<script lang="ts">
  // EditHome.svelte — Svelte 5 (runes) port of the React `EditHome`: the home
  // layout EDITOR shown by the React shell in edit mode.
  //
  // This is a CONTROLLED screen (the second consumer of the shared controlled-
  // screen infra after HomeDock): the React shell owns the layout and pushes it
  // down over propsBus channel "editHome". On each edit the screen does NOT
  // mutate local state — it computes the next layout via the shared pure
  // lib/amosStore helpers (hideFromHome/restoreToHome) and emits it back up
  // ('change'); the shell persists it and re-pushes the new layout in place.
  //
  // Pure logic + icons are REUSED: same lib/amosStore helpers and the same
  // lib/appIcon single source the React EditHome uses.
  import { t } from "./locale.svelte";
  import { appIcon, appTitleKey } from "../lib/appMeta";
  import type { HomeLayout } from "../lib/amosStore";
  import { hideFromHome, restoreToHome } from "../lib/amosStore";
  import { propsChannel } from "./propsBus";
  import AppIcon from "./AppIcon.svelte";

  interface EditProps {
    layout: HomeLayout;
  }
  const bus = propsChannel<EditProps>("editHome");

  let incoming = $state<EditProps | null>(null);
  $effect(() => {
    const un = bus.subscribe((v) => {
      if (v !== undefined) incoming = v;
    });
    return un;
  });
  const EMPTY: HomeLayout = { page: [], dock: [], hidden: [] };
  const layout = $derived(incoming?.layout ?? EMPTY);

  const isBuiltin = (id: string): boolean => appTitleKey(id) !== null;
  const shown = $derived([...layout.page, ...layout.dock].filter(isBuiltin));
  const hiddenShown = $derived(layout.hidden.filter(isBuiltin));

  const label = (id: string): string => {
    const k = appTitleKey(id);
    return k ? t(k) : id;
  };
</script>

<div class="flex h-full flex-col p-4">
  <div class="flex items-center justify-between">
    <p class="text-xs opacity-60">{t("edit.hint")}</p>
    <button
      onclick={() => bus.emit("done")}
      class="rounded-full bg-accent px-4 py-1 text-sm text-white"
    >{t("edit.done")}</button>
  </div>

  <div class="mt-4 flex flex-wrap gap-2">
    {#each shown as id (id)}
      <div class="relative">
        <button
          onclick={() => bus.emit("change", hideFromHome(layout, id))}
          class="group relative block outline-none transition-transform active:scale-90"
          aria-label={`remove ${id}`}
        >
          <AppIcon
            id={id}
            icon={appIcon(id)}
            tileClassName="h-16 w-16 rounded-[21px]"
            glyphClassName="text-[2.5rem]"
          />
        </button>
        <span
          class="absolute -left-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-danger text-xs text-white"
        >✕</span>
        <span class="mt-1 block w-16 truncate text-center text-[10px]">{label(id)}</span>
      </div>
    {/each}
  </div>

  {#if hiddenShown.length > 0}
    <div class="mt-6">
      <p class="text-xs opacity-60">{t("edit.hidden")}</p>
      <div class="mt-2 flex flex-wrap gap-2">
        {#each hiddenShown as id (id)}
          <button
            onclick={() => bus.emit("change", restoreToHome(layout, id))}
            class="flex items-center gap-1 rounded-full bg-neutral-300 px-3 py-1 text-xs dark:bg-neutral-700"
          >＋ {label(id)}</button>
        {/each}
      </div>
    </div>
  {/if}
</div>
