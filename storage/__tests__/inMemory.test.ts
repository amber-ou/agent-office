/**
 * The in-memory adapter against the shared repository contract, plus the few
 * behaviours that are specific to it.
 */

import { describe, expect, it } from 'vitest';

import type { Repositories } from '../../domain/src/index.js';
import { createProject } from '../../domain/src/index.js';
import { createInMemoryRepositories, InMemoryUnitOfWork } from '../src/index.js';
import { describeRepositoryContract } from './repositoryContract.js';

describeRepositoryContract({
  name: 'in-memory',
  create: () => createInMemoryRepositories(),
});

describe('in-memory adapter specifics', () => {
  const deps = {
    ids: {
      next: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `0000000f-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
        };
      })(),
    },
    clock: { now: () => new Date(Date.UTC(2026, 0, 1)).toISOString() },
  };

  it('starts empty and reports its size', async () => {
    const repos = createInMemoryRepositories();
    expect(repos.projects.size).toBe(0);

    await repos.projects.put(createProject({ name: 'AiWow' }, deps));
    expect(repos.projects.size).toBe(1);

    repos.projects.clear();
    expect(repos.projects.size).toBe(0);
    expect(await repos.projects.list()).toEqual([]);
  });

  it('runs a unit of work and hands back the same repositories', async () => {
    const repos = createInMemoryRepositories();
    const uow = new InMemoryUnitOfWork(repos);

    const name = await uow.run(async (inner: Repositories) => {
      const project = createProject({ name: 'AiWow' }, deps);
      await inner.projects.put(project);
      return (await inner.projects.get(project.id))?.name;
    });

    expect(name).toBe('AiWow');
    expect(repos.projects.size).toBe(1);
  });

  it('propagates a failure out of a unit of work without rolling back', async () => {
    // Documented limitation, not a stub: a Map has nothing to roll back to. The
    // port exists so the SQL adapter can wrap a real transaction later.
    const repos = createInMemoryRepositories();
    const uow = new InMemoryUnitOfWork(repos);

    await expect(
      uow.run(async (inner) => {
        await inner.projects.put(createProject({ name: 'Doomed' }, deps));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(repos.projects.size).toBe(1);
  });

  it('refuses to read a reference it does not own', async () => {
    const repos = createInMemoryRepositories();
    await expect(repos.blobs.read({ store: 'file', path: '/etc/passwd' })).rejects.toThrow(
      /cannot read a 'file' reference/,
    );
    await expect(repos.blobs.read({ store: 'blob', key: 'missing' })).rejects.toThrow(
      /blob not found/,
    );
  });
});
