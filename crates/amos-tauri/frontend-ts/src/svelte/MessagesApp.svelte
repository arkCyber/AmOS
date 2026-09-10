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
  import {
    SMS_FOLDERS,
    SMS_RECEIVED_EVENT,
    bridged,
    smsCounts,
    smsFolderSnapshot,
    smsMessages,
    smsSend,
    smsStatus,
    subscribe,
  } from "../lib/backend";
  import type { SmsFolder, SmsFolderCounts, SmsMessageOut, SmsThreadOut } from "../lib/backend";
  import {
    DRAFT_KEY,
    draftId,
    normalizeDrafts,
    removeDraft,
    saveDraft,
  } from "../lib/smsDrafts";
  import type { SmsDraft } from "../lib/smsDrafts";
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
  // The real device store lives in its OWN state and never mixes with the local
  // conversations / notification machinery (that coupling caused a render loop on
  // device). `smsMode` is resolved from the backend status so the honest host
  // mock keeps the local conversations, while a device backend shows the real
  // folders (inbox / sent / drafts) — including their *empty* and *unreadable*
  // (permission) states, which must never be collapsed into "no messages".
  let smsMode = $state<"unknown" | "local" | "real">("unknown");
  let folder = $state<SmsFolder>("inbox");
  let counts = $state<SmsFolderCounts>({ inbox: 0, sent: 0, draft: 0 });
  let realThreads = $state<SmsThreadOut[]>([]);
  let realActiveId = $state("");
  let realMsgs = $state<SmsMessageOut[]>([]);
  let realText = $state("");
  let realErr = $state("");
  let smsErr = $state("");
  let smsDenied = $state(false);
  let smsBusy = $state(false);
  // AmOS-local drafts (the platform only lets the *default* SMS app write
  // drafts, so ours are stored locally and labelled as such).
  let drafts = $state<SmsDraft[]>(normalizeDrafts(readStoreValue<unknown>(DRAFT_KEY, [])));
  const saveDrafts = (next: SmsDraft[]) => {
    const norm = normalizeDrafts(next);
    drafts = norm;
    writeStoreValue(DRAFT_KEY, norm);
  };
  const activeReal = $derived(realThreads.find((th) => th.id === realActiveId) ?? null);
  const activeRealName = $derived(
    activeReal ? activeReal.display_name || activeReal.address : "",
  );
  const loadReal = (id: string, address?: string) => {
    realErr = "";
    void smsMessages(id, folder, address).then((m) => {
      if (m) realMsgs = [...m].sort((a, b) => a.ts_ms - b.ts_ms);
      else realErr = t("message.loadFailed");
    });
  };
  const openReal = (id: string) => {
    realActiveId = id;
    const th = realThreads.find((x) => x.id === id);
    loadReal(id, th?.address);
  };
  const refreshCounts = () => {
    void smsCounts().then((c) => {
      if (c) counts = c;
    });
  };
  // Re-read the active folder: success (possibly empty) vs failure are distinct.
  const refreshReal = () => {
    smsBusy = true;
    refreshCounts();
    void smsFolderSnapshot(folder).then((r) => {
      smsBusy = false;
      if (r.ok) {
        smsErr = "";
        smsDenied = false;
        realThreads = r.threads;
        const first = r.threads[0];
        if (first && !r.threads.some((th) => th.id === realActiveId)) {
          openReal(first.id);
        } else if (realActiveId) {
          // Same thread still open → reload its messages, so a message that just
          // arrived (live `sms-received` refresh) shows up without a manual pull.
          loadReal(realActiveId, activeReal?.address);
        }
      } else {
        realThreads = [];
        realMsgs = [];
        smsDenied = r.denied;
        smsErr = r.denied ? t("message.smsDenied") : t("message.smsUnavailable");
      }
    });
  };
  // Switching folders re-reads that folder's threads and messages.
  const setFolder = (f: SmsFolder) => {
    if (folder === f) return;
    folder = f;
    realActiveId = "";
    realMsgs = [];
    realErr = "";
    smsErr = "";
    refreshReal();
  };
  // Resolve the backend (mock → keep local conversations; device → real).
  // The Kotlin glue attaches in the Activity's `onStart`, which can land *after*
  // the WebView boots, so a single probe could see "mock" and wrongly stay local
  // forever. Bounded retries (no endless polling) close that race.
  const SMS_PROBE_ATTEMPTS = 4;
  const SMS_PROBE_DELAY_MS = 1500;
  const probeSms = async () => {
    for (let attempt = 0; attempt < SMS_PROBE_ATTEMPTS; attempt++) {
      const st = await smsStatus();
      if (st && st.device) {
        smsMode = "real";
        refreshReal();
        return;
      }
      if (attempt < SMS_PROBE_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, SMS_PROBE_DELAY_MS));
      }
    }
    smsMode = "local"; // honest: no device backend after the bounded retries
  };
  const retrySms = () => {
    if (smsMode === "real") refreshReal();
    else void probeSms();
  };
  // Compose to an arbitrary number (device mode). The platform persists the send,
  // so the new thread shows up in the provider and `refreshReal` picks it up.
  let showNew = $state(false);
  let newTo = $state("");
  let newText = $state("");
  const startNew = () => {
    showNew = true;
    realErr = "";
  };
  const cancelNew = () => {
    showNew = false;
    newTo = "";
    newText = "";
    realErr = "";
  };
  // Keep a draft instead of sending (local store; one draft per address).
  const saveDraftNow = () => {
    if (!newTo.trim() || !newText.trim()) return;
    saveDrafts(saveDraft(drafts, newTo, newText, Date.now()));
    newTo = "";
    newText = "";
    showNew = false;
  };
  const sendNew = () => {
    const to = newTo.trim();
    const v = newText.trim();
    if (!to || !v) return;
    smsBusy = true;
    void smsSend(to, v).then((ok) => {
      smsBusy = false;
      if (!ok) {
        realErr = t("message.sendFailed");
        return;
      }
      // A sent draft is no longer a draft.
      saveDrafts(removeDraft(drafts, draftId(to)));
      newTo = "";
      newText = "";
      showNew = false;
      refreshReal();
    });
  };
  // Edit an existing draft: load it into the composer (send or re-save/delete).
  const editDraft = (d: SmsDraft) => {
    newTo = d.address;
    newText = d.text;
    showNew = true;
    realErr = "";
  };
  const deleteDraft = (d: SmsDraft) => {
    saveDrafts(removeDraft(drafts, d.id));
  };
  const sendReal = () => {
    const v = realText.trim();
    if (!v || !activeReal) return;
    void smsSend(activeReal.address, v).then((ok) => {
      if (!ok) {
        realErr = t("message.sendFailed");
        return;
      }
      realText = "";
      refreshReal();
    });
  };
  // Probe once (guarded so the effect can never re-enter).
  let probed = false;
  $effect(() => {
    if (probed || !bridged()) return;
    probed = true;
    void probeSms();
  });

  // Live receive: the device pushes `sms-received` (SMS_RECEIVED broadcast →
  // Kotlin → JNI → here); we re-read the inbox through the validated read path
  // instead of polling. Only subscribed while the device backend is active.
  $effect(() => {
    if (smsMode !== "real") return;
    let un: (() => void) | null = null;
    let cancelled = false;
    void subscribe(SMS_RECEIVED_EVENT, () => refreshReal()).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      if (un) un();
    };
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
  {#if smsMode === "real"}
    <!-- Folder tabs: inbox / sent / drafts (counts are distinct threads) -->
    <div class="mb-1.5 flex items-center gap-1 overflow-x-auto" data-testid="sms-folders">
      {#each SMS_FOLDERS as f (f)}
        {@const badge = counts[f] + (f === "draft" ? drafts.length : 0)}
        <button onclick={() => setFolder(f)} aria-pressed={folder === f} data-folder={f} class={"shrink-0 rounded-full px-3 py-1 text-xs " + (folder === f ? "bg-accent text-white" : "bg-black/5 text-neutral-700 dark:bg-white/10 dark:text-neutral-300")}>{t(`message.folder.${f}`)}{#if badge > 0}<span class="ml-1 opacity-80">{badge}</span>{/if}</button>
      {/each}
    </div>
    <!-- Device inbox toolbar: compose a new message + refresh the real inbox -->
    <div class="mb-1.5 flex items-center justify-between gap-1.5">
      <button onclick={startNew} aria-label="new-sms" class="rounded-full bg-accent px-3 py-1 text-xs text-white active:scale-95">{t("message.newSms")}</button>
      <button onclick={retrySms} disabled={smsBusy} aria-label="refresh-sms" title={t("message.refresh")} class="rounded-full bg-neutral-200 px-3 py-1 text-xs disabled:opacity-40 dark:bg-neutral-700">{t("message.refresh")}</button>
    </div>
    {#if showNew}
      <!-- Compose to any number: the platform persists the send, so the thread
           appears in the provider and the list refreshes below. -->
      <div class="mb-1.5 flex items-center gap-1.5" data-testid="new-sms-form">
        <input bind:value={newTo} aria-label="new-sms-to" placeholder={t("message.toPlaceholder")} class="min-w-0 flex-1 rounded-full bg-black/5 px-3 py-1.5 text-sm outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:ring-white/10 dark:placeholder:text-white/30" />
        <input bind:value={newText} aria-label="new-sms-text" placeholder={t("message.newSmsHint")} onkeydown={(e) => e.key === "Enter" && sendNew()} class="min-w-0 flex-1 rounded-full bg-black/5 px-3 py-1.5 text-sm outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:ring-white/10 dark:placeholder:text-white/30" />
        <button onclick={sendNew} disabled={smsBusy} aria-label="new-sms-send" class="shrink-0 rounded-full bg-accent px-3 py-1.5 text-xs text-white active:scale-95 disabled:opacity-40">{t("message.send")}</button>
        <button onclick={saveDraftNow} aria-label="new-sms-draft" class="shrink-0 rounded-full bg-neutral-200 px-3 py-1.5 text-xs dark:bg-neutral-700">{t("message.saveDraft")}</button>
        <button onclick={cancelNew} aria-label="new-sms-cancel" class="shrink-0 rounded-full bg-neutral-200 px-2 py-1.5 text-xs dark:bg-neutral-700">{t("message.cancel")}</button>
      </div>
    {/if}
    {#if folder === "draft"}
      <!-- Drafts: AmOS-local (only the default SMS app may write system drafts) -->
      <div class="flex-1 space-y-2 overflow-auto" data-testid="drafts-list">
        <p class="pb-1 text-xs opacity-60">{t("message.draftsLocalHint")}</p>
        {#if drafts.length === 0}
          <p class="py-10 text-center text-sm opacity-60">{t("message.draftsEmpty")}</p>
        {:else}
          {#each drafts as d (d.id)}
            <div class="flex items-start gap-2 rounded-xl bg-black/5 px-3 py-2 dark:bg-white/10">
              <button onclick={() => editDraft(d)} aria-label={`draft-edit-${d.address}`} class="min-w-0 flex-1 text-left">
                <div class="text-xs opacity-60">{d.address}</div>
                <div class="truncate text-sm">{d.text}</div>
              </button>
              <button onclick={() => deleteDraft(d)} aria-label={`draft-delete-${d.address}`} class="shrink-0 rounded-full bg-neutral-200 px-2 py-1 text-xs dark:bg-neutral-700">{t("message.delete")}</button>
            </div>
          {/each}
        {/if}
        {#if realThreads.length > 0}
          <!-- Draft rows the platform itself holds (written by the default SMS
               app). Read-only for us: only the default SMS app may write them. -->
          <p class="pt-2 text-xs opacity-60">{t("message.draftsSystem")}</p>
          {#each realThreads as th (th.id)}
            <div class="rounded-xl bg-black/5 px-3 py-2 dark:bg-white/10" data-testid="system-draft">
              <div class="text-xs opacity-60">{th.display_name || th.address}</div>
              <div class="truncate text-sm">{th.last_text}</div>
            </div>
          {/each}
        {/if}
      </div>
    {:else if smsErr}
      <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="sms-error">
        <p class="text-sm text-red-500" role="alert">{smsErr}</p>
        {#if smsDenied}
          <p class="text-xs opacity-60">{t("message.smsDeniedHint")}</p>
        {/if}
        <button onclick={retrySms} disabled={smsBusy} aria-label="sms-retry" class="rounded-full bg-accent px-4 py-1.5 text-xs text-white active:scale-95 disabled:opacity-40">{t("message.retry")}</button>
      </div>
    {:else if realThreads.length === 0}
      <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="sms-empty">
        <p class="text-sm opacity-60">{t("message.inboxEmpty")}</p>
        {#if realErr}
          <p class="text-xs text-red-500" role="alert">{realErr}</p>
        {/if}
      </div>
    {:else}
    <!-- Real device inbox (SmsGlue over JNI): read threads + send via SmsManager -->
    <div class="mb-1 flex items-center gap-1.5 overflow-x-auto">
      {#each realThreads as th (th.id)}
        <button onclick={() => openReal(th.id)} aria-pressed={th.id === realActiveId} class={"shrink-0 rounded-full px-3 py-1 text-xs " + (th.id === realActiveId ? "bg-accent text-white" : "bg-black/5 text-neutral-700 dark:bg-white/10 dark:text-neutral-300")}>{th.display_name || th.address}{#if th.unread > 0}<span class="ml-1">●{th.unread}</span>{/if}</button>
      {/each}
    </div>
    <div class="flex items-center justify-between pb-2">
      <div class="flex min-w-0 items-center gap-2">
        <span class="text-sm font-semibold">{activeRealName}</span>
        <span data-testid="real-sms-badge" class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent">📡 {t("message.realSms")}</span>
      </div>
    </div>
    <div class="flex-1 space-y-2 overflow-auto">
      {#if realMsgs.length === 0}
        <p class="py-10 text-center text-sm opacity-60">{t("message.empty")}</p>
      {:else}
        {#each realMsgs as m, i (m.id + "-" + i)}
          <div role="group" class={"flex items-start gap-1.5 max-w-[86%] " + (m.from_me ? "ml-auto" : "")}>
            <div class={"rounded-2xl px-3 py-2 text-sm " + (m.from_me ? "bg-accent text-white" : "bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-white")}>
              <div class="whitespace-pre-wrap">{m.text}</div>
              <div class="mt-0.5 text-right text-xs tabular-nums opacity-60">{fmtBubbleTime(m.ts_ms)}</div>
            </div>
          </div>
        {/each}
      {/if}
    </div>
    {#if realErr}
      <p class="mt-1 text-xs text-red-500" role="alert">{realErr}</p>
    {/if}
    <div class="mt-2 flex items-center gap-2 pb-1">
      <input bind:value={realText} onkeydown={(e) => e.key === "Enter" && sendReal()} placeholder={t("message.placeholder", { name: activeRealName })} aria-label="real-message-input" class="min-w-0 flex-1 rounded-full bg-black/5 px-3.5 py-2 text-sm outline-none dark:bg-white/10" />
      <button onclick={sendReal} title={t("message.placeholder", { name: activeRealName })} aria-label="send" data-icon="send" class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-white active:scale-90">{@html iconSvg("send", "h-[18px] w-[18px]")}</button>
    </div>
    {/if}
  {:else}
  <!-- Conversation bar: switch threads -->
  <div class="mb-1 flex items-center gap-1.5 overflow-x-auto">
    {#each conversations as c (c.id)}
      <button onclick={() => (activeId = c.id)} aria-pressed={c.id === activeId} class={"shrink-0 rounded-full px-3 py-1 text-xs " + (c.id === activeId ? "bg-accent text-white" : "bg-black/5 text-neutral-700 dark:bg-white/10 dark:text-neutral-300")}>{c.name}{#if unreadCount(c.msgs) > 0}<span class="ml-1">●</span>{/if}</button>
    {/each}
  </div>
  <!-- Always-visible row to start a new contact-thread (local conversations) -->
  <div class="mb-1.5 flex items-center gap-1.5">
    <input bind:value={newName} aria-label="new-contact" onkeydown={(e) => e.key === "Enter" && confirmAdd()} placeholder={t("message.contactPlaceholder")} class="min-w-0 flex-1 rounded-full bg-black/5 px-3 py-1.5 text-sm text-neutral-900 outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:text-white dark:ring-white/10 dark:placeholder:text-white/30" />
    <button onclick={confirmAdd} aria-label="add-contact" title={t("message.addThread")} class="shrink-0 rounded-full bg-accent px-3 py-1.5 text-xs text-white active:scale-95">{t("message.confirm")}</button>
  </div>

  {#if active}
    <div class="flex items-center justify-between pb-2">
      <div class="flex min-w-0 items-center gap-2">
        <span class="text-sm font-semibold">{active.name}</span>
        {#if unreadCount(msgs) > 0}
          <button onclick={() => setMsgs(markAllRead(msgs))} title={t("message.markRead")} class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">{unreadCount(msgs)} {t("message.unread")}</button>
        {/if}
      </div>
      <div class="flex items-center gap-1.5">
        {#if conversations.length > 1}
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
  {/if}
</div>

