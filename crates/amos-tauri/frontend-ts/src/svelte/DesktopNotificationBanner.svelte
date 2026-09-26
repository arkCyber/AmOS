<script lang="ts">
  // DesktopNotificationBanner.svelte — G-γ · 桌面通知 banner（macOS 右上角 toast）。
  //
  // 与 phone 形态的 `NotificationBanner.svelte` **同源**：复用 5 个纯函数 /
  // 4 个策略 helper，不复制「检测新到 / 单击 ack 清空 / DND / 静音 / 触觉」任一条路径。
  //
  // 复用清单：
  //   * `newestAddedNotif` (lib/settings.ts)  —— 检测新到的那一条
  //   * `removeAppNotifs`    (lib/settings.ts)  —— 单击 ack 清该 app 所有通知
  //   * `dndActive / normalizeQuick` (lib/settings.ts)  —— DND 门
  //   * `shouldRingOnArrival / effectiveAlert` (lib/sound.ts)  —— 提示音策略
  //   * `playNotifyTone` (lib/notifyTone.ts)  —— 提示音合成
  //   * `NOTIF_BANNER_SHOW_MS / TOPBAR_HEIGHT / *_OFFSET / *_MAX_WIDTH`
  //     (lib/desktopLayout.ts)  —— 几何 / 时间常量（**唯一**真源）
  //
  // 不做的（macOS 真实行为留给后续 G-δ+）：
  //   * 不打开 app（点 banner = 标记已读，与 phone banner 同源语义）
  //   * 不做通知分组 / 通知聚合（macOS Monterey+）
  //   * 不响 haptic pulse（桌面无马达）
  //   * 不在多次到达时堆叠 banner —— macOS Big Sur+ 同一时刻**只显示一张**，
  //     旧通知移到通知中心；这里对齐这个语义。
  //
  // 几何常量：
  //   * top = `TOPBAR_HEIGHT + NOTIF_BANNER_TOP_OFFSET` （24 + 6 = 30 px）
  //   * right = `NOTIF_BANNER_RIGHT_OFFSET`            （8 px）
  //   * max-width = `NOTIF_BANNER_MAX_WIDTH`           （360 px）
  //
  // a11y：
  //   * `role="alert"` + `aria-live=assertive` —— 通知到达是"中断我"事件
  //     （REQ-A284），polite 会输给聚焦任务
  //   * `tabindex="-1"` —— **不抢焦点**，避免打断正在打字的用户
  //
  // 挂载点：`DesktopShell.svelte` 的浮层 `<div>` 之前 —— z 序
  // z = `100 + index`（overlay） > banner（见 mount 处写在 stage 之后，
  // 但**不放在** `{#each openOverlays}` 内）。
  import { writeStoreValueChecked } from "../lib/amosStore";
  import { deleteDeliveriesOnDevice } from "../lib/pushNotifications";
  import {
    NOTIF_KEY,
    SETTINGS_KEY,
    dndActive,
    droppedAppNotifs,
    newestAddedNotif,
    normalizeNotifs,
    normalizeQuick,
    removeAppNotifs,
    type Notif,
  } from "../lib/settings";
  import {
    SOUND_KEY,
    effectiveAlert,
    normalizeSound,
    shouldRingOnArrival,
  } from "../lib/sound";
  import { playNotifyTone } from "../lib/notifyTone";
  import {
    NOTIF_BANNER_SHOW_MS,
    NOTIF_BANNER_RIGHT_OFFSET,
    NOTIF_BANNER_MAX_WIDTH,
    NOTIF_BANNER_TOP_OFFSET,
    TOPBAR_HEIGHT,
  } from "../lib/desktopLayout";
  import { createStoreValue } from "./store";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { t } from "./locale.svelte";

  // ─── store 订阅（与 phone banner 同源）────────────────────────────────────
  const notifStore = createStoreValue<unknown>(NOTIF_KEY, []);
  const settingsStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  const soundStore = createStoreValue<unknown>(SOUND_KEY, {});

  let notifs = $state<Notif[]>([]);
  let settingsRaw = $state<unknown>({});
  let soundRaw = $state<unknown>({});
  let banner = $state<Notif | null>(null);
  // 上一次 ack 被存储拒绝时的那句话（REQ-A1408 ∕ F-SH-666）。
  let storeErr = $state("");

  // Transient mirrors —— 不参与响应式（避免每次渲染重建）。
  let prev: Notif[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 首读 store 时不要把「已经存在」的条目当作「刚刚到」 —— 与 phone banner 同源。
  let seeded = false;

  $effect(() => {
    const un = notifStore.subscribe((v) => {
      const list = normalizeNotifs(v);
      if (!seeded) {
        seeded = true;
        prev = list;
      }
      notifs = list;
    });
    return un;
  });
  $effect(() => {
    const un = settingsStore.subscribe((v) => (settingsRaw = v));
    return un;
  });
  $effect(() => {
    const un = soundStore.subscribe((v) => (soundRaw = v));
    return un;
  });

  const dnd = $derived(dndActive(normalizeQuick(settingsRaw)));
  const policy = $derived(effectiveAlert(normalizeSound(soundRaw), dnd));

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  // ─── 派生几何：真源在 desktopLayout.ts，这里只是把它们相加 ───────────────
  const bannerTop = TOPBAR_HEIGHT + NOTIF_BANNER_TOP_OFFSET;

  // ─── 主循环：到达 / DND / 超时 ────────────────────────────────────────────
  $effect(() => {
    clearTimer();
    if (dnd) {
      // DND 抑制 banner 与提示音 —— 与 phone banner 同源语义。
      banner = null;
      prev = notifs;
      return;
    }
    const added = newestAddedNotif(prev, notifs);
    if (added) {
      banner = added;
      storeErr = ""; // 新到达换掉旧 toast，旧拒写的那句话随之作废
      timer = setTimeout(() => {
        banner = null;
        timer = null;
      }, NOTIF_BANNER_SHOW_MS);
    }
    // 提示音门：沿用 phone banner 的真源（shouldRingOnArrival）—— 桌面无 haptic。
    // 门据是**这一次到达**（`added`：`prev` 里没有的 id），不是表长了多少 ——
    // `amos.notifications` 有上限，满表时一次真投递让长度不变，旧的 `prev.length` ∕
    // `notifs.length` 把它读成「没有到达」而彻底不响（REQ-A1636，与 `osPushWatcher.ts`
    // 记下的同一处长度差折叠同源，REQ-A589）。只收缩或原样重读的表依旧不是到达：
    // `newestAddedNotif` 回 `null`，门保持关着。
    if (shouldRingOnArrival(added !== null, policy)) {
      playNotifyTone({ volume: policy.volume });
    }
    prev = notifs;
  });

  // 单击 ack：清空该 app 所有通知（不是单条 —— 钉住 `removeAppNotifs` 真源）。
  //
  // ack 是一次**删除**，而 `amos.notifications` 是设备推送历史的投影：`osPushWatcher` 每几秒
  // 重问一次 `push_get_history`，把存储里已经没有的记录写回。所以被丢掉的那些**推送**行必须
  // 同时从设备删掉 —— 只删本地的话，id 会在下一次轮询后原样回来，而横幅的「新到达」检测比的是
  // id 集合，于是同一次投递被第二次播报（toast + 提示音 + 本应在另一形态的震动）。两块面板的
  // `dismiss` 从 REQ-A1202 起就已经这么做，这里是同一个删除、同一份义务（REQ-A1260）。
  const ack = () => {
    const b = banner;
    if (!b) return;
    if (b.app) {
      // 先取快照：写成功会同步派发 `STORE_CHANGED_EVENT`，其监听把 `notifs` 换成新表 ——
      // 写之后再读，读到的会是留下来的行，而不是要删掉的那些。
      const dropped = droppedAppNotifs(notifs, b.app);
      // 本地那一半是能读到判决的那一半，也是 ✓ 所声称的那一半：拒写时每一行都还在，
      // 横幅**不能**装作确认成功而消失 —— 说出口并留在原地，用户可再按一次。设备那一半
      // 放在后面：拒绝时绝不把盘上仍然持有的行从设备删掉（REQ-A1408 ∕ F-SH-666）。
      if (!writeStoreValueChecked(NOTIF_KEY, removeAppNotifs(notifs, b.app))) {
        storeErr = t("common.storeWriteFailed");
        clearTimer(); // 否则自动消失会把这句话吞掉
        return;
      }
      deleteDeliveriesOnDevice(dropped);
    }
    storeErr = "";
    banner = null;
    clearTimer();
  };
</script>

{#if banner}
  <div
    role="alert"
    tabindex="-1"
    aria-live="assertive"
    aria-atomic="true"
    data-testid="desktop-notif-banner"
    data-banner-top={bannerTop}
    data-banner-right={NOTIF_BANNER_RIGHT_OFFSET}
    data-banner-max-width={NOTIF_BANNER_MAX_WIDTH}
    data-banner-show-ms={NOTIF_BANNER_SHOW_MS}
    class="pointer-events-auto fixed z-[90] rounded-xl bg-white/95 px-4 py-3 text-left shadow-2xl ring-1 ring-black/10 backdrop-blur-md dark:bg-neutral-900/95 dark:ring-white/10"
    style="
      top: {bannerTop}px;
      right: {NOTIF_BANNER_RIGHT_OFFSET}px;
      max-width: {NOTIF_BANNER_MAX_WIDTH}px;
    "
  >
    <button
      onclick={ack}
      aria-label={t("a11y.acknowledgeNotification")}
      data-testid="desktop-notif-ack"
      class="flex w-full cursor-pointer items-start gap-3 text-left"
    >
      <span class="text-xl leading-none" aria-hidden="true">{banner.icon ?? "🔔"}</span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13px] font-semibold text-neutral-900 dark:text-white">
          {banner.app ?? banner.title ?? t("nc.untitled")}
        </span>
        {#if banner.title}
          <span class="block truncate text-[12px] text-neutral-700 dark:text-neutral-300">
            {banner.title}
          </span>
        {/if}
        {#if banner.body}
          <span class="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
            {banner.body}
          </span>
        {/if}
      </span>
      <span aria-hidden="true" class="opacity-50">✓</span>
    </button>
    <StoreErrorBar message={storeErr} />
  </div>
{/if}
