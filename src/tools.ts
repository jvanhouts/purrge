/**
 * Installed tool and SDK versions: Volta's Node images, Android NDKs and build
 * tools, Rust toolchains — plus the browser downloads Playwright and Puppeteer
 * keep, and Ollama's models.
 *
 * None of these is a cache in the "throw it away, it comes back" sense. A
 * compiler version is only unused if nothing asks for it, and age proves
 * nothing: an NDK installed two years ago may be exactly what the one Android
 * project you still ship pins. So a version is held back when it is the
 * default, the newest, pinned by a project under your roots, or in use by a
 * running process; only what is left over is offered up. Ollama models are
 * listed for review only — they are what you downloaded on purpose.
 */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_DIRS, GATED_ARTIFACT_DIRS, SKIP_DIRS } from "./artifacts";
import { mapLimit } from "./concurrency";
import {
  exec,
  findRunning,
  HOME,
  lastLine,
  measure,
  measurementIssue,
  newestMtime,
  runningCommands,
  statusFor,
  type Disposition,
  type Issue,
  type ScanContext,
  type StorageFinding,
  type StorageProvider,
} from "./storage";

const PROVIDER = "tools";

// ── pure helpers ─────────────────────────────────────────────────────────────

/**
 * Compare dotted versions numerically, so `18.20.8` sorts after `18.9.0`.
 * Leading `v` and non-numeric suffixes (`-rc1`) are tolerated; a missing
 * segment counts as zero.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.\-+_]/).map((p) => Number.parseInt(p, 10));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return a.replace(/^v/, "").localeCompare(b.replace(/^v/, ""));
}

/** The newest version in each group — what a fresh install would reach for. */
export function newestPerGroup<T>(items: T[], group: (t: T) => string, version: (t: T) => string): Set<T> {
  const best = new Map<string, T>();
  for (const item of items) {
    const key = group(item);
    const current = best.get(key);
    if (!current || compareVersions(version(item), version(current)) > 0) best.set(key, item);
  }
  return new Set(best.values());
}

export type RustToolchain = { name: string; isDefault: boolean; isActive: boolean };

/** `stable-aarch64-apple-darwin (active, default)` → its name and flags. */
export function parseRustupList(text: string): RustToolchain[] {
  const out: RustToolchain[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\S+)(?:\s+\(([^)]*)\))?\s*$/.exec(line.trim());
    if (!m || m[1] === "no" || m[1].startsWith("info:")) continue;
    const flags = (m[2] ?? "").split(",").map((f) => f.trim());
    out.push({ name: m[1], isDefault: flags.includes("default"), isActive: flags.includes("active") });
  }
  return out;
}

export type OllamaModel = { name: string; id: string; bytes: number | null; modified: string };

/** Decimal sizes, the way ollama and Docker print them: `5.7 GB`, `812 MB`. */
export function parseDecimalSize(text: string): number | null {
  const m = /^([\d.]+)\s*([kmgt]?)b$/i.exec(text.trim());
  if (!m) return null;
  const mult = { "": 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[m[2].toLowerCase()]!;
  return Math.round(Number(m[1]) * mult);
}

/**
 * `ollama list` is a whitespace-aligned table whose SIZE column itself
 * contains a space, so columns are split on runs of two or more spaces.
 */
export function parseOllamaList(text: string): OllamaModel[] {
  const out: OllamaModel[] = [];
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 3 || !cols[0]) continue;
    out.push({ name: cols[0], id: cols[1], bytes: parseDecimalSize(cols[2]), modified: cols[3] ?? "" });
  }
  return out;
}

export type BrowserDir = { browser: string; revision: string };

/** `chromium_headless_shell-1234` → `chromium_headless_shell` at revision `1234`. */
export function parsePlaywrightDir(name: string): BrowserDir | null {
  const m = /^([a-z][a-z0-9_]*)-(\d+)$/i.exec(name);
  return m ? { browser: m[1], revision: m[2] } : null;
}

/**
 * Puppeteer's `<platform>-<buildId>`. The platform is part of the group: the
 * old `mac-1108766` and the new `mac_arm-153.0.8010.36` number their builds
 * differently and must not be compared with one another.
 */
export function parsePuppeteerDir(name: string): { platform: string; buildId: string } | null {
  const m = /^([a-z0-9_]+)-(.+)$/i.exec(name);
  return m ? { platform: m[1], buildId: m[2] } : null;
}

export type VoltaPins = Partial<Record<"node" | "npm" | "yarn" | "pnpm", string>>;

/** The `volta` block of a package.json, if it has one. */
export function voltaPins(packageJson: string): VoltaPins {
  try {
    const volta = (JSON.parse(packageJson) as { volta?: Record<string, unknown> }).volta;
    if (!volta || typeof volta !== "object") return {};
    const out: VoltaPins = {};
    for (const tool of ["node", "npm", "yarn", "pnpm"] as const) {
      if (typeof volta[tool] === "string") out[tool] = (volta[tool] as string).trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * `.nvmrc` / `.node-version` hold anything from `lts/iron` to `20`. Only an
 * exact `x.y.z` names an installed image unambiguously; the rest pin nothing.
 */
export function exactNodeVersion(text: string): string | null {
  const m = /^v?(\d+\.\d+\.\d+)\s*$/.exec(text.trim());
  return m ? m[1] : null;
}

/** `ndkVersion "27.0.12077973"`, `ndkVersion = "…"`, and `buildToolsVersion` likewise. */
export function gradlePins(text: string): { ndk: string[]; buildTools: string[] } {
  const grab = (key: string) =>
    [...text.matchAll(new RegExp(`\\b${key}\\s*(?:=\\s*)?\\(?\\s*["']([^"']+)["']`, "g"))].map((m) => m[1]);
  return { ndk: grab("ndkVersion"), buildTools: grab("buildToolsVersion") };
}

/**
 * The channel a `rust-toolchain` (bare channel name) or `rust-toolchain.toml`
 * (`[toolchain] channel = "…"`) asks for.
 */
export function rustToolchainPin(text: string): string | null {
  const toml = /^\s*channel\s*=\s*["']([^"']+)["']/m.exec(text);
  if (toml) return toml[1];
  const bare = text.trim();
  return bare && !bare.includes("\n") && !bare.includes("=") && !bare.startsWith("[") ? bare : null;
}

/**
 * Does an installed toolchain satisfy a pin? rustup names toolchains with the
 * host triple appended, so `stable` pins `stable-aarch64-apple-darwin`.
 */
export function toolchainMatches(installed: string, pin: string): boolean {
  return installed === pin || installed.startsWith(`${pin}-`);
}

// ── pins under the project roots ─────────────────────────────────────────────

export type Pins = {
  /** `node@20.19.5` → number of projects pinning it. */
  volta: Map<string, number>;
  ndk: Map<string, number>;
  buildTools: Map<string, number>;
  rust: Map<string, number>;
};

const PIN_FILES = new Set([
  "package.json", ".nvmrc", ".node-version",
  "build.gradle", "build.gradle.kts",
  "rust-toolchain", "rust-toolchain.toml",
]);

/**
 * One bounded walk over the project roots, reading only the handful of files
 * that pin a tool version. Dependency trees are skipped: a pin inside
 * `node_modules` belongs to someone else's project.
 */
export async function findPins(roots: string[], maxDepth = 6): Promise<Pins> {
  const pins: Pins = { volta: new Map(), ndk: new Map(), buildTools: new Map(), rust: new Map() };
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const seen = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (seen.has(dir)) return;
    seen.add(dir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs: string[] = [];
    // A project pins a version once, however many of its files say so.
    const projectVolta = new Set<string>();
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name) && !ARTIFACT_DIRS.has(e.name) && !GATED_ARTIFACT_DIRS.has(e.name)) {
          subdirs.push(join(dir, e.name));
        }
        continue;
      }
      if (!e.isFile() || !PIN_FILES.has(e.name)) continue;
      let text: string;
      try {
        text = await readFile(join(dir, e.name), "utf8");
      } catch {
        continue;
      }
      if (e.name === "package.json") {
        for (const [tool, version] of Object.entries(voltaPins(text))) projectVolta.add(`${tool}@${version}`);
      } else if (e.name === ".nvmrc" || e.name === ".node-version") {
        const v = exactNodeVersion(text);
        if (v) projectVolta.add(`node@${v}`);
      } else if (e.name.startsWith("build.gradle")) {
        const g = gradlePins(text);
        for (const v of g.ndk) bump(pins.ndk, v);
        for (const v of g.buildTools) bump(pins.buildTools, v);
      } else {
        const channel = rustToolchainPin(text);
        if (channel) bump(pins.rust, channel);
      }
    }
    for (const key of projectVolta) bump(pins.volta, key);
    await mapLimit(subdirs, 16, (d) => walk(d, depth + 1));
  }

  await Promise.all(roots.map((r) => walk(r, 0)));
  return pins;
}

// ── scanning ─────────────────────────────────────────────────────────────────

const voltaHome = () => process.env.VOLTA_HOME || join(HOME, ".volta");
const rustupHome = () => process.env.RUSTUP_HOME || join(HOME, ".rustup");
const ollamaModels = () => process.env.OLLAMA_MODELS || join(HOME, ".ollama", "models");
const playwrightHome = () =>
  process.env.PLAYWRIGHT_BROWSERS_PATH ||
  (process.platform === "darwin" ? join(HOME, "Library", "Caches", "ms-playwright") : join(HOME, ".cache", "ms-playwright"));
const puppeteerHome = () => process.env.PUPPETEER_CACHE_DIR || join(HOME, ".cache", "puppeteer");

function sdkRoot(): string {
  return (
    process.env.ANDROID_SDK_ROOT ||
    process.env.ANDROID_HOME ||
    (process.platform === "darwin" ? join(HOME, "Library", "Android", "sdk") : join(HOME, "Android", "Sdk"))
  );
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A candidate before it is measured: everything but the bytes. */
type Candidate = Omit<StorageFinding, "provider" | "allocatedBytes" | "reclaimableEstimateBytes" | "lastActivityAt">;

type Held = { disposition: Disposition; reason: string };

/** First reason to keep it wins; with none, it is eligible for `fallback`. */
function decide(reasons: (string | null | false | undefined)[], fallback: string): Held {
  const reason = reasons.find((r): r is string => Boolean(r));
  return reason ? { disposition: "held-back", reason } : { disposition: "eligible", reason: fallback };
}

const pinnedBy = (n: number | undefined) => (n ? `pinned by ${n} project${n === 1 ? "" : "s"}` : null);

async function voltaCandidates(pins: Pins, running: string[], issues: Issue[]): Promise<Candidate[]> {
  const home = voltaHome();
  const imageRoot = join(home, "tools", "image");
  if (!(await exists(imageRoot))) return [];

  let platform: Record<string, unknown> = {};
  try {
    platform = JSON.parse(await readFile(join(home, "tools", "user", "platform.json"), "utf8"));
  } catch {
    issues.push({ path: join(home, "tools", "user", "platform.json"), code: "tool-failed", message: "Volta default unreadable — every version treated as possibly default" });
    platform = { unknown: true };
  }
  const defaults: Record<string, string | null> = {
    node: (platform.node as { runtime?: string } | undefined)?.runtime ?? null,
    npm: (platform.node as { npm?: string | null } | undefined)?.npm ?? null,
    yarn: typeof platform.yarn === "string" ? platform.yarn : null,
    pnpm: typeof platform.pnpm === "string" ? platform.pnpm : null,
  };
  const defaultUnknown = "unknown" in platform;

  const out: Candidate[] = [];
  for (const tool of ["node", "npm", "yarn", "pnpm"]) {
    for (const version of await subdirs(join(imageRoot, tool))) {
      const dir = join(imageRoot, tool, version);
      const held = decide(
        [
          defaultUnknown && "default unknown",
          defaults[tool] === version && "default",
          pinnedBy(pins.volta.get(`${tool}@${version}`)),
          findRunning(running, [new RegExp(escapeRegExp(dir))]) && "in use",
        ],
        "not default, not pinned under your project roots",
      );
      out.push({
        id: `${PROVIDER}:volta:${tool}@${version}`,
        label: `${tool} ${version}`,
        detail: "volta image",
        paths: [dir],
        ...held,
        cleanupActionId: "volta-image-rm",
      });
    }
  }

  // Downloads, not installs: the tarballs Volta unpacked images from.
  const inventory = join(home, "tools", "inventory");
  for (const tool of await subdirs(inventory)) {
    let files: string[];
    try {
      files = (await readdir(join(inventory, tool))).map((f) => join(inventory, tool, f));
    } catch {
      continue;
    }
    if (!files.length) continue;
    out.push({
      id: `${PROVIDER}:volta-inventory:${tool}`,
      label: `${tool} downloads`,
      detail: `volta inventory · ${files.length} file${files.length === 1 ? "" : "s"}`,
      paths: files,
      disposition: "eligible",
      reason: "downloads only; Volta re-fetches on demand",
      cleanupActionId: "volta-inventory-rm",
    });
  }
  return out;
}

async function androidCandidates(pins: Pins): Promise<Candidate[]> {
  const sdk = sdkRoot();
  const out: Candidate[] = [];
  for (const [kind, folder, pinMap, label] of [
    ["ndk", "ndk", pins.ndk, "NDK"],
    ["build-tools", "build-tools", pins.buildTools, "build tools"],
  ] as const) {
    const versions = await subdirs(join(sdk, folder));
    const newest = newestPerGroup(versions, () => kind, (v) => v);
    for (const version of versions) {
      const held = decide(
        [newest.has(version) && "newest installed", pinnedBy(pinMap.get(version))],
        "not newest, not pinned under your project roots",
      );
      out.push({
        id: `${PROVIDER}:${kind}:${version}`,
        label: `${label} ${version}`,
        detail: "android sdk",
        paths: [join(sdk, folder, version)],
        ...held,
        cleanupActionId: "android-sdk-uninstall",
      });
    }
  }
  return out;
}

async function rustCandidates(pins: Pins, issues: Issue[]): Promise<Candidate[]> {
  const root = join(rustupHome(), "toolchains");
  const dirs = await subdirs(root);
  if (!dirs.length) return [];

  const listed = await exec(["rustup", "toolchain", "list"]);
  let toolchains: RustToolchain[];
  if (listed.ok) {
    toolchains = parseRustupList(listed.stdout);
  } else {
    // Without rustup's word on which one is default, none can be offered up.
    issues.push({ code: listed.missing ? "missing-tool" : "tool-failed", message: `rustup: ${lastLine(listed.stderr, "toolchain list failed")} — toolchains held back` });
    toolchains = dirs.map((name) => ({ name, isDefault: true, isActive: false }));
  }

  const pinList = [...pins.rust.entries()];
  return toolchains
    .filter((t) => dirs.includes(t.name))
    .map((t) => {
      const pinCount = pinList.filter(([pin]) => toolchainMatches(t.name, pin)).reduce((n, [, c]) => n + c, 0);
      const held = decide(
        [
          !listed.ok && "default unknown",
          listed.ok && t.isDefault && "default",
          t.isActive && "active",
          pinnedBy(pinCount),
        ],
        "not default, not pinned under your project roots",
      );
      return {
        id: `${PROVIDER}:rust:${t.name}`,
        label: t.name,
        detail: "rust toolchain",
        paths: [join(root, t.name)],
        ...held,
        cleanupActionId: "rustup-uninstall",
      };
    });
}

/** Ollama sizes its own models; they are reported as it reports them. */
async function ollamaFindings(issues: Issue[]): Promise<StorageFinding[]> {
  const dir = ollamaModels();
  const hasDir = await exists(dir);
  const listed = await exec(["ollama", "list"], { timeoutMs: 15_000 });

  if (listed.ok) {
    return parseOllamaList(listed.stdout).map((m) => ({
      id: `${PROVIDER}:ollama:${m.name}`,
      provider: PROVIDER,
      label: m.name,
      detail: `ollama model${m.modified ? ` · ${m.modified}` : ""}`,
      paths: hasDir ? [dir] : [],
      allocatedBytes: m.bytes,
      reclaimableEstimateBytes: m.bytes,
      disposition: "review-only",
      reason: "model storage, not cache — remove only the ones you choose",
      lastActivityAt: null,
      cleanupActionId: "ollama-rm",
    }));
  }
  if (!hasDir) return []; // no ollama, no models — nothing to say

  // The daemon may simply not be running. The directory still has a size.
  issues.push({ path: dir, code: listed.missing ? "missing-tool" : "unavailable", message: `ollama list: ${lastLine(listed.stderr, "failed")} — models shown as one total` });
  const m = await measure(dir);
  const issue = measurementIssue(dir, m);
  if (issue) issues.push(issue);
  return [{
    id: `${PROVIDER}:ollama:models`,
    provider: PROVIDER,
    label: "ollama models",
    detail: "model storage",
    paths: [dir],
    allocatedBytes: m.bytes,
    reclaimableEstimateBytes: null,
    disposition: "review-only",
    reason: "model storage, not cache — start ollama to pick models individually",
    lastActivityAt: await newestMtime(dir),
  }];
}

async function browserCandidates(): Promise<Candidate[]> {
  const out: Candidate[] = [];

  const pw = playwrightHome();
  const pwDirs = (await subdirs(pw))
    .map((name) => ({ name, parsed: parsePlaywrightDir(name) }))
    .filter((d): d is { name: string; parsed: BrowserDir } => d.parsed !== null);
  const pwNewest = newestPerGroup(pwDirs, (d) => d.parsed.browser, (d) => d.parsed.revision);
  for (const d of pwDirs) {
    out.push({
      id: `${PROVIDER}:playwright:${d.name}`,
      label: `${d.parsed.browser} ${d.parsed.revision}`,
      detail: "playwright browser",
      paths: [join(pw, d.name)],
      ...decide([pwNewest.has(d) && "newest — what current installs use"], "older revision; reinstalled on demand"),
      cleanupActionId: "browser-rm",
    });
  }

  const pp = puppeteerHome();
  for (const browser of await subdirs(pp)) {
    const builds = (await subdirs(join(pp, browser)))
      .map((name) => ({ name, parsed: parsePuppeteerDir(name) }))
      .filter((d): d is { name: string; parsed: { platform: string; buildId: string } } => d.parsed !== null);
    const newest = newestPerGroup(builds, (d) => d.parsed.platform, (d) => d.parsed.buildId);
    for (const d of builds) {
      out.push({
        id: `${PROVIDER}:puppeteer:${browser}/${d.name}`,
        label: `${browser} ${d.parsed.buildId}`,
        detail: `puppeteer browser · ${d.parsed.platform}`,
        paths: [join(pp, browser, d.name)],
        ...decide([newest.has(d) && "newest — what current installs use"], "older build; reinstalled on demand"),
        cleanupActionId: "browser-rm",
      });
    }
  }
  return out;
}

async function scan(ctx: ScanContext): Promise<{ provider: string; status: ReturnType<typeof statusFor>; findings: StorageFinding[]; issues: Issue[] }> {
  const issues: Issue[] = [];
  const [pins, running] = await Promise.all([findPins(ctx.projectRoots), runningCommands()]);

  const [volta, android, rust, browsers, ollama] = await Promise.all([
    voltaCandidates(pins, running, issues),
    androidCandidates(pins),
    rustCandidates(pins, issues),
    browserCandidates(),
    ollamaFindings(issues),
  ]);

  const measured = await mapLimit([...volta, ...android, ...rust, ...browsers], 6, async (c): Promise<StorageFinding | null> => {
    const sizes = await mapLimit(c.paths, 4, async (p) => {
      const m = await measure(p);
      const issue = measurementIssue(p, m);
      if (issue) issues.push(issue);
      return m.bytes;
    });
    if (sizes.every((b) => b === null)) return null; // vanished between listing and sizing
    const bytes = sizes.reduce<number>((n, b) => n + (b ?? 0), 0);
    if (!bytes) return null;
    const times = (await Promise.all(c.paths.slice(0, 50).map(newestMtime))).filter((t): t is number => t !== null);
    return {
      ...c,
      provider: PROVIDER,
      allocatedBytes: bytes,
      reclaimableEstimateBytes: bytes,
      lastActivityAt: times.length ? Math.max(...times) : null,
    };
  });

  const findings = [...measured.filter((f): f is StorageFinding => f !== null), ...ollama];
  return { provider: PROVIDER, status: statusFor(findings, issues), findings, issues };
}

// ── cleanup ──────────────────────────────────────────────────────────────────

async function removePaths(f: StorageFinding) {
  if (!f.paths.length) throw new Error(`nothing to delete for ${f.label}`);
  for (const p of f.paths) await rm(p, { recursive: true, force: true });
}

/** `tools:ndk:27.0.12077973` → `ndk;27.0.12077973`, sdkmanager's package path. */
function sdkPackage(f: StorageFinding): string {
  const [, kind, version] = f.id.split(":");
  return `${kind};${version}`;
}

async function clean(f: StorageFinding): Promise<void> {
  switch (f.cleanupActionId) {
    case "volta-image-rm":
    case "volta-inventory-rm":
    case "browser-rm":
      // Volta has no uninstall for runtimes, and the browser caches are plain
      // directories the installers re-create; removing them is the owner route.
      return removePaths(f);
    case "android-sdk-uninstall": {
      // sdkmanager keeps package.xml bookkeeping straight; the directory is the fallback.
      for (const bin of ["sdkmanager", join(sdkRoot(), "cmdline-tools", "latest", "bin", "sdkmanager")]) {
        if ((await exec([bin, "--uninstall", sdkPackage(f)], { timeoutMs: 300_000 })).ok) return;
      }
      return removePaths(f);
    }
    case "rustup-uninstall": {
      const name = f.id.slice(`${PROVIDER}:rust:`.length);
      const r = await exec(["rustup", "toolchain", "uninstall", name], { timeoutMs: 300_000 });
      if (!r.ok) throw new Error(lastLine(r.stderr, "rustup toolchain uninstall failed"));
      return;
    }
    case "ollama-rm": {
      const name = f.id.slice(`${PROVIDER}:ollama:`.length);
      const r = await exec(["ollama", "rm", name], { timeoutMs: 60_000 });
      if (!r.ok) throw new Error(lastLine(r.stderr, "ollama rm failed"));
      return;
    }
    default:
      throw new Error(`${f.label} has no cleanup action`);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const toolsProvider: StorageProvider = {
  name: PROVIDER,
  title: "tool & SDK versions",
  scan,
  clean,
};
