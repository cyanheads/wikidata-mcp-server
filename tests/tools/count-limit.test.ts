/**
 * @fileoverview Tests for the per-call count cap and its WIKIDATA_CLAMP_LIMITS off switch.
 * @module tests/tools/count-limit.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCountLimit } from '@/mcp-server/tools/count-limit.js';

/**
 * Stubs WIKIDATA_CLAMP_LIMITS, then imports the helper fresh, so the lazily parsed server config
 * re-reads it. Cases that stub nothing use the static import.
 */
async function loadWithClampLimits(value: string) {
  vi.stubEnv('WIKIDATA_CLAMP_LIMITS', value);
  vi.resetModules();
  return (await import('@/mcp-server/tools/count-limit.js')).applyCountLimit;
}

const input = { field: 'limit', tool: 'wikidata_test_tool' };

describe('applyCountLimit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes a value at or below the cap through unchanged, without logging', () => {
    const ctx = createMockContext();
    const notice = vi.spyOn(ctx.log, 'notice');

    expect(applyCountLimit(1, 500, input, ctx)).toEqual({
      requested: 1,
      applied: 1,
      clamped: false,
    });
    expect(applyCountLimit(500, 500, input, ctx)).toEqual({
      requested: 500,
      applied: 500,
      clamped: false,
    });
    expect(notice).not.toHaveBeenCalled();
  });

  it('serves a value above the cap at the cap and logs the clamp by default', () => {
    const ctx = createMockContext();
    const notice = vi.spyOn(ctx.log, 'notice');

    expect(applyCountLimit(501, 500, input, ctx)).toEqual({
      requested: 501,
      applied: 500,
      clamped: true,
    });
    expect(notice).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ field: 'limit', requested: 501, applied: 500 }),
    );
  });

  it('treats WIKIDATA_CLAMP_LIMITS=true like the default', async () => {
    const fresh = await loadWithClampLimits('true');

    expect(fresh(800, 500, input, createMockContext()).applied).toBe(500);
  });

  it('rejects a value above the cap, naming it, when WIKIDATA_CLAMP_LIMITS=false', async () => {
    const fresh = await loadWithClampLimits('false');
    const ctx = createMockContext();

    let thrown: unknown;
    try {
      fresh(800, 500, input, ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
    expect((thrown as McpError).message).toContain('800');
    expect((thrown as McpError).message).toContain('500');
    expect((thrown as McpError).data).toMatchObject({ field: 'limit', requested: 800, cap: 500 });
  });

  it('still passes a value at the cap through when the switch is off', async () => {
    const fresh = await loadWithClampLimits('false');

    expect(fresh(500, 500, input, createMockContext()).clamped).toBe(false);
  });
});
