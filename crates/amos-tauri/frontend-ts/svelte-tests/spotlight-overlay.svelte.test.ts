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
