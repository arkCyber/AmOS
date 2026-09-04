import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import {
  onTelephonyEvent,
  telephonyAnswer,
  telephonyEnd,
  telephonyStartRecording,
  telephonyStopRecording,
  type TelephonyCall,
} from "../lib/backend";
import { readStoreValue } from "../lib/amosStore";
import {
  CONTACTS_KEY,
  contactNameFor,
  normalizeContacts,
  type Contact,
} from "../lib/contacts";

/**
 * System incoming-call surface. Subscribes to the daemon `Watch` stream (forwarded by
 * the Rust bridge as `telephony-event`) and, for *incoming* calls, shows a top overlay:
 * Ringing → Answer / Decline; once answered (Active) → a compact in-call banner with a
 * record toggle (recording is legal on Active non-emergency calls) and Hang up. Outgoing
 * calls are the PhoneApp's own UI and are intentionally ignored here.
 */
export default function IncomingCall() {
  const { t } = useI18n();
  const [call, setCall] = useState<TelephonyCall | null>(null);
  const [phase, setPhase] = useState<"ringing" | "talking">("ringing");
  const [recording, setRecording] = useState<"Off" | "On" | "Failed">("Off");
  const [contacts] = useState<Contact[]>(() =>
    normalizeContacts(readStoreValue(CONTACTS_KEY, [])),
  );

  useEffect(
    () =>
      onTelephonyEvent((c) => {
        if (c.direction !== "Incoming") return; // outgoing = PhoneApp's own screen
        if (c.state === "Ringing") {
          setCall(c);
          setPhase("ringing");
          setRecording("Off");
        } else if (c.state === "Active") {
          setCall(c);
          setPhase("talking");
          setRecording(c.recording as "Off" | "On" | "Failed");
        } else if (c.state === "Ended") {
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
    void label;
  };
  const toggleRecord = async () => {
    if (!call) return;
    const res = recording !== "On"
      ? await telephonyStartRecording(call.id)
      : await telephonyStopRecording(call.id);
    if (res) setRecording(res.recording as "Off" | "On" | "Failed");
  };

  if (!call) return null;
  const label = contactNameFor(contacts, call.peer) ?? call.peer;
  const ringing = phase === "ringing";

  return (
    <div
      role="dialog"
      aria-label={ringing ? t("phone.incoming") : t("phone.talking")}
      className="pointer-events-auto absolute inset-x-3 top-3 z-[70] overflow-hidden rounded-3xl bg-white/95 p-4 shadow-2xl ring-1 ring-black/10 backdrop-blur dark:bg-neutral-800/95 dark:ring-white/10"
    >
      <div className="flex items-center gap-3">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-accent/20 text-xl">
          📞
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-widest opacity-50">
            {ringing ? t("phone.incoming") : t("phone.talking")}
          </div>
          <div className="truncate text-lg font-semibold">{label}</div>
          {recording === "On" && (
            <div className="flex items-center gap-1 text-[11px] font-medium text-danger">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" aria-hidden />
              {t("phone.recording")}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!ringing && (
            <button
              onClick={() => void toggleRecord()}
              aria-label={recording === "On" ? t("phone.recordStop") : t("phone.recordStart")}
              className={
                "grid h-11 w-11 place-items-center rounded-full text-base transition active:scale-90 " +
                (recording === "On"
                  ? "bg-danger text-white"
                  : "bg-neutral-200 text-danger dark:bg-white/10")
              }
            >
              {recording === "On" ? "⏹" : "●"}
            </button>
          )}
          {ringing && (
            <button
              onClick={() => void answer()}
              className="h-11 w-11 rounded-full bg-emerald-500 text-lg text-white transition active:scale-90"
              aria-label={t("phone.answer")}
            >
              📞
            </button>
          )}
          <button
            onClick={() => void leave(ringing ? "decline" : "hangup")}
            className="h-11 w-11 rounded-full bg-danger text-lg text-white transition active:scale-90"
            aria-label={ringing ? t("phone.decline") : t("phone.hangup")}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
