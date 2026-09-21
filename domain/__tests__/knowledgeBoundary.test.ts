/**
 * Knowledge ownership boundaries (ADR 005).
 *
 * The rule under test: project content, tasks, outputs and project knowledge
 * must NEVER become agent knowledge or permanent agent memory. Working on a
 * project must not mutate what the agent permanently knows.
 *
 * Most of that is enforced by the type system — the assertions here confirm the
 * runtime shape matches, and that the domain exposes no promotion path.
 */

import { describe, expect, it } from 'vitest';

import type { AgentKnowledge, ProjectKnowledge } from '../src/index.js';
import * as domain from '../src/index.js';
import {
  createAgentDefinition,
  createAgentKnowledge,
  createProject,
  createProjectKnowledge,
  createTask,
  KnowledgeType,
  updateAgentKnowledge,
  updateProjectKnowledge,
} from '../src/index.js';
import { testDeps } from './support.js';

/** Compile-time: neither kind carries the other's owner. */
type AgentKnowledgeHasNoProject = [Extract<keyof AgentKnowledge, 'projectId'>] extends [never]
  ? true
  : false;
type ProjectKnowledgeHasNoAgent = [Extract<keyof ProjectKnowledge, 'agentId'>] extends [never]
  ? true
  : false;

function world() {
  const deps = testDeps();
  const project = createProject({ name: 'AiWow' }, deps);
  const agent = createAgentDefinition({ name: 'UX', role: 'ux', provider: 'claude' }, deps);
  return { deps, project, agent };
}

describe('knowledge ownership', () => {
  it('keeps the two owners structurally separate', () => {
    const a: AgentKnowledgeHasNoProject = true;
    const b: ProjectKnowledgeHasNoAgent = true;
    expect(a).toBe(true);
    expect(b).toBe(true);

    const { deps, project, agent } = world();
    const agentItem = createAgentKnowledge(
      {
        agentId: agent.id,
        type: KnowledgeType.MARKDOWN,
        title: 'How I run interviews',
        source: { origin: 'human' },
        location: { store: 'inline', content: '# method' },
      },
      deps,
    );
    const projectItem = createProjectKnowledge(
      {
        projectId: project.id,
        type: KnowledgeType.PRODUCT_REQUIREMENTS,
        title: 'AiWow PRD',
        source: { origin: 'human' },
        location: { store: 'inline', content: '# prd' },
      },
      deps,
    );

    expect(agentItem.agentId).toBe(agent.id);
    expect('projectId' in agentItem).toBe(false);
    expect(projectItem.projectId).toBe(project.id);
    expect('agentId' in projectItem).toBe(false);
    expect(agentItem.id).not.toBe(projectItem.id);
  });

  it('exposes no function that promotes project knowledge into agent knowledge', () => {
    // If someone adds one later, this fails and they have to argue for it.
    const promotionLike = Object.keys(domain).filter((name) =>
      /^(promote|copyInto|absorb|learn|rememberProject|persistToAgent|mergeInto)/i.test(name),
    );
    expect(promotionLike).toEqual([]);

    // Nor a generic "createKnowledgeItem" that could be pointed at either owner.
    expect('createKnowledgeItem' in domain).toBe(false);
    expect('KnowledgeItem' in domain).toBe(false);
  });

  it('does not let an edit re-home either kind', () => {
    const { deps, project, agent } = world();
    const agentItem = createAgentKnowledge(
      {
        agentId: agent.id,
        type: KnowledgeType.MARKDOWN,
        title: 'Permanent',
        source: { origin: 'human' },
        location: { store: 'inline', content: 'x' },
      },
      deps,
    );
    const projectItem = createProjectKnowledge(
      {
        projectId: project.id,
        type: KnowledgeType.MARKDOWN,
        title: 'Temporary',
        source: { origin: 'human' },
        location: { store: 'inline', content: 'y' },
      },
      deps,
    );

    // Owner is absent from KnowledgePatch, so re-homing is not expressible.
    expect(updateAgentKnowledge(agentItem, { title: 'Permanent v2' }, deps.clock).agentId).toBe(
      agent.id,
    );
    expect(
      updateProjectKnowledge(projectItem, { title: 'Temporary v2' }, deps.clock).projectId,
    ).toBe(project.id);
  });

  it("leaves the agent's permanent memory untouched by project work", () => {
    const { deps, project, agent } = world();
    const before = { ...agent.memory };

    // A full round of project work: knowledge, a task, an output.
    createProjectKnowledge(
      {
        projectId: project.id,
        type: KnowledgeType.UX_RESEARCH,
        title: 'Interview notes',
        source: { origin: 'agent', agentId: agent.id },
        location: { store: 'inline', content: 'notes' },
      },
      deps,
    );
    const task = createTask(
      { projectId: project.id, title: 'Run interviews', assignedAgentId: agent.id },
      deps,
    );
    expect(task.assignedAgentId).toBe(agent.id);

    // The agent definition is a value; nothing above could have mutated it, and
    // nothing in the domain offers to.
    expect(agent.memory).toEqual(before);
    expect(agent.memory.notes).toBe('');
  });

  it('records an agent-authored project note as PROJECT knowledge, not agent knowledge', () => {
    const { deps, project, agent } = world();
    const produced = createProjectKnowledge(
      {
        projectId: project.id,
        type: KnowledgeType.USER_FLOW,
        title: 'Checkout flow v1',
        // Authored by the agent while working — provenance, not ownership.
        source: { origin: 'agent', agentId: agent.id },
        location: { store: 'inline', content: '# flow' },
      },
      deps,
    );

    expect(produced.projectId).toBe(project.id);
    expect(produced.source).toEqual({ origin: 'agent', agentId: agent.id });
    // Provenance names the agent; ownership does not.
    expect('agentId' in produced).toBe(false);
  });
});
