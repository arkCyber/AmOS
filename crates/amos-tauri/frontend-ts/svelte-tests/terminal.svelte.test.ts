/**
 * terminal.svelte.test.ts — DOM tests for TerminalApp.svelte (offline-safe demo).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import TerminalApp from "../src/svelte/TerminalApp.svelte";

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

