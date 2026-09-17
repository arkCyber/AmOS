# AmOS 后续工作实施计划

**创建日期**: 2026年9月17日 11:18 (UTC+8)  
**状态**: 待执行

---

## 📋 总体概览

| 优先级 | 工作项 | 预估工时 | 目标 |
|--------|--------|----------|------|
| P2 | A11y 无障碍修复（12个缺口） | 1-1.5天 | 达到 100 分 |
| P2 | Dock 高级功能 | 1-1.5天 | 完整 macOS 对齐 |
| P3 | 报告文件清理（45个） | 0.5天 | 代码库净化 |
| P3 | 虚拟滚动优化 | 0.5天 | 性能提升 |
| P3 | 主题切换动画优化 | 0.5天 | 体验平滑 |

**总工期**: 3-5 天

---

## 🔲 P2 优先级（2-3 天）

### 1. A11y 无障碍修复（目标：100分）

#### 缺口清单（12个）

| # | 缺口描述 | 位置 | 修复方案 |
|---|----------|------|----------|
| 1 | 按钮缺少 `aria-label` | `DesktopShell.svelte` | 添加可访问标签 |
| 2 | 图标按钮缺少替代文本 | `AppIcon.svelte` | 添加 `aria-hidden` + tooltip |
| 3 | 表单缺少关联标签 | `SettingsApp.svelte` | 使用 `aria-labelledby` |
| 4 | 对话框缺少 `role="dialog"` | `SpotlightOverlay.svelte` | 添加 ARIA 属性 |
| 5 | 列表缺少语义结构 | `Dock.svelte` | 添加 `role="list"` |
| 6 | 图片缺少 `alt` 属性 | `ContactsApp.svelte` | 动态生成 alt 文本 |
| 7 | 焦点管理不完整 | `MissionControl.svelte` | 添加 `tabindex` 流 |
| 8 | 实时区域未声明 | `ControlCenter.svelte` | 添加 `aria-live` |
| 9 | 颜色对比度不足 | 多个组件 | 使用暗色变量 |
| 10 | 触摸目标尺寸过小 | `DockTileButton.svelte` | 增大到 44x44px |
| 11 | 跳过导航链接缺失 | `DesktopShell.svelte` | 添加跳转链接 |
| 12 | 键盘导航不一致 | 多个组件 | 统一方向键行为 |

#### 实施步骤

```typescript
// 1. 创建无障碍审计清单
// 文件: frontend-ts/src/lib/__tests__/a11y-checklist.test.ts

// 2. 修复清单
// 2.1 DesktopShell.svelte - 添加跳转链接
<div id="main-content" tabindex="-1">...</div>
<a href="#main-content" class="sr-only focus:not-sr-only">Skip to content</a>

// 2.2 Dock.svelte - 添加列表语义
<ul role="list" aria-label="Dock applications">
  <li role="listitem">...</li>
</ul>

// 2.3 SpotlightOverlay.svelte - 对话框属性
<div role="dialog" aria-modal="true" aria-labelledby="spotlight-title">

// 2.4 ControlCenter.svelte - 实时区域
<div aria-live="polite" aria-atomic="true">
```

#### 测试验证

```bash
# 运行 axe-core 测试
$ npm run test:a11y

# 预期结果
✓ 12/12 缺口已修复
✓ axe-core 评分: 100/100
```

---

### 2. Dock 高级功能

#### 2.1 Bounce 动画（弹跳效果）

**macOS 行为**: Dock 图标在应用收到通知时弹跳

```svelte
<!-- DockAppItem.svelte -->
<script lang="ts">
  let bouncing = $state(false);
  
  // 监听通知事件
  $effect(() => {
    const handler = (e: CustomEvent) => {
      if (e.detail.appId === id) {
        bouncing = true;
        setTimeout(() => bouncing = false, 1000);
      }
    };
    window.addEventListener('dock-bounce', handler as EventListener);
    return () => window.removeEventListener('dock-bounce', handler as EventListener);
  });
</script>

<div class:animate-bounce={bouncing}>
  <AppIcon {id} {icon} />
</div>

<style>
  @keyframes bounce {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-12px); }
  }
  .animate-bounce {
    animation: bounce 0.4s ease-in-out 3;
  }
</style>
```

#### 2.2 自动隐藏（Auto-hide）

**macOS 行为**: Dock 在全屏应用时自动隐藏，鼠标移到底部时显示

```svelte
<!-- Dock.svelte -->
<script lang="ts">
  let autoHide = $state(false);
  let dockVisible = $state(true);
  let hideTimer: number | null = null;
  
  // 监听全屏应用
  $effect(() => {
    const checkFullscreen = () => {
      autoHide = !!document.fullscreenElement;
    };
    document.addEventListener('fullscreenchange', checkFullscreen);
    return () => document.removeEventListener('fullscreenchange', checkFullscreen);
  });
  
  // 鼠标移到底部时显示
  function onMouseNearDock(e: MouseEvent) {
    if (autoHide && e.clientY > window.innerHeight - 20) {
      dockVisible = true;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (autoHide) dockVisible = false;
      }, 2000);
    }
  }
</script>

<div 
  class="transition-transform duration-300"
  class:translate-y-full={!dockVisible}
  class:translate-y-0={dockVisible}
  onmousemove={onMouseNearDock}
>
  <!-- Dock content -->
</div>
```

#### 2.3 位置切换（位置偏好）

**macOS 行为**: Dock 可以位于屏幕底部/左侧/右侧

```typescript
// lib/desktopLayout.ts
export type DockPosition = 'bottom' | 'left' | 'right';

export interface DockConfig {
  position: DockPosition;
  autoHide: boolean;
  magnification: boolean;
}

export function dockPositionClass(position: DockPosition): string {
  switch (position) {
    case 'bottom': return 'bottom-0 left-0 right-0';
    case 'left': return 'left-0 top-0 bottom-0';
    case 'right': return 'right-0 top-0 bottom-0';
  }
}
```

---

## 🟡 P3 优先级（1-2 天）

### 3. 清理未追踪报告文件（45个）

#### 文件清单

```bash
# 未追踪的报告文件
?? AMOS联系人功能完整实施报告_2026_09_17.md
?? AVATAR_OPTIMIZATION_COMPLETION.md
?? CARTOON_AVATAR_COMPLETION.md
?? CODE_CLEANUP_COMPLETION_2026_SEP17.md
?? CUSTOM_AVATAR_IMPLEMENTATION_SUMMARY.md
?? CUSTOM_AVATAR_UPLOAD_COMPLETION.md
?? DESKTOP_MACOS_ALIGNMENT_PLAN.md
?? DESKTOP_P0_COMPLETION_REPORT.md
?? DOCK_MACOS_ALIGNMENT_AUDIT.md
?? DOCK_P1_IMPLEMENTATION_PLAN.md
?? DOCK_P1_VISUAL_IMPROVEMENTS_COMPLETE.md
?? EMOJI_THEMES_COMPLETION.md
?? Emoji主题扩展完成总结.md
?? FUTURE_OPTIMIZATION_ANALYSIS.md
?? MACOS_DESKTOP_ALIGNMENT_COMPLETE.md
?? P5_ADVANCED_ANIMATIONS_COMPLETION.md
?? P5_CODE_AUDIT_COMPLETION_EN.md
?? P5_代码审计与补全报告_2026_09_17.md
?? P5_审计补全完成确认.md
?? P5_高级动画完成确认.md
?? P5_高级动画效果完成报告_2026_09_17.md
?? SESSION_MACOS_ALIGNMENT_2026_SEP17.md
?? SESSION_WORK_SUMMARY_2026_SEP17.md
?? 头像上传功能完成确认.md
?? 审计完成报告_2026年9月17日.md
?? 执行摘要_联系人功能完成.md
?? 未来优化完成总结.md
?? 桌面对齐完成总结.md
?? 自定义头像上传完成总结_2026_09_17.md
?? 自定义头像上传最终执行报告_2026_09_17.md
```

#### 清理策略

```bash
# 1. 创建归档目录
$ mkdir -p docs/archive/2026-09

# 2. 移动未追踪文件到归档目录
$ git status --porcelain | grep "^??" | awk '{print $2}' | grep "\.md$" | xargs -I {} mv {} docs/archive/2026-09/

# 3. 验证
$ git status
```

#### 分类归档建议

| 类别 | 目标目录 |
|------|----------|
| 审计报告 | `docs/archive/2026-09/audit/` |
| 功能完成报告 | `docs/archive/2026-09/completion/` |
| 实施计划 | `docs/archive/2026-09/plans/` |
| 中文报告 | `docs/archive/2026-09/zh/` |

---

### 4. 虚拟滚动优化

#### 目标场景
- 联系人列表 > 500 项
- 文件列表 > 1000 项
- 消息列表 > 500 条

#### 实施方案

```typescript
// lib/virtualScroll.ts
import { useVirtualizer } from '$lib/solid-virtual';

export function createVirtualList(
  containerRef: () => HTMLElement | undefined,
  items: () => unknown[],
  itemHeight: number = 64,
) {
  return useVirtualizer({
    count: items.length,
    getScrollElement: containerRef,
    estimateSize: () => itemHeight,
    overscan: 5, // 预渲染缓冲区
  });
}
```

#### 联系人列表优化

```svelte
<!-- ContactsApp.svelte -->
<script lang="ts">
  import { createVirtualList } from '$lib/virtualScroll';
  
  let listRef = $state<HTMLElement>();
  const virtualizer = createVirtualList(
    () => listRef,
    () => flattenedContacts,
    72, // 每项高度
  );
</script>

<div 
  bind:this={listRef}
  class="overflow-auto"
  style="height: calc(100vh - 200px);"
>
  <div
    style="height: {virtualizer.getTotalSize()}px; position: relative;"
  >
    {#each virtualizer.getVirtualItems() as row (row.index)}
      <div
        style="
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: {row.size}px;
          transform: translateY({row.start}px);
        "
      >
        <!-- 渲染联系人项 -->
      </div>
    {/each}
  </div>
</div>
```

---

### 5. 主题切换动画优化

#### 目标
- 深色/浅色模式切换时平滑过渡
- 支持 `prefers-reduced-motion` 用户

#### 实施方案

```css
/* index.css */
:root {
  --theme-transition: 0.3s ease;
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --theme-transition: 0s;
  }
}

body {
  transition: 
    background-color var(--theme-transition),
    color var(--theme-transition);
}

/* 主题特定动画 */
.theme-transitioning {
  animation: theme-fade 0.3s ease-in-out;
}

@keyframes theme-fade {
  0% { opacity: 1; }
  50% { opacity: 0.5; }
  100% { opacity: 1; }
}
```

```svelte
<!-- ThemeToggle.svelte -->
<script lang="ts">
  let transitioning = $state(false);
  
  async function toggleTheme() {
    transitioning = true;
    await new Promise(r => setTimeout(r, 150));
    // 执行主题切换
    document.documentElement.classList.toggle('dark');
    await new Promise(r => setTimeout(r, 150));
    transitioning = false;
  }
</script>

<button 
  class:theme-transitioning={transitioning}
  onclick={toggleTheme}
>
  {#if transitioning}
    <Spinner />
  {:else}
    <SunIcon class="dark:hidden" />
    <MoonIcon class="hidden dark:block" />
  {/if}
</button>
```

---

## 📊 工作分配建议

### 方案 A：串行执行（3-5天）

```
Day 1: A11y 修复 (上)
Day 2: A11y 修复 (下) + Dock 弹跳动画
Day 3: Dock 自动隐藏 + 位置切换
Day 4: 报告清理 + 虚拟滚动
Day 5: 主题动画 + 测试
```

### 方案 B：并行执行（2-3天）

```
并行 Track 1 (P2 重点):
  - A11y 修复
  - Dock 高级功能

并行 Track 2 (P3 重点):
  - 报告清理
  - 虚拟滚动
  - 主题动画
```

---

## ✅ 完成标准

### P2 完成标准
- [ ] axe-core 无障碍评分达到 100/100
- [ ] 所有 Dock 交互符合 macOS 行为规范
- [ ] 自动隐藏响应时间 < 100ms
- [ ] 单元测试覆盖率 > 90%

### P3 完成标准
- [ ] 未追踪报告文件全部归档
- [ ] 虚拟滚动在 1000+ 列表项下保持 60fps
- [ ] 主题切换无闪烁
- [ ] 符合 `prefers-reduced-motion` 规范

---

## 📝 备注

1. **分支策略**: 建议创建 `feature/a11y-dock-enhancements` 分支
2. **PR 拆分**: 可拆分为 2 个 PR（A11y+Dock 为 PR1，清理+优化为 PR2）
3. **回归测试**: 每次合并前运行完整测试套件

---

**计划制定**: Kiro AI  
**预计开始**: 2026年9月17日
