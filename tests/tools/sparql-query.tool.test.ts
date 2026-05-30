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
});
