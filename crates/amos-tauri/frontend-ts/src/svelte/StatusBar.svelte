<script lang="ts">
  // StatusBar.svelte — Svelte 5 (runes) shell chrome. It is a pure "island": no
  // external props/events — it reads the shared stores (quick settings /
  // flashlight / sound / wifi) and live time/online, and is mounted by
  // Shell.svelte.
  //
  // Battery & network here are REAL, not cosmetic:
  //  • Level/charging come from `system_health` (daemon → amos-monitor, the
  //    authoritative on-device reading) falling back to the host OS Battery API;
  //    only when neither answers do we show an honest "—" (never a fabricated
  //    countdown). Charging → green, low → amber, critical → red.
  //  • Wi‑Fi reflects genuine connectivity (radio toggle AND the SSID we have
  //    actually joined in `amos.wifi` AND real internet via `navigator.onLine`),
  //    not merely that the toggle is flipped.
  import { fmtClock } from "../lib/time";
  import {
    SETTINGS_KEY,
    FLASHLIGHT_KEY,
    normalizeFlashlight,
    normalizeQuick,
    torchOn,
  } from "../lib/settings";
  import { SOUND_KEY, normalizeSound, effectiveAlert } from "../lib/sound";
  import { createStoreValue } from "./store";
  import { batterySvg, iconSvg, radioIcon } from "../lib/sysIcons";
  import { WIFI_KEY, normalizeWifi } from "../lib/wifi";
  // The live battery subscription lives in `lib/batterySources` so this bar and the
  // desktop top bar's `BatteryWidget` resolve the reading the same way.
  import { createBatterySources } from "../lib/batterySources.svelte";
  import { batteryReadout } from "../lib/batteryStatus";
  import { statusIcons } from "../lib/netStatus";
  import { deviceChrome } from "../lib/formLayout";
  import type { FormFactor } from "../lib/wm";
  import { t } from "./locale.svelte";

  // Which device class the shell is drawing for. Optional and defaulting to the phone
  // (no host / preview build ⇒ today's chrome) — the same "a missing payload never
  // gains a capability" rule `HomeDock`'s grid follows. It decides exactly one thing:
  // the **Dynamic Island** is an iPhone screen cutout, so it is not drawn on a Mac
  // (see `lib/formLayout::deviceChrome`).
  let { form = "phone" }: { form?: FormFactor } = $props();
  const chrome = $derived(deviceChrome(form));

  const settingsStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  const flashStore = createStoreValue<unknown>(FLASHLIGHT_KEY, {});
  const soundStore = createStoreValue<unknown>(SOUND_KEY, {});
  const wifiStore = createStoreValue<unknown>(WIFI_KEY, {});
  let settingsRaw = $state<unknown>({});
  let flashRaw = $state<unknown>({});
  let soundRaw = $state<unknown>({});
  let wifiRaw = $state<unknown>({});
  let now = $state(new Date());
  let online = $state(typeof navigator !== "undefined" ? navigator.onLine : true);

  // The live battery subscription (daemon `system_health` first, host OS second) lives
  // in `lib/batterySources` — shared with the desktop top bar's BatteryWidget so both
  // resolve the reading the same way.
  const battery = createBatterySources();

  $effect(() => {
    const un = settingsStore.subscribe((v) => (settingsRaw = v));
    return un;
  });
  $effect(() => {
    const un = flashStore.subscribe((v) => (flashRaw = v));
    return un;
  });
  $effect(() => {
    const un = soundStore.subscribe((v) => (soundRaw = v));
    return un;
  });
  $effect(() => {
    const un = wifiStore.subscribe((v) => (wifiRaw = v));
    return un;
  });
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });
  $effect(() => {
    const on = () => (online = true);
    const off = () => (online = false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  });

  const quick = $derived(normalizeQuick(settingsRaw));
  const flashOn = $derived(torchOn(normalizeFlashlight(flashRaw)));
  const wifi = $derived(normalizeWifi(wifiRaw));
  // Wi‑Fi reads as "connected" only when enabled AND genuinely joined to a network
  // (the host is online, or we hold the joined SSID) — see lib/netStatus.
  const icons = $derived(statusIcons(quick, online, wifi.current));
  const dnd = $derived(!!quick.dnd);
  const effective = $derived(effectiveAlert(normalizeSound(soundRaw), dnd));
  // Persistent alert indicators: moon while Do-Not-Disturb; else a muted bell
  // when the ring/vibrate policy mutes alerts. Nothing extra in the default state.
  const alertIcon = $derived(
    dnd ? ("moon" as const) : effective.ring || effective.vibrate ? null : ("mutedBell" as const),
  );

  // Shown battery = authoritative daemon reading, else host-OS (Tauri) reading,
  // else browser Battery API, else honestly unknown.
  const batt = $derived(battery.batt);
  const battTone = $derived(battery.tone);
  /** The shared read-out: the shown text AND the accessible name (see the span). */
  const readout = $derived(batteryReadout(batt));
  const battText = $derived(readout?.pct ?? "—");
  const battName = $derived(readout ? t(readout.key, { pct: readout.pct }) : t("a11y.batteryLevel"));
</script>

<div class="relative flex items-center justify-between px-4 pb-1 pt-3 text-xs font-semibold text-neutral-900 dark:text-neutral-100">
  <!-- role="timer": the visible time is the value; aria-label names it for on-demand query.
       No aria-live: the chrome bar already broadcasts at most once a minute via the network/battery
       span below, which is what the screen reader user actually wants to hear. (REQ-A284) -->
  <span class="tabular-nums" role="timer" aria-label={t("a11y.currentTime")}>{fmtClock(now)}</span>
  <!-- Dynamic Island: iPhone hardware (a screen cutout), so it is drawn only for the
       class that has it. In a macOS window it was an invented black pill. -->
  {#if chrome.dynamicIsland}
    <span
      aria-hidden="true"
      data-testid="dynamic-island"
      class="pointer-events-none absolute left-1/2 top-[9px] h-[22px] w-[112px] -translate-x-1/2 rounded-full bg-black shadow-sm"
    ></span>
  {/if}
  <span class="flex items-center gap-1 text-[11px] text-neutral-700/90 dark:text-neutral-200/90" aria-label={t("a11y.networkStatus")}>
    {#if alertIcon}
      <span
        data-icon={alertIcon}
        aria-label={dnd ? t("a11y.doNotDisturb") : t("a11y.alertsMuted")}
        title={dnd ? t("a11y.doNotDisturb") : t("a11y.alertsMuted")}
      >{@html iconSvg(alertIcon)}</span>
    {/if}
    {#if flashOn}
      <span data-icon="flashlight" aria-label={t("a11y.flashlightOn")} title={t("a11y.flashlight")}>{@html iconSvg("flashlight")}</span>
    {/if}
    {#each icons as ic (ic.kind)}
      <span
        data-icon={ic.kind}
        class={ic.on ? "" : "opacity-40"}
        title={ic.titleKey
          ? t(ic.titleKey, ic.titleSsid ? { ssid: ic.titleSsid } : undefined)
          : undefined}
      >{@html iconSvg(radioIcon(ic.kind))}</span>
    {/each}
    <!-- The reading is the NAME: `aria-label` overrides the element's content, so the
         previous constant label + `aria-hidden` text made the level unreadable to a
         screen reader even though it was on screen (REQ-A1016). -->
    <span
      class="flex items-center gap-1 tabular-nums"
      data-testid="statusbar-battery"
      aria-label={battName}
      title={readout ? battName : undefined}
    >
      {@html batterySvg(batt.levelPct === null ? 0 : batt.levelPct, "h-3 w-3", battTone)}
      <span aria-hidden="true">{battText}</span>
    </span>
  </span>
</div>
