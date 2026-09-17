/**
 * Skill definition — reusable, referenced by id, not bound to a prompt string
 * (requirement 9).
 */

import { describe, expect, it } from 'vitest';

import {
  createProject,
  createSkill,
  isSkillAvailableTo,
  normalizeSlug,
  SkillKind,
  updateSkill,
} from '../src/index.js';
import { testDeps } from './support.js';

describe('Skill', () => {
  it('normalises slugs', () => {
    expect(normalizeSlug('UX_Research')).toBe('ux-research');
    expect(normalizeSlug(' Design Token ')).toBe('design-token');
  });

  it('expresses sources that are not prompt strings', () => {
    const deps = testDeps();
    const project = createProject({ name: 'AiWow' }, deps);

    const instruction = createSkill(
      {
        projectId: null,
        slug: 'product-spec',
        name: 'Product Spec',
        kind: SkillKind.INSTRUCTION,
        source: { origin: 'content', ref: { store: 'inline', content: '# how to spec' } },
      },
      deps,
    );
    const mcp = createSkill(
      {
        projectId: project.id,
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
        projectId: project.id,
        slug: 'lighthouse',
        name: 'Lighthouse Audit',
        kind: SkillKind.SCRIPT,
        source: { origin: 'content', ref: { store: 'file', path: 'scripts/lighthouse.mjs' } },
      },
      deps,
    );
    const external = createSkill(
      {
        projectId: project.id,
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
    // Kind and source are orthogonal: the same kind can come from either origin.
    expect(instruction.kind).not.toBe(script.kind);
  });

  it('scopes global skills to everyone and project skills to one project', () => {
    const deps = testDeps();
    const a = createProject({ name: 'AiWow' }, deps);
    const b = createProject({ name: 'Other' }, deps);

    const global = createSkill(
      {
        projectId: null,
        slug: 'ux-research',
        name: 'UX Research',
        kind: SkillKind.WORKFLOW,
        source: { origin: 'content', ref: { store: 'inline', content: '# steps' } },
      },
      deps,
    );
    const private_ = createSkill(
      {
        projectId: a.id,
        slug: 'aiwow-tone',
        name: 'AiWow Tone',
        kind: SkillKind.INSTRUCTION,
        source: { origin: 'content', ref: { store: 'inline', content: '# tone' } },
      },
      deps,
    );

    expect(isSkillAvailableTo(global, a.id)).toBe(true);
    expect(isSkillAvailableTo(global, b.id)).toBe(true);
    expect(isSkillAvailableTo(private_, a.id)).toBe(true);
    expect(isSkillAvailableTo(private_, b.id)).toBe(false);
  });

  it('can change its source without changing its identity', () => {
    const deps = testDeps();
    const skill = createSkill(
      {
        projectId: null,
        slug: 'component-spec',
        name: 'Component Spec',
        kind: SkillKind.INSTRUCTION,
        source: { origin: 'content', ref: { store: 'inline', content: '# v1' } },
      },
      deps,
    );

    // Today inline markdown, tomorrow an MCP capability. Every agent that
    // references this skill by id is unaffected.
    const migrated = updateSkill(
      skill,
      { kind: SkillKind.MCP_CAPABILITY, source: { origin: 'mcp', server: 'design-system' } },
      deps.clock,
    );

    expect(migrated.id).toBe(skill.id);
    expect(migrated.slug).toBe(skill.slug);
    expect(migrated.source).toEqual({ origin: 'mcp', server: 'design-system' });
  });
});
