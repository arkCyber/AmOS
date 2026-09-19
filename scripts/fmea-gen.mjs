#!/usr/bin/env node
/**
 * fmea-gen.mjs — AmOS FMEA 文档完整性门禁
 *
 * 模式:
 *   --check          检查 docs/FMEA.md 的失效模式表格与代码扫描一致
 *   --emit-json      机器可读 JSON(FMEA inventory)
 *   --self-test      内嵌用例,证明扫描器可靠
 *
 * 扫描目标(inventory 中 `files:` 字段为真相之源):
 *   - 守护进程: crates/amos-supervisor/src/lib.rs
 *   - 关键模块/文件(crates/amos-ai/src/{server.rs,pool.rs,cache.rs,breaker.rs,session.rs,security.rs,alerts.rs,privacy.rs,audit.rs,peercred.rs,tcp_auth.rs,logfile.rs,inference/mod.rs})
 *   - crates/amos-link/src/{codec.rs,keyexpr.rs,broker.rs,discovery.rs,lan.rs,node.rs,service.rs,robot_hal.rs}
 *   - crates/amos-link-cli/src/lib.rs
 *   - crates/amos-tauri/src/{ai_bridge.rs,clipboard*.rs,devcare.rs,devcare_device.rs}
 *   - crates/amos-tauri/android-glue/com/amos/ai/glue/CameraGlue.kt
 *   - crates/amos-tauri/frontend-ts/src/{lib/{backend.ts,uiFailures.ts,amosStore.ts,bounded.ts,cloud.ts},svelte/ClipboardAnnounce.svelte}
 *   - 真机设备 crates/{amos-telephony,amos-blocklist,amos-radio,amos-sensor,amos-android}
 *
 * 不替代真正的 FMEA 流程 — 仅检查"已登记失效模式与代码/缓解存在性一致"
 *
 * 退出码:
 *   0   检查通过 / 命令成功
 *   1   缓解缺失或 inventory/doc 不一致
 *   2   参数错误
 *   3   读取 inventory 失败
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
// `FMEA_DOC` is overridable so a check can be run against a *historical* copy of the document
// (a negative control on real history: the pre-fix doc must fail the shape check).
const FMEA_DOC = process.env.FMEA_DOC ?? path.join(ROOT, 'docs/FMEA.md');

/**
 * FMEA inventory:每个 ID 关联
 *   - files:     缓解代码所在的文件列表
 *   - mitigations:缓解手段列表(代码片段关键词)
 *   - tests:     测试保护(单测文件)
 */
const KNOWN_FAILURES = [
  // 守护进程
  { id: 'F-AI-001', module: 'amos-ai', files: ['crates/amos-supervisor/src/lib.rs'], markers: ['spawn', 'monitor', 'restart'], severity: 4 },
  { id: 'F-AI-002', module: 'amos-ai', files: ['crates/amos-ai/src/pool.rs', 'crates/amos-ai/src/cache.rs'], markers: ['GenerationPool', 'ResponseCache', 'LRU', 'NonZeroUsize'], severity: 4 },
  { id: 'F-AI-003', module: 'amos-ai', files: ['crates/amos-ai/src/security.rs', 'crates/amos-ai/src/alerts.rs'], markers: ['probe', 'Alert', 'health'], severity: 4 },
  { id: 'F-AI-004', module: 'amos-ai', files: ['crates/amos-ai/src/logfile.rs'], markers: ['LogSinkReport', 'SinkHealth', 'write_failures'], severity: 3 },
  { id: 'F-AI-005', module: 'amos-ai', files: ['crates/amos-ai/src/inference/mod.rs', 'crates/amos-ai/src/breaker.rs'], markers: ['BreakerBackend', 'bytes_per_token'], severity: 3 },
  { id: 'F-AI-006', module: 'amos-ai', files: ['crates/amos-ai/src/breaker.rs'], markers: ['BreakerBackend', 'closed', 'cooldown'], severity: 3 },
  { id: 'F-AI-007', module: 'amos-ai', files: ['crates/amos-ai/src/session.rs'], markers: ['SessionManager', 'CAP'], severity: 3 },
  { id: 'F-AI-008', module: 'amos-ai', files: ['crates/amos-ai/src/pool.rs'], markers: ['Saturated', 'WaitTimeout'], severity: 2 },
  { id: 'F-AI-009', module: 'amos-ai', files: ['crates/amos-ai/src/audit.rs', 'crates/amos-ai/src/privacy.rs'], markers: ['AuditFile', 'recorded', 'attempted'], severity: 4 },
  { id: 'F-AI-010', module: 'amos-ai', files: ['crates/amos-ai/src/peercred.rs'], markers: ['peercred', 'AMOS_UDS_PEER'], severity: 5 },
  { id: 'F-AI-011', module: 'amos-ai', files: ['crates/amos-ai/src/tcp_auth.rs'], markers: ['tcp_auth', 'AMOS_TCP_TOKEN'], severity: 5 },
  { id: 'F-AI-012', module: 'amos-ai', files: ['crates/amos-ai/src/alerts.rs'], markers: ['derive', 'rank', 'BreakerOpen'], severity: 3 },
  { id: 'F-AI-013', module: 'amos-ai', files: ['crates/amos-ai/src/security.rs'], markers: ['RateLimiter', 'validate_probe'], severity: 3 },
  { id: 'F-AI-014', module: 'amos-ai', files: ['crates/amos-ai/src/notifier_bridge.rs', 'crates/amos-ai/src/notifier_sink.rs', 'crates/amos-ai/src/main.rs', 'crates/amos-ai/src/server.rs', 'crates/amos-ai/tests/notifier_alerts_e2e_v2.rs'], markers: ['AlertBridge', 'observe', 'transition', 'paging', 'AMOS_NOTIFIER', 'notifier_sink_from_env', 'serve_with_sinks_full', 'wire'], severity: 3 },
  { id: 'F-AI-015', module: 'amos-ai', files: ['crates/amos-ai/src/alerts.rs'], markers: ['RULES', 'governor', 'privacy', 'netguard'], severity: 3 },
  { id: 'F-NOT-001', module: 'amos-notifier', files: ['crates/amos-notifier/src/webhook.rs', 'crates/amos-notifier/tests/webhook_e2e.rs'], markers: ['POST', 'Content-Type', 'Content-Length', 'Sent', 'Dropped', 'Failed'], severity: 3 },

  // 窗口管理 (形态策略强制到真实窗口: G5 / REQ-A256 主体, REQ-A257 复核收口)
  { id: 'F-WM-014', module: 'amos-tauri', files: ['crates/amos-tauri/src/wm.rs', 'crates/amos-wm/src/form.rs'], markers: ['check_new_app_window', 'check_app_window'], severity: 3 },
  { id: 'F-WM-015', module: 'amos-tauri', files: ['crates/amos-tauri/src/wm.rs', 'crates/amos-wm/src/form.rs'], markers: ['enforce_min', 'fit_window'], severity: 3 },
  { id: 'F-WM-016', module: 'amos-tauri', files: ['crates/amos-tauri/src/wm.rs'], markers: ['resizable(policy.free_resize)', 'min_inner_size'], severity: 2 },
  { id: 'F-WM-017', module: 'amos-tauri', files: ['crates/amos-tauri/src/wm.rs'], markers: ['reclamp_windows', 'reclamp_target'], severity: 3 },
  { id: 'F-WM-018', module: 'amos-tauri', files: ['crates/amos-tauri/src/wm.rs', 'crates/amos-wm/src/form.rs'], markers: ['check_new_app_window', 'AppWindowRefusal'], severity: 3 },
  { id: 'F-WM-019', module: 'amos-tauri', files: ['crates/amos-tauri/src/wm.rs', 'Makefile'], markers: ['title_bar_style', 'android-app-check', 'window_maximize'], severity: 4 },

  // 输入法 (amos-ime / amos-tauri)
  { id: 'F-IME-001', module: 'amos-ime', files: ['crates/amos-ime/src/engine.rs', 'crates/amos-tauri/src/ime.rs'], markers: ['PinyinCore', 'with_core'], severity: 3 },
  { id: 'F-IME-002', module: 'amos-tauri', files: ['crates/amos-tauri/src/ime.rs'], markers: ['MAX_IME_SESSIONS', 'make_room'], severity: 2 },
  { id: 'F-IME-003', module: 'amos-tauri', files: ['crates/amos-tauri/src/ime.rs'], markers: ['PREDICT_KIND', 'predictions'], severity: 3 },
  { id: 'F-IME-004', module: 'amos-ime', files: ['crates/amos-ime/src/engine.rs', 'crates/amos-tauri/src/ime.rs'], markers: ['commit_prediction', 'record_commit'], severity: 3 },
  { id: 'F-IME-005', module: 'amos-ime', files: ['crates/amos-ime/Cargo.toml'], markers: ['predict', 'trigrams'], severity: 2 },

  // 桌面壳 chrome (前端): 模块契约与"可用性=真行为"
  { id: 'F-SH-001', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/modules/ControlCenterButton.svelte', 'crates/amos-tauri/frontend-ts/src/svelte/modules/ChromeIconButton.svelte'], markers: ['disabled', 'aria-disabled'], severity: 2 },
  { id: 'F-SH-002', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/shellModules.ts', 'crates/amos-tauri/frontend-ts/src/lib/shellModule.ts'], markers: ['modulesFor', 'slot'], severity: 2 },
  // REQ-A262: "声称的能力" 与 "真的能力" 必须一致 —— 快捷键不再是注释里的承诺
  { id: 'F-SH-003', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/shellModule.ts', 'crates/amos-tauri/frontend-ts/src/svelte/shellModules.ts'], markers: ['moduleForShortcut', 'shortcuts'], severity: 2 },
  // REQ-A262: 跨组件通道的目的端不能是空的 —— 两条 desktop:* window 事件已删,意图走把手
  { id: 'F-SH-004', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/DesktopStage.svelte', 'crates/amos-tauri/frontend-ts/src/svelte/DesktopShell.svelte'], markers: ['ctxNewFolderUnavailable', 'SHELL_CHROME_API'], severity: 2 },
  // REQ-A263: 同一套设备交互规则不能有第二份实现 —— 三个屏共用 lib/quickRadio.ts
  { id: 'F-SH-005', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/quickRadio.ts', 'crates/amos-tauri/frontend-ts/src/svelte/ControlCenter.svelte'], markers: ['tapRadio', 'RadioCommands'], severity: 3 },
  // REQ-A263: 开关型控件必须成对 —— 能开也能关,并且说得出自己的状态
  { id: 'F-SH-006', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/shellModule.ts', 'crates/amos-tauri/frontend-ts/src/svelte/modules/ControlCenterButton.svelte'], markers: ['toggleOverlay', 'isOverlayOpen'], severity: 2 },
  // REQ-A263: 浮层层序按打开顺序,而不是组件里写死的 z-index
  { id: 'F-SH-007', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/DesktopShell.svelte'], markers: ['openOverlays', 'z-index'], severity: 2 },
  // REQ-A273: 系统快捷键作用于焦点窗口 —— 不能把 "main" / undefined 漏给 wm_close
  { id: 'F-SH-008', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/DesktopShell.svelte'], markers: ['handleSystemShortcut', 'focusedWindowLabel'], severity: 3 },
  // REQ-A273: Dock 右键菜单的 props 在 onclose 之后访问会抛 —— 必须在 await 之前把 label 读到局部
  { id: 'F-SH-009', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/modules/DockContextMenu.svelte'], markers: ['targetLabel', 'Prop-read ordering'], severity: 3 },
  // REQ-A278: 多选 Shift-click 必须 union 而不是替换 —— macOS Finder 契约
  { id: 'F-SH-010', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/DesktopStage.svelte'], markers: ['unionRange(anchorId, id)', 'wasSelected'], severity: 3 },
  // REQ-A278: 顶栏 Edit → Select All 与键盘 ⌘A 必须走同一条选区
  { id: 'F-SH-011', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/modules/TopbarMainMenu.svelte', 'crates/amos-tauri/frontend-ts/src/svelte/DesktopStage.svelte'], markers: ['edit.select-all', 'onWindowKeyDown'], severity: 2 },
  { id: 'F-SH-012', module: 'process', files: ['crates/amos-tauri/frontend-ts/src/lib/desktopKeys.ts', 'crates/amos-tauri/frontend-ts/scripts/orphan-test-scan.mjs'], markers: ['desktopShortcutLabel', 'orphan-test-scan'], severity: 4 },
  { id: 'F-SH-013', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/Shell.svelte', 'crates/amos-tauri/frontend-ts/src/lib/backNav.ts', 'crates/amos-tauri/frontend-ts/svelte-tests/shell.svelte.test.ts'], markers: ['pushDecision', 'history.pushState', 'REQ-A347'], severity: 3 },
  { id: 'F-SH-014', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/modules/TopbarMainMenu.svelte', 'crates/amos-tauri/frontend-ts/src/lib/desktopKeys.ts', 'crates/amos-tauri/frontend-ts/src/i18n/locales/en.ts'], markers: ['desktopShortcutLabel', 'desktop.menu.file.closeWindow'], severity: 3 },
  { id: 'F-SH-015', module: 'process', files: ['crates/amos-tauri/frontend-ts/scripts/orphan-test-scan.mjs', 'crates/amos-tauri/frontend-ts/scripts/test-reach-allowlist.json'], markers: ['orphan-test-scan', 'testreach:scan'], severity: 2 },
  { id: 'F-SH-016', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/mediaExport.ts', 'crates/amos-tauri/frontend-ts/src/svelte/VoiceMemosApp.svelte', 'crates/amos-tauri/frontend-ts/svelte-tests/vmemos.svelte.test.ts'], markers: ['exportToSharedCollection', 'RECORDING_EXPORT_DIR', 'REQ-A350'], severity: 2 },
  { id: 'F-SH-017', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/PhotosApp.svelte', 'crates/amos-tauri/frontend-ts/src/lib/mediaExport.ts', 'crates/amos-tauri/frontend-ts/svelte-tests/photos.svelte.test.ts'], markers: ['copyText', 'photo.shareFailed', 'camera.exportToSystem'], severity: 3 },
  { id: 'F-SH-018', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/scripts/i18n-scan.mjs', 'crates/amos-tauri/frontend-ts/scripts/i18n-allowlist.json'], markers: ['staleAllowList', 'stale allow-list entry', 'REQ-A353'], severity: 3 },
  { id: 'F-SH-019', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/mediaPaging.ts', 'crates/amos-tauri/frontend-ts/src/__tests__/mediaPaging.test.ts', 'crates/amos-media/src/hostfs.rs'], markers: ['afterCursor', 'pageOf', 'Reverse(i.ts)'], severity: 3 },
  { id: 'F-SH-020', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/NotesApp.svelte', 'crates/amos-tauri/frontend-ts/svelte-tests/notes.svelte.test.ts'], markers: ['note.exportCopyFailed', 'copiedToClipboard', 'REQ-A355'], severity: 3 },
  { id: 'F-SH-021', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/CameraApp.svelte', 'crates/amos-tauri/frontend-ts/svelte-tests/camera.svelte.test.ts'], markers: ['camera.exportToSystem', 'exportToSystem', 'CAMERA_EXPORT_DIR'], severity: 3 },
  { id: 'F-SH-022', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/scripts/i18n-scan.mjs', 'crates/amos-tauri/frontend-ts/scripts/i18n-literal-allowlist.json'], markers: ['assignedCJKCopy', 'hard-coded copy in a <script> block', 'stale literal exemption'], severity: 4 },
  { id: 'F-SH-023', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/appLinks.ts', 'crates/amos-tauri/frontend-ts/src/svelte/CameraApp.svelte', 'crates/amos-tauri/frontend-ts/svelte-tests/camera.svelte.test.ts'], markers: ['openPhoto', 'PHOTOS_CHANNEL', 'a11y.lastPhoto'], severity: 3 },
  { id: 'F-SH-024', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/scripts/a11y-scan.mjs'], markers: ['r9_deadControl', 'buttonTags', 'dead-control'], severity: 3 },
  { id: 'F-MED-001', module: 'amos-media', files: ['crates/amos-media/src/android.rs', 'crates/amos-media/src/mapping.rs'], markers: ['kind_and_mime_for_name(&name)', 'audio/mpeg'], severity: 4 },
  { id: 'F-DEV-001', module: 'process', files: ['scripts/device-probe-media-export.js', 'scripts/device-ui-eval.mjs'], markers: ['__probeExpect', 'settledMs', 'IS_PENDING'], severity: 3 },
  { id: 'F-TAU-007', module: 'amos-tauri', files: ['crates/amos-tauri/src/alarm_sched.rs', 'crates/amos-tauri/android-glue/com/amos/ai/glue/AlarmGlue.kt'], markers: ['scheduler_alarm_register', 'AlarmGlue.schedule', 'setExactAndAllowWhileIdle'], severity: 4 },
  // REQ-A404: 覆盖率门的分母把"只有收尾括号"的行当成可执行行（bun 的 lcov 只发 DA:n,0、从不标命中）⇒ 读数被压约 10 个点，
  // 门长期红着而真实覆盖率高于阈值（实测 84.67% → 94.95%）。判据 + 自检 + 负控见 CHANGELOG REQ-A404。
  { id: 'F-DEV-010', module: 'process', files: ['crates/amos-tauri/frontend-ts/scripts/lib-coverage-gate.mjs', 'crates/amos-tauri/frontend-ts/scripts/bun-iso-test.mjs'], markers: ['executableLinesFromSource', 'substantive', 'selftest'], severity: 3 },
  // 覆盖率门的**第二个**盲区（REQ-A405）：分母是从 lcov 的 `SF:` 记录建的 ⇒ 没被任何测试
  // import 过的模块**根本没有 SF 记录** ⇒ 它在门的世界里不存在（实测 153 个模块只"看见"
  // 150 个，门却说"150 files"，其中 `sysIcons.ts` 是真逻辑：图标映射 + 电池字形，被 20+
  // 个组件使用）。处置：每个 `src/lib` 模块必须可测量，否则必须带理由登记进
  // `coverage-unmentioned-allowlist.json`（陈旧条目判死）；三个隐形模块补齐真测试。
  { id: 'F-DEV-011', module: 'process', files: ['crates/amos-tauri/frontend-ts/scripts/lib-coverage-gate.mjs'], markers: ['libModulesOnDisk', 'coverage-unmentioned-allowlist.json', 'measurable', 'REQ-A405'], severity: 3 },
  // 冲突检测/保存/观察者的"说了要做、其实没做"（REQ-A406）：键位配置里禁用分支是个空循环
  // （`arr.findIndex` 结果丢掉）+ 换绑不摘旧键 ⇒ 设置页报不存在的冲突；`writeKeyboardConfig`
  // 恒回 true；`uiFailures` 换 target 时旧监听留着（同一失败记两次）；`customGroups` 对
  // `apps` 逐元素不校验。全部测试先行（先红后修），负控逐字节还原（`detectConflicts` 原块
  // 还原 ⇒ 30 pass / 3 fail）。
  { id: 'F-DEV-012', module: 'process', files: ['crates/amos-tauri/frontend-ts/src/lib/keyboardConfig.ts', 'crates/amos-tauri/frontend-ts/src/lib/uiFailures.ts', 'crates/amos-tauri/frontend-ts/src/lib/customGroups.ts'], markers: ['removeEverywhere', 'detach', 'typeof a === "string"', 'REQ-A406'], severity: 3 },
  // **守卫函数的输入形状没被守卫**（REQ-A407）：`androidLmkTasks` 把宿主应答原样透传成
  // `AndroidLmkTask[]`，于是非数组应答会在对账里变成 `tasks.filter` 抛错 —— 而对账是被
  // `void` 出去的 ⇒ 一次没人看见的未处理拒绝，函数自己"daemon down ≠ app dead"的守卫失效；
  // 同一个对账的坏元素（null / 无 window_id）也会让整轮炸掉。两处都补了形状判据 + 测试。
  { id: 'F-DEV-013', module: 'process', files: ['crates/amos-tauri/frontend-ts/src/lib/lmk.ts'], markers: ['Array.isArray', 'androidLmkTasks', 'reconcileLegacySurfaces', 'REQ-A407'], severity: 3 },
  { id: 'F-DEV-018', module: 'process', files: ['crates/amos-tauri/src/menu.rs'], markers: ['collect_item_ids', 'Menu::get', 'the_tree_check_descends_into_submenus', 'REQ-A427'], severity: 3 },

  { id: 'F-DEV-019', module: 'process', files: ['crates/amos-tauri/src/wm.rs'], markers: ['resolved_title', 'resolve_caller_title', 'a_window_names_itself_and_never_the_launchers_title', 'REQ-A428'], severity: 3 },
  { id: 'F-DEV-020', module: 'process', files: ['crates/amos-tauri/src/wm.rs'], markers: ['close_target', 'a_close_resolves_the_platform_window_before_the_state_forgets_it', 'the platform refused to close the window', 'REQ-A430'], severity: 4 },
  { id: 'F-DEV-021', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/shellNav.ts', 'crates/amos-tauri/frontend-ts/src/lib/__tests__/shellNav.test.ts'], markers: ['windowOwnsShellNav', 'REQ-A429'], severity: 3 },
  { id: 'F-DEV-022', module: 'process', files: ['crates/amos-tauri/frontend-ts/src/lib/earlySystemKeys.ts', 'crates/amos-tauri/src/menu.rs'], markers: ['installEarlySystemKeys', 'handOverSystemKeys', 'close_target_label', 'REQ-A431'], severity: 3 },
  { id: 'F-DEV-023', module: 'process', files: ['crates/amos-tauri/src/menu.rs'], markers: ['orderFrontStandardAboutPanel', 'About panel requested from menu', 'REQ-A432'], severity: 2 },
  { id: 'F-DEV-024', module: 'process', files: ['crates/amos-tauri/src/menu.rs', 'crates/amos-tauri/src/lib.rs'], markers: ['sync_window_items', 'WINDOW_ITEMS', 'the_window_menu_items_are_declared_ids', 'REQ-A433'], severity: 3 },
  { id: 'F-DEV-025', module: 'process', files: ['crates/amos-tauri/src/wm.rs'], markers: ['page_loaded', 'focus deferred until the page loads', 'REQ-A435'], severity: 3 },
  { id: 'F-DEV-026', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/menuKeys.ts', 'crates/amos-tauri/frontend-ts/src/__tests__/menuKeys.test.ts'], markers: ['installMenuKeyboard', 'nextMenuIndex', 'REQ-A436'], severity: 2 },
  { id: 'F-DEV-027', module: 'process', files: ['crates/amos-tauri/src/menu.rs', 'crates/amos-tauri/frontend-ts/src/svelte/locale.svelte.ts', 'scripts/menu-i18n-scan.mjs'], markers: ['MenuLocale', 'MenuLabels', 'menu_set_locale', 'menu-i18n-scan', 'REQ-A437'], severity: 2 },
  { id: 'F-DEV-028', module: 'frontend', files: ['crates/amos-tauri/src/menu.rs', 'crates/amos-tauri/frontend-ts/src/lib/editKeys.ts', 'crates/amos-tauri/frontend-ts/src/svelte/modules/TopbarMainMenu.svelte'], markers: ['selectAllInFocus', 'selectAllFromMenu', 'trackEditableFocus', 'select_all_with_text', 'REQ-A439'], severity: 2 },
  // REQ-A440: a window nobody can move, because the one place that can drag it was never marked
  // (`data-tauri-drag-region`) *and* the ACL never granted `plugin:window|start_dragging` — two
  // silent layers; plus the strip painted a second set of traffic lights and the OS drew its own
  // title beside them.
  { id: 'F-DEV-029', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/DesktopAppWindow.svelte', 'crates/amos-tauri/capabilities/default.json', 'crates/amos-tauri/src/wm.rs', 'crates/amos-tauri/frontend-ts/src/lib/desktopLayout.ts'], markers: ['data-tauri-drag-region', 'allow-start-dragging', 'hidden_title', 'APP_WINDOW_TITLEBAR_INSET', 'REQ-A440'], severity: 2 },
  // REQ-A441: the OS's own minimize (yellow light) leaves a window the model cannot represent, so
  // the open/focus path had nothing to restore — the window was unreachable from AmOS's own UI.
  { id: 'F-DEV-030', module: 'frontend', files: ['crates/amos-tauri/src/wm.rs', 'docs/multi-window.md'], markers: ['reveal_window', 'is_minimized', 'unminimize', 'REQ-A441'], severity: 2 },
  // REQ-A442: the aerospace audit doc asserted a property it never measured ("零处 macro_rules! 生产
  // 代码" while four existed) — the whole point of an audit register is that its claims are checkable.
  { id: 'F-DEV-031', module: 'process', files: ['scripts/rust-macro-scan.mjs', 'scripts/rust-macro-allowlist.json', 'docs/POWER_OF_10.md', 'crates/amos-tauri/src/wm.rs'], markers: ['rust-macro-scan', 'unlisted-macro', 'stale-exemption', 'wm_split_swap', 'REQ-A442'], severity: 2 },
  // REQ-A443: two "invisible" gaps, both in the audit's own instruments. ① the call-flow gate
  // linked only functions defined in the *same file*, so a cycle split across two files (or two
  // crates) could not be seen — a gap the audit's own residual-risk table had registered. ② the
  // same document's verification block spelled the five `-scan` selftests `--self-test`, a flag
  // none of them implements: the line printed a clean *gate* result while asserting nothing
  // (F-DEV-005's shape — an instrument answering a different question).
  { id: 'F-DEV-032', module: 'process', files: ['scripts/rust-recursion-scan.mjs', 'crates/amos-translate/src/lib.rs', 'docs/POWER_OF_10.md'], markers: ['scanWorkspace', 'cross-file cycle', 'deliver', 'REQ-A443'], severity: 2 },
  // REQ-A444: the supervisor's alerting seam was registered as a *mitigation* but never armed.
  // `Supervisor::with_alert_sink` had no caller anywhere (`rust-unwired-scan`: "referenced
  // nowhere"), so `alert_sink` stayed `None` and `fire_alert` was dead in both feature
  // configurations while `alert_sink.rs` asserted the notifier build "wires this in"; and the
  // give-up branch itself printed nothing, so in a default build a daemon simply stopped
  // existing with no line at all. This is F-AI-012's failure mode ("alert never delivered ⇒ the
  // operator does not know"), one component over.
  { id: 'F-DEV-033', module: 'process', files: ['crates/amos-supervisor/src/bin/amos-supervisor.rs', 'crates/amos-supervisor/src/lib.rs', 'crates/amos-supervisor/tests/alert_wiring.rs'], markers: ['with_alert_sink', 'exhausted its restart budget', 'an_armed_supervisor_reports_a_crash_then_the_exhaustion', 'REQ-A444'], severity: 3 },
  // REQ-A445: the unwired ratchet's excuse list had no reasons — a bare `{ "values": [...] }` of
  // 26 strings, while the gate's own failure text and docs/rust-unwired-audit.md both stated that a
  // reason was recorded. Its `--update-baseline` rewrote the whole file, so a new finding could be
  // excused with no reason anywhere and no check ever failed; and an entry that became wired was
  // only *printed*, never required to be removed. Same discipline the macro whitelist got in
  // REQ-A442 (R1 reason / R2 ratchet-must-shrink / R3 duplicate), applied to the older ratchet.
  { id: 'F-DEV-034', module: 'process', files: ['scripts/rust-unwired-scan.mjs', 'scripts/rust-unwired-baseline.json', 'docs/rust-unwired-audit.md'], markers: ['baselineProblems', 'missing-reason', 'stale-entry', 'REQ-A445'], severity: 2 },
  // REQ-A446: the Spaces feature promised "each desktop has its own window set" while
  // `spaces_switch` only moved `active_index` — a switch that reports an effect it does not have,
  // and the panel drew the new desktop as current while every window stayed put. The ledger half
  // was wired (REQ-A389); the window half was three uncalled helpers with a baselined excuse.
  { id: 'F-DEV-035', module: 'process', files: ['crates/amos-tauri/src/spaces.rs', 'crates/amos-tauri/src/spaces_commands.rs'], markers: ['switch_plan', 'apply_switch_plan', 'the space switch moved the ledger but not the screen', 'REQ-A446'], severity: 3 },
  // REQ-A447: "the ratchet must shrink" was enforced in some gates and only *printed* in others.
  // Measured across every allow-list/baseline: 7 gates failed on a stale exemption, 5 merely
  // logged it (unsafe, discard, recursion, hot-loop, and the frontend unwired-scan, whose comment
  // claimed a check that did not exist). Tightening the five found real rot on the first run
  // (an allow-list excuse whose hole had been filled), and `unsafe-baseline.json`'s headline
  // `total` had never been re-measured against the per-file counts.
  { id: 'F-DEV-036', module: 'process', files: ['scripts/unsafe-scan.mjs', 'scripts/rust-recursion-scan.mjs', 'crates/amos-tauri/frontend-ts/scripts/unwired-scan.mjs'], markers: ['the ratchet must shrink', 'totalProblems', 'allowStale', 'REQ-A447'], severity: 2 },
  // REQ-A448: nine amos-tauri files implement one family — a process-global handle installed
  // exactly once, where "a redundant attach keeps the first" is only safe while the Activity is
  // not recreated. What makes that true lives in the *generated* manifest (`android:configChanges`,
  // Tauri's template), was written down nowhere, and was checked by nothing — so a template change
  // would have silently turned 17 deliberate discards into bridges driving a dead Kotlin instance.
  { id: 'F-DEV-037', module: 'process', files: ['scripts/android-glue-mirror.sh', 'crates/amos-tauri/src/mic_permission.rs', 'crates/amos-tauri/src/clipboard_glue.rs'], markers: ['configChanges', 'Activity is not recreated under us', 'REQ-A448'], severity: 3 },
  // REQ-A449: a feature whose last half had **no UI at all**. `spaces_move_window` was on the
  // bridge (exported, typed, unit-tested, command registered) and nothing called it — the frontend
  // unwired baseline listed it as an excuse — so only a window filed by hand from a shell could
  // ever follow a desktop switch, and the panel offered no way to file one.
  { id: 'F-DEV-038', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/SpacesPanel.svelte', 'crates/amos-tauri/frontend-ts/src/lib/spaces.ts', 'crates/amos-tauri/frontend-ts/svelte-tests/spaces.svelte.test.ts'], markers: ['handleAssignWindow', 'fileableWindows', 'REQ-A449'], severity: 3 },
  // REQ-A450: a feature's **initial state was a one-way door**. `move_window_to_space` only moves a
  // window *between* Spaces, so a window filed by mistake could never return to "filed by nobody"
  // (visible on every desktop) — the state every window starts in, and the state the panel could
  // only draw as a placeholder it refused to accept. The inverse operation was simply missing.
  { id: 'F-DEV-039', module: 'frontend', files: ['crates/amos-tauri/src/spaces.rs', 'crates/amos-tauri/src/spaces_commands.rs', 'crates/amos-tauri/frontend-ts/src/svelte/SpacesPanel.svelte'], markers: ['unfile_window', 'spaces_unfile_window', 'REQ-A450'], severity: 2 },
  // REQ-A451: the same defect twice, in two sibling daemons. `amos-translate`'s socket cleanup was
  // fixed to report (REQ-A443); `amos-ai`'s identical line — under a comment that already named the
  // stake ("so a stale one never blocks the next bind") — kept discarding. A fix applied where it
  // was found is not a fix applied where it also holds.
  { id: 'F-DEV-040', module: 'process', files: ['crates/amos-ai/src/server.rs', 'crates/amos-translate/src/lib.rs'], markers: ['remove_socket', 'a stale socket makes the next bind fail', 'REQ-A451'], severity: 3 },
  // REQ-A452: the discard gate could **under-measure itself**. `clippyPass` accepted any output that
  // contained a `compiler-message`, so a pass that failed to *build* returned a partial count — and
  // since REQ-A447 that partial count renders as **stale baseline entries**, i.e. as work nobody
  // did, pointing at files nobody touched (observed: four files after a concurrent crate broke).
  { id: 'F-DEV-041', module: 'process', files: ['scripts/rust-discard-scan.mjs'], markers: ['firstCompilerError', 'could not measure', 'REQ-A452'], severity: 3 },
  { id: 'F-DEV-042', module: 'process', files: ['scripts/blocking-async-allowlist.json', 'crates/amos-ai/src/server.rs'], markers: ['serve_with_sinks_full', 'One cause can produce two lines of output', 'REQ-A454'], severity: 3 },
  { id: 'F-DEV-043', module: 'process', files: ['Makefile', 'scripts/feature-surface-scan.mjs'], markers: ['--features notifier', 'never enabled', 'REQ-A454'], severity: 3 },
  { id: 'F-DEV-044', module: 'process', files: ['Makefile', 'scripts/diagnose-android-usb.sh', 'docs/device-bringup-checklist.md'], markers: ['android-usb', 'diagnose-android-usb', 'REQ-A454'], severity: 2 },
  // REQ-A459: a crate root declared **two** of the three P0-1 lints while the comment next to the
  // one `panic!` in that crate claimed the third was "locally silenced" — a silencing that existed
  // nowhere: the lint had never been enabled and no `#[allow]` was written anywhere. The build
  // enforced less than the prose asserted, and only the gate that requires all three could see it
  // (59 crate roots; this was the only one missing the third).
  { id: 'F-DEV-045', module: 'process', files: ['crates/amos-notifier/src/lib.rs', 'crates/amos-notifier/src/webhook.rs'], markers: ['clippy::panic', 'REQ-A459'], severity: 3 },
  // REQ-A459: a documented default whose implementing function had **no caller anywhere** — the
  // module header promised `~/.amos/feature-flags.json` overridable by `AMOS_FEATURE_FLAGS_FILE`,
  // `default_file_path()` implemented exactly that promise, and nothing called it, so neither the
  // default path nor the override existed in any code path. Two more documented capabilities in the
  // same crate (`Resolver::feature_flags`, `Resolver::get_typed`) were zero-reference too, and one
  // export (`env_name_for_pub`) advertised a direction whose claimed consumer used the other one.
  { id: 'F-DEV-046', module: 'process', files: ['crates/amos-config/src/feature_flag.rs', 'crates/amos-config/src/layer.rs'], markers: ['from_local', 'default_file_path', 'REQ-A459'], severity: 3 },
  // REQ-A459: the two halves of the key normalisation disagreed with each other AND with their own
  // docs. `env_key_to_config_key` stripped `AMOS_` (storing `ai.port`) while its doc said the prefix
  // was "kept"; `env_name_for("amos.ai.port")` — the key the docs and every caller use — produced
  // `AMOS_AMOS_AI_PORT`, a name nothing sets. So Layer::Env could never answer a documented key and
  // an operator's `AMOS_AI_PORT=9090` was silently ignored. Found by RUNNING the §4 example, not by
  // reading: it printed `session-env AMOS_AMOS_AI_PORT: None` and `default: Number(8080)`.
  { id: 'F-DEV-047', module: 'process', files: ['crates/amos-config/src/layer.rs', 'crates/amos-config/src/lib.rs', 'crates/amos-config/examples/layered_resolve.rs'], markers: ['env_key_to_config_key', 'env_name_for', 'REQ-A459'], severity: 4 },
  // REQ-A459: an example nothing runs — and it had been broken since the framing changed.
  // `crates/amos-robot/examples/serial_loopback.rs` asserted a hand-written "12 bytes" while the
  // driver's real wire form is `body ‖ EOF` = `FRAME_LEN + 1` = 11, so it panicked the first time
  // anyone ran it. Nothing could see that: `cargo test` does not build examples, and the README
  // check only asks whether an example is *named* (it was not).
  { id: 'F-DEV-048', module: 'process', files: ['crates/amos-robot/examples/serial_loopback.rs', 'crates/amos-robot/README.md'], markers: ['frame_bytes', 'REQ-A459'], severity: 2 },
  // REQ-A460: the mirror image of `dangling-source-scan` had no gate at all, so a file
  // that sits in `src/` while the compiler never reads it was invisible *by construction*
  // — every other scan walks **from** a reference, and such a file has none.
  // `crates/amos-mdm/src/error.rs.tmp_tests` (14 tests, a byte-identical copy of the
  // module inside `error.rs`, non-`.rs` extension) and `crates/amos-ai/src/notifier_bridge/`
  // (a stale earlier revision left behind by a move; the directory had no `mod.rs`, so
  // `mod notifier_sink;` resolved to `src/notifier_sink.rs`) were both found the moment
  // the gate existed. Its own first version had a false positive (the Rust 2018
  // module-dir rule: a child of `src/live.rs` lives in `src/live/`) — 5 phantom findings,
  // now pinned by a selftest case, because a false positive is worse than a miss.
  { id: 'F-DEV-049', module: 'process', files: ['scripts/unreached-source-scan.mjs', 'scripts/unreached-src-allowlist.json', 'scripts/dangling-source-scan.mjs', 'Makefile'], markers: ['unreached-source-scan', 'moduleDir', 'REQ-A460'], severity: 3 },
  // REQ-A460: a feature-gated test that **nothing runs**. `amos-ai/notifier` and
  // `amos-supervisor/notifier` are off by default (they pull `amos-notifier` into the
  // device build) and `make lint` only *compiled* them, so the alert bridge's unit tests
  // and two end-to-end test targets executed in no step at all — the REQ-A188/A191 blind
  // spot, this time on the run side rather than the compile side.
  { id: 'F-DEV-050', module: 'process', files: ['Makefile', 'crates/amos-ai/src/notifier_sink.rs', 'crates/amos-supervisor/src/alert_sink.rs'], markers: ['amos-supervisor/notifier', 'notifier_sink', 'REQ-A460'], severity: 3 },
  // REQ-A460: a **derived artifact** older than the tree it derives from. The embedded
  // frontend bundle (`dist/`) was older than its sources, so the release desktop binary
  // would have shipped a UI that does not match this tree; and `docs/ENV_VARIABLES.md`
  // — the document that calls itself the single source of truth for configuration — was
  // missing nine knobs the code already reads (the whole alerting/config surface).
  // Both gates existed and both were red: the gap is not "no check" but "a check nobody
  // had run", which is what makes it worth registering as a failure mode.
  { id: 'F-DEV-051', module: 'process', files: ['docs/ENV_VARIABLES.md', 'scripts/dist-freshness.mjs', 'scripts/env-doc-gen.mjs', 'Makefile'], markers: ['AMOS_CONFIG_RELOAD_SECS', 'dist-freshness', 'REQ-A460'], severity: 3 },
  // REQ-A461: the i18n gate's English-copy check read *static* attributes (`attr="…"`) and
  // brace-less text nodes, so a label written as a Svelte expression was invisible to it —
  // `aria-label={`remove ${id}`}` announced English *and* a raw app id in a zh+en OS while the
  // dictionary key it should have used (`edit.remove`) sat unused and allow-listed. Ten such
  // labels existed (two screens' accessible names, play/pause, done/undone, DND). The new rule
  // had its own false-positive lesson: scanning *every* literal in the expression produced 94
  // findings, 93 of them enum tokens / icon names / class lists — so the rule is "the branch the
  // reader sees **is** the literal", and a template is only prose when it interpolates.
  { id: 'F-DEV-052', module: 'process', files: ['crates/amos-tauri/frontend-ts/scripts/i18n-scan.mjs', 'crates/amos-tauri/frontend-ts/src/i18n/locales/zh.ts', 'Makefile'], markers: ['expressionCopy', 'wholeLiteralTexts', 'REQ-A461'], severity: 3 },
  // REQ-A461: a control that *looked* like it did nothing — and a door with no way back.
  // `Launchpad.svelte`'s edit-mode "−" called `hideApp` (writing `layout.hidden`), but its own
  // displayed list never read `hidden`: the second loop re-appended every APP_META id the layout
  // did not contain, so the icon stayed put while the **touch** home screen silently lost the app.
  // On the desktop there was then no restore path at all (the touch form has `EditHome`'s ＋ row).
  { id: 'F-DEV-053', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/Launchpad.svelte', 'crates/amos-tauri/frontend-ts/svelte-tests/launchpad.svelte.test.ts'], markers: ['hiddenIds', 'restoreApp', 'REQ-A461'], severity: 3 },
  // REQ-A462: an exemption can **legitimise a false statement in the UI**. `edit.hint` told
  // the user "tap ‹ › to reorder" from the day it was written, while neither button existed —
  // and the two dictionary keys the buttons would use (`edit.moveEarlier` / `edit.moveLater`)
  // were allow-listed with the reason "the reorder UX was not yet wired … reserved for future
  // implementation". The gate was satisfied (a live allow-list entry is not a dead key), so the
  // only place the gap showed was in front of the user. The lesson: a reason that says "not yet
  // wired" must not also be the reason a *user-visible claim* is allowed to stand.
  { id: 'F-DEV-054', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/EditHome.svelte', 'crates/amos-tauri/frontend-ts/src/lib/amosStore.ts', 'crates/amos-tauri/frontend-ts/scripts/i18n-allowlist.json'], markers: ['canMoveWithinHome', 'REQ-A462'], severity: 3 },
  // REQ-A463: **feature unification hides a package that is broken on its own.**
  // `crates/amos-monitor/examples/sample_health.rs` uses `amos_monitor::linux::LinuxSystemSampler`
  // without declaring `required-features`, so `cargo build -p amos-monitor --all-targets` fails
  // with E0432 while `cargo clippy --workspace --all-targets` passes — because `amos-ai` depends
  // on `amos-monitor` with `features = ["linux"]`, so the workspace build turns the feature on for
  // everyone. Every gate in the tree was green; the defect was found by *running* the example.
  // It is also the reason the examples gate runs each example from the workspace root's manifest
  // but with a scratch `cwd` — the first version wrote `sample.pdf` into the repository.
  { id: 'F-DEV-055', module: 'process', files: ['scripts/examples-smoke.mjs', 'scripts/examples-smoke-allowlist.json', 'crates/amos-monitor/Cargo.toml'], markers: ['required-features', 'REQ-A463'], severity: 3 },
  // REQ-A466: **总测试门是红的，而它的原因是"两个测试共用一个临时路径"**。
  // `restart_all_e2e.rs` 的四个测试是同一个进程里的**并发线程**，而 `pidfile(name)` 只用
  // `(process::id(), name)` 作键：`restart_all_called_twice_…` 用 `a`/`b`、
  // `list_after_restart_all_…` 用 `a`/`b`/`c`/`d` ⇒ 两个测试共用同一批路径，而每次
  // `sleep_daemon_with_pidfile` 开头就 `remove_file` ⇒ 一个测试把另一个测试守护进程刚写的
  // pidfile 删掉，`read_pid` 永远读不出可解析的值。实测：默认并行 **4 例中 1 例失败**
  // （稳定复现，5/5），单线程 **0 失败**，单独跑那一个 **通过**；`cargo test --workspace`
  // 因此 exit 101。同一文件还留下 `cargo fmt --check` 的 3 处 diff ⇒ `make lint` 也是红的。
  // **同一个类的第二个实例**：`amos-link-cli/tests/cli_smoke.rs` 的 `start_control_plane()`
  // 路径用 `(process::id(), SystemTime::now().as_nanos())`，而它有**五个**调用者（同一个
  // 进程的并发线程）⇒ 同一时钟刻度的两次调用算出**同一个**路径，先绑者胜、后绑者
  // `AddrInUse` panic。实测：三次 `cargo test --workspace` 里**红一次**（绿/红/绿），而该
  // 文件单独跑 **34/34 稳定通过** —— 典型的"只在整仓并行下出现"。
  { id: 'F-DEV-056', module: 'process', files: ['crates/amos-supervisor/tests/restart_all_e2e.rs', 'crates/amos-link-cli/tests/cli_smoke.rs'], markers: ['AtomicU64', 'never became parseable', 'unique_socket_path', 'REQ-A466'], severity: 3 },
  // REQ-A467: `Supervisor::restart_all` was only ever proven to recycle a happy-path
  // pair of daemons (the in-lib test `restart_all_recycles_every_running_child`).
  // The harder contracts — *which* daemons must NOT be touched (Stopped /
  // Crashed, whose monitor has already exited), what happens to the supervisor's
  // public view after the recycle (`list()` / `status()`), and whether two
  // back-to-back `restart_all` calls each produce a brand-new child — were
  // implicit. The implementation is correct, but a silent regression (e.g.
  // someone adding a `restart_requested` flag to a crashed daemon's monitor
  // post-hoc and resurrecting a stopped child) would have shipped green.
  // Measured mitigation: 5/5 tests in `tests/restart_all_e2e.rs` cover the
  // production path on real `sh -c 'echo $$ > pid; exec sleep N'` processes,
  // including `kill -0` reaping checks across cycle boundaries.
  { id: 'F-SUP-001', module: 'amos-supervisor', files: ['crates/amos-supervisor/src/lib.rs', 'crates/amos-supervisor/tests/restart_all_e2e.rs'], markers: ['restart_all', 'restart_all_skips_stopped_and_crashed', 'restart_all_called_twice_yields_two_distinct_new_pids', 'list_after_restart_all_reports_every_daemon_running', 'restart_all_over_mixed_states_does_not_spam_the_alert_sink', 'restart_all_on_empty_supervisor_completes', 'REQ-A467'], severity: 3 },
  // REQ-A465: **workspace 构建也不合并输出路径** —— 两个成员的同名 `example` 都写
  // `target/debug/examples/<name>`，cargo 只**警告**（"may become a hard error in the
  // future"），而 `cargo build -q` 连警告都不显示 ⇒ 本仓全绿，且按路径执行那个产物
  // (`scripts/ai-honesty-smoke.sh` 就按路径跑 `target/debug/examples/status_once`) 依赖的是
  // "谁最后被链接"这个意外。实测两对：`status_once`（amos-ai + amos-translate）、
  // `embed_commands`（amos-appstore-cli + amos-link-cli）。
  { id: 'F-DEV-057', module: 'process', files: ['scripts/isolation-check.mjs', 'crates/amos-translate/examples/translate_status_once.rs'], markers: ['REQ-A465', 'outputCollisions', 'UNSHARED_KINDS'], severity: 3 },
  // REQ-A467: **整个"控制"半场是空转的，却回 `Ok`** —— `airplay_connect` / `airplay_start_stream`
  // / `airplay_set_volume` 三个命令的实现只有 `TODO` 注释：`connect` 把 `device.connected` /
  // `status.active` 置位再 `Ok`；`start_stream` 置 `playing` 并把 `url` 丢掉（`let _ = url;`）；
  // `set_volume` 把值夹紧写进 `status` 再 `Ok`。而 `is_available()` 在 macOS/iOS/Android/Linux
  // 一律 `return true`，文件头却写着 "returns well-typed failures rather than silently pretending
  // to work" ⇒ 面板把"已连接 / 投屏中"画出来，而没有任何设备被联系过（demo 设备让 debug 构建
  // 里这条路真的走得到）。**同轮量到的第二个事实**：`AirPlayResult` 是 union alias，而
  // `tauri-reply-scan` **明确跳过** union alias（"skipped, never guessed"），于是
  // `rename_all = "lowercase"` 发出的 `"permissiondenied"` / `"devicenotfound"` 与前端声明的
  // `permission_denied` / `device_not_found` 长期不一致而无人比较（面板只看 `kind === "ok"`）；
  // 而当时那条"断言 Ok"的测试在 macOS 上是**空转**的（发现失败 ⇒ 设备列表为空 ⇒ 提前 return，
  // 什么也没断言）。第三个缺口：面板把拒绝送进 `console.error`，且 discovery 失败时
  // `discovering` 不复位 ⇒ 用户看到的是"永远在搜索"或"点了没反应"。
  { id: 'F-DEV-058', module: 'process', files: ['crates/amos-tauri/src/airplay.rs', 'crates/amos-tauri/src/airplay_tests.rs', 'crates/amos-tauri/frontend-ts/src/lib/airplay.ts', 'crates/amos-tauri/frontend-ts/src/svelte/AirPlayPanel.svelte'], markers: ['NOT_IMPLEMENTED', 'test_airplay_result_wire_form', 'not_implemented', 'airplay.controlUnavailable'], severity: 3 },
  // REQ-A468: **"重试"和"关闭"其实是同一个动作** —— `FilesApp.svelte` 交给 `FileErrorBanner` 的
  // `onRetry` 是个占位实现（注释自己写着 "This is a placeholder - actual retry would need
  // operation-specific logic"）：它只把 `currentError` 清掉，**什么都不重试**。而
  // `FileErrorBanner` 的渲染判据是 `error.retryable && onRetry && !isStorm`，`store_locked`
  // 恰好 `retryable: true` ⇒ 一次被存储拒绝的写操作会递给用户一个"重试"按钮，按下去**错误消失、
  // 什么都没重试** —— 失败看起来被解决了，比"点了没反应"更坏：它把证据也抹掉了（onDismiss 的
  // 实现与此逐字相同，两个按钮行为完全一致）。
  { id: 'F-DEV-059', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/FilesApp.svelte', 'crates/amos-tauri/frontend-ts/src/svelte/modules/FileErrorBanner.svelte'], markers: ['retryAction', 'REQ-A468'], severity: 3 },
  // REQ-A469: **那道"诚实边界"其实是两处抽取器缺陷** —— REQ-A467 的 union-alias 不匹配之所以能长期
  // 存活，是因为 `scripts/tauri-reply-scan.mjs` **根本没看到那一对**：`parseInvokeGenerics` 要求命令名
  // 是**双引号**，而 `invoke<AirPlayResult>('airplay_connect')` 用单引号 ⇒ `lib/airplay.ts` 里 **9 个**
  // typed invoke（整个 AirPlay 回复面）对该扫描不可见（而兄弟扫描器 `tauri-args-scan` 早就同时接受两种
  // 引号）；且 `parseRustShapes` **从不记录 tag 的值** ⇒ 即便解析到也没有可比的东西。本轮补上
  // `variantTag()`（对**变体名**应用 `rename_all` —— 既有的字段重命名器在这里会返回 Rust 拼写而漏报）、
  // `parseTsTaggedUnions()`（两种引号）与单引号 invoke 抽取；报告从 `107 checked / 93 skipped` 变成
  // `116 / 93`，负控（把 `snake_case` 换回 `lowercase`）逐条点名 6 个 airplay 命令。
  { id: 'F-DEV-060', module: 'process', files: ['scripts/tauri-reply-scan.mjs'], markers: ['variantTag', 'parseTsTaggedUnions', 'REQ-A469'], severity: 3 },
  // REQ-A410: **一个功能的两半各自"完成"了，中间那半没人接** —— `fail_command`（唯一写
  // `status = 'failed'` 的人）没有任何调用者，而 ack 协议只有 `result: Option<String>`、**没有失败
  // 信号** ⇒ 一台回报「lock 失败」的设备被记成 `acknowledged`：运维在控制台读到的是"已完成"，而设备
  // 根本没有锁屏 —— 企业场景里这是"远程锁定"这个承诺本身失效。修法：`AckCommandRequest` 增加
  // `ok: Option<bool>`（**加法**：设备代理不在本仓，缺失该字段必须继续按旧语义工作），handler 按
  // `ok:false` 走 `fail_command`，并把**实际记下的**状态回给设备。
  // **接线时又暴露一个被基线掩盖的缺陷**：`fail_command` 只按 command id 定界（`WHERE id = ?`），
  // 任何调用者都能把**别的设备**的命令标成失败 —— 它当时没有调用者，所以这条定界缺口从未被触发；
  // 现在加了 `device_id`，与 `ack_command`（REQ-A411）同一条纪律。
  { id: 'F-DEV-061', module: 'amos-mdm', files: ['crates/amos-mdm/src/models.rs', 'crates/amos-mdm/src/db.rs', 'crates/amos-mdm/src/handlers.rs'], markers: ['AckCommandRequest', 'fail_command', 'REQ-A410'], severity: 4 },
  // REQ-A470: **事件在发、界面在猜** —— `amos-int` 的会话状态机有 8 个状态，`session.rs` 在启动与**每次**
  // 迁移时发出 `state_changed`（`payload.state = format!("{s:?}").to_lowercase()`），而
  // `InterpApp.svelte` 的事件链里**没有这个 kind**：屏幕只按自己的动作维护 `status`（语言对 / 离线 /
  // 权限 / 结束 / 错误），于是 daemon 正在翻译时界面可能还显示着语言对，用户读到的"当前在做什么"是**屏
  // 幕自己的猜测**而不是引擎的事实。修法：消费 `state_changed` 并把 daemon 的**原话**渲染成一个状态
  // 标签（`t(\`interp.state.${token}\`)`，8 个状态各有 en/zh 文案）；`ended`/`error` 两个状态**不**渲染
  // ——它们在 `status` 行上已经带着 daemon 自己的措辞（`session_ended` / `error`），同一件事只出现一次。
  // 没有标签的 token 会被**原样显示**（`t()` 回落到 key 本身），不是静默。
  { id: 'F-DEV-062', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/InterpApp.svelte', 'crates/amos-int/src/state.rs'], markers: ['daemonState', 'STATUS_OWNED_STATES', 'REQ-A470'], severity: 2 },
  // REQ-A471: **没人读的编译器警告** —— `svelte-check` 一直在 `bun run check` / `make check` / CI 里跑，
  // 但**没有** `--fail-on-warnings`：于是 3 条 a11y 警告（`VoiceMemosApp` 两个未与控件关联的 `<label>`、
  // `FilesApp` 预览里一个没有 captions track 的 `<video>`）长期停在输出里，而门禁是绿的。**两个仪器都
  // 沉默**：本仓自研的 `a11y-scan`（6 个启发式维度）报 **0 缺口** —— 它看不见
  // `a11y_label_has_associated_control` 与 `a11y_media_has_caption` 这两类。修法：①两个滑杆的
  // `<label>` 补 `for`/`id`（输入本来就有同名 `aria-label`，可访问名不变，缺的只是"标签属于这个控件"
  // 这层关系）；②用户自己视频的 `<video>` 用**带理由的** `svelte-ignore`（字幕只能来自文件本身，凭空
  // 造一个 track 等于在屏幕上放一句没人做过的声明）；③`typecheck:svelte` 加 `--fail-on-warnings`
  // ⇒ 这一类从此不能回来（负控：同一棵树带 flag 退出 1、不带 flag 退出 0）。
  { id: 'F-DEV-063', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/package.json', 'crates/amos-tauri/frontend-ts/src/svelte/VoiceMemosApp.svelte', 'crates/amos-tauri/frontend-ts/src/svelte/FilesApp.svelte'], markers: ['fail-on-warnings', 'vm-trim-start', 'a11y_media_has_caption', 'REQ-A471'], severity: 2 },
  // REQ-A472: **豁免的理由没人复核，放宽的 flag 没人签名** —— REQ-A471 收口时把两件事如实记成了"开着的"：
  // ①`--compiler-warnings`（逐条规则 ignore/error）**没有跨文件载体**，将来要放宽某条规则只能去
  // `package.json` 改 flag，而**那里没有写理由的地方**；②`svelte-ignore` 是**局部**豁免、理由写在站点上，
  // 而**没有任何门禁检查这条理由是否仍然成立**（本仓对 JSON allowlist 有棘轮纪律，对编译器豁免还没有）。
  // **实测（本轮探针）**：`svelte-check` 对**拼错的/上游删掉的** code 会报 `unknown_code`（`--fail-on-warnings`
  // 已让它致命 ✓），但对**已经不需要的**豁免**一句话都不说** —— 把 `a11y_media_has_caption` 的 ignore 挪到
  // 一个 `<div>` 上，svelte-check 报 `0 errors and 0 warnings` ⇒ 修复前"理由是否仍然成立"**没有任何仪器**。
  // 修法：新增 `scripts/svelte-ignore-allowlist.json`（载体：每个 file+code 一条带理由的登记 + `compilerWarnings`
  // 的逐条放宽登记）与 `scripts/svelte-ignore-scan.mjs`：**R0** 单行可解析；**R1** 每个站点必须被登记；
  // **R2** 登记的理由必须**逐字引用站点注释**（两个载体不许漂移）；**R3** 没有站点的登记是 finding（清单不许烂，
  // 也不许"预先允许"一个没人写的豁免）；**R4** 站点必须保留真正的散文理由；**R5** **liveness** —— 删掉豁免、
  // 把**那一条** code 强制成 `error`、要求它**真的再次触发**（唯一能区分"活的豁免"与"退休的豁免"的仪器；
  // 文件在 `finally` 里按字节还原 + sha256 校验，还原失败 `exit 2`，不留下被改过的树）；**R6** `package.json`
  // 的 `--compiler-warnings` 必须与 JSON 载体**逐条一致**，每个被放宽的 code 都要在**那一条**上写理由
  // （今天两边都空 ⇒ 门禁断言"没有任何规则被放宽"）。合法 code 集**从安装的 svelte 编译器里读**
  // （`warnings.js` 的 `codes[]`/`w()` + `constants.js` 的 IGNORABLE_RUNTIME_WARNINGS）：语法本身分不清
  // "一个 code"与"一个词"（`<!-- svelte-ignore a11y_x, because … -->` 会产出 token `because`）。
  { id: 'F-DEV-064', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/scripts/svelte-ignore-scan.mjs', 'crates/amos-tauri/frontend-ts/scripts/svelte-ignore-allowlist.json', 'crates/amos-tauri/frontend-ts/package.json'], markers: ['svelte-ignore-allowlist.json', 'REQ-A472', 'liveness', 'svelteignore:scan'], severity: 2 },

  // REQ-A409: BLE GATT 写后 read 缓存被读成"已写入"，但实际是前一次应答。
  // `ble::install_glue` 一次性注入 `JavaVM` + `Context`；读写命令走严格 `JValue` 类型；
  // `pending_read` 仅由 Kotlin `onCharacteristicReadResult` 写入并 `take` 后即清空。
  { id: 'F-DEV-014', module: 'process', files: ['crates/amos-tauri/src/ble.rs', 'crates/amos-tauri/src/jni_glue.rs'], markers: ['ble_connect', 'take_pending_read', 'with_binding', 'REQ-A409'], severity: 3 },
  // REQ-A409: NFC 写一条 NDEF 之后 UI 立即读，UI 看到的不是刚刚写的那条。
  // `nfc_start_dispatch` 走 `NfcGlue.init(context)`；`nfc_write_message` 把 `Vec<NdefRecord>`
  // 转 `ArrayList<HashMap>` 后 JNI 调用，写完返回 `bytes_written`；`nfc_read_bytes` 同步返回。
  { id: 'F-DEV-015', module: 'process', files: ['crates/amos-tauri/src/ble.rs', 'crates/amos-tauri/android-glue/com/amos/ai/glue/NfcGlue.kt'], markers: ['nfc_start_dispatch', 'nfc_write_message', 'NfcGlue', 'REQ-A409'], severity: 3 },
  // REQ-A409: BiometricPrompt 在非用户手势上下文被触发 ⇒ Android 12+ 静默失败。
  // `biometric_authenticate` 是 `tauri::command`；`BiometricGlue.authenticate` 走
  // `BiometricPrompt.authenticate(promptInfo, callback)`；pending 绝不四舍五入成 `ok=true`。
  { id: 'F-DEV-016', module: 'process', files: ['crates/amos-tauri/src/ble.rs', 'crates/amos-tauri/android-glue/com/amos/ai/glue/BiometricGlue.kt'], markers: ['biometric_authenticate', 'BiometricPrompt', 'onBiometricResult', 'REQ-A409'], severity: 4 },
  // REQ-A409: 视频录制 metadata 进 `SensorHost` 但 snapshot 不返回。
  // `sensor_host_record_video` 把 `HostVideoClip` 压入 `video_clips: Mutex<Vec<_>>`（环形 32
  // 条上限），`snapshot()` 一并返回；`MAX_CLIP_BYTES = 4 GiB` 写前硬卡，溢出返 `Err`。
  { id: 'F-DEV-017', module: 'process', files: ['crates/amos-tauri/src/sensor_host.rs'], markers: ['sensor_host_record_video', 'video_clips', 'MAX_CLIP_BYTES', 'REQ-A409'], severity: 2 },
  { id: 'F-DEV-002', module: 'process', files: ['scripts/fmea-gen.mjs', 'docs/FMEA.md'], markers: ['tableShapeProblems', 'cell count != their header', 'FMEA_DOC'], severity: 3 },
  // REQ-A365 收口: `pidof` exits 1 when the app is gone — a normal *answer*, not "adb is broken"
  { id: 'F-DEV-003', module: 'process', files: ['scripts/device-ui-eval.mjs'], markers: ['adbRaw', 'exited ${r.status}', 'app is not running'], severity: 2 },
  // REQ-A367: a stalled page used to report a symptom with no cause; the cause is now read from
  // the device, and the table is required to be able to say "the device state is NOT the reason"
  { id: 'F-DEV-004', module: 'process', files: ['scripts/device-ui-eval.mjs'], markers: ['explainUnready', 'mCurrentFocus', 'PAUSES', 'NOT** the reason'], severity: 2 },
  // REQ-A367: `--wait <ms>`'s value was taken for the expression (`evaluate(5000)` printed as the
  // page's answer, exit 0) — an instrument that silently answers a different question
  { id: 'F-DEV-005', module: 'process', files: ['scripts/device-ui-eval.mjs'], markers: ['expressionArg', 'VALUE_FLAGS'], severity: 2 },
  // REQ-A368: the shade was a coincidence — the renderer never started; and my first version of
  // that check read a logcat *window*, so the decisive line had already scrolled away (F-DEV-001's
  // lesson: never make a time-windowed sample the verdict; read the current state instead)
  { id: 'F-DEV-006', module: 'process', files: ['scripts/device-ui-eval.mjs'], markers: ['parseDeadRendererConnection', 'CR DEAD', 'dumpsys activity processes'], severity: 2 },
  // REQ-A371: the requirements ledger (docs/TRACEABILITY_MATRIX.md) had no gate at all, so a
  // duplicated REQ id and a status cell outside the document's own legend survived in the one
  // artefact every reader is sent to (the F-DEV-002 family, one document over).
  { id: 'F-DEV-007', module: 'process', files: ['scripts/trace-scan.mjs'], markers: ['duplicateReqIds', 'missing-status', 'STATUS_MARKS'], severity: 2 },
  // REQ-A372: the ledger's *completeness* claim was never checked — 54 requirement numbers are
  // cited by shipped code and have no row, and the header read as if it were the whole index.
  { id: 'F-DEV-008', module: 'process', files: ['scripts/trace-scan.mjs', 'docs/TRACEABILITY_MATRIX.md'], markers: ['danglingCitations', 'partial', 'REQ-A372'], severity: 2 },
  // REQ-A381: the link gate called itself a hard gate while the tree was red — a committed
  // archive snapshot (40/53 files unique in the repo) contributed 119 broken links and nobody
  // had ever decided whether a frozen snapshot is in scope; 6 more came from three untracked
  // root documents written with another directory's relative paths.
  { id: 'F-DEV-009', module: 'process', files: ['scripts/docs-link-scan.mjs'], markers: ['SKIP_PATHS', 'were NOT judged', 'skipped'], severity: 2 },
  // REQ-A382 corrected this row: the surface IS wired in the tree (the loader line predates the
  // device round), so the reading came from an APK older than the System Monitor commit — and the
  // gate gap it named is real: the registry test iterated a hand-copied id list. See F-SH-026.
  { id: 'F-SH-025', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/appRegistry.ts', 'crates/amos-tauri/frontend-ts/src/svelte/MonitorApp.svelte'], markers: ['没有可显示的界面', 'monitor'], severity: 2 },
  // REQ-A382: the tile<->loader consistency test validated a hand-copied list (29 ids) while the
  // live grid table had 33 — a new tile with no screen could not fail any gate.
  { id: 'F-SH-026', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/svelte-tests/app-registry.svelte.test.ts', 'crates/amos-tauri/frontend-ts/src/svelte/appRegistry.ts'], markers: ['missingLoaders', 'unreachableScreens', 'the comparison itself can fail'], severity: 2 },
  // REQ-A410: voice memo playback progress, edit/trim (edit-keep), and ASR transcription were missing.
  { id: 'F-SH-027', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/voiceMemos.ts', 'crates/amos-tauri/frontend-ts/src/svelte/VoiceMemosApp.svelte'], markers: ['progressPercent', 'clampTrimRange', 'trimMemo', 'classifyTranscribe', 'REQ-A410'], severity: 3 },
  { id: 'F-SH-028', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/DesktopAppWindow.svelte', 'crates/amos-tauri/frontend-ts/svelte-tests/desktop-app-window.svelte.test.ts', 'crates/amos-tauri/src/menu.rs'], markers: ['loadDesktopFeatures', 'REQ-A453', 'desktop_features_disabled', 'menu item activated'], severity: 2 },
  { id: 'F-SH-029', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/files.ts', 'crates/amos-tauri/frontend-ts/src/svelte/FilesApp.svelte', 'crates/amos-tauri/frontend-ts/svelte-tests/files.svelte.test.ts'], markers: ['moveToTrash', 'commitTrash', 'REQ-A455', 'amos.files.trash'], severity: 3 },
  { id: 'F-SH-030', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/Dock.svelte', 'crates/amos-tauri/frontend-ts/src/lib/amosStore.ts', 'crates/amos-tauri/frontend-ts/svelte-tests/dock-reorder.svelte.test.ts'], markers: ['reorderVisibleDock', 'dockReorderIds', 'REQ-A456', 'data-dock-drop-target'], severity: 2 },
  { id: 'F-SH-031', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/svelte/modules/TopbarMainMenu.svelte', 'crates/amos-tauri/frontend-ts/src/svelte/DesktopShell.svelte', 'crates/amos-tauri/frontend-ts/svelte-tests/topbar-main-menu.svelte.test.ts'], markers: ['applyWindowAction', 'windowAction', 'REQ-A457', 'enterFullScreen'], severity: 3 },
  { id: 'F-SH-032', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/spotlightSearch.ts', 'crates/amos-tauri/frontend-ts/src/lib/calculator.ts', 'crates/amos-tauri/frontend-ts/src/svelte/FilesApp.svelte', 'crates/amos-tauri/frontend-ts/svelte-tests/spotlight-search.svelte.test.ts'], markers: ['buildSpotlightResults', 'calcQuery', 'FILES_REVEAL_KEY', 'REQ-A458'], severity: 2 },

  // System UI 桥
  { id: 'F-TAU-001', module: 'amos-tauri', files: ['crates/amos-tauri/frontend-ts/src/lib/backend.ts'], markers: ['bridgeDiag', 'ok-error'], severity: 3 },
  { id: 'F-TAU-002', module: 'amos-tauri', files: ['crates/amos-tauri/src/ai_bridge.rs'], markers: ['ask_daemon', 'deadline'], severity: 4 },
  { id: 'F-TAU-003', module: 'amos-tauri', files: ['crates/amos-tauri/src/clipboard_guest_link.rs'], markers: ['clipboard_guest_status', 'audit'], severity: 5 },
  { id: 'F-TAU-004', module: 'amos-tauri', files: ['crates/amos-tauri/frontend-ts/src/svelte/ClipboardAnnounce.svelte'], markers: ['clipboard-changed', 'metadata'], severity: 4 },
  { id: 'F-TAU-005', module: 'amos-tauri', files: ['crates/amos-ai/src/governor_service.rs'], markers: ['mirror_failed'], severity: 3 },
  { id: 'F-TAU-006', module: 'amos-tauri', files: ['crates/amos-tauri/src/devcare.rs'], markers: ['UninstallGuard'], severity: 4 },
  { id: 'F-TAU-009', module: 'amos-tauri', files: ['crates/amos-tauri/src/ai_bridge.rs'], markers: ['persist_cloud_key', '0600'], severity: 4 },
  // REQ-A369: the OS can *refuse* exact alarms — that refusal has to be a visible state, not a
  // log line, or the user believes in an alarm that will not wake a dozing phone (F-TAU-007's
  // sibling). Mitigations: the glue's status words, the typed DeviceOutcome, the Clock banner.
  { id: 'F-TAU-010', module: 'amos-tauri', files: ['crates/amos-tauri/src/alarm_sched.rs', 'crates/amos-tauri/frontend-ts/src/svelte/ClockApp.svelte', 'crates/amos-tauri/android-glue/com/amos/ai/glue/AlarmGlue.kt'], markers: ['DeviceOutcome', 'nativeWakeUnavailable', 'STATUS_DISALLOWED'], severity: 2 },
  // REQ-A373: two alarms whose ids merely *hash* alike collapsed into one PendingIntent (extras are
  // not part of its equality) — the wrong alarm rings / a cancel hits both. Fixed by a per-id data
  // URI, pinned by a host-JVM test whose negative control fails 3/3.
  { id: 'F-TAU-011', module: 'amos-tauri', files: ['crates/amos-tauri/android-glue/com/amos/ai/glue/AlarmGlue.kt', 'crates/amos-tauri/android-glue/tests/com/amos/ai/glue/AlarmIdentityTest.kt'], markers: ['alarmIdentity', 'setData(Uri.parse(alarmIdentity(id)))', 'collidingHashCodesStillGetDistinctIdentities'], severity: 3 },
  // REQ-A373: the alarm fires, but "bring the ring UI to the front" is blocked for a background app
  // on Android 10+ — the code claimed it worked; the production path (full-screen-intent
  // notification) is registered but deliberately NOT shipped untested.
  { id: 'F-TAU-012', module: 'amos-tauri', files: ['crates/amos-tauri/android-glue/com/amos/ai/glue/AlarmGlue.kt', 'crates/amos-tauri/android-glue/tests/com/amos/ai/glue/AlarmNotifyStatusTest.kt', 'docs/native-alarm-bridge.md'], markers: ['notifyAlarm', 'setFullScreenIntent', 'notifyStatus', 'F-TAU-012'], severity: 4 },
  // REQ-A374: the ledger bounded its keys but not its size (a WebView-callable command), and the
  // settings path read an Activity reference across threads without a happens-before edge.
  { id: 'F-TAU-013', module: 'amos-tauri', files: ['crates/amos-tauri/src/alarm_sched.rs', 'crates/amos-tauri/android-glue/com/amos/ai/glue/AlarmGlue.kt'], markers: ['MAX_ALARM_ENTRIES', 'check_alarm_capacity', '@Volatile'], severity: 2 },
  // REQ-A376 (device-found): a Kotlin `object`'s member is not a static method unless it is
  // annotated, so every Rust `call_static_method` into AlarmGlue threw NoSuchMethodError — and no
  // gate could see it (both sides compile, the class exists, the signature string is right).
  // REQ-A377 closed the "no gate" half: `jni-contract-scan` R1 checks every static call into the
  // glue against the Kotlin member's `@JvmStatic` (and R2 pairs `external fun` ↔ `Java_…`).
  { id: 'F-TAU-014', module: 'amos-tauri', files: ['crates/amos-tauri/android-glue/com/amos/ai/glue/AlarmGlue.kt', 'crates/amos-tauri/src/alarm_sched.rs', 'scripts/jni-contract-scan.mjs'], markers: ['@JvmStatic', 'KOTLIN → RUST CONTRACT', 'clear_pending', 'missing-jvmstatic'], severity: 3 },
  // REQ-A376 (device-found): this ROM's NotificationService refuses a full-screen-intent
  // notification without WAKE_LOCK, so the ring vanished while the alarm itself still fired.
  { id: 'F-TAU-015', module: 'amos-tauri', files: ['crates/amos-tauri/android-glue/AndroidManifest.permissions.xml', 'scripts/android-permission-scan.mjs'], markers: ['WAKE_LOCK', 'alarm-notification'], severity: 3 },
  // REQ-A378: the *instance* half of the same boundary — Rust holds a Kotlin handle (the
  // `object` singleton from `bind()`, the bridge from `attach(bridge)`) and calls it with
  // `call_method`, which JNI resolves by name *and* arity: a Kotlin rename or a parameter
  // change is a NoSuchMethodError that neither R1 (static) nor R2 (external fun) could see.
  { id: 'F-TAU-016', module: 'amos-tauri', files: ['scripts/jni-contract-scan.mjs', 'crates/amos-tauri/src/mic_permission.rs', 'crates/amos-tauri/android-glue/com/amos/ai/glue/MicPermissionGlue.kt'], markers: ['missing-kotlin-member', 'arity-mismatch'], severity: 3 },
  // REQ-A379: a manifest component is a name the platform resolves at *instantiation* time — a
  // name with no class (or of the wrong kind) builds fine and then simply never runs, exactly
  // the F-TAU-007 symptom on the other side of the same seam. A `System.loadLibrary` name no
  // crate builds is the same class of defect (UnsatisfiedLinkError at class init).
  { id: 'F-TAU-017', module: 'amos-tauri', files: ['scripts/android-component-scan.mjs', 'crates/amos-tauri/android-glue/AndroidManifest.components.xml'], markers: ['missing-kotlin-class', 'unknown-library', 'unknown-action', 'missing-sender-permission'], severity: 3 },
  // REQ-A380: the platform's own linter never ran in this repo — "does this API exist on
  // minSdk 26" and "does this call need a permission nobody checks" are invisible to the
  // compiler (20 errors in our glue on the first run: 5 × NewApi, 8 × MissingPermission),
  // and an API-29-only MediaStore path was silently dead on API 26..28.
  { id: 'F-TAU-018', module: 'amos-tauri', files: ['scripts/android-glue-nv21-check.sh', 'crates/amos-tauri/android-glue/com/amos/ai/glue/TetheringGlue.kt', 'crates/amos-tauri/android-glue/com/amos/ai/glue/MediaStoreGlue.kt'], markers: ['lintArmDebug', 'RequiresApi(TETHERING_API)', 'mediaCollection'], severity: 3 },
  { id: 'F-TAU-008', module: 'amos-tauri', files: ['crates/amos-tauri/frontend-ts/src/lib/uiFailures.ts'], markers: ['unhandledrejection', 'error'], severity: 3 },

  // 机器人中间件
  { id: 'F-LK-001', module: 'amos-link', files: ['crates/amos-link/src/robot_hal.rs'], markers: ['estop', 'deadman'], severity: 4 },
  { id: 'F-LK-002', module: 'amos-link', files: ['crates/amos-link/src/service.rs'], markers: ['ListActuations', 'return path'], severity: 5 },
  { id: 'F-LK-003', module: 'amos-link', files: ['crates/amos-link/src/codec.rs'], markers: ['crc32_over', 'Hasher'], severity: 4 },
  { id: 'F-LK-004', module: 'amos-link', files: ['crates/amos-link/src/discovery.rs', 'crates/amos-link/src/lan.rs'], markers: ['AMOS_LINK_BEACON_IFACE'], severity: 4 },
  { id: 'F-LK-005', module: 'amos-link', files: ['crates/amos-link/src/node.rs'], markers: ['with_local', 'self_entries_refused'], severity: 3 },
  { id: 'F-LK-006', module: 'amos-link', files: ['crates/amos-link/src/keyexpr.rs'], markers: ['MAX_SEGMENTS', 'iterative'], severity: 3 },
  { id: 'F-LK-007', module: 'amos-link', files: ['crates/amos-link/src/broker.rs'], markers: ['LinkError::Closed'], severity: 4 },
  { id: 'F-LK-008', module: 'amos-link', files: ['crates/amos-link/src/service.rs'], markers: ['count_to_u32', 'saturating'], severity: 3 },
  { id: 'F-LK-009', module: 'amos-link', files: ['crates/amos-link-cli/src/lib.rs'], markers: ['deadline_after', 'exit 2'], severity: 4 },
  { id: 'F-LK-010', module: 'amos-link', files: ['crates/amos-link/src/service.rs', 'crates/amos-link-cli/src/lib.rs'], markers: ['StreamRobotHal', 'motor --device'], severity: 5 },
  // REQ-A268: 一个「发不出信标」的节点在 LAN 上静默不可见 —— 逐字段界不够(8×128B > 512B 帧),
  // 公告因此在启动期被校验(探针编码),而不是在 emit 路径上被 debug! 静默丢掉
  { id: 'F-LK-011', module: 'amos-link', files: ['crates/amos-link/src/discovery.rs', 'crates/amos-link-cli/src/lib.rs'], markers: ['PeerInfo::advertising', 'parse_endpoints', '--endpoint'], severity: 4 },
  // REQ-A269: 时钟不一致（戳在未来）被读成 0 延迟 —— 帧的年龄必须说 unknown，bench 必须计数而不是采样
  { id: 'F-LK-012', module: 'amos-link-cli', files: ['crates/amos-link-cli/src/lib.rs', 'crates/amos-link/src/pubsub.rs'], markers: ['age_between', 'skewed', 'InTheFuture'], severity: 3 },
  // REQ-A270: 仪器在真网络上失明 —— 传输不计数 ⇒ 节点终生报 published=0（而 0 被读成「没发过」）
  { id: 'F-LK-013', module: 'amos-link', files: ['crates/amos-link/src/zenoh.rs', 'crates/amos-link/src/broker.rs', 'crates/amos-link/src/node.rs'], markers: ['record_published', 'fn metrics(&self) -> Arc<LinkMetrics>', 'not its transport'], severity: 4 },
  // REQ-A271: 老 daemon 少一个 RPC ⇒ 整个页面/命令被拖下水，而文档承诺的只是「少显示一栏」
  { id: 'F-LK-014', module: 'amos-tauri', files: ['crates/amos-tauri/src/link.rs', 'crates/amos-link-cli/src/lib.rs'], markers: ['Unimplemented', 'returnPathLevel', 'actuations: Option'], severity: 3 },
  // REQ-A272: QoS 只在进程内成立 —— 网络传输上「最新帧赢」变成「最老帧」、DropNewest 从不生效、订阅计数器恒为 0
  { id: 'F-LK-015', module: 'amos-link', files: ['crates/amos-link/src/zenoh.rs', 'crates/amos-link/src/broker.rs'], markers: ['remote_latest', 'RelayCounters', 'forward_latest'], severity: 4 },
  // REQ-A277: 平台剖面机器未解锁 ⇒ motion 被拒并点名解锁动作;参考机的运动批次自带 Enable,该分支对它永不触发
  { id: 'F-LK-016', module: 'amos-link', files: ['crates/amos-link/src/robot_hal.rs', 'crates/amos-link/src/platform.rs'], markers: ['for_platform', 'Vocabulary::Profile', 'must_be_armed'], severity: 3 },
  // REQ-A277: 剖面参考机兼容性 — Platform::quadruped() 必须对每步态×速度产出与手写 plan 字节完全相同的帧(含前导 Enable(0))
  { id: 'F-LK-017', module: 'amos-link', files: ['crates/amos-link/src/platform.rs', 'crates/amos-link/src/robot_hal.rs'], markers: ['Platform::quadruped', 'plan as plan_reference', 'Vocabulary::Reference'], severity: 3 },
  // REQ-A281: 固定位姿动作上的 speed 曾被收下、校验、然后丢掉(takeoff 的 0.0 与 1.0 产出同一批帧) ——
  // 操作员以为生效了。实测出来的,不是读出来的:解析失败比静默忽略安全。
  { id: 'F-LK-018', module: 'amos-link', files: ['crates/amos-link/src/platform.rs'], markers: ['has a fixed pose, so `speed`', 'speed_scaled: false'], severity: 3 },
  // REQ-A281: 同一执行器两个设定点曾被 find() 静默取第一个 —— JSON 字段顺序决定了无人机飞哪个推力
  { id: 'F-LK-019', module: 'amos-link', files: ['crates/amos-link/src/platform.rs'], markers: ['is named twice in one intent', 'SetPoint'], severity: 3 },
  // REQ-A281: 只有目标参数的动作(goto/waypoint)曾被允许不带参数 ⇒ 飞出默认位姿,动作名在撒谎
  { id: 'F-LK-020', module: 'amos-link', files: ['crates/amos-link/src/platform.rs', 'crates/amos-link/tests/platform_cases.rs'], markers: ['min_params', 'a target is not a default'], severity: 3 },
  // REQ-A281: 「机器是数据」曾是空话 —— 字段私有 + 六份 const ⇒ 部署只能改这个 crate。from_parts 把
  // 内置剖面同一条校验规则交给部署自己写的机器(否则手写剖面可以带着自相矛盾的词表上线)
  { id: 'F-LK-021', module: 'amos-link', files: ['crates/amos-link/src/platform.rs', 'crates/amos-link/tests/platform_cases.rs'], markers: ['pub fn from_parts', 'pub fn validate(&self) -> Result<()>', 'validate_actions'], severity: 4 },

  // 数据完整性
  { id: 'F-DA-001', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/amosStore.ts'], markers: ['readJson', 'corrupt'], severity: 3 },
  { id: 'F-DA-002', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/amosStore.ts'], markers: ['listQuarantined', 'readQuarantine'], severity: 2 },
  { id: 'F-DA-003', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/bounded.ts'], markers: ['capTail', 'CHAT_MSG_CAP'], severity: 3 },
  { id: 'F-DA-004', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/cloud.ts'], markers: ['SYNC_STORES', 'snapshotStores'], severity: 4 },
  { id: 'F-DA-005', module: 'amos-ai', files: ['crates/amos-ai/src/server.rs', 'crates/amos-ai/src/session.rs'], markers: ['GetHistory', 'history'], severity: 3 },
  // REQ-A401: 一份"时钟 + 一把随机数字"的 id 就是一个*赌*：冻结时钟下 5 位 base36（≈26 bit）
  // 在 20,000 次紧循环里撞 3 次（前端实测，种子可复算），而撞了**没有任何东西会报错** ——
  // 媒体字节被后一次覆盖、通知按 id 去重后被丢掉、流式气泡按 id 串号。身份改走 `localId()`
  // （进程内单调计数器），并由 `scripts/idgen-scan.mjs` 的 R1/R2 钉住（id 惯用法不可豁免）。
  { id: 'F-DA-006', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/src/lib/localId.ts', 'crates/amos-tauri/frontend-ts/scripts/idgen-scan.mjs'], markers: ['localId', 'seq', 'id-idiom'], severity: 3 },
  // REQ-A402: 同一族的另一半 —— "时钟 + 进程内计数器"**没有熵**。两个上下文在同一毫秒铸 id 得到
  // 同一个字符串（前端实测：两个进程 + 冻结时钟都产出 `loyw3v28-1`，而 `localId` 有 7 位 crypto 尾），
  // 消费者还是静默的：voiceMemos/calendars 丢行、notes/events 改名、conversations 曾根本不查重
  // （删一个会话删掉两个）。现已并入 `localId()`，并由 idgen-scan 的 R3（`id-from-clock`，不可豁免，
  // 按名豁免 `localId.ts` 本身）钉住 —— 这一族的**新成员**也逃不过。
  // REQ-A403: "我们的测试不打网络"此前没有任何东西在验，而这个缺陷的形态**静态扫描看不见** ——
  // 模块自己 catch 网络错误并降级（`fetchDeclination`）⇒ 没打桩的测试照样绿。哨兵在运行时记录 + 拒绝
  // 未打桩的 fetch（打桩不受影响；还原到的是哨兵），两个 runner 各自归因到文件/用例。
  { id: 'F-DA-008', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/scripts/net-sentinel.mjs', 'crates/amos-tauri/frontend-ts/svelte-tests/setup-net-sentinel.ts'], markers: ['AMOS-NET-SENTINEL', 'rearm', 'egressRecords'], severity: 3 },
  { id: 'F-DA-007', module: 'frontend', files: ['crates/amos-tauri/frontend-ts/scripts/idgen-scan.mjs', 'crates/amos-tauri/frontend-ts/src/lib/localId.ts'], markers: ['id-from-clock', 'clockInTemplate', 'localId'], severity: 3 },

  // Android 集成
  { id: 'F-AND-001', module: 'amos-tauri', files: ['crates/amos-tauri/android-glue/com/amos/ai/glue/CameraGlue.kt'], markers: ['attach', 'detach', 'epoch'], severity: 4 },
  { id: 'F-AND-002', module: 'amos-ai', files: ['crates/amos-ai/src/governor_service.rs'], markers: ['mirror_failed'], severity: 4 },
  { id: 'F-AND-003', module: 'amos-tauri', files: ['crates/amos-tauri/src/devcare.rs', 'crates/amos-tauri/src/devcare_device.rs'], markers: ['BatteryReading', 'chargingFrom'], severity: 3 },
  { id: 'F-AND-004', module: 'amos-android', files: ['crates/amos-android/src/manager.rs'], markers: ['AMOS_ANDROID_INSTALL_TIMEOUT'], severity: 3 },
  { id: 'F-AND-005', module: 'amos-tauri', files: ['crates/amos-tauri/src/devcare_device.rs'], markers: ['spawn_blocking'], severity: 4 },

  // 真机设备
  { id: 'F-TEL-001', module: 'amos-telephony', files: ['crates/amos-telephony/src/service.rs', 'crates/amos-telephony/src/route.rs'], markers: ['emergency', 'no-record'], severity: 5 },
  { id: 'F-TEL-002', module: 'amos-blocklist', files: ['crates/amos-blocklist/src/lib.rs'], markers: ['blocklistCheck', 'Rule'], severity: 4 },
  { id: 'F-RAD-001', module: 'amos-radio', files: ['crates/amos-radio/src/lib.rs'], markers: ['RadioManager', 'airplane cascade'], severity: 4 },
  { id: 'F-SEN-001', module: 'amos-sensor', files: ['crates/amos-sensor/src/lib.rs'], markers: ['SensorManager', 'set_mode'], severity: 3 },
];

/**
 * 校验:每个登记的失效模式,其缓解代码是否至少有一个 marker 在其 file 之一出现
 */
function verifyMitigation(failure) {
  const found = [];
  for (const f of failure.files) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) {
      return { ok: false, reason: `file not found: ${f}` };
    }
    const text = fs.readFileSync(abs, 'utf8');
    const hits = failure.markers.filter(m => text.includes(m));
    if (hits.length > 0) {
      found.push({ file: f, markers: hits });
    }
  }
  if (found.length === 0) {
    return {
      ok: false,
      reason: `none of [${failure.markers.join(', ')}] found in [${failure.files.join(', ')}]`,
    };
  }
  return { ok: true, evidence: found };
}

function buildReport() {
  const rows = KNOWN_FAILURES.map(f => ({
    id: f.id,
    module: f.module,
    severity: f.severity,
    files: f.files,
    markers: f.markers,
    mitigation: verifyMitigation(f),
  }));
  return rows;
}

/**
 * 表格形状检查（REQ-A363）：**每一行的单元格数必须等于它所在表的表头**。
 *
 * 为什么需要它：`--check` 原本只验"ID 在不在清单里"与"缓解代码在不在"——**列数不验** ✗。
 * 于是少一个单元格的 FMEA 行（S/P/D/RPN 丢一个 ✓）会**通过所有检查，却在 Markdown 里渲染错乱** ✗：
 * 我写 F-SH-022 时把 P 丢了、又少写一个分隔空格，两个单元格被并成一格（实测 8 格 ✓）。
 *
 * 判据用 ` | `（空格-竖线-空格）切分：单元格内部的竖线按 Markdown 规则写作 `\|` ✓，
 * 不会与分隔符混淆 —— 这一点本项目踩过（`awk -F'|'` 会把 `\|` 也当分隔符 ✓）。
 */
export function tableShapeProblems(text) {
  const problems = [];
  let header = null; // 当前表的表头单元格数
  let headerLine = 0;
  text.split('\n').forEach((line, i) => {
    const n = i + 1;
    if (!line.startsWith('|')) {
      header = null;
      return;
    }
    if (/^\|[\s:|-]+\|\s*$/.test(line)) return; // 分隔行 |---|---|
    const cells = line.split(' | ').length;
    if (header === null) {
      header = cells;
      headerLine = n;
      return;
    }
    if (cells !== header) problems.push({ line: n, cells, expected: header, headerLine });
  });
  return problems;
}

/**
 * 同一个 ID 被登记两次。
 *
 * 为什么单列一条判据（REQ-A369）：登记册是**所有失效模式的索引**，一个 ID 对应两种失效模式
 * 会让"按 ID 查找"失去意义 —— 而**没有任何检查看得见**。本仓实测：`F-TAU-007` 被用了两次 ✓
 * （一次是闹钟的"设备绑定从未被调用" ✓，一次是云端 API key 写失败谎报"已保存" ✓），
 * **清单与文档里各两条** ✓（清单 110 行与 133 行 ✓、文档 125 行与 164 行 ✓），而 `--check` 一直
 * 是绿的 ✓ —— 它只问"这个 ID 认识吗" ✗，不问"这个 ID 唯一吗" ✗。
 *
 * ID 只从**表格行的首格**读取 ⇒ 正文里引用某个 ID（"见 F-DEV-002"）依旧合法 ✓。
 */
export function duplicateIdProblems(text) {
  const firstLineOf = new Map();
  const problems = [];
  text.split('\n').forEach((line, i) => {
    if (!line.startsWith('|')) return;
    if (/^\|[\s:|-]+\|\s*$/.test(line)) return;
    const firstCell = line.split(' | ')[0].replace(/^\|\s*/, '').trim();
    const m = /^(F-[A-Z]+-\d+)$/.exec(firstCell);
    if (!m) return;
    const id = m[1];
    if (firstLineOf.has(id)) problems.push({ id, line: i + 1, firstLine: firstLineOf.get(id) });
    else firstLineOf.set(id, i + 1);
  });
  return problems;
}

function cmdCheck() {
  if (!fs.existsSync(FMEA_DOC)) {
    console.error(`[FAIL] fmea-doc: ${FMEA_DOC} not found.`);
    process.exit(1);
  }
  const text = fs.readFileSync(FMEA_DOC, 'utf8');
  const rows = buildReport();

  // (a) 检查文档里出现的所有 F-XXX ID 都对应一个 known failure
  const docIds = new Set([...text.matchAll(/F-[A-Z]+-\d+/g)].map(m => m[0]));
  const knownIds = new Set(KNOWN_FAILURES.map(f => f.id));
  const docButUnknown = [...docIds].filter(id => !knownIds.has(id));
  const knownButDocMissing = [...knownIds].filter(id => !docIds.has(id));

  let bad = false;
  if (docButUnknown.length > 0) {
    bad = true;
    console.error(`[FAIL] fmea-doc: doc lists IDs not in inventory:`);
    for (const id of docButUnknown) console.error(`       - ${id}`);
  }
  if (knownButDocMissing.length > 0) {
    bad = true;
    console.error(`[FAIL] fmea-doc: inventory IDs missing from doc:`);
    for (const id of knownButDocMissing) console.error(`       - ${id}`);
  }

  // (b) 检查缓解代码是否真实存在
  const missingMitigation = rows.filter(r => !r.mitigation.ok);
  if (missingMitigation.length > 0) {
    bad = true;
    console.error(`[FAIL] fmea-doc: mitigations not verifiable in code:`);
    for (const r of missingMitigation) {
      console.error(`       - ${r.id}: ${r.mitigation.reason}`);
    }
  }

  // (c) 表格形状：每行的列数必须与它所在表的表头一致（REQ-A363）
  const shapeProblems = tableShapeProblems(text);
  if (shapeProblems.length > 0) {
    bad = true;
    console.error(`[FAIL] fmea-doc: table rows whose cell count != their header:`);
    for (const p of shapeProblems) {
      console.error(
        `       - line ${p.line}: ${p.cells} cells, but the header on line ${p.headerLine} has ${p.expected}`,
      );
    }
  }

  // (d) 同一 ID 只能登记一种失效模式（REQ-A369）—— 清单与文档两边都要唯一
  const dupInDoc = duplicateIdProblems(text);
  const dupInInventory = (() => {
    const firstSeen = new Map();
    const dup = [];
    for (const f of KNOWN_FAILURES) {
      if (firstSeen.has(f.id)) dup.push({ id: f.id, first: firstSeen.get(f.id) });
      else firstSeen.set(f.id, f.id);
    }
    return dup;
  })();
  if (dupInDoc.length > 0) {
    bad = true;
    console.error(`[FAIL] fmea-doc: the same ID is registered twice in ${FMEA_DOC}:`);
    for (const d of dupInDoc) {
      console.error(`       - ${d.id} on line ${d.line}, already registered on line ${d.firstLine}`);
    }
  }
  if (dupInInventory.length > 0) {
    bad = true;
    console.error(`[FAIL] fmea-doc: the inventory repeats an ID:`);
    for (const d of dupInInventory) console.error(`       - ${d.id}`);
  }

  if (bad) {
    console.error('');
    console.error(`Fix: update docs/FMEA.md (table rows), or update the inventory in scripts/fmea-gen.mjs.`);
    process.exit(1);
  }

  // 报告 RPN 概览
  const bySev = {};
  for (const r of rows) {
    bySev[r.severity] = (bySev[r.severity] ?? 0) + 1;
  }
  console.log(`[OK] fmea-doc: ${rows.length} failure modes documented and mitigations verified.`);
  console.log(`     Severity distribution: ${Object.entries(bySev).sort((a,b)=>b[0]-a[0]).map(([s,n])=>`S${s}=${n}`).join(', ')}`);

  // 高优项提醒(S5)
  const s5 = rows.filter(r => r.severity === 5);
  if (s5.length > 0) {
    console.log(`     [WARN] S5 critical items: ${s5.map(r=>r.id).join(', ')}`);
  }
}

function cmdEmitJson() {
  console.log(JSON.stringify(buildReport(), null, 2));
}

/**
 * 从 FMEA.md §4 解析残余风险表.
 * 返回: Array<{id, rationale, action, accepted_by?, accepted_date?}>
 * 当 §4 表为空时返回空数组(不是错误).
 */
function parseResidualRisks() {
  if (!fs.existsSync(FMEA_DOC)) {
    console.error(`[FMEA-ERR] doc not found: ${FMEA_DOC}`);
    process.exit(3);
  }
  const text = fs.readFileSync(FMEA_DOC, 'utf8');
  // §4 标题:残余风险(已识别且接受),在文档中唯一(§3 是"跨功能风险点").
  const residualSection = text.match(/## 4\. 残余风险\(已识别且接受\)[\s\S]*?(?=## 5\.|## 6\.|$)/);
  if (!residualSection) return [];

  // 表格行: | F-XXX | 理由 | 跟进 | 接受人 | 日期 |
  // 逐行解析(更稳健,避免贪婪匹配).
  const rows = [];
  for (const line of residualSection[0].split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim());
    if (cells.length < 6) continue;
    // 第一列可能是 "F-XXX(描述)" 或纯 "F-XXX";只取 F-ID 部分.
    const idMatch = (cells[1] ?? '').match(/F-[A-Z]+-\d+/);
    if (!idMatch) continue;
    rows.push({
      id: idMatch[0],
      rationale: cells[2] ?? '',
      action: cells[3] ?? '',
      accepted_by: cells[4] || null,
      accepted_date: cells[5] ?? null,
    });
  }
  if (process.env.FMEA_DEBUG) {
    console.error(`[FMEA-DEBUG] residualSection len=${residualSection[0].length}`);
    console.error(`[FMEA-DEBUG] rows=${rows.length}`);
  }
  return rows;
}

function cmdEmitResidual() {
  const risks = parseResidualRisks();
  // 验证:所有残余风险 ID 都存在于主 inventory
  const knownIds = new Set(KNOWN_FAILURES.map(f => f.id));
  const invalid = risks.filter(r => !knownIds.has(r.id));
  if (invalid.length > 0) {
    console.error(`[FAIL] residual IDs not in inventory: ${invalid.map(r=>r.id).join(', ')}`);
    process.exit(1);
  }
  // 验证接受人字段(残余风险必须有文字接受人,否则 CI 应告警).
  // 同时拒绝 "(TBD)" / "TBD" 后缀(防止"alice (TBD)" 这种伪签字溜过).
  const TBD_RE = /\(?\bTBD\b\)?/i;
  const unsigned = risks.filter(r => !r.accepted_by || TBD_RE.test(r.accepted_by));
  const result = { risks, unsigned, total: risks.length, signed: risks.length - unsigned.length };
  console.log(JSON.stringify(result, null, 2));
  if (unsigned.length > 0) {
    console.error(`[FAIL] ${unsigned.length} residual risk(s) lack signed acceptance: ${unsigned.map(r=>r.id).join(', ')}`);
    process.exit(1);
  }
}

function cmdSelfTest() {
  const tests = [
    {
      name: 'inventory has known failure IDs',
      run: () => {
        assert(KNOWN_FAILURES.length >= 30, `expected >=30 known failures, got ${KNOWN_FAILURES.length}`);
        const ids = new Set(KNOWN_FAILURES.map(f => f.id));
        assert(ids.size === KNOWN_FAILURES.length, 'IDs must be unique');
      },
    },
    {
      name: 'FMEA doc exists at expected path',
      run: () => {
        assert(fs.existsSync(FMEA_DOC), `FMEA doc not at ${FMEA_DOC}`);
      },
    },
    {
      name: 'every failure has files and markers',
      run: () => {
        for (const f of KNOWN_FAILURES) {
          assert(Array.isArray(f.files) && f.files.length >= 1, `${f.id}: need >=1 file`);
          assert(Array.isArray(f.markers) && f.markers.length >= 1, `${f.id}: need >=1 marker`);
          assert(f.severity >= 1 && f.severity <= 5, `${f.id}: severity 1-5`);
        }
      },
    },
    {
      name: 'ID format is F-<MODULE>-<NUM>',
      run: () => {
        for (const f of KNOWN_FAILURES) {
          assert(/^F-[A-Z]+-\d+$/.test(f.id), `${f.id}: bad format`);
        }
      },
    },
    {
      name: 'verifyMitigation handles missing file',
      run: () => {
        const r = verifyMitigation({ id: 'X', files: ['/nonexistent/zzz.rs'], markers: ['x'] });
        assert(r.ok === false, 'should report failure');
        assert(r.reason.includes('not found'), 'reason should mention file not found');
      },
    },
    {
      name: 'verifyMitigation detects missing marker',
      run: () => {
        const r = verifyMitigation({ id: 'X', files: ['Makefile'], markers: ['__no_such_marker__'] });
        assert(r.ok === false, 'should report failure');
        assert(r.reason.includes('none of'), 'reason should list markers');
      },
    },
    {
      name: 'verifyMitigation succeeds on real file with marker',
      run: () => {
        const r = verifyMitigation({ id: 'X', files: ['Cargo.toml'], markers: ['workspace'] });
        assert(r.ok === true, `should succeed: ${r.reason ?? ''}`);
      },
    },
    {
      name: 'FMEA doc contains at least one F-XXX ID',
      run: () => {
        const text = fs.readFileSync(FMEA_DOC, 'utf8');
        const ids = [...text.matchAll(/F-[A-Z]+-\d+/g)];
        assert(ids.length >= 10, `expected >=10 IDs in doc, got ${ids.length}`);
      },
    },
    {
      name: 'parseResidualRisks returns array',
      run: () => {
        const r = parseResidualRisks();
        assert(Array.isArray(r), 'should return array');
      },
    },
    {
      name: 'every residual risk ID exists in inventory',
      run: () => {
        const r = parseResidualRisks();
        const known = new Set(KNOWN_FAILURES.map(f => f.id));
        const bad = r.filter(x => !known.has(x.id));
        assert(bad.length === 0, `unknown IDs in residual: ${bad.map(x=>x.id).join(',')}`);
      },
    },
    {
      name: 'every residual risk is signed (accepted_by non-empty, no TBD)',
      run: () => {
        const r = parseResidualRisks();
        const TBD_RE = /\(?\bTBD\b\)?/i;
        const unsigned = r.filter(x => !x.accepted_by || TBD_RE.test(x.accepted_by));
        assert(unsigned.length === 0, `unsigned residual risks: ${unsigned.map(x=>x.id).join(',')}`);
      },
    },
    {
      name: 'duplicateIdProblems names a repeated row ID and ignores prose',
      run: () => {
        const text = [
          '| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |',
          '|----|----------|------|---|---|---|-----|-----------|----------|',
          '| F-XX-001 | first mode | b | 1 | 1 | 1 | 1 | m | t |',
          '| F-XX-001 | a second mode reusing the ID | b | 1 | 1 | 1 | 1 | m | t |',
          'prose may cite F-XX-001 — it is not a row, so it must not count',
        ].join('\n');
        const dup = duplicateIdProblems(text);
        assert(dup.length === 1, `expected 1 duplicate, got ${dup.length}`);
        assert(dup[0].id === 'F-XX-001' && dup[0].line === 4, `got ${JSON.stringify(dup[0])}`);
        assert(
          duplicateIdProblems('| F-XX-002 | a single mode | b | 1 | 1 | 1 | 1 | m | t |').length === 0,
          'a single row is not a duplicate',
        );
      },
    },
  ];

  let failed = 0;
  for (const t of tests) {
    try {
      t.run();
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${t.name}: ${err.message}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} self-test(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} self-tests passed.`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const cmd = process.argv[2] || '--check';
if (cmd === '--check') cmdCheck();
else if (cmd === '--emit-json') cmdEmitJson();
else if (cmd === '--emit-residual') cmdEmitResidual();
else if (cmd === '--self-test') cmdSelfTest();
else {
  console.error('Usage: fmea-gen.mjs [--check | --emit-json | --emit-residual | --self-test]');
  process.exit(2);
}
