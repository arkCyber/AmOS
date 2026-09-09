<script lang="ts">
  // AboutPage.svelte — 「关于本机」sub page. Shows only genuinely obtainable data:
  // OS/build identity from lib/version (this UI client) plus live device telemetry
  // (battery / charging) from the daemon when bridged via lib/system. Nothing is
  // fabricated — offline device fields show the honest "—" placeholder.
  import {
    systemStatusWithHostBattery,
    normalizeSystemHealth,
    type SystemStatus,
  } from "../../lib/system";
  import { bridged } from "../../lib/backend";
  import { AMOS_OS_NAME, AMOS_UI_VERSION, AMOS_DEVICE_LABEL } from "../../lib/version";
  import { CELLULAR_KEY, defaultCellular, normalizeCellular } from "../../lib/cellular";
  import {
    cellularService,
    cellularStateKey,
    defaultRadioSignal,
  } from "../../lib/cellularService";
  import { readStoreValue } from "../../lib/amosStore";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, VALUE } from "./kit";

  let sys = $state<SystemStatus>(normalizeSystemHealth(null));
  let connected = $state(false);

  $effect(() => {
    if (!bridged()) return;
    connected = true;
    systemStatusWithHostBattery()
      .then((raw) => {
        if (raw) sys = raw;
      })
      .catch(() => {
        /* daemon offline → keep '—' */
      });
  });

  const cellularValue = $derived(
    t(
      cellularStateKey(
        cellularService(
          normalizeCellular(readStoreValue(CELLULAR_KEY, defaultCellular())),
          defaultRadioSignal(),
        ),
      ),
    ),
  );

  const batteryLabel = $derived(
    sys.battery_level_pct === null
      ? "—"
      : `${Math.round(sys.battery_level_pct)}%${sys.battery_charging === true ? " · " + t("settings.aboutCharging") : ""}`,
  );
</script>

<div class="space-y-5">
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.aboutDevice")}</span>
      <span class={VALUE}>{AMOS_DEVICE_LABEL}</span>
    </div>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.aboutOs")}</span>
      <span class={VALUE}>{AMOS_OS_NAME}</span>
    </div>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.aboutVersion")}</span>
      <span class={VALUE}>v{AMOS_UI_VERSION}</span>
    </div>
    <div class={ROW} data-testid="about-battery">
      <span class={LABEL}>{t("settings.aboutBattery")}</span>
      <span class={VALUE}>{batteryLabel}</span>
    </div>
    <div class={ROW} data-testid="about-cellular">
      <span class={LABEL}>{t("settings.aboutCellular")}</span>
      <span class={VALUE}>{cellularValue}</span>
    </div>
  </section>
  {#if !connected}
    <p class="px-1 text-xs opacity-50">{t("settings.aboutOffline")}</p>
  {/if}
</div>
