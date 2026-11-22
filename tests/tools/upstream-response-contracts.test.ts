/** Live API response shapes exercised through the REST service and tool responses. */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataGetLabels } from '@/mcp-server/tools/definitions/get-labels.tool.js';
import { wikidataGetSitelinks } from '@/mcp-server/tools/definitions/get-sitelinks.tool.js';
import { wikidataGetStatements } from '@/mcp-server/tools/definitions/get-statements.tool.js';
import { initWikidataRestService } from '@/services/wikidata/wikidata-rest-service.js';

const mockFetch = vi.fn();
const json = (value: unknown) => Response.json(value);
const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
const languageWarning = (...values: string[]) => ({
  code: 'unrecognizedvalues',
  text: 'Unrecognized language values',
  data: { values },
  module: 'wbgetentities',
});

const sitelinks = {
  abstractwiki: { title: 'Q296', url: 'https://abstract.wikipedia.org/wiki/Q296' },
  simplewiki: { title: 'Claude Monet', url: 'https://simple.wikipedia.org/wiki/Claude_Monet' },
  be_x_oldwiki: { title: 'Клёд Манэ', url: 'https://be-tarask.wikipedia.org/wiki/Клёд_Манэ' },
  commonswiki: { title: 'Claude Monet', url: 'https://commons.wikimedia.org/wiki/Claude_Monet' },
};

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  initWikidataRestService({} as never, {} as never);
});

afterEach(() => vi.unstubAllGlobals());

describe('Wikidata upstream response contracts', () => {
  it('counts a found entity with no labels in a recognized language without a warning', async () => {
    mockFetch.mockResolvedValueOnce(json({ entities: { Q76: { id: 'Q76' } } }));
    const result = await runToolContract(wikidataGetLabels, { ids: ['Q76'], languages: ['fr'] });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      entities: { Q76: { labels: {}, descriptions: {} } },
      found: 1,
      notFound: [],
      languages: ['fr'],
    });
    expect(text(result)).toContain('**Q76:** Q76');
  });

  it('returns an explicitly requested Abstract Wikipedia link without the edition filter', async () => {
    mockFetch.mockResolvedValueOnce(json(sitelinks));
    const result = await runToolContract(wikidataGetSitelinks, {
      id: 'Q296',
      sites: ['abstractwiki'],
    });
    expect(result.structuredContent).toMatchObject({
      count: 1,
      sitelinks: { abstractwiki: sitelinks.abstractwiki },
    });
    expect(text(result)).toContain('https://abstract.wikipedia.org/wiki/Q296');
  });

  it('preserves recognized label results, invalid IDs, and ID deferral alongside a language warning', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      const ids = new URL(url).searchParams.get('ids')?.split('|');
      return json({
        warnings: [
          languageWarning('zzzzzzzz', 'fr-ca'),
          { ...languageWarning('fr'), module: 'main' },
        ],
        entities: ids?.includes('Q76')
          ? { Q76: { id: 'Q76', labels: { en: { language: 'en', value: 'Barack Obama' } } } }
          : {},
      });
    });
    const ids = ['Q76', 'invalid', ...Array.from({ length: 500 }, (_, i) => `Q${i + 101}`)];
    const result = await runToolContract(wikidataGetLabels, {
      ids,
      languages: ['en', 'FR_CA', 'zzzzzzzz', 'fr'],
    });
    expect(result.structuredContent).toMatchObject({
      entities: { Q76: { labels: { en: 'Barack Obama' } } },
      found: 1,
      invalid: ['invalid'],
      deferredIds: ['Q600'],
      languages: ['en', 'fr-ca', 'zzzzzzzz', 'fr'],
      unrecognizedLanguages: ['fr-ca', 'zzzzzzzz'],
      notice: expect.stringContaining('deferredIds'),
    });
    expect(result.structuredContent).toMatchObject({
      notice: expect.stringContaining('fr-ca, zzzzzzzz'),
    });
    expect(text(result)).toContain('**Unrecognized languages:** fr-ca, zzzzzzzz');
    expect(text(result)).toContain('Call again with the 1 in deferredIds');
    expect(text(result)).toContain('Barack Obama');
    expect(mockFetch).toHaveBeenCalledTimes(10);
  });

  it('returns empty term maps and retains found IDs when the API discards the whole language filter', async () => {
    mockFetch.mockResolvedValueOnce(
      json({
        warnings: [languageWarning('fr-ca')],
        entities: {
          Q76: {
            id: 'Q76',
            labels: { en: { language: 'en', value: 'Barack Obama' } },
            descriptions: { en: { language: 'en', value: 'American politician' } },
          },
        },
      }),
    );
    const result = await runToolContract(wikidataGetLabels, { ids: ['Q76'], languages: ['fr-ca'] });
    expect(result.structuredContent).toMatchObject({
      found: 1,
      notFound: [],
      unrecognizedLanguages: ['fr-ca'],
    });
    expect(result.structuredContent).toHaveProperty('entities', {
      Q76: { labels: {}, descriptions: {} },
    });
    expect(text(result)).not.toContain('Barack Obama');
  });

  it('marks statements unlabelled when the requested language was explicitly rejected', async () => {
    mockFetch.mockResolvedValueOnce(
      json({
        P106: [
          {
            id: 'Q42$occupation',
            rank: 'normal',
            property: { id: 'P106', data_type: 'wikibase-item' },
            value: { type: 'value', content: 'Q214917' },
          },
        ],
      }),
    );
    mockFetch.mockResolvedValueOnce(
      json({
        warnings: [languageWarning('fr-ca')],
        entities: {
          Q214917: { id: 'Q214917', labels: { en: { language: 'en', value: 'playwright' } } },
        },
      }),
    );
    const result = await runToolContract(wikidataGetStatements, {
      id: 'Q42',
      properties: ['P106'],
      language: 'fr-ca',
    });
    expect(result.structuredContent).toMatchObject({
      kind: 'full',
      labelsResolved: false,
      statements: { P106: [{ value: { qid: 'Q214917' } }] },
      notice: expect.stringContaining('fr-ca'),
    });
    expect(text(result)).toContain('**Labels resolved:** false');
    expect(text(result)).toContain('fr-ca');
    expect(text(result)).toContain('Q214917');
  });

  it('filters Abstract Wikipedia out of the edition view while keeping real editions', async () => {
    mockFetch.mockResolvedValueOnce(json(sitelinks));
    const result = await runToolContract(wikidataGetSitelinks, { id: 'Q296', wikis_only: true });
    expect(result.structuredContent).toEqual({
      id: 'Q296',
      count: 2,
      sitelinks: { simplewiki: sitelinks.simplewiki, be_x_oldwiki: sitelinks.be_x_oldwiki },
    });
    expect(text(result)).not.toContain('abstract.wikipedia.org');
    expect(text(result)).toContain('https://simple.wikipedia.org');
  });

  it('distinguishes an explicit site excluded by the edition filter from a missing site', async () => {
    mockFetch.mockResolvedValueOnce(json(sitelinks));
    const result = await runToolContract(wikidataGetSitelinks, {
      id: 'Q296',
      sites: ['abstractwiki'],
      wikis_only: true,
    });
    expect(result.structuredContent).toMatchObject({
      count: 0,
      message: expect.stringContaining('abstractwiki on Q296 is not a Wikipedia edition'),
    });
    expect(text(result)).toContain('abstractwiki on Q296 is not a Wikipedia edition');
  });

  it('formats Abstract Wikipedia after the editions without dropping the link', async () => {
    mockFetch.mockResolvedValueOnce(json(sitelinks));
    const result = await runToolContract(wikidataGetSitelinks, { id: 'Q296' });
    const rendered = text(result);
    expect(rendered).toContain('https://abstract.wikipedia.org/wiki/Q296');
    expect(rendered).toContain('**simplewiki:**');
    expect(rendered).toContain('**be_x_oldwiki:**');
    expect(rendered.indexOf('**simplewiki:**')).toBeLessThan(rendered.indexOf('**abstractwiki:**'));
    expect(rendered.indexOf('**be_x_oldwiki:**')).toBeLessThan(
      rendered.indexOf('**abstractwiki:**'),
    );
  });
});
