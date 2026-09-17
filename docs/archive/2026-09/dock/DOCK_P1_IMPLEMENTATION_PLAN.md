# Dock P1改进实施计划

**目标**: 将AmOS Dock的macOS对齐度从 92% 提升至 96%  
**时间**: 3-5小时  
**优先级**: P1 (视觉完整性)

---

## 📋 改进项目

### 1. 系统图标 Emoji → SVG (2-4小时)

#### 当前问题
```typescript
// DockLaunchpadItem.svelte
glyph="🚀"  // ❌ 跨平台渲染不一致

// DockFinderItem.svelte
glyph="💻"  // ❌ 无法控制颜色/尺寸

// DockTrashItem.svelte  
glyph="🗑️"  // ❌ 不支持主题变体
```

**影响**:
- macOS: Noto Color Emoji
- Windows: Segoe UI Emoji
- Linux: 各发行版不同
- 结果: 视觉不一致，品牌受损

#### 解决方案

**方案A: 本地SVG组件** (推荐 - 无外部依赖)

```bash
# 1. 创建图标组件目录
mkdir -p crates/amos-tauri/frontend-ts/src/assets/icons
```

```svelte
<!-- src/assets/icons/IconLaunchpad.svelte -->
<svg
  width="32"
  height="32"
  viewBox="0 0 32 32"
  fill="currentColor"
  xmlns="http://www.w3.org/2000/svg"
  {...$$restProps}
>
  <!-- SF Symbols "square.grid.3x3" 简化版 -->
  <rect x="4" y="4" width="7" height="7" rx="1.5"/>
  <rect x="12.5" y="4" width="7" height="7" rx="1.5"/>
  <rect x="21" y="4" width="7" height="7" rx="1.5"/>
  <rect x="4" y="12.5" width="7" height="7" rx="1.5"/>
  <rect x="12.5" y="12.5" width="7" height="7" rx="1.5"/>
  <rect x="21" y="12.5" width="7" height="7" rx="1.5"/>
  <rect x="4" y="21" width="7" height="7" rx="1.5"/>
  <rect x="12.5" y="21" width="7" height="7" rx="1.5"/>
  <rect x="21" y="21" width="7" height="7" rx="1.5"/>
</svg>
```

```svelte
<!-- src/assets/icons/IconFinder.svelte -->
<svg
  width="32"
  height="32"
  viewBox="0 0 32 32"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  {...$$restProps}
>
  <!-- SF Symbols "folder" 简化版 -->
  <path
    d="M4 8C4 6.34 5.34 5 7 5H12L14 7H25C26.66 7 28 8.34 28 10V24C28 25.66 26.66 27 25 27H7C5.34 27 4 25.66 4 24V8Z"
    fill="url(#finder-gradient)"
  />
  <defs>
    <linearGradient id="finder-gradient" x1="16" y1="5" x2="16" y2="27" gradientUnits="userSpaceOnUse">
      <stop stop-color="#54C7FC"/>
      <stop offset="1" stop-color="#1E96FC"/>
    </linearGradient>
  </defs>
</svg>
```

```svelte
<!-- src/assets/icons/IconTrash.svelte -->
<svg
  width="32"
  height="32"
  viewBox="0 0 32 32"
  fill="currentColor"
  xmlns="http://www.w3.org/2000/svg"
  {...$$restProps}
>
  <!-- SF Symbols "trash" -->
  <path d="M11 4H21V6H11V4Z" />
  <path fill-rule="evenodd" clip-rule="evenodd" d="M6 7H26V9H24V26C24 27.1 23.1 28 22 28H10C8.9 28 8 27.1 8 26V9H6V7ZM10 9V26H22V9H10Z"/>
  <path d="M13 12H15V23H13V12Z"/>
  <path d="M17 12H19V23H17V12Z"/>
</svg>
```

**方案B: Iconify (备选 - 如果已用)**

```bash
npm install @iconify/svelte @iconify-json/material-symbols
```

```svelte
<script>
  import Icon from "@iconify/svelte";
</script>

<Icon icon="material-symbols:grid-view-rounded" width="32" />
```

#### 实施步骤

1. **创建SVG图标组件** (1小时)
   ```bash
   cd crates/amos-tauri/frontend-ts
   mkdir -p src/assets/icons
   # 创建3个SVG组件文件
   ```

2. **修改 DockTileButton 支持SVG** (30分钟)
   
   ```typescript
   // DockTileButton.svelte - BEFORE
   let {
     glyph,  // string
     ...
   }
   
   // DockTileButton.svelte - AFTER  
   import type { ComponentType } from "svelte";
   
   let {
     glyph,              // string (向后兼容emoji)
     icon,               // ComponentType (SVG组件)
     iconProps = {},     // SVG props
     ...
   }: {
     glyph?: string;
     icon?: ComponentType;
     iconProps?: Record<string, any>;
     ...
   }
   ```
   
   ```svelte
   <!-- DockTileButton.svelte 渲染部分 -->
   <button ...>
     {#if icon}
       <svelte:component this={icon} {...iconProps} />
     {:else if glyph}
       {glyph}
     {/if}
   </button>
   ```

3. **更新3个Dock系统项** (30分钟)
   
   ```svelte
   <!-- DockLaunchpadItem.svelte -->
   <script lang="ts">
     import IconLaunchpad from "../../assets/icons/IconLaunchpad.svelte";
     // ... 其他imports
   </script>
   
   <DockTileButton
     label={t("desktop.launchpad")}
     testId="dock-launchpad"
     icon={IconLaunchpad}
     iconProps={{ class: "text-white" }}
     shortcut={api?.overlayShortcut("launchpad") ?? null}
     onclick={() => api?.openLaunchpad()}
   />
   ```
   
   ```svelte
   <!-- DockFinderItem.svelte -->
   <script lang="ts">
     import IconFinder from "../../assets/icons/IconFinder.svelte";
     // ...
   </script>
   
   <DockTileButton
     label={t("desktop.finder")}
     testId="dock-finder"
     icon={IconFinder}
     onclick={openFinder}
   />
   ```
   
   ```svelte
   <!-- DockTrashItem.svelte -->
   <script lang="ts">
     import IconTrash from "../../assets/icons/IconTrash.svelte";
     // ...
   </script>
   
   <DockTileButton
     label={t("desktop.trashUnavailable")}
     testId="dock-trash"
     icon={IconTrash}
     iconProps={{ class: "opacity-40" }}
     onclick={() => }
     disabled={true}
   />
   ```

4. **验证与测试** (1小时)
   ```bash
   npm run check          # 类型检查
   npm run test          # 运行测试
   npm run dev           # 视觉验证
   ```

---

### 2. 玻璃效果参数微调 (30分钟)

#### 当前参数
```typescript
// shellChrome.ts:189
export const GLASS_DOCK_STYLE =
  "background: rgba(255,255,255,0.12); " +
  "backdrop-filter: blur(64px) saturate(180%); " +
  "-webkit-backdrop-filter: blur(64px) saturate(180%);";
```

#### macOS实测参数
- **Blur**: 40-50px (不是64px，过强会显得模糊)
- **Background (Light)**: rgba(255,255,255,0.08)
- **Background (Dark)**: rgba(30,30,30,0.75)
- **Border**: rgba(255,255,255,0.18)

#### 修改方案

```typescript
// shellChrome.ts

/** Dock 玻璃效果 (macOS Big Sur+ 实测参数) */
export const GLASS_DOCK_STYLE =
  "background: rgba(255,255,255,0.08); " +
  "backdrop-filter: blur(50px) saturate(180%); " +
  "-webkit-backdrop-filter: blur(50px) saturate(180%);";

/** Dock 边框 (16px 圆角顶部) */
export const GLASS_BORDER_DOCK =
  "border-top: 1px solid rgba(255,255,255,0.18); " +
  "border-left: 1px solid rgba(255,255,255,0.18); " +
  "border-right: 1px solid rgba(255,255,255,0.18); " +
  "border-radius: 16px 16px 0 0;";
```

#### Dark模式支持 (可选)

如果已有dark模式切换:

```typescript
// shellChrome.ts
import { browser } from "$app/environment";

function isDarkMode(): boolean {
  if (!browser) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export const GLASS_DOCK_STYLE = isDarkMode()
  ? "background: rgba(30,30,30,0.75); backdrop-filter: blur(50px) saturate(180%); -webkit-backdrop-filter: blur(50px) saturate(180%);"
  : "background: rgba(255,255,255,0.08); backdrop-filter: blur(50px) saturate(180%); -webkit-backdrop-filter: blur(50px) saturate(180%);";
```

或使用CSS变量:

```css
/* index.css */
:root {
  --dock-bg: rgba(255,255,255,0.08);
  --dock-border: rgba(255,255,255,0.18);
}

@media (prefers-color-scheme: dark) {
  :root {
    --dock-bg: rgba(30,30,30,0.75);
    --dock-border: rgba(255,255,255,0.12);
  }
}
```

```typescript
// shellChrome.ts
export const GLASS_DOCK_STYLE =
  "background: var(--dock-bg); " +
  "backdrop-filter: blur(50px) saturate(180%); " +
  "-webkit-backdrop-filter: blur(50px) saturate(180%);";
```

---

### 3. 运行指示点尺寸优化 (15分钟)

#### 当前实现
```typescript
// shellChrome.ts:99
export const DOCK_RUNNING_DOT = 
  "mt-1 h-1 w-1 rounded-full bg-white shadow-sm";
// Tailwind h-1 = 0.25rem = 4px
```

#### macOS标准
- **直径**: 5px (不是4px)
- **颜色**: #FFFFFF
- **阴影**: 0 1px 2px rgba(0,0,0,0.3)
- **位置**: 距图标底部 4px

#### 修改方案

```typescript
// shellChrome.ts

/** Dock 运行指示点 (macOS 标准 5px) */
export const DOCK_RUNNING_DOT =
  "mt-1 h-[5px] w-[5px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.3)]";

/** Dock 运行指示点占位 (保持布局稳定) */
export const DOCK_RUNNING_DOT_SLOT = "mt-1 h-[5px] w-[5px]";
```

---

## 🧪 测试清单

### 单元测试
- [ ] DockTileButton 支持 `icon` prop
- [ ] DockTileButton 向后兼容 `glyph` prop
- [ ] 3个系统项正确渲染SVG
- [ ] 玻璃效果CSS有效

### 集成测试
```bash
cd crates/amos-tauri/frontend-ts

# 运行现有Dock测试
bunx vitest run svelte-tests/dock-widgets.svelte.test.ts
bunx vitest run svelte-tests/home-dock.svelte.test.ts
bunx vitest run svelte-tests/dock-context-menu.svelte.test.ts

# 类型检查
npm run check
```

### 视觉验证
- [ ] 启动台图标: 3x3网格清晰
- [ ] Finder图标: 蓝色渐变文件夹
- [ ] 废纸篓图标: 灰色(disabled)
- [ ] 运行指示点: 5px白点，柔和阴影
- [ ] 玻璃效果: 50px blur, 轻微透明
- [ ] Dark模式切换正常 (如果支持)

### 浏览器兼容
- [ ] Chrome/Edge (Blink)
- [ ] Safari (WebKit)
- [ ] Firefox (Gecko)

---

## 📦 交付清单

### 新文件
```
src/assets/icons/
├── IconLaunchpad.svelte    # 启动台 (3x3网格)
├── IconFinder.svelte       # Finder (蓝色文件夹)
└── IconTrash.svelte        # 废纸篓
```

### 修改文件
```
src/lib/shellChrome.ts              # 玻璃效果参数
src/svelte/modules/DockTileButton.svelte  # 支持SVG icon
src/svelte/modules/DockLaunchpadItem.svelte
src/svelte/modules/DockFinderItem.svelte
src/svelte/modules/DockTrashItem.svelte
```

### 文档更新
```
DOCK_MACOS_ALIGNMENT_AUDIT.md       # 更新对齐度到96%
CHANGELOG.md                        # 记录P1改进
```

---

## ⏱️ 时间估算

| 任务 | 预计 | 实际 |
|-----|------|------|
| SVG图标设计与实现 | 1h | |
| DockTileButton重构 | 0.5h | |
| 3个系统项更新 | 0.5h | |
| 玻璃效果调参 | 0.5h | |
| 运行点优化 | 0.25h | |
| 测试与验证 | 1h | |
| **总计** | **3.75h** | |

---

## 🚀 执行命令速查

```bash
# 准备
cd /Users/arksong/AmOS/crates/amos-tauri/frontend-ts
mkdir -p src/assets/icons

# 创建图标 (手动或从设计稿导出)
# touch src/assets/icons/Icon{Launchpad,Finder,Trash}.svelte

# 验证
npm run check
npm run test
npm run dev

# 构建
npm run build

# 提交
git add .
git commit -m "feat(dock): P1 visual alignment - SVG icons + glass tuning"
```

---

## 🎯 成功标准

### 量化指标
- ✅ TypeScript 0错误
- ✅ 测试通过率 100%
- ✅ 构建成功
- ✅ macOS对齐度 ≥ 96%

### 定性指标
- ✅ 图标渲染一致 (跨OS/浏览器)
- ✅ 玻璃效果接近macOS Big Sur+
- ✅ 运行点尺寸符合HIG
- ✅ 无性能回归 (FPS ≥ 60)

---

## 📚 参考资料

### macOS HIG
- [Dock - Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/dock)
- [SF Symbols - Apple Design Resources](https://developer.apple.com/sf-symbols/)

### 代码示例
- [Svelte SVG Components](https://svelte.dev/examples/svg-components)
- [Iconify for Svelte](https://iconify.design/docs/icon-components/svelte/)

### 测试
- [Vitest Svelte Testing](https://vitest.dev/guide/ui.html)
- [@testing-library/svelte](https://testing-library.com/docs/svelte-testing-library/intro/)

---

**准备就绪后回复 "开始P1实施" 启动改进流程。**
