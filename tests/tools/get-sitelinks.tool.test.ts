/**
 * @fileoverview Tests for wikidata_get_sitelinks tool.
 * @module tests/tools/get-sitelinks.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataGetSitelinks } from '@/mcp-server/tools/definitions/get-sitelinks.tool.js';

const mockFetchSitelinks = vi.fn();

/**
 * Stub only the service accessor — the module's pure helpers (isEntityNotFoundError,
 * isQId, normalizeId) stay real so the not-found predicate under test is production's.
 */
vi.mock('@/services/wikidata/wikidata-rest-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/wikidata/wikidata-rest-service.js')>()),
  getWikidataRestService: () => ({ fetchSitelinks: mockFetchSitelinks }),
}));

/** Mirrors what fetchWithTimeout rejects with on a non-2xx: an McpError carrying data.status. */
const httpError = (status: number) =>
  new McpError(
    status === 404 ? JsonRpcErrorCode.NotFound : JsonRpcErrorCode.InvalidParams,
    `Fetch failed. Status: ${status}`,
    { status },
  );

const mockSitelinks = {
  enwiki: { title: 'Barack Obama', url: 'https://en.wikipedia.org/wiki/Barack_Obama' },
  dewiki: { title: 'Barack Obama', url: 'https://de.wikipedia.org/wiki/Barack_Obama' },
  enwikiquote: { title: 'Barack Obama', url: 'https://en.wikiquote.org/wiki/Barack_Obama' },
};

describe('wikidataGetSitelinks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns sitelinks for a valid Q-ID', async () => {
    mockFetchSitelinks.mockResolvedValue(mockSitelinks);

    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'Q76' });
    const result = await wikidataGetSitelinks.handler(input, ctx);

    expect(result.id).toBe('Q76');
    expect(result.count).toBe(3);
    expect(result.sitelinks.enwiki!.title).toBe('Barack Obama');
    expect(result.message).toBeUndefined();
  });

  it('filters to wikis_only when requested', async () => {
    mockFetchSitelinks.mockResolvedValue(mockSitelinks);

    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'Q76', wikis_only: true });
    const result = await wikidataGetSitelinks.handler(input, ctx);

    expect(result.count).toBe(2);
    expect(result.sitelinks).toHaveProperty('enwiki');
    expect(result.sitelinks).toHaveProperty('dewiki');
    expect(result.sitelinks).not.toHaveProperty('enwikiquote');
  });

  it('filters to specified sites', async () => {
    mockFetchSitelinks.mockResolvedValue({ enwiki: mockSitelinks.enwiki });

    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'Q76', sites: ['enwiki'] });
    const result = await wikidataGetSitelinks.handler(input, ctx);

    expect(mockFetchSitelinks).toHaveBeenCalledWith('Q76', ['enwiki'], expect.anything());
    expect(result.count).toBe(1);
  });

  it('throws not_an_item for P-ID', async () => {
    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'P31' });
    await expect(wikidataGetSitelinks.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_an_item' },
    });
  });

  it('throws entity_not_found for an unassigned ID (404)', async () => {
    mockFetchSitelinks.mockRejectedValue(httpError(404));

    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'Q99999999' });
    await expect(wikidataGetSitelinks.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'entity_not_found' },
    });
  });

  /** The sitelinks endpoint answers an out-of-range ID with 400, same as the items endpoint. */
  it('throws entity_not_found for an out-of-range ID (400)', async () => {
    mockFetchSitelinks.mockRejectedValue(httpError(400));

    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'Q999999999999' });
    await expect(wikidataGetSitelinks.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'entity_not_found' },
    });
  });

  it('does not leak the raw upstream URL or status on a not-found', async () => {
    mockFetchSitelinks.mockRejectedValue(httpError(400));

    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'Q999999999999' });
    const err = await Promise.resolve(wikidataGetSitelinks.handler(input, ctx)).catch(
      (error: unknown) => error,
    );

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toBe('No item found for Q-ID "Q999999999999".');
    expect(message).not.toContain('Status:');
  });

  it('returns empty sitelinks with message when no matches', async () => {
    mockFetchSitelinks.mockResolvedValue({});

    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'Q76' });
    const result = await wikidataGetSitelinks.handler(input, ctx);

    expect(result.count).toBe(0);
    expect(result.sitelinks).toEqual({});
    expect(result.message).toBeDefined();
  });

  it('handles sparse sitelink (no url or badges)', async () => {
    mockFetchSitelinks.mockResolvedValue({
      enwiki: { title: 'Barack Obama' }, // no url, no badges
    });

    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'Q76' });
    const result = await wikidataGetSitelinks.handler(input, ctx);

    expect(result.sitelinks.enwiki!.title).toBe('Barack Obama');
    expect(result.sitelinks.enwiki!.url).toBeUndefined();
    expect(result.sitelinks.enwiki!.badges).toBeUndefined();
  });

  it('formats sitelinks output with count and links', () => {
    const output = {
      id: 'Q76',
      sitelinks: {
        enwiki: { title: 'Barack Obama', url: 'https://en.wikipedia.org/wiki/Barack_Obama' },
        dewiki: { title: 'Barack Obama', url: 'https://de.wikipedia.org/wiki/Barack_Obama' },
      },
      count: 2,
    };
    const blocks = wikidataGetSitelinks.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Q76');
    expect(text).toContain('2');
    expect(text).toContain('enwiki');
    expect(text).toContain('Barack Obama');
  });

  it('wikis_only filter: returns empty result with message when no Wikipedia links exist', async () => {
    mockFetchSitelinks.mockResolvedValue({
      enwikisource: {
        title: 'Barack Obama speeches',
        url: 'https://en.wikisource.org/wiki/Barack_Obama',
      },
    });

    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'Q76', wikis_only: true });
    const result = await wikidataGetSitelinks.handler(input, ctx);

    expect(result.count).toBe(0);
    expect(result.message).toContain('wikis_only');
  });

  it('returns message when sites filter matches nothing', async () => {
    mockFetchSitelinks.mockResolvedValue({});

    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'Q76', sites: ['zwwiki'] });
    const result = await wikidataGetSitelinks.handler(input, ctx);

    expect(result.count).toBe(0);
    expect(result.message).toBeDefined();
    expect(result.message).toContain('zwwiki');
  });

  /** #28: content[] rendered the first 30 sitelinks of Q76's 340. */
  it('carries every sitelink on both surfaces past the old 30-entry sample (#28)', async () => {
    const codes = Array.from({ length: 300 }, (_, i) => `l${i}wiki`);
    codes.push(...Array.from({ length: 40 }, (_, i) => `l${i}wikiquote`));
    mockFetchSitelinks.mockResolvedValue(
      Object.fromEntries(
        codes.map((code) => [code, { title: `Title ${code}`, url: `https://x.org/${code}` }]),
      ),
    );

    const result = await runToolContract(wikidataGetSitelinks, { id: 'Q76' });
    const structured = result.structuredContent as {
      count: number;
      sitelinks: Record<string, { title: string }>;
    };
    const text = result.content.map((b) => (b as { text: string }).text).join('\n');
    const rendered = text.split('\n').filter((line) => /^\*\*[a-z0-9_]+:\*\* \[/.test(line));

    expect(structured.count).toBe(340);
    expect(Object.keys(structured.sitelinks)).toHaveLength(340);
    expect(rendered).toHaveLength(340);
    for (const code of codes) expect(text).toContain(`**${code}:** [Title ${code}]`);
    expect(text).not.toContain('more sitelinks');
  });

  it('format: includes badge QIDs when present', () => {
    const output = {
      id: 'Q76',
      sitelinks: {
        enwiki: {
          title: 'Barack Obama',
          url: 'https://en.wikipedia.org/wiki/Barack_Obama',
          badges: ['Q17437798'],
        },
      },
      count: 1,
    };
    const blocks = wikidataGetSitelinks.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Q17437798');
  });

  /**
   * #52: a Wikipedia edition is known by its own URL's host, not by a site code ending in "wiki"
   * — ten non-Wikipedia codes end that way, and underscore codes name hyphenated hosts.
   */
  describe('Wikipedia edition test', () => {
    const fixture = {
      enwiki: { title: 'Lion', url: 'https://en.wikipedia.org/wiki/Lion' },
      be_x_oldwiki: { title: 'Леў', url: 'https://be-tarask.wikipedia.org/wiki/Леў' },
      zh_min_nanwiki: { title: 'Sai', url: 'https://zh-min-nan.wikipedia.org/wiki/Sai' },
      commonswiki: {
        title: 'Panthera leo',
        url: 'https://commons.wikimedia.org/wiki/Panthera_leo',
        badges: ['Q17437796'],
      },
      specieswiki: {
        title: 'Panthera leo',
        url: 'https://species.wikimedia.org/wiki/Panthera_leo',
      },
      wikidatawiki: { title: 'Q140', url: 'https://www.wikidata.org/wiki/Q140' },
      wikifunctionswiki: { title: 'Z1', url: 'https://www.wikifunctions.org/wiki/Z1' },
      enwikiquote: { title: 'Lions', url: 'https://en.wikiquote.org/wiki/Lions' },
    };
    const call = (args: Record<string, unknown>) =>
      runToolContract(wikidataGetSitelinks, args as never);
    type Structured = {
      count: number;
      sitelinks: Record<string, { title: string; url?: string; badges?: string[] }>;
      message?: string;
    };
    const structuredOf = (result: { structuredContent?: unknown }) =>
      result.structuredContent as Structured;
    const textOf = (result: { content: unknown[] }) =>
      result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

    it('wikis_only keeps exactly the Wikipedia editions, underscore codes included', async () => {
      mockFetchSitelinks.mockResolvedValue(fixture);

      const result = await call({ id: 'Q140', wikis_only: true });

      expect(Object.keys(structuredOf(result).sitelinks)).toEqual([
        'enwiki',
        'be_x_oldwiki',
        'zh_min_nanwiki',
      ]);
      expect(structuredOf(result).count).toBe(3);
      expect(textOf(result)).not.toContain('commons.wikimedia.org');
    });

    it('returns every sitelink unchanged without wikis_only or sites, url and badges included', async () => {
      // A copy taken before the call, so a handler that edits what upstream sent cannot pass.
      const expected = structuredClone(fixture);
      mockFetchSitelinks.mockResolvedValue(structuredClone(fixture));

      const result = await call({ id: 'Q140' });

      expect(structuredOf(result).sitelinks).toEqual(expected);
      expect(structuredOf(result).count).toBe(8);
      expect(structuredOf(result).sitelinks.commonswiki?.badges).toEqual(['Q17437796']);
      expect(textOf(result)).toContain('[Q17437796]');
    });

    it('an item whose only sitelink is mediawikiwiki has none under wikis_only', async () => {
      mockFetchSitelinks.mockResolvedValue({
        mediawikiwiki: {
          title: 'Extension:SecurePHP',
          url: 'https://www.mediawiki.org/wiki/Extension:SecurePHP',
        },
      });

      const result = await call({ id: 'Q123014743', wikis_only: true });

      expect(structuredOf(result).count).toBe(0);
      expect(structuredOf(result).message).toBe(
        'Q123014743 has no Wikipedia (wikis_only) sitelinks.',
      );
    });

    it('says a requested sitelink is not a Wikipedia edition rather than not found', async () => {
      mockFetchSitelinks.mockResolvedValue({ commonswiki: fixture.commonswiki });

      const result = await call({ id: 'Q140', sites: ['commonswiki'], wikis_only: true });

      expect(structuredOf(result).count).toBe(0);
      const message = structuredOf(result).message ?? '';
      expect(message).toContain('commonswiki');
      expect(message).toContain('not a Wikipedia edition');
      expect(message).not.toContain('found');
      expect(textOf(result)).toContain('not a Wikipedia edition');
    });

    it('names every requested sitelink that is not a Wikipedia edition', async () => {
      mockFetchSitelinks.mockResolvedValue({
        commonswiki: fixture.commonswiki,
        specieswiki: fixture.specieswiki,
      });

      const result = await call({
        id: 'Q140',
        sites: ['commonswiki', 'specieswiki'],
        wikis_only: true,
      });

      expect(structuredOf(result).count).toBe(0);
      expect(structuredOf(result).message).toBe(
        'The requested sitelinks commonswiki, specieswiki on Q140 are not Wikipedia editions; wikis_only returns Wikipedia editions only.',
      );
      expect(textOf(result)).toContain('commonswiki, specieswiki');
      expect(textOf(result)).toContain('are not Wikipedia editions');
    });

    it('keeps the requested Wikipedia edition when sites and wikis_only are combined', async () => {
      mockFetchSitelinks.mockResolvedValue({
        enwiki: fixture.enwiki,
        commonswiki: fixture.commonswiki,
      });

      const result = await call({ id: 'Q140', sites: ['enwiki', 'commonswiki'], wikis_only: true });

      expect(Object.keys(structuredOf(result).sitelinks)).toEqual(['enwiki']);
      expect(structuredOf(result).message).toBeUndefined();
    });

    it('excludes an entry without url from wikis_only, sorts it last, and renders it unlinked', async () => {
      mockFetchSitelinks.mockResolvedValue({
        frwiki: { title: 'Lion' },
        commonswiki: fixture.commonswiki,
        enwiki: fixture.enwiki,
      });

      const only = await call({ id: 'Q140', wikis_only: true });
      expect(Object.keys(structuredOf(only).sitelinks)).toEqual(['enwiki']);

      const all = await call({ id: 'Q140' });
      const lines = textOf(all)
        .split('\n')
        .filter((line) => line.startsWith('**') && line.includes(':** '));
      expect(lines.map((line) => line.slice(2, line.indexOf(':**')))).toEqual([
        'Count',
        'enwiki',
        'frwiki',
        'commonswiki',
      ]);
      expect(lines).toContain('**frwiki:** Lion');
      // Every URL in content[] is one structuredContent carries.
      const structuredUrls = Object.values(structuredOf(all).sitelinks).flatMap((s) =>
        s.url ? [s.url] : [],
      );
      const renderedUrls = [...textOf(all).matchAll(/\]\(<?([^)>]+)>?\)/g)].map((m) => m[1]);
      expect(renderedUrls.sort()).toEqual(structuredUrls.sort());
      expect(textOf(all)).not.toContain('fr.wikipedia.org');
    });

    it('sorts Wikipedia editions first by URL host, keeping upstream order within each group', () => {
      const blocks = wikidataGetSitelinks.format!({
        id: 'Q140',
        count: 4,
        sitelinks: {
          commonswiki: fixture.commonswiki,
          enwiki: fixture.enwiki,
          enwikiquote: fixture.enwikiquote,
          be_x_oldwiki: fixture.be_x_oldwiki,
        },
      });
      const codes = (blocks[0] as { text: string }).text
        .split('\n')
        .filter((line) => /^\*\*[a-z_]+:\*\* /.test(line))
        .map((line) => line.slice(2, line.indexOf(':**')));

      expect(codes).toEqual(['enwiki', 'be_x_oldwiki', 'commonswiki', 'enwikiquote']);
    });

    it('describes wikis_only without the site-code suffix test', () => {
      const description = wikidataGetSitelinks.input.shape.wikis_only.description ?? '';
      expect(description).not.toMatch(/ending in/i);
      expect(description).toContain('wikipedia.org');
    });
  });

  it('re-throws service errors that are not a not-found', async () => {
    mockFetchSitelinks.mockRejectedValue(new Error('Connection refused'));

    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'Q76' });
    await expect(wikidataGetSitelinks.handler(input, ctx)).rejects.toThrow('Connection refused');
  });

  it('security: P-ID injection attempt is rejected as not_an_item', async () => {
    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'P31' });
    await expect(wikidataGetSitelinks.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_an_item' },
    });
    expect(mockFetchSitelinks).not.toHaveBeenCalled();
  });

  it('security: malformed ID is rejected as not_an_item', async () => {
    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'notanid' });
    await expect(wikidataGetSitelinks.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_an_item' },
    });
    expect(mockFetchSitelinks).not.toHaveBeenCalled();
  });

  it('security: no env secret appears in sitelinks output', async () => {
    process.env['TEST_SITE_SECRET'] = 'site_secret_jkl654';
    mockFetchSitelinks.mockResolvedValue({
      enwiki: { title: 'Barack Obama', url: 'https://en.wikipedia.org/wiki/Barack_Obama' },
    });

    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'Q76' });
    const result = await wikidataGetSitelinks.handler(input, ctx);

    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('site_secret_jkl654');
    delete process.env['TEST_SITE_SECRET'];
  });
});
