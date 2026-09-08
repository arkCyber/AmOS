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
