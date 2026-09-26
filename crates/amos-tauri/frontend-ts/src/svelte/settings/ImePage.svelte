<script lang="ts">
  // ImePage.svelte — 「输入法」sub page: the on-screen pinyin keyboard's switch,
  // its fuzzy-pair preferences and the learner reset.
  //
  // It drives the **same** engine bridge as the keyboard itself (`lib/ime`), so the
  // two surfaces cannot drift: the switch writes the same `amos-ui.ime` preference
  // the keyboard reads, **and this page listens for that store change too** — so the
  // keyboard's own 「关闭输入法」 button is reflected here live, not only the other way
  // round. Every preference goes through the same `ime_*` commands.
  //
  // Honest states: with no engine (browser preview / a build without the daemon)
  // the engine-dependent controls are **absent**, not silently inert, and the page
  // says why.
  import {
    IME_ENABLED_KEY,
    IME_FUZZY_PAIRS,
    imeFuzzyPreset,
    imeFuzzyToggle,
    imeLearningClear,
    imeStatus,
    readImeEnabled,
    writeImeEnabled,
    type ImeState,
  } from "../../lib/ime";
  import { STORE_CHANGED_EVENT } from "../../lib/amosStore";
  import { onMount } from "svelte";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, HINT, SUB } from "./kit";
  import ToggleRow from "./ToggleRow.svelte";
  import StoreErrorBar from "../StoreErrorBar.svelte";

  let enabled = $state(readImeEnabled());
  let engine = $state<ImeState | null>(null);
  /**
   * The store's refusal of this page's own switch (REQ-A1432). The switch **is** the success
   * report — it shows the value just written — so it may not move when the write was refused.
   * Its own sentence is said here, next to the control that carries it.
   */
  let storeErr = $state("");
  /** The readout the last command answered with; `null` until the engine replies. */
  let asked = $state(false);
  // "Forget every learned word" cannot be undone, so it asks once.
  let confirmClear = $state(false);

  const learned = $derived((engine?.learned_pins ?? 0) + (engine?.learned_pending ?? 0));

  function apply(next: ImeState | null): void {
    asked = true;
    engine = next;
  }

  function toggleEnabled(): void {
    const next = !enabled;
    // The switch only moves once the preference has landed: it draws the value just written,
    // and a refused `setItem` leaves `amos-ui.ime` on the old one (REQ-A1432).
    if (!writeImeEnabled(next)) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    enabled = next;
  }

  function togglePair(pair: string): void {
    void imeFuzzyToggle(pair).then(apply);
  }

  function preset(name: string): void {
    void imeFuzzyPreset(name).then(apply);
  }

  function askClear(): void {
    if (!confirmClear) {
      confirmClear = true;
      return;
    }
    confirmClear = false;
    void imeLearningClear().then(apply);
  }

  onMount(() => {
    void imeStatus().then(apply);
    // The keyboard owns the **same** preference and can flip it from its own panel
    // (`关闭输入法`). Without this listener the page would only be right until the
    // other surface moved the switch — the docs promise the two agree *live*, so
    // the page listens to the same store change the keyboard does.
    const onStore = (e: Event) => {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key;
      if (key !== IME_ENABLED_KEY) return;
      // This event is dispatched **only after** a write landed, so the store has just proved
      // itself writable: the refusal sentence describes a condition that no longer holds
      // (the same reason `RadioPage`'s `saveCfg` clears its own refusal on success).
      storeErr = "";
      enabled = readImeEnabled();
    };
    window.addEventListener(STORE_CHANGED_EVENT, onStore);
    return () => window.removeEventListener(STORE_CHANGED_EVENT, onStore);
  });
</script>

<section class={GROUP}>
  <ToggleRow
    label={t("settings.imeKeyboard")}
    on={enabled}
    ontoggle={toggleEnabled}
  />
  {#if storeErr}
    <!-- 渲染在**它自己的控件那一块**里（这里是那个开关的正下方），不是页面别处：一条用户
         接不到刚按下的那个开关上的拒绝，读起来就是「什么也没发生」（F-SH-270 的形状）。 -->
    <div class="px-4 pb-3" data-testid="settings-ime-store-error">
      <StoreErrorBar message={storeErr} />
    </div>
  {/if}
</section>
<div class="px-1">
  <p class={HINT}>{t("settings.imeHint")}</p>
</div>

<section class={GROUP}>
  <div class={ROW}>
    <span class={LABEL}>{t("ime.fuzzyTitle")}</span>
    <span class="text-[13px] opacity-50" data-testid="settings-ime-mode">
      {#if engine}
        {engine.strict ? t("ime.presetStrict") : t("ime.fuzzyCustom")}
      {/if}
    </span>
  </div>
  {#if engine}
    <div class="flex flex-wrap gap-1.5 px-4 pb-3">
      {#each IME_FUZZY_PAIRS as pair (pair)}
        <button
          type="button"
          aria-pressed={engine.fuzzy[pair]}
          data-testid="settings-ime-pair-{pair}"
          onclick={() => togglePair(pair)}
          class={"rounded-full px-2.5 py-1 text-xs " +
            (engine.fuzzy[pair] ? "bg-accent text-white" : "bg-black/5 dark:bg-white/10")}
        >
          {t(`ime.fuzzy.${pair}`)}
        </button>
      {/each}
    </div>
    <div class={SUB}></div>
    <div class="flex items-center gap-2 px-4 py-3">
      <button
        type="button"
        data-testid="settings-ime-strict"
        onclick={() => preset("strict")}
        class="rounded-full bg-black/5 px-3 py-1 text-xs dark:bg-white/10"
      >
        {t("ime.presetStrict")}
      </button>
      <button
        type="button"
        data-testid="settings-ime-permissive"
        onclick={() => preset("permissive")}
        class="rounded-full bg-black/5 px-3 py-1 text-xs dark:bg-white/10"
      >
        {t("ime.presetPermissive")}
      </button>
    </div>
    <div class={SUB}></div>
    <div class={ROW}>
      <span class="text-[13px] opacity-60" data-testid="settings-ime-dict">
        {t("ime.dictEntries", { n: engine.dict_entries })}
      </span>
      <span class="text-[13px] opacity-60">{t("ime.learned", { n: learned })}</span>
    </div>
    <div class={SUB}></div>
    <div class={ROW}>
      <span class={LABEL}>{t("ime.clearLearning")}</span>
      <button
        type="button"
        data-testid="settings-ime-forget"
        aria-pressed={confirmClear}
        onclick={askClear}
        class={"rounded-full px-3 py-1 text-xs " +
          (confirmClear ? "bg-red-600 text-white" : "bg-black/5 dark:bg-white/10")}
      >
        {confirmClear ? t("ime.clearLearningConfirm") : t("ime.clearLearning")}
      </button>
    </div>
  {:else if asked}
    <div class="px-4 pb-3">
      <p class={HINT} data-testid="settings-ime-offline">
        {t("settings.imeEngineOff")}
      </p>
    </div>
  {/if}
</section>
