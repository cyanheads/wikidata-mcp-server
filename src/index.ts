#!/usr/bin/env node
/**
 * @fileoverview wikidata-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { wikidataEntityResource } from './mcp-server/resources/definitions/entity.resource.js';
import { wikidataGetEntity } from './mcp-server/tools/definitions/get-entity.tool.js';
import { wikidataGetLabels } from './mcp-server/tools/definitions/get-labels.tool.js';
import { wikidataGetSitelinks } from './mcp-server/tools/definitions/get-sitelinks.tool.js';
import { wikidataGetStatements } from './mcp-server/tools/definitions/get-statements.tool.js';
import { wikidataResolveExternalId } from './mcp-server/tools/definitions/resolve-external-id.tool.js';
import { wikidataSearchEntities } from './mcp-server/tools/definitions/search-entities.tool.js';
import { wikidataSparqlQuery } from './mcp-server/tools/definitions/sparql-query.tool.js';
import { initWikidataRestService } from './services/wikidata/wikidata-rest-service.js';
import { initWikidataSparqlService } from './services/wikidata/wikidata-sparql-service.js';

await createApp({
  name: 'wikidata-mcp-server',
  title: 'wikidata-mcp-server',
  tools: [
    wikidataSearchEntities,
    wikidataGetEntity,
    wikidataGetLabels,
    wikidataGetStatements,
    wikidataGetSitelinks,
    wikidataSparqlQuery,
    wikidataResolveExternalId,
  ],
  resources: [wikidataEntityResource],
  prompts: [],
  // Public hosted-catalog server — serve full inventory to unauthenticated callers
  // even when MCP_AUTH_MODE is jwt/oauth (0.9.13: default flipped to require auth).
  landing: { requireAuth: false },
  setup(core) {
    initWikidataRestService(core.config, core.storage);
    initWikidataSparqlService(core.config, core.storage);
  },
});
