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
  // list is empty" are four different sentences — and, since REQ-A836 / F-SH-266, so is
  // "the host did not answer this enumeration", **per kind**.
  import {
    lastFailureReason,
    launchCommand,
    nativeApps,
    nativeAvailability,
    nativeLaunch,
    type NativeApp,
    type NativeAppKind,
    type NativeAppsRead,
    type NativeAvailability,
  } from "../lib/nativeApps";
  import { t } from "./locale.svelte";

  type Load =
    | { kind: "loading" }
    | { kind: "ok"; read: NativeAppsRead; availability: NativeAvailability }
    | { kind: "offline" }
    /**
     * Neither enumeration answered (REQ-A836 / F-SH-266). It needs its own arm because
     * folding it into an empty list reaches the per-section empty state, whose sentence
     * is `native.empty.wine` — 《Wine 已安装，但它的前缀里没有可启动的 Windows 应用》—
     * a positive claim about the host's filesystem made from a refused read.
     * `native.offlineHint` right up the road forbids exactly that: 「既不显示应用，也不
     * 假装成「本机没有应用」」. The honest sentence was already shipped; the fold put it
     * out of reach. A **single** kind refusing keeps its own section honest instead —
     * `read[kind] === null` → `native.appsUnconfirmed`, see `rowsOf` below.
     */
    | { kind: "unconfirmed" };

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
    const read = await nativeApps();
    // Never a `?? []` on this read: `invoke` answers `null` for a refused command, so
    // the fold turns "we could not enumerate" into "there is nothing to enumerate" and
    // hands it to the empty-state wording (REQ-A836 / F-SH-266).
    load = read === null ? { kind: "unconfirmed" } : { kind: "ok", read, availability };
  };
  $effect(() => {
    void run();
  });

  /**
   * One kind's rows, or `null` when the host did not answer that enumeration. The
   * `null` must survive all the way to the wording — that is the whole point of the
   * per-kind read.
   */
  const rowsOf = (kind: NativeAppKind): NativeApp[] | null =>
    load.kind === "ok" ? load.read[kind] : null;
  const wineApps = $derived(rowsOf("wine") ?? []);
  const linuxApps = $derived(rowsOf("linux") ?? []);
  /** The count is only a count when both enumerations answered (a lower bound is not one). */
  const total = $derived(
    load.kind === "ok" && load.read.wine !== null && load.read.linux !== null
      ? load.read.wine.length + load.read.linux.length
      : null,
  );

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

  /**
   * Is this surface even offered on this host? (Drives the empty-state wording.)
   * `null` is the third answer — the host did not reply to **that** probe — and it must
   * not be folded into `false` here: the wording below turns `false` into a positive
   * statement about the machine (REQ-A1363 / F-SH-627).
   */
  const available = (kind: NativeAppKind): boolean | null => {
    if (load.kind !== "ok") return null;
    return load.availability[kind];
  };

  /**
   * The sentence under an empty section. Three answers, three sentences: the host said
   * yes (it can run these, and found none), said no (it cannot), or did not answer the
   * probe at all — and only the first two license a claim about this machine.
   */
  const emptyReasonKey = (kind: NativeAppKind): string => {
    const offered = available(kind);
    if (offered === null) return "native.availabilityUnconfirmed";
    return offered ? `native.empty.${kind}` : `native.unavailable.${kind}`;
  };
</script>

<div
  class="flex h-full flex-col gap-3 overflow-y-auto overscroll-contain px-4 py-4 text-neutral-900 dark:text-neutral-100"
  data-testid="native-apps"
>
  <header class="flex items-baseline justify-between gap-2">
    <h1 class="text-[17px] font-semibold tracking-tight">{t("app.nativeapps")}</h1>
    {#if total !== null}
      <span class="text-xs opacity-60" data-testid="native-count"
        >{t("native.count", { n: total })}</span
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
  {:else if load.kind === "unconfirmed"}
    <div
      class="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"
      data-testid="native-unconfirmed"
    >
      <p class="text-sm font-semibold">{t("native.appsUnconfirmed")}</p>
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

    {#each [{ kind: "wine" as const, rows: wineApps, asked: rowsOf("wine") !== null }, { kind: "linux" as const, rows: linuxApps, asked: rowsOf("linux") !== null }] as section (section.kind)}
      <section data-testid={`native-section-${section.kind}`}>
        <h2 class="text-sm font-semibold">
          <!-- A refused kind has no count, and `0` would be one (REQ-A836 / F-SH-266). -->
          {t(`native.section.${section.kind}`, { n: section.asked ? section.rows.length : "—" })}
        </h2>
        {#if !section.asked}
          <!-- This kind's enumeration was refused: say that, and do not borrow a
               sentence that makes a claim about the machine (REQ-A836 / F-SH-266). -->
          <p class="mt-1 text-xs opacity-60" data-testid={`native-unasked-${section.kind}`}>
            {t("native.appsUnconfirmed")}
          </p>
        {:else if section.rows.length === 0}
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
