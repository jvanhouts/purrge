/**
 * `purrge doctor` — why is the disk full?
 *
 * The purge commands answer a narrower question: which of the things purrge
 * knows about have gone stale. On a nearly full disk that can come back as a
 * few megabytes while a hundred gigabytes sit in places nothing looks. The
 * doctor starts from the volume instead, then accounts for what it can:
 *
 *   - what every provider found, split into eligible, held back and review-only
 *   - code roots that hold projects but are not in PROJECT_ROOTS
 *   - large locations no provider covers, with app state named as app state
 *   - large artifacts in *active* projects, which the age rule rightly hides
 *   - what could not be read, which is unknown rather than empty
 *   - whatever is left over, labelled unclassified rather than explained away
 *
 * It is read-only. The one thing it offers to change is the config, and only
 * when asked.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { contractHome, GLOBAL_CONFIG_PATH, loadConfig, readGlobalConfig, writeGlobalConfig, type Config } from "./config";
import { applyEdit } from "./config-cli";
import { mapLimit } from "./concurrency";
import { bold, dim, green, humanAge, humanBytes, pink, plural, red } from "./format";
import * as ui from "./gum";
import { appendHistory, compareScans, lastScans, readHistory, type Change, type CleanupEntry, type ScanEntry } from "./history";
import { LiveRegion, SPINNER } from "./live";
import { PROVIDERS } from "./providers";
import { findProjects, isLinkedWorktree, type Project } from "./scan";
import { isSafe as simIsSafe, scanSims, type Sim } from "./sims";
import { scanProvider } from "./stats";
import { describeIssue, statusNote } from "./storage-cli";
import {
  diskSpace,
  exec,
  HOME,
  isLowSpace,
  measure,
  statusFor,
  summarizeFindings,
  type DiskSpace,
  type FindingSummary,
  type Issue,
  type StorageFinding,
  type StorageProviderResult,
} from "./storage";
import { findWorktrees, isSafe as worktreeIsSafe, riskLabel, type Worktree } from "./worktrees";
import { ARTIFACT_DIRS, SKIP_DIRS } from "./artifacts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

// ── the report ───────────────────────────────────────────────────────────────

export type RootSuggestion = {
  /** Which config key it belongs in. */
  key: "PROJECT_ROOTS" | "WORKTREE_ROOTS";
  dir: string;
  count: number;
  bytes: number;
  staleBytes: number;
};

export type Location = {
  path: string;
  bytes: number;
  /** The part of it some provider already accounts for. */
  coveredBytes: number;
  note: string | null;
};

export type ActiveArtifact = { project: string; path: string; name: string; bytes: number; lastActivityAt: number; rebuild: string };

export type DoctorReport = {
  generatedAt: number;
  disk: (DiskSpace & { low: boolean }) | null;
  providers: (StorageProviderResult & { title: string; summary: FindingSummary })[];
  totals: FindingSummary;
  suggestions: RootSuggestion[];
  uncovered: Location[];
  /** Report-only: things that look big and are not purrge's to judge. */
  appStorage: Location[];
  largeFiles: { path: string; bytes: number }[];
  activeArtifacts: ActiveArtifact[];
  inaccessible: string[];
  accounting: {
    /** What the OS says is in use on the volume. */
    usedBytes: number | null;
    /** What the walk of your home directory and the system locations measured. */
    measuredBytes: number;
    /** The rest: other users, apps, the OS, snapshots, and whatever was unreadable. */
    unclassifiedBytes: number | null;
  };
  /** Since the previous doctor or stats scan, when there is one. */
  changes: { since: number; freeBefore: number | null; changes: Change[] } | null;
};

/**
 * Report-only notes for well-known locations. These name what a location *is*
 * so a large number is read correctly — none of them is a cleanup suggestion.
 */
const KNOWN: [string, string][] = [
  ["Pictures", "your photos — never junk"],
  ["Movies", "your files"],
  ["Music", "your files"],
  ["Downloads", "your files — worth a look, never cleaned automatically"],
  ["Desktop", "your files"],
  ["Library/Mobile Documents", "iCloud Drive"],
  ["Library/Messages", "Messages history and attachments"],
  ["Library/Containers/com.docker.docker", "Docker — see purrge docker"],
  ["Library/Application Support/Notion", "app state; its CacheStorage needs Notion closed and synced before any cleanup"],
  ["Library/Caches/com.spotify.client", "cache — may include offline downloads"],
  ["Library/Application Support/Cursor", "workspace, chat and extension state — not a cache"],
  ["Library/Application Support/Code", "workspace and extension state — not a cache"],
  ["Library/Application Support/Autodesk", "an application install, not stale updates"],
  ["Library/Application Support/Slack", "app profile; only Slack/Cache is cache"],
  ["Library/Developer/CoreSimulator", "simulators — see purrge sims"],
  ["Library/Developer/Xcode", "Xcode — see purrge xcode and purrge sims"],
  ["Library/Android", "Android SDK — see purrge tools and purrge sims"],
  [".ollama", "models — see purrge tools"],
  [".volta", "tool versions — see purrge tools"],
  [".rustup", "toolchains — see purrge tools"],
  [".npm", "package cache — see purrge caches"],
  [".bun", "package cache and global tools — see purrge caches"],
  [".gradle", "Gradle — see purrge caches"],
];

/** App storage worth naming on its own. Report-only: none of these is purrge's to delete. */
const APP_STORAGE: [string, string][] = [
  ["Library/Caches/com.spotify.client", "Spotify cache — may hold offline downloads"],
  ["Library/Application Support/Notion/Partitions/notion/Service Worker/CacheStorage", "Notion service-worker cache — close and sync Notion first"],
  ["Library/Application Support/Notion/Partitions/notion/Cache", "Notion HTTP cache"],
  ["Library/Application Support/Slack/Cache", "Slack cache — the precise cache path, not the profile"],
  ["Library/Application Support/Cursor/User/globalStorage", "Cursor global storage — chat and extension state"],
  ["Library/Application Support/Autodesk/webdeploy", "Autodesk Fusion install"],
];

const CORE_TITLES: Record<string, string> = {
  projects: "project artifacts",
  worktrees: "git worktrees",
  sims: "simulators & images",
};

/** What it costs to get an artifact back, for the active-artifact review list. */
const REBUILD: Record<string, string> = {
  target: "full Rust rebuild",
  node_modules: "reinstall",
  DerivedData: "rebuild and reindex",
  ".next": "next build",
  Pods: "pod install",
  ".gradle": "Gradle re-sync",
  ".venv": "recreate the virtualenv",
  venv: "recreate the virtualenv",
};

export async function runDoctor(config: Config, now = Date.now(), progress?: (step: string, done: boolean) => void): Promise<DoctorReport> {
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    progress?.(name, false);
    try {
      return await work();
    } finally {
      progress?.(name, true);
    }
  };

  const roots = config.PROJECT_ROOTS;
  const [disk, core, providers, suggestions, walk, largeFiles] = await Promise.all([
    diskSpace(),
    step("projects, worktrees & simulators", () => coreResults(config, now)),
    Promise.all(PROVIDERS.map((p) => step(p.title, async () => ({ title: p.title, ...(await scanProvider(p, roots, now)) })))),
    step("other code roots", () => suggestRoots(config, now)),
    step("your home directory", () => walkHome()),
    step("large files", () => findLargeFiles()),
  ]);

  const titled = core.results.map((r) => ({ ...r, title: CORE_TITLES[r.provider] ?? r.provider }));
  const all = [...titled, ...providers].map((r) => ({ ...r, summary: summarizeFindings(r.findings) }));
  const findings = all.flatMap((r) => r.findings);
  const covered = coveredPaths(findings);

  const suggested = new Set(suggestions.list.map((s) => s.dir));
  const rootNote = (path: string) =>
    suggested.has(path) ? "code root not in your config — see above"
    : roots.includes(path) ? "a project root — the rest is source and git history"
    : null;
  const uncovered = [...walk.sizes.entries()]
    .filter(([path]) => isReportedLevel(path))
    .map(([path, bytes]) => ({ path, bytes, coveredBytes: coveredUnder(path, covered), note: rootNote(path) ?? noteFor(path) }))
    .filter((l) => l.bytes - l.coveredBytes >= GiB)
    .sort((a, b) => b.bytes - b.coveredBytes - (a.bytes - a.coveredBytes))
    .slice(0, 15);

  const appStorage = (
    await mapLimit(APP_STORAGE, 4, async ([rel, note]): Promise<Location | null> => {
      const path = join(HOME, rel);
      const bytes = walk.sizes.get(path) ?? (await measure(path)).bytes;
      return bytes && bytes >= 100 * MiB ? { path, bytes, coveredBytes: 0, note } : null;
    })
  ).filter((l): l is Location => l !== null);

  const projectCutoff = now - config.PURGE_STALE_WEEKS_AMOUNT * 7 * 86_400_000;
  const activeArtifacts = largeActiveArtifacts([...core.projects, ...suggestions.projects], projectCutoff);

  const system = await step("system storage", () => measureSystem());
  const measuredBytes = walk.total + system.bytes;

  const report: DoctorReport = {
    generatedAt: now,
    disk: disk && { ...disk, low: isLowSpace(disk) },
    providers: all,
    totals: summarizeFindings(findings),
    suggestions: suggestions.list,
    uncovered: [...uncovered, ...system.locations],
    appStorage,
    largeFiles,
    activeArtifacts,
    inaccessible: walk.denied,
    accounting: {
      usedBytes: disk?.usedBytes ?? null,
      measuredBytes,
      unclassifiedBytes: disk ? Math.max(0, disk.usedBytes - measuredBytes) : null,
    },
    changes: null,
  };

  const entry = scanEntry(report, walk.sizes, walk.denied);
  const previous = lastScans(await readHistory(), "doctor").pop();
  if (previous) {
    report.changes = { since: previous.at, freeBefore: previous.disk?.freeBytes ?? null, changes: compareScans(previous, entry) };
  }
  await appendHistory(entry);
  return report;
}

// ── projects, worktrees and simulators as findings ───────────────────────────

/**
 * The three original scans, in the doctor's terms. Anything still in use is
 * held back — the doctor's totals must not count an active project's
 * `node_modules` as reclaimable just because it is large.
 */
async function coreResults(config: Config, now: number): Promise<{ results: StorageProviderResult[]; projects: Project[] }> {
  const projectCutoff = now - config.PURGE_STALE_WEEKS_AMOUNT * 7 * 86_400_000;
  const worktreeCutoff = now - config.WORKTREE_STALE_DAYS_AMOUNT * 86_400_000;
  const simCutoff = now - config.SIM_STALE_DAYS_AMOUNT * 86_400_000;

  const projectIssues: Issue[] = [];
  const [projectLists, worktrees, sims] = await Promise.all([
    Promise.all(config.PROJECT_ROOTS.map((r) => findProjects(r, undefined, (i) => projectIssues.push(i)))),
    findWorktrees(config.WORKTREE_ROOTS, undefined, config.PROJECT_ROOTS),
    scanSims(),
  ]);
  const projects = [...new Map(projectLists.flat().map((p) => [p.dir, p])).values()];

  const projectFindings = projects.map((p): StorageFinding => ({
    id: `projects:${p.dir}`,
    provider: "projects",
    label: contractHome(p.dir),
    detail: [...new Set(p.artifacts.map((a) => a.name))].join(" "),
    paths: p.artifacts.map((a) => a.path),
    allocatedBytes: p.bytes,
    reclaimableEstimateBytes: p.bytes,
    disposition: p.mtime < projectCutoff ? "eligible" : "held-back",
    reason: p.mtime < projectCutoff ? `idle ${config.PURGE_STALE_WEEKS_AMOUNT}+ weeks` : "active",
    lastActivityAt: p.mtime || null,
    cleanupActionId: "purrge",
  }));

  const worktreeFindings = worktrees.map((w: Worktree): StorageFinding => {
    const stale = w.mtime < worktreeCutoff;
    return {
      id: `worktrees:${w.dir}`,
      provider: "worktrees",
      label: contractHome(w.dir),
      detail: w.head,
      paths: [w.dir],
      allocatedBytes: w.bytes,
      reclaimableEstimateBytes: w.bytes,
      disposition: stale && worktreeIsSafe(w) ? "eligible" : "held-back",
      reason: !stale ? "active" : worktreeIsSafe(w) ? `idle ${config.WORKTREE_STALE_DAYS_AMOUNT}+ days` : riskLabel(w),
      lastActivityAt: w.mtime || null,
      cleanupActionId: "purrge worktrees",
    };
  });

  const simFindings = sims.sims.map((s: Sim): StorageFinding => {
    const stale = s.mtime < simCutoff;
    return {
      id: `sims:${s.kind}:${s.id ?? s.dir}`,
      provider: "sims",
      label: s.label,
      detail: s.detail,
      paths: s.kind === "runtime" ? [] : s.paths,
      allocatedBytes: s.bytes,
      reclaimableEstimateBytes: s.bytes,
      disposition: stale && simIsSafe(s) ? "eligible" : "held-back",
      reason: !stale ? "in use" : s.risk ?? `idle ${config.SIM_STALE_DAYS_AMOUNT}+ days`,
      lastActivityAt: s.mtime || null,
      cleanupActionId: "purrge sims",
    };
  });

  const results: StorageProviderResult[] = [
    { provider: "projects", status: statusFor(projects, projectIssues), findings: projectFindings, issues: projectIssues },
    { provider: "worktrees", status: "complete", findings: worktreeFindings, issues: [] },
    { provider: "sims", status: sims.status, findings: simFindings, issues: sims.issues },
  ];
  return { results, projects };
}

// ── root discovery ───────────────────────────────────────────────────────────

/** Never offered as a code root: the home directory's personal folders. */
const NOT_CODE = new Set(["Library", "Applications", "Movies", "Music", "Pictures", "Downloads", "Public", "Desktop", "Documents"]);

/**
 * Directories near the top of your home that hold git repositories with build
 * artifacts, but are not in PROJECT_ROOTS. The existing scanner is run on each,
 * so the numbers are the ones `purrge` would show once the root is added.
 *
 * Home itself is never suggested: `Library` is skipped on purpose, and generic
 * project rules are no way to judge arbitrary app state.
 */
async function suggestRoots(config: Config, now: number): Promise<{ list: RootSuggestion[]; projects: Project[] }> {
  const cutoff = now - config.PURGE_STALE_WEEKS_AMOUNT * 7 * 86_400_000;
  const roots = config.PROJECT_ROOTS;
  const isCovered = (dir: string) => roots.some((r) => dir === r || dir.startsWith(r + "/"));
  const containsRoot = (dir: string) => roots.some((r) => r.startsWith(dir + "/"));

  const candidates: string[] = [];
  for (const parent of [HOME, join(HOME, "Documents"), join(HOME, "Desktop")]) {
    for (const name of await subdirNames(parent)) {
      if (name.startsWith(".") || (parent === HOME && NOT_CODE.has(name))) continue;
      const dir = join(parent, name);
      if (isCovered(dir) || containsRoot(dir)) continue;
      candidates.push(dir);
    }
  }

  const repoDirs = (await mapLimit(candidates, 8, async (dir) => ((await hasRepo(dir, 3)) ? dir : null))).filter(
    (d): d is string => d !== null,
  );

  const found: Project[] = [];
  const list = (
    await mapLimit(repoDirs, 3, async (dir): Promise<RootSuggestion | null> => {
      const projects = await findProjects(dir);
      found.push(...projects);
      const bytes = projects.reduce((n, p) => n + p.bytes, 0);
      if (bytes < 100 * MiB) return null;
      const staleBytes = projects.filter((p) => p.mtime < cutoff).reduce((n, p) => n + p.bytes, 0);
      return { key: "PROJECT_ROOTS", dir, count: projects.length, bytes, staleBytes };
    })
  ).filter((s): s is RootSuggestion => s !== null);

  // Apps that manage worktrees of their own keep them under Application Support.
  const support = join(HOME, "Library", "Application Support");
  for (const app of await subdirNames(support)) {
    const dir = join(support, app, "worktrees");
    if (!existsSync(dir) || config.WORKTREE_ROOTS.includes(dir)) continue;
    const worktrees = await findWorktrees([dir]);
    const linked = (await mapLimit(worktrees, 8, async (w) => ((await isLinkedWorktree(w.dir)) ? w : null))).filter(Boolean) as Worktree[];
    if (!linked.length) continue;
    const bytes = linked.reduce((n, w) => n + w.bytes, 0);
    const staleBytes = linked
      .filter((w) => w.mtime < now - config.WORKTREE_STALE_DAYS_AMOUNT * 86_400_000)
      .reduce((n, w) => n + w.bytes, 0);
    list.push({ key: "WORKTREE_ROOTS", dir, count: linked.length, bytes, staleBytes });
  }

  return { list: list.sort((a, b) => b.bytes - a.bytes), projects: found };
}

async function hasRepo(dir: string, depth: number): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.some((e) => e.name === ".git")) return true;
  if (depth <= 0) return false;
  const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name) && !ARTIFACT_DIRS.has(e.name));
  for (const e of subdirs.slice(0, 200)) if (await hasRepo(join(dir, e.name), depth - 1)) return true;
  return false;
}

async function subdirNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Add the suggested roots to ~/.purrge/config.yml, keeping what is there. */
export async function addRoots(suggestions: RootSuggestion[]) {
  let file = await readGlobalConfig();
  for (const key of ["PROJECT_ROOTS", "WORKTREE_ROOTS"] as const) {
    const dirs = suggestions.filter((s) => s.key === key).map((s) => s.dir);
    if (!dirs.length) continue;
    file = applyEdit(file, { op: "add", key, values: dirs }, await loadConfig());
  }
  await writeGlobalConfig(file);
}

// ── the home walk ────────────────────────────────────────────────────────────

/**
 * Sizes three levels down from home, in one `du` pass — deep enough to name
 * `~/Library/Caches/<app>` and `~/Documents/<root>/<project>`. What `du` could
 * not read is collected rather than discarded: those areas are unknown, and
 * their size is not zero.
 */
async function walkHome(): Promise<{ sizes: Map<string, number>; total: number; denied: string[] }> {
  const r = await exec(["du", "-x", "-k", "-d", "3", HOME], { timeoutMs: 15 * 60_000 });
  const sizes = new Map<string, number>();
  for (const line of r.stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const kb = Number(line.slice(0, tab));
    if (Number.isFinite(kb)) sizes.set(line.slice(tab + 1), kb * 1024);
  }
  const denied = parseDuDenied(r.stderr);
  return { sizes, total: sizes.get(HOME) ?? 0, denied };
}

/** `du: /path: Operation not permitted` → `/path`, for the paths du gave up on. */
export function parseDuDenied(stderr: string): string[] {
  const out: string[] = [];
  for (const line of stderr.split("\n")) {
    const m = /^du: (.+): (Operation not permitted|Permission denied)$/.exec(line.trim());
    if (m) out.push(m[1]);
  }
  return out;
}

/** The levels worth a row: home's children, Library's, and the app folders inside it. */
function isReportedLevel(path: string): boolean {
  if (!path.startsWith(HOME + "/")) return false;
  const parts = path.slice(HOME.length + 1).split("/");
  if (parts[0] === "Library") {
    if (parts.length === 2) return !["Caches", "Application Support", "Containers", "Group Containers", "Developer"].includes(parts[1]);
    return parts.length === 3 && ["Caches", "Application Support", "Containers", "Group Containers", "Developer"].includes(parts[1]);
  }
  if (parts.length === 1) return !["Documents"].includes(parts[0]);
  // Documents is where code roots live; its children are the interesting level.
  return parts.length === 2 && parts[0] === "Documents";
}

function noteFor(path: string): string | null {
  const rel = path.slice(HOME.length + 1);
  for (const [prefix, note] of KNOWN) if (rel === prefix || rel.startsWith(prefix + "/")) return note;
  return null;
}

/**
 * Every path a provider accounts for, outermost only — a project's artifacts
 * and a cache store under the same directory must not be counted twice.
 */
export function coveredPaths(findings: StorageFinding[]): { path: string; bytes: number }[] {
  const byPath = new Map<string, number>();
  for (const f of findings) {
    if (f.allocatedBytes === null) continue;
    // A finding's bytes are spread over its paths; the first path carries them.
    if (f.paths.length) byPath.set(f.paths[0], Math.max(byPath.get(f.paths[0]) ?? 0, f.allocatedBytes));
  }
  const sorted = [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b));
  const out: { path: string; bytes: number }[] = [];
  for (const [path, bytes] of sorted) {
    const last = out[out.length - 1];
    if (last && path.startsWith(last.path + "/")) continue;
    out.push({ path, bytes });
  }
  return out;
}

export function coveredUnder(dir: string, covered: { path: string; bytes: number }[]): number {
  let n = 0;
  for (const c of covered) if (c.path === dir || c.path.startsWith(dir + "/")) n += c.bytes;
  return n;
}

/**
 * Files over a gigabyte in your own folders — a database dump, a disk image.
 * Listed by size only. Whether one is junk is not something a scanner knows.
 */
async function findLargeFiles(): Promise<{ path: string; bytes: number }[]> {
  const r = await exec(
    ["find", HOME, "-xdev", "(", "-path", join(HOME, "Library"), "-o", "-name", "node_modules", "-o", "-name", ".git", "-o", "-name", "target", ")", "-prune",
      "-o", "-type", "f", "-size", "+1G", "-print"],
    { timeoutMs: 120_000 },
  );
  const paths = r.stdout.split("\n").filter(Boolean).filter((p) => !p.endsWith("/Docker.raw"));
  const sized = await mapLimit(paths, 8, async (path) => ({ path, bytes: (await measure(path)).bytes ?? 0 }));
  return sized.sort((a, b) => b.bytes - a.bytes).slice(0, 10);
}

/**
 * System-managed storage outside home. Simulator runtime assets live in
 * AssetsV2 — the backing store behind what `purrge sims` lists, not more space
 * on top of it — so it is reported as what it is and never as a cleanup.
 */
async function measureSystem(): Promise<{ bytes: number; locations: Location[] }> {
  const places: [string, string][] = [
    ["/System/Volumes/Data/System/Library/AssetsV2", "system-managed — holds the simulator runtimes listed above (not extra space) and OS assets"],
    ["/Library/Developer/CoreSimulator", "system-managed simulator runtimes — see purrge sims"],
    ["/opt/homebrew", "installed Homebrew packages (its download cache is under purrge caches)"],
    ["/Applications", "installed applications"],
  ];
  const locations = (
    await mapLimit(places, 4, async ([path, note]): Promise<Location | null> => {
      const m = await measure(path);
      return m.bytes ? { path, bytes: m.bytes, coveredBytes: 0, note } : null;
    })
  ).filter((l): l is Location => l !== null);
  return { bytes: locations.reduce((n, l) => n + l.bytes, 0), locations: locations.filter((l) => l.bytes >= GiB) };
}

/**
 * Big artifacts in projects the age rule calls active. They are hidden from the
 * default purge list for good reason — someone is working there — but a 20 GB
 * Rust target is still worth knowing about when the disk is full.
 */
export function largeActiveArtifacts(projects: Project[], cutoff: number, min = GiB): ActiveArtifact[] {
  const seen = new Set<string>();
  const out: ActiveArtifact[] = [];
  for (const p of projects) {
    if (p.mtime < cutoff) continue;
    for (const a of p.artifacts) {
      if (a.bytes < min || seen.has(a.path)) continue;
      seen.add(a.path);
      out.push({
        project: contractHome(p.dir),
        path: a.path,
        name: a.name,
        bytes: a.bytes,
        lastActivityAt: p.mtime,
        rebuild: REBUILD[basename(a.name)] ?? "rebuild",
      });
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes).slice(0, 10);
}

// ── history ──────────────────────────────────────────────────────────────────

function scanEntry(report: DoctorReport, sizes: Map<string, number>, denied: string[]): ScanEntry {
  const scopes: ScanEntry["scopes"] = {};
  const locations: ScanEntry["locations"] = {};
  for (const r of report.providers) {
    scopes[r.provider] = { status: r.status, bytes: r.summary.bytes };
    for (const f of r.findings) {
      if ((f.allocatedBytes ?? 0) >= 100 * MiB) locations[f.id.startsWith(`${r.provider}:`) ? f.id : `${r.provider}:${f.id}`] = f.allocatedBytes!;
    }
  }
  // Each home location is its own scope: complete unless something under it
  // could not be read, so one locked folder does not void every comparison.
  for (const [path, bytes] of sizes) {
    if (!isReportedLevel(path) || bytes < 100 * MiB) continue;
    const key = `home:${path}`;
    const partial = denied.some((d) => d === path || d.startsWith(path + "/"));
    scopes[key] = { status: partial ? "partial" : "complete", bytes };
    locations[key] = bytes;
  }
  return { kind: "scan", source: "doctor", at: report.generatedAt, disk: report.disk, scopes, locations };
}

// ── printing ─────────────────────────────────────────────────────────────────

const DOCTOR_HELP = `
${bold(pink("purrge doctor"))} — why is the disk full? read-only

${bold("OPTIONS")}
  -j, --json        the whole report as JSON
      --add-roots   add the suggested code roots to ${contractHome(GLOBAL_CONFIG_PATH)} without asking
  -h, --help        this
`;

export async function runDoctorCommand(argv: string[]) {
  let json = false;
  let addRootsNow = false;
  for (const a of argv) {
    if (a === "-j" || a === "--json") json = true;
    else if (a === "--add-roots") addRootsNow = true;
    else if (a === "-h" || a === "--help") return void console.log(DOCTOR_HELP);
    else {
      console.error(`${red("✗")} unknown argument: ${a}\nrun ${bold("purrge doctor --help")}`);
      process.exit(1);
    }
  }

  const config = await loadConfig();
  const report = json ? await runDoctor(config) : await withSteps((progress) => runDoctor(config, Date.now(), progress));

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    await printReport(report);
  }

  if (!report.suggestions.length) return;
  if (addRootsNow) {
    await addRoots(report.suggestions);
    console.log(`  ${green("✓")} added ${plural(report.suggestions.length, "root")} to ${contractHome(GLOBAL_CONFIG_PATH)}`);
  } else if (!json && process.stdin.isTTY && process.stdout.isTTY) {
    if (await ui.confirm(`Add ${plural(report.suggestions.length, "suggested root")} to your config?`, "Add them", "Not now")) {
      await addRoots(report.suggestions);
      await ui.result(`Added. ${bold("purrge")} and the menu bar will look there from now on.`);
    }
  }
}

async function printReport(r: DoctorReport) {
  await ui.banner("purrge doctor", dim("read-only — nothing is deleted"));
  const pct = (n: number, of: number) => `${Math.round((n / of) * 100)}%`;

  if (r.disk) {
    const d = r.disk;
    console.log(`\n  ${bold("disk")}      ${humanBytes(d.freeBytes)} free of ${humanBytes(d.totalBytes)} ${dim(`· ${pct(d.usedBytes, d.totalBytes)} used`)}`);
    if (d.low) console.log(`  ${red("!")} ${bold("low on space")} ${dim("— the numbers below are where to start")}`);
  }

  console.log(`\n  ${bold("what purrge covers")}`);
  const nameW = Math.max(...r.providers.map((p) => p.title.length));
  for (const p of r.providers) {
    const s = p.summary;
    const status = p.status === "complete" ? "" : `  ${pink(p.status)}`;
    console.log(
      `  ${p.title.padEnd(nameW)}  ${humanBytes(s.bytes).padStart(8)}  ${green(humanBytes(s.eligibleBytes).padStart(8))} ${dim("eligible")}` +
        `  ${humanBytes(s.heldBackBytes).padStart(8)} ${dim("held back")}  ${humanBytes(s.reviewBytes).padStart(8)} ${dim("review")}${status}`,
    );
  }
  const t = r.totals;
  console.log(dim(`  ${"".padEnd(nameW)}  ${"─".repeat(8)}`));
  console.log(
    `  ${bold("total".padEnd(nameW))}  ${bold(humanBytes(t.bytes).padStart(8))}  ${bold(green(humanBytes(t.eligibleBytes).padStart(8)))} ${dim("eligible")}` +
      `  ${humanBytes(t.heldBackBytes).padStart(8)} ${dim("held back")}  ${humanBytes(t.reviewBytes).padStart(8)} ${dim("review")}`,
  );
  console.log(dim(`  rows share blocks in places (Docker layers, hardlinked stores) — totals are estimates, not a promise`));

  const troubled = r.providers.filter((p) => p.status !== "complete");
  for (const p of troubled) {
    console.log(`\n  ${pink("!")} ${bold(p.title)} ${p.status} ${dim(statusNote(p.status))}`);
    for (const i of p.issues.filter((i) => i.code !== "missing-tool").slice(0, 4)) console.log(`    ${describeIssue(i)}`);
  }

  if (r.suggestions.length) {
    console.log(`\n  ${bold("code roots purrge is not looking in")}`);
    for (const s of r.suggestions) {
      const what = s.key === "PROJECT_ROOTS" ? plural(s.count, "project") : plural(s.count, "worktree");
      console.log(`  ${contractHome(s.dir).padEnd(36)} ${humanBytes(s.bytes).padStart(8)} ${dim(`in ${what} · ${humanBytes(s.staleBytes)} stale`)}`);
    }
    const projects = r.suggestions.filter((s) => s.key === "PROJECT_ROOTS").map((s) => contractHome(s.dir));
    const worktrees = r.suggestions.filter((s) => s.key === "WORKTREE_ROOTS").map((s) => JSON.stringify(contractHome(s.dir)));
    if (projects.length) console.log(dim(`  add: purrge config add projects ${projects.join(" ")}`));
    if (worktrees.length) console.log(dim(`  add: purrge config add worktrees ${worktrees.join(" ")}`));
  }

  if (r.activeArtifacts.length) {
    console.log(`\n  ${bold("large artifacts in active projects")} ${dim("— not stale, but big; rebuilding has a cost")}`);
    for (const a of r.activeArtifacts) {
      console.log(`  ${`${a.project}/${a.name}`.padEnd(48)} ${humanBytes(a.bytes).padStart(8)} ${dim(`${humanAge(a.lastActivityAt)} · ${a.rebuild}`)}`);
    }
  }

  if (r.uncovered.length) {
    console.log(`\n  ${bold("large locations no provider covers")}`);
    for (const l of r.uncovered) {
      const covered = l.coveredBytes ? dim(` (${humanBytes(l.coveredBytes)} of it covered)`) : "";
      console.log(`  ${contractHome(l.path).padEnd(48)} ${humanBytes(l.bytes).padStart(8)}${covered}${l.note ? dim(` · ${l.note}`) : ""}`);
    }
  }

  if (r.appStorage.length) {
    console.log(`\n  ${bold("app storage")} ${dim("— report only")}`);
    for (const l of r.appStorage) console.log(`  ${contractHome(l.path).padEnd(48)} ${humanBytes(l.bytes).padStart(8)} ${dim(`· ${l.note}`)}`);
  }

  if (r.largeFiles.length) {
    console.log(`\n  ${bold("large files")} ${dim("— listed, not judged")}`);
    for (const f of r.largeFiles) console.log(`  ${contractHome(f.path).padEnd(48)} ${humanBytes(f.bytes).padStart(8)}`);
  }

  if (r.inaccessible.length) {
    console.log(`\n  ${pink("!")} ${bold(`${plural(r.inaccessible.length, "location")} could not be read`)} ${dim("— unknown, not empty")}`);
    for (const p of topLevel(r.inaccessible).slice(0, 6)) console.log(dim(`    ${contractHome(p)}`));
    if (topLevel(r.inaccessible).length > 6) console.log(dim(`    … grant Full Disk Access to your terminal to see more`));
  }

  const a = r.accounting;
  if (a.usedBytes !== null) {
    console.log(`\n  ${bold("accounting")}  ${humanBytes(a.usedBytes)} in use on the volume · ${humanBytes(a.measuredBytes)} measured`);
    console.log(dim(`  ${humanBytes(a.unclassifiedBytes ?? 0)} unclassified — the OS, other users, snapshots, and whatever could not be read`));
  }

  if (r.changes) printChanges(r.changes, r.disk);
  console.log("");
}

function printChanges(c: NonNullable<DoctorReport["changes"]>, disk: DoctorReport["disk"]) {
  console.log(`\n  ${bold("since the last scan")} ${dim(`${humanAge(c.since)} ago`)}`);
  if (c.freeBefore !== null && disk) {
    const delta = disk.freeBytes - c.freeBefore;
    console.log(`  free space ${humanBytes(c.freeBefore)} → ${humanBytes(disk.freeBytes)} ${dim(`(${delta >= 0 ? "+" : "−"}${humanBytes(Math.abs(delta))})`)}`);
  }
  const shown = c.changes.filter((x) => x.kind !== "shrank").slice(0, 8);
  for (const x of shown) {
    const sign = x.delta >= 0 ? pink(`+${humanBytes(x.delta)}`) : green(`−${humanBytes(-x.delta)}`);
    const kind = x.kind === "newly-visible" ? dim(" newly visible, not growth") : x.kind === "appeared" ? dim(" new") : "";
    console.log(`  ${sign.padEnd(20)} ${changeLabel(x.key)}${kind}`);
  }
  if (!shown.length) console.log(dim("  nothing comparable grew by more than 256 MB"));
}

function changeLabel(key: string): string {
  const at = key.indexOf(":");
  const rest = key.slice(at + 1);
  return rest.startsWith("/") ? contractHome(rest) : `${key.slice(0, at)} ${rest.replace(/^[^:]+:/, "")}`;
}

/** Outermost denied paths only — a locked folder is reported once, not per child. */
function topLevel(paths: string[]): string[] {
  const sorted = [...paths].sort();
  return sorted.filter((p, i) => !sorted.slice(0, i).some((q) => p.startsWith(q + "/")));
}

/** A checklist that ticks off as each part of the report comes in. */
async function withSteps<T>(work: (progress: (step: string, done: boolean) => void) => Promise<T>): Promise<T> {
  if (!ui.INTERACTIVE) return work(() => {});
  const region = new LiveRegion();
  const steps = new Map<string, boolean>();
  let frame = 0;
  const paint = () => {
    const spin = pink(SPINNER[frame++ % SPINNER.length]);
    region.render([
      `  ${spin} examining the disk… ${dim("sizing all of home takes a few minutes")}`,
      ...[...steps].map(([name, done]) => `    ${done ? green("✓") : dim("·")} ${done ? dim(name) : name}`),
    ]);
  };
  process.stdout.write("\x1b[?25l");
  const timer = setInterval(paint, 80);
  try {
    return await work((step, done) => steps.set(step, done));
  } finally {
    clearInterval(timer);
    region.clear();
    process.stdout.write("\x1b[?25h");
  }
}

// ── purrge history ───────────────────────────────────────────────────────────

/** `purrge history` — what grew between the last two scans, and what cleanups gave back. */
export async function runHistoryCommand(argv: string[]) {
  const entries = await readHistory();
  if (argv.includes("-j") || argv.includes("--json")) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  const scans = entries.filter((e): e is ScanEntry => e.kind === "scan");
  const cleanups = entries.filter((e): e is CleanupEntry => e.kind === "cleanup");
  if (!scans.length) {
    console.log(`\n  ${dim(`no scans yet — run ${bold("purrge doctor")} or ${bold("purrge stats")}, then again later`)}\n`);
    return;
  }

  console.log(`\n  ${bold("free space")}`);
  for (const s of scans.slice(-10)) {
    if (s.disk) console.log(`  ${new Date(s.at).toLocaleString().padEnd(24)} ${humanBytes(s.disk.freeBytes).padStart(9)} free`);
  }

  // The detailed doctor scans say more; stats totals are the fallback.
  const doctorScans = lastScans(entries, "doctor");
  const [before, after] = doctorScans.length === 2 ? doctorScans : lastScans(entries, "stats");
  if (before && after) {
    printChanges({ since: before.at, freeBefore: before.disk?.freeBytes ?? null, changes: compareScans(before, after) }, after.disk && { ...after.disk, low: isLowSpace(after.disk) });
  }

  if (cleanups.length) {
    console.log(`\n  ${bold("cleanups")} ${dim("— estimated vs what the disk actually got back")}`);
    for (const c of cleanups.slice(-10)) {
      const actual = c.freeBefore !== null && c.freeAfter !== null ? humanBytes(Math.max(0, c.freeAfter - c.freeBefore)) : "?";
      console.log(`  ${new Date(c.at).toLocaleString().padEnd(24)} ${c.provider.padEnd(10)} ~${humanBytes(c.estimatedBytes).padStart(8)} ${dim("estimated")}  ${actual.padStart(8)} ${dim("freed")}`);
    }
  }
  console.log("");
}

/** Used by `purrge stats` to log a scan no more than every few hours. */
export async function recordStatsScan(entry: ScanEntry, minIntervalMs = 6 * 3_600_000) {
  const previous = lastScans(await readHistory(), "stats").pop();
  if (previous && entry.at - previous.at < minIntervalMs) return;
  await appendHistory(entry);
}
