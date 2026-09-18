<script lang="ts">
  /**
   * APISettings.svelte — API 和 Webhook 配置界面
   * 
   * 功能:
   * - 启用/禁用 API 集成
   * - 配置基础 URL 和认证
   * - 管理 Webhook
   * - 测试 API 连接
   */

  import { apiClient, webhookManager } from "../../lib/enterprise";
  import { t } from "../locale.svelte";
  import type { APIConfig } from "../../lib/enterprise/api";
  import type { WebhookConfig } from "../../lib/enterprise/webhooks";
  import { attachFocusTrap } from "../../lib/focusTrap";
  // ============================================================================
  // 状态管理
  // ============================================================================

  let apiConfig = $state<APIConfig>(apiClient.getConfig());
  let webhooks = $state<WebhookConfig[]>(webhookManager.getWebhooks());
  let showTokenPlaintext = $state(false);
  let testingConnection = $state(false);
  let connectionStatus = $state<"success" | "error" | null>(null);
  let connectionMessage = $state("");
  let savingConfig = $state(false);

  // Webhook 编辑状态
  let showWebhookModal = $state(false);
  /** 模态根元素（焦点陷阱 + Escape 关闭）；`$effect` 在它出现时挂上。 */
  let modalEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!showWebhookModal || !modalEl) return;
    return attachFocusTrap(modalEl, closeWebhookModal);
  });

  /** 订阅事件那组复选框的组名 id（可见标签命名整组，而不是单个控件）。 */
  const eventsLabelId = "api-events-label";
  let editingWebhook = $state<WebhookConfig | null>(null);
  let webhookForm = $state<Partial<WebhookConfig>>({
    name: "",
    description: "",
    url: "",
    method: "POST",
    events: [],
    secret: "",
    headers: {},
    timeout: 5000,
    retryCount: 3,
    enabled: true,
  });
  let testingWebhook = $state(false);

  // ============================================================================
  // 事件处理 - API 配置
  // ============================================================================

  function toggleAPI() {
    apiConfig = { ...apiConfig, enabled: !apiConfig.enabled };
  }

  function updateBaseUrl(e: Event) {
    const target = e.target as HTMLInputElement;
    apiConfig = { ...apiConfig, baseUrl: target.value };
  }

  function updateToken(e: Event) {
    const target = e.target as HTMLInputElement;
    apiConfig = { ...apiConfig, apiKey: target.value };
  }

  function updateTimeout(e: Event) {
    const target = e.target as HTMLInputElement;
    apiConfig = { ...apiConfig, timeout: parseInt(target.value) || 30000 };
  }

  function updateRetryCount(e: Event) {
    const target = e.target as HTMLInputElement;
    apiConfig = { ...apiConfig, retryCount: parseInt(target.value) || 3 };
  }

  function updateRetryDelay(e: Event) {
    const target = e.target as HTMLInputElement;
    apiConfig = { ...apiConfig, retryDelay: parseInt(target.value) || 2000 };
  }

  function toggleTokenVisibility() {
    showTokenPlaintext = !showTokenPlaintext;
  }

  async function testConnection() {
    testingConnection = true;
    connectionStatus = null;
    
    try {
      await apiClient.request({
        method: "GET",
        path: "/health",
        skipRateLimit: true,
      });
      connectionStatus = "success";
      connectionMessage = t("api.connectOk");
    } catch (error) {
      connectionStatus = "error";
      connectionMessage = error instanceof Error ? error.message : t("api.connectFailed");
    } finally {
      testingConnection = false;
      setTimeout(() => { connectionStatus = null; }, 3000);
    }
  }

  function saveAPIConfig() {
    savingConfig = true;
    try {
      apiClient.configure(apiConfig);
      connectionStatus = "success";
      connectionMessage = t("api.configSaved");
      setTimeout(() => { connectionStatus = null; }, 2000);
    } catch (error) {
      connectionStatus = "error";
      connectionMessage = error instanceof Error ? error.message : t("api.saveFailed");
    } finally {
      savingConfig = false;
    }
  }

  // ============================================================================
  // 事件处理 - Webhook 管理
  // ============================================================================

  function openWebhookModal(webhook?: WebhookConfig) {
    if (webhook) {
      editingWebhook = webhook;
      webhookForm = { ...webhook };
    } else {
      editingWebhook = null;
      webhookForm = {
        name: "",
        url: "",
        method: "POST",
        events: [],
        secret: "",
        timeout: 5000,
        retryCount: 3,
        enabled: true,
        headers: {},
      };
    }
    showWebhookModal = true;
  }

  function closeWebhookModal() {
    showWebhookModal = false;
    editingWebhook = null;
    webhookForm = {
      name: "",
      url: "",
      method: "POST",
      events: [],
      secret: "",
      timeout: 5000,
      retryCount: 3,
      enabled: true,
    };
  }

  function toggleWebhookEvent(event: string) {
    const events = webhookForm.events || [];
    if (events.includes(event)) {
      webhookForm = { ...webhookForm, events: events.filter(e => e !== event) };
    } else {
      webhookForm = { ...webhookForm, events: [...events, event] };
    }
  }

  function saveWebhook() {
    if (!webhookForm.name || !webhookForm.url) {
      alert(t("api.needNameAndUrl"));
      return;
    }

    if (!webhookForm.events || webhookForm.events.length === 0) {
      alert(t("api.needOneEvent"));
      return;
    }

    try {
      if (editingWebhook && editingWebhook.id) {
        webhookManager.updateWebhook(editingWebhook.id, webhookForm as Partial<WebhookConfig>);
      } else {
        webhookManager.addWebhook({
          name: webhookForm.name || "",
          description: webhookForm.description || "",
          url: webhookForm.url || "",
          method: webhookForm.method || "POST",
          events: webhookForm.events || [],
          secret: webhookForm.secret || "",
          headers: webhookForm.headers || {},
          timeout: webhookForm.timeout || 5000,
          retryCount: webhookForm.retryCount || 3,
          enabled: webhookForm.enabled ?? true,
        });
      }
      webhooks = webhookManager.getWebhooks();
      closeWebhookModal();
    } catch (error) {
      alert(
        t("api.saveFailedReason", {
          reason: error instanceof Error ? error.message : t("api.unknownError"),
        }),
      );
    }
  }

  function deleteWebhook(webhookId: string) {
    if (confirm(t("api.confirmDeleteWebhook"))) {
      webhookManager.deleteWebhook(webhookId);
      webhooks = webhookManager.getWebhooks();
    }
  }

  async function testWebhook(webhookId: string) {
    testingWebhook = true;
    try {
      const result = await webhookManager.testWebhook(webhookId);
      if (result.success) {
        alert(t("api.testOk", { ms: result.duration }));
      } else {
        alert(t("api.testFailed", { reason: result.error || t("api.unknownError") }));
      }
    } catch (error) {
      alert(
        t("api.testFailed", {
          reason: error instanceof Error ? error.message : t("api.unknownError"),
        }),
      );
    } finally {
      testingWebhook = false;
    }
  }

  function toggleWebhook(webhookId: string) {
    const webhook = webhooks.find(w => w.id === webhookId);
    if (webhook) {
      webhookManager.updateWebhook(webhookId, { ...webhook, enabled: !webhook.enabled });
      webhooks = webhookManager.getWebhooks();
    }
  }

  // ============================================================================
  // 辅助函数
  // ============================================================================

  // 事件标签存**键**，渲染时再 t()：这个数组在模块初始化时就建好了，把 t() 放进去
  // 会把当时的语言**冻**在数组里（切语言不会再变）。
  const availableEvents = [
    { id: "shortcut_create", labelKey: "api.event.shortcut_create" },
    { id: "shortcut_run", labelKey: "api.event.shortcut_run" },
    { id: "shortcut_update", labelKey: "api.event.shortcut_update" },
    { id: "shortcut_delete", labelKey: "api.event.shortcut_delete" },
    { id: "shortcut_share", labelKey: "api.event.shortcut_share" },
    { id: "template_install", labelKey: "api.event.template_install" },
    { id: "mdm_policy_change", labelKey: "api.event.mdm_policy_change" },
  ];

  function getSuccessRate(webhook: WebhookConfig): number {
    if (!webhook.triggerCount) return 0;
    return Math.round(((webhook.successCount || 0) / webhook.triggerCount) * 100);
  }
</script>

<div class="api-settings">
  <header class="settings-header">
    <h2>🔌 {t("api.title")}</h2>
    <p class="subtitle">{t("api.subtitle")}</p>
  </header>

  <!-- API 配置 -->
  <section class="card">
    <div class="card-header-row">
      <h3 class="section-title">{t("api.configSection")}</h3>
      <label class="toggle-switch">
        <input
          type="checkbox"
          checked={apiConfig.enabled}
          onchange={toggleAPI}
          role="switch"
          aria-label={t("api.enable")}
        />
        <span class="slider"></span>
      </label>
    </div>

    {#if connectionStatus}
      <!-- 这是一条**用户动作之后**才出现的瞬时结果（测试连接/保存），而焦点还在按钮上，
           所以它必须是 live region —— 否则屏幕阅读器用户点了按钮、什么都没听到（REQ-A386）。 -->
      <div
        class="status-message"
        role="status"
        class:success={connectionStatus === "success"}
        class:error={connectionStatus === "error"}
      >
        {connectionStatus === "success" ? "✓" : "✗"} {connectionMessage}
      </div>
    {/if}

    <div class="form-group">
      <label for="baseUrl" class="form-label">{t("api.baseUrl")}</label>
      <input
        id="baseUrl"
        type="url"
        class="form-input"
        value={apiConfig.baseUrl}
        oninput={updateBaseUrl}
        placeholder="https://api.example.com"
        disabled={!apiConfig.enabled}
      />
    </div>

    <div class="form-group">
      <label for="authMethod" class="form-label">{t("api.authMethod")}</label>
      <select id="authMethod" class="form-input" disabled>
        <option>Bearer Token</option>
      </select>
      <p class="help-text">{t("api.authHint")}</p>
    </div>

    <div class="form-group">
      <label for="token" class="form-label">API Key</label>
      <div class="token-input-group">
        <input
          id="token"
          type={showTokenPlaintext ? "text" : "password"}
          class="form-input"
          value={apiConfig.apiKey || ""}
          oninput={updateToken}
          placeholder={t("api.apiKeyPlaceholder")}
          disabled={!apiConfig.enabled}
        />
        <button
          class="toggle-visibility-btn"
          onclick={toggleTokenVisibility}
          disabled={!apiConfig.enabled}
          aria-label={showTokenPlaintext ? t("api.hideToken") : t("api.showToken")}
        >
          {showTokenPlaintext ? "🙈" : "👁️"}
        </button>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="timeout" class="form-label">{t("api.timeoutMs")}</label>
        <input
          id="timeout"
          type="number"
          class="form-input"
          value={apiConfig.timeout}
          oninput={updateTimeout}
          min="1000"
          max="120000"
          step="1000"
          disabled={!apiConfig.enabled}
        />
      </div>

      <div class="form-group">
        <label for="retryCount" class="form-label">{t("api.retryCount")}</label>
        <input
          id="retryCount"
          type="number"
          class="form-input"
          value={apiConfig.retryCount}
          oninput={updateRetryCount}
          min="0"
          max="5"
          disabled={!apiConfig.enabled}
        />
      </div>

      <div class="form-group">
        <label for="retryDelay" class="form-label">{t("api.retryDelayMs")}</label>
        <input
          id="retryDelay"
          type="number"
          class="form-input"
          value={apiConfig.retryDelay}
          oninput={updateRetryDelay}
          min="500"
          max="10000"
          step="500"
          disabled={!apiConfig.enabled}
        />
      </div>
    </div>

    <div class="action-buttons">
      <button
        class="btn-secondary"
        onclick={testConnection}
        disabled={!apiConfig.enabled || testingConnection}
      >
        {testingConnection ? t("api.testing") : t("api.testConnection")}
      </button>
      <button
        class="btn-primary"
        onclick={saveAPIConfig}
        disabled={!apiConfig.enabled || savingConfig}
      >
        {savingConfig ? t("api.saving") : t("api.saveConfig")}
      </button>
    </div>
  </section>

  <!-- Webhook 管理 -->
  <section class="card">
    <div class="card-header-row">
      <h3 class="section-title">{t("api.webhooksSection")}</h3>
      <button class="btn-add" onclick={() => openWebhookModal()}>
        + {t("api.addWebhook")}
      </button>
    </div>

    <div class="webhooks-list">
      {#if webhooks.length === 0}
        <div class="empty-state">
          <div class="empty-icon">🔗</div>
          <p class="empty-title">{t("api.noWebhooks")}</p>
          <p class="empty-text">{t("api.noWebhooksHint")}</p>
        </div>
      {:else}
        {#each webhooks as webhook}
          <div class="webhook-item" class:disabled={!webhook.enabled}>
            <div class="webhook-header">
              <div class="webhook-name-row">
                <span class="webhook-name">{webhook.name}</span>
                <label class="webhook-toggle">
                  <input
                    type="checkbox"
                    checked={webhook.enabled}
                    onchange={() => webhook.id && toggleWebhook(webhook.id)}
                  />
                  <span>{webhook.enabled ? t("api.enabled") : t("api.disabled")}</span>
                </label>
              </div>
              <div class="webhook-url">{webhook.url}</div>
            </div>

            <div class="webhook-info">
              <div class="webhook-events">
                <span class="info-label">{t("api.eventLabel")}</span>
                <span class="info-value">{webhook.events.join(", ")}</span>
              </div>
              <div class="webhook-stats">
                <span class="info-label">{t("api.triggerLabel")}</span>
                <span class="info-value">{t("api.timesCount", { count: webhook.triggerCount || 0 })}</span>
                <span class="info-separator">|</span>
                <span class="info-label">{t("api.successLabel")}</span>
                <span class="info-value">{webhook.successCount || 0} ({getSuccessRate(webhook)}%)</span>
              </div>
            </div>

            <div class="webhook-actions">
              <button class="btn-small" onclick={() => openWebhookModal(webhook)}>
                {t("api.edit")}
              </button>
              <button
                class="btn-small"
                onclick={() => webhook.id && testWebhook(webhook.id)}
                disabled={!webhook.enabled || testingWebhook}
              >
                {t("api.test")}
              </button>
              <button class="btn-small btn-danger" onclick={() => webhook.id && deleteWebhook(webhook.id)}>
                {t("api.delete")}
              </button>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </section>
</div>

<!-- Webhook 编辑模态框 -->
{#if showWebhookModal}
  <!-- 遮罩 = 内容后面的一枚真按钮（点它关闭）；内容因此不再需要 stopPropagation，
       Escape + 焦点陷阱走仓库共享的 `attachFocusTrap`（REQ-A386）。 -->
  <div class="modal-overlay">
    <button
      class="modal-backdrop"
      aria-label={t("api.close")}
      onclick={closeWebhookModal}
    ></button>
    <div
      class="modal-content"
      bind:this={modalEl}
      role="dialog"
      aria-modal="true"
      aria-labelledby="api-modal-title"
      tabindex="-1"
    >
      <header class="modal-header">
        <h3 id="api-modal-title" class="modal-title">
          {editingWebhook ? t("api.editWebhookTitle") : t("api.addWebhookTitle")}
        </h3>
        <button class="close-btn" onclick={closeWebhookModal} aria-label={t("api.close")}>×</button>
      </header>

      <div class="modal-body">
        <div class="form-group">
          <label for="webhookName" class="form-label">{t("api.nameLabel")}</label>
          <input
            id="webhookName"
            type="text"
            class="form-input"
            bind:value={webhookForm.name}
            placeholder={t("api.namePlaceholder")}
          />
        </div>

        <div class="form-group">
          <label for="webhookUrl" class="form-label">URL *</label>
          <input
            id="webhookUrl"
            type="url"
            class="form-input"
            bind:value={webhookForm.url}
            placeholder="https://hooks.example.com/webhook"
          />
        </div>

        <div class="form-group">
          <label for="webhookMethod" class="form-label">{t("api.methodLabel")}</label>
          <select
            id="webhookMethod"
            class="form-input"
            bind:value={webhookForm.method}
          >
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
          </select>
        </div>

        <div class="form-group">
          <!-- 这个标签命名的是一**组**复选框 ⇒ `role="group"` + `aria-labelledby`，
               而不是一个指向不存在的控件的 `<label>`（REQ-A386）。 -->
          <span id={eventsLabelId} class="form-label">{t("api.eventsLabel")}</span>
          <div class="events-checkboxes" role="group" aria-labelledby={eventsLabelId}>
            {#each availableEvents as event}
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  checked={webhookForm.events?.includes(event.id)}
                  onchange={() => toggleWebhookEvent(event.id)}
                />
                <span>{t(event.labelKey)}</span>
              </label>
            {/each}
          </div>
        </div>

        <div class="form-group">
          <label for="webhookSecret" class="form-label">{t("api.secretLabel")}</label>
          <input
            id="webhookSecret"
            type="password"
            class="form-input"
            bind:value={webhookForm.secret}
            placeholder={t("api.secretPlaceholder")}
          />
          <p class="help-text">{t("api.secretHint")}</p>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="webhookTimeout" class="form-label">{t("api.webhookTimeoutMs")}</label>
            <input
              id="webhookTimeout"
              type="number"
              class="form-input"
              bind:value={webhookForm.timeout}
              min="1000"
              max="30000"
              step="1000"
            />
          </div>

          <div class="form-group">
            <label for="webhookRetry" class="form-label">{t("api.retryCount")}</label>
            <input
              id="webhookRetry"
              type="number"
              class="form-input"
              bind:value={webhookForm.retryCount}
              min="0"
              max="5"
            />
          </div>
        </div>
      </div>

      <footer class="modal-footer">
        <button class="btn-secondary" onclick={closeWebhookModal}>
          {t("api.cancel")}
        </button>
        <button class="btn-primary" onclick={saveWebhook}>
          {editingWebhook ? t("api.update") : t("api.add")}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .api-settings {
    max-width: 900px;
    margin: 0 auto;
    padding: 24px;
  }

  .settings-header {
    margin-bottom: 24px;
  }

  .settings-header h2 {
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
  .card {
    background: #fff;
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .card-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .section-title {
    font-size: 17px;
    font-weight: 600;
    color: #000;
    margin: 0;
  }

  /* 开关 */
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

  /* 状态消息 */
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

  /* 表单 */
  .form-group {
    margin-bottom: 16px;
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

  .help-text {
    font-size: 12px;
    color: #8E8E93;
    margin: 4px 0 0 0;
  }

  .token-input-group {
    position: relative;
    display: flex;
    align-items: center;
  }

  .toggle-visibility-btn {
    position: absolute;
    right: 8px;
    padding: 8px;
    border: none;
    background: transparent;
    font-size: 18px;
    cursor: pointer;
  }

  .toggle-visibility-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .form-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
  }

  .action-buttons {
    display: flex;
    gap: 12px;
    margin-top: 20px;
  }

  /* 按钮 */
  .btn-primary,
  .btn-secondary,
  .btn-add {
    padding: 12px 24px;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.2s;
  }

  .btn-primary {
    flex: 1;
    background: #007AFF;
    color: white;
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .btn-primary:hover:not(:disabled) {
    opacity: 0.8;
  }
  }

  .btn-secondary {
    flex: 1;
    background: #F2F2F7;
    color: #007AFF;
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .btn-secondary:hover:not(:disabled) {
    background: #E5E5EA;
  }
  }

  .btn-add {
    background: #007AFF;
    color: white;
    padding: 8px 16px;
    font-size: 14px;
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .btn-add:hover {
    opacity: 0.8;
  }
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Webhook 列表 */
  .webhooks-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .webhook-item {
    background: #F2F2F7;
    border-radius: 8px;
    padding: 16px;
    transition: opacity 0.2s;
  }

  .webhook-item.disabled {
    opacity: 0.6;
  }

  .webhook-header {
    margin-bottom: 12px;
  }

  .webhook-name-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .webhook-name {
    font-size: 16px;
    font-weight: 600;
    color: #000;
  }

  .webhook-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: #007AFF;
    cursor: pointer;
  }

  .webhook-toggle input {
    width: 16px;
    height: 16px;
    cursor: pointer;
  }

  .webhook-url {
    font-size: 13px;
    color: #8E8E93;
    word-break: break-all;
  }

  .webhook-info {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
    font-size: 13px;
  }

  .webhook-events,
  .webhook-stats {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .info-label {
    color: #8E8E93;
  }

  .info-value {
    color: #000;
  }

  .info-separator {
    color: #E5E5EA;
  }

  .webhook-actions {
    display: flex;
    gap: 8px;
  }

  .btn-small {
    padding: 6px 12px;
    border: none;
    background: #fff;
    color: #007AFF;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .btn-small:hover:not(:disabled) {
    background: #E5E5EA;
  }
  }

  .btn-small.btn-danger {
    color: #FF3B30;
  }

  .btn-small:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* 空状态 */
  .empty-state {
    text-align: center;
    padding: 40px 20px;
  }

  .empty-icon {
    font-size: 48px;
    margin-bottom: 12px;
  }

  .empty-title {
    font-size: 17px;
    font-weight: 600;
    color: #000;
    margin: 0 0 8px 0;
  }

  .empty-text {
    font-size: 14px;
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
    max-width: 600px;
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

  .events-checkboxes {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    background: #F2F2F7;
    border-radius: 8px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 14px;
    color: #000;
  }

  .checkbox-label input {
    width: 18px;
    height: 18px;
    cursor: pointer;
  }

  .modal-footer {
    display: flex;
    gap: 12px;
    padding: 20px;
    border-top: 1px solid #E5E5EA;
  }

  /* 响应式 */
  @media (max-width: 768px) {
    .api-settings {
      padding: 16px;
    }

    .form-row {
      grid-template-columns: 1fr;
    }

    .action-buttons {
      flex-direction: column;
    }

    .webhook-actions {
      flex-wrap: wrap;
    }
  }
</style>
