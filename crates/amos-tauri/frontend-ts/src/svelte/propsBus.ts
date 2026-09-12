/**
 * propsBus.ts — General shell ⇄ Svelte screen external-props + events channel.
 *
 * WHY: Svelte 5's imperative `mount()` returns only the component's exports —
 * there is NO public `$setProps`, so the shell cannot push updated props to
 * an already-mounted runes component without unmounting it (which would reset
 * its internal $state, e.g. the home icon-grid page). For screens that are
 * CONTROLLED by the shell (like the home HomeDock, whose layout/ext/pulse
 * the shell owns), we need in-place, reactive prop updates.
 *
 * This is the general, framework-agnostic primitive (option C). A named
 * "channel" carries TWO independent directions:
 *   • DOWN (shell → screen): a reactive `svelte/store` writable of the screen's
 *     external props. The screen subscribes and re-renders in place.
 *   • UP   (screen → shell): a tiny event emitter the screen uses to signal
 *     one-shot actions (open/move/search) back to the shell.
 *
 * It is plain TS + `svelte/store` (no runes), so both the shell and any Svelte
 * component can import it. Screens are keyed by a stable `name`, so host and
 * component never need to import each other's instances.
 */
import { writable, type Readable } from "svelte/store";

export interface ChannelUp {
  /** (event, detail) fired by the component for the host to observe. */
  on(listener: (event: string, detail: unknown) => void): () => void;
  emit(event: string, detail?: unknown): void;
}

export interface ChannelDown<T> extends Readable<T> {
  /** Persist new external props; the Svelte screen re-renders in place. */
  set(v: T): void;
  /** Current snapshot (reactivity-free read for hosts / initial mount). */
  get(): T | undefined;
}

/**
 * A full two-way channel: the DOWN props store plus the UP event surface.
 *
 * Extends [`ChannelUp`] rather than re-declaring `emit`/`on`: this is the
 * interface every screen actually consumes, so the UP contract must have **one**
 * definition — a hand-copied pair here would silently not track a change to
 * `ChannelUp` (the exact "declared seam duplicated at its call site" drift the
 * unwired audit looks for).
 */
export interface PropsChannel<T> extends ChannelDown<T>, ChannelUp {}

interface BusEntry<T> {
  down: ReturnType<typeof writable<T>>;
  current: T | undefined;
  up: Set<(event: string, detail: unknown) => void>;
}

const channels = new Map<string, BusEntry<unknown>>();

function entry<T>(name: string): BusEntry<T> {
  let e = channels.get(name) as BusEntry<T> | undefined;
  if (!e) {
    const down = writable<T | undefined>(undefined);
    e = { down, current: undefined, up: new Set() } as unknown as BusEntry<T>;
    channels.set(name, e as unknown as BusEntry<unknown>);
  }
  return e;
}

/**
 * Get (creating if needed) the named props channel for a controlled Svelte
 * screen. `name` must be unique per screen instance (e.g. "home").
 */
export function propsChannel<T>(name: string): PropsChannel<T> {
  const e = entry<T>(name);
  const subscribe: Readable<T>["subscribe"] = (run, invalidate) =>
    e.down.subscribe((v) => run(v as T), invalidate);
  return {
    subscribe,
    get: () => e.current,
    set: (v: T) => {
      e.current = v;
      e.down.set(v);
    },
    emit: (event: string, detail?: unknown) => {
      for (const l of [...e.up]) l(event, detail);
    },
    on: (listener: (event: string, detail: unknown) => void) => {
      e.up.add(listener);
      return () => {
        e.up.delete(listener);
      };
    },
  };
}

/** Test/setup helper: drop all registered channels (isolates tests). */
export function resetPropsChannels(): void {
  channels.clear();
}

/**
 * Tear down one named channel (drop its DOWN state + any residual UP listeners)
 * so a screen that left can start from a clean slate on remount. The shell
 * calls this on unmount.
 */
export function disposePropsChannel(name: string): void {
  channels.delete(name);
}
