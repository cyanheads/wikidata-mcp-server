/**
 * @fileoverview Fetch and normalize property statements for a Wikidata entity with label resolution.
 * @module mcp-server/tools/definitions/get-statements.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DEFAULT_OUTLINE_BUDGET_BYTES,
  formatOutline,
  OUTLINE_VARIANT,
  type SectionMeta,
} from '@cyanheads/mcp-ts-core/utils';
import { DEFAULT_LANGUAGE, languageCode } from '@/mcp-server/tools/language-code.js';
import { statementLines } from '@/mcp-server/tools/statement-format.js';
import { jsonBytes } from '@/mcp-server/tools/utf8-bytes.js';
import type { NormalizedStatement } from '@/services/wikidata/types.js';
import {
  collectLabelQids,
  getWikidataRestService,
  isEntityNotFoundError,
  isPId,
  isQId,
  normalizeId,
  normalizeStatements,
} from '@/services/wikidata/wikidata-rest-service.js';

/**
 * The outline's re-call notice. Following it must return statements, so its example is a
 * literal `properties` set packed largest-first (first fit) within the budget — never the
 * largest sections, which on a major item each overflow alone. Sizes are additive upper
 * bounds (see the extractor in the handler), so the sum a caller computes is a safe test.
 */
function retrievalNotice(totalBytes: number, sections: SectionMeta[]): string {
  const budget = DEFAULT_OUTLINE_BUDGET_BYTES;
  const chosen: string[] = [];
  let sum = 0;
  for (const section of sections) {
    if (sum + section.bytes <= budget) {
      chosen.push(section.name);
      sum += section.bytes;
    }
  }
  const parts = [
    `Statement set too large to inline: ${totalBytes} bytes against a ${budget}-byte budget.`,
  ];
  parts.push(
    chosen.length > 0
      ? `Re-call wikidata_get_statements with the same id plus properties:[...] naming the P-IDs you need — e.g. properties:${JSON.stringify(chosen)}, a set measured to fit the budget.`
      : 'Every property here is larger than the budget on its own; re-call wikidata_get_statements with the same id plus properties:[...] naming one P-ID per call.',
  );
  parts.push(
    `Sizes add up: any selection whose listed sizes sum to ${budget} bytes or less returns its statements, and a property requested alone is always returned whole.`,
  );
  return parts.join(' ');
}

export const wikidataGetStatements = tool('wikidata_get_statements', {
  title: 'Get Wikidata Statements',
  description:
    'Fetch property claims for a Wikidata entity with qualifier and reference detail. ' +
    'Item QIDs and quantity units — in values, qualifiers, and references — are resolved to human-readable labels by default. ' +
    'Use the properties parameter to fetch only specific P-IDs — omitting it returns every statement, ' +
    'and a well-connected item (a country, a major city) carries hundreds of properties: more than fits inline. ' +
    'A set over 24,000 bytes before labels comes back as kind: "outline" — every available P-ID with its byte size, largest first — ' +
    'instead of the statements; re-call with the same id plus properties:[...] naming P-IDs whose sizes sum to 24,000 or less ' +
    '(the retrieval_notice names one such set). Labels are added after that check, so a returned set can run past 24,000 bytes by their size, ' +
    'and a property requested alone is always returned whole — on a major item one property can run to hundreds of kilobytes. ' +
    'Designed for fact verification: "what does Wikidata say about this entity\'s {property}?". ' +
    'Preferred rank marks the favored statements for a property; check qualifiers and references for temporal scope and evidence.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    id: z
      .string()
      .min(1)
      .describe('Q-ID (e.g., "Q76") or P-ID of the entity to fetch statements for.'),
    properties: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'P-IDs to fetch (e.g., ["P31", "P569", "P27"]). Omit to return all properties (may be large for major items).',
      ),
    language: languageCode()
      .default(DEFAULT_LANGUAGE)
      .describe(
        'Wikidata language code for label resolution of QID values (e.g., "en", "de"). ' +
          'Case-insensitive; "_" is read as "-"; blank means "en".',
      ),
    resolve_labels: z
      .boolean()
      .default(true)
      .describe(
        'Resolve item QIDs (label) and quantity unit QIDs (unitLabel) to human-readable labels via one batched label call, ' +
          'covering main values, qualifiers, and reference parts. ' +
          'Set to false to skip label resolution and return raw QIDs only (faster, smaller payload).',
      ),
  }),

  output: z.object({
    id: z.string().describe('The entity ID whose statements were fetched.'),
    kind: z
      .enum(['full', 'outline'])
      .describe(
        'full — statements carries the claims. outline — the statement set overflowed the inline byte budget, ' +
          'so sections lists the P-IDs available instead; re-call with properties:[...] to retrieve specific ones. ' +
          'The counts below are reported either way.',
      ),
    // Statement values are from a dynamic external API (18 data types, each with a different shape).
    // Passthrough preserves all normalized fields in structuredContent without over-typing each branch.
    statements: z
      .record(z.string(), z.array(z.object({}).passthrough()))
      .optional()
      .describe(
        'Map of property ID to array of normalized statements. ' +
          'Each statement has id, rank, property, value (with type-specific fields), ' +
          'optional qualifiers ([{ property, value }]), and optional references — ' +
          'one entry per source in upstream order, each { parts: [{ property, value }] }. ' +
          'Present in full mode; omitted in outline mode.',
      ),
    sections: z
      .array(
        OUTLINE_VARIANT.shape.sections.element.describe(
          'An available property — its P-ID and the serialized byte size of its statements.',
        ),
      )
      .optional()
      .describe(
        'Present when kind = outline: the P-IDs this entity carries statements for, largest first, each sized as ' +
          'the UTF-8 bytes it adds to a response before labels. Sizes add up: copy names whose sizes sum to 24,000 or less ' +
          'into the properties input to retrieve them.',
      ),
    // Named retrieval_notice, not notice: it is part of the outline payload the agent acts
    // on, not additive agent-facing context. Enrichment is merged *after* output.parse and
    // so can only add to a fat result, never replace it with an outline.
    retrieval_notice: OUTLINE_VARIANT.shape.notice
      .optional()
      .describe('Present when kind = outline: how to re-call for specific properties.'),
    propertyCount: z
      .number()
      .describe(
        'Number of distinct properties — those returned in full mode, those offered as sections in outline mode.',
      ),
    statementCount: z
      .number()
      .describe(
        'Total number of statement objects across all properties. Counted before any overflow, ' +
          "so it reports the entity's full statement volume in both modes.",
      ),
    labelsResolved: z
      .boolean()
      .describe(
        'True when the returned statements had labels resolved: resolve_labels was true and kind is full, so every item QID ' +
          'and quantity unit that resolved carries its label. False when resolve_labels was false, and on an outline, ' +
          'which carries no statements and makes no label lookup.',
      ),
  }),

  errors: [
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No entity exists at this ID — either unassigned or out of range.',
      recovery: 'Verify the ID with wikidata_search_entities or wikidata_get_labels.',
    },
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'ID is not a valid Q-ID or P-ID format.',
      recovery: 'Supply a valid Q-ID (Q followed by digits) or P-ID (P followed by digits).',
    },
    {
      reason: 'invalid_property',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A properties entry is not a valid P-ID format.',
      recovery:
        'Every properties entry must be P followed by digits (e.g., P31). Find P-IDs with wikidata_search_entities using type="property".',
    },
  ],

  async handler(input, ctx) {
    const id = normalizeId(input.id);

    if (!isQId(id) && !isPId(id)) {
      throw ctx.fail('invalid_id', `"${input.id}" is not a valid Wikidata ID.`);
    }

    /**
     * Reject malformed P-IDs before the fetch. A malformed entry is the only thing the REST
     * `?property=` filter answers with 400 — a well-formed but unassigned P-ID (P9999999)
     * answers 200 with an empty result, which is the honest answer and stays one.
     *
     * That 400 is indistinguishable from the one an out-of-range entity ID draws, so without
     * this check isEntityNotFoundError() below would report a real entity as missing. And a
     * multi-property request never reaches the filter at all (the service fetches all and
     * client-filters), so the bad entry would simply vanish from the result.
     */
    const invalidProperties = input.properties?.filter((p) => !isPId(normalizeId(p))) ?? [];
    if (invalidProperties.length > 0) {
      throw ctx.fail(
        'invalid_property',
        `Invalid property IDs: ${invalidProperties.join(', ')}. Properties must be P followed by digits (e.g., P31).`,
        { invalid: invalidProperties },
      );
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
      if (isEntityNotFoundError(err)) {
        throw ctx.fail('entity_not_found', `No entity found for ID "${id}".`);
      }
      throw err;
    }

    const normalizeAll = (labelMap: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(rawStatements).map(([propertyId, stmts]) => [
          propertyId,
          normalizeStatements(propertyId, stmts, labelMap),
        ]),
      ) as Record<string, NormalizedStatement[]>;

    /**
     * The budget decision is made once, on the unlabelled set, and labels never reverse it.
     * Sizing with labels would mean resolving them for a set about to be outlined — every
     * batch discarded (#40) — and measuring after labelling made the outline a loop: a
     * selection sized to fit from the outline came back over budget once labelled, as the
     * same outline. So a set that fits unlabelled is returned with its labels, which can
     * carry the response past the budget by their own size.
     *
     * Sections are P-IDs — the vocabulary the `properties` input speaks — each sized as the
     * UTF-8 bytes it adds to a response (`{"P31":[…]}`, key and punctuation included). Sizes
     * are therefore additive upper bounds: any selection whose sizes sum to the budget or less
     * measures within it on the re-call, and so returns statements.
     *
     * The decision is this tool's own rather than `outlineOnOverflow`'s, which measures
     * UTF-16 code units (cyanheads/mcp-ts-core#614): a CJK-heavy set would pass it at up to
     * three times the budget, and sizes listed in bytes would no longer sum against the unit
     * the decision used. It keeps the primitive's single-section short-circuit: an entity
     * whose statements sit under one P-ID is returned whole even when oversized, since the
     * only re-call an outline could offer would return the same bytes.
     */
    let normalized = normalizeAll({});
    const totalBytes = jsonBytes(normalized);
    const sections: SectionMeta[] | undefined =
      totalBytes > DEFAULT_OUTLINE_BUDGET_BYTES && Object.keys(normalized).length > 1
        ? Object.entries(normalized)
            .map(([name, value]) => ({ name, bytes: jsonBytes({ [name]: value }) }))
            .sort((a, b) => b.bytes - a.bytes)
        : undefined;

    /** One label batch for item values and quantity units at every level, for a set that fits. */
    const labelsResolved = input.resolve_labels && !sections;
    if (labelsResolved) {
      const qidsToResolve = collectLabelQids(Object.values(rawStatements).flat());
      if (qidsToResolve.size > 0) {
        const labelData = await svc.fetchLabels([...qidsToResolve], [input.language], ctx);
        const labelMap: Record<string, string> = {};
        for (const [qid, data] of Object.entries(labelData)) {
          const label = data.labels[input.language];
          if (label) labelMap[qid] = label;
        }
        normalized = normalizeAll(labelMap);
      }
    }

    const statementCount = Object.values(normalized).reduce((acc, stmts) => acc + stmts.length, 0);

    /** Cheap metadata — kept in both arms. */
    const base = {
      id,
      propertyCount: Object.keys(normalized).length,
      statementCount,
      labelsResolved,
    };

    if (sections) {
      ctx.log.info('Statement set overflowed — returning outline', {
        id,
        propertyCount: base.propertyCount,
        sections: sections.length,
      });
      return {
        ...base,
        kind: 'outline',
        sections,
        retrieval_notice: retrievalNotice(totalBytes, sections),
      } as never;
    }

    return { ...base, kind: 'full', statements: normalized } as never;
  },

  /**
   * Each arm renders on the presence of its own fields, never by branching on `kind` —
   * format-parity injects one synthetic sample with every optional field populated at once,
   * so a mutually-exclusive branch would leave the untaken arm's fields unrendered.
   */
  format: (result) => {
    const lines: string[] = [
      `## Statements for ${result.id}`,
      `**Properties:** ${result.propertyCount} | **Total statements:** ${result.statementCount} | **Labels resolved:** ${result.labelsResolved} | **Response:** ${result.kind}`,
    ];

    lines.push(
      ...statementLines((result.statements ?? {}) as Record<string, NormalizedStatement[]>),
    );

    const outlineBlocks = result.sections
      ? formatOutline({
          kind: 'outline',
          sections: result.sections,
          notice: result.retrieval_notice ?? '',
        })
      : [];

    return [{ type: 'text', text: lines.join('\n') }, ...outlineBlocks];
  },
});
