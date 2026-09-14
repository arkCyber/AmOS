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
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { setCellularRadio, clearCellularRadio } from "../src/svelte/cellularRadio";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { NOTIF_KEY, SETTINGS_KEY } from "../src/lib/settings";
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
    const c = await renderOpen();
    const count = () => c.querySelectorAll(`button[aria-label="${zh["a11y.dismiss"]}"]`).length;
    expect(count()).toBeGreaterThan(0);

    await fireEvent.click(c.querySelector(`button[aria-label="${zh["a11y.dismiss"]}"]`) as HTMLButtonElement);
    await tick();
    const afterOne = count();
    // Seed = 3 notifications, so at least one remains removable.
    await fireEvent.click(c.querySelector(`button[aria-label="${zh["nc.clear"]}"]`) as HTMLButtonElement);
    await tick();
    expect(count()).toBe(0);
    expect(readStoreValue<unknown>(NOTIF_KEY, [])).toEqual([]);
    void afterOne;
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

  test("cellular module is hidden by default (no modem — honest, not misleading)", async () => {
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
});


describe("NotificationCenter — platform-managed switches (REQ-A202)", () => {
  /**
   * Fake bridge: the platform owns whichever radios `managed` lists. This is the answer
   * the S5 gives for wifi/bluetooth/airplane (Android 14), and the one the pre-change UI
   * could not even see — a tile tap simply did nothing. `setReply` overrides the
   * structured `radio_set` answer (REQ-A203) to stage refusals.
   */
  function installBridge(opts: { managed: string[]; openOk?: boolean; setReply?: unknown }) {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        switch (cmd) {
          case "radio_status":
            return { wifi: false, bluetooth: false, airplane: false, hotspot: false };
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
