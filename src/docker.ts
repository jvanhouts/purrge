/**
 * Docker: images, containers, volumes and build cache, inside one VM disk.
 *
 * On macOS all of it lives in a single sparse file under
 * `~/Library/Containers/com.docker.docker`, whose apparent length (a terabyte,
 * typically) says nothing about what it occupies. That file is reported for
 * scale and never touched; the rows inside it are inventoried through Docker's
 * own `system df -v` and removed through Docker's own commands, one resource
 * at a time — never a blanket `docker system prune`.
 *
 * Two caveats travel with every number here. Images share layers, so their
 * sizes cannot simply be summed; the unique size is the honest estimate of
 * what removing one gives back. And freeing space inside the VM does not hand
 * blocks back to the host straight away — the host's free space is the only
 * real measure of what a cleanup achieved.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  exec,
  fileSizes,
  lastLine,
  statusFor,
  type Issue,
  type StorageFinding,
  type StorageProvider,
} from "./storage";

const VM_DIR = join(homedir(), "Library", "Containers", "com.docker.docker", "Data", "vms", "0", "data");
const VM_FILES = ["Docker.raw", "Docker.qcow2"];

type Row = Record<string, string>;

export type DockerDf = {
  images: Row[];
  containers: Row[];
  volumes: Row[];
  buildCache: Row[];
};

/** `"1.097GB"`, `"368.6kB"`, `"0B"` → bytes. Docker's units are decimal. */
export function parseDockerSize(text: string | undefined): number {
  const m = /^\s*([\d.]+)\s*([kKMGTP]?)i?B\s*$/.exec(text ?? "");
  if (!m) return 0;
  const power = { "": 0, k: 1, K: 1, M: 2, G: 3, T: 4, P: 5 }[m[2]] ?? 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.round(n * 1000 ** power) : 0;
}

/** The single JSON object `docker system df -v --format '{{json .}}'` prints. */
export function parseDockerDf(text: string): DockerDf | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((r): r is Row => !!r && typeof r === "object") : []);
  return {
    images: rows(j.Images),
    containers: rows(j.Containers),
    volumes: rows(j.Volumes),
    buildCache: rows(j.BuildCache),
  };
}

const DATABASE = /postgres|mysql|mariadb|mongo|redis|(^|[^a-z])db([^a-z]|$)|database/i;

function date(text: string | undefined): number | null {
  // `2026-10-22 00:27:26 +0200 CEST`, or with nanoseconds — Date.parse takes neither.
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))? ([+-]\d{2})(\d{2})/.exec(text ?? "");
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}.${(m[3] ?? "0").padEnd(3, "0").slice(0, 3)}${m[4]}:${m[5]}`);
  return Number.isFinite(t) ? t : null;
}

const shortId = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);

/**
 * Build cache totals from the plain `docker system df` lines. Cache entries
 * share parents, so summing the verbose rows overstates the cache; Docker's
 * own summary does not.
 */
export function parseBuildCacheSummary(text: string): { bytes: number; reclaimable: number } | null {
  for (const line of text.split("\n")) {
    try {
      const row = JSON.parse(line) as Row;
      if (row.Type !== "Build Cache") continue;
      return { bytes: parseDockerSize(row.Size), reclaimable: parseDockerSize(row.Reclaimable?.split(" (")[0]) };
    } catch {}
  }
  return null;
}

export function buildDockerFindings(df: DockerDf, cacheSummary?: { bytes: number; reclaimable: number } | null): StorageFinding[] {
  const out: StorageFinding[] = [];

  // Build cache: only entries nothing is using, which is all `builder prune` takes.
  const idle = df.buildCache.filter((b) => b.InUse !== "true");
  const cacheBytes = idle.reduce((n, b) => n + parseDockerSize(b.Size), 0);
  if (df.buildCache.length) {
    const last = Math.max(0, ...df.buildCache.map((b) => date(b.LastUsedAt) ?? 0));
    out.push({
      id: "docker:build-cache",
      provider: "docker",
      label: "build cache",
      detail: `${idle.length} of ${df.buildCache.length} entries unused`,
      paths: [],
      allocatedBytes: cacheSummary?.bytes ?? df.buildCache.reduce((n, b) => n + parseDockerSize(b.Size), 0),
      reclaimableEstimateBytes: cacheSummary?.reclaimable ?? cacheBytes,
      disposition: idle.length ? "eligible" : "held-back",
      reason: idle.length ? "unused build cache only — the next build re-pulls and re-runs layers" : "all in use",
      lastActivityAt: last || null,
      cleanupActionId: idle.length ? "docker-builder-prune" : undefined,
    });
  }

  for (const img of df.images) {
    const users = Number(img.Containers) || 0;
    const dangling = img.Repository === "<none>" || !img.Repository;
    const name = dangling ? `<none> ${shortId(img.ID)}` : `${img.Repository}:${img.Tag || "latest"}`;
    out.push({
      id: `docker:image:${img.ID}`,
      provider: "docker",
      label: name,
      detail: dangling ? "dangling image" : `image ${shortId(img.ID)}`,
      paths: [],
      allocatedBytes: parseDockerSize(img.Size),
      reclaimableEstimateBytes: parseDockerSize(img.UniqueSize),
      disposition: users ? "held-back" : "eligible",
      reason: users
        ? `used by ${users} container${users === 1 ? "" : "s"}`
        : "no containers use it — pull or rebuild to get it back",
      lastActivityAt: date(img.CreatedAt),
      cleanupActionId: users ? undefined : "docker-image-rm",
    });
  }

  for (const c of df.containers) {
    const running = c.State === "running";
    out.push({
      id: `docker:container:${c.ID}`,
      provider: "docker",
      label: c.Names || shortId(c.ID),
      detail: `${c.Image} · ${c.Status || c.State}`,
      paths: [],
      allocatedBytes: parseDockerSize(c.Size),
      reclaimableEstimateBytes: parseDockerSize(c.Size),
      disposition: running ? "held-back" : "review-only",
      reason: running ? "running" : "stopped containers can hold unique state",
      lastActivityAt: date(c.CreatedAt),
      cleanupActionId: running ? undefined : "docker-container-rm",
    });
  }

  for (const v of df.volumes) {
    const links = Number(v.Links) || 0;
    const db = DATABASE.test(`${v.Name} ${v.Labels ?? ""}`);
    out.push({
      id: `docker:volume:${v.Name}`,
      provider: "docker",
      label: v.Name,
      detail: links ? `volume · ${links} container${links === 1 ? "" : "s"}` : "volume · unattached",
      paths: [],
      allocatedBytes: parseDockerSize(v.Size),
      reclaimableEstimateBytes: parseDockerSize(v.Size),
      disposition: links ? "held-back" : "review-only",
      reason: links
        ? `attached to ${links} container${links === 1 ? "" : "s"}`
        : db
          ? "looks like database data — unattached is not the same as unwanted"
          : "volumes may be the only copy of their data",
      lastActivityAt: null,
      cleanupActionId: links ? undefined : "docker-volume-rm",
    });
  }

  return out;
}

async function vmDisk(): Promise<StorageFinding | null> {
  for (const name of VM_FILES) {
    const path = join(VM_DIR, name);
    const sizes = await fileSizes(path);
    if (!sizes) continue;
    return {
      id: `docker:vm:${name}`,
      provider: "docker",
      label: `VM disk ${name}`,
      detail: "allocated, not apparent length",
      paths: [path],
      allocatedBytes: sizes.allocated,
      logicalBytes: sizes.logical,
      reclaimableEstimateBytes: null,
      disposition: "review-only",
      reason: "Docker's VM disk — free space inside it with the rows below; never delete the file",
      lastActivityAt: null,
      enclosing: true,
    };
  }
  return null;
}

export const dockerProvider: StorageProvider = {
  name: "docker",
  title: "Docker",

  async scan() {
    const findings: StorageFinding[] = [];
    const issues: Issue[] = [];
    const vm = await vmDisk();
    if (vm) findings.push(vm);

    const r = await exec(["docker", "system", "df", "-v", "--format", "{{json .}}"], { timeoutMs: 60_000 });
    if (r.missing) {
      issues.push({ code: "missing-tool", message: "docker not installed" });
    } else if (!r.ok) {
      issues.push({ code: "unavailable", message: lastLine(r.stderr, "docker daemon not reachable") });
    } else {
      const df = parseDockerDf(r.stdout);
      const summary = await exec(["docker", "system", "df", "--format", "{{json .}}"], { timeoutMs: 60_000 });
      if (df) findings.push(...buildDockerFindings(df, summary.ok ? parseBuildCacheSummary(summary.stdout) : null));
      else issues.push({ code: "tool-failed", message: "could not read docker system df output" });
    }

    // A daemon that is down leaves only the VM file: that is not a complete picture.
    const status = issues.some((i) => i.code === "missing-tool" || i.code === "unavailable")
      ? "unavailable"
      : statusFor(findings, issues);
    return { provider: "docker", status, findings, issues };
  },

  async clean(f) {
    const ref = f.id.split(":").slice(2).join(":");
    const cmd: Record<string, string[]> = {
      "docker-builder-prune": ["docker", "builder", "prune", "--force"],
      "docker-image-rm": ["docker", "image", "rm", ref],
      "docker-container-rm": ["docker", "rm", ref],
      "docker-volume-rm": ["docker", "volume", "rm", ref],
    };
    const args = f.cleanupActionId && cmd[f.cleanupActionId];
    if (!args) throw new Error(`no docker action for ${f.label}`);
    const r = await exec(args, { timeoutMs: 600_000 });
    if (!r.ok) throw new Error(lastLine(r.stderr, `${args.slice(0, 3).join(" ")} failed`));
  },
};
