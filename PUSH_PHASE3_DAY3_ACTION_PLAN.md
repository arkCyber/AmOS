# Phase 3 Day 3: 通知中心集成 - 行动计划

**日期**: 2026年9月18日  
**预计时间**: 6-8 小时  
**目标**: 完成通知中心集成，使推送通知与现有通知系统无缝对接

---

## 🎯 核心目标

将推送通知系统集成到 AmOS 现有的通知中心，实现统一的通知管理体验。

---

## 📋 任务清单

### 阶段 1: 调研与规划 (1-2 小时)

#### 1.1 调研现有通知中心代码
- [ ] 查找通知中心主组件位置
- [ ] 分析通知中心的数据结构
- [ ] 了解现有通知的显示机制
- [ ] 识别通知中心的 API 接口
- [ ] 检查通知中心的样式系统

**关键文件**:
```
src/svelte/modules/NotificationCenter.svelte (如果存在)
src/lib/notifications.ts (如果存在)
src/svelte/Shell.svelte (可能包含通知中心)
```

#### 1.2 设计集成方案
- [ ] 确定推送通知的展示位置
- [ ] 设计统一的通知数据模型
- [ ] 规划通知分类方案（系统/推送）
- [ ] 设计通知过滤和搜索功能
- [ ] 制定通知优先级排序规则

**集成方案选项**:
```
方案 A: 独立标签页
  - 通知中心增加"推送通知"标签
  - 与系统通知分开显示
  - 优点: 清晰分离，易于实现
  - 缺点: 用户需切换标签

方案 B: 统一列表
  - 推送通知和系统通知混合显示
  - 按时间倒序排列
  - 优点: 统一体验
  - 缺点: 需要统一数据格式

方案 C: 混合模式
  - 顶部显示最新推送通知
  - 下方显示系统通知
  - 优点: 突出重要性
  - 缺点: 实现复杂度高

推荐: 方案 B (统一列表)
```

---

### 阶段 2: 数据层集成 (2-3 小时)

#### 2.1 创建统一通知数据模型
```typescript
// src/lib/notifications.ts (或新建)

export type NotificationType = "system" | "push" | "app";

export interface UnifiedNotification {
  id: string;
  type: NotificationType;
  title: string;
  body?: string;
  icon?: string;
  timestamp: number;
  read: boolean;
  priority: "high" | "normal" | "low";
  source: string; // "system", "push", "app_name"
  
  // 推送通知特有字段
  badge?: number;
  sound?: boolean;
  
  // 系统通知特有字段
  action?: () => void;
  dismissable?: boolean;
}

export interface NotificationStore {
  items: UnifiedNotification[];
  unreadCount: number;
  filters: {
    type?: NotificationType;
    read?: boolean;
    source?: string;
  };
}
```

#### 2.2 实现推送通知转换函数
```typescript
// 将 RustNotificationRecord 转换为 UnifiedNotification
function convertPushToUnified(
  push: RustNotificationRecord
): UnifiedNotification {
  return {
    id: push.id,
    type: "push",
    title: push.title || "推送通知",
    body: push.body,
    timestamp: push.received_at,
    read: push.is_read || false,
    priority: push.has_badge ? "high" : "normal",
    source: "push",
    badge: push.badge_count,
    sound: push.has_sound,
  };
}
```

#### 2.3 实现通知聚合器
```typescript
// 聚合所有来源的通知
async function aggregateNotifications(): Promise<UnifiedNotification[]> {
  const pushNotifications = await getNotificationHistory(100);
  const systemNotifications = await getSystemNotifications();
  
  const unified = [
    ...pushNotifications.map(convertPushToUnified),
    ...systemNotifications.map(convertSystemToUnified),
  ];
  
  // 按时间倒序排列
  return unified.sort((a, b) => b.timestamp - a.timestamp);
}
```

---

### 阶段 3: UI 层集成 (2-3 小时)

#### 3.1 创建统一通知列表组件
```svelte
<!-- NotificationList.svelte -->
<script lang="ts">
  import type { UnifiedNotification } from "@/lib/notifications";
  
  export let notifications: UnifiedNotification[];
  export let onRead: (id: string) => void;
  export let onDelete: (id: string) => void;
</script>

<div class="notification-list">
  {#each notifications as notification (notification.id)}
    <div 
      class="notification-item"
      class:unread={!notification.read}
      class:push={notification.type === "push"}
    >
      <!-- 通知内容 -->
    </div>
  {/each}
</div>
```

#### 3.2 集成到通知中心
```svelte
<!-- NotificationCenter.svelte -->
<script lang="ts">
  import NotificationList from "./modules/NotificationList.svelte";
  import { aggregateNotifications } from "@/lib/notifications";
  
  let notifications: UnifiedNotification[] = [];
  let filter: "all" | "push" | "system" = "all";
  
  async function loadNotifications() {
    const all = await aggregateNotifications();
    notifications = filter === "all" 
      ? all 
      : all.filter(n => n.type === filter);
  }
  
  onMount(() => {
    loadNotifications();
    // 每 5 秒刷新
    const interval = setInterval(loadNotifications, 5000);
    return () => clearInterval(interval);
  });
</script>

<div class="notification-center">
  <!-- 过滤器 -->
  <div class="filters">
    <button on:click={() => filter = "all"}>全部</button>
    <button on:click={() => filter = "push"}>推送</button>
    <button on:click={() => filter = "system"}>系统</button>
  </div>
  
  <!-- 通知列表 -->
  <NotificationList 
    {notifications}
    onRead={handleMarkRead}
    onDelete={handleDelete}
  />
</div>
```

---

### 阶段 4: 实时更新机制 (1-2 小时)

#### 4.1 实现 WebSocket 或轮询
```typescript
// 监听新推送通知事件
import { listen } from "@tauri-apps/api/event";

const unlisten = await listen<RustNotificationRecord>(
  "push-received",
  (event) => {
    const newNotification = convertPushToUnified(event.payload);
    notifications = [newNotification, ...notifications];
    
    // 显示弹窗提示
    showNotificationToast(newNotification);
  }
);
```

#### 4.2 实现通知弹窗提示
```svelte
<!-- NotificationToast.svelte -->
<script lang="ts">
  import { fade, fly } from "svelte/transition";
  
  export let notification: UnifiedNotification;
  export let onClose: () => void;
  
  // 3 秒后自动关闭
  setTimeout(onClose, 3000);
</script>

<div 
  class="notification-toast"
  transition:fly={{ y: -20, duration: 300 }}
  on:click={onClose}
>
  <div class="toast-icon">
    {notification.type === "push" ? "📬" : "ℹ️"}
  </div>
  <div class="toast-content">
    <strong>{notification.title}</strong>
    {#if notification.body}
      <p>{notification.body}</p>
    {/if}
  </div>
</div>
```

---

### 阶段 5: 交互功能实现 (1 小时)

#### 5.1 批量操作
- [ ] 全选/取消全选
- [ ] 批量标记已读
- [ ] 批量删除
- [ ] 清除已读通知

#### 5.2 单个通知操作
- [ ] 点击标记已读
- [ ] 滑动删除（移动端）
- [ ] 右键菜单（桌面端）
- [ ] 点击跳转到相关应用

#### 5.3 通知过滤和搜索
- [ ] 按类型过滤（全部/推送/系统）
- [ ] 按已读/未读过滤
- [ ] 按来源过滤
- [ ] 搜索通知内容

---

### 阶段 6: 样式统一 (1 小时)

#### 6.1 通知卡片样式
```css
.notification-item {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 8px;
  transition: all 0.2s ease;
}

.notification-item.unread {
  border-left: 4px solid #007aff;
  background: rgba(0, 122, 255, 0.05);
}

.notification-item.push {
  /* 推送通知特殊样式 */
}

.notification-item:hover {
  background: var(--bg-hover);
}
```

#### 6.2 徽章和指示器
```svelte
{#if notification.type === "push"}
  <span class="notification-badge push">推送</span>
{/if}

{#if notification.badge && notification.badge > 0}
  <span class="badge-count">{notification.badge}</span>
{/if}

{#if notification.sound}
  <span class="sound-indicator">🔔</span>
{/if}
```

---

## 🧪 测试计划

### 单元测试
```typescript
// NotificationList.test.ts
describe("NotificationList", () => {
  test("渲染通知列表", () => {
    // ...
  });
  
  test("标记通知为已读", () => {
    // ...
  });
  
  test("删除通知", () => {
    // ...
  });
  
  test("过滤通知", () => {
    // ...
  });
});
```

### 集成测试
- [ ] 推送通知正确显示在通知中心
- [ ] 实时更新正常工作
- [ ] 批量操作功能正常
- [ ] 过滤和搜索功能正常
- [ ] 通知弹窗正确显示

### 手动测试
- [ ] 发送测试推送，验证实时显示
- [ ] 测试标记已读/未读
- [ ] 测试批量操作
- [ ] 测试过滤器切换
- [ ] 测试深色模式显示
- [ ] 测试响应式布局

---

## 📦 交付清单

### 代码文件
- [ ] `src/lib/notifications.ts` - 统一通知数据模型
- [ ] `src/svelte/modules/NotificationList.svelte` - 通知列表组件
- [ ] `src/svelte/modules/NotificationToast.svelte` - 通知弹窗组件
- [ ] 修改 `src/svelte/modules/NotificationCenter.svelte` - 集成推送通知

### 测试文件
- [ ] `src/lib/__tests__/notifications.test.ts`
- [ ] `src/lib/__tests__/NotificationList.test.ts`

### 文档
- [ ] 通知中心集成文档
- [ ] API 使用说明
- [ ] 更新 Phase 3 进度报告

---

## 🎯 验收标准

### 功能完整性
- [ ] 推送通知正确显示在通知中心
- [ ] 通知按时间倒序排列
- [ ] 标记已读/未读功能正常
- [ ] 删除通知功能正常
- [ ] 批量操作功能正常
- [ ] 过滤器功能正常
- [ ] 实时更新正常工作
- [ ] 通知弹窗正确显示

### 用户体验
- [ ] 界面美观，符合 iOS 设计规范
- [ ] 深色模式完美支持
- [ ] 响应式布局适配各屏幕尺寸
- [ ] 动画流畅，无卡顿
- [ ] 交互反馈及时

### 性能
- [ ] 通知列表加载时间 < 100ms
- [ ] 实时更新延迟 < 1s
- [ ] 大量通知时无性能问题（分页加载）

---

## 🚧 潜在风险

### 技术风险
- **中风险**: 现有通知中心代码可能需要重构
- **低风险**: 实时更新机制可能需要调试
- **低风险**: 通知数据格式可能需要统一

### 缓解措施
- 提前充分调研现有代码
- 模块化设计，降低耦合
- 预留调试和重构时间
- 保持与现有系统的向后兼容

---

## 📅 时间分配

```
09:00-11:00  调研现有通知中心代码 + 设计方案 (2h)
11:00-12:00  午休
12:00-14:00  数据层集成 (2h)
14:00-17:00  UI 层集成 (3h)
17:00-18:00  实时更新机制 (1h)
18:00-19:00  晚餐
19:00-20:00  交互功能 + 样式统一 (1h)
20:00-21:00  测试和调试 (1h)
21:00-22:00  文档编写 (1h)

总计: 8 小时 (含休息)
```

---

## 💡 技术要点

### 1. 通知去重
确保同一推送通知不会重复显示：
```typescript
function deduplicateNotifications(
  notifications: UnifiedNotification[]
): UnifiedNotification[] {
  const seen = new Set<string>();
  return notifications.filter(n => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}
```

### 2. 性能优化
使用虚拟滚动处理大量通知：
```typescript
import VirtualList from "@sveltejs/svelte-virtual-list";

<VirtualList items={notifications} let:item>
  <NotificationItem notification={item} />
</VirtualList>
```

### 3. 无障碍支持
```html
<div 
  role="list" 
  aria-label="通知列表"
  aria-live="polite"
>
  {#each notifications as notification}
    <div 
      role="listitem"
      aria-label={`${notification.title}, ${notification.body}`}
      tabindex="0"
    >
      <!-- 通知内容 -->
    </div>
  {/each}
</div>
```

---

**计划创建时间**: 2026年9月17日 23:55  
**计划执行日期**: 2026年9月18日  
**预计完成时间**: 2026年9月18日 22:00  
**负责人**: Claude (Cursor Agent)
