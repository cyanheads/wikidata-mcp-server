/**
 * @fileoverview Tests for wikidata_get_entity tool.
 * @module tests/tools/get-entity.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

  it('format: renders every description, the en one also as the headline', () => {
    const langs = ['en', 'de', 'fr', 'es', 'it', 'ja', 'zh', 'pt', 'ru', 'ar'];
    const blocks = wikidataGetEntity.format!({
      id: 'Q76',
      type: 'item',
      kind: 'full' as const,
      descriptions: Object.fromEntries(langs.map((l) => [l, `desc-${l}`])),
      fieldsReturned: ['descriptions'],
    });
    const lines = (blocks[0] as { text: string }).text.split('\n');

    expect(lines).toContain('**Description:** desc-en');
    expect(lines).toContain('**Descriptions (10):**');
    for (const lang of langs) expect(lines).toContain(`- ${lang}: desc-${lang}`);
  });

  it('format: renders a category present alone, with no en entry', () => {
    const blocks = wikidataGetEntity.format!({
      id: 'Q76',
      type: 'item',
      kind: 'full' as const,
      labels: { de: 'Barack Obama' },
      fieldsReturned: ['labels'],
    });
    const lines = (blocks[0] as { text: string }).text.split('\n');

    expect(lines).toContain('**Label:** Barack Obama');
    expect(lines).toContain('- de: Barack Obama');
  });

  it('format: renders every alias in every language', () => {
    const aliases = Object.fromEntries(
      ['en', 'de', 'fr', 'es', 'it'].map((l) => [
        l,
        Array.from({ length: 7 }, (_, i) => `alias-${l}-${i}`),
      ]),
    );
    const blocks = wikidataGetEntity.format!({
      id: 'Q76',
      type: 'item',
      kind: 'full' as const,
      aliases,
      fieldsReturned: ['aliases'],
    });
    const lines = (blocks[0] as { text: string }).text.split('\n');

    expect(lines).toContain('**Aliases (35):**');
    expect(lines).toContain('- it: alias-it-6');
    expect(lines.filter((line) => /^- [a-z]+: alias-/.test(line))).toHaveLength(35);
  });

  /**
   * #28: full mode rendered 5 labels, en plus 3 descriptions, 3 alias languages of 5 aliases,
   * and statements and sitelinks as counts plus the enwiki link. Counted on both surfaces here,
   * past every one of those caps, through runToolContract.
   */
  it('carries every entry of every category on both surfaces in full mode (#28)', async () => {
    const langs = ['en', 'de', 'fr', 'es', 'it', 'nl', 'ja', 'pt'];
    const snak = (property: string, data_type: string, content: unknown) => ({
      property: { id: property, data_type },
      value: { type: 'value', content },
    });
    mockFetchEntity.mockResolvedValue({
      id: 'Q42',
      type: 'item',
      labels: Object.fromEntries(langs.map((l) => [l, `Douglas Adams (${l})`])),
      descriptions: Object.fromEntries(langs.map((l) => [l, `writer (${l})`])),
      aliases: Object.fromEntries(
        langs.slice(0, 5).map((l) => [l, Array.from({ length: 7 }, (_, i) => `DNA ${l} ${i}`)]),
      ),
      statements: {
        P31: [{ id: 'Q42$p31', rank: 'normal', ...snak('P31', 'wikibase-item', 'Q5') }],
        P569: [
          {
            id: 'Q42$p569',
            rank: 'preferred',
            ...snak('P569', 'time', { time: '+1952-03-11T00:00:00Z', precision: 11 }),
            qualifiers: [snak('P1480', 'wikibase-item', 'Q5727902')],
            references: Array.from({ length: 4 }, (_, r) => ({
              hash: `h${r}`,
              parts: [
                snak('P248', 'wikibase-item', `Q${200 + r}`),
                snak('P813', 'time', { time: '+2022-10-09T00:00:00Z', precision: 11 }),
              ],
            })),
          },
        ],
      },
      sitelinks: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          `l${i}wiki`,
          { title: `Douglas Adams ${i}`, url: `https://l${i}.wikipedia.org/wiki/DA` },
        ]),
      ),
    });

    const result = await runToolContract(wikidataGetEntity, { id: 'Q42' });
    const structured = result.structuredContent as {
      kind: string;
      labels: Record<string, string>;
      descriptions: Record<string, string>;
      aliases: Record<string, string[]>;
      statements: Record<string, Array<{ references?: Array<{ parts: unknown[] }> }>>;
      sitelinks: Record<string, unknown>;
    };
    const lines = result.content.flatMap((b) => (b as { text: string }).text.split('\n'));
    const between = (start: string, re: RegExp) => {
      const from = lines.indexOf(start);
      const tail = lines.slice(from + 1);
      const end = tail.findIndex((line) => !re.test(line));
      return end === -1 ? tail : tail.slice(0, end);
    };

    expect(structured.kind).toBe('full');
    expect(between('**Labels (8):**', /^- /)).toHaveLength(Object.keys(structured.labels).length);
    expect(between('**Descriptions (8):**', /^- /)).toHaveLength(
      Object.keys(structured.descriptions).length,
    );
    expect(between('**Aliases (35):**', /^- /)).toHaveLength(
      Object.values(structured.aliases).flat().length,
    );
    expect(between('**Sitelinks (40):**', /^- /)).toHaveLength(
      Object.keys(structured.sitelinks).length,
    );
    for (const site of Object.keys(structured.sitelinks)) {
      expect(lines.some((line) => line.startsWith(`- ${site}: [`))).toBe(true);
    }
    const statementCount = Object.values(structured.statements).flat().length;
    const references = Object.values(structured.statements)
      .flat()
      .flatMap((s) => s.references ?? []);
    expect(lines.filter((line) => line.startsWith('  - id: '))).toHaveLength(statementCount);
    expect(lines.filter((line) => /^ {4}- Reference \d+$/.test(line))).toHaveLength(
      references.length,
    );
    expect(lines.filter((line) => /^ {6}- P\d+: /.test(line))).toHaveLength(
      references.flatMap((r) => r.parts).length,
    );
    expect(lines).toContain('- Q5');
    expect(lines).toContain('- +1952-03-11T00:00:00Z (precision 11: day) ★');
    expect(lines).toContain('  - P1480: Q5727902');
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

    /**
     * The budget is UTF-8 bytes. Measured in UTF-16 code units, a CJK-heavy category counts a
     * third of its wire size: Q30's ["aliases","labels"] was offered as fitting at 30,409 bytes.
     */
    describe('the budget is measured in UTF-8 bytes', () => {
      const utf8 = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
      const askedFields = (notice: string): string[] => {
        const match = /fields:(\[[^\]]*\])/.exec(notice);
        return match?.[1] ? (JSON.parse(match[1]) as string[]) : [];
      };

      it('outlines a category that is under budget in characters but over it in bytes', async () => {
        // 9,000 characters, 27,000 bytes.
        mockFetchEntity.mockResolvedValue({
          id: 'Q30',
          type: 'item',
          labels: { zh: '中'.repeat(9_000) },
        });

        const result = wikidataGetEntity.output.parse(
          await wikidataGetEntity.handler(
            wikidataGetEntity.input.parse({ id: 'Q30', fields: ['labels'] }),
            createMockContext({ errors: wikidataGetEntity.errors }),
          ),
        );

        expect(result.kind).toBe('outline');
        expect(result.labels).toBeUndefined();
        expect(result.sections).toEqual([
          { name: 'labels', bytes: utf8({ zh: '中'.repeat(9_000) }) },
        ]);
        expect(result.retrieval_notice).toContain(
          `labels is ${utf8({ zh: '中'.repeat(9_000) })} bytes`,
        );
      });

      it('offers only a fields set whose UTF-8 size fits, and that set returns data', async () => {
        // Characters: aliases 7,000, labels 7,000, descriptions 12,000. Bytes: 21,000, 21,000, 12,000.
        const entity = {
          id: 'Q30',
          type: 'item' as const,
          aliases: { zh: ['中'.repeat(7_000)] },
          labels: { zh: '文'.repeat(7_000) },
          descriptions: { en: 'd'.repeat(12_000) },
        };
        mockFetchEntity.mockResolvedValue(entity);
        const ctx = createMockContext({ errors: wikidataGetEntity.errors });

        const outline = await wikidataGetEntity.handler(
          wikidataGetEntity.input.parse({ id: 'Q30' }),
          ctx,
        );
        expect(outline.kind).toBe('outline');
        const asked = askedFields(outline.retrieval_notice ?? '');
        expect(asked.length).toBeGreaterThan(0);

        const recall = await wikidataGetEntity.handler(
          wikidataGetEntity.input.parse({ id: 'Q30', fields: asked }),
          ctx,
        );
        expect(recall.kind).toBe('full');
        const delivered = Object.fromEntries(
          asked.map((name) => [name, (recall as Record<string, unknown>)[name]]),
        );
        expect(utf8(delivered)).toBeLessThanOrEqual(24_000);
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

  /**
   * #33: get_statements and the search/SPARQL tools spell it `language` (a string). The
   * singular key aliases onto `languages`, and the framework's string-as-array repair wraps a
   * lone string, so it reaches the handler as an array. Run through runToolContract, which
   * applies the production pre-validation.
   */
  describe('language input alias', () => {
    type ErrorEnvelope = {
      error: { code: number; message: string; data?: { recovery?: { hint?: string } } };
    };
    const errorOf = (result: { structuredContent?: unknown }) =>
      (result.structuredContent as ErrorEnvelope).error;
    const labelsOf = (result: { structuredContent?: unknown }) =>
      (result.structuredContent as { labels?: Record<string, string> }).labels;
    /** Raw `tools/call` arguments — deliberately outside the schema's input type. */
    const call = (args: Record<string, unknown>) =>
      runToolContract(wikidataGetEntity, args as never);

    it('accepts language as a lone string, reaching the handler as a one-element array', async () => {
      mockFetchEntity.mockResolvedValue(mockEntity);

      const result = await call({ id: 'Q76', language: 'de', fields: ['labels'] });

      expect(result.isError).toBeFalsy();
      expect(labelsOf(result)).toEqual({ de: 'Barack Obama' });
    });

    it('accepts language carrying an explicit array', async () => {
      mockFetchEntity.mockResolvedValue(mockEntity);

      const result = await call({ id: 'Q76', language: ['en', 'de'], fields: ['labels'] });

      expect(result.isError).toBeFalsy();
      expect(labelsOf(result)).toEqual({ en: 'Barack Obama', de: 'Barack Obama' });
    });

    it('keeps the canonical languages key working as before', async () => {
      mockFetchEntity.mockResolvedValue(mockEntity);

      const result = await call({ id: 'Q76', languages: ['de'], fields: ['labels'] });

      expect(result.isError).toBeFalsy();
      expect(labelsOf(result)).toEqual({ de: 'Barack Obama' });
    });

    it('rejects language sent beside languages, naming it as an alias', async () => {
      const result = await call({ id: 'Q76', language: 'de', languages: ['de'] });

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.recovery?.hint).toContain(
        'language is an alias of languages; send one of them, not both.',
      );
      expect(mockFetchEntity).not.toHaveBeenCalled();
    });

    it('still rejects a wrong type on the canonical languages field', async () => {
      const result = await call({ id: 'Q76', languages: true });

      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(mockFetchEntity).not.toHaveBeenCalled();
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

  /** #36: one shared language-code schema — normalized, blank entries dropped, [] means all. */
  describe('language input', () => {
    const call = (args: Record<string, unknown>) =>
      runToolContract(wikidataGetEntity, args as never);
    const labelsOf = (result: { structuredContent?: unknown }) =>
      (result.structuredContent as { labels?: Record<string, string> }).labels;

    beforeEach(() => {
      mockFetchEntity.mockResolvedValue(mockEntity);
    });

    it.each([
      [['EN'], { en: 'Barack Obama' }],
      [['', ' De '], { de: 'Barack Obama' }],
      [[], { en: 'Barack Obama', de: 'Barack Obama' }],
      [[''], { en: 'Barack Obama', de: 'Barack Obama' }],
    ])('narrows labels for languages %j', async (languages, expected) => {
      const result = await call({ id: 'Q76', languages, fields: ['labels'] });

      expect(result.isError).toBeFalsy();
      expect(labelsOf(result)).toEqual(expected);
    });

    it('normalizes a lone language sent under the singular alias', async () => {
      const result = await call({ id: 'Q76', language: 'DE', fields: ['labels'] });

      expect(result.isError).toBeFalsy();
      expect(labelsOf(result)).toEqual({ de: 'Barack Obama' });
    });

    it.each([['en" || true || "'], ['{en}'], ['en gb'], ['[AUTO_LANGUAGE]'], ['fr,en']])(
      'rejects an entry %j as invalid arguments before any upstream call',
      async (language) => {
        const result = await call({ id: 'Q76', languages: [language] });

        expect(result.isError).toBe(true);
        expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
          JsonRpcErrorCode.InvalidParams,
        );
        expect(mockFetchEntity).not.toHaveBeenCalled();
      },
    );
  });
});
