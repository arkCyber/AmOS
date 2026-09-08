import { useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent as ReactTouchEvent } from "react";
import { ThemeProvider } from "./theme";
import { I18nProvider, useI18n } from "./i18n";
import { APPS, appTitleKey, AppComponent, svelteEnabled } from "./apps";
import HomeDock from "./components/HomeDock";
import SveltePropsHost from "./components/SveltePropsHost";
import SvelteAppHost from "./components/SvelteAppHost";
import { amosLog } from "./lib/debugLog";
import { edgeAtY, pastEdgeThreshold, type Edge } from "./lib/edgeSwipe";
import { LockScreen, RecentsPanel, SpotlightPanel } from "./components/SystemPanels";
import NotificationCenter from "./components/NotificationCenter";
import NotificationBanner from "./components/NotificationBanner";
import IncomingCall from "./components/IncomingCall";
import { Backdrop } from "./components/Wallpaper";
import EditHome from "./components/EditHome";
import StatusBar from "./components/StatusBar";
import { getLayout, hydrateFromSystemStore, moveBefore, addAppsToDock, pushRecent, saveLayout, readStoreValue, writeStoreValue, type HomeLayout } from "./lib/amosStore";
import { NOTIF_KEY, removeAppNotifs, type Notif } from "./lib/settings";
import { zh, type MessageKey } from "./i18n/locales/zh";
import { isExtId, loadStoreTiles, subscribeStoreTiles, tileById, type StoreTile } from "./lib/storeApps";
import { useStoreValue } from "./lib/useStoreValue";
import { bridged, subscribe } from "./lib/backend";
import { clampAutoOffSec, dueForAutoSleep, setScreenState, AUTOOFF_STORE_KEY, WAKE_HOME_KEY, wakeHomeDue, wakeHomeEnabled } from "./lib/display";
import { useCallKeepAwake, useScreenHold } from "./lib/keepAwake";
import { useNotificationAlert } from "./lib/useNotificationAlert";
import { startLmkSurfaceWatcher, startPeriodicReconcile } from "./lib/lmk";
import { startAlarmWatcher } from "./svelte/osAlarmWatcher";
import { startReminderWatcher } from "./svelte/osReminderWatcher";
import { startTimerWatcher } from "./svelte/osTimerWatcher";
import {
  buttonActionOf,
  keyActionOf,
  type HardwareAction,
} from "./lib/systemButtons";

// Dynamic loader for the Svelte home screen (consumed by SveltePropsHost). Kept
// module-stable so the host mounts it exactly once per identity.
const loadHomeDock = () => import("./svelte/HomeDock.svelte");
// The home layout editor is also a controlled screen (shell owns the layout).
const loadEditHome = () => import("./svelte/EditHome.svelte");
// The iOS-style App Library is a controlled screen too (shell owns navigation).
const loadAppLibrary = () => import("./svelte/AppLibrary.svelte");
// Shell-chrome island: StatusBar needs no props — read the same stores as React.
const loadStatusBar = () => import("./svelte/StatusBar.svelte");
function StatusBarEntry() {
  return svelteEnabled() ? (
    <SvelteAppHost load={loadStatusBar} className="" />
  ) : (
    <StatusBar />
  );
}
// Global "notification arrived" toast chrome island (reads NOTIF + DND stores).
const loadNotificationBanner = () => import("./svelte/NotificationBanner.svelte");
function NotificationBannerEntry() {
  return svelteEnabled() ? (
    <SvelteAppHost load={loadNotificationBanner} className="" />
  ) : (
    <NotificationBanner />
  );
}
// Wallpaper backdrop chrome island (pure presentational; reads theme + settings).
const loadBackdrop = () => import("./svelte/Backdrop.svelte");
function BackdropEntry() {
  return svelteEnabled() ? (
    <SvelteAppHost load={loadBackdrop} className="" />
  ) : (
    <Backdrop />
  );
}
// Recents overlay is a CONTROLLED chrome panel (shell owns `open`).
const loadRecents = () => import("./svelte/RecentsPanel.svelte");
// Spotlight overlay is CONTROLLED too (shell owns `open`; result = soft-launch).
const loadSpotlight = () => import("./svelte/SpotlightPanel.svelte");
// LockScreen is the whole-screen locked surface (emits 'unlock' to the shell).
const loadLockScreen = () => import("./svelte/LockScreen.svelte");
// NotificationCenter (control center) is a CONTROLLED overlay.
const loadNotificationCenter = () => import("./svelte/NotificationCenter.svelte");
// Incoming call surface is an always-mounted ISLAND driven by telephony events.
const loadIncomingCall = () => import("./svelte/IncomingCall.svelte");
function IncomingCallEntry() {
  return svelteEnabled() ? (
    <SvelteAppHost load={loadIncomingCall} className="" />
  ) : (
    <IncomingCall />
  );
}

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

function AppShell({
  title,
  onBack,
  onNotify,
  children,
}: {
  title: string;
  onBack: () => void;
  /** Pull DOWN from the top of an app → open quick settings (notification center). */
  onNotify?: () => void;
  children: ReactNode;
}) {
  // Edge gestures: pull UP from the bottom edge → return to the home/dock screen;
  // pull DOWN from the top edge → open quick settings (handled by [onNotify]). Only
  // a drag that starts in the thin top/bottom edge zone counts (lib/edgeSwipe.ts),
  // so it doesn't fight scrolling inside the app content. The bottom edge is the
  // whole home-indicator strip (not just the small pill) so a bottom-up reliably
  // gets you back to the dock.
  const grabRef = useRef<{ edge: Edge; y: number } | null>(null);
  const firedRef = useRef(false);
  const grabStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    const y = e.touches[0]?.clientY;
    if (y == null) return;
    const h = e.currentTarget.clientHeight || window.innerHeight;
    const edge = edgeAtY(y, h);
    if (!edge) return;
    grabRef.current = { edge, y };
    firedRef.current = false;
  };
  const grabMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    const g = grabRef.current;
    if (!g || firedRef.current) return;
    const y = e.touches[0]?.clientY;
    if (y == null) return;
    if (pastEdgeThreshold(g.edge, g.y, y)) {
      firedRef.current = true;
      grabRef.current = null;
      if (g.edge === "top") onNotify?.();
      else onBack();
    }
  };
  const grabEnd = () => {
    grabRef.current = null;
  };
  return (
    <div
      className="app-enter flex h-full flex-col bg-neutral-100 dark:bg-neutral-950"
      onTouchStart={grabStart}
      onTouchMove={grabMove}
      onTouchEnd={grabEnd}
      onTouchCancel={grabEnd}
    >
      <StatusBarEntry />
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

function Shell() {
  const { t } = useI18n();
  const ids = useMemo(() => APPS.map((a) => a.id), []);
  const [layout, setLayout] = useState<HomeLayout>(() => getLayout(ids));
  const [ext, setExt] = useState<StoreTile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [libOpen, setLibOpen] = useState(false);
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
    setLibOpen(false);
    setActive(id);
  };
  // Single "return to AmOS home" entry used by the app's back arrow, the bottom home
  // pill, and the hardware-home action — logging so an on-device "home does nothing"
  // is diagnosable (WebView console via chrome://inspect or adb logcat).
  const goHome = (src: string) => {
    console.info(`[shell] go-home from ${src}`);
    setEditMode(false);
    setLibOpen(false);
    closeAll();
    setActive(null);
  };
  // Keep a fresh handle so the resume listener below always calls the latest goHome.
  const goHomeRef = useRef(goHome);
  goHomeRef.current = goHome;
  // Latest "wake → home" policy for the (mount-once) resume listener.
  const wakeHomeRef = useRef(true);
  const back = () => goHome("app-back");

  // Physical screen-on / app-resume policy: when the app returns from a *real*
  // background (power-button wake, screen on) → show the dock home page, mirroring
  // the in-app unlock→home behavior. Only an absence of at least WAKE_HOME_MIN_MS
  // counts as a wake — transient focus losses (a system permission dialog, a quick
  // notification-shade peek, an in-app blur) are ignored so the user isn't yanked
  // back to the dock. Gated by the wakeHome setting and never bypasses our own
  // LockScreen (that path goes through handleUnlock).
  useEffect(() => {
    let leaveAt: number | null = null;
    const leaving = () => {
      if (leaveAt == null) leaveAt = Date.now();
    };
    const arriving = () => {
      const start = leaveAt;
      leaveAt = null;
      // Only a *real* wake (away >= WAKE_HOME_MIN_MS) returns to the dock.
      if (!wakeHomeDue(start, Date.now())) return;
      if (wakeHomeRef.current) goHomeRef.current("resume");
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") leaving();
      else arriving();
    };
    const onBlur = () => leaving();
    const onFocus = () => arriving();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Clean up the pulse timer if the shell unmounts.
  useEffect(() => {
    const t = pulseTimer.current;
    return () => {
      if (t) window.clearTimeout(t);
    };
  }, []);

  // Log which visible surface the shell is showing whenever it changes. The home
  // screen (HomeDock, incl. the dock pill) only renders when NOT locked / NOT in
  // an app / NOT in edit mode — so this pinpoints an on-device "dock missing"
  // (stuck on lock/app/edit) in adb logcat.
  useEffect(() => {
    const where = locked
      ? "lock"
      : libOpen
        ? "library"
        : active
          ? `app:${active}`
          : editMode
            ? "edit"
            : "home";
    amosLog("shell", `surface=${where}`, { locked, active, editMode, libOpen });
  }, [locked, active, editMode, libOpen]);

  // Global notification-arrival alert (vibrate + ring per effective sound policy),
  // mounted once so it fires on every screen — home, inside an app, even locked.
  useNotificationAlert();
  // OS-wide due reminders/alarms/countdown-timer: ONE React-free implementation
  // each (os*Watcher), started here while React hosts — and by Shell.svelte once
  // it becomes the host. No React hook duplicates remain for these.
  const notifierActiveRef = useRef(active);
  notifierActiveRef.current = active;
  useEffect(() => {
    const getActive = () => notifierActiveRef.current;
    const stops = [
      startReminderWatcher(getActive),
      startAlarmWatcher(getActive),
      startTimerWatcher(getActive),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);
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

  // Edge gestures on the home screen: pull DOWN from the top edge → notification
  // center / quick settings (flashlight, airplane mode, …). Pulling UP from the
  // bottom on the home screen intentionally does nothing — the dock/home is
  // already in view and must never be covered by an overlay (Recents stays
  // reachable from the ⇤ TopBar / app surface). Pure logic in lib/edgeSwipe.ts.
  const pullRef = useRef<{ edge: Edge; y: number } | null>(null);
  const edgeFired = useRef(false);
  const pullStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (locked || active || editMode || ncOpen || recentsOpen || spotOpen) {
      pullRef.current = null;
      return;
    }
    const y = e.touches[0]?.clientY;
    if (y == null) return;
    const edge = edgeAtY(y, window.innerHeight);
    if (!edge) return;
    pullRef.current = { edge, y };
    edgeFired.current = false;
  };
  const pullMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    const s = pullRef.current;
    if (!s || edgeFired.current || s.edge !== "top") return;
    const y = e.touches[0]?.clientY;
    if (y == null) return;
    if (pastEdgeThreshold(s.edge, s.y, y)) {
      edgeFired.current = true;
      pullRef.current = null;
      closeAll();
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
  // Reactive "wake → home" preference (Settings → General). When ON, unlocking or
  // returning to the foreground lands on the dock home page. Live so a Settings
  // toggle takes effect without remounting.
  const wakeHomeRaw = useStoreValue<unknown>(WAKE_HOME_KEY, true);
  const wakeHomeOn = wakeHomeEnabled(wakeHomeRaw);
  wakeHomeRef.current = wakeHomeOn;

  // Single screen-off entry used by the TopBar lock button AND the idle watcher,
  // so both paths report one consistent state to the daemon.
  const lockScreen = () => {
    setLocked(true);
    void setScreenState(false);
  };
  const handleUnlock = () => {
    setLocked(false);
    void setScreenState(true);
    // "Screen on" policy: whenever the display comes back on (manual 🔒 unlock or
    // waking from auto screen-off), return to the home/dock page — don't resume a
    // background app or leave an overlay up. goHome clears active + closes sheets.
    // Gated by the wakeHome setting (default ON).
    if (wakeHomeOn) goHome("unlock");
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

  // DOM fallback: the Rust core ALSO dispatches `hardware-button` as a plain DOM
  // CustomEvent (see buttons.rs `dispatch_dom`) so the shell reacts even when the
  // Tauri `listen` bridge isn't available on-device. Works regardless of bridged().
  useEffect(() => {
    const onHardwareDom = (e: Event) => {
      const detail = (e as CustomEvent<{ name?: string }>).detail;
      if (detail?.name) runRef.current(buttonActionOf(detail.name));
    };
    window.addEventListener("hardware-button", onHardwareDom);
    return () => window.removeEventListener("hardware-button", onHardwareDom);
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

  // Actions from the Svelte Recents overlay (channel "recents"): opening an app
  // reuses the shell's `open` (which also clears overlays); 'close' closes it.
  const handleRecentsEvent = (event: string, detail: unknown): void => {
    if (event === "open" && typeof detail === "string") open(detail);
    else if (event === "close") setRecentsOpen(false);
  };
  // Spotlight choosing an app = soft-launch (pulse its icon on home, stay home).
  const handleSpotlightEvent = (event: string, detail: unknown): void => {
    if (event === "open" && typeof detail === "string") softLaunch(detail);
    else if (event === "close") setSpotOpen(false);
  };
  // Control-center actions + close from the Svelte NotificationCenter.
  const handleNcEvent = (event: string, _detail: unknown): void => {
    if (event === "close") setNcOpen(false);
    else if (event === "search") setSpotOpen(true);
    else if (event === "recents") setRecentsOpen(true);
    else if (event === "edit") setEditMode(true);
    else if (event === "lock") lockScreen();
  };

  // System sheets (quick settings / recents / spotlight) render above BOTH the home
  // screen and an open app, so pull-down (quick settings) works from any surface.
  const sheets = (
    <>
      {svelteEnabled() ? (
        <SveltePropsHost
          name="nc"
          load={loadNotificationCenter}
          props={{ open: ncOpen }}
          onEvent={handleNcEvent}
          className=""
        />
      ) : (
        <NotificationCenter
          open={ncOpen}
          onClose={() => setNcOpen(false)}
          onSearch={() => setSpotOpen(true)}
          onRecents={() => setRecentsOpen(true)}
          onEdit={() => setEditMode(true)}
          onLock={lockScreen}
        />
      )}
      {svelteEnabled() ? (
        <SveltePropsHost
          name="recents"
          load={loadRecents}
          props={{ open: recentsOpen }}
          onEvent={handleRecentsEvent}
          className=""
        />
      ) : (
        <RecentsPanel open={recentsOpen} onClose={() => setRecentsOpen(false)} onOpen={open} />
      )}
      {svelteEnabled() ? (
        <SveltePropsHost
          name="spotlight"
          load={loadSpotlight}
          props={{ open: spotOpen }}
          onEvent={handleSpotlightEvent}
          className=""
        />
      ) : (
        <SpotlightPanel open={spotOpen} onClose={() => setSpotOpen(false)} onOpen={softLaunch} />
      )}
    </>
  );

  // Open the iOS-style "App Library" (home → trailing page). Only meaningful under
  // the Svelte-enabled production shell (which hosts AppLibrary.svelte); in the
  // React dev/test fallback there is no library screen, so it's a no-op there.
  const openLibrary = () => {
    if (!svelteEnabled()) return;
    closeAll();
    setEditMode(false);
    setActive(null);
    setLibOpen(true);
  };
  // Actions from the Svelte App Library (controlled over the "appLibrary" channel):
  // "open"(id) launches an app; "back" returns to the dock home.
  const handleAppLibraryEvent = (event: string, detail: unknown): void => {
    if (event === "open" && typeof detail === "string") open(detail);
    else if (event === "back") goHome("library-back");
    else if (event === "dockAdd" && Array.isArray(detail)) {
      const ids = detail.filter((x): x is string => typeof x === "string");
      setLayout((prev) => {
        const next = addAppsToDock(prev, ids);
        saveLayout(next);
        return next;
      });
    }
  };

  // Actions emitted by the Svelte home screen (bridged over the "home" propsBus
  // channel by SveltePropsHost). The React shell stays the single owner of
  // navigation + the home layout, exactly as it is for the React HomeDock.
  const handleHomeEvent = (event: string, detail: unknown): void => {
    if (event === "open") {
      if (typeof detail === "string") open(detail);
    } else if (event === "move") {
      const d = detail as { drag: string; over: string };
      setLayout((prev) => {
        const next = moveBefore(prev, d.drag, d.over);
        saveLayout(next);
        return next;
      });
    } else if (event === "search") {
      setSpotOpen(true);
    } else if (event === "library") {
      openLibrary();
    }
  };

  // Actions from the Svelte EditHome (controlled over the "editHome" channel):
  // it reports the NEXT layout it computed (via hideFromHome/restoreToHome) and
  // the shell persists it; "done" leaves edit mode. Same ownership split as home.
  const handleEditHomeEvent = (event: string, detail: unknown): void => {
    if (event === "change") {
      const l = detail as HomeLayout;
      setLayout(l);
      saveLayout(l);
    } else if (event === "done") {
      setEditMode(false);
    }
  };

  if (locked)
    return svelteEnabled() ? (
      <SveltePropsHost
        name="lock"
        load={loadLockScreen}
        props={{}}
        onEvent={(event) => {
          if (event === "unlock") handleUnlock();
        }}
      />
    ) : (
      <LockScreen onUnlock={handleUnlock} />
    );

  if (active) {
    const key = appTitleKey(active);
    const title = key ? t(key) : ext.find((x) => x.id === active)?.name ?? active;
    return (
      <>
        <AppShell key={active} title={title} onBack={back} onNotify={() => setNcOpen(true)}>
          <AppComponent id={active} />
        </AppShell>
        {sheets}
      </>
    );
  }

  if (libOpen)
    return (
      <div className="flex h-full flex-col" data-testid="app-library">
        <StatusBarEntry />
        <div className="min-h-0 flex-1">
          <SveltePropsHost
            name="appLibrary"
            load={loadAppLibrary}
            props={{ layout, ext }}
            onEvent={handleAppLibraryEvent}
          />
        </div>
      </div>
    );

  if (editMode)
    return svelteEnabled() ? (
      <SveltePropsHost
        name="editHome"
        load={loadEditHome}
        props={{ layout }}
        onEvent={handleEditHomeEvent}
      />
    ) : (
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
      <StatusBarEntry />
      <div className="min-h-0 flex-1">
        {svelteEnabled() ? (
          <SveltePropsHost
            name="home"
            load={loadHomeDock}
            props={{ layout, ext, pulseId: launchPulse }}
            onEvent={handleHomeEvent}
          />
        ) : (
          <HomeDock
            layout={layout}
            ext={ext}
            onOpen={open}
            onSearch={() => setSpotOpen(true)}
            pulseId={launchPulse}
            onMove={(drag, over) =>
              setLayout((prev) => {
                const next = moveBefore(prev, drag, over);
                saveLayout(next);
                return next;
              })
            }
          />
        )}
      </div>
      {sheets}
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <div className="flex h-full w-full items-center justify-center overflow-hidden bg-neutral-300/60 sm:py-5 dark:bg-neutral-950">
          <div className="relative h-full w-full max-w-[400px] overflow-hidden bg-neutral-100 shadow-2xl ring-1 ring-black/10 sm:h-[min(93vh,860px)] sm:rounded-[46px] dark:bg-black dark:ring-white/10">
            <BackdropEntry />
            <div className="relative z-10 h-full">
              <Shell />
            </div>
            {/* Global arrival toast, layered above every screen (home/app/lock). */}
            <NotificationBannerEntry />
            {/* Incoming-call surface: Ringing → Answer/Decline; Active → record + hang up. */}
            <IncomingCallEntry />
          </div>
        </div>
      </I18nProvider>
    </ThemeProvider>
  );
}
