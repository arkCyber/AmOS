import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  bridged,
  conversationId,
  getAiStatus,
  interpretAudio,
  interpretStart,
  interpretStop,
  sendChat,
  subscribe,
} from "../lib/backend";
import { frameToChunk } from "../lib/audio";
import { onInterpFinal, speakText } from "../lib/realtimeTts";
import { chatLogInit, onAiToken, onAiComplete, onInterpOutput, type ChatLog, type InterpLine } from "../lib/stream";

/* ---- AI Assistant: real chat_agent + streaming ai-token-received rendering ---- */
export function AiApp() {
  const { t } = useI18n();
  const online = bridged();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [log, setLog] = useState<ChatLog>(() => chatLogInit());

  useEffect(() => {
    if (!online) return;
    let alive = true;
    const unsubs: (() => void)[] = [];
    getAiStatus().then((s) => {
      if (alive && s?.model) setStatus(`${s.model} · ${s.active_sessions ?? 0} 会话`);
    });
    (async () => {
      unsubs.push(await subscribe("ai-token-received", (p) => setLog((l) => onAiToken(l, p))));
      unsubs.push(await subscribe("ai-chat-complete", () => setLog((l) => onAiComplete(l))));
    })();
    return () => {
      alive = false;
      unsubs.forEach((f) => f());
    };
  }, [online]);

  const send = async () => {
    const v = q.trim();
    if (!v) return;
    setLog(chatLogInit());
    setQ("");
    if (online) await sendChat(v, conversationId());
  };

  return (
    <div className="flex h-full flex-col p-3">
      <div className="flex items-center gap-2">
        <span className="text-3xl">🤖</span>
        {status && <span className="text-xs opacity-60">{status}</span>}
      </div>
      {!online && <p className="mt-1 text-sm opacity-70">{t("backend.offline")}</p>}
      <div
        role="log"
        aria-live="polite"
        className="mt-2 min-h-[80px] flex-1 whitespace-pre-wrap overflow-auto rounded-2xl bg-neutral-200/50 p-3 text-sm dark:bg-neutral-800/50"
      >
        {log.text || (online ? "…" : "")}
      </div>
      <div className="mt-2 flex gap-2">
        <textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          rows={2}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && void send()}
          placeholder={t("backend.prompt")}
          className="flex-1 resize-none rounded-2xl bg-neutral-200/70 p-2 text-sm outline-none dark:bg-neutral-800/70"
        />
        <button onClick={() => void send()} className="rounded-full bg-accent px-4 text-white">
          ➤
        </button>
      </div>
    </div>
  );
}

/* ---- Interpreter (同传): live transcript + mic + read-aloud ---- */
export function InterpApp() {
  const { t } = useI18n();
  const online = bridged();
  const [lines, setLines] = useState<InterpLine[]>([]);
  const [rec, setRec] = useState(false);
  const [, setSid] = useState<string | null>(null);
  const sidRef = useRef<string | null>(null);
  const setSession = (id: string | null) => {
    setSid(id);
    sidRef.current = id;
  };
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!online) return;
    const unsubs: (() => void)[] = [];
    (async () => {
      unsubs.push(
        await subscribe("interpret-output", (p) => {
          setLines((ls) => onInterpOutput({ lines: ls }, p).lines);
          // Real-time read-aloud: only final segments are spoken (mock/real Piper).
          void onInterpFinal(p);
        }),
      );
    })();
    return () => unsubs.forEach((f) => f());
  }, [online]);

  const speak = () => {
    const last = lines[lines.length - 1];
    if (!last?.target) return;
    // Speak via the Rust TTS backend (real local Piper when configured), not the
    // browser's built-in voice.
    void speakText(last.target, "zh");
  };
  const startCapture = async (): Promise<void> => {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) return;
    const stream = await media.getUserMedia({ audio: { channelCount: 1 } });
    streamRef.current = stream;
    const Ctx =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      stream.getTracks().forEach((t) => t.stop());
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

  const stopCapture = async (): Promise<void> => {
    const id = sidRef.current;
    if (id) await interpretStop(id);
    setSession(null);
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
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setRec(false);
  };

  const toggleMic = async () => {
    if (rec) {
      await stopCapture();
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
    if (online) {
      const s = await interpretStart({ source: "auto", target: "zh" });
      if (!s) return;
      setSession(s);
    }
    await startCapture();
  };

  return (
    <div className="flex h-full flex-col p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-3xl">🌐</span>
        <span>{t("backend.source")}</span>
        <span className="opacity-50">→</span>
        <span>{t("backend.target")}</span>
        <button
          onClick={toggleMic}
          className={"rounded-full px-3 py-1 text-xs " + (rec ? "bg-danger text-white" : "bg-neutral-300 dark:bg-neutral-700")}
        >
          {rec ? "●" : "🎤"}
        </button>
        <button onClick={speak} className="rounded-full bg-neutral-300 px-3 py-1 text-xs dark:bg-neutral-700">
          🔊
        </button>
      </div>
      {!online && <p className="mt-1 text-sm opacity-70">{t("backend.offline")}</p>}
      <div role="log" aria-live="polite" className="mt-2 flex-1 space-y-2 overflow-auto">
        {lines.length === 0 ? (
          <p className="py-10 text-center text-sm opacity-50">—</p>
        ) : (
          lines.map((l, i) => (
            <div key={i} className="rounded-2xl bg-neutral-200/50 p-2 dark:bg-neutral-800/50">
              <div className="text-xs opacity-60">{l.src}</div>
              <div className="text-sm font-medium text-accent">{l.target}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

