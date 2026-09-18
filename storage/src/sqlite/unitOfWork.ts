/**
 * SQLite UnitOfWork.
 *
 * Same contract as the in-memory one, by a different mechanism: BEGIN /
 * COMMIT / ROLLBACK on the shared connection instead of snapshot-and-restore.
 * That is the point of the port — a caller reasons about failure identically
 * either way.
 *
 * The two structural rules are the same as in-memory, and for the same reasons:
 *
 *  - top-level transactions are serialised, because SQLite has no nested
 *    transactions on one connection and two overlapping BEGINs would either
 *    error or silently join;
 *  - a `run()` nested inside another joins the outer transaction rather than
 *    opening its own, so an inner "commit" cannot survive an outer rollback.
 *
 * Nesting is detected with AsyncLocalStorage, not a depth counter: while an
 * outer transaction is parked on an await, an unrelated top-level caller must
 * queue rather than be swept into it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Repositories, UnitOfWork } from '../../../domain/src/index.js';
import { Mutex } from '../memory/transaction.js';
import type { SqliteDatabase } from './database.js';
import type { FileBlobStore } from './fileBlobStore.js';

export class SqliteUnitOfWork implements UnitOfWork {
  private readonly mutex = new Mutex();
  private readonly inTransaction = new AsyncLocalStorage<true>();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly repos: Repositories,
    /** Blob content is not in SQLite, so it gets its own compensating journal. */
    private readonly blobs: FileBlobStore,
  ) {}

  async run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    if (this.inTransaction.getStore()) {
      return fn(this.repos);
    }
    return this.mutex.run(() =>
      this.inTransaction.run(true, async () => {
        this.db.exec('BEGIN');
        const journal = this.blobs.beginTransaction();
        let result: T;
        try {
          result = await fn(this.repos);
        } catch (error) {
          // A failed ROLLBACK would mask the real error, so it is suppressed.
          try {
            this.db.exec('ROLLBACK');
          } catch {
            /* the transaction is already gone */
          }
          journal.rollback();
          throw error;
        }
        try {
          this.db.exec('COMMIT');
        } catch (error) {
          journal.rollback();
          throw error;
        }
        journal.commit();
        return result;
      }),
    );
  }
}
