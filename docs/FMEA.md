# AmOS — FMEA 失效模式与影响分析

> **Failure Modes and Effects Analysis**(失效模式与影响分析)
>
> 来源:ARP4754A/ARP4761 民用航空安全方法学 + DO-178C 软件保证框架
>
> 状态:**机读 + 文档化**,由 `scripts/fmea-gen.mjs` 从代码扫描导出
>
> 适用:**所有已识别的安全关键路径**(守护进程、桥、传输、机器人控制)
>
> **诚实声明**:本文件由代码与文档双源扫描生成。**真实部署前的适航审定**要求**独立 FMEA 团队**复核本表;本文件用作工程纪律而非审定证据。

---

## 1. 风险评估尺度

### 1.1 严重性 (Severity, S)

| 等级 | 含义 | 示例 |
|---|---|---|
| **S5 — 灾难性** | 可能致人死亡/系统丧失 | 误急停;UDS 越权访问;电源切断未广播 |
| **S4 — 严重** | 主要功能失效,需操作员干预 | 守护进程崩溃;剪贴板泄露给另一用户 |
| **S3 — 中等** | 次要功能失效,有降级路径 | 推理响应缓存污染;日志轮转失败 |
| **S2 — 轻微** | 用户可察觉但不影响主功能 | UI 文案错误;时区显示偏移 |
| **S1 — 可忽略** | 用户不可见,无操作影响 | 调试日志缺失;诊断计数偏差 |

### 1.2 发生率 (Probability, P)

| 等级 | 含义 | 频次 |
|---|---|---|
| **P5 — 频繁** | 在常规使用中必然发生 | 每次会话触发 |
| **P4 — 偶尔** | 在某些使用模式下发生 | 每周可见 |
| **P3 — 罕见** | 边缘场景下发生 | 每月可见 |
| **P2 — 不太可能** | 在异常配置下发生 | 每季度可见 |
| **P1 — 极不可能** | 仅理论分析可达 | 已知案例中未发生 |

### 1.3 可检测度 (Detectability, D)

| 等级 | 含义 | 检测手段 |
|---|---|---|
| **D5 — 不可检测** | 无任何信号告诉用户/系统 | 静默丢弃;无日志 |
| **D4 — 难以检测** | 仅事后取证才可发现 | 日志文件损坏 |
| **D3 — 可检测** | 需专业工具/读日志 | `get_status.*` 上 wire |
| **D2 — 易检测** | 普通用户可见 | 横幅/通知/UI 变化 |
| **D1 — 自动处理** | 系统自带降级/重试 | 熔断器/超时/重拨 |

### 1.4 风险优先级数 (RPN) = S × P × D

| RPN 范围 | 行动 |
|---|---|
| **≥ 100** | 必须缓解(强制门禁+回归测试) |
| **50-99** | 应缓解(单测覆盖 + 文档化边界) |
| **20-49** | 可接受(纳入监控) |
| **< 20** | 不需行动 |

---

## 2. 关键功能失效模式

### 2.1 守护进程 (amos-ai)

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|---|-----------|----------|
| F-AI-001 | 守护进程进程崩溃 | System UI 失去 AI/翻译/审计/守护能力 | 4 | 3 | 2 | 24 | `amos-supervisor` 崩溃自动拉起;UDS 重拨 | `supervisor-smoke.sh` |
| F-AI-002 | 守护进程内存泄漏 | OOM 杀进程 | 4 | 2 | 3 | 24 | `GenerationPool` 上限;`ResponseCache` LRU+TTL | `pool::tests`, `cache::tests` |
| F-AI-003 | 守护进程未察觉挂起(死锁/长 GC) | 客户端超时但 UI 不知 | 4 | 2 | 4 | 32 | gRPC deadline;`probe_requests_per_second` 独立通道 | `security::probe` 单测 |
| F-AI-004 | 日志 sink 写失败静默 | 事故后无取证依据 | 3 | 2 | 5 | 30 | `LogSinkReport` 上 wire + 计数 | `logfile::tests` |
| F-AI-005 | 推理后端响应截断/乱码 | 用户收到残缺文本 | 3 | 3 | 2 | 18 | 流式契约 + `bytes_per_token` 健康检查 | `inference::tests` |
| F-AI-006 | 后端不可达但声明"已连接" | 永远等待响应 | 3 | 3 | 2 | 18 | `BreakerBackend` 三态熔断 | `breaker::tests` |
| F-AI-007 | 会话累积无界 | 内存耗尽 | 3 | 2 | 3 | 18 | `SessionManager` 上限 100 | `session::tests` |
| F-AI-008 | 池满拒绝但未区分原因 | 无法判断扩容还是重试 | 2 | 3 | 2 | 12 | `Saturated` vs `WaitTimeout` 类型化拒绝 | `pool::tests` |
| F-AI-009 | 审计落盘失败 → 用户被告知"已记录" | 监管不可追 | 4 | 2 | 4 | 32 | `ok=false` 诚实回返;`recorded/attempted/reason` 报告 | `privacy_audit_e2e` |
| F-AI-010 | UDS 异用户访问通过 | 隐私数据被同主机其他用户读取 | 5 | 2 | 5 | 50 | `peercred.rs` 同用户校验 + `AMOS_UDS_PEER` 策略 | `peercred::tests` |
| F-AI-011 | TCP 通道被同主机其他进程访问 | 与 F-AI-010 同形,但跨网络 | 5 | 2 | 4 | 40 | `tcp_auth.rs` token 校验 + 强制环回 | `tcp_token_e2e.rs` |
| F-AI-012 | 资源门告警未送达 | 操作员不知告警 | 3 | 2 | 3 | 18 | `Alerts` 字段上 wire,UI 渲染 | `alerts::tests` |
| F-AI-013 | 速率限制被旁路 | 资源耗尽攻击 | 3 | 3 | 2 | 18 | `validate_probe` 仍走安全层;`Rejected` 写审计 | `security::tests` |

### 2.2 窗口管理 (amos-tauri/wm)

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|-----|-----------|----------|
| F-WM-014 | Phone 形态打开多个 app 窗口 | 布局混乱,与手机语义不符 | 3 | 1 | 2 | 6 | `multi_window=false` 在窗口创建时强制拒绝 | `phone_form_factor_refuses_second_app_window` |
| F-WM-015 | 分屏窗格尺寸低于可用值 | 用户无法点击或看清内容 | 3 | 1 | 2 | 6 | `enforce_min` 在应用布局时自动提升 | `enforce_min_is_applied_to_split_panes` |
| F-WM-016 | Tablet 窗口意外可缩放 | 触摸设备无缩放交互,行为意外 | 2 | 1 | 2 | 4 | `.resizable(policy.free_resize)` 强制应用 | （隐式：Tauri 原生行为）|
| F-WM-017 | 屏幕变小后 app 窗口挂在屏幕外 | 用户在屏幕上**看不到也点不到**自己的窗口 | 3 | 1 | 2 | 6 | 每次真实屏幕变化后 `WmState::reclamp_windows()` 读平台真实几何(无宿主账本可漂移)、按 `LayoutPolicy::fit_window` 回夹,**只动需要动的窗口**;跳过 Launcher / 外部表面 / 隐藏窗口,读不出的几何计数 + `warn!` 不猜位置 | `reclamp_target_moves_only_windows_that_need_it`、`only_a_believable_reading_becomes_a_window_position` |
| F-WM-018 | 被拒的 app 窗口在状态机里**留痕**(模型有窗口、屏幕上没有) | 布局/焦点/z 序被幽灵窗口污染(REQ-A227 形状) | 3 | 1 | 3 | 9 | 判定**在注册之前**问:`WmState::check_new_app_window()`(生产 `open()` 与测试缝 `register_app()` 共用),拒绝是数据(`AppWindowRefusal`)而非字符串 | `a_refused_app_window_leaves_no_trace_in_the_model`、`a_class_without_multi_window_refuses_the_second_app_window` |

### 2.2c 桌面壳 chrome (前端)

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|-----|-----------|----------|
| F-SH-001 | **不可用的 chrome 控件假装可用**(有可读名字、能 Tab 聚焦、点下去什么都不做) | 用户点了没反应、无从判断是坏了还是没做(REQ-A261 实测:顶栏「控制中心」) | 2 | 3 | 4 | 24 | 可用性=**真行为**:未接入的控件 `disabled` + `aria-disabled` + 说明性名字(i18n),而不是留一个按钮;模块契约让"接入"变成单文件改动(`modules/ControlCenterButton.svelte`) | `chrome-widgets.svelte.test.ts`「the control centre is disabled and says why (no inert control)」+ `topbar-container.svelte.test.ts` 同一条断言(两个层级都钉) |
| F-SH-002 | 挂件写回容器模板里 ⇒ **无边界、无法独立交付**(顺序/存在性住在模板而非数据) | 每加一个指示器都要改顶栏;挂件的测试被迫挂载整条栏;两个人无法同时改两个挂件 | 2 | 4 | 3 | 24 | 容器 ↔ 挂件:注册表 `svelte/shellModules.ts` 是数据,容器只按 `modulesFor(slot)` 渲染、只暴露一个小的 `ShellChromeApi` 把手;外观收进 `lib/shellChrome.ts` 一处 | `shellModule.test.ts`(槽位/顺序/不变量/i18n 键)+ `chrome-widgets.svelte.test.ts`(**每个挂件单独挂载**)+ `topbar-container.svelte.test.ts`(容器自身 markup 不含挂件)+ `unwired-scan`(每个模块必须被注册表引用) |

### 2.2b 输入法 (amos-ime / amos-tauri)
| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|-----|-----------|----------|
| F-IME-001 | 两个窗口**共用一条拼音缓冲**(A 的候选栏显示 B 打的码、B 的提交吃掉 A 的码) | 用户看到/提交**不是自己打**的字(REQ-A258 的 G1) | 3 | 1 | 2 | 6 | 作用域拆开:`PinyinCore`(词典 + L0 学习层 + 模糊音,`Arc`,进程级)与 `PinyinInput`(每窗口一条缓冲 + 提示 + 撤销码);九条 `ime_*` 带 `window: tauri::WebviewWindow` 按 `window.label()` 归档缓冲;设备级动作(模糊音/清空学习)显式作用于每个窗口 | `two_windows_do_not_share_a_composition_buffer`、`the_undo_hint_is_per_window`、`two_sessions_over_one_core_keep_their_own_buffers`(**负控**:改成单会话 ⇒ 前两条 FAIL) |
| F-IME-002 | 每窗口一条缓冲 ⇒ 窗口标签只增不减,**无界增长** | 长会话内存/查找成本持续上涨(Power of 10 #3) | 2 | 2 | 3 | 12 | `MAX_IME_SESSIONS = 64`:达上限先丢弃"没什么可失去"的窗口(空缓冲/无撤销码/无提交提示),只有所有窗口都在打字才逐出最少使用并 `warn!` | `the_window_map_is_bounded_and_prunes_what_holds_nothing`(含"正在打字的窗口不会在有空闲可丢时被逐出") |
| F-IME-003 | 联想(下一词)**数据装了但没接线**:候选栏不呈现 ⇒ 用户看不到联想,而文档却写着"已完成" | 功能缺口被当成已交付(REQ-A260 复核 REQ-A259) | 3 | 2 | 3 | 18 | `state_of` 在**缓冲为空**时把建议作为候选返回(kind `predict`,与缓冲候选同一索引空间);键盘在 `composing \|\| suggesting` 时渲染候选栏并给 `ime-predict-tag` 标签;域侧 `PinyinInput::predictions()` 只在**两个已提交词**的上下文下给建议(拒绝噪声) | `an_empty_buffer_offers_suggestions_for_what_this_window_committed`、`predictions_need_two_committed_words_of_context`、`suggestions render with their own tag and no composition chip` |
| F-IME-004 | 联想建议**被当成用户输入**:污染学习层,或给出一个永远无效的"撤销此词" | 词典学到用户没打过的词;撤销按钮是坏承诺 | 3 | 2 | 3 | 18 | `commit_prediction` 只记录提交(供链式建议),**不**教学习层;宿主在建议分支把 `last_pick_code` 置 `None`(建议没有拼音码 ⇒ 没有可撤销的 pin) | `picking_a_suggestion_inserts_it_and_teaches_nothing`、`a_picked_prediction_continues_the_chain_without_teaching_the_learner` |
| F-IME-005 | 联想的 FST 数据使二进制变大(实测,隔离探针与应用二进制两条路一致:**+19.6 MB**) | 移动端 APK 体积上涨,装机/更新成本上升 | 2 | 1 | 1 | 2 | `amos-ime` 的 `predict` 特性(default on)是**唯一**开关;瘦身构建 `--no-default-features`:所有调用点无条件(我们自己代码里没有 `cfg`),缺数据时引擎按契约返回"没有建议"而不是假装 | `predictions_need_two_committed_words_of_context`(缺数据时同样返回空 ⇒ 路径不会 panic/假报) |

### 2.3 System UI 桥 (amos-tauri)

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|---|-----------|-----------|
| F-TAU-001 | 桥返回 null 而非结构化错误 | UI 不知根因 | 3 | 4 | 3 | 36 | `backend.ts` 改为 `{ok, error}` 形态 + 诊断账本 | `backend.test.ts` |
| F-TAU-002 | AI 桥超时未上报 | UI 卡死 | 4 | 3 | 2 | 24 | gRPC deadline + 探针 | `ai_bridge::tests` |
| F-TAU-003 | 剪贴板跨用户泄露 | 隐私 | 5 | 2 | 4 | 40 | `clipboard_guest` 审计计数;前台门控 | `clipboard_guest_link_e2e` |
| F-TAU-004 | 剪贴板后台读取 | 隐私 | 4 | 2 | 5 | 40 | `clipboard-changed` 公告只含元数据 | `clipboard-announce.test.ts` |
| F-TAU-005 | 远程驱动 (host→container) 静默失败 | 状态分叉 | 3 | 3 | 3 | 27 | `mirror_failed` warn | `lmk_reverse_drive.rs` |
| F-TAU-006 | 卸载策略被 UI 绕过 | 系统包被删 | 4 | 2 | 4 | 32 | `UninstallGuard` 单一构造点 | `devcare::the_preview_and_the_enforcement_agree` |
| F-TAU-007 | 云端 API key 写入失败 UI 谎报"已保存" | key 实际未落盘 | 4 | 2 | 4 | 32 | `persist_cloud_key` 全检查 + 0600 模式断言 | `ai_bridge::persist_cloud_key` |
| F-TAU-008 | WebView 里未捕获异常刷新即失 | 失败不可见 | 3 | 3 | 4 | 36 | `uiFailures.ts` 观察者记账本 | `uiFailures.test.ts` |

### 2.3 机器人中间件 (amos-link)

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|---|-----------|-----------|
| F-LK-001 | 误报急停 | 机器人骤停 | 4 | 2 | 2 | 16 | `latched` 状态需显式恢复;`deadman` watchdog | `amos-link` 17 lib 测试 |
| F-LK-002 | 漏报急停 | 失控 | 5 | 1 | 1 | 5 | 多源汇总;**`return path`** 折叠 | `amos-link` return path 测试 |
| F-LK-003 | CRC 校验后分配(解码前) | 16 MiB 帧接收端先分配 32 MiB | 4 | 2 | 4 | 32 | `crc32_over()` 流式 CRC,**修复后负控实测** | `codec::allocation_budget` |
| F-LK-004 | 多 NIC 信标走错接口 | 5G modem 出 / Wi-Fi 收 | 4 | 3 | 3 | 36 | `AMOS_LINK_BEACON_IFACE` 钉接口;`lan_multicast.rs` 真测 | `lan_multicast.rs` |
| F-LK-005 | 节点把自己当 peer | 自我回声 | 3 | 4 | 2 | 24 | `PeerRegistry::with_local` 拒绝本机 id | `amos-link::a_node_is_never_a_peer_of_itself` |
| F-LK-006 | 匹配器在注册表锁内分配 | broker 抖动 | 3 | 3 | 3 | 27 | 栈定长数组 + 1000 matches 0 bytes 断言 | `keyexpr::allocation_budget` |
| F-LK-007 | 锁中毒 ⇒ offer_blocking 无界等待 | 控制回路卡死 | 4 | 2 | 4 | 32 | `LinkError::Closed` 类型化 + 负控 `Elapsed` | `broker::tests` |
| F-LK-008 | 静默截断 (`usize as u32`) | 数字读错 | 3 | 2 | 4 | 24 | 饱和算子 + 负控 | `count_to_u32` 单测 |
| F-LK-009 | CLI `--seconds u64::MAX` panic | 进程崩溃 | 4 | 2 | 5 | 40 | `deadline_after()` 解析期拒绝 exit 2 | `cli_smoke::arguments_that_used_to_crash_*` |
| F-LK-010 | 真实硬件 HAL 未测驱动 | 误以为电机已断电 | 5 | 1 | 4 | 20 | `StreamRobotHal` 写入前验证 + 帧计数实测 | `motor --device` 进程级 |

### 2.4 数据完整性

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|---|-----------|-----------|
| F-DA-001 | 损坏的 localStorage 被静默回退 | 用户数据丢失 | 3 | 3 | 4 | 36 | `readJson` 区分缺失/损坏 + 隔离备份 | `amosStore.test.ts` |
| F-DA-002 | 隔离备份从未被读出 | 用户拿不回数据 | 2 | 4 | 4 | 32 | `listQuarantined` / `readQuarantine` UI 暴露 | `amosStore.test.ts` |
| F-DA-003 | 长会话无界累积 | OOM | 3 | 4 | 3 | 36 | `capTail` 200 条上限 | `bounded.test.ts` |
| F-DA-004 | 备份快照 key 与真实存储分叉 | 收藏/消息漏备份 | 4 | 3 | 4 | 48 | `SYNC_STORES` 改为模块常量键 | `settings.test.ts` |
| F-DA-005 | AI 历史会话读取未授权 | 历史泄露 | 3 | 2 | 3 | 18 | `GetHistory` RPC + session ownership 校验 | `ai_history_e2e` |

### 2.5 Android 集成

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|---|-----------|-----------|
| F-AND-001 | 相机 use-after-free | 进程崩溃/帧损坏 | 4 | 3 | 3 | 36 | `CameraGlue` 串行化 + epoch 守卫 | `Nv21PackerTest` |
| F-AND-002 | LMK 误杀活跃应用 | 关键进程被杀 | 4 | 2 | 3 | 24 | `UninstallGuard`;`mirror_failed` warn | `lmk_reverse_drive.rs` |
| F-AND-003 | 真实电池读数缺失上报 0 | 虚假低电量告警 | 3 | 3 | 4 | 36 | `BatteryReading::chargingFrom()` UNKNOWN 省略 | `devcare::battery` |
| F-AND-004 | APK 安装超时误报 | 用户以为成功 | 3 | 2 | 2 | 12 | `AMOS_ANDROID_INSTALL_TIMEOUT=180s` 独立 | `android_test.rs` |
| F-AND-005 | JNI 调用阻塞 UI 线程 | ANR | 4 | 3 | 2 | 24 | `spawn_blocking` 五处 | 手动审计 |

### 2.6 真机设备 (amos-telephony / amos-radio / amos-sensor)

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|---|-----------|-----------|
| F-TEL-001 | 紧急号码(110/112/911)被录音 | 隐私违规 | 5 | 2 | 5 | 50 | `hard no-record rule for emergency` | `telephony::tests` |
| F-TEL-002 | 黑名单生效但 UI 显示"未生效" | 拦截假象 | 4 | 2 | 3 | 24 | `blocklistCheck` 实时提示 | `phone.svelte.test.ts` |
| F-RAD-001 | 飞行模式级联未完整 | 设备未真正断网 | 4 | 2 | 3 | 24 | `RadioManager` cascade + guard | `radio::tests` |
| F-SEN-001 | 传感器 mode 切换未生效 | 耗电/低质量 | 3 | 3 | 3 | 27 | `SensorManager` 显式 apply | `sensor::tests` |

---

## 3. 跨功能风险点

### 3.1 资源/内存边界 (NASA Power of 10 #2)

| 模块 | 已建立边界 | 测试 |
|------|------------|------|
| `amos-ai::pool` | `NonZeroUsize` 容量 + RAII permit | 12 任务并发 |
| `amos-ai::cache` | 32 条/300s/256 KiB | 命中/过期/LRU/超限 |
| `amos-ai::session` | 100 条上限 | 单测 |
| `amos-link::broker` | 有界 slot + `Closed` 类型化 | 锁中毒负控 |
| `amos-sms::trash` | 256 FIFO | 单测 |
| 前端 `AiApp` | `capTail(CHAT_MSG_CAP=200)` | `bounded.test.ts` |
| 前端 `InterpApp` | `capTail(SEG_CAP=200)` | 同上 |
| 前端 `notifyStore` | `NOTIF_CAP=100` | 同上 |

### 3.2 失败可见性 (Power of 10 #7)

| 模块 | 失败处理 | 测试 |
|------|----------|------|
| `backend.ts` invoke | 永不 reject,记诊断账本 | `backend.test.ts` |
| `amos-ai::server` | `Status` 类型化(InvalidArg/Unauth/Internal) | 各 e2e |
| `amos-ai::governor_service` | `mirror_failed` warn | `lmk_reverse_drive.rs` |
| 前端 `uiFailures` | 全局未捕获观察者 | `uiFailures.test.ts` |

### 3.3 静态约束 (P0-1)

| 维度 | 门禁 |
|------|------|
| 生产代码禁 `unwrap/expect/panic` | `scripts/rust-panic-scan.mjs` (39 crate 全部通过) |
| 禁 `unsafe` 无 SAFETY 注释 | `scripts/unsafe-scan.mjs` |
| 禁 `std Mutex` 跨 `.await` | `scripts/lock-across-await-scan.mjs` |
| 禁 `std::fs` 在 `async fn` 内 | `scripts/blocking-in-async-scan.mjs` |
| 禁递归(含互递归) | `scripts/rust-recursion-scan.mjs` |
| 禁 must-use 静默丢弃 | `scripts/rust-discard-scan.mjs` |
| 禁 hot spin loop | `scripts/hot-loop-scan.mjs` |

---

## 4. 残余风险(已识别且接受)

> 这些风险**当前未缓解**,**已文档化**为"已知缺口"。**任何改动必须重新评估**。
>
> 接受人必须非空;`fmea-gen.mjs --emit-residual` 会机读校验空接受人**(含 `TBD` / `(TBD)` 后缀)**。
>
> **关于本表的签字模型(诚实声明)**:AmOS 是研究/原型 OS、未做 DAL 审定(见 §6),本表
> 当前由单一开发者 (`arkSong`) 同时承担 safety / ai / security / android 四类 role 的
> 残余风险签字。该做法**不符合职责分离**(理想的合规模型是各 role 由独立负责人分别复核),
> 但在无独立审查员的现状下,这是使本表"有人签字、避免空挂"的可执行方案。**一旦项目进入任
> 何受监管/审定路径,本节必须按 role 拆分并补独立签字。**

| 残余风险 | 接受理由 | 跟进 | 接受人 | 日期 |
|----------|----------|------|--------|------|
| F-LK-002(漏报急停)在异构板上未端到端验证 | 单元测充分,真机集成属设备 bring-up | 真机验收(runbook) | arkSong (safety) | 2026-09-15 |
| F-DA-005(AI 历史)在真机 SMS 已读回执上未联调 | 设备 SMS 由系统侧负责,本服务只读自身模型 | 设备 bring-up | arkSong (ai) | 2026-09-15 |
| F-AI-013(速率限制被旁路)在恶意客户端下可能放大 | 安全层是 best-effort | 加固留给后续 P2 | arkSong (security) | 2026-09-15 |
| F-AND-005(JNI 阻塞)在真机慢路径下未实测 | 代码侧全走 `spawn_blocking`,实测属设备 | 设备 bring-up | arkSong (android) | 2026-09-15 |

---

## 5. 自动生成说明

- 本表由 `scripts/fmea-gen.mjs` 从 **代码与测试**双源扫描生成
- 任何新增 P0/P1 路径应同步在表中登记
- 任何 RPN ≥ 100 项必须由独立验证人复核
- 残余风险表 (§4) 中的项目必须**有书面接受签字**才能进入审定;`--emit-residual` 会机读校验
- 三个模式:
  - `node scripts/fmea-gen.mjs --check`         文档 ↔ inventory ↔ 代码三方一致性
  - `node scripts/fmea-gen.mjs --emit-json`     机器可读 inventory(供仪表盘消费)
  - `node scripts/fmea-gen.mjs --emit-residual` 残余风险签字状态

---

## 6. 与 DO-178C DAL 的对应

> AmOS 是**研究/原型 OS**,**未**按任何 DAL 审定。本节用于映射关系,不可作审定证据。

| DO-178C DAL | 适用系统 | AmOS 当前对应 |
|-------------|----------|---------------|
| DAL A | 灾难性失效 | F-LK-002、F-TEL-001、F-AI-010/011 — **未达 DAL A 审定** |
| DAL B | 严重/危险 | F-DA-004、F-AND-002 — 已建门禁,**仍需独立验证** |
| DAL C | 重大 | F-LK-007、F-AI-001 — 单元覆盖充分 |
| DAL D | 轻微 | 多数 S3 项 |
| DAL E | 无安全影响 | S1-S2 项 |

**结论**:AmOS **不申请**任何 DAL 审定。文档顶部"⚠️ 非审定软件"声明强制保留。
