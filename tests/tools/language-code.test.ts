/**
 * @fileoverview Tests for the shared language-code input schemas — normalization, rejection,
 * the advertised JSON Schema, every Wikibase content-language code, and scan cost.
 * @module tests/tools/language-code.test
 */

import { readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_CODE_PATTERN,
  languageCode,
  languageCodes,
  languageFallbackList,
} from '@/mcp-server/tools/language-code.js';
import { expectBoundedScan } from '../helpers/scan-cost.js';

/**
 * Every content-language code Wikidata served on 2026-10-13, for both the `term` context
 * (labels, descriptions, aliases) and the `monolingualtext` context (statement values).
 */
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/wikibase-content-languages.json', import.meta.url), 'utf8'),
) as { term: string[]; monolingualtext: string[] };

const single = languageCode();
const list = languageFallbackList();
const array = languageCodes([DEFAULT_LANGUAGE]);

/** Values each tool must reject before any upstream call. */
const HOSTILE = [
  'en" || true || "',
  'en"',
  'en\\',
  'en}',
  '{en',
  'en|de',
  'en gb',
  '[AUTO_LANGUAGE]',
  'en\nde',
  'e',
  'abcdefghi',
  'en-',
  '-en',
  'en--gb',
  'en-abcdefghij',
  'en_',
];

describe('language-code schemas', () => {
  describe('content-language fixture', () => {
    it('holds both contexts at the counts Wikidata served', () => {
      expect(fixture.term).toHaveLength(637);
      expect(fixture.monolingualtext).toHaveLength(1474);
    });

    it.each([
      ['term', fixture.term],
      ['monolingualtext', fixture.monolingualtext],
    ])('accepts every %s code unchanged through all three schemas', (_context, codes) => {
      const rejected = codes.filter(
        (code) =>
          single.safeParse(code).data !== code ||
          list.safeParse(code).data !== code ||
          array.safeParse([code]).data?.[0] !== code,
      );
      expect(rejected).toEqual([]);
    });

    it('normalizes every code sent uppercase with _ separators back to the code', () => {
      const all = [...new Set([...fixture.term, ...fixture.monolingualtext])];
      const drifted = all.filter(
        (code) => single.parse(` ${code.toUpperCase().replaceAll('-', '_')} `) !== code,
      );
      expect(drifted).toEqual([]);
    });
  });

  describe('languageCode (single)', () => {
    it.each([
      ['EN', 'en'],
      ['en-GB', 'en-gb'],
      ['en_gb', 'en-gb'],
      ['  de  ', 'de'],
      ['zh_Hant', 'zh-hant'],
    ])('normalizes %j to %j', (input, expected) => {
      expect(single.parse(input)).toBe(expected);
    });

    it.each([[''], ['   '], ['\t\n']])('treats blank %j as the default language', (input) => {
      expect(single.parse(input)).toBe(DEFAULT_LANGUAGE);
    });

    it.each(HOSTILE.map((v) => [v]))('rejects %j', (input) => {
      expect(single.safeParse(input).success).toBe(false);
    });

    it('rejects a comma-separated list', () => {
      expect(single.safeParse('fr,en').success).toBe(false);
    });

    it('every accepted value matches the canonical pattern', () => {
      for (const input of ['EN', 'en_GB', ' pt-BR ', 'sr-EC', '', 'mul']) {
        expect(single.parse(input)).toMatch(LANGUAGE_CODE_PATTERN);
      }
    });
  });

  describe('languageFallbackList', () => {
    it.each([
      ['fr,en', 'fr,en'],
      ['fr, en', 'fr,en'],
      [' FR , en_GB ', 'fr,en-gb'],
      ['de', 'de'],
      ['fr,fr,en', 'fr,en'],
      ['', DEFAULT_LANGUAGE],
      ['  ', DEFAULT_LANGUAGE],
    ])('normalizes %j to %j', (input, expected) => {
      expect(list.parse(input)).toBe(expected);
    });

    it.each([...HOSTILE, 'fr,', ',en', 'fr,,en', ' , ', 'fr;en'].map((v) => [v]))(
      'rejects %j',
      (input) => {
        expect(list.safeParse(input).success).toBe(false);
      },
    );
  });

  describe('languageCodes (array)', () => {
    it('drops blank entries and collapses repeats after normalization', () => {
      expect(array.parse(['EN', '', ' en ', 'de', '  '])).toEqual(['en', 'de']);
    });

    it.each([[[]], [['']], [['', '  ']]])('maps %j to the empty-case value', (input) => {
      expect(array.parse(input)).toEqual([DEFAULT_LANGUAGE]);
      expect(languageCodes([]).parse(input)).toEqual([]);
    });

    it.each(HOSTILE.map((v) => [v]))('rejects an entry %j', (input) => {
      expect(array.safeParse(['en', input]).success).toBe(false);
    });
  });

  /**
   * The JSON Schema `pattern` is what a validating client checks before sending. It must
   * describe the inputs the server accepts — a canonical-only pattern would make such a
   * client refuse `EN` — while still rejecting what the server rejects.
   */
  describe('advertised JSON Schema', () => {
    const emitted = (schema: z.ZodType) =>
      z.toJSONSchema(schema, { io: 'input' }) as { pattern?: string; items?: { pattern?: string } };

    it.each([
      ['single', emitted(single).pattern],
      ['list', emitted(list).pattern],
      ['array item', emitted(array).items?.pattern],
    ])('the %s pattern admits mixed case, _ separators, and padding', (_name, pattern) => {
      expect(pattern).toBeDefined();
      const re = new RegExp(pattern as string);
      for (const input of ['en', 'EN', 'en_GB', ' de ', '']) expect(re.test(input)).toBe(true);
      for (const input of ['en"', 'en gb', '[AUTO_LANGUAGE]', 'en|de']) {
        expect(re.test(input)).toBe(false);
      }
    });

    /** The list is validated entry by entry, not by its advertised pattern — the two must agree. */
    it('the list pattern accepts exactly what the list schema accepts', () => {
      const re = new RegExp(emitted(list).pattern as string);
      const inputs = [
        ...HOSTILE,
        ...['fr,en', 'fr, en', ' FR , en_GB ', 'de', '', '  ', 'fr,', ',en', 'fr,,en', ' , '],
        ...['fr;en', 'fr ,en', 'fr, en ,de', 'en,\nde', 'en\t,\tde', 'mul,en'],
      ];
      const disagreements = inputs.filter(
        (input) => re.test(input) !== list.safeParse(input).success,
      );
      expect(disagreements).toEqual([]);
    });

    it('the list pattern admits a comma-separated list; the single pattern does not', () => {
      expect(new RegExp(emitted(list).pattern as string).test('fr, en')).toBe(true);
      expect(new RegExp(emitted(single).pattern as string).test('fr, en')).toBe(false);
    });
  });

  /**
   * The patterns run over caller-sized text with no length cap. Each worst case is a repeated
   * opener that never closes or a long run the pattern must backtrack over.
   */
  describe('scan cost', () => {
    it.each<[string, (n: number) => string]>([
      ['whitespace run then a bad character', (n) => `${' '.repeat(n)}"`],
      ['code then a whitespace run then a bad character', (n) => `en${' '.repeat(n)}"`],
      ['long subtag chain with a bad tail', (n) => `${'en-gb'.repeat(n / 5)}"`],
      ['comma list with a dangling comma', (n) => `${'fr, '.repeat(n / 4)},`],
      ['comma list with spaces then a bad character', (n) => `fr${' ,  en'.repeat(n / 6)}"`],
      ['comma run', (n) => ','.repeat(n)],
    ])('%s stays under the super-linear ceiling at 400k characters', (_name, build) => {
      expectBoundedScan(build, (input) => {
        single.safeParse(input);
        list.safeParse(input);
        array.safeParse([input]);
      });
    });
  });
});
