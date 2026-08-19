import { readdir, stat, lstat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { ARTIFACT_DIRS, GATED_ARTIFACT_DIRS, NO_DESCEND, SKIP_DIRS, TAURI_DIR } from "./artifacts";
import { mapLimit } from "./concurrency";

export type Artifact = { path: string; name: string; bytes: number };

export type Project = {
  /** Absolute path of the project root. */
  dir: string;
  artifacts: Artifact[];
  /** Total reclaimable bytes. */
  bytes: number;
  /** Newest mtime (ms) of the project's own source files — artifacts excluded. */
  mtime: number;
};

/**
 * One recursive pass over the tree.
 *
 * A directory is a project as soon as it holds an artifact dir. We never descend
 * into artifact dirs — that is where all the file count lives — so the walk stays
 * proportional to your source tree rather than to your dependencies.
 */
export async function findProjects(
  root: string,
  /** Called the moment a project has been sized, before the walk finishes. */
  onProject?: (project: Project) => void,
): Promise<Project[]> {
  const projects: Project[] = [];

  /** @returns newest mtime found in this subtree, artifacts excluded */
  async function walk(dir: string, suppressProject = false): Promise<number> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0; // unreadable — not our problem
    }

    const artifactPaths: string[] = [];
    const gated: string[] = [];
    const subdirs: string[] = [];
    const files = new Set<string>();
    let newest = 0;

    for (const e of entries) {
      const name = e.name;
      if (e.isDirectory()) {
        if (ARTIFACT_DIRS.has(name)) artifactPaths.push(join(dir, name));
        else if (GATED_ARTIFACT_DIRS.has(name)) gated.push(name);
        else if (!SKIP_DIRS.has(name)) subdirs.push(join(dir, name));
      } else if (e.isFile()) {
        files.add(name);
        try {
          const s = await stat(join(dir, name));
          if (s.mtimeMs > newest) newest = s.mtimeMs;
        } catch {}
      }
    }

    // A Tauri project owns the Rust target directory below src-tauri. Treat it
    // as one artifact on the app root, instead of exposing src-tauri as a
    // separate project and hiding the bundle output inside target/.
    const tauriTarget = await findTauriTarget(dir, entries);
    if (tauriTarget) {
      artifactPaths.push(tauriTarget);
      const tauriSource = join(dir, TAURI_DIR);
      const i = subdirs.indexOf(tauriSource);
      if (i >= 0) subdirs.splice(i, 1);
    }

    for (const name of gated) {
      const manifests = GATED_ARTIFACT_DIRS.get(name)!;
      if (manifests.some((m) => files.has(m))) artifactPaths.push(join(dir, name));
      else if (!NO_DESCEND.has(name)) subdirs.push(join(dir, name));
    }

    // Recurse first, so a parent's age reflects edits anywhere below it.
    const childTimes = await mapLimit(subdirs, 16, (child) =>
      walk(child, Boolean(tauriTarget && child === join(dir, TAURI_DIR))),
    );
    for (const t of childTimes) if (t > newest) newest = t;

    if (artifactPaths.length && !suppressProject) {
      const artifacts = await mapLimit(artifactPaths, 8, async (path) => ({
        path,
        name: relative(dir, path) || path.slice(path.lastIndexOf("/") + 1),
        bytes: await dirSize(path),
      }));
      const bytes = artifacts.reduce((n, a) => n + a.bytes, 0);
      if (bytes > 0) {
        const project = { dir, artifacts, bytes, mtime: newest || (await safeMtime(dir)) };
        projects.push(project);
        onProject?.(project);
      }
    }

    return newest;
  }

  await walk(root);
  return projects;
}

async function findTauriTarget(dir: string, entries: import("node:fs").Dirent[]): Promise<string | null> {
  const tauri = entries.find((e) => e.isDirectory() && e.name === TAURI_DIR);
  if (!tauri) return null;
  const rustDir = join(dir, TAURI_DIR);
  try {
    await stat(join(rustDir, "Cargo.toml"));
    const hasConfig = entries.some((e) => e.isFile() && (e.name === "tauri.conf.json" || e.name === "tauri.conf.json5"))
      || await exists(join(rustDir, "tauri.conf.json"))
      || await exists(join(rustDir, "tauri.conf.json5"));
    if (hasConfig || await exists(join(dir, "package.json"))) {
      const target = join(rustDir, "target");
      return await exists(target) ? target : null;
    }
  } catch {}
  return null;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/** Find Cargo target directories for `purrge cargo sweep`. */
export async function findCargoTargets(root: string): Promise<Project[]> {
  const found = new Map<string, Project>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    const hasManifest = entries.some((e) => e.isFile() && e.name === "Cargo.toml");
    if (hasManifest) {
      const target = join(dir, "target");
      if (await exists(target)) await addTarget(dir, target);
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || ARTIFACT_DIRS.has(e.name) || e.name === "target") continue;
      await walk(join(dir, e.name));
    }
  }

  async function addTarget(manifestDir: string, target: string) {
    const projectDir = basename(manifestDir) === TAURI_DIR ? dirname(manifestDir) : manifestDir;
    if (found.has(target)) return;
    const bytes = await dirSize(target);
    if (bytes) found.set(target, {
      dir: projectDir,
      artifacts: [{ path: target, name: relative(projectDir, target), bytes }],
      bytes,
      mtime: await safeMtime(target),
    });
  }

  await walk(root);
  return [...found.values()];
}

async function safeMtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

const HAS_DU = process.platform !== "win32";

/** Size of a directory tree in bytes. Uses `du` (C speed) when available. */
export async function dirSize(path: string): Promise<number> {
  if (HAS_DU) {
    try {
      const proc = Bun.spawn(["du", "-sk", path], { stdout: "pipe", stderr: "ignore" });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      const kb = Number(text.trim().split(/\s+/)[0]);
      if (Number.isFinite(kb)) return kb * 1024;
    } catch {}
  }
  return walkSize(path);
}

async function walkSize(path: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  const dirs: string[] = [];
  for (const e of entries) {
    const p = join(path, e.name);
    if (e.isDirectory()) dirs.push(p);
    else if (e.isFile()) {
      try {
        total += (await lstat(p)).size;
      } catch {}
    }
  }
  for (const s of await mapLimit(dirs, 8, walkSize)) total += s;
  return total;
}
