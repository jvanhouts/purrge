/**
 * `purrge config` — read and change ~/.purrge/config.yml without opening it.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  contractHome,
  expandHome,
  GLOBAL_CONFIG_PATH,
  loadConfig,
  NUMBER_KEYS,
  readGlobalConfig,
  ROOT_KEYS,
  writeGlobalConfig,
  type Config,
  type ConfigKey,
  type RootKey,
} from "./config";
import { bold, dim, green, pink, red } from "./format";

/** Short names for the keys, so nobody has to type PURGE_STALE_WEEKS_AMOUNT. */
export const KEY_ALIASES: Record<string, ConfigKey> = {
  projects: "PROJECT_ROOTS",
  worktrees: "WORKTREE_ROOTS",
  weeks: "PURGE_STALE_WEEKS_AMOUNT",
  "cargo-days": "CARGO_SWEEP_STALE_DAYS_AMOUNT",
  "worktree-days": "WORKTREE_STALE_DAYS_AMOUNT",
  "sim-days": "SIM_STALE_DAYS_AMOUNT",
};

const ALL_KEYS: readonly ConfigKey[] = [...ROOT_KEYS, ...NUMBER_KEYS];

export const CONFIG_HELP = `
${bold(pink("purrge config"))} — manage ${dim(contractHome(GLOBAL_CONFIG_PATH))}

${bold("USAGE")}
  purrge config                       show current settings and these commands
  purrge config list                  show current settings
  purrge config get <key>             print one setting
  purrge config set <key> <value…>    set a number, or replace a directory list
  purrge config add <key> <dir…>      add directories to a list
  purrge config remove <key> <dir…>   remove directories from a list
  purrge config unset <key>           back to the built-in default
  purrge config path                  print the config file's path
  purrge config edit                  open the file in $EDITOR

${bold("KEYS")}
  projects        ${dim("PROJECT_ROOTS")}                  where ${bold("purrge")} and ${bold("purrge stats")} look for projects
  worktrees       ${dim("WORKTREE_ROOTS")}                 where ${bold("purrge worktrees")} looks
  weeks           ${dim("PURGE_STALE_WEEKS_AMOUNT")}       project age threshold
  cargo-days      ${dim("CARGO_SWEEP_STALE_DAYS_AMOUNT")}  cargo sweep age threshold
  worktree-days   ${dim("WORKTREE_STALE_DAYS_AMOUNT")}     worktree age threshold
  sim-days        ${dim("SIM_STALE_DAYS_AMOUNT")}          simulator age threshold

${bold("EXAMPLES")}
  purrge config add projects ~/code .   ${dim("# scan ~/code and the current directory")}
  purrge config remove projects ~/code
  purrge config set weeks 12
`;

export function resolveKey(name: string): ConfigKey | null {
  if (name in KEY_ALIASES) return KEY_ALIASES[name];
  const upper = name.toUpperCase().replaceAll("-", "_");
  return ALL_KEYS.find((k) => k === upper) ?? null;
}

const isRootKey = (key: ConfigKey): key is RootKey => (ROOT_KEYS as readonly string[]).includes(key);

export type Edit =
  | { op: "set"; key: ConfigKey; values: string[] }
  | { op: "add" | "remove"; key: RootKey; values: string[] }
  | { op: "unset"; key: ConfigKey };

/**
 * Apply one edit to the raw global file, returning the new file. Directories
 * are stored home-relative (`~/code`) and compared once expanded, so `.` and
 * `~/code` name the same thing when run from ~/code.
 */
export function applyEdit(file: Record<string, unknown>, edit: Edit, current: Config): Record<string, unknown> {
  const out = { ...file };
  if (edit.op === "unset") {
    delete out[edit.key];
    return out;
  }

  if (!isRootKey(edit.key)) {
    if (edit.op !== "set" || edit.values.length !== 1) throw new Error(`${edit.key} takes a single number`);
    const n = Number(edit.values[0]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${edit.key} must be a non-negative number`);
    out[edit.key] = n;
    return out;
  }

  const dirs = edit.values.map(expandHome);
  // Start from what the file says; fall back to what is in effect so `add`
  // extends the defaults rather than silently replacing them.
  const existing = toList(file[edit.key]) ?? current[edit.key];
  let next: string[];
  if (edit.op === "set") next = dirs;
  else if (edit.op === "add") next = [...existing, ...dirs];
  else next = existing.filter((d) => !dirs.includes(d));

  const unique = [...new Set(next)];
  out[edit.key] = unique.map(contractHome);
  return out;
}

function toList(value: unknown): string[] | null {
  if (typeof value === "string") return [expandHome(value)];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").map(expandHome);
  return null;
}

type Source = "default" | "global" | "local" | "env";

async function sources(cwd: string, globalPath: string): Promise<Record<ConfigKey, Source>> {
  const global = await readGlobalConfig(globalPath);
  let local: Record<string, unknown> = {};
  try {
    local = JSON.parse(await readFile(join(cwd, "purrge.config.json"), "utf8"));
  } catch {}
  const out = {} as Record<ConfigKey, Source>;
  for (const key of ALL_KEYS) {
    out[key] = process.env[key] !== undefined ? "env" : key in local ? "local" : key in global ? "global" : "default";
  }
  return out;
}

const SOURCE_NOTE: Record<Source, string> = {
  default: "default",
  global: "",
  local: "from ./purrge.config.json",
  env: "from environment",
};

function formatValue(key: ConfigKey, config: Config): string {
  if (!isRootKey(key)) return String(config[key]);
  const roots = config[key];
  return roots.length ? roots.map(contractHome).join(", ") : dim("(none)");
}

async function printSettings(cwd: string, globalPath: string) {
  const config = await loadConfig(cwd, globalPath);
  const from = await sources(cwd, globalPath);
  const alias = (key: ConfigKey) => Object.keys(KEY_ALIASES).find((a) => KEY_ALIASES[a] === key)!;
  const w = Math.max(...ALL_KEYS.map((k) => alias(k).length));

  console.log(`\n  ${bold("config")} ${dim(contractHome(globalPath))}${existsSync(globalPath) ? "" : dim(" (not created yet)")}\n`);
  for (const key of ALL_KEYS) {
    const note = SOURCE_NOTE[from[key]];
    console.log(`  ${alias(key).padEnd(w)}  ${formatValue(key, config)}${note ? `  ${dim(`· ${note}`)}` : ""}`);
  }
  console.log("");
}

function die(msg: string): never {
  console.error(`${red("✗")} ${msg}`);
  process.exit(1);
}

export async function runConfigCommand(argv: string[], cwd = process.cwd(), globalPath = GLOBAL_CONFIG_PATH) {
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case undefined:
      await printSettings(cwd, globalPath);
      console.log(CONFIG_HELP.trimStart());
      return;
    case "-h": case "--help": case "help":
      console.log(CONFIG_HELP);
      return;
    case "list": case "ls": case "show":
      await printSettings(cwd, globalPath);
      return;
    case "path":
      console.log(globalPath);
      return;
    case "edit": {
      if (!existsSync(globalPath)) await writeGlobalConfig(await readGlobalConfig(globalPath), globalPath);
      const editor = process.env.VISUAL || process.env.EDITOR || "vi";
      const proc = Bun.spawn(["sh", "-c", `${editor} "$1"`, "sh", globalPath], {
        stdin: "inherit", stdout: "inherit", stderr: "inherit",
      });
      process.exit(await proc.exited);
    }
    case "get": {
      const key = keyArg(rest[0]);
      const config = await loadConfig(cwd, globalPath);
      const value = config[key];
      console.log(Array.isArray(value) ? value.map(contractHome).join("\n") : value);
      return;
    }
    case "set": case "add": case "remove": case "rm": case "unset": {
      const key = keyArg(rest[0]);
      const values = rest.slice(1);
      const op = cmd === "rm" ? "remove" : cmd;
      if (op === "unset") {
        if (values.length) die(`${bold("unset")} takes only a key`);
      } else if (!values.length) {
        die(`${bold(op)} needs ${isRootKey(key) ? "at least one directory" : "a value"}\nrun ${bold("purrge config --help")}`);
      }
      if ((op === "add" || op === "remove") && !isRootKey(key)) {
        die(`${key} is a number — use ${bold(`purrge config set ${rest[0]} <n>`)}`);
      }
      if (isRootKey(key) && op !== "remove") {
        for (const dir of values) {
          if (!existsSync(expandHome(dir))) console.log(`  ${pink("!")} ${dir} ${dim("does not exist (yet) — adding it anyway")}`);
        }
      }

      const current = await loadConfig(cwd, globalPath);
      const file = await readGlobalConfig(globalPath);
      let next: Record<string, unknown>;
      try {
        next = applyEdit(file, { op, key, values } as Edit, current);
      } catch (err) {
        die((err as Error).message);
      }
      await writeGlobalConfig(next, globalPath);

      const after = await loadConfig(cwd, globalPath);
      console.log(`  ${green("✓")} ${key} ${dim("→")} ${formatValue(key, after)}`);
      const from = (await sources(cwd, globalPath))[key];
      if (from === "env" || from === "local") {
        console.log(`  ${pink("!")} ${dim(`${SOURCE_NOTE[from]} still overrides this here`)}`);
      }
      return;
    }
    default:
      die(`unknown config command: ${cmd}\nrun ${bold("purrge config --help")}`);
  }
}

function keyArg(name: string | undefined): ConfigKey {
  if (!name) die(`missing key\nrun ${bold("purrge config --help")}`);
  const key = resolveKey(name);
  if (!key) die(`unknown key: ${name}\nrun ${bold("purrge config --help")} for the list`);
  return key;
}
