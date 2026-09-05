import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { ThemeProvider } from "../theme";
import { AppComponent } from "../apps";
import { readStoreValue } from "../lib/amosStore";
import { AUTOOFF_STORE_KEY } from "../lib/display";

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
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

function mountSettings() {
  window.localStorage.setItem("amos-ui.locale", "en");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <ThemeProvider>
        <AppComponent id="settings" />
      </ThemeProvider>
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function segmentButton(host: HTMLElement, label: string): HTMLButtonElement | null {
  const group = host.querySelector<HTMLElement>('[role="radiogroup"][aria-label="auto-screen-off"]');
  if (!group) return null;
  return Array.from(group.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === label,
  ) ?? null;
}

describe("Settings: Auto screen-off", () => {
  test("off is the default and picking a timeout writes the shared store", async () => {
    const host = mountSettings();
    await flush();
    expect(readStoreValue<unknown>(AUTOOFF_STORE_KEY, 0)).toBe(0); // off by default
    const off = segmentButton(host, "Off");
    expect(off?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      segmentButton(host, "30 s")!.click();
    });
    await flush();
    // Written as seconds → the Shell's reactive watcher picks it up immediately.
    expect(readStoreValue<unknown>(AUTOOFF_STORE_KEY, 0)).toBe(30);
    expect(segmentButton(host, "30 s")?.getAttribute("aria-checked")).toBe("true");
    expect(segmentButton(host, "Off")?.getAttribute("aria-checked")).toBe("false");
  });

  test("existing value is reflected in the control on open", async () => {
    window.localStorage.setItem(AUTOOFF_STORE_KEY, "60");
    const host = mountSettings();
    await flush();
    expect(segmentButton(host, "60 s")?.getAttribute("aria-checked")).toBe("true");
    expect(segmentButton(host, "Off")?.getAttribute("aria-checked")).toBe("false");
  });
});
