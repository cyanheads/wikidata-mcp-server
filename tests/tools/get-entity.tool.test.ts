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

/** Mirrors what fetchWithTimeout rejects with on a non-2xx: an McpError carrying data.statusCode. */
const httpError = (statusCode: number) =>
  new McpError(
    statusCode === 404 ? JsonRpcErrorCode.NotFound : JsonRpcErrorCode.InvalidParams,
    `Fetch failed for https://www.wikidata.org/w/rest.php/wikibase/v1/entities/items/Q76. Status: ${statusCode}`,
    { statusCode, statusText: statusCode === 404 ? 'Not Found' : 'Bad Request' },
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
    const err = await wikidataGetEntity.handler(input, ctx).catch((e: Error) => e);

    expect(err.message).toBe('No entity found for ID "Q999999999999".');
    expect(err.message).not.toContain('rest.php');
    expect(err.message).not.toContain('Status:');
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
      aliases: { en: ['Obama'] },
      fieldsReturned: ['aliases'],
    });
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('Obama');
    expect(text).not.toContain('languages total');
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
