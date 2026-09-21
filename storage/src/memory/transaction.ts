/**
 * Snapshot machinery for the in-memory adapter's transactions.
 *
 * This is storage-internal. `domain/src/repositories.ts` declares only
 * `UnitOfWork.run()`; nothing about snapshots, handles or mutexes crosses into
 * the domain (ADR 004). A SQL adapter satisfies the same port with a real
 * database transaction and never imports this file.
 */

/** A captured point-in-time state, restorable exactly once per capture. */
export interface SnapshotHandle {
  restore(): void;
}

/**
 * Something whose whole state can be captured and put back.
 *
 * Deliberately existential: `capture()` returns a closure that knows how to
 * restore its own owner, so a UnitOfWork can hold handles for repositories of
 * completely different entity types in one flat list without any casting.
 */
export interface Snapshottable {
  capture(): SnapshotHandle;
}

/**
 * Restore a Map's contents in place.
 *
 * In place, not by reassignment, because the owning repository holds `items` as
 * a readonly field and hands the same reference to its own reads. Swapping the
 * reference would leave anything that captured it pointing at the pre-rollback
 * map.
 */
export function captureMap<K, V>(live: Map<K, V>): SnapshotHandle {
  // A shallow copy is sufficient and correct here: stored values are never
  // mutated in place. Repositories clone on `put` and clone again on read, so
  // the only way a stored entity changes is being replaced wholesale by another
  // `put` — which the Map copy already isolates us from.
  const saved = new Map(live);
  return {
    restore(): void {
      live.clear();
      for (const [key, value] of saved) {
        live.set(key, value);
      }
    },
  };
}

/** Capture several snapshottables as one handle; restores in reverse order. */
export function captureAll(targets: readonly Snapshottable[]): SnapshotHandle {
  const handles = targets.map((target) => target.capture());
  return {
    restore(): void {
      for (let i = handles.length - 1; i >= 0; i--) {
        handles[i]!.restore();
      }
    },
  };
}

/**
 * Serialises top-level transactions.
 *
 * Without it, two overlapping `run()` calls would each snapshot a state that
 * already contains the other's writes, and one rollback would silently discard
 * the other transaction's committed work. Serialising gives the in-memory
 * adapter the isolation a SQL transaction provides, so the two behave alike.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the tail regardless of how the previous holder settled, so one
    // rejected transaction cannot wedge the queue.
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
