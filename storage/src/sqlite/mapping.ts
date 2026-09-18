/**
 * Row <-> domain mapping.
 *
 * There is ONE domain model. These functions translate it to and from SQLite
 * rows; they do not define a second, persistence-shaped model.
 *
 * Two conventions, applied everywhere:
 *
 *  - SQL `NULL` reads back as `undefined`, because that is what the domain uses
 *    for an absent optional. The one place this is lossy is a deliberately-set
 *    `seatId: null`, which returns as `undefined`; both mean "no seat", so
 *    nothing downstream can tell them apart anyway.
 *  - Nested structures travel as JSON text. They are read and written whole, so
 *    a row can never disagree with the domain object it came from.
 */

import type {
  AgentAppearance,
  AgentDefinition,
  AgentId,
  AgentKnowledge,
  AgentKnowledgeId,
  AgentMemoryConfig,
  AgentSession,
  KnowledgeSource,
  KnowledgeType,
  Metadata,
  OutputId,
  OutputItem,
  OutputType,
  Project,
  ProjectAgent,
  ProjectAgentId,
  ProjectId,
  ProjectKnowledge,
  ProjectKnowledgeId,
  ProjectSettings,
  ProjectStatus,
  ResourceRef,
  SessionId,
  SessionStatus,
  Skill,
  SkillId,
  SkillKind,
  SkillSource,
  Task,
  TaskId,
  TaskInput,
  TaskPriority,
  TaskStatus,
  ToolGrant,
} from '../../../domain/src/index.js';
import type { Param, Row } from './database.js';

// ── Column helpers ───────────────────────────────────────────────

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`expected TEXT in column '${column}', got ${typeof value}`);
  }
  return value;
}

/** NULL -> undefined. */
function optionalText(row: Row, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(row: Row, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  return Number(value);
}

function json<T>(row: Row, column: string): T {
  return JSON.parse(text(row, column)) as T;
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

/** undefined -> NULL. */
function nullable(value: string | number | null | undefined): Param {
  return value ?? null;
}

// ── Project ──────────────────────────────────────────────────────

export const PROJECT_COLUMNS = 'id, name, description, status, settings, created_at, updated_at';

export function projectToParams(project: Project): Param[] {
  return [
    project.id,
    project.name,
    project.description,
    project.status,
    toJson(project.settings),
    project.createdAt,
    project.updatedAt,
  ];
}

export function rowToProject(row: Row): Project {
  return {
    id: text(row, 'id') as ProjectId,
    name: text(row, 'name'),
    description: text(row, 'description'),
    status: text(row, 'status') as ProjectStatus,
    settings: json<ProjectSettings>(row, 'settings'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

// ── AgentDefinition ──────────────────────────────────────────────

export const AGENT_COLUMNS =
  'id, name, role, description, system_prompt, provider, model, tools, memory, appearance, created_at, updated_at';

export function agentToParams(agent: AgentDefinition): Param[] {
  return [
    agent.id,
    agent.name,
    agent.role,
    agent.description,
    agent.systemPrompt,
    agent.provider,
    nullable(agent.model),
    toJson(agent.tools),
    toJson(agent.memory),
    toJson(agent.appearance),
    agent.createdAt,
    agent.updatedAt,
  ];
}

export function rowToAgent(row: Row): AgentDefinition {
  const agent: AgentDefinition = {
    id: text(row, 'id') as AgentId,
    name: text(row, 'name'),
    role: text(row, 'role'),
    description: text(row, 'description'),
    systemPrompt: text(row, 'system_prompt'),
    provider: text(row, 'provider'),
    tools: json<ToolGrant[]>(row, 'tools'),
    memory: json<AgentMemoryConfig>(row, 'memory'),
    appearance: json<AgentAppearance>(row, 'appearance'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
  const model = optionalText(row, 'model');
  if (model !== undefined) {
    agent.model = model;
  }
  return agent;
}

// ── ProjectAgent ─────────────────────────────────────────────────

export const PROJECT_AGENT_COLUMNS =
  'id, project_id, agent_id, manager_agent_id, seat_id, created_at, updated_at';

export function projectAgentToParams(membership: ProjectAgent): Param[] {
  return [
    membership.id,
    membership.projectId,
    membership.agentId,
    nullable(membership.managerAgentId),
    nullable(membership.seatId),
    membership.createdAt,
    membership.updatedAt,
  ];
}

export function rowToProjectAgent(row: Row): ProjectAgent {
  const membership: ProjectAgent = {
    id: text(row, 'id') as ProjectAgentId,
    projectId: text(row, 'project_id') as ProjectId,
    agentId: text(row, 'agent_id') as AgentId,
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
  const manager = optionalText(row, 'manager_agent_id');
  if (manager !== undefined) {
    membership.managerAgentId = manager as AgentId;
  }
  const seat = optionalText(row, 'seat_id');
  if (seat !== undefined) {
    membership.seatId = seat;
  }
  return membership;
}

// ── Skill ────────────────────────────────────────────────────────

export const SKILL_COLUMNS =
  'id, agent_id, slug, name, description, kind, source, required_tools, created_at, updated_at';

export function skillToParams(skill: Skill): Param[] {
  return [
    skill.id,
    skill.agentId,
    skill.slug,
    skill.name,
    skill.description,
    skill.kind,
    toJson(skill.source),
    toJson(skill.requiredTools),
    skill.createdAt,
    skill.updatedAt,
  ];
}

export function rowToSkill(row: Row): Skill {
  return {
    id: text(row, 'id') as SkillId,
    agentId: text(row, 'agent_id') as AgentId,
    slug: text(row, 'slug'),
    name: text(row, 'name'),
    description: text(row, 'description'),
    kind: text(row, 'kind') as SkillKind,
    source: json<SkillSource>(row, 'source'),
    requiredTools: json<string[]>(row, 'required_tools'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

// ── Task ─────────────────────────────────────────────────────────

export const TASK_COLUMNS =
  'id, project_id, title, description, assigned_agent_id, created_by_agent_id, parent_task_id, ' +
  'status, priority, dependencies, inputs, outputs, created_at, updated_at';

export function taskToParams(task: Task): Param[] {
  return [
    task.id,
    task.projectId,
    task.title,
    task.description,
    nullable(task.assignedAgentId),
    nullable(task.createdByAgentId),
    nullable(task.parentTaskId),
    task.status,
    task.priority,
    toJson(task.dependencies),
    toJson(task.inputs),
    toJson(task.outputs),
    task.createdAt,
    task.updatedAt,
  ];
}

export function rowToTask(row: Row): Task {
  const task: Task = {
    id: text(row, 'id') as TaskId,
    projectId: text(row, 'project_id') as ProjectId,
    title: text(row, 'title'),
    description: text(row, 'description'),
    status: text(row, 'status') as TaskStatus,
    priority: text(row, 'priority') as TaskPriority,
    dependencies: json<TaskId[]>(row, 'dependencies'),
    inputs: json<TaskInput[]>(row, 'inputs'),
    outputs: json<OutputId[]>(row, 'outputs'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
  const assigned = optionalText(row, 'assigned_agent_id');
  if (assigned !== undefined) {
    task.assignedAgentId = assigned as AgentId;
  }
  const createdBy = optionalText(row, 'created_by_agent_id');
  if (createdBy !== undefined) {
    task.createdByAgentId = createdBy as AgentId;
  }
  const parent = optionalText(row, 'parent_task_id');
  if (parent !== undefined) {
    task.parentTaskId = parent as TaskId;
  }
  return task;
}

// ── AgentSession ─────────────────────────────────────────────────

export const SESSION_COLUMNS =
  'id, agent_id, project_id, task_id, provider, status, started_at, ended_at, ' +
  'last_heartbeat_at, error, provider_session_id, runtime_id, transcript_path, ' +
  'runtime_agent_id, created_at';

export function sessionToParams(session: AgentSession): Param[] {
  return [
    session.id,
    session.agentId,
    session.projectId,
    nullable(session.taskId),
    session.provider,
    session.status,
    session.startedAt,
    nullable(session.endedAt),
    nullable(session.lastHeartbeatAt),
    nullable(session.error),
    nullable(session.providerSessionId),
    nullable(session.runtimeId),
    nullable(session.transcriptPath),
    nullable(session.runtimeAgentId),
    session.startedAt,
  ];
}

export function rowToSession(row: Row): AgentSession {
  const session: AgentSession = {
    id: text(row, 'id') as SessionId,
    agentId: text(row, 'agent_id') as AgentId,
    projectId: text(row, 'project_id') as ProjectId,
    provider: text(row, 'provider'),
    status: text(row, 'status') as SessionStatus,
    startedAt: text(row, 'started_at'),
  };
  const taskId = optionalText(row, 'task_id');
  if (taskId !== undefined) {
    session.taskId = taskId as TaskId;
  }
  // Written one by one rather than through a keyed loop: every assignment is
  // type-checked against the field it targets, so a renamed column or field
  // fails the build instead of silently writing the wrong key.
  const endedAt = optionalText(row, 'ended_at');
  if (endedAt !== undefined) {
    session.endedAt = endedAt;
  }
  const lastHeartbeatAt = optionalText(row, 'last_heartbeat_at');
  if (lastHeartbeatAt !== undefined) {
    session.lastHeartbeatAt = lastHeartbeatAt;
  }
  const error = optionalText(row, 'error');
  if (error !== undefined) {
    session.error = error;
  }
  const providerSessionId = optionalText(row, 'provider_session_id');
  if (providerSessionId !== undefined) {
    session.providerSessionId = providerSessionId;
  }
  const runtimeId = optionalText(row, 'runtime_id');
  if (runtimeId !== undefined) {
    session.runtimeId = runtimeId;
  }
  const transcriptPath = optionalText(row, 'transcript_path');
  if (transcriptPath !== undefined) {
    session.transcriptPath = transcriptPath;
  }
  const runtimeAgentId = optionalNumber(row, 'runtime_agent_id');
  if (runtimeAgentId !== undefined) {
    session.runtimeAgentId = runtimeAgentId;
  }
  return session;
}

// ── Knowledge ────────────────────────────────────────────────────

export const AGENT_KNOWLEDGE_COLUMNS =
  'id, agent_id, type, title, source, location, tags, metadata, created_at, updated_at';

export const PROJECT_KNOWLEDGE_COLUMNS =
  'id, project_id, type, title, source, location, tags, metadata, created_at, updated_at';

export function agentKnowledgeToParams(item: AgentKnowledge): Param[] {
  return [
    item.id,
    item.agentId,
    item.type,
    item.title,
    toJson(item.source),
    toJson(item.location),
    toJson(item.tags),
    toJson(item.metadata),
    item.createdAt,
    item.updatedAt,
  ];
}

export function rowToAgentKnowledge(row: Row): AgentKnowledge {
  return {
    id: text(row, 'id') as AgentKnowledgeId,
    agentId: text(row, 'agent_id') as AgentId,
    type: text(row, 'type') as KnowledgeType,
    title: text(row, 'title'),
    source: json<KnowledgeSource>(row, 'source'),
    location: json<ResourceRef>(row, 'location'),
    tags: json<string[]>(row, 'tags'),
    metadata: json<Metadata>(row, 'metadata'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

export function projectKnowledgeToParams(item: ProjectKnowledge): Param[] {
  return [
    item.id,
    item.projectId,
    item.type,
    item.title,
    toJson(item.source),
    toJson(item.location),
    toJson(item.tags),
    toJson(item.metadata),
    item.createdAt,
    item.updatedAt,
  ];
}

export function rowToProjectKnowledge(row: Row): ProjectKnowledge {
  return {
    id: text(row, 'id') as ProjectKnowledgeId,
    projectId: text(row, 'project_id') as ProjectId,
    type: text(row, 'type') as KnowledgeType,
    title: text(row, 'title'),
    source: json<KnowledgeSource>(row, 'source'),
    location: json<ResourceRef>(row, 'location'),
    tags: json<string[]>(row, 'tags'),
    metadata: json<Metadata>(row, 'metadata'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

// ── Output ───────────────────────────────────────────────────────

export const OUTPUT_COLUMNS =
  'id, project_id, task_id, produced_by_agent_id, session_id, title, type, location, ' +
  'metadata, created_at, updated_at';

export function outputToParams(output: OutputItem): Param[] {
  return [
    output.id,
    output.projectId,
    output.taskId,
    output.producedByAgentId,
    nullable(output.sessionId),
    output.title,
    output.type,
    toJson(output.location),
    toJson(output.metadata),
    output.createdAt,
    output.updatedAt,
  ];
}

export function rowToOutput(row: Row): OutputItem {
  const output: OutputItem = {
    id: text(row, 'id') as OutputId,
    projectId: text(row, 'project_id') as ProjectId,
    taskId: text(row, 'task_id') as TaskId,
    producedByAgentId: text(row, 'produced_by_agent_id') as AgentId,
    title: text(row, 'title'),
    type: text(row, 'type') as OutputType,
    location: json<ResourceRef>(row, 'location'),
    metadata: json<Metadata>(row, 'metadata'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
  const sessionId = optionalText(row, 'session_id');
  if (sessionId !== undefined) {
    output.sessionId = sessionId as SessionId;
  }
  return output;
}

/** `?, ?, ?` for a column list, so INSERT statements stay in step with it. */
export function placeholders(columns: string): string {
  return columns
    .split(',')
    .map(() => '?')
    .join(', ');
}
