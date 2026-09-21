/**
 * AgentDefinition: a GLOBAL specialist, and the invariants that keep it one
 * (ADR 002, ADR 005).
 */

import { describe, expect, it } from 'vitest';

import type { AgentDefinition } from '../src/index.js';
import {
  createAgentDefinition,
  createSkill,
  normalizeRole,
  SkillKind,
  ToolMode,
  updateAgentDefinition,
} from '../src/index.js';
import { testDeps } from './support.js';

/**
 * Compile-time guard, in two halves.
 *
 * `ForbiddenRuntimeState` keeps provider/runtime state off the definition
 * (ADR 002). `ForbiddenProjectScope` keeps project-scoped fields off it
 * (ADR 005) — an agent is global, so a `projectId` here would re-own it.
 *
 * If either set gains a member, this stops being `never` and the build fails.
 * Review catches this inconsistently; the type checker does not.
 */
type ForbiddenRuntimeState =
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

type ForbiddenProjectScope = 'projectId' | 'projectIds' | 'taskId' | 'seatId' | 'managerAgentId';

type LeakedFields = Extract<keyof AgentDefinition, ForbiddenRuntimeState | ForbiddenProjectScope>;
type DefinitionIsClean = [LeakedFields] extends [never] ? true : false;

describe('AgentDefinition', () => {
  it('carries neither runtime state nor project scope', () => {
    const clean: DefinitionIsClean = true;
    expect(clean).toBe(true);

    const deps = testDeps();
    const agent = createAgentDefinition(
      { name: 'Manager', role: 'manager', provider: 'claude' },
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
      'projectId',
      'taskId',
      'seatId',
      'managerAgentId',
    ];
    expect(Object.keys(agent).filter((key) => forbidden.includes(key))).toEqual([]);
  });

  it('is created without any project', () => {
    const deps = testDeps();
    const agent = createAgentDefinition(
      { name: 'Researcher', role: 'Research', provider: 'claude' },
      deps,
    );

    expect(agent.role).toBe('research');
    expect(agent.provider).toBe('claude');
    expect(agent.tools).toEqual([]);
    expect(agent.memory.notes).toBe('');
    expect(agent.memory.recentTaskSummaryLimit).toBe(5);
    expect(agent.createdAt).toBe(agent.updatedAt);
    expect('projectId' in agent).toBe(false);
  });

  it('owns its own instructions', () => {
    const deps = testDeps();
    const agent = createAgentDefinition(
      {
        name: 'Spec',
        role: 'spec',
        provider: 'claude',
        systemPrompt: 'You write acceptance criteria.',
      },
      deps,
    );
    expect(agent.systemPrompt).toBe('You write acceptance criteria.');
  });

  it('normalises the role key but does not require it to be unique', () => {
    expect(normalizeRole('Design System')).toBe('design-system');
    expect(normalizeRole('  UX_Research ')).toBe('ux-research');
    expect(() => normalizeRole('   ')).toThrow(/must not be empty/);

    // Two agents may legitimately share a role and differ in configuration.
    const deps = testDeps();
    const a = createAgentDefinition({ name: 'UX A', role: 'ux', provider: 'claude' }, deps);
    const b = createAgentDefinition({ name: 'UX B', role: 'ux', provider: 'claude' }, deps);
    expect(a.role).toBe(b.role);
    expect(a.id).not.toBe(b.id);
  });

  it('rejects an empty name or provider', () => {
    const deps = testDeps();
    expect(() =>
      createAgentDefinition({ name: '  ', role: 'ux', provider: 'claude' }, deps),
    ).toThrow(/agent.name/);
    expect(() => createAgentDefinition({ name: 'UX', role: 'ux', provider: '' }, deps)).toThrow(
      /agent.provider/,
    );
  });

  it('updates fields and bumps updatedAt without touching identity', () => {
    const deps = testDeps();
    const agent = createAgentDefinition({ name: 'UI', role: 'ui', provider: 'claude' }, deps);
    const updated = updateAgentDefinition(
      agent,
      { name: 'UI v2', tools: [{ name: 'Read', mode: ToolMode.ALLOW }] },
      deps.clock,
    );

    expect(updated.id).toBe(agent.id);
    expect(updated.createdAt).toBe(agent.createdAt);
    expect(updated.name).toBe('UI v2');
    expect(updated.tools).toHaveLength(1);
    expect(updated.updatedAt).not.toBe(agent.updatedAt);
  });

  it('holds no skill list: ownership points from the skill to the agent', () => {
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

    // One source of truth: the skill names its owner, the agent holds no copy.
    expect(skill.agentId).toBe(agent.id);
    expect('skillIds' in agent).toBe(false);
    expect('skills' in agent).toBe(false);
  });
});
