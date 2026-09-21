/**
 * ProjectAgent — Project <-> Agent membership (ADR 005).
 */

import { describe, expect, it } from 'vitest';

import {
  assertManagerIsMember,
  assertNotAlreadyMember,
  createAgentDefinition,
  createProject,
  createProjectAgent,
  updateProjectAgent,
} from '../src/index.js';
import { testDeps } from './support.js';

function world() {
  const deps = testDeps();
  const alpha = createProject({ name: 'Alpha' }, deps);
  const beta = createProject({ name: 'Beta' }, deps);
  const ux = createAgentDefinition({ name: 'UX', role: 'ux', provider: 'claude' }, deps);
  const manager = createAgentDefinition(
    { name: 'Manager', role: 'manager', provider: 'claude' },
    deps,
  );
  return { deps, alpha, beta, ux, manager };
}

describe('ProjectAgent', () => {
  it('lets one agent join several projects at once', () => {
    const { deps, alpha, beta, ux } = world();
    const inAlpha = createProjectAgent({ projectId: alpha.id, agentId: ux.id }, deps);
    const inBeta = createProjectAgent({ projectId: beta.id, agentId: ux.id }, deps);

    // One agent, two memberships, one definition.
    expect(inAlpha.agentId).toBe(ux.id);
    expect(inBeta.agentId).toBe(ux.id);
    expect(inAlpha.id).not.toBe(inBeta.id);
    expect(inAlpha.projectId).not.toBe(inBeta.projectId);
  });

  it('holds the per-project fields that cannot live on a global agent', () => {
    const { deps, alpha, ux, manager } = world();
    const membership = createProjectAgent(
      { projectId: alpha.id, agentId: ux.id, managerAgentId: manager.id, seatId: 'desk-3' },
      deps,
    );

    expect(membership.managerAgentId).toBe(manager.id);
    expect(membership.seatId).toBe('desk-3');
  });

  it('lets the same agent lead one project and report in another', () => {
    const { deps, alpha, beta, ux, manager } = world();
    // In Alpha, manager leads and ux reports to it.
    const uxInAlpha = createProjectAgent(
      { projectId: alpha.id, agentId: ux.id, managerAgentId: manager.id },
      deps,
    );
    // In Beta, the roles are reversed.
    const managerInBeta = createProjectAgent(
      { projectId: beta.id, agentId: manager.id, managerAgentId: ux.id },
      deps,
    );

    expect(uxInAlpha.managerAgentId).toBe(manager.id);
    expect(managerInBeta.managerAgentId).toBe(ux.id);
  });

  it('refuses an agent that reports to itself', () => {
    const { deps, alpha, ux } = world();
    expect(() =>
      createProjectAgent({ projectId: alpha.id, agentId: ux.id, managerAgentId: ux.id }, deps),
    ).toThrow(/cannot report to itself/);

    const membership = createProjectAgent({ projectId: alpha.id, agentId: ux.id }, deps);
    expect(() => updateProjectAgent(membership, { managerAgentId: ux.id }, deps.clock)).toThrow(
      /cannot report to itself/,
    );
  });

  it('requires the manager to be a member of the same project', () => {
    const { deps, alpha, ux, manager } = world();
    const uxInAlpha = createProjectAgent(
      { projectId: alpha.id, agentId: ux.id, managerAgentId: manager.id },
      deps,
    );

    // The manager has not joined Alpha.
    expect(() => assertManagerIsMember(uxInAlpha, [uxInAlpha])).toThrow(
      /member of the same project/,
    );

    const managerInAlpha = createProjectAgent({ projectId: alpha.id, agentId: manager.id }, deps);
    expect(() => assertManagerIsMember(uxInAlpha, [uxInAlpha, managerInAlpha])).not.toThrow();
  });

  it('does not accept a manager who is only a member of another project', () => {
    const { deps, alpha, beta, ux, manager } = world();
    const uxInAlpha = createProjectAgent(
      { projectId: alpha.id, agentId: ux.id, managerAgentId: manager.id },
      deps,
    );
    const managerInBeta = createProjectAgent({ projectId: beta.id, agentId: manager.id }, deps);

    expect(() => assertManagerIsMember(uxInAlpha, [uxInAlpha, managerInBeta])).toThrow(
      /member of the same project/,
    );
  });

  it('treats membership as unique per (project, agent) pair', () => {
    const { deps, alpha, beta, ux } = world();
    const existing = [createProjectAgent({ projectId: alpha.id, agentId: ux.id }, deps)];

    expect(() => assertNotAlreadyMember(alpha.id, ux.id, existing)).toThrow(/already a member/);
    // Same agent, different project: fine.
    expect(() => assertNotAlreadyMember(beta.id, ux.id, existing)).not.toThrow();
  });

  it('updates seat and manager without touching identity', () => {
    const { deps, alpha, ux, manager } = world();
    const membership = createProjectAgent({ projectId: alpha.id, agentId: ux.id }, deps);
    const updated = updateProjectAgent(
      membership,
      { seatId: 'desk-9', managerAgentId: manager.id },
      deps.clock,
    );

    expect(updated.id).toBe(membership.id);
    expect(updated.projectId).toBe(membership.projectId);
    expect(updated.agentId).toBe(membership.agentId);
    expect(updated.seatId).toBe('desk-9');
    expect(updated.updatedAt).not.toBe(membership.updatedAt);
  });
});
