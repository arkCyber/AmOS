<script module lang="ts">
  /**
   * 可见标签与它的控件共用一枚 id（REQ-A283/A386）。**模块级**计数器：同一份
   * 文档里可能挂载多份 ShortcutsApp（多窗口、测试），写死字符串会在第二份实例上
   * 撞车，而每次渲染重取又会让 `for` 关联失效 —— 与 `settings/kit.nextFieldId` 同一思路。
   */
  let fieldSeq = 0;
  function nextFieldId(): string {
    fieldSeq += 1;
    return `shortcut-field-${fieldSeq}`;
  }
</script>

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
  import { t, locale } from "./locale.svelte";
  import { attachFocusTrap } from "../lib/focusTrap";
  import { localId } from "../lib/localId";
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
    type Trigger,
    type TriggerType,
  } from "../lib/shortcuts";
  import { APP_META } from "../lib/appMeta";
  import { nameForId } from "../lib/appLookup";
  import { getStoreTiles, subscribeStoreTiles, type StoreTile } from "../lib/storeApps";
  import { TRIGGER_KINDS, kindOf } from "../lib/shortcutTriggerCatalog";
  import { isShareTarget, withShareSheet } from "../lib/shareSheet";
  // MDM 的评判必须由**面板之外**的这一层来问：`updateShortcut()` 被拦下时只返回 `false`，
  // 理由留在它自己的日志里。要让用户看见"为什么"，就得问同一批判判（REQ-A837）。
  import { mdmManager, emitWebhookEvent } from "../lib/enterprise";
  import type { MessageKey } from "../i18n/locales/zh";
  // 快捷指令库（REQ-A500）：预设模板是**数据**，安装走 `createShortcut`（唯一入口）。
  import {
    GALLERY_TEMPLATES,
    isTemplateInstalled,
    templateOptions,
    type GalleryTemplate,
  } from "../lib/shortcutGallery";

  // ============================================================================
  // 状态管理
  // ============================================================================
  
  let shortcuts = $state<Shortcut[]>(loadShortcuts());
  let selectedShortcut = $state<Shortcut | null>(null);
  let searchQuery = $state("");
  let view = $state<"list" | "editor" | "gallery">("list");
  let showNewModal = $state(false);
  let showActionPicker = $state(false);
  /** 触发器类型选择面板是否展开（REQ-A702）。 */
  let showTriggerPicker = $state(false);
  let selectedCategory = $state<ActionCategory | "all">("all");

  /**
   * 已安装的商店应用（REQ-A1190）。本应用挂在 `AppPane` 里，既不在 `DesktopShell`
   * 的 context 内、也拿不到壳推下来的 `ext`，所以它读的是 `lib/storeApps` 的模块缓存
   * —— 那是 `loadStoreTiles()` 唯一的写点，`StoreApp` 在装/卸/升级后 `notifyStoreTilesChanged()`。
   * 缓存本身**不会**通知响应式，因此这里订阅一份 `$state` 副本：否则编辑器在商店装完
   * 应用后仍列不出它（`project_long_lived_component_snapshots_store_at_init` 的同一课）。
   */
  let ext = $state<StoreTile[]>(getStoreTiles());
  $effect(() => subscribeStoreTiles(() => { ext = getStoreTiles(); }));

  // 新建快捷指令表单
  // 编辑器/新建模态里每一对「可见标签 ↔ 控件」的 id（一次挂载取一次）。
  const nameId = nextFieldId();
  const descriptionId = nextFieldId();
  const iconId = nextFieldId();
  const colorId = nextFieldId();
  const newNameId = nextFieldId();
  const newIconId = nextFieldId();
  const newColorId = nextFieldId();

  /** 两个模态的根元素：Escape 关闭 + 焦点陷阱（也负责开模态时把焦点交给首个字段）。 */
  let newModalEl: HTMLDivElement | undefined = $state();
  let pickerEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!showNewModal || !newModalEl) return;
    return attachFocusTrap(newModalEl, () => (showNewModal = false));
  });
  $effect(() => {
    if (!showActionPicker || !pickerEl) return;
    return attachFocusTrap(pickerEl, () => (showActionPicker = false));
  });

  let newName = $state("");
  let newIcon = $state(SHORTCUT_ICONS[0]);
  let newColor = $state(SHORTCUT_COLORS[0]);
  
  // 执行状态
  let executing = $state(false);
  let executionResult = $state<string | null>(null);

  /**
   * 快捷指令库的安装反馈（REQ-A500）。
   *
   * 只在**失败**时才有内容可读：成功之后卡片自己的按钮会变成「已添加」（那是从 `shortcuts`
   * 现算出来的状态，不是第二条账）。失败必须说出来 —— 库里那句「添加失败」正是为了让
   * 「点了没反应」不再出现（`createShortcut` 会因为名字被拒 / 上限而返回 `null`）。
   */
  let galleryNote = $state("");

  /**
   * 修改 / 删除被拒时的那一句话（REQ-A837）。
   *
   * 与 `galleryNote` 同族、同一个判据：**失败了必须说出来**。差别在于这条覆盖的是编辑器里的
   * 每一处写操作 —— 原先它们全是 `if (updateShortcut(...)) { … }`，**没有 else**：
   * 管理员勾上「禁止修改」之后，用户改名字、换图标、加触发器、切分享开关，点下去屏幕
   * 毫无反应，连一句"为什么"都没有。同一个限制面里只有**创建**那条路说了话
   * （`alert(t("shortcuts.createFailed"))`）—— 三条同类路径，两条不说。
   */
  let mutationNote = $state("");

  /**
   * 失败时的那句话：优先用 `mdmManager` 的**同一批判判**给出的理由
   * （管理员看到的句子必须与真正拦下它的那句一致），否则退回到一句通用文案
   * （写盘失败 / 指令已不存在这类非 MDM 的失败）。
   */
  function mutationRefusal(id: string, action: "modify" | "delete"): string {
    const verdict =
      action === "modify" ? mdmManager.checkCanModify(id) : mdmManager.checkCanDelete(id);
    if (!verdict.allowed) return verdict.reason ?? t("shortcuts.mutationBlocked");
    return action === "modify" ? t("shortcuts.updateFailed") : t("shortcuts.deleteFailed");
  }

  /**
   * 写快捷指令的唯一 UI 入口：成功就清掉上一次的拒绝，失败就把理由挂上去。
   *
   * 返回值与 `updateShortcut` 一致，所以 `if (…) { … }` 的调用点可以原样换过来。
   */
  function applyUpdate(id: string, updates: Partial<Shortcut>): boolean {
    if (updateShortcut(id, updates)) {
      mutationNote = "";
      return true;
    }
    mutationNote = mutationRefusal(id, "modify");
    return false;
  }

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
    /**
     * 先把**存下来的 MDM 配置**读回来（REQ-A945）。
     *
     * 本应用里每一道 MDM 判据（`checkCanCreate` / `checkCanModify` /
     * `checkCanDelete` / `checkPermission`）都是**同步**的，它们读的是
     * `mdmManager` 内存里那份配置；而把那份配置从存储里读回来的
     * `initialize()` 在生产里**零调用者**（唯一调用点在一个同样零调用者的
     * `initializeEnterprise()` 里）。于是重启之后：管理员设的限制还在盘上，
     * 而这台设备**按"完全没有策略"运行** —— 改名字、换图标、加触发器、开分享
     * 全都放行，且屏幕上一句话都没有。
     *
     * 挂在这里而不是每个判据里：这一处是**所有**编辑动作之前的那一次
     * （`onMount` 在用户能点到任何按钮之前跑完）。加载是幂等的，重复调用无代价。
     */
    void mdmManager.ensureInitialized();

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
      } else if (showTriggerPicker) {
        showTriggerPicker = false;
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
    
    if (applyUpdate(selectedShortcut.id, updated)) {
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
  
  /**
   * 创建被拒时的那个理由（REQ-A842）。
   *
   * `createShortcut()` 失败时只返回 `null`，理由留在它自己的日志里 —— 于是三种不同的失败
   * （管理员禁止创建 / 每用户上限已满 / 名字不合法）在屏幕上是**同一句话**。这里向
   * **同一批判判**要理由：MDM 说不行就用它的句子（管理员看到的必须与真正拦下它的那句一致），
   * 否则退回这条路径自己的通用文案。
   *
   * 数的是 `shortcuts.length`：`createShortcut()` 判的就是这个数，两边读同一个列表，
   * 所以不存在"屏幕说没超、引擎说超了"的第三种状态。
   *
   * 为什么这里用 `alert` 而不是 `mutationNote`：新建走的是**模态**，它盖住内容区，
   * 那条读数横幅在模态后面 —— 渲染点必须在用户看得见的那一层（这是上一轮踩过的坑）。
   */
  function createRefusal(fallback: string): string {
    const verdict = mdmManager.checkCanCreate(shortcuts.length);
    return verdict.allowed ? fallback : (verdict.reason ?? fallback);
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
      alert(createRefusal(t("shortcuts.createFailed")));
    }
  }
  
  /**
   * 从预设模板安装一条快捷指令（REQ-A500）。
   *
   * 走 `createShortcut` —— 它带着 MDM 权限检查、名字校验与上限，是创建这条路上唯一的入口；
   * 失败必须**说出来**（`galleryNote`），因为"点了没反应"正是这类界面最容易犯的错。
   * 装完之后不跳编辑器：用户是来"逛库"的，卡片自己的按钮会变成「已添加」。
   */
  function installTemplate(tpl: GalleryTemplate) {
    const made = createShortcut(
      t(tpl.nameKey),
      templateOptions(tpl, t(tpl.descKey), t, () => localId("sa")),
    );
    if (!made) {
      galleryNote = createRefusal(t("shortcuts.galleryAddFailed"));
      return;
    }
    galleryNote = "";
    refreshShortcuts();
  }

  function handleDelete(id: string) {
    if (!confirm(t("shortcuts.deleteConfirm"))) return;
    
    if (deleteShortcut(id)) {
      refreshShortcuts();
      mutationNote = "";
      if (selectedShortcut?.id === id) {
        selectedShortcut = null;
        view = "list";
      }
    } else {
      // 删除同样会被 MDM 拦下（强制指令不可删 / 管理员禁止删除）。原先这里没有 else：
      // 用户确认删除之后什么都不发生，指令还在，没有任何解释（REQ-A837）。
      mutationNote = mutationRefusal(id, "delete");
      refreshShortcuts();
    }
  }
  
  /**
   * 复制一条快捷指令（REQ-A1442）。
   *
   * 复制内层走的就是 `createShortcut()`，所以 MDM 的**创建**限制（禁止创建 / 需审批 /
   * 每用户上限）与应用硬上限都会在那里拦下，`duplicateShortcut()` 只把结果折成 `null`
   * —— 理由留在日志里。原先这里没有 else：管理员禁止创建、或到达上限之后，用户按列表里的
   * 📋（或编辑器里按 ⌘D）屏幕毫无反应，列表里也没多出副本，分不清是「没点上」还是
   * 「不让复制」。同一份列表里的创建（REQ-A842）与修改／删除／分享（REQ-A837）都早已
   * 说话，复制是唯一读了裁决又把拒绝丢掉的那条。
   *
   * 理由向**同一批判判**要（`createRefusal` → `checkCanCreate`），不另写一句；它读的
   * `shortcuts.length` 正是 `createShortcut()` 判的那个数。`mutationNote` 的渲染点在两个
   * 视图之外（`role="status"` 的 live region），复制按钮所在的那一层看得见。
   */
  function handleDuplicate(id: string) {
    const duplicate = duplicateShortcut(id);
    if (duplicate) {
      mutationNote = "";
      refreshShortcuts();
    } else {
      mutationNote = createRefusal(t("shortcuts.duplicateFailed"));
    }
  }
  
  async function handleRun(id: string) {
    /**
     * `requiresConfirmation` 是一个数据字段，而这里是它唯一能兑现的地方：引擎会拒
     * 绝未确认的运行（`executeShortcut` 的 confirmed 门禁），所以 UI 必须先问。
     * 自动化触发（触发器）没人可问，运行时按约定**跳过**这类指令。
     */
    const target = shortcuts.find((s) => s.id === id);
    if (target?.requiresConfirmation && !confirm(t("shortcuts.confirmRun", { name: target.name }))) {
      return;
    }

    executing = true;
    executionResult = null;
    
    try {
      const result = await executeShortcut(id, undefined, { confirmed: true });
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
      // The shared `localId` (REQ-A401): an action id is identity within the shortcut,
      // and the editor keys its rows by it.
      id: localId("act"),
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
    
    if (applyUpdate(selectedShortcut.id, updated)) {
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
    
    if (applyUpdate(selectedShortcut.id, updated)) {
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
    
    if (applyUpdate(selectedShortcut.id, updated)) {
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
    
    if (applyUpdate(selectedShortcut.id, updated)) {
      selectedShortcut = updated;
      refreshShortcuts();
    }
  }

  // ==========================================================================
  // 自动化触发器 (REQ-A702)
  //
  // 运行时两端**早已建成**（Rust 的 `shortcuts_trigger_*` 墙钟账本 + WebView
  // 心跳，信号源 time/wifi/app/battery），但此前**没有任何 UI 能创建触发器** ——
  // 用户编不出、自然也就跑不了。本段把那半截界面补上。
  //
  // 哪些类型有信号源由目录（`TRIGGER_KINDS`）回答；没有信号源的类型在面板里
  // **显式禁用**并给出原因，而不是画一个永远不响的开关。
  // ==========================================================================

  /** 编辑器里的触发器列表（旧数据可能没有 `triggers` 字段）。 */
  const editorTriggers = $derived(selectedShortcut?.triggers ?? []);

  /** ISO 星期 1..7 的单字标签（周一…周日）。与 ClockApp 的 `DOW` 同一约定。 */
  const weekdayLabels = $derived(
    locale() === "zh"
      ? ["一", "二", "三", "四", "五", "六", "日"]
      : ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"],
  );

  /** 落盘一份新的触发器数组；失败不动本地状态（`updateShortcut` 会因 MDM/校验拒）。 */
  function saveTriggers(triggers: Trigger[]): void {
    if (!selectedShortcut) return;
    if (applyUpdate(selectedShortcut.id, { triggers })) {
      selectedShortcut = { ...selectedShortcut, triggers };
      refreshShortcuts();
    }
  }

  /**
   * 这条指令是否出现在系统分享面板（REQ-A703）。`quickActions` 曾经是个**只有声明、
   * 没有兑现**的字段（`shareSheet` 全仓无人读），这里是它唯一的**生产者**，而
   * `ShareSheet.svelte` 是唯一的**消费者**。
   */
  function handleToggleShareSheet(): void {
    if (!selectedShortcut) return;
    const on = !isShareTarget(selectedShortcut);

    /**
     * 「分享」这一层的限制（REQ-A837）。`allowSharing` / `requireApprovalForSharing`
     * 此前**只**被 `mdmManager.checkPermission("share")` 读，而那个分支**没有任何调用者**
     * —— 面板上的这两个开关因此是装饰。这里就是它们的生产调用点。
     *
     * **只在开启分享时问**：禁止分享之后还拦着"取消分享"，等于把已经分享出去的指令
     * 永久钉在那里。限制的方向是收紧可见性，而**撤回分享本身就是收紧** —— 拦它是在
     * 朝危险的一侧失败（同一个开关的两个方向不由它自己决定，由消费者决定）。
     */
    if (on) {
      const share = mdmManager.checkPermission("share");
      if (!share.allowed) {
        mutationNote = share.reason ?? t("shortcuts.mutationBlocked");
        return;
      }
    }

    const quickActions = withShareSheet(selectedShortcut.quickActions, on);
    if (applyUpdate(selectedShortcut.id, { quickActions })) {
      selectedShortcut = { ...selectedShortcut, quickActions };
      refreshShortcuts();

      // 企业 webhook（REQ-A980）：**只在开启分享时发**，与上面那道 MDM 判据同一个方向 ——
      // 面板上的 `shortcut_share` 说的是"这条指令被分享出去了"；撤回分享是收紧可见性，
      // 把它也发成一次"share"会让订阅者收到一条与事实相反的通知。
      if (on) {
        emitWebhookEvent("shortcut_share", {
          shortcutId: selectedShortcut.id,
          name: selectedShortcut.name,
        });
      }
    }
  }

  function handleAddTrigger(type: TriggerType): void {
    const kind = kindOf(type);
    if (!kind || kind.unavailableReasonKey !== null) return;
    const trigger: Trigger = {
      id: localId("trg"),
      type,
      enabled: true,
      config: { ...kind.defaultConfig },
    };
    saveTriggers([...editorTriggers, trigger]);
    showTriggerPicker = false;
  }

  function handleRemoveTrigger(triggerId: string): void {
    saveTriggers(editorTriggers.filter((tr) => tr.id !== triggerId));
  }

  function handleToggleTrigger(triggerId: string): void {
    saveTriggers(
      editorTriggers.map((tr) => (tr.id === triggerId ? { ...tr, enabled: !tr.enabled } : tr)),
    );
  }

  function handleUpdateTriggerConfig(triggerId: string, key: string, value: unknown): void {
    saveTriggers(
      editorTriggers.map((tr) =>
        tr.id === triggerId ? { ...tr, config: { ...tr.config, [key]: value } } : tr,
      ),
    );
  }

  /** 切换某个 ISO 星期；空数组 = 每天。 */
  function handleToggleDay(triggerId: string, day: number): void {
    const trigger = editorTriggers.find((tr) => tr.id === triggerId);
    if (!trigger) return;
    const current = Array.isArray(trigger.config.days) ? trigger.config.days.map(Number) : [];
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day].sort((a, b) => a - b);
    handleUpdateTriggerConfig(triggerId, "days", next);
  }

  /** 一个触发器行的一句话细节（类型名之外的摘要）。 */
  function triggerDetail(trigger: Trigger): string {
    const cfg = trigger.config ?? {};
    switch (trigger.type) {
      case "time": {
        const days = Array.isArray(cfg.days) ? cfg.days.map(Number) : [];
        const time = String(cfg.time ?? "");
        const text =
          days.length === 0 || days.length === 7
            ? t("shortcuts.trigger.everyday")
            : days.map((d) => weekdayLabels[d - 1] ?? "").join(" ");
        return `${text} ${time}`.trim();
      }
      case "app":
        return appDisplayName(String(cfg.appId ?? ""));
      case "wifi": {
        const phase = wifiEventKey(String(cfg.event ?? "connect"));
        const ssid = String(cfg.ssid ?? "");
        return ssid ? `${t(phase)} · ${ssid}` : t(phase);
      }
      case "battery": {
        const parts: string[] = [];
        if (cfg.levelBelow !== undefined && cfg.levelBelow !== "") {
          parts.push(`<${Number(cfg.levelBelow)}%`);
        }
        if (cfg.levelAbove !== undefined && cfg.levelAbove !== "") {
          parts.push(`>${Number(cfg.levelAbove)}%`);
        }
        if (cfg.charging === true) parts.push(t("shortcuts.trigger.charging.yes"));
        if (cfg.charging === false) parts.push(t("shortcuts.trigger.charging.no"));
        return parts.join(" · ");
      }
      default: {
        // 尚无信号源的类型：把原因说出来，而不是给一句空摘要。
        const kind = kindOf(trigger.type);
        return kind?.unavailableReasonKey ? t(kind.unavailableReasonKey) : "";
      }
    }
  }

  /** Wi-Fi 时机 → 字典键（字面量映射，不给 i18n 扫描留动态拼接）。 */
  function wifiEventKey(event: string): MessageKey {
    if (event === "disconnect") return "shortcuts.trigger.event.disconnect";
    if (event === "any") return "shortcuts.trigger.event.any";
    return "shortcuts.trigger.event.connect";
  }

  /** 应用触发器的显示名：内置注册表或商店瓷砖里认识的用它的名字，否则退回原始 id。
   * REQ-A1190：此前只查 `APP_META`，一个已安装的商店应用（`store:<manifest.id>`）在
   * 这里会以 raw wire id 显示 —— 与 REQ-A1185 修掉的同一类「把裸 id 给用户看」。 */
  function appDisplayName(appId: string): string {
    if (!appId) return t("shortcuts.trigger.anyApp");
    return nameForId(appId, ext, t);
  }

  /** 电池"充电状态"下拉的取值 ↔ 配置值（"any"/"yes"/"no" ↔ undefined/true/false）。 */
  function chargingToSelect(value: unknown): string {
    if (value === true) return "yes";
    if (value === false) return "no";
    return "any";
  }
  function selectToCharging(value: string): boolean | undefined {
    if (value === "yes") return true;
    if (value === "no") return false;
    return undefined;
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
    <!-- 写操作被拒时的读数（REQ-A837）。与库视图的 `gallery-note` 同一判据：原先这里
         有 9 处 `if (updateShortcut(…)) { … }`、**没有一处带 else** —— 管理员禁止修改后，
         改名字 / 换图标 / 加触发器点下去毫无反应，用户不知道是"没保存上"还是"不让改"。

         **必须渲染在三个视图之外**：删除的按钮在**列表视图**的卡片上（`handleDelete`
         的唯一调用点就在那里），而改名字那一类写操作在编辑器里。先前它只渲染在编辑器
         内部，于是"删除被拒"这句理由根本没有渲染点 —— 用户确认删除之后指令还在，
         屏幕沉默，正是这条要修的那个形状本身。

         必须是 live region：按完按钮焦点还在原处，否则屏幕阅读器不知道那一下成没成。 -->
    {#if mutationNote}
      <p
        class="mx-4 mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        role="status"
        data-testid="shortcut-mutation-note"
      >
        {mutationNote}
      </p>
    {/if}

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
                  <div class="row-actions">
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
                <label for={nameId} class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">{t("shortcuts.name")}</label>
                <input
                  id={nameId}
                  type="text"
                  value={selectedShortcut.name}
                  oninput={(e) => applyUpdate(selectedShortcut!.id, { name: e.currentTarget.value })}
                  class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                />
              </div>
              <div>
                <label for={descriptionId} class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">{t("shortcuts.description")}</label>
                <textarea
                  id={descriptionId}
                  value={selectedShortcut.description}
                  oninput={(e) => applyUpdate(selectedShortcut!.id, { description: e.currentTarget.value })}
                  rows="2"
                  class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                ></textarea>
              </div>
              <div class="flex gap-3">
                <div class="flex-1">
                  <label for={iconId} class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">{t("shortcuts.icon")}</label>
                  <select
                    id={iconId}
                    value={selectedShortcut.icon}
                    onchange={(e) => applyUpdate(selectedShortcut!.id, { icon: e.currentTarget.value })}
                    class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                  >
                    {#each SHORTCUT_ICONS as icon}
                      <option value={icon}>{icon}</option>
                    {/each}
                  </select>
                </div>
                <div class="flex-1">
                  <label for={colorId} class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">{t("shortcuts.color")}</label>
                  <select
                    id={colorId}
                    value={selectedShortcut.color}
                    onchange={(e) => applyUpdate(selectedShortcut!.id, { color: e.currentTarget.value })}
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
              <div class="space-y-2" role="list">
                {#each selectedShortcut.actions as action, index (action.id)}
                  {@const actionType = BUILTIN_ACTIONS.find(a => a.id === action.actionTypeId)}
                  {#if actionType}
                    <div
                      role="listitem"
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
                            <div class="action-actions">
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
                                  <label
                                    for={`shortcut-param-${action.id}-${param.id}`}
                                    class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400"
                                  >
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
                                      id={`shortcut-param-${action.id}-${param.id}`}
                                      class="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-white"
                                    />
                                  {:else if param.type === "number"}
                                    <input
                                      type="number"
                                      value={action.parameters[param.id] ?? ""}
                                      oninput={(e) => handleUpdateActionParam(action.id, param.id, Number(e.currentTarget.value))}
                                      id={`shortcut-param-${action.id}-${param.id}`}
                                      class="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-white"
                                    />
                                  {:else if param.type === "select" && param.options}
                                    <select
                                      value={action.parameters[param.id] ?? param.defaultValue}
                                      onchange={(e) => handleUpdateActionParam(action.id, param.id, e.currentTarget.value)}
                                      id={`shortcut-param-${action.id}-${param.id}`}
                                      class="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-white"
                                    >
                                      {#each param.options as option}
                                        <option value={option.value}>{option.label}</option>
                                      {/each}
                                    </select>
                                  {:else if param.type === "app"}
                                    <!-- REQ-A1190：`open_app` 的 `app` 参数是 **required**、类型 `app`，
                                         而本分支此前不存在 —— 选中「打开 App」后界面上**一个控件都没有**
                                         （`parameters` 永远是 `{}`），于是该步骤执行时必然抛
                                         「打开 App 需要应用标识」。缺的不是一个控件，是整条操作的一半。 -->
                                    <select
                                      value={String(action.parameters[param.id] ?? "")}
                                      onchange={(e) => handleUpdateActionParam(action.id, param.id, e.currentTarget.value)}
                                      id={`shortcut-param-${action.id}-${param.id}`}
                                      data-testid={`action-param-app-${action.id}`}
                                      class="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-white"
                                    >
                                      <option value="">{t("shortcuts.actionAppPlaceholder")}</option>
                                      {#each APP_META as app (app.id)}
                                        <option value={app.id}>{app.icon} {t(app.titleKey)}</option>
                                      {/each}
                                      {#each ext as tile (tile.id)}
                                        <option value={tile.id}>{tile.icon} {tile.name}</option>
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

          <!-- 自动化触发器 (REQ-A702)。运行时两端（Rust 墙钟账本 + WebView 心跳）
               早已建成，此前却没有任何 UI 能创建触发器 —— 用户编不出、自然跑不了。
               这里把「哪些类型有信号源」交给目录 `TRIGGER_KINDS`：没有信号源的
               类型**显式禁用**并给出原因，而不是画一个永远不响的开关。 -->
          <div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
            <div class="mb-1 flex items-center justify-between">
              <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">{t("shortcuts.triggersTitle")}</h3>
              <button
                type="button"
                onclick={() => { showTriggerPicker = !showTriggerPicker; }}
                aria-expanded={showTriggerPicker}
                data-testid="trigger-add"
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950"
              >
                {t("shortcuts.triggerAdd")}
              </button>
            </div>
            <p class="mb-3 text-xs text-neutral-500 dark:text-neutral-400">{t("shortcuts.triggersHint")}</p>

            {#if showTriggerPicker}
              <div class="mb-3 rounded-lg border border-neutral-200 p-2 dark:border-neutral-700" data-testid="trigger-picker">
                <p class="mb-2 text-xs font-medium text-neutral-600 dark:text-neutral-400">{t("shortcuts.triggerPickTitle")}</p>
                <div class="grid grid-cols-2 gap-2">
                  {#each TRIGGER_KINDS as kind (kind.type)}
                    <button
                      type="button"
                      onclick={() => handleAddTrigger(kind.type)}
                      disabled={kind.unavailableReasonKey !== null}
                      data-testid="trigger-option-{kind.type}"
                      class="flex items-start gap-2 rounded-lg border border-neutral-200 p-2 text-left transition hover:border-blue-500 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-neutral-200 dark:border-neutral-700 dark:hover:border-blue-500"
                    >
                      <span class="text-lg" aria-hidden="true">{kind.icon}</span>
                      <span class="min-w-0 flex-1">
                        <span class="block text-sm font-medium text-neutral-900 dark:text-neutral-100">{t(kind.labelKey)}</span>
                        {#if kind.unavailableReasonKey}
                          <span class="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">{t(kind.unavailableReasonKey)}</span>
                        {/if}
                      </span>
                    </button>
                  {/each}
                </div>
              </div>
            {/if}

            {#if editorTriggers.length === 0}
              <p class="py-4 text-center text-xs text-neutral-500 dark:text-neutral-400">{t("shortcuts.triggerEmpty")}</p>
            {:else}
              <div class="space-y-2">
                {#each editorTriggers as trigger (trigger.id)}
                  {@const kind = kindOf(trigger.type)}
                  <div
                    class="rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900"
                    data-testid="trigger-row-{trigger.id}"
                  >
                    <div class="flex items-center gap-2">
                      <span class="text-lg" aria-hidden="true">{kind?.icon ?? "⚡"}</span>
                      <div class="min-w-0 flex-1">
                        <div class="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                          {kind ? t(kind.labelKey) : trigger.type}
                        </div>
                        <div class="truncate text-xs text-neutral-600 dark:text-neutral-400">{triggerDetail(trigger)}</div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={trigger.enabled}
                        aria-label={trigger.enabled ? t("shortcuts.triggerDisable") : t("shortcuts.triggerEnable")}
                        onclick={() => handleToggleTrigger(trigger.id)}
                        data-testid="trigger-toggle-{trigger.id}"
                        class="grid h-11 w-11 shrink-0 place-items-center"
                      >
                        <!-- 命中区 44×44，视觉仍是 36×20 的轨道 —— 按钮承担命中区，轨道是里面
                             那条圆角条（REQ-A387 在 DockPage 上定下的形状）。原来按钮自己只有
                             20 高，低于 WCAG 2.5.8 的 AA 下限 24（REQ-A953）。 -->
                        <span class="relative block h-5 w-9 rounded-full transition {trigger.enabled ? 'bg-blue-600' : 'bg-neutral-300 dark:bg-neutral-600'}">
                          <span class="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all {trigger.enabled ? 'left-4' : 'left-0.5'}"></span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onclick={() => handleRemoveTrigger(trigger.id)}
                        aria-label={t("shortcuts.triggerRemove")}
                        title={t("shortcuts.triggerRemove")}
                        data-testid="trigger-remove-{trigger.id}"
                        class="rounded p-1 hover:bg-red-100 dark:hover:bg-red-950"
                      >
                        <span class="text-xs text-red-600 dark:text-red-400" aria-hidden="true">×</span>
                      </button>
                    </div>

                    {#if trigger.type === "time"}
                      <div class="mt-3 space-y-2">
                        <label class="block text-xs text-neutral-600 dark:text-neutral-400">
                          {t("shortcuts.trigger.timeLabel")}
                          <input
                            type="time"
                            value={String(trigger.config.time ?? "08:00")}
                            oninput={(e) => handleUpdateTriggerConfig(trigger.id, "time", e.currentTarget.value)}
                            data-testid="trigger-time-{trigger.id}"
                            class="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-white"
                          />
                        </label>
                        <div>
                          <span class="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">{t("shortcuts.trigger.daysLabel")}</span>
                          <div class="flex flex-wrap gap-1">
                            {#each weekdayLabels as dayLabel, i}
                              {@const day = i + 1}
                              {@const on = (Array.isArray(trigger.config.days) ? trigger.config.days : []).map(Number).includes(day)}
                              <button
                                type="button"
                                onclick={() => handleToggleDay(trigger.id, day)}
                                aria-pressed={on}
                                data-testid="trigger-day-{trigger.id}-{day}"
                                class="h-7 w-7 rounded-full text-xs font-medium {on ? 'bg-blue-600 text-white' : 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200'}"
                              >
                                {dayLabel}
                              </button>
                            {/each}
                          </div>
                        </div>
                      </div>
                    {:else if trigger.type === "wifi"}
                      <div class="mt-3 grid grid-cols-2 gap-2">
                        <label class="block text-xs text-neutral-600 dark:text-neutral-400">
                          {t("shortcuts.trigger.ssidLabel")}
                          <input
                            type="text"
                            value={String(trigger.config.ssid ?? "")}
                            placeholder={t("shortcuts.trigger.ssidAnyPlaceholder")}
                            oninput={(e) => handleUpdateTriggerConfig(trigger.id, "ssid", e.currentTarget.value)}
                            data-testid="trigger-ssid-{trigger.id}"
                            class="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-white"
                          />
                        </label>
                        <label class="block text-xs text-neutral-600 dark:text-neutral-400">
                          {t("shortcuts.trigger.eventLabel")}
                          <select
                            value={String(trigger.config.event ?? "connect")}
                            onchange={(e) => handleUpdateTriggerConfig(trigger.id, "event", e.currentTarget.value)}
                            data-testid="trigger-wifi-event-{trigger.id}"
                            class="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-white"
                          >
                            <option value="connect">{t("shortcuts.trigger.event.connect")}</option>
                            <option value="disconnect">{t("shortcuts.trigger.event.disconnect")}</option>
                            <option value="any">{t("shortcuts.trigger.event.any")}</option>
                          </select>
                        </label>
                      </div>
                    {:else if trigger.type === "app"}
                      <label class="mt-3 block text-xs text-neutral-600 dark:text-neutral-400">
                        {t("shortcuts.trigger.appLabel")}
                        <select
                          value={String(trigger.config.appId ?? "")}
                          onchange={(e) => handleUpdateTriggerConfig(trigger.id, "appId", e.currentTarget.value)}
                          data-testid="trigger-app-{trigger.id}"
                          class="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-white"
                        >
                          <option value="">{t("shortcuts.trigger.anyApp")}</option>
                          {#each APP_META as app (app.id)}
                            <option value={app.id}>{app.icon} {t(app.titleKey)}</option>
                          {/each}
                          <!-- REQ-A1190：触发器运行时（`triggerMatches` 的 `app` 分支）按字符串
                               相等匹配 appId，对 `store:<manifest.id>` 与内置 id 一视同仁；此前这张
                               列表只有内置应用，于是「当某个已安装应用打开时」这条自动化**编不出来**，
                               尽管它跑得起来 —— 门比屋窄。 -->
                          {#each ext as tile (tile.id)}
                            <option value={tile.id}>{tile.icon} {tile.name}</option>
                          {/each}
                        </select>
                      </label>
                    {:else if trigger.type === "battery"}
                      <div class="mt-3 grid grid-cols-2 gap-2">
                        <label class="block text-xs text-neutral-600 dark:text-neutral-400">
                          {t("shortcuts.trigger.levelBelowLabel")}
                          <input
                            type="number"
                            min="0"
                            max="100"
                            value={trigger.config.levelBelow === undefined || trigger.config.levelBelow === "" ? "" : String(trigger.config.levelBelow)}
                            oninput={(e) => handleUpdateTriggerConfig(trigger.id, "levelBelow", e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value))}
                            data-testid="trigger-below-{trigger.id}"
                            class="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-white"
                          />
                        </label>
                        <label class="block text-xs text-neutral-600 dark:text-neutral-400">
                          {t("shortcuts.trigger.levelAboveLabel")}
                          <input
                            type="number"
                            min="0"
                            max="100"
                            value={trigger.config.levelAbove === undefined || trigger.config.levelAbove === "" ? "" : String(trigger.config.levelAbove)}
                            oninput={(e) => handleUpdateTriggerConfig(trigger.id, "levelAbove", e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value))}
                            data-testid="trigger-above-{trigger.id}"
                            class="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-white"
                          />
                        </label>
                        <label class="col-span-2 block text-xs text-neutral-600 dark:text-neutral-400">
                          {t("shortcuts.trigger.chargingLabel")}
                          <select
                            value={chargingToSelect(trigger.config.charging)}
                            onchange={(e) => handleUpdateTriggerConfig(trigger.id, "charging", selectToCharging(e.currentTarget.value))}
                            data-testid="trigger-charging-{trigger.id}"
                            class="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-white"
                          >
                            <option value="any">{t("shortcuts.trigger.charging.any")}</option>
                            <option value="yes">{t("shortcuts.trigger.charging.yes")}</option>
                            <option value="no">{t("shortcuts.trigger.charging.no")}</option>
                          </select>
                        </label>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <!-- 系统分享面板 (REQ-A703)：`quickActions` 唯一的编辑器入口。 -->
          <div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
            <div class="flex items-center gap-3">
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t("shortcuts.shareSheetToggle")}</div>
                <div class="text-xs text-neutral-500 dark:text-neutral-400">{t("shareSheet.title")}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={isShareTarget(selectedShortcut)}
                aria-label={t("shortcuts.shareSheetToggle")}
                onclick={handleToggleShareSheet}
                data-testid="shortcut-share-sheet-toggle"
                class="grid h-11 w-11 shrink-0 place-items-center"
              >
                <!-- 命中区 44×44，轨道视觉不变（REQ-A953 / REQ-A387 的同一个形状）。 -->
                <span class="relative block h-5 w-9 rounded-full transition {isShareTarget(selectedShortcut) ? 'bg-blue-600' : 'bg-neutral-300 dark:bg-neutral-600'}">
                  <span class="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all {isShareTarget(selectedShortcut) ? 'left-4' : 'left-0.5'}"></span>
                </span>
              </button>
            </div>
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
      <!-- 快捷指令库（REQ-A500）：预设模板 → 一键装进「我的快捷指令」。
           这里此前只有一句 `🚧 快捷指令库即将推出`，而入口、标题与描述都在 —— 承诺与交付不一致。
           现在渲染的是 `GALLERY_TEMPLATES` 的真实卡片：每张都装得上、跑得动（模板的动作与参数由
           `shortcutGallery.test.ts` 对着 `BUILTIN_ACTIONS` 逐条校验）。 -->
      <div class="space-y-4 p-4">
        <div class="text-center">
          <div class="mb-3 text-5xl">📚</div>
          <h2 class="mb-1 text-xl font-bold text-neutral-900 dark:text-neutral-100">{t("shortcuts.galleryTitle")}</h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            {t("shortcuts.galleryDesc")}
          </p>
        </div>

        {#if galleryNote}
          <!-- 失败读数（成功时按钮自己会变成「已添加」，不维护第二条账）。必须是 live region：
               用户按完按钮焦点还在原处，否则屏幕阅读器不会知道那一下成没成。 -->
          <p class="text-center text-xs text-danger" role="status" data-testid="gallery-note">
            {galleryNote}
          </p>
        {/if}

        <ul class="space-y-3" data-testid="gallery-grid">
          {#each GALLERY_TEMPLATES as tpl (tpl.id)}
            {@const installed = isTemplateInstalled(shortcuts, tpl.id)}
            <li class="flex items-start gap-3 rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
              <span
                class="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-xl"
                style="background-color: {tpl.color}20;"
                aria-hidden="true"
              >
                {tpl.icon}
              </span>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t(tpl.nameKey)}</p>
                <p class="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">{t(tpl.descKey)}</p>
                <p class="mt-1 text-xs text-neutral-500">
                  {t("shortcuts.galleryActionCount", { n: tpl.actions.length })}
                </p>
              </div>
              <button
                onclick={() => installTemplate(tpl)}
                disabled={installed}
                data-testid="gallery-add-{tpl.id}"
                class="shrink-0 rounded-full bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition active:scale-95 disabled:bg-black/10 disabled:text-neutral-500 dark:disabled:bg-white/10 dark:disabled:text-neutral-400"
              >
                {installed ? t("shortcuts.galleryAdded") : t("shortcuts.galleryAdd")}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
</div>

<!-- 新建快捷指令模态框 -->
{#if showNewModal}
  <!-- 遮罩 = 内容后面的一枚真按钮；Escape/焦点陷阱走 `attachFocusTrap`，
       它同时把焦点交给第一个可聚焦元素 ⇒ 不再需要 `autofocus`（REQ-A386）。 -->
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <button
      class="modal-backdrop"
      aria-label={t("shortcuts.close")}
      onclick={() => (showNewModal = false)}
    ></button>
    <div
      class="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-neutral-900"
      bind:this={newModalEl}
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcut-new-title"
      tabindex="-1"
    >
      <h2 id="shortcut-new-title" class="mb-4 text-xl font-bold text-neutral-900 dark:text-neutral-100">{t("shortcuts.createNew")}</h2>
      
      <div class="space-y-4">
        <div>
          <label for={newNameId} class="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">{t("shortcuts.name")}</label>
          <input
            id={newNameId}
            type="text"
            bind:value={newName}
            placeholder={t("shortcuts.createNamePlaceholder")}
            class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
            onkeydown={(e) => { if (e.key === "Enter") handleCreate(); }}
          />
        </div>
        
        <div class="flex gap-3">
          <div class="flex-1">
            <label for={newIconId} class="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">{t("shortcuts.icon")}</label>
            <select
              id={newIconId}
              bind:value={newIcon}
              class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
            >
              {#each SHORTCUT_ICONS as icon}
                <option value={icon}>{icon}</option>
              {/each}
            </select>
          </div>
          
          <div class="flex-1">
            <label for={newColorId} class="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">{t("shortcuts.color")}</label>
            <select
              id={newColorId}
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
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <button
      class="modal-backdrop"
      aria-label={t("shortcuts.close")}
      onclick={() => (showActionPicker = false)}
    ></button>
    <div
      class="relative h-[80vh] w-full max-w-2xl rounded-2xl bg-white shadow-xl dark:bg-neutral-900"
      bind:this={pickerEl}
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcut-picker-title"
      tabindex="-1"
    >
      <div class="flex h-full flex-col">
        <!-- 标题 -->
        <div class="flex items-center justify-between border-b border-neutral-200 p-4 dark:border-neutral-800">
          <h2 id="shortcut-picker-title" class="text-xl font-bold text-neutral-900 dark:text-neutral-100">{t("shortcuts.selectAction")}</h2>
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
  <!-- 运行结果是**用户按了按钮之后**才出现的，而焦点还在那个按钮上 ⇒ 必须是 live region
       （`role="status"` = polite），否则屏幕阅读器用户不会知道跑完没有、成功了没有。 -->
  <div
    class="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 animate-[fadeIn_0.3s_ease-in-out]"
    role="status"
    data-testid="shortcut-execution-result"
  >
    <div class="rounded-full bg-neutral-800 px-6 py-3 text-sm text-white shadow-lg dark:bg-neutral-700">
      {executionResult}
    </div>
  </div>
{/if}

<style>
  /* 模态遮罩：铺满的真按钮（背景在它身上，不在定位容器上）。点它 = 关闭；
     它是 `<button>` ⇒ 键盘可达、有名字，不需要"带 click 的 div"（REQ-A386）。 */
  .modal-backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    cursor: pointer;
    background: rgba(0, 0, 0, 0.5);
  }

  /* 指针契约（REQ-A385）：这两个操作行原来只在 hover 时出现（`opacity-0
     group-hover:opacity-100`），而 opacity-0 **既不挡绘制也不挡命中** ⇒ 手机上
     既看不见、又在原位置留着可点区域，而且触屏根本没有 hover 能把它唤出来。

     现在的规则：指针设备上隐到 hover / 键盘聚焦才出现，且**隐藏时不可命中**
     （`visibility: hidden` 会脱离命中测试，`opacity: 0` 不会）；触屏设备
     （`(hover: hover)` 为假）则**一直显示可点** —— 它没有 hover 可用。 */
  .row-actions {
    display: flex;
    flex-shrink: 0;
    gap: 0.5rem;
  }
  .action-actions {
    display: flex;
    gap: 0.25rem;
  }
  @media (hover: hover) {
    .row-actions,
    .action-actions {
      opacity: 0;
      visibility: hidden;
      transition: opacity 150ms ease, visibility 150ms ease;
    }
    .group:hover .row-actions,
    .group:focus-within .row-actions,
    .group:hover .action-actions,
    .group:focus-within .action-actions {
      opacity: 1;
      visibility: visible;
    }
  }
</style>
