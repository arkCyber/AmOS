import { useEffect, useRef } from "react";
import { mount, unmount } from "svelte";
import { useI18n } from "../i18n";
import { SVELTE_LOCALE_EVENT } from "../svelte/locale-events";

export interface SvelteAppLoader {
  (): Promise<{ default: any }>;
}

/**
 * Generic React host that mounts a Svelte 5 app inside the React shell — the
 * coexistence seam shared by every migrated screen (calculator, weather, …).
 *
 * The `.svelte` module is loaded only via the dynamic `load()` the host renders
 * (i.e. production builds). The happy-dom tests run under `bun` (no `.svelte`
 * loader) and keep each React fallback, so no Svelte chunk — and no runes
 * `.svelte.ts` module — is ever loaded on their import graph.
 *
 * i18n: Svelte apps read the shared reactive locale singleton (locale.svelte.ts).
 * This host can't import that runes file under bun, so instead it broadcasts the
 * shell's locale as a window event the singleton listens for. On first mount the
 * singleton already has the right locale because React persists `amos-ui.locale`.
 */
export default function SvelteAppHost({
  load,
  className = "h-full",
}: {
  load: SvelteAppLoader;
  /** Class on the host div. Default "h-full" suits full-screen islands; shell
   *  chrome islands that must size inline (e.g. StatusBar) pass "" so they do
   *  not force a 100%-height block into a flex row/column. */
  className?: string;
}) {
  const { locale: shellLocale } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Tell the (already-loaded) Svelte i18n singleton to re-key on locale change.
  // With the React fallback / under bun there is no Svelte mounted — no-op there.
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent(SVELTE_LOCALE_EVENT, { detail: shellLocale }));
    } catch {
      /* ignore */
    }
  }, [shellLocale]);

  // Mount the Svelte component once per loader identity.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let instance: any = null;

    void load().then((mod) => {
      if (disposed) return;
      instance = mount(mod.default, {
        target: host,
      });
    });

    return () => {
      disposed = true;
      if (instance) unmount(instance);
      instance = null;
    };
  }, [load]);

  return <div ref={hostRef} className={className} />;
}

