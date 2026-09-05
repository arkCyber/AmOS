import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppComponent } from "../apps";
import { I18nProvider } from "../i18n";
import { ThemeProvider } from "../theme";
import { readStoreValue } from "../lib/amosStore";
import { AUTOOFF_STORE_KEY, clampAutoOffSec } from "../lib/display";

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

function radio(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    (Array.from(host.querySelectorAll('button[role="radio"]')).find(
      (b) => b.textContent?.trim() === label,
    ) as HTMLButtonElement | null) ?? null
  );
}

describe("Settings → Auto screen-off", () => {
  test("row renders and picking a timeout writes the store knob", async () => {
    const host = mountSettings();
    await flush();
    // The row is discoverable under General.
    expect(host.textContent).toContain("Auto screen-off");
    // Default = Off (feature disabled out of the box).
    expect(radio(host, "Off")?.getAttribute("aria-checked")).toBe("true");

    // Pick "30 s" → the durable knob is written (the Shell watcher re-arms via
    // the reactive store read).
    await act(async () => {
      radio(host, "30 s")!.click();
    });
    await flush();
    expect(clampAutoOffSec(readStoreValue<unknown>(AUTOOFF_STORE_KEY, 0))).toBe(30);
    expect(radio(host, "30 s")?.getAttribute("aria-checked")).toBe("true");
    expect(radio(host, "Off")?.getAttribute("aria-checked")).toBe("false");

    // Back to Off disables it.
    await act(async () => {
      radio(host, "Off")!.click();
    });
    await flush();
    expect(clampAutoOffSec(readStoreValue<unknown>(AUTOOFF_STORE_KEY, 0))).toBe(0);
  });
});
