<script lang="ts">
  /**
   * ScreenRecordingTile.svelte — the Control Center's system-screen-recording control
   * (REQ-A1580).
   *
   * This is the front door the host's four `screen_record_*` commands never had: they were
   * implemented and registered but **no screen called them** (`tauri-command-scan` named all
   * four). The seam is `lib/screenRecord.ts`; the host side is
   * `crates/amos-tauri/src/screen_record.rs`.
   *
   * The three honest reads this panel keeps apart, precisely:
   *
   *   * **capability** (`null` = the host did not answer) — the only thing that may say
   *     recording is impossible here. A real `false` carries the host's own reason, shown
   *     verbatim rather than re-worded here (one story about why, not two).
   *   * **status** (`null` = did not answer) — distinct from "idle" via
   *     `recordingPhase`, so a missing answer never draws a stopped recorder over a live
   *     session.
   *   * **a refusal on start/stop** — the host foreground-gates both
   *     (`require_screen_record_foreground`): only the window the user is looking at may
   *     begin/end a whole-screen capture. A refused call resolves `null`; this panel says
   *     so instead of silently doing nothing.
   */
  import { onMount, onDestroy } from "svelte";
  import { t } from "./locale.svelte";
  import { amosWarn } from "../lib/debugLog";
  import { bridgeDiag } from "../lib/backend";
  import {
    recordingClock,
    recordingLabelKey,
    recordingPhase,
    screenRecordCapability,
    screenRecordStart,
    screenRecordStatus,
    screenRecordStop,
    type ScreenRecordCapability,
    type ScreenRecordStatus,
  } from "../lib/screenRecord";

  /** `null` = the host did not answer the capability question (not "unavailable"). */
  let capability = $state<ScreenRecordCapability | null>(null);
  /** `null` = the host did not answer the status question (see `recordingPhase`). */
  let status = $state<ScreenRecordStatus | null>(null);
  /** A start/stop is in flight, so a second tap is refused locally rather than racing one. */
  let busy = $state(false);
  /** The last refusal, in the user's language (REQ-A467). */
  let error = $state<string | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;

  const phase = $derived(recordingPhase(status));
  const clock = $derived(recordingClock(status));
  const live = $derived(phase === "recording" || phase === "stopping");
  const canStart = $derived(capability?.available === true);
  /** The label for the tile; a missing capability read is its own sentence, not "unsupported". */
  const labelKey = $derived(
    capability === null && phase === "idle" ? "cc.record.capabilityUnknown" : recordingLabelKey(phase),
  );

  async function refreshStatus(): Promise<void> {
    status = await screenRecordStatus();
  }

  /**
   * Record *why* a refused call was refused (the log half), the same way the topbar's
   * `noteFailure` does: the typed code when the host threw an `AmosError`, otherwise the
   * diagnostic kind (`not-bridged` — no host at all — is a different fault from a foreground
   * refusal, and the ledger is the only place that distinction survives).
   */
  function noteRefusal(command: string): void {
    const diag = bridgeDiag(command);
    if (diag.ok) return;
    const code =
      diag.kind === "command-failed" && diag.detail && typeof diag.detail === "object"
        ? (diag.detail as { code?: string }).code
        : undefined;
    amosWarn("screenrecord", `${command} refused`, code ?? diag.kind);
  }

  async function start(): Promise<void> {
    busy = true;
    error = null;
    const next = await screenRecordStart();
    if (next === null) {
      error = t("cc.record.refused");
      noteRefusal("screen_record_start");
    } else {
      status = next;
    }
    busy = false;
  }

  async function stop(): Promise<void> {
    busy = true;
    error = null;
    const next = await screenRecordStop();
    if (next === null) {
      error = t("cc.record.refused");
      noteRefusal("screen_record_stop");
    } else {
      status = next;
    }
    busy = false;
  }

  onMount(() => {
    void screenRecordCapability().then((cap) => (capability = cap));
    void refreshStatus();
    // Poll on a cadence, **not** gated on the phase. A start is a *request*, not a recording:
    // on Android `screen_record_start` posts a system consent dialog and answers before the
    // user has approved, so the status it returns is legitimately idle and the session begins
    // later with nobody telling this panel (the same is true of a session another window
    // started — the host pushes no event). Gating every tick on the phase therefore meant the
    // tile never observed the capture its own Start button had requested: it kept saying "not
    // recording" while the top bar's indicator — which polls on an always-on cadence for
    // exactly this reason — was already marking it (REQ-A1653 ∕ F-SH-843).
    timer = setInterval(() => void refreshStatus(), 1000);
    return () => {
      if (timer !== null) clearInterval(timer);
    };
  });

  onDestroy(() => {
    if (timer !== null) clearInterval(timer);
  });
</script>

<div class="mt-2" data-testid="cc-record">
  <div class="flex items-center gap-2 rounded-xl bg-white/10 px-2.5 py-2.5 text-white/80">
    <span data-icon="record" class="grid h-5 w-5 place-items-center" aria-hidden="true">
      <span
        class="h-2.5 w-2.5 rounded-full {phase === 'recording'
          ? 'bg-red-500 animate-pulse'
          : 'bg-white/40'}"
      ></span>
    </span>
    <div class="min-w-0 flex-1">
      <div class="text-[12px] font-medium leading-tight">{t("cc.record.title")}</div>
      <div class="text-[10px] leading-tight opacity-70" data-testid="cc-record-state">
        {t(labelKey)}{clock ? ` · ${clock}` : ""}
      </div>
    </div>
    {#if live}
      <button
        class="rounded-lg bg-white/15 px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-white/25 disabled:opacity-40"
        data-testid="cc-record-stop"
        disabled={busy || phase === "stopping"}
        onclick={() => void stop()}
      >{t("cc.record.stop")}</button>
    {:else}
      <button
        class="rounded-lg bg-white/15 px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="cc-record-start"
        disabled={busy || !canStart}
        title={capability?.available === false ? capability.reason : t("cc.record.start")}
        onclick={() => void start()}
      >{t("cc.record.start")}</button>
    {/if}
  </div>

  {#if capability !== null && !capability.available}
    <!-- The host's own words: the UI must not invent a second reason for the same fact. -->
    <p class="mt-1 px-1 text-[10px] leading-snug text-white/50" data-testid="cc-record-unavailable">
      {capability.reason}
    </p>
  {/if}
  {#if capability === null}
    <p class="mt-1 px-1 text-[10px] leading-snug text-white/50" data-testid="cc-record-capability">
      {t("cc.record.capabilityUnknown")}
    </p>
  {/if}
  {#if error !== null}
    <p role="status" class="mt-1 px-1 text-[11px] leading-snug text-danger" data-testid="cc-record-refused">
      {error}
    </p>
  {/if}
</div>
