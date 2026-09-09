import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { ThemeProvider } from "../theme";
import NotificationCenter from "../components/NotificationCenter";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import {
  FLASHLIGHT_KEY,
  SETTINGS_KEY,
  type FlashlightStore,
  type QuickSettings,
} from "../lib/settings";
import { setCellularRadio, clearCellularRadio } from "../svelte/cellularRadio";
import { CELLULAR_KEY } from "../lib/cellular";
import { en } from "../i18n/locales/en";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  window.localStorage.clear();
  clearCellularRadio();
});

function mount() {
  window.localStorage.clear();
  window.localStorage.setItem("amos-ui.locale", "en");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <ThemeProvider>
      <I18nProvider>
        <NotificationCenter open onClose={() => {}} />
      </I18nProvider>
    </ThemeProvider>,
  );
  mounted.push({ root, host });
  return host;
}

function tileByText(host: HTMLElement, label: string): HTMLButtonElement | null {
  const buttons = Array.from(host.querySelectorAll("button"));
  return buttons.find((b) => ((b.textContent ?? "") as string).includes(label)) ?? null;
}
const stored = () =>
  readStoreValue<QuickSettings>(SETTINGS_KEY, {}) as QuickSettings;
const storedFlash = () =>
  readStoreValue<FlashlightStore>(FLASHLIGHT_KEY, {} as FlashlightStore) as FlashlightStore;

/** Mount with a pre-seeded torch store (before first render reads it). */
function mountWithTorch(flash: FlashlightStore) {
  window.localStorage.clear();
  window.localStorage.setItem("amos-ui.locale", "en");
  window.localStorage.setItem(FLASHLIGHT_KEY, JSON.stringify(flash));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <ThemeProvider>
      <I18nProvider>
        <NotificationCenter open onClose={() => {}} />
      </I18nProvider>
    </ThemeProvider>,
  );
  mounted.push({ root, host });
  return host;
}

describe("NotificationCenter quick tiles", () => {
  test("location master starts ON and toggling it turns it OFF", async () => {
    const host = mount();
    await act(async () => {});
    const tile = tileByText(host, "Location");
    expect(tile).not.toBeNull();
    expect(tile!.getAttribute("aria-pressed")).toBe("true"); // default ON

    await act(async () => {
      tile!.click();
    });
    expect(tile!.getAttribute("aria-pressed")).toBe("false");
    expect(stored().location).toBe(false); // persisted
  });

  test("dark tile drives the real theme", async () => {
    const host = mount();
    await act(async () => {});
    const dark = tileByText(host, "Dark");
    expect(dark).not.toBeNull();
    const pressed0 = dark!.getAttribute("aria-pressed");
    await act(async () => {
      dark!.click();
    });
    expect(dark!.getAttribute("aria-pressed")).not.toBe(pressed0);
  });

  test("torch tile toggles on and persists the dedicated store (unbridged fallback)", async () => {
    // Default torch store (present but off).
    const host = mountWithTorch({ on: false, torch_present: true });
    await act(async () => {});
    const torch = tileByText(host, "Flashlight");
    expect(torch).not.toBeNull();
    expect(torch!.getAttribute("aria-pressed")).toBe("false");
    expect(torch!.disabled).toBe(false);
    expect(torch!.textContent).toContain("OFF");

    await act(async () => {
      torch!.click();
    });
    expect(torch!.getAttribute("aria-pressed")).toBe("true");
    expect(torch!.textContent).toContain("ON");
    expect(storedFlash().on).toBe(true);
    expect(storedFlash().torch_present).toBe(true); // presence preserved

    // Toggle back off.
    await act(async () => {
      torch!.click();
    });
    expect(storedFlash().on).toBe(false);
  });

  test("torch tile is disabled + labelled when the device has no torch", async () => {
    const host = mountWithTorch({ on: false, torch_present: false });
    await act(async () => {});
    const torch = tileByText(host, "Flashlight");
    expect(torch).not.toBeNull();
    expect(torch!.disabled).toBe(true);
    expect(torch!.textContent).toContain("No torch");
    // Clicking must not invent a lit torch.
    await act(async () => {
      torch!.click();
    });
    expect(storedFlash().on).toBe(false);
    expect(storedFlash().torch_present).toBe(false);
  });

  test("open tile reflects an OS-driven store push live (no click)", async () => {
    const host = mount();
    await act(async () => {});
    const torch = tileByText(host, "Flashlight");
    expect(torch).not.toBeNull();
    expect(torch!.getAttribute("aria-pressed")).toBe("false");

    // Simulate the Rust `store-updated` live push the device seam emits when the
    // OS changes the torch (another app / thermal / capture): the open tile must
    // flip to lit without any click or re-open.
    await act(async () => {
      writeStoreValue(FLASHLIGHT_KEY, { on: true, torch_present: true });
    });
    expect(torch!.getAttribute("aria-pressed")).toBe("true");
    expect(torch!.textContent).toContain("ON");

    // And an external OFF (e.g. OS turns it off) drops it back immediately.
    await act(async () => {
      writeStoreValue(FLASHLIGHT_KEY, { on: false, torch_present: true });
    });
    expect(torch!.getAttribute("aria-pressed")).toBe("false");
    expect(torch!.textContent).toContain("OFF");
  });
});


describe("controlled cellular module (React fallback)", () => {
  const cell = (host: HTMLElement) => host.querySelector('[data-testid="nc-cellular"]');

  test("hidden by default (no modem — honest, not misleading)", async () => {
    const host = mount();
    await act(async () => {});
    expect(cell(host)).toBeNull();
  });

  test("appears only when a real radio is present, with an honest label", async () => {
    setCellularRadio({ present: true, signal: 2 });
    const host = mount();
    await act(async () => {});
    await act(async () => {});
    const m = cell(host);
    expect(m).not.toBeNull();
    expect(m?.textContent ?? "").toContain(en["settings.cellularConnected"]);
  });

  test("reflects 'data off' honestly when the radio is present", async () => {
    setCellularRadio({ present: true, signal: 0 });
    const host = mount();
    await act(async () => {});
    await act(async () => {
      writeStoreValue(CELLULAR_KEY, { data: false, roaming: false });
    });
    await act(async () => {});
    const m = cell(host);
    expect(m).not.toBeNull();
    expect(m?.textContent ?? "").toContain(en["settings.cellularDataOff"]);
  });
});
