import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { LockScreen } from "../components/SystemPanels";
import { EMERGENCY_QUICK_NUMBER } from "../lib/emergency";

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

function mount() {
  window.localStorage.setItem("amos-ui.locale", "en");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <LockScreen onUnlock={() => {}} />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

function byAriaLabel(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === label,
    ) ?? null
  );
}

describe("LockScreen emergency quick-dial", () => {
  test("labels and dials the shared quick number (no hardcoded string drift)", async () => {
    const host = mount();
    await act(async () => {}); // flush initial effects (clock ticker, focus trap)
    const label = `Emergency call ${EMERGENCY_QUICK_NUMBER}`;
    const btn = byAriaLabel(host, label);
    expect(btn).toBeTruthy();
    expect(btn!.textContent).toContain(EMERGENCY_QUICK_NUMBER);
    await act(async () => {}); // drain any trailing scheduled update
  });

  test("when the phone service is unreachable it recovers instead of staying stuck", async () => {
    const host = mount();
    await act(async () => {});
    const label = `Emergency call ${EMERGENCY_QUICK_NUMBER}`;
    const btn = byAriaLabel(host, label)!;
    expect(btn.disabled).toBe(false);

    // No Tauri bridge installed => telephonyDial resolves null (nothing placed).
    // Await the async recovery inside a single act scope so the state change that
    // re-enables the button is flushed before we assert (no stray act() warning).
    await act(async () => {
      btn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The button must not be left disabled on a phantom "calling…" state.
    expect(byAriaLabel(host, label)!.disabled).toBe(false);
    expect(host.textContent).toContain("Emergency call unavailable");
  });
});
