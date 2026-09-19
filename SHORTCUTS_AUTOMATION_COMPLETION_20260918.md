# 快捷指令自动化：审计与补全（2026-09-18）

**范围**：`shortcuts.ts` 的"执行是模拟的 / 变量未实现 / 触发器未实现"三项指控的取证与补全。
**结论**：三项**全部属实**，已补全；并按要求把**时间触发器的唤醒权威放进 Rust**（路线 A）。

---

## 1. 审计（先取证，再动手）

| 指控 | 取证 | 判定 |
| --- | --- | --- |
| `ShortcutExecutor` 只是框架 | 全仓 `grep ShortcutExecutor` = **0 命中**（该名字不存在；真正的引擎是 `executeShortcut` + `executeAction`） | 名字不对，问题对 |
| 执行是模拟的 | `executeAction` 里 `show_notification` / `show_alert` / `open_app` / `open_url` / `vibrate` 五个 case 合并成一句 `logger.info(...); return input;` —— 即**什么都没做** | 属实 |
| 变量系统未实现 | 只有整串 `"$name"` 能取值；无插值、无 `get_variable`、无追加 | 属实 |
| 触发器未实现 | `Trigger` 只是数据；全仓**没有**任何订阅/调度/判定代码 | 属实 |
| （顺手发现） | `if` / `repeat` 在 `BUILTIN_ACTIONS` 里**列着**，但 `executeAction` 的 switch 没有它们 → 落到 `default`，被当成"未实现动作"跳过 | 属实且更严重 |
| （顺手发现） | `requiresConfirmation` / `runOnLockScreen` 只是字段，**没有任何代码读它们**；`SHORTCUT_EXEC_LOG_KEY` 从 Phase 1 就声明、从没被写过 | 属实 |

## 2. 补全内容

### 2.1 变量系统（`lib/shortcuts.ts`）
- `resolveValue` 支持**整串引用**（保类型：`"$n"` → `42`、`"$list"` → 数组）与**行内插值**
  （`"总计 ${total} 元"` / `"{total} 元"` → 文本），数组/对象递归解析，内建引用
  `{input}` / `{output}` / `{date}` / `{time}` 优先于同名变量。
- 新动作：`get_variable`、`add_to_variable`（标量拼接 / 列表追加）。
- 普通文本里的 `$5` 不会被吃掉（嵌入形式必须带花括号）。

### 2.2 控制流（`children` / `elseChildren`）
- `if`（`== != > < contains empty`，弱比较，缺省按真值）、`repeat`（暴露 `${repeatIndex}`）、
  `for_each`（`${item}` / `${index}`，可改名，输出每轮结果列表）、`stop_shortcut`（**记为成功**）。
- 护栏：嵌套深度 `MAX_CONTROL_DEPTH=10`、迭代次数 `MAX_REPEAT_ITERATIONS=10000`、
  列表 `MAX_LIST_ITEMS=5000`。
- `actionsTotal` 改为**递归计数**（旧实现用 `actions.length`，嵌套后会出现"完成 12 / 共 1"）。
- 失败时的 `actionsCompleted` 不再抹成 0（一次 20 步的指令在第 19 步失败，用户不该看到 0/20）
  —— 已同步更新 `shortcuts-engine.test.ts` 的对应断言并写明理由。

### 2.3 真动作（不再有 `logger.info + return input`）
| 动作 | 真实落点 |
| --- | --- |
| `open_app` | `invoke("wm_open", { label })`（与 Launchpad/Spotlight 同一命令）；无桥时如实记警告 |
| `open_url` | `sanitizeUrl`（复用 `lib/webman.ts`，拒 `javascript:` 等）→ 宿主 `open`；非法 URL 让指令**失败** |
| `show_notification` / `show_alert` | 写进 `amos.notifications`（`addNotif` + `newNotifId`）→ 通知中心/横幅/免打扰自动生效 |
| `copy_to_clipboard` / `get_clipboard` | `clipboard_write` / `clipboard_read`（前台门槛由 Rust 保证） |
| `vibrate` | `navigator.vibrate`（无振动器时安静跳过） |
| 新增 | `split_text` / `text_case` / `trim_text` / `list` / `count_items` / `get_list_item` / `join_list` / `round_number` / `random_number` / `adjust_date` |

（`BUILTIN_ACTIONS` 从 11 项 → **31 项**。）


### 2.4 触发器：Rust 管"何时"，WebView 管"做什么"
**新增 `crates/amos-tauri/src/shortcut_triggers.rs`**（Tauri 命令，照 `alarm_sched` 的形状）：
- `shortcuts_trigger_sync { triggers, nowMs? }` —— 幂等替换整份计划：不在新计划里的条目被取消
  （账本 + OS）；**读不懂的规则按 key 拒绝并给出原因**，一行坏数据不会让所有自动化失效。
- `shortcuts_trigger_poll { nowMs? }` —— 到点触发一次**并立刻重挂下一次**（时间是复现，不是一次性）；
  睡过 3 天醒来只触发 1 次。
- 账本用 `amos_scheduler::ExactAlarmClock`；Android 侧**复用** `alarm_sched` 的同一个 JNI 绑定
  （`arm_device` 改为 `pub(crate)`），所以本 crate 里只有一条 `AlarmManager` 调用路径。
- 无 `AlarmManager` 的宿主如实回答 `host_only`，绝不声称已武装 OS。
- **没有** `_cancel` 命令：唯一的编辑路径是整份 `sync`（它自己会取消离开计划的条目），
  单独加一个没人调用的 cancel 正是本仓门禁要抓的"定义了、测过了、没接线"缺陷。

**新增 `src/lib/shortcutSchedule.ts`**：计划翻译（`timeTriggerSpecs`）+ 命令薄封装 + key 解析。
**新增 `src/svelte/osShortcutTriggers.ts`**（`Shell.svelte` 启动/停止）：
- Rust 轮询（15s）+ WebView 心跳**双路**，分钟级去重保证只跑一次；
- 非时间信号在 WebView 侧观察：`online`/`offline` + Wi-Fi store（`wifi`）、宿主电池（`battery`）、
  `amos:app-opened`（`app`）；
- 存储变化 → 重新同步计划 + 清去重记忆。
- 纯判定在 `lib/shortcuts.ts`：`triggerMatches` / `timeTriggerMatches` / `haversineMeters`
  （时区、ISO 星期、电量阈值、半径全部纯函数可测）。

### 2.5 门禁落地（原本只是数据）
- `requiresConfirmation`：`executeShortcut` 在 `confirmed !== true` 时拒绝；`ShortcutsApp` 运行前
  `confirm()` 再传 `confirmed: true`；**自动化里跳过**（没人可问，不跑也不假装成功）。
- `runOnLockScreen`：锁屏且 `false` → 拒绝（`Shell.svelte` 把锁屏状态传进 watcher）。
- `amos.shortcuts.execLog`：每次执行落一条（含 `triggerId`、成功/失败、计数、时长），上限 200。

---

## 3. 验证

| 检查 | 结果 |
| --- | --- |
| `bun run test`（仓库的 iso 包装器） | ✅ `[bun-iso] test OK` |
| 新增纯逻辑测试 | ✅ `shortcuts-automation.test.ts` + `shortcut-schedule.test.ts` 共 **49 项**，全绿 |
| 既存快捷指令测试 | ✅ 69 项全绿（其中 1 条断言按 2.2 的理由更新） |
| `bun run typecheck` | ✅ 我改动的文件 **0 error**（仓内其余 40 个 error 与本轮无关，改动前就在） |
| `cargo test -p amos-tauri --lib shortcut_triggers` | ✅ **11/11** |
| `cargo clippy -p amos-tauri --lib` | ✅ 本模块 0 告警 |
| `i18n:scan` / `idgen:scan` / `write:scan` | ✅ OK（`random_number` 的抽样已在 `idgen-allowlist.json` 写明理由；exec log 被门禁归类为 non-content） |
| `lifetime` / `reactfree` / `testreach` / `hover` | ✅ OK |
| `unwired:scan` | ⚠️ 失败项为**改动前既有**（`biometric`/`ble`/`gps`/`nfc` 四个不可达模块及其 32 个 export）；我新增的 export 全部有生产调用点 |

### 审计本身抓到的两个真问题（是门禁跑出来的，不是读出来的）
1. `setUrlOpener`（我最初写的可注入 URL 出口）**没有任何生产调用点** → 被 `unwired:scan` 抓出，
   删除而不是留一个空接口。
2. 执行日志最初用 `writeStoreValue(key, 数组)` 写，而 `readStoreValue` 返回的是**已解析**的值，
   于是 `JSON.parse(数组)` 抛 `Unexpected identifier "object"`（测试直接红了）→ 改为与本模块既有约定
   一致的双重编码（存 JSON 字符串），并容忍裸数组。

---

## 4. 已知边界（写在代码注释里，不藏）

1. **编辑器还不能编辑嵌套子操作**：引擎与数据结构支持 `children` / `elseChildren`（导入、模板、
   程序化构造都能跑），但 `ShortcutsApp` 的流程编辑器仍是扁平列表 —— 加嵌套 UI 是下一步。
2. **app 触发器只覆盖会"说出来"的打开动作**：`shellState.open()`（手机/平板 + Dock/appLinks 路径）、
   `Launchpad`、`SpotlightOverlay` 会广播 `amos:app-opened`；`DesktopShell` 顶栏的
   "偏好设置 / 文件"两个内部 chrome 按钮直接调 `wm_open`，不广播。
3. **没有信号源的触发器类型**（`email` / `message` / 真实定位 / NFC / 蓝牙）判定返回 `false`：
   不猜、不假装。接上真实信号源后判定函数无需改动。
4. `location` 的半径判定（`haversineMeters`）已实现并测试，但**定位信号源**尚未接入。

---

### 与并行改动的关系（重要）
本轮期间有**另一个会话**在同一工作区改动 `crates/amos-tauri/src/{ble.rs,files.rs}` 与
`frontend-ts/src/lib/{ble.ts,nfc.ts,wm.ts,filesCloud.ts,filesCompression.ts}`（mtime 晚于本模块）。
`unwired:scan` / `typecheck` / `cargo` 的失败项全部落在这批文件上，**不是本轮引入**。
另外 `svelte/shellState.svelte.ts` 被并行的 `wmOpenWithDiag` 重构改过，留下一个无人使用的
`bridgeDiag, invoke` import（TS6192）—— 我顺手删掉了它（该文件本轮也动过），并确认我加的
两处 `announceAppOpened(id)` 调用在新代码里仍然生效。

---

**改动文件**
- `crates/amos-tauri/src/shortcut_triggers.rs`（新）
- `crates/amos-tauri/src/lib.rs`、`crates/amos-tauri/src/alarm_sched.rs`（注册 / 可见性）
- `frontend-ts/src/lib/shortcuts.ts`（引擎补全）
- `frontend-ts/src/lib/shortcutSchedule.ts`（新）、`frontend-ts/src/svelte/osShortcutTriggers.ts`（新）
- `frontend-ts/src/svelte/{Shell.svelte,shellState.svelte.ts,Launchpad.svelte,SpotlightOverlay.svelte,ShortcutsApp.svelte}`
- `frontend-ts/src/i18n/locales/{zh,en}.ts`（`shortcuts.confirmRun`）
- 测试：`shortcuts-automation.test.ts`（新）、`shortcut-schedule.test.ts`（新）、`shortcuts-engine.test.ts`
- 文档：`docs/SHORTCUTS_DEVELOPER_GUIDE.md`（变量 / 控制流 / 触发器三节重写）、`scripts/idgen-allowlist.json`
