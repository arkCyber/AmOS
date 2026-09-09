/**
 * lockscreen.svelte.test.ts — Svelte whole-screen locked surface.
 *
 * Shell shows LockScreen while locked; it emits 'unlock' when the PIN is entered
 * (or immediately when no PIN is configured) and runs an emergency dial. Pure
 * pin/unlock/emergency offline behaviour is what we test here (no daemon).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import LockScreen from "../src/svelte/LockScreen.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { writeStoreValue } from "../src/lib/amosStore";

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
});
afterEach(() => {
  resetPropsChannels();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const key = (c: HTMLElement, aria: string) =>
  c.querySelector(`button[aria-label="${aria}"]`) as HTMLButtonElement | null;

describe("LockScreen.svelte", () => {
  test("with no PIN configured, tapping unlock emits 'unlock'", async () => {
    writeStoreValue("amos.lock", { enabled: false });
    const { container } = render(LockScreen);
    await tick();
    const events: string[] = [];
    const off = propsChannel<{ ready?: boolean }>("lock").on((e) => events.push(e));
    // No keypad when no PIN → the unlock button is the one without an aria-label
    // (the emergency button carries an aria-label).
    const unlock = [...container.querySelectorAll("button")].find((b) => !b.getAttribute("aria-label"));
    expect(unlock).toBeTruthy();
    await fireEvent.click(unlock as HTMLButtonElement);
    expect(events).toContain("unlock");
    off();
  });

  test("entering the correct PIN then ✓ emits 'unlock'", async () => {
    writeStoreValue("amos.lock", { enabled: true, pin: "1234" });
    const { container } = render(LockScreen);
    await tick();
    const events: string[] = [];
    const off = propsChannel<{ ready?: boolean }>("lock").on((e) => events.push(e));
    for (const d of ["1", "2", "3", "4"]) {
      await fireEvent.click(key(container, d)!);
    }
    await fireEvent.click(key(container, "✓")!);
    expect(events).toContain("unlock");
    off();
  });

  test("a wrong PIN shows the failure mark and does NOT unlock", async () => {
    writeStoreValue("amos.lock", { enabled: true, pin: "1234" });
    const { container } = render(LockScreen);
    await tick();
    const events: string[] = [];
    const off = propsChannel<{ ready?: boolean }>("lock").on((e) => events.push(e));
    for (const d of ["9", "9", "9", "9"]) {
      await fireEvent.click(key(container, d)!);
    }
    await fireEvent.click(key(container, "✓")!);
    expect(events).not.toContain("unlock");
    // ✗ failure glyph shown.
    expect((container.textContent ?? "").includes("✗")).toBe(true);
    off();
  });
});

describe("LockScreen.svelte — real battery indicator", () => {
  const settle = () => new Promise((r) => setTimeout(r, 40));
  const lockBatt = (c: HTMLElement) => c.querySelector('[data-testid="lock-battery"]');

  function installBridge(systemHealth: unknown, hostBatteryPayload?: unknown) {
    const invoke = async (cmd: string) => {
      if (cmd === "system_health") return systemHealth;
      if (cmd === "system_host_battery") return hostBatteryPayload ?? null;
      return null;
    };
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      listen: async () => () => {},
    };
  }

  test("renders no battery when no real source reports a level (honest, unobtrusive)", async () => {
    const { container } = render(LockScreen);
    await tick();
    await settle();
    expect(lockBatt(container)).toBeNull();
  });

  test("shows the REAL battery top-right when the host reports a level", async () => {
    installBridge({}, { level_pct: 75, charging: false });
    const { container } = render(LockScreen);
    await tick();
    await settle();
    const b = lockBatt(container);
    expect(b).not.toBeNull();
    expect(b?.textContent ?? "").toContain("75%");
  });
});

