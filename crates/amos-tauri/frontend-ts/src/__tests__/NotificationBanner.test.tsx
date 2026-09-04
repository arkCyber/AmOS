import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import NotificationBanner from "../components/NotificationBanner";
import { writeStoreValue } from "../lib/amosStore";
import { NOTIF_KEY } from "../lib/settings";

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
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<NotificationBanner />);
  mounted.push({ root, host });
  return host;
}

describe("NotificationBanner", () => {
  test("shows a toast on arrival and acknowledges (clears the app) on tap", async () => {
    window.localStorage.clear();
    const host = mount();
    await act(async () => {});
    // No notifications yet → no banner.
    expect(host.textContent ?? "").not.toContain("天气");

    // A notification arrives (store write → reactive reload → arrival detected).
    await act(async () => {
      writeStoreValue(NOTIF_KEY, [{ id: "n1", app: "天气", title: "今日有雨", time: 1 }]);
    });
    expect(host.textContent).toContain("天气");
    expect(host.textContent).toContain("今日有雨");

    // Tap the banner → acknowledge: that app's notifications are cleared.
    const btn = host.querySelector("button[aria-label*='acknowledge']");
    expect(btn).not.toBeNull();
    await act(async () => {
      (btn as HTMLElement).click();
    });
    expect(window.localStorage.getItem(NOTIF_KEY)).toBe("[]");
    expect(host.textContent ?? "").not.toContain("天气");
  });
});
