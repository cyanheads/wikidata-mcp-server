/**
 * @fileoverview Tests for wikidata_get_statements tool.
 * @module tests/tools/get-statements.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataGetStatements } from '@/mcp-server/tools/definitions/get-statements.tool.js';
import { inlineText } from '../helpers/markdown.js';

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
    fetchStatements: async (
      ...args: Parameters<
        import('@/services/wikidata/wikidata-rest-service.js').WikidataRestService['fetchStatements']
      >
    ) => ({ id: args[0], statements: await mockFetchStatements(...args) }),
    fetchLabels: async (...args: Parameters<typeof mockFetchLabels>) => ({
      entities: await mockFetchLabels(...args),
      unrecognizedLanguages: [],
    }),
  }),
  normalizeStatements: (...args: Parameters<typeof mockNormalizeStatements>) =>
    mockNormalizeStatements(...args),
}));

/** Mirrors what fetchWithTimeout rejects with on a non-2xx: an McpError carrying data.status. */
const httpError = (status: number) =>
  new McpError(
    status === 404 ? JsonRpcErrorCode.NotFound : JsonRpcErrorCode.InvalidParams,
    `Fetch failed. Status: ${status}`,
    { status },
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

type StatementsOutput = Parameters<NonNullable<typeof wikidataGetStatements.format>>[0];

/**
 * Formats a fixture that tests statement rendering alone, filling the per-call pipeline fields
 * (rank, totals, the page count) it does not exercise.
 */
const formatFixture = (
  output: Omit<StatementsOutput, 'rank' | 'propertyTotals' | 'returnedCount'>,
) =>
  wikidataGetStatements.format!({ rank: 'all', propertyTotals: {}, returnedCount: 0, ...output });

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
    const err = await Promise.resolve(wikidataGetStatements.handler(input, ctx)).catch(
      (error: unknown) => error,
    );

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
    const blocks = formatFixture(output);
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
    const blocks = formatFixture(output);
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
    const blocks = formatFixture(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('deprecated');
  });

  it('format: counts references and groups each reference’s parts under it (#38)', () => {
    const part = (property: string, qid: string) => ({
      property,
      value: { type: 'wikibase-item' as const, qid },
    });
    const retrieved = (time: string) => ({
      property: 'P813',
      value: { type: 'time' as const, time, precision: 11 },
    });
    const output = {
      id: 'Q42',
      kind: 'full' as const,
      statements: {
        P31: [
          {
            id: 'stmt1',
            rank: 'normal',
            property: 'P31',
            value: { type: 'wikibase-item' as const, qid: 'Q5' },
            references: [
              {
                parts: [
                  part('P248', 'Q19938912'),
                  { property: 'P268', value: { type: 'external-id' as const, value: '11888092r' } },
                  part('P407', 'Q150'),
                  retrieved('+2022-10-09T00:00:00Z'),
                ],
              },
              {
                parts: [
                  part('P248', 'Q36578'),
                  { property: 'P227', value: { type: 'external-id' as const, value: '119033364' } },
                  part('P407', 'Q188'),
                  retrieved('+2022-10-09T00:00:00Z'),
                ],
              },
              {
                parts: [
                  part('P248', 'Q50358336'),
                  { property: 'P950', value: { type: 'external-id' as const, value: 'XX1149955' } },
                  part('P407', 'Q1321'),
                  retrieved('+2024-02-17T00:00:00Z'),
                ],
              },
            ],
          },
        ],
      },
      propertyCount: 1,
      statementCount: 1,
      labelsResolved: false,
    };
    const text = (formatFixture(output)[0] as { text: string }).text;

    expect(text).toContain('**References (3):**');
    expect(text).not.toContain(' of 12');
    // Each reference heads its own block, and its four parts sit indented beneath it.
    const block = (n: number) => text.split(`    - Reference ${n}\n`)[1]?.split('\n    - ')[0];
    expect(block(1)).toBe(
      [
        '      - P248: Q19938912',
        '      - P268: 11888092r',
        '      - P407: Q150',
        '      - P813: +2022-10-09T00:00:00Z (precision 11: day)',
      ].join('\n'),
    );
    expect(block(2)).toContain('      - P227: 119033364');
    expect(block(3)).toContain('      - P950: XX1149955');
    expect(block(3)).toContain('      - P813: +2024-02-17T00:00:00Z (precision 11: day)');
  });

  /**
   * #28: content[] carried the first 3 reference parts per statement and no statement id or
   * value precision. Run through the real normalizer and runToolContract, counting entries on
   * both surfaces.
   */
  it('carries every statement id, reference, part, and precision on both surfaces (#28)', async () => {
    const actual = await vi.importActual<
      typeof import('@/services/wikidata/wikidata-rest-service.js')
    >('@/services/wikidata/wikidata-rest-service.js');
    mockNormalizeStatements.mockImplementation(actual.normalizeStatements);
    const snak = (property: string, data_type: string, content: unknown) => ({
      property: { id: property, data_type },
      value: { type: 'value', content },
    });
    const day = (time: string) => ({ time, precision: 11, calendarmodel: 'Q1985727' });
    const reference = (n: number) => ({
      hash: `h${n}`,
      parts: [
        snak('P248', 'wikibase-item', `Q${100 + n}`),
        snak('P854', 'url', `https://example.org/${n}`),
        snak('P813', 'time', day('+2022-10-09T00:00:00Z')),
        snak('P1476', 'monolingualtext', { text: `Source ${n}`, language: 'en' }),
      ],
    });
    mockFetchStatements.mockResolvedValue({
      P569: [1, 2].map((s) => ({
        id: `Q42$birth-${s}`,
        rank: s === 1 ? 'preferred' : 'normal',
        ...snak('P569', 'time', {
          time: '+1952-03-11T00:00:00Z',
          precision: 11 - s,
          ...(s === 2 && { calendarmodel: 'http://www.wikidata.org/entity/Q999999999' }),
        }),
        qualifiers: [
          snak('P1480', 'wikibase-item', 'Q5727902'),
          snak('P580', 'time', {
            time: '+1616-04-23T00:00:00Z',
            precision: 11,
            calendarmodel: 'http://www.wikidata.org/entity/Q1985786',
          }),
        ],
        references: Array.from({ length: 5 }, (_, i) => reference(s * 10 + i)),
      })),
      P625: [
        {
          id: 'Q42$coord',
          rank: 'normal',
          ...snak('P625', 'globe-coordinate', {
            latitude: 51.5,
            longitude: -0.1,
            precision: 0.0001,
            globe: 'http://www.wikidata.org/entity/Q2',
          }),
        },
      ],
    });

    const result = await runToolContract(wikidataGetStatements, {
      id: 'Q42',
      resolve_labels: false,
    });
    const statements = (
      result.structuredContent as {
        statements: Record<
          string,
          Array<{
            id: string;
            qualifiers?: unknown[];
            references?: Array<{ parts: unknown[] }>;
          }>
        >;
      }
    ).statements;
    const all = Object.values(statements).flat();
    const lines = result.content.flatMap((b) => (b as { text: string }).text.split('\n'));

    const count = (re: RegExp) => lines.filter((line) => re.test(line)).length;
    const references = all.flatMap((s) => s.references ?? []);
    expect(all).toHaveLength(3);
    expect(references).toHaveLength(10);
    expect(references.flatMap((r) => r.parts)).toHaveLength(40);
    expect(count(/^ {2}- id: /)).toBe(all.length);
    for (const s of all) expect(lines).toContain(`  - id: ${s.id}`);
    expect(count(/^ {4}- Reference \d+$/)).toBe(references.length);
    expect(count(/^ {6}- P\d+: /)).toBe(40);
    expect(count(/^ {2}- P\d+: /)).toBe(all.flatMap((s) => s.qualifiers ?? []).length);
    expect(lines).toContain('- +1952-03-11T00:00:00Z (precision 10: month) ★');
    expect(statements.P569?.[1]).toMatchObject({ value: { calendarmodel: 'Q999999999' } });
    expect(lines).toContain('- +1952-03-11T00:00:00Z (precision 9: year), calendar: Q999999999');
    expect(lines).toContain('- 51.5, -0.1 (precision 0.0001), globe: Earth (Q2)');
    expect(
      count(
        /^ {6}- P813: \+2022-10-09T00:00:00Z \(precision 11: day\), calendar: Gregorian \(Q1985727\)$/,
      ),
    ).toBe(10);
    expect(lines).toContain(
      '  - P580: +1616-04-23T00:00:00Z (precision 11: day), calendar: Julian (Q1985786)',
    );
    expect(statements.P625?.[0]).toMatchObject({ value: { globe: 'Q2' } });
    expect(statements.P569?.[0]?.qualifiers?.[1]).toMatchObject({
      value: { calendarmodel: 'Q1985786' },
    });
    expect(references[0]?.parts[2]).toMatchObject({ value: { calendarmodel: 'Q1985727' } });
  });

  it('format: renders the time and coordinate precision, and a coordinate without one', () => {
    const output = {
      id: 'Q1',
      kind: 'full' as const,
      statements: {
        P580: [
          {
            id: 'Q1$a',
            rank: 'normal',
            property: 'P580',
            value: { type: 'time' as const, time: '-13798000000-00-00T00:00:00Z', precision: 3 },
          },
          {
            id: 'Q1$b',
            rank: 'normal',
            property: 'P580',
            value: { type: 'time' as const, time: '+2001-00-00T00:00:00Z', precision: 15 },
          },
        ],
        P625: [
          {
            id: 'Q1$c',
            rank: 'normal',
            property: 'P625',
            value: { type: 'globe-coordinate' as const, latitude: 1, longitude: 2, globe: 'Q405' },
          },
        ],
      },
      propertyCount: 2,
      statementCount: 3,
      labelsResolved: false,
    };
    const lines = (formatFixture(output)[0] as { text: string }).text.split('\n');

    expect(lines).toContain('- -13798000000-00-00T00:00:00Z (precision 3: million years)');
    expect(lines).toContain('- +2001-00-00T00:00:00Z (precision 15)');
    expect(lines).toContain('- 1, 2, globe: Q405');
    expect(lines).toContain('  - id: Q1$c');
  });

  it('format: renders somevalue/novalue as "unknown value"/"no value" at every level (#39)', () => {
    const output = {
      id: 'Q30',
      kind: 'full' as const,
      statements: {
        P2997: [
          {
            id: 's1',
            rank: 'normal',
            property: 'P2997',
            value: { type: 'somevalue' as const },
            qualifiers: [{ property: 'P582', value: { type: 'novalue' as const } }],
            references: [{ parts: [{ property: 'P248', value: { type: 'somevalue' as const } }] }],
          },
          { id: 's2', rank: 'normal', property: 'P2997', value: { type: 'novalue' as const } },
        ],
      },
      propertyCount: 1,
      statementCount: 2,
      labelsResolved: true,
    };
    const lines = (formatFixture(output)[0] as { text: string }).text.split('\n');

    expect(lines).toContain('- unknown value');
    expect(lines).toContain('  - P582: no value');
    expect(lines).toContain('      - P248: unknown value');
    expect(lines).toContain('- no value');
    expect(lines).not.toContain('- ');
  });

  /** The snaks still name their properties, so the batch carries those P-IDs (#56) and no Q-ID. */
  it('makes no Q-ID label lookup for an item-typed somevalue/novalue (#39)', async () => {
    mockFetchLabels.mockResolvedValue({});
    mockFetchStatements.mockResolvedValue({
      P50: [
        {
          id: 's',
          rank: 'normal',
          property: { id: 'P50', data_type: 'wikibase-item' },
          value: { type: 'somevalue' },
          qualifiers: [
            { property: { id: 'P1545', data_type: 'wikibase-item' }, value: { type: 'novalue' } },
          ],
          references: [
            {
              parts: [
                {
                  property: { id: 'P248', data_type: 'wikibase-item' },
                  value: { type: 'somevalue' },
                },
              ],
            },
          ],
        },
      ],
    });

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const input = wikidataGetStatements.input.parse({ id: 'Q1', properties: ['P50'] });
    await wikidataGetStatements.handler(input, ctx);

    const [requested] = mockFetchLabels.mock.calls[0] as [string[]];
    expect([...requested].sort()).toEqual(['P1545', 'P248', 'P50']);
  });

  describe('nested label batch (#30, #37)', () => {
    const item = (property: string, qid: string) => ({
      property: { id: property, data_type: 'wikibase-item' },
      value: { type: 'value', content: qid },
    });
    const area = (property: string, unit: string) => ({
      property: { id: property, data_type: 'quantity' },
      value: { type: 'value', content: { amount: '+105.4', unit } },
    });
    const km2 = 'http://www.wikidata.org/entity/Q712226';
    const raw = {
      P31: [
        {
          id: 's1',
          rank: 'normal',
          ...item('P31', 'Q5'),
          qualifiers: [
            item('P805', 'Q42395533'),
            area('P2046', 'http://www.wikidata.org/entity/Q11573'),
          ],
          references: [
            { parts: [item('P248', 'Q19938912'), item('P407', 'Q150')] },
            { parts: [item('P248', 'Q19938912'), area('P2046', km2)] },
          ],
        },
      ],
      P2046: [
        { id: 's2', rank: 'normal', ...area('P2046', km2) },
        { id: 's3', rank: 'normal', ...area('P2046', '1') },
      ],
    };

    it('sends main, qualifier, reference-part, and unit QIDs in one deduplicated label call', async () => {
      mockFetchStatements.mockResolvedValue(raw);
      mockFetchLabels.mockResolvedValue({});

      const ctx = createMockContext({ errors: wikidataGetStatements.errors });
      const input = wikidataGetStatements.input.parse({ id: 'Q42', language: 'de' });
      await wikidataGetStatements.handler(input, ctx);

      expect(mockFetchLabels).toHaveBeenCalledTimes(1);
      const [ids, languages] = mockFetchLabels.mock.calls[0] as [string[], string[]];
      // The same batch carries the P-IDs the statements name (#56).
      expect([...ids].sort()).toEqual(
        [
          ...['Q5', 'Q42395533', 'Q11573', 'Q19938912', 'Q150', 'Q712226'],
          ...['P31', 'P805', 'P2046', 'P248', 'P407'],
        ].sort(),
      );
      expect(languages).toEqual(['de']);
    });

    it('passes the resolved label map to normalization', async () => {
      mockFetchStatements.mockResolvedValue(raw);
      mockFetchLabels.mockResolvedValue({
        Q19938912: { labels: { en: 'BnF authorities' }, descriptions: {} },
        Q712226: { labels: { en: 'square kilometre' }, descriptions: {} },
      });

      const ctx = createMockContext({ errors: wikidataGetStatements.errors });
      await wikidataGetStatements.handler(wikidataGetStatements.input.parse({ id: 'Q42' }), ctx);

      expect(mockNormalizeStatements).toHaveBeenCalledWith('P31', raw.P31, {
        Q19938912: 'BnF authorities',
        Q712226: 'square kilometre',
      });
    });

    it('end to end through the real normalizer: labels land at every level in both surfaces', async () => {
      const actual = await vi.importActual<
        typeof import('@/services/wikidata/wikidata-rest-service.js')
      >('@/services/wikidata/wikidata-rest-service.js');
      mockNormalizeStatements.mockImplementation(actual.normalizeStatements);
      mockFetchStatements.mockResolvedValue(raw);
      mockFetchLabels.mockResolvedValue({
        Q5: { labels: { en: 'human' }, descriptions: {} },
        Q42395533: { labels: { en: 'example' }, descriptions: {} },
        Q19938912: { labels: { en: 'BnF authorities' }, descriptions: {} },
        Q712226: { labels: { en: 'square kilometre' }, descriptions: {} },
      });

      const ctx = createMockContext({ errors: wikidataGetStatements.errors });
      const result = wikidataGetStatements.output.parse(
        await wikidataGetStatements.handler(wikidataGetStatements.input.parse({ id: 'Q42' }), ctx),
      );
      const [p31] = (result.statements?.P31 ?? []) as Array<{
        qualifiers: Array<{ value: unknown }>;
        references: Array<{ parts: Array<{ value: unknown }> }>;
      }>;

      expect(p31?.qualifiers[0]?.value).toEqual({
        type: 'wikibase-item',
        qid: 'Q42395533',
        label: 'example',
      });
      expect(p31?.references).toHaveLength(2);
      expect(p31?.references[0]?.parts[0]?.value).toEqual({
        type: 'wikibase-item',
        qid: 'Q19938912',
        label: 'BnF authorities',
      });
      expect(p31?.references[1]?.parts[1]?.value).toEqual({
        type: 'quantity',
        amount: '+105.4',
        unit: 'http://www.wikidata.org/entity/Q712226',
        unitLabel: 'square kilometre',
      });

      const lines = (wikidataGetStatements.format!(result)[0] as { text: string }).text.split('\n');
      expect(lines).toContain('  - P805: example (Q42395533)');
      expect(lines).toContain('  - P2046: +105.4 (Q11573)');
      expect(lines).toContain('  - **References (2):**');
      expect(lines).toContain('      - P248: BnF authorities (Q19938912)');
      expect(lines).toContain('      - P407: Q150');
      expect(lines).toContain('      - P2046: +105.4 square kilometre (Q712226)');
      expect(lines).toContain('- +105.4');
    });

    it('makes no label call when resolve_labels is false', async () => {
      mockFetchStatements.mockResolvedValue(raw);

      const ctx = createMockContext({ errors: wikidataGetStatements.errors });
      const input = wikidataGetStatements.input.parse({ id: 'Q42', resolve_labels: false });
      const result = await wikidataGetStatements.handler(input, ctx);

      expect(mockFetchLabels).not.toHaveBeenCalled();
      expect(mockNormalizeStatements).toHaveBeenCalledWith('P31', raw.P31, {});
      expect(result.labelsResolved).toBe(false);
    });
  });

  it('format: renders a resolved qualifier or reference-part label as "label (QID)" (#30)', () => {
    const output = {
      id: 'Q42',
      kind: 'full' as const,
      statements: {
        P31: [
          {
            id: 's1',
            rank: 'normal',
            property: 'P31',
            value: { type: 'wikibase-item' as const, qid: 'Q5', label: 'human' },
            qualifiers: [
              {
                property: 'P805',
                value: { type: 'wikibase-item' as const, qid: 'Q42395533', label: 'example' },
              },
            ],
            references: [
              {
                parts: [
                  {
                    property: 'P248',
                    value: { type: 'wikibase-item' as const, qid: 'Q19938912', label: 'BnF' },
                  },
                  { property: 'P407', value: { type: 'wikibase-item' as const, qid: 'Q150' } },
                ],
              },
            ],
          },
        ],
      },
      propertyCount: 1,
      statementCount: 1,
      labelsResolved: true,
    };
    const lines = (formatFixture(output)[0] as { text: string }).text.split('\n');

    expect(lines).toContain('- human (Q5)');
    expect(lines).toContain('  - P805: example (Q42395533)');
    expect(lines).toContain('      - P248: BnF (Q19938912)');
    expect(lines).toContain('      - P407: Q150');
  });

  it('format: renders quantity units by label and QID, never the entity URI (#37)', () => {
    const quantity = (unit?: string, unitLabel?: string) => ({
      type: 'quantity' as const,
      amount: '+105.4',
      ...(unit ? { unit } : {}),
      ...(unitLabel ? { unitLabel } : {}),
    });
    const km2 = 'http://www.wikidata.org/entity/Q712226';
    const output = {
      id: 'Q90',
      kind: 'full' as const,
      statements: {
        P2046: [
          {
            id: 's1',
            rank: 'normal',
            property: 'P2046',
            value: quantity(km2, 'square kilometre'),
            qualifiers: [{ property: 'P2046', value: quantity(km2) }],
            references: [
              { parts: [{ property: 'P2046', value: quantity(km2, 'square kilometre') }] },
            ],
          },
          { id: 's2', rank: 'normal', property: 'P2046', value: quantity(km2) },
          { id: 's3', rank: 'normal', property: 'P2046', value: quantity('1') },
        ],
      },
      propertyCount: 1,
      statementCount: 3,
      labelsResolved: true,
    };
    const text = (formatFixture(output)[0] as { text: string }).text;
    const lines = text.split('\n');

    expect(lines).toContain('- +105.4 square kilometre (Q712226)');
    expect(lines).toContain('  - P2046: +105.4 (Q712226)');
    expect(lines).toContain('      - P2046: +105.4 square kilometre (Q712226)');
    expect(lines).toContain('- +105.4 (Q712226)');
    expect(lines).toContain('- +105.4');
    expect(text).not.toContain('http://www.wikidata.org/entity/');
  });

  it('format: renders a bounded quantity as "amount [lower, upper]" at every level (#44)', () => {
    const km = 'http://www.wikidata.org/entity/Q828224';
    const radius = (unitLabel?: string) => ({
      type: 'quantity' as const,
      amount: '+6378.137',
      unit: km,
      upperBound: '+6378.138',
      lowerBound: '+6378.136',
      ...(unitLabel ? { unitLabel } : {}),
    });
    const output = {
      id: 'Q2',
      kind: 'full' as const,
      statements: {
        P2120: [
          {
            id: 's1',
            rank: 'normal',
            property: 'P2120',
            value: radius('kilometre'),
            qualifiers: [{ property: 'P2120', value: radius() }],
            references: [{ parts: [{ property: 'P2120', value: radius('kilometre') }] }],
          },
          {
            id: 's2',
            rank: 'normal',
            property: 'P2120',
            value: {
              type: 'quantity',
              amount: '+5',
              unit: '1',
              upperBound: '+6',
              lowerBound: '+4',
            },
          },
          {
            id: 's3',
            rank: 'normal',
            property: 'P2120',
            value: { type: 'quantity', amount: '+6339.9', unit: km, unitLabel: 'kilometre' },
          },
          {
            id: 's4',
            rank: 'normal',
            property: 'P2120',
            value: { type: 'quantity', amount: '+7', unit: '1', upperBound: '+8' },
          },
        ],
      },
      propertyCount: 1,
      statementCount: 4,
      labelsResolved: true,
    };
    const lines = (formatFixture(output)[0] as { text: string }).text.split('\n');

    const displayed = lines.map(inlineText);
    expect(displayed).toContain('- +6378.137 [+6378.136, +6378.138] kilometre (Q828224)');
    expect(displayed).toContain('  - P2120: +6378.137 [+6378.136, +6378.138] (Q828224)');
    expect(displayed).toContain(
      '      - P2120: +6378.137 [+6378.136, +6378.138] kilometre (Q828224)',
    );
    expect(displayed).toContain('- +5 [+4, +6]');
    expect(displayed).toContain('- +6339.9 kilometre (Q828224)');
    expect(displayed).toContain('- +7 [?, +8]');
  });

  it('format: renders non-item entity-ID values as the bare ID at every level (#43)', () => {
    const entityId = (entityType: string, id: string) => ({ type: 'entity-id', entityType, id });
    const output = {
      id: 'P31',
      kind: 'full' as const,
      statements: {
        P1659: [
          {
            id: 's1',
            rank: 'normal',
            property: 'P1659',
            value: entityId('property', 'P279'),
            qualifiers: [
              { property: 'P5188', value: entityId('lexeme', 'L37633') },
              { property: 'P5189', value: entityId('form', 'L229416-F1') },
            ],
            references: [
              {
                parts: [
                  { property: 'P5972', value: entityId('sense', 'L1452908-S1') },
                  { property: 'P12861', value: entityId('entity-schema', 'E10') },
                ],
              },
            ],
          },
        ],
      },
      propertyCount: 1,
      statementCount: 1,
      labelsResolved: true,
    };
    const text = (formatFixture(output)[0] as { text: string }).text;
    const lines = text.split('\n');

    expect(lines).toContain('- P279');
    expect(lines).toContain('  - P5188: L37633');
    expect(lines).toContain('  - P5189: L229416-F1');
    expect(lines).toContain('      - P5972: L1452908-S1');
    expect(lines).toContain('      - P12861: E10');
    expect(text).not.toContain('"');
  });

  /** Its P-IDs go to the label batch (#56); with none resolved, the value renders bare. */
  it('end to end: a wikibase-property value is typed, unlabelled, and bare in both surfaces (#43)', async () => {
    const actual = await vi.importActual<
      typeof import('@/services/wikidata/wikidata-rest-service.js')
    >('@/services/wikidata/wikidata-rest-service.js');
    mockNormalizeStatements.mockImplementation(actual.normalizeStatements);
    mockFetchLabels.mockResolvedValue({});
    /** P31 P1659, live. */
    mockFetchStatements.mockResolvedValue({
      P1659: [
        {
          id: 'P31$1',
          rank: 'normal',
          property: { id: 'P1659', data_type: 'wikibase-property' },
          value: { type: 'value', content: 'P279' },
        },
      ],
    });

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const result = wikidataGetStatements.output.parse(
      await wikidataGetStatements.handler(
        wikidataGetStatements.input.parse({ id: 'P31', properties: ['P1659'] }),
        ctx,
      ),
    );

    expect(mockFetchLabels).toHaveBeenCalledWith(['P1659', 'P279'], ['en'], expect.anything());
    expect(result.statements?.P1659?.[0]?.value).toEqual({
      type: 'entity-id',
      entityType: 'property',
      id: 'P279',
    });
    const lines = (wikidataGetStatements.format!(result)[0] as { text: string }).text.split('\n');
    expect(lines).toContain('- P279');
  });

  it('end to end: Q2 P2120 bounds reach structuredContent and content[] (#44)', async () => {
    const actual = await vi.importActual<
      typeof import('@/services/wikidata/wikidata-rest-service.js')
    >('@/services/wikidata/wikidata-rest-service.js');
    mockNormalizeStatements.mockImplementation(actual.normalizeStatements);
    mockFetchStatements.mockResolvedValue({
      P2120: [
        {
          id: 'Q2$1',
          rank: 'normal',
          property: { id: 'P2120', data_type: 'quantity' },
          value: {
            type: 'value',
            content: {
              amount: '+6378.137',
              unit: 'http://www.wikidata.org/entity/Q828224',
              upperBound: '+6378.138',
              lowerBound: '+6378.136',
            },
          },
        },
      ],
    });
    mockFetchLabels.mockResolvedValue({
      Q828224: { labels: { en: 'kilometre' }, descriptions: {} },
    });

    const ctx = createMockContext({ errors: wikidataGetStatements.errors });
    const result = wikidataGetStatements.output.parse(
      await wikidataGetStatements.handler(
        wikidataGetStatements.input.parse({ id: 'Q2', properties: ['P2120'] }),
        ctx,
      ),
    );

    expect(result.statements?.P2120?.[0]?.value).toEqual({
      type: 'quantity',
      amount: '+6378.137',
      unit: 'http://www.wikidata.org/entity/Q828224',
      upperBound: '+6378.138',
      lowerBound: '+6378.136',
      unitLabel: 'kilometre',
    });
    const lines = (wikidataGetStatements.format!(result)[0] as { text: string }).text.split('\n');
    expect(lines.map(inlineText)).toContain(
      '- +6378.137 [+6378.136, +6378.138] kilometre (Q828224)',
    );
  });

  it('format: renders no reference block for a statement without references', () => {
    const output = {
      id: 'Q42',
      kind: 'full' as const,
      statements: {
        P31: [
          { id: 's', rank: 'normal', property: 'P31', value: { type: 'wikibase-item', qid: 'Q5' } },
        ],
      },
      propertyCount: 1,
      statementCount: 1,
      labelsResolved: false,
    };
    const text = (formatFixture(output)[0] as { text: string }).text;
    expect(text).not.toContain('References');
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

    /**
     * #40: labels were resolved before the overflow check, so an unfiltered call on a large
     * entity paid for every label batch and then returned an outline that discarded them.
     */
    describe('label resolution against the budget (#40)', () => {
      /** P1..Pn, each one item-valued statement pointing at a distinct QID (Q1001..). */
      const rawItemStatementsFor = (count: number) =>
        Object.fromEntries(
          Array.from({ length: count }, (_, i) => [
            `P${i + 1}`,
            [
              {
                id: `P${i + 1}$stmt`,
                rank: 'normal',
                property: { id: `P${i + 1}`, data_type: 'wikibase-item' },
                value: { type: 'value', content: `Q${1001 + i}` },
              },
            ],
          ]),
        );

      /** It also reports none resolved, on both surfaces, though resolve_labels was true. */
      it('returns the outline of an over-budget set without any label request', async () => {
        mockFetchStatements.mockResolvedValue(rawItemStatementsFor(100));
        mockNormalizeStatements.mockImplementation(bulkyNormalize(300));
        mockFetchLabels.mockResolvedValue({});

        const ctx = createMockContext({ errors: wikidataGetStatements.errors });
        const result = wikidataGetStatements.output.parse(
          await wikidataGetStatements.handler(
            wikidataGetStatements.input.parse({ id: 'Q30', resolve_labels: true }),
            ctx,
          ),
        );
        const text = (wikidataGetStatements.format!(result)[0] as { text: string }).text;

        expect(mockFetchLabels).not.toHaveBeenCalled();
        expect(result.kind).toBe('outline');
        expect(result.sections).toHaveLength(100);
        expect(result.statementCount).toBe(100);
        expect(result.labelsResolved).toBe(false);
        expect(text).toContain('**Labels resolved:** false');
      });

      it('resolves labels for an in-budget set, as before', async () => {
        mockFetchStatements.mockResolvedValue(rawItemStatementsFor(3));
        mockFetchLabels.mockResolvedValue({
          Q1001: { labels: { en: 'first' }, descriptions: {} },
        });

        const ctx = createMockContext({ errors: wikidataGetStatements.errors });
        const result = await wikidataGetStatements.handler(
          wikidataGetStatements.input.parse({ id: 'Q30' }),
          ctx,
        );

        expect(result.kind).toBe('full');
        expect(mockFetchLabels).toHaveBeenCalledTimes(1);
        const [ids] = mockFetchLabels.mock.calls[0] as [string[]];
        // The statement keys ride the same batch (#56).
        expect([...ids].sort()).toEqual(['P1', 'P2', 'P3', 'Q1001', 'Q1002', 'Q1003']);
        expect(mockNormalizeStatements).toHaveBeenLastCalledWith('P3', expect.anything(), {
          Q1001: 'first',
        });
      });

      /** Normalizes to 6,000 bytes per property unlabelled and 15,000 once labels are applied. */
      const growsWithLabels = (propertyId: string, _stmts: unknown, labels?: object) =>
        bulkyNormalize(labels && Object.keys(labels).length > 0 ? 15_000 : 6_000)(propertyId);

      /**
       * The budget is decided on the unlabelled set. Outlining here would hand back sizes no
       * selection could satisfy — a fitting re-call would be labelled over budget again.
       */
      it('returns the labelled statements, never an outline or error, when the set fits only before labels are added', async () => {
        mockFetchStatements.mockResolvedValue(rawItemStatementsFor(2));
        mockNormalizeStatements.mockImplementation(growsWithLabels);
        mockFetchLabels.mockResolvedValue({
          Q1001: { labels: { en: 'first' }, descriptions: {} },
        });

        const ctx = createMockContext({ errors: wikidataGetStatements.errors });
        const result = wikidataGetStatements.output.parse(
          await wikidataGetStatements.handler(
            wikidataGetStatements.input.parse({ id: 'Q30' }),
            ctx,
          ),
        );

        expect(mockFetchLabels).toHaveBeenCalledTimes(1);
        expect(result.kind).toBe('full');
        expect(Object.keys(result.statements ?? {}).sort()).toEqual(['P1', 'P2']);
        expect(result.sections).toBeUndefined();
        // The labelled normalization is what came back, and it is past the budget.
        const p1 = result.statements?.P1?.[0] as { value: { value: string } } | undefined;
        expect(p1?.value.value).toHaveLength(15_000);
        expect(JSON.stringify(result.statements).length).toBeGreaterThan(24_000);
      });

      /**
       * The caller cancels while the label batch is in flight. The batch sees the abort only
       * through the context the handler passed it, and the handler must reject with the
       * caller's own reason — not degrade to unlabelled statements or wrap it.
       */
      it('propagates caller cancellation from the label batch', async () => {
        mockFetchStatements.mockResolvedValue(rawItemStatementsFor(3));
        const controller = new AbortController();
        const reason = new DOMException('The operation was aborted.', 'AbortError');
        mockFetchLabels.mockImplementation(
          async (_ids: string[], _languages: string[], callCtx: { signal: AbortSignal }) => {
            controller.abort(reason);
            callCtx.signal.throwIfAborted();
            return {};
          },
        );

        const ctx = createMockContext({
          errors: wikidataGetStatements.errors,
          signal: controller.signal,
        });
        await expect(
          wikidataGetStatements.handler(wikidataGetStatements.input.parse({ id: 'Q30' }), ctx),
        ).rejects.toBe(reason);
        expect(mockFetchLabels).toHaveBeenCalledTimes(1);
        expect(ctx.signal.aborted).toBe(true);
      });

      /**
       * Labels decorate the statements; they are not the answer. Every window sends a label batch
       * for its P-IDs, so a label service that is down must not fail a call whose statements came
       * back — the statements return unlabelled, and the result says so.
       */
      it.each([
        [
          'unavailable',
          new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Wikidata MW API returned HTML.'),
        ],
        ['rate-limiting', new McpError(JsonRpcErrorCode.RateLimited, 'Too many requests.')],
        [
          'past its deadline',
          new McpError(JsonRpcErrorCode.Timeout, 'The Wikidata label lookup did not finish.'),
        ],
      ])(
        'returns the statements unlabelled, saying so on both surfaces, when the label lookup is %s',
        async (_name, err) => {
          mockFetchStatements.mockResolvedValue(rawStatements);
          mockFetchLabels.mockRejectedValueOnce(err);

          const result = await runToolContract(wikidataGetStatements, {
            id: 'Q42',
            properties: ['P31'],
          });
          const structured = result.structuredContent as {
            kind: string;
            labelsResolved: boolean;
            statements?: Record<string, unknown[]>;
            notice?: string;
          };
          const text = result.content.map((b) => (b as { text: string }).text).join('');

          expect(result.isError).toBeFalsy();
          expect(structured.kind).toBe('full');
          expect(structured.statements?.P31).toHaveLength(1);
          expect(structured.labelsResolved).toBe(false);
          expect(structured).not.toHaveProperty('propertyLabels');
          expect(structured.notice).toContain('Labels were not resolved');
          expect(structured.notice).toContain('resolve_labels: false');
          expect(inlineText(text)).toContain('Labels were not resolved');
          expect(text).toContain('**Labels resolved:** false');
        },
      );

      it('still fails the call when the label lookup fails for any other reason', async () => {
        mockFetchStatements.mockResolvedValue(rawStatements);
        mockFetchLabels.mockRejectedValueOnce(httpError(400));

        const ctx = createMockContext({ errors: wikidataGetStatements.errors });
        await expect(
          wikidataGetStatements.handler(
            wikidataGetStatements.input.parse({ id: 'Q42', properties: ['P31'] }),
            ctx,
          ),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
      });
    });

    /**
     * The outline's guidance is code an agent executes: a re-call built from it must return
     * statements, never the same outline again. Walked through the real normalizer with labels
     * long enough to push every fitting selection over the budget once they are applied.
     */
    describe('walking the outline guidance as written', () => {
      const LONG_LABEL = 'l'.repeat(200);
      /** P1..P8, 40 item statements each, every value a distinct QID. */
      const raw = Object.fromEntries(
        Array.from({ length: 8 }, (_, p) => [
          `P${p + 1}`,
          Array.from({ length: 40 }, (_, s) => ({
            id: `Q30$P${p + 1}-${s}`,
            rank: 'normal',
            property: { id: `P${p + 1}`, data_type: 'wikibase-item' },
            value: { type: 'value', content: `Q${1000 + p * 100 + s}` },
          })),
        ]),
      );

      beforeEach(async () => {
        const actual = await vi.importActual<
          typeof import('@/services/wikidata/wikidata-rest-service.js')
        >('@/services/wikidata/wikidata-rest-service.js');
        mockNormalizeStatements.mockImplementation(actual.normalizeStatements);
        // The service narrows to the requested P-IDs; mirror that.
        mockFetchStatements.mockImplementation(async (_id: string, properties?: string[]) =>
          properties?.length
            ? Object.fromEntries(Object.entries(raw).filter(([p]) => properties.includes(p)))
            : raw,
        );
        mockFetchLabels.mockImplementation(async (ids: string[]) =>
          Object.fromEntries(
            ids.map((id) => [id, { labels: { en: LONG_LABEL }, descriptions: {} }]),
          ),
        );
      });

      /** A window wide enough for every property's 40 statements, so each property is whole. */
      const call = async (args: Record<string, unknown>) =>
        wikidataGetStatements.output.parse(
          await wikidataGetStatements.handler(
            wikidataGetStatements.input.parse({ id: 'Q30', limit: 40, ...args }),
            createMockContext({ errors: wikidataGetStatements.errors }),
          ),
        );

      it('the P-IDs the notice names return statements, not another outline', async () => {
        const outline = await call({});
        expect(outline.kind).toBe('outline');

        const named = outline.retrieval_notice?.match(/P\d+/g) ?? [];
        expect(named.length).toBeGreaterThan(0);

        const recall = await call({ properties: named });
        expect(recall.kind).toBe('full');
        expect(Object.keys(recall.statements ?? {}).sort()).toEqual([...named].sort());
        // Labels were resolved on the re-call even though they carry it past the budget.
        expect(JSON.stringify(recall.statements)).toContain(LONG_LABEL);
      });

      it('any selection whose listed sizes sum to the budget or less returns statements', async () => {
        const outline = await call({});
        const sections = outline.sections ?? [];

        // The largest selection the outline's sizes say will fit, built largest-first.
        const chosen: string[] = [];
        let sum = 0;
        for (const s of sections) {
          if (sum + s.bytes <= 24_000) {
            chosen.push(s.name);
            sum += s.bytes;
          }
        }
        expect(chosen.length).toBeGreaterThan(1);

        const recall = await call({ properties: chosen });
        expect(recall.kind).toBe('full');
        expect(Object.keys(recall.statements ?? {}).sort()).toEqual([...chosen].sort());
      });
    });

    it('listed sizes carry the key overhead a re-call pays, so a knife-edge pair is not offered as fitting', async () => {
      // Three properties whose statement arrays are 11,998 bytes each: two of them sum under
      // 24,000 by array size alone, but the response naming both is 24,009 bytes.
      const base = JSON.stringify(bulkyNormalize(0)('P1')).length;
      mockNormalizeStatements.mockImplementation(bulkyNormalize(11_998 - base));
      const all = rawStatementsFor(3);
      mockFetchStatements.mockImplementation(async (_id: string, properties?: string[]) =>
        properties?.length
          ? Object.fromEntries(Object.entries(all).filter(([p]) => properties.includes(p)))
          : all,
      );
      const call = async (args: Record<string, unknown>) =>
        wikidataGetStatements.output.parse(
          await wikidataGetStatements.handler(
            wikidataGetStatements.input.parse({ id: 'Q30', resolve_labels: false, ...args }),
            createMockContext({ errors: wikidataGetStatements.errors }),
          ),
        );

      const outline = await call({});
      expect(outline.kind).toBe('outline');
      const chosen: string[] = [];
      let sum = 0;
      for (const s of outline.sections ?? []) {
        if (sum + s.bytes <= 24_000) {
          chosen.push(s.name);
          sum += s.bytes;
        }
      }

      expect((await call({ properties: chosen })).kind).toBe('full');
    });

    /**
     * The decision and every listed size are UTF-8 bytes. Counted in UTF-16 code units, a
     * CJK-heavy set measures a third of its wire size and slips past the budget.
     */
    describe('the budget is measured in UTF-8 bytes', () => {
      const utf8 = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
      /** Each property normalizes to one statement whose value is `chars` CJK characters. */
      const cjkNormalize = (chars: number) => (propertyId: string) => [
        {
          id: `${propertyId}$stmt`,
          rank: 'normal',
          property: propertyId,
          value: { type: 'string', value: '中'.repeat(chars) },
        },
      ];
      const call = async (args: Record<string, unknown>) =>
        wikidataGetStatements.output.parse(
          await wikidataGetStatements.handler(
            wikidataGetStatements.input.parse({ id: 'Q30', resolve_labels: false, ...args }),
            createMockContext({ errors: wikidataGetStatements.errors }),
          ),
        );
      const serveNarrowed = (all: Record<string, unknown>) =>
        mockFetchStatements.mockImplementation(async (_id: string, properties?: string[]) =>
          properties?.length
            ? Object.fromEntries(Object.entries(all).filter(([p]) => properties.includes(p)))
            : all,
        );

      it('outlines a set under budget in characters but over it in bytes, sizing sections in bytes', async () => {
        // Two properties of 5,000 CJK characters: ~10,100 characters, ~30,100 bytes.
        serveNarrowed(rawStatementsFor(2));
        mockNormalizeStatements.mockImplementation(cjkNormalize(5_000));

        const result = await call({});

        expect(result.kind).toBe('outline');
        expect(result.sections).toEqual([
          { name: 'P1', bytes: utf8({ P1: cjkNormalize(5_000)('P1') }) },
          { name: 'P2', bytes: utf8({ P2: cjkNormalize(5_000)('P2') }) },
        ]);
        const total = utf8({ P1: cjkNormalize(5_000)('P1'), P2: cjkNormalize(5_000)('P2') });
        expect(result.retrieval_notice).toContain(`${total} bytes against a 24000-byte budget`);
      });

      it('the set the notice names fits the budget in bytes and returns statements', async () => {
        // Eight properties of 3,500 CJK characters: ~3,560 characters, ~10,560 bytes each.
        serveNarrowed(rawStatementsFor(8));
        mockNormalizeStatements.mockImplementation(cjkNormalize(3_500));

        const outline = await call({});
        expect(outline.kind).toBe('outline');
        const named = outline.retrieval_notice?.match(/P\d+/g) ?? [];
        expect(named.length).toBeGreaterThan(0);

        const recall = await call({ properties: named });
        expect(recall.kind).toBe('full');
        expect(utf8(recall.statements)).toBeLessThanOrEqual(24_000);
      });
    });

    it('format: renders the outline sections and the re-call notice', () => {
      const blocks = formatFixture({
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
      const blocks = formatFixture({
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

  /**
   * #36: one shared language-code schema. A blank language used to request labels in "" —
   * none resolved, while labelsResolved still read true.
   */
  describe('language input', () => {
    const call = (args: Record<string, unknown>) =>
      runToolContract(wikidataGetStatements, args as never);

    it.each([
      ['', 'en'],
      ['EN', 'en'],
      ['en_GB', 'en-gb'],
    ])('resolves labels for language %j in %j', async (language, expected) => {
      mockFetchStatements.mockResolvedValue(rawStatements);
      mockFetchLabels.mockResolvedValue({
        Q5: { labels: { [expected]: 'human' }, descriptions: {} },
      });
      mockNormalizeStatements.mockReturnValue(normalizedStatements);

      const result = await call({ id: 'Q42', language });

      expect(result.isError).toBeFalsy();
      expect(mockFetchLabels).toHaveBeenCalledWith(['Q5', 'P31'], [expected], expect.anything());
      // The label reached normalization — the map is keyed by the normalized code.
      expect(mockNormalizeStatements).toHaveBeenCalledWith('P31', rawStatements.P31, {
        Q5: 'human',
      });
    });

    it.each([['en" || true || "'], ['{en}'], ['en gb'], ['[AUTO_LANGUAGE]'], ['fr,en']])(
      'rejects language %j as invalid arguments before any upstream call',
      async (language) => {
        const result = await call({ id: 'Q42', language });

        expect(result.isError).toBe(true);
        expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
          JsonRpcErrorCode.InvalidParams,
        );
        expect(mockFetchStatements).not.toHaveBeenCalled();
      },
    );
  });

  /**
   * The statement pipeline — rank filter (#57), the per-property limit/offset window (#45), the
   * outline decision, and one label batch over the returned window (#56) — run through the real
   * normalizer and runToolContract, so both surfaces and the enrichment trailer are the wire's.
   */
  describe('statement pipeline', () => {
    /** One raw statement as the REST endpoint sends it. */
    const stmt = (
      property: string,
      n: number,
      rank: 'preferred' | 'normal' | 'deprecated',
      dataType = 'string',
      content: unknown = `${property}-${n}`,
    ) => ({
      id: `Q64$${property}-${n}`,
      rank,
      property: { id: property, data_type: dataType },
      value: { type: 'value', content },
    });
    /** `count` statements of `property`, ranked by `rankOf(index)`. */
    const run = (
      property: string,
      count: number,
      rankOf: (i: number) => 'preferred' | 'normal' | 'deprecated' = () => 'normal',
    ) => Array.from({ length: count }, (_, i) => stmt(property, i, rankOf(i)));
    /** The service narrows to the requested P-IDs; mirror that. */
    const serve = (all: Record<string, unknown[]>) =>
      mockFetchStatements.mockImplementation(async (_id: string, properties?: string[]) =>
        properties?.length
          ? Object.fromEntries(Object.entries(all).filter(([p]) => properties.includes(p)))
          : all,
      );
    const callTool = (args: Record<string, unknown>) =>
      runToolContract(wikidataGetStatements, { id: 'Q64', ...args } as never);
    type Structured = {
      kind: string;
      statements?: Record<string, Array<{ id: string; rank: string }>>;
      sections?: Array<{ name: string; bytes: number }>;
      retrieval_notice?: string;
      propertyCount: number;
      statementCount: number;
      notice?: string;
      [key: string]: unknown;
    };
    const structured = (result: { structuredContent?: unknown }) =>
      result.structuredContent as Structured;
    const textOf = (result: { content: unknown[] }) =>
      result.content.map((b) => (b as { text: string }).text).join('\n');
    const ids = (result: { structuredContent?: unknown }, property: string) =>
      (structured(result).statements?.[property] ?? []).map((s) => s.id);

    beforeEach(async () => {
      const actual = await vi.importActual<
        typeof import('@/services/wikidata/wikidata-rest-service.js')
      >('@/services/wikidata/wikidata-rest-service.js');
      mockNormalizeStatements.mockImplementation(actual.normalizeStatements);
      mockFetchLabels.mockResolvedValue({});
    });

    /** Characterization: pinned against the pre-pipeline code, and must hold under the defaults. */
    it('returns every statement of each property, deprecated included, in upstream order, by default', async () => {
      const ranks = ['deprecated', 'preferred', 'normal', 'normal', 'deprecated'] as const;
      serve({
        P1082: ranks.map((rank, i) => stmt('P1082', i, rank)),
        P6: run('P6', 3),
      });

      const result = await callTool({ resolve_labels: false });
      const text = textOf(result);

      expect(result.isError).toBeFalsy();
      expect(structured(result).kind).toBe('full');
      expect(ids(result, 'P1082')).toEqual([0, 1, 2, 3, 4].map((i) => `Q64$P1082-${i}`));
      expect(structured(result).statements?.P1082?.map((s) => s.rank)).toEqual([...ranks]);
      expect(ids(result, 'P6')).toEqual(['Q64$P6-0', 'Q64$P6-1', 'Q64$P6-2']);
      expect(structured(result).propertyCount).toBe(2);
      expect(structured(result).statementCount).toBe(8);
      for (const id of [...ids(result, 'P1082'), ...ids(result, 'P6')]) {
        expect(text).toContain(`  - id: ${id}`);
      }
      expect(text.match(/~~\(deprecated\)~~/g)).toHaveLength(2);
      expect(text.match(/ ★$/gm)).toHaveLength(1);
    });

    describe('rank filter (#57)', () => {
      /** Q64 P1082 shape: 47 statements, one preferred (index 20). */
      const p1082 = run('P1082', 47, (i) => (i === 20 ? 'preferred' : 'normal'));
      /** Q64 P31 shape: 12 normal, 1 deprecated, no preferred. */
      const p31 = run('P31', 13, (i) => (i === 4 ? 'deprecated' : 'normal'));
      /** Q64 P2002 shape: deprecated only. */
      const p2002 = run('P2002', 2, () => 'deprecated');

      it('keeps only the preferred statement of a property that has one under "best"', async () => {
        serve({ P1082: p1082 });

        const result = await callTool({ properties: ['P1082'], rank: 'best' });

        expect(result.isError).toBeFalsy();
        expect(ids(result, 'P1082')).toEqual(['Q64$P1082-20']);
        expect(structured(result).statementCount).toBe(1);
        expect(structured(result).propertyTotals).toEqual({ P1082: 1 });
        expect(structured(result).rank).toBe('best');
        expect(textOf(result)).toContain('**Rank:** best');
        expect(textOf(result)).toContain('  - id: Q64$P1082-20');
      });

      it.each([
        ['omitted', {}],
        ['"all"', { rank: 'all' }],
      ])('counts all 47 statements when rank is %s', async (_label, args) => {
        serve({ P1082: p1082 });

        const result = await callTool({ properties: ['P1082'], ...args });

        expect(result.isError).toBeFalsy();
        expect(structured(result).rank).toBe('all');
        expect(structured(result).statementCount).toBe(47);
        expect(structured(result).propertyTotals).toEqual({ P1082: 47 });
        expect(ids(result, 'P1082')).toContain('Q64$P1082-0');
        expect(textOf(result)).toContain('**Rank:** all');
      });

      it('keeps the normal statements and never a deprecated one when no statement is preferred', async () => {
        serve({ P31: p31 });

        const result = await callTool({ properties: ['P31'], rank: 'best' });
        const returned = structured(result).statements?.P31 ?? [];

        expect(structured(result).statementCount).toBe(12);
        expect(structured(result).propertyTotals).toEqual({ P31: 12 });
        expect(returned.length).toBeGreaterThan(0);
        expect(returned.every((s) => s.rank === 'normal')).toBe(true);
        expect(ids(result, 'P31')).not.toContain('Q64$P31-4');
        expect(textOf(result)).not.toContain('deprecated');
      });

      it('keeps none of a deprecated-only property, counts it as 0, and says why on both surfaces', async () => {
        serve({ P2002: p2002 });

        const result = await callTool({ properties: ['P2002'], rank: 'best' });
        const notice = structured(result).notice ?? '';

        expect(result.isError).toBeFalsy();
        expect(structured(result).statements ?? {}).toEqual({});
        expect(structured(result).propertyCount).toBe(0);
        expect(structured(result).statementCount).toBe(0);
        expect(structured(result).propertyTotals).toEqual({ P2002: 0 });
        // At offset 0 an empty page is the rank's doing, never a paging overrun.
        expect(notice).toBe(
          'P2002 holds only deprecated statements, which rank "best" leaves out. Re-call with rank: "all" to read them.',
        );
        expect(textOf(result)).toContain('only deprecated statements');
        expect(textOf(result)).toContain('P2002');
      });

      it('names a zero total, with no offset to page back to, past the end of a deprecated-only selection', async () => {
        serve({ P2002: p2002 });

        const result = await callTool({
          properties: ['P2002'],
          offset: 5,
          rank: 'best',
          resolve_labels: false,
        });

        expect(structured(result).returnedCount).toBe(0);
        expect(structured(result).notice).toBe(
          'offset 5 is past the end of every property here: the largest, P2002, holds 0 statements. P2002 holds only deprecated statements, which rank "best" leaves out. Re-call with rank: "all" to read them.',
        );
        expect(textOf(result)).toContain('holds 0 statements');
        expect(textOf(result)).not.toContain('offset below');
      });

      it('makes the choice per property in one call', async () => {
        serve({ P1082: p1082, P31: p31, P2002: p2002 });

        const result = await callTool({ properties: ['P1082', 'P31', 'P2002'], rank: 'best' });

        expect(ids(result, 'P1082')).toEqual(['Q64$P1082-20']);
        expect(structured(result).statements?.P31?.every((s) => s.rank === 'normal')).toBe(true);
        expect(structured(result).statements).not.toHaveProperty('P2002');
        expect(structured(result).propertyTotals).toEqual({ P1082: 1, P31: 12, P2002: 0 });
        expect(structured(result).statementCount).toBe(13);
      });

      it('raises no deprecated-only notice under "all", which keeps those statements', async () => {
        serve({ P2002: p2002 });

        const result = await callTool({ properties: ['P2002'] });

        expect(ids(result, 'P2002')).toEqual(['Q64$P2002-0', 'Q64$P2002-1']);
        expect(structured(result).notice).toBeUndefined();
      });

      /** Two properties, each one small preferred statement beside a heavy deprecated tail. */
      const heavyTail = (property: string, qid: string) => [
        stmt(property, 0, 'preferred', 'wikibase-item', qid),
        ...Array.from({ length: 4 }, (_, i) =>
          stmt(property, i + 1, 'deprecated', 'string', 'x'.repeat(4_000)),
        ),
      ];

      it('sizes the outline decision on the kept statements only', async () => {
        serve({ P1: heavyTail('P1', 'Q1001'), P2: heavyTail('P2', 'Q1002') });

        const all = await callTool({ resolve_labels: false });
        const best = await callTool({ resolve_labels: false, rank: 'best' });

        expect(structured(all).kind).toBe('outline');
        expect(structured(best).kind).toBe('full');
        expect(ids(best, 'P1')).toEqual(['Q64$P1-0']);
        expect(ids(best, 'P2')).toEqual(['Q64$P2-0']);
      });

      it('sends only the kept statements to the label batch', async () => {
        serve({
          P1: heavyTail('P1', 'Q1001').map((s, i) =>
            i === 0 ? s : stmt('P1', i, 'deprecated', 'wikibase-item', `Q${2000 + i}`),
          ),
        });

        await callTool({ rank: 'best' });

        expect(mockFetchLabels).toHaveBeenCalledTimes(1);
        const [requested] = mockFetchLabels.mock.calls[0] as [string[]];
        expect(requested).toContain('Q1001');
        expect(requested.filter((id) => id.startsWith('Q2'))).toEqual([]);
      });

      it('outlines a kept set still over budget with sections sized on it, and no label request (#40)', async () => {
        const keptHeavy = (property: string) => [
          stmt(property, 0, 'preferred', 'string', 'y'.repeat(15_000)),
          stmt(property, 1, 'deprecated', 'string', 'x'.repeat(30_000)),
        ];
        serve({ P1: keptHeavy('P1'), P2: keptHeavy('P2') });

        const result = await callTool({ rank: 'best' });
        const sections = structured(result).sections ?? [];

        expect(mockFetchLabels).not.toHaveBeenCalled();
        expect(structured(result).kind).toBe('outline');
        expect(sections.map((s) => s.name).sort()).toEqual(['P1', 'P2']);
        for (const s of sections) {
          expect(s.bytes).toBeGreaterThan(15_000);
          expect(s.bytes).toBeLessThan(16_000);
        }
        expect(structured(result).statementCount).toBe(2);
      });

      it('rejects a rank outside the enum at schema validation', async () => {
        const result = await callTool({ rank: 'preferred' });

        expect(result.isError).toBe(true);
        expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
          JsonRpcErrorCode.InvalidParams,
        );
        expect(mockFetchStatements).not.toHaveBeenCalled();
      });
    });

    describe('limit and offset window (#45)', () => {
      /** Q183 P530 shape: 190 statements. */
      const p530 = run('P530', 190);
      const p530Ids = p530.map((s) => s.id);

      /** Zod 4 `.int()` advertises the safe-integer bound as `maximum`; no cap rides with it. */
      it('advertises limit with minimum 1 and no cap as its maximum, and offset with minimum 0', () => {
        const schema = z.toJSONSchema(wikidataGetStatements.input, { io: 'input' }) as {
          properties: Record<string, { minimum?: number; maximum?: number; default?: unknown }>;
        };

        expect(schema.properties.limit).toMatchObject({ minimum: 1, default: 10 });
        expect(schema.properties.limit?.maximum ?? Number.MAX_SAFE_INTEGER).toBe(
          Number.MAX_SAFE_INTEGER,
        );
        expect(schema.properties.offset).toMatchObject({ minimum: 0, default: 0 });
      });

      it.each([
        ['limit: 0', { limit: 0 }],
        ['offset: -1', { offset: -1 }],
        ['a fractional limit', { limit: 2.5 }],
      ])('rejects %s at schema validation', async (_label, args) => {
        const result = await callTool(args);

        expect(result.isError).toBe(true);
        expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
          JsonRpcErrorCode.InvalidParams,
        );
        expect(mockFetchStatements).not.toHaveBeenCalled();
      });

      it('returns the first 10 statements by default, the total, and the next offset', async () => {
        serve({ P530: p530 });

        const result = await callTool({ properties: ['P530'], resolve_labels: false });
        const text = textOf(result);

        expect(ids(result, 'P530')).toEqual(p530Ids.slice(0, 10));
        expect(structured(result).propertyTotals).toEqual({ P530: 190 });
        expect(structured(result).statementCount).toBe(190);
        expect(structured(result).returnedCount).toBe(10);
        expect(structured(result).nextOffset).toBe(10);
        expect(structured(result).truncated).toBe(true);
        expect(text).toContain('**Returned:** 10');
        expect(text).toContain('**Next offset:** 10');
        expect(text).toContain('**Property totals:** P530: 190');
        expect(text).toContain('**Truncated:** true');
      });

      it('returns the last page at offset 180 with no next offset', async () => {
        serve({ P530: p530 });

        const result = await callTool({ properties: ['P530'], offset: 180, resolve_labels: false });

        expect(ids(result, 'P530')).toEqual(p530Ids.slice(180));
        expect(structured(result).returnedCount).toBe(10);
        expect(structured(result)).not.toHaveProperty('nextOffset');
        expect(structured(result)).not.toHaveProperty('truncated');
        expect(textOf(result)).not.toContain('Next offset');
        expect(textOf(result)).not.toContain('Truncated');
        expect(structured(result).notice).toBeUndefined();
      });

      it('returns every statement once, in upstream order, when nextOffset is followed from 0', async () => {
        serve({ P530: p530 });

        const seen: string[] = [];
        let offset: number | undefined = 0;
        let calls = 0;
        while (offset !== undefined && calls < 50) {
          const result = await callTool({
            properties: ['P530'],
            offset,
            limit: 7,
            resolve_labels: false,
          });
          seen.push(...ids(result, 'P530'));
          offset = structured(result).nextOffset as number | undefined;
          calls++;
        }

        expect(seen).toEqual(p530Ids);
        expect(calls).toBe(Math.ceil(190 / 7));
      });

      it('windows each property on its own, omits a property paged past its end, and totals every property', async () => {
        serve({ P530: p530, P31: run('P31', 12), P6: run('P6', 3) });

        const result = await callTool({ offset: 10, limit: 5, resolve_labels: false });

        expect(ids(result, 'P530')).toEqual(p530Ids.slice(10, 15));
        expect(ids(result, 'P31')).toEqual(['Q64$P31-10', 'Q64$P31-11']);
        expect(structured(result).statements).not.toHaveProperty('P6');
        expect(structured(result).propertyTotals).toEqual({ P530: 190, P31: 12, P6: 3 });
        expect(structured(result).propertyCount).toBe(2);
        expect(structured(result).statementCount).toBe(205);
        expect(structured(result).returnedCount).toBe(7);
        expect(structured(result).nextOffset).toBe(15);
      });

      it('returns no statements past every total, with a notice naming the largest', async () => {
        serve({ P530: p530, P31: run('P31', 12) });

        const result = await callTool({ offset: 400, resolve_labels: false });
        const notice = structured(result).notice ?? '';

        expect(result.isError).toBeFalsy();
        expect(structured(result).kind).toBe('full');
        expect(structured(result).statements ?? {}).toEqual({});
        expect(structured(result).returnedCount).toBe(0);
        expect(structured(result)).not.toHaveProperty('nextOffset');
        expect(structured(result).propertyTotals).toEqual({ P530: 190, P31: 12 });
        expect(notice).toContain('offset 400');
        expect(notice).toContain('P530');
        expect(notice).toContain('190');
        expect(textOf(result)).toContain('offset 400');
      });

      it('raises no past-the-end notice for an entity with no statements', async () => {
        serve({});

        const result = await callTool({ offset: 20, resolve_labels: false });

        expect(structured(result).returnedCount).toBe(0);
        expect(structured(result).notice).toBeUndefined();
      });

      it('serves a limit above 500 at 500 with a notice naming both values on both surfaces', async () => {
        serve({ P1: run('P1', 620) });

        const result = await callTool({ properties: ['P1'], limit: 800, resolve_labels: false });
        const notice = structured(result).notice ?? '';

        expect(result.isError).toBeFalsy();
        expect(structured(result).returnedCount).toBe(500);
        expect(structured(result).nextOffset).toBe(500);
        expect(notice).toContain('800');
        expect(notice).toContain('500');
        expect(notice).toContain('Page through the rest with offset');
        expect(textOf(result)).toContain('800');
      });

      it('names the clamp but not paging when the clamped window holds every statement', async () => {
        serve({ P530: p530 });

        const result = await callTool({ properties: ['P530'], limit: 800, resolve_labels: false });
        const notice = structured(result).notice ?? '';

        expect(structured(result).returnedCount).toBe(190);
        expect(structured(result)).not.toHaveProperty('nextOffset');
        expect(notice).toContain('800');
        expect(notice).toContain('500');
        expect(notice).not.toContain('Page through the rest');
        expect(textOf(result)).not.toContain('Page through the rest');
      });

      it('serves a limit of exactly 500 with no notice', async () => {
        serve({ P1: run('P1', 620) });

        const result = await callTool({ properties: ['P1'], limit: 500, resolve_labels: false });

        expect(structured(result).returnedCount).toBe(500);
        expect(structured(result).notice).toBeUndefined();
      });

      it('joins every notice a call raises into one', async () => {
        serve({ P530: p530, P2002: run('P2002', 2, () => 'deprecated') });

        const result = await callTool({
          limit: 900,
          offset: 300,
          rank: 'best',
          resolve_labels: false,
        });
        const notice = structured(result).notice ?? '';

        expect(notice).toContain('900');
        expect(notice).toContain('offset 300');
        expect(notice).toContain('P2002 holds only deprecated statements');
        expect(textOf(result)).toContain('P2002 holds only deprecated statements');
        expect(textOf(result)).toContain('offset 300');
      });

      it('rejects a limit above 500, naming the cap, before any upstream call when WIKIDATA_CLAMP_LIMITS=false', async () => {
        vi.stubEnv('WIKIDATA_CLAMP_LIMITS', 'false');
        vi.resetModules();
        try {
          const fresh = (await import('@/mcp-server/tools/definitions/get-statements.tool.js'))
            .wikidataGetStatements;
          const result = await runToolContract(fresh, { id: 'Q64', limit: 800 } as never);
          const error = (result.structuredContent as { error: { code: number; message: string } })
            .error;

          expect(result.isError).toBe(true);
          expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
          expect(error.message).toContain('500');
          expect(mockFetchStatements).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllEnvs();
          vi.resetModules();
        }
      });

      it('covers only the returned window in the label batch', async () => {
        serve({
          P50: Array.from({ length: 30 }, (_, i) =>
            stmt('P50', i, 'normal', 'wikibase-item', `Q${5000 + i}`),
          ),
        });

        await callTool({ properties: ['P50'], offset: 10 });

        expect(mockFetchLabels).toHaveBeenCalledTimes(1);
        const [requested] = mockFetchLabels.mock.calls[0] as [string[]];
        expect(requested.filter((id) => id.startsWith('Q')).sort()).toEqual(
          Array.from({ length: 10 }, (_, i) => `Q${5010 + i}`).sort(),
        );
      });

      it('returns a single property at its window for any limit up to the cap, never as an outline', async () => {
        serve({
          P1: Array.from({ length: 500 }, (_, i) =>
            stmt('P1', i, 'normal', 'string', 'z'.repeat(200)),
          ),
        });

        const result = await callTool({ properties: ['P1'], limit: 500, resolve_labels: false });

        expect(structured(result).kind).toBe('full');
        expect(structured(result).returnedCount).toBe(500);
        expect(structured(result)).not.toHaveProperty('sections');
        expect(JSON.stringify(structured(result).statements).length).toBeGreaterThan(24_000);
      });

      describe('the outline measured on the window', () => {
        /** P1..P8, 40 statements each: every fourth preferred, each value 2,000 bytes. */
        const wide = Object.fromEntries(
          Array.from({ length: 8 }, (_, p) => [
            `P${p + 1}`,
            Array.from({ length: 40 }, (_, s) =>
              stmt(
                `P${p + 1}`,
                s,
                s % 4 === 0 ? 'preferred' : 'normal',
                'string',
                'w'.repeat(2_000),
              ),
            ),
          ]),
        );
        const window = { limit: 3, offset: 2, rank: 'best' };

        it('outlines an over-budget page with no label request, sized on the window, and no next offset', async () => {
          serve(wide);

          const result = await callTool(window);
          const sections = structured(result).sections ?? [];

          expect(mockFetchLabels).not.toHaveBeenCalled();
          expect(structured(result).kind).toBe('outline');
          expect(sections).toHaveLength(8);
          // Three 2,000-byte statements per section: the window, not the property's 10 kept or 40 raw.
          for (const s of sections) {
            expect(s.bytes).toBeGreaterThan(6_000);
            expect(s.bytes).toBeLessThan(7_000);
          }
          expect(structured(result).returnedCount).toBe(0);
          expect(structured(result)).not.toHaveProperty('nextOffset');
          expect(structured(result)).not.toHaveProperty('truncated');
          expect(structured(result).statementCount).toBe(80);
          expect(structured(result).propertyTotals).toMatchObject({ P1: 10, P8: 10 });
        });

        it('names limit, offset, and rank in the re-call, and walking it verbatim returns the full window', async () => {
          serve(wide);

          const outline = await callTool(window);
          const notice = structured(outline).retrieval_notice ?? '';
          const recipe = {
            limit: Number(notice.match(/limit: (\d+)/)?.[1]),
            offset: Number(notice.match(/offset: (\d+)/)?.[1]),
            rank: notice.match(/rank: "(\w+)"/)?.[1],
            properties: JSON.parse(notice.match(/properties:(\[[^\]]*"[^\]]*\])/)?.[1] ?? '[]'),
          };
          expect(recipe).toMatchObject(window);
          expect(recipe.properties.length).toBeGreaterThan(1);

          const recall = await callTool({ ...recipe, resolve_labels: false });

          expect(structured(recall).kind).toBe('full');
          expect(Object.keys(structured(recall).statements ?? {}).sort()).toEqual(
            [...recipe.properties].sort(),
          );
          // The listed sizes are the windowed selection's own bytes, so they add up.
          const listed = new Map(
            (structured(outline).sections ?? []).map((s) => [s.name, s.bytes]),
          );
          for (const [name, stmts] of Object.entries(structured(recall).statements ?? {})) {
            expect(Buffer.byteLength(JSON.stringify({ [name]: stmts }), 'utf8')).toBe(
              listed.get(name),
            );
          }
          expect(
            Buffer.byteLength(JSON.stringify(structured(recall).statements), 'utf8'),
          ).toBeLessThanOrEqual(24_000);
        });

        it('returns kind "full" for any selection whose listed sizes sum to 24,000 or less', async () => {
          serve(wide);

          const outline = await callTool(window);
          const chosen: string[] = [];
          let sum = 0;
          for (const s of [...(structured(outline).sections ?? [])].reverse()) {
            if (sum + s.bytes <= 24_000) {
              chosen.push(s.name);
              sum += s.bytes;
            }
          }
          expect(chosen.length).toBeGreaterThan(1);

          const recall = await callTool({ ...window, properties: chosen });
          expect(structured(recall).kind).toBe('full');
          expect(structured(recall).returnedCount).toBe(chosen.length * 3);
        });

        it('names limit, offset, and rank in the one-property re-call when no section fits on its own', async () => {
          const oversized = (property: string) => [
            stmt(property, 0, 'normal'),
            stmt(property, 1, 'normal', 'string', 'v'.repeat(30_000)),
          ];
          serve({ P1: oversized('P1'), P2: oversized('P2') });

          const result = await callTool({ limit: 1, offset: 1, rank: 'best' });
          const notice = structured(result).retrieval_notice ?? '';
          const recall =
            'Every property here is larger than the budget on its own; re-call wikidata_get_statements with the same id, limit: 1, offset: 1, and rank: "best", plus properties:[...] naming one P-ID per call.';

          expect(structured(result).kind).toBe('outline');
          expect((structured(result).sections ?? []).map((s) => s.name).sort()).toEqual([
            'P1',
            'P2',
          ]);
          expect(notice).toContain(recall);
          expect(notice).not.toContain('e.g. properties:');
          expect(textOf(result)).toContain(recall);
        });
      });
    });

    describe('property labels (#56)', () => {
      const snak = (property: string, dataType: string, content: unknown) => ({
        property: { id: property, data_type: dataType },
        value: { type: 'value', content },
      });
      /** Q1497 P2043 shape: two P1310 qualifiers, one reference citing P854, P50, and P1476. */
      const p2043 = [
        {
          id: 'Q1497$length',
          rank: 'normal',
          ...snak('P2043', 'quantity', {
            amount: '+3766',
            unit: 'http://www.wikidata.org/entity/Q828224',
            upperBound: '+3767',
            lowerBound: '+3765',
          }),
          qualifiers: [
            snak('P1310', 'wikibase-item', 'Q14692877'),
            snak('P1310', 'wikibase-item', 'Q7000'),
          ],
          references: [
            {
              parts: [
                snak('P854', 'url', 'https://example.org/river-facts'),
                snak('P50', 'wikibase-item', 'Q7001'),
                snak('P1476', 'monolingualtext', { text: 'River Facts', language: 'en' }),
              ],
            },
          ],
        },
      ];
      const labels: Record<string, string> = {
        P2043: 'length',
        P1310: 'statement disputed by',
        P854: 'reference URL',
        P50: 'author',
        P1476: 'title',
        P1659: 'related property',
        P279: 'subclass of',
        Q828224: 'kilometre',
        Q14692877: 'Mississippi National River and Recreation Area',
      };
      /** Answers each requested ID whose label is known; the rest are absent, as upstream. */
      const answerFrom = (known: Record<string, string>) =>
        mockFetchLabels.mockImplementation(async (requested: string[]) =>
          Object.fromEntries(
            requested
              .filter((id) => known[id])
              .map((id) => [id, { labels: { en: known[id] }, descriptions: {} }]),
          ),
        );
      const lines = (result: { content: unknown[] }) => textOf(result).split('\n');

      it('labels statement, qualifier, and reference-part P-IDs in one map and beside each P-ID', async () => {
        serve({ P2043: p2043 });
        answerFrom(labels);

        const result = await callTool({ id: 'Q1497', properties: ['P2043'] });

        expect(result.isError).toBeFalsy();
        expect(structured(result).propertyLabels).toEqual({
          P2043: 'length',
          P1310: 'statement disputed by',
          P854: 'reference URL',
          P50: 'author',
          P1476: 'title',
        });
        const shown = lines(result).map(inlineText);
        expect(shown).toContain('### P2043 (length)');
        expect(shown).toContain('- +3766 [+3765, +3767] kilometre (Q828224)');
        expect(shown).toContain(
          '  - P1310 (statement disputed by): Mississippi National River and Recreation Area (Q14692877)',
        );
        expect(shown).toContain('  - P1310 (statement disputed by): Q7000');
        expect(shown).toContain('      - P854 (reference URL): https://example.org/river-facts');
        expect(shown).toContain('      - P50 (author): Q7001');
        expect(shown).toContain('      - P1476 (title): River Facts [en]');
      });

      it('leaves a P-ID the batch did not resolve out of the map, rendered bare', async () => {
        serve({ P2043: p2043 });
        const { P50: _unresolved, ...rest } = labels;
        answerFrom(rest);

        const result = await callTool({ id: 'Q1497', properties: ['P2043'] });

        expect(structured(result).propertyLabels).not.toHaveProperty('P50');
        expect(structured(result).propertyLabels).toHaveProperty('P854', 'reference URL');
        expect(lines(result)).toContain('      - P50: Q7001');
      });

      it('labels a property-typed value from the same map, leaving its structured value as it was', async () => {
        serve({
          P1659: [{ id: 'P31$1', rank: 'normal', ...snak('P1659', 'wikibase-property', 'P279') }],
        });
        answerFrom(labels);

        const result = await callTool({ id: 'P31', properties: ['P1659'] });
        const [value] = (structured(result).statements?.P1659 ?? []) as unknown as Array<{
          value: unknown;
        }>;

        expect(value?.value).toEqual({ type: 'entity-id', entityType: 'property', id: 'P279' });
        expect(structured(result).propertyLabels).toEqual({
          P1659: 'related property',
          P279: 'subclass of',
        });
        expect(lines(result)).toContain('### P1659 (related property)');
        expect(lines(result)).toContain('- subclass of (P279)');
      });

      it('labels a property-typed qualifier value and reference-part value from the same map', async () => {
        serve({
          P1659: [
            {
              id: 'P279$1',
              rank: 'normal',
              ...snak('P1659', 'wikibase-property', 'P31'),
              qualifiers: [snak('P1696', 'wikibase-property', 'P1647')],
              references: [{ parts: [snak('P1659', 'wikibase-property', 'P279')] }],
            },
          ],
        });
        answerFrom({
          ...labels,
          P31: 'instance of',
          P1696: 'inverse property',
          P1647: 'subproperty of',
        });

        const result = await callTool({ id: 'P279', properties: ['P1659'] });

        expect(structured(result).propertyLabels).toEqual({
          P1659: 'related property',
          P31: 'instance of',
          P1696: 'inverse property',
          P1647: 'subproperty of',
          P279: 'subclass of',
        });
        expect(lines(result)).toContain('- instance of (P31)');
        expect(lines(result)).toContain('  - P1696 (inverse property): subproperty of (P1647)');
        expect(lines(result)).toContain('      - P1659 (related property): subclass of (P279)');
      });

      it('sends P-IDs and QIDs in one deduplicated label call', async () => {
        serve({
          P2043: p2043,
          P2044: [
            {
              id: 'Q1497$elevation',
              rank: 'normal',
              ...snak('P2044', 'quantity', {
                amount: '+450',
                unit: 'http://www.wikidata.org/entity/Q828224',
              }),
              qualifiers: [snak('P1310', 'wikibase-item', 'Q14692877')],
            },
          ],
        });
        answerFrom(labels);

        await callTool({ id: 'Q1497' });

        expect(mockFetchLabels).toHaveBeenCalledTimes(1);
        const [requested, languages] = mockFetchLabels.mock.calls[0] as [string[], string[]];
        expect(requested).toHaveLength(new Set(requested).size);
        expect([...requested].sort()).toEqual(
          [
            'P2043',
            'P2044',
            'P1310',
            'P854',
            'P50',
            'P1476',
            'Q828224',
            'Q14692877',
            'Q7000',
            'Q7001',
          ].sort(),
        );
        expect(languages).toEqual(['en']);
      });

      it('makes no label request and carries no property labels when resolve_labels is false', async () => {
        serve({ P2043: p2043 });

        const result = await callTool({
          id: 'Q1497',
          properties: ['P2043'],
          resolve_labels: false,
        });

        expect(mockFetchLabels).not.toHaveBeenCalled();
        expect(structured(result)).not.toHaveProperty('propertyLabels');
        expect(lines(result)).toContain('### P2043');
        expect(lines(result)).toContain('  - P1310: Q14692877');
      });

      it('makes no label request and carries no property labels on an outline (#40)', async () => {
        serve({
          P1: [stmt('P1', 0, 'normal', 'string', 'a'.repeat(15_000))],
          P2: [stmt('P2', 0, 'normal', 'string', 'b'.repeat(15_000))],
        });
        answerFrom(labels);

        const result = await callTool({});

        expect(structured(result).kind).toBe('outline');
        expect(mockFetchLabels).not.toHaveBeenCalled();
        expect(structured(result)).not.toHaveProperty('propertyLabels');
      });

      it('labels only the P-IDs of the returned window', async () => {
        serve({
          P2043: [
            ...Array.from({ length: 10 }, (_, i) => ({
              id: `Q1497$head-${i}`,
              rank: 'normal',
              ...snak('P2043', 'string', `v${i}`),
            })),
            {
              id: 'Q1497$tail',
              rank: 'normal',
              ...snak('P2043', 'string', 'tail'),
              qualifiers: [snak('P9000', 'string', 'past the window')],
            },
          ],
        });
        answerFrom(labels);

        await callTool({ id: 'Q1497', properties: ['P2043'] });

        const [requested] = mockFetchLabels.mock.calls[0] as [string[]];
        expect(requested).toEqual(['P2043']);
      });

      it('escapes a property label in content[] and keeps it raw in structuredContent', async () => {
        const hostile = '*bold* [x](javascript:alert) `tick`';
        serve({ P2043: p2043 });
        answerFrom({ ...labels, P1310: hostile });

        const result = await callTool({ id: 'Q1497', properties: ['P2043'] });

        expect(structured(result).propertyLabels).toHaveProperty('P1310', hostile);
        expect(textOf(result)).not.toContain(hostile);
        expect(lines(result).map(inlineText)).toContain(
          `  - P1310 (${hostile}): Mississippi National River and Recreation Area (Q14692877)`,
        );
      });
    });
  });
});
