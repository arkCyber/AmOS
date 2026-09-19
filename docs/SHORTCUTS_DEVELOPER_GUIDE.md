# 快捷指令开发者指南

**AmOS Shortcuts Developer Guide** | v1.0.0 | 2026-09-17

---

## 📖 目录

1. [架构概览](#架构概览)
2. [数据模型](#数据模型)
3. [添加新操作](#添加新操作)
4. [执行引擎](#执行引擎)
5. [触发器系统](#触发器系统)
6. [UI 扩展](#ui-扩展)
7. [测试指南](#测试指南)
8. [最佳实践](#最佳实践)

---

## 🏗️ 架构概览

### 文件结构

```
src/
├── lib/
│   ├── shortcuts.ts              # 核心逻辑
│   └── __tests__/
│       └── shortcuts.test.ts     # 单元测试
├── svelte/
│   └── ShortcutsApp.svelte       # UI 组件
└── assets/
    └── icons/
        └── IconShortcuts.svelte  # 应用图标
```

### 核心模块

```typescript
// shortcuts.ts 导出的主要功能
export {
  // 数据模型
  type Shortcut,
  type ActionType,
  type ActionInstance,   // children / elseChildren = 控制流子操作
  type Trigger,
  type TriggerEvent,     // 触发器的一次信号（宿主翻译后喂给运行时）
  type ExecutionResult,
  type ExecutionLogEntry,

  // CRUD 操作
  createShortcut,
  updateShortcut,
  deleteShortcut,
  duplicateShortcut,
  loadShortcuts,
  saveShortcuts,

  // 执行引擎
  executeShortcut,       // 唯一入口（confirmed / locked 门禁都在这里）
  evaluateCondition,     // `if` 的条件求值（纯）
  resolveValue,          // 变量解析（纯；含行内插值）

  // 操作库
  getActionType,
  getActionsByCategory,
  BUILTIN_ACTIONS,

  // 触发器（纯判定 + 运行时；"在哪个绝对时刻唤醒"在 Rust）
  triggerMatches,
  timeTriggerMatches,
  haversineMeters,
  isoWeekday,
  minuteKey,
  ShortcutTriggerRuntime,
  TRIGGER_TICK_MS,

  // 常量
  SHORTCUT_COLORS,
  SHORTCUT_ICONS,
  LIMITS,
};

---

## 📊 数据模型

### Shortcut 接口

```typescript
export interface Shortcut {
  id: string;                      // 唯一标识符 (时间戳-随机字符串)
  name: string;                    // 名称 (1-60 字符)
  icon: string;                    // 图标 emoji
  color: string;                   // 主题颜色 (十六进制)
  description: string;             // 描述 (0-200 字符)
  actions: ActionInstance[];       // 操作序列
  quickActions: QuickActionType[]; // 快速操作 (add_to_home, share)
  triggers: Trigger[];             // 触发器列表
  createdAt: number;               // 创建时间戳 (毫秒)
  updatedAt: number;               // 更新时间戳 (毫秒)
  runCount: number;                // 运行次数统计
  siriPhrase?: string;             // Siri 语音短语
  runOnLockScreen: boolean;        // 是否允许锁屏运行
  requiresConfirmation: boolean;   // 执行前是否需要确认
  tags: string[];                  // 标签列表 (最多 10 个)
}
```

### ActionType 接口

```typescript
export interface ActionType {
  id: string;                      // 操作 ID (category.action)
  name: string;                    // 显示名称
  category: ActionCategory;        // 所属分类
  icon: string;                    // 图标 emoji
  description: string;             // 操作描述
  parameters: ActionParameter[];   // 参数定义列表
  outputType?: DataType;           // 输出数据类型
  permissions?: string[];          // 所需系统权限
}
```

### ActionParameter 接口

```typescript
export interface ActionParameter {
  name: string;                    // 参数名称
  type: string;                    // 参数类型 (string/number/boolean)
  label: string;                   // 显示标签
  required: boolean;               // 是否必填
  defaultValue?: unknown;          // 默认值
  placeholder?: string;            // 占位符文本
  options?: Array<{                // 下拉选项 (可选)
    label: string;
    value: unknown;
  }>;
  min?: number;                    // 最小值 (数字类型)
  max?: number;                    // 最大值 (数字类型)
  multiline?: boolean;             // 是否多行文本
}
```

### Trigger 接口

```typescript
export interface Trigger {
  id: string;                      // 触发器 ID
  type: TriggerType;               // 触发器类型
  enabled: boolean;                // 是否启用
  config: Record<string, unknown>; // 触发条件配置
}

export type TriggerType =
  | "manual"         // 手动运行
  | "siri"           // Siri 语音
  | "time"           // 时间触发
  | "location"       // 位置触发
  | "app"            // 应用事件
  | "nfc"            // NFC 标签
  | "bluetooth"      // 蓝牙设备
  | "wifi"           // Wi-Fi 网络
  | "notification"   // 通知触发
  | "share"          // 分享菜单
  | "widget";        // 桌面小组件
```

---

## ➕ 添加新操作

### 步骤 1: 定义操作类型

在 `shortcuts.ts` 的 `BUILTIN_ACTIONS` 数组中添加新操作：

```typescript
const BUILTIN_ACTIONS: ActionType[] = [
  // ... 现有操作 ...
  
  // 新操作示例：发送邮件
  {
    id: "contacts.send_email",
    name: "发送邮件",
    category: "contacts",
    icon: "📧",
    description: "向指定邮箱发送邮件",
    parameters: [
      {
        name: "to",
        type: "string",
        label: "收件人",
        required: true,
        placeholder: "example@email.com",
      },
      {
        name: "subject",
        type: "string",
        label: "主题",
        required: true,
        placeholder: "邮件主题",
      },
      {
        name: "body",
        type: "string",
        label: "正文",
        required: true,
        multiline: true,
        placeholder: "邮件内容",
      },
      {
        name: "cc",
        type: "string",
        label: "抄送",
        required: false,
        placeholder: "可选",
      },
    ],
    outputType: "boolean",
    permissions: ["contacts"],
  },
];
```

### 步骤 2: 实现操作逻辑

在 `executeAction` 函数中添加 case：

```typescript
async function executeAction(
  action: ActionInstance,
  input: unknown,
  context: ExecutionContext
): Promise<unknown> {
  const actionType = getActionType(action.actionId);
  if (!actionType) {
    throw new Error(`未知操作: ${action.actionId}`);
  }

  logger.debug("shortcuts", `Executing action: ${actionType.name} ${action.id}`);

  const params = action.parameters;

  switch (action.actionId) {
    // ... 现有 case ...

    case "contacts.send_email": {
      const to = resolveValue(params.to, context) as string;
      const subject = resolveValue(params.subject, context) as string;
      const body = resolveValue(params.body, context) as string;
      const cc = params.cc ? (resolveValue(params.cc, context) as string) : undefined;

      // 实现邮件发送逻辑
      try {
        // 调用 Tauri 后端 API
        // await invoke("send_email", { to, subject, body, cc });
        
        // 或使用 mailto: 协议
        const mailtoUrl = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}${cc ? `&cc=${encodeURIComponent(cc)}` : ""}`;
        window.open(mailtoUrl, "_blank");
        
        return true;
      } catch (error) {
        logger.error("shortcuts", `Failed to send email: ${error}`);
        return false;
      }
    }

    default:
      throw new Error(`未实现的操作: ${action.actionId}`);
  }
}
```

### 步骤 3: 添加测试

在 `shortcuts.test.ts` 中添加测试用例：

```typescript
describe("快捷指令核心功能", () => {
  // ... 现有测试 ...

  describe("执行引擎", () => {
    // ... 现有测试 ...

    it("执行发送邮件操作", async () => {
      const shortcut = createShortcut("邮件测试");
      if (!shortcut) throw new Error("Failed to create shortcut");

      shortcut.actions = [
        {
          id: "action-1",
          actionId: "contacts.send_email",
          parameters: {
            to: "test@example.com",
            subject: "测试邮件",
            body: "这是一封测试邮件",
          },
        },
      ];

      updateShortcut(shortcut.id, shortcut);

      const result = await executeShortcut(shortcut.id);
      expect(result.success).toBe(true);
      expect(result.output).toBe(true);
    });
  });
});
```

---

## ⚙️ 执行引擎

### 执行流程

```typescript
executeShortcut(shortcutId)
  ↓
  1. 加载快捷指令数据
  ↓
  2. 初始化执行上下文 (ExecutionContext)
  ↓
  3. 顺序执行每个操作
     ↓
     executeAction(action, input, context)
       ↓
       a. 解析参数中的变量
       ↓
       b. 执行操作逻辑
       ↓
       c. 返回输出
  ↓
  4. 更新运行计数
  ↓
  5. 返回执行结果 (ExecutionResult)
```

### ExecutionContext

执行上下文包含运行时状态：

```typescript
interface ExecutionContext {
  shortcutId: string;              // 当前快捷指令 ID
  variables: Map<string, unknown>; // 变量存储
  input?: unknown;                 // 初始输入
  output?: unknown;                // 最新输出
  fromSiri: boolean;               // 是否由 Siri 触发
  fromAutomation: boolean;         // 是否由自动化触发
  triggerId?: string;              // 触发器 ID
  startTime: number;               // 开始时间戳
}
```

### 变量解析

`resolveValue` 处理两种写法，**语义故意不同**（`lib/shortcuts.ts`）：

| 写法 | 含义 | 例 |
| --- | --- | --- |
| 整串 `"$name"` / `"${name}"` | 取变量**原值**（数字还是数字、列表还是列表）；未定义时 `"$name"` 回落成字面量 | `"$total"` → `42` |
| 嵌入 `"总计 ${total} 元"` / `"{total} 元"` | 把变量**转成文本**填进去 | `"总计 42 元"` |
| 内建（同名变量不覆盖） | `{input}` 上一步输入、`{output}` 上一步输出、`{date}` / `{time}` | `"${output}"` |

数组 / 对象会**递归**解析；普通文本里的 `$5` 不会被当成变量（嵌入形式必须带花括号）。

### 控制流

`if` / `repeat` / `for_each` 的子操作放在 `ActionInstance.children`（`if` 的 else 分支放
`elseChildren`），执行器递归求值：

- `repeat` 暴露 `${repeatIndex}`（1 起），上限 `LIMITS.MAX_REPEAT_ITERATIONS`；
- `for_each` 默认暴露 `${item}` / `${index}`（可用 `itemName` / `indexName` 改名），输出每轮结果组成的列表；
- 嵌套深度上限 `LIMITS.MAX_CONTROL_DEPTH`（手改/导入的 JSON 可以自引用，这是拒它的地方）；
- `stop_shortcut` 立刻结束整条指令，**记为成功**，输出是当时管道值；
- `actionsTotal` 按整棵树递归计数（不走的 else 分支也在树上）。


### 错误处理

所有操作都应该有完善的错误处理：

```typescript
try {
  // 操作逻辑
  const result = await performOperation();
  return result;
} catch (error) {
  logger.error("shortcuts", `Operation failed: ${error}`);
  throw new Error(`操作失败: ${error instanceof Error ? error.message : "未知错误"}`);
}
```

---

## 🎯 触发器系统

### 触发器系统（Rust 负责"何时"，WebView 负责"做什么"）

自动化触发器**不能**靠 WebView 的 `setInterval`：它在后台被节流，窗口关掉就不存在了。
所以时间触发器的"在哪个绝对时刻唤醒"住在 Rust：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| Rust 计划 + 唤醒 | `crates/amos-tauri/src/shortcut_triggers.rs` | `shortcuts_trigger_sync`（幂等替换整份计划）/ `shortcuts_trigger_poll`（到点 + 自动重挂下一次）；账本用 `amos-scheduler::ExactAlarmClock`，Android 走 `alarm_sched` 的同一个 JNI 绑定（`AlarmManager#setExactAndAllowWhileIdle`） |
| 桥 | `src/lib/shortcutSchedule.ts` | 把存储里的快捷指令翻译成计划、轮询到点、解析 key |
| 判定（纯函数） | `src/lib/shortcuts.ts` | `triggerMatches` / `timeTriggerMatches` / `haversineMeters`：时区、星期、电量阈值、半径都在纯 bun 里钉死 |
| 运行时 + 信号 | `src/svelte/osShortcutTriggers.ts`（`Shell.svelte` 启动） | 心跳兜底、连接变化、电池、app 打开事件、执行 |

要点：

- **时间触发器是复现（recurrence）**：`poll` 命中的那一条会立刻按**同一规则**重挂下一次；
  睡过 3 天醒来只触发 **1 次**（不是 3 次）。
- **去重到分钟**：Rust 的 `atMs` 与 WebView 心跳用同一份分钟账本，所以两边都报同一时刻
  时只会跑一次。
- **读不懂的规则按名字拒绝**：`time` 不是 `HH:mm` / 星期不在 1..7 → `rejected[{key, reason}]`，
  不静默丢弃（静默丢掉的触发器是没人看得见的坏自动化）。
- **`requiresConfirmation` 在自动化里跳过**：没人可问，所以不跑也不假装成功（手动运行由
  `ShortcutsApp` 先确认再传 `confirmed: true`）。
- **锁屏**：`runOnLockScreen === false` 的指令在锁屏下由 `executeShortcut` 拒绝。
- 尚未有信号源的触发器类型（`email` / `message` / `location` 的真实定位等）判定返回
  `false` —— 不猜、不假装。

### 触发器配置示例

```typescript
// 时间触发器
{
  id: "trigger-1",
  type: "time",
  enabled: true,
  config: {
    time: "08:00",           // HH:mm 格式
    days: [1, 2, 3, 4, 5],   // 周一到周五 (1=周一, 7=周日)
    repeat: true,            // 是否重复
  }
}

// 位置触发器
{
  id: "trigger-2",
  type: "location",
  enabled: true,
  config: {
    latitude: 39.9042,
    longitude: 116.4074,
    radius: 100,             // 米
    action: "arrive",        // 或 "leave"
  }
}

// 应用触发器
{
  id: "trigger-3",
  type: "app",
  enabled: true,
  config: {
    appId: "safari",
    event: "open",           // 或 "close"
  }
}
```

### 加一个触发器类型（照现有信号源抄）

1. 在 `TriggerType` 里加类型（`lib/shortcuts.ts`）。
2. 在 `triggerMatches` 的同名 `case` 里写**纯判定**：缺条件的类型返回 `false`，不要猜。
   带阈值的要像 `battery` 一样"一个条件都没给 = 不匹配"，否则"任意变化都触发"会变成默认行为。
3. 找一个能产生该信号的**宿主**（WebView 事件 / 存储键变化 / Tauri 事件），在
   `svelte/osShortcutTriggers.ts` 里把它翻译成 `TriggerEvent` 交给 `runtime.fire(...)`。
4. 判定与运行时都能在纯 bun 里单测（见 `lib/__tests__/shortcuts-automation.test.ts`）。

```typescript
// svelte/osShortcutTriggers.ts 里每个非时间信号源都是这几行
window.addEventListener("online", () => {
  void runtime.fire({ type: "wifi", at: Date.now(), data: { ssid, connected: true } });
});
```

时间触发器**不走** `fire`，而是 Rust 的 `shortcuts_trigger_poll`（见上一节）—— 那是唯一在
"没有窗口 / 设备 Doze"时仍然作数的路径。


---

## 🎨 UI 扩展

### 添加新视图

在 `ShortcutsApp.svelte` 中添加新视图：

```svelte
<script lang="ts">
  let view = $state<"list" | "editor" | "gallery" | "analytics">("list");
  
  // 添加分析视图状态
  let analyticsData = $state({
    totalRuns: 0,
    avgDuration: 0,
    successRate: 0,
  });
</script>

<!-- 在导航栏添加新按钮 -->
<button
  on:click={() => (view = "analytics")}
  class:active={view === "analytics"}
>
  📊 分析
</button>

<!-- 添加新视图内容 -->
{#if view === "analytics"}
  <div class="analytics-view">
    <h2>运行统计</h2>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">{analyticsData.totalRuns}</div>
        <div class="stat-label">总运行次数</div>
      </div>
      <!-- 更多统计卡片 -->
    </div>
  </div>
{/if}
```

### 自定义操作参数编辑器

```svelte
<script lang="ts">
  function renderParameterInput(param: ActionParameter, value: unknown) {
    if (param.options) {
      // 下拉选择
      return /* select element */;
    } else if (param.type === "boolean") {
      // 开关
      return /* toggle element */;
    } else if (param.type === "number") {
      // 数字输入
      return /* number input with min/max */;
    } else if (param.multiline) {
      // 多行文本
      return /* textarea */;
    } else {
      // 单行文本
      return /* text input */;
    }
  }
</script>
```

---

## 🧪 测试指南

### 测试环境设置

```typescript
// shortcuts.test.ts

// Mock localStorage
const storageMap = new Map<string, string>();
const mockStorage: Storage = {
  getItem: (key: string) => storageMap.get(key) || null,
  setItem: (key: string, value: string) => { storageMap.set(key, value); },
  removeItem: (key: string) => { storageMap.delete(key); },
  clear: () => { storageMap.clear(); },
  key: (index: number) => Array.from(storageMap.keys())[index] || null,
  get length() { return storageMap.size; },
};

// 设置 mock
if (typeof window === 'undefined') {
  (global as any).window = {
    localStorage: mockStorage,
    dispatchEvent: () => true,
  };
} else {
  (window as any).localStorage = mockStorage;
}
global.localStorage = mockStorage;

// 每个测试前清理
beforeEach(() => {
  storageMap.clear();
});
```

### 测试模式

```typescript
// 1. 单元测试 - 测试单个函数
it("验证有效名称", () => {
  expect(validateShortcutName("测试")).toBe(true);
  expect(validateShortcutName("Test 123")).toBe(true);
});

// 2. 集成测试 - 测试完整流程
it("创建并执行快捷指令", async () => {
  const shortcut = createShortcut("测试");
  shortcut!.actions = [
    { id: "1", actionId: "text.text", parameters: { text: "Hello" } },
  ];
  updateShortcut(shortcut!.id, shortcut!);
  
  const result = await executeShortcut(shortcut!.id);
  expect(result.success).toBe(true);
  expect(result.output).toBe("Hello");
});

// 3. 边界测试 - 测试极限情况
it("不允许超过最大数量", () => {
  for (let i = 0; i < 1000; i++) {
    createShortcut(`Test ${i}`);
  }
  const overflow = createShortcut("Overflow");
  expect(overflow).toBeNull();
});
```

### 运行测试

```bash
# 运行所有测试
npm test

# 运行特定文件
bun test src/lib/__tests__/shortcuts.test.ts

# 运行并监听变化
bun test --watch

# 生成覆盖率报告
bun test --coverage
```

---

## 💡 最佳实践

### 1. 操作设计原则

✅ **单一职责**: 每个操作只做一件事  
✅ **明确输入输出**: 清晰定义 `inputType` 和 `outputType`  
✅ **参数验证**: 验证所有必需参数  
✅ **错误处理**: 捕获并记录所有异常  
✅ **日志记录**: 使用 `logger` 记录关键操作  

```typescript
// ❌ 不好的设计
{
  id: "do_everything",
  name: "做所有事情",
  parameters: [/* 太多参数 */],
}

// ✅ 好的设计
{
  id: "text.uppercase",
  name: "转换大写",
  parameters: [
    { name: "text", type: "string", required: true }
  ],
  outputType: "text",
}
```

### 2. 性能优化

```typescript
// ✅ 使用 $derived 避免重复计算
let filteredShortcuts = $derived(
  shortcuts.filter((s) =>
    s.name.toLowerCase().includes(searchQuery.toLowerCase())
  )
);

// ✅ 使用虚拟滚动处理大列表
// (待实现 in Phase 2)

// ✅ 缓存操作类型查询
const actionTypeCache = new Map<string, ActionType>();
function getActionType(id: string): ActionType | undefined {
  if (actionTypeCache.has(id)) {
    return actionTypeCache.get(id);
  }
  const type = BUILTIN_ACTIONS.find((a) => a.id === id);
  if (type) actionTypeCache.set(id, type);
  return type;
}
```

### 3. 错误处理模式

```typescript
// ✅ 捕获并转换错误
try {
  const result = await riskyOperation();
  return result;
} catch (error) {
  logger.error("shortcuts", `Operation failed: ${error}`);
  throw new Error(
    error instanceof Error ? error.message : "未知错误"
  );
}

// ✅ 提供有用的错误信息
if (!shortcut) {
  logger.error("shortcuts", `Shortcut not found: ${shortcutId}`);
  return {
    success: false,
    error: `快捷指令不存在: ${shortcutId}`,
  };
}
```

### 4. 类型安全

```typescript
// ✅ 使用类型守卫
function isValidShortcut(data: unknown): data is Shortcut {
  return (
    typeof data === "object" &&
    data !== null &&
    "id" in data &&
    "name" in data &&
    "actions" in data
  );
}

// ✅ 使用泛型
function resolveParameter<T>(
  param: unknown,
  type: "string" | "number" | "boolean"
): T {
  // 类型转换逻辑
}
```

### 5. 可维护性

```typescript
// ✅ 使用常量而非魔法数字
const LIMITS = {
  MAX_SHORTCUTS: 1000,
  MAX_ACTIONS_PER_SHORTCUT: 100,
};

// ✅ 提取可复用函数
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

// ✅ 添加清晰的注释
/**
 * 执行快捷指令
 * @param shortcutId - 快捷指令的唯一标识符
 * @param input - 可选的初始输入数据
 * @param options - 执行选项 (触发器ID、Siri标志等)
 * @returns 执行结果，包含成功状态、输出和持续时间
 */
export async function executeShortcut(
  shortcutId: string,
  input?: unknown,
  options?: ExecuteOptions
): Promise<ExecutionResult>
```

---

## 📚 参考资源

### 内部文档
- `SHORTCUTS_IMPLEMENTATION_COMPLETE.md` - 完整实施报告
- `SHORTCUTS_QUICK_REFERENCE.md` - 快速参考指南
- `快捷指令实施完成确认.md` - 实施确认文档

### 外部资源
- [iOS Shortcuts 用户指南](https://support.apple.com/zh-cn/guide/shortcuts/welcome/ios)
- [Shortcuts JS API Reference](https://developer.apple.com/documentation/shortcuts)
- [Svelte 5 文档](https://svelte.dev/docs/svelte/overview)
- [Tauri 文档](https://tauri.app/zh-cn/v1/guides/)

---

## 🤝 贡献指南

### 提交新操作

1. Fork 项目
2. 在 `BUILTIN_ACTIONS` 中添加操作定义
3. 在 `executeAction` 中实现逻辑
4. 添加单元测试
5. 更新文档
6. 提交 Pull Request

### 代码规范

- 使用 TypeScript 严格模式
- 遵循 ESLint 规则
- 所有函数添加 JSDoc 注释
- 测试覆盖率 > 80%
- 通过所有 CI 检查

---

**版本**: 1.0.0  
**更新日期**: 2026-09-17  
**维护者**: AmOS Development Team  
**许可证**: MIT
