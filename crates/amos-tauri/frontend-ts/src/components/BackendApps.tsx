import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { chip, btn } from "./ui";
import {
  bridged,
  cancelAiSession,
  conversationId,
  newConversation,
  getAiStatus,
  interpretAudio,
  interpretPause,
  interpretResume,
  interpretStart,
  interpretStop,
  interpretText,
  listSessions,
  clearSessions,
  removeSession,
  getSessionHistory,
  sendChat,
  subscribe,
  type AiSessionInfo,
  type HistoryTurn,
} from "../lib/backend";
import { frameToChunk } from "../lib/audio";
import { speakText } from "../lib/realtimeTts";
import { capTail } from "../lib/bounded";
import VoiceMicButton from "./VoiceMicButton";
import StreamVoiceButton from "./StreamVoiceButton";
import { useCapability } from "./CapabilityGate";
import { cardOf, sessionMetaOf, tokenOf, type AiCard } from "../lib/stream";
import {
  clearSegs,
  errorOf,
  LANGS,
  langNative,
  loadSegs,
  partialTextOf,
  readPrefs,
  saveSegs,
  segOf,
  transcriptText,
  writePrefs,
  type InterpPrefs,
  type InterpSeg,
} from "../lib/interp";

/* Bounds for long-lived in-session lists (deterministic-memory guard). */
const CHAT_MSG_CAP = 200; // AI conversation bubbles kept in memory
const SEG_CAP = 200; // interpreter transcript segments kept in memory

/* Semantic UiCard header accents per intent kind (fallback = generic purple). */
const CARD_COLORS: Record<string, string> = {
  weather: "linear-gradient(135deg,#38bdf8,#0ea5e9)",
  music: "linear-gradient(135deg,#f472b6,#e11d48)",
  notes: "linear-gradient(135deg,#fbbf24,#f59e0b)",
  wallet: "linear-gradient(135deg,#34d399,#059669)",
  generic: "linear-gradient(135deg,#a78bfa,#7c3aed)",
};

type AiMsg = { id: string; role: "user" | "agent"; text: string; cards: AiCard[] };

/** Render a semantic UiCard (the terminal frame of an AI reply). */
function AiCardView({ card }: { card: AiCard }) {
  const bg = CARD_COLORS[card.kind] ?? CARD_COLORS.generic;
  return (
    <div className="mt-2 overflow-hidden rounded-2xl border border-neutral-300/60 bg-neutral-50 dark:border-neutral-700/60 dark:bg-neutral-900/70">
      <div
        className="px-3 py-1.5 text-xs font-semibold text-white"
        style={{ background: bg }}
      >
        {card.title || card.kind}
      </div>
      {card.subtitle && <div className="px-3 py-1 text-xs opacity-70">{card.subtitle}</div>}
      {card.fields.length > 0 && (
        <div className="px-3 py-1 text-xs">
          {card.fields.map((f, i) => (
            <div key={i} className="flex justify-between gap-4 py-0.5">
              <span className="opacity-60">{f.key}</span>
              <span className="text-right font-medium">{f.value}</span>
            </div>
          ))}
        </div>
      )}
      {card.actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
          {card.actions.map((a, i) => (
            <span
              key={i}
              className="rounded-full bg-neutral-200 px-2 py-0.5 text-[10px] text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
            >
              {a}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- AI Assistant: chat_agent + streaming tokens, cards, stop & clear ---- */
export function AiApp() {
  const { t } = useI18n();
  const online = bridged();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [meta, setMeta] = useState("");
  const [copiedReply, setCopiedReply] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [sessions, setSessions] = useState<AiSessionInfo[] | null>(null);
  const [sessOpen, setSessOpen] = useState(false);
  const [showHist, setShowHist] = useState<string | null>(null);
  const [histories, setHistories] = useState<Record<string, HistoryTurn[] | "loading">>({});
  const toggleSessions = async (): Promise<void> => {
    const open = !sessOpen;
    setSessOpen(open);
    if (open && sessions === null) {
      const res = await listSessions();
      if (Array.isArray(res)) setSessions(res);
    }
  };
  const toggleHist = async (id: string): Promise<void> => {
    if (showHist === id) {
      setShowHist(null);
      return;
    }
    setShowHist(id);
    if (histories[id] === undefined) {
      setHistories((h) => ({ ...h, [id]: "loading" as const }));
      const res = await getSessionHistory(id);
      const turns = res && Array.isArray(res.turns) ? res.turns : [];
      setHistories((h) => ({ ...h, [id]: turns }));
    }
  };
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<AiMsg[]>([]);

  const curIdRef = useRef<string | null>(null); // agent message being streamed
  const busyRef = useRef(false);
  const abortedRef = useRef(false);
  const onlineRef = useRef(online);
  onlineRef.current = online;

  const uid = (tag: string) =>
    `${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  // Append into the in-progress assistant message only.
  const patchCur = (fn: (m: AiMsg) => AiMsg) => {
    const id = curIdRef.current;
    if (!id) return;
    setMsgs((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  };
  const setBusyBoth = (b: boolean) => {
    busyRef.current = b;
    setBusy(b);
  };
  // Append a finished chat bubble (used by streaming-voice turns, which arrive on
  // the separate `assistant-voice-event` channel rather than `chat_agent`).
  const pushMsg = (role: "user" | "agent", text: string) =>
    setMsgs((prev) =>
      capTail([...prev, { id: uid(role === "agent" ? "a" : "u"), role, text, cards: [] }], CHAT_MSG_CAP),
    );

  useEffect(() => {
    if (!online) return;
    let alive = true;
    const unsubs: (() => void)[] = [];
    getAiStatus().then((s) => {
      if (alive && s?.model)
        setStatus(t("ai.modelStatus", { model: s.model, count: s.active_sessions ?? 0 }));
    });
    (async () => {
      unsubs.push(
        await subscribe("ai-token-received", (p) => {
          if (!alive || abortedRef.current) return;
          patchCur((m) => ({ ...m, text: m.text + tokenOf(p) }));
        }),
      );
      unsubs.push(
        await subscribe("ai-card-received", (p) => {
          if (!alive || abortedRef.current) return;
          const card = cardOf(p);
          if (card) patchCur((m) => ({ ...m, cards: [...m.cards, card] }));
        }),
      );
      unsubs.push(
        await subscribe("ai-session-complete", (p) => {
          if (!alive) return;
          const sm = sessionMetaOf(p);
          if (sm) setMeta(t("ai.sessionDone", { sid: sm.sid }));
        }),
      );
      unsubs.push(
        await subscribe("ai-chat-complete", () => {
          if (!alive) return;
          curIdRef.current = null;
          abortedRef.current = false;
          setBusyBoth(false);
        }),
      );
    })();
    return () => {
      alive = false;
      unsubs.forEach((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  const send = async (force?: string) => {
    const v = (force ?? q).trim();
    if (!v || busyRef.current) return;
    if (!onlineRef.current) {
      // Offline: echo an agent note so users see why nothing streams.
      setMsgs((prev) =>
        capTail(
          [
            ...prev,
            { id: uid("u"), role: "user", text: v, cards: [] },
            { id: uid("a"), role: "agent", text: t("backend.offline"), cards: [] },
          ],
          CHAT_MSG_CAP,
        ),
      );
      setQ("");
      return;
    }
    setQ("");
    const agent = uid("a");
    curIdRef.current = agent;
    abortedRef.current = false;
    setBusyBoth(true);
    setMeta("");
    setMsgs((prev) =>
      capTail(
        [
          ...prev,
          { id: uid("u"), role: "user", text: v, cards: [] },
          { id: agent, role: "agent", text: "", cards: [] },
        ],
        CHAT_MSG_CAP,
      ),
    );
    const r = await sendChat(v, conversationId());
    // If the command failed to reach the daemon (r == null) no `ai-chat-complete`
    // event will ever fire — clear the busy state so the UI never sticks on "⏹ 停止".
    if (r == null && !abortedRef.current) {
      curIdRef.current = null;
      setBusyBoth(false);
      setMeta(t("backend.offline"));
    }
  };

  const stop = () => {
    if (!busyRef.current) return;
    abortedRef.current = true;
    const r = cancelAiSession();
    // Best-effort: if cancellation couldn't reach the daemon, drop busy ourselves.
    void r.then((res) => {
      if (res == null) {
        curIdRef.current = null;
        setBusyBoth(false);
        setMeta(t("backend.offline"));
      }
    });
  };

  const clear = () => {
    curIdRef.current = null;
    abortedRef.current = false;
    setBusyBoth(false);
    setMeta("");
    setMsgs([]);
  };

  const clearSess = async (): Promise<void> => {
    await clearSessions();
    setSessions([]);
  };
  const delSess = async (id: string): Promise<void> => {
    await removeSession(id);
    setSessions((prev) => (prev ?? []).filter((s) => s.session_id !== id));
  };

  const lastAgent = [...msgs].reverse().find((m) => m.role === "agent" && m.text);
  const copyReply = async (): Promise<void> => {
    if (!lastAgent?.text) return;
    try {
      await navigator.clipboard?.writeText(lastAgent.text);
      setCopiedReply(true);
      window.setTimeout(() => setCopiedReply(false), 1500);
    } catch {
      /* clipboard unavailable: no-op */
    }
  };

  // Last user question — the target of "↺ resend".
  const lastUserText = [...msgs].reverse().find((m) => m.role === "user" && m.text)?.text;
  const resend = (): void => {
    if (lastUserText && !busyRef.current) void send(lastUserText);
  };

  // Brand-new conversation: clear the bubbles AND rotate the multi-turn id.
  const newChat = (): void => {
    if (busyRef.current) stop();
    clear();
    newConversation();
  };

  // Two-step 清空: first tap arms it, second tap (within a short window) confirms.
  const clearArmed = (): void => {
    if (confirmClear) {
      setConfirmClear(false);
      clear();
      return;
    }
    setConfirmClear(true);
    window.setTimeout(() => setConfirmClear(false), 3000);
  };

  return (
    <div className="flex h-full flex-col p-3">
      <div className="flex items-center gap-2">
        <span className="text-3xl">🤖</span>
        {status && <span className="truncate text-xs opacity-60">{status}</span>}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => void toggleSessions()}
            className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
          >
            {t("ai.sessions")}
            {sessions !== null ? ` ${sessions.length}` : ""}
          </button>
          {msgs.length > 0 && (
            <button
              onClick={newChat}
              className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
            >
              {t("ai.newChat")}
            </button>
          )}
          {lastUserText && !busy && (
            <button
              onClick={resend}
              className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
            >
              {t("ai.resend")}
            </button>
          )}
          {lastAgent && !busy && (
            <button
              onClick={() => void copyReply()}
              className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
            >
              {copiedReply ? "✓" : t("ai.copyReply")}
            </button>
          )}
          <button
            onClick={clearArmed}
            className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
          >
            {confirmClear ? t("ai.clearConfirm") : t("ai.clear")}
          </button>
        </div>
      </div>
      {meta && <p className="mt-0.5 text-[11px] opacity-60">{meta}</p>}
      {sessOpen && (
        <div className="mt-1 space-y-1 rounded-xl bg-neutral-200/50 p-2 text-[11px] dark:bg-neutral-800/50">
          {sessions && sessions.length > 0 && (
            <button
              onClick={() => void clearSess()}
              className="block w-full text-right text-accent hover:underline"
            >
              {t("ai.clearSessions")}
            </button>
          )}
          {sessions && sessions.length > 0 ? (
            sessions.map((s) => (
              <div key={s.session_id} className="flex items-center justify-between gap-2">
                <span className="truncate font-mono">{s.session_id.slice(0, 8)}</span>
                <span className="truncate opacity-70">{s.model}</span>
                <span className="tabular-nums opacity-60">
                  {s.tokens_generated}t · {s.age_seconds}s{s.cancelled ? " · ✕" : ""}
                </span>
                <button
                  onClick={() => void toggleHist(s.session_id)}
                  title={t("ai.history")}
                  className="rounded-full bg-neutral-300 px-1.5 text-xs dark:bg-neutral-700"
                >
                  {showHist === s.session_id ? "▲" : "…"}
                </button>
                <button
                  onClick={() => void delSess(s.session_id)}
                  title={t("ai.removeSession")}
                  className="rounded-full bg-neutral-300 px-1.5 text-xs text-danger dark:bg-neutral-700"
                >
                  ✕
                </button>
              </div>
            ))
          ) : (
            <p className="opacity-60">{t("ai.sessionEmpty")}</p>
          )}
          {showHist && histories[showHist] !== undefined && (
            <div className="max-h-32 space-y-1 overflow-auto border-t pt-1">
              {histories[showHist] === "loading" ? (
                <p className="opacity-50">{t("ai.historyLoading")}</p>
              ) : (histories[showHist] as HistoryTurn[]).length === 0 ? (
                <p className="opacity-60">{t("ai.historyEmpty")}</p>
              ) : (
                (histories[showHist] as HistoryTurn[]).map((tn, i) => (
                  <p key={i} className="leading-snug">
                    <span className={tn.role === "user" ? "" : "opacity-70"}>{tn.role === "user" ? "👤 " : "🤖 "}</span>
                    {tn.text}
                  </p>
                ))
              )}
            </div>
          )}
        </div>
      )}
      {!bridged() ? (
        <p className="mt-1 text-sm opacity-70">{t("backend.inBrowser")}</p>
      ) : !online ? (
        <p className="mt-1 text-sm opacity-70">{t("backend.offline")}</p>
      ) : null}
      <div
        role="log"
        aria-live="polite"
        className="mt-2 flex-1 space-y-2 overflow-auto rounded-2xl bg-neutral-200/40 p-2 text-sm dark:bg-neutral-800/40"
      >
        {msgs.length === 0 ? (
          <p className="py-8 text-center text-xs opacity-40">{t("ai.placeholder")}</p>
        ) : (
          msgs.map((m) => (
            <div
              key={m.id}
              className={
                m.role === "user"
                  ? "ml-auto max-w-[80%] whitespace-pre-wrap rounded-2xl bg-accent px-3 py-2 text-white"
                  : "max-w-[88%] whitespace-pre-wrap rounded-2xl bg-neutral-200/70 px-3 py-2 text-neutral-900 dark:bg-neutral-700/70 dark:text-white"
              }
            >
              {m.text}
              {m.cards.map((c, i) => (
                <AiCardView key={i} card={c} />
              ))}
            </div>
          ))
        )}
      </div>
      <div className="mt-2 flex items-end gap-2">
        {busy && (
          <button
            onClick={stop}
            className="rounded-full bg-danger px-3 py-2 text-xs text-white"
          >
            {t("ai.stop")}
          </button>
        )}
        <StreamVoiceButton
          online={online}
          disabled={busy}
          session={() => conversationId()}
          onStart={() => pushMsg("user", t("ai.voicePrompt"))}
          onReply={(text) => pushMsg("agent", text)}
        />
        <VoiceMicButton
          online={online}
          disabled={busy}
          onTranscript={(tx) => {
            if (tx) setQ(tx);
          }}
        />
        <textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          rows={2}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && void send()}
          placeholder={t("backend.prompt")}
          className="flex-1 resize-none rounded-2xl bg-neutral-200/70 p-2 text-sm outline-none dark:bg-neutral-800/70"
        />
        <button
          onClick={() => void send()}
          disabled={busy}
          className="rounded-full bg-accent px-4 text-white disabled:opacity-40"
        >
          ➤
        </button>
      </div>
    </div>
  );
}


/* ---- Interpreter (同传): lang pair + mic/text -> live transcript + read-aloud ---- */
export function InterpApp() {
  const { t } = useI18n();
  const online = bridged();
  const [prefs, setPrefs] = useState<InterpPrefs>(() => readPrefs());
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [rec, setRec] = useState(false);
  // OS microphone permission gate for the interpreter (see lib/permissions.ts).
  const mic = useCapability("interpreter", "microphone");
  const [askMic, setAskMic] = useState(false);
  const [segs, setSegs] = useState<InterpSeg[]>(() => loadSegs());
  const [partial, setPartial] = useState("");
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [copiedAll, setCopiedAll] = useState(false);
  const [bilingual, setBilingual] = useState(false);

  const sidRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const autospeakRef = useRef(prefs.autospeak);
  autospeakRef.current = prefs.autospeak;
  const onlineRef = useRef(online);
  onlineRef.current = online;

  // Live-capture plumbing (kept in refs so event callbacks stay stable).
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const langLabel = (code: string): string =>
    code === "auto" ? t("interp.auto") : langNative(code) || code;
  const setPref = (patch: Partial<InterpPrefs>) => setPrefs((p) => ({ ...p, ...patch }));

  // Remember the language pair + auto-speak so reopening feels continuous.
  useEffect(() => {
    writePrefs(prefs);
  }, [prefs]);

  const stopMicRef = useRef<() => Promise<void>>(async () => {});
  const stopMic = async (): Promise<void> => {
    try {
      procRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      srcRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await ctxRef.current?.close();
    } catch {
      /* ignore */
    }
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    procRef.current = null;
    srcRef.current = null;
    ctxRef.current = null;
    setRec(false);
  };
  stopMicRef.current = stopMic;

  const startCapture = async (): Promise<void> => {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) return;
    const stream = await media.getUserMedia({ audio: { channelCount: 1 } });
    streamRef.current = stream;
    const Ctx =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      stream.getTracks().forEach((tr) => tr.stop());
      return;
    }
    const ctx = new Ctx();
    ctxRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);
    srcRef.current = src;
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    procRef.current = proc;
    proc.onaudioprocess = (e) => {
      const chunk = e.inputBuffer.getChannelData(0);
      const id = sidRef.current;
      if (id) void interpretAudio(id, frameToChunk(chunk, ctx.sampleRate));
    };
    src.connect(proc);
    proc.connect(ctx.destination);
    setRec(true);
  };

  const resetRunning = () => {
    runningRef.current = false;
    pausedRef.current = false;
    setRunning(false);
    setPaused(false);
  };

  // Stream live interpret-output events -> partials + final transcript + auto-speak.
  useEffect(() => {
    if (!online) return;
    let alive = true;
    const unsubs: (() => void)[] = [];
    (async () => {
      unsubs.push(
        await subscribe("interpret-output", (payload) => {
          if (!alive) return;
          const kind = (payload as { kind?: string } | null)?.kind;
          if (kind === "partial") {
            setPartial(partialTextOf(payload));
          } else if (kind === "segment_final") {
            const seg = segOf(payload);
            if (seg) {
              setSegs((prev) => {
                const next = capTail([...prev, seg], SEG_CAP);
                saveSegs(next);
                return next;
              });
              if (autospeakRef.current && onlineRef.current && seg.target) {
                void speakText(seg.target, seg.targetLang || "zh");
              }
            }
            setPartial("");
          } else if (kind === "utterance_recognized") {
            const u = payload as { text?: unknown };
            if (u && typeof u.text === "string") setPartial(u.text);
          } else if (kind === "session_ended") {
            resetRunning();
            void stopMicRef.current();
            setPartial("");
            setStatus(t("interp.ended"));
          } else if (kind === "error") {
            setStatus("⚠ " + errorOf(payload));
          }
        }),
      );
    })();
    return () => {
      alive = false;
      unsubs.forEach((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  const beginSession = async (): Promise<void> => {
    if (!onlineRef.current) {
      // Daemon isn't reachable — tell the user instead of a silent no-op.
      setStatus(t("backend.offline"));
      return;
    }
    const id = await interpretStart({
      source: prefsRef.current.source,
      target: prefsRef.current.target,
    });
    if (id == null) return;
    sidRef.current = id;
    runningRef.current = true;
    pausedRef.current = false;
    setRunning(true);
    setPaused(false);
    setStatus(`${langLabel(prefsRef.current.source)} → ${langLabel(prefsRef.current.target)}`);
  };

  const endSession = async (): Promise<void> => {
    const id = sidRef.current;
    sidRef.current = null;
    if (id && onlineRef.current) await interpretStop(id);
    await stopMicRef.current();
    resetRunning();
    setStatus("");
  };

  const togglePause = async (): Promise<void> => {
    const id = sidRef.current;
    if (!id) return;
    if (pausedRef.current) {
      await interpretResume(id);
      pausedRef.current = false;
      setPaused(false);
    } else {
      await interpretPause(id);
      pausedRef.current = true;
      setPaused(true);
    }
  };

  const toggleMic = async (): Promise<void> => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setStatus(t("camera.noCamera"));
      return;
    }
    if (rec) {
      await stopMicRef.current();
      return;
    }
    if (!mic.granted) {
      // Two-tap consent: first tap explains, second grants (and records).
      if (!askMic) {
        setAskMic(true);
        setStatus(t("interp.permNeed"));
        return;
      }
      mic.allow();
      setAskMic(false);
      setStatus("");
    } else {
      setAskMic(false);
    }
    if (!runningRef.current) await beginSession();
    if (runningRef.current) await startCapture();
  };

  const send = async (): Promise<void> => {
    const v = text.trim();
    if (!v) return;
    if (!onlineRef.current) {
      // Daemon isn't reachable — keep the typed text and explain instead of
      // clearing it into a silent no-op.
      setStatus(t("backend.offline"));
      return;
    }
    if (!runningRef.current) await beginSession();
    const id = sidRef.current;
    if (id) {
      setText("");
      await interpretText(id, v);
    }
  };

  const speakLast = (seg: InterpSeg) => {
    if (seg.target) void speakText(seg.target, seg.targetLang || "zh");
  };

  const copyTarget = (seg: InterpSeg) => {
    try {
      void navigator.clipboard?.writeText(seg.target);
    } catch {
      /* ignore */
    }
  };

  const clearHistory = () => {
    setSegs([]);
    clearSegs();
  };

  const copyAll = async (): Promise<void> => {
    const text = transcriptText(segs, bilingual);
    if (!text) return;
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedAll(true);
      window.setTimeout(() => setCopiedAll(false), 1500);
    } catch {
      /* clipboard unavailable: no-op */
    }
  };

  return (
    <div className="flex h-full flex-col p-3">
      {!bridged() ? (
        <p className="mb-2 text-sm opacity-70">{t("backend.inBrowser")}</p>
      ) : !online ? (
        <p className="mb-2 text-sm opacity-70">{t("backend.offline")}</p>
      ) : null}

      {/* language pair (remembered) */}
      <div className="flex items-center gap-2 text-sm">
        <span className="opacity-60">{t("interp.source")}</span>
        <select
          aria-label={t("interp.source")}
          value={prefs.source}
          onChange={(e) => setPref({ source: e.target.value })}
          className="flex-1 rounded-full bg-neutral-200 px-2 py-1 text-sm outline-none dark:bg-neutral-800"
        >
          {LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.code === "auto" ? t("interp.auto") : l.native}
            </option>
          ))}
        </select>
        <span className="opacity-50">→</span>
        <select
          aria-label={t("interp.target")}
          value={prefs.target}
          onChange={(e) => setPref({ target: e.target.value })}
          className="flex-1 rounded-full bg-neutral-200 px-2 py-1 text-sm outline-none dark:bg-neutral-800"
        >
          {LANGS.filter((l) => l.code !== "auto").map((l) => (
            <option key={l.code} value={l.code}>
              {l.native}
            </option>
          ))}
        </select>
      </div>

      {/* session controls */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-3xl">🌐</span>
        {running ? (
          <>
            <button
              onClick={() => void endSession()}
              className={btn("danger", "sm")}
            >
              {t("interp.stop")}
            </button>
            <button
              onClick={() => void togglePause()}
              className={btn("neutral", "sm")}
            >
              {paused ? t("interp.resume") : t("interp.pause")}
            </button>
            <button
              onClick={() => void toggleMic()}
              title="mic"
              className={chip(rec)}
            >
              {rec ? "●" : "🎤"}
            </button>
          </>
        ) : (
          <button
            onClick={() => void beginSession()}
            className={btn("accent", "sm")}
          >
            {t("interp.start")}
          </button>
        )}
        {status && <span className="truncate text-xs opacity-60">{status}</span>}
      </div>

      {/* auto-speak read-aloud toggle */}
      <label className="mt-1 flex items-center gap-2 text-xs opacity-80">
        <input
          type="checkbox"
          checked={prefs.autospeak}
          onChange={(e) => setPref({ autospeak: e.target.checked })}
        />
        {t("interp.autospeak")}
      </label>

      {/* transcript header + clear */}
      <div className="mt-2 flex items-center justify-between text-xs opacity-60">
        <span>{t("interp.transcript")}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setBilingual((b) => !b)}
            aria-pressed={bilingual}
            className={
              "rounded-full px-2 py-0.5 text-[11px] " +
              (bilingual
                ? "bg-accent text-white"
                : "bg-neutral-200 dark:bg-neutral-700")
            }
          >
            {t("interp.bilingual")}
          </button>
          <button
            onClick={() => void copyAll()}
            disabled={segs.length === 0}
            className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700 disabled:opacity-40"
          >
            {copiedAll ? "✓" : t("interp.copyAll")}
          </button>
          <button
            onClick={clearHistory}
            className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
          >
            {t("interp.clear")}
          </button>
        </div>
      </div>

      <div
        role="log"
        aria-live="polite"
        className="mt-1 min-h-[80px] flex-1 space-y-2 overflow-auto rounded-2xl bg-neutral-200/40 p-2 text-sm dark:bg-neutral-800/40"
      >
        {segs.length === 0 && !partial ? (
          <p className="py-8 text-center text-xs opacity-40">
            {running ? t("interp.notRunning") : "—"}
          </p>
        ) : (
          <>
            {segs.map((seg, i) => (
              <div key={i} className="rounded-xl bg-neutral-200/60 p-2 dark:bg-neutral-800/60">
                <div className="flex items-center gap-1 text-[10px] opacity-50">
                  <span>{seg.srcLang ? langLabel(seg.srcLang) : "源"}</span>
                  <span className="truncate">{seg.src}</span>
                </div>
                <div className="text-sm font-medium text-accent">{seg.target}</div>
                <div className="mt-1 flex gap-1">
                  <button
                    onClick={() => speakLast(seg)}
                    className="rounded-full bg-neutral-300 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
                  >
                    {t("interp.read")}
                  </button>
                  <button
                    onClick={() => copyTarget(seg)}
                    title={t("interp.copied")}
                    className="rounded-full bg-neutral-300 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
                  >
                    ⧉
                  </button>
                </div>
              </div>
            ))}
            {partial && (
              <div className="rounded-xl bg-accent/10 p-2 text-sm italic opacity-80">
                … {partial}
              </div>
            )}
          </>
        )}
      </div>

      {/* text-input translate */}
      <div className="mt-2 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
          placeholder={t("interp.placeholder")}
          className="flex-1 rounded-full bg-neutral-200 px-3 py-2 text-sm outline-none dark:bg-neutral-800"
        />
        <button onClick={() => void send()} className="rounded-full bg-accent px-4 text-sm text-white">
          {t("interp.send")}
        </button>
      </div>
    </div>
  );
}




