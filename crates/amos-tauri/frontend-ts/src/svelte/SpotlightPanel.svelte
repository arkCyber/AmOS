<script lang="ts">
  // SpotlightPanel.svelte — Svelte 5 (runes) port of the React `SystemPanels`
  // SpotlightPanel (a CONTROLLED chrome overlay). The shell owns `open` and pushes
  // it over propsBus "spotlight"; search text is LOCAL state (persists across
  // opens like React), and choosing a result emits 'open'(id)+'close'.
  import { t } from "./locale.svelte";
  import { APP_META, appIcon } from "../lib/appMeta";
  import { attachFocusTrap } from "../lib/focusTrap";
  import { propsChannel } from "./propsBus";
  import AppIcon from "./AppIcon.svelte";

  interface SpotlightProps {
    open: boolean;
  }
  const bus = propsChannel<SpotlightProps>("spotlight");

  let incoming = $state<SpotlightProps | null>(null);
  $effect(() => {
    const un = bus.subscribe((v) => {
      if (v !== undefined) incoming = v;
    });
    return un;
  });
  const open = $derived(incoming?.open ?? false);

  let q = $state("");
  let inputEl: HTMLInputElement | undefined = $state();

  // Focus the search field when the sheet opens (summons the OS keyboard). A plain
  // autoFocus is not enough because the opening tap keeps focus on the trigger.
  $effect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputEl?.focus());
    return () => cancelAnimationFrame(id);
  });

  const needle = $derived(q.trim().toLowerCase());
  const hits = $derived(
    needle
      ? APP_META.filter(
          (a) => t(a.titleKey).toLowerCase().includes(needle) || a.id.includes(needle),
        ).slice(0, 12)
      : APP_META.slice(0, 12),
  );

  const close = () => bus.emit("close");
  const choose = (id: string) => {
    bus.emit("open", id);
    bus.emit("close");
  };

  // Keyboard focus trap while open (shared lib/focusTrap). Tab wraps
  // inside the sheet; Escape closes. The search field keeps its own rAF focus.
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
      <h2 class="text-xl font-semibold tracking-tight">{t("shell.search")}</h2>
      <button
        onclick={close}
        class="rounded-full bg-neutral-200/80 px-4 py-1.5 text-sm font-medium text-accent transition active:scale-95 dark:bg-white/10"
      >{t("common.done")}</button>
    </div>
    <input
      bind:this={inputEl}
      bind:value={q}
      placeholder={t("shell.searchPh")}
      class="mt-3 w-full rounded-full bg-white/70 px-4 py-2.5 text-sm text-neutral-900 shadow-sm ring-1 ring-black/5 outline-none placeholder:text-black/30 dark:bg-white/10 dark:text-white dark:ring-white/10 dark:placeholder:text-white/30"
    />
    <div class="mt-3 min-h-0 flex-1 overflow-auto">
      {#if hits.length === 0}
        <p class="py-16 text-center text-sm opacity-50">{t("shell.noMatch")}</p>
      {:else}
        <div class="divide-y divide-black/5 overflow-hidden rounded-2xl bg-white/55 shadow-sm ring-1 ring-black/5 dark:divide-white/5 dark:bg-white/5 dark:ring-white/10">
          {#each hits as a (a.id)}
            <button
              onclick={() => choose(a.id)}
              aria-label={t(a.titleKey)}
              class="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm transition active:bg-accent/10"
            >
              <AppIcon id={a.id} icon={appIcon(a.id)} tileClassName="h-11 w-11 rounded-[12px]" glyphClassName="text-[26px]" />
              <span class="min-w-0 flex-1 truncate font-medium">{t(a.titleKey)}</span>
              <span class="text-xs text-accent">⌘↵</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
