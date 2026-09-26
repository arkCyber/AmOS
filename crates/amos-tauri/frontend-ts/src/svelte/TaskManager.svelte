<script lang="ts">
  // TaskManager.svelte — Svelte 5 (runes) port of the React TaskManager tile in
  // Settings. Drives the daemon's resource-governor registry (freeze/background/
  // stop/kill/cancel) via lib/taskmgr. Hidden when the governor has nothing
  // registered or the daemon is absent (no broken card); live auto-refresh ~3s.
  import {
    appIsRunning,
    normalizeTaskSnapshot,
    taskmgrAppAction,
    taskmgrJobAction,
    taskmgrSnapshot,
    type AppAction,
    type TaskApp,
    type TaskSnapshot,
  } from "../lib/taskmgr";
  import { bridgeDiag } from "../lib/backend";
  import { callActionDetailText } from "../lib/phone";
  import { t } from "./locale.svelte";

  const REFRESH_MS = 3000;
  // The cadence while the panel has nothing to draw — same rule as `SystemPanel.svelte`
  // (REQ-A1356) and `MonitorApp.svelte`, whose comments call each poll a reconnect probe.
  const RECONNECT_MS = 5000;
  const GROUP =
    "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const ROW = "flex items-center justify-between gap-3 px-4 py-3";
  const LABEL = "text-[15px] text-neutral-800 dark:text-neutral-100";

  function actionsFor(a: TaskApp): [AppAction, string][] {
    const acts: [AppAction, string][] = [];
    if (a.state !== "foreground" && a.state !== "unknown") {
      acts.push(["foreground", "settings.taskForeground"]);
    }
    if (a.state === "foreground") acts.push(["background", "settings.taskBackground"]);
    if (a.state === "background") acts.push(["freeze", "settings.taskFreeze"]);
    if (appIsRunning(a)) acts.push(["stop", "settings.taskStop"]);
    acts.push(["kill", "settings.taskKill"]);
    return acts;
  }

  let snap = $state<TaskSnapshot>(normalizeTaskSnapshot(null));
  let busy = $state(false);
  let inflight = false;
  /** A refusal the daemon actually sent (see `reportRefusal`), or null. */
  let refused = $state<string | null>(null);

  /**
   * A lifecycle action that resolved `null` was **either** "no daemon" **or** "the daemon
   * answered and refused" — the two used to be the same silent nothing (the `.catch`
   * commented "daemon offline" was unreachable, because `lib/taskmgr.ts` folded the
   * rejection to `null` before it ever surfaced). The ledger now records the reason, so
   * this reads it back: a real refusal is *said*, a missing daemon stays quiet.
   */
  const reportRefusal = (command: string) => {
    const diag = bridgeDiag(command);
    // `not-bridged` / no record: the panel is already hiding itself offline, so there is
    // nothing to claim. Only a command the daemon *ran and failed* has words to show —
    // through the shared normalizer, so a machine token never reaches the sentence.
    if (diag.ok || diag.kind !== "command-failed") return;
    refused = callActionDetailText(diag.detail) || t("settings.taskRefusedNoReason");
  };

  const refresh = () => {
    if (inflight) return;
    inflight = true;
    busy = true;
    taskmgrSnapshot()
      .then((s) => {
        if (s) snap = normalizeTaskSnapshot(s);
      })
      .finally(() => {
        inflight = false;
        busy = false;
      });
  };

  const act = (id: string, action: AppAction) => {
    if (inflight) return;
    inflight = true;
    busy = true;
    // A new action supersedes the previous action's verdict: without this the
    // refusal outlives what it describes, so a later action that *succeeded*
    // still sits beside a sentence saying the earlier one failed.
    refused = null;
    taskmgrAppAction(id, action)
      .then((s) => {
        if (s) snap = normalizeTaskSnapshot(s);
        else reportRefusal("taskmgr_app_action");
      })
      .finally(() => {
        inflight = false;
        busy = false;
      });
  };
  const actJob = (id: string, action: "cancel") => {
    if (inflight) return;
    inflight = true;
    busy = true;
    // Same rule as `act`: a new action supersedes the previous verdict.
    refused = null;
    taskmgrJobAction(id, action)
      .then((s) => {
        if (s) snap = normalizeTaskSnapshot(s);
        else reportRefusal("taskmgr_job_action");
      })
      .finally(() => {
        inflight = false;
        busy = false;
      });
  };

  const hasAny = $derived(snap.apps.length > 0 || snap.jobs.length > 0 || snap.decision !== null);
  const modeLabel = (m: string): string =>
    m === "balanced"
      ? t("settings.sensorBalanced")
      : m === "performance"
        ? t("settings.sensorPerformance")
        : m === "power_save"
          ? t("settings.sensorPowerSave")
          : m;

  $effect(() => {
    refresh();
  });
  $effect(() => {
    // Kept armed in **both** states, only the period changes (REQ-A1364 / F-SH-628). The
    // pre-fix `if (!hasAny) return;` made the very state that hides the panel switch off
    // the only thing that could ever un-hide it: `{#if hasAny}` below has no `else`, the
    // 刷新 button lives *inside* that branch, and nothing else on these screens re-reads
    // `taskmgr_snapshot` — so a daemon absent at mount left the whole section missing for
    // the session. The sibling `SystemPanel.svelte` (REQ-A1356) already states the rule;
    // this is the same panel, on the same screen, one line down.
    const ms = hasAny ? REFRESH_MS : RECONNECT_MS;
    const id = window.setInterval(refresh, ms);
    return () => window.clearInterval(id);
  });
</script>

{#if hasAny}
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.task")}</span>
      <button
        onclick={refresh}
        disabled={busy}
        class="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 disabled:opacity-40 dark:bg-white/10"
      >
        {t("settings.taskRefresh")}
      </button>
    </div>

    {#if snap.decision}
      <p class="px-4 py-1 text-xs opacity-70">
        {t("settings.taskDecision", { mode: modeLabel(snap.decision.mode), reason: snap.decision.reason })}
      </p>
    {/if}

    {#if refused}
      <!-- A refused action is a verdict, not an absence: the daemon ran the command and
           said no (a dead app, an unknown action). Without this the button did nothing,
           silently, and the app the user meant to stop kept running. -->
      <p role="alert" data-testid="task-refused" class="px-4 py-1 text-xs text-danger">
        {t("settings.taskRefused", { detail: refused })}
      </p>
    {/if}

    <div class="grid grid-cols-1 gap-1 border-t border-black/5 px-4 py-3 text-xs dark:border-white/10">
      <p class="font-semibold opacity-80">{t("settings.taskApps")}</p>
      {#if snap.apps.length === 0}
        <p class="opacity-50">{t("settings.taskEmpty")}</p>
      {:else}
        <ul class="max-h-40 space-y-1 overflow-y-auto">
          {#each snap.apps as a (a.id)}
            <li class="flex flex-wrap items-center justify-between gap-2">
              <span class="min-w-0">
                <span class="truncate">{a.id}</span>
                <span class="ml-2 opacity-50">{a.state}</span>
              </span>
              <span class="flex flex-wrap gap-1">
                {#each actionsFor(a) as [action, key] (action)}
                  <button
                    onclick={() => act(a.id, action)}
                    disabled={busy}
                    class="rounded-full bg-black/5 px-2 py-0.5 active:scale-95 disabled:opacity-40 dark:bg-white/10"
                  >
                    {t(key as "settings.taskKill")}
                  </button>
                {/each}
              </span>
            </li>
          {/each}
        </ul>
      {/if}

      <p class="mt-2 font-semibold opacity-80">{t("settings.taskJobs")}</p>
      {#if snap.jobs.length === 0}
        <p class="opacity-50">{t("settings.taskEmpty")}</p>
      {:else}
        <ul class="max-h-32 space-y-0.5 overflow-y-auto">
          {#each snap.jobs as j (j.id)}
            <li class="flex items-center justify-between gap-2">
              <span class="truncate">{j.id}</span>
              <span class="flex items-center gap-2">
                <span class="opacity-60">
                  {j.kind} [{j.earliest}→{j.latest}]
                </span>
                <button
                  onclick={() => actJob(j.id, "cancel")}
                  disabled={busy}
                  class="rounded-full bg-black/5 px-2 py-0.5 active:scale-95 disabled:opacity-40 dark:bg-white/10"
                >
                  {t("settings.taskCancel")}
                </button>
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </section>
{/if}
