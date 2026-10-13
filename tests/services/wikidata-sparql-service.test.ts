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
});
