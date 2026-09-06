<script lang="ts">
  // MessagesApp.svelte — Svelte 5 (runes) port of the React MessagesApp in
  // src/components/CommsApps.tsx. All message logic reuses pure lib/messages.ts;
  // unread → notification sync mirrors the React effect via $effect; swipe-to-
  // delete uses the same threshold. Store key: amos.messages.
  import {
    MSG_KEY,
    appendMessage,
    appendQuote,
    clearMessages,
    fmtBubbleTime,
    isNewDay,
    markAllRead,
    messageDayLabel,
    normalizeMessages,
    removeMessageAt,
    seedMessages,
    unreadCount,
  } from "../lib/messages";
  import type { Msg } from "../lib/messages";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { NOTIF_KEY, removeAppNotifs } from "../lib/settings";
  import type { Notif } from "../lib/settings";
  import { zh } from "../i18n/locales/zh";
  import { t } from "./locale.svelte";

  const CONTACT = "小安";

  const seeded = ((): Msg[] => {
    const l = normalizeMessages(readStoreValue<unknown>(MSG_KEY, []));
    if (l.length) return l;
    const s = seedMessages(Date.now());
    writeStoreValue(MSG_KEY, s);
    return s;
  })();
  let msgs = $state<Msg[]>(seeded);
  let text = $state("");
  let replyTo = $state<string | null>(null);

  const persist = (l: Msg[]) => {
    const capped = normalizeMessages(l);
    writeStoreValue(MSG_KEY, capped);
    msgs = capped;
  };

  // Publish unread incoming messages as app notifications (dock badge + NC).
  $effect(() => {
    const app = zh["app.messages"];
    const existing = readStoreValue<Notif[]>(NOTIF_KEY, []);
    const hadAppNotifs = existing.some((n) => n.app === app);
    const unread = msgs.filter((m) => m.from === "them" && !m.read).slice(0, 20);
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
    if (!v) return;
    if (replyTo) {
      persist(appendQuote(markAllRead(msgs), v, replyTo, Date.now()));
      replyTo = null;
    } else {
      persist(appendMessage(markAllRead(msgs), v, Date.now()));
    }
    text = "";
  };
  const clear = () => {
    text = "";
    persist(clearMessages());
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
    if (s.x - x > 50) persist(removeMessageAt(msgs, s.i));
  };

  const dayLabelOf = (ts: number): string => {
    const dl = messageDayLabel(ts, Date.now());
    return dl === "today" ? t("message.today") : dl === "yesterday" ? t("message.yesterday") : dl;
  };
</script>

<div class="flex h-full flex-col p-3">
  <div class="flex items-center justify-between pb-2">
    <div class="flex min-w-0 items-center gap-2">
      <span class="text-sm font-semibold">{CONTACT}</span>
      {#if unreadCount(msgs) > 0}
        <button onclick={() => persist(markAllRead(msgs))} title={t("message.markRead")}
          class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">● {unreadCount(msgs)} {t("message.unread")}</button>
      {/if}
    </div>
    <button onclick={clear} disabled={msgs.length === 0} aria-label={t("message.clear")}
      class="rounded-full bg-neutral-200 px-3 py-1 text-xs disabled:opacity-40 dark:bg-neutral-700">🗑 {t("message.clear")}</button>
  </div>

  <div class="flex-1 space-y-2 overflow-auto">
    {#if msgs.length === 0}
      <p class="py-10 text-center text-sm opacity-60">{t("message.empty")}</p>
    {:else}
      {#each msgs as m, i (m.ts + "-" + i)}
        {@const prev = msgs[i - 1]}
        {@const showDay = !prev || isNewDay(prev.ts, m.ts)}
        {#if showDay}
          <p class="py-1 text-center text-xs uppercase tracking-wider text-neutral-500 dark:text-neutral-400">{dayLabelOf(m.ts)}</p>
        {/if}
        <div
          role="group"
          class={"group flex items-start gap-1.5 max-w-[86%] " + (m.from === "me" ? "ml-auto" : "")}
          ontouchstart={(e) => onSwipeStart(e, i)}
          ontouchend={onSwipeEnd}
        >
          <div
            class={"rounded-2xl px-3 py-2 text-sm " +
              (m.from === "me" ? "bg-accent text-white" : "bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-white")}>
            {#if m.quote}
              <div class={"mb-1 rounded-md px-1.5 py-0.5 text-xs leading-snug opacity-70 " +
                (m.from === "me" ? "bg-white/20" : "bg-black/5 dark:bg-white/10")}>↩ {m.quote}</div>
            {/if}
            <div class="whitespace-pre-wrap">{m.text}</div>
            <div class="mt-0.5 text-right text-xs tabular-nums opacity-60">{fmtBubbleTime(m.ts)}</div>
          </div>
          <button onclick={() => (replyTo = m.text)} aria-label={t("message.reply")} title={t("message.reply")}
            class="mt-1 shrink-0 rounded-full px-1 text-xs leading-none opacity-0 transition-opacity group-hover:opacity-60">↩</button>
          <button onclick={() => persist(removeMessageAt(msgs, i))} aria-label={t("message.remove")} title={t("message.remove")}
            class="mt-1 shrink-0 rounded-full px-1 text-xs leading-none opacity-0 transition-opacity group-hover:opacity-60">✕</button>
        </div>
      {/each}
    {/if}
  </div>

  {#if replyTo}
    <div class="mt-1 flex items-center justify-between gap-2 rounded-lg bg-accent/10 px-2 py-1 text-xs">
      <span class="min-w-0 truncate text-accent">↩ {t("message.replying")}: {replyTo}</span>
      <button onclick={() => (replyTo = null)} aria-label={t("message.replyClear")} class="shrink-0 px-1 text-accent">✕</button>
    </div>
  {/if}

  <div class="mt-2 flex items-center gap-2 pb-1">
    <div class="flex min-w-0 flex-1 items-center rounded-full bg-black/5 px-3.5 py-2 ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10">
      <input
        bind:value={text}
        onkeydown={(e) => e.key === "Enter" && send()}
        placeholder={t("message.placeholder", { name: CONTACT })}
        aria-label="message-input"
        class="min-w-0 flex-1 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-black/30 dark:text-white dark:placeholder:text-white/30"
      />
    </div>
    <button onclick={send} title={t("message.placeholder", { name: CONTACT })} aria-label="send"
      class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-white shadow-[0_4px_12px_rgba(0,122,255,0.35)] transition active:scale-90">➤</button>
  </div>
</div>

