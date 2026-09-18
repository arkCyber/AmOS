<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "../locale.svelte";
  import { readStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
  import { DOCK_PREFS_KEY, normalizeDockPrefs, DEFAULT_DOCK_PREFS } from "../../lib/dockPrefs";
  import type { DockPrefs, DockPosition } from "../../lib/dockPrefs";
  import StoreErrorBar from "../StoreErrorBar.svelte";
  import { nextFieldId } from "./kit";

  // 每一处可见标签与它的控件由**同一枚 id** 相连（REQ-A283）：控件的名字必须来自
  // 用户看得见的标签，而手写 id 正是这两半最容易漂移的地方 —— 所以从 kit 的
  // 计数器取（一次挂载取一次，稳定且不重复）。
  const positionLabelId = nextFieldId();
  const autoHideLabelId = nextFieldId();
  const magnificationId = nextFieldId();
  const iconSizeId = nextFieldId();

  let prefs = $state<DockPrefs>({ ...DEFAULT_DOCK_PREFS });
  let storeError = $state<string>("");
  let loaded = $state(false);

  onMount(() => {
    const raw = readStoreValue<unknown>(DOCK_PREFS_KEY, {});
    prefs = normalizeDockPrefs(raw);
    loaded = true;
  });

  function persist(): void {
    const success = writeStoreValueChecked(DOCK_PREFS_KEY, prefs);
    storeError = success ? "" : "Failed to save dock preferences";
  }

  function setPosition(pos: DockPosition): void {
    prefs.position = pos;
    persist();
  }

  function toggleAutoHide(): void {
    prefs.autoHide = !prefs.autoHide;
    persist();
  }

  function setMagnification(value: number): void {
    prefs.magnification = Math.max(1.0, Math.min(2.0, value));
    persist();
  }

  function setIconSize(value: number): void {
    prefs.iconSize = Math.max(32, Math.min(64, Math.round(value)));
    persist();
  }
</script>

<div class="flex h-full flex-col overflow-y-auto bg-neutral-50 dark:bg-black">
  <StoreErrorBar message={storeError} />

  {#if !loaded}
    <div class="flex flex-1 items-center justify-center">
      <div class="text-sm opacity-60">{t("settings.loading")}</div>
    </div>
  {:else}
    <div class="flex-1 space-y-6 p-6">
      <!-- Header -->
      <div>
        <h2 class="text-2xl font-semibold text-neutral-900 dark:text-white">
          {t("settings.dock.title")}
        </h2>
        <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {t("settings.dock.description")}
        </p>
      </div>

      <!-- Position -->
      <div class="space-y-3">
        <!-- 这里标签的是一**组**按钮（不是单个控件）⇒ 用 `role="group"` +
             `aria-labelledby` 把这组按钮命名，而不是一个指向不存在的控件的 `<label>`。 -->
        <span id={positionLabelId} class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          {t("settings.dock.position")}
        </span>
        <div class="flex gap-2" role="group" aria-labelledby={positionLabelId}>
          <button
            onclick={() => setPosition("bottom")}
            class="flex-1 rounded-xl px-4 py-3 text-sm font-medium transition {prefs.position === 'bottom' ? 'bg-accent text-white shadow-md' : 'bg-white text-neutral-700 ring-1 ring-neutral-200 hover:bg-neutral-50 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700 dark:hover:bg-neutral-750'}"
            aria-pressed={prefs.position === "bottom"}
          >
            {t("settings.dock.bottom")}
          </button>
          <button
            onclick={() => setPosition("left")}
            class="flex-1 rounded-xl px-4 py-3 text-sm font-medium transition {prefs.position === 'left' ? 'bg-accent text-white shadow-md' : 'bg-white text-neutral-700 ring-1 ring-neutral-200 hover:bg-neutral-50 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700 dark:hover:bg-neutral-750'}"
            aria-pressed={prefs.position === "left"}
          >
            {t("settings.dock.left")}
          </button>
          <button
            onclick={() => setPosition("right")}
            class="flex-1 rounded-xl px-4 py-3 text-sm font-medium transition {prefs.position === 'right' ? 'bg-accent text-white shadow-md' : 'bg-white text-neutral-700 ring-1 ring-neutral-200 hover:bg-neutral-50 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700 dark:hover:bg-neutral-750'}"
            aria-pressed={prefs.position === "right"}
          >
            {t("settings.dock.right")}
          </button>
        </div>
      </div>

      <!-- Auto-hide -->
      <div class="flex items-center justify-between rounded-xl bg-white p-4 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-800 dark:ring-neutral-700">
        <div class="flex-1">
          <div id={autoHideLabelId} class="text-sm font-medium text-neutral-900 dark:text-white">
            {t("settings.dock.autoHide")}
          </div>
          <div class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t("settings.dock.autoHideDesc")}
          </div>
        </div>
        <!-- 自动隐藏开关：**命中区 44×56，视觉仍是 32×56 的轨道** —— 按钮承担命中区，
             轨道是里面那条 32 高的圆角条。原来按钮自己只有 32 高（低于 HIG / WCAG-AAA
             的 44），手指容易落在轨道外（REQ-A387）。 -->
        <button
          onclick={toggleAutoHide}
          role="switch"
          aria-checked={prefs.autoHide}
          aria-labelledby={autoHideLabelId}
          class="grid h-11 w-14 place-items-center"
        >
          <span
            class="relative block h-8 w-14 rounded-full transition {prefs.autoHide
              ? 'bg-accent'
              : 'bg-neutral-300 dark:bg-neutral-600'}"
          >
            <span
              class="absolute top-1 h-6 w-6 rounded-full bg-white shadow-md transition {prefs.autoHide
                ? 'left-7'
                : 'left-1'}"
            ></span>
          </span>
        </button>
      </div>

      <!-- Magnification -->
      <div class="space-y-3">
        <div class="flex items-baseline justify-between">
          <label for={magnificationId} class="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            {t("settings.dock.magnification")}
          </label>
          <span class="text-sm font-mono text-accent">{prefs.magnification.toFixed(1)}x</span>
        </div>
        <input
          id={magnificationId}
          type="range"
          min="1.0"
          max="2.0"
          step="0.1"
          value={prefs.magnification}
          oninput={(e) => setMagnification(parseFloat(e.currentTarget.value))}
          class="h-2 w-full cursor-pointer appearance-none rounded-full bg-neutral-200 dark:bg-neutral-700 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:transition [&::-webkit-slider-thumb]:hover:scale-110"
        />
        <div class="flex justify-between text-xs text-neutral-500 dark:text-neutral-400">
          <span>{t("settings.dock.small")}</span>
          <span>{t("settings.dock.large")}</span>
        </div>
      </div>

      <!-- Icon Size -->
      <div class="space-y-3">
        <div class="flex items-baseline justify-between">
          <label for={iconSizeId} class="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            {t("settings.dock.iconSize")}
          </label>
          <span class="text-sm font-mono text-accent">{prefs.iconSize}px</span>
        </div>
        <input
          id={iconSizeId}
          type="range"
          min="32"
          max="64"
          step="4"
          value={prefs.iconSize}
          oninput={(e) => setIconSize(parseFloat(e.currentTarget.value))}
          class="h-2 w-full cursor-pointer appearance-none rounded-full bg-neutral-200 dark:bg-neutral-700 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:transition [&::-webkit-slider-thumb]:hover:scale-110"
        />
        <div class="flex justify-between text-xs text-neutral-500 dark:text-neutral-400">
          <span>32px</span>
          <span>64px</span>
        </div>
      </div>

      <!-- Preview hint -->
      <div class="rounded-xl bg-accent/10 p-4 ring-1 ring-accent/20">
        <div class="text-sm text-accent dark:text-accent/90">
          💡 {t("settings.dock.previewHint")}
        </div>
      </div>
    </div>
  {/if}
</div>
