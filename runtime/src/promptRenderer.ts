/**
 * AgentContextBundle → the text one Claude Code run is given.
 *
 * Pure and deterministic: the same bundle and the same contents render the same
 * prompt, byte for byte. There is no ranking, no summarisation and no model
 * call in here — assembling context is a composition, not an inference (ADR 005).
 *
 * The layering is the contract, and it is one-directional. The bundle is
 * rendered, handed to the runtime and discarded; nothing that comes back is
 * written into the agent's instructions, skills or knowledge.
 */

import type { AgentContextBundle, ContextBudget } from '../../domain/src/index.js';

/**
 * Blob contents keyed by the id of the record that points at them — skill ids
 * and knowledge ids. Resolved by the caller, which owns the BlobStore; the
 * renderer itself reads nothing.
 */
export type ContentsById = ReadonlyMap<string, string>;

export interface RenderedPrompt {
  text: string;
  /** Sections dropped to stay inside `budget.maxCharacters`, in drop order. */
  omitted: string[];
}

/**
 * Render the bundle.
 *
 * Sections are emitted in priority order and the budget is enforced by dropping
 * whole sections from the END — a truncated skill or a half a knowledge item is
 * worse than a missing one, because the agent cannot tell it is reading a
 * fragment. The task itself is never dropped: a run with no task is not a run.
 */
export function renderPrompt(
  bundle: AgentContextBundle,
  contents: ContentsById,
  budget: ContextBudget,
): RenderedPrompt {
  const sections: Array<{ label: string; text: string; required: boolean }> = [];

  if (bundle.globalInstructions.trim()) {
    sections.push({
      label: 'global instructions',
      text: heading('Operating instructions') + bundle.globalInstructions.trim(),
      required: true,
    });
  }

  sections.push({
    label: 'agent',
    text:
      heading('You are') +
      `${bundle.agent.name} — ${bundle.agent.role}.` +
      paragraph(bundle.agent.description) +
      paragraph(bundle.agent.systemPrompt),
    required: true,
  });

  // The task is what the run exists for, so it is emitted early and never cut.
  sections.push({ label: 'task', text: renderTask(bundle), required: true });

  sections.push({
    label: 'project',
    text:
      heading('Project') +
      `${bundle.project.name} (${bundle.project.status}).` +
      paragraph(bundle.project.description) +
      (bundle.project.settings.workspacePaths.length > 0
        ? paragraph(`Workspace paths: ${bundle.project.settings.workspacePaths.join(', ')}`)
        : ''),
    required: true,
  });

  for (const skill of bundle.skills) {
    sections.push({
      label: `skill:${skill.slug}`,
      text:
        heading(`Skill — ${skill.name} (${skill.kind})`) +
        [skill.description, contents.get(skill.id)].filter(Boolean).join('\n\n') +
        (skill.requiredTools.length > 0
          ? paragraph(`Requires: ${skill.requiredTools.join(', ')}`)
          : ''),
      required: false,
    });
  }

  for (const item of bundle.agentKnowledge) {
    sections.push({
      label: `agentKnowledge:${item.id}`,
      text: renderKnowledge('Agent knowledge', item.title, item.type, contents.get(item.id)),
      required: false,
    });
  }

  for (const item of bundle.projectKnowledge) {
    sections.push({
      label: `projectKnowledge:${item.id}`,
      text: renderKnowledge('Project knowledge', item.title, item.type, contents.get(item.id)),
      required: false,
    });
  }

  const omitted: string[] = [];
  let kept = sections;
  // Drop optional sections from the end until the whole prompt fits.
  while (kept.map((s) => s.text).join('\n\n').length > budget.maxCharacters) {
    const lastOptional = findLastIndex(kept, (s) => !s.required);
    if (lastOptional < 0) {
      break;
    }
    omitted.push(kept[lastOptional]!.label);
    kept = [...kept.slice(0, lastOptional), ...kept.slice(lastOptional + 1)];
  }

  return { text: kept.map((s) => s.text).join('\n\n'), omitted };
}

/**
 * The prompt for a run dispatched through `claude --agent <name>` (see
 * `claudeCliRuntime.ts`), where the named Claude Code subagent's OWN system
 * prompt, tools and model already replace the defaults for the whole
 * session. Rendering the "You are ..." / agent section here as well would
 * put a second, Office-assembled persona on top of the one CC just loaded
 * from its own file — so this omits it and the skills/knowledge sections
 * (out of scope for a native-linked agent today), keeping only Office's own
 * operating contract and the task itself.
 */
export function renderNativeAgentPrompt(bundle: AgentContextBundle): string {
  const sections: string[] = [];
  if (bundle.globalInstructions.trim()) {
    sections.push(heading('Operating instructions') + bundle.globalInstructions.trim());
  }
  sections.push(renderTask(bundle));
  sections.push(
    heading('Project') +
      `${bundle.project.name} (${bundle.project.status}).` +
      paragraph(bundle.project.description) +
      (bundle.project.settings.workspacePaths.length > 0
        ? paragraph(`Workspace paths: ${bundle.project.settings.workspacePaths.join(', ')}`)
        : ''),
  );
  return sections.join('\n\n');
}

function renderTask(bundle: AgentContextBundle): string {
  const task = bundle.task;
  const inputs = task.inputs.map((input) => {
    switch (input.kind) {
      case 'text':
        return `- ${input.value}`;
      case 'projectKnowledge':
        return `- project knowledge: ${input.knowledgeId}`;
      case 'output':
        return `- output of an earlier task: ${input.outputId}`;
      case 'file':
        return `- file: ${input.path}`;
    }
  });
  return (
    heading('Your task') +
    `${task.title} (priority ${task.priority}).` +
    paragraph(task.description) +
    (inputs.length > 0 ? paragraph(`Inputs:\n${inputs.join('\n')}`) : '')
  );
}

function renderKnowledge(
  kind: string,
  title: string,
  type: string,
  content: string | undefined,
): string {
  return heading(`${kind} — ${title} (${type})`) + (content ?? '(content unavailable)');
}

function heading(title: string): string {
  return `## ${title}\n`;
}

function paragraph(text: string): string {
  return text.trim() ? `\n\n${text.trim()}` : '';
}

/** `Array.prototype.findLastIndex` is ES2023; the build targets ES2022. */
function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i]!)) {
      return i;
    }
  }
  return -1;
}
