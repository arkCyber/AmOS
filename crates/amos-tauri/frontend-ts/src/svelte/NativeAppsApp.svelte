<script lang="ts">
  // NativeAppsApp.svelte — 「原生应用」: the desktop's native application surface.
  //
  // Two sources, one list: Windows apps Wine can run (`wine_apps`) and native Linux
  // desktop apps (`linux_apps`). Both are **the host's own enumeration** — the screen
  // never invents an entry, and launching names an id the host listed (the trust
  // boundary in `lib/nativeApps.ts` / `crates/amos-tauri/src/{wine,linux_apps}.rs`).
  //
  // Honest states, never a blank frame (the rule `PwaHubApp` follows): "no bridge",
  // "Wine is not installed", "this host is not Linux" and "the host answered, and the
  // list is empty" are **four different sentences**.
  import {
    lastFailureReason,
    launchCommand,
    nativeApps,
    nativeAvailability,
    nativeLaunch,
    type NativeApp,
    type NativeAppKind,
    type NativeAvailability,
  } from "../lib/nativeApps";
  import { t } from "./locale.svelte";

  type Load =
    | { kind: "loading" }
    | { kind: "ok"; apps: NativeApp[]; availability: NativeAvailability }
    | { kind: "offline" };

  type Launch =
    | { kind: "idle" }
    | { kind: "busy"; id: string }
    | { kind: "started"; name: string }
    | { kind: "refused"; reason: string };

  let load = $state<Load>({ kind: "loading" });
  let launch = $state<Launch>({ kind: "idle" });

  const run = async () => {
    load = { kind: "loading" };
    // Availability first: it is what turns "no apps" into a *reason*.
    const availability = await nativeAvailability();
    if (availability === null) {
      load = { kind: "offline" };
      return;
    }
    const apps = await nativeApps();
    load = { kind: "ok", apps: apps ?? [], availability };
  };
  $effect(() => {
    void run();
  });

  const apps = $derived(load.kind === "ok" ? load.apps : []);
  const wineApps = $derived(apps.filter((a) => a.kind === "wine"));
  const linuxApps = $derived(apps.filter((a) => a.kind === "linux"));

  const start = async (app: NativeApp) => {
    launch = { kind: "busy", id: app.id };
    const name = await nativeLaunch(app.kind, app.id);
    // The host's refusal sentence is the useful part of a failure, and `invoke`
    // keeps it in the bridge ledger — show it rather than a generic error.
    launch =
      name === null
        ? { kind: "refused", reason: lastFailureReason(launchCommand(app.kind)) }
        : { kind: "started", name };
  };

  /** Is this surface even offered on this host? (Drives the empty-state wording.) */
  const available = (kind: NativeAppKind): boolean => {
    if (load.kind !== "ok") return false;
    return kind === "wine" ? load.availability.wine : load.availability.linux;
  };

  const emptyReasonKey = (kind: NativeAppKind): string =>
    available(kind) ? `native.empty.${kind}` : `native.unavailable.${kind}`;
</script>

<div
  class="flex h-full flex-col gap-3 overflow-y-auto overscroll-contain px-4 py-4 text-neutral-900 dark:text-neutral-100"
  data-testid="native-apps"
>
  <header class="flex items-baseline justify-between gap-2">
    <h1 class="text-[17px] font-semibold tracking-tight">{t("app.nativeapps")}</h1>
    {#if load.kind === "ok"}
      <span class="text-xs opacity-60" data-testid="native-count"
        >{t("native.count", { n: apps.length })}</span
      >
    {/if}
  </header>

  {#if load.kind === "loading"}
    <p class="py-8 text-center text-sm opacity-60" data-testid="native-loading">
      {t("native.loading")}
    </p>
  {:else if load.kind === "offline"}
    <div class="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4" data-testid="native-offline">
      <p class="text-sm font-semibold">{t("native.offline")}</p>
      <p class="mt-1 text-xs opacity-70">{t("native.offlineHint")}</p>
    </div>
  {:else}
    {#if launch.kind === "started"}
      <p
        class="rounded-xl bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"
        data-testid="native-started">{t("native.started", { name: launch.name })}</p
      >
    {:else if launch.kind === "refused"}
      <p
        class="break-words rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300"
        data-testid="native-refused">{t("native.refused", { reason: launch.reason })}</p
      >
    {/if}

    <p class="text-[11px] opacity-60" data-testid="native-scope">{t("native.scope")}</p>

    {#each [{ kind: "wine" as const, rows: wineApps }, { kind: "linux" as const, rows: linuxApps }] as section (section.kind)}
      <section data-testid={`native-section-${section.kind}`}>
        <h2 class="text-sm font-semibold">
          {t(`native.section.${section.kind}`, { n: section.rows.length })}
        </h2>
        {#if section.rows.length === 0}
          <p class="mt-1 text-xs opacity-60" data-testid={`native-empty-${section.kind}`}>
            {t(emptyReasonKey(section.kind))}
          </p>
        {:else}
          <ul class="mt-1 flex flex-col gap-2">
            {#each section.rows as app (app.id)}
              <li
                class="flex items-center justify-between gap-3 rounded-xl border border-black/10 bg-black/[0.03] px-3 py-2 dark:border-white/10 dark:bg-white/5"
                data-testid="native-row"
                data-app-id={app.id}
              >
                <span class="min-w-0">
                  <span class="block truncate text-sm font-medium">{app.name}</span>
                  <span class="block truncate font-mono text-[10px] opacity-50">{app.program}</span>
                </span>
                <button
                  type="button"
                  class="shrink-0 rounded-lg bg-black/5 px-3 py-1 text-xs font-medium disabled:opacity-40 dark:bg-white/10"
                  disabled={launch.kind === "busy"}
                  onclick={() => void start(app)}
                  data-testid="native-launch">{t("native.launch")}</button
                >
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  {/if}
</div>
