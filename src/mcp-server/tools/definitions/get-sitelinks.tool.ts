/**
 * @fileoverview Fetch Wikimedia sitelinks for a Wikidata entity.
 * @module mcp-server/tools/definitions/get-sitelinks.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import {
  getWikidataRestService,
  isEntityNotFoundError,
  isQId,
  normalizeId,
} from '@/services/wikidata/wikidata-rest-service.js';

/** A Wikipedia edition's host: one label under wikipedia.org (`en`, `be-tarask`, `simple`). */
const WIKIPEDIA_HOST = /^[a-z0-9-]+\.wikipedia\.org$/;

/**
 * True when a sitelink is a Wikipedia edition: the host of its own URL is
 * `<edition>.wikipedia.org`. The site code cannot tell — ten non-Wikipedia codes end in "wiki"
 * (commonswiki, specieswiki, wikidatawiki, …), and underscore codes name hyphenated hosts
 * (be_x_oldwiki is be-tarask.wikipedia.org). An entry without a URL does not count as one.
 */
const isWikipediaEdition = (sitelink: { url?: string | null | undefined }): boolean =>
  WIKIPEDIA_HOST.test(URL.parse(sitelink.url ?? '')?.hostname ?? '');

export const wikidataGetSitelinks = tool('wikidata_get_sitelinks', {
  title: 'Get Wikidata Sitelinks',
  description:
    'Fetch Wikipedia and other Wikimedia project article URLs for a Wikidata item. A sitelink maps a site code (e.g., "enwiki", "commonswiki") to an article title and URL. Major items can have 300+ sitelinks across languages. Use sites to filter to specific site codes, or wikis_only to return only Wikipedia editions. Only Q-IDs (items) have sitelinks — properties (P-IDs) do not.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    id: z
      .string()
      .min(1)
      .describe(
        'Q-ID of the item (e.g., "Q76"), bare or as an entity URI or wd: form (e.g., "http://www.wikidata.org/entity/Q76", "wd:Q76"). Only items have sitelinks; properties (P-IDs) are not supported.',
      ),
    sites: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Optional filter to specific site codes (e.g., ["enwiki", "frwiki", "commonswiki"]), matched in any case with surrounding whitespace ignored. Omit to return all sitelinks.',
      ),
    wikis_only: z
      .boolean()
      .default(false)
      .describe(
        'When true, return only Wikipedia editions: sitelinks whose URL is on a <subdomain>.wikipedia.org host, such as enwiki (en.wikipedia.org) or be_x_oldwiki (be-tarask.wikipedia.org). Excludes Wikimedia Commons, Wikispecies, Wikisource, Wiktionary, Wikiquote, and every other project.',
      ),
  }),

  output: z.object({
    id: z.string().describe('The Q-ID whose sitelinks were fetched.'),
    sitelinks: z
      .record(
        z.string(),
        z.object({
          title: z.string().describe('Article title on that wiki.'),
          url: z.string().optional().describe('Full URL to the article. Omitted when unavailable.'),
          badges: z
            .array(z.string())
            .optional()
            .describe('Quality badge QIDs (e.g., "Q17437798" = featured article).'),
        }),
      )
      .describe(
        'Map of site code to sitelink metadata. Empty when the entity has no matching sitelinks.',
      ),
    count: z.number().describe('Number of sitelinks returned.'),
    message: z
      .string()
      .optional()
      .describe(
        'Informational note when no sitelinks were found. Absent when sitelinks are present.',
      ),
  }),

  errors: [
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No item exists at this Q-ID — either unassigned or out of range.',
      recovery: 'Verify the Q-ID with wikidata_search_entities or wikidata_get_labels.',
    },
    {
      reason: 'not_an_item',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A P-ID was supplied — only items (Q-IDs) have sitelinks.',
      recovery: 'Supply a Q-ID (Q followed by digits). Properties do not have Wikipedia sitelinks.',
    },
  ],

  async handler(input, ctx) {
    const id = normalizeId(input.id);

    if (!isQId(id)) {
      throw ctx.fail(
        'not_an_item',
        `"${input.id}" is not a Q-ID. Only Wikidata items have sitelinks.`,
      );
    }

    const svc = getWikidataRestService();
    ctx.log.info('Fetching sitelinks', { id, sites: input.sites, wikis_only: input.wikis_only });

    let rawSitelinks: Record<string, { title: string; url?: string | null; badges?: string[] }>;
    try {
      rawSitelinks = await svc.fetchSitelinks(id, input.sites, ctx);
    } catch (err) {
      if (isEntityNotFoundError(err)) {
        throw ctx.fail('entity_not_found', `No item found for Q-ID "${id}".`);
      }
      throw err;
    }

    const sitelinks = input.wikis_only
      ? Object.fromEntries(Object.entries(rawSitelinks).filter(([, sl]) => isWikipediaEdition(sl)))
      : rawSitelinks;

    const normalized = Object.fromEntries(
      Object.entries(sitelinks).map(([code, sl]) => [
        code,
        {
          title: sl.title,
          ...(sl.url ? { url: sl.url } : {}),
          ...(sl.badges?.length ? { badges: sl.badges } : {}),
        },
      ]),
    );

    const count = Object.keys(normalized).length;

    if (count === 0) {
      // With sites set, a requested code present upstream was dropped only by wikis_only.
      const present = Object.keys(rawSitelinks);
      const hint = !input.sites?.length
        ? input.wikis_only
          ? `${id} has no Wikipedia (wikis_only) sitelinks.`
          : `${id} has no sitelinks.`
        : present.length === 0
          ? `None of the requested site codes (${input.sites.join(', ')}) were found on ${id}.`
          : present.length === 1
            ? `The requested sitelink ${present[0]} on ${id} is not a Wikipedia edition; wikis_only returns Wikipedia editions only.`
            : `The requested sitelinks ${present.join(', ')} on ${id} are not Wikipedia editions; wikis_only returns Wikipedia editions only.`;
      return { id, sitelinks: {}, count: 0, message: hint };
    }

    return { id, sitelinks: normalized, count };
  },

  format: (result) => {
    const lines: string[] = [`## Sitelinks for ${result.id}`, `**Count:** ${result.count}`];

    if (result.message) {
      lines.push(`\n> ${escapeMarkdownInline(result.message)}`);
    }

    // Wikipedia editions first, then every other project, each group in upstream order.
    const entries = Object.entries(result.sitelinks);
    const sorted = [
      ...entries.filter(([, sl]) => isWikipediaEdition(sl)),
      ...entries.filter(([, sl]) => !isWikipediaEdition(sl)),
    ];

    for (const [code, sl] of sorted) {
      // No URL upstream means none here: a link built from the site code would be content[]-only.
      const title = sl.url ? markdownLink(sl.title, sl.url) : escapeMarkdownInline(sl.title);
      lines.push(`**${code}:** ${title}${sl.badges?.length ? ` [${sl.badges.join(', ')}]` : ''}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
