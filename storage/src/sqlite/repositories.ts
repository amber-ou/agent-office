/**
 * SQLite implementations of the domain storage ports.
 *
 * All repositories share one `SqliteDatabase` connection, which is what makes
 * `SqliteUnitOfWork` able to wrap any combination of them in one transaction:
 * whatever a repository writes between BEGIN and COMMIT is part of it, with no
 * per-repository plumbing.
 *
 * Filtering that SQL does well (owner, status, type) is a WHERE clause. Tag
 * filtering is done in TypeScript because tags are a JSON array and an
 * "AND over N tags" query would need either json_each or a tags table — neither
 * earns its keep at this scale, and the contract only requires the behaviour.
 */

import type {
  AgentDefinition,
  AgentId,
  AgentKnowledge,
  AgentKnowledgeId,
  AgentKnowledgeRepository,
  AgentRepository,
  AgentSession,
  AgentSessionRepository,
  KnowledgeFilter,
  OutputId,
  OutputItem,
  OutputRepository,
  Project,
  ProjectAgent,
  ProjectAgentId,
  ProjectAgentRepository,
  ProjectId,
  ProjectKnowledge,
  ProjectKnowledgeId,
  ProjectKnowledgeRepository,
  ProjectRepository,
  ProjectStatus,
  SessionId,
  Skill,
  SkillId,
  SkillRepository,
  Task,
  TaskId,
  TaskRepository,
  TaskStatus,
} from '../../../domain/src/index.js';
import { isLiveSession, SessionStatus } from '../../../domain/src/index.js';
import type { Param, Row, SqliteDatabase } from './database.js';
import {
  AGENT_COLUMNS,
  AGENT_KNOWLEDGE_COLUMNS,
  agentKnowledgeToParams,
  agentToParams,
  OUTPUT_COLUMNS,
  outputToParams,
  placeholders,
  PROJECT_AGENT_COLUMNS,
  PROJECT_COLUMNS,
  PROJECT_KNOWLEDGE_COLUMNS,
  projectAgentToParams,
  projectKnowledgeToParams,
  projectToParams,
  rowToAgent,
  rowToAgentKnowledge,
  rowToOutput,
  rowToProject,
  rowToProjectAgent,
  rowToProjectKnowledge,
  rowToSession,
  rowToSkill,
  rowToTask,
  SESSION_COLUMNS,
  sessionToParams,
  SKILL_COLUMNS,
  skillToParams,
  TASK_COLUMNS,
  taskToParams,
} from './mapping.js';

/** Shared CRUD over one table. Subclasses add the queries the port needs. */
abstract class SqliteRepository<T extends { id: Id }, Id extends string> {
  private readonly upsertSql: string;

  constructor(
    protected readonly db: SqliteDatabase,
    private readonly table: string,
    private readonly columns: string,
    private readonly toParams: (entity: T) => Param[],
    private readonly fromRow: (row: Row) => T,
  ) {
    const names = columns.split(',').map((column) => column.trim());
    const assignments = names
      .filter((name) => name !== 'id')
      .map((name) => `${name} = excluded.${name}`)
      .join(', ');
    // A true upsert, NOT `INSERT OR REPLACE`.
    //
    // `INSERT OR REPLACE` DELETEs the conflicting row before inserting, and
    // that delete fires ON DELETE CASCADE: re-saving a project would silently
    // destroy its tasks, memberships and knowledge. It also resolves a UNIQUE
    // conflict by replacing the other row, which makes every unique index in
    // the schema inert — a second membership for the same (project, agent)
    // pair would quietly overwrite the first instead of being refused.
    //
    // ON CONFLICT(id) DO UPDATE touches only the row with that id, leaves
    // children alone, and lets every other constraint raise as it should.
    this.upsertSql =
      `INSERT INTO ${table} (${columns}) VALUES (${placeholders(columns)}) ` +
      `ON CONFLICT(id) DO UPDATE SET ${assignments}`;
  }

  async get(id: Id): Promise<T | null> {
    const row = this.db.get(`SELECT ${this.columns} FROM ${this.table} WHERE id = ?`, [id]);
    return row ? this.fromRow(row) : null;
  }

  async put(entity: T): Promise<void> {
    this.db.run(this.upsertSql, this.toParams(entity));
  }

  async delete(id: Id): Promise<boolean> {
    return this.db.run(`DELETE FROM ${this.table} WHERE id = ?`, [id]) > 0;
  }

  protected query(where: string, params: readonly Param[] = []): T[] {
    const clause = where.length > 0 ? ` ${where}` : '';
    return this.db
      .all(`SELECT ${this.columns} FROM ${this.table}${clause}`, params)
      .map((row) => this.fromRow(row));
  }

  protected queryOne(where: string, params: readonly Param[] = []): T | null {
    const row = this.db.get(`SELECT ${this.columns} FROM ${this.table} ${where} LIMIT 1`, params);
    return row ? this.fromRow(row) : null;
  }
}

/** `IN (?, ?, ?)` for a list filter, with its bound parameters. */
function inClause(values: readonly string[]): { sql: string; params: Param[] } {
  return { sql: `(${values.map(() => '?').join(', ')})`, params: [...values] };
}

function matchesTags(tags: readonly string[], wanted?: readonly string[]): boolean {
  return !wanted || wanted.every((tag) => tags.includes(tag));
}

// ── Project ──────────────────────────────────────────────────────

export class SqliteProjectRepository
  extends SqliteRepository<Project, ProjectId>
  implements ProjectRepository
{
  constructor(db: SqliteDatabase) {
    super(db, 'projects', PROJECT_COLUMNS, projectToParams, rowToProject);
  }

  async list(filter?: { status?: readonly ProjectStatus[] }): Promise<Project[]> {
    if (!filter?.status) {
      return this.query('');
    }
    const { sql, params } = inClause(filter.status);
    return this.query(`WHERE status IN ${sql}`, params);
  }
}

// ── AgentDefinition (global) ─────────────────────────────────────

export class SqliteAgentRepository
  extends SqliteRepository<AgentDefinition, AgentId>
  implements AgentRepository
{
  constructor(db: SqliteDatabase) {
    super(db, 'agents', AGENT_COLUMNS, agentToParams, rowToAgent);
  }

  async list(): Promise<AgentDefinition[]> {
    return this.query('');
  }

  async listByRole(role: string): Promise<AgentDefinition[]> {
    return this.query('WHERE role = ?', [role]);
  }
}

// ── ProjectAgent membership ──────────────────────────────────────

export class SqliteProjectAgentRepository
  extends SqliteRepository<ProjectAgent, ProjectAgentId>
  implements ProjectAgentRepository
{
  constructor(db: SqliteDatabase) {
    super(db, 'project_agents', PROJECT_AGENT_COLUMNS, projectAgentToParams, rowToProjectAgent);
  }

  async listByProject(projectId: ProjectId): Promise<ProjectAgent[]> {
    return this.query('WHERE project_id = ?', [projectId]);
  }

  async listByAgent(agentId: AgentId): Promise<ProjectAgent[]> {
    return this.query('WHERE agent_id = ?', [agentId]);
  }

  async find(projectId: ProjectId, agentId: AgentId): Promise<ProjectAgent | null> {
    return this.queryOne('WHERE project_id = ? AND agent_id = ?', [projectId, agentId]);
  }

  async listReports(projectId: ProjectId, managerAgentId: AgentId): Promise<ProjectAgent[]> {
    return this.query('WHERE project_id = ? AND manager_agent_id = ?', [projectId, managerAgentId]);
  }
}

// ── Skill (agent-owned) ──────────────────────────────────────────

export class SqliteSkillRepository
  extends SqliteRepository<Skill, SkillId>
  implements SkillRepository
{
  constructor(db: SqliteDatabase) {
    super(db, 'skills', SKILL_COLUMNS, skillToParams, rowToSkill);
  }

  async listByAgent(agentId: AgentId): Promise<Skill[]> {
    return this.query('WHERE agent_id = ?', [agentId]);
  }

  async findBySlug(agentId: AgentId, slug: string): Promise<Skill | null> {
    return this.queryOne('WHERE agent_id = ? AND slug = ?', [agentId, slug]);
  }
}

// ── Task (project-owned) ─────────────────────────────────────────

export class SqliteTaskRepository extends SqliteRepository<Task, TaskId> implements TaskRepository {
  constructor(db: SqliteDatabase) {
    super(db, 'tasks', TASK_COLUMNS, taskToParams, rowToTask);
  }

  private statusFilter(base: string, baseParams: Param[], status?: readonly TaskStatus[]): Task[] {
    if (!status) {
      return this.query(`WHERE ${base}`, baseParams);
    }
    const { sql, params } = inClause(status);
    return this.query(`WHERE ${base} AND status IN ${sql}`, [...baseParams, ...params]);
  }

  async listByProject(
    projectId: ProjectId,
    filter?: { status?: readonly TaskStatus[] },
  ): Promise<Task[]> {
    return this.statusFilter('project_id = ?', [projectId], filter?.status);
  }

  async listByAgent(
    agentId: AgentId,
    filter?: { status?: readonly TaskStatus[] },
  ): Promise<Task[]> {
    return this.statusFilter('assigned_agent_id = ?', [agentId], filter?.status);
  }

  async listChildren(parentTaskId: TaskId): Promise<Task[]> {
    return this.query('WHERE parent_task_id = ?', [parentTaskId]);
  }

  async listDependencies(taskId: TaskId): Promise<Task[]> {
    const task = await this.get(taskId);
    if (!task || task.dependencies.length === 0) {
      return [];
    }
    const { sql, params } = inClause(task.dependencies);
    const found = new Map(this.query(`WHERE id IN ${sql}`, params).map((t) => [t.id, t]));
    // Preserve the order the task declared, and drop ids that no longer exist.
    return task.dependencies.flatMap((id) => {
      const dependency = found.get(id);
      return dependency ? [dependency] : [];
    });
  }
}

// ── AgentSession ─────────────────────────────────────────────────

export class SqliteAgentSessionRepository
  extends SqliteRepository<AgentSession, SessionId>
  implements AgentSessionRepository
{
  constructor(db: SqliteDatabase) {
    super(db, 'agent_sessions', SESSION_COLUMNS, sessionToParams, rowToSession);
  }

  async listByProject(projectId: ProjectId): Promise<AgentSession[]> {
    return this.query('WHERE project_id = ?', [projectId]);
  }

  async listByAgent(agentId: AgentId): Promise<AgentSession[]> {
    return this.query('WHERE agent_id = ?', [agentId]);
  }

  async listLiveByAgent(agentId: AgentId): Promise<AgentSession[]> {
    const live = [SessionStatus.STARTING, SessionStatus.RUNNING, SessionStatus.IDLE];
    const { sql, params } = inClause(live);
    const rows = this.query(`WHERE agent_id = ? AND status IN ${sql}`, [agentId, ...params]);
    // Belt and braces: the domain decides what "live" means, not this list.
    return rows.filter((session) => isLiveSession(session.status));
  }

  async listByProviderSessionId(
    provider: string,
    providerSessionId: string,
  ): Promise<AgentSession[]> {
    return this.query('WHERE provider = ? AND provider_session_id = ?', [
      provider,
      providerSessionId,
    ]);
  }
}

// ── Knowledge: two tables, never one ─────────────────────────────

export class SqliteAgentKnowledgeRepository
  extends SqliteRepository<AgentKnowledge, AgentKnowledgeId>
  implements AgentKnowledgeRepository
{
  constructor(db: SqliteDatabase) {
    super(
      db,
      'agent_knowledge',
      AGENT_KNOWLEDGE_COLUMNS,
      agentKnowledgeToParams,
      rowToAgentKnowledge,
    );
  }

  async listByAgent(agentId: AgentId, filter?: KnowledgeFilter): Promise<AgentKnowledge[]> {
    const params: Param[] = [agentId];
    let where = 'agent_id = ?';
    if (filter?.type) {
      const { sql, params: typeParams } = inClause(filter.type);
      where += ` AND type IN ${sql}`;
      params.push(...typeParams);
    }
    return this.query(`WHERE ${where}`, params).filter((item) =>
      matchesTags(item.tags, filter?.tags),
    );
  }
}

export class SqliteProjectKnowledgeRepository
  extends SqliteRepository<ProjectKnowledge, ProjectKnowledgeId>
  implements ProjectKnowledgeRepository
{
  constructor(db: SqliteDatabase) {
    super(
      db,
      'project_knowledge',
      PROJECT_KNOWLEDGE_COLUMNS,
      projectKnowledgeToParams,
      rowToProjectKnowledge,
    );
  }

  async listByProject(projectId: ProjectId, filter?: KnowledgeFilter): Promise<ProjectKnowledge[]> {
    const params: Param[] = [projectId];
    let where = 'project_id = ?';
    if (filter?.type) {
      const { sql, params: typeParams } = inClause(filter.type);
      where += ` AND type IN ${sql}`;
      params.push(...typeParams);
    }
    return this.query(`WHERE ${where}`, params).filter((item) =>
      matchesTags(item.tags, filter?.tags),
    );
  }
}

// ── Output ───────────────────────────────────────────────────────

export class SqliteOutputRepository
  extends SqliteRepository<OutputItem, OutputId>
  implements OutputRepository
{
  constructor(db: SqliteDatabase) {
    super(db, 'outputs', OUTPUT_COLUMNS, outputToParams, rowToOutput);
  }

  async listByProject(projectId: ProjectId): Promise<OutputItem[]> {
    return this.query('WHERE project_id = ?', [projectId]);
  }

  async listByTask(taskId: TaskId): Promise<OutputItem[]> {
    return this.query('WHERE task_id = ?', [taskId]);
  }
}
