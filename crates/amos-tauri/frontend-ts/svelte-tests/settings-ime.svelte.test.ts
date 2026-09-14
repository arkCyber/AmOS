/**
 * DOM tests for the Settings → Input Method page.
 *
 * This page is what makes the input method *discoverable*: without it the keyboard
 * only exists for someone who already focused a text field, and its preferences can
 * only be changed with the keyboard on screen. These cases pin the contract — the
 * switch writes the same `amos-ui.ime` preference the keyboard reads, the fuzzy
 * controls go through the same `ime_*` commands as the keyboard's own panel, the
 * destructive reset asks first, and with no engine the page says so instead of
 * showing controls that would silently do nothing.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ImePage from "../src/svelte/settings/ImePage.svelte";
import { IME_ENABLED_KEY, writeImeEnabled } from "../src/lib/ime";
import { setLocale } from "../src/svelte/locale.svelte";

afterEach(cleanup);
afterEach(() => setLocale("zh"));
afterEach(() => window.localStorage.removeItem(IME_ENABLED_KEY));
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const PAIRS = ["z_zh", "c_ch", "s_sh", "n_l", "f_h", "r_l", "in_ing", "en_eng", "an_ang"];

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/** A minimal `ime_*` engine: enough state to drive the page's controls. */
function installFakeEngine(): string[] {
  const calls: string[] = [];
  let fuzzy: Record<string, boolean> = Object.fromEntries(PAIRS.map((p) => [p, false]));
  let pins = 3;
  const state = () => ({
    input: "",
    candidates: [],
    composing: false,
    strict: PAIRS.every((p) => !fuzzy[p]),
    fuzzy,
    dict_entries: 165_361,
    learned_pins: pins,
    learned_pending: 0,
    last_committed: null,
    last_pick_code: null,
  });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (command: string, args?: Record<string, unknown>) => {
      calls.push(command);
      switch (command) {
        case "ime_status":
          return Promise.resolve(state());
        case "ime_fuzzy_toggle": {
          const pair = String(args?.pair ?? "");
          fuzzy = { ...fuzzy, [pair]: !fuzzy[pair] };
          return Promise.resolve(state());
        }
        case "ime_fuzzy_preset": {
          const on = args?.preset === "permissive";
          fuzzy = Object.fromEntries(PAIRS.map((p) => [p, on]));
          return Promise.resolve(state());
        }
        case "ime_learning_clear":
          pins = 0;
          return Promise.resolve(state());
        default:
          return Promise.resolve(null);
      }
    },
  };
  return calls;
}

const q = (host: { container: HTMLElement }, testid: string) =>
  host.container.querySelector(`[data-testid="${testid}"]`);

describe("Settings → Input Method", () => {
  test("the switch reflects and writes the same preference the keyboard reads", async () => {
    const host = render(ImePage);
    await tick();
    const sw = host.container.querySelector('[role="switch"]');
    expect(sw?.getAttribute("aria-checked")).toBe("false");

    await fireEvent.click(sw!);
    await tick();
    expect(window.localStorage.getItem(IME_ENABLED_KEY)).toBe("true");
    expect(host.container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");

    await fireEvent.click(host.container.querySelector('[role="switch"]')!);
    await tick();
    expect(window.localStorage.getItem(IME_ENABLED_KEY)).toBe("false");
  });

  test("the switch follows the keyboard, not only its own taps", async () => {
    const host = render(ImePage);
    await tick();
    const sw = () => host.container.querySelector('[role="switch"]');
    expect(sw()?.getAttribute("aria-checked")).toBe("false");

    // The keyboard's own panel turned the input method off: same key, same window —
    // the page must not keep describing a preference that has moved.
    writeImeEnabled(true);
    await tick();
    expect(sw()?.getAttribute("aria-checked")).toBe("true");

    writeImeEnabled(false);
    await tick();
    expect(sw()?.getAttribute("aria-checked")).toBe("false");
  });

  test("with an engine it offers the fuzzy pairs, the presets and a real readout", async () => {
    const calls = installFakeEngine();
    const host = render(ImePage);
    await tick();
    await settle();

    expect(q(host, "settings-ime-offline")).toBeNull();
    expect(host.container.querySelectorAll('[data-testid^="settings-ime-pair-"]').length).toBe(9);
    expect(q(host, "settings-ime-mode")?.textContent).toContain("严格");
    expect(q(host, "settings-ime-dict")?.textContent).toContain("165361");

    await fireEvent.click(q(host, "settings-ime-pair-n_l")!);
    await tick();
    expect(calls).toContain("ime_fuzzy_toggle");
    expect(q(host, "settings-ime-mode")?.textContent).toContain("自定义");
    expect(q(host, "settings-ime-pair-n_l")?.getAttribute("aria-pressed")).toBe("true");

    await fireEvent.click(q(host, "settings-ime-strict")!);
    await tick();
    expect(calls).toContain("ime_fuzzy_preset");
    expect(q(host, "settings-ime-mode")?.textContent).toContain("严格");

    await fireEvent.click(q(host, "settings-ime-permissive")!);
    await tick();
    expect(q(host, "settings-ime-mode")?.textContent).toContain("自定义");
  });

  test("forgetting every learned word asks once here too", async () => {
    const calls = installFakeEngine();
    const host = render(ImePage);
    await tick();
    await settle();

    const button = () => q(host, "settings-ime-forget");
    await fireEvent.click(button()!);
    expect(calls).not.toContain("ime_learning_clear");
    expect(button()?.textContent).toContain("确认");

    await fireEvent.click(button()!);
    expect(calls).toContain("ime_learning_clear");
  });

  test("with no engine it says so instead of showing inert controls", async () => {
    const host = render(ImePage); // no fake bridge: invoke degrades to null
    await tick();
    await settle();

    expect(q(host, "settings-ime-offline")).toBeTruthy();
    expect(host.container.querySelectorAll('[data-testid^="settings-ime-pair-"]').length).toBe(0);
    expect(q(host, "settings-ime-forget")).toBeNull();
    // The switch is a local preference and stays usable.
    expect(host.container.querySelector('[role="switch"]')).toBeTruthy();
  });
});
