/**
 * Agent Office domain model — the public surface.
 *
 * This package depends on nothing: no provider, no storage, no UI, no host API.
 * Anything imported from here is safe in the server, in a runtime adapter, and
 * in the browser office UI alike.
 */

export type {
  AgentAppearance,
  AgentDefinition,
  AgentDefinitionPatch,
  AgentMemoryConfig,
  CreateAgentDefinitionInput,
  ToolGrant,
} from './agentDefinition.js';
export {
  assignSkill,
  createAgentDefinition,
  defaultAgentMemoryConfig,
  normalizeRole,
  ToolMode,
  unassignSkill,
  updateAgentDefinition,
} from './agentDefinition.js';
export type {
  AgentSession,
  ExternalRuntimeRef,
  StartSessionInput,
  TransitionSessionOptions,
} from './agentSession.js';
export {
  bindExternalRuntime,
  canTransitionSession,
  isLiveSession,
  isTerminalSession,
  recordHeartbeat,
  SessionStatus,
  startSession,
  transitionSession,
} from './agentSession.js';
export type {
  AgentStatusInput,
  AgentStatusResolution,
  ObservedRuntimeState,
} from './agentStatus.js';
export {
  AgentStatus,
  agentStatusOf,
  AgentStatusReason,
  resolveAgentStatus,
  unobserved,
} from './agentStatus.js';
export type { Clock, DomainDeps, Timestamp } from './clock.js';
export { systemClock } from './clock.js';
export type {
  AgentContextBundle,
  AgentContextRequest,
  ContextBudget,
  KnowledgeSelector,
} from './context.js';
export { defaultContextBudget } from './context.js';
export { DomainError, DomainErrorCode } from './errors.js';
export type {
  AgentId,
  EntityId,
  IdGenerator,
  KnowledgeId,
  OutputId,
  ProjectId,
  SessionId,
  SkillId,
  TaskId,
} from './ids.js';
export {
  asAgentId,
  asKnowledgeId,
  asOutputId,
  asProjectId,
  asSessionId,
  asSkillId,
  asTaskId,
  isCanonicalId,
  uuidIdGenerator,
} from './ids.js';
export type {
  CreateKnowledgeInput,
  KnowledgeItem,
  KnowledgePatch,
  KnowledgeSource,
} from './knowledge.js';
export { createKnowledgeItem, KnowledgeType, updateKnowledgeItem } from './knowledge.js';
export type { CreateOutputInput, OutputItem, OutputPatch } from './output.js';
export { createOutputItem, OutputType, updateOutputItem } from './output.js';
export type { CreateProjectInput, Project, ProjectPatch, ProjectSettings } from './project.js';
export { createProject, defaultProjectSettings, ProjectStatus, updateProject } from './project.js';
export type { ProjectAggregate } from './projectAggregate.js';
export type {
  AgentRepository,
  AgentSessionRepository,
  BlobStore,
  KnowledgeRepository,
  OutputRepository,
  ProjectRepository,
  Repositories,
  Repository,
  SkillRepository,
  TaskRepository,
  UnitOfWork,
} from './repositories.js';
export type { Metadata, ResourceRef, ResourceStore } from './resource.js';
export { describeResource } from './resource.js';
export type { CreateSkillInput, Skill, SkillPatch, SkillSource } from './skill.js';
export { createSkill, isSkillAvailableTo, normalizeSlug, SkillKind, updateSkill } from './skill.js';
export type { CreateTaskInput, Task, TaskInput, TaskTransitionContext } from './task.js';
export {
  assignTask,
  attachOutput,
  canTransitionTask,
  createTask,
  isTerminalTask,
  TaskPriority,
  TaskStatus,
  transitionTask,
  unassignTask,
} from './task.js';
export type { TaskNode } from './taskGraph.js';
export {
  assertDependenciesValid,
  assertParentValid,
  DependencyViolation,
  findDependencyCycle,
  findParentCycle,
  topologicalOrder,
  validateDependencyEdge,
} from './taskGraph.js';
