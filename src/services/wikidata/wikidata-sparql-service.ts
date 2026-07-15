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

/** Returns true if the response body is an HTML page (rate-limit or maintenance page). */
const isHtmlResponse = (text: string): boolean => /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);

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
  // Prefer specific exception types, then fall back to any Exception, then raw body
  const match =
    /MalformedQueryException:\s*(.+?)(?:\r?\n|$)/.exec(body) ??
    /QueryEvaluationException:\s*(.+?)(?:\r?\n|$)/.exec(body) ??
    /Exception:\s*(.+?)(?:\r?\n|$)/.exec(body);
  return match?.[1]?.trim() ?? body.slice(0, 200).trim();
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
              const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
              throw validationError(`SPARQL parse error: ${cause}`, {
                reason: 'parse_error',
                cause,
              });
            }
            const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
            throw serviceUnavailable(`Wikidata SPARQL endpoint returned HTTP ${response.status}.`, {
              status: response.status,
            });
          }

          const text = await response.text();
          if (isHtmlResponse(text)) {
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
      /**
       * Insert before the WHERE block's closing `}` — then re-attach whatever trails it.
       *
       * The tail is anything the SPARQL 1.1 grammar allows after the WHERE clause: the
       * solution modifiers (LIMIT/OFFSET/ORDER BY/GROUP BY/HAVING) and `ValuesClause`, a
       * distinct production that may follow them. Both must be recognized, because the
       * alternation is what stops the match from sliding onto a later `}`: a trailing
       * `VALUES ?t { wd:Q5 }` ends the query with a brace of its own, and matching *that*
       * one drops the SERVICE inside the VALUES data block, which accepts only constant
       * terms. A VALUES clause *inside* the WHERE block needs no special case — its brace
       * is followed by neither a keyword nor end-of-query, so the match skips past it.
       *
       * The tail capture stays optional, so this one pattern also covers a query that ends
       * at the WHERE block with nothing after it.
       */
      query = query.replace(
        /(\})\s*((?:(?:LIMIT|OFFSET|ORDER\s+BY|GROUP\s+BY|HAVING|VALUES)\b)[\s\S]*)?$/i,
        (_, brace, tail) =>
          tail?.trim()
            ? `  ${LABEL_SERVICE_SNIPPET(language)}\n${brace}\n${tail.trimStart()}`
            : `  ${LABEL_SERVICE_SNIPPET(language)}\n${brace}`,
      );
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
