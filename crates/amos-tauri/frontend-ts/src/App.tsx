import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ThemeProvider } from "./theme";
import { I18nProvider, useI18n } from "./i18n";
import { APPS, appTitleKey, AppComponent } from "./apps";
import HomeDock from "./components/HomeDock";
import { LockScreen, RecentsPanel, SpotlightPanel } from "./components/SystemPanels";
import NotificationCenter from "./components/NotificationCenter";
import { Backdrop } from "./components/Wallpaper";
import EditHome from "./components/EditHome";
import StatusBar from "./components/StatusBar";
import { getLayout, moveBefore, pushRecent, saveLayout, readStoreValue, writeStoreValue, type HomeLayout } from "./lib/amosStore";
import { NOTIF_KEY, removeAppNotifs, type Notif } from "./lib/settings";
import { zh, type MessageKey } from "./i18n/locales/zh";
import { bridged, subscribe } from "./lib/backend";
import {
  buttonActionOf,
  keyActionOf,
  type HardwareAction,
} from "./lib/systemButtons";

function AppShell({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <button onClick={onBack} aria-label="back" className="w-6 text-accent text-sm font-semibold hover:underline">
          ‹
        </button>
        <span className="flex-1 truncate text-center text-sm font-semibold">{title}</span>
        <span className="w-6" />
      </header>
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
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
  return (
    <div className="flex items-center justify-between px-4 pt-3">
      <div className="flex gap-2">
        <button onClick={onNotify} className="rounded-full bg-neutral-300/70 px-3 py-1 text-xs dark:bg-neutral-700/70" title="notifications">
          🔔
        </button>
        <button onClick={onRecents} className="rounded-full bg-neutral-300/70 px-3 py-1 text-xs dark:bg-neutral-700/70" title="recents">
          ⇤
        </button>
        <button onClick={onSearch} className="rounded-full bg-neutral-300/70 px-3 py-1 text-xs dark:bg-neutral-700/70" title="search">
          🔍
        </button>
      </div>
      <div className="flex gap-2">
        <button onClick={onEdit} className="rounded-full bg-neutral-300/70 px-3 py-1 text-xs dark:bg-neutral-700/70" title="edit home">
          ✎
        </button>
        <button onClick={onLock} className="rounded-full bg-neutral-300/70 px-3 py-1 text-xs dark:bg-neutral-700/70" title="lock">
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
  const [active, setActive] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [spotOpen, setSpotOpen] = useState(false);
  const [ncOpen, setNcOpen] = useState(false);

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
    const name = key ? zh[key as MessageKey] : id;
    const list = readStoreValue<Notif[]>(NOTIF_KEY, []);
    writeStoreValue(NOTIF_KEY, removeAppNotifs(list, name));
    pushRecent(id);
    closeAll();
    setActive(id);
  };
  const back = () => setActive(null);

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
    const title = key ? t(key) : active;
    return (
      <AppShell title={title} onBack={back}>
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
    <div className="flex h-full flex-col">
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
          onOpen={open}
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
      <SpotlightPanel open={spotOpen} onClose={() => setSpotOpen(false)} onOpen={open} />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <Backdrop />
        <Shell />
      </I18nProvider>
    </ThemeProvider>
  );
}
