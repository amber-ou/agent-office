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
  OfficeAgent,
  OfficeMembership,
  OfficeProject,
  OfficeState,
  OfficeStorageStatus,
  OfficeTask,
} from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

export interface OfficeView {
  storage: OfficeStorageStatus;
  projects: OfficeProject[];
  agents: OfficeAgent[];
  memberships: OfficeMembership[];
  tasks: OfficeTask[];
  activeProjectId?: string;
  /** Last failed operation, cleared by the next successful snapshot. */
  error: string | null;
}

const EMPTY: OfficeView = {
  storage: { ready: false, schemaVersion: 0 },
  projects: [],
  agents: [],
  memberships: [],
  tasks: [],
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

export interface OfficeCommands {
  refresh(): void;
  createProject(name: string, description?: string): void;
  setActiveProject(projectId: string | undefined): void;
  createAgent(fields: CreateAgentFields): void;
  addAgentToProject(projectId: string, agentId: string): void;
  removeAgentFromProject(projectId: string, agentId: string): void;
  createTask(projectId: string, title: string, description?: string): void;
}

export function useOfficeState(): OfficeView & OfficeCommands {
  const [view, setView] = useState<OfficeView>(EMPTY);

  useEffect(() => {
    const unsubscribe = transport.onMessage((message) => {
      if (message.type === 'officeState') {
        const state = message as OfficeState;
        setView({
          storage: state.storage,
          projects: state.projects,
          agents: state.agents,
          memberships: state.memberships,
          tasks: state.tasks,
          ...(state.activeProjectId === undefined
            ? {}
            : { activeProjectId: state.activeProjectId }),
          // A fresh snapshot is the truth; any earlier failure is now history.
          error: null,
        });
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

  const createTask = useCallback((projectId: string, title: string, description?: string) => {
    transport.send({
      type: 'createTask',
      projectId,
      title,
      ...(description ? { description } : {}),
    });
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
  };
}
