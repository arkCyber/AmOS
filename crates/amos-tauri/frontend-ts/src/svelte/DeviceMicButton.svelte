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
  import { IDLE_MIC_BACKEND, isNativeMicBackend } from "../lib/deviceMic";
  import { loadLedger, capSet, type Capability } from "../lib/permissions";
  import { grantCapability, revokeCapability } from "./osPermissions";
  import { t } from "./locale.svelte";
  import StoreErrorBar from "./StoreErrorBar.svelte";

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
  /**
   * A **stop the host never confirmed**. While this is set the indicator stays ON and
   * says so — see `stop()`. The button is the only place the user can see that an
   * always-on mic is live, so "we could not confirm it stopped" must never be worded
   * as "it is off" (REQ-A826 / F-SH-261).
   */
  let stopFailed = $state(false);
  let micGranted = $state(capSet(loadLedger(), "ai", MIC));
  let ask = $state(false);
  /** The ledger write's refusal, shown inside the still-open prompt (`StoreErrorBar`). */
  let storeErr = $state("");
  /**
   * The OS's own `RECORD_AUDIO` state, read ONCE when bridged. The button's gate
   * above reads the LOCAL ledger; if the grant was revoked outside AmOS the two
   * disagree, and the user should learn that from the title BEFORE pressing
   * (otherwise a press looks like a no-op). This is the **dialog-free** read — it
   * never prompts; only a user-initiated `start()` calls `micPermissionRequest`.
   *
   * The reply is a **state**, not a bare `granted` bit (REQ-A787 / F-AND-010): a
   * failed read and a denied grant used to be the same `false`, so the title told
   * the user 「系统未授予麦克风权限」 — a fact about their own settings — whenever
   * the read had merely failed. Only `"denied"` earns that sentence; `"unreadable"`
   * and `"timed-out"` say what actually happened and offer a retry.
   */
  let osMic = $state<MicPermissionState | null>(null);
  $effect(() => {
    if (!online) return;
    void micPermissionState().then((s) => {
      osMic = s;
    });
  });
  /** The OS answered "no" — the only state that may be worded as the user's settings. */
  const osDenied = $derived(!!osMic && osMic.native && osMic.state === "denied");
  /**
   * The OS never answered: the read failed (`unreadable`, carrying the host's own
   * words) or the dialog went unanswered past the timeout. Both are "we don't know",
   * and both are retryable — never a claim about the grant itself.
   */
  const osUnknown = $derived(
    !!osMic && (osMic.state === "unreadable" || osMic.state === "timed-out"),
  );
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
      if (st.backend === IDLE_MIC_BACKEND) {
        // Worker not running; reflect an external stop without clearing a local
        // denial note the user may still want to read. The idle marker is the
        // exported constant, not a hand-copied `"none"`: this branch and the stop
        // verdict below are the two places that read it (a re-spelling here is what
        // left `IDLE_MIC_BACKEND` with a test binding and no production reader).
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
    stopFailed = false;
    try {
      // Native AAudio capture needs the OS RECORD_AUDIO grant, which the WebView
      // getUserMedia path alone does not guarantee. Ask for it (mic-only, on the
      // device) before opening the mic; on a host there is no grant to ask for and
      // micPermissionRequest honestly reports native:false.
      const perm = await micPermissionRequest();
      if (!perm || !perm.native) {
        note = t("ai.deviceMicUnavailable");
        return;
      }
      if (!perm.granted) {
        // Same three-way split as the title: only `denied` is the user's own answer
        // (REQ-A787 / F-AND-010).
        note =
          perm.state === "denied"
            ? t("ai.deviceMicDenied")
            : perm.state === "timed-out"
              ? t("ai.deviceMicTimedOut")
              : t("ai.deviceMicUnreadable", { detail: perm.detail ?? "" });
        return;
      }
      const label = await deviceMicStart(session());
      if (label && isNativeMicBackend(label)) {
        running = true;
        submitted = 0; // new listen session starts its own count
      } else {
        // Per-command diagnosis: the bridge's global last-outcome slot could belong to a
        // *different* command by now, which here would decide between "offline" and
        // "no native mic" (REQ-A296).
        const diag = bridgeDiag("device_mic_start");
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
    stopFailed = false;
    try {
      await deviceMicStop();
      // `device_mic_stop` is a `void` command: its success value is `null`, and `invoke`
      // answers `null` for a call that failed too (it **never rejects** — it records the
      // reason in the per-command diagnosis and returns `null`). So the reply cannot tell
      // "stopped" from "we could not reach the host". The verdict is the diagnosis — the
      // same slot `start()` reads (REQ-A296). Reading it off the value instead is exactly
      // how the indicator went dark on a stop nobody confirmed, while the resident capture
      // thread kept running: this button is the user's only evidence that an always-on mic
      // is live, so the unconfirmed direction must never be worded as "off".
      if (bridgeDiag("device_mic_stop").ok) {
        running = false;
        return;
      }
      // Unconfirmed. Ask the host what is actually true rather than guessing: the idle
      // marker is its own "no capture thread is running".
      const st = await deviceMicStatus();
      if (st && st.backend === IDLE_MIC_BACKEND) {
        running = false;
        return;
      }
      // The host either still reports a capture, or cannot be reached at all. Neither is a
      // stopped microphone, so the indicator stays on and says why. (If the host is really
      // gone the capture is gone with it — but we cannot *prove* that from here, and for a
      // microphone the honest error is to keep showing it live.)
      stopFailed = true;
    } finally {
      busy = false;
    }
  }

  const toggle = () => (running ? void stop() : void start());

  // `micGranted` is seeded from the persisted ledger (`capSet(loadLedger(), …)`), so it is a
  // *display of* `amos.permissions` — the ledger every OS capability gate reads back. The
  // prompt's answer must adopt the write's own verdict, not the intent: on a refused write
  // `grantCapability`/`revokeCapability` answer the ledger the store still holds, and the adopted
  // value decides whether the prompt may close. The refused revoke is the dangerous direction —
  // the user believes the always-on mic was withdrawn while `loadLedger()` still grants it — so
  // that case keeps the prompt up and says why.
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

  const disabledState = $derived(disabled || !online || busy);
  const title = $derived(
    !online
      ? t("ai.deviceMicOffline")
      : running
        ? stopFailed
          ? t("ai.deviceMicStopUnconfirmed")
          : `${t("ai.deviceMicListening")} · ${t("ai.deviceMicSubmitted", { n: submitted })}`
        : note ||
          (osDenied
            ? t("ai.deviceMicDenied")
            : osUnknown
              ? osMic?.state === "timed-out"
                ? t("ai.deviceMicTimedOut")
                : t("ai.deviceMicUnreadable", { detail: osMic?.detail ?? "" })
              : t("ai.deviceMicTitle")),
  );
</script>

<span class="relative inline-flex shrink-0">
  <!-- The live/off difference is a ● glyph plus a background class, and `aria-label` overrides the
       glyph for the accessible name — so an always-on microphone announced itself as 「设备语音输入」
       whether it was recording or not. `title` carried the state (and still does, for sighted
       users); AT needs it in the state channel. REQ-A1001 / F-SH-322. -->
  <button
    type="button"
    aria-label={t("a11y.deviceVoiceInput")}
    aria-pressed={running}
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
