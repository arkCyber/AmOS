/**
 * rag-foreground-read.svelte.test.ts — REQ-A1399 / F-AI-019 —
 * 「从笔记索引里**检索**是前景窗口才有的权利，而两处界面从前把**被拒**画成**离线**」。
 *
 * 宿主侧 `rag_query` 现在走 `require_rag_foreground`（与 `device_mic_start`（F-AI-018）、
 * `clipboard_read`、短信读取、信箱读取、录音账本同一条规则，`crate::clipboard::require_foreground`）；
 * 一段被检索出来的 passage **就是用户的笔记正文**，所以检索是一次披露。而两处调用方此前把
 * `null` 一律画成「笔记检索离线」：
 *
 *   - `NotesApp.svelte::runAsk` 逐字 `askOffline = res === null;`
 *   - `AiApp.svelte` 的引用通路逐字 `if (qr === null) citeMsg = t("ai.citeOffline");`
 *
 * 被前景规则拒（宿主答 `amos.rag.foreground_required`）被画成「索引离线」——那是对**守护进程**
 * 的一条断言，而守护进程刚刚答过话（它拒的是**这个窗口**）。所以这一轮把两种 `null` 分开：
 * 没有桥 ∕ 宿主的拒读码 → 「未检索：当前窗口不是您正在查看的那个」；守护进程拒绝 ∕ 不可达 →
 * 照旧「离线」。
 *
 * 两处**都必须**改：同一把事实被两个界面引用，只修一处正是 F-SH-639 ∕ F-SH-649 的形状。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotesApp from "../src/svelte/NotesApp.svelte";
import AiApp from "../src/svelte/AiApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { resetShellState } from "../src/svelte/shellState.svelte";
import { zh } from "../src/i18n/locales/zh";

const FOREGROUND_CODE = "amos.rag.foreground_required";

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};
const btnByAria = (h: { container: HTMLElement }, label: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
const textareaByPlaceholder = (h: { container: HTMLElement }, p: string) =>
  [...h.container.querySelectorAll("textarea")].find((t) =>
    (t.getAttribute("placeholder") ?? "").includes(p),
  ) as HTMLTextAreaElement | undefined;

/**
 * A device bridge whose `rag_query` rejects with `refusal` — the way the host fails. `invoke`
 * folds that into `null` and keeps the payload in `bridgeDiag("rag_query").detail`, which is
 * where the surface reads *which* `null` it got.
 */
function installNotesHost(refusal: { code?: string; message?: string }) {
  const calls: string[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "rag_query") throw refusal;
      if (cmd === "rag_status") return { indexed: 0, dimension: 3, embedder: "mock" };
      return null;
    },
    listen: async () => () => {},
  };
  return { queryCalls: () => calls.filter((c) => c === "rag_query").length };
}

/** Drive NotesApp's "ask my notes" panel to the point where the retrieval has happened. */
async function askNotesPanel(host: { container: HTMLElement }, question = "预算还剩多少") {
  await fireEvent.click(
    host.container.querySelector('button[data-testid="note-ask-toggle"]') as HTMLButtonElement,
  );
  await settle();
  const input = host.container.querySelector('[data-testid="note-ask-q"]') as HTMLInputElement;
  await fireEvent.input(input, { target: { value: question } });
  await fireEvent.click(
    host.container.querySelector('button[data-testid="note-ask-run"]') as HTMLButtonElement,
  );
  await settle();
}

beforeEach(() => setLocale("zh"));
afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("NotesApp — 从笔记索引检索要用户正在看着这个窗口", () => {
  test("被前景规则拒绝：不画成索引离线", async () => {
    const host0 = installNotesHost({
      code: FOREGROUND_CODE,
      message:
        "[amos.rag.foreground_required] rag query refused: 'shell/main' is not the foreground window",
    });
    const host = render(NotesApp);
    await settle();
    await askNotesPanel(host);

    expect(host0.queryCalls()).toBeGreaterThan(0);
    expect(txt(host)).toContain(zh["note.askRefused"]);
    // Not a claim about the daemon: "offline" would be a fact about the index service, and the
    // service answered — it refused *this window*.
    expect(txt(host)).not.toContain(zh["note.askOffline"]);
    expect(host.container.querySelector('[data-testid="note-ask-refused"]')).not.toBeNull();
  });

  test("索引真的不可达：照旧说离线，不是被拒", async () => {
    installNotesHost({ code: "amos.rag.rpc_failed", message: "rag rpc failed: daemon absent" });
    const host = render(NotesApp);
    await settle();
    await askNotesPanel(host);

    expect(txt(host)).toContain(zh["note.askOffline"]);
    expect(txt(host)).not.toContain(zh["note.askRefused"]);
    expect(host.container.querySelector('[data-testid="note-ask-refused"]')).toBeNull();
  });

  test("没有桥：照旧离线，且那句被拒不会凭空出现", async () => {
    const host = render(NotesApp);
    await settle();
    await fireEvent.click(
      host.container.querySelector('button[data-testid="note-ask-toggle"]') as HTMLButtonElement,
    );
    await settle();

    expect(txt(host)).toContain(zh["note.askOffline"]);
    expect(txt(host)).not.toContain(zh["note.askRefused"]);
  });
});

describe("AiApp — 引用通路同样把「被拒」与「离线」分开", () => {
  /** Fake bridge whose `rag_query` rejects with `refusal`; `chat_agent` records its prompt. */
  function installAiHost(refusal: { code?: string; message?: string }) {
    const chatArgs: { prompt?: string }[] = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: { prompt?: string }) => {
        if (cmd === "get_status") {
          return { model: "amos", engine: "api", engine_model: "m", degraded: false, active_sessions: 0 };
        }
        if (cmd === "rag_index") return { indexed: true, dimension: 3 };
        if (cmd === "rag_query") throw refusal;
        if (cmd === "chat_agent") {
          chatArgs.push(args ?? {});
          return null;
        }
        return null;
      },
      listen: async () => () => {},
    };
    return { chatArgs };
  }

  test("检索被拒：如实说未检索，且这一轮仍照常发出（不带笔记上下文）", async () => {
    const { chatArgs } = installAiHost({
      code: FOREGROUND_CODE,
      message: "[amos.rag.foreground_required] rag query refused: 'ai' is not the foreground window",
    });
    const host = render(AiApp);
    await settle();

    await fireEvent.click(
      host.container.querySelector('[data-testid="ai-cite-toggle"]') as HTMLButtonElement,
    );
    const input = textareaByPlaceholder(host, "输入指令");
    await fireEvent.input(input as HTMLTextAreaElement, { target: { value: "我这个月还剩多少钱？" } });
    await fireEvent.click(btnByAria(host, zh["a11y.send"]) as HTMLButtonElement);

    await settle();
    await new Promise<void>((r) => setTimeout(r, 5));
    await settle();

    expect(txt(host)).toContain(zh["ai.citeRefused"]);
    expect(txt(host)).not.toContain(zh["ai.citeOffline"]);
    // The turn still goes out — the refusal cost the note context, not the answer.
    expect(chatArgs.length).toBeGreaterThan(0);
    expect(chatArgs[0]?.prompt).toBe("我这个月还剩多少钱？");
  });

  test("索引真的不可达：照旧说离线", async () => {
    installAiHost({ code: "amos.rag.rpc_failed", message: "rag rpc failed: daemon absent" });
    const host = render(AiApp);
    await settle();

    await fireEvent.click(
      host.container.querySelector('[data-testid="ai-cite-toggle"]') as HTMLButtonElement,
    );
    const input = textareaByPlaceholder(host, "输入指令");
    await fireEvent.input(input as HTMLTextAreaElement, { target: { value: "随便问问" } });
    await fireEvent.click(btnByAria(host, zh["a11y.send"]) as HTMLButtonElement);

    await settle();
    await new Promise<void>((r) => setTimeout(r, 5));
    await settle();

    expect(txt(host)).toContain(zh["ai.citeOffline"]);
    expect(txt(host)).not.toContain(zh["ai.citeRefused"]);
  });
});

// `resetShellState` keeps a previous file's window/label map from leaking into this one.
afterEach(() => resetShellState());
