<script lang="ts">
  // LockWallpaperCard.svelte — Svelte 5 (runes) port of the React LockWallpaperCard
  // ("锁屏背景" config in Settings). Choose a built-in wallpaper or add a custom
  // image (URL or ≤2.5MB upload); persisted as amos.settings.lockWallpaper for the
  // LockScreen backdrop.
  import { readStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import {
    WALLPAPER_FILES,
    WALLPAPER_PRESETS,
    isCustomWallpaper,
  } from "../lib/wallpaper";
  import { t } from "./locale.svelte";
  import StoreErrorBar from "./StoreErrorBar.svelte";

  const GROUP =
    "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const pillCls = (active: boolean) =>
    "rounded-full px-3 py-1.5 text-xs transition " +
    (active ? "bg-accent text-white" : "bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300");
  const MAX_UPLOAD_BYTES = 2.5 * 1024 * 1024;

  const PRESET_LABEL: Record<(typeof WALLPAPER_PRESETS)[number], string> = {
    auto: "wp.auto",
    dark: "wp.dark",
    light: "wp.light",
    landscape: "wp.landscape",
    dawn: "wp.dawn",
    abyss: "wp.abyss",
  };

  function readPrefs(): Record<string, unknown> {
    return readStoreValue<Record<string, unknown>>("amos.settings", {});
  }
  const initial = readPrefs();
  const initialActive =
    typeof initial.lockWallpaper === "string" ? (initial.lockWallpaper as string) : undefined;
  let active = $state<string | undefined>(initialActive);
  let url = $state(initialActive && isCustomWallpaper(initialActive) ? initialActive : "");
  let note = $state<string | null>(null);
  let storeErr = $state("");

  // 同 `WallpaperCard`（REQ-A1359 ∕ F-SH-623）：`writeStoreValue` 只返回 void，拒写与成功
  // 在这张卡片看来字节相同。锁屏这张更重 —— 拒写的上传把 `active` 设成 data URL，于是
  // **预览图**画了出来，而那串字节从未落盘，锁屏上永远不会出现它。
  // 落盘成功才动 `active`：四条写入路径（预设 ∕ 自设 ∕ 清除 ∕ 上传）共用这一道门。
  const commit = (patch: Record<string, unknown>, apply: () => void) => {
    if (!writeStoreValueChecked("amos.settings", { ...readPrefs(), ...patch })) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    apply();
  };

  const previewSrc = $derived.by(() => {
    if (!active) return null;
    if (isCustomWallpaper(active)) return active;
    const f = WALLPAPER_FILES[active];
    return f ? `wallpapers/${f}` : null;
  });
  const pick = (id: string) =>
    commit({ lockWallpaper: id }, () => {
      active = id;
      url = "";
      note = null;
    });
  const setCustom = () => {
    const v = url.trim();
    if (v)
      commit({ lockWallpaper: v }, () => {
        active = v;
        note = null;
      });
  };
  const clear = () =>
    commit({ lockWallpaper: "" }, () => {
      active = undefined;
      url = "";
      note = null;
    });
  const onFile = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) {
      note = t("wp.tooLarge");
      input.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result : "";
      if (data)
        commit({ lockWallpaper: data }, () => {
          active = data;
          url = "";
          note = null;
        });
    };
    reader.readAsDataURL(f);
  };
</script>

<section class={"p-4 " + GROUP}>
  <StoreErrorBar message={storeErr} />
  <div class="flex items-center justify-between">
    <h3 class="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">{t("wp.lockLabel")}</h3>
    {#if active}
      <button onclick={clear} class={pillCls(false)}>
        {t("wp.clear")}
      </button>
    {/if}
  </div>
  {#if note}
    <p class="mt-1 text-xs text-danger">{note}</p>
  {/if}
  {#if previewSrc}
    <div class="mt-3 h-24 w-full overflow-hidden rounded-xl bg-black/10 ring-1 ring-black/10 dark:ring-white/10">
      <img src={previewSrc} alt={t("wp.lockLabel")} class="h-full w-full object-cover" />
    </div>
  {/if}
  <div class="mt-2 flex flex-wrap gap-2">
    {#each WALLPAPER_PRESETS as id (id)}
      <button onclick={() => pick(id)} class={pillCls(active === id)}>
        {t(PRESET_LABEL[id])}
      </button>
    {/each}
    <label class={"cursor-pointer " + pillCls(false)}>
      {t("wp.upload")}
      <input type="file" accept="image/*" class="hidden" onchange={onFile} />
    </label>
  </div>
  <div class="mt-3 flex gap-2">
    <input
      bind:value={url}
      placeholder={t("wp.customPh")}
      class="min-w-0 flex-1 rounded-full bg-black/5 px-3 py-1.5 text-xs outline-none dark:bg-white/10"
    />
    <button onclick={setCustom} class={pillCls(false)}>
      {t("bg.customPh")}
    </button>
  </div>
</section>
