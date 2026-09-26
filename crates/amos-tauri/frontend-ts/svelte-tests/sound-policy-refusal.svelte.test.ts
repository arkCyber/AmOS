/**
 * REQ-A1374 / F-SH-638 — the shared writer `saveSound` discarded its verdict, and a `void`
 * return made that verdict **structurally unseeable** from any call site.
 *
 * `lib/sound.ts` is the single owner of the durable `amos.sound` key, and that policy has
 * readers other than the page that writes it:
 *
 *   - the notification-arrival ring / haptic gate (`shouldRingOnArrival`,
 *     `shouldVibrateOnArrival`), and
 *   - the incoming-call path (`lib/callTone` reads `loadSound().vibrate`).
 *
 * Three controls write through `saveSound` and each adopted the flip before the write:
 * `SoundPage.toggle` (`prefs = next; saveSound(next);`), `SoundPage.setVolume` (same shape),
 * and `RingtonePage.toggleVibrate` (`sound = flipSound(sound, "vibrate"); saveSound(sound);`).
 * Because the API returned `void`, no caller *could* gate on it — the fix belongs at the
 * owner (return the verdict), not repeated at each call site.
 *
 * The refused screen is worse than a cosmetic lie: 「来电时同时振动」 lit while a call rings
 * silent, and the 触感 / 铃声 switches lit while the arrival gate still reads the old bit.
 *
 * Each case below installs the refusal **after** render (so mount-time reads still work),
 * then asserts the control did not move, the key was never written, and the refusal is drawn.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import SoundPage from "../src/svelte/settings/SoundPage.svelte";
import RingtonePage from "../src/svelte/settings/RingtonePage.svelte";
import { SOUND_KEY, loadSound } from "../src/lib/sound";
import { RINGTONE_KEY, incomingRingPlan } from "../src/lib/callRingtone";
import { readStoreValue } from "../src/lib/amosStore";
import { t } from "../src/svelte/locale.svelte";
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

/** Every `localStorage.setItem` throws — a full or unavailable store, the real refusal path. */
const refuseWrites = () =>
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });

/** The shared refusal line (`StoreErrorBar`), or null. */
const refusal = (container: HTMLElement) =>
  container.querySelector('[data-testid="store-write-error"]');

const switchBy = (container: HTMLElement, name: string) =>
  controlByName<HTMLButtonElement>(container, '[role="switch"]', name);
const checked = (container: HTMLElement, name: string) =>
  switchBy(container, name)?.getAttribute("aria-checked");

describe("REQ-A1374 — 共享写入者丢掉裁决时，任何调用点都看不到它", () => {
  test("声音与触感：「铃声」开关被拒后不动（权威读者是到达响铃门）", async () => {
    const host = render(SoundPage);
    const name = t("settings.notifySound");
    expect(checked(host.container, name)).toBe("true"); // the default

    refuseWrites();
    await fireEvent.click(switchBy(host.container, name)!);
    await settle();

    // The store holds nothing…
    expect(window.localStorage.getItem(SOUND_KEY)).toBeNull();
    // …so the switch must stay where it was: nothing may be claimed that the arrival gate
    // is not honouring.
    expect(checked(host.container, name)).toBe("true");
    expect(refusal(host.container)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("声音与触感：「触感」开关被拒后不动（与铃声同一枚键、同一门）", async () => {
    const host = render(SoundPage);
    const name = t("settings.haptics");
    expect(checked(host.container, name)).toBe("true");

    refuseWrites();
    await fireEvent.click(switchBy(host.container, name)!);
    await settle();

    expect(window.localStorage.getItem(SOUND_KEY)).toBeNull();
    expect(checked(host.container, name)).toBe("true");
    expect(refusal(host.container)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("声音与触感：被拒的音量写入不动滑杆读数", async () => {
    const host = render(SoundPage);
    const slider = host.container.querySelector<HTMLInputElement>('[data-testid="sound-volume"]')!;
    expect(slider.value).toBe("100"); // the default loudness

    refuseWrites();
    slider.value = "40";
    await fireEvent.input(slider);
    await settle();

    expect(window.localStorage.getItem(SOUND_KEY)).toBeNull();
    // The readout is drawn from the policy, not the input element: it must not move.
    // (The native thumb keeps the user's drag until the next re-render — the same residual
    // the ControlCenter brightness slider has; the *claim* is the readout, and it holds.)
    expect(host.container.textContent).toContain("100%");
    expect(refusal(host.container)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("来电铃声：「来电振动」开关被拒后不动 —— 而电话仍然会振动（权威读者是来电路径）", async () => {
    const host = render(RingtonePage);
    const name = t("ringtone.vibrateOnRing");

    expect(checked(host.container, name)).toBe("true"); // the default
    refuseWrites();
    await fireEvent.click(switchBy(host.container, name)!);
    await settle();

    expect(window.localStorage.getItem(SOUND_KEY)).toBeNull();
    // The switch must NOT read "off": the call path decides with exactly this call, and it
    // still says vibrate — showing "off" here would be the page asserting a change the
    // ringer is not making.
    expect(checked(host.container, name)).toBe("true");
    const plan = incomingRingPlan(readStoreValue<unknown>(RINGTONE_KEY, null), loadSound().vibrate);
    expect(plan.vibrate).toBe(true);
    expect(refusal(host.container)?.textContent).toContain(t("common.storeWriteFailed"));
  });
});
