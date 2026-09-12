<script lang="ts">
  // PermissionsApp.svelte — Svelte 5 (runes) implementation of the privacy &
  // permissions dashboard. Ledger logic reuses pure lib/permissions.ts; the local
  // ledger (amos.permissions) is the display cache and works fully offline. The
  // daemon "recent access" audit section only appears when the bridge answers
  // (offline → hidden). The former React body was removed in the subtraction
  // phase — this is the only implementation, mounted by `appRegistry`.
  import { bridged } from "../lib/backend";
  import { CAPABILITIES, capSet, grantedApps, grantedCaps, loadLedger } from "../lib/permissions";
  import type { Capability, PermissionLedger } from "../lib/permissions";
  import { capForWire, daemonGrantsAll, daemonRecentAudit, toAuditViews } from "../lib/privacyBackend";
  import type { AuditView, DaemonGrantRow } from "../lib/privacyBackend";
  import { daemonVerdict, grantCapability, revokeCapability } from "./osPermissions";
  import { isExtId, tileById } from "../lib/storeApps";
  import { iconSvg } from "../lib/sysIcons";
  import { t } from "./locale.svelte";

  /** Built-in apps that actually request each sensitive capability (a showcase). */
  const CANDIDATES: Record<Capability, string[]> = {
    camera: ["camera"],
    microphone: ["ai", "interpreter", "phone"],
    location: ["maps", "weather"],
    contacts: [],
    storage: [],
    notifications: ["messages", "mail"],
  };
  const CAP_ICON: Record<Capability, string> = {
    camera: "📷",
    microphone: "🎙️",
    location: "📍",
    contacts: "👥",
    storage: "🗂️",
    notifications: "🔔",
  };

  let ledger = $state<PermissionLedger>(loadLedger());
  // Daemon "recent access" audit (only fetched when online). null = no record yet.
  let audit = $state<AuditView[]>([]);
  let auditOnline = $state(false);

  $effect(() => {
    if (!bridged()) return; // offline: local-ledger-only view
    void daemonRecentAudit(20).then((recs) => {
      if (recs === null) return; // no daemon reply → don't show the section
      audit = toAuditViews(recs);
      auditOnline = true; // only when we actually heard from the daemon
    });
  });

  const capLabel = $derived<Record<Capability, string>>({
    camera: t("perm.cap.camera"),
    microphone: t("perm.cap.microphone"),
    location: t("perm.cap.location"),
    contacts: t("perm.cap.contacts"),
    storage: t("perm.cap.storage"),
    notifications: t("perm.cap.notifications"),
  });
  const appName = $derived<Record<string, string>>({
    camera: t("app.camera"),
    ai: t("app.ai"),
    interpreter: t("app.interpreter"),
    phone: t("app.phone"),
    maps: t("app.maps"),
    weather: t("app.weather"),
    messages: t("app.messages"),
    mail: t("app.mail"),
  });
  const labelOf = (id: string): string =>
    isExtId(id) ? tileById(id)?.name ?? id : (appName[id] ?? id);

  // App-centric view: the capability sections below answer "who holds 相机?"; this
  // answers "what can this app access?". Both read the SAME ledger, and an app's
  // list comes from `lib/permissions.grantedCaps` — never re-derived here.
  const appsWithCaps = $derived(
    Object.keys(ledger)
      .sort()
      .map((app) => ({ app, caps: grantedCaps(ledger, app) }))
      .filter((e) => e.caps.length > 0),
  );

  // ---- the daemon's own grant store (the authority) -------------------------
  // Everything above reads the LOCAL ledger. A grant can exist only daemon-side
  // (the daemon reloads its store from AMOS_PRIVACY_PATH, so it survives a fresh
  // or cleared WebView profile, and another surface may have granted it) — and
  // then this page would show nothing while the capability is really held.
  // `perm_grants_all` is the one-round-trip authority for exactly that review.
  let daemonRows = $state<DaemonGrantRow[]>([]);
  $effect(() => {
    if (!bridged()) return;
    void daemonGrantsAll().then((rows) => {
      if (rows === null) return; // no answer → make no claim at all
      daemonRows = rows;
    });
  });
  // Daemon grants the local ledger does not know about. Unknown wire keys are
  // skipped (never rendered as a capability), and a local grant is excluded here
  // because the capability sections above already show it (with its drift mark).
  const daemonOnly = $derived(
    daemonRows.flatMap((row) =>
      row.resources
        .map((res) => capForWire(res))
        .filter((cap): cap is Capability => cap !== null)
        .filter((cap) => !capSet(ledger, row.app_id, cap))
        .map((cap) => ({ app: row.app_id, cap })),
    ),
  );
  /** Revoke a daemon-only grant at the authority (it is not in the local ledger). */
  const revokeDaemonOnly = (app: string, cap: Capability) => {
    ledger = revokeCapability(app, cap);
    // Re-read the authority instead of assuming the write landed.
    void daemonGrantsAll().then((rows) => {
      if (rows !== null) daemonRows = rows;
    });
  };
  // Audit resources are OS wire keys that equal capability names; fall back raw.
  const capNameOf = (res: string): string =>
    (CAPABILITIES as readonly string[]).includes(res) ? capLabel[res as Capability] : res;

  const toggle = (app: string, cap: Capability) => {
    const on = capSet(ledger, app, cap);
    // One seam for both sides: the local ledger (display cache, works offline) and
    // the daemon's authoritative, audited store (best-effort, offline no-op).
    ledger = on ? revokeCapability(app, cap) : grantCapability(app, cap);
  };

  // Drift between the local ledger and the daemon's authoritative store: the local
  // grants the daemon *denies* (a grant that never reached it, a revoke made
  // elsewhere, or a policy denial). `null` = the daemon couldn't answer → no claim.
  let drift = $state<Record<string, true>>({});
  $effect(() => {
    if (!bridged()) return;
    const pairs: Array<[string, Capability]> = [];
    for (const cap of CAPABILITIES) {
      for (const app of grantedApps(ledger, cap)) pairs.push([app, cap]);
    }
    let alive = true;
    void Promise.all(
      pairs.map(async ([app, cap]) => [`${app}|${cap}`, await daemonVerdict(app, cap)] as const),
    ).then((res) => {
      if (!alive) return;
      const next: Record<string, true> = {};
      for (const [key, verdict] of res) if (verdict === false) next[key] = true;
      drift = next;
    });
    return () => {
      alive = false;
    };
  });
</script>
<div class="space-y-3 p-4">
  <p class="rounded-2xl bg-white/50 px-3 py-2 text-xs leading-relaxed opacity-60 ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10">
    {t("perm.hint")}
  </p>

  {#if appsWithCaps.length}
    <section
      data-testid="perm-by-app"
      aria-label={t("perm.byApp")}
      class="rounded-2xl bg-white/60 p-3 shadow-sm ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10"
    >
      <h3 class="text-sm font-medium">{t("perm.byApp")}</h3>
      <ul class="mt-2 space-y-1">
        {#each appsWithCaps as { app, caps } (app)}
          <li class="flex items-center justify-between gap-2 text-xs">
            <span class="truncate">{labelOf(app)}</span>
            <span class="shrink-0 opacity-60">
              {#each caps as cap (cap)}{CAP_ICON[cap]} {capLabel[cap]} {/each}
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if daemonOnly.length}
    <section
      data-testid="perm-daemon-grants"
      aria-label={t("perm.daemonGrants")}
      class="rounded-2xl bg-amber-500/10 p-3 shadow-sm ring-1 ring-amber-500/30"
    >
      <h3 class="text-sm font-medium">{t("perm.daemonGrants")}</h3>
      <p class="mt-1 text-xs leading-relaxed opacity-70">{t("perm.daemonGrantsHint")}</p>
      <ul class="mt-2 space-y-1">
        {#each daemonOnly as row (`${row.app}|${row.cap}`)}
          <li class="flex items-center justify-between gap-2 text-xs">
            <span class="truncate">{labelOf(row.app)} · {capLabel[row.cap]}</span>
            <button
              onclick={() => revokeDaemonOnly(row.app, row.cap)}
              aria-label={t("perm.daemonGrantsRevoke")}
              title={t("perm.daemonGrantsRevoke")}
              class="shrink-0 rounded-full bg-red-500/10 px-2 py-0.5 text-red-500/90 active:scale-95"
            >✕</button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if auditOnline}
    <section aria-label={t("perm.recent.title")} class="rounded-2xl bg-white/60 p-3 shadow-sm ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10">
      <header class="mb-2 flex items-center justify-between">
        <h3 class="text-sm font-medium">{t("perm.recent.title")}</h3>
        <span class="text-xs opacity-50">{t("perm.recent.live")}</span>
      </header>
      {#if audit.length === 0}
        <p class="text-xs opacity-50">{t("perm.recent.empty")}</p>
      {:else}
        <ul class="space-y-1">
          {#each audit.slice(0, 20) as v, i (v.ts + "-" + i)}
            <li class="flex items-center justify-between gap-2 text-xs">
              <span class="truncate">{labelOf(v.appId)} · {capNameOf(v.resource)}</span>
              <span class={v.granted
                ? "shrink-0 rounded-full bg-green-500/15 px-2 py-0.5 text-green-600 dark:text-green-400"
                : "shrink-0 rounded-full bg-red-500/10 px-2 py-0.5 text-red-500/80"}>
                {v.granted ? t("perm.on") : t("perm.off")}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#each CAPABILITIES as cap (cap)}
    {@const holders = grantedApps(ledger, cap)}
    <section class="rounded-2xl bg-white/60 p-3 shadow-sm ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10">
      <header class="flex items-center justify-between">
        <h3 class="text-sm font-medium">{CAP_ICON[cap]} {capLabel[cap]}</h3>
        <span class="text-xs opacity-50">{t("perm.granted")}: {holders.length}</span>
      </header>

      {#if holders.length === 0}
        <p class="mt-1 text-xs opacity-50">{t("perm.none")}</p>
      {:else}
        <div class="mt-2 flex flex-wrap gap-1.5">
          {#each holders as app (app)}
            <button
              onclick={() => toggle(app, cap)}
              title={t("perm.revoke")}
              class="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2.5 py-1 text-xs text-green-600 dark:text-green-400"
            >
              {labelOf(app)}<span data-icon="x" class="grid h-3 w-3 place-items-center">{@html iconSvg("x", "h-3 w-3")}</span>
              {#if drift[`${app}|${cap}`]}
                <span
                  data-testid={`perm-drift-${app}-${cap}`}
                  aria-label={t("perm.drift")}
                  title={t("perm.drift")}
                  class="text-amber-500"
                >⚠</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      <div class="mt-2 flex flex-wrap gap-1.5 border-t border-black/5 pt-2 dark:border-white/10">
        {#each CANDIDATES[cap] as app (app)}
          {@const on = capSet(ledger, app, cap)}
          <button
            onclick={() => toggle(app, cap)}
            aria-pressed={on}
            class="rounded-full px-3 py-1 text-xs ring-1 {on
              ? 'bg-accent text-white ring-accent'
              : 'bg-neutral-200/60 ring-black/5 dark:bg-neutral-700/60 dark:ring-white/10'}"
          >
            {labelOf(app)} · {on ? t("perm.on") : t("perm.off")}
          </button>
        {/each}
      </div>
    </section>
  {/each}
</div>

