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
  import type { AuditLog, AuditLogQuery, AuditLogLevel, AuditResult, AuditEventType } from "../../lib/enterprise/audit";

  // ============================================================================
  // 状态管理
  // ============================================================================

  let logs = $state<AuditLog[]>([]);
  let query = $state<AuditLogQuery>({
    startTime: Date.now() - 86400000, // 最近 24 小时
  });
  let selectedLog = $state<AuditLog | null>(null);
  let showDetailModal = $state(false);
  let exporting = $state(false);
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
      alert(`导出失败: ${error instanceof Error ? error.message : "未知错误"}`);
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
    const labels: Record<string, string> = {
      shortcut_create: "创建快捷指令",
      shortcut_run: "执行快捷指令",
      shortcut_update: "更新快捷指令",
      shortcut_delete: "删除快捷指令",
      shortcut_share: "分享快捷指令",
      shortcut_import: "导入快捷指令",
      shortcut_export: "导出快捷指令",
      template_install: "安装模板",
      template_uninstall: "卸载模板",
      mdm_policy_change: "MDM 策略变更",
      api_call: "API 调用",
      webhook_trigger: "Webhook 触发",
      user_login: "用户登录",
      user_logout: "用户登出",
    };
    return labels[eventType] || eventType;
  }
</script>

<div class="audit-log-viewer">
  <header class="viewer-header">
    <h2>📊 审计日志</h2>
    <p class="subtitle">查看和分析系统操作审计记录</p>
  </header>

  <!-- 筛选器 -->
  <section class="filters-card">
    <h3 class="section-title">筛选器</h3>
    
    <div class="filter-grid">
      <div class="filter-item">
        <label class="filter-label" for="filter-time-range">时间范围</label>
        <select
          id="filter-time-range"
          class="filter-select"
          value={timeRange}
          onchange={(e) => updateTimeRange((e.target as HTMLSelectElement).value)}
        >
          <option value="1h">最近 1 小时</option>
          <option value="24h">最近 24 小时</option>
          <option value="7d">最近 7 天</option>
          <option value="30d">最近 30 天</option>
          <option value="all">全部</option>
        </select>
      </div>

      <div class="filter-item">
        <label class="filter-label" for="filter-user">用户</label>
        <select
          id="filter-user"
          class="filter-select"
          bind:value={userFilter}
          onchange={applyFilters}
        >
          <option value="">全部用户</option>
          {#each uniqueUsers as user}
            <option value={user}>{user}</option>
          {/each}
        </select>
      </div>

      <div class="filter-item">
        <label class="filter-label" for="filter-event-type">事件类型</label>
        <select
          id="filter-event-type"
          class="filter-select"
          bind:value={eventTypeFilter}
          onchange={applyFilters}
        >
          <option value="">全部事件</option>
          {#each uniqueEventTypes as eventType}
            <option value={eventType}>{getEventTypeLabel(eventType)}</option>
          {/each}
        </select>
      </div>

      <div class="filter-item">
        <label class="filter-label" for="filter-result">结果</label>
        <select
          id="filter-result"
          class="filter-select"
          bind:value={resultFilter}
          onchange={applyFilters}
        >
          <option value="">全部</option>
          <option value="success">成功</option>
          <option value="failure">失败</option>
          <option value="warning">警告</option>
          <option value="blocked">阻止</option>
        </select>
      </div>

      <div class="filter-item">
        <label class="filter-label" for="filter-level">级别</label>
        <select
          id="filter-level"
          class="filter-select"
          bind:value={levelFilter}
          onchange={applyFilters}
        >
          <option value="">全部级别</option>
          <option value="DEBUG">DEBUG</option>
          <option value="INFO">INFO</option>
          <option value="WARNING">WARNING</option>
          <option value="ERROR">ERROR</option>
        </select>
      </div>
    </div>

    <div class="filter-actions">
      <button class="btn-secondary" onclick={resetFilters}>
        重置筛选
      </button>
      <label class="auto-refresh-toggle">
        <input
          type="checkbox"
          bind:checked={autoRefresh}
        />
        <span>自动刷新（5秒）</span>
      </label>
      <div class="export-dropdown">
        <button class="btn-secondary" disabled={exporting}>
          {exporting ? "导出中..." : "导出 ▾"}
        </button>
        <div class="dropdown-menu">
          <button onclick={() => exportLogs("json")}>导出为 JSON</button>
          <button onclick={() => exportLogs("csv")}>导出为 CSV</button>
        </div>
      </div>
    </div>
  </section>

  <!-- 统计概览 -->
  <section class="stats-card">
    <h3 class="section-title">统计概览</h3>
    <div class="stats-grid">
      <div class="stat-item">
        <div class="stat-value">{stats.totalLogs}</div>
        <div class="stat-label">总计</div>
      </div>
      <div class="stat-item success">
        <div class="stat-value">{stats.successCount}</div>
        <div class="stat-label">成功</div>
      </div>
      <div class="stat-item failure">
        <div class="stat-value">{stats.failureCount}</div>
        <div class="stat-label">失败</div>
      </div>
      <div class="stat-item warning">
        <div class="stat-value">{stats.warningCount}</div>
        <div class="stat-label">警告</div>
      </div>
      <div class="stat-item blocked">
        <div class="stat-value">{stats.blockedCount}</div>
        <div class="stat-label">阻止</div>
      </div>
    </div>
  </section>

  <!-- 日志列表 -->
  <section class="logs-card">
    <div class="logs-header">
      <h3 class="section-title">日志列表 ({logs.length})</h3>
      {#if loading}
        <span class="loading-indicator">刷新中...</span>
      {/if}
    </div>

    <div class="logs-list">
      {#if logs.length === 0}
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <p class="empty-title">暂无日志</p>
          <p class="empty-text">在选定的时间范围内没有找到审计日志</p>
        </div>
      {:else}
        {#each logs as log}
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
              <div class="log-error">错误: {log.errorMessage}</div>
            {/if}
            
            {#if log.duration}
              <div class="log-duration">⏱️ {log.duration} ms</div>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </section>
</div>

<!-- 日志详情模态框 -->
{#if showDetailModal && selectedLog}
  <div 
    class="modal-overlay" 
    onclick={closeDetailModal}
    role="button"
    tabindex="0"
    onkeydown={(e) => e.key === 'Escape' && closeDetailModal()}
    aria-label="关闭模态框"
  >
    <div 
      class="modal-content" 
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <header class="modal-header">
        <h3 id="modal-title" class="modal-title">审计日志详情</h3>
        <button class="close-btn" onclick={closeDetailModal} aria-label="关闭">×</button>
      </header>

      <div class="modal-body">
        <!-- 基本信息 -->
        <section class="detail-section">
          <h4 class="detail-title">基本信息</h4>
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">ID:</span>
              <span class="detail-value">{selectedLog.id}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">时间:</span>
              <span class="detail-value">{formatTimestamp(selectedLog.timestamp)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">级别:</span>
              <span class="detail-value" style="color: {getLevelColor(selectedLog.level)}">
                {selectedLog.level}
              </span>
            </div>
            <div class="detail-item">
              <span class="detail-label">结果:</span>
              <span class="detail-value" style="color: {getResultColor(selectedLog.result)}">
                {getResultIcon(selectedLog.result)} {selectedLog.result}
              </span>
            </div>
            <div class="detail-item">
              <span class="detail-label">事件:</span>
              <span class="detail-value">{getEventTypeLabel(selectedLog.eventType)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">类别:</span>
              <span class="detail-value">{selectedLog.eventCategory}</span>
            </div>
          </div>
        </section>

        <!-- 用户信息 -->
        <section class="detail-section">
          <h4 class="detail-title">用户信息</h4>
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">用户 ID:</span>
              <span class="detail-value">{selectedLog.userId}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">用户名:</span>
              <span class="detail-value">{selectedLog.userName}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">邮箱:</span>
              <span class="detail-value">{selectedLog.userEmail}</span>
            </div>
            {#if selectedLog.metadata?.ipAddress}
              <div class="detail-item">
                <span class="detail-label">IP 地址:</span>
                <span class="detail-value">{selectedLog.metadata.ipAddress}</span>
              </div>
            {/if}
          </div>
        </section>

        <!-- 资源信息 -->
        {#if selectedLog.resourceId}
          <section class="detail-section">
            <h4 class="detail-title">资源信息</h4>
            <div class="detail-grid">
              <div class="detail-item">
                <span class="detail-label">资源 ID:</span>
                <span class="detail-value">{selectedLog.resourceId}</span>
              </div>
              {#if selectedLog.resourceType}
                <div class="detail-item">
                  <span class="detail-label">资源类型:</span>
                  <span class="detail-value">{selectedLog.resourceType}</span>
                </div>
              {/if}
              {#if selectedLog.resourceName}
                <div class="detail-item">
                  <span class="detail-label">资源名称:</span>
                  <span class="detail-value">{selectedLog.resourceName}</span>
                </div>
              {/if}
            </div>
          </section>
        {/if}

        <!-- 执行结果 -->
        <section class="detail-section">
          <h4 class="detail-title">执行结果</h4>
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">结果:</span>
              <span class="detail-value" style="color: {getResultColor(selectedLog.result)}">
                {getResultIcon(selectedLog.result)} {selectedLog.result}
              </span>
            </div>
            {#if selectedLog.duration}
              <div class="detail-item">
                <span class="detail-label">耗时:</span>
                <span class="detail-value">{selectedLog.duration} ms</span>
              </div>
            {/if}
            <div class="detail-item full-width">
              <span class="detail-label">描述:</span>
              <span class="detail-value">{selectedLog.eventDescription}</span>
            </div>
            {#if selectedLog.errorMessage}
              <div class="detail-item full-width error">
                <span class="detail-label">错误:</span>
                <span class="detail-value">{selectedLog.errorMessage}</span>
              </div>
            {/if}
          </div>
        </section>

        <!-- 元数据 -->
        {#if selectedLog.metadata && Object.keys(selectedLog.metadata).length > 0}
          <section class="detail-section">
            <h4 class="detail-title">元数据</h4>
            <pre class="metadata-pre">{JSON.stringify(selectedLog.metadata, null, 2)}</pre>
          </section>
        {/if}
      </div>

      <footer class="modal-footer">
        <button class="btn-primary" onclick={closeDetailModal}>
          关闭
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

  .export-dropdown:hover .dropdown-menu {
    display: block;
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

  .dropdown-menu button:hover {
    background: #F2F2F7;
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

  .log-item:hover {
    background: #E5E5EA;
    transform: translateX(4px);
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
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
  }

  .modal-content {
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

  .close-btn:hover {
    background: #E5E5EA;
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

  .btn-primary:hover {
    opacity: 0.8;
  }

  .btn-secondary {
    background: #F2F2F7;
    color: #007AFF;
  }

  .btn-secondary:hover {
    background: #E5E5EA;
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
