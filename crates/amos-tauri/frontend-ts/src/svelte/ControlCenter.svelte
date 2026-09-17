<script lang="ts">
  // ControlCenter.svelte — the macOS Control Center popover.
  //
  // The bar's ⚙️ item was a **disabled** control until this existed: there was no panel,
  // and the honest form of "not wired yet" is a greyed control that says so (FMEA
  // F-SH-001). This is the panel it was waiting for, and it follows the same rule the
  // quick-settings tiles on the phone follow: every switch here goes through
  // `lib/quickRadio.ts` — the **one** implementation of "the user tapped a radio" — and
  // the device's answer decides what the panel shows. Nothing here invents a state:
  // a refused write is a sentence, a platform-owned switch offers the system surface, and
  // a switch that cannot work is marked **before** the user taps it.
  //
  // What it deliberately does NOT have: display-brightness and sound-level sliders. macOS
  // puts them here, but this shell has no brightness backend and no system volume the
  // policy reaches, and a slider that moves a number nothing else reads is exactly the
  // decorative control this repo keeps removing. They are listed as gaps instead
  // (`docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md`).
  import { bridged } from "../lib/backend";
  import { iconSvg, quickIcon } from "../lib/sysIcons";
  import { radioManagedState, type RadioRefusalView } from "../lib/radioControl";
  import {
    openRadioSettings,
    readManagedSwitches,
    syncQuickRadios,
    tapRadio,
  } from "../lib/quickRadio";
  import {
    SETTINGS_KEY,
    dndActive,
    flipQuick,
    normalizeQuick,
    type QuickKey,
    type QuickSettings,
    type RadioKey,
  } from "../lib/settings";
  import { writeStoreValue } from "../lib/amosStore";
  import { themeDark, toggleTheme } from "./theme.svelte";
  import { createStoreValue } from "./store";
  import { t } from "./locale.svelte";
  import type { RadioControlReply } from "../lib/backend";
  import { GLASS_CONTROL_CENTER_STYLE, GLASS_BORDER_MEDIUM } from "../lib/shellChrome";
  import AirPlayPanel from "./AirPlayPanel.svelte";

  // The shell renders this overlay and hands it the dismissal (see `DesktopShell`).
  let { onclose }: { onclose?: () => void } = $props();
  
  let showAirPlay = $state(false);

  /** The three radios the panel switches; the Wi-Fi AP lives in Settings, not here. */
  const RADIO_TILES: readonly RadioKey[] = ["wifi", "bluetooth", "airplane"];

  const settingsStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  let settings = $state<QuickSettings>({});
  $effect(() => {
    const un = settingsStore.subscribe((v) => (settings = normalizeQuick(v)));
    return un;
  });

  const persist = (next: QuickSettings) => writeStoreValue(SETTINGS_KEY, next);

  /**
   * What the platform said about each of **this panel's** switches (REQ-A202); `null` =
   * never asked / no answer. Partial on purpose: the hotspot's AP switch lives in Settings,
   * so the panel has nothing to ask about it.
   */
  let ctl = $state<Partial<Record<RadioKey, RadioControlReply | null>>>({
    wifi: null,
    bluetooth: null,
    airplane: null,
  });

  // Mount = open (the overlay is only rendered while it is up), so this is the device read
  // the panel needs to show what the device holds rather than the stored intent.
  let readOnce = false;
  $effect(() => {
    if (readOnce || !bridged()) return;
    readOnce = true;
    void (async () => {
      const synced = await syncQuickRadios(settings);
      if (synced) persist(synced);
      ctl = await readManagedSwitches();
    })();
  });

  const managed = (key: RadioKey) => radioManagedState(ctl[key] ?? null, key);
  /** The switches this platform owns — each gets its own honest line. */
  const managedRadios = $derived(RADIO_TILES.filter((k) => managed(k).managed));
  /** `true` when the last attempt to open a system surface did not open one. */
  let surfaceFailed = $state(false);
  /** The last refusal the device answered with, and the radio it was about. */
  let refused = $state<RadioRefusalView | null>(null);
  let refusedKey = $state<RadioKey | null>(null);

  const dark = $derived(themeDark());
  const quiet = $derived(dndActive(settings));

  async function tapRadioTile(key: RadioKey) {
    const out = await tapRadio({ key, settings, host: bridged(), managed: managed(key) });
    if (out.kind === "managed") surfaceFailed = !out.opened;
    else if (out.kind === "applied") {
      surfaceFailed = false;
      refused = null;
      refusedKey = null;
    } else if (out.kind === "refused") {
      refused = out.refusal;
      refusedKey = out.refusal.noteKey ? key : null;
    }
    // Only a confirmed write is persisted; otherwise the panel shows the device's state
    // while the store keeps the user's intent (see `RadioTapOutcome`).
    if (out.persist) persist(out.next);
    else settings = out.next;
  }

  function tapQuick(key: QuickKey) {
    if (key === "darkmode") {
      persist({ ...settings, darkmode: !dark });
      toggleTheme();
      return;
    }
    persist(flipQuick(settings, key));
  }

  async function openRefusedSurface() {
    if (!refusedKey) return;
    surfaceFailed = !(await openRadioSettings(refusedKey));
  }
</script>


<!--
  macOS Control Center: a popover under the bar's ⚙️ item, not a full-screen sheet.
  - the backdrop is the dismissal (click outside), like every other popover on a Mac — and it
    dismisses only when the click landed on the backdrop itself, so the panel needs no
    `stopPropagation` that could swallow a click a tile was about to handle
  - `role="dialog"` without `aria-modal`: it is a popover, the rest of the desktop stays
    reachable (Escape and the trigger close it)
-->
<div
  class="fixed inset-0 z-[90]"
  role="presentation"
  onclick={(e) => {
    // Only the backdrop itself dismisses: a click that lands on the panel (or any tile in
    // it) must not — checked by target, so the panel needs no handler of its own and
    // nothing here swallows events a tile is about to handle.
    if (e.target === e.currentTarget) onclose?.();
  }}
  data-testid="control-center-backdrop"
>
  <div
    class="absolute right-3 top-11 w-[300px] overflow-hidden rounded-2xl p-3 shadow-2xl"
    style="{GLASS_CONTROL_CENTER_STYLE} {GLASS_BORDER_MEDIUM}"
    role="dialog"
    aria-label={t("desktop.controlCenter")}
    tabindex="-1"
    data-testid="control-center-panel"
  >
    <!-- Radios: the same three the phone's quick settings switch, same rules, same words -->
    <div class="grid grid-cols-3 gap-2">
      {#each RADIO_TILES as key (key)}
        {@const on = key === "airplane" ? !!settings.airplane : !settings.airplane && !!settings[key]}
        {@const state = managed(key)}
        <button
          class="flex flex-col items-start gap-1 rounded-xl px-2.5 py-2 text-left transition-colors {on
            ? 'bg-white/85 text-neutral-900'
            : 'bg-white/10 text-white/80 hover:bg-white/15'}"
          aria-pressed={on}
          aria-label={t(`q.${key}`)}
          title={t(`q.${key}`)}
          data-testid="cc-radio-{key}"
          onclick={() => void tapRadioTile(key)}
        >
          <span data-icon={key} class="grid h-5 w-5 place-items-center">
            {@html iconSvg(quickIcon(key), "h-5 w-5")}
          </span>
          <span class="text-[11px] font-medium leading-tight">{t(`q.${key}`)}</span>
          <span class="text-[10px] leading-tight opacity-70">
            {#if state.managed}
              {t("cc.systemOwned")}
            {:else}
              {on ? t("settings.on") : t("settings.off")}
            {/if}
          </span>
        </button>
      {/each}
    </div>

    <!-- Appearance + quiet -->
    <div class="mt-2 grid grid-cols-2 gap-2">
      <button
        class="flex items-center gap-2 rounded-xl px-2.5 py-2.5 text-left transition-colors {dark
          ? 'bg-white/85 text-neutral-900'
          : 'bg-white/10 text-white/80 hover:bg-white/15'}"
        aria-pressed={dark}
        aria-label={t("q.dark")}
        title={t("q.dark")}
        data-testid="cc-dark"
        onclick={() => tapQuick("darkmode")}
      >
        <span data-icon="darkmode" class="grid h-5 w-5 place-items-center">
          {@html iconSvg(quickIcon("darkmode"), "h-5 w-5")}
        </span>
        <span class="text-[12px] font-medium">{t("q.dark")}</span>
      </button>

      <button
        class="flex items-center gap-2 rounded-xl px-2.5 py-2.5 text-left transition-colors {quiet
          ? 'bg-white/85 text-neutral-900'
          : 'bg-white/10 text-white/80 hover:bg-white/15'}"
        aria-pressed={quiet}
        aria-label={t("q.dnd")}
        title={t("q.dnd")}
        data-testid="cc-dnd"
        onclick={() => tapQuick("dnd")}
      >
        <span data-icon="dnd" class="grid h-5 w-5 place-items-center">
          {@html iconSvg(quickIcon("dnd"), "h-5 w-5")}
        </span>
        <span class="text-[12px] font-medium">{t("q.dnd")}</span>
      </button>
    </div>

    <!-- AirPlay tile -->
    <div class="mt-2">
      <button
        class="w-full flex items-center justify-between rounded-xl px-2.5 py-2.5 text-left transition-colors {showAirPlay
          ? 'bg-sky-500/20 text-white border border-sky-500/30'
          : 'bg-white/10 text-white/80 hover:bg-white/15'}"
        aria-pressed={showAirPlay}
        aria-label={t("airplay.title")}
        title={t("airplay.title")}
        data-testid="cc-airplay"
        onclick={() => showAirPlay = !showAirPlay}
      >
        <div class="flex items-center gap-2">
          <span data-icon="airplay" class="grid h-5 w-5 place-items-center">
            {@html iconSvg(quickIcon("airplay"), "h-5 w-5")}
          </span>
          <span class="text-[12px] font-medium">{t("airplay.title")}</span>
        </div>
        <span class="text-[18px] leading-none transition-transform" style="transform: rotate({showAirPlay ? 180 : 0}deg)">›</span>
      </button>
      
      {#if showAirPlay}
        <div class="mt-2">
          <AirPlayPanel />
        </div>
      {/if}
    </div>

    <!-- What the platform owns, and whether a tap could hand the user to it (REQ-A202) -->
    {#if surfaceFailed}
      <p role="status" data-testid="cc-surface-failed" class="mt-2 px-1 text-[11px] leading-snug text-danger">
        {t("radio.openSettingsFailed")}
      </p>
    {/if}
    {#if refused}
      <p role="status" data-testid="cc-refused" class="mt-2 px-1 text-[11px] leading-snug text-danger">
        {refused.noteKey === "" ? t("radio.refused.unknown") : t(refused.noteKey)}
      </p>
      {#if refused.surface !== null && refusedKey}
        <button
          class="mt-1 px-1 text-[11px] font-semibold text-accent underline underline-offset-2"
          data-testid="cc-refused-open-settings"
          onclick={() => void openRefusedSurface()}
        >{t("radio.openSettings")}</button>
      {/if}
    {/if}
    {#if managedRadios.length > 0}
      <div class="mt-2 space-y-0.5 px-1">
        {#each managedRadios as key (key)}
          <p data-testid="cc-managed" class="text-[11px] leading-snug text-white/60">
            {t(managed(key).noteKey)}
          </p>
        {/each}
      </div>
    {/if}
  </div>
</div>
