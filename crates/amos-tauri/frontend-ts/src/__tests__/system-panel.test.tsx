import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const health = {
  sampler: "linux-proc",
  cpu_busy_pct: 43.5,
  mem_total_bytes: 8_000_000_000,
  mem_available_bytes: 2_000_000_000,
  battery_level_pct: 62,
  battery_charging: false,
  live_power_mw: null,
  running: 5,
  cached: 2,
  stopped: 1,
  apps: [{ id: "com.amos.photos", state: "foreground" }],
  governor: {
    mode: "power_save",
    reason: "battery_low",
    cap_inference: true,
    throttle_background: true,
    ticks: 12,
    dvfs_applied: 7,
    dvfs_failed: 1,
    dropped: 2,
  },
};

const invoke = async (cmd: string) =>
  cmd === "system_health" ? health : "ok";

beforeEach(() => {
  window.localStorage.setItem("amos-ui.locale", "en"); // deterministic UI language
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: () => async () => {},
  };
});

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    // Unmount runs SystemPanel's effect cleanup → clears the auto-refresh interval.
    m.root.unmount();
    m.host.remove();
  }
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const wait = () => new Promise((r) => setTimeout(r, 0));
async function flush() {
  await act(async () => {
    await wait();
    await wait();
  });
}

async function mountPanel() {
  const Panel = (await import("../components/SystemPanel")).default;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <Panel />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

describe("SystemPanel (fake __TAURI_INTERNALS__, DOM)", () => {
  test("renders CPU/mem/battery/process rows + the per-app list from system_health", async () => {
    const host = await mountPanel();
    await flush();

    const text = host.textContent ?? "";
    expect(text).toContain("System working status");
    expect(text).toContain("CPU:");
    expect(text).toContain("44%"); // 43.5 → rounded
    expect(text).toContain("Memory:");
    expect(text).toContain("62%"); // battery level
    expect(text).toContain("Processes:");
    expect(text).toContain("5 running · 2 cached · 1 stopped");
    // The governor's registered app appears by id + lifecycle tier.
    expect(text).toContain("com.amos.photos");
    expect(text).toContain("foreground");
    // The merged power-regulation block shows the energy→scheduler decision.
    expect(text).toContain("Power regulation");
    expect(text).toContain("Power save"); // mode localized via sensor keys
    expect(text).toContain("DVFS 7/1");
    expect(text).toContain("expired 2");
    expect(text).toContain("⚠"); // dvfs_failed(1)>0 → operator warning marker
  });

  test("renders nothing when the daemon is not bridged (no broken card)", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const host = await mountPanel();
    await flush();
    expect(host.childNodes.length).toBe(0);
  });

  test("hides the power-regulation block until the governor has ticked", async () => {
    const pending = { ...health, governor: { ...health.governor, ticks: 0 } };
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => (cmd === "system_health" ? pending : "ok"),
      listen: () => async () => {},
    };
    const host = await mountPanel();
    await flush();
    const text = host.textContent ?? "";
    // Other data is still shown...
    expect(text).toContain("CPU:");
    // ...but a not-yet-run governor (pending) is not presented as active regulation.
    expect(text).not.toContain("Power regulation");
  });
});
