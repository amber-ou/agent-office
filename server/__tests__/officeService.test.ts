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
    expect(detail?.agent.systemPrompt).toContain('Always cite the transcript.');
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
      agentId: agent.id,
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

    expect(await after.deleteSkill({ agentId: agent.id, skillId: skill.id })).toBe(true);
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
      agentId: agent.id,
      knowledgeId: item.id,
      title: 'Interview guide v2',
      content: 'Start with context, then tasks.',
      tags: ['research', 'interviews'],
    });

    const edited = await reopen().agentDetail(agent.id);
    expect(edited?.knowledge[0]!.item.title).toBe('Interview guide v2');
    expect(edited?.knowledge[0]!.item.tags).toEqual(['research', 'interviews']);
    expect(edited?.knowledge[0]!.content).toBe('Start with context, then tasks.');

    expect(await reopen().deleteAgentKnowledge({ agentId: agent.id, knowledgeId: item.id })).toBe(
      true,
    );
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

  // ── Agent-owned files (M5) ───────────────────────────────────

  it('gives a new agent its own directory and reads its config back from it', async () => {
    const office = service();
    const agent = await office.createAgent({
      name: 'UX Agent',
      role: 'ux',
      provider: 'claude',
      systemPrompt: 'Cite the transcript.',
    });
    await office.createSkill({
      agentId: agent.id,
      slug: 'interview',
      name: 'Run an interview',
      kind: 'workflow',
      content: 'Ask open questions.',
    });
    await office.createAgentKnowledge({
      agentId: agent.id,
      title: 'Interview guide',
      knowledgeType: 'ux_research',
      content: 'Start with context questions.',
    });

    const agentDir = path.join(dataRoot, 'agents', agent.id);
    expect(fs.existsSync(path.join(agentDir, 'discovery', 'agent.md'))).toBe(true);
    expect(fs.readFileSync(path.join(agentDir, 'discovery', 'agent.md'), 'utf8')).toContain(
      'Cite the transcript.',
    );
    expect(fs.readdirSync(path.join(agentDir, 'skills'))).toHaveLength(1);
    // knowledge/ also holds the generated index.md — real items are the rest.
    expect(
      fs.readdirSync(path.join(agentDir, 'knowledge')).filter((name) => name !== 'index.md'),
    ).toHaveLength(1);

    // And that is what the office reads back, after a restart.
    const detail = (await reopen().agentDetail(agent.id))!;
    expect(detail.fileBacked).toBe(true);
    expect(detail.agent.systemPrompt).toContain('Cite the transcript.');
    expect(detail.skills[0]!.slug).toBe('interview');
    expect(detail.knowledge[0]!.content).toBe('Start with context questions.');
  });

  it('keeps agent files when the agent is renamed', async () => {
    const office = service();
    const agent = await office.createAgent({
      name: 'UX Agent',
      role: 'ux',
      provider: 'claude',
      systemPrompt: 'Cite the transcript.',
    });
    const skill = await office.createSkill({
      agentId: agent.id,
      slug: 'interview',
      name: 'Run an interview',
      kind: 'workflow',
      content: 'Ask open questions.',
    });

    await office.updateAgent({ agentId: agent.id, name: 'Research Agent', role: 'research' });

    const detail = (await reopen().agentDetail(agent.id))!;
    expect(detail.agent.name).toBe('Research Agent');
    expect(detail.skills.map((s) => s.id)).toEqual([skill.id]);
    // The directory is still the id; nothing was moved.
    expect(fs.existsSync(path.join(dataRoot, 'agents', agent.id, 'discovery', 'agent.md'))).toBe(
      true,
    );
  });

  it('will not let one agent reach another-s files through the office API', async () => {
    const office = service();
    const one = await office.createAgent({ name: 'One', role: 'ux', provider: 'claude' });
    const two = await office.createAgent({ name: 'Two', role: 'ux', provider: 'claude' });
    const skill = await office.createSkill({
      agentId: two.id,
      slug: 'interview',
      name: 'Run an interview',
      kind: 'workflow',
      content: "TWO'S CONTENT",
    });
    const knowledge = await office.createAgentKnowledge({
      agentId: two.id,
      title: 'Two knows this',
      knowledgeType: 'markdown',
      content: "TWO'S KNOWLEDGE",
    });

    // Every agent-scoped call is scoped by the OWNER, so a borrowed id finds
    // nothing rather than someone else's file.
    await expect(
      office.updateSkill({ agentId: one.id, skillId: skill.id, name: 'Stolen' }),
    ).rejects.toThrow(/skill not found/);
    expect(await office.deleteSkill({ agentId: one.id, skillId: skill.id })).toBe(false);
    await expect(
      office.updateAgentKnowledge({
        agentId: one.id,
        knowledgeId: knowledge.id,
        content: 'overwritten',
      }),
    ).rejects.toThrow(/not found/);
    expect(await office.deleteAgentKnowledge({ agentId: one.id, knowledgeId: knowledge.id })).toBe(
      false,
    );

    // Two still has both, unchanged.
    const detail = (await reopen().agentDetail(two.id))!;
    expect(detail.skills).toHaveLength(1);
    expect(detail.knowledge[0]!.content).toBe("TWO'S KNOWLEDGE");
    expect((await reopen().agentDetail(one.id))!.skills).toEqual([]);
  });

  it('rejects a path-traversal id instead of touching the filesystem', async () => {
    const office = service();
    const agent = await office.createAgent({ name: 'UX', role: 'ux', provider: 'claude' });

    await expect(
      office.updateSkill({ agentId: agent.id, skillId: '../../etc/passwd', name: 'x' }),
    ).rejects.toThrow(/canonical uuid/);
    await expect(
      office.deleteAgentKnowledge({ agentId: agent.id, knowledgeId: '../../../secrets' }),
    ).rejects.toThrow(/canonical uuid/);
    await expect(office.agentDetail('../../etc')).rejects.toThrow();

    expect(fs.readdirSync(path.join(dataRoot, 'agents'))).toEqual([agent.id]);
  });

  it('refuses to edit an agent whose FIRST migration hit a conflict', async () => {
    const office = service();
    const agent = await office.createAgent({
      name: 'UX',
      role: 'ux',
      provider: 'claude',
      systemPrompt: 'Cite the transcript.',
    });

    // Put the agent back where a pre-M5 one starts: known to the database, not
    // yet recorded as moved. Then leave a file that disagrees with the row.
    await getOfficeStorage()!.agentMigrations.forget(agent.id as never);
    fs.rmSync(path.join(dataRoot, 'agents', agent.id, 'agent.json'));
    fs.writeFileSync(
      path.join(dataRoot, 'agents', agent.id, 'discovery', 'agent.md'),
      'HAND-EDITED',
      'utf8',
    );

    const after = reopen();
    const detail = (await after.agentDetail(agent.id))!;
    // Blocked: it reads the database and says so, and both copies survive.
    expect(detail.fileBacked).toBe(false);
    expect(detail.configIssue).toMatch(/disagree/i);
    expect(detail.agent.systemPrompt).toContain('Cite the transcript.');
    expect(
      fs.readFileSync(path.join(dataRoot, 'agents', agent.id, 'discovery', 'agent.md'), 'utf8'),
    ).toBe('HAND-EDITED');

    // Editing is refused rather than picking one of two disagreeing sources.
    await expect(
      after.updateAgent({ agentId: agent.id, systemPrompt: 'something else' }),
    ).rejects.toThrow(/resolve the conflict/);
    await expect(
      after.createSkill({ agentId: agent.id, slug: 's', name: 'S', kind: 'workflow' }),
    ).rejects.toThrow(/resolve the conflict/);
  });

  it('treats an ordinary edit of a migrated agent as an edit, not a conflict', async () => {
    const office = service();
    const agent = await office.createAgent({
      name: 'UX',
      role: 'ux',
      provider: 'claude',
      systemPrompt: 'Cite the transcript.',
    });
    const skill = await office.createSkill({
      agentId: agent.id,
      slug: 'interview',
      name: 'Run an interview',
      kind: 'workflow',
      content: 'Ask open questions.',
    });

    await office.updateAgent({ agentId: agent.id, systemPrompt: 'EDITED' });
    expect(await office.deleteSkill({ agentId: agent.id, skillId: skill.id })).toBe(true);

    // Reopening runs the migration again; it must leave all of that alone.
    const detail = (await reopen().agentDetail(agent.id))!;
    expect(detail.fileBacked).toBe(true);
    expect(detail.configIssue).toBeUndefined();
    expect(detail.agent.systemPrompt).toContain('EDITED');
    expect(detail.skills).toEqual([]);
  });

  // ── Project workspace ────────────────────────────────────────

  async function projectWithMember(): Promise<{
    office: OfficeService;
    projectId: string;
    agentId: string;
  }> {
    const office = service();
    const project = await office.createProject({ name: 'AiWow' });
    const agent = await office.createAgent({ name: 'UX', role: 'ux', provider: 'claude' });
    await office.addAgentToProject({ projectId: project.id, agentId: agent.id });
    return { office, projectId: project.id, agentId: agent.id };
  }

  it('edits a project and keeps it across a reopen', async () => {
    const office = service();
    const project = await office.createProject({ name: 'AiWow' });
    await office.updateProject({
      projectId: project.id,
      name: 'AiWow v2',
      description: 'Onboarding redesign',
      status: 'paused',
      workspacePaths: ['/srv/aiwow'],
      defaultModel: 'claude-opus-5',
    });

    const detail = await reopen().projectDetail(project.id);
    expect(detail?.project.name).toBe('AiWow v2');
    expect(detail?.project.description).toBe('Onboarding redesign');
    expect(detail?.project.status).toBe('paused');
    expect(detail?.project.settings.workspacePaths).toEqual(['/srv/aiwow']);
    expect(detail?.project.settings.defaultModel).toBe('claude-opus-5');
  });

  it('adds, edits and deletes project knowledge, content and all', async () => {
    const office = service();
    const project = await office.createProject({ name: 'AiWow' });
    const item = await office.createProjectKnowledge({
      projectId: project.id,
      title: 'Brand voice',
      knowledgeType: 'design_system',
      content: 'Plain, direct, no exclamation marks.',
      tags: ['brand'],
    });
    expect(item.projectId).toBe(project.id);
    expect(item.source).toEqual({ origin: 'human' });

    const stored = await reopen().projectDetail(project.id);
    expect(stored?.knowledge).toHaveLength(1);
    expect(stored?.knowledge[0]!.content).toBe('Plain, direct, no exclamation marks.');
    expect(stored?.knowledge[0]!.contentReadable).toBe(true);

    await reopen().updateProjectKnowledge({
      knowledgeId: item.id,
      title: 'Brand voice v2',
      content: 'Plain and direct.',
      tags: ['brand', 'copy'],
    });
    const edited = await reopen().projectDetail(project.id);
    expect(edited?.knowledge[0]!.item.title).toBe('Brand voice v2');
    expect(edited?.knowledge[0]!.content).toBe('Plain and direct.');
    expect(edited?.knowledge[0]!.item.tags).toEqual(['brand', 'copy']);

    expect(await reopen().deleteProjectKnowledge(item.id)).toBe(true);
    expect((await reopen().projectDetail(project.id))?.knowledge).toEqual([]);
  });

  it('keeps project knowledge and agent knowledge entirely separate', async () => {
    const { office, projectId, agentId } = await projectWithMember();
    await office.createAgentKnowledge({
      agentId,
      title: 'Interview guide',
      knowledgeType: 'ux_research',
      content: 'Agent-owned.',
    });
    const projectItem = await office.createProjectKnowledge({
      projectId,
      title: 'Brand voice',
      knowledgeType: 'design_system',
      content: 'Project-owned.',
    });

    // Neither library can see the other's item.
    expect((await office.agentDetail(agentId))?.knowledge.map((k) => k.item.title)).toEqual([
      'Interview guide',
    ]);
    expect((await office.projectDetail(projectId))?.knowledge.map((k) => k.item.title)).toEqual([
      'Brand voice',
    ]);

    // Editing and deleting project knowledge leaves the agent untouched.
    await office.updateProjectKnowledge({ knowledgeId: projectItem.id, content: 'Changed.' });
    await office.deleteProjectKnowledge(projectItem.id);

    const after = reopen();
    const agentKnowledge = (await after.agentDetail(agentId))?.knowledge;
    expect(agentKnowledge).toHaveLength(1);
    expect(agentKnowledge?.[0]!.content).toBe('Agent-owned.');
    expect((await after.projectDetail(projectId))?.knowledge).toEqual([]);
  });

  it('holds many small tasks, assigned and unassigned alike', async () => {
    const { office, projectId, agentId } = await projectWithMember();
    for (let i = 0; i < 12; i++) {
      await office.createTask({ projectId, title: `Step ${i + 1}` });
    }
    const first = (await office.projectDetail(projectId))!.tasks[0]!;
    await office.assignTask({ taskId: first.id, agentId });

    const detail = await reopen().projectDetail(projectId);
    expect(detail?.tasks).toHaveLength(12);
    // Eleven of them have no agent at all, which is allowed.
    expect(detail?.tasks.filter((t) => t.assignedAgentId === undefined)).toHaveLength(11);
    expect(detail?.tasks.find((t) => t.id === first.id)?.assignedAgentId).toBe(agentId);
  });

  it('edits a task and persists every field', async () => {
    const { office, projectId } = await projectWithMember();
    const knowledge = await office.createProjectKnowledge({
      projectId,
      title: 'Brand voice',
      knowledgeType: 'design_system',
      content: 'Plain and direct.',
    });
    const parent = await office.createTask({ projectId, title: 'Redesign onboarding' });
    const task = await office.createTask({ projectId, title: 'Draft the copy' });

    await office.updateTask({
      taskId: task.id,
      title: 'Draft the welcome copy',
      description: 'Done when the three screens read in one voice.',
      priority: 'high',
      parentTaskId: parent.id,
      inputs: [
        { kind: 'projectKnowledge', knowledgeId: knowledge.id },
        { kind: 'text', value: 'Keep it under 40 words.' },
      ],
    });

    const stored = (await reopen().projectDetail(projectId))!.tasks.find((t) => t.id === task.id)!;
    expect(stored.title).toBe('Draft the welcome copy');
    expect(stored.description).toBe('Done when the three screens read in one voice.');
    expect(stored.priority).toBe('high');
    expect(stored.parentTaskId).toBe(parent.id);
    expect(stored.inputs).toEqual([
      { kind: 'projectKnowledge', knowledgeId: knowledge.id },
      { kind: 'text', value: 'Keep it under 40 words.' },
    ]);

    // And the parent link can be cut again.
    await reopen().updateTask({ taskId: task.id, clearParentTask: true });
    expect(
      (await reopen().projectDetail(projectId))!.tasks.find((t) => t.id === task.id)!.parentTaskId,
    ).toBeUndefined();
  });

  it('assigns only members, and reassigns or unassigns where the domain allows', async () => {
    const { office, projectId, agentId } = await projectWithMember();
    const outsider = await office.createAgent({ name: 'QA', role: 'qa', provider: 'claude' });
    const task = await office.createTask({ projectId, title: 'Draft the copy' });

    await expect(office.assignTask({ taskId: task.id, agentId: outsider.id })).rejects.toThrow(
      /not a member/,
    );
    await expect(
      office.createTask({ projectId, title: 'Another', assignedAgentId: outsider.id }),
    ).rejects.toThrow(/not a member/);

    await office.assignTask({ taskId: task.id, agentId });
    await office.addAgentToProject({ projectId, agentId: outsider.id });
    await office.assignTask({ taskId: task.id, agentId: outsider.id });
    expect((await reopen().projectDetail(projectId))!.tasks[0]!.assignedAgentId).toBe(outsider.id);

    await reopen().unassignTask(task.id);
    expect((await reopen().projectDetail(projectId))!.tasks[0]!.assignedAgentId).toBeUndefined();
  });

  it('never leaves a task assigned to a former member', async () => {
    const { office, projectId, agentId } = await projectWithMember();
    const task = await office.createTask({ projectId, title: 'Draft the copy' });
    await office.assignTask({ taskId: task.id, agentId });

    await office.removeAgentFromProject({ projectId, agentId });

    const after = reopen();
    // The task survives, without an owner it no longer has.
    const stored = (await after.projectDetail(projectId))!.tasks[0]!;
    expect(stored.assignedAgentId).toBeUndefined();
    // The membership is gone; the global agent itself is untouched.
    expect((await after.projectDetail(projectId))!.memberships).toEqual([]);
    expect(await after.getAgent(agentId as never)).not.toBeNull();
  });

  it('refuses to remove a member whose task is in progress', async () => {
    const { office, projectId, agentId } = await projectWithMember();
    const task = await office.createTask({ projectId, title: 'Draft the copy' });
    await office.assignTask({ taskId: task.id, agentId });
    await office.setTaskStatus({ taskId: task.id, status: 'todo' });
    await office.setTaskStatus({ taskId: task.id, status: 'in_progress' });

    await expect(office.removeAgentFromProject({ projectId, agentId })).rejects.toThrow(
      /cannot unassign a task in progress/,
    );

    // Nothing moved: the membership and the assignment are both still there.
    const after = reopen();
    expect((await after.projectDetail(projectId))!.memberships).toHaveLength(1);
    expect((await after.projectDetail(projectId))!.tasks[0]!.assignedAgentId).toBe(agentId);
  });

  it('persists dependencies and enforces the existing graph rules', async () => {
    const { office, projectId } = await projectWithMember();
    const research = await office.createTask({ projectId, title: 'Research' });
    const draft = await office.createTask({
      projectId,
      title: 'Draft',
      dependencies: [research.id],
    });
    expect(draft.dependencies).toEqual([research.id]);

    // Self, unknown, cross-project and cyclic edges are all refused.
    await expect(office.updateTask({ taskId: draft.id, dependencies: [draft.id] })).rejects.toThrow(
      /cannot depend on itself/,
    );
    await expect(
      office.updateTask({
        taskId: draft.id,
        dependencies: ['00000000-0000-4000-8000-0000000000bb'],
      }),
    ).rejects.toThrow(/does not exist/);

    const other = await office.createProject({ name: 'Beta' });
    const foreign = await office.createTask({ projectId: other.id, title: 'Elsewhere' });
    await expect(
      office.updateTask({ taskId: draft.id, dependencies: [foreign.id] }),
    ).rejects.toThrow(/same project/);

    await expect(
      office.updateTask({ taskId: research.id, dependencies: [draft.id] }),
    ).rejects.toThrow(/cycle/i);

    // The sound edge survived every rejection and a reopen.
    const stored = (await reopen().projectDetail(projectId))!.tasks.find((t) => t.id === draft.id)!;
    expect(stored.dependencies).toEqual([research.id]);
  });

  it('will not start a task before its dependencies are done or without an agent', async () => {
    const { office, projectId, agentId } = await projectWithMember();
    const research = await office.createTask({ projectId, title: 'Research' });
    const draft = await office.createTask({
      projectId,
      title: 'Draft',
      dependencies: [research.id],
    });

    await office.setTaskStatus({ taskId: draft.id, status: 'todo' });
    // No agent yet.
    await expect(office.setTaskStatus({ taskId: draft.id, status: 'in_progress' })).rejects.toThrow(
      /no assigned agent/,
    );

    await office.assignTask({ taskId: draft.id, agentId });
    await expect(office.setTaskStatus({ taskId: draft.id, status: 'in_progress' })).rejects.toThrow(
      /unmet dependenc/,
    );

    // Finish the dependency, and the same move is allowed.
    await office.assignTask({ taskId: research.id, agentId });
    await office.setTaskStatus({ taskId: research.id, status: 'todo' });
    await office.setTaskStatus({ taskId: research.id, status: 'in_progress' });
    await office.setTaskStatus({ taskId: research.id, status: 'done' });
    await office.setTaskStatus({ taskId: draft.id, status: 'in_progress' });

    const stored = (await reopen().projectDetail(projectId))!.tasks;
    expect(stored.find((t) => t.id === draft.id)?.status).toBe('in_progress');
    expect(stored.find((t) => t.id === research.id)?.status).toBe('done');
  });

  it('removes a deleted task from the tasks that depended on it', async () => {
    const { office, projectId } = await projectWithMember();
    const research = await office.createTask({ projectId, title: 'Research' });
    const draft = await office.createTask({
      projectId,
      title: 'Draft',
      dependencies: [research.id],
    });

    expect(await office.deleteTask(research.id)).toBe(true);

    const after = reopen();
    const stored = (await after.projectDetail(projectId))!;
    expect(stored.tasks.map((t) => t.id)).toEqual([draft.id]);
    // No dangling edge left behind, so the survivor is still editable.
    expect(stored.tasks[0]!.dependencies).toEqual([]);
    await expect(after.updateTask({ taskId: draft.id, title: 'Draft v2' })).resolves.toBeTruthy();
  });

  it('leaves agent configuration untouched through a whole project workflow', async () => {
    const { office, projectId, agentId } = await projectWithMember();
    const skill = await office.createSkill({
      agentId,
      slug: 'interview',
      name: 'Run an interview',
      kind: 'workflow',
      content: 'Ask open questions.',
    });
    const agentKnowledge = await office.createAgentKnowledge({
      agentId,
      title: 'Interview guide',
      knowledgeType: 'ux_research',
      content: 'Agent-owned.',
    });
    const before = await office.agentDetail(agentId);

    // A full project pass: knowledge, tasks, assignment, status, deletion.
    await office.createProjectKnowledge({
      projectId,
      title: 'Brand voice',
      knowledgeType: 'design_system',
      content: 'Project-owned.',
    });
    const task = await office.createTask({ projectId, title: 'Draft the copy' });
    await office.assignTask({ taskId: task.id, agentId });
    await office.setTaskStatus({ taskId: task.id, status: 'todo' });
    await office.updateTask({ taskId: task.id, description: 'Everything learned stays here.' });
    await office.deleteTask(task.id);

    const after = (await reopen().agentDetail(agentId))!;
    expect(after.agent).toEqual(before?.agent);
    expect(after.skills.map((s) => s.id)).toEqual([skill.id]);
    expect(after.skills[0]!.source).toEqual(before?.skills[0]!.source);
    expect(after.knowledge.map((k) => k.item.id)).toEqual([agentKnowledge.id]);
    expect(after.knowledge[0]!.content).toBe('Agent-owned.');
  });

  it('starts a fresh office with no projects, knowledge or tasks', async () => {
    const office = service();
    expect(await office.projectDetail('00000000-0000-4000-8000-0000000000cc')).toBeNull();
    const snapshot = await office.snapshot();
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.tasks).toEqual([]);
  });

  it('drops a selection that no longer exists', async () => {
    const office = service();
    const snapshot = await office.snapshot('00000000-0000-4000-8000-0000000000ff' as never);
    expect(snapshot.activeProjectId).toBeUndefined();
    expect(snapshot.tasks).toEqual([]);
  });
});
