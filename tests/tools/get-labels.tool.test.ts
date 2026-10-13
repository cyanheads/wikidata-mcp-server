/**
 * @fileoverview Tests for wikidata_get_labels tool.
 * @module tests/tools/get-labels.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
   * #28: the rendered text sampled the primary language plus 3 more, so a content[]-only client
   * could not reach the rest. Every returned language now renders.
   */
  it('format: renders every returned language, one line each', () => {
    const langs = ['en', 'de', 'fr', 'es', 'it', 'ja', 'zh', 'pt', 'ru', 'ar'];
    const blocks = wikidataGetLabels.format!({
      entities: {
        Q76: {
          labels: Object.fromEntries(langs.map((l) => [l, `Obama-${l}`])),
          descriptions: { en: '44th U.S. President', ar: 'رئيس' },
        },
      },
      found: 1,
      notFound: [],
      languages: langs,
    });
    const lines = (blocks[0] as { text: string }).text.split('\n');

    expect(lines).toContain('**Q76:** Obama-en — 44th U.S. President');
    for (const lang of langs.slice(1, -1)) expect(lines).toContain(`  ${lang}: Obama-${lang}`);
    expect(lines).toContain('  ar: Obama-ar — رئيس');
    expect(lines.join('\n')).not.toContain('total');
  });

  it('format: renders a language that carries only a description', () => {
    const blocks = wikidataGetLabels.format!({
      entities: { Q76: { labels: { en: 'Barack Obama' }, descriptions: { de: 'Präsident' } } },
      found: 1,
      notFound: [],
      languages: ['en', 'de'],
    });
    const lines = (blocks[0] as { text: string }).text.split('\n');

    expect(lines).toContain('**Q76:** Barack Obama');
    expect(lines).toContain('  de: Q76 — Präsident');
  });

  it('carries the same entries on both surfaces past the old 4-language sample (#28)', async () => {
    const langs = ['en', 'de', 'fr', 'es', 'it', 'nl', 'ja', 'pt'];
    mockFetchLabels.mockResolvedValue({
      Q42: {
        labels: Object.fromEntries(langs.map((l) => [l, `Adams-${l}`])),
        descriptions: Object.fromEntries(langs.slice(0, 5).map((l) => [l, `writer-${l}`])),
      },
      P31: {
        labels: Object.fromEntries(langs.slice(0, 6).map((l) => [l, `instance-${l}`])),
        descriptions: { ja: 'クラス' },
      },
    });

    const result = await runToolContract(wikidataGetLabels, {
      ids: ['Q42', 'P31'],
      languages: langs,
    });
    const structured = result.structuredContent as {
      entities: Record<
        string,
        { labels: Record<string, string>; descriptions: Record<string, string> }
      >;
    };
    const text = result.content.map((b) => (b as { text: string }).text).join('\n');

    const structuredEntries = Object.entries(structured.entities).flatMap(([id, data]) =>
      [...new Set([...Object.keys(data.labels), ...Object.keys(data.descriptions)])].map(
        (lang) => `${id}:${lang}`,
      ),
    );
    // Primary line (`**ID:**`) plus one `  lang:` line per other language.
    const rendered = text
      .split('\n')
      .filter((line) => /^(\*\*[QP]\d+:\*\*| {2}[a-z-]+: )/.test(line));
    expect(structuredEntries).toHaveLength(15);
    expect(rendered).toHaveLength(structuredEntries.length);
    for (const [id, data] of Object.entries(structured.entities)) {
      for (const [lang, value] of Object.entries(data.labels)) {
        if (lang !== 'en') expect(text).toContain(`  ${lang}: ${value}`);
      }
      for (const value of Object.values(data.descriptions)) expect(text).toContain(value);
      expect(text).toContain(`**${id}:**`);
    }
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

  /**
   * #33: sibling tools spell these singular (`language` on get_statements, `id` on
   * get_entity). The singular keys alias onto the plural arrays, and the framework's
   * string-as-array repair wraps a lone string, so both spellings reach the handler as
   * arrays. Run through runToolContract, which applies the production pre-validation.
   */
  describe('singular input aliases', () => {
    type ErrorEnvelope = {
      error: { code: number; message: string; data?: { recovery?: { hint?: string } } };
    };
    const errorOf = (result: { structuredContent?: unknown }) =>
      (result.structuredContent as ErrorEnvelope).error;
    /** Raw `tools/call` arguments — deliberately outside the schema's input type. */
    const call = (args: Record<string, unknown>) =>
      runToolContract(wikidataGetLabels, args as never);

    beforeEach(() => {
      mockFetchLabels.mockResolvedValue({
        Q42: { labels: { de: 'Douglas Adams' }, descriptions: { de: 'britischer Schriftsteller' } },
      });
    });

    it('accepts id and language as lone strings, reaching the handler as one-element arrays', async () => {
      const result = await call({ id: 'Q42', language: 'de' });

      expect(result.isError).toBeFalsy();
      expect(mockFetchLabels).toHaveBeenCalledWith(['Q42'], ['de'], expect.anything());
      expect(result.structuredContent).toMatchObject({ found: 1, languages: ['de'] });
    });

    it('accepts the aliases carrying explicit arrays', async () => {
      const result = await call({ id: ['Q42', 'Q76'], language: ['de', 'fr'] });

      expect(result.isError).toBeFalsy();
      expect(mockFetchLabels).toHaveBeenCalledWith(['Q42', 'Q76'], ['de', 'fr'], expect.anything());
    });

    it('keeps the canonical keys working as before', async () => {
      const result = await call({ ids: ['Q42'], languages: ['de'] });

      expect(result.isError).toBeFalsy();
      expect(mockFetchLabels).toHaveBeenCalledWith(['Q42'], ['de'], expect.anything());
      expect(result.structuredContent).toMatchObject({ languages: ['de'] });
    });

    it('rejects id sent beside ids, naming it as an alias', async () => {
      const result = await call({ id: 'Q42', ids: ['Q42'] });

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.recovery?.hint).toContain(
        'id is an alias of ids; send one of them, not both.',
      );
      expect(mockFetchLabels).not.toHaveBeenCalled();
    });

    it('rejects language sent beside languages, naming it as an alias', async () => {
      const result = await call({ ids: ['Q42'], language: 'de', languages: ['de'] });

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.recovery?.hint).toContain(
        'language is an alias of languages; send one of them, not both.',
      );
      expect(mockFetchLabels).not.toHaveBeenCalled();
    });

    it('still rejects a wrong type on a canonical field', async () => {
      const ids = await call({ ids: true });
      const languages = await call({ ids: ['Q42'], languages: true });

      expect(errorOf(ids).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(errorOf(languages).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(mockFetchLabels).not.toHaveBeenCalled();
    });
  });

  /**
   * #36: one shared language-code schema. Upstream codes are lowercase and case-sensitive —
   * `EN` used to match nothing, so wbgetentities returned every language the entity carries.
   */
  describe('language input', () => {
    const call = (args: Record<string, unknown>) =>
      runToolContract(wikidataGetLabels, args as never);

    beforeEach(() => {
      mockFetchLabels.mockResolvedValue({});
    });

    it.each([
      [['EN'], ['en']],
      [['en-GB', 'en_gb'], ['en-gb']],
      [
        ['EN', '', ' de '],
        ['en', 'de'],
      ],
      [[], ['en']],
      [[''], ['en']],
    ])('sends languages %j upstream as %j', async (languages, expected) => {
      const result = await call({ ids: ['Q183'], languages });

      expect(result.isError).toBeFalsy();
      expect(mockFetchLabels).toHaveBeenCalledWith(['Q183'], expected, expect.anything());
      expect(result.structuredContent).toMatchObject({ languages: expected });
    });

    it('normalizes a lone language sent under the singular alias', async () => {
      const result = await call({ ids: ['Q183'], language: 'EN' });

      expect(result.isError).toBeFalsy();
      expect(mockFetchLabels).toHaveBeenCalledWith(['Q183'], ['en'], expect.anything());
    });

    it.each([['en" || true || "'], ['{en}'], ['en gb'], ['[AUTO_LANGUAGE]'], ['fr,en']])(
      'rejects an entry %j as invalid arguments before any upstream call',
      async (language) => {
        const result = await call({ ids: ['Q183'], languages: ['en', language] });

        expect(result.isError).toBe(true);
        expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
          JsonRpcErrorCode.InvalidParams,
        );
        expect(mockFetchLabels).not.toHaveBeenCalled();
      },
    );
  });
});
