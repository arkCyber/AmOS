<script lang="ts">
  // StatusBar.svelte — Svelte 5 (runes) port of the React `StatusBar` shell
  // chrome. It is a pure "island": no external props/events — it reads the SAME
  // shared stores (quick settings / flashlight / sound) and live time/online that
  // the React StatusBar reads, so it can be hosted by the React shell with the
  // generic SvelteAppHost (className="") and must never drift from the original.
  import { fmtClock, batteryPercent } from "../lib/time";
  import {
    SETTINGS_KEY,
    FLASHLIGHT_KEY,
    applyConnectivity,
    normalizeFlashlight,
    normalizeQuick,
    radioIcons,
    torchOn,
  } from "../lib/settings";
  import { SOUND_KEY, normalizeSound, effectiveAlert } from "../lib/sound";
  import { createStoreValue } from "./store";
  import { batterySvg, iconSvg, radioIcon } from "../lib/sysIcons";

  const settingsStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  const flashStore = createStoreValue<unknown>(FLASHLIGHT_KEY, {});
  const soundStore = createStoreValue<unknown>(SOUND_KEY, {});
  let settingsRaw = $state<unknown>({});
  let flashRaw = $state<unknown>({});
  let soundRaw = $state<unknown>({});
  let now = $state(new Date());
  let online = $state(typeof navigator !== "undefined" ? navigator.onLine : true);

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
  // Wi-Fi reads as "on" only when enabled AND the host is actually online.
  const icons = $derived(applyConnectivity(radioIcons(quick), online));
  const dnd = $derived(!!quick.dnd);
  const effective = $derived(effectiveAlert(normalizeSound(soundRaw), dnd));
  // Persistent alert indicators: moon while Do-Not-Disturb; else a muted bell
  // when the ring/vibrate policy mutes alerts. Nothing extra in the default state.
  const alertIcon = $derived(
    dnd ? ("moon" as const) : effective.ring || effective.vibrate ? null : ("mutedBell" as const),
  );
</script>

<div class="relative flex items-center justify-between px-4 pb-1 pt-3 text-xs font-semibold">
  <span class="tabular-nums">{fmtClock(now)}</span>
  <!-- Dynamic Island -->
  <span
    aria-hidden="true"
    class="pointer-events-none absolute left-1/2 top-[9px] h-[22px] w-[112px] -translate-x-1/2 rounded-full bg-black shadow-sm"
  ></span>
  <span class="flex items-center gap-1 text-[10px] opacity-80" aria-label="network status">
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
        title={ic.kind === "wifi" && !online ? "wifi: no connection" : undefined}
      >{@html iconSvg(radioIcon(ic.kind))}</span>
    {/each}
    <span class="flex items-center gap-1 tabular-nums" aria-label="battery level">
      {@html batterySvg(batteryPercent(now))}
      <span aria-hidden="true">{batteryPercent(now)}%</span>
    </span>
  </span>
</div>
