/**
 * @fileoverview Tests for wikidata_search_entities tool.
 * @module tests/tools/search-entities.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
        'display-description': { language: 'en', value: '44th U.S. President' },
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
    expect(result.query).toBe('Barack Obama');
    expect(result.type).toBe('item');
    expect(result.language).toBe('en');
  });

  it('returns empty results with a message when no matches found', async () => {
    mockSearch.mockResolvedValue([]);

    const ctx = createMockContext({ errors: wikidataSearchEntities.errors });
    const input = wikidataSearchEntities.input.parse({ query: 'xyzzy-nonexistent-term' });
    const result = await wikidataSearchEntities.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    expect(result.message).toBeDefined();
    expect(result.message).toContain('xyzzy-nonexistent-term');
  });

  it('supports property search type', async () => {
    mockSearch.mockResolvedValue([
      {
        id: 'P31',
        'display-label': { language: 'en', value: 'instance of' },
        'display-description': {
          language: 'en',
          value: 'that class of which this subject is a particular example and member',
        },
        match: { type: 'label', language: 'en' },
      },
    ]);

    const ctx = createMockContext({ errors: wikidataSearchEntities.errors });
    const input = wikidataSearchEntities.input.parse({ query: 'instance of', type: 'property' });
    const result = await wikidataSearchEntities.handler(input, ctx);

    expect(result.type).toBe('property');
    expect(result.results[0]!.id).toBe('P31');
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
      query: 'Barack Obama',
      type: 'item',
      language: 'en',
    };
    const blocks = wikidataSearchEntities.format!(output);
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Q76');
    expect(text).toContain('Barack Obama');
    expect(text).toContain('Barack Obama'); // query
  });

  it('formats empty results with message', () => {
    const output = {
      results: [],
      query: 'nothing',
      type: 'item',
      language: 'en',
      message: 'No items matched "nothing".',
    };
    const blocks = wikidataSearchEntities.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('nothing');
  });
});
