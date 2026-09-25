/**
 * Linked git worktrees living under a shared checkout root.
 *
 * A worktree is disposable in a way a project is not: the whole directory goes,
 * not a build artifact inside it. That makes the safety questions different —
 * uncommitted edits and commits that exist nowhere else are gone for good — so
 * every worktree is inspected before it is offered up.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ARTIFACT_DIRS, GATED_ARTIFACT_DIRS, SKIP_DIRS } from "./artifacts";
import { mapLimit } from "./concurrency";
import { dirSize, isLinkedWorktree, readGitdir } from "./scan";
import type { Project } from "./scan";

export type Worktree = Project & {
  /** The repository this worktree is checked out from, if it could be read. */
  repo: string | null;
  /** Branch name, or a short sha when the worktree is detached. */
  head: string;
  /** Uncommitted changes in the working tree. */
  dirty: boolean;
  /** HEAD is reachable from no other branch — deleting it orphans those commits. */
  unmerged: boolean;
};

/**
 * A worktree is safe to remove unless it holds commits no branch has. Dirty
 * ones are offered up — flagged in the picker, but uncommitted edits in an idle
 * worktree are not worth holding the whole thing back for.
 */
export function isSafe(w: Worktree): boolean {
  return !w.unmerged;
}

/** What is risky about a worktree, for display. */
export function riskLabel(w: Worktree): string {
  const flags = [w.dirty && "dirty", w.unmerged && "unmerged"].filter(Boolean);
  return flags.join(" ");
}

/**
 * Find every linked worktree directly under each root, plus every worktree of
 * every repo under the project roots.
 *
 * Worktree roots are one level deep by convention, and the marker is a `.git`
 * *file* holding a gitdir pointer — a plain clone has a `.git` directory
 * instead, and is left well alone.
 *
 * Plain `git worktree add` puts a checkout wherever it was told to: next to the
 * repo, inside it, anywhere. The repo keeps the path in
 * `.git/worktrees/<name>/gitdir`, so the project roots are searched for repos
 * and each one is asked where its worktrees are.
 */
export async function findWorktrees(
  roots: string[],
  onWorktree?: (w: Worktree) => void,
  projectRoots: string[] = [],
): Promise<Worktree[]> {
  const found: Worktree[] = [];
  const seen = new Set<string>();
  const add = async (dir: string) => {
    const worktree = await inspect(dir);
    if (!worktree) return;
    found.push(worktree);
    onWorktree?.(worktree);
  };

  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // a configured root that does not exist yet is not an error
    }

    const dirs = entries
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
      .map((e) => join(root, e.name))
      .filter((dir) => !seen.has(dir) && seen.add(dir));

    // Sizing shells out to `du`; the git probes are cheap by comparison.
    await mapLimit(dirs, 6, add);
  }

  for (const root of projectRoots) {
    const repos = await findRepos(root);
    const lists = await mapLimit(repos, 8, listWorktrees);
    const dirs = lists.flat().filter((dir) => !seen.has(dir) && seen.add(dir));
    await mapLimit(dirs, 6, add);
  }

  return found;
}

/**
 * Every repo (a directory with a `.git` *directory*) under root. A repo is not
 * searched further: its own worktrees are listed by git, wherever they are.
 */
async function findRepos(root: string): Promise<string[]> {
  const repos: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isDirectory() && e.name === ".git")) {
      repos.push(dir);
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === ".git")) return; // a worktree or submodule
    const subdirs = entries
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !ARTIFACT_DIRS.has(e.name) && !GATED_ARTIFACT_DIRS.has(e.name))
      .map((e) => join(dir, e.name));
    await mapLimit(subdirs, 16, walk);
  }

  await walk(root);
  return repos;
}

/** Checkout paths of a repo's linked worktrees, from `.git/worktrees/<name>/gitdir`. */
async function listWorktrees(repo: string): Promise<string[]> {
  const admin = join(repo, ".git", "worktrees");
  let names;
  try {
    names = await readdir(admin);
  } catch {
    return [];
  }
  const dirs = await mapLimit(names, 8, async (name) => {
    try {
      // `gitdir` holds `<checkout>/.git`. A checkout deleted by hand leaves the
      // entry behind until `git worktree prune`; inspect() skips it.
      const pointer = (await readFile(join(admin, name, "gitdir"), "utf8")).trim();
      // Relative since git 2.48 with `worktree.useRelativePaths`.
      const dir = dirname(resolve(admin, name, pointer));
      return (await isLinkedWorktree(dir)) ? dir : null;
    } catch {
      return null;
    }
  });
  return dirs.filter((d): d is string => d !== null);
}

async function inspect(dir: string): Promise<Worktree | null> {
  const gitdir = await readGitdir(dir);
  if (!gitdir) return null;

  const [bytes, mtime, head, dirty] = await Promise.all([
    dirSize(dir),
    newestSourceMtime(dir),
    describeHead(dir),
    isDirty(dir),
  ]);
  if (!bytes) return null;

  // A worktree on a named branch leaves that branch behind when it goes, so its
  // commits are never at risk. Only a detached HEAD can be orphaned.
  const unmerged = head.startsWith("@") ? await isUnmerged(dir) : false;

  return {
    dir,
    artifacts: [{ path: dir, name: basename(dir), bytes }],
    bytes,
    mtime,
    repo: repoFromGitdir(gitdir),
    head,
    dirty,
    unmerged,
  };
}

function repoFromGitdir(gitdir: string): string | null {
  // <repo>/.git/worktrees/<name>  →  <repo>
  const parts = gitdir.split("/");
  const at = parts.lastIndexOf("worktrees");
  if (at < 2 || parts[at - 1] !== ".git") return null;
  return parts.slice(0, at - 1).join("/") || "/";
}

/**
 * Newest mtime among the worktree's own files, build artifacts excluded.
 *
 * A freshly installed `node_modules` says nothing about whether you are still
 * working in the branch, and every one of these directories is a few hundred
 * megabytes of noise to walk through.
 */
async function newestSourceMtime(root: string): Promise<number> {
  let newest = 0;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const subdirs: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (ARTIFACT_DIRS.has(e.name) || GATED_ARTIFACT_DIRS.has(e.name) || SKIP_DIRS.has(e.name)) continue;
        subdirs.push(join(dir, e.name));
      } else if (e.isFile()) {
        // `.git` here is git's own pointer file, stamped when the worktree was
        // created. Counting it would make every worktree look freshly worked on.
        if (e.name === ".git") continue;
        try {
          const s = await stat(join(dir, e.name));
          if (s.mtimeMs > newest) newest = s.mtimeMs;
        } catch {}
      }
    }
    await mapLimit(subdirs, 16, walk);
  }

  await walk(root);
  if (newest) return newest;
  try {
    return (await stat(root)).mtimeMs;
  } catch {
    return 0;
  }
}

// ── git probes ───────────────────────────────────────────────────────────────

async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

async function describeHead(dir: string): Promise<string> {
  const branch = (await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]))?.trim();
  if (branch) return branch;
  const sha = (await git(dir, ["rev-parse", "--short", "HEAD"]))?.trim();
  return sha ? `@${sha}` : "?";
}

async function isDirty(dir: string): Promise<boolean> {
  const out = await git(dir, ["status", "--porcelain", "--untracked-files=normal"]);
  // A failed probe means we could not prove the worktree is clean — assume dirty.
  return out === null || out.trim().length > 0;
}

/**
 * Is this detached HEAD reachable from no branch at all?
 *
 * `git branch -a --contains HEAD` lists the current worktree's own entry too —
 * as `* (HEAD detached at …)` or `* (no branch)` — so that line is dropped
 * before deciding. Anything left means the commits survive the deletion.
 */
async function isUnmerged(dir: string): Promise<boolean> {
  const out = await git(dir, ["branch", "-a", "--contains", "HEAD"]);
  if (out === null) return true;
  const others = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("*") && !line.includes("->"));
  return others.length === 0;
}
