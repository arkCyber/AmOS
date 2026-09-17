<script lang="ts">
  // LmkDebugPanel.svelte — Svelte 5 (runes) port of the React LmkDebugPanel in
  // Settings (resident LMK dev panel). Unlike the governor-driven TaskManager it
  // ALWAYS renders (offline shows a graceful "not connected" line), so the LMK
  // trigger + per-surface freeze/thaw/reclaim controls stay reachable. Talks to
  // the daemon through lib/lmk (android_lmk_debug / android_lmk_tasks bridge).
  import {
    androidLmkDebug,
    androidLmkTasks,
    victimState,
    type AndroidLmkTask,
    type LmkVictim,
    type LmkVictimState,
  } from "../lib/lmk";
  import { bridgeDiag } from "../lib/backend";
  import { t } from "./locale.svelte";

  const GROUP =
    "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const ROW = "flex items-center justify-between gap-3 px-4 py-3";
  const LABEL = "text-[15px] text-neutral-800 dark:text-neutral-100";

  interface VictimRound {
    at: string;
    victims: LmkVictim[];
  }
  type TaskAct = {
    action: "apply_freeze" | "apply_thaw" | "apply_reclaim";
    key: string;
  };
  function actionsForTask(state: string): TaskAct[] {
    switch (state) {
      case "cached":
        return [
          { action: "apply_thaw", key: "lmk.thaw" },
          { action: "apply_reclaim", key: "lmk.reclaim" },
        ];
      case "background":
        return [
          { action: "apply_freeze", key: "settings.taskFreeze" },
          { action: "apply_reclaim", key: "lmk.reclaim" },
        ];
      case "stopped":
        return [{ action: "apply_reclaim", key: "lmk.reclaim" }];
      default:
        return [];
    }
  }

  /** Which state token to show for a victim. The daemon's `outcome` is authoritative
   *  (REQ-A299): `killed: false` alone cannot tell "frozen to Cached" from "the
   *  container refused", and showing the latter as frozen is a claim that did not
   *  happen. */
  const VICTIM_KEY: Record<LmkVictimState, string> = {
    reclaimed: "lmk.killed",
    frozen: "lmk.frozen",
    refused: "lmk.refused",
    unknown: "lmk.unknown",
  };
  const VICTIM_CLASS: Record<LmkVictimState, string> = {
    reclaimed: "text-red-500",
    frozen: "opacity-60",
    // A refusal is not a failure — nothing happened — so it is a warning, not danger.
    refused: "text-amber-600 dark:text-amber-500",
    unknown: "opacity-40",
  };
  /** The container's own reason, appended only when it refused the action. */
  const reasonSuffix = (v: LmkVictim) => (v.refusal_reason ? ` (${v.refusal_reason})` : "");

  let busy = $state(false);
  let note = $state<string | null>(null);
  let tasks = $state<AndroidLmkTask[]>([]);
  let offline = $state(false);
  let rounds = $state<VictimRound[]>([]);
  let budget = $state(1);
  let noteTimer: number | null = null;

  const dismissNote = () => {
    if (noteTimer !== null) {
      window.clearTimeout(noteTimer);
      noteTimer = null;
    }
    note = null;
  };
  const showNote = (n: string) => {
    dismissNote();
    note = n;
    noteTimer = window.setTimeout(() => (note = null), 4000);
  };

  const refresh = () => {
    // REQ-A297 phase-2 §4 cont.4: `androidLmkTasks()` (and every other
    // `lib/backend.ts` wrapper) resolves `null` on a refused command and
    // **never** rejects — see `lib/backend.ts::invoke`. The pre-fix
    // `.catch(() => (offline = true))` was dead code: a refused
    // `android_lmk_tasks` returns `null`, and the success arm already
    // flips `offline` on that exact value (`offline = l === null`). What
    // was silently empty before was the *typed* error code, which now
    // lands in the diagnostic ledger (P1-3) so ops can tell "the daemon
    // refused" from "the daemon is offline".
    androidLmkTasks()
      .then((l) => {
        tasks = l ?? [];
        offline = l === null;
        if (l === null) {
          // Check diagnostic for refused command (REQ-A296's typed contract).
          // "not-bridged" is the same as `l === null` already, so it isn't
          // interesting on this path.
          const diag = bridgeDiag("android_lmk_tasks");
          if (!diag.ok && diag.kind === "command-failed") {
            console.warn("🛟 [LmkDebugPanel] android_lmk_tasks refused:", diag.detail);
          }
        }
      });
  };
  $effect(() => {
    refresh();
    return dismissNote;
  });

  const run = (
    pkg: string | undefined,
    action: "trigger" | "apply_freeze" | "apply_thaw" | "apply_reclaim",
    b?: number,
  ) => {
    if (busy) return;
    busy = true;
    dismissNote();
    androidLmkDebug(action, pkg, b)
      .then((o) => {
        if (o) {
          showNote(o.note);
          if (o.victims.length > 0) {
            rounds = [
              { at: new Date().toLocaleTimeString(), victims: o.victims },
              ...rounds,
            ].slice(0, 5);
          }
          refresh();
        } else {
          // REQ-A297 phase-2 §4 cont.4: a refused `android_lmk_debug` returns
          // `null`; the user-facing "fail" note is correct for that (same as
          // before), but the .catch that used to host this branch was dead
          // because `invoke` never rejects (lib/backend.ts). The typed
          // reason now lives in the diagnostic ledger.
          showNote(t("lmk.fail"));
          const diag = bridgeDiag("android_lmk_debug");
          if (!diag.ok && diag.kind === "command-failed") {
            console.warn("🛟 [LmkDebugPanel] android_lmk_debug refused:", diag.detail);
          }
        }
      })
      .finally(() => (busy = false));
  };
  const trigger = () => run(undefined, "trigger", budget);
  const actTask = (
    pkg: string,
    action: "apply_freeze" | "apply_thaw" | "apply_reclaim",
  ) => run(pkg, action);
</script>

<section class={GROUP}>
  <div class={ROW}>
    <span class={LABEL}>{t("lmk.title")}</span>
    <label class="flex items-center gap-1 text-[11px] opacity-70">
      {t("lmk.budget")}
      <input
        type="number"
        min={1}
        max={8}
        value={budget}
        aria-label={t("lmk.ariaBudget")}
        oninput={(e) => {
          const v = Math.round(Number((e.target as HTMLInputElement).value));
          budget = Number.isFinite(v) ? Math.min(8, Math.max(1, v)) : 1;
        }}
        class="w-12 rounded bg-black/5 px-1 py-0.5 text-right outline-none dark:bg-white/10"
      />
    </label>
    <button
      onclick={trigger}
      disabled={busy}
      aria-label={t("lmk.ariaTrigger")}
      class="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 disabled:opacity-40 dark:bg-white/10"
    >
      {t("lmk.trigger")}
    </button>
    <button
      onclick={refresh}
      disabled={busy}
      aria-label={t("lmk.ariaRefresh")}
      class="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 disabled:opacity-40 dark:bg-white/10"
    >
      {t("lmk.refresh")}
    </button>
  </div>

  {#if note}
    <div
      role="status"
      class="mx-4 mb-1 flex items-center justify-between gap-2 rounded-lg bg-black/5 px-3 py-1 text-[11px] dark:bg-white/10"
    >
      <span class="min-w-0 truncate">{note}</span>
      <button onclick={dismissNote} aria-label={t("lmk.ariaDismiss")} class="opacity-70 hover:opacity-100">
        ✕
      </button>
    </div>
  {/if}

  {#if rounds.length > 0}
    <div class="border-t border-black/5 px-4 py-3 text-xs dark:border-white/10">
      <div class="mb-1 flex items-center justify-between">
        <p class="font-semibold opacity-80">{t("lmk.recentVictims")}</p>
        <button
          onclick={() => (rounds = [])}
          aria-label={t("lmk.ariaClear")}
          class="rounded-full bg-black/5 px-2 py-0.5 opacity-70 active:scale-95 dark:bg-white/10"
        >
          {t("lmk.clearHistory")}
        </button>
      </div>
      <ul class="max-h-28 space-y-0.5 overflow-y-auto">
        {#each rounds as r, i (r.at + "-" + i)}
          <li class="opacity-80">
            <span class="mr-1 opacity-50">{r.at}</span>
            {#each r.victims as v, j (j)}
              {@const st = victimState(v)}
              <span class="mr-2">
                {v.package_name}
                <span class={VICTIM_CLASS[st]}>{t(VICTIM_KEY[st])}{reasonSuffix(v)}</span>
              </span>
            {/each}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  <div class="border-t border-black/5 px-4 py-3 text-xs dark:border-white/10">
    <p class="mb-1 font-semibold opacity-80">{t("lmk.containerTasks")}</p>
    {#if offline}
      <p class="opacity-50">{t("lmk.offline")}</p>
    {:else if tasks.length === 0}
      <p class="opacity-50">{t("lmk.noTasks")}</p>
    {:else}
      <ul class="max-h-32 space-y-1 overflow-y-auto">
        {#each tasks as tk (tk.window_id || tk.package_name)}
          <li class="flex flex-wrap items-center justify-between gap-2">
            <span class="min-w-0">
              <span class="truncate">{tk.package_name}</span>
              <span class="ml-2 opacity-50">
                {tk.window_id} · {tk.state}
              </span>
            </span>
            <span class="flex flex-wrap gap-1">
              {#each actionsForTask(tk.state) as a (a.action)}
                <button
                  onclick={() => actTask(tk.package_name, a.action)}
                  disabled={busy}
                  aria-label={`${t(a.key)} ${tk.package_name}`}
                  class="rounded-full bg-black/5 px-2 py-0.5 active:scale-95 disabled:opacity-40 dark:bg-white/10"
                >
                  {t(a.key)}
                </button>
              {/each}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>


