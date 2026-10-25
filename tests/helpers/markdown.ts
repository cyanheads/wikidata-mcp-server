/**
 * @fileoverview Decode authored inline Markdown for assertions on displayed values.
 * @module tests/helpers/markdown
 */

import MarkdownIt from 'markdown-it';

const parser = new MarkdownIt('commonmark');

/** The text a CommonMark client reads, preserving inline line breaks. */
export function inlineText(markdown: string): string {
  return parser
    .parseInline(markdown, {})
    .flatMap((token) => token.children ?? [])
    .map((token) =>
      token.type === 'softbreak' || token.type === 'hardbreak' ? '\n' : token.content,
    )
    .join('');
}
