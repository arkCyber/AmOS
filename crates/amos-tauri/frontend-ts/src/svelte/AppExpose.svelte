<script lang="ts">
  /**
   * AppExpose.svelte — macOS 的 **App Exposé**（`⌃↓`，「应用程序窗口」）：把**焦点应用**的
   * 每一扇窗铺成一个瓷砖网格，点一扇就切到它（REQ-A476）。
   *
   * 与 Mission Control 的分工（这是 macOS 自己的分工，不是两种观感）：
   *   * `⌃↑` / `F3` → **Mission Control**：所有应用的窗口，加上 Spaces 栏；
   *   * `⌃↓` → **App Exposé**：只有**当前那个应用**的窗口。
   *
   * 为什么它现在才可能出现：直到身份模型（REQ-A473）落地，"一个应用的窗口"这个集合才存在
   * —— 在那之前宿主一个 label 只有一个窗口，铺开一扇窗没有任何意义。
   *
   * 数据与控制流，逐条说明：
   *   * 读 `wm_windows`（`wmWindows()`，**经规范化**：即便宿主没报 `app`/`instance`，
   *     label 也会被解析成身份），用 `focusedAppOf` 找出焦点应用的 app id，再用
   *     `windowsOfApp` 取它自己的窗口 —— 三个判断都来自 `lib/wm.ts` 的同一组纯函数，
   *     与 ⌘`/⌘N 用的是同一条"哪个应用"的规则；
   *   * 名字用共享的 `windowName`（实例窗口显示「文件 — 2」而不是 `files_2`），图标用应用
   *     的 `appIcon` —— 与 Mission Control 同一套解析；
   *   * 点击 → `wmFocusWithDiag(label)`（**寻址的是窗口**：label 才是宿主的标识）后关闭；
   *     被拒绝时写一条 `🛟` 面包屑而不是静默（REQ-A297 §4 的类型化错误纪律）；
   *   * `Esc` / 点空白处 / 焦点陷阱：与 MissionControl 同形（WCAG 2.1.2）；
   *   * **应用不足两扇窗时不渲染任何东西**（`shouldShowAppExpose`）—— 壳在开之前就问过这个
   *     问题并会把原因说出来（`desktopSystemKeys.appExposeRefusal`），这里是第二道防线：
   *     一个"打开着但什么都没有"的面板比不开更糟。
   *
   * 诚实边界：
   *   * **没有缩略图**：瓷砖用应用图标，与 Mission Control 的预览占位同一条边界（真缩略图
   *     需要宿主把每扇窗的像素交出来，本仓没有这条路）。
   *   * **不排序**：顺序就是宿主给的顺序（`windowsOfApp` 不重排）——本轮不引入第二种顺序；
   *     宿主之后若给出 z 序，这里应跟着走。
   *   * 键盘：Tab 走瓷砖（焦点陷阱保证不跑出去）；方向键由 `lib/overviewKeys` 统一驱动
   *     （←/→ 在行内走并在两端回环，单行面板里 ↑/↓ 等同于 ←/→）—— 与 MissionControl
   *     共用同一个属主，两个面板不可能各走各的。
   */
  import { getContext, onMount } from "svelte";
  import {
    focusedAppOf,
    windowAppId,
    windowsOfApp,
    wmFocusWithDiag,
    wmWindows,
    type WmWindowInfo,
  } from "../lib/wm";
  import { iconForId } from "../lib/appLookup";
  import { getStoreTiles, type StoreTile } from "../lib/storeApps";
  import { SHELL_CHROME_API, type ShellChromeApi } from "../lib/shellModule";
  import { shouldShowAppExpose } from "../lib/desktopLayout";
  import { attachFocusTrap } from "../lib/focusTrap";
  import { installOverviewKeyboard } from "../lib/overviewKeys";
  import { t, windowName } from "./locale.svelte";
  import { GLASS_MISSION_CONTROL_STYLE } from "../lib/shellChrome";

  // 关闭由壳决定（浮层由注册表渲染，壳传 `onclose`）——见 Launchpad.svelte 的同一处说明。
  let { onclose }: { onclose?: () => void } = $props();

  // REQ-A1185：瓷砖表（名字与图标的第二个来源），与 MissionControl 同一条推送链。
  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);
  const ext = $derived<readonly StoreTile[]>(api?.storeTiles ?? getStoreTiles());

  let focusedApp = $state<string | null>(null);
  let windows = $state<WmWindowInfo[]>([]);
  let loaded = $state(false);

  $effect(() => {
    void refresh();
  });

  /**
   * Read the host's window list and keep the focused application's windows.
   *
   * `wmWindows()` answers `null` when this surface is not in a desktop form (or the command
   * failed) — then `loaded` stays false and the panel renders nothing, the same honest state
   * Mission Control uses for an unavailable host/Spaces bridge.
   */
  async function refresh(): Promise<void> {
    const snap = await wmWindows();
    if (!snap) return;
    focusedApp = focusedAppOf(snap);
    windows = focusedApp ? windowsOfApp(snap, focusedApp) : [];
    loaded = true;
  }

  /** The label a tile opens: the **window**, not the app (labels are what `wm_focus` takes). */
  async function open(label: string): Promise<void> {
    const r = await wmFocusWithDiag(label);
    if (!r.ok) {
      const diag = r.diag;
      if (!diag.ok) {
        const code =
          diag.kind === "command-failed" && diag.detail && typeof diag.detail === "object"
            ? (diag.detail as { code?: string }).code
            : undefined;
        console.warn(`🛟 [AppExpose] wm_focus(${label}) refused`, code ?? diag.kind);
      }
    }
    // The user has chosen — staying on a dead overlay is worse than closing it (the same
    // reasoning MissionControl documents for its own click path).
    onclose?.();
  }

  let rootEl: HTMLDivElement | undefined = $state();
  /** 瓷砖行 —— 方向键网格导航的属主（`lib/overviewKeys`）按行读取它。 */
  let windowsRowEl = $state<HTMLElement | null>(null);
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") onclose?.();
  }

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // WCAG 2.1.2: keyboard focus trap while the panel is visible.
  $effect(() => {
    if (!rootEl) return;
    return attachFocusTrap(rootEl, () => onclose?.());
  });

  // 方向键网格导航：与 MissionControl 同一个属主（单行 ⇒ ↑/↓ 退化成 ←/→）。
  $effect(() => {
    return installOverviewKeyboard([windowsRowEl]);
  });

  /** The shared name of a window (`文件` / `文件 — 2`), keyed by the app the host reported. */
  function nameOf(w: WmWindowInfo): string {
    return windowName(w.label, w.app, ext).text;
  }

  /** The tile's icon: the app's own, or a generic window glyph for a window with no app. */
  function iconOf(w: WmWindowInfo): string {
    const appId = windowAppId(w);
    return appId ? iconForId(appId, ext) : "🪟";
  }
</script>



<!--
  与 Mission Control 同形的玻璃面板，但**居中**（macOS 把瓷砖铺在应用窗口原来的位置上；
  这里居中铺开，是本仓"没有真缩略图就老实铺格子"的取舍）。
-->
{#if loaded && shouldShowAppExpose(windows.length)}
  <div
    bind:this={rootEl}
    class="pointer-events-none fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 p-8"
    role="dialog"
    aria-modal="true"
    aria-label={t("desktop.appExpose")}
    tabindex="-1"
    data-testid="app-expose"
    style="{GLASS_MISSION_CONTROL_STYLE} border: 1px solid rgba(255,255,255,0.1);"
  >
    <!-- 点空白处关闭 -->
    <div
      class="pointer-events-auto absolute inset-0"
      role="presentation"
      aria-hidden="true"
      onclick={() => onclose?.()}
    ></div>

    <div
      bind:this={windowsRowEl}
      class="pointer-events-auto relative z-10 flex flex-wrap items-start justify-center gap-6"
      data-testid="app-expose-windows"
    >
      {#each windows as w (w.label)}
        <button
          class="group flex flex-col items-center gap-1"
          onclick={() => void open(w.label)}
          aria-current={w.focused ? "true" : undefined}
          aria-label={nameOf(w)}
          data-testid="app-expose-tile"
          data-window-label={w.label}
        >
          <div
            class="flex items-center justify-center rounded-xl bg-gradient-to-br from-neutral-700 to-neutral-900 shadow-lg transition-transform group-hover:-translate-y-1 group-active:scale-95 {w.focused
              ? 'ring-2 ring-white/70'
              : ''}"
            style="width:160px; height:110px; font-size:40px; border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 4px 16px rgba(0,0,0,0.3);"
          >
            {iconOf(w)}
          </div>
          <span
            class="max-w-[160px] truncate text-center text-[11px] leading-tight text-white/70 transition-colors group-hover:text-white"
          >
            {nameOf(w)}
          </span>
        </button>
      {/each}
    </div>
  </div>
{/if}
