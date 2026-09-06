import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  onTelephonyEvent,
  telephonyAnswer,
  telephonyEnd,
  telephonyStartRecording,
  telephonyStopRecording,
  type TelephonyCall,
} from "../lib/backend";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { CALLLOG_KEY, normalizeCallLog, recordCall } from "../lib/calllog";
import {
  CONTACTS_KEY,
  contactNameFor,
  normalizeContacts,
  type Contact,
} from "../lib/contacts";

/**
 * System incoming-call surface — a full-screen, first-priority popup. Subscribes to
 * the daemon `Watch` stream (forwarded by the Rust bridge as `telephony-event`) and,
 * for *incoming* calls, takes over the whole screen above every surface (home, an
 * app, even the lock screen): Ringing → big Answer / Decline; once answered
 * (Active) → a full in-call screen with mute + record (legal on Active non-emergency
 * calls) and Hang up. Outgoing calls are the PhoneApp's own UI (ignored here).
 */
export default function IncomingCall() {
  const { t } = useI18n();
  const [call, setCall] = useState<TelephonyCall | null>(null);
  const [phase, setPhase] = useState<"ringing" | "talking">("ringing");
  const [recording, setRecording] = useState<"Off" | "On" | "Failed">("Off");
  const [muted, setMuted] = useState(false);
  const [contacts] = useState<Contact[]>(() =>
    normalizeContacts(readStoreValue(CONTACTS_KEY, [])),
  );
  // Tracks the incoming call we surfaced so we only write one log entry per call,
  // once it ends (answered, missed or declined) — and never duplicate on repeat events.
  const surfacedId = useRef<string | null>(null);

  useEffect(
    () =>
      onTelephonyEvent((c) => {
        if (c.direction !== "Incoming") return; // outgoing = PhoneApp's own screen
        if (c.state === "Ringing") {
          surfacedId.current = c.id;
          setCall(c);
          setPhase("ringing");
          setRecording("Off");
          setMuted(false);
        } else if (c.state === "Active") {
          setCall(c);
          setPhase("talking");
          setRecording(c.recording as "Off" | "On" | "Failed");
        } else if (c.state === "Ended") {
          // Persist the finished incoming call into the shared call log so the
          // Phone screen's Recent/Frequent list reflects it too.
          if (surfacedId.current === c.id && c.peer) {
            const prev = normalizeCallLog(readStoreValue(CALLLOG_KEY, []));
            const label = contactNameFor(contacts, c.peer) ?? c.peer;
            writeStoreValue(CALLLOG_KEY, recordCall(prev, c.peer, label, Date.now()));
          }
          surfacedId.current = null;
          setMuted(false);
          setCall((prev) => (prev && prev.id === c.id ? null : prev));
        }
      }),
    [],
  );

  const answer = async () => {
    if (!call) return;
    setPhase("talking"); // optimistic; daemon also confirms via Active event
    await telephonyAnswer(call.id);
  };
  const leave = async (label?: "decline" | "hangup") => {
    const id = call?.id;
    if (id) await telephonyEnd(id);
    setCall(null);
    setMuted(false);
    void label;
  };
  const toggleRecord = async () => {
    if (!call) return;
    const res = recording !== "On"
      ? await telephonyStartRecording(call.id)
      : await telephonyStopRecording(call.id);
    if (res) setRecording(res.recording as "Off" | "On" | "Failed");
  };

  // Ring the phone while an incoming call is ringing (WebView tone until answered).
  useEffect(() => {
    if (!call || phase !== "ringing") return;
    let ctx: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const AC =
      typeof window !== "undefined" &&
      (window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!AC) return;
    ctx = new AC();
    const beep = () => {
      if (!ctx || ctx.state === "closed") return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 620;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.52);
    };
    beep();
    timer = setInterval(beep, 1000);
    return () => {
      if (timer) clearInterval(timer);
      if (ctx) void ctx.close();
    };
  }, [call, phase]);

  if (!call) return null;
  const label = contactNameFor(contacts, call.peer) ?? call.peer;
  const ringing = phase === "ringing";

  return (
    <div
      role="dialog"
      aria-label={ringing ? t("phone.incoming") : t("phone.talking")}
      className="pointer-events-auto absolute inset-0 z-[90] flex flex-col items-center overflow-hidden bg-neutral-950 text-white"
    >
      {/* gradient wash */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 60% at 50% -10%, rgba(16,185,129,0.35), transparent 60%), radial-gradient(120% 50% at 50% 115%, rgba(239,68,68,0.25), transparent 60%)",
        }}
      />
      {ringing && <div aria-hidden className="absolute inset-0 -z-0 animate-pulse bg-black/20" />}

      {/* status tag */}
      <div className="relative mt-10 text-center">
        <div className="text-sm font-semibold uppercase tracking-[0.3em] text-emerald-300/90">
          {ringing ? t("phone.incoming") : t("phone.talking")}
        </div>
      </div>

      {/* caller identity */}
      <div className="relative mt-16 flex min-w-0 flex-1 flex-col items-center justify-center px-6 text-center">
        <div
          aria-hidden
          className={
            "grid h-36 w-36 place-items-center rounded-full bg-white/10 text-7xl shadow-2xl ring-1 ring-white/20 " +
            (ringing ? "animate-pulse" : "")
          }
        >
          📞
        </div>
        <div className="mt-8 max-w-full text-3xl font-semibold leading-tight break-words">{label}</div>
        <div className="mt-2 text-sm tracking-widest text-white/50 tabular-nums">{call.peer}</div>
        {recording === "On" && (
          <div className="mt-4 flex items-center gap-2 text-sm font-medium text-red-300">
            <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-red-400" />
            {t("phone.recording")}
          </div>
        )}
      </div>

      {/* actions */}
      {ringing ? (
        <div className="relative mb-12 flex w-full items-center justify-around px-10">
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={() => void leave("decline")}
              aria-label={t("phone.decline")}
              className="grid h-24 w-24 place-items-center rounded-full bg-red-500 text-3xl text-white shadow-[0_12px_30px_rgba(239,68,68,0.45)] transition active:scale-90"
            >
              ✕
            </button>
            <span className="text-sm font-medium text-white/80">{t("phone.decline")}</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={() => void answer()}
              aria-label={t("phone.answer")}
              className="grid h-24 w-24 place-items-center rounded-full bg-emerald-500 text-4xl text-white shadow-[0_12px_30px_rgba(16,185,129,0.5)] transition active:scale-90"
            >
              📞
            </button>
            <span className="text-sm font-medium text-white/80">{t("phone.answer")}</span>
          </div>
        </div>
      ) : (
        <div className="relative mb-12 flex w-full items-end justify-center gap-8 px-6">
          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={() => setMuted((m) => !m)}
              aria-label={muted ? t("phone.unmute") : t("phone.mute")}
              className={
                "grid h-16 w-16 place-items-center rounded-full text-2xl transition active:scale-90 " +
                (muted
                  ? "bg-red-500 text-white"
                  : "bg-white/10 text-white ring-1 ring-white/20")
              }
            >
              {muted ? "🔇" : "🎙️"}
            </button>
            <span className="text-xs text-white/70">{muted ? t("phone.unmute") : t("phone.mute")}</span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={() => void toggleRecord()}
              aria-label={recording === "On" ? t("phone.recordStop") : t("phone.recordStart")}
              className={
                "grid h-16 w-16 place-items-center rounded-full text-2xl transition active:scale-90 " +
                (recording === "On"
                  ? "bg-red-500 text-white"
                  : "bg-white/10 text-white ring-1 ring-white/20")
              }
            >
              {recording === "On" ? "⏹" : "●"}
            </button>
            <span className="text-xs text-white/70">
              {recording === "On" ? t("phone.recordStop") : t("phone.recordStart")}
            </span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={() => void leave("hangup")}
              aria-label={t("phone.hangup")}
              className="grid h-16 w-16 place-items-center rounded-full bg-red-500 text-2xl text-white transition active:scale-90"
            >
              ✕
            </button>
            <span className="text-xs text-white/70">{t("phone.hangup")}</span>
          </div>
        </div>
      )}
    </div>
  );
}
