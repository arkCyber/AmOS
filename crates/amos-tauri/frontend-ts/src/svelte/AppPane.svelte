<script lang="ts">
  // AppPane.svelte — one mounted app screen, with its chrome (REQ-A512).
  //
  // Extracted from `Shell.svelte`'s app surface so the **single-app** surface and
  // **each half** of a tablet split render the *same* component: the header, the
  // scroll host, the external-app host and the honest "unavailable" panel cannot
  // drift between the two carryings. The pane owns loading its own screen (keyed on
  // `id`), which is also what lets two different apps be mounted at once — the old
  // shell held one `AppComp` state and could only ever show one app.
  //
  // `variant`:
  //   * `full` — the shell's whole app surface: system StatusBar, home indicator.
  //   * `pane` — one half of a split: no StatusBar (the shell draws one for the
  //     whole screen), no home indicator (the shell owns the way home); the header
  //     carries a close control for *this* pane instead.
  import { t } from "./locale.svelte";
  import { appTitleKey, isKnownApp } from "../lib/appMeta";
  import { isExtId, midOf, tileById } from "../lib/storeApps";
  import { svelteAppLoader } from "./appRegistry";
  import { deviceChrome } from "../lib/formLayout";
  import StatusBar from "./StatusBar.svelte";
  import { dragSession } from "./dragSession.svelte";
  import ExtAppHost from "./ExtAppHost.svelte";
  import type { FormFactor } from "../lib/wm";
  import type { Snippet } from "svelte";

  let {
    id,
    form,
    variant = "full",
    paneLabel,
    onback,
    onclosepane,
    trailing,
  }: {
    id: string;
    form: FormFactor;
    variant?: "full" | "pane";
    /** Accessible name of this pane (`pane` variant), e.g. "Primary pane". */
    paneLabel?: string;
    onback: () => void;
    onclosepane?: () => void;
    trailing?: Snippet;
  } = $props();

  const chrome = $derived(deviceChrome(form));
  const isPane = $derived(variant === "pane");

  // Cross-app drag & drop (REQ-A683): this pane is a drop target. It reads the one
  // global drag session and marks itself only when *it* is the pane under the pointer
  // — `accept` (this app can take the payload) vs `reject` (it cannot, or the drag
  // came from here) drive two distinct ring styles, so a drop that would do nothing
  // never looks like one that would.
  const drag = $derived(dragSession());
  const dropState = $derived(
    drag && drag.overAppId === id ? (drag.resolution.kind === "accept" ? "accept" : "reject") : null,
  );

  function appTitle(which: string): string {
    // A store-installed tile carries its own (manifest) name; it has no i18n key.
    const tile = tileById(which);
    if (tile) return tile.name;
    const key = appTitleKey(which);
    return key ? t(key) : which;
  }

  // Load + mount this pane's app screen by `id` (React-free registry). There are three
  // states and conflating any two of them is a defect this component shipped:
  //   • a component for **this** id → mount it;
  //   • the loader answered "none" → say so (`app.screenMissing` / `app.unknown`);
  //   • still fetching it → say *that*.
  // The old shape had one `AppComp` for all three, so (a) a component left over from the
  // previous id stayed on screen — open Photos, then pick Clock from Recents and you read
  // Photos' UI under a 时钟 header, for as long as Clock's chunk took to arrive (the
  // desktop-window twin `DesktopAppWindow` already clears it, which is how the divergence
  // is visible), and (b) `AppComp === null` read as "this build has no such screen" for
  // the whole duration of every cold load: the pane asserted `app.screenMissing` about an
  // app whose screen was merely not here yet.
  let AppComp = $state<any>(null);
  /** The loader for the current `id` has settled **without** a component (no loader for
   * this id/form factor, a rejected import, or a module with no default export). Only
   * then may the pane claim there is no screen — and only then is it not still loading. */
  let noScreen = $state(false);
  $effect(() => {
    const which = id;
    const load = svelteAppLoader(which);
    // Nothing from a previous id survives this pass, however slow this id's chunk is.
    AppComp = null;
    noScreen = false;
    if (!load) {
      noScreen = true;
      return;
    }
    let alive = true;
    load().then(
      (m) => {
        if (!alive) return;
        // A module with no default export is not a screen: "missing" is a truer answer
        // than waiting forever on a promise that has already settled.
        if (m.default) AppComp = m.default;
        else noScreen = true;
      },
      () => {
        if (alive) noScreen = true;
      },
    );
    return () => {
      alive = false;
    };
  });
</script>

<div
  role={isPane ? "group" : undefined}
  aria-label={isPane ? paneLabel : undefined}
  class="flex h-full w-full flex-col text-neutral-900 dark:text-neutral-100 {dropState === 'accept'
    ? 'ring-2 ring-inset ring-accent'
    : dropState === 'reject'
      ? 'ring-2 ring-inset ring-danger/60'
      : ''}"
  data-testid={isPane ? "app-pane" : "app-surface"}
  data-pane-app={isPane ? id : undefined}
  data-drop-app={id}
  data-drop-state={dropState ?? undefined}
>
  {#if !isPane}
    <StatusBar {form} />
  {/if}
  <div
    class="flex items-center justify-between border-b border-neutral-200/70 bg-white/50 px-3 py-3 backdrop-blur-md dark:border-neutral-800 dark:bg-white/5"
  >
    <button
      onclick={onback}
      aria-label={t("a11y.back")}
      class="-ml-1 grid h-11 w-11 cursor-pointer place-items-center rounded-full text-accent text-[17px] font-semibold transition active:bg-black/5 dark:active:bg-white/10"
    >‹</button>
    <span class="flex-1 truncate text-center text-[17px] font-semibold tracking-tight">{appTitle(id)}</span>
    {#if trailing}
      {@render trailing()}
    {:else if isPane && onclosepane}
      <button
        onclick={onclosepane}
        aria-label={t("a11y.splitClosePane")}
        class="grid h-11 w-11 cursor-pointer place-items-center rounded-full text-[17px] font-semibold text-neutral-500 transition active:bg-black/5 dark:text-neutral-400 dark:active:bg-white/10"
      >✕</button>
    {:else}
      <span class="w-10"></span>
    {/if}
  </div>
  <!-- The app host is the ScrollView: content-flow apps (Settings, Phone,
       Photos, Clock…) grow past the viewport and scroll here. Without
       overflow-y-auto they'd clip on device (content below unreachable). -->
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    {#key id}
      {#if isExtId(id)}
        <!-- A store-installed app has no local Svelte screen: it runs its
             own web-bundle at its own origin on the `amos-app://` protocol.
             The host resolves the entry URL from Rust (which also proves
             the app is installed and its entry is servable) and says why
             when it cannot. -->
        <ExtAppHost mid={midOf(id)} name={appTitle(id)} />
      {:else if AppComp}
        <AppComp />
      {:else if noScreen}
        <!-- An id with no mounted screen (a built-in whose loader is absent
             in this build, or an unknown id from a link/layout): never a
             blank frame. `isKnownApp` separates the two honestly. Reached only
             once the loader has settled **without** a component — while it is
             still fetching, the branch below says *that*. -->
        <div
          data-testid="app-unavailable"
          class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center"
        >
          <span class="text-3xl" aria-hidden="true">❓</span>
          <p class="text-sm font-semibold">{appTitle(id)}</p>
          <p class="text-xs opacity-60">
            {isKnownApp(id) ? t("app.screenMissing", { id }) : t("app.unknown", { id })}
          </p>
        </div>
      {:else}
        <!-- A loader exists for this id and its chunk has not landed yet. This
             is **not** the same fact as "there is no screen": asserting
             `app.screenMissing` here told the user a built-in had no screen for
             the whole ~200-500 ms of every cold load, and a fast switcher read
             it on every app they opened. `role="status"` so a screen reader is
             told the pane is working, not empty. -->
        <div
          data-testid="app-loading"
          role="status"
          class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center"
        >
          <span class="text-2xl opacity-60" aria-hidden="true">⋯</span>
          <p class="text-xs opacity-60">{t("app.loading")}</p>
        </div>
      {/if}
    {/key}
  </div>
  <!-- Home affordance. On a **touch** class this is the iOS home-indicator bar
       (its gesture bar). A macOS window has no such gesture → the bar is not
       drawn there; the way back is the toolbar's back control above (plus Esc,
       plus the hardware/NC surfaces) — see `lib/formLayout::deviceChrome`. -->
  {#if !isPane && chrome.homeIndicator}
    <div class="flex justify-center pb-2 pt-1">
      <button
        aria-label={t("a11y.home")}
        data-testid="home-indicator"
        title={t("a11y.home")}
        onclick={onback}
        class="grid w-40 cursor-pointer place-items-center py-2"
      >
        <span class="block h-1.5 w-16 rounded-full bg-neutral-800/80 ring-1 ring-white/10 dark:bg-neutral-200/90 dark:ring-black/10"></span>
      </button>
    </div>
  {/if}
</div>
