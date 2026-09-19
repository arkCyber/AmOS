/**
 * osShortcutTriggers.ts — the shell's automation runtime for shortcuts.
 *
 * Mirrors `osTimerWatcher` / `osReminderWatcher` (a shell-level watcher started in
 * `Shell.svelte`'s `onMount`, released in `onDestroy`), but for user automation. Two
 * timers with different jobs, and both are needed:
 *
 * 1. **Rust (`shortcuts_trigger_*`)** — *when*. A wall-clock ledger plus the platform's
 *    exact-alarm binding: this is what still works with no window open and a dozing
 *    phone. The shell keeps the plan in sync with the stored shortcuts and polls it.
 * 2. **The WebView heartbeat (`ShortcutTriggerRuntime.start`)** — the *fallback* and the
 *    **only** timer on a host without the bridge (a plain browser), plus a backstop for a
 *    stale plan. Both paths report the same minute, and the runtime dedupes to one run
 *    per trigger per minute, so a trigger can never fire twice.
 *
 * Non-time triggers are observed **here**, because the WebView is where the signals are
 * visible: connectivity (`online`/`offline` + the Wi-Fi store), the host battery, and the
 * shell's own "app opened" event. Every signal is forwarded; `triggerMatches` decides.
 */
import { SHORTCUTS_KEY, ShortcutTriggerRuntime, loadShortcuts, APP_OPENED_EVENT, type TriggerEvent } from "../lib/shortcuts";
import {
  parseTriggerKey,
  pollTimeTriggers,
  syncTimeTriggers,
  timeTriggerSpecs,
} from "../lib/shortcutSchedule";
import { STORE_CHANGED_EVENT, readStoreValue } from "../lib/amosStore";
import { WIFI_KEY, normalizeWifi } from "../lib/wifi";
import { watchHostBattery } from "../lib/batteryStatus";
import { amosWarn } from "../lib/debugLog";

/** How often the shell asks the Rust ledger "is anything due?". */
export const TRIGGER_POLL_MS = 15_000;

export interface ShortcutTriggerHostOptions {
  /**
   * Whether the host considers the screen locked, for `runOnLockScreen`.
   *
   * **What the shell actually passes is a proxy** (REQ-A412): `Shell.svelte` uses
   * `surface().kind === "lock"` — *AmOS's own* lock screen — because the real device
   * keyguard is not visible from the WebView and reading it needs a host command
   * (`KeyguardManager.isKeyguardLocked`) plus the Kotlin glue. The proxy is
   * conservative in one direction and **not** in the other: with the shell's lock
   * screen up it refuses `runOnLockScreen: false` shortcuts even when the device is
   * unlocked, but a device that is locked while the shell sits on an app (the WebView
   * backgrounded by the OS) reports `false`, so such a shortcut may run while the
   * phone is locked. Until the host command exists, that gap is real and documented
   * rather than papered over.
   */
  isLocked?: () => boolean;
}

/**
 * Start the automation runtime. Returns a stop function (call it on unmount).
 *
 * Every listener is removed by that function, and nothing here throws into the shell:
 * a missing bridge, a storage failure, or a rejected rule is a logged fact.
 */
export function startShortcutTriggers(options: ShortcutTriggerHostOptions = {}): () => void {
  const runtime = new ShortcutTriggerRuntime({
    isLocked: options.isLocked ?? (() => false),
  });
  runtime.start();

  /** Ask Rust to hold the current plan (idempotent; called on every shortcut edit). */
  const syncPlan = (): void => {
    syncTimeTriggers(timeTriggerSpecs(loadShortcuts()))
      .then((reply) => {
        // `null` = no bridge. The heartbeat above is then the only timer there is, which
        // is the honest state of a browser-only host — no claim of an OS wake.
        for (const rejected of reply?.rejected ?? []) {
          amosWarn("shortcuts", `trigger not armed: ${rejected.key} (${rejected.reason})`);
        }
      })
      .catch((err) => {
        // Bridge rejected the plan; the dedupe ledger stays warm and the heartbeat
        // keeps polling so we recover when the bridge comes back.
        amosWarn("shortcuts", "syncTimeTriggers failed", err);
      });
  };

  /** Poll the Rust ledger for due occurrences and run them. */
  const pollDue = async (): Promise<void> => {
    const due = await pollTimeTriggers();
    if (due === null) return; // no bridge — the heartbeat covers time triggers
    for (const fired of due) {
      if (!parseTriggerKey(fired.key)) continue;
      await fire({ type: "time", at: fired.atMs });
    }
  };

  const fire = (event: TriggerEvent): Promise<string[]> =>
    runtime.fire(event).catch((err) => {
      amosWarn("shortcuts", "trigger runtime failed", err);
      return [];
    });

  const interval = window.setInterval(() => {
    void pollDue();
  }, TRIGGER_POLL_MS);

  // The user edited shortcuts (create / update / delete / trigger change): re-teach both
  // halves, and clear the dedupe memory so an edited trigger can run in this same minute.
  const onStore = (e: Event): void => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key;
    if (key !== SHORTCUTS_KEY) return;
    runtime.sync();
    syncPlan();
  };

  const onOnline = (): void => {
    void fire({ type: "wifi", at: Date.now(), data: { ssid: joinedSsid(), connected: true } });
  };
  const onOffline = (): void => {
    void fire({ type: "wifi", at: Date.now(), data: { ssid: joinedSsid(), connected: false } });
  };
  const onAppOpened = (e: Event): void => {
    const appId = (e as CustomEvent<{ appId?: string }>).detail?.appId;
    if (typeof appId !== "string" || appId === "") return;
    void fire({ type: "app", at: Date.now(), data: { appId, event: "open" } });
  };

  const stopBattery = watchHostBattery((sample) => {
    const data: Record<string, unknown> = {};
    if (sample.levelPct !== null) data.levelPct = sample.levelPct;
    if (sample.charging !== null) data.charging = sample.charging;
    void fire({ type: "battery", at: Date.now(), data });
  });

  window.addEventListener(STORE_CHANGED_EVENT, onStore);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener(APP_OPENED_EVENT, onAppOpened);
  syncPlan();

  return () => {
    window.clearInterval(interval);
    window.removeEventListener(STORE_CHANGED_EVENT, onStore);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener(APP_OPENED_EVENT, onAppOpened);
    stopBattery?.();
    runtime.stop();
  };
}

/** The SSID we are joined to, or `""` — read straight from the Wi-Fi store. */
function joinedSsid(): string {
  return normalizeWifi(readStoreValue<unknown>(WIFI_KEY, null)).current ?? "";
}
