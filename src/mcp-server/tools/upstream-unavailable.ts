/**
 * @fileoverview Whether a failed upstream request means the upstream did not answer — the one kind
 * of failure a tool degrades past rather than rethrowing.
 * @module mcp-server/tools/upstream-unavailable
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/** The framework's upstream-failure codes: the upstream did not answer, as opposed to refusing the request. */
const UNAVAILABLE_CODES = new Set<number>([
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.RateLimited,
  JsonRpcErrorCode.Timeout,
]);

/**
 * True when a request failed because its upstream could not be reached, was rate-limiting, or did
 * not answer in time. The Wikidata services report a network failure as ServiceUnavailable. Caller
 * cancellation, a refusal of the request itself, and anything else do not match.
 */
export const isUpstreamUnavailable = (err: unknown): boolean =>
  err instanceof McpError && UNAVAILABLE_CODES.has(err.code);
