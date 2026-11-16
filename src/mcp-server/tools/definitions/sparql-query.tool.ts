/**
 * @fileoverview Execute a SPARQL query against the Wikidata Query Service.
 * @module mcp-server/tools/definitions/sparql-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { applyCountLimit } from '@/mcp-server/tools/count-limit.js';
import { DEFAULT_LANGUAGE, languageFallbackList } from '@/mcp-server/tools/language-code.js';
import { getWikidataSparqlService } from '@/services/wikidata/wikidata-sparql-service.js';

const isSpace = (char: string | undefined): boolean => char !== undefined && char.trim() === '';

/** Index of the first character past whitespace (a byte-order mark included) and `#` comments. */
function skipSpaceAndComments(query: string, from: number): number {
  let i = from;
  while (i < query.length) {
    if (query[i] === '#') {
      while (i < query.length && query[i] !== '\n' && query[i] !== '\r') i++;
    } else if (isSpace(query[i])) {
      i++;
    } else {
      break;
    }
  }
  return i;
}

/** The run of ASCII letters starting at `from` — a keyword, if one starts there. */
function wordAt(query: string, from: number): string {
  let end = from;
  while (end < query.length && /[A-Za-z]/.test(query[end] as string)) end++;
  return query.slice(from, end);
}

/** Most characters of the leading token a `not_select_query` rejection quotes back. */
const FORM_QUOTE_LIMIT = 30;

/**
 * The query form after the prologue: the first keyword past whitespace, `#` comments, and
 * `BASE`/`PREFIX` declarations, read case-insensitively. Each declaration's IRI is consumed whole,
 * so a `#` inside one is not a comment. Returns `''` when nothing follows the prologue, the first
 * token (at most FORM_QUOTE_LIMIT characters) when no keyword starts there, and `undefined` when
 * a declaration is malformed — a syntax error for the upstream parser to locate, not another
 * query form.
 *
 * A hand scan rather than a schema pattern: JSON Schema `pattern` has no case-insensitive flag,
 * so validating clients would reject a lowercase `select`. Each step only moves forward, so the
 * scan is linear in the query length.
 */
function queryForm(query: string): string | undefined {
  let i = 0;
  for (;;) {
    i = skipSpaceAndComments(query, i);
    const word = wordAt(query, i);
    const keyword = word.toUpperCase();
    if (keyword !== 'PREFIX' && keyword !== 'BASE') {
      if (word) return word.slice(0, FORM_QUOTE_LIMIT);
      let end = i;
      while (end < query.length && end - i < FORM_QUOTE_LIMIT && !isSpace(query[end])) end++;
      return query.slice(i, end);
    }
    i = skipSpaceAndComments(query, i + word.length);
    if (keyword === 'PREFIX') {
      while (i < query.length && query[i] !== ':' && query[i] !== '<' && !isSpace(query[i])) i++;
      if (query[i] !== ':') return;
      i = skipSpaceAndComments(query, i + 1);
    }
    if (query[i] !== '<') return;
    const close = query.indexOf('>', i);
    if (close === -1) return;
    i = close + 1;
  }
}

/**
 * Most rows one call returns. The Query Service has no row maximum, so the ceiling is a size: 4,000
 * typical rows (`?item ?dob ?label`) serialize to about 1 MB of `structuredContent`, the larger of
 * the two surfaces. The service reads at most one binding past it, then aborts the request. A code
 * constant rather than an env var: a deploy-tunable ceiling would drift the tool's output shape
 * between deployments.
 */
const ROW_CEILING = 4_000;

/** The ceiling as prose and descriptions print it ("4,000"). */
const CEILING_TEXT = ROW_CEILING.toLocaleString('en-US');

/**
 * What to do about a capped result. Narrowing and aggregating lead: they work on a match of any
 * size, while ORDER BY paging suits a result not much larger than the ceiling.
 */
const CEILING_NOTICE = `Showing the first ${CEILING_TEXT} rows: the result has more, and rows past the ${CEILING_TEXT}-row ceiling were not read. Narrow the WHERE clause to the rows the task needs, or aggregate in the query (COUNT, GROUP BY) instead of listing rows. To read every row of a result not much larger than the ceiling, page the query with an ORDER BY over variables that make each row unique, a LIMIT of at most ${CEILING_TEXT}, and an OFFSET advanced by that LIMIT on each call.`;

/** The rejection a capped result becomes when `WIKIDATA_CLAMP_LIMITS=false`. */
const CEILING_REJECTION = `The query returned more rows than the ${CEILING_TEXT}-row ceiling. Narrow the WHERE clause, aggregate in the query (COUNT, GROUP BY), add a LIMIT of at most ${CEILING_TEXT}, or page the query with ORDER BY plus LIMIT and OFFSET.`;

/** Guidance for a result with no rows. */
const EMPTY_NOTICE =
  'No results returned. Check query logic or broaden filters. Scholarly articles are reachable only inside SERVICE wdsubgraph:scholarly_articles { … }, and their labels only when read inside that block, with BIND(?paperLabel AS ?paperLabel) and a label SERVICE there.';

/** One SPARQL 1.1 JSON binding value. */
interface SparqlBinding {
  datatype?: string;
  type?: string;
  value?: string;
  'xml:lang'?: string;
}

type SparqlRow = Record<string, SparqlBinding>;

/** Namespaces rendered as prefixed names in `content[]`; longer IRIs come first. */
const NAMESPACES: ReadonlyArray<readonly [string, string]> = [
  ['http://www.wikidata.org/entity/', 'wd:'],
  ['http://www.wikidata.org/prop/direct/', 'wdt:'],
  ['http://www.wikidata.org/prop/statement/', 'ps:'],
  ['http://www.wikidata.org/prop/qualifier/', 'pq:'],
  ['http://www.wikidata.org/prop/', 'p:'],
  ['http://www.w3.org/2001/XMLSchema#', 'xsd:'],
];

/** An IRI as a prefixed name when a known namespace covers it, otherwise `<iri>`. */
function compactIri(iri: string): string {
  const match = NAMESPACES.find(([ns]) => iri.startsWith(ns));
  return match ? `${match[1]}${iri.slice(match[0].length)}` : `<${iri}>`;
}

/**
 * One binding as a table cell, Turtle-style: a URI bare when prefixed or in `<…>`, a literal
 * quoted with its `@lang` or `^^datatype`, a blank node as `_:id`. `|`, CR, and LF are escaped
 * so a value can neither split a cell nor start a new table row.
 */
function renderCell(binding: SparqlBinding | undefined): string {
  if (!binding) return '';
  const value = binding.value ?? '';
  let cell: string;
  if (binding.type === 'uri') {
    cell = compactIri(value);
    const protocol = URL.parse(value)?.protocol;
    if (
      cell.startsWith('<') &&
      (protocol === 'http:' || protocol === 'https:') &&
      !/[\r\n]/.test(value)
    ) {
      // GFM splits table cells before parsing links, including pipes inside destinations.
      return markdownLink(cell, value.replaceAll('|', '%7C'));
    }
  } else if (binding.type === 'bnode') {
    cell = `_:${value}`;
  } else {
    const quoted = `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    const lang = binding['xml:lang'];
    cell = lang
      ? `${quoted}@${lang}`
      : binding.datatype
        ? `${quoted}^^${compactIri(binding.datatype)}`
        : quoted;
  }
  return escapeMarkdownInline(cell.replaceAll('\r', '\\r').replaceAll('\n', '\\n'));
}

const renderRow = (row: SparqlRow, variables: string[]): string =>
  `| ${variables.map((v) => renderCell(row[v])).join(' | ')} |`;

const tableHeader = (variables: string[]): string[] => [
  `| ${variables.map(escapeMarkdownInline).join(' | ')} |`,
  `| ${variables.map(() => '---').join(' | ')} |`,
];

const headerLine = (variables: string[]): string =>
  `**Variables:** ${variables.map(escapeMarkdownInline).join(', ')}`;

export const wikidataSparqlQuery = tool('wikidata_sparql_query', {
  title: 'Wikidata SPARQL Query',
  description: `Execute a SPARQL SELECT query against the Wikidata Query Service. Full graph power: multi-hop traversals, aggregations, subqueries, OPTIONAL, FILTER, UNION, BIND. Standard Wikidata prefixes (wd:, wdt:, p:, ps:, pq:, wikibase:, bd:, rdfs:, schema:) are auto-injected. The wikibase:label SERVICE is also auto-injected when the query references a ?<var>Label, ?<var>Description, or ?<var>AltLabel variable and declares no label SERVICE of its own — so you can use ?itemLabel without writing the boilerplate. Scholarly articles, and every triple they own (DOI, PMID, authorship), live in a separate graph reachable only inside SERVICE wdsubgraph:scholarly_articles { … } (wdsubgraph: is predeclared). The injected label SERVICE runs on the main graph, so read a scholarly article's label inside that block, with BIND(?paperLabel AS ?paperLabel) and a label SERVICE there; a query that writes a label SERVICE gets none injected, so add a top-level one for main-graph labels. Hard server timeout is 60s; use LIMIT to keep queries fast. Each call returns at most ${CEILING_TEXT} rows; a larger result returns its first rows with truncated, shown, and cap in place of totalCount — narrow the WHERE clause or aggregate in the query, or, for a result not much larger than that, page with ORDER BY plus LIMIT and OFFSET. Bindings use the SPARQL 1.1 JSON format: each value is { type, value, "xml:lang"?, datatype? }. Use wikidata_get_labels to humanize QID results from this tool.`,
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'SPARQL SELECT query. Any other form — ASK, CONSTRUCT, DESCRIBE, an update, or plain search text — is rejected before it is sent. Standard prefixes (wd:, wdt:, p:, ps:, pq:, wikibase:, bd:, rdfs:, schema:) are injected automatically. Example: SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q146. } LIMIT 10',
      ),
    language: languageFallbackList()
      .default(DEFAULT_LANGUAGE)
      .describe(
        'Wikidata language code, or a comma-separated fallback list tried in order (e.g., "en", "de", "fr,en"), for the injected wikibase:label SERVICE — the language of ?<var>Label, ?<var>Description, and ?<var>AltLabel variables. The list falls back to the multilingual ("mul") label last unless it already names mul. Case-insensitive; "_" is read as "-"; blank means "en".',
      ),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(55)
      .default(30)
      .describe(
        'Client-side timeout in seconds (1–55). Capped at 55s — the Wikidata server hard limit is 60s.',
      ),
  }),

  output: z.object({
    results: z
      .array(
        // SPARQL 1.1 JSON: variable names are keys; values are { type, value, "xml:lang"?, datatype? }.
        // Variable names are caller-defined and unknowable at schema time — passthrough preserves
        // all fields in structuredContent without aspirational per-field typing.
        z.record(z.string(), z.object({}).passthrough()),
      )
      .describe(
        `Result bindings in query order: every row, or the first ${CEILING_TEXT} when the result has more (truncated). Each row maps variable names to binding objects with { type, value, "xml:lang"?, datatype? } fields.`,
      ),
    variables: z.array(z.string()).describe('Variable names returned by the SELECT clause.'),
  }),

  /**
   * Agent-facing query context — the row count or the ceiling disclosure, and empty-result
   * guidance. Reaches both structuredContent and content[] without consuming a format() entry.
   */
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe(
        'Number of rows the query produced. Present only when the whole result was read: absent when truncated.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        `True when the result had more than ${CEILING_TEXT} rows: only the first ${CEILING_TEXT} were read and returned.`,
      ),
    shown: z.number().optional().describe('Number of rows returned when truncated.'),
    cap: z.number().optional().describe('The row ceiling that truncated the result.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Present when truncated (how to page or aggregate for the rest) or when no rows matched (where else to look).',
      ),
  },
  enrichmentTrailer: {
    notice: {
      render(value: string) {
        return `> ${escapeMarkdownInline(value)}`;
      },
    },
  },

  errors: [
    {
      reason: 'not_select_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query is not a SELECT query: an ASK, CONSTRUCT, DESCRIBE, or update form, or plain text.',
      recovery:
        'Rewrite it as a SELECT query that projects the variables you need. To find an entity by name or keyword, call wikidata_search_entities instead.',
    },
    {
      reason: 'parse_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SPARQL syntax error — the query could not be parsed.',
      recovery:
        'Check SPARQL syntax: verify prefix usage, bracket matching, and SELECT clause format. The error message gives the line and column in your query. Scholarly articles are reachable only inside SERVICE wdsubgraph:scholarly_articles { … }, whose wdsubgraph: prefix is predeclared.',
    },
    {
      reason: 'timeout',
      code: JsonRpcErrorCode.Timeout,
      when: "The query ran past its client-side timeout, or past the Query Service's own 60s limit.",
      retryable: true,
      recovery:
        'Narrow the WHERE clause with additional conditions, simplify traversal depth, or add or lower the LIMIT.',
    },
    {
      reason: 'throttled',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The Wikidata SPARQL endpoint is rate-limiting this server: each client (user agent and IP) gets 60 seconds of query processing time per 60 seconds, and each IP at most 5 parallel queries.',
      retryable: true,
      recovery:
        'Wait 30–60 seconds before retrying. Run at most a few queries in parallel, and keep each one fast: slow queries spend the per-minute processing budget.',
    },
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The result body is larger than the 8 MiB one call reads.',
      recovery:
        'Lower the LIMIT, project fewer variables, or aggregate in the query (COUNT, GROUP BY).',
    },
  ],

  async handler(input, ctx) {
    const form = queryForm(input.query);
    if (form !== undefined && form.toUpperCase() !== 'SELECT') {
      throw ctx.fail(
        'not_select_query',
        form
          ? `wikidata_sparql_query runs SELECT queries only; this query begins with "${form}".`
          : 'wikidata_sparql_query runs SELECT queries only; this query has no query form after its prologue.',
        { found: form },
      );
    }

    const svc = getWikidataSparqlService();
    ctx.log.info('Executing SPARQL query', {
      language: input.language,
      timeout: input.timeout,
      queryLength: input.query.length,
    });

    let response: Awaited<ReturnType<typeof svc.query>>;
    try {
      response = await svc.query(input.query, input.language, input.timeout * 1000, ctx, {
        maxRows: ROW_CEILING,
      });
    } catch (err) {
      // Re-map service errors to tool error contract reasons
      const e = err as {
        data?: { reason?: string; cause?: string; retryAfter?: string };
        code?: number;
      };
      if (e?.data?.reason === 'parse_error') {
        throw ctx.fail('parse_error', (err as Error).message, { cause: e.data.cause });
      }
      if (e?.data?.reason === 'timeout') {
        throw ctx.fail('timeout', (err as Error).message);
      }
      if (e?.data?.reason === 'throttled') {
        // The upstream's Retry-After rides data.retryAfter, which the error trailer renders.
        const { retryAfter } = e.data;
        throw ctx.fail('throttled', (err as Error).message, retryAfter ? { retryAfter } : {});
      }
      if (e?.data?.reason === 'result_too_large') {
        throw ctx.fail('result_too_large', (err as Error).message);
      }
      throw err;
    }

    const bindings = response.results.bindings;
    if (response.stoppedEarly) {
      // The service stopped at binding ROW_CEILING + 1: serve the ceiling, or reject past it.
      applyCountLimit(
        ROW_CEILING + 1,
        ROW_CEILING,
        { field: 'rows', tool: 'wikidata_sparql_query', rejection: CEILING_REJECTION },
        ctx,
      );
      ctx.enrich.truncated({ shown: bindings.length, cap: ROW_CEILING, guidance: CEILING_NOTICE });
    } else {
      ctx.enrich.total(bindings.length);
      if (bindings.length === 0) ctx.enrich.notice(EMPTY_NOTICE);
    }

    return { results: bindings, variables: response.head.vars };
  },

  format: (result) => {
    const lines = [headerLine(result.variables)];
    if (result.results.length > 0) {
      lines.push('', ...tableHeader(result.variables));
      for (const row of result.results) lines.push(renderRow(row as SparqlRow, result.variables));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
