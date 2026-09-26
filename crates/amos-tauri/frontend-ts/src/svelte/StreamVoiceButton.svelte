<script lang="ts">
  // StreamVoiceButton.svelte — Svelte 5 (runes) port of the former React
  // StreamVoiceButton (removed with the React shell; this is the only implementation).
  // Hold-to-talk **streaming** assistant voice: on hold it opens the
  // resident daemon Chat via `assistant_voice_start`, streams 16 kHz f32-le frames
  // via `assistant_voice_feed`, and on release force-finalizes with
  // `assistant_voice_end`.
  //
  // The assistant's reply is NOT subscribed here: the host screen (AiApp.svelte)
  // owns the SINGLE `assistant-voice-event` `turn_done` sink and turns it into an
  // agent bubble. Keeping that sink in exactly one place means a reply — whether
  // from this push-to-talk mic or from the always-on native device mic — renders
  // exactly once (no double bubbles), and DeviceMicButton never has to depend on
  // this button being mounted.
  import { assistantVoiceEnd, assistantVoiceFeed, assistantVoiceStart, assistantVoiceStop, bridgeDiag } from "../lib/backend";
  import { pcmToAssistantChunk } from "../lib/voice";
  import { loadLedger, capSet, type Capability } from "../lib/permissions";
  import { grantCapability, revokeCapability } from "./osPermissions";
  import { t } from "./locale.svelte";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { onDestroy } from "svelte";

  const MIC: Capability = "microphone";
  let {
    online,
    session,
    onStart,
    onError,
    disabled = false,
  }: {
    online: boolean;
    /** Lazily supply the conversation id (only fetched when the user starts
     * speaking) — never call a side-effecting getter during render. */
    session: () => string;
    onStart?: () => void;
    /** The host refused a unit-returning voice command (by name); the screen that renders
     *  this button owns the status line, so the reason is reported there, not swallowed. */
    onError?: (command: string) => void;
    disabled?: boolean;
  } = $props();

  let recording = $state(false);
  let micGranted = $state(capSet(loadLedger(), "ai", MIC));
  let ask = $state(false);
  /** The ledger write's refusal, shown inside the still-open prompt (`StoreErrorBar`). */
  let storeErr = $state("");
  /** True once the host opened a resident listener we must later cancel. */
  let sessionOpen = false;

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

  // A reply to any streamed utterance is rendered by the host screen's single
  // `assistant-voice-event` sink — see the header comment. No per-button
  // subscription here, so a device-mic reply and a push-to-talk reply can never
  // both forward (no double bubbles) and DeviceMicButton doesn't need this button.

  // Release the mic capture (getUserMedia tracks + AudioContext) if this
  // component unmounts mid-hold, so no orphaned stream/context is left behind.
  $effect(() => {
    return () => {
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
    try {
      const sid = session();
      await assistantVoiceStart(sid);
      // `assistant_voice_start` returns `Result<(), AmosError>`: the host's `Ok(())` reaches the
      // bridge as the very same `null` a refusal does (REQ-A297). Unread, a listener the host
      // never opened looked exactly like one it had — local capture started, every frame went to
      // nothing, no reply ever came, and the parent had already been told the user spoke.
      if (!bridgeDiag("assistant_voice_start").ok) {
        recording = false;
        onError?.("assistant_voice_start");
        return;
      }
      // The daemon is listening now, so the parent's "you spoke" bubble is no longer premature.
      onStart?.();
      // From here on the daemon holds a resident listener: even if the local
      // capture fails below, teardown must cancel it.
      sessionOpen = true;
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
    // `assistant_voice_end` is `Result<(), String>`, so success and refusal arrive as the same
    // `null`; a refusal means the utterance was never finalized and no reply is coming, which
    // must be said rather than left as silence (REQ-A297).
    if (!bridgeDiag("assistant_voice_end").ok) onError?.("assistant_voice_end");
  }

  // `assistant_voice_start` opens a **resident** daemon listener (a long-lived
  // `Chat` stream that keeps relaying replies), while `assistant_voice_end` only
  // finalizes the current utterance. So releasing the button must NOT cancel the
  // listener (that would cut off the answer) — but it has to be torn down when
  // this button goes away, or the mic session outlives the UI forever: nothing
  // ever called `assistant_voice_stop`, so every press leaked a resident
  // listener. Cancel is a no-op on the host when nothing is active.
  onDestroy(() => {
    if (!sessionOpen) return; // never opened one → nothing to cancel
    sessionOpen = false;
    // Fire-and-forget, and here that is a fact about the host rather than a hope:
    // `invoke` cannot reject (REQ-A296), so both the `try`/`catch` and the `.catch()`
    // this used to carry were unreachable code; and the whole host path cannot refuse —
    // `assistant_voice_stop` (`crates/amos-tauri/src/assistant_voice.rs:368`) returns
    // `Ok(())` unconditionally, and `VoiceSession::stop` (`:287`) discards even the mpsc
    // send's result (`let _ =`). So the only failure left is having no usable bridge —
    // the same condition under which no listener was ever opened. Nothing to render
    // either way: this runs while the component is being destroyed. `invoke` still
    // records the outcome in the per-command diagnosis
    // (`bridgeDiag("assistant_voice_stop")`), which is where a future reader of a real
    // refusal would find it.
    void assistantVoiceStop();
  });

  // `micGranted` is seeded from the persisted ledger (`capSet(loadLedger(), …)`), so it is a
  // *display of* `amos.permissions` — the ledger every OS capability gate reads back. The
  // prompt's answer must adopt the write's own verdict, not the intent: on a refused write
  // `grantCapability`/`revokeCapability` answer the ledger the store still holds, and the adopted
  // value decides whether the prompt may close. The refused revoke is the dangerous direction —
  // the user believes the mic was withdrawn while `loadLedger()` still grants it.
  const allowMic = () => {
    const res = grantCapability("ai", MIC);
    micGranted = capSet(res.ledger, "ai", MIC);
    if (!micGranted) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    ask = false;
    void start();
  };
  const denyMic = () => {
    const res = revokeCapability("ai", MIC);
    micGranted = capSet(res.ledger, "ai", MIC);
    if (micGranted) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    ask = false;
  };
</script>

<span class="relative inline-flex shrink-0">
  <!-- Push-to-talk: the ● glyph and the red class are the only "capturing" signals, and the static
       `aria-label` overrides that glyph for the accessible name — so the mic announced the same
       name while held down as while idle. `aria-pressed` reports the hold (REQ-A1001 / F-SH-322). -->
  <button
    type="button"
    aria-label={t("a11y.streamingVoiceInput")}
    aria-pressed={recording}
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
    <span class="absolute bottom-full right-0 z-30 mb-2 flex flex-col gap-1 rounded-xl bg-white px-2.5 py-1.5 text-xs shadow ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10">
      <span class="flex items-center gap-2 whitespace-nowrap">
        <span class="opacity-80">{t("perm.micAsk")}</span>
        <button type="button" onclick={allowMic} class="rounded-full bg-accent px-2 py-0.5 text-white">{t("perm.allow")}</button>
        <button type="button" onclick={denyMic} class="rounded-full bg-neutral-200 px-2 py-0.5 dark:bg-neutral-700">{t("perm.deny")}</button>
      </span>
      <StoreErrorBar message={storeErr} />
    </span>
  {/if}
</span>
