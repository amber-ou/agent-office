/**
 * The Agent Office control-plane service against a real SQLite database.
 *
 * Covers the vertical slice at the application layer: create, persist, reopen.
 * The runtime smoke test in `officeRuntime.test.ts` covers the same ground
 * through the actual server and WebSocket path.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OfficeService } from '../src/control/officeService.js';
import {
  closeOfficeStorage,
  getOfficeStorage,
  setOfficeDataRoot,
} from '../src/control/officeStorage.js';

let dataRoot: string;

function service(): OfficeService {
  const storage = getOfficeStorage();
  if (!storage) {
    throw new Error('storage failed to open');
  }
  return new OfficeService(storage);
}

/** Close and reopen the database, the way quitting and relaunching would. */
function reopen(): OfficeService {
  closeOfficeStorage();
  setOfficeDataRoot(dataRoot);
  return service();
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-service-'));
  setOfficeDataRoot(dataRoot);
});

afterEach(() => {
  closeOfficeStorage();
  setOfficeDataRoot(undefined);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('OfficeService', () => {
  it('starts completely empty on a fresh database', async () => {
    const snapshot = await service().snapshot();
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.memberships).toEqual([]);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.activeProjectId).toBeUndefined();
  });

  it('runs the whole vertical slice and survives a reopen', async () => {
    const office = service();
    const project = await office.createProject({ name: 'AiWow' });
    const agent = await office.createAgent({ name: 'UX Agent', role: 'ux', provider: 'claude' });
    await office.addAgentToProject({ projectId: project.id, agentId: agent.id });
    const task = await office.createTask({ projectId: project.id, title: 'Map the flow' });

    // Close and reopen — a new process would see exactly this.
    const after = reopen();
    const snapshot = await after.snapshot(project.id);

    expect(snapshot.projects.map((p) => p.name)).toEqual(['AiWow']);
    expect(snapshot.agents.map((a) => a.name)).toEqual(['UX Agent']);
    expect(snapshot.memberships.map((m) => m.agentId)).toEqual([agent.id]);
    expect(snapshot.tasks.map((t) => t.title)).toEqual(['Map the flow']);
    expect(await after.getTask(task.id)).not.toBeNull();
  });

  it('keeps the global agent when it is removed from a project', async () => {
    const office = service();
    const alpha = await office.createProject({ name: 'Alpha' });
    const beta = await office.createProject({ name: 'Beta' });
    const agent = await office.createAgent({ name: 'UX', role: 'ux', provider: 'claude' });
    await office.addAgentToProject({ projectId: alpha.id, agentId: agent.id });
    await office.addAgentToProject({ projectId: beta.id, agentId: agent.id });

    expect(await office.removeAgentFromProject({ projectId: alpha.id, agentId: agent.id })).toBe(
      true,
    );

    const after = reopen();
    // The agent itself is untouched, and its other membership survives.
    expect(await after.getAgent(agent.id)).not.toBeNull();
    expect((await after.snapshot(alpha.id)).memberships).toEqual([]);
    expect((await after.snapshot(beta.id)).memberships.map((m) => m.agentId)).toEqual([agent.id]);
  });

  it('shows one agent in several projects', async () => {
    const office = service();
    const alpha = await office.createProject({ name: 'Alpha' });
    const beta = await office.createProject({ name: 'Beta' });
    const agent = await office.createAgent({ name: 'Shared', role: 'ux', provider: 'claude' });
    await office.addAgentToProject({ projectId: alpha.id, agentId: agent.id });
    await office.addAgentToProject({ projectId: beta.id, agentId: agent.id });

    // One definition in the library, a membership in each project.
    expect((await office.snapshot()).agents).toHaveLength(1);
    expect((await office.snapshot(alpha.id)).memberships).toHaveLength(1);
    expect((await office.snapshot(beta.id)).memberships).toHaveLength(1);
  });

  it('refuses a duplicate membership and a dangling reference', async () => {
    const office = service();
    const project = await office.createProject({ name: 'AiWow' });
    const agent = await office.createAgent({ name: 'UX', role: 'ux', provider: 'claude' });
    await office.addAgentToProject({ projectId: project.id, agentId: agent.id });

    await expect(
      office.addAgentToProject({ projectId: project.id, agentId: agent.id }),
    ).rejects.toThrow(/already a member/);
    await expect(
      office.addAgentToProject({
        projectId: '00000000-0000-4000-8000-000000000099',
        agentId: agent.id,
      }),
    ).rejects.toThrow(/project not found/);
    await expect(
      office.createTask({
        projectId: '00000000-0000-4000-8000-000000000099',
        title: 'Orphan',
      }),
    ).rejects.toThrow(/project not found/);
  });

  it('scopes memberships and tasks to the active project', async () => {
    const office = service();
    const alpha = await office.createProject({ name: 'Alpha' });
    const beta = await office.createProject({ name: 'Beta' });
    const agent = await office.createAgent({ name: 'UX', role: 'ux', provider: 'claude' });
    await office.addAgentToProject({ projectId: alpha.id, agentId: agent.id });
    await office.createTask({ projectId: alpha.id, title: 'Alpha task' });
    await office.createTask({ projectId: beta.id, title: 'Beta task' });

    const inAlpha = await office.snapshot(alpha.id);
    expect(inAlpha.tasks.map((t) => t.title)).toEqual(['Alpha task']);
    expect(inAlpha.memberships).toHaveLength(1);

    const inBeta = await office.snapshot(beta.id);
    expect(inBeta.tasks.map((t) => t.title)).toEqual(['Beta task']);
    expect(inBeta.memberships).toHaveLength(0);

    // The agent library is global regardless of selection.
    expect(inBeta.agents).toHaveLength(1);
  });

  // ── Agent configuration ──────────────────────────────────────

  it('has no agents, skills or knowledge in a fresh office', async () => {
    const office = service();
    const agent = await office.createAgent({ name: 'Probe', role: 'ux', provider: 'claude' });
    // The agent just created is the only one; it brings nothing with it.
    const detail = await office.agentDetail(agent.id);
    expect(detail?.skills).toEqual([]);
    expect(detail?.knowledge).toEqual([]);
    expect((await service().snapshot()).agents).toHaveLength(1);
  });

  it('configures a global agent with no project involved and keeps it', async () => {
    const office = service();
    const agent = await office.createAgent({ name: 'UX', role: 'ux', provider: 'claude' });

    await office.updateAgent({
      agentId: agent.id,
      name: 'UX Researcher',
      role: 'research',
      description: 'Interviews and synthesis',
      systemPrompt: 'Always cite the transcript.',
      model: 'claude-opus-5',
    });

    const detail = await reopen().agentDetail(agent.id);
    expect(detail?.agent.name).toBe('UX Researcher');
    expect(detail?.agent.role).toBe('research');
    expect(detail?.agent.description).toBe('Interviews and synthesis');
    expect(detail?.agent.systemPrompt).toBe('Always cite the transcript.');
    expect(detail?.agent.model).toBe('claude-opus-5');
    // Still global: no project was ever created.
    expect((await reopen().snapshot()).projects).toEqual([]);
  });

  it('creates, edits and deletes skills owned by one agent', async () => {
    const office = service();
    const agent = await office.createAgent({ name: 'UX', role: 'ux', provider: 'claude' });
    const skill = await office.createSkill({
      agentId: agent.id,
      slug: 'interview',
      name: 'Run an interview',
      kind: 'workflow',
      description: 'Semi-structured',
      content: 'Ask open questions.',
      requiredTools: ['Read'],
    });
    expect(skill.agentId).toBe(agent.id);

    await office.updateSkill({
      skillId: skill.id,
      name: 'Run a user interview',
      content: 'Ask open questions, then probe.',
    });

    const after = reopen();
    const detail = await after.agentDetail(agent.id);
    expect(detail?.skills).toHaveLength(1);
    expect(detail?.skills[0]!.name).toBe('Run a user interview');
    expect(detail?.skills[0]!.source).toEqual({
      origin: 'content',
      ref: { store: 'inline', content: 'Ask open questions, then probe.' },
    });

    expect(await after.deleteSkill(skill.id)).toBe(true);
    expect((await reopen().agentDetail(agent.id))?.skills).toEqual([]);
  });

  it('refuses a duplicate slug on one agent but allows it on another', async () => {
    const office = service();
    const one = await office.createAgent({ name: 'One', role: 'ux', provider: 'claude' });
    const two = await office.createAgent({ name: 'Two', role: 'ux', provider: 'claude' });
    await office.createSkill({ agentId: one.id, slug: 'interview', name: 'A', kind: 'workflow' });

    await expect(
      office.createSkill({ agentId: one.id, slug: 'interview', name: 'B', kind: 'workflow' }),
    ).rejects.toThrow(/already has a skill/);

    // Skills belong to one agent; there is no shared library, so the same slug
    // on a different agent is a different skill.
    const other = await office.createSkill({
      agentId: two.id,
      slug: 'interview',
      name: 'B',
      kind: 'workflow',
    });
    expect(other.agentId).toBe(two.id);
    expect((await reopen().agentDetail(one.id))?.skills).toHaveLength(1);
  });

  it('adds, edits and deletes agent knowledge, content and all', async () => {
    const office = service();
    const agent = await office.createAgent({ name: 'UX', role: 'ux', provider: 'claude' });
    const item = await office.createAgentKnowledge({
      agentId: agent.id,
      title: 'Interview guide',
      knowledgeType: 'ux_research',
      content: 'Start with context questions.',
      tags: ['research'],
    });
    expect(item.agentId).toBe(agent.id);
    // Explicit authorship, never ingested from anywhere.
    expect(item.source).toEqual({ origin: 'human' });

    const stored = await reopen().agentDetail(agent.id);
    expect(stored?.knowledge).toHaveLength(1);
    expect(stored?.knowledge[0]!.content).toBe('Start with context questions.');
    expect(stored?.knowledge[0]!.contentReadable).toBe(true);

    const office2 = reopen();
    await office2.updateAgentKnowledge({
      knowledgeId: item.id,
      title: 'Interview guide v2',
      content: 'Start with context, then tasks.',
      tags: ['research', 'interviews'],
    });

    const edited = await reopen().agentDetail(agent.id);
    expect(edited?.knowledge[0]!.item.title).toBe('Interview guide v2');
    expect(edited?.knowledge[0]!.item.tags).toEqual(['research', 'interviews']);
    expect(edited?.knowledge[0]!.content).toBe('Start with context, then tasks.');

    expect(await reopen().deleteAgentKnowledge(item.id)).toBe(true);
    expect((await reopen().agentDetail(agent.id))?.knowledge).toEqual([]);
  });

  it('keeps knowledge on the agent, not on any project it joins', async () => {
    const office = service();
    const agent = await office.createAgent({ name: 'UX', role: 'ux', provider: 'claude' });
    await office.createAgentKnowledge({
      agentId: agent.id,
      title: 'Interview guide',
      knowledgeType: 'ux_research',
      content: 'Start with context questions.',
    });
    const alpha = await office.createProject({ name: 'Alpha' });
    const beta = await office.createProject({ name: 'Beta' });
    await office.addAgentToProject({ projectId: alpha.id, agentId: agent.id });
    await office.addAgentToProject({ projectId: beta.id, agentId: agent.id });

    // The same knowledge in both projects, because it belongs to neither.
    for (const project of [alpha, beta]) {
      const after = reopen();
      await after.snapshot(project.id);
      expect((await after.agentDetail(agent.id))?.knowledge).toHaveLength(1);
    }

    // Leaving a project takes nothing with it.
    await reopen().removeAgentFromProject({ projectId: alpha.id, agentId: agent.id });
    expect((await reopen().agentDetail(agent.id))?.knowledge).toHaveLength(1);
  });

  it('does not turn project work into agent knowledge', async () => {
    const office = service();
    const agent = await office.createAgent({ name: 'UX', role: 'ux', provider: 'claude' });
    const project = await office.createProject({ name: 'Alpha' });
    await office.addAgentToProject({ projectId: project.id, agentId: agent.id });
    await office.createTask({
      projectId: project.id,
      title: 'Map the onboarding flow',
      description: 'Everything learned here stays in the project.',
    });

    // Creating a project, a membership and a task moved nothing onto the agent.
    const detail = await reopen().agentDetail(agent.id);
    expect(detail?.knowledge).toEqual([]);
    expect(detail?.skills).toEqual([]);
  });

  it('reports a missing agent rather than inventing one', async () => {
    const office = service();
    expect(await office.agentDetail('00000000-0000-4000-8000-0000000000aa')).toBeNull();
    await expect(
      office.updateAgent({ agentId: '00000000-0000-4000-8000-0000000000aa', name: 'X' }),
    ).rejects.toThrow(/agent not found/);
    await expect(
      office.createSkill({
        agentId: '00000000-0000-4000-8000-0000000000aa',
        slug: 's',
        name: 'S',
        kind: 'workflow',
      }),
    ).rejects.toThrow(/agent not found/);
    await expect(
      office.createAgentKnowledge({
        agentId: '00000000-0000-4000-8000-0000000000aa',
        title: 'T',
        knowledgeType: 'markdown',
        content: 'c',
      }),
    ).rejects.toThrow(/agent not found/);
  });

  it('drops a selection that no longer exists', async () => {
    const office = service();
    const snapshot = await office.snapshot('00000000-0000-4000-8000-0000000000ff' as never);
    expect(snapshot.activeProjectId).toBeUndefined();
    expect(snapshot.tasks).toEqual([]);
  });
});
