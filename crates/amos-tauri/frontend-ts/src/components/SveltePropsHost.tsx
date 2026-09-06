import { useEffect, useRef } from "react";
import { mount, unmount } from "svelte";
import { disposePropsChannel, propsChannel } from "../svelte/propsBus";

export interface SvelteAppLoader {
  (): Promise<{ default: any }>;
}

/**
 * SveltePropsHost — generic React host for a CONTROLLED Svelte screen.
 *
 * Unlike SvelteAppHost (which mounts a self-contained "island" with no props),
 * this host bridges a React-owned, changing props object into a Svelte 5 runes
 * component IN PLACE — without unmounting it — via the shared `propsBus`
 * channel named by `name`. The component's internal $state (e.g. the home icon
 * grid's current page) therefore survives every props change.
 *
 *   • DOWN: each render, host pushes `props` into propsChannel(name).set(...);
 *     the Svelte screen subscribes and re-renders in place.
 *   • UP:   the screen emits one-shot actions over the same channel; the host
 *     forwards each to the `onEvent` callback (React shell owns navigation).
 *
 * `load`/`name` are stable identities; the component is mounted exactly once
 * per (name, load) and torn down on unmount / identity change.
 */
export default function SveltePropsHost({
  name,
  load,
  props,
  onEvent,
  className = "h-full",
}: {
  /** Stable bus key shared with the Svelte screen (e.g. "home"). */
  name: string;
  load: SvelteAppLoader;
  /** Current external props — pushed to the screen on every change. */
  props: Record<string, unknown>;
  /** (event, detail) emitted by the Svelte screen (one-shot actions). */
  onEvent?: (event: string, detail: unknown) => void;
  /** Class on the host div. Overlay chrome (absolute panels) pass "" so the host
   *  adds no block and the Svelte root positions to the phone frame. */
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // DOWN: keep the shared channel's props in sync with what the shell owns.
  useEffect(() => {
    propsChannel(name).set(props);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, props]);

  // Mount the Svelte component once per (name, load); bridge UP events.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let instance: any = null;

    const offUp = propsChannel(name).on((event, detail) => {
      onEventRef.current?.(event, detail);
    });
    // Seed the channel before the component first reads it.
    propsChannel(name).set(props);

    void load().then((mod) => {
      if (disposed) return;
      instance = mount(mod.default, { target: host });
    });

    return () => {
      disposed = true;
      offUp();
      if (instance) unmount(instance);
      instance = null;
      // Drop the named channel so a later remount starts from a clean slate
      // (no stale DOWN state / residual listeners).
      disposePropsChannel(name);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, load]);

  return <div ref={hostRef} className={className} />;
}
