/**
 * @fileoverview Tests for wikidata_get_labels tool.
 * @module tests/tools/get-labels.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataGetLabels } from '@/mcp-server/tools/definitions/get-labels.tool.js';
import { inlineText } from '../helpers/markdown.js';

const mockFetchLabels = vi.fn();

/**
 * Stub only the service accessor — the I/O boundary. `normalizeId` stays real, so these tests
 * run the production ID normalizer (entity URI and `wd:` forms included).
 */
vi.mock('@/services/wikidata/wikidata-rest-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/wikidata/wikidata-rest-service.js')>()),
  getWikidataRestService: () => ({ fetchLabels: mockFetchLabels }),
}));

/** `count` distinct Q-IDs starting at Q`from`. */
const qids = (count: number, from = 1) => Array.from({ length: count }, (_, i) => `Q${from + i}`);

/** Echoes every requested ID as a resolved entity, the way wbgetentities answers. */
const resolveAll = () =>
  mockFetchLabels.mockImplementation(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { labels: { en: `label ${id}` }, descriptions: {} }])),
  );

type LabelsStructured = {
  entities: Record<string, { labels: Record<string, string> }>;
  found: number;
  notFound: string[];
  invalid?: string[];
  deferredIds?: string[];
  languages: string[];
  notice?: string;
};
const structuredOf = (result: { structuredContent?: unknown }) =>
  result.structuredContent as LabelsStructured;
const textOf = (result: { content: unknown[] }) =>
  result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
const errorCodeOf = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { error: { code: number } }).error.code;

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

  /** #55: one malformed entry rejected every valid one; it now lands in `invalid`. */
  it('resolves the valid IDs and lists a malformed entry in invalid, as sent', async () => {
    mockFetchLabels.mockResolvedValue({
      Q76: { labels: { en: 'Barack Obama' }, descriptions: {} },
      P31: { labels: { en: 'instance of' }, descriptions: {} },
    });

    const result = await runToolContract(wikidataGetLabels, { ids: ['Q76', 'P31', 'notanid'] });

    expect(result.isError).toBeFalsy();
    expect(mockFetchLabels).toHaveBeenCalledWith(['Q76', 'P31'], ['en'], expect.anything());
    const structured = structuredOf(result);
    expect(structured.found).toBe(2);
    expect(structured.invalid).toEqual(['notanid']);
    expect(structured.notFound).toEqual([]);
    expect(structured.deferredIds).toBeUndefined();
    expect(textOf(result)).toContain('**Invalid:** notanid');
  });

  it('raises invalid_ids only when no valid ID remains', async () => {
    const result = await runToolContract(wikidataGetLabels, { ids: ['notanid'] });

    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: { code: number; data: { reason: string; recovery: { hint: string } } };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('invalid_ids');
    expect(error.data.recovery.hint).toContain('wd:');
    expect(mockFetchLabels).not.toHaveBeenCalled();
  });

  it('echoes each malformed entry once, as sent, keeping valid duplicates to one lookup', async () => {
    mockFetchLabels.mockResolvedValue({});

    const result = await runToolContract(wikidataGetLabels, {
      ids: ['Q1', ' q1 ', 'bad one', 'bad one', 'Bad One', 'Q1'],
    });

    expect(mockFetchLabels).toHaveBeenCalledWith(['Q1'], ['en'], expect.anything());
    const structured = structuredOf(result);
    expect(structured.invalid).toEqual(['bad one', 'Bad One']);
    expect(structured.notFound).toEqual(['Q1']);
  });

  /** #55: the forms wikidata_sparql_query returns resolve without a rewrite by the caller. */
  it('resolves entity URIs and wd: forms to their bare IDs', async () => {
    resolveAll();

    const result = await runToolContract(wikidataGetLabels, {
      ids: ['http://www.wikidata.org/entity/Q42', 'wd:P31', 'https://www.wikidata.org/entity/Q76'],
    });

    expect(result.isError).toBeFalsy();
    expect(mockFetchLabels).toHaveBeenCalledWith(['Q42', 'P31', 'Q76'], ['en'], expect.anything());
    expect(Object.keys(structuredOf(result).entities)).toEqual(['Q42', 'P31', 'Q76']);
    expect(structuredOf(result).invalid).toBeUndefined();
  });

  /** #14 wiring: unassigned and out-of-range IDs go to notFound beside the valid members. */
  it('reports unassigned and out-of-range IDs in notFound without dropping valid members', async () => {
    mockFetchLabels.mockResolvedValue({
      Q76: { labels: { en: 'Barack Obama' }, descriptions: {} },
    });

    const result = await runToolContract(wikidataGetLabels, {
      ids: ['Q76', 'Q99999999', 'Q999999999999'],
    });

    expect(structuredOf(result).found).toBe(1);
    expect(structuredOf(result).notFound).toEqual(['Q99999999', 'Q999999999999']);
    expect(textOf(result)).toContain('**Not found:** Q99999999, Q999999999999');
  });

  /** #55: the per-call cap is 500 distinct IDs; the rest are named, not rejected. */
  describe('500-ID cap', () => {
    it('resolves the first 500 distinct IDs and returns the 501st in deferredIds', async () => {
      resolveAll();

      const result = await runToolContract(wikidataGetLabels, { ids: qids(501) });

      expect(result.isError).toBeFalsy();
      expect(mockFetchLabels).toHaveBeenCalledTimes(1);
      expect(mockFetchLabels.mock.calls[0]?.[0]).toEqual(qids(500));
      const structured = structuredOf(result);
      expect(structured.found).toBe(500);
      expect(structured.deferredIds).toEqual(['Q501']);
      // Q501 was never looked up, so it is deferred, not missing.
      expect(structured.notFound).toEqual([]);
      expect(structured.notice).toBe(
        'Resolved the first 500 of 501 distinct IDs, the per-call cap. Call again with the 1 in deferredIds for the rest.',
      );
      const text = textOf(result);
      expect(text).toContain('**Deferred:** Q501');
      expect(text).toContain(`> ${structured.notice}`);
    });

    it('keeps deferredIds in input order and counts duplicates once toward the cap', async () => {
      resolveAll();
      // 500 distinct IDs, each sent twice, then three more distinct IDs in reverse order.
      const ids = [...qids(500), ...qids(500), 'Q9003', 'Q9002', 'Q9001'];

      const result = await runToolContract(wikidataGetLabels, { ids });

      expect(mockFetchLabels.mock.calls[0]?.[0]).toEqual(qids(500));
      expect(structuredOf(result).deferredIds).toEqual(['Q9003', 'Q9002', 'Q9001']);
      expect(structuredOf(result).notice).toBe(
        'Resolved the first 500 of 503 distinct IDs, the per-call cap. Call again with the 3 in deferredIds for the rest.',
      );
    });

    it('serves exactly 500 distinct IDs, duplicates included, with no deferral or notice', async () => {
      resolveAll();

      const result = await runToolContract(wikidataGetLabels, { ids: [...qids(500), 'Q1', 'Q2'] });

      expect(mockFetchLabels.mock.calls[0]?.[0]).toEqual(qids(500));
      expect(structuredOf(result).deferredIds).toBeUndefined();
      expect(structuredOf(result).notice).toBeUndefined();
    });

    it('does not count malformed entries toward the cap', async () => {
      resolveAll();

      const result = await runToolContract(wikidataGetLabels, {
        ids: [...qids(500), 'nope', 'also nope'],
      });

      expect(structuredOf(result).deferredIds).toBeUndefined();
      expect(structuredOf(result).invalid).toEqual(['nope', 'also nope']);
    });

    it('accepts 10,000 entries and rejects 10,001 as invalid arguments', async () => {
      resolveAll();

      const atCeiling = await runToolContract(wikidataGetLabels, { ids: qids(10_000) });
      expect(atCeiling.isError).toBeFalsy();
      expect(structuredOf(atCeiling).deferredIds).toHaveLength(9_500);

      mockFetchLabels.mockClear();
      const over = await runToolContract(wikidataGetLabels, { ids: qids(10_001) });
      expect(over.isError).toBe(true);
      expect(errorCodeOf(over)).toBe(JsonRpcErrorCode.InvalidParams);
      expect(mockFetchLabels).not.toHaveBeenCalled();
    });

    describe('with WIKIDATA_CLAMP_LIMITS=false', () => {
      afterEach(() => {
        vi.unstubAllEnvs();
      });

      /** Imports the tool fresh, so the lazily parsed server config re-reads the stubbed env. */
      const loadTool = async () => {
        vi.resetModules();
        return (await import('@/mcp-server/tools/definitions/get-labels.tool.js'))
          .wikidataGetLabels;
      };

      it('rejects 501 distinct IDs naming the cap, before any lookup', async () => {
        vi.stubEnv('WIKIDATA_CLAMP_LIMITS', 'false');
        const tool = await loadTool();

        const result = await runToolContract(tool, { ids: qids(501) });

        expect(result.isError).toBe(true);
        const error = (result.structuredContent as { error: { code: number; message: string } })
          .error;
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.message).toContain('500');
        expect(mockFetchLabels).not.toHaveBeenCalled();
      });

      it('still serves 500 distinct IDs', async () => {
        vi.stubEnv('WIKIDATA_CLAMP_LIMITS', 'false');
        const tool = await loadTool();
        resolveAll();

        const result = await runToolContract(tool, { ids: qids(500) });

        expect(result.isError).toBeFalsy();
        expect(structuredOf(result).found).toBe(500);
      });
    });
  });

  /** #55: wbgetentities refuses a 51st language (`toomanyvalues`); the schema stops it first. */
  it('accepts 50 languages and rejects 51 as invalid arguments', async () => {
    mockFetchLabels.mockResolvedValue({});
    /** `n` distinct well-formed codes: xaa, xba, … */
    const letter = (n: number) => String.fromCharCode(97 + n);
    const languages = (n: number) =>
      Array.from({ length: n }, (_, i) => `x${letter(i % 26)}${letter(Math.floor(i / 26))}`);

    const fifty = await runToolContract(wikidataGetLabels, {
      ids: ['Q1'],
      languages: languages(50),
    });
    expect(fifty.isError).toBeFalsy();
    expect(mockFetchLabels.mock.calls[0]?.[1]).toHaveLength(50);

    mockFetchLabels.mockClear();
    const fiftyOne = await runToolContract(wikidataGetLabels, {
      ids: ['Q1'],
      languages: languages(51),
    });
    expect(fiftyOne.isError).toBe(true);
    expect(errorCodeOf(fiftyOne)).toBe(JsonRpcErrorCode.InvalidParams);
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

    expect(inlineText(text)).toContain('de: Barack Obama — 44. Präsident der Vereinigten Staaten');
    expect(inlineText(text)).toContain('de: ist ein(e) — Klasse, zu der dieses Objekt gehört');
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

  /** #55: 51 IDs used to reject the whole call; up to 50 return what they always did. */
  it('input validation: 51 IDs pass the schema, and 50 return no invalid or deferred fields', async () => {
    resolveAll();
    expect(() => wikidataGetLabels.input.parse({ ids: qids(51) })).not.toThrow();

    const result = await runToolContract(wikidataGetLabels, { ids: qids(50) });
    expect(Object.keys(structuredOf(result)).sort()).toEqual([
      'entities',
      'found',
      'languages',
      'notFound',
    ]);
    expect(structuredOf(result).found).toBe(50);
  });

  it('normalizes lowercase IDs before validation', async () => {
    mockFetchLabels.mockResolvedValue({
      Q76: { labels: { en: 'Barack Obama' }, descriptions: {} },
    });

    const ctx = createMockContext({ errors: wikidataGetLabels.errors });
    const input = wikidataGetLabels.input.parse({ ids: ['q76'] });
    const result = await wikidataGetLabels.handler(input, ctx);

    expect(result.found).toBe(1);
    expect(mockFetchLabels).toHaveBeenCalledWith(['Q76'], ['en'], expect.anything());
  });

  it('security: an injection attempt never reaches the lookup and renders as literal text', async () => {
    mockFetchLabels.mockResolvedValue({
      Q76: { labels: { en: 'Barack Obama' }, descriptions: {} },
    });
    const injection = '"; DROP TABLE; -- *x* [a](javascript:alert)';

    const result = await runToolContract(wikidataGetLabels, { ids: ['Q76', injection] });

    expect(mockFetchLabels).toHaveBeenCalledWith(['Q76'], ['en'], expect.anything());
    expect(structuredOf(result).invalid).toEqual([injection]);
    const text = textOf(result);
    expect(text).toContain(escapeMarkdownInline(injection));
    expect(text).not.toContain('*x*');
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
