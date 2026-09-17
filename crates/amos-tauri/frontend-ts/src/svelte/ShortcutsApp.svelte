<script lang="ts">
  /**
   * ShortcutsApp.svelte — iOS-style Shortcuts automation app (Phase 2)
   * 
   * 功能:
   * - 快捷指令列表与管理
   * - 可视化流程编辑器
   * - 操作库浏览
   * - 快速运行
   * - 搜索与筛选
   * - 文件夹组织
   * 
   * Phase 2 新增:
   * - 拖拽排序操作
   * - 实时预览执行流程
   * - 虚拟滚动优化
   * - 全局快捷键支持
   */
  
  import { onMount, onDestroy } from "svelte";
  import { t } from "./locale.svelte";
  import {
    loadShortcuts,
    createShortcut,
    deleteShortcut,
    duplicateShortcut,
    executeShortcut,
    updateShortcut,
    SHORTCUT_COLORS,
    SHORTCUT_ICONS,
    BUILTIN_ACTIONS,
    getActionsByCategory,
    type Shortcut,
    type ActionCategory,
    type ActionType,
    type ActionInstance,
  } from "../lib/shortcuts";

  // ============================================================================
  // 状态管理
  // ============================================================================
  
  let shortcuts = $state<Shortcut[]>(loadShortcuts());
  let selectedShortcut = $state<Shortcut | null>(null);
  let searchQuery = $state("");
  let view = $state<"list" | "editor" | "gallery">("list");
  let showNewModal = $state(false);
  let showActionPicker = $state(false);
  let selectedCategory = $state<ActionCategory | "all">("all");
  
  // 新建快捷指令表单
  let newName = $state("");
  let newIcon = $state(SHORTCUT_ICONS[0]);
  let newColor = $state(SHORTCUT_COLORS[0]);
  
  // 执行状态
  let executing = $state(false);
  let executionResult = $state<string | null>(null);
  
  // Phase 2: 拖拽状态
  let draggedActionId = $state<string | null>(null);
  let dragOverActionId = $state<string | null>(null);
  
  // Phase 2: 实时预览状态
  let showPreview = $state(false);
  let previewStep = $state(0);
  let previewResults = $state<Array<{ actionId: string; result: string }>>([]);
  
  // Phase 2: 虚拟滚动状态
  let scrollContainer: HTMLDivElement | null = null;
  let visibleRange = $state({ start: 0, end: 20 });
  const ITEM_HEIGHT = 120; // 每个快捷指令卡片的高度
  const BUFFER = 5; // 缓冲区项目数
  
  // ============================================================================
  // 计算属性
  // ============================================================================
  
  const filteredShortcuts = $derived(
    searchQuery.trim()
      ? shortcuts.filter((s) =>
          s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()))
        )
      : shortcuts
  );
  
  // Phase 2: 虚拟滚动 - 只渲染可见范围的项目
  const visibleShortcuts = $derived(
    filteredShortcuts.slice(visibleRange.start, visibleRange.end)
  );
  
  const actionCategories: Array<{ id: ActionCategory | "all"; name: string; icon: string }> = [
    { id: "all", name: "全部", icon: "📱" },
    { id: "apps", name: "应用", icon: "📱" },
    { id: "scripting", name: "脚本", icon: "⚙️" },
    { id: "web", name: "网页", icon: "🌐" },
    { id: "text", name: "文本", icon: "📝" },
    { id: "device", name: "设备", icon: "📱" },
    { id: "math", name: "数学", icon: "🧮" },
    { id: "date", name: "日期", icon: "📅" },
  ];
  
  const availableActions = $derived(
    selectedCategory === "all"
      ? BUILTIN_ACTIONS
      : getActionsByCategory(selectedCategory)
  );
  
  // ============================================================================
  // Phase 2: 生命周期和事件监听
  // ============================================================================
  
  onMount(() => {
    // 注册全局快捷键
    window.addEventListener("keydown", handleGlobalKeydown);
    
    // 虚拟滚动事件监听
    if (scrollContainer) {
      scrollContainer.addEventListener("scroll", handleScroll);
    }
  });
  
  onDestroy(() => {
    window.removeEventListener("keydown", handleGlobalKeydown);
    
    if (scrollContainer) {
      scrollContainer.removeEventListener("scroll", handleScroll);
    }
  });
  
  // ============================================================================
  // Phase 2: 快捷键处理
  // ============================================================================
  
  function handleGlobalKeydown(e: KeyboardEvent) {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;
    
    // Cmd/Ctrl + N: 新建快捷指令
    if (cmdOrCtrl && e.key === "n" && view === "list") {
      e.preventDefault();
      showNewModal = true;
      return;
    }
    
    // Cmd/Ctrl + F: 聚焦搜索框
    if (cmdOrCtrl && e.key === "f" && view === "list") {
      e.preventDefault();
      document.querySelector<HTMLInputElement>('input[type="text"]')?.focus();
      return;
    }
    
    // Cmd/Ctrl + K: 打开操作选择器（编辑器模式）
    if (cmdOrCtrl && e.key === "k" && view === "editor") {
      e.preventDefault();
      showActionPicker = true;
      return;
    }
    
    // Escape: 关闭模态框
    if (e.key === "Escape") {
      if (showNewModal) {
        showNewModal = false;
      } else if (showActionPicker) {
        showActionPicker = false;
      } else if (showPreview) {
        showPreview = false;
      } else if (view === "editor") {
        view = "list";
        selectedShortcut = null;
      }
      return;
    }
    
    // Cmd/Ctrl + Enter: 运行快捷指令（编辑器模式）
    if (cmdOrCtrl && e.key === "Enter" && view === "editor" && selectedShortcut) {
      e.preventDefault();
      handleRun(selectedShortcut.id);
      return;
    }
    
    // Cmd/Ctrl + S: 保存并返回（编辑器模式）
    if (cmdOrCtrl && e.key === "s" && view === "editor") {
      e.preventDefault();
      view = "list";
      selectedShortcut = null;
      return;
    }
    
    // Cmd/Ctrl + D: 复制当前快捷指令（编辑器模式）
    if (cmdOrCtrl && e.key === "d" && view === "editor" && selectedShortcut) {
      e.preventDefault();
      handleDuplicate(selectedShortcut.id);
      return;
    }
    
    // Cmd/Ctrl + Shift + P: 显示实时预览
    if (cmdOrCtrl && e.shiftKey && e.key === "P" && view === "editor" && selectedShortcut) {
      e.preventDefault();
      togglePreview();
      return;
    }
  }
  
  // ============================================================================
  // Phase 2: 虚拟滚动处理
  // ============================================================================
  
  function handleScroll() {
    if (!scrollContainer) return;
    
    const scrollTop = scrollContainer.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER);
    const end = Math.min(
      filteredShortcuts.length,
      Math.ceil((scrollTop + scrollContainer.clientHeight) / ITEM_HEIGHT) + BUFFER
    );
    
    visibleRange = { start, end };
  }
  
  // ============================================================================
  // Phase 2: 拖拽处理
  // ============================================================================
  
  function handleDragStart(actionId: string, e: DragEvent) {
    draggedActionId = actionId;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", actionId);
    }
  }
  
  function handleDragOver(actionId: string, e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    dragOverActionId = actionId;
  }
  
  function handleDragLeave() {
    dragOverActionId = null;
  }
  
  function handleDrop(targetActionId: string, e: DragEvent) {
    e.preventDefault();
    
    if (!selectedShortcut || !draggedActionId || draggedActionId === targetActionId) {
      draggedActionId = null;
      dragOverActionId = null;
      return;
    }
    
    const actions = [...selectedShortcut.actions];
    const draggedIndex = actions.findIndex((a) => a.id === draggedActionId);
    const targetIndex = actions.findIndex((a) => a.id === targetActionId);
    
    if (draggedIndex === -1 || targetIndex === -1) {
      draggedActionId = null;
      dragOverActionId = null;
      return;
    }
    
    // 移动操作
    const [draggedAction] = actions.splice(draggedIndex, 1);
    if (!draggedAction) return;
    actions.splice(targetIndex, 0, draggedAction);
    
    // 更新 position
    actions.forEach((a, i) => {
      a.position = i;
    });
    
    const updated = {
      ...selectedShortcut,
      actions,
    };
    
    if (updateShortcut(selectedShortcut.id, updated)) {
      selectedShortcut = updated;
      refreshShortcuts();
    }
    
    draggedActionId = null;
    dragOverActionId = null;
  }
  
  function handleDragEnd() {
    draggedActionId = null;
    dragOverActionId = null;
  }
  
  // ============================================================================
  // Phase 2: 实时预览
  // ============================================================================
  
  function togglePreview() {
    showPreview = !showPreview;
    if (showPreview) {
      startPreview();
    } else {
      stopPreview();
    }
  }
  
  async function startPreview() {
    if (!selectedShortcut) return;
    
    previewStep = 0;
    previewResults = [];
    
    // 模拟逐步执行每个操作
    for (let i = 0; i < selectedShortcut.actions.length; i++) {
      previewStep = i;
      await new Promise((resolve) => setTimeout(resolve, 800));
      
      const action = selectedShortcut.actions[i];
      if (!action) continue;
      const actionType = BUILTIN_ACTIONS.find((a) => a.id === action.actionTypeId);
      
      if (actionType) {
        previewResults.push({
          actionId: action.id,
          result: `✓ ${actionType.name} 完成`,
        });
      }
    }
    
    previewStep = selectedShortcut.actions.length;
  }
  
  function stopPreview() {
    previewStep = 0;
    previewResults = [];
  }
  
  // ============================================================================
  // 原有操作函数
  // ============================================================================
  
  function refreshShortcuts() {
    shortcuts = loadShortcuts();
  }
  
  function handleCreate() {
    if (!newName.trim()) {
      alert(t("shortcuts.alerts.enterName"));
      return;
    }
    
    const shortcut = createShortcut(newName.trim(), {
      icon: newIcon,
      color: newColor,
    });
    
    if (shortcut) {
      refreshShortcuts();
      selectedShortcut = shortcut;
      view = "editor";
      showNewModal = false;
      newName = "";
    } else {
      alert(t("shortcuts.createFailed"));
    }
  }
  
  function handleDelete(id: string) {
    if (!confirm(t("shortcuts.deleteConfirm"))) return;
    
    if (deleteShortcut(id)) {
      refreshShortcuts();
      if (selectedShortcut?.id === id) {
        selectedShortcut = null;
        view = "list";
      }
    }
  }
  
  function handleDuplicate(id: string) {
    const duplicate = duplicateShortcut(id);
    if (duplicate) {
      refreshShortcuts();
    }
  }
  
  async function handleRun(id: string) {
    executing = true;
    executionResult = null;
    
    try {
      const result = await executeShortcut(id);
      if (result.success) {
        executionResult = t("shortcuts.executionSuccess", {
          completed: result.actionsCompleted,
          total: result.actionsTotal,
          duration: result.duration
        });
      } else {
        executionResult = t("shortcuts.executionFailed", { error: result.error ?? "Unknown error" });
      }
    } catch (err) {
      executionResult = t("shortcuts.executionError", { error: String(err) });
    } finally {
      executing = false;
      setTimeout(() => {
        executionResult = null;
      }, 3000);
    }
  }
  
  function handleEdit(shortcut: Shortcut) {
    selectedShortcut = shortcut;
    view = "editor";
  }
  
  function handleAddAction(actionType: ActionType) {
    if (!selectedShortcut) return;
    
    const action: ActionInstance = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      actionTypeId: actionType.id,
      parameters: {},
      position: selectedShortcut.actions.length,
    };
    
    // 设置默认参数值
    for (const param of actionType.parameters) {
      if (param.defaultValue !== undefined) {
        action.parameters[param.id] = param.defaultValue;
      }
    }
    
    const updated = {
      ...selectedShortcut,
      actions: [...selectedShortcut.actions, action],
    };
    
    if (updateShortcut(selectedShortcut.id, updated)) {
      selectedShortcut = updated;
      refreshShortcuts();
      showActionPicker = false;
    }
  }
  
  function handleRemoveAction(actionId: string) {
    if (!selectedShortcut) return;
    
    const updated = {
      ...selectedShortcut,
      actions: selectedShortcut.actions.filter((a) => a.id !== actionId),
    };
    
    if (updateShortcut(selectedShortcut.id, updated)) {
      selectedShortcut = updated;
      refreshShortcuts();
    }
  }
  
  function handleMoveAction(actionId: string, direction: "up" | "down") {
    if (!selectedShortcut) return;
    
    const actions = [...selectedShortcut.actions];
    const index = actions.findIndex((a) => a.id === actionId);
    
    if (index === -1) return;
    if (direction === "up" && index === 0) return;
    if (direction === "down" && index === actions.length - 1) return;
    
    const newIndex = direction === "up" ? index - 1 : index + 1;
    const current = actions[index];
    const target = actions[newIndex];
    if (!current || !target) return;
    [actions[index], actions[newIndex]] = [target, current];
    
    // 更新 position
    actions.forEach((a, i) => {
      a.position = i;
    });
    
    const updated = {
      ...selectedShortcut,
      actions,
    };
    
    if (updateShortcut(selectedShortcut.id, updated)) {
      selectedShortcut = updated;
      refreshShortcuts();
    }
  }
  
  function handleUpdateActionParam(actionId: string, paramId: string, value: unknown) {
    if (!selectedShortcut) return;
    
    const actions = selectedShortcut.actions.map((a) => {
      if (a.id === actionId) {
        return {
          ...a,
          parameters: {
            ...a.parameters,
            [paramId]: value,
          },
        };
      }
      return a;
    });
    
    const updated = {
      ...selectedShortcut,
      actions,
    };
    
    if (updateShortcut(selectedShortcut.id, updated)) {
      selectedShortcut = updated;
      refreshShortcuts();
    }
  }
</script>

<!-- 主容器 -->
<div class="flex h-full w-full flex-col bg-neutral-50 dark:bg-neutral-900">
  <!-- 顶部导航栏 -->
  <div class="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950">
    <div class="flex items-center gap-3">
      {#if view === "editor" && selectedShortcut}
        <button
          onclick={() => { view = "list"; selectedShortcut = null; }}
          class="rounded-lg p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          aria-label={t("shortcuts.back")}
          title={t("shortcuts.backWithEsc")}
        >
          <span class="text-lg">←</span>
        </button>
        <span class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          {selectedShortcut.name}
        </span>
      {:else}
        <span class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          {t("app.shortcuts")}
        </span>
      {/if}
    </div>
    
    <div class="flex items-center gap-2">
      {#if view === "list"}
        <button
          onclick={() => { view = "gallery"; }}
          class="rounded-lg px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950"
        >
          {t("shortcuts.gallery")}
        </button>
        <button
          onclick={() => { showNewModal = true; }}
          class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          title={t("shortcuts.newShortcutWithKey")}
        >
          {t("shortcuts.newButton")}
        </button>
      {:else if view === "editor"}
        <!-- Phase 2: 预览按钮 -->
        <button
          onclick={togglePreview}
          class="rounded-lg px-3 py-1.5 text-sm font-medium {showPreview ? 'bg-blue-600 text-white' : 'text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950'}"
          title={t("shortcuts.livePreviewWithKey")}
        >
          {showPreview ? t("shortcuts.previewActive") : t("shortcuts.previewInactive")}
        </button>
        <button
          onclick={() => { showActionPicker = true; }}
          class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          title={t("shortcuts.addActionWithKey")}
        >
          {t("shortcuts.addActionButton")}
        </button>
      {:else if view === "gallery"}
        <button
          onclick={() => { view = "list"; }}
          class="rounded-lg px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950"
        >
          {t("shortcuts.myShortcuts")}
        </button>
      {/if}
    </div>
  </div>

  <!-- Phase 2: 快捷键提示 -->
  {#if view === "editor"}
    <div class="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
      <span class="mr-4"><kbd class="rounded bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-800">⌘K</kbd> {t("shortcuts.addAction")}</span>
      <span class="mr-4"><kbd class="rounded bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-800">⌘⇧P</kbd> {t("shortcuts.preview")}</span>
      <span class="mr-4"><kbd class="rounded bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-800">⌘↵</kbd> {t("shortcuts.run")}</span>
      <span class="mr-4"><kbd class="rounded bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-800">⌘S</kbd> {t("shortcuts.save")}</span>
      <span><kbd class="rounded bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-800">{t("shortcuts.keyboardHint.esc")}</kbd> {t("shortcuts.back")}</span>
    </div>
  {/if}

  <!-- 内容区域 -->
  <div class="flex-1 overflow-y-auto" bind:this={scrollContainer}>
    {#if view === "list"}
      <!-- 搜索栏 -->
      <div class="sticky top-0 z-10 bg-neutral-50 px-4 py-3 dark:bg-neutral-900">
        <input
          type="text"
          bind:value={searchQuery}
          placeholder={t("shortcuts.searchWithKey")}
          class="w-full rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm placeholder-neutral-400 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
        />
      </div>

      <!-- Phase 2: 虚拟滚动列表 -->
      <div 
        class="relative px-4 pb-4"
        style="min-height: {filteredShortcuts.length * ITEM_HEIGHT}px;"
      >
        {#if filteredShortcuts.length === 0}
          <div class="flex flex-col items-center justify-center py-20 text-center">
            <div class="mb-4 text-6xl">⚡</div>
            <p class="mb-2 text-lg font-medium text-neutral-900 dark:text-neutral-100">
              {searchQuery ? t("shortcuts.notFound") : t("shortcuts.noShortcuts")}
            </p>
            <p class="text-sm text-neutral-500 dark:text-neutral-400">
              {searchQuery ? t("shortcuts.tryOtherKeywords") : t("shortcuts.clickNewToStart")}
            </p>
          </div>
        {:else}
          <div style="padding-top: {visibleRange.start * ITEM_HEIGHT}px;">
            {#each visibleShortcuts as shortcut (shortcut.id)}
              <div
                class="group relative mb-2 rounded-xl border border-neutral-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-neutral-800 dark:bg-neutral-950"
                style="border-left: 4px solid {shortcut.color};"
              >
                <div class="flex items-start gap-3">
                  <!-- 图标 -->
                  <div
                    class="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl text-2xl"
                    style="background-color: {shortcut.color}20;"
                  >
                    {shortcut.icon}
                  </div>
                  
                  <!-- 信息 -->
                  <div class="min-w-0 flex-1">
                    <h3 class="truncate text-base font-semibold text-neutral-900 dark:text-neutral-100">
                      {shortcut.name}
                    </h3>
                    {#if shortcut.description}
                      <p class="mt-1 truncate text-sm text-neutral-600 dark:text-neutral-400">
                        {shortcut.description}
                      </p>
                    {/if}
                    <div class="mt-2 flex items-center gap-4 text-xs text-neutral-500 dark:text-neutral-500">
                      <span>{t("shortcuts.actionsCount", { count: shortcut.actions.length })}</span>
                      <span>{t("shortcuts.runCount", { count: shortcut.runCount })}</span>
                    </div>
                    {#if shortcut.tags.length > 0}
                      <div class="mt-2 flex flex-wrap gap-1">
                        {#each shortcut.tags as tag}
                          <span class="rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                            {tag}
                          </span>
                        {/each}
                      </div>
                    {/if}
                  </div>
                  
                  <!-- 操作按钮 -->
                  <div class="flex flex-shrink-0 gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      onclick={() => handleRun(shortcut.id)}
                      disabled={executing}
                      class="rounded-lg p-2 hover:bg-blue-50 dark:hover:bg-blue-950"
                      aria-label={t("shortcuts.run")}
                      title={t("shortcuts.run")}
                    >
                      <span class="text-lg text-blue-600 dark:text-blue-400">▶️</span>
                    </button>
                    <button
                      onclick={() => handleEdit(shortcut)}
                      class="rounded-lg p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      aria-label={t("shortcuts.edit")}
                      title={t("shortcuts.edit")}
                    >
                      <span class="text-lg">✏️</span>
                    </button>
                    <button
                      onclick={() => handleDuplicate(shortcut.id)}
                      class="rounded-lg p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      aria-label={t("shortcuts.duplicate")}
                      title={t("shortcuts.duplicateWithKey")}
                    >
                      <span class="text-lg">📋</span>
                    </button>
                    <button
                      onclick={() => handleDelete(shortcut.id)}
                      class="rounded-lg p-2 hover:bg-red-50 dark:hover:bg-red-950"
                      aria-label={t("shortcuts.delete")}
                      title={t("shortcuts.delete")}
                    >
                      <span class="text-lg text-red-600 dark:text-red-400">🗑️</span>
                    </button>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {:else if view === "editor" && selectedShortcut}
      <!-- 编辑器 -->
      <div class="flex h-full">
        <!-- 左侧：编辑区 -->
        <div class="flex-1 space-y-4 overflow-y-auto p-4">
          <!-- 基本信息 -->
          <div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
            <h3 class="mb-3 text-sm font-semibold text-neutral-700 dark:text-neutral-300">{t("shortcuts.basicInfo")}</h3>
            <div class="space-y-3">
              <div>
                <label class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">{t("shortcuts.name")}</label>
                <input
                  type="text"
                  value={selectedShortcut.name}
                  oninput={(e) => updateShortcut(selectedShortcut!.id, { name: e.currentTarget.value })}
                  class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                />
              </div>
              <div>
                <label class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">{t("shortcuts.description")}</label>
                <textarea
                  value={selectedShortcut.description}
                  oninput={(e) => updateShortcut(selectedShortcut!.id, { description: e.currentTarget.value })}
                  rows="2"
                  class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                ></textarea>
              </div>
              <div class="flex gap-3">
                <div class="flex-1">
                  <label class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">{t("shortcuts.icon")}</label>
                  <select
                    value={selectedShortcut.icon}
                    onchange={(e) => updateShortcut(selectedShortcut!.id, { icon: e.currentTarget.value })}
                    class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                  >
                    {#each SHORTCUT_ICONS as icon}
                      <option value={icon}>{icon}</option>
                    {/each}
                  </select>
                </div>
                <div class="flex-1">
                  <label class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">{t("shortcuts.color")}</label>
                  <select
                    value={selectedShortcut.color}
                    onchange={(e) => updateShortcut(selectedShortcut!.id, { color: e.currentTarget.value })}
                    class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                  >
                    {#each SHORTCUT_COLORS as color}
                      <option value={color} style="color: {color};">● {color}</option>
                    {/each}
                  </select>
                </div>
              </div>
            </div>
          </div>

          <!-- Phase 2: 拖拽操作列表 -->
          <div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
            <div class="mb-3 flex items-center justify-between">
              <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">{t("shortcuts.actionFlow")}</h3>
              <span class="text-xs text-neutral-500 dark:text-neutral-400">{t("shortcuts.dragToReorder")}</span>
            </div>
            
            {#if selectedShortcut.actions.length === 0}
              <div class="flex flex-col items-center justify-center py-10 text-center">
                <div class="mb-3 text-4xl">⚙️</div>
                <p class="text-sm text-neutral-500 dark:text-neutral-400">
                  {t("shortcuts.noActionsYet")}
                </p>
              </div>
            {:else}
              <div class="space-y-2">
                {#each selectedShortcut.actions as action, index (action.id)}
                  {@const actionType = BUILTIN_ACTIONS.find(a => a.id === action.actionTypeId)}
                  {#if actionType}
                    <div
                      draggable="true"
                      ondragstart={(e) => handleDragStart(action.id, e)}
                      ondragover={(e) => handleDragOver(action.id, e)}
                      ondragleave={handleDragLeave}
                      ondrop={(e) => handleDrop(action.id, e)}
                      ondragend={handleDragEnd}
                      class="group cursor-move rounded-lg border p-3 transition-all {
                        draggedActionId === action.id
                          ? 'border-blue-500 bg-blue-50 opacity-50 dark:bg-blue-950'
                          : dragOverActionId === action.id
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                          : 'border-neutral-200 bg-neutral-50 hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-neutral-600'
                      }"
                    >
                      <div class="flex items-start gap-3">
                        <!-- 拖拽手柄 -->
                        <div class="flex-shrink-0 cursor-grab pt-1 text-neutral-400 active:cursor-grabbing">
                          ⋮⋮
                        </div>
                        
                        <div class="flex-shrink-0 text-2xl">{actionType.icon}</div>
                        <div class="min-w-0 flex-1">
                          <div class="mb-2 flex items-center justify-between">
                            <span class="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                              {index + 1}. {actionType.name}
                            </span>
                            <div class="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                              {#if index > 0}
                                <button
                                  onclick={() => handleMoveAction(action.id, "up")}
                                  class="rounded p-1 hover:bg-neutral-200 dark:hover:bg-neutral-800"
                                  aria-label={t("shortcuts.moveUp")}
                                  title={t("shortcuts.moveUp")}
                                >
                                  <span class="text-xs">↑</span>
                                </button>
                              {/if}
                              {#if index < selectedShortcut.actions.length - 1}
                                <button
                                  onclick={() => handleMoveAction(action.id, "down")}
                                  class="rounded p-1 hover:bg-neutral-200 dark:hover:bg-neutral-800"
                                  aria-label={t("shortcuts.moveDown")}
                                  title={t("shortcuts.moveDown")}
                                >
                                  <span class="text-xs">↓</span>
                                </button>
                              {/if}
                              <button
                                onclick={() => handleRemoveAction(action.id)}
                                class="rounded p-1 hover:bg-red-100 dark:hover:bg-red-950"
                                aria-label={t("shortcuts.delete")}
                                title={t("shortcuts.delete")}
                              >
                                <span class="text-xs text-red-600 dark:text-red-400">×</span>
                              </button>
                            </div>
                          </div>
                          
                          <!-- 参数输入 -->
                          {#if actionType.parameters.length > 0}
                            <div class="space-y-2">
                              {#each actionType.parameters as param}
                                <div>
                                  <label class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">
                                    {param.name}
                                    {#if param.required}
                                      <span class="text-red-500">*</span>
                                    {/if}
                                  </label>
                                  {#if param.type === "text"}
                                    <input
                                      type="text"
                                      value={action.parameters[param.id] ?? ""}
                                      oninput={(e) => handleUpdateActionParam(action.id, param.id, e.currentTarget.value)}
                                      placeholder={param.placeholder}
                                      class="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-white"
                                    />
                                  {:else if param.type === "number"}
                                    <input
                                      type="number"
                                      value={action.parameters[param.id] ?? ""}
                                      oninput={(e) => handleUpdateActionParam(action.id, param.id, Number(e.currentTarget.value))}
                                      class="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-white"
                                    />
                                  {:else if param.type === "select" && param.options}
                                    <select
                                      value={action.parameters[param.id] ?? param.defaultValue}
                                      onchange={(e) => handleUpdateActionParam(action.id, param.id, e.currentTarget.value)}
                                      class="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-white"
                                    >
                                      {#each param.options as option}
                                        <option value={option.value}>{option.label}</option>
                                      {/each}
                                    </select>
                                  {/if}
                                </div>
                              {/each}
                            </div>
                          {/if}
                        </div>
                      </div>
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>

          <!-- 快速运行按钮 -->
          <button
            onclick={() => handleRun(selectedShortcut!.id)}
            disabled={executing || selectedShortcut.actions.length === 0}
            class="w-full rounded-xl bg-blue-600 py-3 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            title={t("shortcuts.runWithKey")}
          >
            {executing ? t("shortcuts.running") : t("shortcuts.runShortcut")}
          </button>
        </div>

        <!-- Phase 2: 右侧实时预览面板 -->
        {#if showPreview}
          <div class="w-80 border-l border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
            <div class="mb-4 flex items-center justify-between">
              <h3 class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t("shortcuts.livePreviewTitle")}</h3>
              <button
                onclick={togglePreview}
                class="rounded p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                aria-label={t("shortcuts.closePreviewWithKey")}
              >
                <span class="text-sm">×</span>
              </button>
            </div>

            {#if selectedShortcut.actions.length === 0}
              <div class="flex flex-col items-center justify-center py-10 text-center">
                <div class="mb-3 text-3xl">👁</div>
                <p class="text-xs text-neutral-500 dark:text-neutral-400">
                  {t("shortcuts.addActionsToPreview")}
                </p>
              </div>
            {:else}
              <div class="space-y-2">
                {#each selectedShortcut.actions as action, index (action.id)}
                  {@const actionType = BUILTIN_ACTIONS.find(a => a.id === action.actionTypeId)}
                  {@const isActive = index === previewStep}
                  {@const isCompleted = index < previewStep}
                  {@const result = previewResults.find(r => r.actionId === action.id)}
                  
                  {#if actionType}
                    <div
                      class="rounded-lg border p-3 text-xs {
                        isActive
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                          : isCompleted
                          ? 'border-green-500 bg-green-50 dark:bg-green-950'
                          : 'border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900'
                      }"
                    >
                      <div class="flex items-start gap-2">
                        <div class="flex-shrink-0 text-lg">{actionType.icon}</div>
                        <div class="min-w-0 flex-1">
                          <div class="font-medium text-neutral-900 dark:text-neutral-100">
                            {index + 1}. {actionType.name}
                          </div>
                          {#if result}
                            <div class="mt-1 text-green-600 dark:text-green-400">
                              {result.result}
                            </div>
                          {/if}
                          {#if isActive}
                            <div class="mt-1 text-blue-600 dark:text-blue-400">
                              {t("shortcuts.executing")}
                            </div>
                          {/if}
                        </div>
                        {#if isCompleted}
                          <span class="text-green-600 dark:text-green-400">✓</span>
                        {/if}
                      </div>
                    </div>
                  {/if}
                {/each}
              </div>

              {#if previewStep === selectedShortcut.actions.length}
                <div class="mt-4 rounded-lg bg-green-50 p-3 text-center text-xs text-green-600 dark:bg-green-950 dark:text-green-400">
                  ✓ {t("shortcuts.previewComplete")}
                </div>
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    {:else if view === "gallery"}
      <!-- 快捷指令库 -->
      <div class="space-y-4 p-4">
        <div class="text-center">
          <div class="mb-4 text-6xl">📚</div>
          <h2 class="mb-2 text-xl font-bold text-neutral-900 dark:text-neutral-100">{t("shortcuts.gallery")}</h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            {t("shortcuts.galleryDesc")}
          </p>
        </div>
        
        <div class="rounded-xl border border-neutral-200 bg-white p-6 text-center dark:border-neutral-800 dark:bg-neutral-950">
          <p class="text-sm text-neutral-500 dark:text-neutral-400">
            {t("shortcuts.libraryComing")}
          </p>
        </div>
      </div>
    {/if}
  </div>
</div>

<!-- 新建快捷指令模态框 -->
{#if showNewModal}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    onclick={(e) => { if (e.target === e.currentTarget) showNewModal = false; }}
  >
    <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-neutral-900">
      <h2 class="mb-4 text-xl font-bold text-neutral-900 dark:text-neutral-100">{t("shortcuts.createNew")}</h2>
      
      <div class="space-y-4">
        <div>
          <label class="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">{t("shortcuts.name")}</label>
          <input
            type="text"
            bind:value={newName}
            placeholder={t("shortcuts.createNamePlaceholder")}
            class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
            onkeydown={(e) => { if (e.key === "Enter") handleCreate(); }}
            autofocus
          />
        </div>
        
        <div class="flex gap-3">
          <div class="flex-1">
            <label class="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">{t("shortcuts.icon")}</label>
            <select
              bind:value={newIcon}
              class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
            >
              {#each SHORTCUT_ICONS as icon}
                <option value={icon}>{icon}</option>
              {/each}
            </select>
          </div>
          
          <div class="flex-1">
            <label class="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">{t("shortcuts.color")}</label>
            <select
              bind:value={newColor}
              class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
            >
              {#each SHORTCUT_COLORS as color}
                <option value={color} style="color: {color};">● {color}</option>
              {/each}
            </select>
          </div>
        </div>
      </div>
      
      <div class="mt-6 flex gap-3">
        <button
          onclick={() => { showNewModal = false; newName = ""; }}
          class="flex-1 rounded-lg border border-neutral-300 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {t("shortcuts.cancel")}
        </button>
        <button
          onclick={handleCreate}
          class="flex-1 rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          {t("shortcuts.create")}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- 操作选择器模态框 -->
{#if showActionPicker}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    onclick={(e) => { if (e.target === e.currentTarget) showActionPicker = false; }}
  >
    <div class="h-[80vh] w-full max-w-2xl rounded-2xl bg-white shadow-xl dark:bg-neutral-900">
      <div class="flex h-full flex-col">
        <!-- 标题 -->
        <div class="flex items-center justify-between border-b border-neutral-200 p-4 dark:border-neutral-800">
          <h2 class="text-xl font-bold text-neutral-900 dark:text-neutral-100">{t("shortcuts.selectAction")}</h2>
          <button
            onclick={() => { showActionPicker = false; }}
            class="rounded-lg p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            aria-label={t("shortcuts.close")}
            title={t("shortcuts.closeWithKey")}
          >
            <span class="text-xl">×</span>
          </button>
        </div>
        
        <!-- 分类标签 -->
        <div class="flex gap-2 overflow-x-auto border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
          {#each actionCategories as category}
            <button
              onclick={() => { selectedCategory = category.id; }}
              class="flex-shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors {selectedCategory === category.id ? 'bg-blue-600 text-white' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'}"
            >
              {category.icon} {category.name}
            </button>
          {/each}
        </div>
        
        <!-- 操作列表 -->
        <div class="flex-1 overflow-y-auto p-4">
          <div class="grid gap-2">
            {#each availableActions as action (action.id)}
              <button
                onclick={() => handleAddAction(action)}
                class="flex items-start gap-3 rounded-lg border border-neutral-200 bg-white p-3 text-left transition-all hover:border-blue-500 hover:shadow-md dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-blue-500"
              >
                <div class="flex-shrink-0 text-2xl">{action.icon}</div>
                <div class="min-w-0 flex-1">
                  <div class="font-medium text-neutral-900 dark:text-neutral-100">{action.name}</div>
                  <div class="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{action.description}</div>
                </div>
              </button>
            {/each}
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- 执行结果 Toast -->
{#if executionResult}
  <div class="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 animate-[fadeIn_0.3s_ease-in-out]">
    <div class="rounded-full bg-neutral-800 px-6 py-3 text-sm text-white shadow-lg dark:bg-neutral-700">
      {executionResult}
    </div>
  </div>
{/if}
