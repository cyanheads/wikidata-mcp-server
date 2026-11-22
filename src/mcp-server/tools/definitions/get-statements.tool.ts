/**
 * @fileoverview Fetch and normalize property statements for a Wikidata entity with label resolution.
 * @module mcp-server/tools/definitions/get-statements.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DEFAULT_OUTLINE_BUDGET_BYTES,
  escapeMarkdownInline,
  formatOutline,
  OUTLINE_VARIANT,
  type SectionMeta,
} from '@cyanheads/mcp-ts-core/utils';
import { applyCountLimit } from '@/mcp-server/tools/count-limit.js';
import { DEFAULT_LANGUAGE, languageCode } from '@/mcp-server/tools/language-code.js';
import { statementLines } from '@/mcp-server/tools/statement-format.js';
import { isUpstreamUnavailable } from '@/mcp-server/tools/upstream-unavailable.js';
import { jsonBytes } from '@/mcp-server/tools/utf8-bytes.js';
import type { NormalizedStatement, RawStatement } from '@/services/wikidata/types.js';
import {
  collectLabelPids,
  collectLabelQids,
  getWikidataRestService,
  isEntityNotFoundError,
  isPId,
  isQId,
  normalizeId,
  normalizeStatements,
} from '@/services/wikidata/wikidata-rest-service.js';

/**
 * Most statements one property returns per call. The REST endpoint sends a property's
 * statements in one response, so the cap bounds the response, not an upstream page.
 */
const LIMIT_CAP = 500;

/**
 * The outline's re-call notice. Following it must return statements, so its example is a
 * literal `properties` set packed largest-first (first fit) within the budget — never the
 * largest sections, which on a major item each overflow alone. Sizes are additive upper
 * bounds (see the extractor in the handler), so the sum a caller computes is a safe test.
 * They measure this call's window, so the re-call names the same limit, offset, and rank.
 */
function retrievalNotice(
  totalBytes: number,
  sections: SectionMeta[],
  window: { limit: number; offset: number; rank: string; resolvedId?: string },
): string {
  const budget = DEFAULT_OUTLINE_BUDGET_BYTES;
  const chosen: string[] = [];
  let sum = 0;
  for (const section of sections) {
    if (sum + section.bytes <= budget) {
      chosen.push(section.name);
      sum += section.bytes;
    }
  }
  const id = window.resolvedId ? `id: "${window.resolvedId}"` : 'the same id';
  const sameCall = `${id}, limit: ${window.limit}, offset: ${window.offset}, and rank: "${window.rank}"`;
  const parts = [
    `Statement set too large to inline: ${totalBytes} bytes against a ${budget}-byte budget.`,
  ];
  parts.push(
    chosen.length > 0
      ? `Re-call wikidata_get_statements with ${sameCall}, plus properties:[...] naming the P-IDs you need — e.g. properties:${JSON.stringify(chosen)}, a set measured to fit the budget.`
      : `Every property here is larger than the budget on its own; re-call wikidata_get_statements with ${sameCall}, plus properties:[...] naming one P-ID per call.`,
  );
  parts.push(
    `Sizes add up: any selection whose listed sizes sum to ${budget} bytes or less returns its statements at that limit, offset, and rank, and a single property is never outlined.`,
  );
  return parts.join(' ');
}

/**
 * The truthy rule SPARQL's `wdt:` reads, applied to one property: its preferred statements when
 * it has any, otherwise its normal ones, never its deprecated ones.
 */
function bestRank(statements: RawStatement[]): RawStatement[] {
  const preferred = statements.filter((s) => s.rank === 'preferred');
  return preferred.length > 0 ? preferred : statements.filter((s) => s.rank === 'normal');
}

export const wikidataGetStatements = tool('wikidata_get_statements', {
  title: 'Get Wikidata Statements',
  description:
    'Fetch property claims for a Wikidata entity with qualifier and reference detail. Item QIDs and quantity units — in values, qualifiers, and references — are resolved to human-readable labels by default, and every P-ID the statements name comes back labelled in propertyLabels. Each property returns up to limit statements (default 10) starting at offset, in upstream order; propertyTotals counts every statement each property holds, and nextOffset, present while any property holds more, continues every property at once. Use the properties parameter to fetch only specific P-IDs — omitting it returns every property, and a well-connected item (a country, a major city) carries hundreds of them: more than fits inline. A page of several properties over 24,000 bytes before labels comes back as kind: "outline" — every P-ID on the page with its byte size, largest first — instead of the statements; re-call with the same id, limit, offset, and rank plus properties:[...] naming P-IDs whose sizes sum to 24,000 or less (the retrieval_notice names one such set). Labels are added after that check, so a returned page can run past 24,000 bytes by their size, and a single property is never outlined: it returns its window whatever the size. Designed for fact verification: "what does Wikidata say about this entity\'s {property}?". For a current value, rank: "best" keeps each property\'s preferred statements, or its normal ones when none is preferred, and never deprecated ones — the statements SPARQL\'s wdt: reads. Check qualifiers and references for temporal scope and evidence.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    id: z
      .string()
      .min(1)
      .describe(
        'Q-ID (e.g., "Q76") or P-ID of the entity to fetch statements for, bare or as an entity URI or wd: form (e.g., "http://www.wikidata.org/entity/Q76", "wd:Q76").',
      ),
    properties: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'P-IDs to fetch (e.g., ["P31", "P569", "P27"]), bare or as an entity URI or wd: form. Omit to return all properties (may be large for major items).',
      ),
    language: languageCode()
      .default(DEFAULT_LANGUAGE)
      .describe(
        'Wikidata language code for label resolution of QID values and P-IDs (e.g., "en", "de"). Case-insensitive; "_" is read as "-"; blank means "en".',
      ),
    resolve_labels: z
      .boolean()
      .default(true)
      .describe(
        'Resolve item QIDs (label), quantity unit QIDs (unitLabel), and the P-IDs of statements, qualifiers, reference parts, and property-typed values (propertyLabels) to human-readable labels via one batched label call over the returned statements. Set to false to skip label resolution and return raw IDs only (faster, smaller payload).',
      ),
    rank: z
      .enum(['all', 'best'])
      .default('all')
      .describe(
        'Which statements each property keeps. "all" keeps every statement, deprecated ones included. "best" keeps a property\'s preferred statements when it has any, otherwise its normal ones, and never deprecated ones — the truthy statements SPARQL\'s wdt: reads. Applied before every count, the limit/offset window, the outline check, and labels.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .default(10)
      .describe(
        'Statements returned per property, starting at offset, in upstream order. Default 10; a larger value returns at most 500 per property and says so.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Statements skipped in each property before its window. Start at 0; pass the nextOffset a response returns to continue every property at once.',
      ),
  }),

  output: z.object({
    id: z.string().describe('The resolved entity ID whose statements were fetched.'),
    redirectedFrom: z
      .string()
      .optional()
      .describe('The normalized requested ID when it redirects to id.'),
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
          'An available property — its P-ID and the serialized byte size of its statements in this window.',
        ),
      )
      .optional()
      .describe(
        'Present when kind = outline: the P-IDs with statements in this limit/offset window, largest first, each sized as the UTF-8 bytes its window adds to a response before labels. Sizes add up: copy names whose sizes sum to 24,000 or less into the properties input, with the same limit, offset, and rank, to retrieve them.',
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
        'Statements across every property in the selection, after the rank filter and before the limit/offset window and any overflow, so it reports the full volume the rank keeps in both modes.',
      ),
    propertyTotals: z
      .record(z.string(), z.number())
      .describe(
        'Statements each property in the selection holds after the rank filter and before the window, keyed by P-ID. Explicitly requested absent properties and properties emptied by rank "best" count as 0. Lists a property paged past its end too. Reported in both modes.',
      ),
    returnedCount: z
      .number()
      .describe(
        'Statements returned in statements, across every property — this page. 0 on an outline.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Present in full mode while any property holds statements past this window: offset + limit. Re-call with offset: nextOffset to continue every property at once. Absent on the last page, and on an outline: re-call for this window first.',
      ),
    rank: z.enum(['all', 'best']).describe('The rank filter applied: "all" or "best".'),
    labelsResolved: z
      .boolean()
      .describe(
        'True when label resolution was enabled and completed for a full response. Statements carry available item and unit labels, and propertyLabels holds available property labels. False when resolution was disabled, the response is an outline, or the label service was unavailable or rejected the language.',
      ),
    propertyLabels: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'P-ID → label in language for the properties the returned statements name: statement keys, qualifier and reference-part properties, and property-typed values. Present when labelsResolved is true; a P-ID with no label is absent and renders bare.',
      ),
  }),

  /**
   * Agent-facing context about what the call left out. Every condition a call raises is
   * joined into one notice, since a second `ctx.enrich.notice()` replaces the first.
   */
  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the window cut at least one property short of its total: nextOffset continues it. Absent otherwise.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Explains missing requested properties, a clamped limit, an offset past every property, deprecated-only claims excluded by best rank, or labels unavailable because of an outage or an unrecognized language.',
      ),
  },
  enrichmentTrailer: {
    truncated: { label: 'Truncated' },
    notice: {
      render(value: string) {
        return `> ${escapeMarkdownInline(value)}`;
      },
    },
  },

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

    const limit = applyCountLimit(
      input.limit,
      LIMIT_CAP,
      { field: 'limit', tool: 'wikidata_get_statements' },
      ctx,
    );
    const { offset } = input;

    const svc = getWikidataRestService();
    ctx.log.info('Fetching statements', {
      id,
      properties: input.properties,
      language: input.language,
      resolve_labels: input.resolve_labels,
      rank: input.rank,
      limit: limit.applied,
      offset,
    });

    let result: Awaited<ReturnType<typeof svc.fetchStatements>>;
    try {
      result = await svc.fetchStatements(id, input.properties, ctx);
    } catch (err) {
      if (isEntityNotFoundError(err)) {
        throw ctx.fail('entity_not_found', `No entity found for ID "${id}".`);
      }
      throw err;
    }
    const { id: resolvedId, statements: rawStatements } = result;

    /**
     * The rank filter runs first, so the totals, the window, the outline decision, and the label
     * batch see only the statements it keeps. Then each property is cut to its own window in
     * upstream order. A property whose window comes out empty — paged past its end, or emptied
     * by the rank — stays in the totals and is left out of `statements`.
     */
    const kept =
      input.rank === 'best'
        ? Object.fromEntries(
            Object.entries(rawStatements).map(([propertyId, stmts]) => [
              propertyId,
              bestRank(stmts),
            ]),
          )
        : rawStatements;
    const propertyTotals = Object.fromEntries(
      Object.entries(kept).map(([propertyId, stmts]) => [propertyId, stmts.length]),
    );
    const statementCount = Object.values(propertyTotals).reduce((acc, n) => acc + n, 0);
    const end = offset + limit.applied;
    const selected = Object.entries(kept)
      .map(([propertyId, stmts]): [string, RawStatement[]] => [
        propertyId,
        stmts.slice(offset, end),
      ])
      .filter(([, stmts]) => stmts.length > 0);
    const returnedCount = selected.reduce((acc, [, stmts]) => acc + stmts.length, 0);
    const morePastWindow = Object.values(propertyTotals).some((n) => n > end);

    const notices: string[] = [];
    if (limit.clamped) {
      notices.push(
        `limit ${limit.requested} was served as ${limit.applied}, the per-call cap: each property returns at most ${limit.applied} statements per call.${morePastWindow ? ' Page through the rest with offset.' : ''}`,
      );
    }
    const totals = Object.entries(propertyTotals);
    if (offset > 0 && selected.length === 0 && totals.length > 0) {
      const [largest, max] = totals.reduce((a, b) => (b[1] > a[1] ? b : a));
      notices.push(
        `offset ${offset} is past the end of every property here: the largest, ${largest}, holds ${max} statements.${max > 0 ? ` Page with an offset below ${max}.` : ''}`,
      );
    }
    const deprecatedOnly = totals
      .filter(([propertyId, total]) => total === 0 && (rawStatements[propertyId]?.length ?? 0) > 0)
      .map(([propertyId]) => propertyId);
    if (input.rank === 'best' && deprecatedOnly.length > 0) {
      const holds = deprecatedOnly.length === 1 ? 'holds' : 'hold';
      notices.push(
        `${deprecatedOnly.join(', ')} ${holds} only deprecated statements, which rank "best" leaves out. Re-call with rank: "all" to read them.`,
      );
    }
    const missing = [...new Set(input.properties?.map(normalizeId))].filter(
      (propertyId) => !rawStatements[propertyId]?.length,
    );
    if (missing.length > 0) {
      for (const propertyId of missing) propertyTotals[propertyId] = 0;
      notices.push(`${resolvedId} has no statements for ${missing.join(', ')}.`);
    }

    const normalizeAll = (labelMap: Record<string, string>) =>
      Object.fromEntries(
        selected.map(([propertyId, stmts]) => [
          propertyId,
          normalizeStatements(propertyId, stmts, labelMap),
        ]),
      ) as Record<string, NormalizedStatement[]>;

    /**
     * The budget decision is made once, on the windowed, unlabelled set, and labels never
     * reverse it. It never trims a window: the page returns whole or outlines.
     * Sizing with labels would mean resolving them for a set about to be outlined — every
     * batch discarded (#40) — and measuring after labelling made the outline a loop: a
     * selection sized to fit from the outline came back over budget once labelled, as the
     * same outline. So a set that fits unlabelled is returned with its labels, which can
     * carry the response past the budget by their own size.
     *
     * Sections are P-IDs — the vocabulary the `properties` input speaks — each sized as the
     * UTF-8 bytes it adds to a response (`{"P31":[…]}`, key and punctuation included). Sizes
     * are therefore additive upper bounds: any selection whose sizes sum to the budget or less
     * measures within it on a re-call with the same limit, offset, and rank — each property's
     * window depends on nothing else in the selection — and so returns statements.
     *
     * The decision is this tool's own rather than `outlineOnOverflow`'s, which measures
     * UTF-16 code units (cyanheads/mcp-ts-core#614): a CJK-heavy set would pass it at up to
     * three times the budget, and sizes listed in bytes would no longer sum against the unit
     * the decision used. It keeps the primitive's single-section short-circuit: a page whose
     * statements sit under one P-ID is returned at its window even when oversized, since the
     * only re-call an outline could offer would return the same bytes; `limit` is the lever there.
     */
    let normalized = normalizeAll({});
    const totalBytes = jsonBytes(normalized);
    const sections: SectionMeta[] | undefined =
      totalBytes > DEFAULT_OUTLINE_BUDGET_BYTES && Object.keys(normalized).length > 1
        ? Object.entries(normalized)
            .map(([name, value]) => ({ name, bytes: jsonBytes({ [name]: value }) }))
            .sort((a, b) => b.bytes - a.bytes)
        : undefined;

    /**
     * One deduplicated label batch for a page that fits, covering its window only: the item
     * values and quantity units the statements carry at every level, and every P-ID they name.
     * Q-ID labels go into the statements; P-ID labels into `propertyLabels`.
     */
    let labelsResolved = input.resolve_labels && !sections;
    let propertyLabels: Record<string, string> | undefined;
    if (labelsResolved) {
      const windowStatements = selected.flatMap(([, stmts]) => stmts);
      const qids = collectLabelQids(windowStatements);
      const pids = collectLabelPids(windowStatements);
      propertyLabels = {};
      if (qids.size + pids.size > 0) {
        /**
         * Labels decorate statements the call already holds, so a label service that does not
         * answer leaves them unlabelled, and the result says so, rather than failing the call.
         */
        const labelData = await svc
          .fetchLabels([...qids, ...pids], [input.language], ctx)
          .catch((err: unknown) => {
            if (!isUpstreamUnavailable(err)) throw err;
            ctx.log.warning('Label lookup unavailable; returning statements unlabelled', {
              id,
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          });
        if (!labelData || labelData.unrecognizedLanguages.includes(input.language)) {
          labelsResolved = false;
          propertyLabels = undefined;
          notices.push(
            labelData
              ? `Wikidata did not recognize "${input.language}" for labels. Use a term-language code such as en or fr, or set resolve_labels: false to keep the raw IDs.`
              : 'Labels were not resolved: the Wikidata label service did not answer, so item values and P-IDs come back as raw IDs. Re-call for labels, or pass resolve_labels: false to skip them.',
          );
        } else {
          const labelOf = (entityId: string) =>
            labelData.entities[entityId]?.labels[input.language];
          const labelMap: Record<string, string> = {};
          for (const qid of qids) {
            const label = labelOf(qid);
            if (label) labelMap[qid] = label;
          }
          for (const pid of pids) {
            const label = labelOf(pid);
            if (label) propertyLabels[pid] = label;
          }
          if (qids.size > 0) normalized = normalizeAll(labelMap);
        }
      }
    }

    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    /** Cheap metadata — kept in both arms. */
    const base = {
      id: resolvedId,
      ...(resolvedId !== id ? { redirectedFrom: id } : {}),
      propertyCount: Object.keys(normalized).length,
      statementCount,
      propertyTotals,
      rank: input.rank,
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
        returnedCount: 0,
        sections,
        retrieval_notice: retrievalNotice(totalBytes, sections, {
          limit: limit.applied,
          offset,
          rank: input.rank,
          ...(resolvedId !== id ? { resolvedId } : {}),
        }),
      } as never;
    }

    if (morePastWindow) ctx.enrich({ truncated: true });
    return {
      ...base,
      kind: 'full',
      statements: normalized,
      returnedCount,
      ...(morePastWindow ? { nextOffset: end } : {}),
      ...(propertyLabels ? { propertyLabels } : {}),
    } as never;
  },

  /**
   * Each arm renders on the presence of its own fields, never by branching on `kind` —
   * format-parity injects one synthetic sample with every optional field populated at once,
   * so a mutually-exclusive branch would leave the untaken arm's fields unrendered.
   */
  format: (result) => {
    const lines: string[] = [
      `## Statements for ${result.id}`,
      `**Properties:** ${result.propertyCount} | **Total statements:** ${result.statementCount} | **Returned:** ${result.returnedCount} | **Rank:** ${result.rank} | **Labels resolved:** ${result.labelsResolved} | **Response:** ${result.kind}`,
    ];
    if (result.redirectedFrom) lines.push(`**Redirected from:** ${result.redirectedFrom}`);
    const totals = Object.entries(result.propertyTotals);
    if (totals.length > 0) {
      lines.push(`**Property totals:** ${totals.map(([p, n]) => `${p}: ${n}`).join(', ')}`);
    }
    if (result.nextOffset !== undefined) {
      lines.push(
        `**Next offset:** ${result.nextOffset} — re-call with offset: ${result.nextOffset} to continue every property`,
      );
    }

    lines.push(
      ...statementLines(
        (result.statements ?? {}) as Record<string, NormalizedStatement[]>,
        result.propertyLabels,
      ),
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
