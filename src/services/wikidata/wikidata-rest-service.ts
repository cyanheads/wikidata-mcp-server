/**
 * @fileoverview Wikidata REST API and MediaWiki wbgetentities client.
 * @module services/wikidata/wikidata-rest-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  fetchWithTimeout,
  httpErrorFromResponse,
  type RequestContext,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  NormalizedStatement,
  RawEntity,
  RawSearchResult,
  RawStatement,
  StatementValue,
  WbGetEntitiesResponse,
} from './types.js';

const REST_BASE = 'https://www.wikidata.org/w/rest.php/wikibase/v1';
const MW_API_BASE = 'https://www.wikidata.org/w/api.php';

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

/** Normalizes a Q/P-ID to uppercase (e.g. q76 → Q76). */
export function normalizeId(id: string): string {
  return id.toUpperCase();
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

  private getJson<T>(url: string, ctx: Context): Promise<T> {
    const rctx = ctx as unknown as RequestContext;
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, this.restTimeoutMs, rctx, {
          headers: this.headers,
          signal: ctx.signal,
        });
        if (!response.ok) {
          throw await httpErrorFromResponse(response, { service: 'Wikidata REST' });
        }
        const text = await response.text();
        if (isHtmlResponse(text)) {
          const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
          throw serviceUnavailable(
            'Wikidata REST returned HTML — likely rate-limited or under maintenance.',
          );
        }
        return JSON.parse(text) as T;
      },
      { operation: 'WikidataRest.getJson', context: rctx, baseDelayMs: 1000, signal: ctx.signal },
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
    const data = await this.getJson<{ results?: RawSearchResult[] }>(url, ctx);
    return data.results ?? [];
  }

  /** Fetch a single entity by QID or PID. Routes by ID prefix. */
  fetchEntity(id: string, ctx: Context): Promise<RawEntity> {
    const normalized = normalizeId(id);
    const path = isQId(normalized)
      ? `entities/items/${normalized}`
      : `entities/properties/${normalized}`;
    const url = `${REST_BASE}/${path}`;
    ctx.log.debug('Fetching entity', { id: normalized });
    return this.getJson<RawEntity>(url, ctx);
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
   * Batch-resolve labels and descriptions for up to 50 IDs using the MediaWiki
   * wbgetentities API (the REST API has no batch label endpoint).
   */
  async fetchLabels(
    ids: string[],
    languages: string[],
    ctx: Context,
  ): Promise<
    Record<string, { labels: Record<string, string>; descriptions: Record<string, string> }>
  > {
    // Process in batches of 50
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += 50) {
      batches.push(ids.slice(i, i + 50));
    }

    const results: Record<
      string,
      { labels: Record<string, string>; descriptions: Record<string, string> }
    > = {};

    await Promise.all(
      batches.map(async (batch) => {
        const params = new URLSearchParams({
          action: 'wbgetentities',
          ids: batch.map(normalizeId).join('|'),
          props: 'labels|descriptions',
          languages: languages.join('|'),
          format: 'json',
          formatversion: '2',
        });
        const url = `${MW_API_BASE}?${params}`;
        ctx.log.debug('Fetching labels batch', { count: batch.length, languages });

        const rctx = ctx as unknown as RequestContext;
        const data = await withRetry(
          async () => {
            const response = await fetchWithTimeout(url, this.restTimeoutMs, rctx, {
              headers: this.headers,
              signal: ctx.signal,
            });
            if (!response.ok) {
              throw await httpErrorFromResponse(response, { service: 'Wikidata MW API' });
            }
            const text = await response.text();
            if (isHtmlResponse(text)) {
              const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
              throw serviceUnavailable('Wikidata MW API returned HTML — likely rate-limited.');
            }
            return JSON.parse(text) as WbGetEntitiesResponse;
          },
          {
            operation: 'WikidataRest.fetchLabels',
            context: rctx,
            baseDelayMs: 1000,
            signal: ctx.signal,
          },
        );

        if (data.entities) {
          for (const [id, entity] of Object.entries(data.entities)) {
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
        }
      }),
    );

    return results;
  }
}

// ---------------------------------------------------------------------------
// Statement value normalization
// ---------------------------------------------------------------------------

/** Normalize a raw statement value to the domain type. */
export function normalizeStatementValue(
  dataType: string | undefined | null,
  rawContent: unknown,
): StatementValue {
  const effective = dataType ?? 'string';

  if (effective === 'wikibase-item') {
    const content = rawContent as { id?: string } | string | null;
    if (typeof content === 'object' && content !== null && 'id' in content) {
      return { type: 'wikibase-item', qid: content.id ?? '' };
    }
    if (typeof content === 'string') {
      return { type: 'wikibase-item', qid: content };
    }
    return { type: 'wikibase-item', qid: String(rawContent ?? '') };
  }

  if (effective === 'time') {
    const content = rawContent as { time?: string; precision?: number } | null;
    if (typeof content === 'object' && content !== null) {
      return { type: 'time', time: content.time ?? '', precision: content.precision ?? 0 };
    }
    return { type: 'other', raw: rawContent };
  }

  if (effective === 'quantity') {
    const content = rawContent as { amount?: string; unit?: string } | null;
    if (typeof content === 'object' && content !== null) {
      const unit = content.unit;
      return unit !== undefined
        ? { type: 'quantity', amount: content.amount ?? '', unit }
        : { type: 'quantity', amount: content.amount ?? '' };
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

/** Normalize a raw statement array to domain statements. */
export function normalizeStatements(
  propertyId: string,
  rawStatements: RawStatement[],
  labelMap?: Record<string, string>,
): NormalizedStatement[] {
  return rawStatements.map((raw) => {
    const dataType = raw.property?.data_type;
    const rawValue = normalizeStatementValue(dataType, raw.value?.content);

    // Resolve label for wikibase-item values
    const value: StatementValue =
      rawValue.type === 'wikibase-item'
        ? {
            type: 'wikibase-item',
            qid: rawValue.qid,
            ...(labelMap?.[rawValue.qid] != null ? { label: labelMap[rawValue.qid] } : {}),
          }
        : rawValue;

    const qualifiers = raw.qualifiers?.map((q) => ({
      property: q.property?.id ?? '',
      value: normalizeStatementValue(q.property?.data_type, q.value?.content),
    }));

    const references = raw.references?.flatMap((ref) =>
      (ref.parts ?? []).map((part) => ({
        property: part.property?.id ?? '',
        value: normalizeStatementValue(part.property?.data_type, part.value?.content),
      })),
    );

    return {
      id: raw.id,
      rank: raw.rank,
      property: propertyId,
      value,
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
