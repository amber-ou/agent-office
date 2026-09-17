/**
 * AgentSession lifecycle, and the Definition / Session separation (ADR 002).
 */

import { describe, expect, it } from 'vitest';

import {
  bindExternalRuntime,
  canTransitionSession,
  createAgentDefinition,
  createProject,
  isLiveSession,
  isTerminalSession,
  recordHeartbeat,
  SessionStatus,
  startSession,
  transitionSession,
} from '../src/index.js';
import { testDeps } from './support.js';

function scenario() {
  const deps = testDeps();
  const project = createProject({ name: 'AiWow' }, deps);
  const agent = createAgentDefinition(
    { projectId: project.id, name: 'Research Agent', role: 'research', provider: 'claude' },
    deps,
  );
  return { deps, project, agent };
}

describe('AgentSession', () => {
  it('starts in STARTING and carries the canonical agent id', () => {
    const { deps, project, agent } = scenario();
    const session = startSession(
      { agentId: agent.id, projectId: project.id, provider: 'claude' },
      deps,
    );

    expect(session.status).toBe(SessionStatus.STARTING);
    expect(session.agentId).toBe(agent.id);
    expect(session.projectId).toBe(project.id);
    expect(session.providerSessionId).toBeUndefined();
    expect(session.endedAt).toBeUndefined();
  });

  it('walks the lifecycle and stamps endedAt on a terminal state', () => {
    const { deps, project, agent } = scenario();
    let session = startSession(
      { agentId: agent.id, projectId: project.id, provider: 'claude' },
      deps,
    );

    session = transitionSession(session, SessionStatus.RUNNING, deps.clock);
    expect(isLiveSession(session.status)).toBe(true);

    session = transitionSession(session, SessionStatus.IDLE, deps.clock);
    expect(session.endedAt).toBeUndefined();

    session = transitionSession(session, SessionStatus.ENDED, deps.clock);
    expect(isTerminalSession(session.status)).toBe(true);
    expect(session.endedAt).toBeDefined();
  });

  it('refuses an illegal transition and refuses to resurrect a terminal session', () => {
    const { deps, project, agent } = scenario();
    const starting = startSession(
      { agentId: agent.id, projectId: project.id, provider: 'claude' },
      deps,
    );

    expect(canTransitionSession(SessionStatus.STARTING, SessionStatus.ENDED)).toBe(false);
    expect(() => transitionSession(starting, SessionStatus.ENDED, deps.clock)).toThrow(
      /illegal session transition/,
    );

    const ended = transitionSession(
      transitionSession(starting, SessionStatus.RUNNING, deps.clock),
      SessionStatus.ENDED,
      deps.clock,
    );
    expect(() => transitionSession(ended, SessionStatus.RUNNING, deps.clock)).toThrow(
      /illegal session transition/,
    );
  });

  it('records a failure reason when failing', () => {
    const { deps, project, agent } = scenario();
    const session = transitionSession(
      startSession({ agentId: agent.id, projectId: project.id, provider: 'claude' }, deps),
      SessionStatus.FAILED,
      deps.clock,
      { error: 'runtime exited 1' },
    );

    expect(session.status).toBe(SessionStatus.FAILED);
    expect(session.error).toBe('runtime exited 1');
    expect(session.endedAt).toBeDefined();
  });

  it('holds external runtime identity separately, and treats it as optional', () => {
    const { deps, project, agent } = scenario();
    const session = startSession(
      { agentId: agent.id, projectId: project.id, provider: 'claude' },
      deps,
    );

    // A session is perfectly valid with no provider id at all.
    expect(session.providerSessionId).toBeUndefined();

    const bound = bindExternalRuntime(session, {
      providerSessionId: 'a1b2c3d4-0000-4000-8000-000000000001',
      runtimeAgentId: 7,
      transcriptPath: '/home/u/.claude/projects/x/y.jsonl',
    });

    // Canonical identity is untouched by external metadata arriving.
    expect(bound.id).toBe(session.id);
    expect(bound.providerSessionId).toBe('a1b2c3d4-0000-4000-8000-000000000001');
    expect(bound.runtimeAgentId).toBe(7);
  });

  it('keeps the AgentDefinition alive across the whole session lifecycle', () => {
    const { deps, project, agent } = scenario();
    const first = transitionSession(
      transitionSession(
        startSession({ agentId: agent.id, projectId: project.id, provider: 'claude' }, deps),
        SessionStatus.RUNNING,
        deps.clock,
      ),
      SessionStatus.ENDED,
      deps.clock,
    );
    const second = startSession(
      { agentId: agent.id, projectId: project.id, provider: 'claude' },
      deps,
    );

    // Two runs, one definition. Ending a run deletes nothing.
    expect(first.id).not.toBe(second.id);
    expect(first.agentId).toBe(agent.id);
    expect(second.agentId).toBe(agent.id);
  });

  it('stamps heartbeats with the control plane clock', () => {
    const { deps, project, agent } = scenario();
    const session = startSession(
      { agentId: agent.id, projectId: project.id, provider: 'claude' },
      deps,
    );
    expect(session.lastHeartbeatAt).toBeUndefined();

    const beat = recordHeartbeat(session, deps.clock);
    expect(beat.lastHeartbeatAt).toBeDefined();
    expect(() => new Date(beat.lastHeartbeatAt!).toISOString()).not.toThrow();
  });
});
