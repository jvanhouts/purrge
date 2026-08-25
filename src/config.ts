import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_PURGE_STALE_WEEKS_AMOUNT = 8;
export const DEFAULT_CARGO_SWEEP_STALE_DAYS_AMOUNT = 14;
export const DEFAULT_WORKTREE_STALE_DAYS_AMOUNT = 14;
export const DEFAULT_WORKTREE_ROOTS = ["~/.whiskers/worktrees"];

/** `~/.purrge/config.yml` — settings that follow you between directories. */
export const GLOBAL_CONFIG_PATH = join(homedir(), ".purrge", "config.yml");

export type Config = {
  PURGE_STALE_WEEKS_AMOUNT: number;
  CARGO_SWEEP_STALE_DAYS_AMOUNT: number;
  WORKTREE_STALE_DAYS_AMOUNT: number;
  /** Directories holding linked git worktrees, absolute and tilde-expanded. */
  WORKTREE_ROOTS: string[];
};

const NUMBER_KEYS = [
  "PURGE_STALE_WEEKS_AMOUNT",
  "CARGO_SWEEP_STALE_DAYS_AMOUNT",
  "WORKTREE_STALE_DAYS_AMOUNT",
] as const;

/**
 * Settings, lowest precedence first:
 *
 *   defaults → ~/.purrge/config.yml → ./purrge.config.json → environment
 *
 * The global file is where machine-wide facts live — where your worktrees are
 * checked out, say — while the per-directory JSON stays a project override.
 */
export async function loadConfig(cwd = process.cwd(), globalPath = GLOBAL_CONFIG_PATH): Promise<Config> {
  const config: Config = {
    PURGE_STALE_WEEKS_AMOUNT: DEFAULT_PURGE_STALE_WEEKS_AMOUNT,
    CARGO_SWEEP_STALE_DAYS_AMOUNT: DEFAULT_CARGO_SWEEP_STALE_DAYS_AMOUNT,
    WORKTREE_STALE_DAYS_AMOUNT: DEFAULT_WORKTREE_STALE_DAYS_AMOUNT,
    WORKTREE_ROOTS: DEFAULT_WORKTREE_ROOTS.map(expandHome),
  };

  applyFile(config, await readYaml(globalPath));
  applyFile(config, await readJson(join(cwd, "purrge.config.json")));

  for (const key of NUMBER_KEYS) {
    const value = process.env[key];
    if (value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0) {
      config[key] = Number(value);
    }
  }
  const roots = process.env.WORKTREE_ROOTS;
  if (roots !== undefined) {
    const parsed = parseRoots(roots.split(/[,:]/));
    if (parsed.length) config.WORKTREE_ROOTS = parsed;
  }

  return config;
}

function applyFile(config: Config, file: unknown) {
  if (!file || typeof file !== "object") return;
  const source = file as Record<string, unknown>;

  for (const key of NUMBER_KEYS) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) config[key] = value;
  }

  // A single string is accepted as shorthand for a one-entry list.
  const roots = source.WORKTREE_ROOTS;
  if (typeof roots === "string" || Array.isArray(roots)) {
    const parsed = parseRoots(typeof roots === "string" ? [roots] : roots);
    if (parsed.length) config.WORKTREE_ROOTS = parsed;
  }
}

function parseRoots(values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) out.push(expandHome(trimmed));
  }
  return [...new Set(out)];
}

/** `~/x` and `$HOME/x` are the natural way to write these in a config file. */
export function expandHome(path: string): string {
  let out = path;
  if (out === "~" || out.startsWith("~/")) out = join(homedir(), out.slice(1));
  else if (out.startsWith("$HOME/")) out = join(homedir(), out.slice(6));
  return isAbsolute(out) ? out : resolve(out);
}

async function readYaml(path: string): Promise<unknown> {
  try {
    return Bun.YAML.parse(await readFile(path, "utf8"));
  } catch {
    return null; // absent or malformed — the defaults still stand
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
