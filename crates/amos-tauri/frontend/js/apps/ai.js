// Amos app: AI 助手 (drives the real amos-ai daemon via the Tauri RPC bridge).
// The Tauri Rust core streams tokens back as `ai-token-received` events, which
// main.js forwards to window.AmosAi. This module only renders + sends.

(function () {
  const A = window.Amos;
  let mounted = false;
  let agentNode = null;
  let busy = false;
  let aborted = false;
  let activeSession = null;
  const sessions = new Map();
  const SESSION_KEY = "amos.ai.session";

  // Stable per-conversation session id, persisted so multi-turn memory survives
  // across renders. Backends with lineage (Hermes-Rust) bind all turns with the
  // same id to one conversation.
  function conversationId() {
    const existing = A.safeGet(SESSION_KEY, "");
    if (existing) return existing;
    const id = "conv-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    A.safeSet(SESSION_KEY, id);
    return id;
  }
  function newConversation() {
    const id = "conv-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    A.safeSet(SESSION_KEY, id);
    return id;
  }

  const api = {
    get mounted() { return mounted; },

    pushToken(token) {
      if (!mounted || aborted) return;
      if (!agentNode) agentNode = A.el("div", { class: "msg agent", style: msgStyle("agent") }, "");
      const log = document.getElementById("ai-log");
      if (!log) return;
      if (!agentNode.parentNode) log.appendChild(agentNode);
      agentNode.textContent += token;
      log.scrollTop = log.scrollHeight;
    },

    chatComplete() {
      if (!mounted) return;
      agentNode = null;
      activeSession = null;
      busy = false;
      aborted = false;
      const send = document.getElementById("ai-send");
      if (send) send.disabled = false;
      const stop = document.getElementById("ai-stop");
      if (stop) stop.disabled = true;
    },

    // Stop the current generation: stop rendering further tokens and ask the
    // backend to cancel (best-effort; works fully for the bidi `chat_agent`
    // path, otherwise it just halts the UI until the stream ends).
    stop() {
      if (!busy) return;
      aborted = true;
      const I = window.__TAURI_INTERNALS__;
      if (I) I.invoke("cancel_ai_session").catch(() => {});
      const stop = document.getElementById("ai-stop");
      if (stop) stop.disabled = true;
    },

    sessionComplete(payload) {
      if (!mounted) return;
      const [sid, full] = Array.isArray(payload) ? payload : [null, null];
      if (sid && full) sessions.set(sid, full);
      const meta = document.getElementById("ai-meta");
      if (meta) meta.textContent = sid ? `会话 ${sid} 完成` : "";
    },

    setStatus(text) {
      const el = document.getElementById("ai-status");
      if (el) el.textContent = text;
    },

    // Show a hint when another app has injected a system-wide context for us.
    refreshCtx() {
      const el = document.getElementById("ai-ctx");
      const I = window.__TAURI_INTERNALS__;
      if (!el) return;
      if (!I) { el.textContent = ""; return; }
      I.invoke("system_peek_context", { targetWindow: "ai" }).then((entry) => {
        if (!entry) { el.textContent = ""; return; }
        const text = String(entry.text || "");
        const preview = text.length > 40 ? text.slice(0, 40) + "…" : text;
        el.textContent = `已附加系统上下文（来自 ${entry.source_window}）：${preview}`;
      }).catch(() => { el.textContent = ""; });
    },

    // Stable conversation identity (multi-turn memory).
    conversationId,
    newConversation,

    // Render a structured UI card (from the daemon's semantic intent engine).
    showCard(card) {
      if (!mounted || !card || !card.kind) return;
      const log = document.getElementById("ai-log");
      if (!log || !window.AmosCards) return;
      const node = window.AmosCards.render(card);
      if (node) { log.appendChild(node); log.scrollTop = log.scrollHeight; }
      api.chatComplete();
    },

    reset() {
      const log = document.getElementById("ai-log");
      if (log) log.innerHTML = "";
      agentNode = null;
      sessions.clear();
      newConversation(); // clearing the log also starts a fresh session lineage
    },
  };
  window.AmosAi = api;

  const msgStyle = (kind) => ({
    maxWidth: "78%", padding: "8px 12px", borderRadius: "16px",
    alignSelf: kind === "me" ? "flex-end" : "flex-start",
    background: kind === "me" ? "#0a84ff" : "rgba(255,255,255,0.1)",
    whiteSpace: "pre-wrap", wordBreak: "break-word",
  });

  function addMsg(kind, text) {
    const log = document.getElementById("ai-log");
    const div = A.el("div", { class: "msg " + kind, style: msgStyle(kind) }, text);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  A.register({
    id: "ai",
    name: "AI 助手",
    icon: "🤖",
    gradient: ["#6b3dff", "#8b2ff5"],
    render() {
      const log = A.el("div", {
        id: "ai-log",
        style: {
          flex: "1", overflowY: "auto", display: "flex", flexDirection: "column",
          gap: "8px", padding: "4px 2px 12px", minHeight: "0",
        },
      });
      const meta = A.el("div", { id: "ai-meta", class: "muted", style: { minHeight: "16px", marginBottom: "6px" } }, "");
      const status = A.el("span", { id: "ai-status", class: "muted", style: { fontSize: "11px" } }, "检测 AI 守护进程…");

      const input = A.el("input", { id: "ai-input", class: "field", placeholder: "输入指令，AI Agent 将在系统底层流式执行…" });
      const sendBtn = A.el("button", { id: "ai-send", class: "btn" }, "发送");
      const stopBtn = A.el("button", { id: "ai-stop", class: "btn secondary", disabled: true, onclick: () => api.stop() }, "⏹ 停止");

      const send = () => {
        const text = input.value.trim();
        if (!text || busy) return;
        busy = true;
        aborted = false;
        sendBtn.disabled = true;
        const stop = document.getElementById("ai-stop");
        if (stop) stop.disabled = false;
        addMsg("me", text);
        input.value = "";
        const sid = conversationId();
        activeSession = sid;
        const I = window.__TAURI_INTERNALS__;
        if (!I) {
          addMsg("agent", "当前非 Tauri 环境，AI 守护进程不可用。");
          api.chatComplete();
          return;
        }
        I.invoke("chat_agent", { prompt: text, sessionId: sid, targetWindow: "ai" }).catch((err) => {
          addMsg("agent", `RPC 错误：${err}`);
          api.chatComplete();
        });
      };

      sendBtn.onclick = send;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

      const clearBtn = A.el("button", { class: "btn secondary", onclick: () => api.reset() }, "清空");

      const body = A.el("div", {
        id: "ai-body",
        style: { display: "flex", flexDirection: "column", height: "100%", minHeight: "0" },
      }, [
        A.el("div", { class: "row spread", style: { marginBottom: "6px" } }, [status, clearBtn]),
        A.el("div", { id: "ai-ctx", class: "muted", style: { fontSize: "11px", minHeight: "14px", marginBottom: "4px" } }, ""),
        meta,
        log,
        A.el("div", { class: "row", style: { marginTop: "8px" } }, [stopBtn, input, sendBtn]),
      ]);

      return A.appShell("AI 助手", body);
    },
    onMount() {
      mounted = true;
      // Probe daemon readiness on open.
      const I = window.__TAURI_INTERNALS__;
      if (!I) { api.setStatus("非 Tauri 环境 · AI 不可用"); return; }
      I.invoke("get_status", {}).then((st) => {
        api.setStatus(`AI 在线 · ${st.model} · ${st.active_sessions} 会话`);
      }).catch(() => api.setStatus("AI 守护进程离线"));
      api.refreshCtx(); // show any system context injected by another app
    },
    onUnmount() { mounted = false; },
  });
})();
