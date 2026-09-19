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
  import { announceAppOpened } from "../lib/shortcuts";
  import { APP_META, appIcon, appTitleKey } from "../lib/appMeta";
  import { LAYOUT_KEY, type HomeLayout, getLayout } from "../lib/amosStore";
  import { withoutPhone } from "../lib/phoneApps";
  import { wmOpenWithDiag, wmOpen } from "../lib/wm";
  import { createStoreValue } from "./store";
  import { t } from "./locale.svelte";
  import { SPOTLIGHT_WIDTH, SPOTLIGHT_HEIGHT, SPOTLIGHT_INPUT_HEIGHT } from "../lib/desktopLayout";
  import { GLASS_SPOTLIGHT_STYLE, GLASS_BORDER_SUBTLE } from "../lib/shellChrome";
  import { calcQuery } from "../lib/calculator";
  import { FILES_KEY, folderPath, normalizeFiles, searchFiles, type FEntry } from "../lib/files";
  import { buildSpotlightResults, type SpotlightRow } from "../lib/spotlightSearch";
  import { revealFileAcrossWindows } from "./appLinks";
  import { clipboardWrite } from "../lib/clipboard";

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

  // ─── 搜索结果（REQ-A458：应用 + 文件 + 计算，一张列表）────────────────────────────
  // 规则、顺序与上界住在 `lib/spotlightSearch.ts`（纯函数、已单测）；这里只负责把三个
  // 来源喂给它：应用的（已本地化）名字、文件域自己的匹配器 `searchFiles`、以及计算器
  // app 自己的引擎 `calcQuery`。三个来源各自都有"唯一真源"，所以 Spotlight 不会算出
  // 一个与「计算器」不同的答案，也不会发明自己的文件匹配规则。
  const filesStore = createStoreValue<unknown>(FILES_KEY, []);
  let files = $state<FEntry[]>([]);
  $effect(() => {
    const un = filesStore.subscribe((raw) => {
      files = normalizeFiles(raw);
    });
    return un;
  });

  const results = $derived.by(() => {
    const q = query.trim();
    const lower = q.toLowerCase();
    return buildSpotlightResults(query, {
      apps: allApps.filter(
        (a) => a.name.toLowerCase().includes(lower) || a.id.toLowerCase().includes(lower),
      ),
      files: q
        ? searchFiles(files, q, true).map((e) => ({
            id: e.id,
            name: e.name,
            // Where the hit lives — a global file search must say so (same rule the touch
            // panel and the Files screen's own global search follow).
            subtitle: folderPath(files, e.id) || null,
          }))
        : [],
      calculation: calcQuery(q),
    });
  });

  /** What the last activation did, when it needs saying (a copied calculation). */
  let notice = $state("");

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
    // REQ-A297 phase-2 §4: `invoke` swallows failures into `null` (REQ-A296).
    // The earlier try/catch was dead code. A silently-failed `wm_open` from
    // Spotlight would feel like "Enter doesn't do anything" — log the null
    // for ops but still close the panel (better than leaving the user with
    // a dead modal over their desktop).
    const r = await wmOpenWithDiag(id);
    if (!r.ok) {
      const diag = r.diag;
      if (!diag.ok) {
        // Only the `{ ok: false, kind: ... }` shape carries `kind` / `detail`
        // — narrowed here so svelte-check sees the union.
        const code =
          diag.kind === "command-failed" &&
          diag.detail &&
          typeof diag.detail === "object"
            ? (diag.detail as { code?: string }).code
            : undefined;
        // Soft log; the panel closes regardless. Keeps the failure visible
        // in the diagnostic ledger without overwhelming the user.
        console.warn(`[Spotlight] wm_open(${id}) refused`, code ?? diag.kind);
      }
    } else {
      // An app really opened → tell the automation runtime (`app` triggers).
      announceAppOpened(id);
    }
    onclose?.();
  }

  /**
   * Run a row (REQ-A458). The three kinds end differently, and each difference is the promise the
   * row makes:
   *
   *   * `app` — `wm_open` (create + focus) and the panel closes: the user is now looking at it.
   *   * `calc` — the value goes to the **clipboard** and the panel stays open. The shell cannot
   *     seed the Calculator window with a value (`wm_open` carries a label and nothing else), so
   *     opening it would lose the number the user just typed; macOS's own answer here (⌘C on a
   *     calculation) is honest *and* useful. A refused clipboard write says so instead of claiming
   *     a copy that did not happen.
   *   * `file` — open the Files window and hand it the entry through the **cross-window** store.
   *     A refused write is reported: "Files opened at the root" is not what the row promised.
   */
  function activate(row: SpotlightRow): void {
    notice = "";
    if (row.kind === "app") {
      void openApp(row.id);
      return;
    }
    if (row.kind === "calc") {
      // `invoke` never rejects — it resolves to `null` when the bridge is missing or the host
      // refused (REQ-A296) — so the answer is read from the **value**, not from a `.catch()`
      // (a catch here would be dead code, and this repo has removed that shape before).
      void clipboardWrite({ kind: "text", text: row.id }, "spotlight.calc").then((entry) => {
        notice = entry === null ? t("desktop.spotlightCopyFailed") : t("desktop.spotlightCopied");
      });
      return;
    }
    if (!revealFileAcrossWindows(row.id)) {
      // The store refused the intent (full/unavailable) — say it, then still open Files: the
      // user asked for a window, and a window is what they can get.
      console.warn(`🛟 [Spotlight] could not queue the reveal for '${row.id}' (store refused)`);
    }
    void wmOpen("files");
    onclose?.();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      onclose?.();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.min(selected + 1, Math.max(0, results.rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results.rows[selected];
      if (r) activate(r);
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
    {GLASS_SPOTLIGHT_STYLE}
    {GLASS_BORDER_SUBTLE}
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
    {#if results.rows.length > 0}
      <div class="flex-1 overflow-y-auto p-2" role="listbox" aria-label={t("desktop.searchResults")}>
        {#each results.rows as result, i (result.key)}
          <button
            class="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-[15px] text-white/80 transition-colors {i === selected ? 'bg-blue-500/40 text-white' : 'hover:bg-white/10'}"
            role="option"
            aria-selected={i === selected}
            data-testid="spotlight-row-{result.kind}"
            onmouseenter={() => (selected = i)}
            onclick={() => activate(result)}
          >
            <span class="text-xl" aria-hidden="true">{result.icon ?? (result.kind === "calc" ? "=" : "📄")}</span>
            <span class="min-w-0 flex-1">
              <span class="block truncate">{result.title}</span>
              {#if result.subtitle}
                <span class="block truncate text-[11px] text-white/40">{result.subtitle}</span>
              {/if}
            </span>
            <!-- What this row is — a screen reader must not have to guess from the glyph. -->
            <span class="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-white/50 ring-1 ring-white/15">
              {t(`desktop.spotlightKind.${result.kind}`)}
            </span>
            {#if i === selected}<span class="text-[11px] text-white/40">↵</span>{/if}
          </button>
        {/each}
        {#if results.hidden.apps + results.hidden.files > 0}
          <!-- Bounded, not silently truncated: the caps live in `lib/spotlightSearch.ts`. -->
          <p class="px-4 py-1 text-[11px] text-white/30" data-testid="spotlight-more">
            {t("desktop.spotlightMore", { n: results.hidden.apps + results.hidden.files })}
          </p>
        {/if}
      </div>
      {#if notice}
        <p class="border-t border-white/10 px-5 py-2 text-[12px] text-white/70" role="status" data-testid="spotlight-notice">
          {notice}
        </p>
      {/if}
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
