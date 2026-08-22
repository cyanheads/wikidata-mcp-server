/**
 * @fileoverview Tests for wikidata_resolve_external_id tool.
 * @module tests/tools/resolve-external-id.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataResolveExternalId } from '@/mcp-server/tools/definitions/resolve-external-id.tool.js';

const mockQuery = vi.fn();
const mockFetchPropertyDataType = vi.fn();

vi.mock('@/services/wikidata/wikidata-sparql-service.js', () => ({
  getWikidataSparqlService: () => ({ query: mockQuery }),
}));

/**
 * Partial mock — the handler imports `isEntityNotFoundError` from this module alongside the
 * service accessor, and its not-found catch path depends on the real implementation.
 */
vi.mock('@/services/wikidata/wikidata-rest-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/wikidata/wikidata-rest-service.js')>()),
  getWikidataRestService: () => ({ fetchPropertyDataType: mockFetchPropertyDataType }),
}));

/** A REST rejection shaped like the McpError fetchWithTimeout throws for a non-2xx. */
const restError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { data: { status } });

const successResponse = {
  head: { vars: ['item', 'itemLabel', 'itemDescription'] },
  results: {
    bindings: [
      {
        item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q12345' },
        itemLabel: { type: 'literal', value: 'Some Article', 'xml:lang': 'en' },
        itemDescription: { type: 'literal', value: 'A scientific paper', 'xml:lang': 'en' },
      },
    ],
  },
};

const noResultResponse = {
  head: { vars: ['item', 'itemLabel', 'itemDescription'] },
  results: { bindings: [] },
};

describe('wikidataResolveExternalId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every property under test is a real external-ID property unless a case says otherwise.
    mockFetchPropertyDataType.mockResolvedValue('external-id');
  });

  it('resolves a DOI to a Wikidata entity', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P356',
      value: '10.1038/nature01234',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.match).not.toBeNull();
    expect(result.match?.id).toBe('Q12345');
    expect(result.match?.label).toBe('Some Article');
    expect(result.match?.url).toBe('https://www.wikidata.org/wiki/Q12345');
    expect(result.property).toBe('P356');
    // DOI should be uppercased
    expect(result.value).toBe('10.1038/NATURE01234');
  });

  it('returns null match when no entity found', async () => {
    mockQuery.mockResolvedValue(noResultResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P356',
      value: '10.1234/nonexistent',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.match).toBeNull();
    expect(result.property).toBe('P356');
  });

  it('normalizes PMID (strips prefix)', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P698',
      value: 'PMID:32283226',
    });
    await wikidataResolveExternalId.handler(input, ctx);

    // Verify the normalized value was passed
    const callArgs = mockQuery.mock.calls[0] as [string, ...unknown[]];
    expect(callArgs[0]).toContain('"32283226"');
  });

  it('normalizes ORCID (adds hyphens)', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P496',
      value: '0000000218250097',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.value).toBe('0000-0002-1825-0097');
  });

  it('strips a doi.org resolver prefix before lookup', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P356',
      value: 'https://doi.org/10.1093/anb/9780198606697.article.0401011',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.value).toBe('10.1093/ANB/9780198606697.ARTICLE.0401011');
  });

  it.each([
    ['https://dx.doi.org/', 'https://dx.doi.org/10.1038/nature01234'],
    ['http://doi.org/', 'http://doi.org/10.1038/nature01234'],
    ['doi: scheme', 'doi:10.1038/nature01234'],
  ])('strips a %s prefix from a DOI', async (_label, value) => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({ property: 'P356', value });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.value).toBe('10.1038/NATURE01234');
  });

  it('strips a pubmed.ncbi.nlm.nih.gov resolver prefix and trailing slash', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P698',
      value: 'https://pubmed.ncbi.nlm.nih.gov/12344444/',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.value).toBe('12344444');
  });

  it('strips an orcid.org resolver prefix from an already-hyphenated ORCID', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P496',
      value: 'https://orcid.org/0000-0001-5069-3018',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.value).toBe('0000-0001-5069-3018');
  });

  /**
   * The case that pins the strip *ahead* of the switch rather than around its return value:
   * the hyphen reformat is gated on a length-16 check that the URL text defeats, so a
   * post-hoc strip would return this ORCID unhyphenated and never match.
   */
  it('hyphenates a URL-prefixed unhyphenated ORCID (strip precedes normalization)', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P496',
      value: 'https://orcid.org/0000000150693018',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.value).toBe('0000-0001-5069-3018');
  });

  it('leaves a bare identifier untouched by the resolver strip', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P698',
      value: '12344444',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.value).toBe('12344444');
  });

  /**
   * Only P698 and P496 discard surrounding whitespace incidentally — a stray `.trim()` in the
   * PMID chain and the `[-\s]` strip in ORCID's. Without a trim ahead of the switch, a padded
   * DOI or IMDb ID reaches the SPARQL literal intact and answers a confident null for an
   * identifier that resolves. Covers every branch, so the four stay consistent.
   */
  it.each([
    ['P356', ' 10.1038/nature01234 ', '10.1038/NATURE01234'],
    ['P698', ' 12344444 ', '12344444'],
    ['P496', ' 0000-0001-5069-3018 ', '0000-0001-5069-3018'],
    ['P345', ' tt0111161 ', 'tt0111161'],
  ])('trims surrounding whitespace from a %s value', async (property, value, expected) => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({ property, value });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.value).toBe(expected);
  });

  it('trims a trailing newline rather than emitting it into the SPARQL literal', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P356',
      value: '10.1038/nature01234\n',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.value).toBe('10.1038/NATURE01234');
  });

  /**
   * Pins the trim *ahead* of the resolver strip: RESOLVER_URL_PATTERNS are `^`-anchored, so a
   * padded URL never matches and the prefix would survive into the SPARQL literal.
   */
  it('strips a resolver prefix from a padded URL (trim precedes strip)', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P356',
      value: '  https://doi.org/10.1038/nature01234  ',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.value).toBe('10.1038/NATURE01234');
  });

  it('throws invalid_property for malformed property ID', async () => {
    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'notaproperty',
      value: 'somevalue',
    });
    await expect(wikidataResolveExternalId.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_property' },
    });
  });

  /**
   * The #16 defect: a well-formed P-ID of the wrong data type produced `match: null`, which
   * reads as a genuine miss for a lookup that could never have matched.
   */
  it.each([
    ['P31', 'wikibase-item'],
    ['P1932', 'string'],
    ['P18', 'commonsMedia'],
  ])('rejects %s — data type %s is not external-id', async (property, dataType) => {
    mockFetchPropertyDataType.mockResolvedValue(dataType);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({ property, value: 'Q5' });

    await expect(wikidataResolveExternalId.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_external_id_property', dataType },
    });
    // Rejected before any SPARQL is built.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['unassigned', 404],
    ['out of range', 400],
  ])('rejects a nonexistent property (%s → HTTP %i)', async (_label, statusCode) => {
    mockFetchPropertyDataType.mockRejectedValue(restError(statusCode));

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P9999999',
      value: '10.1234/x',
    });

    await expect(wikidataResolveExternalId.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_external_id_property' },
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('re-throws a non-not-found REST error from the datatype check', async () => {
    mockFetchPropertyDataType.mockRejectedValue(restError(503));

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P356',
      value: '10.1234/x',
    });

    await expect(wikidataResolveExternalId.handler(input, ctx)).rejects.toThrow('HTTP 503');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('checks the datatype of the normalized P-ID, not the raw input', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: ' p356 ',
      value: '10.1038/nature01234',
    });
    await wikidataResolveExternalId.handler(input, ctx);

    expect(mockFetchPropertyDataType).toHaveBeenCalledWith('P356', expect.anything());
  });

  it('returns null match with multipleMatches when more than one entity claims the ID', async () => {
    mockQuery.mockResolvedValue({
      head: { vars: ['item', 'itemLabel', 'itemDescription'] },
      results: {
        bindings: [
          {
            item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q111' },
            itemLabel: { type: 'literal', value: 'Article A' },
          },
          {
            item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q222' },
            itemLabel: { type: 'literal', value: 'Article B' },
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({ property: 'P356', value: '10.1234/dup' });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.match).toBeNull();
    expect(result.multipleMatches).toHaveLength(2);
    expect(result.multipleMatches?.[0]?.id).toBe('Q111');
    expect(result.multipleMatches?.[1]?.id).toBe('Q222');
  });

  it('deduplicates bindings for the same QID', async () => {
    // Same QID appears twice (different language labels from SPARQL)
    mockQuery.mockResolvedValue({
      head: { vars: ['item', 'itemLabel', 'itemDescription'] },
      results: {
        bindings: [
          {
            item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q12345' },
            itemLabel: { type: 'literal', value: 'English Label', 'xml:lang': 'en' },
          },
          {
            item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q12345' },
            itemLabel: { type: 'literal', value: 'German Label', 'xml:lang': 'de' },
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({ property: 'P356', value: '10.1234/ok' });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    // Should resolve to a single match despite duplicate bindings
    expect(result.match).not.toBeNull();
    expect(result.match?.id).toBe('Q12345');
  });

  it('formats a found match with QID and URL', () => {
    const output = {
      match: {
        id: 'Q12345',
        label: 'Some Article',
        description: 'A paper',
        url: 'https://www.wikidata.org/wiki/Q12345',
      },
      property: 'P356',
      value: '10.1038/NATURE01234',
    };
    const blocks = wikidataResolveExternalId.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Q12345');
    expect(text).toContain('P356');
    expect(text).toContain('Some Article');
    expect(text).toContain('https://www.wikidata.org/wiki/Q12345');
  });

  it('formats a null match with a not-found message', () => {
    const output = {
      match: null,
      property: 'P356',
      value: '10.1234/nonexistent',
    };
    const blocks = wikidataResolveExternalId.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('none');
    expect(text).toContain('No Wikidata entity');
  });

  it('formats multiple matches with list of QIDs', () => {
    const output = {
      match: null,
      property: 'P356',
      value: '10.1234/dup',
      multipleMatches: [
        { id: 'Q111', label: 'Article A' },
        { id: 'Q222', label: 'Article B' },
      ],
    };
    const blocks = wikidataResolveExternalId.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Q111');
    expect(text).toContain('Q222');
    expect(text).toContain('multiple');
  });

  it('normalizes OpenAlex ID (pass-through — no transformation)', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const openAlexId = 'W2023271753';
    const input = wikidataResolveExternalId.input.parse({
      property: 'P10283',
      value: openAlexId,
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    // No normalization applied for P10283 — value is passed through as-is
    expect(result.value).toBe(openAlexId);
  });

  it('normalizes IMDb ID (pass-through — no transformation)', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P345',
      value: 'nm0000331',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.value).toBe('nm0000331');
  });

  it('property is uppercased before use', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'p356', // lowercase
      value: '10.1038/NATURE01234',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.property).toBe('P356');
    const [calledQuery] = mockQuery.mock.calls[0] as [string, ...unknown[]];
    expect(calledQuery).toContain('wdt:P356');
  });

  /** #21: this call site validates `property` itself rather than via normalizeId/isPId. */
  it('trims surrounding whitespace from property', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: ' P356 ',
      value: '10.1038/nature01234',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.property).toBe('P356');
    const [calledQuery] = mockQuery.mock.calls[0] as [string, ...unknown[]];
    expect(calledQuery).toContain('wdt:P356');
  });

  it('security: SPARQL injection via value field — double-quote escaping prevents breakout', async () => {
    // The handler escapes backslashes and double quotes before interpolating into SPARQL.
    // An injection attempt with embedded double quotes must be escaped, not passed raw.
    mockQuery.mockResolvedValue(noResultResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const injectionValue = '10.1234/safe" } . <http://evil.example/> ?x ?y . #';
    const input = wikidataResolveExternalId.input.parse({
      property: 'P356',
      value: injectionValue,
    });
    await wikidataResolveExternalId.handler(input, ctx);

    const [calledQuery] = mockQuery.mock.calls[0] as [string, ...unknown[]];
    // The injected double quote must be escaped in the SPARQL string
    expect(calledQuery).toContain('\\"');
    // The raw injection string must NOT appear verbatim as an unescaped literal
    expect(calledQuery).not.toContain('10.1234/safe" } . <http://evil.example/> ?x ?y . #');
  });

  it('security: SPARQL injection via value field — backslash escaping prevents breakout', async () => {
    mockQuery.mockResolvedValue(noResultResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const injectionValue = '10.1234/safe\\";} CLEAR ALL;#';
    const input = wikidataResolveExternalId.input.parse({
      property: 'P356',
      value: injectionValue,
    });
    await wikidataResolveExternalId.handler(input, ctx);

    const [calledQuery] = mockQuery.mock.calls[0] as [string, ...unknown[]];
    // Backslash must be escaped to \\
    expect(calledQuery).toContain('\\\\');
  });

  it('security: invalid property format is rejected before SPARQL is built', async () => {
    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P356"; DROP GRAPH wd:; #',
      value: '10.1234/x',
    });
    await expect(wikidataResolveExternalId.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_property' },
    });
    // SPARQL service never called
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('security: no env secret appears in resolve output', async () => {
    process.env['TEST_RESOLVE_SECRET'] = 'resolve_secret_mno987';
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P356',
      value: '10.1038/nature01234',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('resolve_secret_mno987');
    delete process.env['TEST_RESOLVE_SECRET'];
  });

  it('re-throws service errors during SPARQL execution', async () => {
    mockQuery.mockRejectedValue(new Error('SPARQL endpoint unavailable'));

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P356',
      value: '10.1234/test',
    });
    await expect(wikidataResolveExternalId.handler(input, ctx)).rejects.toThrow(
      'SPARQL endpoint unavailable',
    );
  });

  it('input validation: empty property is rejected by Zod', () => {
    expect(() =>
      wikidataResolveExternalId.input.parse({ property: '', value: '10.1234/x' }),
    ).toThrow();
  });

  it('input validation: empty value is rejected by Zod', () => {
    expect(() => wikidataResolveExternalId.input.parse({ property: 'P356', value: '' })).toThrow();
  });
});
