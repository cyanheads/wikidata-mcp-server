/**
 * @fileoverview Markdown rendering of normalized statements, shared by the tools that return
 * them: every statement with its id, rank, value, qualifiers, and each reference's parts.
 * @module mcp-server/tools/statement-format
 */

import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import type { NormalizedStatement } from '@/services/wikidata/types.js';
import { unitQid } from '@/services/wikidata/wikidata-rest-service.js';

/** Wikidata time precision codes, named. */
const TIME_PRECISION: Record<number, string> = {
  0: 'billion years',
  1: 'hundred million years',
  2: 'ten million years',
  3: 'million years',
  4: 'hundred thousand years',
  5: 'ten thousand years',
  6: 'millennium',
  7: 'century',
  8: 'decade',
  9: 'year',
  10: 'month',
  11: 'day',
  12: 'hour',
  13: 'minute',
  14: 'second',
};

/** The complete human-readable representation, before Markdown encoding. */
function statementValueText(value: NormalizedStatement['value']): string {
  switch (value.type) {
    case 'wikibase-item':
      return value.label ? `${value.label} (${value.qid})` : value.qid;
    case 'entity-id':
      return value.id;
    case 'time': {
      const name = TIME_PRECISION[value.precision];
      return `${value.time} (precision ${value.precision}${name ? `: ${name}` : ''})`;
    }
    case 'quantity': {
      const bounded =
        value.lowerBound !== undefined || value.upperBound !== undefined
          ? `${value.amount} [${value.lowerBound ?? '?'}, ${value.upperBound ?? '?'}]`
          : value.amount;
      if (!value.unit || value.unit === '1') return bounded;
      const unit = unitQid(value.unit) ?? value.unit;
      return value.unitLabel ? `${bounded} ${value.unitLabel} (${unit})` : `${bounded} (${unit})`;
    }
    case 'string':
    case 'external-id':
    case 'url':
      return value.value;
    case 'monolingualtext':
      return `${value.text} [${value.language}]`;
    case 'globe-coordinate':
      return value.precision !== undefined
        ? `${value.latitude}, ${value.longitude} (precision ${value.precision})`
        : `${value.latitude}, ${value.longitude}`;
    case 'somevalue':
      return 'unknown value';
    case 'novalue':
      return 'no value';
    case 'other':
      return JSON.stringify(value.raw ?? '');
    default:
      return '(unknown)';
  }
}

/** One statement value as literal text or a safe URL link. */
function formatStatementValue(value: NormalizedStatement['value']): string {
  return value.type === 'url'
    ? markdownLink(value.value, value.value)
    : escapeMarkdownInline(statementValueText(value));
}

/**
 * A `### P-ID` block per property: each statement's value and rank, its id, its qualifiers,
 * and every reference with all of its parts.
 */
export function statementLines(statements: Record<string, NormalizedStatement[]>): string[] {
  const lines: string[] = [];
  for (const [propId, stmts] of Object.entries(statements)) {
    lines.push('', `### ${propId}`);
    for (const stmt of stmts) {
      if (!stmt?.value) continue;
      const rankIndicator =
        stmt.rank === 'preferred' ? ' ★' : stmt.rank === 'deprecated' ? ' ~~(deprecated)~~' : '';
      lines.push(`- ${formatStatementValue(stmt.value)}${rankIndicator}`);
      if (stmt.id) lines.push(`  - id: ${stmt.id}`);
      for (const q of stmt.qualifiers ?? []) {
        if (!q?.value) continue;
        lines.push(`  - ${q.property}: ${formatStatementValue(q.value)}`);
      }
      if (stmt.references?.length) {
        lines.push(`  - **References (${stmt.references.length}):**`);
        stmt.references.forEach((reference, i) => {
          lines.push(`    - Reference ${i + 1}`);
          for (const part of reference.parts) {
            lines.push(`      - ${part.property}: ${formatStatementValue(part.value)}`);
          }
        });
      }
    }
  }
  return lines;
}
