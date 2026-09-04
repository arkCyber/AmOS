import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import HomeDock from "../components/HomeDock";
import { writeStoreValue } from "../lib/amosStore";
import { zh } from "../i18n/locales/zh";
import { NOTIF_KEY, SETTINGS_KEY } from "../lib/settings";

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
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <HomeDock
        layout={{ page: ["weather"], dock: ["messages"], hidden: [] }}
        onOpen={() => {}}
        onMove={() => {}}
      />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

const badgeCount = (host: HTMLElement) => host.querySelectorAll('[class*="bg-danger"]').length;

describe("HomeDock unread badge + DND", () => {
  test("shows an unread badge for an app and hides it under Do-Not-Disturb", async () => {
    const host = mount();
    await act(async () => {});

    // One unread notification for the "weather" app (matched by its zh title).
    await act(async () => {
      writeStoreValue(NOTIF_KEY, [{ id: "w1", app: zh["app.weather"], title: "雨", time: 1 }]);
    });
    expect(badgeCount(host)).toBeGreaterThanOrEqual(1);

    // DND on → unread badges are hidden.
    await act(async () => {
      writeStoreValue(SETTINGS_KEY, { dnd: true });
    });
    expect(badgeCount(host)).toBe(0);
  });
});
