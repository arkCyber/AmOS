import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { PhoneApp } from "../components/CommsApps";
import { writeStoreValue } from "../lib/amosStore";
import { CONTACTS_KEY, makeContactId } from "../lib/contacts";
import { CALLLOG_KEY } from "../lib/calllog";

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
      <PhoneApp />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

describe("PhoneApp recents", () => {
  test("shows a Recent chip for a previously dialed contact (name resolved)", async () => {
    writeStoreValue(CONTACTS_KEY, [
      { id: makeContactId(), name: "Ada", phones: ["+86 138 0000 0001"], fav: false, ts: 1 },
    ]);
    writeStoreValue(CALLLOG_KEY, [
      { number: "+86 138 0000 0001", name: "Ada", ts: 1 },
    ]);
    const host = mount();
    await act(async () => {});
    expect(host.textContent).toContain("Recent");
    expect(host.textContent).toContain("Ada"); // chip label from contact lookup
  });

  test("shows a Frequent chip when a number was dialed repeatedly", async () => {
    writeStoreValue(CONTACTS_KEY, [
      { id: makeContactId(), name: "Ada", phones: ["+86 138 0000 0001"], fav: false, ts: 1 },
    ]);
    writeStoreValue(CALLLOG_KEY, [
      { number: "+86 138 0000 0001", name: "Ada", ts: 1 },
      { number: "+86 138 0000 0001", name: "Ada", ts: 2 },
      { number: "+86 138 0000 0001", name: "Ada", ts: 3 },
    ]);
    const host = mount();
    await act(async () => {});
    expect(host.textContent).toContain("Frequent");
  });
});
