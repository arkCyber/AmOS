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
  import {
    AUTH_TYPES,
    AUTH_TYPE_INFO,
    type APIAuthType,
    type APIConfig,
    type AuthField,
  } from "../../lib/enterprise/api";
  import type { WebhookConfig } from "../../lib/enterprise/webhooks";
  import {
    API_NUMERIC_RANGES,
    readBoundedInt,
    type APINumericKey,
    type NumericFieldVerdict,
  } from "../../lib/enterprise/numericField";
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
  /**
   * Set when a **webhook** write was refused by the store (REQ-A806). The manager reports the
   * refusal through `onWriteRefused` rather than a return value: four entry points persist the
   * whole collection and `addWebhook` has to keep returning the new id. The list below renders
   * this, and the modal refuses to close on it — closing the modal *is* the "saved" claim here.
   *
   * Cleared at the start of every save attempt, so the note describes the attempt the user just
   * made rather than accumulating.
   */
  let webhookWriteRefused = $state(false);
  $effect(() => webhookManager.onWriteRefused(() => { webhookWriteRefused = true; }));

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

  /**
   * Pick the authentication method (REQ-A801).
   *
   * The select used to be `disabled` with a single hard-coded "Bearer Token" option and a hint
   * saying only Bearer is supported — which was **false**: `APIClient.buildHeaders` implemented
   * `api_key` (the `DEFAULT_API_CONFIG` default!) and `basic` as well, and the credential inputs
   * those two read had no control anywhere. So two working methods were unreachable and the
   * screen said they did not exist.
   *
   * `oauth2` is rendered as an unavailable option **with its true reason** rather than being
   * hidden: hiding it would be the other half of the same defect (a capability the vocabulary
   * declares and the screen never mentions).
   */
  function updateAuthType(e: Event) {
    const target = e.target as HTMLSelectElement;
    apiConfig = { ...apiConfig, authType: target.value as APIAuthType };
  }

  /** The credential inputs the current auth type reads, in display order. */
  const authFields = $derived(AUTH_TYPE_INFO[apiConfig.authType].fields);

  /** Whether this build can authenticate with the selected method at all. */
  const authImplemented = $derived(AUTH_TYPE_INFO[apiConfig.authType].implemented);

  /** The selected method's credential inputs that are still empty — the honest reason a
   *  configured request would go out with no auth header. */
  const missingAuthFields = $derived(
    authFields.filter((f) => !(apiConfig[f] ?? "").toString().trim()),
  );

  /** Read one credential field off the config (never `undefined` in an `<input>` value). */
  function authFieldValue(field: AuthField): string {
    return apiConfig[field] ?? "";
  }

  /** Write one credential field back, by its own `APIConfig` key. */
  function updateAuthField(field: AuthField, e: Event) {
    const target = e.target as HTMLInputElement;
    apiConfig = { ...apiConfig, [field]: target.value };
  }

  /** Label key + input type for one credential field. */
  const AUTH_FIELD_META: Record<AuthField, { labelKey: string; secret: boolean }> = {
    apiKey: { labelKey: "api.fieldApiKey", secret: true },
    bearerToken: { labelKey: "api.fieldBearerToken", secret: true },
    username: { labelKey: "api.fieldUsername", secret: false },
    password: { labelKey: "api.fieldPassword", secret: true },
  };

  /**
   * The option label for each auth type, spelled out per member rather than built as
   * `` `api.authType.${type}` ``.
   *
   * A computed key is invisible to `i18n-scan` (it checks that every dictionary key is
   * referenced by production, and a template string references no key in particular) and to a
   * reader grep. The `Record` over `APIAuthType` costs four lines and makes a new member a
   * compile error here.
   */
  const AUTH_TYPE_LABEL_KEY: Record<APIAuthType, string> = {
    api_key: "api.authType.api_key",
    bearer_token: "api.authType.bearer_token",
    basic: "api.authType.basic",
    // The unimplemented member's label carries its reason, so the greyed option explains
    // itself where the user meets it.
    oauth2: "api.authType.oauth2Missing",
  };

  /** 被拒绝的那个数字框（连同理由），没有拒绝时为 `null`。 */
  let numericRefusal = $state<{ key: APINumericKey; message: string } | null>(null);

  /** 把一条拒绝翻成人话。三次 `t()` 都是**字面量键**（`i18n-scan` 的「有没有人引用」
   *  只认字面量）。 */
  function numericRefusalMessage(verdict: Extract<NumericFieldVerdict, { ok: false }>): string {
    switch (verdict.reason) {
      case "not-integer":
        return t("common.numberNotInteger");
      case "below-min":
        return t("common.numberBelowMin", { min: verdict.range.min });
      case "above-max":
        return t("common.numberAboveMax", { max: verdict.range.max });
    }
  }

  /**
   * 一个数字字段的输入处理（REQ-A821）。
   *
   * 三个函数原先都是 `parseInt(v) || <默认值>`：`0`／空串／`abc` 一律被静默换成默认值
   * （「重试次数」写 `0` 意味着不重试 —— 一个完全合法的设定，却被换成 `3`），而超过
   * 声明 `max` 的值原样入模型。收下就写，不收就**什么都不写**、只把那句话显示出来。
   */
  function updateBoundedNumber(key: APINumericKey, e: Event) {
    const target = e.target as HTMLInputElement;
    const verdict = readBoundedInt(target.value, API_NUMERIC_RANGES[key]);
    if (verdict.ok) {
      apiConfig = { ...apiConfig, [key]: verdict.value };
      numericRefusal = null;
      return;
    }
    numericRefusal = { key, message: numericRefusalMessage(verdict) };
  }

  /** 离焦时把框里的字收回模型的值 —— 框里显示的永远是系统真正持有的数。 */
  function resyncBoundedNumber(key: APINumericKey, e: Event) {
    const target = e.target as HTMLInputElement;
    if (numericRefusal?.key === key) target.value = String(apiConfig[key]);
  }

  function updateTimeout(e: Event) {
    updateBoundedNumber("timeout", e);
  }

  function updateRetryCount(e: Event) {
    updateBoundedNumber("retryCount", e);
  }

  function updateRetryDelay(e: Event) {
    updateBoundedNumber("retryDelay", e);
  }

  function toggleTokenVisibility() {
    showTokenPlaintext = !showTokenPlaintext;
  }

  /**
   * 测试连接 —— 只声称 `apiClient.request` **真的同意**的那件事（REQ-A819）。
   *
   * 这里原先**真的发了请求**（`GET /health`，与 MDM 面板探的是同一条路由），但把回答
   * 丢掉了：`apiClient.request` 对 4xx/5xx **不抛**，而是返回
   * `{ success: false, statusCode, error: "HTTP 404: Not Found" }`（`api.ts:299-313`），
   * 于是 `await` 之后无条件说「连接成功」—— 一个 401／404／500／503 的 API 服务器
   * 全都被报成连上了；只有传输层真的抛（DNS／TLS／超时重试耗尽）才走失败分支。
   *
   * 同一个文件里 `saveConfig` 已因**同一个形状**被修过（REQ-A806：`configure()` 的
   * 返回值被当成「已完成」），隔壁 `testWebhook` 也一直在读 `result.success` ——
   * 规则不新，只是这一处没跟上。
   */
  async function testConnection() {
    testingConnection = true;
    connectionStatus = null;

    try {
      const result = await apiClient.request({
        method: "GET",
        path: "/health",
        skipRateLimit: true,
      });
      if (result.success) {
        connectionStatus = "success";
        connectionMessage = t("api.connectOk");
      } else {
        // 非 2xx 是一个**回答**，不是一次失败：把状态码说出来。`statusCode === 0` 是
        // `api.ts:332` 的编码——**一个状态码都没收到**（DNS／TLS／超时，重试耗尽后
        // 由那条 return 兜底），那才是「连不上」。`result.error` 是
        // `HTTP 404: Not Found`／`TimeoutError: …` 这类机器话，故不还给用户。
        connectionStatus = "error";
        connectionMessage = result.statusCode
          ? t("api.connectHttpStatus", { status: result.statusCode })
          : t("api.connectUnreachable");
      }
    } catch {
      // 今天**走不到**：`apiClient.request` 把每一次传输失败也折成 `{ success: false,
      // statusCode: 0 }` 返回，不抛。留着它是因为界面不该依赖实现的这个细节 ——
      // 如果那个契约将来改成抛，这里也不会把一次抛出当成「连上了」。
      connectionStatus = "error";
      connectionMessage = t("api.connectUnreachable");
    } finally {
      testingConnection = false;
      setTimeout(() => { connectionStatus = null; }, 3000);
    }
  }

  /**
   * Save the API config, and **claim only what the store agreed to** (REQ-A806).
   *
   * This handler used to read `apiClient.configure(apiConfig)` as "done" and show 「配置已保存」
   * for every outcome, while `configure` returned `void` — so a refused write (storage full or
   * unavailable) was reported to the user as a success and the config was silently gone at the
   * next launch. The repo's own `write-scan` gate allows that: it requires a write's boolean be
   * answered by *some* caller, not that the answer reach a user-visible surface — and the channel
   * the refusal landed on, `enterprise/logger.ts`, was a `console.*` wrapper with no reader (it
   * reaches the rendered ledger now: REQ-A807).
   *
   * The pattern is `KeyboardPage.svelte::reportWrite`'s: say which of the two happened.
   */
  function saveAPIConfig() {
    savingConfig = true;
    try {
      const landed = apiClient.configure(apiConfig);
      connectionStatus = landed ? "success" : "error";
      connectionMessage = t(landed ? "api.configSaved" : "api.saveRefused");
      setTimeout(() => { connectionStatus = null; }, landed ? 2000 : 6000);
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

    webhookWriteRefused = false;
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
      // The modal closing is this screen's "saved" claim. A refused write left the list in
      // memory only, so keep the modal open and let the note below say what happened — the
      // user's input survives, and re-trying is one click away.
      if (webhookWriteRefused) return;
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
      <select
        id="authMethod"
        class="form-input"
        value={apiConfig.authType}
        onchange={updateAuthType}
        disabled={!apiConfig.enabled}
        data-testid="api-auth-method"
      >
        {#each AUTH_TYPES as type (type)}
          <!--
            An unimplemented member stays in the list, greyed and named — removing it would
            hide that the vocabulary declares it, and offering it live would send requests
            with no auth header at all (the defect this replaced). A disabled option is
            skippable by the keyboard, so the reason travels in its own label.
          -->
          <option value={type} disabled={!AUTH_TYPE_INFO[type].implemented}>
            {t(AUTH_TYPE_LABEL_KEY[type])}
          </option>
        {/each}
      </select>
      <p class="help-text">{t("api.authHint")}</p>
    </div>

    {#if !authImplemented}
      <!-- The stored config names a method this build has no flow for. Reachable without this
           screen (a config written by an older build, or by `configure()`), so it must be said
           rather than left to a 401 the user cannot explain. -->
      <p class="help-text" role="status" data-testid="api-auth-unimplemented">
        {t("api.authNotImplemented")}
      </p>
    {/if}

    {#each authFields as field (field)}
      {@const meta = AUTH_FIELD_META[field]}
      <div class="form-group">
        <label for="auth-{field}" class="form-label">{t(meta.labelKey)}</label>
        <div class="token-input-group">
          <input
            id="auth-{field}"
            type={meta.secret && !showTokenPlaintext ? "password" : "text"}
            class="form-input"
            value={authFieldValue(field)}
            oninput={(e) => updateAuthField(field, e)}
            placeholder={t("api.authFieldPlaceholder")}
            disabled={!apiConfig.enabled}
            data-testid="api-auth-field-{field}"
          />
          {#if meta.secret}
            <button
              class="toggle-visibility-btn"
              onclick={toggleTokenVisibility}
              disabled={!apiConfig.enabled}
              aria-label={showTokenPlaintext ? t("api.hideToken") : t("api.showToken")}
            >
              {showTokenPlaintext ? "🙈" : "👁️"}
            </button>
          {/if}
        </div>
      </div>
    {/each}

    {#if apiConfig.enabled && authImplemented && missingAuthFields.length > 0}
      <!--
        The honest reading of "enabled but the credentials are blank": every request will go
        out **unauthenticated**, and the server's 401 is the first the user would hear of it.
        Said here, where the fix is, instead of there.
      -->
      <p class="help-text" role="status" data-testid="api-auth-incomplete">
        {t("api.authIncomplete", {
          fields: missingAuthFields.map((f) => t(AUTH_FIELD_META[f].labelKey)).join("、"),
        })}
      </p>
    {/if}

    <div class="form-row">
      <div class="form-group">
        <label for="timeout" class="form-label">{t("api.timeoutMs")}</label>
        <input
          id="timeout"
          type="number"
          class="form-input"
          value={apiConfig.timeout}
          oninput={updateTimeout}
          onblur={(e) => resyncBoundedNumber("timeout", e)}
          min={API_NUMERIC_RANGES.timeout.min}
          max={API_NUMERIC_RANGES.timeout.max}
          step="1000"
          disabled={!apiConfig.enabled}
        />
        {#if numericRefusal?.key === "timeout"}
          <p class="number-refusal" role="status" data-testid="api-number-refusal">{numericRefusal.message}</p>
        {/if}
      </div>

      <div class="form-group">
        <label for="retryCount" class="form-label">{t("api.retryCount")}</label>
        <input
          id="retryCount"
          type="number"
          class="form-input"
          value={apiConfig.retryCount}
          oninput={updateRetryCount}
          onblur={(e) => resyncBoundedNumber("retryCount", e)}
          min={API_NUMERIC_RANGES.retryCount.min}
          max={API_NUMERIC_RANGES.retryCount.max}
          disabled={!apiConfig.enabled}
        />
        {#if numericRefusal?.key === "retryCount"}
          <p class="number-refusal" role="status" data-testid="api-number-refusal">{numericRefusal.message}</p>
        {/if}
      </div>

      <div class="form-group">
        <label for="retryDelay" class="form-label">{t("api.retryDelayMs")}</label>
        <input
          id="retryDelay"
          type="number"
          class="form-input"
          value={apiConfig.retryDelay}
          oninput={updateRetryDelay}
          onblur={(e) => resyncBoundedNumber("retryDelay", e)}
          min={API_NUMERIC_RANGES.retryDelay.min}
          max={API_NUMERIC_RANGES.retryDelay.max}
          step="500"
          disabled={!apiConfig.enabled}
        />
        {#if numericRefusal?.key === "retryDelay"}
          <p class="number-refusal" role="status" data-testid="api-number-refusal">{numericRefusal.message}</p>
        {/if}
      </div>
    </div>

    <div class="action-buttons">
      <button
        class="btn-secondary"
        data-testid="api-test-connection"
        onclick={testConnection}
        disabled={!apiConfig.enabled || testingConnection}
      >
        {testingConnection ? t("api.testing") : t("api.testConnection")}
      </button>
      <button
        class="btn-primary"
        onclick={saveAPIConfig}
        disabled={!apiConfig.enabled || savingConfig}
        data-testid="api-config-save"
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

    {#if webhookWriteRefused}
      <!--
        The list below is showing webhooks the store did **not** accept: they work for this
        session and are gone at the next launch. Said here, next to the list that lies by
        looking fine, rather than left to a console nobody in the app reads (REQ-A806).
      -->
      <p class="help-text" role="status" data-testid="webhook-write-refused">
        {t("api.webhookSaveRefused")}
      </p>
    {/if}

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
        <button class="btn-primary" onclick={saveWebhook} data-testid="api-webhook-save">
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
    color: rgb(var(--label));
    margin: 0 0 8px 0;
  }

  .subtitle {
    font-size: 14px;
    color: rgb(var(--label-3));
    margin: 0;
  }

  /* 卡片 */
  .card {
    background: rgb(var(--surface));
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
    color: rgb(var(--label));
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
    background-color: rgb(var(--separator));
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
    background-color: rgb(var(--success));
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
    background: rgb(var(--success) / 0.15);
    color: rgb(var(--success));
  }

  .status-message.error {
    background: rgb(var(--danger) / 0.15);
    color: rgb(var(--danger));
  }

  /* 表单 */
  .form-group {
    margin-bottom: 16px;
  }

  .form-label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: rgb(var(--label-2));
    margin-bottom: 8px;
  }

  .form-input {
    width: 100%;
    padding: 12px;
    border: 1px solid rgb(var(--separator));
    border-radius: 8px;
    font-size: 15px;
    background: rgb(var(--surface));
    transition: border-color 0.2s;
  }

  .form-input:focus {
    outline: none;
    border-color: rgb(var(--accent));
  }

  /* 被拒绝的那个数字框下面的那行字（REQ-A821）。 */
  .number-refusal {
    margin: 4px 0 0;
    font-size: 12px;
    color: rgb(var(--danger));
  }

  .form-input:disabled {
    background: rgb(var(--surface-2));
    color: rgb(var(--label-3));
    cursor: not-allowed;
  }

  .help-text {
    font-size: 12px;
    color: rgb(var(--label-3));
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
    background: rgb(var(--accent));
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
    background: rgb(var(--surface-2));
    color: rgb(var(--accent));
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .btn-secondary:hover:not(:disabled) {
    background: rgb(var(--separator));
  }
  }

  .btn-add {
    background: rgb(var(--accent));
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
    background: rgb(var(--surface-2));
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
    color: rgb(var(--label));
  }

  .webhook-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: rgb(var(--accent));
    cursor: pointer;
  }

  .webhook-toggle input {
    width: 16px;
    height: 16px;
    cursor: pointer;
  }

  .webhook-url {
    font-size: 13px;
    color: rgb(var(--label-3));
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
    color: rgb(var(--label-3));
  }

  .info-value {
    color: rgb(var(--label));
  }

  .info-separator {
    color: rgb(var(--separator));
  }

  .webhook-actions {
    display: flex;
    gap: 8px;
  }

  .btn-small {
    padding: 6px 12px;
    border: none;
    background: rgb(var(--surface));
    color: rgb(var(--accent));
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .btn-small:hover:not(:disabled) {
    background: rgb(var(--separator));
  }
  }

  .btn-small.btn-danger {
    color: rgb(var(--danger));
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
    color: rgb(var(--label));
    margin: 0 0 8px 0;
  }

  .empty-text {
    font-size: 14px;
    color: rgb(var(--label-3));
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
    background: rgb(var(--surface));
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
    border-bottom: 1px solid rgb(var(--separator));
  }

  .modal-title {
    font-size: 20px;
    font-weight: 600;
    color: rgb(var(--label));
    margin: 0;
  }

  .close-btn {
    width: 32px;
    height: 32px;
    border: none;
    background: rgb(var(--surface-2));
    color: rgb(var(--label-2));
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
    background: rgb(var(--separator));
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
    background: rgb(var(--surface-2));
    border-radius: 8px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 14px;
    color: rgb(var(--label));
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
    border-top: 1px solid rgb(var(--separator));
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
