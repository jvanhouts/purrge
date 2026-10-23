/**
 * Xcode's shared build output: DerivedData and Archives.
 *
 * `DerivedData` is already an artifact name, but Xcode keeps the real one in
 * `~/Library/Developer/Xcode`, which no project walk visits. Each child there
 * is one workspace's build products and index, named `<Name>-<hash>`, with an
 * `info.plist` saying which workspace it belongs to and when Xcode last opened
 * it. A few children — module, compilation and symbol caches — belong to no
 * workspace and are shared by all of them.
 *
 * Everything in DerivedData regenerates, at the price of a full rebuild and
 * reindex. Archives do not: an `.xcarchive` holds the build and dSYMs that
 * were shipped, which may be the only way to symbolicate a crash from that
 * release. They are listed for review, never offered up by default.
 *
 * Device support and simulator runtimes live next door but belong to
 * `purrge sims`, and are not counted here again.
 */
import { readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { contractHome, expandHome } from "./config";
import { mapLimit } from "./concurrency";
import {
  exec,
  findRunning,
  measure,
  measurementIssue,
  runningCommands,
  statusFor,
  type Issue,
  type StorageFinding,
  type StorageProvider,
} from "./storage";

const XCODE_DIR = join(homedir(), "Library", "Developer", "Xcode");
const ARCHIVES_DIR = join(XCODE_DIR, "Archives");

/** A build within this window, with a build service running, counts as in progress. */
const ACTIVE_WINDOW_MS = 30 * 60_000;
const BUILD_PROCESSES = [/(^|\/)xcodebuild(\s|$)/, /XCBBuildService/, /SWBBuildService/];

async function derivedDataRoot(): Promise<string> {
  const r = await exec(["defaults", "read", "com.apple.dt.Xcode", "IDECustomDerivedDataLocation"]);
  const custom = r.ok ? r.stdout.trim() : "";
  return custom ? expandHome(custom) : join(XCODE_DIR, "DerivedData");
}

async function plistValue(plist: string, key: string): Promise<string | null> {
  const r = await exec(["plutil", "-extract", key, "raw", "-o", "-", plist]);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

async function mtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await mtime(path)) > 0;
}

export type DerivedDataEntry = {
  dir: string;
  workspace: string | null;
  lastAccessedAt: number | null;
  /** Newest of the plist date, the build and index directories and the dir itself. */
  lastActivityAt: number;
};

/** `App-ausgzxvpmgynfvgldxgkfqsjfova` → `App`; shared caches have no hash. */
export function derivedDataName(dirName: string): { name: string; shared: boolean } {
  const m = /^(.+)-[a-z]{28}$/.exec(dirName);
  return m ? { name: m[1], shared: false } : { name: dirName.replace(/\.noindex$/, ""), shared: true };
}

/**
 * Held back while a build service runs and the entry was touched recently, or
 * whenever a running command names the directory outright.
 */
export function activeReason(entry: DerivedDataEntry, commands: string[], now: number): string | null {
  if (commands.some((c) => c.includes(entry.dir))) return "active build";
  const building = findRunning(commands, BUILD_PROCESSES) !== null;
  return building && now - entry.lastActivityAt < ACTIVE_WINDOW_MS ? "active build" : null;
}

async function readEntry(dir: string): Promise<DerivedDataEntry> {
  const plist = join(dir, "info.plist");
  const [workspace, accessed, own, build, index] = await Promise.all([
    plistValue(plist, "WorkspacePath"),
    plistValue(plist, "LastAccessedDate"),
    mtime(dir),
    mtime(join(dir, "Build", "Intermediates.noindex")),
    mtime(join(dir, "Index.noindex")),
  ]);
  const lastAccessedAt = accessed ? Date.parse(accessed) || null : null;
  return {
    dir,
    workspace,
    lastAccessedAt,
    lastActivityAt: Math.max(lastAccessedAt ?? 0, own, build, index),
  };
}

async function scanDerivedData(
  root: string,
  commands: string[],
  now: number,
  findings: StorageFinding[],
  issues: Issue[],
) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") issues.push({ path: root, code: "denied", message: "access denied" });
    return;
  }

  await mapLimit(entries.filter((e) => e.isDirectory()), 6, async (e) => {
    const dir = join(root, e.name);
    const [entry, size] = await Promise.all([readEntry(dir), measure(dir)]);
    const issue = measurementIssue(dir, size);
    if (issue) issues.push(issue);
    if (!size.bytes) return;

    const { name, shared } = derivedDataName(e.name);
    const isShared = shared || !entry.workspace;
    const gone = entry.workspace ? !(await exists(entry.workspace)) : false;
    const active = activeReason(entry, commands, now);

    findings.push({
      id: `xcode:deriveddata:${e.name}`,
      provider: "xcode",
      label: isShared ? `${name} (shared cache)` : name,
      detail: entry.workspace
        ? `${contractHome(entry.workspace)}${gone ? " · project gone" : ""}`
        : "shared by every workspace",
      paths: [dir],
      allocatedBytes: size.bytes,
      reclaimableEstimateBytes: size.bytes,
      disposition: active ? "held-back" : "eligible",
      reason: active ?? "regenerable — the next build rebuilds and reindexes from scratch",
      lastActivityAt: entry.lastActivityAt || null,
      cleanupActionId: "xcode-deriveddata-rm",
    });
  });
}

async function scanArchives(findings: StorageFinding[], issues: Issue[]) {
  let days;
  try {
    days = (await readdir(ARCHIVES_DIR, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch {
    return;
  }

  const archives: string[] = [];
  for (const day of days) {
    try {
      for (const e of await readdir(join(ARCHIVES_DIR, day.name), { withFileTypes: true })) {
        if (e.isDirectory() && e.name.endsWith(".xcarchive")) archives.push(join(ARCHIVES_DIR, day.name, e.name));
      }
    } catch {}
  }

  await mapLimit(archives, 4, async (path) => {
    const plist = join(path, "Info.plist");
    const [size, name, version, created] = await Promise.all([
      measure(path),
      plistValue(plist, "Name"),
      plistValue(plist, "ApplicationProperties.CFBundleShortVersionString"),
      plistValue(plist, "CreationDate"),
    ]);
    const issue = measurementIssue(path, size);
    if (issue) issues.push(issue);
    if (!size.bytes) return;

    findings.push({
      id: `xcode:archive:${basename(join(path, ".."))}/${basename(path)}`,
      provider: "xcode",
      label: `${name ?? basename(path, ".xcarchive")}${version ? ` ${version}` : ""}`,
      detail: `archive · ${basename(join(path, ".."))}`,
      paths: [path],
      allocatedBytes: size.bytes,
      reclaimableEstimateBytes: size.bytes,
      disposition: "review-only",
      reason: "release record — its dSYMs may be the only way to symbolicate crashes",
      lastActivityAt: (created && Date.parse(created)) || (await mtime(path)) || null,
      cleanupActionId: "xcode-archive-trash",
    });
  });
}

export const xcodeProvider: StorageProvider = {
  name: "xcode",
  title: "Xcode build output",

  async scan(ctx) {
    const findings: StorageFinding[] = [];
    const issues: Issue[] = [];
    const commands = await runningCommands();
    await Promise.all([
      scanDerivedData(await derivedDataRoot(), commands, ctx.now, findings, issues),
      scanArchives(findings, issues),
    ]);
    return { provider: "xcode", status: statusFor(findings, issues), findings, issues };
  },

  async clean(f) {
    const [path] = f.paths;
    if (!path) throw new Error(`nothing to delete for ${f.label}`);

    if (f.cleanupActionId === "xcode-deriveddata-rm") {
      // The scan may be minutes old; a build could have started since.
      const active = activeReason(await readEntry(path), await runningCommands(), Date.now());
      if (active) throw new Error(`${active} — left alone`);
      await rm(path, { recursive: true, force: true });
      return;
    }

    if (f.cleanupActionId === "xcode-archive-trash") {
      // Archives go to the Trash rather than away, so a wrong pick is recoverable.
      const trash = join(homedir(), ".Trash");
      let target = join(trash, basename(path));
      if (await exists(target)) target = join(trash, `${basename(path, ".xcarchive")} ${Date.now()}.xcarchive`);
      await rename(path, target);
      return;
    }

    throw new Error(`no xcode action for ${f.label}`);
  },
};
