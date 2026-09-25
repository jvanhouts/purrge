import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdit, resolveKey } from "./config-cli";
import { loadConfig, readGlobalConfig, writeGlobalConfig, type Config } from "./config";

const CURRENT: Config = {
  PURGE_STALE_WEEKS_AMOUNT: 8,
  CARGO_SWEEP_STALE_DAYS_AMOUNT: 14,
  WORKTREE_STALE_DAYS_AMOUNT: 14,
  SIM_STALE_DAYS_AMOUNT: 30,
  WORKTREE_ROOTS: [join(homedir(), ".whiskers", "worktrees")],
  PROJECT_ROOTS: [],
};

describe("resolveKey", () => {
  test("accepts aliases, full names and loose spellings", () => {
    expect(resolveKey("projects")).toBe("PROJECT_ROOTS");
    expect(resolveKey("PROJECT_ROOTS")).toBe("PROJECT_ROOTS");
    expect(resolveKey("sim-stale-days-amount")).toBe("SIM_STALE_DAYS_AMOUNT");
    expect(resolveKey("nope")).toBeNull();
  });
});

describe("applyEdit", () => {
  test("add stores dirs home-relative and skips duplicates", () => {
    const out = applyEdit({}, { op: "add", key: "PROJECT_ROOTS", values: ["~/code", join(homedir(), "code"), "~/work"] }, CURRENT);
    expect(out.PROJECT_ROOTS).toEqual(["~/code", "~/work"]);
  });

  test("add extends the default when the file has no entry", () => {
    const out = applyEdit({}, { op: "add", key: "WORKTREE_ROOTS", values: ["~/wt"] }, CURRENT);
    expect(out.WORKTREE_ROOTS).toEqual(["~/.whiskers/worktrees", "~/wt"]);
  });

  test("remove matches however the dir is spelled", () => {
    const out = applyEdit({ PROJECT_ROOTS: ["~/code", "~/work"] }, { op: "remove", key: "PROJECT_ROOTS", values: [join(homedir(), "code")] }, CURRENT);
    expect(out.PROJECT_ROOTS).toEqual(["~/work"]);
  });

  test("set takes one non-negative number for number keys", () => {
    expect(applyEdit({}, { op: "set", key: "PURGE_STALE_WEEKS_AMOUNT", values: ["12"] }, CURRENT).PURGE_STALE_WEEKS_AMOUNT).toBe(12);
    expect(() => applyEdit({}, { op: "set", key: "PURGE_STALE_WEEKS_AMOUNT", values: ["-1"] }, CURRENT)).toThrow();
    expect(() => applyEdit({}, { op: "set", key: "PURGE_STALE_WEEKS_AMOUNT", values: ["1", "2"] }, CURRENT)).toThrow();
  });

  test("unset drops the key and keeps unknown ones", () => {
    const out = applyEdit({ PROJECT_ROOTS: ["~/code"], SOMETHING_ELSE: true }, { op: "unset", key: "PROJECT_ROOTS" }, CURRENT);
    expect(out).toEqual({ SOMETHING_ELSE: true });
  });
});

test("a written file reads back the same through loadConfig", async () => {
  const dir = await mkdtemp(join(tmpdir(), "purrge-config-cli-"));
  try {
    const path = join(dir, "nested", "config.yml");
    await writeGlobalConfig({ PROJECT_ROOTS: ["~/code"], PURGE_STALE_WEEKS_AMOUNT: 3 }, path);
    expect(await readGlobalConfig(path)).toEqual({ PROJECT_ROOTS: ["~/code"], PURGE_STALE_WEEKS_AMOUNT: 3 });
    const config = await loadConfig(dir, path);
    expect(config.PROJECT_ROOTS).toEqual([join(homedir(), "code")]);
    expect(config.PURGE_STALE_WEEKS_AMOUNT).toBe(3);
    expect(await readFile(path, "utf8")).toStartWith("# purrge settings");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
