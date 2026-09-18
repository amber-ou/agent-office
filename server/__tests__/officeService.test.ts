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

  it('drops a selection that no longer exists', async () => {
    const office = service();
    const snapshot = await office.snapshot('00000000-0000-4000-8000-0000000000ff' as never);
    expect(snapshot.activeProjectId).toBeUndefined();
    expect(snapshot.tasks).toEqual([]);
  });
});
