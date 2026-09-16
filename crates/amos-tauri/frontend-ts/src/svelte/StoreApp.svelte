<script lang="ts">
  // StoreApp.svelte — Svelte 5 (runes) single-source implementation of the app
  // store screen. App Store over the amos-appstore bridge:
  // browse catalog + install/upgrade/uninstall; syncs home-screen tiles via
  // lib/storeApps. Offline (no bridge) shows a localized notice (testable here);
  // real catalog + lifecycle need the appstore daemon (device acceptance).
  import {
    bridged,
    bridgeDiag,
    storeCatalog,
    storeInstall,
    storeInstalled,
    storeSearch,
    storeUninstall,
    storeUpdatable,
    storeUpgrade,
    type AppManifest,
    type AppVersion,
    type InstalledApp,
  } from "../lib/backend";
  import { notifyStoreTilesChanged } from "../lib/storeApps";
  import { searchQueryOf } from "../lib/storeSearch";
  import { t } from "./locale.svelte";

  const online = $derived(bridged());
  let catalog = $state<AppManifest[] | null>(null);
  let installed = $state<InstalledApp[] | null>(null);
  let acting = $state<string | null>(null);
  // ---- catalog search (REQ-A315) --------------------------------------------
  // The daemon owns catalog search (`appstore_search`); this screen had never called it,
  // so a big catalog could only be scrolled — an app that *is* published was
  // indistinguishable from one that is not. `results === null` means **browsing** (the
  // full catalog); a real search always sets an array, even an empty one, so "no match"
  // and "not searched" can never be confused.
  let query = $state("");
  let results = $state<AppManifest[] | null>(null);
  let searchErr = $state<string | null>(null);
  let searching = $state(false);
  // Last mutation error (translated message for display). Cleared on next
  // successful mutation, and shown next to the app row that failed (REQ-A268 —
  // AppStore install/upgrade/uninstall now surface typed errors instead of
  // swallowing them into `null`).
  let actingError = $state<string | null>(null);

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
   * Run the catalog search the user asked for.
   *
   * Three outcomes are kept **distinct** on purpose:
   *  * a real reply — even an empty one ⇒ results ("no matches" is a fact);
   *  * a refusal ⇒ the search says it failed and shows **no** list (never "no matches");
   *  * an empty/whitespace box ⇒ browsing again, with no round-trip at all.
   *
   * A refusal reaches us in one of two shapes, and both are checked (the same rule
   * `run()` uses): a plain `String` error **rejects** the invoke, while a typed
   * `AmosError` resolves `null` and is only visible in the diagnostic ledger (REQ-A296).
   * Either way the previous results are dropped: a stale list under a new query would
   * read as that query's answer.
   */
  const runSearch = async (): Promise<void> => {
    const q = searchQueryOf(query);
    if (q === null) {
      results = null;
      searchErr = null;
      return;
    }
    searching = true;
    searchErr = null;
    // REQ-A297 phase-2 §4 cont.3: `storeSearch` returns `AppManifest[] | null`
    // and never rejects (REQ-A296 — `invoke` swallows rejections into `null`).
    // The previous `try { ... } catch { rejected = true; }` was dead code:
    // the catch branch was unreachable, and the `rejected` flag would never
    // flip. The post-fix code folds the dead branch into the `reply === null`
    // check that already existed below — one path, one source of truth.
    const reply = await storeSearch(q);
    const diag = bridgeDiag("appstore_search");
    // `BridgeDiag` is a union: narrow on `ok` first (the same shape `run()` uses).
    let code = "";
    if (!diag.ok && diag.kind === "command-failed" && typeof diag.detail === "object" && diag.detail) {
      code = (diag.detail as { code?: string }).code ?? "";
    }
    if (reply === null) {
      results = null;
      // Known codes get a localized line; anything else says "the search did not run"
      // rather than leaking the host's own (English, path-shaped) reason.
      searchErr = labelForCode(code) ?? t("store.searchFailed");
    } else {
      results = reply;
    }
    searching = false;
  };
  const clearSearch = (): void => {
    query = "";
    results = null;
    searchErr = null;
  };
  /** What the list shows: search results when searching, else the whole catalog. */
  const rows = $derived(results ?? catalog ?? []);

  /**
   * Ids the **host** reports as updatable (`appstore_updatable`), or `null` when it
   * could not answer. The semantic-version comparison — numeric, with pre-release
   * ordering — is owned by the `amos-appstore` domain (docs/appstore.md §"状态机"),
   * and the host is the one that actually knows the published releases, so its
   * answer is authoritative here.
   */
  let updatableIds = $state<Set<string> | null>(null);

  const run = async (action: () => Promise<unknown>, id: string, command: string) => {
    acting = id;
    actingError = null;
    try {
      await action();
    } finally {
      acting = null;
    }
    // If the bridge rejected the mutation (typed error envelope), surface it.
    // The contract is: any Tauri `AmosError` produced by a `#[tauri::command]`
    // becomes `null` from `invoke()`'s perspective — but the diagnostic ledger
    // (REQ-A296) carries the error code/message. We translate the code (i18n
    // lookup) and fall back to the message for codes we don't localise.
    const diag = bridgeDiag(command);
    if (!diag.ok) {
      const detail =
        diag.kind === "command-failed" && typeof diag.detail === "object" && diag.detail
          ? (diag.detail as { code?: string; message?: string })
          : null;
      const code = detail?.code ?? "";
      const message = detail?.message ?? t("store.errorGeneric");
      // Map known codes to localised labels; fall back to the raw message so
      // an unmapped code still says what went wrong (instead of "failed").
      const label = labelForCode(code) ?? message;
      actingError = `${appNameById(id)}: ${label}`;
    }
    await load();
    notifyStoreTilesChanged();
  };

  /**
   * Map a backend error code (e.g. "amos.appstore.id_too_long") to a
   * translated, user-facing label. Falls back to `null` for codes we don't
   * localise so the caller can render the raw message instead.
   */
  function labelForCode(code: string): string | null {
    switch (code) {
      case "amos.appstore.id_empty":
        return t("store.errorIdEmpty");
      case "amos.appstore.id_too_long":
        return t("store.errorIdTooLong");
      case "amos.appstore.id_invalid":
        return t("store.errorIdInvalid");
      case "amos.appstore.install_failed":
        return t("store.errorInstallFailed");
      case "amos.appstore.upgrade_failed":
        return t("store.errorUpgradeFailed");
      case "amos.appstore.uninstall_failed":
        return t("store.errorUninstallFailed");
      case "amos.appstore.rpc_failed":
        return t("store.errorRpcFailed");
      default:
        return null;
    }
  }

  function appNameById(id: string): string {
    // `installedMap.get(id)` is `InstalledApp` (which nests `manifest`), while
    // catalog entries are flat `AppManifest`. Both surface a display `name`.
    const fromInstalled = installedMap.get(id)?.manifest.name;
    if (fromInstalled) return fromInstalled;
    const fromCatalog = catalog?.find((m) => m.id === id)?.name;
    return fromCatalog ?? id;
  }

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
    <!-- Catalog search (REQ-A315). The daemon owns the matching; this row only asks. -->
    <div class="mb-2 flex items-center gap-2">
      <input
        bind:value={query}
        onkeydown={(e) => {
          if (e.key === "Enter") void runSearch();
        }}
        placeholder={t("store.searchPlaceholder")}
        aria-label={t("store.searchPlaceholder")}
        data-testid="store-search"
        class="min-w-0 flex-1 rounded-full bg-neutral-200 px-3 py-1.5 text-sm outline-none dark:bg-neutral-800"
      />
      {#if results !== null || query !== ""}
        <button
          onclick={clearSearch}
          aria-label={t("store.searchClear")}
          data-testid="store-search-clear"
          class="shrink-0 rounded-full bg-neutral-300 px-3 py-1.5 text-xs dark:bg-neutral-700"
        >{t("store.searchClear")}</button>
      {/if}
      <button
        onclick={() => void runSearch()}
        disabled={searching}
        aria-label={t("store.searchAction")}
        data-testid="store-search-run"
        class="shrink-0 rounded-full bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
      >{t("store.searchAction")}</button>
    </div>
    {#if searchErr}
      <p data-testid="store-search-error" role="alert" class="mb-2 px-1 text-xs text-danger">{searchErr}</p>
    {/if}
    {#if results !== null}
      <p data-testid="store-search-count" role="status" class="px-1 pb-2 text-[11px] uppercase tracking-wide opacity-50">
        {t("store.searchResults", { n: results.length })}
      </p>
    {/if}
    <div class="px-1 pb-2 text-[11px] uppercase tracking-wide opacity-50">
      {t("store.tagline")}
    </div>
    {#if results !== null && results.length === 0}
      <!-- A real, empty result set: the catalog has no match for this query. Never the
           same wording as "the catalog is empty" (that is a different fact). -->
      <div data-testid="store-search-empty" class="p-6 text-center text-sm opacity-70">
        {t("store.searchEmpty")}
      </div>
    {:else}
    <div class="space-y-2">
      {#each rows as app (app.id)}
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
                  onclick={() => void run(() => storeUpgrade(app.id), app.id, "appstore_upgrade")}
                  class="rounded-full bg-accent px-3 py-1 text-xs text-white disabled:opacity-40"
                >
                  {busy ? "…" : t("store.update")}
                </button>
              {/if}
              {#if !own}
                <button
                  disabled={busy}
                  onclick={() => void run(() => storeInstall(app.id), app.id, "appstore_install")}
                  class="rounded-full bg-accent px-3 py-1 text-xs text-white disabled:opacity-40"
                >
                  {busy ? "…" : t("store.install")}
                </button>
              {/if}
              {#if own}
                <button
                  disabled={busy}
                  onclick={() => void run(() => storeUninstall(app.id), app.id, "appstore_uninstall")}
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
    {/if}
    <div class="mt-4 rounded-2xl bg-white/40 px-3 py-2 text-[11px] opacity-60 dark:bg-white/[0.04]">
      {t("store.myApps")}: {installed?.length ?? 0}
    </div>
    {#if actingError}
      <div
        role="alert"
        data-testid="store-error"
        class="mt-3 rounded-2xl bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300"
      >
        {actingError}
      </div>
    {/if}
  </div>
{/if}

