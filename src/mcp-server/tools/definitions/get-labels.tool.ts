/**
 * @fileoverview Batch-resolve QIDs/PIDs to human-readable labels and descriptions.
 * @module mcp-server/tools/definitions/get-labels.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { applyCountLimit } from '@/mcp-server/tools/count-limit.js';
import { DEFAULT_LANGUAGE, languageCodes } from '@/mcp-server/tools/language-code.js';
import { getWikidataRestService, normalizeId } from '@/services/wikidata/wikidata-rest-service.js';

/** Most distinct IDs one call resolves: 10 `wbgetentities` requests of 50. */
const ID_CAP = 500;

/** Most entries `ids` accepts — a guard against absurd input, far past what one call resolves. */
const MAX_ENTRIES = 10_000;

/** Most languages one `wbgetentities` request accepts; a 51st fails upstream as `toomanyvalues`. */
const MAX_LANGUAGES = 50;

export const wikidataGetLabels = tool('wikidata_get_labels', {
  title: 'Get Wikidata Labels',
  description: `Resolve QIDs or PIDs to their human-readable labels and descriptions, with no claim data. Resolves up to ${ID_CAP} distinct IDs per call, batched automatically; distinct IDs past the first ${ID_CAP} come back in deferredIds to send in a follow-up call. Accepts bare IDs (Q76), entity URIs (http://www.wikidata.org/entity/Q76), and wd:Q76 — the forms wikidata_sparql_query returns — so its results can be humanized as they are.`,
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    ids: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_ENTRIES)
      .describe(
        `Q-IDs (e.g., "Q76") or P-IDs (e.g., "P31") to resolve, bare or as an entity URI or wd: form (e.g., "http://www.wikidata.org/entity/Q76", "wd:Q76"). Up to ${MAX_ENTRIES.toLocaleString('en-US')} entries; duplicates count once, the first ${ID_CAP} distinct IDs resolve, and the rest come back in deferredIds. A malformed entry is returned in invalid without failing the call.`,
      ),
    languages: languageCodes([DEFAULT_LANGUAGE])
      .max(MAX_LANGUAGES)
      .default([DEFAULT_LANGUAGE])
      .describe(
        `Wikidata language codes for returned labels and descriptions (e.g., ["en", "de", "fr"]), up to ${MAX_LANGUAGES}. Case-insensitive; "_" is read as "-"; blank entries are dropped, and an empty list means ["en"]. A language with no label of its own falls back to the entity's multilingual ("mul") value, returned under the requested code.`,
      ),
  }),
  // Sibling tools spell these singular; a lone string sent under either is wrapped as a one-element array.
  inputAliases: { id: 'ids', language: 'languages' },

  output: z.object({
    entities: z
      .record(
        z.string(),
        z.object({
          labels: z
            .record(z.string(), z.string())
            .describe(
              'Map of language code to label string. Keys match the requested languages that have data.',
            ),
          descriptions: z
            .record(z.string(), z.string())
            .describe(
              'Map of language code to description string. Keys match the requested languages that have data.',
            ),
        }),
      )
      .describe('Map of entity ID to labels and descriptions. IDs that were not found are absent.'),
    found: z.number().describe('Count of IDs that returned data.'),
    notFound: z
      .array(z.string())
      .describe(
        'Well-formed IDs that were looked up and returned no entity (unassigned or out of range), each once.',
      ),
    invalid: z
      .array(z.string())
      .optional()
      .describe(
        'Entries that are not a Q-ID or P-ID in any accepted form, echoed as sent and never looked up. Absent when every entry is well-formed.',
      ),
    deferredIds: z
      .array(z.string())
      .optional()
      .describe(
        `Distinct IDs past the first ${ID_CAP}, in input order, not looked up in this call — send them in another call. Absent when every ID fit.`,
      ),
    languages: z.array(z.string()).describe('The language codes that were requested.'),
    unrecognizedLanguages: z
      .array(z.string())
      .optional()
      .describe('Requested codes Wikidata does not recognize for labels and descriptions.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Explains deferred IDs or which requested language codes Wikidata did not recognize.',
      ),
  },

  errors: [
    {
      reason: 'invalid_ids',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No entry in the array is a Q-ID or P-ID, bare or as an entity URI or wd: form.',
      recovery:
        'Send Q+digits or P+digits IDs (e.g., Q76, P31), bare or as http://www.wikidata.org/entity/Q76 or wd:Q76. Use wikidata_search_entities to find an ID by name.',
    },
  ],

  async handler(input, ctx) {
    const distinct = new Set<string>();
    const invalid = new Set<string>();
    for (const entry of input.ids) {
      const id = normalizeId(entry);
      if (/^[QP]\d+$/.test(id)) distinct.add(id);
      else invalid.add(entry);
    }
    if (distinct.size === 0) {
      throw ctx.fail(
        'invalid_ids',
        `No valid Wikidata IDs in the request: ${[...invalid].join(', ')}. IDs must be Q+digits or P+digits.`,
        { invalid: [...invalid] },
      );
    }

    const { applied } = applyCountLimit(
      distinct.size,
      ID_CAP,
      { field: 'ids', tool: 'wikidata_get_labels' },
      ctx,
    );
    const ids = [...distinct];
    const resolving = ids.slice(0, applied);
    const deferredIds = ids.slice(applied);

    ctx.log.info('Resolving labels', {
      count: resolving.length,
      deferred: deferredIds.length,
      invalid: invalid.size,
      languages: input.languages,
    });
    const { entities, unrecognizedLanguages } = await getWikidataRestService().fetchLabels(
      resolving,
      input.languages,
      ctx,
    );

    const notices: string[] = [];
    if (deferredIds.length > 0) {
      notices.push(
        `Resolved the first ${applied} of ${ids.length} distinct IDs, the per-call cap. Call again with the ${deferredIds.length} in deferredIds for the rest.`,
      );
    }
    if (unrecognizedLanguages.length > 0) {
      notices.push(
        `Wikidata did not recognize these language codes for labels and descriptions: ${unrecognizedLanguages.join(', ')}. Use term-language codes such as en or fr.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      entities,
      found: Object.keys(entities).length,
      notFound: resolving.filter((id) => !entities[id]),
      ...(invalid.size > 0 ? { invalid: [...invalid] } : {}),
      ...(deferredIds.length > 0 ? { deferredIds } : {}),
      languages: input.languages,
      ...(unrecognizedLanguages.length > 0 ? { unrecognizedLanguages } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**Languages:** ${result.languages.join(', ')} | **Found:** ${result.found}`,
    ];

    if (result.notFound.length > 0) {
      lines.push(`**Not found:** ${result.notFound.join(', ')}`);
    }
    if (result.invalid) {
      lines.push(`**Invalid:** ${result.invalid.map(escapeMarkdownInline).join(', ')}`);
    }
    if (result.deferredIds) {
      lines.push(`**Deferred:** ${result.deferredIds.join(', ')}`);
    }
    if (result.unrecognizedLanguages) {
      lines.push(`**Unrecognized languages:** ${result.unrecognizedLanguages.join(', ')}`);
    }

    lines.push('');
    for (const [id, data] of Object.entries(result.entities)) {
      const availableLanguages = [
        ...new Set([...Object.keys(data.labels), ...Object.keys(data.descriptions)]),
      ];
      const primaryLanguage = availableLanguages.includes('en') ? 'en' : availableLanguages[0];
      const primaryLabel = primaryLanguage ? data.labels[primaryLanguage] : undefined;
      const primaryDescription = primaryLanguage ? data.descriptions[primaryLanguage] : undefined;
      lines.push(
        `**${id}:** ${escapeMarkdownInline(primaryLabel ?? id)}${primaryDescription ? ` — ${escapeMarkdownInline(primaryDescription)}` : ''}`,
      );
      // Every other returned language, one line each — the same entries structuredContent carries.
      for (const lang of availableLanguages) {
        if (lang === primaryLanguage) continue;
        const description = data.descriptions[lang];
        lines.push(
          `  ${lang}: ${escapeMarkdownInline(data.labels[lang] ?? id)}${description ? ` — ${escapeMarkdownInline(description)}` : ''}`,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
