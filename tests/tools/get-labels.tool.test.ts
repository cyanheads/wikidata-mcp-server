/**
 * @fileoverview Tests for wikidata_get_labels tool.
 * @module tests/tools/get-labels.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataGetLabels } from '@/mcp-server/tools/definitions/get-labels.tool.js';

const mockFetchLabels = vi.fn();

vi.mock('@/services/wikidata/wikidata-rest-service.js', () => ({
  getWikidataRestService: () => ({ fetchLabels: mockFetchLabels }),
  normalizeId: (id: string) => id.toUpperCase(),
}));

describe('wikidataGetLabels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns labels for valid Q-IDs', async () => {
    mockFetchLabels.mockResolvedValue({
      Q76: { labels: { en: 'Barack Obama' }, descriptions: { en: '44th U.S. President' } },
      Q42: { labels: { en: 'Douglas Adams' }, descriptions: { en: 'English author' } },
    });

    const ctx = createMockContext({ errors: wikidataGetLabels.errors });
    const input = wikidataGetLabels.input.parse({ ids: ['Q76', 'Q42'] });
    const result = await wikidataGetLabels.handler(input, ctx);

    expect(result.found).toBe(2);
    expect(result.notFound).toHaveLength(0);
    expect(result.entities.Q76!.labels.en).toBe('Barack Obama');
    expect(result.entities.Q42!.labels.en).toBe('Douglas Adams');
    expect(result.languages).toEqual(['en']);
  });

  it('reports not-found IDs separately', async () => {
    mockFetchLabels.mockResolvedValue({
      Q76: { labels: { en: 'Barack Obama' }, descriptions: {} },
      // Q999999 not returned → not found
    });

    const ctx = createMockContext({ errors: wikidataGetLabels.errors });
    const input = wikidataGetLabels.input.parse({ ids: ['Q76', 'Q999999'] });
    const result = await wikidataGetLabels.handler(input, ctx);

    expect(result.found).toBe(1);
    expect(result.notFound).toContain('Q999999');
  });

  it('supports P-IDs', async () => {
    mockFetchLabels.mockResolvedValue({
      P31: {
        labels: { en: 'instance of' },
        descriptions: { en: 'that class of which this subject is a particular example' },
      },
    });

    const ctx = createMockContext({ errors: wikidataGetLabels.errors });
    const input = wikidataGetLabels.input.parse({ ids: ['P31'] });
    const result = await wikidataGetLabels.handler(input, ctx);

    expect(result.entities.P31!.labels.en).toBe('instance of');
  });

  it('throws invalid_ids for malformed IDs', async () => {
    const ctx = createMockContext({ errors: wikidataGetLabels.errors });
    const input = wikidataGetLabels.input.parse({ ids: ['Q76', 'notanid'] });
    await expect(wikidataGetLabels.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_ids' },
    });
    expect(mockFetchLabels).not.toHaveBeenCalled();
  });

  it('supports multiple languages', async () => {
    mockFetchLabels.mockResolvedValue({
      Q76: { labels: { en: 'Barack Obama', de: 'Barack Obama' }, descriptions: {} },
    });

    const ctx = createMockContext({ errors: wikidataGetLabels.errors });
    const input = wikidataGetLabels.input.parse({ ids: ['Q76'], languages: ['en', 'de'] });
    const result = await wikidataGetLabels.handler(input, ctx);

    expect(result.languages).toEqual(['en', 'de']);
    expect(mockFetchLabels).toHaveBeenCalledWith(['Q76'], ['en', 'de'], expect.anything());
  });

  it('handles sparse upstream payload (entity found but no labels)', async () => {
    mockFetchLabels.mockResolvedValue({
      Q76: { labels: {}, descriptions: {} },
    });

    const ctx = createMockContext({ errors: wikidataGetLabels.errors });
    const input = wikidataGetLabels.input.parse({ ids: ['Q76'] });
    const result = await wikidataGetLabels.handler(input, ctx);

    expect(result.found).toBe(1);
    expect(result.entities.Q76!.labels).toEqual({});
  });

  it('formats labels with IDs', () => {
    const output = {
      entities: {
        Q76: {
          labels: { en: 'Barack Obama', de: 'Barack Obama' },
          descriptions: { en: '44th U.S. President' },
        },
      },
      found: 1,
      notFound: [],
      languages: ['en', 'de'],
    };
    const blocks = wikidataGetLabels.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Q76');
    expect(text).toContain('Barack Obama');
    expect(text).toContain('en');
  });

  it('format: preserves descriptions for each sampled language', () => {
    const blocks = wikidataGetLabels.format!({
      entities: {
        Q76: {
          labels: { en: 'Barack Obama', de: 'Barack Obama' },
          descriptions: {
            en: '44th president of the United States',
            de: '44. Präsident der Vereinigten Staaten',
          },
        },
        P31: {
          labels: { en: 'instance of', de: 'ist ein(e)' },
          descriptions: {
            en: 'class of which this subject is an example',
            de: 'Klasse, zu der dieses Objekt gehört',
          },
        },
      },
      found: 2,
      notFound: [],
      languages: ['en', 'de'],
    });
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('de: Barack Obama — 44. Präsident der Vereinigten Staaten');
    expect(text).toContain('de: ist ein(e) — Klasse, zu der dieses Objekt gehört');
  });

  /**
   * The rendered text samples 3 non-English languages; structuredContent carries every
   * language returned. Without a count, a content[]-only client cannot tell a complete
   * result from a silently-cut sample.
   */
  it('format: discloses the total when the language sample is truncated', () => {
    const langs = ['en', 'de', 'fr', 'es', 'it', 'ja', 'zh', 'pt', 'ru', 'ar'];
    const blocks = wikidataGetLabels.format!({
      entities: {
        Q76: {
          labels: Object.fromEntries(langs.map((l) => [l, `Obama-${l}`])),
          descriptions: { en: '44th U.S. President' },
        },
      },
      found: 1,
      notFound: [],
      languages: langs,
    });
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('(10 total)');
    // Only the first 3 non-English languages are sampled.
    expect(text).toContain('de: Obama-de');
    expect(text).not.toContain('ar: Obama-ar');
  });

  it('format: omits the total when no languages were cut', () => {
    const blocks = wikidataGetLabels.format!({
      entities: {
        Q76: {
          labels: { en: 'Barack Obama', de: 'Barack Obama' },
          descriptions: {},
        },
      },
      found: 1,
      notFound: [],
      languages: ['en', 'de'],
    });
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('de: Barack Obama');
    expect(text).not.toContain('total');
  });

  it('formats output with not-found IDs', () => {
    const output = {
      entities: {},
      found: 0,
      notFound: ['Q999999'],
      languages: ['en'],
    };
    const blocks = wikidataGetLabels.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Q999999');
  });

  it('input validation: empty ids array is rejected by Zod', () => {
    expect(() => wikidataGetLabels.input.parse({ ids: [] })).toThrow();
  });

  it('input validation: too many IDs (51) is rejected by Zod', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `Q${i + 1}`);
    expect(() => wikidataGetLabels.input.parse({ ids })).toThrow();
  });

  it('input validation: all IDs valid at max batch size (50)', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `Q${i + 1}`);
    expect(() => wikidataGetLabels.input.parse({ ids })).not.toThrow();
  });

  it('normalizes lowercase IDs before validation', async () => {
    mockFetchLabels.mockResolvedValue({
      Q76: { labels: { en: 'Barack Obama' }, descriptions: {} },
    });

    const ctx = createMockContext({ errors: wikidataGetLabels.errors });
    // normalizeId is mocked to uppercase
    const input = wikidataGetLabels.input.parse({ ids: ['q76'] });
    const result = await wikidataGetLabels.handler(input, ctx);

    expect(result.found).toBe(1);
    expect(mockFetchLabels).toHaveBeenCalledWith(['Q76'], ['en'], expect.anything());
  });

  it('security: injection attempt in IDs array is rejected as invalid', async () => {
    const ctx = createMockContext({ errors: wikidataGetLabels.errors });
    const input = wikidataGetLabels.input.parse({ ids: ['Q76', '"; DROP TABLE; --'] });
    await expect(wikidataGetLabels.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_ids' },
    });
    expect(mockFetchLabels).not.toHaveBeenCalled();
  });

  it('security: no env secret appears in labels output', async () => {
    process.env['TEST_LABELS_SECRET'] = 'labels_secret_def456';
    mockFetchLabels.mockResolvedValue({
      Q76: { labels: { en: 'Barack Obama' }, descriptions: { en: '44th President' } },
    });

    const ctx = createMockContext({ errors: wikidataGetLabels.errors });
    const input = wikidataGetLabels.input.parse({ ids: ['Q76'] });
    const result = await wikidataGetLabels.handler(input, ctx);

    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('labels_secret_def456');
    delete process.env['TEST_LABELS_SECRET'];
  });

  it('re-throws non-validation service errors', async () => {
    mockFetchLabels.mockRejectedValue(new Error('API rate limit'));

    const ctx = createMockContext({ errors: wikidataGetLabels.errors });
    const input = wikidataGetLabels.input.parse({ ids: ['Q76'] });
    await expect(wikidataGetLabels.handler(input, ctx)).rejects.toThrow('API rate limit');
  });
});
