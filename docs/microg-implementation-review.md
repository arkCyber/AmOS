# MicroG 落地：原方案主张 vs 评审结论（并排对照，内部对齐用）

> 定位：**评审/对齐稿，非实现稿**。实现路线、Phase 清单见
> [`docs/microg.md`](./microg.md)（状态：已决策、计划中、尚未实现）。
>
> 评审依据：AmOS 当前仓库实际架构与既有域（`amos-android` 容器模型、governor/LMK 的
> per-app freeze、per-APK 能力账本、feature-gated JNI、docs 中明示的“未落地 seam”）。
> 说明：原方案所附外部链接（Gmail 内的“私有 CI 失败日志”）本评审**无法核验**，仅按
> 仓库既有工程模式与可核对的代码给结论，不采信未被证实的私有日志断言。

## 一、总评

原方案**方向一半正确**（AOSP 必须 signature spoofing、priv-app 预装 MicroG 是对的），但把
若干**不可兑现/待定**的事项写成了“必然结果”，并针对 AmOS **已通过架构绕开的伪耦合**
（“Rust 要 JNI MicroG”）给出了多余的中继设计。可落地的核心其实是：**固定预装层（计划稿
已有）+ 复用现有 per-app freeze/LMK + 位置走 deny/allow/mock 策略经窄协议给 host**。

## 二、并排对照

| # | 原方案主张 | 评审结论 | AmOS 现状/应改为 | 判定 |
|---|---|---|---|---|
| 1 | MicroG 必须在 AOSP/LineageOS 编译期侵入（frameworks/base 合 signature spoofing） | 对，前提是自建 AOSP guest | 计划稿 `docs/microg.md` §3；白名单**仅 GmsCore/GsfProxy** | ✅ 方向对 |
| 2 | spoofing 让微信/支付宝“坚信原装 GMS 从而通过系统合法性验证” | **过强**。spoofing 只让 App 能用 Play Services API 面，**不能通过 SafetyNet/Play Integrity 强校验** | 卖点改“能跑依赖 GMS API 的 App”，**不以微信/支付宝为试金石**（其自带 push/定位且硬校验） | ❌ 承诺不可兑现 |
| 3 | MicroG 作 priv-app 预装（GmsCore/FakeStore/GsfProxy + privapp-permissions XML） | 对 | = 固定预装层；Aurora/F-Droid 放 data 层，不分发 Google Play 本体 | ✅ 方向对 |
| 4 | 剥离芯片厂遥测、喂“AI 模糊/虚构位置”给沙箱 | **夸大**。这是**每应用位置策略**，非对芯片的“过滤层” | 在 location 能力上增 outcome（deny/allow/mock），走既有 deny-by-default 能力账本 | ⚠️ 降级表述 |
| 5 | Rust 用 cgroup v2 `cgroup.freeze` “瞬间冷冻”微信/支付宝 | 方向对应，但 AmOS 已有 per-app freeze 域；跨容器“冻结具体某 APK”才是真机 seam | 复用 governor/LMK（`Background↔Cached` freeze/thaw/reclaim，`HostAction`）；仓库**无 cgroup v2 实现** | ⚠️ 改为接既有域 + 真机 seam |
| 6 | “毫秒级解冻”“常驻仅十几兆”等数字 | 不可验证 | 实测后再报数字，不先行承诺 | ❌ 删掉 |
| 7 | Rust 别碰 Java → 写“C++ C-ABI Binder 代理 + bindgen”解耦 | **不成立/不必**：binder 服务非裸 C ABI；bindgen 还需 Android 头，反而引入跨语言对齐麻烦 | AmOS 已解耦：System UI 不直跑 APK，Rust 经容器 CLI + UDS/gRPC 控制 guest；JNI 全 `--features android` 门控、桌面/CI 不编 | ❌ 修正为“窄协议边界” |
| 8 | 让 Rust lint/test CI “丝滑”绕开 Android Java 编译链 | 部分对：确应把 native/android 隔离出 host CI | 仓库做法：`cargo check --features android` 只证“可编”、不真连设备；把中继做成 transport-agnostic 纯 Rust seam（host mock 单测绿），真客侧桥接留 feature 门控/真机 | ✅ 方向对（做法按仓库） |

## 三、落地版一句话

**AOSP guest 预装 MicroG（spoofing 白名单 + priv-app）＋ 复用现有 governor/LMK 做
per-app freeze 的真机 seam ＋ 位置走 deny/allow/mock 策略、经 guest↔host 窄协议交付。**

需删除/降级：对微信/支付宝“通过验证”“剥离芯片遥测”“毫秒级解冻”等不可验证承诺，
以及 C-ABI/bindgen 中继设计。

## 四、与计划稿关系

- 本文件：**评审对照**（对齐用）。
- `docs/microg.md`：**落地计划**（Phase 0–3、组件/构建/signature spoofing/seam、验收与风险、
  诚实边界）。
- 上游/内部对齐通过后，改动应落到 `docs/microg.md` 的 Phase 清单与 `FUNCTIONAL_GAP_ANALYSIS.md`
  账本（把“MicroG 无对应物”改为“已决策/入路线图”），**任何“已实现”断言都须等真有可复现构建**。
