<script lang="ts">
  // DeviceCareApp.svelte — Svelte 5 (runes) dock app「手机管家」(Device Care).
  //
  // Surfaces the `amos-devocare` domain through the Tauri `devcare_*` bridge:
  // junk scan + one-tap clean, the uninstall safety policy, the read-only
  // permission review, and the folded care report.
  //
  // Honesty rules baked in (mirroring the Rust kernel):
  //  • no backend ⇒ an explicit "not connected" state, never an empty "healthy" device;
  //  • the care score is only shown when the report actually observed something
  //    (`reportHasData`), otherwise "no data" — never "100 / grade A";
  //  • a partial clean is reported as partial (freed bytes + failure count);
  //  • the screen only ever sends **category keys** to `devcare_clean`, never a path.
  import { onMount } from "svelte";
  import { bridged } from "../lib/backend";
  import {
    areaLabelKey,
    auditComplete,
    careAreaSplit,
    devcareApps,
    devcareBoost,
    devcareClean,
    devcarePermissions,
    devcareMemory,
    devcareReport,
    devcareScan,
    devcareStatus,
    devcareStorage,
    devcareTrail,
    devcareUninstall,
    hhmm,
    junkKindLabelKey,
    memUsedBytes,
    opLabelKey,
    outcomeLabelKey,
    permReviewAuthoritative,
    reportHasData,
    resourceLabelKey,
    severityLabelKey,
    validateCleanRequest,
    type AppView,
    type AuditStatusView,
    type DevCareStatusView,
    type MemoryView,
    type PermReviewView,
    type ReportView,
    type ScanView,
    type StorageView,
    type TrailView,
  } from "../lib/devcare";
  import { fmtBytes } from "../lib/system";
  import { t } from "./locale.svelte";

  const CARD =
    "overflow-hidden rounded-[14px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const BTN = "rounded-full bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40";
  const SOFT =
    "rounded-full bg-neutral-200 px-2.5 py-1 text-xs opacity-70 disabled:opacity-40 dark:bg-neutral-700";
  const LABEL = "text-[10px] uppercase tracking-wider opacity-50";

  let bridgedNow = $state(bridged());
  let available = $state(false);
  /** The bridge status (carries `last_error` — never silently dropped). */
  let status = $state<DevCareStatusView | null>(null);
  let scan = $state<ScanView | null>(null);
  /** True when the scan itself failed (must NOT look like "nothing to clean"). */
  let scanErr = $state(false);
  let report = $state<ReportView | null>(null);
  /** The storage overview (device totals + reclaimable breakdown). */
  let storage = $state<StorageView | null>(null);
  /** True when the storage read failed (must NOT look like a `0 B` device). */
  let storageErr = $state(false);
  let apps = $state<AppView[]>([]);
  /** True when the inventory could not be read (never shown as "no apps"). */
  let appsErr = $state(false);
  let perms = $state<PermReviewView | null>(null);
  /** The device-care slice of the unified audit trail. */
  let trail = $state<TrailView | null>(null);
  /** True when the trail could not be read (never shown as "no records"). */
  let trailErr = $state(false);
  /** The memory view (sampler reading + the governor's reclaim targets). */
  let mem = $state<MemoryView | null>(null);
  let boosting = $state(false);
  let boostNote = $state<{ key: string; params?: Record<string, string | number> } | null>(null);
  let selected = $state<string[]>([]);
  let acknowledge = $state(false);
  let busy = $state(false);
  let cleaning = $state(false);
  let acting = $state<string | null>(null);
  let notice = $state<{ key: string; params?: Record<string, string | number> } | null>(null);
  /** Whether the last action reached the daemon's unified audit trail. */
  let audit = $state<AuditStatusView | null>(null);
  let disposed = false;

  const observed = $derived(reportHasData(report));
  /**
   * Which areas the report actually observed, and which it did not.
   *
   * A partial report must say so: the score certifies only what was seen, so
   * rendering a grade with no hint that (e.g.) the battery was never measured
   * would be "unknown shown as healthy" (aerospace P0-3).
   */
  const areas = $derived(careAreaSplit(report));
  const gradeBig = $derived(observed ? String(report?.score ?? 0) : "—");
  const gradeTag = $derived(
    observed ? (report?.grade ?? "?").toUpperCase() : t("care.unknown"),
  );
  const grantCount = $derived(
    (perms?.rows ?? []).reduce((n, r) => n + r.resources.length, 0),
  );
  /**
   * The grant count to hand the report: `null` unless the **authority** answered.
   *
   * `grantCount` is `0` both when the daemon says "nothing is granted" *and* when
   * it could not be reached — and only the former is an observation. Passing the
   * `0` of an unreachable daemon would invent one, mark the permission area as
   * assessed and let the care score certify a healthy permission state
   * (P0-3: unknown ≠ healthy).
   */
  const grantsObserved = $derived(permReviewAuthoritative(perms) ? grantCount : null);

  async function loadApps() {
    // The inventory is bridge-owned: the UI never supplies packages, so the
    // preview and the enforcement cannot disagree.
    const rows = await devcareApps();
    if (disposed) return;
    // `null` means the read failed (not bridged / registry unreadable). That is
    // NOT the same as "no apps": an empty list would be a silent failure.
    appsErr = rows === null;
    apps = rows ?? [];
  }

  async function loadPerms() {
    // The **daemon** is the authority for grants; a frontend-local ledger can
    // disagree with it, so the manager never presents a local cache as "who
    // holds what".
    const review = await devcarePermissions();
    if (disposed) return;
    // `null` (not bridged) leaves `perms` null ⇒ not authoritative ⇒ the UI
    // says "unavailable" instead of "nothing is granted".
    perms = review;
  }

  async function loadTrail() {
    const rows = await devcareTrail(20);
    if (disposed) return;
    // `null` means the read failed (not bridged / daemon unreachable). An empty
    // list would be a silent failure.
    trailErr = rows === null;
    trail = rows;
  }

  async function loadMemory() {
    const view = await devcareMemory();
    if (disposed) return;
    mem = view;
  }

  async function loadStorage() {
    // The filesystem totals come from the backend; `null` is a read failure and
    // `measured: false` means no backend could read them — both must render as
    // unknown, never as `0 B`.
    const view = await devcareStorage();
    if (disposed) return;
    storageErr = view === null;
    storage = view;
  }

  /**
   * Ask the governor to reclaim its cached/background apps.
   *
   * The manager only *requests* the reclaim; the governor owns every lifecycle
   * transition, so the result says what it accepted and the readings around it —
   * never that we "freed N MB".
   */
  async function boost() {
    boosting = true;
    const out = await devcareBoost();
    boosting = false;
    if (disposed) return;
    if (out === null || !out.governor) {
      boostNote = { key: "care.memoryNoGovernor" };
      // No boost happened ⇒ nothing was (or could be) audited.
      audit = null;
    } else if (out.failures.length > 0) {
      boostNote = {
        key: "care.boostPartial",
        params: { n: out.reclaimed, failed: out.failures.length },
      };
      audit = out.audit;
    } else {
      boostNote = { key: "care.boosted", params: { n: out.reclaimed } };
      audit = out.audit;
    }
    await loadMemory();
  }

  async function refresh() {
    if (!bridged()) {
      bridgedNow = false;
      available = false;
      return;
    }
    bridgedNow = true;
    busy = true;
    const st = await devcareStatus();
    status = st;
    available = st?.available ?? false;
    await loadApps();
    await loadPerms();
    await loadTrail();
    await loadMemory();
    await loadStorage();
    if (available) {
      const s = await devcareScan();
      // A failed scan is an ERROR, not an empty device: `scan` stays null and we
      // say so rather than rendering "nothing to clean".
      scanErr = s === null;
      scan = s;
      selected = s ? [...s.auto_kinds] : [];
      acknowledge = false;
      // Both counts are `null` unless the source actually answered: an unread
      // inventory / an unreachable daemon is NOT an observation of zero.
      report = await devcareReport(
        grantsObserved,
        appsErr ? null : apps.length,
      );
    } else {
      scan = null;
      scanErr = false;
      report = null;
    }
    busy = false;
  }

  function toggleKind(kind: string) {
    selected = selected.includes(kind)
      ? selected.filter((k) => k !== kind)
      : [...selected, kind];
  }

  async function clean() {
    const problem = validateCleanRequest(selected, acknowledge);
    if (problem) {
      notice = { key: problem };
      audit = null;
      return;
    }
    cleaning = true;
    const out = await devcareClean(selected, acknowledge);
    cleaning = false;
    if (disposed) return;
    if (out === null) {
      // Honest: nothing is claimed to have been freed.
      notice = { key: "care.cleanFailed" };
      audit = null;
      return;
    }
    notice = out.partial
      ? {
          key: "care.cleanPartial",
          params: { size: fmtBytes(out.freed_bytes), n: out.failed },
        }
      : { key: "care.cleaned", params: { size: fmtBytes(out.freed_bytes) } };
    audit = out.audit;
    await refresh();
  }

  /**
   * Uninstall through the device-care policy (guard enforced in Rust) so every
   * removal — and every refusal — reaches the unified audit trail.
   */
  async function uninstall(id: string) {
    acting = id;
    const out = await devcareUninstall(id);
    acting = null;
    if (disposed) return;
    if (out === null) {
      notice = { key: "care.uninstallFailed" };
      audit = null;
    } else {
      audit = out.audit;
      if (out.removed) {
        notice = { key: "care.uninstalled", params: { name: id } };
      } else if (out.launched) {
        // Honest: the platform took the request and confirms asynchronously, so
        // we must not claim the app is gone.
        notice = { key: "care.uninstallLaunched", params: { name: id } };
      } else {
        notice = {
          key:
            out.reason_key ??
            (out.verdict === "unknown" ? "care.notInstalled" : "care.uninstallFailed"),
        };
      }
    }
    await refresh();
  }

  onMount(() => {
    void refresh();
    return () => {
      disposed = true;
    };
  });
</script>

{#if !bridgedNow}
  <div class="p-6 text-center text-sm opacity-70" data-testid="devcare-offline">
    <div>{t("care.offline")}</div>
    <div class="mt-1 text-[11px] opacity-60">{t("care.offlineHint")}</div>
  </div>
{:else}
  <div class="space-y-3 p-4">
    <!-- Care score + backend -->
    <div class={CARD} data-testid="devcare-overview">
      <div class="flex items-end justify-between gap-3 p-3">
        <div class="flex items-baseline gap-2">
          <span
            class="text-[28px] font-semibold leading-none tabular-nums text-neutral-900 dark:text-white"
            data-testid="devcare-score">{gradeBig}</span
          >
          <span class="text-xs opacity-60" data-testid="devcare-grade">{gradeTag}</span>
        </div>
        <div class="text-right text-[11px] opacity-60">
          <div data-testid="devcare-backend">
            {t("care.backend")}:
            {available ? (scan?.status.backend ?? "host-fs") : t("care.backendNone")}
          </div>
          <div>{t("care.items", { n: scan?.report.total_items ?? 0 })}</div>
        </div>
      </div>
      {#if observed}
        <!-- Which areas the grade actually certifies. A partial report must not
             look like a fully-assessed healthy device (aerospace P0-3). -->
        <div class="px-3 pb-2 text-[11px] opacity-70" data-testid="devcare-areas">
          <span data-testid="devcare-areas-observed">
            {t("care.assessed")}:
            {areas.observed.map((a) => t(areaLabelKey(a))).join(" · ")}
          </span>
          {#if areas.missing.length > 0}
            <span class="ml-2 text-amber-600" data-testid="devcare-areas-missing">
              {t("care.notAssessed")}:
              {areas.missing.map((a) => t(areaLabelKey(a))).join(" · ")}
            </span>
          {/if}
        </div>
      {/if}
      {#if !available}
        <div class="px-3 pb-3 text-[11px] opacity-70" data-testid="devcare-unavailable">
          {t("care.offlineHint")}
        </div>
      {:else}
        {#if status?.last_error}
          <div
            class="px-3 pb-2 text-[11px] text-amber-600"
            data-testid="devcare-last-error"
            title={status.last_error}
          >
            {t("care.backendError")}
          </div>
        {/if}
        {#if scan && scan.status.unreadable_dirs > 0}
          <div class="px-3 pb-2 text-[11px] text-amber-600" data-testid="devcare-partial">
            {t("care.partialScan", { n: scan.status.unreadable_dirs })}
          </div>
        {/if}
        <div class="flex items-center gap-2 px-3 pb-3">
          <button
            class={SOFT}
            disabled={busy}
            onclick={() => void refresh()}
            data-testid="devcare-rescan"
          >
            {busy ? t("care.scanning") : t("care.rescan")}
          </button>
        </div>
      {/if}
    </div>

    <!-- Storage overview: device totals (StatFs on a device) + reclaimable
         breakdown. `measured: false` renders as unknown, never `0 B`. -->
    <div class={CARD} data-testid="devcare-storage">
      <div class={`flex items-center justify-between px-3 pt-3 ${LABEL}`}>
        <span>{t("care.storage")}</span>
        <span class="normal-case tracking-normal opacity-70">{storage?.backend ?? ""}</span>
      </div>
      {#if storageErr}
        <div class="p-3 text-xs text-amber-600" data-testid="devcare-storage-error">
          {t("care.storageFailed")}
        </div>
      {:else if !storage?.measured}
        <div class="p-3 text-xs opacity-60" data-testid="devcare-storage-unknown">
          {t("care.storageUnknown")}
        </div>
      {:else}
        <div class="p-3">
          <div class="flex items-baseline justify-between text-[11px] opacity-70">
            <span>{t("care.storageUsed", { size: fmtBytes(storage?.used_bytes ?? 0) })}</span>
            <span>{t("care.storageTotal", { size: fmtBytes(storage?.total_bytes ?? 0) })}</span>
          </div>
          <div class="mt-1 h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
            <div
              class="h-full rounded-full bg-accent"
              style={`width: ${storage?.used_pct ?? 0}%`}
              data-testid="devcare-storage-bar"
            ></div>
          </div>
          <div class="mt-1 flex items-baseline justify-between text-[10px] opacity-60">
            <span data-testid="devcare-storage-pct">
              {storage?.used_pct === null ? "—" : `${storage?.used_pct}%`}
            </span>
            <span>{t("care.storageFree", { size: fmtBytes(storage?.free_bytes ?? 0) })}</span>
          </div>
          {#if (storage?.groups.length ?? 0) > 0}
            <div class="mt-2 space-y-0.5">
              {#each storage?.groups ?? [] as g (g.kind)}
                <div
                  class="flex items-center justify-between text-[11px]"
                  data-testid={`devcare-storage-${g.kind}`}
                >
                  <span class="truncate opacity-70">{t(junkKindLabelKey(g.kind))}</span>
                  <span class="tabular-nums opacity-60">{fmtBytes(g.bytes)}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    {#if available}
      {#if observed && (report?.findings.length ?? 0) > 0}
        <div class={CARD} data-testid="devcare-findings">
          <div class={`px-3 pt-3 ${LABEL}`}>{t("care.findings")}</div>
          <ul class="space-y-1 p-3">
            {#each report?.findings ?? [] as f (f.key + (f.detail ?? ""))}
              <li class="flex items-start gap-2 text-xs" data-testid="devcare-finding">
                <span
                  class="shrink-0 rounded-full bg-black/[0.06] px-2 py-0.5 text-[10px] dark:bg-white/[0.08]"
                  data-testid="devcare-severity"
                >
                  {t(severityLabelKey(f.severity))}
                </span>
                <span class="min-w-0 flex-1">
                  {t(f.key)}<span class="opacity-50"> · {t(areaLabelKey(f.area))}</span>
                </span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <div class={CARD} data-testid="devcare-junk">
        <div class="flex items-center justify-between px-3 pt-3">
          <span class={LABEL}>{t("care.reclaimable")}</span>
          <span class="text-xs tabular-nums opacity-70">
            {scanErr ? "—" : fmtBytes(scan?.report.reclaimable_bytes ?? 0)}
          </span>
        </div>
        {#if scanErr}
          <div class="p-3 text-xs text-amber-600" data-testid="devcare-junk-error">
            {t("care.scanFailed")}
          </div>
        {:else if (scan?.report.groups.length ?? 0) === 0}
          <div class="p-3 text-xs opacity-60" data-testid="devcare-junk-empty">
            {t("care.nothingToClean")}
          </div>
        {:else}
          <div class="space-y-1 p-3">
            {#each scan?.report.groups ?? [] as g (g.kind)}
              <label class="flex items-center gap-2 text-xs" data-testid={`devcare-group-${g.kind}`}>
                <input
                  type="checkbox"
                  checked={selected.includes(g.kind)}
                  onchange={() => toggleKind(g.kind)}
                />
                <span class="min-w-0 flex-1 truncate">{t(junkKindLabelKey(g.kind))}</span>
                {#if !(scan?.auto_kinds ?? []).includes(g.kind)}
                  <span class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-600">
                    {t("care.needsReview")}
                  </span>
                {/if}
                <span class="shrink-0 tabular-nums opacity-60">
                  {t("care.items", { n: g.count })} · {fmtBytes(g.bytes)}
                </span>
              </label>
            {/each}
          </div>
          {#if selected.includes("stale_download")}
            <label class="flex items-center gap-2 px-3 pb-2 text-[11px]">
              <input type="checkbox" bind:checked={acknowledge} data-testid="devcare-ack" />
              <span>{t("care.needsReview")}</span>
            </label>
          {/if}
          <div class="flex items-center gap-2 px-3 pb-3">
            <button
              class={BTN}
              disabled={cleaning || selected.length === 0}
              onclick={() => void clean()}
              data-testid="devcare-clean"
            >
              {cleaning ? t("care.cleaning") : t("care.clean")}
            </button>
          </div>
        {/if}
        {#if notice}
          <div class="px-3 pb-3 text-[11px] opacity-80" data-testid="devcare-notice">
            {t(notice.key, notice.params)}
          </div>
        {/if}
        {#if audit && audit.attempted > 0}
          <div
            class="px-3 pb-3 text-[11px] opacity-60"
            data-testid="devcare-audit"
            title={audit.reason ?? ""}
          >
            {auditComplete(audit)
              ? `${t("care.audited")} (${audit.recorded}/${audit.attempted})`
              : t("care.notAudited")}
          </div>
        {/if}
      </div>

      <div class={CARD} data-testid="devcare-apps">
        <div class="flex items-center justify-between gap-2 px-3 pt-3">
          <span class={LABEL}>{t("care.apps")}</span>
          {#if !appsErr && apps.length > 0}
            <span class="text-[10px] tabular-nums opacity-50" data-testid="devcare-apps-count">
              {t("care.appsCount", { n: apps.length })}
            </span>
          {/if}
        </div>
        {#if appsErr}
          <div class="p-3 text-xs text-amber-600" data-testid="devcare-apps-error">
            {t("care.appsUnavailable")}
          </div>
        {:else if apps.length === 0}
          <div class="p-3 text-xs opacity-60" data-testid="devcare-apps-empty">
            {t("care.appsEmpty")}
          </div>
        {:else}
          <!-- Bounded, independently scrollable list: a device has hundreds of
               packages, and letting them all flow into the page makes the manager
               a several-screen scroll before you reach permissions/memory. The
               window keeps *every* row reachable without pushing the rest of the
               page away. -->
          <div
            class="max-h-72 space-y-1 overflow-y-auto overscroll-contain p-3"
            data-testid="devcare-apps-scroll"
          >
            {#each apps as a (a.id)}
              <div class="flex items-center gap-2 text-xs" data-testid={`devcare-app-${a.id}`}>
                <span class="min-w-0 flex-1 truncate">{a.name}</span>
                <span class="tabular-nums opacity-60">
                  {a.size_bytes === null ? "—" : fmtBytes(a.size_bytes)}
                </span>
                {#if a.verdict === "allowed"}
                  <button
                    class={SOFT}
                    disabled={acting === a.id}
                    onclick={() => void uninstall(a.id)}
                    data-testid={`devcare-uninstall-${a.id}`}
                  >
                    {t("care.uninstall")}
                  </button>
                {:else}
                  <span
                    class="shrink-0 rounded-full bg-black/[0.06] px-2 py-0.5 text-[10px] opacity-70 dark:bg-white/[0.08]"
                    data-testid={`devcare-verdict-${a.id}`}
                  >
                    {a.reason_key ? t(a.reason_key) : t("care.systemApp")}
                  </span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class={CARD} data-testid="devcare-perms">
        <div class="flex items-center justify-between gap-2 px-3 pt-3">
          <span class={LABEL}>{t("care.permissions")}</span>
          {#if permReviewAuthoritative(perms) && (perms?.rows.length ?? 0) > 0}
            <span class="text-[10px] tabular-nums opacity-50" data-testid="devcare-perms-count">
              {t("care.permsCount", { n: perms?.rows.length ?? 0 })}
            </span>
          {/if}
        </div>
        {#if !permReviewAuthoritative(perms)}
          <div class="p-3 text-xs opacity-60" data-testid="devcare-perms-unavailable">
            {t("care.permNoAuthority")}
          </div>
        {:else if (perms?.rows.length ?? 0) === 0}
          <div class="p-3 text-xs opacity-60" data-testid="devcare-perms-empty">
            {t("care.permissionsEmpty")}
          </div>
        {:else}
          <!-- Same bounded window as the app list: the review is one row per app
               holding sensitive permissions, which is as long as the device is
               populated. -->
          <div
            class="max-h-72 space-y-1 overflow-y-auto overscroll-contain p-3"
            data-testid="devcare-perms-scroll"
          >
            {#each perms?.rows ?? [] as r (r.app_id)}
              <div class="flex items-start gap-2 text-xs" data-testid={`devcare-perm-${r.app_id}`}>
                <span class="min-w-0 flex-1 truncate">{r.app_id}</span>
                <span class="opacity-70">
                  {r.resources.map((x) => t(resourceLabelKey(x))).join(" · ")}
                </span>
              </div>
            {/each}
          </div>
        {/if}
      </div>

    {/if}

    <!-- Memory does not depend on the clean backend either. -->
    <div class={CARD} data-testid="devcare-memory">
      <div class="flex items-center justify-between px-3 pt-3">
        <span class={LABEL}>{t("care.memory")}</span>
        <span class="text-xs tabular-nums opacity-70" data-testid="devcare-memory-used">
          {mem && memUsedBytes(mem) !== null
            ? `${fmtBytes(memUsedBytes(mem))} / ${fmtBytes(mem.total_bytes)}`
            : "—"}
        </span>
      </div>
      {#if mem === null}
        <div class="p-3 text-xs opacity-60" data-testid="devcare-memory-unavailable">
          {t("care.memoryUnavailable")}
        </div>
      {:else if !mem.governor}
        <div class="p-3 text-xs opacity-60" data-testid="devcare-memory-nogovernor">
          {t("care.memoryNoGovernor")}
        </div>
      {:else}
        <div class="px-3 pb-2 text-[11px] opacity-70" data-testid="devcare-memory-reclaimable">
          {t("care.reclaimableApps", { n: mem.reclaimable.length })}
        </div>
        <div class="flex items-center gap-2 px-3 pb-3">
          <button
            class={BTN}
            disabled={boosting || mem.reclaimable.length === 0}
            onclick={() => void boost()}
            data-testid="devcare-boost"
          >
            {boosting ? t("care.boosting") : t("care.boost")}
          </button>
        </div>
      {/if}
      {#if boostNote}
        <div class="px-3 pb-3 text-[11px] opacity-80" data-testid="devcare-boost-note">
          {t(boostNote.key, boostNote.params)}
        </div>
      {/if}
    </div>

    <!-- The audit trail does NOT depend on the clean backend: it must stay
         visible even when no clean backend is attached. -->
    <div class={CARD} data-testid="devcare-trail">
        <div class="flex items-center justify-between px-3 pt-3">
          <span class={LABEL}>{t("care.trail")}</span>
          <button
            class={SOFT}
            disabled={busy}
            onclick={() => void loadTrail()}
            data-testid="devcare-trail-refresh"
          >
            {t("care.rescan")}
          </button>
        </div>
        {#if trailErr}
          <div class="p-3 text-xs text-amber-600" data-testid="devcare-trail-error">
            {t("care.trailUnavailable")}
          </div>
        {:else if trail && !trail.durable}
          <div class="p-3 text-xs opacity-60" data-testid="devcare-trail-nosink">
            {t("care.trailNoSink")}
          </div>
        {:else if (trail?.entries.length ?? 0) === 0}
          <div class="p-3 text-xs opacity-60" data-testid="devcare-trail-empty">
            {t("care.trailEmpty")}
          </div>
        {:else}
          <ul class="space-y-1 p-3">
            {#each trail?.entries ?? [] as e, i (`${e.ts}|${e.op}|${i}`)}
              <li class="flex items-start gap-2 text-xs" data-testid="devcare-trail-entry">
                <span class="shrink-0 tabular-nums opacity-50">{hhmm(e.ts)}</span>
                <span
                  class="shrink-0 rounded-full bg-black/[0.06] px-2 py-0.5 text-[10px] dark:bg-white/[0.08]"
                  data-testid="devcare-trail-outcome"
                >
                  {t(outcomeLabelKey(e.outcome))}
                </span>
                <span class="min-w-0 flex-1">
                  {t(opLabelKey(e.op))}<span class="opacity-50"> · {e.resource}</span>
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
  </div>
{/if}
