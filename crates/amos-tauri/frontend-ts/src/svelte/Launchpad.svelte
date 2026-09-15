<script lang="ts">
  // Launchpad.svelte — macOS Launchpad 全屏覆盖层。
  //
  // 桌面形态下，它是一个**注册表里的浮层**：`shellModules.ts` 的 `launchpad` 行（F4）决定
  // 它什么时候被渲染，`DesktopShell` 渲染它并把 `onclose` 传进来。入口有三个（顶栏 🚀、
  // Dock 🚀、F4），三个都汇到壳的同一个意图上。
  // 不创建新的 OS 窗口，而是作为 DesktopShell 内部的浮层叠加（`z-50`）。
  //
  // 行为：
  //   - 点击空白区域 / Esc 键 → 关闭
  //   - 顶部搜索框（实时过滤应用）
  //   - 自适配列数网格 + 80px 图标
  //   - 编辑模式：点击"编辑"按钮 → app 图标出现减号，点击可从 Dock 隐藏
  //
  // 数据：实时读 home layout（page + dock，去重） → APP_META 元信息。
  import { onMount } from "svelte";
  import { invoke } from "../lib/backend";
  import { APP_META, appIcon, appTitleKey } from "../lib/appMeta";
  import { LAYOUT_KEY, type HomeLayout, getLayout, saveLayout } from "../lib/amosStore";
  import { withoutPhone } from "../lib/phoneApps";
  import { launchpadCols, launchpadRows, LAUNCHPAD_COLS_DEFAULT, LAUNCHPAD_ROWS_DEFAULT, LAUNCHPAD_ICON_SIZE, LAUNCHPAD_ICON_GAP } from "../lib/desktopLayout";
  import { t } from "./locale.svelte";
  import { wmLayoutSnapshot } from "../lib/wm";
  import { createStoreValue } from "./store";

  // 关闭由**壳**决定：浮层从注册表渲染（`DesktopShell`），壳把 `onclose` 传进来。
  // 旧写法是 `createEventDispatcher` + `on:close`，而注册表驱动的渲染无法为每一行
  // 单独绑定事件——而且 Svelte 5 里 `$on()` 已移除，测试也订阅不到。改成 props 之后
  // 浮层可以脱离壳单独挂载（这正是"每个浮层可独立交付"的前提）。
  let { onclose }: { onclose?: () => void } = $props();

  // ─── 布局参数（自适配窗口尺寸）──────────────────────────────────────────────
  // Start from the module's documented defaults (the wide-screen design values),
  // then let the host's measured screen decide. Writing 8/5 here again would be a
  // second copy of the same numbers — and the copy is the one nobody remembers to edit.
  let cols = $state(LAUNCHPAD_COLS_DEFAULT);
  let rows = $state(LAUNCHPAD_ROWS_DEFAULT);

  $effect(() => {
    void wmLayoutSnapshot().then((s) => {
      if (s) {
        cols = launchpadCols(s.screen_w);
        rows = launchpadRows(s.screen_h);
      }
    });
  });

  // ─── 真实 app 列表（用户的 home layout 优先，再追加所有内置 app）──────────────
  const layoutStore = createStoreValue<HomeLayout>(LAYOUT_KEY, getLayout(APP_META.map((a) => a.id)));
  let layout = $state<HomeLayout>(getLayout(APP_META.map((a) => a.id)));
  $effect(() => {
    const un = layoutStore.subscribe((v) => {
      if (v && v.page) layout = v;
    });
    return un;
  });

  // 所有 app 的可见 id（page + dock 去重 + 内置 APP_META）
  // 桌面形态下，电话类 app 不显示（无 SIM / 蜂窝）。
  const visibleIds = $derived.by(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of withoutPhone([...layout.page, ...layout.dock])) {
      if (!seen.has(id) && appTitleKey(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    for (const a of withoutPhone(APP_META.map((m) => m.id))) {
      if (!seen.has(a)) {
        seen.add(a);
        ids.push(a);
      }
    }
    return ids;
  });

  // ─── 搜索 ──────────────────────────────────────────────────────────────────
  let search = $state("");
  const filteredIds = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!q) return visibleIds;
    return visibleIds.filter((id) => {
      const titleKey = appTitleKey(id);
      const name = titleKey ? t(titleKey).toLowerCase() : "";
      return name.includes(q) || id.toLowerCase().includes(q);
    });
  });

  // ─── 编辑模式 ──────────────────────────────────────────────────────────────
  let editMode = $state(false);

  function toggleEdit() {
    editMode = !editMode;
  }

  // ─── 打开应用 ──────────────────────────────────────────────────────────────
  async function openApp(id: string) {
    try {
      await invoke("wm_open", { label: id });
    } catch {
      /* ignore */
    }
    onclose?.();
  }

  // ─── 隐藏 app（编辑模式：从 home layout 中删除，落盘）───────────────────────
  function hideApp(id: string) {
    const next: HomeLayout = {
      page: layout.page.filter((x) => x !== id),
      dock: layout.dock.filter((x) => x !== id),
      hidden: [...layout.hidden.filter((x) => x !== id), id],
    };
    layout = next;
    saveLayout(next);
  }

  // ─── 键盘处理：Esc 关闭 ───────────────────────────────────────────────────
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      onclose?.();
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
</script>

<!--
  Launchpad 全屏覆盖：
  - 深色毛玻璃背景（macOS Big Sur+ 风格）
  - 顶部标题 "Launchpad" + 搜索框 + 编辑按钮
  - 应用网格（自适配列数）
  - 点击应用图标 → wm_open(id) → 关闭 Launchpad
  - 编辑模式：减号角标 → 点击 → 从 home 移除
  - Esc / 点击空白区域 关闭
-->
<div
  class="pointer-events-none fixed inset-0 z-50 flex flex-col overflow-hidden"
  data-testid="launchpad-overlay"
  style="
    background: rgba(15, 15, 15, 0.92);
    backdrop-filter: blur(40px) saturate(200%);
    -webkit-backdrop-filter: blur(40px) saturate(200%);
  "
>
  <!-- 点击空白区域关闭（pointer-events-auto 的子元素除外） -->
  <div
    class="pointer-events-auto absolute inset-0"
    role="presentation"
    aria-hidden="true"
    onclick={(e) => {
      if (e.target === e.currentTarget) onclose?.();
    }}
    onkeydown={() => { /* no-op; close via keyboard is handled at the document level */ }}
  ></div>

  <!-- 内容区（pointer-events-auto） -->
  <div
    class="pointer-events-none relative z-10 flex h-full flex-col items-center overflow-hidden pt-12"
  >
    <!-- 顶部标题 + 搜索 + 编辑 -->
    <div class="pointer-events-auto flex w-full flex-col items-center gap-4 px-8">
      <h1
        class="pt-6 text-[26px] font-semibold tracking-tight text-white"
        style="text-shadow: 0 2px 12px rgba(0,0,0,0.5);"
      >
        {t("desktop.launchpad")}
      </h1>

      <!-- 搜索框 -->
      <div
        class="relative flex w-full max-w-md items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2"
      >
        <span class="text-sm text-white/50">🔍</span>
        <input
          type="text"
          placeholder={t("desktop.search")}
          bind:value={search}
          class="flex-1 border-none bg-transparent text-[15px] text-white placeholder-white/40 outline-none"
          aria-label={t("desktop.search")}
        />
        {#if search}
          <button
            class="text-sm text-white/50 hover:text-white/80"
            aria-label={t("desktop.clear")}
            onclick={() => (search = "")}
          >✕</button>
        {/if}
      </div>

      <!-- 编辑按钮 -->
      <button
        class="pointer-events-auto rounded-full border border-white/15 bg-white/10 px-5 py-1 text-[13px] font-medium text-white/80 shadow-sm transition-all hover:border-white/25 hover:bg-white/15 hover:text-white active:scale-95"
        onclick={toggleEdit}
        aria-pressed={editMode}
      >
        {editMode ? t("desktop.done") : t("desktop.edit")}
      </button>
    </div>

    <!-- 应用网格 -->
    <div
      class="pointer-events-auto mt-6 flex flex-wrap justify-center gap-x-6 gap-y-8 overflow-y-auto px-8 pb-8"
      style="
        width: {cols * (LAUNCHPAD_ICON_SIZE + LAUNCHPAD_ICON_GAP) + 32}px;
        max-height: {rows * (LAUNCHPAD_ICON_SIZE + LAUNCHPAD_ICON_GAP + 32)}px;
      "
      role="grid"
      aria-label={t("desktop.launchpad")}
    >
      {#each filteredIds as id (id)}
        <button
          class="group flex flex-col items-center gap-2"
          onclick={() => editMode ? hideApp(id) : openApp(id)}
          aria-label={appTitleKey(id) ? t(appTitleKey(id)!) : id}
        >
          <!-- 应用图标 -->
          <div class="relative">
            <span
              class="flex items-center justify-center rounded-[22px] bg-gradient-to-br from-neutral-700 to-neutral-900 shadow-xl transition-transform group-hover:-translate-y-1 group-active:scale-90"
              style="
                width:{LAUNCHPAD_ICON_SIZE}px;
                height:{LAUNCHPAD_ICON_SIZE}px;
                font-size:{Math.round(LAUNCHPAD_ICON_SIZE * 0.6)}px;
                border: 1px solid rgba(255,255,255,0.1);
                box-shadow: 0 4px 16px rgba(0,0,0,0.4);
              "
            >
              {appIcon(id)}
            </span>

            <!-- 编辑模式：减号删除标记 -->
            {#if editMode}
              <span
                class="absolute -left-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-danger text-[10px] font-bold text-white shadow-md"
                style="border: 1.5px solid rgba(255,255,255,0.2);"
                aria-hidden="true"
              >−</span>
            {/if}
          </div>

          <!-- 应用名称 -->
          <span
            class="max-w-full truncate text-center text-[11px] leading-tight text-white/80"
            style="width:{LAUNCHPAD_ICON_SIZE}px;"
          >
            {appTitleKey(id) ? t(appTitleKey(id)!) : id}
          </span>
        </button>
      {/each}

      <!-- 无结果提示 -->
      {#if filteredIds.length === 0}
        <p class="mt-12 text-[15px] text-white/40">{t("desktop.noResults")}</p>
      {/if}
    </div>
  </div>
</div>
