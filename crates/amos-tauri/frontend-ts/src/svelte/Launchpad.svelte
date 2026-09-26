<script lang="ts">
  // Launchpad.svelte — macOS Launchpad 全屏覆盖层。
  //
  // 桌面形态下，它是一个**注册表里的浮层**：`shellModules.ts` 的 `launchpad` 行（F4）决定
  // 它什么时候被渲染，`DesktopShell` 渲染它并把 `onclose` 传进来。入口有三个（顶栏 🚀、
  // Dock 🚀、F4），三个都汇到壳的同一个意图上。
  // 不创建新的 OS 窗口，而是作为 DesktopShell 内部的浮层叠加（`z-50`）。
  //
  // 行为：
  //   - 点击空白区域 / Esc 键 → 关闭
  //   - 顶部搜索框（实时过滤应用）
  //   - 自适配列数网格 + 80px 图标
  //   - 编辑模式：点击"编辑"按钮 → app 图标出现减号，点击可从 Dock 隐藏
  //
  // 数据：实时读 home layout（page + dock，去重） + 已安装的商店应用 → `lib/appLookup`
  // 解析出名字与图标（内置注册表 / 商店瓷砖，一个属主）。
  import { getContext, onMount } from "svelte";
  import { announceAppOpened } from "../lib/shortcuts";
  import { APP_META } from "../lib/appMeta";
  import { iconForId, isDrawableApp, nameForId } from "../lib/appLookup";
  import { getStoreTiles, type StoreTile } from "../lib/storeApps";
  import { SHELL_CHROME_API, type ShellChromeApi } from "../lib/shellModule";
  import { LAYOUT_KEY, type HomeLayout, getLayout, restoreToHome, writeStoreValueChecked } from "../lib/amosStore";
  import { withoutPhone } from "../lib/phoneApps";
  import { launchpadCols, launchpadRows, LAUNCHPAD_COLS_DEFAULT, LAUNCHPAD_ROWS_DEFAULT, LAUNCHPAD_ICON_SIZE, LAUNCHPAD_ICON_GAP } from "../lib/desktopLayout";
  import { GLASS_LAUNCHPAD_STYLE } from "../lib/shellChrome";
  import { t } from "./locale.svelte";
  import { wmLayoutSnapshot, wmOpenWithDiag } from "../lib/wm";
  import { installGridKeyboard } from "../lib/overviewKeys";
  import { createStoreValue } from "./store";
  import StoreErrorBar from "./StoreErrorBar.svelte";

  // 关闭由**壳**决定：浮层从注册表渲染（`DesktopShell`），壳把 `onclose` 传进来。
  // 旧写法是 `createEventDispatcher` + `on:close`，而注册表驱动的渲染无法为每一行
  // 单独绑定事件——而且 Svelte 5 里 `$on()` 已移除，测试也订阅不到。改成 props 之后
  // 浮层可以脱离壳单独挂载（这正是"每个浮层可独立交付"的前提）。
  let { onclose }: { onclose?: () => void } = $props();

  // ─── 布局参数（自适配窗口尺寸）──────────────────────────────────────────────
  // Start from the module's documented defaults (the wide-screen design values),
  // then let the host's measured screen decide. Writing 8/5 here again would be a
  // second copy of the same numbers — and the copy is the one nobody remembers to edit.
  let cols = $state(LAUNCHPAD_COLS_DEFAULT);
  let rows = $state(LAUNCHPAD_ROWS_DEFAULT);

  $effect(() => {
    void wmLayoutSnapshot().then((s) => {
      if (s) {
        cols = launchpadCols(s.screen_w);
        rows = launchpadRows(s.screen_h);
      }
    });
  });

  // ─── 真实 app 列表（用户的 home layout 优先，再追加所有内置 app）──────────────
  const layoutStore = createStoreValue<HomeLayout>(LAYOUT_KEY, getLayout(APP_META.map((a) => a.id)));
  let layout = $state<HomeLayout>(getLayout(APP_META.map((a) => a.id)));
  /** 存储拒写时那一句（`StoreErrorBar` 唯一的内容源，与 Dock ∕ 其他内容屏同一枚 testid）。 */
  let storeError = $state<string>("");
  $effect(() => {
    const un = layoutStore.subscribe((v) => {
      if (v && v.page) layout = v;
    });
    return un;
  });

  // 所有 app 的可见 id（page + dock 去重 + 内置 APP_META）
  // 桌面形态下，电话类 app 不显示（无 SIM / 蜂窝）。
  //
  // REQ-A461：**隐藏的 app 必须真的不出现**。这里的第二个循环会把 APP_META 里
  // `seen` 之外的 id 全部追加回来，而 `layout.hidden` 从来没进过 `seen` —— 于是
  // 编辑模式里点「−」（`hideApp` 写 `hidden`）在**本面板里什么都不会发生**（图标
  // 照旧在那），却悄悄把触屏主屏上的该 app 拿掉了；桌面上又没有还原入口 ⇒ 一个
  // 「看得见、点得动、没反应」的控件 + 一扇只能进不能出的门（F-SH-001 / F-DEV-039）。
  // 把 hidden 预先并进 `seen`，两个循环就都不会再把它们加回来。
  // REQ-A1179：这里原先是 `appTitleKey(id)` 作为过滤条件（只认内置 app），于是用户在触屏
  // 主屏上拖进 page/dock 的商店应用在桌面上**整个消失**。瓷砖列表由壳推下来
  // （`SHELL_CHROME_API.storeTiles`，getter ⇒ 保持活）；单独渲染本组件时回退到模块缓存。
  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);
  const ext = $derived<readonly StoreTile[]>(api?.storeTiles ?? getStoreTiles());
  const visibleIds = $derived.by(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of withoutPhone(layout.hidden)) seen.add(id);
    for (const id of withoutPhone([...layout.page, ...layout.dock])) {
      if (!seen.has(id) && isDrawableApp(id, ext)) {
        seen.add(id);
        ids.push(id);
      }
    }
    for (const a of withoutPhone(APP_META.map((m) => m.id))) {
      if (!seen.has(a)) {
        seen.add(a);
        ids.push(a);
      }
    }
    // 已安装但**还没被放上去**的商店应用也属于这里：macOS 的启动台列出**每一个**已安装的
    // 应用，触屏侧的「App 资源库」同样列出它们。少了这一条，用户装了应用却在桌面上无处可开。
    for (const tile of ext) {
      if (!seen.has(tile.id)) {
        seen.add(tile.id);
        ids.push(tile.id);
      }
    }
    return ids;
  });

  // 编辑模式里的「已隐藏」行 —— 隐藏动作的**逆操作**。没有它，桌面形态下从
  // Launchpad 隐藏一个 app 就再也拿不回来（触屏形态有 `EditHome` 的 ＋ 行）。
  const hiddenIds = $derived.by(() =>
    withoutPhone(layout.hidden.filter((id) => isDrawableApp(id, ext))),
  );

  // ─── 搜索 ──────────────────────────────────────────────────────────────────
  let search = $state("");
  const filteredIds = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!q) return visibleIds;
    return visibleIds.filter((id) => {
      const name = nameForId(id, ext, t).toLowerCase();
      return name.includes(q) || id.toLowerCase().includes(q);
    });
  });

  // ─── 编辑模式 ──────────────────────────────────────────────────────────────
  let editMode = $state(false);

  function toggleEdit() {
    editMode = !editMode;
  }

  // ─── 打开应用 ──────────────────────────────────────────────────────────────
  //
  // REQ-A297 phase-2 §4 (typed error discipline): `invoke` swallows
  // failures into `null` (REQ-A296 / `lib/backend.ts`), so a bare
  // `await invoke(...)` always resolves. The earlier `try/catch` was
  // dead code — it could never fire — and a silently-failed `wm_open`
  // made the icon look unresponsive ("click an app, nothing happens").
  // We now branch on the null result and write a diagnostic the UI can
  // surface via `bridgeDiag("wm_open")`.

  async function openApp(id: string) {
    const r = await wmOpenWithDiag(id);
    if (r.ok) {
      // An app really opened → tell the automation runtime (`app` triggers). Every
      // desktop launcher announces here, so `shellState.open` is not the only path.
      announceAppOpened(id);
      onclose?.();
      return;
    }
    // The command ran but the host refused (or the bridge was offline).
    // The earlier `try/catch` was dead code — `invoke` swallows rejections
    // into `null` per REQ-A296. The user used to see a dead launcher; now
    // we keep a breadcrumb and decide closure from the typed outcome.
    const diag = r.diag;
    if (diag.ok) {
      // Last command succeeded but result was null? Invariant violation —
      // close out of caution.
      onclose?.();
      return;
    }
    // Extract a typed error code (only present on command-failed outcomes);
    // the empty `not-bridged` shape also encodes "the daemon is gone".
    const code =
      diag.kind === "command-failed" &&
      diag.detail &&
      typeof diag.detail === "object"
        ? (diag.detail as { code?: string }).code
        : undefined;
    console.warn(`[Launchpad] wm_open(${id}) refused`, code ?? diag.kind);
    // Host refused: keep the panel open so the user can pick another app.
    // Offline (or any other failure path): close — staying on a dead modal
    // over a broken backend isn't useful.
    if (diag.kind === "not-bridged") onclose?.();
  }

  /**
   * 把一份新布局落盘，**并读**存储的裁决（REQ-A1346 / FMEA F-SH-611）。
   *
   * 原先两处都写作 `layout = next; saveLayout(next);` —— `saveLayout` 签 `void` 而里面
   * 的 `writeJson` **有**返回值（存储满 ∕ 不可用时为 false，并记一条 `amosError`），于是
   * 记忆里的 `layout` 先改了、屏幕跟着画，而盘上还是旧的：重启（或另一次重读）之后被
   * 「隐藏」的 app 又回来了，中间没有一句话。**同一个键**（`amos.home.layout`）的另一个
   * 写者 —— Dock 的拖拽排序 —— 早就走 `writeStoreValueChecked` + `StoreErrorBar`，并在
   * 被拒时保持内存里的旧顺序；这里漏了。
   *
   * 与 Dock 同一条纪律：写不进去就**不动**内存、如实说。
   */
  function commitLayout(next: HomeLayout): void {
    if (!writeStoreValueChecked(LAYOUT_KEY, next)) {
      storeError = t("common.storeWriteFailed");
      return;
    }
    storeError = "";
    layout = next;
  }

  // ─── 隐藏 app（编辑模式：从 home layout 中删除，落盘）───────────────────────
  function hideApp(id: string) {
    commitLayout({
      page: layout.page.filter((x) => x !== id),
      dock: layout.dock.filter((x) => x !== id),
      hidden: [...layout.hidden.filter((x) => x !== id), id],
    });
  }

  // ─── 还原 app（编辑模式：「已隐藏」行里的 ＋）───────────────────────────────
  // 与触屏形态的 `EditHome` 用同一个纯函数，所以「隐藏 → 还原」在两种形态下
  // 不可能给出两种结果（`restoreToHome` 把 id 放回 page 末尾并移出 hidden）。
  function restoreApp(id: string) {
    commitLayout(restoreToHome(layout, id));
  }

  // ─── 键盘处理：Esc 关闭 ───────────────────────────────────────────────────
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      onclose?.();
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // ─── 方向键走图标网格 ─────────────────────────────────────────────────────
  // macOS 的 Launchpad 是全键盘可驱动的（方向键在图标之间走，Return 打开）。此前这里
  // 只有 Tab 与 Escape：Tab 能到每一块瓷砖（WCAG 2.1.1 满足），于是没有一个门禁会注意
  // 到四个方向键按下去什么也不做 —— 与两个窗口总览面板同一族（REQ-A1024）。
  // 复用同一个属主（`lib/overviewKeys`）：网格是**均匀换行**的（没有行元素），所以用
  // `installGridKeyboard` 从列数推出每行长度，判定仍是同一个 `nextOverviewCell`。
  // `cols` 在这里被读到 ⇒ 窗口尺寸变化导致列数变化时，这个 `$effect` 会重新接线。
  let gridEl = $state<HTMLElement | null>(null);
  $effect(() => installGridKeyboard(gridEl, cols));
</script>

<!--
  Launchpad 全屏覆盖：
  - 深色毛玻璃背景（macOS Big Sur+ 风格）
  - 顶部标题 "Launchpad" + 搜索框 + 编辑按钮
  - 应用网格（自适配列数）
  - 点击应用图标 → wm_open(id) → 关闭 Launchpad
  - 方向键在图标网格里走（←/→ 行内回环、↑/↓ 换行保列，由 `lib/overviewKeys` 驱动）；
    在搜索框里打字时这套键让位给光标
  - 编辑模式：减号角标 → 点击 → 从 home 移除
  - Esc / 点击空白区域 关闭
-->
<div
  class="pointer-events-none fixed inset-0 z-50 flex flex-col overflow-hidden"
  data-testid="launchpad-overlay"
  style={GLASS_LAUNCHPAD_STYLE}
>
  <!-- 存储拒写时的那一句（与 Dock ∕ 其他内容屏用同一枚 testid 的共用组件） -->
  <div class="absolute inset-x-0 top-0 z-20 flex justify-center px-4 pt-2 pointer-events-none">
    <div class="pointer-events-auto">
      <StoreErrorBar message={storeError} />
    </div>
  </div>

  <!-- 点击空白区域关闭（pointer-events-auto 的子元素除外） -->
  <div
    class="pointer-events-auto absolute inset-0"
    role="presentation"
    aria-hidden="true"
    onclick={(e) => {
      if (e.target === e.currentTarget) onclose?.();
    }}
    onkeydown={() => { /* no-op; close via keyboard is handled at the document level */ }}
  ></div>

  <!-- 内容区（pointer-events-auto） -->
  <div
    class="pointer-events-none relative z-10 flex h-full flex-col items-center overflow-hidden pt-12"
  >
    <!-- 顶部标题 + 搜索 + 编辑 -->
    <div class="pointer-events-auto flex w-full flex-col items-center gap-4 px-8">
      <h1
        class="pt-6 text-[26px] font-semibold tracking-tight text-white"
        style="text-shadow: 0 2px 12px rgba(0,0,0,0.5);"
      >
        {t("desktop.launchpad")}
      </h1>

      <!-- 搜索框 -->
      <div
        class="relative flex w-full max-w-md items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2"
      >
        <span class="text-sm text-white/50">🔍</span>
        <input
          type="text"
          placeholder={t("desktop.search")}
          bind:value={search}
          class="flex-1 border-none bg-transparent text-[15px] text-white placeholder-white/40 outline-none"
          aria-label={t("desktop.search")}
        />
        {#if search}
          <button
            class="text-sm text-white/50 hover:text-white/80"
            aria-label={t("desktop.clear")}
            onclick={() => (search = "")}
          >✕</button>
        {/if}
      </div>

      <!-- 编辑按钮 -->
      <button
        class="pointer-events-auto rounded-full border border-white/15 bg-white/10 px-5 py-1 text-[13px] font-medium text-white/80 shadow-sm transition-all hover:border-white/25 hover:bg-white/15 hover:text-white active:scale-95"
        onclick={toggleEdit}
        aria-pressed={editMode}
      >
        {editMode ? t("desktop.done") : t("desktop.edit")}
      </button>
    </div>

    <!-- 应用网格 -->
    <div
      bind:this={gridEl}
      class="pointer-events-auto mt-6 flex flex-wrap justify-center gap-x-6 gap-y-8 overflow-y-auto px-8 pb-8"
      style="
        width: {cols * (LAUNCHPAD_ICON_SIZE + LAUNCHPAD_ICON_GAP) + 32}px;
        max-height: {rows * (LAUNCHPAD_ICON_SIZE + LAUNCHPAD_ICON_GAP + 32)}px;
      "
      role="grid"
      aria-label={t("desktop.launchpad")}
    >
      {#each filteredIds as id (id)}
        <button
          class="group flex flex-col items-center gap-2"
          onclick={() => editMode ? hideApp(id) : openApp(id)}
          aria-label={nameForId(id, ext, t)}
        >
          <!-- 应用图标 -->
          <div class="relative">
            <span
              class="flex items-center justify-center rounded-[22px] bg-gradient-to-br from-neutral-700 to-neutral-900 shadow-xl transition-transform group-hover:-translate-y-1 group-active:scale-90"
              style="
                width:{LAUNCHPAD_ICON_SIZE}px;
                height:{LAUNCHPAD_ICON_SIZE}px;
                font-size:{Math.round(LAUNCHPAD_ICON_SIZE * 0.6)}px;
                border: 1px solid rgba(255,255,255,0.1);
                box-shadow: 0 4px 16px rgba(0,0,0,0.4);
              "
            >
              {iconForId(id, ext)}
            </span>

            <!-- 编辑模式：减号删除标记 -->
            {#if editMode}
              <span
                class="absolute -left-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-danger-solid text-[10px] font-bold text-white shadow-md"
                style="border: 1.5px solid rgba(255,255,255,0.2);"
                aria-hidden="true"
              >−</span>
            {/if}
          </div>

          <!-- 应用名称 -->
          <span
            class="max-w-full truncate text-center text-[11px] leading-tight text-white/80"
            style="width:{LAUNCHPAD_ICON_SIZE}px;"
          >
            {nameForId(id, ext, t)}
          </span>
        </button>
      {/each}

      <!-- 无结果提示 -->
      {#if filteredIds.length === 0}
        <p class="mt-12 text-[15px] text-white/40">{t("desktop.noResults")}</p>
      {/if}
    </div>

    <!-- 编辑模式：已隐藏的 app + 还原（隐藏的逆操作，REQ-A461） -->
    {#if editMode && hiddenIds.length > 0}
      <div class="pointer-events-auto mt-8 flex flex-col items-center gap-2">
        <p class="text-[11px] text-white/40">{t("edit.hidden")}</p>
        <div class="flex flex-wrap justify-center gap-2">
          {#each hiddenIds as id (id)}
            <button
              class="flex items-center gap-1 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] text-white/80 transition-colors hover:border-white/25 hover:bg-white/15"
              onclick={() => restoreApp(id)}
            >
              ＋ {nameForId(id, ext, t)}
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>
