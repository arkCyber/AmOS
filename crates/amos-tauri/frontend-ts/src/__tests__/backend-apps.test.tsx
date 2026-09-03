import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { AiApp } from "../components/BackendApps";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ---- Real lib/backend + a fake window.__TAURI_INTERNALS__ bridge. The module
 *      is NOT replaced, so nothing leaks to other test files. ---- */
type Listener = (ev: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();
let daemonDown = false;
let aiSessions: { session_id: string; model: string; tokens_generated: number; cancelled: boolean; age_seconds: number }[] = [];
let aiHistory: Record<string, { turns: { role: string; text: string }[] }> = {};
async function invoke(cmd: string, args?: Record<string, unknown>) {
  if (daemonDown) return null; // every command rejected -> offline
  if (cmd === "get_status") return { model: "unit-model", active_sessions: 1 };
  if (cmd === "get_ai_sessions") return aiSessions;
  if (cmd === "get_ai_session_history") {
    const id = String((args as { sessionId?: unknown } | undefined)?.sessionId ?? "");
    return aiHistory[id] ?? { turns: [] };
  }
  if (cmd === "remove_ai_session") {
    const id = String((args as { sessionId?: unknown } | undefined)?.sessionId ?? "");
    aiSessions = aiSessions.filter((s) => s.session_id !== id);
    return true;
  }
  if (cmd === "clear_ai_sessions") {
    const n = aiSessions.length;
    aiSessions = [];
    return n;
  }
  return "ok";
}

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke,
  listen: (channel: string, cb: Listener) => {
    listeners.set(channel, cb);
    return () => {
      listeners.delete(channel);
    };
  },
};

/** Deliver a daemon event of `kind` to whoever subscribed to it. */
function emit(kind: string, payload: unknown) {
  listeners.get(kind)?.({ payload });
}

const mounted: { root: Root; host: HTMLElement }[] = [];
beforeEach(() => {
  daemonDown = false;
  listeners.clear();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: (channel: string, cb: Listener) => {
      listeners.set(channel, cb);
      return () => {
        listeners.delete(channel);
      };
    },
  };
});
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  listeners.clear();
  daemonDown = false;
  aiSessions = [];
  aiHistory = {};
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const wait = () => new Promise((r) => setTimeout(r, 0));
async function flush() {
  await act(async () => {
    await wait();
    await wait();
  });
}

/** Set a React-controlled textarea's value via its own onChange (happy-dom does
 * not fire onChange for synthetic native 'input' events). */
function typeInto(host: HTMLElement, text: string) {
  const ta = host.querySelector("textarea") as HTMLTextAreaElement;
  const key = Object.keys(ta).find((k) => k.startsWith("__reactProps$"));
  const props = (ta as unknown as Record<string, { onChange?: (e: { target: { value: string } }) => void }>)[key!]!;
  props.onChange?.({ target: { value: text } });
}

function mountAi() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <AiApp />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

describe("AiApp (fake __TAURI_INTERNALS__, DOM)", () => {
  test("typing + send streams ai tokens/card then completes (busy lifecycle)", async () => {
    const host = mountAi();
    await flush(); // subscription effect mounts + getAiStatus resolves

    // Status from getAiStatus surfaces in the header.
    expect(host.textContent).toContain("unit-model");

    await act(async () => typeInto(host, "天气如何?"));
    await flush(); // q commits

    const sendBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "➤")!;
    await act(async () => {
      sendBtn.click();
    });
    await flush(); // sendChat resolves; user + agent(empty) bubbles render

    expect(host.textContent).toContain("天气如何?"); // user bubble

    // Streaming ai events arrive asynchronously from the daemon.
    await act(async () => {
      emit("ai-token-received", { token: "今天" });
      emit("ai-token-received", { token: "晴朗" });
    });
    expect(host.textContent).toContain("今天晴朗");

    await act(async () => {
      emit("ai-card-received", { kind: "weather", title: "北京", fields: [{ key: "气温", value: "26°" }] });
    });
    expect(host.textContent).toContain("北京");

    // Stop button visible while busy.
    expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.includes("停止"))).toBe(true);

    await act(async () => {
      emit("ai-session-complete", ["conv-1", "今天晴朗"]);
      emit("ai-chat-complete", {});
    });
    // After completion: not busy (stop gone), meta carries the session id.
    expect(host.textContent).not.toContain("停止");
    expect(host.textContent).toContain("会话 conv-1 完成");
  });

  test("a rejected send (daemon down) clears busy and reports offline (no stuck ⏹)", async () => {
    daemonDown = true; // every invoke returns null
    const host = await mountAi();
    await flush();

    await act(async () => typeInto(host, "在吗?"));
    await flush();

    const sendBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "➤")!;
    await act(async () => {
      sendBtn.click();
    });
    await flush();

    // No streaming possible -> offline message surfaced, and busy must not stick
    // (no 停止 button) even though the daemon never sent ai-chat-complete.
    expect(host.textContent).toContain("未连接守护进程");
    expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.includes("停止"))).toBe(false);
  });

  test("copy-reply writes the last finished assistant text to the clipboard", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void writes.push(t) },
    });

    const host = await mountAi();
    await flush();

    await act(async () => typeInto(host, "介绍一下"));
    await flush();
    const sendBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "➤")!;
    await act(async () => {
      sendBtn.click();
    });
    await flush();

    await act(async () => {
      emit("ai-token-received", { token: "Amos" });
      emit("ai-token-received", { token: " 是系统助手。" });
      emit("ai-session-complete", ["conv-1", "Amos 是系统助手。"]);
      emit("ai-chat-complete", {});
    });
    expect(host.textContent).toContain("Amos 是系统助手。");

    const copy = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("复制回答"));
    expect(copy).toBeTruthy();
    await act(async () => {
      copy!.click();
    });
    await flush(); // let the async clipboard write settle
    expect(writes).toEqual(["Amos 是系统助手。"]);
  });

  test("↺ resend re-runs the last question and streams a fresh answer", async () => {
    const host = await mountAi();
    await flush();

    const ask = async (question: string, token: string) => {
      await act(async () => typeInto(host, question));
      await flush();
      const sendBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "➤")!;
      await act(async () => {
        sendBtn.click();
      });
      await flush();
      await act(async () => {
        emit("ai-token-received", { token });
        emit("ai-chat-complete", {});
      });
    };

    await ask("介绍一下", "首次回答");
    expect(host.textContent).toContain("首次回答");

    const resend = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("重发"));
    expect(resend).toBeTruthy();
    await act(async () => {
      resend!.click();
    });
    await flush();

    // Resend opened a new round: stream a second (different) answer into it.
    await act(async () => {
      emit("ai-token-received", { token: "二次回答" });
      emit("ai-chat-complete", {});
    });
    expect(host.textContent).toContain("二次回答");
    expect(host.textContent).toContain("首次回答"); // both rounds preserved
  });

  test("new chat clears the bubbles and rotates the multi-turn conversation id", async () => {
    const host = await mountAi();
    await flush();

    await act(async () => typeInto(host, "记住我是小明"));
    await flush();
    const sendBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "➤")!;
    await act(async () => {
      sendBtn.click();
    });
    await flush();
    await act(async () => {
      emit("ai-token-received", { token: "好的。" });
      emit("ai-chat-complete", {});
    });
    expect(host.textContent).toContain("记住我是小明");
    expect(window.localStorage.getItem("amos.ai.session")).toBeTruthy(); // a session id was persisted

    const fresh = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("新建会话"))!;
    expect(fresh).toBeTruthy();
    await act(async () => {
      fresh.click();
    });
    await flush();

    expect(window.localStorage.getItem("amos.ai.session")).toBe(""); // multi-turn id rotated away
    expect(host.textContent).toContain("与 AI 对话"); // placeholder = bubbles cleared
    expect(host.textContent).not.toContain("记住我是小明");
  });

  test("清空 needs a second tap to confirm (accidental-wipe guard)", async () => {
    const host = await mountAi();
    await flush();

    await act(async () => typeInto(host, "测试内容"));
    await flush();
    const sendBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "➤")!;
    await act(async () => {
      sendBtn.click();
    });
    await flush();
    await act(async () => {
      emit("ai-token-received", { token: "回答" });
      emit("ai-chat-complete", {});
    });
    expect(host.textContent).toContain("测试内容");

    // First tap on 清空 arms confirmation — content must still be present.
    const clearBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "清空")!;
    await act(async () => {
      clearBtn.click();
    });
    expect(host.textContent).toContain("确认清空?"); // armed
    expect(host.textContent).toContain("测试内容"); // NOT cleared yet

    // Second tap confirms and wipes.
    const armed = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("确认清空"))!;
    await act(async () => {
      armed.click();
    });
    expect(host.textContent).not.toContain("测试内容");
    expect(host.textContent).toContain("与 AI 对话");
  });

  test("会话 opens a panel listing daemon sessions from get_ai_sessions", async () => {
    aiSessions = [
      { session_id: "aaaaaaaa-bbbb-cccc", model: "m-test", tokens_generated: 12, cancelled: false, age_seconds: 5 },
    ];
    const host = await mountAi();
    await flush();

    const sessBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "会话")!;
    expect(sessBtn).toBeTruthy();
    await act(async () => {
      sessBtn.click();
    });
    await flush();
    expect(host.textContent).toContain("m-test");
    expect(host.textContent).toContain("12t");

    // Clear sessions: panel empties back to the empty state.
    const clearAll = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "清空会话")!;
    expect(clearAll).toBeTruthy();
    await act(async () => {
      clearAll.click();
    });
    await flush();
    expect(host.textContent).toContain("暂无 daemon 会话");
    expect(host.textContent).not.toContain("m-test");
  });

  test("会话 per-row ✕ removes exactly that daemon session", async () => {
    aiSessions = [
      { session_id: "aaa", model: "m1", tokens_generated: 1, cancelled: false, age_seconds: 1 },
      { session_id: "bbb", model: "m2", tokens_generated: 2, cancelled: false, age_seconds: 2 },
    ];
    const host = await mountAi();
    await flush();
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "会话")!.click();
    });
    await flush();
    expect(host.textContent).toContain("m1");
    expect(host.textContent).toContain("m2");

    // Click the delete button inside m1's row.
    const del = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "✕" && b.parentElement?.textContent?.includes("m1"),
    )!;
    expect(del).toBeTruthy();
    await act(async () => {
      del.click();
    });
    await flush();
    expect(host.textContent).not.toContain("m1");
    expect(host.textContent).toContain("m2"); // sibling untouched
  });

  test("会话 history toggle expands a session's completed turns", async () => {
    aiSessions = [{ session_id: "sess1", model: "m", tokens_generated: 2, cancelled: false, age_seconds: 1 }];
    aiHistory = { sess1: { turns: [{ role: "user", text: "你好" }, { role: "assistant", text: "你好呀" }] } };
    const host = await mountAi();
    await flush();
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "会话")!.click();
    });
    await flush();
    expect(host.textContent).toContain("sess1");

    const hist = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "…" && b.parentElement?.textContent?.includes("sess1"),
    )!;
    expect(hist).toBeTruthy();
    await act(async () => {
      hist.click();
    });
    await flush();
    expect(host.textContent).toContain("你好");
    expect(host.textContent).toContain("你好呀");
  });
});
