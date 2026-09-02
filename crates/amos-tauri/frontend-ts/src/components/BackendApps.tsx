import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  bridged,
  cancelAiSession,
  conversationId,
  getAiStatus,
  interpretAudio,
  interpretPause,
  interpretResume,
  interpretStart,
  interpretStop,
  interpretText,
  sendChat,
  subscribe,
} from "../lib/backend";
import { frameToChunk } from "../lib/audio";
import { speakText } from "../lib/realtimeTts";
import VoiceMicButton from "./VoiceMicButton";
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
  writePrefs,
  type InterpPrefs,
  type InterpSeg,
} from "../lib/interp";

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

  useEffect(() => {
    if (!online) return;
    let alive = true;
    const unsubs: (() => void)[] = [];
    getAiStatus().then((s) => {
      if (alive && s?.model) setStatus(`${s.model} · ${s.active_sessions ?? 0} 会话`);
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

  const send = async () => {
    const v = q.trim();
    if (!v || busyRef.current) return;
    if (!onlineRef.current) {
      // Offline: echo an agent note so users see why nothing streams.
      setMsgs((prev) => [
        ...prev,
        { id: uid("u"), role: "user", text: v, cards: [] },
        { id: uid("a"), role: "agent", text: t("backend.offline"), cards: [] },
      ]);
      setQ("");
      return;
    }
    setQ("");
    const agent = uid("a");
    curIdRef.current = agent;
    abortedRef.current = false;
    setBusyBoth(true);
    setMeta("");
    setMsgs((prev) => [
      ...prev,
      { id: uid("u"), role: "user", text: v, cards: [] },
      { id: agent, role: "agent", text: "", cards: [] },
    ]);
    await sendChat(v, conversationId());
  };

  const stop = () => {
    if (!busyRef.current) return;
    abortedRef.current = true;
    void cancelAiSession();
  };

  const clear = () => {
    curIdRef.current = null;
    abortedRef.current = false;
    setBusyBoth(false);
    setMeta("");
    setMsgs([]);
  };

  return (
    <div className="flex h-full flex-col p-3">
      <div className="flex items-center gap-2">
        <span className="text-3xl">🤖</span>
        {status && <span className="truncate text-xs opacity-60">{status}</span>}
        <button
          onClick={clear}
          className="ml-auto rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
        >
          {t("ai.clear")}
        </button>
      </div>
      {meta && <p className="mt-0.5 text-[11px] opacity-60">{meta}</p>}
      {!online && <p className="mt-1 text-sm opacity-70">{t("backend.offline")}</p>}
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
  const [segs, setSegs] = useState<InterpSeg[]>(() => loadSegs());
  const [partial, setPartial] = useState("");
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");

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
                const next = [...prev, seg];
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
    if (!onlineRef.current) return;
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
    if (!runningRef.current) await beginSession();
    if (runningRef.current) await startCapture();
  };

  const send = async (): Promise<void> => {
    const v = text.trim();
    if (!v) return;
    setText("");
    if (!runningRef.current) {
      if (!onlineRef.current) return;
      await beginSession();
    }
    const id = sidRef.current;
    if (id && onlineRef.current) await interpretText(id, v);
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

  return (
    <div className="flex h-full flex-col p-3">
      {!online && <p className="mb-2 text-sm opacity-70">{t("backend.offline")}</p>}

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
              className="rounded-full bg-danger px-3 py-1 text-xs text-white"
            >
              {t("interp.stop")}
            </button>
            <button
              onClick={() => void togglePause()}
              className="rounded-full bg-neutral-300 px-3 py-1 text-xs dark:bg-neutral-700"
            >
              {paused ? t("interp.resume") : t("interp.pause")}
            </button>
            <button
              onClick={() => void toggleMic()}
              title="mic"
              className={
                "rounded-full px-3 py-1 text-xs " +
                (rec ? "bg-accent text-white" : "bg-neutral-300 dark:bg-neutral-700")
              }
            >
              {rec ? "●" : "🎤"}
            </button>
          </>
        ) : (
          <button
            onClick={() => void beginSession()}
            className="rounded-full bg-accent px-3 py-1 text-xs text-white"
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
        <button
          onClick={clearHistory}
          className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
        >
          {t("interp.clear")}
        </button>
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




