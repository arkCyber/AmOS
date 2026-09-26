/**
 * Shell-level Focus-schedule watcher (REQ-A684).
 *
 * The decision lives in `lib/focusSchedule.ts` (pure). This module is only the
 * timer + store adapter: it reads the windows, asks the kernel whether a window is
 * running, and writes the **one real DND bit** (`amos.settings.dnd`) through the
 * same key every other surface reads — no second silencing path.
 *
 * It reacts to schedule edits immediately (so a window added/toggled in Settings
 * takes effect without waiting for the tick) and otherwise re-evaluates on an
 * interval, so a window boundary is crossed even with the WebView idle.
 */
import { STORE_CHANGED_EVENT, readStoreValue, writeStoreValueChecked } from "../lib/amosStore";
import {
  SETTINGS_KEY,
  dndActive,
  normalizeQuick,
  saveQuick,
  type QuickSettings,
} from "../lib/settings";
import {
  FOCUS_AUTO_KEY,
  FOCUS_SCHEDULE_KEY,
  activeScenario,
  advanceDnd,
  dayOfWeek,
  minutesOfDay,
  normalizeFocusAuto,
  normalizeSchedule,
} from "../lib/focusSchedule";

/** Re-evaluate at least this often so a window boundary is never missed for long. */
const FOCUS_TICK_MS = 30_000;

/**
 * One reconcile: read (windows, owner flag, real DND) → decide → write what changed.
 * Writes **only** on an actual change so it cannot ping-pong with its own store event.
 *
 * Two things about the two writes, both learned the hard way:
 *
 *  - The DND bit goes through `saveQuick`, never `writeStoreValue(SETTINGS_KEY, qs)`.
 *    `qs` is `normalizeQuick`'s narrowing (seven booleans), while `amos.settings` is a
 *    union blob that also holds the AI provider and the cloud prefs — spreading the
 *    narrowing back erased them, for the whole OS, twice a day (REQ-A1397 ∕ F-SH-656).
 *
 *  - The **order** of the bit and the ownership flag is the guard, and the two
 *    directions are not symmetric. `advanceDnd` reads `amos.focus.auto` first: when it
 *    is `false` it answers `dnd: currentDnd`, i.e. hands off **forever**. So clearing
 *    the flag before the bit it owns has landed strands a scheduled DND **on** with no
 *    window active — every later tick reads "not ours" and does nothing, and nothing
 *    anywhere says so. A *claim*, by contrast, may safely precede the bit: an owner
 *    flag that is set while the bit is still off costs nothing (the next in-window tick
 *    re-attempts the bit, and if the window ends first, `advanceDnd(false, false,
 *    {auto:true})` clears the flag with the bit already off).
 */
export function focusWatcherTick(now: Date = new Date()): boolean {
  try {
    const schedule = normalizeSchedule(readStoreValue<unknown>(FOCUS_SCHEDULE_KEY, {}));
    const auto = normalizeFocusAuto(readStoreValue<unknown>(FOCUS_AUTO_KEY, {}));
    const qs: QuickSettings = normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {}));
    const current = dndActive(qs);
    const desired = activeScenario(schedule, dayOfWeek(now), minutesOfDay(now)) !== null;
    const step = advanceDnd(desired, current, auto);
    const bitMoves = step.dnd !== current;
    const ownerMoves = step.auto.auto !== auto.auto;
    const claims = step.auto.auto && !auto.auto;

    const writeBit = (): boolean => (bitMoves ? saveQuick({ dnd: step.dnd }) : true);
    const writeOwner = (): boolean =>
      ownerMoves ? writeStoreValueChecked(FOCUS_AUTO_KEY, step.auto) : true;

    if (claims) {
      if (!writeOwner()) return false;
      return writeBit();
    }
    if (!writeBit()) return false;
    return writeOwner();
  } catch {
    return false;
  }
}

/** Start the watcher. Returns a stop function (call on unmount). */
export function startFocusWatcher(): () => void {
  focusWatcherTick();
  const interval = window.setInterval(() => {
    try {
      focusWatcherTick();
    } catch {
      /* storage unavailable — best-effort */
    }
  }, FOCUS_TICK_MS);
  const onStore = (e: Event) => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key;
    if (key === FOCUS_SCHEDULE_KEY || key === FOCUS_AUTO_KEY || key === SETTINGS_KEY) {
      try {
        focusWatcherTick();
      } catch {
        /* ignore */
      }
    }
  };
  window.addEventListener(STORE_CHANGED_EVENT, onStore);
  return () => {
    window.clearInterval(interval);
    window.removeEventListener(STORE_CHANGED_EVENT, onStore);
  };
}
