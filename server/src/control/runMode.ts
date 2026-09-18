/**
 * How a run is isolated on this machine.
 *
 * Two modes, chosen by the platform and never by a failure:
 *
 *   sandboxed    Linux and WSL2. bubblewrap removes the paths a run must not
 *                reach. If it cannot be entered, nothing runs — a fallback
 *                here would be exactly the thing the sandbox exists to stop.
 *   shell        Windows. There is no equivalent of that namespace, so a run
 *                executes with the operator's own permissions and can reach
 *                anything they can. It is therefore OPT-IN, once, in writing,
 *                after being told what it means.
 *
 * The mode is a property of the platform, not of whether the sandbox happened
 * to work: a Linux host with a broken bubblewrap does not become a Windows
 * host, and a Windows host is never silently "downgraded" because it was never
 * sandboxed to begin with.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Written once, by the launcher, when the operator accepts the risk. */
export const WINDOWS_CONSENT_FILE = 'windows-shell-consent.json';

export interface WindowsConsent {
  accepted: true;
  acceptedAt: string;
  /** What was shown at the time, so the record says what was agreed to. */
  notice: string;
}

export const WINDOWS_SHELL_NOTICE = [
  'Agent Office runs Claude Code with shell access.',
  '',
  'On Linux each run is confined to its own namespace: it cannot see your',
  'agents’ files, and it can only write to that task’s working directory.',
  'Windows has no equivalent that ships with the operating system, so on this',
  'machine a run executes with YOUR OWN permissions. A command it decides to',
  'run can read or change anything your Windows account can, including your',
  'Agent Office data and the rest of your files. Claude’s own file tools are',
  'still denied the Agent Office data directory, but a shell command is not',
  'bound by that.',
  '',
  'Only continue if you are willing to run agent-authored commands on this',
  'account, and only give projects to agents you would give to a contractor.',
].join('\n');

export type RunMode = 'sandboxed' | 'shell';

export interface RunModeDecision {
  mode: RunMode;
  /** Set when no run may start. The text is shown to the operator as-is. */
  refusal?: string;
  /** True when the run should authenticate from CLAUDE_CODE_OAUTH_TOKEN. */
  requiresToken: boolean;
}

export interface RunModeInput {
  platform: NodeJS.Platform;
  /** Whether the operator has accepted the Windows notice. */
  windowsConsent: boolean;
  /** Result of actually entering a namespace, on the platforms that use one. */
  sandboxOk: boolean;
  sandboxDetail?: string;
  /** Whether a token is present in the environment. */
  hasToken: boolean;
}

export function decideRunMode(input: RunModeInput): RunModeDecision {
  if (input.platform === 'win32') {
    if (!input.windowsConsent) {
      return {
        mode: 'shell',
        requiresToken: false,
        refusal:
          'Running agents on Windows needs one-time approval, because a run is not sandboxed there. Start Agent Office with agent-office.cmd and accept the notice it shows.',
      };
    }
    // The operator's existing `claude login` is reachable, because nothing is
    // hidden from the run. Asking for a token as well would be setup for
    // nothing.
    return { mode: 'shell', requiresToken: false };
  }

  if (!input.sandboxOk) {
    return {
      mode: 'sandboxed',
      requiresToken: true,
      refusal: `the run sandbox is unavailable, so no task can be dispatched: ${input.sandboxDetail ?? 'unknown reason'}`,
    };
  }
  if (!input.hasToken) {
    return {
      mode: 'sandboxed',
      requiresToken: true,
      refusal:
        'no CLAUDE_CODE_OAUTH_TOKEN in the environment: a sandboxed run cannot reach the login in your home directory, so the token has to be provided to Agent Office',
    };
  }
  return { mode: 'sandboxed', requiresToken: true };
}

export function readWindowsConsent(dataRoot: string): boolean {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dataRoot, WINDOWS_CONSENT_FILE), 'utf8'),
    ) as Partial<WindowsConsent>;
    return parsed.accepted === true;
  } catch {
    return false;
  }
}

export function writeWindowsConsent(dataRoot: string, now: string): void {
  const consent: WindowsConsent = {
    accepted: true,
    acceptedAt: now,
    notice: WINDOWS_SHELL_NOTICE,
  };
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(
    path.join(dataRoot, WINDOWS_CONSENT_FILE),
    `${JSON.stringify(consent, null, 2)}\n`,
    { mode: 0o600 },
  );
}
