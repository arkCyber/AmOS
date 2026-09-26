/**
 * AiApp.svelte — a session delete/clear the daemon never answered must not move the list.
 *
 * `lib/backend.invoke` never rejects: it answers `null` for "not bridged" and for an RPC that
 * never reached a daemon, so `removeSession()` → `null` and `clearSessions()` → `null` both mean
 * **nothing was established**. The pre-fix bodies awaited them and moved the local mirror anyway
 * (`sessions = []` / `filter(...)`), so the row left the screen on a delete the host never carried
 * out — and on this surface the row leaving *is* the success report, so the lie had nowhere else
 * to show (REQ-A1453 / F-SH-704).
 *
 * The daemon's own answers are the other two states, and they **are** answers: `removed:false` and
 * `removed:0` (`proto/ai_agent.proto:364,356` — "it did not exist" / "nothing was cleared"), so
 * following them (moving the mirror) is correct, and the tests below pin that they are not folded
 * into the unanswered case.
 *
 * The open history panel is part of the same gesture: it is keyed by `showHist`, a row id, so a
 * session that left the list must not keep a history drawn under it.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import AiApp from "../src/svelte/AiApp.svelte";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

afterEach(() => {
  cleanup();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
/** Whether the screen shows any of the locale's renderings of `key`. */
const shows = (h: { container: HTMLElement }, key: string) =>
  [zh[key], en[key]].some((v) => v !== undefined && txt(h).includes(v));

const SESSION_IDS = ["aaaa1111", "bbbb2222"];
/** A turn the fake history answers with, so the open history panel is observable. */
const HISTORY_TURN = "历史一问";

/**
 * Install a host whose session commands answer exactly what each case needs.
 * `"throw"` is how a command that never reached a daemon looks through `invoke` (→ `null`).
 */
function installBridge() {
  const opts: {
    remove: "throw" | boolean;
    clear: "throw" | number;
    read: "throw" | "empty" | "rows";
    hist: "throw" | "empty" | "turn";
  } = {
    remove: true,
    clear: SESSION_IDS.length,
    read: "rows",
    hist: "turn",
  };
  const sessions = SESSION_IDS.map((id, i) => ({
    session_id: id,
    model: `m${i + 1}`,
    tokens_generated: i + 1,
    cancelled: false,
    age_seconds: i + 1,
  }));
  const invoke = async (cmd: string): Promise<unknown> => {
    if (cmd === "get_status") return { model: "demo", active_sessions: 0, degraded: false };
    if (cmd === "get_ai_sessions") {
      if (opts.read === "throw") {
        throw { code: "amos.ai.rpc_failed", message: "ai list_sessions failed" };
      }
      if (opts.read === "empty") return [];
      return sessions;
    }
    if (cmd === "remove_ai_session") {
      if (opts.remove === "throw") {
        throw { code: "amos.ai.rpc_failed", message: "ai remove_session failed" };
      }
      return opts.remove;
    }
    if (cmd === "clear_ai_sessions") {
      if (opts.clear === "throw") {
        throw { code: "amos.ai.rpc_failed", message: "ai clear_sessions failed" };
      }
      return opts.clear;
    }
    if (cmd === "get_ai_session_history") {
      if (opts.hist === "throw") {
        throw { code: "amos.ai.rpc_failed", message: "ai session_history failed" };
      }
      return {
        session_id: "aaaa1111",
        model: "m1",
        tokens_generated: 1,
        cancelled: false,
        turns: opts.hist === "empty" ? [] : [{ role: "user", text: HISTORY_TURN }],
      };
    }
    return null; // system_peek_context, …
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
  return opts;
}

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** Open the session panel (its rows — and the ✕ buttons — only exist while it is open). */
async function openPanel(h: { container: HTMLElement }) {
  const toggle = [...h.container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(zh["ai.sessions"]),
  ) as HTMLButtonElement;
  await fireEvent.click(toggle);
  await waitFor(() => expect(removeButtons(h)).toHaveLength(2));
}

const removeButtons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].filter(
    (b) => b.getAttribute("title") === zh["ai.removeSession"],
  ) as HTMLButtonElement[];

const histButtons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].filter(
    (b) => b.getAttribute("title") === zh["ai.history"],
  ) as HTMLButtonElement[];

const clearButton = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === zh["ai.clearSessions"],
  ) as HTMLButtonElement | undefined;

const sessionErr = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="ai-session-error"]');

const sessionsUnanswered = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="ai-sessions-unanswered"]');

const historyUnanswered = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="ai-history-unanswered"]');

/** Open the panel without assuming rows exist (the read itself may have been refused). */
async function openPanelBare(h: { container: HTMLElement }) {
  const toggle = [...h.container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(zh["ai.sessions"]),
  ) as HTMLButtonElement;
  await fireEvent.click(toggle);
  await settle();
}

describe("AiApp.svelte — a session command the daemon never answered does not move the mirror", () => {
  test("✕ on a delete the host never answered leaves the row and says so", async () => {
    installBridge().remove = "throw";
    const h = render(AiApp);
    await settle();
    await openPanel(h);

    await fireEvent.click(removeButtons(h)[0]);
    await waitFor(() => expect(shows(h, "ai.sessionRemoveUnanswered")).toBe(true));

    expect(removeButtons(h)).toHaveLength(2); // the mirror did not move
    expect(sessionErr(h)).toBeTruthy();
    expect(shows(h, "ai.sessionEmpty")).toBe(false); // and it is not drawn as an empty list
  });

  test("✕ on a delete the host confirmed drops the row and says nothing", async () => {
    installBridge().remove = true;
    const h = render(AiApp);
    await settle();
    await openPanel(h);

    await fireEvent.click(removeButtons(h)[0]);
    await waitFor(() => expect(removeButtons(h)).toHaveLength(1));

    expect(sessionErr(h)).toBeNull();
  });

  test("✕ on a delete the daemon answered `false` drops the stale row (an answer, not a refusal)", async () => {
    installBridge().remove = false;
    const h = render(AiApp);
    await settle();
    await openPanel(h);

    await fireEvent.click(removeButtons(h)[0]);
    await waitFor(() => expect(removeButtons(h)).toHaveLength(1));

    expect(sessionErr(h)).toBeNull();
  });

  test("清空会话 the host never answered leaves the list and says so", async () => {
    installBridge().clear = "throw";
    const h = render(AiApp);
    await settle();
    await openPanel(h);

    await fireEvent.click(clearButton(h)!);
    await waitFor(() => expect(shows(h, "ai.sessionsClearUnanswered")).toBe(true));

    expect(removeButtons(h)).toHaveLength(2);
    expect(shows(h, "ai.sessionEmpty")).toBe(false);
  });

  test("清空会话 the host confirmed empties the list", async () => {
    installBridge().clear = 2;
    const h = render(AiApp);
    await settle();
    await openPanel(h);

    await fireEvent.click(clearButton(h)!);
    await waitFor(() => expect(shows(h, "ai.sessionEmpty")).toBe(true));

    expect(removeButtons(h)).toHaveLength(0);
    expect(sessionErr(h)).toBeNull();
  });

  test("a later confirmed delete clears the unanswered notice", async () => {
    const opts = installBridge();
    opts.remove = "throw";
    const h = render(AiApp);
    await settle();
    await openPanel(h);

    await fireEvent.click(removeButtons(h)[0]);
    await waitFor(() => expect(sessionErr(h)).toBeTruthy());

    opts.remove = true;
    await fireEvent.click(removeButtons(h)[0]);
    await waitFor(() => expect(removeButtons(h)).toHaveLength(1));

    expect(sessionErr(h)).toBeNull();
  });

  test("a deleted session's open history does not outlive its row", async () => {
    installBridge().remove = true;
    const h = render(AiApp);
    await settle();
    await openPanel(h);

    await fireEvent.click(histButtons(h)[0]);
    await waitFor(() => expect(txt(h)).toContain(HISTORY_TURN));

    await fireEvent.click(removeButtons(h)[0]);
    await waitFor(() => expect(removeButtons(h)).toHaveLength(1));

    expect(txt(h)).not.toContain(HISTORY_TURN);
  });

  test("a session list the host never answered says so, not 「暂无 daemon 会话」", async () => {
    installBridge().read = "throw";
    const h = render(AiApp);
    await settle();
    await openPanelBare(h);

    expect(sessionsUnanswered(h)).toBeTruthy();
    expect(shows(h, "ai.sessionsUnanswered")).toBe(true);
    expect(shows(h, "ai.sessionEmpty")).toBe(false); // not a claim nobody established
    expect(removeButtons(h)).toHaveLength(0);
  });

  test("a host that answers an empty list is the empty state, not the unanswered one", async () => {
    installBridge().read = "empty";
    const h = render(AiApp);
    await settle();
    await openPanelBare(h);

    expect(sessionsUnanswered(h)).toBeNull();
    expect(shows(h, "ai.sessionEmpty")).toBe(true);
    expect(shows(h, "ai.sessionsUnanswered")).toBe(false);
  });

  test("a history read the host never answered says so, not 「暂无对话历史」", async () => {
    const opts = installBridge();
    opts.hist = "throw";
    const h = render(AiApp);
    await settle();
    await openPanel(h);

    await fireEvent.click(histButtons(h)[0]);
    await waitFor(() => expect(historyUnanswered(h)).toBeTruthy());

    expect(shows(h, "ai.historyUnanswered")).toBe(true);
    expect(shows(h, "ai.historyEmpty")).toBe(false);
  });

  test("a host that answers an empty turn list is the empty state, not the unanswered one", async () => {
    const opts = installBridge();
    opts.hist = "empty";
    const h = render(AiApp);
    await settle();
    await openPanel(h);

    await fireEvent.click(histButtons(h)[0]);
    await waitFor(() => expect(shows(h, "ai.historyEmpty")).toBe(true));

    expect(historyUnanswered(h)).toBeNull();
    expect(shows(h, "ai.historyUnanswered")).toBe(false);
  });

  test("清空会话 takes the open history with it", async () => {
    installBridge().clear = 2;
    const h = render(AiApp);
    await settle();
    await openPanel(h);

    await fireEvent.click(histButtons(h)[0]);
    await waitFor(() => expect(txt(h)).toContain(HISTORY_TURN));

    await fireEvent.click(clearButton(h)!);
    await waitFor(() => expect(txt(h)).not.toContain(HISTORY_TURN));
  });
});
