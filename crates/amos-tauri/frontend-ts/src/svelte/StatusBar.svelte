<script lang="ts">
  // StatusBar.svelte — Svelte 5 (runes) port of the React `StatusBar` shell
  // chrome. It is a pure "island": no external props/events — it reads the SAME
  // shared stores (quick settings / flashlight / sound / wifi) and live
  // time/online that the React StatusBar reads, so it can be hosted by the React
  // shell with the generic SvelteAppHost (className="") and must never drift from
  // the original.
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
  import { systemHealth, hostBattery } from "../lib/system";
  import { bridged } from "../lib/backend";

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
      : batt.charging === true
        ? `battery: charging ${battText}`
        : `battery: ${battText}`,
  );
</script>

<div class="relative flex items-center justify-between px-4 pb-1 pt-3 text-xs font-semibold text-neutral-900 dark:text-neutral-100">
  <span class="tabular-nums">{fmtClock(now)}</span>
  <!-- Dynamic Island -->
  <span
    aria-hidden="true"
    class="pointer-events-none absolute left-1/2 top-[9px] h-[22px] w-[112px] -translate-x-1/2 rounded-full bg-black shadow-sm"
  ></span>
  <span class="flex items-center gap-1 text-[11px] text-neutral-700/90 dark:text-neutral-200/90" aria-label="network status">
    {#if alertIcon}
      <span
        data-icon={alertIcon}
        aria-label={dnd ? "do not disturb" : "alerts muted"}
        title={dnd ? "Do Not Disturb" : "alerts muted"}
      >{@html iconSvg(alertIcon)}</span>
    {/if}
    {#if flashOn}
      <span data-icon="flashlight" aria-label="flashlight on" title="Flashlight">{@html iconSvg("flashlight")}</span>
    {/if}
    {#each icons as ic (ic.kind)}
      <span
        data-icon={ic.kind}
        class={ic.on ? "" : "opacity-40"}
        title={ic.title}
      >{@html iconSvg(radioIcon(ic.kind))}</span>
    {/each}
    <span
      class="flex items-center gap-1 tabular-nums"
      aria-label="battery level"
      title={battTitle}
    >
      {@html batterySvg(batt.levelPct === null ? 0 : batt.levelPct, "h-3 w-3", battTone)}
      <span aria-hidden="true">{battText}</span>
    </span>
  </span>
</div>
