#!/usr/bin/env bun
/**
 * purrge — cough up the build artifacts your stale projects are sitting on.
 */
import { rm } from "node:fs/promises";

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
import { relative, resolve, basename } from "node:path";
import { homedir } from "node:os";
import pkg from "../package.json";
import { mapLimit } from "./concurrency";
import { bold, dim, green, humanAge, humanBytes, parseBytes, pink, plural, red } from "./format";
import * as ui from "./gum";
import { LiveRegion, SPINNER } from "./live";
import { pick } from "./picker";
import { findProjects, type Project } from "./scan";
import { findCargoTargets } from "./scan";
import { loadConfig } from "./config";
import { findWorktrees, isSafe, riskLabel, type Worktree } from "./worktrees";
import { findSims, isSafe as simIsSafe, removeSim, type Sim } from "./sims";

const HOME = homedir();

const WORKTREE_COMMANDS = new Set(["worktrees", "worktree", "wt"]);
const SIM_COMMANDS = new Set(["sims", "sim", "simulators", "emulators"]);

const HELP = `
${bold(pink("purrge"))} ${dim(`v${pkg.version}`)} — cough up build artifacts from stale projects

${bold("USAGE")}
  purrge [weeks] [options]
  purrge cargo sweep [options]
  purrge worktrees [days] [options]
  purrge sims [days] [options]

${bold("OPTIONS")}
  -w, --weeks <n>   only projects untouched for n+ weeks (default from config, 8)
  -d, --days <n>    cargo sweep / worktree / sim age threshold in days
  -r, --root <dir>  directory to scan (default: cwd)
  -m, --min <size>  ignore projects below this size (default 10M)
  -a, --all         no age filter — list every project
  -y, --yes         no prompts, purge everything listed
  -n, --dry-run     list what would go, delete nothing
  -j, --json        machine-readable output, never deletes
  -f, --force       include ones held back as unsafe or in use
  -h, --help        this
  -v, --version     version

${bold("EXAMPLES")}
  purrge 8               ${dim("# projects idle for 8+ weeks, in cwd")}
  purrge -r ~/code -m 1G ${dim("# only the big stuff under ~/code")}
  purrge -a -j           ${dim("# inventory everything as JSON")}
  purrge worktrees 14    ${dim("# git worktrees idle for 14+ days")}
  purrge sims 30         ${dim("# simulators, runtimes and AVDs idle 30+ days")}

${bold("CONFIG")}
  ~/.purrge/config.yml   ${dim("# machine-wide settings, incl. WORKTREE_ROOTS")}
  ./purrge.config.json   ${dim("# per-directory override")}
`;

type Options = {
  weeks: number;
  root: string;
  min: number;
  all: boolean;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  cargoSweep: boolean;
  cargoDays: number;
  worktrees: boolean;
  worktreeDays: number;
  worktreeRoots: string[];
  sims: boolean;
  simDays: number;
  force: boolean;
};

function parseArgs(argv: string[], config: Awaited<ReturnType<typeof loadConfig>>): Options {
  const o: Options = {
    weeks: config.PURGE_STALE_WEEKS_AMOUNT,
    root: process.cwd(),
    min: 10 * 1024 ** 2,
    all: false,
    yes: false,
    dryRun: false,
    json: false,
    cargoSweep: argv[0] === "cargo" && argv[1] === "sweep",
    cargoDays: config.CARGO_SWEEP_STALE_DAYS_AMOUNT,
    worktrees: WORKTREE_COMMANDS.has(argv[0]),
    worktreeDays: config.WORKTREE_STALE_DAYS_AMOUNT,
    worktreeRoots: config.WORKTREE_ROOTS,
    sims: SIM_COMMANDS.has(argv[0]),
    simDays: config.SIM_STALE_DAYS_AMOUNT,
    force: false,
  };

  const args = o.cargoSweep ? argv.slice(2) : o.worktrees || o.sims ? argv.slice(1) : argv;
  // `-r` names the tree to scan; for worktrees that is the checkout root.
  let rootGiven = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "-h": case "--help": console.log(HELP); process.exit(0);
      case "-v": case "--version": console.log(pkg.version); process.exit(0);
      case "-a": case "--all": o.all = true; break;
      case "-y": case "--yes": o.yes = true; break;
      case "-n": case "--dry-run": o.dryRun = true; break;
      case "-j": case "--json": o.json = true; break;
      case "-f": case "--force": o.force = true; break;
      case "-w": case "--weeks": o.weeks = Number(args[++i]); break;
      case "-d": case "--days": {
        const n = Number(args[++i]);
        if (o.worktrees) o.worktreeDays = n;
        else if (o.sims) o.simDays = n;
        else o.cargoDays = n;
        break;
      }
      case "-r": case "--root": o.root = resolve(args[++i]); rootGiven = true; break;
      case "-m": case "--min": o.min = parseBytes(args[++i]); break;
      default:
        if (/^\d+(\.\d+)?$/.test(a)) {
          if (o.cargoSweep) o.cargoDays = Number(a);
          else if (o.worktrees) o.worktreeDays = Number(a);
          else if (o.sims) o.simDays = Number(a);
          else o.weeks = Number(a);
        }
        else die(`unknown argument: ${a}\nrun ${bold("purrge --help")}`);
    }
  }
  if (!Number.isFinite(o.weeks) || o.weeks < 0) die("--weeks must be a non-negative number");
  if (!Number.isFinite(o.cargoDays) || o.cargoDays < 0) die("--days must be a non-negative number");
  if (!Number.isFinite(o.worktreeDays) || o.worktreeDays < 0) die("--days must be a non-negative number");
  if (!Number.isFinite(o.simDays) || o.simDays < 0) die("--days must be a non-negative number");

  if (o.worktrees) {
    if (rootGiven) o.worktreeRoots = [o.root];
    if (!o.worktreeRoots.length) {
      die(`no worktree roots configured\nset ${bold("WORKTREE_ROOTS")} in ~/.purrge/config.yml, or pass ${bold("--root")}`);
    }
    // Paths are printed relative to the first root; the rest fall back to ~/….
    o.root = o.worktreeRoots[0];
  }
  return o;
}


function die(msg: string): never {
  console.error(`${red("✗")} ${msg}`);
  process.exit(1);
}

// ── main ─────────────────────────────────────────────────────────────────────

const config = await loadConfig();
const opts = parseArgs(process.argv.slice(2), config);
const showUi = !opts.json;

/** What the run calls the things it lists. Worktrees are not projects, and a
 * sims run lists five different kinds of thing at once. */
const NOUN = opts.worktrees ? "worktree" : opts.sims ? "item" : "project";

if (showUi) {
  const scope = opts.worktrees
    ? `${opts.worktreeRoots.join("\n")}\n${opts.all ? "every worktree" : `idle ${opts.worktreeDays}+ days`}`
    : opts.sims
    ? `simulators, runtimes & emulators\n${opts.all ? "every one" : `idle ${opts.simDays}+ days`}`
    : `${opts.root}\n${opts.cargoSweep ? `cargo targets idle ${opts.cargoDays}+ days` : opts.all ? "every project" : `idle ${opts.weeks}+ weeks`}`;
  await ui.banner("purrge", dim(`${scope} · min ${humanBytes(opts.min)}`));
}

const ageDays = opts.cargoSweep
  ? opts.cargoDays
  : opts.worktrees
    ? opts.worktreeDays
    : opts.sims
      ? opts.simDays
      : opts.weeks * 7;
const cutoff = Date.now() - ageDays * 86_400_000;
const worthPurging = (p: Project) => p.bytes >= opts.min && (opts.all || p.mtime < cutoff);

const started = performance.now();
const projects: Project[] = opts.cargoSweep
  ? await findCargoTargets(opts.root)
  : opts.worktrees
    ? await scanWorktreesWithPreview(opts.worktreeRoots, showUi, worthPurging)
    : opts.sims
      ? await scanSimsWithPreview(showUi, worthPurging)
      : await scanWithPreview(opts.root, showUi, worthPurging);
const elapsed = (performance.now() - started) / 1000;

let stale = projects.filter(worthPurging).sort((a, b) => b.bytes - a.bytes);
const worthCount = stale.length;

// Anything whose removal would take something else down with it is shown, then
// set aside: a worktree holding edits or commits that exist nowhere else, a
// simulator runtime other simulators are cut from. `--force` opts back in.
const risky = opts.force ? [] : stale.filter((p) => heldBack(p));
if (risky.length) stale = stale.filter((p) => !heldBack(p));

if (opts.json) {
  console.log(JSON.stringify(
    opts.worktrees
      ? { roots: opts.worktreeRoots, scanned: projects.length, worktrees: stale, heldBack: risky }
      : opts.sims
        ? { scanned: projects.length, sims: stale, heldBack: risky }
        : { root: opts.root, scanned: projects.length, projects: stale },
    null,
    2,
  ));
  process.exit(0);
}

await ui.note(
  `${plural(projects.length, NOUN)} scanned in ${elapsed.toFixed(1)}s · ${worthCount} worth purging`,
);

if (risky.length) {
  console.log("");
  for (const p of risky) {
    console.log(`  ${dim("·")} ${label(p)} ${dim(`held back — ${heldBack(p)}`)}`);
  }
  await ui.note(
    `${plural(risky.length, NOUN)} kept back — ${bold("--force")} to include ${risky.length === 1 ? "it" : "them"}.`,
  );
}

if (!stale.length) {
  await ui.result("Nothing to cough up. Nice and tidy. 🐾");
  process.exit(0);
}

const total = stale.reduce((n, p) => n + p.bytes, 0);
const nameW = Math.max(...stale.map((p) => label(p).length));
const sizeW = Math.max(...stale.map((p) => humanBytes(p.bytes).length));

const rows = stale.map((p) => ({
  value: p,
  bytes: p.bytes,
  cells: [
    label(p).padEnd(nameW),
    humanBytes(p.bytes).padStart(sizeW),
    humanAge(p.mtime).padStart(5),
    opts.worktrees
      ? describe(p as Worktree)
      : opts.sims
        ? dim((p as Sim).detail)
        : [...new Set(p.artifacts.map((a) => a.name))].join(" "),
  ],
}));

let chosen: Project[];

if (opts.dryRun || opts.yes || !ui.INTERACTIVE) {
  console.log("");
  for (const r of rows) console.log(`  ${r.cells.join("  ")}`);
  console.log(`\n  ${bold("TOTAL".padEnd(nameW))}  ${bold(humanBytes(total).padStart(sizeW))}\n`);
  chosen = stale;
} else {
  const picked = await pick({
    rows,
    header: "  arrows to move · space to toggle · enter when ready",
    footer: (bytes, count) => `${bold(pink(humanBytes(bytes)))} across ${plural(count, NOUN)}`,
  });
  if (!picked) {
    await ui.note("Nothing touched.");
    process.exit(0);
  }
  chosen = picked;
}

if (!chosen.length) {
  await ui.note("Nothing selected. Nothing touched.");
  process.exit(0);
}

const chosenBytes = chosen.reduce((n, p) => n + p.bytes, 0);
const dirCount = chosen.reduce((n, p) => n + p.artifacts.length, 0);

const unit = opts.worktrees || opts.sims
  ? plural(chosen.length, NOUN)
  : plural(dirCount, "directory", "directories");

if (opts.dryRun) {
  await ui.result(`Dry run — would cough up ${humanBytes(chosenBytes)} from ${unit}.`);
  process.exit(0);
}

if (!opts.yes) {
  const ok = await ui.confirm(
    `Delete ${unit} and free ${humanBytes(chosenBytes)}?`,
    "Cough it up",
    "Leave it",
  );
  if (!ok) {
    await ui.note("Nothing touched.");
    process.exit(0);
  }
}

console.log("");
let freed = 0;
let failed = 0;

await mapLimit(chosen, 6, async (p) => {
  const targets = await mapLimit(p.artifacts, 4, async (a) => {
    try {
      if (opts.worktrees) await removeWorktree(p as Worktree);
      else if (opts.sims) await removeSim(p as Sim);
      else await rm(a.path, { recursive: true, force: true });
      return a.bytes;
    } catch (err) {
      failed++;
      const what = opts.worktrees || opts.sims ? label(p) : `${rel(p.dir)}/${a.name}`;
      console.log(`  ${red("✗")} ${what} — ${(err as Error).message}`);
      return 0;
    }
  });
  const sum = targets.reduce((n, b) => n + b, 0);
  freed += sum;
  console.log(`  ${green("✓")} ${label(p).padEnd(nameW)}  ${dim(humanBytes(sum).padStart(9))}`);
});

await ui.result(
  failed
    ? `Freed ${humanBytes(freed)} — ${
        opts.worktrees || opts.sims ? plural(failed, NOUN) : plural(failed, "directory", "directories")
      } refused to budge.`
    : `Freed ${humanBytes(freed)}. 🐱`,
  !failed,
);

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Walk the tree, showing matches in a preview list as they are discovered.
 *
 * Sizing a big `node_modules` takes long enough that a bare spinner wastes the
 * wait — the projects are known one by one, so they may as well be shown one by
 * one. The preview is a bounded window over the current top hits, repainted on a
 * timer, and erased once the real list takes over.
 */
async function scanWithPreview(
  root: string,
  withPreview: boolean,
  matches: (p: Project) => boolean,
): Promise<Project[]> {
  if (!withPreview || !ui.INTERACTIVE) return findProjects(root);
  return livePreview(basename(root) || root, matches, (onHit) => findProjects(root, onHit));
}

/**
 * Simulators come from tooling rather than a walk, but sizing each device and
 * system image is the same `du` wait, so they stream in the same way.
 */
async function scanSimsWithPreview(
  withPreview: boolean,
  matches: (p: Project) => boolean,
): Promise<Sim[]> {
  if (!withPreview || !ui.INTERACTIVE) return findSims();
  return livePreview("simulators", matches, (onHit) => findSims(onHit));
}

/** The same walk-and-show treatment for worktree roots. */
async function scanWorktreesWithPreview(
  roots: string[],
  withPreview: boolean,
  matches: (p: Project) => boolean,
): Promise<Worktree[]> {
  if (!withPreview || !ui.INTERACTIVE) return findWorktrees(roots);
  const label = roots.length === 1 ? basename(roots[0]) || roots[0] : plural(roots.length, "root");
  return livePreview(label, matches, (onHit) => findWorktrees(roots, onHit));
}

async function livePreview<T extends Project>(
  label: string,
  matches: (p: Project) => boolean,
  scan: (onHit: (p: T) => void) => Promise<T[]>,
): Promise<T[]> {
  const region = new LiveRegion();
  const hits: T[] = [];
  let scanned = 0;
  let frame = 0;

  const paint = () => {
    const spin = pink(SPINNER[frame++ % SPINNER.length]);
    const lines = [
      `  ${spin} sniffing around ${label}… ${dim(
        `${plural(scanned, NOUN)} · ${hits.length} worth purging`,
      )}`,
      "",
    ];

    const height = Math.max(3, Math.min(hits.length, (process.stdout.rows || 24) - 10));
    const shown = hits.slice(0, height);
    const nameW = Math.max(0, ...shown.map((p) => rel(p.dir).length));
    const sizeW = Math.max(0, ...shown.map((p) => humanBytes(p.bytes).length));

    for (const p of shown) {
      lines.push(
        `    ${rel(p.dir).padEnd(nameW)}  ${humanBytes(p.bytes).padStart(sizeW)}  ${dim(
          humanAge(p.mtime).padStart(5),
        )}`,
      );
    }
    const more = hits.length - shown.length;
    if (more > 0) lines.push(dim(`    … and ${more} more`));

    region.render(lines);
  };

  process.stdout.write(HIDE);
  const timer = setInterval(paint, 80);
  paint();

  try {
    return await scan((p) => {
      scanned++;
      if (!matches(p)) return;
      // Keep the preview ordered the way the final list will be.
      const at = hits.findIndex((h) => h.bytes < p.bytes);
      hits.splice(at === -1 ? hits.length : at, 0, p);
    });
  } finally {
    clearInterval(timer);
    region.clear();
    process.stdout.write(SHOW);
  }
}

/**
 * Hand a worktree back to git rather than deleting the directory behind its
 * back — otherwise the parent repo keeps a dangling entry in `.git/worktrees`
 * and `git worktree list` goes on advertising a path that is no longer there.
 * If git will not do it, remove the directory and prune the parent repo.
 */
async function removeWorktree(w: Worktree) {
  const proc = Bun.spawn(["git", "-C", w.repo ?? w.dir, "worktree", "remove", "--force", w.dir], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) === 0) return;

  await rm(w.dir, { recursive: true, force: true });
  if (w.repo) {
    const prune = Bun.spawn(["git", "-C", w.repo, "worktree", "prune"], { stdout: "ignore", stderr: "ignore" });
    await prune.exited;
    return;
  }
  // No parent repo to prune means the pointer, wherever it is, stays stale.
  throw new Error(stderr.trim().split("\n").pop() || "git worktree remove failed");
}

/**
 * Why this one is being set aside, or null when it can go. Only the two modes
 * that can take something else down with them have anything to say.
 */
function heldBack(p: Project): string | null {
  if (opts.worktrees) return isSafe(p as Worktree) ? null : riskLabel(p as Worktree);
  if (opts.sims) return simIsSafe(p as Sim) ? null : (p as Sim).risk;
  return null;
}

/** How a row is named: a path for the things that are one, a name otherwise. */
function label(p: Project): string {
  return opts.sims ? (p as Sim).label : rel(p.dir);
}

/** Branch (or short sha) plus whatever is unsafe about it. */
function describe(w: Worktree): string {
  const risk = riskLabel(w);
  return risk ? `${w.head} ${red(risk)}` : dim(w.head);
}

/**
 * Paths are shown relative to the scan root. A second worktree root lands
 * outside it, where `../../..` reads worse than the home-relative path does.
 */
function rel(dir: string): string {
  const r = relative(opts.root, dir);
  if (!r) return ".";
  if (!r.startsWith("..")) return r;
  return dir.startsWith(HOME) ? `~${dir.slice(HOME.length)}` : dir;
}

