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
   *   • it does **not** invent notifications — an empty list says so. (When this panel was
   *     written the touch sheet still seeded three demo rows via `seedNotifs`; that seeding
   *     is gone as of REQ-A1249, because a list that invents entries reports arrivals that
   *     never happened — and those rows went into the **shared** `amos.notifications` key, so
   *     this panel drew them too and `NotificationBanner` announced the newest with a chime.)
   *   • no widgets section (macOS puts clocks/weather above the list).
   */
  import { onMount } from "svelte";
  import { readStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import { createStoreValue } from "./store";
  import {
    NOTIF_KEY,
    SETTINGS_KEY,
    dndActive,
    droppedAppNotifs,
    markNotifRead,
    normalizeNotifs,
    normalizeQuick,
    removeAppNotifs,
    removeNotif,
    unreadCount,
    type Notif,
    type QuickSettings,
  } from "../lib/settings";
  import { appIdForDisplayName } from "../lib/appMeta";
  import { bridged } from "../lib/backend";
  import { wmOpenWithDiag } from "../lib/wm";
  import { announceAppOpened } from "../lib/shortcuts";
  import {
    clearNotificationHistory,
    deleteDeliveriesOnDevice,
    deleteNotification,
    markNotificationRead,
  } from "../lib/pushNotifications";
  import { fmtClock } from "../lib/time";
  import { iconSvg } from "../lib/sysIcons";
  import {
    GLASS_CONTROL_CENTER_STYLE,
    GLASS_BORDER_SUBTLE,
    CHROME_MENU_ITEM,
  } from "../lib/shellChrome";
  import { attachFocusTrap } from "../lib/focusTrap";
  import { t, ALL_LABEL_DICTS } from "./locale.svelte";
  import StoreErrorBar from "./StoreErrorBar.svelte";

  // 关闭由壳决定（浮层从注册表渲染，壳传 `onclose`）——见 Launchpad.svelte 的同一处说明。
  let { onclose }: { onclose?: () => void } = $props();

  const notifStore = createStoreValue<Notif[]>(NOTIF_KEY, []);
  const settingsStore = createStoreValue<QuickSettings>(SETTINGS_KEY, {});
  let notifs = $state<Notif[]>(normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, [])));
  let quick = $state<QuickSettings>(normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {})));
  let storeError = $state("");
  /** 「设备没照做」的句子 —— 与 `storeError` 分开放，一次写失败不该抹掉另一件事的说法。 */
  let pushErr = $state("");

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

  /**
   * A push row here is a **projection** of the device's history — `osPushWatcher` re-reads
   * `push_get_history` every few seconds and writes back anything the store no longer holds
   * — so a removal that stops at this panel is undone by the next poll. `markRead` below has
   * always relayed to the device; these two did not.
   */
  async function clear(): Promise<void> {
    pushErr = "";
    const hadDeliveries = normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, [])).some(
      (n) => n.source === "push",
    );
    // The device half is the destructive one and it can be refused, so it goes **first** and
    // its answer decides the local half — the rule `settings/NotificationsPage.svelte`'s
    // `clearAll` (REQ-A1238) and `PushSettings.clearPushHistory` already state. The rows are
    // gone by the time the next poll writes them back, so "they stay on screen" is not a
    // disclosure. `bridged()` bounds the gate to its reason: without a host there is no
    // history to clear and no poll to write one back.
    if (hadDeliveries && bridged() && !(await clearNotificationHistory())) {
      pushErr = t("pushSettings.clearFailed");
      return;
    }
    persist([]);
  }

  /**
   * The same projection rule as `clear` above, one row at a time. The verdict here is **not**
   * the command's boolean: `delete_notification` answers whether the device held the id, and a
   * well-formed `false` ("it never had this one") is a **success** — removing locally is right.
   * What can strand the row is a call that never reached the device, and that is exactly the
   * `null` (REQ-A1352). It used to be recovered from the *per-command* `bridgeDiag` slot, which
   * is one entry shared by every call of `push_delete_notification`: two dismissals in flight
   * at once each read whichever outcome landed last, so a refusal could be hidden by another
   * row's success and the row removed while the device still held it.
   *
   * `bridged()` still bounds the *no-host* case: without a host there is nothing to delete and
   * no poll to write it back, so that tap stays purely local.
   */
  async function dismiss(id: string): Promise<void> {
    pushErr = "";
    if (notifs.find((n) => n.id === id)?.source === "push") {
      const verdict = await deleteNotification(id);
      if (verdict === null && bridged()) {
        pushErr = t("pushSettings.deleteFailed");
        return;
      }
    }
    persist(removeNotif(notifs, id));
  }

  /** 点一条通知 = 已读（并把回执回报给设备侧，best-effort、离线是 no-op）。 */
  function markRead(id: string): void {
    persist(markNotifRead(notifs, id));
    void markNotificationRead(id);
  }

  /**
   * 点一张卡片 = **打开发它的那个应用**（macOS 的行为：通知可读、也可去），并把该应用在
   * 本面板里的通知一并 ack 掉 —— 本仓既有的「打开即已读」约定（`removeAppNotifs`，
   * `DesktopNotificationBanner` 用的是同一条）。
   *
   * 目标不是一条 id，而是一次**反查**：通知里的 `app` 是**显示串**（`MailApp` 写
   * `zh["app.mail"]`、`calendarCore` 写 `bgT("app.calendar")`、push 载荷是自由文本），
   * 所以 `appIdForDisplayName` 是这里唯一能把「谁发的」翻成「打开谁」的规则，且它要试
   * **所有** locale（见 `locale.svelte.ts::ALL_LABEL_DICTS` —— 一条英文界面上发出的通知，
   * 名字是英文，应用不是）。
   *
   * 反查不到就**没有可点区域**（`{#if appId}`）：push 的自由文本 `app` 与遥测审计自己的
   * 「外发泄漏审计」都不指向任何应用，摆一颗按下去什么都不做的钮正是本仓记为 F-SH-001 /
   * F-SH-426 那一族。（REQ-A1125）
   *
   * Prop-read ordering（与 `DockContextMenu` 同一条）：`onclose?.()` 会立刻卸载本面板，所以
   * `n.app` 必须在 `await` **之前**读进局部量 —— Svelte 5 里已卸载组件的 prop getter 读取会抛。
   */
  async function openSource(n: Notif) {
    const appName = n.app;
    const appId = appIdForDisplayName(appName, ALL_LABEL_DICTS);
    if (!appId) return; // 该行不可点，见上
    const r = await wmOpenWithDiag(appId);
    if (!r.ok) {
      // 宿主拒绝（或桥不在）：面板留着，用户还能看别的；一行面包屑供排障。
      const diag = r.diag;
      const code =
        !diag.ok && diag.kind === "command-failed" && diag.detail && typeof diag.detail === "object"
          ? (diag.detail as { code?: string }).code
          : undefined;
      console.warn(
        `🛟 [notification center] wm_open(${appId}) refused`,
        code ?? (diag.ok ? "inconsistent-diagnostic" : diag.kind),
      );
      return;
    }
    announceAppOpened(appId);
    // 「打开即已读」也是一次**删除**，所以它和 `dismiss` 一样欠设备那一半 —— 这个键是设备推送
    // 历史的投影，只删本地的行会在下一次轮询后原样回来，而横幅会把它当成又一次新到达播报
    // （REQ-A1260；同一份义务逐字写在 `dismiss` 与本轮的 `pushNotifications` 助手上）。
    if (appName) {
      deleteDeliveriesOnDevice(droppedAppNotifs(notifs, appName));
      persist(removeAppNotifs(notifs, appName));
    }
    onclose?.();
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
  一张卡片的**内容**，只写一次：应用名行 + 标题 + 正文。
  `pr-24` 让出右上角那块绝对定位区（到达时刻 + ✓ ∕ ✕），应用名因此不会钻到按钮底下。
  `nc-push-badge` 仍在这里 —— 它标记的是**投递渠道**，与卡片是否可点无关。
-->
{#snippet cardBody(n: Notif)}
  <div class="pr-24 text-[11px] text-white/70">
    <span class="flex min-w-0 items-center gap-1.5">
      <span class="truncate font-semibold text-white/90">{n.icon} {n.app ?? n.title}</span>
      {#if n.source === "push"}
        <span
          data-testid="nc-push-badge"
          class="shrink-0 rounded-full bg-neutral-900/60 px-1.5 py-0.5 text-[10px] font-semibold text-white"
        >{t("nc.pushBadge")}</span>
      {/if}
    </span>
  </div>
  {#if n.title}<div class="mt-1 text-[13px] font-medium text-white/95">{n.title}</div>{/if}
  {#if n.body}<div class="text-[12px] text-white/70">{n.body}</div>{/if}
{/snippet}

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

    {#if pushErr}
      <p
        role="status"
        data-testid="dnc-push-refused"
        class="mb-2 shrink-0 rounded-lg bg-black/5 px-3 py-1.5 text-[11px] text-danger dark:bg-white/10"
      >
        {pushErr}
      </p>
    {/if}

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
          {@const appId = appIdForDisplayName(n.app, ALL_LABEL_DICTS)}
          <!--
            整张卡片是一颗按钮（当且仅当 `app` 能反查到一个内置应用时）；到达时刻与 ✓ ∕ ✕ 是
            绝对定位的**兄弟**，不是按钮的子节点 —— 按钮里不能再套按钮（HTML），而把卡片写成
            `role="button"` 的 div 又要自己实现一整套键盘模型（本仓记为「声明的 role 是一个承诺」）。
            卡片内容只写**一次**（`{#snippet}`），两个分支各自只换外壳。
          -->
          <div
            data-testid={`nc-notif-${n.id}`}
            class={"relative rounded-2xl ring-1 ring-white/10 " +
              (quiet || (n.source === "push" && n.read === true)
                ? "bg-white/5 opacity-60"
                : "bg-white/12")}
          >
            {#if appId}
              <button
                type="button"
                data-testid="nc-open"
                onclick={() => void openSource(n)}
                aria-label={t("nc.openApp", { app: n.app ?? n.title ?? "" })}
                class="block w-full rounded-2xl p-3 text-left"
              >
                {@render cardBody(n)}
              </button>
            {:else}
              <div class="rounded-2xl p-3">{@render cardBody(n)}</div>
            {/if}

            <span class="absolute right-2 top-2.5 flex shrink-0 items-center gap-0.5">
              <!-- 到达时刻（真值；相对时间未做，见文件头边界）。 -->
              <span class="text-[11px] tabular-nums text-white/70">{fmtClock(new Date(n.time))}</span>
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
        {/each}
      {/if}
    </div>
  </div>
</div>
