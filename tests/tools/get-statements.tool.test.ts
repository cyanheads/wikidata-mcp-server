/**
 * @fileoverview Tests for wikidata_get_statements tool.
 * @module tests/tools/get-statements.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataGetStatements } from '@/mcp-server/tools/definitions/get-statements.tool.js';

const mockFetchStatements = vi.fn();
const mockFetchLabels = vi.fn();
const mockNormalizeStatements = vi.fn();

vi.mock('@/services/wikidata/wikidata-rest-service.js', () => ({
  getWikidataRestService: () => ({
    fetchStatements: mockFetchStatements,
    fetchLabels: mockFetchLabels,
  }),
  isQId: (id: string) => /^[Qq]\d+$/.test(id),
  isPId: (id: string) => /^[Pp]\d+$/.test(id),
  normalizeId: (id: string) => id.toUpperCase(),
  normalizeStatements: (...args: Parameters<typeof mockNormalizeStatements>) =>
    mockNormalizeStatements(...args),
}));

const rawStatements = {
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
};

const normalizedStatements = [
  {
    id: 'stmt1',
    rank: 'normal',
    property: 'P31',
    value: { type: 'wikibase-item', qid: 'Q5', label: 'human' },
  },
];

describe('wikidataGetStatements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNormalizeStatements.mockReturnValue(normalizedStatements);
  });

  it('returns statements with label resolution', async () => {
    mockFetchStatements.mockResolvedValue(rawStatements);
    mockFetchLabels.mockResolvedValue({
      Q5: { labels: { en: 'human' }, descriptions: { en: 'any human' } },
    });

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: 'Q76' });
    const result = await wikidataGetStatements.handler(input, ctx);

    expect(result.id).toBe('Q76');
    expect(result.propertyCount).toBe(1);
    expect(result.statementCount).toBe(1);
    expect(result.labelsResolved).toBe(true);
    expect(result.statements).toHaveProperty('P31');
  });

  it('returns statements without label resolution when disabled', async () => {
    mockFetchStatements.mockResolvedValue(rawStatements);

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: 'Q76', resolve_labels: false });
    const result = await wikidataGetStatements.handler(input, ctx);

    expect(result.labelsResolved).toBe(false);
    expect(mockFetchLabels).not.toHaveBeenCalled();
  });

  it('filters to requested properties', async () => {
    mockFetchStatements.mockResolvedValue(rawStatements);
    mockFetchLabels.mockResolvedValue({});

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: 'Q76', properties: ['P31'] });
    const result = await wikidataGetStatements.handler(input, ctx);

    expect(mockFetchStatements).toHaveBeenCalledWith('Q76', ['P31'], expect.anything());
    expect(result.id).toBe('Q76');
  });

  it('throws invalid_id for malformed ID', async () => {
    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: 'notanid' });
    await expect(wikidataGetStatements.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('throws entity_not_found when service returns 404', async () => {
    mockFetchStatements.mockRejectedValue({ data: { statusCode: 404 } });

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: 'Q99999' });
    await expect(wikidataGetStatements.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'entity_not_found' },
    });
  });

  it('handles empty statements', async () => {
    mockFetchStatements.mockResolvedValue({});
    mockNormalizeStatements.mockReturnValue([]);

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: 'Q1', resolve_labels: false });
    const result = await wikidataGetStatements.handler(input, ctx);

    expect(result.propertyCount).toBe(0);
    expect(result.statementCount).toBe(0);
  });

  it('formats statements with property count and labels resolved', () => {
    const output = {
      id: 'Q76',
      statements: {
        P31: [
          {
            id: 'stmt1',
            rank: 'normal',
            property: 'P31',
            value: { type: 'wikibase-item', qid: 'Q5', label: 'human' },
          },
        ],
      },
      propertyCount: 1,
      statementCount: 1,
      labelsResolved: true,
    };
    const blocks = wikidataGetStatements.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Q76');
    expect(text).toContain('P31');
    expect(text).toContain('1');
    expect(text).toContain('true');
  });
});
