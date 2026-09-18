/**
 * Office control-plane state in the webview.
 *
 * Subscribes to `officeState` and `officeError` and exposes command senders.
 * The UI never sees a repository or the database — it sends a message and
 * renders whatever snapshot comes back, which is also why there is no
 * optimistic local mutation here: the server is the authority.
 */

import { useCallback, useEffect, useState } from 'react';

import type {
  AgentDetail,
  OfficeAgent,
  OfficeAgentKnowledge,
  OfficeMembership,
  OfficeOutput,
  OfficeProject,
  OfficeProjectDetail,
  OfficeProjectKnowledge,
  OfficeSession,
  OfficeSkill,
  OfficeState,
  OfficeStorageStatus,
  OfficeTask,
  OfficeTaskInput,
  OutputContent,
  ProjectDetail,
} from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

/** The configuration of the one agent this window has open, if any. */
export interface AgentDetailView {
  agent: OfficeAgent;
  skills: OfficeSkill[];
  knowledge: OfficeAgentKnowledge[];
}

/** The workspace of the one project this window has open, if any. */
export interface ProjectDetailView {
  project: OfficeProjectDetail;
  memberships: OfficeMembership[];
  knowledge: OfficeProjectKnowledge[];
  tasks: OfficeTask[];
  /** Runs in this project, newest first. */
  sessions: OfficeSession[];
  outputs: OfficeOutput[];
}

export interface OfficeView {
  storage: OfficeStorageStatus;
  projects: OfficeProject[];
  agents: OfficeAgent[];
  memberships: OfficeMembership[];
  tasks: OfficeTask[];
  activeProjectId?: string;
  /** The open agent's configuration, or null when none is open. */
  agentDetail: AgentDetailView | null;
  /** The open project's workspace, or null when none is open. */
  projectDetail: ProjectDetailView | null;
  /** The last output whose text was fetched, or null. */
  outputContent: OutputContent | null;
  /** Last failed operation, cleared by the next successful snapshot. */
  error: string | null;
}

const EMPTY: OfficeView = {
  storage: { ready: false, schemaVersion: 0 },
  projects: [],
  agents: [],
  memberships: [],
  tasks: [],
  agentDetail: null,
  projectDetail: null,
  outputContent: null,
  error: null,
};

export interface CreateAgentFields {
  name: string;
  role: string;
  provider: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
}

export interface UpdateAgentFields {
  name?: string;
  role?: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
}

export interface SkillFields {
  slug: string;
  name: string;
  kind: string;
  description?: string;
  content?: string;
  requiredTools?: string[];
}

export interface KnowledgeFields {
  title: string;
  knowledgeType: string;
  content: string;
  tags?: string[];
}

export interface UpdateProjectFields {
  name?: string;
  description?: string;
  status?: string;
  workspacePaths?: string[];
  defaultProvider?: string;
  defaultModel?: string;
}

export interface ProjectKnowledgeFields {
  title: string;
  knowledgeType: string;
  content: string;
  tags?: string[];
}

export interface TaskFields {
  title?: string;
  description?: string;
  priority?: string;
  parentTaskId?: string;
  clearParentTask?: boolean;
  dependencies?: string[];
  inputs?: OfficeTaskInput[];
}

export interface CreateTaskFields {
  title: string;
  description?: string;
  assignedAgentId?: string;
  priority?: string;
  parentTaskId?: string;
  dependencies?: string[];
  inputs?: OfficeTaskInput[];
}

export interface OfficeCommands {
  refresh(): void;
  createProject(name: string, description?: string): void;
  setActiveProject(projectId: string | undefined): void;
  createAgent(fields: CreateAgentFields): void;
  addAgentToProject(projectId: string, agentId: string): void;
  removeAgentFromProject(projectId: string, agentId: string): void;
  createTask(projectId: string, fields: CreateTaskFields): void;
  openProject(projectId: string): void;
  closeProject(): void;
  updateProject(projectId: string, fields: UpdateProjectFields): void;
  createProjectKnowledge(projectId: string, fields: ProjectKnowledgeFields): void;
  updateProjectKnowledge(knowledgeId: string, fields: Partial<ProjectKnowledgeFields>): void;
  deleteProjectKnowledge(knowledgeId: string): void;
  updateTask(taskId: string, fields: TaskFields): void;
  assignTask(taskId: string, agentId: string): void;
  unassignTask(taskId: string): void;
  setTaskStatus(taskId: string, status: string): void;
  deleteTask(taskId: string): void;
  runTask(taskId: string): void;
  cancelTaskRun(): void;
  viewOutput(outputId: string): void;
  clearOutput(): void;
  openAgent(agentId: string): void;
  closeAgent(): void;
  updateAgent(agentId: string, fields: UpdateAgentFields): void;
  createSkill(agentId: string, fields: SkillFields): void;
  updateSkill(skillId: string, fields: Partial<SkillFields>): void;
  deleteSkill(skillId: string): void;
  createKnowledge(agentId: string, fields: KnowledgeFields): void;
  updateKnowledge(knowledgeId: string, fields: Partial<KnowledgeFields>): void;
  deleteKnowledge(knowledgeId: string): void;
}

export function useOfficeState(): OfficeView & OfficeCommands {
  const [view, setView] = useState<OfficeView>(EMPTY);

  useEffect(() => {
    const unsubscribe = transport.onMessage((message) => {
      if (message.type === 'officeState') {
        const state = message as OfficeState;
        setView((current) => ({
          storage: state.storage,
          projects: state.projects,
          agents: state.agents,
          memberships: state.memberships,
          tasks: state.tasks,
          ...(state.activeProjectId === undefined
            ? {}
            : { activeProjectId: state.activeProjectId }),
          // The office snapshot says nothing about the open agent, so the
          // configuration surface keeps whatever the last agentDetail put there.
          agentDetail: current.agentDetail,
          projectDetail: current.projectDetail,
          outputContent: current.outputContent,
          // A fresh snapshot is the truth; any earlier failure is now history.
          error: null,
        }));
      } else if (message.type === 'agentDetail') {
        const detail = message as AgentDetail;
        setView((current) => ({
          ...current,
          agentDetail: {
            agent: detail.agent,
            skills: detail.skills,
            knowledge: detail.knowledge,
          },
          error: null,
        }));
      } else if (message.type === 'projectDetail') {
        const detail = message as ProjectDetail;
        setView((current) => ({
          ...current,
          projectDetail: {
            project: detail.project,
            memberships: detail.memberships,
            knowledge: detail.knowledge,
            tasks: detail.tasks,
            sessions: detail.sessions,
            outputs: detail.outputs,
          },
          error: null,
        }));
      } else if (message.type === 'outputContent') {
        const content = message as OutputContent;
        setView((current) => ({ ...current, outputContent: content }));
      } else if (message.type === 'officeError') {
        const failure = `${message.operation}: ${message.message}`;
        setView((current) => ({ ...current, error: failure }));
      }
    });
    // The server also pushes a snapshot during the ready handshake; this covers
    // a panel opened after that, and a reconnect.
    transport.send({ type: 'requestOffice' });
    return unsubscribe;
  }, []);

  const refresh = useCallback(() => {
    transport.send({ type: 'requestOffice' });
  }, []);

  const createProject = useCallback((name: string, description?: string) => {
    transport.send({
      type: 'createProject',
      name,
      ...(description ? { description } : {}),
    });
  }, []);

  const setActiveProject = useCallback((projectId: string | undefined) => {
    transport.send({ type: 'setActiveProject', ...(projectId ? { projectId } : {}) });
  }, []);

  const createAgent = useCallback((fields: CreateAgentFields) => {
    transport.send({
      type: 'createAgent',
      name: fields.name,
      role: fields.role,
      provider: fields.provider,
      ...(fields.description ? { description: fields.description } : {}),
      ...(fields.systemPrompt ? { systemPrompt: fields.systemPrompt } : {}),
      ...(fields.model ? { model: fields.model } : {}),
    });
  }, []);

  const addAgentToProject = useCallback((projectId: string, agentId: string) => {
    transport.send({ type: 'addAgentToProject', projectId, agentId });
  }, []);

  const removeAgentFromProject = useCallback((projectId: string, agentId: string) => {
    transport.send({ type: 'removeAgentFromProject', projectId, agentId });
  }, []);

  const createTask = useCallback((projectId: string, fields: CreateTaskFields) => {
    transport.send({
      type: 'createTask',
      projectId,
      title: fields.title,
      ...optional('description', fields.description),
      ...optional('assignedAgentId', fields.assignedAgentId),
      ...optional('priority', fields.priority),
      ...optional('parentTaskId', fields.parentTaskId),
      ...optional('dependencies', fields.dependencies),
      ...optional('inputs', fields.inputs),
    });
  }, []);

  const openProject = useCallback((projectId: string) => {
    transport.send({ type: 'requestProjectDetail', projectId });
  }, []);

  const closeProject = useCallback(() => {
    setView((current) => ({ ...current, projectDetail: null }));
  }, []);

  const updateProject = useCallback((projectId: string, fields: UpdateProjectFields) => {
    transport.send({
      type: 'updateProject',
      projectId,
      ...optional('name', fields.name),
      ...optional('description', fields.description),
      ...optional('status', fields.status),
      ...optional('workspacePaths', fields.workspacePaths),
      ...optional('defaultProvider', fields.defaultProvider),
      ...optional('defaultModel', fields.defaultModel),
    });
  }, []);

  const createProjectKnowledge = useCallback(
    (projectId: string, fields: ProjectKnowledgeFields) => {
      transport.send({
        type: 'createProjectKnowledge',
        projectId,
        title: fields.title,
        knowledgeType: fields.knowledgeType,
        content: fields.content,
        ...optional('tags', fields.tags),
      });
    },
    [],
  );

  const updateProjectKnowledge = useCallback(
    (knowledgeId: string, fields: Partial<ProjectKnowledgeFields>) => {
      transport.send({
        type: 'updateProjectKnowledge',
        knowledgeId,
        ...optional('title', fields.title),
        ...optional('knowledgeType', fields.knowledgeType),
        ...optional('content', fields.content),
        ...optional('tags', fields.tags),
      });
    },
    [],
  );

  const deleteProjectKnowledge = useCallback((knowledgeId: string) => {
    transport.send({ type: 'deleteProjectKnowledge', knowledgeId });
  }, []);

  const updateTask = useCallback((taskId: string, fields: TaskFields) => {
    transport.send({
      type: 'updateTask',
      taskId,
      ...optional('title', fields.title),
      ...optional('description', fields.description),
      ...optional('priority', fields.priority),
      ...optional('parentTaskId', fields.parentTaskId),
      ...optional('clearParentTask', fields.clearParentTask),
      ...optional('dependencies', fields.dependencies),
      ...optional('inputs', fields.inputs),
    });
  }, []);

  const assignTask = useCallback((taskId: string, agentId: string) => {
    transport.send({ type: 'assignTask', taskId, agentId });
  }, []);

  const unassignTask = useCallback((taskId: string) => {
    transport.send({ type: 'unassignTask', taskId });
  }, []);

  const setTaskStatus = useCallback((taskId: string, status: string) => {
    transport.send({ type: 'setTaskStatus', taskId, status });
  }, []);

  const deleteTask = useCallback((taskId: string) => {
    transport.send({ type: 'deleteTask', taskId });
  }, []);

  const runTask = useCallback((taskId: string) => {
    transport.send({ type: 'runTask', taskId });
  }, []);

  const cancelTaskRun = useCallback(() => {
    transport.send({ type: 'cancelTaskRun' });
  }, []);

  const viewOutput = useCallback((outputId: string) => {
    transport.send({ type: 'requestOutputContent', outputId });
  }, []);

  const clearOutput = useCallback(() => {
    setView((current) => ({ ...current, outputContent: null }));
  }, []);

  const openAgent = useCallback((agentId: string) => {
    transport.send({ type: 'requestAgentDetail', agentId });
  }, []);

  // Closing is local: the server keeps no per-window selection worth clearing
  // beyond what the next open replaces.
  const closeAgent = useCallback(() => {
    setView((current) => ({ ...current, agentDetail: null }));
  }, []);

  const updateAgent = useCallback((agentId: string, fields: UpdateAgentFields) => {
    transport.send({
      type: 'updateAgent',
      agentId,
      ...optional('name', fields.name),
      ...optional('role', fields.role),
      ...optional('description', fields.description),
      ...optional('systemPrompt', fields.systemPrompt),
      ...optional('model', fields.model),
    });
  }, []);

  const createSkill = useCallback((agentId: string, fields: SkillFields) => {
    transport.send({
      type: 'createSkill',
      agentId,
      slug: fields.slug,
      name: fields.name,
      kind: fields.kind,
      ...optional('description', fields.description),
      ...optional('content', fields.content),
      ...optional('requiredTools', fields.requiredTools),
    });
  }, []);

  const updateSkill = useCallback((skillId: string, fields: Partial<SkillFields>) => {
    transport.send({
      type: 'updateSkill',
      skillId,
      ...optional('slug', fields.slug),
      ...optional('name', fields.name),
      ...optional('kind', fields.kind),
      ...optional('description', fields.description),
      ...optional('content', fields.content),
      ...optional('requiredTools', fields.requiredTools),
    });
  }, []);

  const deleteSkill = useCallback((skillId: string) => {
    transport.send({ type: 'deleteSkill', skillId });
  }, []);

  const createKnowledge = useCallback((agentId: string, fields: KnowledgeFields) => {
    transport.send({
      type: 'createAgentKnowledge',
      agentId,
      title: fields.title,
      knowledgeType: fields.knowledgeType,
      content: fields.content,
      ...optional('tags', fields.tags),
    });
  }, []);

  const updateKnowledge = useCallback((knowledgeId: string, fields: Partial<KnowledgeFields>) => {
    transport.send({
      type: 'updateAgentKnowledge',
      knowledgeId,
      ...optional('title', fields.title),
      ...optional('knowledgeType', fields.knowledgeType),
      ...optional('content', fields.content),
      ...optional('tags', fields.tags),
    });
  }, []);

  const deleteKnowledge = useCallback((knowledgeId: string) => {
    transport.send({ type: 'deleteAgentKnowledge', knowledgeId });
  }, []);

  return {
    ...view,
    refresh,
    createProject,
    setActiveProject,
    createAgent,
    addAgentToProject,
    removeAgentFromProject,
    createTask,
    openProject,
    closeProject,
    updateProject,
    createProjectKnowledge,
    updateProjectKnowledge,
    deleteProjectKnowledge,
    updateTask,
    assignTask,
    unassignTask,
    setTaskStatus,
    deleteTask,
    runTask,
    cancelTaskRun,
    viewOutput,
    clearOutput,
    openAgent,
    closeAgent,
    updateAgent,
    createSkill,
    updateSkill,
    deleteSkill,
    createKnowledge,
    updateKnowledge,
    deleteKnowledge,
  };
}

/**
 * One optional field, or nothing.
 *
 * Every message sets `additionalProperties: false` and treats a missing field
 * as "leave this alone", so an explicit `undefined` must never reach the wire.
 */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
