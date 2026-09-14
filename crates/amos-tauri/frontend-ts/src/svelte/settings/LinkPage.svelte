<script lang="ts">
  // LinkPage.svelte — 「机器人链路 / Robot Link」 sub page: the System UI's read-only
  // view of the daemon's AmOS-Link control plane (`RobotLink.GetStatus`, bridge
  // `crates/amos-tauri/src/link.rs`). It answers the operator's question — is the
  // robot on the link, who else is, and can the latency numbers be trusted — with
  // the daemon's *own* verdict, never a UI guess:
  //   • `unknown` (no evidence yet) is kept apart from `healthy`;
  //   • an uncalibrated clock is called out, because it makes every latency a bound;
  //   • counters are shown as cumulative, not as a rate.
  // There is no toggle: this page observes, it does not command (the CLI owns
  // publishing; docs/amos-link.md §6).
  import { onMount } from "svelte";
  import {
    counterSummary,
    formatUptime,
    healthKey,
    linkLevel,
    linkStatus,
    peerSummary,
    robotLevel,
    robotLevelKey,
    robotSummary,
    type LinkStatus,
  } from "../../lib/link";
  import { t } from "../locale.svelte";
  import { GROUP, H2, HINT, LABEL, ROW, SUB, VALUE } from "./kit";

  let status = $state<LinkStatus | null>(null);
  let loading = $state(false);
  let loaded = $state(false);

  const level = $derived(linkLevel(status));

  const refresh = async () => {
    loading = true;
    try {
      status = await linkStatus();
    } finally {
      loading = false;
      loaded = true;
    }
  };

  onMount(() => {
    void refresh();
  });
</script>

<div class="space-y-5">
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>🦿 {t("settings.link")}</span>
      <button
        class="text-[15px] text-accent active:scale-95 disabled:opacity-40"
        onclick={() => void refresh()}
        disabled={loading}
        aria-label={t("link.refresh")}
      >
        {t("link.refresh")}
      </button>
    </div>
    <div class={SUB}></div>
    <div class="px-4 py-3">
      <p class={VALUE} data-testid="link-verdict">{t(healthKey(level))}</p>
      {#if status}
        <p class="mt-1 text-xs opacity-60">
          {status.peer} · {status.kind} · v{status.version}
        </p>
        <p class="mt-1 text-xs opacity-60">
          {t("link.uptime")}: {formatUptime(status.uptime_ms)} ·
          {status.clock_synced ? t("link.clockSynced") : t("link.clockUnsynced")}
        </p>
      {/if}
    </div>
  </section>

  {#if status}
    {#if status.health_reasons.length > 0}
      <section class={GROUP}>
        <div class="px-4 py-3">
          <p class={H2}>{t("link.reasonsHeading")}</p>
          <ul class="mt-1.5 space-y-1 text-sm opacity-80">
            {#each status.health_reasons as reason (reason)}
              <li class="truncate">{reason}</li>
            {/each}
          </ul>
        </div>
      </section>
    {/if}

    <section class={GROUP}>
      <div class="px-4 py-3">
        <p class={H2}>{t("link.countersHeading")}</p>
        <p class="mt-1.5 text-sm opacity-80" data-testid="link-counters">
          {counterSummary(status.metrics)}
        </p>
      </div>
    </section>

    <section class={GROUP}>
      <div class="px-4 py-3">
        <p class={H2}>{t("link.peersHeading")}</p>
        {#if status.peers.length > 0}
          <p class="mt-1.5 text-sm opacity-80" data-testid="link-peers">
            {peerSummary(status.peers)}
          </p>
          <ul class="mt-1.5 space-y-1 text-xs opacity-60">
            {#each status.peers as peer (peer.id)}
              <li class="flex justify-between gap-3">
                <span class="truncate">{peer.id}</span>
                <span class="shrink-0">
                  {peer.last_seen_ms}ms · {peer.beacons}×
                </span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="mt-1.5 text-sm opacity-70">{t("link.noPeers")}</p>
        {/if}
      </div>
    </section>

    <section class={GROUP}>
      <div class="px-4 py-3">
        <p class={H2}>{t("link.robotsHeading")}</p>
        {#if (status.actuations ?? []).length > 0}
          <ul class="mt-1.5 space-y-2" data-testid="link-robots">
            {#each status.actuations ?? [] as robot (robot.robot)}
              <li class="text-sm">
                <div class="flex justify-between gap-3">
                  <span class="truncate">{robotSummary(robot)}</span>
                  <span class="shrink-0 opacity-70">
                    {t(robotLevelKey(robotLevel(robot)))}
                  </span>
                </div>
                {#if robot.last_refusal}
                  <p class="text-xs opacity-60" data-testid="link-robot-refusal">
                    {t("link.robotRefused", { seq: robot.last_refusal.seq })}:
                    {robot.last_refusal.reason}
                  </p>
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="mt-1.5 text-sm opacity-70" data-testid="link-robots-none">
            {t("link.noReports")}
          </p>
        {/if}
      </div>
    </section>
  {:else if loaded}
    <p class={HINT}>{t("link.tip")}</p>
  {/if}

  <section class={GROUP}>
    <div class="px-4 py-3">
      <p class={H2}>{t("link.leadHeading")}</p>
      <p class="mt-1.5 text-sm leading-relaxed opacity-80">{t("link.lead")}</p>
    </div>
  </section>

  <p class={HINT}>{t("link.boundary")}</p>
</div>
