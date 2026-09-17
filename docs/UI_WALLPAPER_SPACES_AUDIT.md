# AmOS UI 界面、壁纸与多桌面审计报告

> 日期：2026-09-16 21:00
> 范围：UI 界面显示、壁纸功能、多桌面显示（Spaces）
> 状态：2/3 功能完整，1 项计划中

---

## 📊 执行摘要

| 功能模块 | 完成度 | 评分 | 状态 |
|---------|--------|------|------|
| **壁纸功能** | 100% | 10/10 | ✅ 完整实现 |
| **UI 界面显示** | 100% | 10/10 | ✅ 完整实现 |
| **多桌面（Spaces）** | 0% | 0/10 | ❌ 未实现（Q1 2027） |
| **综合** | 66.7% | 6.7/10 | ⚠️ 核心完整 |

---

## 一、✅ 壁纸功能 - 完整实现

### 功能清单

✅ **6 种内置壁纸**：auto / dark / light / landscape / dawn / abyss  
✅ **4 种显示模式**：ghost / soft / muted / vivid（控制透明度/模糊/饱和度）  
✅ **自定义壁纸**：支持 URL 和上传（≤2.5MB）  
✅ **锁屏壁纸**：独立的锁屏背景设置  
✅ **安全过滤**：拒绝 javascript:/file: 等危险协议  
✅ **主题适配**：暗黑/明亮主题自动切换  
✅ **照片设为壁纸**：PhotosApp 一键设为壁纸  
✅ **显示/隐藏**：View 菜单控制壁纸显示  

### 核心文件

- `lib/wallpaper.ts` (62 行) - 壁纸解析与安全验证
- `svelte/Backdrop.svelte` (60 行) - 壁纸渲染层
- `svelte/WallpaperCard.svelte` (98 行) - 设置界面
- `svelte/LockWallpaperCard.svelte` - 锁屏壁纸设置

### 使用方式

```typescript
// 设置壁纸
writeStoreValue("amos.settings", { 
  wallpaper: "landscape",  // 或自定义 URL
  background: "soft"       // 显示模式
});

// 读取壁纸
const file = resolveWallpaper(dark, settings.wallpaper);
```

### 测试覆盖

✅ `wallpaper.test.ts` - 16 个测试全过  
✅ 安全过滤测试（拒绝危险协议）  
✅ 主题切换测试  

---

## 二、✅ UI 界面显示 - 完整实现

### 桌面 UI 组件

| 组件 | 文件 | 功能 |
|------|------|------|
| DesktopShell | `DesktopShell.svelte` | 桌面顶层容器 |
| TopBar | `TopBar.svelte` | 28px macOS 顶栏 |
| Dock | `Dock.svelte` | 76px 常驻 Dock |
| DesktopStage | `DesktopStage.svelte` | 壁纸 + 图标网格 |
| Launchpad | `Launchpad.svelte` | 全屏启动台 |
| Spotlight | `SpotlightOverlay.svelte` | ⌘Space 搜索 |
| Mission Control | `MissionControl.svelte` | ⌘Tab 窗口切换 |
| Backdrop | `Backdrop.svelte` | 壁纸背景 |

### 桌面图标功能（DesktopStage）

✅ **单选/多选**：单击选中，⌘-点击添加，Shift-点击范围选择  
✅ **Rubber-band**：拖动空白区域拉框多选  
✅ **拖动移动**：选中的图标可拖动到新位置  
✅ **双击打开**：打开应用（多选时打开所有）  
✅ **右键菜单**：7 个菜单项（新建文件夹/更改壁纸/显示设置/打开选中/清空选择/启动台）  
✅ **键盘导航**：方向键移动焦点，⌘A 全选，Esc 清空  
✅ **选区计数**：显示"N 个已选"提示  

### View 菜单控制（REQ-A275）

```typescript
export interface DesktopView {
  showWallpaper: boolean;    // 显示/隐藏壁纸
  showIcons: boolean;        // 显示/隐藏桌面图标
  showStageWidgets: boolean; // 显示/隐藏舞台挂件
}
```

用户可通过 View 菜单独立控制每个元素的显示。

---

## 三、❌ 多桌面显示（Spaces）- 未实现

### 当前状态

| 功能 | 状态 |
|------|------|
| 虚拟桌面管理 | ❌ 未实现 |
| 桌面切换（Ctrl+← / Ctrl+→） | ❌ 未实现 |
| Mission Control 多桌面视图 | ❌ 未实现 |
| 窗口在桌面间移动 | ❌ 未实现 |

### 已有的相关功能

✅ **多窗口**：真实 OS 窗口（`wm_open`）  
✅ **Mission Control**：窗口切换器（⌘Tab / F3）  
✅ **窗口管理**：`wm_focus` / `wm_hide` / `wm_close`  

**说明**：当前的 Mission Control 只显示所有打开的窗口，不支持多虚拟桌面。

### 计划实现方案

**优先级**：P3（下季度）  
**工作量**：3 周  
**计划时间**：Q1 2027  

#### Phase 1: Rust 后端（1 周）

```rust
// crates/amos-tauri/src/spaces.rs (新文件)
pub struct SpaceManager {
    spaces: Vec<Space>,
    active: usize,
}

pub struct Space {
    id: String,
    name: String,
    windows: Vec<String>,  // 窗口标签
}

#[tauri::command]
pub fn spaces_list() -> Vec<SpaceInfo> { }

#[tauri::command]
pub fn spaces_switch(index: usize) -> Result<()> { }

#[tauri::command]
pub fn spaces_create(name: String) -> Result<String> { }

#[tauri::command]
pub fn spaces_move_window(window: String, space: String) -> Result<()> { }
```

#### Phase 2: 前端桥接（3 天）

```typescript
// lib/spaces.ts (新文件)
export interface Space {
  id: string;
  name: string;
  windows: string[];
}

export async function listSpaces(): Promise<Space[]>
export async function switchSpace(index: number): Promise<void>
export async function createSpace(name: string): Promise<string>
export async function moveWindowToSpace(label: string, spaceId: string): Promise<void>
```

#### Phase 3: UI 组件（4 天）

```svelte
<!-- svelte/SpacesPanel.svelte (新文件) -->
<div class="spaces-panel">
  {#each spaces as space, i}
    <button onclick={() => switchSpace(i)}>
      桌面 {i + 1}
      <div class="space-preview">
        {#each space.windows as win}
          <div class="window-thumb">{win}</div>
        {/each}
      </div>
    </button>
  {/each}
  <button onclick={createSpace}>+ 新建桌面</button>
</div>
```

#### Phase 4: Mission Control 集成（3 天）

更新 `MissionControl.svelte`：
- 上半部分：所有 Spaces（横向排列）
- 下半部分：当前桌面的窗口网格

#### Phase 5: 快捷键（1 天）

- `Ctrl+←` - 上一个桌面
- `Ctrl+→` - 下一个桌面
- `F3` - Mission Control（显示所有桌面 + 窗口）

---

## 四、补全建议

### 4.1 壁纸功能 - 无需补全

✅ 功能已完整，建议保持现状。

**可选增强**（P3，非必需）：
- 壁纸预览缩略图
- 壁纸收藏功能
- 定时切换壁纸
- 动态壁纸（视频）

### 4.2 多桌面功能 - 需要补全

**立即行动**（Q1 2027，3 周）：

1. **Week 1**：Rust 后端 SpaceManager
2. **Week 2**：前端桥接 + SpacesPanel UI
3. **Week 3**：Mission Control 集成 + 测试

**测试清单**：
```typescript
// __tests__/spaces.test.ts (新文件)
describe("Spaces", () => {
  test("创建新桌面");
  test("切换桌面");
  test("移动窗口到另一个桌面");
  test("删除桌面");
  test("快捷键切换");
});
```

---

## 五、文档建议

### 需要创建的文档

1. **用户手册 - 壁纸章节**（1 小时）
   - 如何选择内置壁纸
   - 如何上传自定义壁纸
   - 显示模式说明
   - 锁屏壁纸设置

2. **Spaces 设计文档**（2 小时，Q1 2027）
   - 架构设计
   - API 规范
   - 用户交互流程
   - 测试计划

---

## 六、总结

### 已完成（立即可用）

✅ **壁纸系统**：6 种内置 + 自定义，4 种显示模式，安全可靠  
✅ **桌面界面**：macOS 风格完整实现，4×4 图标网格，完整交互  

### 待补全（Q1 2027）

❌ **多桌面（Spaces）**：虚拟桌面管理，预计 3 周完成  

### 推荐决策

✅ **壁纸和 UI 界面可投入生产使用**  
⏳ **多桌面功能按计划在 Q1 2027 实现**  

---

**审计完成时间**：2026-09-16 21:00  
**综合评分**：6.7/10（核心功能完整）  
**状态**：✅ 可投入使用（多桌面除外）
