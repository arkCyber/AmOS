<script lang="ts">
  // VoiceMicButton.svelte — Svelte 5 (runes) port of components/VoiceMicButton.tsx.
  // No React. Voice → ASR one-shot mic button: tap to record, tap again to
  // transcribe the clip via the translate daemon (`transcribe_audio`, WAV) and
  // surface the text through `onTranscript`. The voice state machine + PCM→WAV
  // logic reuse lib/voice.ts; mic capture degrades silently when unavailable.
  import { transcribeAudio } from "../lib/backend";
  import {
    hasSignal,
    parseTranscribe,
    pcmToWavBytes,
    voiceReducer,
    type VoiceStatus,
  } from "../lib/voice";
  import { loadLedger, saveLedger, grantCap, revokeCap, capSet, type Capability } from "../lib/permissions";
  import { t } from "./locale.svelte";

  const MIC: Capability = "microphone";
  let {
    online,
    disabled = false,
    appId = "ai",
    onTranscript,
  }: {
    online: boolean;
    disabled?: boolean;
    /** Built-in app requesting the microphone (defaults to the AI app). */
    appId?: string;
    onTranscript: (text: string) => void;
  } = $props();

  // Plain const seed is unnecessary — appId is read only in reactive contexts.
  let status = $state<VoiceStatus>("idle");
  // OS microphone permission gate (persisted ledger for `appId`).
  let micGranted = $state(false);
  let seeded = false;
  $effect(() => {
    if (seeded) return;
    seeded = true;
    micGranted = capSet(loadLedger(), appId, MIC);
  });
  let ask = $state(false);

  // Live-capture plumbing (plain refs).
  let ctxRef: AudioContext | null = null;
  let srcRef: MediaStreamAudioSourceNode | null = null;
  let procRef: ScriptProcessorNode | null = null;
  let streamRef: MediaStream | null = null;
  let buf: Float32Array[] = [];
  let rate = 16000;
  let mounted = true;

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

  function cleanup(): void {
    try {
      procRef?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      srcRef?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      void ctxRef?.close();
    } catch {
      /* ignore */
    }
    streamRef?.getTracks().forEach((tr) => tr.stop());
    procRef = null;
    srcRef = null;
    ctxRef = null;
    streamRef = null;
  }

  $effect(() => {
    return () => {
      mounted = false;
      cleanup();
    };
  });

  const recording = $derived(status === "recording");
  const transcribing = $derived(status === "transcribing");
  const clickable = $derived(online && !disabled && !transcribing);

  const next = (a: { type: "start" } | { type: "stop" } | { type: "ok" } | { type: "fail" }) => {
    status = voiceReducer(status, a);
  };

  async function start(): Promise<void> {
    if (!online) return;
    if (!micGranted) {
      ask = true; // prompt before touching the microphone
      return;
    }
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) return;
    next({ type: "start" });
    try {
      const stream = await media.getUserMedia({ audio: { channelCount: 1 } });
      if (!mounted) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      streamRef = stream;
      const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const Ctx = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctx) {
        stream.getTracks().forEach((tr) => tr.stop());
        next({ type: "fail" });
        return;
      }
      const ctx = new Ctx();
      ctxRef = ctx;
      rate = ctx.sampleRate || 16000;
      const src = ctx.createMediaStreamSource(stream);
      srcRef = src;
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      procRef = proc;
      buf = [];
      proc.onaudioprocess = (e) => {
        buf.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      src.connect(proc);
      proc.connect(ctx.destination);
    } catch {
      if (mounted) next({ type: "fail" });
    }
  }

  async function stop(): Promise<void> {
    if (status !== "recording") return;
    next({ type: "stop" });
    const frames = concat(buf);
    const sourceRate = rate;
    cleanup();
    // Not bridged, silent, or empty clip -> cannot transcribe (degrade).
    if (!online || !hasSignal(frames)) {
      if (mounted) next({ type: "fail" });
      return;
    }
    const bytes = pcmToWavBytes(frames, sourceRate);
    const res = await transcribeAudio(bytes, { format: "wav" });
    if (!mounted) return;
    const parsed = res && parseTranscribe(res);
    if (parsed && parsed.recognized && parsed.text.trim()) {
      onTranscript(parsed.text.trim());
      next({ type: "ok" });
    } else {
      next({ type: "fail" });
    }
  }

  const allowMic = () => {
    saveLedger(grantCap(loadLedger(), appId, MIC));
    micGranted = true;
    ask = false;
    void start();
  };
  const denyMic = () => {
    saveLedger(revokeCap(loadLedger(), appId, MIC));
    micGranted = false;
    ask = false;
  };
</script>

<span class="relative inline-flex shrink-0">
  <button
    type="button"
    aria-label="voice input"
    onclick={() => {
      if (transcribing) return;
      if (recording) void stop();
      else void start();
    }}
    disabled={!clickable}
    title={online ? t("ai.voiceInputTitle") : t("ai.streamVoiceOffline")}
    class={"grid h-9 w-9 shrink-0 place-items-center rounded-full text-base " +
      (recording
        ? "bg-danger text-white"
        : transcribing
          ? "bg-neutral-200 text-neutral-400 dark:bg-neutral-700"
          : "bg-neutral-300 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200") +
      (disabled || !online ? " opacity-40" : "")}
  >{recording ? "●" : transcribing ? "…" : "🎤"}</button>
  {#if ask}
    <span class="absolute bottom-full right-0 z-30 mb-2 flex items-center gap-2 whitespace-nowrap rounded-xl bg-white px-2.5 py-1.5 text-xs shadow ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10">
      <span class="opacity-80">{t("perm.micAsk")}</span>
      <button type="button" onclick={allowMic} class="rounded-full bg-accent px-2 py-0.5 text-white">{t("perm.allow")}</button>
      <button type="button" onclick={denyMic} class="rounded-full bg-neutral-200 px-2 py-0.5 dark:bg-neutral-700">{t("perm.deny")}</button>
    </span>
  {/if}
</span>
