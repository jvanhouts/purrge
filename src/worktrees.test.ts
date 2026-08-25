import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findWorktrees, isSafe, riskLabel } from "./worktrees";

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

/** A repo with a worktree root beside it, the way ~/.whiskers is laid out. */
async function makeRepo() {
  const created = await mkdtemp(join(tmpdir(), "purrge-wt-"));
  temporaryDirs.push(created);
  // macOS hands out /var/... but git resolves the /private/var symlink.
  const base = await realpath(created);
  const repo = join(base, "repo");
  const root = join(base, "worktrees");
  await mkdir(repo, { recursive: true });
  await mkdir(root, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "README.md"), "x".repeat(20_000));
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "first");
  return { base, repo, root };
}

async function addWorktree(repo: string, root: string, name: string, ref = "main") {
  const dir = join(root, name);
  await git(repo, "worktree", "add", "-q", "--detach", dir, ref);
  return dir;
}

describe("findWorktrees", () => {
  test("finds linked worktrees and reads their repo and head", async () => {
    const { repo, root } = await makeRepo();
    const dir = await addWorktree(repo, root, "feature");

    const found = await findWorktrees([root]);

    expect(found).toHaveLength(1);
    expect(found[0].dir).toBe(dir);
    expect(found[0].repo).toBe(repo);
    expect(found[0].head).toMatch(/^@[0-9a-f]+$/);
    expect(found[0].bytes).toBeGreaterThan(0);
    expect(found[0].artifacts[0].path).toBe(dir);
  });

  test("ignores plain directories and full clones", async () => {
    const { base, repo, root } = await makeRepo();
    await mkdir(join(root, "just-a-folder"));
    await writeFile(join(root, "just-a-folder", "note.txt"), "hello");
    // A real clone has a .git directory, not a gitdir pointer file.
    await git(base, "clone", "-q", repo, join(root, "a-clone"));

    const found = await findWorktrees([root]);

    expect(found).toHaveLength(0);
  });

  test("a missing root is skipped rather than fatal", async () => {
    const { root } = await makeRepo();
    const found = await findWorktrees([join(root, "nope"), root]);
    expect(found).toEqual([]);
  });

  test("reports each worktree as it is found", async () => {
    const { repo, root } = await makeRepo();
    await addWorktree(repo, root, "one");
    await addWorktree(repo, root, "two");

    const streamed: string[] = [];
    const found = await findWorktrees([root], (w) => streamed.push(w.dir));

    expect(streamed.sort()).toEqual(found.map((w) => w.dir).sort());
    expect(streamed).toHaveLength(2);
  });
});

describe("safety", () => {
  test("a worktree at a merged commit is safe", async () => {
    const { repo, root } = await makeRepo();
    await addWorktree(repo, root, "clean");

    const [w] = await findWorktrees([root]);

    expect(w.dirty).toBe(false);
    expect(w.unmerged).toBe(false);
    expect(isSafe(w)).toBe(true);
    expect(riskLabel(w)).toBe("");
  });

  test("uncommitted changes make it unsafe", async () => {
    const { repo, root } = await makeRepo();
    const dir = await addWorktree(repo, root, "messy");
    await writeFile(join(dir, "README.md"), "edited");

    const [w] = await findWorktrees([root]);

    expect(w.dirty).toBe(true);
    expect(isSafe(w)).toBe(false);
    expect(riskLabel(w)).toContain("dirty");
  });

  test("a detached commit on no branch is unmerged", async () => {
    const { repo, root } = await makeRepo();
    const dir = await addWorktree(repo, root, "orphan");
    await writeFile(join(dir, "extra.txt"), "y".repeat(20_000));
    await git(dir, "add", ".");
    await git(dir, "commit", "-qm", "only here");

    const [w] = await findWorktrees([root]);

    expect(w.unmerged).toBe(true);
    expect(riskLabel(w)).toContain("unmerged");
  });

  test("a worktree on a named branch is never unmerged — the branch outlives it", async () => {
    const { repo, root } = await makeRepo();
    const dir = join(root, "on-a-branch");
    await git(repo, "worktree", "add", "-q", "-b", "side", dir, "main");
    await writeFile(join(dir, "extra.txt"), "y".repeat(20_000));
    await git(dir, "add", ".");
    await git(dir, "commit", "-qm", "on the branch");

    const [w] = await findWorktrees([root]);

    expect(w.head).toBe("side");
    expect(w.unmerged).toBe(false);
    expect(isSafe(w)).toBe(true);
  });
});
