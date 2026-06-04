/**
 * @fileoverview Tests for the wikidata://entity/{id} resource.
 * @module tests/resources/entity.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikidataEntityResource } from '@/mcp-server/resources/definitions/entity.resource.js';

const mockFetchEntity = vi.fn();

vi.mock('@/services/wikidata/wikidata-rest-service.js', () => ({
  getWikidataRestService: () => ({ fetchEntity: mockFetchEntity }),
  isQId: (id: string) => /^[Qq]\d+$/.test(id),
  isPId: (id: string) => /^[Pp]\d+$/.test(id),
  normalizeId: (id: string) => id.toUpperCase(),
}));

const mockItemEntity = {
  id: 'Q76',
  type: 'item' as const,
  labels: {
    en: 'Barack Obama',
    de: 'Barack Obama',
    fr: 'Barack Obama',
    es: 'Barack Obama',
    ja: 'バラク・オバマ',
    zh: '奥巴马',
  },
  descriptions: { en: '44th U.S. President' },
  aliases: { en: ['Obama'] },
  statements: {
    P31: [{ value: { content: { id: 'Q5' } } }],
    P18: [{ value: { content: 'Obama_official_portrait.jpg' } }],
  },
  sitelinks: {
    enwiki: { title: 'Barack Obama', url: 'https://en.wikipedia.org/wiki/Barack_Obama' },
  },
};

const mockPropertyEntity = {
  id: 'P31',
  type: 'property' as const,
  data_type: 'wikibase-item',
  labels: { en: 'instance of' },
  descriptions: { en: 'that class of which this subject is a particular example and member' },
};

describe('wikidataEntityResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns compact markdown for a valid Q-ID', async () => {
    mockFetchEntity.mockResolvedValue(mockItemEntity);

    const ctx = createMockContext({ uri: new URL('wikidata://entity/Q76') });
    const result = await wikidataEntityResource.handler({ id: 'Q76' }, ctx);

    expect(typeof result).toBe('string');
    const text = result as string;
    expect(text).toContain('Q76');
    expect(text).toContain('Barack Obama');
    expect(text).toContain('44th U.S. President');
    expect(text).toContain('Wikidata URL');
    expect(text).toContain('https://www.wikidata.org/wiki/Q76');
  });

  it('includes enwiki Wikipedia link when present', async () => {
    mockFetchEntity.mockResolvedValue(mockItemEntity);

    const ctx = createMockContext({ uri: new URL('wikidata://entity/Q76') });
    const result = (await wikidataEntityResource.handler({ id: 'Q76' }, ctx)) as string;

    expect(result).toContain('Wikipedia');
    expect(result).toContain('https://en.wikipedia.org/wiki/Barack_Obama');
  });

  it('includes image (P18) when present', async () => {
    mockFetchEntity.mockResolvedValue(mockItemEntity);

    const ctx = createMockContext({ uri: new URL('wikidata://entity/Q76') });
    const result = (await wikidataEntityResource.handler({ id: 'Q76' }, ctx)) as string;

    expect(result).toContain('Image');
    expect(result).toContain('Obama_official_portrait.jpg');
  });

  it('includes instance-of (P31) values', async () => {
    mockFetchEntity.mockResolvedValue(mockItemEntity);

    const ctx = createMockContext({ uri: new URL('wikidata://entity/Q76') });
    const result = (await wikidataEntityResource.handler({ id: 'Q76' }, ctx)) as string;

    expect(result).toContain('Instance of');
    expect(result).toContain('Q5');
  });

  it('includes label count when entity has multiple labels', async () => {
    mockFetchEntity.mockResolvedValue(mockItemEntity);

    const ctx = createMockContext({ uri: new URL('wikidata://entity/Q76') });
    const result = (await wikidataEntityResource.handler({ id: 'Q76' }, ctx)) as string;

    expect(result).toContain('Labels available');
  });

  it('includes statement count when entity has statements', async () => {
    mockFetchEntity.mockResolvedValue(mockItemEntity);

    const ctx = createMockContext({ uri: new URL('wikidata://entity/Q76') });
    const result = (await wikidataEntityResource.handler({ id: 'Q76' }, ctx)) as string;

    expect(result).toContain('Statements');
    expect(result).toContain('2 properties');
  });

  it('returns compact markdown for a valid P-ID (property entity)', async () => {
    mockFetchEntity.mockResolvedValue(mockPropertyEntity);

    const ctx = createMockContext({ uri: new URL('wikidata://entity/P31') });
    const result = (await wikidataEntityResource.handler({ id: 'P31' }, ctx)) as string;

    expect(result).toContain('P31');
    expect(result).toContain('instance of');
    expect(result).toContain('Property');
    expect(result).toContain('wikibase-item');
  });

  it('throws ValidationError for a malformed ID', async () => {
    const ctx = createMockContext({ uri: new URL('wikidata://entity/notanid') });
    await expect(wikidataEntityResource.handler({ id: 'notanid' }, ctx)).rejects.toMatchObject({
      code: expect.any(Number),
    });
    expect(mockFetchEntity).not.toHaveBeenCalled();
  });

  it('throws NotFound when the entity does not exist (404)', async () => {
    mockFetchEntity.mockRejectedValue({ data: { status: 404 } });

    const ctx = createMockContext({ uri: new URL('wikidata://entity/Q99999999') });
    await expect(wikidataEntityResource.handler({ id: 'Q99999999' }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Q99999999'),
    });
  });

  it('re-throws non-404 service errors', async () => {
    mockFetchEntity.mockRejectedValue(new Error('Network failure'));

    const ctx = createMockContext({ uri: new URL('wikidata://entity/Q76') });
    await expect(wikidataEntityResource.handler({ id: 'Q76' }, ctx)).rejects.toThrow(
      'Network failure',
    );
  });

  it('handles sparse entity with no optional fields', async () => {
    mockFetchEntity.mockResolvedValue({ id: 'Q1', type: 'item' });

    const ctx = createMockContext({ uri: new URL('wikidata://entity/Q1') });
    const result = (await wikidataEntityResource.handler({ id: 'Q1' }, ctx)) as string;

    expect(result).toContain('Q1');
    expect(result).toContain('Wikidata URL');
    // No Wikipedia link section when no sitelinks
    expect(result).not.toContain('Wikipedia:');
    // No image section
    expect(result).not.toContain('Image:');
  });

  it('handles enwiki sitelink with title but no url', async () => {
    mockFetchEntity.mockResolvedValue({
      id: 'Q999',
      type: 'item',
      sitelinks: { enwiki: { title: 'Some Article' } },
    });

    const ctx = createMockContext({ uri: new URL('wikidata://entity/Q999') });
    const result = (await wikidataEntityResource.handler({ id: 'Q999' }, ctx)) as string;

    expect(result).toContain('Wikipedia');
    expect(result).toContain('Some Article');
  });

  it('normalizes lowercase ID to uppercase before calling the service', async () => {
    mockFetchEntity.mockResolvedValue({ id: 'Q76', type: 'item' });

    const ctx = createMockContext({ uri: new URL('wikidata://entity/q76') });
    await wikidataEntityResource.handler({ id: 'q76' }, ctx);

    expect(mockFetchEntity).toHaveBeenCalledWith('Q76', expect.anything());
  });

  it('security: injection attempt in ID is rejected as invalid', async () => {
    const ctx = createMockContext({ uri: new URL('wikidata://entity/Q76') });
    await expect(
      wikidataEntityResource.handler({ id: '"; DROP TABLE entities; --' }, ctx),
    ).rejects.toMatchObject({ code: expect.any(Number) });
    expect(mockFetchEntity).not.toHaveBeenCalled();
  });

  it('security: API key and env values do not appear in output', async () => {
    process.env['TEST_SECRET_KEY'] = 'supersecret_api_key_12345';
    mockFetchEntity.mockResolvedValue({
      id: 'Q1',
      type: 'item',
      labels: { en: 'Test' },
      descriptions: { en: 'A test entity' },
    });

    const ctx = createMockContext({ uri: new URL('wikidata://entity/Q1') });
    const result = (await wikidataEntityResource.handler({ id: 'Q1' }, ctx)) as string;

    expect(result).not.toContain('supersecret_api_key_12345');
    delete process.env['TEST_SECRET_KEY'];
  });

  it('handles P18 image with non-string content gracefully', async () => {
    mockFetchEntity.mockResolvedValue({
      id: 'Q76',
      type: 'item',
      statements: {
        P18: [{ value: { content: { id: 'Q999' } } }], // object content, not string
      },
    });

    const ctx = createMockContext({ uri: new URL('wikidata://entity/Q76') });
    const result = (await wikidataEntityResource.handler({ id: 'Q76' }, ctx)) as string;

    // No crash — image section omitted when content is not a string
    expect(result).toContain('Q76');
    expect(result).not.toContain('Image:');
  });

  it('handles P31 instance-of with string content value', async () => {
    mockFetchEntity.mockResolvedValue({
      id: 'Q76',
      type: 'item',
      statements: {
        P31: [{ value: { content: 'Q5' } }], // string directly
      },
    });

    const ctx = createMockContext({ uri: new URL('wikidata://entity/Q76') });
    const result = (await wikidataEntityResource.handler({ id: 'Q76' }, ctx)) as string;

    expect(result).toContain('Instance of');
    expect(result).toContain('Q5');
  });

  it('list() returns static example resources', () => {
    const listed = wikidataEntityResource.list!();
    expect(listed.resources).toHaveLength(3);
    const uris = listed.resources.map((r) => r.uri);
    expect(uris).toContain('wikidata://entity/Q76');
    expect(uris).toContain('wikidata://entity/Q42');
    expect(uris).toContain('wikidata://entity/P31');
  });
});
