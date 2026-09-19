/**
 * Registers a Claude Code native subagent file as an Office Agent —
 * the reverse direction from `ccBridgeSync.ts` (Office → CC). Here, CC's own
 * file is the ONLY source: Office never writes to it, never copies its
 * content into `discovery/agent.md`, and this agent is never migrated to
 * file-backed status (see `OfficeAgentMeta.nativeAgentPath`), so the ordinary
 * discovery bridge — which only considers migrated agents — leaves it alone.
 *
 * Calling this again for the same path is how a change made in Claude Code
 * gets picked up: it is a re-read, not a re-import, and it never creates a
 * second agent for the same file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentDefinition, DomainDeps, Repositories } from '../../../domain/src/index.js';
import { createAgentDefinition, updateAgentDefinition } from '../../../domain/src/index.js';
import type { AgentFileStore } from '../agentFiles.js';
import { toolGrantsFromCcFields } from './ccBridge.js';
import { parseNativeAgentFile } from './nativeAgentFile.js';

export interface LinkNativeAgentSuccess {
  ok: true;
  agent: AgentDefinition;
  /** 'linked' the first time this path is registered, 'refreshed' every
   *  time after — both read the file fresh, so a refresh IS a re-read. */
  action: 'linked' | 'refreshed';
}

export interface LinkNativeAgentFailure {
  ok: false;
  reason: string;
}

export type LinkNativeAgentResult = LinkNativeAgentSuccess | LinkNativeAgentFailure;

export async function linkNativeAgentFile(
  repos: Repositories,
  files: AgentFileStore,
  filePath: string,
  deps: DomainDeps,
): Promise<LinkNativeAgentResult> {
  const absolute = path.resolve(filePath);
  let text: string;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    return {
      ok: false,
      reason: `could not read ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = parseNativeAgentFile(text);
  if (!parsed.ok) {
    return { ok: false, reason: `${absolute}: ${parsed.reason}` };
  }
  const { fields, body } = parsed.agent;
  const tools = toolGrantsFromCcFields(fields);

  const existing = await findLinkedAgent(repos, files, absolute);
  const now = deps.clock.now();

  if (existing) {
    const updated = updateAgentDefinition(
      existing,
      {
        name: fields.name,
        description: fields.description,
        systemPrompt: body,
        model: fields.model,
        tools,
      },
      deps.clock,
    );
    await repos.agents.put(updated);
    const officeMeta = await files.readOfficeMeta(updated.id);
    await files.writeOfficeMeta(updated.id, {
      agentId: updated.id,
      displayName: updated.name,
      role: officeMeta?.role ?? updated.role,
      provider: officeMeta?.provider ?? updated.provider,
      memory: officeMeta?.memory ?? { ...updated.memory },
      appearance: officeMeta?.appearance ?? { ...updated.appearance },
      nativeAgentPath: absolute,
    });
    return { ok: true, agent: updated, action: 'refreshed' };
  }

  const agent = createAgentDefinition(
    {
      name: fields.name,
      role: fields.name,
      provider: 'claude',
      description: fields.description,
      systemPrompt: body,
      model: fields.model,
      tools,
    },
    deps,
  );
  await repos.agents.put(agent);
  // Directory only for office.json's pointer — never markMigrated: this
  // agent's source of truth is the external file, not discovery/agent.md.
  await files.ensureAgent(agent.id, now);
  await files.writeOfficeMeta(agent.id, {
    agentId: agent.id,
    displayName: agent.name,
    role: agent.role,
    provider: agent.provider,
    memory: { ...agent.memory },
    appearance: { ...agent.appearance },
    nativeAgentPath: absolute,
  });
  return { ok: true, agent, action: 'linked' };
}

async function findLinkedAgent(
  repos: Repositories,
  files: AgentFileStore,
  absolutePath: string,
): Promise<AgentDefinition | null> {
  for (const agent of await repos.agents.list()) {
    const meta = await files.readOfficeMeta(agent.id);
    if (meta?.nativeAgentPath && path.resolve(meta.nativeAgentPath) === absolutePath) {
      return agent;
    }
  }
  return null;
}
