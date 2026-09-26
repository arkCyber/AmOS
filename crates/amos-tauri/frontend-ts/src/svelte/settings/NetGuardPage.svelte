<script lang="ts">
  // NetGuardPage.svelte — 「外发网闸 / Network Guard」 sub page. One-click arm /
  // disarm of the daemon's egress guard (`NetGuardService`), with an honest
  // status that never claims a real firewall is blocking when none is enforced.
  // See docs/anti-telemetry-egress-guard.md for the enforcement boundaries.
  import { onMount } from "svelte";
  import {
    guardLevel,
    netguardArm,
    netguardStatus,
    type NetGuardStatus,
  } from "../../lib/netguard";
  import { bridgeDiag } from "../../lib/backend";
  // The repo's single home for "the host's own words" about a refused command
  // (`lib/devcare.ts` imports it the same way).
  import { callActionDetailText } from "../../lib/phone";
  import { t } from "../locale.svelte";
  import { GROUP, H2, HINT, VALUE } from "./kit";
  import ToggleRow from "./ToggleRow.svelte";

  let status = $state<NetGuardStatus | null>(null);
  let busy = $state(false);
  // The host's own words for the last refused arm/disarm. Without this the switch
  // simply springs back and the page says nothing — on a *security* control, "the
  // toggle did nothing" is indistinguishable from "it is still working".
  let error = $state<string | null>(null);

  const level = $derived(guardLevel(status));
  // The switch reflects *armed* (intent or enforced); disarmed = off.
  const on = $derived(level === "armed-enforced" || level === "armed-intent");
  const canToggle = $derived(status !== null && !busy);

  const valKey = $derived.by(() => {
    switch (level) {
      case "armed-enforced": return "guard.valEnforced";
      case "armed-intent": return "guard.valIntent";
      case "disarmed": return "guard.valDisarmed";
      default: return "guard.valOffline";
    }
  });

  const refresh = async () => {
    status = await netguardStatus();
  };

  const toggle = async () => {
    if (!canToggle || status === null) return;
    busy = true;
    error = null;
    try {
      const r = await netguardArm(!status.enabled);
      // The verdict is not `r`: a refused `netguard_toggle` reaches us as `null`,
      // which is also what "the daemon answered with nothing" looks like, so
      // `if (r)` read a refusal as "nothing to say" and the switch just sprang back
      // in silence (F-SH-236 family). Ask the diagnosis slot — the same source
      // `callActionOutcome` reads for the phone surfaces.
      const diag = bridgeDiag("netguard_toggle");
      if (!diag.ok) {
        const words =
          diag.kind === "not-bridged" ? "" : callActionDetailText(diag.detail);
        error = t("guard.toggleFailed", {
          detail: words === "" ? t("guard.toggleNoReason") : words,
        });
        return;
      }
      // Trust only the daemon's own post-toggle snapshot for the next status; the
      // Mock backend never fabricates `enforced`, so arming yields intent, not a lie.
      if (r) await refresh();
    } finally {
      busy = false;
    }
  };

  onMount(() => {
    void refresh();
  });
</script>

<div class="space-y-5">
  <section class={GROUP}>
    <ToggleRow
      label={t("settings.guard")}
      icon="🛡️"
      on={on}
      ontoggle={toggle}
      disabled={!canToggle}
    />
    <div class="border-t border-black/5 px-4 py-3 dark:border-white/10">
      <p class={VALUE}>{t(valKey)}</p>
      {#if error}
        <!-- A refused arm/disarm: the switch has already sprung back, so without the
             host's own words the page would look like the tap never registered. -->
        <p
          role="alert"
          class="mt-2 rounded-md bg-red-500/15 px-2 py-1 text-[11px] font-medium text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      {/if}
      {#if status}
        <p class="mt-1 text-xs opacity-60">
          {t("guard.backend")}: {status.backend}
        </p>
      {/if}
    </div>
  </section>

  <section class={GROUP}>
    <div class="px-4 py-3">
      <p class={H2}>{t("guard.leadHeading")}</p>
      <p class="mt-1.5 text-sm leading-relaxed opacity-80">{t("guard.lead")}</p>
    </div>
  </section>

  {#if status && status.top_egress.length > 0}
    <section class={GROUP}>
      <div class="px-4 py-3">
        <p class={H2}>{t("guard.topHeading")}</p>
        <ul class="mt-1.5 space-y-1 text-sm opacity-80">
          {#each status.top_egress as e (e.domain)}
            <li class="flex justify-between gap-3">
              <span class="truncate">{e.domain}</span>
              <span class="shrink-0 opacity-60">{e.bytes} B</span>
            </li>
          {/each}
        </ul>
      </div>
    </section>
  {:else if status}
    <p class={HINT}>{t("guard.noEgress")}</p>
  {/if}

  <p class={HINT}>{t("guard.boundary")}</p>
</div>
