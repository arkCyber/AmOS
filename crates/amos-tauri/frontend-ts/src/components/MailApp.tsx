import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
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
import { NOTIF_KEY, removeAppNotifs, type Notif } from "../lib/settings";
import { zh } from "../i18n/locales/zh";

/// Unread mail badge cap — one notification per unread INBOX message, so the
/// dock/launcher badge (countForApp) matches how many you haven't read.
const MAIL_NOTIF_CAP = 40;

/** Show an address as its display name when present, else the bare email. */
function fmtAddr(a: MailAddr | null): string {
  if (!a) return "";
  return a.name.trim() !== "" ? a.name : a.email;
}

/** Localized date/time from unix-epoch seconds. */
function fmtDate(sec: number, locale: string): string {
  const d = new Date(sec * 1000);
  return d.toLocaleString(locale.startsWith("zh") ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Offline-capable mail app over the amos-mail bridge (INBOX → read → compose). */
export default function MailApp() {
  const { t, locale } = useI18n();
  const online = bridged();

  const [mailboxes, setMailboxes] = useState<string[]>(["INBOX", "Sent"]);
  const [mailbox, setMailbox] = useState("INBOX");
  const [list, setList] = useState<MailSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  /** Engine search results (null = no active search / not searched yet). */
  const [searchList, setSearchList] = useState<MailSummary[] | null>(null);

  // Open reader.
  const [opened, setOpened] = useState<MailMessage | null>(null);

  // Compose form.
  const [composing, setComposing] = useState(false);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sentId, setSentId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const refresh = useMemo(
    () => async (mb: string) => {
      setLoading(true);
      setError(null);
      const rows = await mailList(mb);
      setList(rows ?? []);
      if (rows === null) setError(t("mail.offline"));
      setLoading(false);
    },
    [t],
  );

  useEffect(() => {
    if (!bridged()) return;
    let alive = true;
    void (async () => {
      const boxes = await mailMailboxes();
      if (alive && boxes && boxes.length > 0) setMailboxes(boxes);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!bridged()) return;
    void refresh(mailbox);
  }, [mailbox, refresh]);

  // Engine-backed search: also matches body text, not just the loaded list.
  useEffect(() => {
    const term = q.trim();
    if (!bridged() || term === "") {
      setSearchList(null);
      return;
    }
    let alive = true;
    setSearchList([]);
    void (async () => {
      const res = await mailSearch(mailbox, term);
      if (alive) setSearchList(res ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [q, mailbox]);

  // Publish unread INBOX mail as app notifications → dock/launcher badge.
  // Re-runs whenever the visible list changes (load, after read/delete/send),
  // replacing this app's notifications with the current unread set.
  useEffect(() => {
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
  }, [list, mailbox]);

  const openMessage = async (m: MailSummary) => {
    const msg = await mailRead(m.mailbox, m.id);
    if (msg) {
      setOpened(msg);
      setSentId(null);
    }
  };

  const closeReader = () => {
    setOpened(null);
    void refresh(mailbox);
  };

  const toggleFlag = async () => {
    if (!opened) return;
    const next = !opened.summary.flags.flagged;
    await mailSetFlagged(opened.summary.mailbox, opened.summary.id, next);
    setOpened({
      ...opened,
      summary: {
        ...opened.summary,
        flags: { ...opened.summary.flags, flagged: next },
      },
    });
  };

  const markUnread = async () => {
    if (!opened) return;
    await mailSetSeen(opened.summary.mailbox, opened.summary.id, false);
    setOpened({
      ...opened,
      summary: {
        ...opened.summary,
        flags: { ...opened.summary.flags, seen: false },
      },
    });
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
    setOpened(null);
    // Make sure the destination folder chip is available even before a refetch.
    setMailboxes((prev) => (prev.includes(target) ? prev : [...prev, target]));
    void refresh(mailbox);
  };

  const deletePermanent = async () => {
    if (!opened) return;
    await mailDelete(opened.summary.mailbox, opened.summary.id);
    setOpened(null);
    void refresh(mailbox);
  };

  const send = async () => {
    const recipients = to
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (recipients.length === 0) {
      setError(t("mail.needTo"));
      return;
    }
    setSending(true);
    setError(null);
    const receipt = await mailSend({ to: recipients, subject, body });
    setSending(false);
    if (!receipt) {
      setError(t("mail.sendFailed"));
      return;
    }
    setSentId(receipt.id);
    setTo("");
    setSubject("");
    setBody("");
    setComposing(false);
    setMailbox("Sent"); // the [mailbox] effect reloads the Sent list
  };

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

  // ---- reader view ------------------------------------------------------
  if (opened) {
    const s = opened.summary;
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between px-4 py-2">
          <button
            onClick={closeReader}
            className="rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"
          >
            ‹ {t("mail.back")}
          </button>
          <span className="text-xs opacity-60">
            {labelOf(s.mailbox)}
          </span>
        </div>
        <div className="mx-4 rounded-2xl bg-white/70 p-4 shadow-sm ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10">
          <h2 className="text-base font-semibold">{s.subject || "—"}</h2>
          <div className="mt-1 text-xs opacity-70">
            <div>
              {t("mail.from")}: {fmtAddr(s.from)} · {fmtDate(s.date, locale)}
            </div>
            {s.to.length > 0 && (
              <div>
                {t("mail.to")}: {s.to.map(fmtAddr).join(", ")}
              </div>
            )}
          </div>
        </div>
        {opened.attachments.length > 0 && (
          <div className="mx-4 mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {opened.attachments.map((a) => (
              <span
                key={a.id}
                className="rounded-full bg-neutral-200 px-2 py-0.5 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
              >
                📎 {a.filename} ({a.mime})
              </span>
            ))}
          </div>
        )}
        <div className="mx-4 mt-3 whitespace-pre-wrap rounded-2xl bg-neutral-200/40 p-3 text-sm leading-relaxed dark:bg-neutral-800/40">
          {opened.body_plain || "—"}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2 px-4 pb-2">
          {opened.summary.mailbox !== "INBOX" && (
            <button
              onClick={() => void moveOut("INBOX")}
              className="rounded-full bg-accent/15 px-3 py-1 text-xs text-accent"
            >
              ⇦ {t("mail.restore")}
            </button>
          )}
          <button
            onClick={() => void toggleFlag()}
            aria-pressed={opened.summary.flags.flagged}
            className="rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"
          >
            {opened.summary.flags.flagged ? "★ " + t("mail.unstar") : "☆ " + t("mail.star")}
          </button>
          {opened.summary.flags.seen && (
            <button
              onClick={() => void markUnread()}
              className="rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"
            >
              {t("mail.markUnread")}
            </button>
          )}
          {opened.summary.mailbox !== "Archive" && (
            <button
              onClick={() => void moveOut("Archive")}
              className="rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"
            >
              🗂 {t("mail.archive")}
            </button>
          )}
          {opened.summary.mailbox !== "Trash" && (
            <button
              onClick={() => void moveOut("Trash")}
              className="rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"
            >
              🗑 {t("mail.trash")}
            </button>
          )}
          {opened.summary.mailbox === "Trash" && (
            <button
              onClick={() => void deletePermanent()}
              className="rounded-full bg-danger/15 px-3 py-1 text-xs text-danger"
            >
              {t("mail.delete")}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ---- compose view ------------------------------------------------------
  if (composing) {
    const field =
      "w-full rounded-xl bg-black/5 px-3 py-2 text-sm outline-none ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10";
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between px-4 py-2">
          <button
            onClick={() => {
              setComposing(false);
              setSentId(null);
            }}
            className="rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"
          >
            {t("mail.cancel")}
          </button>
          <span className="text-xs font-semibold">✉️ {t("mail.new")}</span>
          <button
            onClick={() => void send()}
            disabled={sending}
            className="rounded-full bg-accent px-4 py-1 text-xs text-white disabled:opacity-50"
          >
            {t("mail.send")}
          </button>
        </div>
        <div className="space-y-2 px-4 pt-1">
          {sentId && (
            <p className="rounded-xl bg-green-500/15 px-3 py-2 text-xs text-green-700 dark:text-green-300">
              {t("mail.sentOk", { id: sentId })}
            </p>
          )}
          {error && <p className="rounded-xl bg-danger/15 px-3 py-2 text-xs">{error}</p>}
          <input
            className={field}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder={t("mail.toPlaceholder")}
          />
          <input
            className={field}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={t("mail.subject")}
          />
          <textarea
            className={field + " min-h-[160px] resize-none"}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("mail.body")}
          />
        </div>
      </div>
    );
  }


  // Search: engine results when bridged (matches subject/sender/body), else a
  // client-side subject/sender filter over the loaded mailbox.
  const term = q.trim();
  const termLower = term.toLowerCase();
  const localFiltered = termLower
    ? list.filter(
        (s) =>
          s.subject.toLowerCase().includes(termLower) ||
          (s.from ? `${s.from.name} ${s.from.email}`.toLowerCase().includes(termLower) : false),
      )
    : list;
  const shown = term && bridged() ? searchList ?? [] : localFiltered;
  const hasUnread = list.some((s) => !s.flags.seen);

  // ---- list view ---------------------------------------------------------
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex gap-1.5">
          {mailboxes.map((m) => (
            <button
              key={m}
              onClick={() => setMailbox(m)}
              aria-pressed={m === mailbox}
              className={
                "rounded-full px-3 py-1 text-xs " +
                (m === mailbox ? "bg-accent text-white" : "bg-neutral-200 dark:bg-neutral-700")
              }
            >
              {labelOf(m)}
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            setComposing(true);
            setSentId(null);
            setError(null);
          }}
          className="rounded-full bg-accent px-3 py-1 text-xs text-white"
        >
          ✏️ {t("mail.compose")}
        </button>
      </div>

      {!online && (
        <p className="mx-4 mb-1 rounded-xl bg-neutral-200/60 px-3 py-2 text-xs opacity-70 dark:bg-neutral-800/60">
          {t("mail.offline")}
        </p>
      )}

      <div className="flex items-center gap-2 px-4 pb-1">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("mail.search")}
          aria-label={t("mail.search")}
          className="min-w-0 flex-1 rounded-full bg-neutral-200/70 px-3.5 py-1.5 text-sm outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:ring-white/10 dark:placeholder:text-white/30"
        />
        {hasUnread && (
          <button
            onClick={() => void markAllRead()}
            className="shrink-0 rounded-full bg-accent/15 px-3 py-1.5 text-xs text-accent"
          >
            {t("mail.markAllRead")}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-2">
        {loading ? (
          <p className="py-8 text-center text-sm opacity-50">…</p>
        ) : error ? (
          <p className="py-8 text-center text-sm opacity-60">{error}</p>
        ) : shown.length === 0 ? (
          <p className="py-8 text-center text-sm opacity-50">
            {list.length === 0
              ? `${labelOf(mailbox)}: ${t("mail.empty")}`
              : t("mail.noMatch")}
          </p>
        ) : (
          shown.map((m) => (
            <button
              key={m.id}
              onClick={() => void openMessage(m)}
              className="mb-1.5 flex w-full items-start gap-3 rounded-2xl bg-white/60 px-3 py-2 text-left shadow-sm ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10"
            >
              <span className="mt-0.5 w-7 shrink-0 text-center text-sm">
                {!m.flags.seen ? "🔵" : m.flags.flagged ? "★" : "•"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={"truncate text-sm " + (!m.flags.seen ? "font-semibold" : "")}>
                    {fmtAddr(m.from) || "—"}
                  </span>
                  <span className="shrink-0 text-[10px] opacity-50">
                    {fmtDate(m.date, locale)}
                  </span>
                </span>
                <span className="block truncate text-sm opacity-80">{m.subject || "—"}</span>
                {m.attachment_count > 0 && (
                  <span className="text-[10px] opacity-50">📎 {m.attachment_count}</span>
                )}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

