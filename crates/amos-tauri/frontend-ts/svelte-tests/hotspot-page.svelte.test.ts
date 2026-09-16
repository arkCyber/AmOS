/**
 * hotspot-page.svelte.test.ts — 「个人热点」is honest and cannot lie:
 *   • an un-provisionable config (blank name / a PSK under 8 chars) must NOT let the
 *     master switch claim a running AP (the toggle is refused);
 *   • a valid config toggles the shared radio bit (`onToggle("hotspot")`);
 *   • the config persists through lib/hotspot (durable amos.hotspot), including the
 *     "Suggest" PSK and the Open-network warning;
 *   • airplane mode blocks the switch and the Settings index cascade clears the bit;
 *   • no client list is ever invented (the page says the data needs the device).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import SettingsApp from "../src/svelte/SettingsApp.svelte";
import HotspotPage from "../src/svelte/settings/HotspotPage.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { HOTSPOT_KEY, type HotspotCfg } from "../src/lib/hotspot";
import { SETTINGS_KEY, type QuickSettings } from "../src/lib/settings";
import { zh } from "../src/i18n/locales/zh";
import { controlByName } from "./a11y-name";

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

/** A config that can actually serve (a WPA2 key long enough to provision). */
const VALID: HotspotCfg = {
  ssid: "AmOS Hotspot",
  password: "hunter2x",
  band: "5",
  security: "wpa2",
  maxClients: 5,
};

const qs = (over: Partial<QuickSettings> = {}): QuickSettings => ({
  hotspot: false,
  airplane: false,
  ...over,
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const byTest = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);
/**
 * The switch whose **accessible name** is `aria` (REQ-A283). Rows are built from the shared
 * `ToggleRow`, so the name comes from `aria-labelledby` → the visible label, not from an
 * `aria-label` attribute any more — locating by name is what the audit is about.
 */
const switchByLabel = (h: { container: HTMLElement }, aria: string) =>
  controlByName<HTMLButtonElement>(h.container, '[role="switch"]', aria);
const buttonByLabel = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === aria,
  ) as HTMLButtonElement | undefined;
/** The input whose accessible name is `aria` (REQ-A283 — the row's `<label for>` names it). */
const inputByLabel = (h: { container: HTMLElement }, aria: string) =>
  controlByName<HTMLInputElement>(h.container, "input", aria);
const radioByText = (h: { container: HTMLElement }, label: string) =>
  [...h.container.querySelectorAll('[role="radio"]')].find(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | undefined;

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and
 * return a restore function. (`window.localStorage` is a per-access proxy, so the
 * prototype cannot be patched — the window property itself is replaced. Mirrors
 * the helper the settings-pages suite uses.)
 */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", {
    value: fake,
    configurable: true,
    writable: true,
  });
  return () =>
    Object.defineProperty(window, "localStorage", {
      value: real,
      configurable: true,
      writable: true,
    });
}

describe("HotspotPage — the switch never claims an un-provisionable hotspot", () => {
  test("a default (empty PSK) config refuses to turn on", async () => {
    const onToggle = vi.fn();
    const host = render(HotspotPage, { props: { qs: qs(), onToggle } });
    await tick();
    // The config is shown while off (so it can be fixed) and states the problem.
    expect(byTest(host.container, "hotspot-problems")?.textContent ?? "").toContain(
      zh["settings.hotspotProblemPw"],
    );
    await fireEvent.click(switchByLabel(host, zh["settings.hotspot"]) as HTMLButtonElement);
    expect(onToggle).not.toHaveBeenCalled();
  });

  test("a valid config toggles the shared radio bit", async () => {
    writeStoreValue(HOTSPOT_KEY, VALID);
    const onToggle = vi.fn();
    const host = render(HotspotPage, { props: { qs: qs(), onToggle } });
    await tick();
    expect(byTest(host.container, "hotspot-problems")).toBeNull();
    await fireEvent.click(switchByLabel(host, zh["settings.hotspot"]) as HTMLButtonElement);
    expect(onToggle).toHaveBeenCalledWith("hotspot");
  });

  test("a blank name is reported as a problem too", async () => {
    writeStoreValue(HOTSPOT_KEY, { ...VALID, ssid: "" });
    const onToggle = vi.fn();
    const host = render(HotspotPage, { props: { qs: qs(), onToggle } });
    await tick();
    expect(byTest(host.container, "hotspot-problems")?.textContent ?? "").toContain(
      zh["settings.hotspotProblemSsid"],
    );
    await fireEvent.click(switchByLabel(host, zh["settings.hotspot"]) as HTMLButtonElement);
    expect(onToggle).not.toHaveBeenCalled();
  });

  test("airplane mode disables the switch and explains why", async () => {
    writeStoreValue(HOTSPOT_KEY, VALID);
    const onToggle = vi.fn();
    const host = render(HotspotPage, { props: { qs: qs({ airplane: true }), onToggle } });
    await tick();
    expect(switchByLabel(host, zh["settings.hotspot"])?.disabled).toBe(true);
    expect(txt(host)).toContain(zh["settings.airplaneBlocks"]);
  });

  test("a refused write is stated next to the switch (REQ-A203)", async () => {
    // The structured `radio_set` answer reached SettingsApp, which passes the coerced
    // refusal down: the page must say the device said no — not silently keep a switch
    // that only recorded a ledger entry.
    const host = render(HotspotPage, {
      props: {
        qs: qs(),
        onToggle: () => {},
        refusal: { noteKey: "radio.refused.device", surface: null },
      },
    });
    await tick();
    expect(byTest(host.container, "hotspot-refused")?.textContent).toContain(
      zh["radio.refused.device"],
    );
  });

  test("no refusal shows no refusal row", async () => {
    const host = render(HotspotPage, { props: { qs: qs(), onToggle: () => {} } });
    await tick();
    expect(byTest(host.container, "hotspot-refused")).toBeNull();
  });
});

describe("HotspotPage — config persists through lib/hotspot", () => {
  test("Suggest writes a usable PSK and clears the problem", async () => {
    const host = render(HotspotPage, { props: { qs: qs(), onToggle: () => {} } });
    await tick();
    expect(byTest(host.container, "hotspot-problems")).toBeTruthy();
    await fireEvent.click(
      buttonByLabel(host, zh["settings.hotspotGenerate"]) as HTMLButtonElement,
    );
    await tick();
    const saved = readStoreValue<HotspotCfg>(HOTSPOT_KEY, VALID);
    expect(saved.password.length).toBe(12);
    expect(byTest(host.container, "hotspot-problems")).toBeNull();
  });

  test("renaming the network is trimmed and stored", async () => {
    writeStoreValue(HOTSPOT_KEY, VALID);
    const host = render(HotspotPage, { props: { qs: qs(), onToggle: () => {} } });
    await tick();
    const input = inputByLabel(host, zh["settings.hotspotName"]) as HTMLInputElement;
    await fireEvent.change(input, { target: { value: "  Cafe  " } });
    expect(readStoreValue<HotspotCfg>(HOTSPOT_KEY, VALID).ssid).toBe("Cafe");
  });

  test("choosing Open drops the password requirement and warns", async () => {
    const host = render(HotspotPage, { props: { qs: qs(), onToggle: () => {} } });
    await tick();
    // A password is meaningless on an open network, so Suggest must be off too.
    expect(buttonByLabel(host, zh["settings.hotspotGenerate"])?.disabled).toBe(false);
    await fireEvent.click(
      radioByText(host, zh["settings.hotspotSecOpen"]) as HTMLButtonElement,
    );
    await tick();
    expect(readStoreValue<HotspotCfg>(HOTSPOT_KEY, VALID).security).toBe("open");
    expect(byTest(host.container, "hotspot-problems")).toBeNull();
    expect(buttonByLabel(host, zh["settings.hotspotGenerate"])?.disabled).toBe(true);
    expect(byTest(host.container, "hotspot-open-warning")?.textContent ?? "").toContain(
      zh["settings.hotspotOpenWarning"],
    );
  });

  test("the page never invents a client list", async () => {
    writeStoreValue(HOTSPOT_KEY, VALID);
    const host = render(HotspotPage, {
      props: { qs: qs({ hotspot: true }), onToggle: () => {} },
    });
    await tick();
    expect(byTest(host.container, "hotspot-clients")?.textContent ?? "").toContain(
      zh["settings.hotspotClientsHint"],
    );
  });

  test("picking a band persists it", async () => {
    writeStoreValue(HOTSPOT_KEY, VALID);
    const host = render(HotspotPage, { props: { qs: qs(), onToggle: () => {} } });
    await tick();
    await fireEvent.click(
      radioByText(host, zh["settings.hotspotBand24"]) as HTMLButtonElement,
    );
    await tick();
    expect(readStoreValue<HotspotCfg>(HOTSPOT_KEY, VALID).band).toBe("2.4");
  });

  test("picking a client cap persists it", async () => {
    writeStoreValue(HOTSPOT_KEY, VALID);
    const host = render(HotspotPage, { props: { qs: qs(), onToggle: () => {} } });
    await tick();
    await fireEvent.click(radioByText(host, "10") as HTMLButtonElement);
    await tick();
    expect(readStoreValue<HotspotCfg>(HOTSPOT_KEY, VALID).maxClients).toBe(10);
  });

  test("a rejected config write is visible AND never moves the store", async () => {
    writeStoreValue(HOTSPOT_KEY, VALID);
    const restore = failWritesFor(HOTSPOT_KEY);
    try {
      const host = render(HotspotPage, { props: { qs: qs(), onToggle: () => {} } });
      await tick();
      const input = inputByLabel(host, zh["settings.hotspotName"]) as HTMLInputElement;
      await fireEvent.change(input, { target: { value: "Renamed" } });
      await tick();
      // The screen must say the save failed …
      expect(byTest(host.container, "hotspot-store-error")?.textContent ?? "").toContain(
        zh["settings.radioSaveFailed"],
      );
      // … and the durable store must still hold the old name (no silent claim).
      expect(readStoreValue<HotspotCfg>(HOTSPOT_KEY, VALID).ssid).toBe(VALID.ssid);
    } finally {
      restore();
    }
  });

  test("the switch reflects the AP bit and the note only shows while it is on", async () => {
    writeStoreValue(HOTSPOT_KEY, VALID);
    const on = render(HotspotPage, {
      props: { qs: qs({ hotspot: true }), onToggle: () => {} },
    });
    await tick();
    expect(switchByLabel(on, zh["settings.hotspot"])?.getAttribute("aria-checked")).toBe("true");
    expect(byTest(on.container, "hotspot-clients")).toBeTruthy();

    cleanup();
    const off = render(HotspotPage, { props: { qs: qs(), onToggle: () => {} } });
    await tick();
    expect(switchByLabel(off, zh["settings.hotspot"])?.getAttribute("aria-checked")).toBe(
      "false",
    );
    // Nothing is claimed about connected devices while the AP is off.
    expect(byTest(off.container, "hotspot-clients")).toBeNull();
  });
});

describe("Settings index — hotspot row + airplane cascade", () => {
  test("the index exposes 个人热点 and opens the page", async () => {
    const host = render(SettingsApp);
    const row = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(zh["settings.hotspot"]),
    );
    expect(row).toBeTruthy();
    await fireEvent.click(row as HTMLButtonElement);
    expect(txt(host)).toContain(zh["settings.hotspotDesc"]);
  });

  test("turning airplane on cascades the hotspot off (shared radio policy)", async () => {
    writeStoreValue<QuickSettings>(SETTINGS_KEY, {
      wifi: true,
      bluetooth: true,
      hotspot: true,
    });
    const host = render(SettingsApp);
    await fireEvent.click(switchByLabel(host, zh["settings.airplane"]) as HTMLButtonElement);
    const saved = readStoreValue<QuickSettings>(SETTINGS_KEY, {});
    expect(saved.airplane).toBe(true);
    expect(saved.hotspot).toBe(false);
  });
});
