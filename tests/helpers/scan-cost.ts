/**
 * @fileoverview Asserts that a scan over one large adversarial input stays far below what any
 * super-linear scan of it would cost, in this thread's own CPU time.
 * @module tests/helpers/scan-cost
 */

import { expect } from 'vitest';

/**
 * Adversarial input length. A linear scan of it costs at most ~20 ms of CPU here; a quadratic
 * one costs seconds — even a scan that restarts a native `indexOf` from every position, the
 * cheapest quadratic shape, measured ~2,000 ms at this size.
 */
const SIZE = 400_000;

/** Ten times the slowest linear scan, a tenth of the cheapest quadratic one. */
const CEILING_MS = 200;

const cpuMs = (): number => {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1_000;
};

/**
 * Runs `scan` once over `build(SIZE)` and asserts it stays under CEILING_MS of this thread's CPU
 * time. One absolute bound at one size, not a ratio between sizes: CPU time excludes time spent
 * descheduled, and the order-of-magnitude margin on each side absorbs cache and frequency noise
 * that a small-input timing cannot. A warm-up call on short input first, so JIT and regex
 * compilation are not charged to the measured scan.
 */
export function expectBoundedScan(
  build: (size: number) => string,
  scan: (input: string) => unknown,
): void {
  scan(build(1_000));
  const input = build(SIZE);
  const start = cpuMs();
  scan(input);
  const elapsed = cpuMs() - start;
  expect(elapsed, `CPU ms to scan ${SIZE} characters`).toBeLessThan(CEILING_MS);
}
