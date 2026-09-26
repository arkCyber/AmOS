<script lang="ts">
  // MailApp.svelte — Svelte 5 (runes) single-source implementation of the mail
  // screen. Reads + acts on the amos-mail daemon purely
  // through lib/backend.ts; offline (no bridge)
  // shows a localized banner + empty list. Unread INBOX mail
  // is mirrored into the shared notif store for the dock badge.
  import {
    bridgeDiag,
    bridged,
    mailDelete,
    mailList,
    mailMailboxes,
    mailMove,
    mailRead,
    mailSearch,
    mailSend,
    mailSetAnswered,
    mailSetFlagged,
    mailSetSeen,
    mailStatus,
    type MailAddr,
    type MailMessage,
    type MailStatus,
    type MailSummary,
  } from "../lib/backend";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { iconSvg } from "../lib/sysIcons";
  import { NOTIF_KEY, normalizeNotifs, type Notif } from "../lib/settings";
  import { withoutAppNotifs } from "../lib/notifApp";
  import { bgT } from "./bgText";
  import { t, locale, ALL_LABEL_DICTS } from "./locale.svelte";
  import { mailChannel } from "./appLinks";

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
  // The mailbox names are read **through `t()` at render time**, never cached in a
  // plain object: `t()` is the reactive locale read (`locale.svelte.ts` promises a
  // mounted app re-keys in place on `setLocale()`), and a `const labels = {…t(…)}`
  // is evaluated once when this script body runs — so the chips would keep the
  // mount-time language while the rest of the screen switched. `labelOf` stays a
  // plain function *because* it is called from the markup, where the read is
  // tracked (same shape as `PermissionsApp.svelte`'s `capLabel`).
  const labelOf = (name: string): string =>
    name === "INBOX"
      ? t("mail.inbox")
      : name === "Sent"
        ? t("mail.sent")
        : name === "Archive"
          ? t("mail.archive")
          : name === "Trash"
            ? t("mail.trash")
            : name;

  const online = $derived(bridged());

  let mailboxes = $state<string[]>(["INBOX", "Sent"]);
  let mailbox = $state("INBOX");
  let list = $state<MailSummary[]>([]);
  let loading = $state(false);
  /**
   * Two facts, two states — a *read* that failed and a *composer* that refused.
   *
   * They used to share one `error`. The list region is keyed on it, and the composer writes
   * it too, so a refused 发送 left the sentence in the list slot: cancelling the composer then
   * replaced the whole mailbox listing with 「请填写至少一个收件人」 (measured: `composing =
   * false` at the cancel button never cleared it, and `refresh()` only re-runs when the
   * mailbox changes). Splitting makes it structurally impossible for a composer refusal to
   * render where the listing goes — the same rule `FilesApp`'s `hostListFailed` keeps.
   */
  let listError = $state<string | null>(null);
  /**
   * A read this window was **not entitled to make** and has not yet paid (REQ-A1396 ∕
   * FMEA F-SH-655).
   *
   * The host's four mail reads now go through `require_mail_foreground` — the same rule
   * `clipboard_read`, the SMS reads and the in-call recording toggle follow: only the window
   * the user is looking at may read the mailbox. This screen's reads all happen in its own
   * window, so they happen while it is focused… but an `invoke` is **asynchronous**: if the
   * user switches away between the call and the host running it, the read lands refused. That
   * is not "the mail service is offline" — `listError` used to draw both facts with the same
   * `mail.offline` sentence, which is a false claim about the account. So a refusal sets this
   * bit, and regaining focus pays it — the discipline `MessagesApp`'s `readOwed` keeps.
   */
  let readOwed = $state(false);
  /**
   * The **message** read that is owed, when the one that was refused was a tap on a row
   * (REQ-A1512 ∕ FMEA F-SH-757).
   *
   * `refusalOf` answers a pair precisely because two different reads consume it: `refresh`
   * takes `owed` into `readOwed` and pays it with another `mail_list`; `openMessage` was added
   * later and took only `.text`, so the sentence it drew — 「回到这个窗口时会补上这次读取」 —
   * promised a retry nobody implemented. The promise is kept by re-running **that message's**
   * read on focus, which is what "这次读取" names: not a listing, and not the user's tap again.
   */
  let owedOpen = $state<MailSummary | null>(null);
  /** The composer's own refusal (no recipient / the daemon refused the send). */
  let sendError = $state<string | null>(null);
  let q = $state("");
  let searchList = $state<MailSummary[] | null>(null);

  // Open reader.
  let opened = $state<MailMessage | null>(null);
  /**
   * A reader action the mail service never confirmed (REQ-A830 / F-SH-263, then
   * REQ-A835 / F-SH-265 for the move/delete pair). The reader draws the star / answered
   * / read state from `opened`, so a write we merely *intended* must never be drawn
   * there — see `settleFlag` — and the same goes for closing the reader as if a message
   * had left its mailbox. Shown under the action bar, in the reader, because that is
   * where the wrong picture would be.
   */
  let readerNote = $state("");
  /**
   * The list-level counterpart of `readerNote` (REQ-A835 / F-SH-265). It exists because
   * `markAllRead` lives on the list toolbar, where the reader's note is not on screen —
   * and its failure mode is the quiet one: `refresh()` corrects the rows, so the unread
   * ones simply stay unread and the click looked like a no-op with nothing saying why.
   */
  let listNote = $state("");
  /**
   * A search the mail service never ran (REQ-A836 / F-SH-266). Without it the refused
   * search is indistinguishable from "no matches", because the engine's failure value
   * `null` and its empty result are both coerced by the same `?? []`.
   */
  let searchFailed = $state(false);

  // Compose form.
  let composing = $state(false);
  let to = $state("");
  let subject = $state("");
  let body = $state("");
  let sentId = $state<string | null>(null);
  /**
   * Whether the receipt for `sentId` says the message actually left the device.
   *
   * The receipt carries this rather than the UI inferring it: the offline mock
   * files a copy in `Sent` and delivers nowhere, so printing 「已发送」 off the id
   * alone is a false claim about a real send (F-SH-824). A receipt can never
   * disagree with this — `send()` sets the two together.
   */
  let sentDelivered = $state(false);
  let sending = $state(false);
  /**
   * What the backend can actually deliver, read once on mount. `delivers: false`
   * is the offline mock; the composer says so **before** the user writes anything,
   * so the mock's "sent" line is never the first time they learn it (F-SH-824).
   */
  let mailMode = $state<MailStatus | null>(null);

  /** The host's own code for "the caller is not the window the user is looking at". */
  const FOREGROUND_REQUIRED = "amos.mail.foreground_required";

  /**
   * The nonce of the last deep-link draft consumed (REQ-A1458). The channel is a
   * props bus, and `subscribe` fires the current value on attach, so without this the
   * screen would re-open the previous share's draft on every remount. Same guard
   * `MessagesApp`'s `composeNonce`/`applyCompose` pair keeps.
   */
  let draftNonce = 0;

  /**
   * Prefill the composer from a cross-app hand-off (the share sheet's Mail target).
   *
   * A draft, not a send: `mail_send` is never called here. The channel is consumed
   * (re-set to an empty payload carrying the consumed marker) so a later remount starts
   * clean (REQ-A1499 / F-SH-739) — the same consume step `MessagesApp`'s `applyCompose`
   * and `NotesApp`'s draft branch take. Without it a props channel *is* the stale value
   * (it is a module singleton that outlives every mount), `draftNonce` resets to `0` with
   * the component, and the next attach re-fires the previous share's body into a fresh
   * composer.
   */
  $effect(() => {
    return mailChannel().subscribe((v) => {
      if (!v || v.body.trim() === "" || v.nonce === draftNonce) return;
      draftNonce = v.nonce;
      // Consume before touching the form: `set` notifies synchronously, and the re-entry
      // bails on the empty body, so this cannot loop.
      mailChannel().set({ subject: "", body: "", nonce: draftNonce });
      opened = null;
      composing = true;
      sentId = null;
      sendError = null;
      to = "";
      subject = v.subject;
      body = v.body;
    });
  });

  /**
   * Which fact a `null` from a read carries — three, not one. The read answers one `null` for
   * three different situations, and `listError` drew all of them as `mail.offline`: no bridge
   * at all, a window the user is not looking at (the host's own code, F-SH-655), or the engine
   * refusing a well-formed request. Only the first is "offline", and only the second is worth
   * retrying — so they are told apart by the code the host sent, never by a guess.
   */
  const refusalOf = (command: string): { text: string; owed: boolean } => {
    const diag = bridgeDiag(command);
    if (!diag.ok && diag.kind === "not-bridged") {
      return { text: t("mail.offline"), owed: false };
    }
    const detail = diag.ok === false && diag.kind === "command-failed" ? diag.detail : undefined;
    const code = typeof detail === "object" && detail !== null
      ? (detail as { code?: unknown }).code
      : undefined;
    return code === FOREGROUND_REQUIRED
      ? { text: t("mail.readRefused"), owed: true }
      : { text: t("mail.readFailed"), owed: false };
  };

  const refresh = async (mb: string) => {
    loading = true;
    // Any re-read invalidates the last list-level note — whoever sets one does so from
    // the fresh list, after this returns (REQ-A835 / F-SH-265). An owed message open is the
    // same kind of thing: it names a row of the list being replaced (REQ-A1512).
    listNote = "";
    listError = null;
    owedOpen = null;
    const rows = await mailList(mb);
    list = rows ?? [];
    if (rows === null) {
      const refusal = refusalOf("mail_list");
      listError = refusal.text;
      readOwed = refusal.owed;
    } else {
      // The read landed: nothing is owed any more.
      readOwed = false;
    }
    loading = false;
  };

  $effect(() => {
    if (!bridged()) return;
    let alive = true;
    void (async () => {
      const boxes = await mailMailboxes();
      if (alive && boxes && boxes.length > 0) mailboxes = boxes;
    })();
    void (async () => {
      const s = await mailStatus();
      if (alive) mailMode = s;
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
      searchFailed = false;
      return;
    }
    let alive = true;
    searchList = [];
    searchFailed = false;
    void (async () => {
      const res = await mailSearch(mailbox, term);
      if (!alive) return;
      // `mailSearch` answers `null` both when the engine found nothing and when the
      // command was refused — and the eager `searchList = []` above means the refused
      // case then reaches the empty branch and is drawn as 《没有匹配的邮件》: a claim
      // about the mailbox. It is worse than a generic fold here, because the client
      // filter sitting in the same file (`localFiltered`) *does* match the term, so the
      // screen contradicts data it already holds. `refresh` above never folds (`rows ===
      // null` sets the honest `listError`); the search path had no such test (REQ-A836 /
      // F-SH-266).
      searchFailed = res === null;
      searchList = res ?? [];
    })();
    return () => {
      alive = false;
    };
  });

  // Publish unread INBOX mail as app notifications → dock/launcher badge.
  $effect(() => {
    if (!bridged() || mailbox !== "INBOX") return;
    const others = withoutAppNotifs(
      normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, [])),
      "mail",
      ALL_LABEL_DICTS,
    );
    const fresh: Notif[] = list
      .filter((s) => !s.flags.seen)
      .slice(0, MAIL_NOTIF_CAP)
      .map((s) => ({
        id: `mail:${s.mailbox}:${s.id}`,
        app: bgT("app.mail"),
        icon: "✉️",
        title: s.subject || "—",
        body: s.from ? fmtAddr(s.from) : undefined,
        time: s.date * 1000,
      }));
    writeStoreValue(NOTIF_KEY, [...others, ...fresh]);
  });

  /**
   * Pay the owed read when this window comes back to the foreground (REQ-A1396 ∕ F-SH-655).
   * `window`'s focus/blur are **per WebView** — the unit the host compares — so this is the
   * signal the refusal is about, not a guess at the shell's.
   */
  $effect(() => {
    const onFocus = () => {
      // Read the owed message **before** paying the owed listing: `refresh` clears it (any
      // re-read invalidates a pending open, like the list-level note), and it runs its first
      // lines synchronously.
      const owed = owedOpen;
      owedOpen = null;
      if (readOwed) {
        readOwed = false;
        void refresh(mailbox);
      }
      if (owed) void openMessage(owed);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });

  const openMessage = async (m: MailSummary) => {
    readerNote = "";
    const msg = await mailRead(m.mailbox, m.id);
    if (msg) {
      opened = msg;
      owedOpen = null;
      sentId = null;
    } else {
      // The reader did not open — that is a fact about this tap, and it used to be silent
      // (a refused read drew nothing at all). It goes to the list-level note: the reader is
      // exactly the region that never opened, so a sentence inside it would be drawn nowhere.
      const refusal = refusalOf("mail_read");
      listNote = refusal.text;
      // `refusal.text` promises a retry for the foreground refusal (`mail.readRefused`), so
      // take the `owed` half of the pair and let the focus listener pay it (REQ-A1512).
      owedOpen = refusal.owed ? m : null;
    }
  };
  const closeReader = () => {
    opened = null;
    readerNote = "";
    void refresh(mailbox);
  };
  /** Write one flag into the reader — but only if it is still the same message. */
  const setFlag = (
    mb: string,
    id: string,
    key: "flagged" | "answered" | "seen",
    v: boolean,
  ): void => {
    if (!opened || opened.summary.mailbox !== mb || opened.summary.id !== id) return;
    opened = {
      ...opened,
      summary: { ...opened.summary, flags: { ...opened.summary.flags, [key]: v } },
    };
  };

  /**
   * Settle one boolean flag on the open message — and believe it only when the mail
   * service says so.
   *
   * `mail_set_flagged` / `_answered` / `_seen` are `void` commands: their success
   * value is `null`, and `invoke` answers `null` for a call that failed too — it
   * **never rejects**, it records the reason in the *per-command* diagnosis
   * (REQ-A296). So the reply cannot tell "saved" from "never reached the host", and
   * the verdict is the diagnosis. The three buttons below used to write `opened`
   * from the intent alone, so a star / an answered tick / a "read" the store never
   * accepted was drawn as fact for as long as the reader stayed open — and, for
   * `markUnread`, it also removed the retry button (`{#if …flags.seen}`) that was
   * the user's only way to notice and fix it (REQ-A830 / F-SH-263).
   *
   * `confirmed` is the verdict, **read at the call site next to the command that
   * produced it** — not here. `bridgeDiag` is per-command, so the read has to be
   * adjacent to its own `await`, and a scan can then bind that literal read to that
   * exact write instead of trusting a parameter (REQ-A830).
   */
  async function settleFlag(
    mb: string,
    id: string,
    key: "flagged" | "answered" | "seen",
    next: boolean,
    confirmed: boolean,
  ): Promise<void> {
    readerNote = "";
    if (confirmed) {
      setFlag(mb, id, key, next);
      return;
    }
    // Unconfirmed. Ask the store what is actually true rather than assuming the
    // write landed. This read is `mailList`, **not** `mailRead`: `client.read()`
    // marks the message seen on its way out (`amos-mail/src/client.rs`), so
    // verifying a `markUnread` with it would re-read the very state we were asked
    // to set. The summary listing has no such side effect.
    const rows = await mailList(mb);
    const row = rows?.find((m) => m.id === id);
    if (!row) {
      // Cannot even learn the truth: keep the state we had and say so. The one
      // thing we must not do is draw the value we merely intended.
      readerNote = t("mail.flagUnconfirmed");
      return;
    }
    setFlag(mb, id, key, row.flags[key]);
    if (row.flags[key] !== next) readerNote = t("mail.flagUnconfirmed");
  }

  const toggleFlag = async () => {
    if (!opened) return;
    const { mailbox: mb, id } = opened.summary;
    const next = !opened.summary.flags.flagged;
    await mailSetFlagged(mb, id, next);
    await settleFlag(mb, id, "flagged", next, bridgeDiag("mail_set_flagged").ok);
  };
  const toggleAnswered = async () => {
    if (!opened) return;
    const { mailbox: mb, id } = opened.summary;
    const next = !opened.summary.flags.answered;
    await mailSetAnswered(mb, id, next);
    await settleFlag(mb, id, "answered", next, bridgeDiag("mail_set_answered").ok);
  };
  const markUnread = async () => {
    if (!opened) return;
    const { mailbox: mb, id } = opened.summary;
    await mailSetSeen(mb, id, false);
    await settleFlag(mb, id, "seen", false, bridgeDiag("mail_set_seen").ok);
  };
  const markAllRead = async () => {
    const unread = list.filter((s) => !s.flags.seen).map((s) => s.id);
    if (unread.length === 0) return;
    listNote = "";
    await Promise.all(unread.map((id) => mailSetSeen(mailbox, id, true)));
    await refresh(mailbox);
    // The verdict is read back from the store, **not** from the per-command diagnosis:
    // `bridgeDiag("mail_set_seen")` holds only the *last* call's result, so a batch
    // where some writes landed and others did not would report one of the two as if it
    // spoke for all of them. The fresh list answers the actual question — did every row
    // we asked about come back read — and it is the same source the screen draws from,
    // so the note can never disagree with the rows underneath it (REQ-A835 / F-SH-265).
    const still = list.filter((s) => unread.includes(s.id) && !s.flags.seen).length;
    if (still > 0) listNote = t("mail.actionUnconfirmed");
  };
  const moveOut = async (target: string) => {
    if (!opened) return;
    const { mailbox: mb, id } = opened.summary;
    readerNote = "";
    await mailMove(mb, id, target);
    // `mail_move` is a `void` command too: closing the reader is a claim that the
    // message left this mailbox, and `invoke` cannot tell us whether it did. Only
    // close on the host's own verdict; otherwise stay put and say why, because the
    // `refresh()` below would silently put the message back in the list the user just
    // watched it leave (REQ-A835 / F-SH-265).
    if (!bridgeDiag("mail_move").ok) {
      readerNote = t("mail.actionUnconfirmed");
      void refresh(mailbox);
      return;
    }
    opened = null;
    if (!mailboxes.includes(target)) mailboxes = [...mailboxes, target];
    void refresh(mailbox);
  };
  const deletePermanent = async () => {
    if (!opened) return;
    const { mailbox: mb, id } = opened.summary;
    readerNote = "";
    await mailDelete(mb, id);
    if (!bridgeDiag("mail_delete").ok) {
      readerNote = t("mail.actionUnconfirmed");
      void refresh(mailbox);
      return;
    }
    opened = null;
    void refresh(mailbox);
  };
  const send = async () => {
    const recipients = to
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (recipients.length === 0) {
      sendError = t("mail.needTo");
      return;
    }
    sending = true;
    sendError = null;
    const receipt = await mailSend({ to: recipients, subject, body });
    sending = false;
    if (!receipt) {
      sendError = t("mail.sendFailed");
      return;
    }
    sentId = receipt.id;
    // Read the receipt's own verdict — never assume a stored copy was delivered.
    sentDelivered = receipt.delivered;
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
  {#if sentId}
    <p
      class={"mx-4 mt-2 rounded-xl px-3 py-2 text-xs " +
        (sentDelivered
          ? "bg-green-500/15 text-green-700 dark:text-green-300"
          : "bg-amber-500/15 text-amber-700 dark:text-amber-300")}
      role="status"
      data-testid="mail-sent-note"
    >
      {sentDelivered
        ? t("mail.sentOk", { id: sentId })
        : t("mail.sentStoredOnly", { id: sentId })}
    </p>
  {/if}
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
    {#if readerNote}
      <p class="mx-4 mt-2 text-xs text-danger">{readerNote}</p>
    {/if}
    <div class="mt-3 flex flex-wrap items-center justify-end gap-2 px-4 pb-2">
      {#if opened.summary.mailbox !== "INBOX"}
        <button onclick={() => void moveOut("INBOX")} class="rounded-full bg-accent/10 px-3 py-1 text-xs text-accent">
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
      <button
        onclick={() => void toggleAnswered()}
        aria-pressed={opened.summary.flags.answered}
        class="rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"
      >
        {opened.summary.flags.answered ? "↩ " + t("mail.answered") : "↪ " + t("mail.markAnswered")}
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
        <button onclick={() => void deletePermanent()} class="rounded-full bg-danger/8 px-3 py-1 text-xs text-danger">
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
          // The composer is gone, so its refusal is too — otherwise it would sit in state
          // waiting for the next thing that draws it.
          sendError = null;
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
      {#if mailMode && !mailMode.delivers}
        <p
          class="rounded-xl bg-amber-500/15 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          role="status"
          data-testid="mail-demo-mode"
        >{t("mail.demoMode")}</p>
      {/if}
      {#if sendError}
        <p class="rounded-xl bg-danger/8 px-3 py-2 text-xs">{sendError}</p>
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
          sendError = null;
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
        <button onclick={() => void markAllRead()} class="shrink-0 rounded-full bg-accent/10 px-3 py-1.5 text-xs text-accent">
          {t("mail.markAllRead")}
        </button>
      {/if}
    </div>

    {#if listNote}
      <p class="mx-4 mb-1 text-xs text-danger">{listNote}</p>
    {/if}

    <div class="min-h-0 flex-1 overflow-auto px-4 pb-2">
      {#if loading}
        <p class="py-8 text-center text-sm opacity-50">…</p>
      {:else if listError}
        <p class="py-8 text-center text-sm opacity-60">{listError}</p>
      {:else if searchFailed}
        <p class="py-8 text-center text-sm opacity-60">{t("mail.searchUnconfirmed")}</p>
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



