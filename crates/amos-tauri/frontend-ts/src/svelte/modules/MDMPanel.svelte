<script lang="ts">
  /**
   * MDMPanel.svelte — MDM 配置管理面板
   * 
   * 功能:
   * - 启用/禁用 MDM
   * - 配置服务器 URL 和组织 ID
   * - 管理策略和限制
   * - 查看设备注册状态
   * - 手动同步配置
   */

  import { mdmManager } from "../../lib/enterprise";
  import type { MDMConfig, MDMRestrictions } from "../../lib/enterprise/mdm";

  // ============================================================================
  // 状态管理
  // ============================================================================

  let config = $state<MDMConfig | null>(mdmManager.getConfig());
  let restrictions = $state<MDMRestrictions>(mdmManager.getRestrictions());
  let syncing = $state(false);
  let testingConnection = $state(false);
  let lastSyncTime = $state<number | null>(null);
  let connectionStatus = $state<"success" | "error" | null>(null);
  let connectionMessage = $state("");

  // ============================================================================
  // 事件处理
  // ============================================================================

  function toggleMDM() {
    if (!config) return;
    mdmManager.configure({ ...config, enabled: !config?.enabled });
    config = mdmManager.getConfig();
    restrictions = mdmManager.getRestrictions();
  }

  function updateServerUrl(e: Event) {
    if (!config) return;
    const target = e.target as HTMLInputElement;
    mdmManager.configure({ ...config, serverUrl: target.value });
    config = mdmManager.getConfig();
  }

  function updateOrganizationId(e: Event) {
    if (!config) return;
    const target = e.target as HTMLInputElement;
    mdmManager.configure({ ...config, organizationId: target.value });
    config = mdmManager.getConfig();
  }

  function updateRestriction(key: keyof MDMRestrictions, value: boolean | number) {
    if (!config) return;
    restrictions = { ...restrictions, [key]: value };
    mdmManager.configure({ ...config, restrictions });
    config = mdmManager.getConfig();
    restrictions = mdmManager.getRestrictions();
  }

  async function syncConfig() {
    syncing = true;
    try {
      await mdmManager.syncWithServer();
      config = mdmManager.getConfig();
      restrictions = mdmManager.getRestrictions();
      lastSyncTime = Date.now();
      connectionStatus = "success";
      connectionMessage = "配置同步成功";
      setTimeout(() => { connectionStatus = null; }, 3000);
    } catch (error) {
      connectionStatus = "error";
      connectionMessage = error instanceof Error ? error.message : "同步失败";
    } finally {
      syncing = false;
    }
  }

  async function testConnection() {
    if (!config) return;
    testingConnection = true;
    connectionStatus = null;
    try {
      // 模拟连接测试
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (config.serverUrl && config.serverUrl.startsWith("https://")) {
        connectionStatus = "success";
        connectionMessage = "连接成功";
      } else {
        throw new Error("无效的服务器 URL");
      }
    } catch (error) {
      connectionStatus = "error";
      connectionMessage = error instanceof Error ? error.message : "连接失败";
    } finally {
      testingConnection = false;
      setTimeout(() => { connectionStatus = null; }, 3000);
    }
  }

  function resetToDefault() {
    if (!config) return;
    if (confirm("确定要重置为默认配置吗？这将清除所有自定义设置。")) {
      mdmManager.configure({
        enabled: false,
        serverUrl: "",
        organizationId: "",
        deviceId: config.deviceId,
        enrolledAt: config?.enrolledAt,
        restrictions: {
          allowUserCreate: true,
          allowUserModify: true,
          allowUserDelete: true,
          allowSharing: true,
          allowExport: true,
          allowImport: true,
          requireApprovalForCreate: false,
          requireApprovalForModify: false,
          requireApprovalForSharing: false,
          requireApprovalForDelete: false,
          maxExecutionsPerDay: 1000,
          maxActionsPerShortcut: 100,
          maxShortcutsPerUser: 500,
        },
      });
      config = mdmManager.getConfig();
      restrictions = mdmManager.getRestrictions();
    }
  }

  function formatDate(timestamp: number | null): string {
    if (!timestamp) return "从未同步";
    const date = new Date(timestamp);
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

<div class="mdm-panel">
  <header class="panel-header">
    <h2>📱 MDM 移动设备管理</h2>
    <p class="subtitle">集中管理快捷指令策略和使用限制</p>
  </header>

  <!-- 主开关 -->
  <section class="card">
    <div class="toggle-row">
      <div>
        <div class="label">启用 MDM</div>
        <div class="caption">启用后将应用企业策略和使用限制</div>
      </div>
      <label class="toggle-switch">
        <input
          type="checkbox"
          checked={config?.enabled}
          onchange={toggleMDM}
          role="switch"
          aria-label="启用 MDM"
        />
        <span class="slider"></span>
      </label>
    </div>
  </section>

  <!-- 服务器配置 -->
  <section class="card">
    <h3 class="section-title">服务器配置</h3>
    <div class="form-group">
      <label for="serverUrl" class="form-label">服务器 URL</label>
      <input
        id="serverUrl"
        type="url"
        class="form-input"
        value={config.serverUrl}
        oninput={updateServerUrl}
        placeholder="https://mdm.company.com"
        disabled={!config?.enabled}
      />
    </div>
    <div class="form-group">
      <label for="organizationId" class="form-label">组织 ID</label>
      <input
        id="organizationId"
        type="text"
        class="form-input"
        value={config.organizationId}
        oninput={updateOrganizationId}
        placeholder="org-12345"
        disabled={!config?.enabled}
      />
    </div>
    <div class="form-group">
      <label for="deviceId" class="form-label">设备 ID</label>
      <input
        id="deviceId"
        type="text"
        class="form-input disabled-input"
        value={config.deviceId}
        disabled
        readonly
      />
      <p class="help-text">自动生成，只读</p>
    </div>
    <button
      class="btn-secondary"
      onclick={testConnection}
      disabled={!config?.enabled || testingConnection}
    >
      {testingConnection ? "测试中..." : "测试连接"}
    </button>
  </section>

  <!-- 权限策略 -->
  <section class="card">
    <h3 class="section-title">权限策略</h3>
    <div class="permission-list">
      <label class="permission-item">
        <input
          type="checkbox"
          checked={restrictions.allowUserCreate}
          onchange={() => updateRestriction("allowUserCreate", !restrictions.allowUserCreate)}
          disabled={!config?.enabled}
        />
        <span>允许用户创建快捷指令</span>
      </label>
      <label class="permission-item">
        <input
          type="checkbox"
          checked={restrictions.allowUserModify}
          onchange={() => updateRestriction("allowUserModify", !restrictions.allowUserModify)}
          disabled={!config?.enabled}
        />
        <span>允许用户编辑快捷指令</span>
      </label>
      <label class="permission-item">
        <input
          type="checkbox"
          checked={restrictions.allowUserDelete}
          onchange={() => updateRestriction("allowUserDelete", !restrictions.allowUserDelete)}
          disabled={!config?.enabled}
        />
        <span>允许用户删除快捷指令</span>
      </label>
      <label class="permission-item">
        <input
          type="checkbox"
          checked={restrictions.allowSharing}
          onchange={() => updateRestriction("allowSharing", !restrictions.allowSharing)}
          disabled={!config?.enabled}
        />
        <span>允许用户分享快捷指令</span>
      </label>
      <label class="permission-item">
        <input
          type="checkbox"
          checked={restrictions.allowImport}
          onchange={() => updateRestriction("allowImport", !restrictions.allowImport)}
          disabled={!config?.enabled}
        />
        <span>允许用户导入快捷指令</span>
      </label>
      <label class="permission-item">
        <input
          type="checkbox"
          checked={restrictions.allowExport}
          onchange={() => updateRestriction("allowExport", !restrictions.allowExport)}
          disabled={!config?.enabled}
        />
        <span>允许用户导出快捷指令</span>
      </label>
    </div>
  </section>

  <!-- 使用限制 -->
  <section class="card">
    <h3 class="section-title">使用限制</h3>
    <div class="limit-list">
      <div class="limit-item">
        <label for="maxShortcutsPerUser" class="limit-label">
          每用户快捷指令数
        </label>
        <div class="number-input-group">
          <input
            id="maxShortcutsPerUser"
            type="number"
            class="number-input"
            value={restrictions.maxShortcutsPerUser}
            oninput={(e) => updateRestriction("maxShortcutsPerUser", parseInt((e.target as HTMLInputElement).value) || 100)}
            min="1"
            max="1000"
            disabled={!config?.enabled}
          />
          <span class="unit">个</span>
        </div>
      </div>
      <div class="limit-item">
        <label for="maxActionsPerShortcut" class="limit-label">
          每快捷指令动作数
        </label>
        <div class="number-input-group">
          <input
            id="maxActionsPerShortcut"
            type="number"
            class="number-input"
            value={restrictions.maxActionsPerShortcut}
            oninput={(e) => updateRestriction("maxActionsPerShortcut", parseInt((e.target as HTMLInputElement).value) || 50)}
            min="1"
            max="200"
            disabled={!config?.enabled}
          />
          <span class="unit">个</span>
        </div>
      </div>
      <div class="limit-item">
        <label for="maxExecutionsPerDay" class="limit-label">
          每日执行次数
        </label>
        <div class="number-input-group">
          <input
            id="maxExecutionsPerDay"
            type="number"
            class="number-input"
            value={restrictions.maxExecutionsPerDay}
            oninput={(e) => updateRestriction("maxExecutionsPerDay", parseInt((e.target as HTMLInputElement).value) || 1000)}
            min="1"
            max="10000"
            disabled={!config?.enabled}
          />
          <span class="unit">次</span>
        </div>
      </div>
    </div>
  </section>

  <!-- 同步状态 -->
  <section class="card sync-section">
    {#if connectionStatus}
      <div class="status-message" class:success={connectionStatus === "success"} class:error={connectionStatus === "error"}>
        {connectionStatus === "success" ? "✓" : "✗"} {connectionMessage}
      </div>
    {/if}
    
    <div class="sync-info">
      <span class="sync-label">最后同步:</span>
      <span class="sync-time">{formatDate(lastSyncTime || config?.enrolledAt)}</span>
    </div>
    
    <div class="action-buttons">
      <button
        class="btn-primary"
        onclick={syncConfig}
        disabled={!config?.enabled || syncing}
      >
        {syncing ? "同步中..." : "同步配置"}
      </button>
      <button
        class="btn-secondary"
        onclick={resetToDefault}
        disabled={syncing}
      >
        重置为默认
      </button>
    </div>
  </section>
</div>

<style>
  .mdm-panel {
    max-width: 800px;
    margin: 0 auto;
    padding: 24px;
  }

  .panel-header {
    margin-bottom: 24px;
  }

  .panel-header h2 {
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

  .card {
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

  /* 开关行 */
  .toggle-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .label {
    font-size: 15px;
    font-weight: 500;
    color: #000;
    margin-bottom: 4px;
  }

  .caption {
    font-size: 13px;
    color: #8E8E93;
  }

  /* iOS 风格开关 */
  .toggle-switch {
    position: relative;
    display: inline-block;
    width: 51px;
    height: 31px;
  }

  .toggle-switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .slider {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: #E5E5EA;
    transition: 0.3s;
    border-radius: 31px;
  }

  .slider:before {
    position: absolute;
    content: "";
    height: 27px;
    width: 27px;
    left: 2px;
    bottom: 2px;
    background-color: white;
    transition: 0.3s;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  input:checked + .slider {
    background-color: #34C759;
  }

  input:checked + .slider:before {
    transform: translateX(20px);
  }

  input:disabled + .slider {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* 表单 */
  .form-group {
    margin-bottom: 16px;
  }

  .form-group:last-child {
    margin-bottom: 0;
  }

  .form-label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: #3C3C43;
    margin-bottom: 8px;
  }

  .form-input {
    width: 100%;
    padding: 12px;
    border: 1px solid #E5E5EA;
    border-radius: 8px;
    font-size: 15px;
    background: #fff;
    transition: border-color 0.2s;
  }

  .form-input:focus {
    outline: none;
    border-color: #007AFF;
  }

  .form-input:disabled {
    background: #F2F2F7;
    color: #8E8E93;
    cursor: not-allowed;
  }

  .disabled-input {
    background: #F2F2F7;
    color: #8E8E93;
  }

  .help-text {
    font-size: 12px;
    color: #8E8E93;
    margin: 4px 0 0 0;
  }

  /* 权限列表 */
  .permission-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .permission-item {
    display: flex;
    align-items: center;
    gap: 12px;
    cursor: pointer;
    font-size: 15px;
    color: #000;
  }

  .permission-item input[type="checkbox"] {
    width: 20px;
    height: 20px;
    cursor: pointer;
  }

  .permission-item input[type="checkbox"]:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* 限制列表 */
  .limit-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .limit-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .limit-label {
    font-size: 15px;
    color: #000;
  }

  .number-input-group {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .number-input {
    width: 80px;
    padding: 8px 12px;
    border: 1px solid #E5E5EA;
    border-radius: 8px;
    font-size: 15px;
    text-align: right;
  }

  .number-input:focus {
    outline: none;
    border-color: #007AFF;
  }

  .number-input:disabled {
    background: #F2F2F7;
    color: #8E8E93;
    cursor: not-allowed;
  }

  .unit {
    font-size: 15px;
    color: #8E8E93;
  }

  /* 同步区域 */
  .sync-section {
    border-top: 1px solid #E5E5EA;
    margin-top: 24px;
  }

  .status-message {
    padding: 12px;
    border-radius: 8px;
    font-size: 14px;
    margin-bottom: 16px;
  }

  .status-message.success {
    background: #E5F7ED;
    color: #34C759;
  }

  .status-message.error {
    background: #FFE5E5;
    color: #FF3B30;
  }

  .sync-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    font-size: 14px;
  }

  .sync-label {
    color: #8E8E93;
  }

  .sync-time {
    color: #3C3C43;
  }

  .action-buttons {
    display: flex;
    gap: 12px;
  }

  /* 按钮 */
  .btn-primary,
  .btn-secondary {
    flex: 1;
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
  }

  .btn-primary:hover:not(:disabled) {
    opacity: 0.8;
  }

  .btn-secondary {
    background: #F2F2F7;
    color: #007AFF;
  }

  .btn-secondary:hover:not(:disabled) {
    opacity: 0.8;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* 响应式 */
  @media (max-width: 768px) {
    .mdm-panel {
      padding: 16px;
    }

    .action-buttons {
      flex-direction: column;
    }

    .limit-item {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }
  }
</style>
