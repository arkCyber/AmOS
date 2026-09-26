/**
 * notification-banner.svelte.test.ts — Svelte "notification arrived" toast island.
 *
 * NotificationBanner.svelte shows the newest just-arrived notification as a
 * transient toast (unless Do-Not-Disturb), and tapping acknowledges (clears that
 * app's badge + dismisses). Same shared stores + transient logic as React.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotificationBanner from "../src/svelte/NotificationBanner.svelte";
import NotificationCenter from "../src/svelte/NotificationCenter.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { NOTIF_CAP, NOTIF_KEY, SETTINGS_KEY } from "../src/lib/settings";
import { SOUND_KEY } from "../src/lib/sound";
import { setLocale } from "../src/svelte/locale.svelte";
import { en } from "../src/i18n/locales/en";
import { zh } from "../src/i18n/locales/zh";

// The chime is asserted, not heard: swap the real (asset-free) Web Audio synth
// for a spy so the arrival *policy* is what's under test.
const tone = vi.hoisted(() => ({ play: vi.fn() }));
vi.mock("../src/lib/notifyTone", () => ({ playNotifyTone: tone.play }));

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  window.localStorage.clear();
  setLocale("zh");
});

const banner = (c: HTMLElement) =>
  c.querySelector('[data-testid="notif-ack"]') as HTMLButtonElement | null;

describe("NotificationBanner.svelte", () => {
  test("a newly added notification appears as a toast", async () => {
    const { container } = render(NotificationBanner);
    await tick();
    expect(banner(container)).toBeFalsy();

    writeStoreValue(NOTIF_KEY, [{ id: "n1", app: "信息", title: "小安", time: 1 }]);
    await tick();
    expect(banner(container)).toBeTruthy();
    expect(container.textContent ?? "").toContain("信息");
  });

  // REQ-A983 / F-SH-310: the acknowledge control's accessible name was the hard-coded
  // English literal `notification: acknowledge`, so a zh-UI screen-reader user heard
  // English. It escaped `i18n-scan`'s English-copy check because that check's multi-word
  // shape only accepts word characters (letters / apostrophe / hyphen), and the `:`
  // broke it. The name must now come from the dictionary and follow the locale.
  test("the acknowledge name is localized and follows the locale", async () => {
    const { container } = render(NotificationBanner);
    await tick();
    writeStoreValue(NOTIF_KEY, [{ id: "n1", app: "信息", title: "小安", time: 1 }]);
    await tick();
    const ack = banner(container)!;
    expect(ack.getAttribute("aria-label")).toBe(zh["a11y.acknowledgeNotification"]);
    expect(ack.getAttribute("aria-label")).not.toBe("notification: acknowledge");

    setLocale("en");
    await tick();
    expect(ack.getAttribute("aria-label")).toBe(en["a11y.acknowledgeNotification"]);
  });

  // REQ-A1181 / F-SH-473: a row with neither `app` nor `title` fell back to the hard-coded
  // English literal "Notification", so a zh-UI user read English. It escaped `i18n-scan`
  // because the expression sat on its own line and the text-node matcher required `>{` to
  // be adjacent. The fallback must now come from the dictionary and follow the locale.
  test("a notification with no app or title falls back to localized copy", async () => {
    const { container } = render(NotificationBanner);
    await tick();
    writeStoreValue(NOTIF_KEY, [{ id: "n1", body: "仅正文", time: 1 }]);
    await tick();
    expect(banner(container)).toBeTruthy();
    expect(container.textContent ?? "").toContain(zh["nc.untitled"]);
    expect(container.textContent ?? "").not.toContain("Notification");

    setLocale("en");
    await tick();
    expect(container.textContent ?? "").toContain(en["nc.untitled"]);
  });

  test("Do-Not-Disturb suppresses the toast", async () => {
    writeStoreValue(SETTINGS_KEY, { dnd: true });
    const { container } = render(NotificationBanner);
    await tick();

    writeStoreValue(NOTIF_KEY, [{ id: "n1", app: "信息", title: "hi", time: 1 }]);
    await tick();
    expect(banner(container)).toBeFalsy();
  });

  test("acknowledge clears the app's notifications and dismisses the toast", async () => {
    const { container } = render(NotificationBanner);
    await tick();
    writeStoreValue(NOTIF_KEY, [{ id: "n1", app: "信息", title: "hi", time: 1 }]);
    await tick();
    expect(banner(container)).toBeTruthy();

    await fireEvent.click(banner(container)!);
    await tick();
    expect(banner(container)).toBeFalsy();
    // The acknowledged app's badge is cleared (its notification is gone).
    const remaining = JSON.parse(localStorage.getItem(NOTIF_KEY) ?? "[]") as unknown[];
    expect(remaining).toEqual([]);
  });
});

describe("NotificationBanner.svelte (arrival alert policy)", () => {
  let vibrate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    tone.play.mockClear();
    vibrate = vi.fn();
    // happy-dom has no vibration motor; inject a spy to observe the haptic gate.
    Object.defineProperty(navigator, "vibrate", {
      value: vibrate,
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    window.localStorage.clear();
    delete (navigator as unknown as { vibrate?: unknown }).vibrate;
  });

  /** Mount the banner, then let one notification arrive. */
  async function arrive() {
    render(NotificationBanner);
    await tick();
    writeStoreValue(NOTIF_KEY, [{ id: "n1", app: "信息", time: 1 }]);
    await tick();
  }

  test("an arrival rings and vibrates under the default (all-on) policy", async () => {
    await arrive();
    expect(tone.play).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  test("ring=off mutes the chime but keeps the haptic", async () => {
    writeStoreValue(SOUND_KEY, { ring: false, vibrate: true });
    await arrive();
    expect(tone.play).not.toHaveBeenCalled();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  test("vibrate=off keeps the chime but mutes the haptic", async () => {
    writeStoreValue(SOUND_KEY, { ring: true, vibrate: false });
    await arrive();
    expect(tone.play).toHaveBeenCalledTimes(1);
    expect(vibrate).not.toHaveBeenCalled();
  });

  test("Do-Not-Disturb mutes both (and suppresses the toast)", async () => {
    writeStoreValue(SETTINGS_KEY, { dnd: true });
    await arrive();
    expect(tone.play).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
  });

  test("a legacy {notify,haptics} record still mutes both bits", async () => {
    // The old Settings sound page wrote this shape under the same key.
    writeStoreValue(SOUND_KEY, { notify: false, haptics: false });
    await arrive();
    expect(tone.play).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
  });

  // REQ-A1636 / F-SH-831: `amos.notifications` is capped at `NOTIF_CAP`. At the cap a
  // delivery that really landed pushes the oldest row out, so the list ends up exactly as
  // long as it was. The toast still appears — *it* compares id sets (`newestAddedNotif`) —
  // but the old `prev.length` / `notifs.length` gate read that same arrival as "nothing
  // changed" and the chime and haptic went silent, for good, once the list filled. The
  // gate's fact is the arrival, not the length delta; `osPushWatcher.ts` records replacing
  // that exact fold for its own arrival count (REQ-A589).
  test("a capped arrival (list already at NOTIF_CAP) still rings and vibrates", async () => {
    const full = Array.from({ length: NOTIF_CAP }, (_, i) => ({
      id: `n${i}`,
      app: "信息",
      time: i + 1,
    }));
    writeStoreValue(NOTIF_KEY, full);
    const { container } = render(NotificationBanner);
    await tick();
    // Reading the existing list on mount is not an arrival.
    expect(tone.play).not.toHaveBeenCalled();

    // One delivery lands: the new row evicts the oldest, so the length is unchanged.
    const capped = [{ id: "n-new", app: "信息", time: 9_999 }, ...full.slice(1)];
    expect(capped.length).toBe(NOTIF_CAP);
    writeStoreValue(NOTIF_KEY, capped);
    await tick();

    expect(banner(container)).toBeTruthy();
    expect(tone.play).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  // The other half of the same gate: a list that only *shrank* (a dismissal / clear) is not
  // an arrival, and neither is a re-read of the same list. Without this the fix above would
  // pass for a gate that simply always rings.
  test("a removal does not ring (control against 'always alert')", async () => {
    writeStoreValue(NOTIF_KEY, [
      { id: "n1", app: "信息", time: 1 },
      { id: "n2", app: "信息", time: 2 },
    ]);
    render(NotificationBanner);
    await tick();
    tone.play.mockClear();
    vibrate.mockClear();

    writeStoreValue(NOTIF_KEY, [{ id: "n2", app: "信息", time: 2 }]);
    await tick();
    expect(tone.play).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 没有任何东西到达时，横幅不应该说话（REQ-A1249）
// ============================================================================
//
// 触屏通知中心挂载时曾往共享的 `amos.notifications` 里写三条**演示**通知。那个键是所有
// 通知面共用的，而 `Shell.svelte:936` 的 `NotificationBanner` 挂在 `NotificationCenter`
// （:940）**之前** —— 横幅先读到空表把 prev 记成 `[]`，种子随后落盘，于是外壳把自己刚造
// 出来的一行当成新到达播报：toast + 提示音 + 震动。没有任何投递发生过。
describe("通知中心挂载时不得凭空造出通知（REQ-A1249）", () => {
  test("页面打开时种下的演示通知不会被当成一次到达来播报", async () => {
    const { container } = render(NotificationBanner);
    await tick();
    // 挂载顺序与壳一致：横幅在前，通知中心在后。
    render(NotificationCenter);
    await tick();
    await tick();

    expect(readStoreValue<Array<{ id: string }>>(NOTIF_KEY, [])).toEqual([]);
    expect(banner(container)).toBeFalsy();
    expect(tone.play).not.toHaveBeenCalled();
  });
});
