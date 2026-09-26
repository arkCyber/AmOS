/**
 * notes-clipboard-clear-refusal.svelte.test.ts — 备忘录的「清空剪贴板历史」被宿主拒绝时，
 * 不能是一个不说话的 no-op（REQ-A1601 ∕ FMEA F-SH-812）。
 *
 * `lib/clipboard.ts::clipboardClear` 是 `Promise<number | null>`：「清掉几条」是**回答**，
 * `null` 是**拒答**（`clipboard_clear` 在 Rust 侧前台门 [`require_foreground`]），`invoke`
 * 把 `Err` 折成 `null`。修前 `clearTray` 逐字
 *
 *     const removed = await clipboardClear();
 *     if (removed !== null) trayItems = [];
 *
 * —— 判决**只读了一个方向**：拒答时列表不动、也**一句话都没有**，于是「宿主拒绝清空」与
 * 「按了没反应」在屏幕上字节相同。这条规则就写在**同一个函数的文档注释里**（「an offline
 * `null` must not look like a successful wipe」），而同一轮（REQ-A1600）刚刚给它的两个兄弟
 * 加上了这句话：📋 `pasteEditing` ∕ ⧉ `copyEditing` 写 `clipErr`，🕘 历史读写 `trayUnread`。
 * 修法是让第三个动词走**同一个**槽（`clipErr`）。
 *
 * 为什么没有门禁看见它：
 *   - `write-scan` 只匹配 `writeStoreValue(Checked)` 一类写入判决，这是一次 `invoke` 的判决；
 *   - `read-fold-scan` 的「可空包装器清单」用 `export\s+async\s+function` 构建，而
 *     `clipboardClear` 是**非 async** 的 `export function … : Promise<number | null>`，连清单都
 *     进不去（`read-fold-scan` 的既有盲点，与 REQ-A1600 的同一条）；
 *   - 这是一条**被读过**的判决（`removed` 确实被读了），所以「判决有没有被读」这类扫描看不见
 *     它 —— 缺的是**另一个分支**。
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import NotesApp from "../src/svelte/NotesApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

/** What `clipboard_clear` does: remove some, remove nothing (`0`), or refuse (`Err`). */
type ClearAnswer = "count" | "none" | "refuse";

let clearAnswer: ClearAnswer = "count";

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
 * `bridgeDiag(command).ok === false`. Returning a number, even `0`, is an *answer*.
 */
function installHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "clipboard_history") return [sampleEntry];
      if (cmd === "clipboard_clear") {
        if (clearAnswer === "count") return 3;
        if (clearAnswer === "none") return 0; // answered "nothing left to remove"
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
const clipError = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="note-clip-error"]')?.textContent ?? null;
const clickClear = (h: { container: HTMLElement }) =>
  fireEvent.click(
    h.container.querySelector(
      `button[aria-label="${zh["clipboard.clearHistory"]}"]`,
    ) as HTMLButtonElement,
  );
const openTray = (h: { container: HTMLElement }) =>
  fireEvent.click(
    h.container.querySelector(
      `button[aria-label="${zh["note.clipHistoryHint"]}"]`,
    ) as HTMLButtonElement,
  );

/** Add a note and enter its editor — the toolbar holding 🕘 (and its tray) lives there. */
async function enterEditorWithTray(h: { container: HTMLElement }): Promise<void> {
  const compose = h.container.querySelector(
    'textarea[data-testid="note-compose"]',
  ) as HTMLTextAreaElement;
  await fireEvent.input(compose, { target: { value: "底稿" } });
  await fireEvent.click(btnTrim(h, zh["note.save"])!);
  await new Promise<void>((r) => setTimeout(r, 0));
  await fireEvent.click(btnTrim(h, zh["note.edit"])!);
  await new Promise<void>((r) => setTimeout(r, 0));
  await openTray(h);
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe("REQ-A1601 — 清空剪贴板历史被拒答时不得是一个不说话的 no-op", () => {
  afterEach(cleanup);
  afterEach(() => setLocale("zh"));
  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("宿主拒答 ⇒ 如实说明，且列表**不被抹掉**", async () => {
    localStorage.clear();
    clearAnswer = "refuse";
    installHost();
    const host = render(NotesApp);
    await enterEditorWithTray(host);

    await clickClear(host);
    await new Promise<void>((r) => setTimeout(r, 0));

    // 修前这里是 `null` —— 拒答被折成一个安静的成功（列表其实没被清）。
    expect(clipError(host)).toContain(zh["clipboard.clearFailed"]);
    // 一次被拒绝的清空不是一次「清空」：屏幕上的条目必须还在。
    expect(txt(host)).toContain("从剪贴板来的");
  });

  test("正控：宿主确认清掉 N 条 ⇒ 列表清空，且不报错", async () => {
    localStorage.clear();
    clearAnswer = "count";
    installHost();
    const host = render(NotesApp);
    await enterEditorWithTray(host);

    await clickClear(host);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(clipError(host)).toBeNull();
    expect(txt(host)).not.toContain("从剪贴板来的");
  });

  test("正控：宿主答「0 条」是**回答**不是拒答 —— 不报错", async () => {
    localStorage.clear();
    clearAnswer = "none"; // an answered 0, **not** a thrown refusal
    installHost();
    const host = render(NotesApp);
    await enterEditorWithTray(host);

    await clickClear(host);
    await new Promise<void>((r) => setTimeout(r, 0));

    // 判据必须钉在 `=== null`（拒答）上：把它写成 `if (!removed)` 会让这条假故障变红。
    expect(clipError(host)).toBeNull();
  });
});
