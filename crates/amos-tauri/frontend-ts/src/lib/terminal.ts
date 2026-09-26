/**
 * AmOS Terminal — offline-safe line model (pure, headlessly testable).
 *
 * AmOS ships no real PTY by default (see docs/terminal-design.md): the backend
 * executes nothing unless the `terminal-pty` feature is on in a device build. So
 * the on-screen Terminal here is an HONEST offline shell: it runs a small,
 * built-in safe command set (help/echo/clear/…) and clearly states that a real
 * shell needs the device build. No function here spawns a process — the only
 * "execution" is producing text lines + a clear marker.
 */

export interface TermLine {
  text: string;
  /** How to render the line. */
  kind: "out" | "err" | "cmd" | "muted";
}

/** Result of running one input line: lines to append, and whether to clear. */
export interface TermResult {
  lines: TermLine[];
  clear: boolean;
}

export const PROMPT = "amos:~$";

/**
 * The reply the whole `term_*` family answers, structurally — `term_spawn` /
 * `term_write` / `term_read` / `term_kill` / `term_resize` all return
 * `amos-tauri::terminal::TermOut`.
 *
 * It is **not** a `Result`, which is the trap this interface exists to name: a refusal is
 * *inside* a perfectly successful bridge call (`error` carries the reason, `id` is 0,
 * `running` is false), so `invoke` never folds it to `null` (REQ-A296) and
 * `bridgeDiag("term_write").ok` is **true** for a write the shell never took. Neither
 * `void-cmd-scan` (a `void` command's verdict) nor `read-fold-scan` (a refused read folded
 * into an absence) can see this shape: the failure travels in the *value*, so the only
 * thing that reads it is this predicate.
 */
export interface TermReply {
  /**
   * Live session token; `0` when the call failed. **`0` is not the failure test**: a
   * successful `term_kill` answers `ok(0, None, false)` — id `0`, empty `error` — because
   * the session it names is gone. Only `error` separates the two.
   */
  id: number;
  /** The reason, non-empty on failure (and the *only* field that is). */
  error: string;
  running: boolean;
}

/** Was this `term_*` reply a failure? `null` = no bridge at all (the same failure). */
export function termRefused(reply: TermReply | null): boolean {
  return reply === null || reply.error !== "";
}

/** The reason to show for a refused `term_*` reply, or `""` when there is none to quote. */
export function termRefusalReason(reply: TermReply | null): string {
  return reply === null ? "" : reply.error;
}

/** Honest banner shown at startup. */
export function termBanner(demoNote: string): TermLine[] {
  return [
    { text: "AmOS Terminal", kind: "out" },
    { text: demoNote, kind: "muted" },
    { text: 'Type "help" to see available (offline-safe) commands.', kind: "muted" },
  ];
}

const HELP: TermLine[] = [
  { text: "Available commands (offline-safe demo shell):", kind: "out" },
  { text: "  help            show this help", kind: "cmd" },
  { text: "  echo <text>     print <text> back", kind: "cmd" },
  { text: "  date            print the current date/time (UTC)", kind: "cmd" },
  { text: "  uname           print the OS name", kind: "cmd" },
  { text: "  ver / version   alias of 'about'", kind: "cmd" },
  { text: "  clear           clear the screen", kind: "cmd" },
  { text: "  whoami          print the current user", kind: "cmd" },
  { text: "  about           show build info", kind: "cmd" },
  { text: "  exit / quit     end the session", kind: "cmd" },
  { text: "  (real shell commands need the terminal-pty device build)", kind: "muted" },
];

/** Run one (trimmed) input line against the safe demo command set. Pure. */
export function runTermLine(input: string, about: string, now = Date.now()): TermResult {
  const line = input.trim();
  if (line === "") return { lines: [], clear: false };
  const cmdLine: TermLine = { text: `${PROMPT} ${input}`, kind: "cmd" };

  if (line === "help" || line === "?") return { lines: [cmdLine, ...HELP], clear: false };
  if (line === "clear") return { lines: [cmdLine], clear: true };

  const [head, ...rest] = line.split(/\s+/);
  switch (head) {
    case "echo":
      return { lines: [cmdLine, { text: rest.join(" "), kind: "out" }], clear: false };
    case "date":
      return { lines: [cmdLine, { text: new Date(now).toISOString(), kind: "out" }], clear: false };
    case "uname":
      return { lines: [cmdLine, { text: "amos", kind: "out" }], clear: false };
    case "whoami":
      return { lines: [cmdLine, { text: "amos", kind: "out" }], clear: false };
    case "ver":
    case "version":
    case "about":
      return { lines: [cmdLine, { text: about, kind: "out" }], clear: false };
    case "exit":
    case "quit":
      return { lines: [cmdLine, { text: "session ended", kind: "muted" }], clear: false };
    default:
      return {
        lines: [
          cmdLine,
          { text: `term: unknown command '${line}'`, kind: "err" },
          { text: "  (real shell commands are disabled in this offline demo build)", kind: "muted" },
        ],
        clear: false,
      };
  }
}

/** Keep a bounded command history (newest last), dedup adjacent repeats. */
export function pushHistory(history: string[], input: string, cap = 100): string[] {
  const s = input.trim();
  if (s === "") return history;
  const next = history[history.length - 1] === s ? history : [...history, s];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Cap a transcript to the newest `cap` lines (scrollback buffer). Pure. */
export function capLines(lines: readonly TermLine[], cap = 1000): TermLine[] {
  if (lines.length <= cap) return lines as TermLine[];
  return lines.slice(lines.length - cap);
}

/**
 * Terminal cell geometry → the PTY window size (`term_resize` cols/rows).
 *
 * The host `term_spawn` starts a session at a fixed default (120×24); a real
 * terminal must tell the shell how big it actually is, or interactive programs
 * (wrapping, `vim`/`htop` layout) draw for the wrong grid. Returns `null` when the
 * geometry is not measurable — the honest answer there is to leave the host's
 * default alone rather than invent a size.
 */
export function ptySizeFor(opts: {
  /** Content box (CSS px) available to the character grid. */
  width: number;
  height: number;
  /** One character cell (CSS px). */
  charW: number;
  charH: number;
  minCols?: number;
  minRows?: number;
}): { cols: number; rows: number } | null {
  const { width, height, charW, charH } = opts;
  if (![width, height, charW, charH].every((n) => Number.isFinite(n) && n > 0)) return null;
  const minCols = opts.minCols ?? 20;
  const minRows = opts.minRows ?? 4;
  return {
    cols: Math.max(minCols, Math.floor(width / charW)),
    rows: Math.max(minRows, Math.floor(height / charH)),
  };
}
