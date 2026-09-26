/**
 * terminal.svelte.test.ts — DOM tests for TerminalApp.svelte (offline-safe demo).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import TerminalApp from "../src/svelte/TerminalApp.svelte";
import { recentDiag } from "../src/lib/debugLog";

type AnyWin = Record<string, unknown>;
const cleanBridge = () => delete (window as AnyWin).__TAURI_INTERNALS__;
/** Fake term_* bridge: spawn yields a session; term_write collects lines;
 *  term_read returns scripted chunks (here one echo + an ANSI clear + colour). */
function installTermBridge(): { reads: string[][] } {
  const reads: string[][] = [["PTY_OK\r\n"], ["\u001b[2J\u001b[32mGREEN\u001b[0m\r\n"]];
  (window as AnyWin).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "term_spawn") return { id: 7, output: null, error: "", running: true };
      if (cmd === "term_write") return { id: (args?.session as number) ?? 0, output: null, error: "", running: true };
      if (cmd === "term_read") {
        const chunk = reads.shift() ?? [];
        const out = chunk.length ? chunk.join("") : null;
        const running = reads.length > 0;
        return { id: (args?.session as number) ?? 0, output: out, error: "", running };
      }
      if (cmd === "term_kill") return { id: (args?.session as number) ?? 0, output: null, error: "", running: false };
      return null;
    },
  };
  return { reads };
}

afterEach(() => {
  cleanup();
  cleanBridge();
});
const inputOf = (h: { container: HTMLElement }) =>
  h.container.querySelector('input[aria-label="命令"]') as HTMLInputElement | null;
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const run = async (h: { container: HTMLElement }, cmd: string) => {
  const inp = inputOf(h)!;
  await fireEvent.input(inp, { target: { value: cmd } });
  await fireEvent.keyDown(inp, { key: "Enter" });
  await tick();
};

describe("TerminalApp.svelte (offline demo shell)", () => {
  test("starts with the honest banner and echoes input commands", async () => {
    const host = render(TerminalApp);
    expect(txt(host)).toContain("AmOS Terminal");
    expect(txt(host)).toContain("离线演示");
    await run(host, "echo hi");
    expect(txt(host)).toContain("hi");
  });

  test("unknown/real-shell commands are rejected, not executed", async () => {
    const host = render(TerminalApp);
    await run(host, "rm -rf /");
    expect(txt(host)).toContain("unknown command");
    expect(txt(host)).toContain("disabled");
  });

  test("clear wipes the transcript", async () => {
    const host = render(TerminalApp);
    expect(txt(host)).toContain("AmOS Terminal");
    await run(host, "clear");
    expect(txt(host)).not.toContain("AmOS Terminal");
  });

  test("arrow keys recall command history", async () => {
    const host = render(TerminalApp);
    await run(host, "whoami");
    expect(txt(host)).toContain("amos");
    const inp = inputOf(host)!;
    await fireEvent.keyDown(inp, { key: "ArrowUp" });
    await tick();
    expect(inp.value).toBe("whoami");
  });

  test("the command input is focused on open and refocused after each command", async () => {
    const host = render(TerminalApp);
    await tick();
    expect(document.activeElement).toBe(inputOf(host));
    await run(host, "echo x");
    expect(txt(host)).toContain("x");
    expect(document.activeElement).toBe(inputOf(host));
  });

  test("live mode: a real-PTY bridge is polled, decoded, cleared and coloured", async () => {
    installTermBridge();
    const host = render(TerminalApp);
    // let the spawn probe + a few poll ticks run
    await new Promise<void>((r) => setTimeout(r, 450));
    await tick();
    // the stream cleared the screen (junk/echo gone) then printed GREEN (ANSI kept)
    expect(txt(host)).toContain("GREEN");
    expect(txt(host)).not.toContain("PTY_OK"); // cleared by ESC[2J
    const green = host.container.querySelector('span[style*="color: rgb(34, 197, 94)"]') ??
      host.container.querySelector('span[style*="#22c55e"]');
    expect(green).toBeTruthy();
  });

  test("live mode cleans up the PTY session on unmount (no orphan)", async () => {
    installTermBridge();
    let killed = 0;
    const inv = (window as AnyWin).__TAURI_INTERNALS__ as {
      invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown>;
    };
    const original = inv.invoke;
    inv.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "term_kill") killed += 1;
      return original(cmd, args);
    };
    const host = render(TerminalApp);
    await new Promise<void>((r) => setTimeout(r, 60));
    // unmount while a live session is attached
    cleanup();
    await tick();
    expect(killed).toBeGreaterThan(0);
  });

  test("live mode: a kill the host refused leaves a breadcrumb", async () => {
    // The ring is bounded, so window on the monotonic `seq` mark, never a length delta.
    const mark = recentDiag(1)[0]?.seq ?? 0;
    (window as AnyWin).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "term_spawn") return { id: 7, output: null, error: "", running: true };
        if (cmd === "term_kill") {
          // A refusal that is not an exception: the reply says the shell is still there.
          return { id: 7, output: null, error: "terminal: unknown or ended session", running: true };
        }
        return { id: (args?.session as number) ?? 0, output: null, error: "", running: true };
      },
    };
    render(TerminalApp);
    await new Promise<void>((r) => setTimeout(r, 60));
    cleanup();
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    // There is no window left to draw in, so the ledger is the only place "no orphan" can
    // be denied — and a kill the host never confirmed must not pass silently.
    const entry = recentDiag(-1).find((e) => e.seq > mark);
    expect(entry?.msg).toContain("term_kill did not confirm");
    expect(entry?.area).toBe("terminal");
  });

  test("live mode: a refused term_write is not drawn as an entered command", async () => {
    (window as AnyWin).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "term_spawn") return { id: 7, output: null, error: "", running: true };
        if (cmd === "term_write") {
          // The host's real refusal shape: `TermOut` with `id: 0` and the reason in
          // `error` — a successful bridge call, so `invoke` never folds it to `null`.
          return { id: 0, output: null, error: "terminal: write exceeds 4096 bytes", running: false };
        }
        return { id: (args?.session as number) ?? 0, output: null, error: "", running: true };
      },
    };
    const host = render(TerminalApp);
    await new Promise<void>((r) => setTimeout(r, 60)); // the spawn probe attaches
    await run(host, "echo hi");
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    // The host's reason is on screen…
    expect(txt(host)).toContain("terminal: write exceeds 4096 bytes");
    // …and the command is *not* drawn as entered: the shell never took it.
    expect(txt(host)).not.toContain("echo hi");
  });
});

describe("TerminalApp.svelte — PTY window size", () => {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  const saved: Array<[object, string, PropertyDescriptor | undefined]> = [
    [Element.prototype, "clientWidth", Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")],
    [Element.prototype, "clientHeight", Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")],
    [HTMLElement.prototype, "clientWidth", Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")],
    [HTMLElement.prototype, "clientHeight", Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")],
  ];

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = rect;
    for (const [target, key, desc] of saved) {
      if (desc) Object.defineProperty(target, key, desc);
      else delete (target as unknown as Record<string, unknown>)[key];
    }
  });

  /** Make the character probe + container measurable (happy-dom reports 0). */
  function stubMetrics(): void {
    HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
      // A 1-line probe of 100 chars → 600px wide, 15px tall ⇒ 6×15 cells.
      return { width: 600, height: 15, top: 0, left: 0, right: 600, bottom: 15 } as DOMRect;
    };
    // `clientWidth/Height` may be defined on either prototype depending on the DOM
    // implementation, so shadow both.
    for (const proto of [Element.prototype, HTMLElement.prototype]) {
      Object.defineProperty(proto, "clientWidth", { get: () => 800, configurable: true });
      Object.defineProperty(proto, "clientHeight", { get: () => 400, configurable: true });
    }
  }

  test("attaching a real session tells the shell the actual grid size", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    (window as AnyWin).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "term_spawn") return { id: 7, output: null, error: "", running: true };
        return { id: (args?.session as number) ?? 0, output: null, error: "", running: true };
      },
    };
    stubMetrics();
    render(TerminalApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));

    // Without this the PTY stays at the spawn default (120×24) forever, so
    // wrapping / full-screen programs draw for the wrong grid.
    const resize = calls.find((c) => c.cmd === "term_resize");
    expect(resize).toBeTruthy();
    expect(resize!.args?.session).toBe(7);
    const cols = resize!.args?.cols as number;
    const rows = resize!.args?.rows as number;
    expect(Number.isInteger(cols) && cols >= 20).toBe(true);
    expect(Number.isInteger(rows) && rows >= 4).toBe(true);
  });

  test("no resize command in the offline demo (nothing to resize)", async () => {
    const calls: string[] = [];
    (window as AnyWin).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        if (cmd === "term_spawn") return { id: 0, output: null, error: "pty off", running: false };
        return null;
      },
    };
    stubMetrics();
    render(TerminalApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(calls).not.toContain("term_resize");
  });
});

describe("TerminalApp.svelte — a refused resize is not remembered as applied", () => {
  const rect = HTMLElement.prototype.getBoundingClientRect;

  /** happy-dom delivers no ResizeObserver callbacks; capture them so the test can
   *  re-measure the container at the same size, which is exactly what a real one does. */
  function stubObserver(): Array<() => void> {
    const cbs: Array<() => void> = [];
    (globalThis as AnyWin).ResizeObserver = class {
      constructor(cb: () => void) {
        cbs.push(cb);
      }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    };
    for (const proto of [Element.prototype, HTMLElement.prototype]) {
      Object.defineProperty(proto, "clientWidth", { get: () => 800, configurable: true });
      Object.defineProperty(proto, "clientHeight", { get: () => 400, configurable: true });
    }
    HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
      return { width: 600, height: 15, top: 0, left: 0, right: 600, bottom: 15 } as DOMRect;
    };
    return cbs;
  }

  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  afterEach(() => {
    delete (globalThis as AnyWin).ResizeObserver;
    for (const proto of [Element.prototype, HTMLElement.prototype]) {
      for (const key of ["clientWidth", "clientHeight"] as const) {
        delete (proto as unknown as Record<string, unknown>)[key];
      }
    }
    HTMLElement.prototype.getBoundingClientRect = rect;
  });

  /** `lastSize` is the dedup key, so memoising a size the session never took
   *  suppressed the next attempt at that same size and left the PTY on its spawn grid
   *  (120×24) while the box drew the measured one — wrapping and full-screen programs
   *  wrong, with nothing said.
   *
   *  The refusal is **not** a `null` return: `term_resize` answers `TermOut` (not
   *  `Result`), so a refusal is a perfectly successful bridge call carrying `id: 0` and a
   *  reason in `error`. A fixture that stubbed `null` tested a shape the host never
   *  produces, so the guard could stay broken and this test stayed green. */
  test("a refused term_resize leaves the size unremembered, and the next measure retries", async () => {
    const cbs = stubObserver();
    let resizes = 0;
    (window as AnyWin).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "term_spawn") return { id: 7, output: null, error: "", running: true };
        if (cmd === "term_resize") {
          resizes += 1;
          // The host's real refusal shape: a value, not an exception, and not `null`.
          return { id: 0, output: null, error: "terminal: unknown or ended session", running: false };
        }
        // Anything else (term_read / term_write) keeps the session alive, the same
        // shape the passing resize test uses.
        return { id: (args?.session as number) ?? 0, output: null, error: "", running: true };
      },
    };
    render(TerminalApp);
    await tick();
    await settle();
    expect(resizes).toBe(1); // the attach measurement went out

    for (const cb of cbs) cb(); // the box is re-measured at the same size
    await tick();
    await settle();
    // Not memoised → asked again. Before the fix this stayed 1: the failed size was
    // recorded as applied, so the dedup guard swallowed every later attempt.
    expect(resizes).toBe(2);
  });

  // The control. Without it, deleting the dedup guard entirely would pass the test above
  // — and a session that took the resize would be re-told its own size on every frame.
  test("an accepted term_resize is still deduped", async () => {
    const cbs = stubObserver();
    let resizes = 0;
    (window as AnyWin).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "term_spawn") return { id: 7, output: null, error: "", running: true };
        if (cmd === "term_resize") {
          resizes += 1;
          return { id: (args?.session as number) ?? 0, output: null, error: "", running: true };
        }
        return null;
      },
    };
    render(TerminalApp);
    await tick();
    await settle();
    expect(resizes).toBe(1);

    for (const cb of cbs) cb();
    await tick();
    await settle();
    expect(resizes).toBe(1);
  });
});

