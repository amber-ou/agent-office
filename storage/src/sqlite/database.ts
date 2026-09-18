/**
 * Thin wrapper over the SQLite driver.
 *
 * The rest of the SQLite adapter talks to this, not to `node-sqlite3-wasm`
 * directly, so swapping the driver later touches one file. Nothing here knows
 * about the domain.
 */

import { Database } from 'node-sqlite3-wasm';

/** A row as the driver returns it: column name -> primitive. */
export type Row = Record<string, string | number | bigint | Uint8Array | null>;

/** A value that may be bound to a statement parameter. */
export type Param = string | number | bigint | Uint8Array | null;

export interface SqliteDatabaseOptions {
  /** File path, or ':memory:' for an ephemeral database. */
  path: string;
}

export class SqliteDatabase {
  private db: Database | null;
  readonly path: string;

  constructor(options: SqliteDatabaseOptions) {
    this.path = options.path;
    this.db = new Database(options.path);
    // Foreign keys are OFF by default in SQLite and are per-connection, so this
    // has to be set on every open or the schema's REFERENCES clauses are inert.
    this.db.run('PRAGMA foreign_keys = ON');
  }

  private handle(): Database {
    if (!this.db) {
      throw new Error('SQLite database is closed');
    }
    return this.db;
  }

  /** Run a statement that returns no rows. Returns the number of rows changed. */
  run(sql: string, params: readonly Param[] = []): number {
    const result = this.handle().run(sql, params as Param[]);
    return result.changes;
  }

  /** Run several statements. For schema DDL, which has no parameters. */
  exec(sql: string): void {
    this.handle().exec(sql);
  }

  get(sql: string, params: readonly Param[] = []): Row | null {
    return (this.handle().get(sql, params as Param[]) as Row | undefined) ?? null;
  }

  all(sql: string, params: readonly Param[] = []): Row[] {
    return this.handle().all(sql, params as Param[]) as Row[];
  }

  /** `PRAGMA user_version` — the schema version this file is at. */
  get userVersion(): number {
    const row = this.get('PRAGMA user_version');
    return Number(row?.['user_version'] ?? 0);
  }

  setUserVersion(version: number): void {
    // PRAGMA does not accept bound parameters, hence the interpolation. The
    // value is a number we produced, never user input.
    this.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
