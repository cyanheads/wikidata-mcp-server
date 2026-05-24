/**
 * @fileoverview Fetch a Wikidata entity by QID or PID with field selection.
 * @module mcp-server/tools/definitions/get-entity.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getWikidataRestService,
  isPId,
  isQId,
  normalizeId,
} from '@/services/wikidata/wikidata-rest-service.js';

const FIELD_ENUM = z.enum(['labels', 'descriptions', 'aliases', 'statements', 'sitelinks']);

export const wikidataGetEntity = tool('wikidata_get_entity', {
  title: 'Get Wikidata Entity',
  description:
    'Fetch a Wikidata entity (item or property) by QID or PID. ' +
    'Use the fields parameter to trim what is returned to the caller — major items can be large. ' +
    'Omit fields to get all data. ' +
    'Q-IDs (e.g. Q76) fetch items; P-IDs (e.g. P31) fetch properties from the correct endpoint automatically. ' +
    'Use wikidata_get_statements for deep claim traversal with label resolution.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    id: z
      .string()
      .min(1)
      .describe(
        'Q-ID (e.g., "Q76") or P-ID (e.g., "P31"). Case-insensitive — normalized to uppercase.',
      ),
    fields: z
      .array(FIELD_ENUM)
      .optional()
      .describe(
        'Fields to include in the response. Options: "labels", "descriptions", "aliases", "statements", "sitelinks". ' +
          'Omit for all fields.',
      ),
    languages: z
      .array(z.string())
      .optional()
      .describe(
        'Language codes to include in labels, descriptions, and aliases (e.g., ["en", "de"]). ' +
          'Omit to return all available languages.',
      ),
  }),

  output: z.object({
    id: z.string().describe('Normalized entity ID (e.g., "Q76" or "P31").'),
    type: z.string().describe('Entity type: "item" or "property".'),
    data_type: z
      .string()
      .optional()
      .describe(
        'Property data type (e.g., "wikibase-item", "external-id"). Present on properties only.',
      ),
    labels: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Map of language code to label string (e.g., {"en": "Barack Obama", "de": "Barack Obama"}).',
      ),
    descriptions: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Map of language code to description string (e.g., {"en": "44th President of the United States"}).',
      ),
    aliases: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe(
        'Map of language code to list of alias strings (e.g., {"en": ["Barack H. Obama", "President Obama"]}).',
      ),
    statements: z
      .record(z.string(), z.array(z.object({}).passthrough()))
      .optional()
      .describe(
        'Map of property ID to array of raw statement objects. Use wikidata_get_statements for resolved claims with label resolution.',
      ),
    // Sitelink values are from a dynamic external API — passthrough preserves all nested fields
    // (title, url, badges) in structuredContent without aspirational per-field typing.
    sitelinks: z
      .record(z.string(), z.object({}).passthrough())
      .optional()
      .describe(
        'Map of site code (e.g., "enwiki") to sitelink metadata with title, url, and badges fields.',
      ),
    fieldsReturned: z.array(z.string()).describe('Which fields are included in this response.'),
  }),

  errors: [
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No entity exists at this ID — the REST API returned resource-not-found.',
      recovery: 'Verify the ID with wikidata_search_entities or check the Wikidata URL directly.',
    },
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'ID format is not recognized as a Q-ID or P-ID.',
      recovery:
        'Supply a valid Q-ID (Q followed by digits, e.g. Q76) or P-ID (P followed by digits, e.g. P31).',
    },
  ],

  async handler(input, ctx) {
    const id = normalizeId(input.id);

    if (!isQId(id) && !isPId(id)) {
      throw ctx.fail(
        'invalid_id',
        `"${input.id}" is not a valid Wikidata ID. Expected Q+digits (item) or P+digits (property).`,
        { ...ctx.recoveryFor('invalid_id') },
      );
    }

    const svc = getWikidataRestService();
    ctx.log.info('Fetching Wikidata entity', {
      id,
      fields: input.fields,
      languages: input.languages,
    });

    let entity: Awaited<ReturnType<typeof svc.fetchEntity>>;
    try {
      entity = await svc.fetchEntity(id, ctx);
    } catch (err) {
      if ((err as { data?: { statusCode?: number } })?.data?.statusCode === 404) {
        throw ctx.fail('entity_not_found', `No entity found for ID "${id}".`, {
          ...ctx.recoveryFor('entity_not_found'),
        });
      }
      throw err;
    }

    // Determine which fields to include
    const requestedFields = new Set<string>(
      input.fields ?? ['labels', 'descriptions', 'aliases', 'statements', 'sitelinks'],
    );

    // Helper to filter language-keyed maps
    const filterLangs = <T>(map: Record<string, T> | undefined): Record<string, T> | undefined => {
      if (!map) return;
      if (!input.languages?.length) return map;
      const langSet = new Set(input.languages);
      const filtered = Object.fromEntries(
        Object.entries(map).filter(([lang]) => langSet.has(lang)),
      );
      return Object.keys(filtered).length ? filtered : undefined;
    };

    const result: Record<string, unknown> = {
      id: entity.id,
      type: entity.type,
      fieldsReturned: [...requestedFields],
    };

    if (entity.data_type) result.data_type = entity.data_type;

    if (requestedFields.has('labels')) {
      const labels = filterLangs(entity.labels);
      if (labels) result.labels = labels;
    }
    if (requestedFields.has('descriptions')) {
      const descriptions = filterLangs(entity.descriptions);
      if (descriptions) result.descriptions = descriptions;
    }
    if (requestedFields.has('aliases')) {
      const aliases = filterLangs(entity.aliases);
      if (aliases) result.aliases = aliases;
    }
    if (requestedFields.has('statements') && entity.statements) {
      result.statements = entity.statements;
    }
    if (requestedFields.has('sitelinks') && entity.sitelinks) {
      result.sitelinks = Object.fromEntries(
        Object.entries(entity.sitelinks).map(([site, sl]) => [
          site,
          {
            title: sl.title,
            ...(sl.url ? { url: sl.url } : {}),
            ...(sl.badges?.length ? { badges: sl.badges } : {}),
          },
        ]),
      );
    }

    // The output schema defines the full shape — result satisfies it at runtime
    // even though the TypeScript type is widened to Record<string, unknown>.
    return result as never;
  },

  format: (result) => {
    const lines: string[] = [`## ${result.id} (${result.type})`];

    if (result.data_type) lines.push(`**Data type:** ${result.data_type}`);
    lines.push(`**Fields returned:** ${result.fieldsReturned.join(', ')}`);

    if (result.labels) {
      const enLabel = result.labels.en;
      const allLabels = Object.entries(result.labels)
        .slice(0, 5)
        .map(([lang, val]) => `${lang}: ${val}`)
        .join(', ');
      lines.push(`**Label:** ${enLabel ?? Object.values(result.labels)[0] ?? '(none)'}`);
      if (Object.keys(result.labels).length > 1) {
        lines.push(
          `**Labels (sample):** ${allLabels}${Object.keys(result.labels).length > 5 ? ` … (${Object.keys(result.labels).length} total)` : ''}`,
        );
      }
    }

    if (result.descriptions) {
      const enDesc = result.descriptions.en;
      if (enDesc) {
        lines.push(`**Description:** ${enDesc}`);
      }
      const otherDescs = Object.entries(result.descriptions)
        .filter(([lang]) => lang !== 'en')
        .slice(0, 3)
        .map(([lang, val]) => `${lang}: ${val}`);
      if (otherDescs.length) lines.push(`**Descriptions (sample):** ${otherDescs.join(' | ')}`);
    }

    if (result.aliases) {
      const allAliasEntries = Object.entries(result.aliases).slice(0, 3);
      for (const [lang, aliases] of allAliasEntries) {
        if (aliases.length) {
          lines.push(
            `**Aliases (${lang}):** ${aliases.slice(0, 5).join(', ')}${aliases.length > 5 ? ` … (${aliases.length} total)` : ''}`,
          );
        }
      }
    }

    if (result.statements) {
      const propCount = Object.keys(result.statements).length;
      const claimCount = Object.values(result.statements).reduce(
        (acc, stmts) => acc + (stmts as unknown[]).length,
        0,
      );
      lines.push(`**Statements:** ${propCount} properties, ${claimCount} total claims`);
    }

    if (result.sitelinks) {
      const sitelinkCount = Object.keys(result.sitelinks).length;
      const enwiki = result.sitelinks.enwiki as { url?: string; title?: string } | undefined;
      lines.push(`**Sitelinks:** ${sitelinkCount} total`);
      if (enwiki) lines.push(`**Wikipedia (en):** ${enwiki.url ?? enwiki.title}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
