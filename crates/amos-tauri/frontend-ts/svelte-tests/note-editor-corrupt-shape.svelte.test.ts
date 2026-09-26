/**
 * note-editor-corrupt-shape.svelte.test.ts — `amos.notes` 的读取侧：笔记列表
 * （`NotesApp`）与 Spotlight、AiApp 都过了这个键自己的守卫，**整页编辑器**
 * （`NoteEditor`）没过。REQ-A1422 ∕ FMEA F-SH-680。
 *
 * 核实如下（对工作树，逐字）：
 *
 *   • 这个键有一条自己的守卫：`src/lib/notes.ts:156`
 *     `export function normalizeNotes(list: unknown): Note[] { if (!Array.isArray(list)) return []; … }`
 *   • 四个兄弟读取处都走它：`NotesApp.svelte:102`（种子）、`:208`（重新读取）、
 *     `SpotlightPanel.svelte:85 ∕ :161`、`AiApp.svelte:294`。
 *   • `NoteEditor.svelte:61` 的**唯一**一处读取逐字不归一化：
 *     `const cur = readStoreValue<Note[]>(NOTES_KEY, []);`
 *     紧接着 `:64` `if (!cur.some((n) => n.id === initial.id)) { … }` —— 非数组即
 *     `cur.some is not a function`，抛在 `commit()` 里。而 `commit` 只由两处调用：
 *     `:83` 的 600 ms 去抖器（`createDebouncer` 的 `timers.set` 回调，抛在**定时器
 *     回调里** ⇒ 无人接住）与 `:86` `onDestroy(() => deb.flush())`。两条路都**不会**
 *     把失败写进 `saveErr`，于是**本次改动静默丢失**，指示器还停在 `saving`。
 *     注意这一处不是「渲染即抛」：`note` 是 props 传进来的快照，文本仍然画得出来，
 *     所以症状是**存不下去**而不是打不开。
 *   • `readJson` 只隔离**解析不了的**字节：合法 JSON 的 `{}` ∕ `5` ∕ `null` ∕ `"x"`
 *     原样返回，`fallback` 仅在字符串缺席时生效（`lib/amosStore.ts:52`）。这个键是
 *     **云端备份集合**里的一个（`lib/cloud.ts` `SYNC_STORES` 含 `NOTES_KEY`），而
 *     `restoreBackup`（`cloud.ts:278-281`）逐字 `if (write(k, env.stores[k])) restored.push(k);`
 *     —— 把备份里的值**原样**写进存储，**没有任何形状校验**。于是「从备份恢复」这条
 *     正常用户路径就能把一个非数组合法地放进 `amos.notes`：编辑器打开着一个（当时还
 *     完好的）笔记，另一个窗口恢复备份，下一次自动保存就静默丢失。
 *
 * 修法：这一处读取归一化（`normalizeNotes`），与四个兄弟同形。归一化后 `cur` 是
 * `[]`，`:64` 的 `some` 为假 ⇒ 走**已经存在**的诚实分支 `note.editorDeleted`
 * （「笔记已被删除，改动未保存」），而不是抛一个没人接的错误。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NoteEditor from "../src/svelte/NoteEditor.svelte";
import { NOTES_KEY, type Note } from "../src/lib/notes";
import { readStoreValue } from "../src/lib/amosStore";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

/** Valid JSON that is **not** an array — the shape `readJson` hands back verbatim. */
const CORRUPT = "{}";

/** Seed the raw *bytes*: `writeStoreValue` would JSON.stringify the string itself. */
const corrupt = () => window.localStorage.setItem(NOTES_KEY, CORRUPT);

/** Flush Svelte without a macrotask — `setTimeout` is faked in every leaf here. */
async function settle() {
  await tick();
  await Promise.resolve();
  await tick();
}

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const ta = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="note-editor-textarea"]') as HTMLTextAreaElement;

/** Type one edit and let the 600 ms autosave debounce fire. */
async function typeAndWait(host: { container: HTMLElement }, text: string) {
  await fireEvent.input(ta(host), { target: { value: text } });
  await vi.advanceTimersByTimeAsync(700);
  await settle();
}

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
  setLocale("zh");
});

describe("amos.notes 的读取侧必须归一化（REQ-A1422 ∕ F-SH-680）", () => {
  test("盘上是一个合法的非数组时自动保存不抛错，而是如实说「笔记已被删除，改动未保存」", async () => {
    const note: Note = { id: "n1", text: "旧标题", ts: 1000, created: 1000 };
    window.localStorage.setItem(NOTES_KEY, JSON.stringify([note]));
    vi.useFakeTimers();
    const host = render(NoteEditor, { props: { note, onClose: () => {} } });
    await settle();

    // 打开之后、下一次自动保存之前，盘上被写坏（另一个窗口恢复备份）。
    corrupt();
    // 修前：`cur.some` 对 `{}` 抛 TypeError，抛在去抖器的定时器回调里 ⇒ 静默，
    // `saveErr` 不写、指示器停在 saving、本次改动丢失。
    await typeAndWait(host, "改动了");

    expect(txt(host)).toContain(zh["note.editorDeleted"]);
    // 归一化 ≠ 把坏值当相册写回：盘上仍然是我们没有覆写的那个非数组。
    expect(window.localStorage.getItem(NOTES_KEY)).toBe(CORRUPT);
  });

  test("⇐ back 那条路同样是去抖 flush —— 坏盘时也走诚实分支，不把按键吞掉", async () => {
    const note: Note = { id: "n1", text: "旧标题", ts: 1000, created: 1000 };
    window.localStorage.setItem(NOTES_KEY, JSON.stringify([note]));
    vi.useFakeTimers();
    const closed: string[] = [];
    const host = render(NoteEditor, { props: { note, onClose: () => closed.push("closed") } });
    await settle();

    corrupt();
    await fireEvent.input(ta(host), { target: { value: "改动了" } });
    // 修前：`back()` 里 `deb.flush()` 同步炸开 ⇒ `onClose()` 永远不执行，编辑器关不上。
    await fireEvent.click(host.container.querySelector('[data-testid="note-editor-back"]')!);
    await settle();

    expect(closed).toEqual(["closed"]);
  });

  test("对照（守卫）：归一化不等于不保存 —— 完好的一本笔记仍然存得下去", async () => {
    const note: Note = { id: "n1", text: "旧标题", ts: 1000, created: 1000 };
    window.localStorage.setItem(NOTES_KEY, JSON.stringify([note]));
    vi.useFakeTimers();
    const host = render(NoteEditor, { props: { note, onClose: () => {} } });
    await settle();

    await typeAndWait(host, "新标题");

    const stored = readStoreValue<{ id: string; text: string }[]>(NOTES_KEY, []);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toBe("新标题");
    expect(txt(host)).not.toContain(zh["note.editorDeleted"]);
  });
});
