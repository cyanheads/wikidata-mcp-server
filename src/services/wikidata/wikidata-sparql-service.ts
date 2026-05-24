/**
 * @fileoverview Wikidata SPARQL Query Service client.
 * @module services/wikidata/wikidata-sparql-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { SparqlResponse } from './types.js';

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

/** Common SPARQL prefixes pre-pended to every query. */
const SPARQL_PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX p: <http://www.wikidata.org/prop/>
PREFIX ps: <http://www.wikidata.org/prop/statement/>
PREFIX pq: <http://www.wikidata.org/prop/qualifier/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX bd: <http://www.bigdata.com/rdf#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX schema: <http://schema.org/>
`;

/** Label SERVICE snippet injected when language is specified and not already present. */
const LABEL_SERVICE_SNIPPET = (lang: string) =>
  `SERVICE wikibase:label { bd:serviceParam wikibase:language "${lang}" }`;

/**
 * Extract the human-readable cause from a Blazegraph Java stack trace.
 * Stack traces look like:
 *   org.openrdf.query.MalformedQueryException: <reason>
 *   ... (stack frames)
 */
function extractSparqlError(body: string): string {
  // Try to find the MalformedQueryException message
  const mqMatch = /MalformedQueryException:\s*(.+?)(?:\r?\n|$)/.exec(body);
  if (mqMatch?.[1]) return mqMatch[1].trim();

  // Try QueryEvaluationException
  const qeMatch = /QueryEvaluationException:\s*(.+?)(?:\r?\n|$)/.exec(body);
  if (qeMatch?.[1]) return qeMatch[1].trim();

  // Try any Exception line
  const anyMatch = /Exception:\s*(.+?)(?:\r?\n|$)/.exec(body);
  if (anyMatch?.[1]) return anyMatch[1].trim();

  // Fall back to first 200 chars
  return body.slice(0, 200).trim();
}

export class WikidataSparqlService {
  private readonly userAgent: string;
  private readonly defaultTimeoutMs: number;

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverCfg = getServerConfig();
    this.userAgent = serverCfg.userAgent;
    this.defaultTimeoutMs = serverCfg.sparqlTimeoutMs;
  }

  /**
   * Execute a SPARQL SELECT query against the Wikidata Query Service.
   * Injects common prefixes and label SERVICE when appropriate.
   */
  query(
    rawQuery: string,
    language: string,
    timeoutMs: number | undefined,
    ctx: Context,
  ): Promise<SparqlResponse> {
    const effectiveTimeout = Math.min(timeoutMs ?? this.defaultTimeoutMs, 55_000);
    const query = this.prepareQuery(rawQuery, language);

    ctx.log.debug('Executing SPARQL query', { language, timeoutMs: effectiveTimeout });
    const rctx = ctx as unknown as RequestContext;

    return withRetry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

        // Forward cancellation from the caller's signal to our timeout controller
        const onCallerAbort = () => controller.abort();
        ctx.signal.addEventListener('abort', onCallerAbort);

        try {
          const response = await fetch(SPARQL_ENDPOINT, {
            method: 'POST',
            headers: {
              'User-Agent': this.userAgent,
              Accept: 'application/sparql-results+json',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ query }),
            signal: controller.signal,
          });

          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            const { rateLimited } = await import('@cyanheads/mcp-ts-core/errors');
            throw rateLimited(
              `Wikidata SPARQL endpoint is rate-limited. ${retryAfter ? `Retry after ${retryAfter}s.` : 'Retry shortly.'}`,
              { reason: 'throttled', ...(retryAfter ? { retryAfter } : {}) },
            );
          }

          if (!response.ok) {
            const body = await response.text().catch(() => '');
            if (response.status === 400 || response.status === 422) {
              const cause = extractSparqlError(body);
              const { invalidParams } = await import('@cyanheads/mcp-ts-core/errors');
              throw invalidParams(`SPARQL parse error: ${cause}`, { reason: 'parse_error', cause });
            }
            const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
            throw serviceUnavailable(`Wikidata SPARQL endpoint returned HTTP ${response.status}.`, {
              status: response.status,
            });
          }

          const text = await response.text();
          if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
            const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
            throw serviceUnavailable(
              'SPARQL endpoint returned HTML — likely rate-limited or under maintenance.',
            );
          }

          return JSON.parse(text) as SparqlResponse;
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
            throw serviceUnavailable(
              `SPARQL query timed out after ${effectiveTimeout / 1000}s. Add a LIMIT clause or simplify the query.`,
              { reason: 'timeout' },
            );
          }
          throw err;
        } finally {
          clearTimeout(timeoutId);
          ctx.signal.removeEventListener('abort', onCallerAbort);
        }
      },
      {
        operation: 'WikidataSparql.query',
        context: rctx,
        baseDelayMs: 2000,
        signal: ctx.signal,
        // Only retry throttle errors (429), not parse errors or timeouts
        isTransient: (err) => {
          const e = err as { code?: number; data?: { reason?: string } };
          return e?.data?.reason === 'throttled';
        },
      },
    );
  }

  /** Prepend standard prefixes and inject label SERVICE if needed. */
  private prepareQuery(rawQuery: string, language: string): string {
    let query = rawQuery.trim();

    // Inject label SERVICE if language is set and the SERVICE block is absent
    const hasLabelService = /SERVICE\s+wikibase:label/i.test(query);
    if (language && !hasLabelService) {
      // Insert before the final } — then re-attach any trailing LIMIT/OFFSET/ORDER BY/GROUP BY/HAVING.
      // The original /\}\s*$/ only matched when } was the last character, so queries ending with
      // LIMIT N (or other solution modifiers) silently skipped injection.
      query = query.replace(
        /(\})\s*((?:(?:LIMIT|OFFSET|ORDER\s+BY|GROUP\s+BY|HAVING)\b)[\s\S]*)$/i,
        (_, brace, tail) => `  ${LABEL_SERVICE_SNIPPET(language)}\n${brace}\n${tail.trimStart()}`,
      );
      // Fallback: if no trailing modifier was found, the original pattern still applies
      if (!query.includes(LABEL_SERVICE_SNIPPET(language))) {
        query = query.replace(/\}\s*$/, `  ${LABEL_SERVICE_SNIPPET(language)}\n}`);
      }
    }

    // Prepend standard prefixes (only those not already declared)
    const prefixLines = SPARQL_PREFIXES.split('\n').filter(Boolean);
    const existingPrefixes = new Set<string>();
    for (const line of query.split('\n')) {
      const m = /^PREFIX\s+(\w+:)/i.exec(line.trim());
      if (m?.[1]) existingPrefixes.add(m[1]);
    }
    const neededPrefixes = prefixLines
      .filter((line) => {
        const m = /^PREFIX\s+(\w+:)/.exec(line);
        return m?.[1] && !existingPrefixes.has(m[1]);
      })
      .join('\n');

    return neededPrefixes ? `${neededPrefixes}\n${query}` : query;
  }
}

// ---------------------------------------------------------------------------
// Init / accessor pattern
// ---------------------------------------------------------------------------

let _service: WikidataSparqlService | undefined;

export function initWikidataSparqlService(config: AppConfig, storage: StorageService): void {
  _service = new WikidataSparqlService(config, storage);
}

export function getWikidataSparqlService(): WikidataSparqlService {
  if (!_service) {
    throw new Error(
      'WikidataSparqlService not initialized — call initWikidataSparqlService() in setup()',
    );
  }
  return _service;
}
