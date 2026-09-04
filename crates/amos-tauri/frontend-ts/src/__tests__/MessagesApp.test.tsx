import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { MessagesApp } from "../components/CommsApps";
import { writeStoreValue, readStoreValue } from "../lib/amosStore";
import { MSG_KEY, type Msg } from "../lib/messages";
import { NOTIF_KEY } from "../lib/settings";
import { zh } from "../i18n/locales/zh";

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
  window.localStorage.setItem("amos-ui.locale", "en");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <MessagesApp />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

const msgNotifs = () =>
  (readStoreValue<{ app?: string; icon?: string }[]>(NOTIF_KEY, []) ?? []).filter(
    (n) => n.app === zh["app.messages"],
  );

describe("MessagesApp → dock badge notifications", () => {
  test("publishes unread incoming messages as app notifications", async () => {
    const msgs: Msg[] = [
      { from: "them", text: "你好", ts: 1 }, // unread
      { from: "them", text: "在吗？", ts: 2 }, // unread
      { from: "them", text: "已读的", ts: 3, read: true },
      { from: "me", text: "嗯", ts: 4 },
    ];
    writeStoreValue(MSG_KEY, msgs);
    mount();
    await act(async () => {});
    await act(async () => {});
    const fresh = msgNotifs();
    expect(fresh.length).toBe(2); // only the two unread incoming
    expect(fresh.every((n) => n.icon === "💬")).toBe(true);
  });

  test("does not publish when everything is read", async () => {
    writeStoreValue(MSG_KEY, [{ from: "them", text: "读过了", ts: 1, read: true }]);
    mount();
    await act(async () => {});
    expect(msgNotifs()).toHaveLength(0);
  });
});
