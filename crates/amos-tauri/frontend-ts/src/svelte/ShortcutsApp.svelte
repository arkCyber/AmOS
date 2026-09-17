<script lang="ts">
  /**
   * ShortcutsApp.svelte — iOS-style Shortcuts automation app
   * 
   * 功能:
   * - 快捷指令列表与管理
   * - 可视化流程编辑器
   * - 操作库浏览
   * - 快速运行
   * - 搜索与筛选
   * - 文件夹组织
   */
  
  import { t, locale } from "./locale.svelte";
  import { appIcon } from "../lib/appMeta";
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
  // 操作函数
  // ============================================================================
  
  function refreshShortcuts() {
    shortcuts = loadShortcuts();
  }
  
  function handleCreate() {
    if (!newName.trim()) {
      alert("请输入快捷指令名称");
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
      alert("创建失败");
    }
  }
  
  function handleDelete(id: string) {
    if (!confirm("确定要删除这个快捷指令吗？")) return;
    
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
        executionResult = `✅ 已完成 (${result.actionsCompleted}/${result.actionsTotal} 个操作，用时 ${result.duration}ms)`;
      } else {
        executionResult = `❌ 失败: ${result.error}`;
      }
    } catch (err) {
      executionResult = `❌ 错误: ${err}`;
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
    [actions[index], actions[newIndex]] = [actions[newIndex], actions[index]];
    
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
  
  function getActionTypeName(actionTypeId: string): string {
    return BUILTIN_ACTIONS.find((a) => a.id === actionTypeId)?.name ?? actionTypeId;
  }
  
  function getActionTypeIcon(actionTypeId: string): string {
    return BUILTIN_ACTIONS.find((a) => a.id === actionTypeId)?.icon ?? "⚙️";
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
          aria-label="返回"
        >
          <span class="text-lg">←</span>
        </button>
        <span class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          {selectedShortcut.name}
        </span>
      {:else}
        <span class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          {$t("app.shortcuts")}
        </span>
      {/if}
    </div>
    
    <div class="flex items-center gap-2">
      {#if view === "list"}
        <button
          onclick={() => { view = "gallery"; }}
          class="rounded-lg px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950"
        >
          快捷指令库
        </button>
        <button
          onclick={() => { showNewModal = true; }}
          class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          + 新建
        </button>
      {:else if view === "editor"}
        <button
          onclick={() => { showActionPicker = true; }}
          class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          + 添加操作
        </button>
      {:else if view === "gallery"}
        <button
          onclick={() => { view = "list"; }}
          class="rounded-lg px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950"
        >
          我的快捷指令
        </button>
      {/if}
    </div>
  </div>

  <!-- 内容区域 -->
  <div class="flex-1 overflow-y-auto">
    {#if view === "list"}
      <!-- 搜索栏 -->
      <div class="sticky top-0 z-10 bg-neutral-50 px-4 py-3 dark:bg-neutral-900">
        <input
          type="text"
          bind:value={searchQuery}
          placeholder="搜索快捷指令"
          class="w-full rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm placeholder-neutral-400 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
        />
      </div>

      <!-- 快捷指令列表 -->
      <div class="space-y-2 px-4 pb-4">
        {#if filteredShortcuts.length === 0}
          <div class="flex flex-col items-center justify-center py-20 text-center">
            <div class="mb-4 text-6xl">⚡</div>
            <p class="mb-2 text-lg font-medium text-neutral-900 dark:text-neutral-100">
              {searchQuery ? "未找到快捷指令" : "还没有快捷指令"}
            </p>
            <p class="text-sm text-neutral-500 dark:text-neutral-400">
              {searchQuery ? "试试其他关键词" : "点击右上角「新建」开始创建"}
            </p>
          </div>
        {:else}
          {#each filteredShortcuts as shortcut (shortcut.id)}
            <div
              class="group relative rounded-xl border border-neutral-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-neutral-800 dark:bg-neutral-950"
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
                    <span>{shortcut.actions.length} 个操作</span>
                    <span>运行 {shortcut.runCount} 次</span>
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
                    aria-label="运行"
                    title="运行"
                  >
                    <span class="text-lg text-blue-600 dark:text-blue-400">▶️</span>
                  </button>
                  <button
                    onclick={() => handleEdit(shortcut)}
                    class="rounded-lg p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    aria-label="编辑"
                    title="编辑"
                  >
                    <span class="text-lg">✏️</span>
                  </button>
                  <button
                    onclick={() => handleDuplicate(shortcut.id)}
                    class="rounded-lg p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    aria-label="复制"
                    title="复制"
                  >
                    <span class="text-lg">📋</span>
                  </button>
                  <button
                    onclick={() => handleDelete(shortcut.id)}
                    class="rounded-lg p-2 hover:bg-red-50 dark:hover:bg-red-950"
                    aria-label="删除"
                    title="删除"
                  >
                    <span class="text-lg text-red-600 dark:text-red-400">🗑️</span>
                  </button>
                </div>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {:else if view === "editor" && selectedShortcut}
      <!-- 编辑器 -->
      <div class="space-y-4 p-4">
        <!-- 基本信息 -->
        <div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
          <h3 class="mb-3 text-sm font-semibold text-neutral-700 dark:text-neutral-300">基本信息</h3>
          <div class="space-y-3">
            <div>
              <label class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">名称</label>
              <input
                type="text"
                value={selectedShortcut.name}
                oninput={(e) => updateShortcut(selectedShortcut!.id, { name: e.currentTarget.value })}
                class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
              />
            </div>
            <div>
              <label class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">描述</label>
              <textarea
                value={selectedShortcut.description}
                oninput={(e) => updateShortcut(selectedShortcut!.id, { description: e.currentTarget.value })}
                rows="2"
                class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
              ></textarea>
            </div>
            <div class="flex gap-3">
              <div class="flex-1">
                <label class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">图标</label>
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
                <label class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">颜色</label>
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

        <!-- 操作列表 -->
        <div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
          <h3 class="mb-3 text-sm font-semibold text-neutral-700 dark:text-neutral-300">操作流程</h3>
          
          {#if selectedShortcut.actions.length === 0}
            <div class="flex flex-col items-center justify-center py-10 text-center">
              <div class="mb-3 text-4xl">⚙️</div>
              <p class="text-sm text-neutral-500 dark:text-neutral-400">
                还没有操作，点击"添加操作"开始构建流程
              </p>
            </div>
          {:else}
            <div class="space-y-2">
              {#each selectedShortcut.actions as action, index (action.id)}
                {@const actionType = BUILTIN_ACTIONS.find(a => a.id === action.actionTypeId)}
                {#if actionType}
                  <div class="group rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900">
                    <div class="flex items-start gap-3">
                      <div class="flex-shrink-0 text-2xl">{actionType.icon}</div>
                      <div class="min-w-0 flex-1">
                        <div class="mb-2 flex items-center justify-between">
                          <span class="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                            {actionType.name}
                          </span>
                          <div class="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            {#if index > 0}
                              <button
                                onclick={() => handleMoveAction(action.id, "up")}
                                class="rounded p-1 hover:bg-neutral-200 dark:hover:bg-neutral-800"
                                aria-label="上移"
                              >
                                <span class="text-xs">↑</span>
                              </button>
                            {/if}
                            {#if index < selectedShortcut.actions.length - 1}
                              <button
                                onclick={() => handleMoveAction(action.id, "down")}
                                class="rounded p-1 hover:bg-neutral-200 dark:hover:bg-neutral-800"
                                aria-label="下移"
                              >
                                <span class="text-xs">↓</span>
                              </button>
                            {/if}
                            <button
                              onclick={() => handleRemoveAction(action.id)}
                              class="rounded p-1 hover:bg-red-100 dark:hover:bg-red-950"
                              aria-label="删除"
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
        >
          {executing ? "运行中..." : "运行快捷指令"}
        </button>
      </div>
    {:else if view === "gallery"}
      <!-- 快捷指令库 -->
      <div class="space-y-4 p-4">
        <div class="text-center">
          <div class="mb-4 text-6xl">📚</div>
          <h2 class="mb-2 text-xl font-bold text-neutral-900 dark:text-neutral-100">快捷指令库</h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            探索预设模板，快速创建实用的快捷指令
          </p>
        </div>
        
        <div class="rounded-xl border border-neutral-200 bg-white p-6 text-center dark:border-neutral-800 dark:bg-neutral-950">
          <p class="text-sm text-neutral-500 dark:text-neutral-400">
            🚧 快捷指令库即将推出
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
      <h2 class="mb-4 text-xl font-bold text-neutral-900 dark:text-neutral-100">新建快捷指令</h2>
      
      <div class="space-y-4">
        <div>
          <label class="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">名称</label>
          <input
            type="text"
            bind:value={newName}
            placeholder="输入快捷指令名称"
            class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
            onkeydown={(e) => { if (e.key === "Enter") handleCreate(); }}
          />
        </div>
        
        <div class="flex gap-3">
          <div class="flex-1">
            <label class="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">图标</label>
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
            <label class="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">颜色</label>
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
          取消
        </button>
        <button
          onclick={handleCreate}
          class="flex-1 rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          创建
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
          <h2 class="text-xl font-bold text-neutral-900 dark:text-neutral-100">选择操作</h2>
          <button
            onclick={() => { showActionPicker = false; }}
            class="rounded-lg p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            aria-label="关闭"
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
