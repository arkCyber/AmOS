<script lang="ts">
  // RecentsPanel.svelte — Svelte 5 (runes) port of the React `SystemPanels`
  // RecentsPanel (a CONTROLLED chrome overlay). The shell owns whether it is
  // open and pushes `{ open }` down over propsBus "recents"; the panel shows the
  // recently-opened apps (reactive over the shared amos.recents store) and emits
  // 'open'/'close' back to the shell. No internal state to preserve across opens.
  import { t } from "./locale.svelte";
  import { appIcon, appTitleKey } from "../lib/appMeta";
  import { type StoreTile } from "../lib/storeApps";
  import { RECENTS_KEY, normalizeRecents } from "../lib/amosStore";
  import { attachFocusTrap } from "../lib/focusTrap";
  import { propsChannel } from "./propsBus";
  import { createStoreValue } from "./store";
  import AppIcon from "./AppIcon.svelte";

  interface RecentsProps {
    open: boolean;
    /** The sheet is being used to **choose an app for a multi-app gesture** rather
     * than to reopen a recent one. `"split"` = pick the second pane of a two-pane
     * surface (REQ-A512); `"slide"` = pick the floating Slide Over panel (REQ-A674).
     * The shell sets this when the matching affordance was tapped, and decides what a
     * pick means. `null`/absent = a plain recents list. */
    pick?: "split" | "slide" | null;
    /** The app already in the primary pane — offering it again would build a split
     * of one app with itself, which is not a split. (A Slide Over panel *may* repeat
     * the app behind it, so the shell passes `null` for the `"slide"` mode.) */
    exclude?: string | null;
    /** Installed store-app tiles, pushed by the shell (the same list the home
     * screen gets) — the picker's second candidate source. See `ids` below. */
    ext?: StoreTile[];
  }
  const bus = propsChannel<RecentsProps>("recents");

  let incoming = $state<RecentsProps | null>(null);
  $effect(() => {
    const un = bus.subscribe((v) => {
      if (v !== undefined) incoming = v;
    });
    return un;
  });
  const open = $derived(incoming?.open ?? false);
  const pick = $derived(incoming?.pick ?? null);
  const exclude = $derived(incoming?.exclude ?? null);

  const recentsStore = createStoreValue<unknown>(RECENTS_KEY, []);
  let raw = $state<unknown>([]);
  $effect(() => {
    const un = recentsStore.subscribe((v) => (raw = v));
    return un;
  });
  // Installed store tiles are the *second* source of choosable apps, and only in
  // pick mode. Recents hold built-ins only on purpose (`open()` keeps third-party
  // ids out of the frequently-used set), but every layer *behind* this picker
  // already accepts a `store:` pane: `open()`'s split retarget, `parseSplit` /
  // `parseSlideOver`'s validation and `AppPane`'s ext host all take one. Offering
  // only recents made the door narrower than the room behind it, so an installed
  // app could never be chosen as the second pane or the Slide Over panel. Kept
  // out of plain recents mode so the App Library's "Frequently Used" is unmoved.
  const ext = $derived(incoming?.ext ?? []);

  const ids = $derived(
    [
      // `normalizeRecents` is the shared shape rule; this picker adds its own predicate on
      // top (only built-ins here — see the note above), which is a *different* rule.
      ...normalizeRecents(raw).filter((x) => appTitleKey(x) !== null),
      ...(pick ? ext.map((e) => e.id) : []),
    ].filter((id) => id !== exclude),
  );

  const close = () => bus.emit("close");
  const choose = (id: string) => {
    bus.emit("open", id);
    bus.emit("close");
  };

  // Keyboard focus trap while the overlay is open (shared lib/focusTrap).
  let rootEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!open || !rootEl) return;
    return attachFocusTrap(rootEl, close);
  });
</script>

{#if open}
  <div
    bind:this={rootEl}
    class="sheet-in absolute inset-0 z-40 flex flex-col bg-white/45 p-4 backdrop-blur-2xl backdrop-saturate-150 dark:bg-neutral-950/60"
  >
    <div class="flex items-center justify-between px-1">
      <h2 class="text-xl font-semibold tracking-tight">
        {pick === "split" ? t("split.pickSecond") : pick === "slide" ? t("slide.pick") : t("shell.recents")}
      </h2>
      <button
        onclick={close}
        class="rounded-full bg-neutral-200/80 px-4 py-1.5 text-sm font-medium text-accent transition active:scale-95 dark:bg-white/10"
      >{t("common.done")}</button>
    </div>
    <div class="mt-3 min-h-0 flex-1 overflow-auto">
      {#if ids.length === 0}
        <p class="py-16 text-center text-sm opacity-50">{t("shell.noRecent")}</p>
      {:else}
        <div class="divide-y divide-black/5 overflow-hidden rounded-2xl bg-white/55 shadow-sm ring-1 ring-black/5 dark:divide-white/5 dark:bg-white/5 dark:ring-white/10">
          {#each ids as id (id)}
            {@const tile = ext.find((e) => e.id === id)}
            {@const key = appTitleKey(id)}
            {@const label = tile?.name ?? (key ? t(key) : id)}
            <button
              onclick={() => choose(id)}
              aria-label={label}
              class="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm transition active:bg-accent/10"
            >
              <AppIcon id={id} icon={tile?.icon ?? appIcon(id)} tileClassName="h-11 w-11 rounded-[12px]" glyphClassName="text-[26px]" />
              <span class="min-w-0 flex-1 truncate font-medium">{label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
