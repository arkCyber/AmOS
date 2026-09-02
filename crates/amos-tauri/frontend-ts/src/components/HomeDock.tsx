import { useRef, type DragEvent } from "react";
import { readStoreValue, type HomeLayout } from "../lib/amosStore";
import { appTitleKey } from "../apps";
import { useI18n } from "../i18n";
import { zh, type MessageKey } from "../i18n/locales/zh";
import { NOTIF_KEY, countForApp, type Notif } from "../lib/settings";

function IconTile({
  id,
  icon,
  label,
  unread,
  onClick,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  id: string;
  icon: string;
  label: string;
  unread: number;
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
        <span className="grid h-14 w-14 place-items-center rounded-[17px] bg-neutral-300 text-3xl shadow-sm transition group-active:scale-90 dark:bg-neutral-700">
          {icon}
        </span>
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 grid min-w-[18px] place-items-center rounded-full bg-danger px-1 text-[11px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </span>
      <span className="max-w-full truncate text-[11px] text-neutral-800 dark:text-neutral-200">{label}</span>
    </button>
  );
}

export default function HomeDock({
  layout,
  onOpen,
  onMove,
}: {
  layout: HomeLayout;
  onOpen: (id: string) => void;
  /** (dragId, overId) after a drop — parent persists with saveLayout. */
  onMove: (dragId: string, overId: string) => void;
}) {
  const { t } = useI18n();
  const notifs = readStoreValue<Notif[]>(NOTIF_KEY, []);
  const dragId = useRef<string | null>(null);
  const EMOJI: Record<string, string> = {
    clock: "🕐",
    settings: "⚙️",
    calculator: "🧮",
    weather: "🌤️",
    notes: "📝",
    photos: "🖼️",
    files: "📁",
    messages: "💬",
    phone: "📞",
    music: "🎵",
    maps: "🗺️",
    camera: "📷",
    ai: "🤖",
    interpreter: "🌐",
  };

  const labelOf = (id: string): string => {
    const key = appTitleKey(id);
    return key ? t(key) : id;
  };
  const known = (id: string): boolean => appTitleKey(id) !== null;
  const zhName = (id: string): string => {
    const key = appTitleKey(id) as MessageKey | null;
    return key ? zh[key] : id;
  };
  const unreadOf = (id: string) => countForApp(notifs, zhName(id));
  const iconOf = (id: string): string => EMOJI[id] ?? "🧩";
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
      onClick={() => openTap(id)}
      onDragStart={handleStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    />
  );

  const pageIds = layout.page.filter(known);
  const dockIds = layout.dock.filter(known);

  return (
    <div className="flex h-full flex-col px-4 pb-6">
      <div className="grid grid-cols-4 gap-y-6 py-6">{pageIds.map(renderIcon)}</div>
      <div className="mt-auto flex items-end justify-around rounded-3xl bg-neutral-300/40 px-2 py-3 dark:bg-neutral-800/50">
        {dockIds.map(renderIcon)}
      </div>
    </div>
  );
}
