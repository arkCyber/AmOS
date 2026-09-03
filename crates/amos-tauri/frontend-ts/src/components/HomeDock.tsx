import { useRef, type DragEvent } from "react";
import { readStoreValue, type HomeLayout } from "../lib/amosStore";
import { appIcon, appTitleKey } from "../apps";
import { AppIconTile } from "./AppIcon";
import { useI18n } from "../i18n";
import { zh, type MessageKey } from "../i18n/locales/zh";
import { NOTIF_KEY, countForApp, type Notif } from "../lib/settings";
import { HomeWidgets } from "./HomeWidgets";
import type { StoreTile } from "../lib/storeApps";

function IconTile({
  id,
  icon,
  label,
  unread,
  pulse,
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
  onClick: () => void;
  onDragStart: (id: string) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (id: string) => void;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      draggable
      onClick={onClick}
      onDragStart={(e) => {
        onDragStart(id);
        e.dataTransfer?.setData("text/plain", id);
      }}
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
      <span className="max-w-full truncate text-[11px] text-neutral-800 transition-colors group-hover:text-accent dark:text-neutral-200">{label}</span>
    </button>
  );
}

export default function HomeDock({
  layout,
  onOpen,
  onMove,
  pulseId,
  ext = [],
}: {
  layout: HomeLayout;
  onOpen: (id: string) => void;
  /** (dragId, overId) after a drop — parent persists with saveLayout. */
  onMove: (dragId: string, overId: string) => void;
  /** Icon to briefly highlight (id) after a soft-launch from search. */
  pulseId?: string | null;
  /** Store-installed (third-party) tiles to render alongside built-ins. */
  ext?: StoreTile[];
}) {
  const { t } = useI18n();
  const notifs = readStoreValue<Notif[]>(NOTIF_KEY, []);
  const dragId = useRef<string | null>(null);

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
  const unreadOf = (id: string) => (extById.has(id) ? 0 : countForApp(notifs, zhName(id)));
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
      onClick={() => openTap(id)}
      onDragStart={handleStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    />
  );

  const pageIds = layout.page.filter(known);
  const dockIds = layout.dock.filter(known);

  return (
    <div className="flex h-full flex-col px-4 pb-3">
      <div className="min-h-0 flex-1 overflow-y-auto py-3">
        <HomeWidgets onOpen={onOpen} />
        <div className="mt-4 grid grid-cols-4 gap-y-6">{pageIds.map(renderIcon)}</div>
      </div>
      <div className="dock-mag flex items-end justify-around rounded-3xl bg-white/30 px-2 py-3 shadow-inner ring-1 ring-black/5 backdrop-blur-md dark:bg-neutral-900/40 dark:ring-white/10">
        {dockIds.map(renderIcon)}
      </div>
    </div>
  );
}
