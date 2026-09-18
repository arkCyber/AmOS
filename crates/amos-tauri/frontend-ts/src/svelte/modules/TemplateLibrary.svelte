<script lang="ts">
  /**
   * TemplateLibrary.svelte — 企业模板库浏览器
   * 
   * 功能:
   * - 浏览所有企业模板
   * - 按类别、部门筛选
   * - 搜索模板
   * - 查看模板详情
   * - 安装模板
   * - 查看已安装模板
   */

  import { templateManager } from "../../lib/enterprise";
  import type { EnterpriseTemplate } from "../../lib/enterprise/templates";
  import { loadShortcuts } from "../../lib/shortcuts";
  import { t } from "../locale.svelte";
  import { attachFocusTrap } from "../../lib/focusTrap";

  // ============================================================================
  // 状态管理
  // ============================================================================

  let templates = $state<EnterpriseTemplate[]>(templateManager.getTemplates());
  let searchQuery = $state("");
  let selectedCategory = $state<string | undefined>(undefined);
  let selectedDepartment = $state<string | undefined>(undefined);
  let showDetailModal = $state(false);
  let selectedTemplate = $state<EnterpriseTemplate | null>(null);
  let installing = $state(false);
  let parameterValues = $state<Record<string, any>>({});

  /** 详情模态的根元素（焦点陷阱 + Escape 关闭挂在它身上）。 */
  let modalEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!showDetailModal || !modalEl) return;
    return attachFocusTrap(modalEl, closeDetailModal);
  });

  // ============================================================================
  // 计算属性
  // ============================================================================

  const filteredTemplates = $derived(
    templateManager.getTemplates({
      search: searchQuery.trim() || undefined,
      category: selectedCategory,
      department: selectedDepartment,
      status: "published",
    })
  );

  const categories = $derived(
    Array.from(new Set(templates.map(t => t.category))).sort()
  );

  const departments = $derived(
    Array.from(new Set(templates.map(t => t.department).filter(Boolean))).sort()
  );

  // 获取已安装的快捷指令
  const installedShortcuts = $derived(loadShortcuts());

  // ============================================================================
  // 辅助函数
  // ============================================================================

  function getInstallCount(_templateId: string): number {
    // 简化实现：暂不支持安装计数
    return 0;
  }

  function isInstalled(templateId: string): boolean {
    // 检查是否已安装此模板
    return installedShortcuts.some((s: any) => s.templateId === templateId);
  }

  function getCategoryIcon(category: string): string {
    const icons: Record<string, string> = {
      "生产力": "📊",
      "自动化": "⚙️",
      "通讯": "📧",
      "办公": "💼",
      "财务": "💰",
      "人事": "👥",
      "销售": "📈",
      "市场": "📣",
    };
    return icons[category] || "📦";
  }

  // ============================================================================
  // 事件处理
  // ============================================================================

  function openTemplateDetail(template: EnterpriseTemplate) {
    selectedTemplate = template;
    parameterValues = {};
    // 初始化参数默认值
    template.parameters.forEach(param => {
      parameterValues[param.key] = param.defaultValue;
    });
    showDetailModal = true;
  }

  function closeDetailModal() {
    showDetailModal = false;
    selectedTemplate = null;
    parameterValues = {};
  }

  async function installTemplate() {
    if (!selectedTemplate) return;

    // 验证必填参数
    const missingParams = selectedTemplate.parameters
      .filter(p => p.required && !parameterValues[p.key])
      .map(p => p.name);

    if (missingParams.length > 0) {
      alert(t("templates.missingParams", { params: missingParams.join(", ") }));
      return;
    }

    installing = true;
    try {
      const result = await templateManager.installTemplate(
        selectedTemplate.id,
        parameterValues
      );

      if (result.success) {
        alert(t("templates.installSuccess", { id: result.shortcutId ?? "" }));
        closeDetailModal();
        // 刷新模板列表以更新安装数量
        templates = templateManager.getTemplates();
      } else {
        alert(t("templates.installFailed", { reason: result.message ?? t("templates.unknownError") }));
      }
    } catch (error) {
      alert(
        t("templates.installFailed", {
          reason: error instanceof Error ? error.message : t("templates.unknownError"),
        }),
      );
    } finally {
      installing = false;
    }
  }

  function updateParameter(key: string, value: any) {
    parameterValues = { ...parameterValues, [key]: value };
  }

  function resetFilters() {
    searchQuery = "";
    selectedCategory = undefined;
    selectedDepartment = undefined;
  }
</script>

<div class="template-library">
  <header class="library-header">
    <h2>📦 {t("templates.title")}</h2>
    <p class="subtitle">{t("templates.subtitle")}</p>
  </header>

  <!-- 搜索和筛选 -->
  <section class="filters-section">
    <div class="search-box">
      <span class="search-icon">🔍</span>
      <input
        type="text"
        class="search-input"
        placeholder={t("templates.searchPlaceholder")}
        bind:value={searchQuery}
      />
      {#if searchQuery}
        <button class="clear-btn" onclick={() => searchQuery = ""}>×</button>
      {/if}
    </div>

    <div class="filter-row">
      <select
        class="filter-select"
        value={selectedCategory || ""}
        onchange={(e) => selectedCategory = (e.target as HTMLSelectElement).value || undefined}
      >
        <option value="">{t("templates.allCategories")}</option>
        {#each categories as category}
          <option value={category}>{getCategoryIcon(category)} {category}</option>
        {/each}
      </select>

      <select
        class="filter-select"
        value={selectedDepartment || ""}
        onchange={(e) => selectedDepartment = (e.target as HTMLSelectElement).value || undefined}
      >
        <option value="">{t("templates.allDepartments")}</option>
        {#each departments as dept}
          <option value={dept}>{dept}</option>
        {/each}
      </select>

      {#if searchQuery || selectedCategory || selectedDepartment}
        <button class="reset-filters-btn" onclick={resetFilters}>
          {t("templates.resetFilters")}
        </button>
      {/if}
    </div>

    <div class="results-count">
      {t("templates.foundCount", { count: filteredTemplates.length })}
    </div>
  </section>

  <!-- 模板网格 -->
  <section class="templates-grid">
    {#if filteredTemplates.length === 0}
      <div class="empty-state">
        <div class="empty-icon">📦</div>
        <p class="empty-title">{t("templates.emptyTitle")}</p>
        <p class="empty-text">{t("templates.emptyHint")}</p>
      </div>
    {:else}
      {#each filteredTemplates as template}
        <button
          class="template-card"
          onclick={() => openTemplateDetail(template)}
        >
          <div class="card-header">
            <span class="card-icon">{getCategoryIcon(template.category)}</span>
            {#if template.isForced}
              <span class="badge badge-required">{t("templates.badgeRequired")}</span>
            {/if}
            {#if isInstalled(template.id)}
              <span class="badge badge-installed">{t("templates.badgeInstalled")}</span>
            {/if}
          </div>
          
          <h3 class="card-title">{template.name}</h3>
          <p class="card-description">{template.description}</p>
          
          <div class="card-meta">
            <span class="meta-item">
              <span class="meta-icon">📊</span>
              {t("templates.version", { version: template.version })}
            </span>
            <span class="meta-item">
              <span class="meta-icon">👥</span>
              {t("templates.installCount", { count: getInstallCount(template.id) })}
            </span>
          </div>
          
          <div class="card-footer">
            <span class="category-tag">{template.category}</span>
            {#if template.department}
              <span class="department-tag">{template.department}</span>
            {/if}
          </div>
        </button>
      {/each}
    {/if}
  </section>
</div>

<!-- 模板详情模态框 -->
{#if showDetailModal && selectedTemplate}
  <!-- 遮罩是**内容后面的一枚真按钮**：自己可点、可聚焦、有名字（点它 = 关闭），
       于是内容不再需要 `stopPropagation`（点击内容根本到不了遮罩），
       Escape 与焦点陷阱交给仓库共享的 `attachFocusTrap`（REQ-A386）。 -->
  <div class="modal-overlay">
    <button
      class="modal-backdrop"
      aria-label={t("templates.close")}
      onclick={closeDetailModal}
    ></button>
    <div
      class="modal-content"
      bind:this={modalEl}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tpl-modal-title"
      tabindex="-1"
    >
      <header class="modal-header">
        <div class="modal-title-row">
          <span class="modal-icon">{getCategoryIcon(selectedTemplate.category)}</span>
          <h3 id="tpl-modal-title" class="modal-title">{selectedTemplate.name}</h3>
        </div>
        <button class="close-btn" onclick={closeDetailModal} aria-label={t("templates.close")}>×</button>
      </header>

      <div class="modal-body">
        <!-- 基本信息 -->
        <section class="info-section">
          <div class="info-row">
            <span class="info-label">{t("templates.versionLabel")}</span>
            <span class="info-value">{selectedTemplate.version}</span>
          </div>
          <div class="info-row">
            <span class="info-label">{t("templates.categoryLabel")}</span>
            <span class="info-value">{selectedTemplate.category}</span>
          </div>
          {#if selectedTemplate.department}
            <div class="info-row">
              <span class="info-label">{t("templates.departmentLabel")}</span>
              <span class="info-value">{selectedTemplate.department}</span>
            </div>
          {/if}
          <div class="info-row">
            <span class="info-label">{t("templates.installCountLabel")}</span>
            <span class="info-value">{getInstallCount(selectedTemplate.id)}</span>
          </div>
        </section>

        <!-- 描述 -->
        <section class="description-section">
          <h4 class="section-title">{t("templates.descriptionLabel")}</h4>
          <p class="description-text">{selectedTemplate.description}</p>
        </section>

        <!-- 参数配置 -->
        {#if selectedTemplate.parameters.length > 0}
          <section class="parameters-section">
            <h4 class="section-title">{t("templates.parametersTitle")}</h4>
            <div class="parameter-list">
              {#each selectedTemplate.parameters as param}
                <div class="parameter-item">
                  <label for={`tpl-param-${param.key}`} class="parameter-label">
                    {param.name}
                    {#if param.required}
                      <span class="required-mark">*</span>
                    {/if}
                  </label>
                  
                  {#if param.type === "text"}
                    <input
                      id={`tpl-param-${param.key}`}
                      type="text"
                      class="parameter-input"
                      value={parameterValues[param.key] || ""}
                      oninput={(e) => updateParameter(param.key, (e.target as HTMLInputElement).value)}
                      placeholder={param.description}
                    />
                  {:else if param.type === "number"}
                    <input
                      id={`tpl-param-${param.key}`}
                      type="number"
                      class="parameter-input"
                      value={parameterValues[param.key] || ""}
                      oninput={(e) => updateParameter(param.key, parseFloat((e.target as HTMLInputElement).value))}
                      placeholder={param.description}
                    />
                  {:else if param.type === "url"}
                    <input
                      id={`tpl-param-${param.key}`}
                      type="url"
                      class="parameter-input"
                      value={parameterValues[param.key] || ""}
                      oninput={(e) => updateParameter(param.key, (e.target as HTMLInputElement).value)}
                      placeholder={param.description}
                    />
                  {:else if param.type === "boolean"}
                    <label class="checkbox-label">
                      <input
                        id={`tpl-param-${param.key}`}
                        type="checkbox"
                        checked={parameterValues[param.key] || false}
                        onchange={(e) => updateParameter(param.key, (e.target as HTMLInputElement).checked)}
                      />
                      <span>{param.description}</span>
                    </label>
                  {:else if param.type === "select" && param.options}
                    <select
                      id={`tpl-param-${param.key}`}
                      class="parameter-select"
                      value={parameterValues[param.key] || ""}
                      onchange={(e) => updateParameter(param.key, (e.target as HTMLSelectElement).value)}
                    >
                      <option value="">{t("templates.selectPlaceholder")}</option>
                      {#each param.options as option}
                        <option value={option}>{option}</option>
                      {/each}
                    </select>
                  {/if}
                  
                  {#if param.description}
                    <p class="parameter-help">{param.description}</p>
                  {/if}
                </div>
              {/each}
            </div>
          </section>
        {/if}

        <!-- 快捷指令信息 -->
        <section class="shortcut-info-section">
          <div class="info-row">
            <span class="info-icon">⚙️</span>
            <span>包含 {selectedTemplate.shortcutData.actions.length} 个动作</span>
          </div>
          <div class="info-row">
            <span class="info-icon">⏱️</span>
            <span>预计耗时 ~{Math.ceil(selectedTemplate.shortcutData.actions.length * 0.4)} 分钟</span>
          </div>
        </section>
      </div>

      <footer class="modal-footer">
        <button class="btn-secondary" onclick={closeDetailModal}>
          {t("templates.cancel")}
        </button>
        <button
          class="btn-primary"
          onclick={installTemplate}
          disabled={installing}
        >
          {installing ? t("templates.installing") : t("templates.install")}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .template-library {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px;
  }

  .library-header {
    margin-bottom: 24px;
  }

  .library-header h2 {
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

  /* 搜索和筛选 */
  .filters-section {
    background: #fff;
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 24px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .search-box {
    position: relative;
    margin-bottom: 16px;
  }

  .search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 18px;
  }

  .search-input {
    width: 100%;
    padding: 12px 40px 12px 40px;
    border: 1px solid #E5E5EA;
    border-radius: 8px;
    font-size: 15px;
    background: #F2F2F7;
  }

  .search-input:focus {
    outline: none;
    border-color: #007AFF;
    background: #fff;
  }

  .clear-btn {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    width: 24px;
    height: 24px;
    border: none;
    background: #8E8E93;
    color: white;
    border-radius: 50%;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .filter-row {
    display: flex;
    gap: 12px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .filter-select {
    flex: 1;
    min-width: 150px;
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

  .reset-filters-btn {
    padding: 10px 16px;
    border: none;
    background: #F2F2F7;
    color: #007AFF;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .reset-filters-btn:hover {
    background: #E5E5EA;
  }
  }

  .results-count {
    font-size: 13px;
    color: #8E8E93;
  }

  /* 模板网格 */
  .templates-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
  }

  .template-card {
    background: #fff;
    border: 1px solid #E5E5EA;
    border-radius: 12px;
    padding: 16px;
    text-align: left;
    cursor: pointer;
    transition: all 0.2s;
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .template-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    border-color: #007AFF;
  }
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }

  .card-icon {
    font-size: 32px;
  }

  .badge {
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    margin-left: auto;
  }

  .badge-required {
    background: #FFE5E5;
    color: #FF3B30;
  }

  .badge-installed {
    background: #E5F7ED;
    color: #34C759;
  }

  .card-title {
    font-size: 17px;
    font-weight: 600;
    color: #000;
    margin: 0 0 8px 0;
  }

  .card-description {
    font-size: 14px;
    color: #3C3C43;
    margin: 0 0 12px 0;
    line-height: 1.4;
    display: -webkit-box;
    /* 标准属性也要写：只写 `-webkit-` 版本时，非 WebKit 引擎（以及未来的
       WebKit）会忽略它，截断就静默失效（svelte-check 的兼容性判据）。 */
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .card-meta {
    display: flex;
    gap: 16px;
    margin-bottom: 12px;
    font-size: 13px;
    color: #8E8E93;
  }

  .meta-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .meta-icon {
    font-size: 14px;
  }

  .card-footer {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .category-tag,
  .department-tag {
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
  }

  .category-tag {
    background: #E5F1FF;
    color: #007AFF;
  }

  .department-tag {
    background: #F2F2F7;
    color: #3C3C43;
  }

  /* 空状态 */
  .empty-state {
    grid-column: 1 / -1;
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

  /* 遮罩层：一枚铺满的真按钮（背景在这里，不在 overlay 上）。 */
  .modal-backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    cursor: pointer;
    background: rgba(0, 0, 0, 0.5);
  }

  .modal-content {
    position: relative; /* 盖在遮罩之上（同层内后出现的元素在上） */
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

  .modal-title-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .modal-icon {
    font-size: 28px;
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

  .section-title {
    font-size: 15px;
    font-weight: 600;
    color: #000;
    margin: 0 0 12px 0;
  }

  .info-section {
    margin-bottom: 20px;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid #F2F2F7;
  }

  .info-row:last-child {
    border-bottom: none;
  }

  .info-label {
    font-size: 14px;
    color: #8E8E93;
  }

  .info-value {
    font-size: 14px;
    color: #000;
    font-weight: 500;
  }

  .description-section {
    margin-bottom: 20px;
  }

  .description-text {
    font-size: 14px;
    color: #3C3C43;
    line-height: 1.6;
    margin: 0;
  }

  .parameters-section {
    margin-bottom: 20px;
  }

  .parameter-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .parameter-item {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .parameter-label {
    font-size: 14px;
    font-weight: 500;
    color: #000;
  }

  .required-mark {
    color: #FF3B30;
  }

  .parameter-input,
  .parameter-select {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #E5E5EA;
    border-radius: 8px;
    font-size: 14px;
  }

  .parameter-input:focus,
  .parameter-select:focus {
    outline: none;
    border-color: #007AFF;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 14px;
    color: #3C3C43;
  }

  .checkbox-label input {
    width: 18px;
    height: 18px;
    cursor: pointer;
  }

  .parameter-help {
    font-size: 12px;
    color: #8E8E93;
    margin: 0;
  }

  .shortcut-info-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    background: #F2F2F7;
    border-radius: 8px;
  }

  .info-icon {
    margin-right: 4px;
  }

  .modal-footer {
    display: flex;
    gap: 12px;
    padding: 20px;
    border-top: 1px solid #E5E5EA;
  }

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

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .btn-primary:hover:not(:disabled) {
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
    .template-library {
      padding: 16px;
    }

    .templates-grid {
      grid-template-columns: 1fr;
    }

    .modal-content {
      max-height: 100vh;
      border-radius: 0;
    }

    .filter-row {
      flex-direction: column;
    }

    .filter-select {
      width: 100%;
    }
  }
</style>
