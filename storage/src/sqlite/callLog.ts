/**
 * SQLite adapter for `AgentCallLogStore`. See `storage/src/callLog.ts` for
 * why this is a sibling table rather than a reuse of `tasks`/`agent_sessions`.
 */

import * as crypto from 'node:crypto';

import type {
  AgentCall,
  AgentCallLogStore,
  AgentCallStatus,
  AgentCallUsage,
  EndAgentCallInput,
  StartAgentCallInput,
} from '../callLog.js';
import type { Row, SqliteDatabase } from './database.js';

const OPEN_STATUSES: readonly AgentCallStatus[] = ['running', 'waiting_response'];
const TERMINAL_STATUSES: readonly AgentCallStatus[] = [
  'ended',
  'failed',
  'unknown',
  'background_not_tracked',
];

export class SqliteAgentCallLogStore implements AgentCallLogStore {
  constructor(private readonly db: SqliteDatabase) {}

  async start(input: StartAgentCallInput): Promise<AgentCall> {
    const existing = await this.get(input.parentSessionId, input.toolUseId);
    if (existing) {
      // Idempotent: a replayed/duplicated start event must not reset
      // startedAt or create a second row for the same call.
      return existing;
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO agent_calls
         (id, agent_name, agent_file_path, recognized, parent_session_id, tool_use_id,
          task_text, task_description, status, started_at, start_unknown, ended_at,
          usage_input_tokens, usage_output_tokens, usage_cache_creation_tokens, usage_cache_read_tokens,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      [
        id,
        input.agentName,
        input.agentFilePath ?? null,
        input.recognized ? 1 : 0,
        input.parentSessionId,
        input.toolUseId,
        input.taskText ?? null,
        input.taskDescription ?? null,
        input.startedAt ?? null,
        input.startedAt ? 0 : 1,
        now,
        now,
      ],
    );
    const created = await this.get(input.parentSessionId, input.toolUseId);
    if (!created) {
      throw new Error('agent_calls: row vanished immediately after insert');
    }
    return created;
  }

  async markStatus(
    parentSessionId: string,
    toolUseId: string,
    status: AgentCallStatus,
  ): Promise<void> {
    this.db.run(
      `UPDATE agent_calls SET status = ?, updated_at = ?
        WHERE parent_session_id = ? AND tool_use_id = ?
          AND status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(',')})`,
      [status, new Date().toISOString(), parentSessionId, toolUseId, ...TERMINAL_STATUSES],
    );
  }

  async end(input: EndAgentCallInput): Promise<void> {
    this.db.run(
      `UPDATE agent_calls SET status = ?, ended_at = ?, updated_at = ?
        WHERE parent_session_id = ? AND tool_use_id = ?
          AND status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(',')})`,
      [
        input.status,
        input.endedAt,
        new Date().toISOString(),
        input.parentSessionId,
        input.toolUseId,
        ...TERMINAL_STATUSES,
      ],
    );
  }

  async setUsage(parentSessionId: string, toolUseId: string, usage: AgentCallUsage): Promise<void> {
    this.db.run(
      `UPDATE agent_calls SET
         usage_input_tokens = ?, usage_output_tokens = ?,
         usage_cache_creation_tokens = ?, usage_cache_read_tokens = ?,
         updated_at = ?
       WHERE parent_session_id = ? AND tool_use_id = ?`,
      [
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationTokens,
        usage.cacheReadTokens,
        new Date().toISOString(),
        parentSessionId,
        toolUseId,
      ],
    );
  }

  async listRecent(limit: number, offset = 0): Promise<AgentCall[]> {
    return this.db
      .all(
        `SELECT * FROM agent_calls
          ORDER BY COALESCE(started_at, created_at) DESC, id DESC
          LIMIT ? OFFSET ?`,
        [limit, offset],
      )
      .map(toAgentCall);
  }

  async get(parentSessionId: string, toolUseId: string): Promise<AgentCall | null> {
    const row = this.db.get(
      'SELECT * FROM agent_calls WHERE parent_session_id = ? AND tool_use_id = ?',
      [parentSessionId, toolUseId],
    );
    return row ? toAgentCall(row) : null;
  }

  async markOpenCallsUnknown(): Promise<number> {
    return this.db.run(
      `UPDATE agent_calls SET status = 'unknown', updated_at = ?
        WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})`,
      [new Date().toISOString(), ...OPEN_STATUSES],
    );
  }
}

function toAgentCall(row: Row): AgentCall {
  const usage =
    row['usage_input_tokens'] === null
      ? undefined
      : {
          inputTokens: Number(row['usage_input_tokens']),
          outputTokens: Number(row['usage_output_tokens'] ?? 0),
          cacheCreationTokens: Number(row['usage_cache_creation_tokens'] ?? 0),
          cacheReadTokens: Number(row['usage_cache_read_tokens'] ?? 0),
        };
  return {
    id: String(row['id']),
    agentName: String(row['agent_name']),
    ...(row['agent_file_path'] === null ? {} : { agentFilePath: String(row['agent_file_path']) }),
    recognized: Number(row['recognized']) === 1,
    parentSessionId: String(row['parent_session_id']),
    toolUseId: String(row['tool_use_id']),
    ...(row['task_text'] === null ? {} : { taskText: String(row['task_text']) }),
    ...(row['task_description'] === null
      ? {}
      : { taskDescription: String(row['task_description']) }),
    status: String(row['status']) as AgentCallStatus,
    ...(row['started_at'] === null ? {} : { startedAt: String(row['started_at']) }),
    startUnknown: Number(row['start_unknown']) === 1,
    ...(row['ended_at'] === null ? {} : { endedAt: String(row['ended_at']) }),
    ...(usage ? { usage } : {}),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}
