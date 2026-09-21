/**
 * A stand-in for the `claude` binary.
 *
 * Only `spawn` is replaced, so the real `ClaudeCliRuntime` still builds the
 * argument list, writes the prompt to stdin and parses the JSON envelope — the
 * bridge under test is the production one.
 */

import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import type { SpawnLike } from '../../../runtime/src/index.js';

export interface FakeClaude {
  spawn: SpawnLike;
  /** Set false to make the sandbox probe fail, as an unusable host would. */
  sandboxAvailable?: boolean;
  /** Every prompt a run was given, in order. */
  prompts: string[];
  /** Every argument list, in order, command first. */
  calls: string[][];
  /** What the next run does. Mutate between runs. */
  script: { result: string; isError?: boolean; exitCode?: number };
}

export function fakeClaude(): FakeClaude {
  const state: FakeClaude = {
    prompts: [],
    calls: [],
    script: { result: 'done' },
    spawn: (() => undefined) as unknown as SpawnLike,
  };

  state.spawn = ((command: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      stdin: Writable;
      kill: (signal?: string) => boolean;
    };
    state.calls.push([command, ...args]);

    // The sandbox probe and `--version` never write to stdin, so they answer
    // immediately rather than waiting for a prompt that is not coming.
    if (args.includes('--unshare-all') && args.includes('/bin/true')) {
      setTimeout(() => {
        child.stdout.push(null);
        child.emit('close', state.sandboxAvailable === false ? 1 : 0);
      }, 0);
    }

    let prompt = '';
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        prompt += String(chunk);
        callback();
      },
    });
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.kill = () => true;

    child.stdin.on('finish', () => {
      state.prompts.push(prompt);
      setTimeout(() => {
        if (args.includes('--version')) {
          child.stdout.push('2.0.0 (Claude Code)\n');
        } else {
          child.stdout.push(
            JSON.stringify({
              type: 'result',
              subtype: state.script.isError ? 'error_during_execution' : 'success',
              is_error: state.script.isError ?? false,
              result: state.script.result,
              session_id: args[args.indexOf('--session-id') + 1],
            }),
          );
        }
        child.stdout.push(null);
        child.emit('close', state.script.exitCode ?? 0);
      }, 0);
    });
    return child;
  }) as unknown as SpawnLike;

  return state;
}
