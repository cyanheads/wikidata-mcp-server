<div align="center">
  <h1>@cyanheads/wikidata-mcp-server</h1>
  <p><b>Search and fetch Wikidata entities, execute SPARQL queries, and resolve external identifiers via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.19-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/wikidata-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/wikidata-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/wikidata-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Wikidata's knowledge graph — entity search and lookup over the REST API v1, graph traversal via SPARQL against the Query Service, batch label resolution through MediaWiki, and external identifier resolution (DOI, PMID, ORCID, OpenAlex, IMDb). Search, fetch, and traverse entities from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

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

## Capability reference

### `wikidata_search_entities` <sub>tool</sub>

- Searches labels, aliases, and descriptions
- `type="item"` for real-world concepts (people, places, works); `type="property"` for predicate P-IDs
- Language-aware results (BCP 47 language codes)
- Offset-based pagination, up to 50 results per call
- Returns match metadata indicating whether the hit was on a label or alias

---

### `wikidata_get_entity` <sub>tool</sub>

- Q-IDs (e.g. `Q76`) fetch items; P-IDs (e.g. `P31`) fetch properties — endpoint routing is automatic
- `fields` parameter selects `labels`, `descriptions`, `aliases`, `statements`, or `sitelinks`
- `fields` narrows the upstream fetch, not just the response — Q76 is 344,114 bytes whole, 6,703 for `labels` alone
- `languages` parameter filters multilingual maps to specific language codes, client-side (the entity endpoint takes no language parameter)
- An entity too large to inline returns a field-category outline with byte sizes instead of the data — follow its `retrieval_notice`: it names a literal `fields` set already measured to fit (category sizes are additive, so requesting every name listed would overflow again), defers the remainder to a further call, and redirects a category too large to deliver whole (statements or sitelinks on a major item) to the tool that can narrow it

---

### `wikidata_get_labels` <sub>tool</sub>

- Up to 50 IDs per call, batched via the MediaWiki `wbgetentities` API
- Supports multiple language codes per request
- Reports `found` count and `notFound` IDs for partial-result handling
- Designed for the common agent pattern: run a SPARQL query, then humanize the QID results

---

### `wikidata_get_statements` <sub>tool</sub>

- `properties` parameter fetches only specific P-IDs — omit to return all statements
- Value QIDs are resolved to human-readable labels by default via a batched label call
- Set `resolve_labels=false` for raw QIDs only (faster, smaller payload)
- A statement set too large to inline returns an outline of the available P-IDs with byte sizes, largest first, instead of the statements — re-call with `properties` for the ones you need (unfiltered, Q30 carries 467 properties across 1,717 statements)
- Preferred-rank statements represent the most current values
- Designed for fact verification: "what does Wikidata say about this entity's {property}?"

---

### `wikidata_get_sitelinks` <sub>tool</sub>

- Maps site codes (e.g., `enwiki`) to article titles and URLs
- `sites` parameter filters to specific site codes
- `wikis_only=true` returns only Wikipedia links (excludes Wiktionary, Wikiquote, Wikisource, etc.)
- Major items can have 300+ sitelinks across languages
- Only Q-IDs (items) have sitelinks — P-IDs are not supported

---

### `wikidata_sparql_query` <sub>tool</sub>

- Full graph power over the Wikidata Query Service (Blazegraph): multi-hop traversals, aggregations, subqueries, OPTIONAL, FILTER, UNION, BIND
- Standard Wikidata prefixes (`wd:`, `wdt:`, `p:`, `ps:`, `pq:`, `wikibase:`, `bd:`) are auto-injected
- `wikibase:label` SERVICE auto-injected when `language` is set and the query uses `?<var>Label` variables
- Results in SPARQL 1.1 JSON format: each binding is `{ type, value, "xml:lang"? }`
- Hard server timeout is 60s; client-side `timeout` parameter (1–55s) applies earlier
- Rate-limited at 60 requests/min and 5 concurrent requests per IP

---

### `wikidata_resolve_external_id` <sub>tool</sub>

- Common use cases: CrossRef DOI → QID (P356), PubMed PMID → QID (P698), ORCID → author QID (P496), OpenAlex ID → entity QID (P10283), IMDb ID (P345)
- Automatic value normalization: surrounding whitespace trimmed, resolver URL prefixes stripped (`https://doi.org/`, `https://pubmed.ncbi.nlm.nih.gov/`, `https://orcid.org/`), DOIs uppercased, PMID prefixes stripped, ORCID hyphens normalized
- The property's data type must be `external-id` — item-valued or media properties (e.g. `P31`, `P18`) are rejected rather than returning an empty match
- Returns `match=null` when not found (the Query Service lags the live wiki, so a null is not proof of absence)
- Returns `multipleMatches` when a Wikidata data integrity issue causes more than one entity to claim the same external ID
- Designed for cross-server joins with pubmed-mcp-server, crossref-mcp-server, and openalex-mcp-server

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

### Public Hosted Instance

A public instance is available at `https://wikidata.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "wikidata-mcp-server": {
      "type": "streamable-http",
      "url": "https://wikidata.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "wikidata-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/wikidata-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "wikidata-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/wikidata-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "wikidata-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/wikidata-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js ≥ 24.0.0).

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/wikidata-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd wikidata-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set any overrides
```

## Configuration

All configuration is validated at startup via Zod schemas. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments | none |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateful`, `stateless`, or `auto`. The framework's `auto` default resolves to `stateful`; this server explicitly selects `stateless`. | `stateless` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`) | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC interval (ms). Try `60000` if heap growth is observed under HTTP load. | `0` (disabled) |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `WIKIDATA_USER_AGENT` | User-Agent string for Wikimedia requests (policy requires a descriptive value) | `wikidata-mcp-server/0.1 (https://github.com/cyanheads/wikidata-mcp-server)` |
| `WIKIDATA_SPARQL_TIMEOUT_MS` | Max wait for a SPARQL response in ms | `55000` |
| `WIKIDATA_REST_TIMEOUT_MS` | Max wait for REST API responses in ms | `10000` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

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
docker build -t wikidata-mcp-server .
docker run --rm -p 3010:3010 wikidata-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/wikidata-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and resources, inits services. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Seven tools for entity lookup, statements, sitelinks, SPARQL, and external ID resolution. |
| `src/mcp-server/resources` | Resource definitions. Entity summary resource. |
| `src/services/wikidata` | Wikidata service layer — REST API client, SPARQL client, statement normalization, types. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

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
