/**
 * @fileoverview CommonMark fidelity for untrusted Wikidata values on the text surface.
 * @module tests/tools/markdown-safety.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { wikidataGetEntity } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { wikidataGetLabels } from '@/mcp-server/tools/definitions/get-labels.tool.js';
import { wikidataGetSitelinks } from '@/mcp-server/tools/definitions/get-sitelinks.tool.js';
import { wikidataGetStatements } from '@/mcp-server/tools/definitions/get-statements.tool.js';
import { wikidataResolveExternalId } from '@/mcp-server/tools/definitions/resolve-external-id.tool.js';
import { wikidataSearchEntities } from '@/mcp-server/tools/definitions/search-entities.tool.js';
import { wikidataSparqlQuery } from '@/mcp-server/tools/definitions/sparql-query.tool.js';

const parser = new MarkdownIt('commonmark').enable('table');
const hostile = 'A*p* [x](javascript:alert) <b>tag</b> `code` &copy; | _edge_';
const multiline = `${hostile}\n# injected heading\n- injected list`;
const url = 'https://example.org/a_(b)?x=1&y=2';

function tokensText(tokens: ReturnType<typeof parser.parse>): string {
  return tokens
    .map((token) =>
      token.children
        ? tokensText(token.children)
        : token.type === 'hardbreak' || token.type === 'softbreak'
          ? '\n'
          : token.content,
    )
    .join('');
}

function parsed(blocks: Array<{ type: string; text?: string }>) {
  const tokens = parser.parse(blocks.map((block) => block.text ?? '').join('\n'), {});
  const inline = tokens.flatMap((token) => token.children ?? []);
  return { tokens, inline, text: tokensText(tokens) };
}

describe('Markdown data fidelity', () => {
  it('preserves search labels and descriptions without injecting blocks', () => {
    const result = parsed(
      wikidataSearchEntities.format!({
        results: [
          {
            id: 'Q1',
            label: multiline,
            description: multiline,
            match: { type: 'label', language: 'en' },
          },
        ],
      }),
    );
    expect(result.text).toContain(multiline);
    expect(result.inline.some((token) => token.type === 'html_inline')).toBe(false);
    expect(result.tokens.filter((token) => token.type === 'heading_open')).toHaveLength(1);
  });

  it('preserves multilingual labels, descriptions and aliases', () => {
    const entity = parsed(
      wikidataGetEntity.format!({
        id: 'Q1',
        type: 'item',
        kind: 'full',
        fieldsReturned: ['labels', 'descriptions', 'aliases'],
        labels: { en: multiline },
        descriptions: { en: multiline },
        aliases: { en: [multiline] },
      }),
    );
    const labels = parsed(
      wikidataGetLabels.format!({
        entities: { Q1: { labels: { en: multiline }, descriptions: { en: multiline } } },
        found: 1,
        notFound: [],
        languages: ['en'],
      }),
    );
    expect(entity.text).toContain(multiline);
    expect(labels.text).toContain(multiline);
  });

  it('preserves a sitelink title and destination and refuses non-HTTP links', () => {
    const result = parsed(
      wikidataGetSitelinks.format!({
        id: 'Q1',
        count: 2,
        sitelinks: {
          enwiki: { title: hostile, url },
          badwiki: { title: hostile, url: 'javascript:alert(1)' },
        },
      }),
    );
    expect(result.text).toContain(hostile);
    expect(
      result.inline
        .filter((token) => token.type === 'link_open')
        .map((token) => token.attrGet('href')),
    ).toEqual([url]);
    expect(result.text).toContain('javascript:alert(1)');
  });

  it('preserves statement values, qualifiers and references', () => {
    const value = { type: 'string', value: multiline };
    const result = parsed(
      wikidataGetStatements.format!({
        id: 'Q1',
        kind: 'full',
        propertyCount: 1,
        statementCount: 1,
        labelsResolved: false,
        statements: {
          P1: [
            {
              id: 'Q1$1',
              property: 'P1',
              rank: 'normal',
              value,
              qualifiers: [{ property: 'P2', value }],
              references: [{ parts: [{ property: 'P3', value }] }],
            },
          ],
        },
      }),
    );
    expect(result.text.split(multiline)).toHaveLength(4);
  });

  it('preserves resolver values and labels', () => {
    const result = parsed(
      wikidataResolveExternalId.format!({
        property: 'P356',
        value: hostile,
        match: { id: 'Q1', label: multiline, description: multiline, url },
      }),
    );
    expect(result.text).toContain(hostile);
    expect(result.text).toContain(multiline);
    expect(
      result.inline
        .filter((token) => token.type === 'link_open')
        .map((token) => token.attrGet('href')),
    ).toEqual([url]);
  });

  it('preserves entity sitelink labels and destinations', () => {
    const result = parsed(
      wikidataGetEntity.format!({
        id: 'Q1',
        type: 'item',
        kind: 'full',
        fieldsReturned: ['sitelinks'],
        sitelinks: { enwiki: { title: hostile, url } },
      }),
    );
    expect(result.text).toContain(hostile);
    expect(
      result.inline
        .filter((token) => token.type === 'link_open')
        .map((token) => token.attrGet('href')),
    ).toEqual([url]);
  });

  it('preserves error messages and recovery on both surfaces through the framework', async () => {
    const result = await runToolContract(wikidataGetEntity, { id: hostile });
    const error = (
      result.structuredContent as {
        error: {
          code: number;
          message: string;
          data: { reason: string; recovery: { hint: string } };
        };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('invalid_id');
    expect(error.message).toBe(
      `"${hostile}" is not a valid Wikidata ID. Expected Q+digits (item) or P+digits (property).`,
    );
    const displayed = parsed(result.content).text;
    expect(displayed).toContain(error.message);
    expect(displayed).toContain(error.data.recovery.hint);
  });

  it('preserves SPARQL cell syntax without interpreting literal markup', () => {
    const result = parsed(
      wikidataSparqlQuery.format!({
        variables: ['value'],
        truncated: false,
        results: [{ value: { type: 'literal', value: hostile } }],
      }),
    );
    expect(result.text).toContain(`"${hostile}"`);
    expect(
      result.inline.some(
        (token) =>
          token.type === 'html_inline' ||
          token.type === 'code_inline' ||
          token.type === 'link_open',
      ),
    ).toBe(false);
    expect(result.tokens.filter((token) => token.type === 'tr_open')).toHaveLength(2);
  });

  it('keeps full HTTP URI cells clickable with their typed text and intact table columns', () => {
    const uri = 'https://example.org/a_(b)?x=a|b&y=2';
    const result = parsed(
      wikidataSparqlQuery.format!({
        variables: ['uri', 'literal', 'compact', 'other'],
        truncated: false,
        results: [
          {
            uri: { type: 'uri', value: uri },
            literal: { type: 'literal', value: uri },
            compact: { type: 'uri', value: 'http://www.wikidata.org/entity/Q76' },
            other: { type: 'uri', value: 'urn:example:a|b' },
          },
        ],
      }),
    );
    expect(
      result.inline
        .filter((token) => token.type === 'link_open')
        .map((token) => token.attrGet('href')),
    ).toEqual(['https://example.org/a_(b)?x=a%7Cb&y=2']);
    const cells = result.tokens
      .filter((token) => token.type === 'inline')
      .slice(5)
      .map((token) => tokensText(token.children ?? []));
    expect(cells).toEqual([`<${uri}>`, `"${uri}"`, 'wd:Q76', '<urn:example:a|b>']);
    expect(result.tokens.filter((token) => token.type === 'tr_open')).toHaveLength(2);
    expect(result.tokens.filter((token) => token.type === 'td_open')).toHaveLength(4);
  });
});
