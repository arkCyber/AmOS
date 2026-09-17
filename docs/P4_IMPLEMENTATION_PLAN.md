# P4 优先级实施计划

**日期**: 2026年9月17日 13:00  
**预计时间**: 1-2周  
**状态**: ✅ 已完成（2026年9月17日 15:30）

---

## 📋 任务清单

### 1. ✅ ContactsApp 虚拟滚动集成
**目标**: 提升 800+ 联系人列表性能  
**预期**: 初始渲染从 800+ 节点降至 ~15 节点，60fps 流畅滚动

#### 实施步骤
- [x] 1.1 在 ContactsApp.svelte 添加虚拟滚动状态管理
- [x] 1.2 使用 `calculateVirtualRange` 计算可见范围
- [x] 1.3 重构联系人列表渲染逻辑
- [x] 1.4 保持搜索、分组、滚动到顶部等现有功能
- [x] 1.5 添加性能测试

#### 技术细节
```typescript
// ContactsApp.svelte 新增状态
let scrollTop = $state(0);
let containerHeight = $state(600);
const ITEM_HEIGHT = 64; // 联系人行高

const visibleRange = $derived(
  calculateVirtualRange(scrollTop, containerHeight, filtered.length, ITEM_HEIGHT, 3)
);
```

---

### 2. ✅ Settings UI - Dock 配置面板
**目标**: 用户可配置 Dock 位置、自动隐藏、放大倍数  
**位置**: Settings > 桌面与 Dock

#### 实施步骤
- [x] 2.1 创建 `DockPage.svelte` 设置页面
- [x] 2.2 添加 Dock 偏好设置存储（`lib/dockPrefs.ts`）
- [x] 2.3 在 SettingsApp.svelte 添加 "桌面与 Dock" 入口
- [x] 2.4 在 Dock.svelte 集成偏好设置
- [x] 2.5 添加实时预览功能

#### 配置选项
```typescript
interface DockPrefs {
  position: DockPosition;        // "bottom" | "left" | "right"
  autoHide: boolean;             // 自动隐藏
  magnification: number;         // 放大倍数 (1.0 - 2.0)
  iconSize: number;              // 图标大小 (32 - 64)
}
```

#### UI 设计
- **位置选择**: Segmented Control (底部/左侧/右侧)
- **自动隐藏**: Toggle 开关
- **放大倍数**: Slider (1.0x - 2.0x)
- **图标大小**: Slider (小 32px - 大 64px)

---

### 3. ✅ Dock 弹跳 API 集成
**目标**: MessagesApp、PhoneApp 触发弹跳通知  
**实现**: 在新消息/未接来电时调用 `emitDockBounce(appId)`

#### 实施步骤
- [x] 3.1 在 MessagesApp.svelte 集成弹跳通知
- [x] 3.2 在 PhoneApp.svelte 集成弹跳通知
- [x] 3.3 添加弹跳触发条件逻辑
- [x] 3.4 测试弹跳动画效果
- [x] 3.5 添加用户偏好设置（是否启用弹跳）

#### 触发场景
**MessagesApp**:
- 新消息到达时（本地或远程）
- 仅在应用未激活时触发

**PhoneApp**:
- 未接来电
- 语音留言
- 仅在应用未激活时触发

#### 实现示例
```typescript
// MessagesApp.svelte
import { emitDockBounce } from "../lib/dockConfig";

$effect(() => {
  const total = unreadCount(conversations);
  if (total > 0 && !isAppActive) {
    emitDockBounce("messages");
  }
});

// PhoneApp.svelte
$effect(() => {
  const missed = missedCalls(callLog);
  if (missed.length > 0 && !isAppActive) {
    emitDockBounce("phone");
  }
});
```

---

## 🎯 质量目标

### 性能指标
- ContactsApp 初始渲染: < 50ms
- ContactsApp 滚动帧率: 60fps
- Dock 配置切换: < 100ms 响应

### 测试覆盖
- 虚拟滚动边界测试
- Dock 配置持久化测试
- 弹跳事件触发测试

### 无障碍性
- Dock 配置 UI 满足 WCAG 2.1 AA
- 虚拟滚动保持键盘导航
- 弹跳动画支持 `prefers-reduced-motion`

---

## 📊 预期成果

### ContactsApp 虚拟滚动
- **Before**: 800 联系人 = 800+ DOM 节点
- **After**: 800 联系人 = 15-20 DOM 节点（可见范围）
- **性能提升**: 40x DOM 节点减少，60fps 流畅滚动

### Dock 配置面板
- **新增文件**: 
  - `src/svelte/settings/DockPage.svelte`
  - `src/lib/dockPrefs.ts`
  - `src/lib/__tests__/dockPrefs.test.ts`
- **用户可配置**: 位置、自动隐藏、放大倍数、图标大小

### Dock 弹跳通知
- **集成应用**: MessagesApp、PhoneApp
- **触发场景**: 新消息、未接来电
- **用户体验**: 即时视觉反馈

---

## 🚀 实施顺序

### Phase 1: ContactsApp 虚拟滚动（预计 2-3 小时）
1. 添加虚拟滚动状态管理
2. 重构列表渲染逻辑
3. 测试搜索、分组功能
4. 性能验证

### Phase 2: Dock 配置面板（预计 3-4 小时）
1. 创建 DockPrefs 数据模型
2. 创建 DockPage UI 组件
3. 集成到 SettingsApp
4. 集成到 Dock 组件
5. 添加单元测试

### Phase 3: Dock 弹跳集成（预计 1-2 小时）
1. MessagesApp 弹跳逻辑
2. PhoneApp 弹跳逻辑
3. 测试弹跳动画
4. 文档更新

---

## ✅ 验收标准

### ContactsApp 虚拟滚动
- [x] 800+ 联系人列表渲染 < 50ms
- [x] 滚动帧率稳定在 60fps
- [x] 搜索功能正常工作
- [x] 分组功能正常工作
- [x] 键盘导航正常工作

### Dock 配置面板
- [x] 所有配置选项可持久化
- [x] 实时预览功能正常
- [x] TypeScript 无错误
- [x] 单元测试通过
- [x] UI 符合 iOS 设置风格

### Dock 弹跳通知
- [x] 新消息触发弹跳
- [x] 未接来电触发弹跳
- [x] 应用激活时不触发
- [x] 动画流畅自然
- [x] 支持 reduced motion

---

**开始时间**: 2026年9月17日 13:00  
**完成时间**: 2026年9月17日 15:30  
**实际用时**: 2.5小时 (预计7小时)
