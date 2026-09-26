/**
 * REQ-A790 — the cross-window **page** intent: the desktop Dock's 「打开偏好设置」 row asking this
 * screen to land on its Dock pane.
 *
 * The sibling block is `files.svelte.test.ts`'s "cross-window view intent (the Dock's trash tile,
 * REQ-A783)", and this one deliberately mirrors it case for case. The route is the same (the shared
 * store, because the Dock lives in the launcher's `WebviewWindow` and this screen in its own, so the
 * in-window `settingsChannel` bus reaches nobody), and so are the properties under test:
 *
 *   • the request is served — the screen moves to the page, not merely the window opening;
 *   • the request is **consumed** — a stale destination must never re-fire on a later mount;
 *   • the same page asked twice still fires (the marker is the nonce, not the page);
 *   • a replay at the same nonce does **not** yank the user back to where they were;
 *   • a page this build does not have is ignored, and its value left for a reader that can serve
 *     it;
 *   • the request is written **before the window exists** — `wmOpen("settings")` is
 *     create-or-focus, so on a first click there is no Settings window to receive a broadcast and
 *     the intent is only ever seen as the store's *initial* value. That is why the Dock writes
 *     first and opens second, and why these cases write before `render()`.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import SettingsApp from "../src/svelte/SettingsApp.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { SETTINGS_PAGE_KEY } from "../src/lib/settingsPages";
import { resetShellState, setLayoutSnapshot } from "../src/svelte/shellState.svelte";
import type { LayoutSnapshot } from "../src/lib/wm";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  resetShellState();
  setLocale("zh");
});

const pending = () => readStoreValue<unknown>(SETTINGS_PAGE_KEY, null);
/** The heading of whatever page the screen settled on (the narrow branch's title). */
const heading = (el: HTMLElement) => el.querySelector("h1")?.textContent ?? "";
/** Settle the `$effect`'s subscription, which delivers on a microtask. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
/** The sub page's back-to-index button — the user's *own* way off a page. */
const backButton = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === zh["settings.back"]);
/** Leave the current page the way a user would, not by sending another intent. */
const goBack = async (el: HTMLElement) => {
  await fireEvent.click(backButton(el)!);
  await tick();
};

/** A tablet host snapshot — the same shape `settings-sidebar.svelte.test.ts` uses. */
function snap(over: Partial<LayoutSnapshot>): LayoutSnapshot {
  return {
    screen_w: 900,
    screen_h: 1200,
    split: null,
    candidates: [],
    form: "tablet",
    columns: 2,
    multi_window: true,
    free_resize: false,
    divider_gap: 12,
    ...over,
  };
}

describe("SettingsApp.svelte — cross-window page intent (the Dock's 打开偏好设置 row, REQ-A790)", () => {
  test("a request written BEFORE the window exists still lands on that page, and is consumed", async () => {
    // The Dock's order: the intent is in the store, *then* the window is created. Nothing
    // broadcasts to a window that is not there — the value has to be read at mount.
    writeStoreValue(SETTINGS_PAGE_KEY, { page: "dock", nonce: 41 });
    const { container } = render(SettingsApp);
    await settle();

    expect(heading(container)).toContain(zh["settings.dock.title"]);
    // Consumed: a Settings window opened later finds `null`, not a served request — otherwise
    // every future Settings window would open straight onto the Dock pane.
    expect(pending()).toBeNull();
  });

  test("it lands on the Dock page AND NOT on the index (the two-part route, both halves)", async () => {
    // The failure this pins is the one the row's old comment was afraid of: "Settings opened, and
    // not on the pane you asked for". A request that opened the window without moving the page
    // would look exactly like a working row to anyone asserting only that Settings is up.
    writeStoreValue(SETTINGS_PAGE_KEY, { page: "dock", nonce: 42 });
    const { container } = render(SettingsApp);
    await settle();

    expect(heading(container)).toContain(zh["settings.dock.title"]);
    // …and the index is not what it settled on: the search field and the grouped cards belong to
    // the index alone, so seeing either would mean the screen never left home.
    expect(container.querySelector("input[type=search]")).toBeNull();
    expect(heading(container)).not.toBe(zh["settings.indexTitle"]);
  });

  test("asking for the same page again still fires (the nonce, not the page, is the marker)", async () => {
    writeStoreValue(SETTINGS_PAGE_KEY, { page: "dock", nonce: 43 });
    const { container } = render(SettingsApp);
    await settle();
    expect(heading(container)).toContain(zh["settings.dock.title"]);

    // The user wanders off to another page…
    writeStoreValue(SETTINGS_PAGE_KEY, { page: "about", nonce: 44 });
    await tick();
    await settle();
    expect(heading(container)).toContain(zh["settings.about"]);

    // …and the Dock row is clicked again. Same page, fresh nonce: it must come back, or the row
    // would be dead for every user who had ever already opened the Dock pane.
    writeStoreValue(SETTINGS_PAGE_KEY, { page: "dock", nonce: 45 });
    await tick();
    await settle();
    expect(heading(container)).toContain(zh["settings.dock.title"]);
    expect(pending()).toBeNull();
  });

  test("the same request replayed at the same nonce does NOT yank the user back", async () => {
    // The store can re-announce a change (`store-updated`) without its value having changed — and
    // a served intent must never re-fire, or a background store echo would fight the user's own
    // navigation, dragging them back to the Dock pane every time they clicked away.
    //
    // The user leaves the page **themselves** (the back button), not by a newer intent: that is
    // the situation the rule is about. A newer *request* is a different case and legitimately
    // navigates — a stale older one would too, which is why this replays the nonce that was served.
    writeStoreValue(SETTINGS_PAGE_KEY, { page: "dock", nonce: 46 });
    const { container } = render(SettingsApp);
    await settle();
    expect(heading(container)).toContain(zh["settings.dock.title"]);

    await goBack(container);
    expect(heading(container)).toBe(zh["settings.indexTitle"]);

    writeStoreValue(SETTINGS_PAGE_KEY, { page: "dock", nonce: 46 });
    await tick();
    await settle();
    expect(heading(container)).toBe(zh["settings.indexTitle"]); // stayed where the user put it
  });

  test("a page this build cannot serve is left alone, both the screen and the value", async () => {
    // A newer writer's page name. The screen must not switch to a state no branch of its template
    // renders (an empty detail pane, indistinguishable from a page that legitimately has none), and
    // the value is deliberately **not** cleared: this build cannot serve it, but it also must not
    // destroy an intent that a reader which understands it can.
    writeStoreValue(SETTINGS_PAGE_KEY, { page: "vpn", nonce: 48 });
    const { container } = render(SettingsApp);
    await settle();

    expect(container.querySelector("input[type=search]")).not.toBeNull(); // an ordinary index
    expect(heading(container)).toBe(zh["settings.indexTitle"]);
    expect(pending()).toEqual({ page: "vpn", nonce: 48 });
  });

  test("a non-object in the key is not a request (nothing pending)", async () => {
    window.localStorage.setItem(SETTINGS_PAGE_KEY, JSON.stringify("dock"));
    const { container } = render(SettingsApp);
    await settle();
    expect(heading(container)).toBe(zh["settings.indexTitle"]);
  });

  test("the tablet split layout serves it too — the two template roots are both wired", async () => {
    // The wide branch is a *separate* template root (`settings-split`), and a surface that only
    // worked in the narrow one would be the same defect the Dock row had before this change: a row
    // that works on a phone and does nothing on a tablet.
    setLayoutSnapshot(snap({ screen_w: 900 }));
    writeStoreValue(SETTINGS_PAGE_KEY, { page: "dock", nonce: 49 });
    const { container } = render(SettingsApp);
    await settle();

    const row = container.querySelector('[data-testid="settings-side-dock"]');
    expect(row).not.toBeNull();
    expect(row!.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('[data-testid="settings-detail-placeholder"]')).toBeNull();
    expect(container.querySelector('[data-testid="settings-detail"]')!.textContent).toContain(
      zh["settings.dock.title"],
    );
    expect(pending()).toBeNull();
  });

  test("a refused store write is REPORTED, not swallowed (the row must not lie about where it went)", async () => {
    // The one failure mode a served intent cannot cover: the *clear* did not land. The destination
    // would then still be pending, so the next Settings window would be yanked to a pane the user
    // has long left. `StoreErrorBar` is how the screen says so — and the write-scan makes
    // answering the boolean a gate rather than a matter of taste.
    const orig = window.localStorage.setItem.bind(window.localStorage);
    // Only the *clear* fails: the request itself must land, or the screen never sees one and there
    // is nothing to report. `writeJson` serialises `null` for a clear, so that is the tell.
    window.localStorage.setItem = (k: string, v: string) => {
      if (k === SETTINGS_PAGE_KEY && v === "null") throw new Error("quota");
      orig(k, v);
    };
    try {
      writeStoreValue(SETTINGS_PAGE_KEY, { page: "dock", nonce: 50 });
      const { container } = render(SettingsApp);
      await settle();
      // The page still came up (the request was served)…
      expect(heading(container)).toContain(zh["settings.dock.title"]);
      // …and the fact that it could not be cleared is on screen rather than swallowed.
      expect(container.querySelector('[data-testid="store-write-error"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="store-write-error"]')!.textContent).toContain(
        zh["common.storeWriteFailed"],
      );
    } finally {
      window.localStorage.setItem = orig;
    }
  });

  test("the Dock row's own call site records the intent before the window opens", async () => {
    // `appLinks.openSettingsAt` is the writer; this is the Dock's contract with it — the value is in
    // the store by the time it returns, so a Settings window created *after* the call already has
    // it. (The full click-through lives in the Dock's own suite; this pins the half the Settings
    // screen depends on, and it is here so the two halves are tested against one key.)
    const { openSettingsAt } = await import("../src/svelte/appLinks");
    expect(openSettingsAt("dock")).toBe(true);
    expect(pending()).toEqual({ page: "dock", nonce: expect.any(Number) });
    // …and the screen it is addressed to honours it.
    const { container } = render(SettingsApp);
    await settle();
    expect(heading(container)).toContain(zh["settings.dock.title"]);
  });

  test("a page chosen on the screen itself clears the pending intent (no second landing)", async () => {
    // Ordinary use after a Dock click: the user is on the Dock pane and taps 关于本机. The intent
    // was already served and cleared, so nothing here re-fires — the screen simply goes where the
    // user pressed, which is the property the "consumed" assertions above exist to protect.
    writeStoreValue(SETTINGS_PAGE_KEY, { page: "dock", nonce: 51 });
    const { container } = render(SettingsApp);
    await settle();
    expect(heading(container)).toContain(zh["settings.dock.title"]);

    await goBack(container); // the user's own way off the page
    await fireEvent.click(
      [...container.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(zh["settings.about"]),
      )!,
    );
    await tick();
    expect(heading(container)).toContain(zh["settings.about"]);
    expect(pending()).toBeNull();
  });
});
