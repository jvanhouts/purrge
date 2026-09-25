import { describe, expect, test } from "bun:test";
import { summarize, summarizeWorktrees } from "./stats";
import type { Project } from "./scan";
import type { Worktree } from "./worktrees";

const project = (bytes: number, mtime: number): Project => ({ dir: `/p/${bytes}`, artifacts: [], bytes, mtime });

describe("summarize", () => {
  test("splits count and bytes at the cutoff", () => {
    const s = summarize([project(100, 50), project(30, 200), project(5, 10)], 100);

    expect(s).toEqual({ count: 3, staleCount: 2, bytes: 135, staleBytes: 105 });
  });

  test("something never used is stale", () => {
    expect(summarize([project(1, 0)], 1).staleCount).toBe(1);
  });

  test("nothing at all is all zeros", () => {
    expect(summarize([], Date.now())).toEqual({ count: 0, staleCount: 0, bytes: 0, staleBytes: 0 });
  });
});

describe("summarizeWorktrees", () => {
  const worktree = (bytes: number, mtime: number, dirty = false, unmerged = false): Worktree => ({
    ...project(bytes, mtime),
    repo: null,
    head: "main",
    dirty,
    unmerged,
  });

  test("only stale unmerged worktrees are held back — dirty ones are not", () => {
    const s = summarizeWorktrees(
      [worktree(10, 50), worktree(20, 50, true), worktree(40, 50, false, true), worktree(80, 200, true)],
      100,
    );

    expect(s).toEqual({ count: 4, staleCount: 3, bytes: 150, staleBytes: 70, heldBackCount: 1, heldBackBytes: 40 });
  });
});
