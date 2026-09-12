/**
 * DOM tests for the Svelte 5 reminders screen (RemindersApp.svelte).
 *
 * Reminder domain logic is unit-tested once against pure lib/reminders.ts
 * (shared by the React + Svelte UIs). Here we verify the Svelte UI wiring on
 * top of the same shared amos.reminders / amos.reminderLists store: seeding,
 * adding through the compose form, completing (moves between smart views), a
 * custom-list chip, and search filtering.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import RemindersApp from "../src/svelte/RemindersApp.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import {
  DEFAULT_LIST_ID,
  LISTS_KEY,
  REMINDERS_KEY,
  type Reminder,
  type ReminderList,
} from "../src/lib/reminders";

afterEach(cleanup);

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttonContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;
const inputByLabel = (h: { container: HTMLElement }, label: string) =>
  [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === label) as
    HTMLInputElement | undefined;

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

/** Deterministic fixture: an inbox + a custom "生活" list with 2 pending + 1 done. */
function seed() {
  const now = Date.now();
  const lists: ReminderList[] = [
    { id: DEFAULT_LIST_ID, custom: false, name: "", color: "blue", createdAt: now },
    { id: "life", custom: true, name: "生活", color: "green", createdAt: now + 1 },
  ];
  const rems: Reminder[] = [
    { id: "a", title: "买牛奶", listId: "life", priority: 0, flagged: false, createdAt: now },
    {
      id: "b",
      title: "交房租",
      listId: "life",
      priority: 2,
      flagged: true,
      createdAt: now + 1,
      dueAt: now + 3_600_000,
    },
    {
      id: "c",
      title: "已完成事",
      listId: "life",
      priority: 0,
      flagged: false,
      createdAt: now + 2,
      completed: true,
      completedAt: now + 3,
    },
  ];
  writeStoreValue(LISTS_KEY, lists);
  writeStoreValue(REMINDERS_KEY, rems);
}

describe("RemindersApp.svelte", () => {
  test("an intentionally emptied store is not re-seeded with demo reminders", () => {
    window.localStorage.setItem("amos.reminders", "[]");
    window.localStorage.setItem("amos.reminderLists", "[]");
    const host = render(RemindersApp);
    // The built-in default list is repaired (nothing is unreachable), but the demo
    // reminders must not come back.
    expect(txt(host)).not.toContain("买牛奶");
    expect(readStoreValue<unknown>("amos.reminders", null)).toEqual([]);
  });

  test("seeds show in 全部 and the custom list chip appears", () => {
    seed();
    const host = render(RemindersApp);
    expect(txt(host)).toContain("买牛奶");
    expect(txt(host)).toContain("交房租");
    // The custom list chip carries its localized "生活" name.
    expect(buttonContaining(host, "生活")).toBeTruthy();
  });

  test("adding a reminder through compose persists it and shows it", async () => {
    seed();
    const host = render(RemindersApp);
    await fireEvent.click(buttonContaining(host, "新提醒事项") as HTMLButtonElement);
    const title = inputByLabel(host, "标题");
    expect(title).toBeTruthy();
    await fireEvent.input(title as HTMLInputElement, { target: { value: "买咖啡" } });
    await fireEvent.click(buttonContaining(host, "添加") as HTMLButtonElement);
    expect(txt(host)).toContain("买咖啡");
    const stored = readStoreValue<Reminder[]>(REMINDERS_KEY, []);
    expect(stored.some((r) => r.title === "买咖啡")).toBe(true);
  });

  test("a rejected write is reported and the reminder is not applied", async () => {
    seed();
    const restore = failWritesFor(REMINDERS_KEY);
    try {
      const host = render(RemindersApp);
      await fireEvent.click(buttonContaining(host, "新提醒事项") as HTMLButtonElement);
      await fireEvent.input(inputByLabel(host, "标题") as HTMLInputElement, {
        target: { value: "买咖啡" },
      });
      await fireEvent.click(buttonContaining(host, "添加") as HTMLButtonElement);
      // The store never accepted it, so the list must not show it (and the compose
      // form stays open with the draft).
      expect(txt(host)).toContain("本机存储写入失败");
      expect(txt(host)).not.toContain("买咖啡");
      expect(inputByLabel(host, "标题")).toBeTruthy();
      expect(readStoreValue<Reminder[]>(REMINDERS_KEY, []).some((r) => r.title === "买咖啡")).toBe(
        false,
      );
    } finally {
      restore();
    }
  });

  test("completing moves a reminder out of 全部 into the 已完成 smart view", async () => {
    seed();
    const host = render(RemindersApp);
    // Pending rows expose a "done" toggle button (aria-label="done").
    const toggles = [...host.container.querySelectorAll('button[aria-label="done"]')];
    expect(toggles.length).toBe(2);
    await fireEvent.click(toggles[0] as HTMLButtonElement);
    expect(txt(host)).not.toContain("买牛奶");

    // 已完成 smart chip now lists the just-completed reminder.
    const doneChip = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim().startsWith("已完成"),
    );
    expect(doneChip).toBeTruthy();
    await fireEvent.click(doneChip as HTMLButtonElement);
    expect(txt(host)).toContain("买牛奶");
  });

  test("search narrows the current view by title", async () => {
    seed();
    const host = render(RemindersApp);
    // Open search via the header 🔍 (aria-label = reminder.search).
    const openSearch = [...host.container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "搜索提醒事项…",
    );
    expect(openSearch).toBeTruthy();
    await fireEvent.click(openSearch as HTMLButtonElement);
    const q = inputByLabel(host, "搜索提醒事项…");
    await fireEvent.input(q as HTMLInputElement, { target: { value: "房租" } });
    expect(txt(host)).toContain("交房租");
    expect(txt(host)).not.toContain("买牛奶");
  });
});
