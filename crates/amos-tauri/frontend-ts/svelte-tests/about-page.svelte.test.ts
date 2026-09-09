/**
 * about-page.svelte.test.ts — 「关于本机」honesty: battery shows a real host
 * reading on a `/proc`-less desktop, and the Cellular row states the honest "no
 * cellular service" (no SIM/modem) instead of faking bars or leaving a blank.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AboutPage from "../src/svelte/settings/AboutPage.svelte";
import { zh } from "../src/i18n/locales/zh";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const settle = () => new Promise((r) => setTimeout(r, 40));
const byTest = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);

function installBridge(systemHealth: unknown, hostBatteryPayload?: unknown) {
  const invoke = async (cmd: string) => {
    if (cmd === "system_health") return systemHealth;
    if (cmd === "system_host_battery") return hostBatteryPayload ?? null;
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}

describe("AboutPage.svelte", () => {
  test("no bridge: honest battery '—' and an explicit 'no cellular service' row", async () => {
    const { container } = render(AboutPage);
    await tick();
    await settle();
    expect(container.textContent ?? "").toContain(zh["settings.aboutDevice"]);
    const batt = byTest(container, "about-battery");
    expect(batt?.textContent ?? "").toContain("—"); // no real source → not fabricated
    const cell = byTest(container, "about-cellular");
    expect(cell?.textContent ?? "").toContain(zh["settings.cellularNone"]);
  });

  test("host battery fills the About page on a /proc-less desktop", async () => {
    // Daemon answers but has no battery (macOS, no /proc); the Tauri host command
    // reports the real laptop battery → About shows a real %, not '—'.
    installBridge({}, { level_pct: 75, charging: false });
    const { container } = render(AboutPage);
    await tick();
    await settle();
    const batt = byTest(container, "about-battery");
    expect(batt?.textContent ?? "").toContain("75%");
  });
});
