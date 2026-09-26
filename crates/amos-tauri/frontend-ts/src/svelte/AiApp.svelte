<script lang="ts">
  // AiApp.svelte — Svelte 5 (runes) single-source implementation of the AI
  // screen, rendering <VoiceMicButton/> and <StreamVoiceButton/>. chat_agent streaming
  // (tokens + semantic UiCards) + sessions/history reuses lib/backend + lib/stream
  // pure parsers. Outside Tauri every RPC degrades to null so the shell shows a
  // localized banner; live chat/voice need a real amos-ai daemon + mic.
  import {
    bridged,
    bridgeDiag,
    subscribe,
    getAiStatus,
    sendChat,
    systemClearContext,
    systemPeekContext,
    type SystemContextEntry,
    conversationId,
    newConversation,
    cancelAiSession,
    listSessions,
    clearSessions,
    removeSession,
    getSessionHistory,
    type AiSessionInfo,
    type HistoryTurn,
  } from "../lib/backend";
  import { tokenOf, cardOf, sessionMetaOf, type AiCard } from "../lib/stream";
  import { callActionDetailText } from "../lib/phone";
  import { AI_TARGET_WINDOW } from "./appLinks";
  import { capTail } from "../lib/bounded";
  import { copyTextToClipboard } from "../lib/clipboard";
  import { parseVoiceEvent } from "../lib/voice";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { localId } from "../lib/localId";
  import { NOTES_KEY, normalizeNotes } from "../lib/notes";
  import { buildCitedSnippet, buildRagPrompt, NOTES_RAG_INDEXED_KEY } from "../lib/notesRag";
  import { askNotes, liveRagClient, syncNotesIndex } from "../lib/notesRagRun";
  import { ragQueryRefusedForForeground } from "../lib/rag";
  import VoiceMicButton from "./VoiceMicButton.svelte";
  import StreamVoiceButton from "./StreamVoiceButton.svelte";
  import DeviceMicButton from "./DeviceMicButton.svelte";
  import { iconSvg } from "../lib/sysIcons";
  import { t } from "./locale.svelte";

  /* Bounds for long-lived in-session lists (deterministic-memory guard). */
  const CHAT_MSG_CAP = 200;

  type AiMsg = { id: string; role: "user" | "agent"; text: string; cards: AiCard[] };

  const CARD_COLORS: Record<string, string> = {
    weather: "linear-gradient(135deg,#38bdf8,#0ea5e9)",
    music: "linear-gradient(135deg,#f472b6,#e11d48)",
    notes: "linear-gradient(135deg,#fbbf24,#f59e0b)",
    wallet: "linear-gradient(135deg,#34d399,#059669)",
    generic: "linear-gradient(135deg,#a78bfa,#7c3aed)",
  };
  const cardBg = (kind: string) => CARD_COLORS[kind] ?? CARD_COLORS.generic;

  const online = $state(bridged());
  let q = $state("");
  let status = $state("");
  let meta = $state("");
  let degraded = $state(false);
  let copiedReply = $state(false);
  let confirmClear = $state(false);
  let sessions = $state<AiSessionInfo[] | null>(null);
  // The session list read was refused, so `sessions`'s `null` is 「我没问到」 and not a verdict
  // (REQ-A1536 / F-SH-778). A separate flag because `null` is also the value before the first read
  // lands — that is 「还没问」, and the lazy load re-reads on the next open, so the sentence must
  // not appear for it. Same shape as the sibling write-refusal slot `sessErr` below.
  let sessionsUnanswered = $state(false);
  // A refused/unanswered session delete gets its own slot, next to the list it is about — not
  // `meta`, which carries the send/stop refusals and would let one gesture blank the other's
  // reading (the two-slot rule the same screen already applies to its copy errors).
  let sessErr = $state("");
  let sessOpen = $state(false);
  let showHist = $state<string | null>(null);
  // `"unanswered"` is a third state next to the turns list: the history read was refused, so
  // drawing an empty list would be a claim the RPC never established (REQ-A1536 / F-SH-778).
  let histories = $state<Record<string, HistoryTurn[] | "loading" | "unanswered">>({});
  let busy = $state(false);
  let msgs = $state<AiMsg[]>([]);

  // "Ask my files/notes": when on, a chat turn first retrieves the nearest note
  // passages and sends a cited, context-augmented prompt (`buildRagPrompt`).
  // Retrieval is a separate daemon service from the chat model, so an offline
  // index is reported honestly and the turn still answers (without context).
  let cite = $state(false);
  let citeMsg = $state("");

  // System context that another screen attached to this app (Notes' "✦ 发送到 AI",
  // see `svelte/appLinks.sendToAi`). `chat_agent` merges it into the next request
  // and **consumes** it, so we re-peek after every send. A `null` reply means
  // "nothing attached" *or* "could not ask" (indistinguishable on the wire), so we
  // render only a positive entry and never claim that no context is attached.
  let ctxEntry = $state<SystemContextEntry | null>(null);
  const ctxPreview = (text: string): string => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
  };
  const refreshContext = async () => {
    if (!bridged()) return;
    const e = await systemPeekContext(AI_TARGET_WINDOW);
    ctxEntry = e ?? null;
  };
  // A refused detach must not read as done. `system_clear_context` fails on the host
  // (`wm.rs`: a bad target label) and `invoke` folds that into `null` — the same value
  // its `void` success has — so `ctxEntry = null` on a refusal hid the hint while the
  // host still held the context and `chat_agent` merged it into the next request: the
  // user removed a context that the AI kept receiving. The verdict comes from the
  // diagnosis slot (REQ-A296), never from the return value.
  let ctxError = $state<string | null>(null);
  const dropContext = async () => {
    ctxError = null;
    await systemClearContext(AI_TARGET_WINDOW);
    const diag = bridgeDiag("system_clear_context");
    if (!diag.ok) {
      const words = diag.kind === "not-bridged" ? "" : callActionDetailText(diag.detail);
      ctxError = t("ai.contextClearFailed", {
        detail: words === "" ? t("ai.contextNoReason") : words,
      });
      return; // the entry is still attached — keep it on screen and keep it detachable
    }
    ctxEntry = null;
  };
  $effect(() => {
    void refreshContext();
  });

  // Streaming control (plain refs; the event callbacks must stay stable).
  let curId: string | null = null; // agent message being streamed
  let aborted = false;
  let clearTimer: number | null = null;

  /**
   * A message id. Identity, not a label: `{#each msgs … (m.id)}` keys rows by it and
   * `patchCur` finds the streaming agent bubble by it — a duplicate would make one
   * stream's tokens land in the wrong bubble. Hence the shared `localId` (REQ-A401),
   * which is counter-backed; the `tag` (`a` / `u`) is kept as the prefix.
   */
  const uid = (tag: string) => localId(tag);

  // Append into the in-progress assistant message only.
  const patchCur = (fn: (m: AiMsg) => AiMsg) => {
    const id = curId;
    if (!id) return;
    msgs = msgs.map((m) => (m.id === id ? fn(m) : m));
  };
  // Append a finished chat bubble (streaming-voice turns arrive separately).
  const pushMsg = (role: "user" | "agent", text: string) => {
    msgs = capTail(
      [...msgs, { id: uid(role === "agent" ? "a" : "u"), role, text, cards: [] }],
      CHAT_MSG_CAP,
    );
  };
  /**
   * Why the bridge refused a command, in one word: the typed `code` off a
   * `command-failed` entry, else the entry's own `kind`. `""` when the ledger's last
   * word on the command is "fine" — the same read `DesktopShell.windowMenuAction`
   * makes (REQ-A297), so we never invent a reason we did not observe.
   *
   * The AI commands that need this (`chat_agent`, `cancel_ai_session`) are both
   * `Result<(), AmosError>`: the host's `Ok(())` reaches the bridge as the very same
   * `null` a refusal does, so their payload cannot separate the two and only the
   * ledger can.
   */
  const refusalDetail = (command: string): string => {
    const d = bridgeDiag(command);
    if (d.ok) return "";
    return d.kind === "command-failed" && d.detail && typeof d.detail === "object"
      ? ((d.detail as { code?: string }).code ?? d.kind)
      : d.kind;
  };

  // Session panel open/close + lazy load.
  const toggleSessions = async () => {
    const open = !sessOpen;
    sessOpen = open;
    if (open && sessions === null) {
      // No host at all is not a refusal: the screen already names the cause
      // (`backend.inBrowser`), so the browser shell keeps its plain empty state. Only a host
      // that *was asked* and did not answer is 「我没问到」(REQ-A1536 / F-SH-778).
      if (!bridged()) return;
      const answer = await listSessions();
      if (Array.isArray(answer)) {
        sessions = answer;
        sessionsUnanswered = false;
      } else {
        // `listSessions` answers `null` for "no bridge" and for an RPC that never reached the
        // daemon, so nothing about the session list was established — say so rather than drawing
        // 「暂无 daemon 会话」, a claim about the daemon only a *landed* read can make
        // (REQ-A1536 / F-SH-778).
        sessionsUnanswered = true;
      }
    }
  };
  const toggleHist = async (id: string) => {
    if (showHist === id) {
      showHist = null;
      return;
    }
    showHist = id;
    if (histories[id] === undefined) {
      histories = { ...histories, [id]: "loading" as const };
      if (!bridged()) {
        histories = { ...histories, [id]: [] };
        return;
      }
      const answer = await getSessionHistory(id);
      // A refused read (or an answer with no turn list) is not an empty history — the same
      // 「我没问到」 vs 「答了：空的」 distinction as the list above (REQ-A1536 / F-SH-778).
      histories = {
        ...histories,
        [id]: answer && Array.isArray(answer.turns) ? answer.turns : "unanswered",
      };
    }
  };

  // Stream live chat events → tokens/cards + complete/session meta + busy reset.
  let subscribed = false;
  $effect(() => {
    if (subscribed) return;
    subscribed = true;
    if (!online) return;
    let alive = true;
    // REQ-A838: `subscribe` answers `null` when the listen was refused, and the teardown below
    // must tolerate that — it is the same "nothing to release" case, not an error. Keeping the
    // `null`s in the list (rather than filtering them out) means the teardown stays a faithful
    // one-line release of whatever was acquired. Which of the five channels actually opened is
    // the ledger's answer (`bridgeDiag("ai-token-received")` etc.), not this array's length.
    const unsubs: ((() => void) | null)[] = [];
    void getAiStatus().then((s) => {
      if (!alive) return;
      if (s?.model) {
        status = t("ai.modelStatus", { model: s.model, count: s.active_sessions ?? 0 });
      }
      degraded = Boolean(s?.degraded);
    });
    void (async () => {
      unsubs.push(
        await subscribe("ai-token-received", (p) => {
          if (!alive || aborted) return;
          const tok = tokenOf(p);
          if (tok) patchCur((m) => ({ ...m, text: m.text + tok }));
        }),
      );
      unsubs.push(
        await subscribe("ai-card-received", (p) => {
          if (!alive || aborted) return;
          const card = cardOf(p);
          if (card) patchCur((m) => ({ ...m, cards: [...m.cards, card] }));
        }),
      );
      unsubs.push(
        await subscribe("ai-session-complete", (p) => {
          if (!alive) return;
          const sm = sessionMetaOf(p);
          if (sm) meta = t("ai.sessionDone", { sid: sm.sid });
        }),
      );
      unsubs.push(
        await subscribe("ai-chat-complete", () => {
          if (!alive) return;
          curId = null;
          aborted = false;
          busy = false;
        }),
      );
      // SINGLE assistant-voice sink: a finalized utterance — from the push-to-talk
      // mic (StreamVoiceButton) OR the always-on native device mic
      // (DeviceMicButton) — becomes one agent bubble. Because this is the only
      // place that forwards `assistant-voice-event` `turn_done`, a reply renders
      // exactly once and the native mic never depends on StreamVoiceButton being
      // mounted.
      unsubs.push(
        await subscribe("assistant-voice-event", (p) => {
          if (!alive) return;
          const e = parseVoiceEvent(p);
          if (e?.kind === "turn_done" && e.text.trim()) {
            pushMsg("agent", e.text.trim());
          }
        }),
      );
    })();
    return () => {
      alive = false;
      unsubs.forEach((f) => f?.());
    };
  });

  async function send(force?: string): Promise<void> {
    const v = (force ?? q).trim();
    if (!v || busy) return;
    if (!online) {
      // Offline: echo an agent note so users see why nothing streams.
      msgs = capTail(
        [
          ...msgs,
          { id: uid("u"), role: "user", text: v, cards: [] },
          { id: uid("a"), role: "agent", text: t("backend.offline"), cards: [] },
        ],
        CHAT_MSG_CAP,
      );
      q = "";
      return;
    }
    q = "";
    const agent = uid("a");
    curId = agent;
    aborted = false;
    busy = true;
    meta = "";
    msgs = capTail(
      [
        ...msgs,
        { id: uid("u"), role: "user", text: v, cards: [] },
        { id: agent, role: "agent", text: "", cards: [] },
      ],
      CHAT_MSG_CAP,
    );
    let prompt = v;
    citeMsg = "";
    if (cite) {
      citeMsg = t("ai.citeIndexing");
      try {
        const known = readStoreValue<string[]>(NOTES_RAG_INDEXED_KEY, []);
        const notesNow = normalizeNotes(readStoreValue<unknown>(NOTES_KEY, []));
        const res = await syncNotesIndex(liveRagClient, notesNow, known);
        writeStoreValue(NOTES_RAG_INDEXED_KEY, res.indexed);
        const qr = await askNotes(liveRagClient, v);
        if (qr === null) {
          // Two different `null`s: the index refused *this window* (F-AI-019) versus the index
          // being unreachable. The refusal is a fact about focus, so the honest sentence names
          // focus — and the turn still goes out, just without note context.
          citeMsg = ragQueryRefusedForForeground() ? t("ai.citeRefused") : t("ai.citeOffline");
        } else if (qr.hits.length > 0) {
          prompt = buildRagPrompt(v, buildCitedSnippet(qr.hits));
          citeMsg = t("ai.citeUsed", { n: String(qr.hits.length) });
        } else {
          citeMsg = t("ai.citeNone");
        }
      } catch {
        citeMsg = t("ai.citeOffline");
      }
    }
    // A stop during retrieval cancels the turn before it reaches the daemon.
    if (aborted) return;
    await sendChat(prompt, conversationId());
    // The daemon consumed the attached system context while merging it into this
    // request, so re-peek and stop claiming it is still attached.
    void refreshContext();
    // A send the daemon never received emits no `ai-chat-complete`, so the turn must
    // be ended here or the UI sticks on "⏹ 停止". The payload cannot say whether it
    // was received (`chat_agent` returns `Result<(), AmosError>`, so `Ok(())` and a
    // refusal are both `null`), so ask the ledger (REQ-A297) instead.
    if (!bridgeDiag("chat_agent").ok && !aborted) {
      curId = null;
      busy = false;
      meta = t("ai.sendRefused", { code: refusalDetail("chat_agent") });
    }
  }

  const stop = () => {
    if (!busy) return;
    aborted = true;
    void cancelAiSession().then(() => {
      // The turn ends here either way: the user asked to stop, and a stop taken while
      // the turn is still fetching note context has no open stream to cancel — no
      // `ai-chat-complete` is coming, so waiting for the event would strand the UI on
      // "⏹ 停止". Only the ledger may speak about the host, and `cancel_ai_session`
      // (also `Result<(), AmosError>`) reports the same `null` whether it landed or not.
      curId = null;
      busy = false;
      if (!bridgeDiag("cancel_ai_session").ok) {
        meta = t("ai.stopRefused", { code: refusalDetail("cancel_ai_session") });
      }
    });
  };

  const clear = () => {
    // Disarm the two-step 清空 confirmation (idempotent; also clears any pending
    // auto-disarm timer so a stale tick can't fire on a later session).
    if (clearTimer != null) {
      window.clearTimeout(clearTimer);
      clearTimer = null;
    }
    confirmClear = false;
    curId = null;
    aborted = false;
    busy = false;
    meta = "";
    msgs = [];
  };

  // Teardown: never leave the confirm auto-disarm timer running after unmount.
  $effect(() => {
    return () => {
      if (clearTimer != null) window.clearTimeout(clearTimer);
    };
  });

  // The session list is a **mirror** of the daemon's ledger, so it may only move when the
  // daemon *answered*. `invoke` folds every failure — not bridged, or an RPC that never reached a
  // daemon — into `null`, and `null` establishes nothing: the pre-fix bodies awaited
  // `clearSessions()` / `removeSession()` and moved the mirror regardless, so a delete the host
  // never carried out still vanished its row, and a 清空 blanked a list the daemon still held.
  // The row leaving the screen *is* this surface's success report, so the lie had nowhere else to
  // show (REQ-A1453 / F-SH-704). `false` / `0` are the daemon's own answers — "it did not exist"
  // (`RemoveSessionReply.removed`, `proto/ai_agent.proto:364`) and "nothing was cleared"
  // (`ClearSessionsReply.removed`, `:356`) — and following the daemon's answer is correct there.
  //
  // The open history panel is part of the same gesture: `showHist` names a row, so a session that
  // left the list must not keep a history drawn under it (the viewer-copy-outlives-the-write
  // family) — and its cached turns go with it, or a re-listed id would draw the old ones.
  const forgetHistory = (id: string) => {
    if (showHist === id) showHist = null;
    histories = Object.fromEntries(Object.entries(histories).filter(([k]) => k !== id));
  };
  const clearSess = async () => {
    sessErr = "";
    const removed = await clearSessions();
    if (removed === null) {
      sessErr = t("ai.sessionsClearUnanswered");
      return;
    }
    sessions = [];
    showHist = null;
    histories = {};
  };
  const delSess = async (id: string) => {
    sessErr = "";
    const removed = await removeSession(id);
    if (removed === null) {
      sessErr = t("ai.sessionRemoveUnanswered");
      return;
    }
    sessions = (sessions ?? []).filter((s) => s.session_id !== id);
    forgetHistory(id);
  };

  const lastAgent = $derived([...msgs].reverse().find((m) => m.role === "agent" && m.text));
  // REQ-A1271 — the claim follows the effect. The pre-fix body was
  // `try { await navigator.clipboard?.writeText(lastAgent.text); copiedReply = true; } catch {}`;
  // when the API is absent (the case `PhotosApp::copyText` names as the normal one in a WebView
  // without a secure context) the optional call short-circuits to `undefined` — no throw, so the
  // `catch` never fired and 「✓」 was set over an empty clipboard. The shared helper asks the
  // API's presence first and answers `false`; a refused copy says so instead.
  let copyErr = $state("");
  const copyReply = async () => {
    if (!lastAgent?.text) return;
    if (!(await copyTextToClipboard(lastAgent.text))) {
      copyErr = t("common.copyFailed");
      return;
    }
    copyErr = "";
    copiedReply = true;
    window.setTimeout(() => {
      copiedReply = false;
    }, 1500);
  };

  // Last user question — the target of "↺ resend".
  const lastUserText = $derived([...msgs].reverse().find((m) => m.role === "user" && m.text)?.text);
  const resend = () => {
    if (lastUserText && !busy) void send(lastUserText);
  };

  // Brand-new conversation: clear the bubbles AND rotate the multi-turn id.
  const newChat = () => {
    if (busy) stop();
    clear();
    newConversation();
  };

  // Two-step 清空: first tap arms it, second tap (within a short window) confirms.
  const clearArmed = () => {
    if (confirmClear) {
      confirmClear = false;
      clear();
      return;
    }
    confirmClear = true;
    if (clearTimer != null) window.clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => {
      confirmClear = false;
    }, 3000);
  };
</script>

<div class="flex h-full flex-col p-3">
  <div class="flex items-center gap-2">
    <span class="text-3xl">🤖</span>
    {#if status}<span class="truncate text-xs opacity-60">{status}</span>{/if}
    {#if degraded}
      <span
        role="alert"
        title={t("ai.degraded")}
        class="shrink-0 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-300"
      >{t("ai.degraded")}</span>
    {/if}
    <div class="ml-auto flex items-center gap-1">
      <button
        onclick={() => void toggleSessions()}
        class="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
      >{t("ai.sessions")}{sessions !== null ? ` ${sessions.length}` : ""}</button>
      {#if msgs.length > 0}
        <button onclick={newChat} class="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700">{t("ai.newChat")}</button>
      {/if}
      {#if lastUserText && !busy}
        <button onclick={resend} class="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700">{t("ai.resend")}</button>
      {/if}
      {#if lastAgent && !busy}
        <button onclick={() => void copyReply()} class="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700">{copiedReply ? "✓" : t("ai.copyReply")}</button>
      {/if}
      <button onclick={clearArmed} class="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700">{confirmClear ? t("ai.clearConfirm") : t("ai.clear")}</button>
    </div>
  </div>
  {#if meta}<p class="mt-0.5 text-[11px] opacity-60">{meta}</p>{/if}
  {#if copyErr}
    <p
      role="status"
      data-testid="ai-copy-error"
      class="mt-0.5 rounded-md bg-black/5 px-2 py-1 text-[11px] text-danger dark:bg-white/10"
    >{copyErr}</p>
  {/if}
  {#if sessOpen}
    <div class="mt-1 space-y-1 rounded-xl bg-neutral-200/50 p-2 text-[11px] dark:bg-neutral-800/50">
      {#if sessErr}
        <p
          role="status"
          data-testid="ai-session-error"
          class="rounded-md bg-danger/10 px-2 py-1 text-danger dark:bg-danger/20"
        >{sessErr}</p>
      {/if}
      {#if sessions && sessions.length > 0}
        <button onclick={() => void clearSess()} class="block w-full text-right text-accent hover:underline">{t("ai.clearSessions")}</button>
      {/if}
      {#if sessions && sessions.length > 0}
        {#each sessions as s (s.session_id)}
          <div class="flex items-center justify-between gap-2">
            <span class="truncate font-mono">{s.session_id.slice(0, 8)}</span>
            <span class="truncate opacity-70">{s.model}</span>
            <span class="tabular-nums opacity-60">{s.tokens_generated}t · {s.age_seconds}s{s.cancelled ? " · ✕" : ""}</span>
            <button
              onclick={() => void toggleHist(s.session_id)}
              title={t("ai.history")}
              class="rounded-full bg-neutral-300 px-1.5 text-xs dark:bg-neutral-700"
            >{showHist === s.session_id ? "▲" : "…"}</button>
            <button
              onclick={() => void delSess(s.session_id)}
              title={t("ai.removeSession")}
              data-icon="x"
              class="grid h-7 w-7 place-items-center rounded-full bg-danger/8 text-danger dark:bg-danger/20"
            >{@html iconSvg("x", "h-3 w-3")}</button>
          </div>
        {/each}
      {:else if sessionsUnanswered}
        <!-- The read was refused: `sessions` is `null`, which is 「我没问到」. The `{:else}` used
             to draw this as 「暂无 daemon 会话」 — an assertion about the daemon that a refused RPC
             cannot support (REQ-A1536 / F-SH-778). -->
        <p
          role="status"
          data-testid="ai-sessions-unanswered"
          class="opacity-60"
        >{t("ai.sessionsUnanswered")}</p>
      {:else}
        <p class="opacity-60">{t("ai.sessionEmpty")}</p>
      {/if}
      {#if showHist && histories[showHist] !== undefined}
        <div class="max-h-32 space-y-1 overflow-auto border-t pt-1">
          {#if histories[showHist] === "loading"}
            <p class="opacity-50">{t("ai.historyLoading")}</p>
          {:else if histories[showHist] === "unanswered"}
            <p
              role="status"
              data-testid="ai-history-unanswered"
              class="opacity-60"
            >{t("ai.historyUnanswered")}</p>
          {:else if (histories[showHist] as HistoryTurn[]).length === 0}
            <p class="opacity-60">{t("ai.historyEmpty")}</p>
          {:else}
            {#each (histories[showHist] as HistoryTurn[]) as tn, i ((showHist as string) + String(i))}
              <p class="leading-snug">
                <span class={tn.role === "user" ? "" : "opacity-70"}>{tn.role === "user" ? "👤 " : "🤖 "}</span>
                {tn.text}
              </p>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  {/if}
  {#if !online}
    <p class="mt-1 text-sm opacity-70">{t("backend.inBrowser")}</p>
  {/if}
  {#if ctxEntry}
    <div
      data-testid="ai-context"
      aria-label={t("ai.contextAttached", { src: ctxEntry.source_window })}
      class="mt-2 flex items-center justify-between gap-2 rounded-xl bg-accent/10 px-3 py-1.5 text-xs ring-1 ring-accent/25"
    >
      <span class="truncate">
        {t("ai.contextAttached", { src: ctxEntry.source_window })}：{ctxPreview(ctxEntry.text)}
      </span>
      <button
        onclick={() => void dropContext()}
        data-testid="ai-context-clear"
        title={t("ai.contextClear")}
        class="shrink-0 opacity-70 hover:opacity-100"
      >✕</button>
    </div>
    {#if ctxError}
      <p
        role="alert"
        data-testid="ai-context-error"
        class="mt-1 rounded-md bg-red-500/15 px-2 py-1 text-[11px] font-medium text-red-700 dark:text-red-300"
      >{ctxError}</p>
    {/if}
  {/if}

  <div
    role="log"
    aria-live="polite"
    class="mt-2 flex-1 space-y-2 overflow-auto rounded-2xl bg-neutral-200/40 p-2 text-sm dark:bg-neutral-800/40"
  >
    {#if msgs.length === 0}
      <p class="py-8 text-center text-xs opacity-40">{t("ai.placeholder")}</p>
    {:else}
      {#each msgs as m (m.id)}
        <div
          class={m.role === "user"
            ? "ml-auto max-w-[80%] whitespace-pre-wrap rounded-2xl bg-accent px-3 py-2 text-white"
            : "max-w-[88%] whitespace-pre-wrap rounded-2xl bg-neutral-200/70 px-3 py-2 text-neutral-900 dark:bg-neutral-700/70 dark:text-white"}
        >
          {m.text}
          {#each m.cards as c (c.kind + (c.title || ""))}
            <div class="mt-2 overflow-hidden rounded-2xl border border-neutral-300/60 bg-neutral-50 dark:border-neutral-700/60 dark:bg-neutral-900/70">
              <div class="px-3 py-1.5 text-xs font-semibold text-white" style:background={cardBg(c.kind)}>{c.title || c.kind}</div>
              {#if c.subtitle}<div class="px-3 py-1 text-xs opacity-70">{c.subtitle}</div>{/if}
              {#if c.fields.length > 0}
                <div class="px-3 py-1 text-xs">
                  {#each c.fields as f, fi (fi)}
                    <div class="flex justify-between gap-4 py-0.5">
                      <span class="opacity-60">{f.key}</span>
                      <span class="text-right font-medium">{f.value}</span>
                    </div>
                  {/each}
                </div>
              {/if}
              {#if c.actions.length > 0}
                <div class="flex flex-wrap gap-1.5 px-3 pb-2">
                  {#each c.actions as a, ai (ai)}
                    <span class="rounded-full bg-neutral-200 px-2 py-0.5 text-[10px] text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">{a}</span>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    {/if}
  </div>

  <!-- composer: stop · streaming voice · ASR mic · text · send -->
  <div class="mt-2 flex items-end gap-2">
    {#if busy}
      <button onclick={stop} class="rounded-full bg-danger px-3 py-2 text-xs text-white">{t("ai.stop")}</button>
    {/if}
    <StreamVoiceButton
      online={online}
      disabled={busy}
      session={() => conversationId()}
      onStart={() => pushMsg("user", t("ai.voicePrompt"))}
      onError={(cmd) => {
        // The push-to-talk mic's start/end are `Result<(), _>`: a host that never opened the
        // listener (or never finalized the utterance) answers the same `null` as success, so the
        // refusal is read off the ledger (REQ-A297) and said here — the screen that owns the
        // status line. Without it the user held the mic, spoke, and got silence.
        meta = t("ai.voiceRefused", { code: refusalDetail(cmd) });
      }}
    />
    <DeviceMicButton
      online={online}
      disabled={busy}
      session={() => conversationId()}
    />
    <VoiceMicButton
      online={online}
      disabled={busy}
      onTranscript={(tx) => {
        if (tx) q = tx;
      }}
    />
    <button
      onclick={() => (cite = !cite)}
      data-testid="ai-cite-toggle"
      aria-pressed={cite}
      title={t("ai.citeTitle")}
      class="grid h-8 shrink-0 place-items-center rounded-full px-2 text-sm {cite
        ? 'bg-accent text-white'
        : 'bg-neutral-200/70 dark:bg-neutral-800/70'}"
    >📚</button>
    <textarea
      bind:value={q}
      rows={2}
      onkeydown={(e) => {
        const k = e as KeyboardEvent;
        if (k.key === "Enter" && !k.shiftKey) void send();
      }}
      placeholder={t("backend.prompt")}
      class="flex-1 resize-none rounded-2xl bg-neutral-200/70 p-2 text-sm outline-none dark:bg-neutral-800/70"
    ></textarea>
    <button
      onclick={() => void send()}
      disabled={busy}
      aria-label={t("a11y.send")}
      title={t("a11y.send")}
      data-icon="send"
      class="grid h-8 w-9 place-items-center rounded-full bg-accent px-2 text-white disabled:opacity-40"
    >{@html iconSvg("send", "h-[18px] w-[18px]")}</button>
  </div>
  {#if citeMsg}
    <p role="status" data-testid="ai-cite-status" class="mt-1 px-1 text-[11px] opacity-60">{citeMsg}</p>
  {/if}
</div>

