<script lang="ts">
  // PushSettings.svelte — 设备推送后端面板（REQ-A383 的实现；REQ-A499 抽成**共享组件**）。
  //
  // 为什么是一个组件而不是两个页面各写一份：这一块读写的都是**同一套设备推送命令**
  // （`push_get_status` / `push_request_permission` / `push_clear_history` /
  // `push_simulate_receive`），而本仓为"同一规则两份实现"付过代价（F-SH-005）。所以
  // 「通知」页与「推送通知管理」页渲染的是**同一个** `PushSettings`，两者的差别只在页面外壳。
  //
  // 诚实边界（沿用 REQ-A383，逐条都是决定而非疏忽）：
  //   • `pushStatus === null` 表示**还没问到**，页面绝不把它说成"没有推送"；
  //   • 宿主根本没答与后端答 `available: false` 是**两件不同的事**，两种文案；而"根本没答"
  //     自己又分两种：**没桥**（`pushOffline`）与**桥在、宿主拒绝作答**（`pushUnanswered`）。
  //     REQ-A1335 / F-SH-601 之前这两条被并成一条 —— `getPushStatus()` 为一个拒答的宿主
  //     合成了一份 `available: false` 的完整状态，于是页面把"我没问到"画成了
  //     「此设备上没有可用的推送后端」，而且只有没桥那条分支给了重试。
  //   • 只在 `available` 时才画令牌与统计 —— 平台没有推送后端时不该给出一屏不能用的控件。
  //   • `permission_backend === null`（宿主没有可申请的系统权限接口）时**不画**「允许通知」
  //     按钮，改说一句实话（REQ-A865）。`available` 与 `permission_backend` 是**两件事**：
  //     前者说"这个设备有推送子系统"（真的，宿主确实握着令牌与历史），后者说"系统可以被
  //     问一句"。合成一个 `bool` 的时候，页面画了一个按钮，而它唯一可能的回答说
  //     「你现在可以接收推送通知了」—— 那个授权没有任何人给过。
  import { readStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
  import { bridged } from "../../lib/backend";
  import { dropPushNotifs } from "../../lib/pushNotifBridge";
  import {
    clearNotificationHistory,
    getPushStatus,
    requestPushPermission,
    simulateReceivePush,
    type RustPushStatus,
  } from "../../lib/pushNotifications";
  import { NOTIF_KEY, normalizeNotifs, type Notif } from "../../lib/settings";
  import { t } from "../locale.svelte";
  import { GROUP, LABEL, HINT } from "./kit";
  import StoreErrorBar from "../StoreErrorBar.svelte";

  interface Props {
    /**
     * 「清除推送历史」落地之后，把**剩下的**通知列表交给宿主页面。
     *
     * 单一真源仍是 `amos.notifications`（本组件自己读、自己写），这个回调只是让宿主那份
     * 内存副本跟着变 —— 否则「通知」页会继续渲染刚从存储里删掉的推送行。
     */
    onhistorycleared?: (remaining: Notif[]) => void;
  }
  let { onhistorycleared }: Props = $props();

  let pushStatus = $state<RustPushStatus | null>(null);
  let pushBusy = $state(false);
  /** 没桥 —— 宿主根本不存在。 */
  let pushOffline = $state(false);
  /**
   * 桥在，但宿主拒绝作答（命令被拒 / 无回包）—— 与"没桥"、"后端答不可用"都不同的一件事。
   *
   * 这一格就是 REQ-A1335 / F-SH-601：没有它的时候，拒答被折进了一份合成的
   * `available: false`，页面便把"我没问到"说成了对**设备能力**的断言。
   */
  let pushUnanswered = $state(false);
  /**
   * 「清除推送历史」被宿主拒绝时的句子（REQ-A845）。
   *
   * 与 `pushOffline` 是**不同的**一件事：那个说"没问到"，这个说"问到了、宿主没做"。
   * 空串 = 没有要说的。
   */
  let pushError = $state("");
  /**
   * 「申请通知权限」被宿主拒绝时的句子（REQ-A865）。
   *
   * 与 `pushError` 分开是**必须的**：那条说的是「清除历史被拒」，渲染在清除按钮下面；
   * 这条说的是「权限申请被拒」，必须渲染在**权限按钮自己那一块**里 —— 把拒绝放到别处，
   * 用户按完按钮看到的是"什么也没发生"（F-SH-270 的形状）。
   */
  let permissionError = $state("");
  /**
   * 「清除推送历史」**本地那一半**被**存储**拒绝时的句子（REQ-A1423 ∕ F-SH-681）。
   *
   * 与 `pushError`（宿主拒绝）分开是同一个理由：`permissionError` 上面那段注释已经写下
   * ——「同一个手势的两个不同拒绝，必须各自说自己那句话」。宿主照做了、盘却没写下去时，
   * 本地列表若照样交回宿主页面（`onhistorycleared`），屏幕就画出一份盘上并不存在的表。
   */
  let pushStoreError = $state("");

  const loadPush = async () => {
    pushOffline = false;
    pushUnanswered = false;
    if (!bridged()) {
      pushOffline = true;
      pushStatus = null;
      return;
    }
    const status = await getPushStatus();
    if (status === null) {
      // Bridge present, host silent. **Not** a device-capability claim: keep the panel on
      // the "could not ask" sentence and leave the retry in place (REQ-A1335 / F-SH-601).
      pushUnanswered = true;
      pushStatus = null;
      return;
    }
    pushStatus = status;
  };

  // One read on mount (same one-shot guard the Notification Center uses for its
  // device reads): a retry is an explicit user action, not an effect loop.
  let pushRead = false;
  $effect(() => {
    if (pushRead) return;
    pushRead = true;
    void loadPush();
  });

  const askPermission = async () => {
    pushBusy = true;
    permissionError = "";
    // REQ-A865 / F-DEV-116: **read the verdict.** This used to be a bare
    // `await requestPushPermission();` — the `PushResult` was never bound, so a refusal
    // was indistinguishable from a grant. The host was asked, answered `Unavailable`, and
    // the panel re-read the status, found the `authorized` the host had written into
    // itself, and printed 「你现在可以接收推送通知了」. Reading the result is the half that
    // makes the fabrication visible even if the other half ever comes back.
    const reply = await requestPushPermission();
    if (reply === null) {
      // REQ-A1352: the host never answered. This is **not** `{ kind: "failed" }` and must
      // not borrow its sentence — the library used to supply a synthesized
      // `reason: "push backend unreachable (no host bridge)"` which was rendered verbatim
      // here, an English cause that contradicted the very fact that put this button on
      // screen (`pushStatus.available` is true in this branch, so a host *was* reached).
      permissionError = t("pushPermission.requestUnanswered");
    } else if (reply.kind !== "ok") {
      // Rendered inside the block that owns the button, not at the bottom of the section
      // where `push-clear-error` lives: a refusal the user cannot connect to the control
      // they just pressed reads as nothing having happened (F-SH-270's shape).
      // `reason` is optional on `PushResult` (the `ok` variant has none), so a host that
      // refuses without explaining still gets a sentence — the kind stands in rather than
      // the notice disappearing. `??` and not `||`: an empty-string reason is a value.
      permissionError = t("pushPermission.requestFailed", { reason: reply.reason ?? reply.kind });
    }
    await loadPush();
    pushBusy = false;
  };

  const clearPushHistory = async () => {
    if (!confirm(t("pushSettings.confirmClearAll"))) return;
    pushError = "";
    pushStoreError = "";
    const cleared = await clearNotificationHistory();
    if (!cleared) {
      // REQ-A845 / F-SH-270: `push_clear_history` answers unit, so a refusal is
      // indistinguishable from a success *unless* the verdict is read. Without this the
      // local half below ran anyway — the shell deleted its own copy of notifications the
      // device still had, told the host page the list was empty, and said nothing.
      // The local wipe is the destructive step, so it waits for the device to confirm.
      pushError = t("pushSettings.clearFailed");
      await loadPush();
      return;
    }
    // Local half of the clear: the list must not keep showing what the device no
    // longer has. (The shell's own notifications stay — they are not push's to wipe.)
    const remaining = dropPushNotifs(normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, [])));
    // REQ-A1423 / F-SH-681：本地这一半也可能被存储拒（`writeJson` 回 false 且不派发
    // `STORE_CHANGED_EVENT`）。判决没读的话，`onhistorycleared` 会把一份盘上并不存在的
    // 列表交给宿主页面 —— 设备那一半做完了，屏幕上却是「清掉了」，而重开页面它们又回来。
    if (!writeStoreValueChecked(NOTIF_KEY, remaining)) {
      pushStoreError = t("common.storeWriteFailed");
      await loadPush();
      return;
    }
    onhistorycleared?.(remaining);
    await loadPush();
  };

  /** Dev-only: proves the whole path (payload → Rust history → the shell's list). */
  const sendTestPush = async () => {
    await simulateReceivePush({
      aps: { alert: { title: t("pushSettings.sendTest"), body: "AmOS" } },
    });
    await loadPush();
  };

  const isDev = import.meta.env.DEV;
  const permissionText = $derived(
    pushStatus?.permission === "authorized" || pushStatus?.permission === "provisional"
      ? t("pushPermission.successDescription")
      : pushStatus?.permission === "denied"
        ? t("pushPermission.denied")
        : t("pushPermission.description"),
  );
  const stats = $derived(
    pushStatus === null || pushStatus.statistics === null
      ? []
      : [
          { label: t("pushSettings.totalReceived"), value: pushStatus.statistics.total_received },
          { label: t("pushSettings.withBadge"), value: pushStatus.statistics.with_badge },
          { label: t("pushSettings.withSound"), value: pushStatus.statistics.with_sound },
          { label: t("pushSettings.silent"), value: pushStatus.statistics.silent },
        ],
  );
</script>


<section class={GROUP} data-testid="push-settings">
  <div class="px-4 py-3">
    <p class={LABEL}>{t("pushPermission.title")}</p>
    {#if pushStatus === null}
      <p class="mt-1 {HINT}">
        {#if pushOffline}
          {t("pushSettings.unavailable")}
        {:else if pushUnanswered}
          {t("pushSettings.unanswered")}
        {:else}
          {t("pushSettings.loading")}
        {/if}
      </p>
      {#if pushOffline || pushUnanswered}
        <button
          onclick={() => void loadPush()}
          class="mt-2 rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 dark:bg-white/10"
        >
          {t("pushSettings.retry")}
        </button>
      {/if}
    {:else if !pushStatus.available}
      <!-- The Rust side answers `available: false` on platforms with no push
           backend; the page says so instead of showing controls that cannot work. -->
      <p class="mt-1 {HINT}">{t("pushSettings.unavailable")}</p>
    {:else}
      <p class="mt-1 {HINT}">{permissionText}</p>
      {#if pushStatus.permission === "denied"}
        <p class="mt-1 {HINT}">{t("pushPermission.deniedHint")}</p>
      {/if}
    {/if}
  </div>

  {#if pushStatus?.available}
    {#if pushStatus.permission === "notdetermined"}
      <!-- REQ-A865 / F-DEV-116. 这一块在按下按钮**之前**就决定要不要给按钮：
           `permission_backend === null` 表示宿主没有可申请的系统权限接口，那就**不画**
           「允许通知」—— 画一个唯一可能的回答是"没有真的问过任何人"的按钮，比不画更坏。
           拒绝的句子渲染在**同一块**里（不是页面底部的 `push-clear-error` 那里）。 -->
      <div class="border-t border-black/5 px-4 py-3 dark:border-white/10" data-testid="push-permission">
        {#if pushStatus.permission_backend}
          <button
            onclick={() => void askPermission()}
            disabled={pushBusy}
            class="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white transition active:scale-95 disabled:opacity-50"
          >
            {pushBusy ? t("pushPermission.requesting") : t("pushPermission.request")}
          </button>
          {#if permissionError !== ""}
            <p class="mt-1 {HINT}" data-testid="push-permission-error">{permissionError}</p>
          {/if}
        {:else}
          <p class="{HINT}" data-testid="push-permission-nobackend">
            {t("pushPermission.noBackend")}
          </p>
        {/if}
      </div>
    {/if}

    <div class="border-t border-black/5 px-4 py-3 dark:border-white/10">
      <p class={LABEL}>{t("pushSettings.deviceToken")}</p>
      <p class="mt-1 break-all font-mono text-xs opacity-70">
        {pushStatus.device_token?.token ?? t("pushSettings.noToken")}
      </p>
      {#if pushStatus.device_token}
        <p class="mt-1 text-xs opacity-60">
          {t("pushSettings.environment")}:
          {pushStatus.device_token.environment === "production"
            ? t("pushSettings.envProduction")
            : t("pushSettings.envDevelopment")}
          · {t("pushSettings.registeredAt")} {pushStatus.device_token.registered_at}
        </p>
      {/if}
    </div>

    <!-- `data-testid` 是**契约**：`notifications-page-push.svelte.test.ts` 有一条断言读它
         （「不可用时不应出现统计块」）—— 旧标记里这个钩子不存在 ⇒ 那条断言一直是真空的
         （`querySelector` 恒为 null）。补上之后，同一句话才真的在说"统计块没渲染"。 -->
    <div class="border-t border-black/5 px-4 py-3 dark:border-white/10" data-testid="push-statistics">
      <p class={LABEL}>{t("pushSettings.statistics")}</p>
      <div class="mt-1 grid grid-cols-2 gap-x-4 gap-y-2">
        {#each stats as s (s.label)}
          <p class="text-sm">
            <span class="opacity-60">{s.label}</span>
            <span class="font-medium">{s.value}</span>
          </p>
        {/each}
      </div>
    </div>

    <div class="border-t border-black/5 px-4 py-3 dark:border-white/10">
      <p class={LABEL}>{t("pushSettings.lastReceived")}</p>
      <p class="mt-1 text-xs opacity-70">
        {pushStatus.statistics?.last_received ?? t("pushSettings.never")}
      </p>
    </div>

    <div class="border-t border-black/5 px-4 py-3 dark:border-white/10">
      <button
        onclick={() => void clearPushHistory()}
        class="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 dark:bg-white/10"
      >
        {t("pushSettings.clearAll")}
      </button>
      {#if pushError !== ""}
        <!-- 宿主拒绝了这次清除：设备**仍然**留着历史，所以本地那份一条也没删。 -->
        <p class="mt-1 {HINT}" data-testid="push-clear-error">{pushError}</p>
      {/if}
      {#if pushStoreError !== ""}
        <!-- 宿主照做了、**存储**没写下去：这句话说的是另一件事，所以是另一个槽、另一个
             testid（REQ-A1423 ∕ F-SH-681）。 -->
        <div class="mt-1" data-testid="push-clear-store-error">
          <StoreErrorBar message={pushStoreError} />
        </div>
      {/if}
    </div>

    {#if isDev}
      <div class="border-t border-black/5 px-4 py-3 dark:border-white/10">
        <button
          onclick={() => void sendTestPush()}
          class="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 dark:bg-white/10"
        >
          {t("pushSettings.sendTest")}
        </button>
      </div>
    {/if}
  {/if}
</section>
