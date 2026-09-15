<script lang="ts">
  /**
   * ClockWidget.svelte — the top bar's clock.
   *
   * Owns its own second-ticker (it used to live in `TopBar`, which meant the bar
   * re-rendered its whole right side every second and the ticker could not be
   * tested without mounting the shell). The read-out reserves a fixed width so a
   * wider value does not shift the widgets to its right — see `lib/shellChrome.ts`
   * for why that is a look rule and not a per-widget decision.
   */
  import { fmtClock } from "../../lib/time";
  import { CHROME_READOUT, CHROME_READOUT_MIN_WIDTH, CHROME_TEXT_SHADOW } from "../../lib/shellChrome";

  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });
</script>

<span
  data-testid="chrome-clock"
  class={CHROME_READOUT}
  style="text-shadow: {CHROME_TEXT_SHADOW}; min-width: {CHROME_READOUT_MIN_WIDTH}; text-align: center;"
>{fmtClock(now)}</span>
