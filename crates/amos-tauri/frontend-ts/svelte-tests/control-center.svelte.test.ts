/**
 * DOM tests for the desktop **Control Center** popover (REQ-A263).
 *
 * Why these cases exist: the bar's ⚙️ item was the audit's standing example of an
 * unusable control — first a button that did nothing, then (REQ-A261) a disabled one whose
 * name said the panel did not exist. The panel exists now, and these tests are what keep it
 * from becoming decorative in the other direction: every tile must go through
 * `lib/quickRadio.ts` (the one implementation of a radio tap), and what the *device*
 * answered must decide what the panel and the store show.
 *
 * The fake host is the same shape the notification centre's tests use, deliberately: both
 * screens share the rules now, so both are measured against the same device answers.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ControlCenter from "../src/svelte/ControlCenter.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { SETTINGS_KEY, normalizeQuick } from "../src/lib/settings";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { THEME_KEY } from "../src/lib/themeCore";
import { zh } from "../src/i18n/locales/zh";

afterEach(cleanup);
afterEach(() => setLocale("zh"));
beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

const settle = () => new Promise((r) => setTimeout(r, 20));

/** The quick settings as the panel reads them back from the store. */
const stored = () => normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {}));

/**
 * Fake host. `managed` lists the radios the platform owns; `setReply` stages a write
 * answer (applied or refused); `openOk` decides whether a system surface opens.
 * Returns the command log.
 */
function installHost(
  opts: { managed?: string[]; openOk?: boolean; setReply?: unknown; status?: unknown } = {},
): string[] {
  const calls: string[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(
        cmd === "radio_set" ? `radio_set:${String(args?.key)}:${String(args?.enabled)}` : cmd,
      );
      switch (cmd) {
        case "radio_status":
          return opts.status ?? { wifi: false, bluetooth: false, airplane: false, hotspot: false };
        case "radio_control": {
          const key = String(args?.key ?? "");
          const isManaged = (opts.managed ?? []).includes(key);
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

describe("ControlCenter — the panel the bar's ⚙️ item was waiting for", () => {
  test("offline: a tile flips locally and the store records the intent", async () => {
    // No host at all (the plain desktop case): the same local policy the phone uses.
    const { container } = render(ControlCenter);
    await tick();
    const tile = container.querySelector<HTMLButtonElement>('[data-testid="cc-radio-wifi"]')!;
    expect(tile.getAttribute("aria-label")).toBe(zh["q.wifi"]);
    expect(tile.getAttribute("aria-pressed")).toBe("false");

    await fireEvent.click(tile);
    await tick();
    const after = container.querySelector('[data-testid="cc-radio-wifi"]')!;
    expect(after.getAttribute("aria-pressed")).toBe("true");
    expect(stored().wifi).toBe(true);
  });

  test("the device is authoritative: an applied write mirrors the device's snapshot", async () => {
    installHost({
      setReply: {
        radio: "wifi",
        requested: true,
        applied: true,
        state: { wifi: false, bluetooth: true, airplane: false, hotspot: false },
        refusal: null,
      },
    });
    const { container } = render(ControlCenter);
    await tick();
    await settle();
    await fireEvent.click(container.querySelector('[data-testid="cc-radio-wifi"]')!);
    await tick();
    await settle();
    // The reply says Wi-Fi is off, so the panel shows off even though the tap asked for on.
    const tile = container.querySelector('[data-testid="cc-radio-wifi"]')!;
    expect(tile.getAttribute("aria-pressed")).toBe("false");
    expect(stored().bluetooth).toBe(true);
  });

  test("a refusal is a sentence, and it must not rewrite the user's intent", async () => {
    installHost({
      setReply: {
        radio: "wifi",
        requested: true,
        applied: false,
        state: { wifi: false, bluetooth: false, airplane: false, hotspot: false },
        refusal: { kind: "provider_refused", radio: "wifi", detail: "setWifiEnabled(true) failed" },
      },
    });
    const { container } = render(ControlCenter);
    await tick();
    await settle();
    await fireEvent.click(container.querySelector('[data-testid="cc-radio-wifi"]')!);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="cc-refused"]')?.textContent?.trim()).toBe(
      zh["radio.refused.device"],
    );
    // The tap asked for Wi-Fi **on** and the device refused: the store must not adopt what
    // was refused (it holds the device's own read, `false` — never the refused `true`).
    expect(stored().wifi).not.toBe(true);
  });

  test("a switch the platform owns is marked, explained, and never attempted", async () => {
    const calls = installHost({ managed: ["wifi"] });
    const { container } = render(ControlCenter);
    await tick();
    await settle();
    const notes = container.querySelectorAll('[data-testid="cc-managed"]');
    expect(notes.length).toBe(1);
    expect(notes[0]?.textContent?.trim()).toBe(zh["radio.managed.wifi"]);
    expect(container.querySelector('[data-testid="cc-radio-wifi"]')?.textContent).toContain(
      zh["cc.systemOwned"],
    );

    await fireEvent.click(container.querySelector('[data-testid="cc-radio-wifi"]')!);
    await tick();
    await settle();
    expect(calls).toContain("radio_open_settings");
    expect(calls.some((c) => c.startsWith("radio_set:wifi"))).toBe(false);
  });

  test("a system surface that will not open is reported, never swallowed", async () => {
    installHost({ managed: ["airplane"], openOk: false });
    const { container } = render(ControlCenter);
    await tick();
    await settle();
    await fireEvent.click(container.querySelector('[data-testid="cc-radio-airplane"]')!);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="cc-surface-failed"]')?.textContent?.trim()).toBe(
      zh["radio.openSettingsFailed"],
    );
  });

  test("the airplane gate is the shared rule: Wi-Fi is not even attempted under it", async () => {
    // The *device* holds airplane mode (the panel reads device truth on open, so seeding the
    // store alone would be overwritten by that read — which is itself the REQ-A185 rule).
    const calls = installHost({
      status: { wifi: true, bluetooth: false, airplane: true, hotspot: false },
    });
    const { container } = render(ControlCenter);
    await tick();
    await settle();
    // Airplane mode owns the others: Wi-Fi reads as off even though its own bit is set.
    const wifi = container.querySelector('[data-testid="cc-radio-wifi"]')!;
    expect(wifi.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(wifi);
    await tick();
    await settle();
    expect(calls.filter((c) => c.startsWith("radio_set:wifi"))).toEqual([]);
  });

  test("Do Not Disturb and Dark Mode are the real switches the shell honours", async () => {
    const { container } = render(ControlCenter);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="cc-dnd"]')!);
    await tick();
    expect(stored().dnd).toBe(true);
    expect(container.querySelector('[data-testid="cc-dnd"]')!.getAttribute("aria-pressed")).toBe("true");

    await fireEvent.click(container.querySelector('[data-testid="cc-dark"]')!);
    await tick();
    // The theme goes through the same single source (and persistence) the rest of the UI reads.
    expect(["dark", "light"]).toContain(window.localStorage.getItem(THEME_KEY));
  });

  test("the backdrop dismisses the panel; a click inside it does not", async () => {
    const onclose = vi.fn();
    const { container } = render(ControlCenter, { props: { onclose } });
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="control-center-panel"]')!);
    expect(onclose).not.toHaveBeenCalled();
    await fireEvent.click(container.querySelector('[data-testid="control-center-backdrop"]')!);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  test("the panel is a named dialog a screen reader can announce", async () => {
    const { container } = render(ControlCenter);
    await tick();
    const panel = container.querySelector('[data-testid="control-center-panel"]')!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-label")).toBe(zh["desktop.controlCenter"]);
  });
});
