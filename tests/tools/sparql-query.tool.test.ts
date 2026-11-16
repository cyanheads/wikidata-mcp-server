/**
 * @fileoverview Tests for wikidata_sparql_query tool.
 * @module tests/tools/sparql-query.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataSparqlQuery } from '@/mcp-server/tools/definitions/sparql-query.tool.js';
import { inlineText } from '../helpers/markdown.js';
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
  stoppedEarly: false,
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

  it('declares timeout guidance that fits a query already carrying a LIMIT', () => {
    const recovery = wikidataSparqlQuery.errors?.find((e) => e.reason === 'timeout')?.recovery;

    expect(recovery).toMatch(/^Narrow the WHERE clause/);
    expect(recovery).not.toContain('Add a LIMIT clause');
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

  it('throws result_too_large when the service stops a body at its byte ceiling', async () => {
    mockQuery.mockRejectedValue({
      data: { reason: 'result_too_large' },
      message: 'The SPARQL result is larger than the 8 MiB one call reads.',
    });

    const result = await runToolContract(wikidataSparqlQuery, {
      query: 'SELECT ?item WHERE { ?item wdt:P31 wd:Q5. } LIMIT 10',
    } as never);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'result_too_large' } },
    });
  });

  /** The service reads Retry-After into data.retryAfter; the re-mapped error must keep it. */
  it('carries the upstream Retry-After through to the throttled error on the wire', async () => {
    mockQuery.mockRejectedValue({
      data: { reason: 'throttled', retryAfter: '30' },
      message: 'Wikidata SPARQL endpoint is rate-limited. Retry after 30s.',
    });

    const result = await runToolContract(wikidataSparqlQuery, {
      query: 'SELECT ?item WHERE { ?item wdt:P31 wd:Q5. } LIMIT 10',
    } as never);

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'throttled', retryAfter: '30' } },
    });
    const text = result.content.map((b) => (b as { text: string }).text).join('');
    expect(text).toContain('retry after `30`');
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
    });
    const text = blocks.map((b) => (b as { text: string }).text).join('\n');

    expect(tableRows(text)).toHaveLength(25);
    expect(tableRows(text).at(-1)).toBe('| wd:Q25 |');
    expect(text).not.toContain('more rows');
  });

  /** The header names the variables only; it states no row cap. */
  it('format: the header names the variables and claims no server cap', () => {
    const blocks = wikidataSparqlQuery.format!({
      results: [{ item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q1' } }],
      variables: ['item', 'label'],
    });
    const text = (blocks[0] as { text: string }).text;

    expect(text.split('\n')[0]).toBe('**Variables:** item, label');
    expect(text).not.toMatch(/truncated|10,000/i);
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
      expect(mockQuery).toHaveBeenCalledWith(query, expected, 30_000, expect.anything(), {
        maxRows: 4_000,
      });
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
   * #51: the Query Service has no row cap, so `LIMIT`/`OFFSET` is the page boundary, and a
   * 4,000-row ceiling bounds every query. The service reads at most 4,001 bindings and reports
   * `stoppedEarly`; the tool serves the first 4,000 and discloses the ceiling (#10: an agent can
   * tell a partial result from a whole one).
   */
  describe('row ceiling (#51)', () => {
    const query = 'SELECT ?item ?dob ?label WHERE { ?item wdt:P31 wd:Q5 } LIMIT 10000';
    const vars = ['item', 'dob', 'label'];
    const row = (i: number) => ({
      item: { type: 'uri', value: `http://www.wikidata.org/entity/Q${i}` },
      dob: {
        type: 'literal',
        value: '1952-03-11T00:00:00Z',
        datatype: 'http://www.w3.org/2001/XMLSchema#dateTime',
      },
      label: { type: 'literal', value: `Person ${i}`, 'xml:lang': 'en' },
    });
    const rows = (count: number) => Array.from({ length: count }, (_, i) => row(i + 1));

    const serve = (bindings: unknown[], stoppedEarly: boolean) =>
      mockQuery.mockResolvedValue({ head: { vars }, results: { bindings }, stoppedEarly });
    const run = (bindings: unknown[], stoppedEarly: boolean) => {
      serve(bindings, stoppedEarly);
      return runToolContract(wikidataSparqlQuery, { query });
    };

    /**
     * Stubs WIKIDATA_CLAMP_LIMITS, then imports the tool fresh, so the lazily parsed server config
     * re-reads it. Cases that stub nothing use the static import.
     */
    const freshTool = async (clampLimits: string) => {
      vi.stubEnv('WIKIDATA_CLAMP_LIMITS', clampLimits);
      vi.resetModules();
      return (await import('@/mcp-server/tools/definitions/sparql-query.tool.js'))
        .wikidataSparqlQuery;
    };
    type Structured = {
      results: Array<Record<string, { value: string }>>;
      totalCount?: number;
      truncated?: boolean;
      shown?: number;
      cap?: number;
      notice?: string;
      returnedCount?: number;
    };
    const structuredOf = (result: Awaited<ReturnType<typeof run>>) =>
      result.structuredContent as Structured;
    const textOf = (result: Awaited<ReturnType<typeof run>>) =>
      result.content.map((b) => (b as { text: string }).text).join('');

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('asks the service for at most 4,000 rows', async () => {
      await run(rows(1), false);

      expect(mockQuery).toHaveBeenCalledWith(query, 'en', 30_000, expect.anything(), {
        maxRows: 4_000,
      });
    });

    it.each([25, 4_000])(
      'returns a whole %i-row result on both surfaces, with totalCount and no truncation',
      async (count) => {
        const result = await run(rows(count), false);
        const structured = structuredOf(result);
        const text = textOf(result);

        expect(structured.results).toHaveLength(count);
        expect(structured.totalCount).toBe(count);
        expect(structured).not.toHaveProperty('truncated');
        expect(structured).not.toHaveProperty('shown');
        expect(structured).not.toHaveProperty('cap');
        expect(structured).not.toHaveProperty('notice');
        expect(structured).not.toHaveProperty('returnedCount');
        expect(tableRows(text)).toHaveLength(count);
        expect(tableRows(text).at(-1)).toContain(`wd:Q${count} `);
        expect(text).toContain(`**${count} total**`);
      },
    );

    it('serves the first 4,000 rows of a larger result and discloses the ceiling on both surfaces', async () => {
      const result = await run(rows(4_000), true);
      const structured = structuredOf(result);
      const text = textOf(result);

      expect(structured.results).toHaveLength(4_000);
      expect(structured.truncated).toBe(true);
      expect(structured.shown).toBe(4_000);
      expect(structured.cap).toBe(4_000);
      expect(structured).not.toHaveProperty('totalCount');
      expect(structured).not.toHaveProperty('returnedCount');
      expect(structured.notice).toContain('first 4,000 rows');
      expect(structured.notice).toContain('ORDER BY');
      expect(structured.notice).toContain('LIMIT of at most 4,000');
      expect(structured.notice).toContain('OFFSET');
      expect(structured.notice).toContain('aggregate');
      // Narrowing and aggregating come before paging: they are what works on a large match.
      const notice = structured.notice as string;
      expect(notice.indexOf('Narrow the WHERE clause')).toBeGreaterThan(-1);
      expect(notice.indexOf('Narrow the WHERE clause')).toBeLessThan(notice.indexOf('ORDER BY'));
      expect(notice.indexOf('aggregate')).toBeLessThan(notice.indexOf('ORDER BY'));
      expect(tableRows(text)).toHaveLength(4_000);
      expect(tableRows(text).at(-1)).toContain('wd:Q4000 ');
      expect(text).toContain('> Showing the first 4,000 rows');
      expect(text).toMatch(/truncated\W+true/i);
      expect(text).not.toContain('total**');
    });

    it('logs a capped result as served at the cap', async () => {
      serve(rows(4_000), true);
      const ctx = createMockContext({ errors: wikidataSparqlQuery.errors });
      const notice = vi.spyOn(ctx.log, 'notice');

      await wikidataSparqlQuery.handler(wikidataSparqlQuery.input.parse({ query }), ctx);

      expect(notice).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ field: 'rows', tool: 'wikidata_sparql_query', applied: 4_000 }),
      );
    });

    it.each([
      ['by default', undefined],
      ['with WIKIDATA_CLAMP_LIMITS=true', 'true'],
    ])('serves a capped result %s', async (_name, value) => {
      const tool = value === undefined ? wikidataSparqlQuery : await freshTool(value);
      serve(rows(4_000), true);

      const result = await runToolContract(tool, { query });

      expect(result.isError).toBeFalsy();
      expect(structuredOf(result).truncated).toBe(true);
    });

    it('rejects a result past the ceiling, naming 4,000, with WIKIDATA_CLAMP_LIMITS=false', async () => {
      const fresh = await freshTool('false');
      serve(rows(4_000), true);

      const result = await runToolContract(fresh, { query });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: number; message: string } };
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toContain('4,000-row ceiling');
      expect(error.message).toContain('LIMIT of at most 4,000');
      expect(error.message).toContain('ORDER BY');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('still returns a whole 4,000-row result with WIKIDATA_CLAMP_LIMITS=false', async () => {
      const fresh = await freshTool('false');
      serve(rows(4_000), false);

      const result = await runToolContract(fresh, { query });

      expect(result.isError).toBeFalsy();
      expect(structuredOf(result).totalCount).toBe(4_000);
    });

    it('returns an empty result with a zero count and the no-results notice on both surfaces', async () => {
      const result = await run([], false);
      const structured = structuredOf(result);
      const text = textOf(result);

      expect(structured.results).toHaveLength(0);
      expect(structured.totalCount).toBe(0);
      expect(structured).not.toHaveProperty('truncated');
      expect(structured.notice).toContain('No results returned');
      expect(tableRows(text)).toHaveLength(0);
      expect(text).toContain('**0 total**');
      expect(text).toContain('> No results returned');
    });
  });

  /**
   * #49: since the WDQS graph split, scholarly articles live only in the scholarly graph, which a
   * main-graph query reaches through `SERVICE wdsubgraph:scholarly_articles { … }` — and their
   * labels only from inside that block, since the injected label SERVICE runs on the main graph.
   */
  describe('scholarly graph guidance (#49)', () => {
    const SUBGRAPH = 'SERVICE wdsubgraph:scholarly_articles { … }';

    it('the description routes scholarly articles through the subgraph SERVICE, labels read inside it', () => {
      expect(wikidataSparqlQuery.description).toContain(SUBGRAPH);
      expect(wikidataSparqlQuery.description).toContain('wdsubgraph: is predeclared');
      expect(wikidataSparqlQuery.description).toContain('BIND(?paperLabel AS ?paperLabel)');
      expect(wikidataSparqlQuery.description).toContain('label SERVICE runs on the main graph');
    });

    it('the no-results notice names the subgraph SERVICE on both surfaces', async () => {
      mockQuery.mockResolvedValue({
        head: { vars: ['paper'] },
        results: { bindings: [] },
        stoppedEarly: false,
      });

      const result = await runToolContract(wikidataSparqlQuery, {
        query: 'SELECT ?paper WHERE { ?paper wdt:P50 wd:Q3571662 }',
      });

      expect((result.structuredContent as { notice: string }).notice).toContain(SUBGRAPH);
      const text = result.content.map((b) => (b as { text: string }).text).join('');
      expect(inlineText(text)).toContain('SERVICE wdsubgraph:scholarly_articles');
    });

    it('the no-results notice says how to read an article label inside the block', async () => {
      mockQuery.mockResolvedValue({
        head: { vars: ['paper', 'paperLabel'] },
        results: { bindings: [] },
        stoppedEarly: false,
      });

      const result = await runToolContract(wikidataSparqlQuery, {
        query: 'SELECT ?paper ?paperLabel WHERE { ?paper wdt:P356 "10.1038/NATURE14539" }',
      });

      const BIND = 'BIND(?paperLabel AS ?paperLabel)';
      expect((result.structuredContent as { notice: string }).notice).toContain(BIND);
      const text = result.content.map((b) => (b as { text: string }).text).join('');
      expect(inlineText(text)).toContain(BIND);
    });

    it('the parse_error recovery hint names the subgraph SERVICE on the wire', async () => {
      mockQuery.mockRejectedValue({
        data: { reason: 'parse_error', cause: 'Encountered " "}" "} "" at line 1, column 40.' },
        message: 'SPARQL parse error: Encountered " "}" "} "" at line 1, column 40.',
      });

      const result = await runToolContract(wikidataSparqlQuery, {
        query: 'SELECT ?paper WHERE { SERVICE wdsubgraph:scholarly_articles { } }',
      });

      const { error } = result.structuredContent as {
        error: { data: { recovery: { hint: string } } };
      };
      expect(error.data.recovery.hint).toContain(SUBGRAPH);
    });
  });

  describe('cell rendering (#28)', () => {
    const render = (results: Array<Record<string, Record<string, string>>>, variables: string[]) =>
      (wikidataSparqlQuery.format!({ results, variables })[0] as { text: string }).text;

    it.each(['', '|tail'])(
      'renders a long backslash run followed by %j within the bounded scan ceiling',
      (suffix) => {
        expectBoundedScan(
          (size) => `https://example.org/?value=${'\\'.repeat(size)}${suffix}`,
          (value) => render([{ uri: { type: 'uri', value } }], ['uri']),
        );
      },
    );

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

      expect(tableRows(text).map(inlineText)).toEqual([
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

      expect(tableRows(text).map(inlineText)).toEqual([
        '| "a | b\\r\\nc\\nd \\"q\\" \\\\" |',
        '| <http://example.org/x|y> |',
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
