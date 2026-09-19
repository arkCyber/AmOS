<script lang="ts">
  /**
   * DesktopNotificationCenter.svelte — macOS's right-hand notification panel.
   *
   * REQ-A417. `docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md` G6 registered the gap「**桌面没有通知
   * 中心**（macOS 右半边）」 — on a Mac you click the **clock** and notifications slide in
   * from the right. The desktop had no such surface, so notifications produced anywhere in
   * the OS (the push backend, the timer/alarm/reminder watchers, `NotificationBanner`) were
   * reachable only by opening Settings.
   *
   * Why a **desktop** panel and not the touch `NotificationCenter.svelte`: that sheet also
   * carries the six quick-setting tiles (Wi-Fi / Bluetooth / Airplane / Dark / DND /
   * Location). The desktop already has those in `ControlCenter`, so mounting the touch sheet
   * here would be **two implementations of the same device rules** — the defect class this
   * audit removed as F-SH-005. What *is* shared is deliberate, and is the part that must not
   * fork: the `amos.notifications` store, the pure helpers (`normalizeNotifs` /
   * `unreadCount` / `markNotifRead` / `removeNotif`), the device-side read receipt
   * (`markNotificationRead`, best-effort), the i18n strings (`nc.*`) and the
   * `nc-notif-<id>` row testid.
   *
   * Honest boundaries (stated, not hidden):
   *   • no relative timestamps — each row shows the **clock time** it arrived (`fmtClock`);
   *     the repo has no relative-time helper and inventing one is a formatting decision for
   *     a different round;
   *   • it does **not** seed demo notifications the way the touch sheet does
   *     (`seedNotifs`), because a panel that invents entries reports arrivals that never
   *     happened — an empty list says so;
   *   • no widgets section (macOS puts clocks/weather above the list).
   */
  import { onMount } from "svelte";
  import { readStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import { createStoreValue } from "./store";
  import {
    NOTIF_KEY,
    SETTINGS_KEY,
    dndActive,
    markNotifRead,
    normalizeNotifs,
    normalizeQuick,
    removeNotif,
    unreadCount,
    type Notif,
    type QuickSettings,
  } from "../lib/settings";
  import { markNotificationRead } from "../lib/pushNotifications";
  import { fmtClock } from "../lib/time";
  import { iconSvg } from "../lib/sysIcons";
  import {
    GLASS_CONTROL_CENTER_STYLE,
    GLASS_BORDER_SUBTLE,
    CHROME_MENU_ITEM,
  } from "../lib/shellChrome";
  import { attachFocusTrap } from "../lib/focusTrap";
  import { t } from "./locale.svelte";
  import StoreErrorBar from "./StoreErrorBar.svelte";

  // 关闭由壳决定（浮层从注册表渲染，壳传 `onclose`）——见 Launchpad.svelte 的同一处说明。
  let { onclose }: { onclose?: () => void } = $props();

  const notifStore = createStoreValue<Notif[]>(NOTIF_KEY, []);
  const settingsStore = createStoreValue<QuickSettings>(SETTINGS_KEY, {});
  let notifs = $state<Notif[]>(normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, [])));
  let quick = $state<QuickSettings>(normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {})));
  let storeError = $state("");

  // 两条订阅：通知本身，以及"勿扰"（面板要如实说明当前是静音的）。
  $effect(() => {
    const unNotifs = notifStore.subscribe((v) => {
      notifs = normalizeNotifs(v);
    });
    const unQuick = settingsStore.subscribe((v) => {
      quick = normalizeQuick(v);
    });
    return () => {
      unNotifs();
      unQuick();
    };
  });

  const unread = $derived(unreadCount(notifs));
  const quiet = $derived(dndActive(quick));

  /** 写失败必须说出来（本次改动未保存），不能只改屏幕上的列表。 */
  function persist(next: Notif[]): void {
    storeError = writeStoreValueChecked(NOTIF_KEY, next) ? "" : t("common.storeWriteFailed");
  }

  function clear(): void {
    persist([]);
  }

  function dismiss(id: string): void {
    persist(removeNotif(notifs, id));
  }

  /** 点一条通知 = 已读（并把回执回报给设备侧，best-effort、离线是 no-op）。 */
  function markRead(id: string): void {
    persist(markNotifRead(notifs, id));
    void markNotificationRead(id);
  }

  let panelEl = $state<HTMLElement | null>(null);
  onMount(() => {
    const el = panelEl;
    if (!el) return;
    // 键盘：焦点收进面板、Tab 环留在面板内、Escape 关闭 —— 与其它浮层同一条规则
    // （`attachFocusTrap` 还会把焦点还给打开它的人）。
    return attachFocusTrap(el, () => onclose?.());
  });
</script>

<!--
  浮层：背板与面板是**兄弟**（不是父子），所以面板不需要 stopPropagation —— 点背板关闭，
  点面板不冒泡到背板。Escape / Tab 环由 focus trap 处理（`attachFocusTrap(el, onclose)`）。
  面板用 `<div role="dialog">`（`section` 的隐式 role 是 region，套 `dialog` 会被 a11y 规则
  拒绝；Mission Control 用的是同一写法）。
-->
<div class="absolute inset-0">
  <div
    class="absolute inset-0"
    role="presentation"
    aria-hidden="true"
    onclick={() => onclose?.()}
  ></div>

  <div
    bind:this={panelEl}
    class="absolute bottom-0 right-0 top-0 flex w-[360px] flex-col p-3 text-white"
    style="{GLASS_CONTROL_CENTER_STYLE} {GLASS_BORDER_SUBTLE} border-left: 1px solid rgba(255,255,255,0.10);"
    role="dialog"
    aria-modal="true"
    aria-label={t("nc.title")}
    data-testid="desktop-notification-center"
  >
    <StoreErrorBar message={storeError} />

    <header class="mb-2 flex items-baseline justify-between gap-2 px-1">
      <h2 class="text-[15px] font-semibold tracking-tight">{t("nc.title")}</h2>
      <span class="flex-1 text-[11px] text-white/60">
        {#if quiet}
          <span class="inline-flex items-center gap-1 text-accent">
            <span aria-hidden="true">{@html iconSvg("moon", "h-3.5 w-3.5")}</span>
            {t("nc.dnd")}
          </span>
        {:else}
          {notifs.length}{#if unread > 0} · {t("nc.unread", { count: unread })}{/if}
        {/if}
      </span>
      <button
        type="button"
        class={CHROME_MENU_ITEM + " w-auto px-2"}
        onclick={clear}
        disabled={notifs.length === 0}
        aria-label={t("nc.clear")}
      >{t("nc.clear")}</button>
    </header>

    <div class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5" data-testid="dnc-list">
      {#if notifs.length === 0}
        <p class="py-12 text-center text-[13px] text-white/45">{t("nc.empty")}</p>
      {:else}
        {#each notifs as n (n.id)}
          {@const unreadPush = n.source === "push" && n.read === false}
          <div
            data-testid={`nc-notif-${n.id}`}
            class={"rounded-2xl p-3 ring-1 ring-white/10 " +
              (quiet || (n.source === "push" && n.read === true)
                ? "bg-white/5 opacity-60"
                : "bg-white/12")}
          >
            <div class="flex items-center justify-between gap-2 text-[11px] text-white/70">
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="truncate font-semibold text-white/90">{n.icon} {n.app ?? n.title}</span>
                {#if n.source === "push"}
                  <span
                    data-testid="nc-push-badge"
                    class="shrink-0 rounded-full bg-neutral-900/60 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                  >{t("nc.pushBadge")}</span>
                {/if}
              </span>
              <span class="flex shrink-0 items-center gap-0.5">
                <!-- 到达时刻（真值；相对时间未做，见文件头边界）。 -->
                <span class="tabular-nums">{fmtClock(new Date(n.time))}</span>
                {#if unreadPush}
                  <button
                    type="button"
                    onclick={() => markRead(n.id)}
                    aria-label={t("nc.markRead")}
                    data-icon="check"
                    class="grid h-6 w-6 place-items-center rounded-full opacity-70 transition hover:opacity-100"
                  >{@html iconSvg("check", "h-3 w-3")}</button>
                {/if}
                <button
                  type="button"
                  onclick={() => dismiss(n.id)}
                  aria-label={t("a11y.dismiss")}
                  data-icon="x"
                  class="grid h-6 w-6 place-items-center rounded-full opacity-70 transition hover:opacity-100"
                >{@html iconSvg("x", "h-3 w-3")}</button>
              </span>
            </div>
            {#if n.title}<div class="mt-1 text-[13px] font-medium text-white/95">{n.title}</div>{/if}
            {#if n.body}<div class="text-[12px] text-white/70">{n.body}</div>{/if}
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>
