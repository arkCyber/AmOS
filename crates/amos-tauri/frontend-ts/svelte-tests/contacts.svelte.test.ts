/**
 * DOM tests for the Svelte 5 contacts screen (ContactsApp.svelte).
 *
 * Pure contact logic is unit-tested once against lib/contacts.ts (shared by the
 * React + Svelte UIs). Here we verify the Svelte UI wiring: store persistence,
 * the composer (add/dup-guard), favorite toggle, delete-confirm, and search.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import ContactsApp from "../src/svelte/ContactsApp.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { contactsChannel } from "../src/svelte/appLinks";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { MAX_IMPORT_BYTES } from "../src/lib/contactTransfer";
import { capSet, loadLedger } from "../src/lib/permissions";
import { revokeCapability } from "../src/svelte/osPermissions";

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return
 * a restore function. (`window.localStorage` is a per-access proxy, so the prototype
 * cannot be patched — the window property itself is replaced.)
 */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}

function input(h: { container: HTMLElement }, aria: string): HTMLInputElement {
  const el = h.container.querySelector(`input[aria-label="${aria}"]`) as HTMLInputElement | null;
  expect(el, `missing input "${aria}"`).toBeTruthy();
  return el!;
}
function button(h: { container: HTMLElement }, aria: string): HTMLButtonElement {
  const el = h.container.querySelector(`button[aria-label="${aria}"]`) as HTMLButtonElement | null;
  expect(el, `missing button "${aria}"`).toBeTruthy();
  return el!;
}
async function addContact(h: { container: HTMLElement }, name: string, phones: string) {
  await fireEvent.click(button(h, "添加"));
  await fireEvent.input(input(h, "姓名"), { target: { value: name } });
  await fireEvent.input(input(h, "电话号码（逗号/换行分隔）"), { target: { value: phones } });
  await fireEvent.click(button(h, "保存"));
}

describe("ContactsApp.svelte", () => {
  test("starts empty (暂无联系人)", () => {
    const host = render(ContactsApp);
    expect(txt(host)).toContain("暂无联系人");
  });

  test("a rejected write is reported and the contact is not applied", async () => {
    const restore = failWritesFor("amos.contacts");
    try {
      const host = render(ContactsApp);
      await addContact(host, "Alice", "13800000001");
      // Nothing was stored, so nothing may be claimed: an honest banner, no row, and
      // the typed name/number stay in the form.
      expect(txt(host)).toContain("本机存储写入失败");
      expect(txt(host)).not.toContain("Alice");
      expect(readStoreValue<{ name: string }[]>("amos.contacts", [])).toEqual([]);
      expect(input(host, "姓名").value).toBe("Alice");
    } finally {
      restore();
    }
  });

  test("add a contact → appears and is persisted to the shared store", async () => {
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    expect(txt(host)).toContain("Alice");
    expect(txt(host)).toContain("13800000001");
    const stored = readStoreValue<{ name: string }[]>("amos.contacts", []);
    expect(stored.some((c) => c.name === "Alice")).toBe(true);
  });

  // REQ-A1126 / F-SH-435. The shared contact store is written by more than one surface —
  // `PhoneApp` subscribes to it (`createStoreValue(CONTACTS_KEY)`, so a contact added in the
  // Contacts screen names the typed number in the recents), and a **split pane** mounts this
  // screen *beside* another one. But this component reads the key **once** at init
  // (`readStoreValue` → `$state`) and never subscribes, so a write made by any other surface
  // is invisible here — and worse, the next local edit (`persist`) serialises this component's
  // frozen array back over it, so the other surface's contact is *destroyed*, not merely missed.
  test("a contact written by another surface reaches this screen", async () => {
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    writeStoreValue("amos.contacts", [
      { id: "z1", name: "Zed", phones: ["13900000009"], fav: false, ts: 5000 },
    ]);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(txt(host)).toContain("Zed");
  });

  test("the next local edit does not erase a contact another surface wrote", async () => {
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    writeStoreValue("amos.contacts", [
      { id: "z1", name: "Zed", phones: ["13900000009"], fav: false, ts: 5000 },
    ]);
    await new Promise<void>((r) => setTimeout(r, 0));
    // A local mutation persists this component's list; it must carry the external write.
    await fireEvent.click(button(host, "收藏"));
    const stored = readStoreValue<{ name: string }[]>("amos.contacts", []);
    expect(stored.some((c) => c.name === "Zed")).toBe(true);
  });

  test("duplicate number is rejected (dup guard)", async () => {
    const host = render(ContactsApp);
    await addContact(host, "A", "13800000001");
    // reopen add with the same number on a new name
    await addContact(host, "B", "13800000001");
    expect(txt(host)).toContain("该号码已在通讯录中");
    // B was NOT added
    expect(txt(host)).not.toContain("B");
  });

  // REQ-A1119 / F-TEL-013. The phone field is a comma/newline-separated *list* — its own
  // aria-label says so — and `submit` splits it into every number (`ph`). But the duplicate
  // guard asked only about `ph[0]`, so a second number already owned by another contact
  // slipped past the guard. The next lookup (`contactNameFor` → the first match in list
  // order) then names the wrong person for that number.
  test("a duplicate in any position is rejected, not just the first", async () => {
    const host = render(ContactsApp);
    await addContact(host, "A", "13800000001");
    // B's FIRST number is fresh; the duplicate is the second one.
    await addContact(host, "B", "13900000009, 13800000001");
    expect(txt(host)).toContain("该号码已在通讯录中");
    expect(txt(host)).not.toContain("B");
  });

  // The edit path has its own arm (`contactsWithPhoneExcept`, so a contact may keep its
  // own number). It had the same first-only hole: editing A to add B's number as a second
  // entry was allowed. The row is picked by its number, not by position — the list is
  // name-sorted, so "the first 编辑 button" is whichever contact sorts first.
  test("the edit path also blocks a duplicate in any position", async () => {
    const host = render(ContactsApp);
    await addContact(host, "A", "13800000001");
    await addContact(host, "B", "222");
    const rows = [...host.container.querySelectorAll('button[aria-label="编辑"]')];
    const forA = rows.find((b) => (b.parentElement?.textContent ?? "").includes("13800000001"));
    expect(forA, "no 编辑 button in A's row").toBeTruthy();
    await fireEvent.click(forA!);
    // A keeps its own number (allowed) and gains B's as a second entry (must be refused).
    await fireEvent.input(input(host, "电话号码（逗号/换行分隔）"), {
      target: { value: "13800000001, 222" },
    });
    await fireEvent.click(button(host, "保存"));
    expect(txt(host)).toContain("该号码已在通讯录中");
  });

  // REQ-A1122 / F-TEL-015. The edit form prefills the phone field with `phones.join("\n")`,
  // but the field is a single-line `<input>` — and the HTML value-sanitisation algorithm for a
  // text input **strips** CR/LF. So a contact with two numbers reopened for editing showed them
  // as ONE concatenated number, and the next keystroke (which sets the field's state from the
  // DOM value) persisted that concatenation: the contact's numbers were destroyed. Separators
  // the field itself advertises (comma) survive; the `\n` it was using does not.
  test("editing a two-number contact keeps the numbers separated in the field", async () => {
    const host = render(ContactsApp);
    await addContact(host, "A", "13800000001, 222");
    const rows = [...host.container.querySelectorAll('button[aria-label="编辑"]')];
    const forA = rows.find((b) => (b.parentElement?.textContent ?? "").includes("13800000001"));
    await fireEvent.click(forA!);
    const field = input(host, "电话号码（逗号/换行分隔）");
    // Two numbers, still two — not "13800000001222".
    expect(field.value).toBe("13800000001, 222");
  });

  test("favorite toggles the star", async () => {
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    expect(txt(host)).not.toContain("★");
    await fireEvent.click(button(host, "收藏"));
    expect(txt(host)).toContain("★");
  });

  // REQ-A1001 / F-SH-322. The star glyph is the ONLY state signal and `aria-label` overrides
  // element content for the accessible name, so without `aria-pressed` the toggle reported the same
  // name in both states. Two-sided: the attribute must be `false` before AND after a full cycle,
  // so an implementation that hard-codes "true" (or omits the attribute) fails either way.
  test("favorite reports its own state to AT (aria-pressed)", async () => {
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    const fav = () => button(host, "收藏").getAttribute("aria-pressed");
    expect(fav()).toBe("false");
    await fireEvent.click(button(host, "收藏"));
    expect(fav()).toBe("true");
    await fireEvent.click(button(host, "收藏"));
    expect(fav()).toBe("false");
  });

  test("delete needs a confirm tap", async () => {
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    expect(txt(host)).toContain("Alice");
    // first tap arms confirm (icon turns ✓), list unchanged
    await fireEvent.click(button(host, "删除"));
    expect(txt(host)).toContain("Alice");
    // second tap removes
    await fireEvent.click(button(host, "删除"));
    expect(txt(host)).not.toContain("Alice");
    expect(txt(host)).toContain("暂无联系人");
  });

  // REQ-A1001 / F-SH-322. The armed state is the ✓ glyph; the name stays 删除. Without
  // `aria-pressed` the second press — the one that deletes — was announced exactly like the first.
  test("the delete tap reports its armed state (aria-pressed)", async () => {
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    expect(button(host, "删除").getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(button(host, "删除"));
    expect(button(host, "删除").getAttribute("aria-pressed")).toBe("true");
  });

  test("search filters the list", async () => {
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    await addContact(host, "Bob", "13900000002");
    expect(txt(host)).toContain("Alice");
    expect(txt(host)).toContain("Bob");
    await fireEvent.input(input(host, "搜索姓名或号码"), { target: { value: "Bob" } });
    expect(txt(host)).toContain("Bob");
    expect(txt(host)).not.toContain("Alice");
  });
});

describe("ContactsApp.svelte — the dialer reads the host's verdict (REQ-A875)", () => {
  /**
   * A desktop demo host: `telephony_dial` answers `reply`, and the real platform path is
   * reported unavailable (`on_device: false`), which is what makes the daemon the transport
   * here. Without that answer the host would be read as an on-device build and every dial
   * would be refused rather than simulated.
   */
  const dialBridge = (reply: unknown) => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "telephony_real_dial_status") {
          return { on_device: false, available: false, reason: "desktop" };
        }
        return cmd === "telephony_dial" ? reply : null;
      },
      listen: async () => async () => {},
    };
  };
  const callLog = () => readStoreValue<unknown[]>("amos.calllog", []);
  const notifs = () => readStoreValue<unknown[]>("amos.notifications", []);
  const dial = async (h: { container: HTMLElement }) => fireEvent.click(button(h, "呼叫"));

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    window.localStorage.removeItem("amos.calllog");
    window.localStorage.removeItem("amos.notifications");
  });

  // `telephony_dial` answers `Result<_, AmosError>`, so a refusal arrives at the WebView
  // as `null` — `invoke` catches the rejection (REQ-A296) and a `catch` here can never
  // run. The old code therefore wrote a call-log entry, pushed a notification and said
  // "dialing" for a call nothing placed: a fabricated call record, not just a stale label.
  test("a refused dial records no call and no notification", async () => {
    dialBridge(null);
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    await dial(host);

    // The verdict now takes several transports (the platform path, then the daemon), so
    // wait on the screen's own answer instead of assuming one flush is enough — the
    // assertions below must land *after* the refusal, not before it.
    await vi.waitFor(() => expect(txt(host)).toContain("无法呼叫"));

    expect(callLog()).toEqual([]);
    expect(notifs()).toEqual([]);
    expect(txt(host)).not.toContain("模拟拨出");
  });

  // The control: without it, never recording anything would pass the test above.
  test("an accepted dial records the call and the notification", async () => {
    dialBridge({ id: "call-1" });
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    await dial(host);

    // A call the daemon's mock placed is labelled as simulated — "正在拨号…" here would
    // claim a call this desktop host cannot place.
    await vi.waitFor(() => expect(txt(host)).toContain("模拟拨出"));

    expect(callLog()).toHaveLength(1);
    expect(notifs()).toHaveLength(1);
    // …and it is an **outgoing** call, the same as the dialer's own record: a row with no
    // direction reads as 「通话」 with the neutral bullet and is hidden by the history page's
    // 「去电」 filter, so a call the user really placed from here would not be findable as one.
    expect((callLog()[0] as { direction?: unknown }).direction).toBe("outgoing");
  });

  // The call-log write and the notification write are the **same** dial path, but only the
  // former was checked (`callLogStore.save`). The notification went through the unchecked
  // `writeStoreValue`, so a rejected write (full/unavailable storage) was swallowed and the
  // page reported a dial whose notification had silently vanished — the sibling's
  // `storeWriteFailed` line exists precisely so this cannot happen.
  test("a rejected notification write is reported, not swallowed", async () => {
    dialBridge({ id: "call-1" });
    const restore = failWritesFor("amos.notifications");
    try {
      const host = render(ContactsApp);
      await addContact(host, "Alice", "13800000001");
      await dial(host);
      // The call itself was recorded — its own write landed.
      await vi.waitFor(() => expect(callLog()).toHaveLength(1));
      // …but the notification did not, and the page must say so rather than staying silent.
      await vi.waitFor(() => expect(txt(host)).toContain("本机存储写入失败"));
      expect(notifs()).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe("ContactsApp.svelte — Spotlight deep link (appLinks.openContact)", () => {
  afterEach(resetPropsChannels);

  test("clears a filter that would hide the contact and marks its row", async () => {
    window.localStorage.setItem(
      "amos.contacts",
      JSON.stringify([
        { id: "c1", name: "Alice", phones: ["13800000001"], fav: false, ts: 1000 },
        { id: "c2", name: "Bob", phones: ["13900000002"], fav: false, ts: 2000 },
      ]),
    );
    // The chooser sets the channel *before* opening the app.
    contactsChannel().set({ id: "c2", nonce: 21 });
    const host = render(ContactsApp);
    await new Promise<void>((r) => setTimeout(r, 0));

    const marked = host.container.querySelectorAll('[data-spotlight="hit"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent ?? "").toContain("Bob");
    // The link is consumed, so re-mounting later cannot re-fire it.
    expect(contactsChannel().get()?.id).toBe("");
  });

  test("a link to a contact that is gone marks nothing (no phantom)", async () => {
    window.localStorage.setItem(
      "amos.contacts",
      JSON.stringify([{ id: "c1", name: "Alice", phones: ["13800000001"], fav: false, ts: 1000 }]),
    );
    contactsChannel().set({ id: "gone", nonce: 22 });
    const host = render(ContactsApp);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(txt(host)).toContain("Alice");
    expect(host.container.querySelector('[data-spotlight="hit"]')).toBeNull();
  });
});

describe("ContactsApp.svelte — vCard import/export", () => {
  const URL_RECORD = URL as unknown as Record<string, unknown>;
  let origCreate: unknown;
  let origRevoke: unknown;
  let created: string[];
  let revoked: string[];

  /** Stub the Blob URL factory (happy-dom may lack it entirely). */
  function stubObjectUrls(): void {
    origCreate = URL_RECORD.createObjectURL;
    origRevoke = URL_RECORD.revokeObjectURL;
    created = [];
    revoked = [];
    URL_RECORD.createObjectURL = (b: Blob) => {
      created.push(`${b.size}:${b.type}`);
      return "blob:mock-url";
    };
    URL_RECORD.revokeObjectURL = (u: string) => {
      revoked.push(u);
    };
  }
  function restoreObjectUrls(): void {
    if (origCreate === undefined) delete URL_RECORD.createObjectURL;
    else URL_RECORD.createObjectURL = origCreate;
    if (origRevoke === undefined) delete URL_RECORD.revokeObjectURL;
    else URL_RECORD.revokeObjectURL = origRevoke;
  }

  function textarea(h: { container: HTMLElement }, aria: string): HTMLTextAreaElement {
    const el = h.container.querySelector(
      `textarea[aria-label="${aria}"]`,
    ) as HTMLTextAreaElement | null;
    expect(el, `missing textarea "${aria}"`).toBeTruthy();
    return el!;
  }

  test("export downloads the whole book as a vCard blob", async () => {
    stubObjectUrls();
    try {
      const host = render(ContactsApp);
      await addContact(host, "Alice", "13800000001");
      await fireEvent.click(button(host, "导出 .vcf"));
      expect(txt(host)).toContain("已导出 1 个联系人");
      expect(created).toHaveLength(1);
      expect(created[0]!.endsWith(":text/vcard")).toBe(true); // the blob is a vCard
      // The URL must **outlive** the click: the browser reads the blob after `click()`
      // returns, so a synchronous `revokeObjectURL` can cancel the download and leave
      // 「已导出 1 个联系人」 over a file that never landed. The release is deferred.
      expect(revoked).toEqual([]);
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(revoked).toContain("blob:mock-url"); // …but it is still released
    } finally {
      restoreObjectUrls();
    }
  });

  test("export with an empty book says so instead of pretending", async () => {
    stubObjectUrls();
    try {
      const host = render(ContactsApp);
      await fireEvent.click(button(host, "导出 .vcf"));
      expect(txt(host)).toContain("没有可导出的联系人");
      expect(created).toEqual([]);
    } finally {
      restoreObjectUrls();
    }
  });

  test("copy vCard honestly reports an unavailable clipboard bridge", async () => {
    stubObjectUrls();
    try {
      const host = render(ContactsApp);
      await addContact(host, "Alice", "13800000001");
      // Outside the Tauri shell the clipboard invoke degrades to null → honest offline line.
      await fireEvent.click(button(host, "复制 vCard"));
      expect(txt(host)).toContain("剪贴板不可用");
    } finally {
      restoreObjectUrls();
    }
  });

  test("import: paste → preview → confirm adds and persists with honest counts", async () => {
    const host = render(ContactsApp);
    await fireEvent.click(button(host, "导入"));
    await fireEvent.input(textarea(host, "粘贴 vCard 文本，或选择 .vcf 文件"), {
      target: {
        value:
          "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Imported One\r\nTEL:13700000003\r\nEND:VCARD\r\n" +
          "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:NoPhone\r\nEND:VCARD\r\n",
      },
    });
    await fireEvent.click(button(host, "解析预览"));
    expect(txt(host)).toContain("解析到 1 个可导入联系人");
    expect(txt(host)).toContain("1 条记录不完整");
    await fireEvent.click(button(host, "确认导入"));
    expect(txt(host)).toContain("Imported One");
    expect(txt(host)).toContain("13700000003");
    expect(txt(host)).toContain("已导入 1 个，跳过重复 0 个，无法识别 1 个");
    const stored = readStoreValue<{ name: string }[]>("amos.contacts", []);
    expect(stored.some((c) => c.name === "Imported One")).toBe(true);
  });

  test("import: a duplicate number is skipped and counted, not merged", async () => {
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    await fireEvent.click(button(host, "导入"));
    await fireEvent.input(textarea(host, "粘贴 vCard 文本，或选择 .vcf 文件"), {
      target: {
        value: "BEGIN:VCARD\r\nFN:Copycat\r\nTEL:+8613800000001\r\nEND:VCARD\r\n",
      },
    });
    await fireEvent.click(button(host, "解析预览"));
    await fireEvent.click(button(host, "确认导入"));
    expect(txt(host)).toContain("已导入 0 个，跳过重复 1 个，无法识别 0 个");
    expect(txt(host)).toContain("Alice");
    expect(txt(host)).not.toContain("Copycat");
  });

  test("import: garbage text is refused as not-a-vCard and confirm stays disabled", async () => {
    const host = render(ContactsApp);
    await fireEvent.click(button(host, "导入"));
    await fireEvent.input(textarea(host, "粘贴 vCard 文本，或选择 .vcf 文件"), {
      target: { value: "hello, this is not a vcard" },
    });
    await fireEvent.click(button(host, "解析预览"));
    expect(txt(host)).toContain("无法识别为 vCard 文件");
    const confirm = button(host, "确认导入");
    expect(confirm.disabled).toBe(true);
  });
  test("editing the text after a preview invalidates it (no stale imports)", async () => {
    const host = render(ContactsApp);
    await fireEvent.click(button(host, "导入"));
    const box = textarea(host, "粘贴 vCard 文本，或选择 .vcf 文件");
    await fireEvent.input(box, {
      target: { value: "BEGIN:VCARD\r\nFN:Fresh\r\nTEL:13700000009\r\nEND:VCARD\r\n" },
    });
    await fireEvent.click(button(host, "解析预览"));
    expect(button(host, "确认导入").disabled).toBe(false);
    // After the preview the text changes — the stale parse must not stay
    // confirmable (pre-fix it silently imported the OLD entries).
    await fireEvent.input(box, { target: { value: "totally not a vcard" } });
    expect(button(host, "确认导入").disabled).toBe(true);
    expect(txt(host)).not.toContain("解析到");
    // A fresh preview of the new text re-enables.
    await fireEvent.input(box, {
      target: { value: "BEGIN:VCARD\r\nFN:Fresh2\r\nTEL:13700000010\r\nEND:VCARD\r\n" },
    });
    await fireEvent.click(button(host, "解析预览"));
    expect(button(host, "确认导入").disabled).toBe(false);
  });

  test("a file that fails to read is a read failure, not 'not a vCard'", async () => {
    const host = render(ContactsApp);
    await fireEvent.click(button(host, "导入"));
    const picker = host.container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(picker).toBeTruthy();
    const badFile = { text: () => Promise.reject(new Error("boom")) } as unknown as File;
    Object.defineProperty(picker, "files", { value: [badFile], configurable: true });
    await fireEvent.change(picker);
    await new Promise<void>((r) => setTimeout(r, 0)); // let the rejected text() settle
    expect(txt(host)).toContain("无法读取该文件");
    expect(txt(host)).not.toContain("无法识别为 vCard 文件");
  });

  /** Fire a `change` on the file picker with `file` selected (happy-dom needs the stub). */
  async function pickFile(host: { container: HTMLElement }, file: File): Promise<void> {
    const picker = host.container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(picker).toBeTruthy();
    Object.defineProperty(picker, "files", { value: [file], configurable: true });
    await fireEvent.change(picker);
    await new Promise<void>((r) => setTimeout(r, 0)); // let the read settle
  }

  const vcardText = (name: string, tel: string): string =>
    `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${name}\r\nTEL:${tel}\r\nEND:VCARD\r\n`;

  test("picking a new file voids the earlier preview (no stale imports)", async () => {
    const host = render(ContactsApp);
    await fireEvent.click(button(host, "导入"));
    const box = textarea(host, "粘贴 vCard 文本，或选择 .vcf 文件");
    await fireEvent.input(box, { target: { value: vcardText("Stale", "13600000001") } });
    await fireEvent.click(button(host, "解析预览"));
    expect(button(host, "确认导入").disabled).toBe(false);
    // The picked file replaces the box text, but a programmatic assignment fires
    // no `input` — pre-fix the confirm button still held the OLD parse and would
    // import "Stale" while the screen showed "Fresh".
    await pickFile(host, {
      size: 42,
      text: () => Promise.resolve(vcardText("Fresh", "13600000002")),
    } as unknown as File);
    expect(box.value).toContain("Fresh");
    expect(button(host, "确认导入").disabled).toBe(true);
    expect(txt(host)).not.toContain("解析到");
    await fireEvent.click(button(host, "确认导入")); // disabled ⇒ must be a no-op
    expect(txt(host)).not.toContain("Fresh");
    expect(readStoreValue<{ name: string }[]>("amos.contacts", [])).toEqual([]);
  });

  test("an oversized picked file is refused before reading (bounded import)", async () => {
    const host = render(ContactsApp);
    await fireEvent.click(button(host, "导入"));
    let read = false;
    const big = {
      size: MAX_IMPORT_BYTES + 1,
      text: () => {
        read = true;
        return Promise.resolve(vcardText("TooBig", "13600000003"));
      },
    } as unknown as File;
    await pickFile(host, big);
    expect(txt(host)).toContain("文件过大");
    expect(txt(host)).not.toContain("无法读取该文件"); // a size refusal ≠ a read failure
    expect(read).toBe(false); // never even opened
    expect(textarea(host, "粘贴 vCard 文本，或选择 .vcf 文件").value).toBe("");
    expect(button(host, "确认导入").disabled).toBe(true);
  });

  test("export counts cards, not literal BEGIN:VCARD substrings in values", async () => {
    stubObjectUrls();
    try {
      window.localStorage.setItem(
        "amos.contacts",
        JSON.stringify([
          {
            id: "t1",
            name: "骗子",
            phones: ["13900000002"],
            fav: false,
            ts: 1000,
            note: "BEGIN:VCARD\r\nEND:VCARD",
          },
        ]),
      );
      const host = render(ContactsApp);
      await fireEvent.click(button(host, "导出 .vcf"));
      // Pre-fix the substring split counted the note's literal BEGIN:VCARD → "2".
      expect(txt(host)).toContain("已导出 1 个联系人");
      expect(created).toHaveLength(1);
    } finally {
      restoreObjectUrls();
    }
  });
});

/**
 * The avatar theme is a durable preference. Until this round the picker only assigned
 * `lib/contacts.ts`'s module-level `currentTheme` and announced 「已切换到 … 主题」 for a
 * choice a cold start silently reset to 动物 — a control whose state reached no store at
 * all (the sibling of REQ-A993's "a durable key only the writer reads", one step worse:
 * it never wrote a key).
 */
describe("ContactsApp.svelte — 头像主题持久化", () => {
  const THEME_KEY = "amos.contacts.avatarTheme";
  afterEach(() => {
    window.localStorage.removeItem(THEME_KEY);
  });

  /**
   * The menu item is the button whose *whole* trimmed text is the theme name. The
   * trigger renders "🎨 动物", so it can never match a bare label — that is why this
   * cannot reuse `button(h, aria)` (the menu items carry no aria-label).
   */
  function themeItem(h: { container: HTMLElement }, label: string): HTMLButtonElement {
    const el = [...h.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === label,
    ) as HTMLButtonElement | undefined;
    expect(el, `missing theme item "${label}"`).toBeTruthy();
    return el!;
  }

  test("the chosen theme is written to the store and survives a remount", async () => {
    const first = render(ContactsApp);
    expect(txt(first)).toContain("动物"); // the built-in default, before any choice
    await fireEvent.click(button(first, "头像主题"));
    await fireEvent.click(themeItem(first, "食物"));
    expect(txt(first)).toContain("已切换到 食物 主题");
    expect(readStoreValue<string>(THEME_KEY, "")).toBe("food");
    first.unmount();

    // A cold start must come back on the chosen theme, not the built-in default:
    // pre-fix the module reset to 动物 and the store was never consulted.
    const second = render(ContactsApp);
    expect(txt(second)).toContain("食物");
    expect(txt(second)).not.toContain("🎨 动物");
  });

  // The trigger is a **disclosure**: its click opens/closes the theme region, and its
  // accessible name (「头像主题」, plus the current theme) is the same in both states —
  // the only other signal is whether the menu is painted. Without `aria-expanded` an
  // assistive-tech user cannot tell whether pressing it again opens or closes.
  test("the theme trigger announces whether the menu is open (REQ-A1060)", async () => {
    const host = render(ContactsApp);
    const trigger = button(host, "头像主题");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  /**
   * The same rule on the other disclosure in this file: 「添加」 reveals the composer
   * region (`{#if adding || editing}`) and its accessible name is 「添加」 in both states.
   *
   * The binding is the **region's** open state, not just the flag this click flips:
   * tapping a row's pencil opens the same region with `adding` still false, so
   * `aria-expanded={adding}` alone would announce "collapsed" over a composer that is
   * plainly on screen — the very mismatch this attribute exists to prevent.
   */
  test("「添加」 announces whether the composer it reveals is open (REQ-A1060)", async () => {
    const host = render(ContactsApp);
    const add = button(host, "添加");
    expect(add.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(add);
    expect(add.getAttribute("aria-expanded")).toBe("true");
    await fireEvent.click(add);
    expect(add.getAttribute("aria-expanded")).toBe("false");
  });

  test("a refused theme write is reported and the picker does not claim the switch", async () => {
    const restore = failWritesFor(THEME_KEY);
    try {
      const host = render(ContactsApp);
      await fireEvent.click(button(host, "头像主题"));
      await fireEvent.click(themeItem(host, "食物"));
      expect(txt(host)).toContain("本机存储写入失败");
      expect(txt(host)).not.toContain("已切换到");
      expect(readStoreValue<string>(THEME_KEY, "")).not.toBe("food");
      expect(txt(host)).toContain("🎨 动物"); // still on the default
    } finally {
      restore();
    }
  });
});

/**
 * The alphabet index's whole point is the **far** jump: tap a letter, land on that
 * section. The list is virtualized, so only the rows around the current scroll
 * position are in the DOM at all — and the jump used to be a
 * `getElementById("section-" + letter)?.scrollIntoView()`, which finds nothing for any
 * letter outside that window. Tapping "F" in a 30-contact book therefore did *nothing*:
 * the one gesture that must reach a section you cannot see was the one it could not
 * perform (a letter whose header IS rendered is a letter already on screen).
 */
describe("ContactsApp.svelte — 字母索引", () => {
  test("the index reaches a section that is not currently rendered (REQ-A1045)", async () => {
    const many: unknown[] = [];
    for (const L of ["A", "B", "C", "D", "E", "F"]) {
      for (let i = 1; i <= 5; i++) {
        many.push({ id: `${L}${i}`, name: `${L}0${i}`, phones: ["13800000000"], fav: false, ts: 1 });
      }
    }
    writeStoreValue("amos.contacts", many);
    const host = render(ContactsApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    // Off the top of the list, F's section is not rendered at all (so the old
    // `getElementById` had nothing to scroll to).
    expect(host.container.querySelector("#section-F")).toBeNull();
    const fBtn = host.container.querySelector('button[aria-label="跳转到 F"]') as HTMLButtonElement;
    expect(fBtn).toBeTruthy();
    await fireEvent.click(fBtn);
    await new Promise<void>((r) => setTimeout(r, 0));
    // The window moved to F — it was not extended to keep A as well.
    expect(host.container.querySelector("#section-F")).toBeTruthy();
    expect(host.container.querySelector("#section-A")).toBeNull();
    expect(txt(host)).toContain("F05");
  });
});

/**
 * The list renders a **window** derived from `scrollTop` (the alphabet index above is
 * the jump *into* that window). The mirror direction is just as load-bearing, and
 * nothing did it: no code ever reconciled the cached offset with the list actually
 * being rendered, so
 *
 *  - a search that replaces a long list with a short one left the window starting past
 *    the new end. `calculateVirtualRange` clamps the end to the item count but never the
 *    start, so the range came out **inverted** (`startIndex > endIndex`) and the loop
 *    rendered nothing. The screen showed a blank list — not the "暂无联系人" line
 *    either, because the filtered list is not empty — while the matches were right there;
 *  - the Spotlight deep link cleared the filter and marked the target row, but a row
 *    outside the window is not in the DOM at all, so for any contact below the window
 *    the screen claimed to reveal a contact and showed nothing (REQ-A1045's family: a
 *    jump addressed to a derived view finds nothing).
 *
 * Both go through the window's input now: `scrollListTo`.
 */
describe("ContactsApp.svelte — 虚拟窗口与其内容 (REQ-A1047)", () => {
  const MANY: unknown[] = (() => {
    const list: unknown[] = [];
    for (const L of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
      for (let i = 1; i <= 5; i++) {
        list.push({ id: `${L}${i}`, name: `${L}0${i}`, phones: ["13800000000"], fav: false, ts: 1 });
      }
    }
    return list;
  })();
  const search = (h: { container: HTMLElement }) => input(h, "搜索姓名或号码");
  /** Put the window far down the list, the way a real scroll event does. */
  const scrollDown = async (h: { container: HTMLElement }) => {
    const el = h.container.querySelector(".overflow-y-auto") as HTMLElement;
    // happy-dom lays nothing out, so the geometry the `onscroll` handler reads is stubbed.
    Object.defineProperty(el, "scrollTop", { value: 3000, writable: true, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 600, writable: true, configurable: true });
    await fireEvent.scroll(el);
    await new Promise<void>((r) => setTimeout(r, 0));
  };
  const renderSeeded = async () => {
    writeStoreValue("amos.contacts", MANY);
    const host = render(ContactsApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    return host;
  };

  afterEach(resetPropsChannels);

  test("搜索把窗口重新锚回顶部：结果在，远端窗口已离开", async () => {
    const host = await renderSeeded();
    await scrollDown(host);
    expect(host.container.querySelector("#section-H")).toBeTruthy(); // the window really moved

    // A query every name matches: the list stays long, so what is measured is the
    // anchor moving, not the list getting short.
    await fireEvent.input(search(host), { target: { value: "0" } });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(host.container.querySelector("#section-A")).toBeTruthy();
    expect(txt(host)).toContain("A01");
    expect(host.container.querySelector("#section-H")).toBeNull(); // moved, not extended

    // …and a query whose whole result is one row is drawn rather than left blank
    // (the window used to start past its end, so nothing was rendered at all).
    await fireEvent.input(search(host), { target: { value: "A01" } });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(txt(host)).toContain("A01");
  });

  test("Spotlight 深链把窗口移到那一位联系人（否则标记落在窗口外）", async () => {
    const host = await renderSeeded();
    await scrollDown(host);
    // A1 sits at the top of the list, far outside the current window.
    expect(host.container.querySelector('[data-spotlight="hit"]')).toBeNull();

    contactsChannel().set({ id: "A1", nonce: 7 });
    await new Promise<void>((r) => setTimeout(r, 0));

    const hit = host.container.querySelector('[data-spotlight="hit"]');
    expect(hit).toBeTruthy();
    expect(hit!.textContent ?? "").toContain("A01");
  });
});

/**
 * `placeOutgoingCall` (`lib/phone.ts`) is the one owner of "place an outbound call": the
 * **real platform path first** (`ACTION_CALL` through the host), then a daemon backed by a
 * genuinely real stack, and the daemon's simulation only on a host with no telephony stack.
 * The dialer (`PhoneApp`) routes through it. This screen did not — it called
 * `telephonyDial` alone, so on a device whose bridge is up but whose telephony daemon is
 * down (`bridged()` is about the WebView bridge, not the daemon) tapping a contact's number
 * could only ever say "offline", even though the platform could place the call (REQ-A1049).
 */
describe("ContactsApp.svelte — 呼叫走 placeOutgoingCall（与 PhoneApp 同一判定）(REQ-A1049)", () => {
  const bridge = (daemon: unknown, system: unknown) => {
    const calls: Record<string, unknown>[] = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...(args ?? {}) });
        if (cmd === "telephony_dial") return daemon;
        if (cmd === "real_dial") return system;
        // The role probe stays unanswered here (everything else answers `null`), so the
        // hand-off lands on the honest "status unread" sentence — but a real host can still
        // open the Phone app, which is what these two tests are about (REQ-A1544).
        if (cmd === "wm_open") return { windows: [] };
        return null;
      },
      listen: async () => async () => {},
    };
    return calls;
  };
  /** A desktop demo host: no telephony stack, so the daemon's simulation is the only path. */
  const desktopBridge = () => {
    const calls: Record<string, unknown>[] = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...(args ?? {}) });
        if (cmd === "telephony_real_dial_status") {
          return { on_device: false, available: false, reason: "desktop" };
        }
        if (cmd === "telephony_dial") return { id: "demo-1" };
        return null;
      },
      listen: async () => async () => {},
    };
    return calls;
  };
  const callLog = () => readStoreValue<unknown[]>("amos.calllog", []);
  const dial = async (h: { container: HTMLElement }) => fireEvent.click(button(h, "呼叫"));

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    window.localStorage.removeItem("amos.calllog");
    window.localStorage.removeItem("amos.notifications");
  });

  test("守护进程不在时仍走真实系统通路，而不是只报「无法呼叫」", async () => {
    bridge(null, "ok"); // daemon down; the host can still place the call
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    await dial(host);

    await vi.waitFor(() => expect(txt(host)).toContain("未能读取默认拨号器状态"));

    expect(txt(host)).not.toContain("无法呼叫");
    expect(callLog()).toHaveLength(1);
  });

  test("紧急号码同样走真实系统通路（这才是平台紧急通路所在）", async () => {
    // This asserted the inverse before: an emergency number had to stay off `ACTION_CALL`.
    // `ACTION_CALL` is where `docs/telephony.md` §5 puts the emergency guarantee, so
    // keeping emergency calls on the daemon kept them off the only real path.
    const calls = bridge(null, "ok");
    const host = render(ContactsApp);
    await addContact(host, "急救", "110");
    await dial(host);

    await vi.waitFor(() => expect(txt(host)).toContain("未能读取默认拨号器状态"));

    expect(calls.find((c) => c.cmd === "real_dial")?.number).toBe("110");
    expect(callLog()).toHaveLength(1);
  });

  test("带分隔符的紧急号码仍被识别为紧急号（号码字段允许空格/连字符原样保存）", async () => {
    // The contact's phone field stores what the user typed, trimmed but otherwise
    // verbatim (`lib/contacts.ts::cleanPhones`), and people write emergency numbers
    // with the same separators they write any other number with. The daemon strips them
    // (`Number::new`) and classifies "1 1 0" as 110, so the classification this screen
    // hands the daemon must answer the same question — otherwise the daemon sees an
    // ordinary dial and its provider refuses it (`guard_regular`).
    const calls = desktopBridge();
    const host = render(ContactsApp);
    await addContact(host, "急救", "1 1 0");
    await dial(host);

    await vi.waitFor(() =>
      expect(calls.find((c) => c.cmd === "telephony_dial")).toBeTruthy(),
    );
    expect(calls.find((c) => c.cmd === "telephony_dial")?.emergency).toBe(true);
  });

  test("设备上没有可用真实通路时如实报错，不用模拟通话顶上", async () => {
    // The honesty rule on this screen too: an on-device build whose real path cannot fire
    // must report the failure — the daemon here answers every dial, so this is the
    // negative control for "the simulation is never reached once we know we are on a phone".
    const calls: Record<string, unknown>[] = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...(args ?? {}) });
        if (cmd === "telephony_real_dial_status") {
          return {
            on_device: true,
            available: false,
            reason: "real dial context not bound — grant CALL_PHONE and re-open the app",
          };
        }
        if (cmd === "telephony_dial") return { id: "mock-1" };
        return null;
      },
      listen: async () => async () => {},
    };
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    await dial(host);

    await vi.waitFor(() => expect(txt(host)).toContain("无法拨号"));
    expect(calls.some((c) => c.cmd === "telephony_dial")).toBe(false);
    // Nothing was placed, so nothing may be recorded as a placed call.
    expect(callLog()).toEqual([]);
  });
});

/**
 * A handed-off call whose owner is **AmOS itself** must reach an in-call surface.
 *
 * `ACTION_CALL` goes to Android Telecom, and which dialer ends up owning the call is the
 * `ROLE_DIALER` role, not the fact that this screen handed it off: when AmOS holds the
 * role (and no daemon answered), Telecom resolves the call straight back into this app's
 * own `AmosInCallService` — the fixed id `real`. The sibling dialer asks exactly this
 * after its own hand-off (`PhoneApp.startCall`, REQ-A1222); this screen kept the earlier
 * premise that a hand-off always means *another* dialer took it, so it said
 * 「已交给系统拨号器」 over a call nobody else could drive and this list has no in-call UI
 * for — a live call with no hang-up anywhere. The fix routes to the Phone app, whose
 * mount-adoption draws the real in-call surface (REQ-A1232).
 */
describe("ContactsApp.svelte — 交回的呼出必须有人接管（角色决定归属）(REQ-A1232)", () => {
  /** No daemon, a host `ACTION_CALL` that takes the call, plus the role probe + `wm_open`. */
  function bridge(roleHeld: boolean | null, wmOpen: unknown) {
    const opened: string[] = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: { label?: string }) => {
        if (cmd === "telephony_dial") return null;
        if (cmd === "real_dial") return "dialing via Android Telecom";
        if (cmd === "telephony_default_dialer_status") {
          // `null` models the *refused* probe (`invoke` folds a thrown command to `null`),
          // a different answer from "the role is not held" (REQ-A1544).
          if (roleHeld === null) return null;
          return { role_supported: true, role_held: roleHeld, role_requestable: true };
        }
        if (cmd === "wm_open") {
          opened.push(args?.label ?? "");
          return wmOpen;
        }
        return null;
      },
      listen: async () => async () => {},
    };
    return opened;
  }
  const dial = async (h: { container: HTMLElement }) => fireEvent.click(button(h, "呼叫"));

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    window.localStorage.removeItem("amos.calllog");
    window.localStorage.removeItem("amos.notifications");
  });

  test("AmOS 自己是默认电话应用 → 打开电话应用的通话界面，而不是说「已交给系统」", async () => {
    const opened = bridge(true, { windows: [] });
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    await dial(host);

    await vi.waitFor(() => expect(opened).toEqual(["phone"]));
    expect(txt(host)).toContain("正在拨号…");
    expect(txt(host)).not.toContain("已交给系统拨号器");
  });

  test("角色不归 AmOS → 仍是别的拨号器接管，不开通话界面", async () => {
    const opened = bridge(false, { windows: [] });
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    await dial(host);

    await vi.waitFor(() => expect(txt(host)).toContain("已交给系统拨号器"));
    expect(opened).toEqual([]); // another dialer's in-call UI is not ours to open
  });

  test("通话界面打不开时说实话：呼叫已拨出，不是「正在拨号」也不是「已交给系统」", async () => {
    const opened = bridge(true, null); // the host refused `wm_open`
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    await dial(host);

    await vi.waitFor(() => expect(opened).toEqual(["phone"]));
    expect(txt(host)).toContain("已拨出电话，但无法打开通话界面");
    expect(txt(host)).not.toContain("已交给系统拨号器");
  });

  test("探针失败（无判决）→ 不假装「已交给系统」；打开电话应用并说实话 (REQ-A1544)", async () => {
    // The probe is refused (`invoke` folds a thrown command to `null`), which is 「我没问到」
    // — **not** "another dialer owns the call". The old fold read it as the hand-off case
    // and could hide a call AmOS itself owns behind a line with no hang-up anywhere; the
    // honest answer opens Phone (whose mount adoption asks the same question) and says the
    // status could not be read.
    const opened = bridge(null, { windows: [] });
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    await dial(host);

    await vi.waitFor(() => expect(opened).toEqual(["phone"]));
    expect(txt(host)).toContain("未能读取默认拨号器状态");
    expect(txt(host)).not.toContain("已交给系统拨号器");
  });

  test("探针无判决且通话界面也打不开时，仍不假装「已交给系统」(REQ-A1544)", async () => {
    const opened = bridge(null, null); // refused probe AND refused `wm_open`
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    await dial(host);

    await vi.waitFor(() => expect(opened).toEqual(["phone"]));
    expect(txt(host)).toContain("已拨出电话，但无法打开通话界面");
    expect(txt(host)).not.toContain("已交给系统拨号器");
  });
});

/**
 * The `contacts` capability is declared on both ledgers (host `privacy.rs` /
 * container `capability.rs`) and the Privacy dashboard renders this app as a
 * revocable holder (`osCapabilities.DEFAULT_CAPABILITIES.contacts`). Until this
 * round the screen named by that capability referenced it **nowhere** — the
 * declaration was decorative (audit P1-C1). The repo's owning-screen doctrine
 * (CameraApp: no in-app gate, mount re-seed; VoiceMemosApp: re-assert at the
 * point of use) is what fixes the direction: the screen that *owns* the
 * resource re-asserts it through the one seam, rather than prompting.
 */
describe("ContactsApp.svelte — 默认开启的 contacts 能力", () => {
  afterEach(() => {
    window.localStorage.removeItem("amos.permissions");
  });

  test("挂载即重申 contacts（显式撤销在下次打开本屏时回来）", () => {
    // Leave the ledger the way the Privacy dashboard leaves it after a revoke.
    revokeCapability("contacts", "contacts");
    expect(capSet(loadLedger(), "contacts", "contacts")).toBe(false);

    render(ContactsApp);

    // Without the mount re-assert this stays `false`: the app the capability names
    // never touched the ledger, so a revoke was permanent *and* a grant was never
    // re-asserted — the capability was declared but unused.
    expect(capSet(loadLedger(), "contacts", "contacts")).toBe(true);
  });
});
