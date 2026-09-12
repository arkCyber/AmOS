<script lang="ts">
  // DeviceMicButton.svelte — always-on **native** mic listen for the assistant.
  //
  // This is the frontend reach path for the Rust `device_mic_start/stop/status`
  // commands (the AAudio seam in `amos-tauri/src/assistant_voice.rs`): tapping
  // opens the platform mic through `amos_audio::PlatformMic` on-device and runs a
  // resident capture thread that streams `Payload::Audio` and auto-finalizes each
  // utterance on trailing silence.
  //
  // Replies are NOT subscribed here: AiApp.svelte owns the SINGLE
  // `assistant-voice-event` `turn_done` sink and turns every finalized utterance
  // into one agent bubble. Because the native listen and the push-to-talk path
  // share that one daemon `Chat` stream / event channel, a second per-button
  // subscription would double every reply bubble — so this control only manages
  // the mic (start/stop/status), and it never depends on StreamVoiceButton being
  // mounted to show a reply.
  //
  // Honesty: a real device mic exists only in a Tauri **Android** build with
  // `amos-audio/aaudio`. Outside the bridge (browser) the button is disabled with
  // an offline tooltip; on a bridged host without a native mic `deviceMicStart`
  // degrades to `null` and we surface an honest "no native mic" note — never a
  // fabricated "listening".
  import {
    bridgeDiag,
    deviceMicStart,
    deviceMicStatus,
    deviceMicStop,
    micPermissionRequest,
    micPermissionState,
  } from "../lib/backend";
  import type { MicPermissionState } from "../lib/backend";
  import { isNativeMicBackend } from "../lib/deviceMic";
  import { loadLedger, capSet, type Capability } from "../lib/permissions";
  import { grantCapability, revokeCapability } from "./osPermissions";
  import { t } from "./locale.svelte";

  const MIC: Capability = "microphone";
  let {
    online,
    session,
    disabled = false,
  }: {
    online: boolean;
    /** Lazily supply the conversation id (only fetched when the user starts the
     * native listen) — never call a side-effecting getter during render. */
    session: () => string;
    disabled?: boolean;
  } = $props();

  let running = $state(false);
  let busy = $state(false);
  let note = $state("");
  let micGranted = $state(capSet(loadLedger(), "ai", MIC));
  let ask = $state(false);
  /**
   * The OS's own `RECORD_AUDIO` state, read ONCE when bridged. The button's gate
   * above reads the LOCAL ledger; if the grant was revoked outside AmOS the two
   * disagree, and the user should learn that from the title BEFORE pressing
   * (otherwise a press looks like a no-op). This is the **dialog-free** read — it
   * never prompts; only a user-initiated `start()` calls `micPermissionRequest`.
   */
  let osMic = $state<MicPermissionState | null>(null);
  $effect(() => {
    if (!online) return;
    void micPermissionState().then((s) => {
      osMic = s;
    });
  });
  const osDenied = $derived(!!osMic && osMic.native && !osMic.granted);
  /** Utterances submitted (`AudioEnd`) by the running worker — live proof that the
   * AAudio capture → resident-worker → daemon path is actually delivering. */
  let submitted = $state(0);

  // Live status sync: while the device is bridged, poll the resident worker so an
  // externally-started/stopped listen is reflected and the submitted count stays
  // fresh (an engineer can confirm capture is alive before speaking). No polling
  // offline / in the browser — `deviceMicStatus` degrades to null there anyway.
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    if (!online) return;
    if (pollHandle) return; // already polling on this online window
    const tick = async () => {
      const st = await deviceMicStatus();
      if (!st) return;
      if (st.backend === "none") {
        // Worker not running; reflect an external stop without clearing a local
        // denial note the user may still want to read.
        running = false;
        return;
      }
      running = st.running;
      if (st.running && isNativeMicBackend(st.backend)) {
        submitted = st.submitted;
      }
    };
    void tick();
    pollHandle = setInterval(() => void tick(), 1000);
    return () => {
      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
    };
  });

  async function start(): Promise<void> {
    if (!online || disabled || busy || running) return;
    if (!micGranted) {
      ask = true;
      return;
    }
    busy = true;
    note = "";
    try {
      // Native AAudio capture needs the OS RECORD_AUDIO grant, which the WebView
      // getUserMedia path alone does not guarantee. Ask for it (mic-only, on the
      // device) before opening the mic; on a host there is no grant to ask for and
      // micPermissionRequest honestly reports native:false.
      const perm = await micPermissionRequest();
      const nativeMic = !!perm && !!perm.native;
      const granted = !!perm && !!perm.granted;
      if (!nativeMic || !granted) {
        note = t("ai.deviceMicUnavailable");
        return;
      }
      const label = await deviceMicStart(session());
      if (label && isNativeMicBackend(label)) {
        running = true;
        submitted = 0; // new listen session starts its own count
      } else {
        const diag = bridgeDiag();
        note =
          !diag.ok && diag.kind === "not-bridged"
            ? t("ai.deviceMicOffline")
            : t("ai.deviceMicUnavailable");
      }
    } finally {
      busy = false;
    }
  }

  async function stop(): Promise<void> {
    if (!running) return;
    busy = true;
    try {
      await deviceMicStop();
    } finally {
      running = false;
      busy = false;
    }
  }

  const toggle = () => (running ? void stop() : void start());

  const allowMic = () => {
    grantCapability("ai", MIC);
    micGranted = true;
    ask = false;
    void start();
  };
  const denyMic = () => {
    revokeCapability("ai", MIC);
    micGranted = false;
    ask = false;
  };

  const disabledState = $derived(disabled || !online || busy);
  const title = $derived(
    !online
      ? t("ai.deviceMicOffline")
      : running
        ? `${t("ai.deviceMicListening")} · ${t("ai.deviceMicSubmitted", { n: submitted })}`
        : note || (osDenied ? t("ai.deviceMicDenied") : t("ai.deviceMicTitle")),
  );
</script>

<span class="relative inline-flex shrink-0">
  <button
    type="button"
    aria-label="device voice input"
    onclick={toggle}
    disabled={disabledState}
    title={title}
    class={"grid h-9 w-9 shrink-0 place-items-center rounded-full text-base " +
      (running
        ? "bg-accent text-white"
        : "bg-neutral-300 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200") +
      (disabledState ? " opacity-40" : "")}
  >{running ? "●" : "🎧"}</button>
  {#if ask}
    <span class="absolute bottom-full right-0 z-30 mb-2 flex items-center gap-2 whitespace-nowrap rounded-xl bg-white px-2.5 py-1.5 text-xs shadow ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10">
      <span class="opacity-80">{t("perm.micAsk")}</span>
      <button type="button" onclick={allowMic} class="rounded-full bg-accent px-2 py-0.5 text-white">{t("perm.allow")}</button>
      <button type="button" onclick={denyMic} class="rounded-full bg-neutral-200 px-2 py-0.5 dark:bg-neutral-700">{t("perm.deny")}</button>
    </span>
  {/if}
</span>
