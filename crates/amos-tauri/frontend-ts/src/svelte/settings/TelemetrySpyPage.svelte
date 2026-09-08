<script lang="ts">
  // TelemetrySpyPage.svelte — 「外发泄漏审计 / Outbound Leak Audit」sub page.
  // Informational + status only: describes the passive, read-only egress audit
  // (docs/telemetry-spy.md) and its honest boundaries. There is deliberately NO
  // toggle — the audit is always-on and read-only; this page is where a user can
  // understand what the "Outbound leak risk" notifications are about.
  import { bridged } from "../../lib/backend";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, VALUE, H2, HINT } from "./kit";

  // Watching = the System UI's Watch feed is bridged (listener attached); Quiet =
  // not connected. Either way the default host build has no capture producer, so
  // the honest boundary copy below makes clear the chain stays silent.
  const status = $derived(bridged() ? t("spy.statusWatching") : t("spy.statusQuiet"));
</script>

<div class="space-y-5">
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>🛰️ {t("settings.spy")}</span>
      <span class={VALUE}>{status}</span>
    </div>
    <div class="border-t border-black/5 px-4 py-3 dark:border-white/10">
      <p class="text-sm leading-relaxed opacity-80">{t("spy.lead")}</p>
    </div>
  </section>

  <section class={GROUP}>
    <div class="px-4 py-3">
      <p class={H2}>{t("spy.whatHeading")}</p>
      <p class="mt-1.5 text-sm leading-relaxed opacity-80">{t("spy.whatText")}</p>
    </div>
  </section>

  <p class={HINT}>{t("spy.boundary")}</p>
  <p class={HINT}>{t("spy.privacyNote")}</p>
</div>
