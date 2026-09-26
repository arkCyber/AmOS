<script lang="ts">
  // PushManagementPage.svelte — 「推送通知管理」sub page (REQ-A499).
  //
  // 这一页此前是**一句硬编码英文占位**（`Push Notification Settings - Coming Soon`），而它
  // 承诺的内容（设备推送权限 / 令牌 / 统计 / 最后接收 / 清历史 / 测试推送）**早就完整实现**在
  // 「通知」页里，索引行、标题、搜索别名、渲染分支又都齐备 ⇒ "承诺了、也点得到、但什么都不给"。
  //
  // 现在它渲染**同一个** `PushSettings` 面板（一份实现、两个入口 —— 见该组件的注释），外加这
  // 一页独有的「推送历史」：@see `pushOnly` —— 只看推送来源的行，系统通知属于「通知」页。
  import { readStoreValue } from "../../lib/amosStore";
  import { createStoreValue } from "../store";
  import { pushOnly } from "../../lib/pushNotifBridge";
  import { NOTIF_KEY, normalizeNotifs, type Notif } from "../../lib/settings";
  import { t } from "../locale.svelte";
  import { GROUP, LABEL, HINT } from "./kit";
  import PushSettings from "./PushSettings.svelte";

  /** `amos.notifications` 是唯一真源；本页只读它，写入由 `PushSettings` 自己做。 */
  let notifs = $state<Notif[]>(normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, [])));
  /**
   * 推送随时会到达（`osPushWatcher` 每 5 秒轮询一次设备历史并写回这个键），页面开着时也一样：
   * 订阅它，否则推送历史与条数停在打开那一刻的快照上。与「通知」页同一条纪律 —— 那一页的
   * 同一份缺陷在 REQ-A1238 已修（REQ-A1310 补上这个漏掉的孪生）。
   */
  const notifStore = createStoreValue<Notif[]>(NOTIF_KEY, []);
  $effect(() => {
    return notifStore.subscribe((v) => {
      notifs = normalizeNotifs(v);
    });
  });
  const pushRows = $derived(pushOnly(notifs));
  /** 本页最多显示多少行（与「通知」页的 10 行同一取舍：一屏可读优先）。 */
  const HISTORY_LIMIT = 20;
</script>

<div class="space-y-5">
  <PushSettings onhistorycleared={(remaining) => (notifs = remaining)} />

  <section class={GROUP} data-testid="push-history">
    <div class="flex items-center justify-between gap-2 px-4 py-3">
      <span class={LABEL}>{t("pushSettings.historyTitle")}</span>
      <span class="text-xs opacity-60">{t("pushSettings.historyCount", { n: pushRows.length })}</span>
    </div>
    {#if pushRows.length === 0}
      <div class="px-4 pb-4">
        <p class={HINT}>{t("pushSettings.historyEmpty")}</p>
      </div>
    {:else}
      <ul class="border-t border-black/5 dark:border-white/10">
        {#each pushRows.slice(0, HISTORY_LIMIT) as n (n.id)}
          <li class="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
            <div class="min-w-0">
              {#if n.title}
                <p class="truncate font-medium">{n.title}</p>
              {/if}
              {#if n.body}
                <p class="truncate text-xs opacity-60">{n.body}</p>
              {/if}
            </div>
            <span class="shrink-0 text-xs opacity-50">
              {new Date(n.time).toLocaleTimeString()}
            </span>
          </li>
        {/each}
      </ul>
      {#if pushRows.length > HISTORY_LIMIT}
        <p class="border-t border-black/5 px-4 py-2 text-xs opacity-50 dark:border-white/10">
          {t("settings.notifMore", { n: String(pushRows.length - HISTORY_LIMIT) })}
        </p>
      {/if}
    {/if}
  </section>
</div>
