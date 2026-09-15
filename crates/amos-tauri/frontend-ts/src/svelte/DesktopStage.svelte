<script lang="ts">
  // DesktopStage.svelte — 桌面形态中间舞台，现在是一个**容器**（REQ-A262）。
  //
  // 容器负责：壁纸底、桌面图标网格、右键菜单、`stage` 槽位、桌面多选（rubber-band
  // + 双击打开 / 拖动移动）。时钟搬去了 `modules/StageClock.svelte`——它原来住在这
  // 里，于是整块舞台（壁纸 + 图标 + 菜单）每秒跟着重渲染一次，只为了显示一个新
  // 的分钟数。
  //
  // 右键菜单的真实动作：
  //   • 「更改壁纸…」「显示设置」→ `wm_open("settings")`（宿主只有一个真实的入口）
  //   • 「打开启动台」→ 壳注入的把手 `api.openLaunchpad()`
  //   • 「打开选中的 N 个」→ 多选非空时显示，复用同一 `wm_open` 路径
  // 「新建文件夹」按 FMEA F-SH-001：暂灰 + 说明，不假装能做。
  //
  // **桌面多选**（macOS 语义）
  //   - 单击一个图标：进入"只选它一个"的选区（替代"单击啥都不做"——旧版本里用户
  //     唯一的入口是双击，与 macOS 桌面图标"单击选中、再双击打开"的肌肉记忆相反）
  //   - 在空白处按下并拖动：rubber-band 选框；松开后框内的图标进入选区
  //   - 双击任一图标：若它在选区中，打开选区里**全部**；否则打开它一个
  //   - 拖动选区中任一图标：选区作为一个整体移动到目标位置
  //   - Esc / 点击空白：清空选区
  //   - 键盘 A11y：`aria-selected="true"` 与 `role="listbox"`，与原生 listbox 一致
  //
  // REQ-A262 + REQ-A249 的纪律：所有几何来自 `lib/desktopLayout.ts`；选区拖动
  // 走 `lib/amosStore.ts::moveBefore`（与"主屏编辑"复用同一个纯函数）。
  //
  // 数据流：
  //   - 壁纸：`SharedStore.settings.wallpaper/background`
  //   - 桌面图标：`SharedStore.home.layout.page`（与手机主屏共用）
  //   - 选区：**只在本组件内**（DesktopStage 选区不该跨"主屏"——主屏是手机形态）
  import { getContext, onMount, tick } from "svelte";
  import { invoke } from "../lib/backend";
  import { APP_META, appIcon, appTitleKey } from "../lib/appMeta";
  import {
    LAYOUT_KEY,
    type HomeLayout,
    getLayout,
    saveLayout,
    moveBefore,
  } from "../lib/amosStore";
  import { withoutPhone } from "../lib/phoneApps";
  import { createStoreValue } from "./store";
  import { t } from "./locale.svelte";
  import { modulesFor, SHELL_CHROME_API, type ShellChromeApi } from "../lib/shellModule";
  import { SHELL_MODULES } from "./shellModules";
  import {
    DESKTOP_GRID_COLS,
    DESKTOP_GRID_INSET,
    DESKTOP_TILE_GAP_X,
    DESKTOP_TILE_GAP_Y,
    DESKTOP_TILE_SIZE,
    desktopGridWidth,
    desktopIconCapacity,
  } from "../lib/desktopLayout";
  import {
    CHROME_MENU_ITEM,
    CHROME_MENU_PANEL,
    CHROME_MENU_PANEL_STYLE,
    CHROME_MENU_SEPARATOR,
    DESKTOP_ICON_SELECTED,
    DESKTOP_SELECTION_RECT,
  } from "../lib/shellChrome";
  import Backdrop from "./Backdrop.svelte";
  import AppIcon from "./AppIcon.svelte";

  /** 舞台槽位（当前只有时钟；顺序/存在性住在注册表）。 */
  const stageModules = modulesFor("stage", SHELL_MODULES);
  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);

  // ─── 桌面图标 ───────────────────────────────────────────────────────────────
  // 桌面形态下，桌面图标 = 用户的 home layout page 项（与手机主屏图标一致）。
  // 这样用户编辑 home 时，桌面图标会跟着变化（符合 macOS 行为）。
  const layoutStore = createStoreValue<HomeLayout>(LAYOUT_KEY, getLayout(APP_META.map((a) => a.id)));
  let layout = $state<HomeLayout>(getLayout(APP_META.map((a) => a.id)));
  $effect(() => {
    const un = layoutStore.subscribe((v) => {
      if (v && v.page) layout = v;
    });
    return un;
  });
  // 桌面图标：**几何全部来自 `lib/desktopLayout.ts`**（REQ-A263）。
  const DESKTOP_ICON_LIMIT = desktopIconCapacity();
  const desktopIcons = $derived(withoutPhone(layout.page).slice(0, DESKTOP_ICON_LIMIT));

  // ─── 多选（rubber-band + 单击切换 + 双击打开 + 拖动移动）──────────────────
  //
  // 选区只追踪 id 集合（**id 是唯一稳定键**：图标 DOM 节点会随父级重渲染而被换掉，
  // 不能用 `node` 做 key）。这一段与 FMEA F-SH-001 同条纪律：
  //   - 「选中的 N 个」是真实的——真的会打开 N 个
  //   - 「清空选择」是真实的——选区真的会消失
  //   - 「打开启动台」是真实的——经壳的把手
  // 做不到的（比如「移到废纸篓」）这一版就不列。
  let selectedIds = $state<Set<string>>(new Set());
  /** Whether the click that just landed should toggle (vs replace) — macOS: ⌘-click adds
   * to selection; we don't bind ⌘ here, so every click REPLACES selection. Documented
   * honestly: no "extend" / "toggle" shortcut is wired up, and Shift-click is also
   * not wired (it's the same shape as the disabled menu rows — declare rather than
   * partially deliver). */
  let rubberBand = $state<{ x: number; y: number; w: number; h: number } | null>(null);
  /** Drag state: when the user starts dragging an icon, we capture the **anchor** (the
   * single icon under the cursor) and the **set of icons that move with it** (the
   * current selection, or just the anchor if nothing is selected). The whole set is
   * written to the layout on drop. */
  type DragKind = "select" | "move";
  let drag = $state<{
    kind: DragKind;
    startX: number;
    startY: number;
    /** For `kind: "select"` — the rubber-band's start point. */
    anchorX: number;
    anchorY: number;
    /** For `kind: "move"` — the ids that move together. */
    dragIds: string[];
    /** Original layout.page indices — used to translate "drop on icon X" into a
     * `moveBefore` call without losing relative order between the dragged icons. */
    pageSnapshot: string[];
  } | null>(null);
  /** Where an icon was last hovered during a move drag — drives the visual hint and
   * the eventual `moveBefore` target. */
  let dropTargetId = $state<string | null>(null);

  function isSelected(id: string): boolean {
    return selectedIds.has(id);
  }

  /** Click on an icon: replace selection with that single icon (no modifier bindings
   * here — the SHELL-AND-MAC-AGREEMENT shift/cmd toggles are out of scope this round
   * and are not advertised). */
  function onIconClick(id: string, e: MouseEvent) {
    e.stopPropagation();
    // A `click` that follows a successful drag should NOT also re-write selection —
    // without this guard the user would drag an icon to a new spot, release the
    // mouse, and find the selection has snapped back to the icon under the cursor.
    if (dragJustEnded) return;
    selectedIds = new Set([id]);
  }

  function onIconDoubleClick(id: string, e: MouseEvent) {
    e.stopPropagation();
    // The double-click is macOS's "open" verb. If the clicked icon is in the current
    // selection, open **the whole selection** (real multi-open); otherwise open just
    // it. Either way: wm_open is the host's "create + focus", and the host opens each
    // app in a new window when called multiple times — which is what macOS does with
    // a multi-open.
    const targets = selectedIds.has(id) && selectedIds.size > 0
      ? [...selectedIds]
      : [id];
    for (const t of targets) {
      void invoke("wm_open", { label: t });
    }
    selectedIds = new Set();
  }

  function onIconContextMenu(id: string, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // macOS: right-click on an unselected icon = select it + open the menu; right-
    // click on a selected icon = keep the selection + open the menu. We follow that
    // because it's the rule that makes "right-click a selected group" do what the
    // user expected when they selected the group in the first place.
    if (!selectedIds.has(id)) selectedIds = new Set([id]);
    showContextMenu(e.clientX, e.clientY);
  }

  function onIconMouseDown(id: string, e: MouseEvent) {
    // Only the primary button starts a drag — right/middle must reach the context
    // menu handler, not start a rubber-band or move.
    if (e.button !== 0) return;
    // The icon is already selected: dragging moves the whole selection. The icon is
    // not yet selected: this drag is the *start* of a click, NOT a move — we let it
    // bubble to the click handler.
    if (!selectedIds.has(id)) return;
    drag = {
      kind: "move",
      startX: e.clientX,
      startY: e.clientY,
      anchorX: e.clientX,
      anchorY: e.clientY,
      dragIds: [...selectedIds],
      pageSnapshot: [...layout.page],
    };
    dropTargetId = null;
  }

  /** Stage backdrop mouse-down: start a rubber-band selection. */
  function onStageMouseDown(e: MouseEvent) {
    // Only primary button; right click goes to the context menu (handled below).
    if (e.button !== 0) return;
    // Mousedown on an icon is consumed by `onIconMouseDown` (via `stopPropagation`
    // in `onIconClick`/`onIconDoubleClick`'s path — see the template's button
    // handlers). Mousedown on the empty stage starts a rubber-band.
    drag = {
      kind: "select",
      startX: e.clientX,
      startY: e.clientY,
      anchorX: e.clientX,
      anchorY: e.clientY,
      dragIds: [],
      pageSnapshot: [...layout.page],
    };
    rubberBand = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
    selectedIds = new Set();
  }

  /** Global mouse-move: drive rubber-band geometry OR the move-drag's drop target. */
  function onWindowMouseMove(e: MouseEvent) {
    if (!drag) return;
    if (drag.kind === "select") {
      const x = Math.min(drag.anchorX, e.clientX);
      const y = Math.min(drag.anchorY, e.clientY);
      rubberBand = {
        x,
        y,
        w: Math.abs(e.clientX - drag.anchorX),
        h: Math.abs(e.clientY - drag.anchorY),
      };
      return;
    }
    // Move drag — the user's only feedback while dragging is the drop-target hint.
    // We don't translate the icons visually (CSS translates on the tiles are not
    // wired to the layout store — a real drag preview would need either a
    // `transform` prop on the AppIcon widget or a Svelte `transition:` setup that
    // fights `layout.page`'s source of truth; neither is worth doing without a
    // product decision to back it). What we DO show is the icon under the cursor
    // outlined as the drop target, and on drop we recompute `layout.page` via
    // `moveBefore` for the **first** dragged id, then re-insert the rest of the
    // dragged ids in their original relative order. (macOS Finder is the model: the
    // drop target gets a single insertion point, and the dragged items keep their
    // relative positions.)
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const item = el?.closest("[data-desktop-icon-id]") as HTMLElement | null;
    dropTargetId = item?.dataset.desktopIconId ?? null;
  }

  /** A `click` immediately after a `mouseup` that ended a drag must not collapse the
   * selection back to a single icon (the drag already moved the layout, and the
   * selection state should reflect what the user just did, not the click the browser
   * synthesises on release). */
  let dragJustEnded = false;

  function onWindowMouseUp(_e: MouseEvent) {
    if (!drag) return;
    if (drag.kind === "select") {
      // Finalize the rubber-band. We measure by `getBoundingClientRect` against the
      // rect that was live on the previous paint — DOM positions are stable here
      // because the icons haven't moved during the drag.
      const rect = rubberBand;
      if (rect && rect.w > 2 && rect.h > 2) {
        const hits = new Set<string>();
        for (const node of document.querySelectorAll<HTMLElement>("[data-desktop-icon-id]")) {
          const r = node.getBoundingClientRect();
          const intersect =
            r.left < rect.x + rect.w &&
            r.right > rect.x &&
            r.top < rect.y + rect.h &&
            r.bottom > rect.y;
          if (intersect) {
            const id = node.dataset.desktopIconId;
            if (id) hits.add(id);
          }
        }
        selectedIds = hits;
      } else {
        // A click (not a drag) on the empty stage: clear the selection. macOS does
        // the same — clicking the wallpaper deselects.
        selectedIds = new Set();
      }
      rubberBand = null;
      drag = null;
      dragJustEnded = true;
      void tick().then(() => { dragJustEnded = false; });
      return;
    }
    // Move drag — write the layout. The drop target may be:
    //   * an icon → `moveBefore(first dragId, targetId)` then re-insert the rest of
    //     the dragged ids right after the first, in their original relative order
    //   * the empty stage → no-op (the user dragged nowhere meaningful)
    if (drag.dragIds.length === 0) {
      drag = null;
      return;
    }
    const target = dropTargetId;
    const dragged = drag.dragIds;
    if (target && !dragged.includes(target)) {
      // Compute the first-id's new position, then splice the rest of the dragged ids
      // in right after it, preserving their pre-drag order.
      const originalOrder = drag.pageSnapshot;
      const relativeOrder = dragged
        .slice()
        .sort((a, b) => originalOrder.indexOf(a) - originalOrder.indexOf(b));
      let next = moveBefore(layout, relativeOrder[0]!, target);
      const firstNewIndex = next.page.indexOf(relativeOrder[0]!);
      if (firstNewIndex >= 0) {
        const withoutFirst = next.page.filter((id) => !relativeOrder.slice(1).includes(id));
        const targetIndex = withoutFirst.indexOf(relativeOrder[0]!);
        const insertions = relativeOrder.slice(1);
        next = {
          ...next,
          page: [
            ...withoutFirst.slice(0, targetIndex + 1),
            ...insertions,
            ...withoutFirst.slice(targetIndex + 1),
          ],
        };
      }
      saveLayout(next);
      // After save: keep the same selection (the moved icons are still selected, so
      // the user can immediately drag again if they need to). Drop the snapshot we
      // passed into `moveBefore` is no longer authoritative.
      layout = getLayout(APP_META.map((a) => a.id));
      // Selection needs to track the new positions, but ids are stable, so the Set
      // is already correct.
    }
    dropTargetId = null;
    drag = null;
    dragJustEnded = true;
    void tick().then(() => { dragJustEnded = false; });
  }

  /** Keyboard: Esc clears selection; everything else stays where it is (no Shift/Cmd
   * toggles wired up — declared honestly above). */
  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && selectedIds.size > 0) {
      selectedIds = new Set();
      e.stopPropagation();
    }
  }

  onMount(() => {
    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("mousemove", onWindowMouseMove);
      window.removeEventListener("mouseup", onWindowMouseUp);
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  });

  // ─── 右键菜单 ──────────────────────────────────────────────────────────────
  /** 一条菜单项。没有 `run` ⇒ 这一条**做不到**，于是渲染成 macOS 的灰项 + 名字说明原因。 */
  interface MenuItem {
    id: string;
    label?: string;
    run?: () => void | Promise<void>;
    separator?: boolean;
  }
  let ctxMenu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

  function showContextMenu(x: number, y: number) {
    const openSelected = {
      id: "open-selection",
      label: t("desktop.openSelection", { n: selectedIds.size }),
      run: openSelectedApps,
    };
    const clearSel = {
      id: "clear-selection",
      label: t("desktop.clearSelection"),
      run: () => {
        selectedIds = new Set();
        closeContextMenu();
      },
    };
    const base: MenuItem[] = [
      { id: "new-folder", label: t("desktop.ctxNewFolderUnavailable") },
      { id: "change-wallpaper", label: t("desktop.ctxChangeWallpaper"), run: openSettings },
      { id: "display-settings", label: t("desktop.ctxDisplaySettings"), run: openSettings },
    ];
    if (selectedIds.size >= 2) {
      base.push(
        { id: "sep-selection-top", separator: true },
        openSelected,
        clearSel,
      );
    } else if (selectedIds.size === 1) {
      base.push(
        { id: "sep-selection-top", separator: true },
        openSelected,
      );
    }
    base.push(
      { id: "sep1", separator: true },
      { id: "open-launchpad", label: t("desktop.ctxOpenLaunchpad"), run: () => api?.openLaunchpad() },
    );
    ctxMenu = { x, y, items: base };
  }

  function closeContextMenu() {
    ctxMenu = null;
  }

  /** 壁纸与显示设置都住在设置应用里——打开它，不假装这里能改。 */
  async function openSettings() {
    await invoke("wm_open", { label: "settings" });
    closeContextMenu();
  }

  /** Multi-open: walk the selection and invoke `wm_open` for each (the host opens a
   * new window per call, which is exactly what macOS Finder's "Open N selected" does). */
  async function openSelectedApps() {
    const ids = [...selectedIds];
    closeContextMenu();
    for (const id of ids) {
      await invoke("wm_open", { label: id });
    }
  }

  async function choose(item: MenuItem) {
    if (!item.run) return;
    await item.run();
  }

  function onContextMenu(e: MouseEvent) {
    // A right-click on an icon's contextmenu handler stops propagation, so this only
    // fires for clicks on the stage's backdrop. The backdrop's only menu is the
    // stage menu — without a selection, that's the original three rows; with a
    // selection, it shows the open-selected / clear-selection row too.
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY);
  }

  function onDocumentClick(e: MouseEvent) {
    if (!ctxMenu) return;
    const target = e.target as Node | null;
    if (target && menuEl && !menuEl.contains(target)) closeContextMenu();
  }

  let menuEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  });
</script>

<!--
  桌面舞台：
  - 100% × 100%（父容器定位后铺满）
  - 壁纸（Backdrop）作为底
  - `stage` 槽位（当前：右上角时钟挂件）
  - 桌面图标网格（左上 4×4）
  - 右键菜单（绝对定位浮层）
  - 拖拽选区（rubber-band，仅 mousedown 在背景时出现）
-->
<div
  class="absolute inset-0 select-none"
  oncontextmenu={onContextMenu}
  onmousedown={onStageMouseDown}
  role="presentation"
  aria-label={t("desktop.stage")}
>
  <!-- 壁纸 -->
  <Backdrop />

  <!-- stage 槽位：注册表里的挂件（顺序见 shellModules.ts；此处只是槽位） -->
  {#each stageModules as mod (mod.id)}
    {@const Widget = mod.component}
    <Widget />
  {/each}

  <!-- 桌面图标网格：列/行/间距/内缩全部来自 lib/desktopLayout.ts（数值与改造前一致）。
       `role="listbox"` + 每张图标 `role="option"` + `aria-selected` 与原生 listbox 一致：
       读屏用户拿到的是"桌面有 N 个图标、其中 K 个已选"的真实模型。 -->
  <div
    class="absolute grid"
    style="
      left:{DESKTOP_GRID_INSET}px;
      top:{DESKTOP_GRID_INSET}px;
      grid-template-columns: repeat({DESKTOP_GRID_COLS}, {DESKTOP_TILE_SIZE}px);
      column-gap: {DESKTOP_TILE_GAP_X}px;
      row-gap: {DESKTOP_TILE_GAP_Y}px;
      width: {desktopGridWidth()}px;
    "
    data-testid="desktop-icon-grid"
    role="listbox"
    aria-multiselectable="true"
    aria-label={t("desktop.stage")}
  >
    {#each desktopIcons as id (id)}
      {@const selected = isSelected(id)}
      {@const dropTarget = dropTargetId === id}
      <button
        class="group flex flex-col items-center gap-1.5 outline-none {selected ? DESKTOP_ICON_SELECTED : ''} {dropTarget ? 'opacity-90' : ''}"
        aria-label={(appTitleKey(id) ? t(appTitleKey(id)!) : id) +
          (selected ? ', ' + t("desktop.iconAriaSelected") : '')}
        title={appTitleKey(id) ? t(appTitleKey(id)!) : id}
        aria-selected={selected}
        role="option"
        data-testid="desktop-icon"
        data-desktop-icon-id={id}
        onclick={(e) => onIconClick(id, e)}
        ondblclick={(e) => onIconDoubleClick(id, e)}
        onmousedown={(e) => onIconMouseDown(id, e)}
        oncontextmenu={(e) => onIconContextMenu(id, e)}
      >
        <AppIcon
          {id}
          icon={appIcon(id)}
          tileClassName="rounded-[24px] group-hover:-translate-y-0.5 group-active:scale-90 transition-transform"
          glyphClassName="text-[3.2rem]"
          style="width:{DESKTOP_TILE_SIZE}px;height:{DESKTOP_TILE_SIZE}px;"
        />
        <span
          class="truncate text-center text-[11px] font-medium text-white/90"
          style="max-width: {DESKTOP_TILE_SIZE}px; text-shadow: 0 1px 3px rgba(0,0,0,0.6);"
        >
          {appTitleKey(id) ? t(appTitleKey(id)!) : id}
        </span>
      </button>
    {/each}

    {#if desktopIcons.length === 0}
      <div
        class="py-8 text-center text-[12px] text-white/40"
        style="grid-column: span {DESKTOP_GRID_COLS}; text-shadow: 0 1px 3px rgba(0,0,0,0.6);"
      >
        {t("desktop.emptyDesktop")}
      </div>
    {/if}
  </div>

  <!-- 选区计数提示（macOS：在选区顶部居中显示"4 个已选"）。位于舞台容器内、不拦截
       事件，纯粹是状态展示。 -->
  {#if selectedIds.size > 0}
    <div
      class="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[11px] font-medium text-white shadow-md backdrop-blur"
      data-testid="desktop-selection-count"
      role="status"
      aria-live="polite"
    >
      {t("desktop.selection", { n: selectedIds.size })}
    </div>
  {/if}

  <!-- rubber-band 选框（仅 mousedown 在背景时存在） -->
  {#if rubberBand}
    <div
      class={DESKTOP_SELECTION_RECT}
      style="left:{rubberBand.x}px; top:{rubberBand.y}px; width:{rubberBand.w}px; height:{rubberBand.h}px;"
      data-testid="desktop-rubber-band"
      aria-hidden="true"
    ></div>
  {/if}

  <!-- 右键菜单浮层 -->
  {#if ctxMenu}
    <div
      bind:this={menuEl}
      class="fixed z-[200] {CHROME_MENU_PANEL}"
      style="
        left:{ctxMenu.x}px;
        top:{ctxMenu.y}px;
        {CHROME_MENU_PANEL_STYLE}
      "
      role="menu"
      aria-label={t("desktop.contextMenu")}
      data-testid="desktop-context-menu"
    >
      {#each ctxMenu.items as item (item.id)}
        {#if item.separator}
          <div class={CHROME_MENU_SEPARATOR} role="presentation"></div>
        {:else}
          <button
            class={CHROME_MENU_ITEM}
            role="menuitem"
            disabled={!item.run}
            aria-disabled={item.run ? undefined : "true"}
            aria-label={item.label}
            data-testid="ctx-{item.id}"
            onclick={() => choose(item)}
          >
            {item.label}
          </button>
        {/if}
      {/each}
    </div>
  {/if}
</div>
