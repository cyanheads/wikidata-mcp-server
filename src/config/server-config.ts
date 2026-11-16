/**
 * @fileoverview Server-specific configuration for wikidata-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  userAgent: z
    .string()
    .default('wikidata-mcp-server/0.1 (https://github.com/cyanheads/wikidata-mcp-server)')
    .describe(
      'User-Agent string for Wikimedia requests. Wikimedia policy requires a descriptive User-Agent.',
    ),
  sparqlTimeoutMs: z.coerce
    .number()
    .default(55_000)
    .describe(
      'Max time to wait for a SPARQL response in milliseconds, retries included. It caps every call, including a wikidata_sparql_query timeout asked for, and is itself held to 55000. Default: 55000 (just under the 60s hard server limit).',
    ),
  restTimeoutMs: z.coerce
    .number()
    .default(10_000)
    .describe('Max time to wait for REST API responses in milliseconds. Default: 10000.'),
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Serve a count above its per-call cap at the cap, with a notice. false rejects it instead, naming the cap. Default: true.',
    ),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

/** Returns the lazy-parsed server configuration. */
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    userAgent: 'WIKIDATA_USER_AGENT',
    sparqlTimeoutMs: 'WIKIDATA_SPARQL_TIMEOUT_MS',
    restTimeoutMs: 'WIKIDATA_REST_TIMEOUT_MS',
    clampLimits: 'WIKIDATA_CLAMP_LIMITS',
  });
  return _config;
}
