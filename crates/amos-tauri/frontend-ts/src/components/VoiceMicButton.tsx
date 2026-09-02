import { useEffect, useRef, useState } from "react";
import { transcribeAudio } from "../lib/backend";
import {
  hasSignal,
  parseTranscribe,
  pcmToWavBytes,
  voiceReducer,
  type VoiceStatus,
} from "../lib/voice";

function concat(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Voice → ASR mic button for the AI app: tap to record, tap again to transcribe
 * the clip via the translate daemon (`transcribe_audio`, WAV). Offline / no
 * result degrades to the idle state; the caller decides how to surface the text.
 */
export default function VoiceMicButton({
  online,
  disabled,
  onTranscript,
}: {
  online: boolean;
  disabled?: boolean;
  onTranscript: (text: string) => void;
}) {
  const [status, setStatus] = useState<VoiceStatus>("idle");

  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const bufRef = useRef<Float32Array[]>([]);
  const rateRef = useRef(16000);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cleanup = () => {
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
      void ctxRef.current?.close();
    } catch {
      /* ignore */
    }
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    procRef.current = null;
    srcRef.current = null;
    ctxRef.current = null;
    streamRef.current = null;
  };

  const next = (a: Parameters<typeof voiceReducer>[1]) =>
    setStatus((s) => voiceReducer(s, a));

  const start = async () => {
    if (!online) return;
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) return;
    next({ type: "start" });
    try {
      const stream = await media.getUserMedia({ audio: { channelCount: 1 } });
      if (!mountedRef.current) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      streamRef.current = stream;
      const Ctx =
        window.AudioContext ??
        (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) {
        stream.getTracks().forEach((tr) => tr.stop());
        next({ type: "fail" });
        return;
      }
      const ctx = new Ctx();
      ctxRef.current = ctx;
      rateRef.current = ctx.sampleRate || 16000;
      const src = ctx.createMediaStreamSource(stream);
      srcRef.current = src;
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      procRef.current = proc;
      bufRef.current = [];
      proc.onaudioprocess = (e) => {
        bufRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      src.connect(proc);
      proc.connect(ctx.destination);
    } catch {
      if (mountedRef.current) next({ type: "fail" });
    }
  };

  const stop = async () => {
    if (status !== "recording") return;
    next({ type: "stop" });
    const frames = concat(bufRef.current);
    const sourceRate = rateRef.current;
    cleanup();
    // Not bridged, silent, or empty clip -> cannot transcribe (degrade).
    if (!online || !hasSignal(frames)) {
      if (mountedRef.current) next({ type: "fail" });
      return;
    }
    const bytes = pcmToWavBytes(frames, sourceRate);
    const res = await transcribeAudio(bytes, { format: "wav" });
    if (!mountedRef.current) return;
    const parsed = res && parseTranscribe(res);
    if (parsed && parsed.recognized && parsed.text.trim()) {
      onTranscript(parsed.text.trim());
      next({ type: "ok" });
    } else {
      next({ type: "fail" });
    }
  };

  const recording = status === "recording";
  const transcribing = status === "transcribing";
  const clickable = online && !disabled && !transcribing;

  return (
    <button
      type="button"
      onClick={() => {
        if (transcribing) return;
        if (recording) void stop();
        else void start();
      }}
      disabled={!clickable}
      title={online ? "语音输入（ASR）" : "离线：语音不可用"}
      aria-label="voice input"
      className={
        "grid h-9 w-9 shrink-0 place-items-center rounded-full text-base " +
        (recording
          ? "bg-danger text-white"
          : transcribing
            ? "bg-neutral-200 text-neutral-400 dark:bg-neutral-700"
            : "bg-neutral-300 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200") +
        (disabled || !online ? " opacity-40" : "")
      }
    >
      {recording ? "●" : transcribing ? "…" : "🎤"}
    </button>
  );
}
