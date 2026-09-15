<script lang="ts">
  // DesktopShell.svelte — 桌面形态顶层 Shell。
  //
  // 由 Shell.svelte 在 `LayoutSnapshot.form === 'desktop'` 时挂载。
  // 渲染 macOS 风格桌面拓扑：
  //   - 顶部 TopBar（毛玻璃顶栏）
  //   - 中间舞台 DesktopStage（壁纸 + 时钟 + 桌面图标 + 右键菜单）
  //   - 底部 Dock（毛玻璃 + 放大镜效果）
  //   - 浮层：Launchpad / Spotlight / Mission Control（按快捷键召出）
  //
  // 数据流：
  //   - `LayoutSnapshot` 来自 wm.rs（host authoritative）
  //   - 焦点 app 状态来自 SharedStore（`amos.app_focused`）
  //   - 已打开窗口列表来自 wm_windows 命令
  //
  // Power of 10 #2：所有几何常量由 lib/desktopLayout.ts 提供；纯函数决策。
  import { onMount } from "svelte";
  import { wmLayoutSnapshot, onLayoutChanged, type LayoutSnapshot } from "../lib/wm";
  import { stageRect, DEFAULT_SCREEN } from "../lib/desktopLayout";
  import TopBar from "./TopBar.svelte";
  import Launchpad from "./Launchpad.svelte";
  import SpotlightOverlay from "./SpotlightOverlay.svelte";
  import MissionControl from "./MissionControl.svelte";
  import Dock from "./Dock.svelte";
  import DesktopStage from "./DesktopStage.svelte";

  // ─── 布局状态 ───────────────────────────────────────────────────────────────
  let layoutSnap = $state<LayoutSnapshot | null>(null);
  // Until the host answers, the stage is the *documented* no-measurement screen —
  // `stageRect` already knows that fallback, so the component must not restate the
  // numbers (a second copy of 1440/796 is how a component starts "guessing" geometry
  // the host is supposed to own; `DEFAULT_SCREEN` is the one place they live).
  const stage = $derived(
    layoutSnap
      ? stageRect(layoutSnap.screen_w, layoutSnap.screen_h)
      : stageRect(DEFAULT_SCREEN.width, DEFAULT_SCREEN.height),
  );

  // ─── 浮层状态 ───────────────────────────────────────────────────────────────
  let showLaunchpad = $state(false);
  let showSpotlight = $state(false);
  let showMission = $state(false);

  function openLaunchpad() { showLaunchpad = true; }
  function closeLaunchpad() { showLaunchpad = false; }
  function closeSpotlight() { showSpotlight = false; }
  function closeMission() { showMission = false; }

  // ─── 全局快捷键 ────────────────────────────────────────────────────────────
  function onKeyDown(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey;

    // ⌘ Space → Spotlight
    if (meta && e.key === " ") {
      e.preventDefault();
      showSpotlight = !showSpotlight;
      return;
    }
    // ⌘ Tab → Mission Control
    if (meta && e.key === "Tab") {
      e.preventDefault();
      showMission = !showMission;
      return;
    }
    // Esc → 关所有浮层
    if (e.key === "Escape") {
      if (showSpotlight) { showSpotlight = false; return; }
      if (showMission)    { showMission = false; return; }
      if (showLaunchpad)  { showLaunchpad = false; return; }
    }
  }

  // ─── 监听 DesktopStage 派发的事件 ─────────────────────────────────────────
  function onDesktopStageEvent(e: Event) {
    const ce = e as CustomEvent<{ kind: string }>;
    if (ce.detail?.kind === "newFolder") {
      // 占位：什么都不做（"新文件夹" 待接入）。
      return;
    }
  }

  function onDesktopLaunchpadEvent() {
    showLaunchpad = true;
  }

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("desktop:placeholder", onDesktopStageEvent as EventListener);
    window.addEventListener("desktop:open-launchpad", onDesktopLaunchpadEvent);

    // 读取初始 LayoutSnapshot
    void wmLayoutSnapshot().then((s) => {
      if (s) layoutSnap = s;
    });
    // 订阅 host 的 layout-changed 推送
    let stopLayout: () => void = () => {};
    void onLayoutChanged((s) => {
      layoutSnap = s;
    }).then((f) => { stopLayout = f; });

    // Cleanup is returned from `onMount` (Svelte runs it on destroy) — the canonical
    // shape. The earlier version registered it with `onDestroy(...)` *inside* this
    // callback, which is a lifecycle call from outside the component's init phase;
    // measured in Svelte 5.57 that still runs (`onDestroy` is literally
    // `onMount(() => () => fn())`), so this is clarity, not a leaked listener. The
    // property itself is pinned by `desktop-shell.svelte.test.ts` ("unmount releases
    // EVERY window listener"), whose negative control — deleting this block — fails.
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("desktop:placeholder", onDesktopStageEvent as EventListener);
      window.removeEventListener("desktop:open-launchpad", onDesktopLaunchpadEvent);
      stopLayout();
    };
  });
</script>

<!--
  桌面 Shell 容器：
  - 100vw × 100vh，深色背景
  - TopBar 在最上层（永远可见）
  - DesktopStage（壁纸 + 时钟 + 图标 + 右键菜单）
  - Dock 在底部
  - 浮层按需叠加
-->
<div
  class="relative h-full w-full overflow-hidden font-system"
  style="
    background: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif;
  "
>
  <!-- 桌面舞台（壁纸 + 时钟 + 图标 + 右键菜单） -->
  <div
    class="absolute"
    style="
      left:{stage.x}px;
      top:{stage.y}px;
      width:{stage.width}px;
      height:{stage.height}px;
    "
  >
    <DesktopStage />
  </div>

  <!-- 顶部 TopBar -->
  <div class="absolute left-0 right-0 top-0 z-30">
    <TopBar onspotlight={() => (showSpotlight = true)} onlaunchpad={openLaunchpad} />
  </div>

  <!-- 底部 Dock -->
  <Dock on:launchpad={openLaunchpad} />

  <!-- 浮层：Launchpad -->
  {#if showLaunchpad}
    <Launchpad on:close={closeLaunchpad} />
  {/if}

  <!-- 浮层：Spotlight -->
  {#if showSpotlight}
    <SpotlightOverlay on:close={closeSpotlight} />
  {/if}

  <!-- 浮层：Mission Control -->
  {#if showMission}
    <MissionControl on:close={closeMission} />
  {/if}
</div>
