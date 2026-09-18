/**
 * Which isolation a run gets, and when no run is allowed at all.
 *
 * The distinction that matters: a Linux host whose sandbox will not start is
 * REFUSED, never quietly run without one; a Windows host has no namespace to
 * begin with, so it is refused until the operator has said, once, that they
 * accept what that means.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decideRunMode,
  readWindowsConsent,
  WINDOWS_SHELL_NOTICE,
  writeWindowsConsent,
} from '../src/control/runMode.js';

let dataRoot: string;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-runmode-'));
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('run mode', () => {
  it('sandboxes on Linux, and refuses rather than dropping the sandbox', () => {
    expect(
      decideRunMode({
        platform: 'linux',
        windowsConsent: false,
        sandboxOk: true,
        hasToken: true,
      }),
    ).toEqual({ mode: 'sandboxed', requiresToken: true });

    const broken = decideRunMode({
      platform: 'linux',
      windowsConsent: true, // irrelevant here, and must not open a back door
      sandboxOk: false,
      sandboxDetail: 'refused by host policy',
      hasToken: true,
    });
    expect(broken.mode).toBe('sandboxed');
    expect(broken.refusal).toMatch(/sandbox is unavailable/);

    const noToken = decideRunMode({
      platform: 'linux',
      windowsConsent: false,
      sandboxOk: true,
      hasToken: false,
    });
    expect(noToken.refusal).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it('refuses on Windows until the notice has been accepted', () => {
    const before = decideRunMode({
      platform: 'win32',
      windowsConsent: false,
      sandboxOk: false,
      hasToken: false,
    });
    expect(before.refusal).toMatch(/one-time approval/);

    const after = decideRunMode({
      platform: 'win32',
      windowsConsent: true,
      sandboxOk: false,
      hasToken: false,
    });
    // Accepted: shell mode, and no token needed because the operator's own
    // `claude login` is reachable when nothing is hidden from the run.
    expect(after).toEqual({ mode: 'shell', requiresToken: false });
  });

  it('records what was accepted, and forgets it when the file goes', () => {
    expect(readWindowsConsent(dataRoot)).toBe(false);
    writeWindowsConsent(dataRoot, '2026-09-18T00:00:00.000Z');
    expect(readWindowsConsent(dataRoot)).toBe(true);

    const stored = JSON.parse(
      fs.readFileSync(path.join(dataRoot, 'windows-shell-consent.json'), 'utf8'),
    ) as { notice: string };
    // The record says what was agreed to, not just that something was.
    expect(stored.notice).toBe(WINDOWS_SHELL_NOTICE);
    expect(stored.notice).toMatch(/YOUR OWN permissions/);

    fs.rmSync(path.join(dataRoot, 'windows-shell-consent.json'));
    expect(readWindowsConsent(dataRoot)).toBe(false);
  });
});
