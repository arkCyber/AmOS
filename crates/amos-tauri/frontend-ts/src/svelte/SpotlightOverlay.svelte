<script lang="ts">
  // SpotlightOverlay.svelte — macOS Spotlight 居中浮层。
  //
  // 桌面形态下，由 DesktopShell 处理 ⌘ Space 快捷键触发。
  // 居中浮层，宽 600px，巨大搜索输入框（macOS Big Sur 风格）。
  //
  // 数据：实时读 home layout 的 `page + dock`（去重）→ APP_META 元信息（icon + i18n 名称）。
  // 搜索：按名称 / id 子串匹配（大小写不敏感）。
  // 选中：Enter 打开 / 单击打开 → wm_open(id) → 关闭浮层。
  import { onMount } from "svelte";
  import { invoke } from "../lib/backend";
  import { APP_META, appIcon, appTitleKey } from "../lib/appMeta";
  import { LAYOUT_KEY, type HomeLayout, getLayout } from "../lib/amosStore";
  import { withoutPhone } from "../lib/phoneApps";
  import { createStoreValue } from "./store";
  import { t } from "./locale.svelte";
  import { SPOTLIGHT_WIDTH, SPOTLIGHT_HEIGHT, SPOTLIGHT_INPUT_HEIGHT } from "../lib/desktopLayout";

  // 关闭由壳决定（浮层从注册表渲染，壳传 `onclose`）——见 Launchpad.svelte 的同一处说明。
  let { onclose }: { onclose?: () => void } = $props();

  let query = $state("");
  let inputEl = $state<HTMLInputElement | null>(null);

  // ─── 真实应用列表（从 home layout + dock 合并去重）────────────────────────────────
  const layoutStore = createStoreValue<HomeLayout>(LAYOUT_KEY, getLayout(APP_META.map((a) => a.id)));
  let layout = $state<HomeLayout>(getLayout(APP_META.map((a) => a.id)));
  $effect(() => {
    const un = layoutStore.subscribe((v) => {
      if (v && v.page) layout = v;
    });
    return un;
  });

  interface AppEntry {
    id: string;
    icon: string;
    name: string;
  }
  // 全部可搜 app（用户的 home layout + 所有内置 app，去重；电话类 app 在桌面形态下不显示）
  const allApps = $derived.by<AppEntry[]>(() => {
    const seen = new Set<string>();
    const result: AppEntry[] = [];
    // 优先放 layout 中的（按用户排序），再追加未安装的；过滤电话类 app
    const candidates = withoutPhone([...layout.page, ...layout.dock, ...APP_META.map((a) => a.id)]);
    for (const id of candidates) {
      if (seen.has(id)) continue;
      seen.add(id);
      const titleKey = appTitleKey(id);
      if (!titleKey) continue; // 跳过未注册的 id（如 store tile 占位）
      result.push({ id, icon: appIcon(id), name: t(titleKey) });
    }
    return result;
  });

  // ─── 搜索结果 ─────────────────────────────────────────────────────────────────
  const results = $derived.by<AppEntry[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allApps.filter(
      (a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q),
    ).slice(0, 8); // macOS Spotlight 最多展示 ~10 条
  });

  // 键盘：上下选择 + Enter 打开
  let selected = $state(0);
  // Reset the selection whenever the query changes. This is ONE effect reading
  // `query` — it used to be an `$effect` *nested inside another* `$effect`, which
  // Svelte 5 warns about and which ran the reset on the wrong dependency graph.
  $effect(() => {
    void query;
    selected = 0;
  });

  async function openApp(id: string) {
    try {
      await invoke("wm_open", { label: id });
    } catch {
      /* ignore */
    }
    onclose?.();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      onclose?.();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.min(selected + 1, Math.max(0, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[selected];
      if (r) void openApp(r.id);
    }
  }

  // 自动聚焦输入框
  onMount(() => {
    inputEl?.focus();
  });
</script>

<!--
  Spotlight 居中浮层：
  - 宽 600px，圆角 12px
  - 深色毛玻璃背景
  - 巨大搜索输入框（macOS Big Sur 风格，22px 字号）
  - 结果列表（可点击 / Enter 跳转）
  - 上下方向键 + Enter 选择
  - Esc 关闭
-->
<div
  class="pointer-events-none fixed inset-0 z-[100] flex items-start justify-center pt-24"
  style="background: rgba(0, 0, 0, 0.35);"
  role="presentation"
  onclick={(e) => { if (e.target === e.currentTarget) onclose?.(); }}
  onkeydown={(e) => { if (e.key === "Escape") onclose?.(); }}
  data-testid="spotlight-backdrop"
>
  <!-- 浮层容器 -->
  <div
    class="pointer-events-auto flex flex-col overflow-hidden rounded-2xl shadow-2xl"
    role="dialog"
    aria-modal="true"
    aria-label={t("desktop.spotlight")}
    tabindex="-1"
    data-testid="spotlight-overlay"
    style="
      width:{SPOTLIGHT_WIDTH}px;
      max-height:{SPOTLIGHT_HEIGHT}px;
      background:rgba(40, 40, 40, 0.92);
      backdrop-filter:blur(30px) saturate(200%);
      -webkit-backdrop-filter:blur(30px) saturate(200%);
      border:1px solid rgba(255,255,255,0.08);
    "
  >
    <!-- 搜索输入 -->
    <div class="flex items-center gap-3 border-b border-white/10 px-5 py-4">
      <span class="text-[22px] text-white/50">🔍</span>
      <input
        bind:this={inputEl}
        type="text"
        bind:value={query}
        onkeydown={onKeyDown}
        placeholder={t("desktop.spotlightPlaceholder")}
        class="flex-1 border-none bg-transparent text-[22px] text-white placeholder-white/35 outline-none"
        style="height:{SPOTLIGHT_INPUT_HEIGHT}px;"
        aria-label={t("desktop.spotlight")}
      />
      {#if query}
        <button
          class="text-sm text-white/40 hover:text-white/70"
          aria-label={t("desktop.clear")}
          onclick={() => (query = "")}
        >✕</button>
      {/if}
    </div>

    <!-- 结果列表 -->
    {#if results.length > 0}
      <div class="flex-1 overflow-y-auto p-2" role="listbox" aria-label={t("desktop.searchResults")}>
        {#each results as result, i (result.id)}
          <button
            class="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-[15px] text-white/80 transition-colors {i === selected ? 'bg-blue-500/40 text-white' : 'hover:bg-white/10'}"
            role="option"
            aria-selected={i === selected}
            onmouseenter={() => (selected = i)}
            onclick={() => openApp(result.id)}
          >
            <span class="text-xl">{result.icon}</span>
            <span class="flex-1">{result.name}</span>
            <span class="text-[11px] text-white/40">↵</span>
          </button>
        {/each}
      </div>
    {:else if query.trim()}
      <div class="flex items-center justify-center p-8 text-[13px] text-white/30">
        {t("desktop.noResults")}
      </div>
    {:else}
      <!-- 空白状态：显示快捷命令 -->
      <div class="flex flex-col gap-1 p-2" data-testid="spotlight-quick-actions">
        <p class="px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-white/30">
          {t("desktop.quickActions")}
        </p>
        {#each allApps.slice(0, 5) as app, i (app.id)}
          <button
            class="flex w-full items-center gap-3 rounded-lg px-4 py-2 text-left text-[14px] text-white/60 transition-colors {i === selected ? 'bg-blue-500/30' : 'hover:bg-white/10'}"
            onmouseenter={() => (selected = i)}
            onclick={() => openApp(app.id)}
          >
            <span class="text-lg">{app.icon}</span>
            <span>{app.name}</span>
          </button>
        {/each}
        {#if allApps.length === 0}
          <p class="px-4 py-3 text-[12px] text-white/30">{t("desktop.noApps")}</p>
        {/if}
      </div>
    {/if}
  </div>
</div>
