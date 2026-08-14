#!/usr/bin/env bun
/**
 * purrge — cough up the build artifacts your stale projects are sitting on.
 */
import { rm } from "node:fs/promises";

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
import { relative, resolve, basename } from "node:path";
import pkg from "../package.json";
import { mapLimit } from "./concurrency";
import { bold, dim, green, humanAge, humanBytes, parseBytes, pink, plural, red } from "./format";
import * as ui from "./gum";
import { LiveRegion, SPINNER } from "./live";
import { pick } from "./picker";
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

// ── main ─────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));
const showUi = !opts.json;

if (showUi) {
  await ui.banner(
    "purrge",
    dim(`${opts.root}\n${opts.all ? "every project" : `idle ${opts.weeks}+ weeks`} · min ${humanBytes(opts.min)}`),
  );
}

const cutoff = Date.now() - opts.weeks * 7 * 86_400_000;
const worthPurging = (p: Project) => p.bytes >= opts.min && (opts.all || p.mtime < cutoff);

const started = performance.now();
const projects = await scanWithPreview(opts.root, showUi, worthPurging);
const elapsed = (performance.now() - started) / 1000;

const stale = projects.filter(worthPurging).sort((a, b) => b.bytes - a.bytes);

if (opts.json) {
  console.log(JSON.stringify({ root: opts.root, scanned: projects.length, projects: stale }, null, 2));
  process.exit(0);
}

await ui.note(
  `${plural(projects.length, "project")} scanned in ${elapsed.toFixed(1)}s · ${stale.length} worth purging`,
);

if (!stale.length) {
  await ui.result("Nothing to cough up. Nice and tidy. 🐾");
  process.exit(0);
}

const total = stale.reduce((n, p) => n + p.bytes, 0);
const nameW = Math.max(...stale.map((p) => rel(p.dir).length));
const sizeW = Math.max(...stale.map((p) => humanBytes(p.bytes).length));

const rows = stale.map((p) => ({
  value: p,
  bytes: p.bytes,
  cells: [
    rel(p.dir).padEnd(nameW),
    humanBytes(p.bytes).padStart(sizeW),
    humanAge(p.mtime).padStart(5),
    [...new Set(p.artifacts.map((a) => a.name))].join(" "),
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
    footer: (bytes, count) => `${bold(pink(humanBytes(bytes)))} across ${plural(count, "project")}`,
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

if (opts.dryRun) {
  await ui.result(`Dry run — would cough up ${humanBytes(chosenBytes)} from ${plural(dirCount, "directory", "directories")}.`);
  process.exit(0);
}

if (!opts.yes) {
  const ok = await ui.confirm(
    `Delete ${plural(dirCount, "directory", "directories")} and free ${humanBytes(chosenBytes)}?`,
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
  console.log(`  ${green("✓")} ${rel(p.dir).padEnd(nameW)}  ${dim(humanBytes(sum).padStart(9))}`);
});

await ui.result(
  failed
    ? `Freed ${humanBytes(freed)} — ${plural(failed, "directory", "directories")} refused to budge.`
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

  const region = new LiveRegion();
  const hits: Project[] = [];
  let scanned = 0;
  let frame = 0;

  const paint = () => {
    const spin = pink(SPINNER[frame++ % SPINNER.length]);
    const lines = [
      `  ${spin} sniffing around ${basename(root) || root}… ${dim(
        `${plural(scanned, "project")} · ${hits.length} worth purging`,
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
    return await findProjects(root, (p) => {
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

function rel(dir: string): string {
  return relative(opts.root, dir) || ".";
}

