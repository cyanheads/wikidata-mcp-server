/**
 * @fileoverview Language-code input schemas shared by every tool that takes a `language` or
 * `languages` parameter.
 * @module mcp-server/tools/language-code
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Language used when the caller sends none — or sends a blank single `language`. */
export const DEFAULT_LANGUAGE = 'en';

/**
 * The canonical form of a Wikibase language code — lowercase subtags joined by `-` — which
 * every accepted input normalizes onto. It covers all of Wikidata's content-language codes,
 * term and monolingual-text contexts alike, and admits no quote, backslash, brace, `|`, or
 * whitespace, so a normalized code is safe to splice into a SPARQL string literal.
 */
export const LANGUAGE_CODE_PATTERN = /^[a-z]{2,8}(?:-[a-z0-9]{1,9})*$/;

/**
 * One code as a caller may send it: any case, `-` or `_` between subtags. Normalizing such a
 * code (lowercase, `_` → `-`) yields exactly the strings LANGUAGE_CODE_PATTERN accepts.
 */
const CODE = '[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,9})*';

/**
 * The advertised patterns. They describe what callers may *send* — surrounding whitespace, any
 * case, `_` separators — because a `pattern` holding only the canonical form would make a
 * validating client refuse `EN` or `en_GB`, inputs the server normalizes and accepts. The
 * whitespace sits outside an optional group, so a run of it is matched once rather than retried
 * at every split point.
 */
const SINGLE_INPUT = new RegExp(`^\\s*(?:${CODE}\\s*)?$`);
const LIST_INPUT = `^\\s*(?:${CODE}(?:\\s*,\\s*${CODE})*\\s*)?$`;

/**
 * Validates a fallback list one entry at a time, reusing the single-code pattern. Equivalent to
 * LIST_INPUT, which is only advertised; the tests hold the two to the same verdicts.
 */
const isFallbackList = (list: string): boolean =>
  !list.trim() || list.split(',').every((code) => code.trim() !== '' && SINGLE_INPUT.test(code));

const INVALID_CODE =
  'Expected a Wikidata language code: 2–8 letters, then optional subtags of letters or digits joined by "-" (e.g. "en", "de", "pt-br", "zh-hant").';

const normalizeCode = (code: string): string => code.trim().toLowerCase().replaceAll('_', '-');

/** One code, with blank entries normalized to `''` for the array schemas to drop. */
const languageCodeEntry = () =>
  z.string().regex(SINGLE_INPUT, INVALID_CODE).overwrite(normalizeCode);

/**
 * A single language code. A blank value means unset, so a form client that sends `""` for an
 * untouched field gets the default rather than an empty language.
 */
export const languageCode = () => languageCodeEntry().overwrite((code) => code || DEFAULT_LANGUAGE);

/**
 * A comma-separated fallback list of codes (`fr,en`), for the SPARQL label SERVICE, which tries
 * each in turn. Normalized to `fr,en` whatever the spacing; a blank list means the default.
 */
export const languageFallbackList = () =>
  z
    .string()
    .refine(isFallbackList, `${INVALID_CODE} Separate fallback codes with commas (e.g. "fr,en").`)
    .meta({ pattern: LIST_INPUT })
    .overwrite(
      (list) =>
        [...new Set(list.split(',').map(normalizeCode).filter(Boolean))].join(',') ||
        DEFAULT_LANGUAGE,
    );

/**
 * An array of codes. Blank entries are dropped and repeats collapsed; when nothing remains the
 * result is `whenEmpty`, so `[]` behaves like an omitted field.
 */
export const languageCodes = (whenEmpty: string[]) =>
  z.array(languageCodeEntry()).overwrite((codes) => {
    const unique = [...new Set(codes.filter(Boolean))];
    return unique.length ? unique : whenEmpty;
  });
