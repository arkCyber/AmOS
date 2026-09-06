<script lang="ts">
  // CalculatorApp.svelte — Svelte 5 (runes) port of the iOS-style calculator that
  // lives as a React FC in src/apps.tsx. The reduction logic is NOT reimplemented:
  // it reuses the same pure reducer in src/lib/calculator.ts shared by the React
  // UI (single source of truth, already unit-tested there). This component is
  // intentionally React-free; all state is runes ($state/$derived/$effect).

  // Shared, non-reactive constants + colour map (iOS palette). Recreated per
  // component instance — cheap and dependency-free.
  const LAYOUT: string[][] = [
    ["C", "±", "%", "÷"],
    ["7", "8", "9", "×"],
    ["4", "5", "6", "−"],
    ["1", "2", "3", "+"],
    ["0", ".", "="],
  ];
  const OPER = new Set(["÷", "×", "−", "+", "="]);
  const FUNC = new Set(["C", "±", "%"]);
  function keyCls(k: string): string {
    return OPER.has(k)
      ? "bg-[#ff9f0a] text-white" // iOS orange
      : FUNC.has(k)
        ? "bg-[#a5a5a5] text-black" // iOS light-grey functions
        : "bg-[#333] text-white"; // iOS dark-grey digits
  }

  import {
    addHistory,
    calcClearLabel,
    calcEntry,
    calcFontPx,
    calcFromKey,
    calcInit,
    calcPress,
    ERR,
  } from "../lib/calculator";
  import type { CalcEntry } from "../lib/calculator";
  import { t } from "./locale.svelte";
  import { createStoreValue } from "./store";

  // Persisted history — createStoreValue is the Svelte counterpart of React's
  // useStoreValue. Here it's a REAL consumer: history is seeded from and
  // persisted to the shared amos.* store, and stays reactive to any writer, so
  // completed calculations survive closing/reopening the calculator.
  const HISTORY_KEY = "amos.calculator.history";
  function normalizeHistory(v: unknown): CalcEntry[] {
    if (!Array.isArray(v)) return [];
    return (v as CalcEntry[])
      .filter((x) => x && typeof x.expr === "string" && typeof x.result === "string")
      .slice(0, 12);
  }
  const historyStore = createStoreValue<unknown>(HISTORY_KEY, []);


  // No props needed: `t` comes from the shared reactive i18n singleton
  // (locale.svelte.ts), which the React shell keeps in sync via setLocale — so a
  // mid-calculation locale switch re-renders text in place without losing state.

  // --- State (runes) ---
  let st = $state(calcInit());
  let history = $state<CalcEntry[]>([]);
  let showHist = $state(false);

  // Bridge the reactive store into component state (idiomatic runes↔store:
  // $state can't be created dynamically in a function, so a store subscriber
  // drives it; store.start/stop tears listeners down when unmounted).
  $effect(() => {
    const unsub = historyStore.subscribe((v) => {
      history = normalizeHistory(v);
    });
    return unsub;
  });

  // --- Derived (recomputed when st/t change) ---
  const big = $derived(st.cur === ERR ? t("calc.error") : st.cur);
  const operand = $derived(st.acc ? st.acc.trimEnd() : "");
  const isErr = $derived(st.cur === ERR);
  const clearGlyph = $derived(calcClearLabel(st));

  function press(k: string): void {
    if (k === "=") {
      const entry = calcEntry(st); // record the completed computation first
      st = calcPress(st, k);
      if (entry) {
        const next = addHistory(history, entry);
        history = next;
        historyStore.save(next); // persist via the shared store (real consumer)
      }
    } else {
      st = calcPress(st, k);
    }
  }

  // Physical keyboard support (mirrors the React ref listener): installed once,
  // never rebound; $effect owns add/remove lifecycle.
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      const label = calcFromKey(e.key, e.ctrlKey || e.metaKey || e.altKey);
      if (label == null) return;
      e.preventDefault();
      press(label);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<!-- iOS layout: operator column (incl. =) orange, top function row light-grey,
     digits on the dark-grey body. Always a dark surface (like the real app). -->
<div class="flex min-h-full flex-col bg-black text-white">
  <div class="flex justify-end px-4 pt-2">
    <button
      onclick={() => (showHist = !showHist)}
      class="rounded-full px-3 py-1 text-[13px] leading-none transition active:scale-95 {showHist
        ? 'bg-[#ff9f0a] text-white'
        : 'bg-white/10 text-white/70 hover:bg-white/20'}"
    >
      {t("calc.history")}{history.length > 0 ? ` (${history.length})` : ""}
    </button>
  </div>

  <!-- Big iOS-style display region (fills all space above the keypad). -->
  <div class="relative min-h-0 flex-1 px-5">
    {#if showHist}
      {#if history.length > 0}
        <div class="fade-in absolute inset-x-4 top-1 max-h-[70%] overflow-auto rounded-xl bg-white/10 p-2 text-sm backdrop-blur-md">
          {#each history as h, i (i + "-" + h.expr)}
            <div class="flex items-baseline justify-end gap-2 py-0.5">
              <span class="text-white/60">{h.expr} =</span>
              <span class="tabular-nums font-medium text-white">{h.result}</span>
            </div>
          {/each}
          <button
            onclick={() => {
              history = [];
              historyStore.save([]);
            }}
            class="mt-1 w-full rounded-md py-0.5 text-xs text-white/60 hover:text-white"
          >
            {t("calc.clear")}
          </button>
        </div>
      {:else}
        <div class="fade-in absolute inset-x-4 top-1 rounded-xl bg-white/10 p-2 text-center text-xs text-white/70 backdrop-blur-md">
          {t("calc.empty")}
        </div>
      {/if}
    {/if}
    <div class="flex h-full flex-col justify-end pb-2">
      {#if operand}
        <div
          aria-hidden="true"
          class="truncate pb-1 text-right text-2xl font-light tabular-nums text-white/45"
        >
          {operand}
        </div>
      {/if}
      <div
        role="status"
        class="truncate text-right font-thin leading-none tabular-nums"
        style:font-size={isErr ? "40px" : `${calcFontPx(big)}px`}
        style:color={isErr ? "rgb(var(--danger))" : ""}
      >
        {big}
      </div>
    </div>
  </div>

  <!-- Keypad pinned to the bottom, square keys sized by column width. -->
  <div class="px-2 pb-3">
    <div class="grid grid-cols-4 gap-x-3 gap-y-3">
      {#each LAYOUT as row, ri}
        {#each row as k}
          {@const wide = k === "0" && ri === LAYOUT.length - 1}
          {@const glyph = k === "C" ? clearGlyph : k}
          <button
            onclick={() => press(k)}
            aria-label={glyph}
            class="flex select-none items-center rounded-full text-[26px] leading-none transition active:brightness-150 active:scale-95 {wide
              ? 'col-span-2 justify-start pl-8 text-left'
              : 'aspect-square justify-center'} {keyCls(k)}"
          >
            {glyph}
          </button>
        {/each}
      {/each}
    </div>
  </div>
</div>

