/**
 * Project — the isolation boundary of Agent Office.
 *
 * A Project does NOT embed its agents, tasks, knowledge or outputs. Those are
 * separate entities holding a `projectId` foreign key, fetched through their own
 * repositories. The composed view lives in `ProjectAggregate`, which is a read
 * model only and is never persisted. See ADR 001 for why.
 */

import type { Clock, DomainDeps, Timestamp } from './clock.js';
import { requireText } from './errors.js';
import type { ProjectId } from './ids.js';
import { newProjectId } from './ids.js';

export const ProjectStatus = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  ARCHIVED: 'archived',
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export interface ProjectSettings {
  /** Working directories an Agent Runtime may use as cwd for this Project. */
  workspacePaths: string[];
  /** Provider id (matches upstream `HookProvider.id`) for agents that omit one. */
  defaultProvider?: string;
  /** Model id for agents that omit one. Never a provider-specific object. */
  defaultModel?: string;
  /** Which office layout this Project opens. Undefined = the shared default. */
  layoutId?: string;
  /** Office Area labels this Project's characters prefer to sit in. */
  areaLabels?: string[];
  /**
   * Projects are isolated by default. Listing another Project here is an
   * explicit, one-directional grant to read its knowledge — the hook that
   * Shared Knowledge will hang off later. It grants nothing else: not agents,
   * not tasks, not outputs.
   */
  sharedKnowledgeFrom?: ProjectId[];
}

export interface Project {
  id: ProjectId;
  name: string;
  description: string;
  status: ProjectStatus;
  settings: ProjectSettings;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  status?: ProjectStatus;
  settings?: Partial<ProjectSettings>;
}

export function defaultProjectSettings(): ProjectSettings {
  return { workspacePaths: [] };
}

export function createProject(input: CreateProjectInput, deps: DomainDeps): Project {
  const now = deps.clock.now();
  return {
    id: newProjectId(deps.ids),
    name: requireText('project.name', input.name),
    description: input.description?.trim() ?? '',
    status: input.status ?? ProjectStatus.ACTIVE,
    settings: { ...defaultProjectSettings(), ...input.settings },
    createdAt: now,
    updatedAt: now,
  };
}

export type ProjectPatch = Partial<
  Pick<Project, 'name' | 'description' | 'status'> & { settings: Partial<ProjectSettings> }
>;

export function updateProject(project: Project, patch: ProjectPatch, clock: Clock): Project {
  return {
    ...project,
    name: patch.name === undefined ? project.name : requireText('project.name', patch.name),
    description: patch.description === undefined ? project.description : patch.description.trim(),
    status: patch.status ?? project.status,
    settings: patch.settings ? { ...project.settings, ...patch.settings } : project.settings,
    updatedAt: clock.now(),
  };
}
