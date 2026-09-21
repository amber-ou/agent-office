/**
 * Which agents have moved to files, recorded in the database.
 *
 * Deliberately not only in the agent's own directory: the whole point is to
 * still know an agent was migrated when that directory is gone. A missing
 * directory then reads as damage to repair, not as an agent that never moved.
 */

import type { AgentId, Timestamp } from '../../../domain/src/index.js';
import type { SqliteDatabase } from './database.js';

export interface AgentMigrationStore {
  /** True when this agent's configuration has been handed over to its files. */
  isMigrated(agentId: AgentId): Promise<boolean>;
  markMigrated(agentId: AgentId, at: Timestamp): Promise<void>;
  /** Only used by recovery tooling and tests. */
  forget(agentId: AgentId): Promise<void>;
}

export class SqliteAgentMigrationStore implements AgentMigrationStore {
  constructor(private readonly db: SqliteDatabase) {}

  async isMigrated(agentId: AgentId): Promise<boolean> {
    return (
      this.db.get('SELECT agent_id FROM agent_file_migrations WHERE agent_id = ?', [agentId]) !==
      null
    );
  }

  async markMigrated(agentId: AgentId, at: Timestamp): Promise<void> {
    this.db.run(
      `INSERT INTO agent_file_migrations (agent_id, migrated_at) VALUES (?, ?)
       ON CONFLICT(agent_id) DO NOTHING`,
      [agentId, at],
    );
  }

  async forget(agentId: AgentId): Promise<void> {
    this.db.run('DELETE FROM agent_file_migrations WHERE agent_id = ?', [agentId]);
  }
}
