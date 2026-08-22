/**
 * @fileoverview Tests for WikidataSparqlService — the label-SERVICE injection and prefix
 * prepending that `prepareQuery()` performs on every query.
 *
 * Driven through the public `query()` with global `fetch` mocked, and asserted against the
 * query text actually sent upstream. `prepareQuery()` is private, and the tool-level test
 * mocks this service wholesale, so the rewriter had no coverage at all: neither the
 * solution-modifier handling nor the trailing-VALUES case was pinned by a test.
 * @module tests/services/wikidata-sparql-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WikidataSparqlService } from '@/services/wikidata/wikidata-sparql-service.js';

const mockFetch = vi.fn();

const makeService = () => new WikidataSparqlService({} as AppConfig, {} as StorageService);

/** An empty but well-formed SPARQL 1.1 JSON result — enough for query() to resolve. */
const emptyResults = () =>
  new Response(JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }), {
    status: 200,
    headers: { 'Content-Type': 'application/sparql-results+json' },
  });

/** The query text actually POSTed upstream — what prepareQuery() produced. */
const sentQuery = (call = 0): string => {
  const init = mockFetch.mock.calls[call]?.[1] as { body?: URLSearchParams } | undefined;
  return init?.body?.get('query') ?? '';
};

/** Runs a query through the service and returns the prepared text sent upstream. */
const prepare = async (rawQuery: string, language = 'en'): Promise<string> => {
  await makeService().query(rawQuery, language, 5_000, createMockContext());
  return sentQuery();
};

const LABEL_SERVICE = 'SERVICE wikibase:label';

describe('WikidataSparqlService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch.mockImplementation(() => emptyResults());
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('prepareQuery — label SERVICE injection', () => {
    it('injects the SERVICE inside the WHERE block for a query with no trailing clause', async () => {
      const query = await prepare('SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q5 . }');

      expect(query).toContain(`${LABEL_SERVICE} { bd:serviceParam wikibase:language "en" }`);
      // The SERVICE lands before the block's closing brace, not after it.
      expect(query.indexOf(LABEL_SERVICE)).toBeLessThan(query.lastIndexOf('}'));
    });

    it('uses the requested language in the SERVICE snippet', async () => {
      const query = await prepare('SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q5 . }', 'de');

      expect(query).toContain('bd:serviceParam wikibase:language "de"');
    });

    it('leaves a query that already declares the SERVICE untouched', async () => {
      const raw =
        'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q5 . SERVICE wikibase:label { bd:serviceParam wikibase:language "fr" } }';
      const query = await prepare(raw, 'en');

      // Exactly one SERVICE, still the caller's own language.
      expect(query.match(/SERVICE\s+wikibase:label/gi)).toHaveLength(1);
      expect(query).toContain('"fr"');
      expect(query).not.toContain('"en"');
    });

    it('skips injection when no language is requested', async () => {
      const query = await prepare('SELECT ?item WHERE { ?item wdt:P31 wd:Q5 . }', '');

      expect(query).not.toContain(LABEL_SERVICE);
    });

    /**
     * #6: a trailing solution modifier must be re-attached after the WHERE block, not have
     * the SERVICE injected past it. Each keyword is its own alternation branch in the
     * rewriter, so each gets its own case.
     */
    describe('trailing solution modifiers (#6)', () => {
      it.each([
        ['LIMIT', 'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q5 . } LIMIT 10'],
        ['OFFSET', 'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q5 . } OFFSET 5'],
        ['ORDER BY', 'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q5 . } ORDER BY ?item'],
        [
          'GROUP BY',
          'SELECT ?item (COUNT(?x) AS ?c) WHERE { ?item wdt:P31 wd:Q5 . ?item ?p ?x . } GROUP BY ?item',
        ],
        [
          'HAVING',
          'SELECT ?item (COUNT(?x) AS ?c) WHERE { ?item wdt:P31 wd:Q5 . ?item ?p ?x . } GROUP BY ?item HAVING (COUNT(?x) > 2)',
        ],
      ])('re-attaches a trailing %s after the SERVICE injection', async (keyword, raw) => {
        const query = await prepare(raw);

        expect(query).toContain(LABEL_SERVICE);
        // The modifier survives, and stays outside the WHERE block — after the SERVICE.
        expect(query).toContain(keyword);
        expect(query.indexOf(LABEL_SERVICE)).toBeLessThan(query.indexOf(keyword));
      });

      it('re-attaches a multi-modifier tail as one unit', async () => {
        const query = await prepare(
          'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q5 . } ORDER BY ?item LIMIT 10 OFFSET 5',
        );

        expect(query).toContain('ORDER BY ?item LIMIT 10 OFFSET 5');
        expect(query.indexOf(LABEL_SERVICE)).toBeLessThan(query.indexOf('ORDER BY'));
      });
    });

    /**
     * #20: `ValuesClause` is a distinct grammar production that may follow the solution
     * modifiers, and a trailing `VALUES` block ends the query with a brace of its own.
     * Before the fix the rewriter matched that brace and dropped the SERVICE inside the
     * VALUES data block — which accepts only constant terms — producing a parse error.
     */
    describe('trailing VALUES clause (#20)', () => {
      it('injects before the WHERE brace, not into a trailing VALUES data block', async () => {
        const query = await prepare(
          'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 ?type . } VALUES ?type { wd:Q11344 }',
        );

        expect(query).toContain(LABEL_SERVICE);
        // The defect: SERVICE landed *after* VALUES, inside its data block.
        expect(query.indexOf(LABEL_SERVICE)).toBeLessThan(query.indexOf('VALUES'));
        // The VALUES clause itself survives intact.
        expect(query).toContain('VALUES ?type { wd:Q11344 }');
      });

      it('handles a VALUES clause that follows a solution modifier', async () => {
        const query = await prepare(
          'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 ?type . } LIMIT 5 VALUES ?type { wd:Q11344 }',
        );

        expect(query.indexOf(LABEL_SERVICE)).toBeLessThan(query.indexOf('LIMIT'));
        expect(query).toContain('LIMIT 5 VALUES ?type { wd:Q11344 }');
      });

      it('handles a multi-variable VALUES data block', async () => {
        const query = await prepare(
          'SELECT ?a ?aLabel WHERE { ?a wdt:P31 ?b . } VALUES (?a ?b) { (wd:Q1 wd:Q2) }',
        );

        expect(query.indexOf(LABEL_SERVICE)).toBeLessThan(query.indexOf('VALUES'));
        expect(query).toContain('VALUES (?a ?b) { (wd:Q1 wd:Q2) }');
      });

      /**
       * The far more common placement, and the one the fix must not regress: a VALUES block
       * *inside* the WHERE clause. Its brace is followed by neither a keyword nor the end of
       * the query, so the match must skip past it to the WHERE block's own brace.
       */
      it('does not regress a VALUES clause inside the WHERE block', async () => {
        const query = await prepare(
          'SELECT ?item ?itemLabel WHERE { VALUES ?type { wd:Q11344 } ?item wdt:P31 ?type . } LIMIT 3',
        );

        expect(query).toContain('VALUES ?type { wd:Q11344 }');
        // SERVICE goes after the in-block VALUES and before the trailing modifier.
        expect(query.indexOf('VALUES')).toBeLessThan(query.indexOf(LABEL_SERVICE));
        expect(query.indexOf(LABEL_SERVICE)).toBeLessThan(query.indexOf('LIMIT'));
      });

      it('injects at the WHERE brace when a nested graph block precedes a trailing VALUES', async () => {
        const query = await prepare(
          'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 ?type . { ?item wdt:P17 wd:Q30 } } VALUES ?type { wd:Q11344 }',
        );

        // Past the nested block's brace, before the trailing VALUES.
        expect(query.indexOf('wd:Q30')).toBeLessThan(query.indexOf(LABEL_SERVICE));
        expect(query.indexOf(LABEL_SERVICE)).toBeLessThan(query.indexOf('VALUES'));
        expect(query).toContain('VALUES ?type { wd:Q11344 }');
      });

      it('is case-insensitive on the VALUES keyword', async () => {
        const query = await prepare(
          'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 ?type . } values ?type { wd:Q11344 }',
        );

        expect(query.indexOf(LABEL_SERVICE)).toBeLessThan(query.indexOf('values'));
        expect(query).toContain('values ?type { wd:Q11344 }');
      });
    });
  });

  describe('prepareQuery — prefix prepending', () => {
    it('prepends the standard prefixes', async () => {
      const query = await prepare('SELECT ?item WHERE { ?item wdt:P31 wd:Q5 . }', '');

      expect(query).toContain('PREFIX wd: <http://www.wikidata.org/entity/>');
      expect(query).toContain('PREFIX wdt: <http://www.wikidata.org/prop/direct/>');
      expect(query).toContain('PREFIX wikibase: <http://wikiba.se/ontology#>');
    });

    it('does not redeclare a prefix the caller already supplied', async () => {
      const query = await prepare(
        'PREFIX wd: <http://example.org/custom/>\nSELECT ?item WHERE { ?item wdt:P31 wd:Q5 . }',
        '',
      );

      expect(query.match(/PREFIX wd:/g)).toHaveLength(1);
      expect(query).toContain('PREFIX wd: <http://example.org/custom/>');
    });
  });

  describe('query — upstream failures', () => {
    it('surfaces a 400 as a parse error carrying the Blazegraph cause', async () => {
      mockFetch.mockImplementation(
        () =>
          new Response(
            'org.openrdf.query.MalformedQueryException: Encountered " "service" "SERVICE ""',
            { status: 400 },
          ),
      );

      await expect(
        makeService().query('SELECT ?x WHERE { ?x ?y ?z }', 'en', 5_000, createMockContext()),
      ).rejects.toMatchObject({ data: { reason: 'parse_error' } });
    });

    /** A rate-limit HTML page is a 200 — it must not be parsed as a result set. */
    it('rejects an HTML body rather than parsing it as results', async () => {
      mockFetch.mockImplementation(
        () =>
          new Response('<!DOCTYPE html><html><body>Too many requests</body></html>', {
            status: 200,
          }),
      );

      await expect(
        makeService().query('SELECT ?x WHERE { ?x ?y ?z }', 'en', 5_000, createMockContext()),
      ).rejects.toThrow(/HTML/);
    });

    it('preserves caller cancellation instead of misclassifying it as a timeout', async () => {
      mockFetch.mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () =>
                setTimeout(
                  () => reject(new DOMException('Request cancelled by caller.', 'AbortError')),
                  20,
                ),
              { once: true },
            );
          }),
      );

      const caller = new AbortController();
      const pending = makeService().query(
        'SELECT ?x WHERE { ?x ?y ?z }',
        'en',
        10,
        createMockContext({ signal: caller.signal }),
      );
      caller.abort();

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});
