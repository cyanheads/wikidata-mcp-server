# wikidata-mcp-server

Structured knowledge graph access via the Wikidata SPARQL endpoint and REST API.

## Data source

- **Wikidata Query Service** — SPARQL endpoint for complex queries across 100M+ items
- **Wikidata REST API** — entity lookups, search, label/description resolution
- **Auth**: None required
- **Rate limits**: Concurrent query limits on SPARQL; REST is generous

## Why it earns its keep

Entity resolution is universal. Every agent that needs to disambiguate a person, place, organization, concept, or verify a structured fact benefits from Wikidata. It's the connective tissue for cross-server joins — linking entities across PubMed, OpenAlex, Crossref, and others via stable QIDs.

## Target users

- Agents doing fact verification or entity disambiguation
- Research workflows needing structured entity metadata
- Cross-referencing entities across other MCP servers (OpenAlex, PubMed, etc.)
- Multilingual entity resolution

## Scope

- Read-only
- Entity search and lookup by QID
- SPARQL query execution
- Property/claim traversal
- Label/description/alias resolution across languages
- Sitelink lookup (Wikipedia article URLs)
