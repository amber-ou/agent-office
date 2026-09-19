/**
 * Pure helpers for the Claude Code discovery bridge.
 *
 * No filesystem, no ids-as-paths concerns (that's `discoveryLinks.ts` and
 * `fileAgentStore.ts`) — just the small, independently-testable rules that
 * decide what goes in `discovery/agent.md`'s front matter, what a Skill's
 * CC-facing identity looks like, and what counts as a file too broken to run
 * an agent from.
 */

import type { AgentDefinition, ToolGrant } from '../../../domain/src/index.js';
import { ToolMode } from '../../../domain/src/index.js';
import type { AgentCcFields, OfficeAgentMeta } from '../agentFiles.js';

/**
 * An unresolved git merge conflict marker. A file containing one must never
 * be treated as valid agent configuration — used by the discovery bridge and
 * `importAgentsFromDisk`, the two places that read a file a person or a git
 * merge could have left mid-conflict, before anything runs off it.
 */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7} |^={7}\s*$|^>{7} /m.test(text);
}

export interface FileValidation {
  ok: boolean;
  reason?: string;
}

/** The one check every file this bridge reads passes through before it is
 *  trusted enough to register or link an agent from. */
export function validateBridgeFile(text: string): FileValidation {
  if (hasConflictMarkers(text)) {
    return { ok: false, reason: 'unresolved git merge conflict markers' };
  }
  return { ok: true };
}

/**
 * CC's own stable identifier for an agent (the subagent front matter
 * `name`), generated once from the role at creation time plus a slice of the
 * immutable agent id — so it is unique without ever needing to scan every
 * other agent's identifier, and stable even if the role or Office's own
 * display name are edited later. Once written to `discovery/agent.md` it is
 * sticky (see `AgentCcFields.name`); this function is only ever consulted
 * for an agent that has no identifier on disk yet.
 */
export function ccIdentifierFor(role: string, agentId: string): string {
  const slug =
    role
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent';
  return `${slug}-${agentId.replace(/-/g, '').slice(0, 8)}`;
}

/**
 * The globally-unique form of a Skill's name and discovery-directory name,
 * qualified by the owning agent's CC identifier. CC's own skill-identity
 * mechanism (directory name, front matter `name`, or both — unconfirmed, see
 * the bridge's own notes) is not fully documented, so both the directory and
 * the `name` field written into SKILL.md are qualified the same way: two
 * agents' same-named skills can never collide in CC's flat `skills/`
 * namespace, whichever mechanism CC actually keys on (ADR 005: a skill
 * belongs to exactly one agent, so this is a true identity, not a display
 * choice invented here).
 */
export function qualifiedSkillName(ccAgentIdentifier: string, skillSlug: string): string {
  return `${ccAgentIdentifier}--${skillSlug}`;
}

/**
 * Office's `ToolGrant[]` distinguishes allow / ask / deny; CC's own schema
 * only has an allow list (`tools`) and a deny list (`disallowedTools`) — no
 * `ask`. `ask` is folded into the allow list rather than dropped, since
 * dropping it would silently remove a capability the operator granted. This
 * is a deliberate, lossy simplification: converting back cannot recover
 * which allowed tools were originally `ask` versus `allow`.
 */
export function ccFieldsFromToolGrants(tools: readonly ToolGrant[]): {
  tools: string[];
  disallowedTools: string[];
} {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const grant of tools) {
    if (grant.mode === ToolMode.DENY) {
      deny.push(grant.name);
    } else {
      allow.push(grant.name);
    }
  }
  return { tools: allow, disallowedTools: deny };
}

/** The reverse of `ccFieldsFromToolGrants`. Every tool comes back as ALLOW or
 *  DENY — `ask` cannot round-trip, per the note above. */
export function toolGrantsFromCcFields(
  fields: Pick<AgentCcFields, 'tools' | 'disallowedTools'>,
): ToolGrant[] {
  return [
    ...fields.tools.map((name) => ({ name, mode: ToolMode.ALLOW }) satisfies ToolGrant),
    ...fields.disallowedTools.map((name) => ({ name, mode: ToolMode.DENY }) satisfies ToolGrant),
  ];
}

const KNOWLEDGE_POINTER_MARKER = '<!-- agent-office:knowledge-pointer -->';

/**
 * The block appended to an agent's instructions telling it where its
 * knowledge lives. This is the ONLY mechanism that connects `knowledge/
 * index.md` to the agent — nothing loads knowledge automatically, so an
 * agent that never reads this paragraph never reads its knowledge either.
 * Deliberately home-relative (`~/...`), not a machine-specific absolute
 * path, so the same instructions body stays correct after this agent's
 * files are cloned onto a different computer with a different home
 * directory.
 */
export function knowledgePointerBlock(agentId: string): string {
  return [
    KNOWLEDGE_POINTER_MARKER,
    '',
    '## Your knowledge',
    '',
    `You have a personal knowledge base at \`~/.agent-office/agents/${agentId}/knowledge/\` ` +
      "(`~` is your home directory on THIS computer — resolve it yourself, e.g. via Bash's " +
      '`$HOME`, since it is not expanded automatically here). Read `index.md` there first for ' +
      'what exists, then read only the file(s) relevant to your current task with the Read ' +
      'tool. Nothing loads this for you automatically.',
  ].join('\n');
}

/** True once `knowledgePointerBlock` has already been appended, so the
 *  bridge never appends it twice. */
export function hasKnowledgePointer(body: string): boolean {
  return body.includes(KNOWLEDGE_POINTER_MARKER);
}

/** Office-only fields, straight off the domain object. Never includes
 *  name/description/tools/model — those belong solely to `AgentCcFields`. */
export function officeMetaFromAgent(agent: AgentDefinition): OfficeAgentMeta {
  return {
    agentId: agent.id,
    displayName: agent.name,
    role: agent.role,
    provider: agent.provider,
    memory: { ...agent.memory },
    appearance: { ...agent.appearance },
  };
}

/** The CC fields to write for an agent that has no `discovery/agent.md` yet.
 *  `ccIdentifier` should come from `ccIdentifierFor` the first time only —
 *  once written it is sticky and this is never called again to change it. */
export function ccFieldsFromAgent(agent: AgentDefinition, ccIdentifier: string): AgentCcFields {
  const { tools, disallowedTools } = ccFieldsFromToolGrants(agent.tools);
  return {
    name: ccIdentifier,
    description: agent.description,
    tools,
    disallowedTools,
    ...(agent.model ? { model: agent.model } : {}),
  };
}
