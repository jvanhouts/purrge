import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendHistory, compareScans, lastScans, readHistory, type ScanEntry } from "./history";

const GiB = 1024 ** 3;
const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const scan = (at: number, scopes: ScanEntry["scopes"], locations: ScanEntry["locations"], source: ScanEntry["source"] = "doctor"): ScanEntry => ({
  kind: "scan", source, at, disk: null, scopes, locations,
});

describe("compareScans", () => {
  const complete = { status: "complete" as const, bytes: 0 };

  test("growth is only reported between complete scopes", () => {
    const before = scan(1, { caches: complete, docker: { status: "unavailable", bytes: 0 } }, { "caches:npm": 2 * GiB, "docker:vm": 10 * GiB });
    const after = scan(2, { caches: complete, docker: complete }, { "caches:npm": 5 * GiB, "docker:vm": 30 * GiB });

    expect(compareScans(before, after)).toEqual([{ key: "caches:npm", before: 2 * GiB, after: 5 * GiB, delta: 3 * GiB, kind: "grew" }]);
  });

  test("something new behind a scope that could not be seen is newly visible, not growth", () => {
    const before = scan(1, { docker: { status: "unavailable", bytes: 0 }, caches: complete }, {});
    const after = scan(2, { docker: complete, caches: complete }, { "docker:vm": 30 * GiB, "caches:bun": GiB });

    const kinds = Object.fromEntries(compareScans(before, after).map((c) => [c.key, c.kind]));
    expect(kinds).toEqual({ "docker:vm": "newly-visible", "caches:bun": "appeared" });
  });

  test("a location missing from a partial scan is not gone", () => {
    const before = scan(1, { caches: complete }, { "caches:npm": 2 * GiB });
    const after = scan(2, { caches: { status: "partial", bytes: 0 } }, {});

    expect(compareScans(before, after)).toEqual([]);
  });

  test("a location can carry its own scope", () => {
    const key = "home:/Users/x/Library/Caches";
    const before = scan(1, { [key]: complete }, { [key]: GiB });
    const after = scan(2, { [key]: { status: "partial", bytes: 0 } }, { [key]: 9 * GiB });

    expect(compareScans(before, after)).toEqual([]);
  });

  test("small changes are noise", () => {
    const before = scan(1, { caches: complete }, { "caches:npm": GiB });
    const after = scan(2, { caches: complete }, { "caches:npm": GiB + 1024 });

    expect(compareScans(before, after)).toEqual([]);
  });
});

describe("history file", () => {
  test("appends, reads back, and only compares scans from the same source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "purrge-history-"));
    temporaryDirs.push(dir);
    const path = join(dir, "history.jsonl");

    await appendHistory(scan(1, {}, {}), path);
    await appendHistory(scan(2, {}, {}, "stats"), path);
    await appendHistory({ kind: "cleanup", at: 3, provider: "caches", items: 1, failed: 0, estimatedBytes: 5, freeBefore: 1, freeAfter: 6 }, path);
    await appendHistory(scan(4, {}, {}), path);

    const entries = await readHistory(path);
    expect(entries.map((e) => e.at)).toEqual([1, 2, 3, 4]);
    expect(lastScans(entries, "doctor").map((e) => e.at)).toEqual([1, 4]);
    expect(lastScans(entries, "stats").map((e) => e.at)).toEqual([2]);
  });

  test("a missing file is an empty history", async () => {
    expect(await readHistory("/nonexistent/purrge/history.jsonl")).toEqual([]);
  });
});
