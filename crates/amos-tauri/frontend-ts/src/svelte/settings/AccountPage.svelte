<script lang="ts">
  // AccountPage.svelte — 「iCloud / 账户」sub page reached from the top account
  // card. Holds the real iCloud-style backup sync (relocated) plus a lightweight
  // placeholder block for the surrounding account rows (iPhone-style future work).
  import { readStoreValue, writeStoreValue } from "../../lib/amosStore";
  import {
    BACKUP_KEY,
    SETTINGS_KEY,
    SYNC_STORES,
    readCloud,
    setCloudPrefs,
    snapshotStores,
    type CloudPrefs,
  } from "../../lib/cloud";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, HINT } from "./kit";
  import Switch from "./Switch.svelte";

  let cloud = $state<CloudPrefs>(readCloud(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {})));
  const persistCloud = (partial: Partial<CloudPrefs>) => {
    const cur = readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {});
    writeStoreValue(SETTINGS_KEY, setCloudPrefs(cur, partial));
    cloud = { ...cloud, ...partial };
  };
  const syncNow = () => {
    const stores: Record<string, unknown> = {};
    for (const k of SYNC_STORES) stores[k] = readStoreValue<unknown>(k, []);
    writeStoreValue(BACKUP_KEY, snapshotStores(stores));
    persistCloud({ enabled: cloud.enabled, lastSync: Date.now() });
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
      {#if cloud.lastSync > 0}
        <p class="mt-1 text-xs opacity-60">
          {t("settings.syncedAt", { time: new Date(cloud.lastSync).toLocaleTimeString() })}
        </p>
      {/if}
      <button
        onclick={syncNow}
        class="mt-2 rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95"
      >
        {t("settings.syncNow")}
      </button>
    </div>
  {/if}
</section>
