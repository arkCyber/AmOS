import { useEffect, useRef, useState, type DragEvent, type TouchEvent as ReactTouchEvent } from "react";
import type { HomeLayout } from "../lib/amosStore";
import { appIcon, appTitleKey } from "../apps";
import { AppIconTile } from "./AppIcon";
import { useI18n } from "../i18n";
import { zh, type MessageKey } from "../i18n/locales/zh";
import { NOTIF_KEY, SETTINGS_KEY, countForApp, dndActive, normalizeQuick, type Notif } from "../lib/settings";
import { useStoreValue } from "../lib/useStoreValue";
import { iconSvg } from "../lib/sysIcons";
import { HomeWidgets } from "./HomeWidgets";
import type { StoreTile } from "../lib/storeApps";
import { amosLog, amosWarn } from "../lib/debugLog";

/** Fine-pointer (mouse/trackpad) → allow HTML5 drag-to-reorder. Coarse/touch →
 *  disable native drag so a horizontal swipe pages the dock instead of dragging.
 *  Falls back to draggable when matchMedia is unavailable (SSR / happy-dom tests). */
function finePointerEnabled(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(pointer: fine)").matches;
}

function IconTile({
  id,
  icon,
  label,
  unread,
  pulse,
  reorderable,
  onClick,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  id: string;
  icon: string;
  label: string;
  unread: number;
  /** Brief "launch" highlight when the user picks this app from search. */
  pulse?: boolean;
  /** HTML5 drag-to-reorder is a fine-pointer (mouse) affordance; touch devices
   *  keep icons non-draggable so a horizontal swipe pages the dock instead of
   *  starting a native drag that swallows the touch. */
  reorderable: boolean;
  onClick: () => void;
  onDragStart: (id: string) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (id: string) => void;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      draggable={reorderable}
      onClick={onClick}
      onDragStart={reorderable ? (e) => {
        onDragStart(id);
        e.dataTransfer?.setData("text/plain", id);
      } : undefined}
      onDragOver={(e) => onDragOver(e)}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(id);
      }}
      className="group flex w-16 flex-col items-center gap-1 outline-none"
    >
      <span className="relative">
        <AppIconTile
          id={id}
          icon={icon}
          tileClassName={
            "h-14 w-14 rounded-[19px] group-hover:-translate-y-0.5 group-active:scale-90" +
            (pulse ? " animate-pulse ring-2 ring-accent" : "")
          }
          glyphClassName="text-[2.5rem]"
        />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 grid min-w-[18px] place-items-center rounded-full bg-danger px-1 text-[11px] font-bold text-white ring-2 ring-white dark:ring-neutral-900">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </span>
      <span className="max-w-full truncate text-xs font-medium text-neutral-800 transition-colors group-hover:text-accent dark:text-neutral-200">{label}</span>
    </button>
  );
}

export default function HomeDock({
  layout,
  onOpen,
  onMove,
  onSearch,
  onLibrary,
  pulseId,
  ext = [],
}: {
  layout: HomeLayout;
  onOpen: (id: string) => void;
  /** (dragId, overId) after a drop — parent persists with saveLayout. */
  onMove: (dragId: string, overId: string) => void;
  /** Open Spotlight search (shown as a discreet search pill at the bottom of the grid). */
  onSearch?: () => void;
  /** Enter the iOS-style "App Library" page (trailing page / pager dot). */
  onLibrary?: () => void;
  /** Icon to briefly highlight (id) after a soft-launch from search. */
  pulseId?: string | null;
  /** Store-installed (third-party) tiles to render alongside built-ins. */
  ext?: StoreTile[];
}) {
  const { t } = useI18n();
  // Reactive reads: home unread badges (and their DND suppression) update live
  // as notifications / quick-settings change (same window or cross-window).
  const notifs = useStoreValue<Notif[]>(NOTIF_KEY, []);
  const quiet = dndActive(normalizeQuick(useStoreValue<unknown>(SETTINGS_KEY, {})));
  const dragId = useRef<string | null>(null);
  const reorderable = useRef(finePointerEnabled()).current;

  const extById = new Map(ext.map((e) => [e.id, e]));
  const extName = (id: string): string | undefined => extById.get(id)?.name;

  const labelOf = (id: string): string => {
    const key = appTitleKey(id);
    return key ? t(key) : extName(id) ?? id;
  };
  const known = (id: string): boolean => appTitleKey(id) !== null || extById.has(id);
  const zhName = (id: string): string => {
    const key = appTitleKey(id) as MessageKey | null;
    return key ? zh[key] : extName(id) ?? id;
  };
  const unreadOf = (id: string) =>
    quiet || extById.has(id) ? 0 : countForApp(notifs, zhName(id));
  const iconOf = (id: string): string => extById.get(id)?.icon ?? appIcon(id);
  const handleStart = (id: string) => {
    dragId.current = id;
  };
  const handleDragOver = (e: DragEvent) => e.preventDefault();
  const handleDrop = (id: string) => {
    const src = dragId.current;
    dragId.current = null;
    if (src && src !== id) onMove(src, id);
  };
  const openTap = (id: string) => {
    if (dragId.current) {
      dragId.current = null; // a tap right after a drag shouldn't open the app
      return;
    }
    onOpen(id);
  };

  const renderIcon = (id: string) => (
    <IconTile
      key={id}
      id={id}
      icon={iconOf(id)}
      label={labelOf(id)}
      unread={unreadOf(id)}
      pulse={pulseId === id}
      reorderable={reorderable}
      onClick={() => openTap(id)}
      onDragStart={handleStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    />
  );

  const pageIds = layout.page.filter(known);
  const dockIds = layout.dock.filter(known);

  // ---- Main icon grid: horizontal multi-page ----
  // The home's app icons live on horizontal pages (swipe left/right to page).
  // HomeWidgets stay fixed above; the bottom dock bar stays a single row below.
  const GRID_COLS = 4;
  const GRID_ROWS = 3;
  const GRID_PER_PAGE = GRID_COLS * GRID_ROWS; // 12 icons per page
  const gridPages: string[][] = [];
  for (let i = 0; i < pageIds.length; i += GRID_PER_PAGE) {
    gridPages.push(pageIds.slice(i, i + GRID_PER_PAGE));
  }
  const [gridPage, setGridPage] = useState(0);
  useEffect(() => {
    if (gridPage > Math.max(0, gridPages.length - 1)) {
      setGridPage(Math.max(0, gridPages.length - 1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridPages.length]);
  const shownGrid = gridPages.length ? (gridPages[Math.min(gridPage, gridPages.length - 1)] ?? []) : [];
  const gridPanX = useRef<number | null>(null);
  const gridPanned = useRef(false);
  const onGridStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    const x = e.touches[0]?.clientX;
    gridPanX.current = x == null ? null : x;
    gridPanned.current = false;
  };
  const onGridMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    const x0 = gridPanX.current;
    if (x0 == null || gridPanned.current) return;
    const x = e.touches[0]?.clientX;
    if (x == null) return;
    const dx = x - x0;
    if (Math.abs(dx) < 48) return;
    gridPanned.current = true;
    gridPanX.current = null;
    dragId.current = "__grid_pan__";
    window.setTimeout(() => {
      if (dragId.current === "__grid_pan__") dragId.current = null;
    }, 300);
    if (gridPages.length <= 1) {
      // A single page has nowhere to page to — a swipe to the left is the iOS
      // "keep going past the last page" gesture that opens the App Library.
      if (dx < 0) onLibrary?.();
    } else if (gridPage >= gridPages.length - 1 && dx < 0) {
      // Past the last icon page → the trailing "App Library" page.
      onLibrary?.();
    } else if (dx < 0) {
      setGridPage((p) => Math.min(p + 1, gridPages.length - 1));
    } else {
      setGridPage((p) => Math.max(p - 1, 0));
    }
  };
  const onGridEnd = () => {
    gridPanX.current = null;
  };

  // ---- on-device diagnosis for "dock not rendering" ----
  const reported = useRef(false);
  const lastEmpty = useRef<boolean | null>(null);
  useEffect(() => {
    reported.current = false;
    lastEmpty.current = null;
  }, [layout]);
  if (!reported.current) {
    reported.current = true;
    amosLog("dock", "mounted", { gridPages: gridPages.length, pageIds, dockIds });
  }
  const emptyNow = dockIds.length === 0;
  if (emptyNow !== lastEmpty.current) {
    lastEmpty.current = emptyNow;
    if (emptyNow) {
      const dropped = layout.dock.filter((id) => !known(id));
      amosWarn("dock", "dock icon list is empty", { persistedDock: layout.dock, droppedUnknown: dropped });
    }
  }

  return (
    <div className="flex h-full flex-col px-4 pb-3">
      {/* main paged region: a horizontal swipe ANYWHERE in this column (incl. over
          the clock/weather widgets) pages the icon grid, iOS-home style. */}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        style={{ touchAction: "pan-y" }}
        onTouchStart={onGridStart}
        onTouchMove={onGridMove}
        onTouchEnd={onGridEnd}
        onTouchCancel={onGridEnd}
      >
        {/* fixed widgets header — generous breathing room below the status bar */}
        <div className="shrink-0 px-1 pt-[48px]">
          <HomeWidgets onOpen={onOpen} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col justify-center">
          <div className="grid grid-cols-4 place-content-center gap-y-5" data-testid="home-grid">
            {shownGrid.map(renderIcon)}
          </div>
        </div>
        <div className="mt-1 flex items-center justify-center gap-1">
          {gridPages.length > 1 && (
            <div data-testid="home-dots" className="flex items-center justify-center gap-0.5">
              {gridPages.map((_, i) => {
                const active = i === Math.min(gridPage, gridPages.length - 1);
                return (
                  <button
                    key={i}
                    type="button"
                    data-testid="home-dot"
                    aria-label={`page ${i + 1} of ${gridPages.length}`}
                    aria-current={active ? "true" : undefined}
                    onClick={() => setGridPage(Math.min(i, gridPages.length - 1))}
                    className="grid h-5 min-w-5 cursor-pointer place-items-center transition active:scale-90"
                  >
                    <span
                      aria-hidden
                      className={
                        "block rounded-full transition-all " +
                        (active
                          ? "h-1.5 w-3.5 bg-neutral-500/80 dark:bg-neutral-300/80"
                          : "h-1.5 w-1.5 bg-neutral-400/40 dark:bg-neutral-600/60")
                      }
                    />
                  </button>
                );
              })}
            </div>
          )}
          {/* iOS-style "App Library" trailing-page entry (always present, even with a
              single icon page). A bigger 4×4 mini-app-grid icon, like the iOS App
              Library indicator. Left-swipe past the last page reaches the same place. */}
          <button
            type="button"
            data-testid="app-library-entry"
            aria-label={t("appLibrary.title")}
            title={t("appLibrary.title")}
            onClick={onLibrary}
            className="ml-1 grid h-6 w-6 cursor-pointer place-items-center rounded-[7px] bg-white/45 shadow-sm ring-1 ring-black/5 transition hover:scale-105 active:scale-90 dark:bg-white/10 dark:ring-white/10"
          >
            <span aria-hidden className="grid w-4 grid-cols-4 gap-px">
              {Array.from({ length: 16 }).map((_, i) => (
                <span
                  key={i}
                  className="h-[3px] w-[3px] rounded-[0.5px] bg-neutral-600/70 dark:bg-neutral-300/70"
                />
              ))}
            </span>
          </button>
        </div>
      </div>

      {onSearch && (
        <button
          type="button"
          aria-label="search"
          onClick={onSearch}
          className="mx-auto mb-1.5 flex h-8 cursor-pointer items-center justify-center gap-1 rounded-full bg-white/45 px-3 text-xs font-medium text-neutral-700 shadow-sm ring-1 ring-black/5 transition active:scale-90 dark:bg-white/10 dark:text-neutral-200 dark:ring-white/10"
        >
          <span data-icon="search" dangerouslySetInnerHTML={{ __html: iconSvg("search", "h-3.5 w-3.5") }} /> <span>{t("home.search")}</span>
        </button>
      )}

      {/* bottom dock bar: single fixed row (no paging) */}
      <div className="dock-mag flex items-end justify-around rounded-3xl bg-white/30 px-2 py-3 shadow-inner ring-1 ring-black/5 backdrop-blur-md dark:bg-neutral-900/40 dark:ring-white/10">
        {dockIds.map(renderIcon)}
      </div>
    </div>
  );
}
