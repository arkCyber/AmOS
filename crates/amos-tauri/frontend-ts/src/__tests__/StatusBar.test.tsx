import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import StatusBar from "../components/StatusBar";
import { writeStoreValue } from "../lib/amosStore";
import { SETTINGS_KEY } from "../lib/settings";

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
});

function mount() {
  window.localStorage.clear();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<StatusBar />);
  mounted.push({ root, host });
  return host;
}

describe("StatusBar radio / DND indicators", () => {
  test("default (no settings): shows wifi + bluetooth glyphs, no DND moon", async () => {
    const host = mount();
    await act(async () => {});
    expect(host.textContent).toContain("📶");
    expect(host.textContent).toContain("🅱");
    expect(host.textContent).not.toContain("🌒");
  });

  test("airplane mode replaces wifi/bluetooth with ✈️", async () => {
    const host = mount();
    await act(async () => {});
    await act(async () => {
      writeStoreValue(SETTINGS_KEY, { wifi: true, bluetooth: true, airplane: true });
    });
    expect(host.textContent).toContain("✈️");
    expect(host.textContent).not.toContain("📶");
    expect(host.textContent).not.toContain("🅱");
  });

  test("Do-Not-Disturb shows the persistent 🌒 moon", async () => {
    const host = mount();
    await act(async () => {});
    expect(host.textContent).not.toContain("🌒");
    await act(async () => {
      writeStoreValue(SETTINGS_KEY, { dnd: true });
    });
    expect(host.textContent).toContain("🌒");
  });
});
