<script lang="ts">
  // WidgetBattery.svelte — the home screen's battery widget.
  //
  // The reading is REAL and comes from `lib/batterySources`, the single live subscription
  // the phone chrome (`StatusBar`) and the desktop top bar (`modules/BatteryWidget`) already
  // share — so the home screen cannot show a level the status bar disagrees with. With no
  // daemon, no host battery and no browser Battery API the sample is `unknown` and the tile
  // says `—` rather than inventing a number.
  //
  // It is a separate component so the subscription exists **only while the widget is
  // placed** (`HomeWidgets` mounts it inside the `{#if}`): a home screen with no battery
  // widget must not poll the host every 5 s.
  import { batterySvg } from "../../lib/sysIcons";
  import { batteryReadout } from "../../lib/batteryStatus";
  import { createBatterySources } from "../../lib/batterySources.svelte";
  import { t } from "../locale.svelte";

  let { onopen }: { onopen: () => void } = $props();

  const battery = createBatterySources();
  const batt = $derived(battery.batt);
  const battTone = $derived(battery.tone);
  /** One read-out for the shown text AND the accessible name (see below). */
  const readout = $derived(batteryReadout(batt));
  const battText = $derived(readout?.pct ?? "—");
  const battTitle = $derived(readout ? t(readout.key, { pct: readout.pct }) : undefined);
</script>

<!-- The reading has to be the *label*: `title` only names an element when no `aria-label`
     is present, so a constant label beside a `title` makes the tooltip the only spelling
     of the level — which a screen reader never reads. Same shape as the clock tile in
     `HomeWidgets`, which names itself `${t("a11y.currentTime")} · HH:MM`. The sentence
     itself comes from `lib/batteryStatus::batteryReadout`, shared with the three other
     battery surfaces (REQ-A1016) rather than hand-copied here. -->
<button
  class="flex items-center justify-center gap-2 rounded-3xl bg-white/40 px-5 py-4 shadow-sm ring-1 ring-black/5 backdrop-blur-md transition active:scale-95 dark:bg-white/10 dark:ring-white/10"
  aria-label={battTitle ?? t("widget.battery")}
  title={battTitle}
  data-testid="home-widget-battery"
  onclick={onopen}
>
  <span aria-hidden="true" class="text-neutral-800 dark:text-white"
    >{@html batterySvg(batt.levelPct === null ? 0 : batt.levelPct, "h-5 w-7", battTone)}</span
  >
  <span
    class="text-xl font-medium tabular-nums text-neutral-900 dark:text-white"
    data-testid="home-widget-battery-value">{battText}</span
  >
</button>
