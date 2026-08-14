/**
 * Thin wrapper around charmbracelet/gum. Every helper degrades to a plain
 * terminal equivalent when gum is missing or stdout is not a TTY, so purrge
 * stays scriptable.
 */
import { bold, dim, pink } from "./format";

export const GUM = Bun.which("gum");
export const INTERACTIVE = Boolean(GUM) && process.stdout.isTTY && process.stdin.isTTY;

const PINK = "212";
const MUTED = "244";

async function run(args: string[], capture = true) {
  const proc = Bun.spawn([GUM!, ...args], {
    stdin: "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const out = capture ? await new Response(proc.stdout).text() : "";
  const code = await proc.exited;
  return { code, out };
}

/** Big pink title block. */
export async function banner(title: string, subtitle: string) {
  if (!INTERACTIVE) {
    console.log(`${bold(pink(title))} ${dim(subtitle)}`);
    return;
  }
  await run(
    [
      "style", "--border", "rounded", "--border-foreground", PINK,
      "--padding", "0 2", "--margin", "1 0 0 0", "--align", "left",
      `🐱 ${title}`, subtitle,
    ],
    false,
  );
}

export async function confirm(prompt: string, affirmative: string, negative: string): Promise<boolean> {
  if (!INTERACTIVE) {
    process.stdout.write(`${prompt} [y/N] `);
    for await (const line of console) return /^y(es)?$/i.test(line.trim());
    return false;
  }
  const { code } = await run(
    [
      "confirm", prompt,
      "--affirmative", affirmative,
      "--negative", negative,
      "--prompt.foreground", "141",
      "--selected.background", PINK,
      "--selected.foreground", "232",
    ],
    false,
  );
  return code === 0;
}

/** Muted one-liner — gum's `--faint` when available. */
export async function note(text: string) {
  if (!INTERACTIVE) {
    console.log(dim(text));
    return;
  }
  await run(["style", "--foreground", MUTED, text], false);
}

export async function result(text: string, ok = true) {
  if (!INTERACTIVE) {
    console.log(bold(text));
    return;
  }
  await run(
    [
      "style", "--border", "rounded", "--border-foreground", ok ? PINK : "203",
      "--padding", "0 2", "--margin", "1 0", "--bold", text,
    ],
    false,
  );
}
