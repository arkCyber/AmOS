import { useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent as ReactTouchEvent } from "react";
import { ThemeProvider } from "./theme";
import { I18nProvider, useI18n } from "./i18n";
import { APPS, appTitleKey, AppComponent } from "./apps";
import HomeDock from "./components/HomeDock";
import { LockScreen, RecentsPanel, SpotlightPanel } from "./components/SystemPanels";
import NotificationCenter from "./components/NotificationCenter";
import NotificationBanner from "./components/NotificationBanner";
import IncomingCall from "./components/IncomingCall";
import { Backdrop } from "./components/Wallpaper";
import EditHome from "./components/EditHome";
import StatusBar from "./components/StatusBar";
import { getLayout, hydrateFromSystemStore, moveBefore, pushRecent, saveLayout, readStoreValue, writeStoreValue, type HomeLayout } from "./lib/amosStore";
import { NOTIF_KEY, removeAppNotifs, dndActive, normalizeQuick, SETTINGS_KEY, type Notif } from "./lib/settings";
import { zh, type MessageKey } from "./i18n/locales/zh";
import { isExtId, loadStoreTiles, subscribeStoreTiles, tileById, type StoreTile } from "./lib/storeApps";
import { useStoreValue } from "./lib/useStoreValue";
import { bridged, subscribe } from "./lib/backend";
import { useNotificationAlert } from "./lib/useNotificationAlert";
import {
  buttonActionOf,
  keyActionOf,
  type HardwareAction,
} from "./lib/systemButtons";

function HomeIndicator({ onHome }: { onHome: () => void }) {
  const startY = useRef<number | null>(null);
  return (
    <div
      className="flex justify-center py-1.5"
      onTouchStart={(e) => {
        startY.current = e.touches[0]?.clientY ?? null;
      }}
      onTouchEnd={(e) => {
        const sy = startY.current;
        startY.current = null;
        const ey = e.changedTouches[0]?.clientY ?? sy;
        if (sy !== null && ey !== null && ey < sy - 40) onHome(); // swipe up
      }}
    >
      <button
        onClick={onHome}
        aria-label="home"
        title="Home"
        className="h-1.5 w-28 rounded-full bg-neutral-400/80 active:bg-accent dark:bg-neutral-600/80"
      />
    </div>
  );
}

function AppShell({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  // Pull down from the top edge of an app to close it and return home (iPhone-like).
  const closeY = useRef<number | null>(null);
  const closeStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    const y = e.touches[0]?.clientY;
    if (y != null && y <= 120) closeY.current = y;
  };
  const closeMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    const sy = closeY.current;
    if (sy == null) return;
    const y = e.touches[0]?.clientY;
    if (y != null && y - sy > 70) {
      closeY.current = null;
      onBack();
    }
  };
  const closeEnd = () => {
    closeY.current = null;
  };
  return (
    <div
      className="app-enter flex h-full flex-col bg-neutral-100 dark:bg-neutral-950"
      onTouchStart={closeStart}
      onTouchMove={closeMove}
      onTouchEnd={closeEnd}
      onTouchCancel={closeEnd}
    >
      <StatusBar />
      <header className="flex items-center gap-2 border-b border-neutral-200/70 bg-white/50 px-3 py-2 backdrop-blur-md dark:border-neutral-800 dark:bg-white/5">
        <button onClick={onBack} aria-label="back" className="w-6 text-accent text-sm font-semibold hover:underline">
          ‹
        </button>
        <span className="flex-1 truncate text-center text-sm font-semibold">{title}</span>
        <span className="w-6" />
      </header>
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      <HomeIndicator onHome={onBack} />
    </div>
  );
}
function TopBar({
  onLock,
  onRecents,
  onSearch,
  onNotify,
  onEdit,
}: {
  onLock: () => void;
  onRecents: () => void;
  onSearch: () => void;
  onNotify: () => void;
  onEdit: () => void;
}) {
  const btn =
    "grid h-9 w-9 place-items-center rounded-full bg-white/45 text-sm shadow-sm ring-1 ring-black/5 backdrop-blur-md transition active:scale-90 dark:bg-white/10 dark:ring-white/10";
  // Unread notification count on the bell (hidden while Do-Not-Disturb is on),
  // reactive so it updates live as notifications change.
  const notifs = useStoreValue<Notif[]>(NOTIF_KEY, []);
  const unread = dndActive(normalizeQuick(useStoreValue<unknown>(SETTINGS_KEY, {})))
    ? 0
    : notifs.length;
  const badge = unread > 0 ? (unread > 99 ? "99+" : String(unread)) : null;
  return (
    <div className="flex items-center justify-between px-4 pt-2">
      <div className="flex gap-2">
        <button onClick={onNotify} aria-label="notifications" className={btn} title="notifications">
          <span className="relative">
            🔔
            {badge && (
              <span className="absolute -right-2.5 -top-1.5 grid min-w-[16px] place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-white ring-2 ring-white dark:ring-neutral-900">
                {badge}
              </span>
            )}
          </span>
        </button>
        <button onClick={onRecents} aria-label="recents" className={btn} title="recents">
          ⇤
        </button>
        <button onClick={onSearch} aria-label="search" className={btn} title="search">
          🔍
        </button>
      </div>
      <div className="flex gap-2">
        <button onClick={onEdit} aria-label="edit home" className={btn} title="edit home">
          ✎
        </button>
        <button onClick={onLock} aria-label="lock" className={btn} title="lock">
          🔒
        </button>
      </div>
    </div>
  );
}

function Shell() {
  const { t } = useI18n();
  const ids = useMemo(() => APPS.map((a) => a.id), []);
  const [layout, setLayout] = useState<HomeLayout>(() => getLayout(ids));
  const [ext, setExt] = useState<StoreTile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [spotOpen, setSpotOpen] = useState(false);
  const [ncOpen, setNcOpen] = useState(false);
  // Soft-launch: choosing an app from Search returns home & pulses its icon
  // instead of jumping straight into the app screen (iPhone "spotlight" feel).
  const [launchPulse, setLaunchPulse] = useState<string | null>(null);
  const pulseTimer = useRef<number | undefined>(undefined);

  // Recover durable system state (settings/notifications/layout) from the Rust
  // on-disk store into localStorage on boot — the Rust side is authoritative.
  useEffect(() => {
    void hydrateFromSystemStore();
  }, []);

  // Load store-installed apps and merge them into the persisted home layout so
  // they appear as tiles; refresh live when the Store page installs/uninstalls.
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const tiles = await loadStoreTiles();
      if (!alive) return;
      setExt(tiles);
      const available = [...ids, ...tiles.map((t) => t.id)];
      const next = getLayout(available);
      setLayout(next);
      saveLayout(next);
    };
    void refresh();
    const unsubscribe = subscribeStoreTiles(refresh);
    return () => {
      alive = false;
      unsubscribe();
    };
    // ids/APPS are static; load once and re-run on change notifications.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeAll = () => {
    setRecentsOpen(false);
    setSpotOpen(false);
    setNcOpen(false);
  };

  // Keyboard: Esc closes any open overlay (recents / spotlight / notification center).
  useEffect(() => {
    if (!recentsOpen && !spotOpen && !ncOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recentsOpen, spotOpen, ncOpen]);
  const open = (id: string) => {
    // opening an app marks its notifications as read (badge clears)
    const key = appTitleKey(id);
    const name = key ? zh[key as MessageKey] : tileById(id)?.name ?? id;
    const list = readStoreValue<Notif[]>(NOTIF_KEY, []);
    writeStoreValue(NOTIF_KEY, removeAppNotifs(list, name));
    if (!isExtId(id)) pushRecent(id); // third-party tiles don't pollute Recents yet
    closeAll();
    setActive(id);
  };
  const back = () => setActive(null);

  // Clean up the pulse timer if the shell unmounts.
  useEffect(() => {
    const t = pulseTimer.current;
    return () => {
      if (t) window.clearTimeout(t);
    };
  }, []);

  // Global notification-arrival alert (vibrate + ring per effective sound policy),
  // mounted once so it fires on every screen — home, inside an app, even locked.
  useNotificationAlert();

  // Search-launch: clear the badge + record a recent, but stay on the home
  // screen and briefly highlight that app's icon (like picking it in Spotlight).
  const softLaunch = (id: string) => {
    const key = appTitleKey(id);
    const name = key ? zh[key as MessageKey] : id;
    const list = readStoreValue<Notif[]>(NOTIF_KEY, []);
    writeStoreValue(NOTIF_KEY, removeAppNotifs(list, name));
    pushRecent(id);
    closeAll();
    setActive(null);
    setLaunchPulse(id);
    if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
    pulseTimer.current = window.setTimeout(() => setLaunchPulse(null), 1200);
  };

  // Pull down from the top of the home screen to open the notification center.
  const pullRef = useRef<{ y: number } | null>(null);
  const pullStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (locked || active || editMode || ncOpen || recentsOpen || spotOpen) return;
    const y = e.touches[0]?.clientY;
    if (y != null && y <= 110) pullRef.current = { y };
  };
  const pullMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    const s = pullRef.current;
    if (!s) return;
    const y = e.touches[0]?.clientY;
    if (y != null && y - s.y > 70) {
      pullRef.current = null;
      setNcOpen(true);
    }
  };
  const pullEnd = () => {
    pullRef.current = null;
  };

  // System hardware buttons (Home / Voice / AI) + desktop H/V/A shortcuts.
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const runRef = useRef<(action: HardwareAction) => void>(() => {});
  runRef.current = (action) => {
    if (lockedRef.current) return; // locked: the system must be unlocked first
    if (action === "home") {
      setEditMode(false);
      closeAll();
      setActive(null);
    } else if (action === "ai" || action === "voice") {
      open("ai");
    }
  };

  // Route real `hardware-button` events from the Rust core (Home/Voice/AI).
  useEffect(() => {
    if (!bridged()) return;
    let alive = true;
    let unsub: (() => void) | null = null;
    void (async () => {
      unsub = await subscribe("hardware-button", (payload) => {
        if (alive) runRef.current(buttonActionOf(payload));
      });
    })();
    return () => {
      alive = false;
      unsub?.();
    };
  }, []);

  // Desktop dev convenience: H = home, V = voice (AI), A = AI — same actions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (typing) return; // don't hijack keys while typing in a field
      runRef.current(keyActionOf(e.key));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (locked) return <LockScreen onUnlock={() => setLocked(false)} />;

  if (active) {
    const key = appTitleKey(active);
    const title = key ? t(key) : ext.find((x) => x.id === active)?.name ?? active;
    return (
      <AppShell key={active} title={title} onBack={back}>
        <AppComponent id={active} />
      </AppShell>
    );
  }

  if (editMode)
    return (
      <EditHome
        layout={layout}
        onChange={(l) => {
          setLayout(l);
          saveLayout(l);
        }}
        onDone={() => setEditMode(false)}
      />
    );

  return (
    <div
      className="flex h-full flex-col"
      onTouchStart={pullStart}
      onTouchMove={pullMove}
      onTouchEnd={pullEnd}
      onTouchCancel={pullEnd}
    >
      <StatusBar />
      <TopBar
        onLock={() => setLocked(true)}
        onRecents={() => setRecentsOpen(true)}
        onSearch={() => setSpotOpen(true)}
        onNotify={() => setNcOpen(true)}
        onEdit={() => setEditMode(true)}
      />
      <div className="min-h-0 flex-1">
        <HomeDock
          layout={layout}
          ext={ext}
          onOpen={open}
          pulseId={launchPulse}
          onMove={(drag, over) =>
            setLayout((prev) => {
              const next = moveBefore(prev, drag, over);
              saveLayout(next);
              return next;
            })
          }
        />
      </div>
      <NotificationCenter open={ncOpen} onClose={() => setNcOpen(false)} />
      <RecentsPanel open={recentsOpen} onClose={() => setRecentsOpen(false)} onOpen={open} />
      <SpotlightPanel open={spotOpen} onClose={() => setSpotOpen(false)} onOpen={softLaunch} />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <div className="flex h-full w-full items-center justify-center overflow-hidden bg-neutral-300/60 sm:py-5 dark:bg-neutral-950">
          <div className="relative h-full w-full max-w-[400px] overflow-hidden bg-neutral-100 shadow-2xl ring-1 ring-black/10 sm:h-[min(93vh,860px)] sm:rounded-[46px] dark:bg-black dark:ring-white/10">
            <Backdrop />
            <div className="relative z-10 h-full">
              <Shell />
            </div>
            {/* Global arrival toast, layered above every screen (home/app/lock). */}
            <NotificationBanner />
            {/* Incoming-call surface: Ringing → Answer/Decline; Active → record + hang up. */}
            <IncomingCall />
          </div>
        </div>
      </I18nProvider>
    </ThemeProvider>
  );
}
