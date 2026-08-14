#!/usr/bin/env bun
/**
 * purrge — cough up the build artifacts your stale projects are sitting on.
 */
import { rm } from "node:fs/promises";
import { relative, resolve, basename } from "node:path";
import pkg from "../package.json";
import { mapLimit } from "./concurrency";
import { bold, dim, green, humanAge, humanBytes, parseBytes, pink, red } from "./format";
import * as ui from "./gum";
import { findProjects, type Project } from "./scan";

const HELP = `
${bold(pink("purrge"))} ${dim(`v${pkg.version}`)} — cough up build artifacts from stale projects

${bold("USAGE")}
  purrge [weeks] [options]

${bold("OPTIONS")}
  -w, --weeks <n>   only projects untouched for n+ weeks (default 4)
  -r, --root <dir>  directory to scan (default: cwd)
  -m, --min <size>  ignore projects below this size (default 10M)
  -a, --all         no age filter — list every project
  -y, --yes         no prompts, purge everything listed
  -n, --dry-run     list what would go, delete nothing
  -j, --json        machine-readable output, never deletes
  -h, --help        this
  -v, --version     version

${bold("EXAMPLES")}
  purrge 8               ${dim("# projects idle for 8+ weeks, in cwd")}
  purrge -r ~/code -m 1G ${dim("# only the big stuff under ~/code")}
  purrge -a -j           ${dim("# inventory everything as JSON")}
`;

type Options = {
  weeks: number;
  root: string;
  min: number;
  all: boolean;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): Options {
  const o: Options = {
    weeks: 4,
    root: process.cwd(),
    min: 10 * 1024 ** 2,
    all: false,
    yes: false,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h": case "--help": console.log(HELP); process.exit(0);
      case "-v": case "--version": console.log(pkg.version); process.exit(0);
      case "-a": case "--all": o.all = true; break;
      case "-y": case "--yes": o.yes = true; break;
      case "-n": case "--dry-run": o.dryRun = true; break;
      case "-j": case "--json": o.json = true; break;
      case "-w": case "--weeks": o.weeks = Number(argv[++i]); break;
      case "-r": case "--root": o.root = resolve(argv[++i]); break;
      case "-m": case "--min": o.min = parseBytes(argv[++i]); break;
      default:
        if (/^\d+(\.\d+)?$/.test(a)) o.weeks = Number(a);
        else die(`unknown argument: ${a}\nrun ${bold("purrge --help")}`);
    }
  }
  if (!Number.isFinite(o.weeks) || o.weeks < 0) die("--weeks must be a non-negative number");
  return o;
}

function die(msg: string): never {
  console.error(`${red("✗")} ${msg}`);
  process.exit(1);
}

// ── internal: the scan half, so it can run behind a gum spinner ───────────────

if (process.argv[2] === "--scan-json") {
  const projects = await findProjects(resolve(process.argv[3] ?? process.cwd()));
  console.log(JSON.stringify(projects));
  process.exit(0);
}

// ── main ─────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));
const showUi = !opts.json;

if (showUi) {
  await ui.banner(
    "purrge",
    dim(`${opts.root}\n${opts.all ? "every project" : `idle ${opts.weeks}+ weeks`} · min ${humanBytes(opts.min)}`),
  );
}

const started = performance.now();
const projects = await scan(opts.root, showUi);
const elapsed = (performance.now() - started) / 1000;

const cutoff = Date.now() - opts.weeks * 7 * 86_400_000;
const stale = projects
  .filter((p) => p.bytes >= opts.min && (opts.all || p.mtime < cutoff))
  .sort((a, b) => b.bytes - a.bytes);

if (opts.json) {
  console.log(JSON.stringify({ root: opts.root, scanned: projects.length, projects: stale }, null, 2));
  process.exit(0);
}

await ui.note(
  `${projects.length} projects scanned in ${elapsed.toFixed(1)}s · ${stale.length} worth purging`,
);

if (!stale.length) {
  await ui.result("Nothing to cough up. Nice and tidy. 🐾");
  process.exit(0);
}

const total = stale.reduce((n, p) => n + p.bytes, 0);
const labels = new Map<string, Project>();
const width = Math.max(...stale.map((p) => label(p).length));
for (const p of stale) labels.set(row(p, width), p);

let chosen: Project[];

if (opts.dryRun || opts.yes || !ui.INTERACTIVE) {
  console.log("");
  for (const line of labels.keys()) console.log(`  ${line}`);
  console.log(`\n  ${bold("TOTAL".padEnd(width))}  ${bold(humanBytes(total).padStart(9))}\n`);
  chosen = stale;
} else {
  const picked = await ui.chooseMany(
    `space + arrows to pick, enter to continue — ${humanBytes(total)} across ${stale.length} projects`,
    [...labels.keys()],
  );
  if (!picked) {
    await ui.note("Nothing touched.");
    process.exit(0);
  }
  chosen = picked.map((l) => labels.get(l)!).filter(Boolean);
}

if (!chosen.length) {
  await ui.note("Nothing selected. Nothing touched.");
  process.exit(0);
}

const chosenBytes = chosen.reduce((n, p) => n + p.bytes, 0);
const dirCount = chosen.reduce((n, p) => n + p.artifacts.length, 0);

if (opts.dryRun) {
  await ui.result(`Dry run — would cough up ${humanBytes(chosenBytes)} from ${dirCount} directories.`);
  process.exit(0);
}

if (!opts.yes) {
  const ok = await ui.confirm(
    `Delete ${dirCount} directories and free ${humanBytes(chosenBytes)}?`,
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
      await rm(a.path, { recursive: true, force: true });
      return a.bytes;
    } catch (err) {
      failed++;
      console.log(`  ${red("✗")} ${rel(p.dir)}/${a.name} — ${(err as Error).message}`);
      return 0;
    }
  });
  const sum = targets.reduce((n, b) => n + b, 0);
  freed += sum;
  console.log(`  ${green("✓")} ${rel(p.dir).padEnd(width)}  ${dim(humanBytes(sum).padStart(9))}`);
});

await ui.result(
  failed
    ? `Freed ${humanBytes(freed)} — ${failed} directories refused to budge.`
    : `Freed ${humanBytes(freed)}. 🐱`,
  !failed,
);

// ── helpers ──────────────────────────────────────────────────────────────────

async function scan(root: string, withSpinner: boolean): Promise<Project[]> {
  if (!withSpinner || !ui.INTERACTIVE) return findProjects(root);

  const { code, out } = await ui.spin(`sniffing around ${basename(root) || root}…`, [
    process.execPath,
    import.meta.path,
    "--scan-json",
    root,
  ]);
  if (code !== 0) return findProjects(root); // spinner subprocess failed — just scan inline
  try {
    return JSON.parse(out) as Project[];
  } catch {
    return findProjects(root);
  }
}

function rel(dir: string): string {
  return relative(opts.root, dir) || ".";
}

function label(p: Project): string {
  return rel(p.dir);
}

/** Plain text on purpose — gum renders these as list items and adds its own styling. */
function row(p: Project, w: number): string {
  const kinds = [...new Set(p.artifacts.map((a) => a.name))].join(" ");
  return `${label(p).padEnd(w)}  ${humanBytes(p.bytes).padStart(9)}  ${humanAge(p.mtime).padStart(5)}  ${kinds}`;
}
