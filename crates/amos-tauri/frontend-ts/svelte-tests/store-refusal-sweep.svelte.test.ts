/**
 * REQ-A1368 / F-SH-632 — the **sweep** half of the family REQ-A1366 opened.
 *
 * REQ-A1366 fixed the two 勿扰 switches (`FocusPage.toggleDnd`, `NotificationsPage.toggleDnd`)
 * on the rule "a store-authoritative flip must not be adopted before the store says the write
 * landed". The sweep for that fix stopped at the two writers of `amos.settings.dnd` — and the
 * same shape is sitting on **six more surfaces**, each with its own store key, each with an
 * **authoritative reader other than the page**:
 *
 *   page / control             key                  the other reader that decides
 *   CellularPage.toggle        amos.cellular        (none — the store *is* the world)
 *   DisplayPage.pickAutoOff    amos.autooff         osAutoOff (the screen-off timer)
 *   DisplayPage.toggleWakeHome amos.wakehome        osWakeHome (the home-button gate)
 *   FocusPage.toggle           amos.focus           (intent ledger; only this page reads it)
 *   FocusSchedule.save         amos.focus.schedule  osFocusWatcher (flips the real DND bit)
 *   RingtonePage.selectRingtone amos.ringtone       lib/callTone (which tone a call rings)
 *   ControlCenter.setBrightnessPct amos.brightness  DesktopShell (the dim overlay)
 *
 * Each was `local = next; writeStoreValue(key, next)` — the local copy moved first, and
 * `writeStoreValue` is `void`. `writeJson` returns `false` **and dispatches no
 * `STORE_CHANGED_EVENT`** on a refused `setItem` ("a failed write changed nothing, so nothing
 * may be announced"), and `createStoreValue`'s `reload` is bound to that event — so nothing
 * ever corrects the page. Four of these are worse than a cosmetic lie: the screen states a
 * timeout / a ringtone / a brightness / a DND schedule that the rest of the system is not
 * obeying, and it will not obey until the store actually holds it.
 *
 * Every case below installs the refusal **after** render (so mount-time reads still work) and
 * asserts the control did not move, the key is untouched, and the refusal is on screen.
 *
 * Honest boundary: these are the six leaves *this round* touched, not an exhaustive sweep of
 * the shape. A seventh leaf, `AccountPage.svelte::persistCloud`, was fixed independently by a
 * concurrent round (REQ-A1367 / F-SH-631 — its `svelte-tests/account-page-refusal.svelte.test.ts`
 * was already on disk before this round's ledgers were written), and this round deliberately
 * leaves it alone so the two rounds' negative-control windows cannot overwrite each other.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import CellularPage from "../src/svelte/settings/CellularPage.svelte";
import DisplayPage from "../src/svelte/settings/DisplayPage.svelte";
import FocusPage from "../src/svelte/settings/FocusPage.svelte";
import FocusSchedule from "../src/svelte/settings/FocusSchedule.svelte";
import RingtonePage from "../src/svelte/settings/RingtonePage.svelte";
import ControlCenter from "../src/svelte/ControlCenter.svelte";
import { CELLULAR_KEY } from "../src/lib/cellular";
import { AUTOOFF_STORE_KEY, WAKE_HOME_KEY } from "../src/lib/display";
import { FOCUS_KEY } from "../src/lib/focusPrefs";
import { FOCUS_SCHEDULE_KEY } from "../src/lib/focusSchedule";
import { RINGTONE_KEY } from "../src/lib/callRingtone";
import { BRIGHTNESS_KEY } from "../src/lib/brightness";
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

/** `raw(key)` — the store's own bytes, or null when the key was never written. */
const raw = (key: string) => window.localStorage.getItem(key);

const switchBy = (container: HTMLElement, name: string) =>
  controlByName<HTMLButtonElement>(container, '[role="switch"]', name);
const checked = (container: HTMLElement, name: string) =>
  switchBy(container, name)?.getAttribute("aria-checked");

describe("REQ-A1368 — 拒写不得被当成生效：同族的其余叶子", () => {
  test("蜂窝网络：被拒的「蜂窝数据」写入不动开关", async () => {
    const host = render(CellularPage);
    const name = t("settings.cellularData");
    expect(checked(host.container, name)).toBe("true"); // the default is data ON

    refuseWrites();
    await fireEvent.click(switchBy(host.container, name)!);
    await settle();

    // The store holds nothing…
    expect(raw(CELLULAR_KEY)).toBeNull();
    // …so the switch must be exactly where it was — the page says nothing it cannot back.
    expect(checked(host.container, name)).toBe("true");
    expect(refusal(host.container)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("显示与亮度：被拒的自动息屏写入不动分段选择（权威读者是 osAutoOff）", async () => {
    const host = render(DisplayPage);
    const group = controlByName<HTMLElement>(
      host.container,
      '[role="radiogroup"]',
      t("settings.autoOff"),
    );
    expect(group).toBeTruthy();
    const option = (label: string) =>
      [...group!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (b) => b.textContent?.trim() === label,
      )!;
    expect(option(t("settings.autoOffOff")).getAttribute("aria-checked")).toBe("true");

    refuseWrites();
    await fireEvent.click(option(t("settings.autoOff30")));
    await settle();

    expect(raw(AUTOOFF_STORE_KEY)).toBeNull();
    // The timer the OS actually runs still uses the old value, so the row must still show it.
    expect(option(t("settings.autoOffOff")).getAttribute("aria-checked")).toBe("true");
    expect(refusal(host.container)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("显示与亮度：被拒的「唤醒回主屏」写入不动开关（权威读者是 osWakeHome）", async () => {
    const host = render(DisplayPage);
    const name = t("settings.wakeHome");
    expect(checked(host.container, name)).toBe("true"); // the default

    refuseWrites();
    await fireEvent.click(switchBy(host.container, name)!);
    await settle();

    expect(raw(WAKE_HOME_KEY)).toBeNull();
    expect(checked(host.container, name)).toBe("true");
    expect(refusal(host.container)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("专注模式：被拒的「工作」意图写入不动开关（与勿扰同一条纪律的邻行）", async () => {
    const host = render(FocusPage);
    const name = t("settings.focusWork");
    expect(checked(host.container, name)).toBe("false");

    refuseWrites();
    await fireEvent.click(switchBy(host.container, name)!);
    await settle();

    expect(raw(FOCUS_KEY)).toBeNull();
    expect(checked(host.container, name)).toBe("false");
    expect(refusal(host.container)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("自动勿扰时段：被拒的时段编辑不动编辑器（权威读者是 osFocusWatcher）", async () => {
    const host = render(FocusSchedule);
    const first = host.container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(first).toBeTruthy();
    expect(first!.getAttribute("aria-checked")).toBe("false");

    refuseWrites();
    await fireEvent.click(first!);
    await settle();

    expect(raw(FOCUS_SCHEDULE_KEY)).toBeNull();
    // The watcher will not silence anything, so the switch must not claim a window exists.
    expect(
      host.container.querySelector<HTMLButtonElement>('[role="switch"]')!.getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
    expect(refusal(host.container)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("铃声：被拒的铃声选择不挪那颗 ✓（权威读者是来电路径）", async () => {
    const host = render(RingtonePage);
    const picked = () =>
      host.container
        .querySelector('[data-testid="ringtone-selected"]')
        ?.closest("button")
        ?.getAttribute("data-testid");
    const before = picked();
    expect(before).toBeTruthy();

    refuseWrites();
    await fireEvent.click(
      host.container.querySelector('[data-testid="ringtone-option-guitar"]')!,
    );
    await settle();

    expect(raw(RINGTONE_KEY)).toBeNull();
    // The call path rings the old tone, so the ✓ must not have moved.
    expect(picked()).toBe(before);
    expect(refusal(host.container)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("控制中心：被拒的亮度写入不动滑杆读数（权威读者是降亮遮罩）", async () => {
    const host = render(ControlCenter);
    await settle();
    const slider = host.container.querySelector(
      '[data-testid="cc-brightness"]',
    ) as HTMLInputElement;
    expect(slider).toBeTruthy();

    refuseWrites();
    slider.value = "40";
    await fireEvent.input(slider);
    await settle();

    expect(raw(BRIGHTNESS_KEY)).toBeNull();
    // DesktopShell's overlay never dimmed, so the readout must still say 100%.
    expect(
      host.container.querySelector('[data-testid="cc-brightness-readout"]')?.textContent,
    ).toContain("100%");
    expect(refusal(host.container)?.textContent).toContain(t("common.storeWriteFailed"));
  });
});
