<script lang="ts">
  /**
   * ClockWidget.svelte — the top bar's clock, **and** the Notification Center's trigger.
   *
   * Owns its own second-ticker (it used to live in `TopBar`, which meant the bar
   * re-rendered its whole right side every second and the ticker could not be
   * tested without mounting the shell). The read-out reserves a fixed width so a
   * wider value does not shift the widgets to its right — see `lib/shellChrome.ts`
   * for why that is a look rule and not a per-widget decision.
   *
   * REQ-A417: on a Mac the clock is **clickable** and opens Notification Center from the
   * right — that is the muscle memory, and the panel landed in this round. The element is
   * therefore a `<button>` (same pattern as `ControlCenterButton`: `toggleOverlay` on click,
   * `aria-expanded` from `isOverlayOpen`, and a handle-less mount that simply does nothing).
   * The time itself stays a nested `role="timer"` element with its own accessible name, so
   * the REQ-A284 contract ("a screen reader can ask what time it is") is unchanged — the
   * button's name says what the click *does*.
   */
  import { getContext } from "svelte";
  import { fmtClock } from "../../lib/time";
  import {
    CHROME_READOUT,
    CHROME_READOUT_MIN_WIDTH,
    CHROME_TEXT_SHADOW,
  } from "../../lib/shellChrome";
  import { SHELL_CHROME_API, type ShellChromeApi } from "../../lib/shellModule";
  import { t } from "../locale.svelte";

  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);
  const open = $derived(api?.isOverlayOpen("notifications") ?? false);

  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });
</script>

<!--
  role="timer" tells assistive tech this is a live readout it can query on demand;
  the *visible* text is the value (current time), and the static aria-label is the
  descriptive name ("Current time") a screen reader uses when the user asks
  "what time is it?". We deliberately do NOT use aria-live — a clock that interrupts
  the screen reader every second is hostile. (REQ-A284)
-->
<button
  type="button"
  data-testid="chrome-clock"
  class={CHROME_READOUT + " rounded-md transition-colors hover:bg-white/10"}
  style="border: none; background: transparent; padding: 0; cursor: pointer; min-width: {CHROME_READOUT_MIN_WIDTH}; text-align: center;"
  aria-label={t("desktop.openNotifications")}
  aria-expanded={open}
  title={t("desktop.openNotifications")}
  onclick={() => api?.toggleOverlay("notifications")}
>
  <!-- The read-out reserves its width on the **button** now (that is the element that
       occupies layout space, so the widgets to its right still do not shift). -->
  <span
    role="timer"
    aria-label={t("a11y.currentTime")}
    style="text-shadow: {CHROME_TEXT_SHADOW};"
  >{fmtClock(now)}</span>
</button>
