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
  import { writeStoreValue } from "../lib/amosStore";
  import {
    NOTIF_KEY,
    SETTINGS_KEY,
    dndActive,
    newestAddedNotif,
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

  // ─── store 订阅（与 phone banner 同源）────────────────────────────────────
  const notifStore = createStoreValue<Notif[]>(NOTIF_KEY, []);
  const settingsStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  const soundStore = createStoreValue<unknown>(SOUND_KEY, {});

  let notifs = $state<Notif[]>([]);
  let settingsRaw = $state<unknown>({});
  let soundRaw = $state<unknown>({});
  let banner = $state<Notif | null>(null);

  // Transient mirrors —— 不参与响应式（避免每次渲染重建）。
  let prev: Notif[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 首读 store 时不要把「已经存在」的条目当作「刚刚到」 —— 与 phone banner 同源。
  let seeded = false;

  $effect(() => {
    const un = notifStore.subscribe((v) => {
      if (!seeded) {
        seeded = true;
        prev = v;
      }
      notifs = v;
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
      timer = setTimeout(() => {
        banner = null;
        timer = null;
      }, NOTIF_BANNER_SHOW_MS);
      // 提示音门：沿用 phone banner 的真源（shouldRingOnArrival）—— 桌面无 haptic。
      if (shouldRingOnArrival(prev.length, notifs.length, policy)) {
        playNotifyTone({ volume: policy.volume });
      }
    }
    prev = notifs;
  });

  // 单击 ack：清空该 app 所有通知（不是单条 —— 钉住 `removeAppNotifs` 真源）
  const ack = () => {
    const b = banner;
    if (!b) return;
    if (b.app) {
      writeStoreValue(NOTIF_KEY, removeAppNotifs(notifs, b.app));
    }
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
      aria-label="notification: acknowledge"
      class="flex w-full cursor-pointer items-start gap-3 text-left"
    >
      <span class="text-xl leading-none" aria-hidden="true">{banner.icon ?? "🔔"}</span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13px] font-semibold text-neutral-900 dark:text-white">
          {banner.app ?? banner.title ?? "Notification"}
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
  </div>
{/if}
