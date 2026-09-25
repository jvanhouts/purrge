import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_PURGE_STALE_WEEKS_AMOUNT = 8;
export const DEFAULT_CARGO_SWEEP_STALE_DAYS_AMOUNT = 14;
export const DEFAULT_WORKTREE_STALE_DAYS_AMOUNT = 14;
export const DEFAULT_SIM_STALE_DAYS_AMOUNT = 30;
export const DEFAULT_WORKTREE_ROOTS = ["~/.whiskers/worktrees"];
/** No sensible guess at where someone keeps their code, so nothing by default. */
export const DEFAULT_PROJECT_ROOTS: string[] = [];

/** `~/.purrge/config.yml` — settings that follow you between directories. */
export const GLOBAL_CONFIG_PATH = join(homedir(), ".purrge", "config.yml");

export type Config = {
  PURGE_STALE_WEEKS_AMOUNT: number;
  CARGO_SWEEP_STALE_DAYS_AMOUNT: number;
  WORKTREE_STALE_DAYS_AMOUNT: number;
  SIM_STALE_DAYS_AMOUNT: number;
  /** Directories holding linked git worktrees, absolute and tilde-expanded. */
  WORKTREE_ROOTS: string[];
  /** Directories `purrge stats` (and the menu bar app) sum projects under. */
  PROJECT_ROOTS: string[];
};

export const NUMBER_KEYS = [
  "PURGE_STALE_WEEKS_AMOUNT",
  "CARGO_SWEEP_STALE_DAYS_AMOUNT",
  "WORKTREE_STALE_DAYS_AMOUNT",
  "SIM_STALE_DAYS_AMOUNT",
] as const;

export const ROOT_KEYS = ["WORKTREE_ROOTS", "PROJECT_ROOTS"] as const;

export type NumberKey = (typeof NUMBER_KEYS)[number];
export type RootKey = (typeof ROOT_KEYS)[number];
export type ConfigKey = NumberKey | RootKey;

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
    SIM_STALE_DAYS_AMOUNT: DEFAULT_SIM_STALE_DAYS_AMOUNT,
    WORKTREE_ROOTS: DEFAULT_WORKTREE_ROOTS.map(expandHome),
    PROJECT_ROOTS: DEFAULT_PROJECT_ROOTS.map(expandHome),
  };

  applyFile(config, await readYaml(globalPath));
  applyFile(config, await readJson(join(cwd, "purrge.config.json")));

  for (const key of NUMBER_KEYS) {
    const value = process.env[key];
    if (value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0) {
      config[key] = Number(value);
    }
  }
  for (const key of ROOT_KEYS) {
    const roots = process.env[key];
    if (roots === undefined) continue;
    const parsed = parseRoots(roots.split(/[,:]/));
    if (parsed.length) config[key] = parsed;
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
  for (const key of ROOT_KEYS) {
    const roots = source[key];
    if (typeof roots === "string" || Array.isArray(roots)) {
      const parsed = parseRoots(typeof roots === "string" ? [roots] : roots);
      if (parsed.length) config[key] = parsed;
    }
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

/** `/Users/you/code` → `~/code`, which is how a person would write it. */
export function contractHome(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(home + "/") ? `~${path.slice(home.length)}` : path;
}

/**
 * The global file as written, not merged with anything — what `purrge config`
 * edits. Keys purrge does not know are kept so a write never loses them.
 */
export async function readGlobalConfig(path = GLOBAL_CONFIG_PATH): Promise<Record<string, unknown>> {
  const file = await readYaml(path);
  return file && typeof file === "object" && !Array.isArray(file) ? { ...(file as Record<string, unknown>) } : {};
}

/** Comments in a hand-edited file do not survive this; the values do. */
export async function writeGlobalConfig(file: Record<string, unknown>, path = GLOBAL_CONFIG_PATH) {
  await mkdir(dirname(path), { recursive: true });
  const body = Object.keys(file).length ? Bun.YAML.stringify(file, null, 2) : "";
  await writeFile(path, `# purrge settings — edit by hand or with \`purrge config\`.\n${body}${body.endsWith("\n") || !body ? "" : "\n"}`);
}
