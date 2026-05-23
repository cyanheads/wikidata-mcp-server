/**
 * @fileoverview Fetch Wikimedia sitelinks for a Wikidata entity.
 * @module mcp-server/tools/definitions/get-sitelinks.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getWikidataRestService,
  isQId,
  normalizeId,
} from '@/services/wikidata/wikidata-rest-service.js';

export const wikidataGetSitelinks = tool('wikidata_get_sitelinks', {
  title: 'Get Wikidata Sitelinks',
  description:
    'Fetch Wikipedia and Wikimedia project article URLs for a Wikidata item. ' +
    'A sitelink maps a site code (e.g., "enwiki") to a Wikipedia article title and URL. ' +
    'Major items can have 300+ sitelinks across languages. ' +
    'Use sites to filter to specific language editions, or wikis_only to return only Wikipedia links. ' +
    'Only Q-IDs (items) have sitelinks — properties (P-IDs) do not.',
  annotations: { readOnlyHint: true },

  input: z.object({
    id: z
      .string()
      .min(1)
      .describe(
        'Q-ID of the item (e.g., "Q76"). Only items have sitelinks; properties (P-IDs) are not supported.',
      ),
    sites: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Optional filter to specific site codes (e.g., ["enwiki", "frwiki", "dewiki"]). ' +
          'Omit to return all sitelinks.',
      ),
    wikis_only: z
      .boolean()
      .default(false)
      .describe(
        'When true, return only Wikipedia sitelinks (site codes ending in "wiki", e.g., "enwiki", "dewiki"). ' +
          'Excludes Wikisource, Wiktionary, Wikiquote, etc.',
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
      when: 'No item exists at this Q-ID.',
      recovery: 'Verify the Q-ID with wikidata_search_entities or wikidata_get_labels.',
    },
    {
      reason: 'not_an_item',
      code: JsonRpcErrorCode.InvalidParams,
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
        { ...ctx.recoveryFor('not_an_item') },
      );
    }

    const svc = getWikidataRestService();
    ctx.log.info('Fetching sitelinks', { id, sites: input.sites, wikis_only: input.wikis_only });

    let rawSitelinks: Record<string, { title: string; url?: string | null; badges?: string[] }>;
    try {
      rawSitelinks = await svc.fetchSitelinks(id, input.sites, ctx);
    } catch (err) {
      const e = err as { data?: { status?: number }; code?: number };
      if (e?.data?.status === 404 || e?.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('entity_not_found', `No item found for Q-ID "${id}".`, {
          ...ctx.recoveryFor('entity_not_found'),
        });
      }
      throw err;
    }

    // Apply wikis_only filter
    let sitelinks = rawSitelinks;
    if (input.wikis_only) {
      sitelinks = Object.fromEntries(
        Object.entries(rawSitelinks).filter(([code]) => code.endsWith('wiki')),
      );
    }

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
      const hint = input.sites?.length
        ? `None of the requested site codes (${input.sites.join(', ')}) were found on ${id}.`
        : input.wikis_only
          ? `${id} has no Wikipedia (wikis_only) sitelinks.`
          : `${id} has no sitelinks.`;
      return { id, sitelinks: {}, count: 0, message: hint };
    }

    return { id, sitelinks: normalized, count };
  },

  format: (result) => {
    const lines: string[] = [`## Sitelinks for ${result.id}`, `**Count:** ${result.count}`];

    if (result.message) {
      lines.push(`\n> ${result.message}`);
    }

    // Sort: Wikipedia editions first, then others
    const entries = Object.entries(result.sitelinks);
    const wikis = entries.filter(([code]) => code.endsWith('wiki'));
    const others = entries.filter(([code]) => !code.endsWith('wiki'));
    const sorted = [...wikis, ...others];

    for (const [code, sl] of sorted.slice(0, 30)) {
      const url =
        sl.url ??
        `https://${code.replace('wiki', '')}.wikipedia.org/wiki/${encodeURIComponent(sl.title)}`;
      lines.push(
        `**${code}:** [${sl.title}](${url})${sl.badges?.length ? ` [${sl.badges.join(', ')}]` : ''}`,
      );
    }

    if (sorted.length > 30) {
      lines.push(`… and ${sorted.length - 30} more sitelinks.`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
