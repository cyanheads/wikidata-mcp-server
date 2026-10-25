/**
 * @fileoverview Tests for WikidataRestService — the wbgetentities batch parsing and the
 * REST not-found predicate. Mocks global `fetch` rather than the service module, so these
 * exercise the real `fetchWithTimeout`/`withRetry` pipeline the production code runs on.
 * @module tests/services/wikidata-rest-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawStatement } from '@/services/wikidata/types.js';
import {
  collectLabelQids,
  isEntityNotFoundError,
  isPId,
  isQId,
  normalizeId,
  normalizeStatements,
  resolveLangValue,
  unitQid,
  WikidataRestService,
} from '@/services/wikidata/wikidata-rest-service.js';

const mockFetch = vi.fn();

const makeService = () => new WikidataRestService({} as AppConfig, {} as StorageService);

/** A 200 response carrying a JSON body — how the MediaWiki API answers, errors included. */
const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Answers every fetch with a *fresh* Response. A Response body can only be read once, so
 * handing the same instance to two calls fails the second read for reasons unrelated to
 * the code under test.
 */
const respondWith = (body: unknown) => mockFetch.mockImplementation(() => jsonResponse(body));

/** Queues one fresh Response for the next fetch, in order. */
const respondOnceWith = (body: unknown) =>
  mockFetch.mockImplementationOnce(() => jsonResponse(body));

/** Answers every fetch with a fresh non-2xx — fetchWithTimeout rejects these before returning. */
const respondWithStatus = (status: number, statusText: string, body = '{}') =>
  mockFetch.mockImplementation(() => new Response(body, { status, statusText }));

/** The wbgetentities top-level rejection for an out-of-range ID. Only the first bad ID is named. */
const noSuchEntity = (id: string) => ({
  error: {
    code: 'no-such-entity',
    info: `Could not find an entity with the ID "${id}".`,
    id,
  },
});

const label = (value: string, lang = 'en') => ({ language: lang, value });

/** The url string of the Nth fetch call (0-based). */
const urlOf = (call: number) => String(mockFetch.mock.calls[call]?.[0]);

describe('WikidataRestService', () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks — the latter leaves queued `…Once` implementations
    // in place, which then leak into the next test's first fetch.
    vi.resetAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('fetchLabels — language fallback', () => {
    it('requests languagefallback=1 so a mul-only entity resolves the requested language', async () => {
      respondWith({
        entities: {
          Q76: {
            id: 'Q76',
            labels: {
              // What the API returns with languagefallback=1: keyed by the REQUESTED
              // language, with the mul source recorded as metadata.
              en: { value: 'Barack Obama', language: 'mul', 'for-language': 'en' },
              de: { value: 'Barack Obama', language: 'mul', 'for-language': 'de' },
            },
          },
        },
      });

      const svc = makeService();
      const result = await svc.fetchLabels(['Q76'], ['en', 'de'], createMockContext());

      expect(urlOf(0)).toContain('languagefallback=1');
      expect(result.Q76?.labels).toEqual({ en: 'Barack Obama', de: 'Barack Obama' });
    });
  });

  describe('fetchLabels — mixed batches', () => {
    /** The #14 defect: one out-of-range ID collapsed the whole batch to zero results. */
    it('returns the valid members when one out-of-range ID rejects the batch', async () => {
      respondOnceWith(noSuchEntity('Q999999999999'));
      respondOnceWith({
        entities: {
          Q76: { id: 'Q76', labels: { en: label('Barack Obama') } },
          P31: { id: 'P31', labels: { en: label('instance of') } },
        },
      });

      const svc = makeService();
      const result = await svc.fetchLabels(
        ['Q76', 'P31', 'Q999999999999'],
        ['en'],
        createMockContext(),
      );

      expect(Object.keys(result).sort()).toEqual(['P31', 'Q76']);
      expect(result.Q76?.labels.en).toBe('Barack Obama');
      expect(result.P31?.labels.en).toBe('instance of');

      // The retry drops only the named ID and keeps the rest.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(urlOf(0)).toContain('Q999999999999');
      expect(urlOf(1)).not.toContain('Q999999999999');
      expect(decodeURIComponent(urlOf(1))).toContain('Q76|P31');
    });

    /**
     * The API names only the FIRST offending ID, so a single drop-and-retry does not
     * converge — each bad member costs one more pass.
     */
    it('converges when a batch carries several out-of-range IDs', async () => {
      respondOnceWith(noSuchEntity('Q999999999999'));
      respondOnceWith(noSuchEntity('Q888888888888'));
      respondOnceWith({ entities: { Q76: { id: 'Q76', labels: { en: label('Barack Obama') } } } });

      const svc = makeService();
      const result = await svc.fetchLabels(
        ['Q76', 'Q999999999999', 'Q888888888888'],
        ['en'],
        createMockContext(),
      );

      expect(Object.keys(result)).toEqual(['Q76']);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(urlOf(2)).not.toContain('Q999999999999');
      expect(urlOf(2)).not.toContain('Q888888888888');
    });

    /**
     * The other not-found shape: an unassigned but in-range ID rides inside a normal
     * entities map with a per-item marker. It must NOT trigger the retry path.
     */
    it('skips a per-item missing marker without re-requesting the batch', async () => {
      respondWith({
        entities: {
          Q76: { id: 'Q76', labels: { en: label('Barack Obama') } },
          P31: { id: 'P31', labels: { en: label('instance of') } },
          Q99999999: { id: 'Q99999999', missing: '' },
        },
      });

      const svc = makeService();
      const result = await svc.fetchLabels(
        ['Q76', 'P31', 'Q99999999'],
        ['en'],
        createMockContext(),
      );

      expect(Object.keys(result).sort()).toEqual(['P31', 'Q76']);
      expect(result.Q99999999).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns nothing, without throwing, when every member is unresolvable', async () => {
      respondOnceWith(noSuchEntity('Q999999999999'));

      const svc = makeService();
      const result = await svc.fetchLabels(['Q999999999999'], ['en'], createMockContext());

      expect(result).toEqual({});
      // The batch empties out after the single bad ID is dropped — no second request.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    /** A real API failure must surface, not masquerade as "none of these IDs exist". */
    it('throws on a top-level error that is not no-such-entity', async () => {
      respondWith({ error: { code: 'param-missing', info: 'The required parameter is missing.' } });

      const svc = makeService();
      await expect(svc.fetchLabels(['Q76'], ['en'], createMockContext())).rejects.toThrow(
        /param-missing/,
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws rather than looping when no-such-entity names an ID outside the batch', async () => {
      respondWith(noSuchEntity('Q123456789012'));

      const svc = makeService();
      await expect(svc.fetchLabels(['Q76'], ['en'], createMockContext())).rejects.toThrow(
        /no-such-entity/,
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('chunks more than 50 IDs into separate requests', async () => {
      respondWith({ entities: {} });

      const ids = Array.from({ length: 51 }, (_, i) => `Q${i + 1}`);
      const svc = makeService();
      await svc.fetchLabels(ids, ['en'], createMockContext());

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * #40: every 50-ID batch went out at once — 23 concurrent wbgetentities requests for the
   * ~1,150 distinct QIDs an unfiltered Q30 carries.
   */
  describe('fetchLabels — batch concurrency (#40)', () => {
    /** The IDs a wbgetentities URL asked for. */
    const idsOf = (url: unknown) => new URL(String(url)).searchParams.get('ids')?.split('|') ?? [];

    /**
     * Answers each batch after a macrotask, echoing its IDs as resolved entities, and records
     * how many requests were in flight at once.
     */
    const trackConcurrency = () => {
      const stats = { inFlight: 0, peak: 0, started: 0 };
      mockFetch.mockImplementation(async (url: unknown) => {
        stats.started++;
        stats.inFlight++;
        stats.peak = Math.max(stats.peak, stats.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        stats.inFlight--;
        return jsonResponse({
          entities: Object.fromEntries(
            idsOf(url).map((id) => [id, { id, labels: { en: label(`label ${id}`) } }]),
          ),
        });
      });
      return stats;
    };

    it('keeps at most 4 requests in flight for a 23-batch call, and resolves every batch', async () => {
      const stats = trackConcurrency();
      const ids = Array.from({ length: 1_150 }, (_, i) => `Q${i + 1}`);

      const result = await makeService().fetchLabels(ids, ['en'], createMockContext());

      expect(stats.started).toBe(23);
      expect(stats.peak).toBe(4);
      expect(Object.keys(result)).toHaveLength(1_150);
      expect(result.Q1?.labels.en).toBe('label Q1');
      expect(result.Q1150?.labels.en).toBe('label Q1150');
    });

    it('sends a single batch alone', async () => {
      const stats = trackConcurrency();

      const result = await makeService().fetchLabels(['Q76', 'P31'], ['en'], createMockContext());

      expect(stats.started).toBe(1);
      expect(Object.keys(result).sort()).toEqual(['P31', 'Q76']);
    });

    it('starts no further batch once one batch fails', async () => {
      let started = 0;
      mockFetch.mockImplementation(async () => {
        started++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return jsonResponse({ error: { code: 'param-missing', info: 'Missing.' } });
      });
      const ids = Array.from({ length: 1_000 }, (_, i) => `Q${i + 1}`);

      await expect(makeService().fetchLabels(ids, ['en'], createMockContext())).rejects.toThrow(
        /param-missing/,
      );
      // The first wave of 4 fails together; none of the remaining 16 batches is sent.
      expect(started).toBe(4);
    });

    it('rejects on caller cancellation and sends no batch after the abort', async () => {
      const controller = new AbortController();
      let started = 0;
      mockFetch.mockImplementation(async (url: unknown, init?: { signal?: AbortSignal }) => {
        started++;
        if (started === 2) controller.abort();
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          });
        });
        return jsonResponse({ entities: Object.fromEntries(idsOf(url).map((id) => [id, { id }])) });
      });
      const ids = Array.from({ length: 1_000 }, (_, i) => `Q${i + 1}`);

      const outcome = await makeService()
        .fetchLabels(ids, ['en'], createMockContext({ signal: controller.signal }))
        .then(
          () => 'resolved',
          () => 'rejected',
        );

      expect(outcome).toBe('rejected');
      // The abort landed inside the second request: nothing starts after it.
      expect(started).toBe(2);
    });

    /**
     * The cap is process-wide: N simultaneous calls on the hosted single-instance server must
     * not put 4N requests in flight. Answers each batch after a macrotask unless its signal
     * aborts first, recording the IDs of every batch that started.
     */
    describe('one limit shared by every caller', () => {
      const ids = (from: number, count: number) =>
        Array.from({ length: count }, (_, i) => `Q${from + i}`);

      const trackShared = (outcome: (url: unknown) => unknown = () => undefined) => {
        const stats = { inFlight: 0, peak: 0, startedIds: [] as string[] };
        mockFetch.mockImplementation(async (url: unknown, init?: { signal?: AbortSignal }) => {
          stats.startedIds.push(...idsOf(url));
          stats.inFlight++;
          stats.peak = Math.max(stats.peak, stats.inFlight);
          try {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 5);
              init?.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(init.signal?.reason);
              });
            });
          } finally {
            stats.inFlight--;
          }
          return jsonResponse(
            outcome(url) ?? {
              entities: Object.fromEntries(
                idsOf(url).map((id) => [id, { id, labels: { en: label(`label ${id}`) } }]),
              ),
            },
          );
        });
        return stats;
      };

      it('keeps at most 4 requests in flight across overlapping calls and service instances', async () => {
        const stats = trackShared();

        const results = await Promise.all([
          makeService().fetchLabels(ids(1, 200), ['en'], createMockContext()),
          makeService().fetchLabels(ids(1001, 200), ['en'], createMockContext()),
          makeService().fetchLabels(ids(2001, 200), ['en'], createMockContext()),
        ]);

        expect(stats.peak).toBe(4);
        expect(stats.startedIds).toHaveLength(600);
        expect(results.map((r) => Object.keys(r).length)).toEqual([200, 200, 200]);
        expect(results[2]?.Q2200?.labels.en).toBe('label Q2200');
      });

      it('a call cancelled while queued never starts its batches, and frees the queue for others', async () => {
        const stats = trackShared();
        const svc = makeService();
        const settled: string[] = [];

        // First call takes all 4 slots; the second (4 batches) waits behind it.
        const first = svc.fetchLabels(ids(1, 200), ['en'], createMockContext()).then((r) => {
          settled.push('first');
          return r;
        });
        const controller = new AbortController();
        const cancelled = svc
          .fetchLabels(ids(5001, 200), ['en'], createMockContext({ signal: controller.signal }))
          .then(
            () => settled.push('cancelled:resolved'),
            () => settled.push('cancelled:rejected'),
          );
        await Promise.resolve();
        controller.abort();

        const [firstResult] = await Promise.all([first, cancelled]);

        // Rejected at once, not after waiting for a slot.
        expect(settled).toEqual(['cancelled:rejected', 'first']);
        expect(stats.startedIds.filter((id) => Number(id.slice(1)) >= 5001)).toEqual([]);
        expect(Object.keys(firstResult)).toHaveLength(200);

        // Every slot came back: a fresh 4-batch call runs all 4 at once.
        stats.peak = 0;
        const after = await svc.fetchLabels(ids(9001, 200), ['en'], createMockContext());
        expect(stats.peak).toBe(4);
        expect(Object.keys(after)).toHaveLength(200);
      });

      it("one call's cancellation mid-flight never fails another call's batches", async () => {
        const firstWave = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const stats = { inFlight: 0, peak: 0, startedIds: [] as string[] };
        mockFetch.mockImplementation(async (url: unknown, init?: { signal?: AbortSignal }) => {
          stats.startedIds.push(...idsOf(url));
          stats.inFlight++;
          stats.peak = Math.max(stats.peak, stats.inFlight);
          if (stats.inFlight === 4) firstWave.resolve();
          try {
            await new Promise<void>((resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                once: true,
              });
              release.promise.then(resolve, reject);
            });
          } finally {
            stats.inFlight--;
          }
          return jsonResponse({
            entities: Object.fromEntries(idsOf(url).map((id) => [id, { id }])),
          });
        });
        const svc = makeService();
        const controller = new AbortController();

        const doomed = svc
          .fetchLabels(ids(1, 400), ['en'], createMockContext({ signal: controller.signal }))
          .then(
            () => 'resolved',
            (error: unknown) => error,
          );
        const bystander = svc.fetchLabels(ids(7001, 100), ['en'], createMockContext());
        // Abort once the first wave is in flight: 4 of the doomed call's 8 batches.
        await firstWave.promise;
        controller.abort();
        release.resolve();

        expect(await doomed).toBe(controller.signal.reason);
        const result = await bystander;
        expect(Object.keys(result)).toHaveLength(100);
        // The doomed call's queued batches (Q201..Q400) never started.
        expect(
          stats.startedIds.filter((id) => Number(id.slice(1)) > 200 && Number(id.slice(1)) <= 400),
        ).toEqual([]);
        expect(stats.peak).toBe(4);
      });

      it('returns every slot after an upstream failure', async () => {
        const stats = trackShared((url) =>
          idsOf(url).includes('Q1')
            ? { error: { code: 'param-missing', info: 'Missing.' } }
            : undefined,
        );
        const svc = makeService();

        const [failed, survivor] = await Promise.allSettled([
          svc.fetchLabels(ids(1, 100), ['en'], createMockContext()),
          svc.fetchLabels(ids(3001, 300), ['en'], createMockContext()),
        ]);

        expect(failed.status).toBe('rejected');
        expect(survivor.status).toBe('fulfilled');
        expect(Object.keys(survivor.status === 'fulfilled' ? survivor.value : {})).toHaveLength(
          300,
        );

        stats.peak = 0;
        const after = await svc.fetchLabels(ids(9001, 200), ['en'], createMockContext());
        expect(stats.peak).toBe(4);
        expect(Object.keys(after)).toHaveLength(200);
      });
    });
  });

  describe('REST not-found classification', () => {
    /**
     * fetchWithTimeout rejects every non-2xx itself, carrying the status on data.status
     * — the field the tool catch sites key on. Guards the shape end to end.
     */
    it('surfaces an out-of-range 400 as an McpError carrying data.status', async () => {
      respondWithStatus(400, 'Bad Request', '{"code":"invalid-path-parameter"}');

      const svc = makeService();
      const err = await svc
        .fetchEntity('Q999999999999', createMockContext())
        .catch((e: unknown) => e);

      expect((err as { data?: { status?: number } }).data?.status).toBe(400);
      expect(isEntityNotFoundError(err)).toBe(true);
    });

    it('surfaces an unassigned 404 as an McpError carrying data.status', async () => {
      respondWithStatus(404, 'Not Found', '{"code":"resource-not-found"}');

      const svc = makeService();
      const err = await svc.fetchEntity('Q99999999', createMockContext()).catch((e: unknown) => e);

      expect((err as { data?: { status?: number } }).data?.status).toBe(404);
      expect(isEntityNotFoundError(err)).toBe(true);
    });

    /**
     * A deterministic not-found must fail fast. `withRetry`'s default predicate treats only
     * ServiceUnavailable/Timeout/RateLimited as transient, and 400/404 map to
     * InvalidParams/NotFound — retrying would burn four upstream requests on every bad ID.
     */
    it('does not retry a 400', async () => {
      respondWithStatus(400, 'Bad Request');

      const svc = makeService();
      await svc.fetchEntity('Q999999999999', createMockContext()).catch(() => undefined);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry a 404', async () => {
      respondWithStatus(404, 'Not Found');

      const svc = makeService();
      await svc.fetchSitelinks('Q99999999', undefined, createMockContext()).catch(() => undefined);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * #42: the search endpoint answers a parameter it will not take — a language it does not
   * search in, such as `mul` — with 400 `invalid-query-parameter`. That surfaced as the raw
   * fetch failure: the full upstream URL, no reason, no recovery hint.
   */
  describe('search — upstream 400 (#42)', () => {
    const invalidParameter = (parameter: string) =>
      JSON.stringify({
        code: 'invalid-query-parameter',
        message: `Invalid query parameter: '${parameter}'`,
        context: { parameter },
      });
    const searchError = (language = 'mul') =>
      makeService()
        .search('Douglas Adams', 'item', language, 10, 0, createMockContext())
        .catch((e: unknown) => e) as Promise<{
        code: number;
        message: string;
        data: { reason?: string; parameter?: string; status?: number };
      }>;

    it('maps a refused language to invalid_search_parameter naming the code, not the URL', async () => {
      respondWithStatus(400, 'Bad Request', invalidParameter('language'));

      const err = await searchError('mul');

      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason: 'invalid_search_parameter', parameter: 'language' });
      expect(err.message).toContain('"mul"');
      expect(err.message).not.toMatch(/https?:|rest\.php|Fetch failed/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('names another refused parameter and the value sent for it', async () => {
      respondWithStatus(400, 'Bad Request', invalidParameter('q'));

      const err = await searchError('en');

      expect(err.data).toMatchObject({ reason: 'invalid_search_parameter', parameter: 'q' });
      expect(err.message).toContain('"q"');
      expect(err.message).toContain('Douglas Adams');
      expect(err.message).not.toMatch(/https?:|rest\.php/);
    });

    it('still maps a 400 whose body names no parameter', async () => {
      respondWithStatus(400, 'Bad Request', '<html>not json</html>');

      const err = await searchError('en');

      expect(err.data.reason).toBe('invalid_search_parameter');
      expect(err.data.parameter).toBeUndefined();
      expect(err.message).not.toMatch(/https?:|rest\.php|<html>/);
    });

    it('keeps the current classification for other statuses', async () => {
      respondWithStatus(404, 'Not Found', '{"code":"resource-not-found"}');

      const err = await searchError('en');

      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.data.status).toBe(404);
      expect(err.data.reason).toBeUndefined();
    });
  });

  describe('isEntityNotFoundError', () => {
    it.each([
      [404, true],
      [400, true],
      [403, false],
      [429, false],
      [500, false],
      [503, false],
    ])('status %i → %s', (status, expected) => {
      expect(isEntityNotFoundError({ data: { status } })).toBe(expected);
    });

    it('is false for errors with no status data', () => {
      expect(isEntityNotFoundError(new Error('network down'))).toBe(false);
      expect(isEntityNotFoundError(undefined)).toBe(false);
      expect(isEntityNotFoundError(null)).toBe(false);
    });

    /**
     * `data.statusCode` remains a compatibility alias, but new consumers use `data.status`.
     * The predicate stays pinned to the canonical field.
     */
    it('ignores the legacy data.statusCode field', () => {
      expect(isEntityNotFoundError({ data: { statusCode: 404 } })).toBe(false);
    });
  });

  /**
   * #26: the REST API honours `?_fields=` (the `?fields=` spelling is accepted and silently
   * ignored). Narrowing is worth 51x on a major item — `items/Q76` is 344,114 bytes whole and
   * 6,703 with `_fields=labels`.
   */
  describe('fetchEntity — server-side field selection', () => {
    it('forwards the requested fields as _fields', async () => {
      respondWith({ id: 'Q76', type: 'item', labels: { en: 'Barack Obama' } });

      const svc = makeService();
      await svc.fetchEntity('Q76', createMockContext(), ['labels', 'descriptions']);

      expect(urlOf(0)).toContain('_fields=');
      expect(decodeURIComponent(urlOf(0))).toContain('labels');
      expect(decodeURIComponent(urlOf(0))).toContain('descriptions');
    });

    it('fetches the whole entity when no fields are requested', async () => {
      respondWith({ id: 'Q76', type: 'item' });

      const svc = makeService();
      await svc.fetchEntity('Q76', createMockContext());

      expect(urlOf(0)).not.toContain('_fields');
      expect(urlOf(0)).toContain('/entities/items/Q76');
    });

    it('fetches the whole entity for an empty fields array', async () => {
      respondWith({ id: 'Q76', type: 'item' });

      const svc = makeService();
      await svc.fetchEntity('Q76', createMockContext(), []);

      expect(urlOf(0)).not.toContain('_fields');
    });

    /**
     * The endpoint drops `type` unless it is asked for — `?_fields=labels` answers with
     * `labels` and `id` only. Every caller needs `type`, and get_entity declares it as a
     * required output field, so it rides along on every narrowed fetch.
     */
    it('always requests type, which the endpoint otherwise omits', async () => {
      respondWith({ id: 'Q76', type: 'item', labels: { en: 'Barack Obama' } });

      const svc = makeService();
      await svc.fetchEntity('Q76', createMockContext(), ['labels']);

      expect(decodeURIComponent(urlOf(0))).toContain('type');
    });

    /** `id` is rejected as a selector (400) but returned on every response regardless. */
    it('never requests id, which the endpoint rejects as a selector', async () => {
      respondWith({ id: 'Q76', type: 'item', labels: { en: 'Barack Obama' } });

      const svc = makeService();
      await svc.fetchEntity('Q76', createMockContext(), ['labels', 'id']);

      const fields = new URL(urlOf(0)).searchParams.get('_fields')?.split(',') ?? [];
      expect(fields).not.toContain('id');
      expect(fields).toContain('labels');
    });

    it('always requests data_type for a property, keeping the narrowed shape intact', async () => {
      respondWith({ id: 'P31', type: 'property', data_type: 'wikibase-item' });

      const svc = makeService();
      await svc.fetchEntity('P31', createMockContext(), ['labels']);

      const fields = new URL(urlOf(0)).searchParams.get('_fields')?.split(',') ?? [];
      expect(fields).toContain('data_type');
      expect(urlOf(0)).toContain('/entities/properties/P31');
    });

    /**
     * The two endpoints accept different field sets, and an endpoint answers a value it does
     * not know with 400 — indistinguishable from an out-of-range ID's 400, which
     * `isEntityNotFoundError()` maps to "does not exist". Forwarding blind would report a
     * real entity as missing, so unaccepted values are dropped instead.
     */
    it('drops sitelinks for a property, which the properties endpoint rejects', async () => {
      respondWith({ id: 'P31', type: 'property', data_type: 'wikibase-item' });

      const svc = makeService();
      await svc.fetchEntity('P31', createMockContext(), ['sitelinks']);

      const fields = new URL(urlOf(0)).searchParams.get('_fields')?.split(',') ?? [];
      expect(fields).not.toContain('sitelinks');
      // Still narrowed to the always-kept metadata rather than falling back to a full fetch.
      expect(fields.sort()).toEqual(['data_type', 'type']);
    });

    it('drops data_type for an item, which the items endpoint rejects', async () => {
      respondWith({ id: 'Q76', type: 'item' });

      const svc = makeService();
      await svc.fetchEntity('Q76', createMockContext(), ['labels', 'data_type']);

      const fields = new URL(urlOf(0)).searchParams.get('_fields')?.split(',') ?? [];
      expect(fields).not.toContain('data_type');
      expect(fields.sort()).toEqual(['labels', 'type']);
    });

    it('forwards every item field the endpoint accepts', async () => {
      respondWith({ id: 'Q76', type: 'item' });

      const svc = makeService();
      await svc.fetchEntity('Q76', createMockContext(), [
        'labels',
        'descriptions',
        'aliases',
        'statements',
        'sitelinks',
      ]);

      const fields = new URL(urlOf(0)).searchParams.get('_fields')?.split(',') ?? [];
      expect(fields.sort()).toEqual([
        'aliases',
        'descriptions',
        'labels',
        'sitelinks',
        'statements',
        'type',
      ]);
    });

    it('does not repeat a field the caller listed twice', async () => {
      respondWith({ id: 'Q76', type: 'item' });

      const svc = makeService();
      await svc.fetchEntity('Q76', createMockContext(), ['labels', 'labels', 'type']);

      const fields = new URL(urlOf(0)).searchParams.get('_fields')?.split(',') ?? [];
      expect(fields.sort()).toEqual(['labels', 'type']);
    });

    /** Narrowing must not disturb the not-found classification the tools depend on. */
    it('still classifies a narrowed fetch of an unassigned ID as not-found', async () => {
      respondWithStatus(404, 'Not Found', '{"code":"resource-not-found"}');

      const svc = makeService();
      const err = await svc
        .fetchEntity('Q99999999', createMockContext(), ['labels'])
        .catch((e: unknown) => e);

      expect(isEntityNotFoundError(err)).toBe(true);
    });
  });

  describe('fetchPropertyDataType', () => {
    it('requests only data_type and returns it', async () => {
      respondWith({ id: 'P356', data_type: 'external-id' });

      const svc = makeService();
      const dataType = await svc.fetchPropertyDataType('P356', createMockContext());

      expect(dataType).toBe('external-id');
      expect(urlOf(0)).toContain('/entities/properties/P356');
      expect(urlOf(0)).toContain('_fields=data_type');
    });

    it('normalizes the P-ID before addressing the endpoint', async () => {
      respondWith({ id: 'P356', data_type: 'external-id' });

      const svc = makeService();
      await svc.fetchPropertyDataType(' p356 ', createMockContext());

      expect(urlOf(0)).toContain('/entities/properties/P356');
    });

    it('rejects a nonexistent property with a not-found-classifiable error', async () => {
      respondWithStatus(404, 'Not Found', '{"code":"resource-not-found"}');

      const svc = makeService();
      const err = await svc
        .fetchPropertyDataType('P9999999', createMockContext())
        .catch((e: unknown) => e);

      expect(isEntityNotFoundError(err)).toBe(true);
    });
  });

  /** #21: the single point every ID-format call site inherits its trim from. */
  describe('normalizeId', () => {
    it.each([
      [' Q76 ', 'Q76'],
      ['q76', 'Q76'],
      ['\tp31\n', 'P31'],
      ['  Q76', 'Q76'],
      ['Q76  ', 'Q76'],
    ])('normalizes %j → %j', (input, expected) => {
      expect(normalizeId(input)).toBe(expected);
    });

    it('makes a whitespace-padded ID pass the strict format check', () => {
      expect(isQId(normalizeId(' q76 '))).toBe(true);
      expect(isPId(normalizeId(' p31 '))).toBe(true);
    });

    it('does not rescue an ID that is malformed for other reasons', () => {
      expect(isQId(normalizeId(' Q 76 '))).toBe(false);
      expect(isQId(normalizeId(' notanid '))).toBe(false);
    });
  });

  describe('resolveLangValue', () => {
    it('returns the exact language when present', () => {
      expect(resolveLangValue({ en: 'Douglas Adams', mul: 'D. Adams' }, 'en')).toBe(
        'Douglas Adams',
      );
    });

    it('falls back to mul when the language is absent', () => {
      expect(resolveLangValue({ mul: 'Barack Obama' }, 'en')).toBe('Barack Obama');
    });

    it('returns undefined when neither the language nor mul is present', () => {
      expect(resolveLangValue({ de: 'Vereinte Nationen' }, 'en')).toBeUndefined();
      expect(resolveLangValue(undefined, 'en')).toBeUndefined();
    });

    it('carries array values through for alias maps', () => {
      expect(resolveLangValue({ mul: ['Obama', 'POTUS 44'] }, 'en')).toEqual(['Obama', 'POTUS 44']);
    });
  });

  describe('normalizeStatements', () => {
    /** One snak as the REST statements endpoint sends it. */
    const snak = (property: string, dataType: string, value: { type: string; content?: unknown }) =>
      ({ property: { id: property, data_type: dataType }, value }) as RawStatement;
    const val = (content: unknown) => ({ type: 'value', content });
    const day = (time: string) => val({ time, precision: 11 });

    /** A statement wrapping a main snak, as the endpoint returns it. */
    const statement = (main: RawStatement, extra: Partial<RawStatement> = {}): RawStatement => ({
      ...main,
      id: `Q1$${main.property.id}`,
      rank: 'normal',
      ...extra,
    });

    /** Q42 P31, trimmed from the live REST response: 1 qualifier, 3 references × 4 parts. */
    const q42P31: RawStatement = statement(snak('P31', 'wikibase-item', val('Q5')), {
      id: 'Q42$F078E5B3-F9A8-480E-B7AC-D97778CBBEF9',
      qualifiers: [snak('P805', 'wikibase-item', val('Q42395533'))],
      references: [
        {
          hash: 'a4d108601216cffd2ff1819ccf12b483486b62e7',
          parts: [
            snak('P248', 'wikibase-item', val('Q19938912')),
            snak('P268', 'external-id', val('11888092r')),
            snak('P407', 'wikibase-item', val('Q150')),
            snak('P813', 'time', day('+2022-10-09T00:00:00Z')),
          ],
        },
        {
          hash: 'f38b0c50096908694fe215d33497be11eb3f9d3b',
          parts: [
            snak('P248', 'wikibase-item', val('Q36578')),
            snak('P227', 'external-id', val('119033364')),
            snak('P407', 'wikibase-item', val('Q188')),
            snak('P813', 'time', day('+2022-10-09T00:00:00Z')),
          ],
        },
        {
          hash: '3822724d621668aeee62ec03b07d3a36251b552f',
          parts: [
            snak('P248', 'wikibase-item', val('Q50358336')),
            snak('P950', 'external-id', val('XX1149955')),
            snak('P407', 'wikibase-item', val('Q1321')),
            snak('P813', 'time', day('+2024-02-17T00:00:00Z')),
          ],
        },
      ],
    });

    it('resolves the main item value against the label map', () => {
      const [stmt] = normalizeStatements('P31', [q42P31], { Q5: 'human' });

      expect(stmt).toMatchObject({
        id: 'Q42$F078E5B3-F9A8-480E-B7AC-D97778CBBEF9',
        rank: 'normal',
        property: 'P31',
        value: { type: 'wikibase-item', qid: 'Q5', label: 'human' },
      });
    });

    it('normalizes per data type: time, external-id, monolingualtext, coordinate', () => {
      const stmts = normalizeStatements('P1', [
        statement(snak('P569', 'time', day('+1952-03-11T00:00:00Z'))),
        statement(snak('P214', 'external-id', val('113230702'))),
        statement(snak('P1559', 'monolingualtext', val({ text: 'Douglas Adams', language: 'en' }))),
        statement(snak('P625', 'globe-coordinate', val({ latitude: 1.5, longitude: -2.5 }))),
      ]);

      expect(stmts.map((s) => s.value)).toEqual([
        { type: 'time', time: '+1952-03-11T00:00:00Z', precision: 11 },
        { type: 'external-id', value: '113230702' },
        { type: 'monolingualtext', text: 'Douglas Adams', language: 'en' },
        { type: 'globe-coordinate', latitude: 1.5, longitude: -2.5 },
      ]);
    });

    it('omits references and qualifiers when the statement carries none', () => {
      const [stmt] = normalizeStatements('P569', [
        statement(snak('P569', 'time', day('+1952-03-11T00:00:00Z')), {
          qualifiers: [],
          references: [],
        }),
      ]);

      expect(stmt).not.toHaveProperty('references');
      expect(stmt).not.toHaveProperty('qualifiers');
    });

    describe('references (#38)', () => {
      it('keeps each reference as its own group of parts, in upstream order', () => {
        const [stmt] = normalizeStatements('P31', [q42P31]);

        expect(stmt?.references).toHaveLength(3);
        expect(stmt?.references?.map((ref) => ref.parts.map((part) => part.property))).toEqual([
          ['P248', 'P268', 'P407', 'P813'],
          ['P248', 'P227', 'P407', 'P813'],
          ['P248', 'P950', 'P407', 'P813'],
        ]);
        expect(stmt?.references?.[1]?.parts[1]).toEqual({
          property: 'P227',
          value: { type: 'external-id', value: '119033364' },
        });
      });

      it('does not carry the upstream reference hash', () => {
        const [stmt] = normalizeStatements('P31', [q42P31]);
        expect(stmt?.references?.[0]).toEqual({ parts: expect.any(Array) });
      });
    });

    describe('somevalue and novalue (#39)', () => {
      const unknown = { type: 'somevalue' };
      const none = { type: 'novalue' };

      it('keeps an unknown quantity main value as somevalue (Q30 P2997)', () => {
        const [stmt] = normalizeStatements('P2997', [
          statement(snak('P2997', 'quantity', unknown), {
            qualifiers: [snak('P1552', 'wikibase-item', val('Q27145860'))],
          }),
        ]);
        expect(stmt?.value).toEqual({ type: 'somevalue' });
      });

      it.each([
        ['wikibase-item', unknown, { type: 'somevalue' }],
        ['wikibase-item', none, { type: 'novalue' }],
        ['time', unknown, { type: 'somevalue' }],
        ['string', none, { type: 'novalue' }],
      ])('maps a %s %j main value to its own type', (dataType, raw, expected) => {
        const [stmt] = normalizeStatements('P1', [statement(snak('P1', dataType, raw))]);
        expect(stmt?.value).toEqual(expected);
      });

      it('maps them in qualifiers and reference parts, item-typed and not', () => {
        const [stmt] = normalizeStatements(
          'P39',
          [
            statement(snak('P39', 'wikibase-item', val('Q11696')), {
              qualifiers: [snak('P1365', 'wikibase-item', unknown), snak('P582', 'time', none)],
              references: [
                {
                  parts: [snak('P248', 'wikibase-item', none), snak('P854', 'url', unknown)],
                },
              ],
            }),
          ],
          { Q11696: 'President of the United States' },
        );

        expect(stmt?.qualifiers).toEqual([
          { property: 'P1365', value: { type: 'somevalue' } },
          { property: 'P582', value: { type: 'novalue' } },
        ]);
        expect(stmt?.references).toEqual([
          {
            parts: [
              { property: 'P248', value: { type: 'novalue' } },
              { property: 'P854', value: { type: 'somevalue' } },
            ],
          },
        ]);
      });

      it('never produces a wikibase-item with an empty qid', () => {
        const stmts = normalizeStatements('P50', [
          statement(snak('P50', 'wikibase-item', unknown), {
            qualifiers: [snak('P1545', 'wikibase-item', none)],
            references: [{ parts: [snak('P248', 'wikibase-item', unknown)] }],
          }),
        ]);
        const values = stmts.flatMap((s) => [
          s.value,
          ...(s.qualifiers ?? []).map((q) => q.value),
          ...(s.references ?? []).flatMap((r) => r.parts.map((p) => p.value)),
        ]);

        expect(values).toHaveLength(3);
        expect(values.filter((v) => v.type === 'wikibase-item')).toEqual([]);
      });
    });

    describe('nested labels (#30)', () => {
      const labelMap = {
        Q5: 'human',
        Q42395533: 'Wikidata property example',
        Q19938912: 'BnF authorities',
        Q150: 'French',
      };

      it('labels qualifier and reference-part item values from the same map as the main value', () => {
        const [stmt] = normalizeStatements('P31', [q42P31], labelMap);

        expect(stmt?.value).toEqual({ type: 'wikibase-item', qid: 'Q5', label: 'human' });
        expect(stmt?.qualifiers?.[0]?.value).toEqual({
          type: 'wikibase-item',
          qid: 'Q42395533',
          label: 'Wikidata property example',
        });
        expect(stmt?.references?.[0]?.parts.slice(0, 3).map((p) => p.value)).toEqual([
          { type: 'wikibase-item', qid: 'Q19938912', label: 'BnF authorities' },
          { type: 'external-id', value: '11888092r' },
          { type: 'wikibase-item', qid: 'Q150', label: 'French' },
        ]);
      });

      it('leaves a QID absent from the map bare, at every level', () => {
        const [stmt] = normalizeStatements('P31', [q42P31], labelMap);

        // Q36578 / Q188 (second reference) are not in the map.
        expect(stmt?.references?.[1]?.parts[0]?.value).toEqual({
          type: 'wikibase-item',
          qid: 'Q36578',
        });
        expect(stmt?.references?.[1]?.parts[2]?.value).toEqual({
          type: 'wikibase-item',
          qid: 'Q188',
        });
      });

      it('adds no label anywhere without a label map', () => {
        const [stmt] = normalizeStatements('P31', [q42P31]);
        const serialized = JSON.stringify(stmt);
        expect(serialized).not.toContain('"label"');
      });
    });

    describe('quantity units (#37)', () => {
      const km2 = 'http://www.wikidata.org/entity/Q712226';
      const area = (unit: string) => snak('P2046', 'quantity', val({ amount: '+105.4', unit }));
      /** Q90 P2046 shape, plus a unit in a qualifier and a reference part. */
      const q90 = statement(area(km2), {
        qualifiers: [area(km2)],
        references: [{ parts: [snak('P248', 'wikibase-item', val('Q20894925')), area(km2)] }],
      });

      it('adds unitLabel beside the unchanged unit URI at every level', () => {
        const [stmt] = normalizeStatements('P2046', [q90], { Q712226: 'square kilometre' });
        const expected = {
          type: 'quantity',
          amount: '+105.4',
          unit: km2,
          unitLabel: 'square kilometre',
        };

        expect(stmt?.value).toEqual(expected);
        expect(stmt?.qualifiers?.[0]?.value).toEqual(expected);
        expect(stmt?.references?.[0]?.parts[1]?.value).toEqual(expected);
      });

      it('adds no unitLabel when the unit is missing from the map', () => {
        const [stmt] = normalizeStatements('P2046', [q90], { Q5: 'human' });
        expect(stmt?.value).toEqual({ type: 'quantity', amount: '+105.4', unit: km2 });
        expect(stmt?.references?.[0]?.parts[1]?.value).not.toHaveProperty('unitLabel');
      });

      it('leaves a unitless quantity ("1") untouched', () => {
        const [stmt] = normalizeStatements('P1082', [statement(area('1'))], { '1': 'one' });
        expect(stmt?.value).toEqual({ type: 'quantity', amount: '+105.4', unit: '1' });
      });

      it('collects unit QIDs at every level and skips the unitless "1"', () => {
        const qids = collectLabelQids([q90, statement(area('1'))]);
        expect([...qids].sort()).toEqual(['Q20894925', 'Q712226']);
      });
    });

    describe('quantity bounds (#44)', () => {
      const km = 'http://www.wikidata.org/entity/Q828224';
      /** Q2 P2120, live: the equatorial radius with its uncertainty range. */
      const radius = (property: string) =>
        snak(
          property,
          'quantity',
          val({ amount: '+6378.137', unit: km, upperBound: '+6378.138', lowerBound: '+6378.136' }),
        );
      const bounded = statement(radius('P2120'), {
        qualifiers: [radius('P2120')],
        references: [{ parts: [radius('P2120')] }],
      });

      it('passes upperBound and lowerBound through verbatim at every level', () => {
        const [stmt] = normalizeStatements('P2120', [bounded], { Q828224: 'kilometre' });
        const expected = {
          type: 'quantity',
          amount: '+6378.137',
          unit: km,
          upperBound: '+6378.138',
          lowerBound: '+6378.136',
          unitLabel: 'kilometre',
        };

        expect(stmt?.value).toEqual(expected);
        expect(stmt?.qualifiers?.[0]?.value).toEqual(expected);
        expect(stmt?.references?.[0]?.parts[0]?.value).toEqual(expected);
      });

      it('keeps the bounds of a unitless quantity and adds no bound keys to an unbounded one', () => {
        const [withBounds, without] = normalizeStatements('P1082', [
          statement(
            snak(
              'P1',
              'quantity',
              val({ amount: '+5', unit: '1', upperBound: '+6', lowerBound: '+4' }),
            ),
          ),
          statement(snak('P1', 'quantity', val({ amount: '+6339.9', unit: km }))),
        ]);

        expect(withBounds?.value).toEqual({
          type: 'quantity',
          amount: '+5',
          unit: '1',
          upperBound: '+6',
          lowerBound: '+4',
        });
        expect(without?.value).toEqual({ type: 'quantity', amount: '+6339.9', unit: km });
      });
    });

    describe('non-item entity-ID values (#43)', () => {
      /** Live examples: each data type's content is the bare ID string. */
      const cases = [
        ['wikibase-property', 'P1659', 'P279', 'property'],
        ['wikibase-lexeme', 'P5188', 'L37633', 'lexeme'],
        ['wikibase-form', 'P5189', 'L229416-F1', 'form'],
        ['wikibase-sense', 'P5972', 'L1452908-S1', 'sense'],
        ['entity-schema', 'P12861', 'E10', 'entity-schema'],
      ] as const;

      it.each(cases)(
        'types a %s value (%s → %s) as an entity-id naming its kind',
        (dataType, property, id, entityType) => {
          const [stmt] = normalizeStatements(property, [
            statement(snak(property, dataType, val(id))),
          ]);
          expect(stmt?.value).toEqual({ type: 'entity-id', entityType, id });
        },
      );

      it('types them in qualifiers and reference parts', () => {
        const [stmt] = normalizeStatements('P31', [
          statement(snak('P31', 'wikibase-item', val('Q5')), {
            qualifiers: cases.map(([dataType, property, id]) => snak(property, dataType, val(id))),
            references: [
              { parts: cases.map(([dataType, property, id]) => snak(property, dataType, val(id))) },
            ],
          }),
        ]);
        const expected = cases.map(([, property, id, entityType]) => ({
          property,
          value: { type: 'entity-id', entityType, id },
        }));

        expect(stmt?.qualifiers).toEqual(expected);
        expect(stmt?.references?.[0]?.parts).toEqual(expected);
      });

      it('keeps somevalue/novalue and an empty value off the entity-id type', () => {
        const stmts = normalizeStatements('P1659', [
          statement(snak('P1659', 'wikibase-property', { type: 'somevalue' })),
          statement(snak('P1659', 'wikibase-property', { type: 'novalue' })),
          statement(snak('P1659', 'wikibase-property', val(''))),
        ]);
        expect(stmts.map((s) => s.value)).toEqual([
          { type: 'somevalue' },
          { type: 'novalue' },
          { type: 'other', raw: '' },
        ]);
      });

      it('never collects or labels them, even when the label map holds the ID', () => {
        const all = statement(snak('P1659', 'wikibase-property', val('P279')), {
          qualifiers: cases.map(([dataType, property, id]) => snak(property, dataType, val(id))),
          references: [
            { parts: cases.map(([dataType, property, id]) => snak(property, dataType, val(id))) },
          ],
        });
        const labelMap = Object.fromEntries(cases.map(([, , id]) => [id, `label of ${id}`]));

        expect(collectLabelQids([all]).size).toBe(0);
        const [stmt] = normalizeStatements('P1659', [all], labelMap);
        expect(JSON.stringify(stmt)).not.toMatch(/"(label|unitLabel)"/);
      });
    });

    describe('unitQid', () => {
      it.each([
        ['http://www.wikidata.org/entity/Q712226', 'Q712226'],
        ['1', undefined],
        [undefined, undefined],
        ['http://example.test/unit/Q1', undefined],
      ])('%j → %j', (unit, expected) => {
        expect(unitQid(unit)).toBe(expected);
      });
    });

    describe('collectLabelQids (#30, #37)', () => {
      it('collects item values from the main value, qualifiers, and reference parts, deduplicated', () => {
        const qids = collectLabelQids([q42P31, q42P31]);

        expect([...qids].sort()).toEqual(
          ['Q5', 'Q42395533', 'Q19938912', 'Q150', 'Q36578', 'Q188', 'Q50358336', 'Q1321'].sort(),
        );
      });

      it('skips somevalue/novalue items and non-item values', () => {
        const qids = collectLabelQids([
          statement(snak('P50', 'wikibase-item', { type: 'somevalue' }), {
            qualifiers: [snak('P1545', 'wikibase-item', { type: 'novalue' })],
            references: [{ parts: [snak('P854', 'url', val('https://example.test'))] }],
          }),
        ]);
        expect(qids.size).toBe(0);
      });

      it('collects a unit that appears only in a qualifier or only in a reference part', () => {
        const qty = (property: string, unit: string) =>
          snak(
            property,
            'quantity',
            val({ amount: '+1', unit: `http://www.wikidata.org/entity/${unit}` }),
          );
        const qids = collectLabelQids([
          statement(snak('P1', 'string', val('x')), {
            qualifiers: [qty('P2048', 'Q11573')],
            references: [{ parts: [qty('P2046', 'Q712226')] }],
          }),
        ]);
        expect([...qids].sort()).toEqual(['Q11573', 'Q712226']);
      });

      it('never collects or labels a QID-shaped value of a non-item data type', () => {
        const qidShaped = statement(snak('P1', 'external-id', val('Q5')), {
          qualifiers: [snak('P2', 'string', val('Q5'))],
          references: [
            { parts: [snak('P3', 'wikibase-property', val('P31')), snak('P4', 'url', val('Q5'))] },
          ],
        });

        expect(collectLabelQids([qidShaped]).size).toBe(0);
        const [stmt] = normalizeStatements('P1', [qidShaped], { Q5: 'human', P31: 'instance of' });
        expect(JSON.stringify(stmt)).not.toMatch(/"(label|unitLabel)"/);
      });

      it('returns an empty set for no statements', () => {
        expect(collectLabelQids([]).size).toBe(0);
      });
    });
  });
});
