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
const FMEA_DOC = path.join(ROOT, 'docs/FMEA.md');

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

  // 窗口管理 (形态策略强制到真实窗口: G5 / REQ-A256 主体, REQ-A257 复核收口)
  { id: 'F-WM-014', module: 'amos-tauri', files: ['crates/amos-tauri/src/wm.rs', 'crates/amos-wm/src/form.rs'], markers: ['check_new_app_window', 'check_app_window'], severity: 3 },
  { id: 'F-WM-015', module: 'amos-tauri', files: ['crates/amos-tauri/src/wm.rs', 'crates/amos-wm/src/form.rs'], markers: ['enforce_min', 'fit_window'], severity: 3 },
  { id: 'F-WM-016', module: 'amos-tauri', files: ['crates/amos-tauri/src/wm.rs'], markers: ['resizable(policy.free_resize)', 'min_inner_size'], severity: 2 },
  { id: 'F-WM-017', module: 'amos-tauri', files: ['crates/amos-tauri/src/wm.rs'], markers: ['reclamp_windows', 'reclamp_target'], severity: 3 },
  { id: 'F-WM-018', module: 'amos-tauri', files: ['crates/amos-tauri/src/wm.rs', 'crates/amos-wm/src/form.rs'], markers: ['check_new_app_window', 'AppWindowRefusal'], severity: 3 },

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

  // System UI 桥
  { id: 'F-TAU-001', module: 'amos-tauri', files: ['crates/amos-tauri/frontend-ts/src/lib/backend.ts'], markers: ['bridgeDiag', 'ok-error'], severity: 3 },
  { id: 'F-TAU-002', module: 'amos-tauri', files: ['crates/amos-tauri/src/ai_bridge.rs'], markers: ['ask_daemon', 'deadline'], severity: 4 },
  { id: 'F-TAU-003', module: 'amos-tauri', files: ['crates/amos-tauri/src/clipboard_guest_link.rs'], markers: ['clipboard_guest_status', 'audit'], severity: 5 },
  { id: 'F-TAU-004', module: 'amos-tauri', files: ['crates/amos-tauri/frontend-ts/src/svelte/ClipboardAnnounce.svelte'], markers: ['clipboard-changed', 'metadata'], severity: 4 },
  { id: 'F-TAU-005', module: 'amos-tauri', files: ['crates/amos-ai/src/governor_service.rs'], markers: ['mirror_failed'], severity: 3 },
  { id: 'F-TAU-006', module: 'amos-tauri', files: ['crates/amos-tauri/src/devcare.rs'], markers: ['UninstallGuard'], severity: 4 },
  { id: 'F-TAU-007', module: 'amos-tauri', files: ['crates/amos-tauri/src/ai_bridge.rs'], markers: ['persist_cloud_key', '0600'], severity: 4 },
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
