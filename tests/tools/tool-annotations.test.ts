/**
 * @fileoverview Annotation contract across every registered tool definition.
 * @module tests/tools/tool-annotations.test
 */

import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { wikidataGetEntity } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { wikidataGetLabels } from '@/mcp-server/tools/definitions/get-labels.tool.js';
import { wikidataGetSitelinks } from '@/mcp-server/tools/definitions/get-sitelinks.tool.js';
import { wikidataGetStatements } from '@/mcp-server/tools/definitions/get-statements.tool.js';
import { wikidataResolveExternalId } from '@/mcp-server/tools/definitions/resolve-external-id.tool.js';
import { wikidataSearchEntities } from '@/mcp-server/tools/definitions/search-entities.tool.js';
import { wikidataSparqlQuery } from '@/mcp-server/tools/definitions/sparql-query.tool.js';

const definitions = [
  wikidataSearchEntities,
  wikidataGetEntity,
  wikidataGetLabels,
  wikidataGetStatements,
  wikidataGetSitelinks,
  wikidataSparqlQuery,
  wikidataResolveExternalId,
];

describe('tool annotations', () => {
  it('covers every tool definition file, by its registered name', () => {
    const files = readdirSync(new URL('../../src/mcp-server/tools/definitions/', import.meta.url))
      .filter((file) => file.endsWith('.tool.ts'))
      .map((file) => `wikidata_${file.replace('.tool.ts', '').replaceAll('-', '_')}`)
      .sort();

    expect(definitions.map((def) => def.name).sort()).toEqual(files);
    expect(files).toEqual([
      'wikidata_get_entity',
      'wikidata_get_labels',
      'wikidata_get_sitelinks',
      'wikidata_get_statements',
      'wikidata_resolve_external_id',
      'wikidata_search_entities',
      'wikidata_sparql_query',
    ]);
  });

  // Every tool reads live Wikidata data (REST API, wbgetentities, or the Query Service).
  it.each(definitions.map((def) => [def.name, def] as const))(
    '%s is read-only and open-world',
    (_name, def) => {
      expect(def.annotations?.readOnlyHint).toBe(true);
      expect(def.annotations?.openWorldHint).toBe(true);
    },
  );
});
