/**
 * @fileoverview Wikidata SPARQL Query Service client.
 * @module services/wikidata/wikidata-sparql-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  rateLimited,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
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

/**
 * Label SERVICE snippet injected when the query asks for labels and declares no SERVICE itself.
 *
 * The SERVICE tries each code of a comma-separated list in turn but never falls back to the
 * multilingual (`mul`) label on its own — and many items now carry their name only there. So the
 * list ends in `mul` unless the caller's list already places it.
 *
 * It is wrapped in OPTIONAL so a label variable the caller binds itself (`?x rdfs:label ?xLabel`)
 * keeps its rows. A plain SERVICE joins on that variable, and when the planner runs it first —
 * as it does for a single-valued `VALUES` — every row whose label differs from the one the
 * SERVICE picks is dropped. The left join keeps them, and still binds an unbound label variable.
 */
const LABEL_SERVICE_SNIPPET = (languages: string) => {
  const list = languages.split(',').includes('mul') ? languages : `${languages},mul`;
  return `OPTIONAL { SERVICE wikibase:label { bd:serviceParam wikibase:language "${list}" } }`;
};

/**
 * A SPARQL variable (`?name` or `$name`). The name approximates the grammar's VARNAME: letters,
 * digits, combining marks, `_`, and the middle dot and tie characters it allows after the first.
 */
const VARIABLE = /[?$][\p{L}\p{N}\p{M}_\u00B7\u203F\u2040]+/gu;

/**
 * True when the query references a variable the label SERVICE binds: a base name followed by
 * `Label`, `AltLabel`, or `Description`. Each variable is matched once by a single linear scan,
 * then its suffix checked, so no pattern backtracks over the query text.
 */
function referencesLabelVariable(query: string): boolean {
  for (const [variable] of query.matchAll(VARIABLE)) {
    const name = variable.slice(1);
    for (const suffix of ['Label', 'Description']) {
      if (name.length > suffix.length && name.endsWith(suffix)) return true;
    }
  }
  return false;
}

/**
 * True when the query writes its own label SERVICE, in any spelling the parser accepts: the
 * `wikibase:` prefix this service injects, any other prefix the query binds to the ontology
 * namespace, or the full IRI. Injecting a second SERVICE beside the caller's would override the
 * caller's language.
 */
function declaresLabelService(query: string): boolean {
  const prefixes = new Set(['wikibase']);
  for (const [, name] of query.matchAll(
    /PREFIX\s+([\w.-]*):\s*<http:\/\/wikiba\.se\/ontology#>/gi,
  )) {
    prefixes.add(name as string);
  }
  for (const [, name] of query.matchAll(
    /SERVICE\s+(?:<http:\/\/wikiba\.se\/ontology#label>|([\w.-]*):label\b)/gi,
  )) {
    if (name === undefined || prefixes.has(name)) return true;
  }
  return false;
}

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

/**
 * An IRI reference: SPARQL's IRIREF admits no whitespace, `<>"{}|^\``, or backslash inside — so
 * a `<` comparison followed by spaces (`?n < 5 && ?n > 1`) is never mistaken for one.
 */
const IRI_REF = /<[^<>"{}|^`\\\s]*>/y;

/** Index of the last character of the string literal opening at `start`, or -1 if unterminated. */
function stringLiteralEnd(query: string, start: number): number {
  const quote = query[start] as string;
  const triple = quote.repeat(3);
  const long = query.startsWith(triple, start);
  let i = start + (long ? 3 : 1);
  while (i < query.length) {
    if (query[i] === '\\') {
      i += 2;
    } else if (long ? query.startsWith(triple, i) : query[i] === quote) {
      return long ? i + 2 : i;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Index of the `}` that closes the top-level WHERE group — the first `{` met outside any
 * parenthesized projection expression, matched by depth. Braces inside string literals, IRIs,
 * `#` comments, and after a backslash escape do not count, so neither a sub-SELECT's own solution
 * modifiers nor a trailing comment or `VALUES` block can move the match. Undefined when the group
 * never closes: the query is malformed, and the upstream parser reports where.
 *
 * Each character is visited once — a string, comment, or IRI is skipped whole, and the IRI
 * pattern cannot run past the next `<` — so the scan is linear in the query length.
 */
function whereGroupClose(query: string): number | undefined {
  let braces = 0;
  let parens = 0;
  let inWhere = false;
  for (let i = 0; i < query.length; i++) {
    switch (query[i]) {
      case '\\':
        i++;
        break;
      case '#':
        while (i + 1 < query.length && query[i + 1] !== '\n' && query[i + 1] !== '\r') i++;
        break;
      case '"':
      case "'": {
        const end = stringLiteralEnd(query, i);
        if (end === -1) return;
        i = end;
        break;
      }
      case '<':
        IRI_REF.lastIndex = i;
        if (IRI_REF.test(query)) i = IRI_REF.lastIndex - 1;
        break;
      case '(':
        if (braces === 0) parens++;
        break;
      case ')':
        if (braces === 0 && parens > 0) parens--;
        break;
      case '{':
        // At depth 0 outside parentheses it opens the WHERE group; inside them, an EXISTS.
        if (braces === 0 && parens === 0) inWhere = true;
        braces++;
        break;
      case '}':
        braces--;
        if (braces === 0 && inWhere) return i;
        if (braces < 0) return;
        break;
    }
  }
  return;
}

/** A query ready to send, plus what was injected into it — enough to map an error position back. */
export interface PreparedQuery {
  /** Whole PREFIX lines prepended ahead of the caller's first line. */
  prefixLines: number;
  /** Where the label SERVICE was spliced, in the caller's 1-based coordinates. Absent when none was. */
  splice?: { line: number; column: number; length: number };
  /** The text sent upstream. */
  text: string;
}

/**
 * 1-based line and column of `index`, counted the way Blazegraph counts: CRLF, LF, and a lone CR
 * each end a line, and every character — a tab included — is one column.
 */
function positionOf(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    const char = text[i];
    if (char === '\n' || (char === '\r' && text[i + 1] !== '\n')) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

/**
 * Prepend the standard prefixes the query does not declare and, when the query asks for labels,
 * splice in the label SERVICE.
 *
 * Both injections are shaped so a parse error can be mapped back to the caller's text: prefixes
 * are whole lines ahead of the caller's first line, and the SERVICE is spliced inline just before
 * the WHERE block's closing brace, with no line break. The caller's text is otherwise sent as
 * written — leading blank lines included — except for a leading byte-order mark.
 */
export function prepareQuery(rawQuery: string, language: string): PreparedQuery {
  let text = rawQuery.startsWith('\uFEFF') ? rawQuery.slice(1) : rawQuery;
  let splice: PreparedQuery['splice'];

  /**
   * Inject the label SERVICE when the query asks for a label, description, or alias variable
   * and declares no SERVICE of its own. An empty language (an internal caller that builds its
   * own label filters) skips injection.
   */
  if (language && !declaresLabelService(text) && referencesLabelVariable(text)) {
    const close = whereGroupClose(text);
    if (close !== undefined) {
      const snippet = `${LABEL_SERVICE_SNIPPET(language)} `;
      splice = { ...positionOf(text, close), length: snippet.length };
      text = `${text.slice(0, close)}${snippet}${text.slice(close)}`;
    }
  }

  const declared = new Set<string>();
  for (const line of text.split(/\r\n|\r|\n/)) {
    const m = /^PREFIX\s+(\w+:)/i.exec(line.trim());
    if (m?.[1]) declared.add(m[1]);
  }
  const needed = SPARQL_PREFIXES.split('\n').filter((line) => {
    const m = /^PREFIX\s+(\w+:)/.exec(line);
    return m?.[1] && !declared.has(m[1]);
  });

  return {
    text: needed.length ? `${needed.join('\n')}\n${text}` : text,
    prefixLines: needed.length,
    ...(splice ? { splice } : {}),
  };
}

/**
 * Rewrite each `line N, column M` in a Blazegraph error from the position in the sent text to
 * the position in the caller's: the line less the prepended prefix lines and, on the splice line,
 * a column past the spliced SERVICE less its length. A position inside the injected text has no
 * caller equivalent and is left as reported.
 */
export function toCallerPosition(message: string, prepared: PreparedQuery): string {
  return message.replace(
    /\bline (\d+), column (\d+)/g,
    (match, sentLine: string, sentColumn: string) => {
      const line = Number(sentLine) - prepared.prefixLines;
      if (line < 1) return match;
      let column = Number(sentColumn);
      const { splice } = prepared;
      if (splice && line === splice.line && column >= splice.column + splice.length) {
        column -= splice.length;
      }
      return `line ${line}, column ${column}`;
    },
  );
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
    const prepared = prepareQuery(rawQuery, language);
    const query = prepared.text;

    ctx.log.debug('Executing SPARQL query', { language, timeoutMs: effectiveTimeout });
    return withRetry(
      async () => {
        const timeoutController = new AbortController();
        let timedOut = false;
        const timeoutId = setTimeout(() => {
          if (ctx.signal.aborted) return;
          timedOut = true;
          timeoutController.abort();
        }, effectiveTimeout);
        const signal = AbortSignal.any([ctx.signal, timeoutController.signal]);

        try {
          const response = await fetch(SPARQL_ENDPOINT, {
            method: 'POST',
            headers: {
              'User-Agent': this.userAgent,
              Accept: 'application/sparql-results+json',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ query }),
            signal,
          });

          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            throw rateLimited(
              `Wikidata SPARQL endpoint is rate-limited. ${retryAfter ? `Retry after ${retryAfter}s.` : 'Retry shortly.'}`,
              { reason: 'throttled', ...(retryAfter ? { retryAfter } : {}) },
            );
          }

          if (!response.ok) {
            const body = await response.text().catch(() => '');
            if (response.status === 400 || response.status === 422) {
              const cause = toCallerPosition(extractSparqlError(body), prepared);
              throw validationError(`SPARQL parse error: ${cause}`, {
                reason: 'parse_error',
                cause,
              });
            }
            throw serviceUnavailable(`Wikidata SPARQL endpoint returned HTTP ${response.status}.`, {
              status: response.status,
            });
          }

          const text = await response.text();
          if (isHtmlResponse(text)) {
            throw serviceUnavailable(
              'SPARQL endpoint returned HTML — likely rate-limited or under maintenance.',
            );
          }

          return JSON.parse(text) as SparqlResponse;
        } catch (err) {
          if (timedOut && err instanceof Error && err.name === 'AbortError') {
            throw timeout(
              `SPARQL query timed out after ${effectiveTimeout / 1000}s. Add a LIMIT clause or simplify the query.`,
              { reason: 'timeout' },
            );
          }
          throw err;
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        operation: 'WikidataSparql.query',
        context: ctx,
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
