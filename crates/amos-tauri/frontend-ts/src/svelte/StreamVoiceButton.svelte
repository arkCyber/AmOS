<script lang="ts">
  // StreamVoiceButton.svelte — Svelte 5 (runes) port of components/StreamVoiceButton.tsx.
  // No React. Hold-to-talk **streaming** assistant voice: on hold it opens the
  // resident daemon Chat via `assistant_voice_start`, streams 16 kHz f32-le frames
  // via `assistant_voice_feed`, and on release force-finalizes with
  // `assistant_voice_end`. The assistant's reply arrives as an
  // `assistant-voice-event` `turn_done` and is reported through `onReply`.
  import { assistantVoiceEnd, assistantVoiceFeed, assistantVoiceStart, subscribe } from "../lib/backend";
  import { pcmToAssistantChunk, parseVoiceEvent } from "../lib/voice";
  import { loadLedger, saveLedger, grantCap, revokeCap, capSet, type Capability } from "../lib/permissions";
  import { t } from "./locale.svelte";

  const MIC: Capability = "microphone";
  let {
    online,
    session,
    onStart,
    onReply,
    disabled = false,
  }: {
    online: boolean;
    /** Lazily supply the conversation id (only fetched when the user starts
     * speaking) — never call a side-effecting getter during render. */
    session: () => string;
    onStart?: () => void;
    onReply: (text: string) => void;
    disabled?: boolean;
  } = $props();

  let recording = $state(false);
  let micGranted = $state(capSet(loadLedger(), "ai", MIC));
  let ask = $state(false);

  // Live-capture plumbing (plain refs).
  let ctxRef: AudioContext | null = null;
  let srcRef: MediaStreamAudioSourceNode | null = null;
  let procRef: ScriptProcessorNode | null = null;
  let streamRef: MediaStream | null = null;

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

  // A reply to any streamed utterance arrives as an `assistant-voice-event`
  // `turn_done` frame — forward it to the caller while mounted.
  let subscribed = false;
  $effect(() => {
    if (subscribed) return;
    subscribed = true;
    let alive = true;
    let unsub: (() => void) | null = null;
    void (async () => {
      unsub = await subscribe("assistant-voice-event", (p) => {
        if (!alive) return;
        const e = parseVoiceEvent(p);
        if (e?.kind === "turn_done" && e.text.trim()) {
          onReply(e.text.trim());
        }
      });
    })();
    return () => {
      alive = false;
      unsub?.();
      cleanup();
    };
  });

  async function start(): Promise<void> {
    if (!online || disabled || recording) return;
    if (!micGranted) {
      ask = true;
      return;
    }
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) return;
    recording = true;
    onStart?.();
    try {
      const sid = session();
      await assistantVoiceStart(sid);
      const stream = await media.getUserMedia({ audio: { channelCount: 1 } });
      if (!stream.getTracks().length) {
        cleanup();
        recording = false;
        return;
      }
      streamRef = stream;
      const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const Ctx = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctx) {
        cleanup();
        recording = false;
        return;
      }
      const ctx = new Ctx();
      ctxRef = ctx;
      const src = ctx.createMediaStreamSource(stream);
      srcRef = src;
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      procRef = proc;
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
      recording = false;
    }
  }

  async function stop(): Promise<void> {
    if (!recording) return;
    cleanup();
    recording = false;
    // Force-finalize the utterance so the daemon answers now (push-to-talk).
    await assistantVoiceEnd();
  }

  const allowMic = () => {
    saveLedger(grantCap(loadLedger(), "ai", MIC));
    micGranted = true;
    ask = false;
    void start();
  };
  const denyMic = () => {
    saveLedger(revokeCap(loadLedger(), "ai", MIC));
    micGranted = false;
    ask = false;
  };
</script>

<span class="relative inline-flex shrink-0">
  <button
    type="button"
    aria-label="streaming voice input"
    onpointerdown={(e) => {
      e.preventDefault();
      if (!recording) void start();
    }}
    onpointerup={() => {
      if (recording) void stop();
    }}
    onpointerleave={() => {
      if (recording) void stop();
    }}
    onclick={() => {
      // Keyboard/touch fallback: toggle.
      if (recording) void stop();
      else void start();
    }}
    disabled={disabled || !online}
    title={online ? t("ai.streamVoiceTitle") : t("ai.streamVoiceOffline")}
    class={"grid h-9 w-9 shrink-0 place-items-center rounded-full text-base " +
      (recording
        ? "bg-danger text-white"
        : "bg-neutral-300 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200") +
      (disabled || !online ? " opacity-40" : "")}
  >{recording ? "●" : "🎙️"}</button>
  {#if ask}
    <span class="absolute bottom-full right-0 z-30 mb-2 flex items-center gap-2 whitespace-nowrap rounded-xl bg-white px-2.5 py-1.5 text-xs shadow ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10">
      <span class="opacity-80">{t("perm.micAsk")}</span>
      <button type="button" onclick={allowMic} class="rounded-full bg-accent px-2 py-0.5 text-white">{t("perm.allow")}</button>
      <button type="button" onclick={denyMic} class="rounded-full bg-neutral-200 px-2 py-0.5 dark:bg-neutral-700">{t("perm.deny")}</button>
    </span>
  {/if}
</span>
