/**
 * Agent configuration: the definition, its skills, and its knowledge.
 *
 * An Agent is global. Nothing on this surface belongs to a project, and
 * nothing a project produces can appear here — knowledge changes only through
 * the explicit actions below.
 *
 * Fields mirror `AgentDefinition`, `Skill` and `AgentKnowledge` exactly.
 *
 * The forms hold a local draft seeded from the server's copy. The caller keys
 * this component by agent id, so opening a different agent remounts it and the
 * drafts start from that agent's stored values rather than the previous one's.
 */

import { useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import type {
  AgentDetailView,
  KnowledgeFields,
  OfficeCommands,
  SkillFields,
} from './useOfficeState.js';

/** Kept in step with the domain's SkillKind / KnowledgeType unions. */
const SKILL_KINDS = [
  'instruction',
  'workflow',
  'tool_bundle',
  'mcp_capability',
  'script',
  'external',
] as const;

const KNOWLEDGE_TYPES = [
  'markdown',
  'product_requirements',
  'ux_research',
  'user_flow',
  'design_system',
  'ui_specification',
  'api_documentation',
  'upload',
  'other',
] as const;

const fieldClass =
  'w-full bg-btn-bg border-2 border-border rounded-none px-4 py-2 text-text outline-none focus:border-accent';
const sectionClass = 'border-2 border-border p-8 flex flex-col gap-6 min-w-0';
const headingClass = 'text-accent-bright text-lg';
const rowClass = 'flex items-start justify-between gap-6 border-b border-border py-3 last:border-0';
const emptyClass = 'text-text-muted text-sm py-3';

interface AgentConfigPanelProps {
  detail: AgentDetailView;
  commands: Pick<
    OfficeCommands,
    | 'closeAgent'
    | 'updateAgent'
    | 'createSkill'
    | 'updateSkill'
    | 'deleteSkill'
    | 'createKnowledge'
    | 'updateKnowledge'
    | 'deleteKnowledge'
  >;
  error: string | null;
}

interface AgentForm {
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  model: string;
}

const EMPTY_SKILL: SkillFields & { description: string; content: string; requiredTools: string[] } =
  {
    slug: '',
    name: '',
    kind: 'instruction',
    description: '',
    content: '',
    requiredTools: [],
  };

const EMPTY_KNOWLEDGE: KnowledgeFields & { tags: string[] } = {
  title: '',
  knowledgeType: 'markdown',
  content: '',
  tags: [],
};

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function AgentConfigPanel({ detail, commands, error }: AgentConfigPanelProps) {
  const agent = detail.agent;

  const [form, setForm] = useState<AgentForm>(() => toForm(detail));
  const [skill, setSkill] = useState(EMPTY_SKILL);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [knowledge, setKnowledge] = useState(EMPTY_KNOWLEDGE);
  const [editingKnowledgeId, setEditingKnowledgeId] = useState<string | null>(null);

  const saveAgent = () => {
    const name = form.name.trim();
    const role = form.role.trim();
    if (!name || !role) {
      return;
    }
    commands.updateAgent(agent.id, {
      name,
      role,
      description: form.description,
      systemPrompt: form.systemPrompt,
      model: form.model.trim(),
    });
  };

  const submitSkill = () => {
    const slug = skill.slug.trim();
    const name = skill.name.trim();
    if (!slug || !name) {
      return;
    }
    const fields: SkillFields = {
      slug,
      name,
      kind: skill.kind,
      description: skill.description,
      content: skill.content,
      requiredTools: skill.requiredTools,
    };
    if (editingSkillId) {
      commands.updateSkill(editingSkillId, fields);
    } else {
      commands.createSkill(agent.id, fields);
    }
    setSkill(EMPTY_SKILL);
    setEditingSkillId(null);
  };

  const submitKnowledge = () => {
    const title = knowledge.title.trim();
    if (!title || !knowledge.content) {
      return;
    }
    const fields: KnowledgeFields = {
      title,
      knowledgeType: knowledge.knowledgeType,
      content: knowledge.content,
      tags: knowledge.tags,
    };
    if (editingKnowledgeId) {
      commands.updateKnowledge(editingKnowledgeId, fields);
    } else {
      commands.createKnowledge(agent.id, fields);
    }
    setKnowledge(EMPTY_KNOWLEDGE);
    setEditingKnowledgeId(null);
  };

  return (
    <Modal
      isOpen
      onClose={commands.closeAgent}
      title={`Agent · ${agent.name}`}
      zIndex={70}
      className="w-256 max-w-[92vw]"
    >
      <div
        className="flex flex-col gap-8 max-h-[70vh] overflow-y-auto"
        data-testid="agent-config-panel"
      >
        {error && <div className="border-2 border-warning p-6 text-warning text-sm">{error}</div>}

        {/* ── Definition ───────────────────────────────────────── */}
        <section className={sectionClass}>
          <h3 className={headingClass}>Configuration</h3>
          <div className="grid grid-cols-3 gap-4">
            <input
              className={fieldClass}
              placeholder="Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <input
              className={fieldClass}
              placeholder="Role"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            />
            <input
              className={fieldClass}
              placeholder="Model (optional)"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
            />
          </div>
          <input
            className={fieldClass}
            placeholder="Description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <textarea
            className={`${fieldClass} h-40 resize-none`}
            placeholder="Instructions (system prompt)"
            value={form.systemPrompt}
            onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
          />
          <div className="flex justify-between items-center gap-6">
            <span className="text-text-muted text-sm">
              Provider: {agent.provider} · this agent is global and independent of any project.
            </span>
            <Button variant="accent" onClick={saveAgent}>
              Save
            </Button>
          </div>
        </section>

        {/* ── Skills (owned by this agent alone) ───────────────── */}
        <section className={sectionClass}>
          <h3 className={headingClass}>Skills</h3>
          <p className="text-text-muted text-sm">
            Skills belong to this agent only. There is no shared skill library.
          </p>
          <div className="grid grid-cols-3 gap-4">
            <input
              className={fieldClass}
              placeholder="Slug"
              value={skill.slug}
              onChange={(e) => setSkill({ ...skill, slug: e.target.value })}
            />
            <input
              className={fieldClass}
              placeholder="Name"
              value={skill.name}
              onChange={(e) => setSkill({ ...skill, name: e.target.value })}
            />
            <select
              className={fieldClass}
              value={skill.kind}
              onChange={(e) => setSkill({ ...skill, kind: e.target.value })}
            >
              {SKILL_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </div>
          <input
            className={fieldClass}
            placeholder="Description"
            value={skill.description}
            onChange={(e) => setSkill({ ...skill, description: e.target.value })}
          />
          <input
            className={fieldClass}
            placeholder="Required tools (comma separated)"
            value={skill.requiredTools.join(', ')}
            onChange={(e) => setSkill({ ...skill, requiredTools: splitList(e.target.value) })}
          />
          <textarea
            className={`${fieldClass} h-40 resize-none`}
            placeholder="Skill content"
            value={skill.content}
            onChange={(e) => setSkill({ ...skill, content: e.target.value })}
          />
          <div className="flex gap-4 justify-end">
            {editingSkillId && (
              <Button
                onClick={() => {
                  setSkill(EMPTY_SKILL);
                  setEditingSkillId(null);
                }}
              >
                Cancel
              </Button>
            )}
            <Button variant="accent" onClick={submitSkill}>
              {editingSkillId ? 'Save skill' : 'Add skill'}
            </Button>
          </div>
          {detail.skills.length === 0 ? (
            <p className={emptyClass}>No skills yet.</p>
          ) : (
            <ul>
              {detail.skills.map((item) => (
                <li key={item.id} className={rowClass}>
                  <span className="truncate min-w-0">
                    {item.name}{' '}
                    <span className="text-text-muted text-sm">
                      · {item.slug} · {item.kind}
                    </span>
                  </span>
                  <span className="flex gap-4 shrink-0">
                    <Button
                      size="sm"
                      onClick={() => {
                        setSkill({
                          slug: item.slug,
                          name: item.name,
                          kind: item.kind,
                          description: item.description,
                          content: item.content ?? '',
                          requiredTools: item.requiredTools,
                        });
                        setEditingSkillId(item.id);
                      }}
                    >
                      Edit
                    </Button>
                    <Button size="sm" onClick={() => commands.deleteSkill(item.id)}>
                      Delete
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Agent knowledge (explicit only) ──────────────────── */}
        <section className={sectionClass}>
          <h3 className={headingClass}>Agent Knowledge</h3>
          <p className="text-text-muted text-sm">
            What this agent permanently knows. Only the actions below change it — project content,
            tasks and outputs never do.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <input
              className={fieldClass}
              placeholder="Title"
              value={knowledge.title}
              onChange={(e) => setKnowledge({ ...knowledge, title: e.target.value })}
            />
            <select
              className={fieldClass}
              value={knowledge.knowledgeType}
              onChange={(e) => setKnowledge({ ...knowledge, knowledgeType: e.target.value })}
            >
              {KNOWLEDGE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>
          <input
            className={fieldClass}
            placeholder="Tags (comma separated)"
            value={knowledge.tags.join(', ')}
            onChange={(e) => setKnowledge({ ...knowledge, tags: splitList(e.target.value) })}
          />
          <textarea
            className={`${fieldClass} h-40 resize-none`}
            placeholder="Knowledge content"
            value={knowledge.content}
            onChange={(e) => setKnowledge({ ...knowledge, content: e.target.value })}
          />
          <div className="flex gap-4 justify-end">
            {editingKnowledgeId && (
              <Button
                onClick={() => {
                  setKnowledge(EMPTY_KNOWLEDGE);
                  setEditingKnowledgeId(null);
                }}
              >
                Cancel
              </Button>
            )}
            <Button variant="accent" onClick={submitKnowledge}>
              {editingKnowledgeId ? 'Save knowledge' : 'Add knowledge'}
            </Button>
          </div>
          {detail.knowledge.length === 0 ? (
            <p className={emptyClass}>No knowledge yet.</p>
          ) : (
            <ul>
              {detail.knowledge.map((item) => (
                <li key={item.id} className={rowClass}>
                  <span className="truncate min-w-0">
                    {item.title} <span className="text-text-muted text-sm">· {item.type}</span>
                    {item.contentReadable === false && (
                      <span className="text-warning text-sm"> · content unavailable</span>
                    )}
                  </span>
                  <span className="flex gap-4 shrink-0">
                    <Button
                      size="sm"
                      variant={item.contentReadable === false ? 'disabled' : 'default'}
                      disabled={item.contentReadable === false}
                      onClick={() => {
                        setKnowledge({
                          title: item.title,
                          knowledgeType: item.type,
                          content: item.content ?? '',
                          tags: item.tags,
                        });
                        setEditingKnowledgeId(item.id);
                      }}
                    >
                      Edit
                    </Button>
                    <Button size="sm" onClick={() => commands.deleteKnowledge(item.id)}>
                      Delete
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}

function toForm(detail: AgentDetailView): AgentForm {
  return {
    name: detail.agent.name,
    role: detail.agent.role,
    description: detail.agent.description,
    systemPrompt: detail.agent.systemPrompt ?? '',
    model: detail.agent.model ?? '',
  };
}
