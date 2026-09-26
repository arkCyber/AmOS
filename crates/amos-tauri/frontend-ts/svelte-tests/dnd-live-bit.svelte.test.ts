/**
 * The quick-settings bits (`amos.settings.*`) are **live**, and the surfaces that render them
 * as controls must follow them while they are mounted.
 *
 * `amos.settings.dnd` — the one real Do-Not-Disturb bit — has more than one writer in a single
 * session: `osFocusWatcher` (REQ-A684) writes it on a 30 s tick **and** immediately on every
 * schedule edit, and the desktop Control Center writes the radios. Nine readers already follow
 * the key through `createStoreValue` (`StatusBar`, `Dock`, `HomeDock`, `ControlCenter`,
 * `NotificationCenter`, `DesktopNotificationCenter`, and both arrival banners).
 *
 * The two Settings sub pages that render the bit as a **live switch** — 专注模式 and 通知 —
 * read it once at mount and never subscribed:
 *
 *   const readQuick = () => normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {}));
 *   let qs = $state<QuickSettings>(readQuick());          // ← snapshot; nothing follows it
 *
 * So on 专注模式, whose own screen renders the schedule editor (`<FocusSchedule />`) directly
 * under the switch, enabling a window that covers *now* left the 勿扰 switch showing the
 * mount-time value while the watcher turned the real bit on — and 通知页's switch *and* its
 * 「勿扰模式已开启/关闭」 prose did the same. The 通知 page even states this exact rule at the top
 * of the same file for the notification list it fixed (REQ-A1238) — the DND read one line above
 * that fix was left behind (REQ-A1340 / F-SH-605).
 *
 * Red-first: every case below writes the key the way a *different* surface does and reads the
 * control back. Before the fix they fail with `expected 'false' to be 'true'`; the mount-time
 * cases in `settings-pages-uncovered.svelte.test.ts` and `settings-pages.svelte.test.ts` cannot
 * see it, because a value that never changes after mount is indistinguishable from one that is
 * followed.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import FocusPage from "../src/svelte/settings/FocusPage.svelte";
import NotificationsPage from "../src/svelte/settings/NotificationsPage.svelte";
import SettingsApp from "../src/svelte/SettingsApp.svelte";
import { writeStoreValue, readStoreValue } from "../src/lib/amosStore";
import { SETTINGS_KEY, type QuickSettings } from "../src/lib/settings";
import { FOCUS_SCHEDULE_KEY, type FocusSchedule } from "../src/lib/focusSchedule";
import { focusWatcherTick } from "../src/svelte/osFocusWatcher";
import { t } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";
import { controlByName } from "./a11y-name";

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const switchByLabel = (h: { container: HTMLElement }, name: string) =>
  controlByName<HTMLButtonElement>(h.container, '[role="switch"]', name);
const checked = (h: { container: HTMLElement }, name: string) =>
  switchByLabel(h, name)?.getAttribute("aria-checked");

/** A window that covers *now*, so the watcher's decision is "DND on". */
const coveringNow: FocusSchedule = {
  work: { days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 1439, enabled: true },
  sleep: { days: [0, 1, 2, 3, 4, 5, 6], start: 23 * 60, end: 7 * 60, enabled: false },
};

describe("专注模式页：勿扰开关跟随真实的快速设置位（REQ-A1340）", () => {
  test("the focus-schedule watcher turning DND on moves the switch on the same screen", async () => {
    const host = render(FocusPage);
    expect(checked(host, t("settings.focusDnd"))).toBe("false");

    // The real producer, not a hand-written store poke: `osFocusWatcher` writes
    // `amos.settings.dnd` when a schedule window is running.
    writeStoreValue(FOCUS_SCHEDULE_KEY, coveringNow);
    expect(focusWatcherTick(new Date())).toBe(true);
    await settle();

    // The store really holds the bit the shell honours…
    expect((readStoreValue<QuickSettings>(SETTINGS_KEY, {}) as QuickSettings).dnd).toBe(true);
    // …so the switch above the editor must say so.
    expect(checked(host, t("settings.focusDnd"))).toBe("true");
  });

  test("DND cleared by another surface moves the switch back off", async () => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ dnd: true }));
    const host = render(FocusPage);
    expect(checked(host, t("settings.focusDnd"))).toBe("true");

    // Any other writer — the Control Center overlay, a schedule window ending.
    writeStoreValue(SETTINGS_KEY, { dnd: false });
    await settle();

    expect(checked(host, t("settings.focusDnd"))).toBe("false");
  });

  test("complement: the page's own 勿扰 switch still writes the shared bit (not merely renders it)", async () => {
    const host = render(FocusPage);
    await fireEvent.click(switchByLabel(host, t("settings.focusDnd"))!);
    await settle();

    expect(checked(host, t("settings.focusDnd"))).toBe("true");
    expect((readStoreValue<QuickSettings>(SETTINGS_KEY, {}) as QuickSettings).dnd).toBe(true);
  });
});

describe("通知页：勿扰开关与文案跟随真实的快速设置位（REQ-A1340）", () => {
  test("an external DND write moves both the switch and its prose", async () => {
    const host = render(NotificationsPage);
    const name = t("settings.dnd");
    expect(checked(host, name)).toBe("false");
    expect(host.container.textContent).toContain(t("settings.dndOff"));

    // The focus-schedule watcher (or the Control Center) turns the real bit on.
    writeStoreValue(SETTINGS_KEY, { dnd: true });
    await settle();

    expect(checked(host, name)).toBe("true");
    expect(host.container.textContent).toContain(t("settings.dndOn"));
  });
});

describe("设置索引页：快速设置开关跟随真实的位（REQ-A1340）", () => {
  test("an external radio write moves the index's flight-mode switch", async () => {
    const host = render(SettingsApp);
    const name = zh["settings.airplane"];
    expect(checked(host, name)).toBe("false");

    // The Control Center (or the notification centre) toggles the same bit.
    writeStoreValue(SETTINGS_KEY, { airplane: true });
    await settle();

    expect(checked(host, name)).toBe("true");
  });
});

/**
 * REQ-A1366 / F-SH-630 — the 勿扰 flip was **store-authoritative**, and the pages moved
 * their copy of it *before* the store said whether the write landed.
 *
 * `toggleDnd` is `const next = flipQuick(qs, "dnd"); qs = next; writeStoreValue(...)` — the
 * local `qs` is adopted before `writeJson` is asked anything. Nothing about a DND flip asks a
 * device, so the store **is** the whole world: on success the eager assignment is redundant
 * (`writeJson` dispatches `STORE_CHANGED_EVENT` synchronously, so `quickStore.subscribe`
 * delivers `next` before `writeStoreValue` returns — REQ-A1340 is what made that subscription
 * exist), and on failure it is the entire defect: `writeJson` returns `false` and dispatches
 * *nothing*, so the switch stays lit and 通知页 prints 「勿扰模式已开启」 while no store holds
 * the bit and the shell keeps delivering notifications. `write-scan.mjs` ignores `settings`
 * keys by design ("carry no claim about the user's content"), so no gate saw this.
 */
describe("勿扰开关：一次被存储拒绝的翻转不得被报成已生效（REQ-A1366）", () => {
  /** Make every `localStorage.setItem` throw, exactly as a full/unavailable store would. */
  const refuseWrites = () =>
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

  test("专注模式页：被拒的写入让开关留在原处，并说出原因", async () => {
    const host = render(FocusPage);
    const name = t("settings.focusDnd");
    expect(checked(host, name)).toBe("false");

    refuseWrites();
    await fireEvent.click(switchByLabel(host, name)!);
    await settle();

    // The bit the shell honours never moved…
    expect(readStoreValue<QuickSettings>(SETTINGS_KEY, {})).toEqual({});
    // …so neither may the switch, and the refusal has to be on screen.
    expect(checked(host, name)).toBe("false");
    expect(host.container.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("通知页：被拒的写入不得印出「勿扰模式已开启」", async () => {
    const host = render(NotificationsPage);
    const name = t("settings.dnd");
    expect(checked(host, name)).toBe("false");

    refuseWrites();
    await fireEvent.click(switchByLabel(host, name)!);
    await settle();

    expect(readStoreValue<QuickSettings>(SETTINGS_KEY, {})).toEqual({});
    expect(checked(host, name)).toBe("false");
    // The sentence that asserts the silencing — the loudest false claim of the pair.
    expect(host.container.textContent).not.toContain(t("settings.dndOn"));
    expect(host.container.textContent).toContain(t("common.storeWriteFailed"));
  });
});
