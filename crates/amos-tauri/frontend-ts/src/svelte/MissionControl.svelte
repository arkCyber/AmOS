<script lang="ts">
  // MissionControl.svelte — macOS 简化版窗口切换浮层 + Spaces 栏。
  //
  // 桌面形态下，由 DesktopShell 处理 ⌘ Tab 快捷键触发。
  // 半屏底部覆盖（280px 高），顶部显示 Spaces 栏，底部列出所有已打开窗口。
  // 点击窗口 → wm_focus(id) → 关闭。
  // 点击 Space → 切换桌面 → 关闭。
  //
  // 数据：wm_windows → 过滤 App 类、非 Hidden 的窗口；名字走 `windowName(label, app)`
  // （REQ-A473：label 不再是 app id，`files_2` 必须解析成"文件 — 2"，而不是显示原始标签）。
  //       spaces_list / spaces_active → Spaces 栏显示。
  import { getContext, onMount } from "svelte";
  import {
    wmFocusWithDiag,
    wmWindows,
    missionControlWindows,
    type WmWindowInfo,
  } from "../lib/wm";
  import { iconForId } from "../lib/appLookup";
  import { getStoreTiles, type StoreTile } from "../lib/storeApps";
  import { SHELL_CHROME_API, type ShellChromeApi } from "../lib/shellModule";
  import { shouldShowMissionControl } from "../lib/desktopLayout";
  import { t, windowName } from "./locale.svelte";
  import { attachFocusTrap } from "../lib/focusTrap";
  import { installOverviewKeyboard } from "../lib/overviewKeys";
  import {
    listSpaces,
    activeSpace,
    switchSpace,
    spacesFailure,
    announceSpacesChanged,
    onSpacesChanged,
    type Space,
  } from "../lib/spaces";
  import { GLASS_MISSION_CONTROL_STYLE } from "../lib/shellChrome";

  // 关闭由壳决定（浮层从注册表渲染，壳传 `onclose`）——见 Launchpad.svelte 的同一处说明。
  let { onclose }: { onclose?: () => void } = $props();

  // REQ-A1185：窗口的**名字与图标**对已安装的商店应用此前都按内置注册表解析 ——
  // 名字取 `windowName(label).text`（无 i18n key ⇒ 回退成 `store:org.amos.demo`），
  // 图标取 `appIcon(appId)`（未知 id ⇒ 兜底 🧩）。瓷砖表由壳推下来（getter ⇒ 保持活），
  // 单独渲染本组件时回退到模块缓存。
  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);
  const ext = $derived<readonly StoreTile[]>(api?.storeTiles ?? getStoreTiles());

  // ─── Spaces 栏数据 ───────────────────────────────────────────────────────
  let spaces = $state<Space[]>([]);
  /**
   * 当前桌面的索引 —— `null` = 宿主**还没回答过**「哪个桌面是当前的」。
   *
   * 与 `SpacesPanel.currentIndex` 同一个假索引（F-SH-585 的如实边界里逐字登记为**另案**）：
   * `refreshSpaces` 从前逐字 `currentSpaceIndex = active ?? 0;`，把 `spaces_active()`
   * 的 `null`（宿主没回答）折成「第 0 个桌面是当前的」，于是顶部 Spaces 栏给第 0 个芯片
   * 挂上 `aria-current="true"` —— 一个没有任何人建立过的事实。本文件 `syncActiveDesktop`
   * 对同一个 `null` 是拒绝的（`if (active === null || …) return;`），只有**首读**折了。
   * `null` ⇒ 一片都不标当前（`idx === null` 对任何数字为假）。
   */
  let currentSpaceIndex = $state<number | null>(null);
  let spacesLoaded = $state(false);
  /** 切换成功但有窗口没跟过来（REQ-A513）—— 见 SpacesPanel 同名状态的说明。 */
  let switchWarning = $state<string | null>(null);
  /**
   * 这次切换**被宿主拒绝**时，用户读到的那句话（REQ-A1302 / F-SH-577）。
   *
   * 从前这个分支根本不存在：`switchSpace` 返回 `null`（拒绝）时函数直接结束 —— 桌面没有
   * 换过去，浮层留着不动，屏幕上没有一个字。用户看到的"点了没反应"与"这个按钮坏了"完全
   * 同形（FMEA F-SH-001 那一族），而它的姊妹面 `SpacesPanel.applySwitch` 对**同一个**
   * `spaces_switch` 拒绝是写下一行错误再留着的。判据与措辞都来自 `lib/spaces.ts::spacesFailure`
   * （同一个拒绝只能有一份说法）。
   */
  let switchError = $state<string | null>(null);

  $effect(() => {
    void refreshSpaces();
  });

  /**
   * 本浮层**开着**的时候，别处（桌面壳的 ⌃←/⌃→ 与 ⌃1…9、Spaces 面板）换了桌面 ——
   * 顶部那条 Spaces 栏必须跟着挪 `aria-current`（REQ-A1311 / F-SH-585）。
   *
   * 与 `SpacesPanel::syncActiveDesktop` 同一处置、同一理由：浮层不是这条事实的属主，它只在
   * 挂载时读过一次；壳在 capture 阶段消费那条弦并 `stopPropagation()`，浮层自己的键盘面
   * （`installOverviewKeyboard`）根本收不到，所以不通告就会停在旧桌面上。
   * 索引仍以 `spaces_active` 为权威 —— 重新读一次，通告本身不带索引。读到同样的值就直接
   * 返回，免得浮层自己那次切换换来一次多余渲染。
   */
  async function syncActiveDesktop() {
    if (!spacesLoaded || spaces.length === 0) return;
    const active = await activeSpace();
    // `null` = 宿主没有回答。保持上一次读到的权威值，不编一个来挪高亮。
    if (active === null || active === currentSpaceIndex) return;
    if (active < 0 || active >= spaces.length) return;
    currentSpaceIndex = active;
  }

  $effect(() => {
    const stop = onSpacesChanged(() => {
      void syncActiveDesktop();
    });
    return () => stop();
  });

  // REQ-A297 phase-2 §4: `invoke` swallows failures into `null` (REQ-A296).
  // The earlier `try/catch` was dead code — listSpaces / activeSpace /
  // wm_windows can never reject, only return null. The new code checks
  // the null result and treats it as "this surface is offline / not
  // available" rather than crashing or pretending we got data.
  async function refreshSpaces() {
    const list = await listSpaces();
    const active = await activeSpace();
    if (list !== null) {
      spaces = list;
      // 宿主没回答当前桌面时**不编一个**：`active` 原样交给 `currentSpaceIndex`
      // （`null` ⇒ 没有芯片挂着 `aria-current`）。`?? 0` 曾经让第 0 个芯片替宿主说话。
      currentSpaceIndex = active;
      spacesLoaded = true;
    }
    // list === null → Spaces not available: keep spacesLoaded false so
    // the spaces bar is hidden (the {#if spacesLoaded && spaces.length}
    // gate below).
  }

  async function onSwitchSpace(index: number) {
    // REQ-A513：这里的判据从前是 `boolean`，而桥对"单位返回"的命令**成功也返回 null**
    // ⇒ `success` 恒为 false，浮层因此**从不关闭**（切换其实已经发生）。现在成功是报告对象。
    const report = await switchSpace(index);
    // F-SH-577：拒绝（`null`）的分支从前是**空的** —— 命令没发生，而用户就站在这个浮层上，
    // 屏幕上没有任何东西说得出为什么。现在与成功那半共用同一枚措辞（`spacesFailure`），并且
    // **不关浮层**：这句话是本浮层里唯一能读它的地方（与 `switchWarning` 同一条理由，
    // REQ-A1083），照常关闭就把自己刚写下的句子一起销毁了。
    if (!report) {
      const { key, hostMessage } = spacesFailure("spaces_switch");
      switchError = hostMessage ?? t(key);
      return;
    }
    // 这一次切换有读数了：上一句失败的话不再成立，先撤掉，免得它挂在一次成功的操作旁边。
    switchError = null;
    currentSpaceIndex = index;
    // REQ-A1311：属主换了桌面就要通告 —— 另一个开着的面（Spaces 面板）也画这条事实。
    announceSpacesChanged();
    const missed = report.hide_failed.length + report.show_failed.length;
    switchWarning = missed > 0 ? t("spaces.switchPartial", { n: missed }) : null;
    // 只有干净的切换才自动关闭（延迟关闭以便用户看到切换效果）。有窗口没跟过来时**不关**：
    // 这句话是本浮层里唯一能看见那些窗口的地方，浮层若照常关闭就把自己刚写下的句子
    // 连同浮层一起销毁（REQ-A1083），用户从来读不到。姊妹页 SpacesPanel 对同一句话
    // 的处理是"留到用户点关闭"，这里照办。
    if (switchWarning === null) {
      setTimeout(() => onclose?.(), 200);
    }
  }

  /** 读完"有窗口没跟过来"的提示再关闭 —— 本浮层是这句话唯一的落点。 */
  function dismissWarning() {
    switchWarning = null;
    onclose?.();
  }

  // ─── 已打开窗口列表 ──────────────────────────────────────────────────────
  let windows = $state<WmWindowInfo[]>([]);

  $effect(() => {
    void refreshWindows();
  });

  // REQ-A297 phase-2 §4: see refreshSpaces() for the contract rationale.
  // The pre-fix try/catch was dead code; wm_windows only ever returns
  // `null` on failure, never rejects.
  //
  // F-SH-361: the list comes from `wmWindows()` (the **normalized** read) and the "which
  // windows does this panel show" rule from `missionControlWindows()` — the very same
  // predicate `DesktopShell` uses to decide whether to open this layer at all. The panel
  // used to filter a raw payload here, so the shell's open-guard and the panel's own gate
  // could have answered differently about the same snapshot.
  async function refreshWindows() {
    const snap = await wmWindows();
    if (snap) {
      windows = missionControlWindows(snap);
    }
    // snap === null → not in a desktop form; leave windows empty and
    // let shouldShowMissionControl(windows.length) hide the panel.
  }

  /**
   * What to show for a window in the switcher.
   *
   * REQ-A473: the label is not the app id any more (`files_2` is a window of Files), so
   * this goes through the shared `windowName` — the earlier `appTitleKey(label)` lookup
   * found nothing for an instance window and printed the capitalized raw label
   * (`Files_2`) with the generic 🧩 icon, i.e. the switcher named a window after its
   * *platform identifier*.
   */
  function nameOf(w: WmWindowInfo): string {
    return windowName(w.label, w.app, ext).text;
  }

  /** The icon of the app a window shows (falls back to the generic tile for no app). */
  function iconOf(w: WmWindowInfo): string {
    const appId = windowName(w.label, w.app, ext).appId;
    return appId ? iconForId(appId, ext) : "🪟";
  }

  // ─── 聚焦 ────────────────────────────────────────────────────────────────
  //
  // REQ-A297 phase-2 §4 (typed-error discipline): `invoke` swallows
  // rejections into `null`. The earlier `try/catch` was dead code; a
  // refused `wm_focus` (host offline / window already torn down by the
  // time the user clicked) silently closed the panel and left the
  // user wondering why the app didn't come to front.
  //
  // The post-fix branches on the null result: a breadcrumb goes to
  // the launcher log, the panel still closes (the user has chosen —
  // staying on a dead overlay is worse), and the failure is visible.
  async function focusWindow(label: string) {
    const r = await wmFocusWithDiag(label);
    if (!r.ok) {
      const diag = r.diag;
      if (!diag.ok) {
        const code =
          diag.kind === "command-failed" &&
          diag.detail &&
          typeof diag.detail === "object"
            ? (diag.detail as { code?: string }).code
            : undefined;
        console.warn(
          `🛟 [MissionControl] wm_focus(${label}) refused`,
          code ?? diag.kind,
        );
      }
    }
    onclose?.();
  }

  // ─── 键盘处理 ───────────────────────────────────────────────────────────
  let rootEl: HTMLDivElement | undefined = $state();
  /** 两行瓷砖：Spaces 栏（可能不渲染）+ 窗口行。方向键在这两行之间走 —— 见 `lib/overviewKeys`。 */
  let spacesRowEl = $state<HTMLElement | null>(null);
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

  // 方向键网格导航（macOS Mission Control 是全键盘可驱动的）。两行都在这里交给同一个属主：
  // ←/→ 在当前行内走，↑/↓ 换行并尽量保持列，单行面板由属主退化成 ←/→ —— 与 `AppExpose`
  // 共用一份决定，两个面板不会各走各的。
  $effect(() => {
    return installOverviewKeyboard([spacesRowEl, windowsRowEl]);
  });
</script>

<!--
  Mission Control 简化版：
  - 底部 280px 高（增加了 Spaces 栏空间），半透明深色背景
  - 顶部：Spaces 栏（横向排列所有虚拟桌面）
  - 中部：显示已打开的窗口列表（图标 + 名称）
  - 点击 Space 切换桌面 + 关闭
  - 点击窗口聚焦 + 关闭
  - Esc 关闭
  - 0/1 个窗口时不出现：没有任何"切换"可做（`shouldShowMissionControl`），
    这与 macOS 上 ⌘Tab 的行为一致，而不是弹一个只有一项的面板。
-->
{#if shouldShowMissionControl(windows.length)}
<div
  bind:this={rootEl}
  class="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-4 overflow-hidden p-6"
  role="dialog"
  aria-modal="true"
  aria-label={t("desktop.missionControl")}
  tabindex="-1"
  data-testid="mission-control"
  style="{GLASS_MISSION_CONTROL_STYLE} height: 280px; border-top: 1px solid rgba(255,255,255,0.1);"
>
  <!-- 点击空白区域关闭 -->
  <div
    class="pointer-events-auto absolute inset-0"
    role="presentation"
    aria-hidden="true"
    onclick={() => onclose?.()}
    onkeydown={(e) => { if (e.key === "Escape") onclose?.(); }}
  ></div>

  <!-- Spaces 栏（顶部） -->
  {#if spacesLoaded && spaces.length > 0}
  <div bind:this={spacesRowEl} class="pointer-events-auto relative z-10 flex items-center justify-center gap-2 pb-2" data-testid="mission-spaces">
    {#each spaces as space, idx (space.id)}
      <button
        class="group flex flex-col items-center gap-1 rounded-lg px-3 py-1.5 transition-all {idx === currentSpaceIndex ? 'bg-white/10 ring-1 ring-white/30' : ''}"
        onclick={() => onSwitchSpace(idx)}
        aria-label={`${space.name} (${space.windows.length} ${space.windows.length === 1 ? t("desktop.window") : t("desktop.windows")})`}
        aria-current={idx === currentSpaceIndex ? "true" : undefined}
      >
        <!-- Space 名称 -->
        <span 
          class="text-[11px] font-medium transition-colors {idx === currentSpaceIndex ? 'text-white' : 'text-white/60 group-hover:text-white/90'}"
        >
          {space.name}
        </span>
        <!-- 窗口数量指示器 -->
        {#if space.windows.length > 0}
        <div class="flex gap-0.5">
          {#each Array(Math.min(space.windows.length, 5)) as _dot}
            <div
              class="h-1 w-1 rounded-full transition-colors {idx === currentSpaceIndex ? 'bg-white/80' : 'bg-white/30 group-hover:bg-white/50'}"
            ></div>
          {/each}
          {#if space.windows.length > 5}
            <span class="text-[8px] text-white/40">+{space.windows.length - 5}</span>
          {/if}
        </div>
        {/if}
      </button>
    {/each}
  </div>
  {/if}

  <!-- 切换成功但有窗口没跟过来（REQ-A513）：浮层**不自动关闭**，这句话留到用户自己点关闭
       （REQ-A1083）—— 与 SpacesPanel 的同一提示同形，否则它就是一句没人读得到的句子。 -->
  {#if switchWarning}
    <div
      class="pointer-events-auto relative z-10 mb-1 rounded-lg bg-amber-500/20 px-3 py-1 text-[11px] text-amber-100"
      data-testid="mission-switch-partial"
    >
      ⚠️ {switchWarning}
      <button onclick={dismissWarning} class="ml-2 underline" data-testid="mission-switch-dismiss">
        {t("spaces.dismiss")}
      </button>
    </div>
  {/if}

  <!-- 切换**被拒绝**（F-SH-577）：会话没换过去，而用户就站在这里。浮层**不自动关闭**，
       理由与上面那句"有窗口没跟过来"完全一样 —— 这是这句话唯一的落点。点「关闭」只清掉这句
       话、不关浮层：用户可以接着挑另一个桌面（与 `SpacesPanel` 的错误条同一条规矩）。 -->
  {#if switchError}
    <div
      role="status"
      class="pointer-events-auto relative z-10 mb-1 rounded-lg bg-red-500/20 px-3 py-1 text-[11px] text-red-100"
      data-testid="mission-switch-error"
    >
      ⚠️ {switchError}
      <button
        onclick={() => (switchError = null)}
        class="ml-2 underline"
        data-testid="mission-switch-error-dismiss"
      >
        {t("spaces.dismiss")}
      </button>
    </div>
  {/if}

  <!-- 窗口列表 -->
  <div bind:this={windowsRowEl} class="pointer-events-auto relative z-10 flex items-end justify-center gap-6 overflow-x-auto" data-testid="mission-windows">
    {#each windows as w (w.label)}
      <button
        class="group flex flex-col items-center gap-1"
        onclick={() => focusWindow(w.label)}
        aria-label={nameOf(w)}
      >
        <!-- 窗口预览占位（简化版：应用图标代替缩略图） -->
        <div
          class="flex items-center justify-center rounded-xl bg-gradient-to-br from-neutral-700 to-neutral-900 shadow-lg transition-transform group-hover:-translate-y-1 group-active:scale-95"
          style="
            width:120px;
            height:80px;
            font-size:32px;
            border: 1px solid rgba(255,255,255,0.1);
            box-shadow: 0 4px 16px rgba(0,0,0,0.3);
          "
        >
          {iconOf(w)}
        </div>
        <!-- 窗口名称 -->
        <span class="max-w-[120px] truncate text-center text-[11px] leading-tight text-white/70 transition-colors group-hover:text-white">
          {nameOf(w)}
        </span>
      </button>
    {/each}

    {#if windows.length === 0}
      <p class="text-[13px] text-white/30">{t("desktop.noOpenWindows")}</p>
    {/if}
  </div>

  <!-- 底部提示 -->
  <p class="pointer-events-auto relative z-10 text-[11px] text-white/25">
    {t("desktop.missionControlHint")}
  </p>
</div>
{/if}
