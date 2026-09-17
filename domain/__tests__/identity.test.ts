/**
 * Entity identity (requirement 7).
 *
 * Every entity is keyed by an Agent Office-generated canonical uuid. The point of
 * these tests is that nothing else can become a key: not an index, not a Claude
 * session id, not upstream's numeric agent id.
 */

import { describe, expect, it } from 'vitest';

import {
  asAgentId,
  asProjectId,
  createAgentDefinition,
  createKnowledgeItem,
  createOutputItem,
  createProject,
  createSkill,
  createTask,
  isCanonicalId,
  KnowledgeType,
  OutputType,
  SkillKind,
  startSession,
  uuidIdGenerator,
} from '../src/index.js';
import { testDeps } from './support.js';

describe('canonical identity', () => {
  it('accepts a canonical uuid and rejects everything else', () => {
    expect(isCanonicalId('3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d')).toBe(true);
    expect(isCanonicalId('')).toBe(false);
    expect(isCanonicalId('7')).toBe(false);
    expect(isCanonicalId('agent-1')).toBe(false);
    expect(isCanonicalId('ux-agent')).toBe(false);
  });

  it('refuses to brand a provider id or an index as a domain key', () => {
    // An upstream numeric agent id.
    expect(() => asAgentId('7')).toThrow(TypeError);
    // A Claude session id is a uuid, so it WOULD pass the shape check — the
    // guard against it is architectural (ADR 002), not lexical. What must fail
    // is anything that is not uuid-shaped at all.
    expect(() => asProjectId('project-aiwow')).toThrow(TypeError);
    expect(() => asProjectId('0')).toThrow(TypeError);
  });

  it('generates canonical uuids from the default generator', () => {
    const first = uuidIdGenerator.next();
    const second = uuidIdGenerator.next();
    expect(isCanonicalId(first)).toBe(true);
    expect(isCanonicalId(second)).toBe(true);
    expect(first).not.toBe(second);
  });

  it('gives every entity type a canonical id at creation', () => {
    const deps = testDeps();
    const project = createProject({ name: 'AiWow' }, deps);
    const agent = createAgentDefinition(
      { projectId: project.id, name: 'UX Agent', role: 'ux', provider: 'claude' },
      deps,
    );
    const task = createTask({ projectId: project.id, title: 'Map the onboarding flow' }, deps);
    const session = startSession(
      { agentId: agent.id, projectId: project.id, provider: 'claude' },
      deps,
    );
    const skill = createSkill(
      {
        projectId: null,
        slug: 'ux-research',
        name: 'UX Research',
        kind: SkillKind.WORKFLOW,
        source: { origin: 'content', ref: { store: 'inline', content: '# how to' } },
      },
      deps,
    );
    const knowledge = createKnowledgeItem(
      {
        projectId: project.id,
        type: KnowledgeType.UX_RESEARCH,
        title: 'Interview notes',
        source: { origin: 'human' },
        location: { store: 'inline', content: 'notes' },
      },
      deps,
    );
    const output = createOutputItem(
      {
        projectId: project.id,
        taskId: task.id,
        producedByAgentId: agent.id,
        title: 'Flow draft',
        type: OutputType.MARKDOWN,
        location: { store: 'inline', content: '# flow' },
      },
      deps,
    );

    for (const id of [
      project.id,
      agent.id,
      task.id,
      session.id,
      skill.id,
      knowledge.id,
      output.id,
    ]) {
      expect(isCanonicalId(id)).toBe(true);
    }
    expect(new Set([project.id, agent.id, task.id, session.id, skill.id]).size).toBe(5);
  });
});
