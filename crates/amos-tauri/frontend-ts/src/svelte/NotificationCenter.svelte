<script lang="ts">
  // NotificationCenter.svelte — Svelte 5 (runes) port of the React control-center
  // sheet. CONTROLLED: the shell owns `open` (over propsBus "nc") and receives
  // shell actions (search/recents/edit/lock). Radio + torch tiles go through the
  // real `radio_*`/`flashlight_*` backend when bridged (authoritative), else fall
  // back to the SAME local policy so offline behaviour matches React. Notifications
  // list is reactive over the shared amos.notifications store.
  import { t } from "./locale.svelte";
  import { themeDark, toggleTheme } from "./theme.svelte";
  import { writeStoreValue } from "../lib/amosStore";
  import {
    bridged,
    flashlightSet,
    flashlightStatus,
    radioSet,
    radioStatus,
    type FlashlightPayload,
    type RadioPayload,
  } from "../lib/backend";
  import { attachFocusTrap } from "../lib/focusTrap";
  import { propsChannel } from "./propsBus";
  import { createStoreValue } from "./store";
  import {
    FLASHLIGHT_KEY,
    NOTIF_KEY,
    SETTINGS_KEY,
    dndActive,
    flipFlashlight,
    flipLocation,
    flipQuick,
    flipRadio,
    locationEnabled,
    normalizeFlashlight,
    normalizeNotifs,
    normalizeQuick,
    removeNotif,
    seedNotifs,
    type FlashlightStore,
    type Notif,
    type QuickKey,
    type QuickSettings,
    type RadioKey,
  } from "../lib/settings";

  const QUICK: { key: QuickKey; label: string; icon: string }[] = [
    { key: "wifi", label: "q.wifi", icon: "📶" },
    { key: "bluetooth", label: "q.bluetooth", icon: "🅱" },
    { key: "airplane", label: "q.airplane", icon: "✈️" },
    { key: "darkmode", label: "q.dark", icon: "🌙" },
    { key: "dnd", label: "q.dnd", icon: "🌒" },
    { key: "location", label: "q.location", icon: "📍" },
  ];

  interface NcProps {
    open: boolean;
  }
  const bus = propsChannel<NcProps>("nc");
  let incoming = $state<NcProps | null>(null);
  $effect(() => {
    const un = bus.subscribe((v) => {
      if (v !== undefined) incoming = v;
    });
    return un;
  });
  const open = $derived(incoming?.open ?? false);

  const settingsStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  const notifStore = createStoreValue<Notif[]>(NOTIF_KEY, []);
  const flashStore = createStoreValue<unknown>(FLASHLIGHT_KEY, {});
  let settings = $state<QuickSettings>({});
  let notifs = $state<Notif[]>([]);
  let flash = $state<FlashlightStore>({ on: false, torch_present: true });
  $effect(() => {
    const un = settingsStore.subscribe((v) => (settings = normalizeQuick(v)));
    return un;
  });
  $effect(() => {
    const un = notifStore.subscribe((v) => (notifs = normalizeNotifs(v)));
    return un;
  });
  $effect(() => {
    const un = flashStore.subscribe((v) => (flash = normalizeFlashlight(v)));
    return un;
  });

  // Seed demo notifications once when the store is empty (mirrors React's mount
  // seed). A later manual clear reaches the true empty state.
  let seeded = false;
  $effect(() => {
    if (!seeded && notifs.length === 0) {
      seeded = true;
      writeStoreValue(NOTIF_KEY, seedNotifs(Date.now()));
    }
  });

  const dark = $derived(themeDark());
  const quiet = $derived(dndActive(settings));
  let rootEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!open || !rootEl) return;
    return attachFocusTrap(rootEl, close);
  });

  const mergeRadio = (s: QuickSettings, r: RadioPayload): QuickSettings => ({
    ...s,
    wifi: r.wifi,
    bluetooth: r.bluetooth,
    airplane: r.airplane,
  });
  const mergeFlash = (p: FlashlightPayload): FlashlightStore => ({
    on: p.on,
    torch_present: p.torch_present,
  });
  const persistSettings = (next: QuickSettings) => writeStoreValue(SETTINGS_KEY, next);

  const toggle = async (key: QuickKey) => {
    if (key === "darkmode") {
      const nextDark = !dark;
      persistSettings({ ...settings, darkmode: nextDark });
      toggleTheme();
      return;
    }
    if (key === "wifi" || key === "bluetooth" || key === "airplane") {
      await toggleRadio(key);
      return;
    }
    if (key === "location") {
      persistSettings(flipLocation(settings)); // defaults ON; tap flips OFF/ON
      return;
    }
    persistSettings(flipQuick(settings, key));
  };

  // Radio tiles go through the real backend when bridged; otherwise the same
  // local policy (incl. airplane cascade) so offline behaves identically.
  const toggleRadio = async (key: RadioKey) => {
    if (key !== "airplane" && settings.airplane) return; // gated no-op under APM
    const on = !!settings[key];
    if (bridged()) {
      const snap = await radioSet(key, !on);
      if (snap) {
        persistSettings(mergeRadio(settings, snap));
        return;
      }
      const live = await radioStatus();
      if (live) settings = mergeRadio(settings, live);
      return;
    }
    persistSettings(flipRadio(settings, key));
  };

  const toggleFlash = async () => {
    if (bridged()) {
      const snap = await flashlightSet(!flash.on);
      if (snap) {
        writeStoreValue(FLASHLIGHT_KEY, mergeFlash(snap));
        return;
      }
      const live = await flashlightStatus();
      if (live) writeStoreValue(FLASHLIGHT_KEY, mergeFlash(live));
      return;
    }
    writeStoreValue(FLASHLIGHT_KEY, flipFlashlight(flash));
  };

  const clear = () => writeStoreValue(NOTIF_KEY, []);
  const dismiss = (id: string) => writeStoreValue(NOTIF_KEY, removeNotif(notifs, id));

  const close = () => bus.emit("close");
  const act = (name: string) => {
    bus.emit(name); // search / recents / edit / lock
    bus.emit("close");
  };

</script>

{#if open}
  <div
    bind:this={rootEl}
    role="dialog"
    aria-modal="true"
    aria-label={t("nc.title")}
    class="drop-in absolute inset-0 z-40 flex flex-col bg-white/45 p-4 backdrop-blur-2xl backdrop-saturate-150 dark:bg-neutral-950/60"
  >
    <div class="flex items-center justify-between px-1">
      <h2 class="text-xl font-semibold tracking-tight">{t("nc.title")}</h2>
      <button
        onclick={close}
        class="rounded-full bg-neutral-200/80 px-4 py-1.5 text-sm font-medium text-accent transition active:scale-95 dark:bg-white/10"
      >{t("common.done")}</button>
    </div>

    <!-- Control-center system actions (formerly the home top bar). -->
    <div class="mt-2 flex items-center justify-end gap-2">
      <button aria-label="search" title="search" onclick={() => act("search")} class="grid h-9 w-9 place-items-center rounded-full bg-white/55 text-sm ring-1 ring-white/50 shadow-sm transition active:scale-90 dark:bg-white/10 dark:ring-white/10">🔍</button>
      <button aria-label="recents" title="recents" onclick={() => act("recents")} class="grid h-9 w-9 place-items-center rounded-full bg-white/55 text-sm ring-1 ring-white/50 shadow-sm transition active:scale-90 dark:bg-white/10 dark:ring-white/10">⇤</button>
      <button aria-label="edit home" title="edit home" onclick={() => act("edit")} class="grid h-9 w-9 place-items-center rounded-full bg-white/55 text-sm ring-1 ring-white/50 shadow-sm transition active:scale-90 dark:bg-white/10 dark:ring-white/10">✎</button>
      <button aria-label="lock" title="lock" onclick={() => act("lock")} class="grid h-9 w-9 place-items-center rounded-full bg-white/55 text-sm ring-1 ring-white/50 shadow-sm transition active:scale-90 dark:bg-white/10 dark:ring-white/10">🔒</button>
    </div>

    <!-- Torch / flashlight tile. -->
    <button
      onclick={() => void toggleFlash()}
      aria-pressed={flash.on}
      disabled={!flash.torch_present}
      class={
        "mt-3 flex items-center justify-between rounded-3xl px-4 py-3 text-sm font-semibold transition active:scale-[0.98] disabled:opacity-40 " +
        (flash.on
          ? "bg-amber-400 text-neutral-900 shadow-[0_6px_16px_rgba(245,158,11,0.45)]"
          : "bg-white/55 text-neutral-800 ring-1 ring-white/50 shadow-sm dark:bg-white/10 dark:text-neutral-200 dark:ring-white/10")
      }
    >
      <span class="flex items-center gap-2.5">
        <span class="text-xl leading-none">{flash.on ? "🔦" : "🔆"}</span>
        {t("q.flashlight")}
      </span>
      {#if !flash.torch_present}
        <span class="text-xs font-medium opacity-50">{t("nc.torchNone")}</span>
      {:else}
        <span class={"text-xs font-medium " + (flash.on ? "opacity-80" : "opacity-50")}>
          {flash.on ? t("nc.torchOn") : t("nc.torchOff")}
        </span>
      {/if}
    </button>

    <!-- Quick settings tiles. -->
    <div class="mt-4 grid grid-cols-3 gap-2.5">
      {#each QUICK as q (q.key)}
        {@const on = q.key === "darkmode" ? dark : q.key === "location" ? locationEnabled(settings) : !!settings[q.key]}
        <button
          onclick={() => void toggle(q.key)}
          aria-pressed={on}
          class={
            "flex flex-col items-center justify-center gap-1.5 rounded-3xl py-4 text-[11px] font-medium backdrop-blur transition active:scale-95 " +
            (on
              ? "bg-accent text-white shadow-[0_6px_16px_rgba(10,132,255,0.35)]"
              : "bg-white/55 text-neutral-800 ring-1 ring-white/50 shadow-sm dark:bg-white/10 dark:text-neutral-200 dark:ring-white/10")
          }
        >
          <span class="text-xl leading-none">{q.icon}</span>
          {t(q.label)}
        </button>
      {/each}
    </div>

    <div class="mt-3 flex items-center justify-between px-1">
      <span class="text-xs font-semibold uppercase tracking-widest opacity-50">
        {#if quiet}
          <span class="normal-case tracking-normal text-accent">🌒 {t("nc.dnd")}</span>
        {:else}
          {notifs.length} ·
        {/if}
      </span>
      <button onclick={clear} aria-label="clear" class="text-xs font-medium text-accent hover:underline">{t("nc.clear")}</button>
    </div>

    <div class="mt-2 flex-1 space-y-2.5 overflow-auto pr-0.5">
      {#if notifs.length === 0}
        <p class="py-12 text-center text-sm opacity-50">{t("nc.empty")}</p>
      {:else}
        {#each notifs as n (n.id)}
          <div
            class={
              "rounded-3xl p-3.5 shadow-sm ring-1 ring-black/5 dark:ring-white/10 " +
              (quiet ? "bg-white/30 opacity-60 saturate-50 dark:bg-white/5" : "bg-white/60 dark:bg-white/10")
            }
          >
            <div class="flex items-center justify-between text-xs">
              <span class="font-semibold">{n.icon} {n.app ?? n.title}</span>
              <button
                onclick={() => dismiss(n.id)}
                aria-label="dismiss"
                class="grid h-6 w-6 place-items-center rounded-full opacity-60 transition hover:opacity-100"
              >✕</button>
            </div>
            {#if n.title}<div class="mt-1 text-sm font-medium">{n.title}</div>{/if}
            {#if n.body}<div class="text-xs opacity-70">{n.body}</div>{/if}
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}

