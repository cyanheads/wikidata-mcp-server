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

/**
 * A raw statement map spanning `count` properties (P1..Pn). Paired with the
 * `bulkyNormalize` mock below to drive a payload of a known, controllable size.
 */
const rawStatementsFor = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `P${i + 1}`,
      [
        {
          id: `P${i + 1}$stmt`,
          rank: 'normal',
          property: { id: `P${i + 1}`, data_type: 'string' },
          value: { type: 'string', content: 'x' },
        },
      ],
    ]),
  );

/** Normalizes each property to a statement of `valueBytes` — the size lever for overflow tests. */
const bulkyNormalize = (valueBytes: number) => (propertyId: string) => [
  {
    id: `${propertyId}$stmt`,
    rank: 'normal',
    property: propertyId,
    value: { type: 'string', value: 'x'.repeat(valueBytes) },
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
      kind: 'full' as const,
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
      kind: 'full' as const,
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
      kind: 'full' as const,
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

  /**
   * #17: an unfiltered call on a well-connected entity (Q30: 467 properties, 1,717
   * statements) produced a 519,077-character response — past the calling client's token
   * ceiling, so it failed outright rather than returning something usable. Over budget the
   * tool now outlines the P-IDs instead, and the caller re-calls through `properties`.
   */
  describe('overflow to outline', () => {
    it('returns statements inline when the set fits the budget', async () => {
      mockFetchStatements.mockResolvedValue(rawStatements);

      const ctx = createMockContext({ errors: wikidataGetStatements.errors });
      const input = wikidataGetStatements.input.parse({ id: 'Q76', resolve_labels: false });
      const result = await wikidataGetStatements.handler(input, ctx);

      expect(result.kind).toBe('full');
      expect(result.statements).toHaveProperty('P31');
      expect(result.sections).toBeUndefined();
      expect(result.retrieval_notice).toBeUndefined();
    });

    it('returns an outline instead of the statements for a high-cardinality entity', async () => {
      mockFetchStatements.mockResolvedValue(rawStatementsFor(100));
      mockNormalizeStatements.mockImplementation(bulkyNormalize(300));

      const ctx = createMockContext({ errors: wikidataGetStatements.errors });
      const input = wikidataGetStatements.input.parse({ id: 'Q30', resolve_labels: false });
      const result = await wikidataGetStatements.handler(input, ctx);

      expect(result.kind).toBe('outline');
      expect(result.statements).toBeUndefined();
      expect(result.sections).toHaveLength(100);
      // The response is now a fraction of the payload it replaced.
      expect(JSON.stringify(result).length).toBeLessThan(24_000);
    });

    it('outlines sections as P-IDs — the vocabulary the properties input takes', async () => {
      mockFetchStatements.mockResolvedValue(rawStatementsFor(100));
      mockNormalizeStatements.mockImplementation(bulkyNormalize(300));

      const ctx = createMockContext({ errors: wikidataGetStatements.errors });
      const input = wikidataGetStatements.input.parse({ id: 'Q30', resolve_labels: false });
      const result = await wikidataGetStatements.handler(input, ctx);

      for (const section of result.sections ?? []) {
        expect(section.name).toMatch(/^P\d+$/);
        expect(section.bytes).toBeGreaterThan(0);
      }
    });

    it('sorts outline sections largest first', async () => {
      mockFetchStatements.mockResolvedValue(rawStatementsFor(60));
      // P1 is made the outlier so the ordering is unambiguous.
      mockNormalizeStatements.mockImplementation((propertyId: string) =>
        bulkyNormalize(propertyId === 'P1' ? 5_000 : 400)(propertyId),
      );

      const ctx = createMockContext({ errors: wikidataGetStatements.errors });
      const input = wikidataGetStatements.input.parse({ id: 'Q30', resolve_labels: false });
      const result = await wikidataGetStatements.handler(input, ctx);

      const bytes = (result.sections ?? []).map((s) => s.bytes);
      expect(result.sections?.[0]?.name).toBe('P1');
      expect(bytes).toEqual([...bytes].sort((a, b) => b - a));
    });

    it('reports the honest counts alongside the outline', async () => {
      mockFetchStatements.mockResolvedValue(rawStatementsFor(100));
      mockNormalizeStatements.mockImplementation(bulkyNormalize(300));

      const ctx = createMockContext({ errors: wikidataGetStatements.errors });
      const input = wikidataGetStatements.input.parse({ id: 'Q30', resolve_labels: false });
      const result = await wikidataGetStatements.handler(input, ctx);

      // The gap the issue named: an oversized response carried no size signal at all.
      expect(result.id).toBe('Q30');
      expect(result.propertyCount).toBe(100);
      expect(result.statementCount).toBe(100);
      expect(result.labelsResolved).toBe(false);
    });

    it('points the re-call at the properties parameter, not a sections parameter', async () => {
      mockFetchStatements.mockResolvedValue(rawStatementsFor(100));
      mockNormalizeStatements.mockImplementation(bulkyNormalize(300));

      const ctx = createMockContext({ errors: wikidataGetStatements.errors });
      const input = wikidataGetStatements.input.parse({ id: 'Q30', resolve_labels: false });
      const result = await wikidataGetStatements.handler(input, ctx);

      // The tool has no `sections` input — the outline must name the lever it does have.
      expect(result.retrieval_notice).toContain('properties:[...]');
      expect(result.retrieval_notice).not.toContain('sections:[...]');
      expect(result.retrieval_notice).toContain('wikidata_get_statements');
    });

    it('returns the narrowed set inline when the caller re-calls with properties', async () => {
      mockFetchStatements.mockResolvedValue(rawStatementsFor(1));
      mockNormalizeStatements.mockImplementation(bulkyNormalize(300));

      const ctx = createMockContext({ errors: wikidataGetStatements.errors });
      const input = wikidataGetStatements.input.parse({
        id: 'Q30',
        properties: ['P1'],
        resolve_labels: false,
      });
      const result = await wikidataGetStatements.handler(input, ctx);

      expect(result.kind).toBe('full');
      expect(result.statements).toHaveProperty('P1');
    });

    /**
     * Documented, accepted limitation: below two sections there is nothing to choose
     * between, so an oversized single property comes back whole rather than costing a
     * round-trip whose only possible re-call returns the same bytes.
     */
    it('returns a single oversized property whole rather than outlining one section', async () => {
      mockFetchStatements.mockResolvedValue(rawStatementsFor(1));
      mockNormalizeStatements.mockImplementation(bulkyNormalize(40_000));

      const ctx = createMockContext({ errors: wikidataGetStatements.errors });
      const input = wikidataGetStatements.input.parse({ id: 'Q30', resolve_labels: false });
      const result = await wikidataGetStatements.handler(input, ctx);

      expect(result.kind).toBe('full');
      expect(result.statements).toHaveProperty('P1');
      expect(result.sections).toBeUndefined();
      expect(JSON.stringify(result).length).toBeGreaterThan(24_000);
    });

    it('format: renders the outline sections and the re-call notice', () => {
      const blocks = wikidataGetStatements.format!({
        id: 'Q30',
        kind: 'outline',
        propertyCount: 2,
        statementCount: 9,
        labelsResolved: false,
        sections: [
          { name: 'P2936', bytes: 66_428 },
          { name: 'P530', bytes: 61_629 },
        ],
        retrieval_notice: 'Re-call with properties:[...] — e.g. P2936, P530.',
      });
      const text = blocks.map((b) => (b as { text: string }).text).join('\n');

      expect(text).toContain('P2936');
      expect(text).toContain('66428');
      expect(text).toContain('properties:[...]');
      expect(text).toContain('2 sections available');
    });

    /**
     * format() must render each arm on field presence, never by branching on `kind` —
     * format-parity injects one sample with every optional field populated at once.
     */
    it('format: renders both arms when statements and sections are both present', () => {
      const blocks = wikidataGetStatements.format!({
        id: 'Q30',
        kind: 'full',
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
        sections: [{ name: 'P31', bytes: 120 }],
        retrieval_notice: 'Re-call with properties:[...].',
      });
      const text = blocks.map((b) => (b as { text: string }).text).join('\n');

      expect(text).toContain('human');
      expect(text).toContain('120');
      expect(text).toContain('Re-call with properties');
    });
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
