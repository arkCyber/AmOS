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
 * visible: a change to the Wi-Fi store (`amos.wifi`, the network we joined or forgot), the
 * host battery, and the shell's own "app opened" event. Every signal is forwarded;
 * `triggerMatches` decides.
 */
import { SHORTCUTS_KEY, ShortcutTriggerRuntime, loadShortcuts, APP_OPENED_EVENT, type TriggerEvent } from "../lib/shortcuts";
import {
  osHoldsAlarm,
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
        // The other half of the same honesty rule (REQ-A773). `armed` means "the ledger
        // kept it", **not** "the OS took it": on a device where exact alarms are
        // `disallowed`/`denied`, or the glue is `unattached`, the trigger will not fire
        // while the phone dozes. Before this only `rejected` — a *parse* error — was
        // surfaced, so a real device refusal was silent: the automation never ran and
        // nothing said why. `host_only` (desktop / CI) is deliberately **not** a warning:
        // there the ledger + heartbeat *are* the mechanism, which is the honest answer.
        for (const armed of reply?.armed ?? []) {
          if (!osHoldsAlarm(armed.device.state)) {
            amosWarn(
              "shortcuts",
              `trigger armed in the ledger only: ${armed.key} (os: ${armed.device.state})`,
            );
          }
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

  /**
   * The Wi-Fi network we are on, kept across writes so a store change reads as a
   * **transition** rather than as a state.
   */
  let joined = joinedSsid();

  /**
   * The Wi-Fi store is the only Wi-Fi event AmOS can observe: `WifiCfg.current` moves
   * exactly when a screen joins or forgets a network (`lib/wifi.ts`), which is the very
   * thing this trigger's editor promises ("Wi-Fi · 连接时 ∕ 断开时", optionally scoped to an
   * SSID).
   *
   * It used to be fed from `navigator.onLine` — *internet reachability*, a different fact —
   * so it could not see the app's own join at all (the headline 「连上 X 时…」 never ran),
   * stayed silent when Wi-Fi dropped while cellular kept the host online (no `offline`),
   * and fired on a subway with Wi-Fi untouched — stamping that event with whatever SSID
   * `amos.wifi` happened to remember, i.e. naming a network that was never involved
   * (REQ-A1165 / F-SH-463).
   */
  const emitWifi = (next: string): void => {
    const prev = joined;
    if (prev === next) return;
    joined = next;
    // A store change can carry **two** real facts at once: a direct switch from one network
    // to another (`Home → Cafe`, the write `lib/wifi.ts::join` makes when you tap a second
    // network) is a *disconnect from Home* **and** a *join to Cafe*. Reporting only the join
    // (the old `next !== "" ? next : prev`) left the disconnect half unobservable, so a
    // 「断开 Home 时…」 rule silently missed every switch and only ran when the user pressed
    // "forget" — the transition was read as a state. Both halves are forwarded, and each is
    // named for the network it concerns; `fire` does not dedupe non-time events, which is
    // right here: leaving and joining are two things that happened.
    const emit = (ssid: string, connected: boolean): Promise<string[]> =>
      fire({ type: "wifi", at: Date.now(), data: { ssid, connected } });
    const left = prev !== "";
    const arrived = next !== "";
    if (left && arrived) {
      // Chained, not raced: a switch is a disconnect *then* a join, so the second half is
      // reported after the first — which also keeps two runs of the same shortcut from
      // overlapping (a run reads `runCount` when it starts and writes back the increment).
      void emit(prev, false).then(() => emit(next, true));
    } else if (left) {
      void emit(prev, false);
    } else if (arrived) {
      void emit(next, true);
    }
  };

  // The user edited shortcuts (create / update / delete / trigger change): re-teach both
  // halves, and clear the dedupe memory so an edited trigger can run in this same minute.
  // A Wi-Fi store change is the other signal this listener carries (see `emitWifi`).
  const onStore = (e: Event): void => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key;
    if (key === WIFI_KEY) {
      emitWifi(joinedSsid());
      return;
    }
    if (key !== SHORTCUTS_KEY) return;
    runtime.sync();
    syncPlan();
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
  window.addEventListener(APP_OPENED_EVENT, onAppOpened);
  syncPlan();

  return () => {
    window.clearInterval(interval);
    window.removeEventListener(STORE_CHANGED_EVENT, onStore);
    window.removeEventListener(APP_OPENED_EVENT, onAppOpened);
    stopBattery?.();
    runtime.stop();
  };
}

/** The SSID we are joined to, or `""` — read straight from the Wi-Fi store. */
function joinedSsid(): string {
  return normalizeWifi(readStoreValue<unknown>(WIFI_KEY, null)).current ?? "";
}
