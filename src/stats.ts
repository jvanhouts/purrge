/**
 * The whole picture rather than the purge list: how much there is, and how
 * much of it has gone stale. This is what `purrge stats` prints and what the
 * menu bar app draws, so the idea of "stale" lives here and nowhere else.
 */
import { findProjects, type Project } from "./scan";
import { findSims, type Sim, type SimKind } from "./sims";
import { findWorktrees, isSafe, type Worktree } from "./worktrees";
import type { Config } from "./config";

export type Summary = {
  count: number;
  staleCount: number;
  bytes: number;
  staleBytes: number;
};

export type Stats = {
  generatedAt: number;
  projects: Summary & { roots: string[]; staleWeeks: number };
  worktrees: WorktreeSummary & { roots: string[]; staleDays: number };
  /** iOS simulators and Android AVDs — the things you boot. */
  devices: Summary & { staleDays: number };
  /** Runtimes, device support and system images — what devices are cut from. */
  images: Summary;
};

export type WorktreeSummary = Summary & {
  /** Stale, but dirty or unmerged — purrge will not remove these without --force. */
  heldBackCount: number;
  heldBackBytes: number;
};

/**
 * One section of `Stats`, as soon as its scan is done. The three scans take
 * wildly different times — sims in a second, a worktree root in half a minute —
 * so anything drawing them should not have to wait for the slowest.
 */
export type StatsUpdate =
  | Pick<Stats, "projects">
  | Pick<Stats, "worktrees">
  | Pick<Stats, "devices" | "images">;

const DEVICE_KINDS = new Set<SimKind>(["sim", "avd"]);

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
  const heldBack = items.filter((w) => w.mtime < cutoff && !isSafe(w));
  return {
    ...summarize(items, cutoff),
    heldBackCount: heldBack.length,
    heldBackBytes: heldBack.reduce((n, w) => n + w.bytes, 0),
  };
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
): Promise<Stats> {
  const projectCutoff = now - config.PURGE_STALE_WEEKS_AMOUNT * 7 * 86_400_000;
  const worktreeCutoff = now - config.WORKTREE_STALE_DAYS_AMOUNT * 86_400_000;
  const simCutoff = now - config.SIM_STALE_DAYS_AMOUNT * 86_400_000;
  const isDevice = (s: Sim) => DEVICE_KINDS.has(s.kind);

  const emit = <T extends StatsUpdate>(update: T): T => {
    onUpdate?.(update);
    return update;
  };

  const [{ projects }, { worktrees }, { devices, images }] = await Promise.all([
    Promise.all(roots.map((root) => findProjects(root))).then((lists) => {
      const unique = new Map<string, Project>();
      for (const list of lists) for (const p of list) unique.set(p.dir, p);
      return emit({
        projects: {
          roots,
          staleWeeks: config.PURGE_STALE_WEEKS_AMOUNT,
          ...summarize([...unique.values()], projectCutoff),
        },
      });
    }),
    findWorktrees(config.WORKTREE_ROOTS).then((list) =>
      emit({
        worktrees: {
          roots: config.WORKTREE_ROOTS,
          staleDays: config.WORKTREE_STALE_DAYS_AMOUNT,
          ...summarizeWorktrees(list, worktreeCutoff),
        },
      }),
    ),
    findSims().then((sims) =>
      emit({
        devices: {
          staleDays: config.SIM_STALE_DAYS_AMOUNT,
          ...summarize(sims.filter(isDevice), simCutoff),
        },
        images: summarize(sims.filter((s) => !isDevice(s)), simCutoff),
      }),
    ),
  ]);

  return { generatedAt: now, projects, worktrees, devices, images };
}
