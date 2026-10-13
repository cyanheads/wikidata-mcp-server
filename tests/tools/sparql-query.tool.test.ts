/**
 * @fileoverview Tests for wikidata_sparql_query tool.
 * @module tests/tools/sparql-query.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESPONSE_BUDGET_BYTES,
  rowAllowance,
  rowCharge,
  wikidataSparqlQuery,
} from '@/mcp-server/tools/definitions/sparql-query.tool.js';
import { expectBoundedScan } from '../helpers/scan-cost.js';

const mockQuery = vi.fn();

vi.mock('@/services/wikidata/wikidata-sparql-service.js', () => ({
  getWikidataSparqlService: () => ({ query: mockQuery }),
}));

/** The data rows of a rendered table — every `| … |` line past the header and separator. */
const tableRows = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .slice(2);

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** Bytes on each surface of a tool result, as the caller receives it. */
const surfaceBytes = (result: Awaited<ReturnType<typeof runToolContract>>) => ({
  structured: utf8Bytes(JSON.stringify(result.structuredContent)),
  text: utf8Bytes(result.content.map((b) => (b as { text: string }).text).join('')),
});

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
    const input = wikidataSparqlQuery.input.parse({ query: 'SELECT ?x WHERE { ?x wdt:P31 ;; }' });
    await expect(wikidataSparqlQuery.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'parse_error' },
      code: JsonRpcErrorCode.ValidationError,
    });
  });

  /** The service maps the position in `data.cause` to the caller's query; it must reach the wire. */
  it('carries the Blazegraph cause through to the parse_error on the wire', async () => {
    const cause = 'Encountered " "a" "a "" at line 1, column 44.';
    mockQuery.mockRejectedValue({
      data: { reason: 'parse_error', cause },
      message: `SPARQL parse error: ${cause}`,
    });

    const result = await runToolContract(wikidataSparqlQuery, {
      query: 'SELECT ?x WHERE { ?x wdt:P31 wd:Q5 } LIMIT abc',
    } as never);

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'parse_error', cause } },
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

  it('format: renders every row it is given — 25 rows, 25 table rows (#28)', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      item: { type: 'uri', value: `http://www.wikidata.org/entity/Q${i + 1}` },
    }));
    const blocks = wikidataSparqlQuery.format!({
      results: rows,
      variables: ['item'],
      truncated: false,
    });
    const text = blocks.map((b) => (b as { text: string }).text).join('\n');

    expect(tableRows(text)).toHaveLength(25);
    expect(tableRows(text).at(-1)).toBe('| wd:Q25 |');
    expect(text).not.toContain('more rows');
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

  /** #36: one shared language-code schema; this tool alone also takes a fallback list. */
  describe('language input', () => {
    const call = (args: Record<string, unknown>) =>
      runToolContract(wikidataSparqlQuery, args as never);
    const query = 'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q146 } LIMIT 3';

    it.each([
      ['', 'en'],
      ['  ', 'en'],
      ['EN', 'en'],
      ['en_GB', 'en-gb'],
      ['fr,en', 'fr,en'],
      ['fr, en', 'fr,en'],
      [' FR , de_AT ', 'fr,de-at'],
    ])('passes language %j to the service as %j', async (language, expected) => {
      mockQuery.mockResolvedValue(sparqlResponse);

      const result = await call({ query, language });

      expect(result.isError).toBeFalsy();
      expect(mockQuery).toHaveBeenCalledWith(query, expected, 30_000, expect.anything());
    });

    it.each([
      ['en" || true || "'],
      ['en\\'],
      ['{en}'],
      ['en|de'],
      ['en gb'],
      ['[AUTO_LANGUAGE]'],
      ['fr,'],
      ['fr;en'],
    ])('rejects language %j as invalid arguments before any upstream call', async (language) => {
      const result = await call({ query, language });

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  /**
   * #29: the tool runs SELECT only. Other forms reached the upstream and failed late — ASK
   * crashed reading `results.bindings` as an InternalError, CONSTRUCT/DESCRIBE returned triples.
   * The handler now checks the form after the prologue, before any upstream request.
   */
  describe('query-form check', () => {
    const run = async (query: string) => {
      const ctx = createMockContext({ errors: wikidataSparqlQuery.errors });
      return wikidataSparqlQuery.handler(wikidataSparqlQuery.input.parse({ query }), ctx);
    };

    it.each([
      ['ASK', 'ASK WHERE { wd:Q42 wdt:P31 wd:Q5 }', 'ASK'],
      ['CONSTRUCT', 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } LIMIT 1', 'CONSTRUCT'],
      ['DESCRIBE', 'DESCRIBE wd:Q42', 'DESCRIBE'],
      ['INSERT DATA', 'INSERT DATA { wd:Q1 wdt:P31 wd:Q5 }', 'INSERT'],
      ['DELETE WHERE', 'DELETE WHERE { ?s ?p ?o }', 'DELETE'],
      ['LOAD', 'LOAD <http://example.org/data.ttl>', 'LOAD'],
      ['CLEAR', 'CLEAR ALL', 'CLEAR'],
      ['DROP', 'DROP ALL', 'DROP'],
      [
        'WITH … DELETE',
        'WITH <http://example.org/g> DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }',
        'WITH',
      ],
      ['a sub-SELECT inside an ASK', 'ASK { SELECT ?x WHERE { ?x ?p ?o } }', 'ASK'],
      [
        'a prologue then ASK',
        'PREFIX wd: <http://www.wikidata.org/entity/>\nask { wd:Q42 ?p ?o }',
        'ask',
      ],
      ['plain text', 'react hooks useEffect', 'react'],
      ['a SELECT-like word', 'SELECTED ?x WHERE { ?x ?p ?o }', 'SELECTED'],
      ['a bare group pattern', '{ ?x ?p ?o }', '{'],
    ])(
      'rejects %s as not_select_query without an upstream request',
      async (_name, query, found) => {
        const err = await run(query).catch((e: unknown) => e);

        expect(err).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'not_select_query' },
        });
        expect((err as Error).message).toContain(`begins with "${found}"`);
        expect(mockQuery).not.toHaveBeenCalled();
      },
    );

    /** The rejection quotes the leading token; a caller-sized one must not come back whole. */
    it('quotes at most 30 characters of a long leading word', async () => {
      const err = (await run(`${'a'.repeat(100_000)} b`).catch((e: unknown) => e)) as {
        message: string;
        data: { found: string };
      };

      expect(err.data.found).toBe('a'.repeat(30));
      expect(err.message.length).toBeLessThan(200);
    });

    it.each([
      ['a comment-only query', '# SELECT ?x WHERE { ?x ?p ?o }'],
      ['several comment lines', '# one\n# two\r\n'],
      ['whitespace only', ' \t\n '],
      ['a prologue with nothing after it', 'PREFIX wd: <http://www.wikidata.org/entity/>\n'],
    ])('rejects %s, naming no query form', async (_name, query) => {
      const err = await run(query).catch((e: unknown) => e);

      expect(err).toMatchObject({ data: { reason: 'not_select_query' } });
      expect((err as Error).message).toContain('no query form');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('carries a recovery hint routing keyword lookups to wikidata_search_entities', async () => {
      const result = await runToolContract(wikidataSparqlQuery, {
        query: 'ASK WHERE { wd:Q42 wdt:P31 wd:Q5 }',
      } as never);

      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as {
          error: { code: number; data: { reason: string; recovery: { hint: string } } };
        }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('not_select_query');
      expect(error.data.recovery.hint).toContain('wikidata_search_entities');
      expect(result.content?.[0]).toMatchObject({
        text: expect.stringContaining('wikidata_search_entities'),
      });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it.each([
      ['lowercase select', 'select ?x where { ?x ?p ?o } limit 1'],
      [
        'lowercase prefix',
        'prefix wd: <http://www.wikidata.org/entity/>\nselect ?x where { ?x ?p wd:Q5 }',
      ],
      ['lowercase base', 'base <http://example.org/>\nSELECT ?x WHERE { ?x ?p ?o }'],
      ['a leading comment line', '# find cats\nSELECT ?x WHERE { ?x wdt:P31 wd:Q146 }'],
      [
        'a # inside a PREFIX IRI',
        'PREFIX ex: <http://example.org/a#b>\nSELECT ?x WHERE { ?x ex:p ?o }',
      ],
      ['an empty prefix name', 'PREFIX : <http://example.org/>\nSELECT ?x WHERE { ?x :p ?o }'],
      [
        'no space before the IRI',
        'PREFIX ex:<http://example.org/>\nSELECT ?x WHERE { ?x ex:p ?o }',
      ],
      [
        'a comment between a prefix name and its IRI',
        'PREFIX ex: # the example vocabulary\n  <http://example.org/>\nSELECT ?x WHERE { ?x ex:p ?o }',
      ],
      [
        'trailing whitespace and blank lines after the prologue',
        'PREFIX wd: <http://www.wikidata.org/entity/>   \n\n\n  SELECT ?x WHERE { ?x ?p wd:Q5 }',
      ],
      [
        'CRLF line endings',
        'PREFIX wd: <http://www.wikidata.org/entity/>\r\n# c\r\nSELECT ?x WHERE { ?x ?p wd:Q5 }',
      ],
      ['a leading BOM', '\uFEFFSELECT ?x WHERE { ?x ?p ?o }'],
      ['SELECT DISTINCT', 'SELECT DISTINCT ?x WHERE { ?x ?p ?o }'],
      ['SELECT REDUCED', 'SELECT REDUCED ?x WHERE { ?x ?p ?o }'],
      ['SELECT*', 'SELECT* WHERE { ?x ?p ?o } LIMIT 1'],
      ['the word ASK inside the WHERE block', 'SELECT ?x WHERE { ?x rdfs:label "ASK" }'],
      ['a malformed SELECT', 'SELECT ?x WHERE { ?x wdt:P31 ;; }'],
    ])('passes a query with %s to the service exactly as sent', async (_name, query) => {
      mockQuery.mockResolvedValue({ head: { vars: ['x'] }, results: { bindings: [] } });

      await run(query);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0]?.[0]).toBe(query);
    });

    /**
     * A prologue the check cannot read — a PREFIX missing its colon or IRI — is a syntax
     * error, not another query form, so it goes upstream for a positioned parse_error.
     */
    it('leaves a malformed prologue to the upstream parser', async () => {
      mockQuery.mockRejectedValue({
        data: { reason: 'parse_error' },
        message: 'SPARQL parse error: …',
      });

      const err = await run(
        'PREFIX wd <http://www.wikidata.org/entity/>\nSELECT ?x WHERE { ?x ?p wd:Q5 }',
      ).catch((e: unknown) => e);

      expect(err).toMatchObject({ data: { reason: 'parse_error' } });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    /** The check scans caller-sized text: each worst case is an opener with no closer. */
    it.each<[string, (n: number) => string]>([
      ['unterminated PREFIX openers', (n) => 'PREFIX x: <'.repeat(n / 11)],
      ['a # run', (n) => '#'.repeat(n)],
      ['a whitespace run', (n) => ' '.repeat(n)],
      ['complete PREFIX declarations with no query form', (n) => 'PREFIX x: <y>\n'.repeat(n / 14)],
      ['PREFIX keywords with no name', (n) => 'PREFIX '.repeat(n / 7)],
      ['comment lines', (n) => '# c\n'.repeat(n / 4)],
      ['one long leading word', (n) => 'a'.repeat(n)],
      ['an unterminated BASE IRI', (n) => `BASE ${'<'.repeat(n)}`],
      ['dense PREFIX declarations', (n) => 'PREFIX x:<>'.repeat(n / 11)],
      ['a PREFIX name run with no colon', (n) => `PREFIX ${'x'.repeat(n)}`],
    ])(
      'the form check over %s stays under the super-linear ceiling at 400k characters',
      async (_name, build) => {
        const ctx = createMockContext({ errors: wikidataSparqlQuery.errors });
        mockQuery.mockResolvedValue({ head: { vars: [] }, results: { bindings: [] } });
        expectBoundedScan(build, (query) => {
          // The check runs synchronously before the handler's first await; the promise is discarded.
          Promise.resolve(
            wikidataSparqlQuery.handler({ query, language: 'en', timeout: 30 }, ctx),
          ).catch(() => {});
        });
      },
    );
  });

  /**
   * #28: content[] rendered only the first 20 rows while structuredContent carried up to 10,000
   * (2.5 MB). Both surfaces now carry the same leading rows, each held to 64,000 bytes.
   */
  describe('response budget (#28)', () => {
    const query = 'SELECT ?item ?label WHERE { ?item rdfs:label ?label }';
    const run = (bindings: unknown[], vars = ['item', 'label']) => {
      mockQuery.mockResolvedValue({ head: { vars }, results: { bindings } });
      return runToolContract(wikidataSparqlQuery, { query });
    };
    type Structured = {
      results: Array<Record<string, { value: string }>>;
      truncated: boolean;
      totalCount: number;
      returnedCount?: number;
      notice?: string;
    };
    const structuredOf = (result: Awaited<ReturnType<typeof run>>) =>
      result.structuredContent as Structured;
    const textOf = (result: Awaited<ReturnType<typeof run>>) =>
      result.content.map((b) => (b as { text: string }).text).join('');

    /** A row whose value is `n` characters of padding — the size lever for boundary tests. */
    const row = (i: number, n: number) => ({
      item: { type: 'uri', value: `http://www.wikidata.org/entity/Q${i}` },
      label: { type: 'literal', value: 'x'.repeat(n), 'xml:lang': 'en' },
    });

    /**
     * `count` rows whose charges sum to exactly `total` bytes: equal rows, with the last row
     * padded by the remainder (each padding character adds one byte to the charge).
     */
    const rowsCharging = (count: number, total: number) => {
      const base = rowCharge(row(1, 0), ['item', 'label']);
      const each = Math.floor(total / count) - base;
      const rows = Array.from({ length: count }, (_, i) => row(i + 1, each));
      const spent = rows.reduce((sum, r) => sum + rowCharge(r, ['item', 'label']), 0);
      rows[count - 1] = row(count, each + (total - spent));
      return rows;
    };

    it('returns a result that fits unchanged, stating both counts', async () => {
      const result = await run([row(1, 5), row(2, 5)]);
      const structured = structuredOf(result);

      expect(structured.results).toHaveLength(2);
      expect(structured.totalCount).toBe(2);
      expect(structured.returnedCount).toBe(2);
      expect(structured.notice).toBeUndefined();
      expect(tableRows(textOf(result))).toHaveLength(2);
      expect(textOf(result)).toContain('**Rows returned:** 2');
    });

    it('returns every row when their charges land exactly on the budget', async () => {
      const allowance = rowAllowance(['item', 'label'], 40, false);
      const bindings = rowsCharging(40, allowance);
      expect(bindings.reduce((sum, r) => sum + rowCharge(r, ['item', 'label']), 0)).toBe(allowance);

      const result = await run(bindings);
      const structured = structuredOf(result);

      expect(structured.results).toHaveLength(40);
      expect(structured.returnedCount).toBe(40);
      expect(structured.notice).toBeUndefined();
      expect(tableRows(textOf(result))).toHaveLength(40);
      const size = surfaceBytes(result);
      expect(size.structured).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      expect(size.text).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    });

    it('cuts the last row when the charges run one byte over, on both surfaces', async () => {
      const allowance = rowAllowance(['item', 'label'], 40, false);
      const bindings = rowsCharging(40, allowance + 1);

      const result = await run(bindings);
      const structured = structuredOf(result);
      const text = textOf(result);

      expect(structured.results).toHaveLength(39);
      expect(structured.totalCount).toBe(40);
      expect(structured.returnedCount).toBe(39);
      expect(structured.truncated).toBe(false);
      expect(structured.notice).toContain('first 39 of 40 rows');
      expect(structured.notice).toContain('ORDER BY');
      expect(structured.notice).toContain('LIMIT/OFFSET');
      expect(structured.notice).toContain('aggregate');
      // The same leading rows on both surfaces, and the counts and notice reach content[] too.
      const rendered = tableRows(text);
      expect(rendered).toHaveLength(39);
      expect(rendered.at(-1)).toContain('wd:Q39 ');
      expect(structured.results.at(-1)?.item?.value).toBe('http://www.wikidata.org/entity/Q39');
      expect(text).toContain('40 total');
      expect(text).toContain('**Rows returned:** 39');
      expect(text).toContain('> Showing the first 39 of 40 rows');
      const size = surfaceBytes(result);
      expect(size.structured).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      expect(size.text).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    });

    /**
     * Fifty variables, one bound: the rendered row (49 empty cells) outweighs its serialized
     * binding, so the charge — and the boundary — is set by the content[] side.
     */
    it('holds content[] at the boundary when rendered rows outweigh their bindings', async () => {
      const vars = Array.from({ length: 50 }, (_, i) => `v${i + 1}`);
      const sparse = (n: number) => ({ v1: { type: 'literal', value: 'x'.repeat(n) } });
      expect(utf8Bytes(JSON.stringify(sparse(0)))).toBeLessThan(rowCharge(sparse(0), vars) - 1);
      const allowance = rowAllowance(vars, 300, false);
      const base = rowCharge(sparse(0), vars);
      const each = Math.floor(allowance / 300) - base;
      const bindings = Array.from({ length: 300 }, () => sparse(each));
      const spent = bindings.reduce((sum, r) => sum + rowCharge(r, vars), 0);
      bindings[299] = sparse(each + (allowance - spent));

      const atBudget = await run(bindings, vars);
      expect(structuredOf(atBudget).returnedCount).toBe(300);
      expect(surfaceBytes(atBudget).text).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);

      bindings[299] = sparse(each + (allowance - spent) + 1);
      const over = await run(bindings, vars);
      expect(structuredOf(over).returnedCount).toBe(299);
      expect(tableRows(textOf(over))).toHaveLength(299);
      expect(surfaceBytes(over).text).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    });

    /**
     * The notice is a paging recipe an agent executes. Its example must order by variables the
     * query actually projects, and it cannot be a fixed `OFFSET <returned>`: the cut page came
     * from an unordered query (no stable order to continue), and a page cut again returns fewer
     * rows than its LIMIT, so the next OFFSET is the running sum of returnedCount. The query here
     * binds no `?item`, the variable a fixed example would have named.
     */
    it('pages by the notice: ORDER BY over the result variables, from OFFSET 0, advancing by returnedCount', async () => {
      const vars = ['a', 'b', 'c', 'd', 'e'];
      const wide = (i: number) =>
        Object.fromEntries(
          vars.map((v) => [v, { type: 'literal', value: `${i}-${'x'.repeat(3_000)}` }]),
        );
      const result = await run(
        Array.from({ length: 10 }, (_, i) => wide(i)),
        vars,
      );
      const { notice = '', returnedCount } = structuredOf(result);
      expect(returnedCount).toBeLessThan(10);

      // The query's own variables in projection order, at most four.
      const orderBy = /ORDER BY((?:\s+\?\w+)+)/.exec(notice)?.[1]?.trim().split(/\s+/);
      expect(orderBy).toEqual(['?a', '?b', '?c', '?d']);
      expect(notice).toContain('OFFSET 0');
      expect(notice).toContain('returnedCount');
      expect(notice).not.toContain(`OFFSET ${returnedCount})`);
    });

    it('returns no rows, and says why, when the first row alone overflows', async () => {
      const result = await run([row(1, 70_000), row(2, 5)]);
      const structured = structuredOf(result);

      expect(structured.results).toHaveLength(0);
      expect(structured.totalCount).toBe(2);
      expect(structured.returnedCount).toBe(0);
      expect(structured.notice).toContain('first row alone exceeds');
      expect(tableRows(textOf(result))).toHaveLength(0);
      const size = surfaceBytes(result);
      expect(size.structured).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      expect(size.text).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    });

    it('returns an empty result with zero counts and the no-results notice', async () => {
      const result = await run([]);
      const structured = structuredOf(result);

      expect(structured.results).toHaveLength(0);
      expect(structured.totalCount).toBe(0);
      expect(structured.returnedCount).toBe(0);
      expect(structured.notice).toContain('No results returned');
      expect(textOf(result)).toContain('**Rows returned:** 0');
    });

    /** The 10,000-row shape from the issue: ~2.5 MB of structuredContent before the budget. */
    it('holds a 10,000-row result to the budget on both surfaces, keeping truncated for the server cap', async () => {
      const bindings = Array.from({ length: 10_000 }, (_, i) => ({
        item: { type: 'uri', value: `http://www.wikidata.org/entity/Q${i + 1}` },
        dob: {
          type: 'literal',
          value: '1952-03-11T00:00:00Z',
          datatype: 'http://www.w3.org/2001/XMLSchema#dateTime',
        },
        label: { type: 'literal', value: `Person ${i + 1}`, 'xml:lang': 'en' },
      }));

      const result = await run(bindings, ['item', 'dob', 'label']);
      const structured = structuredOf(result);
      const returned = structured.results.length;

      expect(structured.truncated).toBe(true);
      expect(structured.totalCount).toBe(10_000);
      expect(returned).toBeGreaterThan(100);
      expect(returned).toBeLessThan(10_000);
      expect(structured.returnedCount).toBe(returned);
      expect(tableRows(textOf(result))).toHaveLength(returned);
      expect(structured.notice).toContain(`first ${returned} of 10000 rows`);
      const size = surfaceBytes(result);
      expect(size.structured).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      expect(size.text).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    });
  });

  describe('cell rendering (#28)', () => {
    const render = (results: Array<Record<string, Record<string, string>>>, variables: string[]) =>
      (wikidataSparqlQuery.format!({ results, variables, truncated: false })[0] as { text: string })
        .text;

    it('tells a URI from a literal and shows datatype or language', () => {
      const text = render(
        [
          {
            item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q42' },
            dob: {
              type: 'literal',
              value: '1952-03-11T00:00:00Z',
              datatype: 'http://www.w3.org/2001/XMLSchema#dateTime',
            },
            label: { type: 'literal', value: 'Douglas Adams', 'xml:lang': 'en' },
            id: { type: 'literal', value: 'wd:Q42' },
            site: { type: 'uri', value: 'https://en.wikipedia.org/wiki/Douglas_Adams' },
            node: { type: 'bnode', value: 't123' },
          },
        ],
        ['item', 'dob', 'label', 'id', 'site', 'node'],
      );

      expect(tableRows(text)).toEqual([
        '| wd:Q42 | "1952-03-11T00:00:00Z"^^xsd:dateTime | "Douglas Adams"@en | "wd:Q42" | <https://en.wikipedia.org/wiki/Douglas_Adams> | _:t123 |',
      ]);
    });

    it('keeps |, CR, and LF in a value from breaking or adding table rows', () => {
      const value = 'a | b\r\nc\nd "q" \\';
      const results = [
        { note: { type: 'literal', value } },
        { note: { type: 'uri', value: 'http://example.org/x|y' } },
      ];
      const text = render(results, ['note']);

      expect(tableRows(text)).toEqual([
        '| "a \\| b\\r\\nc\\nd \\"q\\" \\\\" |',
        '| <http://example.org/x\\|y> |',
      ]);
      expect(text.split('\n')).toHaveLength(2 + 2 + results.length);
    });

    it('keeps the value verbatim in structuredContent', async () => {
      const value = 'a | b\r\nc';
      mockQuery.mockResolvedValue({
        head: { vars: ['note'] },
        results: { bindings: [{ note: { type: 'literal', value } }] },
      });

      const result = await runToolContract(wikidataSparqlQuery, { query: 'SELECT ?note {}' });

      expect(
        (result.structuredContent as { results: Array<{ note: { value: string } }> }).results[0]
          ?.note.value,
      ).toBe(value);
    });
  });
});
