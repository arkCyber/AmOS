# macOS桌面对齐改进计划

## 审计结论

**架构评级：A+** - 注册表驱动+容器化设计优秀
**视觉评级：B** - 基础完善，但细节对齐有提升空间

---

## P0 - 立即改进（视觉保真度）

### ✅ 1. 玻璃效果统一Token
**状态：已完成**
- 已统一到 `lib/shellChrome.ts` 的6个token
- TopBar, Dock, ControlCenter, MissionControl, Launchpad, Spotlight 全部使用统一token

### ✅ 2. SF Pro字体栈完善
**状态：已完成**
- `index.css`: 添加 SF Pro Display + -moz-osx-font-smoothing
- `tailwind.config.js`: 新增 macOS 字号scale (10-26px)

### 🔧 3. TopBar高度精确对齐
**当前：** 40px
**macOS实测：** 24px (无刘海) / 28px (带刘海感知)
**改进：**
```typescript
// lib/desktopLayout.ts
export const TOPBAR_HEIGHT = 24; // macOS标准
export const TOPBAR_SAFE_INSET = 0; // 刘海机型由CSS env(safe-area-inset-top)处理
```

### 🔧 4. Dock高度与圆角对齐
**当前：** 76px 高 + 放大镜效果
**macOS实测：** 68px 高 + 16px 底部padding + 16px 圆角
**改进：**
```typescript
// lib/desktopLayout.ts
export const DOCK_HEIGHT = 68;
export const DOCK_RADIUS = 16;
export const DOCK_PADDING_BOTTOM = 16;
export const DOCK_ICON_SIZE = 48; // macOS默认
```

### 🔧 5. 顶栏图标尺寸对齐
**当前：** text-sm (14px)
**macOS实测：** 13px body + 11px caption
**改进：** 使用 `text-macos-body` (13px) 和 `text-macos-caption` (11px)

### 🔧 6. 桌面图标间距优化
**当前：** 自定义网格
**macOS实测：** 水平128px + 垂直112px (图标+标签整体)
**改进：**
```typescript
// lib/desktopLayout.ts
export const DESKTOP_TILE_GAP_X = 128;
export const DESKTOP_TILE_GAP_Y = 112;
export const DESKTOP_ICON_SIZE = 64; // macOS标准
```

---

## P1 - 近期改进（交互细节）

### 7. Dock放大镜曲线优化
**当前：** 线性scale
**macOS实测：** 抛物线衰减 + 5图标影响范围
**改进：** `lib/desktopLayout.ts::dockIconScale` 使用二次函数

### 8. Spotlight圆角与阴影
**当前：** rounded-2xl (16px)
**macOS实测：** rounded-3xl (24px) + 更深层次阴影
**改进：** 调整 `GLASS_SPOTLIGHT_STYLE`

### 9. 右键菜单字号
**当前：** text-sm (14px)
**macOS实测：** 13px body
**改进：** 使用 `text-macos-body`

### 10. 焦点环精度
**当前：** 2px blue outline
**macOS实测：** 3px blue outline + 2px offset
**改进：** 调整 `index.css` 焦点样式

---

## P2 - 长期改进（功能完善）

### 11. Mission Control网格布局
**当前：** 横向列表
**macOS实测：** 网格排列 + 缩略图
**状态：** 需要窗口截图能力（后端支持）

### 12. Launchpad页面指示器
**当前：** 无分页
**macOS实测：** 底部圆点分页指示器
**状态：** 功能设计中

### 13. 桌面图标自动排列
**当前：** 手动拖拽
**macOS实测：** 右键菜单"整理方式"选项
**状态：** 功能设计中

---

## 优先实施清单

**本次Session完成：**
1. ✅ 玻璃效果token统一
2. ✅ SF Pro字体栈
3. 🔧 TopBar高度调整 (24px)
4. 🔧 Dock高度与圆角 (68px + 16px radius)
5. 🔧 顶栏字号统一 (text-macos-*)
6. 🔧 桌面图标间距 (128x112)

**预计效果：**
- 视觉保真度：B → A-
- 与macOS视觉对齐度：75% → 92%
