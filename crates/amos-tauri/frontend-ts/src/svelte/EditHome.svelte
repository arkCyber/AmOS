<script lang="ts">
  // EditHome.svelte — Svelte 5 (runes) implementation of the home layout editor.
  //
  // This is a CONTROLLED screen (the second consumer of the shared controlled-
  // screen infra after HomeDock): the shell owns the layout and pushes it
  // down over propsBus channel "editHome". On each edit the screen does NOT
  // mutate local state — it computes the next layout via the shared pure
  // lib/amosStore helpers (hideFromHome/restoreToHome) and emits it back up
  // ('change'); the shell persists it and re-pushes the new layout in place.
  //
  // Pure logic + icons are REUSED: same lib/amosStore helpers and the same
  // lib/appLookup single source every app-drawing surface asks (REQ-A1182).
  //
  // Why `lib/appLookup` and not `appTitleKey(id) !== null` (as this screen used to): the home
  // screen and the dock can also hold an **installed store app** (`store:<manifest.id>`), which
  // has no registry row. The narrow predicate was true only for built-ins, so a store tile had
  // no removable chip here, could not be reordered, and — being filtered out of the hidden tray
  // too — could never be brought back from this screen once Launchpad had hidden it.
  import { t } from "./locale.svelte";
  import { iconForId, isDrawableApp, nameForId } from "../lib/appLookup";
  import type { StoreTile } from "../lib/storeApps";
  import type { HomeLayout } from "../lib/amosStore";
  import {
    hideFromHome,
    moveWithinHome,
    canMoveWithinHome,
    restoreToHome,
    writeStoreValueChecked,
  } from "../lib/amosStore";
  import { propsChannel } from "./propsBus";
  import AppIcon from "./AppIcon.svelte";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { createStoreValue } from "./store";
  import {
    HOME_WIDGETS_KEY,
    MAX_WIDGETS,
    WIDGET_CATALOG,
    addWidget,
    canAddWidget,
    canMoveWidget,
    moveWidget,
    normalizeWidgets,
    removeWidget,
    widgetSpec,
    type WidgetKind,
  } from "../lib/homeWidgets";
  import type { MessageKey } from "../i18n/locales/zh";

  interface EditProps {
    layout: HomeLayout;
    ext?: StoreTile[];
  }
  const bus = propsChannel<EditProps>("editHome");

  let incoming = $state<EditProps | null>(null);
  $effect(() => {
    const un = bus.subscribe((v) => {
      if (v !== undefined) incoming = v;
    });
    return un;
  });
  const EMPTY: HomeLayout = { page: [], dock: [], hidden: [] };
  const layout = $derived(incoming?.layout ?? EMPTY);
  // Absent `ext` is an empty tile list — `isDrawableApp(id, [])` then reduces to exactly the
  // built-in-only question this screen used to ask, so a caller that has no store tiles (and
  // every older test) keeps its old answer.
  const ext = $derived(incoming?.ext ?? []);

  const isDrawable = (id: string): boolean => isDrawableApp(id, ext);
  const shown = $derived([...layout.page, ...layout.dock].filter(isDrawable));
  const hiddenShown = $derived(layout.hidden.filter(isDrawable));

  const label = (id: string): string => nameForId(id, ext, t);

  // ---- Home widgets (the stack above the icon grid) ----
  // The list lives in the SAME shared store `HomeDock` renders from, so an edit here shows
  // up on the home screen in place — no channel, no second copy. `null` (no key) decodes to
  // the default clock+weather stack, the rule `lib/homeWidgets` owns.
  const widgetStore = createStoreValue<unknown>(HOME_WIDGETS_KEY, null);
  let rawWidgets = $state<unknown>(null);
  $effect(() => {
    const un = widgetStore.subscribe((v) => (rawWidgets = v));
    return un;
  });
  const widgets = $derived(normalizeWidgets(rawWidgets));
  /** The catalog entries not currently placed — the "add" row. */
  const availableWidgets = $derived(
    WIDGET_CATALOG.filter((w) => !widgets.includes(w.kind)).map((w) => w.kind),
  );
  const widgetName = (kind: WidgetKind): string => {
    const spec = widgetSpec(kind);
    return spec ? t(spec.labelKey as MessageKey) : kind;
  };
  /**
   * Persist a widget edit. The screen keeps reading the **store** (the single source), so a
   * refused write (storage full/unavailable) leaves the chips showing exactly what landed
   * instead of a list that only exists on this screen — and the refusal is reported rather
   * than swallowed (`StoreErrorBar`), so the user is not told an edit was saved when it was not.
   */
  let widgetErr = $state("");
  function saveWidgets(next: WidgetKind[]): void {
    widgetErr = writeStoreValueChecked(HOME_WIDGETS_KEY, next) ? "" : t("common.storeWriteFailed");
  }
</script>

<div class="flex h-full flex-col p-4">
  <div class="flex items-center justify-between">
    <p class="text-xs opacity-60">{t("edit.hint")}</p>
    <button
      onclick={() => bus.emit("done")}
      class="rounded-full bg-accent px-4 py-1 text-sm text-white"
    >{t("edit.done")}</button>
  </div>

  <div class="mt-4 flex flex-wrap gap-2">
    {#each shown as id (id)}
      <div class="relative">
        <button
          onclick={() => bus.emit("change", hideFromHome(layout, id))}
          class="group relative block outline-none transition-transform active:scale-90"
          aria-label={t("edit.remove", { name: label(id) })}
        >
          <AppIcon
            id={id}
            icon={iconForId(id, ext)}
            tileClassName="h-16 w-16 rounded-[21px]"
            glyphClassName="text-[2.5rem]"
          />
        </button>
        <span
          class="absolute -left-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-danger text-xs text-white"
        >✕</span>
        <span class="mt-1 block w-16 truncate text-center text-[10px]">{label(id)}</span>
        <!-- 排序：REQ-A462。提示条（`edit.hint`）从写下那天起就写着「点 ‹ › 调整顺序」，
             而这两个按钮一直不存在 —— 一条**对用户说假话**的文案，同时两个键
             （`edit.moveEarlier` / `edit.moveLater`）被豁免表当作"预留"挂着。
             两端的按钮 `disabled`，判据与 `moveWithinHome` **共用同一个邻居查询**
             （`canMoveWithinHome`）：否则会出现"看起来能点、点下去什么都没发生"的死控件。
             移动只在元素**自己所在的那个列表内**发生（见 `moveWithinHome` 的文档）。 -->
        <div class="mt-1 flex w-16 items-center justify-center gap-1">
          <button
            onclick={() => bus.emit("change", moveWithinHome(layout, id, -1, isDrawable))}
            disabled={!canMoveWithinHome(layout, id, -1, isDrawable)}
            aria-label={t("edit.moveEarlier", { name: label(id) })}
            class="grid h-5 w-5 place-items-center rounded-full bg-neutral-300/80 text-[11px] leading-none transition disabled:opacity-30 dark:bg-neutral-700"
          >‹</button>
          <button
            onclick={() => bus.emit("change", moveWithinHome(layout, id, 1, isDrawable))}
            disabled={!canMoveWithinHome(layout, id, 1, isDrawable)}
            aria-label={t("edit.moveLater", { name: label(id) })}
            class="grid h-5 w-5 place-items-center rounded-full bg-neutral-300/80 text-[11px] leading-none transition disabled:opacity-30 dark:bg-neutral-700"
          >›</button>
        </div>
      </div>
    {/each}
  </div>

  <!-- widgets: the stack above the icon grid. Same ‹ › reorder idiom as the app chips
       above; the ＋ row is the catalog's unplaced entries. -->
  <div class="mt-6">
    <p class="text-xs opacity-60">{t("widget.title")}</p>
    <p class="mt-1 text-[11px] opacity-50">{t("widget.hint")}</p>
    <StoreErrorBar message={widgetErr} />
    <div class="mt-2 flex flex-wrap gap-2" data-testid="widget-editor">
      {#each widgets as kind (kind)}
        <div
          class="flex items-center gap-1 rounded-full bg-neutral-300/80 px-3 py-1 text-xs dark:bg-neutral-700"
          data-widget={kind}
        >
          <span>{widgetName(kind)}</span>
          <button
            onclick={() => saveWidgets(moveWidget(widgets, kind, -1))}
            disabled={!canMoveWidget(widgets, kind, -1)}
            aria-label={t("widget.moveEarlier", { name: widgetName(kind) })}
            class="grid h-5 w-5 place-items-center rounded-full transition disabled:opacity-30"
          >‹</button>
          <button
            onclick={() => saveWidgets(moveWidget(widgets, kind, 1))}
            disabled={!canMoveWidget(widgets, kind, 1)}
            aria-label={t("widget.moveLater", { name: widgetName(kind) })}
            class="grid h-5 w-5 place-items-center rounded-full transition disabled:opacity-30"
          >›</button>
          <button
            onclick={() => saveWidgets(removeWidget(widgets, kind))}
            aria-label={t("widget.remove", { name: widgetName(kind) })}
            class="grid h-5 w-5 place-items-center rounded-full bg-danger text-white transition"
          >✕</button>
        </div>
      {/each}
      {#each availableWidgets as kind (kind)}
        <button
          onclick={() => saveWidgets(addWidget(widgets, kind))}
          disabled={!canAddWidget(widgets, kind)}
          aria-label={t("widget.add", { name: widgetName(kind) })}
          title={canAddWidget(widgets, kind) ? undefined : t("widget.full", { max: MAX_WIDGETS })}
          class="flex items-center gap-1 rounded-full bg-neutral-300 px-3 py-1 text-xs transition disabled:opacity-40 dark:bg-neutral-700"
        >＋ {widgetName(kind)}</button>
      {/each}
    </div>
  </div>

  {#if hiddenShown.length > 0}
    <div class="mt-6" data-testid="edit-hidden">
      <p class="text-xs opacity-60">{t("edit.hidden")}</p>
      <div class="mt-2 flex flex-wrap gap-2">
        {#each hiddenShown as id (id)}
          <button
            onclick={() => bus.emit("change", restoreToHome(layout, id))}
            class="flex items-center gap-1 rounded-full bg-neutral-300 px-3 py-1 text-xs dark:bg-neutral-700"
          >＋ {label(id)}</button>
        {/each}
      </div>
    </div>
  {/if}
</div>
