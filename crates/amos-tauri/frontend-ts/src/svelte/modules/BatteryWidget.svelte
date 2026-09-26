<script lang="ts">
  /**
   * BatteryWidget.svelte — the desktop top bar's battery read-out.
   *
   * The reading is REAL, and comes from `lib/batterySources` (the same live
   * subscription the phone chrome's `StatusBar` uses): the daemon `system_health`
   * block first, else the host OS battery via the `system_host_battery` command,
   * else the browser Battery API. This widget previously hardcoded an unknown
   * sample, so on a desktop host it showed `—` forever while the real level was one
   * call away — the repo's "capability on both sides, nothing connecting them" shape.
   *
   * Honest when it must be: with no daemon and no host reading the sample is
   * `unknown` and the widget shows `—` and no tooltip rather than a made-up number.
   */
  import { batterySvg } from "../../lib/sysIcons";
  import { batteryReadout } from "../../lib/batteryStatus";
  import { createBatterySources } from "../../lib/batterySources.svelte";
  import { t } from "../locale.svelte";
  import { CHROME_TEXT_SHADOW } from "../../lib/shellChrome";

  const battery = createBatterySources();
  const batt = $derived(battery.batt);
  const battTone = $derived(battery.tone);
  /** One read-out for the shown text AND the accessible name (see below). */
  const readout = $derived(batteryReadout(batt));
  const battText = $derived(readout?.pct ?? "—");
  const battName = $derived(
    readout ? t(readout.key, { pct: readout.pct }) : t("a11y.batteryLevel"),
  );
</script>

<!-- The reading must be the NAME, not only the tooltip: `aria-label` overrides both
     the element's content and `title` when the accessible name is computed, so a
     constant label beside a `title={battTitle}` left a screen reader with "Battery
     level" and no level at all (REQ-A1016). Same shape as the home-screen tiles. -->
<span
  aria-label={battName}
  title={readout ? battName : undefined}
  data-testid="chrome-battery"
  class="flex items-center gap-0.5 text-[11px] tabular-nums text-white"
  style="text-shadow: {CHROME_TEXT_SHADOW};"
>
  {@html batterySvg(batt.levelPct === null ? 0 : batt.levelPct, "h-3 w-3", battTone)}
  <span>{battText}</span>
</span>
