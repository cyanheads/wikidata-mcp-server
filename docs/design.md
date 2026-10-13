# wikidata-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `wikidata_search_entities` | Search Wikidata for items or properties by text query. Returns QIDs/PIDs with labels, descriptions, and match metadata. | `query`, `type` (item/property), `language`, `limit` | `readOnlyHint: true` |
| `wikidata_get_entity` | Fetch a Wikidata entity (item or property) by QID or PID. `fields` narrows the fetch server-side via `?_fields=`, cutting a 300KB+ payload to kilobytes. An entity that still overflows returns a field-category outline. Routes to `/entities/items/{id}` for Q-IDs and `/entities/properties/{id}` for P-IDs. | `id`, `fields` (labels/descriptions/aliases/statements/sitelinks), `languages` | `readOnlyHint: true` |
| `wikidata_get_labels` | Resolve one or more QIDs/PIDs to their human-readable labels and descriptions in specified languages. Lightweight — no claim data. | `ids` (array), `languages` | `readOnlyHint: true` |
| `wikidata_get_statements` | Get specific property claims for an entity, with qualifier and reference detail. Resolves item QIDs and quantity units to labels inline. | `id`, `properties` (P-ID array), `language` | `readOnlyHint: true` |
| `wikidata_get_sitelinks` | Get Wikipedia and other Wikimedia project URLs for an entity, optionally filtered to specific wiki codes. | `id`, `sites` (optional filter array) | `readOnlyHint: true` |
| `wikidata_sparql_query` | Execute a SPARQL SELECT query against the Wikidata Query Service. Full graph query power for complex traversals, aggregations, and multi-hop joins. | `query` (SPARQL string), `language` (label language), `timeout` | `readOnlyHint: true` |
| `wikidata_resolve_external_id` | Look up a Wikidata entity by an external identifier — DOI, PubMed ID, ORCID, OpenAlex ID, etc. Returns the QID and core labels/description. | `property` (P-ID), `value` (external ID string), `language` | `readOnlyHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `wikidata://entity/{id}` | Wikidata entity by QID or PID — labels, descriptions, aliases, and key statements in the requested language. | No |

### Prompts

None — this is a data access server.

---

## Overview

wikidata-mcp-server exposes Wikidata — the world's largest free structured knowledge base (~100M items) — to LLM agents via the Wikidata REST API and SPARQL Query Service. It serves two complementary access patterns: point lookups via the REST API (fast, structured, predictable) and arbitrary graph queries via SPARQL (powerful, flexible, occasionally slow).

The primary users are agents doing entity disambiguation, fact verification, cross-server joins, and multilingual label resolution. The server is a connective layer between other research MCP servers (PubMed, OpenAlex, CrossRef, SEC EDGAR) and the structured knowledge graph they all implicitly reference — linking authors, institutions, compounds, papers, and companies to their stable Wikidata identifiers.

Read-only. No auth required.

---

## Requirements

- Entity search by text query, returning QIDs with labels and descriptions
- Entity fetch by QID/PID with configurable field selection (full entity payloads can exceed 300KB)
- Label/description resolution for batches of QIDs without claim data overhead
- Statement/claim access with qualifier and reference detail
- Sitelink lookup (Wikipedia URLs across languages)
- SPARQL query execution against the public endpoint
- External ID resolution (DOI → QID, PubMed ID → QID, ORCID → QID, etc.)
- Multilingual: all label-returning tools accept a `language` parameter
- No authentication required for any endpoint
- User-Agent header required on all requests (Wikimedia policy)

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `WikidataRestService` | Wikidata REST API (`wikidata.org/w/rest.php/wikibase/v1/`) | `wikidata_search_entities`, `wikidata_get_entity`, `wikidata_get_labels`, `wikidata_get_statements`, `wikidata_get_sitelinks`, `wikidata_resolve_external_id` |
| `WikidataSparqlService` | Wikidata Query Service (`query.wikidata.org/sparql`) | `wikidata_sparql_query`, `wikidata_resolve_external_id` |

Both services are stateless HTTP clients with retry and timeout handling. No shared mutable state between calls.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `WIKIDATA_USER_AGENT` | No (has default) | User-Agent string for Wikimedia requests. Default: `wikidata-mcp-server/0.1 (https://github.com/cyanheads/wikidata-mcp-server)`. Wikimedia policy requires a descriptive User-Agent. |
| `WIKIDATA_SPARQL_TIMEOUT_MS` | No | Max time to wait for a SPARQL response in milliseconds. Default: `55000` (55s, just under the 60s hard server limit). |
| `WIKIDATA_REST_TIMEOUT_MS` | No | Max time to wait for REST API responses in milliseconds. Default: `10000`. |

---

## Implementation Order

1. Config and server setup (`server-config.ts`, User-Agent handling)
2. `WikidataRestService` — base HTTP client, retry, entity fetch, search, labels, statements, sitelinks
3. `WikidataSparqlService` — SPARQL POST endpoint, timeout, error parsing (Java stack traces from Blazegraph)
4. `wikidata_search_entities` tool (uses search REST endpoint)
5. `wikidata_get_entity` tool (uses entity REST endpoint with field selection)
6. `wikidata_get_labels` tool (batch label fetch via `wbgetentities` MediaWiki API)
7. `wikidata_get_statements` tool (uses statements endpoint with property filter + label resolution)
8. `wikidata_get_sitelinks` tool (uses sitelinks endpoint)
9. `wikidata_resolve_external_id` tool (SPARQL lookup by property/value)
10. `wikidata_sparql_query` tool (pass-through with validation)
11. `wikidata://entity/{id}` resource

Each step is independently testable.

---

## Domain Mapping

### Nouns × Operations → Endpoints

| Noun | Operations | Primary Endpoint |
|:-----|:-----------|:-----------------|
| Item (Q-ID) | search, get, get-labels, get-statements, get-sitelinks | REST `/v1/search/items`, `/v1/entities/items/{id}` (`?_fields=` narrows the fetch server-side), `/v1/entities/items/{id}/statements`, `/v1/entities/items/{id}/sitelinks` |
| Property (P-ID) | search, get, get-labels, get-statements | REST `/v1/search/properties`, `/v1/entities/properties/{id}`, `/v1/entities/properties/{id}/statements`. **Must use the properties endpoint — the items endpoint returns HTTP 400 for P-IDs.** |
| Statement | get by property filter | REST `/v1/entities/items/{id}/statements?property={P-id}` |
| Sitelink | get, filter by site | REST `/v1/entities/items/{id}/sitelinks`, `/v1/entities/items/{id}/sitelinks/{site_id}` |
| Graph query | arbitrary SPARQL | SPARQL `https://query.wikidata.org/sparql` POST |
| External ID | resolve to QID | SPARQL (no REST batch-by-external-id endpoint exists) |

### Entity Data Model

- **Items** (Q-IDs): people, places, concepts, works — anything. 100M+ items.
- **Properties** (P-IDs): the predicates that connect items. ~12K properties. Each has a `data_type` (wikibase-item, external-id, time, quantity, string, url, …).
- **Statements**: `{ id, rank, value, qualifiers[], references[] }`. Value shape varies by `data_type`. A value can also be `somevalue` (unknown) or `novalue` (explicitly none), which carry no content.
- **Qualifiers**: additional context for a statement (e.g., a start date on a "position held" claim).
- **References**: provenance for a statement (e.g., the source database that first recorded it). Each reference is an ordered group of property/value parts (`{ hash, parts[] }` upstream); a statement can carry several.
- **Sitelinks**: connections to Wikipedia articles and other Wikimedia projects across languages. An item can have 300+ sitelinks.
- **Labels / Descriptions / Aliases**: multilingual display strings. Barack Obama has 113 labels and 242 descriptions.

### External ID Property Map (Key Cross-Server Joins)

`data_type: external-id` — the only properties `wikidata_resolve_external_id` accepts:

| P-ID | Property Name | External System |
|:-----|:-------------|:----------------|
| P356 | DOI | CrossRef, academic papers |
| P698 | PubMed publication ID | PubMed |
| P496 | ORCID iD | Author identifiers |
| P10283 | OpenAlex ID | OpenAlex (works, authors, institutions) |
| P213 | ISNI | International Standard Name Identifier |
| P244 | Library of Congress authority ID | Libraries, archives |
| P345 | IMDb ID | Film/TV |

Adjacent properties with real cross-server value that are **not** external IDs. Reachable via `wikidata_get_statements` or SPARQL; `wikidata_resolve_external_id` rejects them with `not_external_id_property`:

| P-ID | Property Name | Data Type | Cross-server use |
|:-----|:-------------|:----------|:-----------------|
| P2860 | cites work | `wikibase-item` | Citation-graph traversal — values are QIDs, not identifier strings |
| P1932 | stated as (reference) | `string` | CrossRef title matching against a reference's as-printed name |
| P18 | image | `commonsMedia` | Commons media filename |

---

## Workflow Analysis

### `wikidata_get_entity` (1 upstream call)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /v1/entities/items/{id}[?_fields=…]` or `GET /v1/entities/properties/{id}[?_fields=…]` | Entity data, narrowed server-side to the requested fields. `_fields` is omitted entirely when the caller wants everything. |
| — | Client-side field + language filtering | Shapes the response: language narrowing, which the endpoint cannot do, plus a field filter that keeps the returned shape identical whether or not the fetch was narrowed. |
| — | Overflow check | Over the byte budget, the field categories are returned as an outline instead of the data. |

Statements come back raw and unlabelled — no label calls are made here; label resolution lives in `wikidata_get_statements`.

### `wikidata_get_labels` (1 upstream call)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /w/api.php?action=wbgetentities&ids=Q1\|Q2\|…&props=labels\|descriptions&languages=en` | Batch fetch labels for up to 50 QIDs in one request |

Uses MediaWiki API (`wbgetentities`) rather than the REST API because the REST API has no batch label endpoint — individual `/labels/{lang}` calls would be N+1.

### `wikidata_get_statements` (2 upstream steps, sequential)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /v1/entities/items/{id}/statements?property={pid}` (Q-IDs) or `GET /v1/entities/properties/{id}/statements` (P-IDs) | Fetch raw statement data — route by ID prefix |
| 2 | `wbgetentities` batches of 50, at most 4 in flight | Resolve item QIDs and quantity units — main values, qualifiers, reference parts — to human-readable labels |

Step 2 needs the QIDs step 1 returns, and runs only when the unlabelled statement set fits the byte budget — an over-budget set is outlined without it.

### `wikidata_resolve_external_id` (1 REST call + 1 SPARQL call, sequential)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /v1/entities/properties/{id}?_fields=data_type` | Confirm the property's data type is `external-id` before spending a SPARQL call. `?_fields=data_type` answers in ~40 bytes. |
| 2 | `POST /sparql` with `SELECT ?item WHERE { ?item wdt:{P} "{value}" }` | Map external ID to QID |

Sequential, not parallel — step 1 is a gate, and a non-`external-id` property makes step 2 pointless (the SPARQL is valid but can never match).

Uses SPARQL because the REST API has no "get entity by external ID value" endpoint.

### `wikidata_sparql_query` (1 SPARQL call, pass-through)

Raw SPARQL forwarded to the endpoint; the response is held to a 64,000-byte budget per surface (see the tool design). Hard 60s server timeout; the client timeout defaults to 30s and is capped at 55s so the error is from our side. Error responses are Java stack traces from Blazegraph — the service layer must parse/strip these down to the meaningful error line.

---

## Tool Designs

### `wikidata_search_entities`

**Purpose:** Text search returning a ranked list of matching items or properties with QIDs/PIDs, labels, descriptions, and match type (label vs. alias match).

**Input schema:**
- `query: string` — search terms
- `type: enum('item', 'property')` — default `'item'`
- `language: string` — Wikidata language code for labels/descriptions, default `'en'`. Shared language-code schema.
- `limit: number` — 1–50, default `10`
- `offset: number` — optional pagination offset

**Output:** `{ results: Array<{ id, label, description, match }> }` where `match` conveys whether it was a label or alias match and in which language. The API returns no total count — pagination is offset-only with no result ceiling indicator.

**Enrichment:** `effectiveQuery`, `searchType`, `language`, `resultCount` (always); `notice` (empty-result guidance when `results` is empty).

**Errors:**
- `invalid_search_parameter` (`ValidationError`): the search endpoint answered 400 — in practice a language it does not search in, such as `mul`. The message names the refused parameter and the value sent (from the endpoint's `context.parameter`), never the upstream URL; the recovery hint suggests a supported code such as `en`. Other upstream statuses keep their default classification.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

**Implementation note:** Uses REST `/v1/search/items` and `/v1/search/properties`. The `display-label` field in the response is a nested object `{ language, value }` — extract `.value` for the output `label` field. The `description` field is similarly nested `{ language, value }`. The response has no `total` field.

---

### `wikidata_get_entity`

**Purpose:** Fetch a Wikidata entity by QID or PID with configurable field selection. `fields` narrows the fetch itself, via the REST API's `?_fields=` parameter, and the client-side filter then shapes what is returned. Full entity data for a major item (Q76 Barack Obama) is 344,114 bytes with 410 properties and 340 sitelinks; `?_fields=labels` answers the same item in 6,703 bytes.

**Routing:** Q-IDs → `GET /v1/entities/items/{id}`. P-IDs → `GET /v1/entities/properties/{id}`. The items endpoint returns HTTP 400 for P-IDs; routing must be done by ID prefix before the request.

**Input schema:**
- `id: string` — Q-ID (e.g., `"Q76"`) or P-ID (e.g., `"P31"`). Case-insensitive, normalized to uppercase.
- `fields: array<enum('labels','descriptions','aliases','statements','sitelinks')>` — optional; omit for all fields. Forwarded to `?_fields=`, so it narrows the fetch as well as the response.
- `languages: array<string>` — optional language filter for labels/descriptions/aliases; omit, or send `[]`, for all languages. Client-side: the entity endpoint has no language parameter. Shared language-code schema; blank entries are dropped.

**Output:** Entity data with only the requested fields, never truncated. The `statements` field preserves full qualifier and reference structure. P-IDs include a `data_type` field; `sitelinks` is absent on property entities.

Over the byte budget the response switches to `kind: "outline"` — the field categories with their sizes, largest first — and `retrieval_notice` names how to fetch each one. Sections are field categories rather than top-level result keys, since an outline naming `id` or `fieldsReturned` would advertise a re-call `fields` rejects.

The governing rule is that **following the notice literally must make progress** — what it says to do next has to return something better than what the caller just read, never the identical outline. Two ways to break that, both closed:

1. *Pointing at a category `fields` cannot deliver.* One over budget on its own returns the same overflow, so it is redirected to a lever with finer granularity: `statements` → `wikidata_get_statements` (`properties`, by P-ID), `sitelinks` → `wikidata_get_sitelinks` (`sites`, by site code), the language-keyed maps → this tool's own `languages`. On Q30 that redirects `statements` (793,825 bytes) and `sitelinks` (59,631).
2. *Naming a set that only fits piecewise.* Sizes are additive, so enumerating every category that fits individually can name a re-call that cannot succeed — Q30's `labels` + `descriptions` + `aliases` are 10,431 + 6,848 + 12,447 = 29,726 against 24,000. That notice returns the same outline, which returns the same notice: a closed loop, reachable straight from the default `get_entity(Q30)` path. So the notice packs a subset measured to fit and defers the remainder to a further call.

Both checks go through `sizeOf`, the same serialization and UTF-8 byte count the handler uses to decide overflow, so a suggested re-call is validated against the exact predicate that will judge it — the named set provably returns `kind: "full"` in one step, and the first candidate always fits because a category that cannot be delivered alone was already routed elsewhere. The set is emitted as a literal array (`fields:["aliases","labels"]`) rather than a constraint to satisfy ("keep the total under 24000 bytes"), because the caller most likely to loop here is the one least likely to do the arithmetic.

**Errors:**
- `entity_not_found` (`NotFound`): no entity exists at this ID. REST answers an unassigned but well-formed ID (`Q99999999`) with HTTP 404 `resource-not-found`, and a syntactically valid but out-of-range ID (`Q999999999999`) with HTTP 400 `invalid-path-parameter` — both mean "no such entity" to a caller and map to this reason.
- `invalid_id` (`ValidationError`): ID format unrecognized (must be Q+digits or P+digits)

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `wikidata_get_labels`

**Purpose:** Resolve a batch of QIDs/PIDs to their human-readable labels and descriptions. Cheap and fast — returns no claim data. Designed for the common agent pattern of having a set of QIDs (e.g., from a SPARQL query) and needing to display them.

**Input schema:**
- `ids: array<string>` — 1–50 Q-IDs or P-IDs
- `languages: array<string>` — Wikidata language codes; default `['en']`, which `[]` also gets. Shared language-code schema; blank entries are dropped.

**Output:** `{ entities: Record<id, { labels: Record<lang, string>, descriptions: Record<lang, string> }> }` — only requested languages included.

**Errors:**
- `invalid_ids` (`ValidationError`): array contains non-Q/P-ID values

An ID that is well-formed but does not resolve is not an error — it is absent from `entities` and listed in `notFound`, so a partial batch still returns its valid members.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true` (every call reads live data from `wbgetentities`)

**Implementation note:** Uses `wbgetentities` MediaWiki API with `props=labels|descriptions` and `languages` parameter. Supports up to 50 IDs per request; `fetchLabels` chunks inputs into batches of 50 and runs at most 4 at once, for every caller — Wikimedia's API etiquette discourages parallel fan-out, and 4 still clears the largest label set an in-budget `wikidata_get_statements` payload carries in two round trips.

A non-resolving ID has two distinct shapes, and they must not be conflated:
- **Unassigned but in range** (`Q99999999`): arrives inside a normal `entities` map as a per-item `{"id": "Q99999999", "missing": ""}` marker, alongside the valid members. Skip the marked entry.
- **Out of range** (`Q999999999999`): rejects the *whole batch* with a top-level `error` key (`code: "no-such-entity"`) and no `entities` map at all, naming only the **first** offending ID in `error.id`. Drop the named ID and re-request the remainder, so valid members still resolve; repeat until the batch clears (each pass removes exactly one ID, so it terminates). Any other top-level `error` code is a real failure and is thrown rather than reported as "nothing found".

Both arrive as HTTP 200 — the error rides in the body, not the status.

`languagefallback=1` is set on every request so a requested language with no label of its own resolves to the entity's `mul` (multilingual) value. Fallback values stay keyed by the requested language, carrying `language`/`for-language` metadata alongside `value`.

---

### `wikidata_get_statements`

**Purpose:** Get specific property claims for an entity with full qualifier and reference detail, with item QIDs and quantity units resolved to human-readable labels inline. Designed for fact verification — "what does Wikidata say about this entity's {property}?".

**Input schema:**
- `id: string` — Q-ID of the item or P-ID of a property. Routes to `/v1/entities/items/{id}/statements` for Q-IDs and `/v1/entities/properties/{id}/statements` for P-IDs.
- `properties: array<string>` — P-IDs to fetch (e.g., `["P31", "P569", "P27"]`); omit for all properties. Unfiltered, a well-connected item overflows — see below.
- `language: string` — language for label resolution, default `'en'`. Shared language-code schema.
- `resolve_labels: boolean` — resolve item QIDs and quantity unit QIDs to labels at every level, default `true`

**Output:** Map of property ID → array of statements. Each statement includes `id`, `rank`, `value`, `qualifiers` (`[{ property, value }]`), and `references` — one entry per upstream reference in upstream order, each `{ parts: [{ property, value }] }` (the upstream `hash` is not carried). With `resolve_labels: true`, item values and quantity units at every level — main value, qualifiers, reference parts — go into one deduplicated `wbgetentities` batch: an item value gains `label`, a quantity gains `unitLabel` beside its unchanged `unit`. A QID absent from the batch response stays bare; with `resolve_labels: false` no label call is made. Qualifier and reference property P-IDs are not labelled.

Over the byte budget the response switches to `kind: "outline"` — every available P-ID with its serialized size, largest first — and the caller re-calls with `properties:[…]`. Unfiltered, Q30 carries 467 properties across 1,717 statements and serializes to 519,077 characters, past what a client can accept at all; the outline of the same call is ~14KB. Sections are the statement map's own keys, so they are already P-IDs — the vocabulary `properties` takes — and the outline needs no new input parameter. The budget decision is made once, after normalization and before label resolution, and labels never reverse it: a set over budget is outlined at its unlabelled sizes without a `wbgetentities` request (an unfiltered Q30 would otherwise send ~1,150 QIDs in 23 batches only to discard them), and a set that fits is returned with its labels even when they carry it past 24,000 bytes (+8–12% on the largest fitting selections of Q30, Q42, and Q183). Measuring again after labelling made the outline a loop — a selection sized to fit from the outline came back over budget once labelled, as the same outline. Each section is sized as the UTF-8 bytes it adds to a response (`{"P31":[…]}`, key and punctuation included), so sizes are additive upper bounds and any selection summing to the budget or less returns statements. The `retrieval_notice` names one such set as a literal `properties:[…]` array, packed largest-first — never the largest sections, which on a major item each overflow alone. An entity whose statements sit under a single P-ID is returned whole even when oversized: below two sections there is nothing to choose between, and the only re-call an outline could offer would return the same bytes. `labelsResolved` reports what happened rather than echoing `resolve_labels`: it is false on an outline, which fetches no labels. Sub-section outlining (splitting one property's statement list) is out of scope.

Statement value normalization by data type:
- `wikibase-item` values: `{ qid, label }` (label resolved if `resolve_labels: true`)
- `wikibase-property`, `wikibase-lexeme`, `wikibase-form`, `wikibase-sense`, `entity-schema` values: `{ type: "entity-id", entityType, id }` — `entityType` is `property` / `lexeme` / `form` / `sense` / `entity-schema`, `id` the bare upstream ID (`P279`, `L37633`, `L229416-F1`, `L1452908-S1`, `E10`). Rendered as the bare ID and never labelled — only item values and quantity units enter the label batch
- `time` values: `{ time, precision }` — ISO string + precision level (e.g., 11 = day)
- `quantity` values: `{ amount, unit, upperBound?, lowerBound?, unitLabel? }` — `unit` stays as upstream sends it (an entity URI, or `"1"` when unitless); the bounds are the upstream uncertainty range, verbatim, present only when upstream sends them; `unitLabel` is added when the unit QID resolves. `content[]` renders `+105.4 square kilometre (Q712226)`, or `+105.4 (Q712226)` unresolved, or the bare amount when unitless; a bounded quantity puts its range beside the amount: `+6378.137 [+6378.136, +6378.138] kilometre (Q828224)`
- `external-id`, `url` values: raw string; `string`, `commonsMedia`, `geo-shape`, `tabular-data`, `math`, `musical-notation` values: raw string under `type: "string"`
- `monolingualtext` values: `{ text, language }`
- `globe-coordinate` values: `{ latitude, longitude, precision? }`
- A data type the server does not know, or a value whose content does not match its data type: `{ type: "other", raw }`, rendered as JSON
- `somevalue` / `novalue` snaks, at any level and for any data type: `{ type: "somevalue" }` / `{ type: "novalue" }`, rendered "unknown value" / "no value" — never an empty value or an empty QID, and never sent for label lookup

**Errors:**
- `entity_not_found` (`NotFound`): no item at this QID — HTTP 404 (unassigned) or HTTP 400 (out of range), same as `wikidata_get_entity`
- `invalid_id` (`ValidationError`): ID is not a valid Q-ID or P-ID format
- `invalid_property` (`ValidationError`): a `properties` entry is not P+digits format. Validated before the fetch, naming every offending entry — a malformed entry is the only thing the REST `?property=` filter answers with HTTP 400, so rejecting it here keeps that status unambiguous for `entity_not_found`.

A well-formed but unassigned P-ID (`P9999999`) is not an error — it returns an empty result, the honest answer to "this entity has no such statements".

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true`

---

### `wikidata_get_sitelinks`

**Purpose:** Get Wikipedia and Wikimedia project article URLs for an entity. A sitelink maps a site code (e.g., `enwiki`) to a Wikipedia article title and URL. Used to find the Wikipedia page for an entity, or all Wikimedia pages across languages.

**Input schema:**
- `id: string` — Q-ID
- `sites: array<string>` — optional filter to specific site codes (e.g., `["enwiki", "frwiki", "dewiki"]`); omit for all sitelinks
- `wikis_only: boolean` — filter to Wikipedia sitelinks only (site codes ending in `wiki`), default `false`

**Output:** `{ sitelinks: Record<siteCode, { title, url, badges }> }` — site code → article metadata.

**Errors:**
- `entity_not_found` (`NotFound`): no item at this QID — HTTP 404 (unassigned) or HTTP 400 (out of range); the sitelinks endpoint returns the same status pair as the items endpoint
- `not_an_item` (`ValidationError`): a P-ID was supplied — only items (Q-IDs) have sitelinks

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true`

---

### `wikidata_sparql_query`

**Purpose:** Execute an arbitrary SPARQL query against the Wikidata Query Service. Full graph traversal — multi-hop joins, aggregations, subqueries, federated queries. Use for anything beyond single-entity lookups: "all Nobel Prize winners in Chemistry since 2000", "co-authors of an author", "all cities in a country with population > 1M".

The tool handles Wikidata's auto-label SERVICE boilerplate automatically when the query references a `?…Label`, `?…Description`, or `?…AltLabel` variable (`$` sigil too) — the caller doesn't need to include `SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }` manually. A query with no such variable, or one that declares its own label SERVICE, is sent without injection.

**Input schema:**
- `query: string` — SPARQL SELECT query. Any other form is rejected before the upstream call (`not_select_query`). The `wikibase:` prefixes are auto-populated.
- `language: string` — language for the injected `wikibase:label` SERVICE, default `'en'`: one code, or a comma-separated fallback list tried in order (`fr, en` is sent as `fr,en`). The injected list ends in `mul` unless it already names it, since the SERVICE does not fall back to multilingual labels on its own. Shared language-code schema.
- `timeout: number` — client-side timeout in seconds, 1–55, default `30`. Capped at 55 (server hard limit is 60s).

**Output:** `{ results: Array<Record<string, { type, value, "xml:lang"?, datatype? }>>, variables: string[], truncated: boolean }` — raw SPARQL bindings with type annotations. Language-tagged literals use the key `"xml:lang"` (not `"lang"`) — this is the SPARQL 1.1 JSON format. `truncated` is inferred, since the endpoint exposes no truncation flag: `true` when the row count reaches the 10,000-row server cap, `false` otherwise.

**Enrichment:** `totalCount` (rows the query produced) and `returnedCount` (rows in `results`), written on every call; `notice` when the result was cut to the response budget or matched nothing.

**Response budget:** each surface — serialized `structuredContent` and the `content[]` text — is held to 64,000 bytes, cut between whole rows. Each row is charged the larger of its serialized binding and its rendered table row, against what is left once the envelope (variables, header, counts, the longest notice) is paid for, so both surfaces carry the same leading rows. A cut result's `notice` names the re-call: page with `ORDER BY` plus `LIMIT`/`OFFSET`, or aggregate in the query; a first row that alone overflows returns no rows and says to project fewer or shorter values. A result that fits is returned whole.

**`content[]` cells** are Turtle-style: a URI as a prefixed name (`wd:`, `wdt:`, `p:`, `ps:`, `pq:`) or `<…>`, a literal quoted with its `@lang` or `^^datatype` (`"1952-03-11T00:00:00Z"^^xsd:dateTime`), a blank node as `_:id`. `|`, CR, and LF are escaped so a value cannot split a cell or add a row; `structuredContent` keeps every value verbatim.

**Errors:**
- `not_select_query` (`ValidationError`): the query is not a SELECT — ASK, CONSTRUCT, DESCRIBE, an update form, a comment-only query, or plain text. A handler pre-flight skips whitespace, a BOM, `#` comments, and `BASE`/`PREFIX` declarations (IRIs consumed whole), then requires `SELECT` case-insensitively; no upstream request is made. The recovery hint routes keyword lookups to `wikidata_search_entities`. A prologue the check cannot read (a `PREFIX` missing its colon or IRI) goes upstream as a syntax error.
- `parse_error` (`ValidationError`): SPARQL syntax error — the cause line stripped from the Blazegraph stack trace, with its `line N, column M` mapped back to the caller's query (the injected prefix lines and label SERVICE are subtracted out), in both the message and `data.cause`
- `timeout` (`Timeout`, retryable): query exceeded the time limit — simplify or add LIMIT
- `throttled` (`RateLimited`, retryable): rate limited (60 req/min, 5 concurrent per IP) — retry after `Retry-After` header value

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

**Implementation note:** POST queries bypass the CDN cache, which is correct for dynamic agent queries. GET queries are cached up to 5 minutes but hit URL length limits for complex queries. Use POST.

---

### `wikidata_resolve_external_id`

**Purpose:** Look up a Wikidata entity by an external identifier — a DOI, PubMed ID, ORCID iD, OpenAlex ID, etc. The primary use case is cross-server joins: "I have a DOI from CrossRef — what's the Wikidata QID for this paper?" Returns the QID, label, description, and any additional matching metadata.

**Input schema:**
- `property: string` — P-ID of the external ID property (e.g., `"P356"` for DOI, `"P698"` for PubMed ID, `"P496"` for ORCID, `"P10283"` for OpenAlex ID)
- `value: string` — the external ID value (e.g., `"10.1038/nature01234"`)
- `language: string` — language for label/description, default `'en'`. Shared language-code schema. A match with no label in that language returns its `mul` label.

**Output:** `{ id, label, description, url }` — QID, display name, description, and Wikidata entity page URL. `null` when no match found (not an error — clean absence signal). A null match is not proof of absence: the Query Service lags the live wiki, so it can also mean "not yet indexed". The `match` field's description says so, since that ambiguity decides whether a caller retries.

**Errors:**
- `invalid_property` (`ValidationError`): `property` is not in P+digits format. A pure format check, run before any upstream call.
- `not_external_id_property` (`ValidationError`): the P-ID does not exist on Wikidata, or it exists but its `data_type` is not `external-id` (e.g. `P31`, an item-valued property). One reason covers both — the caller's fix is the same either way, supply a different property.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

**Implementation note:** Uses SPARQL `SELECT ?item WHERE { ?item wdt:{P} "{value}" . }` — the only viable approach since the REST API has no "find by external ID" endpoint. One `GET /v1/entities/properties/{id}?_fields=data_type` precedes it to enforce the `external-id` datatype; `?_fields=` trims that check to ~40 bytes against a 27–282KB full property payload.

**Value normalization:** Wikidata stores some external IDs in a canonical form that differs from user input. The value is trimmed, then a resolver-prefix strip runs on it, feeding the bare identifier into the per-property cases:
- **Surrounding whitespace:** trimmed for every property. Only P698 and P496 discard it incidentally (via the PMID chain's `.trim()` and ORCID's `[-\s]` strip), so without a trim ahead of the switch a padded DOI or IMDb ID reaches the SPARQL literal intact and answers a confident `match: null` for an identifier that resolves. The trim precedes the strip because the resolver patterns are `^`-anchored — a padded URL would not match, and the prefix would survive into the query.
- **Resolver prefixes:** `https?://(dx.)?doi.org/` and a bare `doi:` scheme for P356; `https?://pubmed.ncbi.nlm.nih.gov/` for P698; `https?://orcid.org/` for P496 — the latter two also absorb a trailing slash, while P356 does not (a DOI suffix can legitimately end in one). DOIs and PMIDs are routinely copy-pasted or API-returned in resolver-URL form. Ordering is load-bearing: ORCID's reformat is gated on a length-16 check that URL text always defeats, so stripping after the per-property step would leave a URL-prefixed *unhyphenated* ORCID silently unformatted.
- **DOI (P356):** Stored uppercase (e.g., `10.1038/NATURE01234`). The handler must uppercase DOI values before querying — a lowercase input returns zero results.
- **PubMed ID (P698):** Stored as plain integer string — strip any `PMID:` prefix before querying.
- **ORCID (P496):** Stored with hyphens in the `0000-0000-0000-000X` format — normalize if user provides without hyphens.
Other P-IDs: use the value as-is unless Wikidata data shows otherwise.

---

## Resources

### `wikidata://entity/{id}`

**URI:** `wikidata://entity/{id}` where `{id}` is a Q-ID (e.g., `Q76`) or P-ID.

**Content:** Entity labels (all languages), English description, and a summary of the most common properties — instance-of (P31), image (P18), and any Wikipedia URL (enwiki sitelink). Formatted as a compact markdown summary suitable for injection as context.

**Why a resource here:** Entity pages are stable, addressable by URI, and useful as injectable context before asking for detailed statements. A resource path lets clients that support it inject `wikidata://entity/Q76` directly into context rather than calling a tool.

**Tool coverage:** All data in this resource is reachable via `wikidata_get_entity` — tool-only clients are not disadvantaged.

---

## API Reference

### REST API

Base: `https://www.wikidata.org/w/rest.php/wikibase/v1/`

Key endpoints used:

| Endpoint | Method | Purpose |
|:---------|:-------|:--------|
| `/search/items?q=…&language=…&limit=…` | GET | Entity text search |
| `/search/properties?q=…&language=…&limit=…` | GET | Property text search |
| `/entities/items/{id}` | GET | Item data. `?_fields=` narrows it server-side (`type`, `labels`, `descriptions`, `aliases`, `statements`, `sitelinks`); `id` is always returned and is rejected as a selector. Note `?fields=` — no underscore — is silently ignored. |
| `/entities/items/{id}/labels` | GET | All labels |
| `/entities/items/{id}/descriptions/{lang}` | GET | Single-language description |
| `/entities/items/{id}/statements?property={pid}` | GET | Filtered statements |
| `/entities/items/{id}/sitelinks` | GET | All sitelinks |
| `/entities/items/{id}/sitelinks/{site}` | GET | Single sitelink |
| `/entities/properties/{id}` | GET | Property metadata |

REST v1.5 search results use `display-label` (not `label`) as the display name field. The `id` field is the QID/PID.

### MediaWiki API (for batch label resolution)

`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q1|Q2&props=labels|descriptions&languages=en&format=json`

Supports up to 50 IDs per call. Used for `wikidata_get_labels` since the REST API has no batch label endpoint.

### SPARQL Endpoint

- Endpoint: `https://query.wikidata.org/sparql`
- Method: POST (preferred — avoids URL length limits, bypasses 5-minute CDN cache)
- Accept: `application/sparql-results+json`
- Hard timeout: **60 seconds** per query
- Rate limits: 60 request-seconds per 60-second window per (User-Agent + IP), 5 parallel queries per IP, 30 errors per minute
- Throttle response: HTTP 429 with `Retry-After` header
- Error format: Java stack traces from Blazegraph — parse the first meaningful line after `MalformedQueryException`

### Common SPARQL Prefixes (auto-populated by the service layer)

```sparql
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX p: <http://www.wikidata.org/prop/>
PREFIX ps: <http://www.wikidata.org/prop/statement/>
PREFIX pq: <http://www.wikidata.org/prop/qualifier/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX bd: <http://www.bigdata.com/rdf#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX schema: <http://schema.org/>
```

### User-Agent Policy

Wikimedia blocks requests without a valid User-Agent. Required format per policy: `{tool-name}/{version} (contact: {email or URL})`. The default config value satisfies this. Agents using this server do not need to supply their own User-Agent.

---

## Known Limitations

- **SPARQL 60s timeout is hard.** Complex queries touching millions of triples regularly time out. The server can't extend this — it's enforced by Wikimedia infrastructure. Agents must write LIMIT-bounded queries.
- **No batch entity fetch via REST.** The REST API has no multi-ID endpoint. Batch label resolution uses the MediaWiki API (`wbgetentities`), not REST. Fetching N full entities requires N REST calls — the server uses parallel fetching where possible.
- **`_fields` is spelled with an underscore, and the accepted set differs per endpoint.** `?fields=` is silently ignored; only `?_fields=` narrows. The items endpoint takes `type`/`labels`/`descriptions`/`aliases`/`statements`/`sitelinks`, the properties endpoint takes `type`/`data_type`/`labels`/`descriptions`/`aliases`/`statements` — `sitelinks` and `data_type` are each valid on exactly one of them, `id` on neither. An unaccepted value answers HTTP 400 `invalid-query-parameter`, which is the same status an out-of-range ID draws and which `isEntityNotFoundError()` reads as "no such entity". `fetchEntity()` therefore intersects the caller's fields against the endpoint's set instead of forwarding them, or a property asked for `sitelinks` would be reported as missing.
- **No language selection on entity fetch.** The entity endpoint returns exactly the language keys an entity carries, with no `languages` or `languagefallback` parameter, so language narrowing and `mul` fallback stay client-side. (The MediaWiki batch path used by `wikidata_get_labels` does have `languagefallback=1`.)
- **Statement value payloads vary by data type.** `wikibase-item`, `wikibase-property`, `wikibase-lexeme`, `wikibase-form`, `wikibase-sense`, `entity-schema`, `time`, `quantity`, `string`, `external-id`, `url`, `commonsMedia`, `monolingualtext`, `globe-coordinate`, `math`, `musical-notation`, `tabular-data`, `geo-shape` — 18 data types each with different value shapes. The server normalizes to a consistent structure per type, but callers should expect `type` to vary.
- **External ID case sensitivity.** Wikidata stores DOIs uppercase and other external IDs in canonical forms. The `wikidata_resolve_external_id` handler normalizes known cases (whitespace trimming, resolver-URL prefix stripping, DOI uppercasing, PMID prefix stripping, ORCID hyphen normalization), but unlisted properties use the value as-is.
- **Wikidata data quality is uneven.** Popular entities (Barack Obama, Albert Einstein) are well-maintained. Long-tail items may have sparse labels, missing descriptions, or zero sitelinks. The server faithfully reports what's there — it does not synthesize missing data.
- **SPARQL endpoint is Blazegraph (planned migration).** Wikimedia has announced intent to migrate away from Blazegraph to a different triplestore. The endpoint URL and SPARQL semantics should be stable, but some Blazegraph-specific extensions (graph traversal algorithms, `bd:sample`) may be discontinued.
- **5 concurrent SPARQL queries per IP.** A server hosting multiple agent sessions from the same IP can hit this limit. The server does not implement cross-session SPARQL rate tracking — operators running in multi-tenant environments should be aware.

---

## Decisions Log

### 2026-05-23

**REST API vs. MediaWiki API for entity fetch**
Chose the Wikidata REST API (`/w/rest.php/wikibase/v1/`) as the primary client for entity lookups and search. The REST API is versioned (v1.5), has a clean OpenAPI spec, and returns structured JSON without the additional `entities` envelope wrapping the MediaWiki API uses. Exception: batch label resolution uses `wbgetentities` because the REST API has no multi-ID label endpoint — individual REST label calls would be N+1.

**Field selection via `fields` parameter on `wikidata_get_entity`**
A full entity payload for a major item (Barack Obama Q76) is 344,114 bytes with 410 properties, 113 labels, 242 descriptions, and 340 sitelinks. `fields` is forwarded to the REST API's `?_fields=` parameter, so it narrows the fetch and not just the response: the same item is 6,703 bytes with `?_fields=labels`, and Q42 is 16,986 with `?_fields=labels,descriptions`.

This tool originally filtered client-side only, on the finding that the API ignored a field parameter. That finding was real but keyed on the wrong spelling — `?fields=` is accepted and silently ignored, `?_fields=` is honoured. The underscore is the whole difference, and `fetchPropertyDataType()` had been relying on the working spelling against the properties endpoint the entire time.

The client-side filter stays. It does work `_fields` cannot — language narrowing, `mul` fallback, sitelink reshaping — and it keeps the returned shape identical whether or not the fetch was narrowed, which is what lets the forwarding be a pure bandwidth win rather than a contract change. Two constraints make forwarding non-blind: the endpoint drops `type` unless asked for, and its accepted set is endpoint-specific, so `fetchEntity()` always appends `type` (plus `data_type` for properties) and intersects the rest against the endpoint's set.

**`wikidata_get_labels` as a dedicated tool**
Label resolution is a separate concern from entity data. Agents running SPARQL queries routinely get back sets of QIDs and need to humanize them. A dedicated `wikidata_get_labels` batches up to 50 QIDs in one MediaWiki API call rather than N REST calls. This pattern — "get QIDs from SPARQL, then resolve labels" — is the most common two-step workflow in practice.

**`wikidata_resolve_external_id` uses SPARQL, not REST**
The REST API has no "find entity by external ID value" endpoint — you can't do `GET /entities/items?P356=10.1038/...`. The SPARQL `SELECT ?item WHERE { ?item wdt:P356 "..." }` pattern is the correct approach. Wrapping it as a named tool with a `property`/`value` interface hides this complexity from callers who don't know SPARQL.

**`wikidata_sparql_query` injects label SERVICE automatically**
The `SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }` block is required in virtually every practical SPARQL query that uses `?itemLabel` variables. Making agents write this boilerplate for every query is friction with no upside. The service layer injects it when the query references a label, description, or alias variable and doesn't already include a label SERVICE. There is no off switch: a query that wants no labels names no label variable.

The injection point is the closing brace of the top-level WHERE group: the first `{` outside a parenthesized projection expression, matched by depth, with braces inside string literals, IRIs, and `#` comments ignored. The SERVICE is spliced inline just before that brace, with no line break, and the text around it is left as written. Matching by depth rather than by what follows a `}` is load-bearing: a sub-SELECT carrying its own `LIMIT` or `GROUP BY` ends in a brace followed by a solution modifier, and injecting there binds labels inside a subquery whose projection drops them; a trailing `VALUES ?t { wd:Q5 }` ends the query with its own brace, and injecting there puts a graph pattern inside a data block that accepts only constant terms. A query whose WHERE group never closes is sent without injection, for the upstream parser to locate. Coverage lives in `tests/services/wikidata-sparql-service.test.ts`, which asserts the prepared text sent upstream.

The injected SERVICE is wrapped in `OPTIONAL { … }`. A plain SERVICE joins on any label variable the caller binds itself (`?item rdfs:label ?itemLabel`), and when the planner runs it first — as it does for a single-valued `VALUES` — it drops every row whose label differs from the one the SERVICE picks. The left join keeps the caller's rows and still binds an unbound label variable; verified live on WDQS, with no measurable cost on a 5,000-row query.

**Overflow returns an outline, not a truncated payload**
`wikidata_get_statements` and `wikidata_get_entity` can both produce a response too large for a client to accept — 519,077 and 793,897 characters respectively for Q30, hard failures rather than degraded results. Both return an outline rather than a per-tool cap. A cap has to answer which statements survive truncation, and there is no honest answer; an outline drops nothing and hands the choice to the caller, who is the only party that knows what it needs. The fit is that both tools already own the lever the outline points at — `properties` for one, `fields` for the other — so neither needs a new input parameter, only a notice naming the existing one in place of the default `sections:[…]` wording. The budget is `DEFAULT_OUTLINE_BUDGET_BYTES` (24,000), measured — like every listed section size — in UTF-8 bytes of serialized JSON, never `.length`: UTF-16 code units undercount non-Latin text up to threefold, and counted that way Q30's outline offered `fields:["aliases","labels"]` as fitting a set that returned 30,409 bytes. It is deliberately a code constant rather than an env var, since a deploy-tunable threshold would drift a tool's output *shape* across environments.

**An outline may never point at a section it measured as over budget**
The two tools take the overflow decision differently, and the split is deliberate.

`wikidata_get_statements` keeps the short-circuit of `outlineOnOverflow` from `@cyanheads/mcp-ts-core/utils` — return a document with fewer than two sections intact, even over budget — which is exactly right there: the only re-call available is the tool's own `properties`, so an outline of one section would cost a round-trip that returns the same bytes. It takes the decision itself rather than calling the primitive, which measures UTF-16 code units (cyanheads/mcp-ts-core#614): the listed sizes are UTF-8 bytes, and "selections summing to the budget fit" holds only when the decision uses the same unit.

`wikidata_get_entity` measures itself instead (still using the module's `OUTLINE_VARIANT`, `formatOutline`, and budget constant), because that short-circuit assumes the re-call lever is the tool's own selector and here it is not. Every oversized category narrows through a lever `fields` has no vocabulary for — `statements` by P-ID through `wikidata_get_statements`, `sitelinks` by site code through `wikidata_get_sitelinks`, the language-keyed maps through `languages`. The round-trip redirects rather than repeats, so it is worth taking: short-circuiting it returned the ~793KB `fields: ["statements"]` payload the outline exists to prevent.

The same reasoning governs the notice, and generalizes past the single-section case. A multi-section outline that lists `statements — 793,825 bytes` and tells the caller to re-call `fields:["statements"]` is a confident pointer into the failure — worse than no outline, since an agent following it walks straight in. `sitelinks` on Q30 (59,631 bytes) is the same case, not a special one. And an outline naming every category that fits individually, when their total does not, is the same defect once more: advice that cannot work, this time looping instead of overflowing.

The rule that covers all three: a notice may only name a call this tool has already measured as one that will return data. That is a property of the guidance, not of the payload — the tools exist so a calling agent gets guidance that works, and the agent most likely to follow a notice literally is the one least able to recover when it is wrong.

Both tools model the two modes as one flat `z.object` with a `kind` discriminator and presence-based optional arms, because `tool()` rejects a `z.discriminatedUnion` output. Their `format()` renders each arm on field presence and never branches on `kind`: format-parity injects a single synthetic sample with every optional field populated at once, so a mutually-exclusive branch would leave the untaken arm unrendered. The re-call notice is named `retrieval_notice` — it is outline payload the agent acts on, and enrichment merges *after* `output.parse`, so it could only add to a fat result, never replace it with an outline.

**`wikidata_sparql_query` cuts rows to a byte budget instead of outlining**
A 10,000-row result serializes to ~2.5 MB of `structuredContent`, and rendering every row in `content[]` measures ~609 KB — neither is a response a client should take whole, and rendering only a sample left `content[]` with a fraction of what `structuredContent` carried. Rows have no section to outline, and the caller already owns the lever that reaches the rest (`ORDER BY` with `LIMIT`/`OFFSET`, or aggregation in the query), so the tool returns the leading rows that fit 64,000 bytes on both surfaces and names that lever in the notice. Charging each row the larger of its two renderings keeps the two surfaces cut at the same row. The disclosure uses `returnedCount` and `notice`, not `ctx.enrich.truncated()`, whose `truncated` key would collide with the output field that reports the 10,000-row server cap.

**Every `format()` renders every entry `structuredContent` carries**
`wikidata_get_entity`, `wikidata_get_labels`, `wikidata_get_statements`, and `wikidata_get_sitelinks` render every label, description, alias, statement (id, value with time/coordinate precision, qualifiers, every reference and part), and sitelink — clients that read only `content[]` see the same data. Each set is already bounded: the 24,000-byte outline budget, 50 IDs times the requested languages, or one item's own sitelinks.

**`wikidata_get_statements` resolves value QIDs to labels by default**
Raw statement data uses QIDs for item-type values (`"content": "Q76"`). Without label resolution, the agent gets back opaque identifiers it can't act on without a follow-up call. `resolve_labels: true` (the default) batches the value QID → label resolution into the same handler, eliminating a round trip. Callers can opt out for performance when they only need the QIDs.

**No `wikidata_get_entity_batch` tool**
The REST API has no batch entity fetch — N entities requires N calls. A batch tool would create an async.map over N REST calls, which is fine to implement but the surface complexity isn't justified for the initial design. Agents who need multiple entities can either use `wikidata_get_labels` (if they only need labels) or write a SPARQL query (if they need structured data). The gap can be filled if it proves to be a real pain point.

**SPARQL POST over GET**
POST requests to the SPARQL endpoint bypass the 5-minute CDN cache, which is correct for agent-driven dynamic queries. GET requests are cached, which would serve stale results to agents asking fresh questions. URL length limits are also a concern for complex SPARQL queries. The service layer always uses POST.

**No `wikidata_sparql_explain` or query optimization tool**
SPARQL query optimization (via Blazegraph's `EXPLAIN`) would be useful for developers but not for agents at runtime. The `wikidata_sparql_query` tool's timeout error message instructs agents to add `LIMIT` or simplify — that's the correct recovery hint. An explain tool would be developer tooling, not agent tooling.

**Sitelink tool included despite low frequency**
`wikidata_get_sitelinks` covers a specific but high-value use case: "what Wikipedia article corresponds to this QID?". This comes up in research workflows linking Wikidata entities to human-readable references. It's cheap (one REST call) and the URL returned is immediately useful. Kept in the surface.

**No property data type enumeration tool**
The REST API exposes `/v1/property-data-types` listing Wikidata's 18 data types. This is developer documentation, not agent-facing functionality. Agents don't need to know the abstract type system — `wikidata_get_statements` handles type normalization internally.

### 2026-07-14

**`wikidata_resolve_external_id` checks the property datatype upstream, not against an allowlist**
A non-`external-id` property produces valid SPARQL that can never match, so the caller got `match: null` — indistinguishable from a genuine miss. A hardcoded allowlist of external-ID properties was rejected: Wikidata has thousands and adds more, so the list would be wrong the day it shipped. `?_fields=data_type` makes the authoritative check cost tens of bytes and one round trip, which is cheaper than being wrong. Property absence and wrong-datatype share the `not_external_id_property` reason because the caller's fix is identical — supply a different P-ID.

**The resolver-prefix strip runs before the per-property normalization switch**
Stripping `https://doi.org/`-style wrappers after the per-property transform would appear to work for already-canonical inputs and silently fail for others. ORCID is the proof case: its hyphen reformat is gated on a length-16 check that URL text defeats, so a post-hoc strip returns a URL-prefixed *unhyphenated* ORCID unformatted, and the lookup misses. Stripping first means each property's existing transform always sees a bare identifier.

**`normalizeId()` trims, and is the only place that does**
Every ID-format call site — the entity/statements/sitelinks tools, the batch label tool, and the `wikidata://entity/{id}` resource — runs its `isQId`/`isPId` check on a `normalizeId()` result, so the four tools inherit the trim at once. The resource inherits it only nominally: a URI path segment carries whitespace percent-encoded (`wikidata://entity/ Q76 ` reaches the handler as `%20Q76`), which `.trim()` does not touch, so it still rejects — correctly, since that URI is malformed. `isQId`/`isPId` deliberately do not trim: nothing reaches them without passing through `normalizeId` first, and a second trim would imply otherwise. `wikidata_resolve_external_id` is the lone exception — its bespoke `/^P\d+$/` check bypasses the service helpers and carries its own trim.

### 2026-10-13

**One language-code schema for every `language`/`languages` input**
All six tools take their language through `src/mcp-server/tools/language-code.ts`. A value is trimmed, lowercased, and `_` becomes `-`; the result must match `^[a-z]{2,8}(-[a-z0-9]{1,9})*$`, which accepts every one of Wikidata's 637 term and 1,474 monolingual-text content-language codes (fixture: `tests/fixtures/wikibase-content-languages.json`) and admits no quote, backslash, brace, `|`, or whitespace — so a code is safe inside a SPARQL string literal. A blank single `language` means `en`, because form clients send `""` for untouched fields; `languages: []` and blank entries behave like an omitted field. The advertised JSON Schema `pattern` is the case- and `_`-tolerant pre-image of that check, not the canonical form: a canonical-only pattern would make validating clients refuse `EN`, which the server accepts. `wikidata_sparql_query` alone takes a comma-separated fallback list, validated entry by entry and advertised as the equivalent single pattern.

**Label SERVICE injection follows label variables, with no off switch**
`wikidata_sparql_query` injects the label SERVICE only when the query references a `?…Label`, `?…Description`, or `?…AltLabel` variable (either sigil) and declares no label SERVICE itself. The old `language: ""` off switch is gone: it collided with form clients sending `""` for an untouched field, which silently unbound every label. A query that binds its own label variable needs no switch, because the injected SERVICE is wrapped in OPTIONAL and leaves that variable's rows intact.

**Both SPARQL label paths fall back to `mul`**
Many items carry their name only as a multilingual (`mul`) label. The REST and `wbgetentities` paths already fall back to it, but the Query Service label SERVICE does not: it tries the listed languages and then binds the bare QID. So the injected SERVICE list ends in `mul` unless the caller's list names it (keeping the caller's order), and `wikidata_resolve_external_id` selects the `mul` label beside the requested one and uses it only when the requested one is absent.

**Parse-error positions are mapped back to the caller's query**
Blazegraph reports a syntax error's `line N, column M` in the text it received, which includes up to nine prepended `PREFIX` lines and the spliced label SERVICE. Both injections are shaped to keep that mapping arithmetic: prefixes are whole lines ahead of the caller's first line, and the SERVICE is spliced on the brace's own line rather than with line breaks that would renumber everything after it. `prepareQuery()` records the prefix-line count and the splice point; the 400/422 branch subtracts the prefix lines and, on the splice line, the SERVICE's length from a column past it. Positions follow Blazegraph's counting, verified live: CRLF, LF, and a lone CR each end a line, a tab is one column, and a character outside the Basic Multilingual Plane is two columns — UTF-16 code units, the same unit as a JavaScript string index. The caller's text is sent untrimmed, so leading blank lines keep their numbering.

**SELECT-only is enforced by a handler pre-flight, not a schema pattern**
The tool read `results.bindings` from every response, so ASK (a `boolean` body) surfaced as an `InternalError`, and CONSTRUCT/DESCRIBE returned triple rows the output contract does not describe. The handler now checks the query form after the prologue before any upstream call and fails other forms as `not_select_query`. It is a hand scan rather than a schema `.regex()` because JSON Schema `pattern` cannot carry the case-insensitive flag — validating clients would reject a lowercase `select` — and a regex over the prologue would have to model IRIs containing `#`.
