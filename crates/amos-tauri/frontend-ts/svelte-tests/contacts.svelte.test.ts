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
