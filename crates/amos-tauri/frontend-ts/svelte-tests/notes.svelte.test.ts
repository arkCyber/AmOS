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

afterEach(cleanup);

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const btnTrim = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === s) as
    HTMLButtonElement | undefined;

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

