import { readdir, stat, lstat } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_DIRS, GATED_ARTIFACT_DIRS, NO_DESCEND, SKIP_DIRS } from "./artifacts";
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
export async function findProjects(root: string): Promise<Project[]> {
  const projects: Project[] = [];

  /** @returns newest mtime found in this subtree, artifacts excluded */
  async function walk(dir: string): Promise<number> {
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

    for (const name of gated) {
      const manifests = GATED_ARTIFACT_DIRS.get(name)!;
      if (manifests.some((m) => files.has(m))) artifactPaths.push(join(dir, name));
      else if (!NO_DESCEND.has(name)) subdirs.push(join(dir, name));
    }

    // Recurse first, so a parent's age reflects edits anywhere below it.
    const childTimes = await mapLimit(subdirs, 16, walk);
    for (const t of childTimes) if (t > newest) newest = t;

    if (artifactPaths.length) {
      const artifacts = await mapLimit(artifactPaths, 8, async (path) => ({
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        bytes: await dirSize(path),
      }));
      const bytes = artifacts.reduce((n, a) => n + a.bytes, 0);
      if (bytes > 0) {
        projects.push({ dir, artifacts, bytes, mtime: newest || (await safeMtime(dir)) });
      }
    }

    return newest;
  }

  await walk(root);
  return projects;
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
