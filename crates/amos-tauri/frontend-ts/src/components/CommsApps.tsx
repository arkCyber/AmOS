import { Fragment, useEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from "react";
import { useI18n } from "../i18n";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import {
  MSG_KEY,
  appendMessage,
  appendQuote,
  clearMessages,
  fmtBubbleTime,
  isNewDay,
  messageDayLabel,
  normalizeMessages,
  removeMessageAt,
  unreadCount,
  markAllRead,
  markRead,
  seedMessages,
  type Msg,
} from "../lib/messages";
import { MUSIC_KEY, nextIndexAfterRemoval, nextIndex, normalizeTracks, pctProgress, removeTrack, seekSeconds, seedTracks, stepIndex, DEMO_LYRICS, lyricIndex, type RepeatMode, type Track } from "../lib/music";
import { NOTIF_KEY, removeAppNotifs, type Notif } from "../lib/settings";
import { zh } from "../i18n/locales/zh";

// The full-featured dialer now lives in its own module; re-exported here so existing
// callers (apps.tsx, tests) that import { PhoneApp } from CommsApps keep working.
export { PhoneApp } from "./PhoneDialer";

const DURATION = 24; // demo seconds per track


/* ---- Messages (persisted amos.messages) ---- */
export function MessagesApp() {
  const { t } = useI18n();
  const CONTACT = "小安";
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    const l = normalizeMessages(readStoreValue<unknown>(MSG_KEY, []));
    if (l.length) return l;
    const s = seedMessages(Date.now());
    writeStoreValue(MSG_KEY, s);
    return s;
  });
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const persist = (l: Msg[]) => {
    // Write through the normalizer so every save is cleaned + bounded (MESSAGE_CAP).
    const capped = normalizeMessages(l);
    writeStoreValue(MSG_KEY, capped);
    setMsgs(capped);
  };

  // Publish unread incoming messages as app notifications → dock "信息" badge +
  // notification center (kept in sync as the user reads/clears). Mirrors MailApp.
  useEffect(() => {
    const app = zh["app.messages"];
    const existing = readStoreValue<Notif[]>(NOTIF_KEY, []);
    const hadAppNotifs = existing.some((n) => n.app === app);
    const unread = msgs.filter((m) => m.from === "them" && !m.read).slice(0, 20);
    if (unread.length === 0 && !hadAppNotifs) return; // nothing to publish/remove
    const others = removeAppNotifs(existing, app);
    const fresh: Notif[] = unread.map((m, i) => ({
      id: `msg:${i}:${m.ts}`,
      app,
      icon: "💬",
      title: m.text.length > 40 ? `${m.text.slice(0, 40)}…` : m.text,
      time: m.ts,
    }));
    writeStoreValue(NOTIF_KEY, [...others, ...fresh]);
  }, [msgs]);

  const send = () => {
    const v = text.trim();
    if (!v) return;
    if (replyTo) {
      persist(appendQuote(markAllRead(msgs), v, replyTo, Date.now()));
      setReplyTo(null);
    } else {
      persist(appendMessage(markAllRead(msgs), v, Date.now())); // reading clears incoming
    }
    setText("");
  };
  const clear = () => {
    setText("");
    persist(clearMessages());
  };
  // iOS-style: swipe left on a message to delete that single message.
  const swipeRef = useRef<{ x: number; i: number } | null>(null);
  const onSwipeStart = (e: ReactTouchEvent<HTMLDivElement>, i: number) => {
    const x = e.touches[0]?.clientX;
    if (x != null) swipeRef.current = { x, i };
  };
  const onSwipeEnd = (e: ReactTouchEvent<HTMLDivElement>) => {
    const s = swipeRef.current;
    swipeRef.current = null;
    if (!s) return;
    const x = e.changedTouches[0]?.clientX;
    if (x == null) return;
    if (s.x - x > 50) persist(removeMessageAt(msgs, s.i)); // left swipe deletes
  };
  return (
    <div className="flex h-full flex-col p-3">
      <div className="flex items-center justify-between pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-semibold">{CONTACT}</span>
          {unreadCount(msgs) > 0 && (
            <button
              onClick={() => persist(markAllRead(msgs))}
              title={t("message.markRead")}
              className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent"
            >
              ● {unreadCount(msgs)} {t("message.unread")}
            </button>
          )}
        </div>
        <button
          onClick={clear}
          disabled={msgs.length === 0}
          aria-label={t("message.clear")}
          className="rounded-full bg-neutral-200 px-3 py-1 text-[11px] disabled:opacity-40 dark:bg-neutral-700"
        >
          🗑 {t("message.clear")}
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-auto">
        {msgs.length === 0 ? (
          <p className="py-10 text-center text-sm opacity-60">{t("message.empty")}</p>
        ) : (
          msgs.map((m, i) => {
            const prev = msgs[i - 1];
            const showDay = !prev || isNewDay(prev.ts, m.ts);
            const dl = messageDayLabel(m.ts, Date.now());
            const dayText =
              dl === "today" ? t("message.today") : dl === "yesterday" ? t("message.yesterday") : dl;
            return (
              <Fragment key={i}>
                {showDay && (
                  <p className="py-1 text-center text-[10px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    {dayText}
                  </p>
                )}
                <div
                  className={
                    "group flex items-start gap-1.5 " + (m.from === "me" ? "ml-auto" : "") +
                    " max-w-[86%]"
                  }
                  onTouchStart={(e) => onSwipeStart(e, i)}
                  onTouchEnd={onSwipeEnd}
                  onClick={m.from === "them" && !m.read ? () => persist(markRead(msgs, i)) : undefined}
                >
                  <div
                    className={
                      "rounded-2xl px-3 py-2 text-sm " +
                      (m.from === "me"
                        ? "bg-accent text-white"
                        : "bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-white")
                    }
                  >
                    {m.quote && (
                      <div
                        className={
                          "mb-1 rounded-md px-1.5 py-0.5 text-[11px] leading-snug opacity-70 " +
                          (m.from === "me" ? "bg-white/20" : "bg-black/5 dark:bg-white/10")
                        }
                      >
                        ↩ {m.quote}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap">{m.text}</div>
                    <div className="mt-0.5 text-right text-[9px] tabular-nums opacity-60">
                      {fmtBubbleTime(m.ts)}
                    </div>
                  </div>
                  <button
                    onClick={() => setReplyTo(m.text)}
                    aria-label={t("message.reply")}
                    title={t("message.reply")}
                    className="mt-1 shrink-0 rounded-full px-1 text-[11px] leading-none opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
                  >
                    ↩
                  </button>
                  <button
                    onClick={() => persist(removeMessageAt(msgs, i))}
                    aria-label={t("message.remove")}
                    title={t("message.remove")}
                    className="mt-1 shrink-0 rounded-full px-1 text-[11px] leading-none opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
                  >
                    ✕
                  </button>
                </div>
              </Fragment>
            );
          })
        )}
      </div>
      {replyTo && (
        <div className="mt-1 flex items-center justify-between gap-2 rounded-lg bg-accent/10 px-2 py-1 text-[11px]">
          <span className="min-w-0 truncate text-accent">↩ {t("message.replying")}: {replyTo}</span>
          <button
            onClick={() => setReplyTo(null)}
            aria-label={t("message.replyClear")}
            className="shrink-0 px-1 text-accent"
          >
            ✕
          </button>
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 pb-1">
        <div className="flex min-w-0 flex-1 items-center rounded-full bg-black/5 px-3.5 py-2 ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={t("message.placeholder", { name: CONTACT })}
            className="min-w-0 flex-1 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-black/30 dark:text-white dark:placeholder:text-white/30"
          />
        </div>
        <button
          onClick={send}
          title={t("message.placeholder", { name: CONTACT })}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-white shadow-[0_4px_12px_rgba(0,122,255,0.35)] transition active:scale-90"
        >
          ➤
        </button>
      </div>
    </div>
  );
}

/* ---- Music (list + play/pause + prev/next + progress timer) ---- */
export function MusicApp() {
  const { t } = useI18n();
  const [tracks, setTracks] = useState<Track[]>(() => {
    const l = normalizeTracks(readStoreValue<unknown>(MUSIC_KEY, []));
    if (l.length) return l;
    const s = seedTracks();
    writeStoreValue(MUSIC_KEY, s);
    return s;
  });
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sec, setSec] = useState(0);
  const [repeat, setRepeat] = useState<RepeatMode>("all");
  const [showLyrics, setShowLyrics] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setSec((prev) => {
        if (prev >= DURATION) {
          setIdx((i) => {
            const n = Math.max(tracks.length, 1);
            if (repeat === "one") return i; // repeat single: restart this track
            if (repeat === "off" && i >= n - 1) {
              setPlaying(false); // end of playlist: stop
              return i;
            }
            return stepIndex(i, n, 1);
          });
          return 0;
        }
        return prev + 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [playing, tracks.length, repeat]);

  // Guard: current index may drift out of range if the playlist ever shrinks
  // (removal / a changed store); fall back to the first track instead of a crash.
  const safeIdx = tracks.length ? (idx < tracks.length ? idx : 0) : 0;
  const track = tracks[safeIdx] ?? null;
  const select = (i: number) => {
    setIdx(stepIndex(i, Math.max(tracks.length, 1), 0));
    setSec(0);
  };
  const step = (d: number) => {
    setIdx((i) => nextIndex(i, Math.max(tracks.length, 1), d, repeat));
    setSec(0);
  };

  // Delete a track, persist, and keep the *currently playing* track selected
  // (or land on a safe in-range track when the playing one itself is removed).
  const remove = (id: string) => {
    const removedIndex = tracks.findIndex((tr) => tr.id === id);
    if (removedIndex < 0) return;
    const list = removeTrack(tracks, id);
    writeStoreValue(MUSIC_KEY, list);
    setTracks(list);
    setIdx(nextIndexAfterRemoval(idx, removedIndex, list.length));
    setSec(0);
  };

  const fmtM = (s: number) => {
    const n = Math.max(0, Math.floor(s));
    const p = (x: number) => String(x).padStart(2, "0");
    return `${p(Math.floor(n / 60))}:${p(n % 60)}`;
  };

  // Empty-playlist guard: keep the screen pleasant instead of showing NaN/undefined.
  if (!track) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <div className="text-6xl">🎧</div>
          <p className="mt-3 text-sm opacity-60">{t("music.empty")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <p className="text-center text-xs uppercase tracking-widest opacity-50">
        {playing ? t("music.playing") : "—"}
      </p>
      <div className="my-2 grid place-items-center rounded-3xl bg-gradient-to-br from-orange-400 to-pink-500 py-10 text-6xl">
        🎧
      </div>
      {showLyrics && (
        <div className="mx-auto mb-1 w-64 space-y-0.5">
          {DEMO_LYRICS.map((l, i) => (
            <p
              key={i}
              className={
                "truncate text-center text-sm transition " +
                (i === lyricIndex(sec, DURATION, DEMO_LYRICS.length)
                  ? "font-semibold text-accent"
                  : "opacity-40")
              }
            >
              {l}
            </p>
          ))}
        </div>
      )}
      <p className="text-center text-lg font-semibold">{track?.title}</p>
      <p className="text-center text-xs opacity-60">{track?.artist}</p>
      <div className="mt-1 flex items-baseline justify-between px-0.5 text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
        <span>{fmtM(sec)}</span>
        <span>{fmtM(DURATION)}</span>
      </div>
      <div
        role="slider"
        aria-label={t("music.seek")}
        aria-valuenow={Math.round(pctProgress(sec, DURATION) * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const c = r.width > 0 ? (e.clientX - r.left) / r.width : 0;
          setSec(seekSeconds(c, DURATION));
          setPlaying(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowUp") {
            e.preventDefault();
            setSec((s) => Math.min(DURATION, s + 5));
          } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
            e.preventDefault();
            setSec((s) => Math.max(0, s - 5));
          }
        }}
        className="group relative mt-1.5 h-1.5 cursor-pointer rounded-full bg-neutral-300 dark:bg-white/15"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent"
          style={{ width: `${pctProgress(sec, DURATION) * 100}%` }}
        />
        <div
          className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow ring-1 ring-black/5 transition group-hover:scale-110"
          style={{ left: `calc(${pctProgress(sec, DURATION) * 100}% - 7px)` }}
        />
      </div>
      <div className="mt-5 flex items-center justify-center gap-7">
        <button
          onClick={() => step(-1)}
          className="grid h-14 w-14 place-items-center rounded-full bg-neutral-300 text-xl text-neutral-700 transition active:scale-90 dark:bg-white/10 dark:text-white"
        >
          ⏮
        </button>
        <button
          onClick={() => setPlaying((p) => !p)}
          aria-label={playing ? "pause" : "play"}
          className="grid h-[72px] w-[72px] place-items-center rounded-full bg-accent text-3xl text-white shadow-[0_8px_20px_rgba(0,122,255,0.35)] transition active:scale-95"
        >
          {playing ? "⏸" : "▶"}
        </button>
        <button
          onClick={() => step(1)}
          className="grid h-14 w-14 place-items-center rounded-full bg-neutral-300 text-xl text-neutral-700 transition active:scale-90 dark:bg-white/10 dark:text-white"
        >
          ⏭
        </button>
      </div>
      <div className="mt-4 flex items-center justify-center gap-12 text-sm">
        <button
          onClick={() => setRepeat((r) => (r === "all" ? "one" : r === "one" ? "off" : "all"))}
          title={t("music.repeat")}
          aria-label={t("music.repeat")}
          className={
            "grid h-10 w-10 place-items-center rounded-full text-base transition active:scale-90 " +
            (repeat === "off" ? "opacity-35" : "opacity-80")
          }
        >
          {repeat === "one" ? "🔂" : "🔁"}
        </button>
        <button
          onClick={() => setShowLyrics((s) => !s)}
          title={t("music.lyrics")}
          aria-label={t("music.lyrics")}
          className={
            "grid h-10 w-10 place-items-center rounded-full text-base transition active:scale-90 " +
            (showLyrics ? "opacity-80" : "opacity-35")
          }
        >
          💬
        </button>
      </div>
      <div className="mt-4 space-y-1">
        {tracks.map((tr, i) => (
          <div
            key={tr.id}
            className={
              "flex items-center gap-1 rounded-xl px-2 py-1.5 " +
              (i === idx ? "bg-accent/20" : "hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50")
            }
          >
            <button
              onClick={() => select(i)}
              className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left text-sm outline-none"
            >
              <span>{i === idx ? "▶" : "♪"}</span>
              <span className="flex-1 truncate">{tr.title}</span>
              <span className="text-xs opacity-60">{tr.artist}</span>
            </button>
            <button
              onClick={() => remove(tr.id)}
              disabled={tracks.length <= 1}
              aria-label={t("music.remove")}
              className="rounded-full bg-neutral-300/70 px-2 py-0.5 text-[11px] leading-none text-danger disabled:opacity-30 dark:bg-neutral-700/70"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

