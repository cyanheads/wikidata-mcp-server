/**
 * @fileoverview Tests for wikidata_get_entity tool.
 * @module tests/tools/get-entity.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataGetEntity } from '@/mcp-server/tools/definitions/get-entity.tool.js';

const mockFetchEntity = vi.fn();

vi.mock('@/services/wikidata/wikidata-rest-service.js', () => ({
  getWikidataRestService: () => ({ fetchEntity: mockFetchEntity }),
  isQId: (id: string) => /^[Qq]\d+$/.test(id),
  isPId: (id: string) => /^[Pp]\d+$/.test(id),
  normalizeId: (id: string) => id.toUpperCase(),
}));

const mockEntity = {
  id: 'Q76',
  type: 'item' as const,
  labels: {
    en: { language: 'en', value: 'Barack Obama' },
    de: { language: 'de', value: 'Barack Obama' },
  },
  descriptions: { en: { language: 'en', value: '44th U.S. President' } },
  aliases: {
    en: [
      { language: 'en', value: 'Obama' },
      { language: 'en', value: 'President Obama' },
    ],
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

  it('throws entity_not_found when service returns 404', async () => {
    mockFetchEntity.mockRejectedValue({ data: { status: 404 } });

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({ id: 'Q99999999' });
    await expect(wikidataGetEntity.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'entity_not_found' },
    });
  });

  it('re-throws non-404 service errors', async () => {
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

  it('throws entity_not_found for 404 HTTP status', async () => {
    mockFetchEntity.mockRejectedValue({ data: { status: 404 } });

    const ctx = createMockContext({ errors: wikidataGetEntity.errors });
    const input = wikidataGetEntity.input.parse({ id: 'Q76' });
    await expect(wikidataGetEntity.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'entity_not_found' },
    });
  });
});
