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
  import { t } from "./locale.svelte";

  const REFRESH_MS = 3000;
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

  const refresh = () => {
    if (inflight) return;
    inflight = true;
    busy = true;
    taskmgrSnapshot()
      .then((s) => {
        if (s) snap = normalizeTaskSnapshot(s);
      })
      .catch(() => {
        /* daemon offline → keep previous / nothing */
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
    taskmgrAppAction(id, action)
      .then((s) => {
        if (s) snap = normalizeTaskSnapshot(s);
      })
      .catch(() => {
        /* daemon offline */
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
    taskmgrJobAction(id, action)
      .then((s) => {
        if (s) snap = normalizeTaskSnapshot(s);
      })
      .catch(() => {
        /* daemon offline */
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
    if (!hasAny) return;
    const id = window.setInterval(refresh, REFRESH_MS);
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
