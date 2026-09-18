/**
 * The Agent Office management surface.
 *
 * Deliberately plain: projects, the global agent library, membership of the
 * selected project, and that project's tasks. Enough to drive the persistent
 * model end to end, and no further — the polished UX is a later phase.
 *
 * Agent fields mirror `AgentDefinition` exactly. Nothing here invents a field
 * the domain does not have.
 */

import { useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { AgentConfigPanel } from './AgentConfigPanel.js';
import type { CreateAgentFields } from './useOfficeState.js';
import { useOfficeState } from './useOfficeState.js';

interface OfficePanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const fieldClass =
  'w-full bg-btn-bg border-2 border-border rounded-none px-4 py-2 text-text outline-none focus:border-accent';
const sectionClass = 'border-2 border-border p-8 flex flex-col gap-6 min-w-0';
const headingClass = 'text-accent-bright text-lg';
const rowClass =
  'flex items-center justify-between gap-6 border-b border-border py-3 last:border-0';
const emptyClass = 'text-text-muted text-sm py-3';

export function OfficePanel({ isOpen, onClose }: OfficePanelProps) {
  const office = useOfficeState();

  const [projectName, setProjectName] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [agent, setAgent] = useState<CreateAgentFields>({
    name: '',
    role: '',
    provider: 'claude',
  });

  if (!isOpen) {
    return null;
  }

  const activeProjectId = office.activeProjectId;
  const memberAgentIds = new Set(office.memberships.map((m) => m.agentId));
  const members = office.agents.filter((a) => memberAgentIds.has(a.id));

  const submitProject = () => {
    const name = projectName.trim();
    if (!name) {
      return;
    }
    office.createProject(name);
    setProjectName('');
  };

  const submitAgent = () => {
    const name = agent.name.trim();
    const role = agent.role.trim();
    const provider = agent.provider.trim();
    if (!name || !role || !provider) {
      return;
    }
    office.createAgent({ ...agent, name, role, provider });
    setAgent({ name: '', role: '', provider: 'claude' });
  };

  const submitTask = () => {
    const title = taskTitle.trim();
    if (!title || !activeProjectId) {
      return;
    }
    office.createTask(activeProjectId, title);
    setTaskTitle('');
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Agent Office" className="w-256 max-w-[92vw]">
      <div className="flex flex-col gap-8 max-h-[70vh] overflow-y-auto">
        {!office.storage.ready && (
          <div className="border-2 border-warning p-6 text-warning text-sm">
            Storage unavailable — nothing will be saved.
            {office.storage.error ? ` ${office.storage.error}` : ''}
          </div>
        )}
        {office.error && (
          <div className="border-2 border-warning p-6 text-warning text-sm">{office.error}</div>
        )}

        {/* ── Projects ─────────────────────────────────────────── */}
        <section className={sectionClass}>
          <h3 className={headingClass}>Projects</h3>
          <div className="flex gap-4">
            <input
              className={fieldClass}
              placeholder="New project name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitProject()}
            />
            <Button variant="accent" onClick={submitProject}>
              Create
            </Button>
          </div>
          {office.projects.length === 0 ? (
            <p className={emptyClass}>No projects yet.</p>
          ) : (
            <ul>
              {office.projects.map((project) => (
                <li key={project.id} className={rowClass}>
                  <span className="truncate">{project.name}</span>
                  <Button
                    variant={project.id === activeProjectId ? 'active' : 'default'}
                    size="sm"
                    onClick={() => office.setActiveProject(project.id)}
                  >
                    {project.id === activeProjectId ? 'Selected' : 'Select'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Agent library (global) ───────────────────────────── */}
        <section className={sectionClass}>
          <h3 className={headingClass}>Agent Library</h3>
          <p className="text-text-muted text-sm">
            Agents belong to the office, not to a project, and can join several at once.
          </p>
          <div className="grid grid-cols-3 gap-4">
            <input
              className={fieldClass}
              placeholder="Name"
              value={agent.name}
              onChange={(e) => setAgent({ ...agent, name: e.target.value })}
            />
            <input
              className={fieldClass}
              placeholder="Role"
              value={agent.role}
              onChange={(e) => setAgent({ ...agent, role: e.target.value })}
            />
            <input
              className={fieldClass}
              placeholder="Provider"
              value={agent.provider}
              onChange={(e) => setAgent({ ...agent, provider: e.target.value })}
            />
          </div>
          <div className="flex gap-4">
            <input
              className={fieldClass}
              placeholder="Model (optional)"
              value={agent.model ?? ''}
              onChange={(e) => setAgent({ ...agent, model: e.target.value })}
            />
            <Button variant="accent" onClick={submitAgent}>
              Create
            </Button>
          </div>
          <textarea
            className={`${fieldClass} h-40 resize-none`}
            placeholder="System prompt (optional)"
            value={agent.systemPrompt ?? ''}
            onChange={(e) => setAgent({ ...agent, systemPrompt: e.target.value })}
          />
          {office.agents.length === 0 ? (
            <p className={emptyClass}>No agents yet.</p>
          ) : (
            <ul>
              {office.agents.map((a) => (
                <li key={a.id} className={rowClass}>
                  <span className="truncate">
                    {a.name} <span className="text-text-muted text-sm">· {a.role}</span>
                  </span>
                  <span className="flex gap-4 shrink-0">
                    <Button size="sm" onClick={() => office.openAgent(a.id)}>
                      Configure
                    </Button>
                    {!memberAgentIds.has(a.id) && (
                      <Button
                        size="sm"
                        variant={activeProjectId ? 'default' : 'disabled'}
                        disabled={!activeProjectId}
                        onClick={() =>
                          activeProjectId && office.addAgentToProject(activeProjectId, a.id)
                        }
                      >
                        Add to project
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Members of the selected project ──────────────────── */}
        <section className={sectionClass}>
          <h3 className={headingClass}>Project Members</h3>
          {!activeProjectId ? (
            <p className={emptyClass}>Select a project first.</p>
          ) : members.length === 0 ? (
            <p className={emptyClass}>No agents in this project yet.</p>
          ) : (
            <ul>
              {members.map((a) => (
                <li key={a.id} className={rowClass}>
                  <span className="truncate">
                    {a.name} <span className="text-text-muted text-sm">· {a.role}</span>
                  </span>
                  <Button
                    size="sm"
                    onClick={() => office.removeAgentFromProject(activeProjectId, a.id)}
                    title="Removes the membership only; the agent itself is kept"
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Tasks of the selected project ────────────────────── */}
        <section className={sectionClass}>
          <h3 className={headingClass}>Tasks</h3>
          {!activeProjectId ? (
            <p className={emptyClass}>Select a project first.</p>
          ) : (
            <>
              <div className="flex gap-4">
                <input
                  className={fieldClass}
                  placeholder="New task title"
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitTask()}
                />
                <Button variant="accent" onClick={submitTask}>
                  Create
                </Button>
              </div>
              {office.tasks.length === 0 ? (
                <p className={emptyClass}>No tasks yet.</p>
              ) : (
                <ul>
                  {office.tasks.map((task) => (
                    <li key={task.id} className={rowClass}>
                      <span className="truncate">{task.title}</span>
                      <span className="text-text-muted text-sm">{task.status}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>
      {office.agentDetail && (
        <AgentConfigPanel
          // Remount on a different agent so the draft forms reseed from it.
          key={office.agentDetail.agent.id}
          detail={office.agentDetail}
          commands={office}
          error={office.error}
        />
      )}
    </Modal>
  );
}
