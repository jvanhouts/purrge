import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expandHome, loadConfig } from "./config";

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  delete process.env.WORKTREE_ROOTS;
  delete process.env.WORKTREE_STALE_DAYS_AMOUNT;
});

async function temporaryCwd() {
  const dir = await mkdtemp(join(tmpdir(), "purrge-config-"));
  temporaryDirs.push(dir);
  return dir;
}

/** Never read the real ~/.purrge/config.yml — the tests would follow the machine. */
const NO_GLOBAL = join(tmpdir(), "purrge-no-such-global.yml");


describe("loadConfig", () => {
  test("falls back to the built-in defaults", async () => {
    const config = await loadConfig(await temporaryCwd(), NO_GLOBAL);

    expect(config.WORKTREE_STALE_DAYS_AMOUNT).toBe(14);
    expect(config.WORKTREE_ROOTS).toEqual([join(homedir(), ".whiskers", "worktrees")]);
  });

  test("the local JSON file overrides the defaults", async () => {
    const cwd = await temporaryCwd();
    await writeFile(join(cwd, "purrge.config.json"), JSON.stringify({ WORKTREE_STALE_DAYS_AMOUNT: 30 }));

    expect((await loadConfig(cwd, NO_GLOBAL)).WORKTREE_STALE_DAYS_AMOUNT).toBe(30);
  });

  test("the environment wins over the files", async () => {
    const cwd = await temporaryCwd();
    await writeFile(join(cwd, "purrge.config.json"), JSON.stringify({ WORKTREE_STALE_DAYS_AMOUNT: 30 }));
    process.env.WORKTREE_STALE_DAYS_AMOUNT = "3";

    expect((await loadConfig(cwd, NO_GLOBAL)).WORKTREE_STALE_DAYS_AMOUNT).toBe(3);
  });

  test("WORKTREE_ROOTS accepts a list, a lone string, and a separated env var", async () => {
    const cwd = await temporaryCwd();

    await writeFile(join(cwd, "purrge.config.json"), JSON.stringify({ WORKTREE_ROOTS: ["/a", "/b"] }));
    expect((await loadConfig(cwd, NO_GLOBAL)).WORKTREE_ROOTS).toEqual(["/a", "/b"]);

    await writeFile(join(cwd, "purrge.config.json"), JSON.stringify({ WORKTREE_ROOTS: "~/trees" }));
    expect((await loadConfig(cwd, NO_GLOBAL)).WORKTREE_ROOTS).toEqual([join(homedir(), "trees")]);

    process.env.WORKTREE_ROOTS = "/x,/y:/x";
    expect((await loadConfig(cwd, NO_GLOBAL)).WORKTREE_ROOTS).toEqual(["/x", "/y"]);
  });

  test("nonsense values are ignored rather than fatal", async () => {
    const cwd = await temporaryCwd();
    await writeFile(join(cwd, "purrge.config.json"), "{ not json at all");

    expect((await loadConfig(cwd, NO_GLOBAL)).WORKTREE_STALE_DAYS_AMOUNT).toBe(14);

    await writeFile(join(cwd, "purrge.config.json"), JSON.stringify({ WORKTREE_STALE_DAYS_AMOUNT: -1, WORKTREE_ROOTS: [] }));
    const config = await loadConfig(cwd, NO_GLOBAL);
    expect(config.WORKTREE_STALE_DAYS_AMOUNT).toBe(14);
    expect(config.WORKTREE_ROOTS).toEqual([join(homedir(), ".whiskers", "worktrees")]);
  });
});

describe("the global YAML file", () => {
  test("is read, and yields to the local file and the environment", async () => {
    const cwd = await temporaryCwd();
    const globalPath = join(cwd, "config.yml");
    await writeFile(
      globalPath,
      "PURGE_STALE_WEEKS_AMOUNT: 4\nWORKTREE_STALE_DAYS_AMOUNT: 21\nWORKTREE_ROOTS:\n  - ~/.whiskers/worktrees\n  - /srv/trees\n",
    );

    let config = await loadConfig(cwd, globalPath);
    expect(config.PURGE_STALE_WEEKS_AMOUNT).toBe(4);
    expect(config.WORKTREE_STALE_DAYS_AMOUNT).toBe(21);
    expect(config.WORKTREE_ROOTS).toEqual([join(homedir(), ".whiskers", "worktrees"), "/srv/trees"]);

    await writeFile(join(cwd, "purrge.config.json"), JSON.stringify({ WORKTREE_STALE_DAYS_AMOUNT: 7 }));
    config = await loadConfig(cwd, globalPath);
    expect(config.WORKTREE_STALE_DAYS_AMOUNT).toBe(7);
    expect(config.PURGE_STALE_WEEKS_AMOUNT).toBe(4); // untouched keys still come from the global file

    process.env.WORKTREE_STALE_DAYS_AMOUNT = "2";
    expect((await loadConfig(cwd, globalPath)).WORKTREE_STALE_DAYS_AMOUNT).toBe(2);
  });

  test("malformed YAML leaves the defaults standing", async () => {
    const cwd = await temporaryCwd();
    const globalPath = join(cwd, "config.yml");
    await writeFile(globalPath, "WORKTREE_ROOTS: [unclosed\n\t\tbad: indent");

    expect((await loadConfig(cwd, globalPath)).WORKTREE_STALE_DAYS_AMOUNT).toBe(14);
  });
});

describe("expandHome", () => {
  test("expands ~ and $HOME, and leaves absolute paths alone", () => {
    expect(expandHome("~/trees")).toBe(join(homedir(), "trees"));
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("$HOME/trees")).toBe(join(homedir(), "trees"));
    expect(expandHome("/tmp/trees")).toBe("/tmp/trees");
  });
});
