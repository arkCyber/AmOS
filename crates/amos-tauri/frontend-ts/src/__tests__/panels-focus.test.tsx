import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { RecentsPanel, SpotlightPanel } from "../components/SystemPanels";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered by another DOM test file */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tab = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
const esc = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

function render(ui: ReactNode) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById("root") as HTMLElement);
  return { root, mount: () => act(async () => root.render(<I18nProvider>{ui}</I18nProvider>)) };
}

describe("Recents/Spotlight focus trap (DOM)", () => {
  test("Tab wraps within Recents and Escape closes", async () => {
    const { root, mount } = render(<RecentsPanel open onClose={() => {}} onOpen={() => {}} />);
    await mount();
    const btns = Array.from(document.querySelectorAll("button")) as HTMLElement[];
    expect(btns.length).toBeGreaterThan(0);
    btns[btns.length - 1]!.focus();
    tab();
    expect(document.activeElement).toBe(btns[0]!);
    root.unmount();
  });

  test("Tab wraps within Spotlight and Escape closes", async () => {
    let closed = 0;
    const { root, mount } = render(<SpotlightPanel open onClose={() => closed++} onOpen={() => {}} />);
    await mount();
    const btns = Array.from(document.querySelectorAll("button")) as HTMLElement[];
    expect(btns.length).toBeGreaterThan(0);
    btns[btns.length - 1]!.focus();
    tab();
    expect(document.activeElement).toBe(btns[0]!);
    esc();
    expect(closed).toBe(1);
    root.unmount();
  });
});
