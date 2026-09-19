<script lang="ts">
  // MissionControl.svelte — macOS 简化版窗口切换浮层 + Spaces 栏。
  //
  // 桌面形态下，由 DesktopShell 处理 ⌘ Tab 快捷键触发。
  // 半屏底部覆盖（280px 高），顶部显示 Spaces 栏，底部列出所有已打开窗口。
  // 点击窗口 → wm_focus(id) → 关闭。
  // 点击 Space → 切换桌面 → 关闭。
  //
  // 数据：wm_windows → 过滤 App 类、非 Hidden 的窗口；用 label 反查 i18n 显示名。
  //       spaces_list / spaces_active → Spaces 栏显示。
  import { onMount } from "svelte";
  import { invoke } from "../lib/backend";
  import { wmFocusWithDiag } from "../lib/wm";
  import { appIcon, appTitleKey } from "../lib/appMeta";
  import { shouldShowMissionControl } from "../lib/desktopLayout";
  import { t } from "./locale.svelte";
  import { attachFocusTrap } from "../lib/focusTrap";
  import { listSpaces, activeSpace, switchSpace, type Space } from "../lib/spaces";
  import { GLASS_MISSION_CONTROL_STYLE } from "../lib/shellChrome";

  // 关闭由壳决定（浮层从注册表渲染，壳传 `onclose`）——见 Launchpad.svelte 的同一处说明。
  let { onclose }: { onclose?: () => void } = $props();

  // ─── Spaces 栏数据 ───────────────────────────────────────────────────────
  let spaces = $state<Space[]>([]);
  let currentSpaceIndex = $state(0);
  let spacesLoaded = $state(false);

  $effect(() => {
    void refreshSpaces();
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
      currentSpaceIndex = active ?? 0;
      spacesLoaded = true;
    }
    // list === null → Spaces not available: keep spacesLoaded false so
    // the spaces bar is hidden (the {#if spacesLoaded && spaces.length}
    // gate below).
  }

  async function onSwitchSpace(index: number) {
    const success = await switchSpace(index);
    if (success) {
      currentSpaceIndex = index;
      // 延迟关闭以便用户看到切换效果
      setTimeout(() => onclose?.(), 200);
    }
  }

  // ─── 已打开窗口列表 ──────────────────────────────────────────────────────
  interface WmWindow {
    label: string;
    kind: string;
    state: string;
  }
  let windows = $state<WmWindow[]>([]);

  $effect(() => {
    void refreshWindows();
  });

    // REQ-A297 phase-2 §4: see refreshSpaces() for the contract rationale.
  // The pre-fix try/catch was dead code; wm_windows only ever returns
  // `null` on failure, never rejects.
  async function refreshWindows() {
    const raw = await invoke<{ windows: WmWindow[] } | null>("wm_windows");
    if (raw?.windows) {
      // 只显示 App 类窗口，不显示 Launcher
      windows = raw.windows.filter(
        (w) => w.kind === "App" && w.state !== "Hidden",
      );
    }
    // raw === null → not in a desktop form; leave windows empty and
    // let shouldShowMissionControl(windows.length) hide the panel.
  }

  function titleOf(label: string): string {
    const key = appTitleKey(label);
    if (key) return t(key);
    // store tile 或未知 id：用 label 自身的首字母大写作为兜底
    return label.charAt(0).toUpperCase() + label.slice(1);
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
  <div class="pointer-events-auto relative z-10 flex items-center justify-center gap-2 pb-2" data-testid="mission-spaces">
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

  <!-- 窗口列表 -->
  <div class="pointer-events-auto relative z-10 flex items-end justify-center gap-6 overflow-x-auto" data-testid="mission-windows">
    {#each windows as w (w.label)}
      <button
        class="group flex flex-col items-center gap-1"
        onclick={() => focusWindow(w.label)}
        aria-label={titleOf(w.label)}
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
          {appIcon(w.label)}
        </div>
        <!-- 窗口名称 -->
        <span class="max-w-[120px] truncate text-center text-[11px] leading-tight text-white/70 transition-colors group-hover:text-white">
          {titleOf(w.label)}
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
