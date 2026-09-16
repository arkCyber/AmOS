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
  <!-- systemStatus aria-label: the live-status section's accessible name — a screen
       reader that lands on any row in this <section> hears "System status" before the
       row label, so the live readings are situated in their containing region rather
       than reading as bare "Battery 67%". (REQ-A284) -->
  <section class={GROUP} aria-label={t("a11y.systemStatus")}>
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
      <!-- aria-live="polite" + aria-atomic="true": the visible label and the changing
           percentage both go to assistive tech as one utterance ("Battery 67%"). The
           label is duplicated in the aria text on purpose — when the user lands on this
           row they hear WHAT is changing and TO WHAT, not just the new number. (REQ-A284) -->
      <span class={VALUE} aria-live="polite" aria-atomic="true">
        <span class="sr-only">{t("settings.aboutBattery")}: </span>{batteryLabel}
      </span>
    </div>
    {#if probeStamp}
      <div class="px-4 pb-3" data-testid="about-probe">
        <!-- sr-only probeLabel: a screen-reader user who tabs onto the live timestamp hears
             "Last updated: 14:32:07" — without the prefix the bare time reads as a number
             out of context. (REQ-A284) -->
        <p class={HINT} aria-live="polite">
          <span class="sr-only">{t("a11y.probeLabel")}: </span>{t("settings.aboutProbe", { time: probeStamp })}
        </p>
      </div>
    {/if}
    <div class={ROW} data-testid="about-cellular">
      <span class={LABEL}>{t("settings.aboutCellular")}</span>
      <!-- Same polite live-region pattern: cellular signal can shift edge/4G/5G; the
           visible label + the new state announce together. (REQ-A284) -->
      <span class={VALUE} aria-live="polite" aria-atomic="true">
        <span class="sr-only">{t("settings.aboutCellular")}: </span>{cellularValue}
      </span>
    </div>
  </section>
  {#if !connected}
    <p class="px-1 text-xs opacity-50">{t("settings.aboutOffline")}</p>
  {/if}
</div>
