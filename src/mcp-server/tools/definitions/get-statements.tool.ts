/**
 * @fileoverview Fetch and normalize property statements for a Wikidata entity with label resolution.
 * @module mcp-server/tools/definitions/get-statements.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { NormalizedStatement } from '@/services/wikidata/types.js';
import {
  getWikidataRestService,
  isPId,
  isQId,
  normalizeId,
  normalizeStatements,
} from '@/services/wikidata/wikidata-rest-service.js';

export const wikidataGetStatements = tool('wikidata_get_statements', {
  title: 'Get Wikidata Statements',
  description:
    'Fetch property claims for a Wikidata entity with qualifier and reference detail. ' +
    'Value QIDs are resolved to human-readable labels by default. ' +
    'Use the properties parameter to fetch only specific P-IDs — omitting it returns all statements, ' +
    'which can be large. Designed for fact verification: "what does Wikidata say about this entity\'s {property}?". ' +
    'Preferred-rank statements are the most current values.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    id: z
      .string()
      .min(1)
      .describe('Q-ID (e.g., "Q76") or P-ID of the entity to fetch statements for.'),
    properties: z
      .array(
        z
          .string()
          .min(1)
          .regex(/^P\d+$/i, 'Property filters must be Wikidata P-IDs such as P31.'),
      )
      .optional()
      .describe(
        'P-IDs to fetch (e.g., ["P31", "P569", "P27"]). Omit to return all properties (may be large for major items).',
      ),
    language: z
      .string()
      .default('en')
      .describe('Language code for label resolution of QID values (e.g., "en", "de").'),
    resolve_labels: z
      .boolean()
      .default(true)
      .describe(
        'Resolve wikibase-item value QIDs to human-readable labels via a batched label call. ' +
          'Set to false to skip label resolution and return raw QIDs only (faster, smaller payload).',
      ),
  }),

  output: z.object({
    id: z.string().describe('The entity ID whose statements were fetched.'),
    // Statement values are from a dynamic external API (12+ data types, each with a different shape).
    // Passthrough preserves all normalized fields in structuredContent without over-typing each branch.
    statements: z
      .record(z.string(), z.array(z.object({}).passthrough()))
      .describe(
        'Map of property ID to array of normalized statements. ' +
          'Each statement has id, rank, property, value (with type-specific fields), ' +
          'and optional qualifiers and references arrays.',
      ),
    propertyCount: z.number().describe('Number of distinct properties returned.'),
    statementCount: z.number().describe('Total number of statement objects across all properties.'),
    labelsResolved: z
      .boolean()
      .describe(
        'True when QID values were resolved to labels. False when resolve_labels was set to false.',
      ),
  }),

  errors: [
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No entity exists at this QID.',
      recovery: 'Verify the ID with wikidata_search_entities or wikidata_get_labels.',
    },
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'ID is not a valid Q-ID or P-ID format.',
      recovery: 'Supply a valid Q-ID (Q followed by digits) or P-ID (P followed by digits).',
    },
  ],

  async handler(input, ctx) {
    const id = normalizeId(input.id);

    if (!isQId(id) && !isPId(id)) {
      throw ctx.fail('invalid_id', `"${input.id}" is not a valid Wikidata ID.`, {
        ...ctx.recoveryFor('invalid_id'),
      });
    }

    const svc = getWikidataRestService();
    ctx.log.info('Fetching statements', {
      id,
      properties: input.properties,
      language: input.language,
      resolve_labels: input.resolve_labels,
    });

    let rawStatements: Awaited<ReturnType<typeof svc.fetchStatements>>;
    try {
      rawStatements = await svc.fetchStatements(id, input.properties, ctx);
    } catch (err) {
      const errorData = (err as { data?: { status?: number; statusCode?: number } })?.data;
      const httpStatus = errorData?.status ?? errorData?.statusCode;
      // Wikidata returns 404 for unknown IDs and 400 for syntactically valid but out-of-range IDs
      // (e.g. Q9999999999 → "invalid-path-parameter"). Both map to entity_not_found.
      if (httpStatus === 404 || httpStatus === 400) {
        throw ctx.fail('entity_not_found', `No entity found for ID "${id}".`, {
          ...ctx.recoveryFor('entity_not_found'),
        });
      }
      throw err;
    }

    // Collect all value QIDs for label resolution
    const labelMap: Record<string, string> = {};
    if (input.resolve_labels) {
      const qidsToResolve = new Set<string>();

      /** Extract QID from a wikibase-item content value. */
      const extractQid = (content: unknown): string | undefined => {
        if (typeof content === 'string') return content;
        const c = content as { id?: string } | null;
        return c?.id ?? undefined;
      };

      for (const stmts of Object.values(rawStatements)) {
        for (const stmt of stmts) {
          if (stmt.property?.data_type === 'wikibase-item') {
            const qid = extractQid(stmt.value?.content);
            if (qid) qidsToResolve.add(qid);
          }
          for (const q of stmt.qualifiers ?? []) {
            if (q.property?.data_type === 'wikibase-item') {
              const qid = extractQid(q.value?.content);
              if (qid) qidsToResolve.add(qid);
            }
          }
        }
      }

      if (qidsToResolve.size > 0) {
        const labelData = await svc.fetchLabels([...qidsToResolve], [input.language], ctx);
        for (const [qid, data] of Object.entries(labelData)) {
          const label = data.labels[input.language];
          if (label) labelMap[qid] = label;
        }
      }
    }

    // Normalize statements
    const normalized: Record<string, NormalizedStatement[]> = {};
    for (const [propertyId, stmts] of Object.entries(rawStatements)) {
      normalized[propertyId] = normalizeStatements(propertyId, stmts, labelMap);
    }

    const statementCount = Object.values(normalized).reduce((acc, stmts) => acc + stmts.length, 0);

    return {
      id,
      statements: normalized,
      propertyCount: Object.keys(normalized).length,
      statementCount,
      labelsResolved: input.resolve_labels,
    } as never;
  },

  format: (result) => {
    const lines: string[] = [
      `## Statements for ${result.id}`,
      `**Properties:** ${result.propertyCount} | **Total statements:** ${result.statementCount} | **Labels resolved:** ${result.labelsResolved}`,
    ];

    for (const [propId, rawStmts] of Object.entries(result.statements)) {
      lines.push('');
      lines.push(`### ${propId}`);
      for (const rawStmt of rawStmts) {
        const stmt = rawStmt as NormalizedStatement;
        if (!stmt?.value) continue;
        const rankIndicator =
          stmt.rank === 'preferred' ? ' ★' : stmt.rank === 'deprecated' ? ' ~~(deprecated)~~' : '';
        const valueStr = formatStatementValue(stmt.value);
        lines.push(`- ${valueStr}${rankIndicator}`);
        if (stmt.qualifiers?.length) {
          for (const q of stmt.qualifiers) {
            if (!q?.value) continue;
            lines.push(`  - ${q.property}: ${formatStatementValue(q.value)}`);
          }
        }
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function formatStatementValue(value: NormalizedStatement['value']): string {
  switch (value.type) {
    case 'wikibase-item':
      return value.label ? `${value.label} (${value.qid})` : value.qid;
    case 'time':
      return value.time;
    case 'quantity':
      return value.unitLabel
        ? `${value.amount} ${value.unitLabel}`
        : value.unit && value.unit !== '1'
          ? `${value.amount} (${value.unit})`
          : value.amount;
    case 'string':
      return value.value;
    case 'monolingualtext':
      return `${value.text} [${value.language}]`;
    case 'globe-coordinate':
      return `${value.latitude}, ${value.longitude}`;
    case 'other':
      return JSON.stringify(value.raw ?? '');
    default:
      return '(unknown)';
  }
}
