<script lang="ts">
  // FocusPage.svelte — 「专注模式」sub page.
  //
  // REQ-A206: the 勿扰 row is **the real Do-Not-Disturb bit** — persisted through
  // the shared quick-settings store (`amos.settings.dnd`, lib/settings), the same
  // single write path and key the shell, control center, arrival banner and the
  // 通知 page all read. It used to write a decorative `amos.focus.dnd` field that
  // no silencing path ever read: two switches with the same name in Settings, one
  // real and one fake. 工作 / 睡眠 stay per-scenario *intent* (lib/focusPrefs,
  // durable amos.focus) — the hint says plainly that they do not silence anything
  // yet.
  import { readStoreValue, writeStoreValue } from "../../lib/amosStore";
  import {
    FOCUS_KEY,
    FOCUS_SCENARIOS,
    normalizeFocus,
    toggleFocus,
    type FocusId,
    type FocusPrefs,
  } from "../../lib/focusPrefs";
  import {
    SETTINGS_KEY,
    dndActive,
    flipQuick,
    normalizeQuick,
    type QuickSettings,
  } from "../../lib/settings";
  import { t } from "../locale.svelte";
  import { GROUP, SUB, HINT } from "./kit";
  import ToggleRow from "./ToggleRow.svelte";

  const readQuick = (): QuickSettings => normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {}));
  let qs = $state<QuickSettings>(readQuick());
  const dnd = $derived(dndActive(qs));
  const toggleDnd = () => {
    // Same store, same flip policy as the 通知 page — there is exactly one DND.
    const next = flipQuick(qs, "dnd");
    qs = next;
    writeStoreValue(SETTINGS_KEY, next);
  };

  const initPrefs = normalizeFocus(readStoreValue<unknown>(FOCUS_KEY, {}));
  let prefs = $state<FocusPrefs>(initPrefs);
  const toggle = (id: FocusId) => {
    const next = toggleFocus(prefs, id);
    prefs = next;
    writeStoreValue(FOCUS_KEY, next);
  };
  const idKey = (id: FocusId): string => (id === "work" ? "settings.focusWork" : "settings.focusSleep");
</script>

<section class={GROUP}>
  <ToggleRow label={t("settings.focusDnd")} on={dnd} ontoggle={toggleDnd} />
  {#if FOCUS_SCENARIOS.length > 0}<div class={SUB}></div>{/if}
  {#each FOCUS_SCENARIOS as id, i (id)}
    <ToggleRow label={t(idKey(id))} on={prefs[id]} ontoggle={() => toggle(id)} />
    {#if i < FOCUS_SCENARIOS.length - 1}<div class={SUB}></div>{/if}
  {/each}
  <div class="px-4 pb-3">
    <p class={HINT}>{t("settings.focusHint")}</p>
  </div>
</section>
