/**
 * Bridges Office's file-backed agents into Claude Code's own discovery
 * directories.
 *
 * Directory junctions/symlinks ONLY — never a file symlink. A file symlink
 * needs Administrator privileges or Developer Mode on Windows, and a
 * directory junction needs neither; `fs.symlinkSync(target, path,
 * 'junction')` asks Node for a junction on Windows and a plain directory
 * symlink everywhere else, so this one call is correct cross-platform without
 * a runtime OS check.
 *
 * Scope is deliberately narrow, so Skills and Knowledge are never inside
 * Claude Code's recursive `.claude/agents/` scan:
 *
 *   ~/.claude/agents/<agent-id>/   → …/agents/<agent-id>/discovery/
 *                                    (holds ONLY agent.md — nothing else)
 *   ~/.claude/skills/<qualified>/  → …/agents/<agent-id>/skills/<skill-id>/
 *                                    (one skill's own directory, one at a time)
 *
 * Ownership safety mirrors `claudeHookInstaller.ts`'s rule for hooks: never
 * rewrite a shape this module did not create. A real file or directory found
 * where a link should go is left alone and reported, not replaced; a link
 * pointing somewhere else is left alone too, since repointing it could hide
 * an agent that legitimately still owns that name.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LinkOutcome {
  created: boolean;
  /** True when an existing path was left untouched because this module did
   *  not create it, or it points somewhere other than `targetDir`. */
  skippedForeign?: boolean;
}

/**
 * Create (or verify) a directory junction/symlink at `linkPath` pointing at
 * `targetDir`. Idempotent: calling it again once the link is correct is a
 * no-op.
 */
export function ensureDirectoryLink(linkPath: string, targetDir: string): LinkOutcome {
  const stat = lstatIfPresent(linkPath);
  if (stat) {
    if (!stat.isSymbolicLink()) {
      return { created: false, skippedForeign: true };
    }
    if (resolvesTo(linkPath, targetDir)) {
      return { created: false };
    }
    return { created: false, skippedForeign: true };
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(targetDir, linkPath, 'junction');
  return { created: true };
}

/**
 * Remove a link this module created. Refuses (returns false, touches
 * nothing) if `linkPath` is not actually a link pointing at `targetDir` —
 * this can never delete a real directory or someone else's link.
 */
export function removeDirectoryLinkIfOurs(linkPath: string, targetDir: string): boolean {
  const stat = lstatIfPresent(linkPath);
  if (!stat || !stat.isSymbolicLink() || !resolvesTo(linkPath, targetDir)) {
    return false;
  }
  fs.rmSync(linkPath, { force: true });
  return true;
}

/** True if `linkPath` is a link and every entry it names still exists inside
 *  the Office data root — used to spot a stale link left by a deleted agent
 *  without ever guessing at *why* it is stale. */
export function isOurLink(linkPath: string, targetDir: string): boolean {
  const stat = lstatIfPresent(linkPath);
  return stat !== undefined && stat.isSymbolicLink() && resolvesTo(linkPath, targetDir);
}

function resolvesTo(linkPath: string, targetDir: string): boolean {
  const current = fs.readlinkSync(linkPath);
  const resolvedCurrent = path.isAbsolute(current)
    ? current
    : path.resolve(path.dirname(linkPath), current);
  return path.resolve(resolvedCurrent) === path.resolve(targetDir);
}

function lstatIfPresent(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
