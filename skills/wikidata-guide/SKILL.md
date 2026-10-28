---
name: wikidata-guide
description: Use wikidata_* tools to identify entities, verify qualified claims, join external identifiers, and build SPARQL graph queries. Use for Wikidata research that needs identity disambiguation, statement evidence, or completeness checks.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use Wikidata for structured relationships, identifiers, multilingual entity names, and links to Wikimedia articles. No API key is required. Use an article or source-document service when the task needs full text; a Wikidata statement or sitelink does not supply that text. Missing claims and links do not establish that a real-world fact or article is absent.

## Identifiers

- **Q-ID:** an item, obtained from `wikidata_search_entities`, `wikidata_resolve_external_id`, a returned statement value, or a SPARQL entity URI. Keep the Q-ID through joins; labels can be shared by unrelated items.
- **P-ID:** a property, discovered with property search in `wikidata_search_entities` or read from returned statements. Inspect an unfamiliar property's entity with `wikidata_get_entity` to check its meaning and datatype before using it.
- **External identifier:** the DOI, PMID, ORCID, or other identifier supplied by a source record. Pair it with that identifier scheme's P-ID for `wikidata_resolve_external_id`; a name or title is not an external identifier.
- **Statement ID:** returned with a claim by `wikidata_get_statements`; retain it with the evidence it identifies. It is not the entity's Q-ID or the property's P-ID.
- **Site code:** a key such as `enwiki` in returned sitelinks, identifying a Wikimedia project and language. Obtain article URLs with `wikidata_get_sitelinks`, rather than constructing URLs from entity labels.

## Gates

1. **Settle identity before joining facts.** Compare candidate descriptions and relevant statements with the known person, place, or work. Search rank and matching labels alone are insufficient. If candidates remain indistinguishable, report the ambiguity or ask for the missing discriminator.
2. **Separate resolver outcomes.** Inspect `multipleMatches` before interpreting a null match as a miss; fetch candidates to disambiguate them. An ordinary null means no indexed match, not proof of absence: the Query Service can lag the live wiki. Inspect known candidate entities directly when recent edits matter.
3. **Retrieve claims before citing them.** A `kind: "outline"` response contains an inventory, not the statements or entity fields. Follow `retrieval_notice`; do not turn section names or counts into evidence.
4. **Read statement context before making a factual conclusion.** Inspect rank, qualifiers, and references, keeping each reference's parts together. Preferred rank can express recency or consensus; it does not alone establish that a value is current. Check time qualifiers for time-sensitive claims, and state when Wikidata supplies no supporting reference.
5. **Preserve the value's meaning.** `somevalue` means an unknown value, `novalue` an explicit absence; neither means a missing property. Preserve time precision, quantity units and bounds, coordinate precision, and language tags when present. Do not convert a year-precision time into a known day, or an unresolved Q-ID into a guessed label.
6. **Check coverage before saying “all” or “none.”** Inspect search pagination, SPARQL counts and notices, and label lookup misses. SPARQL `truncated` signals an inferred upstream row cap; response-budget cuts are reported separately. A false flag, a LIMIT-bounded query, or a page of results does not prove completeness. Describe an empty query as no matching indexed rows under that query's conditions.

## Core chain

Resolve identity → discover relevant properties → retrieve targeted statements → interpret qualifiers and references → follow related Q-IDs or retrieve sitelinks. Use `wikidata_get_labels` for display-only batches; fetch full entities only when their additional fields are needed.

## Workflows

### Verify a named entity's fact

Search the name, then inspect plausible candidates with `wikidata_get_entity`. Find the predicate with property search if its P-ID is unknown. Use `wikidata_get_statements` for the chosen entity and relevant predicates. For an affiliation or office, examine date qualifiers before presenting it as current; for a quantity, keep the unit beside the value. Resolve remaining predicate labels with `wikidata_get_labels` when needed.

If the entity fetch outlines statements, switch to `wikidata_get_statements`. If that tool outlines properties, retrieve only those needed for the question, following its notice. A single property is returned whole and can still be large. For oversized sitelinks, use `wikidata_get_sitelinks`; narrow multilingual fields on the entity fetch instead of repeatedly requesting the same oversized category.

### Join an external record to Wikidata and Wikipedia

Start with the identifier in the source record and resolve it with `wikidata_resolve_external_id`. Check the echoed normalized value, especially for unfamiliar identifier schemes whose value is passed through without scheme-specific normalization. On ambiguity, compare candidate entities against the source record. On success, retrieve the needed statements or use `wikidata_get_sitelinks` for article URLs. No sitelink means no link was returned for that item and selection, not that Wikipedia has no relevant article.

### Query relationships or aggregate a set

Resolve the query's subjects, classes, and unfamiliar predicates before writing SPARQL. Use `wikidata_sparql_query` for joins, traversals, or aggregation that individual lookups cannot express. Choose direct claims only when qualifier and reference detail is unnecessary; use statement nodes otherwise. The [SPARQL patterns](references/sparql-patterns.md) cover this distinction.

Keep queries selective. On timeout, narrow graph patterns or simplify traversal rather than repeatedly increasing the wait. On throttling, follow the returned recovery guidance and reduce concurrent queries. For multiple pages, use stable ordering and retain the same query conditions; changing live data can still move rows between pages. Use aggregation when the user needs counts rather than individual records.

Read each SPARQL binding's type and value; a URI, language-tagged literal, and typed literal are different kinds of result. Extract Q-IDs only from Wikidata entity URIs, then use `wikidata_get_labels` for unresolved display names. Keep the IDs even when labels are available.

## References

- [SPARQL patterns](references/sparql-patterns.md): direct claims, statement nodes, class paths, counts, and pagination.
- [Wikidata ranking](https://www.wikidata.org/wiki/Help:Ranking): how rank differs from certainty and chronology.
- [Wikidata statements](https://www.wikidata.org/wiki/Help:Statements): values, unknown values, and explicit no-value claims.
