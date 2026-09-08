/**
 * terminal.svelte.test.ts — DOM tests for TerminalApp.svelte (offline-safe demo).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import TerminalApp from "../src/svelte/TerminalApp.svelte";

afterEach(cleanup);

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
});
