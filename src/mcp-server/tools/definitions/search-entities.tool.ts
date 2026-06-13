/**
 * @fileoverview Search Wikidata items or properties by text query.
 * @module mcp-server/tools/definitions/search-entities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getWikidataRestService } from '@/services/wikidata/wikidata-rest-service.js';

export const wikidataSearchEntities = tool('wikidata_search_entities', {
  title: 'Search Wikidata Entities',
  description:
    'Search Wikidata for items or properties by text query. Returns QIDs or PIDs with labels, descriptions, ' +
    'and match metadata indicating whether the hit was on a label or alias. ' +
    'Use type="item" for real-world concepts (people, places, works) and type="property" to find predicate P-IDs. ' +
    'The API returns no total count — pagination is offset-based with no result ceiling indicator.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe('Search terms to match against entity labels, aliases, and descriptions.'),
    type: z
      .enum(['item', 'property'])
      .default('item')
      .describe(
        'Entity type to search. Use "item" for Q-IDs (people, places, concepts) or "property" for P-IDs (predicates).',
      ),
    language: z
      .string()
      .default('en')
      .describe(
        'BCP 47 language code for returned labels and descriptions (e.g., "en", "de", "zh").',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum number of results to return. Range: 1–50.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Pagination offset. Start at 0; increment by limit to page through results.'),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            id: z.string().describe('Q-ID (e.g., "Q76") or P-ID (e.g., "P31") of the entity.'),
            label: z
              .string()
              .describe('Display label in the requested language, or empty string if unavailable.'),
            description: z
              .string()
              .describe(
                'Short description in the requested language, or empty string if unavailable.',
              ),
            match: z
              .object({
                type: z
                  .string()
                  .describe(
                    'Match type: "label" for a direct label hit, "alias" for an alias hit.',
                  ),
                language: z.string().describe('Language of the matched string.'),
              })
              .describe('Metadata about how this result matched the query.'),
          })
          .describe(
            'A single search result with entity ID, label, description, and match metadata.',
          ),
      )
      .describe('Ranked list of matching entities. Empty when no results found.'),
  }),

  // Agent-facing search context — the query as executed, type, language, pagination counts,
  // truncation disclosure, and recovery guidance for empty results. Reaches both structuredContent and content[].
  enrichment: {
    effectiveQuery: z.string().describe('The search query that was executed.'),
    searchType: z.string().describe('The entity type that was searched ("item" or "property").'),
    language: z.string().describe('The language used for label and description display.'),
    shown: z.number().describe('Number of results returned on this page.'),
    cap: z.number().describe('The limit parameter in effect.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when results were capped at the limit. The Wikidata search API returns no total count — use offset pagination to retrieve more.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when results are empty — echoes filters and suggests how to broaden. Absent when results are present.',
      ),
  },

  async handler(input, ctx) {
    const svc = getWikidataRestService();
    ctx.log.info('Searching Wikidata entities', {
      query: input.query,
      type: input.type,
      language: input.language,
      limit: input.limit,
      offset: input.offset,
    });

    const raw = await svc.search(
      input.query,
      input.type,
      input.language,
      input.limit,
      input.offset,
      ctx,
    );

    const results = raw.map((r) => ({
      id: r.id,
      label: r['display-label']?.value ?? '',
      description: r.description?.value ?? '',
      match: {
        type: r.match?.type ?? 'label',
        language: r.match?.language ?? input.language,
      },
    }));

    const atCap = results.length >= input.limit;
    if (atCap) {
      ctx.enrich.truncated({ shown: results.length, cap: input.limit });
    } else {
      ctx.enrich({ shown: results.length, cap: input.limit });
    }
    ctx.enrich({
      effectiveQuery: input.query,
      searchType: input.type,
      language: input.language,
    });

    if (results.length === 0) {
      ctx.enrich.notice(
        `No ${input.type}s matched "${input.query}" in language "${input.language}". Try broader terms or a different language code.`,
      );
    }

    return { results };
  },

  format: (result) => {
    const lines: string[] = [`**Results:** ${result.results.length}`];

    for (const item of result.results) {
      lines.push('');
      lines.push(`## ${item.label || item.id}`);
      lines.push(`**ID:** ${item.id}`);
      if (item.description) lines.push(`**Description:** ${item.description}`);
      lines.push(`**Match:** ${item.match.type} (${item.match.language})`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
