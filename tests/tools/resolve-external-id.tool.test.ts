/**
 * @fileoverview Tests for wikidata_resolve_external_id tool.
 * @module tests/tools/resolve-external-id.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  rateLimited,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeExternalId,
  wikidataResolveExternalId,
} from '@/mcp-server/tools/definitions/resolve-external-id.tool.js';
import {
  type SparqlQueryOptions,
  WikidataSparqlService,
} from '@/services/wikidata/wikidata-sparql-service.js';

const mockQuery = vi.fn();
const mockFetchPropertyDataType = vi.fn();

/** The SPARQL service the tool reaches: the `mockQuery` stub, unless a case installs the real one. */
const sparqlService: { real?: WikidataSparqlService } = {};

/** Partial mock — a case that times the real deadline needs the real service class. */
vi.mock('@/services/wikidata/wikidata-sparql-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/wikidata/wikidata-sparql-service.js')>()),
  getWikidataSparqlService: () => sparqlService.real ?? { query: mockQuery },
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

/** The `?form` binding: the index of the looked-up value form a row matched. */
const formBinding = (index: number) => ({
  type: 'literal',
  value: String(index),
  datatype: 'http://www.w3.org/2001/XMLSchema#integer',
});

/** A `?rank` binding: the rank IRI of the statement a row matched through. */
const rankBinding = (rank: 'Preferred' | 'Normal' | 'Deprecated') => ({
  type: 'uri',
  value: `http://wikiba.se/ontology#${rank}Rank`,
});

/** A `?best` binding: whether that statement is one of its entity's best-rank (truthy) ones. */
const bestBinding = (best: boolean) => ({
  type: 'literal',
  value: String(best),
  datatype: 'http://www.w3.org/2001/XMLSchema#boolean',
});

/**
 * The bindings a lookup row carries beside its item and labels, for a claim on the first form
 * through a normal-rank statement that is the entity's best — what a `wdt:` lookup matches.
 */
const firstFormClaim = {
  form: formBinding(0),
  rank: rankBinding('Normal'),
  best: bestBinding(true),
};

const successResponse = {
  head: { vars: ['item', 'form', 'itemLabel', 'itemDescription'] },
  results: {
    bindings: [
      {
        item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q12345' },
        ...firstFormClaim,
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
            ...firstFormClaim,
            itemLabel: { type: 'literal', value: 'Article A' },
          },
          {
            item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q222' },
            ...firstFormClaim,
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
            ...firstFormClaim,
            itemLabel: { type: 'literal', value: 'English Label', 'xml:lang': 'en' },
          },
          {
            item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q12345' },
            ...firstFormClaim,
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
        rank: 'deprecated' as const,
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
    expect(text).toContain('**Rank:** deprecated');
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
        { id: 'Q111', label: 'Article A', rank: 'preferred' as const },
        { id: 'Q222', label: 'Article B', rank: 'normal' as const },
      ],
    };
    const blocks = wikidataResolveExternalId.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('- Q111 (preferred rank): Article A');
    expect(text).toContain('- Q222 (normal rank): Article B');
    expect(text).toContain('Q111');
    expect(text).toContain('Q222');
    expect(text).toContain('multiple');
  });

  /**
   * #54: P10283 stores the entity letter in either case, and an ID resolves only in its stored
   * case — so the value is searched as given, with the flipped letter riding the same query.
   */
  it('searches an OpenAlex ID as given, then in the other entity-letter case', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const openAlexId = 'W2023271753';
    const input = wikidataResolveExternalId.input.parse({
      property: 'P10283',
      value: openAlexId,
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.value).toBe(openAlexId);
    const [calledQuery] = mockQuery.mock.calls[0] as [string, ...unknown[]];
    expect(calledQuery).toContain('("W2023271753" 0) ("w2023271753" 1)');
  });

  it('lowercases an IMDb ID, which is stored lowercase', async () => {
    mockQuery.mockResolvedValue(successResponse);

    const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
    const input = wikidataResolveExternalId.input.parse({
      property: 'P345',
      value: 'NM0000331',
    });
    const result = await wikidataResolveExternalId.handler(input, ctx);

    expect(result.value).toBe('nm0000331');
  });

  /**
   * #54: the variant form is a fallback for a miss, never a rival claimant — every value that
   * resolves as given keeps resolving to the same item.
   */
  describe('value forms', () => {
    const row = (qid: string, form: number, label: string) => ({
      item: { type: 'uri', value: `http://www.wikidata.org/entity/${qid}` },
      ...firstFormClaim,
      form: formBinding(form),
      itemLabel: { type: 'literal', value: label, 'xml:lang': 'en' },
    });
    const respond = (...bindings: ReturnType<typeof row>[]) =>
      mockQuery.mockResolvedValue({ head: { vars: [] }, results: { bindings } });

    it('prefers a claimant of the form tried first over one of the variant', async () => {
      respond(row('Q101574421', 0, 'As given'), row('Q999', 1, 'Variant'));

      const result = await call({ property: 'P10283', value: 'A5035517966' });

      expect(result.structuredContent).toMatchObject({
        match: { id: 'Q101574421', label: 'As given' },
        value: 'A5035517966',
      });
      expect(result.structuredContent).not.toHaveProperty('multipleMatches');
    });

    it('falls back to the variant form when nothing holds the form tried first', async () => {
      respond(row('Q100296791', 1, 'Stored lowercase'));

      const result = await call({ property: 'P10283', value: 'A5041957172' });

      expect(result.structuredContent).toMatchObject({
        match: { id: 'Q100296791' },
        value: 'A5041957172',
      });
    });

    it('sends one form for a property without a variant', async () => {
      respond();

      await call({ property: 'P356', value: 'doi: 10.1038/nature14539' });

      expect(sentQuery()).toContain('VALUES (?value ?form) { ("10.1038/NATURE14539" 0) }');
    });

    it('keeps the form tried first ahead of rank: a deprecated claim on it beats a best-rank variant', async () => {
      mockQuery.mockResolvedValue({
        head: { vars: [] },
        results: {
          bindings: [
            {
              ...row('Q1', 0, 'As given'),
              rank: rankBinding('Deprecated'),
              best: bestBinding(false),
            },
            row('Q2', 1, 'Variant'),
          ],
        },
      });

      const result = await call({ property: 'P10283', value: 'A5035517966' });

      expect(result.structuredContent).toMatchObject({ match: { id: 'Q1', rank: 'deprecated' } });
    });

    /** Each row lacks exactly one binding the query always sets, so no other check masks it. */
    it.each<[string, (complete: ReturnType<typeof row>) => Record<string, unknown>]>([
      ['its item', ({ item: _item, ...rest }) => rest],
      ['its form', ({ form: _form, ...rest }) => rest],
      ['an integer form', (complete) => ({ ...complete, form: { type: 'literal', value: 'x' } })],
      ['its rank', ({ rank: _rank, ...rest }) => rest],
      ['its best-rank flag', ({ best: _best, ...rest }) => rest],
    ])('fails on a row without %s rather than reporting a blank claimant', async (_name, strip) => {
      mockQuery.mockResolvedValue({
        head: { vars: [] },
        results: { bindings: [strip(row('Q1', 0, 'As given'))] },
      });

      const result = await call({ property: 'P356', value: '10.1/x' });

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.SerializationError,
      );
    });
  });

  /**
   * #50: the identifier matches through statement nodes, so a value held below best rank is
   * found; claimants come from the best tier any entity holds it at, so every value a `wdt:`
   * lookup resolved still resolves to the same entities.
   */
  describe('rank tiers', () => {
    type Rank = Parameters<typeof rankBinding>[0];
    const claim = (qid: string, rank: Rank, best: boolean) => ({
      item: { type: 'uri', value: `http://www.wikidata.org/entity/${qid}` },
      form: formBinding(0),
      rank: rankBinding(rank),
      best: bestBinding(best),
      itemLabel: { type: 'literal', value: `Label ${qid}`, 'xml:lang': 'en' },
    });
    const respond = (...bindings: ReturnType<typeof claim>[]) =>
      mockQuery.mockResolvedValue({ head: { vars: [] }, results: { bindings } });
    const notice = (result: Awaited<ReturnType<typeof call>>) =>
      (result.structuredContent as { notice?: string }).notice;

    it('matches through statement nodes, ordered best tier first', async () => {
      respond();

      await call({ property: 'P345', value: 'nm4728997' });

      expect(sentQuery()).toContain('?item p:P345 ?statement .');
      expect(sentQuery()).toContain('?statement ps:P345 ?value ; wikibase:rank ?rank .');
      expect(sentQuery()).toContain('BIND(EXISTS { ?statement a wikibase:BestRank } AS ?best)');
      expect(sentQuery()).toContain('ORDER BY ?form DESC(?best) ?rankOrder ?item');
      expect(sentQuery()).not.toContain('wdt:');
    });

    it.each([
      [
        'a normal-rank value beside a preferred one',
        'nm4728997',
        claim('Q20528449', 'Normal', false),
        'normal',
      ],
      ['the preferred value', 'nm0068744', claim('Q20528449', 'Preferred', true), 'preferred'],
      [
        'a value held only at deprecated rank',
        'tt4104338',
        claim('Q17055259', 'Deprecated', false),
        'deprecated',
      ],
    ])(
      'resolves %s and reports its rank on both surfaces',
      async (_label, value, binding, rank) => {
        respond(binding);

        const result = await call({ property: 'P345', value });

        expect(result.structuredContent).toMatchObject({ match: { rank } });
        expect(result.content?.[0]).toMatchObject({
          text: expect.stringContaining(`**Rank:** ${rank}`),
        });
      },
    );

    it('keeps the best-rank holder over an entity holding the value deprecated', async () => {
      respond(claim('Q7426827', 'Normal', true), claim('Q12050981', 'Deprecated', false));

      const result = await call({ property: 'P345', value: 'tt0111077' });

      expect(result.structuredContent).toMatchObject({ match: { id: 'Q7426827', rank: 'normal' } });
      expect(result.structuredContent).not.toHaveProperty('multipleMatches');
    });

    it('keeps a non-deprecated holder below best rank over a deprecated one', async () => {
      respond(claim('Q1', 'Normal', false), claim('Q2', 'Deprecated', false));

      const result = await call({ property: 'P345', value: 'nm0000001' });

      expect(result.structuredContent).toMatchObject({ match: { id: 'Q1', rank: 'normal' } });
    });

    it('lists the holders of one tier, each with its rank, and leaves out a later tier', async () => {
      respond(
        claim('Q1', 'Preferred', true),
        claim('Q2', 'Normal', true),
        claim('Q3', 'Deprecated', false),
      );

      const result = await call({ property: 'P345', value: 'nm0000001' });

      expect(result.structuredContent).toMatchObject({
        match: null,
        multipleMatches: [
          { id: 'Q1', label: 'Label Q1', rank: 'preferred' },
          { id: 'Q2', label: 'Label Q2', rank: 'normal' },
        ],
      });
      expect(result.content?.[0]).toMatchObject({
        text: expect.stringContaining('- Q2 (normal rank): Label Q2'),
      });
    });

    it('makes one claimant of an entity holding the value at two tiers, at its best', async () => {
      respond(claim('Q1255182', 'Normal', true), claim('Q1255182', 'Deprecated', false));

      const result = await call({ property: 'P345', value: 'tt0125065' });

      expect(result.structuredContent).toMatchObject({ match: { id: 'Q1255182', rank: 'normal' } });
    });

    /**
     * The query used to stop at five rows, so a sixth claimant vanished from `multipleMatches`
     * without a word. It now fetches one past the cap and says when that one exists.
     */
    describe('multipleMatches cap', () => {
      const claimants = (count: number) =>
        Array.from({ length: count }, (_, i) => claim(`Q${i + 1}`, 'Normal', true));

      it('fetches one claimant past the cap', async () => {
        respond();

        await call({ property: 'P345', value: 'nm0000001' });

        expect(sentQuery()).toMatch(/\nLIMIT 6$/);
      });

      it('lists five and discloses the rest past the cap', async () => {
        respond(...claimants(6));

        const result = await call({ property: 'P345', value: 'nm0000001' });

        expect(result.isError).toBeFalsy();
        expect(
          (result.structuredContent as { multipleMatches: unknown[] }).multipleMatches,
        ).toHaveLength(5);
        expect(notice(result)).toBe(
          'More than 5 entities claim this external identifier; multipleMatches lists 5 of them. List every claimant with wikidata_sparql_query.',
        );
        expect(
          result.content?.map((block) => (block as { text: string }).text).join('\n'),
        ).toContain('> More than 5 entities claim this external identifier');
      });

      it('lists every claimant at the cap without a notice', async () => {
        respond(...claimants(5));

        const result = await call({ property: 'P345', value: 'nm0000001' });

        expect(
          (result.structuredContent as { multipleMatches: unknown[] }).multipleMatches,
        ).toHaveLength(5);
        expect(notice(result)).toBeUndefined();
      });

      it('does not count a later tier toward the cap', async () => {
        respond(...claimants(5), claim('Q9', 'Deprecated', false));

        const result = await call({ property: 'P345', value: 'nm0000001' });

        expect(
          (result.structuredContent as { multipleMatches: unknown[] }).multipleMatches,
        ).toHaveLength(5);
        expect(notice(result)).toBeUndefined();
      });

      it('carries no notice on a miss', async () => {
        respond();

        const result = await call({ property: 'P345', value: 'nm0000001' });

        expect(result.structuredContent).toMatchObject({ match: null });
        expect(notice(result)).toBeUndefined();
      });
    });
  });

  /**
   * #49: since the Query Service's graph split, scholarly articles — and every DOI and PubMed ID
   * on them — live only in the scholarly graph. The lookup asks both graphs and merges, and a
   * graph that does not answer is disclosed rather than read as a miss.
   */
  describe('graph split', () => {
    type Graph = NonNullable<SparqlQueryOptions['graph']>;
    const claim = (qid: string, label: string) => ({
      item: { type: 'uri', value: `http://www.wikidata.org/entity/${qid}` },
      ...firstFormClaim,
      itemLabel: { type: 'literal', value: label, 'xml:lang': 'en' },
    });
    const results = (...bindings: ReturnType<typeof claim>[]) => ({
      head: { vars: ['item', 'form', 'rank', 'best', 'itemLabel', 'mulLabel', 'itemDescription'] },
      results: { bindings },
      stoppedEarly: false,
    });
    /** Answers each graph's request with its own outcome. */
    const byGraph = (answers: Record<Graph, () => Promise<unknown>>) =>
      mockQuery.mockImplementation(
        (
          _query: string,
          _language: string,
          _timeoutMs: number,
          _ctx: unknown,
          options?: SparqlQueryOptions,
        ) => answers[options?.graph ?? 'main'](),
      );
    const answer =
      (...bindings: ReturnType<typeof claim>[]) =>
      () =>
        Promise.resolve(results(...bindings));
    const failWith = (error: unknown) => () => Promise.reject(error);
    const notice = (result: Awaited<ReturnType<typeof call>>) =>
      (result.structuredContent as { notice?: string }).notice;
    const text = (result: Awaited<ReturnType<typeof call>>) =>
      result.content?.map((block) => (block as { text: string }).text).join('\n') ?? '';
    const scholarlyMissed =
      'The scholarly_articles graph did not answer, so an entity held there would be missing from this result. Retry the call for a complete answer.';

    it('sends the same query to both graphs under one 20 s deadline', async () => {
      byGraph({ main: answer(), scholarly: answer() });

      await call({ property: 'P356', value: '10.1038/nature14539' });

      expect(mockQuery).toHaveBeenCalledTimes(2);
      const [main, scholarly] = mockQuery.mock.calls as [unknown[], unknown[]];
      expect(main).toEqual([expect.any(String), '', 20_000, expect.anything(), { graph: 'main' }]);
      expect(scholarly).toEqual([main[0], '', 20_000, expect.anything(), { graph: 'scholarly' }]);
    });

    it('resolves an identifier held only in the scholarly graph', async () => {
      byGraph({ main: answer(), scholarly: answer(claim('Q28018765', 'Deep learning')) });

      const result = await call({ property: 'P356', value: '10.1038/nature14539' });

      expect(result.structuredContent).toMatchObject({
        match: { id: 'Q28018765', label: 'Deep learning', rank: 'normal' },
        value: '10.1038/NATURE14539',
      });
      expect(result.structuredContent).not.toHaveProperty('unavailableGraphs');
      expect(notice(result)).toBeUndefined();
    });

    it('resolves an identifier held only in the main graph', async () => {
      byGraph({ main: answer(claim('Q101574421', 'Researcher')), scholarly: answer() });

      const result = await call({ property: 'P496', value: '0000-0003-2992-658X' });

      expect(result.structuredContent).toMatchObject({ match: { id: 'Q101574421' } });
      expect(result.structuredContent).not.toHaveProperty('unavailableGraphs');
    });

    it('uses a normalized arXiv ID in both graphs and echoes it on both surfaces', async () => {
      mockQuery.mockImplementation(
        (query: string, _language, _timeoutMs, _ctx, options?: SparqlQueryOptions) =>
          Promise.resolve(
            options?.graph === 'scholarly' && query.includes('("2002.11618" 0)')
              ? results(claim('Q101469239', 'Scientific article'))
              : results(),
          ),
      );

      const result = await call({ property: 'P818', value: 'https://arxiv.org/abs/2002.11618' });

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery.mock.calls[0]?.[0]).toBe(mockQuery.mock.calls[1]?.[0]);
      expect(result.structuredContent).toMatchObject({
        match: { id: 'Q101469239', label: 'Scientific article', rank: 'normal' },
        value: '2002.11618',
      });
      expect(text(result)).toContain('**Value searched:** 2002.11618');
      expect(text(result)).toContain('**QID:** Q101469239');
    });

    it('lists claimants from both graphs as multipleMatches', async () => {
      byGraph({ main: answer(claim('Q1', 'Main')), scholarly: answer(claim('Q2', 'Scholarly')) });

      const result = await call({ property: 'P356', value: '10.1234/dup' });

      expect(result.structuredContent).toMatchObject({
        match: null,
        multipleMatches: [
          { id: 'Q1', label: 'Main' },
          { id: 'Q2', label: 'Scholarly' },
        ],
      });
    });

    it.each([
      [
        'an HTTP 500',
        serviceUnavailable('Wikidata SPARQL endpoint returned HTTP 500.', { status: 500 }),
      ],
      ['a timeout', timeout('SPARQL query timed out after 20s.', { reason: 'timeout' })],
      [
        'a throttle',
        rateLimited('Wikidata SPARQL endpoint is rate-limited.', { reason: 'throttled' }),
      ],
      ['a network failure', serviceUnavailable('Could not reach the Wikidata SPARQL endpoint.')],
    ])(
      'answers from the main graph when the scholarly one fails with %s, and says so',
      async (_label, error) => {
        byGraph({ main: answer(claim('Q101574421', 'Researcher')), scholarly: failWith(error) });

        const result = await call({ property: 'P496', value: '0000-0003-2992-658X' });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          match: { id: 'Q101574421' },
          unavailableGraphs: ['scholarly_articles'],
        });
        expect(notice(result)).toBe(scholarlyMissed);
        expect(text(result)).toContain('**Unavailable graphs:** scholarly_articles');
        expect(text(result)).toContain(`> ${scholarlyMissed}`);
      },
    );

    it('returns a null match with the disclosure when the graph that holds a DOI fails', async () => {
      byGraph({
        main: answer(),
        scholarly: failWith(serviceUnavailable('HTTP 500', { status: 500 })),
      });

      const result = await call({ property: 'P356', value: '10.1038/nature14539' });

      expect(result.structuredContent).toMatchObject({
        match: null,
        unavailableGraphs: ['scholarly_articles'],
      });
      expect(notice(result)).toBe(scholarlyMissed);
    });

    it('resolves a DOI from the scholarly graph when the main one fails', async () => {
      byGraph({
        main: failWith(timeout('SPARQL query timed out after 20s.', { reason: 'timeout' })),
        scholarly: answer(claim('Q28018765', 'Deep learning')),
      });

      const result = await call({ property: 'P356', value: '10.1038/nature14539' });

      expect(result.structuredContent).toMatchObject({
        match: { id: 'Q28018765' },
        unavailableGraphs: ['wikidata_main'],
      });
      expect(notice(result)).toContain('The wikidata_main graph did not answer');
    });

    it('raises the main request error when both graphs fail', async () => {
      byGraph({
        main: failWith(timeout('Main graph timed out.', { reason: 'timeout' })),
        scholarly: failWith(
          serviceUnavailable('Scholarly graph returned HTTP 503.', { status: 503 }),
        ),
      });

      const result = await call({ property: 'P356', value: '10.1038/nature14539' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.Timeout,
          message: expect.stringContaining('Main graph timed out.'),
        },
      });
    });

    it.each([
      ['a parse error', validationError('SPARQL parse error: line 2', { reason: 'parse_error' })],
      ['an unexpected error', new Error('Unexpected lookup failure')],
    ])('never stands in for a graph that failed with %s', async (_label, error) => {
      byGraph({ main: answer(claim('Q101574421', 'Researcher')), scholarly: failWith(error) });

      const result = await call({ property: 'P496', value: '0000-0003-2992-658X' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { message: expect.stringContaining((error as Error).message) },
      });
    });

    it('rejects on caller cancellation rather than answering from the other graph', async () => {
      const controller = new AbortController();
      const aborted = new DOMException('The operation was aborted.', 'AbortError');
      byGraph({
        main: answer(claim('Q101574421', 'Researcher')),
        scholarly: () => {
          controller.abort(aborted);
          return Promise.reject(aborted);
        },
      });

      const ctx = createMockContext({
        errors: wikidataResolveExternalId.errors,
        signal: controller.signal,
      });
      const input = wikidataResolveExternalId.input.parse({
        property: 'P496',
        value: '0000-0003-2992-658X',
      });

      await expect(wikidataResolveExternalId.handler(input, ctx)).rejects.toBe(aborted);
    });

    it('joins a graph disclosure and the cap disclosure into one notice', async () => {
      const six = Array.from({ length: 6 }, (_, i) => claim(`Q${i + 1}`, `Claimant ${i + 1}`));
      byGraph({
        main: answer(...six),
        scholarly: failWith(timeout('timed out', { reason: 'timeout' })),
      });

      const result = await call({ property: 'P345', value: 'nm0000001' });

      expect(
        (result.structuredContent as { multipleMatches: unknown[] }).multipleMatches,
      ).toHaveLength(5);
      expect(notice(result)).toBe(
        `${scholarlyMissed} More than 5 entities claim this external identifier; multipleMatches lists 5 of them. List every claimant with wikidata_sparql_query.`,
      );
    });

    /**
     * The deadline lives in the SPARQL service; this proves the tool hands both graphs the same
     * one, so a graph that never answers cannot hold back the other's answer past it.
     */
    describe('deadline', () => {
      const fetchStub = vi.fn();
      /** A fetch that answers only by rejecting with the request signal's reason, as fetch does. */
      const hang = (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });

      beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', fetchStub);
        sparqlService.real = new WikidataSparqlService({} as AppConfig, {} as StorageService);
      });
      afterEach(() => {
        delete sparqlService.real;
        vi.unstubAllGlobals();
        vi.useRealTimers();
      });

      it('settles at the deadline with the answering graph when the other never answers', async () => {
        fetchStub.mockImplementation((url: string, init?: RequestInit) =>
          url.includes('query-scholarly')
            ? hang(url, init)
            : Promise.resolve(Response.json(results(claim('Q101574421', 'Researcher')))),
        );

        const ctx = createMockContext({ errors: wikidataResolveExternalId.errors });
        const input = wikidataResolveExternalId.input.parse({
          property: 'P496',
          value: '0000-0003-2992-658X',
        });
        let settled = false;
        const pending = Promise.resolve(wikidataResolveExternalId.handler(input, ctx)).finally(
          () => {
            settled = true;
          },
        );

        await vi.advanceTimersByTimeAsync(19_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        for (let i = 0; i < 20 && !settled; i++) await Promise.resolve();

        expect(settled).toBe(true);
        await expect(pending).resolves.toMatchObject({
          match: { id: 'Q101574421' },
          unavailableGraphs: ['scholarly_articles'],
        });
        expect(fetchStub).toHaveBeenCalledTimes(2);
      });
    });
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
    expect(calledQuery).toContain('ps:P356');
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
    expect(calledQuery).toContain('ps:P356');
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

  /** The SPARQL text the handler sent — what the label filters were built from. */
  const sentQuery = () => (mockQuery.mock.calls[0] as [string, ...unknown[]])[0];
  const call = (args: Record<string, unknown>) =>
    runToolContract(wikidataResolveExternalId, args as never);

  /**
   * #36: the language is spliced into SPARQL string literals, so it must be a validated code.
   * `en" || true || "` used to rewrite the FILTER into one every label language passes.
   */
  describe('language input', () => {
    it.each([
      ['', 'en'],
      ['EN', 'en'],
      ['en_GB', 'en-gb'],
    ])('filters labels and descriptions for language %j as %j', async (language, expected) => {
      mockQuery.mockResolvedValue(noResultResponse);

      const result = await call({ property: 'P345', value: 'nm0010930', language });

      expect(result.isError).toBeFalsy();
      expect(sentQuery()).toContain(`FILTER(LANG(?itemLabel) = "${expected}")`);
      expect(sentQuery()).toContain(`FILTER(LANG(?itemDescription) = "${expected}")`);
    });

    it.each([['en" || true || "'], ['en\\'], ['{en}'], ['en gb'], ['[AUTO_LANGUAGE]'], ['fr,en']])(
      'rejects language %j as invalid arguments before any upstream call',
      async (language) => {
        const result = await call({ property: 'P345', value: 'nm0010930', language });

        expect(result.isError).toBe(true);
        expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
          JsonRpcErrorCode.InvalidParams,
        );
        expect(mockFetchPropertyDataType).not.toHaveBeenCalled();
        expect(mockQuery).not.toHaveBeenCalled();
      },
    );
  });

  /**
   * #41: many items carry their name only as a multilingual (`mul`) label, and the SPARQL
   * path filtered on the requested language alone — Q42 came back with an empty label.
   */
  describe('mul label fallback', () => {
    const uri = (qid: string) => ({ type: 'uri', value: `http://www.wikidata.org/entity/${qid}` });
    const literal = (value: string, lang: string) => ({ type: 'literal', value, 'xml:lang': lang });

    it('also selects the mul label in the query', async () => {
      mockQuery.mockResolvedValue(noResultResponse);

      await call({ property: 'P345', value: 'nm0010930', language: 'de' });

      expect(sentQuery()).toContain('FILTER(LANG(?itemLabel) = "de")');
      expect(sentQuery()).toContain('FILTER(LANG(?mulLabel) = "mul")');
    });

    it('returns the mul label when the requested language has none', async () => {
      mockQuery.mockResolvedValue({
        head: { vars: ['item', 'itemLabel', 'mulLabel', 'itemDescription'] },
        results: {
          bindings: [
            {
              item: uri('Q42'),
              ...firstFormClaim,
              mulLabel: literal('Douglas Adams', 'mul'),
              itemDescription: literal('English science fiction writer', 'en'),
            },
          ],
        },
      });

      const result = await call({ property: 'P345', value: 'nm0010930' });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        match: { id: 'Q42', label: 'Douglas Adams', description: 'English science fiction writer' },
      });
      expect(result.content?.[0]).toMatchObject({
        text: expect.stringContaining('## Douglas Adams'),
      });
    });

    it('prefers the requested-language label over the mul label', async () => {
      mockQuery.mockResolvedValue({
        head: { vars: ['item', 'itemLabel', 'mulLabel', 'itemDescription'] },
        results: {
          bindings: [
            {
              item: uri('Q76'),
              ...firstFormClaim,
              itemLabel: literal('Barack Obama (de)', 'de'),
              mulLabel: literal('Barack Obama', 'mul'),
            },
          ],
        },
      });

      const result = await call({ property: 'P345', value: 'nm1682433', language: 'de' });

      expect(result.structuredContent).toMatchObject({ match: { label: 'Barack Obama (de)' } });
    });

    it('applies the fallback to each entry of multipleMatches', async () => {
      mockQuery.mockResolvedValue({
        head: { vars: ['item', 'itemLabel', 'mulLabel'] },
        results: {
          bindings: [
            { item: uri('Q111'), ...firstFormClaim, mulLabel: literal('Mul Only', 'mul') },
            {
              item: uri('Q222'),
              ...firstFormClaim,
              itemLabel: literal('English', 'en'),
              mulLabel: literal('Mul', 'mul'),
            },
            { item: uri('Q333'), ...firstFormClaim },
          ],
        },
      });

      const result = await call({ property: 'P356', value: '10.1234/dup' });

      expect(result.structuredContent).toMatchObject({
        match: null,
        multipleMatches: [
          { id: 'Q111', label: 'Mul Only' },
          { id: 'Q222', label: 'English' },
          { id: 'Q333', label: '' },
        ],
      });
    });
  });
});

/**
 * #54: the forms each property's value is looked up in, in the order they are tried. The handler
 * tests above prove the wiring (the echoed value, the `VALUES` block); the table lives here.
 */
describe('normalizeExternalId', () => {
  it.each([
    ['P932', 'PMC7652289x'],
    ['P6782', 'https://example.org/042nb2s44'],
    ['P6782', 'https://ror.org/042nb2s44/extra'],
    ['P213', '0000 0001 2124 432'],
    ['P818', 'arXiv:2002x11618'],
    ['P818', 'https://arxiv.org/abs/2002.11618/extra'],
    ['P214', 'https://ror.org/042nb2s44'],
  ])('keeps unsupported %s input literal: %s', (property, value) => {
    expect(normalizeExternalId(property, `  ${value}  `)).toEqual([value]);
  });

  it.each([
    ['P932', 'PMC7652289', '7652289'],
    ['P6782', 'https://ror.org/042nb2s44', '042nb2s44'],
    ['P6782', 'HTTPS://ROR.ORG/042nb2s44', '042nb2s44'],
    ['P213', '0000 0001 2124 4328', '0000000121244328'],
    ['P213', '0000 0001 2124 432X', '000000012124432X'],
    ['P818', 'arXiv:2002.11618', '2002.11618'],
    ['P818', 'https://arxiv.org/abs/2002.11618', '2002.11618'],
    ['P818', 'arXiv:hep-th/9901001v2', 'hep-th/9901001v2'],
    ['P818', 'https://arxiv.org/abs/math.GT/0309136v1', 'math.GT/0309136v1'],
  ])('normalizes %s display form %s', (property, value, expected) => {
    expect(normalizeExternalId(property, value)).toEqual([expected]);
    expect(normalizeExternalId(property, expected)).toEqual([expected]);
  });

  it.each([
    // OpenAlex: page and API URLs, any case, then the entity letter tried in both cases.
    ['P10283', 'https://openalex.org/A5035517966', ['A5035517966', 'a5035517966']],
    ['P10283', 'openalex.org/A5035517966', ['A5035517966', 'a5035517966']],
    ['P10283', 'https://api.openalex.org/authors/A5035517966', ['A5035517966', 'a5035517966']],
    ['P10283', 'HTTP://OpenAlex.org/works/W3112390984', ['W3112390984', 'w3112390984']],
    ['P10283', 'a5035517966', ['a5035517966', 'A5035517966']],
    ['P10283', 'A5041957172', ['A5041957172', 'a5041957172']],
    ['P10283', '5035517966', ['5035517966']],
    // ORCID: resolver URL or label, trailing slash, the check character uppercased.
    ['P496', '0000-0003-2992-658x', ['0000-0003-2992-658X']],
    ['P496', '000000032992658x', ['0000-0003-2992-658X']],
    ['P496', 'orcid.org/0000-0003-2992-658X', ['0000-0003-2992-658X']],
    ['P496', 'https://www.orcid.org/0000-0003-2992-658X/', ['0000-0003-2992-658X']],
    ['P496', 'ORCID: 0000-0003-2992-658X', ['0000-0003-2992-658X']],
    // DOI: every resolver host with or without a scheme, the label and its space; a final slash stays.
    ['P356', 'doi: 10.1038/nature14539', ['10.1038/NATURE14539']],
    ['P356', 'doi.org/10.1038/nature14539', ['10.1038/NATURE14539']],
    ['P356', 'www.doi.org/10.1038/nature14539', ['10.1038/NATURE14539']],
    ['P356', 'HTTPS://DX.DOI.ORG/10.1038/nature14539', ['10.1038/NATURE14539']],
    ['P356', 'https://doi.org/10.1000/xyz/', ['10.1000/XYZ/']],
    // PubMed: both resolver hosts, with or without a scheme and trailing slash, and the label.
    ['P698', 'https://www.ncbi.nlm.nih.gov/pubmed/26017442', ['26017442']],
    ['P698', 'www.ncbi.nlm.nih.gov/pubmed/26017442/', ['26017442']],
    ['P698', 'pubmed.ncbi.nlm.nih.gov/26017442/', ['26017442']],
    ['P698', 'PMID: 26017442', ['26017442']],
    // IMDb: the ID from a page URL with whatever follows it dropped, lowercased.
    ['P345', 'https://www.imdb.com/title/tt0111161/', ['tt0111161']],
    ['P345', 'TT0111161', ['tt0111161']],
    ['P345', 'https://m.imdb.com/name/NM0000209/?ref_=nv_sr_1', ['nm0000209']],
    ['P345', 'imdb.com/company/co0071240/', ['co0071240']],
    ['P345', 'https://www.imdb.com/title/tt0111161/reviews/', ['tt0111161']],
    // IMDb compound IDs: a character page keeps its path, a ceremony is tried with and without its number.
    [
      'P345',
      'https://www.imdb.com/title/tt0111161/characters/nm0000209',
      ['tt0111161/characters/nm0000209'],
    ],
    [
      'P345',
      'https://www.imdb.com/event/ev0000003/1982/1/',
      ['ev0000003/1982/1', 'ev0000003/1982'],
    ],
    ['P345', 'ev0000003/1930/2', ['ev0000003/1930/2', 'ev0000003/1930']],
    ['P345', 'https://www.imdb.com/event/ev0000003/', ['ev0000003']],
    // IMDb values that hold no ID are sent as given.
    ['P345', 'Cadre 45/2-Weltmeiste', ['Cadre 45/2-Weltmeiste']],
    ['P345', 'tt0111161/', ['tt0111161/']],
    ['P345', 'https://www.imdb.com/title/about/', ['https://www.imdb.com/title/about/']],
    // Another property is trimmed only — no other property's prefix applies to it.
    ['P214', '  https://doi.org/113230702 ', ['https://doi.org/113230702']],
  ])('%s %j → %j', (property, value, forms) => {
    expect(normalizeExternalId(property, value)).toEqual(forms);
  });
});

/** This thread's own CPU time in microseconds, which a descheduled worker does not accrue. */
const threadCpuUs = (): number => {
  const { user, system } = process.threadCpuUsage();
  return user + system;
};

/** Characters each timed batch scans: enough calls that a small input's batch outlasts the timer's resolution. */
const BATCH_CHARS = 500_000;
const BASE_CHARS = 5_000;
/** A linear scan grows at most 64× over the full span; a quadratic one passes 256 by 16×. */
const GROWTH_BOUND = 256;
/** Per-call CPU time at the largest size. Linear normalization of 320k characters costs well under 1 ms. */
const LARGEST_CALL_BOUND_US = 50_000;

/**
 * Least per-call CPU time of `scan(input)` over a few batches, since a garbage-collection pause
 * only ever adds time.
 */
function leastPerCallUs(scan: (input: string) => unknown, input: string): number {
  const calls = Math.max(1, Math.round(BATCH_CHARS / input.length));
  let least = Number.POSITIVE_INFINITY;
  for (let batch = 0; batch < 3; batch++) {
    const start = threadCpuUs();
    for (let call = 0; call < calls; call++) scan(input);
    least = Math.min(least, (threadCpuUs() - start) / calls);
  }
  return least;
}

/**
 * Asserts `scan` grows linearly in its input: doubling from 10k characters to `largest`, each
 * size is timed beside a fresh timing of the 5k baseline — a baseline timed once can sit on a
 * performance core while a later size runs on an efficiency core — and the least growth across up
 * to three such pairs must stay under GROWTH_BOUND before the next size runs, so a quadratic scan
 * fails at a small size instead of hanging on the largest. A pair under the bound settles its size.
 * The largest size also has an absolute bound.
 */
function expectLinearScan(
  build: (size: number) => string,
  scan: (input: string) => unknown,
  largest: number,
): void {
  scan(build(1_000));
  const base = build(BASE_CHARS);
  let largestCallUs = Number.POSITIVE_INFINITY;
  for (let size = BASE_CHARS * 2; size <= largest; size *= 2) {
    const input = build(size);
    let growth = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < 3 && growth >= GROWTH_BOUND; pair++) {
      const baseUs = leastPerCallUs(scan, base);
      largestCallUs = leastPerCallUs(scan, input);
      growth = Math.min(growth, largestCallUs / baseUs);
    }
    expect(growth, `CPU growth from ${BASE_CHARS} to ${size} characters`).toBeLessThan(
      GROWTH_BOUND,
    );
  }
  expect(largestCallUs, `CPU µs per call at ${largest} characters`).toBeLessThan(
    LARGEST_CALL_BOUND_US,
  );
}

/**
 * Every prefix pattern and per-property step runs over caller-sized text. Shapes with line breaks
 * or letter runs stop at 80k characters, below the size past which Bun's regex engine can switch to
 * a slower mode on linear patterns; digit runs, which never trigger it, carry the full 64× span.
 */
describe('normalizeExternalId timing', () => {
  const longLine = (size: number) => `${'§1 x'.repeat(Math.ceil(size / 4))}\ny`;
  const breaks = (size: number) => '  \r\n'.repeat(Math.ceil(size / 4));
  const digits = (size: number) => '1'.repeat(size);

  it.each([
    ['P356', 'a label, then line breaks', (n: number) => `doi:${breaks(n)}`, 80_000],
    [
      'P356',
      'a resolver URL, then one long line',
      (n: number) => `https://doi.org/${longLine(n)}`,
      80_000,
    ],
    [
      'P356',
      'a repeated resolver host',
      (n: number) => 'doi.org/'.repeat(Math.ceil(n / 8)),
      80_000,
    ],
    [
      'P356',
      'a resolver URL, then a digit run',
      (n: number) => `https://doi.org/10.${digits(n)}`,
      320_000,
    ],
    ['P698', 'a label, then line breaks', (n: number) => `PMID${breaks(n)}1`, 80_000],
    [
      'P698',
      'a resolver URL, then a digit run',
      (n: number) => `https://www.ncbi.nlm.nih.gov/pubmed/${digits(n)}/`,
      320_000,
    ],
    ['P496', 'a resolver URL, then line breaks', (n: number) => `orcid.org/${breaks(n)}x`, 80_000],
    ['P496', 'a hyphen run', (n: number) => '0000-'.repeat(Math.ceil(n / 5)), 80_000],
    [
      'P496',
      'a resolver URL, then a digit run',
      (n: number) => `https://orcid.org/${digits(n)}`,
      320_000,
    ],
    [
      'P10283',
      'a host, then an unterminated entity path',
      (n: number) => `openalex.org/${'a'.repeat(n)}`,
      80_000,
    ],
    ['P10283', 'a host, then one long line', (n: number) => `openalex.org/${longLine(n)}`, 80_000],
    [
      'P10283',
      'a host, then an ID with a digit run',
      (n: number) => `https://openalex.org/A${digits(n)}`,
      320_000,
    ],
    [
      'P345',
      'a title page, then digits and an unfinished character path',
      (n: number) => `imdb.com/title/tt${digits(n)}/characters/`,
      320_000,
    ],
    ['P345', 'a bare ID with trailing text', (n: number) => `tt${digits(n)}x`, 320_000],
    [
      'P345',
      'an event page, then line breaks',
      (n: number) => `imdb.com/event/ev1${breaks(n)}`,
      80_000,
    ],
    ['P345', 'one long line', longLine, 80_000],
    ['P932', 'a numeric display form', (n: number) => `PMC${digits(n)}`, 320_000],
    ['P818', 'a versioned ID', (n: number) => `arXiv:2002.11618v${digits(n)}`, 320_000],
    ['P818', 'an unrecognized archive', (n: number) => `arXiv:${'a'.repeat(n)}`, 80_000],
    ['P818', 'an invalid label and one long line', (n: number) => `arXiv:${longLine(n)}`, 80_000],
    ['P818', 'an invalid label and lines', (n: number) => `arXiv:${breaks(n)}x`, 80_000],
  ] as const)(
    '%s, %s, normalizes in linear time',
    (property, _shape, build, largest) => {
      expectLinearScan(build, (input) => normalizeExternalId(property, input), largest);
    },
    0,
  );
});
