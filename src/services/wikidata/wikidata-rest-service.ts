/**
 * @fileoverview Wikidata REST API and MediaWiki wbgetentities client.
 * @module services/wikidata/wikidata-rest-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createPacer, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  EntityIdKind,
  NormalizedStatement,
  RawEntity,
  RawSearchResult,
  RawSnak,
  RawStatement,
  RawStatementValue,
  StatementValue,
  WbGetEntitiesResponse,
} from './types.js';

const REST_BASE = 'https://www.wikidata.org/w/rest.php/wikibase/v1';
const MW_API_BASE = 'https://www.wikidata.org/w/api.php';

/**
 * Most `wbgetentities` batches the process keeps in flight, across every `fetchLabels` caller.
 * Wikimedia's API etiquette asks clients not to fan out requests in parallel; 4 still finishes
 * the largest label set an in-budget `wikidata_get_statements` payload can carry in two round
 * trips, where unbounded fan-out sent 23 requests at once for one unfiltered Q30 call.
 */
const LABEL_BATCH_CONCURRENCY = 4;

/**
 * The one queue every label batch waits in, module-level so the cap binds the process rather
 * than one call or one service instance — N concurrent tool calls on a hosted server still put
 * at most {@link LABEL_BATCH_CONCURRENCY} requests in flight. FIFO, so no caller starves; a
 * queued batch whose call is cancelled leaves the queue without ever holding a slot. With no
 * rate window configured it arms no timer, so it needs no teardown.
 */
const labelBatchQueue = createPacer({
  name: 'wikidata-wbgetentities',
  maxConcurrent: LABEL_BATCH_CONCURRENCY,
});

/** Most IDs one `wbgetentities` request accepts. */
const LABEL_BATCH_SIZE = 50;

/**
 * `_fields` values each entity endpoint accepts, verified against the live API.
 *
 * The two sets differ: `sitelinks` is items-only and `data_type` is properties-only. An
 * endpoint answers a value it does not know with 400 `invalid-query-parameter` — the same
 * status an out-of-range ID draws, which `isEntityNotFoundError()` cannot tell apart. So a
 * caller asking a property for `sitelinks` would have a real entity reported as missing.
 * `fetchEntity` intersects against these sets rather than forwarding a field list blindly.
 *
 * `id` is absent deliberately: the endpoint rejects it as a selector (400) but returns it
 * on every response regardless.
 */
const ITEM_FIELDS = new Set([
  'type',
  'labels',
  'descriptions',
  'aliases',
  'statements',
  'sitelinks',
]);
const PROPERTY_FIELDS = new Set([
  'type',
  'data_type',
  'labels',
  'descriptions',
  'aliases',
  'statements',
]);

/** Returns true if the response body is an HTML page (rate-limit or maintenance page). */
const isHtmlResponse = (text: string): boolean => /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);

/** Checks if an ID is a Q-ID (item). */
export function isQId(id: string): boolean {
  return /^[Qq]\d+$/.test(id);
}

/** Checks if an ID is a P-ID (property). */
export function isPId(id: string): boolean {
  return /^[Pp]\d+$/.test(id);
}

/**
 * Normalizes a Q/P-ID to uppercase, trimming surrounding whitespace (e.g. ` q76 ` → `Q76`).
 *
 * Trimming here covers every ID-format call site: the tools and the entity resource all run
 * their `isQId`/`isPId` check on a `normalizeId()` result, so incidental whitespace no longer
 * reaches the strict `^[QqPp]\d+$` patterns as an "invalid ID". `isQId`/`isPId` need no trim
 * of their own — nothing calls them on a value that has not been through `normalizeId` first.
 */
export function normalizeId(id: string): string {
  return id.trim().toUpperCase();
}

/** The HTTP status `fetchWithTimeout` records on a non-2xx rejection. */
const statusOf = (err: unknown): number | undefined =>
  (err as { data?: { status?: number } } | null)?.data?.status;

/**
 * True when an error from an entity-addressed REST lookup means "this entity does not exist".
 *
 * The REST API answers a well-formed but unassigned ID (Q99999999) with 404, and a
 * syntactically valid but out-of-range ID (Q999999999999) with 400 `invalid-path-parameter`
 * — on the items, statements, and sitelinks endpoints alike. Both mean the same thing to a
 * caller, so both map to `entity_not_found`. `fetchWithTimeout` rejects every non-2xx with an
 * `McpError` carrying the HTTP status on `data.status`.
 *
 * Call this only from entity-addressed lookups (fetchEntity/fetchStatements/fetchSitelinks).
 * `search()` shares the same transport, but a 400 there means a malformed query, not a
 * missing entity — classifying it as not-found would report a broken search as an empty one.
 */
export function isEntityNotFoundError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 404 || status === 400;
}

/**
 * Reads the value for `lang` from a REST language-keyed map, falling back to the
 * multilingual (`mul`) entry.
 *
 * Wikidata increasingly stores a single `mul` label for names that are identical across
 * languages, and the REST API returns exactly the keys an entity happens to carry — it has
 * no `languagefallback` parameter, so an item like Q76 comes back with a `mul` label and no
 * `en` label at all. Without this fallback, label-oriented surfaces render the bare QID.
 * The MediaWiki batch path (`fetchLabels`) gets the equivalent server-side via
 * `languagefallback=1` and does not need this.
 */
export function resolveLangValue<T>(
  map: Record<string, T> | undefined,
  lang: string,
): T | undefined {
  return map?.[lang] ?? map?.mul;
}

/**
 * Maps a 400 from the search endpoint to `invalid_search_parameter`. The endpoint names the
 * parameter it refused in `context.parameter` (in practice a language it does not search in,
 * such as `mul`); the message names that parameter and the value sent, never the upstream URL.
 */
function searchRejection(err: unknown, params: URLSearchParams) {
  const body = (err as { data?: { body?: unknown } }).data?.body;
  let parameter: string | undefined;
  try {
    const named = (JSON.parse(String(body)) as { context?: { parameter?: unknown } }).context
      ?.parameter;
    if (typeof named === 'string') parameter = named;
  } catch {
    // A body that is not the endpoint's JSON error names no parameter.
  }
  const value = parameter === undefined ? null : params.get(parameter);
  const message =
    parameter === 'language'
      ? `The Wikidata search endpoint does not search in language "${value}".`
      : parameter !== undefined
        ? `The Wikidata search endpoint rejected the "${parameter}" parameter${value === null ? '' : ` ("${value}")`}.`
        : 'The Wikidata search endpoint rejected the request as invalid (HTTP 400).';
  return validationError(message, {
    reason: 'invalid_search_parameter',
    ...(parameter !== undefined ? { parameter } : {}),
  });
}

export class WikidataRestService {
  private readonly userAgent: string;
  private readonly restTimeoutMs: number;

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverCfg = getServerConfig();
    this.userAgent = serverCfg.userAgent;
    this.restTimeoutMs = serverCfg.restTimeoutMs;
  }

  private get headers(): Record<string, string> {
    return {
      'User-Agent': this.userAgent,
      Accept: 'application/json',
    };
  }

  /**
   * GETs JSON from the REST API. `fetchWithTimeout` rejects every non-2xx itself — with the
   * status on `data.status` — so a returned response is always 2xx and needs no status check.
   */
  private getJson<T>(url: string, ctx: Context): Promise<T> {
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, this.restTimeoutMs, ctx, {
          headers: this.headers,
          signal: ctx.signal,
        });
        const text = await response.text();
        if (isHtmlResponse(text)) {
          throw serviceUnavailable(
            'Wikidata REST returned HTML — likely rate-limited or under maintenance.',
          );
        }
        return JSON.parse(text) as T;
      },
      { operation: 'WikidataRest.getJson', context: ctx, baseDelayMs: 1000, signal: ctx.signal },
    );
  }

  /** Search items or properties by text. */
  async search(
    query: string,
    type: 'item' | 'property',
    language: string,
    limit: number,
    offset: number,
    ctx: Context,
  ): Promise<RawSearchResult[]> {
    const path = type === 'item' ? 'search/items' : 'search/properties';
    const params = new URLSearchParams({
      q: query,
      language,
      limit: String(limit),
      ...(offset > 0 ? { offset: String(offset) } : {}),
    });
    const url = `${REST_BASE}/${path}?${params}`;
    ctx.log.debug('Searching entities', { type, query, language, limit, offset });
    const data = await this.getJson<{ results?: RawSearchResult[] }>(url, ctx).catch(
      (err: unknown) => {
        throw statusOf(err) === 400 ? searchRejection(err, params) : err;
      },
    );
    return data.results ?? [];
  }

  /**
   * Fetch a single entity by QID or PID. Routes by ID prefix.
   *
   * `fields` narrows the fetch server-side via `?_fields=`, the parameter the REST API
   * actually honours — the plausible `?fields=` spelling is accepted and silently ignored,
   * returning the whole entity. Narrowing is a pure bandwidth win: `items/Q76` is 344,114
   * bytes whole and 6,703 with `_fields=labels`. Omit `fields` to fetch everything.
   *
   * `type` is always requested, because the endpoint drops it unless it is asked for and
   * every caller needs it; `data_type` likewise for properties, so a narrowed property keeps
   * the shape an unnarrowed one returns. Values the endpoint would reject are dropped rather
   * than forwarded — see {@link ITEM_FIELDS}/{@link PROPERTY_FIELDS} for why that matters.
   */
  fetchEntity(id: string, ctx: Context, fields?: string[]): Promise<RawEntity> {
    const normalized = normalizeId(id);
    const isItem = isQId(normalized);
    const path = isItem ? `entities/items/${normalized}` : `entities/properties/${normalized}`;

    const accepted = isItem ? ITEM_FIELDS : PROPERTY_FIELDS;
    const selected = fields?.length
      ? [
          ...new Set([
            ...fields.filter((f) => accepted.has(f)),
            'type',
            ...(isItem ? [] : ['data_type']),
          ]),
        ]
      : [];

    const url = selected.length
      ? `${REST_BASE}/${path}?_fields=${selected.join(',')}`
      : `${REST_BASE}/${path}`;
    ctx.log.debug('Fetching entity', { id: normalized, fields: selected });
    return this.getJson<RawEntity>(url, ctx);
  }

  /**
   * Fetch only a property's `data_type`.
   *
   * `?_fields=data_type` keeps the response to ~40 bytes; the same property fetched whole
   * carries labels, descriptions, aliases, and statements, and runs 27–282KB — all of it dead
   * weight for a datatype check. Not-found behavior is unchanged by the narrowing: an
   * unassigned P-ID still answers 404 and an out-of-range one still answers 400, so callers
   * classify both with `isEntityNotFoundError()`.
   */
  async fetchPropertyDataType(id: string, ctx: Context): Promise<string | undefined> {
    const normalized = normalizeId(id);
    const url = `${REST_BASE}/entities/properties/${normalized}?_fields=data_type`;
    ctx.log.debug('Fetching property data type', { id: normalized });
    const data = await this.getJson<Pick<RawEntity, 'id' | 'data_type'>>(url, ctx);
    return data.data_type ?? undefined;
  }

  /** Fetch statements for an entity, optionally filtered to specific P-IDs. */
  async fetchStatements(
    id: string,
    properties: string[] | undefined,
    ctx: Context,
  ): Promise<Record<string, RawStatement[]>> {
    const normalized = normalizeId(id);
    const basePath = isQId(normalized)
      ? `entities/items/${normalized}/statements`
      : `entities/properties/${normalized}/statements`;

    // The REST API supports a single `property` filter param per request.
    // For multiple properties we fetch all and client-filter.
    const url =
      properties?.length === 1
        ? `${REST_BASE}/${basePath}?property=${properties[0]?.toUpperCase()}`
        : `${REST_BASE}/${basePath}`;

    ctx.log.debug('Fetching statements', { id: normalized, properties });
    const data = await this.getJson<Record<string, RawStatement[]>>(url, ctx);

    if (properties && properties.length > 1) {
      const upperProps = new Set(properties.map((p) => p.toUpperCase()));
      return Object.fromEntries(
        Object.entries(data).filter(([key]) => upperProps.has(key.toUpperCase())),
      );
    }
    return data;
  }

  /** Fetch sitelinks for a Q-ID, optionally filtered to specific site codes. */
  async fetchSitelinks(
    id: string,
    sites: string[] | undefined,
    ctx: Context,
  ): Promise<Record<string, { title: string; url?: string | null; badges?: string[] }>> {
    const normalized = normalizeId(id);
    const url = `${REST_BASE}/entities/items/${normalized}/sitelinks`;
    ctx.log.debug('Fetching sitelinks', { id: normalized, sites });
    const data = await this.getJson<
      Record<string, { title: string; url?: string | null; badges?: string[] }>
    >(url, ctx);

    if (sites?.length) {
      const siteSet = new Set(sites);
      return Object.fromEntries(Object.entries(data).filter(([key]) => siteSet.has(key)));
    }
    return data;
  }

  /**
   * Issues one `wbgetentities` request. `languagefallback=1` makes the API resolve a requested
   * language to the entity's `mul` (multilingual) or other fallback label when it has no
   * label in that exact language — Q76 has only a `mul` label and would otherwise come back
   * with an empty `labels` map. Fallback values stay keyed by the *requested* language, so
   * the extraction below is unaffected.
   *
   * `fetchWithTimeout` rejects every non-2xx itself, so a returned response is always 2xx.
   * A rejected batch still arrives as HTTP 200 carrying a top-level `error` — see fetchLabels.
   */
  private fetchWbEntities(
    ids: string[],
    languages: string[],
    ctx: Context,
    signal: AbortSignal,
  ): Promise<WbGetEntitiesResponse> {
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: ids.join('|'),
      props: 'labels|descriptions',
      languages: languages.join('|'),
      languagefallback: '1',
      format: 'json',
      formatversion: '2',
    });
    const url = `${MW_API_BASE}?${params}`;
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, this.restTimeoutMs, ctx, {
          headers: this.headers,
          signal,
        });
        const text = await response.text();
        if (isHtmlResponse(text)) {
          throw serviceUnavailable('Wikidata MW API returned HTML — likely rate-limited.');
        }
        return JSON.parse(text) as WbGetEntitiesResponse;
      },
      {
        operation: 'WikidataRest.fetchLabels',
        context: ctx,
        baseDelayMs: 1000,
        signal,
      },
    );
  }

  /**
   * Batch-resolve labels and descriptions using the MediaWiki wbgetentities API (the REST API
   * has no batch label endpoint), {@link LABEL_BATCH_SIZE} IDs per request.
   *
   * IDs absent from the result did not resolve; callers diff against what they requested.
   */
  async fetchLabels(
    ids: string[],
    languages: string[],
    ctx: Context,
  ): Promise<
    Record<string, { labels: Record<string, string>; descriptions: Record<string, string> }>
  > {
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += LABEL_BATCH_SIZE) {
      batches.push(ids.slice(i, i + LABEL_BATCH_SIZE));
    }

    const results: Record<
      string,
      { labels: Record<string, string>; descriptions: Record<string, string> }
    > = {};

    const resolveBatch = async (batch: string[], signal: AbortSignal) => {
      let remaining = batch.map(normalizeId);
      ctx.log.debug('Fetching labels batch', { count: remaining.length, languages });

      /**
       * An out-of-range ID (Q999999999999) makes the API reject the whole batch with a
       * top-level `no-such-entity` error instead of an `entities` map, naming only the
       * FIRST offending ID — so valid members resolve only if we drop the named ID and
       * re-request. Each pass removes exactly one ID, so this terminates.
       *
       * A merely unassigned ID (Q99999999) is not affected: it arrives inside a normal
       * `entities` map with a per-item `missing` marker, handled below.
       */
      while (remaining.length > 0) {
        const data = await this.fetchWbEntities(remaining, languages, ctx, signal);

        if (data.error) {
          const badId = data.error.id;
          if (data.error.code === 'no-such-entity' && badId && remaining.includes(badId)) {
            ctx.log.debug('Dropping unresolvable ID from labels batch', { id: badId });
            remaining = remaining.filter((id) => id !== badId);
            continue;
          }
          // Any other top-level error is a real failure — surface it rather than let the
          // batch collapse into a silent "none of these IDs exist".
          throw serviceUnavailable(
            `Wikidata MW API rejected the labels request: ${data.error.info} (${data.error.code})`,
            { apiErrorCode: data.error.code, retryable: false },
          );
        }

        for (const [id, entity] of Object.entries(data.entities ?? {})) {
          if (entity.missing === '') continue;
          results[id] = {
            labels: Object.fromEntries(
              Object.entries(entity.labels ?? {}).map(([lang, lb]) => [lang, lb.value]),
            ),
            descriptions: Object.fromEntries(
              Object.entries(entity.descriptions ?? {}).map(([lang, ds]) => [lang, ds.value]),
            ),
          };
        }
        return;
      }
    };

    /**
     * Every batch waits its turn in the process-wide {@link labelBatchQueue} and holds one slot
     * from its first request to its last — retry backoff and drop-and-retry passes included —
     * so the cap counts batches in progress.
     *
     * The call's batches share one signal: the caller's, joined with `stop`, which the first
     * batch to fail fires before its slot is released. Aborting it pulls this call's queued
     * batches out of the queue unstarted and cuts its in-flight ones short, so a failed or
     * cancelled call frees its slots for other callers at once; their batches carry their own
     * signals and never see it.
     */
    const stop = new AbortController();
    const signal = AbortSignal.any([ctx.signal, stop.signal]);
    await Promise.all(
      batches.map((batch) =>
        labelBatchQueue.run(
          async (batchSignal) => {
            try {
              await resolveBatch(batch, batchSignal);
            } catch (err) {
              stop.abort(err);
              throw err;
            }
          },
          { signal },
        ),
      ),
    );

    return results;
  }
}

// ---------------------------------------------------------------------------
// Statement value normalization
// ---------------------------------------------------------------------------

/**
 * The non-item entity-ID data types, keyed to the entity kind their value names. Upstream
 * sends each value as the bare ID string (`"P279"`, `"L37633"`, `"L229416-F1"`, `"E10"`).
 */
const ENTITY_ID_KINDS: Record<string, EntityIdKind | undefined> = {
  'wikibase-property': 'property',
  'wikibase-lexeme': 'lexeme',
  'wikibase-form': 'form',
  'wikibase-sense': 'sense',
  'entity-schema': 'entity-schema',
};

/**
 * Normalize a raw snak value to the domain type.
 *
 * `somevalue` (an unknown value) and `novalue` (an explicit absence) carry no `content` and
 * keep their own types whatever the property's data type — read as content they would
 * collapse to an empty value, and an item-typed one to a `wikibase-item` with no QID.
 */
export function normalizeStatementValue(
  dataType: string | undefined | null,
  raw: RawStatementValue | undefined,
): StatementValue {
  if (raw?.type === 'somevalue' || raw?.type === 'novalue') return { type: raw.type };

  const rawContent = raw?.content;
  const effective = dataType ?? 'string';

  if (effective === 'wikibase-item') {
    const content = rawContent as { id?: string } | string | null | undefined;
    const qid = typeof content === 'string' ? content : content?.id;
    return qid ? { type: 'wikibase-item', qid } : { type: 'other', raw: rawContent };
  }

  const entityType = ENTITY_ID_KINDS[effective];
  if (entityType) {
    return typeof rawContent === 'string' && rawContent
      ? { type: 'entity-id', entityType, id: rawContent }
      : { type: 'other', raw: rawContent };
  }

  if (effective === 'time') {
    const content = rawContent as { time?: string; precision?: number } | null;
    if (typeof content === 'object' && content !== null) {
      return { type: 'time', time: content.time ?? '', precision: content.precision ?? 0 };
    }
    return { type: 'other', raw: rawContent };
  }

  if (effective === 'quantity') {
    const content = rawContent as {
      amount?: string;
      unit?: string;
      upperBound?: string;
      lowerBound?: string;
    } | null;
    if (typeof content === 'object' && content !== null) {
      const { unit, upperBound, lowerBound } = content;
      return {
        type: 'quantity',
        amount: content.amount ?? '',
        ...(unit !== undefined ? { unit } : {}),
        ...(upperBound !== undefined ? { upperBound } : {}),
        ...(lowerBound !== undefined ? { lowerBound } : {}),
      };
    }
    return { type: 'other', raw: rawContent };
  }

  if (effective === 'monolingualtext') {
    const content = rawContent as { text?: string; language?: string } | null;
    if (typeof content === 'object' && content !== null) {
      return {
        type: 'monolingualtext',
        text: content.text ?? '',
        language: content.language ?? '',
      };
    }
    return { type: 'other', raw: rawContent };
  }

  if (effective === 'globe-coordinate') {
    const content = rawContent as {
      latitude?: number;
      longitude?: number;
      precision?: number;
    } | null;
    if (typeof content === 'object' && content !== null) {
      return {
        type: 'globe-coordinate',
        latitude: content.latitude ?? 0,
        longitude: content.longitude ?? 0,
        ...(content.precision != null ? { precision: content.precision } : {}),
      };
    }
    return { type: 'other', raw: rawContent };
  }

  if (effective === 'external-id' || effective === 'url') {
    return { type: effective, value: String(rawContent ?? '') };
  }

  if (
    ['string', 'commonsMedia', 'geo-shape', 'tabular-data', 'math', 'musical-notation'].includes(
      effective,
    )
  ) {
    return { type: 'string', value: String(rawContent ?? '') };
  }

  // Unknown types — preserve as-is
  return { type: 'other', raw: rawContent };
}

/**
 * The Q-ID a quantity unit names: `http://www.wikidata.org/entity/Q712226` → `Q712226`.
 * Undefined for the unitless `"1"` and for any unit that is not a Wikidata entity URI.
 */
export function unitQid(unit: string | undefined): string | undefined {
  return unit?.match(/^https?:\/\/www\.wikidata\.org\/entity\/(Q\d+)$/)?.[1];
}

/** Every snak a statement carries: its main value, its qualifiers, and each reference's parts. */
function* statementSnaks(raw: RawStatement): Generator<RawSnak> {
  yield raw;
  yield* raw.qualifiers ?? [];
  for (const ref of raw.references ?? []) yield* ref.parts ?? [];
}

/** The Q-ID a normalized value needs a label for — an item value or a quantity unit. */
function labelQidOf(value: StatementValue): string | undefined {
  if (value.type === 'wikibase-item') return value.qid;
  return value.type === 'quantity' ? unitQid(value.unit) : undefined;
}

/**
 * The Q-IDs a statement set needs labels for — item values and quantity units at every level
 * (main value, qualifiers, reference parts) — deduplicated for one `fetchLabels` batch. Reads
 * each snak through `normalizeStatementValue`, so `somevalue`/`novalue` never contribute.
 */
export function collectLabelQids(rawStatements: RawStatement[]): Set<string> {
  const qids = new Set<string>();
  for (const raw of rawStatements) {
    for (const snak of statementSnaks(raw)) {
      const qid = labelQidOf(normalizeStatementValue(snak.property?.data_type, snak.value));
      if (qid) qids.add(qid);
    }
  }
  return qids;
}

/** Normalize one snak, attaching `label` / `unitLabel` when its Q-ID resolved in `labelMap`. */
function normalizeSnakValue(snak: RawSnak, labelMap?: Record<string, string>): StatementValue {
  const value = normalizeStatementValue(snak.property?.data_type, snak.value);
  const qid = labelQidOf(value);
  const label = qid ? labelMap?.[qid] : undefined;
  if (!label) return value;
  if (value.type === 'wikibase-item') return { ...value, label };
  if (value.type === 'quantity') return { ...value, unitLabel: label };
  return value;
}

/**
 * Normalize a raw statement array to domain statements. `labelMap` (Q-ID → label) labels
 * item values and quantity units at every level; a Q-ID absent from it stays bare.
 */
export function normalizeStatements(
  propertyId: string,
  rawStatements: RawStatement[],
  labelMap?: Record<string, string>,
): NormalizedStatement[] {
  const toSnak = (snak: RawSnak) => ({
    property: snak.property?.id ?? '',
    value: normalizeSnakValue(snak, labelMap),
  });

  return rawStatements.map((raw) => {
    const qualifiers = raw.qualifiers?.map(toSnak);
    const references = raw.references?.map((ref) => ({ parts: (ref.parts ?? []).map(toSnak) }));

    return {
      id: raw.id,
      rank: raw.rank,
      property: propertyId,
      value: normalizeSnakValue(raw, labelMap),
      ...(qualifiers?.length ? { qualifiers } : {}),
      ...(references?.length ? { references } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Init / accessor pattern
// ---------------------------------------------------------------------------

let _service: WikidataRestService | undefined;

export function initWikidataRestService(config: AppConfig, storage: StorageService): void {
  _service = new WikidataRestService(config, storage);
}

export function getWikidataRestService(): WikidataRestService {
  if (!_service) {
    throw new Error(
      'WikidataRestService not initialized — call initWikidataRestService() in setup()',
    );
  }
  return _service;
}
