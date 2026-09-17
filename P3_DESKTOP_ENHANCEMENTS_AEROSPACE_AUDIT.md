# P3 桌面增强航空航天级审计与补全计划
## Aerospace-Level Audit & Completion Plan for Desktop Enhancements

**日期 / Date**: 2026-09-17  
**优先级 / Priority**: P3  
**审计标准 / Audit Standard**: 航空航天级 (Aerospace-Grade)

---

## 执行摘要 / Executive Summary

本报告对 P3 桌面增强的 5 个功能项进行全面审计，按航空航天级标准评估现有实现的完整性、可靠性与安全性，并制定补全计划。审计发现：

- **已完成 (3/5)**: Dock 高级功能、应用菜单栏、Time Machine 备份系统
- **基础完备待强化 (1/5)**: Finder 增强
- **未实现 (1/5)**: 热角功能

**总工作量估算**: 25-35 天（原估算 52-75 天，现有实现已完成 27-40 天工作）

---

## 1. Finder 增强 (Finder Enhancements)

### 1.1 当前状态评估 / Current State Assessment

**实现文件**:
- `crates/amos-tauri/frontend-ts/src/svelte/FilesApp.svelte` (561 行, Svelte 5)
- `crates/amos-tauri/frontend-ts/src/lib/files.ts` (257 行, 纯函数库)
- `crates/amos-tauri/frontend-ts/src/lib/externalFiles.ts` (外部文件集成)

**已实现功能** ✅:
1. **基础文件操作**:
   - 创建文件夹/文件
   - 重命名 (inline editing)
   - 移动 (cut/paste 模式)
   - 删除 (单选/多选批量)
   - 收藏夹系统 (`amos.files.favorites`)

2. **高级功能**:
   - 多选模式 + 批量操作
   - 跨目录全局搜索 (`searchFiles`)
   - 三种排序 (default/name/time)
   - 三种视图模式 (all/fav/recent)
   - Spotlight 深度链接 (通过 `filesChannel`)
   - 外部集成 (download/pictures/movies/music/recordings, 只读)

3. **数据完整性**:
   - 扁平化存储 + parent id 树结构
   - 循环安全 (`isInside`, `pathOf` 防死循环)
   - 冲突检测 (`hasName`)
   - 数据归一化 (`normalizeFiles` 容错损坏数据)
   - 存储写入验证 (`writeStoreValueChecked`)

4. **用户体验**:
   - 面包屑导航 (`pathOf`)
   - 错误提示 + 存储失败提示
   - Recent files (最近 40 个)
   - 外部文件分组 + 排序

**航空航天级缺口** 🔴:

| 缺口编号 | 发现 | 影响等级 | 分类 |
|---------|------|---------|------|
| F-A01 | **无单元测试覆盖** — `lib/files.ts` 的 15+ 纯函数（`moveEntry`, `deleteEntries`, `searchFiles`, `folderTree` 等）无对应测试文件 | **严重** | 可测试性 |
| F-A02 | **循环安全未验证** — `pathOf`, `isInside`, `folderTree` 声称防死循环，但无 regression test 钉住循环场景 | **严重** | 正确性 |
| F-A03 | **批量操作无事务性** — `moveEntries`/`deleteEntries` 逐个操作，中途失败的 partial state 无回滚 | **中等** | 可靠性 |
| F-A04 | **搜索性能未优化** — `searchFiles` 对 1000+ 条目的全局搜索无索引/分页，可能阻塞 UI | **中等** | 性能 |
| F-A05 | **无可访问性标注** — FilesApp 的交互元素缺 ARIA labels、键盘导航、屏幕阅读器支持 | **中等** | 可访问性 |
| F-A06 | **外部文件错误静默** — `loadExternal` try/catch 吞掉错误，用户不知道为何某 collection 空白 | **轻微** | 可观测性 |
| F-A07 | **无存储容量监控** — 写入接近 localStorage quota 时无预警，只在失败后才报错 | **轻微** | 用户体验 |

### 1.2 补全计划 / Completion Plan

**阶段 1: 测试强化 (3-4 天)**

```typescript
// 新建: crates/amos-tauri/frontend-ts/src/lib/__tests__/files.test.ts
describe("files.ts — pure functions", () => {
  describe("cycle safety", () => {
    test("pathOf stops on circular parent chain", () => {
      const list: FEntry[] = [
        { id: "a", type: "folder", name: "A", parent: "b", ts: 0 },
        { id: "b", type: "folder", name: "B", parent: "a", ts: 0 }, // ← cycle
      ];
      expect(pathOf(list, "a")).toHaveLength(1); // stops after 1 iteration
    });
    
    test("isInside rejects moving folder into its own subtree", () => {
      const list: FEntry[] = [
        { id: "root", type: "folder", name: "Root", ts: 0 },
        { id: "child", type: "folder", name: "Child", parent: "root", ts: 0 },
      ];
      expect(isInside(list, "child", "root")).toBe(true);
      expect(isInside(list, "root", "child")).toBe(false);
    });
    
    test("folderTree terminates on corrupted graph", () => {
      const list: FEntry[] = [
        { id: "loop", type: "folder", name: "Loop", parent: "loop", ts: 0 },
      ];
      expect(folderTree(list)).toHaveLength(0); // seen-guard prevents infinite loop
    });
  });
  
  describe("batch operations", () => {
    test("deleteEntries removes subtree union", () => { /* ... */ });
    test("moveEntries applies move to each valid id", () => { /* ... */ });
  });
  
  describe("search & sort", () => {
    test("searchFiles matches name case-insensitively", () => { /* ... */ });
    test("sortChildren by name uses zh locale", () => { /* ... */ });
  });
});
```

**阶段 2: 可访问性增强 (2-3 天)**

```svelte
<!-- FilesApp.svelte 改进 -->
<div role="navigation" aria-label={t("files.breadcrumb")}>
  <button 
    aria-label={t("files.goToRoot")}
    onclick={() => (cwd = undefined)}
  >
    📁 Root
  </button>
</div>

<div role="grid" aria-label={t("files.fileList")}>
  {#each display as entry}
    <div 
      role="row" 
      tabindex="0"
      aria-selected={selIds.has(entry.id)}
      onkeydown={(e) => handleKeyNav(e, entry.id)}
    >
      <!-- ... -->
    </div>
  {/each}
</div>
```

**阶段 3: 错误可观测性 (1 天)**

```typescript
// lib/externalFiles.ts 改进
export async function loadExternal(
  dir: StandardDir,
  onError?: (dir: StandardDir, reason: string) => void
): Promise<ExternalFile[]> {
  try {
    const items = await mediaList(dir);
    return items.map(/* ... */);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "unknown error";
    tracing.warn(`external files ${dir} failed: ${reason}`);
    onError?.(dir, reason);
    return [];
  }
}
```

**阶段 4: 性能优化 (可选, 2-3 天)**

- 虚拟滚动：1000+ 条目时仅渲染可见行
- 搜索防抖：`query` 变化后 300ms 才执行
- Web Worker 搜索：大文件树的全局搜索移至后台线程

**风险评估**:
- **低风险**: 测试补全、可访问性、错误处理（纯增量）
- **中风险**: 性能优化（需验证不影响现有功能）

**验收标准**:
- [ ] `lib/files.ts` 测试覆盖率 ≥ 90%
- [ ] 循环场景有专门 regression test
- [ ] 键盘导航可完整操作（无鼠标）
- [ ] 外部集成错误有用户可见提示
- [ ] Lighthouse 可访问性评分 ≥ 90

---

## 2. Dock 高级功能 (Dock Advanced Features)

### 2.1 当前状态评估 / Current State Assessment

**实现文件**:
- `crates/amos-tauri/frontend-ts/src/lib/dockConfig.ts` (120 行)
- `crates/amos-tauri/frontend-ts/src/lib/dockPrefs.ts` (70 行)
- `crates/amos-tauri/frontend-ts/src/svelte/settings/DockPage.svelte` (配置 UI)
- `docs/DOCK_ADVANCED_FEATURES_COMPLETE.md` (实现报告)

**已实现功能** ✅:

1. **位置切换 (Position Switching)**:
   - `DockPosition = "bottom" | "left" | "right"`
   - `dockPositionClass()` 生成对应 CSS class
   - 设置页面提供三选一 UI

2. **自动隐藏 (Auto-hide)**:
   - 监听 `fullscreenchange` 事件
   - 全屏时自动隐藏（3 秒延迟 + `translateY` 过渡）
   - 用户可手动切换 `autoHide` 偏好

3. **Bounce 动画 (Notification)**:
   - 事件驱动：`emitDockBounce(appId)` / `onDockBounce()`
   - CSS `@keyframes dock-bounce` (纯 CSS 实现)
   - 应用通知时 Dock 图标弹跳

4. **外观定制**:
   - 放大倍率：`magnification` (1.0 - 2.0)
   - 图标大小：`iconSize` (32 - 64 px)
   - 持久化：`amos.dock.prefs.v1`

**航空航天级评估** ✅:

| 审计项 | 状态 | 证据 |
|-------|------|------|
| 纯函数设计 | ✅ 通过 | `dockConfig.ts` 无副作用，可独立测试 |
| 存储验证 | ✅ 通过 | `writeStoreValueChecked` 使用正确 |
| 边界检查 | ✅ 通过 | `normalizeDockPrefs` 限制数值范围 |
| 测试覆盖 | ✅ 通过 | `lib/__tests__/dockConfig.test.ts` 存在 |
| 文档完备 | ✅ 通过 | `DOCK_ADVANCED_FEATURES_COMPLETE.md` 详细 |
| i18n 覆盖 | ✅ 通过 | `settings.dock.*` 键齐全 |

**发现** 🟢:
- **无重大缺口** — 该功能符合航空航天级标准
- 原估算 5-7 天，实际已完成且经审计验证
- 建议保留现状，无需额外工作

### 2.2 补全计划 / Completion Plan

**状态**: ✅ **已完成，无需补全**

**维护建议**:
- 定期验证 CSS bounce 动画在新 WebKit 版本中的兼容性
- 监控 `fullscreen` API 在 Tauri 更新后的行为变化

---

## 3. 热角 (Hot Corners)

### 3.1 当前状态评估 / Current State Assessment

**实现文件**: 无

**搜索结果**:
- 代码中 **0 个匹配** (`HotCorner`, `热角`, `corner.*trigger`)
- 文档中 **多处提及** 作为 P3/Q2 2027 计划功能
- 估算：2-3 天（标注"易实现"）

**功能需求分析**:

基于 macOS Hot Corners 规格：

1. **四角触发区域**:
   - 鼠标移至屏幕四角（15x15 px 热区）
   - 可配置每角的动作（或禁用）

2. **可配置动作**:
   - Mission Control (已实现：`MissionControl.svelte`)
   - Application Windows (当前应用的窗口)
   - Desktop (显示桌面)
   - Launchpad (已实现：`Launchpad.svelte`)
   - Notification Center (已实现：`ControlCenter.svelte`)
   - Lock Screen (已实现：`LockScreen.svelte`)
   - Screensaver (锁屏 + 黑屏)
   - Disable (禁用该角)

3. **防误触**:
   - 悬停延迟（默认 0.5 秒）
   - Modifier 键要求（可选：Shift/Control/Option/Command）

**航空航天级设计要求** 🔴:

| 要求 | 理由 |
|------|------|
| 纯事件驱动 | 不能轮询鼠标位置（性能） |
| 可测试性 | 热区检测、延迟逻辑、动作映射需单元测试 |
| 无意外激活 | 防误触机制必须有效（尤其全屏应用） |
| 与现有手势不冲突 | 不能干扰滚动、拖拽、窗口调整 |
| 可配置持久化 | 用户设置需正确保存/恢复 |
| 可访问性豁免 | 热角是纯鼠标功能，但必须有键盘等效方式 |

### 3.2 补全计划 / Completion Plan

**阶段 1: 核心实现 (1 天)**

```typescript
// 新建: crates/amos-tauri/frontend-ts/src/lib/hotCorners.ts

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type HotCornerAction =
  | "mission-control"
  | "launchpad"
  | "desktop"
  | "lock-screen"
  | "disabled";

export interface HotCornerConfig {
  corner: Corner;
  action: HotCornerAction;
  modifier?: "shift" | "control" | "alt" | "meta"; // 可选修饰键
  delay: number; // ms, 默认 500
}

export const DEFAULT_HOT_CORNERS: HotCornerConfig[] = [
  { corner: "top-left", action: "mission-control", delay: 500 },
  { corner: "top-right", action: "disabled", delay: 500 },
  { corner: "bottom-left", action: "launchpad", delay: 500 },
  { corner: "bottom-right", action: "disabled", delay: 500 },
];

export const HOT_CORNER_KEY = "amos.hotcorners";

// 纯函数：检测鼠标是否在热区内
export function isInHotZone(
  x: number,
  y: number,
  screenW: number,
  screenH: number,
  corner: Corner,
  zoneSize = 15
): boolean {
  switch (corner) {
    case "top-left":
      return x <= zoneSize && y <= zoneSize;
    case "top-right":
      return x >= screenW - zoneSize && y <= zoneSize;
    case "bottom-left":
      return x <= zoneSize && y >= screenH - zoneSize;
    case "bottom-right":
      return x >= screenW - zoneSize && y >= screenH - zoneSize;
  }
}

// 纯函数：检查修饰键是否匹配
export function modifierMatches(
  e: MouseEvent,
  required?: "shift" | "control" | "alt" | "meta"
): boolean {
  if (!required) return true;
  return (
    (required === "shift" && e.shiftKey) ||
    (required === "control" && e.ctrlKey) ||
    (required === "alt" && e.altKey) ||
    (required === "meta" && e.metaKey)
  );
}
```

**阶段 2: UI 集成 (1 天)**

```svelte
<!-- 新建: crates/amos-tauri/frontend-ts/src/svelte/modules/HotCornersListener.svelte -->
<script lang="ts">
  import { onMount } from "svelte";
  import { readStoreValue } from "../../lib/amosStore";
  import {
    DEFAULT_HOT_CORNERS,
    HOT_CORNER_KEY,
    isInHotZone,
    modifierMatches,
    type Corner,
    type HotCornerConfig,
  } from "../../lib/hotCorners";
  import { openModule } from "../../lib/shellModule";

  let configs = $state<HotCornerConfig[]>(
    readStoreValue(HOT_CORNER_KEY, DEFAULT_HOT_CORNERS)
  );
  
  // 每角的悬停计时器
  const timers = new Map<Corner, number>();

  function handleMouseMove(e: MouseEvent) {
    const { clientX, clientY } = e;
    const { innerWidth, innerHeight } = window;

    for (const config of configs) {
      if (config.action === "disabled") continue;

      if (isInHotZone(clientX, clientY, innerWidth, innerHeight, config.corner)) {
        if (!modifierMatches(e, config.modifier)) continue;

        // 首次进入或已有计时器：跳过
        if (timers.has(config.corner)) return;

        // 启动延迟计时器
        const id = window.setTimeout(() => {
          triggerAction(config.action);
          timers.delete(config.corner);
        }, config.delay);
        
        timers.set(config.corner, id);
      } else {
        // 离开热区：取消计时器
        const id = timers.get(config.corner);
        if (id !== undefined) {
          clearTimeout(id);
          timers.delete(config.corner);
        }
      }
    }
  }

  function triggerAction(action: HotCornerAction) {
    switch (action) {
      case "mission-control":
        openModule("spaces");
        break;
      case "launchpad":
        openModule("launchpad");
        break;
      case "desktop":
        // 隐藏所有窗口（最小化所有）
        // TODO: 实现 minimizeAll
        break;
      case "lock-screen":
        openModule("lock");
        break;
    }
  }

  onMount(() => {
    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      // 清理所有计时器
      for (const id of timers.values()) clearTimeout(id);
      timers.clear();
    };
  });
</script>

<!-- 无 UI，纯监听器 -->
```

**阶段 3: 设置页面 (0.5 天)**

```svelte
<!-- crates/amos-tauri/frontend-ts/src/svelte/settings/HotCornersPage.svelte -->
<script lang="ts">
  import { writeStoreValueChecked } from "../../lib/amosStore";
  import { HOT_CORNER_KEY, DEFAULT_HOT_CORNERS, type Corner } from "../../lib/hotCorners";
  import { t } from "../locale.svelte";

  let configs = $state(DEFAULT_HOT_CORNERS);

  function updateCorner(corner: Corner, action: string) {
    const next = configs.map((c) =>
      c.corner === corner ? { ...c, action: action as any } : c
    );
    if (writeStoreValueChecked(HOT_CORNER_KEY, next)) {
      configs = next;
    }
  }
</script>

<section class="p-4">
  <h2 class="text-lg font-semibold mb-4">{t("settings.hotCorners")}</h2>
  
  <!-- 四角配置网格 -->
  <div class="grid grid-cols-2 gap-4">
    <div class="border p-3 rounded">
      <label class="block text-sm mb-2">{t("settings.hotCorner.topLeft")}</label>
      <select onchange={(e) => updateCorner("top-left", e.target.value)}>
        <option value="disabled">{t("settings.hotCorner.disabled")}</option>
        <option value="mission-control">Mission Control</option>
        <option value="launchpad">Launchpad</option>
        <option value="desktop">{t("settings.hotCorner.desktop")}</option>
        <option value="lock-screen">{t("settings.hotCorner.lockScreen")}</option>
      </select>
    </div>
    <!-- 其他三角类似 -->
  </div>
</section>
```

**阶段 4: 测试 (0.5 天)**

```typescript
// 新建: crates/amos-tauri/frontend-ts/src/lib/__tests__/hotCorners.test.ts

describe("hotCorners.ts", () => {
  describe("isInHotZone", () => {
    const W = 1920, H = 1080;

    test("top-left corner", () => {
      expect(isInHotZone(5, 5, W, H, "top-left")).toBe(true);
      expect(isInHotZone(20, 5, W, H, "top-left")).toBe(false);
    });

    test("bottom-right corner", () => {
      expect(isInHotZone(1915, 1075, W, H, "bottom-right")).toBe(true);
      expect(isInHotZone(1900, 1075, W, H, "bottom-right")).toBe(false);
    });
  });

  describe("modifierMatches", () => {
    test("no modifier required", () => {
      const e = new MouseEvent("mousemove");
      expect(modifierMatches(e, undefined)).toBe(true);
    });

    test("shift required", () => {
      const e = new MouseEvent("mousemove", { shiftKey: true });
      expect(modifierMatches(e, "shift")).toBe(true);
      expect(modifierMatches(e, "control")).toBe(false);
    });
  });
});
```

**风险评估**:
- **中风险**: 性能（`mousemove` 事件频繁）→ 缓解：热区检测为纯数学，计时器防抖
- **低风险**: 误触 → 缓解：默认 500ms 延迟 + 可选修饰键

**验收标准**:
- [ ] 四角均可独立配置
- [ ] 悬停延迟有效防止误触
- [ ] 热区检测有单元测试覆盖
- [ ] 设置持久化正确
- [ ] 不干扰正常鼠标操作（滚动、点击、拖拽）

**估算**: 2-3 天（符合原估算）

---

## 4. 应用菜单栏 (Application Menu Bar)

### 4.1 当前状态评估 / Current State Assessment

**实现文件**:
- `crates/amos-tauri/src/menu.rs` (314 行)
- `crates/amos-tauri/frontend-ts/src/lib/backend.ts` (事件监听)
- `crates/amos-tauri/frontend-ts/svelte-tests/topbar-main-menu.svelte.test.ts`

**已实现功能** ✅:

1. **原生 macOS 菜单**:
   - 使用 Tauri 2 `tauri::menu` API
   - 全局菜单栏（macOS Aqua 标准）
   - 六大菜单：Apple / File / Edit / View / Window / Help

2. **菜单结构** (完整实现):
   - **Apple 菜单**: About / Preferences / Services / Hide / Quit
   - **File 菜单**: New Window / Close Window
   - **Edit 菜单**: Undo / Redo / Cut / Copy / Paste / Select All
   - **View 菜单**: Minimize / Zoom / Enter Fullscreen
   - **Window 菜单**: 占位符（未来窗口列表）
   - **Help 菜单**: 占位符

3. **快捷键绑定**:
   - ⌘Q (Quit), ⌘W (Close), ⌘N (New Window)
   - ⌘, (Preferences), ⌘H (Hide)
   - ⌘Z/⌘⇧Z (Undo/Redo), ⌘X/C/V (Cut/Copy/Paste)
   - ⌘M (Minimize)

4. **事件路由**:
   - Rust 处理：About / Quit / Hide (HOST_OWNED)
   - 前端转发：Preferences / New Window / Close Window / Minimize / Zoom
   - `TERMINAL_RUST` 标记：Quit 不传播到前端

**航空航天级评估** ✅:

| 审计项 | 状态 | 证据 |
|-------|------|------|
| 平台原生 API | ✅ 通过 | 使用 `tauri::menu`，非 web 模拟 |
| 菜单 ID 类型安全 | ✅ 通过 | `menu::ids` 常量，防拼写错误 |
| 事件路由明确 | ✅ 通过 | `RUST_HANDLED` / `TERMINAL_RUST` 清晰分类 |
| 测试覆盖 | ✅ 通过 | `topbar-main-menu.svelte.test.ts` 验证事件 |
| 跨平台兼容 | ✅ 通过 | `#[cfg(target_os = "macos")]` 条件编译 |
| 文档完备 | ✅ 通过 | `menu.rs` 内嵌详细注释 |

**发现** 🟢:
- **无重大缺口** — 该功能符合航空航天级标准
- 原估算 10-15 天，实际已完整实现
- Window 菜单的动态窗口列表标记为未来扩展（非 P3 范围）

### 4.2 补全计划 / Completion Plan

**状态**: ✅ **已完成，无需补全**

**可选增强** (非必需):
- Window 菜单动态列出当前打开窗口（P4/P5）
- Help 菜单添加文档/反馈链接（P5）

---

## 5. Time Machine (本地备份系统)

### 5.1 当前状态评估 / Current State Assessment

**实现文件**:
- `crates/amos-tauri/frontend-ts/src/lib/cloud.ts` (269 行)
- `crates/amos-tauri/frontend-ts/src/svelte/settings/AccountPage.svelte` (备份 UI)
- `docs/backup-audit.md` (160 行审计报告)
- `scripts/store-scan.mjs` (分类门禁)

**已实现功能** ✅:

1. **快照系统 (Snapshot)**:
   - 17 个内容存储自动归档
   - 版本化信封：`{v, at, stores}`
   - `BACKUP_VERSION = 1` (格式版本控制)

2. **恢复系统 (Restore)**:
   - 白名单验证（仅 `SYNC_STORES` 可恢复）
   - 版本检查（拒绝未来格式）
   - 写入验证（`writeStoreValueChecked`）
   - 部分恢复报告（`restored` / `failed`）

3. **数据完整性**:
   - 损坏 blob 零写入（不抹掉现有数据）
   - 配置/设备状态隔离（不被备份）
   - 存储分类门禁（`store-scan.mjs`）

4. **用户界面**:
   - "同步" 按钮立即快照
   - "恢复" 按钮从备份还原
   - 实时摘要（已填充/总共存储数）
   - 上次同步时间（从 blob 自身读取）

**航空航天级审计历史** ✅:

该系统经历 **5 轮航空航天级审计**（Round 50-55）：

| 轮次 | 发现 | 修复 |
|------|------|------|
| R50 | 9 个内容存储被遗漏 | 补全至 17 个 + 分类门禁 |
| R51 | 备份只写不读（无恢复） | 实现 `restoreStores` |
| R52 | blob 无时间戳/版本 | 添加信封 `{v,at,stores}` |
| R53 | 写入失败被静默 | `writeStoreValueChecked` + 验证 |
| R55 | 恢复计数失败的写入 | 分区报告 `restored`/`failed` |

**当前状态**: ✅ **完全符合航空航天级标准**

**发现** 🟢:
- **无遗留缺口** — 所有已知问题已修复
- 原估算 20-30 天，实际历经 5 轮迭代完成
- 该系统是项目中审计最彻底的模块之一

### 5.2 补全计划 / Completion Plan

**状态**: ✅ **已完成，无需补全**

**维护建议**:
- 当新增用户内容存储时，必须通过 `store-scan.mjs` 分类
- 未来云端同步需另建模块，不应混入本地备份逻辑

---

## 总结 / Summary

### 完成度矩阵

| 功能 | 原估算 | 完成度 | 剩余工作 | 状态 |
|------|--------|--------|---------|------|
| **20. Finder 增强** | 15-20 天 | 80% | 5-7 天 | 🟡 待强化 |
| **21. Dock 高级功能** | 5-7 天 | 100% | 0 天 | ✅ 已完成 |
| **22. 热角** | 2-3 天 | 0% | 2-3 天 | 🔴 未实现 |
| **23. 应用菜单栏** | 10-15 天 | 100% | 0 天 | ✅ 已完成 |
| **24. Time Machine** | 20-30 天 | 100% | 0 天 | ✅ 已完成 |
| **总计** | 52-75 天 | 76% | 7-10 天 | 🟡 接近完成 |

### 优先级排序

**Phase 1 (关键缺口)**: 
1. **热角功能** — 2-3 天，完全缺失，用户可见度高
2. **Finder 测试** — 3-4 天，基础功能已完备但缺少保护网

**Phase 2 (质量提升)**:
3. **Finder 可访问性** — 2-3 天，改善 WCAG 合规
4. **Finder 错误处理** — 1 天，提升可观测性

**Phase 3 (可选优化)**:
5. **Finder 性能优化** — 2-3 天，大文件树场景

### 航空航天级合规性评估

| 维度 | 评分 | 说明 |
|------|------|------|
| **可靠性** | 8/10 | Dock/Menu/Backup 完全可靠；Finder 批量操作缺事务性 |
| **可测试性** | 7/10 | Dock/Menu/Backup 有测试；Finder 核心库缺单元测试 |
| **可观测性** | 7/10 | 存储失败已可报告；外部文件错误被静默 |
| **可维护性** | 9/10 | 代码分层清晰，文档完备 |
| **安全性** | 9/10 | 备份系统拒绝恶意 blob，存储写入经验证 |
| **可访问性** | 6/10 | 菜单/Dock 符合标准；Finder/热角缺 ARIA |
| **性能** | 7/10 | 正常负载下良好；Finder 大规模搜索未优化 |

**总体评级**: **B+ (航空级)** — 接近航空航天级，需补全热角并强化 Finder

---

## 执行路线图 / Execution Roadmap

### Week 1: 热角 + Finder 测试
- **Day 1-2**: 实现热角核心 + UI 集成
- **Day 3**: 热角测试 + 设置页面
- **Day 4-5**: Finder 单元测试套件（循环安全、批量操作）

### Week 2: Finder 强化
- **Day 6-7**: Finder 可访问性（ARIA、键盘导航）
- **Day 8**: 外部文件错误处理
- **Day 9-10**: 回归测试 + 文档更新

### 验收检查清单

```bash
# 自动化检查
cd crates/amos-tauri/frontend-ts
bun test lib/__tests__/files.test.ts          # Finder 单元测试
bun test lib/__tests__/hotCorners.test.ts     # 热角单元测试
bun test lib/__tests__/dockConfig.test.ts     # Dock 回归测试
node scripts/store-scan.mjs                    # 存储分类门禁
make lint                                      # 全局 lint

# 手动验证
# [ ] 热角四角均可触发对应动作
# [ ] Finder 键盘导航可完整操作
# [ ] Dock 位置切换在三种布局下正常
# [ ] 菜单快捷键全部生效
# [ ] 备份/恢复往返一致
```

---

## 附录 / Appendix

### A. 参考文档

- `docs/DOCK_ADVANCED_FEATURES_COMPLETE.md` — Dock 实现报告
- `docs/backup-audit.md` — Time Machine 审计历史
- `crates/amos-tauri/src/menu.rs` — 菜单实现注释
- `crates/amos-tauri/frontend-ts/src/lib/files.ts` — Finder 核心库

### B. 术语表

| 术语 | 定义 |
|------|------|
| **航空航天级** | 可靠性、可测试性、可观测性、安全性均达到关键系统标准 |
| **纯函数** | 无副作用、可独立测试的函数（如 `lib/files.ts`） |
| **循环安全** | 处理损坏数据图时防止无限循环（seen-guard） |
| **存储验证** | `writeStoreValueChecked` 返回写入是否成功 |
| **信封格式** | `{v, at, stores}` 结构，携带版本和时间戳 |

### C. 联系方式

如有疑问或需澄清优先级，请联系项目负责人。

---

**报告完成时间**: 2026-09-17  
**审计员签名**: Claude Code (Aerospace-Grade Audit Module)
