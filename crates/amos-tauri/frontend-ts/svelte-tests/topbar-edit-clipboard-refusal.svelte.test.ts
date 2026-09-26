/**
 * topbar-edit-clipboard-refusal.svelte.test.ts — 菜单栏 编辑 ▸ 拷贝 / 粘贴 必须读宿主的回答。
 *
 * `TopbarMainMenu.svelte` 的**同一个文件**里，三条 `wm_*` 行与 `file.screenshot` 行都读宿主的判决
 * （`noteFailure` 写 `🛟 [Topbar menu] …` 面包屑），文件自己的注释逐字记着为什么：
 * 「the bar's three wm_* rows used to be `invoke("wm_*", ...).catch(() => undefined)` — `catch` is
 * dead code because `invoke` swallows rejections into `null` (REQ-A296)」。
 *
 * 但那次只扫到了 File/Window 的 `wm_*` 行：**编辑 ▸ 拷贝 / 粘贴 这两行原封不动**，
 * `clipboardWrite(...).catch(() => undefined)` 与 `clipboardRead().then(...).catch(() => undefined)`
 * 里的 `catch` 同样**永远不运行** —— `lib/backend.ts::invoke` 从不 reject（`null` 是它的失败值），
 * 于是宿主的拒绝（选区超过 `MAX_TEXT_LEN`、窗口不在前台、没有桥）**没有读者**：用户点了拷贝/粘贴，
 * 屏上什么都没有，诊断环里也只有 backend 那条泛泛的 `clipboard_write failed`，说不出**哪个动作**被拒。
 *
 * 粘贴这一行还多一层：`clipboard_read` 的 `Ok(None)`（剪贴板是空的）与 `Err(…)`（被拒）**都**经由
 * `invoke` 折叠成 `null`（本仓的「一个 null 两个事实」）。所以修法不能只看 `entry === null`，
 * 而要走 `noteFailure` —— 它读 `bridgeDiag(command)`，**空剪贴板不是故障**，于是只有真的被拒才留痕。
 *
 * 负控需要的正是这一点：`null-but-ok` 那一例在没有读 `bridgeDiag` 的修法下会多余地报警。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import TopbarMainMenu from "../src/svelte/modules/TopbarMainMenu.svelte";

let warn: ReturnType<typeof vi.spyOn>;

/** The host, per command. A handler that throws models the Rust `Err` path (Tauri 2 rejects). */
function installHost(handlers: Record<string, () => Promise<unknown>>): { sent: string[] } {
  const sent: string[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      sent.push(cmd);
      const h = handlers[cmd];
      return h ? await h() : null;
    },
    listen: async () => () => {},
  };
  return { sent };
}

/** Did the bar write its own refusal breadcrumb for `command`? */
const barSaid = (command: string): boolean =>
  warn.mock.calls.some((c) => {
    const first = String(c[0] ?? "");
    return first.includes("Topbar menu") && first.includes(command);
  });

/** Open 编辑 and click one row, then let the whole async chain settle. */
async function chooseEditRow(container: HTMLElement, row: "edit.copy" | "edit.paste"): Promise<void> {
  await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="menu-edit-trigger"]')!);
  await tick();
  await fireEvent.click(
    container.querySelector<HTMLElement>(`[data-testid="menu-edit-${row}"]`)!,
  );
  await tick();
  await new Promise((r) => setTimeout(r, 0));
  await tick();
}

let selection: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // A real user gesture on this row means there **is** a selection; the row's own
  // `text.length > 0` guard is what makes it send anything at all.
  selection = vi.spyOn(window, "getSelection").mockReturnValue({
    toString: () => "copied text",
  } as unknown as Selection);
});

afterEach(() => {
  warn.mockRestore();
  selection.mockRestore();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  document.body.innerHTML = "";
});

describe("TopbarMainMenu — 编辑 ▸ 拷贝 / 粘贴 read the host's answer", () => {
  test("a refused copy is reported by the row, not swallowed by a dead catch", async () => {
    // The reachable host refusal: `clipboard_write` rejects text over `MAX_TEXT_LEN`
    // ("clipboard text exceeds N bytes") — the user selected a big block and nothing happened.
    const { sent } = installHost({
      clipboard_write: async () => {
        throw { code: "amos.clipboard.text_too_long", message: "clipboard text exceeds 65536 bytes" };
      },
    });
    const { container } = render(TopbarMainMenu);
    await chooseEditRow(container, "edit.copy");

    expect(sent, "the row really asked the host").toContain("clipboard_write");
    expect(
      barSaid("clipboard_write"),
      "a refused copy must leave a breadcrumb the surface names",
    ).toBe(true);
  });

  test("a copy that landed says nothing (the mirror: the breadcrumb is not unconditional)", async () => {
    const { sent } = installHost({
      clipboard_write: async () => ({
        seq: 1,
        source: "topbar.file.copy",
        owner: "main",
        timestamp_ms: 0,
        payload: { kind: "text", text: "copied text" },
      }),
    });
    const { container } = render(TopbarMainMenu);
    await chooseEditRow(container, "edit.copy");

    expect(sent, "the row asked the host").toContain("clipboard_write");
    expect(barSaid("clipboard_write"), "a copy that worked is not a failure").toBe(false);
  });

  test("a refused paste is reported too (the row below the copy row, same dead catch)", async () => {
    const { sent } = installHost({
      // The real foreground rule: `require_foreground` refuses a background window.
      clipboard_read: async () => {
        throw { code: "clipboard.read_denied", message: "clipboard read denied: not foreground" };
      },
    });
    const { container } = render(TopbarMainMenu);
    await chooseEditRow(container, "edit.paste");

    expect(sent).toContain("clipboard_read");
    expect(barSaid("clipboard_read"), "a refused paste must not be silent either").toBe(true);
  });

  test("an EMPTY clipboard is not a refusal — `null` stands for two facts", async () => {
    // `clipboard_read` answers `Ok(None)` when nothing was copied yet: the bridge call
    // **succeeded** and there is simply nothing to paste. Reporting it as a failure would
    // be the mirror-image defect, and it is what an `entry === null` check alone produces.
    const { sent } = installHost({ clipboard_read: async () => null });
    const { container } = render(TopbarMainMenu);
    await chooseEditRow(container, "edit.paste");

    expect(sent, "the row still asked the host").toContain("clipboard_read");
    expect(barSaid("clipboard_read"), "an empty clipboard is not a host refusal").toBe(false);
  });
});
