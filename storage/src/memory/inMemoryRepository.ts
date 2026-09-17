/**
 * Shared in-memory repository base.
 *
 * Two properties every implementation here must have:
 *
 *  - **Copy on the way in and on the way out.** A repository that hands back a
 *    live reference lets a caller mutate "stored" state without a `put`, which
 *    an SQL-backed repository would never allow. Tests that pass against this
 *    adapter must pass against the next one, so it copies.
 *  - **Async even though it need not be.** The port is async (see
 *    `domain/src/repositories.ts`); honouring that here keeps call sites honest.
 */

import type { Repository } from '../../../domain/src/index.js';

/** JSON deep copy. Every domain entity is JSON-safe by construction. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryRepository<T extends { id: Id }, Id extends string> implements Repository<
  T,
  Id
> {
  protected readonly items = new Map<Id, T>();

  async get(id: Id): Promise<T | null> {
    const found = this.items.get(id);
    return found ? clone(found) : null;
  }

  async put(entity: T): Promise<void> {
    this.items.set(entity.id, clone(entity));
  }

  async delete(id: Id): Promise<boolean> {
    return this.items.delete(id);
  }

  /** All entities, copied. Subclasses filter on top of this. */
  protected all(): T[] {
    return [...this.items.values()].map((item) => clone(item));
  }

  /** Test/diagnostic helper: how many entities are held. */
  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }
}
