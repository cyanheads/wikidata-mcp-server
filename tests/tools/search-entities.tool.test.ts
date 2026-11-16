/**
 * @fileoverview Tests for wikidata_search_entities tool.
 * @module tests/tools/search-entities.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  /**
   * #53: the endpoint returns no total and a short page is not the end, so `nextOffset` marks
   * where to continue; the walk ends at an empty page or a page with no `nextOffset`.
   */
  describe('pagination and the per-call cap', () => {
    type SearchStructured = {
      results: unknown[];
      shown: number;
      cap: number;
      truncated?: boolean;
      nextOffset?: number;
      notice?: string;
    };
    const call = (args: Record<string, unknown>) =>
      runToolContract(wikidataSearchEntities, args as never);
    const structuredOf = (result: { structuredContent?: unknown }) =>
      result.structuredContent as SearchStructured;
    const textOf = (result: { content: unknown[] }) =>
      result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    /** `n` ranked hits, the shape the REST search endpoint returns. */
    const hits = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `Q${i + 1}`,
        'display-label': { language: 'en', value: `hit ${i + 1}` },
        match: { type: 'label', language: 'en' },
      }));

    it('a full page carries nextOffset, truncated, shown, cap, and a notice naming nextOffset', async () => {
      mockSearch.mockResolvedValue(hits(50));

      const result = await call({ query: 'Douglas Adams', limit: 50 });

      const structured = structuredOf(result);
      expect(structured).toMatchObject({ nextOffset: 50, truncated: true, shown: 50, cap: 50 });
      expect(structured.notice).toContain('offset 50');
      expect(structured.notice).not.toMatch(/raise the cap/i);
      const text = textOf(result);
      expect(text).toContain('**nextOffset:** 50');
      expect(text).toContain('offset 50');
    });

    it('a short page carries nextOffset at offset + limit, never offset + results', async () => {
      mockSearch.mockResolvedValue(hits(49));

      const result = await call({ query: 'date', type: 'property', limit: 50, offset: 300 });

      const structured = structuredOf(result);
      expect(structured.nextOffset).toBe(350);
      expect(structured.truncated).toBeUndefined();
      expect(structured.notice).toBeUndefined();
      expect(textOf(result)).toContain('**nextOffset:** 350');
    });

    it('walks 50 → 16 → none, ending at the empty page with an end-of-results notice', async () => {
      mockSearch.mockResolvedValueOnce(hits(16)).mockResolvedValueOnce([]);

      const second = await call({ query: 'Douglas Adams', limit: 50, offset: 50 });
      expect(structuredOf(second).nextOffset).toBe(100);

      const past = await call({ query: 'Douglas Adams', limit: 50, offset: 100 });
      const structured = structuredOf(past);
      expect(structured.nextOffset).toBeUndefined();
      expect(structured.notice).toContain('offset 100');
      expect(structured.notice).not.toMatch(/matched|broader/i);
      expect(textOf(past)).toContain('offset 100');
    });

    it('keeps the zero-match notice for an empty first page (#11)', async () => {
      mockSearch.mockResolvedValue([]);

      const result = await call({ query: 'xyzzy' });

      expect(result.isError).toBeFalsy();
      expect(structuredOf(result).notice).toBe(
        'No items matched "xyzzy" in language "en". Try broader terms or a different language code.',
      );
      expect(structuredOf(result).nextOffset).toBeUndefined();
    });

    it('stops nextOffset at the 10,000-result window, saying so', async () => {
      mockSearch.mockResolvedValue(hits(10));

      const result = await call({ query: 'john', limit: 20, offset: 9_990 });

      const structured = structuredOf(result);
      expect(structured.nextOffset).toBeUndefined();
      expect(structured.notice).toContain('first 10,000 results');
      expect(textOf(result)).toContain('first 10,000 results');
    });

    it('rejects offset 10,000 as invalid arguments before any upstream request', async () => {
      const result = await call({ query: 'john', offset: 10_000 });

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it.each([51, 500])('sends limit %i upstream unchanged', async (limit) => {
      mockSearch.mockResolvedValue([]);

      const result = await call({ query: 'john', limit });

      expect(mockSearch).toHaveBeenCalledWith('john', 'item', 'en', limit, 0, expect.anything());
      expect(structuredOf(result).cap).toBe(limit);
    });

    it('serves limit 501 at 500, reporting cap 500 and a notice naming both', async () => {
      mockSearch.mockResolvedValue(hits(120));

      const result = await call({ query: 'john', limit: 501 });

      expect(mockSearch).toHaveBeenCalledWith('john', 'item', 'en', 500, 0, expect.anything());
      const structured = structuredOf(result);
      expect(structured.cap).toBe(500);
      expect(structured.nextOffset).toBe(500);
      expect(structured.notice).toContain('501');
      expect(structured.notice).toContain('500');
      expect(textOf(result)).toContain('501');
    });

    it('joins the clamp, full-page, and window-end notices into one', async () => {
      mockSearch.mockResolvedValue(hits(500));

      const result = await call({ query: 'john', limit: 501, offset: 9_500 });

      const structured = structuredOf(result);
      expect(structured).toMatchObject({ truncated: true, shown: 500, cap: 500 });
      expect(structured.nextOffset).toBeUndefined();
      const notice = structured.notice ?? '';
      expect(notice).toContain('501');
      expect(notice).toContain('filled');
      expect(notice).toContain('first 10,000 results');
      for (const line of notice.split('\n')) expect(textOf(result)).toContain(line);
    });

    it('carries nextOffset and the notice on both surfaces for a property search', async () => {
      mockSearch.mockResolvedValue(hits(10));

      const result = await call({ query: 'date', type: 'property' });

      expect(mockSearch).toHaveBeenCalledWith('date', 'property', 'en', 10, 0, expect.anything());
      expect(structuredOf(result)).toMatchObject({ nextOffset: 10, truncated: true });
      expect(textOf(result)).toContain('**nextOffset:** 10');
      expect(textOf(result)).toContain(structuredOf(result).notice ?? 'missing notice');
    });

    /** Zod 4 `.int()` advertises the safe-integer bound as `maximum`; no cap rides with it. */
    it('advertises limit with no cap as its maximum and offset with maximum 9999', () => {
      const schema = z.toJSONSchema(wikidataSearchEntities.input, { io: 'input' }) as {
        properties: Record<string, { minimum?: number; maximum?: number; default?: unknown }>;
      };

      expect(schema.properties.limit).toMatchObject({ minimum: 1, default: 10 });
      expect(schema.properties.limit?.maximum ?? Number.MAX_SAFE_INTEGER).toBe(
        Number.MAX_SAFE_INTEGER,
      );
      expect(schema.properties.offset).toMatchObject({ minimum: 0, maximum: 9999 });
    });

    describe('with WIKIDATA_CLAMP_LIMITS=false', () => {
      afterEach(() => {
        vi.unstubAllEnvs();
      });

      it('rejects limit 501 naming 500, before any upstream request', async () => {
        vi.stubEnv('WIKIDATA_CLAMP_LIMITS', 'false');
        vi.resetModules();
        const { wikidataSearchEntities: fresh } = await import(
          '@/mcp-server/tools/definitions/search-entities.tool.js'
        );

        const result = await runToolContract(fresh, { query: 'john', limit: 501 } as never);

        expect(result.isError).toBe(true);
        const error = (result.structuredContent as { error: { code: number; message: string } })
          .error;
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.message).toContain('500');
        expect(mockSearch).not.toHaveBeenCalled();
      });
    });
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

  /** #36: one shared language-code schema — normalized, blank means en, hostile values rejected. */
  describe('language input', () => {
    const call = (args: Record<string, unknown>) =>
      runToolContract(wikidataSearchEntities, args as never);

    it.each([
      ['EN', 'en'],
      ['en-GB', 'en-gb'],
      ['en_gb', 'en-gb'],
      ['', 'en'],
      ['  ', 'en'],
    ])('sends language %j upstream as %j', async (language, expected) => {
      mockSearch.mockResolvedValue([]);

      const result = await call({ query: 'Douglas Adams', language });

      expect(result.isError).toBeFalsy();
      expect(mockSearch).toHaveBeenCalledWith(
        'Douglas Adams',
        'item',
        expected,
        10,
        0,
        expect.anything(),
      );
    });

    it.each([
      ['en" || true || "'],
      ['en\\'],
      ['{en}'],
      ['en|de'],
      ['en gb'],
      ['[AUTO_LANGUAGE]'],
      ['fr,en'],
    ])('rejects language %j as invalid arguments before any upstream call', async (language) => {
      const result = await call({ query: 'Douglas Adams', language });

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
      expect(mockSearch).not.toHaveBeenCalled();
    });
  });

  /** #42: the service's typed search rejection is a declared reason with a recovery hint. */
  it('surfaces invalid_search_parameter with its declared recovery hint', async () => {
    mockSearch.mockRejectedValue(
      validationError('The Wikidata search endpoint does not search in language "mul".', {
        reason: 'invalid_search_parameter',
        parameter: 'language',
      }),
    );

    const result = await runToolContract(wikidataSearchEntities, {
      query: 'Douglas Adams',
      language: 'mul',
    } as never);

    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: {
          code: number;
          message: string;
          data: { reason: string; recovery: { hint: string } };
        };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('invalid_search_parameter');
    expect(error.data.recovery.hint).toContain('"en"');
    expect(result.content?.[0]).toMatchObject({
      text: expect.stringContaining(error.data.recovery.hint),
    });
    expect(wikidataSearchEntities.errors?.map((e) => e.reason)).toContain(
      'invalid_search_parameter',
    );
  });
});
