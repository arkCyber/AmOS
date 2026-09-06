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
afterEach(() => resetPropsChannels());

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
