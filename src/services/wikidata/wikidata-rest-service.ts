/**
 * @fileoverview Wikidata REST API and MediaWiki wbgetentities client.
 * @module services/wikidata/wikidata-rest-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable, timeout, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createPacer, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  EntityIdKind,
  NormalizedStatement,
  RawEntity,
  RawSearchResult,
  RawSitelink,
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
 * One budget for a whole `fetchLabels` call — queue wait, every batch, every retry and backoff —
 * so it settles under an MCP client's 60 s default request timeout. A 500-ID call is 10 batches
 * in 3 rounds of {@link labelBatchQueue}, and each batch's retry ladder (four attempts of up to
 * the REST timeout, plus backoff) alone can approach that timeout, so chained rounds outrun it.
 */
const LABELS_DEADLINE_MS = 50_000;

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
 * The entity forms `wikidata_sparql_query` returns an ID in: the concept URI
 * (`http://www.wikidata.org/entity/Q42`, in structuredContent) and the `wd:` compact form (in
 * content[]). Anchored, one fixed alternative each, so a match reads at most the first 32
 * characters.
 */
const ENTITY_ID_PREFIX = /^(?:https?:\/\/www\.wikidata\.org\/entity\/|wd:)/i;

/**
 * Normalizes a Q/P-ID to its bare uppercase form, trimming surrounding whitespace and one
 * leading entity URI or `wd:` prefix (` q76 ` → `Q76`, `wd:Q42` and
 * `http://www.wikidata.org/entity/Q42` → `Q42`).
 *
 * Every ID-format call site inherits this: the tools and the entity resource all run their
 * `isQId`/`isPId` check on a `normalizeId()` result, so incidental whitespace or a SPARQL result
 * value no longer reaches the strict `^[QqPp]\d+$` patterns as an "invalid ID". `isQId`/`isPId`
 * need no trim of their own — nothing calls them on a value that has not been through
 * `normalizeId` first.
 */
export function normalizeId(id: string): string {
  return id.trim().replace(ENTITY_ID_PREFIX, '').toUpperCase();
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
  private getJsonResponse<T>(url: string, ctx: Context): Promise<{ data: T; url: string }> {
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
        return { data: JSON.parse(text) as T, url: response.url };
      },
      { operation: 'WikidataRest.getJson', context: ctx, baseDelayMs: 1000, signal: ctx.signal },
    );
  }

  private async getJson<T>(url: string, ctx: Context): Promise<T> {
    return (await this.getJsonResponse<T>(url, ctx)).data;
  }

  /** Collection bodies omit the ID, including when the resolved collection is empty. */
  private collectionEntityId(requestUrl: string, responseUrl: string, id: string): string {
    if (!responseUrl || responseUrl === requestUrl) return id;
    const requested = new URL(requestUrl);
    const resolved = URL.parse(responseUrl);
    if (
      !resolved ||
      resolved.origin !== requested.origin ||
      resolved.pathname === requested.pathname
    ) {
      return id;
    }
    const requestPath = requested.pathname.split('/');
    const resolvedPath = resolved.pathname.split('/');
    const idIndex = requestPath.length - 2;
    const resolvedId = resolvedPath[idIndex];
    if (
      resolvedId &&
      (isQId(id) ? isQId(resolvedId) : isPId(resolvedId)) &&
      requestPath.length === resolvedPath.length &&
      requestPath.every((segment, index) => index === idIndex || segment === resolvedPath[index])
    ) {
      return resolvedId;
    }
    return id;
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
  ): Promise<{ id: string; statements: Record<string, RawStatement[]> }> {
    const normalized = normalizeId(id);
    const basePath = isQId(normalized)
      ? `entities/items/${normalized}/statements`
      : `entities/properties/${normalized}/statements`;

    // Each entry reaches upstream as its bare P-ID, whatever form `normalizeId` accepted.
    const props = properties?.map(normalizeId);

    // The REST API supports a single `property` filter param per request.
    // For multiple properties we fetch all and client-filter.
    const url =
      props?.length === 1
        ? `${REST_BASE}/${basePath}?property=${props[0]}`
        : `${REST_BASE}/${basePath}`;

    ctx.log.debug('Fetching statements', { id: normalized, properties: props });
    const response = await this.getJsonResponse<Record<string, RawStatement[]>>(url, ctx);
    const resolvedId = this.collectionEntityId(url, response.url, normalized);

    if (props?.length) {
      const wanted = new Set(props);
      const statements = Object.fromEntries(
        Object.entries(response.data).filter(([key]) => wanted.has(key)),
      );
      return { id: resolvedId, statements };
    }
    return { id: resolvedId, statements: response.data };
  }

  /** Fetch sitelinks for a Q-ID, optionally filtered to specific site codes (trimmed, any case). */
  async fetchSitelinks(
    id: string,
    sites: string[] | undefined,
    ctx: Context,
  ): Promise<{ id: string; sitelinks: Record<string, RawSitelink>; notFound: string[] }> {
    const normalized = normalizeId(id);
    const url = `${REST_BASE}/entities/items/${normalized}/sitelinks`;
    ctx.log.debug('Fetching sitelinks', { id: normalized, sites });
    const response = await this.getJsonResponse<Record<string, RawSitelink>>(url, ctx);
    const resolvedId = this.collectionEntityId(url, response.url, normalized);

    if (sites?.length) {
      // Every upstream site code is lowercase, so `ENWIKI` and ` enwiki ` mean enwiki.
      const siteSet = new Set(sites.map((site) => site.trim().toLowerCase()));
      const sitelinks = Object.fromEntries(
        Object.entries(response.data).filter(([key]) => siteSet.has(key)),
      );
      const notFound = [...siteSet].filter((site) => !Object.hasOwn(sitelinks, site));
      return { id: resolvedId, sitelinks, notFound };
    }
    return { id: resolvedId, sitelinks: response.data, notFound: [] };
  }

  /**
   * Issues one `wbgetentities` request. `languagefallback=1` makes the API resolve a requested
   * language to the entity's `mul` (multilingual) or other fallback label when it has no
   * label in that exact language — Q76 has only a `mul` label and would otherwise come back
   * with an empty `labels` map. Fallback values stay keyed by the *requested* language, so
   * the extraction below is unaffected.
   *
   * `fetchWithTimeout` rejects every non-2xx itself, so a returned response is always 2xx.
   * A rejected batch still arrives as HTTP 200 carrying `errors` — see fetchLabels.
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
      errorformat: 'plaintext',
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
   * IDs absent from the entity map did not resolve. Entities and rejected languages come back in
   * input order.
   */
  async fetchLabels(ids: string[], languages: string[], ctx: Context) {
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += LABEL_BATCH_SIZE) {
      batches.push(ids.slice(i, i + LABEL_BATCH_SIZE));
    }

    const results: Record<
      string,
      { labels: Record<string, string>; descriptions: Record<string, string> }
    > = {};
    const requested = new Set(languages);
    const unrecognized = new Set<string>();

    // With no recognized language, MediaWiki returns unfiltered terms. Its fallback
    // results are keyed by the requested language, so filtering keeps those intact.
    const selectTerms = (terms: Record<string, { value: string }> | undefined) => {
      const selected: Record<string, string> = Object.create(null);
      for (const [lang, term] of Object.entries(terms ?? {})) {
        if (requested.has(lang) && !unrecognized.has(lang)) selected[lang] = term.value;
      }
      return selected;
    };

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

        // The other enum-list parameter, props, is fixed. Match machine-readable values
        // against the requested languages rather than parsing the localized warning text.
        for (const warning of data.warnings ?? []) {
          if (warning.module !== 'wbgetentities' || warning.code !== 'unrecognizedvalues') continue;
          for (const value of warning.data?.values ?? []) {
            if (requested.has(value)) unrecognized.add(value);
          }
        }

        const error = data.errors?.[0];
        if (error) {
          const badId = error.data?.id;
          if (error.code === 'no-such-entity' && badId && remaining.includes(badId)) {
            ctx.log.debug('Dropping unresolvable ID from labels batch', { id: badId });
            remaining = remaining.filter((id) => id !== badId);
            continue;
          }
          // Any other top-level error is a real failure — surface it rather than let the
          // batch collapse into a silent "none of these IDs exist".
          throw serviceUnavailable(
            `Wikidata MW API rejected the labels request: ${error.text} (${error.code})`,
            { apiErrorCode: error.code, retryable: false },
          );
        }

        for (const [id, entity] of Object.entries(data.entities ?? {})) {
          if (entity.missing === '') continue;
          results[id] = {
            labels: selectTerms(entity.labels),
            descriptions: selectTerms(entity.descriptions),
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
     * batch to fail fires before its slot is released, and with the call's
     * {@link LABELS_DEADLINE_MS} clock. Aborting it pulls this call's queued batches out of the
     * queue unstarted and cuts its in-flight ones short, so a failed, cancelled, or expired call
     * frees its slots for other callers at once; their batches carry their own signals and
     * never see it.
     */
    const stop = new AbortController();
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(
          new DOMException(
            `Label lookup exceeded its ${LABELS_DEADLINE_MS} ms deadline.`,
            'TimeoutError',
          ),
        ),
      LABELS_DEADLINE_MS,
    );
    const signal = AbortSignal.any([ctx.signal, stop.signal, deadline.signal]);
    try {
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
    } catch (err) {
      // The caller's own cancellation outranks the deadline and passes through untouched.
      if (deadline.signal.aborted && !ctx.signal.aborted) {
        throw timeout(
          `The Wikidata label lookup for ${ids.length} IDs did not finish within ${LABELS_DEADLINE_MS / 1000} s. Retry, or send fewer IDs per call.`,
          { deadlineMs: LABELS_DEADLINE_MS },
          { cause: err },
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // Batches settle in network order. Return the asked-for IDs in input order, then any entry the
    // API keyed under another ID, such as a redirect's target, in arrival order.
    const ordered: typeof results = {};
    for (const id of ids.map(normalizeId)) {
      const entry = results[id];
      if (entry) ordered[id] = entry;
    }
    return {
      entities: Object.assign(ordered, results),
      unrecognizedLanguages: [...requested].filter((language) => unrecognized.has(language)),
    };
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
    const content = rawContent as {
      time?: string;
      precision?: number;
      calendarmodel?: string;
    } | null;
    if (typeof content === 'object' && content !== null) {
      const calendar = modelQid(content.calendarmodel);
      return {
        type: 'time',
        time: content.time ?? '',
        precision: content.precision ?? 0,
        ...(calendar && { calendarmodel: calendar }),
      };
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
      globe?: string;
    } | null;
    if (typeof content === 'object' && content !== null) {
      const globe = modelQid(content.globe);
      return {
        type: 'globe-coordinate',
        latitude: content.latitude ?? 0,
        longitude: content.longitude ?? 0,
        ...(content.precision != null ? { precision: content.precision } : {}),
        ...(globe && { globe }),
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

/** A calendar or globe can arrive as a concept URI or a bare item ID. */
function modelQid(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return;
  return isQId(value) ? value.toUpperCase() : unitQid(value);
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

/**
 * The P-IDs a statement set needs labels for — the property of every snak (the statement's own,
 * each qualifier's, each reference part's) and every property-typed value — deduplicated for the
 * same `fetchLabels` batch as {@link collectLabelQids}. A `somevalue`/`novalue` snak still names
 * its property but contributes no value.
 */
export function collectLabelPids(rawStatements: RawStatement[]): Set<string> {
  const pids = new Set<string>();
  for (const raw of rawStatements) {
    for (const snak of statementSnaks(raw)) {
      if (snak.property?.id) pids.add(snak.property.id);
      const value = normalizeStatementValue(snak.property?.data_type, snak.value);
      if (value.type === 'entity-id' && value.entityType === 'property') pids.add(value.id);
    }
  }
  return pids;
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
