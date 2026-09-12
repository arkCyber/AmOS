/**
 * DOM tests for the Svelte 5 contacts screen (ContactsApp.svelte).
 *
 * Pure contact logic is unit-tested once against lib/contacts.ts (shared by the
 * React + Svelte UIs). Here we verify the Svelte UI wiring: store persistence,
 * the composer (add/dup-guard), favorite toggle, delete-confirm, and search.
 */
import { afterEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import ContactsApp from "../src/svelte/ContactsApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { contactsChannel } from "../src/svelte/appLinks";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { MAX_IMPORT_BYTES } from "../src/lib/contactTransfer";

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

  test("duplicate number is rejected (dup guard)", async () => {
    const host = render(ContactsApp);
    await addContact(host, "A", "13800000001");
    // reopen add with the same number on a new name
    await addContact(host, "B", "13800000001");
    expect(txt(host)).toContain("该号码已在通讯录中");
    // B was NOT added
    expect(txt(host)).not.toContain("B");
  });

  test("favorite toggles the star", async () => {
    const host = render(ContactsApp);
    await addContact(host, "Alice", "13800000001");
    expect(txt(host)).not.toContain("★");
    await fireEvent.click(button(host, "收藏"));
    expect(txt(host)).toContain("★");
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
      expect(revoked).toContain("blob:mock-url"); // the object URL is released
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
