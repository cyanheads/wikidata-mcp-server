<div align="center">
  <h1>@cyanheads/wikidata-mcp-server</h1>
  <p><b>Search and fetch Wikidata entities, execute SPARQL queries, and resolve external identifiers via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/wikidata-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/wikidata-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/wikidata-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/wikidata-mcp-server/releases/latest/download/wikidata-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=wikidata-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvd2lraWRhdGEtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22wikidata-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fwikidata-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://wikidata.caseyjhand.com/mcp](https://wikidata.caseyjhand.com/mcp)

</div>

---

## Overview

Wikidata's knowledge graph. Search and fetch entities, traverse the graph with SPARQL, and resolve external identifiers like DOI, PMID, ORCID, OpenAlex, and IMDb to their Wikidata items. No API key required.

### Tools

| Tool | Description |
|:---|:---|
| `wikidata_search_entities` | Search for items or properties by text query, returning QIDs/PIDs with labels, descriptions, and match metadata |
| `wikidata_get_entity` | Fetch a full entity by QID or PID with optional field and language filtering |
| `wikidata_get_labels` | Batch-resolve up to 50 QIDs or PIDs to human-readable labels and descriptions |
| `wikidata_get_statements` | Fetch property claims for an entity with qualifier detail and QID label resolution |
| `wikidata_get_sitelinks` | Fetch Wikipedia and Wikimedia project article URLs for a Wikidata item |
| `wikidata_sparql_query` | Execute a SPARQL SELECT query against the Wikidata Query Service |
| `wikidata_resolve_external_id` | Look up a Wikidata entity by an external identifier (DOI, PubMed ID, ORCID, OpenAlex ID, etc.) |

### Resources

| Resource | Description |
|:---|:---|
| `wikidata://entity/{id}` | Compact markdown summary of a Wikidata entity — labels, English description, instance-of, Wikipedia link, image, and statement count |

All resource data is also reachable via tools.

The published [wikidata-guide](./skills/wikidata-guide/SKILL.md) covers entity disambiguation, qualified statements, external identifiers, and SPARQL. It is included in plugin installs and served over MCP as `skill://wikidata-guide/SKILL.md`.

## Capability reference

### `wikidata_search_entities` <sub>tool</sub>

- Searches labels, aliases, and descriptions; `type="item"` for people, places, and works, `type="property"` for P-IDs
- Takes a Wikidata language code (`en`, `de`, `pt-br`; case-insensitive); offset pagination, up to 50 results per call
- Each hit includes match metadata saying whether it matched a label or alias

---

### `wikidata_get_entity` <sub>tool</sub>

- Q-IDs (e.g. `Q76`) fetch items and P-IDs (e.g. `P31`) fetch properties; `fields` selects `labels`, `descriptions`, `aliases`, `statements`, or `sitelinks`, and narrows the upstream fetch (Q76 is 344,114 bytes whole, 6,703 for `labels` alone)
- `languages` filters multilingual maps to the given language codes
- An entity too large to inline returns an outline of field categories with byte sizes; its `retrieval_notice` names a `fields` set that fits and points oversized statements or sitelinks to the tool that can narrow them

---

### `wikidata_get_labels` <sub>tool</sub>

- Up to 50 IDs per call via the MediaWiki `wbgetentities` API, with one or more language codes per request
- Reports a `found` count and `notFound` IDs for partial results
- Meant to follow a SPARQL query: run it, then humanize the QIDs

---

### `wikidata_get_statements` <sub>tool</sub>

- `properties` limits the fetch to specific P-IDs (omit for all); item QIDs and quantity units in values, qualifiers, and references are resolved to labels unless `resolve_labels=false`
- References stay grouped by source; unknown or absent values come back as `somevalue` / `novalue`
- A statement set too large to inline returns an outline of P-IDs with byte sizes, largest first (unfiltered, Q30 carries 467 properties across 1,717 statements); re-call with `properties` whose sizes sum to 24,000 or less, as the `retrieval_notice` suggests

---

### `wikidata_get_sitelinks` <sub>tool</sub>

- Maps site codes (e.g. `enwiki`) to article titles and URLs; `sites` filters to specific codes
- `wikis_only=true` keeps only Wikipedia links (drops Wiktionary, Wikiquote, Wikisource, etc.)
- Q-IDs only; P-IDs are not supported

---

### `wikidata_sparql_query` <sub>tool</sub>

- Runs SELECT queries against the Wikidata Query Service (Blazegraph); ASK, CONSTRUCT, DESCRIBE, updates, and plain search text are rejected before the request is sent
- Standard prefixes (`wd:`, `wdt:`, `p:`, `ps:`, `pq:`, `wikibase:`, `bd:`) and the `wikibase:label` SERVICE (when the query uses a `?<var>Label`, `?<var>Description`, or `?<var>AltLabel` variable) are added automatically; `language` takes one code or a fallback list like `fr,en`
- Results are SPARQL 1.1 JSON bindings, capped at 64,000 bytes per response and cut between whole rows; a larger result returns its leading rows with `returnedCount`, `totalCount`, and a notice to page with `ORDER BY` plus `LIMIT`/`OFFSET` or to aggregate
- Client `timeout` is 1–55s (server hard limit 60s); rate limit is 60 requests/min and 5 concurrent requests per IP

---

### `wikidata_resolve_external_id` <sub>tool</sub>

- Resolves DOI (P356), PMID (P698), ORCID (P496), OpenAlex ID (P10283), IMDb ID (P345), and other external IDs to a QID; whitespace and resolver URL prefixes are stripped, and DOIs, PMIDs, and ORCIDs are normalized
- The property must have data type `external-id`; item-valued or media properties (e.g. `P31`, `P18`) are rejected
- Returns `match=null` when not found (the Query Service lags the live wiki, so null is not proof of absence) and `multipleMatches` when more than one entity claims the same ID; the label uses the requested `language`, falling back to `mul`

---

### `wikidata://entity/{id}` <sub>resource</sub>

- Compact markdown summary — labels (all languages), English description, instance-of (`P31`), enwiki Wikipedia link, image (`P18`), and statement count
- Returned as `text/markdown`; for full entity data, use `wikidata_get_entity`
- `id` is a Q-ID or P-ID, the same identifiers the tools take

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Wikidata-specific:

- Wikidata REST API v1 for entity and statement fetches — no SPARQL overhead for lookup operations
- MediaWiki `wbgetentities` API for efficient batch label resolution
- Wikidata Query Service (Blazegraph) for SPARQL with auto-injected prefix headers and label SERVICE
- Configurable `User-Agent` per Wikimedia policy (`WIKIDATA_USER_AGENT`)
- Separate timeout configuration for REST and SPARQL endpoints (`WIKIDATA_REST_TIMEOUT_MS`, `WIKIDATA_SPARQL_TIMEOUT_MS`)

Agent-friendly output:

- All tools echo relevant input parameters in the response for traceability
- `wikidata_get_labels` designed to follow SPARQL result sets — run the query, then humanize in one call
- `wikidata_resolve_external_id` returns `multipleMatches` instead of a false null when a Wikidata data-integrity issue puts duplicate claims on one external ID
- Oversized entities and statement sets return a `kind: "outline"` payload — field/property sizes plus a `retrieval_notice` naming the exact re-call — instead of a truncated or oversized response

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http wikidata-mcp-server https://wikidata.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add wikidata-mcp-server -- npx -y @cyanheads/wikidata-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "wikidata-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/wikidata-mcp-server"]
    }
  }
}
```

For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

All configuration is validated at startup via Zod schemas. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments | none |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateful`, `stateless`, or `auto` | `stateless` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`) | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in forced-GC interval in ms (Bun only) | `0` (disabled) |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `WIKIDATA_USER_AGENT` | User-Agent string for Wikimedia requests (policy requires a descriptive value) | `wikidata-mcp-server/0.1 (https://github.com/cyanheads/wikidata-mcp-server)` |
| `WIKIDATA_SPARQL_TIMEOUT_MS` | Max wait for a SPARQL response in ms | `55000` |
| `WIKIDATA_REST_TIMEOUT_MS` | Max wait for REST API responses in ms | `10000` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js ≥24.0.0).

```sh
git clone https://github.com/cyanheads/wikidata-mcp-server.git
cd wikidata-mcp-server
bun install
cp .env.example .env
```

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/wikidata-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/wikidata-mcp-server`. For stdio client configuration, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/wikidata-mcp-server:latest"]`. Build locally with `docker build -t wikidata-mcp-server .`; OpenTelemetry peers are installed by default (`--build-arg OTEL_ENABLED=false` omits them).

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and resources, inits services. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Seven tools for entity lookup, statements, sitelinks, SPARQL, and external ID resolution. |
| `src/mcp-server/resources` | Resource definitions. Entity summary resource. |
| `src/services/wikidata` | Wikidata service layer — REST API client, SPARQL client, statement normalization, types. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |
| `skills/wikidata-guide/` | Published guide for entity resolution, statements, and SPARQL workflows. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
