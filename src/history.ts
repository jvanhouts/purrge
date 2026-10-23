/**
 * What changed between scans.
 *
 * One snapshot says where the space is; it cannot say what keeps eating it.
 * Each scan therefore appends a compact line to `~/.purrge/history.jsonl` —
 * when, how much was free, how big each provider and large location was, and
 * whether the scan could see all of it. Cleanups are logged too, with the
 * free space measured before and after: an estimate of what a deletion frees
 * and what the disk actually got back are different numbers, and only the
 * second one is the truth. Never file contents, never more than sizes.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { DiskSpace, ProviderStatus } from "./storage";

export const HISTORY_PATH = process.env.PURRGE_HISTORY || join(homedir(), ".purrge", "history.jsonl");

/** Enough for a year of daily scans; older lines are dropped on write. */
const MAX_ENTRIES = 400;

export type ScanEntry = {
  kind: "scan";
  /**
   * The doctor records every large location; stats only per-section totals.
   * Only scans from the same source are compared, or a total would look like
   * it vanished the moment a detailed scan came along.
   */
  source: "doctor" | "stats";
  at: number;
  disk: DiskSpace | null;
  /** Per provider: did it see everything, and how much it found. */
  scopes: Record<string, { status: ProviderStatus; bytes: number }>;
  /** `<scope>:<location>` → allocated bytes, for the larger locations only. */
  locations: Record<string, number>;
};

export type CleanupEntry = {
  kind: "cleanup";
  at: number;
  provider: string;
  items: number;
  failed: number;
  /** What purrge expected the deletions to free. */
  estimatedBytes: number;
  /** What the disk's free space actually did, when it could be measured. */
  freeBefore: number | null;
  freeAfter: number | null;
};

export type HistoryEntry = ScanEntry | CleanupEntry;

export async function readHistory(path = HISTORY_PATH): Promise<HistoryEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && (e.kind === "scan" || e.kind === "cleanup") && typeof e.at === "number") out.push(e);
    } catch {} // a half-written line from a killed run — skip it
  }
  return out;
}

/** Recording history is a convenience: failing to write it never fails a run. */
export async function appendHistory(entry: HistoryEntry, path = HISTORY_PATH): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n");
    const all = await readHistory(path);
    if (all.length > MAX_ENTRIES) {
      await writeFile(path, all.slice(-MAX_ENTRIES).map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
  } catch {}
}

export type Change = {
  key: string;
  before: number;
  after: number;
  delta: number;
  /**
   * `grew` and `shrank` compare like with like. `appeared` is new since a scan
   * that could see that scope fully; `newly-visible` appeared only because the
   * earlier scan could not look — access granted, a tool installed — and is not
   * growth at all.
   */
  kind: "grew" | "shrank" | "appeared" | "newly-visible" | "gone";
};

/**
 * Location-by-location changes between two scans, biggest movement first.
 * Only scopes complete in *both* scans are compared as growth; anything else
 * would mistake "can see more now" for "there is more now".
 */
export function compareScans(before: ScanEntry, after: ScanEntry, minBytes = 256 * 1024 ** 2): Change[] {
  const complete = (e: ScanEntry, scope: string) => e.scopes[scope]?.status === "complete";
  // A location can carry its own scope (one `du` row) or share its provider's.
  const scopeOf = (key: string) =>
    key in before.scopes || key in after.scopes ? key : key.slice(0, key.indexOf(":"));
  const keys = new Set([...Object.keys(before.locations), ...Object.keys(after.locations)]);
  const out: Change[] = [];

  for (const key of keys) {
    const scope = scopeOf(key);
    const a = before.locations[key];
    const b = after.locations[key];
    const comparable = complete(before, scope) && complete(after, scope);
    let kind: Change["kind"];
    if (a === undefined) kind = complete(before, scope) ? "appeared" : "newly-visible";
    else if (b === undefined) {
      if (!complete(after, scope)) continue; // not seen this time is not gone
      kind = "gone";
    } else {
      if (!comparable) continue;
      kind = b >= a ? "grew" : "shrank";
    }
    const delta = (b ?? 0) - (a ?? 0);
    if (Math.abs(delta) < minBytes) continue;
    out.push({ key, before: a ?? 0, after: b ?? 0, delta, kind });
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

/** The latest two scans from one source, newest last — or fewer, if there are not two yet. */
export function lastScans(entries: HistoryEntry[], source: ScanEntry["source"]): ScanEntry[] {
  return entries.filter((e): e is ScanEntry => e.kind === "scan" && (e.source ?? "doctor") === source).slice(-2);
}
