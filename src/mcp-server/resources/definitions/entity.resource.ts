/**
 * @fileoverview Wikidata entity resource — compact entity summary by QID or PID.
 * @module mcp-server/resources/definitions/entity.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  getWikidataRestService,
  isEntityNotFoundError,
  isPId,
  isQId,
  normalizeId,
  resolveLangValue,
} from '@/services/wikidata/wikidata-rest-service.js';

export const wikidataEntityResource = resource('wikidata://entity/{id}', {
  name: 'wikidata-entity',
  description:
    'Wikidata entity by QID or PID — labels (all languages), English description, ' +
    'and a summary of key properties (instance-of P31, image P18, enwiki sitelink). ' +
    'Formatted as compact markdown. For full entity data, use the wikidata_get_entity tool.',
  mimeType: 'text/markdown',
  params: z.object({
    id: z.string().describe('Q-ID (e.g., "Q76") or P-ID (e.g., "P31") of the entity.'),
  }),

  async handler(params, ctx) {
    const id = normalizeId(params.id);

    if (!isQId(id) && !isPId(id)) {
      throw validationError(
        `"${params.id}" is not a valid Wikidata ID. Expected Q+digits (e.g., Q76) or P+digits (e.g., P31).`,
        { id: params.id },
      );
    }

    const svc = getWikidataRestService();
    ctx.log.info('Fetching entity resource', { id });

    let entity: Awaited<ReturnType<typeof svc.fetchEntity>>;
    try {
      entity = await svc.fetchEntity(id, ctx);
    } catch (err) {
      if (isEntityNotFoundError(err)) {
        throw notFound(`No Wikidata entity found for ID "${id}".`, { id }, { cause: err as Error });
      }
      throw err;
    }

    const lines: string[] = [];

    // Header: ID + English label, falling back to the entity's multilingual ("mul") label —
    // items like Q76 carry only a mul label and would otherwise render as a bare QID.
    const enLabel = resolveLangValue(entity.labels, 'en');
    lines.push(`# ${enLabel ? `${enLabel} (${id})` : id}`);

    // English description
    const enDesc = resolveLangValue(entity.descriptions, 'en');
    if (enDesc) lines.push(`*${enDesc}*`);

    lines.push('');

    // Type/data_type
    if (entity.type === 'property' && entity.data_type) {
      lines.push(`**Type:** Property | **Data type:** ${entity.data_type}`);
    } else {
      lines.push(`**Type:** ${entity.type}`);
    }

    // Instance of (P31)
    const instanceOf = entity.statements?.P31;
    if (instanceOf?.length) {
      const values = instanceOf
        .slice(0, 3)
        .map((stmt) => {
          const content = stmt.value?.content;
          return (typeof content === 'string' ? content : (content as { id?: string })?.id) ?? '?';
        })
        .join(', ');
      lines.push(`**Instance of:** ${values} *(resolve with wikidata_get_labels)*`);
    }

    // Wikipedia link (enwiki sitelink)
    const enwiki = entity.sitelinks?.enwiki;
    if (enwiki?.url) {
      lines.push(`**Wikipedia:** [${enwiki.title}](${enwiki.url})`);
    } else if (enwiki?.title) {
      lines.push(`**Wikipedia:** ${enwiki.title}`);
    }

    // Image (P18)
    const images = entity.statements?.P18;
    if (images?.length) {
      const firstImage = images[0];
      const imgContent = firstImage?.value?.content;
      if (typeof imgContent === 'string' && imgContent) {
        lines.push(`**Image:** ${imgContent}`);
      }
    }

    // Labels summary
    const labelCount = entity.labels ? Object.keys(entity.labels).length : 0;
    if (labelCount > 0) {
      lines.push('');
      lines.push(`**Labels available:** ${labelCount} languages`);
      const sample = Object.entries(entity.labels ?? {})
        .slice(0, 5)
        .map(([lang, lb]) => `${lang}: ${lb}`)
        .join(' | ');
      if (sample) lines.push(sample);
    }

    // Statement count
    const propCount = entity.statements ? Object.keys(entity.statements).length : 0;
    if (propCount > 0) {
      lines.push(`**Statements:** ${propCount} properties`);
    }

    lines.push('');
    lines.push(`**Wikidata URL:** https://www.wikidata.org/wiki/${id}`);

    return lines.join('\n');
  },

  list: () => ({
    resources: [
      {
        uri: 'wikidata://entity/Q76',
        name: 'Barack Obama (Q76)',
        description: 'Example: Wikidata entity for Barack Obama',
        mimeType: 'text/markdown',
      },
      {
        uri: 'wikidata://entity/Q42',
        name: 'Douglas Adams (Q42)',
        description: 'Example: Wikidata entity for Douglas Adams',
        mimeType: 'text/markdown',
      },
      {
        uri: 'wikidata://entity/P31',
        name: 'instance of (P31)',
        description: 'Example: Wikidata property "instance of"',
        mimeType: 'text/markdown',
      },
    ],
  }),
});
