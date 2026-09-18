/**
 * Blob content on the filesystem, beside the database.
 *
 * Knowledge and Output rows hold a `ResourceRef`; the bytes live here. Keeping
 * potentially large content out of SQLite keeps the database small enough to
 * copy, back up and open quickly, and means a big upload is a file write rather
 * than a row rewrite.
 *
 * Layout under the data root:
 *
 *   blobs/project/<projectId>/<n>-<name>
 *   blobs/agent/<agentId>/<n>-<name>
 *
 * The owner kind is part of the path, so agent-owned content is never filed
 * under a project and vice versa (ADR 005).
 *
 * Transactional, by compensation. The UnitOfWork opens a journal around the
 * SQLite transaction: writes are recorded so a rollback can remove them, and
 * deletes are deferred to commit so a rollback has nothing to undo. Within an
 * open transaction a deleted blob already reads as missing, so the caller sees
 * the same state SQLite shows it.
 *
 * This is compensation, not atomicity: a crash between COMMIT and the deferred
 * unlink leaves an orphan file. An orphan is unreferenced and harmless, whereas
 * the opposite failure — a row pointing at content that was rolled away — is
 * not, so the ordering is deliberate.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BlobOwner, BlobStore, ResourceRef } from '../../../domain/src/index.js';

/** Keep a name safe as a single path segment, without silently colliding. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'blob';
}

function ownerSegment(owner: BlobOwner): string {
  return owner.kind === 'project' ? `project/${owner.projectId}` : `agent/${owner.agentId}`;
}

/** Open transaction state: what to undo on rollback, what to finish on commit. */
interface BlobJournalState {
  written: string[];
  pendingDeletes: Set<string>;
}

/** Handle the UnitOfWork drives. */
export interface BlobJournal {
  commit(): void;
  rollback(): void;
}

export class FileBlobStore implements BlobStore {
  private counter = 0;
  private journal: BlobJournalState | null = null;

  constructor(private readonly root: string) {}

  /**
   * Begin a journal. Nesting is not supported and not needed: the UnitOfWork
   * serialises top-level transactions and joins nested ones, so there is only
   * ever one open at a time.
   */
  beginTransaction(): BlobJournal {
    if (this.journal) {
      throw new Error('a blob journal is already open');
    }
    const state: BlobJournalState = { written: [], pendingDeletes: new Set() };
    this.journal = state;
    return {
      commit: (): void => {
        this.journal = null;
        // Deletes were held back so a rollback had nothing to restore.
        for (const key of state.pendingDeletes) {
          this.unlink(key);
        }
      },
      rollback: (): void => {
        this.journal = null;
        for (const key of state.written) {
          this.unlink(key);
        }
      },
    };
  }

  private unlink(key: string): boolean {
    try {
      const file = this.resolve(key);
      if (!fs.existsSync(file)) {
        return false;
      }
      fs.unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    // A key is ours, but resolving defensively costs nothing and stops a
    // malformed one escaping the blob root.
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`blob key escapes the blob root: ${key}`);
    }
    return full;
  }

  async read(ref: ResourceRef): Promise<string> {
    if (ref.store === 'inline') {
      return ref.content;
    }
    if (ref.store !== 'blob') {
      throw new Error(`FileBlobStore cannot read a '${ref.store}' reference`);
    }
    // Inside a transaction, a blob deleted by that transaction is already gone
    // as far as the caller is concerned, even though the file is still there.
    if (this.journal?.pendingDeletes.has(ref.key)) {
      throw new Error(`blob not found: ${ref.key}`);
    }
    const file = this.resolve(ref.key);
    if (!fs.existsSync(file)) {
      throw new Error(`blob not found: ${ref.key}`);
    }
    return fs.readFileSync(file, 'utf-8');
  }

  async write(hint: { owner: BlobOwner; name: string }, content: string): Promise<ResourceRef> {
    this.counter += 1;
    const key = `${ownerSegment(hint.owner)}/${this.counter}-${safeName(hint.name)}`;
    const file = this.resolve(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // tmp + rename, matching how the rest of this repository writes files: a
    // reader never sees a half-written blob.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, file);
    this.journal?.written.push(key);
    return { store: 'blob', key };
  }

  async delete(ref: ResourceRef): Promise<boolean> {
    if (ref.store !== 'blob') {
      return false;
    }
    if (this.journal) {
      if (this.journal.pendingDeletes.has(ref.key) || !fs.existsSync(this.resolve(ref.key))) {
        return false;
      }
      // Deferred to commit: an unlink cannot be undone on rollback.
      this.journal.pendingDeletes.add(ref.key);
      return true;
    }
    return this.unlink(ref.key);
  }

  /**
   * Resume the key sequence from what is already on disk, so a reopened store
   * does not hand out keys that collide with existing blobs.
   */
  restoreCounter(): void {
    let highest = 0;
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const match = /^(\d+)-/.exec(entry.name);
        if (match) {
          highest = Math.max(highest, Number(match[1]));
        }
      }
    };
    walk(this.root);
    this.counter = highest;
  }
}
