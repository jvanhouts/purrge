import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findCargoTargets, findProjects } from "./scan";

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTauriFixture() {
  const root = await mkdtemp(join(tmpdir(), "purrge-test-"));
  temporaryDirs.push(root);
  const app = join(root, "demo");
  const target = join(app, "src-tauri", "target", "release", "bundle");
  await mkdir(target, { recursive: true });
  await writeFile(join(app, "src-tauri", "Cargo.toml"), "[package]\nname = \"demo\"\n");
  await writeFile(join(app, "src-tauri", "tauri.conf.json"), "{}");
  await writeFile(join(target, "demo"), "fake Tauri build output");
  const targetDir = join(app, "src-tauri", "target");
  await utimes(targetDir, new Date("2025-01-01"), new Date("2025-01-01"));
  return { root, app, target: targetDir };
}

describe("Tauri and Cargo detection", () => {
  test("groups a Tauri target under the application root", async () => {
    const fixture = await makeTauriFixture();
    const projects = await findProjects(fixture.root);

    expect(projects).toHaveLength(1);
    expect(projects[0].dir).toBe(fixture.app);
    expect(projects[0].artifacts.map((artifact) => artifact.name)).toEqual(["src-tauri/target"]);
    expect(projects[0].artifacts[0].path).toBe(fixture.target);
  });

  test("finds Tauri targets for cargo sweep", async () => {
    const fixture = await makeTauriFixture();
    const projects = await findCargoTargets(fixture.root);

    expect(projects).toHaveLength(1);
    expect(projects[0].dir).toBe(fixture.app);
    expect(projects[0].artifacts[0].name).toBe("src-tauri/target");
    expect(projects[0].bytes).toBeGreaterThan(0);
    expect(projects[0].mtime).toBeLessThan(Date.now() - 14 * 86_400_000);
  });
});
