import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  assistantVoiceEnd,
  assistantVoiceFeed,
  assistantVoiceStart,
  subscribe,
} from "../lib/backend";
import { pcmToAssistantChunk, parseVoiceEvent } from "../lib/voice";
import { useCapability } from "./CapabilityGate";

/**
 * Hold-to-talk **streaming** assistant voice (vs `VoiceMicButton`'s whole-buffer
 * transcribe): on hold it opens the resident daemon Chat (no prompt) via
 * `assistant_voice_start`, streams live 16 kHz f32-le frames via
 * `assistant_voice_feed`, and on release force-finalizes the utterance with
 * `assistant_voice_end`. The assistant's reply arrives as an
 * `assistant-voice-event` `turn_done` and is reported through `onReply`.
 */
export default function StreamVoiceButton({
  online,
  session,
  onStart,
  onReply,
  disabled = false,
}: {
  online: boolean;
  /** Lazily supply the conversation id (only fetched when the user actually
   * starts speaking) — never call a side-effecting getter during render. */
  session: () => string;
  onStart?: () => void;
  onReply: (text: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const mic = useCapability("ai", "microphone");
  const [recording, setRecording] = useState(false);
  const [ask, setAsk] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;

  // A reply to any streamed utterance arrives as an `assistant-voice-event`
  // `turn_done` frame — forward it to the caller while mounted.
  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | null = null;
    void (async () => {
      unsub = await subscribe("assistant-voice-event", (p) => {
        if (!alive) return;
        const e = parseVoiceEvent(p);
        if (e?.kind === "turn_done" && e.text.trim()) {
          onReplyRef.current(e.text.trim());
        }
      });
    })();
    return () => {
      alive = false;
      unsub?.();
    };
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
  useEffect(() => cleanup, []);

  const start = async () => {
    if (!online || disabled || recording) return;
    if (!mic.granted) {
      setAsk(true);
      return;
    }
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) return;
    setRecording(true);
    onStart?.();
    try {
      const sid = session();
      await assistantVoiceStart(sid);
      const stream = await media.getUserMedia({ audio: { channelCount: 1 } });
      if (!stream.getTracks().length) {
        cleanup();
        setRecording(false);
        return;
      }
      streamRef.current = stream;
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) {
        cleanup();
        setRecording(false);
        return;
      }
      const ctx = new Ctx();
      ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      srcRef.current = src;
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      procRef.current = proc;
      const rate = ctx.sampleRate || 16000;
      proc.onaudioprocess = (e) => {
        const ch = e.inputBuffer?.getChannelData(0);
        if (!ch) return;
        const frame = new Float32Array(ch);
        const bytes = pcmToAssistantChunk(frame, rate);
        if (bytes.length) void assistantVoiceFeed(bytes);
      };
      src.connect(proc);
      proc.connect(ctx.destination);
    } catch {
      cleanup();
      setRecording(false);
    }
  };

  const stop = async () => {
    if (!recording) return;
    cleanup();
    setRecording(false);
    // Force-finalize the utterance so the daemon answers now (push-to-talk).
    await assistantVoiceEnd();
  };

  const allowMic = () => {
    mic.allow();
    setAsk(false);
    void start();
  };
  const denyMic = () => {
    mic.deny();
    setAsk(false);
  };

  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label="streaming voice input"
        onPointerDown={(e) => {
          e.preventDefault();
          if (!recording) void start();
        }}
        onPointerUp={() => {
          if (recording) void stop();
        }}
        onPointerLeave={() => {
          if (recording) void stop();
        }}
        onClick={() => {
          // Keyboard/touch fallback: toggle.
          if (recording) void stop();
          else void start();
        }}
        disabled={disabled || !online}
        title={online ? t("ai.streamVoiceTitle") : t("ai.streamVoiceOffline")}
        className={
          "grid h-9 w-9 shrink-0 place-items-center rounded-full text-base " +
          (recording
            ? "bg-danger text-white"
            : "bg-neutral-300 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200") +
          (disabled || !online ? " opacity-40" : "")
        }
      >
        {recording ? "●" : "🎙️"}
      </button>
      {ask && (
        <span className="absolute bottom-full right-0 z-30 mb-2 flex items-center gap-2 whitespace-nowrap rounded-xl bg-white px-2.5 py-1.5 text-xs shadow ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10">
          <span className="opacity-80">{t("perm.micAsk")}</span>
          <button
            type="button"
            onClick={allowMic}
            className="rounded-full bg-accent px-2 py-0.5 text-white"
          >
            {t("perm.allow")}
          </button>
          <button
            type="button"
            onClick={denyMic}
            className="rounded-full bg-neutral-200 px-2 py-0.5 dark:bg-neutral-700"
          >
            {t("perm.deny")}
          </button>
        </span>
      )}
    </span>
  );
}

