/**
 * Minimal ANSI → colour-span renderer (pure).
 *
 * Real PTY output carries SGR sequences (`ESC[..m`); demo lines have none. This
 * parser maps a hand-picked subset (bold `1`, fg `30-37`, bright `90-97`) to CSS
 * colours so the Terminal can render them, and drops everything else (cursor /
 * clear codes) safely. Any leftover escape is removed so it can never leak to the
 * DOM as literal control text.
 */

export interface AnsiSpan {
  text: string;
  fg?: string;
  bold?: boolean;
}

const PALETTE: Record<number, string> = {
  30: "#0f0f0f", 31: "#ef4444", 32: "#22c55e", 33: "#eab308",
  34: "#3b82f6", 35: "#d946ef", 36: "#06b6d4", 37: "#e5e7eb",
  90: "#6b7280", 91: "#f87171", 92: "#4ade80", 93: "#facc15",
  94: "#60a5fa", 95: "#f472b6", 96: "#22d3ee", 97: "#f9fafb",
};

/** Parse a string with SGR codes into plain spans (fg/bold only). */
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let fg: string | undefined;
  let bold = false;
  let buf = "";
  const flush = () => {
    if (buf === "") return;
    spans.push({ text: buf, ...(fg ? { fg } : {}), ...(bold ? { bold: true } : {}) });
    buf = "";
  };
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i]!;
    if (c === "\u001b" && input[i + 1] === "[") {
      // consume the CSI sequence (incl. its final letter)
      let j = i + 2;
      while (
        j < n &&
        !((input[j]! >= "a" && input[j]! <= "z") || (input[j]! >= "A" && input[j]! <= "Z"))
      ) {
        j += 1;
      }
      if (j >= n) {
        i = n; // unterminated escape — drop the rest
        continue;
      }
      const code = input.slice(i + 2, j + 1);
      i = j + 1;
      if (code.endsWith("m")) {
        flush();
        const params = code
          .slice(0, -1)
          .split(";")
          .map((p) => Number(p))
          .filter((p) => Number.isFinite(p));
        for (const p of params) {
          if (p === 0) {
            fg = undefined;
            bold = false;
          } else if (p === 1) {
            bold = true;
          } else if (p === 22) {
            bold = false;
          } else if (PALETTE[p] !== undefined) {
            fg = PALETTE[p];
          }
        }
      }
      // non-SGR CSI (cursor/clear) is simply dropped
      continue;
    }
    buf += c;
    i += 1;
  }
  flush();
  return spans;
}

/** True when the text contains any escape sequence (so the UI can mark raw). */
export function hasEscape(text: string): boolean {
  return text.includes("\u001b");
}
