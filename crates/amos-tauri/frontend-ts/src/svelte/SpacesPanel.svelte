/**
 * Spaces 管理面板
 * 
 * 状态：完整实现（2026-09-16）
 * 
 * REQ-SPACES: 虚拟桌面管理
 * 详细文档：docs/SPACES_IMPLEMENTATION_PLAN.md
 */

<script lang="ts">
  import { getContext, onMount } from "svelte";
  import {
    listSpaces,
    activeSpace,
    switchSpace,
    createSpace,
    deleteSpace,
    renameSpace,
    moveWindowToSpace,
    unfileWindow,
    fileableWindows,
    prevSpaceIndex,
    nextSpaceIndex,
    spacesFailure,
    announceSpacesChanged,
    onSpacesChanged,
    type Space,
  } from "../lib/spaces";
  import { wmWindows, type WmWindowInfo } from "../lib/wm";
  import { getStoreTiles, type StoreTile } from "../lib/storeApps";
  import { SHELL_CHROME_API, type ShellChromeApi } from "../lib/shellModule";
  import { createKeyboardBindings } from "../lib/keyboardConfigHook.svelte";
  import { shortcutMatches } from "../lib/shellModule";
  import { t, windowName } from "./locale.svelte";

  // REQ-A1185：窗口名对已安装的商店应用此前回退成 raw wire id（`windowName` 只查内置注册表）。
  // 瓷砖表由壳推下来（getter ⇒ 保持活），单独渲染本组件时回退到模块缓存。
  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);
  const ext = $derived<readonly StoreTile[]>(api?.storeTiles ?? getStoreTiles());

  let spaces = $state<Space[]>([]);
  /**
   * 当前桌面的索引 —— `null` = **宿主还没回答过**「哪个桌面是当前的」。
   *
   * 这一个状态是 F-SH-585 的「如实边界」里逐字登记为**另案**的那个假索引：从前这里是
   * `$state(0)`，而 `loadSpaces` 逐字 `currentIndex = active ?? 0;` 把 `spaces_active()`
   * 的 `null`（宿主没回答 —— `invoke` 从不 reject、失败解析为 `null`，REQ-A296）折成
   * 「桌面 0 是当前的」。于是宿主拒答时，第 0 张卡片带着 🖥️✨、「当前桌面」牌子与蓝色高亮 ——
   * 一个没有任何人建立过的事实。同一文件 `syncActiveDesktop` 对**同一个**读数
   * （`if (active === null || …) return;`）与邻居 `DesktopShell`（`if (!spaces || current === null) return;`）
   * 都拒绝折 —— 只有**首读**这一处折了。
   *
   * `null` 不是「没有当前桌面」，是「不知道」：卡片因此一张也不标当前，且不拿 `0` 去
   * 假装重放一次切换（见 `handleAssignWindow`）。
   */
  let currentIndex = $state<number | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  /**
   * 切换**成功**但有窗口没跟着走时的提示（REQ-A513）。
   *
   * 与 `error` 分开：切换确实发生了，把它显示成"错误"会撒谎；但不说也不行 ——
   * 那是用户看得见、别处看不见的状态。
   */
  let warning = $state<string | null>(null);
  let editingId = $state<string | null>(null);
  let editingName = $state("");
  /**
   * The app windows a desktop can own (REQ-A449). `null` means the host did not answer the
   * `wm_windows` call — the panel says so rather than drawing an empty list, which would read as
   * "you have no windows".
   */
  let windows = $state<WmWindowInfo[] | null>(null);
  /** Label of the window being filed (the selects are disabled while one is in flight). */
  let assigning = $state<string | null>(null);

  /**
   * 底部快捷键图例的弦，读**实时合并绑定**而不是写死的字面量（REQ-A553）。
   *
   * 此前这四条 `<kbd>` 全部是硬编码的（`⌃←` / `⌃→` / `F3` / `⌃↑` 四个字面量），于是用户在
   * 设置里改键或**禁用**某条绑定后，图例照旧印着旧弦 —— 与 `DockContextMenu` 早已改掉的那个
   * 缺陷同形（F-SH-003："声称的能力"与"真的能力"不一致）。现在四个值都从
   * `createKeyboardBindings()` 取：改键跟着变，`null`（被禁用）则不画 `<kbd>`（"做不到就不
   * 假装"）。
   *
   * 顺带修掉一条**假**行：旧图例把 `⌃↑` 写成"创建新桌面"，而 `⌃↑` 是 `spacesPanel`
   * （设置页明写"显示虚拟桌面面板"）、`SPACES_DEFAULTS` 里**根本没有**创建新桌面的绑定 ——
   * 按下去打开的是本面板，不是新建。现在那一行如实写成「显示/隐藏本面板」。
   *
   * `mission-control` 是**浮层注册表**里的 id（`F3` / `⌘⇥` 两个入口），所以走
   * `getOverlayShortcut` —— 与 Dock / 顶栏读同一个注册表，不是第二份快捷键表。
   */
  const kb = createKeyboardBindings();
  const hintPrev = $derived(kb.getSpacesShortcut("spacesPrev"));
  const hintNext = $derived(kb.getSpacesShortcut("spacesNext"));
  const hintDirect = $derived(kb.getSpacesShortcut("spacesDirect"));
  const hintPanel = $derived(kb.getSpacesShortcut("spacesPanel"));
  const hintMission = $derived(kb.getOverlayShortcut("mission-control"));

  /**
   * Translate a `spaces_*` error code from `bridgeDiag()` into a user-facing
   * sentence.
   *
   * F-SH-577: the code → message rule moved to [`spacesFailure`] (`lib/spaces.ts`) because this
   * file was its **only** owner and Mission Control — which reports the very same
   * `spaces_switch` refusal — said nothing at all. Two surfaces, one rule; here we only add the
   * language. The behaviour is unchanged, including the host's own sentence as the fallback for
   * a code this build does not know.
   */
  function spacesErrorLabel(command: string): string {
    const { key, hostMessage } = spacesFailure(command);
    return hostMessage ?? t(key);
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
        currentIndex = null;
        error = spacesErrorLabel("spaces_list");
        return;
      }
      spaces = list;
      // 宿主没回答「哪个桌面是当前的」时**不编一个**：`active` 原样交给 `currentIndex`
      // （`null` ⇒ 一张卡片都不标当前，也不拿 0 去重放切换）。这是 F-SH-585 登记为另案的
      // 假索引 —— `?? 0` 曾经在卡片上点亮 🖥️✨ 与「当前桌面」牌子，而那两个事实没有任何
      // 人建立过；同一文件 `syncActiveDesktop` 与 `DesktopShell` 对同一个 `null` 都拒绝折。
      currentIndex = active;
      // The window list is read on every ledger reload so the two views cannot disagree: which
      // desktop owns a window is the ledger's answer, and it is what the panel draws next to it.
      await loadWindows();
    } finally {
      loading = false;
    }
  }

  /**
   * 面板打开时**别人**换了桌面 —— 重新问宿主，把高亮挪到那一张（REQ-A1311 / F-SH-585）。
   *
   * 为什么需要：默认绑定下面板打开时按 ⌃←/⌃→，跑的是**壳**那一份处理器（壳在 capture 阶段
   * 消费并 `stopPropagation()`，见 `handleKeyDown` 的说明），所以面板永远不会从自己的按键
   * 路径上得知桌面换过了。属主改了事实却不通告，面板就停在旧桌面上 —— 高亮、🖥️✨、以及那张
   * 「当前桌面」的牌子全部指向一个用户已经离开的桌面。
   *
   * 索引仍以 `spaces_active` 为权威：这里**重新读一次**，而不是相信通告捎来的副本
   * （通告本身不带索引，见 `lib/spaces.ts::announceSpacesChanged`）。读到同样的索引就直接
   * 返回 —— 通告是幂等的，面板自己那次切换不该换来一次多余的渲染。
   */
  async function syncActiveDesktop() {
    if (spaces.length === 0) return;
    const active = await activeSpace();
    // `null` = 宿主没有回答。不假装：保持上一次读到的权威值（与 `loadSpaces` 的 `?? 0` 不同，
    // 那条路至少刚刚成功读到了列表；这里连"有没有这个桌面"都不知道，挪高亮就是编）。
    if (active === null || active === currentIndex) return;
    if (active < 0 || active >= spaces.length) return;
    currentIndex = active;
  }

  /**
   * The host's app windows — the ones a desktop can actually own (REQ-A449).
   *
   * Which windows qualify is [`fileableWindows`]'s rule (one place, unit-tested); this function
   * only adds the "the host did not answer" third state, which the panel renders as such instead
   * of as an empty list.
   */
  async function loadWindows() {
    const snapshot = await wmWindows();
    windows = snapshot === null ? null : fileableWindows(snapshot);
  }

  /** Which desktop owns `label`, or `null` when nothing has filed it yet. */
  function spaceOfWindow(label: string): string | null {
    return spaces.find((s) => s.windows.includes(label))?.id ?? null;
  }

  /**
   * File a window into a desktop — the last piece of Spaces that had **no UI at all** (REQ-A449):
   * `spaces_move_window` existed on the bridge and nothing called it, so only a window filed by
   * hand from a shell could ever follow a desktop switch.
   *
   * After the move this **re-applies the active desktop** rather than deciding visibility here:
   * the host's `switch_plan` is the single rule that says what disappears and what appears, and
   * calling it with the current index is exactly "make the screen match the ledger". A window just
   * filed to *another* desktop therefore leaves the screen at once — which is what the user asked
   * for — without this component re-implementing the rule.
   */
  async function handleAssignWindow(label: string, spaceId: string) {
    if (spaceId === (spaceOfWindow(label) ?? "")) return;
    assigning = label;
    error = null;
    // An empty selection is **not** "do nothing": it is the unfiled state — the one every window
    // starts in, visible on every desktop. `spaces_move_window` only moves a window *between*
    // desktops, so reaching that state needs its own command (REQ-A450).
    const ok =
      spaceId === "" ? await unfileWindow(label) : await moveWindowToSpace(label, spaceId);
    if (!ok) {
      error = spacesErrorLabel(spaceId === "" ? "spaces_unfile_window" : "spaces_move_window");
    } else {
      await loadSpaces();
      // 「让屏幕与账本一致」要有**一个**权威索引才做得了。宿主没回答当前桌面
      // （`currentIndex === null`）时重放切换就是拿 0 假装 —— 那会真的把用户切到桌面 0，
      // 而没有任何人说过他在那儿。归档本身仍然成功，只是这一下不做多余的切换。
      if (currentIndex !== null) await applySwitch(currentIndex);
    }
    await loadWindows();
    assigning = null;
  }

  /**
   * 切换到 `index` 并**读完**宿主的读数 —— 切桌面控件与「归档窗口后重新应用」共用这一个属主。
   *
   * 归档路径曾经自己写了一遍 `await switchSpace(currentIndex);` 并把读数丢掉：那条路径上
   * `null`（宿主拒绝）与 `hide_failed ∕ show_failed`（账本动了、屏幕没动）都会消失得无声无息，
   * 而窗口此时已经归档走、`loadWindows()` 也让列表如实反映了 —— 用户看着屏幕和账本对不上，
   * 一句话也没有。同一个文件里的切换控件本来就报这两种状态，两处不该有两种答案。
   */
  async function applySwitch(index: number): Promise<void> {
    const report = await switchSpace(index);
    if (!report) {
      error = spacesErrorLabel("spaces_switch");
      return;
    }
    currentIndex = index;
    // 这一次切换有读数了：上一次拒绝留下的那句话不再成立，先撤掉 —— 否则卡片的高亮说着
    // "切过去了"、红色横幅还说着"切换失败"，同一件事在同一个屏幕上两种说法。姊妹页
    // `MissionControl::onSwitchSpace` 对同一个宿主读数做的正是这一步（`switchError = null`）。
    error = null;
    // REQ-A1311：本条事实的属主有三个（壳的 ⌃←/⌃→ 与 ⌃1…9、本面板、Mission Control），
    // 而**显示**它的面不止一个。谁换的都要通告，否则另一个开着的面停在旧桌面上 ——
    // 与壳那条路径同一条纪律（`DesktopShell.svelte` 的两处 `announceSpacesChanged()`）。
    announceSpacesChanged();
    // 切换**成功**了，但"账本动了、屏幕没动"的窗口要说出来（REQ-A513）：这条信息从前只进
    // `tracing::warn!`，而它恰好是用户看得见、别的模块看不见的那一种状态。
    const missed = report.hide_failed.length + report.show_failed.length;
    warning = missed > 0 ? t("spaces.switchPartial", { n: missed }) : null;
  }

  async function handleSwitch(index: number) {
    await applySwitch(index);
  }

  /**
   * Step to the previous / next desktop with the arrow keys.
   *
   * The **cyclic wrap** is not computed here — it is [`prevSpaceIndex`] / [`nextSpaceIndex`],
   * the same pair the shell's keyboard handler uses (REQ-A340). This handler used to carry its
   * own copy of that arithmetic; two implementations of one rule drift, and only one of them was
   * covered by `spacesShortcuts.test.ts`. `null` (out of range) and "no movement" both mean there
   * is nothing to switch to — including the single-desktop case, where the shared math is
   * deliberately stationary so we do not round-trip the bridge for nothing.
   */
  async function handleArrowNavigation(direction: "left" | "right") {
    // 不知道站在哪张桌面上就没法"上一张 ∕ 下一张"：`null` 是从哪一步都算不出来，
    // 不是第 0 张。卡片仍可点，用户自己选一张之后 `currentIndex` 才有值。
    if (spaces.length === 0 || currentIndex === null) return;
    const next =
      direction === "left"
        ? prevSpaceIndex(currentIndex, spaces.length)
        : nextSpaceIndex(currentIndex, spaces.length);
    if (next === null || next === currentIndex) return;
    await handleSwitch(next);
  }

  /**
   * 面板打开时用方向键翻桌面。
   *
   * 判据读**实时合并绑定**（`kb.bindings.spaces`）而不是写死的 ⌃←/⌃→ —— 与图例
   * （`hintPrev` / `hintNext`，REQ-A553）和桌面壳的 Spaces 判据同一份（REQ-A1308）。
   *
   * 这里原本是 `e.ctrlKey && e.key === "ArrowLeft"`：同一条键在**图例**里跟着用户改、
   * 在这个处理函数里不跟。于是禁用 `spacesPrev` 之后图例如实不画 `<kbd>`，面板里按 ⌃←
   * 却照样切桌面；改绑到 ⌥← 之后图例印 ⌥←、按 ⌃← 也仍然切。这是 `DockContextMenu` 早已
   * 修掉的 F-SH-003 形状（"声称的能力"与"真的能力"两套）。
   *
   * 线上默认绑定下这两条判据的差别被**掩盖**了：桌面壳在 capture 阶段听同一个 `keydown`
   * 并 `stopPropagation()`，命中时面板的 bubble 监听器收不到 —— 也就是说这个写死的判据
   * 只在壳**没有**消费时才被跑到，而那恰好就是它最不该生效的两种场合（键被禁用／被改绑）。
   */
  function handleKeyDown(e: KeyboardEvent) {
    const spacesBindings = kb.bindings.spaces;
    const prev = spacesBindings.get("spacesPrev");
    const next = spacesBindings.get("spacesNext");
    if (prev && shortcutMatches(e, prev)) {
      e.preventDefault();
      e.stopPropagation();
      void handleArrowNavigation("left");
    } else if (next && shortcutMatches(e, next)) {
      e.preventDefault();
      e.stopPropagation();
      void handleArrowNavigation("right");
    }
  }

  async function handleCreate() {
    const newId = await createSpace(t("spaces.defaultName", { n: spaces.length + 1 }));
    if (newId === null) {
      error = spacesErrorLabel("spaces_create");
      return;
    }
    await loadSpaces();
  }

  async function handleDelete(id: string) {
    if (spaces.length <= 1) {
      error = t("spaces.cannotDeleteLast");
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
    // REQ-A1311：别处（桌面壳的 ⌃←/⌃→、⌃1…9）换了桌面时跟着挪高亮 —— 面板自己的监听器
    // 被壳的 capture 处理器遮蔽，这条通告是它与属主之间唯一的信息通路。
    const stopSpaces = onSpacesChanged(() => {
      void syncActiveDesktop();
    });

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      stopSpaces();
    };
  });
</script>

<div class="spaces-panel p-6 bg-white dark:bg-neutral-900 rounded-lg">
  <!-- 头部 -->
  <div class="flex items-center justify-between mb-6">
    <h2 class="text-2xl font-semibold text-neutral-800 dark:text-neutral-200">
      {t("spaces.title")}
    </h2>
    <button
      onclick={handleCreate}
      class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50"
      disabled={loading}
    >
      {t("spaces.newDesktop")}
    </button>
  </div>

  <!-- 错误提示 -->
  {#if error}
    <div class="mb-4 p-3 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-lg">
      ⚠️ {error}
      <button onclick={() => (error = null)} class="ml-2 underline">{t("spaces.dismiss")}</button>
    </div>
  {/if}

  <!-- 部分窗口没跟着切换（REQ-A513）：切换成功，所以是提示而不是错误 -->
  {#if warning}
    <div
      class="mb-4 p-3 bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 rounded-lg"
      data-testid="spaces-switch-partial"
    >
      ⚠️ {warning}
      <button onclick={() => (warning = null)} class="ml-2 underline">{t("spaces.dismiss")}</button>
    </div>
  {/if}

  <!-- 加载状态 -->
  {#if loading}
    <div class="flex items-center justify-center py-12">
      <div class="animate-spin text-4xl">⏳</div>
      <span class="ml-3 text-neutral-600 dark:text-neutral-400">{t("spaces.loading")}</span>
    </div>
  {:else}
    <!-- 宿主没回答「哪个桌面是当前的」：既点亮某张卡（那是在编），也不沉默（用户会以为
         面板坏了）。与窗口列表读不到时的 `spaces.windowsUnavailable` 同一条纪律。 -->
    {#if currentIndex === null}
      <p
        class="mb-4 p-3 bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 rounded-lg"
        data-testid="spaces-active-unread"
      >
        {t("spaces.activeUnavailable")}
      </p>
    {/if}

    <!-- Spaces 列表 -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each spaces as space, index (space.id)}
        <div
          class="space-card p-4 rounded-lg border-2 transition-all cursor-pointer {currentIndex === index
            ? 'border-blue-600 bg-blue-50 dark:bg-blue-950'
            : 'border-neutral-300 dark:border-neutral-700 hover:border-neutral-400 dark:hover:border-neutral-600'}"
          role="button"
          tabindex="0"
          onclick={() => handleSwitch(index)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleSwitch(index);
            }
          }}
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
            <div class="flex gap-2">
              <button
                onclick={(e) => {
                  e.stopPropagation();
                  saveEdit(space.id);
                }}
                class="flex-1 px-2 py-1 bg-green-600 text-white rounded text-sm"
              >
                {t("spaces.save")}
              </button>
              <button
                onclick={(e) => {
                  e.stopPropagation();
                  cancelEdit();
                }}
                class="flex-1 px-2 py-1 bg-neutral-600 text-white rounded text-sm"
              >
                {t("spaces.cancel")}
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
                title={t("spaces.rename")}
              >
                ✏️
              </button>
            </div>

            <!-- 窗口数量 -->
            <div class="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
              {t("spaces.windowCount", { n: space.windows.length })}
            </div>

            <!-- 操作按钮 -->
            <div class="flex gap-2">
              {#if currentIndex === index}
                <div class="flex-1 px-2 py-1 bg-blue-600 text-white text-center rounded text-sm">
                  {t("spaces.currentDesktop")}
                </div>
              {:else}
                <button
                  onclick={(e) => {
                    e.stopPropagation();
                    handleSwitch(index);
                  }}
                  class="flex-1 px-2 py-1 bg-neutral-600 hover:bg-neutral-700 text-white rounded text-sm"
                >
                  {t("spaces.switch")}
                </button>
              {/if}
              <button
                onclick={(e) => {
                  e.stopPropagation();
                  handleDelete(space.id);
                }}
                class="px-2 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-sm disabled:opacity-50"
                disabled={spaces.length <= 1}
                title={spaces.length <= 1 ? t("spaces.cannotDeleteLast") : t("spaces.delete")}
              >
                🗑️
              </button>
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Window filing (REQ-A449): the half of Spaces that had no UI at all — a window can be
         filed into a desktop, and the host's `switch_plan` then decides whether it stays on
         screen. Text lives in the dictionary, never here. -->
    <section class="mt-8" aria-labelledby="spaces-windows-heading">
      <h3
        id="spaces-windows-heading"
        class="font-medium mb-3 text-neutral-800 dark:text-neutral-200"
      >
        {t("spaces.windows")}
      </h3>
      <p class="text-sm text-neutral-600 dark:text-neutral-400 mb-3">{t("spaces.windowsHint")}</p>

      {#if windows === null}
        <p class="text-sm text-neutral-600 dark:text-neutral-400">
          {t("spaces.windowsUnavailable")}
        </p>
      {:else if windows.length === 0}
        <p class="text-sm text-neutral-600 dark:text-neutral-400">{t("spaces.noWindows")}</p>
      {:else}
        <ul class="space-y-2">
          {#each windows as w (w.label)}
            {@const shown = windowName(w.label, w.app, ext).text}
            <li
              class="flex items-center justify-between gap-3 p-3 rounded-lg bg-neutral-100 dark:bg-neutral-800"
            >
              <!-- REQ-A473: the *name* is the app's localized name (+ instance) while the
                   **value** sent to the host stays the window label — the label is the
                   routing identity (`spaces_move_window` addresses a window, not an app),
                   so the two must not be conflated in either direction. -->
              <span class="text-sm text-neutral-800 dark:text-neutral-200">{shown}</span>
              <select
                class="px-2 py-1 rounded border text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-900 border-neutral-300 dark:border-neutral-700 disabled:opacity-50"
                aria-label={t("spaces.assignWindow", { label: shown })}
                value={spaceOfWindow(w.label) ?? ""}
                disabled={assigning !== null}
                onchange={(e) => void handleAssignWindow(w.label, e.currentTarget.value)}
              >
                <!-- Choosing this **is** the unfiled state (the window then belongs to every
                     desktop) — a real action, `spaces_unfile_window`, not a dead placeholder
                     (REQ-A450). -->
                <option value="">{t("spaces.unfiled")}</option>
                {#each spaces as s (s.id)}
                  <option value={s.id}>{s.name}</option>
                {/each}
              </select>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- 快捷键提示 -->
    <div class="mt-8 p-4 bg-neutral-100 dark:bg-neutral-800 rounded-lg">
      <h3 class="font-medium mb-3 text-neutral-800 dark:text-neutral-200">{t("spaces.shortcuts")}</h3>
      <!-- 弦全部来自实时绑定（REQ-A553）：被禁用的绑定不画 `<kbd>`，不假装有键。 -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
        <div class="flex justify-between">
          <span class="text-neutral-600 dark:text-neutral-400">{t("spaces.shortcutPrev")}</span>
          {#if hintPrev}<kbd data-testid="spaces-hint-prev" class="px-2 py-1 bg-neutral-200 dark:bg-neutral-700 rounded">{hintPrev}</kbd>{/if}
        </div>
        <div class="flex justify-between">
          <span class="text-neutral-600 dark:text-neutral-400">{t("spaces.shortcutNext")}</span>
          {#if hintNext}<kbd data-testid="spaces-hint-next" class="px-2 py-1 bg-neutral-200 dark:bg-neutral-700 rounded">{hintNext}</kbd>{/if}
        </div>
        <div class="flex justify-between">
          <span class="text-neutral-600 dark:text-neutral-400">{t("spaces.shortcutDirect")}</span>
          {#if hintDirect}<kbd data-testid="spaces-hint-direct" class="px-2 py-1 bg-neutral-200 dark:bg-neutral-700 rounded">{hintDirect}</kbd>{/if}
        </div>
        <div class="flex justify-between">
          <span class="text-neutral-600 dark:text-neutral-400">{t("spaces.shortcutMission")}</span>
          {#if hintMission}<kbd data-testid="spaces-hint-mission" class="px-2 py-1 bg-neutral-200 dark:bg-neutral-700 rounded">{hintMission}</kbd>{/if}
        </div>
        <div class="flex justify-between">
          <span class="text-neutral-600 dark:text-neutral-400">{t("spaces.shortcutPanel")}</span>
          {#if hintPanel}<kbd data-testid="spaces-hint-panel" class="px-2 py-1 bg-neutral-200 dark:bg-neutral-700 rounded">{hintPanel}</kbd>{/if}
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

  /* REQ-A331: a component <style> block is **outside** Tailwind's
     `hoverOnlyWhenSupported`, so a bare `:hover` here is a sticky-hover regression on touch
     (the tile stays lifted after a tap). Scoped like the dock magnifier in `index.css`. */
  @media (hover: hover) {
    .space-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }
  }

  kbd {
    font-family: ui-monospace, monospace;
    font-size: 0.875rem;
  }
</style>
