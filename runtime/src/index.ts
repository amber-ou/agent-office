/**
 * Runtime adapters — the Control Plane's downward channel.
 *
 * Depends on `domain/` and nothing else beyond Node itself. No storage, no
 * server, no host API (ADR 003, ADR 004).
 */

export type {
  AgentRuntimeAdapter,
  RuntimeDescriptor,
  RuntimeHealth,
  StartRunRequest,
  StartRunResult,
} from './adapter.js';
export { RuntimeBridgeVerb, RuntimeKind } from './adapter.js';
export type {
  ClaudeCliRuntimeOptions,
  ClaudeRunOutcome,
  ClaudeStartRunRequest,
  SpawnLike,
} from './claudeCliRuntime.js';
export { ClaudeCliRuntime } from './claudeCliRuntime.js';
export type { ContentsById, RenderedPrompt } from './promptRenderer.js';
export { renderPrompt } from './promptRenderer.js';
export type { ForbiddenRoots, SandboxSpec } from './sandbox.js';
export {
  buildSandboxArgv,
  INHERITED_ENV_KEYS,
  inheritedEnv,
  resolveBindPath,
  SandboxPathError,
} from './sandbox.js';
