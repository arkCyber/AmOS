# AmOS 手机管家（Device Care）领域内核

**日期**: 2026-09-10 · **范围**: `crates/amos-devocare`（领域内核，纯 `std`）
**关联**: `docs/app-lifecycle.md`（进程/LMK）、`docs/power-policy.md`（电池/热/能效）、`docs/permissions-sandbox-audit-plan.md`（权限/审计）、`docs/appstore.md`（安装/卸载/签名）、`docs/android-storage-unify.md`（存储/MediaStore）、`docs/AEROSPACE_SOFTWARE_AUDIT.md`（P0-1/P0-3 纪律）。

> 本文回答「平台需要手机管家」这条需求留下的最大空白：AmOS 已拥有手机管家所需的**全部子系统**——`amos-appstore`（安装/卸载）、`amos-applife`（前台/后台/墓碑/回收）、`amos-power`（电量/热/频率决策）、`amos-monitor`（系统健康）、`amos-media`（外部存储）、daemon 的隐私授权与审计账本——但**没有一层统一的「什么可以安全地做」的领域内核**。`amos-devocare` 就是那层：纯 `std`、离线可测、平台无关的**设备维护决策内核**，真正的设备后端（Android `PackageManager`/`MediaStore`/`BatteryManager`）与 Tauri 桥、Svelte 界面留作 seam。

---

## 1. 为什么需要它（缺口盘点）

| 手机管家的能力 | 仓库中已有的点 | 缺的是什么 |
|---|---|---|
| 清理垃圾 | `amos-media` 能列/存标准集合；`hostfs` 能读目录 | 「哪些东西算垃圾」的**分类模型**、扫描汇总、**安全清理计划与逐条诚实结果** |
| 删除软件 | `amos-appstore` 有 `uninstall(id)`；`AppPackage` 概念散落 | 「**哪些包禁止卸载**」的**安全策略**（系统包 / 关键包），拒绝时给得出理由 |
| 电池与省电 | `amos-power` 出 `Decision{sensor_mode,cap_inference,throttle_background}` | 把电量/热/充电折成**用户可读的管家建议**（而不是悬空的 knob） |
| 权限控制 | daemon `PrivacyManager` + 审计、前端 `PermissionsApp` | 「哪个 App 拿了哪些敏感权限」的**只读审阅视图**（绝不自行授权/撤销） |
| 一体化体检 | `amos-monitor` 有系统健康 | 把存储/应用/电池/权限**折成一个带等级的体检报告**（未知不冒充健康） |

一句话：**能力点齐了，缺决策层与「安全默认值」的单一真相源。**

---

## 2. 分层与架构

```text
   [ System UI: 手机管家（Svelte 页） ]                 ← 下一阶段
            │  analyze / plan / execute / assess / review
            ▼
   [ Tauri 桥  →  crates/amos-tauri/src/devcare.rs ]     ← 已实现
            │
   ┌────────┴──────────┬──────────────────┬───────────────────┐
   │ junk.rs           │ guard.rs         │ permissions.rs    │  ← 本 crate
   │ analyze/plan/exec │ UninstallGuard   │ review_grants     │
   └────────┬──────────┴──────────────────┴───────────────────┘
            │                       health.rs
            │                    assess → CareReport
            │  CleanProvider seam（唯一外部触点）
            ▼
   MockCleanProvider（确定性、离线）· hostfs（根目录受限，真实文件系统）
   Android MediaStore / PackageManager / BatteryManager（设备 bring-up）
```

UI 侧（已实现）：`frontend-ts/src/lib/devcare.ts`（typed 桥 + 全量 normalizer + 客户端策略校验）
与 `svelte/DeviceCareApp.svelte`（体检卡 / 垃圾勾选 / 一键清理 / 应用策略 / 权限审阅），
经 `appMeta`/`appRegistry`/`appGroups` 注册为第 26 个内置应用（`app.devocare` = 手机管家）。

模块划分（与 `amos-media`/`amos-blocklist` 同构）：

| 模块 | 内容 |
|---|---|
| `spec` | 领域词汇：`JunkKind`/`JunkItem`/`JunkReport`、`CleanRequest`/`CleanPlan`/`CleanOutcome`、`AppPackage`/`UninstallVerdict`、`SensitiveResource`/`PermissionGrant`/`SensitiveAppRow`、`CareArea`/`Severity`/`CareGrade`/`CareFinding`/`CareReport`。全部 `serde` 可序列化（桥接直接复用，不产生第二份模型） |
| `error` | `DevCareError`（5 个具名错误 + `key()` 稳定标签），`Result<T>` 别名 |
| `provider` | `CleanProvider` seam（只做「删」这一件事，不做安全判断）+ 确定性 `MockCleanProvider`（可配置失败、非幂等） |
| `junk` | `analyze`（有界、确定性汇总）、`auto_cleanable_kinds`（一键清理的**唯一**安全选择来源）、`plan`（策略校验 + uri 去重 + 冻结排序）、`execute`（逐条诚实结果） |
| `guard` | `UninstallGuard` + `CRITICAL_PACKAGES`：系统包与关键包的**双层拒绝** |
| `permissions` | `review_grants`/`apps_holding`/`granted_resource_count`：只读、只统计**已授予**、去重、有界、确定性 |
| `health` | `assess(&CareInput) -> CareReport`：加法罚分 + 等级；**未观测区域不评估** |
| `hostfs` | 唯一显式 I/O 后端：`HostFsScanner`（**有界深度**遍历，只匹配已建模的垃圾形状，**不跟随符号链接**）+ `HostFsCleanProvider`（`is_within` 规范化后前缀校验，拒绝根目录外任何路径；目录只用 `remove_dir`）+ `is_safe_root`（拒绝把 `/` 当根） |


---

## 3. 领域模型

### 3.1 「什么算垃圾」——`JunkKind`（安全的第一性设计）

| Kind | 含义 | 可自动清理？ |
|---|---|---|
| `AppCache` | 应用可重建缓存（`cache/`、`code_cache/`） | ✅ |
| `ApkInstaller` | 残留安装包（`*.apk`/`*.apks`/`*.xapk`） | ✅ |
| `LogFile` | 轮转/过期日志 | ✅ |
| `TempFile` | 临时文件（`*.tmp`、编辑器 swap） | ✅ |
| `Thumbnail` | 可重建缩略图 | ✅ |
| `CrashDump` | 崩溃转储 / tombstone | ✅ |
| `EmptyDir` | 卸载后残留空目录 | ✅ |
| `StaleDownload` | 用户**未标记保留**的下载 | ❌ 需确认（可能是唯一副本） |

> **关键安全属性（by construction）**：用户媒体（照片/视频/音乐）、文档、通讯录、短信、应用私有数据**根本没有被建模成垃圾**。因此不存在「某个判断写错就把用户照片删掉」的路径——不是靠运行期检查兜底，而是**类型系统层面不可能表达**。这条性质写在 `spec.rs` 的模块文档里，并由 `docs/AEROSPACE_SOFTWARE_AUDIT.md` 的确定性纪律支撑。

### 3.2 三条流水线

```text
scan（调用方）        analyze            plan                 execute
&[JunkItem] ─▶ JunkReport ─▶ (无字节) ─▶ CleanPlan ─────────▶ CleanOutcome
                                        （冻结、排序）        （逐条诚实）
```

- `analyze`：按 `JunkKind::ALL` 顺序汇总；超过 `MAX_JUNK_ITEMS`（10 000）**拒绝**而非静默截断（传给破坏性操作的输入不允许被悄悄裁剪）；求和使用 `saturating_add`，溢出饱和不 panic。
- `plan`：空选择 → 拒绝；`StaleDownload` 未 `acknowledge_review` → 拒绝；命中项超过 `MAX_CLEAN_BATCH`（5 000）→ 拒绝并要求调用方分批；排序键 `(kind, uri)`，**同一次扫描永远得到同一个计划**。
- `execute`：逐条处理，**单项失败不中断其余**；`freed_bytes` **只累计已确认删除**的项；失败进 `failures`（含 `uri`/`kind`/`size`/原因），`is_partial()` 让「清了一半」永远不可能被显示成「清理完成」。

### 3.3 卸载安全策略——`UninstallGuard`

两层彼此独立的保护**叠加**（`Protected` 优先于 `SystemApp`）：

1. **平台自带包**（`AppPackage::system`，对应 `ApplicationInfo.FLAG_SYSTEM`）→ `SystemApp`，拒绝（卸掉可能无法开机 / 破坏核心服务）。
2. **钉死的关键包集**（`CRITICAL_PACKAGES`）→ `Protected`，**即使平台允许也拒绝**：System UI、Settings、AI daemon 入口、以及**手机管家自己**。

| 判定 | `key()` | 拒绝理由 i18n |
|---|---|---|
| 可卸载 | `allowed` | —（无理由，UI 才显示卸载按钮） |
| 系统包 | `system_app` | `care.uninstall.systemApp` |
| 关键包 | `protected` | `care.uninstall.protected` |

`selectable()` 给出 UI 真正**可以**报价卸载的子集，`blocked()` 给出被拒列表 + 理由。设备侧可用 `with_critical([...])` **扩展**（如运营商预装），但**不能**从 UI 缩小默认集。真正的卸载动作仍由 `amos-appstore` 的 `uninstall(id)` 执行——本内核只做「许不许」。

### 3.4 权限审阅——**只读**

`review_grants(&[PermissionGrant]) -> Vec<SensitiveAppRow>` 只把**已授予**的敏感权限按 App 分组：

- 被拒绝的授权**不显示**（视图绝不夸大某个 App 的访问）；
- `app_id` 为空的观测被丢弃（无法归因的访问不冒充属于某人）；
- 资源去重并按 `SensitiveResource::ALL` 顺序、行按 `app_id` 排序 → 同一份数据两次审阅结果一致；
- 上限 `MAX_REVIEW_APPS`（500）。这是**只读视图**（无破坏性下游），故超过上限**截断**（截断可从返回长度观测），而非拒绝。

`granted_resource_count()` 供体检用的去重计数；`apps_holding(resource)` 给出持有某资源的 App 列表。**本内核从不自行授权/撤销**——那属于 daemon 的隐私账本（`docs/permissions-sandbox-audit-plan.md` 的 `PrivacyManager` + 审计）。

**数据来源是 daemon，不是前端缓存（2026-09-10 修正）**：`devcare_permissions` **不接受**前端传来的授权观测；它读 `PrivacyService.GrantedAll` → `PrivacyManager::grants_snapshot()`（**权威**），再把这些行喂给上面的 `review_grants` 来定形（去重/排序/有界仍在领域内核里）。返回 `{rows, authority}`：`authority:"daemon"` 才是权威答案；`authority:"unavailable"` 表示**读不到权威**（daemon 未连接），此时空列表**不是**「没有任何授权」。此前前端拿本地 `amos.permissions` 账本当数据源——那是**缓存**，可能与权威不一致，属同一类「把缓存当权威」的缺陷。

### 3.5 体检折叠——`assess(&CareInput) -> CareReport`

输入全部可选（`None` = **未观测**）。加法罚分（常数在 `health.rs` 顶部，文档可核对）：

| 区域 | 条件 | 严重度 | 罚分 | key |
|---|---|---|---|---|
| Storage | 可回收 ≥ `STORAGE_WARNING_BYTES`(2 GiB) | Warning | 20 | `care.storage.reclaimableHigh` |
| Storage | 可回收 > 0 | Suggestion | 5 | `care.storage.reclaimable` |
| Battery | 未充电 且 ≤ `BATTERY_CRITICAL_PCT`(5%) | Critical | 30 | `care.battery.critical` |
| Battery | 未充电 且 ≤ `BATTERY_LOW_PCT`(20%) | Warning | 15 | `care.battery.low` |
| Battery | `thermal_throttled` | Warning | 10 | `care.battery.thermal` |
| Permissions | 已授予去重对数 ≥ `MANY_SENSITIVE_GRANTS`(20) | Suggestion | 10 | `care.permissions.many` |
| Apps | 可审阅 App 数 > 0 | Info | 0 | `care.apps.reviewable` |

`score = clamp(100 − Σ罚分, 0, 100)`；等级 `CareGrade::from_score`：**A ≥ 90、B ≥ 75、C ≥ 60、否则 D**。同一档内 `critical` 抑制 `low`（不重复计罚）；电量 > 100 被夹到 100；充电时低电量不报警。

**电量从哪来、以及怎么折叠（诚实规则）**：`CareInput.battery` 的每个字段都可缺省。读数的**优先源是所挂后端**（真机 = Kotlin `DevCareGlue.battery()` 的 `BatteryManager`，见 §7），只有当后端**什么都没读到**（全 `None`）时才回落到桌面宿主读数（`host_battery.rs`）——后端一旦答了**任何**字段，它就是权威，**不拿宿主读数去补全一个部分回复**（那会把两个来源混成一个）。折叠成领域那个**耦合**的 `BatteryCare` 时有意不对称：

| 事实 | 未知时 | 为什么 |
|---|---|---|
| `level_pct` | ⇒ 电池区**不评估** | 没读到电量就没有可评的事实 |
| `level_pct` **越界**（`< 0` 或 `> 100`） | ⇒ 电池区**不评估** | 夹到 `0` 会凭空造出 `care.battery.critical`，夹到 `100` 会凭空造出「健康」——**两种都是编造**（glue 在源头也拒 `level > scale`；Rust 侧再拒一次是纵深防御） |
| `charging` | ⇒ 电池区**不评估** | 把它默认成「未充电」会把 3% 的部分读数伪造成 `care.battery.critical`——**凭空造问题** |
| `thermal_throttled` | ⇒ `false` | 只会**少记**一条热罚分，永远不会制造一条 |

档位取整用 `round`（不是截断）：`20.6%` 必须映成 `21`，否则会把一个**高于**低电量阈值（20%）的读数说成「电量偏低」。领域的 `health::assess` 另有 `min(100)` 兜底，但桥现在**不会**造出越界值给它。

即：**未知只能让我们少说，不能让我们多说**。`BatteryReading::care()` 是这条规则的唯一实现点（`crates/amos-tauri/src/devcare.rs`），并由 `a_partial_battery_reading_never_becomes_a_fabricated_finding` 等测试钉住。Kotlin 侧同守此律：**只有平台真的报了 `status` 才发 `charging`**（`BATTERY_STATUS_UNKNOWN` / 字段缺失一律**省略** ⇒ 未知，绝不当成「未充电」），而**越界的 `level`**（`level > scale`）**不是读数**——直接返回 `{"error":…}`，绝不去夹紧成一个看起来健康的百分比（Rust 侧的 `clamp` 只作为宿主/其它后端的第二道防线保留）。

**宿主（桌面）同样从严**：`reading_from_host()` 把 `host_battery.rs` 的真读数折成同一个 `BatteryReading`，**不**再把缺失的充电标志默认成 `false`（旧桥的 `unwrap_or(false)` 会在 4% 时凭空造出一条低电量告警）——宿主读数缺标志 ⇒ 电池区不评估。这套语义要求宿主读数**尽量别丢观测**：`/sys/class/power_supply/*/status` 的 `Full` **与 `Not charging`**（插着但没在充，如充电上限）都是**已观测到的「插电」**，一律映成 `Some(true)`，而不是丢掉当未知（否则整块电池区会在很常见的机器上消失）；同理，目录里**读不懂的条目**（没有 `type` 的非电池条目、驱动怪癖）一律**跳过**，绝不让其中一个**整盘放弃**（旧实现用 `?` 直接结束整个目录遍历 ⇒ 明明可读的电池被判成「未知」）。这些都是刻意**在非 Linux 主机上也编译并可测**的（`#[cfg(any(target_os = "linux", test))]` 门控 `linux` 模块与 `charging_from_status`，与 `clamp_level` 同一惯例），不留「只有 Linux CI 才验得到」的死角。

### 3.6 统一审计落盘——清理、卸载与加速都进同一条 trail

删除类与强制停止类操作必须在**统一审计 sink** 留痕。链路：

```text
  手机管家（Svelte）
      │ devcare_clean(kinds, ack) / devcare_uninstall(id) / devcare_boost()
      ▼
  Tauri 桥  crates/amos-tauri/src/devcare.rs
      │ ① 纯函数产出事件：amos-devocare::audit::{clean_events, uninstall_refused,
      │    uninstall_performed, boost_events}
      │ ② perm_record_audit（gRPC）→ daemon
      ▼
  daemon  PrivacyService.RecordAudit
      │ 校验 outcome / principal / op；**用守护进程自己的时钟盖 ts**
      ▼
  PrivacyManager::record_audit → amos-ai::audit::AuditFile
      （与隐私裁决镜像到的是同一个 JSON-lines 文件）
```

要点：

- **事件内容在领域内核里决定**（`amos-devocare::audit`，纯函数、离线可测）：聚合一条 `devcare.clean`（`success` **仅当零失败**；有失败即 `error`，附 `planned/freed_bytes/removed/failed`）+ 每条失败一条 `devcare.clean.item`（**有界 50 条**）；卸载为 `app.uninstall`，**被拒绝也记一条 `rejected`**（拒绝必须可见，否则「谁试图删关键包」无从追溯）；内存加速为 `devcare.boost` 聚合（`requested/attempted/reclaimed/failed`，`success` **仅当零失败且每个请求项都被真正尝试**（`attempted == requested`）——部分失败或簿记丢了应用都即 `error`，短缺在 details 里可见但**不伪造逐条记录**）+ 每条失败一条 `devcare.boost.item`（同样有界 50 条）——**强制停止应用是有后果的动作，和删除一样必须可追溯**。
- **时间戳由守护进程盖章**：客户端传的 `ts` 只是占位，守护进程用自身时钟——审计时间不能由调用方回填或预填。
- **未知 outcome 直接拒绝**（`INVALID_ARGUMENT`，不猜成最接近的值）；`principal`/`op` 为空同样拒绝。
- **诚实降级**：守护进程未以 `AMOS_PRIVACY_PATH` 启动时**没有持久 sink** → `RecordAudit` 回 `ok=false`，桥折成 `CleanOut.audit{recorded, attempted, reason}`，UI 显示「审计未记录」而不是假装有 trail。
- **批量不因单条失败而丢尾**：`perm_record_audit` 逐条发送；单条被拒只记下**第一个错误**、其余**继续发送**（返回 `{recorded, total, error}`）——一条坏记录不能让排在它之后的 trail 静默消失。
- **库存由桥所有**：`devcare_apps` **不接受**前端传来的清单。预览与执法走**同一个 `policy_package` 构造点**，所以「用户看到的判定」就是「会被执行的判定」（此前预览用调用方给的 `system` 标志、执法恒为 `false`，两者可以不一致）；清单读取失败时是**错误**而不是空列表（空列表会把失败伪装成「没有应用」）；包尺寸缺失时是 `null`（UI 显示「—」），**绝不伪造 `0 B`**。
- **拒绝不能被绕过**：`devcare_uninstall` 在 Rust 侧**先跑 `UninstallGuard` 再卸载**，且**策略先于库存查询**（关键包即使不在本地清单也拒绝）——前端不再直接调 `appstore_uninstall`。
- **单行有界**：`resource`/`details` 按**字符**截断（200/300，不按字节，绝不切断 UTF-8），保证 JSONL 每行有界。
- **读回（闭环）**：`PrivacyService.RecentTrail` → `PrivacyManager::recent_trail` 读**同一个** `AuditFile` 窗口（隐私裁决与管家动作共用一条 sink），命令 `devcare_trail` 用 `audit::ACTOR` **在 Rust 侧过滤**（actor id 只在这一处定义，不在 UI 里再写一份），返回 `{records, durable}`。`durable:false` 表示守护进程**没有持久 sink** ⇒ 空列表是「没有 trail」而**不是**「什么都没发生过」；读失败是**错误**而**不是**空列表。管家页「近期操作（审计）」卡片据此渲染，并在每次清理/卸载后自动刷新。
- **outcome 只有一种拼写**：`Outcome` 序列化为**小写**（`"rejected"`），与 gRPC wire 形式（`proto/privacy.proto` 的 `granted|denied|success|rejected|error`）**逐字一致**——磁盘上的 JSONL 与 RPC 对同一条记录给出同一个 tag，外部消费者（SIEM 导出、日志解析器）不会因为大小写不一致而解析失败。**读取时仍接受旧的 PascalCase**（`#[serde(alias)]`），所以归一化之前写下的 trail 依然可读，不会被当作坏行静默丢弃。
- **UI 不把失败显示成空**：扫描失败 ≠「没有垃圾」（`care.scanFailed` + 可回收量显示「—」而不是 `0 B`）；后端错误（如 `AMOS_DEVCARE_ROOT` 指向不存在的目录）会显式渲染，而不是看起来「一切正常」；审计读取不依赖清理后端，所以**没有后端时它仍然可见**。

### 3.7 内存加速——策略在领域，权威在 governor

参考安卓手机管家的「一键加速」：

- **可回收性 by construction**（`amos-devocare::boost`）：只命名两个可回收档位——`cached`（墓碑，**先回收**：已冻结且已存状态，最便宜）与 `background`；`foreground`/`visible`/`foreground_service` **永不**入选，`stopped`/未知/大小写不符一律不碰（「未知=别动」，不是「大概没事」）。`reclaim_plan` **稳定排序**（cached 先，同档保持输入序），同一快照必得同一计划。
- **数据与动作各有其主**：内存读数来自 `system_health`（`amos-monitor` 采样器）；待回收清单来自资源 governor 的 `taskmgr_snapshot`；动作是把 `kill` **逐个**下发给 `taskmgr_app_action`——governor 是生命周期的唯一权威，管家只**请求**。
- **诚实回报**：`BoostOut{requested, reclaimed, failures, available_before/after, governor, audit}`——每条失败都列出（部分成功绝不冒充完整），并且**从不声称「释放了 N MB」**：我们只给出加速前后的可用内存读数，由调用方自行比较（内存变化本来就有别的来源，把 delta 归因给本次动作是不成立的因果）。
- **加速也可审计**：每次 boost 把聚合 + 逐条失败事件写进**同一条统一 trail**（§3.6），聚合的 `requested/attempted/reclaimed/failed` 全部取自输入本身——**每个请求项都必须被交代**：部分失败、或有应用从未被尝试（`attempted < requested`），聚合都读作 `error`，trail 永不把残缺的 boost 描述成完整成功；`BoostOut.audit{recorded, attempted, reason}` 如实回报是否落盘；governor 不可达 ⇒ 没有动作、没有事件，`audit` 为零值（「未尝试」，UI 不渲染 trail），**绝不伪造一条存在的审计**。trail 卡的 op 标签 `care.op.boost`/`care.op.boostItem` 与清理/卸载同表。
- **三态**：`governor:false`（没能问到 governor）时 `reclaimable` 为空，但界面显示「守护进程未连接，无法管理后台应用」，**不是**「没有可回收应用」；读不到内存 → 显示「—」而不是 `0`；没有可回收项时按钮置灰。

---

## 4. 安全与「不造假」边界

1. **未知 ≠ 健康**。`CareInput` 的每个字段都可缺省；未观测的区域**不进** `CareReport::assessed`。因此空输入得到的是 `score=100` 但 `has_data()==false` —— **UI 必须先读 `has_data()`，为 false 时显示「未知」而不是满分**。这是 P0-3（未采集必须如实上报）在管家上的落地。**部分**观测同样必须可见：评分只对**看过的**区域有效，所以管家页用 `careAreaSplit`（域枚举序）渲染「已检测 / 未检测」分区——一份只测了存储的报告不允许看起来像一次完整体检（否则就是「未测 = 健康」）。
2. **不发明判断**。领域内没有「App 使用历史」，所以**从不**声称某权限「从未被使用」。权限侧只报一个跨过**已文档化阈值**的计数。
3. **破坏性输入从不被静默裁剪**。超上限的扫描/批量一律 `Err`（`TooManyItems`/`BatchTooLarge`），由调用方显式分批；只有**只读**的权限审阅允许截断。上限约束的是**上报项数**，不是「看过多少个节点」：`walk` 走完全部子树、只在**上报**第 `MAX_ITEMS+1` 项时判超限，`scanPublicDownloads` 与此**逐字一致**（此前它按「已检查行数」封顶，会把一个被截短的列表当成完整扫描交出去 —— 已修，2026-09-11）。
4. **部分成功即部分成功**。`CleanOutcome.failures` 与 `freed_bytes` 一起返回，`is_partial()` 可判；不存在「删失败但报成功」的路径。
5. **seam 不做安全判断**。`CleanProvider` 只「删」，不决定删什么；被攻破的后端最多喂坏字节/失败，进不了策略层——与 `amos-appstore`「只信 provider 的『取』、不信它的『判』」一致。
6. **P0-1 门禁**。`lib.rs` 顶部 `#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]` + `#![forbid(unsafe_code)]`；生产代码不 panic、无 `unsafe`。
7. **前端不能指名删除路径（桥层硬化）**。`devcare_clean` 只接受**类别 tag** + 审阅确认，并在桥内用**自己的扫描快照**重新 `plan`：WebView 传来的 `uri` 从不被接受，未知 tag 直接拒绝（`unknown junk category '…'`）。测试 `the_frontend_cannot_name_a_path_to_delete` 断言「把路径当类别」被拒且该文件仍在。
8. **根目录受限（`hostfs`）**。对**父目录**做规范化后前缀校验（`is_within`），`..`/符号链接**先解析再判断**；目录只走 `remove_dir`（非空目录诚实失败，绝不递归删除）；`is_safe_root` 拒绝把 `/` 当根。测试覆盖「根外文件必须存活」「删符号链接不删其目标」「非空目录拒绝」「不跟随符号链接目录」。
9. **桥的诚实默认**。未设 `AMOS_DEVCARE_ROOT` 时 `backend:"none"`、`available:false`，且 `devcare_report` 的存储区**保持未评估**——不把「没有后端」报成「0 字节＝健康」。真机尚未接 Android provider 时，UI 显示「未连接」而不是「一切正常」。
10. **重复 uri 不重复删**。`plan` 按 `uri` 去重，尺寸冲突时取**最小值**（永不夸大可回收空间）；空/空白 `uri` 直接拒绝（`Refused`）。
11. **量测不补零（P0-3 延伸到扫描）**：`JunkItem::size_bytes` 是 `u64`、**表达不了「未知」**，所以**读不到尺寸的行根本不被建模**（glue 的 MediaStore `SIZE` 为 `null`、或桥收到缺 `size_bytes` 的行 ⇒ 跳过），并**计入 `unreadable_dirs`**（UI 显示「扫描不完整」）。绝不填 `0`——那会是一条伪造量测，还会低估 `reclaimable_bytes` 与清理实际释放的字节。真正的 `0`（空文件/空目录）是**真实读数**，照常保留。

---

## 5. 需求 → 代码 → 测试（可追溯）

| 需求 ID | 描述 | 设计 / 代码 | 验证（测试） |
|---|---|---|---|
| REQ-DC1 | 只清理**可重建**材料；用户媒体/文档/通讯录/短信/应用数据**不可表达为垃圾** | `spec::JunkKind`（8 类，含 `is_auto_cleanable`/`needs_review`）、`spec` 模块文档 | `junk::tests::report_separates_reclaimable_from_review_bytes`；`tests/devcare.rs`（媒体/下载未被触碰） |
| REQ-DC2 | 扫描汇总**有界**：超 `MAX_JUNK_ITEMS` 拒绝而非截断；求和饱和 | `junk::analyze`、`spec::MAX_JUNK_ITEMS` | `analyze_refuses_over_cap_instead_of_truncating`、`analyze_saturates_rather_than_overflowing` |
| REQ-DC3 | 汇总**确定性**：分组按 `JunkKind::ALL` 顺序 | `junk::analyze` | `analyze_groups_and_totals_in_stable_order`、`analyze_empty_scan_is_an_honest_empty_report` |
| REQ-DC4 | 一键清理**只能**选中自动可清理类别 | `junk::auto_cleanable_kinds` | `report_separates_reclaimable_from_review_bytes`、`tests/devcare.rs` |
| REQ-DC5 | 空选择 / 未确认的 review-only 类别 → 拒绝 | `junk::plan`、`spec::CleanRequest::acknowledge_review` | `plan_refuses_an_empty_selection`、`plan_refuses_review_kind_without_acknowledgement`、`plan_allows_review_kind_when_acknowledged`、`tests/devcare.rs::a_stale_download_requires_an_explicit_acknowledgement_end_to_end` |
| REQ-DC6 | 计划**确定性 + 去重 + 过滤 + 有界** | `junk::plan`、`spec::MAX_CLEAN_BATCH` | `plan_is_filtered_sorted_and_deterministic`、`plan_deduplicates_repeated_kinds`、`plan_refuses_over_batch` |
| REQ-DC7 | 清理**逐条诚实**：单项失败不中断、`freed_bytes` 只计确认删除 | `junk::execute`、`spec::{CleanOutcome,CleanFailure}` | `tests/devcare.rs::the_junk_pipeline_reclaims_only_what_was_selected`；`provider::tests::*`（4 例） |
| REQ-DC8 | 卸载**安全策略**：系统包拒绝、关键包即使平台允许也拒绝 | `guard::{UninstallGuard,CRITICAL_PACKAGES}` | `guard::tests::*`（8 例：用户包/系统包/关键包/优先级/默认集/扩展/筛选与解释/空目录） |
| REQ-DC9 | 权限审阅**只读且只显示已授予**，去重、排序、有界 | `permissions::{review_grants,granted_resource_count,apps_holding}` | `permissions::tests::*`（8 例） |
| REQ-DC10 | 体检**未知不等于健康**：未观测区域不评估 | `health::{assess,CareInput}`、`spec::CareReport::{has_data,assessed_area}` | `no_data_is_explicitly_unassessed`、`zero_reclaimable_storage_is_healthy_but_assessed` |
| REQ-DC11 | 体检罚分/等级**可由常数复算**、边界明确 | `health::{STORAGE_WARNING_BYTES,BATTERY_CRITICAL_PCT,BATTERY_LOW_PCT,MANY_SENSITIVE_GRANTS}`、`spec::CareGrade::from_score` | `grade_boundaries_match_the_documented_thresholds`、`storage_over_two_gib_is_a_warning`、`small_reclaimable_storage_is_only_a_suggestion`、`many_sensitive_grants_is_a_suggestion`、`reviewable_apps_is_informational_and_never_lowers_the_score` |
| REQ-DC12 | 体检**确定性 + 严重度排序**；critical 抑制 low；充电抑制低电；>100 夹取 | `health::assess` | `findings_are_sorted_most_severe_first`、`critical_battery_replaces_the_low_warning`、`charging_suppresses_the_low_battery_finding`、`level_above_100_is_clamped`、`assess_is_deterministic`、`the_worst_case_folds_to_a_poor_grade` |
| REQ-DC13 | 桥接形状 `serde` 往返一致 | `spec` 全类型 `Serialize/Deserialize` | `tests/devcare.rs::care_report_round_trips_through_json_for_the_bridge` |
| REQ-DC14 | 生产代码禁 `unwrap/expect/panic`、无 `unsafe` | `lib.rs` 顶部 `deny`/`forbid` | `cargo clippy -p amos-devocare --all-targets -- -D warnings` |
| REQ-DC15 | 计划按 `uri` 去重（尺寸取最小，永不夸大），空/空白 `uri` 拒绝 | `junk::plan` | `plan_deduplicates_a_repeated_uri_keeping_the_smallest_claimed_size`、`plan_deduplication_is_independent_of_scan_order`、`plan_refuses_a_blank_uri_instead_of_skipping_it` |
| REQ-DC16 | 执行不跳过任何计划项：`attempted() == plan.len()` | `junk::execute`、`spec::CleanOutcome::attempted` | `execute_accounts_for_every_planned_item` |
| REQ-DC17 | `hostfs` 只匹配已建模垃圾形状，**用户媒体/文档永远不返回** | `hostfs::HostFsScanner`、`classify_file` | `scan_finds_the_modelled_shapes_and_never_user_media`、`scan_reports_real_sizes`、`end_to_end_scan_plan_execute_reclaims_real_files_only` |
| REQ-DC18 | `hostfs` 有界：深度上限、扫描上限、不可读目录计数（部分扫描不冒充完整） | `hostfs::{MAX_SCAN_DEPTH,HostScan}` | `scan_is_depth_bounded`、`scan_refuses_a_bare_filesystem_root`、`scan_refuses_a_root_that_does_not_exist` |
| REQ-DC19 | `hostfs` 受限删除：根外拒绝、符号链接不跟随/不删目标、非空目录拒绝 | `hostfs::{is_within,HostFsCleanProvider}` | `is_within_rejects_prefix_neighbours_and_accepts_real_children`、`provider_refuses_a_path_outside_the_root`、`provider_removes_files_and_empty_dirs_inside_the_root`、`provider_refuses_a_missing_file_and_a_non_empty_directory`、`removing_a_symlink_deletes_the_link_not_its_target`、`scan_does_not_follow_symlinks_out_of_the_root` |
| REQ-DC20 | 桥只接受**类别**、不接受路径；未知 tag 拒绝；清理后重扫 | `amos-tauri/src/devcare.rs`（`clean`） | `the_frontend_cannot_name_a_path_to_delete`、`clean_refuses_an_unknown_category_and_an_unacknowledged_review_kind`、`a_host_root_bridge_scans_cleans_and_reports_end_to_end` |
| REQ-DC21 | 桥无后端时诚实：`available:false`、存储**不评估**、不给假成功 | `devcare::DevCareBridge::{unavailable,report}` | `an_unavailable_bridge_reports_unknown_rather_than_healthy`、`report_assesses_storage_only_when_a_backend_observed_it` |
| REQ-DC22 | 卸载策略/权限审阅经桥一致执行（关键包拒绝、未知资源拒绝） | `devcare::{apps,permission_review}` | `apps_applies_the_uninstall_policy`、`permission_review_groups_grants_and_refuses_unknown_tags` |
| REQ-DC23 | 前端 normalizer **全量**（畸形载荷不抛错、不伪造）、未观测不显示评分、客户端策略与 Rust 同构 | `frontend-ts/src/lib/devcare.ts` | `devcare.test.ts`（12 例） |
| REQ-DC24 | 管家页：离线/无后端/部分清理/需确认/拒绝卸载等状态**如实渲染**，且只发类别 | `svelte/DeviceCareApp.svelte`、`appMeta`/`appRegistry`/`appGroups` | `device-care.svelte.test.ts`（10 例）、`app-registry.svelte.test.ts`、`appMeta.test.ts` |
| REQ-DC25 | 审计事件内容由**纯领域函数**决定：聚合（零失败才 success）+ 逐条失败 + 拒绝；有界（50 条）且按**字符**截断（不切断 UTF-8） | `amos-devocare/src/audit.rs` | `audit::tests::*`（8 例：聚合/部分失败/有界/多字节截断/拒绝/已执行/确定性） |
| REQ-DC26 | 守护进程 `RecordAudit`：校验 outcome/principal/op、**守护进程盖章时间戳**、`ok` 如实反映是否落盘 | `proto/privacy.proto`、`PrivacySvc::record_audit`、`PrivacyManager::record_audit` | `privacy_service::tests::record_audit_persists_to_the_unified_sink_and_validates`、`..._without_a_durable_sink_reports_not_recorded` |
| REQ-DC27 | 桥把审计状态**如实回报**（`recorded`/`attempted`/`reason`），清理产生的事件内容正确 | `devcare.rs`（`record_audit`、`AuditStatus`、`CleanReply`） | `record_audit_always_reports_attempted_and_a_reason_on_shortfall`、`recording_no_events_is_a_no_op`、`a_host_root_bridge_scans_cleans_and_reports_end_to_end`（事件内容断言） |
| REQ-DC28 | 卸载经**策略命令**执行且拒绝也入审计；策略先于库存；前端不再直接调 store 卸载 | `devcare.rs`（`uninstall_with_policy`、`devcare_uninstall`）、`svelte/DeviceCareApp.svelte` | `uninstall_refuses_a_protected_package_before_touching_the_store`、`uninstall_policy_holds_for_a_pinned_package_not_in_the_registry`、`uninstall_of_an_uninstalled_app_is_audited_as_not_removed`；DOM：`uninstalling goes through the policy command …`（断言未调用 `appstore_uninstall`） |
| REQ-DC29 | 前端审计状态全量解析与降级（缺失/畸形 → 视为未记录） | `lib/devcare.ts`（`normalizeAudit`/`auditComplete`/`normalizeUninstall`） | `devcare.test.ts`（+4 例）、DOM：`已记录审计 (1/1)` / `审计未记录` |
| REQ-DC30 | 卸载策略**唯一构造点**：预览与执法用同一 `policy_package`，WebView 不能提供库存（也无法影响判定） | `devcare.rs`（`policy_package`/`verdict_out`/`policy_preview`）、`appstore.rs::StoreBridge::installed_inventory`、`DeviceCareApp.svelte` | `the_preview_and_the_enforcement_agree_for_every_package`、`the_preview_verdicts_come_from_the_single_package_builder`、`policy_preview_of_an_empty_registry_is_empty`；DOM：`the uninstall preview is bridge-owned (the UI sends no inventory)`（断言 `devcare_apps` 无参、未调 `appstore_installed`） |
| REQ-DC31 | 审计 ingest 批量**不因单条失败丢尾**：逐条发送、收集首个错误、返回 `{recorded,total,error}` | `privacy_client::perm_record_audit`、`devcare::record_audit` | `record_audit_always_reports_attempted_and_a_reason_on_shortfall`、`recording_no_events_is_a_no_op` |
| REQ-DC32 | 未知值不伪造：包尺寸缺失 → `null`（UI「—」，绝不 `0 B`）；清单读失败 → **错误态**（不冒充「没有应用」） | `devcare::AppOut`、`lib/devcare.ts::normalizeApps`、`DeviceCareApp.svelte` | `an_unknown_package_size_serializes_as_null_not_zero`、`normalizeApps keeps an unknown package size unknown`、DOM：`an unreadable inventory is not shown as 'no apps'` |
| REQ-DC33 | 桥的 wire 形状由测试锁定（`CleanReply` 必须是**扁平**的，否则前端会静默显示 0） | `devcare::CleanReply`（`serde(flatten)`） | `the_clean_reply_wire_shape_is_flat` |
| REQ-DC34 | 统一 trail **读回**：与隐私裁决共用同一 sink，按 principal/resource 过滤，`durable` 区分「无 trail」与「无活动」 | `proto/privacy.proto`（`TrailReply`/`RecentTrail`）、`privacy.rs::recent_trail`、`privacy_service.rs::recent_trail` | `recent_trail_reads_the_unified_sink_and_filters_by_principal`（3 条记录、按 actor 与 resource 过滤、拒绝可见）、`recent_trail_without_a_sink_is_honestly_not_durable`；`tests/privacy_audit_e2e.rs` 真 UDS **读回**断言 |
| REQ-DC35 | 桥只暴露**本 actor** 的 trail（`audit::ACTOR` 单源，不在 UI 重复）；读失败是错误而非空列表 | `privacy_client::perm_recent_trail`、`devcare::devcare_trail`、`lib/devcare.ts::devcareTrail`/`normalizeTrail` | `normalizeTrail is total and keeps 'no sink' distinct from 'empty'`、`op/outcome label keys fall back…`、`hhmm renders a zero/invalid stamp as empty`；DOM：`an unreadable trail is an error, not 'no records'` |
| REQ-DC36 | 管家页「近期操作（审计）」四种状态**如实渲染**：有条目 / 空 / 无 sink / 读失败 | `svelte/DeviceCareApp.svelte`、i18n `care.trail*`/`care.op.*`/`care.outcome.*` | `device-care.svelte.test.ts`：渲染本地化 op+outcome、空态、**无 sink 不显示成空**、读失败显示错误 |
| REQ-DC37 | 扫描失败 ≠「没有垃圾」；可回收量在失败时显示「—」而非 `0 B` | `DeviceCareApp.svelte`（`scanErr`） | `a failed scan is an error, not 'nothing to clean'`（断言不出现「0 B」） |
| REQ-DC38 | 后端错误（如根目录不存在）**必须显式渲染**，不允许看起来健康；原始诊断保留在 `title` | `DeviceCareApp.svelte`（`status.last_error`）、i18n `care.backendError` | `a backend error is surfaced instead of looking healthy`、`a clean run does not show a backend error` |
| REQ-DC39 | 审计读取**不依赖**清理后端：无后端时 trail 仍可见 | `DeviceCareApp.svelte`（trail 卡片移出 `{#if available}`） | `the trail stays visible when no clean backend is attached` |
| REQ-DC40 | 审计 outcome **单一拼写**（小写，与 wire 一致），且**兼容读取**旧 PascalCase（不静默丢历史） | `amos-ai/src/audit.rs`（`Outcome` 的 `rename_all`/`alias`） | `outcome_has_one_canonical_spelling_but_reads_the_legacy_one`；`crates/amos-tauri/tests/devcare_audit_e2e.rs` 断言磁盘为 `"rejected"` |
| REQ-DC41 | **桥 → 守护进程 → 磁盘** 全链路 headless e2e（真实 client + 真实 daemon + 真实 JSONL，无 mock） | `crates/amos-tauri/tests/devcare_audit_e2e.rs` | 该测试自身：5 条记录写入（clean 聚合+逐条、拒绝卸载、**boost 聚合+逐条**）+ `perm_recent_trail` 读回 + actor 过滤 + 落盘 `"rejected"`/`"error"` + 时间戳由守护进程盖 + **权限权威读回** |
| REQ-DC42 | 权限审阅**以 daemon 为权威**：`GrantedAll` 一次取回全部持有者（按 app id、资源按稳定键排序；空集不列出） | `proto/privacy.proto`（`AllGrantsRequest`/`AllGrantsReply`/`GrantedAll`）、`privacy.rs::grants_snapshot`、`privacy_service.rs::granted_all` | `granted_all_lists_every_holder_once_in_a_stable_order`（deny-by-default 为空、只列持有者、撤销后消失、稳定序） |
| REQ-DC43 | 桥**不接受**前端授权观测；行由 daemon 提供、形状由领域定（去重/排序/有界），未建模的键跳过 | `privacy_client::perm_grants_all`、`devcare::permission_review_from`、`devcare_permissions` | `the_permission_review_is_shaped_from_daemon_rows`、`an_empty_grant_set_reviews_to_nothing`；`tests/devcare_audit_e2e.rs` 真 daemon 授权后读回 |
| REQ-DC44 | `authority` 区分「权威答案为空」与「读不到权威」；UI 不得把后者渲染成「没有任何授权」 | `PermReviewOut`/`AUTHORITY_*`、`lib/devcare.ts::permReviewAuthoritative`、`DeviceCareApp.svelte` | `normalizePermReview is total and defaults to 'unavailable'`、`permReviewAuthoritative is false unless the daemon answered`；DOM：`an unreachable daemon is NOT shown as 'nothing is granted'`、`an authoritative review with no grants says so`、`renders the read-only permission review rows from the daemon` |
| REQ-DC45 | 内存加速的**可回收性 by construction**：只回收 `cached`（先）/`background`；受保护档位与未知档位永不入选；计划稳定确定 | `amos-devocare/src/boost.rs`（`RECLAIMABLE_STATES`/`is_reclaimable`/`reclaim_rank`/`reclaim_plan`） | `boost::tests` 5 例：受保护档位不可回收、仅两档可回收（含 `stopped`/空/大小写）、cached 先于 background、同档稳定且确定性、空集为空 |
| REQ-DC46 | 内存视图映射为**纯函数**；未知读数不伪造（`None`/`governor:false`） | `devcare.rs::memory_view`、`devcare_memory` | `the_memory_view_keeps_protected_apps_out_and_orders_cached_first`、`an_unreachable_governor_never_fakes_a_reading` |
| REQ-DC47 | 加速**逐条请求**并诚实回报（部分失败列出；不声称「释放了 N MB」的因果） | `devcare::devcare_boost`、`BoostOut` | 前端 `normalizeBoost reports a partial boost honestly`；`BoostOut` 只含 `requested/reclaimed/failures/available_before/after/governor/audit` |
| REQ-DC48 | 内存卡三态如实渲染（不可读 / 未连接 governor / 正常）+ 无可回收项时按钮置灰 | `svelte/DeviceCareApp.svelte`、i18n `care.memory*`/`care.boost*` | `device-care.svelte.test.ts` 6 例：读数与可回收计数、加速回报、部分失败、**不可达 ≠ 没有可回收**、不可读显示「—」、空列表禁用按钮 |
| REQ-DC49 | `attach`（`DevCareGlue.bind`，Activity `onStart` 主线程）**只安装后端、绝不扫描**：`scanned_items` 保持 0 直到 `devcare_scan` 命令执行；重新 attach 会**丢弃前一后端的快照**（不把它冒充成新后端观测到的） | `devcare.rs::DevCareBridge::attach_device`（**不调用** `scanner.scan()`），扫描只发生在 `devcare_scan`（`offload` → `spawn_blocking`） | `a_device_backend_drives_scan_inventory_and_storage`（attach 后 `scanned_items == 0`，命令后才为 1）、`re_attaching_a_backend_drops_the_previous_snapshot` |
| REQ-DC50 | 跨组求和也**饱和**（`reclaimable_bytes`/`review_bytes` 不 `.sum()`）：自相矛盾/敌意扫描既不 panic 也不回绕 | `spec::JunkReport::{reclaimable_bytes, review_bytes}` | `junk::tests::analyze_saturates_rather_than_overflowing`（两自动档各 `u64::MAX` 的跨组饱和断言；修复前该断言在 debug 下 panic） |
| REQ-DC51 | 计划去重**与顺序无关**：同一 `uri` 被自相矛盾地报成两个类别时，`kind`/`size`/`owner` 一律取确定性的最小值，绝不「先到先得」 | `junk::plan`（`by_uri` 去重） | `plan_deduplication_across_kinds_is_independent_of_scan_order`、`plan_deduplication_is_independent_of_scan_order` |
| REQ-DC52 | Android glue 扫描**超上限即拒绝**（绝不静默截断）：`walk`/`scanPublicDownloads` 在将超过 `MAX_ITEMS` 时返回 `{"error":…}`；桥侧 `parse_scan_reply` **防御性**拒绝达到上限的数组（`TooManyItems`），未知 kind 计为部分扫描 | `android-glue/.../DevCareGlue.kt`（`walk`/`scanPublicDownloads`/`scanJunk`）、`devcare_device.rs::parse_scan_reply` | `devcare_device::tests::{a_scan_at_the_cap_is_refused_instead_of_silently_truncated, a_scan_reply_maps_rows_and_counts_unknown_kinds_as_partial, a_glue_error_is_an_honest_error_not_an_empty_scan}`（`cargo test -p amos-tauri --features android`） |
| REQ-DC53 | `CareReport::assessed` 按 **`CareArea` 枚举序**（Storage→Apps→Battery→Permissions），不泄漏「探测顺序」（Storage→Battery→Permissions→Apps） | `health::assess`（`assessed.sort()`） | `health::tests::assessed_areas_are_reported_in_care_area_order` |
| REQ-DC54 | 电量读数：真机取 **`BatteryManager`**（与 `amos-power` 同源的 sticky `ACTION_BATTERY_CHANGED`：`level`/`scale`/`status`；`thermal_throttled` 取平台自己的 `PowerManager.currentThermalStatus`，API 29+），仅在**后端全未知**时回落宿主读数；折叠进耦合的 `BatteryCare` 时**未知只让少说**——`level_pct`/`charging` 未知或**越界**（`<0`/`>100`）⇒ 电池区**不评估**（绝不夹成 `0`/`100` 那样的具体主张），`thermal_throttled` 未知 ⇒ `false`，档位 `round` 不截断。glue 只在平台**真的报了** `status` 时才发 `charging`（`BATTERY_STATUS_UNKNOWN`/缺失 ⇒ 省略），`level` 越界（`level > scale`）⇒ **读作失败**；宿主读数同样从严（`reading_from_host`：缺充电标志 ⇒ 不评估），宿主读取**不丢观测**（`Full`/`Not charging` ⇒ 插电；读不懂的 sysfs 条目**跳过**而不是整盘放弃），且这些 Linux 分支**在非 Linux 主机上也编译/跑测** | `android-glue/.../DevCareGlue.kt`（`battery()`/`chargingFrom`/`thermalThrottled`）、`devcare_device.rs`（`AndroidScanner::battery` + `parse_battery_reply`）、`devcare.rs`（`BatteryReading`/`BatteryReading::care`/`reading_from_host`/`DevCareBridge::report`）、`host_battery.rs`（`charging_from_status`/`linux::read`，`cfg(any(linux, test))`） | `devcare_device::tests::a_battery_reply_maps_every_field_and_keeps_unknowns_unknown`（`--features android`）、`devcare::tests::{a_partial_battery_reading_never_becomes_a_fabricated_finding（含 6 个越界/非有限值 ⇒ `None`、`0.0`/`100.0` 边界为真读数、`20.6 ⇒ 21`）, a_host_reading_is_folded_without_inventing_a_charger_state, the_device_battery_reading_drives_the_report, a_device_reading_that_cannot_fill_the_care_state_stays_unassessed}`、`host_battery::tests::{sysfs_charging_status_maps_only_observed_states, linux_reads_battery_from_a_real_tree, linux_reports_unknown_when_no_battery_is_readable}` |
| REQ-DC55 | **读不到尺寸的行不作为垃圾建模**（`JunkItem::size_bytes` 表达不了 unknown ⇒ 绝不填 `0`）：桥侧缺/`null`/非数字 `size_bytes` 一律跳过，glue 侧 MediaStore `SIZE` 为 `null` 同样跳过；跳过计入 `unreadable_dirs`（部分扫描可见），真正的 `0` 照常保留 | `devcare_device.rs::parse_item`、`android-glue/.../DevCareGlue.kt::scanPublicDownloads` | `devcare_device::tests::a_row_without_a_usable_size_is_left_out_instead_of_sized_zero`（`--features android`：3 种不可用尺寸全跳过且计 partial、真 `0` 保留） |
| REQ-DC56 | **部分体检必须可见**：评分只对**看过的**区域有效，管家页渲染「已检测 / 未检测」分区（域枚举序），未建模的键既不算已检测也不算未检测（不发明） | `frontend-ts/src/lib/devcare.ts`（`CARE_AREAS`/`careAreaSplit`）、`svelte/DeviceCareApp.svelte`（`devcare-areas`/`-observed`/`-missing`）、i18n `care.assessed`/`care.notAssessed` | `devcare.test.ts`（`careAreaSplit`：域序/部分/未建模键/`null`）、`device-care.svelte.test.ts` 3 例（部分报告列出未检测分区、全检测无告警、未观测不显示该行） |
| REQ-DC57 | **内存加速可审计**：每次 boost 与清理/卸载进**同一条统一 trail**——聚合 `devcare.boost`（计数取自输入本身，聚合与逐条记录不可能互相矛盾；`success` **仅当零失败且 `attempted == requested`**——部分失败或簿记丢失应用都即 `error`，`requested/attempted/reclaimed/failed` 四数齐报使短缺可见，但**不伪造逐条记录**）+ 每条失败一条 `devcare.boost.item`（有界 50 条、按字符截断）；`BoostOut.audit` 如实回报落盘与否；governor 不可达 ⇒ 零事件 + 零值 audit（「未尝试」，绝不伪造 trail）；前端 normalizer 全量、op 标签同表、UI 复用共享审计状态（**无可回收的 boost 也写了诚实事件 ⇒ UI 必须显示**） | `amos-devocare/src/audit.rs`（`boost_events`/`BoostReclaim`/`OP_BOOST`/`OP_BOOST_ITEM`）、`devcare.rs::devcare_boost`、`lib/devcare.ts::normalizeBoost`/`OP_I18N`、`DeviceCareApp.svelte::boost()`、i18n `care.op.boost*` | `audit::tests` 7 例（全成功一条记录、部分失败=error+逐条、**未尝试即非成功**、**请求外的尝试可见且非成功**、无事可做是一条诚实的 success、有界+多字节截断、确定性）、`the_boost_out_reports_whether_it_was_audited`（wire 形状）、前端 `normalizeBoost reports a partial boost honestly`（audit 全量+缺省降级+**reason 透传**）与 `auditComplete separates a full boost trail…`、DOM 4 例（加速回报「已记录审计 (1/1)」、部分失败「审计未记录」、未发生不渲染 trail、**空加速仍显示已记录事件**）、`devcare_audit_e2e`（boost 两 op 过真 daemon 落盘+读回） |

---

## 6. 验证

```bash
# 领域内核（含 hostfs 真实文件系统后端 + 纯审计事件构造）
cargo test -p amos-devocare          # 84 lib 单测 + 4 集成（tests/devcare.rs）
cargo clippy -p amos-devocare --all-targets -- -D warnings
cargo fmt -p amos-devocare --check

# 守护进程统一审计 sink（RecordAudit / RecentTrail / GrantedAll）
cargo test -p amos-ai --lib privacy_service::   # 10 例
cargo test -p amos-ai --lib                     # 218 例
cargo test -p amos-ai --test privacy_rpc_e2e    # 真 UDS e2e 仍全绿
cargo test -p amos-ai --test privacy_audit_e2e  # 真 UDS + 真 JSONL：写入 + **读回**

# Tauri 桥（devcare:: 28 例；host_battery:: 7 例；全 lib 228 例）
cargo test -p amos-tauri --lib devcare::
cargo test -p amos-tauri --lib
cargo test -p amos-tauri --features android --lib devcare_device::   # 设备后端解析（含 battery 回包）
cargo test -p amos-tauri --test devcare_audit_e2e  # 桥→真 daemon：审计写入/读回（clean/uninstall/boost）+ 权限权威
cargo clippy -p amos-tauri --all-targets -- -D warnings
cargo clippy -p amos-tauri --all-targets --features android -- -D warnings   # 设备后端也要过
cargo check -p amos-tauri --features android --lib  # 真机后端的 host 侧接线门禁

# Kotlin glue 类型检查（无 APK）：JDK 17 + Android SDK
cd crates/amos-tauri/gen/android && JAVA_HOME=$(/usr/libexec/java_home -v 17) ANDROID_HOME=$HOME/Library/Android/sdk \
  ./gradlew --no-daemon :app:compileUniversalDebugKotlin

# 前端（devcare.test.ts 30 例 + device-care.svelte.test.ts 43 例；整套 check 含 tsc / svelte-check / i18n 奇偶）
cd crates/amos-tauri/frontend-ts && bun run check
bun test src/__tests__/devcare.test.ts
bun run test:svelte -- device-care
```

覆盖：垃圾分类/汇总/上限/饱和、计划校验/去重/确定性、逐条诚实执行、Mock provider（存在/缺失/配置失败/非幂等）、卸载判定全分支、权限审阅（去重/忽略拒绝/丢弃无法归因/有界/确定性）、体检（未观测/阈值/排序/边界/最坏档）、端到端 `scan→analyze→plan→execute` + 体检折叠 + JSON 往返；**真实文件系统**（临时目录）扫描/删除/根限制/符号链接/非空目录/深度上限；**审计**（事件构造、聚合/逐条/拒绝/有界/多字节截断、**加速的聚合+逐条失败**、**attempted 记账：短缺或簿记丢失应用绝不读作成功**、`RecordAudit` 校验与落盘、无 sink 时的诚实降级、桥的 `recorded/attempted/reason` 不变量）；**电量折叠**（全字段映射、部分读数不伪造罚分、越界/非有限 ⇒ 不评估、`0`/`100` 边界为真读数、`20.6 ⇒ 21` 取整、后端优先于宿主、后端答了部分就不回落到宿主、`thermal` 未知只少说、**宿主读数缺标志 ⇒ 不评估**、sysfs `Full`/`Not charging` ⇒ 插电且**本机可测**）；**量测不补零**（缺尺寸的行被跳过并计入部分扫描，真 `0` 保留）；**部分体检可见**（`careAreaSplit` 域序 + DOM 三态）；**桥**的策略执行、诚实默认、清理后重扫、加速的 wire 形状；**前端** normalizer 全量性、客户端策略校验、审计状态展示与降级、DOM 各状态渲染。

> 说明：`hostfs` 的测试用自建临时目录（进程 id + 原子序号）并在 `Drop` 中清理，不引入 `tempfile` 依赖。守护进程侧的落盘测试在临时目录建真 JSON-lines 文件并**重开校验**（重启后仍在）；`crates/amos-ai/tests/privacy_audit_e2e.rs` 用**真 UDS + 真 daemon**验证写入 + 读回；`crates/amos-tauri/tests/devcare_audit_e2e.rs` 更进一步——用**桥自己的函数**（`devcare::record_audit` / `privacy_client::perm_recent_trail`）打真 daemon，覆盖「桥 → 守护进程 → 磁盘」这最后一段，并断言落盘 outcome 与 wire 一致。

---

## 7. 路线图（下一阶段，遵循仓库「领域内核 → 桥 → UI」惯例）

- [x] **Tauri 桥 `crates/amos-tauri/src/devcare.rs`**（2026-09-10）：managed `DevCareBridge` + 命令 `devcare_status` / `devcare_scan` / `devcare_clean` / `devcare_apps` / `devcare_permissions` / `devcare_report`，已 `manage` + 注册进 `generate_handler`；`AMOS_DEVCARE_ROOT` 设置时挂 `hostfs` 后端（真实扫描 + 受限删除），未设置时诚实 `backend:"none"`。**硬化**：桥只接受类别 tag（前端不能指名路径），未知 tag 拒绝，清理后重扫快照。
- [x] **Svelte 管家页 `DeviceCareApp.svelte`**（2026-09-10）：体检卡（先判 `has_data`，未观测显示「—」而非 100）+ 垃圾分类勾选 + 一键清理（只喂 `auto_cleanable_kinds`）+ 审阅型确认 + 应用策略（只对 `allowed` 显示卸载，被拒显示 `reason_key`）+ 权限只读审阅；注册进 `appMeta`/`appRegistry`/`appGroups`（第 26 个内置应用），`en`/`zh` i18n 全量对齐。桥模块 `lib/devcare.ts` 提供全量 normalizer 与客户端策略校验。
- [x] **审计落盘（2026-09-10）**：清理与卸载都写入守护进程的**统一审计 sink**（`PrivacyService.RecordAudit` → `PrivacyManager::record_audit` → `amos-ai::audit::AuditFile`，与隐私裁决同一 JSON-lines 文件）。事件内容由纯领域函数 `amos-devocare::audit` 决定（聚合 `devcare.clean` + 逐条 `devcare.clean.item` + `app.uninstall`，**拒绝也记 `rejected`**，有界 50 条、按字符截断）；守护进程**盖自己的时间戳**、校验 outcome/principal/op、无持久 sink 时诚实回 `ok=false`；桥把 `recorded/attempted/reason` 如实透传给 UI（「审计未记录」而不是假装有 trail）。
- [x] **卸载策略不可绕过（2026-09-10）**：新增 `devcare_uninstall`（Rust 侧先跑 `UninstallGuard` 再卸载、策略先于库存查询），前端「手机管家」改走该命令，不再直接调 `appstore_uninstall`。
- [x] **审计消费 UI（2026-09-10）**：新增 `PrivacyService.RecentTrail` + `PrivacyManager::recent_trail` 读**同一个** `AuditFile` 窗口；Tauri `perm_recent_trail` / `devcare_trail` 用 `audit::ACTOR` **在 Rust 侧过滤**（actor 单源）；管家页「近期操作（审计）」卡片渲染 时间 / 操作 / 资源 / 结果，并区分 **空 / 无持久 sink / 读失败** 三种非空态。
- [x] **权限数据取自 daemon 权威（2026-09-10）**：新增 `PrivacyService.GrantedAll` + `PrivacyManager::grants_snapshot`（一次取回全部持有者）；`devcare_permissions` **不接受**前端观测，行由 daemon 提供、形状由 `review_grants` 定，返回 `{rows, authority}`；`authority:"unavailable"` 与「权威答案为空」在 UI 上严格区分。
- [x] **真机 Android `CleanProvider`（2026-09-10）**：新增 Kotlin `DevCareGlue`（`android-glue/com/amos/ai/glue/DevCareGlue.kt`）+ Rust `crates/amos-tauri/src/devcare_device.rs`（feature `android`）。设备后端通过 JNI 安装进同一个 `DevCareBridge`：
  - **扫描**：`scanJunk()` 走应用**自己的** `cacheDir`/`codeCacheDir`/`externalCacheDir` 子树（缓存 / 缩略图 / 墓碑 / dmp / 空目录）与 `filesDir`（轮转日志 / 临时文件 / 残留 APK），并 best-effort 查询 MediaStore `Download` 集合里的残留安装包。**未 root 的零售机读不到别的应用的 `cache/`**，所以它老实只报自己看得见的东西，不假装是全盘清理器。
  - **删除**：`removeJunk(uri)` —— 应用私有路径（Kotlin 侧 `canonicalFile` 前缀校验，与 Rust `hostfs::is_within` 同构，双重防御）或 `content://` URI；目录只 `delete()`（仅空目录成功），绝不递归。
  - **存储读数（本轮新增）**：`storage()` 用 `StatFs(Environment.getDataDirectory())` 读**真实**内部存储总/已用/可用；新增命令 `devcare_storage` → `StorageOut{total_bytes,used_bytes,free_bytes,used_pct,measured,backend,groups,reclaimable_bytes,review_bytes}`，管家页新增「存储概览」卡片（总量 / 已用条 / 可用 / 分类可回收）。**诚实边界**：host-fs 后端测不了整盘容量 ⇒ `measured:false` 且三个字节全 `null`，UI 显示「—」，绝不伪造 `0 B`。
  - **包库存**：`installedApps()` 由 `PackageManager.getInstalledApplications` 提供（`system` 取自 `ApplicationInfo.FLAG_SYSTEM`，尺寸为已安装 APK 的**真实**长度，读不到即省略 ⇒ `null`），排序稳定，成为 `devcare_apps` 的唯一库存来源。
- [x] **扫描上限不静默截断（2026-09-11）**：`DevCareGlue.scanJunk()` 此前在凑满 `MAX_ITEMS`（10 000）时**静默截断**并返回数组——Rust 侧 `analyze` 只拒 `> MAX_JUNK_ITEMS`，所以被裁掉的尾巴对用户与规划器都不可见，恰好违反 §5.3「破坏性输入从不被静默裁剪」（host-fs 后端在超上限时是**硬错**）。现 `walk`/`scanPublicDownloads` 改为**插入前检查**：一旦还有第 `MAX_ITEMS + 1` 项就返回 `true`，`scanJunk` 随即回 `{"error":…}`（Rust `parse_reply` → 诚实 `Err`，UI 显示扫描失败而非「没有垃圾」）。桥侧另加**防御性** `parse_scan_reply`：达到上限的数组一律 `TooManyItems`，未知 `kind` 计为 `unreadable_dirs`（部分扫描可观测）。**边界**：恰好 `MAX_ITEMS` 项仍视为完整（与 `junk::push` 的 `> cap` 语义一致）；Kotlin 侧行为仍需真机验收。
- [x] **设备侧卸载意图（2026-09-10）**：`devcare_uninstall` 在设备后端改走 `PackageManager` 卸载意图（`ACTION_DELETE`），且**策略先行**（`UninstallGuard` 先拒系统包 / 关键包）。ACTION_DELETE 只是**请求**：系统弹窗异步确认，因此 wire 上新增 `launched: bool` —— `removed` 保持 `false`，UI 显示「已请求卸载，请在系统弹窗中确认」，审计记 `app.uninstall / success / launched`，**绝不假装已卸载**。
- [x] **主线程保护（2026-09-10；2026-09-11 扩到 `devcare_report`）**：`devcare_scan` / `devcare_clean` / `devcare_apps` / `devcare_uninstall` / `devcare_storage` / `devcare_report` 全部为 `async` + `spawn_blocking`（`devcare::offload`），把 JNI/`PackageManager`/MediaStore/`BatteryManager`/`StatFs` 调用移出 UI 线程——一个卡住的平台调用不会冻住界面（与 `sms.rs` 同一理由）。`attach`（`DevCareGlue.bind`，跑在 Activity `onStart`）只安装后端、**不扫描**，并附一条 `Log.i` 自检（`StatFs` 读数 + `BatteryManager` 读数 + 包数量），使设备日志可决定性验证。**（2026-09-11 修正）** 此前 `attach_device` 会在**主线程**同步跑一次 `scanner.scan()`（即 JNI `scanJunk()` 文件系统遍历），与本文件及 `devcare_device.rs` 文档承诺的「attach 不扫描」相反、也与 Kotlin `bind` 注释「junk walk stays lazy」相反——现改为只安装后端并**清空旧快照**（`scanned_items == 0`），扫描一律经 `devcare_scan` 的 `spawn_blocking` 执行；见 REQ-DC49 的两条测试。
- [x] **电池读数改用 `BatteryManager`（2026-09-11）**：Kotlin `DevCareGlue.battery()` 读**与 `amos-power` 同一处的** sticky `ACTION_BATTERY_CHANGED`（`level`/`scale` → `level_pct`、`status` → `charging`），`thermal_throttled` 取平台自己的 `PowerManager.currentThermalStatus >= THERMAL_STATUS_MODERATE`（API 29+；更早版本**省略** ⇒ 未知，绝不伪造成「未降档」）。Rust 侧新增 `CareScanner::battery()`（默认未知）+ `AndroidScanner::battery()` + host 可测的 `parse_battery_reply`；`DevCareBridge::report` 以**后端**为准，只有后端**全未知**才回落 `host_battery.rs`（不再把宿主读数补进一个部分回复）。折叠规则见 §3.5：**未知只让少说**（`level_pct`/`charging` 未知 ⇒ 电池区不评估；`thermal_throttled` 未知 ⇒ `false`）。`devcare_report` 随之改为 `async` + `offload`（JNI 与 `pmset` 都离开 UI 线程）。**诚实边界**：真机的**运行期**读数仍需 USB 设备验收（§8.2 第 3 步的 `self-check battery =>`）；本机只验证「编译 + 纯折叠逻辑 + 后端接线」。`amos-profiling` 的 `BatterySample`（电流×电压 ⇒ mW）**未**并入本报告——`BatteryCare` 只需电量/充电/降档三个事实，把瞬时功率塞进来会造出一条领域无法解释的读数。
- [x] **内存加速可审计（2026-09-11，REQ-DC57）**：审计发现清理/卸载都进统一 trail，唯独**强制停止应用的 boost 没有任何审计事件**——一个有后果的动作在 trail 上不可见（DO-178C 可追溯性缺口）。现 `amos-devocare::audit::boost_events`（纯函数）为每次 boost 产出聚合 `devcare.boost`（`requested/reclaimed/failed` 取自输入本身，**部分失败即 `error`**）+ 每条失败一条 `devcare.boost.item`（有界 50、按字符截断、确定性）；桥在 governor 可达时构造事件并 `record_audit`，`BoostOut` 新增 `audit` 字段如实回报落盘与否（governor 不可达 ⇒ 零事件 + 零值 audit，**不伪造 trail**）；前端 `normalizeBoost` 全量携带 audit（缺省降级为「未尝试」）、`OP_I18N` 补 `devcare.boost(.item)` 标签、UI 复用共享审计状态（加速后与清理/卸载同样显示「已记录审计 / 审计未记录」）。测试：领域 `audit::tests` +5、桥 `the_boost_out_reports_whether_it_was_audited`、前端 normalizer 扩展 + DOM 3 例。**同日审计加固**：自审计发现两处残余缺口并修复——(1) 领域层 `boost_events` 未交代「从未被尝试」的请求项（`attempts.len() < requested.len()` 时聚合仍可能读作 `success`），现聚合改报 `requested/attempted/reclaimed/failed` 四数，`success` **仅当零失败且 `attempted == requested`**，短缺可见但不伪造逐条记录（+2 领域用例）；(2) e2e 只覆盖 clean/uninstall 的 op，`devcare.boost(.item)` 从未过真 wire——现 e2e 写入 5 条记录（含 boost 聚合+逐条 `error`）过真 daemon 落盘并读回校验四数；(3) 前端补 `reason` 透传/畸形 audit 降级/`auditComplete` 三态与「空加速仍显示已记录事件」的 DOM 用例。验证：amos-devocare **84** lib + 4 集成、e2e 1 例、前端 pure **949**（97 文件 EXIT=0）、svelte **471**、tsc/svelte-check 0/0、clippy（default + android）与 fmt 全绿。

---

## 8. 真机 bring-up 与验收（Android / feature `android`）

设备后端的**编译与产物**已在本环境验证；**运行期**验收需要一台 USB 连接的设备。

### 8.1 构建与安装

```bash
make android-app    # 重建前端 dist → aarch64 debug APK → adb install -r -g
# 等价于：
cd crates/amos-tauri/frontend-ts && bun run build
cargo tauri android build --debug --features android --target aarch64
adb install -r -g crates/amos-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

**已在 2026-09-11 验证（S5 / Android 14 / arm64）**：

- Gradle 编译 `DevCareGlue.kt` 通过（Kotlin 与所用平台 API 均有效）；
- APK 内 `classes7.dex` 含 `DevCareGlue bound (Rust backend attached)`、`self-check storage =>`、`self-check installedApps =>`、`refusing a path outside the app's own directories`；
- `lib/arm64-v8a/libamos_tauri_lib.so` 导出 `Java_com_amos_ai_glue_DevCareGlue_attach`（缺它时 attach 会静默 no-op）；
- `adb install -r -g` 报 `Success`。

**2026-09-11（电池轮）本机复验**：`DevCareGlue.kt`（含 `battery()`）经 `./gradlew :app:compileUniversalDebugKotlin` **BUILD SUCCESSFUL**（JDK 17 + Android SDK 36）；Rust 侧 `cargo test -p amos-tauri --lib` **227**（`devcare::` **27**、`host_battery::` **7**）、`--features android --lib` **230**（`devcare_device::` **4**）、`clippy --all-targets -D warnings`（default 与 `--features android`）干净。**诚实边界**：本轮**没有**重建 APK，所以上面产物里的字符串清单仍是**上一轮**构建的结果——`self-check battery =>` 要等下一次 `make android-app` 才会出现在 dex 里；真机的**运行期**读数仍需按 §8.2 在设备上验收。

### 8.2 运行期验收清单（需设备）

| 步骤 | 命令 | 通过判据 |
|---|---|---|
| 1. 清日志并启动 | `adb shell logcat -c; adb shell am start -n com.amos.ai/.MainActivity` | — |
| 2. 后端已安装 | `adb logcat -d -s DevCareGlue:I` | `DevCareGlue bound (Rust backend attached)`；若为 `devcare attach upcall failed …` ⇒ 原生库未含 `android` feature |
| 3. 真实读数（自检） | 同上 | `self-check storage => {"total_bytes":…,"used_bytes":…,"free_bytes":…,"volume":"data"}`，与 `adb shell df /data` 同量级；`self-check battery => {"level_pct":…,"charging":…,"thermal_throttled":…}`，与「设置 → 电池」同值（`thermal_throttled` 在 API < 29 上按设计**不出现**）；`self-check installedApps => N apps` 与 `adb shell pm list packages \| wc -l` 同量级（无 `QUERY_ALL_PACKAGES` 时会更少，属平台过滤，不是伪造） |
| 4. 界面 | 打开「手机管家」（`app.devocare`） | 存储概览显示 总/已用/可用 + 分类；体检卡的电量相关 finding（`care.battery.low`/`critical`/`thermal`）只在真有对应事实时出现，读不到电量时**不评估**电池区（不显示任何电量 finding，也**不**伪造「健康」）；应用列表来自 `PackageManager`（**不是**商店注册表）；系统包显示 `care.uninstall.systemApp` 且无卸载按钮 |
| 5. 卸载意图 | 对一个用户应用点「卸载」 | 弹出**系统**卸载确认；界面文案为「已请求卸载，请在系统弹窗中确认」（**不是**「已卸载」）；审计记 `app.uninstall` |
| 6. 清理 | 勾选类别 → 一键清理 | 释放字节真实（对照 `adb shell du -s <cacheDir>`）；失败逐条列出；无后端时显示「—」而非 `0 B` |

### 8.3 设备实测记录（2026-09-11，S5 / Android 14 / arm64）

**A. Kotlin 自检（`adb logcat`，标记文件存在时）**

```
I DevCareGlue: DevCareGlue bound (Rust backend attached)
I DevCareGlue: self-check storage => {"total_bytes":247410065408,"free_bytes":231368859648,"used_bytes":16041205760,"volume":"data"}
I DevCareGlue: self-check battery => {"level_pct":17,"charging":true,"thermal_throttled":false}
I DevCareGlue: self-check installedApps => 216 apps
```

交叉核对（同一时刻）：`adb shell df -k /data` 的 **241,611,392 KiB × 1024 = 247,410,065,408 B** 与 `total_bytes` **逐字节一致**；`adb shell pm list packages | wc -l` = **216**，与自检的 `216 apps` 一致（证明 `QUERY_ALL_PACKAGES` 生效，没有被平台过滤）。

**B. Rust bring-up 自检（`<dataDir>/files/devcare-selfcheck.out`，经 `run-as` 读回）**

```bash
adb shell run-as com.amos.ai touch files/devcare-selfcheck
adb shell am force-stop com.amos.ai && adb shell am start -n com.amos.ai/.MainActivity
adb shell run-as com.amos.ai cat files/devcare-selfcheck.out
```

```json
{
  "resolved_dirs": ["/data/user/0/com.amos.ai/files", "/data/user/0/com.amos.ai", "/data/user/0/com.amos.ai/cache"],
  "plant_dir": "/data/user/0/com.amos.ai/cache",
  "storage": {"total_bytes": 247410065408, "used_bytes": 13235027968, "free_bytes": 234175037440, "measured": true},
  "planted_temp_file": {"path": "/data/user/0/com.amos.ai/cache/devcare-selfcheck.tmp", "written": true},
  "scan": {"items": 15, "kinds": ["app_cache", "empty_dir"], "saw_planted_temp_file": true, "unreadable_dirs": 0},
  "inventory": {"apps": 216, "system_apps": 215, "with_size": 216, "sample": ["android", "android.auto_generated_rro_product__", "com.aiwinn.android.overlay.modules.safetycenter"]},
  "remove_planted": {"ok": true, "error": null, "file_gone": true},
  "refuse_outside_path": {"refused": true, "error": "provider failed for /data/local/tmp/amos-devocare-selfcheck: refusing a path outside the app's own directories"}
}
```

这一份同时证明了**每一条 JNI 契约**：`storage()`/`scanJunk()`（且 Rust 植入的临时文件**确实被扫到**）/`installedApps()`（216 个包，215 个系统包，全部带真实尺寸）/`removeJunk(uri)`（Rust 指令下达后**文件真的消失**）以及**越界路径被 Kotlin 侧拒绝**（双重防御生效）。

**C. 探针（`DevCareGlue.probeAttached()`，只读、永不阻塞）**

```
# 冷启动第一次 onStart（setup 尚未运行）
{"app_handle":false}
# 再次前台（setup 已运行）
{"app_handle":true,"available":true,"backend":"android","bridge_lock":"free","can_clean":true,"glue":true,"installed":true,"scanned_items":0}
```

**D. 本轮在真机上发现并修掉的三个真实缺陷**

1. **后端从未被安装（顺序缺陷）**：`DevCareGlue.bind` 跑在 Activity `onStart`，经实测**早于** Tauri 的 `setup` 钩子，因此 `Java_..._attach` 里 `APP.get()` 为 `None` → 静默 `return`，**设备后端从未挂上**（而 Kotlin 自检照样打日志，因为它直接调平台 API——一个「看起来一切正常」的静默失败）。修法：两侧**对称、与顺序无关**（`APP`/`GLUE` 两个 `OnceLock` + `INSTALLED` 原子标志，谁后到谁安装），并由 §C 的 `installed:true, backend:"android"` 证实。
2. **`app.path()` 在 Android 主线程上自死锁**：`PathResolver` 在 Android 上是**经 WebView JS 的往返**（`plugin:path|resolve_directory`）；从主线程（JNI 回调链）调用它会等一个只能由同一个主线程跑出来的答复 → 挂死。本轮的诊断探针第一次在 `APP` 存在时调用 `app.path()` 就**挂了整整一分钟以上**（表现为 `self-check rust` 行彻底消失、且没有任何异常日志）。现在探针**完全避开 `app.path()`**（路径由工作线程的报告给出），并把这条写进注释与本节。
3. **冗长自检在每次 `onStart` 的主线程上跑 ~2 秒**：`installedApps()` 设备实测耗时 **1.9–2.1 s**（`08:13:40.195 → 08:13:42.144`），而它原先在 `bind()` 里**无条件**执行 → 每次冷启动/回前台都卡主线程约 2 秒。现改为**标记文件驱动**（`devcare-selfcheck` 存在才跑），生产启动零开销。

**F. UI 渲染验收（2026-09-11）——一度整屏白，但根因不在本仓代码**

设备侧 UI 一度**整屏纯白**（`adb exec-out screencap` 分析：99.6% 为 `(255,255,255)`、**零**饱和像素）。用 `AmosMainActivity.onWebViewCreate`（新增的设备侧探针，见下）取到决定性证据：

```
I AmosMainActivity: onWebViewCreate id=main domain=wry.assets withAssetLoader=false
I AmosMainActivity: webview url=http://tauri.localhost/ progress=10 contentHeight=0
```

- WebView 拿到了**正确**的 URL，且 `withAssetLoader=false` ⇒ 走 `.so` 内嵌 bundle 的 `handleRequest` 路径（`.so` 里确实有 `/index.html`、`/assets/*.js`，已用 `strings` 验证；APK 的 `assets/` 里**只有** `tauri.conf.json`，所以 `AssetsPathHandler` 那条路本来就不该走）；
- 但页面**卡在 `progress=10, contentHeight=0`**，且 `evaluateJavascript` 的回调**永不触发**。

logcat 同步给出原因：

```
W ActivityManager: Unable to launch app com.amos.ai/10171 for service Intent { cmp=com.amos.ai/org.chromium.content.app.SandboxedProcessService0:0 }: process is bad
W cr_ChildProcessConn: Fallback to ComponentInfo{com.google.android.webview/...SandboxedProcessService1}
E cr_ChildProcessConn: Failed to establish the service connection.
```

即 **WebView 的渲染子进程根本起不来**。触发条件：连续多次 `adb install -r` + `am force-stop` 之后，ActivityManager 把该进程标成 `bad`，此后它的 `SandboxedProcessService` 一律拒启。**`adb reboot` 后立刻恢复**（同一次 `screencap` 变成 25,000+ 种颜色 / 42,575 个饱和像素，`process is bad` 计数为 0，`inkmap` 能看出壁纸 + 网格 + dock）。

⇒ **设备 bring-up 纪律**：反复重装 APK 之后不要靠 force-stop 重启 UI 来验收——**先重启设备**。这条同时解释了「同一个 APK 昨天还好、今天白屏」这类假故障。

**UI + 后端联动的验收结论**（重启后）：存储概览卡片显示**真实**总/已用/可用与分类（`StatFs`，与 `df -k /data` 逐字节一致）；「应用」卡片列出 `PackageManager` 的真实库存（216/217 项，含为测试新装的第三方 POC 应用）。

**G. 用户实测反馈 → 已修（2026-09-11）**：217 行的应用列表**把整页撑得过长**（要滚好几屏才能看到权限/内存/审计卡）。现改为**有界独立滚动窗口**：应用列表与权限审阅各自 `max-h-72 overflow-y-auto overscroll-contain`，并在卡片头显示计数（`care.appsCount` / `care.permsCount`）——**所有行仍可达**，只是不再把页面其余部分推走。DOM 测试锁住「窗口存在 + 行全在窗口内 + 计数正确」两例。

**H. 仍未闭环的一步**：从管家页点「卸载」→ 系统确认框 → 应用消失的**完整**链路尚未在本轮拿到干净证据（第一次尝试时页面正处于 `F` 的坏进程状态；对照组 `adb shell am start -a android.intent.action.DELETE -d package:…` 已证明该设备的 `UninstallerActivity` 正常）。策略拒绝（系统包）与 `launched` 语义由 host 测试与 §B 的 `removeJunk` 证据覆盖。



### 8.4 诚实边界（真机）

- **扫描范围**：未 root 零售机只能清理**应用自身**的目录与公共 `Download` 里的残留安装包；别的应用的 `cache/` 既读不到也删不掉——管家页**不承诺**「整机全盘清理」。
- **`ACTION_DELETE` 是异步的**：本仓只能确认「系统弹窗已拉起」，确认结果由系统决定；`removed == true` 只出现在**宿主商店后端**（同步删除）。
- **存储读数**取自 `Environment.getDataDirectory()`（内部存储）的 `StatFs`，不含外置卷；外置卷未建模。
- **电池**取自 `BatteryManager` **的 sticky `ACTION_BATTERY_CHANGED` 广播**（`level`/`scale`/`status`，与 `amos-power` 的能量 governor 同源），**不是** `getIntProperty(CAPACITY)`；`thermal_throttled` 是平台自己的 `PowerManager.currentThermalStatus` 判定（API 29+，更早版本**不报**）。**只有平台真的报了 `status` 才发 `charging`**——`BATTERY_STATUS_UNKNOWN` / 字段缺失一律省略（⇒ 电池区不评估），绝不把「不知道」写成「未充电」（那会凭空造出一条低电量告警）；**越界的 `level`**（`level > scale`，即一条自相矛盾的广播）**不是读数**，按读取失败处理。瞬时功耗（`amos-profiling` 的 `BatterySample`，电流×电压 ⇒ mW）**不在**本报告内——`BatteryCare` 只承载电量/充电/降档三个事实。读不到电量时电池区**不评估**（不是「健康」也不是「0」）；宿主（桌面）仍用 `host_battery.rs` 的真读数，且只有后端**全未知**时才回落。
- **公共 `Download` 集合只在 API 29+ 存在**（`MediaStore.Downloads`）：更早的机器**显式跳过**该 best-effort 扫描（`Build.VERSION.SDK_INT < Q`，不是靠捕获 `NoSuchFieldError`），所以 API 26–28 上清不到公共下载里的残留安装包——这是**平台限制**，不是「没有垃圾」。

