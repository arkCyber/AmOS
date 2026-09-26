<script lang="ts">
  // WallpaperCard.svelte — Svelte 5 (runes) port of the React WallpaperCard
  // (main/home wallpaper chooser shown in Settings). Persists to amos.settings
  // ({ wallpaper, background }) through pure lib/wallpaper + the shared store.
  import { readStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import {
    BACKGROUND_MODES,
    DEFAULT_BG_MODE,
    WALLPAPER_PRESETS,
    isBgMode,
    isCustomWallpaper,
    type BgModeId,
  } from "../lib/wallpaper";
  import { t } from "./locale.svelte";
  import StoreErrorBar from "./StoreErrorBar.svelte";

  const GROUP =
    "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const pillCls = (active: boolean) =>
    "rounded-full px-3 py-1.5 text-xs transition " +
    (active ? "bg-accent text-white" : "bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300");

  const PRESET_LABEL: Record<(typeof WALLPAPER_PRESETS)[number], string> = {
    auto: "wp.auto",
    dark: "wp.dark",
    light: "wp.light",
    landscape: "wp.landscape",
    dawn: "wp.dawn",
    abyss: "wp.abyss",
  };
  const MODE_LABEL: Record<BgModeId, string> = {
    ghost: "bg.ghost",
    soft: "bg.soft",
    muted: "bg.muted",
    vivid: "bg.vivid",
  };

  function readPrefs(): Record<string, unknown> {
    return readStoreValue<Record<string, unknown>>("amos.settings", {});
  }
  const initial = readPrefs();
  const initialWall =
    typeof initial.wallpaper === "string" ? (initial.wallpaper as string) : undefined;
  let wall = $state<string | undefined>(initialWall);
  let url = $state(initialWall && isCustomWallpaper(initialWall) ? initialWall : "");
  // The domain owns "is this a known background mode" (`lib/wallpaper.isBgMode`).
  // The card must not re-derive it from its own label map with a cast: a mode added
  // to the domain but not mirrored here would silently fall back to the default.
  const storedBg = initial.background;
  const initialBg: BgModeId =
    typeof storedBg === "string" && isBgMode(storedBg) ? storedBg : DEFAULT_BG_MODE;
  let bgSel = $state<BgModeId>(initialBg);

  let storeErr = $state("");

  // 写入必须先问判决，再动本地读数（REQ-A1359 ∕ F-SH-623）。`writeStoreValue` 只返回
  // void —— 配额满 ∕ 存储不可用时它把异常吞掉，于是「盘上收下了」与「盘上拒绝了」在这张
  // 卡片看来字节相同：药丸照旧点亮，而真正读这枚键的读者（`Backdrop.svelte` 订阅
  // `amos.settings` 画桌面壁纸）纹丝不动，屏幕上一个字都不解释。`DockPage.svelte:52` 写
  // 另一枚偏好的同一条规则是这里的先例：拒写要挂横幅、不许把没落盘的选择画在屏幕上。
  // 本地的读数**只**在落盘成功之后才动 —— 先问判决，再动屏幕。与 `DockPage.svelte:52` 同义，
  // 只是次序不同：那边先改读数再持久化，所以拒写后要额外回滚一次；这里门挡在 `apply()` 前面，
  // 屏幕本来就还停在盘上那个值上，没有可回滚的第二份读数。`url` 是用户敲进去的文本，它不上
  // 盘，也不必在拒写时被抹掉 —— 那是用户还能重试的输入。
  const commit = (patch: Record<string, unknown>, apply: () => void) => {
    if (!writeStoreValueChecked("amos.settings", { ...readPrefs(), ...patch })) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    apply();
  };

  const pick = (id: string) =>
    commit({ wallpaper: id }, () => {
      wall = id;
      url = id;
    });
  const setCustom = () => {
    const v = url.trim();
    if (v) commit({ wallpaper: v }, () => (wall = v));
  };
  const pickBg = (id: BgModeId) => commit({ background: id }, () => (bgSel = id));
  const presetActive = (id: string) => wall === id || (!wall && id === "auto");
</script>

<section class={"p-4 " + GROUP}>
  <StoreErrorBar message={storeErr} />
  <h3 class="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">{t("wp.label")}</h3>
  <div class="mt-2 flex flex-wrap gap-2">
    {#each WALLPAPER_PRESETS as id (id)}
      <button onclick={() => pick(id)} class={pillCls(presetActive(id))}>
        {t(PRESET_LABEL[id])}
      </button>
    {/each}
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
  <h4 class="mt-4 text-xs opacity-70">{t("bg.label")}</h4>
  <div class="mt-1 flex flex-wrap gap-2">
    {#each BACKGROUND_MODES as m (m.id)}
      <button onclick={() => pickBg(m.id)} class={pillCls(bgSel === m.id)}>
        {t(MODE_LABEL[m.id])}
      </button>
    {/each}
  </div>
</section>
