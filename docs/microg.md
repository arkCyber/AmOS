# MicroG 在 AmOS 的落地：自建 AOSP guest + signature spoofing 固定预装

> 状态：**已决策、计划中（尚未实现）**。本文先钉死 AmOS 的单一叙事、技术路线、
> 宿主接入 seam、验收与不可变式，避免文档/对外叙事打架（此前 `external-analysis-review.md`
> 明确记着“仓库内无 MicroG 引用，为商业叙事”——本文即把该账改为“已决策/入路线图”）。
>
> 路线归属方：**guest Android 容器（Waydroid/LXC）**。宿主 System UI（Tauri/WebView）
> **不直跑 APK**（见 `crates/amos-android/src/lib.rs`），因此 MicroG 落在 guest 镜像内。
>
> 评审对照（原方案主张 vs 评审结论）：[`docs/microg-implementation-review.md`](./microg-implementation-review.md)。

## 0. 定位与目标

- 目标：让 guest 里**硬依赖 Google Play Services 的第三方 App** 能跑，同时保持 AmOS
  的 de-Google + deny-by-default 隐私纪律，把 MicroG 当成“容器能力”统一供应/授权。
- 选型：**自建 AOSP guest 镜像**，镜像内开启 **signature spoofing**，把 MicroG 组件做成
  **系统分区固定预装层**（system app，用户不可卸载、可整体禁用）——最可控、工程量最大。
- 非目标（不做）：
  - 不重写/不复刻 GMS；不宣称“真 GMS 认证/兼容认证”。
  - 宿主 System UI 不直跑 APK、不把 Web-bundle 商店与 guest APK 混为一谈。
  - **telephony 110 紧急通路不依赖 MicroG/GMS 拨号**（走系统电信栈，仓库既有要求）。

## 1. 单一叙事（对外/对 OEM）

> AmOS System UI 运行于宿主；第三方 Android App 运行于 AmOS 供应的 **de-Googled
> AOSP guest 容器**。该 guest 预装开源 MicroG 作为 GMS API 兼容层 + Aurora/F-Droid 作
> 分发，并按 AmOS 的 per-APK 能力账本受控。guest 内运行的应用经 Wayland/DMA-BUF 合成
> 进 AmOS 窗口；宿主始终是权限/审计权威。

> 上游边界（勿混淆）：**LineageOS for microG 是独立的第三方上游项目**（基于 LineageOS
> 的 de-Googled 发行）。AmOS **不是** LineageOS for microG，**不以它为基座、也不随它分发**；
> 本文（§3）仅把它的 signature-spoofing 宏/受控 allowlist 当作**工程做法参考**，用于指导
> AmOS **自建 AOSP guest** 的实现。

## 2. 组件选型（均为上游、可随镜像分发）

| 组件 | 作用 | 说明/许可 |
|---|---|---|
| `GmsCore` (`com.google.android.gms`) | Play Services 核心 API 实现 | microG 项目；Apache-2.0 系 |
| `GsfProxy` (`com.google.android.gsf`) | GSF 框架代理（GCM 注册/账户） | 供直接依赖 GSF 的旧 App；可后置 |
| `UnifiedNlp` + 离线定位后端 | 去中心化定位提供者 | 默认**纯离线后端**，不联网泄露 |
| 分发客户端 `Aurora Store` / `F-Droid` | App 获取 | **不**随 Google Play Store 分发；许可上需保留上游版权声明 |
| （可选）`Play Store` 客户端 | 装私有/商店已购 | 非 MicroG 核心，视验收需要再评估 |

> 版本/Android 目标：以你选定的 **AOSP 基线（API level）与 Waydroid 兼容性**核实
> （见 §7 核实清单）。GmsCore 也依赖 guest 的 **`ro.*`/硬件能力门控**，需在镜像里给足
> `uses-feature`/`uses-permission` 与网络、定位等系统权限（授予 GmsCore 本体）。

## 3. AOSP 构建：signature spoofing 与改动点

多数依赖 GMS 的 App 校验 Play Services 签名；MicroG 需以 GMS 包身份出现 ⇒ 系统须开
**signature spoofing**。在自建 AOSP 里的标准做法（以所选 Android 版本核实行号/接口）：

- 在 `frameworks/base` 的包管理/签名路径（`PackageManagerService` / 安装校验 / service
  的 `signaturesMatch` 类判定）启用“**FAKE_PACKAGE_SIGNATURE**”或等价的
  `ro.signature.spoofing` 白名单机制：仅允许持有该能力的包（即我们的 GmsCore）以
  `com.google.android.gms` 的身份被签名比对通过。
- 用**白名单而非全开**：只放行 GmsCore/GsfProxy，不放行任意第三方包伪造签名
  （deny-by-default；这是安全不可变式）。
- GmsCore 在 manifest 声明对应 `android.permission.FAKE_PACKAGE_SIGNATURE`（或其私有
  权限），并把目标包 `com.google.android.gms` 写进其 `signature` 域。

> microG 官方对 AOSP 的 signature spoofing 说明与补丁、LineageOS-for-microG 的宏
> （如 `SIGNATURE_SPOOFING` + 受控 allowlist）是权威参考；**务必按你锁定的 AOSP 基线
> 核对接口再写进构建脚本**，不在本文伪造“已可编译”。

构建落地形态（建议）：

- 独立构建产物：`product`/`system` 分区内放 **GmsCore / GsfProxy / UnifiedNlp 为
  system app**（`LOCAL_PRIVILEGED_MODULE` 或预置目录），保证“固定预装层”语义；
- 把签名伪造开关注入构建配置（prop/宏）而非运行时随意开；
- Aurora/F-Droid 放 `data`（用户层），不进预装只读层。

## 4. 宿主接入 seam（Rust / amos-android 侧，先行定义不实现）

沿用仓库“域 seam + 诚实边界”节奏，先钉接口、不假接：

- **`AndroidManager` 能力面新增“guest 服务状态”**：host 能查询 guest 是否已装
  GmsCore/UnifiedNlp、版本、是否可满足某 App 的“依赖 Play Services”标记——供宿主商店
  /`StoreApp` 判定“此 App 需 GMS 兼容层，当前可用/缺失”，不静默装。
- **per-APK 能力账本复用**（`amos-android/src/capability.rs`）：把“面向 GMS 的 App”
  当普通三方处理——location/camera/mic/contacts/storage 一律走既有 deny-by-default
  账本 + host `PrivacyManager` 审计，绝不因“走了 MicroG 定位”而绕过宿主门。
- **位置门控**：UnifiedNlp 离线定位是否提供、给哪些包提供，由 host 的 `cap_location`
  侧决定并下发（guest 只执行），离线后端不联网。
- 明确 seam 缺口（如实记）：**HAL 级拦截**（guest 内 `AudioRecord`/`Camera.open` 真正
  被 per-APK 策略挡住、账本真正接进 guest 策略 / `am force-stop`）仍是设备/生态工作，
  不在本文假装已完成（对齐 `docs/permissions-sandbox-audit-plan.md` Phase 5 未落地部分）。
