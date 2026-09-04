import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { AppComponent, appIcon, appTitleKey } from "../apps";
import { AppIconTile, isBespokeTile } from "../components/AppIcon";
import { writeStoreValue } from "../lib/amosStore";
import { REMINDERS_KEY, LISTS_KEY } from "../lib/reminders";

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
  window.localStorage.removeItem(REMINDERS_KEY);
  window.localStorage.removeItem(LISTS_KEY);
});

async function mountReminders() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AppComponent id="reminders" />
      </I18nProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  mounted.push({ root, host });
  return host;
}

function typeInto(el: HTMLInputElement, text: string) {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  const props = (el as unknown as Record<string, { onChange?: (e: { target: { value: string } }) => void }>)[key!]!;
  props.onChange?.({ target: { value: text } });
}
const clickText = async (host: HTMLElement, needle: string) => {
  const btn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.includes(needle));
  expect(btn, `button containing "${needle}"`).toBeTruthy();
  await act(async () => btn!.click());
};
/** Click the leaf (deepest) node whose trimmed text equals `text` — bubbles up
 *  to the row's onOpen handler so it opens the edit form for that reminder. */
const clickLeaf = async (host: HTMLElement, text: string) => {
  const el = Array.from(host.querySelectorAll<HTMLElement>("div")).find(
    (n) => n.children.length === 0 && n.textContent?.trim() === text,
  );
  expect(el, `leaf with text "${text}"`).toBeTruthy();
  await act(async () => el!.click());
};
const storeReminders = () =>
  JSON.parse(window.localStorage.getItem(REMINDERS_KEY) ?? "[]") as { title: string; completed?: boolean }[];

describe("Reminders — iOS-style lists + compose (DOM)", () => {
  test("is registered with a home-screen tile icon and title", () => {
    expect(appTitleKey("reminders")).toBe("app.reminders"); // discoverable on the launcher
    expect(appIcon("reminders")).toBe("✅"); // registry glyph (still distinct from 📝 / 🕐)
    // It opts into the bespoke iOS-style face: white card + coloured checklist.
    expect(isBespokeTile("reminders")).toBe(true);
    expect(isBespokeTile("clock")).toBe(false); // other apps keep the uniform tone
    const host = document.createElement("span");
    const root = createRoot(host);
    act(() => {
      root.render(<AppIconTile id="reminders" icon={appIcon("reminders")} />);
    });
    expect(host.querySelector("svg")).toBeTruthy(); // dedicated checklist art, not a glyph
    const tile = host.querySelector("span") as HTMLElement | null;
    expect(tile?.style?.backgroundImage ?? "").toContain("gradient"); // bespoke white-card base
    act(() => root.unmount());
  });
  test("seeds and shows smart chips, a reminder row and the compose bar", async () => {
    const host = await mountReminders();
    expect(host.textContent).toContain("全部");
    expect(host.textContent).toContain("今天");
    expect(host.textContent).toContain("计划");
    expect(host.textContent).toContain("已完成");
    expect(host.textContent).toContain("写周报"); // a seeded pending reminder
    expect(host.textContent).toContain("新提醒事项");
  });

  test("compose a new reminder and persist it to the shared store", async () => {
    const host = await mountReminders();
    await clickText(host, "新提醒事项");
    const title = host.querySelector('input[placeholder="标题"]') as HTMLInputElement;
    expect(title).toBeTruthy();
    await act(async () => typeInto(title, "周五站会"));
    await clickText(host, "添加");
    // Saved row visible in 全部 and stored.
    expect(host.textContent).toContain("周五站会");
    expect(storeReminders().length).toBe(7); // 6 seeded + 1
    expect(storeReminders().some((x) => x.title === "周五站会" && !x.completed)).toBe(true);
  });

  test("tapping the circle completes a reminder and moves it to 已完成", async () => {
    const host = await mountReminders();
    const done = Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-label="done"]'));
    expect(done.length).toBeGreaterThan(0);
    await act(async () => done[0]!.click());
    // A newly-completed seed item is no longer in the pending 全部 feed.
    const doneCount = storeReminders().filter((x) => x.completed).length;
    expect(doneCount).toBe(2); // 1 seed + the one we just completed
    // It appears under the 已完成 smart view.
    await clickText(host, "已完成");
    expect(storeReminders().filter((x) => x.completed).length).toBe(2);
  });

  test("editing a scheduled reminder reveals its date editor; clearing notes persists", async () => {
    const dueAt = Math.floor(Date.now() / 60_000) * 60_000 + 3_600_000; // whole-minute, future
    writeStoreValue(REMINDERS_KEY, [
      {
        id: "a",
        title: "带时间的事",
        listId: "inbox",
        priority: 0,
        flagged: false,
        createdAt: Date.now(),
        dueAt,
        allDay: false,
        notes: "老备注",
      },
    ]);
    const host = await mountReminders();
    await clickLeaf(host, "带时间的事");
    // Fix 1: an existing due date must be editable (its editor is open by default).
    expect(host.querySelector('input[type="date"]')).toBeTruthy();
    // Fix 2: clearing the notes field must actually remove them on save.
    const notes = host.querySelector('input[placeholder="备注"]') as HTMLInputElement;
    expect(notes?.value).toBe("老备注");
    await act(async () => typeInto(notes, ""));
    await clickText(host, "保存");
    const stored = JSON.parse(window.localStorage.getItem(REMINDERS_KEY) ?? "[]") as Record<string, unknown>[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.notes).toBeUndefined(); // truly cleared
    expect(typeof stored[0]!.dueAt).toBe("number"); // schedule preserved
  });

  test("editing an unscheduled reminder can add a schedule via 提醒我", async () => {
    writeStoreValue(REMINDERS_KEY, [
      {
        id: "b",
        title: "还没有时间的事",
        listId: "inbox",
        priority: 0,
        flagged: false,
        createdAt: Date.now(),
      },
    ]);
    const host = await mountReminders();
    await clickLeaf(host, "还没有时间的事");
    expect(host.querySelector('input[type="date"]')).toBeFalsy(); // unscheduled → editor closed
    await clickText(host, "提醒我"); // now available in edit mode too
    expect(host.querySelector('input[type="date"]')).toBeTruthy();
  });

  test("searches the current view by title and clears back to all", async () => {
    const host = await mountReminders(); // demo seeds are present
    const toggle = host.querySelector('button[aria-label="搜索提醒事项…"]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    await act(async () => toggle.click());
    const box = host.querySelector('input[aria-label="搜索提醒事项…"]') as HTMLInputElement;
    expect(box).toBeTruthy();
    await act(async () => typeInto(box, "周报"));
    expect(host.textContent).toContain("写周报"); // matched
    expect(host.textContent).not.toContain("去健身"); // filtered out
    await act(async () => typeInto(box, ""));
    expect(host.textContent).toContain("去健身"); // clearing the query restores the view
  });

  test("a list view shows a collapsible 已完成 section", async () => {
    writeStoreValue(REMINDERS_KEY, [
      { id: "p", title: "待办P", listId: "inbox", priority: 0, flagged: false, createdAt: Date.now() },
      {
        id: "d",
        title: "已完成D",
        listId: "inbox",
        priority: 0,
        flagged: false,
        createdAt: Date.now() - 1000,
        completed: true,
        completedAt: Date.now() - 500,
      },
    ]);
    const host = await mountReminders();
    await clickText(host, "提醒事项"); // open the built-in inbox list view
    expect(host.textContent).toContain("待办P");
    expect(host.textContent).not.toContain("已完成D"); // completed group is collapsed
    await clickText(host, "已完成 (1)"); // the per-list completed section header
    expect(host.textContent).toContain("已完成D");
  });

  test("✓ 全部完成 completes every pending reminder in the current view", async () => {
    const host = await mountReminders(); // demo seeds (5 pending) present in 全部
    await clickText(host, "全部完成");
    const all = JSON.parse(window.localStorage.getItem(REMINDERS_KEY) ?? "[]") as { completed?: boolean }[];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((x) => x.completed === true)).toBe(true); // all completed
    expect(host.textContent).toContain("暂无提醒事项"); // pending feed is now empty
  });

  test("⏰ 推迟 1 小时 pushes a past-due reminder ~1 hour into the future", async () => {
    const past = Date.now() - 5_000; // already overdue
    writeStoreValue(REMINDERS_KEY, [
      { id: "s", title: "已到期事项", listId: "inbox", priority: 0, flagged: false, createdAt: past, dueAt: past },
    ]);
    const host = await mountReminders();
    await clickLeaf(host, "已到期事项"); // open edit (schedule editor visible)
    await clickText(host, "推迟 1 小时");
    const stored = JSON.parse(window.localStorage.getItem(REMINDERS_KEY) ?? "[]") as { id: string; dueAt?: number }[];
    const s = stored.find((x) => x.id === "s");
    expect(s).toBeTruthy();
    expect(typeof s?.dueAt).toBe("number");
    expect(s!.dueAt! > Date.now()).toBe(true); // moved out ~1 h
  });
});
