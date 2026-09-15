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
    type FlashlightPayload,
    type RadioControlReply,
  } from "../lib/backend";
  import { radioManagedState, type RadioRefusalView } from "../lib/radioControl";
  import { readManagedSwitches, openRadioSettings, syncQuickRadios, tapRadio } from "../lib/quickRadio";
  import { attachFocusTrap } from "../lib/focusTrap";
  import { iconSvg, quickIcon } from "../lib/sysIcons";
  import { propsChannel } from "./propsBus";
  import { createStoreValue } from "./store";
  import { cellularRadio } from "./cellularRadio";
  import { CELLULAR_KEY, defaultCellular, normalizeCellular, type CellularPrefs } from "../lib/cellular";
  import {
    cellularService,
    cellularStateKey,
    defaultRadioSignal,
    type RadioSignal,
  } from "../lib/cellularService";
  import {
    FLASHLIGHT_KEY,
    NOTIF_KEY,
    SETTINGS_KEY,
    dndActive,
    flipFlashlight,
    flipLocation,
    flipQuick,
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

  const QUICK: { key: QuickKey; label: string }[] = [
    { key: "wifi", label: "q.wifi" },
    { key: "bluetooth", label: "q.bluetooth" },
    { key: "airplane", label: "q.airplane" },
    { key: "darkmode", label: "q.dark" },
    { key: "dnd", label: "q.dnd" },
    { key: "location", label: "q.location" },
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
  let cellPrefs = $state<CellularPrefs>(defaultCellular());
  let radio = $state<RadioSignal>(defaultRadioSignal());
  const cellularStore = createStoreValue<unknown>(CELLULAR_KEY, {});
  $effect(() => {
    const un = settingsStore.subscribe((v) => (settings = normalizeQuick(v)));
    return un;
  });
  // Mount-time **device truth** (REQ-A185): ask the radios once so these tiles show
  // what the device holds instead of only the persisted intent (the Mock made the two
  // identical; the real provider makes the difference visible). A failure keeps the
  // stored values.
  let radioRead = false;
  $effect(() => {
    if (radioRead || !bridged()) return;
    radioRead = true;
    void (async () => {
      const next = await syncQuickRadios(settings);
      if (next) persistSettings(next);
    })();
  });

  // Which switches the **platform** owns (REQ-A202). Asked once, on mount, exactly like
  // the status read above: a tile that cannot work must say so *before* the user taps it
  // (and must offer the system surface), instead of swallowing a refusal that `invoke`
  // reports as `null`.
  let ctlRead = false;
  let radioCtl = $state<Record<RadioKey, RadioControlReply | null>>({
    wifi: null,
    bluetooth: null,
    airplane: null,
    hotspot: null,
  });
  $effect(() => {
    if (ctlRead || !bridged()) return;
    ctlRead = true;
    void (async () => {
      radioCtl = await readManagedSwitches();
    })();
  });

  const managed = (key: RadioKey) => radioManagedState(radioCtl[key], key);
  /** The radios whose switch this platform owns — each gets its own honest line. */
  const managedRadios = $derived(
    (["wifi", "bluetooth", "airplane"] as RadioKey[]).filter((k) => managed(k).managed),
  );
  /** `true` when the last managed tap could not open the system surface. */
  let managedFailed = $state(false);
  /**
   * The last **refused write** (REQ-A203): `radio_set` now answers `applied: false`
   * with machine tokens instead of failing into `null`, so "the device refused this
   * time" is a visible line with an optional way out — not just a ledger entry.
   */
  let refused = $state<RadioRefusalView | null>(null);
  let refusedKey = $state<RadioKey | null>(null);
  $effect(() => {
    const un = notifStore.subscribe((v) => (notifs = normalizeNotifs(v)));
    return un;
  });
  $effect(() => {
    const un = flashStore.subscribe((v) => (flash = normalizeFlashlight(v)));
    return un;
  });
  $effect(() => {
    const un = cellularStore.subscribe((v) => (cellPrefs = normalizeCellular(v)));
    return un;
  });
  $effect(() => {
    const un = cellularRadio.subscribe((v) => (radio = v));
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
  // Controlled cellular: only meaningful once a REAL radio is present (on-device).
  // No modem → radio.present false → nothing is shown (honest, not misleading).
  const cellStatusKey = $derived(cellularStateKey(cellularService(cellPrefs, radio)));
  let rootEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!open || !rootEl) return;
    return attachFocusTrap(rootEl, close);
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

  /**
   * Radio tiles: the rules (airplane gate, platform-owned switches, refusals, the re-read
   * after a failed write) live in `lib/quickRadio.ts` — one implementation shared with the
   * Settings screen and the desktop's Control Center. This screen only says what happened.
   */
  const toggleRadio = async (key: RadioKey) => {
    const out = await tapRadio({ key, settings, host: bridged(), managed: managed(key) });
    if (out.kind === "managed") {
      // A failed open must be visible: the alternative is a tile that silently does
      // nothing, which is exactly what REQ-A202 removed.
      managedFailed = !out.opened;
    } else if (out.kind === "applied") {
      managedFailed = false;
      refused = null;
      refusedKey = null;
    } else if (out.kind === "refused") {
      refused = out.refusal;
      refusedKey = out.refusal.noteKey ? key : null;
    }
    // Only a confirmed write is persisted; otherwise the store keeps the user's intent
    // while the tiles show the device's state (see `RadioTapOutcome`).
    if (out.persist) persistSettings(out.next);
    else settings = out.next;
  };

  /** Offer the real switch for the refused radio (only when a surface is known). */
  const openRefusedSettings = async () => {
    if (!refusedKey) return;
    managedFailed = !(await openRadioSettings(refusedKey));
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
      <button aria-label={t("shell.search")} title={t("shell.search")} onclick={() => act("search")} class="grid h-9 w-9 place-items-center rounded-full bg-white/55 text-sm ring-1 ring-white/50 shadow-sm transition active:scale-90 dark:bg-white/10 dark:ring-white/10"><span data-icon="search">{@html iconSvg("search", "h-[17px] w-[17px]")}</span></button>
      <button aria-label={t("shell.recents")} title={t("shell.recents")} onclick={() => act("recents")} class="grid h-9 w-9 place-items-center rounded-full bg-white/55 text-sm ring-1 ring-white/50 shadow-sm transition active:scale-90 dark:bg-white/10 dark:ring-white/10"><span data-icon="recents">{@html iconSvg("recents", "h-[17px] w-[17px]")}</span></button>
      <button aria-label={t("a11y.editHome")} title={t("a11y.editHome")} onclick={() => act("edit")} class="grid h-9 w-9 place-items-center rounded-full bg-white/55 text-sm ring-1 ring-white/50 shadow-sm transition active:scale-90 dark:bg-white/10 dark:ring-white/10"><span data-icon="pencil">{@html iconSvg("pencil", "h-[17px] w-[17px]")}</span></button>
      <button aria-label={t("a11y.lock")} title={t("a11y.lock")} onclick={() => act("lock")} class="grid h-9 w-9 place-items-center rounded-full bg-white/55 text-sm ring-1 ring-white/50 shadow-sm transition active:scale-90 dark:bg-white/10 dark:ring-white/10"><span data-icon="lock">{@html iconSvg("lock", "h-[17px] w-[17px]")}</span></button>
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
        <span data-icon="flashlight" class="text-xl leading-none">{@html iconSvg("flashlight", "h-[22px] w-[22px]")}</span>
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

    <!-- Cellular module — only when a REAL modem source is present. This build has
         none (radio.present=false) so it stays hidden: honest, never a fake phone
         affordance. Once a real Android signal source is wired it appears here. -->
    {#if radio.present}
      <div
        class="mt-3 flex items-center justify-between rounded-3xl bg-white/55 px-4 py-3 text-sm font-semibold text-neutral-800 ring-1 ring-white/50 shadow-sm dark:bg-white/10 dark:text-neutral-200 dark:ring-white/10"
        data-testid="nc-cellular"
      >
        <span class="flex items-center gap-2.5">{t("settings.cellular")}</span>
        <span class="text-xs font-medium opacity-70">{t(cellStatusKey)}</span>
      </div>
    {/if}

    <!-- Quick settings tiles. -->
    <div class="mt-4 grid grid-cols-3 gap-2.5">
      {#each QUICK as q (q.key)}
        {@const on = q.key === "darkmode" ? dark : q.key === "location" ? locationEnabled(settings) : !!settings[q.key]}
        {@const ctl = q.key === "wifi" || q.key === "bluetooth" || q.key === "airplane" ? managed(q.key) : { managed: false, noteKey: "", surface: null }}
        <button
          onclick={() => void toggle(q.key)}
          aria-pressed={on}
          aria-label={ctl.managed ? `${t(q.label)} · ${t("radio.openSettings")}` : undefined}
          data-managed={ctl.managed ? "system" : undefined}
          class={
            "flex flex-col items-center justify-center gap-1.5 rounded-3xl py-4 text-[11px] font-medium backdrop-blur transition active:scale-95 " +
            (on
              ? "bg-accent text-white shadow-[0_6px_16px_rgba(10,132,255,0.35)]"
              : "bg-white/55 text-neutral-800 ring-1 ring-white/50 shadow-sm dark:bg-white/10 dark:text-neutral-200 dark:ring-white/10")
          }
        >
          <span data-icon={q.key} class="text-xl leading-none">{@html iconSvg(quickIcon(q.key), "h-[22px] w-[22px]")}</span>
          {t(q.label)}
          <!-- A switch the platform owns is not this app's to move: the tile says so
               instead of looking like a button that silently does nothing (REQ-A202). -->
          {#if ctl.managed}
            <span aria-hidden="true" class="text-[10px] leading-none opacity-70">⚙</span>
          {/if}
        </button>
      {/each}
    </div>

    <!-- The explanation for each switch the platform owns, and whether the last managed
         tap could actually open the system surface (REQ-A202). -->
    {#if managedFailed}
      <div class="mt-2 px-1">
        <p role="status" data-testid="nc-radio-managed-failed" class="text-[11px] leading-snug text-danger">
          {t("radio.openSettingsFailed")}
        </p>
      </div>
    {/if}
    <!-- A refused write (REQ-A203): the device said no *this time* — say so, mirror the
         real state, and offer the system switch when there is one to offer. -->
    {#if refused}
      <div class="mt-2 px-1">
        <p role="status" data-testid="nc-radio-refused" class="text-[11px] leading-snug text-danger">
          {refused.noteKey === "" ? t("radio.refused.unknown") : t(refused.noteKey)}
        </p>
        {#if refused.surface !== null && refusedKey}
          <button
            onclick={() => void openRefusedSettings()}
            data-testid="nc-radio-refused-open-settings"
            class="mt-1 text-[11px] font-semibold text-accent underline underline-offset-2"
          >
            {t("radio.openSettings")}
          </button>
        {/if}
      </div>
    {/if}
    {#if managedRadios.length > 0}
      <div class="mt-2 space-y-0.5 px-1">
        {#each managedRadios as key (key)}
          <p data-testid="nc-radio-managed" class="text-[11px] leading-snug opacity-70">
            {t(managed(key).noteKey)}
          </p>
        {/each}
      </div>
    {/if}

    <div class="mt-3 flex items-center justify-between px-1">
      <span class="text-xs font-semibold uppercase tracking-widest opacity-50">
        {#if quiet}
          <span class="inline-flex items-center gap-1 normal-case tracking-normal text-accent">
            <span data-icon="moon" class="grid h-4 w-4 place-items-center">{@html iconSvg("moon", "h-4 w-4")}</span>
            {t("nc.dnd")}
          </span>
        {:else}
          {notifs.length} ·
        {/if}
      </span>
      <button onclick={clear} aria-label={t("nc.clear")} class="text-xs font-medium text-accent hover:underline">{t("nc.clear")}</button>
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
                aria-label={t("a11y.dismiss")}
                data-icon="x"
                class="grid h-6 w-6 place-items-center rounded-full opacity-60 transition hover:opacity-100"
              >{@html iconSvg("x", "h-3 w-3")}</button>
            </div>
            {#if n.title}<div class="mt-1 text-sm font-medium">{n.title}</div>{/if}
            {#if n.body}<div class="text-xs opacity-70">{n.body}</div>{/if}
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}

