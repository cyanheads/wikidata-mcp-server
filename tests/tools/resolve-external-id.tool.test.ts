/**
 * @fileoverview Tests for wikidata_resolve_external_id tool.
 * @module tests/tools/resolve-external-id.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataResolveExternalId } from '@/mcp-server/tools/definitions/resolve-external-id.tool.js';

const mockQuery = vi.fn();

vi.mock('@/services/wikidata/wikidata-sparql-service.js', () => ({
  getWikidataSparqlService: () => ({ query: mockQuery }),
}));

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
});
