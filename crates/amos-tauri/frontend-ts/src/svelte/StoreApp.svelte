<script lang="ts">
  // StoreApp.svelte — Svelte 5 (runes) single-source implementation of the app
  // store screen. App Store over the amos-appstore bridge:
  // browse catalog + install/upgrade/uninstall; syncs home-screen tiles via
  // lib/storeApps. Offline (no bridge) shows a localized notice (testable here);
  // real catalog + lifecycle need the appstore daemon (device acceptance).
  import {
    bridged,
    storeCatalog,
    storeInstall,
    storeInstalled,
    storeUninstall,
    storeUpdatable,
    storeUpgrade,
    type AppManifest,
    type AppVersion,
    type InstalledApp,
  } from "../lib/backend";
  import { notifyStoreTilesChanged } from "../lib/storeApps";
  import { t } from "./locale.svelte";

  const online = $derived(bridged());
  let catalog = $state<AppManifest[] | null>(null);
  let installed = $state<InstalledApp[] | null>(null);
  let acting = $state<string | null>(null);

  const load = async () => {
    const [cat, inst, up] = await Promise.all([
      storeCatalog(),
      storeInstalled(),
      storeUpdatable(),
    ]);
    if (cat !== null) catalog = cat;
    if (inst !== null) installed = inst;
    // `null` = the host could not answer (offline / bridge error) → fall back below.
    updatableIds = up !== null ? new Set(up) : null;
  };
  $effect(() => {
    if (!online) return;
    void load();
  });

  const installedMap = $derived(new Map((installed ?? []).map((a) => [a.manifest.id, a])));

  /**
   * Ids the **host** reports as updatable (`appstore_updatable`), or `null` when it
   * could not answer. The semantic-version comparison — numeric, with pre-release
   * ordering — is owned by the `amos-appstore` domain (docs/appstore.md §"状态机"),
   * and the host is the one that actually knows the published releases, so its
   * answer is authoritative here.
   */
  let updatableIds = $state<Set<string> | null>(null);

  const run = async (action: () => Promise<unknown>, id: string) => {
    acting = id;
    try {
      await action();
    } finally {
      acting = null;
    }
    await load();
    notifyStoreTilesChanged();
  };

  /**
   * Fallback comparison used **only** when the host could not answer
   * (`updatableIds === null`): true when `a` is strictly older than `b`. Kept so an
   * older/partially-bridged host still shows the right affordance, but it must not
   * override the domain's own answer.
   */
  function verLt(a: AppVersion, b: AppVersion): boolean {
    if (a.major !== b.major) return a.major < b.major;
    if (a.minor !== b.minor) return a.minor < b.minor;
    if (a.patch !== b.patch) return a.patch < b.patch;
    const preA = a.pre != null;
    const preB = b.pre != null;
    if (preA !== preB) return preA;
    if (!preA) return false;
    return (a.pre ?? "") < (b.pre ?? "");
  }
  /** "1.2.0" from an `AppVersion` (major.minor.patch) for display. */
  function fmtVer(v: AppVersion): string {
    return `${v.major}.${v.minor}.${v.patch}`;
  }
</script>

{#if !online}
  <div class="p-6 text-center text-sm opacity-70">{t("store.offline")}</div>
{:else if catalog === null}
  <div class="p-6 text-center text-sm opacity-50">…</div>
{:else if catalog.length === 0}
  <div class="p-6 text-center text-sm opacity-70">{t("store.empty")}</div>
{:else}
  <div class="p-4">
    <div class="px-1 pb-2 text-[11px] uppercase tracking-wide opacity-50">
      {t("store.tagline")}
    </div>
    <div class="space-y-2">
      {#each catalog as app (app.id)}
        {@const own = installedMap.get(app.id)}
        {@const updatable =
          updatableIds !== null
            ? updatableIds.has(app.id)
            : own !== undefined && verLt(own.manifest.version, app.version)}
        {@const busy = acting === app.id}
        {@const verLabel = fmtVer(app.version)}
        <div class="rounded-2xl bg-white/60 p-3 shadow-sm ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate text-sm font-medium">{app.name}</div>
              <div class="mt-0.5 truncate text-[11px] opacity-50">
                {app.id} · {app.author} · {t("store.version", { version: verLabel })}
              </div>
              <div class="mt-1 text-xs opacity-70">{app.summary || "—"}</div>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              {#if own && !updatable}
                <span class="rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-600 dark:text-green-400">
                  {t("store.installed")}
                </span>
              {/if}
              {#if updatable}
                <button
                  disabled={busy}
                  onclick={() => void run(() => storeUpgrade(app.id), app.id)}
                  class="rounded-full bg-accent px-3 py-1 text-xs text-white disabled:opacity-40"
                >
                  {busy ? "…" : t("store.update")}
                </button>
              {/if}
              {#if !own}
                <button
                  disabled={busy}
                  onclick={() => void run(() => storeInstall(app.id), app.id)}
                  class="rounded-full bg-accent px-3 py-1 text-xs text-white disabled:opacity-40"
                >
                  {busy ? "…" : t("store.install")}
                </button>
              {/if}
              {#if own}
                <button
                  disabled={busy}
                  onclick={() => void run(() => storeUninstall(app.id), app.id)}
                  aria-label={t("store.uninstall")}
                  class="rounded-full bg-neutral-200 px-2.5 py-1 text-xs opacity-70 disabled:opacity-40 dark:bg-neutral-700"
                >
                  ✕
                </button>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
    <div class="mt-4 rounded-2xl bg-white/40 px-3 py-2 text-[11px] opacity-60 dark:bg-white/[0.04]">
      {t("store.myApps")}: {installed?.length ?? 0}
    </div>
  </div>
{/if}

