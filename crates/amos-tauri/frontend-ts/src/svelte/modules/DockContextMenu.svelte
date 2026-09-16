<script lang="ts">
  /**
   * DockContextMenu.svelte — macOS 风格的 Dock 项右键菜单。
   *
   * macOS Dock 上**右键**一个 app 图标 → 弹出菜单，菜单里有：
   *   • 「显示 / 隐藏」（对应宿主 `wm_focus` / `wm_hide`）
   *   • 「退出」（对应宿主 `wm_close`）
   *   • 「选项 ›」子菜单入口（先登记：dock 选项菜单需要 per-app 配置，宿主尚无此能力）
   *
   * 这是 `DesktopStage.svelte` 里那个**右键菜单**的同形状实现——按 `lib/shellChrome.ts`
   * 那套"做不到 = 灰项 + 名字说明原因"的纪律：能做的就让它真做，做不到的就老实说。
   *
   * 数据契约：
   *   • `label`    — 窗口标签（用作 `wm_close` / `wm_hide` 的参数）
   *   • `running`  — 当前是否打开（不在 Dock 上时 `running=false`，隐藏与关闭都灰掉）
   *   • `x` / `y`  — 鼠标坐标（视口）
   *   • `onclose`  — 父级关闭这个菜单
   *
   * `onclose` 由 props 传进来（不是 `createEventDispatcher`），所以这个面板可以脱离
   * Dock 容器独立挂载/测试——和 `Launchpad` / `MissionControl` 是同一条规则（REQ-A262）。
   *
   * **Prop-read ordering**：每个菜单动作都是 `async`，而 `onclose?.()` 是同步的，会
   * 立即把父级的 `{#if}` 关掉并卸载本组件。在 Svelte 5 中，已卸载组件的 `$props`
   * getter 读取会抛 `Cannot read properties of null (reading 'label')`，所以这里
   * 把 `label` 立刻读到局部 `targetLabel` 再调用 `onclose()`——这是闭包捕获，不是
   * "复制一个字符串"。这一处缺陷本轮才出现：先前的 stage 右键菜单没有跨过 await。
   */
  import { bridgeDiag, invoke } from "../../lib/backend";
  import { t } from "../locale.svelte";
  import {
    CHROME_MENU_ITEM,
    CHROME_MENU_PANEL,
    CHROME_MENU_PANEL_STYLE,
    CHROME_MENU_SEPARATOR,
  } from "../../lib/shellChrome";

  let {
    label,
    running,
    x,
    y,
    onclose,
  }: {
    label: string;
    running: boolean;
    x: number;
    y: number;
    onclose?: () => void;
  } = $props();

  // REQ-A297 phase-2 §4 (typed-error discipline): `invoke` swallows
  // rejections into `null`. The pre-fix code wrapped every `wm_close` /
  // `wm_hide` / `wm_focus` in `try { ... } catch {}` — all of them were
  // dead code (the catch could never fire). The user would close the
  // context menu and see the dock app do nothing, with no breadcrumb
  // and no way to retry. We now branch on the null result and write a
  // diagnostic via `bridgeDiag(command)` plus a `console.warn` so the
  // failure is visible in the launcher log.
  const WARN_ICON = "🛟";
  function noteFailure(command: string, targetLabel: string, context: string) {
    const diag = bridgeDiag(command);
    if (diag.ok) return; // invariant: null result implies diag is not ok
    const code =
      diag.kind === "command-failed" &&
      diag.detail &&
      typeof diag.detail === "object"
        ? (diag.detail as { code?: string }).code
        : undefined;
    console.warn(
      `${WARN_ICON} [Dock menu] ${context} — ${command}(${targetLabel}) refused`,
      code ?? diag.kind,
    );
  }

  /** 「退出」需要真的把窗口关掉。`wm_close` 在 `main`（Launcher）上是 no-op。 */
  async function quit() {
    const targetLabel = label;
    onclose?.();
    const result = await invoke<unknown>("wm_close", { label: targetLabel });
    if (result === null) noteFailure("wm_close", targetLabel, "quit");
  }

  /** 「隐藏」对应 macOS 的 "Hide"（⌘H）。非运行中项上没有意义，灰掉。 */
  async function hide() {
    const targetLabel = label;
    onclose?.();
    if (!running) return;
    const result = await invoke<unknown>("wm_hide", { label: targetLabel });
    if (result === null) noteFailure("wm_hide", targetLabel, "hide");
  }

  /** 「显示」对应 macOS 的"再次点按运行中的图标 → 切回焦点"。 */
  async function show() {
    const targetLabel = label;
    onclose?.();
    if (!running) return;
    const result = await invoke<unknown>("wm_focus", { label: targetLabel });
    if (result === null) noteFailure("wm_focus", targetLabel, "show");
  }
</script>

<!--
  macOS 风格的小型下拉面板：
  - 玻璃质感（与顶栏 / Dock 一致）
  - 菜单项 disabled 时仍渲染（macOS 把"做不到"那一项也列出来，灰字而不是消失）
-->
<div
  class="fixed z-[200] {CHROME_MENU_PANEL}"
  style="
    left:{x}px;
    top:{y}px;
    {CHROME_MENU_PANEL_STYLE}
  "
  role="menu"
  aria-label={t("desktop.dockContextMenu")}
  data-testid="dock-context-menu"
  data-label={label}
>
  <!-- 「显示」：仅当窗口已开 -->
  <button
    type="button"
    role="menuitem"
    class={CHROME_MENU_ITEM}
    data-testid="dock-ctx-show"
    disabled={!running}
    aria-disabled={running ? undefined : "true"}
    onclick={() => void show()}>{t("desktop.dockCtxShow")}</button
  >

  <!-- 「隐藏」：仅当窗口已开 -->
  <button
    type="button"
    role="menuitem"
    class={CHROME_MENU_ITEM}
    data-testid="dock-ctx-hide"
    disabled={!running}
    aria-disabled={running ? undefined : "true"}
    onclick={() => void hide()}>{t("desktop.dockCtxHide")}</button
  >

  <div class={CHROME_MENU_SEPARATOR} role="presentation"></div>

  <!-- 「选项 ›」：占位 — per-app 选项菜单需要宿主扩展，灰项 -->
  <button
    type="button"
    role="menuitem"
    class={CHROME_MENU_ITEM}
    data-testid="dock-ctx-options"
    disabled
    aria-disabled="true"
    title={t("desktop.dockCtxOptionsUnavailable")}
    aria-label={t("desktop.dockCtxOptionsUnavailable")}
    >{t("desktop.dockCtxOptions")}</button
  >

  <div class={CHROME_MENU_SEPARATOR} role="presentation"></div>

  <!-- 「退出」：把窗口关掉 -->
  <button
    type="button"
    role="menuitem"
    class={CHROME_MENU_ITEM}
    data-testid="dock-ctx-quit"
    disabled={!running}
    aria-disabled={running ? undefined : "true"}
    onclick={() => void quit()}>{t("desktop.dockCtxQuit")}</button
  >
</div>
