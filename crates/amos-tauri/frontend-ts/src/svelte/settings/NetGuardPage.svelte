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
  import { t } from "../locale.svelte";
  import { GROUP, H2, HINT, LABEL, ROW, VALUE } from "./kit";
  import Switch from "./Switch.svelte";

  let status = $state<NetGuardStatus | null>(null);
  let busy = $state(false);

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
    try {
      const r = await netguardArm(!status.enabled);
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
    <div class={ROW}>
      <span class={LABEL}>🛡️ {t("settings.guard")}</span>
      <Switch on={on} ontoggle={toggle} disabled={!canToggle} aria={t("settings.guard")} />
    </div>
    <div class="border-t border-black/5 px-4 py-3 dark:border-white/10">
      <p class={VALUE}>{t(valKey)}</p>
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
