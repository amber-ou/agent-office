/**
 * AgentDefinition, and the invariant that keeps it a definition (ADR 002).
 */

import { describe, expect, it } from 'vitest';

import type { AgentDefinition } from '../src/index.js';
import {
  assignSkill,
  createAgentDefinition,
  createProject,
  createSkill,
  normalizeRole,
  SkillKind,
  ToolMode,
  unassignSkill,
  updateAgentDefinition,
} from '../src/index.js';
import { testDeps } from './support.js';

/**
 * Compile-time guard: no provider-specific runtime state on AgentDefinition.
 *
 * If someone adds `providerSessionId` or `status` to the interface, this stops
 * being `never` and the build fails — which is the point. Review catches this
 * inconsistently; the type checker does not.
 */
type ForbiddenOnDefinition =
  | 'status'
  | 'sessionId'
  | 'providerSessionId'
  | 'runtimeAgentId'
  | 'runtimeId'
  | 'terminalId'
  | 'terminalName'
  | 'processId'
  | 'pid'
  | 'transcriptPath'
  | 'jsonlFile'
  | 'hookDelivered'
  | 'currentTaskId';

type LeakedFields = Extract<keyof AgentDefinition, ForbiddenOnDefinition>;
type DefinitionIsClean = [LeakedFields] extends [never] ? true : false;

describe('AgentDefinition', () => {
  it('carries no provider-specific runtime state', () => {
    const clean: DefinitionIsClean = true;
    expect(clean).toBe(true);

    // Runtime assertion as well, so a structurally-typed escape hatch is caught.
    const deps = testDeps();
    const project = createProject({ name: 'AiWow' }, deps);
    const agent = createAgentDefinition(
      { projectId: project.id, name: 'Manager Agent', role: 'manager', provider: 'claude' },
      deps,
    );
    const forbidden = [
      'status',
      'sessionId',
      'providerSessionId',
      'runtimeAgentId',
      'terminalId',
      'processId',
      'transcriptPath',
      'currentTaskId',
    ];
    expect(Object.keys(agent).filter((key) => forbidden.includes(key))).toEqual([]);
  });

  it('normalises the role key', () => {
    expect(normalizeRole('Design System')).toBe('design-system');
    expect(normalizeRole('  UX_Research ')).toBe('ux-research');
    expect(() => normalizeRole('   ')).toThrow(/must not be empty/);
  });

  it('creates a definition with defaults and keeps the project link', () => {
    const deps = testDeps();
    const project = createProject({ name: 'AiWow' }, deps);
    const agent = createAgentDefinition(
      { projectId: project.id, name: 'UX Agent', role: 'UX', provider: 'claude' },
      deps,
    );

    expect(agent.projectId).toBe(project.id);
    expect(agent.role).toBe('ux');
    expect(agent.provider).toBe('claude');
    expect(agent.skillIds).toEqual([]);
    expect(agent.tools).toEqual([]);
    expect(agent.memory.recentTaskSummaryLimit).toBe(5);
    expect(agent.createdAt).toBe(agent.updatedAt);
  });

  it('rejects an empty name or provider', () => {
    const deps = testDeps();
    const project = createProject({ name: 'AiWow' }, deps);
    expect(() =>
      createAgentDefinition(
        { projectId: project.id, name: '  ', role: 'ux', provider: 'claude' },
        deps,
      ),
    ).toThrow(/agent.name/);
    expect(() =>
      createAgentDefinition({ projectId: project.id, name: 'UX', role: 'ux', provider: '' }, deps),
    ).toThrow(/agent.provider/);
  });

  it('updates fields and bumps updatedAt without touching identity', () => {
    const deps = testDeps();
    const project = createProject({ name: 'AiWow' }, deps);
    const agent = createAgentDefinition(
      { projectId: project.id, name: 'UI Agent', role: 'ui', provider: 'claude' },
      deps,
    );
    const updated = updateAgentDefinition(
      agent,
      { name: 'UI Agent v2', tools: [{ name: 'Read', mode: ToolMode.ALLOW }] },
      deps.clock,
    );

    expect(updated.id).toBe(agent.id);
    expect(updated.createdAt).toBe(agent.createdAt);
    expect(updated.name).toBe('UI Agent v2');
    expect(updated.tools).toHaveLength(1);
    expect(updated.updatedAt).not.toBe(agent.updatedAt);
  });

  it('references skills by id and never embeds them (requirement 9)', () => {
    const deps = testDeps();
    const project = createProject({ name: 'AiWow' }, deps);
    const agent = createAgentDefinition(
      { projectId: project.id, name: 'UX Agent', role: 'ux', provider: 'claude' },
      deps,
    );
    const research = createSkill(
      {
        projectId: null,
        slug: 'ux-research',
        name: 'UX Research',
        kind: SkillKind.WORKFLOW,
        source: { origin: 'content', ref: { store: 'inline', content: '# steps' } },
      },
      deps,
    );

    const withSkill = assignSkill(agent, research.id, deps.clock);
    expect(withSkill.skillIds).toEqual([research.id]);
    // The reference is an id, not a Skill object.
    expect(typeof withSkill.skillIds[0]).toBe('string');

    // Assigning twice is idempotent and does not duplicate.
    const again = assignSkill(withSkill, research.id, deps.clock);
    expect(again.skillIds).toEqual([research.id]);
    expect(again).toBe(withSkill);

    const removed = unassignSkill(again, research.id, deps.clock);
    expect(removed.skillIds).toEqual([]);
  });

  it('lets several agents share one skill definition', () => {
    const deps = testDeps();
    const project = createProject({ name: 'AiWow' }, deps);
    const skill = createSkill(
      {
        projectId: null,
        slug: 'user-flow',
        name: 'User Flow',
        kind: SkillKind.WORKFLOW,
        source: { origin: 'content', ref: { store: 'inline', content: '# flow' } },
      },
      deps,
    );
    const ux = assignSkill(
      createAgentDefinition(
        { projectId: project.id, name: 'UX Agent', role: 'ux', provider: 'claude' },
        deps,
      ),
      skill.id,
      deps.clock,
    );
    const ui = assignSkill(
      createAgentDefinition(
        { projectId: project.id, name: 'UI Agent', role: 'ui', provider: 'claude' },
        deps,
      ),
      skill.id,
      deps.clock,
    );

    expect(ux.skillIds).toEqual(ui.skillIds);
    expect(ux.id).not.toBe(ui.id);
  });
});
