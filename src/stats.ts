/**
 * The whole picture rather than the purge list: how much there is, and how
 * much of it has gone stale. This is what `purrge stats` prints and what the
 * menu bar app draws, so the idea of "stale" lives here and nowhere else.
 */
import { findProjects, type Project } from "./scan";
import { isSafe as simIsSafe, scanSims, type Sim, type SimKind } from "./sims";
import { findWorktrees, isSafe, type Worktree } from "./worktrees";
import type { Config } from "./config";
import { PROVIDERS } from "./providers";
import {
  diskSpace,
  isLowSpace,
  statusFor,
  summarizeFindings,
  type DiskSpace,
  type FindingSummary,
  type Issue,
  type ProviderStatus,
  type StorageProvider,
  type StorageProviderResult,
} from "./storage";

export type Summary = {
  count: number;
  staleCount: number;
  bytes: number;
  staleBytes: number;
};

/** Stale, but purrge will not remove these without --force. */
export type HeldBack = {
  heldBackCount: number;
  heldBackBytes: number;
};

/**
 * Whether a section saw everything. A scan that could not run simctl used to
 * report zero simulators; now it reports zero simulators *and* why.
 */
export type Health = {
  status: ProviderStatus;
  issueCount: number;
  /** The first few, for display. */
  issues: Issue[];
};

export type ProviderSummary = FindingSummary & Health & { name: string; title: string };

export type Stats = {
  generatedAt: number;
  /** Free space on the volume your files are on — the number that ran out. */
  disk: (DiskSpace & { low: boolean }) | null;
  projects: Summary & Health & { roots: string[]; staleWeeks: number };
  worktrees: WorktreeSummary & { roots: string[]; staleDays: number };
  /** iOS simulators and Android AVDs — the things you boot. */
  devices: Summary & HeldBack & Health & { staleDays: number };
  /** Runtimes, device support and system images — what devices are cut from. */
  images: Summary & HeldBack;
  /** Caches, Xcode build output, Docker, tool versions. */
  providers: ProviderSummary[];
};

export type WorktreeSummary = Summary & HeldBack;

/**
 * One section of `Stats`, as soon as its scan is done. The scans take wildly
 * different times — disk space instantly, sims in a second, a worktree root in
 * half a minute — so anything drawing them should not have to wait for the
 * slowest.
 */
export type StatsUpdate =
  | Pick<Stats, "disk">
  | Pick<Stats, "projects">
  | Pick<Stats, "worktrees">
  | Pick<Stats, "devices" | "images">
  | { provider: ProviderSummary };

const DEVICE_KINDS = new Set<SimKind>(["sim", "avd"]);

/** Issues shown with a section; the count says how many more there were. */
const SHOWN_ISSUES = 5;

/** Never used counts as stale: an mtime of 0 is older than any cutoff. */
export function summarize(items: Project[], cutoff: number): Summary {
  const s: Summary = { count: 0, staleCount: 0, bytes: 0, staleBytes: 0 };
  for (const p of items) {
    s.count++;
    s.bytes += p.bytes;
    if (p.mtime < cutoff) {
      s.staleCount++;
      s.staleBytes += p.bytes;
    }
  }
  return s;
}

export function summarizeWorktrees(items: Worktree[], cutoff: number): WorktreeSummary {
  return summarizeHeldBack(items, cutoff, isSafe);
}

/**
 * Stale counts everything idle; held back is the part of it that purrge would
 * still refuse to delete. Without the split, a runtime in use by a simulator
 * looked as reclaimable as one nothing refers to.
 */
export function summarizeSims(items: Sim[], cutoff: number): Summary & HeldBack {
  return summarizeHeldBack(items, cutoff, simIsSafe);
}

function summarizeHeldBack<T extends Project>(items: T[], cutoff: number, safe: (item: T) => boolean): Summary & HeldBack {
  const heldBack = items.filter((p) => p.mtime < cutoff && !safe(p));
  return {
    ...summarize(items, cutoff),
    heldBackCount: heldBack.length,
    heldBackBytes: heldBack.reduce((n, p) => n + p.bytes, 0),
  };
}

export function health(status: ProviderStatus, issues: Issue[]): Health {
  return { status, issueCount: issues.length, issues: issues.slice(0, SHOWN_ISSUES) };
}

export function summarizeProvider(provider: StorageProvider, result: StorageProviderResult): ProviderSummary {
  return {
    name: provider.name,
    title: provider.title,
    ...summarizeFindings(result.findings),
    ...health(result.status, result.issues),
  };
}

/** A provider that throws is an error result, never a crashed stats run. */
export async function scanProvider(provider: StorageProvider, projectRoots: string[], now = Date.now()): Promise<StorageProviderResult> {
  try {
    return await provider.scan({ projectRoots, now });
  } catch (err) {
    return {
      provider: provider.name,
      status: "error",
      findings: [],
      issues: [{ code: "tool-failed", message: (err as Error).message }],
    };
  }
}

/**
 * Nested roots would count a project once per root it sits under, so projects
 * are keyed by directory.
 */
export async function collectStats(
  config: Config,
  roots: string[],
  /** Called with each section the moment its scan finishes. */
  onUpdate?: (update: StatsUpdate) => void,
  now = Date.now(),
  /** The extra providers to run; tests and quick callers pass fewer. */
  providers: StorageProvider[] = PROVIDERS,
): Promise<Stats> {
  const projectCutoff = now - config.PURGE_STALE_WEEKS_AMOUNT * 7 * 86_400_000;
  const worktreeCutoff = now - config.WORKTREE_STALE_DAYS_AMOUNT * 86_400_000;
  const simCutoff = now - config.SIM_STALE_DAYS_AMOUNT * 86_400_000;
  const isDevice = (s: Sim) => DEVICE_KINDS.has(s.kind);

  const emit = <T extends StatsUpdate>(update: T): T => {
    onUpdate?.(update);
    return update;
  };

  const [{ disk }, { projects }, { worktrees }, { devices, images }, summaries] = await Promise.all([
    diskSpace().then((d) => emit({ disk: d && { ...d, low: isLowSpace(d) } })),
    (async () => {
      const issues: Issue[] = [];
      const lists = await Promise.all(roots.map((root) => findProjects(root, undefined, (i) => issues.push(i))));
      const unique = new Map<string, Project>();
      for (const list of lists) for (const p of list) unique.set(p.dir, p);
      return emit({
        projects: {
          roots,
          staleWeeks: config.PURGE_STALE_WEEKS_AMOUNT,
          ...summarize([...unique.values()], projectCutoff),
          ...health(statusFor([...unique.values()], issues), issues),
        },
      });
    })(),
    findWorktrees(config.WORKTREE_ROOTS, undefined, roots).then((list) =>
      emit({
        worktrees: {
          roots: config.WORKTREE_ROOTS,
          staleDays: config.WORKTREE_STALE_DAYS_AMOUNT,
          ...summarizeWorktrees(list, worktreeCutoff),
        },
      }),
    ),
    scanSims().then(({ sims, status, issues }) =>
      emit({
        devices: {
          staleDays: config.SIM_STALE_DAYS_AMOUNT,
          ...summarizeSims(sims.filter(isDevice), simCutoff),
          ...health(status, issues),
        },
        images: summarizeSims(sims.filter((s) => !isDevice(s)), simCutoff),
      }),
    ),
    Promise.all(
      providers.map(async (p) => emit({ provider: summarizeProvider(p, await scanProvider(p, roots, now)) }).provider),
    ),
  ]);

  return { generatedAt: now, disk, projects, worktrees, devices, images, providers: summaries };
}
