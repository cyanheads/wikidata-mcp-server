# wikidata-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `wikidata_search_entities` | Search Wikidata for items or properties by text query. Returns QIDs/PIDs with labels, descriptions, and match metadata. | `query`, `type` (item/property), `language`, `limit` | `readOnlyHint: true` |
| `wikidata_get_entity` | Fetch a Wikidata entity (item or property) by QID or PID. Supports client-side field filtering to trim 300KB+ payloads before returning to the caller. Routes to `/entities/items/{id}` for Q-IDs and `/entities/properties/{id}` for P-IDs. | `id`, `fields` (labels/descriptions/aliases/statements/sitelinks), `languages` | `readOnlyHint: true` |
| `wikidata_get_labels` | Resolve one or more QIDs/PIDs to their human-readable labels and descriptions in specified languages. Lightweight — no claim data. | `ids` (array), `languages` | `readOnlyHint: true` |
| `wikidata_get_statements` | Get specific property claims for an entity, with qualifier and reference detail. Resolves value QIDs to labels inline. | `id`, `properties` (P-ID array), `language` | `readOnlyHint: true` |
| `wikidata_get_sitelinks` | Get Wikipedia and other Wikimedia project URLs for an entity, optionally filtered to specific wiki codes. | `id`, `sites` (optional filter array) | `readOnlyHint: true` |
| `wikidata_sparql_query` | Execute a SPARQL query against the Wikidata Query Service. Full graph query power for complex traversals, aggregations, and multi-hop joins. | `query` (SPARQL string), `language` (label language), `timeout` | `readOnlyHint: true` |
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
| Item (Q-ID) | search, get, get-labels, get-statements, get-sitelinks | REST `/v1/search/items`, `/v1/entities/items/{id}` (all fields always returned — field filtering is client-side), `/v1/entities/items/{id}/statements`, `/v1/entities/items/{id}/sitelinks` |
| Property (P-ID) | search, get, get-labels, get-statements | REST `/v1/search/properties`, `/v1/entities/properties/{id}`, `/v1/entities/properties/{id}/statements`. **Must use the properties endpoint — the items endpoint returns HTTP 400 for P-IDs.** |
| Statement | get by property filter | REST `/v1/entities/items/{id}/statements?property={P-id}` |
| Sitelink | get, filter by site | REST `/v1/entities/items/{id}/sitelinks`, `/v1/entities/items/{id}/sitelinks/{site_id}` |
| Graph query | arbitrary SPARQL | SPARQL `https://query.wikidata.org/sparql` POST |
| External ID | resolve to QID | SPARQL (no REST batch-by-external-id endpoint exists) |

### Entity Data Model

- **Items** (Q-IDs): people, places, concepts, works — anything. 100M+ items.
- **Properties** (P-IDs): the predicates that connect items. ~12K properties. Each has a `data_type` (wikibase-item, external-id, time, quantity, string, url, …).
- **Statements**: `{ id, rank, value, qualifiers[], references[] }`. Value shape varies by `data_type`.
- **Qualifiers**: additional context for a statement (e.g., a start date on a "position held" claim).
- **References**: provenance for a statement (e.g., the source database that first recorded it).
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
| 1 | `GET /v1/entities/items/{id}` or `GET /v1/entities/properties/{id}` | Full entity data (always all fields — REST API has no server-side field selection) |
| — | Client-side field filtering | Handler strips unrequested fields from the response before returning. Network payload is always the full entity. |

When `fields` includes `statements`, the handler may optionally make N additional label-fetch calls for value QIDs (deferred to `wikidata_get_statements` which has dedicated label resolution).

### `wikidata_get_labels` (1 upstream call)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /w/api.php?action=wbgetentities&ids=Q1\|Q2\|…&props=labels\|descriptions&languages=en` | Batch fetch labels for up to 50 QIDs in one request |

Uses MediaWiki API (`wbgetentities`) rather than the REST API because the REST API has no batch label endpoint — individual `/labels/{lang}` calls would be N+1.

### `wikidata_get_statements` (2 upstream calls, parallel)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /v1/entities/items/{id}/statements?property={pid}` (Q-IDs) or `GET /v1/entities/properties/{id}/statements` (P-IDs) | Fetch raw statement data — route by ID prefix |
| 2 | `wbgetentities` batch (parallel) | Resolve value QIDs to human-readable labels |

The two calls can be parallelized after step 1 returns the value QIDs.

### `wikidata_resolve_external_id` (1 REST call + 1 SPARQL call, sequential)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /v1/entities/properties/{id}?_fields=data_type` | Confirm the property's data type is `external-id` before spending a SPARQL call. `?_fields=data_type` answers in ~40 bytes. |
| 2 | `POST /sparql` with `SELECT ?item WHERE { ?item wdt:{P} "{value}" }` | Map external ID to QID |

Sequential, not parallel — step 1 is a gate, and a non-`external-id` property makes step 2 pointless (the SPARQL is valid but can never match).

Uses SPARQL because the REST API has no "get entity by external ID value" endpoint.

### `wikidata_sparql_query` (1 SPARQL call, pass-through)

Raw SPARQL forwarded to the endpoint. Hard 60s server timeout; default client timeout 55s so the error is from our side. Error responses are Java stack traces from Blazegraph — the service layer must parse/strip these down to the meaningful error line.

---

## Tool Designs

### `wikidata_search_entities`

**Purpose:** Text search returning a ranked list of matching items or properties with QIDs/PIDs, labels, descriptions, and match type (label vs. alias match).

**Input schema:**
- `query: string` — search terms
- `type: enum('item', 'property')` — default `'item'`
- `language: string` — BCP 47 language code for labels/descriptions, default `'en'`
- `limit: number` — 1–50, default `10`
- `offset: number` — optional pagination offset

**Output:** `{ results: Array<{ id, label, description, match }> }` where `match` conveys whether it was a label or alias match and in which language. The API returns no total count — pagination is offset-only with no result ceiling indicator.

**Enrichment:** `effectiveQuery`, `searchType`, `language`, `resultCount` (always); `notice` (empty-result guidance when `results` is empty).

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

**Implementation note:** Uses REST `/v1/search/items` and `/v1/search/properties`. The `display-label` field in the response is a nested object `{ language, value }` — extract `.value` for the output `label` field. The `description` field is similarly nested `{ language, value }`. The response has no `total` field.

---

### `wikidata_get_entity`

**Purpose:** Fetch a Wikidata entity by QID or PID with configurable field selection. The REST API returns all fields unconditionally — `fields` filtering is applied client-side before returning to the caller, keeping context budget low. Full entity data for a major item (Q76 Barack Obama) is ~370KB with 410 properties and 340 sitelinks — returning only `labels` and `descriptions` drops this to a few kilobytes.

**Routing:** Q-IDs → `GET /v1/entities/items/{id}`. P-IDs → `GET /v1/entities/properties/{id}`. The items endpoint returns HTTP 400 for P-IDs; routing must be done by ID prefix before the request.

**Input schema:**
- `id: string` — Q-ID (e.g., `"Q76"`) or P-ID (e.g., `"P31"`). Case-insensitive, normalized to uppercase.
- `fields: array<enum('labels','descriptions','aliases','statements','sitelinks')>` — optional; omit for all fields. Filtering is client-side — the full entity is fetched, then trimmed.
- `languages: array<string>` — optional language filter for labels/descriptions/aliases; omit for all languages

**Output:** Entity data with only the requested fields. Each field is returned as-is from the API with no truncation. The `statements` field preserves full qualifier and reference structure. P-IDs include a `data_type` field; `sitelinks` is absent on property entities.

**Errors:**
- `entity_not_found` (`NotFound`): no entity exists at this ID. REST answers an unassigned but well-formed ID (`Q99999999`) with HTTP 404 `resource-not-found`, and a syntactically valid but out-of-range ID (`Q999999999999`) with HTTP 400 `invalid-path-parameter` — both mean "no such entity" to a caller and map to this reason.
- `invalid_id` (`ValidationError`): ID format unrecognized (must be Q+digits or P+digits)

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `wikidata_get_labels`

**Purpose:** Resolve a batch of QIDs/PIDs to their human-readable labels and descriptions. Cheap and fast — returns no claim data. Designed for the common agent pattern of having a set of QIDs (e.g., from a SPARQL query) and needing to display them.

**Input schema:**
- `ids: array<string>` — 1–50 Q-IDs or P-IDs
- `languages: array<string>` — BCP 47 language codes; default `['en']`

**Output:** `{ entities: Record<id, { labels: Record<lang, string>, descriptions: Record<lang, string> }> }` — only requested languages included.

**Errors:**
- `invalid_ids` (`ValidationError`): array contains non-Q/P-ID values

An ID that is well-formed but does not resolve is not an error — it is absent from `entities` and listed in `notFound`, so a partial batch still returns its valid members.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false` (given valid IDs, output is deterministic)

**Implementation note:** Uses `wbgetentities` MediaWiki API with `props=labels|descriptions` and `languages` parameter. Supports up to 50 IDs per request; the handler chunks inputs into batches of 50 and parallelizes.

A non-resolving ID has two distinct shapes, and they must not be conflated:
- **Unassigned but in range** (`Q99999999`): arrives inside a normal `entities` map as a per-item `{"id": "Q99999999", "missing": ""}` marker, alongside the valid members. Skip the marked entry.
- **Out of range** (`Q999999999999`): rejects the *whole batch* with a top-level `error` key (`code: "no-such-entity"`) and no `entities` map at all, naming only the **first** offending ID in `error.id`. Drop the named ID and re-request the remainder, so valid members still resolve; repeat until the batch clears (each pass removes exactly one ID, so it terminates). Any other top-level `error` code is a real failure and is thrown rather than reported as "nothing found".

Both arrive as HTTP 200 — the error rides in the body, not the status.

`languagefallback=1` is set on every request so a requested language with no label of its own resolves to the entity's `mul` (multilingual) value. Fallback values stay keyed by the requested language, carrying `language`/`for-language` metadata alongside `value`.

---

### `wikidata_get_statements`

**Purpose:** Get specific property claims for an entity with full qualifier and reference detail, with value QIDs resolved to human-readable labels inline. Designed for fact verification — "what does Wikidata say about this entity's {property}?".

**Input schema:**
- `id: string` — Q-ID of the item or P-ID of a property. Routes to `/v1/entities/items/{id}/statements` for Q-IDs and `/v1/entities/properties/{id}/statements` for P-IDs.
- `properties: array<string>` — P-IDs to fetch (e.g., `["P31", "P569", "P27"]`); omit for all properties (large)
- `language: string` — language for label resolution, default `'en'`
- `resolve_labels: boolean` — resolve value QIDs to labels, default `true`

**Output:** Map of property ID → array of statements. Each statement includes `rank`, `value` (with resolved label if applicable), `qualifiers` (similarly resolved), and a trimmed `references` summary.

Statement value normalization by data type:
- `wikibase-item` values: `{ qid, label }` (label resolved if `resolve_labels: true`)
- `time` values: `{ time, precision }` — ISO string + precision level (e.g., 11 = day)
- `quantity` values: `{ amount, unit }` — unit QID resolved to label
- `external-id`, `string`, `url` values: raw string
- `monolingualtext` values: `{ text, language }`

**Errors:**
- `entity_not_found` (`NotFound`): no item at this QID — HTTP 404 (unassigned) or HTTP 400 (out of range), same as `wikidata_get_entity`
- `invalid_id` (`ValidationError`): ID is not a valid Q-ID or P-ID format
- `invalid_property` (`ValidationError`): a `properties` entry is not P+digits format. Validated before the fetch, naming every offending entry — a malformed entry is the only thing the REST `?property=` filter answers with HTTP 400, so rejecting it here keeps that status unambiguous for `entity_not_found`.

A well-formed but unassigned P-ID (`P9999999`) is not an error — it returns an empty result, the honest answer to "this entity has no such statements".

**Annotations:** `readOnlyHint: true`

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

**Annotations:** `readOnlyHint: true`

---

### `wikidata_sparql_query`

**Purpose:** Execute an arbitrary SPARQL query against the Wikidata Query Service. Full graph traversal — multi-hop joins, aggregations, subqueries, federated queries. Use for anything beyond single-entity lookups: "all Nobel Prize winners in Chemistry since 2000", "co-authors of an author", "all cities in a country with population > 1M".

The tool handles Wikidata's auto-label SERVICE boilerplate automatically when `language` is specified — the caller doesn't need to include `SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }` manually.

**Input schema:**
- `query: string` — SPARQL SELECT query. Must be a SELECT query (not CONSTRUCT/DESCRIBE/ASK). The `wikibase:` prefixes are auto-populated.
- `language: string` — language for `wikibase:label` service, default `'en'`. Set to `''` to suppress label injection.
- `timeout: number` — client-side timeout in seconds, 1–55, default `30`. Capped at 55 (server hard limit is 60s).

**Output:** `{ results: Array<Record<string, { type, value, "xml:lang"? }>>, variables: string[], truncated: boolean }` — raw SPARQL bindings with type annotations. Language-tagged literals use the key `"xml:lang"` (not `"lang"`) — this is the SPARQL 1.1 JSON format. `truncated` is always false for SELECT queries (results are complete or the query times out).

**Errors:**
- `parse_error` (`ValidationError`): SPARQL syntax error — includes the relevant error line stripped from the Blazegraph stack trace
- `timeout` (`ServiceUnavailable`, retryable): query exceeded the time limit — simplify or add LIMIT
- `throttled` (`RateLimited`, retryable): rate limited (60 req/min, 5 concurrent per IP) — retry after `Retry-After` header value

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

**Implementation note:** POST queries bypass the CDN cache, which is correct for dynamic agent queries. GET queries are cached up to 5 minutes but hit URL length limits for complex queries. Use POST.

---

### `wikidata_resolve_external_id`

**Purpose:** Look up a Wikidata entity by an external identifier — a DOI, PubMed ID, ORCID iD, OpenAlex ID, etc. The primary use case is cross-server joins: "I have a DOI from CrossRef — what's the Wikidata QID for this paper?" Returns the QID, label, description, and any additional matching metadata.

**Input schema:**
- `property: string` — P-ID of the external ID property (e.g., `"P356"` for DOI, `"P698"` for PubMed ID, `"P496"` for ORCID, `"P10283"` for OpenAlex ID)
- `value: string` — the external ID value (e.g., `"10.1038/nature01234"`)
- `language: string` — language for label/description, default `'en'`

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
| `/entities/items/{id}` | GET | Full item data (all fields always returned — no server-side field selection; filtering must be done client-side) |
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
- **No server-side field selection on entity fetch.** The REST API ignores `?fields=` query parameters and always returns the full entity payload (~370KB for major items). The `fields` parameter on `wikidata_get_entity` filters client-side — the network cost is unavoidable.
- **Statement value payloads vary by data type.** `wikibase-item`, `time`, `quantity`, `string`, `external-id`, `url`, `monolingualtext`, `globe-coordinate`, `math`, `musical-notation`, `tabular-data`, `geo-shape` — 12+ data types each with different value shapes. The server normalizes to a consistent structure per type, but callers should expect `type` to vary.
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
A full entity payload for a major item (Barack Obama Q76) is ~370KB with 410 properties, 113 labels, 242 descriptions, and 340 sitelinks. The REST API has no server-side field selection — `?fields=` query parameters are silently ignored, and the full entity is always returned over the wire. The `fields` parameter on this tool is implemented as client-side filtering: the handler fetches the full entity, then strips unrequested fields before returning to the caller. The network cost is fixed; the context budget benefit to the caller is real.

**`wikidata_get_labels` as a dedicated tool**
Label resolution is a separate concern from entity data. Agents running SPARQL queries routinely get back sets of QIDs and need to humanize them. A dedicated `wikidata_get_labels` batches up to 50 QIDs in one MediaWiki API call rather than N REST calls. This pattern — "get QIDs from SPARQL, then resolve labels" — is the most common two-step workflow in practice.

**`wikidata_resolve_external_id` uses SPARQL, not REST**
The REST API has no "find entity by external ID value" endpoint — you can't do `GET /entities/items?P356=10.1038/...`. The SPARQL `SELECT ?item WHERE { ?item wdt:P356 "..." }` pattern is the correct approach. Wrapping it as a named tool with a `property`/`value` interface hides this complexity from callers who don't know SPARQL.

**`wikidata_sparql_query` injects label SERVICE automatically**
The `SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }` block is required in virtually every practical SPARQL query that uses `?itemLabel` variables. Making agents write this boilerplate for every query is friction with no upside. The service layer injects it when `language` is set (the default) and the query doesn't already include it.

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
The REST API exposes `/v1/property-data-types` listing Wikidata's 12+ data types. This is developer documentation, not agent-facing functionality. Agents don't need to know the abstract type system — `wikidata_get_statements` handles type normalization internally.

### 2026-07-14

**`wikidata_resolve_external_id` checks the property datatype upstream, not against an allowlist**
A non-`external-id` property produces valid SPARQL that can never match, so the caller got `match: null` — indistinguishable from a genuine miss. A hardcoded allowlist of external-ID properties was rejected: Wikidata has thousands and adds more, so the list would be wrong the day it shipped. `?_fields=data_type` makes the authoritative check cost tens of bytes and one round trip, which is cheaper than being wrong. Property absence and wrong-datatype share the `not_external_id_property` reason because the caller's fix is identical — supply a different P-ID.

**The resolver-prefix strip runs before the per-property normalization switch**
Stripping `https://doi.org/`-style wrappers after the per-property transform would appear to work for already-canonical inputs and silently fail for others. ORCID is the proof case: its hyphen reformat is gated on a length-16 check that URL text defeats, so a post-hoc strip returns a URL-prefixed *unhyphenated* ORCID unformatted, and the lookup misses. Stripping first means each property's existing transform always sees a bare identifier.

**`normalizeId()` trims, and is the only place that does**
Every ID-format call site — the entity/statements/sitelinks tools, the batch label tool, and the `wikidata://entity/{id}` resource — runs its `isQId`/`isPId` check on a `normalizeId()` result, so the four tools inherit the trim at once. The resource inherits it only nominally: a URI path segment carries whitespace percent-encoded (`wikidata://entity/ Q76 ` reaches the handler as `%20Q76`), which `.trim()` does not touch, so it still rejects — correctly, since that URI is malformed. `isQId`/`isPId` deliberately do not trim: nothing reaches them without passing through `normalizeId` first, and a second trim would imply otherwise. `wikidata_resolve_external_id` is the lone exception — its bespoke `/^P\d+$/` check bypasses the service helpers and carries its own trim.
