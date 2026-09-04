import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { readStoreValue } from "../lib/amosStore";
import {
  onTelephonyEvent,
  telephonyDial,
  telephonyEnd,
  telephonySimulateIncoming,
  telephonyStartRecording,
  telephonyStopRecording,
} from "../lib/backend";
import { KEYS, backspace, clearDial, pushKey, MAX_DIAL_LEN } from "../lib/phone";
import { EMERGENCY_NUMBERS, EMERGENCY_QUICK_NUMBER } from "../lib/emergency";
import {
  CONTACTS_KEY,
  contactNameFor,
  normalizeContacts,
  type Contact,
} from "../lib/contacts";
import { useOutgoingCalls } from "../lib/useOutgoingCalls";

/** iOS dialer letters shown beneath 2–9 (empty for the rest of the keys). */
const SUB: Record<string, string> = {
  "2": "ABC", "3": "DEF", "4": "GHI", "5": "JKL",
  "6": "MNO", "7": "PQRS", "8": "TUV", "9": "WXYZ",
};

export type PhoneTab = "keys" | "recent" | "frequent" | "emergency";

/** Full-featured dialer: tabbed keypad / recent / frequent / emergency pages and an
 * in-call surface with record + mute + DTMF keypad. Real audio (tones, mic routing)
 * is the audio pipeline's job (docs/native-voice.md); mute & DTMF are local UI state
 * here until that pipeline lands, while dialing goes through the OS telephony service
 * (degrading honestly to a localized error when the daemon is absent). */
export function PhoneApp() {
  const { t } = useI18n();
  const [num, setNum] = useState("");
  const [calling, setCalling] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [talking, setTalking] = useState(false);
  const [recording, setRecording] = useState<"Off" | "On" | "Failed">("Off");
  const [dialError, setDialError] = useState<string | null>(null);
  const [tab, setTab] = useState<PhoneTab>("keys");
  const [muted, setMuted] = useState(false);
  const [padOpen, setPadOpen] = useState(false);
  const [dtmf, setDtmf] = useState("");
  const activeRef = useRef<string | null>(null);
  const [contacts] = useState<Contact[]>(() =>
    normalizeContacts(readStoreValue(CONTACTS_KEY, [])),
  );
  const { recents, frequent, recordOutgoing } = useOutgoingCalls(contacts);

  const tap = (k: string) => !calling && setNum(pushKey(num, k));

  // Place a call via the OS telephony service. `number` defaults to the keypad
  // entry; `emergency` forces the privileged path (the daemon also re-classifies a
  // recognized emergency number regardless). A null result (no daemon / rejection)
  // drops us back with a localized error instead of a phantom "calling…" screen.
  const startCall = async (number = num, emergency = false) => {
    const target = number.trim();
    if (target === "") return;
    setNum(target);
    setCalling(true);
    setTalking(false);
    setActiveId(null);
    activeRef.current = null;
    setRecording("Off");
    setMuted(false);
    setPadOpen(false);
    setDtmf("");
    setDialError(null);
    const res = await telephonyDial(target, emergency);
    if (res) {
      setActiveId(res.id);
      activeRef.current = res.id;
      recordOutgoing(target, contactNameFor(contacts, target) ?? undefined, t("contacts.dialed"));
    } else {
      setCalling(false);
      setTalking(false);
      setActiveId(null);
      activeRef.current = null;
      setDialError(t("phone.dialFailed"));
    }
  };

  // Select a number from a list page: fill the keypad and jump to it (select-then-place,
  // so an accidental tap never dials).
  const pick = (n: string) => {
    if (calling) return;
    setNum(n);
    setTab("keys");
  };

  // Emergency page: one-tap straight through the privileged path.
  const emergencyDial = (n: string) => void startCall(n, true);

  const endCall = async () => {
    if (activeId) await telephonyEnd(activeId);
    setCalling(false);
    setTalking(false);
    setActiveId(null);
    activeRef.current = null;
    setRecording("Off");
    setMuted(false);
    setPadOpen(false);
    setDtmf("");
    setDialError(null);
  };

  const toggleRecord = async () => {
    if (!activeId) return;
    const target = recording !== "On";
    const res = target
      ? await telephonyStartRecording(activeId)
      : await telephonyStopRecording(activeId);
    if (res) setRecording(res.recording as "Off" | "On" | "Failed");
  };

  const simIncoming = async () => {
    if (calling) return;
    const from = num.trim() !== "" ? num.trim() : "02112345678";
    await telephonySimulateIncoming(from);
  };

  // Drive our own dialed call from the daemon `Watch` stream: on connect we enter the
  // talking screen; on end we drop back. Other calls (incoming) are the system
  // incoming-call overlay's concern.
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
        setMuted(false);
        setPadOpen(false);
        setDtmf("");
      }
    });
  }, []);

  const tabs: { id: PhoneTab; label: string }[] = [
    { id: "keys", label: t("phone.tabKeys") },
    { id: "recent", label: t("phone.tabRecent") },
    { id: "frequent", label: t("phone.tabFrequent") },
    { id: "emergency", label: t("phone.tabEmergency") },
  ];

  const keypad = (
    <div className="flex w-full flex-col items-center">
      <div className="py-5 text-center">
        <div className="text-3xl tabular-nums tracking-widest">{num || "—"}</div>
        <div className="mt-1 text-[10px] tabular-nums opacity-40">
          {num.length}/{MAX_DIAL_LEN}
        </div>
      </div>
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
                  <span className="mt-0.5 text-[9px] tracking-[0.18em] opacity-60">
                    {letters}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex items-center justify-center gap-6">
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
      {/* Demo-only: have the mock daemon ring an incoming call for a manual test. */}
      <button
        onClick={() => void simIncoming()}
        disabled={calling}
        aria-label={t("phone.simIncoming")}
        className="mt-3 text-[10px] uppercase tracking-widest text-accent/70 transition hover:text-accent disabled:opacity-30"
      >
        {t("phone.simIncoming")}
      </button>
    </div>
  );


  const listView = (
    header: string,
    items: { num: string; label: string }[],
    emptyKey: string,
  ) => (
    <div className="flex w-full flex-col items-center">
      <div className="py-5 text-center text-lg font-medium opacity-70">{header}</div>
      {items.length === 0 ? (
        <p className="py-10 text-sm opacity-50">{t(emptyKey)}</p>
      ) : (
        <ul className="w-full max-w-xs divide-y divide-black/5 dark:divide-white/10">
          {items.map((it) => (
            <li key={it.num}>
              <button
                onClick={() => pick(it.num)}
                title={it.num}
                className="flex w-full items-center justify-between gap-2 py-3 text-left transition active:opacity-70"
              >
                <span className="truncate text-sm">{it.label}</span>
                <span className="shrink-0 text-xs opacity-50 tabular-nums">{it.num}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const EMERGENCY_LABEL: Record<string, string> = {
    "110": t("phone.emergency.police"),
    "119": t("phone.emergency.fire"),
    "120": t("phone.emergency.ambulance"),
    "122": t("phone.emergency.traffic"),
    "112": t("phone.emergency.international"),
  };

  const emergencyView = (
    <div className="flex w-full flex-col items-center">
      <div className="py-5 text-center text-lg font-medium opacity-70">
        {t("phone.emergencyTitle")}
      </div>
      <ul className="w-full max-w-xs space-y-2.5">
        {EMERGENCY_NUMBERS.map((code) => {
          const primary = code === EMERGENCY_QUICK_NUMBER;
          return (
            <li key={code}>
              <button
                onClick={() => emergencyDial(code)}
                aria-label={`${t("phone.emergencyCall")} ${code}`}
                className={
                  "flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition active:scale-[0.99] " +
                  (primary
                    ? "bg-danger text-white shadow-[0_6px_18px_rgba(220,38,38,0.35)]"
                    : "bg-danger/10 text-red-700 ring-1 ring-danger/25 dark:text-red-300")
                }
              >
                <span className="text-base font-semibold">
                  {EMERGENCY_LABEL[code] ?? t("phone.emergencyGeneric", { num: code })}
                </span>
                <span className="text-2xl tabular-nums tracking-widest">{code}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 max-w-xs text-center text-[10px] leading-relaxed opacity-50">
        {t("phone.emergencyHint")}
      </p>
    </div>
  );


  // In-call surface (dialing or, once connected, talking with record/mute/DTMF).
  const incall = (
    <div className="flex w-full flex-col items-center">
      <div className="py-4 text-center">
        <div className="text-3xl tabular-nums tracking-widest">{num || "—"}</div>
        <div className="mt-1 text-sm opacity-70">
          {talking ? t("phone.talking") : t("phone.call")}
          {!talking && num ? " …" : ""}
        </div>
      </div>
      {recording === "On" && (
        <p className="flex items-center gap-1.5 text-xs font-medium text-danger">
          <span className="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden />
          {t("phone.recording")}
        </p>
      )}
      {recording === "Failed" && (
        <p className="text-[11px] opacity-60">{t("phone.recordUnavailable")}</p>
      )}
      {muted && <p className="mt-1 text-[11px] opacity-60">{t("phone.muted")}</p>}
      {talking && (
        <>
          {padOpen && (
            <div className="my-3 flex w-full max-w-[210px] flex-col items-center gap-2">
              <div className="h-6 w-full truncate rounded-full bg-black/5 px-3 text-center text-sm tabular-nums tracking-[0.2em] dark:bg-white/10">
                {dtmf || "\u00A0"}
              </div>
              <div className="grid w-full grid-cols-3 gap-2">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((k) => (
                  <button
                    key={k}
                    onClick={() => setDtmf((d) => (d.length < 12 ? d + k : d))}
                    className="grid aspect-square place-items-center rounded-full bg-neutral-300/90 text-lg text-neutral-900 transition active:scale-90 dark:bg-white/10 dark:text-white"
                    aria-label={t("phone.dtmfKey", { key: k })}
                  >
                    {k}
                  </button>
                ))}
              </div>
              {dtmf && (
                <button
                  onClick={() => setDtmf("")}
                  className="text-[11px] text-accent"
                  aria-label={t("phone.dtmfClear")}
                >
                  {t("phone.clear")}
                </button>
              )}
            </div>
          )}
          <div className="mt-2 flex items-center gap-5">
            {activeId && (
              <button
                onClick={() => void toggleRecord()}
                aria-label={recording === "On" ? t("phone.recordStop") : t("phone.recordStart")}
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
              onClick={() => setMuted((m) => !m)}
              aria-label={muted ? t("phone.unmute") : t("phone.mute")}
              className={
                "grid h-14 w-14 place-items-center rounded-full text-lg transition active:scale-90 " +
                (muted
                  ? "bg-danger text-white"
                  : "bg-neutral-200 text-neutral-700 dark:bg-white/10 dark:text-white")
              }
            >
              {muted ? "🔇" : "🎙️"}
            </button>
            <button
              onClick={() => {
                setPadOpen((o) => !o);
                setDtmf("");
              }}
              aria-label={t("phone.dtmf")}
              className="grid h-14 w-14 place-items-center rounded-full bg-neutral-200 text-lg text-neutral-700 transition active:scale-90 dark:bg-white/10 dark:text-white"
            >
              ⌨️
            </button>
          </div>
        </>
      )}
      <div className="mt-6">
        <button
          onClick={() => void endCall()}
          className="grid h-16 w-16 place-items-center rounded-full bg-danger text-2xl text-white transition active:scale-90"
          aria-label="end"
        >
          ✕
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full w-full flex-col items-center p-3">
      {!calling && (
        <nav
          role="tablist"
          aria-label={t("phone.tabs")}
          className="mb-1 flex w-full max-w-xs gap-1 rounded-full bg-neutral-200/80 p-1 dark:bg-white/10"
        >
          {tabs.map((tb) => (
            <button
              key={tb.id}
              role="tab"
              aria-selected={tab === tb.id}
              onClick={() => setTab(tb.id)}
              className={
                "flex-1 rounded-full px-2 py-1.5 text-xs font-medium transition " +
                (tab === tb.id
                  ? "bg-white text-neutral-900 shadow dark:bg-white/20 dark:text-white"
                  : "text-neutral-600 hover:text-neutral-900 dark:text-white/70 dark:hover:text-white")
              }
            >
              {tb.label}
            </button>
          ))}
        </nav>
      )}
      {!calling && dialError && (
        <p role="alert" className="my-2 max-w-xs text-center text-[11px] text-danger">
          {dialError}
        </p>
      )}
      {calling ? (
        incall
      ) : tab === "keys" ? (
        keypad
      ) : tab === "recent" ? (
        listView(t("phone.tabRecent"), recents, "phone.emptyRecent")
      ) : tab === "frequent" ? (
        listView(t("phone.tabFrequent"), frequent, "phone.emptyFrequent")
      ) : (
        emergencyView
      )}
    </div>
  );
}

