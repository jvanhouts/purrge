/**
 * A block of terminal lines that can be repainted in place.
 *
 * Both the scan preview and the picker draw into one of these: render() rewinds
 * over the previous frame and overwrites it, so the block updates without
 * scrolling the screen or leaving debris when a frame gets shorter.
 */
const ESC = "\x1b";
const CLEAR_LINE = `${ESC}[2K`;

export class LiveRegion {
  private printed = 0;

  constructor(private out: NodeJS.WriteStream = process.stdout) {}

  render(lines: string[]) {
    let s = this.printed ? `${ESC}[${this.printed}A` : "";
    s += lines.map((l) => `${CLEAR_LINE}${l}`).join("\n") + "\n";

    // Wipe whatever the previous, taller frame left behind.
    if (this.printed > lines.length) {
      const extra = this.printed - lines.length;
      s += `${CLEAR_LINE}\n`.repeat(extra) + `${ESC}[${extra}A`;
    }

    this.out.write(s);
    this.printed = lines.length;
  }

  /** Erase the block and park the cursor back at its first line. */
  clear() {
    if (!this.printed) return;
    this.out.write(
      `${ESC}[${this.printed}A` + `${CLEAR_LINE}\n`.repeat(this.printed) + `${ESC}[${this.printed}A`,
    );
    this.printed = 0;
  }

  /** Leave the block on screen and move on. */
  release() {
    this.printed = 0;
  }
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
