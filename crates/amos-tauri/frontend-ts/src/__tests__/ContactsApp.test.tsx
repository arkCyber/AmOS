import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import ContactsApp from "../components/ContactsApp";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { CONTACTS_KEY, makeContactId, type Contact } from "../lib/contacts";
import { NOTIF_KEY } from "../lib/settings";
import { CALLLOG_KEY, type CallRecord } from "../lib/calllog";

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

function seedOne(): Contact {
  const c: Contact = { id: makeContactId(), name: "Ada", phones: ["+86 138 0000"], fav: false, ts: 1 };
  writeStoreValue(CONTACTS_KEY, [c]);
  return c;
}

function mount() {
  window.localStorage.setItem("amos-ui.locale", "en");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <ContactsApp />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

function byAria(host: HTMLElement, label: string): HTMLElement | null {
  return host.querySelector(`[aria-label="${label}"]`);
}

describe("ContactsApp", () => {
  test("lists a stored contact (name + number)", async () => {
    seedOne();
    const host = mount();
    await act(async () => {});
    expect(host.textContent).toContain("Ada");
    expect(host.textContent).toContain("+86 138 0000");
  });

  test("call without a bridge reports it is offline", async () => {
    seedOne();
    const host = mount();
    await act(async () => {});
    await act(async () => {
      byAria(host, "Call")?.click();
    });
    expect(host.textContent).toContain("connect the phone daemon");
  });

  test("delete needs a confirm tap then removes + persists", async () => {
    seedOne();
    const host = mount();
    await act(async () => {});
    const del = byAria(host, "Delete")!;
    await act(async () => {
      del.click(); // arm
    });
    expect(host.textContent).toContain("Ada"); // still there after arming
    await act(async () => {
      del.click(); // confirm
    });
    expect(host.textContent).not.toContain("Ada");
    const stored = readStoreValue<Contact[]>(CONTACTS_KEY, []);
    expect(stored).toHaveLength(0);
  });

  test("add flow validates: empty Save shows a hint and adds nothing", async () => {
    const host = mount(); // empty store
    await act(async () => {});
    const addBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Add"),
    )!;
    await act(async () => {
      addBtn.click(); // open the form
    });
    await act(async () => {
      const save = Array.from(host.querySelectorAll("button")).find((b) =>
        (b.textContent ?? "").includes("Save"),
      )!;
      save.click(); // no name / no number → invalid
    });
    await act(async () => {});
    expect(host.textContent).toContain("are required");
    expect(host.textContent).toContain("No contacts"); // nothing added
    const stored = readStoreValue<Contact[]>(CONTACTS_KEY, []);
    expect(stored).toHaveLength(0);
  });

  test("Edit prefills the form and Cancel leaves the contact intact", async () => {
    seedOne();
    const host = mount();
    await act(async () => {});
    await act(async () => {
      byAria(host, "Edit")?.click();
    });
    const nameInput = Array.from(host.querySelectorAll("input")).find(
      (i) => i.getAttribute("placeholder") === "Name",
    ) as HTMLInputElement | undefined;
    const phoneInput = Array.from(host.querySelectorAll("input")).find(
      (i) => i.getAttribute("placeholder")?.startsWith("Phone number"),
    ) as HTMLInputElement | undefined;
    expect(nameInput?.value).toBe("Ada"); // prefilled from the contact
    expect(phoneInput?.value).toContain("138");

    // Cancel → nothing changed, contact still listed.
    await act(async () => {
      const cancel = Array.from(host.querySelectorAll("button")).find((b) =>
        (b.textContent ?? "").includes("Cancel"),
      )!;
      cancel.click();
    });
    expect(host.textContent).toContain("Ada");
    const stored = readStoreValue<Contact[]>(CONTACTS_KEY, []);
    expect(stored[0]?.name).toBe("Ada");
  });

  test("a bridged call is recorded into the Recent quick-dial strip", async () => {
    seedOne();
    // Fake Tauri bridge so bridged() is true and telephony_dial resolves.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async () => ({ ok: true }),
      listen: async () => async () => {},
    };
    try {
      const host = mount();
      await act(async () => {});
      expect(host.textContent).not.toContain("Recent");
      await act(async () => {
        byAria(host, "Call")?.click();
      });
      await act(async () => {});
      // Recent strip shows the called contact, and the call is persisted.
      expect(host.textContent).toContain("Recent");
      const log = readStoreValue<CallRecord[]>(CALLLOG_KEY, []);
      expect(log[0]?.number).toContain("138 0000");
      expect(log[0]?.name).toBe("Ada");
      // A phone notification is raised too (banner / bell / badge).
      const notifs = readStoreValue<{ app?: string; title?: string }[]>(NOTIF_KEY, []);
      expect(notifs.length).toBeGreaterThanOrEqual(1);
      expect(notifs[0]?.title).toBe("Ada");
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  test("a repeated dial shows a Frequent quick-dial chip", async () => {
    // 3 calls to Ada's number → frequent; one to an unknown number.
    writeStoreValue(CALLLOG_KEY, [
      { number: "+86 138 0000", name: "Ada", ts: 1 },
      { number: "+86 138 0000", name: "Ada", ts: 2 },
      { number: "+86 138 0000", name: "Ada", ts: 3 },
      { number: "999", ts: 4 },
    ]);
    seedOne();
    const host = mount();
    await act(async () => {});
    expect(host.textContent).toContain("Frequent");
    // Ada's name is shown in the frequent chips (list also shows her once).
    const ada = host.textContent!.split("Ada").length - 1;
    expect(ada).toBeGreaterThanOrEqual(2);
  });
});
