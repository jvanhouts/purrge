import { describe, expect, test } from "bun:test";
import { coveredPaths, coveredUnder, largeActiveArtifacts, parseDuDenied } from "./doctor";
import type { StorageFinding } from "./storage";

const GiB = 1024 ** 3;

const finding = (paths: string[], allocatedBytes: number): StorageFinding => ({
  id: paths[0], provider: "t", label: "x", detail: "", paths,
  allocatedBytes, reclaimableEstimateBytes: allocatedBytes, disposition: "eligible", reason: "", lastActivityAt: null,
});

describe("parseDuDenied", () => {
  test("keeps the paths du could not read, and nothing else", () => {
    const stderr = [
      "du: /Users/x/Library/Messages: Operation not permitted",
      "du: /Users/x/Library/Safari: Permission denied",
      "du: fts_read: something else",
    ].join("\n");
    expect(parseDuDenied(stderr)).toEqual(["/Users/x/Library/Messages", "/Users/x/Library/Safari"]);
  });
});

describe("coveredPaths", () => {
  test("nested findings are counted once, by the outermost", () => {
    const covered = coveredPaths([
      finding(["/h/.npm/_cacache"], 20),
      finding(["/h/.npm/_cacache/index-v5"], 3),
      finding(["/h/.npm/_npx/abc"], 4),
      finding(["/h/Library/Caches/Yarn"], 2),
    ]);
    expect(covered).toEqual([
      { path: "/h/.npm/_cacache", bytes: 20 },
      { path: "/h/.npm/_npx/abc", bytes: 4 },
      { path: "/h/Library/Caches/Yarn", bytes: 2 },
    ]);
    expect(coveredUnder("/h/.npm", covered)).toBe(24);
    expect(coveredUnder("/h/Library", covered)).toBe(2);
    // A sibling whose name merely starts the same is not underneath.
    expect(coveredUnder("/h/.np", covered)).toBe(0);
  });
});

describe("largeActiveArtifacts", () => {
  test("lists big artifacts of active projects only, biggest first, with what rebuilding costs", () => {
    const now = Date.now();
    const project = (dir: string, mtime: number, artifacts: [string, number][]) => ({
      dir, mtime, bytes: 0, artifacts: artifacts.map(([name, bytes]) => ({ path: `${dir}/${name}`, name, bytes })),
    });
    const list = largeActiveArtifacts(
      [
        project("/p/app", now, [["src-tauri/target", 20 * GiB], ["node_modules", 2 * GiB], [".next", 100]]),
        project("/p/old", now - 1e10, [["node_modules", 5 * GiB]]),
      ],
      now - 1e9,
    );
    expect(list.map((a) => [a.name, a.rebuild])).toEqual([
      ["src-tauri/target", "full Rust rebuild"],
      ["node_modules", "reinstall"],
    ]);
  });
});
