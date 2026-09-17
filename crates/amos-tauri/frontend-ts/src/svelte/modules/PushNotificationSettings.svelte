<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { _ } from "svelte-i18n";
  import {
    getPushStatus,
    setBadgeCount,
    getNotificationHistory,
    clearNotificationHistory,
    simulateReceivePush,
    type RustPushStatus,
    type RustNotificationRecord,
  } from "@/lib/pushNotifications";

  /** 推送状态 */
  let status: RustPushStatus | null = null;

  /** 通知历史 */
  let history: RustNotificationRecord[] = [];

  /** 当前页码 */
  let currentPage = 1;

  /** 每页显示数量 */
  const pageSize = 10;

  /** 加载中状态 */
  let isLoading = true;

  /** 错误消息 */
  let errorMessage = "";

  /** 是否显示开发工具 (仅开发环境) */
  const isDev = import.meta.env.DEV;

  /** 设备令牌复制状态 */
  let tokenCopied = false;

  /** 刷新间隔 ID */
  let refreshInterval: number | null = null;

  /**
   * 加载推送状态
   */
  async function loadPushStatus() {
    try {
      const result = await getPushStatus();
      if (result.kind === "ok") {
        status = result.value;
        errorMessage = "";
      } else {
        errorMessage = result.reason || "Failed to load status";
      }
    } catch (error) {
      console.error("Failed to load push status:", error);
      errorMessage = String(error);
    }
  }

  /**
   * 加载通知历史
   */
  async function loadNotificationHistory() {
    try {
      const result = await getNotificationHistory(100);
      if (result.kind === "ok") {
        history = result.value;
      } else {
        console.error("Failed to load history:", result.reason);
      }
    } catch (error) {
      console.error("Failed to load notification history:", error);
    }
  }

  /**
   * 刷新所有数据
   */
  async function refreshData() {
    isLoading = true;
    await Promise.all([loadPushStatus(), loadNotificationHistory()]);
    isLoading = false;
  }

  /**
   * 复制设备令牌
   */
  async function copyDeviceToken() {
    if (!status?.device_token) return;

    try {
      await navigator.clipboard.writeText(status.device_token);
      tokenCopied = true;
      setTimeout(() => {
        tokenCopied = false;
      }, 2000);
    } catch (error) {
      console.error("Failed to copy token:", error);
    }
  }

  /**
   * 清除全部历史
   */
  async function handleClearAll() {
    if (!confirm($_("pushSettings.confirmClearAll"))) {
      return;
    }

    try {
      const result = await clearNotificationHistory();
      if (result.kind === "ok") {
        history = [];
        currentPage = 1;
      } else {
        alert($_("pushSettings.clearFailed") + ": " + result.reason);
      }
    } catch (error) {
      console.error("Failed to clear history:", error);
      alert($_("pushSettings.clearFailed") + ": " + error);
    }
  }

  /**
   * 发送测试通知 (开发模式)
   */
  async function handleSendTestNotification() {
    try {
      const testPayload = {
        aps: {
          alert: {
            title: "Test Notification",
            body: "This is a test notification from AmOS",
          },
          badge: 1,
          sound: "default",
        },
      };

      const result = await simulateReceivePush(JSON.stringify(testPayload));
      if (result.kind === "ok") {
        await refreshData();
      } else {
        alert("Test failed: " + result.reason);
      }
    } catch (error) {
      console.error("Failed to send test notification:", error);
      alert("Test failed: " + error);
    }
  }

  /**
   * 模拟静默推送 (开发模式)
   */
  async function handleSimulateSilent() {
    try {
      const silentPayload = {
        aps: {
          "content-available": 1,
        },
        custom_data: "silent update",
      };

      const result = await simulateReceivePush(JSON.stringify(silentPayload));
      if (result.kind === "ok") {
        await refreshData();
      } else {
        alert("Silent push failed: " + result.reason);
      }
    } catch (error) {
      console.error("Failed to simulate silent push:", error);
    }
  }

  /**
   * 测试大载荷 (开发模式)
   */
  async function handleTestLargePayload() {
    try {
      const largePayload = {
        aps: {
          alert: {
            title: "Large Notification",
            body: "A".repeat(1000),
          },
          badge: 99,
        },
        custom_data: "B".repeat(2000),
      };

      const result = await simulateReceivePush(JSON.stringify(largePayload));
      if (result.kind === "ok") {
        await refreshData();
      } else {
        alert("Large payload test failed: " + result.reason);
      }
    } catch (error) {
      console.error("Failed to test large payload:", error);
    }
  }

  /**
   * 格式化时间戳
   */
  function formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    // 小于 1 分钟
    if (diff < 60000) {
      return $_("pushSettings.justNow");
    }

    // 小于 1 小时
    if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000);
      return $_("pushSettings.minutesAgo", { values: { count: minutes } });
    }

    // 小于 1 天
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return $_("pushSettings.hoursAgo", { values: { count: hours } });
    }

    // 显示日期
    return date.toLocaleString();
  }

  /**
   * 格式化环境
   */
  function formatEnvironment(env: string): string {
    return env === "production" ? $_("pushSettings.envProduction") : $_("pushSettings.envDevelopment");
  }

  // 分页历史
  $: paginatedHistory = history.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // 总页数
  $: totalPages = Math.ceil(history.length / pageSize);

  // 统计信息
  $: stats = {
    total: history.length,
    withBadge: history.filter((n) => n.has_badge).length,
    withSound: history.filter((n) => n.has_sound).length,
    silent: history.filter((n) => !n.has_badge && !n.has_sound).length,
  };

  // 最后接收时间
  $: lastReceived = history.length > 0 ? formatTimestamp(history[0].received_at) : $_("pushSettings.never");

  // 挂载时加载数据
  onMount(() => {
    refreshData();

    // 每 10 秒刷新一次
    refreshInterval = window.setInterval(() => {
      refreshData();
    }, 10000);
  });

  // 卸载时清理定时器
  onDestroy(() => {
    if (refreshInterval !== null) {
      clearInterval(refreshInterval);
    }
  });
</script>

<div class="push-settings">
  {#if isLoading && !status}
    <!-- 加载中 -->
    <div class="loading-container">
      <div class="loading-spinner"></div>
      <p>{$_("pushSettings.loading")}</p>
    </div>
  {:else if errorMessage}
    <!-- 错误状态 -->
    <div class="error-container">
      <span class="error-icon">⚠️</span>
      <p>{errorMessage}</p>
      <button class="btn btn-secondary" on:click={refreshData}>
        {$_("pushSettings.retry")}
      </button>
    </div>
  {:else if status}
    <!-- 设备令牌区域 -->
    <section class="settings-section">
      <h3 class="section-title">{$_("pushSettings.deviceToken")}</h3>
      <div class="token-card">
        {#if status.device_token}
          <div class="token-content">
            <code class="token-text">{status.device_token}</code>
            <button
              class="btn-icon"
              on:click={copyDeviceToken}
              title={$_("pushSettings.copy")}
              type="button"
            >
              {#if tokenCopied}
                <span class="icon-check">✓</span>
              {:else}
                <span class="icon-copy">📋</span>
              {/if}
            </button>
          </div>
          <div class="token-meta">
            <span class="meta-item">
              {$_("pushSettings.environment")}: <strong>{formatEnvironment(status.environment)}</strong>
            </span>
            <span class="meta-item">
              {$_("pushSettings.registeredAt")}: <strong>{formatTimestamp(status.registered_at)}</strong>
            </span>
          </div>
        {:else}
          <p class="no-token">{$_("pushSettings.noToken")}</p>
        {/if}
      </div>
    </section>

    <!-- 统计信息面板 -->
    <section class="settings-section">
      <h3 class="section-title">{$_("pushSettings.statistics")}</h3>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">{stats.total}</div>
          <div class="stat-label">{$_("pushSettings.totalReceived")}</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{stats.withBadge}</div>
          <div class="stat-label">{$_("pushSettings.withBadge")}</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{stats.withSound}</div>
          <div class="stat-label">{$_("pushSettings.withSound")}</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{stats.silent}</div>
          <div class="stat-label">{$_("pushSettings.silent")}</div>
        </div>
      </div>
      <div class="last-received">
        {$_("pushSettings.lastReceived")}: <strong>{lastReceived}</strong>
      </div>
    </section>

    <!-- 通知历史 -->
    <section class="settings-section">
      <div class="section-header">
        <h3 class="section-title">{$_("pushSettings.history")}</h3>
        {#if history.length > 0}
          <button class="btn btn-danger-text" on:click={handleClearAll} type="button">
            {$_("pushSettings.clearAll")}
          </button>
        {/if}
      </div>

      {#if history.length === 0}
        <div class="empty-state">
          <span class="empty-icon">📭</span>
          <p>{$_("pushSettings.noHistory")}</p>
        </div>
      {:else}
        <div class="history-list">
          {#each paginatedHistory as notification (notification.id)}
            <div class="history-item">
              <div class="history-header">
                <span class="history-title">{notification.title || $_("pushSettings.noTitle")}</span>
                <span class="history-time">{formatTimestamp(notification.received_at)}</span>
              </div>
              {#if notification.body}
                <p class="history-body">{notification.body}</p>
              {/if}
              <div class="history-badges">
                {#if notification.has_badge}
                  <span class="badge badge-blue">
                    🔵 {$_("pushSettings.badge")}: {notification.badge_count}
                  </span>
                {/if}
                {#if notification.has_sound}
                  <span class="badge badge-green">🔔 {$_("pushSettings.sound")}</span>
                {/if}
                {#if !notification.has_badge && !notification.has_sound}
                  <span class="badge badge-gray">🔇 {$_("pushSettings.silent")}</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>

        {#if totalPages > 1}
          <div class="pagination">
            <button
              class="btn btn-sm"
              disabled={currentPage === 1}
              on:click={() => (currentPage = Math.max(1, currentPage - 1))}
              type="button"
            >
              ←
            </button>
            <span class="pagination-info">
              {$_("pushSettings.page", { values: { current: currentPage, total: totalPages } })}
            </span>
            <button
              class="btn btn-sm"
              disabled={currentPage === totalPages}
              on:click={() => (currentPage = Math.min(totalPages, currentPage + 1))}
              type="button"
            >
              →
            </button>
          </div>
        {/if}
      {/if}
    </section>

    <!-- 开发工具 -->
    {#if isDev}
      <section class="settings-section dev-tools">
        <h3 class="section-title">
          {$_("pushSettings.devTools")} <span class="dev-badge">DEV</span>
        </h3>
        <div class="dev-actions">
          <button class="btn btn-secondary" on:click={handleSendTestNotification} type="button">
            {$_("pushSettings.sendTest")}
          </button>
          <button class="btn btn-secondary" on:click={handleSimulateSilent} type="button">
            {$_("pushSettings.simulateSilent")}
          </button>
          <button class="btn btn-secondary" on:click={handleTestLargePayload} type="button">
            {$_("pushSettings.testLarge")}
          </button>
        </div>
      </section>
    {/if}
  {/if}
</div>

<style>
  .push-settings {
    max-width: 900px;
    margin: 0 auto;
    padding: 20px;
  }

  /* 加载状态 */
  .loading-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px 20px;
    gap: 16px;
  }

  .loading-spinner {
    width: 48px;
    height: 48px;
    border: 4px solid rgba(0, 122, 255, 0.2);
    border-top-color: #007aff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .loading-container p {
    color: var(--text-secondary, #666666);
    font-size: 14px;
  }

  /* 错误状态 */
  .error-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 40px 20px;
    background: rgba(255, 59, 48, 0.1);
    border: 1px solid rgba(255, 59, 48, 0.3);
    border-radius: 12px;
  }

  .error-icon {
    font-size: 32px;
  }

  .error-container p {
    color: #ff3b30;
    font-size: 14px;
    margin: 0;
  }

  /* 区域 */
  .settings-section {
    background: var(--bg-secondary, rgba(255, 255, 255, 0.8));
    border: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
  }

  @media (prefers-color-scheme: dark) {
    .settings-section {
      background: var(--bg-secondary, rgba(28, 28, 30, 0.8));
      border-color: var(--border-color, rgba(255, 255, 255, 0.1));
    }
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .section-title {
    font-size: 18px;
    font-weight: 600;
    margin: 0 0 16px 0;
    color: var(--text-primary, #000000);
  }

  @media (prefers-color-scheme: dark) {
    .section-title {
      color: var(--text-primary, #ffffff);
    }
  }

  /* 设备令牌卡片 */
  .token-card {
    background: var(--bg-primary, #ffffff);
    border: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
    border-radius: 8px;
    padding: 16px;
  }

  @media (prefers-color-scheme: dark) {
    .token-card {
      background: var(--bg-primary, #1c1c1e);
      border-color: var(--border-color, rgba(255, 255, 255, 0.1));
    }
  }

  .token-content {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  .token-text {
    flex: 1;
    font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
    font-size: 12px;
    color: var(--text-primary, #000000);
    background: var(--bg-secondary, rgba(0, 0, 0, 0.05));
    padding: 8px 12px;
    border-radius: 6px;
    word-break: break-all;
  }

  @media (prefers-color-scheme: dark) {
    .token-text {
      color: var(--text-primary, #ffffff);
      background: var(--bg-secondary, rgba(255, 255, 255, 0.05));
    }
  }

  .btn-icon {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 8px;
    border-radius: 6px;
    transition: background 0.2s ease;
  }

  .btn-icon:hover {
    background: var(--bg-secondary, rgba(0, 0, 0, 0.05));
  }

  @media (prefers-color-scheme: dark) {
    .btn-icon:hover {
      background: var(--bg-secondary, rgba(255, 255, 255, 0.05));
    }
  }

  .icon-copy,
  .icon-check {
    font-size: 18px;
  }

  .icon-check {
    color: #34c759;
  }

  .token-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    font-size: 13px;
    color: var(--text-secondary, #666666);
  }

  @media (prefers-color-scheme: dark) {
    .token-meta {
      color: var(--text-secondary, #8e8e93);
    }
  }

  .meta-item strong {
    color: var(--text-primary, #000000);
  }

  @media (prefers-color-scheme: dark) {
    .meta-item strong {
      color: var(--text-primary, #ffffff);
    }
  }

  .no-token {
    color: var(--text-secondary, #666666);
    font-size: 14px;
    margin: 0;
  }

  /* 统计卡片 */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }

  .stat-card {
    background: var(--bg-primary, #ffffff);
    border: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
    border-radius: 8px;
    padding: 16px;
    text-align: center;
  }

  @media (prefers-color-scheme: dark) {
    .stat-card {
      background: var(--bg-primary, #1c1c1e);
      border-color: var(--border-color, rgba(255, 255, 255, 0.1));
    }
  }

  .stat-value {
    font-size: 28px;
    font-weight: 600;
    color: #007aff;
    margin-bottom: 4px;
  }

  .stat-label {
    font-size: 12px;
    color: var(--text-secondary, #666666);
  }

  @media (prefers-color-scheme: dark) {
    .stat-label {
      color: var(--text-secondary, #8e8e93);
    }
  }

  .last-received {
    font-size: 14px;
    color: var(--text-secondary, #666666);
    text-align: center;
  }

  @media (prefers-color-scheme: dark) {
    .last-received {
      color: var(--text-secondary, #8e8e93);
    }
  }

  .last-received strong {
    color: var(--text-primary, #000000);
  }

  @media (prefers-color-scheme: dark) {
    .last-received strong {
      color: var(--text-primary, #ffffff);
    }
  }

  /* 历史列表 */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 40px 20px;
    gap: 12px;
  }

  .empty-icon {
    font-size: 48px;
  }

  .empty-state p {
    color: var(--text-secondary, #666666);
    font-size: 14px;
    margin: 0;
  }

  .history-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .history-item {
    background: var(--bg-primary, #ffffff);
    border: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
    border-radius: 8px;
    padding: 12px;
  }

  @media (prefers-color-scheme: dark) {
    .history-item {
      background: var(--bg-primary, #1c1c1e);
      border-color: var(--border-color, rgba(255, 255, 255, 0.1));
    }
  }

  .history-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .history-title {
    font-weight: 600;
    font-size: 14px;
    color: var(--text-primary, #000000);
  }

  @media (prefers-color-scheme: dark) {
    .history-title {
      color: var(--text-primary, #ffffff);
    }
  }

  .history-time {
    font-size: 12px;
    color: var(--text-secondary, #666666);
  }

  @media (prefers-color-scheme: dark) {
    .history-time {
      color: var(--text-secondary, #8e8e93);
    }
  }

  .history-body {
    font-size: 13px;
    color: var(--text-secondary, #666666);
    margin: 0 0 8px 0;
    line-height: 1.5;
  }

  @media (prefers-color-scheme: dark) {
    .history-body {
      color: var(--text-secondary, #8e8e93);
    }
  }

  .history-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
  }

  .badge-blue {
    background: rgba(0, 122, 255, 0.1);
    color: #007aff;
  }

  .badge-green {
    background: rgba(52, 199, 89, 0.1);
    color: #34c759;
  }

  .badge-gray {
    background: rgba(142, 142, 147, 0.1);
    color: #8e8e93;
  }

  /* 分页 */
  .pagination {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
  }

  .pagination-info {
    font-size: 13px;
    color: var(--text-secondary, #666666);
  }

  @media (prefers-color-scheme: dark) {
    .pagination-info {
      color: var(--text-secondary, #8e8e93);
    }
  }

  /* 开发工具 */
  .dev-tools {
    border: 2px dashed #ff9500;
    background: rgba(255, 149, 0, 0.05);
  }

  .dev-badge {
    display: inline-block;
    background: #ff9500;
    color: white;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
    margin-left: 8px;
  }

  .dev-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  /* 按钮 */
  .btn {
    padding: 8px 16px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    outline: none;
  }

  .btn:focus-visible {
    outline: 2px solid #007aff;
    outline-offset: 2px;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: rgba(142, 142, 147, 0.1);
    color: var(--text-primary, #000000);
  }

  @media (prefers-color-scheme: dark) {
    .btn-secondary {
      background: rgba(142, 142, 147, 0.2);
      color: var(--text-primary, #ffffff);
    }
  }

  .btn-secondary:hover:not(:disabled) {
    background: rgba(142, 142, 147, 0.2);
  }

  .btn-danger-text {
    background: transparent;
    color: #ff3b30;
    padding: 8px 12px;
    border: none;
    font-size: 14px;
    cursor: pointer;
  }

  .btn-danger-text:hover {
    background: rgba(255, 59, 48, 0.1);
    border-radius: 6px;
  }

  .btn-sm {
    padding: 6px 12px;
    font-size: 13px;
  }

  /* 动画 */
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  /* 响应式 */
  @media (max-width: 640px) {
    .push-settings {
      padding: 12px;
    }

    .settings-section {
      padding: 16px;
    }

    .stats-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .token-text {
      font-size: 11px;
    }
  }
</style>
