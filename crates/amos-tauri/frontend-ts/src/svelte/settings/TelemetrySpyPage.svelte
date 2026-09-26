<script lang="ts">
  // TelemetrySpyPage.svelte — 「外发泄漏审计 / Outbound Leak Audit」sub page.
  // Informational + status only: describes the passive, read-only egress audit
  // (docs/telemetry-spy.md) and its honest boundaries. There is deliberately NO
  // toggle — the audit is always-on and read-only; this page is where a user can
  // understand what the "Outbound leak risk" notifications are about.
  import { spyWatch } from "../../lib/telemetrySpy";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, VALUE, H2, HINT } from "./kit";

  // The status is the **subscription's own verdict**, read from the seam the shell
  // publishes it on (`spyWatch`), not `bridged()`. `bridged()` only says the Tauri
  // internals object exists (REQ-A1360) — and the event registration can still be
  // refused, in which case no hit will ever arrive while the shell keeps running. The
  // pre-fix line drew 「已接入外发监听」 whenever a host existed at all, so the one state
  // this page exists to report — an audit that is **not** running — was the one it
  // reported as running. Three states, so "not attached yet" and "the host refused"
  // stop sharing a sentence that claimed neither.
  //
  // Note the remaining boundary, kept in the copy below: an *attached* listener is not
  // a *producing* one — the default host build has no capture producer, so the chain
  // is quiet, and 「审计中」 must not be read as "hits are being collected".
  const status = $derived(
    $spyWatch === "attached"
      ? t("spy.statusWatching")
      : $spyWatch === "refused"
        ? t("spy.statusListenRefused")
        : t("spy.statusQuiet"),
  );
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
