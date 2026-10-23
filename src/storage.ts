/**
 * The common shape every storage provider reports in.
 *
 * Projects, worktrees and simulators grew up as their own `Project`-shaped
 * lists. Everything beyond them — shared package caches, Xcode's DerivedData,
 * Docker, installed tool versions — lives outside any project root and needs
 * more nuance than "stale or not": a cache can be eligible, an archive is
 * only ever worth a look, a Docker volume may be the only copy of a database.
 * Each provider therefore hands back findings with an explicit disposition,
 * plus an honest account of what it could not see.
 *
 * Inventory and cleanup are kept apart: a finding names a cleanup action by
 * id, and only the provider that produced it knows how to carry it out. No
 * finding ever carries shell text.
 */
import { realpath, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";

export type Disposition = "eligible" | "held-back" | "review-only";

export type StorageFinding = {
  /** Stable: provider plus a canonical identity, so history can line scans up. */
  id: string;
  provider: string;
  /** What to print — "npm content cache" beats a path. */
  label: string;
  /** Trailing column: version, owning project, image tag… */
  detail: string;
  paths: string[];
  /** Bytes on disk (`du`), not apparent length. Null when it could not be measured. */
  allocatedBytes: number | null;
  /** Apparent length, where it differs enough to matter (sparse VM images). */
  logicalBytes?: number;
  /** What removing it should give back, by the provider's own estimate. */
  reclaimableEstimateBytes: number | null;
  disposition: Disposition;
  /** Why it has the disposition it has, in a few words. */
  reason: string;
  lastActivityAt: number | null;
  /** Names an action in the provider's own table; absent means report-only. */
  cleanupActionId?: string;
  /**
   * Its bytes are the provider's other findings' bytes, seen from outside —
   * Docker's VM disk holds its images and volumes. Shown for context; left
   * out of totals whenever the findings inside it are there to count instead.
   */
  enclosing?: boolean;
};

export type IssueCode =
  /** The owning tool is not installed — that store simply is not there. */
  | "missing-tool"
  /** The tool is there, but failed or answered with something unreadable. */
  | "tool-failed"
  /** Docker's daemon (or similar) is not running. */
  | "unavailable"
  /** macOS privacy controls or plain permissions refused the read. */
  | "denied"
  /** `du` finished but could not read everything — the size is a floor. */
  | "partial-size";

export type Issue = { path?: string; code: IssueCode; message: string };

export type ProviderStatus = "complete" | "partial" | "unavailable" | "error";

export type StorageProviderResult = {
  provider: string;
  status: ProviderStatus;
  findings: StorageFinding[];
  issues: Issue[];
};

export type ScanContext = {
  /** PROJECT_ROOTS, for providers that look for version pins in projects. */
  projectRoots: string[];
  now: number;
};

export type StorageProvider = {
  /** Command and history key: `caches`, `xcode`, `docker`, `tools`. */
  name: string;
  title: string;
  scan(ctx: ScanContext): Promise<StorageProviderResult>;
  /** Carry out `finding.cleanupActionId`. Throws with a short reason on failure. */
  clean(finding: StorageFinding): Promise<void>;
};

/**
 * What a set of issues means for the result as a whole. Missing tools on their
 * own are not a failure — a machine without Gradle has no Gradle cache — but a
 * provider that found nothing *because* it could not look is unavailable, not
 * empty.
 */
export function statusFor(findings: readonly unknown[], issues: Issue[], { required = false } = {}): ProviderStatus {
  const serious = issues.filter((i) => i.code !== "missing-tool");
  if (required && issues.some((i) => i.code === "missing-tool" || i.code === "unavailable") && !findings.length) {
    return "unavailable";
  }
  if (!serious.length) return "complete";
  if (serious.some((i) => i.code === "unavailable") && !findings.length) return "unavailable";
  if (serious.some((i) => i.code === "tool-failed") && !findings.length) return "error";
  return "partial";
}

// ── running tools ────────────────────────────────────────────────────────────

export type ExecResult = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  /** The binary could not be started at all — not installed, or not on PATH. */
  missing: boolean;
};

/**
 * Run a tool and keep everything: exit code, both streams, and whether it was
 * there in the first place. The difference between "not installed" and "ran
 * and failed" is exactly what turned a sandboxed simctl into zero simulators.
 */
export async function exec(cmd: string[], { cwd, timeoutMs = 120_000 }: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  if (!Bun.which(cmd[0]) && !cmd[0].includes("/")) {
    return { ok: false, code: -1, stdout: "", stderr: `${cmd[0]} not found`, missing: true };
  }
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { ok: code === 0, code, stdout, stderr, missing: false };
  } catch (err) {
    return { ok: false, code: -1, stdout: "", stderr: (err as Error).message, missing: true };
  }
}

/** The last meaningful line of a tool's complaint, for an issue message. */
export function lastLine(text: string, fallback: string): string {
  return text.trim().split("\n").filter(Boolean).pop()?.trim() || fallback;
}

// ── measuring ────────────────────────────────────────────────────────────────

export type Measurement = {
  /** Allocated bytes; null when the path is missing or unreadable outright. */
  bytes: number | null;
  /** Something underneath could not be read: `bytes` is a lower bound. */
  partial: boolean;
  /** The path does not exist. */
  missing: boolean;
  /** The path exists but could not be read at all. */
  denied: boolean;
};

/**
 * Allocated size via `du -xsk`, which counts blocks rather than apparent length
 * — the difference between Docker's 1 TiB sparse VM file and the 40 GiB it
 * actually occupies. Unlike a bare `du`, the exit status is checked: a nonzero
 * exit with a number still printed means some subtree was skipped.
 */
export async function measure(path: string): Promise<Measurement> {
  try {
    await stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return { bytes: null, partial: false, missing: false, denied: true };
    return { bytes: null, partial: false, missing: true, denied: false };
  }
  // `-x`: simulator runtimes and other disk images mount inside the trees we
  // measure, and counting a mounted image as part of its mount point is
  // exactly how the same bytes get counted twice.
  const r = await exec(["du", "-x", "-sk", path], { timeoutMs: 600_000 });
  const kb = Number(r.stdout.trim().split(/\s+/)[0]);
  if (!r.stdout.trim() || !Number.isFinite(kb)) {
    const denied = /denied|not permitted/i.test(r.stderr);
    return { bytes: null, partial: false, missing: false, denied };
  }
  return { bytes: kb * 1024, partial: !r.ok, missing: false, denied: false };
}

/**
 * A measurement as an issue, if it deserves one. Missing paths deserve none:
 * the caller decides whether absence is news.
 */
export function measurementIssue(path: string, m: Measurement): Issue | null {
  if (m.denied) return { path, code: "denied", message: "access denied — size unknown, not zero" };
  if (m.partial) return { path, code: "partial-size", message: "some contents unreadable — size is a lower bound" };
  return null;
}

/**
 * Apparent length and allocated bytes of a single file. Sparse files are where
 * the two part company, and a scanner that trusts `size` overstates them wildly.
 */
export async function fileSizes(path: string): Promise<{ logical: number; allocated: number } | null> {
  try {
    const s = await stat(path);
    return { logical: s.size, allocated: s.blocks * 512 };
  } catch {
    return null;
  }
}

/** Resolved through symlinks, so two spellings of one directory are one finding. */
export async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export async function newestMtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

// ── processes ────────────────────────────────────────────────────────────────

/**
 * Command lines of everything running, read once per scan. Cache stores are
 * held back while their owner is mid-install; deleting a store under a running
 * `npm install` corrupts the install, not just the cache.
 */
export async function runningCommands(): Promise<string[]> {
  const r = await exec(["ps", "-axo", "command="]);
  return r.ok ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

/** The first running command matching any pattern, or null. */
export function findRunning(commands: string[], patterns: RegExp[]): string | null {
  for (const c of commands) if (patterns.some((p) => p.test(c))) return c;
  return null;
}

// ── disk ─────────────────────────────────────────────────────────────────────

export type DiskSpace = {
  /** The volume asked about — on macOS, the Data volume that holds your files. */
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
};

/** APFS volumes share their container's free space, so this is the container's. */
export async function diskSpace(path = process.platform === "darwin" ? "/System/Volumes/Data" : "/"): Promise<DiskSpace | null> {
  try {
    const s = await statfs(path);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    return { path, totalBytes, freeBytes, usedBytes: totalBytes - s.bfree * s.bsize };
  } catch {
    return null;
  }
}

/** Below 10% or 20 GiB free, whichever is larger, the disk is getting tight. */
export function isLowSpace(d: DiskSpace): boolean {
  return d.freeBytes < Math.max(d.totalBytes * 0.1, 20 * 1024 ** 3);
}

// ── totals ───────────────────────────────────────────────────────────────────

export type FindingSummary = {
  count: number;
  bytes: number;
  eligibleCount: number;
  eligibleBytes: number;
  heldBackCount: number;
  heldBackBytes: number;
  reviewCount: number;
  reviewBytes: number;
};

/** Per-disposition totals. Unmeasured findings count, but add no bytes. */
export function summarizeFindings(findings: StorageFinding[]): FindingSummary {
  const s: FindingSummary = {
    count: 0, bytes: 0, eligibleCount: 0, eligibleBytes: 0,
    heldBackCount: 0, heldBackBytes: 0, reviewCount: 0, reviewBytes: 0,
  };
  const hasContents = new Set(findings.filter((f) => !f.enclosing).map((f) => f.provider));
  for (const f of findings) {
    if (f.enclosing && hasContents.has(f.provider)) continue;
    const bytes = f.allocatedBytes ?? 0;
    s.count++;
    s.bytes += bytes;
    if (f.disposition === "eligible") {
      s.eligibleCount++;
      s.eligibleBytes += f.reclaimableEstimateBytes ?? bytes;
    } else if (f.disposition === "held-back") {
      s.heldBackCount++;
      s.heldBackBytes += bytes;
    } else {
      s.reviewCount++;
      s.reviewBytes += bytes;
    }
  }
  return s;
}

export const HOME = homedir();
