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

function buttons(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll("button"));
}
function tab(host: HTMLElement, label: string): HTMLButtonElement {
  const b = buttons(host).find((x) => x.getAttribute("role") === "tab" && x.textContent === label);
  if (!b) throw new Error(`tab not found: ${label}`);
  return b;
}

describe("PhoneApp list tabs", () => {
  test("Recents tab lists a previously dialed contact (name resolved)", async () => {
    writeStoreValue(CONTACTS_KEY, [
      { id: makeContactId(), name: "Ada", phones: ["+86 138 0000 0001"], fav: false, ts: 1 },
    ]);
    writeStoreValue(CALLLOG_KEY, [
      { number: "+86 138 0000 0001", name: "Ada", ts: 1 },
    ]);
    const host = mount();
    await act(async () => {});
    // The recent entries live under the Recents tab now (not on the keypad).
    expect(host.textContent).not.toContain("+86 138 0000 0001");
    await act(async () => {
      tab(host, "Recents").click();
    });
    expect(host.textContent).toContain("+86 138 0000 0001");
    expect(host.textContent).toContain("Ada"); // label from contact lookup
  });

  test("Frequent tab shows a number dialed repeatedly", async () => {
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
    await act(async () => {
      tab(host, "Frequent").click();
    });
    expect(host.textContent).toContain("Ada");
    expect(host.textContent).toContain("+86 138 0000 0001");
  });

  test("picking a recent entry fills the keypad (select-then-place)", async () => {
    writeStoreValue(CONTACTS_KEY, [
      { id: makeContactId(), name: "Ada", phones: ["13800000001"], fav: false, ts: 1 },
    ]);
    writeStoreValue(CALLLOG_KEY, [{ number: "13800000001", name: "Ada", ts: 1 }]);
    const host = mount();
    await act(async () => {});
    await act(async () => {
      tab(host, "Recents").click();
    });
    const row = buttons(host).find((b) => b.title === "13800000001");
    expect(row).toBeTruthy();
    await act(async () => {
      row!.click();
    });
    // Back on the keypad with the number filled in.
    expect(buttons(host).some((b) => b.getAttribute("role") === "tab" && b.textContent === "Keypad" && b.getAttribute("aria-selected") === "true")).toBe(true);
    expect(host.textContent).toContain("13800000001");
  });
});

