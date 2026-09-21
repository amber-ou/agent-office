/**
 * Skill: owned by one agent, not a global library (ADR 005).
 */

import { describe, expect, it } from 'vitest';

import type { Skill } from '../src/index.js';
import {
  createAgentDefinition,
  createSkill,
  isSkillOwnedBy,
  normalizeSlug,
  SkillKind,
  updateSkill,
} from '../src/index.js';
import { testDeps } from './support.js';

/** Compile-time guard: a skill is owned by an agent, never by a project. */
type SkillIsAgentOwned = [Extract<keyof Skill, 'projectId'>] extends [never] ? true : false;

describe('Skill', () => {
  it('belongs to exactly one agent and to no project', () => {
    const scoped: SkillIsAgentOwned = true;
    expect(scoped).toBe(true);

    const deps = testDeps();
    const agent = createAgentDefinition({ name: 'UX', role: 'ux', provider: 'claude' }, deps);
    const skill = createSkill(
      {
        agentId: agent.id,
        slug: 'user-research',
        name: 'User Research',
        kind: SkillKind.WORKFLOW,
        source: { origin: 'content', ref: { store: 'inline', content: '# steps' } },
      },
      deps,
    );

    expect(skill.agentId).toBe(agent.id);
    expect('projectId' in skill).toBe(false);
    expect(isSkillOwnedBy(skill, agent.id)).toBe(true);
  });

  it('is not shared between agents: each owns its own copy', () => {
    const deps = testDeps();
    const ux = createAgentDefinition({ name: 'UX', role: 'ux', provider: 'claude' }, deps);
    const research = createAgentDefinition(
      { name: 'Research', role: 'research', provider: 'claude' },
      deps,
    );

    // Same slug, two agents, two independent skills. Nothing links them.
    const uxSkill = createSkill(
      {
        agentId: ux.id,
        slug: 'user-research',
        name: 'User Research',
        kind: SkillKind.WORKFLOW,
        source: { origin: 'content', ref: { store: 'inline', content: '# ux version' } },
      },
      deps,
    );
    const researchSkill = createSkill(
      {
        agentId: research.id,
        slug: 'user-research',
        name: 'User Research',
        kind: SkillKind.WORKFLOW,
        source: { origin: 'content', ref: { store: 'inline', content: '# research version' } },
      },
      deps,
    );

    expect(uxSkill.id).not.toBe(researchSkill.id);
    expect(uxSkill.slug).toBe(researchSkill.slug);
    expect(isSkillOwnedBy(uxSkill, research.id)).toBe(false);
    expect(isSkillOwnedBy(researchSkill, ux.id)).toBe(false);
  });

  it('cannot be re-homed by an edit', () => {
    const deps = testDeps();
    const ux = createAgentDefinition({ name: 'UX', role: 'ux', provider: 'claude' }, deps);
    const other = createAgentDefinition({ name: 'UI', role: 'ui', provider: 'claude' }, deps);
    const skill = createSkill(
      {
        agentId: ux.id,
        slug: 'component-spec',
        name: 'Component Spec',
        kind: SkillKind.INSTRUCTION,
        source: { origin: 'content', ref: { store: 'inline', content: '# v1' } },
      },
      deps,
    );

    // `agentId` is absent from SkillPatch, so this does not type-check as an
    // edit. The runtime check confirms the owner survives a patch regardless.
    const patched = updateSkill(skill, { name: 'Component Spec v2' }, deps.clock);
    expect(patched.agentId).toBe(ux.id);
    expect(patched.agentId).not.toBe(other.id);
  });

  it('normalises slugs', () => {
    expect(normalizeSlug('UX_Research')).toBe('ux-research');
    expect(normalizeSlug(' Design Token ')).toBe('design-token');
  });

  it('expresses sources that are not prompt strings', () => {
    const deps = testDeps();
    const agent = createAgentDefinition({ name: 'UI', role: 'ui', provider: 'claude' }, deps);

    const instruction = createSkill(
      {
        agentId: agent.id,
        slug: 'product-spec',
        name: 'Product Spec',
        kind: SkillKind.INSTRUCTION,
        source: { origin: 'content', ref: { store: 'inline', content: '# how to spec' } },
      },
      deps,
    );
    const mcp = createSkill(
      {
        agentId: agent.id,
        slug: 'figma-read',
        name: 'Read Figma',
        kind: SkillKind.MCP_CAPABILITY,
        source: { origin: 'mcp', server: 'figma', tool: 'get_file' },
        requiredTools: ['mcp__figma__get_file'],
      },
      deps,
    );
    const script = createSkill(
      {
        agentId: agent.id,
        slug: 'lighthouse',
        name: 'Lighthouse Audit',
        kind: SkillKind.SCRIPT,
        source: { origin: 'content', ref: { store: 'file', path: 'scripts/lighthouse.mjs' } },
      },
      deps,
    );
    const external = createSkill(
      {
        agentId: agent.id,
        slug: 'jira-sync',
        name: 'Jira Sync',
        kind: SkillKind.EXTERNAL,
        source: { origin: 'integration', integration: 'jira', config: { project: 'AIWOW' } },
      },
      deps,
    );

    expect(instruction.source.origin).toBe('content');
    expect(mcp.source).toEqual({ origin: 'mcp', server: 'figma', tool: 'get_file' });
    expect(script.kind).toBe(SkillKind.SCRIPT);
    expect(external.source.origin).toBe('integration');
    // Kind and source are orthogonal.
    expect(instruction.kind).not.toBe(script.kind);
  });

  it('can change its source without changing its identity or owner', () => {
    const deps = testDeps();
    const agent = createAgentDefinition(
      { name: 'DS', role: 'design-system', provider: 'claude' },
      deps,
    );
    const skill = createSkill(
      {
        agentId: agent.id,
        slug: 'component-spec',
        name: 'Component Spec',
        kind: SkillKind.INSTRUCTION,
        source: { origin: 'content', ref: { store: 'inline', content: '# v1' } },
      },
      deps,
    );

    const migrated = updateSkill(
      skill,
      { kind: SkillKind.MCP_CAPABILITY, source: { origin: 'mcp', server: 'design-system' } },
      deps.clock,
    );

    expect(migrated.id).toBe(skill.id);
    expect(migrated.agentId).toBe(agent.id);
    expect(migrated.slug).toBe(skill.slug);
    expect(migrated.source).toEqual({ origin: 'mcp', server: 'design-system' });
  });
});
