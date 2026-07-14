/**
 * @fileoverview Look up a Wikidata entity by an external identifier (DOI, PubMed ID, ORCID, etc.).
 * @module mcp-server/tools/definitions/resolve-external-id.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getWikidataRestService,
  isEntityNotFoundError,
} from '@/services/wikidata/wikidata-rest-service.js';
import { getWikidataSparqlService } from '@/services/wikidata/wikidata-sparql-service.js';

/**
 * Identifier-resolver wrappers these IDs are commonly presented in, mapped to the bare value
 * Wikidata actually stores. CrossRef, PubMed, and citation managers all routinely render a
 * DOI/PMID/ORCID as a resolver URL, and the URL text never matches the stored identifier.
 *
 * Each pattern captures the bare identifier in group 1. PubMed and ORCID absorb a trailing
 * slash; P356 deliberately does not — a DOI suffix can legitimately end in one.
 */
const RESOLVER_URL_PATTERNS: Record<string, RegExp> = {
  P356: /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)(.+)$/i,
  P698: /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(.+?)\/?$/i,
  P496: /^https?:\/\/orcid\.org\/(.+?)\/?$/i,
};

/** Strip a known identifier-resolver prefix, leaving the bare identifier. */
function stripResolverPrefix(property: string, value: string): string {
  return RESOLVER_URL_PATTERNS[property]?.exec(value)?.[1] ?? value;
}

/**
 * Normalize a value to the canonical form Wikidata stores it in for known P-IDs.
 *
 * Both steps ahead of the switch are order-load-bearing:
 * - The trim precedes the strip because RESOLVER_URL_PATTERNS are `^`-anchored — a padded URL
 *   would not match, and the prefix would survive into the SPARQL literal.
 * - The strip precedes the per-property cases because ORCID's hyphen reformat is gated on a
 *   length-16 check that a URL-prefixed value always fails, so stripping afterwards would leave
 *   a URL-prefixed *unhyphenated* ORCID silently unformatted.
 *
 * Trimming here rather than in a single branch keeps the four cases consistent: only P698 and
 * P496 discard surrounding whitespace incidentally, so a padded DOI or IMDb ID would otherwise
 * reach SPARQL intact and return a confident `match: null` for an identifier that resolves.
 */
function normalizeExternalId(property: string, value: string): string {
  const upperProp = property.toUpperCase();
  const bare = stripResolverPrefix(upperProp, value.trim());
  switch (upperProp) {
    case 'P356':
      // DOI: stored uppercase
      return bare.toUpperCase();
    case 'P698':
      // PubMed ID: strip "PMID:" prefix, keep numeric
      return bare.replace(/^PMID[:\s]*/i, '').trim();
    case 'P496': {
      // ORCID: normalize to 0000-0000-0000-000X format
      const stripped = bare.replace(/[-\s]/g, '');
      if (stripped.length === 16) {
        return `${stripped.slice(0, 4)}-${stripped.slice(4, 8)}-${stripped.slice(8, 12)}-${stripped.slice(12)}`;
      }
      return bare;
    }
    default:
      return bare;
  }
}

export const wikidataResolveExternalId = tool('wikidata_resolve_external_id', {
  title: 'Resolve Wikidata External ID',
  description:
    'Look up a Wikidata entity by an external identifier such as a DOI, PubMed ID, ORCID iD, or OpenAlex ID. ' +
    'Returns match=<entity> on success, match=null when not found, and match=null with multipleMatches populated ' +
    'when a Wikidata data integrity issue causes more than one entity to claim the same external ID. ' +
    'Common cross-server join use cases: CrossRef DOI → Wikidata paper QID (P356), ' +
    'PubMed PMID → Wikidata paper QID (P698), ORCID → author QID (P496), ' +
    'OpenAlex ID → entity QID (P10283). ' +
    'The property must be one whose Wikidata data type is external-id — item-valued or media ' +
    'properties (e.g. P31 instance-of, P18 image) are rejected rather than returning an empty match. ' +
    'Known value normalization is applied automatically: surrounding whitespace is trimmed, ' +
    'identifier-resolver URL prefixes are stripped ' +
    '(https://doi.org/, https://pubmed.ncbi.nlm.nih.gov/, https://orcid.org/), ' +
    'DOIs are uppercased, PMID prefixes stripped, ORCID hyphens normalized.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    property: z
      .string()
      .min(1)
      .describe(
        'P-ID of the external identifier property, whose Wikidata data type must be external-id ' +
          '(e.g., "P356" for DOI, "P698" for PubMed ID, "P496" for ORCID, "P10283" for OpenAlex ID, ' +
          '"P345" for IMDb ID). Properties of any other data type are rejected — check an unfamiliar ' +
          "P-ID's data type with wikidata_get_entity.",
      ),
    value: z
      .string()
      .min(1)
      .describe(
        'The external identifier value to look up (e.g., "10.1038/nature01234" for a DOI, ' +
          '"32283226" for a PubMed ID, "0000-0002-1825-0097" for an ORCID). ' +
          'A resolver URL is accepted for DOI, PubMed, and ORCID — the prefix is stripped before lookup.',
      ),
    language: z
      .string()
      .default('en')
      .describe('Language code for label and description in the response (e.g., "en", "de").'),
  }),

  output: z.object({
    match: z
      .object({
        id: z.string().describe('Wikidata Q-ID of the matching entity (e.g., "Q12345").'),
        label: z
          .string()
          .describe('Display label in the requested language, or empty string if unavailable.'),
        description: z
          .string()
          .describe('Short description in the requested language, or empty string if unavailable.'),
        url: z
          .string()
          .describe('Wikidata entity page URL (e.g., "https://www.wikidata.org/wiki/Q12345").'),
      })
      .nullable()
      .describe(
        'Matching entity, or null when no Wikidata entity claims this external identifier ' +
          '(including the case where multipleMatches is populated). ' +
          'A null match is not proof of absence — the Query Service backing this lookup lags the ' +
          'live wiki, so a recently added identifier may not be indexed yet.',
      ),
    property: z.string().describe('The P-ID used for the lookup.'),
    value: z
      .string()
      .describe(
        'The normalized value that was searched (may differ from input due to canonicalization).',
      ),
    multipleMatches: z
      .array(
        z
          .object({
            id: z.string().describe('Q-ID of a matching entity.'),
            label: z.string().describe('Display label of this match.'),
          })
          .describe('One of the entities that claims this external identifier.'),
      )
      .optional()
      .describe(
        'Present when more than one Wikidata entity claims this external ID (data integrity issue). ' +
          'match is null when this field is present. Inspect the list and select the correct QID manually.',
      ),
  }),

  errors: [
    {
      reason: 'invalid_property',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Property ID is not in P+digits format.',
      recovery: 'Supply a valid P-ID (P followed by digits, e.g. P356 for DOI).',
    },
    {
      reason: 'not_external_id_property',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Property does not exist on Wikidata, or its data type is not external-id.',
      recovery:
        'Supply a P-ID whose data type is external-id, such as P356 (DOI), P698 (PubMed ID), P496 (ORCID), P10283 (OpenAlex ID), or P345 (IMDb ID).',
    },
  ],

  async handler(input, ctx) {
    // This check is bespoke rather than the service's normalizeId/isPId pair, so it carries
    // its own trim — the format test below is strict about surrounding whitespace.
    const prop = input.property.trim().toUpperCase();
    if (!/^P\d+$/.test(prop)) {
      throw ctx.fail(
        'invalid_property',
        `"${input.property}" is not a valid property ID. Expected P followed by digits.`,
        { ...ctx.recoveryFor('invalid_property') },
      );
    }

    /**
     * Reject a property that cannot carry an external identifier before spending a SPARQL
     * call on it. `?item wdt:P31 "Q5"` is valid SPARQL that simply matches nothing, so
     * without this the caller gets `match: null` — indistinguishable from a genuine miss —
     * for a lookup that could never have succeeded.
     *
     * A missing property and a wrong-datatype one share the reason: the caller's fix is the
     * same either way, supply a different P-ID.
     */
    const restSvc = getWikidataRestService();
    let dataType: string | undefined;
    try {
      dataType = await restSvc.fetchPropertyDataType(prop, ctx);
    } catch (err) {
      if (isEntityNotFoundError(err)) {
        throw ctx.fail(
          'not_external_id_property',
          `Property "${prop}" does not exist on Wikidata.`,
          { ...ctx.recoveryFor('not_external_id_property') },
        );
      }
      throw err;
    }

    if (dataType !== 'external-id') {
      throw ctx.fail(
        'not_external_id_property',
        `Property ${prop} has data type "${dataType}", not "external-id", so it cannot be resolved as an external identifier.`,
        { dataType, ...ctx.recoveryFor('not_external_id_property') },
      );
    }

    const normalizedValue = normalizeExternalId(prop, input.value);
    ctx.log.info('Resolving external ID', {
      property: prop,
      value: normalizedValue,
      language: input.language,
    });

    const svc = getWikidataSparqlService();

    // Escape value for SPARQL string literal — double quotes need escaping
    const escapedValue = normalizedValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const sparql = `SELECT ?item ?itemLabel ?itemDescription WHERE {
  ?item wdt:${prop} "${escapedValue}" .
  OPTIONAL { ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "${input.language}") }
  OPTIONAL { ?item schema:description ?itemDescription . FILTER(LANG(?itemDescription) = "${input.language}") }
}
LIMIT 5`;

    const response = await svc.query(sparql, '', undefined, ctx);
    const bindings = response.results.bindings;

    if (bindings.length === 0) {
      return { match: null, property: prop, value: normalizedValue };
    }

    // Extract QIDs
    const matches = bindings.map((b) => ({
      id: b.item?.value.replace('http://www.wikidata.org/entity/', '') ?? '',
      label: b.itemLabel?.value ?? '',
      description: b.itemDescription?.value ?? '',
    }));

    // Deduplicate by QID (SPARQL may return multiple rows for same item with different labels)
    const unique = [...new Map(matches.map((m) => [m.id, m])).values()];

    if (unique.length > 1) {
      // Wikidata data integrity issue — multiple entities claim the same external ID.
      // Return all matches so the agent can pick the right one.
      return {
        match: null,
        property: prop,
        value: normalizedValue,
        multipleMatches: unique.map((m) => ({ id: m.id, label: m.label })),
      };
    }

    // unique.length === 1 guaranteed by the preceding check
    const m = unique[0] as (typeof unique)[number];
    return {
      match: {
        id: m.id,
        label: m.label,
        description: m.description,
        url: `https://www.wikidata.org/wiki/${m.id}`,
      },
      property: prop,
      value: normalizedValue,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**Property:** ${result.property} | **Value searched:** ${result.value}`,
    ];

    if (result.match !== null) {
      lines.push(`**Match:** ${result.match.label || result.match.id}`);
      lines.push('');
      lines.push(`## ${result.match.label || result.match.id}`);
      lines.push(`**QID:** ${result.match.id}`);
      if (result.match.description) lines.push(`**Description:** ${result.match.description}`);
      lines.push(`**URL:** ${result.match.url}`);
    } else if (result.multipleMatches?.length) {
      lines.push(
        `**Match:** multiple (${result.multipleMatches.length}) — Wikidata data integrity issue`,
      );
      lines.push(
        '\n**Multiple entities claim this external ID — select the correct QID manually:**',
      );
      for (const entry of result.multipleMatches) {
        lines.push(`- ${entry.id}: ${entry.label || '(no label)'}`);
      }
    } else {
      lines.push('**Match:** none');
      lines.push('\n> No Wikidata entity found for this external identifier.');
    }

    // Render multipleMatches even when match is present — satisfies format parity for linter
    // synthetic variants that populate both fields simultaneously.
    if (result.match !== null && result.multipleMatches?.length) {
      lines.push('\n**Also matched:**');
      for (const entry of result.multipleMatches) {
        lines.push(`- ${entry.id}: ${entry.label || '(no label)'}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
