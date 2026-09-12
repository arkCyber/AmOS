<script lang="ts">
  // AccountPage.svelte — 「iCloud / 账户」sub page reached from the top account
  // card. Holds the real iCloud-style backup sync (relocated): toggle the pref,
  // "Sync now" writes a snapshot, and the summary + "restore" put it back through
  // lib/cloud (restore is whitelisted to the content stores in SYNC_STORES).
  import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
  import {
    BACKUP_KEY,
    SETTINGS_KEY,
    SYNC_STORES,
    readCloud,
    restoreStores,
    setCloudPrefs,
    snapshotStores,
    summarizeBackup,
    type CloudPrefs,
  } from "../../lib/cloud";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, HINT } from "./kit";
  import Switch from "./Switch.svelte";

  let cloud = $state<CloudPrefs>(readCloud(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {})));
  // The last snapshot lives in the shared store, so the summary/restore also work
  // after a reload. `null` = corrupt/absent ⇒ we offer no restore (nothing honest
  // to restore from) instead of pretending there is a backup.
  let backupRaw = $state<unknown>(readStoreValue<unknown>(BACKUP_KEY, ""));
  const backup = $derived(summarizeBackup(backupRaw));
  // "Last synced" describes the **backup**, not a separate pref: the time comes from
  // the blob itself. A legacy blob (written before the envelope) carries none — the
  // old code stamped `cloudLast` in the same call, so that fallback is exact. With no
  // restorable backup there is no sync time to claim at all.
  const syncedAt = $derived(backup ? (backup.at ?? cloud.lastSync) : 0);
  let restoreMsg = $state("");
  const persistCloud = (partial: Partial<CloudPrefs>) => {
    const cur = readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {});
    writeStoreValue(SETTINGS_KEY, setCloudPrefs(cur, partial));
    cloud = { ...cloud, ...partial };
  };
  const syncNow = () => {
    const stores: Record<string, unknown> = {};
    for (const k of SYNC_STORES) stores[k] = readStoreValue<unknown>(k, []);
    const snapshot = snapshotStores(stores, Date.now());
    // The write is **verified**: a full/unavailable localStorage rejects it silently,
    // and showing a summary + "last synced" for bytes that were never stored would be
    // a lie about the user's data. On failure nothing is claimed and the summary keeps
    // describing whatever *is* actually stored (the previous backup, or none).
    if (!writeStoreValueChecked(BACKUP_KEY, snapshot)) {
      restoreMsg = t("settings.backupWriteFailed");
      return;
    }
    backupRaw = snapshot;
    restoreMsg = "";
    persistCloud({ enabled: cloud.enabled, lastSync: Date.now() });
  };
  // Restore only content stores (lib/cloud.restoreStores whitelists SYNC_STORES):
  // a corrupt blob changes nothing, a blob from a *newer* AmOS is refused rather than
  // guessed at, and configuration / device-state keys a blob might carry are refused.
  // The writer reports whether each value landed, so a rejected write (full storage)
  // is reported as a partial restore instead of being counted as restored.
  const restoreNow = () => {
    const report = restoreStores(backupRaw, (key, value) => writeStoreValueChecked(key, value));
    if (!report.ok) {
      restoreMsg =
        report.reason === "unsupported-version"
          ? t("settings.restoreTooNew")
          : t("settings.restoreCorrupt");
      return;
    }
    restoreMsg =
      report.failed.length > 0
        ? t("settings.restorePartial", {
            n: String(report.restored.length),
            failed: String(report.failed.length),
          })
        : t("settings.restoredCount", { n: String(report.restored.length) });
  };
</script>

<section class={GROUP}>
  <div class={ROW}>
    <span class={LABEL}>{t("settings.icloud")}</span>
    <Switch
      on={cloud.enabled}
      ontoggle={() => persistCloud({ enabled: !cloud.enabled })}
      aria={t("settings.icloud")}
    />
  </div>
  {#if cloud.enabled}
    <div class="px-4 py-3 border-t border-black/5 dark:border-white/10">
      <p class={HINT}>{t("settings.icloudHint")}</p>
      {#if syncedAt > 0}
        <p class="mt-1 text-xs opacity-60">
          {t("settings.syncedAt", { time: new Date(syncedAt).toLocaleTimeString() })}
        </p>
      {/if}
      <button
        onclick={syncNow}
        class="mt-2 rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95"
      >
        {t("settings.syncNow")}
      </button>
      {#if backup}
        <p class="mt-2 text-xs opacity-60">
          {t("settings.backupSummary", {
            filled: String(backup.filled),
            total: String(backup.total),
          })}
        </p>
        <button
          onclick={restoreNow}
          class="mt-2 ml-2 rounded-full bg-black/5 px-4 py-1.5 text-sm active:scale-95 dark:bg-white/10"
        >
          {t("settings.restoreBackup")}
        </button>
      {/if}
      {#if restoreMsg}
        <p class="mt-2 text-xs opacity-60">{restoreMsg}</p>
      {/if}
    </div>
  {/if}
</section>
