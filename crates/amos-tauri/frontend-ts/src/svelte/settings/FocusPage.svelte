<script lang="ts">
  // FocusPage.svelte — 「专注模式」sub page. Persists per-scenario *intent* (勿扰/
  // 工作/睡眠) through lib/focusPrefs (durable amos.focus); actual silencing still
  // comes from the shell's Do-Not-Disturb quick bit — an honest preference page.
  import { readStoreValue, writeStoreValue } from "../../lib/amosStore";
  import {
    FOCUS_KEY,
    FOCUS_SCENARIOS,
    normalizeFocus,
    toggleFocus,
    type FocusId,
    type FocusPrefs,
  } from "../../lib/focusPrefs";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, SUB, HINT } from "./kit";
  import Switch from "./Switch.svelte";

  const initPrefs = normalizeFocus(readStoreValue<unknown>(FOCUS_KEY, {}));
  let prefs = $state<FocusPrefs>(initPrefs);
  const toggle = (id: FocusId) => {
    const next = toggleFocus(prefs, id);
    prefs = next;
    writeStoreValue(FOCUS_KEY, next);
  };
  const idKey = (id: FocusId): string => {
    switch (id) {
      case "dnd": return "settings.focusDnd";
      case "work": return "settings.focusWork";
      case "sleep": return "settings.focusSleep";
      default: return "settings.focusDnd";
    }
  };
</script>

<section class={GROUP}>
  {#each FOCUS_SCENARIOS as id, i (id)}
    <div class={ROW}>
      <span class={LABEL}>{t(idKey(id))}</span>
      <Switch on={prefs[id]} aria={t(idKey(id))} ontoggle={() => toggle(id)} />
    </div>
    {#if i < FOCUS_SCENARIOS.length - 1}<div class={SUB}></div>{/if}
  {/each}
  <div class="px-4 pb-3">
    <p class={HINT}>{t("settings.focusHint")}</p>
  </div>
</section>
