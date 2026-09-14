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
  import { GROUP, ROW, LABEL, VALUE, HINT } from "./kit";

  let sys = $state<SystemStatus>(normalizeSystemHealth(null));
  let connected = $state(false);
  let lastProbe = $state(0);

  // REQ-A204 (same defect class as REQ-A79): a one-shot battery read goes stale
  // the moment it is taken. While this page is open, re-probe the daemon every
  // 10 s — visible tab only — and stamp each answer so the readout always shows
  // when it was last taken. A null answer (daemon dropped) resets the row to the
  // honest "—" instead of leaving an old percentage on screen.
  const ABOUT_PROBE_MS = 10_000;
  $effect(() => {
    if (!bridged()) return;
    connected = true;
    let alive = true;
    const probe = async () => {
      const raw = await systemStatusWithHostBattery();
      if (!alive) return;
      sys = raw ?? normalizeSystemHealth(null);
      lastProbe = Date.now();
    };
    void probe();
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void probe();
    }, ABOUT_PROBE_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
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

  const probeStamp = $derived(
    lastProbe === 0
      ? ""
      : new Date(lastProbe).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
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
    {#if probeStamp}
      <div class="px-4 pb-3" data-testid="about-probe">
        <p class={HINT}>{t("settings.aboutProbe", { time: probeStamp })}</p>
      </div>
    {/if}
    <div class={ROW} data-testid="about-cellular">
      <span class={LABEL}>{t("settings.aboutCellular")}</span>
      <span class={VALUE}>{cellularValue}</span>
    </div>
  </section>
  {#if !connected}
    <p class="px-1 text-xs opacity-50">{t("settings.aboutOffline")}</p>
  {/if}
</div>
