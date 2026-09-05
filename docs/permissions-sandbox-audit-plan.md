# 细粒度 Permissions Manager + 三方扩展沙箱 + 运行时安全审计 —— 现状盘点与落地计划

> 状态：**盘点稿 / 设计计划**（纯文档，未改代码）。日期：2026-09-05。
> 范围：回应「系统级账户与安全沙箱隐私管理」缺口 —— 缺乏细粒度应用权限管理系统、
> 三方扩展应用的沙箱技术方案与运行时安全审计需要补全。
> 语言约定：保留既有标识符（`PrivacyManager`/`Resource`/`Capability`…）原文，叙述用中文。
>
> **落地进度（2026-09-05）：Phase 1 + Phase 4 已实现并验证** —— `amos-ai` 新增统一审计模块
> `audit.rs`（`AuditRecord`/`Outcome`/`AuditFile` 可持久 JSON-lines sink + 跨域互转），
> `privacy.rs` 加 `save(path)`/`load(path)` 原子持久化（授权表 + 审计），`security.rs::AuditLogger`
> 加可选 `new_persistent` 落盘通道；`amos-ai` lib **118→143 passed**，clippy/fmt 干净（详见 CHANGELOG）。
> **后续补充**：`privacy.rs` 运行时 `authorize()` 决策可经 `with_audit_file`/`with_durable_audit`
> 镜像进统一可持久 sink（`amos-ai` lib **144 passed**）。
>
> **Phase 2 已实现并验证（2026-09-05）** —— 真做 gRPC 权限 RPC：
> 新增 `proto/privacy.proto`（`amos_privacy`，service `PrivacyService`：`Grant/Revoke/RevokeAll/
> Authorize/Granted/RecentAudit`，资源用稳定 wire-key，未知键 INVALID_ARGUMENT），
> `amos-proto` build/lib 注册；`amos-ai` 新 `privacy_service.rs`（`PrivacySvc` 持共享
> `PrivacyManager`，`Authorize` 单一咽喉 + 全裁决审计，`AMOS_PRIVACY_PATH` 时 grant 原子落盘、
> 决策镜像到 `<path>.jsonl`），并挂载进 `serve()` 与 governor 等共享同一 UDS；
> `amos-ai` lib **148 passed**（+4 service 单测）+ 真 UDS e2e `tests/privacy_rpc_e2e.rs`（1 passed）；
> `amos-tauri` 新 host 客户端 `privacy_client.rs`（`perm_authorize/grant/revoke/granted/recent_audit`）
> 注册进 invoke handler，`cargo check/clippy -p amos-tauri` clean。
>
> **Phase 2.2/2.3 部分（2026-09-05）** —— 前端词汇对齐 + daemon 桥 seam：
> `frontend-ts/src/lib/permissions.ts` 的 `Capability`/`CAPABILITIES` 补齐 `contacts`/`storage`
> （与 daemon `Resource` wire-key 对齐；`notifications` 明示为 local-only），`PermissionsApp`
> 的穷举 `CANDIDATES`/`CAP_ICON`/`capLabel` 与新 i18n 键（en/zh `perm.cap.contacts/storage`）补齐；
> 新增 `lib/privacyBackend.ts`（`daemonResource` 映射 + `daemonAuthorize/grant/revoke`，离线
> `null` 永不造假、local-only 不触达 daemon）作为 OS 门要消费的权威后端 seam；
> `tsc --noEmit` clean、权限/privacy-backend/capability-gate/camera/voice 测试全绿。
>
> **完整 P2.2（2026-09-05）** —— `CapabilityGate`/`PermissionsApp` 的 allow/deny **改走 daemon 权威**：
> `useCapability` 挂载时（仅 online，`bridged()` 才探询）用 `daemonAuthorize` 对账——daemon「拒绝」会覆盖过期的本地授权；`allow()` 先 `daemonGrant` 再写本地缓存；`PermissionsApp` 每个 toggle 提交 `daemonGrant/daemonRevoke`（离线为 no-op）并保留本地账本作即时显示缓存。离线路径与旧行为逐字节一致（无 probe/无异步、无闪烁）。新增在线用例：daemon 拒绝覆盖过期本地授权 + Allow 提交 `perm_grant`。验证：`tsc --noEmit` clean；capability-gate（含新在线例 5 例）/camera/voice-mic/stream-voice/permissions/privacy-backend 各自跑绿（直接 `bun test a b…` 合跑会因多 DOM 文件共享 happy-dom 全局而误报隔离假阳性；仓库 runner 按文件隔离）。诚实边界：`daemonAuthorize` 离线/local-only 返回 `null`、`daemonGrant/Revoke` 离线为 no-op——真实 OS 边界执行（web-bundle 桥、真机 APK HAL 拦截）仍属设备/生态层（Phase 3/5），未造假。
>
> **Phase 5（host-side seam，2026-09-05）** —— 容器侧能力账本：新增
> `amos-android/src/capability.rs`（`CapabilityLedger`：deny-by-default、按 package 存敏感资源集，
> wire-key 与 host `PrivacyManager`/`proto/privacy.proto` 对齐；未知键拒绝、包隔离、
> grant/revoke/revoke_all/is_granted/granted/packages）——纯 Rust、`amos-ai` 无依赖，供未来
> 容器策略钩子 / LMK / `am force-stop` 层种子与查询。+5 单测；`clippy --all-targets -D warnings`
> clean、fmt clean。诚实边界：这是**决策数据 seam**——`AudioRecord`/`Camera.open` 的 HAL 级拦截
> 仍是设备/生态工作，未伪造已拦截。至此 Phase 1/2/3(纯 seam)/4/5(host seam) 均已落地。
>
> **审计消费 UI（2026-09-05）** —— 「隐私」仪表盘新增**近期访问（OS 权限审计）**视图：`privacyBackend`
> 增 `daemonRecentAudit` + 纯 `toAuditViews`；`PermissionsApp` 在线（`bridged()`）时拉取 daemon
> `perm_recent_audit`（≤20）渲染每条的 app/资源/允许或拒绝，离线不拉取、纯本地视图；i18n（zh/en）
> 增 `perm.recent.*`。验证：`tsc --noEmit` clean；privacy-backend 5 例（含 toAuditViews、离线 null、在线返回）。
>
> **Phase 3（纯 seam，2026-09-05）** —— web-bundle 沙箱能力桥**纯裁决逻辑**：新增
> `frontend-ts/src/lib/sandboxBridge.ts`（`SANDBOX_RESOURCES` = daemon wire-key 五元组；
> `validateCapabilityRequest` 结构化校验 `{type:"capability.request", resource, requestId}`，
> 未知资源/坏帧一律拒绝；`decideCapabilityRequest(raw, daemonGranted)` 仅当 daemon `perm_authorize`
> 返回 `true` 才 `granted:true`，`null`(离线)/`false` → 拒绝，无效帧无应答）——纯函数、与
> `lib/bundle.ts` 同风格。新增 `__tests__/sandbox-bridge.test.ts` **5 例**；`tsc --noEmit` clean。
> 诚实边界：这是**纯裁决 seam**——把它接进真实 `postMessage` 监听 / `amos-app://` 真 origin 宿主
> 才是真正的宿主接线（仍是设备/协议阶段，未造假）。

---

## 0. TL;DR（结论摘要）

当前安全/隐私域**不是一张白纸**，但存在三层割裂、两条「并行且不相通」的授权账本，以及一个
**「孤岛 seam」**（`PrivacyManager` 定义了但零消费者）。按用户诉求拆解：

1. **细粒度权限管理** —— Rust 侧已有 `amos-ai::privacy::PrivacyManager`（deny-by-default、按 app 授权、
   内置运行时审计），但**没有被任何 daemon 服务 / gRPC / Tauri 命令 / System UI 引用**，属于死 seam；
   前端另有一份 `lib/permissions.ts` 账本（`Capability[]`），只在前端内置应用调用点被
   `useCapability`/`CapabilityGate` 强制执行，且与 Rust 侧资源模型（`Resource`）**字段不一致**、无审计、
   缺 `contacts`/`storage`。**→ 缺的是一个「单一权威源」+ 一条把它接到各执行点的链路。**
2. **三方扩展沙箱** —— web-bundle 三方应用已在 `srcdoc iframe sandbox="allow-scripts"`（无 same-origin）
   中运行，OS 壳/存储默认不可达；`serve.rs`/`webinstall.rs` 已做 bundle 目录内路径限制。但**没有**
   三方侧「按需申请敏感能力」的受控通道（默认拿不到即安全，但也意味着沙箱与权限管理器之间没有任何
   授权/拦截桥）、无 CSP、未来 `amos-app://` 自定义协议宿主尚待接线。**→ 缺的是沙箱裁决/桥 seam。**
3. **运行时安全审计** —— `security.rs::AuditLogger` 与 `privacy.rs::recent_audit` 都是**内存有界环形缓冲**，
   有 `export_json()` 但无落盘持久化/订阅导出 hook；审计与授权账本分属两处、互相不通。**→ 缺持久化与聚合。**

一句话：**把 `amos-ai` 的 `privacy.rs` 从「死 seam」升级成「唯一权威 Permissions Manager」，并通过
「daemon 端裁决 + 前端/沙箱/真机各执行点代理」把它接通；审计统一收口、落盘可导出。

---

## 1. 现状盘点（Inventory）

### 1.1 Rust 守护进程层 —— 已存在「权限域核心」但无消费者

**`crates/amos-ai/src/privacy.rs`**（2026-09-04 新增，仓库自述为「Permissions-Manager domain seam」）：

- `Resource` 枚举（5 项）：`Microphone / Camera / Contacts / Location / Storage`，带稳定 `key()`/`from_key()`。
- `PrivacyManager`：`Arc<RwLock<HashMap<String, HashSet<Resource>>>>`，deny-by-default。
  API：`grant` / `revoke` / `revoke_all` / `granted` / `authorize` / `is_granted` / `recent_audit`。
- `authorize()` 是**单一裁决咽喉点**，每次裁决必写 `AccessRecord`（有界审计，`max_audit`）。
- 有 7 个单测；`amos-ai` lib 118 passed。

**核实：`PrivacyManager` 除自身与测试外，在仓库内无任何引用**（`server.rs`、`governor_service.rs`、
`amos-tauri/src`、`proto` 中均无）。它**未被 gRPC/Tauri/System UI 暴露**，**无持久化**（内存态，重启即失）。

### 1.2 Rust 守护进程层 —— 既有安全层（粗粒度，面向 AI daemon 客户端）

**`crates/amos-ai/src/security.rs`**：

- `Permission` 枚举：`Deny=0 / Limited=1 / Standard=2 / Admin=3` —— 按**客户端级别**授权，不区分资源。
- `PermissionManager`（client → 级别）+ `RateLimiter`（令牌桶：RPS + 每小时 token）+ `AuditLogger`
  （内存有界 Vec，`export_json()`，**无落盘**）。
- `server.rs` 只给默认客户端 `DEFAULT_CLIENT_ID` 授予 `Standard`，用于 AI 推理方法的准入/限流/审计。
- `SECURITY_LAYER_SUMMARY.md` 自列 TODO：审计落盘、权限数据库（替换内存 HashMap）。

> 定位：这是「**守护进程 API 调用者**」的粗粒度 ACL，**不是**「**应用对敏感资产**」的细粒度授权。
> 两者应分工互补，不应合并。

### 1.3 前端层 —— 另一套「并行账本」（内置应用在用，字段与 Rust 不一致）

**`crates/amos-tauri/frontend-ts/src/lib/permissions.ts`**：

- `Capability = "camera" | "microphone" | "location" | "notifications"`（注意：**无 `contacts`、无 `storage`**，
  多了一个 Rust 侧没有的 `notifications`）。
- `PermissionLedger = Record<AppId, Capability[]>`；持久化在共享 store `amos.permissions`，写盘
  `~/.amos/state.json`，注释称「可被 Rust 读取」。
- 纯函数 `capSet/grantedCaps/grantedApps/grantCap/revokeCap` + `loadLedger/saveLedger`。

**执行点**：
- `components/CapabilityGate.tsx`：`useCapability(appId, cap)` + 全屏 allow/deny 覆盖层，用于**内置**相机/麦克风/定位。
- `components/PermissionsApp.tsx`：隐私仪表盘（grant/revoke 每个 cap × app），候选 app 是**内置**应用的写死表
  （camera/ai/interpreter/phone/maps/weather/messages/mail），仅提到未来三方由 host 自行列举。
- 调用点：`CameraApp`（相机）、`StreamVoiceButton`/`VoiceMicButton`（麦克风）、`MapsApp`（定位）等。

**核实：前端 `backend.ts` 没有任何 permission/grant/privacy 命令** → 这套账本**只在浏览器/前端 JS 内裁决**，
**没有落到 daemon，也没有审计轨迹**；`loadLedger` 注释里的「可被 Rust 读取」目前无对应 Rust 读取方。

### 1.4 三方扩展（web-bundle）沙箱现状

- `crates/amos-appstore`：安装（`webinstall.rs`，tar 拒绝 `..`、`start` 路径与 `read_file` 已做路径加固——
  2026-09-04 audit）、清单（`model.rs`）、发布签名（`sign.rs`，Ed25519 + 安装前验签）、目录内安全文件服务
  （`serve.rs`：canonicalize 后必须落在 bundle 目录内、`nosniff`）。
- 宿主：`components/ExtApp.tsx` 逐文件 base64 取回 → `lib/bundle.ts` 内联相对资源为单一自包含文档 →
  放进 **`<iframe sandbox="allow-scripts">`（无 `allow-same-origin`）** 运行。三方代码拿不到 OS 壳/共享 store/存储。
- 诚实边界（既有文档已写清）：这是**无自定义协议**路径，适合 classic 单页 demo bundle；多页 / ESM /
  需真 origin 的 bundle 仍待真正 `amos-app://` 协议宿主（Rust `amos_appstore::serve` 就绪未接线）。

> 语义：**web-bundle 三方应用当前根本接触不到任何敏感资源**——这是**安全但残缺**的默认：因为拿不到，
> 也就没有「申请→裁决→审计」的需求闭环。缺口不在“默认被拒”，而在“**没有可用的能力申请通道与对应裁决**”，
> 以及「真机/容器 APK」路径上没有任何权限拦截。

### 1.5 真机 / 容器 APK（Waydroid）现状

- `amos-android` LMK-proxy / Activity-Task 生命周期代理（`lmk.rs`）控制容器内 legacy APK 的生死；cgroups
  做资源（CPU/内存）隔离；`am force-stop` 可落地 kill。
- **没有**针对三方 APK `AudioRecord`/`Camera.open`/通讯录读取的按 APK 权限拦截 —— 文档明确标注这是
  设备/生态层工作，仓库「不造假」。UDS socket + cgroups = 进程隔离，非「系统调用级策略强制」。

---

## 2. 需求 → 现状 → 差距对照（Gap Mapping）

| 用户诉求 | 现状 | 差距（GAP） |
|---|---|---|
| 细粒度权限管理（按应用 × 敏感资产） | Rust `PrivacyManager`（deny-by-default，5 资源）**存在但死 seam**；前端 `permissions.ts` 账本在用但**纯前端、无审计** | **G1 双账本割裂**：无「唯一权威源」。Rust `Resource` 与前端 `Capability` 字段不对齐（contacts/storage/notifications），无映射 |
| 拦截/授权三方访问麦克风/摄像头/通讯录 | 前端仅对**内置**应用做 gate；web-bundle 三方**默认拿不到**（无通道） | **G2 无 daemon 裁决暴露**：`authorize()` 未接 gRPC/Tauri → System UI 与沙箱无权威询问点 |
| 三方扩展应用沙箱技术方案 | web-bundle srcdoc iframe `allow-scripts` + serve/install 路径加固；`amos-app://` 宿主未接线；APK 无权限拦截 | **G3 沙箱-权限桥缺失**：沙箱内三方「如何合法申请一个敏感能力并被裁决/审计」没有 seam |
| 运行时安全审计 | `security.rs::AuditLogger`（内存）、`privacy.rs::recent_audit`（内存）各管各；有 `export_json` 无落盘 | **G4 审计不持久、不聚合、不与授权账本同源** |

补充差距（盘点新增）：
- **G5 无持久化**：`PrivacyManager` 授权表纯内存，重启即失（前端账本反而落盘了，方向相反）。
- **G6 资源模型分裂**：Rust `Resource{mic,camera,contacts,location,storage}` vs 前端
  `Capability{camera,microphone,location,notifications}` —— 交集仅 3 项，无单一 schema（proto）。
- **G7 无 System-UI 绑定**：`PermissionsApp` 改的是前端账本，与 daemon 授权无关，也没有「查看某 app 近期访问审计」。

---

## 3. 目标架构（Target）

一条原则：**授权 = 策略数据，裁决 = 单一咽喉点，执行 = 各边界代理**。把权威放在可信的 daemon，前端与沙箱
只是“查询 + 展示 + 把每个决策转发去审计”的客户端。

```text
                            ┌──────────────────────────────────────────────┐
   System UI（权限/隐私App）│        Permissions Manager（唯一权威）          │
                            │   amos-ai::privacy::PrivacyManager (持久化)    │
   ┌─ PermissionsApp ───────┼─ grant/revoke ─────────────────────────────▶  │
   │ CapabilityGate(callsite)│                                              │
   │ (内置应用调用点)          │   authorize(app, resource) ──► AccessDecision│
   └────────────────────────┼─ + 每次决策写 AuditEvent ──► 落盘审计导出       │
                            └───────────────▲──────────────────────────────┘
                                            │ 代理1：Tauri 命令（前端 gate 转 daemon 裁决）
   Web-bundle 三方 (srcdoc iframe)          │ 代理2：沙箱桥（真 origin / amos-app:// 之后）
   ─ 默认可得：无；申请走 bridge → daemon ───┘ 代理3（真机，honest seam）：APK interposer / HAL gate
```

要点：
1. **`Resource`/`AppId` 收进一份 proto/共享 schema**，两端（Rust/Tauri bridge、前端）共用，消除字段分裂。
2. **daemon 提供权限 RPC/Tauri 命令**：`grant/revoke/revoke_all/list/authorize/audit`；前端 `permissions.ts`
   账本退化为「daemon 的本地缓存/展示快照」或彻底由 daemon 管。
3. **运行时审计统一为一个事件流**（权限裁决事件 + 既有 security 访问事件），落盘 + 保留 `export_json`/查询接口。
4. **沙箱 bridge**：为 web-bundle/未来 `amos-app://` 宿主定义「能力请求」消息，全部经 `authorize()` 单一咽喉点。

---

## 4. 落地计划（Phases，含具体落点与验收）

> 遵守仓库纪律：transport-agnostic 纯域核心 + 可离线单测；改动必须 `clippy --all-targets -D warnings`
> clean、fmt clean、相关 crate 全绿；诚实 seam 不造假，跨进程/真机拦截留在调用侧并写 `docs/`。

### Phase 1 —— 让 `PrivacyManager` 可寻址：持久化 + 单一共享资源 schema（改动 amos-ai + 一处共享）

- **P1.1 持久化授权表**（`privacy.rs`）：新增 `load/save`（JSON 到 `~/.amos/` 或 daemon 数据目录），启动加载、
  每次 `grant/revoke` 后写盘（原子写：写 tmp + rename）。保持 `RwLock`，避免与既有纯内存路径冲突（可做成
  `new(max_audit)` 无盘 与 `with_store(path)` 有盘 两种构造）。
- **P1.2 单一 schema / key**：定义共享 wire key 集（沿用 `Resource::key()`：`microphone/camera/contacts/location/storage`），
  确认前端 `Capability` 与之一一映射；把 `notifications` 明确归为「非敏感资产/独立域」，避免混入。
- 落点：`crates/amos-ai/src/privacy.rs`（+ 持久化单测：round-trip、盘损坏回退、原子写）。可新增一个
  `proto`/Rust 共享类型文件承载 `AppId`+`Resource` 的 wire 描述，供两端复用。
- 验收：`amos-ai` lib 新增若干测试全绿；clippy/fmt clean。**不接任何网络/命令**（保持 seam）。

### Phase 2 —— 暴露裁决命令并接到前端（改动 amos-tauri/src + frontend-ts + 视情况 proto）

- **P2.1 daemon/Tauri 权限命令**：新增一组 Tauri command（Rust 侧）把 `PrivacyManager`（`Arc` 共享实例）包起来：
  `perm_list_apps / perm_grant / perm_revoke / perm_authorize / perm_audit`。授权判定以 daemon 为准。
- **P2.2 前端接线**：`lib/permissions.ts` 的 `loadLedger/saveLedger/capSet` 改为优先走 daemon（离线回落本地缓存，
  保留现有单测不破坏）；`CapabilityGate::useCapability` 的 allow/deny 最终调用 `perm_grant/perm_authorize`，
  使**内置相机/麦克风/定位**的实际裁决与审计落到 daemon。
- **P2.3 补齐 `contacts`/`storage`** 到前端 `Capability`/`PermissionsApp` 候选（与 Rust `Resource` 对齐），
  相关 i18n 键补齐。
- 落点：`amos-tauri/src/lib.rs`（注册命令）、`frontend-ts/src/lib/backend.ts`、`lib/permissions.ts`、
  `components/CapabilityGate.tsx`、`components/PermissionsApp.tsx`、`i18n/locales/{zh,en}.ts`。
- 验收：Rust 编译/clippy clean；前端 `tsc --noEmit` clean；`CapabilityGate`/`permissions`/`PermissionsApp`
  测试更新后全绿；e2e 断言「gate 允许 → daemon `authorize()` 返回 Granted 且 audit 出现 Success」。

### Phase 3 —— 三方 web-bundle 沙箱桥（改动 amos-tauri 宿主 + bundle/lib；honest seam）

- **P3.1 明确沙箱声明**：给 iframe 增加可审计的 `allow-*` 语义与 CSP（`sandbox` 保持无 `allow-same-origin`；
  文档写明：默认能力集为空）。
- **P3.2 能力请求桥（seam）**：为真正需要敏感能力的 web-bundle 定义受限 `postMessage` 协议
  （`{type:"capability.request", resource, requestId}`）→ 宿主收到后**只放行**若 `perm_authorize` 裁决 Granted，
  并回传结果；**默认全部 Denied 且每次记录审计**。此阶段先落地「裁决/审计的桩 + 单测」，真 origin
  `amos-app://` 宿主接线（`serve.rs` 已就绪）留到设备/协议工作。
- 落点：`frontend-ts/src/lib/bundle.ts`（或新 `sandboxBridge.ts`，纯函数可测）、`components/ExtApp.tsx`、
  文档 `docs/appstore.md` 同步「三方敏感能力申请」小节。
- 验收：前端新纯函数单测全绿（请求→裁决→审计映射正确、非法资源拒绝）；`tsc` clean。诚实边界写明「真 origin
  宿主接线在设备/协议阶段」。

### Phase 4 —— 运行时安全审计统一、落盘、可导出（改动 amos-ai security/privacy + 导出）

- **P4.1 审计事件归一**：定义统一 `AuditEvent`（who/app × what/operation × resource × decision × when），
  让 `security.rs::AuditLogger` 与 `privacy.rs` 审计共用同一事件模型与单一 `log()` 通道。
- **P4.2 落盘 + 查询**：`AuditLogger`/privacy 审计支持 append 到日志文件（含轮转上限），保留 `export_json()`，
  新增按 app/resource/result 过滤查询；补全 `SECURITY_LAYER_SUMMARY.md` 里既有的「审计落盘」TODO。
- 落点：`crates/amos-ai/src/security.rs`、`privacy.rs`（或抽 `audit.rs`）。
- 验收：单测覆盖「granted/denied 都落审计、重启可读、轮转有界、导出合法 JSON」；clippy/fmt clean。

### Phase 5 —— 真机/容器 APK 拦截（honest seam，设备工作；改动 amos-android 仅留 seam + 文档）

- **P5.1 在容器侧加权限查询 seam**：`lmk.rs`/controller 记录每个 APK 当前前台/持有能力（与 `PrivacyManager`
  对齐），供未来 HAL/`am force-stop`-级策略钩子消费。
- **P5.2 文档化**：`docs/` 新增「真机三方 APK 的 `AudioRecord`/`Camera.open` 拦截」边界与所需设备栈
  （与既有 `lmk-proxy.md`、`no-ui-android.md` 一致的不造假风格）。
- 验收：无行为回归；改动仅 seam + 测试 + 文档。

---

## 5. 运行时安全审计设计（Data Model 草案）

```text
AuditEvent {
  ts:        u64,          // epoch secs
  principal: String,       // app id / client id（统一主语）
  op:        String,       // "perm.authorize" | "generate" | "camera.open" | …
  resource:  String,       // "microphone" | "camera" | "contacts" | "location" | "storage" | "tokens"
  decision:  Granted | Denied | Rejected | Error,
  details:   String,
}
```
- 有界内存环形（保持现在 latency）+ **异步落盘**（不阻塞裁决）。
- 单一 `log()` 咽喉，所有裁决/访问共写；`export_json` 与按 app 过滤为 SIEM/隐私 App 消费。
- 前端「隐私」页 = 读 daemon 审计 + 授权表，**不是**本地第二套账本。

---

## 6. 风险与「不造假」边界

- **web-bundle 默认拿不到敏感能力**是安全默认；P3 只做「受控申请桥」的裁决/审计 seam，不假装沙箱能安全地
  放行浏览器级 `getUserMedia` 直连。
- **真机三方 APK 的系统调用级拦截**（`AudioRecord`/`Camera.open`）是设备/生态工作，仓库只留 seam 与策略落点，
  不伪造“已拦截”。遵循 `privacy.rs` 现有诚实声明。
- **双账本迁移**要小心不破坏 `permissions.ts` 既有单测与离线回落；Phase 2 做到“daemon 在则 daemon 裁决、
  离线则本地缓存兜底”的平滑切换，避免前端功能退化。
- **持久化与 P0-1 gate**：新 IO 路径不得在 `not(test)` 下使用 `unwrap/expect/panic`（仓库 lib 顶部 `deny`），
  需返回 `Result`。

---

## 7. 参考文件索引

- `crates/amos-ai/src/privacy.rs` —— 权限域核心（死 seam，Phase 1/2/4 主战场）
- `crates/amos-ai/src/security.rs` —— 守护进程 ACL/限流/审计（Phase 4 归一）
- `crates/amos-ai/src/server.rs` —— SecurityManager 接线处（仅粗粒度）
- `crates/amos-ai/src/lib.rs` —— 模块导出
- `crates/amos-tauri/frontend-ts/src/lib/permissions.ts` —— 前端并行账本
- `crates/amos-tauri/frontend-ts/src/components/{PermissionsApp,CapabilityGate}.tsx` —— System-UI 权限面
- `crates/amos-tauri/frontend-ts/src/lib/bundle.ts`、`components/ExtApp.tsx` —— web-bundle 沙箱宿主
- `crates/amos-appstore/src/{serve,webinstall,sign,model}.rs` —— 安装/服务/签名边界（已加固）
- `docs/appstore.md`、`docs/lmk-proxy.md` —— 沙箱/APK 边界既有说明
- `SECURITY_LAYER_SUMMARY.md` —— 既有安全层与 TODO
