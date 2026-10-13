/**
 * @fileoverview UTF-8 byte length — the unit every response budget in this server is stated in.
 * @module mcp-server/tools/utf8-bytes
 */

const encoder = new TextEncoder();

/**
 * Byte length of `text` as UTF-8 on the wire. `String.prototype.length` counts UTF-16 code
 * units, which undercounts non-Latin text up to threefold (one CJK character is 1 unit, 3 bytes).
 */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** UTF-8 byte length of `value` serialized as JSON. */
export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}
