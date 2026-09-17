# 推送通知 Phase 3: UI 组件实施计划

**开始日期**: 2026年9月17日  
**预计完成**: 2026年9月21日 (4天)  
**当前状态**: 🚀 **开始实施**

---

## 📋 总体目标

在 Phase 2 后端集成的基础上，实现完整的推送通知用户界面，包括权限请求、设置管理和通知中心集成。

---

## 🎯 三个核心组件

### 1️⃣ PushPermissionDialog.svelte (Day 1)

**预估**: 1天 (6-8小时)  
**优先级**: P0 ⭐⭐⭐⭐⭐

#### 功能需求

**权限状态展示**:
```
未确定 (notdetermined) → 显示请求按钮
已拒绝 (denied)       → 显示引导到设置
已授权 (authorized)   → 显示成功状态
临时授权 (provisional) → 显示升级选项
```

**3步引导流程**:
1. **说明页**: 推送通知的好处和用途
2. **权限页**: 系统权限请求
3. **完成页**: 设置成功确认

**交互设计**:
- 模态对话框 (半透明背景)
- 支持键盘导航 (Tab/Enter/Esc)
- 拒绝后引导到系统设置
- 国际化支持 (中英文)

#### 技术要点

**状态管理**:
```typescript
import { getPushPermission, requestPushPermission } from "@/lib/pushNotifications";

let permissionStatus: "notdetermined" | "denied" | "authorized" | "provisional";
let step = 1; // 1=说明, 2=请求, 3=完成
```

**权限请求流程**:
```typescript
async function handleRequestPermission() {
  const result = await requestPushPermission();
  if (result.kind === "ok") {
    permissionStatus = await getPushPermission();
    step = 3; // 跳转到完成页
  } else {
    // 处理拒绝/错误
  }
}
```

**A11y 要求**:
- `role="dialog"`, `aria-labelledby`, `aria-describedby`
- Focus trap (焦点锁定在对话框内)
- Esc 键关闭
- 屏幕阅读器友好

#### UI 规范

**尺寸**: 480px × 600px (居中)  
**圆角**: 16px  
**阴影**: `0 8px 32px rgba(0,0,0,0.12)`  
**背景**: 白色 (light) / `#1c1c1e` (dark)

**按钮样式**:
- 主按钮: 蓝色 `#007AFF`
- 次按钮: 灰色 `#8E8E93`
- 危险按钮: 红色 `#FF3B30`

#### 国际化

**中文** (`zh.ts`):
```typescript
pushPermission: {
  title: "启用推送通知",
  description: "接收重要消息和更新提醒",
  benefits: [
    "即时接收新消息",
    "重要事件提醒",
    "离线通知同步"
  ],
  request: "允许通知",
  deny: "暂时不要",
  denied: "通知已被拒绝",
  deniedHint: "前往系统设置以启用通知",
  openSettings: "打开设置",
}
```

**英文** (`en.ts`):
```typescript
pushPermission: {
  title: "Enable Push Notifications",
  description: "Receive important messages and updates",
  benefits: [
    "Instant message delivery",
    "Important event alerts",
    "Offline notification sync"
  ],
  request: "Allow Notifications",
  deny: "Not Now",
  denied: "Notifications Denied",
  deniedHint: "Go to System Settings to enable notifications",
  openSettings: "Open Settings",
}
```

#### 测试需求

**单元测试** (`PushPermissionDialog.test.ts`):
- [ ] 权限状态渲染
- [ ] 3步流程导航
- [ ] 权限请求交互
- [ ] 键盘导航 (Tab/Enter/Esc)
- [ ] A11y 属性验证
- [ ] 国际化字符串加载

**手动测试**:
- [ ] 首次打开 (notdetermined)
- [ ] 拒绝后重新打开
- [ ] 已授权状态
- [ ] 深色模式
- [ ] 响应式布局

---

### 2️⃣ PushNotificationSettings.svelte (Day 2-3)

**预估**: 2天 (12-16小时)  
**优先级**: P0 ⭐⭐⭐⭐⭐

#### 功能需求

**总开关**:
```
┌─────────────────────────────────────┐
│ 推送通知                    [●○○○] │ ← 主开关
└─────────────────────────────────────┘
```

**子功能开关**:
```
┌─────────────────────────────────────┐
│ 显示徽章                    [●○○○] │
│ 播放声音                    [●○○○] │
│ 横幅提醒                    [●○○○] │
└─────────────────────────────────────┘
```

**设备令牌区域**:
```
┌─────────────────────────────────────┐
│ 设备令牌                            │
│ abc123def456...                [复制]│
│ 环境: Production                    │
│ 注册时间: 2026-09-17 14:00          │
└─────────────────────────────────────┘
```

**统计信息面板** (图表):
```
┌─────────────────────────────────────┐
│ 通知统计                            │
│                                     │
│ 总接收: 100        带徽章: 50      │
│ 带声音: 75         静默: 10        │
│                                     │
│ [■■■■■■■■■■■■■■■■░░░░] 75%     │
│ 最后接收: 2小时前                   │
└─────────────────────────────────────┘
```

**历史记录查看器** (分页):
```
┌─────────────────────────────────────┐
│ 通知历史                  [清除全部] │
│                                     │
│ ● 新消息通知              2小时前   │
│   "你有一条新消息"                  │
│                                     │
│ ○ 系统更新                5小时前   │
│   "AmOS 1.2.0 可用"                │
│                                     │
│ [1] 2 3 ... 10            共 100条  │
└─────────────────────────────────────┘
```

**测试推送按钮** (开发模式):
```
┌─────────────────────────────────────┐
│ 开发工具 (仅开发环境)               │
│                                     │
│ [发送测试通知]                      │
│ [模拟静默推送]                      │
│ [测试大载荷]                        │
└─────────────────────────────────────┘
```

#### 技术要点

**状态管理**:
```typescript
import { 
  getPushStatus, 
  setBadgeCount, 
  getNotificationHistory,
  clearNotificationHistory,
  simulateReceivePush 
} from "@/lib/pushNotifications";

let status: RustPushStatus;
let history: RustNotificationRecord[] = [];
let currentPage = 1;
const pageSize = 10;
```

**开关同步**:
```typescript
async function handleToggleNotifications(enabled: boolean) {
  // 更新本地存储
  await invoke("store_set", {
    key: "amos.push.enabled",
    value: JSON.stringify({ enabled })
  });
  // 刷新状态
  await refreshStatus();
}
```

**历史分页**:
```typescript
$: paginatedHistory = history.slice(
  (currentPage - 1) * pageSize,
  currentPage * pageSize
);

$: totalPages = Math.ceil(history.length / pageSize);
```

**图表可视化** (可选):
```typescript
import { Chart } from "svelte-chartjs"; // 或使用 canvas 直接绘制

const chartData = {
  labels: ["带徽章", "带声音", "静默"],
  datasets: [{
    data: [stats.with_badge, stats.with_sound, stats.silent],
    backgroundColor: ["#007AFF", "#34C759", "#8E8E93"]
  }]
};
```

#### UI 规范

**布局**: 设置页内嵌组件 (非模态)  
**宽度**: 100% (响应式)  
**分组**: 使用 `<section>` 分隔各功能区

**开关样式**:
- iOS 风格 toggle switch
- 宽度: 51px, 高度: 31px
- 动画: 200ms ease

**卡片样式**:
```css
background: rgba(255,255,255,0.8);
border: 1px solid rgba(0,0,0,0.1);
border-radius: 12px;
padding: 16px;
backdrop-filter: blur(20px);
```

#### 国际化

**中文**:
```typescript
pushSettings: {
  title: "推送通知",
  enabled: "启用推送",
  badge: "显示徽章",
  sound: "播放声音",
  banner: "横幅提醒",
  deviceToken: "设备令牌",
  environment: "环境",
  registeredAt: "注册时间",
  copy: "复制",
  copied: "已复制",
  statistics: "通知统计",
  totalReceived: "总接收",
  withBadge: "带徽章",
  withSound: "带声音",
  silent: "静默",
  lastReceived: "最后接收",
  history: "通知历史",
  clearAll: "清除全部",
  noHistory: "暂无历史记录",
  page: "第 {{current}}/{{total}} 页",
  devTools: "开发工具",
  sendTest: "发送测试通知",
}
```

#### 测试需求

**单元测试**:
- [ ] 开关状态切换
- [ ] 设备令牌复制
- [ ] 统计数据显示
- [ ] 历史记录分页
- [ ] 清除历史功能
- [ ] 测试推送功能 (dev)

**集成测试**:
- [ ] 与后端 API 同步
- [ ] 本地存储持久化
- [ ] 实时状态更新

---

### 3️⃣ 通知中心集成 (Day 4)

**预估**: 1天 (6-8小时)  
**优先级**: P1 ⭐⭐⭐⭐

#### 功能需求

**通知列表组件** (`NotificationList.svelte`):
```
┌─────────────────────────────────────┐
│ ● 新消息                  2分钟前   │
│   标题: 你有新消息                  │
│   内容: 来自张三的消息              │
│   [标记已读] [删除]                 │
├─────────────────────────────────────┤
│ ○ 系统更新                1小时前   │
│   标题: 更新可用                    │
│   内容: AmOS 1.2.0 已发布          │
│   [查看详情]                        │
└─────────────────────────────────────┘
```

**已读/未读状态**:
- 未读: 蓝色圆点 `●`, 粗体标题
- 已读: 灰色圆点 `○`, 常规字体
- 点击标记已读

**通知详情展示**:
```
┌─────────────────────────────────────┐
│ 通知详情                    [×关闭] │
│                                     │
│ 📬 你有新消息                       │
│                                     │
│ 来自: 张三                          │
│ 时间: 2026-09-17 14:30             │
│                                     │
│ 消息内容:                           │
│ "你好，请查看最新的项目进度报告。"  │
│                                     │
│ [标记已读] [删除]                   │
└─────────────────────────────────────┘
```

**批量操作**:
```
[全选] [全部标记已读] [清除已读]
```

#### 技术要点

**集成到现有通知中心**:
```typescript
// 在 NotificationCenter.svelte 中
import NotificationList from "./modules/NotificationList.svelte";
import { getNotificationHistory } from "@/lib/pushNotifications";

let pushNotifications = [];

onMount(async () => {
  pushNotifications = await getNotificationHistory(50);
});
```

**实时更新**:
```typescript
import { listen } from "@tauri-apps/api/event";

// 监听新推送事件
const unlisten = await listen("push-received", (event) => {
  pushNotifications = [event.payload, ...pushNotifications];
});

onDestroy(() => {
  unlisten();
});
```

**分组显示**:
```typescript
// 按日期分组
const groupedNotifications = groupBy(pushNotifications, (notif) => {
  const date = new Date(notif.received_at);
  return formatDate(date); // "今天", "昨天", "2026-09-15"
});
```

#### UI 规范

**列表项高度**: 最小 64px (单行), 自适应多行  
**间距**: 8px 垂圾间距  
**分隔线**: 1px solid rgba(0,0,0,0.1)

**操作按钮**:
- 小按钮: 28px × 28px
- 图标: 16px × 16px
- 颜色: 蓝色 (主要), 灰色 (次要), 红色 (删除)

#### 国际化

**中文**:
```typescript
notificationCenter: {
  title: "通知中心",
  noNotifications: "暂无通知",
  markRead: "标记已读",
  markAllRead: "全部已读",
  delete: "删除",
  clearRead: "清除已读",
  selectAll: "全选",
  today: "今天",
  yesterday: "昨天",
  older: "更早",
  detail: "详情",
  from: "来自",
  time: "时间",
}
```

#### 测试需求

**单元测试**:
- [ ] 通知列表渲染
- [ ] 已读/未读切换
- [ ] 删除通知
- [ ] 批量操作
- [ ] 分组显示

**集成测试**:
- [ ] 与通知中心集成
- [ ] 实时推送接收
- [ ] 状态同步

---

## 📅 实施时间线

### Day 1 (2026-09-18)
```
09:00-12:00  创建 PushPermissionDialog.svelte 基础结构
12:00-13:00  午休
13:00-16:00  实现 3 步流程和权限请求
16:00-18:00  添加国际化和 A11y
18:00-19:00  编写单元测试
19:00-20:00  手动测试和调试
```

### Day 2 (2026-09-19)
```
09:00-12:00  创建 PushNotificationSettings.svelte 基础结构
12:00-13:00  午休
13:00-16:00  实现开关和设备令牌区域
16:00-18:00  添加统计信息面板
18:00-20:00  实现历史记录查看器
```

### Day 3 (2026-09-20)
```
09:00-12:00  完善 PushNotificationSettings
12:00-13:00  午休
13:00-16:00  添加测试推送功能 (dev)
16:00-18:00  编写单元测试
18:00-20:00  集成测试和调试
```

### Day 4 (2026-09-21)
```
09:00-12:00  创建 NotificationList.svelte
12:00-13:00  午休
13:00-16:00  集成到通知中心
16:00-18:00  实现实时更新
18:00-20:00  最终测试和文档
```

---

## 🔧 技术栈

### 前端框架
- **Svelte 4**: 组件开发
- **TypeScript**: 类型安全
- **Tauri API**: 系统集成

### 样式
- **Tailwind CSS**: 快速样式开发
- **CSS Variables**: 主题切换
- **Dark Mode**: 深色模式支持

### 测试
- **Bun Test**: 单元测试
- **Testing Library**: 组件测试
- **Mock Tauri API**: API 模拟

### 国际化
- **svelte-i18n**: i18n 库
- **中文/英文**: 双语支持

---

## ✅ 验收标准

### 功能完整性
- [ ] 所有 3 个组件实现完整
- [ ] 权限请求流程正常
- [ ] 设置保存和读取正常
- [ ] 通知历史显示正常
- [ ] 实时更新工作正常

### 用户体验
- [ ] 界面美观，符合 iOS 设计规范
- [ ] 深色模式完美支持
- [ ] 响应式布局适配各屏幕尺寸
- [ ] 动画流畅，无卡顿
- [ ] 交互反馈及时

### 可访问性
- [ ] 键盘导航完整
- [ ] 屏幕阅读器友好
- [ ] ARIA 属性完整
- [ ] 焦点管理正确
- [ ] 颜色对比度达标 (WCAG AA)

### 国际化
- [ ] 中英文完整翻译
- [ ] 字符串无硬编码
- [ ] 日期时间格式化
- [ ] 数字本地化

### 测试覆盖
- [ ] 单元测试覆盖率 > 80%
- [ ] 所有测试通过
- [ ] 集成测试完成
- [ ] 手动测试通过

### 文档
- [ ] 组件 API 文档
- [ ] 使用示例
- [ ] 完成报告

---

## 📊 质量指标

| 指标 | 目标 | 标准 |
|------|------|------|
| **测试覆盖率** | >80% | >70% |
| **组件大小** | <500行/组件 | <800行 |
| **加载时间** | <100ms | <200ms |
| **响应时间** | <16ms | <32ms |
| **A11y 评分** | >95 | >90 |
| **国际化** | 100% | 100% |

---

## 🚧 风险与依赖

### 技术风险
- **低风险**: 后端 API 已就绪
- **低风险**: TypeScript 类型已定义
- **中风险**: 通知中心集成可能需要重构

### 依赖项
- ✅ Phase 2 后端 API
- ✅ Tauri 命令注册
- ✅ TypeScript 类型定义
- ⏳ 通知中心现有代码 (需要调研)

### 缓解措施
- 提前调研通知中心代码结构
- 模块化设计，降低耦合
- 预留集成调试时间

---

## 📝 下一步行动

### 立即开始 (Day 1)

1. **创建组件文件**:
   ```bash
   touch crates/amos-tauri/frontend-ts/src/svelte/modules/PushPermissionDialog.svelte
   ```

2. **创建测试文件**:
   ```bash
   touch crates/amos-tauri/frontend-ts/src/lib/__tests__/PushPermissionDialog.test.ts
   ```

3. **添加国际化字符串**:
   - 编辑 `src/i18n/locales/zh.ts`
   - 编辑 `src/i18n/locales/en.ts`

4. **开始实现**:
   - 基础结构和布局
   - 权限状态管理
   - 3 步流程逻辑

---

**准备就绪，开始 Phase 3！** 🚀

*计划创建时间: 2026年9月17日 23:30*  
*预计完成时间: 2026年9月21日 20:00*
