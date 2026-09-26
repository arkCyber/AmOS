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
  import { openSysInk } from "./shellState.svelte";
  import { radioManagedState, type RadioRefusalView } from "../lib/radioControl";
  import {
    openRadioSettings,
    radioDisplayOn,
    radioGated,
    readManagedSwitches,
    syncQuickRadios,
    tapRadio,
  } from "../lib/quickRadio";
  import {
    SETTINGS_KEY,
    dndActive,
    flipQuick,
    normalizeQuick,
    saveQuick,
    type QuickKey,
    type QuickSettings,
    type RadioKey,
  } from "../lib/settings";
  import {
    BRIGHTNESS_KEY,
    normalizeBrightness,
  } from "../lib/brightness";
  import { writeStoreValueChecked } from "../lib/amosStore";
  import { themeDark, toggleTheme } from "./theme.svelte";
  import { createStoreValue } from "./store";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { t } from "./locale.svelte";
  import type { RadioControlReply } from "../lib/backend";
  import { GLASS_CONTROL_CENTER_STYLE, GLASS_BORDER_MEDIUM } from "../lib/shellChrome";
  import AirPlayPanel from "./AirPlayPanel.svelte";
  import ScreenRecordingTile from "./ScreenRecordingTile.svelte";

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

  /**
   * 这一块（快速开关、外观与勿扰）的显示由 store 决定 —— `settings` 是从 `SETTINGS_KEY`
   * 订阅来的，拒写时它**不动**，所以屏幕上不会出现假读数。但也正因为不动，一次被拒的点击
   * 就变成了「按下去什么也没发生、也没有一句话」：同一个面板里的单选框会说
   * `radio.openSettingsFailed` ∕ 拒绝原因，亮度滑杆会说 `common.storeWriteFailed`
   * （`brightnessErr` + `StoreErrorBar`，第 88 行），只有这几枚开关把裁决丢在
   * `writeStoreValue` 的 `void` 里。这里把裁决接回来，报法与滑杆逐字一致。
   *
   * 深色那一枚也走这里：主题真值是另一枚键（`amos-ui.theme`），而拒写通常来自整块
   * localStorage 不可用 —— 那时 `THEME_KEY` 同样写不进去，屏幕真的会变暗、但重启后不会
   * 保持：这句「本次改动未保存」正是要说的事，所以它**照旧立即切换**、只是如实报账。
   */
  let quickErr = $state("");
  const persist = (next: QuickSettings) => {
    // `next` is a narrowed flip; `saveQuick` carries it onto the raw blob, which also
    // holds the AI provider and the cloud prefs (REQ-A1397 ∕ F-SH-656).
    if (!saveQuick(next)) {
      quickErr = t("common.storeWriteFailed");
      return;
    }
    quickErr = "";
  };

  /** G-β-1 · 屏幕降亮（WebView 内）—— 同源自 lib/brightness.ts。
   *
   * 为什么不放在 quickRadio 那一套：brightness 是连续值（0..100 百分比），不是布尔。
   * 走独立 store key（`amos.brightness`），由 DesktopShell 订阅同一个 key 渲染
   * `<div class="brightness-overlay">`（详见 docs/DESKTOP_BRIGHTNESS_SLIDER_G_BETA_1.md）。
   * 默认 100 = 不降亮；持久化即"用户的偏好"，覆盖系统默认值。
   *
   * 诚实边界：本仓做不到 macOS 系统亮度 —— slider 上方/下方会**显式**标注
   * "仅桌面" / "Desktop only"，避免用户把它误读为系统级亮度（这是
   * docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md G6 钉住的纪律——「不摆装饰性滑杆」，
   * 我们不是摆了一个装饰性的滑杆，而是摆了一个**真实生效**的 WebView 降亮）。 */
  const brightnessStore = createStoreValue<unknown>(BRIGHTNESS_KEY, {});
  let brightnessPct = $state<number>(100);
  $effect(() => {
    const un = brightnessStore.subscribe((v) => {
      brightnessPct = normalizeBrightness(v).pct;
    });
    return un;
  });
  /** 滑杆拒写时那一句 —— 渲染在滑杆自己那一块里（见下面的亮度块）。 */
  let brightnessErr = $state("");
  const setBrightnessPct = (next: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(next)));
    if (clamped === brightnessPct) return; // 减少没必要的写盘
    // 这一枚键的**权威读者是 `DesktopShell` 的降亮遮罩**（它订阅同一个键画
    // `<div class="brightness-overlay">`）。所以拒写时本地 `brightnessPct` 必须原样不动 ——
    // 否则面板上的读数与滑杆都移到了新值，而屏幕根本没有降亮：同屏两处说同一件事，只有一处
    // 是真的（F-SH-632）。
    if (!writeStoreValueChecked(BRIGHTNESS_KEY, { pct: clamped })) {
      brightnessErr = t("common.storeWriteFailed");
      return;
    }
    brightnessErr = "";
    brightnessPct = clamped;
  };

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
        {@const state = managed(key)}
        <!-- Airplane mode owns the other radios, and `tapRadio` will not even attempt the
             write — so the tile is marked **before** the tap (the same rule the settings
             page applies: `RadioPage` disables its ToggleRow under airplane mode). Leaving
             it live made a tap do nothing at all, which is what this panel's header says
             must never happen. Both what the tile *reads* (`radioDisplayOn`) and whether it
             is live (`radioGated`) are the shared predicates tapRadio reads — this panel
             used to spell the first one out inline (`!settings.airplane && !!settings[key]`),
             which is the second copy of a rule that is only correct while it matches. -->
        {@const gated = radioGated(settings, key)}
        {@const on = radioDisplayOn(settings, key)}
        <button
          class="flex flex-col items-start gap-1 rounded-xl px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 {on
            ? 'bg-white/85 text-neutral-900'
            : 'bg-white/10 text-white/80 enabled:hover:bg-white/15'}"
          disabled={gated}
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

    <!-- Why the tiles above cannot be tapped (REQ-A1082). The sentence is the one the
         settings page already shows for the same state (`settings.airplaneBlocks`), so the
         two screens say the same thing about the same fact. -->
    {#if RADIO_TILES.some((k) => radioGated(settings, k))}
      <p data-testid="cc-airplane-blocks" class="mt-2 px-1 text-[11px] leading-snug text-white/60">
        {t("settings.airplaneBlocks")}
      </p>
    {/if}

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

    <!-- 快速开关被存储拒写时的那一句（与下面滑杆同一条纪律、同一枚 testid）。 -->
    <StoreErrorBar message={quickErr} />

    <!-- G-β-1 · 屏幕亮度滑杆（WebView 内降亮；显式标注「仅桌面」避免误读为系统亮度） -->
    <div class="mt-2 space-y-1" data-testid="cc-brightness-block">
      <div class="flex items-center justify-between px-1">
        <span class="flex items-center gap-2 text-[12px] font-medium text-white/80">
          <span data-icon="brightness" class="grid h-5 w-5 place-items-center" aria-hidden="true">
            {@html iconSvg(quickIcon("brightness"), "h-5 w-5")}
          </span>
          {t("cc.brightness")}
        </span>
        <span class="text-[10px] tabular-nums text-white/50" data-testid="cc-brightness-readout">
          {brightnessPct}%  ·  {t("cc.brightnessScope")}
        </span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={brightnessPct}
        aria-label={t("cc.brightness")}
        title={`${t("cc.brightness")} — ${t("cc.brightnessHint")}`}
        data-testid="cc-brightness"
        oninput={(e) => setBrightnessPct(Number((e.target as HTMLInputElement).value))}
        class="h-1 w-full appearance-none rounded-full bg-white/30 accent-white"
      />
      <StoreErrorBar message={brightnessErr} />
      <!-- 诚实标注：slider 控件可被屏幕阅读器读出，但视觉用户需要看这行小字 -->
      <p class="px-1 text-[10px] leading-tight text-white/40">
        {t("cc.brightnessHint")}
      </p>
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

    <!-- Screen recording (REQ-A1580) — the front door the host's `screen_record_*` commands
         never had (they were registered but no screen called them). -->
    <ScreenRecordingTile />

    <!-- 系统级手写（REQ-A1590）。唤起后本弹层收起：墨层盖住整个窗口，留着它也看不见，
         而 `openSysInk` 只清三张系统浮层，不负责关掉注册表渲染的这个弹层。 -->
    <button
      type="button"
      class="mt-2 flex w-full items-center gap-2 rounded-xl bg-white/10 px-2.5 py-2.5 text-left text-white/80 transition-colors enabled:active:bg-white/15"
      aria-label={t("sysInk.open")}
      data-testid="cc-ink"
      onclick={() => {
        openSysInk();
        onclose?.();
      }}
    >
      <span data-icon="ink" class="grid h-5 w-5 place-items-center" aria-hidden="true">
        {@html iconSvg("ink", "h-5 w-5")}
      </span>
      <span class="text-[12px] font-medium">{t("sysInk.title")}</span>
    </button>

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
