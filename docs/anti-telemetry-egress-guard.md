# 芯片防追踪 · 落地重定标（Anti-telemetry egress guard — honest re-scope）

**日期**: 2026-09-09
**状态**: 设计/对齐文档 —— 仅澄清与拆任务，**不含代码改动**。
**范围**: 把早期那份「芯片防追踪网闸 / 主动抓包审计 / Binder 喂假 / 隐私中心」四层方案，
依据**真实仓库结构与 Android 真实能力**重定标成可执行、不破坏 CI 的任务清单。

> ⚠️ **前提诚实声明**（沿用 `docs/qcom-mtk-bringup.md` §0 的同款纪律）：本仓库能保证的是
> host 可编译、feature 门控、单测绿、Mock seam。凡依赖 root、SELinux 策略、厂商闭源、
> AOSP 平台层的路径，都必须**在装有对应芯片的真机上端到端验收**，绝不把「能编译」当「已接通」，
> 也绝不把「没真机验证的假设」当结论写进代码注释。

---

## 0. 这份文档在干什么

原方案的**目标**（用户可控的隐私；减少可观测的外发遥测；给用户一个可开关的网闸 + 可视化审计）
是合理且有价值的。但原方案的四层**载体**（新增两个 crate、改一个不存在的 `amos-framework-api`、
前端放 `frontend-ts/`、用 `#[cfg(target_os)]`+`Ok(())` 当门控）与真实仓库和 Android 的工作方式
有系统性偏差。本文先把「仓库里到底有什么」和「哪些事技术上做不到」讲清楚，再把四层目标
**落到能做的位置**，给出可执行的 checklist。**所有结论都可回溯到下文命中的具体文件。**

---

## 1. 仓库现状核对（Ground truth）

| 原方案假设 | 仓库实际 |
|---|---|
| 前端在根目录 `frontend-ts/` | 实际在 `crates/amos-tauri/frontend-ts/`，设置页在 `src/svelte/settings/*Page.svelte`（Svelte 5，见 `package.json` `"svelte": "^5.0.0"`）|
| 新 crate `amos-network-guard` | 不存在（需新建，且默认构建应为纯 `std`）|
| 新 crate `amos-telemetry-spy` | 不存在 |
| 扩展 `amos-framework-api` | **不存在**该 crate；最接近的宿主是 `amos-android`/`amos-telephony`/`amos-ai` |
| 门控用 `#[cfg(target_os = "android")]` + 每文件 `Ok(())` | 仓库惯例是 **feature flag**：`#[cfg(feature = "android")]`/`#[cfg(feature = "linux")]` + **domain core + seam + Mock + 诚实 unknown**（`amos-telephony`、`amos-monitor`、`amos-power`、`amos-sensor`、`amos-radio` 一致）。`#[cfg(target_os)]` 仅用于 FFI 缝（如 `amos-audio` 的 AAudio/TinyALSA）|
| 隐私/权限从零建 | **已有**完整链路：`proto/privacy.proto` 定义 `PrivacyService`（Grant/Revoke/**Authorize** 唯一决策口 + `RecentAudit`）→ `amos-tauri/src/privacy_client.rs` 经共享 UDS（`crate::daemon::channel()`）暴露 `#[tauri::command]`；前端已有 `PermissionsApp.svelte`、设置页 `PrivacyPage.svelte` |
| 真机 bring-up 叙事 | 已有 `docs/qcom-mtk-bringup.md`（SoC 画像/加速）、`docs/device-bring-up.md`、`docs/no-ui-android.md` |

**工程含义**：新工作应**并入**既有权限/审计/监控架构（`privacy.proto` + `amos-ai` 审计 +
`amos-monitor` 健康聚合 + Settings 面板），而不是另起一套平行系统；命名要与既有 crate 一致。

---

## 2. 四个必须先承认的硬边界（技术现实）

### 2.1 AP 侧 netfilter 拦不住 modem/baseband
现代高通/联发科 SoC 里 modem/baseband 是**独立处理器/独立可信域**，跑自己的固件。
`rmnet_data0` 只是 **AP⇄modem 的 IP 数据面**。在 `OUTPUT` 链加的规则、以及抓 `rmnet_data0`
的包，**只能看到 AP Linux 栈 / App 流量**。modem 自己发起的信令（IMS/VoLTE、Telephony/SMS）
根本不过 AP netfilter，固件侧的遥测也不会以用户态可见的可路由包出现在 `rmnet`。
⇒ 原话「彻底锁死芯片回传」**不可达**。诚实的可达目标是：**Android 用户态/App 的数据面出口
拦截 + 审计**——这本身真实且有用。

### 2.2 原方案示例规则是坏的
```rust
.args(&["-I", "OUTPUT", "-d", target, "-j", "DROP"])
// target 含 "://qualcomm.com"、"://mediatek.com"
```
- `iptables -d` 只接受 **IP/掩码**，**不做 DNS 解析**；传 `://qualcomm.com` 会被拒。
- 按目标 **IP 一刀切 DROP** 会误伤所有共享该 IP 的进程。
- 域名级策略应落在 **DNS / SNI / uid-aware** 层，而不是 `-d`。

### 2.3 用户态 Rust daemon 拦截不了别人对 system_server 的 Binder
普通进程**无法**截获其他进程⇄`system_server` 的 Binder 事务。给第三方/厂商 APK「喂假的
CellInfo/ScanResults」必须发生在**平台层**（`LocationManagerService` / `TelephonyRegistry` /
`WifiManager`，或带平台签名的特权代理），**不是**一个 Rust gRPC daemon 能做的。
另注：AOSP 默认第三方拿 `CellInfo` 需要 fine-location 权限——该接口的威胁面是**App**，不是基带。

### 2.4 root / rootless 决定一切
- **无 root 的原厂/测试机**（如「12G 二手真机」默认状态）：Tauri App **没有 iptables 权限**。
  唯一免 root 又能做 per-app/per-dest 规则 + 看流量的 API 是 Android **`VpnService`**
  （NetGuard 的做法）。拿到 root 前，`iptables`/pcap 都只会得到 `Permission denied`。
- **root / AmOS 自编译 AOSP**：才能走真 `nftables` + SELinux domain + pcap。
⇒ 分层：**rootless = VpnService**（现在就能在测试机跑通）；**AOSP/rooted = nftables 路径**
（feature 门控，保留给系统组件位）。两端共用同一套「domain core 策略 + seam」。

## 3. 重定标后的四层目标（落到仓库能做的位置）

### 3.1 网络网闸 → 新 crate `amos-network-guard`（domain core + seam，默认纯 std）

**目标**：per-app / per-destination 的数据面出口策略（block/allow），不含任何 native 系统依赖。
**模块**：`domain 策略模型 + NetworkGuard seam + MockNetworkGuard + 门控实现` —— 完全复刻
`amos-monitor`（core/sampler/linux/android + feature 门控）与 `amos-telephony` 的形态。

Checklist（对应 crate 文件）：
- [ ] `crates/amos-network-guard/Cargo.toml` —— 纳入 `Cargo.toml` workspace `members` +
  `[workspace.dependencies]`；`default = []`（纯 `std`）；optional deps 全门控。
- [ ] `src/policy.rs` —— 纯策略类型：`Policy { uid, effect: Block|Allow }`、`Destination
  { Domain | Ip | SnI }`、`BlockList::contains()`（域名/IP/SNI 精确+后缀匹配的**纯函数**，可 host 单测）。
  刻意不写 `://qualcomm.com` 这类坏规则；不把「按目标 IP 一刀切」当默认。
- [ ] `src/lib.rs` —— `NetworkGuard` seam（`apply(policy)` / `flush()`）+ `MockNetworkGuard`
  （记录调用、返回 `Ok`），顶部沿用 P0-1 lint 门：
  `#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]`
- [ ] `src/vpn.rs`（`#[cfg(feature = "vpn")]`）—— rootless 路径：经 `jni`（仿 `amos-telephony`
  `android.rs`）驱动系统 **`VpnService`**，这才是无 root 设备的真实网闸；`cargo check --features vpn`
  保证编译，运行需真机 Context。
- [ ] `src/nftables.rs`（`#[cfg(feature = "nftables")]`）—— AOSP/rooted 路径：**预留**，
  只在系统组件位/有 root 时启用；host 上不拉入任何 native lib。
- [ ] 真机 bring-up 首个探针（见 §5）写进 `examples/probe_permission.rs`。

### 3.2 出口审计 → 并入 `amos-network-guard` 审计流 / `amos-monitor` 消费

**目标**：把「外发在发生什么」如实上报，供 UI 画动态图。信号基于**元数据**而非魔数抓包：
- 可观测面与 §2.1 一致：只能看到 **用户态数据面**。无 root 时通过同一 VpnService 隧道统计
  每 app 的流量与目标；root/AOSP 时才谈 pcap。
- 检测信号 = **DNS 查询 / SNI(ClientHello) / 证书 CN / 已知遥测域名 / per-app 体量**；
  不建议「在 payload 里 grep IMEI/CellID 字符串」当主判据——加密流不暴露明文，且误报高。
  若坚持做明文敏感串审计，只能作**可选、启发式**的低置信标记，绝不当作已证实的外泄证据。

Checklist：
- [ ] `crates/amos-network-guard/src/audit.rs` —— 结构化的 `EgressEvent { ts, uid, app, domain,
  bytes, kind, flags }` + 聚合计数；纯函数可单测。
- [ ] 消费端：送 daemon 经共享 UDS 给 UI（与 `amos-tauri/src/system.rs` 的 `system_health` 桥同构），
  或并入 `amos-monitor` 的健康/事件流形状。
- [ ] 审计记录进既有 `PrivacyService.RecentAudit`/统一审计口径（见 `docs/permissions-sandbox-audit-plan.md`），
  不另造一套日志格式。

### 3.3 「喂假位置」→ 改到 AOSP 平台层（非 Rust daemon 拦截 Binder）

**目标**（保留）：对不需要位置/网络的进程，让系统不再给真 CellInfo/ScanResults。
**修正**：这不是新 Rust crate 的活，而是 **自编译 AOSP** 的活：
- 补丁点：`LocationManagerService` / `TelephonyRegistry` / `WifiManager`（对不必要进程给空/随机
  BSSID 与假信号强度），或带平台签名的特权代理。
- Rust 侧角色降为**策略持有 + 决策**：把「哪些 uid 喂假」经既有 `PrivacyService`（`Authorize`
  口）下发；daemon 不越权去伪造平台响应。
- 与现状对齐：`amos-telephony` 现只做自己 `ROLE_DIALER` 的真实 `TelecomManager#placeCall`
  （见 `crates/amos-telephony/src/android.rs`），**并不过滤别人**——本文保持该诚实边界。

Checklist：
- [ ] 记录平台补丁点与签名要求到 AOSP 侧文档（另立，非本 Rust 仓库内实现）。
- [ ] Rust 侧：确认 `proto/privacy.proto` 的 `resource` 键已含 `location`（现状含），把喂假 uid 策略
  作为该 chokepoint 的一个**审计维度**落到 `amos-ai` 权限管理（只加策略，不加 Binder 拦截）。
- [ ] **不**新建名为 `amos-framework-api` 或伪拦截 Binder 的代码。

### 3.4 前端「芯片防追踪 / 网络防火墙」设置页

**目标**：一个可开关的网闸 + 出口频率可视化。真实落点 = Svelte 5 Settings，**复用已有件**。
- 后端已有：`proto/privacy.proto`、`amos-tauri/src/privacy_client.rs` 的命令桥（UDS）。
- 前端已有：设置页 `src/svelte/settings/*Page.svelte`（`PrivacyPage.svelte`、`CellularPage.svelte`
  等）、`SystemPanel.svelte`、`appRegistry.ts`/`appMeta.ts`、`lib/*.ts` 类型 + `__tests__`。

Checklist：
- [ ] 新 gRPC service/方法（如 `NetworkGuardService`：`Toggle`/`Status`/`RecentEgress`）写进 `proto/`，
  仿 `privacy.proto`；daemon 侧注册（仿 `amos-ai` 内既有的服务注册）。
- [ ] 新 Tauri 命令文件 `amos-tauri/src/netguard.rs`：`#[tauri::command] pub async fn …` +
  `crate::daemon::channel()`，返回 `serde` 镜像（照抄 `privacy_client.rs` 结构），并在
  `amos-tauri/src/lib.rs` 注册。
- [ ] 新设置页 `src/svelte/settings/NetworkFirewallPage.svelte`：一键开关（真网闸）+ 出口频率
  动态图；离线/无数据给「未连接 / —」空态，**绝不伪造**（沿用 `SystemPanel` 的诚实 UI 规则）。
  在 `SettingsApp`/设置导航与 `appRegistry` 里登记，补 en/zh i18n key。
- [ ] 类型层 `lib/netguard.ts` + `__tests__/netguard.test.ts`（仿 `lib/system.ts` +
  `system.test.ts`），跑 `bun run check`。

---

## 4. Cargo / CI 依赖选型（不破坏现有 gate）

原方案的担忧（原生后端 gate 常挂）正确，对策也**不必**是 `#[cfg(target_os)]` 海量 stub；
沿用仓库已有的 **feature-flag + optional dep** 纪律即可：

- `gated-native-backends`（`make gated-check`）跑的是 **linux host**，`android-audio-seams`
  （`make android-audio-check`）才交叉编 android FFI。
- 让 `amos-network-guard` **默认构建 = 纯 `std`**，则上述两个 gate 都**不新增任何 native 系统依赖**
  自然保持绿。
- 候选依赖一律 **optional + feature**，host/CI 默认不含：`jni`（`vpn`，仿 `amos-telephony`，
  `optional=true`）、`pnet`/nftables 绑定（`audit`/`nftables`，仅供 AOSP/rooted 真机路径，
  **不进 `make test`/`make lint` 的默认矩阵**）。
- 交叉编译门禁只用 `cargo check -p amos-network-guard --features vpn` / `--features nftables`
  （仿 `cargo check --features android`），并在其 doc 顶部写清「编译 ≠ 真机已验收」。
- 加入 `Cargo.toml` workspace 时同步 `Cargo.lock`；遵守 `docs/ci-engineering.md` 的 runner 固定
  （`ubuntu-24.04`）与 `make lint`/`make test`/`make cov` 入口。

---

## 5. 真机 bring-up 探针（拿到测试机后的第一步）

先做「权限边界实测」再谈规则注入 —— 照原方案建议、但落成独立可运行 example：

1. `crates/amos-network-guard/examples/probe_permission.rs`：`adb shell iptables -L`（或
   `nft list ruleset`）跑一次，**如实返回**退出码与 stderr，不 panic。
2. 真机先**无 root** 跑：预期拿到 `Operation not permitted` / SELinux denial —— 记录这个异常层级，
   这决定了默认路径必须走 `VpnService`（§3.1 `vpn`）。
3. 再在 **root/自定义 AOSP** 下跑：验证是否可写规则，从而决定 `nftables` 路径是否需要额外
   SELinux domain / init.rc 豁免（`docs/device-bring-up.md` 流程内加该步骤）。

**验收判据（host 即可跑，不碰真机）**：
```bash
cargo test   -p amos-network-guard                # policy 纯函数 + MockGuard + audit 聚合
cargo clippy -p amos-network-guard --all-targets -- -D warnings
cargo fmt    -p amos-network-guard -- --check
cargo check  -p amos-network-guard --features vpn         # rootless 缝编译（不保证真机行为）
cargo check  -p amos-network-guard --features nftables    # AOSP/rooted 缝编译
make gated-check      # 现有原生后端 gate 必须保持绿（默认 std → 零新增 native 依赖）
bun run check         # 前端类型 + svelte 单测绿（改到前端时）
```

---

## 6. 待拍板的开放问题

1. **默认部署形态**：是否作为免 root 的普通 App（→ 只能 `VpnService`，无法真正拦 modem 面），
   还是 AmOS 自编译 AOSP 里的系统组件（→ 才能碰 `nftables`/平台层喂假）？这决定 §3.1/§3.3 优先级。
2. **遥测审计是否纳入明文敏感串扫描**：默认建议只做 DNS/SNI/域名/体量的**元数据**信号，
   明文串扫描作可选低置信标记；需团队确认接受其误报与隐私权衡。
3. **喂假位置是否要真做**：它需要 AOSP 平台改动（超出本 Rust 仓库），是否值得进入排期，
   还是先用 §3.1/§3.4 的「出口拦截 + 可视化」覆盖主要可落地价值。

---

## 7. 相关既有文档/判定

- 权限与审计：`proto/privacy.proto`、`docs/permissions-sandbox-audit-plan.md`、`SECURITY_LAYER_SUMMARY.md`
- 领域 core + seam + Mock 形态范式：`docs/system-monitor.md`、`docs/telephony.md`
- SoC/真机 bring-up 纪律：`docs/qcom-mtk-bringup.md`、`docs/device-bring-up.md`、`docs/no-ui-android.md`
- CI 门禁：`.github/workflows/ci.yml`、`docs/ci-engineering.md`


