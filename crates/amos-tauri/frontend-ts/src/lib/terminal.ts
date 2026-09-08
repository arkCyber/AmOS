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
