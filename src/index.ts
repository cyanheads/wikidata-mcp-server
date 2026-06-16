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
  instructions:
    'Use the wikidata_* tools to query the Wikidata knowledge graph (REST API + Query Service). No API key required. ' +
    'Items are addressed by Q-IDs (e.g. Q76), properties by P-IDs (e.g. P31). IDs are not names — resolve a name to an ID with ' +
    'wikidata_search_entities first, then fetch with wikidata_get_entity, wikidata_get_statements, or wikidata_get_sitelinks. ' +
    'Use wikidata_resolve_external_id to enter the graph from a DOI, PMID, ORCID, or OpenAlex ID. ' +
    'wikidata_sparql_query is the escape hatch for graph traversals and aggregations the curated tools cannot express (SELECT only, rate-limited); ' +
    'pair it with wikidata_get_labels to humanize the QIDs it returns.',
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
