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

import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "./amosStore";
import { localId } from "./localId";
import { mdmManager, auditLogger } from "./enterprise/index";
import { invoke } from "./backend";
import { clipboardRead, clipboardWrite } from "./clipboard";
import { NOTIF_CAP, NOTIF_KEY, addNotif, newNotifId, type Notif } from "./settings";
import { sanitizeUrl } from "./webman";

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
  /**
   * 控制流子操作（`if` 的 then 分支 / `repeat` / `for_each` 的循环体）。
   *
   * 旧数据没有这个字段（`undefined`），执行器按"没有子操作"处理 —— 嵌套是
   * **可选的**，所以一个扁平格式的快捷指令仍然是完全合法的。
   */
  children?: ActionInstance[];
  /** `if` 的 else 分支。`if` 之外的操作用不到。 */
  elseChildren?: ActionInstance[];
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

/**
 * 一次"信号"—— 触发器的输入。
 *
 * 触发器判定被拆成**纯函数**（`triggerMatches`），所以它不订阅任何东西：宿主把
 * 现实世界的事件（`online`/`offline`、电池变化、窗口打开、定时器到点……）翻译成
 * `TriggerEvent`，`ShortcutTriggerRuntime` 只负责把事件喂给匹配器。这样时区、星期、
 * 电量阈值这些容易写错的规则可以在纯 bun 环境里逐条钉死。
 */
export interface TriggerEvent {
  /** 事件对应的触发器类型。 */
  type: TriggerType;
  /** 事件发生时刻（毫秒）。时间触发器的"哪一分钟"由它决定。 */
  at: number;
  /**
   * 事件携带的事实（按类型）：
   * - `app` → `{ appId, event: "open" | "close" }`
   * - `wifi` → `{ ssid, connected }`
   * - `bluetooth` → `{ deviceName, connected }`
   * - `battery` → `{ levelPct, charging }`
   * - `location` → `{ latitude, longitude, action: "arrive" | "leave" }`
   * - `nfc` → `{ tagId }`
   * - `airplane` → `{ enabled }`
   * - `notification` → `{ app, title, body }`
   * - `email` / `message` → `{ from, subject/body }`
   */
  data?: Record<string, unknown>;
}

/** 执行上下文 */
export interface ExecutionContext {
  shortcutId: string;
  variables: Map<string, unknown>;
  input?: unknown;
  /** 上一步的输出（供 `{output}` 插值使用）。每执行一步刷新。 */
  output?: unknown;
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
  /** 控制流最大嵌套深度 —— 防止 `if`/`repeat` 互相嵌套到栈溢出。 */
  MAX_CONTROL_DEPTH: 10,
  /** 单个 `repeat` 的最大迭代次数 —— 防止 `repeat 10000000` 冻死界面。 */
  MAX_REPEAT_ITERATIONS: 10000,
  /** `list` / `for_each` 之后单个列表的最大长度。 */
  MAX_LIST_ITEMS: 5000,
  /** 执行日志保留条数（`SHORTCUT_EXEC_LOG_KEY`）。 */
  MAX_EXEC_LOG_ENTRIES: 200,
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

  // ---- Scripting: 变量 ----
  {
    id: "get_variable",
    name: "获取变量",
    category: "scripting",
    icon: "📥",
    description: "读取一个变量的当前值",
    parameters: [
      {
        id: "name",
        name: "变量名",
        type: "text",
        required: true,
        placeholder: "myVar",
      },
    ],
    outputType: "text",
  },
  {
    id: "add_to_variable",
    name: "追加到变量",
    category: "scripting",
    icon: "➕",
    description: "把一个值追加到变量的末尾（文本拼接 / 列表追加）",
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

  // ---- Scripting: 列表 ----
  {
    id: "list",
    name: "列表",
    category: "scripting",
    icon: "📋",
    description: "把一段文本按分隔符拆成一个列表",
    parameters: [
      {
        id: "items",
        name: "内容",
        type: "text",
        required: true,
        placeholder: "第一项\n第二项",
      },
      {
        id: "separator",
        name: "分隔符",
        type: "text",
        required: false,
        defaultValue: "\n",
      },
    ],
    outputType: "array",
  },
  {
    id: "count_items",
    name: "项目数",
    category: "scripting",
    icon: "🔢",
    description: "统计列表中的项目数量",
    parameters: [],
    outputType: "number",
  },
  {
    id: "get_list_item",
    name: "获取列表项",
    category: "scripting",
    icon: "📎",
    description: "取出列表中指定位置的项目（从 1 开始）",
    parameters: [
      {
        id: "index",
        name: "位置",
        type: "number",
        required: true,
        defaultValue: 1,
      },
    ],
    outputType: "text",
  },
  {
    id: "join_list",
    name: "合并列表",
    category: "scripting",
    icon: "🧵",
    description: "用分隔符把列表拼成一段文本",
    parameters: [
      {
        id: "separator",
        name: "分隔符",
        type: "text",
        required: false,
        defaultValue: ", ",
      },
    ],
    outputType: "text",
  },

  // ---- Scripting: 控制流 ----
  {
    id: "for_each",
    name: "对每一项重复",
    category: "scripting",
    icon: "🔂",
    description: "遍历一个列表，对每一项执行子操作",
    parameters: [
      {
        id: "itemName",
        name: "项目变量名",
        type: "text",
        required: false,
        defaultValue: "item",
      },
      {
        id: "indexName",
        name: "序号变量名",
        type: "text",
        required: false,
        defaultValue: "index",
      },
    ],
    outputType: "array",
  },
  {
    id: "stop_shortcut",
    name: "停止此快捷指令",
    category: "scripting",
    icon: "⏹️",
    description: "立即结束整条快捷指令",
    parameters: [],
    outputType: "void",
  },

  // ---- Text 补充 ----
  {
    id: "split_text",
    name: "拆分文本",
    category: "text",
    icon: "✂️",
    description: "按分隔符把文本拆成列表",
    parameters: [
      {
        id: "text",
        name: "文本",
        type: "text",
        required: true,
      },
      {
        id: "separator",
        name: "分隔符",
        type: "text",
        required: true,
        defaultValue: ",",
      },
    ],
    outputType: "array",
  },
  {
    id: "text_case",
    name: "更改大小写",
    category: "text",
    icon: "🔠",
    description: "把文本转换为大写 / 小写 / 首字母大写",
    parameters: [
      {
        id: "text",
        name: "文本",
        type: "text",
        required: true,
      },
      {
        id: "mode",
        name: "方式",
        type: "select",
        required: true,
        defaultValue: "upper",
        options: [
          { label: "大写", value: "upper" },
          { label: "小写", value: "lower" },
          { label: "首字母大写", value: "title" },
        ],
      },
    ],
    outputType: "text",
  },
  {
    id: "trim_text",
    name: "修剪空白",
    category: "text",
    icon: "🧹",
    description: "去掉文本首尾的空白字符",
    parameters: [
      {
        id: "text",
        name: "文本",
        type: "text",
        required: true,
      },
    ],
    outputType: "text",
  },

  // ---- Math 补充 ----
  {
    id: "round_number",
    name: "取整",
    category: "math",
    icon: "🔵",
    description: "把数字四舍五入到指定小数位",
    parameters: [
      {
        id: "number",
        name: "数字",
        type: "number",
        required: true,
      },
      {
        id: "places",
        name: "小数位",
        type: "number",
        required: false,
        defaultValue: 0,
      },
    ],
    outputType: "number",
  },
  {
    id: "random_number",
    name: "随机数",
    category: "math",
    icon: "🎲",
    description: "在区间内取一个随机整数（含两端）",
    parameters: [
      {
        id: "min",
        name: "最小值",
        type: "number",
        required: true,
        defaultValue: 1,
      },
      {
        id: "max",
        name: "最大值",
        type: "number",
        required: true,
        defaultValue: 100,
      },
    ],
    outputType: "number",
  },

  // ---- Date 补充 ----
  {
    id: "adjust_date",
    name: "调整日期",
    category: "date",
    icon: "🕰️",
    description: "在日期上加减一段时间，输出 ISO 字符串",
    parameters: [
      {
        id: "date",
        name: "日期",
        type: "variable",
        required: true,
      },
      {
        id: "amount",
        name: "数量",
        type: "number",
        required: true,
        defaultValue: 1,
      },
      {
        id: "unit",
        name: "单位",
        type: "select",
        required: true,
        defaultValue: "days",
        options: [
          { label: "秒", value: "seconds" },
          { label: "分钟", value: "minutes" },
          { label: "小时", value: "hours" },
          { label: "天", value: "days" },
          { label: "月", value: "months" },
          { label: "年", value: "years" },
        ],
      },
    ],
    outputType: "text",
  },

  // ---- Device 补充 ----
  {
    id: "copy_to_clipboard",
    name: "拷贝到剪贴板",
    category: "device",
    icon: "📋",
    description: "把文本写入系统剪贴板",
    parameters: [
      {
        id: "text",
        name: "文本",
        type: "text",
        required: true,
      },
    ],
    outputType: "void",
    permissions: ["clipboard"],
  },
  {
    id: "get_clipboard",
    name: "获取剪贴板",
    category: "device",
    icon: "📄",
    description: "读取系统剪贴板中的文本（需要前台窗口）",
    parameters: [],
    outputType: "text",
    permissions: ["clipboard"],
  },
];

// ============================================================================
// 存储键
//
// 每个键都以**具名常量**导出：`lib/cloud.ts` 的 `SYNC_STORES` 只允许引用模块
// 自己的键常量，不许重写字面量（历史上重写导致 `amos.files.fav` 与
// `FILES_FAV_KEY` 不匹配、备份静默漏掉一个 store）。
// ============================================================================

export const SHORTCUTS_KEY = "amos.shortcuts";
export const SHORTCUT_FOLDERS_KEY = "amos.shortcuts.folders";
export const SHORTCUT_EXEC_LOG_KEY = "amos.shortcuts.execLog";

const STORE_KEYS = {
  SHORTCUTS: SHORTCUTS_KEY,
  FOLDERS: SHORTCUT_FOLDERS_KEY,
  EXECUTION_LOG: SHORTCUT_EXEC_LOG_KEY,
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

/**
 * 生成唯一 ID。
 *
 * 走共享的 `localId`（REQ-A401）。旧写法 `${Date.now()}-${Math.random()…}` 与
 * `ShortcutsApp.svelte` 里动作 id 的那份是同一族"时间 + 运气"；而快捷指令 id 是
 * 持久化行的身份（`updateShortcut` / `deleteShortcut` / `duplicateShortcut` 全按它匹配）。
 */
function generateId(): string {
  return localId("sc");
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

/**
 * `stop_shortcut` 的控制流信号。
 *
 * 它必须**穿透**任意深度的嵌套（`repeat` 里套 `if` 里套 `stop_shortcut`），所以用
 * 抛出而不是返回值。与"失败"严格区分：`executeShortcut` 捕获它并记为 **成功**，
 * 输出就是抛出时那一步的管道值。
 */
class StopSignal {
  constructor(readonly output: unknown) {}
}

/** 一次运行的累计状态（在递归里共享，所以 `stop` 展开时计数不丢）。 */
interface RunState {
  completed: number;
}

/** 一条被触发器**跳过**（而不是失败）的指令 + 原因。 */
export interface SkippedShortcut {
  shortcutId: string;
  triggerId: string;
  reason: string;
}

/** `executeShortcut` 的调用选项。 */
export interface ExecuteOptions {
  fromSiri?: boolean;
  triggerId?: string;
  /** 用户已在确认对话框里按过"运行"（`requiresConfirmation` 的指令需要它）。 */
  confirmed?: boolean;
  /** 当前是否锁屏（`runOnLockScreen === false` 的指令在锁屏下会被拒绝）。 */
  locked?: boolean;
}

/** 执行快捷指令 */
export async function executeShortcut(
  shortcutId: string,
  input?: unknown,
  options?: ExecuteOptions
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
  
  const total = countActions(shortcut.actions);

  /**
   * 两条"先问再做"的门禁。它们以前**根本不存在**：`requiresConfirmation` 与
   * `runOnLockScreen` 只是数据，UI 也没人读 —— 用户勾了"运行前确认"，指令照样
   * 从自动化里无声跑掉。现在两个字段都在**唯一**的执行入口生效。
   */
  if (shortcut.requiresConfirmation && options?.confirmed !== true) {
    logger.warn("shortcuts", `Confirmation required before running ${shortcut.name}`);
    return {
      success: false,
      error: "运行前需要确认",
      duration: Date.now() - startTime,
      actionsCompleted: 0,
      actionsTotal: total,
    };
  }
  if (options?.locked === true && !shortcut.runOnLockScreen) {
    logger.warn("shortcuts", `Locked screen blocks ${shortcut.name}`);
    return {
      success: false,
      error: "锁屏状态下不允许运行",
      duration: Date.now() - startTime,
      actionsCompleted: 0,
      actionsTotal: total,
    };
  }
  
  // MDM 权限检查
  const mdmCheck = mdmManager.checkCanExecute(shortcutId, total);
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
      actionsTotal: total,
    };
  }
  
  const context: ExecutionContext = {
    shortcutId,
    variables: new Map(),
    input,
    output: input,
    fromSiri: options?.fromSiri ?? false,
    fromAutomation: !!options?.triggerId,
    triggerId: options?.triggerId,
    startTime,
  };
  const state: RunState = { completed: 0 };

  try {
    const output = await runActions(shortcut.actions, context, input, state, 0);
    
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
      actionCount: state.completed,
    }).catch(err => logger.error("shortcuts", "Failed to log audit", err));
    appendExecutionLog({
      shortcutId,
      shortcutName: shortcut.name,
      triggerId: options?.triggerId,
      success: true,
      duration,
      actionsCompleted: state.completed,
      actionsTotal: total,
      at: startTime,
    });
    
    return {
      success: true,
      output,
      duration,
      actionsCompleted: state.completed,
      actionsTotal: total,
    };
  } catch (err) {
    const duration = Date.now() - startTime;

    /**
     * `stop_shortcut` 不是失败：它是一条指令**要求**自己结束。把它和异常混在一起
     * 会让"到此为止"在用户眼里变成红色错误（iOS 上它是正常完成）。
     */
    if (err instanceof StopSignal) {
      updateShortcut(shortcutId, { runCount: shortcut.runCount + 1 });
      logger.info("shortcuts", `Shortcut stopped early after ${state.completed} actions`);
      auditLogger.logExecution({
        shortcutId,
        shortcutName: shortcut.name,
        success: true,
        duration,
        actionCount: state.completed,
      }).catch(e => logger.error("shortcuts", "Failed to log audit", e));
      appendExecutionLog({
        shortcutId,
        shortcutName: shortcut.name,
        triggerId: options?.triggerId,
        success: true,
        duration,
        actionsCompleted: state.completed,
        actionsTotal: total,
        at: startTime,
        stopped: true,
      });
      return {
        success: true,
        output: err.output,
        duration,
        actionsCompleted: state.completed,
        actionsTotal: total,
      };
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("shortcuts", "Shortcut execution failed", errorMsg);
    
    // 审计日志 - 执行失败
    auditLogger.logExecution({
      shortcutId,
      shortcutName: shortcut.name,
      success: false,
      duration,
      errorMessage: errorMsg,
      actionCount: total,
    }).catch(err => logger.error("shortcuts", "Failed to log audit", err));
    appendExecutionLog({
      shortcutId,
      shortcutName: shortcut.name,
      triggerId: options?.triggerId,
      success: false,
      duration,
      actionsCompleted: state.completed,
      actionsTotal: total,
      error: errorMsg,
      at: startTime,
    });
    
    return {
      success: false,
      error: errorMsg,
      duration,
      actionsCompleted: state.completed,
      actionsTotal: total,
    };
  }
}

/**
 * 递归执行一串操作，返回管道输出。
 *
 * 控制流（`if` / `repeat` / `for_each` / `stop_shortcut`）**在这里**处理而不是放进
 * `executeAction`：它们需要 `children` 和递归，而 `executeAction` 只负责"一步"。
 * `depth` 是嵌套深度护栏（`LIMITS.MAX_CONTROL_DEPTH`）—— 一份手改过 / 导入的 JSON
 * 可以自引用到栈溢出，这里是拒它的地方。
 */
async function runActions(
  actions: ActionInstance[],
  context: ExecutionContext,
  input: unknown,
  state: RunState,
  depth: number
): Promise<unknown> {
  if (depth > LIMITS.MAX_CONTROL_DEPTH) {
    throw new Error(`控制流嵌套超过 ${LIMITS.MAX_CONTROL_DEPTH} 层`);
  }

  let output: unknown = input;

  for (const action of actions) {
    if (Date.now() - context.startTime > LIMITS.MAX_EXECUTION_TIME_MS) {
      throw new Error("执行超时");
    }

    const actionType = getActionType(action.actionTypeId);
    if (!actionType) {
      logger.warn("shortcuts", `Unknown action type: ${action.actionTypeId}, skipping`);
      continue;
    }

    logger.debug("shortcuts", `Executing action: ${actionType.name}`, action.id);

    const params = resolveParameters(action, context, output);

    switch (actionType.id) {
      case "if": {
        const taken = evaluateCondition(params, output) ? action.children : action.elseChildren;
        state.completed++;
        context.output = output;
        output = await runActions(taken ?? [], context, output, state, depth + 1);
        break;
      }

      case "repeat": {
        const count = clampIterations(Number(params.count));
        state.completed++;
        for (let i = 0; i < count; i++) {
          context.variables.set("repeatIndex", i + 1);
          output = await runActions(action.children ?? [], context, output, state, depth + 1);
        }
        break;
      }

      case "for_each": {
        const itemName = String(params.itemName ?? "item") || "item";
        const indexName = String(params.indexName ?? "index") || "index";
        const list = toList(output);
        state.completed++;
        const results: unknown[] = [];
        for (let i = 0; i < list.length; i++) {
          context.variables.set(itemName, list[i]);
          context.variables.set(indexName, i + 1);
          results.push(await runActions(action.children ?? [], context, list[i], state, depth + 1));
        }
        output = results;
        break;
      }

      case "stop_shortcut":
        state.completed++;
        throw new StopSignal(output);

      default:
        output = await executeAction(actionType, params, context, output);
        state.completed++;
        break;
    }

    context.output = output;
  }

  return output;
}

/** 解析一步操作的全部参数（含变量引用），控制流与普通操作共用同一份求值规则。 */
function resolveParameters(
  action: ActionInstance,
  context: ExecutionContext,
  input: unknown
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(action.parameters)) {
    params[key] = resolveValue(value, context, input);
  }
  return params;
}

/**
 * 统计一棵操作树里的操作总数（含控制流子操作）。
 *
 * 与 `actionsCompleted` 用同一棵树，容器操作自己也算一个（它确实被执行了）。旧实现
 * 只数顶层并把 `shortcut.actions.length` 直接当总数 —— 嵌套之后就会出现
 * "完成 12 / 共 1" 这种自相矛盾的读数。
 */
function countActions(actions: ActionInstance[]): number {
  let n = 0;
  for (const a of actions) {
    n += 1;
    if (a.children) n += countActions(a.children);
    if (a.elseChildren) n += countActions(a.elseChildren);
  }
  return n;
}

/** 迭代次数护栏：非有限 / 负数 / 超上限一律夹到合法区间。 */
function clampIterations(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), LIMITS.MAX_REPEAT_ITERATIONS);
}

/** 把任意管道值看成列表（`for_each` / `count_items` / `join_list` 共用）。 */
function toList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.slice(0, LIMITS.MAX_LIST_ITEMS);
  if (value === null || value === undefined) return [];
  return [value];
}

/**
 * `if` 的条件求值（导出为纯函数，便于单测逐条钉）。
 *
 * 支持 `== != > < contains empty`；缺省运算符时按 JavaScript 真值判断。比较是
 * **弱比较**（`"3" == 3` 为真）—— 参数在表单里是字符串、变量可能是数字，强比较会
 * 让用户看不到任何差别却得到相反的分支。
 */
export function evaluateCondition(
  params: Record<string, unknown>,
  input: unknown
): boolean {
  const left = params.condition === undefined ? input : params.condition;
  const op = typeof params.operator === "string" ? params.operator : "";
  const right = params.value;

  switch (op) {
    case "==":
      // eslint-disable-next-line eqeqeq -- 见上面的弱比较说明
      return left == right;
    case "!=":
      // eslint-disable-next-line eqeqeq
      return left != right;
    case ">":
      return Number(left) > Number(right);
    case "<":
      return Number(left) < Number(right);
    case "contains":
      return String(left ?? "").includes(String(right ?? ""));
    case "empty":
      return toList(left).length === 0 || String(left ?? "") === "";
    default:
      return Boolean(left);
  }
}

/** 执行单个操作（参数已解析；控制流不在这里，见 `runActions`）。 */
async function executeAction(
  actionType: ActionType,
  params: Record<string, unknown>,
  context: ExecutionContext,
  input: unknown
): Promise<unknown> {
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

    case "split_text":
      return splitText(params.text, String(params.separator ?? ","));

    case "text_case": {
      const s = String(params.text ?? "");
      switch (String(params.mode)) {
        case "lower":
          return s.toLowerCase();
        case "title":
          return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
        default:
          return s.toUpperCase();
      }
    }

    case "trim_text":
      return String(params.text ?? "").trim();
    
    case "set_variable":
      context.variables.set(String(params.name), params.value);
      return params.value;

    case "get_variable": {
      const name = String(params.name ?? "");
      // 未定义时给空串（而不是 `undefined`）：接在后面的文本操作会拿到 "undefined"。
      return context.variables.has(name) ? context.variables.get(name) : "";
    }

    case "add_to_variable": {
      const name = String(params.name ?? "");
      const existing = context.variables.get(name);
      if (existing === undefined) {
        context.variables.set(name, params.value);
      } else if (Array.isArray(existing)) {
        context.variables.set(name, [...existing, params.value].slice(0, LIMITS.MAX_LIST_ITEMS));
      } else {
        context.variables.set(name, `${stringify(existing)}${stringify(params.value)}`);
      }
      return input;
    }

    case "list":
      return splitText(params.items, String(params.separator ?? "\n"));

    case "count_items":
      return toList(input).length;

    case "get_list_item": {
      const list = toList(input);
      const raw = Math.trunc(Number(params.index ?? 1));
      // iOS 用 1 起；负数从末尾数（-1 = 最后一项）。
      const idx = raw < 0 ? list.length + raw : raw - 1;
      return idx >= 0 && idx < list.length ? list[idx] : "";
    }

    case "join_list":
      return toList(input).map(stringify).join(String(params.separator ?? ", "));
    
    case "wait":
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(params.seconds) * 1000)));
      return input;
    
    case "calculate":
      return performCalculation(
        Number(params.num1),
        String(params.operator),
        Number(params.num2)
      );

    case "round_number": {
      const n = Number(params.number);
      if (!Number.isFinite(n)) return 0;
      const places = Math.min(Math.max(Math.trunc(Number(params.places ?? 0)), 0), 20);
      return Number(n.toFixed(places));
    }

    case "random_number": {
      const a = Math.trunc(Number(params.min));
      const b = Math.trunc(Number(params.max));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return lo + Math.floor(Math.random() * (hi - lo + 1));
    }
    
    case "current_date":
      return new Date().toISOString();
    
    case "format_date":
      return formatDate(params.date, String(params.format));

    case "adjust_date":
      return adjustDate(params.date, Number(params.amount), String(params.unit));
    
    // ------------------------------------------------------------------
    // 系统集成：这四个以前是 `logger.info(...) + return input`（即什么都没做）
    // ------------------------------------------------------------------

    case "show_notification":
      postNotification(params.title, params.body, "⚡");
      return input;

    case "show_alert":
      // AmOS 没有模态框系统；"警告"落成通知中心里一条 ⚠️ 记录 —— 至少是**用户看得见**的，
      // 而不是控制台里的一行日志（旧实现就是后者）。
      postNotification(params.title, params.message, "⚠️");
      return input;

    case "open_app": {
      const appId = String(params.app ?? "").trim();
      if (!appId) throw new Error("打开 App 需要应用标识");
      // `wm_open` 是桌面形态建窗口 / 移动形态路由的唯一入口（与 Launchpad/Spotlight 同一命令）。
      // 桥不在（纯浏览器 / 单测）时返回 null —— 如实记一条警告，不假装打开了。
      const opened = await invoke<unknown>("wm_open", { label: appId });
      if (opened === null) logger.warn("shortcuts", `open_app: wm_open(${appId}) not bridged`);
      return input;
    }

    case "open_url": {
      const raw = String(params.url ?? "");
      const checked = sanitizeUrl(raw);
      if (!checked.valid) throw new Error(`URL 无效: ${checked.error ?? raw}`);
      openExternal(raw.trim());
      return input;
    }

    case "vibrate":
      vibrate(String(params.pattern ?? "short"));
      return input;

    case "copy_to_clipboard":
      // 剪贴板写入失败（无桥 / 非前台）不影响指令本身：返回管道值，让后续步骤继续。
      await clipboardWrite({ kind: "text", text: stringify(params.text) }, "shortcuts");
      return input;

    case "get_clipboard": {
      const entry = await clipboardRead();
      return entry ? clipboardText(entry.payload) : "";
    }
    
    default:
      logger.warn("shortcuts", `Unimplemented action: ${actionType.id}`);
      return input;
  }
}

/**
 * 分辨并取出一个变量。
 *
 * 三个"内置"引用与变量同名时**内置优先**：`{input}` / `{output}` / `{date}` 是文档里
 * 承诺的名字，用户建一个叫 `input` 的变量不该把它顶掉。
 */
function lookupVariable(name: string, context: ExecutionContext, input: unknown): unknown {
  switch (name) {
    case "input":
      return input;
    case "output":
      return context.output;
    case "date":
      return new Date().toLocaleDateString();
    case "time":
      return new Date().toLocaleTimeString();
    default:
      return context.variables.get(name);
  }
}

/** 变量名的字符集：字母数字下划线点（`user.name` 也是合法变量名）。 */
const VAR_NAME = "[A-Za-z_$][\\w$]*(?:\\.[\\w$]+)*";

/**
 * 解析一个值里的变量引用（导出给测试逐条钉）。
 *
 * 两族写法，语义**故意不同**：
 *
 * 1. **整串引用** —— `"$name"` / `"${name}"`：返回变量**原值**（数字还是数字、列表还是
 *    列表）。`"$x"` 里 `x` 不存在时按旧行为回落到字面量 `"$x"`，而不是 `undefined`。
 * 2. **嵌入插值** —— `"总计 ${total} 元"`：把变量**转成文本**填进去。`{}`（不带 `$`）
 *    与 `${}` 等价，兼容开发者指南里 `resolveValue` 的旧写法。
 *
 * 数组 / 对象**递归**解析（列表参数里也能用变量）。普通文本里的 `$5` 不会被吃掉 ——
 * 嵌入形式必须带花括号。
 */
export function resolveValue(
  value: unknown,
  context: ExecutionContext,
  input: unknown = context.input
): unknown {
  if (typeof value === "string") {
    const whole = /^\$?\{([^}]+)\}$/.exec(value);
    if (whole?.[1] !== undefined) return lookupVariable(whole[1].trim(), context, input);

    const bare = new RegExp(`^\\$(${VAR_NAME})$`).exec(value);
    if (bare?.[1] !== undefined) {
      const resolved = lookupVariable(bare[1], context, input);
      return resolved === undefined ? value : resolved;
    }

    // 整串没有引用就直接返回，省掉一次正则扫描。
    if (!value.includes("{")) return value;

    return value.replace(/\$?\{([^}]+)\}/g, (match, name: string) => {
      const resolved = lookupVariable(name.trim(), context, input);
      return resolved === undefined ? match : stringify(resolved);
    });
  }

  if (Array.isArray(value)) return value.map((v) => resolveValue(v, context, input));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, context, input);
    }
    return out;
  }
  return value;
}

/** 把任意值转成文本（`undefined`/`null` → 空串，绝不写出 "undefined"）。 */
function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** 按分隔符拆成列表；空串拆出空列表（不是 `[""]`）。 */
function splitText(text: unknown, separator: string): string[] {
  const s = stringify(text);
  if (s === "") return [];
  const parts = separator === "" ? [...s] : s.split(separator);
  return parts.slice(0, LIMITS.MAX_LIST_ITEMS);
}

/**
 * 写入通知中心的唯一入口。
 *
 * 快捷指令的通知没有自己的列表：它**投影**进 `amos.notifications`，于是
 * `NotificationCenter` / `NotificationBanner`（横幅、提示音、触感、免打扰门禁）自动
 * 全部生效 —— 与 push 通知走的是同一个商店（`pushNotifBridge` 的同一决策）。
 */
function postNotification(title: unknown, body: unknown, icon: string): void {
  const n: Notif = {
    id: newNotifId(),
    app: "快捷指令",
    icon,
    title: stringify(title) || "快捷指令",
    body: stringify(body),
    time: Date.now(),
    source: "system",
  };
  const existing = readStoreValue<Notif[]>(NOTIF_KEY, []);
  const next = Array.isArray(existing) ? addNotif(existing, n).slice(0, NOTIF_CAP) : [n];
  writeStoreValue(NOTIF_KEY, next);
}

/**
 * 打开外部链接。
 *
 * 用宿主的 `open`（桌面 WebView 会把 http(s) 交给系统浏览器）。宿主没有 `open`
 * 时**如实记一条警告**，不假装打开了 —— 这个函数以前是一个可注入的 seam，但那个
 * seam 没有任何生产调用点（unwired 门禁抓到的正是"定义了、测过了、从没接线"），
 * 所以它被删掉了：需要换出口时再把它接上，而不是先留一个空接口。
 */
function openExternal(url: string): void {
  const w = (globalThis as { open?: (u: string, t?: string, f?: string) => unknown }).open;
  if (typeof w === "function") {
    w(url, "_blank", "noopener,noreferrer");
    return;
  }
  logger.warn("shortcuts", `open_url: no opener available for ${url}`);
}

/** 触感震动。宿主没有振动器（桌面 / 无头测试）时安静跳过。 */
function vibrate(pattern: string): void {
  const vibrateFn = (globalThis as { navigator?: { vibrate?: (p: number | number[]) => boolean } })
    .navigator?.vibrate;
  if (typeof vibrateFn !== "function") return;
  const patterns: Record<string, number[]> = {
    short: [80],
    medium: [200],
    long: [500],
  };
  try {
    vibrateFn.call(
      (globalThis as { navigator?: unknown }).navigator,
      patterns[pattern] ?? [80]
    );
  } catch {
    /* 振动权限被拒 —— 不影响指令其余部分 */
  }
}

/** 从剪贴板载荷里取纯文本（图片等非文本表示返回空串）。 */
function clipboardText(payload: { kind: string } & Record<string, unknown>): string {
  switch (payload.kind) {
    case "text":
      return stringify(payload.text);
    case "html":
      return stringify(payload.plain ?? payload.html);
    case "uris":
      return stringify(payload.text ?? (payload.uris as string[] | undefined)?.join("\n"));
    default:
      return "";
  }
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

/**
 * 在日期上加减一段时间，输出 ISO 字符串。
 *
 * 月 / 年走 `setMonth`/`setFullYear`（日历语义：1 月 31 日 + 1 月 = 3 月 3 日），
 * 其余走毫秒数。非法输入返回 `"Invalid Date"` —— 与 `formatDate` 同一约定。
 */
function adjustDate(date: unknown, amount: number, unit: string): string {
  const d = new Date(String(date));
  if (isNaN(d.getTime())) return "Invalid Date";
  const n = Number.isFinite(amount) ? amount : 0;

  switch (unit) {
    case "months":
      d.setMonth(d.getMonth() + n);
      break;
    case "years":
      d.setFullYear(d.getFullYear() + n);
      break;
    case "seconds":
      d.setTime(d.getTime() + n * 1000);
      break;
    case "minutes":
      d.setTime(d.getTime() + n * 60_000);
      break;
    case "hours":
      d.setTime(d.getTime() + n * 3_600_000);
      break;
    default: // days
      d.setTime(d.getTime() + n * 86_400_000);
      break;
  }
  return isNaN(d.getTime()) ? "Invalid Date" : d.toISOString();
}

// ============================================================================
// 触发器
//
// 判定全部是**纯函数**（触发器本身不订阅任何东西）：宿主把现实世界的事件翻译成
// `TriggerEvent`，`triggerMatches` 只回答"这条触发器要不要跑"。这样时区、星期、
// 电量阈值、距离这些最容易写错的规则可以在纯 bun 环境里逐条钉死。
//
// 时间触发器的**唤醒权威**在 Rust（`shortcuts_trigger_*` → `amos-scheduler` 的
// `ExactAlarmClock`）：WebView 的 `setInterval` 会被节流，窗口关掉就没了。这里负责
// "到点之后跑哪条"，不负责"到点叫醒设备"。
// ============================================================================

/** 时间触发器的配置形状。 */
export interface TimeTriggerConfig {
  /** `HH:mm`（24 小时制）。 */
  time?: string;
  /** ISO 星期（1 = 周一 … 7 = 周日）；缺省 = 每天。 */
  days?: number[];
}

/** 把 `Date` 转成 ISO 星期（1..7，周日 = 7）。 */
export function isoWeekday(date: Date): number {
  const d = date.getDay();
  return d === 0 ? 7 : d;
}

/**
 * 纯：这一刻是否命中时间触发器。
 *
 * 比较**到分钟**：`08:00` 这一分钟内的任何时刻（`08:00:00`…`08:00:59`）都算命中，
 * 重复去重交给运行时的"每触发器每分钟一次"账本。
 */
export function timeTriggerMatches(config: TimeTriggerConfig, date: Date): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(config.time ?? "").trim());
  if (!m) return false;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return false;
  if (date.getHours() !== hour || date.getMinutes() !== minute) return false;

  const days = Array.isArray(config.days) ? config.days.map(Number) : [];
  if (days.length === 0) return true;
  return days.includes(isoWeekday(date));
}

/** 事件数据里的取数助手（把 `unknown` 收窄，不抛异常）。 */
function evStr(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}
function evBool(data: Record<string, unknown>, key: string): boolean | null {
  const v = data[key];
  return typeof v === "boolean" ? v : null;
}
function evNum(data: Record<string, unknown>, key: string): number | null {
  const raw = data[key];
  if (raw === undefined || raw === null) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/** 两点间的大圆距离（米）—— 位置触发器的唯一判定依据。 */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * 纯：一条触发器是否命中一次事件。
 *
 * 判定顺序是"事件类型 → 该类型自己的规则"；类型不匹配一律 `false`（**不做**跨类型
 * 兜底）：把一条 Wi-Fi 触发当成应用触发跑掉，比不跑更糟。
 */
export function triggerMatches(trigger: Trigger, event: TriggerEvent): boolean {
  if (!trigger.enabled) return false;
  if (trigger.type !== event.type) return false;
  const config = trigger.config ?? {};
  const data = event.data ?? {};

  switch (trigger.type) {
    case "time":
      return timeTriggerMatches(config as TimeTriggerConfig, new Date(event.at));

    case "app": {
      const want = evStr(config, "appId");
      if (want && want !== evStr(data, "appId")) return false;
      return (evStr(data, "event") || "open") === (evStr(config, "event") || "open");
    }

    case "wifi": {
      const wantSsid = evStr(config, "ssid");
      if (wantSsid && wantSsid !== evStr(data, "ssid")) return false;
      return matchConnectionPhase(evStr(config, "event") || "connect", evBool(data, "connected"));
    }

    case "bluetooth": {
      const wantName = evStr(config, "deviceName");
      if (wantName && wantName !== evStr(data, "deviceName")) return false;
      return matchConnectionPhase(evStr(config, "event") || "connect", evBool(data, "connected"));
    }

    case "battery": {
      const level = evNum(data, "levelPct");
      const below = evNum(config, "levelBelow");
      const above = evNum(config, "levelAbove");
      const wantCharging = evBool(config, "charging");
      // 一个条件都没给 = 不匹配任何事件（否则"任何电量变化"会变成默认行为）。
      if (below === null && above === null && wantCharging === null) return false;
      if (below !== null && (level === null || level > below)) return false;
      if (above !== null && (level === null || level < above)) return false;
      if (wantCharging !== null && evBool(data, "charging") !== wantCharging) return false;
      return true;
    }

    case "airplane": {
      const want = evBool(config, "enabled");
      return want !== null && evBool(data, "enabled") === want;
    }

    case "nfc": {
      const wantTag = evStr(config, "tagId");
      return wantTag === "" || wantTag === evStr(data, "tagId");
    }

    case "location": {
      const lat = evNum(config, "latitude");
      const lon = evNum(config, "longitude");
      const radius = evNum(config, "radius") ?? 100;
      const evLat = evNum(data, "latitude");
      const evLon = evNum(data, "longitude");
      if (lat === null || lon === null || evLat === null || evLon === null) return false;
      const near = haversineMeters(lat, lon, evLat, evLon) <= radius;
      return evStr(config, "action") === "leave" ? !near : near;
    }

    case "notification": {
      const app = evStr(config, "app");
      if (app && app !== evStr(data, "app")) return false;
      const contains = evStr(config, "contains");
      if (!contains) return true;
      const hay = `${evStr(data, "title")} ${evStr(data, "body")}`.toLowerCase();
      return hay.includes(contains.toLowerCase());
    }

    case "email":
    case "message": {
      const from = evStr(config, "from");
      if (from && from !== evStr(data, "from")) return false;
      const contains = evStr(config, "contains");
      if (!contains) return true;
      const hay = `${evStr(data, "subject")} ${evStr(data, "body")}`.toLowerCase();
      return hay.includes(contains.toLowerCase());
    }

    default:
      // 尚未有信号源的触发器类型（`TriggerType` 比宿主事件集大）：不匹配，不假装。
      return false;
  }
}

/** `connect` / `disconnect` / 其它（"any"）三种连接类事件的共同判定。 */
function matchConnectionPhase(phase: string, connected: boolean | null): boolean {
  if (phase === "connect") return connected === true;
  if (phase === "disconnect") return connected === false;
  return true;
}

// ============================================================================
// 执行日志（`amos.shortcuts.execLog`）
//
// 这个键从 Phase 1 就声明了，但**没有任何人写**它 —— 于是"这条指令什么时候跑过、
// 成功还是失败"在运行之外没有任何痕迹。现在每次执行落一条（上限
// `MAX_EXEC_LOG_ENTRIES`），触发器跑的那次也带着 `triggerId`。
// ============================================================================

/** 一条执行历史记录。 */
export interface ExecutionLogEntry {
  shortcutId: string;
  shortcutName: string;
  /** 自动化触发时是哪个触发器；手动运行为 `undefined`。 */
  triggerId?: string;
  success: boolean;
  duration: number;
  actionsCompleted: number;
  actionsTotal: number;
  error?: string;
  /** `stop_shortcut` 提前结束（仍是成功）。 */
  stopped?: boolean;
  at: number;
}

/** 读取执行日志（最新在前）。 */
export function loadExecutionLog(): ExecutionLogEntry[] {
  try {
    // 与 `loadShortcuts` 同一约定：本模块的键里放的是 **JSON 字符串**（不是裸数组），
    // `readStoreValue` 已经把外层 JSON 解开了，所以这里再解一次。裸数组也容忍 ——
    // 云备份/别的窗口可能直接写数组进来。
    const raw = readStoreValue<unknown>(SHORTCUT_EXEC_LOG_KEY, "");
    if (Array.isArray(raw)) return raw as ExecutionLogEntry[];
    if (typeof raw !== "string" || raw === "") return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as ExecutionLogEntry[]) : [];
  } catch (err) {
    logger.error("shortcuts", "Failed to load execution log", err);
    return [];
  }
}

/**
 * 追加一条执行历史。
 *
 * 写失败**不影响**一次已经成功的运行 —— 这只是历史，不是结果本身，所以这里用
 * `writeStoreValue`（而不是 `Checked` 的失败上报）：不该因为"日志没落盘"让一次
 * 真的跑完的指令变成失败。上限 `MAX_EXEC_LOG_ENTRIES`，写入是覆盖式的（不会无限增长）。
 */
function appendExecutionLog(entry: ExecutionLogEntry): void {
  try {
    const next = [entry, ...loadExecutionLog()].slice(0, LIMITS.MAX_EXEC_LOG_ENTRIES);
    writeStoreValue(SHORTCUT_EXEC_LOG_KEY, JSON.stringify(next));
  } catch (err) {
    logger.error("shortcuts", "Failed to append execution log", err);
  }
}

/** 窗口事件名：某个 app 屏幕被打开（`app` 触发器的信号源）。 */
export const APP_OPENED_EVENT = "amos:app-opened";

/**
 * 广播"某个 app 被打开了"。
 *
 * `app` 触发器的信号必须来自**真正的打开动作**，而不是轮询窗口列表（那会把手动
 * 拖动的窗口、恢复的窗口也算成一次"打开"）。所以 `shellState.open()` 在它真的
 * 切换界面/请求建窗之后调用这里；桌面浮层（Launchpad / Spotlight）也走同一入口。
 *
 * 没有事件总线（无头测试）时安静跳过 —— 触发器收不到信号，但绝不影响打开 app。
 */
export function announceAppOpened(appId: string): void {
  const id = appId.trim();
  if (id === "") return;
  try {
    window.dispatchEvent(new CustomEvent(APP_OPENED_EVENT, { detail: { appId: id } }));
  } catch {
    /* no event bus in this host */
  }
}

/** `ShortcutTriggerRuntime` 的可注入依赖（全部有默认值，所以生产调用零参数）。 */
export interface TriggerRuntimeOptions {
  /** 跑一条指令。默认 `executeShortcut`。 */
  execute?: (shortcutId: string, options: ExecuteOptions) => Promise<ExecutionResult>;
  /** 加载指令快照。默认 `loadShortcuts`。 */
  load?: () => Shortcut[];
  /** 当前是否锁屏（`runOnLockScreen` 门禁）。默认恒 `false`。 */
  isLocked?: () => boolean;
  /** 时钟。默认 `Date.now`。 */
  now?: () => number;
  /** 时间触发轮询间隔（毫秒）。默认 20s。 */
  intervalMs?: number;
}

/** 触发器运行时的默认轮询间隔。 */
export const TRIGGER_TICK_MS = 20_000;

/**
 * 把 `Trigger` 与事件接起来的运行时。
 *
 * 它**不订阅**任何东西（DOM、Tauri、定时器都由宿主注入或驱动），所以：
 * - `fire(event)` / `tick(at)` 是纯逻辑 + `execute`，可以逐条单测；
 * - `start()`/`stop()` 只是给宿主用的默认 20s 心跳（真正的时间唤醒在 Rust 的
 *   `shortcuts_trigger_*`，那里才在设备 Doze 时也作数）。
 */
export class ShortcutTriggerRuntime {
  private readonly execute: (shortcutId: string, options: ExecuteOptions) => Promise<ExecutionResult>;
  private readonly load: () => Shortcut[];
  private readonly isLocked: () => boolean;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** `${shortcutId}:${triggerId}` → 已触发过的分钟键（`YYYY-MM-DDTHH:mm`）。 */
  private readonly fired = new Map<string, string>();

  constructor(options: TriggerRuntimeOptions = {}) {
    this.execute = options.execute ?? ((id, opts) => executeShortcut(id, undefined, opts));
    this.load = options.load ?? loadShortcuts;
    this.isLocked = options.isLocked ?? (() => false);
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = options.intervalMs ?? TRIGGER_TICK_MS;
  }

  /** 开始默认心跳（宿主在 shell 的 onMount 里调用；测试不调）。 */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  /** 停止心跳（shell 的 onDestroy）。 */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 时间触发器到点检查。返回真正跑起来的指令 id。
   *
   * 去重到**分钟**：轮询比一分钟快（或宿主卡了一拍）时同一分钟不会重复触发；分钟键
   * 也顺带让"睡过 5 分钟"不会补偿性地连跑 5 次。
   */
  async tick(at: number = this.now()): Promise<string[]> {
    const key = minuteKey(at);
    const fired: string[] = [];
    for (const shortcut of this.load()) {
      for (const trigger of shortcut.triggers ?? []) {
        if (!trigger.enabled || trigger.type !== "time") continue;
        if (!timeTriggerMatches(trigger.config as TimeTriggerConfig, new Date(at))) continue;
        if (this.markFired(shortcut.id, trigger.id, key)) continue;
        if (await this.run(shortcut, trigger.id)) fired.push(shortcut.id);
      }
    }
    return fired;
  }

  /**
   * 把一次信号喂给所有启用的触发器。返回真正跑起来的指令 id。
   *
   * 时间事件与 `tick` 共用同一份分钟账本：Rust 的调度桥（`shortcuts_trigger_poll`）
   * 和 WebView 心跳会**同时**报告同一个到点时刻，这里必须只跑一次；其余类型不做
   * 去重 —— 两次连上同一个 Wi-Fi 是两件真事。
   */
  async fire(event: TriggerEvent): Promise<string[]> {
    const key = event.type === "time" ? minuteKey(event.at) : null;
    const fired: string[] = [];
    for (const shortcut of this.load()) {
      for (const trigger of shortcut.triggers ?? []) {
        if (!triggerMatches(trigger, event)) continue;
        if (key !== null && this.markFired(shortcut.id, trigger.id, key)) continue;
        if (await this.run(shortcut, trigger.id)) fired.push(shortcut.id);
      }
    }
    return fired;
  }

  /** 记一次已触发；同一分钟重复返回 `true`（调用方应跳过）。 */
  private markFired(shortcutId: string, triggerId: string, key: string): boolean {
    const id = `${shortcutId}:${triggerId}`;
    if (this.fired.get(id) === key) return true;
    this.fired.set(id, key);
    return false;
  }

  /**
   * 跑一条被触发的指令，并在这里执行**只有宿主人能做的门禁**：
   * `requiresConfirmation` 在自动化里无法弹确认框，所以**跳过**（并留下原因），
   * 而不是静默地跑掉、也不是静默地失败。锁屏门禁交给 `executeShortcut`（它拥有
   * `runOnLockScreen` 这个字段）。
   */
  private async run(shortcut: Shortcut, triggerId: string): Promise<boolean> {
    if (shortcut.requiresConfirmation) {
      logger.warn("shortcuts", `Trigger skipped (needs confirmation): ${shortcut.name}`);
      return false;
    }
    try {
      await this.execute(shortcut.id, { triggerId, locked: this.isLocked() });
      return true;
    } catch (err) {
      // `executeShortcut` 自己把失败包成结果（不抛），所以到这里说明是**宿主的执行器**
      // 出了问题 —— 记下来；一条触发器不能拖垮整个运行时。
      logger.error("shortcuts", `Trigger execution threw for ${shortcut.name}`, err);
      return false;
    }
  }

  /** 指令被增删改后调用：清掉去重记忆，让编辑后的触发器重新生效。 */
  sync(shortcutId?: string): void {
    if (shortcutId === undefined) {
      this.fired.clear();
      return;
    }
    for (const key of [...this.fired.keys()]) {
      if (key.startsWith(`${shortcutId}:`)) this.fired.delete(key);
    }
  }
}

/** 某一毫秒所属的分钟键（本地时区，与时间触发器的 `HH:mm` 同一套）。 */
export function minuteKey(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
