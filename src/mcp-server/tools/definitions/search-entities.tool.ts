/**
 * @fileoverview Search Wikidata items or properties by text query.
 * @module mcp-server/tools/definitions/search-entities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { applyCountLimit } from '@/mcp-server/tools/count-limit.js';
import { DEFAULT_LANGUAGE, languageCode } from '@/mcp-server/tools/language-code.js';
import { getWikidataRestService } from '@/services/wikidata/wikidata-rest-service.js';

/** The search endpoint's page maximum; it answers a larger `limit` with 400. */
const PAGE_MAX = 500;

/**
 * How deep the search endpoint pages: it serves only the first 10,000 ranked results, answering
 * an offset past them with 500 `cirrussearch-offset-too-large` and a page that crosses the
 * window with just the results inside it.
 */
const RESULT_WINDOW = 10_000;

export const wikidataSearchEntities = tool('wikidata_search_entities', {
  title: 'Search Wikidata Entities',
  description:
    'Search Wikidata for items or properties by text query. Returns QIDs or PIDs with labels, descriptions, and match metadata indicating whether the hit was on a label or alias. Use type="item" for real-world concepts (people, places, works) and type="property" to find predicate P-IDs. The endpoint returns no total count: page by sending each page\'s nextOffset as offset until a page returns no results or no nextOffset. Only the first 10,000 results are reachable.',
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
    language: languageCode()
      .default(DEFAULT_LANGUAGE)
      .describe(
        'Wikidata language code for returned labels and descriptions (e.g., "en", "de", "zh-hant"). ' +
          'Case-insensitive; "_" is read as "-"; blank means "en".',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .default(10)
      .describe(
        `Results per page. Default 10; a value above ${PAGE_MAX}, the search endpoint's page maximum, returns at most ${PAGE_MAX} and says so.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(RESULT_WINDOW - 1)
      .default(0)
      .describe(
        "Pagination offset, 0–9,999: the endpoint serves only the first 10,000 results. Start at 0, then send each page's nextOffset.",
      ),
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
    cap: z.number().describe(`The limit in effect for this page, at most ${PAGE_MAX}.`),
    truncated: z
      .boolean()
      .optional()
      .describe('True when this page filled the limit. More results may follow at nextOffset.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'The offset to send for the next page: offset + limit. Present on every page that returned results while it stays below 10,000. It marks where to continue, not that more results exist — the endpoint returns no total, and a short page can still be followed by more. A walk ends at the first page with no results or no nextOffset.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for this page, every case that applies in one notice: no matches at offset 0, results that ended before this offset, a full page and where to continue, the 10,000-result window, or a limit served at the page maximum.',
      ),
  },

  errors: [
    {
      reason: 'invalid_search_parameter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The search endpoint refused a request parameter, in practice a language it does not search in such as "mul".',
      recovery:
        'Retry with a language code the search endpoint supports, such as "en" or "de"; "mul" labels entities but cannot be searched in. If the message names another parameter, correct that value.',
      thrownBy: 'service',
    },
  ],

  enrichmentTrailer: {
    notice: {
      render(value: string) {
        return `> ${escapeMarkdownInline(value)}`;
      },
    },
  },

  async handler(input, ctx) {
    const svc = getWikidataRestService();
    const limit = applyCountLimit(
      input.limit,
      PAGE_MAX,
      { field: 'limit', tool: 'wikidata_search_entities' },
      ctx,
    );
    ctx.log.info('Searching Wikidata entities', {
      query: input.query,
      type: input.type,
      language: input.language,
      limit: limit.applied,
      offset: input.offset,
    });

    const raw = await svc.search(
      input.query,
      input.type,
      input.language,
      limit.applied,
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

    /**
     * The end cannot be read off a page — no total, and a short page can still be followed by
     * more — so nextOffset says where to continue on every page with results, up to the window.
     */
    const next = input.offset + limit.applied;
    const atWindowEnd = results.length > 0 && next >= RESULT_WINDOW;
    const nextOffset = results.length > 0 && !atWindowEnd ? next : undefined;
    const full = results.length >= limit.applied;

    /** Every notice this page raises, joined into one: a second `notice()` replaces the first. */
    const notices: string[] = [];
    if (limit.clamped) {
      notices.push(
        `limit ${limit.requested} is above the search endpoint's page maximum of ${PAGE_MAX}; this page holds at most ${PAGE_MAX}.`,
      );
    }
    if (results.length === 0) {
      notices.push(
        input.offset === 0
          ? `No ${input.type}s matched "${input.query}" in language "${input.language}". Try broader terms or a different language code.`
          : `The ${input.type} results for "${input.query}" ended before offset ${input.offset}.`,
      );
    } else if (full) {
      notices.push(
        nextOffset === undefined
          ? `This page filled limit ${limit.applied}.`
          : `This page filled limit ${limit.applied}; continue with offset ${nextOffset}.`,
      );
    }
    if (atWindowEnd) {
      notices.push(
        `The search endpoint serves only the first ${RESULT_WINDOW.toLocaleString('en-US')} results, so no page follows this one.`,
      );
    }

    const shown = { shown: results.length, cap: limit.applied };
    const notice = notices.join(' ');
    if (full) {
      ctx.enrich.truncated({ ...shown, guidance: notice });
    } else {
      ctx.enrich(shown);
      if (notice) ctx.enrich.notice(notice);
    }
    ctx.enrich({
      effectiveQuery: input.query,
      searchType: input.type,
      language: input.language,
      ...(nextOffset === undefined ? {} : { nextOffset }),
    });

    return { results };
  },

  format: (result) => {
    const lines: string[] = [`**Results:** ${result.results.length}`];

    for (const item of result.results) {
      lines.push('');
      lines.push(`## ${item.id}`);
      lines.push(`**Label:** ${escapeMarkdownInline(item.label || item.id)}`);
      lines.push(`**ID:** ${item.id}`);
      if (item.description)
        lines.push(`**Description:** ${escapeMarkdownInline(item.description)}`);
      lines.push(`**Match:** ${item.match.type} (${item.match.language})`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
