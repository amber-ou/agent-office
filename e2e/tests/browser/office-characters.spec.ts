import { expect, test } from '@playwright/test';

import type { OfficeState, OfficeTask } from '../../../core/src/messages.js';

const date = '2026-09-21T00:00:00Z';
const initial: OfficeState = {
  type: 'officeState',
  storage: { ready: true, schemaVersion: 3 },
  projects: [
    {
      id: 'project',
      name: 'Skill Retriever 驗證',
      description: '',
      status: 'active',
      createdAt: date,
      updatedAt: date,
    },
  ],
  agents: [
    {
      id: 'retriever',
      name: 'skill-retriever',
      role: 'retriever',
      description: '',
      provider: 'claude',
      createdAt: date,
      updatedAt: date,
    },
  ],
  memberships: [{ id: 'membership', projectId: 'project', agentId: 'retriever' }],
  tasks: [],
  sessions: [],
  activeProjectId: 'project',
};
const task = (status: string): OfficeTask => ({
  id: 'task',
  projectId: 'project',
  title: 'Read fixture',
  description: '',
  assignedAgentId: 'retriever',
  status,
  priority: 'normal',
  dependencies: [],
  inputs: [],
  createdAt: date,
  updatedAt: date,
});

test('Office agent remains visible while idle, across reloads and task states, without a duplicate runtime @area:standalone', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.assign(window, { __PIXEL_AGENTS_E2E: true });
  });
  let push: (message: unknown) => void = () => {};
  await page.routeWebSocket('**/ws*', (ws) => {
    push = (message) => ws.send(JSON.stringify(message));
    ws.onMessage((message) => {
      const request = JSON.parse(String(message));
      if (request.type === 'requestOffice' || request.type === 'webviewReady') push(initial);
    });
  });
  await page.goto('/');
  const resident = page.getByTestId('agent-overlay').filter({ hasText: 'skill-retriever' });
  await expect(resident).toContainText('待命');
  const id = await resident.getAttribute('data-agent-id');
  await page.reload();
  await expect(resident).toContainText('待命');
  await expect(resident).toHaveAttribute('data-agent-id', id!);
  // Real sprites/layout + real WebSocket handler; no provider process is launched.
  await expect
    .poll(() => page.evaluate(() => window.__pixelAgentsTestHooks?.getCharacters?.().length))
    .toBe(1);
  const running: OfficeState = {
    ...initial,
    tasks: [task('in_progress')],
    sessions: [
      {
        id: 'run',
        agentId: 'retriever',
        projectId: 'project',
        taskId: 'task',
        provider: 'claude',
        status: 'running',
        startedAt: date,
      },
    ],
  };
  push(running);
  push({ type: 'agentCreated', id: 5, sessionId: 'run' });
  await expect(resident).toContainText('工作中');
  await expect
    .poll(() => page.evaluate(() => window.__pixelAgentsTestHooks?.getCharacters?.().length))
    .toBe(1);
  push({ ...running, tasks: [task('review')] });
  await expect(resident).toContainText('等待審核');
  push({ ...running, tasks: [task('failed')] });
  await expect(resident).toContainText('執行失敗');
  push({ ...running, tasks: [task('done')] });
  await expect(resident).toContainText('待命');
  await page.evaluate((id) => window.__pixelAgentsTestHooks?.selectAgent?.(Number(id)), id);
  await expect(resident.getByTitle('Close agent')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.__pixelAgentsTestHooks?.getCharacters?.()[0]?.matrixEffect),
    )
    .toBeNull();
  await page.screenshot({ path: testInfo.outputPath('office-resident.png') });
  push({ ...running, activeProjectId: 'empty', memberships: [], tasks: [] });
  await expect(resident).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__pixelAgentsTestHooks?.getCharacters?.().length))
    .toBe(0);
});
