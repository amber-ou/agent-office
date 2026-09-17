/**
 * The in-memory adapter against the shared repository contract, plus the few
 * behaviours that are specific to it.
 */

import { describe, expect, it } from 'vitest';

import { createProject, createTask } from '../../domain/src/index.js';
import {
  createInMemoryRepositories,
  createInMemoryStorage,
  InMemoryUnitOfWork,
} from '../src/index.js';
import { describeRepositoryContract } from './repositoryContract.js';

describeRepositoryContract({
  name: 'in-memory',
  create: () => createInMemoryStorage(),
});

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

describe('in-memory adapter specifics', () => {
  it('starts empty and reports its size', async () => {
    const repos = createInMemoryRepositories();
    expect(repos.projects.size).toBe(0);

    await repos.projects.put(createProject({ name: 'AiWow' }, deps));
    expect(repos.projects.size).toBe(1);

    repos.projects.clear();
    expect(repos.projects.size).toBe(0);
    expect(await repos.projects.list()).toEqual([]);
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

  it('hands the callback the same repositories it was built with', async () => {
    const { repos, uow } = createInMemoryStorage();
    const seen = await uow.run(async (tx) => tx);
    expect(seen).toBe(repos);
  });

  it('serialises overlapping transactions instead of interleaving them', async () => {
    // Without serialisation the second transaction would snapshot a state that
    // already contains the first one's writes, and its rollback would discard
    // work the first transaction committed.
    const { repos, uow } = createInMemoryStorage();
    const project = createProject({ name: 'AiWow' }, deps);
    await repos.projects.put(project);

    const committed = createTask({ projectId: project.id, title: 'Committed' }, deps);
    const discarded = createTask({ projectId: project.id, title: 'Discarded' }, deps);

    const first = uow.run(async (tx) => {
      await tx.tasks.put(committed);
      // Yield, giving an unserialised implementation every chance to interleave.
      await Promise.resolve();
      await Promise.resolve();
    });
    const second = uow.run(async (tx) => {
      await tx.tasks.put(discarded);
      throw new Error('boom');
    });

    await first;
    await expect(second).rejects.toThrow('boom');

    const remaining = await repos.tasks.listByProject(project.id);
    expect(remaining.map((t) => t.title)).toEqual(['Committed']);
  });

  it('does not wedge the queue when a transaction rejects', async () => {
    const { repos, uow } = createInMemoryStorage();
    const project = createProject({ name: 'AiWow' }, deps);
    await repos.projects.put(project);

    await expect(
      uow.run(async () => {
        throw new Error('first');
      }),
    ).rejects.toThrow('first');

    const later = createTask({ projectId: project.id, title: 'Later' }, deps);
    await expect(uow.run(async (tx) => tx.tasks.put(later))).resolves.toBeUndefined();
    expect(await repos.tasks.get(later.id)).not.toBeNull();
  });

  it('joins a nested run to the outer transaction rather than opening its own', async () => {
    // Nesting must not deadlock on the mutex, and an inner "commit" must not
    // survive an outer rollback.
    const { repos, uow } = createInMemoryStorage();
    const project = createProject({ name: 'AiWow' }, deps);
    await repos.projects.put(project);
    const inner = createTask({ projectId: project.id, title: 'Written by the inner run' }, deps);

    await expect(
      uow.run(async () => {
        await uow.run(async (tx) => {
          await tx.tasks.put(inner);
        });
        // The inner run returned, but nothing is committed until the outer one does.
        throw new Error('outer fails');
      }),
    ).rejects.toThrow('outer fails');

    expect(await repos.tasks.get(inner.id)).toBeNull();
  });

  it('does not let a concurrent caller be swept into an in-flight transaction', async () => {
    // The case a depth counter gets wrong: while the first transaction is
    // parked on an await, an unrelated caller starts its own. It must NOT join
    // the first one — otherwise its writes get rolled back by a failure it has
    // nothing to do with, after its own callback already returned successfully.
    const { repos, uow } = createInMemoryStorage();
    const project = createProject({ name: 'AiWow' }, deps);
    await repos.projects.put(project);

    const survivor = createTask({ projectId: project.id, title: 'Unrelated' }, deps);
    let entered!: () => void;
    const hasEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const failing = uow.run(async (tx) => {
      await tx.tasks.put(createTask({ projectId: project.id, title: 'Doomed' }, deps));
      entered();
      await parked;
      throw new Error('boom');
    });

    // Wait until the first transaction is genuinely in flight before starting
    // the second — otherwise both calls resolve their nesting check before
    // either callback has begun, and the interleaving under test never happens.
    await hasEntered;
    const unrelated = uow.run(async (tx) => {
      await tx.tasks.put(survivor);
    });

    release();
    await expect(failing).rejects.toThrow('boom');
    await unrelated;

    const remaining = await repos.tasks.listByProject(project.id);
    expect(remaining.map((t) => t.title)).toEqual(['Unrelated']);
  });

  it('commits a nested run when the outer transaction succeeds', async () => {
    const { repos, uow } = createInMemoryStorage();
    const project = createProject({ name: 'AiWow' }, deps);
    await repos.projects.put(project);
    const inner = createTask({ projectId: project.id, title: 'Nested' }, deps);

    await uow.run(async () => {
      await uow.run(async (tx) => {
        await tx.tasks.put(inner);
      });
    });

    expect(await repos.tasks.get(inner.id)).not.toBeNull();
  });

  it('can be constructed directly against existing repositories', async () => {
    const repos = createInMemoryRepositories();
    const uow = new InMemoryUnitOfWork(repos);
    const project = createProject({ name: 'AiWow' }, deps);

    await uow.run(async (tx) => {
      await tx.projects.put(project);
    });
    expect(repos.projects.size).toBe(1);
  });
});
