# Spaces（多桌面）实现计划

> 优先级：P3（下季度）
> 工作量：3 周
> 计划时间：Q1 2027
> 依赖：当前 wm (窗口管理) 系统
>
> **状态（2026-09-17，REQ-A389）**：**账本那一半已经上线** —— `mod spaces;` /
> `mod spaces_commands;` 已声明、`SpaceManager` 已托管（从共享 store 恢复，重启保留）、8 条
> `spaces_*` 命令已注册、面板 `SpacesPanel` 在 shell 注册表里可用。
> **还欠的是窗口那一半**：切桌面只改 `active_index`，没有任何代码把窗口在桌面间搬动 ——
> `active_space_windows` / `is_window_in_active_space` / `space_for_window` 三个 helper 无人调用
> （记在 `docs/rust-unwired-audit.md`），面板文案若暗示“窗口会跟着走”就是不准确的。
> 下面这份计划因此仍然有效，只是它的“第一步”已经落地了。

---

## 一、功能目标

实现 macOS 风格的虚拟桌面（Spaces）系统：

- ✅ 多个独立的虚拟桌面
- ✅ 每个桌面有独立的窗口集合
- ✅ 桌面间快速切换（Ctrl+← / Ctrl+→）
- ✅ Mission Control 显示所有桌面
- ✅ 窗口可在桌面间移动
- ✅ 桌面创建/删除/重命名

---

## 二、架构设计

### 2.1 Rust 后端（crates/amos-tauri/src/spaces.rs）

```rust
use std::sync::{Arc, Mutex};
use tauri::State;
use serde::{Deserialize, Serialize};

/// Space（虚拟桌面）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Space {
    pub id: String,
    pub name: String,
    /// 属于这个桌面的窗口标签列表
    pub windows: Vec<String>,
}

/// SpaceInfo - 序列化给前端的结构
#[derive(Debug, Clone, Serialize)]
pub struct SpaceInfo {
    pub id: String,
    pub name: String,
    pub windows: Vec<String>,
}

/// SpaceManager - Spaces 状态管理器
pub struct SpaceManager {
    spaces: Arc<Mutex<Vec<Space>>>,
    active_index: Arc<Mutex<usize>>,
}

impl SpaceManager {
    pub fn new() -> Self {
        let default_space = Space {
            id: "space-0".to_string(),
            name: "桌面 1".to_string(),
            windows: Vec::new(),
        };
        Self {
            spaces: Arc::new(Mutex::new(vec![default_space])),
            active_index: Arc::new(Mutex::new(0)),
        }
    }

    pub fn list(&self) -> Vec<Space> {
        self.spaces.lock().unwrap().clone()
    }

    pub fn active_index(&self) -> usize {
        *self.active_index.lock().unwrap()
    }

    pub fn switch(&self, index: usize) -> Result<(), String> {
        let spaces = self.spaces.lock().unwrap();
        if index >= spaces.len() {
            return Err("Invalid space index".to_string());
        }
        *self.active_index.lock().unwrap() = index;
        Ok(())
    }

    pub fn create(&self, name: String) -> String {
        let mut spaces = self.spaces.lock().unwrap();
        let id = format!("space-{}", spaces.len());
        spaces.push(Space {
            id: id.clone(),
            name,
            windows: Vec::new(),
        });
        id
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut spaces = self.spaces.lock().unwrap();
        if spaces.len() <= 1 {
            return Err("Cannot delete the last space".to_string());
        }
        let pos = spaces.iter().position(|s| s.id == id)
            .ok_or("Space not found")?;
        spaces.remove(pos);
        
        // 如果删除的是当前桌面，切换到前一个
        let mut active = self.active_index.lock().unwrap();
        if *active >= spaces.len() {
            *active = spaces.len() - 1;
        }
        Ok(())
    }

    pub fn move_window(&self, window_label: &str, space_id: &str) -> Result<(), String> {
        let mut spaces = self.spaces.lock().unwrap();
        
        // 从所有桌面移除该窗口
        for space in spaces.iter_mut() {
            space.windows.retain(|w| w != window_label);
        }
        
        // 添加到目标桌面
        let target = spaces.iter_mut()
            .find(|s| s.id == space_id)
            .ok_or("Target space not found")?;
        target.windows.push(window_label.to_string());
        
        Ok(())
    }

    /// 窗口打开时，自动添加到当前桌面
    pub fn add_window_to_current(&self, window_label: String) {
        let active = self.active_index();
        let mut spaces = self.spaces.lock().unwrap();
        if let Some(space) = spaces.get_mut(active) {
            if !space.windows.contains(&window_label) {
                space.windows.push(window_label);
            }
        }
    }

    /// 窗口关闭时，从所有桌面移除
    pub fn remove_window(&self, window_label: &str) {
        let mut spaces = self.spaces.lock().unwrap();
        for space in spaces.iter_mut() {
            space.windows.retain(|w| w != window_label);
        }
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────────

#[tauri::command]
pub fn spaces_list(state: State<SpaceManager>) -> Vec<SpaceInfo> {
    state.list().into_iter().map(|s| SpaceInfo {
        id: s.id,
        name: s.name,
        windows: s.windows,
    }).collect()
}

#[tauri::command]
pub fn spaces_active(state: State<SpaceManager>) -> usize {
    state.active_index()
}

#[tauri::command]
pub fn spaces_switch(state: State<SpaceManager>, index: usize) -> Result<(), String> {
    state.switch(index)
}

#[tauri::command]
pub fn spaces_create(state: State<SpaceManager>, name: String) -> String {
    state.create(name)
}

#[tauri::command]
pub fn spaces_delete(state: State<SpaceManager>, id: String) -> Result<(), String> {
    state.delete(&id)
}

#[tauri::command]
pub fn spaces_move_window(
    state: State<SpaceManager>,
    window_label: String,
    space_id: String,
) -> Result<(), String> {
    state.move_window(&window_label, &space_id)
}

#[tauri::command]
pub fn spaces_rename(
    state: State<SpaceManager>,
    id: String,
    name: String,
) -> Result<(), String> {
    let mut spaces = state.spaces.lock().unwrap();
    let space = spaces.iter_mut()
        .find(|s| s.id == id)
        .ok_or("Space not found")?;
    space.name = name;
    Ok(())
}
```

### 2.2 集成到 lib.rs

```rust
// crates/amos-tauri/src/lib.rs

mod spaces;
use spaces::SpaceManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SpaceManager::new())  // 注册 SpaceManager
        .invoke_handler(tauri::generate_handler![
            // ... 现有命令
            spaces::spaces_list,
            spaces::spaces_active,
            spaces::spaces_switch,
            spaces::spaces_create,
            spaces::spaces_delete,
            spaces::spaces_move_window,
            spaces::spaces_rename,
        ])
        // ...
}
```

### 2.3 wm 命令集成

修改现有的窗口管理命令，使其与 Spaces 协同：

```rust
// crates/amos-tauri/src/wm.rs

#[tauri::command]
pub async fn wm_open(
    app: AppHandle,
    label: String,
    spaces: State<'_, SpaceManager>,  // 新增参数
) -> Result<(), String> {
    // ... 现有打开窗口逻辑
    
    // 将窗口添加到当前桌面
    spaces.add_window_to_current(label.clone());
    
    Ok(())
}

#[tauri::command]
pub async fn wm_close(
    app: AppHandle,
    label: String,
    spaces: State<'_, SpaceManager>,  // 新增参数
) -> Result<(), String> {
    // 从所有桌面移除
    spaces.remove_window(&label);
    
    // ... 现有关闭窗口逻辑
    Ok(())
}
```

---

## 三、前端实现

### 3.1 TypeScript 桥接（lib/spaces.ts）

```typescript
import { invoke } from "./backend";

export interface Space {
  id: string;
  name: string;
  windows: string[];
}

/** 列出所有虚拟桌面 */
export async function listSpaces(): Promise<Space[]> {
  return invoke("spaces_list");
}

/** 获取当前桌面索引 */
export async function activeSpace(): Promise<number> {
  return invoke("spaces_active");
}

/** 切换到指定桌面 */
export async function switchSpace(index: number): Promise<void> {
  return invoke("spaces_switch", { index });
}

/** 创建新桌面 */
export async function createSpace(name: string): Promise<string> {
  return invoke("spaces_create", { name });
}

/** 删除桌面 */
export async function deleteSpace(id: string): Promise<void> {
  return invoke("spaces_delete", { id });
}

/** 移动窗口到另一个桌面 */
export async function moveWindowToSpace(
  windowLabel: string,
  spaceId: string
): Promise<void> {
  return invoke("spaces_move_window", { windowLabel, spaceId });
}

/** 重命名桌面 */
export async function renameSpace(id: string, name: string): Promise<void> {
  return invoke("spaces_rename", { id, name });
}
```

### 3.2 Spaces 管理面板（svelte/SpacesPanel.svelte）

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import {
    listSpaces,
    activeSpace,
    switchSpace,
    createSpace,
    deleteSpace,
    renameSpace,
    type Space,
  } from "../lib/spaces";
  import { t } from "./locale.svelte";

  let spaces = $state<Space[]>([]);
  let current = $state(0);
  let editing = $state<string | null>(null);
  let editName = $state("");

  async function refresh() {
    spaces = await listSpaces();
    current = await activeSpace();
  }

  async function onSwitch(index: number) {
    await switchSpace(index);
    current = index;
  }

  async function onCreate() {
    const name = `桌面 ${spaces.length + 1}`;
    await createSpace(name);
    await refresh();
  }

  async function onDelete(id: string) {
    if (spaces.length <= 1) {
      alert("无法删除最后一个桌面");
      return;
    }
    await deleteSpace(id);
    await refresh();
  }

  function startEdit(space: Space) {
    editing = space.id;
    editName = space.name;
  }

  async function saveEdit(id: string) {
    if (editName.trim()) {
      await renameSpace(id, editName.trim());
      await refresh();
    }
    editing = null;
  }

  onMount(() => {
    void refresh();
  });
</script>

<div class="spaces-panel p-4">
  <div class="flex items-center justify-between mb-4">
    <h2 class="text-lg font-semibold">{t("spaces.title")}</h2>
    <button
      onclick={onCreate}
      class="px-3 py-1.5 rounded bg-accent text-white text-sm"
    >
      + {t("spaces.create")}
    </button>
  </div>

  <div class="grid grid-cols-2 gap-3">
    {#each spaces as space, i (space.id)}
      <div
        class="space-card relative rounded-lg border-2 transition-all cursor-pointer"
        class:border-accent={i === current}
        class:border-neutral-200={i !== current}
        class:bg-accent/5={i === current}
        onclick={() => onSwitch(i)}
      >
        <!-- 桌面预览区 -->
        <div class="aspect-video bg-neutral-100 dark:bg-neutral-800 rounded-t-lg p-2">
          {#if space.windows.length > 0}
            <div class="grid grid-cols-2 gap-1">
              {#each space.windows.slice(0, 4) as win}
                <div class="h-6 bg-white dark:bg-neutral-700 rounded text-[10px] flex items-center justify-center">
                  {win}
                </div>
              {/each}
            </div>
            {#if space.windows.length > 4}
              <div class="text-[10px] text-neutral-500 mt-1 text-center">
                +{space.windows.length - 4} 更多
              </div>
            {/if}
          {:else}
            <div class="h-full flex items-center justify-center text-neutral-400 text-xs">
              无窗口
            </div>
          {/if}
        </div>

        <!-- 桌面名称 -->
        <div class="p-2 flex items-center justify-between">
          {#if editing === space.id}
            <input
              bind:value={editName}
              onblur={() => saveEdit(space.id)}
              onkeydown={(e) => e.key === "Enter" && saveEdit(space.id)}
              class="flex-1 px-2 py-1 text-sm border rounded"
              onclick={(e) => e.stopPropagation()}
            />
          {:else}
            <span class="text-sm font-medium">{space.name}</span>
          {/if}

          <div class="flex gap-1" onclick={(e) => e.stopPropagation()}>
            <button
              onclick={() => startEdit(space)}
              class="p-1 hover:bg-neutral-100 rounded"
              title="重命名"
            >
              ✏️
            </button>
            {#if spaces.length > 1}
              <button
                onclick={() => onDelete(space.id)}
                class="p-1 hover:bg-red-100 rounded"
                title="删除"
              >
                🗑️
              </button>
            {/if}
          </div>
        </div>

        {#if i === current}
          <div class="absolute top-2 right-2 px-2 py-0.5 bg-accent text-white text-[10px] rounded-full">
            当前
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>
```

### 3.3 更新 Mission Control（MissionControl.svelte）

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "../lib/backend";
  import { listSpaces, activeSpace, switchSpace, type Space } from "../lib/spaces";
  import { t } from "./locale.svelte";

  let spaces = $state<Space[]>([]);
  let current = $state(0);
  let windows = $state<{ label: string; title: string }[]>([]);

  async function refresh() {
    spaces = await listSpaces();
    current = await activeSpace();
    
    // 获取当前桌面的窗口详情
    if (spaces[current]) {
      // TODO: 实现 wm_list_windows 命令
      windows = []; // 临时为空
    }
  }

  async function onSwitchSpace(index: number) {
    await switchSpace(index);
    close();
  }

  async function onSwitchWindow(label: string) {
    await invoke("wm_focus", { label });
    close();
  }

  function close() {
    // 关闭 Mission Control 浮层的逻辑
  }

  onMount(() => {
    void refresh();
  });
</script>

<div class="mission-control fixed inset-0 bg-black/20 backdrop-blur-sm z-[300]">
  <!-- Spaces 条（顶部） -->
  <div class="spaces-strip flex justify-center gap-3 pt-8 pb-4">
    {#each spaces as space, i (space.id)}
      <button
        onclick={() => onSwitchSpace(i)}
        class="space-thumb w-32 h-20 rounded-lg border-2 transition-all"
        class:border-accent={i === current}
        class:border-white/30={i !== current}
        class:bg-white/10={i !== current}
        class:bg-accent/20={i === current}
      >
        <div class="text-white text-sm font-medium">{space.name}</div>
        <div class="text-white/60 text-xs">{space.windows.length} 个窗口</div>
      </button>
    {/each}
  </div>

  <!-- 窗口网格（中部） -->
  <div class="windows-grid grid grid-cols-3 gap-4 px-8">
    {#each windows as win (win.label)}
      <button
        onclick={() => onSwitchWindow(win.label)}
        class="window-preview aspect-video bg-white/10 rounded-lg border border-white/20 hover:border-accent transition-all"
      >
        <div class="text-white text-sm">{win.title}</div>
      </button>
    {/each}

    {#if windows.length === 0}
      <div class="col-span-3 text-center text-white/50 py-8">
        当前桌面无打开的窗口
      </div>
    {/if}
  </div>
</div>
```

### 3.4 快捷键集成（DesktopShell.svelte）

```typescript
// DesktopShell.svelte - 添加到现有的 onWindowKeyDown

import { listSpaces, activeSpace, switchSpace } from "../lib/spaces";

let currentSpace = $state(0);
let totalSpaces = $state(1);

$effect(() => {
  // 定期刷新 Spaces 状态
  void refreshSpaces();
});

async function refreshSpaces() {
  const spaces = await listSpaces();
  totalSpaces = spaces.length;
  currentSpace = await activeSpace();
}

function onWindowKeyDown(e: KeyboardEvent) {
  // ... 现有快捷键逻辑
  
  // Ctrl+← - 上一个桌面
  if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key === "ArrowLeft") {
    if (currentSpace > 0) {
      void switchSpace(currentSpace - 1).then(refreshSpaces);
    }
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  
  // Ctrl+→ - 下一个桌面
  if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key === "ArrowRight") {
    if (currentSpace < totalSpaces - 1) {
      void switchSpace(currentSpace + 1).then(refreshSpaces);
    }
    e.preventDefault();
    e.stopPropagation();
    return;
  }
}
```

---

## 四、测试计划

### 4.1 单元测试（__tests__/spaces.test.ts）

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import {
  listSpaces,
  activeSpace,
  createSpace,
  switchSpace,
  deleteSpace,
  moveWindowToSpace,
  renameSpace,
} from "../lib/spaces";

describe("Spaces", () => {
  beforeEach(async () => {
    // 重置到初始状态：1 个桌面
  });

  test("初始状态有 1 个桌面", async () => {
    const spaces = await listSpaces();
    expect(spaces.length).toBe(1);
    expect(spaces[0].name).toBe("桌面 1");
  });

  test("创建新桌面", async () => {
    const id = await createSpace("工作");
    const spaces = await listSpaces();
    expect(spaces.length).toBe(2);
    expect(spaces.find(s => s.id === id)?.name).toBe("工作");
  });

  test("切换桌面", async () => {
    await createSpace("工作");
    await switchSpace(1);
    const current = await activeSpace();
    expect(current).toBe(1);
  });

  test("切换到无效索引应失败", async () => {
    await expect(switchSpace(99)).rejects.toThrow();
  });

  test("删除桌面", async () => {
    const id = await createSpace("临时");
    await deleteSpace(id);
    const spaces = await listSpaces();
    expect(spaces.find(s => s.id === id)).toBeUndefined();
  });

  test("无法删除最后一个桌面", async () => {
    const spaces = await listSpaces();
    await expect(deleteSpace(spaces[0].id)).rejects.toThrow();
  });

  test("移动窗口到另一个桌面", async () => {
    const id = await createSpace("工作");
    await moveWindowToSpace("settings", id);
    const spaces = await listSpaces();
    const workspace = spaces.find(s => s.id === id);
    expect(workspace?.windows).toContain("settings");
  });

  test("重命名桌面", async () => {
    const spaces = await listSpaces();
    await renameSpace(spaces[0].id, "主桌面");
    const updated = await listSpaces();
    expect(updated[0].name).toBe("主桌面");
  });
});
```

### 4.2 集成测试

```typescript
describe("Spaces Integration", () => {
  test("打开窗口自动添加到当前桌面", async () => {
    await invoke("wm_open", { label: "settings" });
    const spaces = await listSpaces();
    const current = spaces[await activeSpace()];
    expect(current.windows).toContain("settings");
  });

  test("关闭窗口从所有桌面移除", async () => {
    await invoke("wm_open", { label: "settings" });
    await invoke("wm_close", { label: "settings" });
    const spaces = await listSpaces();
    for (const space of spaces) {
      expect(space.windows).not.toContain("settings");
    }
  });

  test("切换桌面后只显示该桌面的窗口", async () => {
    // 桌面 1 打开 settings
    await invoke("wm_open", { label: "settings" });
    
    // 创建桌面 2 并切换
    const id2 = await createSpace("工作");
    await switchSpace(1);
    
    // 桌面 2 打开 photos
    await invoke("wm_open", { label: "photos" });
    
    // 验证
    const spaces = await listSpaces();
    expect(spaces[0].windows).toEqual(["settings"]);
    expect(spaces[1].windows).toEqual(["photos"]);
  });
});
```

---

## 五、时间表

### Week 1: Rust 后端（5 天）

- Day 1-2: `spaces.rs` 核心逻辑
- Day 3: 集成到 `lib.rs` + Tauri commands
- Day 4: 修改 `wm.rs`（窗口打开/关闭联动）
- Day 5: Rust 单元测试

### Week 2: 前端桥接 + UI（5 天）

- Day 1: `lib/spaces.ts` 桥接层
- Day 2-3: `SpacesPanel.svelte` 管理界面
- Day 4: 更新 `MissionControl.svelte`
- Day 5: 前端单元测试

### Week 3: 集成 + 测试（5 天）

- Day 1: 快捷键集成（`DesktopShell.svelte`）
- Day 2: 集成测试
- Day 3: 手动测试 + Bug 修复
- Day 4: 性能测试 + 优化
- Day 5: 文档更新

---

## 六、验收标准

✅ 用户可以创建/删除/重命名虚拟桌面  
✅ `Ctrl+← / Ctrl+→` 快捷键切换桌面  
✅ 打开的窗口自动关联到当前桌面  
✅ Mission Control 显示所有桌面 + 窗口  
✅ 可以将窗口拖动到其他桌面  
✅ 删除桌面时，窗口不丢失（移到其他桌面）  
✅ 单元测试覆盖率 ≥ 80%  
✅ 集成测试通过  
✅ 文档完整（API + 用户手册）  

---

**计划创建时间**：2026-09-16  
**预计开始时间**：2027-01-05  
**预计完成时间**：2027-01-26  
**负责人**：待定  
**状态**：计划中
