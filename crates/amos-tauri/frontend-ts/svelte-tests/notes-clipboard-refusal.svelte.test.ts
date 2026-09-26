/**
 * notes-clipboard-refusal.svelte.test.ts — Notes 编辑器里两个剪贴板读者不得把「宿主拒答」折成
 * 一个安静的空态（REQ-A1600 ∕ FMEA F-SH-811）。
 *
 * `lib/clipboard.ts` 把两个**读**包装成 `Promise<T | null>`：
 *
 *   - `clipboardRead()`   → `clipboard_read`：`Ok(None)`（**空剪贴板**）与 `Err`（前台门拒答）
 *     在 `invoke` 里都折成 `null` —— 两种意思共用一个值，不能靠 `e === null` 分辨。
 *   - `clipboardHistory()`→ `clipboard_history`：`Ok([])`（**空历史**）≠ `Err`（拒答），
 *     所以它的 `null` 只可能是拒答。
 *
 * 修前 NotesApp 两处都折了：`pasteEditing` 把 `null` 折成「什么都没发生」（静默 no-op，
 * 而 11 行之上的姊妹 ⧉ `copyEditing` 会把失败写进同一个 `clipErr` 槽），tray 效果把
 * `clipboardHistory` 的 `null` 折成 `trayItems` 不动 ⇒ 渲染 `clipboard.empty`
 * 「剪贴板暂无历史 / 离线」—— 用户按了 📋 没反应、打开历史看到「暂无历史」，都无法读出
 * 「宿主没有回应」这个**另一个**事实。
 *
 * 判据（姊妹 ∕ 同命令）：
 *   - 同文件 `copyEditing` 逐字 `clipErr = (await copiedToClipboard(editVal)) ? "" : t("common.copyFailed");`
 *   - 同文件 `clearTray` 的 doc 逐字「an offline `null` must not look like a successful wipe」
 *   - `TopbarMainMenu` 的 paste 行逐字「the report cannot be keyed on `entry === null` —
 *     it goes through `noteFailure`, which reads `bridgeDiag("clipboard_read")`」
 *
 * 为什么没有门禁看见它：`read-fold-scan` 的「可空包装器清单」用正则
 * `export\s+async\s+function\s+(\w+)\s*\(` 构建，而 `clipboardRead` ∕ `clipboardHistory`
 * 声明为**非 async** 的 `export function … : Promise<… | null>`（直接返回 `invoke(...)`），
 * 所以这两个包装器**连清单都进不去**（与 F-SH-792 的「清单只读一个文件」是不同的盲点）。
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import NotesApp from "../src/svelte/NotesApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

/** What `clipboard_read` does: answer an entry, answer "empty" (`Ok(None)`), or refuse. */
type ReadAnswer = "entry" | "empty" | "refuse";
/** What `clipboard_history` does: answer a list, answer `Ok([])`, or refuse. */
type HistoryAnswer = "list" | "empty" | "refuse";

let readAnswer: ReadAnswer = "entry";
let historyAnswer: HistoryAnswer = "list";

const sampleEntry = {
  seq: 7,
  source: "webview",
  owner: "notes",
  timestamp_ms: 7,
  payload: { kind: "text", text: "从剪贴板来的" },
};

/**
 * Install a fake host. A **refusal** is modelled by *throwing* — that is what the real Tauri
 * host does on `Err(…)`, and it is what makes `invoke` return `null` **and** record
 * `bridgeDiag(command).ok === false`. Returning `null` without throwing is the *other* case
 * (`Ok(None)`), which must not be reported as a fault.
 */
function installHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "clipboard_read") {
        if (readAnswer === "entry") return sampleEntry;
        if (readAnswer === "empty") return null; // Ok(None): the clipboard is empty
        throw { code: "amos.clipboard.foreground_required", message: "not foreground" };
      }
      if (cmd === "clipboard_history") {
        if (historyAnswer === "list") return [sampleEntry];
        if (historyAnswer === "empty") return []; // Ok([]): nothing copied yet
        throw { code: "amos.clipboard.foreground_required", message: "not foreground" };
      }
      return null;
    },
    listen: async () => () => {},
  };
}

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const btnTrim = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === s) as
    | HTMLButtonElement
    | undefined;
const editorTextarea = (h: { container: HTMLElement }) =>
  h.container.querySelector('textarea[data-testid="note-edit"]') as HTMLTextAreaElement;
const clipError = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="note-clip-error"]')?.textContent ?? null;
const clickPaste = (h: { container: HTMLElement }) =>
  fireEvent.click(
    h.container.querySelector(`button[aria-label="${zh["note.pasteHint"]}"]`) as HTMLButtonElement,
  );
const openTray = (h: { container: HTMLElement }) =>
  fireEvent.click(
    h.container.querySelector(
      `button[aria-label="${zh["note.clipHistoryHint"]}"]`,
    ) as HTMLButtonElement,
  );

/** Add a note and enter its editor — the toolbar holding 📋 and 🕘 lives there. */
async function enterEditor(h: { container: HTMLElement }): Promise<void> {
  const compose = h.container.querySelector(
    'textarea[data-testid="note-compose"]',
  ) as HTMLTextAreaElement;
  await fireEvent.input(compose, { target: { value: "底稿" } });
  await fireEvent.click(btnTrim(h, zh["note.save"])!);
  await new Promise<void>((r) => setTimeout(r, 0));
  await fireEvent.click(btnTrim(h, zh["note.edit"])!);
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe("REQ-A1600 — Notes 的剪贴板读者不把「宿主拒答」折成安静的空态", () => {
  afterEach(cleanup);
  afterEach(() => setLocale("zh"));
  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("📋 粘贴：宿主拒答 ⇒ 如实说明，且正文一字未改", async () => {
    localStorage.clear();
    readAnswer = "refuse";
    installHost();
    const host = render(NotesApp);
    await enterEditor(host);

    const before = editorTextarea(host).value;
    await clickPaste(host);
    await new Promise<void>((r) => setTimeout(r, 0));

    // 修前这里是 `null` —— 静默 no-op，用户没有任何可读的线索。
    expect(clipError(host)).toContain(zh["note.pasteUnavailable"]);
    expect(editorTextarea(host).value).toBe(before);
  });

  test("📋 粘贴正控：宿主答了一个文本条目 ⇒ 追加进正文，且不报错", async () => {
    localStorage.clear();
    readAnswer = "entry";
    installHost();
    const host = render(NotesApp);
    await enterEditor(host);

    await clickPaste(host);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(editorTextarea(host).value).toContain("从剪贴板来的");
    expect(clipError(host)).toBeNull();
  });

  test("📋 粘贴：空剪贴板（Ok(None)）不是故障 —— 不报错，也不编内容", async () => {
    localStorage.clear();
    readAnswer = "empty"; // null **without** throwing: an empty clipboard, not a refusal
    installHost();
    const host = render(NotesApp);
    await enterEditor(host);

    const before = editorTextarea(host).value;
    await clickPaste(host);
    await new Promise<void>((r) => setTimeout(r, 0));

    // 两种 `null` 必须分流：这一条**不能**报错（否则「空剪贴板」成了一个假故障）。
    expect(clipError(host)).toBeNull();
    expect(editorTextarea(host).value).toBe(before);
  });

  test("🕘 历史：宿主拒答 ⇒ 说「读不到」，而不是「暂无历史」", async () => {
    localStorage.clear();
    historyAnswer = "refuse";
    installHost();
    const host = render(NotesApp);
    await enterEditor(host);

    await openTray(host);
    await new Promise<void>((r) => setTimeout(r, 0));

    // 修前这里画的是 `clipboard.empty` —— 拒答被折成「暂无历史 / 离线」。
    expect(txt(host)).toContain(zh["clipboard.unreadable"]);
    expect(txt(host)).not.toContain(zh["clipboard.empty"]);
  });

  test("🕘 历史正控：宿主答了空历史（Ok([])）⇒ 画「暂无历史」，不画「读不到」", async () => {
    localStorage.clear();
    historyAnswer = "empty";
    installHost();
    const host = render(NotesApp);
    await enterEditor(host);

    await openTray(host);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(txt(host)).toContain(zh["clipboard.empty"]);
    expect(txt(host)).not.toContain(zh["clipboard.unreadable"]);
  });

  test("🕘 历史正控：宿主答了条目 ⇒ 画出条目预览", async () => {
    localStorage.clear();
    historyAnswer = "list";
    installHost();
    const host = render(NotesApp);
    await enterEditor(host);

    await openTray(host);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(txt(host)).toContain("从剪贴板来的");
    expect(txt(host)).not.toContain(zh["clipboard.unreadable"]);
  });
});
