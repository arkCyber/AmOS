<script lang="ts">
  // RecentsPanel.svelte — Svelte 5 (runes) port of the React `SystemPanels`
  // RecentsPanel (a CONTROLLED chrome overlay). The React shell owns whether it is
  // open and pushes `{ open }` down over propsBus "recents"; the panel shows the
  // recently-opened apps (reactive over the shared amos.recents store) and emits
  // 'open'/'close' back to the shell. No internal state to preserve across opens.
  import { t } from "./locale.svelte";
  import { appIcon, appTitleKey } from "../lib/appMeta";
  import { RECENTS_KEY } from "../lib/amosStore";
  import { attachFocusTrap } from "../lib/focusTrap";
  import { propsChannel } from "./propsBus";
  import { createStoreValue } from "./store";
  import AppIcon from "./AppIcon.svelte";

  interface RecentsProps {
    open: boolean;
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

  const recentsStore = createStoreValue<unknown>(RECENTS_KEY, []);
  let raw = $state<unknown>([]);
  $effect(() => {
    const un = recentsStore.subscribe((v) => (raw = v));
    return un;
  });
  const ids = $derived(
    (Array.isArray(raw) ? raw : [])
      .filter((x): x is string => typeof x === "string" && appTitleKey(x) !== null),
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
      <h2 class="text-xl font-semibold tracking-tight">{t("shell.recents")}</h2>
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
            {@const key = appTitleKey(id)}
            {@const label = key ? t(key) : id}
            <button
              onclick={() => choose(id)}
              aria-label={label}
              class="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm transition active:bg-accent/10"
            >
              <AppIcon id={id} icon={appIcon(id)} tileClassName="h-11 w-11 rounded-[12px]" glyphClassName="text-[26px]" />
              <span class="min-w-0 flex-1 truncate font-medium">{label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
