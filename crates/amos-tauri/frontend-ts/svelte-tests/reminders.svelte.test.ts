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
import { zh } from "../src/i18n/locales/zh";
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
const deleteListButton = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === zh["reminder.deleteList"],
  ) as HTMLButtonElement | undefined;

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

  // REQ-A968: the「提醒我」button's label is constant and it reveals a block of fields — the
  // open/closed state was invisible to AT. `aria-expanded` is the repo idiom for a disclosure
  // (Dock.svelte:777).
  test("schedule disclosure announces its expanded state", async () => {
    seed();
    const host = render(RemindersApp);
    await fireEvent.click(buttonContaining(host, "新提醒事项") as HTMLButtonElement);
    const schedule = buttonContaining(host, zh["reminder.schedule"]) as HTMLButtonElement;
    expect(schedule).toBeTruthy();
    expect(schedule.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(schedule);
    expect(
      (buttonContaining(host, zh["reminder.schedule"]) as HTMLButtonElement).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
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
    // Pending rows expose a "mark done" toggle button, whose accessible name is the
    // localised action plus the reminder's own title (REQ-A461: it used to be the
    // English literal "done"). Select by the dictionary's prefix so the assertion
    // does not freeze a language.
    const donePrefix = zh["reminder.markDone"].split("{name}")[0];
    const toggles = [...host.container.querySelectorAll("button")].filter((b) =>
      (b.getAttribute("aria-label") ?? "").startsWith(donePrefix),
    );
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

  // REQ-A970: the new-list colour picker is a one-of-N selection whose chosen dot
  // lived only in a `ring-2` class — the per-dot accessible name (`aria-label={col}`)
  // never changed, so AT could not tell which colour was picked. The **identical
  // widget in CalendarApp** (`newCalColor` dots) already carries `aria-pressed`.
  test("the new-list colour dots expose which colour is selected", async () => {
    seed();
    const host = render(RemindersApp);
    const openNewList = [...host.container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "新建列表",
    );
    expect(openNewList).toBeTruthy();
    await fireEvent.click(openNewList as HTMLButtonElement);
    const dot = (name: string) =>
      [...host.container.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === name,
      ) as HTMLButtonElement | undefined;
    // default colour is "blue"
    expect(dot("blue")?.getAttribute("aria-pressed")).toBe("true");
    expect(dot("red")?.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(dot("red") as HTMLButtonElement);
    expect(dot("red")?.getAttribute("aria-pressed")).toBe("true");
    expect(dot("blue")?.getAttribute("aria-pressed")).toBe("false");
  });

  // REQ-A1460 / F-SH-712 — deleting a list is TWO writes to two stores: reassign the
  // reminders that lived in it, then remove the list. Pre-fix both verdicts were discarded and
  // the destructive half ran regardless, so a *refused reassignment* still destroyed the list:
  // its reminders kept `listId: "life"` while "life" was gone from `amos.reminderLists`. Nothing
  // reassigns an orphan (`normalizeReminders` only defaults a *missing* `listId` — it never
  // checks the list exists), so the dangling reference is stored. The sibling handlers in the
  // very same component (`commit`, `snooze`, `createList`) all read their verdict, and
  // `CalendarApp.deleteCalendar` orders these same two writes the other way for this reason
  // ("nothing else may move if the calendar itself was not removed").
  const listsNow = () => readStoreValue<ReminderList[]>(LISTS_KEY, []);
  const remsNow = () => readStoreValue<Reminder[]>(REMINDERS_KEY, []);

  test("a refused reminder-move does not let the list be destroyed", async () => {
    seed();
    const host = render(RemindersApp);
    await fireEvent.click(buttonContaining(host, "生活") as HTMLButtonElement);
    const restore = failWritesFor(REMINDERS_KEY);
    try {
      await fireEvent.click(deleteListButton(host) as HTMLButtonElement);
      // The reassignment never landed, so the list must still be there…
      expect(listsNow().some((l) => l.id === "life")).toBe(true);
      // …and the reminders must still point at it: no dangling reference either way.
      expect(remsNow().filter((r) => r.listId === "life").length).toBe(3);
      expect(txt(host)).toContain("本机存储写入失败");
    } finally {
      restore();
    }
  });

  test("a refused list-removal leaves no reminder pointing at a missing list", async () => {
    seed();
    const host = render(RemindersApp);
    await fireEvent.click(buttonContaining(host, "生活") as HTMLButtonElement);
    const restore = failWritesFor(LISTS_KEY);
    try {
      await fireEvent.click(deleteListButton(host) as HTMLButtonElement);
      // Whatever landed, the domain invariant must hold: every reminder's list exists.
      const ids = new Set(listsNow().map((l) => l.id));
      expect(remsNow().every((r) => ids.has(r.listId))).toBe(true);
      expect(txt(host)).toContain("本机存储写入失败");
      // The list was not removed, so the screen must not navigate away from it — the delete
      // control only renders while a (non-default) list is selected, so its presence *is* the
      // "we are still looking at that list" claim.
      expect(deleteListButton(host)).toBeTruthy();
    } finally {
      restore();
    }
  });

  test("a landed delete removes the list and moves its reminders to the inbox", async () => {
    seed();
    const host = render(RemindersApp);
    await fireEvent.click(buttonContaining(host, "生活") as HTMLButtonElement);
    await fireEvent.click(deleteListButton(host) as HTMLButtonElement);
    expect(listsNow().some((l) => l.id === "life")).toBe(false);
    expect(remsNow().every((r) => r.listId === DEFAULT_LIST_ID)).toBe(true);
    // The reminders are still reachable — they moved to the inbox, they were not deleted.
    expect(txt(host)).toContain("买牛奶");
  });

  // The guard must be keyed on "is there anything to move", not on "did we write" — deleting an
  // EMPTY list moves nothing, so it must not be blocked by an unrelated refusal of the reminders
  // store (nor write to it at all).
  test("deleting an empty list still works when the reminders store refuses writes", async () => {
    seed();
    writeStoreValue(LISTS_KEY, [
      { id: DEFAULT_LIST_ID, custom: false, name: "", color: "blue", createdAt: 1 },
      { id: "empty", custom: true, name: "空列表", color: "red", createdAt: 2 },
    ]);
    const host = render(RemindersApp);
    await fireEvent.click(buttonContaining(host, "空列表") as HTMLButtonElement);
    const restore = failWritesFor(REMINDERS_KEY);
    try {
      await fireEvent.click(deleteListButton(host) as HTMLButtonElement);
      expect(listsNow().some((l) => l.id === "empty")).toBe(false);
      expect(txt(host)).not.toContain("本机存储写入失败");
    } finally {
      restore();
    }
  });
});
