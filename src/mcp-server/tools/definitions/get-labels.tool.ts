/**
 * @fileoverview Batch-resolve QIDs/PIDs to human-readable labels and descriptions.
 * @module mcp-server/tools/definitions/get-labels.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getWikidataRestService, normalizeId } from '@/services/wikidata/wikidata-rest-service.js';

export const wikidataGetLabels = tool('wikidata_get_labels', {
  title: 'Get Wikidata Labels',
  description:
    'Resolve one or more QIDs or PIDs to their human-readable labels and descriptions. ' +
    'Lightweight — returns no claim data. Supports up to 50 IDs per call (batched automatically). ' +
    'Designed for the common agent pattern: receive QIDs from a SPARQL query, then humanize them.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    ids: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .describe('Q-IDs (e.g., "Q76") or P-IDs (e.g., "P31") to resolve. 1–50 IDs per call.'),
    languages: z
      .array(z.string().min(1))
      .min(1)
      .default(['en'])
      .describe(
        'BCP 47 language codes for returned labels and descriptions (e.g., ["en", "de", "fr"]). ' +
          'A language with no label of its own falls back to the entity\'s multilingual ("mul") value, ' +
          'returned under the requested code.',
      ),
  }),

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
      .describe('IDs from the request that did not return data (not found or invalid).'),
    languages: z.array(z.string()).describe('The language codes that were requested.'),
  }),

  errors: [
    {
      reason: 'invalid_ids',
      code: JsonRpcErrorCode.ValidationError,
      when: 'One or more IDs in the array are not valid Q-IDs or P-IDs.',
      recovery:
        'All IDs must match Q+digits or P+digits format (e.g., Q76, P31). Use wikidata_search_entities to find valid IDs.',
    },
  ],

  async handler(input, ctx) {
    // Validate all IDs
    const normalized = input.ids.map(normalizeId);
    const invalid = normalized.filter((id) => !/^[QP]\d+$/.test(id));
    if (invalid.length > 0) {
      throw ctx.fail(
        'invalid_ids',
        `Invalid Wikidata IDs: ${invalid.join(', ')}. IDs must be Q+digits or P+digits.`,
        { invalid, ...ctx.recoveryFor('invalid_ids') },
      );
    }

    const svc = getWikidataRestService();
    ctx.log.info('Resolving labels', { count: normalized.length, languages: input.languages });

    const labelData = await svc.fetchLabels(normalized, input.languages, ctx);

    const notFound = normalized.filter((id) => !labelData[id]);

    return {
      entities: labelData,
      found: Object.keys(labelData).length,
      notFound,
      languages: input.languages,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**Languages:** ${result.languages.join(', ')} | **Found:** ${result.found}`,
    ];

    if (result.notFound.length > 0) {
      lines.push(`**Not found:** ${result.notFound.join(', ')}`);
    }

    lines.push('');
    for (const [id, data] of Object.entries(result.entities)) {
      const enLabel = data.labels.en ?? Object.values(data.labels)[0] ?? id;
      const enDesc = data.descriptions.en ?? Object.values(data.descriptions)[0] ?? '';
      lines.push(`**${id}:** ${enLabel}${enDesc ? ` — ${enDesc}` : ''}`);
      // Show a bounded sample of the other requested languages, disclosing the full count
      // when the sample is cut — structuredContent always carries every language returned.
      const otherEntries = Object.entries(data.labels).filter(([lang]) => lang !== 'en');
      const otherLangs = otherEntries.slice(0, 3).map(([lang, lbl]) => `${lang}: ${lbl}`);
      if (otherLangs.length) {
        const total = Object.keys(data.labels).length;
        lines.push(
          `  ${otherLangs.join(' | ')}${otherEntries.length > 3 ? ` … (${total} total)` : ''}`,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
