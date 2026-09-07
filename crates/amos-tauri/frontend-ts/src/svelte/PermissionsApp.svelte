<script lang="ts">
  // PermissionsApp.svelte — Svelte 5 (runes) implementation of the privacy &
  // permissions dashboard. Ledger logic reuses pure lib/permissions.ts; the local
  // ledger (amos.permissions) is the display cache and works fully offline. The
  // daemon "recent access" audit section only appears when the bridge answers
  // (offline → hidden). The former React body (src/components/PermissionsApp.tsx)
  // was removed in the subtraction phase — this is now the only implementation,
  // mounted directly by apps.tsx PermissionsEntry (no React fallback).
  import { bridged } from "../lib/backend";
  import {
    CAPABILITIES,
    capSet,
    grantCap,
    grantedApps,
    loadLedger,
    revokeCap,
    saveLedger,
  } from "../lib/permissions";
  import type { Capability, PermissionLedger } from "../lib/permissions";
  import {
    daemonGrant,
    daemonRecentAudit,
    daemonRevoke,
    toAuditViews,
  } from "../lib/privacyBackend";
  import type { AuditView } from "../lib/privacyBackend";
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
  // Audit resources are OS wire keys that equal capability names; fall back raw.
  const capNameOf = (res: string): string =>
    (CAPABILITIES as readonly string[]).includes(res) ? capLabel[res as Capability] : res;

  const commit = (next: PermissionLedger) => {
    saveLedger(next);
    ledger = next;
  };
  const toggle = (app: string, cap: Capability) => {
    const on = capSet(ledger, app, cap);
    // Authoritative side-effect on the daemon (best-effort; offline no-op), then
    // update the local cache so the dashboard reflects the toggle immediately.
    if (on) void daemonRevoke(app, cap);
    else void daemonGrant(app, cap);
    commit(on ? revokeCap(ledger, app, cap) : grantCap(ledger, app, cap));
  };
</script>
<div class="space-y-3 p-4">
  <p class="rounded-2xl bg-white/50 px-3 py-2 text-xs leading-relaxed opacity-60 ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10">
    {t("perm.hint")}
  </p>

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

