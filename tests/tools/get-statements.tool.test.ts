/**
 * @fileoverview Tests for wikidata_get_statements tool.
 * @module tests/tools/get-statements.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataGetStatements } from '@/mcp-server/tools/definitions/get-statements.tool.js';

const mockFetchStatements = vi.fn();
const mockFetchLabels = vi.fn();
const mockNormalizeStatements = vi.fn();

/**
 * Stub the service accessor and normalizeStatements; leave the module's pure helpers
 * (isEntityNotFoundError, isQId, normalizeId) real so the not-found predicate under test
 * is the one production uses.
 */
vi.mock('@/services/wikidata/wikidata-rest-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/wikidata/wikidata-rest-service.js')>()),
  getWikidataRestService: () => ({
    fetchStatements: mockFetchStatements,
    fetchLabels: mockFetchLabels,
  }),
  normalizeStatements: (...args: Parameters<typeof mockNormalizeStatements>) =>
    mockNormalizeStatements(...args),
}));

/** Mirrors what fetchWithTimeout rejects with on a non-2xx: an McpError carrying data.statusCode. */
const httpError = (statusCode: number) =>
  new McpError(
    statusCode === 404 ? JsonRpcErrorCode.NotFound : JsonRpcErrorCode.InvalidParams,
    `Fetch failed. Status: ${statusCode}`,
    { statusCode },
  );

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

  it('accepts a lowercase P-ID, normalizing before the format check', async () => {
    mockFetchStatements.mockResolvedValue(rawStatements);

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({
      id: 'Q76',
      properties: ['p31'],
      resolve_labels: false,
    });
    await wikidataGetStatements.handler(input, ctx);

    expect(mockFetchStatements).toHaveBeenCalledWith('Q76', ['p31'], expect.anything());
  });

  it('returns an empty result for a well-formed but unassigned P-ID', async () => {
    // Upstream answers an unassigned P-ID with 200 and no statements — an honest
    // "this entity has no such property", not an input error.
    mockFetchStatements.mockResolvedValue({});
    mockNormalizeStatements.mockReturnValue([]);

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({
      id: 'Q76',
      properties: ['P9999999'],
      resolve_labels: false,
    });
    const result = await wikidataGetStatements.handler(input, ctx);

    expect(result.propertyCount).toBe(0);
    expect(result.statementCount).toBe(0);
    expect(mockFetchStatements).toHaveBeenCalledWith('Q76', ['P9999999'], expect.anything());
  });

  it('throws invalid_property for a malformed properties entry', async () => {
    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: 'Q76', properties: ['NOTAPROP'] });
    await expect(wikidataGetStatements.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_property', invalid: ['NOTAPROP'] },
    });
    expect(mockFetchStatements).not.toHaveBeenCalled();
  });

  it('throws invalid_property for a mixed batch instead of dropping the bad entry', async () => {
    mockFetchStatements.mockResolvedValue(rawStatements);

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({
      id: 'Q76',
      properties: ['P31', 'NOTAPROP'],
    });
    await expect(wikidataGetStatements.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_property', invalid: ['NOTAPROP'] },
    });
    expect(mockFetchStatements).not.toHaveBeenCalled();
  });

  it('regression: a malformed property on a valid entity is never reported as entity_not_found', async () => {
    /**
     * The REST `?property=` filter answers a malformed P-ID with the same 400 an out-of-range
     * entity ID draws, so isEntityNotFoundError() cannot tell them apart. Arming the mock with
     * that 400 means dropping the up-front validation re-breaks this test: the fetch would run
     * and Q76 — a real entity — would be reported missing.
     */
    mockFetchStatements.mockRejectedValue(httpError(400));

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: 'Q76', properties: ['NOTAPROP'] });
    const err = await wikidataGetStatements.handler(input, ctx).catch((e: unknown) => e);

    expect((err as McpError).data).toMatchObject({ reason: 'invalid_property' });
    expect((err as McpError).data).not.toMatchObject({ reason: 'entity_not_found' });
    expect((err as McpError).message).toContain('NOTAPROP');
    expect(mockFetchStatements).not.toHaveBeenCalled();
  });

  it('throws invalid_id for malformed ID', async () => {
    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: 'notanid' });
    await expect(wikidataGetStatements.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('throws entity_not_found for an unassigned ID (404)', async () => {
    mockFetchStatements.mockRejectedValue(httpError(404));

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: 'Q99999999' });
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

  it('throws entity_not_found for an out-of-range ID (400)', async () => {
    mockFetchStatements.mockRejectedValue(httpError(400));

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: 'Q999999999999' });
    await expect(wikidataGetStatements.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'entity_not_found' },
    });
  });

  it('re-throws service errors that are not a not-found', async () => {
    mockFetchStatements.mockRejectedValue(new Error('Service timeout'));

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: 'Q76', resolve_labels: false });
    await expect(wikidataGetStatements.handler(input, ctx)).rejects.toThrow('Service timeout');
  });

  it('format: preferred-rank statement includes star indicator', () => {
    const output = {
      id: 'Q76',
      statements: {
        P569: [
          {
            id: 'stmt2',
            rank: 'preferred',
            property: 'P569',
            value: { type: 'time', time: '+1961-08-04T00:00:00Z' },
          },
        ],
      },
      propertyCount: 1,
      statementCount: 1,
      labelsResolved: false,
    };
    const blocks = wikidataGetStatements.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('★');
    expect(text).toContain('+1961-08-04T00:00:00Z');
  });

  it('format: deprecated-rank statement includes strikethrough indicator', () => {
    const output = {
      id: 'Q76',
      statements: {
        P569: [
          {
            id: 'stmt3',
            rank: 'deprecated',
            property: 'P569',
            value: { type: 'time', time: '+1960-01-01T00:00:00Z' },
          },
        ],
      },
      propertyCount: 1,
      statementCount: 1,
      labelsResolved: false,
    };
    const blocks = wikidataGetStatements.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('deprecated');
  });

  it('security: injection attempt in ID is rejected as invalid', async () => {
    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: '"; rm -rf / --' });
    await expect(wikidataGetStatements.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
    expect(mockFetchStatements).not.toHaveBeenCalled();
  });

  it('security: no env secret appears in statements output', async () => {
    process.env['TEST_STMT_SECRET'] = 'stmt_secret_ghi321';
    mockFetchStatements.mockResolvedValue({});
    mockNormalizeStatements.mockReturnValue([]);

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: 'Q1', resolve_labels: false });
    const result = await wikidataGetStatements.handler(input, ctx);

    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('stmt_secret_ghi321');
    delete process.env['TEST_STMT_SECRET'];
  });
});
