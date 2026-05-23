/**
 * @fileoverview Execute a SPARQL query against the Wikidata Query Service.
 * @module mcp-server/tools/definitions/sparql-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getWikidataSparqlService } from '@/services/wikidata/wikidata-sparql-service.js';

export const wikidataSparqlQuery = tool('wikidata_sparql_query', {
  title: 'Wikidata SPARQL Query',
  description:
    'Execute a SPARQL SELECT query against the Wikidata Query Service (Blazegraph). ' +
    'Full graph power: multi-hop traversals, aggregations, subqueries, OPTIONAL, FILTER, UNION, BIND. ' +
    'Standard Wikidata prefixes (wd:, wdt:, p:, ps:, pq:, wikibase:, bd:) are auto-injected. ' +
    'The wikibase:label SERVICE is also auto-injected when language is set and the query includes ?<var>Label ' +
    'variables — so you can use ?itemLabel without writing the boilerplate. ' +
    'Hard server timeout is 60s; use LIMIT to keep queries fast. ' +
    'Bindings use the SPARQL 1.1 JSON format: each value is { type, value, "xml:lang"? }. ' +
    'Use wikidata_get_labels to humanize QID results from this tool.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'SPARQL SELECT query. Must be a SELECT query (not CONSTRUCT/DESCRIBE/ASK). ' +
          'Standard prefixes are auto-injected; do not include them yourself. ' +
          'Example: SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q146. } LIMIT 10',
      ),
    language: z
      .string()
      .default('en')
      .describe(
        'Language for the wikibase:label SERVICE (e.g., "en", "de"). ' +
          'Controls the language of ?<var>Label variables. Set to "" to suppress label SERVICE injection.',
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
        'Array of result bindings. Each row maps variable names to binding objects with { type, value, "xml:lang"?, datatype? } fields.',
      ),
    variables: z.array(z.string()).describe('Variable names returned by the SELECT clause.'),
    rowCount: z.number().describe('Number of result rows.'),
    truncated: z
      .boolean()
      .describe(
        'True when the endpoint returned a partial result set due to server-side memory limits. ' +
          'False when the full result was returned. Add a LIMIT clause to avoid truncation on large queries.',
      ),
  }),

  errors: [
    {
      reason: 'parse_error',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'SPARQL syntax error — the query could not be parsed.',
      recovery:
        'Check SPARQL syntax: verify prefix usage, bracket matching, and SELECT clause format. The error message includes the relevant line.',
    },
    {
      reason: 'timeout',
      code: JsonRpcErrorCode.ServiceUnavailable,
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
      const e = err as { data?: { reason?: string; status?: number }; code?: number };
      if (e?.data?.reason === 'parse_error') {
        throw ctx.fail('parse_error', (err as Error).message, {
          ...ctx.recoveryFor('parse_error'),
        });
      }
      if (e?.data?.reason === 'timeout') {
        throw ctx.fail('timeout', (err as Error).message, {
          ...ctx.recoveryFor('timeout'),
        });
      }
      if (e?.data?.reason === 'throttled') {
        throw ctx.fail('throttled', (err as Error).message, {
          ...ctx.recoveryFor('throttled'),
        });
      }
      throw err;
    }

    const bindings = response.results.bindings;
    const variables = response.head.vars;

    return {
      results: bindings as Array<Record<string, Record<string, unknown>>>,
      variables,
      rowCount: bindings.length,
      truncated: false,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**Variables:** ${result.variables.join(', ')} | **Rows:** ${result.rowCount} | **Truncated:** ${result.truncated}`,
    ];

    if (result.rowCount === 0) {
      lines.push('\n> No results returned. Check query logic or broaden filters.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    // Render as a simple table (first 20 rows)
    const cap = Math.min(result.rowCount, 20);
    const header = result.variables.join(' | ');
    const separator = result.variables.map(() => '---').join(' | ');
    lines.push('');
    lines.push(`| ${header} |`);
    lines.push(`| ${separator} |`);

    for (let i = 0; i < cap; i++) {
      const row = result.variables.map((v) => {
        const raw = result.results[i]?.[v];
        if (!raw) return '';
        const binding = raw as {
          type?: string;
          value?: string;
          'xml:lang'?: string;
          datatype?: string;
        };
        const val = (binding.value ?? '')
          .replace('http://www.wikidata.org/entity/', 'wd:')
          .replace('http://www.wikidata.org/prop/direct/', 'wdt:');
        const lang = binding['xml:lang'] ? ` @${binding['xml:lang']}` : '';
        return `${val}${lang}`;
      });
      lines.push(`| ${row.join(' | ')} |`);
    }

    if (result.rowCount > 20) {
      lines.push(`\n… ${result.rowCount - 20} more rows not shown.`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
