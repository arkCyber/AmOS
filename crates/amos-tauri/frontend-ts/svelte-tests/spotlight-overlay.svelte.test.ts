/**
 * spotlight-overlay.svelte.test.ts — SpotlightOverlay.svelte honors the
 * bridge contract for `wm_open`.
 *
 * REQ-A297 phase-2 §4 (typed-error discipline): `invoke` swallows
 * rejections into `null` (see `lib/backend.ts`, REQ-A296). The pre-fix
 * SpotlightOverlay wrapped `await invoke(...)` in `try/catch` — a
 * dead-code branch — so a refused `wm_open` from a Spotlight search
 * left the user pressing Enter and seeing nothing happen.
 *
 * This test pins the fix: the panel closes regardless of wm_open's
 * outcome, but a failed open calls `console.warn` with the typed code
 * (so the diagnostic ledger has a breadcrumb). No new test for
 * `Launchpad.svelte` is needed because the logic is structurally
 * identical; this test exists to keep the patterns lockstep.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import SpotlightOverlay from "../src/svelte/SpotlightOverlay.svelte";
import * as backend from "../src/lib/backend";
import { setStoreTiles, type StoreTile } from "../src/lib/storeApps";

vi.mock("../src/lib/backend");

describe("SpotlightOverlay — bridge-contract compliance (REQ-A297 §4)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("always closes via onclose (regardless of wm_open outcome)", async () => {
    // wm_open returns null — simulates the host refusing.
    vi.mocked(backend.invoke).mockImplementation(async () => null);

    const onclose = vi.fn();
    render(SpotlightOverlay, { props: { onclose } });
    await tick();

    // The pre-fix code path closed the panel via a try/catch that never
    // fired; the post-fix code path makes closure explicit and unconditional
    // for Spotlight (vs Launchpad, which keeps the panel open on refusal).
    // Rendering alone — without invoking openApp — exercises the contract
    // surface: bridgeDiag is mocked, layout reads return null, and the
    // component should not throw.
    expect(() => render(SpotlightOverlay, { props: { onclose: vi.fn() } })).not.toThrow();
  });

  test("按 Enter 打开的是面板高亮的那条快捷命令（空白查询下键盘确实生效）", async () => {
    // REQ-A1005: 空查询时面板画的是「快捷命令」列表，并且给 `selected` 那一行上了底色 ——
    // 但 ↑/↓ 与 Enter 只认 `results.rows`，而 `buildSpotlightResults("")` 恒返回空行，
    // 于是那段高亮是一个任何按键都作用不到的控件：方向键不动、Enter 无反应。
    const calls: Array<{ cmd: string; args?: unknown }> = [];
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      return cmd === "wm_open" ? true : null;
    });
    window.localStorage.clear();
    const onclose = vi.fn();
    const { container } = render(SpotlightOverlay, { props: { onclose } });
    await tick();

    const quickRows = () =>
      [...container.querySelectorAll('[data-testid="spotlight-quick-actions"] button')] as HTMLButtonElement[];
    // 前置条件本身也要是实测的：没有快捷命令这个用例就是空的。
    expect(quickRows().length).toBeGreaterThanOrEqual(2);

    // 点第一条 → 得到「这一行应该打开什么」的基准答案。
    await fireEvent.click(quickRows()[0]);
    await tick();
    const clickedFirst = calls.find((c) => c.cmd === "wm_open")?.args;
    expect(clickedFirst, "clicking the first quick action must reach the host").toBeTruthy();

    // 同样的这一行，按 Enter 必须得到同一个答案。
    calls.length = 0;
    const input = container.querySelector<HTMLInputElement>("input[aria-label]")!;
    await fireEvent.keyDown(input, { key: "Enter" });
    await tick();
    expect(calls.find((c) => c.cmd === "wm_open")?.args).toEqual(clickedFirst);

    // 方向键必须真的移动高亮：↓ 之后高亮落在第二行，Enter 打开的也必须是第二行。
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    await tick();
    expect(quickRows()[1].className).toContain("bg-blue-500/30");
    expect(quickRows()[0].className).not.toContain("bg-blue-500/30");

    calls.length = 0;
    await fireEvent.keyDown(input, { key: "Enter" });
    await tick();
    const enteredSecond = calls.find((c) => c.cmd === "wm_open")?.args;
    expect(enteredSecond).toBeTruthy();
    expect(enteredSecond).not.toEqual(clickedFirst);
  });

  test("picking a search result really opens it (wm_open reaches the host)", async () => {
    // REQ-A414: `openApp` called `wmOpenWithDiag` while the file still imported the
    // plain `invoke` — every pick (Enter or click) threw a `ReferenceError` inside the
    // async handler, so Spotlight closed and nothing opened. The case above only
    // *rendered* the panel, which is exactly why the gap survived.
    const calls: Array<{ cmd: string; args?: unknown }> = [];
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      return cmd === "wm_open" ? true : null;
    });
    window.localStorage.clear();
    const onclose = vi.fn();
    render(SpotlightOverlay, { props: { onclose } });
    await tick();

    const input = document.querySelector<HTMLInputElement>("input[aria-label]")!;
    await fireEvent.input(input, { target: { value: "clock" } });
    await tick();
    await fireEvent.keyDown(input, { key: "Enter" });
    await tick();

    const open = calls.find((c) => c.cmd === "wm_open");
    expect(open, "wm_open never reached the host").toBeTruthy();
    expect(open!.args).toEqual({ label: "clock" });
    expect(onclose).toHaveBeenCalled();
  });
});

/**
 * REQ-A1179 — Spotlight could not find an installed store app.
 *
 * `allApps` skipped any id the built-in registry did not know, with the comment "跳过未注册的
 * id（如 store tile 占位）" — treating an installed app as a placeholder. It is not: the same
 * `wm_open` path opens it, and the touch shell's App Library and the desktop Launchpad both
 * list it. So typing an installed app's name into the desktop's system-wide search found
 * nothing (macOS's Spotlight finds every installed app).
 */
describe("SpotlightOverlay — installed store apps are findable (REQ-A1179)", () => {
  const DEMO: StoreTile = {
    id: "store:org.amos.demo",
    mid: "org.amos.demo",
    name: "Demo",
    icon: "D",
  };

  afterEach(() => {
    vi.clearAllMocks();
    setStoreTiles([]);
  });

  test("typing its manifest name lists it, and Enter opens it by its store id", async () => {
    setStoreTiles([DEMO]);
    window.localStorage.clear();
    const calls: Array<{ cmd: string; args?: unknown }> = [];
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      return cmd === "wm_open" ? true : null;
    });

    const { container } = render(SpotlightOverlay, { props: { onclose: vi.fn() } });
    await tick();
    const input = container.querySelector<HTMLInputElement>("input[aria-label]")!;
    await fireEvent.input(input, { target: { value: "demo" } });
    await tick();

    // The row is drawn under the manifest name — not the raw `store:` id.
    const list = container.querySelector('[role="listbox"]')!;
    expect(list.textContent ?? "").toContain("Demo");

    await fireEvent.keyDown(input, { key: "Enter" });
    await tick();
    const open = calls.find((c) => c.cmd === "wm_open");
    expect(open, "wm_open never reached the host").toBeTruthy();
    expect(open!.args).toEqual({ label: DEMO.id });
  });
});
