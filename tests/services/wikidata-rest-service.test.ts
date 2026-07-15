/**
 * @fileoverview Tests for WikidataRestService — the wbgetentities batch parsing and the
 * REST not-found predicate. Mocks global `fetch` rather than the service module, so these
 * exercise the real `fetchWithTimeout`/`withRetry` pipeline the production code runs on.
 * @module tests/services/wikidata-rest-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isEntityNotFoundError,
  isPId,
  isQId,
  normalizeId,
  resolveLangValue,
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

  describe('REST not-found classification', () => {
    /**
     * fetchWithTimeout rejects every non-2xx itself, carrying the status on data.statusCode
     * — the field the tool catch sites key on. Guards the shape end to end.
     */
    it('surfaces an out-of-range 400 as an McpError carrying data.statusCode', async () => {
      respondWithStatus(400, 'Bad Request', '{"code":"invalid-path-parameter"}');

      const svc = makeService();
      const err = await svc
        .fetchEntity('Q999999999999', createMockContext())
        .catch((e: unknown) => e);

      expect((err as { data?: { statusCode?: number } }).data?.statusCode).toBe(400);
      expect(isEntityNotFoundError(err)).toBe(true);
    });

    it('surfaces an unassigned 404 as an McpError carrying data.statusCode', async () => {
      respondWithStatus(404, 'Not Found', '{"code":"resource-not-found"}');

      const svc = makeService();
      const err = await svc.fetchEntity('Q99999999', createMockContext()).catch((e: unknown) => e);

      expect((err as { data?: { statusCode?: number } }).data?.statusCode).toBe(404);
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

  describe('isEntityNotFoundError', () => {
    it.each([
      [404, true],
      [400, true],
      [403, false],
      [429, false],
      [500, false],
      [503, false],
    ])('statusCode %i → %s', (statusCode, expected) => {
      expect(isEntityNotFoundError({ data: { statusCode } })).toBe(expected);
    });

    it('is false for errors with no status data', () => {
      expect(isEntityNotFoundError(new Error('network down'))).toBe(false);
      expect(isEntityNotFoundError(undefined)).toBe(false);
      expect(isEntityNotFoundError(null)).toBe(false);
    });

    /**
     * The pre-fix catch sites keyed on `data.status`, a field no live path populates.
     * Matching it again would resurrect the bug.
     */
    it('ignores the legacy data.status field', () => {
      expect(isEntityNotFoundError({ data: { status: 404 } })).toBe(false);
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
});
