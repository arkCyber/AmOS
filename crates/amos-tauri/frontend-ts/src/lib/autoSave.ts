/**
 * lib/autoSave.ts — debounced "save on idle" for the full-page note editor
 * (design: docs/notes-editor.md).
 *
 * Two small, pure, headless-testable pieces:
 *   1. a debouncer whose timer is **injectable**, so tests drive it with a fake
 *      clock (coalesce → fire on trailing edge; cancel; flush-before-leave);
 *   2. a tiny save-state reducer (`dirty` / `saved` / `saving` / `error`) so the
 *      editor can show "正在保存… / 保存于 HH:MM:SS" without a running app.
 *
 * The editor itself (NoteEditor.svelte) is deliberately NOT here — it is a
 * follow-on that wires these into `NotesApp` as a full-bleed overlay.
 */

/** Timer seam: lets a test substitute a manual clock. */
export interface TimerApi {
  set(cb: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

const defaultTimer: TimerApi = {
  set: (cb, ms) => setTimeout(cb, ms) as unknown,
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface Debouncer {
  /** (Re)arm the trailing-edge timer; earlier pending calls are coalesced. */
  schedule(): void;
  /** Drop any pending call (no-op if none). */
  cancel(): void;
  /** Run the pending call now (if any) and disarm. Used on ‹ back to not lose work. */
  flush(): void;
}

/** A debouncer that runs `fn` once, `ms` after the last `schedule()` (no leading
 *  fire). `timers` defaults to the real setTimeout but is injectable for tests. */
export function createDebouncer(
  fn: () => void,
  ms: number,
  timers: TimerApi = defaultTimer,
): Debouncer {
  let id: unknown = null;
  const clear = () => {
    if (id !== null) {
      timers.clear(id);
      id = null;
    }
  };
  return {
    schedule() {
      clear();
      id = timers.set(() => {
        id = null;
        fn();
      }, ms);
    },
    cancel() {
      clear();
    },
    flush() {
      if (id !== null) {
        clear();
        fn();
      }
    },
  };
}

// ---- save-state ---------------------------------------------------------------

export type SaveStatus = "saved" | "saving" | "error";

export interface SaveState {
  /** True when the draft differs from what was last persisted. */
  dirty: boolean;
  status: SaveStatus;
}

export type SaveEvent =
  | { type: "edit" }
  | { type: "flush_started" }
  | { type: "saved" }
  | { type: "save_failed" };

export const initialSaveState: SaveState = { dirty: false, status: "saved" };

/** Fold editor/save events into a small UI-facing save state. */
export function saveStateReducer(state: SaveState, event: SaveEvent): SaveState {
  switch (event.type) {
    case "edit":
      return { dirty: true, status: "saving" };
    case "flush_started":
      return { ...state, status: "saving" };
    case "saved":
      return { dirty: false, status: "saved" };
    case "save_failed":
      return { dirty: true, status: "error" };
  }
}

/** A readable clock label for "保存于 HH:MM:SS" (local time). Pure + testable. */
export function clockLabel(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
