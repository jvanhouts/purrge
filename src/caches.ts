/**
 * Shared package caches: npm, Bun, Gradle, Yarn, CocoaPods, Coursier, NuGet,
 * Cargo, uv and Homebrew.
 *
 * None of these live under a project root, so the tree walk never sees them,
 * and on a machine that builds for several ecosystems they quietly outgrow
 * every `node_modules` combined. They are also not junk in the way a stale
 * `.next` is: a cache is what makes the next install fast and lets it work
 * offline. Clearing one is a deliberate trade, so each finding says plainly
 * what goes — usually the whole store, because that is what the owner's own
 * command does — and nothing here pretends to age-filter individual entries.
 * A cache directory's mtime says nothing about which packages are still used.
 *
 * Locations come from the tools themselves where they will say (`npm config
 * get cache`, `yarn cache dir`, `uv cache dir`, `brew --cache`) or from the
 * environment variable each one honours, and only then the usual default.
 *
 * Sizes are what `du` allocates. pnpm-style hardlinks and APFS clones shared
 * with projects mean deleting a store can free less than it reports, so the
 * reclaim estimate is an upper bound.
 */
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { mapLimit } from "./concurrency";
import {
  canonical,
  exec,
  findRunning,
  HOME,
  lastLine,
  measure,
  measurementIssue,
  newestMtime,
  runningCommands,
  statusFor,
  type Issue,
  type StorageFinding,
  type StorageProvider,
} from "./storage";

const LIBRARY_CACHES = join(HOME, "Library", "Caches");

/** One cache store, located and described, before it is measured. */
type Store = {
  key: string;
  label: string;
  detail: string;
  paths: string[];
  cleanupActionId: string;
  reason: string;
};

// ── who is using what ────────────────────────────────────────────────────────

/**
 * The command lines that mean a store's owner is mid-run. Deleting a cache
 * under a running install corrupts the install, not just the cache, so these
 * hold the store back until the tool is done. Deliberately broad: a false
 * "running" costs a rescan, a false "idle" costs a broken install.
 */
export const OWNERS: Record<string, { tool: string; patterns: RegExp[] }> = {
  // Not `npm exec` / `npx`: MCP servers and the like run that way for days, and
  // a running npx tool lives in its own `_npx` entry, held back by path below.
  npm: { tool: "npm", patterns: [/(^|\/)npm(-cli\.js)?\s+(install|i|ci|add|update|rebuild)\b/] },
  bun: { tool: "bun", patterns: [/(^|\/)bun\s+(install|i|add|update|x|pm)\b/, /(^|\/)bunx\s/] },
  gradle: { tool: "Gradle", patterns: [/GradleDaemon/, /GradleWrapperMain/, /(^|\/)gradlew?\s/] },
  yarn: { tool: "yarn", patterns: [/(^|\/)yarn(\.js|\.cjs)?(\s|$)/, /(^|\/)yarnpkg(\s|$)/] },
  "yarn-berry": { tool: "yarn", patterns: [/(^|\/)yarn(\.js|\.cjs)?(\s|$)/, /\.yarn\/releases\/yarn-/] },
  cocoapods: { tool: "CocoaPods", patterns: [/(^|\/)pod\s+(install|update|repo|cache)\b/] },
  coursier: { tool: "Coursier", patterns: [/(^|\/)(coursier|cs)\s+(fetch|install|launch|setup)\b/, /sbt-launch/, /\bmetals\b/, /\bbloop\b/] },
  "nuget-packages": { tool: "dotnet", patterns: [/(^|\/)dotnet\s+(restore|build|run|test|publish|pack|add)\b/, /(^|\/)nuget(\.exe)?\s/] },
  "nuget-http": { tool: "dotnet", patterns: [/(^|\/)dotnet\s+(restore|build|run|test|publish|pack|add)\b/, /(^|\/)nuget(\.exe)?\s/] },
  cargo: { tool: "cargo", patterns: [/(^|\/)cargo\s+(\+\S+\s+)?(build|check|run|test|install|fetch|update|add|bench|doc|clippy)\b/] },
  uv: { tool: "uv", patterns: [/(^|\/)uv\s+(pip|sync|add|run|lock|tool|venv|python|cache)\b/, /(^|\/)uvx\s/] },
  homebrew: { tool: "Homebrew", patterns: [/(^|\/)brew(\.sh|\.rb)?\s+(install|upgrade|reinstall|fetch|bundle|cleanup)\b/] },
};

/**
 * Why a store is held back, or null. npx entries are matched by path rather
 * than by tool: one cached tool running should not hold back the other fifty.
 */
export function holdBackReason(key: string, paths: string[], commands: string[]): string | null {
  if (key.startsWith("npx:")) {
    return commands.some((c) => paths.some((p) => c.includes(p))) ? "running right now" : null;
  }
  const owner = OWNERS[key];
  if (!owner) return null;
  return findRunning(commands, owner.patterns) ? `${owner.tool} is running` : null;
}

// ── parsing ──────────────────────────────────────────────────────────────────

/** Yarn 1.x is Classic; 2+ is Berry, whose cache lives elsewhere and cleans differently. */
export function isYarnClassic(versionOutput: string): boolean {
  return /^1\.\d+/.test(versionOutput.trim());
}

/**
 * A single path printed by `npm config get cache` and friends. Empty output,
 * or npm's "undefined", means the tool had no opinion.
 */
export function parseLocation(stdout: string): string | null {
  const line = stdout.trim().split("\n").pop()?.trim();
  if (!line || line === "undefined" || line === "null" || !line.startsWith("/")) return null;
  return line;
}

/**
 * `_npx/<hash>/package.json` lists what that one-off run installed — the hash
 * means nothing to anybody, `create-vite` does.
 */
export function npxLabel(packageJson: string | null, hash: string): string {
  if (packageJson) {
    try {
      const deps = Object.keys(JSON.parse(packageJson)?.dependencies ?? {});
      if (deps.length) return `npx ${deps.join(" ")}`;
    } catch {}
  }
  return `npx ${hash.slice(0, 8)}`;
}

// ── locating ─────────────────────────────────────────────────────────────────

async function ask(cmd: string[]): Promise<{ path: string | null; missing: boolean }> {
  const r = await exec(cmd, { cwd: HOME, timeoutMs: 15_000 });
  return { path: r.ok ? parseLocation(r.stdout) : null, missing: r.missing };
}

const WHOLE = "clears the whole store — later installs redownload";

async function npmStores(issues: Issue[]): Promise<Store[]> {
  const asked = await ask(["npm", "config", "get", "cache"]);
  const root = asked.path ?? join(HOME, ".npm");
  const stores: Store[] = [{
    key: "npm",
    label: "npm content cache",
    detail: "_cacache",
    paths: [join(root, "_cacache")],
    cleanupActionId: asked.missing ? "npm-cache-remove" : "npm-cache-clean",
    reason: "clears the entire content cache — offline installs stop working, later installs redownload",
  }];
  if (asked.missing && !(await newestMtime(root))) {
    issues.push({ code: "missing-tool", message: "npm not installed" });
    return [];
  }

  const npx = join(root, "_npx");
  let entries: string[] = [];
  try {
    entries = (await readdir(npx, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {}
  for (const hash of entries) {
    const dir = join(npx, hash);
    let pkg: string | null = null;
    try { pkg = await readFile(join(dir, "package.json"), "utf8"); } catch {}
    stores.push({
      key: `npx:${hash}`,
      label: npxLabel(pkg, hash),
      detail: "npx install",
      paths: [dir],
      cleanupActionId: "npx-remove",
      reason: "temporary npx install — reinstalled on next run",
    });
  }
  return stores;
}

function bunStore(): Store {
  const dir = process.env.BUN_INSTALL_CACHE_DIR
    || join(process.env.BUN_INSTALL || join(HOME, ".bun"), "install", "cache");
  return {
    key: "bun",
    label: "Bun install cache",
    detail: "install/cache",
    paths: [dir],
    cleanupActionId: "bun-cache-rm",
    // install/global and bin are installed tools, not cache — never listed.
    reason: WHOLE,
  };
}

function gradleStore(): Store {
  return {
    key: "gradle",
    label: "Gradle caches",
    detail: "caches",
    paths: [join(process.env.GRADLE_USER_HOME || join(HOME, ".gradle"), "caches")],
    cleanupActionId: "gradle-caches-remove",
    // Only caches/: gradle.properties, init scripts and wrapper dists stay.
    reason: "dependency and transform caches — next build redownloads and re-transforms",
  };
}

async function yarnStores(issues: Issue[]): Promise<Store[]> {
  const version = await exec(["yarn", "--version"], { cwd: HOME, timeoutMs: 15_000 });
  const classic = version.ok && isYarnClassic(version.stdout);
  const reported = classic ? (await ask(["yarn", "cache", "dir"])).path : null;
  const classicDir = reported ?? join(LIBRARY_CACHES, "Yarn");
  const berryDir = join(process.env.YARN_GLOBAL_FOLDER || join(HOME, ".yarn", "berry"), "cache");

  if (version.missing && !(await newestMtime(classicDir)) && !(await newestMtime(berryDir))) {
    issues.push({ code: "missing-tool", message: "yarn not installed" });
  }
  return [
    {
      key: "yarn",
      label: "Yarn Classic cache",
      detail: "yarn 1",
      paths: [classicDir],
      cleanupActionId: classic ? "yarn-cache-clean" : "yarn-classic-cache-remove",
      reason: WHOLE,
    },
    {
      key: "yarn-berry",
      label: "Yarn Berry cache",
      detail: "yarn 2+",
      paths: [berryDir],
      cleanupActionId: "yarn-berry-cache-remove",
      reason: "global Berry cache — projects without zero-installs redownload",
    },
  ];
}

function staticStores(): Store[] {
  const cargoHome = process.env.CARGO_HOME || join(HOME, ".cargo");
  return [
    {
      key: "cocoapods",
      label: "CocoaPods download cache",
      detail: "pod cache",
      paths: [join(LIBRARY_CACHES, "CocoaPods")],
      cleanupActionId: "pod-cache-clean",
      // Project Pods/ directories are the project scan's business, not this.
      reason: "downloaded pods — next `pod install` refetches",
    },
    {
      key: "coursier",
      label: "Coursier cache",
      detail: "JVM dependencies",
      paths: [process.env.COURSIER_CACHE || join(LIBRARY_CACHES, "Coursier")],
      cleanupActionId: "coursier-cache-remove",
      reason: WHOLE,
    },
    {
      key: "nuget-packages",
      label: "NuGet global packages",
      detail: "~/.nuget/packages",
      paths: [process.env.NUGET_PACKAGES || join(HOME, ".nuget", "packages")],
      cleanupActionId: "nuget-packages-clear",
      reason: "global packages folder — next restore redownloads",
    },
    {
      key: "nuget-http",
      label: "NuGet HTTP cache",
      detail: "http-cache",
      paths: [join(HOME, ".local", "share", "NuGet", "http-cache")],
      cleanupActionId: "nuget-http-clear",
      reason: WHOLE,
    },
    {
      key: "cargo",
      label: "Cargo registry",
      detail: "registry cache + src",
      // bin/ holds installed tools and config.toml is yours; neither is listed.
      paths: [join(cargoHome, "registry", "cache"), join(cargoHome, "registry", "src")],
      cleanupActionId: "cargo-registry-remove",
      reason: "crate downloads and unpacked sources — next build refetches",
    },
  ];
}

async function uvStore(issues: Issue[]): Promise<Store[]> {
  const asked = process.env.UV_CACHE_DIR ? null : await ask(["uv", "cache", "dir"]);
  const dir = process.env.UV_CACHE_DIR || asked?.path || join(HOME, ".cache", "uv");
  if (asked?.missing && !(await newestMtime(dir))) {
    issues.push({ code: "missing-tool", message: "uv not installed" });
    return [];
  }
  return [{
    key: "uv",
    label: "uv cache",
    detail: "uv",
    paths: [dir],
    cleanupActionId: asked?.missing ? "uv-cache-remove" : "uv-cache-clean",
    // `uv cache prune` is gentler but frees little; installed tools and venvs
    // live outside the cache either way.
    reason: WHOLE,
  }];
}

async function brewStore(issues: Issue[]): Promise<Store[]> {
  const asked = await ask(["brew", "--cache"]);
  const dir = asked.path ?? join(LIBRARY_CACHES, "Homebrew");
  if (asked.missing && !(await newestMtime(dir))) {
    issues.push({ code: "missing-tool", message: "brew not installed" });
    return [];
  }
  return [{
    key: "homebrew",
    label: "Homebrew download cache",
    detail: "brew --cache",
    paths: [dir],
    // Not `brew cleanup`: that also uninstalls old versions, which is not cache.
    cleanupActionId: "brew-cache-remove",
    reason: "downloaded bottles and sources — reinstalls refetch",
  }];
}

// ── the provider ─────────────────────────────────────────────────────────────

async function scan(): Promise<{ findings: StorageFinding[]; issues: Issue[] }> {
  const issues: Issue[] = [];
  const [commands, ...groups] = await Promise.all([
    runningCommands(),
    npmStores(issues),
    Promise.resolve([bunStore(), gradleStore(), ...staticStores()]),
    yarnStores(issues),
    uvStore(issues),
    brewStore(issues),
  ]);
  const stores = groups.flat();

  // Two spellings of one directory (a symlinked cache, say) are one store.
  const seen = new Set<string>();
  const findings = await mapLimit(stores, 6, async (store): Promise<StorageFinding | null> => {
    const paths = await Promise.all(store.paths.map(canonical));
    let bytes = 0;
    let measured = false;
    let unknown = false;
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const m = await measure(path);
      if (m.missing) continue;
      measured = true;
      const issue = measurementIssue(path, m);
      if (issue) issues.push(issue);
      if (m.bytes === null) unknown = true;
      else bytes += m.bytes;
    }
    if (!measured || (!unknown && !bytes)) return null;

    const held = holdBackReason(store.key, paths, commands);
    const mtimes = await Promise.all(paths.map(newestMtime));
    const lastActivityAt = Math.max(0, ...mtimes.map((t) => t ?? 0)) || null;
    return {
      id: `caches:${store.key}`,
      provider: "caches",
      label: store.label,
      detail: store.detail,
      paths,
      allocatedBytes: unknown ? null : bytes,
      reclaimableEstimateBytes: unknown ? null : bytes,
      disposition: held || unknown ? "held-back" : "eligible",
      reason: held ?? (unknown ? "size unknown — access denied" : store.reason),
      lastActivityAt,
      cleanupActionId: store.cleanupActionId,
    };
  });

  return { findings: findings.filter((f): f is StorageFinding => f !== null), issues };
}

/** Run an owner command, turning a failure into the tool's own last word. */
async function must(cmd: string[]): Promise<void> {
  const r = await exec(cmd, { cwd: HOME, timeoutMs: 600_000 });
  if (!r.ok) throw new Error(lastLine(r.stderr || r.stdout, `${cmd.join(" ")} failed`));
}

async function removeAll(paths: string[]): Promise<void> {
  for (const path of paths) await rm(path, { recursive: true, force: true });
}

/** Empty a directory but keep it: Homebrew expects its cache dir to exist. */
async function emptyDir(dir: string): Promise<void> {
  let names: string[];
  try { names = await readdir(dir); } catch { return; }
  await mapLimit(names, 8, (name) => rm(join(dir, name), { recursive: true, force: true }));
}

async function clean(f: StorageFinding): Promise<void> {
  // The scan may be minutes old by now; an install started since still counts.
  const key = f.id.slice("caches:".length);
  const held = holdBackReason(key, f.paths, await runningCommands());
  if (held) throw new Error(held);

  switch (f.cleanupActionId) {
    case "npm-cache-clean": return must(["npm", "cache", "clean", "--force"]);
    case "bun-cache-rm": return must(["bun", "pm", "cache", "rm"]);
    case "yarn-cache-clean": return must(["yarn", "cache", "clean"]);
    case "uv-cache-clean": return must(["uv", "cache", "clean"]);
    case "pod-cache-clean": {
      if ((await exec(["pod", "cache", "clean", "--all"], { cwd: HOME, timeoutMs: 600_000 })).ok) return;
      return removeAll(f.paths);
    }
    case "nuget-packages-clear":
    case "nuget-http-clear": {
      const which = f.cleanupActionId === "nuget-packages-clear" ? "global-packages" : "http-cache";
      const r = await exec(["dotnet", "nuget", "locals", which, "--clear"], { cwd: HOME, timeoutMs: 600_000 });
      if (r.ok) return;
      return removeAll(f.paths);
    }
    case "brew-cache-remove":
      for (const path of f.paths) await emptyDir(path);
      return;
    case "npm-cache-remove":
    case "npx-remove":
    case "gradle-caches-remove":
    case "yarn-classic-cache-remove":
    case "yarn-berry-cache-remove":
    case "coursier-cache-remove":
    case "cargo-registry-remove":
    case "uv-cache-remove":
      return removeAll(f.paths);
    default:
      throw new Error(`no cleanup for ${f.label}`);
  }
}

export const cachesProvider: StorageProvider = {
  name: "caches",
  title: "package caches",
  async scan() {
    const { findings, issues } = await scan();
    return { provider: "caches", status: statusFor(findings, issues), findings, issues };
  },
  clean,
};
