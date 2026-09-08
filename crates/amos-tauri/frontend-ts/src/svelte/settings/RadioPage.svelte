<script lang="ts">
  // RadioPage.svelte — Wi‑Fi / 蓝牙 sub page of the iOS-style Settings. Renders a
  // master switch row bound to the shared quick-settings radio bits (same store +
  // policy as the control center, see lib/settings.ts flipRadio / airplane gating).
  import { t } from "../locale.svelte";
  import type { QuickSettings, RadioKey } from "../../lib/settings";
  import { GROUP, ROW, LABEL, SUB, VALUE, HINT } from "./kit";
  import Switch from "./Switch.svelte";

  let {
    which,
    qs,
    onToggle,
  }: { which: "wifi" | "bluetooth"; qs: QuickSettings; onToggle: (k: RadioKey) => void } = $props();

  const title = $derived(which === "wifi" ? t("settings.wifi") : t("settings.bluetooth"));
  const on = $derived(which === "wifi" ? !!qs.wifi : !!qs.bluetooth);
</script>

<div class="space-y-5">
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{title}</span>
      <Switch on={on} disabled={qs.airplane} aria={title} ontoggle={() => onToggle(which)} />
    </div>
    {#if qs.airplane}
      <div class={SUB}></div>
      <div class="px-4 py-3">
        <p class={HINT}>{t("settings.airplaneBlocks")}</p>
      </div>
    {:else}
      <div class={SUB}></div>
      <div class="flex items-center justify-between gap-3 px-4 py-3">
        <span class={LABEL}>{t("settings.currentNetwork")}</span>
        <span class={VALUE}>{on ? t("settings.on") : t("settings.off")}</span>
      </div>
    {/if}
  </section>

  <section class={GROUP}>
    <div class="px-4 py-3">
      <p class={HINT}>{on ? t("settings.radioOnDesc") : t("settings.radioOffDesc")}</p>
    </div>
  </section>
</div>
