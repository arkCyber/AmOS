/**
 * notification-center.svelte.test.ts — Svelte control-center sheet.
 *
 * Shell owns `open` (over propsBus "nc"); quick toggles (dnd/location/etc.),
 * flashlight tile, notification list (dismiss/clear), and shell actions
 * (search/recents/edit/lock) are exercised offline.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotificationCenter from "../src/svelte/NotificationCenter.svelte";
import { pushWatcherTick } from "../src/svelte/osPushWatcher";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { setCellularRadio, clearCellularRadio } from "../src/svelte/cellularRadio";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { NOTIF_KEY, SETTINGS_KEY } from "../src/lib/settings";
import { ROTATION_KEY } from "../src/lib/rotation";
import { BRIGHTNESS_KEY } from "../src/lib/brightness";
import { CELLULAR_KEY, type CellularPrefs } from "../src/lib/cellular";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  clearCellularRadio();
});
afterEach(() => {
  resetPropsChannels();
  clearCellularRadio();
});

async function renderOpen() {
  propsChannel<{ open: boolean }>("nc").set({ open: true });
  const { container } = render(NotificationCenter);
  await tick();
  return container;
}

const tileByIcon = (c: HTMLElement, dataIcon: string) =>
  [...c.querySelectorAll("button[aria-pressed]")].find((b) =>
    b.querySelector(`[data-icon="${dataIcon}"]`),
  ) as HTMLButtonElement | undefined;

describe("NotificationCenter.svelte (controlled via propsBus 'nc')", () => {
  test("renders quick tiles and the flashlight tile when open", async () => {
    const c = await renderOpen();
    expect(c.querySelectorAll('button[aria-pressed]').length).toBeGreaterThanOrEqual(6);
    expect(tileByIcon(c, "wifi")).toBeTruthy(); // wifi
    expect(tileByIcon(c, "flashlight")).toBeTruthy(); // torch tile
  });

  test("toggling Do-Not-Disturb flips its tile and persists", async () => {
    const c = await renderOpen();
    const dnd = tileByIcon(c, "dnd") as HTMLButtonElement;
    expect(dnd.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(dnd);
    await tick();
    const next = tileByIcon(c, "dnd") as HTMLButtonElement;
    expect(next.getAttribute("aria-pressed")).toBe("true");
    expect(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {}).dnd).toBe(true);
  });

  test("dismiss removes a notification; clear reaches the empty state", async () => {
    // 这一例过去以**演示种子**（`seedNotifs` 写进共享存储的那三条）为夹具 —— 存储为空、
    // 页面自己造数据。REQ-A1249 之后夹具必须由测试自己给出。
    writeStoreValue(NOTIF_KEY, [
      { id: "s1", app: "信息", icon: "💬", title: "一", body: "甲", time: 3 },
      { id: "s2", app: "天气", icon: "🌤️", title: "二", body: "乙", time: 2 },
      { id: "s3", app: "AI 助手", icon: "🤖", title: "三", body: "丙", time: 1 },
    ]);
    const c = await renderOpen();
    const count = () => c.querySelectorAll(`button[aria-label="${zh["a11y.dismiss"]}"]`).length;
    expect(count()).toBe(3);

    await fireEvent.click(c.querySelector(`button[aria-label="${zh["a11y.dismiss"]}"]`) as HTMLButtonElement);
    await tick();
    expect(count()).toBe(2);
    await fireEvent.click(c.querySelector(`button[aria-label="${zh["nc.clear"]}"]`) as HTMLButtonElement);
    await tick();
    expect(count()).toBe(0);
    expect(readStoreValue<unknown>(NOTIF_KEY, [])).toEqual([]);
  });

  test("location starts ON and a tap flips it off", async () => {
    const c = await renderOpen();
    const loc = tileByIcon(c, "location") as HTMLButtonElement;
    expect(loc.getAttribute("aria-pressed")).toBe("true"); // default ON
    await fireEvent.click(loc);
    await tick();
    const after = tileByIcon(c, "location") as HTMLButtonElement;
    expect(after.getAttribute("aria-pressed")).toBe("false");
  });

  test("an action button emits its action then close", async () => {
    const c = await renderOpen();
    const events: string[] = [];
    const off = propsChannel<{ open: boolean }>("nc").on((e) => events.push(e));
    await fireEvent.click(c.querySelector(`button[aria-label="${zh["a11y.lock"]}"]`) as HTMLButtonElement);
    expect(events).toContain("lock");
    expect(events).toContain("close");
    off();
  });

  test("cellular module is hidden with no reading — nothing has asked the host", async () => {
    // `null` (never answered), not `{present:false}` (answered "no modem"): the tile
    // hides on both, which is why only the surfaces that *print* a sentence had to
    // learn the difference (REQ-A1539 ∕ F-SH-780).
    const c = await renderOpen();
    expect(c.querySelector('[data-testid="nc-cellular"]')).toBeNull();
  });

  test("cellular module appears ONLY when a real radio is present, with an honest label", async () => {
    // A real (future) signal source reports present + a real signal.
    setCellularRadio({ present: true, signal: 2 });
    const c = await renderOpen();
    await tick();
    const module = c.querySelector('[data-testid="nc-cellular"]');
    expect(module).not.toBeNull();
    // data on (default) + real signal → "connected" text; never a fabricated carrier.
    expect(module?.textContent ?? "").toContain(zh["settings.cellularConnected"]);
  });

  test("cellular module reflects 'data off' honestly when the radio is present", async () => {
    writeStoreValue<CellularPrefs>(CELLULAR_KEY, { data: false, roaming: false });
    setCellularRadio({ present: true, signal: 0 });
    const c = await renderOpen();
    await tick();
    const module = c.querySelector('[data-testid="nc-cellular"]');
    expect(module?.textContent ?? "").toContain(zh["settings.cellularDataOff"]);
  });

describe("NotificationCenter — push deliveries in the one list (REQ-A383)", () => {
  /** A host that records push commands; `push_get_history` is not used here (the
   *  watcher is a separate unit) — the NC renders whatever the store holds. */
  function installPushBridge() {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "push_mark_read") return true;
        return null;
      },
      listen: async () => () => {},
    };
    return calls;
  }

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("a delivery is labelled as push and counted as unread, beside the shell's own", async () => {
    writeStoreValue(NOTIF_KEY, [
      { id: "p1", app: "Mail", title: "Deploy", body: "ready", icon: "📩", time: 20, source: "push", read: false, badge: 3 },
      { id: "s1", app: "时钟", title: "计时结束", icon: "⏱️", time: 10 },
    ]);
    const c = await renderOpen();
    await tick();

    const badges = c.querySelectorAll('[data-testid="nc-push-badge"]');
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toContain(zh["nc.pushBadge"]);
    // Only the push delivery is unread; the shell-made one has no read flag at all.
    expect(c.textContent ?? "").toContain(zh["nc.unread"].replace("{count}", "1"));
    expect(c.querySelectorAll(`button[aria-label="${zh["nc.markRead"]}"]`)).toHaveLength(1);
  });

  test("marking a delivery read updates the store and asks the device", async () => {
    writeStoreValue(NOTIF_KEY, [
      { id: "p1", app: "Mail", title: "Deploy", icon: "📩", time: 20, source: "push", read: false },
    ]);
    const calls = installPushBridge();
    const c = await renderOpen();
    await tick();

    await fireEvent.click(c.querySelector(`button[aria-label="${zh["nc.markRead"]}"]`) as HTMLButtonElement);
    await tick();

    const stored = readStoreValue<Array<{ id: string; read?: boolean; source?: string }>>(NOTIF_KEY, []);
    expect(stored[0]?.read).toBe(true);
    expect(stored[0]?.source).toBe("push");
    // The device's own flag is updated too, so a re-poll does not resurrect it as unread.
    await vi.waitFor(() => expect(calls.some((x) => x.cmd === "push_mark_read")).toBe(true));
    expect(calls.find((x) => x.cmd === "push_mark_read")?.args).toEqual({ id: "p1" });
    // Read → the row stays (the user can still read it) but is no longer offered for marking.
    expect(c.querySelectorAll(`button[aria-label="${zh["nc.markRead"]}"]`)).toHaveLength(0);
    expect(c.textContent ?? "").not.toContain(zh["nc.unread"].replace("{count}", "1"));
  });

  test("dismissing a delivery removes it from the one store, like any other", async () => {
    writeStoreValue(NOTIF_KEY, [
      { id: "p1", app: "Mail", title: "Deploy", icon: "📩", time: 20, source: "push", read: false },
    ]);
    const c = await renderOpen();
    await tick();

    // Dismiss *this* row.
    const row = c.querySelector('[data-testid="nc-notif-p1"]');
    expect(row).not.toBeNull();
    await fireEvent.click(row?.querySelector(`button[aria-label="${zh["a11y.dismiss"]}"]`) as HTMLButtonElement);
    await tick();
    const stored = readStoreValue<Array<{ id: string }>>(NOTIF_KEY, []);
    expect(stored.some((n) => n.id === "p1")).toBe(false);
  });

  test("a delivery that landed before the sheet opened is left alone", async () => {
    // The store already holds a delivery (the watcher can write it at any time).
    writeStoreValue(NOTIF_KEY, [
      { id: "p1", app: "Mail", title: "Deploy", icon: "📩", time: 20, source: "push", read: false },
    ]);
    await renderOpen();
    await tick();
    const stored = readStoreValue<Array<{ id: string }>>(NOTIF_KEY, []);
    expect(stored.map((n) => n.id)).toContain("p1");
  });

  // REQ-A1249：这一页曾经在挂载时往共享存储里写三条**演示**通知。通知陈述的是一次
  // **事件**，不是内容 —— 凭空造行等于报告从未发生的投递，而 `NotificationBanner` 排在
  // 本组件之前（`Shell.svelte:936` 对 :940），会把造出来的最新一条当成刚到达播报
  // （toast + 铃声 + 震动）。空表就说自己是空的，与桌面面板那条「no demo seeding」一致。
  test("存储为空时，打开通知中心不得凭空写出任何通知", async () => {
    await renderOpen();
    await tick();
    expect(readStoreValue<Array<{ id: string }>>(NOTIF_KEY, [])).toEqual([]);
  });

  /**
   * A host that **models the device**: its `history` is what `push_get_history` answers and
   * `push_delete_notification` / `push_clear_history` really change it — which is the only
   * way a test can tell "the shell told the device" from "the shell hoped it would".
   */
  function installDeviceBridge(history: Array<Record<string, unknown>>) {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        switch (cmd) {
          case "push_get_history":
            return history;
          case "push_delete_notification": {
            const id = String(args?.id ?? "");
            const at = history.findIndex((r) => r.id === id);
            if (at < 0) return false;
            history.splice(at, 1);
            return true;
          }
          case "push_clear_history":
            history.length = 0;
            return null;
          case "push_mark_read":
            return true;
          default:
            return null;
        }
      },
      listen: async () => () => {},
    };
    return calls;
  }

  const delivery = (id: string, alert: string, at: number) => ({
    id,
    payload: { aps: { alert } },
    received_at: new Date(at).toISOString(),
    read: false,
  });

  /**
   * The list is a **projection** of the device's history: `push_get_history` is asked again
   * on every poll (`svelte/osPushWatcher`), and the merge adds any record the store does not
   * hold. So a push row removed only from the store is written straight back by the next
   * tick — a few seconds later the notification the user just dismissed is on screen again.
   * The test above stops at the store and never runs a poll, so it pinned the local half
   * green while the delivery came back.
   */
  test("dismissing a delivery tells the device, so the next poll cannot write it back", async () => {
    const history = [delivery("p1", "Deploy", 20)];
    const calls = installDeviceBridge(history);
    writeStoreValue(NOTIF_KEY, [
      { id: "p1", app: "Mail", title: "Deploy", icon: "📩", time: 20, source: "push", read: false },
    ]);
    const c = await renderOpen();
    await tick();

    const row = c.querySelector('[data-testid="nc-notif-p1"]');
    expect(row).not.toBeNull();
    await fireEvent.click(row?.querySelector(`button[aria-label="${zh["a11y.dismiss"]}"]`) as HTMLButtonElement);
    await tick();
    await vi.waitFor(() =>
      expect(calls.some((x) => x.cmd === "push_delete_notification")).toBe(true),
    );
    expect(calls.find((x) => x.cmd === "push_delete_notification")?.args).toEqual({ id: "p1" });

    // The device no longer holds it, so the poll has nothing to re-add.
    expect(await pushWatcherTick(1_000)).toBe(0);
    const stored = readStoreValue<Array<{ id: string }>>(NOTIF_KEY, []);
    expect(stored.some((n) => n.id === "p1")).toBe(false);
  });

  // The same defect one control over: 「清空」wiped the shell's list while the device kept
  // every delivery, so the whole list reappeared on the next tick. The sibling surface
  // (`settings/PushSettings`) has always relayed this clear to the device (REQ-A845).
  test("clearing the sheet tells the device, so the next poll cannot write the list back", async () => {
    const history = [delivery("p1", "Deploy", 20), delivery("p2", "Build", 10)];
    const calls = installDeviceBridge(history);
    writeStoreValue(NOTIF_KEY, [
      { id: "p1", app: "Mail", title: "Deploy", icon: "📩", time: 20, source: "push", read: false },
      { id: "p2", app: "CI", title: "Build", icon: "📩", time: 10, source: "push", read: false },
    ]);
    const c = await renderOpen();
    await tick();

    await fireEvent.click(c.querySelector(`button[aria-label="${zh["nc.clear"]}"]`) as HTMLButtonElement);
    await tick();
    await vi.waitFor(() => expect(calls.some((x) => x.cmd === "push_clear_history")).toBe(true));

    expect(await pushWatcherTick(1_000)).toBe(0);
    expect(readStoreValue<unknown>(NOTIF_KEY, [])).toEqual([]);
  });
});

});


describe("NotificationCenter — platform-managed switches (REQ-A202)", () => {
  /**
   * Fake bridge: the platform owns whichever radios `managed` lists. This is the answer
   * the S5 gives for wifi/bluetooth/airplane (Android 14), and the one the pre-change UI
   * could not even see — a tile tap simply did nothing. `setReply` overrides the
   * structured `radio_set` answer (REQ-A203) to stage refusals.
   */
  function installBridge(opts: { managed: string[]; openOk?: boolean; setReply?: unknown; status?: unknown }) {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        switch (cmd) {
          case "radio_status":
            return (
              opts.status ?? { wifi: false, bluetooth: false, airplane: false, hotspot: false }
            );
          case "radio_control": {
            const key = String(args?.key ?? "");
            const isManaged = opts.managed.includes(key);
            return {
              radio: key,
              app_controlled: !isManaged,
              surface: isManaged ? "wifi_panel" : null,
              reason: isManaged ? "switch_removed" : null,
            };
          }
          case "radio_open_settings":
            return opts.openOk ?? true;
          case "radio_set":
            return (
              opts.setReply ?? {
                radio: "wifi",
                requested: true,
                applied: true,
                state: { wifi: true, bluetooth: false, airplane: false, hotspot: false },
                refusal: null,
              }
            );
          default:
            return null;
        }
      },
      listen: async () => () => {},
    };
    return calls;
  }

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

describe("NotificationCenter — airplane mode marks the switches it owns (REQ-A1082)", () => {
  /**
   * The same hole the desktop Control Center had: `tapRadio` answers `{ kind: "gated" }`
   * under airplane mode and `toggleRadio` drops it, so the Wi-Fi / Bluetooth tiles stayed
   * live-looking and did nothing at all on a tap. The platform-owned marking already exists
   * on these tiles (REQ-A202, the ⚙ glyph); a switch the *airplane gate* owns gets the same
   * treatment — marked before the tap, with `settings.airplaneBlocks` on screen.
   */
  test("under airplane mode the gated tiles are disabled and the reason is on screen", async () => {
    installBridge({
      managed: [],
      status: { wifi: true, bluetooth: true, airplane: true, hotspot: false },
    });
    const c = await renderOpen();
    await vi.waitFor(() =>
      expect(tileByIcon(c, "airplane")?.getAttribute("aria-pressed")).toBe("true"),
    );
    expect(
      tileByIcon(c, "wifi")?.disabled,
      "Wi-Fi cannot work under airplane mode — the tile must not look live",
    ).toBe(true);
    expect(tileByIcon(c, "bluetooth")?.disabled).toBe(true);
    // Being dead is not enough: a tile that still *reads* pressed contradicts the sentence
    // rendered a few lines below it on the same screen. Airplane mode owns these radios, so
    // they read off — the snapshot above deliberately has both of their bits set (REQ-A1082).
    expect(
      tileByIcon(c, "wifi")?.getAttribute("aria-pressed"),
      "a gated Wi-Fi tile must not read lit above the line that says Wi-Fi is closed",
    ).toBe("false");
    expect(tileByIcon(c, "bluetooth")?.getAttribute("aria-pressed")).toBe("false");
    expect(
      tileByIcon(c, "airplane")?.disabled,
      "the airplane switch itself is the one that can still be tapped",
    ).toBe(false);
    expect(c.querySelector('[data-testid="nc-airplane-blocks"]')?.textContent?.trim()).toBe(
      zh["settings.airplaneBlocks"],
    );
  });

  test("control: with airplane off the tiles are live and nothing is explained away", async () => {
    installBridge({
      managed: [],
      status: { wifi: false, bluetooth: false, airplane: false, hotspot: false },
    });
    const c = await renderOpen();
    await tick();
    expect(tileByIcon(c, "wifi")?.disabled).toBe(false);
    expect(c.querySelector('[data-testid="nc-airplane-blocks"]')).toBeNull();
  });
});

  test("a switch the platform owns is marked, explained, and opens system settings instead of a doomed write", async () => {
    const calls = installBridge({ managed: ["wifi", "bluetooth", "airplane"] });
    const c = await renderOpen();
    await vi.waitFor(() => expect(c.querySelectorAll('[data-managed="system"]').length).toBe(3));

    // Every managed radio gets its own sentence (the platforms differ per radio).
    const notes = [...c.querySelectorAll('[data-testid="nc-radio-managed"]')]
      .map((e) => e.textContent ?? "")
      .join(" | ");
    expect(notes).toContain(zh["radio.managed.wifi"]);
    expect(notes).toContain(zh["radio.managed.bluetooth"]);
    expect(notes).toContain(zh["radio.managed.airplane"]);

    calls.length = 0;
    await fireEvent.click(tileByIcon(c, "wifi") as HTMLButtonElement);
    await vi.waitFor(() =>
      expect(calls.some((x) => x.cmd === "radio_open_settings")).toBe(true),
    );
    // The request carries the radio key; the surface is resolved Rust-side from the same
    // capability answer, so the UI cannot drift into opening the wrong screen.
    expect(calls.find((x) => x.cmd === "radio_open_settings")?.args).toEqual({ key: "wifi" });
    expect(
      calls.some((x) => x.cmd === "radio_set"),
      "no write may be attempted on a switch the platform owns",
    ).toBe(false);
  });

  test("a system surface that will not open is reported, never swallowed", async () => {
    installBridge({ managed: ["wifi"], openOk: false });
    const c = await renderOpen();
    await vi.waitFor(() => expect(c.querySelectorAll('[data-managed="system"]').length).toBe(1));

    await fireEvent.click(tileByIcon(c, "wifi") as HTMLButtonElement);
    await vi.waitFor(() =>
      expect(c.querySelector('[data-testid="nc-radio-managed-failed"]')?.textContent).toContain(
        zh["radio.openSettingsFailed"],
      ),
    );
  });

  test("an app-controlled radio keeps the old path: the switch is attempted", async () => {
    const calls = installBridge({ managed: [] });
    const c = await renderOpen();
    await tick();
    // No answer said "managed", so nothing is claimed and no note is shown.
    expect(c.querySelectorAll('[data-managed="system"]').length).toBe(0);
    expect(c.querySelector('[data-testid="nc-radio-managed"]')).toBeNull();

    await fireEvent.click(tileByIcon(c, "wifi") as HTMLButtonElement);
    await vi.waitFor(() => expect(calls.some((x) => x.cmd === "radio_set")).toBe(true));
    expect(calls.find((x) => x.cmd === "radio_set")?.args).toEqual({ key: "wifi", enabled: true });
    expect(calls.some((x) => x.cmd === "radio_open_settings")).toBe(false);
  });

  test("a device refusal is a visible sentence, not a dead tap (REQ-A203)", async () => {
    // The S5's actual shape: the write was attempted, the platform said no *this time*,
    // and the state was re-read (it did not move). Before this answer became structured
    // the invoke failed, `null` came back, and the tap looked like nothing happened.
    const calls = installBridge({
      managed: [],
      setReply: {
        radio: "wifi",
        requested: true,
        applied: false,
        state: { wifi: false, bluetooth: false, airplane: false, hotspot: false },
        refusal: {
          kind: "provider_refused",
          radio: null,
          surface: null,
          reason: null,
          detail: "the platform refused to switch Wi-Fi on (setWifiEnabled returned false)",
        },
      },
    });
    const c = await renderOpen();
    await fireEvent.click(tileByIcon(c, "wifi") as HTMLButtonElement);
    await vi.waitFor(() =>
      expect(c.querySelector('[data-testid="nc-radio-refused"]')?.textContent).toContain(
        zh["radio.refused.device"],
      ),
    );
    // No surface is named, so no way out is offered — and none is invented.
    expect(c.querySelector('[data-testid="nc-radio-refused-open-settings"]')).toBeNull();
    // The tile did not flip: the screen shows the re-read state, not the request.
    expect((tileByIcon(c, "wifi") as HTMLButtonElement).getAttribute("aria-pressed")).toBe("false");
    expect(calls.some((x) => x.cmd === "radio_open_settings")).toBe(false);
  });

  test("a refusal that names a surface offers the real switch (REQ-A203)", async () => {
    // A stale `radio_control` said "app-controlled", the write was refused as
    // platform-managed: the structured answer carries the surface, so the sheet can
    // still hand the user to the system settings instead of dead-ending.
    const calls = installBridge({
      managed: [],
      setReply: {
        radio: "wifi",
        requested: true,
        applied: false,
        state: { wifi: true, bluetooth: false, airplane: false, hotspot: false },
        refusal: {
          kind: "platform_managed",
          radio: "wifi",
          surface: "wifi_panel",
          reason: "switch_removed",
          detail: "the platform owns the Wi-Fi switch",
        },
      },
    });
    const c = await renderOpen();
    await fireEvent.click(tileByIcon(c, "wifi") as HTMLButtonElement);
    await vi.waitFor(() =>
      expect(c.querySelector('[data-testid="nc-radio-refused"]')?.textContent).toContain(
        zh["radio.managed.wifi"],
      ),
    );
    await fireEvent.click(
      c.querySelector('[data-testid="nc-radio-refused-open-settings"]') as HTMLButtonElement,
    );
    await vi.waitFor(() =>
      expect(calls.find((x) => x.cmd === "radio_open_settings")?.args).toEqual({ key: "wifi" }),
    );
  });

  test("a refusal nobody understands still says that something was refused", async () => {
    // An unknown kind may not be dressed up as a reason it was never given — but the
    // tap did nothing, and that fact itself must be visible (REQ-A203).
    installBridge({
      managed: [],
      setReply: {
        radio: "bluetooth",
        requested: true,
        applied: false,
        state: { wifi: false, bluetooth: false, airplane: false, hotspot: false },
        refusal: { kind: "brain_lock", radio: null, surface: null, reason: null, detail: "?" },
      },
    });
    const c = await renderOpen();
    await fireEvent.click(tileByIcon(c, "bluetooth") as HTMLButtonElement);
    await vi.waitFor(() =>
      expect(c.querySelector('[data-testid="nc-radio-refused"]')?.textContent).toContain(
        zh["radio.refused.unknown"],
      ),
    );
  });
});

describe("NotificationCenter — rotation lock / forced orientation (REQ-A677)", () => {
  /** Fake host: `available` decides whether the tile claims the platform can rotate;
   *  `outcomeState` is what `rotation_set` answers (host_only / applied / denied / …). */
  function installBridge(opts: { available: boolean; outcomeState: string }) {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        switch (cmd) {
          case "rotation_get":
            return { mode: "auto", available: opts.available };
          case "rotation_set":
            return {
              mode: String(args?.mode ?? "auto"),
              available: opts.available,
              outcome: { state: opts.outcomeState },
            };
          default:
            return null;
        }
      },
      listen: async () => () => {},
    };
    return calls;
  }

  /**
   * A **bridged** host that never answers: every command resolves `null` — which is exactly
   * what `invoke` gives back for a command that *failed* (it never rejects; the reason lands
   * in `bridgeDiag`). So this is "the host is there but unreachable", not "no host at all".
   */
  function installDeadBridge() {
    const calls: string[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        return null;
      },
      listen: async () => () => {},
    };
    return calls;
  }

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("a host that never answers rotation_get is not reported as unable to rotate (REQ-A1274)", async () => {
    const calls = installDeadBridge();
    const c = await renderOpen();
    await vi.waitFor(() => expect(calls).toContain("rotation_get"));

    const tile = c.querySelector('[data-testid="nc-rotation"]');
    // The failed read must NOT be worded as a fact about the device…
    expect(tile?.textContent ?? "").not.toContain(zh["rotation.unavailable"]);
    // …it says what actually happened instead.
    expect(c.querySelector('[data-testid="nc-rotation-read-failed"]')?.textContent).toContain(
      zh["rotation.readFailed"],
    );
  });

  test("a host that answers available:true shows the mode, not the read-failure (REQ-A1274)", async () => {
    const calls = installBridge({ available: true, outcomeState: "applied" });
    const c = await renderOpen();
    await vi.waitFor(() => expect(calls.some((x) => x.cmd === "rotation_get")).toBe(true));

    // Positive leaf: an ANSWERED read leaves no trace of either honest caveat.
    expect(c.querySelector('[data-testid="nc-rotation-read-failed"]')).toBeNull();
    const tile = c.querySelector('[data-testid="nc-rotation"]');
    expect(tile?.textContent ?? "").toContain(zh["rotation.auto"]);
    expect(tile?.textContent ?? "").not.toContain(zh["rotation.unavailable"]);
  });

  test("a tap whose rotation_set never answers says so instead of doing nothing (REQ-A1274)", async () => {
    const calls = installDeadBridge();
    const c = await renderOpen();
    await vi.waitFor(() => expect(calls).toContain("rotation_get"));

    await fireEvent.click(c.querySelector('[data-testid="nc-rotation-locked"]') as HTMLButtonElement);
    await vi.waitFor(() => expect(calls).toContain("rotation_set"));
    await tick();

    // The silent no-op is gone: the reply that never came is stated…
    expect(c.querySelector('[data-testid="nc-rotation-note"]')?.textContent).toContain(
      zh["rotation.setFailed"],
    );
    // …and nothing was claimed to have happened (the mode is still auto, nothing stored).
    expect(
      c.querySelector('[data-testid="nc-rotation-locked"]')?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(readStoreValue<unknown>(ROTATION_KEY, null)).toBeNull();
  });

  test("renders the four modes with Auto selected and persists an offline tap", async () => {
    const c = await renderOpen();
    const tile = c.querySelector('[data-testid="nc-rotation"]');
    expect(tile).not.toBeNull();
    for (const m of ["auto", "locked", "portrait", "landscape"]) {
      expect(c.querySelector(`[data-testid="nc-rotation-${m}"]`)).not.toBeNull();
    }
    // Default is auto (un-locked): the tile is not frozen.
    expect(
      c.querySelector('[data-testid="nc-rotation-auto"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(tile?.getAttribute("data-frozen")).toBe("false");

    // No host bridge: the intent is stored locally (still a real toggle).
    await fireEvent.click(c.querySelector('[data-testid="nc-rotation-locked"]') as HTMLButtonElement);
    await tick();
    expect(
      c.querySelector('[data-testid="nc-rotation-locked"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    // Locking is a freeze (the tile says so — `rotationFreezes`).
    expect(
      c.querySelector('[data-testid="nc-rotation"]')?.getAttribute("data-frozen"),
    ).toBe("true");
    expect(readStoreValue<{ mode: string }>(ROTATION_KEY, { mode: "" }).mode).toBe("locked");
  });

  test("a host that cannot rotate says so instead of pretending", async () => {
    installBridge({ available: false, outcomeState: "host_only" });
    const c = await renderOpen();
    await vi.waitFor(() =>
      expect(c.querySelector('[data-testid="nc-rotation"]')?.textContent).toContain(
        zh["rotation.unavailable"],
      ),
    );
  });

  test("a device tap commits the mode and a host_only answer shows no error", async () => {
    const calls = installBridge({ available: true, outcomeState: "host_only" });
    const c = await renderOpen();
    await vi.waitFor(() => expect(calls.some((x) => x.cmd === "rotation_get")).toBe(true));

    await fireEvent.click(c.querySelector('[data-testid="nc-rotation-landscape"]') as HTMLButtonElement);
    await vi.waitFor(() =>
      expect(calls.find((x) => x.cmd === "rotation_set")?.args).toEqual({ mode: "landscape" }),
    );
    await tick();
    // host_only is not a failure — the intent is stored and the host has no orientation.
    expect(c.querySelector('[data-testid="nc-rotation-note"]')).toBeNull();
  });

  test("a device refusal is a visible sentence, not a dead tap (REQ-A677)", async () => {
    installBridge({ available: true, outcomeState: "denied" });
    const c = await renderOpen();
    await fireEvent.click(c.querySelector('[data-testid="nc-rotation-portrait"]') as HTMLButtonElement);
    await vi.waitFor(() =>
      expect(c.querySelector('[data-testid="nc-rotation-note"]')?.textContent).toContain(
        zh["rotation.notApplied"],
      ),
    );
  });

  describe("brightness slider (G-β-1, shared with the desktop overlay)", () => {
    test("the slider is labelled, shows its scope hint, and starts at 100%", async () => {
      const c = await renderOpen();
      const slider = c.querySelector('[data-testid="nc-brightness"]') as HTMLInputElement;
      expect(slider).toBeTruthy();
      expect(slider.getAttribute("aria-label")).toBe(zh["cc.brightness"]);
      // The desktop's "Desktop only" scope line is NOT reused here — on a phone the
      // WebView is the whole device, so that copy would be wrong.
      const block = c.querySelector('[data-testid="nc-brightness-block"]');
      expect(block!.textContent ?? "").toContain(zh["nc.brightnessHint"]);
      expect(c.querySelector('[data-testid="nc-brightness-readout"]')?.textContent).toContain("100%");
    });

    test("dragging the slider writes the {pct} shape to amos.brightness", async () => {
      const c = await renderOpen();
      await fireEvent.input(c.querySelector('[data-testid="nc-brightness"]') as HTMLInputElement, {
        target: { value: "40" },
      });
      await tick();
      expect(JSON.parse(window.localStorage.getItem(BRIGHTNESS_KEY) ?? "null")).toEqual({ pct: 40 });
      expect(c.querySelector('[data-testid="nc-brightness-readout"]')?.textContent).toContain("40%");
    });

    test("a stored value is reflected when the sheet opens", async () => {
      writeStoreValue(BRIGHTNESS_KEY, { pct: 25 });
      const c = await renderOpen();
      expect(
        (c.querySelector('[data-testid="nc-brightness"]') as HTMLInputElement).value,
      ).toBe("25");
    });
  });
});
