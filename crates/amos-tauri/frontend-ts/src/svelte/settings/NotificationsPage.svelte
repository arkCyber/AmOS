<script lang="ts">
  // NotificationsPage.svelte — 「通知」sub page. Real controls backed by the shared
  // quick-settings + notification stores: a Do-Not-Disturb switch (lib/settings
  // dnd, persisted under amos.settings — same policy the shell honours) plus a
  // read-only view of the current notifications with a clear-all action.
  import { readStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
  import { bridged } from "../../lib/backend";
  // REQ-A1238：列表是 `amos.notifications` 的**投影**（`osPushWatcher` 每 5 秒把设备历史并进来），
  // 所以这一页也必须订阅它 —— 只读一次快照，屏幕就停在打开那一刻。另外两个通知面
  // （`NotificationCenter` / `DesktopNotificationCenter`）一直用的是同一个订阅原语。
  import { createStoreValue } from "../store";
  import {
    NOTIF_KEY,
    SETTINGS_KEY,
    dndActive,
    flipQuick,
    normalizeNotifs,
    normalizeQuick,
    saveQuick,
    type Notif,
    type QuickSettings,
  } from "../../lib/settings";
  import { t } from "../locale.svelte";
  import { GROUP, LABEL, HINT } from "./kit";
  import ToggleRow from "./ToggleRow.svelte";
  import StoreErrorBar from "../StoreErrorBar.svelte";
  // REQ-A499: the push backend panel is a **shared component** — 「通知」and
  // 「推送通知管理」render the same one, so the device commands (`push_get_status` …) have
  // exactly one implementation (a second copy is the F-SH-005 defect).
  import PushSettings from "./PushSettings.svelte";
  import { clearNotificationHistory } from "../../lib/pushNotifications";

  const readQuick = (): QuickSettings => normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {}));
  let qs = $state<QuickSettings>(readQuick());
  // 与下面那条通知列表订阅同一条纪律，只是**上一条**修复漏掉了它：勿扰这一位由
  // `osFocusWatcher`（时间窗边界 + 每次编辑时段）和控制中心一起写，所以这一页的开关与它那句
  // 「勿扰模式已开启/关闭」也必须跟随这个键，而不是停在挂载那一刻（REQ-A1340 ∕ F-SH-605）。
  const quickStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  $effect(() => {
    const un = quickStore.subscribe((v) => (qs = normalizeQuick(v)));
    return un;
  });
  const dnd = $derived(dndActive(qs));
  /**
   * 与「清空」那条拒绝同一条纪律、同一个键：这一翻转是**纯存储**的判决，不向任何设备发问。
   * 存储答「没写成」时本地那一位必须原样不动 —— `writeJson` 拒绝之后既不派发
   * `STORE_CHANGED_EVENT`、也不留存任何东西，于是开关亮着、下面那句还印着「勿扰模式已开启」，
   * 而没有一位存储持有它（F-SH-630）。成功时这句本地赋值是多余的：派发是同步的，
   * `quickStore` 的订阅会把 `next` 送回来（REQ-A1340 装的正是这条订阅）。
   */
  let dndErr = $state("");
  const toggleDnd = () => {
    const next = flipQuick(qs, "dnd");
    // `next` 是窄化后的翻转值，必须**载入**原始 blob 而不是覆盖它（REQ-A1397 ∕ F-SH-656）。
    if (!saveQuick(next)) {
      dndErr = t("common.storeWriteFailed");
      return;
    }
    dndErr = "";
    qs = next;
  };

  const notifStore = createStoreValue<Notif[]>(NOTIF_KEY, []);
  let notifs = $state<Notif[]>(normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, [])));
  // 推送随时会到达（观察者每 5 秒轮询一次设备历史），页面开着的时候也一样：订阅它，
  // 否则列表、条数、「清空」按钮的可用性全部停在打开那一刻的快照上。
  $effect(() => {
    return notifStore.subscribe((v) => {
      notifs = normalizeNotifs(v);
    });
  });
  /**
   * 「清空」被设备拒绝时的句子。与 `PushSettings` 同一条规则、同一个键：同一个事实
   * （「设备没有清历史」）不该有两个说法。
   */
  let clearErr = $state("");
  /**
   * 「清空」**本地那一半**被存储拒绝时的句子 —— 与 `clearErr`（设备拒绝）分开两个槽。
   * 同一次手势可能只被其中一方拒绝，而两句话说的是两件不同的事：那句说「设备没清历史」，
   * 这句说「盘没写下去」。姊妹面 `NotificationCenter.persistNotifs` /
   * `DesktopNotificationCenter.persist` 早就把同一个键、同一个动词门在
   * `writeStoreValueChecked` 上，并把这句话放在与设备拒绝**分开**的槽里（REQ-A1423 ∕ F-SH-681）。
   */
  let clearStoreErr = $state("");
  /**
   * Clearing the list must reach the device's push history too: `osPushWatcher` re-reads
   * `push_get_history` every few seconds and writes back any record the store no longer
   * holds, so a local-only clear is undone by the next poll. The predicate is read straight
   * from the store — 「有推送行要清吗」问的是存储里的事实，不是这一页刚渲染出来的那一帧。
   *
   * 而既然写回是事实，**顺序**就不是风格问题：设备那一半是破坏性的、且它可能被拒，所以
   * 先问设备，由它的答复决定本地那一半——与同族的 `PushSettings.clearPushHistory` 逐字
   * 同一条纪律（「The local wipe is the destructive step, so it waits for the device to
   * confirm」）。`clearNotificationHistory()` 返回的正是这个判决（`push_clear_history`
   * 答的是 unit，除了诊断账本之外拒绝与成功无从分辨 —— REQ-A845 ∕ F-SH-270），所以
   * 把判决丢掉的写法会先清本地、再让轮询把设备仍然持有的记录写回来：屏幕先清空又复活，
   * 而用户什么也没被告知。
   *
   * 门的**范围**必须与理由同宽：写回本地的是 `osPushWatcher`，而它在没有桥时第一步就
   * 返回（`if (!bridged()) return 0`）。所以「没有宿主」既没有设备历史可清、也没有轮询
   * 会写回，那一下本来就是纯本地的动作，不该被一句问不到的判决拦住。
   *
   * 而设备那一半清完之后，**本地那一半自己也是一个可能被拒的写**：`writeJson` 在
   * `setItem` 抛错（配额满 ∕ 私有模式无存储）时回 `false`，且**不派发 `STORE_CHANGED_EVENT`**。
   * 所以这一下的判决也必须读 —— 否则 `notifs = []` 把屏幕清成「无通知」，盘上那几行原样留着，
   * Dock 的徽记（订阅同一个键）照旧计数，下一次任何成功的写入又把它们拉回屏幕上
   * （REQ-A1423 ∕ F-SH-681，与 REQ-A1391 ∕ F-SH-650 同族：那一脚修的是 `NotificationCenter`，
   * 漏掉了这两个设置面）。
   */
  const clearAll = async () => {
    clearErr = "";
    clearStoreErr = "";
    const hadDeliveries = normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, [])).some(
      (n) => n.source === "push",
    );
    if (hadDeliveries && bridged() && !(await clearNotificationHistory())) {
      // 设备没做 ⇒ 本地一条也不许删。列表还画着它仍然持有的那几条，正如这句话所说。
      clearErr = t("pushSettings.clearFailed");
      return;
    }
    // 本地这一半同样是破坏性的：盘没写下去就不能动屏幕 —— 否则那句话是「无通知」，
    // 而存储里一条都没少。
    if (!writeStoreValueChecked(NOTIF_KEY, [])) {
      clearStoreErr = t("common.storeWriteFailed");
      return;
    }
    notifs = [];
  };
</script>


<div class="space-y-5">
  <section class={GROUP}>
    <ToggleRow label={t("settings.dnd")} on={dnd} ontoggle={toggleDnd} />
    {#if dndErr}
      <!-- 渲染在它自己那一行**正下方**，不是页面别处 —— 一次没生效的静音必须当场说出来，
           否则屏幕上唯一的那句话正是「勿扰模式已开启」（F-SH-630）。用共用的 `StoreErrorBar`：
           「存储拒写」这句话在别处都出自这一个组件、同一枚 testid。 -->
      <StoreErrorBar message={dndErr} />
    {/if}
    <div class="px-4 pb-3">
      <p class={HINT}>{dnd ? t("settings.dndOn") : t("settings.dndOff")}</p>
    </div>
  </section>

  <!-- REQ-A499: the push panel below is the **same component** the 「推送通知管理」page
       renders — one implementation of the device commands, two entry points. -->
  <PushSettings onhistorycleared={(remaining) => (notifs = remaining)} />

  <section class={GROUP}>
    <div class="flex items-center justify-between gap-2 px-4 py-3">
      <span class={LABEL}>{t("settings.notifList")}</span>
      <button
        onclick={clearAll}
        disabled={notifs.length === 0}
        class="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 disabled:opacity-40 dark:bg-white/10"
      >
        {t("settings.notifClear")}
      </button>
    </div>
    {#if clearErr}
      <!-- 渲染在**它自己的控件那一块**里（这里是「清空」按钮的正下方），不是页面别处：
           一条用户接不到刚按下的那个按钮上的拒绝，读起来就是「什么也没发生」（F-SH-270
           的形状 —— 同族的 `PushSettings` 为它自己那条拒绝写下了同样的理由）。 -->
      <div class="px-4 pb-3">
        <p class="text-xs text-red-500" role="alert" data-testid="notif-clear-error">{clearErr}</p>
      </div>
    {/if}
    {#if clearStoreErr}
      <!-- 「存储拒写」这条句子在本文件里一律出自共用的 `StoreErrorBar`（见上面 `dndErr`
           那条注释），渲染在**它自己的控件那一块**里、与设备拒绝分成两块。 -->
      <div class="px-4 pb-3" data-testid="notif-clear-store-error">
        <StoreErrorBar message={clearStoreErr} />
      </div>
    {/if}
    {#if notifs.length === 0}
      <div class="px-4 pb-4">
        <p class={HINT}>{t("settings.notifEmpty")}</p>
      </div>
    {:else}
      <ul class="border-t border-black/5 dark:border-white/10">
        {#each notifs.slice(0, 10) as n (n.id)}
          <li class="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
            <div class="min-w-0">
              <p class="truncate font-medium">{n.app ?? ""}</p>
              {#if n.title}
                <p class="truncate opacity-80">{n.title}</p>
              {/if}
              {#if n.body}
                <p class="truncate text-xs opacity-50">{n.body}</p>
              {/if}
            </div>
            <span class="shrink-0 text-xs opacity-50">
              {new Date(n.time).toLocaleTimeString()}
            </span>
          </li>
        {/each}
      </ul>
      {#if notifs.length > 10}
        <p class="border-t border-black/5 px-4 py-2 text-xs opacity-50 dark:border-white/10">
          {t("settings.notifMore", { n: String(notifs.length - 10) })}
        </p>
      {/if}
    {/if}
  </section>
</div>
