<script lang="ts">
  // MessagesApp.svelte — Svelte 5 (runes) single-source messages screen.
  // Offline-first. When a real SMS provider is present (device: SmsGlue over JNI)
  // the screen shows the *device inbox* threads/messages and sends real SMS via
  // `sms_send`; otherwise it falls back to local conversations (host/offline).
  // Pure logic lives in lib/messages.ts; unread → notification sync via $effect.
  import {
    CONV_KEY,
    addConversation,
    appendMessage,
    appendQuote,
    clearMessages,
    findConversation,
    fmtBubbleTime,
    isNewDay,
    markAllRead,
    messageDayLabel,
    normalizeConversations,
    normalizeMessages,
    removeConversation,
    removeMessageAt,
    seedConversations,
    unreadCount,
  } from "../lib/messages";
  import type { Conversation, Msg } from "../lib/messages";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { NOTIF_KEY, removeAppNotifs } from "../lib/settings";
  import { iconSvg } from "../lib/sysIcons";
  import type { Notif } from "../lib/settings";
  import { bridged, smsMessages, smsSend, smsSnapshot } from "../lib/backend";
  import { zh } from "../i18n/locales/zh";
  import { t } from "./locale.svelte";

  const seeded = ((): Conversation[] => {
    const stored = readStoreValue<unknown>(CONV_KEY, []);
    if (Array.isArray(stored) && stored.length) return normalizeConversations(stored);
    const s = seedConversations(Date.now());
    writeStoreValue(CONV_KEY, s);
    return s;
  })();
  let conversations = $state<Conversation[]>(seeded);
  let activeId = $state<string>(seeded[0]?.id ?? "");
  let text = $state("");
  let replyTo = $state<string | null>(null);
  let newName = $state("");

  const active = $derived(findConversation(conversations, activeId));
  const msgs = $derived(active?.msgs ?? []);
  const saveConvs = (next: Conversation[]) => {
    const norm = normalizeConversations(next);
    conversations = norm;
    writeStoreValue(CONV_KEY, norm);
    if (!findConversation(norm, activeId)) activeId = norm[0]?.id ?? "";
  };
  // Replace the active thread's message list (pure helper then store).
  const setMsgs = (l: Msg[]) => {
    const list = normalizeMessages(l);
    saveConvs(conversations.map((c) => (c.id === activeId ? { ...c, msgs: list } : c)));
  };

  // ---- Real SMS (device) --------------------------------------------------------
  // When a real SMS provider is present (device SmsGlue over JNI), show the real
  // inbox threads and send through `sms_send`. `smsAddr` maps a conv id → its
  // remote address; local conversations are untouched when there is no real SMS.
  let realSms = $state(false);
  let smsAddr = $state<Record<string, string>>({});
  const smsThreadId = (convId: string): string | null =>
    convId.startsWith("sms:") ? convId.slice(4) : null;
  const loadRealMsgs = (convId: string) => {
    const tid = smsThreadId(convId);
    if (!tid) return;
    void smsMessages(tid).then((m) => {
      if (!m) return;
      const mapped: Msg[] = [...m]
        .sort((a, b) => a.ts_ms - b.ts_ms)
        .map((x) => ({ from: x.from_me ? "me" : "them", text: x.text, ts: x.ts_ms, read: x.read }));
      conversations = conversations.map((c) => (c.id === convId ? { ...c, msgs: mapped } : c));
    });
  };
  // Probe once: if the device reports real threads, switch the screen to them.
  $effect(() => {
    if (!bridged()) return;
    void smsSnapshot().then((ts) => {
      if (!ts || ts.length === 0) return; // no real SMS → keep local conversations
      realSms = true;
      const convs: Conversation[] = ts.map((th) => ({
        id: `sms:${th.id}`,
        name: th.display_name || th.address,
        msgs: [],
      }));
      const addr: Record<string, string> = {};
      for (const th of ts) addr[`sms:${th.id}`] = th.address;
      smsAddr = addr;
      conversations = convs;
      activeId = convs[0]?.id ?? "";
      if (activeId) loadRealMsgs(activeId);
    });
  });
  // Load a thread's messages whenever the active real thread changes.
  $effect(() => {
    if (realSms && activeId) loadRealMsgs(activeId);
  });

  // Publish unread incoming messages across conversations as app notifications.
  $effect(() => {
    const app = zh["app.messages"];
    const existing = readStoreValue<Notif[]>(NOTIF_KEY, []);
    const hadAppNotifs = existing.some((n) => n.app === app);
    const all = conversations.flatMap((c) => c.msgs);
    const unread = all.filter((m) => m.from === "them" && !m.read).slice(0, 20);
    if (unread.length === 0 && !hadAppNotifs) return;
    const others = removeAppNotifs(existing, app);
    const fresh: Notif[] = unread.map((m, i) => ({
      id: `msg:${i}:${m.ts}`,
      app,
      icon: "💬",
      title: m.text.length > 40 ? `${m.text.slice(0, 40)}…` : m.text,
      time: m.ts,
    }));
    writeStoreValue(NOTIF_KEY, [...others, ...fresh]);
  });

  const send = () => {
    const v = text.trim();
    if (!v || !active) return;
    // Real device thread → send via SmsManager (then reload the thread).
    if (realSms && smsThreadId(active.id)) {
      const addr = smsAddr[active.id];
      if (!addr) return;
      void smsSend(addr, v).then((ok) => {
        text = "";
        if (ok) loadRealMsgs(active.id);
      });
      return;
    }
    setMsgs(
      replyTo
        ? appendQuote(markAllRead(msgs), v, replyTo, Date.now())
        : appendMessage(markAllRead(msgs), v, Date.now()),
    );
    replyTo = null;
    text = "";
  };
  const clear = () => {
    if (!active) return;
    text = "";
    replyTo = null;
    setMsgs(clearMessages());
  };
  const confirmAdd = () => {
    const before = conversations;
    const next = addConversation(before, newName, Date.now());
    if (next.length === before.length) return; // blank or duplicate → no-op
    const added = next[next.length - 1] as Conversation; // addConversation appended it
    saveConvs(next);
    activeId = added.id;
    newName = "";
  };
  const deleteThread = () => {
    const next = removeConversation(conversations, activeId);
    saveConvs(next);
    replyTo = null;
    text = "";
  };

  // iOS-style: swipe left on a message to delete that single message.
  let swipeStart: { x: number; i: number } | null = null;
  const onSwipeStart = (e: TouchEvent, i: number) => {
    const x = e.touches[0]?.clientX;
    if (x != null) swipeStart = { x, i };
  };
  const onSwipeEnd = (e: TouchEvent) => {
    const s = swipeStart;
    swipeStart = null;
    if (!s) return;
    const x = e.changedTouches[0]?.clientX;
    if (x == null) return;
    if (s.x - x > 50) setMsgs(removeMessageAt(msgs, s.i));
  };

  const dayLabelOf = (ts: number): string => {
    const dl = messageDayLabel(ts, Date.now());
    return dl === "today" ? t("message.today") : dl === "yesterday" ? t("message.yesterday") : dl;
  };
</script>

<div class="flex h-full flex-col p-3">
  <!-- Conversation bar: switch threads -->
  <div class="mb-1 flex items-center gap-1.5 overflow-x-auto">
    {#each conversations as c (c.id)}
      <button onclick={() => (activeId = c.id)} aria-pressed={c.id === activeId} class={"shrink-0 rounded-full px-3 py-1 text-xs " + (c.id === activeId ? "bg-accent text-white" : "bg-black/5 text-neutral-700 dark:bg-white/10 dark:text-neutral-300")}>{c.name}{#if unreadCount(c.msgs) > 0}<span class="ml-1">●</span>{/if}</button>
    {/each}
  </div>
  <!-- Always-visible row to start a new contact-thread (local conversations only) -->
  {#if !realSms}
    <div class="mb-1.5 flex items-center gap-1.5">
      <input bind:value={newName} aria-label="new-contact" onkeydown={(e) => e.key === "Enter" && confirmAdd()} placeholder={t("message.contactPlaceholder")} class="min-w-0 flex-1 rounded-full bg-black/5 px-3 py-1.5 text-sm text-neutral-900 outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:text-white dark:ring-white/10 dark:placeholder:text-white/30" />
      <button onclick={confirmAdd} aria-label="add-contact" title={t("message.addThread")} class="shrink-0 rounded-full bg-accent px-3 py-1.5 text-xs text-white active:scale-95">{t("message.confirm")}</button>
    </div>
  {/if}

  {#if active}
    <div class="flex items-center justify-between pb-2">
      <div class="flex min-w-0 items-center gap-2">
        <span class="text-sm font-semibold">{active.name}</span>
        {#if realSms}
          <span data-testid="real-sms-badge" class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent">📡 {t("message.realSms")}</span>
        {/if}
        {#if unreadCount(msgs) > 0}
          <button onclick={() => setMsgs(markAllRead(msgs))} title={t("message.markRead")} class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">{unreadCount(msgs)} {t("message.unread")}</button>
        {/if}
      </div>
      <div class="flex items-center gap-1.5">
        {#if conversations.length > 1 && !realSms}
          <button onclick={deleteThread} aria-label="delete-thread" title={t("message.deleteThread")} class="rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700">{t("message.deleteThread")}</button>
        {/if}
        <button onclick={clear} disabled={msgs.length === 0} aria-label={t("message.clear")} class="rounded-full bg-neutral-200 px-3 py-1 text-xs disabled:opacity-40 dark:bg-neutral-700"><span data-icon="trash" class="inline-flex align-[-1px]">{@html iconSvg("trash", "h-3 w-3")}</span> {t("message.clear")}</button>
      </div>
    </div>
    <div class="flex-1 space-y-2 overflow-auto">
      {#if msgs.length === 0}
        <p class="py-10 text-center text-sm opacity-60">{t("message.empty")}</p>
      {:else}
        {#each msgs as m, i (m.ts + "-" + i)}
          {@const prev = msgs[i - 1]}
          {#if !prev || isNewDay(prev.ts, m.ts)}
            <p class="py-1 text-center text-xs uppercase tracking-wider text-neutral-500 dark:text-neutral-400">{dayLabelOf(m.ts)}</p>
          {/if}
          <div role="group" class={"group flex items-start gap-1.5 max-w-[86%] " + (m.from === "me" ? "ml-auto" : "")} ontouchstart={(e) => onSwipeStart(e, i)} ontouchend={onSwipeEnd}>
            <div class={"rounded-2xl px-3 py-2 text-sm " + (m.from === "me" ? "bg-accent text-white" : "bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-white")}>
              {#if m.quote}
                <div class="mb-1 rounded-md bg-white/10 px-1.5 py-0.5 text-xs opacity-70"><span class="inline-flex">{@html iconSvg("reply", "h-3 w-3")}</span> {m.quote}</div>
              {/if}
              <div class="whitespace-pre-wrap">{m.text}</div>
              <div class="mt-0.5 text-right text-xs tabular-nums opacity-60">{fmtBubbleTime(m.ts)}</div>
            </div>
            <button onclick={() => (replyTo = m.text)} aria-label={t("message.reply")} data-icon="reply" class="mt-1 shrink-0 rounded-full px-1 text-xs opacity-0 transition-opacity group-hover:opacity-60">{@html iconSvg("reply", "h-4 w-4")}</button>
            <button onclick={() => setMsgs(removeMessageAt(msgs, i))} aria-label={t("message.remove")} data-icon="x" class="mt-1 shrink-0 rounded-full px-1 text-xs opacity-0 transition-opacity group-hover:opacity-60">{@html iconSvg("x", "h-3 w-3")}</button>
          </div>
        {/each}
      {/if}
    </div>
    {#if replyTo}
      <div class="mt-1 flex items-center justify-between gap-2 rounded-lg bg-accent/10 px-2 py-1 text-xs">
        <span class="truncate text-accent">{t("message.replying")}: {replyTo}</span>
        <button onclick={() => (replyTo = null)} aria-label={t("message.replyClear")} class="shrink-0 px-1 text-accent">{@html iconSvg("x", "h-3 w-3")}</button>
      </div>
    {/if}
    <div class="mt-2 flex items-center gap-2 pb-1">
      <input bind:value={text} onkeydown={(e) => e.key === "Enter" && send()} placeholder={t("message.placeholder", { name: active.name })} aria-label="message-input" class="min-w-0 flex-1 rounded-full bg-black/5 px-3.5 py-2 text-sm outline-none dark:bg-white/10" />
      <button onclick={send} title={t("message.placeholder", { name: active.name })} aria-label="send" data-icon="send" class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-white active:scale-90">{@html iconSvg("send", "h-[18px] w-[18px]")}</button>
    </div>
  {:else}
    <p class="py-16 text-center text-sm opacity-60">{t("message.noThreads")}</p>
  {/if}
</div>

