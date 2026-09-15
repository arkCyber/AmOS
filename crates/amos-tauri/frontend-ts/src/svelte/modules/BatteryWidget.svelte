<script lang="ts">
  /**
   * BatteryWidget.svelte — the top bar's battery read-out.
   *
   * Honest by construction: `lib/batteryStatus.ts` supplies the tone and an
   * **unknown** sample while no host reading exists, and the widget then shows `—`
   * and no tooltip rather than a made-up percentage. The placeholder call is the
   * same one `TopBar` used; wiring `system_health` is the follow-up, and it changes
   * only this file.
   */
  import { batterySvg } from "../../lib/sysIcons";
  import { batteryTone, firstBattery } from "../../lib/batteryStatus";
  import { t } from "../locale.svelte";
  import { CHROME_TEXT_SHADOW } from "../../lib/shellChrome";

  // batt 占位：桌面形态下从顶层 daemon 读取 system_health（Phase 2 实测接入）。
  const batt = $derived(firstBattery([{ levelPct: null, charging: null }]));
  const battTone = $derived(batteryTone(batt));
  const battText = $derived(batt.levelPct === null ? "—" : `${Math.round(batt.levelPct)}%`);
  const battTitle = $derived(
    batt.levelPct === null
      ? undefined
      : t(batt.charging === true ? "a11y.batteryCharging" : "a11y.battery", { pct: battText }),
  );
</script>

<span
  aria-label={t("a11y.batteryLevel")}
  title={battTitle}
  data-testid="chrome-battery"
  class="flex items-center gap-0.5 text-[11px] tabular-nums text-white"
  style="text-shadow: {CHROME_TEXT_SHADOW};"
>
  {@html batterySvg(batt.levelPct === null ? 0 : batt.levelPct, "h-3 w-3", battTone)}
  <span>{battText}</span>
</span>
