<script lang="ts">
  // ImeKeyboard.svelte — the on-screen pinyin keyboard's *presentation*.
  //
  // Deliberately dumb: it renders the candidate bar + key grid + the fuzzy-pair
  // settings panel and calls back for every user action. All session state (the
  // pinyin buffer, the candidates, the learner) lives in the Rust engine behind
  // `lib/ime`, and all *behavior* (where committed text goes, which field is
  // focused) lives in `ImeOverlay.svelte`. That keeps this file testable by
  // clicking, with no backend.
  //
  // `state` is `null` when the host bridge is unavailable (browser preview / a build
  // without the daemon): the keys still render, so the honest message is shown
  // instead of a blank keyboard.
  import {
    IME_CANDIDATE_PAGE_SIZE,
    IME_FUZZY_PAIRS,
    IME_LETTER_ROWS,
    IME_SYMBOL_ROWS,
    candidatePageCount,
    pageCandidates,
    type ImeState,
  } from "../lib/ime";
  import { t } from "./locale.svelte";

  let {
    session,
    online,
    error,
    mode,
    page,
    settingsOpen,
    onkey,
    onbackspace,
    onclear,
    oncommit,
    onpage,
    onmode,
    onhide,
    onsettings,
    onpreset,
    onfuzztoggle,
    onlearnclear,
    ondisable,
    onforget,
  }: {
    session: ImeState | null;
    online: boolean;
    /** The last command never reached the engine — say so instead of doing nothing. */
    error: boolean;
    mode: "zh" | "en";
    page: number;
    settingsOpen: boolean;
    onkey: (ch: string) => void;
    onbackspace: () => void;
    onclear: () => void;
    oncommit: (index: number) => void;
    onpage: (page: number) => void;
    onmode: (mode: "zh" | "en") => void;
    onhide: () => void;
    onsettings: () => void;
    onpreset: (preset: string) => void;
    onfuzztoggle: (pair: string) => void;
    onlearnclear: () => void;
    /** Turn the whole input method off (persisted) — the keyboard's own way out. */
    ondisable: () => void;
    /** Undo the just-committed dictionary word (drops its learned pin). */
    onforget: () => void;
  } = $props();

  // Which key page is showing (letters vs digits/punctuation). Purely local layout.
  let symbols = $state(false);
  // One-shot shift: applies to the *next* letter, and only in English mode — pinyin
  // is case-insensitive, so a shifted pinyin key would claim a difference that does
  // not exist.
  let shift = $state(false);
  // "Forget all learned words" destroys data and cannot be undone, so it asks once
  // before doing it (and lets go of the question when the panel closes).
  let confirmClear = $state(false);
  const rows = $derived(symbols ? IME_SYMBOL_ROWS : IME_LETTER_ROWS);
  const upper = $derived(mode === "en" && shift && !symbols);
  const candidates = $derived(session?.candidates ?? []);
  const pages = $derived(candidatePageCount(candidates.length));
  // The page actually on screen. The `page` *prop* can briefly point past the end
  // (the overlay pages forward), and everything user-visible — the slice, the
  // label and the index a candidate reports — must agree on one clamped page,
  // otherwise a visible candidate would report an index that commits nothing.
  const current = $derived(Math.min(Math.max(0, page), pages - 1));
  const visible = $derived(pageCandidates(candidates, current));
  // 联想: the engine's next-word suggestions for what this window has committed.
  // They arrive as candidates of kind "predict" **with an empty buffer** (the host
  // composes both lists into one index space), so the bar below shows when either
  // source has something to offer.
  const suggesting = $derived(candidates.some((c) => c.kind === "predict"));
  const learned = $derived((session?.learned_pins ?? 0) + (session?.learned_pending ?? 0));

  // A one-shot modifier must not outlive the mode it belongs to: leaving English
  // mode drops the arm, so a stale ⇧ can never uppercase the first letter after the
  // user comes back. (In Chinese mode the key is not offered at all — see below —
  // so the arm can only ever be set where it works.)
  $effect(() => {
    if (mode !== "en") shift = false;
  });

  /** Report a tap, applying the one-shot shift and letting go of it immediately. */
  function tap(glyph: string): void {
    onkey(upper ? glyph.toUpperCase() : glyph);
    if (upper) shift = false;
  }

  /** Ask once, then forget everything the learner knows. */
  function askClearLearning(): void {
    if (confirmClear) {
      confirmClear = false;
      onlearnclear();
      return;
    }
    confirmClear = true;
  }

  // A question left hanging is not a question: closing the panel drops it.
  $effect(() => {
    if (!settingsOpen) confirmClear = false;
  });
</script>

<div
  class="pointer-events-auto w-full select-none border-t border-black/10 bg-neutral-200/95 text-neutral-900 backdrop-blur-md dark:border-white/10 dark:bg-neutral-800/95 dark:text-neutral-100"
  data-testid="ime-keyboard"
  aria-label={t("ime.title")}
>
  {#if settingsOpen}
    <!-- Fuzzy-pair settings: the nine toggles + presets + the learner reset. -->
    <div class="space-y-2 px-3 py-2" data-testid="ime-settings-panel">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-semibold">{t("ime.fuzzyTitle")}</span>
        <span
          class="rounded-full bg-white/70 px-2 py-0.5 text-[11px] dark:bg-white/10"
          data-testid="ime-mode-summary"
        >
          {session?.strict ? t("ime.presetStrict") : t("ime.fuzzyCustom")}
        </span>
      </div>
      <div class="flex items-center justify-between gap-2 text-[11px] opacity-60">
        <span data-testid="ime-dict-entries">
          {t("ime.dictEntries", { n: session?.dict_entries ?? 0 })}
        </span>
        <span>{t("ime.learned", { n: learned })}</span>
      </div>
      <div class="flex flex-wrap gap-1.5">
        {#each IME_FUZZY_PAIRS as pair (pair)}
          <button
            type="button"
            aria-pressed={!!session?.fuzzy[pair]}
            data-testid="ime-fuzzy-{pair}"
            onclick={() => onfuzztoggle(pair)}
            class={"rounded-full px-2.5 py-1 text-xs " +
              (session?.fuzzy[pair]
                ? "bg-accent text-white"
                : "bg-white/70 text-neutral-700 dark:bg-white/10 dark:text-neutral-200")}
          >
            {t(`ime.fuzzy.${pair}`)}
          </button>
        {/each}
      </div>
      <div class="flex items-center gap-1.5">
        <button
          type="button"
          data-testid="ime-preset-strict"
          onclick={() => onpreset("strict")}
          class="rounded-full bg-white/70 px-2.5 py-1 text-xs dark:bg-white/10"
        >
          {t("ime.presetStrict")}
        </button>
        <button
          type="button"
          data-testid="ime-preset-permissive"
          onclick={() => onpreset("permissive")}
          class="rounded-full bg-white/70 px-2.5 py-1 text-xs dark:bg-white/10"
        >
          {t("ime.presetPermissive")}
        </button>
        <button
          type="button"
          data-testid="ime-learn-clear"
          aria-pressed={confirmClear}
          onclick={askClearLearning}
          class={"ml-auto rounded-full px-2.5 py-1 text-xs " +
            (confirmClear ? "bg-red-600 text-white" : "bg-white/70 dark:bg-white/10")}
        >
          {confirmClear ? t("ime.clearLearningConfirm") : t("ime.clearLearning")}
        </button>
      </div>
      <div class="flex justify-end">
        <button
          type="button"
          data-testid="ime-disable"
          onclick={ondisable}
          class="rounded-full px-2.5 py-1 text-[11px] text-red-600 dark:text-red-400"
        >
          {t("ime.toggleOff")}
        </button>
      </div>
    </div>
  {:else}
    {#if error}
      <!-- A tap the engine never saw: visible, not swallowed. -->
      <div
        class="border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-700 dark:text-red-300"
        data-testid="ime-bridge-error"
      >
        {t("ime.bridgeError")}
      </div>
    {/if}
    <!-- Candidate bar: the raw pinyin + the engine's candidates (paged), or — with
         an empty buffer — the 联想 suggestions for what this window committed. -->
    {#if session?.composing || suggesting}
      <div
        class="flex items-center gap-2 border-b border-black/10 px-2 py-1.5 dark:border-white/10"
        data-testid="ime-composition"
      >
        {#if session?.composing}
          <button
            type="button"
            aria-label={t("ime.clear")}
            data-testid="ime-composition-clear"
            onclick={onclear}
            class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/70 text-sm dark:bg-white/10"
          >
            ✕
          </button>
          <span class="shrink-0 font-mono text-sm tracking-wide" data-testid="ime-input">{session.input}</span>
        {/if}
        {#if visible.length > 0}
          <div class="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {#each visible as c, i (c.text + i)}
              <button
                type="button"
                data-testid="ime-candidate"
                onclick={() => oncommit(current * IME_CANDIDATE_PAGE_SIZE + i)}
                class="shrink-0 rounded-lg bg-white px-3 py-1 text-[15px] shadow-sm dark:bg-neutral-700"
              >
                {c.text}{#if c.kind === "sentence"}<span class="ml-1 align-middle text-[10px] opacity-60">{t("ime.sentence")}</span>{:else if c.kind === "predict"}<span class="ml-1 align-middle text-[10px] opacity-60" data-testid="ime-predict-tag">{t("ime.predict")}</span>{/if}
              </button>
            {/each}
          </div>
        {:else}
          <span class="min-w-0 flex-1 truncate text-xs opacity-60" data-testid="ime-no-candidates">
            {t("ime.empty")}
          </span>
        {/if}
        {#if pages > 1}
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label={t("ime.prevPage")}
              data-testid="ime-page-prev"
              disabled={current === 0}
              onclick={() => onpage(current - 1)}
              class={"grid h-8 w-8 place-items-center rounded-full bg-white/70 dark:bg-white/10" +
                (current === 0 ? " opacity-30" : "")}
            >
              ‹
            </button>
            <span class="text-[10px] opacity-70" data-testid="ime-page">
              {t("ime.page", { n: current + 1, total: pages })}
            </span>
            <button
              type="button"
              aria-label={t("ime.nextPage")}
              data-testid="ime-page-next"
              disabled={current >= pages - 1}
              onclick={() => onpage(current + 1)}
              class={"grid h-8 w-8 place-items-center rounded-full bg-white/70 dark:bg-white/10" +
                (current >= pages - 1 ? " opacity-30" : "")}
            >
              ›
            </button>
          </div>
        {/if}
      </div>
    {:else if session?.last_committed}
      <!-- Feedback that a commit happened, plus the only per-word undo there is.
           The undo is offered **only** for a dictionary pick: a sentence
           composition never taught the learner anything, so a button there would
           do nothing. -->
      <div
        class="flex items-center gap-2 border-b border-black/10 px-2 py-1.5 dark:border-white/10"
        data-testid="ime-last-committed"
      >
        <span class="truncate text-xs opacity-70">
          {t("ime.lastCommitted", { word: session.last_committed ?? "" })}
        </span>
        {#if session.last_pick_code}
          <button
            type="button"
            data-testid="ime-forget"
            onclick={onforget}
            class="ml-auto shrink-0 rounded-full bg-white/70 px-2.5 py-0.5 text-xs dark:bg-white/10"
          >
            {t("ime.forget")}
          </button>
        {/if}
      </div>
    {:else if !online}
      <div
        class="border-b border-black/10 px-3 py-1.5 text-xs opacity-70 dark:border-white/10"
        data-testid="ime-offline"
      >
        {t("ime.offline")}
      </div>
    {/if}
  {/if}

  <!-- Key grid (letters by default, digits/punctuation on the `?123` page). -->
  {#if !settingsOpen}
    <div class="space-y-1.5 px-1 pt-2">
    {#each rows as row, ri (ri)}
      <div class="flex justify-center gap-1">
        {#each row as glyph (glyph)}
          <button
            type="button"
            data-testid="ime-key-{glyph}"
            onclick={() => tap(glyph)}
            class="h-9 min-w-[30px] flex-1 rounded-md bg-white text-[15px] shadow-sm dark:bg-neutral-700"
          >
            {upper ? glyph.toUpperCase() : glyph}
          </button>
        {/each}
      </div>
    {/each}
    <div class="flex items-center gap-1">
      <button
        type="button"
        data-testid="ime-shift"
        aria-label={t("ime.shift")}
        aria-pressed={shift}
        disabled={mode !== "en"}
        onclick={() => (shift = !shift)}
        class={"h-9 w-12 rounded-md text-base shadow-sm " +
          (shift
            ? "bg-white text-neutral-900 dark:bg-neutral-100 dark:text-neutral-900"
            : "bg-white/70 dark:bg-white/10") +
          (mode === "en" ? "" : " opacity-30")}
      >
        ⇧
      </button>
      <button
        type="button"
        data-testid="ime-symbols"
        aria-label={symbols ? t("ime.letters") : t("ime.symbols")}
        onclick={() => (symbols = !symbols)}
        class="h-9 w-12 rounded-md bg-white/70 text-xs shadow-sm dark:bg-white/10"
      >
        {symbols ? t("ime.letters") : t("ime.symbols")}
      </button>
      <button
        type="button"
        data-testid="ime-mode"
        aria-label={mode === "zh" ? t("ime.modeZh") : t("ime.modeEn")}
        disabled={!online}
        onclick={() => onmode(mode === "zh" ? "en" : "zh")}
        class={"h-9 w-12 rounded-md bg-white/70 text-xs font-semibold shadow-sm dark:bg-white/10" +
          (online ? "" : " opacity-30")}
      >
        {mode === "zh" ? t("ime.modeZh") : t("ime.modeEn")}
      </button>
      <button
        type="button"
        aria-label={t("ime.space")}
        data-testid="ime-space"
        onclick={() => onkey(" ")}
        class="h-9 flex-1 rounded-md bg-white text-lg shadow-sm dark:bg-neutral-700"
      >
        {t("ime.space")}
      </button>
      <button
        type="button"
        aria-label={t("ime.backspace")}
        data-testid="ime-backspace"
        onclick={onbackspace}
        class="h-9 w-14 rounded-md bg-white/70 text-base shadow-sm dark:bg-white/10"
      >
        ⌫
      </button>
      <button
        type="button"
        aria-label={t("ime.enter")}
        data-testid="ime-enter"
        onclick={() => onkey("\n")}
        class="h-9 w-14 rounded-md bg-accent text-base text-white shadow-sm"
      >
        ⏎
      </button>
    </div>
  </div>

  <!-- Toolbar: settings + hide. -->
  <div class="flex items-center justify-between px-2 pb-2 pt-1.5 text-xs">
    <button
      type="button"
      aria-label={t("ime.settings")}
      data-testid="ime-settings"
      disabled={!online}
      onclick={onsettings}
      class={"rounded-full bg-white/70 px-2.5 py-1 dark:bg-white/10" + (online ? "" : " opacity-30")}
    >
      ⚙ {t("ime.settings")}
    </button>
    <button
      type="button"
      aria-label={t("ime.hide")}
      data-testid="ime-hide"
      onclick={onhide}
      class="rounded-full bg-white/70 px-2.5 py-1 dark:bg-white/10"
    >
      ⌄
    </button>
  </div>
  {/if}
</div>
