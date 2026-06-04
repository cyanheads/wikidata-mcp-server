# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-06-04

Fix entity_not_found contract never firing (err.data.statusCode → err.data.status); fix wikidata_sparql_query truncated field always false — now inferred from 10,000-row server cap

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-06-02

mcp-ts-core ^0.9.16 → ^0.9.21: per-request log context fix, secret-stripping in fetchWithTimeout, withRetry fail-fast on non-retryable errors; release:github script; skills sync (api-mirror, orchestrations, 8 updated)

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-05-30

enrichment adoption: wikidata_search_entities and wikidata_sparql_query surface query echoes, result totals, and empty-result guidance via ctx.enrich; mcp-ts-core ^0.9.13 → ^0.9.16

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-05-28

mcp-ts-core ^0.9.9 → ^0.9.13: 413 body cap, HTTP session-init gate, quieter error logs, GET /mcp keywords

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-05-24

Bug fix: external-id/url statement types preserved in StatementValue union; code simplification; error codes corrected to ValidationError; mcp-ts-core ^0.9.7 → ^0.9.9

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-24

Three field-test bug fixes: SPARQL label SERVICE injection with LIMIT, empty search descriptions, 400 from out-of-range IDs

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-23

Hosted server endpoint — remotes block in server.json, public URL in README

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-23

Metadata alignment to pubmed gold standard — scripts, descriptions, Dockerfile labels, README badges

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-23

Sync tagline across all surfaces — adds 'and' before 'resolve external identifiers'

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-24

Label type fixes, statusCode error path, resource output shape — correct the REST API type layer and not_found detection

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-23

First real release — Wikidata knowledge graph MCP server with 7 tools for entity search/fetch, SPARQL queries, batch label resolution, and external ID lookup (DOI, PMID, ORCID, OpenAlex, IMDb)

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-23

Initial release — 7 tools covering entity search, fetch, statements, labels, sitelinks, SPARQL, and external ID resolution
