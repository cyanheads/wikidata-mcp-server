/**
 * @fileoverview Tests for wikidata_get_statements tool.
 * @module tests/tools/get-statements.tool.test
 */

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
    fetchStatements: mockFetchStatements,
    fetchLabels: mockFetchLabels,
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
    const text = (wikidataGetStatements.format!(output)[0] as { text: string }).text;

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
        ...snak('P569', 'time', { time: '+1952-03-11T00:00:00Z', precision: 11 - s }),
        qualifiers: [snak('P1480', 'wikibase-item', 'Q5727902')],
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
    expect(lines).toContain('- +1952-03-11T00:00:00Z (precision 9: year)');
    expect(lines).toContain('- 51.5, -0.1 (precision 0.0001)');
    expect(count(/^ {6}- P813: \+2022-10-09T00:00:00Z \(precision 11: day\)$/)).toBe(10);
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
            value: { type: 'globe-coordinate' as const, latitude: 1, longitude: 2 },
          },
        ],
      },
      propertyCount: 2,
      statementCount: 3,
      labelsResolved: false,
    };
    const lines = (wikidataGetStatements.format!(output)[0] as { text: string }).text.split('\n');

    expect(lines).toContain('- -13798000000-00-00T00:00:00Z (precision 3: million years)');
    expect(lines).toContain('- +2001-00-00T00:00:00Z (precision 15)');
    expect(lines).toContain('- 1, 2');
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
    const lines = (wikidataGetStatements.format!(output)[0] as { text: string }).text.split('\n');

    expect(lines).toContain('- unknown value');
    expect(lines).toContain('  - P582: no value');
    expect(lines).toContain('      - P248: unknown value');
    expect(lines).toContain('- no value');
    expect(lines).not.toContain('- ');
  });

  it('makes no label lookup for an item-typed somevalue/novalue (#39)', async () => {
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

    expect(mockFetchLabels).not.toHaveBeenCalled();
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
      expect([...ids].sort()).toEqual(
        ['Q5', 'Q42395533', 'Q11573', 'Q19938912', 'Q150', 'Q712226'].sort(),
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
    const lines = (wikidataGetStatements.format!(output)[0] as { text: string }).text.split('\n');

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
    const text = (wikidataGetStatements.format!(output)[0] as { text: string }).text;
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
    const lines = (wikidataGetStatements.format!(output)[0] as { text: string }).text.split('\n');

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
    const text = (wikidataGetStatements.format!(output)[0] as { text: string }).text;
    const lines = text.split('\n');

    expect(lines).toContain('- P279');
    expect(lines).toContain('  - P5188: L37633');
    expect(lines).toContain('  - P5189: L229416-F1');
    expect(lines).toContain('      - P5972: L1452908-S1');
    expect(lines).toContain('      - P12861: E10');
    expect(text).not.toContain('"');
  });

  it('end to end: a wikibase-property value is typed, unlabelled, and bare in both surfaces (#43)', async () => {
    const actual = await vi.importActual<
      typeof import('@/services/wikidata/wikidata-rest-service.js')
    >('@/services/wikidata/wikidata-rest-service.js');
    mockNormalizeStatements.mockImplementation(actual.normalizeStatements);
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

    expect(mockFetchLabels).not.toHaveBeenCalled();
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
    const text = (wikidataGetStatements.format!(output)[0] as { text: string }).text;
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
        expect([...ids].sort()).toEqual(['Q1001', 'Q1002', 'Q1003']);
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

      it('propagates caller cancellation from the label batch', async () => {
        mockFetchStatements.mockResolvedValue(rawItemStatementsFor(3));
        const abort = new DOMException('The operation was aborted.', 'AbortError');
        mockFetchLabels.mockRejectedValue(abort);

        const ctx = createMockContext({ errors: wikidataGetStatements.errors });
        await expect(
          wikidataGetStatements.handler(wikidataGetStatements.input.parse({ id: 'Q30' }), ctx),
        ).rejects.toBe(abort);
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

      const call = async (args: Record<string, unknown>) =>
        wikidataGetStatements.output.parse(
          await wikidataGetStatements.handler(
            wikidataGetStatements.input.parse({ id: 'Q30', ...args }),
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
      expect(mockFetchLabels).toHaveBeenCalledWith(['Q5'], [expected], expect.anything());
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
});
