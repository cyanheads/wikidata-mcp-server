/**
 * @fileoverview Fetch a Wikidata entity by QID or PID with field selection.
 * @module mcp-server/tools/definitions/get-entity.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DEFAULT_OUTLINE_BUDGET_BYTES,
  formatOutline,
  OUTLINE_VARIANT,
  type SectionMeta,
} from '@cyanheads/mcp-ts-core/utils';
import {
  getWikidataRestService,
  isEntityNotFoundError,
  isPId,
  isQId,
  normalizeId,
  resolveLangValue,
} from '@/services/wikidata/wikidata-rest-service.js';

const FIELD_ENUM = z.enum(['labels', 'descriptions', 'aliases', 'statements', 'sitelinks']);

/**
 * How to retrieve a category whose own size exceeds the budget, which `fields` therefore
 * cannot deliver — re-calling `fields` with it returns the same overflowing payload.
 *
 * Every category has a narrowing lever at a granularity `fields` has no vocabulary for: the
 * two collection-shaped ones each have a sibling tool that selects members, and the
 * language-keyed maps narrow through this tool's own `languages`.
 */
function routeFor(section: string): string {
  switch (section) {
    case 'statements':
      return 'wikidata_get_statements with properties:[...] to select individual P-IDs';
    case 'sitelinks':
      return 'wikidata_get_sitelinks with sites:[...] to select individual site codes';
    default:
      return 'the languages parameter to narrow to specific language codes';
  }
}

/** One section per field category, sized by serialized length, largest first. */
function sectionsOf(categories: Record<string, unknown>): SectionMeta[] {
  return Object.entries(categories)
    .map(([name, value]) => ({ name, bytes: JSON.stringify(value).length }))
    .sort((a, b) => b.bytes - a.bytes);
}

/**
 * Serialized size of the response a `fields:[names]` re-call would produce — the same
 * measurement the handler applies to decide overflow. Every claim the notice makes about a
 * re-call is checked with this, so a suggested call cannot come back as the outline the
 * caller just read.
 */
function sizeOf(categories: Record<string, unknown>, names: string[]): number {
  return JSON.stringify(Object.fromEntries(names.map((k) => [k, categories[k]]))).length;
}

/**
 * Largest subset of `names`, in the order given, whose combined size fits the budget.
 * First-fit over the size-sorted sections: take each one that still fits alongside those
 * already taken, skip the rest.
 *
 * Combined is the operative word. Sections that each fit individually can overflow together
 * — Q30's labels/descriptions/aliases are 10,431 + 6,848 + 12,447 = 29,726 against a 24,000
 * budget — so enumerating everything that fits on its own would name a re-call that returns
 * this same outline, forever. Callers are given a set that terminates.
 */
function packWithinBudget(categories: Record<string, unknown>, names: string[]): string[] {
  const chosen: string[] = [];
  for (const name of names) {
    if (sizeOf(categories, [...chosen, name]) <= DEFAULT_OUTLINE_BUDGET_BYTES) chosen.push(name);
  }
  return chosen;
}

/**
 * Builds the re-call notice. Following it literally must make progress, so every route it
 * names is one this tool has verified will return data:
 *
 * - A category that cannot be returned even alone is redirected to a tool that can narrow
 *   below a whole category (see routeFor). `fields` would hand back the same overflow.
 * - The rest are packed into one `fields` set measured to fit, named as a literal array the
 *   caller can copy. Anything left over is deferred to a further call rather than folded
 *   into a set that would not fit.
 */
function buildNotice(categories: Record<string, unknown>, sections: SectionMeta[]): string {
  /**
   * Deliverable alone is the k=1 case of the re-call's own budget check — not `bytes <=
   * budget`, which ignores the key overhead the response carries and would let a knife-edge
   * category be offered through `fields` and bounce straight back as an outline.
   */
  const deliverable: SectionMeta[] = [];
  const oversized: SectionMeta[] = [];
  for (const section of sections) {
    const fits = sizeOf(categories, [section.name]) <= DEFAULT_OUTLINE_BUDGET_BYTES;
    (fits ? deliverable : oversized).push(section);
  }

  // The first deliverable section fits by definition, so this is never empty when one exists.
  const chosen = packWithinBudget(
    categories,
    deliverable.map((s) => s.name),
  );
  const deferred = deliverable.filter((s) => !chosen.includes(s.name)).map((s) => s.name);

  const parts = ['Entity too large to inline.'];
  if (chosen.length > 0) {
    parts.push(
      `Re-call wikidata_get_entity with the same id plus fields:${JSON.stringify(chosen)} — that set fits the ${DEFAULT_OUTLINE_BUDGET_BYTES}-byte budget and returns the data.`,
    );
  }
  if (deferred.length > 0) {
    parts.push(`Request ${deferred.join(' and ')} in a further call; together they would not fit.`);
  }
  for (const section of oversized) {
    parts.push(
      `${section.name} is ${section.bytes} bytes on its own — fields cannot deliver it; use ${routeFor(section.name)}.`,
    );
  }
  return parts.join(' ');
}

export const wikidataGetEntity = tool('wikidata_get_entity', {
  title: 'Get Wikidata Entity',
  description:
    'Fetch a Wikidata entity (item or property) by QID or PID. ' +
    'The fields parameter narrows the upstream fetch, not just the response — asking for labels alone ' +
    'costs a fraction of the whole entity, so name the fields you need. ' +
    'Omit fields for all data; a well-connected item is large enough to overflow, and an oversized entity ' +
    'returns kind: "outline" — the field categories with their byte sizes — instead of the data. ' +
    'Follow its retrieval_notice literally rather than picking from sections yourself — it names a fields set ' +
    'already measured to fit, since category sizes are additive and requesting them all would overflow again; ' +
    'for a category too large to deliver whole (statements or sitelinks on a major item) it names the sibling ' +
    'tool that can narrow it. ' +
    'Q-IDs (e.g. Q76) fetch items; P-IDs (e.g. P31) fetch properties from the correct endpoint automatically. ' +
    "Use wikidata_get_statements for deep claim traversal with label resolution, and whenever an entity's " +
    'statements are large — its properties parameter selects individual P-IDs, granularity fields does not carry.',
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
        'Fields to include. Options: "labels", "descriptions", "aliases", "statements", "sitelinks". ' +
          'Narrows the upstream fetch as well as the response, so a narrow selection is markedly cheaper. ' +
          'Omit for all fields.',
      ),
    languages: z
      .array(z.string())
      .optional()
      .describe(
        'Language codes to include in labels, descriptions, and aliases (e.g., ["en", "de"]). ' +
          'A requested language with no label of its own falls back to the entity\'s multilingual ("mul") ' +
          'value, returned under the requested code. Omit to return all available languages.',
      ),
  }),

  output: z.object({
    id: z.string().describe('Normalized entity ID (e.g., "Q76" or "P31").'),
    type: z.string().describe('Entity type: "item" or "property".'),
    kind: z
      .enum(['full', 'outline'])
      .describe(
        'full — the requested field categories carry their data. outline — the entity overflowed the ' +
          'inline byte budget, so sections lists the categories with their byte sizes instead, and ' +
          'retrieval_notice names how to fetch each one. The id and type are present either way.',
      ),
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
        'Map of property ID to array of raw statement objects. Use wikidata_get_statements for resolved claims ' +
          "with label resolution, and whenever this entity's statements are large — its properties parameter " +
          'selects individual P-IDs, granularity fields does not carry.',
      ),
    // Sitelink values are from a dynamic external API — passthrough preserves all nested fields
    // (title, url, badges) in structuredContent without aspirational per-field typing.
    sitelinks: z
      .record(z.string(), z.object({}).passthrough())
      .optional()
      .describe(
        'Map of site code (e.g., "enwiki") to sitelink metadata with title, url, and badges fields.',
      ),
    fieldsReturned: z
      .array(z.string())
      .describe(
        'Which fields were requested. In outline mode these are the categories the outline covers, not data returned.',
      ),
    sections: z
      .array(
        OUTLINE_VARIANT.shape.sections.element.describe(
          'An available field category — its name and the serialized byte size of its data.',
        ),
      )
      .optional()
      .describe(
        "Present when kind = outline: the entity's field categories, largest first, each with its byte " +
          'size. Sizes are additive — a set of categories is only retrievable together if their total fits ' +
          'the budget, so follow retrieval_notice rather than requesting every name listed here.',
      ),
    // Named retrieval_notice, not notice: it is part of the outline payload the agent acts
    // on, not additive agent-facing context. Enrichment is merged *after* output.parse and
    // so can only add to a fat result, never replace it with an outline.
    retrieval_notice: OUTLINE_VARIANT.shape.notice
      .optional()
      .describe(
        'Present when kind = outline: the next call to make, and the authoritative one to follow. It names a ' +
          'literal fields set already measured to fit the budget, defers any category that would not fit ' +
          'alongside it, and for a category too large for fields to deliver at all names the sibling tool ' +
          '(wikidata_get_statements, wikidata_get_sitelinks) or the languages parameter that can narrow it.',
      ),
  }),

  errors: [
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No entity exists at this ID — either unassigned (resource-not-found) or out of range (invalid-path-parameter).',
      recovery: 'Verify the ID with wikidata_search_entities or check the Wikidata URL directly.',
    },
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.ValidationError,
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
      entity = await svc.fetchEntity(id, ctx, input.fields);
    } catch (err) {
      if (isEntityNotFoundError(err)) {
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

    /**
     * Narrows a language-keyed map to the requested languages, resolving each one through the
     * entity's `mul` (multilingual) entry when it has no label in that exact language. The
     * REST API has no language-fallback parameter, so this has to happen here. The resolved
     * value lands under the *requested* key (labels.en), never a raw `mul` key, to match the
     * declared Record<lang, string> output contract.
     */
    const filterLangs = <T>(map: Record<string, T> | undefined): Record<string, T> | undefined => {
      if (!map) return;
      if (!input.languages?.length) return map;
      const filtered: Record<string, T> = {};
      for (const lang of input.languages) {
        const value = resolveLangValue(map, lang);
        if (value !== undefined) filtered[lang] = value;
      }
      return Object.keys(filtered).length ? filtered : undefined;
    };

    /** Cheap metadata — kept in both arms; the overflow primitive returns only kind/sections/notice. */
    const base: Record<string, unknown> = {
      id: entity.id,
      type: entity.type,
      fieldsReturned: [...requestedFields],
      ...(entity.data_type ? { data_type: entity.data_type } : {}),
    };

    /**
     * The field categories, kept apart from the envelope above because they are the only
     * keys `fields` can name — which makes them exactly the sections an outline may offer,
     * and the default extractor the right one. Outlining the whole result instead would
     * advertise `id`/`type`/`fieldsReturned` as sections, and a re-call naming those is not
     * something `fields` accepts.
     */
    const categories: Record<string, unknown> = {};

    if (requestedFields.has('labels')) {
      const labels = filterLangs(entity.labels);
      if (labels) categories.labels = labels;
    }
    if (requestedFields.has('descriptions')) {
      const descriptions = filterLangs(entity.descriptions);
      if (descriptions) categories.descriptions = descriptions;
    }
    if (requestedFields.has('aliases')) {
      const aliases = filterLangs(entity.aliases);
      if (aliases) categories.aliases = aliases;
    }
    if (requestedFields.has('statements') && entity.statements) {
      categories.statements = entity.statements;
    }
    if (requestedFields.has('sitelinks') && entity.sitelinks) {
      categories.sitelinks = Object.fromEntries(
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

    /**
     * Outline whenever the categories overflow — including the single-section case that
     * `outlineOnOverflow` deliberately short-circuits past, which is why this tool measures
     * itself rather than delegating the decision.
     *
     * The primitive returns a document whole below two sections because an outline offering
     * one section would cost a round-trip whose only possible re-call returns the same
     * bytes. That reasoning holds only when the re-call lever is the tool's own selector.
     * Here it is not: every oversized category narrows through a lever `fields` has no
     * vocabulary for (see routeFor). The round-trip redirects rather than repeats, so
     * short-circuiting it would hand back the exact payload the outline exists to prevent —
     * `fields: ["statements"]` on a major item is ~793KB, past what a client can accept.
     *
     * wikidata_get_statements keeps the primitive: there the only lever IS its own
     * `properties`, which is the case the short-circuit was written for.
     */
    // The output schema defines the full shape — these satisfy it at runtime even though
    // the TypeScript type is widened to Record<string, unknown>.
    if (JSON.stringify(categories).length > DEFAULT_OUTLINE_BUDGET_BYTES) {
      const sections = sectionsOf(categories);
      ctx.log.info('Entity overflowed — returning outline', { id, sections: sections.length });
      return {
        ...base,
        kind: 'outline',
        sections,
        retrieval_notice: buildNotice(categories, sections),
      } as never;
    }

    return { ...base, ...categories, kind: 'full' } as never;
  },

  /**
   * Each arm renders on the presence of its own fields, never by branching on `kind` —
   * format-parity injects one synthetic sample with every optional field populated at once,
   * so a mutually-exclusive branch would leave the untaken arm's fields unrendered.
   */
  format: (result) => {
    const lines: string[] = [`## ${result.id} (${result.type})`];

    if (result.data_type) lines.push(`**Data type:** ${result.data_type}`);
    lines.push(
      `**Fields returned:** ${result.fieldsReturned.join(', ')} | **Response:** ${result.kind}`,
    );

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
      const otherDescEntries = Object.entries(result.descriptions).filter(
        ([lang]) => lang !== 'en',
      );
      const otherDescs = otherDescEntries.slice(0, 3).map(([lang, val]) => `${lang}: ${val}`);
      if (otherDescs.length) {
        const total = Object.keys(result.descriptions).length;
        lines.push(
          `**Descriptions (sample):** ${otherDescs.join(' | ')}${otherDescEntries.length > 3 ? ` … (${total} total)` : ''}`,
        );
      }
    }

    if (result.aliases) {
      const aliasEntries = Object.entries(result.aliases);
      for (const [lang, aliases] of aliasEntries.slice(0, 3)) {
        if (aliases.length) {
          lines.push(
            `**Aliases (${lang}):** ${aliases.slice(0, 5).join(', ')}${aliases.length > 5 ? ` … (${aliases.length} total)` : ''}`,
          );
        }
      }
      if (aliasEntries.length > 3) {
        lines.push(`**Aliases:** … (${aliasEntries.length} languages total)`);
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
