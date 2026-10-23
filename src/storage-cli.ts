/**
 * `purrge caches`, `purrge xcode`, `purrge docker`, `purrge tools` — one flow
 * for every provider: scan, say what could not be seen, list what is eligible,
 * show what is held back and what is only worth a look, then let you pick.
 *
 * Held-back findings come back with `--force`. Review-only ones — archives,
 * Docker volumes, models — are never taken by `--yes`, not even with
 * `--force`: they join the picker unticked, and only an explicit tick takes
 * them.
 */
import { relative } from "node:path";
import { appendHistory } from "./history";
import { bold, dim, green, humanAge, humanBytes, parseBytes, pink, plural, red } from "./format";
import * as ui from "./gum";
import { LiveRegion, SPINNER } from "./live";
import { pick } from "./picker";
import { scanProvider } from "./stats";
import { diskSpace, HOME, summarizeFindings, type Issue, type StorageFinding, type StorageProvider, type StorageProviderResult } from "./storage";

type Flags = { yes: boolean; dryRun: boolean; json: boolean; force: boolean; min: number };

export const providerHelp = (p: StorageProvider) => `
${bold(pink(`purrge ${p.name}`))} — ${p.title}

${bold("OPTIONS")}
  -y, --yes         no prompts, remove everything eligible
  -n, --dry-run     list what would go, delete nothing
  -j, --json        machine-readable inventory, never deletes
  -f, --force       include what is held back as in use
  -m, --min <size>  ignore findings below this size (default 1M)
`;

export async function runProviderCommand(provider: StorageProvider, argv: string[], projectRoots: string[]) {
  const flags = parseFlags(provider, argv);

  const result = await withSpinner(`sniffing around ${provider.title}…`, !flags.json, () => scanProvider(provider, projectRoots));

  if (flags.json) {
    console.log(JSON.stringify({ ...result, summary: summarizeFindings(result.findings) }, null, 2));
    return;
  }

  await ui.banner(`purrge ${provider.name}`, dim(provider.title));
  printIssues(result);

  const big = (f: StorageFinding) => (f.allocatedBytes ?? 0) >= flags.min;
  const bySize = (a: StorageFinding, b: StorageFinding) => (b.allocatedBytes ?? 0) - (a.allocatedBytes ?? 0);
  const eligible = result.findings.filter((f) => f.disposition === "eligible" && big(f)).sort(bySize);
  const held = result.findings.filter((f) => f.disposition === "held-back" && big(f)).sort(bySize);
  const review = result.findings.filter((f) => f.disposition === "review-only" && big(f)).sort(bySize);

  const s = summarizeFindings(result.findings);
  await ui.note(
    `${plural(s.count, "finding")} · ${humanBytes(s.bytes)} on disk · ${humanBytes(s.eligibleBytes)} eligible` +
      (s.heldBackCount ? ` · ${humanBytes(s.heldBackBytes)} held back` : "") +
      (s.reviewCount ? ` · ${humanBytes(s.reviewBytes)} review-only` : ""),
  );

  if (held.length) {
    console.log("");
    for (const f of held) console.log(`  ${dim("·")} ${clip(f.label)} ${dim(`${size(f)} held back — ${f.reason}`)}`);
    if (!flags.force) await ui.note(`${plural(held.length, "finding")} kept back — ${bold("--force")} to include ${held.length === 1 ? "it" : "them"}.`);
  }
  if (review.length) {
    console.log("");
    for (const f of review.slice(0, 15)) console.log(`  ${dim("○")} ${clip(f.label)} ${dim(`${size(f)} review only — ${f.reason}`)}`);
    if (review.length > 15) console.log(dim(`    … and ${review.length - 15} more`));
    const actionable = review.some((f) => f.cleanupActionId);
    if (actionable && !flags.force) await ui.note(`review-only items are never removed for you — ${bold("--force")} to pick them by hand.`);
  }

  // What is on offer: eligible, plus held back under --force, plus review-only
  // when someone is there to tick them one by one.
  const offered = [
    ...eligible,
    ...(flags.force ? held : []),
    ...(flags.force && ui.INTERACTIVE && !flags.yes && !flags.dryRun ? review : []),
  ].filter((f) => f.cleanupActionId);

  if (!offered.length) {
    await ui.result(eligible.length ? "Nothing here purrge can remove for you." : "Nothing to cough up. Nice and tidy. 🐾");
    return;
  }

  const nameW = Math.max(...offered.map((f) => clip(f.label).length));
  const sizeW = Math.max(...offered.map((f) => size(f).length));
  const rows = offered.map((f) => ({
    value: f,
    bytes: estimate(f),
    selected: f.disposition !== "review-only",
    cells: [
      clip(f.label).padEnd(nameW),
      size(f).padStart(sizeW),
      (f.lastActivityAt === null ? "—" : humanAge(f.lastActivityAt)).padStart(5),
      dim(f.disposition === "eligible" ? f.detail : `${f.disposition} · ${f.reason}`),
    ],
  }));

  let chosen: StorageFinding[];
  if (flags.dryRun || flags.yes || !ui.INTERACTIVE) {
    console.log("");
    for (const r of rows) console.log(`  ${r.cells.join("  ")}`);
    chosen = offered.filter((f) => f.disposition !== "review-only");
    const total = chosen.reduce((n, f) => n + estimate(f), 0);
    console.log(`\n  ${bold("TOTAL".padEnd(nameW))}  ${bold(humanBytes(total).padStart(sizeW))}\n`);
  } else {
    console.log("");
    const picked = await pick({
      rows,
      header: "  arrows to move · space to toggle · enter when ready",
      footer: (bytes, count) => `${bold(pink(humanBytes(bytes)))} across ${plural(count, "finding")}`,
    });
    if (!picked) return void (await ui.note("Nothing touched."));
    chosen = picked;
  }

  if (!chosen.length) return void (await ui.note("Nothing selected. Nothing touched."));
  const estimated = chosen.reduce((n, f) => n + estimate(f), 0);

  if (flags.dryRun) {
    await ui.result(`Dry run — would cough up about ${humanBytes(estimated)} from ${plural(chosen.length, "finding")}.`);
    return;
  }
  if (!flags.yes && !(await ui.confirm(`Remove ${plural(chosen.length, "finding")}, about ${humanBytes(estimated)}?`, "Cough it up", "Leave it"))) {
    return void (await ui.note("Nothing touched."));
  }

  const report = await cleanFindings(provider, chosen);
  await ui.result(report.message, !report.failed);
}

/**
 * Carry out the chosen cleanups one at a time — several of them are another
 * tool's own command, and two `docker image rm` racing gain nothing — and
 * measure the disk on both sides. What was estimated and what came back are
 * reported separately: shared blocks, hardlinks and Docker's VM all mean the
 * disk can get back less than the rows add up to, or get it back later.
 */
export async function cleanFindings(provider: StorageProvider, chosen: StorageFinding[]) {
  console.log("");
  const before = await diskSpace();
  const nameW = Math.max(...chosen.map((f) => clip(f.label).length));
  let estimated = 0;
  let failed = 0;

  for (const f of chosen) {
    try {
      await provider.clean(f);
      estimated += estimate(f);
      console.log(`  ${green("✓")} ${clip(f.label).padEnd(nameW)}  ${dim(humanBytes(estimate(f)).padStart(9))}`);
    } catch (err) {
      failed++;
      console.log(`  ${red("✗")} ${f.label} — ${(err as Error).message}`);
    }
  }

  const after = await diskSpace();
  await appendHistory({
    kind: "cleanup",
    at: Date.now(),
    provider: provider.name,
    items: chosen.length - failed,
    failed,
    estimatedBytes: estimated,
    freeBefore: before?.freeBytes ?? null,
    freeAfter: after?.freeBytes ?? null,
  });

  const gained = before && after ? after.freeBytes - before.freeBytes : null;
  const disk = gained === null
    ? ""
    : ` Disk free went from ${humanBytes(before!.freeBytes)} to ${humanBytes(after!.freeBytes)}${
        gained < estimated * 0.5 ? " — some space may come back later, or was shared with something else" : ""
      }.`;
  const message = failed
    ? `Removed about ${humanBytes(estimated)} — ${plural(failed, "finding")} refused to budge.${disk}`
    : `Removed about ${humanBytes(estimated)}. 🐱${disk}`;
  return { estimated, failed, gained, message };
}

/** What the provider expects removal to give back; never more than is on disk. */
export function estimate(f: StorageFinding): number {
  return f.reclaimableEstimateBytes ?? f.allocatedBytes ?? 0;
}

/** Long image names and paths keep their start and end; the middle goes. */
export function clip(text: string, max = 56): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - (max - 1 - half))}`;
}

function size(f: StorageFinding): string {
  if (f.allocatedBytes === null) return "?";
  return humanBytes(f.allocatedBytes);
}

/** Missing access must not look like an empty machine. */
export function printIssues(result: StorageProviderResult) {
  const shown = result.issues.filter((i) => i.code !== "missing-tool");
  const missing = result.issues.filter((i) => i.code === "missing-tool");
  if (result.status !== "complete") {
    console.log(`\n  ${pink("!")} ${bold(result.status)} ${dim(statusNote(result.status))}`);
  }
  for (const i of shown.slice(0, 8)) console.log(`  ${pink("!")} ${describeIssue(i)}`);
  if (shown.length > 8) console.log(dim(`    … and ${shown.length - 8} more`));
  if (missing.length) console.log(dim(`  not installed: ${missing.map((i) => i.message.split(" ")[0]).join(", ")}`));
}

export function statusNote(status: StorageProviderResult["status"]): string {
  switch (status) {
    case "partial": return "— some locations could not be read; sizes below are a floor";
    case "unavailable": return "— could not look at all; this is unknown, not empty";
    case "error": return "— the scan failed; this is unknown, not empty";
    default: return "";
  }
}

export function describeIssue(i: Issue): string {
  return i.path ? `${contract(i.path)} ${dim(`— ${i.message}`)}` : i.message;
}

function contract(path: string): string {
  return path.startsWith(HOME + "/") ? `~/${relative(HOME, path)}` : path;
}

function parseFlags(provider: StorageProvider, argv: string[]): Flags {
  const f: Flags = { yes: false, dryRun: false, json: false, force: false, min: 1024 ** 2 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "-h": case "--help": console.log(providerHelp(provider)); process.exit(0);
      case "-y": case "--yes": f.yes = true; break;
      case "-n": case "--dry-run": f.dryRun = true; break;
      case "-j": case "--json": f.json = true; break;
      case "-f": case "--force": f.force = true; break;
      case "-m": case "--min": f.min = parseBytes(argv[++i]); break;
      default:
        console.error(`${red("✗")} unknown argument: ${argv[i]}\nrun ${bold(`purrge ${provider.name} --help`)}`);
        process.exit(1);
    }
  }
  return f;
}

/** A bare spinner: providers come back whole, so there is nothing to preview. */
export async function withSpinner<T>(label: string, show: boolean, work: () => Promise<T>): Promise<T> {
  if (!show || !ui.INTERACTIVE) return work();
  const region = new LiveRegion();
  let frame = 0;
  const paint = () => region.render([`  ${pink(SPINNER[frame++ % SPINNER.length])} ${label}`]);
  process.stdout.write("\x1b[?25l");
  const timer = setInterval(paint, 80);
  paint();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    region.clear();
    process.stdout.write("\x1b[?25h");
  }
}
