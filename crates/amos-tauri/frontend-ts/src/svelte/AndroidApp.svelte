<script lang="ts">
  // AndroidApp.svelte — Svelte 5 (runes) single-source implementation of the
  // Android-apps screen. Lists legacy Android apps over the shared
  // bridge (get_android_apps) + launches on tap; recents persisted in the shared
  // store. Offline (not inside Tauri / no daemon) degrades to a localized
  // "not connected" state (fully testable here); live listing/launch/icon fetch
  // need the daemon (device acceptance).
  import {
    bridged,
    getAndroidAppIcon,
    getAndroidApps,
    launchAndroidApp,
    subscribe,
  } from "../lib/backend";
  import {
    addRecent,
    bytesToDataUri,
    displayName,
    readRecents,
    runTierForPackage,
    type AndroidApp,
    type AndroidRecent,
    type AndroidRunTier,
  } from "../lib/android";
  import { androidLmkTasks, LMK_SURFACE_EVENT } from "../lib/lmk";
  import { t } from "./locale.svelte";

  const online = $derived(bridged());
  let apps = $state<AndroidApp[]>([]);
  let icons = $state<Record<string, string>>({});
  // package_name -> lifecycle tier surfaced from the daemon's LMK snapshot.
  let tiers = $state<Record<string, AndroidRunTier>>({});
  let recent = $state<AndroidRecent[]>(readRecents());
  let status = $state("");
  let pkg = $state("");

  $effect(() => {
    if (!online) {
      status = t("android.offline");
      return;
    }
    let alive = true;
    getAndroidApps()
      .then((list) => {
        if (!alive) return;
        if (!list || !list.length) {
          status = t("android.empty");
          return;
        }
        apps = list;
        status = `${list.length} ${t("android.count")}`;
      })
      .catch(() => {
        if (alive) status = t("android.fetchError");
      });
    return () => {
      alive = false;
    };
  });

  // Best-effort icon fetch (PNG bytes → data URI); emoji tile fallback.
  $effect(() => {
    if (!online) return;
    let alive = true;
    for (const a of apps) {
      getAndroidAppIcon(a.package_name)
        .then((bytes) => {
          if (alive && bytes && bytes.length) {
            icons = { ...icons, [a.package_name]: bytesToDataUri(bytes) };
          }
        })
        .catch(() => {
          /* keep the emoji fallback */
        });
    }
    return () => {
      alive = false;
    };
  });

  // Surface each app's container lifecycle tier (running / background) from the
  // daemon's authoritative LMK snapshot, so the grid reflects freeze/kill state
  // without polluting recents. Recomputes from the latest apps list whenever it
  // is (re)loaded, and is re-triggered live by container `lmk-surface` events.
  let fetchToken = 0;
  async function refreshTiers() {
    const token = ++fetchToken;
    const tasks = await androidLmkTasks();
    // Stale responses lose to a newer refresh; daemon-down (null) is not
    // "everything stopped", so keep whatever tiers we already had.
    if (!tasks || token !== fetchToken) return;
    const next: Record<string, AndroidRunTier> = {};
    for (const a of apps) {
      const tier = runTierForPackage(a.package_name, tasks);
      if (tier) next[a.package_name] = tier;
    }
    tiers = next;
  }

  // Initial + reactive refetch: whenever the installed list changes/loads.
  $effect(() => {
    if (!online || apps.length === 0) {
      tiers = {};
      return;
    }
    void refreshTiers();
  });

  // Live refresh: any container LMK decision (kill/reclaim/freeze/thaw/destroy)
  // is broadcast to the shell as an `lmk-surface` event — refetch so the badges
  // track the current container state without waiting for a page reload.
  $effect(() => {
    if (!online) return;
    let disposed = false;
    let stop = () => {};
    void subscribe(LMK_SURFACE_EVENT, () => {
      void refreshTiers();
    }).then((un) => {
      if (disposed) un();
      else stop = un;
    });
    return () => {
      disposed = true;
      stop();
    };
  });

  const doLaunch = async (p: string) => {
    const name = p.trim();
    if (!name) return;
    if (!online) {
      status = t("android.offline");
      return;
    }
    // Already foreground/visible in the container? Don't cold-launch a duplicate;
    // surface the fact so the tap isn't a silent no-op.
    if (tiers[name] === "running") {
      status = `${t("android.alreadyRunning")} ${name}`;
      return;
    }
    status = `${t("android.launching")} ${name}…`;
    const r = await launchAndroidApp(name);
    if (!r) {
      status = t("android.rpcError");
      return;
    }
    if (r.success) {
      recent = addRecent(readRecents(), { package_name: name, name, ts: Date.now() });
      status = t("android.launched") + (r.window_id ? " · " + r.window_id : "");
      // The container now holds this app as foreground — refresh the tiers so the
      // badge appears immediately and the "already running" guard holds for the
      // next tap (instead of waiting on an unrelated lmk-surface event / reload).
      void refreshTiers();
    } else {
      status = t("android.launchFailed") + (r.error ? "：" + r.error : "");
    }
  };
</script>

<div class="flex h-full flex-col p-3">
  <p class="text-sm opacity-70">{status || t("android.loading")}</p>

  {#if recent.length > 0}
    <div class="mt-2">
      <p class="text-xs opacity-50">{t("android.recent")}</p>
      <div class="mt-1 flex flex-wrap gap-1.5">
        {#each recent as r (r.package_name)}
          <button
            onclick={() => void doLaunch(r.package_name)}
            class="inline-flex items-center gap-1.5 rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"
          >
            {#if tiers[r.package_name]}
              <span
                data-testid={`recent-dot-${r.package_name}`}
                aria-hidden="true"
                class="h-1.5 w-1.5 shrink-0 rounded-full {tiers[r.package_name] === 'running'
                  ? 'bg-emerald-500'
                  : 'bg-neutral-400'}"
              ></span>
            {/if}
            {displayName(r)}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="mt-3 grid flex-1 auto-rows-min grid-cols-3 gap-x-2 gap-y-4 overflow-auto pb-2">
    {#each apps as a (a.package_name)}
      <button
        onclick={() => void doLaunch(a.package_name)}
        class="flex flex-col items-center gap-1.5 outline-none active:scale-95"
      >
        <span class="relative grid h-14 w-14 place-items-center overflow-hidden rounded-[15px] bg-gradient-to-br from-[#2c6b49] to-[#00a854] text-3xl">
          {#if icons[a.package_name]}
            <img
              alt={displayName(a)}
              src={icons[a.package_name]}
              class="absolute inset-0 h-full w-full object-cover"
            />
          {:else}
            <span>🤖</span>
          {/if}
        </span>
        <span class="max-w-full truncate text-center text-[11px] leading-tight text-neutral-800 dark:text-neutral-200">
          {displayName(a)}
        </span>
        {#if tiers[a.package_name]}
          <span
            data-testid={`android-tier-${a.package_name}`}
            class="rounded-full px-2 py-px text-[9px] leading-none {tiers[a.package_name] === 'running'
              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
              : 'bg-neutral-400/20 text-neutral-500 dark:text-neutral-400'}"
          >
            {tiers[a.package_name] === "running" ? t("android.running") : t("android.background")}
          </span>
        {/if}
      </button>
    {/each}
  </div>

  <div class="mt-3 flex gap-2">
    <input
      bind:value={pkg}
      onkeydown={(e) => {
        if (e.key === "Enter") void doLaunch(pkg);
      }}
      placeholder={t("android.placeholder")}
      class="flex-1 rounded-full bg-neutral-200 px-3 py-2 text-sm outline-none dark:bg-neutral-800"
    />
    <button onclick={() => void doLaunch(pkg)} class="rounded-full bg-accent px-4 text-sm text-white">
      {t("android.launch")}
    </button>
  </div>
</div>
