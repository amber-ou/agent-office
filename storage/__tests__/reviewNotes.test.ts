/**
 * The review-note store.
 *
 * An application record rather than a domain entity, so it is not part of the
 * repository contract suite; what it must do is persist, list in order, and
 * disappear with the task it belongs to.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createAgentDefinition,
  createProject,
  createTask,
  systemClock,
  uuidIdGenerator,
} from '../../domain/src/index.js';
import type { SqliteStorage } from '../src/index.js';
import { openSqliteStorage } from '../src/index.js';

const DEPS = { ids: uuidIdGenerator, clock: systemClock };

let dataRoot: string;
let storage: SqliteStorage;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-notes-'));
  storage = openSqliteStorage({ dataRoot });
});

afterEach(() => {
  storage.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

async function seedTask(): Promise<{ projectId: string; taskId: string }> {
  const project = createProject({ name: 'AiWow' }, DEPS);
  await storage.repos.projects.put(project);
  const agent = createAgentDefinition({ name: 'UX', role: 'ux', provider: 'claude' }, DEPS);
  await storage.repos.agents.put(agent);
  const task = createTask({ projectId: project.id, title: 'Draft' }, DEPS);
  await storage.repos.tasks.put(task);
  return { projectId: project.id, taskId: task.id };
}

describe('SqliteReviewNoteStore', () => {
  it('stores notes and lists them oldest first, by task and by project', async () => {
    const { projectId, taskId } = await seedTask();
    await storage.reviews.put({
      id: '1',
      taskId: taskId as never,
      author: 'human',
      body: 'first',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await storage.reviews.put({
      id: '2',
      taskId: taskId as never,
      author: 'human',
      body: 'second',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    expect((await storage.reviews.listByTask(taskId as never)).map((n) => n.body)).toEqual([
      'first',
      'second',
    ]);
    expect((await storage.reviews.listByProject(projectId)).map((n) => n.body)).toEqual([
      'first',
      'second',
    ]);
  });

  it('survives a reopen and goes with its task', async () => {
    const { taskId } = await seedTask();
    await storage.reviews.put({
      id: '1',
      taskId: taskId as never,
      author: 'human',
      body: 'needs a mobile state',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    storage.close();
    storage = openSqliteStorage({ dataRoot });
    expect((await storage.reviews.listByTask(taskId as never))[0]!.body).toBe(
      'needs a mobile state',
    );

    // Deleting the task takes its notes with it.
    await storage.repos.tasks.delete(taskId as never);
    expect(await storage.reviews.listByTask(taskId as never)).toEqual([]);
  });
});
