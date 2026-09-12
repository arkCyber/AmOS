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
import { writeStoreValue } from "../src/lib/amosStore";
import { NOTIF_KEY, SETTINGS_KEY } from "../src/lib/settings";
import { SOUND_KEY } from "../src/lib/sound";

// The chime is asserted, not heard: swap the real (asset-free) Web Audio synth
// for a spy so the arrival *policy* is what's under test.
const tone = vi.hoisted(() => ({ play: vi.fn() }));
vi.mock("../src/lib/notifyTone", () => ({ playNotifyTone: tone.play }));

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

const banner = (c: HTMLElement) =>
  c.querySelector('button[aria-label="notification: acknowledge"]') as HTMLButtonElement | null;

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
});
