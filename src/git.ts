import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Run git with array args (no shell). Returns trimmed stdout. */
async function git(root: string | null, args: string[]): Promise<string> {
  const base = root ? ['-C', root] : [];
  const { stdout } = await run('git', [...base, ...args]);
  return stdout.trim();
}

/**
 * Return the repository root containing `dir`, or null if `dir` is not inside a
 * git work tree (or git is unavailable).
 */
export async function isGitRepo(dir: string): Promise<string | null> {
  try {
    return await git(null, ['-C', dir, 'rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

/** True if the current branch has an upstream or any remote is configured. */
export async function hasUpstreamOrRemote(root: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    return true;
  } catch {
    // No upstream; fall back to "is any remote configured?"
    try {
      return (await git(root, ['remote'])).length > 0;
    } catch {
      return false;
    }
  }
}

export interface AutoCommitResult {
  committed: boolean;
  pushed: boolean;
  /** Short reason when nothing was committed / pushed. */
  note?: string;
  /** Short commit SHA when a commit was made. */
  sha?: string;
  /** Non-fatal warning (e.g. push rejected). */
  warning?: string;
}

/**
 * Stage `addPath`, commit (if there are staged changes), and best-effort push.
 * All operations are scoped to the repo at `root`. Never throws; problems are
 * returned as a `note`/`warning` so the caller can log without failing the run.
 */
export async function autoCommitSnapshot(args: {
  root: string;
  addPath: string;
  message: string;
}): Promise<AutoCommitResult> {
  const { root, addPath, message } = args;

  try {
    await git(root, ['add', '-A', '--', addPath]);
  } catch (err) {
    return { committed: false, pushed: false, warning: `git add failed: ${(err as Error).message}` };
  }

  // Anything staged? `diff --cached --quiet` exits 1 when there are changes.
  try {
    await git(root, ['diff', '--cached', '--quiet', '--', addPath]);
    return { committed: false, pushed: false, note: 'nothing to commit' };
  } catch {
    // non-zero exit => there are staged changes; proceed to commit.
  }

  let sha: string | undefined;
  try {
    await git(root, ['commit', '-m', message, '--', addPath]);
    sha = await git(root, ['rev-parse', '--short', 'HEAD']).catch(() => undefined);
  } catch (err) {
    return { committed: false, pushed: false, warning: `git commit failed: ${(err as Error).message}` };
  }

  if (!(await hasUpstreamOrRemote(root))) {
    return { committed: true, pushed: false, sha, note: 'no remote configured — not pushed' };
  }

  try {
    await git(root, ['push']);
    return { committed: true, pushed: true, sha };
  } catch (err) {
    return { committed: true, pushed: false, sha, warning: `git push failed: ${(err as Error).message}` };
  }
}
