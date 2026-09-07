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

