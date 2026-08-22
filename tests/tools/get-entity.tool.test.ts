/**
 * @fileoverview Tests for wikidata_get_entity tool.
 * @module tests/tools/get-entity.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataGetEntity } from '@/mcp-server/tools/definitions/get-entity.tool.js';

const mockFetchEntity = vi.fn();

/**
 * Stub only the service accessor — the I/O boundary. The module's pure helpers
 * (isEntityNotFoundError, resolveLangValue, isQId, normalizeId) stay real, so these
 * tests exercise the actual not-found predicate and mul-fallback rather than a
 * second copy of that logic living in the mock.
 */
vi.mock('@/services/wikidata/wikidata-rest-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/wikidata/wikidata-rest-service.js')>()),
  getWikidataRestService: () => ({ fetchEntity: mockFetchEntity }),
}));

/** Mirrors what fetchWithTimeout rejects with on a non-2xx: an McpError carrying data.status. */
const httpError = (status: number) =>
  new McpError(
    status === 404 ? JsonRpcErrorCode.NotFound : JsonRpcErrorCode.InvalidParams,
    `Fetch failed for https://www.wikidata.org/w/rest.php/wikibase/v1/entities/items/Q76. Status: ${status}`,
    { status, statusText: status === 404 ? 'Not Found' : 'Bad Request' },
  );

const mockEntity = {
  id: 'Q76',
  type: 'item' as const,
  labels: {
    en: 'Barack Obama',
    de: 'Barack Obama',
  },
  descriptions: { en: '44th U.S. President' },
  aliases: {
    en: ['Obama', 'President Obama'],
  },
  statements: {
    P31: [
      {
        id: 'stmt1',
        rank: 'normal',
        property: { id: 'P31', data_type: 'wikibase-item' },
        value: { type: 'wikibase-item', content: { id: 'Q5' } },
        qualifiers: [],
        references: [],
      },
    ],
  },
  sitelinks: {
    enwiki: { title: 'Barack Obama', url: 'https://en.wikipedia.org/wiki/Barack_Obama' },
  },
};

describe('wikidataGetEntity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns full entity for a valid Q-ID', async () => {
    mockFetchEntity.mockResolvedValue(mockEntity);

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({ id: 'Q76' });
    const result = await wikidataGetEntity.handler(input, ctx);

    expect(result.id).toBe('Q76');
    expect(result.type).toBe('item');
    expect((result.labels as Record<string, string>).en).toBe('Barack Obama');
    expect(result.fieldsReturned).toContain('labels');
  });

  it('filters to requested fields only', async () => {
    mockFetchEntity.mockResolvedValue(mockEntity);

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({ id: 'Q76', fields: ['labels'] });
    const result = await wikidataGetEntity.handler(input, ctx);

    expect(result.labels).toBeDefined();
    expect(result.descriptions).toBeUndefined();
    expect(result.statements).toBeUndefined();
    expect(result.fieldsReturned).toEqual(['labels']);
  });

  it('filters to requested languages', async () => {
    mockFetchEntity.mockResolvedValue(mockEntity);

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({
      id: 'Q76',
      fields: ['labels'],
      languages: ['en'],
    });
    const result = await wikidataGetEntity.handler(input, ctx);

    const labels = result.labels as Record<string, string> | undefined;
    expect(labels).toBeDefined();
    expect(labels!.en).toBe('Barack Obama');
    expect(labels!.de).toBeUndefined();
  });

  it('throws invalid_id for malformed ID', async () => {
    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({ id: 'notanid' });
    await expect(wikidataGetEntity.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('throws entity_not_found for an unassigned ID (404)', async () => {
    mockFetchEntity.mockRejectedValue(httpError(404));

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({ id: 'Q99999999' });
    await expect(wikidataGetEntity.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'entity_not_found' },
    });
  });

  it('throws entity_not_found for an out-of-range ID (400)', async () => {
    mockFetchEntity.mockRejectedValue(httpError(400));

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({ id: 'Q999999999999' });
    await expect(wikidataGetEntity.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'entity_not_found' },
    });
  });

  it('does not leak the raw upstream URL or status on a not-found', async () => {
    mockFetchEntity.mockRejectedValue(httpError(400));

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({ id: 'Q999999999999' });
    const err = await Promise.resolve(wikidataGetEntity.handler(input, ctx)).catch(
      (error: unknown) => error,
    );

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toBe('No entity found for ID "Q999999999999".');
    expect(message).not.toContain('rest.php');
    expect(message).not.toContain('Status:');
  });

  it('re-throws service errors that are not a not-found', async () => {
    mockFetchEntity.mockRejectedValue(new Error('Network timeout'));

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({ id: 'Q76' });
    await expect(wikidataGetEntity.handler(input, ctx)).rejects.toThrow('Network timeout');
  });

  it('handles sparse entity (no optional fields)', async () => {
    mockFetchEntity.mockResolvedValue({ id: 'Q1', type: 'item' });

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({ id: 'Q1', fields: ['labels', 'descriptions'] });
    const result = await wikidataGetEntity.handler(input, ctx);

    expect(result.id).toBe('Q1');
    expect(result.labels).toBeUndefined();
    expect(result.descriptions).toBeUndefined();
  });

  it('formats entity output with IDs and labels', () => {
    const output = {
      id: 'Q76',
      type: 'item',
      kind: 'full' as const,
      labels: { en: 'Barack Obama', de: 'Barack Obama' },
      descriptions: { en: '44th U.S. President' },
      aliases: { en: ['Obama', 'President Obama'] as unknown as string[] },
      statements: { P31: [{}] },
      sitelinks: {
        enwiki: { title: 'Barack Obama', url: 'https://en.wikipedia.org/wiki/Barack_Obama' } as {
          url?: string;
          title?: string;
        },
      },
      fieldsReturned: ['labels', 'descriptions', 'aliases', 'statements', 'sitelinks'],
    };
    const blocks = wikidataGetEntity.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Q76');
    expect(text).toContain('Barack Obama');
    expect(text).toContain('44th U.S. President');
    expect(text).toContain('Sitelinks');
  });

  it('includes badges in sitelinks when present', async () => {
    mockFetchEntity.mockResolvedValue({
      id: 'Q76',
      type: 'item',
      sitelinks: {
        enwiki: {
          title: 'Barack Obama',
          url: 'https://en.wikipedia.org/wiki/Barack_Obama',
          badges: ['Q17437798'],
        },
      },
    });

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({ id: 'Q76', fields: ['sitelinks'] });
    const result = await wikidataGetEntity.handler(input, ctx);

    const sitelinks = result.sitelinks as Record<
      string,
      { title?: string; url?: string; badges?: string[] }
    >;
    expect(sitelinks.enwiki?.badges).toEqual(['Q17437798']);
  });

  it('returns data_type for property entities', async () => {
    mockFetchEntity.mockResolvedValue({
      id: 'P31',
      type: 'property',
      data_type: 'wikibase-item',
      labels: { en: 'instance of' },
    });

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({ id: 'P31', fields: ['labels'] });
    const result = await wikidataGetEntity.handler(input, ctx);

    expect(result.type).toBe('property');
    expect(result.data_type).toBe('wikibase-item');
  });

  it('filters languages to empty set returns undefined (no matching data)', async () => {
    mockFetchEntity.mockResolvedValue(mockEntity);

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({
      id: 'Q76',
      fields: ['labels'],
      languages: ['zz'], // non-existent language
    });
    const result = await wikidataGetEntity.handler(input, ctx);

    // No labels match the requested language — filtered to undefined
    expect(result.labels).toBeUndefined();
  });

  /**
   * The REST API returns exactly the language keys an entity carries and has no
   * languagefallback parameter, so a mul-only item like Q76 arrives with no `en` label.
   */
  it('resolves a requested language to the mul label when the entity has no label for it', async () => {
    mockFetchEntity.mockResolvedValue({
      id: 'Q76',
      type: 'item',
      labels: { mul: 'Barack Obama' },
      descriptions: { en: 'president of the United States from 2009 to 2017 (born 1961)' },
      aliases: { mul: ['Barack Hussein Obama II'] },
    });

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({
      id: 'Q76',
      fields: ['labels', 'descriptions', 'aliases'],
      languages: ['en', 'de'],
    });
    const result = await wikidataGetEntity.handler(input, ctx);

    // The mul value lands under each requested code, never as a raw `mul` key.
    const labels = result.labels as Record<string, string>;
    expect(labels).toEqual({ en: 'Barack Obama', de: 'Barack Obama' });
    expect(labels.mul).toBeUndefined();
    // A real per-language value still wins over mul.
    expect((result.descriptions as Record<string, string>).en).toContain('president');
    expect((result.aliases as Record<string, string[]>).en).toEqual(['Barack Hussein Obama II']);
  });

  it('prefers an exact language label over the mul fallback', async () => {
    mockFetchEntity.mockResolvedValue({
      id: 'Q42',
      type: 'item',
      labels: { en: 'Douglas Adams', mul: 'D. Adams' },
    });

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({
      id: 'Q42',
      fields: ['labels'],
      languages: ['en'],
    });
    const result = await wikidataGetEntity.handler(input, ctx);

    expect((result.labels as Record<string, string>).en).toBe('Douglas Adams');
  });

  it('returns mul as its own key when the caller requests it explicitly', async () => {
    mockFetchEntity.mockResolvedValue({
      id: 'Q76',
      type: 'item',
      labels: { mul: 'Barack Obama' },
    });

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({
      id: 'Q76',
      fields: ['labels'],
      languages: ['mul'],
    });
    const result = await wikidataGetEntity.handler(input, ctx);

    expect((result.labels as Record<string, string>).mul).toBe('Barack Obama');
  });

  it('format: discloses the total when the descriptions sample is truncated', () => {
    const descriptions = Object.fromEntries(
      ['en', 'de', 'fr', 'es', 'it', 'ja', 'zh', 'pt', 'ru', 'ar'].map((l) => [l, `desc-${l}`]),
    );
    const blocks = wikidataGetEntity.format!({
      id: 'Q76',
      type: 'item',
      kind: 'full' as const,
      descriptions,
      fieldsReturned: ['descriptions'],
    });
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('(10 total)');
  });

  it('format: omits the descriptions total when nothing was cut', () => {
    const blocks = wikidataGetEntity.format!({
      id: 'Q76',
      type: 'item',
      kind: 'full' as const,
      descriptions: { en: 'desc-en', de: 'desc-de' },
      fieldsReturned: ['descriptions'],
    });
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('de: desc-de');
    expect(text).not.toContain('total');
  });

  it('format: discloses the alias language total when the list is truncated', () => {
    const aliases = Object.fromEntries(
      ['en', 'de', 'fr', 'es', 'it'].map((l) => [l, [`alias-${l}`]]),
    );
    const blocks = wikidataGetEntity.format!({
      id: 'Q76',
      type: 'item',
      kind: 'full' as const,
      aliases,
      fieldsReturned: ['aliases'],
    });
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('(5 languages total)');
  });

  it('format: omits the alias language total when nothing was cut', () => {
    const blocks = wikidataGetEntity.format!({
      id: 'Q76',
      type: 'item',
      kind: 'full' as const,
      aliases: { en: ['Obama'] },
      fieldsReturned: ['aliases'],
    });
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('Obama');
    expect(text).not.toContain('languages total');
  });

  /**
   * #26: `fields` narrows the upstream fetch via `?_fields=`, not just the response. The
   * service owns which values each endpoint accepts; the tool's job is to pass the caller's
   * selection down rather than fetch everything and filter.
   */
  describe('field selection reaches the fetch', () => {
    it('passes the requested fields to the service', async () => {
      mockFetchEntity.mockResolvedValue(mockEntity);

      const ctx = createMockContext({ errors: wikidataGetEntity.errors });
      const input = wikidataGetEntity.input.parse({ id: 'Q76', fields: ['labels'] });
      await wikidataGetEntity.handler(input, ctx);

      expect(mockFetchEntity).toHaveBeenCalledWith('Q76', expect.anything(), ['labels']);
    });

    it('passes no field list when the caller wants everything', async () => {
      mockFetchEntity.mockResolvedValue(mockEntity);

      const ctx = createMockContext({ errors: wikidataGetEntity.errors });
      const input = wikidataGetEntity.input.parse({ id: 'Q76' });
      await wikidataGetEntity.handler(input, ctx);

      expect(mockFetchEntity).toHaveBeenCalledWith('Q76', expect.anything(), undefined);
    });

    it("passes the normalized ID, not the caller's casing", async () => {
      mockFetchEntity.mockResolvedValue(mockEntity);

      const ctx = createMockContext({ errors: wikidataGetEntity.errors });
      const input = wikidataGetEntity.input.parse({ id: ' q76 ', fields: ['labels'] });
      await wikidataGetEntity.handler(input, ctx);

      expect(mockFetchEntity).toHaveBeenCalledWith('Q76', expect.anything(), ['labels']);
    });
  });

  /**
   * #17: `get_entity` on a well-connected item returned a 793,897-character payload — past
   * the calling client's token ceiling. Over budget it now outlines the field categories,
   * which is exactly the vocabulary the `fields` input already takes.
   */
  describe('overflow to outline', () => {
    /** An entity whose categories together exceed the 24,000-byte budget. */
    const bulkyEntity = {
      id: 'Q30',
      type: 'item' as const,
      labels: { en: 'x'.repeat(9_000) },
      descriptions: { en: 'y'.repeat(9_000) },
      aliases: { en: ['z'.repeat(9_000)] },
    };

    /** A statements category that alone exceeds the budget — the live Q30 case, ~793KB. */
    const oversizedStatements = {
      id: 'Q30',
      type: 'item' as const,
      statements: {
        P31: [
          {
            id: 's',
            rank: 'normal',
            property: { id: 'P31' },
            value: { type: 'string', content: 'q'.repeat(40_000) },
          },
        ],
      },
    };

    it('returns the data inline when the entity fits the budget', async () => {
      mockFetchEntity.mockResolvedValue(mockEntity);

      const ctx = createMockContext({ errors: wikidataGetEntity.errors });
      const input = wikidataGetEntity.input.parse({ id: 'Q76' });
      const result = await wikidataGetEntity.handler(input, ctx);

      expect(result.kind).toBe('full');
      expect(result.labels).toBeDefined();
      expect(result.sections).toBeUndefined();
      expect(result.retrieval_notice).toBeUndefined();
    });

    it('returns an outline instead of the data for an oversized entity', async () => {
      mockFetchEntity.mockResolvedValue(bulkyEntity);

      const ctx = createMockContext({ errors: wikidataGetEntity.errors });
      const input = wikidataGetEntity.input.parse({ id: 'Q30' });
      const result = await wikidataGetEntity.handler(input, ctx);

      expect(result.kind).toBe('outline');
      expect(result.labels).toBeUndefined();
      expect(result.descriptions).toBeUndefined();
      expect(result.aliases).toBeUndefined();
      expect(JSON.stringify(result).length).toBeLessThan(24_000);
    });

    it('outlines only field categories — never id, type, or fieldsReturned', async () => {
      mockFetchEntity.mockResolvedValue(bulkyEntity);

      const ctx = createMockContext({ errors: wikidataGetEntity.errors });
      const input = wikidataGetEntity.input.parse({ id: 'Q30' });
      const result = await wikidataGetEntity.handler(input, ctx);

      // Every section name must be something `fields` will accept on the re-call.
      const names = (result.sections ?? []).map((s) => s.name).sort();
      expect(names).toEqual(['aliases', 'descriptions', 'labels']);
      const enumValues = ['labels', 'descriptions', 'aliases', 'statements', 'sitelinks'];
      for (const name of names) expect(enumValues).toContain(name);
    });

    it('keeps the entity identity alongside the outline', async () => {
      mockFetchEntity.mockResolvedValue(bulkyEntity);

      const ctx = createMockContext({ errors: wikidataGetEntity.errors });
      const input = wikidataGetEntity.input.parse({ id: 'Q30' });
      const result = await wikidataGetEntity.handler(input, ctx);

      // An outline that did not say which entity it described would be unusable.
      expect(result.id).toBe('Q30');
      expect(result.type).toBe('item');
      expect(result.fieldsReturned).toContain('labels');
    });

    it('points the re-call at the fields parameter, not a sections parameter', async () => {
      mockFetchEntity.mockResolvedValue(bulkyEntity);

      const ctx = createMockContext({ errors: wikidataGetEntity.errors });
      const input = wikidataGetEntity.input.parse({ id: 'Q30' });
      const result = await wikidataGetEntity.handler(input, ctx);

      // The tool has no `sections` input — the outline must name the lever it does have.
      expect(result.retrieval_notice).toContain('fields:[');
      expect(result.retrieval_notice).not.toContain('sections:[...]');
      // Every section here fits, so nothing needs redirecting elsewhere.
      expect(result.retrieval_notice).not.toContain('wikidata_get_statements');
    });

    /**
     * The termination guarantee: following the notice must make progress. The regression is a
     * closed loop — a notice enumerating every individually-fitting category as one re-call,
     * when their combined size overflows, so the caller re-issues that call and gets the same
     * outline forever. These read the notice the way a caller would and follow it literally,
     * rather than asserting against an assumption about what it says.
     */
    describe('following the notice terminates', () => {
      /** The literal fields array the notice tells the caller to send next. */
      const askedFields = (notice: string): string[] => {
        const match = /fields:(\[[^\]]*\])/.exec(notice);
        return match?.[1] ? (JSON.parse(match[1]) as string[]) : [];
      };

      /** Each category fits alone; 12,400 + 10,400 + 6,800 together does not. */
      const additivelyOversized = {
        id: 'Q30',
        type: 'item' as const,
        aliases: { en: ['a'.repeat(12_400)] },
        labels: { en: 'l'.repeat(10_400) },
        descriptions: { en: 'd'.repeat(6_800) },
      };

      it('names a set that fits combined, not every category that fits alone', async () => {
        mockFetchEntity.mockResolvedValue(additivelyOversized);

        const ctx = createMockContext({ errors: wikidataGetEntity.errors });
        const result = await wikidataGetEntity.handler(
          wikidataGetEntity.input.parse({ id: 'Q30' }),
          ctx,
        );

        const asked = askedFields(result.retrieval_notice ?? '');
        expect(asked.length).toBeGreaterThan(0);
        expect(asked.length).toBeLessThan(3);
        expect(result.retrieval_notice).toContain('in a further call');
      });

      it('re-calling with the fields the notice names returns data, not the same outline', async () => {
        mockFetchEntity.mockResolvedValue(additivelyOversized);

        const ctx = createMockContext({ errors: wikidataGetEntity.errors });
        const first = await wikidataGetEntity.handler(
          wikidataGetEntity.input.parse({ id: 'Q30' }),
          ctx,
        );
        expect(first.kind).toBe('outline');

        // Do exactly what the notice says, with no interpretation.
        const second = await wikidataGetEntity.handler(
          wikidataGetEntity.input.parse({
            id: 'Q30',
            fields: askedFields(first.retrieval_notice ?? ''),
          }),
          ctx,
        );

        expect(second.kind).toBe('full');
        expect(second.retrieval_notice).toBeUndefined();
        expect(JSON.stringify(second).length).toBeLessThanOrEqual(24_000);
      });

      it('leaves the deferred categories reachable in a further call', async () => {
        mockFetchEntity.mockResolvedValue(additivelyOversized);

        const ctx = createMockContext({ errors: wikidataGetEntity.errors });
        const first = await wikidataGetEntity.handler(
          wikidataGetEntity.input.parse({ id: 'Q30' }),
          ctx,
        );
        const asked = askedFields(first.retrieval_notice ?? '');
        const deferred = ['aliases', 'labels', 'descriptions'].filter((f) => !asked.includes(f));

        const rest = await wikidataGetEntity.handler(
          wikidataGetEntity.input.parse({ id: 'Q30', fields: deferred }),
          ctx,
        );

        // Two calls retrieve everything — nothing is stranded by the split.
        expect(deferred.length).toBeGreaterThan(0);
        expect(rest.kind).toBe('full');
      });

      it('never names an oversized category in the fields set', async () => {
        mockFetchEntity.mockResolvedValue({
          id: 'Q30',
          type: 'item',
          labels: { en: 'l'.repeat(9_000) },
          descriptions: { en: 'd'.repeat(9_000) },
          statements: oversizedStatements.statements,
        });

        const ctx = createMockContext({ errors: wikidataGetEntity.errors });
        const result = await wikidataGetEntity.handler(
          wikidataGetEntity.input.parse({ id: 'Q30' }),
          ctx,
        );

        const asked = askedFields(result.retrieval_notice ?? '');
        expect(asked).not.toContain('statements');
        expect(asked).toContain('labels');
      });

      it('offers no fields set at all when nothing can be delivered through it', async () => {
        mockFetchEntity.mockResolvedValue(oversizedStatements);

        const ctx = createMockContext({ errors: wikidataGetEntity.errors });
        const result = await wikidataGetEntity.handler(
          wikidataGetEntity.input.parse({ id: 'Q30', fields: ['statements'] }),
          ctx,
        );

        // No fields advice to follow — the redirect is the progress.
        expect(askedFields(result.retrieval_notice ?? '')).toEqual([]);
        expect(result.retrieval_notice).toContain('wikidata_get_statements');
      });
    });

    /**
     * The regression this guards: the outline must never point a caller at a category it has
     * already measured as over budget. `fields` would return the same overflow, so following
     * our own notice would land on the failure the outline exists to prevent. Each oversized
     * category is redirected to a lever with finer granularity than `fields` carries.
     */
    describe('oversized categories are redirected, never advertised via fields', () => {
      it('outlines a lone oversized category rather than returning it whole', async () => {
        mockFetchEntity.mockResolvedValue(oversizedStatements);

        const ctx = createMockContext({ errors: wikidataGetEntity.errors });
        const input = wikidataGetEntity.input.parse({ id: 'Q30', fields: ['statements'] });
        const result = await wikidataGetEntity.handler(input, ctx);

        // One section, over budget: the primitive short-circuits to `full` here and hands
        // back the payload. The redirect is what makes the round-trip worth taking.
        expect(result.kind).toBe('outline');
        expect(result.statements).toBeUndefined();
        expect(result.sections).toHaveLength(1);
        expect(JSON.stringify(result).length).toBeLessThan(24_000);
      });

      it('routes a lone oversized statements category to wikidata_get_statements', async () => {
        mockFetchEntity.mockResolvedValue(oversizedStatements);

        const ctx = createMockContext({ errors: wikidataGetEntity.errors });
        const input = wikidataGetEntity.input.parse({ id: 'Q30', fields: ['statements'] });
        const result = await wikidataGetEntity.handler(input, ctx);

        expect(result.retrieval_notice).toContain('wikidata_get_statements');
        expect(result.retrieval_notice).toContain('properties:[...]');
        // Nothing fits, so there is no fields offer at all to mislead the caller.
        expect(result.retrieval_notice).not.toContain('fields:[');
      });

      it('routes an oversized sitelinks category to wikidata_get_sitelinks', async () => {
        mockFetchEntity.mockResolvedValue({
          id: 'Q30',
          type: 'item',
          sitelinks: Object.fromEntries(
            Array.from({ length: 400 }, (_, i) => [`site${i}wiki`, { title: 'x'.repeat(80) }]),
          ),
        });

        const ctx = createMockContext({ errors: wikidataGetEntity.errors });
        const input = wikidataGetEntity.input.parse({ id: 'Q30', fields: ['sitelinks'] });
        const result = await wikidataGetEntity.handler(input, ctx);

        expect(result.kind).toBe('outline');
        expect(result.retrieval_notice).toContain('wikidata_get_sitelinks');
        expect(result.retrieval_notice).toContain('sites:[...]');
      });

      it('routes an oversized language-keyed category to the languages parameter', async () => {
        mockFetchEntity.mockResolvedValue({
          id: 'Q30',
          type: 'item',
          labels: Object.fromEntries(
            Array.from({ length: 400 }, (_, i) => [`lang${i}`, 'x'.repeat(80)]),
          ),
        });

        const ctx = createMockContext({ errors: wikidataGetEntity.errors });
        const input = wikidataGetEntity.input.parse({ id: 'Q30', fields: ['labels'] });
        const result = await wikidataGetEntity.handler(input, ctx);

        expect(result.kind).toBe('outline');
        expect(result.retrieval_notice).toContain('languages');
      });

      /**
       * The composed failure that started this: a multi-section outline advertising
       * `statements` — a section it had just measured at 793,825 bytes — as fields-retrievable.
       */
      it('splits a mixed outline into fields for what fits and a redirect for what does not', async () => {
        mockFetchEntity.mockResolvedValue({
          id: 'Q30',
          type: 'item',
          labels: { en: 'x'.repeat(9_000) },
          descriptions: { en: 'y'.repeat(9_000) },
          statements: oversizedStatements.statements,
        });

        const ctx = createMockContext({ errors: wikidataGetEntity.errors });
        const input = wikidataGetEntity.input.parse({ id: 'Q30' });
        const result = await wikidataGetEntity.handler(input, ctx);

        expect(result.kind).toBe('outline');
        const notice = result.retrieval_notice ?? '';

        // The fields set covers the two that fit and excludes the one that does not.
        const offer = /fields:(\[[^\]]*\])/.exec(notice)?.[1] ?? '';
        expect(offer).toContain('labels');
        expect(offer).toContain('descriptions');
        expect(offer).not.toContain('statements');

        // ...and statements carries its own redirect instead.
        expect(notice).toContain('wikidata_get_statements');
        expect(notice).toContain('properties:[...]');
      });

      it('offers fields for every section when none is individually oversized', async () => {
        mockFetchEntity.mockResolvedValue(bulkyEntity);

        const ctx = createMockContext({ errors: wikidataGetEntity.errors });
        const input = wikidataGetEntity.input.parse({ id: 'Q30' });
        const result = await wikidataGetEntity.handler(input, ctx);

        const notice = result.retrieval_notice ?? '';
        expect(notice).toContain('fields:[');
        expect(notice).not.toContain('cannot deliver');
        // Each is reachable — named in the fields set, or deferred to a further call.
        for (const name of ['labels', 'descriptions', 'aliases']) expect(notice).toContain(name);
      });
    });

    it('format: renders the outline sections and the re-call notice', () => {
      const blocks = wikidataGetEntity.format!({
        id: 'Q30',
        type: 'item',
        kind: 'outline',
        fieldsReturned: ['labels', 'statements'],
        sections: [
          { name: 'statements', bytes: 793_825 },
          { name: 'sitelinks', bytes: 59_631 },
        ],
        retrieval_notice:
          'Entity too large to inline. Re-call wikidata_get_entity with the same id plus fields:["labels"].',
      });
      const text = blocks.map((b) => (b as { text: string }).text).join('\n');

      expect(text).toContain('Q30');
      expect(text).toContain('statements');
      expect(text).toContain('793825');
      expect(text).toContain('fields:["labels"]');
      expect(text).toContain('2 sections available');
    });
  });

  it('security: injection attempt in ID is rejected as invalid', async () => {
    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({ id: '"; DROP TABLE entities; --' });
    await expect(wikidataGetEntity.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
    expect(mockFetchEntity).not.toHaveBeenCalled();
  });

  it('security: no env secret appears in entity output', async () => {
    process.env['TEST_ENTITY_SECRET'] = 'entity_secret_abc999';
    mockFetchEntity.mockResolvedValue({ id: 'Q1', type: 'item', labels: { en: 'Universe' } });

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({ id: 'Q1' });
    const result = await wikidataGetEntity.handler(input, ctx);

    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('entity_secret_abc999');
    delete process.env['TEST_ENTITY_SECRET'];
  });
});
