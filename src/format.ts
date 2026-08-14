export function humanBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Parse a size like "500M", "1.5g", "250kb" into bytes. */
export function parseBytes(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(input.trim());
  if (!m) throw new Error(`not a size: ${input}`);
  const mult = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()]!;
  return Number(m[1]) * mult;
}

export function humanAge(mtime: number, now = Date.now()): string {
  const days = Math.floor((now - mtime) / 86_400_000);
  if (days < 1) return "today";
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  if (days < 730) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

const esc = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
export const bold = esc("1");
export const dim = esc("2");
export const pink = esc("38;5;212");
export const mauve = esc("38;5;141");
export const green = esc("38;5;42");
export const red = esc("38;5;203");
