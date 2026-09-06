/**
 * DOM tests for the Svelte 5 contacts screen (ContactsApp.svelte).
 *
 * Pure contact logic is unit-tested once against lib/contacts.ts (shared by the
 * React + Svelte UIs). Here we verify the Svelte UI wiring: store persistence,
 * the composer (add/dup-guard), favorite toggle, delete-confirm, and search.
 */
import { describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import ContactsApp from "../src/svelte/ContactsApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";

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
