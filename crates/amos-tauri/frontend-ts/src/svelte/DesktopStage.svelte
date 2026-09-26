<script lang="ts">
  // DesktopStage.svelte — 桌面形态中间舞台，现在是一个**容器**（REQ-A262）。
  //
  // 容器负责：壁纸底、桌面图标网格、右键菜单、`stage` 槽位、桌面多选（rubber-band
  // + 双击打开 / 拖动移动）。时钟搬去了 `modules/StageClock.svelte`——它原来住在这
  // 里，于是整块舞台（壁纸 + 图标 + 菜单）每秒跟着重渲染一次，只为了显示一个新
  // 的分钟数。
  //
  // 右键菜单的真实动作：
  //   • 「更改壁纸…」「显示设置」→ 先记下目的页（`amos.settings.page`）再 `wm_open("settings")`，
  //     于是设置窗口**落在它命名的那一页**（REQ-A1810：此前只开窗口、落在索引页）
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
  import { bridgeDiag } from "../lib/backend";
  import { wmOpenWithDiag } from "../lib/wm";
  import { APP_META } from "../lib/appMeta";
  import { iconForId, nameForId } from "../lib/appLookup";
  import { getStoreTiles, type StoreTile } from "../lib/storeApps";
  import {
    LAYOUT_KEY,
    type HomeLayout,
    getLayout,
    writeStoreValueChecked,
    moveBefore,
  } from "../lib/amosStore";
  import { withoutPhone } from "../lib/phoneApps";
  import { createStoreValue } from "./store";
  import StoreErrorBar from "./StoreErrorBar.svelte";
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
  import { installMenuKeyboard, isContextMenuKey } from "../lib/menuKeys";
  import { NAV_KEYS, nextGridIndex } from "../lib/overviewKeys";
  import {
    CHROME_MENU_ITEM,
    CHROME_MENU_PANEL,
    CHROME_MENU_PANEL_STYLE,
    CHROME_MENU_SEPARATOR,
    DESKTOP_ICON_SELECTED,
    DESKTOP_ICON_FOCUSED,
    DESKTOP_SELECTION_RECT,
  } from "../lib/shellChrome";
  import { DESKTOP_VIEW_KEY, DEFAULT_DESKTOP_VIEW, type DesktopView } from "../lib/desktopView";
  import { placeMenuAt } from "../lib/menuPlacement";
  import { openSettingsAt } from "./appLinks";
  import type { SettingsPageId } from "../lib/settingsPages";
  import Backdrop from "./Backdrop.svelte";
  import AppIcon from "./AppIcon.svelte";

  /** 舞台槽位（当前只有时钟；顺序/存在性住在注册表）。 */
  const stageModules = modulesFor("stage", SHELL_MODULES);
  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);

  /**
   * Stage Manager 轨道条带占的宽度（px），由壳从 `LayoutSnapshot.rail_width` 推下来。
   *
   * 图标网格的 `left` 内缩要**再**减去它：轨道是半透明、且条带里的像素点不到（那里的
   * 最上层窗口是启动器），所以不内缩的话第一列图标会被画在一条压不出反馈的条带下面。
   * `0` = 没有轨道（模式关着 / 类别没有 / 屏幕太窄让位），此时内缩是恒等。
   */
  let { railWidth = 0 }: { railWidth?: number } = $props();
  // 已安装的商店应用：壳通过 `SHELL_CHROME_API.storeTiles` 推下来（getter ⇒ 保持活）。
  // REQ-A1179 之前这里画得出商店瓷砖、却把名字解析成**原始 id**、图标退成默认字形——因为
  // 名字只有 `appTitleKey(id) ? t(...) : id` 一条路，而商店 id 在注册表里查不到。
  const ext = $derived<readonly StoreTile[]>(api?.storeTiles ?? getStoreTiles());

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

  /**
   * 存储拒写时要说的那一句（REQ-A1390 ∕ FMEA F-SH-649）。
   *
   * 与 `Dock.svelte::storeError` 同一个判据、同一个组件（`StoreErrorBar`，testid
   * `store-write-error`）：一次没生效的拖拽必须说出口，否则它与一颗坏掉的图标在屏幕上
   * 一模一样 —— 用户拖动、图标弹回、一个字也没有。
   */
  let stageErr = $state("");

  // ─── View toggles (REQ-A275) ──────────────────────────────────────────────────
  // The View menu writes `amos.settings.view`; this component reads the same key
  // and hides the icon grid when the user has toggled icons off. Backdrop is
  // a separate component that subscribes to the same key (Backdrop owns its own
  // subscription; we deliberately don't pass a prop so the two surfaces stay
  // decoupled — neither one needs the other to render). Stage widgets are
  // filtered here because the iteration lives in this template.
  const viewStore = createStoreValue<DesktopView>(
    DESKTOP_VIEW_KEY,
    DEFAULT_DESKTOP_VIEW,
  );
  let view = $state<DesktopView>(DEFAULT_DESKTOP_VIEW);
  $effect(() => {
    const un = viewStore.subscribe((v) => (view = v ?? DEFAULT_DESKTOP_VIEW));
    return un;
  });
  const visibleStageModules = $derived(
    view.showStageWidgets ? stageModules : [],
  );

  // ─── 多选（rubber-band + 单击切换 + 双击打开 + 拖动移动）──────────────────
  //
  // 选区只追踪 id 集合（**id 是唯一稳定键**：图标 DOM 节点会随父级重渲染而被换掉，
  // 不能用 `node` 做 key）。这一段与 FMEA F-SH-001 同条纪律：
  //   - 「选中的 N 个」是真实的——真的会打开 N 个
  //   - 「清空选择」是真实的——选区真的会消失
  //   - 「打开启动台」是真实的——经壳的把手
  // 做不到的（比如「移到废纸篓」）这一版就不列。
  let selectedIds = $state<Set<string>>(new Set());
  /** The icon that was last clicked without a modifier — the **anchor** for ⇧-click
   * range selection (REQ-A273, macOS semantic). A range click does not move the
   * anchor; only plain and ⌘-click do. */
  let anchorId = $state<string | null>(null);
  /** The icon that is currently the listbox's keyboard focus (REQ-A273). */
  let focusedId = $state<string | null>(null);
  /** Whether the click that just landed should toggle (vs replace). This is the **rubber
   * band**'s flag, not the click modifiers': ⌘-click toggles and ⇧-click extends both ARE
   * wired (see `onIconClick`). */
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

  /** Click on an icon. The three modifiers macOS's Finder binds are all wired here:
   * ⇧-click extends from the anchor (union, below), ⌘-click toggles one icon, and a
   * plain click replaces the selection with that single icon. */
  function onIconClick(id: string, e: MouseEvent) {
    e.stopPropagation();
    if (dragJustEnded) return;
    if (e.shiftKey && anchorId !== null) {
      // macOS Finder: Shift-click extends the selection from the **anchor** to the
      // click target (inclusive). It is an **union** with whatever was already
      // selected, not a replacement — a non-contiguous prior selection {A, C} +
      // Shift-click E becomes {A, B, C, D, E}, not just {B, C, D, E}. Replacing the
      // set with the contiguous window is the FMEA F-SH-010 defect: it silently
      // drops icons the user already picked. Pinning the union is the regression
      // guard (negative control: replace this line with `selectedIds = new
      // Set(unionRange(anchorId, id))` and the "clock stays selected after Cmd-
      // toggle-off + Shift-click mail" assertion in `desktop-shell.svelte.test.ts`
      // fails with `expected false to be true`).
      selectedIds = new Set([...selectedIds, ...unionRange(anchorId, id)]);
      focusedId = id;
    } else if (e.metaKey || e.ctrlKey) {
      const next = new Set(selectedIds);
      const wasSelected = next.has(id);
      if (wasSelected) next.delete(id);
      else next.add(id);
      selectedIds = next;
      // macOS Finder: Cmd-click on an unselected icon moves the anchor to it;
      // Cmd-click on an *already selected* icon (toggle off) leaves the anchor
      // where it was — the next Shift-click still extends from the last real
      // pick, not from the icon the user just removed. Pinning this rule is the
      // FMEA F-SH-010 mitigation; its regression guard is the multi-selection
      // case in `desktop-shell.svelte.test.ts` (negative control: re-assign
      // anchorId on toggle-off ⇒ the test for `clock` after the toggle-off
      // FAILED with `expected false to be true`).
      if (!wasSelected) {
        anchorId = id;
        focusedId = id;
      } else {
        focusedId = id;
      }
    } else {
      selectedIds = new Set([id]);
      anchorId = id;
      focusedId = id;
    }
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
    void openApps(targets, "onIconDoubleClick");
    selectedIds = new Set();
  }

  /**
   * Open the stage's menu **about** `id` at `(x, y)`; `id === null` ⇒ the menu is about the
   * current selection as-is (an empty desktop: the three global rows).
   *
   * One implementation for both entry paths: macOS's rule is that the menu belongs to the icon
   * the gesture stood on, and the keyboard gesture stands on the focused icon just as the
   * right-click stands on the clicked one. (Right-click on an unselected icon = select it +
   * open the menu; right-click on a selected icon = keep the selection + open the menu — the
   * rule that makes "right-click a selected group" do what the user expected when they selected
   * the group in the first place.)
   */
  function openMenuFor(id: string | null, x: number, y: number) {
    if (id !== null && !selectedIds.has(id)) selectedIds = new Set([id]);
    showContextMenu(x, y);
  }

  function onIconContextMenu(id: string, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    openMenuFor(id, e.clientX, e.clientY);
  }

  /** The icon a keyboard-opened menu is about: the focused one, else the first selected. */
  function menuAnchorId(): string | null {
    if (focusedId !== null && desktopIcons.includes(focusedId)) return focusedId;
    return desktopIcons.find((id) => selectedIds.has(id)) ?? null;
  }

  /**
   * The keyboard's way into the stage menu — Shift+F10 / the ContextMenu key, the APG
   * context-menu chord. Anchored at the icon's own rectangle (macOS hangs the menu off the
   * thing it is about; `placeMenuAt` flips it off the window edges), or at the stage when the
   * desktop is empty, where the menu is the three global rows.
   *
   * Returns whether a menu was opened, so the caller claims the key only when something happened.
   */
  function openContextMenuFromKeyboard(): boolean {
    const id = menuAnchorId();
    if (id !== null) {
      const r = document.getElementById(`desktop-icon-${id}`)?.getBoundingClientRect();
      openMenuFor(id, r?.left ?? 0, r?.bottom ?? 0);
      return true;
    }
    const r = stageEl?.getBoundingClientRect();
    openMenuFor(null, r?.left ?? 0, r?.top ?? 0);
    return true;
  }

  function onIconMouseDown(id: string, e: MouseEvent) {
    // Consume the mousedown here: the backdrop's `onStageMouseDown` is on an **ancestor**
    // of every icon, so an un-consumed event would bubble up and replace the move-drag
    // started below with a rubber-band — clearing `selectedIds` (i.e. deselecting the very
    // icon the user is trying to pick up). Stopping propagation does not affect the
    // `click`/`dblclick` that follow, which still reach the icon's own handlers.
    e.stopPropagation();
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
    // Mousedown on an icon never reaches here: `onIconMouseDown` stops its propagation
    // (see the note there). So this runs only for the empty stage — which is the one
    // place a rubber-band may start.
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
      // REQ-A1390 ∕ FMEA F-SH-649：**这一处是 `amos.home.layout` 的第四个写者**，而它是唯一
      // 一个把裁决丢在地上的。同一枚键的另外三个写者早就门住了裁决并说出被拒：
      // `Dock.svelte::onWindowDragEnd` 与 `Launchpad` 的隐藏 ∕ 还原（REQ-A1346 ∕ F-SH-611）、
      // `shellState.svelte.ts::applyLayout`（REQ-A1378 ∕ F-SH-641）。那一轮把自己的写者数成
      // 「三个」—— 桌面这一处不在名单上，因为它从**另一个面**写同一个键，而按形状枚举写者
      // （`_layout = next; saveLayout(next)`）看不见它。修前这里逐字 `saveLayout(next)`，
      // 而 `saveLayout` 签 `void`：存储拒写时下面那句 `getLayout()` 从盘上重读回**旧顺序**，
      // 图标于是静静地弹回原位，没有一个字说为什么。
      if (!writeStoreValueChecked(LAYOUT_KEY, next)) {
        stageErr = t("common.storeWriteFailed");
      } else {
        stageErr = "";
      }
      // After save: keep the same selection (the moved icons are still selected, so
      // the user can immediately drag again if they need to). Drop the snapshot we
      // passed into `moveBefore` is no longer authoritative.
      //
      // 这一次重读对两支都成立：收下了就是新顺序，被拒了就是旧顺序（盘上没变）——
      // 屏幕永远画盘上的那一份，`stageErr` 才是"这次没生效"的那句话。
      layout = getLayout(APP_META.map((a) => a.id));
      // Selection needs to track the new positions, but ids are stable, so the Set
      // is already correct.
    }
    dropTargetId = null;
    drag = null;
    dragJustEnded = true;
    void tick().then(() => { dragJustEnded = false; });
  }

  /** Keyboard: Escape clears the selection, ⌘A selects every icon, the six nav keys walk the
   * grid (see `stepFocusByKey`), and Enter / Space open the selection. */
  function onWindowKeyDown(e: KeyboardEvent) {
    if (isEditableTarget(e.target)) return;
    const meta = e.metaKey || e.ctrlKey;
    if (e.key === "Escape" && (selectedIds.size > 0 || focusedId !== null)) {
      selectedIds = new Set();
      anchorId = null;
      focusedId = null;
      e.stopPropagation();
      return;
    }
    if (meta && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
      selectedIds = new Set(desktopIcons);
      anchorId = desktopIcons[desktopIcons.length - 1] ?? null;
      focusedId = anchorId;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!meta && !e.altKey) {
      // The chord that **opens** the context menu (Shift+F10 / the ContextMenu key). The menu's
      // rows are walkable (`installMenuKeyboard` below) but nothing opened it — F-DEV-026 booked
      // the harm as 「打不开也用不了」 and only implemented the second half. The Dock listens for
      // the same chord on `document`, which the bubble path reaches first: if the dock claimed it
      // we never see it, so either surface answers it, never both.
      if (isContextMenuKey(e)) {
        if (openContextMenuFromKeyboard()) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      // The six nav keys come from the module that owns "where does a tile grid's arrow key
      // go" (`lib/overviewKeys`), so this surface cannot hand-write its own answer — the two
      // grids drifted apart once already: Down was wired as ±1, the same step as Right.
      if (NAV_KEYS.has(e.key)) {
        stepFocusByKey(e.key, e.shiftKey);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        const t = e.target as Element | null;
        if (e.key === " " && t && (t.tagName === "BUTTON" || t.tagName === "INPUT")) {
          return;
        }
        if (selectedIds.size > 0) {
          void openApps([...selectedIds], "onWindowKeyDown");
          selectedIds = new Set();
          anchorId = null;
          focusedId = null;
          e.preventDefault();
          e.stopPropagation();
        }
      }
    }
  }

  /** True if the event target is an editable element — input / textarea /
   * contenteditable. The keyboard handler must skip when the user is typing. */
  function isEditableTarget(t: EventTarget | null): boolean {
    if (!t || !(t instanceof HTMLElement)) return false;
    const tag = t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (t.isContentEditable) return true;
    return false;
  }

  /** Union of every id strictly between `a` and `b` (both inclusive), in the
   * current `desktopIcons` order. */
  function unionRange(a: string, b: string): string[] {
    const i = desktopIcons.indexOf(a);
    const j = desktopIcons.indexOf(b);
    if (i < 0 || j < 0) {
      const probe = [...selectedIds, a, b];
      return probe.filter((x, k, arr) => arr.indexOf(x) === k);
    }
    const [lo, hi] = i < j ? [i, j] : [j, i];
    return desktopIcons.slice(lo, hi + 1);
  }

  /**
   * One nav key → the next tile, following the **grid's** geometry.
   *
   * The container is `repeat(DESKTOP_GRID_COLS, …)` with row-major flow, so Left / Right walk
   * the reading order and Up / Down change row keeping the column. The decision is
   * `lib/overviewKeys.nextGridIndex`'s — the same owner the Launchpad and the two window
   * overviews use — and only the edge rule differs (`wrap: false`: this listbox clamps at the
   * ends instead of wrapping to the far tile). This function adds only what is *this*
   * component's own state: a Shift key extends the selection from the anchor instead of
   * moving it (macOS Finder).
   */
  function stepFocusByKey(key: string, shift: boolean): void {
    if (desktopIcons.length === 0) return;
    // A range extension needs both ends; without them there is nothing to extend from.
    if (shift && (focusedId === null || anchorId === null)) return;
    const from = focusedId ? desktopIcons.indexOf(focusedId) : -1;
    if (from < 0) {
      // Nothing focused yet (or the focused id is gone): the key lands **on** a tile instead of
      // stepping off one — ArrowUp / ArrowLeft / End reach the last icon, the rest the first.
      // `shift` cannot be set here (it returned above), so this always moves the anchor too.
      const newId = desktopIcons[key === "ArrowLeft" || key === "ArrowUp" || key === "End"
        ? desktopIcons.length - 1
        : 0]!;
      focusedId = newId;
      anchorId = newId;
      return;
    }
    const target = nextGridIndex(key, from, desktopIcons.length, DESKTOP_GRID_COLS, {
      wrap: false,
    });
    if (target === null) return;
    const newId = desktopIcons[target]!;
    focusedId = newId;
    if (shift) {
      selectedIds = new Set(unionRange(anchorId!, newId));
      return; // a range extension does not move the anchor (same rule as Shift-click)
    }
    anchorId = newId;
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
      { id: "change-wallpaper", label: t("desktop.ctxChangeWallpaper"), run: () => openSettingsPage("wallpaper") },
      { id: "display-settings", label: t("desktop.ctxDisplaySettings"), run: () => openSettingsPage("display") },
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

  // REQ-A297 phase-2 §4: a refused `wm_open("settings")` is now visible in
  // the launcher log instead of a silent nothing. (Pre-fix: the bare
  // `await invoke(...)` could only ever resolve to `null` on failure —
  // the user clicked "Change Wallpaper…" and the menu closed without
  // anything happening and without a diagnostic.)
  async function noteOpenFailure(command: string, label: string, context: string) {
    const diag = bridgeDiag(command);
    if (diag.ok) return;
    const code =
      diag.kind === "command-failed" &&
      diag.detail &&
      typeof diag.detail === "object"
        ? (diag.detail as { code?: string }).code
        : undefined;
    console.warn(
      `🛟 [DesktopStage] ${context} — ${command}(${label}) refused`,
      code ?? diag.kind,
    );
  }

  /**
   * 打开设置应用并**落在 `page` 那一页**（REQ-A1810 ∕ FMEA F-SH-898）。
   *
   * 此前这里逐字只有一句 `wmOpenWithDiag("settings")` —— 应用是开了，可落在**索引页**。右键桌面
   * 点「更改壁纸…」/「显示设置」的用户拿到的是一张设置列表："the app opened but not where they
   * asked to be"，而 `appLinks.openSettingsAt` 的文档把这一条写成**不许静默**的失败。
   *
   * 同一个意图的另一个入口早就修好了这一半：Dock 全局右键菜单的「程序坞偏好设置…」
   * （`Dock.svelte::handleOpenPreferences`，REQ-A790）走"**先写目的页 → 再开窗口**"两步，并把写
   * 不进去的裁决说出来。顺序是**机制**而不是实现细节：`wm_open` 是 create-or-focus，第一次点击时
   * 还没有窗口可以接收广播，目的页只有在窗口挂载**之前**落进 store 才会被读到。
   */
  async function openSettingsPage(page: SettingsPageId) {
    if (!openSettingsAt(page)) {
      // 目的页没能记下来 ⇒ 说出来，而不是开一张索引页让用户以为那就是他要的那页
      // （与 Dock 同一条裁决；`StoreErrorBar` 是同一个组件、同一枚 testid）。
      stageErr = t("common.storeWriteFailed");
      closeContextMenu();
      return;
    }
    stageErr = "";
    const r = await wmOpenWithDiag("settings");
    closeContextMenu();
    if (!r.ok) noteOpenFailure("wm_open", "settings", `openSettingsPage(${page})`);
  }

  /** Multi-open: walk `ids` and invoke `wm_open` for each (the host opens a new window per
   * call, which is exactly what macOS Finder's "Open N selected" does).
   *
   * One owner for the act, because there were three and only one read the answer:
   * `openSelectedApps` (the desktop's context menu) reported each refusal, while the icon
   * **double-click** and the **Enter/Space** handler both fired `void wmOpen(id)` and dropped
   * the verdict — a refused multi-open there was a dead click whose reason only the shared
   * ledger recorded (REQ-A1187). Every path now comes through here, so `context` names which
   * one died.
   *
   * REQ-A297 phase-2 §4: pre-fix, a single refused open inside the loop
   * silently dropped the rest of the selection. We keep iterating
   * (so a partial success still opens the remaining apps) and log a
   * breadcrumb per refusal — the user gets the apps that worked, the
   * launcher log has the ones that did not. */
  async function openApps(ids: readonly string[], context: string): Promise<void> {
    for (const id of ids) {
      const r = await wmOpenWithDiag(id);
      if (!r.ok) noteOpenFailure("wm_open", id, context);
    }
  }

  async function openSelectedApps() {
    const ids = [...selectedIds];
    closeContextMenu();
    await openApps(ids, "openSelectedApps");
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
  /** 舞台根元素 —— 键盘打开的菜单在没有可锚定的图标时以它为准（见
   * `openContextMenuFromKeyboard`）。 */
  let stageEl = $state<HTMLDivElement | null>(null);

  /**
   * Where the desktop's context menu actually goes (REQ-A481).
   *
   * The same measured defect as the Dock's menus: a pointer-anchored panel drawn straight down is
   * clipped by the shell window's bottom edge — a right-click on a desktop icon near the bottom
   * showed a menu whose lower rows (including the destructive/global ones) were invisible and
   * unclickable. The rule is shared (`lib/menuPlacement`, pure and unit-tested); this only measures
   * the rendered panel, whose height depends on how many items the click carried.
   */
  let placed = $derived.by(() =>
    menuEl && ctxMenu ? placeMenuAt(menuEl, ctxMenu.x, ctxMenu.y) : { left: ctxMenu?.x ?? 0, top: ctxMenu?.y ?? 0, flipped: false },
  );

  // REQ-A436: the desktop context menu answers the keyboard too (arrows / Home / End walk its
  // rows, Escape closes this menu and nobody else's) — the shared `lib/menuKeys` layer.
  $effect(() => {
    if (!menuEl) return;
    return installMenuKeyboard(menuEl, { onClose: closeContextMenu });
  });

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
  bind:this={stageEl}
  class="absolute inset-0 select-none"
  oncontextmenu={onContextMenu}
  onmousedown={onStageMouseDown}
  role="presentation"
  aria-label={t("desktop.stage")}
>
  <!-- 壁纸 -->
  <Backdrop />

  <!-- stage 槽位：注册表里的挂件（顺序见 shellModules.ts；此处只是槽位） -->
  {#each visibleStageModules as mod (mod.id)}
    {@const Widget = mod.component}
    <Widget />
  {/each}

  <!-- 桌面图标网格：列/行/间距/内缩全部来自 lib/desktopLayout.ts（数值与改造前一致）。
       `role="listbox"` + 每张图标 `role="option"` + `aria-selected` 与原生 listbox 一致：
       读屏用户拿到的是"桌面有 N 个图标、其中 K 个已选"的真实模型。
       REQ-A275: `view.showIcons = false` ⇒ listbox 不渲染(右键菜单里的 "Open the N selected" 也自动空,
       因为没有 icon 可作用于；与"诚实 UI" 一致 —— 不假装有一个看不见的桌面)。 -->
  {#if view.showIcons}
  <div
    class="absolute grid"
    style="
      left:{DESKTOP_GRID_INSET + railWidth}px;
      top:{DESKTOP_GRID_INSET}px;
      grid-template-columns: repeat({DESKTOP_GRID_COLS}, {DESKTOP_TILE_SIZE}px);
      column-gap: {DESKTOP_TILE_GAP_X}px;
      row-gap: {DESKTOP_TILE_GAP_Y}px;
      width: {desktopGridWidth()}px;
    "
    data-testid="desktop-icon-grid"
    role="listbox"
    tabindex="0"
    aria-multiselectable="true"
    aria-activedescendant={focusedId ? `desktop-icon-${focusedId}` : undefined}
    aria-label={t("desktop.stage")}
  >
    {#each desktopIcons as id (id)}
      {@const selected = isSelected(id)}
      {@const dropTarget = dropTargetId === id}
      {@const focused = focusedId === id}
      <button
        id={`desktop-icon-${id}`}
        class="group flex flex-col items-center gap-1.5 outline-none {selected ? DESKTOP_ICON_SELECTED : ''} {dropTarget ? 'opacity-90' : ''} {!selected && focused ? DESKTOP_ICON_FOCUSED : ''}"
        aria-label={nameForId(id, ext, t) +
          (selected ? ', ' + t("desktop.iconAriaSelected") : '')}
        title={nameForId(id, ext, t)}
        aria-selected={selected}
        role="option"
        data-testid="desktop-icon"
        data-desktop-icon-id={id}
        data-focused={focused ? "true" : undefined}
        onclick={(e) => onIconClick(id, e)}
        ondblclick={(e) => onIconDoubleClick(id, e)}
        onmousedown={(e) => onIconMouseDown(id, e)}
        oncontextmenu={(e) => onIconContextMenu(id, e)}
        onfocus={() => (focusedId = id)}
      >
        <AppIcon
          {id}
          icon={iconForId(id, ext)}
          tileClassName="rounded-[24px] group-hover:-translate-y-0.5 group-active:scale-90 transition-transform"
          glyphClassName="text-[3.2rem]"
          style="width:{DESKTOP_TILE_SIZE}px;height:{DESKTOP_TILE_SIZE}px;"
        />
        <span
          class="truncate text-center text-[11px] font-medium text-white/90"
          style="max-width: {DESKTOP_TILE_SIZE}px; text-shadow: 0 1px 3px rgba(0,0,0,0.6);"
        >
          {nameForId(id, ext, t)}
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
  {/if}

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

  <!-- 存储拒写时的那一句（REQ-A1390）。与 Dock 的 `storeError` 同一个组件、同一个判据：
       一次没生效的拖拽必须说出口，否则它与一颗坏掉的图标在屏幕上一模一样。`top-12` 在
       选区计数提示（`top-3`）之下，两者不会互相盖住；舞台本身已经让开了顶栏
       （`stageRect` 的 `y = TOPBAR_HEIGHT`），所以这个位置在任何窗口尺寸下都露得出来。 -->
  {#if stageErr}
    <div class="pointer-events-none absolute left-1/2 top-12 z-10 -translate-x-1/2">
      <StoreErrorBar message={stageErr} />
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
        left:{placed.left}px;
        top:{placed.top}px;
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
