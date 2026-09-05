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
import { clampAutoOffSec, dueForAutoSleep, setScreenState, AUTOOFF_STORE_KEY } from "./lib/display";
import { useCallKeepAwake, useScreenHold } from "./lib/keepAwake";
import { useNotificationAlert } from "./lib/useNotificationAlert";
import { startLmkSurfaceWatcher, startPeriodicReconcile } from "./lib/lmk";
import { useDueReminderAlerts } from "./lib/reminderNotify";
import {
  buttonActionOf,
  keyActionOf,
  type HardwareAction,
} from "./lib/systemButtons";

function HomeIndicator({ onHome }: { onHome: () => void }) {
  const startY = useRef<number | null>(null);
  const firedRef = useRef(false);
  // Fire once per gesture (a swipe-up also synthesizes a click); log for on-device
  // diagnostics via chrome://inspect or `adb logcat` (WebView console).
  const go = (src: "tap" | "swipe-up") => {
    if (firedRef.current) return;
    firedRef.current = true;
    console.info(`[shell] HomeIndicator ${src} -> home`);
    onHome();
    window.setTimeout(() => {
      firedRef.current = false;
    }, 250);
  };
  return (
    <div
      className="flex justify-center pt-1"
      // Guarantee the pill sits well ABOVE the Android system-gesture strip (the
      // likely cause of "home does nothing"): at least 24px of padding below it,
      // more if the OS reports a larger bottom inset. env() may be 0 if the WebView
      // is not treated as edge-to-edge, so we never trust it alone.
      style={{ paddingBottom: "max(24px, env(safe-area-inset-bottom))" }}
      onTouchStart={(e) => {
        firedRef.current = false;
        startY.current = e.touches[0]?.clientY ?? null;
      }}
      onTouchEnd={(e) => {
        const sy = startY.current;
        startY.current = null;
        const ey = e.changedTouches[0]?.clientY ?? sy;
        if (sy !== null && ey !== null && ey < sy - 40) go("swipe-up"); // swipe up
      }}
    >
      <button
        onClick={() => go("tap")}
        aria-label="home"
        title="Home"
        // Generous hit area so the tap reliably lands (h-3 + the tap maps to a click).
        className="h-3 w-32 cursor-pointer rounded-full bg-neutral-400/90 active:bg-accent dark:bg-neutral-600/90"
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
  // Single "return to AmOS home" entry used by the app's back arrow, the bottom home
  // pill, and the hardware-home action — logging so an on-device "home does nothing"
  // is diagnosable (WebView console via chrome://inspect or adb logcat).
  const goHome = (src: string) => {
    console.info(`[shell] go-home from ${src}`);
    setEditMode(false);
    closeAll();
    setActive(null);
  };
  const back = () => goHome("app-back");

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
  // OS-wide due-reminder scheduler: fires an app alert when a reminder's due
  // time is reached, on any screen (see lib/reminderNotify.ts). Suppressed while
  // the Reminders app itself is focused (its items are already on screen).
  useDueReminderAlerts(active);
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
      goHome("hardware-home");
    } else if (action === "ai" || action === "voice") {
      open("ai");
    }
  };

  // ---- Display protection (auto screen-off) --------------------------------
  // When enabled (`amos.displayAutoOffSec` > 0) and the shell is not locked, an
  // idle watcher sleeps the screen after N seconds without interaction. Locking
  // (auto or the TopBar 🔒) is phone-equivalent to turning the screen off, so
  // every lock path reports `screen_on = false` to the daemon via the shared
  // screen-state file (energy governor then defers/freezes); unlocking reports
  // it back on. Docs/display-idle.md.
  // Reactive auto screen-off timeout (seconds; 0 = off). Subscribed to the store
  // so a live write (e.g. a future Settings row, another window) re-arms the
  // watcher without a remount — not a one-shot read.
  const autoOffRaw = useStoreValue<unknown>(AUTOOFF_STORE_KEY, 0);
  const autoOffSec = clampAutoOffSec(autoOffRaw);
  // Single screen-off entry used by the TopBar lock button AND the idle watcher,
  // so both paths report one consistent state to the daemon.
  const lockScreen = () => {
    setLocked(true);
    void setScreenState(false);
  };
  const handleUnlock = () => {
    setLocked(false);
    void setScreenState(true);
  };
  const lastActivityRef = useRef(Date.now());
  // Keep-awake reasons: an active call (today) or a future nav/video session
  // asserts a screen hold; the idle watcher must not auto-sleep while any is held.
  useCallKeepAwake();
  const screenHeld = useScreenHold();
  const screenHeldRef = useRef(screenHeld);
  screenHeldRef.current = screenHeld;
  useEffect(() => {
    if (autoOffSec <= 0) return; // feature off by default
    const mark = () => {
      lastActivityRef.current = Date.now();
    };
    window.addEventListener("keydown", mark);
    window.addEventListener("pointerdown", mark);
    window.addEventListener("touchstart", mark);
    const id = window.setInterval(() => {
      if (lockedRef.current) return; // already on the lock screen
      const now = Date.now();
      const due = dueForAutoSleep(
        Math.floor(lastActivityRef.current / 1000),
        Math.floor(now / 1000),
        autoOffSec,
        screenHeldRef.current,
      );
      if (due) lockScreen();
    }, 1000);
    return () => {
      window.removeEventListener("keydown", mark);
      window.removeEventListener("pointerdown", mark);
      window.removeEventListener("touchstart", mark);
      window.clearInterval(id);
    };
    // lockScreen is stable across the component; the dependency set is fixed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOffSec]);

  // Re-assert the screen is ON on boot (the shell starts unlocked = display
  // visible): clears a stale `off` left by a previous run so the daemon never
  // keeps deferring/freezing as if the screen were still dark. No-op offline.
  useEffect(() => {
    if (!lockedRef.current) void setScreenState(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Tear down `legacy` Android surfaces whose container app was reclaimed or
  // destroyed (daemon `WatchLmk` → Rust `lmk-surface` event → wm_close). Also
  // reconcile the whole legacy set periodically against the authoritative LMK
  // snapshot (catches surfaces stale before the watcher started / missed events).
  useEffect(() => {
    if (!bridged()) return;
    let alive = true;
    let unsub: (() => void) | null = null;
    void (async () => {
      const stop = await startLmkSurfaceWatcher();
      if (!alive) {
        stop();
        return;
      }
      unsub = stop;
    })();
    const stopPeriodic = startPeriodicReconcile();
    return () => {
      alive = false;
      unsub?.();
      stopPeriodic();
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

  if (locked) return <LockScreen onUnlock={handleUnlock} />;

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
        onLock={lockScreen}
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
