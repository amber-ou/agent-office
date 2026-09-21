/**
 * Project creation and the aggregate boundary (ADR 001).
 */

import { describe, expect, it } from 'vitest';

import { createProject, ProjectStatus, updateProject } from '../src/index.js';
import { testDeps } from './support.js';

describe('Project', () => {
  it('creates an active project with defaults', () => {
    const deps = testDeps();
    const project = createProject({ name: 'AiWow' }, deps);

    expect(project.name).toBe('AiWow');
    expect(project.description).toBe('');
    expect(project.status).toBe(ProjectStatus.ACTIVE);
    expect(project.settings.workspacePaths).toEqual([]);
    expect(project.createdAt).toBe(project.updatedAt);
  });

  it('rejects an empty name', () => {
    const deps = testDeps();
    expect(() => createProject({ name: '   ' }, deps)).toThrow(/project.name/);
  });

  it('does NOT embed agents, tasks, knowledge or outputs (ADR 001)', () => {
    const deps = testDeps();
    const project = createProject({ name: 'AiWow' }, deps);
    const keys = Object.keys(project);

    for (const embedded of ['agents', 'tasks', 'knowledge', 'outputs', 'sessions']) {
      expect(keys).not.toContain(embedded);
    }
  });

  it('merges settings on update and bumps updatedAt', () => {
    const deps = testDeps();
    const project = createProject(
      { name: 'AiWow', settings: { workspacePaths: ['/srv/aiwow'] } },
      deps,
    );
    const updated = updateProject(
      project,
      { status: ProjectStatus.PAUSED, settings: { defaultModel: 'claude-opus-5' } },
      deps.clock,
    );

    expect(updated.id).toBe(project.id);
    expect(updated.status).toBe(ProjectStatus.PAUSED);
    // Merge, not replace.
    expect(updated.settings.workspacePaths).toEqual(['/srv/aiwow']);
    expect(updated.settings.defaultModel).toBe('claude-opus-5');
    expect(updated.updatedAt).not.toBe(project.updatedAt);
  });

  it('keeps shared knowledge opt-in and one-directional', () => {
    const deps = testDeps();
    const a = createProject({ name: 'AiWow' }, deps);
    const b = createProject({ name: 'Other' }, deps);

    expect(a.settings.sharedKnowledgeFrom).toBeUndefined();

    const granting = updateProject(a, { settings: { sharedKnowledgeFrom: [b.id] } }, deps.clock);
    expect(granting.settings.sharedKnowledgeFrom).toEqual([b.id]);
    // The grant does not reciprocate.
    expect(b.settings.sharedKnowledgeFrom).toBeUndefined();
  });
});
