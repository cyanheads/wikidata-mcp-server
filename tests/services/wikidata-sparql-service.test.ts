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
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SparqlResultsScanner } from '@/services/wikidata/sparql-results-scanner.js';
import {
  prepareQuery,
  toCallerPosition,
  WikidataSparqlService,
} from '@/services/wikidata/wikidata-sparql-service.js';
import { expectBoundedScan } from '../helpers/scan-cost.js';

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

      // The SERVICE lands before the block's closing brace, not after it.
      expect(
        query.endsWith(
          `wd:Q5 . OPTIONAL { ${LABEL_SERVICE} { bd:serviceParam wikibase:language "en,mul" } } }`,
        ),
      ).toBe(true);
    });

    /**
     * The SERVICE uses the requested language. #41: the Query Service label SERVICE does not fall
     * back to multilingual (`mul`) labels by itself, so an item named only in `mul` came back as
     * its bare QID.
     */
    it.each([
      ['en', 'en,mul'],
      ['de', 'de,mul'],
      ['fr,en', 'fr,en,mul'],
      ['mul', 'mul'],
      ['mul,en', 'mul,en'],
      ['fr,mul,en', 'fr,mul,en'],
    ])('ends the SERVICE language list %j in mul as %j', async (language, expected) => {
      const query = await prepare(
        'SELECT ?item ?itemLabel WHERE { VALUES ?item { wd:Q42 } }',
        language,
      );

      expect(query).toContain(`bd:serviceParam wikibase:language "${expected}" }`);
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

    it.each([
      ['a full IRI', 'SERVICE <http://wikiba.se/ontology#label>'],
      ['another prefix bound to the ontology', 'SERVICE wb:label'],
    ])('leaves a query whose own label SERVICE is spelled as %s untouched', async (_, service) => {
      const raw = `PREFIX wb: <http://wikiba.se/ontology#>\nSELECT ?item ?itemLabel WHERE { VALUES ?item { wd:Q90 } ${service} { bd:serviceParam wikibase:language "de" } }`;
      const query = await prepare(raw, 'en');

      expect(query).not.toContain('"en,mul"');
      // Sent as written: no second SERVICE spliced before the WHERE brace.
      expect(query.endsWith(raw)).toBe(true);
    });

    /**
     * #36: the SERVICE is injected only when the query asks for a label, description, or
     * alias — there is no off switch, so a query with no such variable must go out bare.
     */
    describe('label-variable detection (#36)', () => {
      it.each([
        ['?itemLabel', 'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q5 . }'],
        ['$itemLabel', 'SELECT $item $itemLabel WHERE { $item wdt:P31 wd:Q5 . }'],
        ['?itemDescription', 'SELECT ?item ?itemDescription WHERE { ?item wdt:P31 wd:Q5 . }'],
        ['?itemAltLabel', 'SELECT ?item ?itemAltLabel WHERE { ?item wdt:P31 wd:Q5 . }'],
        [
          'a label variable used only in ORDER BY',
          'SELECT ?item WHERE { ?item wdt:P31 wd:Q5 . } ORDER BY ?itemLabel',
        ],
        ['a non-ASCII base name', 'SELECT ?città ?cittàLabel WHERE { ?città wdt:P31 wd:Q515 . }'],
      ])('injects for %s', async (_name, raw) => {
        expect(await prepare(raw)).toContain(LABEL_SERVICE);
      });

      it.each([
        ['no label variable', 'SELECT ?item WHERE { ?item wdt:P31 wd:Q5 . } LIMIT 3'],
        ['a bare ?Label with no base name', 'SELECT ?Label WHERE { ?Label wdt:P31 wd:Q5 . }'],
        [
          'a variable that only contains Label',
          'SELECT ?itemLabels WHERE { ?itemLabels wdt:P31 wd:Q5 . }',
        ],
        ['a lowercase label suffix', 'SELECT ?itemlabel WHERE { ?itemlabel wdt:P31 wd:Q5 . }'],
        ['Label text outside a variable', 'SELECT ?item WHERE { ?item rdfs:label "itemLabel" . }'],
      ])('sends a query with %s without a SERVICE', async (_name, raw) => {
        const query = await prepare(raw);

        expect(query).not.toContain(LABEL_SERVICE);
        // Nothing else is rewritten: the caller's text follows the prefixes verbatim.
        expect(query.endsWith(raw)).toBe(true);
      });
    });

    it('skips injection when no language is requested', async () => {
      const query = await prepare('SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q5 . }', '');

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
          'SELECT ?item ?itemLabel (COUNT(?x) AS ?c) WHERE { ?item wdt:P31 wd:Q5 . ?item ?p ?x . } GROUP BY ?item ?itemLabel',
        ],
        [
          'HAVING',
          'SELECT ?item ?itemLabel (COUNT(?x) AS ?c) WHERE { ?item wdt:P31 wd:Q5 . ?item ?p ?x . } GROUP BY ?item ?itemLabel HAVING (COUNT(?x) > 2)',
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

  /**
   * The SERVICE belongs at the end of the top-level WHERE group. A sub-SELECT's own solution
   * modifiers, a trailing comment, and braces inside literals, IRIs, comments, or a projection
   * expression must not move it — inside a sub-SELECT it binds labels the outer query never sees.
   */
  describe('prepareQuery — WHERE-group placement', () => {
    const SNIPPET =
      'OPTIONAL { SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul" } } ';

    /** Each template marks with `^` where the SERVICE must land; the caller sends it without. */
    it.each([
      [
        'a sub-SELECT with its own LIMIT',
        'SELECT ?item ?itemLabel WHERE { { SELECT ?item WHERE { ?item wdt:P31 wd:Q146 } LIMIT 2 } ^}',
      ],
      [
        'a sub-SELECT with GROUP BY and ORDER BY',
        'SELECT ?item ?itemLabel ?n WHERE { { SELECT ?item (COUNT(?x) AS ?n) WHERE { ?item wdt:P31 ?x } GROUP BY ?item ORDER BY DESC(?n) } ^} LIMIT 5',
      ],
      [
        'a trailing comment after the WHERE group',
        'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q146 ^}\n# cats } LIMIT 1',
      ],
      [
        'braces inside a string literal',
        'SELECT ?item ?itemLabel WHERE { ?item rdfs:label "} LIMIT 1"@en ^} LIMIT 1',
      ],
      [
        'braces and an escaped quote inside a long string literal',
        "SELECT ?item ?itemLabel WHERE { ?item rdfs:label '''a }\\''' }\n} LIMIT 1''' ^} LIMIT 1",
      ],
      [
        'a # inside an IRI and a commented-out brace',
        'SELECT ?item ?itemLabel WHERE { ?item <http://wikiba.se/ontology#x> ?y ^} # } LIMIT 1',
      ],
      [
        'a comparison that looks like an IRI opener',
        'SELECT ?item ?itemLabel WHERE { ?item wdt:P1082 ?n FILTER(?n < 5 && ?n > 1) ^} LIMIT 3',
      ],
      [
        'an EXISTS group inside the projection',
        'SELECT ?item ?itemLabel (EXISTS { ?item wdt:P18 ?i } AS ?pic) WHERE { ?item wdt:P31 wd:Q146 ^} LIMIT 3',
      ],
      [
        'a trailing VALUES block after a sub-SELECT with LIMIT',
        'SELECT ?item ?itemLabel WHERE { { SELECT ?item WHERE { ?item wdt:P31 ?t } LIMIT 2 } ^} VALUES ?t { wd:Q146 }',
      ],
    ])('splices before the top-level WHERE brace with %s', (_name, template) => {
      const raw = template.replace('^', '');

      expect(prepareQuery(raw, 'en').text.endsWith(template.replace('^', SNIPPET))).toBe(true);
    });

    it.each([
      [
        'an unterminated string literal',
        'SELECT ?item ?itemLabel WHERE { ?item rdfs:label "open }',
      ],
      [
        'an unbalanced WHERE group',
        'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q146 . LIMIT 3',
      ],
    ])('sends a query with %s as written', (_name, raw) => {
      const prepared = prepareQuery(raw, 'en');

      expect(prepared.text.endsWith(raw)).toBe(true);
      expect(prepared.splice).toBeUndefined();
    });

    /**
     * A caller that binds its own `?xLabel` (`?x rdfs:label ?xLabel`, `BIND(… AS ?xLabel)`) must
     * keep its rows. A plain SERVICE joins on the bound variable, and when the planner runs it
     * first (a single-valued `VALUES`, live on WDQS) it drops every row whose label differs from
     * the one the SERVICE picks. An OPTIONAL left-joins instead: the caller's rows survive, and
     * an unbound label variable still binds.
     */
    it('wraps the injected SERVICE in OPTIONAL', () => {
      const { text } = prepareQuery(
        'SELECT ?item ?itemLabel WHERE { VALUES ?item { wd:Q42 } ?item rdfs:label ?itemLabel }',
        'en',
      );

      expect(text.endsWith(`?item rdfs:label ?itemLabel ${SNIPPET}}`)).toBe(true);
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

  /**
   * #34: Blazegraph reports a parse error's position in the text it received — counting the
   * PREFIX lines the service prepends and the label SERVICE it splices in. The service maps the
   * position back to the caller's text.
   *
   * The mock plays Blazegraph: it finds the marker token in the query it was sent and reports
   * that token's position the way Blazegraph counts — CRLF or a lone CR ends a line, a tab is
   * one column — so each case exercises the injection actually performed.
   */
  describe('query — parse-error positions (#34)', () => {
    /** 1-based line and column of `index` in `text`, counted the way Blazegraph counts. */
    const positionIn = (text: string, index: number) => {
      const lines = text.slice(0, index).split(/\r\n|\r|\n/);
      return { line: lines.length, column: (lines.at(-1) as string).length + 1 };
    };

    const parseErrorAt = (
      marker: string,
      template = (pos: string) => `Encountered " "x" "x "" at ${pos}.`,
    ) =>
      mockFetch.mockImplementation((_url: string, init?: { body?: URLSearchParams }) => {
        const sent = init?.body?.get('query') ?? '';
        const index = sent.indexOf(marker);
        expect(index).toBeGreaterThanOrEqual(0);
        const { line, column } = positionIn(sent, index);
        const cause = template(`line ${line}, column ${column}`);
        return Promise.resolve(
          new Response(
            `java.util.concurrent.ExecutionException: org.openrdf.query.MalformedQueryException: ${cause}\nWas expecting one of:\n    "." ...\n\tat com.bigdata.rdf.sail.webapp.QueryServlet.doGet(QueryServlet.java:1)`,
            { status: 400 },
          ),
        );
      });

    const failure = async (raw: string, language = 'en') => {
      const err = (await makeService()
        .query(raw, language, 5_000, createMockContext())
        .catch((e: unknown) => e)) as { message: string; data: { reason: string; cause: string } };
      expect(err.data.reason).toBe('parse_error');
      return err;
    };

    it('reports the caller position of an error on line 3 (no SERVICE spliced)', async () => {
      parseErrorAt(';; .');
      const err = await failure(
        'SELECT ?item WHERE {\n  ?item wdt:P31 wd:Q5 .\n  ?item wdt:P27 wd:Q30 ;; .\n} LIMIT 1',
      );

      expect(err.message).toBe('SPARQL parse error: Encountered " "x" "x "" at line 3, column 24.');
      expect(err.data.cause).toBe('Encountered " "x" "x "" at line 3, column 24.');
    });

    it('reports line 1, column 44 for an error after the WHERE block (no SERVICE spliced)', async () => {
      parseErrorAt('abc');
      const err = await failure('SELECT ?x WHERE { ?x wdt:P31 wd:Q5 } LIMIT abc');

      expect(err.data.cause).toContain('at line 1, column 44.');
    });

    it('counts only the prefixes it injected when the query declares some itself', async () => {
      parseErrorAt(';;');
      const err = await failure(
        'PREFIX wd: <http://www.wikidata.org/entity/>\nPREFIX wdt: <http://www.wikidata.org/prop/direct/>\nSELECT ?x WHERE {\n  ?x wdt:P31 ;; .\n}',
      );

      expect(err.data.cause).toContain('at line 4, column 14.');
    });

    it('keeps the caller line numbering when the query opens with blank lines', async () => {
      parseErrorAt(';;');
      const err = await failure('\n\nSELECT ?x WHERE { ?x wdt:P31 ;; }');

      expect(err.data.cause).toContain('at line 3, column 30.');
    });

    it('splices the SERVICE inline, with no line break, just before the WHERE brace', async () => {
      const query = await prepare('SELECT ?x ?xLabel WHERE {\n  ?x wdt:P31 wd:Q5 .\n} LIMIT 1');

      expect(
        query.endsWith(
          'SELECT ?x ?xLabel WHERE {\n  ?x wdt:P31 wd:Q5 .\nOPTIONAL { SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul" } } } LIMIT 1',
        ),
      ).toBe(true);
    });

    it.each([
      [
        'an error before the brace on the splice line',
        'SELECT ?x ?xLabel WHERE { ?x wdt:P31 ;; } LIMIT 1',
        ';;',
        'line 1, column 38',
      ],
      [
        'an error after the brace on the splice line',
        'SELECT ?x ?xLabel WHERE { ?x wdt:P31 wd:Q5 } LIMIT abc',
        'abc',
        'line 1, column 52',
      ],
      [
        'an error after the brace on the splice line of a multi-line query',
        'SELECT ?x ?xLabel WHERE {\n  ?x wdt:P31 wd:Q5 .\n} LIMIT abc',
        'abc',
        'line 3, column 9',
      ],
      [
        'an error on a tab-indented splice line',
        'SELECT ?x ?xLabel WHERE {\n\t?x wdt:P31 wd:Q5 .\n\t\t} LIMIT abc',
        'abc',
        'line 3, column 11',
      ],
      [
        'an error on a line before the splice line',
        'SELECT ?x ?xLabel WHERE {\n\t?x wdt:P31 ;; .\n}',
        ';;',
        'line 2, column 13',
      ],
      [
        'an error after the brace in a CRLF query',
        'SELECT ?x ?xLabel WHERE {\r\n  ?x wdt:P31 wd:Q5 .\r\n} LIMIT abc',
        'abc',
        'line 3, column 9',
      ],
      [
        'an error mid-block in a CRLF query',
        'SELECT ?x ?xLabel WHERE {\r\n  ?x wdt:P31 ;; .\r\n}',
        ';;',
        'line 2, column 14',
      ],
      [
        'an error after the brace with a lone-CR line ending',
        'SELECT ?x ?xLabel WHERE {\r  ?x wdt:P31 wd:Q5 .\r} LIMIT abc',
        'abc',
        'line 3, column 9',
      ],
    ])('maps %s to the caller position', async (_name, raw, marker, expected) => {
      parseErrorAt(marker);
      const err = await failure(raw);

      // Bounded by "at" and "." so a wrong number that merely starts with the right digits fails.
      expect(err.data.cause).toContain(`at ${expected}.`);
      expect(err.message).toContain(`at ${expected}.`);
    });

    it('maps a lexical-error position too', async () => {
      parseErrorAt('~', (pos) => `Lexical error at ${pos}.  Encountered: "~" (126), after : ""`);
      const err = await failure('SELECT ?x ?xLabel WHERE { ?x wdt:P31 wd:Q5 } LIMIT 1 ~');

      expect(err.data.cause).toBe(
        'Lexical error at line 1, column 54.  Encountered: "~" (126), after : ""',
      );
    });

    it('passes a message with no position through unchanged', async () => {
      mockFetch.mockImplementation(
        () =>
          new Response(
            "org.openrdf.query.MalformedQueryException: Multiple prefix declarations for prefix 'wd'",
            {
              status: 400,
            },
          ),
      );
      const err = await failure('SELECT ?x ?xLabel WHERE { ?x wdt:P31 wd:Q5 }');

      expect(err.data.cause).toBe("Multiple prefix declarations for prefix 'wd'");
      expect(err.message).toBe("SPARQL parse error: Multiple prefix declarations for prefix 'wd'");
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

    /** fetch rejects with a TypeError when the endpoint cannot be reached. */
    it('reports a network failure as ServiceUnavailable, not a raw TypeError', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      await expect(
        makeService().query('SELECT ?x WHERE { ?x ?y ?z }', 'en', 5_000, createMockContext()),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    });

    it('reports a connection lost mid-body as ServiceUnavailable, not a raw TypeError', async () => {
      mockFetch.mockImplementation(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('{"head":{"vars":["i"]},"results":{"bindings":['),
                );
              },
              pull(controller) {
                controller.error(new TypeError('terminated'));
              },
            }),
            { status: 200 },
          ),
      );

      await expect(
        makeService().query('SELECT ?x WHERE { ?x ?y ?z }', 'en', 5_000, createMockContext()),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
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

  describe('query — request and response', () => {
    it('POSTs the prepared query as a form body to the main Query Service endpoint', async () => {
      await makeService().query(
        'SELECT ?x WHERE { ?x ?p ?o } LIMIT 1',
        'en',
        5_000,
        createMockContext(),
      );

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://query.wikidata.org/sparql');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        Accept: 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(sentQuery()).toContain('SELECT ?x WHERE { ?x ?p ?o } LIMIT 1');
    });

    it('returns the variables and every binding of a well-formed result', async () => {
      const bindings = [
        {
          item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q42' },
          label: { type: 'literal', value: 'Douglas "DNA" Adams {}[]\\', 'xml:lang': 'en' },
        },
        { item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q1' } },
      ];
      mockFetch.mockImplementation(
        () =>
          new Response(
            JSON.stringify({ head: { vars: ['item', 'label'] }, results: { bindings } }, null, 2),
            { status: 200 },
          ),
      );

      const response = await makeService().query(
        'SELECT ?item ?label WHERE { ?item rdfs:label ?label }',
        'en',
        5_000,
        createMockContext(),
      );

      expect(response).toMatchObject({ head: { vars: ['item', 'label'] }, results: { bindings } });
      expect(response.results.bindings).toEqual(bindings);
    });

    it('surfaces a 5xx as ServiceUnavailable naming the status', async () => {
      mockFetch.mockImplementation(() => new Response('upstream down', { status: 503 }));

      await expect(
        makeService().query('SELECT ?x WHERE { ?x ?p ?o }', 'en', 5_000, createMockContext()),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable, data: { status: 503 } });
    });

    describe('throttling', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('retries a 429, honoring Retry-After, then surfaces it as throttled with the hint', async () => {
        mockFetch.mockImplementation(
          () => new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } }),
        );

        const settled = makeService()
          .query('SELECT ?x WHERE { ?x ?p ?o }', 'en', 5_000, createMockContext())
          .catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(4_000);

        expect(await settled).toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: { reason: 'throttled', retryAfter: '1' },
        });
        expect(mockFetch).toHaveBeenCalledTimes(4);
      });
    });
  });

  describe('query — endpoint graph (#49)', () => {
    it.each([
      ['no graph', undefined, 'https://query.wikidata.org/sparql'],
      ['the main graph', { graph: 'main' as const }, 'https://query.wikidata.org/sparql'],
      [
        'the scholarly graph',
        { graph: 'scholarly' as const },
        'https://query-scholarly.wikidata.org/sparql',
      ],
    ])('sends a query for %s to its own endpoint', async (_name, options, url) => {
      await makeService().query(
        'SELECT ?x WHERE { ?x ?p ?o } LIMIT 1',
        'en',
        5_000,
        createMockContext(),
        options,
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]?.[0]).toBe(url);
    });
  });

  /**
   * `timeoutMs` is one deadline for the whole call: every attempt, every backoff, and every
   * throttle retry. Before, each attempt got the full timeout of its own, so retries multiplied it.
   */
  describe('query — one deadline across retries', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Records whether, and how, the call has settled. */
    const track = (pending: Promise<unknown>) => {
      const state = { settled: false, error: undefined as unknown };
      pending.then(
        () => {
          state.settled = true;
        },
        (err: unknown) => {
          state.settled = true;
          state.error = err;
        },
      );
      return state;
    };

    /** Advances fake time by `ms`, then lets the rejection chain run out. */
    const advance = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    /** A fetch that answers only by rejecting with the request signal's reason, as fetch does. */
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });

    it('settles a call throttled on every attempt inside its deadline, as throttled', async () => {
      mockFetch.mockImplementation(() => new Response('slow down', { status: 429 }));

      const state = track(
        makeService().query('SELECT ?x WHERE { ?x ?p ?o }', 'en', 5_000, createMockContext()),
      );
      await advance(5_000);

      expect(state.settled).toBe(true);
      expect(state.error).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'throttled' },
      });
    });

    it('stops an attempt that follows a throttle at the call deadline, as timeout', async () => {
      mockFetch
        .mockImplementationOnce(() => new Response('slow down', { status: 429 }))
        .mockImplementation(hang);

      const state = track(
        makeService().query('SELECT ?x WHERE { ?x ?p ?o }', 'en', 5_000, createMockContext()),
      );
      await advance(4_999);
      expect(state.settled).toBe(false);
      await advance(1);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(state.settled).toBe(true);
      expect(state.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'timeout' },
      });
      expect((state.error as Error).message).toContain('5s');
      // The guidance fits a query that already carries a LIMIT.
      expect((state.error as Error).message).toContain('Narrow the WHERE clause');
      expect((state.error as Error).message).not.toContain('Add a LIMIT clause');
    });

    it('rejects with the caller cancellation during a backoff, never as timeout', async () => {
      mockFetch.mockImplementation(() => new Response('slow down', { status: 429 }));
      const caller = new AbortController();

      const state = track(
        makeService().query(
          'SELECT ?x WHERE { ?x ?p ?o }',
          'en',
          5_000,
          createMockContext({ signal: caller.signal }),
        ),
      );
      await advance(500);
      caller.abort();
      await advance(0);

      expect(state.settled).toBe(true);
      expect(state.error).toMatchObject({ name: 'AbortError' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    /** A body that sends its head, then nothing, until the request signal aborts it. */
    const stalledBody = (_url: string, init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('{"head":{"vars":["x"]},"results":{"bindings":['),
            );
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
              once: true,
            });
          },
        }),
        { status: 200 },
      );

    it('rejects with the caller cancellation during the body read, never as timeout', async () => {
      mockFetch.mockImplementation(stalledBody);
      const caller = new AbortController();

      const state = track(
        makeService().query(
          'SELECT ?x WHERE { ?x ?p ?o }',
          'en',
          5_000,
          createMockContext({ signal: caller.signal }),
        ),
      );
      await advance(1_000);
      caller.abort();
      await advance(0);

      expect(state.settled).toBe(true);
      expect(state.error).toMatchObject({ name: 'AbortError' });
    });

    it('stops a body that stalls mid-read at the deadline, as timeout', async () => {
      mockFetch.mockImplementation(stalledBody);

      const state = track(
        makeService().query('SELECT ?x WHERE { ?x ?p ?o }', 'en', 5_000, createMockContext()),
      );
      await advance(5_000);

      expect(state.settled).toBe(true);
      expect(state.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'timeout' },
      });
    });

    it('holds every deadline to WIKIDATA_SPARQL_TIMEOUT_MS, the most a SPARQL call waits', async () => {
      vi.stubEnv('WIKIDATA_SPARQL_TIMEOUT_MS', '3000');
      vi.resetModules();
      try {
        const { WikidataSparqlService: Configured } = await import(
          '@/services/wikidata/wikidata-sparql-service.js'
        );
        mockFetch.mockImplementation(hang);

        const state = track(
          new Configured({} as AppConfig, {} as StorageService).query(
            'SELECT ?x WHERE { ?x ?p ?o }',
            'en',
            5_000,
            createMockContext(),
          ),
        );
        await advance(2_999);
        expect(state.settled).toBe(false);
        await advance(1);

        expect(state.settled).toBe(true);
        expect(state.error).toMatchObject({
          code: JsonRpcErrorCode.Timeout,
          data: { reason: 'timeout' },
        });
        expect((state.error as Error).message).toContain('3s');
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    });
  });

  /** Encodes a JSON text, then splits its bytes into chunks of `size` (1 cuts every seam). */
  const bytesOf = (text: string, size: number): Uint8Array[] => {
    const bytes = new TextEncoder().encode(text);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
    return chunks;
  };

  /** A 200 response whose body arrives as the given byte chunks, recording a cancel. */
  const chunked = (chunks: Uint8Array[], onCancel?: () => void) => {
    let next = 0;
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const chunk = chunks[next++];
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          },
          cancel() {
            onCancel?.();
          },
        },
        { highWaterMark: 0 },
      ),
      { status: 200 },
    );
  };

  const resultText = (vars: string[], bindings: unknown[]) =>
    JSON.stringify({ head: { vars }, results: { bindings } }, null, 2);

  const run = (options?: { maxRows?: number }) =>
    makeService().query(
      'SELECT ?i WHERE { ?i wdt:P31 wd:Q515 } LIMIT 5000',
      'en',
      5_000,
      createMockContext(),
      options,
    );

  const uriRow = (i: number) => ({
    i: { type: 'uri', value: `http://www.wikidata.org/entity/Q${i}` },
  });

  /**
   * #51: with `maxRows`, the service reads the result one binding at a time, stops after
   * `maxRows + 1`, and aborts the request — so a result past the ceiling is never read whole.
   */
  describe('query — bounded read (#51)', () => {
    /**
     * A body that never ends on its own: one binding per read, as many as are asked for. It
     * errors past HARD_STOP, so a reader that ignores `maxRows` fails instead of hanging.
     */
    const HARD_STOP = 20_000;
    const endlessBody = () => {
      const encoder = new TextEncoder();
      const counts = { rows: 0, cancelled: 0 };
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            start(controller) {
              controller.enqueue(encoder.encode('{"head":{"vars":["i"]},"results":{"bindings":['));
            },
            pull(controller) {
              if (counts.rows >= HARD_STOP) {
                controller.error(new Error(`read past ${HARD_STOP} bindings`));
                return;
              }
              counts.rows++;
              const row = JSON.stringify(uriRow(counts.rows));
              controller.enqueue(encoder.encode(counts.rows === 1 ? row : `,${row}`));
            },
            cancel() {
              counts.cancelled++;
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 200 },
      );
      return { response, counts };
    };

    it('reads an endless body to 4,001 bindings, aborts it, and returns the first 4,000', async () => {
      const { response, counts } = endlessBody();
      mockFetch.mockImplementation(() => response);

      const result = await run({ maxRows: 4_000 });

      expect(result.stoppedEarly).toBe(true);
      expect(result.head.vars).toEqual(['i']);
      expect(result.results.bindings).toHaveLength(4_000);
      expect(result.results.bindings.at(-1)).toEqual(uriRow(4_000));
      expect(counts.rows).toBeGreaterThanOrEqual(4_001);
      expect(counts.rows).toBeLessThanOrEqual(4_002);
      expect(counts.cancelled).toBe(1);
    });

    it.each([
      [3, 3, false, 3],
      [3, 4, true, 3],
      [3, 0, false, 0],
      [1, 2, true, 1],
    ])(
      'with maxRows %i, a %i-row result is stoppedEarly=%s with %i rows',
      async (maxRows, rows, stoppedEarly, returned) => {
        const bindings = Array.from({ length: rows }, (_, i) => uriRow(i + 1));
        mockFetch.mockImplementation(() => chunked(bytesOf(resultText(['i'], bindings), 7)));

        const result = await run({ maxRows });

        expect(result.stoppedEarly).toBe(stoppedEarly);
        expect(result.results.bindings).toEqual(bindings.slice(0, returned));
      },
    );

    it('returns every row, not stopped early, when no maxRows is given', async () => {
      const bindings = Array.from({ length: 5_000 }, (_, i) => uriRow(i + 1));
      mockFetch.mockImplementation(() => chunked(bytesOf(resultText(['i'], bindings), 4_096)));

      const result = await run();

      expect(result.stoppedEarly).toBe(false);
      expect(result.results.bindings).toEqual(bindings);
    });

    /** The read also stops at 8 MiB of body, whatever the row count, and the call fails. */
    it('stops a body past 8 MiB, aborts it, and rejects as result_too_large', async () => {
      const encoder = new TextEncoder();
      const value = 'x'.repeat(64 * 1024);
      const counts = { rows: 0, cancelled: 0 };
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            start(controller) {
              controller.enqueue(encoder.encode('{"head":{"vars":["s"]},"results":{"bindings":['));
            },
            pull(controller) {
              if (counts.rows >= 1_000) {
                controller.error(new Error('read past 1,000 bindings'));
                return;
              }
              counts.rows++;
              const row = JSON.stringify({ s: { type: 'literal', value } });
              controller.enqueue(encoder.encode(counts.rows === 1 ? row : `,${row}`));
            },
            cancel() {
              counts.cancelled++;
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 200 },
      );
      mockFetch.mockImplementation(() => response);

      const err = await run({ maxRows: 4_000 }).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'result_too_large', limitBytes: 8 * 1024 * 1024 },
      });
      expect((err as Error).message).toContain('8 MiB');
      // The read stops on the row that carries the body past the ceiling.
      expect(counts.rows).toBeGreaterThanOrEqual(128);
      expect(counts.rows).toBeLessThanOrEqual(129);
      expect(counts.cancelled).toBe(1);
    });
  });

  /**
   * The incremental read must give the same rows JSON.parse would, wherever the chunk seams fall
   * and whatever layout or member order the document uses.
   */
  describe('query — incremental read fidelity', () => {
    const tricky = [
      {
        item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q42' },
        label: {
          type: 'literal',
          value: 'brace } bracket ] quote " backslash \\ "}]" é中😀 \u0000 \n\r\t',
          'xml:lang': 'en',
        },
      },
      {},
      {
        deep: {
          type: 'literal',
          value: 'x',
          nested: { a: [1, [2, { k: '}' }], { '': '"' }], b: null, c: true, d: -1.5e3 },
        },
      },
    ];

    it.each([1, 2, 3, 5, 64])(
      'reads a document split into %i-byte chunks exactly as JSON.parse does',
      async (size) => {
        const text = resultText(['item', 'label', 'deep'], tricky);
        mockFetch.mockImplementation(() => chunked(bytesOf(text, size)));

        const result = await run();

        expect(result.head).toEqual({ vars: ['item', 'label', 'deep'] });
        expect(result.results.bindings).toEqual(tricky);
      },
    );

    it.each([
      [
        'a compact layout',
        JSON.stringify({ head: { vars: ['x'] }, results: { bindings: [uriRow(1)] } }),
      ],
      [
        'CRLF line breaks and tabs between every token',
        JSON.stringify({ head: { vars: ['x'] }, results: { bindings: [uriRow(1)] } }, null, '\t')
          .split('\n')
          .join('\r\n'),
      ],
      [
        'results before head, and members the format does not define',
        JSON.stringify({
          results: { distinct: false, bindings: [uriRow(1)], ordered: true },
          head: { link: [], vars: ['x'] },
          extra: { bindings: [{ not: 'a row' }] },
        }),
      ],
      [
        'escaped member names',
        '{"he\\u0061d":{"vars":["x"]},"r\\u0065sults":{"b\\u0069ndings":[{"i":{"type":"uri","value":"http://www.wikidata.org/entity/Q1"}}]}}',
      ],
    ])('reads %s', async (_name, text) => {
      mockFetch.mockImplementation(() => chunked(bytesOf(text, 3)));

      const result = await run();

      expect(result.head.vars).toEqual(['x']);
      expect(result.results.bindings).toEqual([uriRow(1)]);
      expect(result.stoppedEarly).toBe(false);
    });

    it('reads an empty bindings array', async () => {
      mockFetch.mockImplementation(() => chunked(bytesOf(resultText(['x'], []), 2)));

      const result = await run({ maxRows: 10 });

      expect(result).toMatchObject({ head: { vars: ['x'] }, results: { bindings: [] } });
      expect(result.stoppedEarly).toBe(false);
    });
  });

  /**
   * #51: when a query passes WDQS's 60 s limit after rows have started streaming, the Query
   * Service still answers HTTP 200 and appends its exception trailer to the partial JSON. That
   * is a timeout, never a partial result.
   */
  describe('query — incomplete 200 bodies', () => {
    const head =
      '{\n  "head" : {\n    "vars" : [ "i" ]\n  },\n  "results" : {\n    "bindings" : [ ';
    const row = (i: number) =>
      `{\n      "i" : {\n        "type" : "uri",\n        "value" : "http://www.wikidata.org/entity/Q${i}"\n      }\n    }`;
    const trailer =
      'SPARQL-QUERY: queryStr=SELECT ?i WHERE { ?i wdt:P31 wd:Q515 . FILTER(?i != "}") } LIMIT 5000\njava.util.concurrent.TimeoutException\n\tat java.util.concurrent.FutureTask.get(FutureTask.java:205)\n\tat com.bigdata.rdf.sail.webapp.BigdataServlet.submitApiTask(BigdataServlet.java:292)\n';

    it.each([
      [
        'inside a binding',
        `${head}${row(1)}, {\n      "i" : {\n        "type" : "uri",\n        "value" : "http://www.wikidata.org/entity/Q${trailer}`,
      ],
      ['between bindings', `${head}${row(1)}, ${row(2)}, ${trailer}`],
      ['after a complete document', `${head}${row(1)} ]\n  }\n}${trailer}`],
    ])('reports the trailer %s as a timeout, returning no rows', async (_name, text) => {
      mockFetch.mockImplementation(() => chunked(bytesOf(text, 16)));

      const err = await run({ maxRows: 4_000 }).catch((e: unknown) => e);

      expect(err).toMatchObject({ code: JsonRpcErrorCode.Timeout, data: { reason: 'timeout' } });
      expect((err as Error).message).toContain('60s');
      expect((err as Error).message).toContain('Narrow the WHERE clause');
      expect((err as Error).message).not.toContain('Add a LIMIT clause');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const marker = 'java.util.concurrent.TimeoutException';

    it.each([
      ['inside the marker', 'java.util.'.length],
      ['before its last character', marker.length - 1],
    ])('finds the trailer when a chunk seam splits it %s', async (_name, into) => {
      const text = `${head}${row(1)}, ${trailer}`;
      const cut = text.indexOf(marker) + into;
      const encoder = new TextEncoder();
      mockFetch.mockImplementation(() =>
        chunked([encoder.encode(text.slice(0, cut)), encoder.encode(text.slice(cut))]),
      );

      await expect(run()).rejects.toMatchObject({ data: { reason: 'timeout' } });
    });

    it('returns a capped result when the read stops before a trailer', async () => {
      const text = `${head}${[1, 2, 3, 4].map(row).join(', ')}, ${trailer}`;
      mockFetch.mockImplementation(() => chunked(bytesOf(text, 16)));

      const result = await run({ maxRows: 2 });

      expect(result.stoppedEarly).toBe(true);
      expect(result.results.bindings).toEqual([uriRow(1), uriRow(2)]);
    });

    it.each([
      ['ends mid-binding', `${head}${row(1)}, {\n      "i" : {\n        "type" : "uri",\n`],
      ['ends after a binding', `${head}${row(1)}, `],
      ['carries text after the document', `${head}${row(1)} ]\n  }\n} trailing`],
      ['holds a binding that is not an object', `${head}${row(1)}, [ 1, 2 ] ]\n  }\n}`],
      ['holds a binding value that is not a term', `${head}{ "i": "Q1" } ]\n  }\n}`],
      ['holds a term without a value', `${head}{ "i": { "type": "uri" } } ]\n  }\n}`],
      [
        'holds a term whose value is not a string',
        `${head}{ "i": { "type": "uri", "value": 7 } } ]\n  }\n}`,
      ],
      ['has no head', '{ "results" : { "bindings" : [ ] } }'],
      ['has a head without vars', '{ "head" : { }, "results" : { "bindings" : [ ] } }'],
      [
        'has a head whose vars are not strings',
        '{ "head" : { "vars" : [ 1 ] }, "results" : { "bindings" : [ ] } }',
      ],
      ['has no results', '{ "head" : { "vars" : [ "x" ] } }'],
      ['has results without bindings', '{ "head" : { "vars" : [ "x" ] }, "results" : { } }'],
      [
        'has a results member that is not an object',
        '{ "head" : { "vars" : [ "x" ] }, "results" : [ ] }',
      ],
      [
        'has a bindings member that is not an array',
        '{ "head" : { "vars" : [ "x" ] }, "results" : { "bindings" : { } } }',
      ],
      ['is empty', ''],
    ])('reports a body that %s as ServiceUnavailable, returning no rows', async (_name, text) => {
      mockFetch.mockImplementation(() => chunked(bytesOf(text, 16)));

      await expect(run()).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    });

    it('rejects an HTML page delivered in chunks as HTML', async () => {
      mockFetch.mockImplementation(() =>
        chunked(bytesOf('\n<!DOCTYPE html><html><body>Too many requests</body></html>', 4)),
      );

      await expect(run()).rejects.toThrow(/HTML/);
    });
  });

  /**
   * A 400 or 422 with no Blazegraph exception line comes from a proxy in front of the Query
   * Service. An HTML page there is the proxy's error page, never a report on the query, so it is
   * ServiceUnavailable — which `wikidata_resolve_external_id` reads as that graph being down.
   */
  describe('query — 400 pages with no exception line', () => {
    const failWith = async (body: string, status = 400) => {
      mockFetch.mockImplementation(() => new Response(body, { status }));
      return (await makeService()
        .query('SELECT ?x WHERE { ?x ?p ?o }', 'en', 5_000, createMockContext())
        .catch((e: unknown) => e)) as {
        code: number;
        message: string;
        data: { reason?: string; cause?: string; status?: number };
      };
    };

    it.each([400, 422])(
      'reports an HTML page sent with %i as ServiceUnavailable, by its title, never its markup',
      async (status) => {
        const err = await failWith(
          '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>Wikimedia\n  Error: 400 Bad Request</title><style>body{}</style></head><body><h1>Error</h1><p>Request <b>rejected</b>.</p></body></html>',
          status,
        );

        expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(err.data.reason).toBeUndefined();
        expect(err.data.status).toBe(status);
        expect(err.message).toContain('Wikimedia Error: 400 Bad Request');
        expect(err.message).not.toContain('<');
        expect(err.message).not.toContain('parse error');
      },
    );

    it.each([
      ['an HTML page with no title', '<html><body><h1>Bad Request</h1></body></html>'],
      ['an HTML fragment', '  <body><p>Bad <b>Request</b></p></body>'],
      ['an empty title', '<html><head><title>  </title></head></html>'],
      ['an unclosed title', '<html><head><title>Bad'],
    ])('reports %s as ServiceUnavailable naming the bare status', async (_name, body) => {
      const err = await failWith(body);

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toContain('HTTP 400');
      expect(err.message).not.toContain('<');
    });

    it('reads an exception line as a parse error even inside markup', async () => {
      const err = await failWith(
        '<pre>org.openrdf.query.MalformedQueryException: Encountered "}" at line 1, column 9.</pre>',
      );

      expect(err.data.reason).toBe('parse_error');
    });

    it('reports an empty body as a parse error naming the bare status', async () => {
      const err = await failWith('');

      expect(err.data.reason).toBe('parse_error');
      expect(err.data.cause).toBe('HTTP 400');
      expect(err.message).toBe('SPARQL parse error: HTTP 400');
    });

    it('keeps the first 200 characters of a plain-text body', async () => {
      const err = await failWith(`Query is too long. ${'x'.repeat(300)}`);

      expect(err.data.reason).toBe('parse_error');
      expect(err.data.cause).toBe(`Query is too long. ${'x'.repeat(181)}`);
    });

    it('keeps the first 200 characters of a page title', async () => {
      const err = await failWith(`<html><head><title>${'T'.repeat(300)}</title></head></html>`);

      expect(err.message).toContain('T'.repeat(200));
      expect(err.message).not.toContain('T'.repeat(201));
    });
  });

  /**
   * Every scan prepareQuery() and the position rewrite run over caller-sized text: label-variable
   * detection, the SERVICE check, the WHERE-brace match, the PREFIX scan, the line count to the
   * splice point, and the `line N, column M` rewrite. Each worst case is a repeated opener with
   * no closer or a long run the pattern must backtrack over.
   */
  describe('scan cost', () => {
    const WITH_LABEL = 'SELECT ?xLabel WHERE { ';

    it.each<[string, (n: number) => string]>([
      ['a flood of non-label variables', (n) => `SELECT ${'?a '.repeat(n / 3)}`],
      ['a run of bare sigils', (n) => `SELECT ${'?'.repeat(n)}`],
      ['one long variable name that is not a label', (n) => `SELECT ?${'a'.repeat(n)}Labe`],
      ['a flood of label variables', (n) => `SELECT ${'?aLabel '.repeat(n / 8)}`],
      [
        'closing braces each followed by whitespace and a non-keyword',
        (n) => `${WITH_LABEL}${'}   x'.repeat(n / 5)}`,
      ],
      ['a brace followed by a long whitespace run', (n) => `${WITH_LABEL}}${' '.repeat(n)}x`],
      ['nested open braces with no closer', (n) => `${WITH_LABEL}${'{ '.repeat(n / 2)}`],
      [
        'SERVICE keywords trailing whitespace',
        (n) => `${WITH_LABEL}${'SERVICE    '.repeat(n / 11)}}`,
      ],
      ['unterminated PREFIX openers', (n) => `${'PREFIX x: <'.repeat(n / 11)}\n${WITH_LABEL}}`],
      ['PREFIX lines with no name', (n) => `${'PREFIX \n'.repeat(n / 8)}${WITH_LABEL}}`],
      ['IRI openers with no closer', (n) => `${WITH_LABEL}${'<'.repeat(n)}}`],
      ['IRI openers each before a long run', (n) => `${WITH_LABEL}${'<aaaaaaa'.repeat(n / 8)}}`],
      ['one IRI opener then a long run', (n) => `${WITH_LABEL}<${'a'.repeat(n)}}`],
      ['comment runs', (n) => `${WITH_LABEL}${'#'.repeat(n)}\n}`],
      ['comment lines', (n) => `${WITH_LABEL}${'# }\n'.repeat(n / 4)}}`],
      ['closed short strings', (n) => `${WITH_LABEL}${'"}" '.repeat(n / 4)}}`],
      ['a long-string opener with no closer', (n) => `${WITH_LABEL}'''${"''x".repeat(n / 3)}`],
      ['escaped quotes in a string', (n) => `${WITH_LABEL}"${'\\"'.repeat(n / 2)}"}`],
      ['parentheses in the projection', (n) => `SELECT ?xLabel ${'('.repeat(n)}{ }`],
      ['many lines before the splice point', (n) => `${WITH_LABEL}${'\r\n'.repeat(n / 2)}}`],
      ['lone CRs before the splice point', (n) => `${WITH_LABEL}${'\r'.repeat(n)}} LIMIT 1`],
    ])(
      'prepareQuery over %s stays under the super-linear ceiling at 400k characters',
      (_name, build) => {
        expectBoundedScan(build, (input) => prepareQuery(input, 'en'));
      },
    );

    const prepared = prepareQuery('SELECT ?xLabel WHERE { ?x ?p ?o } LIMIT abc', 'en');

    it.each<[string, (n: number) => string]>([
      ['repeated positions', (n) => 'line 12, column 99 '.repeat(n / 19)],
      ['position openers with no digits', (n) => 'line , column '.repeat(n / 14)],
      ['one huge line number', (n) => `line ${'9'.repeat(n)}, column 1`],
    ])(
      'toCallerPosition over %s stays under the super-linear ceiling at 400k characters',
      (_name, build) => {
        expectBoundedScan(build, (input) => toCallerPosition(input, prepared));
      },
    );
  });

  /**
   * The response scans run over upstream-sized text: the incremental results scanner (with its
   * timeout-trailer search) on every 200 body, and the title lookup on a 400 page. Each input
   * doubles from 5k to 320k characters. At every size the least growth over a 5k baseline,
   * re-timed beside it in each of several rounds, stays under 4× the size ratio (256 across the
   * whole 64× span), and the least CPU time per scan stays under an absolute bound — both in this
   * thread's own CPU time, so a descheduled worker never reads as a slow scan.
   */
  describe('response scan cost', () => {
    const BASE = 5_000;
    const ROUNDS = 5;
    /** Calls per timing of the 5k input, whose single scan sits near the timer's resolution. */
    const BATCH = 32;
    /** Per-character CPU budget plus a fixed allowance, in µs — ten times the slowest measured scan. */
    const boundUs = (size: number) => size * 0.25 + 1_000;

    const cpuUs = (): number => {
      const { user, system } = process.threadCpuUsage();
      return user + system;
    };

    /** Doubles the input from BASE to 64 × BASE, checking both bounds at each size before the next. */
    async function expectLinear(
      build: (size: number) => string,
      scanOnce: (input: string) => unknown,
      batch: number,
    ): Promise<void> {
      const timeEach = async (input: string, calls: number) => {
        const start = cpuUs();
        for (let i = 0; i < calls; i++) await scanOnce(input);
        return (cpuUs() - start) / calls;
      };
      const base = build(BASE);
      await timeEach(base, batch);
      for (let size = BASE * 2; size <= BASE * 64; size *= 2) {
        const input = build(size);
        let growth = Number.POSITIVE_INFINITY;
        let least = Number.POSITIVE_INFINITY;
        for (let round = 0; round < ROUNDS; round++) {
          const baseUs = await timeEach(base, batch);
          const sizeUs = await timeEach(input, Math.max(1, Math.round((batch * BASE) / size)));
          least = Math.min(least, sizeUs);
          growth = Math.min(growth, sizeUs / Math.max(baseUs, 1));
        }
        expect(growth, `growth from ${BASE} to ${size} characters`).toBeLessThan((4 * size) / BASE);
        expect(least, `CPU µs per scan of ${size} characters`).toBeLessThan(boundUs(size));
      }
    }

    const OPEN = '{"head":{"vars":["x"]},"results":{"bindings":[';
    /** `unit` repeated to about `size` characters after `prefix`. */
    const fill = (prefix: string, unit: string, size: number, suffix = '') =>
      `${prefix}${unit.repeat(Math.max(1, Math.floor((size - prefix.length) / unit.length)))}${suffix}`;

    it.each<[string, (size: number) => string]>([
      [
        'bindings on one long line ending in a break',
        (n) => fill(OPEN, '{"x":{"type":"literal","value":"§1 x"}},', n, '{}]}}\ny'),
      ],
      [
        'CRLF and spaces between every token',
        (n) =>
          fill(
            `{  \r\n"head"  \r\n:  \r\n{"vars":["x"]}  \r\n,  \r\n"results"  \r\n:  \r\n{  \r\n"bindings"  \r\n:  \r\n[  \r\n`,
            '{}  \r\n,  \r\n',
            n,
            '{}]}}',
          ),
      ],
      [
        'a string value of one long line ending in a break',
        (n) => fill(`${OPEN}{"x":{"type":"literal","value":"`, '§1 x', n, '\ny'),
      ],
      [
        'a string value of breaks throughout',
        (n) => fill(`${OPEN}{"x":{"type":"literal","value":"`, '  \r\n', n),
      ],
      ['nested openers with no closer in a row', (n) => fill(`${OPEN}{"a":`, '[', n)],
      ['nested objects with no closer in a skipped member', (n) => fill('{"x":', '{"x":', n)],
      [
        'escaped quotes in a row value',
        (n) => fill(`${OPEN}{"x":{"type":"literal","value":"`, '\\"', n, '"}}]}}'),
      ],
      ['a backslash run in a row value', (n) => fill(`${OPEN}{"x":{"value":"`, '\\', n)],
      ['short strings in a skipped member', (n) => fill('{"x":[', '"a",', n, '"a"]}')],
      ['one long key with no closing quote', (n) => fill('{"', 'a', n)],
      ['many skipped root members', (n) => fill('{', '"k":0,', n, '"k":0}')],
      ['a long digit run', (n) => fill('{"x":', '1', n, '}')],
      [
        'near misses of the timeout trailer',
        (n) => fill(`${OPEN}{}, `, 'java.util.concurrent.Timeout ', n),
      ],
    ])(
      'the results scanner over %s stays linear from 5k to 320k characters',
      async (_name, build) => {
        await expectLinear(
          build,
          (input) => {
            const scanner = new SparqlResultsScanner(4_000);
            scanner.push(input);
            return scanner.finish();
          },
          BATCH,
        );
      },
      0,
    );

    it.each<[string, (size: number) => string]>([
      [
        'bindings on one long line ending in a break',
        (n) => fill(OPEN, '{"x":{"type":"literal","value":"§1 x"}},', n, '{}]}}\ny'),
      ],
      ['near misses of the timeout trailer', (n) => fill(OPEN, 'java.util.concurrent.Timeout ', n)],
    ])(
      'the results scanner over %s, pushed in 1,000-character chunks, stays linear',
      async (_name, build) => {
        await expectLinear(
          build,
          (input) => {
            const scanner = new SparqlResultsScanner();
            for (let i = 0; i < input.length; i += 1_000) scanner.push(input.slice(i, i + 1_000));
            return scanner.finish();
          },
          BATCH,
        );
      },
      0,
    );

    /** Through `query()`, one call per measurement: the 400 path reads the body as a whole. */
    const parseFailure = (body: string) => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response(body, { status: 400 })));
      return makeService()
        .query('SELECT ?x WHERE { ?x ?p ?o }', 'en', 5_000, createMockContext())
        .catch((e: unknown) => e);
    };

    it.each<[string, (size: number) => string]>([
      ['title openers with no closing bracket', (n) => fill('<html>', '<title', n)],
      ['an unclosed title', (n) => fill('<html><title>', 'a', n)],
      ['near misses of the closing tag', (n) => fill('<html><title>', '</titl', n)],
      [
        'a title of one long line ending in a break',
        (n) => fill('<title>', '§1 x', n, '\ny</title>'),
      ],
      ['a title of breaks throughout', (n) => fill('<title>', '  \r\n', n, 'x</title>')],
      ['a run of tag openers', (n) => fill('', '<', n)],
      ['near misses of the exception line', (n) => fill('', 'Exceptio', n)],
    ])(
      'the 400 page title lookup over %s stays linear from 5k to 320k characters',
      async (_name, build) => {
        await expectLinear(build, parseFailure, 1);
      },
      30_000,
    );
  });
});
