/**
 * @fileoverview Look up a Wikidata entity by an external identifier (DOI, PubMed ID, ORCID, etc.).
 * @module mcp-server/tools/definitions/resolve-external-id.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, serializationError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { DEFAULT_LANGUAGE, languageCode } from '@/mcp-server/tools/language-code.js';
import { isUpstreamUnavailable } from '@/mcp-server/tools/upstream-unavailable.js';
import type { SparqlBinding } from '@/services/wikidata/types.js';
import {
  getWikidataRestService,
  isEntityNotFoundError,
} from '@/services/wikidata/wikidata-rest-service.js';
import {
  getWikidataSparqlService,
  type SparqlGraph,
} from '@/services/wikidata/wikidata-sparql-service.js';

/**
 * The resolver prefix each property's identifiers are commonly presented behind — a resolver URL
 * (`https://`, `http://`, or no scheme ahead of the host) or a scheme label like `doi:` — none of
 * which is part of the value Wikidata stores. Each pattern is `^`-anchored, case-insensitive, and
 * matches the prefix alone, so it never reads past it into the identifier. A trailing slash is the
 * property's own step: PubMed and ORCID drop it, and a DOI keeps it, since a DOI suffix can end in
 * one.
 */
const RESOLVER_PREFIXES: Record<string, RegExp> = {
  P356: /^(?:(?:https?:\/\/)?(?:dx\.|www\.)?doi\.org\/|doi:)/i,
  P698: /^(?:(?:https?:\/\/)?(?:pubmed\.ncbi\.nlm\.nih\.gov|www\.ncbi\.nlm\.nih\.gov\/pubmed)\/|pmid[:\s]*)/i,
  P496: /^(?:(?:https?:\/\/)?(?:www\.)?orcid\.org\/|orcid:)/i,
  /** An OpenAlex page or API URL, with the entity path an API URL carries (`authors/`, `works/`, …). */
  P10283: /^(?:https?:\/\/)?(?:api\.)?openalex\.org\/(?:[a-z]+\/)?/i,
  /** IMDb's page path for each kind of ID; whatever follows the ID in a URL is page path too. */
  P345: /^(?:https?:\/\/)?(?:www\.|m\.)?imdb\.com\/(?:title|name|company|event)\//i,
  P932: /^pmc/i,
  P6782: /^(?:https?:\/\/)?ror\.org\//i,
  P818: /^(?:arxiv:|(?:https?:\/\/)?arxiv\.org\/abs\/)/i,
};

/** Modern and legacy arXiv identifiers, including a version when given. */
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/;

/** An ISNI displayed as four groups of four characters. */
const GROUPED_ISNI = /^(?:\d{4} ){3}\d{3}[\dX]$/;

/**
 * An IMDb ID as P345 stores it, read case-insensitively: a two-letter prefix and digits, or one of
 * the two compound forms P345's format admits — a title's character page, and an event's ceremony
 * by year, which IMDb URLs number within the year (`/1`, `/2`). The ceremony number is captured.
 */
const IMDB_ID = /^(?:tt\d+\/characters\/nm\d+|ev\d+\/\d{4}(\/[12])?|[a-z]{2}\d+)/i;

/** The value without one trailing slash. */
const dropTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value.slice(0, -1) : value;

/**
 * An ORCID iD in its stored `0000-0000-0000-000X` form: hyphens and spaces regrouped, and the
 * check character `x` written `X`, the only case stored. A value that is not 16 characters once
 * regrouped is left as given.
 */
function normalizeOrcid(value: string): string {
  const compact = value.replace(/[-\s]/g, '');
  if (compact.length !== 16) return value;
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 15)}${compact.slice(15).toUpperCase()}`;
}

/**
 * The forms an IMDb ID is looked up in, or undefined when `path` holds none. IMDb IDs are stored
 * lowercase, so the ID is lowercased. From a URL (`fromUrl`), the ID ends where its pattern does
 * and the page path after it is dropped; a bare value must be an ID and nothing else.
 *
 * A ceremony numbered within its year is stored with the number only for a year that held two;
 * other years are stored as `ev…/<year>`. So a numbered ceremony is tried as given, then without
 * the number.
 */
function imdbIdForms(path: string, fromUrl: boolean): string[] | undefined {
  const match = IMDB_ID.exec(path);
  if (match === null || (!fromUrl && match[0].length !== path.length)) return;
  const id = match[0].toLowerCase();
  return match[1] === undefined ? [id] : [id, id.slice(0, -match[1].length)];
}

/**
 * An OpenAlex ID's forms. P10283 stores the entity letter in either case (`A5035517966`,
 * `a5041957172`), and each ID resolves only in the case it is stored in, so the value is tried as
 * given and then with its leading letter's case flipped.
 */
function openAlexForms(value: string): string[] {
  const letter = value[0];
  if (letter === undefined || !/[a-z]/i.test(letter)) return [value];
  const flipped = letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase();
  return [value, `${flipped}${value.slice(1)}`];
}

/**
 * The forms of `value` to look up for `property`, in the order they are tried: the first is the
 * value searched, and a later one matters only when no claimant holds an earlier one. Every
 * property but P10283, and P345 for a numbered ceremony, has one form.
 *
 * The value is trimmed, a known resolver prefix stripped, and the remainder trimmed again — the
 * first trim because the prefixes are `^`-anchored, the second for the space a label prefix like
 * `doi: ` leaves. The strip runs ahead of each property's own step: ORCID's regrouping is gated on
 * a length a URL-prefixed value never has. Every property is trimmed, not only those whose step
 * happens to discard whitespace, so a padded DOI or IMDb ID never reaches the query intact.
 */
export function normalizeExternalId(property: string, value: string): string[] {
  const given = value.trim();
  const prefix = RESOLVER_PREFIXES[property];
  const bare = prefix ? given.replace(prefix, '').trim() : given;
  switch (property) {
    case 'P356':
      return [bare.toUpperCase()];
    case 'P698':
      return [dropTrailingSlash(bare)];
    case 'P496':
      return [normalizeOrcid(dropTrailingSlash(bare))];
    case 'P10283':
      return openAlexForms(bare);
    case 'P345':
      // A value that holds no IMDb ID — a URL to another page included — is sent as given.
      return imdbIdForms(bare, bare !== given) ?? [given];
    case 'P932':
      return [bare !== given && /^[1-9]\d+$/.test(bare) ? bare : given];
    case 'P6782':
      return [bare !== given && /^[a-z0-9]{9}$/.test(bare) ? bare : given];
    case 'P213':
      return [GROUPED_ISNI.test(given) ? given.replaceAll(' ', '') : given];
    case 'P818':
      return [bare !== given && ARXIV_ID.test(bare) ? bare : given];
    default:
      return [given];
  }
}

/** A statement's rank, in the vocabulary wikidata_get_statements reports it in. */
const STATEMENT_RANK = z.enum(['preferred', 'normal', 'deprecated']);
type StatementRank = z.infer<typeof STATEMENT_RANK>;

/** The Query Service's rank IRIs, read off each statement node. */
const RANK_BY_IRI = new Map<string, StatementRank>([
  ['http://wikiba.se/ontology#PreferredRank', 'preferred'],
  ['http://wikiba.se/ontology#NormalRank', 'normal'],
  ['http://wikiba.se/ontology#DeprecatedRank', 'deprecated'],
]);

/**
 * Most claimants `multipleMatches` lists. The query fetches one more, so a call knows when more
 * entities claim the identifier than it lists.
 */
const MULTIPLE_MATCH_CAP = 5;

/**
 * The graphs the lookup searches, each under the name `unavailableGraphs` reports it by. Since the
 * Query Service's graph split, scholarly articles and every statement on them — DOIs and PubMed IDs
 * included — live only in the scholarly graph, and everything else only in the main one.
 */
const GRAPH_NAME = z.enum(['wikidata_main', 'scholarly_articles']);
type GraphName = z.infer<typeof GRAPH_NAME>;
const GRAPHS = [
  { graph: 'main', name: 'wikidata_main' },
  { graph: 'scholarly', name: 'scholarly_articles' },
] as const satisfies readonly { graph: SparqlGraph; name: GraphName }[];

/**
 * One deadline for both graph lookups, retries included. With the datatype check ahead of it, a
 * call settles well inside the 60 s an MCP client waits on a request, and a graph that misses it is
 * disclosed rather than holding the other's answer back.
 */
const LOOKUP_DEADLINE_MS = 20_000;

/** One claimant row of the lookup query. */
interface LookupRow {
  description: string;
  /** Index into the looked-up forms of the one this row matched. */
  form: number;
  id: string;
  label: string;
  rank: StatementRank;
  /**
   * The rank tier the claim falls in: 0 for a best-rank statement — exactly the statements the
   * Query Service writes a truthy `wdt:` triple for — 1 for another non-deprecated one, 2 for a
   * deprecated one.
   */
  tier: number;
}

/**
 * Decode one lookup row. The query binds `item`, `form`, `rank`, and `best` on every row it
 * returns, so a row without them is a response this query cannot produce: it fails rather than
 * becoming a blank or rankless claimant.
 */
function decodeRow(binding: Record<string, SparqlBinding>): LookupRow {
  const item = binding.item?.value;
  const form = Number(binding.form?.value);
  const rank = RANK_BY_IRI.get(binding.rank?.value ?? '');
  const best = binding.best?.value;
  if (item === undefined || !Number.isInteger(form) || rank === undefined || best === undefined) {
    throw serializationError(
      'The Query Service returned a lookup row without its item, form, rank, or best-rank flag.',
      { variables: Object.keys(binding) },
    );
  }
  return {
    id: item.replace('http://www.wikidata.org/entity/', ''),
    form,
    rank,
    tier: best === 'true' ? 0 : rank === 'deprecated' ? 2 : 1,
    label: binding.itemLabel?.value ?? binding.mulLabel?.value ?? '',
    description: binding.itemDescription?.value ?? '',
  };
}

/**
 * The claimants an identifier resolves to: the entities holding it at the first form any entity
 * holds, and within that form at the best rank tier any holds it at. Each entity appears once,
 * at its own best claim, so two statements of the same value on one entity are one claimant.
 *
 * Tier 0 alone reproduces a `wdt:` lookup exactly, so an identifier some entity holds at best
 * rank resolves to the same entities it always did; only identifiers held at no best rank reach
 * the later tiers. Claimants keep the order of their rows.
 */
function selectClaimants(rows: LookupRow[]): LookupRow[] {
  const order = (row: LookupRow) => row.form * 3 + row.tier;
  const claims = new Map<string, LookupRow>();
  for (const row of rows) {
    const held = claims.get(row.id);
    if (held === undefined || order(row) < order(held)) claims.set(row.id, row);
  }
  const claimants = [...claims.values()];
  const first = Math.min(...claimants.map(order));
  return claimants.filter((row) => order(row) === first);
}

/** One `multipleMatches` entry as a list item. */
const claimantLine = (entry: { id: string; label: string; rank: StatementRank }): string =>
  `- ${entry.id} (${entry.rank} rank): ${escapeMarkdownInline(entry.label || '(no label)')}`;

export const wikidataResolveExternalId = tool('wikidata_resolve_external_id', {
  title: 'Resolve Wikidata External ID',
  description:
    'Look up a Wikidata entity by an external identifier such as a DOI, PubMed ID, ORCID iD, OpenAlex ID, or IMDb ID. Returns match=<entity> on success, match=null when not found, and match=null with multipleMatches populated when a Wikidata data integrity issue causes more than one entity to claim the same external ID. The identifier matches through statements of every rank — entities holding it at best rank first, then at another non-deprecated rank, then deprecated — and each match reports the rank of the statement it was found through. The lookup searches both the main Wikidata graph and the scholarly-article graph, where scholarly articles and the DOIs and PubMed IDs on them live; when one does not answer, the result covers the other, with unavailableGraphs naming the one missed. Common cross-server join use cases: CrossRef DOI → Wikidata paper QID (P356), PubMed PMID → Wikidata paper QID (P698), ORCID → author QID (P496), OpenAlex ID → entity QID (P10283). The property must be one whose Wikidata data type is external-id — item-valued or media properties (e.g. P31 instance-of, P18 image) are rejected rather than returning an empty match. Known value forms are normalized automatically. Surrounding whitespace is trimmed. Resolver prefixes are stripped, in any case and with https://, http://, or no scheme: doi.org/, dx.doi.org/, www.doi.org/, and doi: for DOIs; pubmed.ncbi.nlm.nih.gov/, www.ncbi.nlm.nih.gov/pubmed/, and PMID: for PubMed IDs; orcid.org/, www.orcid.org/, and orcid: for ORCID iDs; openalex.org/ and api.openalex.org/ with an optional entity path for OpenAlex IDs; and the title, name, company, and event pages of imdb.com, www.imdb.com, and m.imdb.com for IMDb IDs; ror.org/ for ROR; and arxiv.org/abs/ or arXiv: for arXiv. PMC is stripped from numeric PMCIDs, and ISNI values displayed in four space-separated groups are compacted. DOIs are uppercased, ORCID iDs regrouped with hyphens and an uppercase X check character, and IMDb IDs lowercased. An OpenAlex ID is stored with its entity letter in either case, so it is tried as given and then with that letter in the other case.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    property: z
      .string()
      .min(1)
      .describe(
        `P-ID of the external identifier property, whose Wikidata data type must be external-id (e.g., "P356" for DOI, "P698" for PubMed ID, "P496" for ORCID, "P10283" for OpenAlex ID, "P345" for IMDb ID). Properties of any other data type are rejected — check an unfamiliar P-ID's data type with wikidata_get_entity.`,
      ),
    value: z
      .string()
      .min(1)
      .describe(
        'The external identifier value to look up (e.g., "10.1038/nature01234" for a DOI, "32283226" for a PubMed ID, "0000-0002-1825-0097" for an ORCID, "A5035517966" for an OpenAlex ID, "tt0111161" for an IMDb ID). Accepts resolver or page URLs for DOI, PubMed, ORCID, OpenAlex, IMDb, and ROR, and abs URLs for arXiv. Also accepts PMC-prefixed PMCIDs, four space-separated ISNI groups, and arXiv: labels.',
      ),
    language: languageCode()
      .default(DEFAULT_LANGUAGE)
      .describe(
        'Wikidata language code for the label and description in the response (e.g., "en", "de"). Case-insensitive; "_" is read as "-"; blank means "en". An entity with no label in this language returns its multilingual ("mul") label.',
      ),
  }),

  output: z.object({
    match: z
      .object({
        id: z.string().describe('Wikidata Q-ID of the matching entity (e.g., "Q12345").'),
        label: z
          .string()
          .describe(
            'Display label in the requested language, else the multilingual ("mul") label, or empty string if neither exists.',
          ),
        description: z
          .string()
          .describe('Short description in the requested language, or empty string if unavailable.'),
        url: z
          .string()
          .describe('Wikidata entity page URL (e.g., "https://www.wikidata.org/wiki/Q12345").'),
        rank: STATEMENT_RANK.describe(
          'Rank of the statement through which the entity holds this identifier. "deprecated" means Wikidata marks the identifier as no longer valid for the entity — often a retired or mistaken ID.',
        ),
      })
      .nullable()
      .describe(
        'Matching entity, or null when no Wikidata entity claims this external identifier (including the case where multipleMatches is populated). The identifier matches through statements of every rank, from the best tier any entity holds it at: best-rank statements first, then other non-deprecated ones, then deprecated ones. A null match is not proof of absence: the Query Service backing this lookup lags the live wiki, so a recently added identifier may not be indexed yet, and a graph named in unavailableGraphs was not searched.',
      ),
    property: z.string().describe('The P-ID used for the lookup.'),
    value: z
      .string()
      .describe(
        'The normalized value that was searched (may differ from input due to canonicalization). An identifier stored in more than one form — an OpenAlex ID with its entity letter in either case, an IMDb ceremony with or without its number — is also looked up in its other form, which matches only when no entity holds this one.',
      ),
    unavailableGraphs: z
      .array(
        GRAPH_NAME.describe(
          'A graph that did not answer: "wikidata_main" (everything but scholarly articles) or "scholarly_articles" (scholarly articles and their DOIs, PubMed IDs, and other identifiers).',
        ),
      )
      .optional()
      .describe(
        'Present when one of the two graphs the lookup searches did not answer in time or could not be reached. The result covers the other graph only — an entity held in the named graph would not appear — so retry for a complete answer. Absent when both answered.',
      ),
    multipleMatches: z
      .array(
        z
          .object({
            id: z.string().describe('Q-ID of a matching entity.'),
            label: z.string().describe('Display label of this match.'),
            rank: STATEMENT_RANK.describe(
              'Rank of the statement through which this entity holds the identifier.',
            ),
          })
          .describe('One of the entities that claims this external identifier.'),
      )
      .optional()
      .describe(
        `Present when more than one Wikidata entity claims this external ID at the same rank tier (data integrity issue), listing at most ${MULTIPLE_MATCH_CAP}; the notice says when more claim it. match is null when this field is present. Inspect the list and select the correct QID manually.`,
      ),
  }),

  /**
   * Agent-facing context about what the response leaves out. Every condition a call raises is
   * joined into one notice, since a second `ctx.enrich.notice()` replaces the first.
   */
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        `Present when a graph did not answer (unavailableGraphs names it), or when more than ${MULTIPLE_MATCH_CAP} entities claim the identifier, so multipleMatches lists only ${MULTIPLE_MATCH_CAP} of them — saying what the result leaves out and how to get it.`,
      ),
  },
  enrichmentTrailer: {
    notice: {
      render(value: string) {
        return `> ${escapeMarkdownInline(value)}`;
      },
    },
  },

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
      );
    }

    /**
     * Reject a property that cannot carry an external identifier before spending a SPARQL
     * call on it. `?statement ps:P31 "Q5"` is valid SPARQL that simply matches nothing, so
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
        );
      }
      throw err;
    }

    if (dataType !== 'external-id') {
      throw ctx.fail(
        'not_external_id_property',
        `Property ${prop} has data type "${dataType}", not "external-id", so it cannot be resolved as an external identifier.`,
        { dataType },
      );
    }

    const forms = normalizeExternalId(prop, input.value);
    const normalizedValue = forms[0] as string;
    ctx.log.info('Resolving external ID', {
      property: prop,
      value: normalizedValue,
      language: input.language,
    });

    const svc = getWikidataSparqlService();

    // Escape each form for a SPARQL string literal — backslashes and double quotes.
    const valueRows = forms
      .map((form, index) => `("${form.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" ${index})`)
      .join(' ');

    /**
     * The identifier matches through statement nodes, so a value held at any rank is found, not
     * only the best-rank values `wdt:` carries. Every form rides one query, numbered in `?form` by
     * the order it is tried in. Rows sort by form, then rank tier (best rank, other non-deprecated,
     * deprecated), so the `LIMIT` never cuts a claimant of the tier selectClaimants picks for one
     * of a later tier. `DISTINCT` collapses two statements of one value on one entity, so a
     * duplicate cannot push a second claimant past the `LIMIT`; within a tier each entity holds a
     * value at one rank, so each entity takes one row there. The rank's sort order comes from a
     * `VALUES` join rather than an `IF` or arithmetic expression, which the Query Service fails
     * the whole query on here.
     *
     * The language is a schema-validated code, so it is safe inside a string literal. `mulLabel`
     * is the multilingual label, which many items carry instead of a per-language one: the REST
     * tools fall back to it, and the Query Service does not on its own. Descriptions have no
     * `mul` form, so they take the requested language alone.
     */
    const sparql = `SELECT DISTINCT ?item ?form ?rank ?best ?itemLabel ?mulLabel ?itemDescription WHERE {
  VALUES (?value ?form) { ${valueRows} }
  VALUES (?rank ?rankOrder) { (wikibase:PreferredRank 0) (wikibase:NormalRank 1) (wikibase:DeprecatedRank 2) }
  ?item p:${prop} ?statement .
  ?statement ps:${prop} ?value ; wikibase:rank ?rank .
  BIND(EXISTS { ?statement a wikibase:BestRank } AS ?best)
  OPTIONAL { ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "${input.language}") }
  OPTIONAL { ?item rdfs:label ?mulLabel . FILTER(LANG(?mulLabel) = "mul") }
  OPTIONAL { ?item schema:description ?itemDescription . FILTER(LANG(?itemDescription) = "${input.language}") }
}
ORDER BY ?form DESC(?best) ?rankOrder ?item
LIMIT ${MULTIPLE_MATCH_CAP + 1}`;

    /**
     * The same query goes to each graph in parallel, and each answers labels from its own data.
     * Separate requests rather than one federated query, because a federated branch that fails
     * or stalls fails the whole query, and a silenced one reads as a clean miss. Here a graph that
     * does not answer is named in `unavailableGraphs` and the other's answer stands; the call
     * fails only when neither answers, with the main graph's error.
     */
    const outcomes = await Promise.allSettled(
      GRAPHS.map(({ graph }) => svc.query(sparql, '', LOOKUP_DEADLINE_MS, ctx, { graph })),
    );
    const rows: LookupRow[] = [];
    const unavailableGraphs: GraphName[] = [];
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'fulfilled') {
        rows.push(...outcome.value.results.bindings.map(decodeRow));
      } else if (isUpstreamUnavailable(outcome.reason)) {
        // Only a graph that did not answer is stood in for; a parse error and anything else rethrow.
        const { name } = GRAPHS[index] as (typeof GRAPHS)[number];
        ctx.log.warning('Graph unavailable for external ID lookup', {
          graph: name,
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
        unavailableGraphs.push(name);
      } else {
        throw outcome.reason;
      }
    }
    if (unavailableGraphs.length === GRAPHS.length) {
      throw (outcomes[0] as PromiseRejectedResult).reason;
    }

    const claimants = selectClaimants(rows);
    const notices: string[] = [];
    if (unavailableGraphs.length > 0) {
      notices.push(
        `The ${unavailableGraphs.join(', ')} graph did not answer, so an entity held there would be missing from this result. Retry the call for a complete answer.`,
      );
    }
    if (claimants.length > MULTIPLE_MATCH_CAP) {
      notices.push(
        `More than ${MULTIPLE_MATCH_CAP} entities claim this external identifier; multipleMatches lists ${MULTIPLE_MATCH_CAP} of them. List every claimant with wikidata_sparql_query.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    const searched = {
      property: prop,
      value: normalizedValue,
      ...(unavailableGraphs.length > 0 ? { unavailableGraphs } : {}),
    };

    if (claimants.length === 0) {
      return { match: null, ...searched };
    }

    if (claimants.length > 1) {
      // Wikidata data integrity issue — multiple entities claim the same external ID.
      // Return the matches so the agent can pick the right one.
      return {
        match: null,
        ...searched,
        multipleMatches: claimants
          .slice(0, MULTIPLE_MATCH_CAP)
          .map((m) => ({ id: m.id, label: m.label, rank: m.rank })),
      };
    }

    const m = claimants[0] as LookupRow;
    return {
      match: {
        id: m.id,
        label: m.label,
        description: m.description,
        url: `https://www.wikidata.org/wiki/${m.id}`,
        rank: m.rank,
      },
      ...searched,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**Property:** ${result.property} | **Value searched:** ${escapeMarkdownInline(result.value)}`,
    ];
    if (result.unavailableGraphs?.length) {
      lines.push(`**Unavailable graphs:** ${result.unavailableGraphs.join(', ')}`);
    }

    if (result.match !== null) {
      lines.push(`**Match:** ${escapeMarkdownInline(result.match.label || result.match.id)}`);
      lines.push('');
      const label = result.match.label || result.match.id;
      lines.push(`## ${/[\r\n]/.test(label) ? result.match.id : escapeMarkdownInline(label)}`);
      lines.push(`**QID:** ${result.match.id}`);
      if (result.match.description)
        lines.push(`**Description:** ${escapeMarkdownInline(result.match.description)}`);
      lines.push(`**URL:** ${markdownLink(result.match.url, result.match.url)}`);
      lines.push(`**Rank:** ${result.match.rank}`);
    } else if (result.multipleMatches?.length) {
      lines.push(
        `**Match:** multiple (${result.multipleMatches.length}) — Wikidata data integrity issue`,
      );
      lines.push(
        '\n**Multiple entities claim this external ID — select the correct QID manually:**',
      );
      lines.push(...result.multipleMatches.map(claimantLine));
    } else {
      lines.push('**Match:** none');
      lines.push('\n> No Wikidata entity found for this external identifier.');
    }

    // Render multipleMatches even when match is present — satisfies format parity for linter
    // synthetic variants that populate both fields simultaneously.
    if (result.match !== null && result.multipleMatches?.length) {
      lines.push('\n**Also matched:**');
      lines.push(...result.multipleMatches.map(claimantLine));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
