/**
 * @fileoverview Tests for wikidata_search_entities tool.
 * @module tests/tools/search-entities.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataSearchEntities } from '@/mcp-server/tools/definitions/search-entities.tool.js';

const mockSearch = vi.fn();

vi.mock('@/services/wikidata/wikidata-rest-service.js', () => ({
  getWikidataRestService: () => ({ search: mockSearch }),
}));

describe('wikidataSearchEntities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns results for a valid query', async () => {
    mockSearch.mockResolvedValue([
      {
        id: 'Q76',
        'display-label': { language: 'en', value: 'Barack Obama' },
        description: { language: 'en', value: '44th U.S. President' },
        match: { type: 'label', language: 'en' },
      },
    ]);

    const ctx = createMockContext({ errors: wikidataSearchEntities.errors });
    const input = wikidataSearchEntities.input.parse({ query: 'Barack Obama' });
    const result = await wikidataSearchEntities.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.id).toBe('Q76');
    expect(result.results[0]!.label).toBe('Barack Obama');
    expect(result.results[0]!.description).toBe('44th U.S. President');
    expect(result.results[0]!.match.type).toBe('label');

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('Barack Obama');
    expect(enrichment.searchType).toBe('item');
    expect(enrichment.language).toBe('en');
    expect(enrichment.shown).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('returns empty results with a notice enrichment when no matches found', async () => {
    mockSearch.mockResolvedValue([]);

    const ctx = createMockContext({ errors: wikidataSearchEntities.errors });
    const input = wikidataSearchEntities.input.parse({ query: 'xyzzy-nonexistent-term' });
    const result = await wikidataSearchEntities.handler(input, ctx);

    expect(result.results).toHaveLength(0);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('xyzzy-nonexistent-term');
    expect(enrichment.shown).toBe(0);
  });

  it('supports property search type', async () => {
    mockSearch.mockResolvedValue([
      {
        id: 'P31',
        'display-label': { language: 'en', value: 'instance of' },
        description: {
          language: 'en',
          value: 'that class of which this subject is a particular example and member',
        },
        match: { type: 'label', language: 'en' },
      },
    ]);

    const ctx = createMockContext({ errors: wikidataSearchEntities.errors });
    const input = wikidataSearchEntities.input.parse({ query: 'instance of', type: 'property' });
    const result = await wikidataSearchEntities.handler(input, ctx);

    expect(result.results[0]!.id).toBe('P31');

    const enrichment = getEnrichment(ctx);
    expect(enrichment.searchType).toBe('property');
  });

  it('handles sparse search result (missing optional fields)', async () => {
    mockSearch.mockResolvedValue([
      {
        id: 'Q999',
        // no display-label, no display-description, no match
      },
    ]);

    const ctx = createMockContext({ errors: wikidataSearchEntities.errors });
    const input = wikidataSearchEntities.input.parse({ query: 'sparse result' });
    const result = await wikidataSearchEntities.handler(input, ctx);

    expect(result.results[0]!.label).toBe('');
    expect(result.results[0]!.description).toBe('');
    expect(result.results[0]!.match.type).toBe('label');
  });

  it('formats output with IDs and labels', () => {
    const output = {
      results: [
        {
          id: 'Q76',
          label: 'Barack Obama',
          description: '44th President',
          match: { type: 'label', language: 'en' },
        },
      ],
    };
    const blocks = wikidataSearchEntities.format!(output);
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Q76');
    expect(text).toContain('Barack Obama');
  });

  it('formats empty results list', () => {
    const output = { results: [] };
    const blocks = wikidataSearchEntities.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0');
  });

  it('pagination: offset and limit are forwarded to service', async () => {
    mockSearch.mockResolvedValue([]);

    const ctx = createMockContext({ errors: wikidataSearchEntities.errors });
    const input = wikidataSearchEntities.input.parse({ query: 'test', limit: 20, offset: 40 });
    await wikidataSearchEntities.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith('test', 'item', 'en', 20, 40, expect.anything());
  });

  it('input validation: limit above maximum (51) is rejected by Zod', () => {
    expect(() => wikidataSearchEntities.input.parse({ query: 'test', limit: 51 })).toThrow();
  });

  it('input validation: limit below minimum (0) is rejected by Zod', () => {
    expect(() => wikidataSearchEntities.input.parse({ query: 'test', limit: 0 })).toThrow();
  });

  it('input validation: negative offset is rejected by Zod', () => {
    expect(() => wikidataSearchEntities.input.parse({ query: 'test', offset: -1 })).toThrow();
  });

  it('input validation: empty query is rejected by Zod', () => {
    expect(() => wikidataSearchEntities.input.parse({ query: '' })).toThrow();
  });

  it('security: no env secret appears in search result output', async () => {
    process.env['TEST_SEARCH_SECRET'] = 'search_secret_xyz789';
    mockSearch.mockResolvedValue([
      {
        id: 'Q76',
        'display-label': { language: 'en', value: 'Barack Obama' },
        description: { language: 'en', value: '44th U.S. President' },
        match: { type: 'label', language: 'en' },
      },
    ]);

    const ctx = createMockContext({ errors: wikidataSearchEntities.errors });
    const input = wikidataSearchEntities.input.parse({ query: 'Barack Obama' });
    const result = await wikidataSearchEntities.handler(input, ctx);

    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('search_secret_xyz789');
    delete process.env['TEST_SEARCH_SECRET'];
  });

  it('security: injection attempt in query is forwarded as-is and not re-executed', async () => {
    mockSearch.mockResolvedValue([]);

    const ctx = createMockContext({ errors: wikidataSearchEntities.errors });
    const injection = "<script>alert('xss')</script>";
    const input = wikidataSearchEntities.input.parse({ query: injection });
    const result = await wikidataSearchEntities.handler(input, ctx);

    // Handler should not crash and result should be empty
    expect(result.results).toHaveLength(0);
    expect(mockSearch).toHaveBeenCalledWith(injection, 'item', 'en', 10, 0, expect.anything());
  });
});
