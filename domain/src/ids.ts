/**
 * Canonical identity for every Agent Office domain entity.
 *
 * Every entity is keyed by an Agent Office-generated UUID. Nothing else is ever
 * a primary key — not an array index, not upstream's numeric agent id, not a
 * Claude session id, not any other provider-specific id. Those are integration
 * metadata and live on AgentSession (see ADR 002).
 *
 * Ids are branded so a ProjectId cannot be passed where an AgentId is expected.
 * The brand is a type-level phantom only; at runtime every id is a plain string.
 */

declare const idBrand: unique symbol;

type Branded<Name extends string> = string & { readonly [idBrand]: Name };

export type ProjectId = Branded<'ProjectId'>;
export type AgentId = Branded<'AgentId'>;
/** Membership of one Agent in one Project. */
export type ProjectAgentId = Branded<'ProjectAgentId'>;
export type SessionId = Branded<'SessionId'>;
export type TaskId = Branded<'TaskId'>;
export type SkillId = Branded<'SkillId'>;
/** Permanent knowledge owned by an Agent. Distinct brand from project knowledge
 *  so the two can never be substituted for one another (ADR 005). */
export type AgentKnowledgeId = Branded<'AgentKnowledgeId'>;
/** Project-scoped knowledge owned by a Project. */
export type ProjectKnowledgeId = Branded<'ProjectKnowledgeId'>;
export type OutputId = Branded<'OutputId'>;

/** Every branded id type in the domain. */
export type EntityId =
  | ProjectId
  | AgentId
  | ProjectAgentId
  | SessionId
  | TaskId
  | SkillId
  | AgentKnowledgeId
  | ProjectKnowledgeId
  | OutputId;

/**
 * Shape check only — deliberately not version- or variant-specific.
 *
 * Validating the RFC 4122 version nibble would reject perfectly good ids from a
 * future generator (v7, say) and force test fixtures to hand-craft v4 bit
 * patterns. What matters here is that the value is a canonical 8-4-4-4-12 hex
 * id and not an index, a session id, or a slug.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCanonicalId(value: string): boolean {
  return UUID_SHAPE.test(value);
}

/**
 * Source of new canonical ids.
 *
 * A port, not a function call, so tests can inject a deterministic sequence and
 * so the domain never reaches for a host API directly.
 */
export interface IdGenerator {
  next(): string;
}

interface RandomUuidSource {
  randomUUID(): string;
}

/**
 * `crypto.randomUUID` where the host has it — Node 20+ and browsers in a secure
 * context both do. A browser on plain http (the standalone office bound to a LAN
 * address, for instance) does not expose it, so there is a fallback rather than
 * a crash. The fallback is NOT cryptographically strong; it exists to keep ids
 * well-formed and collision-unlikely, not to be a security primitive. Nothing in
 * the domain treats an id as a secret or a capability.
 */
function randomUuidSource(): RandomUuidSource | undefined {
  const candidate = (globalThis as { crypto?: unknown }).crypto;
  if (candidate && typeof (candidate as RandomUuidSource).randomUUID === 'function') {
    return candidate as RandomUuidSource;
  }
  return undefined;
}

function fallbackUuid(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      out += hex[8 + Math.floor(Math.random() * 4)];
    } else {
      out += hex[Math.floor(Math.random() * 16)];
    }
  }
  return out;
}

export const uuidIdGenerator: IdGenerator = {
  next(): string {
    return randomUuidSource()?.randomUUID() ?? fallbackUuid();
  },
};

/**
 * Narrow a raw string to a branded id, rejecting anything that is not a
 * canonical uuid. This is the only sanctioned way into the branded types, so a
 * provider id or an array index cannot be laundered into a domain key.
 */
function narrow<T extends EntityId>(kind: string, raw: string): T {
  if (!isCanonicalId(raw)) {
    throw new TypeError(`${kind} must be a canonical UUID, received: ${JSON.stringify(raw)}`);
  }
  return raw as T;
}

export const asProjectId = (raw: string): ProjectId => narrow<ProjectId>('ProjectId', raw);
export const asAgentId = (raw: string): AgentId => narrow<AgentId>('AgentId', raw);
export const asSessionId = (raw: string): SessionId => narrow<SessionId>('SessionId', raw);
export const asTaskId = (raw: string): TaskId => narrow<TaskId>('TaskId', raw);
export const asSkillId = (raw: string): SkillId => narrow<SkillId>('SkillId', raw);
export const asProjectAgentId = (raw: string): ProjectAgentId =>
  narrow<ProjectAgentId>('ProjectAgentId', raw);
export const asAgentKnowledgeId = (raw: string): AgentKnowledgeId =>
  narrow<AgentKnowledgeId>('AgentKnowledgeId', raw);
export const asProjectKnowledgeId = (raw: string): ProjectKnowledgeId =>
  narrow<ProjectKnowledgeId>('ProjectKnowledgeId', raw);
export const asOutputId = (raw: string): OutputId => narrow<OutputId>('OutputId', raw);

export const newProjectId = (ids: IdGenerator): ProjectId => asProjectId(ids.next());
export const newAgentId = (ids: IdGenerator): AgentId => asAgentId(ids.next());
export const newSessionId = (ids: IdGenerator): SessionId => asSessionId(ids.next());
export const newTaskId = (ids: IdGenerator): TaskId => asTaskId(ids.next());
export const newSkillId = (ids: IdGenerator): SkillId => asSkillId(ids.next());
export const newProjectAgentId = (ids: IdGenerator): ProjectAgentId => asProjectAgentId(ids.next());
export const newAgentKnowledgeId = (ids: IdGenerator): AgentKnowledgeId =>
  asAgentKnowledgeId(ids.next());
export const newProjectKnowledgeId = (ids: IdGenerator): ProjectKnowledgeId =>
  asProjectKnowledgeId(ids.next());
export const newOutputId = (ids: IdGenerator): OutputId => asOutputId(ids.next());
