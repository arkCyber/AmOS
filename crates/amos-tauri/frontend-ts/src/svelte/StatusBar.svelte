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
  import {
    firstBattery,
    batteryTone,
    watchHostBattery,
    type BatterySample,
  } from "../lib/batteryStatus";
  import { statusIcons } from "../lib/netStatus";
  import { deviceChrome } from "../lib/formLayout";
  import type { FormFactor } from "../lib/wm";
  import { systemHealth, hostBattery } from "../lib/system";
  import { bridged } from "../lib/backend";
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

  // Real battery sources, kept separate so the shown reading can be resolved with
  // explicit precedence (daemon system_health first, host OS Battery API second).
  const BATTERY_POLL_MS = 5000;
  let systemBatt = $state<BatterySample>({ levelPct: null, charging: null });
  let tauriBatt = $state<BatterySample>({ levelPct: null, charging: null });
  let hostBatt = $state<BatterySample>({ levelPct: null, charging: null });

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

  // Live real battery. The daemon poll only runs when actually bridged (when not
  // bridged the call is a cheap null, but we skip the timer to keep the always-
  // mounted chrome light); the host OS Battery API is event-driven so it needs no
  // timer — we just forward its samples.
  $effect(() => {
    const stopHost = watchHostBattery((s) => {
      hostBatt = s;
    });
    const poll = async () => {
      if (!bridged()) return;
      const raw = await systemHealth();
      if (raw) {
        systemBatt = {
          levelPct: raw.battery_level_pct,
          charging: raw.battery_charging,
        };
      }
      // The host OS battery (desktop dev / any host the daemon can't see).
      const host = await hostBattery();
      if (host) {
        tauriBatt = { levelPct: host.level_pct, charging: host.charging };
      }
    };
    void poll();
    const id = window.setInterval(poll, BATTERY_POLL_MS);
    return () => {
      if (stopHost) stopHost();
      window.clearInterval(id);
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
  const batt = $derived(firstBattery([systemBatt, tauriBatt, hostBatt]));
  const battTone = $derived(batteryTone(batt));
  const battText = $derived(
    batt.levelPct === null ? "—" : `${Math.round(batt.levelPct)}%`,
  );
  const battTitle = $derived(
    batt.levelPct === null
      ? undefined
      : t(batt.charging === true ? "a11y.batteryCharging" : "a11y.battery", { pct: battText }),
  );
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
        aria-label={dnd ? "do not disturb" : "alerts muted"}
        title={dnd ? "Do Not Disturb" : "alerts muted"}
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
    <span
      class="flex items-center gap-1 tabular-nums"
      aria-label={t("a11y.batteryLevel")}
      title={battTitle}
    >
      {@html batterySvg(batt.levelPct === null ? 0 : batt.levelPct, "h-3 w-3", battTone)}
      <span aria-hidden="true">{battText}</span>
    </span>
  </span>
</div>
