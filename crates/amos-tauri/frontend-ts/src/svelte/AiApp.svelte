<script lang="ts">
  // AiApp.svelte — Svelte 5 (runes) single-source implementation of the AI
  // screen, rendering <VoiceMicButton/> and <StreamVoiceButton/>. chat_agent streaming
  // (tokens + semantic UiCards) + sessions/history reuses lib/backend + lib/stream
  // pure parsers. Outside Tauri every RPC degrades to null so the shell shows a
  // localized banner; live chat/voice need a real amos-ai daemon + mic.
  import {
    bridged,
    subscribe,
    getAiStatus,
    sendChat,
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
  import { capTail } from "../lib/bounded";
  import { parseVoiceEvent } from "../lib/voice";
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
  let sessOpen = $state(false);
  let showHist = $state<string | null>(null);
  let histories = $state<Record<string, HistoryTurn[] | "loading">>({});
  let busy = $state(false);
  let msgs = $state<AiMsg[]>([]);

  // Streaming control (plain refs; the event callbacks must stay stable).
  let curId: string | null = null; // agent message being streamed
  let aborted = false;
  let clearTimer: number | null = null;

  const uid = (tag: string) =>
    `${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

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
  // Session panel open/close + lazy load.
  const toggleSessions = async () => {
    const open = !sessOpen;
    sessOpen = open;
    if (open && sessions === null) {
      const res = await listSessions();
      if (Array.isArray(res)) sessions = res;
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
      const res = await getSessionHistory(id);
      const turns = res && Array.isArray(res.turns) ? res.turns : [];
      histories = { ...histories, [id]: turns };
    }
  };

  // Stream live chat events → tokens/cards + complete/session meta + busy reset.
  let subscribed = false;
  $effect(() => {
    if (subscribed) return;
    subscribed = true;
    if (!online) return;
    let alive = true;
    const unsubs: (() => void)[] = [];
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
      unsubs.forEach((f) => f());
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
    const r = await sendChat(v, conversationId());
    // If the command failed to reach the daemon (r == null) no `ai-chat-complete`
    // event will ever fire — clear busy so the UI never sticks on "⏹ 停止".
    if (r == null && !aborted) {
      curId = null;
      busy = false;
      meta = t("backend.offline");
    }
  }

  const stop = () => {
    if (!busy) return;
    aborted = true;
    void cancelAiSession().then((res) => {
      if (res == null) {
        curId = null;
        busy = false;
        meta = t("backend.offline");
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

  const clearSess = async () => {
    await clearSessions();
    sessions = [];
  };
  const delSess = async (id: string) => {
    await removeSession(id);
    sessions = (sessions ?? []).filter((s) => s.session_id !== id);
  };

  const lastAgent = $derived([...msgs].reverse().find((m) => m.role === "agent" && m.text));
  const copyReply = async () => {
    if (!lastAgent?.text) return;
    try {
      await navigator.clipboard?.writeText(lastAgent.text);
      copiedReply = true;
      window.setTimeout(() => {
        copiedReply = false;
      }, 1500);
    } catch {
      /* clipboard unavailable: no-op */
    }
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
  {#if sessOpen}
    <div class="mt-1 space-y-1 rounded-xl bg-neutral-200/50 p-2 text-[11px] dark:bg-neutral-800/50">
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
              class="grid h-5 w-5 place-items-center rounded-full bg-neutral-300 text-danger dark:bg-neutral-700"
            >{@html iconSvg("x", "h-3 w-3")}</button>
          </div>
        {/each}
      {:else}
        <p class="opacity-60">{t("ai.sessionEmpty")}</p>
      {/if}
      {#if showHist && histories[showHist] !== undefined}
        <div class="max-h-32 space-y-1 overflow-auto border-t pt-1">
          {#if histories[showHist] === "loading"}
            <p class="opacity-50">{t("ai.historyLoading")}</p>
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
      aria-label="send"
      title="send"
      data-icon="send"
      class="grid h-8 w-9 place-items-center rounded-full bg-accent px-2 text-white disabled:opacity-40"
    >{@html iconSvg("send", "h-[18px] w-[18px]")}</button>
  </div>
</div>

