/**
 * shell.svelte.test.ts — Svelte top-level Shell decision tree (Phase-3 ③).
 *
 * Drives shellState and asserts Shell renders the matching Svelte surface:
 * lock→LockScreen, edit→EditHome, app→app surface (back→home), home→HomeDock;
 * overlays (Spotlight / Notification Center) open from shellState; Esc closes them.
 * HomeDock/EditHome are fed their controlled channels by Shell from shellState.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import Shell from "../src/svelte/Shell.svelte";
import { resetPropsChannels } from "../src/svelte/propsBus";
import {
  applyLayout,
  enterEdit,
  lock,
  open,
  resetShellState,
  setNc,
  setRecents,
  setSpot,
  layout,
  pulseId,
  unlock,
} from "../src/svelte/shellState.svelte";
import { moveBefore, writeStoreValue, RECENTS_KEY } from "../src/lib/amosStore";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  resetShellState();
});
afterEach(() => {
  resetPropsChannels();
  resetShellState();
});

describe("Shell.svelte (surface decision tree)", () => {
  test("locked surface renders LockScreen", async () => {
    lock();
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    unlock();
  });

  test("home surface renders the Svelte HomeDock", async () => {
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
  });

  test("edit surface renders EditHome (Done action present)", async () => {
    enterEdit();
    const { container } = render(Shell);
    await tick();
    const done = [...container.querySelectorAll("button")].find((b) =>
      (b.className ?? "").includes("bg-accent"),
    );
    expect(done).toBeTruthy();
  });

  test("app surface shows chrome + Back returns home", async () => {
    open("phone");
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector('[data-testid="app-surface"]')).toBeTruthy();
    const back = container.querySelector('button[aria-label="back"]') as HTMLButtonElement | null;
    expect(back).toBeTruthy();
    await fireEvent.click(back!);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
  });

  test("app surface hosts a scrollable region so tall content-flow apps can be paged", async () => {
    open("settings");
    const { container } = render(Shell);
    await tick();
    const surface = container.querySelector('[data-testid="app-surface"]');
    expect(surface).toBeTruthy();
    // the app host is the ScrollView → an overflow-y-auto region exists under the
    // surface chrome (this is what lets a Settings/Phone list scroll on device)
    const host = surface?.querySelector(".overflow-y-auto");
    expect(host).toBeTruthy();
    // and it is bounded (min-h-0 flex-1) so it fills the space under the header
    expect(host?.className ?? "").toContain("min-h-0");
  });

  test("Spotlight overlay opens from shellState and closes on setSpot(false)", async () => {
    setSpot(true);
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector("input[placeholder]")).toBeTruthy();
    setSpot(false);
    await tick();
    expect(container.querySelector("input[placeholder]")).toBeNull();
  });

  test("Notification Center overlay shows quick tiles when opened", async () => {
    setNc(true);
    const { container } = render(Shell);
    await tick();
    expect(container.querySelectorAll('button[aria-pressed]').length).toBeGreaterThanOrEqual(6);
  });

  test("Escape closes an open overlay", async () => {
    setSpot(true);
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector("input[placeholder]")).toBeTruthy();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(container.querySelector("input[placeholder]")).toBeNull();
  });

  test("app surface Home indicator returns to the home surface", async () => {
    open("phone");
    const { container } = render(Shell);
    await tick();
    const home = container.querySelector('button[data-testid="home-indicator"]') as HTMLButtonElement | null;
    expect(home).toBeTruthy();
    await fireEvent.click(home!);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
  });


  test("tapping a HomeDock dock icon opens the app surface via Shell", async () => {
    applyLayout({ page: [], dock: ["phone"], hidden: [] });
    const { container } = render(Shell);
    await tick();
    const phone = container.querySelector(
      `button[aria-label="${zh["app.phone"]}"]`,
    ) as HTMLButtonElement | null;
    expect(phone).toBeTruthy();
    await fireEvent.click(phone!);
    await tick();
    expect(container.querySelector('[data-testid="app-surface"]')).toBeTruthy();
  });

  test("tapping the monitor dock tile opens the System Monitor app surface", async () => {
    applyLayout({ page: [], dock: ["monitor"], hidden: [] });
    const { container } = render(Shell);
    await tick();
    const tile = container.querySelector(
      `button[aria-label="${zh["app.monitor"]}"]`,
    ) as HTMLButtonElement | null;
    expect(tile).toBeTruthy();
    await fireEvent.click(tile!);
    await tick();
    const surf = container.querySelector('[data-testid="app-surface"]');
    expect(surf).toBeTruthy();
    // The app chrome shows the localized title (registry resolved `monitor`).
    expect(surf!.textContent ?? "").toContain(zh["app.monitor"]);
  });

  test("opening the calendar app really mounts its month grid through the registry", async () => {
    open("calendar");
    const { container } = render(Shell);
    await tick();
    const surf = container.querySelector('[data-testid="app-surface"]');
    expect(surf).toBeTruthy();
    expect(surf!.textContent ?? "").toContain(zh["app.calendar"]);
    // The registry's dynamic import resolves and the app screen renders for real
    // (not just the chrome) — the month grid is the calendar's own DOM.
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="cal-grid"]')).toBeTruthy();
    });
    expect(container.querySelectorAll("[data-day]").length).toBe(42);
  });

  test("unlocking from the LockScreen returns Shell to the home surface", async () => {
    lock();
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    const unlockBtn = [...container.querySelectorAll("button")].find(
      (b) => !b.getAttribute("aria-label"),
    );
    expect(unlockBtn).toBeTruthy();
    await fireEvent.click(unlockBtn as HTMLButtonElement);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
  });


  test("NC 'edit home' action routes Shell into the edit surface", async () => {
    setNc(true);
    const { container } = render(Shell);
    await tick();
    const editBtn = [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "edit home",
    );
    expect(editBtn).toBeTruthy();
    await fireEvent.click(editBtn as HTMLButtonElement);
    await tick();
    // Edit surface shows its Done button (bg-accent).
    const done = [...container.querySelectorAll("button")].find((b) =>
      (b.className ?? "").includes("bg-accent"),
    );
    expect(done).toBeTruthy();
  });

  test("choosing a Recents row opens that app via Shell", async () => {
    writeStoreValue(RECENTS_KEY, ["clock"]);
    setRecents(true);
    const { container } = render(Shell);
    await tick();
    const row = container.querySelector(
      `button[aria-label="${zh["app.clock"]}"]`,
    ) as HTMLButtonElement | null;
    expect(row).toBeTruthy();
    await fireEvent.click(row!);
    await tick();
    expect(container.querySelector('[data-testid="app-surface"]')).toBeTruthy();
  });


  test("NC 'search' opens the Spotlight overlay via Shell", async () => {
    setNc(true);
    const { container } = render(Shell);
    await tick();
    // Both the home pill and the NC action carry aria-label="search"; either
    // routes to Spotlight through Shell.
    const search = container.querySelector('button[aria-label="search"]') as HTMLButtonElement | null;
    expect(search).toBeTruthy();
    await fireEvent.click(search!);
    await tick();
    expect(container.querySelector("input[placeholder]")).toBeTruthy();
  });

  test("NC 'lock' routes Shell into the locked surface", async () => {
    setNc(true);
    const { container } = render(Shell);
    await tick();
    const lockBtn = [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "lock",
    );
    expect(lockBtn).toBeTruthy();
    await fireEvent.click(lockBtn as HTMLButtonElement);
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy(); // LockScreen
  });

  test("choosing a Spotlight result soft-launches (stays home + pulses)", async () => {
    setSpot(true);
    const { container } = render(Shell);
    await tick();
    // The home now ships a real default layout (seeded dock + page), so a "时钟"
    // tile also lives on the home page. The Spotlight overlay is rendered AFTER
    // the home content in the DOM, so pick the LAST "时钟" button = the Spotlight
    // result, not the home tile (which would open the app).
    const clocks = [
      ...container.querySelectorAll(`button[aria-label="${zh["app.clock"]}"]`),
    ];
    const spotlightResult = clocks[clocks.length - 1];
    expect(spotlightResult).toBeTruthy();
    await fireEvent.click(spotlightResult!);
    await tick();
    expect(container.querySelector('[data-testid="app-surface"]')).toBeNull(); // stays home
    expect(pulseId()).toBe("clock"); // soft-launch pulse set
  });

  test("App Library entry routes Shell into the library surface and back home", async () => {
    const { container } = render(Shell);
    await tick();
    const entry = container.querySelector(
      'button[data-testid="app-library-entry"]',
    ) as HTMLButtonElement | null;
    expect(entry).toBeTruthy();
    await fireEvent.click(entry!);
    await tick();
    // The library surface (category folders) replaces the home grid.
    expect(container.querySelector('[data-testid="home-grid"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-library"]')).toBeTruthy();
    // Its home indicator returns to the dock home.
    const home = container.querySelector(
      'button[data-testid="library-home-indicator"]',
    ) as HTMLButtonElement | null;
    expect(home).toBeTruthy();
    await fireEvent.click(home!);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
  });


});

  test("HomeDock dock reorder via Shell persists to shellState layout", async () => {
    applyLayout({ page: [], dock: ["phone", "messages"], hidden: [] });
    const { container } = render(Shell);
    await tick();

    const phone = container.querySelector(
      `button[aria-label="${zh["app.phone"]}"]`,
    ) as HTMLButtonElement | null;
    const messages = container.querySelector(
      `button[aria-label="${zh["app.messages"]}"]`,
    ) as HTMLButtonElement | null;
    expect(phone).toBeTruthy();
    expect(messages).toBeTruthy();

    await fireEvent.dragStart(phone!);
    await fireEvent.drop(messages!);
    await tick();

    const expected = moveBefore({ page: [], dock: ["phone", "messages"], hidden: [] }, "phone", "messages");
    expect(layout()).toEqual(expected);
  });


