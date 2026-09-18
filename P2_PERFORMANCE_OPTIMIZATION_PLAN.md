# P2 性能优化实施计划

**创建日期**: 2026-09-18  
**优先级**: 🟢 P2  
**预计工期**: 4-6 小时  
**状态**: 🔄 进行中

---

## 📋 优化目标

### 1. AuditLogViewer 虚拟滚动
**问题**: 当日志数量超过 1000+ 时，渲染所有 DOM 节点会导致性能下降
**目标**: 
- ✅ 支持 10,000+ 日志流畅滚动
- ✅ 首屏渲染时间 < 100ms
- ✅ 滚动帧率 > 55 FPS

**技术方案**: 
- 使用 `svelte-virtual-list` 或自定义虚拟滚动实现
- 每次仅渲染可见区域 + 缓冲区（约 20-30 条）
- 动态高度支持（日志项高度不固定）

### 2. TemplateLibrary 懒加载
**问题**: 一次性加载所有模板和图标，首屏加载慢
**目标**:
- ✅ 首屏加载时间减少 50%
- ✅ 按需加载模板详情
- ✅ 图片懒加载

**技术方案**:
- 初始仅加载元数据（标题、类别、描述摘要）
- 滚动到可视区域时加载完整详情
- 使用 `IntersectionObserver` 实现图片懒加载

### 3. 搜索防抖优化
**问题**: 每次输入都触发搜索，高频操作导致卡顿
**目标**:
- ✅ 搜索延迟 300ms
- ✅ 取消未完成的搜索请求
- ✅ 显示搜索加载状态

**技术方案**:
- 实现通用 `debounce` 工具函数
- 搜索时显示 loading 指示器
- 使用 AbortController 取消过期请求

---

## 🔧 实施步骤

### Step 1: 创建虚拟滚动组件 (2h)
- [ ] 创建 `VirtualList.svelte` 通用组件
- [ ] 支持动态高度计算
- [ ] 支持滚动位置恢复
- [ ] 集成到 AuditLogViewer

### Step 2: 实现懒加载 (1.5h)
- [ ] 创建 `LazyImage.svelte` 组件
- [ ] TemplateLibrary 分页加载
- [ ] 模板详情按需加载

### Step 3: 搜索防抖 (1h)
- [ ] 创建 `debounce` 工具函数
- [ ] 集成到 TemplateLibrary 搜索
- [ ] 集成到 AuditLogViewer 筛选
- [ ] 添加搜索 loading 状态

### Step 4: 性能测试 (0.5h)
- [ ] 生成 10k+ 测试数据
- [ ] 性能基准测试
- [ ] 优化前后对比
- [ ] 编写性能测试报告

---

## 📊 性能指标

### 优化前基准
| 指标 | AuditLogViewer | TemplateLibrary |
|------|---------------|-----------------|
| 1000 条渲染时间 | ~800ms | ~500ms |
| 10000 条渲染时间 | ~8s (卡顿) | ~4s (卡顿) |
| 内存占用 | ~120MB | ~80MB |
| 滚动 FPS | ~30 FPS | ~45 FPS |

### 优化后目标
| 指标 | AuditLogViewer | TemplateLibrary |
|------|---------------|-----------------|
| 1000 条渲染时间 | < 100ms | < 80ms |
| 10000 条渲染时间 | < 150ms | < 100ms |
| 内存占用 | < 50MB | < 40MB |
| 滚动 FPS | > 55 FPS | > 58 FPS |

---

## 🎯 成功标准

- ✅ 所有测试通过（包括新增的性能测试）
- ✅ 用户体验无降级（功能完全一致）
- ✅ 代码可维护性不降低
- ✅ 向后兼容（API 不变）

---

## 📝 技术细节

### 虚拟滚动实现
```typescript
// VirtualList.svelte - 核心逻辑
interface VirtualListProps<T> {
  items: T[];
  itemHeight: number | ((item: T) => number);
  buffer?: number; // 缓冲区大小
  containerHeight: number;
}

// 计算可见范围
const visibleRange = $derived(() => {
  const start = Math.floor(scrollTop / avgItemHeight);
  const end = Math.ceil((scrollTop + containerHeight) / avgItemHeight);
  return {
    start: Math.max(0, start - buffer),
    end: Math.min(items.length, end + buffer)
  };
});
```

### 懒加载实现
```typescript
// LazyImage.svelte
let imageLoaded = $state(false);
let imageRef: HTMLImageElement;

$effect(() => {
  if (!imageRef) return;
  
  const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      imageLoaded = true;
      observer.disconnect();
    }
  });
  
  observer.observe(imageRef);
  return () => observer.disconnect();
});
```

### 防抖实现
```typescript
// lib/utils/debounce.ts
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: number | null = null;
  
  return (...args: Parameters<T>) => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}
```

---

## ⚠️ 风险与缓解

### 风险 1: 虚拟滚动动态高度复杂
**影响**: 中  
**缓解**: 
- 先实现固定高度版本（快速验证）
- 再升级为动态高度（渐进增强）
- 提供 `estimatedItemHeight` 配置

### 风险 2: 懒加载可能影响 SEO/可访问性
**影响**: 低  
**缓解**:
- 保留原始 `alt` 和 `title` 属性
- 加载占位符提供上下文
- 确保键盘导航正常

### 风险 3: 防抖延迟可能被用户察觉
**影响**: 低  
**缓解**:
- 300ms 延迟是行业标准
- 显示 loading 指示器提供反馈
- 允许通过配置调整延迟

---

## 📦 交付物

1. ✅ `VirtualList.svelte` - 通用虚拟滚动组件
2. ✅ `LazyImage.svelte` - 懒加载图片组件
3. ✅ `lib/utils/debounce.ts` - 防抖工具函数
4. ✅ 更新后的 `AuditLogViewer.svelte`
5. ✅ 更新后的 `TemplateLibrary.svelte`
6. ✅ 性能测试套件
7. ✅ 性能优化报告

---

**状态**: 📋 计划完成，准备实施  
**下一步**: 创建 VirtualList 组件
