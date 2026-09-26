<script lang="ts">
  // AccountPage.svelte — 「iCloud / 账户」sub page reached from the top account
  // card. Holds the real iCloud-style backup sync (relocated): toggle the pref,
  // "Sync now" writes a snapshot, and the summary + "restore" put it back through
  // lib/cloud (restore is whitelisted to the content stores in SYNC_STORES).
  import { readStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
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
  import { GROUP, HINT } from "./kit";
  import ToggleRow from "./ToggleRow.svelte";
  // REQ-A1369：拒绝用**共用**的那一行说出来（与 `CellularPage` ∕ `DisplayPage` ∕
  // `FocusSchedule` ∕ `RingtonePage` 同一条纪律、同一枚 `data-testid`）—— 同一个事实不该有
  // 两种说法，测试也不该去猜第二个 testid。
  import StoreErrorBar from "../StoreErrorBar.svelte";

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
  /** 这一位被存储拒绝时的句子 —— 渲染在 iCloud 开关**自己那一行**上。 */
  let cloudErr = $state("");
  const persistCloud = (partial: Partial<CloudPrefs>) => {
    const cur = readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {});
    // 写入先问判决，再动这一页的读数：`writeStoreValue` 只返回 void，于是「存储收下了」与
    // 「存储拒绝了」在这张卡片看来字节相同 —— 开关会亮着、下面的同步面板会展开，而
    // `amos.settings` 里一位也没有（下次打开就是关的）。`readCloud` 正是设置首页那一行
    // 「iCloud」副标题读的东西，所以两处还会互相打脸。
    //
    // 这条规则在本文件里就写在**下面两个函数处**：`syncNow` 对 `BACKUP_KEY` 的那一次写入
    // 说的是同一句话（「showing a summary + "last synced" for bytes that were never stored
    // would be a lie about the user's data」）—— 同一个文件、同一条纪律，只是键不同。
    // 门挡在本地读数前面（而不是先改再回滚）：屏幕本来就还停在盘上那个值上，没有第二份读数
    // 要回滚 —— 与 `DockPage.svelte:52` ∕ `RingtonePage.selectRingtone` ∕
    // `FocusPage.toggleDnd` 同一形状。
    if (!writeStoreValueChecked(SETTINGS_KEY, setCloudPrefs(cur, partial))) {
      cloudErr = t("common.storeWriteFailed");
      return;
    }
    cloudErr = "";
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
  <ToggleRow
    label={t("settings.icloud")}
    on={cloud.enabled}
    ontoggle={() => persistCloud({ enabled: !cloud.enabled })}
  />
  {#if cloudErr}
    <!-- 渲染在**它自己的控件那一块**里（iCloud 开关那一行的正下方），不是页面别处：一条
         用户接不到刚按下那个开关上的拒绝，读起来就是「什么也没发生」（F-SH-270 的形状）。 -->
    <div class="px-4"><StoreErrorBar message={cloudErr} /></div>
  {/if}
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
