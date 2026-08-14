/**
 * Interactive multi-select list.
 *
 * `gum choose` renders a static list, so it cannot show a running total that
 * responds to what you have ticked. This is the same interaction with a live
 * footer: arrow keys highlight, space toggles, and the reclaimable size updates
 * on every keystroke.
 */
import { bold, dim, pink } from "./format";
import { LiveRegion } from "./live";

export type PickRow<T> = {
  value: T;
  /** Pre-padded columns, plain text — this module adds the colour. */
  cells: string[];
  bytes: number;
};

const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

export type PickOptions<T> = {
  rows: PickRow<T>[];
  header: string;
  /** Rendered under the list, recomputed on every toggle. */
  footer: (bytes: number, count: number) => string;
};

/** @returns the chosen values, or null if the user backed out */
export async function pick<T>({ rows, header, footer }: PickOptions<T>): Promise<T[] | null> {
  const selected = rows.map(() => true);
  let cursor = 0;
  let offset = 0;
  const region = new LiveRegion();
  let done: ((v: T[] | null) => void) | null = null;

  const viewport = () => Math.max(3, Math.min(rows.length, (process.stdout.rows || 24) - 8));

  function frame(): string[] {
    const height = viewport();
    // Keep the cursor inside the window.
    if (cursor < offset) offset = cursor;
    if (cursor >= offset + height) offset = cursor - height + 1;

    const lines = [dim(header), ""];

    if (offset > 0) lines.push(dim(`   ↑ ${offset} more`));
    for (let i = offset; i < Math.min(offset + height, rows.length); i++) {
      const isCursor = i === cursor;
      const box = selected[i] ? "[✓]" : "[ ]";
      const text = `${isCursor ? "❯" : " "} ${box} ${rows[i].cells.join("  ")}`;
      lines.push(isCursor ? bold(pink(text)) : selected[i] ? text : dim(text));
    }
    const hidden = rows.length - (offset + height);
    if (hidden > 0) lines.push(dim(`   ↓ ${hidden} more`));

    const bytes = rows.reduce((n, r, i) => (selected[i] ? n + r.bytes : n), 0);
    const count = selected.filter(Boolean).length;
    lines.push("", `  ${footer(bytes, count)}`);
    lines.push(dim("  space toggle · a all · n none · enter confirm · esc cancel"));
    return lines;
  }

  function draw() {
    region.render(frame());
  }

  function cleanup() {
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.stdin.off("data", onData);
    process.stdout.write(SHOW_CURSOR);
  }

  function finish(value: T[] | null) {
    cleanup();
    // Leave the final frame on screen, cursor below it.
    region.release();
    process.stdout.write("\n");
    done?.(value);
  }

  /**
   * Split a chunk into individual keypresses.
   *
   * Terminals coalesce bytes — key repeat, paste, or a piped stdin can deliver
   * several keys in one event, so matching the whole chunk drops every key but
   * the first.
   *
   * Terminal *replies* land here too. gum asks the terminal for its background
   * colour and cursor position, and the answers (`ESC ] 11 ; rgb:…`) can arrive
   * after gum has exited — by which point we own stdin. Those must be swallowed
   * whole: their leading ESC would otherwise read as "cancel" and tear the list
   * down before the user has touched a key.
   */
  function keys(chunk: string): string[] {
    const out: string[] = [];

    for (let i = 0; i < chunk.length; ) {
      if (chunk[i] !== ESC) {
        out.push(chunk[i++]);
        continue;
      }

      const next = chunk[i + 1];

      if (next === "[") {
        // CSI — arrows, page keys, cursor-position reports.
        let j = i + 2;
        while (j < chunk.length && !/[@-~]/.test(chunk[j])) j++;
        out.push(chunk.slice(i, j + 1));
        i = j + 1;
      } else if (next === "]" || next === "P" || next === "_" || next === "^") {
        // OSC / DCS / APC / PM — a terminal answering a question. Runs until
        // BEL or a string terminator; drop the whole thing.
        let j = i + 2;
        while (j < chunk.length) {
          if (chunk[j] === "\x07") { j++; break; }
          if (chunk[j] === ESC && chunk[j + 1] === "\\") { j += 2; break; }
          j++;
        }
        i = j;
      } else if (next === undefined) {
        out.push(ESC); // a real, standalone Escape
        i++;
      } else {
        i += 2; // ESC-prefixed key we do not handle (alt+key)
      }
    }

    return out;
  }

  let finished = false;

  function onData(buf: Buffer) {
    let dirty = false;

    for (const key of keys(buf.toString())) {
      if (finished) return;

      switch (key) {
        case "\x03": // ctrl-c
        case ESC:
        case "q":
          finished = true;
          return finish(null);
        case "\r":
        case "\n":
          finished = true;
          return finish(rows.filter((_, i) => selected[i]).map((r) => r.value));
        case " ":
          selected[cursor] = !selected[cursor];
          cursor = Math.min(cursor + 1, rows.length - 1); // space-space-space down the list
          break;
        case "a":
          selected.fill(true);
          break;
        case "n":
          selected.fill(false);
          break;
        case "g":
          cursor = 0;
          break;
        case "G":
          cursor = rows.length - 1;
          break;
        case `${ESC}[A`: case "k": cursor = Math.max(0, cursor - 1); break;
        case `${ESC}[B`: case "j": cursor = Math.min(rows.length - 1, cursor + 1); break;
        case `${ESC}[5~`: cursor = Math.max(0, cursor - viewport()); break;
        case `${ESC}[6~`: cursor = Math.min(rows.length - 1, cursor + viewport()); break;
        default:
          continue; // unknown key, nothing to repaint
      }
      dirty = true;
    }

    if (dirty) draw();
  }

  process.stdout.write(HIDE_CURSOR);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", onData);
  draw();

  return new Promise<T[] | null>((resolve) => {
    done = resolve;
  });
}
