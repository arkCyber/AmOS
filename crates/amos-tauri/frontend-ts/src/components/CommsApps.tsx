import { Fragment, useEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from "react";
import { useI18n } from "../i18n";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import {
  onTelephonyEvent,
  telephonyDial,
  telephonyEnd,
  telephonySimulateIncoming,
  telephonyStartRecording,
  telephonyStopRecording,
} from "../lib/backend";
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
import { KEYS, backspace, clearDial, pushKey, MAX_DIAL_LEN } from "../lib/phone";
import { MUSIC_KEY, nextIndexAfterRemoval, nextIndex, normalizeTracks, pctProgress, removeTrack, seekSeconds, seedTracks, stepIndex, DEMO_LYRICS, lyricIndex, type RepeatMode, type Track } from "../lib/music";
import {
  CONTACTS_KEY,
  contactNameFor,
  normalizeContacts,
  type Contact,
} from "../lib/contacts";
import { useOutgoingCalls } from "../lib/useOutgoingCalls";
import { NOTIF_KEY, removeAppNotifs, type Notif } from "../lib/settings";
import { zh } from "../i18n/locales/zh";

const DURATION = 24; // demo seconds per track

// iOS dialer letters shown beneath 2–9 (empty for the rest of the keys).
const SUB: Record<string, string> = {
  "2": "ABC",
  "3": "DEF",
  "4": "GHI",
  "5": "JKL",
  "6": "MNO",
  "7": "PQRS",
  "8": "TUV",
  "9": "WXYZ",
};

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

/* ---- Phone dialer ---- */
export function PhoneApp() {
  const { t } = useI18n();
  const [num, setNum] = useState("");
  const [calling, setCalling] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Whether our outgoing call has connected (reached Active); enables recording.
  const [talking, setTalking] = useState(false);
  // Authoritative recording state for the live call, mirrored from the daemon's
  // telephony_start_recording / telephony_stop_recording responses.
  const [recording, setRecording] = useState<"Off" | "On" | "Failed">("Off");
  // Live copy of activeId so the event subscription (registered once) never reads a
  // stale id from its closure.
  const activeRef = useRef<string | null>(null);
  const [contacts] = useState<Contact[]>(() =>
    normalizeContacts(readStoreValue(CONTACTS_KEY, [])),
  );
  const { recents, frequent, recordOutgoing } = useOutgoingCalls(contacts);
  const tap = (k: string) => !calling && setNum(pushKey(num, k));

  // Place a real call via the OS telephony service when the daemon is present;
  // outside the Tauri shell (or with no daemon) this still shows the local
  // "calling" UI but leaves no id to hang up (honest graceful degradation).
  const startCall = async () => {
    if (!num) return;
    setCalling(true);
    setTalking(false);
    setActiveId(null);
    activeRef.current = null;
    setRecording("Off");
    const res = await telephonyDial(num);
    if (res) {
      setActiveId(res.id);
      activeRef.current = res.id;
      // Feed call history + a phone notification (shared, like ContactsApp).
      recordOutgoing(num, contactNameFor(contacts, num) ?? undefined, t("contacts.dialed"));
    }
  };
  const endCall = async () => {
    if (activeId) await telephonyEnd(activeId);
    setCalling(false);
    setTalking(false);
    setActiveId(null);
    activeRef.current = null;
    setRecording("Off");
  };
  // Start/stop recording on the live call. Recording is only legal once the call
  // is ACTIVE + non-emergency (enforced by the OS telephony domain); when the
  // daemon declines (call not yet connected) the authoritative response keeps the
  // local toggle unchanged rather than lying about a recording that didn't start.
  const toggleRecord = async () => {
    if (!activeId) return;
    const target = recording !== "On";
    const res = target
      ? await telephonyStartRecording(activeId)
      : await telephonyStopRecording(activeId);
    if (res) setRecording(res.recording as "Off" | "On" | "Failed");
  };

  // Demo-only: have the mock daemon ring an incoming call from the currently dialed
  // number (or a demo number) so the system incoming-call overlay can be exercised.
  const simIncoming = async () => {
    if (calling) return;
    const from = num.trim() !== "" ? num.trim() : "02112345678";
    await telephonySimulateIncoming(from);
  };

  // Drive our own dialed call from the daemon `Watch` stream: when it connects we
  // enter the "talking" screen (recording becomes legal), and when it ends (local or
  // remote) we drop back to the keypad. Events for other calls (incoming) are left
  // to the system incoming-call overlay.
  useEffect(() => {
    return onTelephonyEvent((call) => {
      if (call.id !== activeRef.current) return;
      setRecording(call.recording as "Off" | "On" | "Failed");
      if (call.state === "Active") setTalking(true);
      else if (call.state === "Ended") {
        setCalling(false);
        setTalking(false);
        setActiveId(null);
        activeRef.current = null;
        setRecording("Off");
      }
    });
  }, []);

  const quickRow = (header: string, items: { num: string; label: string }[]) =>
    items.length === 0 ? null : (
      <div className="mb-3 flex w-full max-w-xs flex-wrap items-center justify-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest opacity-40">
          {header}
        </span>
        {items.map(({ num, label }) => (
          <button
            key={num}
            onClick={() => setNum(num)}
            title={num}
            className="rounded-full bg-neutral-300/80 px-2.5 py-1 text-[11px] text-neutral-800 transition active:scale-95 dark:bg-white/10 dark:text-white"
          >
            {label}
          </button>
        ))}
      </div>
    );
  return (
    <div className="flex h-full flex-col items-center p-3">
      <div className="py-6 text-center">
        <div className="text-3xl tabular-nums tracking-widest">{num || "—"}</div>
        <div className="mt-1 text-[10px] tabular-nums opacity-40">
          {num.length}/{MAX_DIAL_LEN}
        </div>
      </div>
      {calling ? (
        <div className="flex flex-col items-center gap-6 py-10">
          <p className="text-2xl font-thin">
            {talking ? t("phone.talking") : t("phone.call")}
            {talking ? "" : ` ${num}…`}
          </p>
          {recording === "On" && (
            <p className="flex items-center gap-1.5 text-xs font-medium text-danger">
              <span className="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden />
              {t("phone.recording")}
            </p>
          )}
          {recording === "Failed" && (
            <p className="text-[11px] opacity-60">{t("phone.recordUnavailable")}</p>
          )}
          {/* Recording toggle: offered only once the call has connected (talking) and
              the OS returned a live call id — recording is domain-legal only then. */}
          {talking && activeId && (
            <button
              onClick={() => void toggleRecord()}
              aria-label={
                recording === "On" ? t("phone.recordStop") : t("phone.recordStart")
              }
              className={
                "grid h-14 w-14 place-items-center rounded-full text-lg transition active:scale-90 " +
                (recording === "On"
                  ? "bg-danger text-white"
                  : "bg-neutral-200 text-danger dark:bg-white/10")
              }
            >
              {recording === "On" ? "⏹" : "●"}
            </button>
          )}
          <button
            onClick={() => void endCall()}
            className="h-16 w-16 rounded-full bg-danger text-2xl text-white"
            aria-label="end"
          >
            ✕
          </button>
        </div>
      ) : (
        <>
          {quickRow(t("contacts.frequent"), frequent)}
          {quickRow(t("contacts.recent"), recents)}
          <div className="grid w-full max-w-xs grid-cols-3 gap-3">
            {KEYS.map((k) => {
              const letters = SUB[k as keyof typeof SUB];
              return (
                <button
                  key={k}
                  onClick={() => tap(k)}
                  className="grid aspect-square place-items-center rounded-full bg-neutral-300/90 text-neutral-900 transition active:scale-90 dark:bg-white/10 dark:text-white"
                >
                  <span className="flex flex-col items-center leading-none">
                    <span className="text-[22px]">{k}</span>
                    {letters && (
                      <span className="mt-0.5 text-[9px] tracking-[0.18em] opacity-60">{letters}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-5 flex items-center justify-center gap-6">
            <div className="flex flex-col items-center gap-3">
              <button
                onClick={() => setNum(backspace(num))}
                disabled={!num}
                aria-label="backspace"
                className="grid h-11 w-11 place-items-center rounded-full bg-neutral-300/90 text-lg text-neutral-700 transition active:scale-90 disabled:opacity-30 dark:bg-white/10 dark:text-white"
              >
                ⌫
              </button>
              <button
                onClick={() => setNum(clearDial(num))}
                disabled={!num}
                aria-label="clear"
                className="text-[11px] text-accent disabled:opacity-30"
              >
                {t("phone.clear")}
              </button>
            </div>
            <button
              onClick={() => void startCall()}
              disabled={!num}
              className="grid h-[72px] w-[72px] place-items-center rounded-full bg-green-500 text-white shadow-[0_8px_20px_rgba(52,199,89,0.4)] transition active:scale-90 disabled:opacity-40"
              aria-label="call"
            >
              <span className="text-3xl leading-none">📞</span>
            </button>
          </div>
          {/* Demo-only: ask the mock daemon to ring an incoming call so the system
              incoming-call surface can be exercised by hand (dev affordance). */}
          <button
            onClick={() => void simIncoming()}
            disabled={calling}
            aria-label={t("phone.simIncoming")}
            className="mt-3 text-[10px] uppercase tracking-widest text-accent/70 transition hover:text-accent disabled:opacity-30"
          >
            {t("phone.simIncoming")}
          </button>
        </>
      )}
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

