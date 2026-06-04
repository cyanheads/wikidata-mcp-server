/**
 * @fileoverview Tests for wikidata_sparql_query tool.
 * @module tests/tools/sparql-query.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataSparqlQuery } from '@/mcp-server/tools/definitions/sparql-query.tool.js';

const mockQuery = vi.fn();

vi.mock('@/services/wikidata/wikidata-sparql-service.js', () => ({
  getWikidataSparqlService: () => ({ query: mockQuery }),
}));

const sparqlResponse = {
  head: { vars: ['item', 'itemLabel'] },
  results: {
    bindings: [
      {
        item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q146' },
        itemLabel: { type: 'literal', value: 'domestic cat', 'xml:lang': 'en' },
      },
    ],
  },
};

describe('wikidataSparqlQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes a SPARQL query and returns results', async () => {
    mockQuery.mockResolvedValue(sparqlResponse);

    const ctx = createMockContext({ errors: wikidataSparqlQuery.errors });
    const input = wikidataSparqlQuery.input.parse({
      query: 'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q146. } LIMIT 5',
    });
    const result = await wikidataSparqlQuery.handler(input, ctx);

    expect(result.variables).toEqual(['item', 'itemLabel']);
    expect(result.truncated).toBe(false);
    expect(result.results[0]!.item).toBeDefined();

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('returns empty results and emits a notice enrichment for a query with no matches', async () => {
    mockQuery.mockResolvedValue({
      head: { vars: ['item'] },
      results: { bindings: [] },
    });

    const ctx = createMockContext({ errors: wikidataSparqlQuery.errors });
    const input = wikidataSparqlQuery.input.parse({
      query: 'SELECT ?item WHERE { ?item wdt:P31 wd:Q99999999. } LIMIT 1',
    });
    const result = await wikidataSparqlQuery.handler(input, ctx);

    expect(result.results).toHaveLength(0);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No results');
  });

  it('sets truncated=true when result count equals 10,000 (server cap)', async () => {
    const bindings = Array.from({ length: 10_000 }, (_, i) => ({
      item: { type: 'uri' as const, value: `http://www.wikidata.org/entity/Q${i + 1}` },
    }));
    mockQuery.mockResolvedValue({ head: { vars: ['item'] }, results: { bindings } });

    const ctx = createMockContext({ errors: wikidataSparqlQuery.errors });
    const input = wikidataSparqlQuery.input.parse({
      query: 'SELECT ?item WHERE { ?item wdt:P31 wd:Q5. }',
    });
    const result = await wikidataSparqlQuery.handler(input, ctx);

    expect(result.truncated).toBe(true);
  });

  it('throws parse_error when service signals a parse failure', async () => {
    mockQuery.mockRejectedValue({
      data: { reason: 'parse_error' },
      message: 'Syntax error at line 1',
    });

    const ctx = createMockContext({ errors: wikidataSparqlQuery.errors });
    const input = wikidataSparqlQuery.input.parse({ query: 'INVALID SPARQL' });
    await expect(wikidataSparqlQuery.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'parse_error' },
      code: JsonRpcErrorCode.ValidationError,
    });
  });

  it('throws timeout when service signals a timeout', async () => {
    mockQuery.mockRejectedValue({ data: { reason: 'timeout' }, message: 'Query timed out' });

    const ctx = createMockContext({ errors: wikidataSparqlQuery.errors });
    const input = wikidataSparqlQuery.input.parse({
      query: 'SELECT ?item WHERE { ?item ?p ?o. } LIMIT 1000000',
    });
    await expect(wikidataSparqlQuery.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'timeout' },
    });
  });

  it('throws throttled when service signals rate limiting', async () => {
    mockQuery.mockRejectedValue({ data: { reason: 'throttled' }, message: 'Rate limited' });

    const ctx = createMockContext({ errors: wikidataSparqlQuery.errors });
    const input = wikidataSparqlQuery.input.parse({
      query: 'SELECT ?item WHERE { ?item wdt:P31 wd:Q5. } LIMIT 10',
    });
    await expect(wikidataSparqlQuery.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'throttled' },
    });
  });

  it('re-throws unknown service errors', async () => {
    mockQuery.mockRejectedValue(new Error('Unexpected network error'));

    const ctx = createMockContext({ errors: wikidataSparqlQuery.errors });
    const input = wikidataSparqlQuery.input.parse({
      query: 'SELECT ?item WHERE { ?item wdt:P31 wd:Q5. } LIMIT 1',
    });
    await expect(wikidataSparqlQuery.handler(input, ctx)).rejects.toThrow(
      'Unexpected network error',
    );
  });

  it('formats results as a table', () => {
    const output = {
      results: [
        {
          item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q146' },
          itemLabel: { type: 'literal', value: 'domestic cat' },
        },
      ],
      variables: ['item', 'itemLabel'],
      truncated: false,
    };
    const blocks = wikidataSparqlQuery.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('item');
    expect(text).toContain('itemLabel');
  });

  it('formats empty results', () => {
    const output = {
      results: [],
      variables: ['item'],
      truncated: false,
    };
    const blocks = wikidataSparqlQuery.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('item');
  });

  it('format: caps output at 20 rows and appends overflow indicator', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      item: { type: 'uri', value: `http://www.wikidata.org/entity/Q${i + 1}` },
    }));
    const output = {
      results: rows,
      variables: ['item'],
      truncated: false,
    };
    const blocks = wikidataSparqlQuery.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // Only 20 rows rendered + overflow line
    expect(text).toContain('5 more rows');
  });

  it('format: reflects truncated=true flag', () => {
    const output = {
      results: [{ item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q1' } }],
      variables: ['item'],
      truncated: true,
    };
    const blocks = wikidataSparqlQuery.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('true');
  });

  it('enrichment: totalCount is set on non-empty results', async () => {
    mockQuery.mockResolvedValue(sparqlResponse);

    const ctx = createMockContext({ errors: wikidataSparqlQuery.errors });
    const input = wikidataSparqlQuery.input.parse({
      query: 'SELECT ?item WHERE { ?item wdt:P31 wd:Q146. } LIMIT 1',
    });
    await wikidataSparqlQuery.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('security: SPARQL injection in query string is passed to the service and not re-executed by the server', async () => {
    // The server passes the query verbatim to the SPARQL service — it does NOT execute
    // or interpolate the query string itself. The mock captures what was actually sent.
    mockQuery.mockResolvedValue({ head: { vars: ['x'] }, results: { bindings: [] } });

    const ctx = createMockContext({ errors: wikidataSparqlQuery.errors });
    const injectionQuery =
      'SELECT ?x WHERE { ?x ?p ?o. } LIMIT 1 ; DROP GRAPH <http://example.org/> -- injection';
    const input = wikidataSparqlQuery.input.parse({ query: injectionQuery });
    await wikidataSparqlQuery.handler(input, ctx);

    // The service receives the raw query string — no server-side interpolation was applied
    const [calledQuery] = mockQuery.mock.calls[0] as [string, ...unknown[]];
    expect(calledQuery).toBe(injectionQuery);
    // No second service call was made (no re-execution)
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('security: no env secret appears in query result output', async () => {
    process.env['TEST_SPARQL_SECRET'] = 'sparql_secret_abc123';
    mockQuery.mockResolvedValue({
      head: { vars: ['item'] },
      results: {
        bindings: [{ item: { type: 'literal', value: 'public_value' } }],
      },
    });

    const ctx = createMockContext({ errors: wikidataSparqlQuery.errors });
    const input = wikidataSparqlQuery.input.parse({
      query: 'SELECT ?item WHERE { BIND("public_value" AS ?item) }',
    });
    const result = await wikidataSparqlQuery.handler(input, ctx);

    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('sparql_secret_abc123');
    delete process.env['TEST_SPARQL_SECRET'];
  });

  it('input validation: query below minimum length is rejected by Zod', () => {
    expect(() => wikidataSparqlQuery.input.parse({ query: '' })).toThrow();
  });

  it('input validation: timeout below minimum (0) is rejected by Zod', () => {
    expect(() =>
      wikidataSparqlQuery.input.parse({
        query: 'SELECT ?x WHERE { ?x ?p ?o. } LIMIT 1',
        timeout: 0,
      }),
    ).toThrow();
  });

  it('input validation: timeout above maximum (56) is rejected by Zod', () => {
    expect(() =>
      wikidataSparqlQuery.input.parse({
        query: 'SELECT ?x WHERE { ?x ?p ?o. } LIMIT 1',
        timeout: 56,
      }),
    ).toThrow();
  });
});
