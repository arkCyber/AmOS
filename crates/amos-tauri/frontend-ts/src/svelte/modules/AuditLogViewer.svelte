<script lang="ts">
  /**
   * AuditLogViewer.svelte — 审计日志查看器
   * 
   * 功能:
   * - 查看审计日志列表
   * - 按时间、用户、事件类型、结果筛选
   * - 查看日志详情
   * - 导出日志（JSON/CSV）
   * - 查看统计图表
   */

  import { auditLogger } from "../../lib/enterprise";
  import { t } from "../locale.svelte";
  import { attachFocusTrap } from "../../lib/focusTrap";
  import { installMenuKeyboard } from "../../lib/menuKeys";
  import type { AuditLog, AuditLogQuery, AuditLogLevel, AuditResult, AuditEventType } from "../../lib/enterprise/audit";
  import VirtualList from "../components/VirtualList.svelte";

  // ============================================================================
  // 状态管理
  // ============================================================================

  let logs = $state<AuditLog[]>([]);
  let query = $state<AuditLogQuery>({
    startTime: Date.now() - 86400000, // 最近 24 小时
  });
  let selectedLog = $state<AuditLog | null>(null);
  let showDetailModal = $state(false);
  /** 模态根元素（焦点陷阱 + Escape 关闭）；`$effect` 在它出现时挂上。 */
  let modalEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!showDetailModal || !modalEl) return;
    return attachFocusTrap(modalEl, closeDetailModal);
  });
  let exporting = $state(false);
  /** 导出菜单是否展开（点击/回车是显式路径；hover 只是指针设备上的顺带）。 */
  let exportMenuOpen = $state(false);
  /** 展开的下拉菜单元素，交给 REQ-A436 的共享键盘层（方向键 / Home / End / Escape）。 */
  let exportMenuEl = $state<HTMLDivElement | undefined>();
  $effect(() => {
    if (!exportMenuEl || !exportMenuOpen) return;
    return installMenuKeyboard(exportMenuEl, { onClose: () => (exportMenuOpen = false) });
  });
  let loading = $state(false);
  let autoRefresh = $state(false);
  let refreshInterval: number | null = null;

  // 筛选器状态
  let timeRange = $state("24h");
  let userFilter = $state<string>("");
  let eventTypeFilter = $state<AuditEventType | "">("");
  let resultFilter = $state<AuditResult | "">("");
  let levelFilter = $state<AuditLogLevel | "">("");

  // ============================================================================
  // 计算属性
  // ============================================================================

  const stats = $derived(
    auditLogger.getStatistics(query.startTime, query.endTime)
  );

  const uniqueUsers = $derived(
    Array.from(new Set(logs.map(log => log.userId))).sort()
  );

  const uniqueEventTypes = $derived(
    Array.from(new Set(logs.map(log => log.eventType))).sort()
  );

  // ============================================================================
  // 生命周期
  // ============================================================================

  $effect(() => {
    loadLogs();
  });

  $effect(() => {
    if (autoRefresh) {
      refreshInterval = setInterval(loadLogs, 5000) as unknown as number;
    } else if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
    return () => {
      if (refreshInterval) clearInterval(refreshInterval);
    };
  });

  // ============================================================================
  // 辅助函数
  // ============================================================================

  function loadLogs() {
    loading = true;
    try {
      logs = auditLogger.query(query);
    } finally {
      loading = false;
    }
  }

  function updateTimeRange(range: string) {
    timeRange = range;
    const now = Date.now();
    
    switch (range) {
      case "1h":
        query = { ...query, startTime: now - 3600000, endTime: undefined };
        break;
      case "24h":
        query = { ...query, startTime: now - 86400000, endTime: undefined };
        break;
      case "7d":
        query = { ...query, startTime: now - 604800000, endTime: undefined };
        break;
      case "30d":
        query = { ...query, startTime: now - 2592000000, endTime: undefined };
        break;
      case "all":
        query = { ...query, startTime: 0, endTime: undefined };
        break;
    }
  }

  function applyFilters() {
    query = {
      ...query,
      userId: userFilter || undefined,
      eventTypes: eventTypeFilter ? [eventTypeFilter as AuditEventType] : undefined,
      results: resultFilter ? [resultFilter] : undefined,
      levels: levelFilter ? [levelFilter] : undefined,
    };
  }

  function resetFilters() {
    timeRange = "24h";
    userFilter = "";
    eventTypeFilter = "";
    resultFilter = "";
    levelFilter = "";
    updateTimeRange("24h");
    query = { startTime: Date.now() - 86400000 };
  }

  async function exportLogs(format: "json" | "csv") {
    exporting = true;
    try {
      const data = await auditLogger.exportLogs(query, format);
      downloadFile(`audit-logs-${Date.now()}.${format}`, data);
    } catch (error) {
      alert(
        t("audit.exportFailed", {
          reason: error instanceof Error ? error.message : t("audit.unknownError"),
        }),
      );
    } finally {
      exporting = false;
    }
  }

  function downloadFile(filename: string, data: string) {
    const blob = new Blob([data], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function openLogDetail(log: AuditLog) {
    selectedLog = log;
    showDetailModal = true;
  }

  function closeDetailModal() {
    showDetailModal = false;
    selectedLog = null;
  }

  function formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function getResultIcon(result: AuditResult): string {
    const icons = {
      success: "✓",
      failure: "✗",
      warning: "⚠",
      blocked: "🚫",
    };
    return icons[result];
  }

  function getResultColor(result: AuditResult): string {
    const colors = {
      success: "#34C759",
      failure: "#FF3B30",
      warning: "#FF9500",
      blocked: "#8E8E93",
    };
    return colors[result];
  }

  function getLevelColor(level: AuditLogLevel): string {
    const colors: Record<string, string> = {
      debug: "#8E8E93",
      info: "#007AFF",
      warning: "#FF9500",
      error: "#FF3B30",
      critical: "#FF3B30",
    };
    return colors[level] || "#8E8E93";
  }

  function getEventTypeLabel(eventType: string): string {
    // 标签走词典（`audit.event.<id>`，动态前缀 ⇒ 扫描器知道这批键在用）。
    // 词典里没有时**回落成原始 id** —— 与 `getLevelColor` 的回落同一规则：
    // 显示设备/后端真实给的值，而不是给它编一个本地化名字。
    const key = `audit.event.${eventType}`;
    const label = t(key);
    return label === key ? eventType : label;
  }
</script>

<div class="audit-log-viewer">
  <header class="viewer-header">
    <h2>📊 {t("audit.title")}</h2>
    <p class="subtitle">{t("audit.subtitle")}</p>
  </header>

  <!-- 筛选器 -->
  <section class="filters-card">
    <h3 class="section-title">{t("audit.filtersSection")}</h3>
    
    <div class="filter-grid">
      <div class="filter-item">
        <label class="filter-label" for="filter-time-range">{t("audit.timeRange")}</label>
        <select
          id="filter-time-range"
          class="filter-select"
          value={timeRange}
          onchange={(e) => updateTimeRange((e.target as HTMLSelectElement).value)}
        >
          <option value="1h">{t("audit.last1h")}</option>
          <option value="24h">{t("audit.last24h")}</option>
          <option value="7d">{t("audit.last7d")}</option>
          <option value="30d">{t("audit.last30d")}</option>
          <option value="all">{t("audit.all")}</option>
        </select>
      </div>

      <div class="filter-item">
        <label class="filter-label" for="filter-user">{t("audit.user")}</label>
        <select
          id="filter-user"
          class="filter-select"
          bind:value={userFilter}
          onchange={applyFilters}
        >
          <option value="">{t("audit.allUsers")}</option>
          {#each uniqueUsers as user}
            <option value={user}>{user}</option>
          {/each}
        </select>
      </div>

      <div class="filter-item">
        <label class="filter-label" for="filter-event-type">{t("audit.eventType")}</label>
        <select
          id="filter-event-type"
          class="filter-select"
          bind:value={eventTypeFilter}
          onchange={applyFilters}
        >
          <option value="">{t("audit.allEvents")}</option>
          {#each uniqueEventTypes as eventType}
            <option value={eventType}>{getEventTypeLabel(eventType)}</option>
          {/each}
        </select>
      </div>

      <div class="filter-item">
        <label class="filter-label" for="filter-result">{t("audit.result")}</label>
        <select
          id="filter-result"
          class="filter-select"
          bind:value={resultFilter}
          onchange={applyFilters}
        >
          <option value="">{t("audit.all")}</option>
          <option value="success">{t("audit.success")}</option>
          <option value="failure">{t("audit.failure")}</option>
          <option value="warning">{t("audit.warning")}</option>
          <option value="blocked">{t("audit.blocked")}</option>
        </select>
      </div>

      <div class="filter-item">
        <label class="filter-label" for="filter-level">{t("audit.level")}</label>
        <select
          id="filter-level"
          class="filter-select"
          bind:value={levelFilter}
          onchange={applyFilters}
        >
          <option value="">{t("audit.allLevels")}</option>
          <option value="DEBUG">DEBUG</option>
          <option value="INFO">INFO</option>
          <option value="WARNING">WARNING</option>
          <option value="ERROR">ERROR</option>
        </select>
      </div>
    </div>

    <div class="filter-actions">
      <button class="btn-secondary" onclick={resetFilters}>
        {t("audit.resetFilters")}
      </button>
      <label class="auto-refresh-toggle">
        <input
          type="checkbox"
          bind:checked={autoRefresh}
        />
        <span>{t("audit.autoRefresh")}</span>
      </label>
      <div class="export-dropdown">
        <!-- 指针契约（REQ-A385）：菜单不能**只**靠 hover 展开 —— 触屏没有 hover，
             那样在手机上永远打不开。点击/回车是显式路径，hover 只是指针设备上的顺带。
             按钮本身是 `<button>` ⇒ 键盘天然可达（Enter/Space 触发 onclick）。 -->
        <button
          class="btn-secondary"
          disabled={exporting}
          onclick={() => (exportMenuOpen = !exportMenuOpen)}
          aria-haspopup="menu"
          aria-expanded={exportMenuOpen}
        >
          {exporting ? t("audit.exporting") : t("audit.export")}
        </button>
        <div class="dropdown-menu" class:open={exportMenuOpen} bind:this={exportMenuEl} role="menu">
          <button
            role="menuitem"
            onclick={() => {
              exportMenuOpen = false;
              void exportLogs("json");
            }}>{t("audit.exportJson")}</button
          >
          <button
            role="menuitem"
            onclick={() => {
              exportMenuOpen = false;
              void exportLogs("csv");
            }}>{t("audit.exportCsv")}</button
          >
        </div>
      </div>
    </div>
  </section>

  <!-- 统计概览 -->
  <section class="stats-card">
    <h3 class="section-title">{t("audit.statsSection")}</h3>
    <div class="stats-grid">
      <div class="stat-item">
        <div class="stat-value">{stats.totalLogs}</div>
        <div class="stat-label">{t("audit.statTotal")}</div>
      </div>
      <div class="stat-item success">
        <div class="stat-value">{stats.successCount}</div>
        <div class="stat-label">{t("audit.statSuccess")}</div>
      </div>
      <div class="stat-item failure">
        <div class="stat-value">{stats.failureCount}</div>
        <div class="stat-label">{t("audit.statFailure")}</div>
      </div>
      <div class="stat-item warning">
        <div class="stat-value">{stats.warningCount}</div>
        <div class="stat-label">{t("audit.statWarning")}</div>
      </div>
      <div class="stat-item blocked">
        <div class="stat-value">{stats.blockedCount}</div>
        <div class="stat-label">{t("audit.statBlocked")}</div>
      </div>
    </div>
  </section>

  <!-- 日志列表 -->
  <section class="logs-card">
    <div class="logs-header">
      <h3 class="section-title">{t("audit.listTitle", { count: logs.length })}</h3>
      {#if loading}
        <!-- 刷新指示本身是"正在发生什么"的读数 ⇒ 播报它（polite）；
             而它下面那个**每 5 秒自动刷新**的日志列表**不**做成 live region ——
             那会把整张表念一遍又一遍。 -->
        <span class="loading-indicator" role="status">{t("audit.refreshing")}</span>
      {/if}
    </div>

    <div class="logs-list">
      {#if logs.length === 0}
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <p class="empty-title">{t("audit.emptyTitle")}</p>
          <p class="empty-text">{t("audit.emptyHint")}</p>
        </div>
      {:else}
        <VirtualList
          items={logs}
          itemHeight={120}
          containerHeight={600}
          buffer={3}
        >
          {#snippet renderItem(log: AuditLog)}
            <button
              class="log-item"
              onclick={() => openLogDetail(log)}
              style="border-left: 4px solid {getResultColor(log.result)}"
            >
              <div class="log-header-row">
                <span class="log-result-icon" style="color: {getResultColor(log.result)}">
                  {getResultIcon(log.result)}
                </span>
                <span class="log-timestamp">{formatTimestamp(log.timestamp)}</span>
                <span class="log-level" style="color: {getLevelColor(log.level)}">
                  {log.level}
                </span>
              </div>
              
              <div class="log-info-row">
                <span class="log-user">👤 {log.userId}</span>
                <span class="log-event">{getEventTypeLabel(log.eventType)}</span>
              </div>
              
              <div class="log-description">{log.eventDescription}</div>
              
              {#if log.errorMessage}
                <div class="log-error">{t("audit.errorLine", { message: log.errorMessage ?? "" })}</div>
              {/if}
              
              {#if log.duration}
                <div class="log-duration">⏱️ {log.duration} ms</div>
              {/if}
            </button>
          {/snippet}
        </VirtualList>
      {/if}
    </div>
  </section>
</div>

<!-- 日志详情模态框 -->
{#if showDetailModal && selectedLog}
  <!-- 遮罩 = 内容后面的一枚真按钮；Escape + 焦点陷阱走 `attachFocusTrap`（REQ-A386）。 -->
  <div class="modal-overlay">
    <button
      class="modal-backdrop"
      aria-label={t("audit.closeModal")}
      onclick={closeDetailModal}
    ></button>
    <div
      class="modal-content"
      bind:this={modalEl}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      tabindex="-1"
    >
      <header class="modal-header">
        <h3 id="modal-title" class="modal-title">{t("audit.detailTitle")}</h3>
        <button class="close-btn" onclick={closeDetailModal} aria-label={t("audit.close")}>×</button>
      </header>

      <div class="modal-body">
        <!-- 基本信息 -->
        <section class="detail-section">
          <h4 class="detail-title">{t("audit.basicInfo")}</h4>
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">ID:</span>
              <span class="detail-value">{selectedLog.id}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">{t("audit.time")}</span>
              <span class="detail-value">{formatTimestamp(selectedLog.timestamp)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">{t("audit.levelLabel")}</span>
              <span class="detail-value" style="color: {getLevelColor(selectedLog.level)}">
                {selectedLog.level}
              </span>
            </div>
            <div class="detail-item">
              <span class="detail-label">{t("audit.resultLabel")}</span>
              <span class="detail-value" style="color: {getResultColor(selectedLog.result)}">
                {getResultIcon(selectedLog.result)} {selectedLog.result}
              </span>
            </div>
            <div class="detail-item">
              <span class="detail-label">{t("audit.eventLabel")}</span>
              <span class="detail-value">{getEventTypeLabel(selectedLog.eventType)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">{t("audit.categoryLabel")}</span>
              <span class="detail-value">{selectedLog.eventCategory}</span>
            </div>
          </div>
        </section>

        <!-- 用户信息 -->
        <section class="detail-section">
          <h4 class="detail-title">{t("audit.userInfo")}</h4>
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">{t("audit.userId")}</span>
              <span class="detail-value">{selectedLog.userId}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">{t("audit.userName")}</span>
              <span class="detail-value">{selectedLog.userName}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">{t("audit.email")}</span>
              <span class="detail-value">{selectedLog.userEmail}</span>
            </div>
            {#if selectedLog.metadata?.ipAddress}
              <div class="detail-item">
                <span class="detail-label">{t("audit.ipAddress")}</span>
                <span class="detail-value">{selectedLog.metadata.ipAddress}</span>
              </div>
            {/if}
          </div>
        </section>

        <!-- 资源信息 -->
        {#if selectedLog.resourceId}
          <section class="detail-section">
            <h4 class="detail-title">{t("audit.resourceInfo")}</h4>
            <div class="detail-grid">
              <div class="detail-item">
                <span class="detail-label">{t("audit.resourceId")}</span>
                <span class="detail-value">{selectedLog.resourceId}</span>
              </div>
              {#if selectedLog.resourceType}
                <div class="detail-item">
                  <span class="detail-label">{t("audit.resourceType")}</span>
                  <span class="detail-value">{selectedLog.resourceType}</span>
                </div>
              {/if}
              {#if selectedLog.resourceName}
                <div class="detail-item">
                  <span class="detail-label">{t("audit.resourceName")}</span>
                  <span class="detail-value">{selectedLog.resourceName}</span>
                </div>
              {/if}
            </div>
          </section>
        {/if}

        <!-- 执行结果 -->
        <section class="detail-section">
          <h4 class="detail-title">{t("audit.execResult")}</h4>
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">{t("audit.resultLabel")}</span>
              <span class="detail-value" style="color: {getResultColor(selectedLog.result)}">
                {getResultIcon(selectedLog.result)} {selectedLog.result}
              </span>
            </div>
            {#if selectedLog.duration}
              <div class="detail-item">
                <span class="detail-label">{t("audit.duration")}</span>
                <span class="detail-value">{selectedLog.duration} ms</span>
              </div>
            {/if}
            <div class="detail-item full-width">
              <span class="detail-label">{t("audit.description")}</span>
              <span class="detail-value">{selectedLog.eventDescription}</span>
            </div>
            {#if selectedLog.errorMessage}
              <div class="detail-item full-width error">
                <span class="detail-label">{t("audit.errorLabel")}</span>
                <span class="detail-value">{selectedLog.errorMessage}</span>
              </div>
            {/if}
          </div>
        </section>

        <!-- 元数据 -->
        {#if selectedLog.metadata && Object.keys(selectedLog.metadata).length > 0}
          <section class="detail-section">
            <h4 class="detail-title">{t("audit.metadata")}</h4>
            <pre class="metadata-pre">{JSON.stringify(selectedLog.metadata, null, 2)}</pre>
          </section>
        {/if}
      </div>

      <footer class="modal-footer">
        <button class="btn-primary" onclick={closeDetailModal}>
          {t("audit.close")}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .audit-log-viewer {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px;
  }

  .viewer-header {
    margin-bottom: 24px;
  }

  .viewer-header h2 {
    font-size: 24px;
    font-weight: 600;
    color: #000;
    margin: 0 0 8px 0;
  }

  .subtitle {
    font-size: 14px;
    color: #8E8E93;
    margin: 0;
  }

  /* 卡片 */
  .filters-card,
  .stats-card,
  .logs-card {
    background: #fff;
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .section-title {
    font-size: 17px;
    font-weight: 600;
    color: #000;
    margin: 0 0 16px 0;
  }

  /* 筛选器 */
  .filter-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 16px;
  }

  .filter-item {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .filter-label {
    font-size: 13px;
    font-weight: 500;
    color: #3C3C43;
  }

  .filter-select {
    padding: 10px 12px;
    border: 1px solid #E5E5EA;
    border-radius: 8px;
    font-size: 14px;
    background: #fff;
    cursor: pointer;
  }

  .filter-select:focus {
    outline: none;
    border-color: #007AFF;
  }

  .filter-actions {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }

  .auto-refresh-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    color: #3C3C43;
    cursor: pointer;
  }

  .auto-refresh-toggle input {
    width: 18px;
    height: 18px;
    cursor: pointer;
  }

  .export-dropdown {
    position: relative;
    margin-left: auto;
  }

  /* 指针契约（REQ-A385）：`.open` 是显式路径（点击/回车），下面那条 hover 只是
     指针设备上的顺带 —— 所以它必须被关在 `@media (hover: hover)` 里。 */
  .dropdown-menu.open {
    display: block;
  }

  @media (hover: hover) {
  .export-dropdown:hover .dropdown-menu {
    display: block;
  }
  }

  .dropdown-menu {
    display: none;
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    overflow: hidden;
    z-index: 10;
  }

  .dropdown-menu button {
    display: block;
    width: 100%;
    padding: 12px 16px;
    border: none;
    background: #fff;
    text-align: left;
    font-size: 14px;
    cursor: pointer;
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .dropdown-menu button:hover {
    background: #F2F2F7;
  }
  }

  /* 统计 */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 16px;
  }

  .stat-item {
    text-align: center;
    padding: 16px;
    border-radius: 8px;
    background: #F2F2F7;
  }

  .stat-item.success {
    background: #E5F7ED;
  }

  .stat-item.failure {
    background: #FFE5E5;
  }

  .stat-item.warning {
    background: #FFF4E5;
  }

  .stat-item.blocked {
    background: #F2F2F7;
  }

  .stat-value {
    font-size: 28px;
    font-weight: 700;
    color: #000;
    margin-bottom: 4px;
  }

  .stat-label {
    font-size: 13px;
    color: #8E8E93;
  }

  /* 日志列表 */
  .logs-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .loading-indicator {
    font-size: 13px;
    color: #007AFF;
  }

  .logs-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 600px;
    overflow-y: auto;
  }

  .log-item {
    background: #F2F2F7;
    border-radius: 8px;
    padding: 16px;
    text-align: left;
    cursor: pointer;
    transition: all 0.2s;
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .log-item:hover {
    background: #E5E5EA;
    transform: translateX(4px);
  }
  }

  .log-header-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
    font-size: 13px;
  }

  .log-result-icon {
    font-size: 18px;
    font-weight: 700;
  }

  .log-timestamp {
    color: #8E8E93;
  }

  .log-level {
    margin-left: auto;
    font-weight: 600;
  }

  .log-info-row {
    display: flex;
    gap: 16px;
    margin-bottom: 8px;
    font-size: 14px;
  }

  .log-user {
    color: #3C3C43;
  }

  .log-event {
    color: #007AFF;
    font-weight: 500;
  }

  .log-description {
    font-size: 14px;
    color: #000;
    margin-bottom: 4px;
  }

  .log-error {
    font-size: 13px;
    color: #FF3B30;
    background: #FFE5E5;
    padding: 8px;
    border-radius: 4px;
    margin-top: 8px;
  }

  .log-duration {
    font-size: 12px;
    color: #8E8E93;
    margin-top: 4px;
  }

  /* 空状态 */
  .empty-state {
    text-align: center;
    padding: 60px 20px;
  }

  .empty-icon {
    font-size: 64px;
    margin-bottom: 16px;
  }

  .empty-title {
    font-size: 20px;
    font-weight: 600;
    color: #000;
    margin: 0 0 8px 0;
  }

  .empty-text {
    font-size: 15px;
    color: #8E8E93;
    margin: 0;
  }

  /* 模态框 */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
  }

  /* 遮罩层：铺满的真按钮（背景在它身上，不在 overlay 上）。 */
  .modal-backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    cursor: pointer;
    background: rgba(0, 0, 0, 0.5);
  }

  .modal-content {
    position: relative; /* 盖在遮罩之上 */
    background: #fff;
    border-radius: 16px;
    max-width: 700px;
    width: 100%;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px;
    border-bottom: 1px solid #E5E5EA;
  }

  .modal-title {
    font-size: 20px;
    font-weight: 600;
    color: #000;
    margin: 0;
  }

  .close-btn {
    width: 32px;
    height: 32px;
    border: none;
    background: #F2F2F7;
    color: #3C3C43;
    border-radius: 50%;
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .close-btn:hover {
    background: #E5E5EA;
  }
  }

  .modal-body {
    padding: 20px;
    overflow-y: auto;
    flex: 1;
  }

  .detail-section {
    margin-bottom: 24px;
  }

  .detail-section:last-child {
    margin-bottom: 0;
  }

  .detail-title {
    font-size: 15px;
    font-weight: 600;
    color: #000;
    margin: 0 0 12px 0;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }

  .detail-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .detail-item.full-width {
    grid-column: 1 / -1;
  }

  .detail-item.error {
    background: #FFE5E5;
    padding: 12px;
    border-radius: 8px;
  }

  .detail-label {
    font-size: 12px;
    color: #8E8E93;
    font-weight: 500;
  }

  .detail-value {
    font-size: 14px;
    color: #000;
    word-break: break-all;
  }

  .metadata-pre {
    background: #F2F2F7;
    padding: 12px;
    border-radius: 8px;
    font-size: 12px;
    font-family: "SF Mono", Monaco, monospace;
    overflow-x: auto;
    margin: 0;
  }

  .modal-footer {
    padding: 20px;
    border-top: 1px solid #E5E5EA;
  }

  .btn-primary,
  .btn-secondary {
    padding: 12px 24px;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.2s;
  }

  .btn-primary {
    background: #007AFF;
    color: white;
    width: 100%;
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .btn-primary:hover {
    opacity: 0.8;
  }
  }

  .btn-secondary {
    background: #F2F2F7;
    color: #007AFF;
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .btn-secondary:hover {
    background: #E5E5EA;
  }
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* 响应式 */
  @media (max-width: 768px) {
    .audit-log-viewer {
      padding: 16px;
    }

    .filter-grid {
      grid-template-columns: 1fr;
    }

    .stats-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .detail-grid {
      grid-template-columns: 1fr;
    }

    .filter-actions {
      flex-direction: column;
      align-items: stretch;
    }

    .export-dropdown {
      margin-left: 0;
    }
  }
</style>
