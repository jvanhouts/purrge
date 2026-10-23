import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exec, findRunning, isLowSpace, measure, measurementIssue, statusFor, summarizeFindings, type StorageFinding } from "./storage";

const GiB = 1024 ** 3;
const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const finding = (disposition: StorageFinding["disposition"], allocatedBytes: number | null, reclaim?: number): StorageFinding => ({
  id: `t:${Math.random()}`, provider: "t", label: "x", detail: "", paths: [],
  allocatedBytes, reclaimableEstimateBytes: reclaim ?? allocatedBytes, disposition, reason: "", lastActivityAt: null,
});

describe("statusFor", () => {
  test("a missing tool alone is complete — there is simply nothing there", () => {
    expect(statusFor([], [{ code: "missing-tool", message: "gradle not found" }])).toBe("complete");
  });

  test("a tool failure with nothing found is an error, not an empty machine", () => {
    expect(statusFor([], [{ code: "tool-failed", message: "simctl failed" }])).toBe("error");
  });

  test("partial when something was found despite the trouble", () => {
    expect(statusFor([1], [{ code: "tool-failed", message: "simctl failed" }])).toBe("partial");
    expect(statusFor([1], [{ code: "denied", path: "/x", message: "denied" }])).toBe("partial");
  });

  test("an unreachable daemon with nothing found is unavailable", () => {
    expect(statusFor([], [{ code: "unavailable", message: "daemon down" }])).toBe("unavailable");
  });
});

describe("summarizeFindings", () => {
  test("splits by disposition, using the reclaim estimate for eligible bytes", () => {
    const s = summarizeFindings([finding("eligible", 100, 60), finding("held-back", 30), finding("review-only", 5), finding("eligible", null)]);

    expect(s).toEqual({
      count: 4, bytes: 135, eligibleCount: 2, eligibleBytes: 60,
      heldBackCount: 1, heldBackBytes: 30, reviewCount: 1, reviewBytes: 5,
    });
  });
});

describe("measure", () => {
  test("sizes a directory and says when it is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "purrge-measure-"));
    temporaryDirs.push(dir);
    await mkdir(join(dir, "a"));
    await writeFile(join(dir, "a", "f"), Buffer.alloc(64 * 1024));

    const m = await measure(dir);
    expect(m.bytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(m.partial).toBe(false);
    expect(measurementIssue(dir, m)).toBeNull();

    expect(await measure(join(dir, "nope"))).toEqual({ bytes: null, partial: false, missing: true, denied: false });
  });

  test("a partial size is an issue", () => {
    expect(measurementIssue("/x", { bytes: 1, partial: true, missing: false, denied: false })?.code).toBe("partial-size");
  });
});

describe("exec", () => {
  test("tells a missing binary from a failing one", async () => {
    expect((await exec(["purrge-definitely-not-installed"])).missing).toBe(true);
    const failed = await exec(["sh", "-c", "echo nope >&2; exit 3"]);
    expect(failed).toMatchObject({ ok: false, code: 3, missing: false });
    expect(failed.stderr.trim()).toBe("nope");
  });
});

test("findRunning matches command lines", () => {
  expect(findRunning(["/usr/bin/node npm install", "zsh"], [/npm install/])).toBe("/usr/bin/node npm install");
  expect(findRunning(["zsh"], [/npm install/])).toBeNull();
});

test("low space is the larger of 10% and 20 GiB", () => {
  const disk = (total: number, free: number) => ({ path: "/", totalBytes: total, freeBytes: free, usedBytes: total - free });
  expect(isLowSpace(disk(500 * GiB, 8 * GiB))).toBe(true);
  expect(isLowSpace(disk(500 * GiB, 60 * GiB))).toBe(false);
  expect(isLowSpace(disk(100 * GiB, 15 * GiB))).toBe(true);
});

test("an enclosing finding is left out of totals while what it encloses is counted", () => {
  const vm = { ...finding("review-only", 40), provider: "docker", enclosing: true };
  const image = { ...finding("eligible", 8), provider: "docker" };

  expect(summarizeFindings([vm, image]).bytes).toBe(8);
  // Daemon down: the VM disk is all there is to go on.
  expect(summarizeFindings([vm]).bytes).toBe(40);
});
