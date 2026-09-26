<script lang="ts">
  // KeyboardPage.svelte — 「键盘快捷键」设置子页面（Phase 2）。
  //
  // Apple 风格：分组展示所有系统快捷键，支持点击编辑、冲突检测与重置。
  //
  // 功能：
  //   1. 按功能分组展示所有快捷键（只读模式）
  //   2. 点击快捷键徽章进入编辑模式
  //   3. 按下新键捕获并实时预览
  //   4. 冲突检测（保存前检查）
  //   5. 重置为默认值
  //   6. 导入/导出配置
  //
  // 数据源：
  //   1. 浮层快捷键 —— `shellModules.ts` 注册表（F4 / ⌘Space / F3 / ⌘Tab）
  //   2. 系统快捷键 —— `keyboardConfigHook.svelte` 的 SYSTEM_DEFAULTS（⌘W / ⌘M / ⌘H / ⌘,）
  //   3. Spaces 快捷键 —— `keyboardConfigHook.svelte` 的 SPACES_DEFAULTS（Ctrl+1-9 / Ctrl+←→↑）
  //   4. 触屏快捷键 —— `lib/keyboardConfig.ts` TOUCH_DEFAULTS（⌘[ / Esc / ⌘,）
  //
  // 所有分类与标签都来自 i18n（`settings.keyboard.*`），不内联任何文本。
  import { t } from "../locale.svelte";
  import { SHELL_MODULES } from "../shellModules";
  import {
    modulesFor,
    formatShortcut,
    type ShellShortcut,
  } from "../../lib/shellModule";
  import {
    readKeyboardConfig,
    writeKeyboardConfig,
    resetKeyboardConfig,
    detectConflicts,
    exportConfig,
    importConfig,
    eventToShortcut,
  } from "../../lib/keyboardConfig";
  // 默认值是**引擎那一份**（`keyboardConfigHook` 导出）。这里曾把三张表逐字再抄一遍
  // （同一个键、同一个修饰符，只是包成了数组）—— 那是典型的两处真相：改引擎默认值时
  // 设置页会继续显示旧键，而"用户没改过"的行会按旧默认值写回配置。
  import {
    SYSTEM_DEFAULTS,
    SPACES_DEFAULTS,
    TOUCH_DEFAULTS,
  } from "../../lib/keyboardConfigHook.svelte";
  import { GROUP, SUB } from "./kit";

  // ─── 类型定义 ─────────────────────────────────────────────────────────────
  /** 可编辑的快捷键行。 */
  interface EditableShortcutRow {
    id: string;
    category: "overlay" | "system" | "spaces" | "touch";
    labelKey: string;
    currentKeys: string;
    shortcuts: ShellShortcut[];
    disabled: boolean;
  }

  /** 快捷键分组。 */
  interface ShortcutSection {
    titleKey: string;
    rows: EditableShortcutRow[];
  }

  // ─── 系统默认快捷键定义 ──────────────────────────────────────────────────
  // 见上面的 import：这三张表来自引擎（`keyboardConfigHook`），本文件不再自带副本。

  // ─── 从注册表生成浮层快捷键 ─────────────────────────────────────────────
  function buildOverlayRows(): EditableShortcutRow[] {
    const overlays = modulesFor("overlay", SHELL_MODULES);
    const config = readKeyboardConfig();
    return overlays
      .filter((m) => m.shortcuts && m.shortcuts.length > 0)
      .map((m) => {
        const custom = config.overlays[m.id];
        // custom is `undefined` = no override, `null` = user-disabled, `[]` = cleared.
        const shortcuts: ShellShortcut[] =
          custom !== undefined && custom !== null ? custom : [...(m.shortcuts ?? [])];
        const disabled = custom === null;
        return {
          id: m.id,
          category: "overlay" as const,
          labelKey: m.titleKey,
          currentKeys: shortcuts.length > 0 ? shortcuts.map((s) => formatShortcut(s)).join(" / ") : "—",
          shortcuts,
          disabled,
        };
      });
  }

  function buildSystemRows(): EditableShortcutRow[] {
    const config = readKeyboardConfig();
    return Object.entries(SYSTEM_DEFAULTS).map(([id, defaults]) => {
      const custom = config.system[id];
      const shortcuts: ShellShortcut[] = custom !== undefined ? (custom ? [custom] : []) : [defaults];
      const disabled = custom === null;
      const first = shortcuts[0];
      return {
        id,
        category: "system" as const,
        labelKey: `settings.keyboard.${id}`,
        currentKeys: first ? formatShortcut(first) : "—",
        shortcuts,
        disabled,
      };
    });
  }

  function buildSpacesRows(): EditableShortcutRow[] {
    const config = readKeyboardConfig();
    return Object.entries(SPACES_DEFAULTS).map(([id, defaults]) => {
      const custom = config.spaces[id];
      const shortcuts: ShellShortcut[] = custom !== undefined ? (custom ? [custom] : []) : [defaults];
      const disabled = custom === null;
      const first = shortcuts[0];
      return {
        id,
        category: "spaces" as const,
        labelKey: `settings.keyboard.${id}`,
        currentKeys: first ? formatShortcut(first) : "—",
        shortcuts,
        disabled,
      };
    });
  }

  function buildTouchRows(): EditableShortcutRow[] {
    const config = readKeyboardConfig();
    return Object.entries(TOUCH_DEFAULTS).map(([id, defaults]) => {
      const custom = config.touch[id];
      const shortcuts: ShellShortcut[] = custom !== undefined ? (custom ? [custom] : []) : [defaults];
      const disabled = custom === null;
      const first = shortcuts[0];
      return {
        id,
        category: "touch" as const,
        labelKey: `settings.keyboard.${id}`,
        currentKeys: first ? formatShortcut(first) : "—",
        shortcuts,
        disabled,
      };
    });
  }

  // ─── 分组构建 ─────────────────────────────────────────────────────────────
  function buildSections(): ShortcutSection[] {
    const overlayRows = buildOverlayRows();
    const systemRows = buildSystemRows();
    const spacesRows = buildSpacesRows();
    const touchRows = buildTouchRows();

    return [
      { titleKey: "settings.keyboard.sectionLaunchpad", rows: overlayRows },
      { titleKey: "settings.keyboard.sectionSpaces", rows: spacesRows },
      { titleKey: "settings.keyboard.sectionWindow", rows: systemRows },
      { titleKey: "settings.keyboard.sectionTouch", rows: touchRows },
    ].filter((sec) => sec.rows.length > 0);
  }

  // ─── 状态 ────────────────────────────────────────────────────────────────
  let sections = $state(buildSections());
  let searchQuery = $state("");
  let editingId = $state<string | null>(null);
  let editingCategory = $state<"overlay" | "system" | "spaces" | "touch" | null>(null);
  let recordingKey = $state<ShellShortcut | null>(null);
  let conflictWarning = $state<string | null>(null);
  let showResetConfirm = $state(false);
  let showExportPanel = $state(false);
  let showImportPanel = $state(false);
  let importText = $state("");
  let importError = $state<string | null>(null);
  let savedMessage = $state(false);
  let saveFailed = $state(false);
  /** The failed-write note stays up longer than the success one: it asks the user to act. */
  const FAIL_MS = 4000;

  /**
   * Publish the result of a write instead of assuming it landed (F-SH-043).
   *
   * `writeKeyboardConfig` answers whether the value reached the store
   * (`writeStoreValueChecked` → `writeJson`, which also logs `amosError` when storage is full or
   * unavailable). This page used to discard that answer and show the green 「已保存」 toast
   * unconditionally: with a refusing store the user was told their rebind was saved while
   * `buildSections()` re-read the *old* config — the row kept the old chord and the toast said
   * otherwise. The repo's `write-scan` gate exempts *config* keys ("they carry no claim about the
   * user's content"), and that exemption is exactly what this page broke: it does make a claim.
   */
  function reportWrite(landed: boolean): boolean {
    if (landed) {
      savedMessage = true;
      setTimeout(() => (savedMessage = false), 2000);
    } else {
      saveFailed = true;
      setTimeout(() => (saveFailed = false), FAIL_MS);
    }
    return landed;
  }

  // ─── 注册表用于冲突检测 ──────────────────────────────────────────────────
  const registryMap = new Map<string, ShellShortcut[]>();
  for (const m of modulesFor("overlay", SHELL_MODULES)) {
    if (m.shortcuts) registryMap.set(m.id, [...m.shortcuts]);
  }
  // F-SH-045: the conflict check must see **every** table this page renders, not just the overlay
  // registry. The system / Spaces / touch rows come from their own default tables, and their *labels*
  // were already registered below while their **bindings** were not — so capturing ⌘W (关闭窗口's own
  // key, shown two rows further down) produced no warning at all: the page promised 「冲突的绑定将被
  // 警告」 and stayed silent for every non-overlay chord.
  for (const defaults of [SYSTEM_DEFAULTS, SPACES_DEFAULTS, TOUCH_DEFAULTS]) {
    for (const [id, shortcut] of Object.entries(defaults)) {
      registryMap.set(id, [shortcut]);
    }
  }

  const labelKeysMap = new Map<string, string>();
  for (const m of modulesFor("overlay", SHELL_MODULES)) {
    labelKeysMap.set(m.id, m.titleKey);
  }
  // 系统快捷键标签
  for (const [id] of Object.entries(SYSTEM_DEFAULTS)) {
    labelKeysMap.set(id, `settings.keyboard.${id}`);
  }
  for (const [id] of Object.entries(SPACES_DEFAULTS)) {
    labelKeysMap.set(id, `settings.keyboard.${id}`);
  }
  for (const [id] of Object.entries(TOUCH_DEFAULTS)) {
    labelKeysMap.set(id, `settings.keyboard.${id}`);
  }

  // ─── 过滤搜索 ────────────────────────────────────────────────────────────
  const filteredSections = $derived.by(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return sections;
    return sections
      .map((sec) => ({
        ...sec,
        rows: sec.rows.filter((row) => {
          const label = t(row.labelKey).toLowerCase();
          const keys = row.currentKeys.toLowerCase();
          return label.includes(needle) || keys.includes(needle);
        }),
      }))
      .filter((sec) => sec.rows.length > 0);
  });

  // ─── 编辑逻辑 ───────────────────────────────────────────────────────────
  function startEditing(row: EditableShortcutRow) {
    editingId = row.id;
    editingCategory = row.category;
    recordingKey = row.shortcuts[0] ?? null;
    conflictWarning = null;
    document.addEventListener("keydown", handleKeyCapture, { once: false });
  }

  function cancelEditing() {
    editingId = null;
    editingCategory = null;
    recordingKey = null;
    conflictWarning = null;
    document.removeEventListener("keydown", handleKeyCapture);
  }

  function handleKeyCapture(e: KeyboardEvent) {
    if (!editingId || !editingCategory) return;

    // 忽略单独的修饰键
    if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const shortcut = eventToShortcut(e);
    recordingKey = shortcut;

    // 实时冲突检测
    const config = readKeyboardConfig();
    const tempConfig = { ...config };

    if (editingCategory === "overlay") {
      tempConfig.overlays = { ...config.overlays, [editingId]: [shortcut] };
    } else if (editingCategory === "system") {
      tempConfig.system = { ...config.system, [editingId]: shortcut };
    } else if (editingCategory === "spaces") {
      tempConfig.spaces = { ...config.spaces, [editingId]: shortcut };
    } else if (editingCategory === "touch") {
      tempConfig.touch = { ...config.touch, [editingId]: shortcut };
    }

    const conflicts = detectConflicts(tempConfig, registryMap, labelKeysMap);
    const thisConflict = conflicts.find((c) =>
      c.usedBy.some((u) => u.id === editingId)
    );

    if (thisConflict && thisConflict.usedBy.length > 1) {
      const others = thisConflict.usedBy
        .filter((u) => u.id !== editingId)
        .map((u) => t(u.labelKey))
        .join(", ");
      conflictWarning = t("settings.keyboard.conflictWith", { others });
    } else {
      conflictWarning = null;
    }
  }

  function saveShortcut() {
    if (!editingId || !editingCategory) return;

    const config = readKeyboardConfig();

    if (editingCategory === "overlay") {
      config.overlays = {
        ...config.overlays,
        [editingId]: recordingKey ? [recordingKey] : null,
      };
    } else if (editingCategory === "system") {
      config.system = {
        ...config.system,
        [editingId]: recordingKey,
      };
    } else if (editingCategory === "spaces") {
      config.spaces = {
        ...config.spaces,
        [editingId]: recordingKey,
      };
    } else if (editingCategory === "touch") {
      config.touch = {
        ...config.touch,
        [editingId]: recordingKey,
      };
    }

    reportWrite(writeKeyboardConfig(config));
    sections = buildSections();
    cancelEditing();
  }

  function disableShortcut(id: string, category: "overlay" | "system" | "spaces" | "touch") {
    const config = readKeyboardConfig();
    if (category === "overlay") {
      config.overlays = { ...config.overlays, [id]: null };
    } else if (category === "system") {
      config.system = { ...config.system, [id]: null };
    } else if (category === "spaces") {
      config.spaces = { ...config.spaces, [id]: null };
    } else if (category === "touch") {
      config.touch = { ...config.touch, [id]: null };
    }
    reportWrite(writeKeyboardConfig(config));
    sections = buildSections();
  }

  function resetAll() {
    reportWrite(resetKeyboardConfig());
    sections = buildSections();
    showResetConfirm = false;
  }

  function handleExport() {
    const config = readKeyboardConfig();
    const json = exportConfig(config);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "amos-keyboard-config.json";
    a.click();
    URL.revokeObjectURL(url);
    showExportPanel = false;
  }

  function handleImport() {
    const result = importConfig(importText);
    if ("error" in result) {
      importError = result.error;
      return;
    }
    // The import path was the third site the rule found (REQ-A492): closing the panel and clearing the
    // text **before knowing whether the config was stored** told the user the import had been applied.
    // On a refused write the panel stays open with the reason, so the text can be retried.
    if (!reportWrite(writeKeyboardConfig(result))) {
      importError = t("settings.keyboard.saveFailed");
      return;
    }
    sections = buildSections();
    showImportPanel = false;
    importText = "";
    importError = null;
  }
</script>

<div class="space-y-5">
  <!-- 保存成功消息 -->
  {#if saveFailed}
    <div
      class="fixed top-4 right-4 z-50 rounded-lg bg-red-500 px-4 py-2 text-sm text-white shadow-lg"
      role="alert"
    >
      {t("settings.keyboard.saveFailed")}
    </div>
  {/if}
  {#if savedMessage}
    <div class="fixed top-4 right-4 z-50 rounded-lg bg-green-500 px-4 py-2 text-sm text-white shadow-lg">
      {t("settings.keyboard.saved")}
    </div>
  {/if}

  <!-- 说明文本 -->
  <p class="px-1 text-[13px] leading-relaxed opacity-60">
    {t("settings.keyboard.hintPhase2")}
  </p>

  <!-- 工具栏 -->
  <div class="flex items-center justify-between gap-3">
    <!-- 搜索框 -->
    <div class="relative flex-1">
      <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm opacity-40">🔍</span>
      <input
        bind:value={searchQuery}
        type="search"
        placeholder={t("settings.keyboard.searchPlaceholder")}
        aria-label={t("settings.keyboard.searchPlaceholder")}
        class="w-full rounded-[10px] bg-black/5 py-2 pl-9 pr-3 text-sm outline-none dark:bg-white/10"
      />
    </div>

    <!-- 操作按钮 -->
    <div class="flex gap-2">
      <button
        onclick={() => (showExportPanel = true)}
        class="rounded-[10px] bg-black/5 px-3 py-2 text-xs opacity-70 hover:opacity-100 dark:bg-white/10"
      >
        {t("settings.keyboard.export")}
      </button>
      <button
        onclick={() => (showImportPanel = true)}
        class="rounded-[10px] bg-black/5 px-3 py-2 text-xs opacity-70 hover:opacity-100 dark:bg-white/10"
      >
        {t("settings.keyboard.import")}
      </button>
      <button
        onclick={() => (showResetConfirm = true)}
        class="rounded-[10px] bg-black/5 px-3 py-2 text-xs opacity-70 hover:opacity-100 dark:bg-white/10"
      >
        {t("settings.keyboard.resetAll")}
      </button>
    </div>
  </div>

  <!-- 重置确认对话框 -->
  {#if showResetConfirm}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div class="w-[80%] max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-neutral-800">
        <h3 class="mb-3 text-[17px] font-semibold">{t("settings.keyboard.resetConfirmTitle")}</h3>
        <p class="mb-4 text-sm opacity-70">{t("settings.keyboard.resetConfirmMsg")}</p>
        <div class="flex justify-end gap-2">
          <button
            onclick={() => (showResetConfirm = false)}
            class="rounded-lg px-4 py-2 text-sm opacity-70 hover:opacity-100"
          >
            {t("settings.keyboard.cancel")}
          </button>
          <button
            onclick={resetAll}
            class="rounded-lg bg-red-500 px-4 py-2 text-sm text-white"
          >
            {t("settings.keyboard.reset")}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- 导出面板 -->
  {#if showExportPanel}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div class="w-[80%] max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-neutral-800">
        <h3 class="mb-3 text-[17px] font-semibold">{t("settings.keyboard.exportTitle")}</h3>
        <p class="mb-4 text-sm opacity-70">{t("settings.keyboard.exportDesc")}</p>
        <div class="flex justify-end gap-2">
          <button
            onclick={() => (showExportPanel = false)}
            class="rounded-lg px-4 py-2 text-sm opacity-70 hover:opacity-100"
          >
            {t("settings.keyboard.cancel")}
          </button>
          <button
            onclick={handleExport}
            class="rounded-lg bg-blue-500 px-4 py-2 text-sm text-white"
          >
            {t("settings.keyboard.download")}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- 导入面板 -->
  {#if showImportPanel}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div class="w-[80%] max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-neutral-800">
        <h3 class="mb-3 text-[17px] font-semibold">{t("settings.keyboard.importTitle")}</h3>
        <textarea
          bind:value={importText}
          placeholder={t("settings.keyboard.importPlaceholder")}
          rows="6"
          class="mb-3 w-full rounded-lg bg-black/5 p-3 text-xs dark:bg-white/10"
        ></textarea>
        {#if importError}
          <p class="mb-3 text-xs text-red-500">{importError}</p>
        {/if}
        <div class="flex justify-end gap-2">
          <button
            onclick={() => { showImportPanel = false; importText = ""; importError = null; }}
            class="rounded-lg px-4 py-2 text-sm opacity-70 hover:opacity-100"
          >
            {t("settings.keyboard.cancel")}
          </button>
          <button
            onclick={handleImport}
            class="rounded-lg bg-blue-500 px-4 py-2 text-sm text-white"
          >
            {t("settings.keyboard.importBtn")}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- 快捷键列表 -->
  {#if filteredSections.length === 0}
    <p class="px-1 py-8 text-center text-sm opacity-50">
      {t("settings.keyboard.noResults")}
    </p>
  {:else}
    {#each filteredSections as section (section.titleKey)}
      <section>
        <h3 class="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide opacity-50">
          {t(section.titleKey)}
        </h3>
        <div class={GROUP}>
          {#each section.rows as row, i (row.id)}
            {@const isEditing = editingId === row.id}
            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <span class="text-[15px]">{t(row.labelKey)}</span>
              <div class="flex items-center gap-2">
                {#if isEditing}
                  <!-- 编辑模式 -->
                  <div class="flex items-center gap-2">
                    <kbd
                      class="shrink-0 rounded-md bg-blue-500 px-3 py-1 font-sans text-[13px] font-medium text-white"
                    >
                      {recordingKey ? formatShortcut(recordingKey) : t("settings.keyboard.pressKey")}
                    </kbd>
                    {#if conflictWarning}
                      <!--
                        The reason used to live **only** in a `title` tooltip (`<span title=…>⚠️</span>`).
                        That is the wrong shape here on two counts (F-SH-044): the page's whole audience is
                        keyboard users — who cannot hover — and a screen reader announces the emoji with no
                        name at all, so "which binding is this in conflict with?" was unreachable without a
                        mouse. The message is short (`冲突：已被「关闭窗口」占用`), so it is rendered as text
                        (and named for assistive tech), which also makes it readable from a device pass.
                      -->
                      <span
                        role="status"
                        class="text-xs text-red-500"
                        title={conflictWarning}
                        aria-label={conflictWarning}>{conflictWarning}</span>
                    {/if}
                    <button
                      onclick={cancelEditing}
                      class="rounded-md bg-black/10 px-2 py-1 text-xs opacity-70 hover:opacity-100"
                    >
                      {t("settings.keyboard.cancel")}
                    </button>
                    <button
                      onclick={saveShortcut}
                      class="rounded-md bg-green-500 px-2 py-1 text-xs text-white"
                    >
                      {t("settings.keyboard.save")}
                    </button>
                  </div>
                {:else}
                  <!-- 只读模式 -->
                  {#if row.disabled}
                    <span class="text-xs italic opacity-50">—</span>
                  {:else}
                    <button
                      onclick={() => startEditing(row)}
                      class="group cursor-pointer flex items-center gap-1 rounded-md bg-black/5 px-2 py-1 opacity-70 transition-opacity hover:opacity-100 dark:bg-white/10"
                      aria-label={t("settings.keyboard.editShortcut", { name: t(row.labelKey) })}
                    >
                      <kbd class="font-sans text-[13px] font-medium tabular-nums">{row.currentKeys}</kbd>
                    </button>
                  {/if}
                  {#if !row.disabled}
                    <button
                      onclick={() => disableShortcut(row.id, row.category)}
                      class="rounded-md bg-black/5 px-1.5 py-1 text-xs opacity-40 hover:opacity-70"
                      title={t("settings.keyboard.disable")}
                    >
                      ✕
                    </button>
                  {:else}
                    <button
                      onclick={() => startEditing(row)}
                      class="rounded-md bg-black/5 px-2 py-1 text-xs opacity-40 hover:opacity-70"
                    >
                      +
                    </button>
                  {/if}
                {/if}
              </div>
            </div>
            {#if i < section.rows.length - 1}
              <div class={SUB}></div>
            {/if}
          {/each}
        </div>
      </section>
    {/each}
  {/if}

  <!-- 提示 -->
  <div class="mt-4 rounded-[11px] bg-blue-50/50 p-4 dark:bg-blue-900/20">
    <p class="text-[13px] leading-relaxed opacity-75">
      💡 {t("settings.keyboard.editHint")}
    </p>
  </div>
</div>
