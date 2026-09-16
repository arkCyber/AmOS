/**
 * Spaces 管理面板
 * 
 * 状态：完整实现（2026-09-16）
 * 
 * REQ-SPACES: 虚拟桌面管理
 * 详细文档：docs/SPACES_IMPLEMENTATION_PLAN.md
 */

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
  import { bridgeDiag } from "../lib/backend";

  let spaces = $state<Space[]>([]);
  let currentIndex = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let editingId = $state<string | null>(null);
  let editingName = $state("");

  /**
   * Translate a `spaces_*` error code from `bridgeDiag()` into a user-facing
   * sentence. Mirrors `StoreApp.svelte`'s `labelForCode` — kept local so a
   * future i18n sweep can move both into a shared helper without rewriting
   * either call site.
   */
  function spacesErrorLabel(command: string): string {
    const diag = bridgeDiag(command);
    if (diag.ok) return "操作失败 (无详情)";
    const detail =
      diag.kind === "command-failed" && typeof diag.detail === "object" && diag.detail
        ? (diag.detail as { code?: string; message?: string })
        : null;
    switch (detail?.code) {
      case "amos.spaces.lock_failed":
        return "内部锁失败,请稍后再试";
      case "amos.spaces.serialization_failed":
        return "保存失败 (本地存储不可写)";
      case "amos.spaces.not_found":
        return "找不到该桌面 (可能已经被删除)";
      case "amos.spaces.index_out_of_bounds":
        return "桌面索引超出范围";
      case "amos.spaces.delete_last":
        return "无法删除最后一个桌面";
      default:
        return detail?.message ?? "操作失败";
    }
  }

  async function loadSpaces() {
    loading = true;
    error = null;
    try {
      // `invoke` swallows errors into `null` (REQ-A296), so the only signal is
      // the `null` return — never a thrown Promise. The old `try/catch` form
      // was a TypeScript lie: a failed `spaces_list` would assign `null` to a
      // typed `Space[]` and quietly break the panel.
      const list = await listSpaces();
      const active = await activeSpace();
      if (list === null) {
        spaces = [];
        currentIndex = 0;
        error = spacesErrorLabel("spaces_list");
        return;
      }
      spaces = list;
      currentIndex = active ?? 0;
    } finally {
      loading = false;
    }
  }

  async function handleSwitch(index: number) {
    const ok = await switchSpace(index);
    if (!ok) {
      error = spacesErrorLabel("spaces_switch");
      return;
    }
    currentIndex = index;
  }

  // Navigate to previous/next space with arrow keys
  async function handleArrowNavigation(direction: "left" | "right") {
    if (spaces.length === 0) return;

    const newIndex =
      direction === "left"
        ? currentIndex > 0
          ? currentIndex - 1
          : spaces.length - 1
        : currentIndex < spaces.length - 1
          ? currentIndex + 1
          : 0;

    await handleSwitch(newIndex);
  }

  function handleKeyDown(e: KeyboardEvent) {
    // Ctrl+Arrow navigation (when panel is open)
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        void handleArrowNavigation("left");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        void handleArrowNavigation("right");
      }
    }
  }

  async function handleCreate() {
    const name = `桌面 ${spaces.length + 1}`;
    const newId = await createSpace(name);
    if (newId === null) {
      error = spacesErrorLabel("spaces_create");
      return;
    }
    await loadSpaces();
  }

  async function handleDelete(id: string) {
    if (spaces.length <= 1) {
      error = "无法删除最后一个桌面";
      return;
    }

    const ok = await deleteSpace(id);
    if (!ok) {
      error = spacesErrorLabel("spaces_delete");
      return;
    }
    await loadSpaces();
  }

  function startEdit(space: Space) {
    editingId = space.id;
    editingName = space.name;
  }

  function cancelEdit() {
    editingId = null;
    editingName = "";
  }

  async function saveEdit(id: string) {
    if (!editingName.trim()) {
      cancelEdit();
      return;
    }

    const ok = await renameSpace(id, editingName.trim());
    if (!ok) {
      error = spacesErrorLabel("spaces_rename");
      return;
    }
    await loadSpaces();
    cancelEdit();
  }

  onMount(() => {
    void loadSpaces();

    // Listen for keyboard events when panel is open
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  });
</script>

<div class="spaces-panel p-6 bg-white dark:bg-neutral-900 rounded-lg">
  <!-- 头部 -->
  <div class="flex items-center justify-between mb-6">
    <h2 class="text-2xl font-semibold text-neutral-800 dark:text-neutral-200">
      虚拟桌面管理
    </h2>
    <button
      onclick={handleCreate}
      class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50"
      disabled={loading}
    >
      ＋ 新建桌面
    </button>
  </div>

  <!-- 错误提示 -->
  {#if error}
    <div class="mb-4 p-3 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-lg">
      ⚠️ {error}
      <button onclick={() => (error = null)} class="ml-2 underline">关闭</button>
    </div>
  {/if}

  <!-- 加载状态 -->
  {#if loading}
    <div class="flex items-center justify-center py-12">
      <div class="animate-spin text-4xl">⏳</div>
      <span class="ml-3 text-neutral-600 dark:text-neutral-400">加载中...</span>
    </div>
  {:else}
    <!-- Spaces 列表 -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each spaces as space, index (space.id)}
        <div
          class="space-card p-4 rounded-lg border-2 transition-all cursor-pointer {currentIndex === index
            ? 'border-blue-600 bg-blue-50 dark:bg-blue-950'
            : 'border-neutral-300 dark:border-neutral-700 hover:border-neutral-400 dark:hover:border-neutral-600'}"
          onclick={() => handleSwitch(index)}
        >
          <!-- 桌面图标 -->
          <div class="text-3xl mb-2">
            {currentIndex === index ? "🖥️✨" : "🖥️"}
          </div>

          <!-- 桌面名称 -->
          {#if editingId === space.id}
            <input
              type="text"
              bind:value={editingName}
              class="w-full px-2 py-1 mb-2 border rounded text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800"
              onclick={(e) => e.stopPropagation()}
              onkeydown={(e) => {
                if (e.key === "Enter") saveEdit(space.id);
                if (e.key === "Escape") cancelEdit();
              }}
            />
            <div class="flex gap-2" onclick={(e) => e.stopPropagation()}>
              <button
                onclick={() => saveEdit(space.id)}
                class="flex-1 px-2 py-1 bg-green-600 text-white rounded text-sm"
              >
                保存
              </button>
              <button
                onclick={cancelEdit}
                class="flex-1 px-2 py-1 bg-neutral-600 text-white rounded text-sm"
              >
                取消
              </button>
            </div>
          {:else}
            <div class="flex items-center justify-between mb-2">
              <h3 class="font-medium text-neutral-800 dark:text-neutral-200">
                {space.name}
              </h3>
              <button
                onclick={(e) => {
                  e.stopPropagation();
                  startEdit(space);
                }}
                class="text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                title="重命名"
              >
                ✏️
              </button>
            </div>

            <!-- 窗口数量 -->
            <div class="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
              {space.windows.length} 个窗口
            </div>

            <!-- 操作按钮 -->
            <div class="flex gap-2" onclick={(e) => e.stopPropagation()}>
              {#if currentIndex === index}
                <div class="flex-1 px-2 py-1 bg-blue-600 text-white text-center rounded text-sm">
                  当前桌面
                </div>
              {:else}
                <button
                  onclick={() => handleSwitch(index)}
                  class="flex-1 px-2 py-1 bg-neutral-600 hover:bg-neutral-700 text-white rounded text-sm"
                >
                  切换
                </button>
              {/if}
              <button
                onclick={() => handleDelete(space.id)}
                class="px-2 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-sm disabled:opacity-50"
                disabled={spaces.length <= 1}
                title={spaces.length <= 1 ? "无法删除最后一个桌面" : "删除"}
              >
                🗑️
              </button>
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- 快捷键提示 -->
    <div class="mt-8 p-4 bg-neutral-100 dark:bg-neutral-800 rounded-lg">
      <h3 class="font-medium mb-3 text-neutral-800 dark:text-neutral-200">⌨️ 快捷键</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
        <div class="flex justify-between">
          <span class="text-neutral-600 dark:text-neutral-400">切换到上一个桌面：</span>
          <kbd class="px-2 py-1 bg-neutral-200 dark:bg-neutral-700 rounded">Ctrl+←</kbd>
        </div>
        <div class="flex justify-between">
          <span class="text-neutral-600 dark:text-neutral-400">切换到下一个桌面：</span>
          <kbd class="px-2 py-1 bg-neutral-200 dark:bg-neutral-700 rounded">Ctrl+→</kbd>
        </div>
        <div class="flex justify-between">
          <span class="text-neutral-600 dark:text-neutral-400">Mission Control：</span>
          <kbd class="px-2 py-1 bg-neutral-200 dark:bg-neutral-700 rounded">F3</kbd>
        </div>
        <div class="flex justify-between">
          <span class="text-neutral-600 dark:text-neutral-400">新建桌面：</span>
          <kbd class="px-2 py-1 bg-neutral-200 dark:bg-neutral-700 rounded">Ctrl+↑</kbd>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .spaces-panel {
    animation: fadeIn 0.3s ease-in-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .space-card {
    transition: all 0.2s;
  }

  .space-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  }

  kbd {
    font-family: ui-monospace, monospace;
    font-size: 0.875rem;
  }
</style>
