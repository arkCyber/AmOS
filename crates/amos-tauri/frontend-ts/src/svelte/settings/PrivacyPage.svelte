<script lang="ts">
  // PrivacyPage.svelte — 「隐私与安全性」sub page. Reuses the REAL local OS
  // permission ledger (lib/permissions, durable amos.permissions) to show which
  // apps hold each sensitive capability and let the user revoke them; each revoke
  // also mirrors to the daemon via lib/privacyBackend (best-effort, offline-safe).
  import { CAPABILITIES, grantedApps, loadLedger } from "../../lib/permissions";
  import type { Capability, PermissionLedger } from "../../lib/permissions";
  import { revokeCapability } from "../osPermissions";
  import {
    canonicalPath,
    mediaAvailableCollections,
    mediaGrants,
    mediaProviderName,
    mediaRevoke,
    type Grant,
    type StandardDir,
  } from "../../lib/media";
  import { isExtId, tileById } from "../../lib/storeApps";
  import { t } from "../locale.svelte";
  import { GROUP, LABEL } from "./kit";
  import { iconSvg } from "../../lib/sysIcons";

  const CAP_ICON: Record<Capability, string> = {
    camera: "📷",
    microphone: "🎙️",
    location: "📍",
    contacts: "👥",
    storage: "🗂️",
    notifications: "🔔",
  };
  /** built-in app id → i18n key (ext ids resolve through the store tile). */
  const KNOWN: Record<string, string> = {
    camera: "app.camera",
    ai: "app.ai",
    interpreter: "app.interpreter",
    phone: "app.phone",
    maps: "app.maps",
    weather: "app.weather",
    messages: "app.messages",
    mail: "app.mail",
    magnifier: "app.magnifier",
  };
  const capKey = (c: Capability): string => {
    switch (c) {
      case "camera": return "perm.cap.camera";
      case "microphone": return "perm.cap.microphone";
      case "location": return "perm.cap.location";
      case "contacts": return "perm.cap.contacts";
      case "storage": return "perm.cap.storage";
      case "notifications": return "perm.cap.notifications";
      default: return "perm.cap.camera"; // exhaustive guard (never reached)
    }
  };
  const nameOf = (id: string): string => {
    if (isExtId(id)) return tileById(id)?.name ?? id;
    const key = KNOWN[id];
    return key ? t(key) : id;
  };

  let ledger = $state<PermissionLedger>(loadLedger());
  const revoke = (app: string, cap: Capability) => {
    // One seam for both sides (local ledger + daemon mirror), same as the other
    // capability prompts — see `svelte/osPermissions`.
    ledger = revokeCapability(app, cap);
  };

  // ---- System media access ------------------------------------------------
  // The media bridge (crates/amos-tauri/src/media.rs) holds its own grant set for
  // the standard Android collections. It is *separate* from the app-capability
  // ledger above, so it gets its own section: what the OS actually lets us read /
  // write, with a revoke per grant. `null` from a call means "could not read" —
  // never rendered as "nothing granted".
  let mediaProvider = $state<string | null>(null);
  let mediaCollectionList = $state<StandardDir[] | null>(null);
  let mediaGrantList = $state<Grant[] | null>(null);

  const loadMedia = async () => {
    const [prov, grants, cols] = await Promise.all([
      mediaProviderName(),
      mediaGrants(),
      mediaAvailableCollections(),
    ]);
    mediaProvider = prov;
    mediaGrantList = grants;
    mediaCollectionList = cols;
  };
  $effect(() => {
    void loadMedia();
  });

  /** True when the media bridge answered at all (otherwise: no section, no claims). */
  const mediaKnown = $derived(
    mediaProvider !== null || mediaCollectionList !== null || mediaGrantList !== null,
  );

  const revokeMedia = async (g: Grant) => {
    await mediaRevoke(g.access, g.collection);
    await loadMedia(); // reflect the real state again (never assume the revoke took)
  };

  const held = $derived(
    CAPABILITIES.map((cap) => ({ cap, apps: grantedApps(ledger, cap) })).filter(
      (g) => g.apps.length > 0,
    ),
  );
</script>

<div class="space-y-5">
  {#if held.length === 0}
    <section class={GROUP}>
      <div class="px-4 py-6">
        <p class="text-center text-sm opacity-60">{t("perm.none")}</p>
      </div>
    </section>
  {:else}
    {#each held as group (group.cap)}
      <section class={GROUP}>
        <div class="flex items-center justify-between px-4 py-3">
          <span class={LABEL}>{CAP_ICON[group.cap]} {t(capKey(group.cap))}</span>
          <span class="text-xs opacity-60">{t("perm.granted")}: {group.apps.length}</span>
        </div>
        <div class="flex flex-wrap gap-1.5 border-t border-black/5 px-4 py-3 dark:border-white/10">
          {#each group.apps as app (app)}
            <button
              onclick={() => revoke(app, group.cap)}
              title={t("perm.revoke")}
              class="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2.5 py-1 text-xs text-green-600 active:scale-95 dark:text-green-400"
            >
              {nameOf(app)}<span data-icon="x" class="grid h-3 w-3 place-items-center">{@html iconSvg("x", "h-3 w-3")}</span>
            </button>
          {/each}
        </div>
      </section>
    {/each}
  {/if}
  {#if mediaKnown}
    <section class={GROUP} aria-label={t("settings.mediaAccess")}>
      <div class="flex items-center justify-between px-4 py-3">
        <span class={LABEL}>🗂️ {t("settings.mediaAccess")}</span>
        <span class="text-xs opacity-60">
          {#if mediaProvider}{t("settings.mediaProvider", { name: mediaProvider })}{/if}
        </span>
      </div>
      <div class="border-t border-black/5 px-4 py-3 dark:border-white/10">
        {#if mediaGrantList === null}
          <p class="text-xs opacity-60">{t("settings.mediaUnreadable")}</p>
        {:else if mediaGrantList.length === 0}
          <p class="text-xs opacity-60">{t("settings.mediaNone")}</p>
        {:else}
          <div class="flex flex-wrap gap-1.5">
            {#each mediaGrantList as g (g.access + ":" + g.collection)}
              <button
                onclick={() => void revokeMedia(g)}
                title={t("settings.mediaRevoke")}
                aria-label={`${canonicalPath(g.collection)} ${g.access}`}
                class="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2.5 py-1 text-xs text-green-600 active:scale-95 dark:text-green-400"
              >
                {canonicalPath(g.collection)} · {g.access}
                <span data-icon="x" class="grid h-3 w-3 place-items-center">{@html iconSvg("x", "h-3 w-3")}</span>
              </button>
            {/each}
          </div>
        {/if}
        <p class="mt-2 text-xs opacity-50">
          {t("settings.mediaAccessHint")}
          {#if mediaCollectionList !== null}
            · {t("settings.mediaCollections", { n: mediaCollectionList.length })}
          {/if}
        </p>
      </div>
    </section>
  {/if}
  <p class="px-1 text-xs opacity-50">{t("settings.privacyHint")}</p>
</div>
