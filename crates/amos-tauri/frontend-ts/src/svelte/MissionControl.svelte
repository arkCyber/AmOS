<script lang="ts">
  // MissionControl.svelte — macOS 简化版窗口切换浮层。
  //
  // 桌面形态下，由 DesktopShell 处理 ⌘ Tab 快捷键触发。
  // 半屏底部覆盖（220px 高），列出所有已打开窗口。
  // 点击窗口 → wm_focus(id) → 关闭。
  //
  // 数据：wm_windows → 过滤 App 类、非 Hidden 的窗口；用 label 反查 i18n 显示名。
  import { createEventDispatcher, onMount } from "svelte";
  import { invoke } from "../lib/backend";
  import { appIcon, appTitleKey } from "../lib/appMeta";
  import { shouldShowMissionControl } from "../lib/desktopLayout";
  import { t } from "./locale.svelte";

  const dispatch = createEventDispatcher<{ close: void }>();

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

  async function refreshWindows() {
    try {
      const raw = await invoke<{ windows: WmWindow[] }>("wm_windows");
      if (raw?.windows) {
        // 只显示 App 类窗口，不显示 Launcher
        windows = raw.windows.filter(
          (w) => w.kind === "App" && w.state !== "Hidden",
        );
      }
    } catch {
      /* 非桌面形态 */
    }
  }

  function titleOf(label: string): string {
    const key = appTitleKey(label);
    if (key) return t(key);
    // store tile 或未知 id：用 label 自身的首字母大写作为兜底
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  // ─── 聚焦 ────────────────────────────────────────────────────────────────
  async function focusWindow(label: string) {
    try {
      await invoke("wm_focus", { label });
    } catch {
      /* ignore */
    }
    dispatch("close");
  }

  // ─── 键盘处理 ───────────────────────────────────────────────────────────
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") dispatch("close");
  }

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
</script>

<!--
  Mission Control 简化版：
  - 底部 220px 高，半透明深色背景
  - 显示已打开的窗口列表（图标 + 名称）
  - 点击聚焦 + 关闭
  - Esc 关闭
  - 0/1 个窗口时不出现：没有任何"切换"可做（`shouldShowMissionControl`），
    这与 macOS 上 ⌘Tab 的行为一致，而不是弹一个只有一项的面板。
-->
{#if shouldShowMissionControl(windows.length)}
<div
  class="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-4 overflow-hidden p-6"
  role="dialog"
  aria-modal="true"
  aria-label={t("desktop.missionControl")}
  tabindex="-1"
  data-testid="mission-control"
  style="
    background: rgba(20, 20, 20, 0.88);
    backdrop-filter: blur(24px) saturate(200%);
    -webkit-backdrop-filter: blur(24px) saturate(200%);
    height: 220px;
    border-top: 1px solid rgba(255,255,255,0.1);
  "
>
  <!-- 点击空白区域关闭 -->
  <div
    class="pointer-events-auto absolute inset-0"
    role="presentation"
    aria-hidden="true"
    onclick={() => dispatch("close")}
    onkeydown={(e) => { if (e.key === "Escape") dispatch("close"); }}
  ></div>

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
