/**
 * @fileoverview Bundle pruning preserves executable skill modules while removing package-root agent docs.
 * @module tests/scripts/agent-doc-entries
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY } from '../../scripts/lint-packaging.js';

describe('dependency agent documentation', () => {
  const runtime = [
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/parent/node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/example/dist/skills/loader.js',
    'skills/wikidata-guide/SKILL.md',
  ];
  const documentation = [
    'node_modules/example/skills/guide/SKILL.md',
    'node_modules/@scope/example/framework-skills/add-tool/SKILL.md',
    'node_modules/parent/node_modules/@scope/example/.claude/skills/guide/SKILL.md',
    'node_modules/parent/node_modules/example/.agents/guide.md',
    'node_modules/example/SKILL.md',
  ];

  it('preserves SDK and nested runtime modules', () => {
    expect(filterAgentDocEntries(runtime)).toEqual([]);
    expect(runtime.filter((entry) => AGENT_DOC_ENTRY.test(entry))).toEqual([]);
  });

  it('removes documentation only at installed package roots', () => {
    expect(filterAgentDocEntries(documentation)).toEqual(documentation);
    expect(documentation.filter((entry) => AGENT_DOC_ENTRY.test(entry))).toEqual(documentation);
  });
});
