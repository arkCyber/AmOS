<script lang="ts">
  // PermissionsApp.svelte — Svelte 5 (runes) implementation of the privacy &
  // permissions dashboard. Ledger logic reuses pure lib/permissions.ts; the local
  // ledger (amos.permissions) is the display cache and works fully offline. The
  // daemon "recent access" audit section only appears when the bridge answers
  // (offline → hidden). The former React body was removed in the subtraction
  // phase — this is the only implementation, mounted by `appRegistry`.
  import { bridged } from "../lib/backend";
  import { CAPABILITIES, PERMISSIONS_KEY, capSet, grantedApps, grantedCaps, loadLedger, normalizeLedger } from "../lib/permissions";
  import type { Capability, PermissionLedger } from "../lib/permissions";
  import { capForWire, daemonGrantsAll, daemonRecentAudit, toAuditViews } from "../lib/privacyBackend";
  import type { AuditView, DaemonGrantRow } from "../lib/privacyBackend";
  import {
  daemonVerdict,
  grantCapability,
  mirrorRefused,
  onMirrorVerdict,
  revokeCapability,
} from "./osPermissions";
  import type { CapabilityWrite } from "./osPermissions";
  import { createStoreValue } from "./store";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { defaultAppsFor, isDefaultOnGrant } from "./osCapabilities";
  import { appTitleKey } from "../lib/appMeta";
  import { isExtId, tileById } from "../lib/storeApps";
  import { iconSvg } from "../lib/sysIcons";
  import { t } from "./locale.svelte";

  /**
   * Built-in apps that actually request each sensitive capability (a showcase).
   *
   * This is the **declared** half only. The other half — the apps the OS itself
   * default-grants the capability to (`osCapabilities.DEFAULT_CAPABILITIES`) — is
   * unioned in by {@link candidatesFor}, because a default-on app that is not in
   * this list could be *revoked* (it shows up as a granted holder) and then had no
   * way back on: the holder chip disappears with the grant (`vmemos` + microphone
   * was exactly that case).
   */
  const CANDIDATES: Record<Capability, string[]> = {
    camera: ["camera"],
    microphone: ["ai", "interpreter", "phone"],
    location: ["maps", "weather"],
    contacts: ["contacts"],
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

  // （REQ-A1467 ∕ F-SH-738）`amos.permissions` 的写入者不止本页。相机在挂载时就自动授权
  // （`CameraApp:92`），地图 ∕ 语音备忘录 ∕ 同传的运行时授权、三个麦克风按钮也都写这枚键
  // （`svelte/osPermissions.grantCapability`）。平板上本页与它们同台（Slide Over 面板或分屏的
  // 另一格），一次授权写完这枚键，本页不会重挂 —— 「只读一次」的代价是**审查面**说谎：`地图`
  // 对一个真的被授着的能力仍写「拒绝」，另一处撤销掉的能力仍留着绿芯片（还带着 ★ ∕ ⛔ 承诺）。
  // 用 `createStoreValue` 订阅：回退值取当前读数，挂载时同步投递的那次与初始值一致；本页自己的
  // 写入仍照旧读裁决并 `adopt`（订阅是幂等的）。
  const ledgerStore = createStoreValue<unknown>(PERMISSIONS_KEY, loadLedger());
  let ledger = $state<PermissionLedger>(loadLedger());
  $effect(() => {
    const un = ledgerStore.subscribe((v) => (ledger = normalizeLedger(v)));
    return un;
  });
  /** The last refused `amos.permissions` write, stated (see {@link adopt}). */
  let storeErr = $state("");
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
  // The display name comes from `lib/appMeta` — the one table that owns it — instead of
  // a hand-maintained copy here. That copy had no `vmemos`, so a default-on app rendered
  // as the raw id `vmemos`; and any newly added built-in would do the same until someone
  // remembered to edit this file too.
  const labelOf = (id: string): string => {
    if (isExtId(id)) return tileById(id)?.name ?? id;
    const key = appTitleKey(id);
    return key ? t(key) : id;
  };

  // App-centric view: the capability sections below answer "who holds 相机?"; this
  // answers "what can this app access?". Both read the SAME ledger, and an app's
  // list comes from `lib/permissions.grantedCaps` — never re-derived here.
  const appsWithCaps = $derived(
    Object.keys(ledger)
      .sort()
      .map((app) => ({ app, caps: grantedCaps(ledger, app) }))
      .filter((e) => e.caps.length > 0),
  );

  /**
   * The apps a capability's row offers to turn on: the declared showcase **plus** every
   * app the OS default-grants it to (`osCapabilities.defaultAppsFor`). Declared order
   * first (the showcase is the curated order), default-on apps appended.
   *
   * Why the union is load-bearing: the row is the only way *on*. A default-on app that
   * the row does not list can still be revoked (it is a granted holder), and then the
   * capability is unreachable until the next boot re-seeds the matrix — a dead end the
   * user cannot see or explain.
   */
  function candidatesFor(cap: Capability): string[] {
    const out = [...CANDIDATES[cap]];
    for (const app of defaultAppsFor(cap)) {
      if (!out.includes(app)) out.push(app);
    }
    return out;
  }

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
    adopt(revokeCapability(app, cap));
    // Re-read the authority instead of assuming the write landed.
    void daemonGrantsAll().then((rows) => {
      if (rows !== null) daemonRows = rows;
    });
  };
  // Audit resources are OS wire keys that equal capability names; fall back raw.
  const capNameOf = (res: string): string =>
    (CAPABILITIES as readonly string[]).includes(res) ? capLabel[res as Capability] : res;

  /**
   * Show what the store holds, and say when it holds something else.
   *
   * `CapabilityWrite.ledger` is the **persisted** ledger: every gate in the OS reads it back
   * through `loadLedger` (`capSet` in the apps, the daemon's own mirror), so adopting the
   * attempted value instead would draw a revoke that never took effect — the switch moves, the
   * holder chip disappears, and the next boot finds the capability granted again with nothing
   * having said a word. A refused write is the one case this page can prove locally
   * (`writeStoreValueChecked` → `false`), so it is stated rather than swallowed.
   */
  function adopt(res: CapabilityWrite): void {
    ledger = res.ledger;
    storeErr = res.landed ? "" : t("common.storeWriteFailed");
    // The ⛔ marks read `ledger`; recompute them for the ledger actually adopted.
    collectMirrorRefusals();
  }

  const toggle = (app: string, cap: Capability) => {
    const on = capSet(ledger, app, cap);
    // One seam for both sides: the local ledger (display cache, works offline) and
    // the daemon's authoritative, audited store (best-effort, offline no-op).
    adopt(on ? revokeCapability(app, cap) : grantCapability(app, cap));
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

  /**
   * A mirror write the daemon **refused** — the one failure the app can prove locally. The
   * drift block above *asks the daemon*, so it goes silent exactly when the write failed
   * because the daemon is unreachable (`perm_authorize` fails too, and `null` means "no
   * claim"). This reads the verdict of the write the user's own action made, so a grant
   * that never reached the authoritative store is not shown as a clean green grant. Kept
   * apart from `drift` because the cause differs: that one is "the daemon denies it", this
   * is "the daemon never confirmed it".
   */
  let mirrorRefusals = $state<Record<string, true>>({});
  function collectMirrorRefusals(): void {
    const next: Record<string, true> = {};
    for (const cap of CAPABILITIES) {
      for (const app of grantedApps(ledger, cap)) {
        if (mirrorRefused(app, cap)) next[`${app}|${cap}`] = true;
      }
    }
    mirrorRefusals = next;
  }
  $effect(() => {
    // 对**当前这份**账本先算一次 —— 订阅送来的外部写入可能带来一个「最后一次镜像已被拒」的
    // 配对（那次写入的判决早就记在 `mirrorRefused` 里，只是本页还没有这份账本去看见它）。
    collectMirrorRefusals();
    return onMirrorVerdict(() => collectMirrorRefusals());
  });
</script>
<div class="space-y-3 p-4">
  <StoreErrorBar message={storeErr} />
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
              {#if isDefaultOnGrant(app, cap)}
                <span
                  data-testid={`perm-default-${app}-${cap}`}
                  aria-label={t("perm.defaultOn")}
                  title={t("perm.defaultOn")}
                  class="text-blue-500"
                >★</span>
              {/if}
              {#if mirrorRefusals[`${app}|${cap}`]}
                <span
                  data-testid={`perm-mirror-${app}-${cap}`}
                  aria-label={t("perm.mirrorRefused")}
                  title={t("perm.mirrorRefused")}
                  class="text-red-500"
                  >⛔</span
                >
              {/if}
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
        {#each candidatesFor(cap) as app (app)}
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

