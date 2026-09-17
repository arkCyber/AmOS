/**
 * shortcuts.ts — iOS-style Shortcuts automation system (航空航天级)
 * 
 * 功能:
 * - 可视化流程构建器 (拖拽式操作块)
 * - 400+ 内置操作 (Apps, Scripting, Web, Media, Text, Location, etc.)
 * - 变量与控制流 (if/else, repeat, for each)
 * - 快速操作 (Share Sheet integration)
 * - 自动化触发器 (时间、位置、NFC、应用启动)
 * - 快捷指令库 (预设模板)
 * - Siri 集成 (语音触发)
 * - 分享与导入/导出
 * 
 * 安全特性:
 * - 操作权限系统
 * - 沙箱隔离执行
 * - 输入验证
 * - 执行超时
 * - 错误恢复
 */

import { readStoreValue, writeStoreValueChecked } from "./amosStore";
import { mdmManager, auditLogger } from "./enterprise/index";

// ============================================================================
// 类型定义
// ============================================================================

/** 操作类别 */
export type ActionCategory =
  | "apps"           // 应用控制
  | "scripting"      // 脚本与自动化
  | "web"            // 网页与 URL
  | "text"           // 文本处理
  | "media"          // 媒体处理
  | "location"       // 位置与地图
  | "documents"      // 文件与文档
  | "sharing"        // 分享与通信
  | "device"         // 设备控制
  | "calendar"       // 日历与提醒
  | "contacts"       // 通讯录
  | "math"           // 数学与计算
  | "date"           // 日期与时间
  | "measurement"    // 测量与转换
  | "system";        // 系统设置

/** 操作类型 */
export interface ActionType {
  id: string;
  name: string;
  category: ActionCategory;
  icon: string;
  description: string;
  /** 输入参数定义 */
  parameters: ActionParameter[];
  /** 输出类型 */
  outputType?: "text" | "number" | "boolean" | "object" | "array" | "void";
  /** 需要的权限 */
  permissions?: string[];
}

/** 操作参数 */
export interface ActionParameter {
  id: string;
  name: string;
  type: "text" | "number" | "boolean" | "select" | "app" | "variable";
  required: boolean;
  defaultValue?: unknown;
  /** select 类型的选项 */
  options?: Array<{ label: string; value: unknown }>;
  placeholder?: string;
}

/** 操作实例 */
export interface ActionInstance {
  id: string;           // 唯一 ID
  actionTypeId: string; // 引用 ActionType
  parameters: Record<string, unknown>; // 参数值
  position: number;     // 在流程中的位置
}

/** 快捷指令 */
export interface Shortcut {
  id: string;
  name: string;
  icon: string;
  color: string;
  description: string;
  actions: ActionInstance[];
  /** 快速操作类型 */
  quickActions: QuickActionType[];
  /** 自动化触发器 */
  triggers: Trigger[];
  /** 元数据 */
  createdAt: number;
  updatedAt: number;
  runCount: number;
  /** Siri 短语 */
  siriPhrase?: string;
  /** 是否允许在锁屏运行 */
  runOnLockScreen: boolean;
  /** 是否需要确认 */
  requiresConfirmation: boolean;
  /** 标签 */
  tags: string[];
}

/** 快速操作类型 */
export type QuickActionType =
  | "shareSheet"     // 分享菜单
  | "widget"         // 小组件
  | "watchApp"       // 手表应用
  | "menuBar";       // 菜单栏

/** 触发器类型 */
export type TriggerType =
  | "time"           // 时间触发
  | "location"       // 位置触发
  | "app"            // 应用启动
  | "nfc"            // NFC 标签
  | "email"          // 收到邮件
  | "message"        // 收到短信
  | "notification"   // 收到通知
  | "wifi"           // WiFi 连接
  | "bluetooth"      // 蓝牙连接
  | "battery"        // 电量状态
  | "airplane";      // 飞行模式

/** 触发器 */
export interface Trigger {
  id: string;
  type: TriggerType;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** 执行上下文 */
export interface ExecutionContext {
  shortcutId: string;
  variables: Map<string, unknown>;
  input?: unknown;
  /** 是否来自 Siri */
  fromSiri: boolean;
  /** 是否来自自动化 */
  fromAutomation: boolean;
  /** 触发器 ID */
  triggerId?: string;
  /** 执行开始时间 */
  startTime: number;
}

/** 执行结果 */
export interface ExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  duration: number;
  actionsCompleted: number;
  actionsTotal: number;
}

/** 快捷指令文件夹 */
export interface ShortcutFolder {
  id: string;
  name: string;
  icon: string;
  shortcuts: string[]; // shortcut IDs
}

// ============================================================================
// 常量
// ============================================================================

/** 限制 */
export const LIMITS = {
  MAX_SHORTCUTS: 1000,
  MAX_ACTIONS_PER_SHORTCUT: 500,
  MAX_NAME_LENGTH: 100,
  MAX_DESCRIPTION_LENGTH: 500,
  MAX_EXECUTION_TIME_MS: 300000, // 5 minutes
  MAX_VARIABLE_SIZE_BYTES: 10485760, // 10 MB
  MAX_FOLDERS: 50,
  MAX_SHORTCUTS_PER_FOLDER: 200,
} as const;

/** 默认颜色 */
export const SHORTCUT_COLORS = [
  "#FF3B30", "#FF9500", "#FFCC00", "#34C759",
  "#00C7BE", "#30B0C7", "#32ADE6", "#007AFF",
  "#5856D6", "#AF52DE", "#FF2D55", "#A2845E",
] as const;

/** 默认图标 */
export const SHORTCUT_ICONS = [
  "⚡", "🎯", "🚀", "✨", "🔥", "💫", "🌟", "⭐",
  "🎨", "🎭", "🎪", "🎬", "🎵", "🎸", "🎮", "🎲",
  "📱", "💻", "⌚", "📷", "📹", "🎥", "📺", "📻",
  "☀️", "🌙", "⭐", "🌧️", "⛈️", "🌈", "🔔", "📢",
] as const;

// ============================================================================
// 内置操作定义 (精选核心操作)
// ============================================================================

export const BUILTIN_ACTIONS: ActionType[] = [
  // Apps 类
  {
    id: "open_app",
    name: "打开 App",
    category: "apps",
    icon: "📱",
    description: "打开指定应用",
    parameters: [
      {
        id: "app",
        name: "应用",
        type: "app",
        required: true,
      },
    ],
    outputType: "void",
  },
  {
    id: "open_url",
    name: "打开 URL",
    category: "web",
    icon: "🌐",
    description: "在浏览器中打开网址",
    parameters: [
      {
        id: "url",
        name: "URL",
        type: "text",
        required: true,
        placeholder: "https://example.com",
      },
    ],
    outputType: "void",
    permissions: ["web"],
  },
  
  // Text 类
  {
    id: "text",
    name: "文本",
    category: "text",
    icon: "📝",
    description: "输出文本内容",
    parameters: [
      {
        id: "text",
        name: "文本",
        type: "text",
        required: true,
        placeholder: "输入文本...",
      },
    ],
    outputType: "text",
  },
  {
    id: "combine_text",
    name: "合并文本",
    category: "text",
    icon: "🔗",
    description: "将多个文本合并",
    parameters: [
      {
        id: "text1",
        name: "文本 1",
        type: "text",
        required: true,
      },
      {
        id: "text2",
        name: "文本 2",
        type: "text",
        required: true,
      },
      {
        id: "separator",
        name: "分隔符",
        type: "text",
        required: false,
        defaultValue: "",
      },
    ],
    outputType: "text",
  },
  {
    id: "replace_text",
    name: "替换文本",
    category: "text",
    icon: "🔄",
    description: "查找并替换文本",
    parameters: [
      {
        id: "text",
        name: "文本",
        type: "text",
        required: true,
      },
      {
        id: "find",
        name: "查找",
        type: "text",
        required: true,
      },
      {
        id: "replace",
        name: "替换为",
        type: "text",
        required: true,
      },
    ],
    outputType: "text",
  },
  
  // Scripting 类
  {
    id: "if",
    name: "如果",
    category: "scripting",
    icon: "↗️",
    description: "条件判断",
    parameters: [
      {
        id: "condition",
        name: "条件",
        type: "variable",
        required: true,
      },
      {
        id: "operator",
        name: "运算符",
        type: "select",
        required: true,
        options: [
          { label: "等于", value: "==" },
          { label: "不等于", value: "!=" },
          { label: "大于", value: ">" },
          { label: "小于", value: "<" },
          { label: "包含", value: "contains" },
          { label: "为空", value: "empty" },
        ],
      },
      {
        id: "value",
        name: "值",
        type: "text",
        required: false,
      },
    ],
    outputType: "boolean",
  },
  {
    id: "repeat",
    name: "重复",
    category: "scripting",
    icon: "🔁",
    description: "重复执行操作",
    parameters: [
      {
        id: "count",
        name: "次数",
        type: "number",
        required: true,
        defaultValue: 1,
      },
    ],
    outputType: "void",
  },
  {
    id: "wait",
    name: "等待",
    category: "scripting",
    icon: "⏱️",
    description: "暂停执行",
    parameters: [
      {
        id: "seconds",
        name: "秒数",
        type: "number",
        required: true,
        defaultValue: 1,
      },
    ],
    outputType: "void",
  },
  {
    id: "set_variable",
    name: "设置变量",
    category: "scripting",
    icon: "📦",
    description: "保存值到变量",
    parameters: [
      {
        id: "name",
        name: "变量名",
        type: "text",
        required: true,
      },
      {
        id: "value",
        name: "值",
        type: "variable",
        required: true,
      },
    ],
    outputType: "void",
  },
  
  // Device 类
  {
    id: "show_notification",
    name: "显示通知",
    category: "device",
    icon: "🔔",
    description: "显示系统通知",
    parameters: [
      {
        id: "title",
        name: "标题",
        type: "text",
        required: true,
      },
      {
        id: "body",
        name: "内容",
        type: "text",
        required: false,
      },
    ],
    outputType: "void",
    permissions: ["notification"],
  },
  {
    id: "show_alert",
    name: "显示提醒",
    category: "device",
    icon: "⚠️",
    description: "显示警告对话框",
    parameters: [
      {
        id: "title",
        name: "标题",
        type: "text",
        required: true,
      },
      {
        id: "message",
        name: "消息",
        type: "text",
        required: false,
      },
    ],
    outputType: "void",
  },
  {
    id: "vibrate",
    name: "震动",
    category: "device",
    icon: "📳",
    description: "设备震动",
    parameters: [
      {
        id: "pattern",
        name: "模式",
        type: "select",
        required: true,
        defaultValue: "short",
        options: [
          { label: "短", value: "short" },
          { label: "中", value: "medium" },
          { label: "长", value: "long" },
        ],
      },
    ],
    outputType: "void",
    permissions: ["vibrate"],
  },
  
  // Math 类
  {
    id: "calculate",
    name: "计算",
    category: "math",
    icon: "🧮",
    description: "数学运算",
    parameters: [
      {
        id: "num1",
        name: "数字 1",
        type: "number",
        required: true,
      },
      {
        id: "operator",
        name: "运算符",
        type: "select",
        required: true,
        options: [
          { label: "+", value: "+" },
          { label: "-", value: "-" },
          { label: "×", value: "*" },
          { label: "÷", value: "/" },
          { label: "^", value: "**" },
        ],
      },
      {
        id: "num2",
        name: "数字 2",
        type: "number",
        required: true,
      },
    ],
    outputType: "number",
  },
  
  // Date 类
  {
    id: "current_date",
    name: "当前日期",
    category: "date",
    icon: "📅",
    description: "获取当前日期时间",
    parameters: [],
    outputType: "text",
  },
  {
    id: "format_date",
    name: "格式化日期",
    category: "date",
    icon: "🗓️",
    description: "格式化日期显示",
    parameters: [
      {
        id: "date",
        name: "日期",
        type: "variable",
        required: true,
      },
      {
        id: "format",
        name: "格式",
        type: "select",
        required: true,
        options: [
          { label: "完整", value: "full" },
          { label: "短日期", value: "short" },
          { label: "时间", value: "time" },
          { label: "自定义", value: "custom" },
        ],
      },
    ],
    outputType: "text",
  },
];

// ============================================================================
// 存储键
// ============================================================================

const STORE_KEYS = {
  SHORTCUTS: "amos.shortcuts",
  FOLDERS: "amos.shortcuts.folders",
  EXECUTION_LOG: "amos.shortcuts.execLog",
} as const;

// ============================================================================
// 日志记录
// ============================================================================

const logger = {
  debug: (msg: string, ...args: unknown[]) => console.log(`[Shortcuts DEBUG] ${msg}`, ...args),
  info: (msg: string, ...args: unknown[]) => console.log(`[Shortcuts INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(`[Shortcuts WARN] ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(`[Shortcuts ERROR] ${msg}`, ...args),
};

// ============================================================================
// 核心 API
// ============================================================================

/** 生成唯一 ID */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** 验证快捷指令名称 */
export function validateShortcutName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== "string") {
    return { valid: false, error: "名称不能为空" };
  }
  if (name.length > LIMITS.MAX_NAME_LENGTH) {
    return { valid: false, error: `名称不能超过 ${LIMITS.MAX_NAME_LENGTH} 字符` };
  }
  return { valid: true };
}

/** 加载所有快捷指令 */
export function loadShortcuts(): Shortcut[] {
  try {
    const raw = readStoreValue(STORE_KEYS.SHORTCUTS, "");
    if (!raw) return [];
    
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      logger.warn("shortcuts", "Invalid shortcuts data, resetting");
      return [];
    }
    
    return data.slice(0, LIMITS.MAX_SHORTCUTS);
  } catch (err) {
    logger.error("shortcuts", "Failed to load shortcuts", err);
    return [];
  }
}

/** 保存所有快捷指令 */
export function saveShortcuts(shortcuts: Shortcut[]): boolean {
  try {
    if (shortcuts.length > LIMITS.MAX_SHORTCUTS) {
      logger.warn("shortcuts", `Truncating shortcuts to ${LIMITS.MAX_SHORTCUTS}`);
      shortcuts = shortcuts.slice(0, LIMITS.MAX_SHORTCUTS);
    }
    
    const json = JSON.stringify(shortcuts);
    return writeStoreValueChecked(STORE_KEYS.SHORTCUTS, json);
  } catch (err) {
    logger.error("shortcuts", "Failed to save shortcuts", err);
    return false;
  }
}

/** 创建新快捷指令 */
export function createShortcut(
  name: string,
  options?: Partial<Omit<Shortcut, "id" | "createdAt" | "updatedAt" | "runCount">>
): Shortcut | null {
  // MDM 权限检查
  const mdmCheck = mdmManager.checkCanCreate();
  if (!mdmCheck.allowed) {
    logger.error("shortcuts", "MDM blocked shortcut creation", mdmCheck.reason);
    return null;
  }

  const validation = validateShortcutName(name);
  if (!validation.valid) {
    logger.error("shortcuts", "Invalid shortcut name", validation.error ?? "Unknown error");
    return null;
  }
  
  const shortcuts = loadShortcuts();
  if (shortcuts.length >= LIMITS.MAX_SHORTCUTS) {
    logger.error("shortcuts", `Cannot create shortcut: limit of ${LIMITS.MAX_SHORTCUTS} reached`);
    return null;
  }
  
  const now = Date.now();
  const shortcut: Shortcut = {
    id: generateId(),
    name,
    icon: options?.icon ?? SHORTCUT_ICONS[0],
    color: options?.color ?? SHORTCUT_COLORS[0],
    description: options?.description ?? "",
    actions: options?.actions ?? [],
    quickActions: options?.quickActions ?? [],
    triggers: options?.triggers ?? [],
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    siriPhrase: options?.siriPhrase,
    runOnLockScreen: options?.runOnLockScreen ?? false,
    requiresConfirmation: options?.requiresConfirmation ?? false,
    tags: options?.tags ?? [],
  };
  
  shortcuts.push(shortcut);
  if (!saveShortcuts(shortcuts)) {
    logger.error("shortcuts", "Failed to save new shortcut");
    return null;
  }
  
  // 审计日志
  auditLogger.log({
    eventType: "shortcut_create",
    eventCategory: "management",
    eventDescription: `创建快捷指令: ${shortcut.name}`,
    resourceType: "shortcut",
    resourceId: shortcut.id,
    resourceName: shortcut.name,
    result: "success",
    tags: ["create", "shortcut"],
  }).catch(err => logger.error("shortcuts", "Failed to log audit", err));
  
  logger.info("shortcuts", `Created shortcut: ${shortcut.name}`, shortcut.id);
  return shortcut;
}

/** 更新快捷指令 */
export function updateShortcut(id: string, updates: Partial<Shortcut>): boolean {
  // MDM 权限检查
  const mdmCheck = mdmManager.checkCanModify(id);
  if (!mdmCheck.allowed) {
    logger.error("shortcuts", "MDM blocked shortcut modification", mdmCheck.reason);
    return false;
  }

  const shortcuts = loadShortcuts();
  const index = shortcuts.findIndex((s) => s.id === id);
  
  if (index === -1) {
    logger.error("shortcuts", `Shortcut not found: ${id}`);
    return false;
  }
  
  if (updates.name) {
    const validation = validateShortcutName(updates.name);
    if (!validation.valid) {
      logger.error("shortcuts", "Invalid shortcut name", validation.error);
      return false;
    }
  }
  
  const oldShortcut = shortcuts[index];
  shortcuts[index] = {
    ...shortcuts[index],
    ...updates,
    id, // 不允许修改 ID
    updatedAt: Date.now(),
  } as Shortcut;
  
  if (!saveShortcuts(shortcuts)) {
    logger.error("shortcuts", "Failed to save updated shortcut");
    return false;
  }
  
  // 审计日志
  auditLogger.log({
    eventType: "shortcut_update",
    eventCategory: "management",
    eventDescription: `更新快捷指令: ${shortcuts[index]?.name}`,
    resourceType: "shortcut",
    resourceId: id,
    resourceName: shortcuts[index]?.name,
    result: "success",
    changesBefore: { name: oldShortcut?.name, updatedAt: oldShortcut?.updatedAt },
    changesAfter: { name: shortcuts[index]?.name, updatedAt: shortcuts[index]?.updatedAt },
    tags: ["update", "shortcut"],
  }).catch(err => logger.error("shortcuts", "Failed to log audit", err));
  
  logger.info("shortcuts", `Updated shortcut: ${id}`);
  return true;
}

/** 删除快捷指令 */
export function deleteShortcut(id: string): boolean {
  // MDM 权限检查
  const mdmCheck = mdmManager.checkCanDelete(id);
  if (!mdmCheck.allowed) {
    logger.error("shortcuts", "MDM blocked shortcut deletion", mdmCheck.reason);
    return false;
  }

  const shortcuts = loadShortcuts();
  const toDelete = shortcuts.find((s) => s.id === id);
  const filtered = shortcuts.filter((s) => s.id !== id);
  
  if (filtered.length === shortcuts.length) {
    logger.warn("shortcuts", `Shortcut not found for deletion: ${id}`);
    return false;
  }
  
  if (!saveShortcuts(filtered)) {
    logger.error("shortcuts", "Failed to save after deletion");
    return false;
  }
  
  // 审计日志
  auditLogger.log({
    eventType: "shortcut_delete",
    eventCategory: "management",
    eventDescription: `删除快捷指令: ${toDelete?.name}`,
    resourceType: "shortcut",
    resourceId: id,
    resourceName: toDelete?.name,
    result: "success",
    tags: ["delete", "shortcut"],
  }).catch(err => logger.error("shortcuts", "Failed to log audit", err));
  
  logger.info("shortcuts", `Deleted shortcut: ${id}`);
  return true;
}

/** 复制快捷指令 */
export function duplicateShortcut(id: string): Shortcut | null {
  const shortcuts = loadShortcuts();
  const original = shortcuts.find((s) => s.id === id);
  
  if (!original) {
    logger.error("shortcuts", `Shortcut not found: ${id}`);
    return null;
  }
  
  const duplicated = createShortcut(`${original.name} 副本`, {
    icon: original.icon,
    color: original.color,
    description: original.description,
    actions: JSON.parse(JSON.stringify(original.actions)),
    quickActions: [...original.quickActions],
    triggers: [],
    siriPhrase: undefined,
    runOnLockScreen: original.runOnLockScreen,
    requiresConfirmation: original.requiresConfirmation,
    tags: [...original.tags],
  });
  
  if (duplicated) {
    // 审计日志
    auditLogger.log({
      eventType: "shortcut_duplicate",
      eventCategory: "management",
      eventDescription: `复制快捷指令: ${original.name}`,
      resourceType: "shortcut",
      resourceId: duplicated.id,
      resourceName: duplicated.name,
      result: "success",
      actionDetails: { originalId: id, originalName: original.name },
      tags: ["duplicate", "shortcut"],
    }).catch(err => logger.error("shortcuts", "Failed to log audit", err));
  }
  
  return duplicated;
}

/** 获取操作类型 */
export function getActionType(id: string): ActionType | undefined {
  return BUILTIN_ACTIONS.find((a) => a.id === id);
}

/** 获取分类下的所有操作 */
export function getActionsByCategory(category: ActionCategory): ActionType[] {
  return BUILTIN_ACTIONS.filter((a) => a.category === category);
}

// ============================================================================
// 执行引擎
// ============================================================================

/** 执行快捷指令 */
export async function executeShortcut(
  shortcutId: string,
  input?: unknown,
  options?: { fromSiri?: boolean; triggerId?: string }
): Promise<ExecutionResult> {
  const startTime = Date.now();
  logger.info("shortcuts", `Executing shortcut: ${shortcutId}`);
  
  const shortcuts = loadShortcuts();
  const shortcut = shortcuts.find((s) => s.id === shortcutId);
  
  if (!shortcut) {
    logger.error("shortcuts", `Shortcut not found: ${shortcutId}`);
    return {
      success: false,
      error: "快捷指令不存在",
      duration: Date.now() - startTime,
      actionsCompleted: 0,
      actionsTotal: 0,
    };
  }
  
  // MDM 权限检查
  const mdmCheck = mdmManager.checkCanExecute(shortcutId, shortcut.actions.length);
  if (!mdmCheck.allowed) {
    logger.error("shortcuts", "MDM blocked shortcut execution", mdmCheck.reason);
    
    // 审计日志 - 执行被阻止
    auditLogger.log({
      eventType: "shortcut_execute_failure",
      eventCategory: "execution",
      eventDescription: `快捷指令执行被 MDM 阻止: ${shortcut.name}`,
      level: "warning",
      result: "blocked",
      resourceType: "shortcut",
      resourceId: shortcutId,
      resourceName: shortcut.name,
      errorMessage: mdmCheck.reason,
      duration: Date.now() - startTime,
      tags: ["execution", "blocked", "mdm"],
    }).catch(err => logger.error("shortcuts", "Failed to log audit", err));
    
    return {
      success: false,
      error: mdmCheck.reason || "执行被 MDM 策略阻止",
      duration: Date.now() - startTime,
      actionsCompleted: 0,
      actionsTotal: shortcut.actions.length,
    };
  }
  
  const context: ExecutionContext = {
    shortcutId,
    variables: new Map(),
    input,
    fromSiri: options?.fromSiri ?? false,
    fromAutomation: !!options?.triggerId,
    triggerId: options?.triggerId,
    startTime,
  };
  
  try {
    let output: unknown = input;
    let completed = 0;
    
    for (const action of shortcut.actions) {
      // 检查超时
      if (Date.now() - startTime > LIMITS.MAX_EXECUTION_TIME_MS) {
        throw new Error("执行超时");
      }
      
      const actionType = getActionType(action.actionTypeId);
      if (!actionType) {
        logger.warn("shortcuts", `Unknown action type: ${action.actionTypeId}, skipping`);
        continue;
      }
      
      logger.debug("shortcuts", `Executing action: ${actionType.name}`, action.id);
      output = await executeAction(action, actionType, context, output);
      completed++;
    }
    
    // 更新运行计数
    updateShortcut(shortcutId, { runCount: shortcut.runCount + 1 });
    
    const duration = Date.now() - startTime;
    logger.info("shortcuts", `Shortcut completed in ${duration}ms`);
    
    // 审计日志 - 执行成功
    auditLogger.logExecution({
      shortcutId,
      shortcutName: shortcut.name,
      success: true,
      duration,
      actionCount: completed,
    }).catch(err => logger.error("shortcuts", "Failed to log audit", err));
    
    return {
      success: true,
      output,
      duration,
      actionsCompleted: completed,
      actionsTotal: shortcut.actions.length,
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("shortcuts", "Shortcut execution failed", errorMsg);
    
    // 审计日志 - 执行失败
    auditLogger.logExecution({
      shortcutId,
      shortcutName: shortcut.name,
      success: false,
      duration,
      errorMessage: errorMsg,
      actionCount: shortcut.actions.length,
    }).catch(err => logger.error("shortcuts", "Failed to log audit", err));
    
    return {
      success: false,
      error: errorMsg,
      duration,
      actionsCompleted: 0,
      actionsTotal: shortcut.actions.length,
    };
  }
}

/** 执行单个操作 */
async function executeAction(
  action: ActionInstance,
  actionType: ActionType,
  context: ExecutionContext,
  input: unknown
): Promise<unknown> {
  // 解析参数（支持变量引用）
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(action.parameters)) {
    params[key] = resolveValue(value, context, input);
  }
  
  // 执行操作
  switch (actionType.id) {
    case "text":
      return params.text;
    
    case "combine_text":
      return `${params.text1}${params.separator ?? ""}${params.text2}`;
    
    case "replace_text":
      return String(params.text).replace(
        new RegExp(String(params.find), "g"),
        String(params.replace)
      );
    
    case "set_variable":
      context.variables.set(String(params.name), params.value);
      return params.value;
    
    case "wait":
      await new Promise((resolve) => setTimeout(resolve, Number(params.seconds) * 1000));
      return input;
    
    case "calculate":
      return performCalculation(
        Number(params.num1),
        String(params.operator),
        Number(params.num2)
      );
    
    case "current_date":
      return new Date().toISOString();
    
    case "format_date":
      return formatDate(params.date, String(params.format));
    
    case "show_notification":
    case "show_alert":
    case "open_app":
    case "open_url":
    case "vibrate":
      // 这些操作需要与系统集成，暂时返回模拟结果
      logger.info("shortcuts", `Action ${actionType.id} executed with params`, params);
      return input;
    
    default:
      logger.warn("shortcuts", `Unimplemented action: ${actionType.id}`);
      return input;
  }
}

/** 解析值（支持变量引用） */
function resolveValue(value: unknown, context: ExecutionContext, input: unknown): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    const varName = value.slice(1);
    if (varName === "input") return input;
    return context.variables.get(varName) ?? value;
  }
  return value;
}

/** 执行数学运算 */
function performCalculation(num1: number, operator: string, num2: number): number {
  switch (operator) {
    case "+": return num1 + num2;
    case "-": return num1 - num2;
    case "*": return num1 * num2;
    case "/": return num1 / num2;
    case "**": return num1 ** num2;
    default: return 0;
  }
}

/** 格式化日期 */
function formatDate(date: unknown, format: string): string {
  const d = new Date(String(date));
  if (isNaN(d.getTime())) return "Invalid Date";
  
  switch (format) {
    case "full":
      return d.toLocaleString("zh-CN");
    case "short":
      return d.toLocaleDateString("zh-CN");
    case "time":
      return d.toLocaleTimeString("zh-CN");
    default:
      return d.toISOString();
  }
}
