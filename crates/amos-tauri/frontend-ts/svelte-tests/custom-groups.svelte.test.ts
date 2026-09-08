/**
 * custom-groups.svelte.test.ts — user-created (empty) groups in the App Library.
 * Covers the pure storage helpers (lib/customGroups.ts) and the DOM flow
 * (＋ 新建分组 → input → create → card shown; delete ✕ removes it).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AppLibrary from "../src/svelte/AppLibrary.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { resetShellState } from "../src/svelte/shellState.svelte";
import {
  addCustomGroup,
  getCustomGroups,
  removeCustomGroup,
  renameCustomGroup,
  setGroupApps,
  setGroupIcon,
} from "../src/lib/customGroups";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  resetShellState();
});
afterEach(() => {
  resetPropsChannels();
});

const zhLabel = (key: string): string => zh[key as keyof typeof zh] ?? key;

describe("lib/customGroups - storage helpers", () => {
  test("starts empty and adds a trimmed named group (persisted)", () => {
    expect(getCustomGroups()).toEqual([]);
    const { created } = addCustomGroup([], "  学习  ");
    expect(created.name).toBe("学习");
    expect(getCustomGroups().map((g) => g.name)).toEqual(["学习"]);
  });

  test("empty/blank name falls back to a default label", () => {
    const { created } = addCustomGroup([], "   ");
    expect(created.name).toBe("未命名分组");
  });

  test("removeCustomGroup deletes only the matching id (persisted)", () => {
    const { created } = addCustomGroup([], "A");
    const b = addCustomGroup([], "B");
    const after = removeCustomGroup(b.groups, created.id);
    expect(after.map((g) => g.name)).toEqual(["B"]);
    expect(getCustomGroups().map((g) => g.name)).toEqual(["B"]);
  });

  test("renameCustomGroup updates the name and ignores empty input (persisted)", () => {
    const { created } = addCustomGroup([], "工具");
    const renamed = renameCustomGroup([created], created.id, "  工作  ");
    expect(renamed[0].name).toBe("工作");
    expect(getCustomGroups()[0].name).toBe("工作");
    // blank → unchanged (returns same list, nothing persisted)
    const same = renameCustomGroup([{ ...created, name: "工作" }], created.id, "   ");
    expect(same[0].name).toBe("工作");
  });

  test("setGroupIcon sets and clears the icon (persisted)", () => {
    const { created } = addCustomGroup([], "X");
    const withIcon = setGroupIcon([created], created.id, "❤️");
    expect(withIcon[0].icon).toBe("❤️");
    expect(getCustomGroups()[0].icon).toBe("❤️");
    const cleared = setGroupIcon(withIcon, created.id, undefined);
    expect(cleared[0].icon).toBeUndefined();
    expect(getCustomGroups()[0].icon).toBeUndefined();
  });
});

describe("AppLibrary.svelte - 新建分组 (+)", () => {
  async function renderLibrary() {
    propsChannel<{ layout: { page: string[]; dock: string[]; hidden: string[] }; ext: [] }>(
      "appLibrary",
    ).set({ layout: { page: [], dock: [], hidden: [] }, ext: [] });
    return render(AppLibrary);
  }

  test("+ creates a folder at once with the default name and opens it for rename", async () => {
    const { container } = await renderLibrary();
    await tick();

    const newCard = container.querySelector(
      '[data-testid="app-library-new-group"]',
    ) as HTMLButtonElement | null;
    expect(newCard).toBeTruthy();
    expect(newCard!.textContent).toContain("＋");
    await fireEvent.click(newCard!);
    await tick();

    // Immediately created with the iOS-like default name "新建文件夹"…
    expect(getCustomGroups().map((g) => g.name)).toEqual(["新建文件夹"]);
    // …and the group is opened straight into its rename field (prefilled).
    const input = container.querySelector(
      '[data-testid="app-library-rename-input"]',
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("新建文件夹");
  });

  test("leaving a new folder via ‹ resets rename; opening another group is not in rename", async () => {
    addCustomGroup([], "已有组");
    const { container } = await renderLibrary();
    await tick();

    // create a new folder → it opens in rename mode
    const newCard = container.querySelector(
      '[data-testid="app-library-new-group"]',
    ) as HTMLButtonElement | null;
    await fireEvent.click(newCard!);
    await tick();
    expect(
      container.querySelector('[data-testid="app-library-rename-input"]'),
    ).toBeTruthy();

    // back out without saving
    const back = container.querySelector('button[aria-label="back"]');
    await fireEvent.click(back as HTMLButtonElement);
    await tick();

    // open the pre-existing group → it must NOT be in rename mode
    const cards = [...container.querySelectorAll('[data-testid="app-library-custom-group"]')];
    const existing = cards.find((b) => b.getAttribute("aria-label") === "已有组");
    expect(existing).toBeTruthy();
    await fireEvent.click(existing as HTMLButtonElement);
    await tick();

    expect(
      container.querySelector('[data-testid="app-library-rename-input"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="app-library-rename"]')).toBeTruthy();
  });

  test("deleting a custom group (from inside it) removes it and the persisted entry", async () => {
    addCustomGroup([], "测试");
    const { container } = await renderLibrary();
    await tick();

    expect(container.textContent).toContain("测试");
    const card = container.querySelector(
      '[data-testid="app-library-custom-group"]',
    ) as HTMLButtonElement | null;
    expect(card).toBeTruthy();
    await fireEvent.click(card!);
    await tick();

    const del = container.querySelector(
      '[data-testid="app-library-group-delete"]',
    ) as HTMLButtonElement | null;
    expect(del).toBeTruthy();
    await fireEvent.click(del!);
    await tick();

    expect(getCustomGroups()).toEqual([]);
    expect(container.textContent).not.toContain("测试");
  });
});

describe("AppLibrary.svelte - custom-group section header", () => {
  test("'我的分组' section title appears only once a group exists", async () => {
    propsChannel<{ layout: { page: string[]; dock: string[]; hidden: string[] }; ext: [] }>(
      "appLibrary",
    ).set({ layout: { page: [], dock: [], hidden: [] }, ext: [] });

    const noHeader = render(AppLibrary);
    await tick();
    expect(noHeader.container.textContent).not.toContain(zhLabel("appLibrary.customSection"));

    addCustomGroup([], "游戏");
    const { container } = render(AppLibrary);
    await tick();
    expect(container.textContent).toContain(zhLabel("appLibrary.customSection"));
  });
});

describe("AppLibrary.svelte - custom group membership", () => {
  async function renderLibrary() {
    propsChannel<{ layout: { page: string[]; dock: string[]; hidden: string[] }; ext: [] }>(
      "appLibrary",
    ).set({ layout: { page: [], dock: [], hidden: [] }, ext: [] });
    return render(AppLibrary);
  }

  test("add an app from the edit view; it shows as a member and persists", async () => {
    addCustomGroup([], "收藏");
    const { container } = await renderLibrary();
    await tick();

    const card = container.querySelector(
      '[data-testid="app-library-custom-group"]',
    ) as HTMLButtonElement | null;
    expect(card).toBeTruthy();
    await fireEvent.click(card!);
    await tick();
    expect(container.textContent).toContain(zhLabel("appLibrary.emptyMembers"));

    const edit = container.querySelector(
      '[data-testid="app-library-edit-members"]',
    ) as HTMLButtonElement | null;
    expect(edit).toBeTruthy();
    await fireEvent.click(edit!);
    await tick();

    const phoneRow = container.querySelector(
      `button[aria-label="${zhLabel("app.phone")}"]`,
    ) as HTMLButtonElement | null;
    expect(phoneRow).toBeTruthy();
    await fireEvent.click(phoneRow!);
    await tick();

    const done = container.querySelector(
      '[data-testid="app-library-done-members"]',
    ) as HTMLButtonElement | null;
    await fireEvent.click(done!);
    await tick();

    // Member persisted and shown as a tile in the group view.
    expect(getCustomGroups()[0].apps).toEqual(["phone"]);
    expect(
      container.querySelector(`button[aria-label="${zhLabel("app.phone")}"]`),
    ).toBeTruthy();
  });

  test("remove a member app removes it and persists", async () => {
    const { created } = addCustomGroup([], "工具");
    setGroupApps([created], created.id, ["phone", "clock"]);
    const { container } = await renderLibrary();
    await tick();

    const card = container.querySelector(
      '[data-testid="app-library-custom-group"]',
    ) as HTMLButtonElement | null;
    await fireEvent.click(card!);
    await tick();

    const edit = container.querySelector(
      '[data-testid="app-library-edit-members"]',
    ) as HTMLButtonElement | null;
    await fireEvent.click(edit!);
    await tick();

    const clockRow = container.querySelector(
      `button[aria-label="${zhLabel("app.clock")}"]`,
    ) as HTMLButtonElement | null;
    expect(clockRow).toBeTruthy();
    await fireEvent.click(clockRow!); // already a member → remove
    await tick();

    expect(getCustomGroups()[0].apps).toEqual(["phone"]);
  });

  test("renaming a group updates its name and the card", async () => {
    addCustomGroup([], "工具");
    const { container } = await renderLibrary();
    await tick();

    const card = container.querySelector(
      '[data-testid="app-library-custom-group"]',
    ) as HTMLButtonElement | null;
    await fireEvent.click(card!);
    await tick();

    const rename = container.querySelector(
      '[data-testid="app-library-rename"]',
    ) as HTMLButtonElement | null;
    expect(rename).toBeTruthy();
    await fireEvent.click(rename!);
    await tick();

    const input = container.querySelector(
      '[data-testid="app-library-rename-input"]',
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("工具"); // prefilled
    await fireEvent.input(input!, { target: { value: "工作用" } });
    const save = container.querySelector(
      '[data-testid="app-library-rename-save"]',
    ) as HTMLButtonElement | null;
    await fireEvent.click(save!);
    await tick();

    expect(getCustomGroups()[0].name).toBe("工作用");
    expect(container.textContent).toContain("工作用");
    expect(container.textContent).not.toContain(">工具<"); // header now shows new name
  });

  test("dragging a member before another reorders the group (persisted)", async () => {
    const { created } = addCustomGroup([], "排序");
    setGroupApps([created], created.id, ["phone", "clock", "weather"]);
    const { container } = await renderLibrary();
    await tick();

    const card = container.querySelector(
      '[data-testid="app-library-custom-group"]',
    ) as HTMLButtonElement | null;
    await fireEvent.click(card!);
    await tick();

    // Grab "天气" (weather) and drop it onto "电话" (phone) → it moves to the front.
    const weather = container.querySelector(
      `button[aria-label="${zhLabel("app.weather")}"]`,
    ) as HTMLButtonElement | null;
    const phone = container.querySelector(
      `button[aria-label="${zhLabel("app.phone")}"]`,
    ) as HTMLButtonElement | null;
    expect(weather && phone).toBeTruthy();

    await fireEvent.dragStart(weather!);
    await fireEvent.drop(phone!);
    await tick();

    expect(getCustomGroups()[0].apps).toEqual(["weather", "phone", "clock"]);
  });

  test("a stray click right after a drag-reorder does NOT open the app", async () => {
    const opened: string[] = [];
    const un = propsChannel("appLibrary").on((e, d) => {
      if (e === "open" && typeof d === "string") opened.push(d);
    });

    const { created } = addCustomGroup([], "守卫");
    setGroupApps([created], created.id, ["phone", "clock"]);
    const { container } = await renderLibrary();
    await tick();
    const card = container.querySelector(
      '[data-testid="app-library-custom-group"]',
    ) as HTMLButtonElement | null;
    await fireEvent.click(card!);
    await tick();

    const phone = container.querySelector(
      `button[aria-label="${zhLabel("app.phone")}"]`,
    ) as HTMLButtonElement | null;
    const clock = container.querySelector(
      `button[aria-label="${zhLabel("app.clock")}"]`,
    ) as HTMLButtonElement | null;
    expect(phone && clock).toBeTruthy();

    // Drag phone onto clock, then a stray click lands on clock — should not open.
    await fireEvent.dragStart(phone!);
    await fireEvent.drop(clock!);
    await fireEvent.click(clock!);
    await tick();
    expect(opened).toEqual([]);

    un();
  });

  test("touch reorder via ▲/▼ moves a member and persists", async () => {
    const { created } = addCustomGroup([], "触屏");
    setGroupApps([created], created.id, ["phone", "clock", "weather"]);
    const { container } = await renderLibrary();
    await tick();

    const card = container.querySelector(
      '[data-testid="app-library-custom-group"]',
    ) as HTMLButtonElement | null;
    await fireEvent.click(card!);
    await tick();

    const toggle = container.querySelector(
      '[data-testid="app-library-sort-toggle"]',
    ) as HTMLButtonElement | null;
    expect(toggle).toBeTruthy();
    await fireEvent.click(toggle!);
    await tick();

    // First member (phone) → its ▼ moves it down one slot.
    const downs = [...container.querySelectorAll('[data-testid="app-library-member-down"]')];
    expect(downs.length).toBe(3);
    await fireEvent.click(downs[0] as HTMLButtonElement);
    await tick();
    expect(getCustomGroups()[0].apps).toEqual(["clock", "phone", "weather"]);

    // ▲ of the now-first member (clock) is disabled at the top.
    const firstUp = container.querySelector(
      '[data-testid="app-library-member-up"]',
    ) as HTMLButtonElement | null;
    expect(firstUp!.disabled).toBe(true);
  });
});



describe("AppLibrary.svelte - dedup names + custom icon", () => {
  async function renderHomeWith(groups?: ReturnType<typeof addCustomGroup>["created"][]) {
    propsChannel<{ layout: { page: string[]; dock: string[]; hidden: string[] }; ext: [] }>(
      "appLibrary",
    ).set({ layout: { page: [], dock: [], hidden: [] }, ext: [] });
    return render(AppLibrary);
  }

  test("creating folders auto-numbers the default name (新建文件夹 → 新建文件夹 2)", async () => {
    const { container } = await renderHomeWith();
    await tick();

    for (const expected of ["新建文件夹", "新建文件夹 2"]) {
      const newCard = container.querySelector(
        '[data-testid="app-library-new-group"]',
      ) as HTMLButtonElement | null;
      await fireEvent.click(newCard!);
      await tick();
      expect(getCustomGroups().map((g) => g.name)).toContain(expected);
      // each new folder opens prefilled with its unique default name; go back home
      const back = container.querySelector('button[aria-label="back"]');
      await fireEvent.click(back as HTMLButtonElement);
      await tick();
    }
    expect(getCustomGroups().length).toBe(2);
  });

  test("renaming to an existing name is rejected and keeps the original", async () => {
    const a = addCustomGroup([], "工具");
    addCustomGroup(a.groups, "工作");
    const { container } = await renderHomeWith();
    await tick();

    // open the first group card ("工具")
    const cards = [...container.querySelectorAll('[data-testid="app-library-custom-group"]')];
    await fireEvent.click(cards[0] as HTMLButtonElement);
    await tick();
    const rename = container.querySelector(
      '[data-testid="app-library-rename"]',
    ) as HTMLButtonElement | null;
    await fireEvent.click(rename!);
    await tick();
    const input = container.querySelector(
      '[data-testid="app-library-rename-input"]',
    ) as HTMLInputElement | null;
    await fireEvent.input(input!, { target: { value: "工作" } });
    const save = container.querySelector(
      '[data-testid="app-library-rename-save"]',
    ) as HTMLButtonElement | null;
    await fireEvent.click(save!);
    await tick();

    expect(getCustomGroups().map((g) => g.name).sort()).toEqual(["工作", "工具"]);
    expect(container.textContent).toContain(zhLabel("appLibrary.nameTaken"));
  });

  test("choosing an icon persists it and shows on the (empty) group card", async () => {
    const { created } = addCustomGroup([], "星标");
    const { container } = await renderHomeWith();
    await tick();

    const card = container.querySelector(
      '[data-testid="app-library-custom-group"]',
    ) as HTMLButtonElement | null;
    await fireEvent.click(card!);
    await tick();
    const toggle = container.querySelector(
      '[data-testid="app-library-icon-toggle"]',
    ) as HTMLButtonElement | null;
    await fireEvent.click(toggle!);
    await tick();
    const choice = container.querySelector(
      'button[aria-label="❤️"]',
    ) as HTMLButtonElement | null;
    expect(choice).toBeTruthy();
    await fireEvent.click(choice!);
    await tick();

    expect(getCustomGroups()[0].icon).toBe("❤️");

    // back to the library home → the empty group card shows the chosen icon
    const back = container.querySelector('button[aria-label="back"]');
    await fireEvent.click(back as HTMLButtonElement);
    await tick();
    expect(container.textContent).toContain("❤️");
  });
});

