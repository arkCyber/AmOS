import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { ThemeProvider } from "../theme";
import NotificationCenter from "../components/NotificationCenter";
import { readStoreValue } from "../lib/amosStore";
import { SETTINGS_KEY, type QuickSettings } from "../lib/settings";

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
});
