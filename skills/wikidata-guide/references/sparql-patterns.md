# SPARQL patterns

Use these patterns with `wikidata_sparql_query`. Resolve and verify the IDs appropriate to the task before substituting them. Examples use Douglas Adams (`Q42`), occupation (`P106`), human (`Q5`), spouse (`P26`), start/end time (`P580`/`P582`), instance of (`P31`), and subclass of (`P279`). Example results are bounded; they are not an inventory of Wikidata.

## Namespaces and direct claims

`wd:` names entities; `wdt:` reads direct, truthy claims. Truthy claims use the best non-deprecated rank for each subject/property: preferred statements when any exist, otherwise normal statements. They omit qualifiers and references. “Truthy” is a rank-selection rule, not a guarantee of factual truth.

```sparql
SELECT ?occupation ?occupationLabel WHERE {
  wd:Q42 wdt:P106 ?occupation .
}
ORDER BY ?occupation
LIMIT 20
```

The server injects standard prefixes and a label service when label, description, or alias variables request it. Names such as `?occupationLabel` correspond to `?occupation`. Other prefixes, such as `xsd:`, need explicit declarations when used.

## Statement nodes and qualifiers

`p:` reaches the statement node; `ps:` reads its main value; `pq:` reads a qualifier. Unlike `wdt:`, this route can include deprecated statements. Inspect or filter rank deliberately. Missing date qualifiers are left unbound here; they do not establish that the relationship continues today.

```sparql
SELECT ?statement ?spouse ?spouseLabel ?rank ?start ?end WHERE {
  wd:Q42 p:P26 ?statement .
  ?statement ps:P26 ?spouse ; wikibase:rank ?rank .
  OPTIONAL { ?statement pq:P580 ?start . }
  OPTIONAL { ?statement pq:P582 ?end . }
}
ORDER BY ?statement ?start ?end
LIMIT 20
```

For reference detail and normalized value precision, retrieve the entity's relevant property with `wikidata_get_statements`. Do not treat a plain time literal projected by SPARQL as evidence of day-level precision.

## Class membership

The path `/` composes predicates; `*` allows zero or more repetitions. `wdt:P31/wdt:P279*` finds instances of a class or its subclasses. Use this only when subclass inclusion matches the question; direct `wdt:P31` asks a narrower question. Broad paths can be expensive even with a small LIMIT.

```sparql
SELECT DISTINCT ?item ?itemLabel WHERE {
  VALUES ?item { wd:Q42 }
  ?item wdt:P31/wdt:P279* wd:Q5 .
}
ORDER BY ?item
LIMIT 20
```

Replace the seed VALUES with a selective task-specific relationship when expanding beyond known items.

## Counts and pages

Count distinct entities when joins can produce several rows per entity. This example counts occupation values, not people or all statement ranks:

```sparql
SELECT (COUNT(DISTINCT ?occupation) AS ?count) WHERE {
  wd:Q42 wdt:P106 ?occupation .
}
```

For row retrieval, add `ORDER BY` over keys that distinguish the projected rows, then `LIMIT` and `OFFSET`. Advance by the page requested only when that page was fully returned. If the response reports a budget cut, reduce the page size and re-run that page before advancing; otherwise an OFFSET jump can skip unseen rows. Separate requests do not share a snapshot of the changing graph.

```sparql
SELECT DISTINCT ?occupation WHERE {
  wd:Q42 wdt:P106 ?occupation .
}
ORDER BY ?occupation
LIMIT 20
OFFSET 0
```

The response's `totalCount` counts rows produced by that execution before the response-budget cut. It is not the count of every match beyond the query's LIMIT or an upstream cap. `returnedCount` reports what reached the caller. Check both the notice and `truncated` before using rows as a complete set.

## Official references

- [Wikidata SPARQL tutorial](https://www.wikidata.org/wiki/Wikidata:SPARQL_tutorial): property paths, qualifiers, and aggregates.
- [Wikibase RDF format](https://www.mediawiki.org/wiki/Wikibase/Indexing/RDF_Dump_Format): truthy and full statements, namespaces, and value representation.
- [Wikidata ranking](https://www.wikidata.org/wiki/Help:Ranking): selection by rank and its interpretation.
