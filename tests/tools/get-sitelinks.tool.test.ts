/**
 * @fileoverview Tests for wikidata_get_sitelinks tool.
 * @module tests/tools/get-sitelinks.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataGetSitelinks } from '@/mcp-server/tools/definitions/get-sitelinks.tool.js';

const mockFetchSitelinks = vi.fn();

vi.mock('@/services/wikidata/wikidata-rest-service.js', () => ({
  getWikidataRestService: () => ({ fetchSitelinks: mockFetchSitelinks }),
  isQId: (id: string) => /^[Qq]\d+$/.test(id),
  normalizeId: (id: string) => id.toUpperCase(),
}));

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

  it('throws entity_not_found when service returns 404', async () => {
    mockFetchSitelinks.mockRejectedValue({ data: { status: 404 } });

    const ctx = createMockContext({ errors: wikidataGetSitelinks.errors });
    const input = wikidataGetSitelinks.input.parse({ id: 'Q99999' });
    await expect(wikidataGetSitelinks.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'entity_not_found' },
    });
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

  it('format: constructs fallback URL when url is absent', () => {
    const output = {
      id: 'Q76',
      sitelinks: {
        frwiki: { title: 'Barack Obama' }, // no url
      },
      count: 1,
    };
    const blocks = wikidataGetSitelinks.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // Falls back to constructed URL from site code
    expect(text).toContain('frwiki');
    expect(text).toContain('Barack Obama');
  });

  it('re-throws non-404 service errors', async () => {
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
