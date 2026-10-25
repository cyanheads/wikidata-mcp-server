/**
 * @fileoverview Execute a SPARQL query against the Wikidata Query Service.
 * @module mcp-server/tools/definitions/sparql-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { DEFAULT_LANGUAGE, languageFallbackList } from '@/mcp-server/tools/language-code.js';
import { utf8Bytes } from '@/mcp-server/tools/utf8-bytes.js';
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
 * UTF-8 bytes each response surface — serialized `structuredContent` and the `content[]` text,
 * enrichment trailer included — may carry. A code constant rather than an env var: a
 * deploy-tunable threshold would drift the tool's output shape between deployments.
 */
export const RESPONSE_BUDGET_BYTES = 64_000;

/** The budget as prose and descriptions print it ("64,000"). */
const BUDGET_TEXT = RESPONSE_BUDGET_BYTES.toLocaleString('en-US');

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

const headerLine = (variables: string[], truncated: boolean): string =>
  `**Variables:** ${variables.map(escapeMarkdownInline).join(', ')} | **Truncated at the 10,000-row server cap:** ${truncated}`;

/**
 * Bytes one row costs on the larger of the two surfaces: its serialized binding plus the comma
 * that joins it to the next, or its rendered table row plus its line break.
 */
export function rowCharge(row: SparqlRow, variables: string[]): number {
  return Math.max(utf8Bytes(JSON.stringify(row)) + 1, utf8Bytes(renderRow(row, variables)) + 1);
}

/** Most variables the notice's example ORDER BY names. */
const ORDER_BY_EXAMPLE_LIMIT = 4;

/**
 * The notice for a result cut to its first `returned` of `total` rows.
 *
 * Its paging recipe is something an agent executes, so it names no fixed next OFFSET: the cut
 * result may come from an unordered query, whose rows have no stable order to continue from,
 * and a page can itself be cut short of its LIMIT. Paging that holds is an ORDER BY that makes
 * rows unique, from OFFSET 0, advanced by each page's returnedCount. The example orders by the
 * result's own variables, so it never names one the query does not project.
 */
function cutNotice(returned: number, total: number, variables: string[]): string {
  if (returned === 0) {
    return (
      `The first row alone exceeds the ${BUDGET_TEXT}-byte response budget, ` +
      `so none of the ${total} rows is returned. Project fewer variables or shorten long values in the query ` +
      '(SUBSTR, STRLEN), or aggregate in the query (COUNT, GROUP BY).'
    );
  }
  const orderBy = variables
    .slice(0, ORDER_BY_EXAMPLE_LIMIT)
    .map((v) => `?${v}`)
    .join(' ');
  return (
    `Showing the first ${returned} of ${total} rows: each response is held to ${BUDGET_TEXT} bytes. ` +
    'To read every row, page the query: ORDER BY variables that make each row unique ' +
    `(e.g. ORDER BY ${orderBy}) plus LIMIT/OFFSET, starting at OFFSET 0 unless this query was already ordered that way, ` +
    "and advance OFFSET by each page's returnedCount — a page can return fewer rows than its LIMIT. " +
    'Or aggregate in the query (COUNT, GROUP BY) instead of listing rows.'
  );
}

/**
 * Bytes left for rows once the response envelope is paid for on the larger surface: the
 * variables, the `truncated` flag, the table header, and the enrichment a cut result carries
 * (counts and the longer of the two notices `total` can produce).
 */
export function rowAllowance(variables: string[], total: number, truncated: boolean): number {
  const notice = [cutNotice(0, total, variables), cutNotice(total, total, variables)].reduce(
    (a, b) => (a.length >= b.length ? a : b),
  );
  const structured = utf8Bytes(
    JSON.stringify({
      results: [],
      variables,
      truncated,
      totalCount: total,
      returnedCount: total,
      notice,
    }),
  );
  // format()'s header and table head, then the framework's trailer: a blank line, one field per line.
  const text = utf8Bytes(
    [
      headerLine(variables, truncated),
      '',
      ...tableHeader(variables),
      '',
      `**${total} total**`,
      `**Rows returned:** ${total}`,
      `> ${escapeMarkdownInline(notice)}`,
    ].join('\n'),
  );
  return RESPONSE_BUDGET_BYTES - Math.max(structured, text);
}

/** How many leading rows fit the budget, charging each by {@link rowCharge}. Whole rows only. */
function fitRows(rows: SparqlRow[], variables: string[], truncated: boolean): number {
  if (rows.length === 0) return 0;
  let remaining = rowAllowance(variables, rows.length, truncated);
  let count = 0;
  for (const row of rows) {
    remaining -= rowCharge(row, variables);
    if (remaining < 0) break;
    count++;
  }
  return count;
}

export const wikidataSparqlQuery = tool('wikidata_sparql_query', {
  title: 'Wikidata SPARQL Query',
  description:
    'Execute a SPARQL SELECT query against the Wikidata Query Service. ' +
    'Full graph power: multi-hop traversals, aggregations, subqueries, OPTIONAL, FILTER, UNION, BIND. ' +
    'Standard Wikidata prefixes (wd:, wdt:, p:, ps:, pq:, wikibase:, bd:, rdfs:, schema:) are auto-injected. ' +
    'The wikibase:label SERVICE is also auto-injected when the query references a ?<var>Label, ?<var>Description, ' +
    'or ?<var>AltLabel variable and declares no label SERVICE of its own — so you can use ?itemLabel without writing ' +
    'the boilerplate. ' +
    'Hard server timeout is 60s; use LIMIT to keep queries fast. ' +
    'Bindings use the SPARQL 1.1 JSON format: each value is { type, value, "xml:lang"?, datatype? }. ' +
    `Each response is held to ${BUDGET_TEXT} bytes, cut between whole rows: a larger result returns its leading rows ` +
    'with returnedCount and totalCount and a notice — page with ORDER BY plus LIMIT/OFFSET, or aggregate in the query. ' +
    'Use wikidata_get_labels to humanize QID results from this tool.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'SPARQL SELECT query. Any other form — ASK, CONSTRUCT, DESCRIBE, an update, or plain search text — ' +
          'is rejected before it is sent. ' +
          'Standard prefixes (wd:, wdt:, p:, ps:, pq:, wikibase:, bd:, rdfs:, schema:) are injected automatically. ' +
          'Example: SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q146. } LIMIT 10',
      ),
    language: languageFallbackList()
      .default(DEFAULT_LANGUAGE)
      .describe(
        'Wikidata language code, or a comma-separated fallback list tried in order (e.g., "en", "de", "fr,en"), ' +
          'for the injected wikibase:label SERVICE — the language of ?<var>Label, ?<var>Description, and ' +
          '?<var>AltLabel variables. The list falls back to the multilingual ("mul") label last unless it already names mul. ' +
          'Case-insensitive; "_" is read as "-"; blank means "en".',
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
        `Result bindings: every row when the result fits the ${BUDGET_TEXT}-byte response budget, otherwise the leading rows ` +
          'that fit (returnedCount of totalCount). Each row maps variable names to binding objects with ' +
          '{ type, value, "xml:lang"?, datatype? } fields.',
      ),
    variables: z.array(z.string()).describe('Variable names returned by the SELECT clause.'),
    truncated: z
      .boolean()
      .describe(
        'True when the query produced 10,000 rows (totalCount) — the Wikidata/Blazegraph server-side cap — indicating ' +
          'the result set was likely truncated upstream. False otherwise. Add a LIMIT clause to avoid hitting the cap. ' +
          'Independent of the response-budget cut, which returnedCount reports. ' +
          'Note: the SPARQL endpoint does not expose an explicit truncation flag; this is an inferred signal.',
      ),
  }),

  /**
   * Agent-facing query context — row counts, the budget-cut notice, and empty-result guidance.
   * Reaches both structuredContent and content[] without consuming a format() entry. The cut is
   * disclosed under these keys, not ctx.enrich.truncated(), whose `truncated` key would collide
   * with the output field that reports the 10,000-row server cap.
   */
  enrichment: {
    totalCount: z
      .number()
      .describe('Number of rows the query produced, before any response-budget cut.'),
    returnedCount: z
      .number()
      .optional()
      .describe(
        `Number of rows in results — fewer than totalCount when the ${BUDGET_TEXT}-byte response budget cut the result.`,
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Present when the result was cut to fit the response budget (how to page or aggregate for the rest), ' +
          'or when no rows matched (check query logic or broaden filters).',
      ),
  },
  enrichmentTrailer: {
    returnedCount: { label: 'Rows returned' },
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
        'Check SPARQL syntax: verify prefix usage, bracket matching, and SELECT clause format. The error message gives the line and column in your query.',
    },
    {
      reason: 'timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Query exceeded the client-side timeout.',
      retryable: true,
      recovery:
        'Add a LIMIT clause, simplify traversal depth, or narrow the subject with additional WHERE conditions.',
    },
    {
      reason: 'throttled',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Wikidata SPARQL endpoint is rate-limited (60 req/min, 5 concurrent per IP).',
      retryable: true,
      recovery:
        'Wait 30–60 seconds before retrying. Reduce concurrent queries if running parallel requests.',
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
      response = await svc.query(input.query, input.language, input.timeout * 1000, ctx);
    } catch (err) {
      // Re-map service errors to tool error contract reasons
      const e = err as { data?: { reason?: string; cause?: string }; code?: number };
      if (e?.data?.reason === 'parse_error') {
        throw ctx.fail('parse_error', (err as Error).message, { cause: e.data.cause });
      }
      if (e?.data?.reason === 'timeout') {
        throw ctx.fail('timeout', (err as Error).message);
      }
      if (e?.data?.reason === 'throttled') {
        throw ctx.fail('throttled', (err as Error).message);
      }
      throw err;
    }

    const bindings = response.results.bindings as SparqlRow[];
    const variables = response.head.vars;

    // Blazegraph silently caps result sets at 10,000 rows. If we hit exactly that
    // count, the result is likely truncated — treat it as a positive signal.
    const truncated = bindings.length >= 10_000;

    const returned = fitRows(bindings, variables, truncated);
    ctx.enrich.total(bindings.length);
    ctx.enrich({ returnedCount: returned });
    if (bindings.length === 0) {
      ctx.enrich.notice('No results returned. Check query logic or broaden filters.');
    } else if (returned < bindings.length) {
      ctx.log.info('SPARQL result cut to the response budget', {
        total: bindings.length,
        returned,
      });
      ctx.enrich.notice(cutNotice(returned, bindings.length, variables));
    }

    return {
      results: bindings.slice(0, returned) as Array<Record<string, Record<string, unknown>>>,
      variables,
      truncated,
    };
  },

  format: (result) => {
    const lines = [headerLine(result.variables, result.truncated)];
    if (result.results.length > 0) {
      lines.push('', ...tableHeader(result.variables));
      for (const row of result.results) lines.push(renderRow(row as SparqlRow, result.variables));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
