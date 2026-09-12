/**
 * DOM tests for the Svelte 5 notes screen (NotesApp.svelte).
 *
 * Pure note logic is unit-tested once against lib/notes.ts (shared by the React
 * + Svelte UIs). Here we verify the Svelte UI wiring: empty state, adding a note
 * (which expands to show its body + persists), and archiving it (moves it out of
 * "备忘录" into the "归档" tab).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import NotesApp from "../src/svelte/NotesApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { notesChannel, AI_TARGET_WINDOW } from "../src/svelte/appLinks";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { resetShellState, surface } from "../src/svelte/shellState.svelte";
import { setLocale } from "../src/svelte/locale.svelte";

afterEach(cleanup);
afterEach(() => setLocale("zh")); // never leak a locale into the next case
afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const btnTrim = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === s) as
    HTMLButtonElement | undefined;

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

describe("NotesApp.svelte", () => {
  test("starts empty (暂无备忘录)", () => {
    const host = render(NotesApp);
    expect(txt(host)).toContain("暂无备忘录");
  });

  test("adding a note expands it, shows its body, and persists", async () => {
    const host = render(NotesApp);
    const ta = host.container.querySelector('textarea[aria-label="note-compose"]') as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "买牛奶\n鸡蛋" } });
    await fireEvent.click(btnTrim(host, "保存")!);

    expect(txt(host)).toContain("买牛奶");
    const stored = readStoreValue<{ text: string }[]>("amos.notes", []);
    expect(stored.some((n) => n.text === "买牛奶\n鸡蛋")).toBe(true);
  });

  test("a rejected store write is visible, applies nothing, and keeps the draft", async () => {
    const restore = failWritesFor("amos.notes");
    try {
      const host = render(NotesApp);
      const ta = host.container.querySelector(
        'textarea[aria-label="note-compose"]',
      ) as HTMLTextAreaElement;
      await fireEvent.input(ta, { target: { value: "会丢的笔记" } });
      await fireEvent.click(btnTrim(host, "保存")!);
      await new Promise<void>((r) => setTimeout(r, 0));

      // The write was rejected, so nothing may be claimed: an honest banner, no row
      // added, and the typed draft still in the box (never cleared into a lost write).
      const err = host.container.querySelector('[data-testid="note-store-error"]');
      expect(err?.textContent ?? "").toContain("本机存储写入失败");
      expect(txt(host)).toContain("暂无备忘录");
      expect(ta.value).toBe("会丢的笔记");
      expect(readStoreValue<{ text: string }[]>("amos.notes", [])).toEqual([]);
    } finally {
      restore();
    }
  });

  test("a successful write clears the store error and applies the note", async () => {
    const restore = failWritesFor("amos.notes");
    const host = render(NotesApp);
    const ta = host.container.querySelector(
      'textarea[aria-label="note-compose"]',
    ) as HTMLTextAreaElement;
    try {
      await fireEvent.input(ta, { target: { value: "第一次失败" } });
      await fireEvent.click(btnTrim(host, "保存")!);
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(host.container.querySelector('[data-testid="note-store-error"]')).toBeTruthy();
    } finally {
      restore();
    }
    // Storage works again → the same draft (still in the box) saves and the banner goes.
    await fireEvent.click(btnTrim(host, "保存")!);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(host.container.querySelector('[data-testid="note-store-error"]')).toBeNull();
    expect(txt(host)).toContain("第一次失败");
    expect(readStoreValue<{ text: string }[]>("amos.notes", []).some((n) => n.text === "第一次失败")).toBe(
      true,
    );
  });

  test("archiving removes it from 备忘录 and it appears in 归档", async () => {
    const host = render(NotesApp);
    const ta = host.container.querySelector('textarea[aria-label="note-compose"]') as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "待办清单" } });
    await fireEvent.click(btnTrim(host, "保存")!);
    expect(txt(host)).toContain("待办清单");

    // footer "归档" (exact text, not the "归档 (n)" chip)
    await fireEvent.click(btnTrim(host, "归档")!);
    expect(txt(host)).not.toContain("待办清单");
    expect(txt(host)).toContain("暂无备忘录");

    // switch to 归档 chip → the note is listed again (collapsed row preview)
    const chip = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").startsWith("归档"),
    );
    expect(chip).toBeTruthy();
    await fireEvent.click(chip as HTMLButtonElement);
    expect(txt(host)).toContain("待办清单");
  });
  test("#标签 surfaces a chip that filters the list; ✕ clears it", async () => {
    const host = render(NotesApp);
    const ta = host.container.querySelector('textarea[aria-label="note-compose"]') as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "汇报\n本周进度 #工作" } });
    await fireEvent.click(btnTrim(host, "保存")!);
    await fireEvent.input(ta, { target: { value: "买菜清单" } });
    await fireEvent.click(btnTrim(host, "保存")!);
    expect(txt(host)).toContain("买菜清单");

    const chip = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").startsWith("#工作"),
    );
    expect(chip).toBeTruthy();
    await fireEvent.click(chip as HTMLButtonElement);
    // Only the tagged note remains.
    expect(txt(host)).toContain("进度");
    expect(txt(host)).not.toContain("买菜清单");

    const clear = [...host.container.querySelectorAll("button")].find((b) =>
      b.querySelector('[data-icon="x"]'),
    );
    expect(clear).toBeTruthy();
    await fireEvent.click(clear as HTMLButtonElement);
    expect(txt(host)).toContain("买菜清单");
  });

  test("multi-select batch archives two notes at once", async () => {
    const host = render(NotesApp);
    const ta = host.container.querySelector('textarea[aria-label="note-compose"]') as HTMLTextAreaElement;
    const add = async (v: string) => {
      await fireEvent.input(ta, { target: { value: v } });
      await fireEvent.click(btnTrim(host, "保存")!);
    };
    await add("甲事项");
    await add("乙事项");
    await add("丙清单");
    expect(txt(host)).toContain("丙清单");

    await fireEvent.click(btnTrim(host, "选择")!);
    const row = (title: string) =>
      [...host.container.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-pressed") !== null && (b.textContent ?? "").includes(title),
      ) as HTMLButtonElement;
    await fireEvent.click(row("甲事项"));
    await fireEvent.click(row("乙事项"));
    expect(txt(host)).toContain("已选 2");
    await fireEvent.click(btnTrim(host, "归档")!);

    expect(txt(host)).not.toContain("甲事项");
    expect(txt(host)).not.toContain("乙事项");
    expect(txt(host)).toContain("丙清单");
    const stored = readStoreValue<{ state?: string }[]>("amos.notes", []);
    expect(stored.filter((n) => n.state === "archived").length).toBe(2);
  });
  test("exporting a note without a backend copies it and shows a fallback message", async () => {
    const host = render(NotesApp);
    const ta = host.container.querySelector('textarea[aria-label="note-compose"]') as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "导出正文" } });
    await fireEvent.click(btnTrim(host, "保存")!);
    const exportBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("导出"),
    ) as HTMLButtonElement;
    expect(exportBtn).toBeTruthy();
    await fireEvent.click(exportBtn);
    await new Promise((r) => setTimeout(r, 20));
    expect(txt(host)).toContain("已复制到剪贴板（未连接后端）");
  });
});

describe("NotesApp.svelte — editor affordances", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const addNote = async (host: { container: HTMLElement }, v: string) => {
    const ta = host.container.querySelector(
      'textarea[aria-label="note-compose"]',
    ) as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: v } });
    await fireEvent.click(btnTrim(host, "保存")!);
    await tick();
  };
  const enterEdit = async (host: { container: HTMLElement }) => {
    const editBtn = [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").includes("编辑"),
    ) as HTMLButtonElement;
    expect(editBtn).toBeTruthy();
    await fireEvent.click(editBtn);
    await tick();
  };
  const noteEditTa = (host: { container: HTMLElement }) =>
    host.container.querySelector('textarea[aria-label="note-edit"]') as HTMLTextAreaElement;

  test("live rich-text preview shows while editing and renders markers", async () => {
    const host = render(NotesApp);
    await addNote(host, "**加粗** 与 #工作");
    await enterEdit(host);
    expect(noteEditTa(host)).toBeTruthy();

    await fireEvent.click(host.container.querySelector('[aria-label="note-edit-preview"]')!);
    await tick();

    const prev = host.container.querySelector('[aria-label="note-preview"]');
    expect(prev).toBeTruthy();
    expect(prev?.querySelector("strong")).toBeTruthy(); // **加粗** rendered bold
    expect(txt(host)).toContain("#工作");
  });

  test("☑ 勾选 toggles the task on the caret's line (line 0 by default)", async () => {
    const host = render(NotesApp);
    await addNote(host, "- [ ] 买牛奶");
    await enterEdit(host);
    const ta = noteEditTa(host);
    expect(ta.value).toBe("- [ ] 买牛奶");

    await fireEvent.click(host.container.querySelector('[aria-label="note-edit-toggle-task"]')!);
    await tick();
    expect(noteEditTa(host).value).toBe("- [x] 买牛奶");
  });

  test("＋ 任务 turns the caret's plain line into a checklist item", async () => {
    const host = render(NotesApp);
    await addNote(host, "写周报");
    await enterEdit(host);
    await fireEvent.click(host.container.querySelector('[aria-label="note-edit-prefix-task"]')!);
    await tick();
    expect(noteEditTa(host).value).toBe("- [ ] 写周报");
  });
});

describe("NotesApp.svelte — created/modified indicator", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  test("an edited note (created < modified) shows the 已编辑 marker when opened", async () => {
    // Seed localStorage with one edited note (created=1000, modified=2000).
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([{ id: "edited1", text: "被修改过的正文", ts: 2000, created: 1000 }]),
    );
    const host = render(NotesApp);
    await tick();

    // The note is a collapsed row; open it to reveal the detail footer.
    const row = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("被修改过的正文"),
    ) as HTMLButtonElement;
    expect(row).toBeTruthy();
    await fireEvent.click(row);
    await tick();

    expect(txt(host)).toContain("已编辑");
  });

  test("a freshly-created note shows no 已编辑 marker", async () => {
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([{ id: "fresh", text: "新笔记", ts: 1000, created: 1000 }]),
    );
    const host = render(NotesApp);
    const row = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("新笔记"),
    ) as HTMLButtonElement;
    await fireEvent.click(row);
    await tick();
    expect(txt(host)).not.toContain("已编辑");
  });
});




describe("NotesApp.svelte — full-page editor wiring", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  test("opening 整页 swaps to NoteEditor; ‹ back flushes the autosave and returns", async () => {
    const host = render(NotesApp);
    const compose = host.container.querySelector(
      'textarea[aria-label="note-compose"]',
    ) as HTMLTextAreaElement;
    await fireEvent.input(compose, { target: { value: "第一版标题" } });
    await fireEvent.click(btnTrim(host, "保存")!);
    await tick();
    expect(txt(host)).toContain("第一版标题");

    // Open the full-page editor from the note's detail footer.
    const full = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("整页"),
    ) as HTMLButtonElement;
    expect(full).toBeTruthy();
    await fireEvent.click(full);
    await tick();

    const ed = host.container.querySelector(
      'textarea[aria-label="note-editor-textarea"]',
    ) as HTMLTextAreaElement;
    expect(ed).toBeTruthy();
    await fireEvent.input(ed, { target: { value: "第二版标题与正文" } });
    await tick();

    // ‹ back flushes the pending autosave and returns to the list.
    await fireEvent.click(host.container.querySelector('[aria-label="note-editor-back"]')!);
    await tick();

    expect(host.container.querySelector('[aria-label="note-editor-textarea"]')).toBeNull();
    expect(txt(host)).toContain("第二版标题与正文"); // list row reflects the save
    const stored = readStoreValue<{ id: string; text: string; ts: number }[]>(
      "amos.notes",
      [],
    );
    expect(stored.some((n) => n.text === "第二版标题与正文")).toBe(true);
  });
});

describe("NotesApp.svelte — Markdown-aware titles", () => {
  test("a note starting with '# title' shows the heading (no '#') as its row title", async () => {
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([{ id: "md1", text: "# 阶段计划\n\n写正文与检查清单", ts: 1, created: 1 }]),
    );
    const host = render(NotesApp);
    await new Promise<void>((r) => setTimeout(r, 0));

    // Collapsed row title area: heading without the leading '#'.
    expect(txt(host)).toContain("阶段计划");
    expect(txt(host)).not.toContain("# 阶段计划");
  });
});


describe("NotesApp.svelte — Markdown import / export", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  test("⇪ md imports the compose content as a front-matter-stripped note", async () => {
    const host = render(NotesApp);
    const compose = host.container.querySelector(
      'textarea[aria-label="note-compose"]',
    ) as HTMLTextAreaElement;
    await fireEvent.input(compose, {
      target: { value: "---\ntitle: 周报\n---\n# 周报标题\n\n正文内容" },
    });
    await fireEvent.click(host.container.querySelector('[aria-label="note-import-md"]')!);
    await tick();

    const stored = readStoreValue<{ id: string; text: string }[]>("amos.notes", []);
    expect(stored.some((n) => n.text === "# 周报标题\n\n正文内容")).toBe(true);
    expect(compose.value).toBe(""); // compose cleared after import
    expect(txt(host)).toContain("已导入");
  });

  test("⇩ .md export affordance is present and reports the clipboard fallback", async () => {
    const host = render(NotesApp);
    const compose = host.container.querySelector(
      'textarea[aria-label="note-compose"]',
    ) as HTMLTextAreaElement;
    await fireEvent.input(compose, { target: { value: "导出正文" } });
    await fireEvent.click(btnTrim(host, "保存")!); // adds + opens the note
    await tick();

    const mdBtn = host.container.querySelector('[aria-label="note-export-md"]');
    expect(mdBtn).toBeTruthy();
    await fireEvent.click(mdBtn as HTMLButtonElement);
    await tick();
    expect(txt(host)).toContain("已复制 .md");
  });
});

describe("NotesApp.svelte — open-in-editor preference", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const seedNote = () =>
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([{ id: "row1", text: "点按我", ts: 1, created: 1 }]),
    );
  const tapRow = async (host: { container: HTMLElement }) => {
    const row = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("点按我"),
    ) as HTMLButtonElement;
    expect(row).toBeTruthy();
    await fireEvent.click(row);
    await tick();
  };

  test("default: tapping a row expands inline, not the full-page editor", async () => {
    seedNote();
    window.localStorage.removeItem("amos.notesPrefs");
    const host = render(NotesApp);
    await tapRow(host);
    expect(host.container.querySelector('textarea[aria-label="note-editor-textarea"]')).toBeNull();
    expect(txt(host)).toContain("点按我"); // expanded inline detail
  });

  test("pref on: tapping a row opens the full-page editor", async () => {
    seedNote();
    window.localStorage.setItem("amos.notesPrefs", JSON.stringify({ openInEditor: true }));
    const host = render(NotesApp);
    await tapRow(host);
    expect(host.container.querySelector('textarea[aria-label="note-editor-textarea"]')).toBeTruthy();
  });

  test("the toggle persists openInEditor to amos.notesPrefs", async () => {
    window.localStorage.removeItem("amos.notes");
    window.localStorage.removeItem("amos.notesPrefs");
    const host = render(NotesApp);
    const cb = host.container.querySelector(
      'input[aria-label="note-pref-open-in-editor"]',
    ) as HTMLInputElement;
    expect(cb).toBeTruthy();
    await fireEvent.click(cb); // bind:checked flips to true
    await tick();
    const saved = JSON.parse(window.localStorage.getItem("amos.notesPrefs") ?? "{}");
    expect(saved.openInEditor).toBe(true);
  });
});



describe("NotesApp.svelte — 已编辑 badge on collapsed rows", () => {
  test("an edited note shows the badge without opening it", async () => {
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([{ id: "e1", text: "改过的备忘录", ts: 2000, created: 1000 }]),
    );
    const host = render(NotesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(txt(host)).toContain("已编辑");
  });

  test("a freshly-created note shows no badge on its collapsed row", async () => {
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([{ id: "f1", text: "新备忘录", ts: 3000, created: 3000 }]),
    );
    const host = render(NotesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(txt(host)).not.toContain("已编辑");
  });
});

describe("NotesApp.svelte — 按修改时间排序偏好", () => {
  function rowTexts(host: { container: HTMLElement }): string[] {
    const box = host.container.querySelector(".mt-3.space-y-2");
    if (!box) return [];
    return [...box.querySelectorAll("button")].map((b) => b.textContent ?? "");
  }
  function seed(notes: unknown[], sortByModified: boolean) {
    window.localStorage.setItem("amos.notes", JSON.stringify(notes));
    window.localStorage.setItem("amos.notesPrefs", JSON.stringify({ sortByModified }));
  }
  // stored order = [older(ts 100), newer(ts 900)]; with the pref on the newer
  // note (ts 900) must surface first even though it was inserted second.
  const notes = [
    { id: "old", text: "更早创建的备注", ts: 100, created: 100 },
    { id: "new", text: "最近修改的备注", ts: 900, created: 100 },
  ];

  test("toggle exists and persists sortByModified", async () => {
    window.localStorage.removeItem("amos.notes");
    window.localStorage.removeItem("amos.notesPrefs");
    const host = render(NotesApp);
    const cb = host.container.querySelector(
      'input[aria-label="note-pref-sort-by-modified"]',
    ) as HTMLInputElement;
    expect(cb).toBeTruthy();
    expect(cb.checked).toBe(false);
    await fireEvent.click(cb);
    const saved = JSON.parse(window.localStorage.getItem("amos.notesPrefs") ?? "{}");
    expect(saved.sortByModified).toBe(true);
  });

  test("sortByModified on reorders rows by last-modified (newest first)", async () => {
    seed(notes, true);
    const host = render(NotesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    const texts = rowTexts(host);
    expect(texts.length).toBeGreaterThanOrEqual(2);
    expect(texts[0]).toContain("最近修改的备注");
    expect(texts[1]).toContain("更早创建的备注");
  });

  test("off keeps stored/insertion order", async () => {
    seed(notes, false);
    const host = render(NotesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    const texts = rowTexts(host);
    expect(texts[0]).toContain("更早创建的备注");
    expect(texts[1]).toContain("最近修改的备注");
  });
});


describe("NotesApp.svelte — 折叠预览去内联标记", () => {
  test("collapsed row preview hides marker syntax but shows the text", async () => {
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([
        {
          id: "m1",
          text: "标题\n**粗体** 与 ==高亮== 和 ~~删除~~ 还有 [链接](https://example.com)",
          ts: 10,
          created: 10,
        },
      ]),
    );
    const host = render(NotesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    const body = txt(host);
    expect(body).toContain("粗体 与 高亮 和 删除 还有 链接");
    expect(body).not.toContain("**");
    expect(body).not.toContain("==");
    expect(body).not.toContain("~~");
  });
});


describe("NotesApp.svelte — 复制便签", () => {
  test("expanded note duplicate adds a copy at the top and persists two notes", async () => {
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([{ id: "d1", text: "被复制的内容", ts: 10, created: 10 }]),
    );
    const host = render(NotesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    const row = host.container.querySelector(".mt-3.space-y-2 button") as HTMLButtonElement;
    await fireEvent.click(row); // expand the note to reveal its action toolbar
    const btn = host.container.querySelector(
      'button[aria-label="note-duplicate"]',
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    await fireEvent.click(btn);
    const saved = JSON.parse(window.localStorage.getItem("amos.notes") ?? "[]");
    expect(saved.length).toBe(2);
    expect(saved[0].text).toBe("被复制的内容");
    expect(saved[0].id).not.toBe("d1");
  });
});


describe("NotesApp.svelte — 折叠行标题也去内联标记", () => {
  test("collapsed title hides marker syntax from a marker-rich first line", async () => {
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([{ id: "t1", text: "**加粗标题**\n正文内容", ts: 10, created: 10 }]),
    );
    const host = render(NotesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    const body = txt(host);
    expect(body).toContain("加粗标题");
    expect(body).not.toContain("**");
  });
});


describe("NotesApp.svelte — 搜索高亮", () => {
  test("typing a search highlights the matching title via <mark>", async () => {
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([{ id: "s1", text: "买牛奶计划\n今晚去买", ts: 10, created: 10 }]),
    );
    const host = render(NotesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    const input = host.container.querySelector(
      'input[aria-label="note-search"]',
    ) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "牛奶" } });
    await new Promise<void>((r) => setTimeout(r, 0));
    const mark = host.container.querySelector("mark");
    expect(mark).toBeTruthy();
    expect(mark?.textContent).toBe("牛奶");
  });
});



describe("NotesApp.svelte — 清空最近删除（两步确认）", () => {
  test("arming then confirming empties the trash; cancel keeps notes", async () => {
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([
        { id: "t1", text: "待清空的条目", ts: 5, created: 5, state: "trash" },
        { id: "keep", text: "正常便签", ts: 6, created: 6 },
      ]),
    );
    const host = render(NotesApp);
    await new Promise<void>((r) => setTimeout(r, 0));

    // switch to the trash tab
    const chip = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("最近删除"),
    );
    await fireEvent.click(chip as HTMLButtonElement);
    await new Promise<void>((r) => setTimeout(r, 0));

    // arm
    const arm = host.container.querySelector(
      'button[aria-label="note-empty-trash"]',
    ) as HTMLButtonElement;
    expect(arm).toBeTruthy();
    await fireEvent.click(arm);
    // nothing deleted yet (only armed)
    expect(JSON.parse(window.localStorage.getItem("amos.notes") ?? "[]").length).toBe(2);

    // cancel path keeps everything
    const cancel = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("取消"),
    );
    await fireEvent.click(cancel as HTMLButtonElement);
    expect(JSON.parse(window.localStorage.getItem("amos.notes") ?? "[]").length).toBe(2);

    // arm again and confirm
    const arm2 = host.container.querySelector(
      'button[aria-label="note-empty-trash"]',
    ) as HTMLButtonElement;
    await fireEvent.click(arm2);
    const confirmBtn = host.container.querySelector(
      'button[aria-label="note-empty-trash-confirm"]',
    ) as HTMLButtonElement;
    await fireEvent.click(confirmBtn);
    const saved = JSON.parse(window.localStorage.getItem("amos.notes") ?? "[]");
    expect(saved.length).toBe(1);
    expect(saved[0].id).toBe("keep");
  });
});

describe("NotesApp.svelte — 搜索命中在正文预览里也高亮", () => {
  test("a term found only in the body highlights inside the collapsed preview", async () => {
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([{ id: "p1", text: "周末安排\n去超市买牛奶并转账水费", ts: 10, created: 10 }]),
    );
    const host = render(NotesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    const input = host.container.querySelector(
      'input[aria-label="note-search"]',
    ) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "转账" } });
    await new Promise<void>((r) => setTimeout(r, 0));
    const marks = host.container.querySelectorAll("mark");
    expect(marks.length).toBeGreaterThanOrEqual(1);
    expect([...marks].some((m) => m.textContent === "转账")).toBe(true);
  });

  test("shows the AI-offline hint and Notes still work when no bridge/AI", async () => {
    // No __TAURI_INTERNALS__ => not bridged => AI offline, but Notes is local.
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const host = render(NotesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(host.container.querySelector('[data-testid="note-ai-offline"]')).toBeTruthy();

    // Creating a memo still works while AI is offline (never blocked).
    const ta = host.container.querySelector(
      'textarea[aria-label="note-compose"]',
    ) as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "离线也能记" } });
    await fireEvent.click(btnTrim(host, "保存")!);
    expect(txt(host)).toContain("离线也能记");
  });

  test("hides the AI-offline hint when a real AI engine is bridged", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async () => ({ engine: "api", engine_model: "deepseek-chat", degraded: false }),
      listen: async () => () => {},
    };
    const host = render(NotesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(host.container.querySelector('[data-testid="note-ai-offline"]')).toBeNull();
  });

  test("clipboard tray previews entries and can clear the history", async () => {
    const calls: string[] = [];
    const entries = [
      { seq: 2, source: "webview", owner: "notes", timestamp_ms: 2, payload: { kind: "image", mime: "image/png", data_b64: "AA==" } },
      { seq: 1, source: "webview", owner: "notes", timestamp_ms: 1, payload: { kind: "text", text: "  hello   world  " } },
    ];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        if (cmd === "clipboard_history") return entries;
        if (cmd === "clipboard_clear") return 2;
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(NotesApp);
    // The clipboard tray lives in the note editor toolbar → add a note first
    // (saving opens it in the editor).
    const compose = host.container.querySelector(
      'textarea[aria-label="note-compose"]',
    ) as HTMLTextAreaElement;
    await fireEvent.input(compose, { target: { value: "剪辑测试" } });
    await fireEvent.click(btnTrim(host, "保存")!);
    await new Promise<void>((r) => setTimeout(r, 0));
    // The tray lives in the note *editor* toolbar → enter the editor.
    await fireEvent.click(btnTrim(host, "编辑")!);
    await new Promise<void>((r) => setTimeout(r, 0));

    await fireEvent.click(host.container.querySelector('button[aria-label="Clipboard history"]') as HTMLButtonElement);
    await new Promise<void>((r) => setTimeout(r, 0));
    // A binary entry used to render as "—"; it now shows its honest preview, and
    // whitespace in a text entry is collapsed for the one-line picker.
    expect(txt(host)).toContain("[image · image/png]");
    expect(txt(host)).toContain("hello world");

    await fireEvent.click(
      host.container.querySelector('button[aria-label="清空剪贴板历史"]') as HTMLButtonElement,
    );
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(calls).toContain("clipboard_clear");
    // The list is emptied only because the bridge confirmed a count.
    expect(txt(host)).toContain("剪贴板暂无历史");
  });

  test("ask-my-notes shows the daemon-confirmed index status (embedder named honestly)", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "rag_status") return { indexed: 7, dimension: 384, embedder: "ollama" };
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(NotesApp);
    await fireEvent.click(
      host.container.querySelector('button[aria-label="note-ask-toggle"]') as HTMLButtonElement,
    );
    await new Promise<void>((r) => setTimeout(r, 0));
    const status = host.container.querySelector('[data-testid="note-rag-status"]');
    expect(status).toBeTruthy();
    // The daemon's real numbers + the embedder label (`mock` vs `ollama`), never
    // a fabricated index size.
    expect(status?.textContent ?? "").toContain("7");
    expect(status?.textContent ?? "").toContain("384");
    expect(status?.textContent ?? "").toContain("ollama");
  });

  test("ask-my-notes toggles a panel and reports offline without a daemon", async () => {
    const host = render(NotesApp);
    const toggle = host.container.querySelector(
      'button[aria-label="note-ask-toggle"]',
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    // Panel is closed until toggled.
    expect(host.container.querySelector('[data-testid="note-ask"]')).toBeNull();
    await fireEvent.click(toggle);
    expect(host.container.querySelector('[data-testid="note-ask"]')).toBeTruthy();
    // No Tauri bridge → the daemon is unreachable: an honest notice, and the Ask
    // button is disabled (never a silent no-op).
    expect(txt(host)).toContain("笔记检索需要守护进程");
    const run = host.container.querySelector(
      'button[aria-label="note-ask-run"]',
    ) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    // Toggling off closes the panel again.
    await fireEvent.click(toggle);
    expect(host.container.querySelector('[data-testid="note-ask"]')).toBeNull();
  });
});

describe("NotesApp.svelte — Spotlight deep link (appLinks.openNote)", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  afterEach(resetPropsChannels);

  test("opens the linked note in the full-page editor", async () => {
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([
        { id: "n1", text: "买菜清单", ts: 1000 },
        { id: "n2", text: "会议记录", ts: 2000 },
      ]),
    );
    // The chooser sets the channel *before* opening the app, so the payload is there
    // at mount (same contract as the phone → Messages "回短信" link).
    notesChannel().set({ noteId: "n2", nonce: 7 });
    const host = render(NotesApp);
    await tick();
    const ta = host.container.querySelector(
      'textarea[aria-label="note-editor-textarea"]',
    ) as HTMLTextAreaElement | null;
    expect(ta).toBeTruthy();
    expect(ta?.value).toBe("会议记录");
  });

  test("a link to a note that is gone leaves the list (never a phantom note)", async () => {
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([{ id: "n1", text: "买菜清单", ts: 1000 }]),
    );
    notesChannel().set({ noteId: "gone", nonce: 8 });
    const host = render(NotesApp);
    await tick();
    expect(host.container.querySelector('textarea[aria-label="note-editor-textarea"]')).toBeNull();
    expect(txt(host)).toContain("买菜清单");
  });
});

describe("NotesApp.svelte — send to AI (wm SystemContext)", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  afterEach(() => {
    resetPropsChannels();
    resetShellState();
  });

  /** Fake bridge recording every command; answers null (nothing to read back). */
  function bridge() {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        calls.push({ cmd, args });
        return null;
      },
      listen: async () => () => {},
    };
    return calls;
  }

  /** Add a note, expand its row and enter edit mode so the toolbar shows. */
  async function editNote(host: { container: HTMLElement }, text: string) {
    const ta = host.container.querySelector(
      'textarea[aria-label="note-compose"]',
    ) as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: text } });
    await fireEvent.click(btnTrim(host, "保存")!);
    // The fresh note may already be expanded; a collapsed row is opened by tapping
    // it. Either way the "编辑" action (in the expanded view) enters the editor.
    const row = [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").includes(text) && (b.textContent ?? "").includes("打开"),
    ) as HTMLButtonElement | undefined;
    if (row) await fireEvent.click(row);
    await tick();
    await fireEvent.click(btnTrim(host, "编辑")!);
    await tick();
  }

  test("✦ 发送到 AI attaches the note as system context and opens the AI app", async () => {
    const calls = bridge();
    const host = render(NotesApp);
    await editNote(host, "预算审查 #work");

    const send = host.container.querySelector(
      'button[aria-label="note-send-ai"]',
    ) as HTMLButtonElement | null;
    expect(send).toBeTruthy();
    await fireEvent.click(send as HTMLButtonElement);
    await tick();

    // The text is attached to the AI window, addressed from notes — the daemon's
    // `chat_agent` merges it into the next request as `system_selection`.
    expect(calls).toContainEqual({
      cmd: "system_set_context",
      args: { targetWindow: AI_TARGET_WINDOW, sourceWindow: "notes", text: "预算审查 #work" },
    });
    // …and the AI app is opened so the user lands where the context is used.
    expect(surface()).toEqual({ kind: "app", id: "ai" });
  });

  test("the list toolbar's copy follows the locale (no hard-coded Chinese)", async () => {
    setLocale("en");
    const host = render(NotesApp);
    // Create a note (the row is expanded afterwards) so the footer + inline toolbar
    // render — those are the affordances whose copy used to be hard-coded in zh.
    const compose = host.container.querySelector(
      'textarea[aria-label="note-compose"]',
    ) as HTMLTextAreaElement;
    await fireEvent.input(compose, { target: { value: "Groceries" } });
    await fireEvent.click(btnTrim(host, "Save")!);
    await tick();

    const importBtn = host.container.querySelector('[aria-label="note-import-md"]')!;
    expect(importBtn.getAttribute("title")).toBe("Import the input as Markdown"); // was "把输入内容当作 Markdown 导入"
    expect(btnTrim(host, "Full page")).toBeTruthy(); // was "整页"

    // Enter the inline editor: its task/preview + clipboard toolbar was the block of
    // hard-coded Chinese titles this round localised.
    await fireEvent.click(btnTrim(host, "Edit")!);
    await tick();
    expect(host.container.querySelector('[aria-label="note-edit-preview"]')!.getAttribute("title")).toBe(
      "Rich-text preview", // was "富文本预览"
    );
    expect(host.container.querySelector('[aria-label="Clipboard history"]')!.getAttribute("title")).toBe(
      "Clipboard history", // was "剪贴板历史"
    );
    expect(txt(host)).not.toContain("整页");
  });
});

