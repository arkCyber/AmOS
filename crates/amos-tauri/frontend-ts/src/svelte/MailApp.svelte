<script lang="ts">
  // MailApp.svelte — Svelte 5 (runes) single-source implementation of the mail
  // screen. Reads + acts on the amos-mail daemon purely
  // through lib/backend.ts; offline (no bridge)
  // shows a localized banner + empty list. Unread INBOX mail
  // is mirrored into the shared notif store for the dock badge.
  import {
    bridged,
    mailDelete,
    mailList,
    mailMailboxes,
    mailMove,
    mailRead,
    mailSearch,
    mailSend,
    mailSetFlagged,
    mailSetSeen,
    type MailAddr,
    type MailMessage,
    type MailSummary,
  } from "../lib/backend";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { iconSvg } from "../lib/sysIcons";
  import { NOTIF_KEY, removeAppNotifs, type Notif } from "../lib/settings";
  import { zh } from "../i18n/locales/zh";
  import { t, locale } from "./locale.svelte";

  const MAIL_NOTIF_CAP = 40;

  function fmtAddr(a: MailAddr | null): string {
    if (!a) return "";
    return a.name.trim() !== "" ? a.name : a.email;
  }
  function fmtDate(sec: number, loc: string): string {
    const d = new Date(sec * 1000);
    return d.toLocaleString(loc.startsWith("zh") ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  const labels = {
    inbox: t("mail.inbox"),
    sent: t("mail.sent"),
    archive: t("mail.archive"),
    trash: t("mail.trash"),
  };
  const labelOf = (name: string): string =>
    name === "INBOX"
      ? labels.inbox
      : name === "Sent"
        ? labels.sent
        : name === "Archive"
          ? labels.archive
          : name === "Trash"
            ? labels.trash
            : name;

  const online = $derived(bridged());

  let mailboxes = $state<string[]>(["INBOX", "Sent"]);
  let mailbox = $state("INBOX");
  let list = $state<MailSummary[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let q = $state("");
  let searchList = $state<MailSummary[] | null>(null);

  // Open reader.
  let opened = $state<MailMessage | null>(null);

  // Compose form.
  let composing = $state(false);
  let to = $state("");
  let subject = $state("");
  let body = $state("");
  let sentId = $state<string | null>(null);
  let sending = $state(false);

  const refresh = async (mb: string) => {
    loading = true;
    error = null;
    const rows = await mailList(mb);
    list = rows ?? [];
    if (rows === null) error = t("mail.offline");
    loading = false;
  };

  $effect(() => {
    if (!bridged()) return;
    let alive = true;
    void (async () => {
      const boxes = await mailMailboxes();
      if (alive && boxes && boxes.length > 0) mailboxes = boxes;
    })();
    return () => {
      alive = false;
    };
  });

  $effect(() => {
    const mb = mailbox;
    if (!bridged()) return;
    void refresh(mb);
  });

  // Engine-backed search (also matches body text), else client filter below.
  $effect(() => {
    const term = q.trim();
    if (!bridged() || term === "") {
      searchList = null;
      return;
    }
    let alive = true;
    searchList = [];
    void (async () => {
      const res = await mailSearch(mailbox, term);
      if (alive) searchList = res ?? [];
    })();
    return () => {
      alive = false;
    };
  });

  // Publish unread INBOX mail as app notifications → dock/launcher badge.
  $effect(() => {
    if (!bridged() || mailbox !== "INBOX") return;
    const others = removeAppNotifs(readStoreValue<Notif[]>(NOTIF_KEY, []), zh["app.mail"]);
    const fresh: Notif[] = list
      .filter((s) => !s.flags.seen)
      .slice(0, MAIL_NOTIF_CAP)
      .map((s) => ({
        id: `mail:${s.mailbox}:${s.id}`,
        app: zh["app.mail"],
        icon: "✉️",
        title: s.subject || "—",
        body: s.from ? fmtAddr(s.from) : undefined,
        time: s.date * 1000,
      }));
    writeStoreValue(NOTIF_KEY, [...others, ...fresh]);
  });

  const openMessage = async (m: MailSummary) => {
    const msg = await mailRead(m.mailbox, m.id);
    if (msg) {
      opened = msg;
      sentId = null;
    }
  };
  const closeReader = () => {
    opened = null;
    void refresh(mailbox);
  };
  const toggleFlag = async () => {
    if (!opened) return;
    const next = !opened.summary.flags.flagged;
    await mailSetFlagged(opened.summary.mailbox, opened.summary.id, next);
    opened = {
      ...opened,
      summary: { ...opened.summary, flags: { ...opened.summary.flags, flagged: next } },
    };
  };
  const markUnread = async () => {
    if (!opened) return;
    await mailSetSeen(opened.summary.mailbox, opened.summary.id, false);
    opened = {
      ...opened,
      summary: { ...opened.summary, flags: { ...opened.summary.flags, seen: false } },
    };
  };
  const markAllRead = async () => {
    const unread = list.filter((s) => !s.flags.seen).map((s) => s.id);
    if (unread.length === 0) return;
    await Promise.all(unread.map((id) => mailSetSeen(mailbox, id, true)));
    void refresh(mailbox);
  };
  const moveOut = async (target: string) => {
    if (!opened) return;
    await mailMove(opened.summary.mailbox, opened.summary.id, target);
    opened = null;
    if (!mailboxes.includes(target)) mailboxes = [...mailboxes, target];
    void refresh(mailbox);
  };
  const deletePermanent = async () => {
    if (!opened) return;
    await mailDelete(opened.summary.mailbox, opened.summary.id);
    opened = null;
    void refresh(mailbox);
  };
  const send = async () => {
    const recipients = to
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (recipients.length === 0) {
      error = t("mail.needTo");
      return;
    }
    sending = true;
    error = null;
    const receipt = await mailSend({ to: recipients, subject, body });
    sending = false;
    if (!receipt) {
      error = t("mail.sendFailed");
      return;
    }
    sentId = receipt.id;
    to = "";
    subject = "";
    body = "";
    composing = false;
    mailbox = "Sent"; // the [mailbox] effect reloads the Sent list
  };

  // Client-side subject/sender filter over the loaded mailbox (offline search).
  const termLower = $derived(q.trim().toLowerCase());
  const localFiltered = $derived(
    termLower
      ? list.filter(
          (s) =>
            s.subject.toLowerCase().includes(termLower) ||
            (s.from
              ? `${s.from.name} ${s.from.email}`.toLowerCase().includes(termLower)
              : false),
        )
      : list,
  );
  const term = $derived(q.trim());
  const shown = $derived(term && bridged() ? searchList ?? [] : localFiltered);
  const hasUnread = $derived(list.some((s) => !s.flags.seen));
  const loc = $derived(locale());
</script>

<div class="flex h-full flex-col">
  {#if opened}
    <div class="flex items-center justify-between px-4 py-2">
      <button onclick={closeReader} class="rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700">
        ‹ {t("mail.back")}
      </button>
      <span class="text-xs opacity-60">{labelOf(opened.summary.mailbox)}</span>
    </div>
    <div class="mx-4 rounded-2xl bg-white/70 p-4 shadow-sm ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10">
      <h2 class="text-base font-semibold">{opened.summary.subject || "—"}</h2>
      <div class="mt-1 text-xs opacity-70">
        <div>
          {t("mail.from")}: {fmtAddr(opened.summary.from)} · {fmtDate(opened.summary.date, loc)}
        </div>
        {#if opened.summary.to.length > 0}
          <div>
            {t("mail.to")}: {opened.summary.to.map(fmtAddr).join(", ")}
          </div>
        {/if}
      </div>
    </div>
    {#if opened.attachments.length > 0}
      <div class="mx-4 mt-2 flex flex-wrap gap-1.5 text-[11px]">
        {#each opened.attachments as a (a.id)}
          <span class="rounded-full bg-neutral-200 px-2 py-0.5 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
            📎 {a.filename} ({a.mime})
          </span>
        {/each}
      </div>
    {/if}
    <div class="mx-4 mt-3 whitespace-pre-wrap rounded-2xl bg-neutral-200/40 p-3 text-sm leading-relaxed dark:bg-neutral-800/40">
      {opened.body_plain || "—"}
    </div>
    <div class="mt-3 flex flex-wrap items-center justify-end gap-2 px-4 pb-2">
      {#if opened.summary.mailbox !== "INBOX"}
        <button onclick={() => void moveOut("INBOX")} class="rounded-full bg-accent/15 px-3 py-1 text-xs text-accent">
          ⇦ {t("mail.restore")}
        </button>
      {/if}
      <button
        onclick={() => void toggleFlag()}
        aria-pressed={opened.summary.flags.flagged}
        class="rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"
      >
        {opened.summary.flags.flagged ? "★ " + t("mail.unstar") : "☆ " + t("mail.star")}
      </button>
      {#if opened.summary.flags.seen}
        <button onclick={() => void markUnread()} class="rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700">
          {t("mail.markUnread")}
        </button>
      {/if}
      {#if opened.summary.mailbox !== "Archive"}
        <button onclick={() => void moveOut("Archive")} class="inline-flex items-center gap-1 rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700">
          <span data-icon="archive">{@html iconSvg("archive", "h-3 w-3")}</span> {t("mail.archive")}
        </button>
      {/if}
      {#if opened.summary.mailbox !== "Trash"}
        <button onclick={() => void moveOut("Trash")} class="inline-flex items-center gap-1 rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700">
          <span data-icon="trash">{@html iconSvg("trash", "h-3 w-3")}</span> {t("mail.trash")}
        </button>
      {/if}
      {#if opened.summary.mailbox === "Trash"}
        <button onclick={() => void deletePermanent()} class="rounded-full bg-danger/15 px-3 py-1 text-xs text-danger">
          {t("mail.delete")}
        </button>
      {/if}
    </div>
  {:else if composing}
    <div class="flex items-center justify-between px-4 py-2">
      <button
        onclick={() => {
          composing = false;
          sentId = null;
        }}
        class="rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"
      >
        {t("mail.cancel")}
      </button>
      <span class="text-xs font-semibold">✉️ {t("mail.new")}</span>
      <button onclick={() => void send()} disabled={sending} class="rounded-full bg-accent px-4 py-1 text-xs text-white disabled:opacity-50">
        {t("mail.send")}
      </button>
    </div>
    <div class="space-y-2 px-4 pt-1">
      {#if sentId}
        <p class="rounded-xl bg-green-500/15 px-3 py-2 text-xs text-green-700 dark:text-green-300">
          {t("mail.sentOk", { id: sentId })}
        </p>
      {/if}
      {#if error}
        <p class="rounded-xl bg-danger/15 px-3 py-2 text-xs">{error}</p>
      {/if}
      <input
        bind:value={to}
        placeholder={t("mail.toPlaceholder")}
        class="w-full rounded-xl bg-black/5 px-3 py-2 text-sm outline-none ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10"
      />
      <input
        bind:value={subject}
        placeholder={t("mail.subject")}
        class="w-full rounded-xl bg-black/5 px-3 py-2 text-sm outline-none ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10"
      />
      <textarea
        bind:value={body}
        placeholder={t("mail.body")}
        class="min-h-[160px] w-full resize-none rounded-xl bg-black/5 px-3 py-2 text-sm outline-none ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10"
      ></textarea>
    </div>
  {:else}
    <div class="flex items-center justify-between px-4 py-2">
      <div class="flex gap-1.5">
        {#each mailboxes as m (m)}
          <button
            onclick={() => (mailbox = m)}
            aria-pressed={m === mailbox}
            class={"rounded-full px-3 py-1 text-xs " +
              (m === mailbox ? "bg-accent text-white" : "bg-neutral-200 dark:bg-neutral-700")}
          >
            {labelOf(m)}
          </button>
        {/each}
      </div>
      <button
        onclick={() => {
          composing = true;
          sentId = null;
          error = null;
        }}
        class="inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1 text-xs text-white"
      >
        <span data-icon="pencil">{@html iconSvg("pencil", "h-3 w-3")}</span> {t("mail.compose")}
      </button>
    </div>

    {#if !online}
      <p class="mx-4 mb-1 rounded-xl bg-neutral-200/60 px-3 py-2 text-xs opacity-70 dark:bg-neutral-800/60">
        {t("mail.offline")}
      </p>
    {/if}

    <div class="flex items-center gap-2 px-4 pb-1">
      <input
        bind:value={q}
        placeholder={t("mail.search")}
        aria-label={t("mail.search")}
        class="min-w-0 flex-1 rounded-full bg-neutral-200/70 px-3.5 py-1.5 text-sm outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:ring-white/10 dark:placeholder:text-white/30"
      />
      {#if hasUnread}
        <button onclick={() => void markAllRead()} class="shrink-0 rounded-full bg-accent/15 px-3 py-1.5 text-xs text-accent">
          {t("mail.markAllRead")}
        </button>
      {/if}
    </div>

    <div class="min-h-0 flex-1 overflow-auto px-4 pb-2">
      {#if loading}
        <p class="py-8 text-center text-sm opacity-50">…</p>
      {:else if error}
        <p class="py-8 text-center text-sm opacity-60">{error}</p>
      {:else if shown.length === 0}
        <p class="py-8 text-center text-sm opacity-50">
          {list.length === 0 ? `${labelOf(mailbox)}: ${t("mail.empty")}` : t("mail.noMatch")}
        </p>
      {:else}
        {#each shown as m (m.id)}
          <button
            onclick={() => void openMessage(m)}
            class="mb-1.5 flex w-full items-start gap-3 rounded-2xl bg-white/60 px-3 py-2 text-left shadow-sm ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10"
          >
            <span class="mt-0.5 w-7 shrink-0 text-center text-sm">
              {!m.flags.seen ? "🔵" : m.flags.flagged ? "★" : "•"}
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-baseline justify-between gap-2">
                <span class={"truncate text-sm " + (!m.flags.seen ? "font-semibold" : "")}>
                  {fmtAddr(m.from) || "—"}
                </span>
                <span class="shrink-0 text-[10px] opacity-50">
                  {fmtDate(m.date, loc)}
                </span>
              </span>
              <span class="block truncate text-sm opacity-80">{m.subject || "—"}</span>
              {#if m.attachment_count > 0}
                <span class="text-[10px] opacity-50">📎 {m.attachment_count}</span>
              {/if}
            </span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>



