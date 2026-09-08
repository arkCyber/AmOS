<script lang="ts">
  // LockScreen.svelte — Svelte 5 (runes) port of the React `SystemPanels.LockScreen`
  // (the whole-screen surface the shell shows while locked). Reads amos.lock /
  // amos.settings, shows clock/date, PIN pad (or tap-to-unlock when no PIN), and
  // the always-reachable emergency quick-dial. Emits 'unlock' to the React shell.
  import { t, locale } from "./locale.svelte";
  import { fmtClock } from "../lib/time";
  import { telephonyDial } from "../lib/backend";
  import { EMERGENCY_QUICK_NUMBER } from "../lib/emergency";
  import { createStoreValue } from "./store";
  import { propsChannel } from "./propsBus";
  import { isCustomWallpaper, WALLPAPER_FILES } from "../lib/wallpaper";
  import { iconSvg } from "../lib/sysIcons";

  const bus = propsChannel<{ ready?: boolean }>("lock");

  const lockStore = createStoreValue<{ enabled?: boolean; pin?: string }>("amos.lock", {});
  const settingsStore = createStoreValue<{ lockWallpaper?: string }>("amos.settings", {});
  let lockCfg = $state<{ enabled?: boolean; pin?: string }>({});
  let prefs = $state<{ lockWallpaper?: string }>({});
  $effect(() => {
    const un = lockStore.subscribe((v) => (lockCfg = v ?? {}));
    return un;
  });
  $effect(() => {
    const un = settingsStore.subscribe((v) => (prefs = v ?? {}));
    return un;
  });

  const needPin = $derived(!!lockCfg.enabled && !!lockCfg.pin);
  const dark =
    typeof document !== "undefined" && !!document.documentElement?.classList?.contains("dark");
  const lockWall = $derived(prefs.lockWallpaper);
  const lockBgUrl = $derived.by(() => {
    // Always resolve a wallpaper: use the user's lock wallpaper if chosen, else
    // fall back to the theme default (dark/light) so the lock screen is never a
    // bare gray panel.
    const w = lockWall;
    if (!w) return `wallpapers/${dark ? "dark" : "light"}`;
    const f = isCustomWallpaper(w) ? w : WALLPAPER_FILES[w] ?? (dark ? "dark" : "light");
    return isCustomWallpaper(f) ? f : `wallpapers/${f}`;
  });

  let pin = $state("");
  let bad = $state(false);
  let emergency = $state(false);
  let dialFailed = $state(false);

  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });
  const dateStr = $derived(
    new Intl.DateTimeFormat(locale() === "zh" ? "zh-CN" : "en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(now),
  );

  const tap = (d: string) => {
    if (pin.length < 6) pin += d;
    bad = false;
  };
  const backspace = () => (pin = pin.slice(0, -1));
  const submit = () => {
    if (pin === lockCfg.pin) {
      pin = "";
      bus.emit("unlock");
    } else {
      bad = true;
      pin = "";
    }
  };

  const dialEmergency = async () => {
    if (emergency) return;
    dialFailed = false;
    emergency = true;
    const res = await telephonyDial(EMERGENCY_QUICK_NUMBER, true);
    if (!res) {
      emergency = false;
      dialFailed = true;
    }
  };
</script>

<div
  role="dialog"
  aria-modal="true"
  aria-label={t("shell.lockTitle")}
  class={
    "fade-in absolute inset-0 z-50 flex flex-col items-center justify-center overflow-hidden px-6 text-neutral-50 " +
    (lockBgUrl ? "" : "bg-neutral-900/75 backdrop-blur-2xl")
  }
>
  {#if lockBgUrl}
    <div aria-hidden="true" class="absolute inset-0 bg-cover bg-center" style={`background-image:url(${lockBgUrl})`}></div>
    <div aria-hidden="true" class="absolute inset-0 bg-black/35"></div>
  {/if}
  <div class="relative z-10 flex w-full flex-col items-center">
    <div class="text-center leading-none">
      <div class="text-7xl font-medium tabular-nums tracking-tight">{fmtClock(now)}</div>
      <div class="mt-2.5 text-lg text-neutral-200">{dateStr}</div>
      <div class="mt-7 flex items-center justify-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-400">
        <span aria-hidden="true" data-icon="lock" class="grid h-3.5 w-3.5 place-items-center">{@html iconSvg("lock", "h-3.5 w-3.5")}</span> {t("shell.lockTitle")}
      </div>
    </div>

    {#if needPin}
      <div class="my-7 text-2xl tabular-nums tracking-[0.35em] text-neutral-100">
        {#if bad}
          <span class="text-3xl text-red-400">✗</span>
        {:else}
          <span class="text-3xl">{pin.length ? "●".repeat(pin.length) : "○○○○○○"}</span>
        {/if}
      </div>
      <div class="grid grid-cols-3 gap-x-6 gap-y-4">
        {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"] as k (k)}
          {@const confirm = k === "✓"}
          {@const back = k === "⌫"}
          <button
            onclick={confirm ? submit : back ? backspace : () => tap(k)}
            aria-label={k}
            data-icon={confirm ? "check" : back ? "delete" : undefined}
            class={
              "grid h-[72px] w-[72px] place-items-center rounded-full text-2xl ring-1 transition active:scale-90 " +
              (confirm
                ? "bg-green-500 text-white ring-green-400 active:bg-green-400"
                : "bg-white/10 text-white ring-white/25 backdrop-blur active:bg-white/25")
            }
          >
            {#if confirm}
              {@html iconSvg("check", "h-8 w-8")}
            {:else if back}
              {@html iconSvg("delete", "h-7 w-7")}
            {:else}
              {k}
            {/if}
          </button>
        {/each}
      </div>
    {:else}
      <button
        onclick={() => bus.emit("unlock")}
        class="mt-10 rounded-full bg-white/15 px-9 py-3 text-base font-medium ring-1 ring-white/25 backdrop-blur transition active:bg-white/25"
      >{t("shell.unlock")}</button>
    {/if}

    <button
      onclick={() => void dialEmergency()}
      disabled={emergency}
      class="mt-10 rounded-full bg-danger/20 px-8 py-3 text-base font-medium text-red-200 ring-1 ring-red-400/40 transition active:bg-danger/30 disabled:opacity-60"
      aria-label={t("shell.emergency", { num: EMERGENCY_QUICK_NUMBER })}
    >
      {emergency
        ? t("shell.emergencyCalling", { num: EMERGENCY_QUICK_NUMBER })
        : t("shell.emergency", { num: EMERGENCY_QUICK_NUMBER })}
    </button>
    {#if dialFailed}
      <p class="mt-3 max-w-xs text-center text-xs text-red-200/80">{t("shell.emergencyUnreachable")}</p>
    {/if}
  </div>
</div>

