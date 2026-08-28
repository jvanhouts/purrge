/**
 * iOS simulators and Android emulators, plus the images they are cut from.
 *
 * None of this lives inside a project, so the tree walk never sees it: the
 * devices sit under `~/Library/Developer`, the runtimes under `/Library`, the
 * AVDs under `~/.android`. It is also the biggest single pile on most machines
 * that build for phones — a couple of stale runtimes outweigh every
 * `node_modules` you own.
 *
 * The inventory comes from tooling rather than from guessing at directory
 * names, and removal goes back through that same tooling wherever it exists,
 * so CoreSimulator's own bookkeeping stays honest instead of being left
 * pointing at a directory that is no longer there.
 */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mapLimit } from "./concurrency";
import { dirSize } from "./scan";
import type { Project } from "./scan";

export type SimKind = "sim" | "runtime" | "devicesupport" | "avd" | "sysimage";

export type Sim = Project & {
  kind: SimKind;
  /** What to print instead of a path — "iPhone 17 Pro" beats a UDID. */
  label: string;
  /** Runtime, API level or device model, for the trailing column. */
  detail: string;
  /** UDID or AVD name, for the kinds removed through their own tooling. */
  id: string | null;
  /** Everything to delete if the tooling is unavailable or refuses. */
  paths: string[];
  /** Why this one is held back, or null when it is free to go. */
  risk: string | null;
};

/** Held back unless `--force`: something else is still relying on it. */
export function isSafe(s: Sim): boolean {
  return s.risk === null;
}

const HOME = homedir();
const XCODE_DIR = join(HOME, "Library", "Developer", "Xcode");

/**
 * Every simulator, runtime, device support bundle, AVD and system image on the
 * machine, sized. The five collectors are independent, so they run together.
 */
export async function findSims(onSim?: (s: Sim) => void): Promise<Sim[]> {
  const found: Sim[] = [];
  const emit = (s: Sim) => {
    found.push(s);
    onSim?.(s);
  };

  const devices = await listDevices();
  await Promise.all([
    collectDevices(devices, emit),
    collectRuntimes(devices, emit),
    collectDeviceSupport(emit),
    collectAvds(emit),
    collectSystemImages(emit),
  ]);

  return found;
}

// ── iOS simulators ───────────────────────────────────────────────────────────

type Device = {
  udid: string;
  name: string;
  /** The `com.apple.CoreSimulator.SimRuntime.iOS-26-5` key it was listed under. */
  runtimeId: string;
  state: string;
  isAvailable: boolean;
  dataPath: string;
  logPath: string;
  logPathSize: number;
  lastBootedAt: string | null;
};

/** Flatten simctl's runtime-keyed device map into a plain list. */
export function parseDevices(json: unknown): Device[] {
  const groups = (json as { devices?: Record<string, unknown[]> } | null)?.devices;
  if (!groups || typeof groups !== "object") return [];

  const out: Device[] = [];
  for (const [runtimeId, list] of Object.entries(groups)) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const d = raw as Record<string, unknown>;
      if (typeof d.udid !== "string" || typeof d.dataPath !== "string") continue;
      out.push({
        udid: d.udid,
        name: typeof d.name === "string" ? d.name : d.udid,
        runtimeId,
        state: typeof d.state === "string" ? d.state : "Unknown",
        // Absent means available: only unavailable devices carry the flag reliably.
        isAvailable: d.isAvailable !== false,
        dataPath: d.dataPath,
        logPath: typeof d.logPath === "string" ? d.logPath : "",
        logPathSize: typeof d.logPathSize === "number" ? d.logPathSize : 0,
        lastBootedAt: typeof d.lastBootedAt === "string" ? d.lastBootedAt : null,
      });
    }
  }
  return out;
}

async function listDevices(): Promise<Device[]> {
  const out = await xcrun(["simctl", "list", "devices", "--json"]);
  return out ? parseDevices(safeJson(out)) : [];
}

async function collectDevices(devices: Device[], emit: (s: Sim) => void): Promise<void> {
  await mapLimit(devices, 8, async (d) => {
    // dataPath is `<device>/data`; the whole device directory is what goes.
    const dir = dirname(d.dataPath);
    const bytes = (await dirSize(dir)) + d.logPathSize;
    if (!bytes) return;

    const paths = [dir];
    if (d.logPath) paths.push(d.logPath);

    emit({
      kind: "sim",
      dir,
      label: d.name,
      detail: d.isAvailable ? runtimeName(d.runtimeId) : `${runtimeName(d.runtimeId)} unavailable`,
      id: d.udid,
      paths,
      // A booted simulator is in use, and simctl will refuse to delete it.
      risk: d.state === "Booted" ? "booted" : null,
      artifacts: [{ path: dir, name: d.name, bytes }],
      bytes,
      mtime: d.lastBootedAt ? Date.parse(d.lastBootedAt) || 0 : await safeMtime(dir),
    });
  });
}

// ── iOS simulator runtimes ───────────────────────────────────────────────────

type Runtime = {
  id: string;
  runtimeId: string;
  version: string;
  bytes: number;
  lastUsedAt: string | null;
  deletable: boolean;
  /** Where the image is mounted, for display — deletion goes by identifier. */
  path: string;
};

export function parseRuntimes(json: unknown): Runtime[] {
  if (!json || typeof json !== "object") return [];

  const out: Runtime[] = [];
  for (const [id, raw] of Object.entries(json as Record<string, unknown>)) {
    const r = raw as Record<string, unknown>;
    if (typeof r?.runtimeIdentifier !== "string") continue;
    out.push({
      id,
      runtimeId: r.runtimeIdentifier,
      version: typeof r.version === "string" ? r.version : "",
      bytes: typeof r.sizeBytes === "number" ? r.sizeBytes : 0,
      lastUsedAt: typeof r.lastUsedAt === "string" ? r.lastUsedAt : null,
      path: typeof r.runtimeBundlePath === "string" ? r.runtimeBundlePath : "",
      // Runtimes shipped inside Xcode itself report false, and cannot go.
      deletable: r.deletable === true,
    });
  }
  return out;
}

async function collectRuntimes(devices: Device[], emit: (s: Sim) => void): Promise<void> {
  const out = await xcrun(["simctl", "runtime", "list", "--json"]);
  if (!out) return;

  for (const r of parseRuntimes(safeJson(out))) {
    if (!r.deletable || !r.bytes) continue;

    // Deleting a runtime does not delete the simulators cut from it — it leaves
    // them behind as unavailable. Say so rather than quietly breaking them.
    const users = devices.filter((d) => d.runtimeId === r.runtimeId).length;

    emit({
      kind: "runtime",
      dir: r.path || r.id,
      label: `${runtimeName(r.runtimeId)} runtime`,
      detail: r.version ? `runtime ${r.version}` : "runtime",
      id: r.id,
      paths: [],
      risk: users ? `used by ${users} sim${users === 1 ? "" : "s"}` : null,
      artifacts: [{ path: r.path || r.id, name: "runtime", bytes: r.bytes }],
      bytes: r.bytes,
      // No lastUsedAt means it was downloaded and never booted once.
      mtime: r.lastUsedAt ? Date.parse(r.lastUsedAt) || 0 : 0,
    });
  }
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-5` → `iOS 26.5`. */
export function runtimeName(runtimeId: string): string {
  const tail = runtimeId.split(".").pop() ?? runtimeId;
  const m = /^([A-Za-z]+)-(.+)$/.exec(tail);
  return m ? `${m[1]} ${m[2].replace(/-/g, ".")}` : tail;
}

// ── Xcode device support ─────────────────────────────────────────────────────

/**
 * `~/Library/Developer/Xcode/iOS DeviceSupport/<model> <version> (<build>)` —
 * symbols copied off a physical device the first time you plug it in on a given
 * OS build, and re-copied automatically if they are missing. One per OS update
 * per device, kept forever, a couple of gigabytes each.
 */
async function collectDeviceSupport(emit: (s: Sim) => void): Promise<void> {
  let platforms;
  try {
    platforms = await readdir(XCODE_DIR, { withFileTypes: true });
  } catch {
    return;
  }

  const roots = platforms
    .filter((e) => e.isDirectory() && e.name.endsWith(" DeviceSupport"))
    .map((e) => ({ platform: e.name.replace(" DeviceSupport", ""), path: join(XCODE_DIR, e.name) }));

  await mapLimit(roots, 4, async (root) => {
    let entries;
    try {
      entries = await readdir(root.path, { withFileTypes: true });
    } catch {
      return;
    }

    await mapLimit(entries.filter((e) => e.isDirectory()), 6, async (e) => {
      const dir = join(root.path, e.name);
      const bytes = await dirSize(dir);
      if (!bytes) return;
      emit({
        kind: "devicesupport",
        dir,
        label: e.name,
        detail: `${root.platform} device support`,
        id: null,
        paths: [dir],
        risk: null,
        artifacts: [{ path: dir, name: e.name, bytes }],
        bytes,
        mtime: await safeMtime(dir),
      });
    });
  });
}

// ── Android emulators ────────────────────────────────────────────────────────

function avdHome(): string {
  return process.env.ANDROID_AVD_HOME || join(HOME, ".android", "avd");
}

function sdkRoot(): string {
  return (
    process.env.ANDROID_SDK_ROOT ||
    process.env.ANDROID_HOME ||
    (process.platform === "darwin" ? join(HOME, "Library", "Android", "sdk") : join(HOME, "Android", "Sdk"))
  );
}

/** `key = value` lines, which is all an `.ini` under `~/.android/avd` ever is. */
export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at < 1) continue;
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
}

/**
 * An AVD is a `<name>.avd` directory plus a sibling `.ini` pointing at it. The
 * two names need not match — the pointer is named after the AVD, the directory
 * after whatever it was called when it was created — so the pointers are read
 * rather than assumed, and a directory nothing points at is still listed.
 */
async function collectAvds(emit: (s: Sim) => void): Promise<void> {
  const home = avdHome();
  let entries;
  try {
    entries = await readdir(home, { withFileTypes: true });
  } catch {
    return;
  }

  /** `<avd directory> → <name, pointer file>` */
  const pointers = new Map<string, { name: string; ini: string }>();
  await mapLimit(entries.filter((e) => e.isFile() && e.name.endsWith(".ini")), 8, async (e) => {
    const ini = join(home, e.name);
    try {
      const path = parseIni(await readFile(ini, "utf8")).path;
      if (path) pointers.set(path, { name: e.name.slice(0, -4), ini });
    } catch {}
  });

  const dirs = entries.filter((e) => e.isDirectory() && e.name.endsWith(".avd"));
  await mapLimit(dirs, 4, async (e) => {
    const dir = join(home, e.name);
    const bytes = await dirSize(dir);
    if (!bytes) return;

    const pointer = pointers.get(dir);
    const config = await readIni(join(dir, "config.ini"));

    emit({
      kind: "avd",
      dir,
      label: config["avd.ini.displayname"] || pointer?.name || e.name.slice(0, -4),
      detail: `avd ${config["image.sysdir.1"]?.split("/")[1] ?? config["hw.device.name"] ?? ""}`.trim(),
      id: pointer?.name ?? null,
      paths: pointer ? [dir, pointer.ini] : [dir],
      risk: null,
      artifacts: [{ path: dir, name: e.name, bytes }],
      bytes,
      mtime: await safeMtime(dir),
    });
  });
}

/**
 * `<sdk>/system-images/<api>/<tag>/<abi>` — the disk image an AVD is cut from,
 * shared by every AVD that names it. Deleting one out from under a live AVD
 * leaves an emulator that cannot boot, so images still referenced are held back.
 */
async function collectSystemImages(emit: (s: Sim) => void): Promise<void> {
  const root = join(sdkRoot(), "system-images");
  const inUse = await referencedSystemImages();

  const images: { dir: string; api: string; tag: string; abi: string }[] = [];
  for (const api of await subdirs(root)) {
    for (const tag of await subdirs(join(root, api))) {
      for (const abi of await subdirs(join(root, api, tag))) {
        images.push({ dir: join(root, api, tag, abi), api, tag, abi });
      }
    }
  }

  await mapLimit(images, 4, async (img) => {
    const bytes = await dirSize(img.dir);
    if (!bytes) return;
    const users = inUse.get(`system-images/${img.api}/${img.tag}/${img.abi}`) ?? 0;
    emit({
      kind: "sysimage",
      dir: img.dir,
      label: `${img.api} ${img.tag} ${img.abi}`,
      detail: "system image",
      id: null,
      paths: [img.dir],
      risk: users ? `used by ${users} avd${users === 1 ? "" : "s"}` : null,
      artifacts: [{ path: img.dir, name: img.abi, bytes }],
      bytes,
      // Images carry no usage stamp; the mtime is when it was installed.
      mtime: await safeMtime(img.dir),
    });
  });
}

/** How many AVDs name each system image, by its `image.sysdir.1` relative path. */
async function referencedSystemImages(): Promise<Map<string, number>> {
  const home = avdHome();
  const counts = new Map<string, number>();

  let entries;
  try {
    entries = await readdir(home, { withFileTypes: true });
  } catch {
    return counts;
  }

  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith(".avd")) continue;
    const sysdir = (await readIni(join(home, e.name, "config.ini")))["image.sysdir.1"];
    if (!sysdir) continue;
    const key = sysdir.replace(/\/+$/, "");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// ── removal ──────────────────────────────────────────────────────────────────

/**
 * Hand each kind back to the tool that created it where there is one, so its
 * bookkeeping goes too — `simctl delete` updates CoreSimulator's device index,
 * `avdmanager delete` drops the pointer file with the directory. Both are
 * optional: a plain delete of the same paths is the fallback, and for device
 * support and system images it is the only route there ever was.
 */
export async function removeSim(s: Sim): Promise<void> {
  if (s.kind === "sim" && s.id && (await xcrun(["simctl", "delete", s.id])) !== null) return;

  if (s.kind === "runtime") {
    if (s.id && (await xcrun(["simctl", "runtime", "delete", s.id])) !== null) return;
    throw new Error("simctl runtime delete failed");
  }

  if (s.kind === "avd" && s.id && (await avdmanager(["delete", "avd", "-n", s.id]))) return;

  if (!s.paths.length) throw new Error(`nothing to delete for ${s.label}`);
  for (const path of s.paths) await rm(path, { recursive: true, force: true });
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function run(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : null;
  } catch {
    return null; // the tool is not installed — that platform simply has nothing
  }
}

const xcrun = (args: string[]) => (process.platform === "darwin" ? run(["xcrun", ...args]) : Promise.resolve(null));

async function avdmanager(args: string[]): Promise<boolean> {
  for (const bin of ["avdmanager", join(sdkRoot(), "cmdline-tools", "latest", "bin", "avdmanager")]) {
    if ((await run([bin, ...args])) !== null) return true;
  }
  return false;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readIni(path: string): Promise<Record<string, string>> {
  try {
    return parseIni(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function safeMtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}
