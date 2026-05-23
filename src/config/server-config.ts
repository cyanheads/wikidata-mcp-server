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
      'Max time to wait for a SPARQL response in milliseconds. Default: 55000 (just under the 60s hard server limit).',
    ),
  restTimeoutMs: z.coerce
    .number()
    .default(10_000)
    .describe('Max time to wait for REST API responses in milliseconds. Default: 10000.'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

/** Returns the lazy-parsed server configuration. */
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    userAgent: 'WIKIDATA_USER_AGENT',
    sparqlTimeoutMs: 'WIKIDATA_SPARQL_TIMEOUT_MS',
    restTimeoutMs: 'WIKIDATA_REST_TIMEOUT_MS',
  });
  return _config;
}
