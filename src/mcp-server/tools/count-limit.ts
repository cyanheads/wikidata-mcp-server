/**
 * @fileoverview Per-call caps on count inputs and ID batches: serve a larger value at the cap and record
 * the clamp, or reject it when `WIKIDATA_CLAMP_LIMITS=false`.
 * @module mcp-server/tools/count-limit
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

const clampCounter = createCounter(
  'wikidata.count_limit.clamped',
  'Calls whose count input or ID batch was served at the per-call cap',
  '{calls}',
);

/** The outcome of applying a per-call cap to one input. */
export interface CountLimit {
  /** The value the caller applies: `requested`, or `cap` when clamped. */
  applied: number;
  clamped: boolean;
  requested: number;
}

/**
 * Applies a per-call `cap` to a caller's `requested` count (a `limit`, or a batch's distinct-ID count).
 * Above the cap it returns the cap, logs, and counts the clamp; the tool owns the caller-facing notice,
 * since only it knows what the clamp left out. With `WIKIDATA_CLAMP_LIMITS=false` it throws a
 * `ValidationError` naming the cap — its message is `input.rejection` when given (for a cap the caller
 * doesn't set directly, such as a result-row ceiling), else one naming the field and the cap.
 */
export function applyCountLimit(
  requested: number,
  cap: number,
  input: { field: string; tool: string; rejection?: string },
  ctx: Context,
): CountLimit {
  if (requested <= cap) return { requested, applied: requested, clamped: false };
  const { rejection, ...labels } = input;
  if (!getServerConfig().clampLimits) {
    throw validationError(
      rejection ??
        `${input.field} is ${requested}, above the per-call cap of ${cap}. Send at most ${cap}.`,
      { field: input.field, requested, cap },
    );
  }
  ctx.log.notice('Count input served at the per-call cap', { ...labels, requested, applied: cap });
  clampCounter.add(1, { tool: input.tool, field: input.field });
  return { requested, applied: cap, clamped: true };
}
