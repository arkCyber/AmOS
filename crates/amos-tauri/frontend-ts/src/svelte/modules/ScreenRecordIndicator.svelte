<script lang="ts">
  /**
   * ScreenRecordIndicator.svelte — the top bar's live screen-recording marker (REQ-A1581).
   *
   * Why this exists and the Control Center tile is not enough: the tile is inside a
   * popover the user has to open, so with the popover closed **nothing on screen says a
   * whole-screen capture is running** — and the host's own rule leans on there being such
   * a marker. `screen_record_status` is deliberately *not* foreground-gated
   * (`screen_record::require_screen_record_foreground`) precisely because "a recording is
   * running" is the fact this indicator is already showing to anyone looking at the
   * screen. This component is that sentence made true.
   *
   * Three states, kept apart by `recordingPhase` (never folded here):
   *   * `unknown` — the host did not answer. Rendered as **nothing**, deliberately: a
   *     marker drawn from a missing answer would either invent a recording or invent its
   *     absence, and the bar has no room to explain which.
   *   * `recording` / `stopping` — the marker is drawn, with the elapsed clock.
   *   * `idle` — nothing.
   *
   * Polling, not an event: the host pushes no event for a session that started in another
   * window, and one `screen_record_status` call is cheap (a lock read, no child awaited).
   * The cadence is slower while nothing is live, so an idle bar is not a per-second host
   * call with nothing to show.
   *
   * The stop button is the indicator's own: a user who sees REC in the bar should not have
   * to hunt for the popover. The host foreground-gates the stop, and a refusal is
   * **rendered** rather than logged-only — a button that silently does nothing is the
   * shape this repo keeps removing.
   */
  import { onMount, onDestroy } from "svelte";
  import { t } from "../locale.svelte";
  import { amosWarn } from "../../lib/debugLog";
  import { bridgeDiag } from "../../lib/backend";
  import {
    recordingClock,
    recordingPhase,
    screenRecordStatus,
    screenRecordStop,
    type ScreenRecordStatus,
  } from "../../lib/screenRecord";

  /** While a session is live: a one-second clock. While idle: a cheap "did one start?" probe. */
  const LIVE_POLL_MS = 1000;
  const IDLE_POLL_MS = 2000;

  let status = $state<ScreenRecordStatus | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The poll re-arms **after** its `await`, so a teardown that happens while a read is in
   * flight would clear a `timer` that is still `null` and let the continuation arm a fresh
   * tick on a destroyed widget — a loop that runs for the rest of the process (REQ-A1611 ∕
   * F-SH-813; `lifetime-scan` R1 sees only `setInterval`, so this shape is ungated). The
   * flag is what the **polling** continuation checks before re-arming the next tick. It is
   * not needed in `stop` below: that continuation arms nothing and writes only the reading
   * the user's own click produced, so it has no tick to leak.
   */
  let alive = true;

  const phase = $derived(recordingPhase(status));
  const clock = $derived(recordingClock(status));
  const live = $derived(phase === "recording" || phase === "stopping");

  function noteRefusal(command: string): void {
    const diag = bridgeDiag(command);
    if (diag.ok) return;
    const code =
      diag.kind === "command-failed" && diag.detail && typeof diag.detail === "object"
        ? (diag.detail as { code?: string }).code
        : undefined;
    amosWarn("screenrecord", `${command} refused`, code ?? diag.kind);
  }

  async function poll(): Promise<void> {
    const next = await screenRecordStatus();
    // The widget may have been torn down while this read was in flight (see `alive`).
    if (!alive) return;
    status = next;
    // A refusal about stopping is moot once the session it concerned has ended; any other
    // poll leaves it up so a refused stop stays readable beside the marker.
    if (recordingPhase(next) === "idle") error = null;
    const wait =
      recordingPhase(next) === "recording" || recordingPhase(next) === "stopping"
        ? LIVE_POLL_MS
        : IDLE_POLL_MS;
    timer = setTimeout(() => void poll(), wait);
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
    alive = true;
    void poll();
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
    };
  });

  onDestroy(() => {
    alive = false;
    if (timer !== null) clearTimeout(timer);
  });
</script>

<!--
  The root is **always** rendered, empty when there is nothing to say. The bar is a
  registry container (`TopBar.svelte`) whose contract is "one node per registered module,
  in registry order" (`topbar-container.svelte.test.ts`), so a widget that unmounted its
  own root would change the slot's child list with the recording state. An empty flex row
  draws nothing, so the user sees exactly what the state warrants.
-->
<div class="flex items-center gap-1.5" data-testid="chrome-record">
  {#if live || error !== null}
    {#if live}
      <span
        class="h-2 w-2 rounded-full {phase === 'recording' ? 'bg-red-500 animate-pulse' : 'bg-white/40'}"
        data-testid="chrome-record-dot"
        aria-hidden="true"
      ></span>
      <span
        class="text-[11px] tabular-nums text-white/90"
        data-testid="chrome-record-clock"
        title={t("cc.record.title")}
      >{phase === "stopping" ? t("cc.record.stopping") : clock}</span>
      <button
        class="rounded px-1 text-[11px] leading-none text-white/80 transition-colors hover:text-white disabled:opacity-40"
        data-testid="chrome-record-stop"
        disabled={busy || phase === "stopping"}
        title={t("cc.record.stop")}
        aria-label={t("cc.record.stop")}
        onclick={() => void stop()}
      >■</button>
    {/if}
    {#if error !== null}
      <span
        role="status"
        class="text-[10px] leading-none text-danger"
        data-testid="chrome-record-refused"
      >{error}</span>
    {/if}
  {/if}
</div>
