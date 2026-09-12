# Amos — 航空航天软件工程视角审计报告（适航级）

> 状态：审计稿（只读，未改动代码）
> 日期：2026-09
> 范围：`AmOS` 全部 Rust crates（约 15,401 行）与 Tauri 系统 UI（`frontend-ts`，约 7,098 行）
> 依据框架：
> - **DO-178C**（机载系统和设备合格审定中的软件考虑）— 用于过程/目标/追溯/验证框架
> - **NASA/JPL “Power of 10”** 安全关键编码规范（Holzmann, IEEE Computer 2006）
> - **MISRA 风格**静态约束与错误处理约定
> - **ARP4754A / 系统安全评估（FMEA）**思想 — 用于失效与降级路径审查

> ⚠️ 重要声明：本项目为操作系统/桌面壳研究与原型，**并未**作为机载软件提交任何合格审定机构，本报告不构成适航放行。其价值在于：用安全关键软件的工程纪律审查代码，找出"演示环境可容忍、但按适航/安全标准不可容忍"的**确定性、静默失效、可追溯性**缺陷，并给出整改路线。

---

## 1. 基线度量（审计证据）

| 维度 | 数值 | 出处 |
|---|---|---|
| Rust 代码量 | 15,401 行 / 10 crates | `find crates -name '*.rs'` |
| TS/React 系统 UI 代码量 | 7,098 行 | `frontend-ts/src` |
| Rust 内 `unsafe` | **0** | `grep -r unsafe crates --include=*.rs` |
| Rust 生产代码 `unwrap/expect/panic!/unreachable!` | **≈230 处**（`/src/` 内，不含测试） | 各 crate 汇总 |
| Rust 顶层 `loop {}` | 16 | `grep -rE 'loop \{' crates` |
| Rust 内 `#[test]/#[tokio::test]` | 197 | `grep -rE '#\[(tokio::)?test\]' crates` |
| Rust 源码级 `#![deny/#[warn/#[forbid]` 属性 | **0** | `grep -rE '#\[deny|#\[warn|#\[forbid' crates` |
| 编译门禁 | `cargo clippy --workspace --all-targets -- -D warnings` + `rustfmt` | `Makefile:50`, `.github/workflows/ci.yml:35` |
| TS 编译器 | `strict:true` + `noUnusedLocals/Parameters`（**未开** `noUncheckedIndexedAccess`） | `frontend-ts/tsconfig.json` |
| TS 单测 | 143 用例 / 0 失败 / 30 文件 | `bun test` |
| TS 空 `catch{}`（含注释“忽略”） | ≈26 处（源码/组件） | `grep 'catch {' frontend-ts/src` |
| TS `setInterval` / `addEventListener` 清理 | 全部 `return cleanup`，无泄漏 | 见 §4 |
| 代码内 TODO 遗留 | Rust `amos-ai/inference/real.rs:162`（GPU 遥测返回 0）、若干 doc | `grep -rE 'TODO|todo!' crates` |

**总体判读**：工程的"工具纪律"（clippy `-D warnings`、严格 TS、大量单测）在同类项目中属于上游水平，且 Rust 0 `unsafe` 提供了内存安全的强保证。但距"适航级"仍缺四类东西：**(1) 失败可见性/确定性**、(2) 静态约束与不可达 panic、(3) 需求↔代码↔测试的显式可追溯、(4) 关键遥测数据的真实性校验。逐项展开如下。

---

## 2. NASA “Power of 10” 逐条核查

| # | 规则（要旨） | 证据 / 判定 | 违规点与整改 |
|---|---|---|---|
| 1 | 限制控制流：无 goto、无递归 | Rust 无 goto；TS/React 无深度递归。**基本符合**。 | 建议在 CI 增加复杂度/递归静态扫描（lint 兜底）。 |
| 2 | 所有循环静态有界；**不得用循环计数器当数组下标** | TS/React 列表以固定长度渲染；Rust 有 16 处顶层 `loop {}`（多为 supervisor/WM 事件循环）。**部分符合/有风险**。 | (a) 事件循环必须由外部信号显式中止并文档化终止条件；(b) TS 未开 `noUncheckedIndexedAccess`，`arr[i]` 隐含越界风险，见 P1-5。 |
| 3 | 初始化后禁止动态内存分配 | Rust 编译期管理，无手动动态分配。**符合（Rust 语义内）**。 | 监控前端长会话是否累积（AiMsg/音频流无上限），见 P1-4。 |
| 4 | 禁止函数指针 | Rust 用 trait/dyn（受控）；TS 用一等函数（React 模式）。按语言语义**适配性符合**。 | React 回调需保持引用稳定（多用 `useCallback`/ref 模式，已大量采用）。 |
| 5 | 编译期最高告警 + 静态分析，发布前清零 | Rust：clippy `-D warnings` ✅；TS：`strict` ✅。**符合（工具层）**。 | 缺“告警即红线”的覆盖率门禁（无覆盖率阈值、无 mutation）。见 P2-1。 |
| 6 | 声明尽量小作用域、多用 `const` | TS 大量 `const`/纯函数（`lib/*`）；Rust 惯用所有权/借用。**符合**。 | —— |
| 7 | 所有非 void 函数返回值必须被处理，错误不得吞掉 | TS `backend.invoke()` 把一切错误收敛成 `null`（`backend.ts:26-29`）；Rust 生产 `unwrap/expect` ≈230 处。**重大违规风险**。 | 见 P0-1、P0-2：错误必须具名/类型化，panic 收敛到边界。 |
| 8 | 强类型、限制隐式转换/未初始化 | Rust 强类型无未初始化；TS strict。**基本符合**。 | Rust 生产 `unwrap/expect` 即“断言式初始化”，若前提被破坏会直接 panic，等同未定义行为入口。 |
| 9 | 运行时断言用于防缺陷 | Rust 测试断言丰富（197 `#[test]`）；TS 单测 143。**工具验证强**。 | 缺面向“运行时自检/健康上报”层，遥测真实性存疑，见 P0-3。 |
| 10 | 少用预处理器/魔法 | Rust 无宏滥用；TS 少量样板。**符合**。 | —— |

**小结**：规则 5、6、8、10 基本达标；规则 3/4 语言语义内达标；**规则 2 与 7 是主要失分项**（索引越界与错误吞掉/panic 面过大）。

---

## 3. DO-178C 过程对齐（目标 vs 现状）

| DO-178C 关注 | 现状 | 差距 |
|---|---|---|
| 高层需求基线化 | README/docs 有功能清单，无编号需求库 | 无需求标识（无 REQ-xxx），无法做追溯 |
| 需求→设计→代码追溯 | docs 描述架构（`docs/ARCHITECTURE.md`） | 无显式矩阵，改码不能证明覆盖需求 |
| 代码→测试追溯 | 大量单测但按“文件/组件”组织 | 无“每条需求至少一条测试”的映射 |
| 结构性验证 | clippy `-D warnings` ✅ | 无 MC/DC/覆盖率门槛（DO-178C DAL A 要求） |
| 配置管理 | git 已用 | 无基线(受控)与问题追踪状态机 |
| 独立性与工具资格 | —— | 无独立验证人/工具资格说明（对原型可不要求，但应声明） |

**判读**：DO-178C 完整落地对小规模研究项目是过重负担，故建议按“轻量可追溯”落地（见 §6 路线）。

---

## 4. 资源生命周期与并发卫生（正面证据）

逐项核查确认以下均已正确释放，这是同类代码中少见的高水准，予以肯定：

- 时钟/计时器：`apps.tsx:72-74`、`StatusBar.tsx:7-9`、`CommsApps.tsx:174-184`（音乐进度）→ 全部 `clearInterval` 于卸载/暂停。
- 键盘/系统事件：`App.tsx:97-98,157-159`、`lib/useFocusTrap.ts:42-44`、`theme/index.tsx:86-87`（matchMedia）→ 全部 `removeEventListener`。
- 联网监听：`lib/useOnline.ts:17-22`（近期新增）→ 卸载清理。
- 媒体资源：`CameraApp`、`BackendApps.tsx`、`VoiceMicButton` 的 `AudioContext`/`MediaStream`/`ScriptProcessor` 均在停止时 `disconnect/close/stop`（多个 `try/catch{ignore}` 属尽力而为清理，可接受）。
- 后端订阅：`lib/backend.ts` 返回退订闭包并被各 effect 在清理时调用。

**整改（低）**：将“尽力而为清理失败”计入可观测日志，而不是彻底吞掉（见 P1-3），以便在真机上排查音频残留。

---

## 5. 主要发现与证据（分级）

### P0 — 必须整改（安全/正确性）
- **P0-1 Rust panic 面过大**：生产 `src` 中 `unwrap/expect/panic!/unreachable!` ≈230 处（`amos-int:60`, `amos-ai:42`, `amos-tauri:29`, `amos-android:28`, `amos-supervisor:28`…）。任一前提被违反即进程 panic。样例：`amos-tauri/src/wm.rs:489`、`amos-tauri/src/tts.rs:118-124`、`amos-wm/src/lib.rs:252`。**整改**：`Result` 显式传播、把 `unwrap` 收敛到进程边界，在非测试 crate 顶层开 `#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]`（测试模块例外），使 panic 面由 lint 强制可见。
- **P0-2 跨进程/桥接错误被收敛为 `null`**：`frontend-ts/src/lib/backend.ts:26-29` 把所有 IPC 失败降级为 `null`，调用方难以区分“未连接/命令失败/内部错误”。虽有利于降级 UI，但**丢失了根因**。**整改**：返回结构化 `{ok, error}` 或带分类的枚举，UI 只负责展示，分类信息同时进日志。
- **P0-3 遥测真实性（数据完整性）**：`amos-ai/src/inference/real.rs:162` 用 `TODO: Query actual GPU stats` 返回 `gpu_utilization_percent: 0`。若被上游消费，等于**用伪造数据驱动状态**，违反“数据真实、可审计”的安全原则。**整改**：要么实现真实采集，要么把该字段标记为 `Option`/“未提供”，禁止填 0 充当有效值。

### P1 — 强烈建议（稳健/防御）
- **P1-1 静默数据损坏不告警**：`lib/amosStore.ts:31-33` 的 `readJson` 把 JSON 解析失败静默回退默认值，损坏的 `amos.*` 数据会被悄悄覆盖而用户无感知。**整改**：解析失败时 `console.warn` + 保留坏档副本，避免覆盖丢数据。
- **P1-2 TS 空 `catch{}` 清单需分类**：≈26 处。多数为合法清理（`BackendApps.tsx:333-345`、`VoiceMicButton`、`CameraApp:40`），但少数可能掩盖真实问题（如 `calculator.ts:137/143` 用 `catch` 当控制流，虽转为 `ERR` 可接受；`CameraApp:90` 捕获后悄悄生成占位图）。**整改**：给“非清理型” catch 统一加日志与用户可见降级，保留清理型为白名单并加注释。**现状（2026-09-11 自动扫描复核）**：`src` 下共 **146** 个 `catch`，**全部**要么有真实 body/降级路径、要么带**说明为什么可以吞**的注释；唯一"仅注释无代码"的是 `PlayerApp.svelte:138`，其注释已写明（headless DOM 会同步抛 `play()`，真实失败经 `onerror` 上报）——即**不存在静默吞错残留**。**补充（2026-09-11）"统一日志出口"已落地**：`lib/debugLog.ts` 成为有界诊断账本（级别 + 环形上限 + 诚实丢弃计数 + 永不抛错），`backend`/`store`/`messages`/`blocklist`/`camera` 等 8 处失败路径已改走它，并在 Settings→AI 可见（见下表 REQ-A88）。
- **P1-3 无统一可观测层**：TS 端错误只有 `console.warn`（`backend.ts:28`）；Rust 端无统一结构化日志/健康上报出口。**整改**：建立最小日志等级 + 关键路径采样，便于真机冒烟定位。**进展（2026-09-11）**：Rust 侧已有**有界自轮转的持久化日志出口**（`crates/amos-ai/src/logfile.rs`，`AMOS_LOG_DIR`/`AMOS_LOG_MAX_BYTES`/`AMOS_LOG_KEEP`，IO 失败只降级为仅 stdout），失败可见性缺陷也已修一处（存活探针不再被生成流量饿死，见下表 REQ-A82）；运行期 sink 失败**不再静默**（计次 + 首次 stderr 告警，刻意不经 tracing 以免重入）；**且该健康状态已上 wire**（`get_status.log_sink`：enabled/path/已落盘字节/丢失字节/失败次数/轮转次数，见下表 REQ-A87），System UI 会显示"已落盘 N 字节"并在丢失时**显式告警**；**仍未完成**：日志**聚合/远端收集**、TS 端统一日志出口、关键路径采样。
- **P1-7 发布身份一致性（本轮新增，已修）**：发布管道此前**不校验 git 标签与 `Cargo.toml` 版本是否一致**，也不校验版本**解析来源**——`vX.Y.Z` 标签可以发布内含另一版本的包，而 `VERSION` 文件与每个二进制的 `--version` 会与 Release 标题互相矛盾（"用一件事的名字，装另一件事"）。另：版本解析原先按行取**首个** `^version = "…"`，一旦某依赖以 `[workspace.dependencies.x]` + 独立 `version =` 行排在前面，发布会被**静默按依赖版本命名**。**整改**：①解析改为**只读 `[workspace.package]` 段**并校验 semver 形态；②支持 `AMOS_RELEASE_TAG`，标签与打包版本不符即**拒绝打包**（workflow 在 tag 构建时传入，`workflow_dispatch`/分支构建不传）。见下表 REQ-A86。
- **P1-4 长会话无界累积**：`AiApp` 的 `msgs`、同传 `segs` 只增不设上限；长会话内存/渲染持续增长。**整改**：上限（如截断或分页）+ 会话结束清理。**已完成（复核确认）**：`AiApp` 全部三处 `msgs` 写入都经 `capTail(..., CHAT_MSG_CAP=200)`，`InterpApp` 的 `segs` 经 `capTail(..., SEG_CAP=200)`（及 `lib/bounded.ts` 的 `capTail` 自身单测，含 NaN/负数/空数组边界）。
- **P1-5 前端索引无 `noUncheckedIndexedAccess`**：`tsconfig.json` 未开该项，`arr[i]` 类型为 `T` 而非 `T|undefined`，编译期无法发现越界读。**整改**：开启该选项并修复暴露出的空值路径（能显著缩小“循环下标当索引”面，对应 NASA 规则 2）。**已完成（复核确认）**：`frontend-ts/tsconfig.json` 已含 `"noUncheckedIndexedAccess": true`，`tsc --noEmit`（含全仓 `bun run check` 的 typecheck）**0 错**。
- **P1-6 `loop {}` 16 处终止性**：需逐一确认由外部信号中止且非空转（防 CPU 占满/看门狗失效）。**整改**：为每个长循环加明确退出条件与注释；事件型改由 channel/select 驱动。**现状（2026-09-11 自动扫描复核）**：生产 `src` 中实为 **64** 处 `loop{`（`16` 为旧口径）。按"体内是否有等待/阻塞（`.await`/`recv`/`select!`/`sleep`/`park`/`accept`/锁等待…）"与"是否有 `break`/`return`"分类扫描：**40 处可等待/阻塞**、**7 处有出口但无等待**（有界忙碌循环）、**0 处"既无等待又无出口"**。**已完成（2026-09-11，同一轮加守门）**：**11 处**"等待且无出口"的长循环**逐处补齐终止条件注释**（`amos-ai` 的 energy / life_guard / monitoring / profiler 心跳、security / session 清理任务、`server::serve` 的两个周期采样任务；`amos-tauri` 的 lmk / telemetry-spy / telephony 三条 watch 重连循环——每条都写明"运行到进程/应用停止（任务随运行时被 abort）"以及哪个调用是等待），并把该性质变成**生产门**：新增零依赖扫描器 `scripts/hot-loop-scan.mjs`——①**硬失败**于"既无等待又无出口"的空转循环（无基线豁免；刻意的 spin 必须以带 `reason` 的基线条目显式豁免）；②**棘轮**式要求长循环必须写明终止条件（当前基线**为空**——11 处全部真注释，无祖父化）；③内建 `--selftest`（7 个分类用例，其中 3 个必须被判失败）以防"永远返回 OK 的假门"——该 selftest 上线即抓到分类器自身的**漏报**（`try_recv` 被 `recv` 子串误判为"等待"，会让忙轮询冒充健康长循环），已用词边界 + 排除非阻塞变体修正。已接入 `make lint`（CI 的 `lint-and-test` job 会执行）与独立目标 `make hot-loop`。当前 304 个生产 `.rs`：**0 空转、0 未注明终止**（反证：临时塞入一个空转文件，门立刻 `exit=1` 并指出 `file:line`，删除后恢复 OK）。

### P2 — 建议（工程化/文档）
- **P2-1 覆盖率门禁**：在 CI 增加 `cargo llvm-cov` / `bun --coverage` 阈值（如核心 `lib/*` 达 90%），并把 `amos-*` 纯逻辑模块纳入。
- **P2-2 可追溯矩阵**：给 README/docs 功能条目分配 `REQ-xxx`，建立“需求→代码路径→测试”表格（本审计可作为起始草稿）。
- **P2-3 移除/收敛代码内 TODO 遗留**（除 `real.rs:162` 外，文档层若干），确保无“假装完成”的实现。
- **P2-4 适航性免责声明**：仓库顶部/发布说明明确“非审定软件”，防止被误用于真实飞行/医疗等 DAL A 场景。

---

## 6. 整改路线图（建议顺序，本轮未改代码）

| 阶段 | 内容 | 对应发现 |
|---|---|---|
| **阶段 1（近期）** | Rust：非测试 crate 开启 `deny(unwrap/expect/panic)` 并逐处改 `Result`；`real.rs` GPU 遥测改为 `Option`/真实采集 | P0-1, P0-3 |
| 阶段 1 | TS：`invoke` 改结构化错误；`readJson` 失败告警并保留坏档 | P0-2, P1-1 |
| **阶段 2** | TS 开 `noUncheckedIndexedAccess` 并修复空值路径；`AiApp/同传` 加会话上限；`loop{}` 终止性审查 | P1-5, P1-4, P1-6 |
| 阶段 2 | 统一错误/日志出口，catch 分类白名单化 | P1-2, P1-3 |
| **阶段 3** | 覆盖率门禁 + 需求编号与“需求→代码→测试”矩阵文档 + 免责声明 | P2-1~P2-4 |
| 持续 | 每次改动：新增/更新单测，保证 `typecheck` + clippy `-D warnings` + 全量测试绿 | §1 门禁 |

---

## 7. 结论（verdict）

**作为研究型 OS/桌面壳，代码工程纪律良好**：0 `unsafe`、clippy `-D warnings`、strict TS、资源清理齐全、测试覆盖面（Rust 197 `#[test]` + TS 143 用例）在本量级项目中属上游。

**尚不满足“适航/安全关键”级的三条硬约束**：
1. **失败可见性**：跨进程错误被收敛为 `null`、Rust 生产代码有 ≈230 个 panic 入口、个别遥测为占位数据（P0）。
2. **确定性边界**：TS 未开索引越界检查、长会话无界累积、`loop{}` 终止性未逐一定稿（P1）。
3. **可追溯性**：缺“需求↔代码↔测试”显式矩阵与覆盖率门禁（P2）。

按 **“Power of 10”** 计：规则 5/6/8/10 达标、3/4 语义内达标、**规则 2、7 为主要整改区**。按整改路线图推进后，可在“原型之上、审定之下”达到较高的安全关键工程水准。

---

## 8. 整改跟踪（变更记录）

> 审计后按路线图执行的代码改动在此登记，便于追溯"发现 → 处置 → 验证"。

| 日期 | 处置项 | 变更 | 验证 |
|---|---|---|---|
| 2026-09-11 | **P1-3 的 TS 半边：把"统一日志出口"从名义变成真实（REQ-A88）** | 审计原文点名"TS 端错误只有 `console.warn`（`backend.ts:28`）"。复审发现更准确的问题：**`lib/debugLog.ts` 已经存在**（2 处使用，只写 console），而 `src/lib`+`src/svelte` 里 **12 处失败路径各自直接 `console.warn`** —— 出口存在但**名存实亡**，且 console 输出**用户看不见、刷新即失**，事后无法取证。处置：①把 `debugLog.ts` 扩成**单一有界诊断账本**（保持 `amosLog`/`amosWarn` 既有签名与前缀 `[amos][area]` 不变，故既有调用方与测试不受影响）：级别 `debug / info / warn / error`、**有界环** `RING_CAP=200`（避免 P1-4 式无界增长）、**诚实丢弃计数**（`evicted` 环满淘汰、`suppressed` 低于阈值未记录——短列表绝不能被误读为"没有别的事发生"）、`subscribeDiag`/`recentDiag`/`diagStats`/`clearDiag`（清列表**不清**计数）；**永不抛错**：circular/BigInt/抛异常的 getter 一律安全降级并截断（含订阅者抛错的隔离）；`amos.debug.log="0"` 的旧开关同时**静默 console 并把阈值抬到 warn**（"关"不能让 info 噪音继续塞满账本）。②**真接线**（不是加白名单）把 8 处关键失败路径改走账本：`backend` IPC 命令失败、`store` 损坏隔离（因是**数据丢失**，级别提升为 **error**）、`messages`×2 / `blocklist`×5 的规则与短信操作失败、`camera` 采集失败（用户已见提示，账本补齐**原因名**）。③**上界面**：Settings→AI 的"健康读数"区新增「客户端诊断」块——最近 5 条 + `保留 n/200 · 丢弃 e · 级别过滤 s` + **级别选择器**（debug/info/warn/error，`setDiagMinLevel` 落 localStorage）+ 清空按钮，故级别旋钮是**真控件**而非代码常量。 | `frontend-ts/src/lib/debugLog.ts`、`src/lib/{backend,amosStore}.ts`、`src/svelte/{CameraApp,MessagesApp,PhoneApp}.svelte`、`src/svelte/settings/AiPage.svelte`、`src/i18n/locales/{en,zh}.ts`、`src/__tests__/{debugLog,amosStore}.test.ts`、`svelte-tests/settings-pages.svelte.test.ts` | 测试 **+10**：`debugLog` 7（新→旧顺序与字段；**环上界 + evicted 计数**（写 207 条 ⇒ 200/7、最旧消失）；阈值过滤 + **suppressed** 计数与降阈后放行；**清列表保留计数**；**恶意 detail 不抛错且截断**（circular/BigInt/抛异常 getter/5000 字符）；订阅/退订；**抛错的订阅者不会破坏日志**）；设置页 DOM 3（最近失败 + 丢弃计数**逐项** 与 `diagStats()` 一致；清空后列表空但计数仍在；**级别选择器真换策略并持久化**）；`amosStore` 用例改为同时监视 warn+error（数据损坏现按 error 上报）。门：`bun run check` **EXIT=0**（`tsc`/`svelte-check` **0 错 0 警**、`test:svelte` **557**、`bun` **1042**、unwired 基线仍 **42**）；`coverage:gate` **92.02% ≥ 90%**。**过程证据**：unwired 门在实现中途**抓到本轮新增的 3 个"无生产调用点"导出**（`amosDebug`/`amosError`/`setDiagMinLevel`）——按门的规矩**接线或删除、不加基线**：删掉与 `diag("debug",…)` 重复的 `amosDebug`、把 `amosError` 接到真实数据损坏路径、把 `setDiagMinLevel` 接成 UI 控件，基线**保持 42 不变**。 |
| 2026-09-11 | **P1-3 续：守护进程把"日志落盘是否完好"上 wire（REQ-A87），失败不再只留在 stderr** | 上一轮补了运行期 sink 失败告警（stderr 一行 + 内部计次），但**运营面看不到**：`eprintln!` 只存在于守护进程的终端，System UI 里没有任何"落盘是否还在工作"的信号，而 `AMOS_LOG_DIR` 是**默认开启**的（无头设备上这是唯一的事后取证）。本轮把它做成 additive 可观测链（同 REQ-A43/A44 的范式，**不改动既有字段语义**）：`logfile.rs` 新增可克隆 `LogSinkHandle` + `LogSinkReport{enabled,path,bytes_written,lost_bytes,write_failures,rotations,active_bytes}`（`bytes_written` 计成功落盘、`lost_bytes` 计写失败未落盘——两者一起才说得清"轨迹有多少、缺了多少"；`rotations` 由 `RotatingFile` 计）；proto `StatusReply` 新增字段 **19 `LogSinkMetrics`**；`AiAgentService` 持有 `Option<LogSinkHandle>`（`with_log_sink`）+ `log_sink_metrics()`（未接线时返回 `LogSinkReport::disabled()` 的**诚实零**，绝不伪造）；`serve_with_log_sink(path, Option<handle>)` 由二进制把 tracing 写入器交进服务（`serve` 仍委托 `None`，测试/嵌入方行为不变）；Tauri `DaemonStatus.log_sink` 与前端 `EngineView.logSink` 逐字段镜像（缺块 ⇒ `null`=unknown，**绝不回退伪造零值**），AiPage 渲染"已落盘 N 字节"，并在 `lost_bytes/write_failures > 0` 时**显式告警"丢失 N 字节、写入失败 M 次"**。 | `crates/amos-ai/src/logfile.rs`、`src/{server,main}.rs`、`tests/rpc_test.rs`、`Cargo.toml`（dev-dep `tracing-subscriber`）、`proto/ai_agent.proto`、`crates/amos-tauri/src/ai_bridge.rs`、`frontend-ts/src/lib/{aiEngine,backend}.ts`、`src/svelte/settings/AiPage.svelte`、`src/i18n/locales/{en,zh}.ts`、`src/__tests__/ai-engine.test.ts`、`svelte-tests/settings-pages.svelte.test.ts` | 单测/集成 **+7**：`logfile` 2（"无 sink ⇒ 诚实零、path 不伪造"；"成功落盘/轮转/失败丢失各自的计数"，含用"`.1` 为非空目录"制造**真实**写失败）；`server` 1（无 sink ⇒ enabled=false 全零；接线后 ⇒ enabled/path/`bytes_written==10`/`active_bytes==10`）；**真 UDS 集成 1**（`serve_with_log_sink` + 真实 `MakeWriter` 写入 ⇒ 线上 `log_sink.enabled/path/bytes_written` 与磁盘一致，`lost/failures==0`）；前端 **+3**（`ai-engine` 2：落盘块解析含**诚实 stdout-only 零态**与丢失计数、缺块 ⇒ `null`；设置页 DOM 1：同时断言"2048 字节"与"丢失 64 / 失败 2"，且 stdout-only 时显示"仅标准输出"**不显示**丢失行）。`cargo test -p amos-ai --lib` **263 passed**、`cargo test -p amos-ai` 全部集成套件绿、`-p amos-tauri --lib` **237**；`cargo clippy -p amos-ai -p amos-tauri --all-targets -- -D warnings`、`cargo fmt --all --check` 干净；`bun run check` **EXIT=0**（`svelte-check` 0 错 0 警、`test:svelte` **554**、unwired 基线 **42** 不变）。 |
| 2026-09-11 | **发布身份一致性 + 运行期失败可见性：审计上一轮新增的发布管道与日志 sink** | 对上一轮自己新增的代码做对抗式审计（P0-3「不得用一件东西的身份冒充另一件」+ P1-3「失败必须可见」），查出 **3 处真实缺陷**：(a) **标签/版本不校验**——`vX.Y.Z` 标签可发布内含另一版本的包，Release 标题与包内 `VERSION`、各二进制 `--version` 互相矛盾；(b) **版本解析脆弱**——`VERSION="$(sed … | head -n1)"` 取全文件**首个** `^version = "…"`，若某依赖以 `[workspace.dependencies.x]` + 独立 `version =` 行出现且在前，发布会被**静默按依赖版本命名**（实测 fixture：旧解析得 `9.9.9`，新解析得 `0.1.0`）；(c) **日志 sink 运行期失败静默**——`let _ = f.append(buf)` 丢弃写/轮转错误，daemon 启动时已宣告 "file log sink active"，之后磁盘满/轮转失败则只剩 stdout，**审计轨迹静默丢失**。**处置**：(a) 脚本支持 `AMOS_RELEASE_TAG`，不符即拒绝打包（workflow 仅在 `refs/tags/v*` 时传入）+ (b) 解析改为**只读 `[workspace.package]` 段**并校验 semver 形态 + (c) `SinkHealth` 计次并在**首次**失败时向 stderr 打一行告警（`TeeWriter::write_failures()` 可查），刻意**不经 tracing** 以免重入本 writer 递归。 | 守卫实证：`AMOS_RELEASE_TAG=v0.2.0` → `tag/version mismatch …`、**exit=1**；`v0.1.0` → 通过并打印 `tag … matches the packaged version`；无 tag（dispatch/分支）→ 正常。解析实证：合成 `Cargo.toml`（依赖版本在前）旧法得 `9.9.9`、新法得 `0.1.0`。日志实证：`--nocapture` 可见 `amos-ai: file log sink write failed (Is a directory (os error 21)); continuing on stdout only (on-disk trail may be incomplete)`；新增单测 **2**（`SinkHealth` 只报首次 + 计次；轮转不可完成时 `append` **返回 Err** 且 writer **计次**、clone 共享计数）。门：`make lint` 全绿、`cargo test -p amos-ai --lib` **260 passed**、`bash -n`、workflow YAML 解析通过。 |
| 2026-09-11 | **P1-6 闭环：长循环终止性注释 + 把"无空转/有终止说明"变成生产门（含防"假门"的 selftest）** | 上一轮只做了**一次性取证**（0 空转），"逐处注释"与"自动化守门"都还欠着。本轮两者一起补：新增零依赖扫描器 `scripts/hot-loop-scan.mjs`（字符串/字符/嵌套注释感知的花括号匹配，`#[cfg(test)]` 与 `tests/` 一律排除），①**硬失败**于"体内既无等待也无可退出（`break`/`return`）"的 `loop`；②**棘轮**式要求"等待且无出口"的长循环必须在其上方写明终止条件；③`--selftest` 用 7 个内嵌用例证明分类器**会**失败。接入 `make lint`（CI 已跑）与 `make hot-loop`。用该门发现并**逐处补齐 11 处长循环的终止性注释**（amos-ai：energy/life_guard/monitoring/profiler 心跳、security/session 清理、serve 内两个采样任务；amos-tauri：lmk/telemetry-spy/telephony watch 重连），基线因此保持**空**（无祖父化）。 | 门在真实回归上验证：临时插入一个空转文件 → `[FAIL] hot-spin …: crates/amos-ai/src/__hotspin_probe.rs:2`、`exit=1`，删除后恢复 OK。`node scripts/hot-loop-… --selftest` **7/7**（含 3 例必须失败；上线即抓出分类器把非阻塞 `try_recv` 误判为"等待"的漏报，已修）。`cargo fmt --all --check`、`cargo clippy --workspace --all-targets -- -D warnings` 干净；`cargo test -p amos-ai --lib` **258**、`-p amos-tauri --lib` **237** 全绿。 |
| 2026-09-11 | **审计条目复核（P1-2/P1-4/P1-5/P1-6）：用扫描与编译取证，纠正过时结论** | 复核发现四条 P1 的状态与本报告原文不符——它们描述的是**旧代码**。取证：(a) **P1-2**：脚本扫描 `src` 下 **146** 个 `catch`，**无一处**静默吞错（仅 `PlayerApp.svelte:138` 为"仅注释"，且注释已写明 headless DOM 同步抛 `play()`、真实失败走 `onerror`）；(b) **P1-4**：`AiApp` 三处 `msgs` 写入全部经 `capTail(..., 200)`、`InterpApp.segs` 经 `capTail(..., 200)`；(c) **P1-5**：`tsconfig.json` **已含** `noUncheckedIndexedAccess: true` 且 `tsc` **0 错**；(d) **P1-6**：生产 `src` 实为 **64** 处 `loop{`（原文 16 为旧口径），按"有等待/阻塞"与"有出口"分类扫描得 **40 处可等待、7 处有界忙碌、0 处既无等待又无出口** ⇒ 审计担心的**空转烧 CPU 风险不存在**。 | 三条一次性扫描脚本 + `tsc --noEmit`（0 错）。**仍未完成并如实保留**：P1-6 的逐处终止性**注释**与"无空转"的**自动化守门**（当前仅一次性取证）。 |
| 2026-09-11 | **失败可见性缺陷（P1-3 类，由新负载测试当场抓到）：存活探针与生成请求共用限流桶 → 忙时"守护进程看起来像死了"** | 新增 `crates/amos-ai/tests/load_test.rs`（gap #36 有界负载测试）首跑即失败：16 并发 `StreamChat` 期间 `GetStatus` 返回 `ResourceExhausted: request rejected by security layer: rate limit exceeded: requests per second`。根因：`security.rs` 的**每客户端 10 req/s 单桶**同时承载**生成请求**与**存活探针**，于是一串生成就把守护进程**自己的健康通道**打成"拒绝"——**恰在系统最忙、最需要看清它是否健康的时候，看得见的能力被安全层自己掐掉**（正是本报告 P1-3「失败可见性/无统一可观测出口」的实例）。**处置**：探针改走**独立且仍然有界**的道——`RateLimitConfig.probe_requests_per_second`（默认 50）、`ClientBuckets.probe`、`RateLimiter::check_probe`、`SecurityManager::validate_probe`（**仍然**权限校验 + 审计，动作 `probe`，**成功/拒绝均留痕**），`get_status` 改用它；**不是**豁免安全层，探针超限照样 `ResourceExhausted` 并写入审计。 | 新集成测试 **1**（**连跑 3 次稳定**，且断言"负载中探针必须成功"作为回归守卫）；`security::` 单测 **+2**、`server::` 单测 **+1**；`cargo test -p amos-ai --lib` **258 passed**、全部集成套件绿；`clippy --all-targets -- -D warnings`、`fmt --all --check` 干净。 |
| 2026-09-11 | **P1-3 可观测性（Rust 侧）：守护进程日志持久化 + 有界自轮转** | 对照本报告 P1-3「无统一可观测层 / 无结构化日志出口」：`amos-ai` 是**无头**守护进程，此前 tracing **只写 stdout**，被 init.rc/systemd 丢弃时**设备上事后无从追查**。新增 `crates/amos-ai/src/logfile.rs`（纯 `std`、零新依赖）：`LogFileConfig`（`AMOS_LOG_DIR` 未设 ⇒ `$HOME/.amos/logs`、`off/none/0/空` ⇒ 仅 stdout、`AMOS_LOG_MAX_BYTES` 默认 5 MiB、`AMOS_LOG_KEEP` 默认 3 硬上限 64）、`RotatingFile`（**行边界**才轮转、`log→.1→.2…`、删最旧、keep 封顶）、`TeeWriter`（`MakeWriter`：stdout **与**文件同写）；**IO 失败只降级为仅 stdout**（stderr 告警一次）绝不崩守护进程；`main.rs` 启动时如实打印 sink 状态。 | 新模块单测 **6**（env 策略/解析与上限/轮转上界/**无换行大写入不中途轮转**/降级不 panic）；`cargo test -p amos-ai --lib` **255 passed**、`cargo test -p amos-ai` 全绿、`clippy -D warnings`、`fmt --check` 干净；**真跑** `AMOS_LOG_DIR=<tmp> target/debug/amos-ai` 落盘 8 行且 stdout 不变、`AMOS_LOG_DIR=off` 不建文件。**边界**：本地文件 sink ≠ 聚合/远端采集栈（后者仍未做）。 |
| 2026-09-11 | **航空航天级审计：守护进程资源门补全（`AMOS_MAX_SESSIONS` 已写未接线 + `cache.rs`/`pool.rs` 两文档点名缺失）** | 复审 amos-ai 确认两处真实缺口并补全（Power of 10 #2「资源静态有界」）：(a) **`config.rs` 声明并校验 `max_concurrent_sessions`（默认 16）但 `server.rs` 从未读取**——并发生成无上限，`RateLimiter` 只限每客户端速率/小时配额、不限同时执行的生成数。新建 `pool.rs` `GenerationPool`：容量 `NonZeroUsize` 类型编码（零槽位不可表示）、fail-fast 默认（`Saturated` 确定性拒绝；可选 `AMOS_GEN_POOL_WAIT_MS` 有界等待 → `WaitTimeout`，两拒绝可区分且单调计数）、RAII `PoolPermit`（tokio `OwnedSemaphorePermit` 'static，任何退出路径恰好归还一次）；接线 `stream_chat`（安全门后、会话/簿记前，被拒不分配资源）与 bidi `chat`（每 Prompt 生成前，饱和回错误 chunk 保持连接），拒绝审计 `Rejected` + gRPC `ResourceExhausted`。(b) 新建 `cache.rs`：`ResponseCache` 有界 LRU+TTL（32 条/300 s/单条 256 KiB、注入时钟、超限拒绝而非截断、`hits+misses==lookups` 不变量）、键=后端可见全部输入（会话谱系键参与，绝不在可能分叉的会话间错误共享）、`CachingBackend` 装饰器命中按原 token 序列重放、**上游错误绝不缓存**、名诚实加 `+cache`、`BackendStats` 纯透传；**默认关**（`AMOS_RESPONSE_CACHE=1` 显式开）。登记 `docs/TRACEABILITY_MATRIX.md` REQ-A43/A44、`docs/daemon-resource-gate.md`。 | `cargo test -p amos-ai` **245** lib（pool 8 + cache 17 + server 集成 2 新增）+ 全部集成测试；`cargo test --workspace` **134 个测试二进制全绿 EXIT=0**；`cargo clippy -p amos-ai --all-targets -- -D warnings` 干净；`cargo fmt --check` 0 diff；**诚实边界**：进程内缓存重启即空；池/缓存计数进 wire proto 属后续增量（本轮不动 proto） |
| 2026-09-11 | **守护进程资源门可观测：准入池/响应缓存计数上 wire（REQ-A43/A44 增量）** | 上一轮刻意未动 proto，运营者能看到缓存存在（backend 名 `+cache`）却看不到池是否饱和、缓存命中多少。本轮补上 additive 可观测链（P0-3：宁可报 `null`/`enabled=false` 也不伪造读数）：proto `StatusReply` 新增字段 17/18 —— `GenerationPoolMetrics`（capacity/in_flight/available/acquired_total/rejected_saturated/rejected_timeout/wait_ms，`available+in_flight==capacity` 由池结构保证）与 `ResponseCacheMetrics`（enabled/capacity/ttl_seconds/entries/hits/misses/stores/evicted/expired/oversized）；`server.rs` 保存 `Option<Arc<ResponseCache>>` 句柄（仅 `AMOS_RESPONSE_CACHE=1` 非空）+ `generation_pool_metrics()`/`response_cache_metrics()`（关闭时 `enabled=false` 且全零）+ `with_response_cache`；`ResponseCache::ttl()` 访问器；Tauri `DaemonStatus.generation_pool/response_cache` 与前端 `EngineView.pool/cache` 逐字段镜像（缺块 ⇒ `null`=unknown，绝不回退伪造零值），AiPage 渲染槽位占用/拒绝计数/缓存命中。 | server 单元 **+2**（`get_status_reports_honest_generation_pool_metrics`、`get_status_reports_response_cache_counters_when_enabled`）；`pool::tests` **+2**（`snapshot()` 拆分恒等式、8 任务并发下 5000 次采样 `in_flight+available==capacity` 恒成立）；`rpc_test::get_status_exposes_live_monitoring_metrics` 断言两块随 `StatusReply` 过真 UDS；`cargo test -p amos-ai` **249** lib + 全部集成；`cargo test --workspace` **135 个测试二进制全绿 EXIT=0**；`cargo clippy --workspace --all-targets -- -D warnings`、`cargo fmt --all --check` 干净；前端 `ai-engine.test.ts` **13**、i18n 键中英对齐、`tsc`/`svelte-check` 0 错 0 警、vitest **471** 全绿 |
| 2026-09-11 | **确定性缺陷（两处）：并发单测把调度/墙钟当断言 + 并行用例共享临时安装目录** | 全量 `cargo test --workspace` 与 Gradle 构建**并发**时先后暴露两个**偶发**失败，根因都在**测试自身依赖时序/共享状态**（不可复现的失败等于没有证据）。(a) `amos-audio::ring::tests::concurrent_producer_consumer_loses_nothing`（`producer never EOFs mid-stream`）：`read()` 按文档只在「整个读预算（默认 1 s）内无样本」时返回 `0`，被负载饿死的生产者足以触发；且生产者以固定 1 ms sleep 推进、`dropped() == 0` 又要求消费者在 512 样本（≈8 ms）内被调度。现改为**自我节流**：生产者等**剩余容量**（`pending() + chunk <= capacity()`）再 push（`dropped == 0` 由构造保证），消费者把 `0` 读按文档语义当作**饥饿**继续排空并给 60 s 上限。ring 的生产契约未改。(b) `amos-appstore::serve::tests::resolves_index_asset_and_content_type`（`serve.rs:183` 的 `resolve_request(...).unwrap()`）：`installed_dir()` 的临时根只按**进程 id** 命名，于是同一测试二进制内的**并行**用例共用并互相重装/擦除同一目录，A 解析路径时 B 刚把它清掉。现按仓内既有的「进程 id + 原子序号」夹具惯例给每次调用独立根目录（`hostfs`/`host_battery` 同样做法）。 | 修复前：`cargo test --workspace` **EXIT=101**（先 `-p amos-audio --lib` 1 failed，后 `-p amos-appstore --lib` 1 failed）。修复后：ring 用例单跑 **12/12**、在 **6 个 CPU 打满进程**下 **20/20**；appstore `--lib` **55 passed** 且重复跑 **10/10**；`cargo clippy -p amos-audio/-p amos-appstore --all-targets -- -D warnings` 干净（顺带修掉 `let mut flush` 的 `unused_mut`）；`cargo fmt --check` 0 diff。登记 `docs/TRACEABILITY_MATRIX.md` **REQ-B10** |
| 2026-09-11 | **航空航天级审计：手机管家电量链路的量测真实性（P0-3 类）+ 部分体检可见性** | 对新增的电量读数做三轮对抗式审计，逐条对照本报告 P0-3（"禁止用 `0` 等占位值冒充有效量测"）与 NASA Power of 10 规则 7/9：(a) **glue 伪造 `charging`**——`getIntExtra("status", 0)` 在字段缺失时返回 `0`（非任何合法 `BATTERY_STATUS_*`），"没读到充电状态"被写成 `"charging": false`，Rust 侧当成已知事实后在低电量时生成 `care.battery.critical` 告警；改为 `chargingFrom()`（仅 `CHARGING`/`FULL` ⇒ true、`DISCHARGING`/`NOT_CHARGING` ⇒ false，`UNKNOWN`/缺失 ⇒ **省略** ⇒ 电池区不评估）。(b) **越界档位被夹成具体主张**：`level.clamp(0,100) as u8` 把负数夹成 `0`（⇒ 凭空"电量极低"）又用截断把 `20.6 ⇒ 20`（跨过低电量阈值）；改为"越界不是读数"（`<0`/`>100`/非有限 ⇒ `None`）+ `round()`。(c) **宿主回退沿用旧默认值**：宿主分支内联 `charging.unwrap_or(false)`（P0-3 同款）→ 抽纯函数 `reading_from_host()` 与设备走同一 `care()`；(d) **sysfs 观测被丢弃**（注释承诺 `Not charging` ⇒ 插电、代码只映射 `Full`）+ **一个读不懂的条目终止整盘遍历**（`?` 提前返回 `None`）→ 补映射、改 `continue`，并把该 Linux 分支门控为 `cfg(any(linux, test))` 使修复**在非 Linux 主机上也能编译/跑测**（原为 Linux-CI-only 死角）。(e) **`parse_item` 给缺失尺寸填 `0`**（`unwrap_or(0)`）+ glue 对 `null` SIZE 填 `0L` → 违反 P0-3 且低估 `reclaimable_bytes`：改为**跳过该行**并计入**部分扫描**（`unreadable_dirs`，UI 明示"扫描不完整"）。(f) **部分体检不可见**：`assessed` 只被 `reportHasData` 使用，部分报告会渲染成看不出漏测的自信评分 → 新增纯函数 `careAreaSplit` + 管家页「已检测 / 未检测」分区（i18n `care.assessed`/`care.notAssessed`）。 | `cargo test -p amos-tauri --lib` **227**（`devcare::` 27 / `host_battery::` 7，含越界与边界、取整、宿主缺标志、`Not charging`、decoy 条目、无可读电池）；`--features android --lib` **231**（`devcare_device::` 5，含缺尺寸行跳过+计 partial）；`clippy --workspace --all-targets -- -D warnings` 干净；`cargo fmt --all --check` 0 diff；`bun run check` EXIT=0（`devcare.test.ts` 29 / `device-care.svelte.test.ts` 39 / 全仓 458）；Kotlin `:app:compileUniversalDebugKotlin` BUILD SUCCESSFUL | `docs/TRACEABILITY_MATRIX.md` REQ-A39/A40/B7；`docs/devcare.md` §3.5/§4/REQ-DC54~56；**诚实边界**：真机运行期读数仍按 `docs/devcare.md` §8.2 验收（本轮未重建 APK） |
| 2026-09 | **P0-3 遥测真实性** | `amos-ai/src/inference/real.rs`：`BackendStats` 各指标字段改为 `Option<T>`，`None`=未采集；5 个后端（ggml/api/ollama/hermes/mock）的 `get_stats` 一律返回 `BackendStats::default()`（全 `None`），移除“`0`/`8192` 冒充有效遥测”；删除 `TODO: Query actual GPU stats`。新增回归测试 `stats_report_unknown_instead_of_fabricated_zero`。 | `cargo clippy -p amos-ai --all-targets -- -D warnings` 通过；`cargo test -p amos-ai --lib` 57 passed / 0 failed |
| 2026-09 | **P1-1 静默数据损坏** | `frontend-ts/src/lib/amosStore.ts`：`readJson` 区分“缺失”与“损坏”；损坏时 `console.warn` 并把原始字节隔离备份到 `${key}.corrupt`（有界单槽），避免被“读到空就播种写回”静默覆盖。新增 DOM 单测 `src/__tests__/amosStore.test.ts`。 | `tsc --noEmit` 通过；`bun test` 146 passed / 0 failed（+3） |
| 2026-09-12 | **P1-1 复核/补全：隔离槽是「只写不读」的死角** | 复核发现上一行只说对了一半：隔离**写入**了，但**全仓没有任何代码读过它**（`CORRUPT_SUFFIX` 甚至没有导出）——用户只在诊断台账里看到「原始字节已保留」，却既看不到也拿不出来；而且同键**第二次**损坏会**静默**覆盖上一份（有界单槽的代价没人说）。**补全**：导出 `CORRUPT_SUFFIX`；新增**读侧** `listQuarantined()`（扫描 `.corrupt` 槽，返回原键 + 字节数）与 `readQuarantine(key)`（取回原始文本）；覆盖已有隔离槽时**改记一条 error**，明说「替换了先前的隔离（丢掉了 N 字节）」；设置 → **系统监控与开发者**新增 `QuarantinePanel`（列键 + 字节数 + **复制原始内容**；无内容时整块不渲染，遵循该页“无数据不渲染”的规则；复制复用 `lib/clipboard.copySelection`）。**应用不自动“修复”它解析失败过的 JSON**——只交还字节。 | `src/__tests__/amosStore.test.ts` **+2**（隔离可读回 / 覆盖被如实记账）；DOM `settings-pages` **+1**（无隔离 ⇒ 面板不渲染；有隔离 ⇒ 列出键与字节数并可复制，`readQuarantine` 取回原文）；`tsc` 0 错、`svelte-check` 0/0、i18n **+6** 键；`make lint` EXIT=0 |
| 2026-09-12 | **WebView 里没人看得见的失败（REQ-A151）** | 桥（`lib/backend.ts`）按设计永不 reject（catch ⇒ 记诊断账本 + 返回 `null`），因此**唯一会 reject 的是回调自身抛错**（回复形状不符、`[...m]` 非数组、`JSON.parse` 失败），而这类抛出发生在**游离的 `.then()` 链**（度量：生产代码 **45 条** `void …then(` 无 `.catch(`；`void` 调用共 210 处，多数为安全的「向守护进程刷新」惯用法）。真正的问题是**全仓没有任何 `unhandledrejection` / `error` 观察者**（唯一的 `addEventListener("error")` 属铃声 `<audio>`）⇒ 这类失败不弹错、不进账本、刷新即失，屏幕只是空的。补：`lib/uiFailures.ts` 的 `installUiFailureObserver` 在 `shell-entry.ts::boot()` 首行安装（`index.html`/`shell.html` 共用入口），把两类事件记进**既有**账本（area `ui`，Settings→AI 诊断块可读回），**不 preventDefault**（只加可见性，不捂平台）。 | `frontend-ts/src/lib/uiFailures.ts`（新）、`src/shell-entry.ts`、`src/__tests__/uiFailures.test.ts`（**+6**：拒绝带原因入账本 / 非 Error 原因可描述且自身不抛 / 未捕获异常带 `file:line` / 重复安装不重复记账 / **重置后重装不叠加监听** / 不 preventDefault）；**负控**：`record()` 改为不记 ⇒ 5/6 FAIL，还原 ⇒ 绿；`bun run check` EXIT=0（新文件在 DOM 隔离通道；`svelte-check` 0/0；四扫描绿）、`make lint` EXIT=0 |
| 2026-09-12 | **记账里只记「抛了什么」、把「在哪抛的」丢了（REQ-A152）** | R87 装了 `unhandledrejection`/`error` 观察者，但复核发现它**记不下位置**：`record()` 把 `reason` 交给 `amosError`，`debugLog::safeDetail` 对 `Error` 走 `JSON.stringify` ⇒ **`{}`**（`message`/`stack` 都不是自有可枚举属性），**整条栈被丢弃**；`error` 分支有位置只因 `ErrorEvent` 自带 `filename`/`lineno`，而**拒绝事件没有**——模块注释却把「没有位置」写成「浏览器只给压缩栈」，**实际是没取**。补：`frameOf(reason)` 从 `Error.stack` 取**第一个帧**（`file:line:col`）追加进消息（与 `error` 分支同一 `(…)` 形状），`stackOf(reason)` 把**完整栈**作为 `detail`（仍受 500 字符上限 + 有界环）；非 `Error` 原因（字符串/对象/`undefined`）**无栈就不伪造位置**；两者对**抛异常的 `stack` getter** 都返回 `""`，观察者绝不变成新失败源。边界**改写而非删除**：帧是**压缩的**、需 source map；非 `Error` 无位置；重复计数等 R87 边界不变。 | `frontend-ts/src/lib/uiFailures.ts`、`src/__tests__/uiFailures.test.ts`（**6→8**：抛点从栈提取并进消息（确定性自定义栈）/ 非 Error 无位置且不抛）；**负控**：中性化 `frameOf`+`stackOf` ⇒ **7/8（正是「带抛点」条 FAIL）**，还原 ⇒ 8/8；`bun run check` EXIT=0（`tsc` 0、`svelte-check` 0/0、DOM 隔离通道、四扫描绿、unwired 基线仍 **45**）、`make lint` EXIT=0 |


| 2026-09 | **P1-4 长会话无界累积** | `frontend-ts`：新增纯工具 `lib/bounded.ts`（`capTail` 保留最近 N 条、非变异）；`BackendApps.tsx` 中 AI 会话消息与同传译文分别按 `CHAT_MSG_CAP=200`/`SEG_CAP=200` 封顶（含持久化前封顶）。新增单测 `__tests__/bounded.test.ts`。 | `tsc --noEmit` 通过；`bun test` 149 passed / 0 failed（+3） |
| 2026-09 | **P0-2 结构化 IPC 错误（阶段一）** | `frontend-ts/src/lib/backend.ts`：`invoke` 保留 `T | null` 契约（零调用方改动），内部把失败分类为 `not-bridged` / `command-failed` 并暴露 `bridgeDiag()` 可检索根因；成功后重置为 `ok`。新增测试 `backend.test.ts`（未桥接/命令抛错/恢复成功）。 | `tsc --noEmit` 通过；`bun test` 150 passed / 0 failed（+1） |
| 2026-09 | **功能完善：备忘录可编辑** | `lib/notes.ts` 新增纯函数 `editNote`（仅命中 id 才替换并更新时间戳；缺 id / 空白 / 文本未变时为真 no-op 返回原引用）；`apps.tsx` 备忘录 UI 增加“编辑”，单条进入编辑态并可保存/取消；新增 i18n `note.edit/cancel/save`。 | `tsc --noEmit` 通过；`bun test` 152 passed / 0 failed（+3） |
| 2026-09 | **P1-5 索引越界编译检查** | `frontend-ts/tsconfig.json` 开启 `noUncheckedIndexedAccess`，并修复由此暴露的 49 处索引：lib（`notes/photos/wallpaper/calculator/audio/voice/android/useFocusTrap`）与组件（`apps Weather`、`Wallpaper` 标签表按字面量联合精确定型）改为安全取值（`charAt`/可选链/守卫/`?? 兜底`）；测试断言对确定性夹具加非空断言。 | `tsc --noEmit` 0 error；`bun test` 152 passed / 0 failed（回归全绿） |
| 2026-09 | **P0-1 Rust panic 面（阶段一批：`amos-wm`）** | `amos-wm/src/lib.rs` 顶部加 `#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]`：生产代码禁 `unwrap/expect/panic`，测试模块豁免。审计确认该 crate 生产代码本就无 panic 入口（6 处均在测试内）。建立“先加门禁→CI 强制→后续收敛”的模式。 | `cargo clippy -p amos-wm --all-targets -- -D warnings` 通过；`cargo test -p amos-wm` 2 passed / 0 failed |
| 2026-09 | **P0-1（阶段一批：`amos-tts`）** | 同款门禁加到 `amos-tts/src/lib.rs`；其 8 处 `unwrap/expect` 均在测试模块，生产代码本就无 panic 入口。 | `cargo clippy -p amos-tts --all-targets/--all-features -- -D warnings` 通过；`cargo test -p amos-tts` 4 passed / 0 failed |
| 2026-09 | **P0-1（阶段一批：`amos-asr`）** | 同款门禁加到 `amos-asr/src/lib.rs`；默认与 `sherpa` feature 的生产代码均无 panic 入口。 | `cargo clippy -p amos-asr --all-targets/--all-features -- -D warnings` 通过；`cargo test -p amos-asr` 通过 |
| 2026-09-12 | **P0-1 收口：39 个 crate 里**5 个 lib 与 8 个 binary 根**从未加过门禁，且没有任何东西会提醒** | 复核「先加门禁→后续收敛」：`amos-blocklist` / `amos-proto` / `amos-sms` / `amos-int-cli` / `amos-timesync-cli` 的 **lib 根**没有该属性；更普遍的盲区是**二进制根**——全仓 9 个 `src/main.rs`/`src/bin/*.rs` 里**只有 1 个**（`amos-supervisor`）有门禁，而它们同样是生产代码。**先取证再改**：用 awk 只在 `#[cfg(test)]` **之前**统计，5 个 crate 与 9 个二进制根的**生产代码中 `unwrap/expect/panic` 计数全部为 0**。**补全**：给 13 个 crate 根补上 `#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]`，`cargo clippy -p <11 个受影响 crate> --all-targets -- -D warnings` **EXIT=0**（证明「干净」不是猜的）。**机械化**：新增 `scripts/rust-panic-scan.mjs`（自测 **9** 断言）：从根 `Cargo.toml` 读 members，对每个成员的 `src/lib.rs`、`src/main.rs`、`src/bin/*.rs` 要求**三条 lint 齐全**（只禁 `unwrap_used` 不算），允许清单 `scripts/rust-panic-allowlist.json`（今日空）+ `[stale]` 报告；接入 `make lint`。 | 新门：`48 crate root(s) across 39 workspace member(s)` **全部通过**；**负控 1**：删掉 `amos-blocklist` 的门禁块 ⇒ 门 **EXIT=1** 并点名该文件；**负控 2**：在已上门的 `amos-blocklist` 里加一个生产 `unwrap()` ⇒ **clippy 直接报 `clippy::unwrap_used`**（门有牙，不是装饰），两处还原 ⇒ 全绿 |

| 2026-09 | **P2-1 覆盖率门禁（接入 CI）** | `Makefile` 新增 `cov` 目标（`bun run coverage:gate`）；`.github/workflows/ci.yml` 的 `lint-and-test` 在 `make test` 之后新增 `make cov` 步骤，使 TS 核心 `src/lib` 覆盖率门禁成为每天跑的门禁。 | `make cov` 通过（84.92% ≥ 80%） |
| 2026-09 | **P2-1 覆盖率门禁（TS 核心）** | 新增 `frontend-ts/scripts/lib-coverage-gate.mjs`：解析 Bun lcov 报告，仅对 `src/lib/**`（25 文件 / 955 行）算聚合行覆盖率并设阈值（默认 80%，可用参数/`COVERAGE_THRESHOLD` 覆盖），低于则非零退出。`package.json` 新增 `test:coverage`、`coverage:gate`；`frontend-ts/.gitignore` 忽略 `coverage/`。当前基线 **84.92%**。 | `bun run coverage:gate` 通过（84.92% ≥ 80%）；`node … 0.9` 返回 exit 1（失败路径正确） |
| 2026-09 | **功能完善：信息可删单条** | `lib/messages.ts` 新增纯函数 `removeMessageAt`（删精确一条；越界为真 no-op 返回原引用、非变异）；`CommsApps.tsx` 信息列表每条气泡提供悬停“✕”删除单条；新增 i18n `message.remove`。 | `tsc --noEmit` 通过；`bun test` 153 passed / 0 failed（+1） |
| 2026-09 | **功能完善：地图可平移** | `lib/maps.ts` 新增 Web-Mercator 逆变换 `tileToLatLon`、`panTiles`（按瓦片平移）、`shiftCenter`（按屏幕像素手势平移，dx/dy 语义与拖拽一致）；`MapsApp.tsx` 支持**指针拖拽平移**（相对起点无漂移、指针捕获）与 **NSEW 平移按钮**；新增 i18n `maps.pan*/dragHint`。 | `tsc --noEmit` 通过；`bun test` 155 passed / 0 failed（+2） |
| 2026-09 | **P2-1 覆盖率提升** | 为 `files.ts` 未覆盖构造函数（`makeId/makeEntry/addEntry`）补单测；`src/lib` 行覆盖率 **84.92% → 85.82%**（835/973）。门禁默认阈值 **80% → 84%**。 | `bun test` 157 passed / 0 failed；`node scripts/lib-coverage-gate.mjs` 通过（85.82% ≥ 84%） |
| 2026-09 | **P2-1 覆盖率提升（二）** | 为 `backend.ts` 薄封装命令（tts/transcribe/translate/android/cancel/interpret 暂停恢复等）补“路由到正确命令”测试；`src/lib` 行覆盖率 **85.82% → 87.89%**（856/974）。门禁默认阈值 **84% → 86%**。 | `bun test` 158 passed / 0 failed；`make cov` 通过（87.89% ≥ 86%） |
| 2026-09 | **P2-1 覆盖率提升（三）** | 为 `stream.ts` 未覆盖项补测（`chatLogReset`/`finalSegmentOf`/`interpClear`/`onInterpOutput` 守卫分支）；`src/lib` 行覆盖率 **87.89% → 88.10%**（859/975）。门禁默认阈值 **86% → 87%**。 | `bun test` 162 passed / 0 failed；`node scripts/lib-coverage-gate.mjs` 通过（88.10% ≥ 87%） |
| 2026-09 | **P2-1 覆盖率达 90%（达标）** | 为 `amosStore.ts` 的布局/最近使用纯逻辑补 DOM 测试（`defaultLayout/getLayout/hideFromHome/restoreToHome/moveBefore/saveLayout/pushRecent/getRecents`，含未知 app 剪枝与新增合并）；`src/lib` 行覆盖率 **88.10% → 96.90%**（905/934）。门禁默认阈值升至 **90%**（达到审计目标）。 | `bun test` 168 passed / 0 failed；`make cov` 通过（96.90% ≥ 90%） |
| 2026-09 | **P2-2 可追溯矩阵** | 新增 `docs/TRACEABILITY_MATRIX.md`：以 `REQ-*` 编号把 A「应用/OS 功能」与 B「稳健性/安全」的“需求→设计/代码→验证”显式对应（含未完成的 REQ-C1 等）。 | 文档工件（与 §8/§9 对应，供后续改码回查） |
| 2026-09 | **P0-1（收敛型：`amos-translate`）** | 审计确认其 12 处 `unwrap/expect` 中 10 处在测试内；**生产仅 `shutdown_signal` 2 处 `.expect`**（装 SIGTERM/SIGINT），改为“尽力而为安装、失败仅告警并降级到 Ctrl-C/另一个信号”（不 panic）。`lib.rs` 加 P0-1 门禁。 | `cargo clippy -p amos-translate --all-targets -- -D warnings` 通过；`cargo test -p amos-translate` rc=0（含 full_chain E2E） |
| 2026-09 | **P0-1（收敛型：`amos-supervisor`）** | 生产 panic 点仅 `bin/amos-supervisor.rs` 装 SIGUSR1 的 `.expect`，改为“尽力而为安装、失败告警并仅用 Ctrl-C”（保留 SIGUSR1 热重启）。`lib.rs` 与 `bin` 顶部均加 P0-1 门禁。 | `cargo clippy -p amos-supervisor --all-targets -- -D warnings` 通过；`cargo test -p amos-supervisor` rc=0（14+1） |
| 2026-09 | **P0-1（收敛型：`amos-android`）** | 生产 panic 点仅 `png.rs icon_png` 的 zlib `.expect`；改为返回 `Result<Vec<u8>,String>`，`runtime.icon_for` 把编码失败映射为“无图标(None)”而非崩溃。其余 unwrap 均在测试内。`lib.rs` 加 P0-1 门禁。 | `cargo clippy -p amos-android --all-targets -- -D warnings` 通过；`cargo test -p amos-android` rc=0（24+1） |
| 2026-09 | **P0-1（收敛型：`amos-int`）** | 表观 60 处 unwrap 中绝大多数在测试内；**生产仅 2 处**：`session.rs` 译后解构 `.expect`（改为 let-else 防御分支，缺失即按失败处理而非 panic）与 `pipeline.rs` 锁 `.unwrap()`（改 poison-safe `into_inner`）。`lib.rs` 加 P0-1 门禁。 | `cargo clippy -p amos-int --all-targets -- -D warnings` 通过；`cargo test -p amos-int` rc=0（39+1） |
| 2026-09 | **P0-1（收敛型：`amos-ai`）** | 表观 42 处 unwrap 绝大多数在测试内；**生产仅 `server.rs` shutdown_signal 装 SIGTERM/SIGINT 的 2 处 `.expect`**，改为“尽力而为安装、失败告警并降级到 Ctrl-C/另一信号”。`lib.rs` 加 P0-1 门禁。 | `cargo clippy -p amos-ai --all-targets -- -D warnings` 通过；`cargo test -p amos-ai` rc=0（57 lib + 集成） |
| 2026-09 | **P0-1（收敛型：`amos-tauri`）** | 生产 unwrap 集中：`interpret.rs` 8 处 `guard.as_mut()/take().unwrap()` 改 `ok_or_else` 返回 `Err`；`ai_bridge.rs with_client_id` 的 `.expect` 改“解析失败即省略头”；`wm.rs::new` 与 `lib.rs::run`（Launcher 不变量 / GUI 启动边界）保留 `.expect` 但加**文档化 `#[allow(clippy::expect_used)]`** 作唯一例外。`lib.rs` 加 P0-1 门禁。 | `cargo clippy --workspace --all-targets -- -D warnings` 通过；`cargo test -p amos-tauri --lib` rc=0（14） |
| 2026-09 | **P2-3 / P2-4（收尾）** | P2-3：全仓代码（`src`，排除测试/生成）已无遗留 `TODO/FIXME/HACK/XXX`（`real.rs` 的遥测 TODO 早于 P0-3 移除）。P2-4：`README.md` 顶部加入“非审定软件 / not certified，勿用于 DAL-A”免责声明。 | `grep TODO/FIXME` 代码层 0 命中 |
| 2026-09 | **功能完善：文件可搜索排序** | `lib/files.ts` 新增 `sortChildren`（按名称/时间/default 排序，不变量入参）与 `filterByName`（大小写不敏感子串过滤，空查询透传）；`FilesApp.tsx` 顶部加“搜索框 + 排序循环按钮”，列表改用 `display`，空态区分“空文件夹/无匹配”；新增 i18n `files.search/sort/sortName/sortTime/noMatch`。 | `tsc --noEmit` 通过；`bun test` 170 passed / 0 failed（+2） |
| 2026-09 | **功能完善：相册多选批量删除** | `lib/photos.ts` 新增 `removePhotos(list, ids)`（批量删、空集为原引用 no-op）；`apps.tsx` Photos 增加“选择/取消”模式：点选打勾、再次进入仍可打开查看器、底部“删除所选(n)”；新增 i18n `photo.select/cancel/deleteSelected`。 | `tsc --noEmit` 通过；`bun test` 171 passed / 0 failed（+1） |
| 2026-09 | **功能完善：相册查看器上/下张切换** | `lib/photos.ts` 新增 `neighborOf(list,id,±1)`（环绕取邻居；<2 张或缺 id 返回 null）；`apps.tsx` Photos 查看器加 ‹ › 前后张与“当前/总数”位置；新增 i18n `photo.prev/next`。 | `tsc --noEmit` 通过；`bun test` 172 passed / 0 failed（+1） |
| 2026-09 | **功能完善：时钟世界时钟** | `lib/time.ts` 新增纯函数 `zoneClock(date, IANA 时区)`（HH:MM；无效时区回退本地不抛错）；`apps.tsx` Clock 除本地大钟外新增北京/东京/伦敦/纽约世界时钟卡片（随 1s 实时刷新）；新增 i18n `clock.city.*`。 | `tsc --noEmit` 通过；`bun test` 174 passed / 0 failed（+2） |
| 2026-09 | **功能完善：信息按时间分组** | `lib/messages.ts` 新增 `fmtBubbleTime`/`dayStamp`/`messageDayLabel`/`isNewDay`（HH:MM、日历日戳、今天/昨天标记、跨天判定）；`CommsApps.tsx` 信息列表按天插分隔头（今天/昨天/日期）并给每条气泡加发送时间；新增 i18n `message.today/yesterday`。 | `tsc --noEmit` 通过；`bun test` 175 passed / 0 failed（+1） |
| 2026-09 | **功能完善：文件全盘/内容搜索** | `lib/files.ts` 新增 `contentContains` 与 `searchFiles(list,query,includeContent)`（跨目录按名称+可选内容匹配，结果按名排序）；`FilesApp.tsx` 搜索框旁加“当前目录/全局”切换，全局模式跨整棵树搜名称与文本内容；新增 i18n `files.global/currentFolder`。 | `tsc --noEmit` 通过；`bun test` 176 passed / 0 failed（+1） |
| 2026-09 | **审计并补全最新功能** | 复查近期功能批次，修复两处真实缺陷：① Files 全局模式下空态误显示“空文件夹”→ 改三态（全局无输入→`files.searchHint` / 有输入无匹配→`noMatch` / 否则→`empty`）；② 排序按钮在全局模式无意义→仅当前目录模式显示。新增 i18n `files.searchHint`。 | `tsc --noEmit` 通过；`bun test` 176 passed / 0 failed（回归全绿） |
| 2026-09 | **审计并补全最新功能（二）** | Files 全局搜索中点开某文件夹后仍滞留“全局+关键词”视图（看起来卡住）→ 新增 `openFolder`：从全局搜索命中打开文件夹时自动退出全局并清空关键词，再进入该目录。 | `tsc --noEmit` 通过；`bun test` 176 passed / 0 failed |
| 2026-09 | **功能完善：相册查看器方向键切换** | `apps.tsx` Photos 单张查看器加 `keydown`（ArrowLeft/Right 用 `neighborOf` 前后切换，打开时挂、关闭时清）；新增 DOM 回归测试 `photos-keys.test.tsx`（点开首张→→/←验证内容变化）。 | `tsc --noEmit` 通过；`bun test` 177 passed / 0 failed（+1） |
| 2026-09 | **功能完善：Files 全局结果显示所属路径** | `lib/files.ts` 新增 `folderPath(list,id)`（祖先文件夹名面包屑 `A / B`，根目录为空串）；`FilesApp.tsx` 全局搜索结果在名称下方显示“所属文件夹路径”（根目录显示“根目录”），当前目录模式仍显示时间；新增单测。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed（+1） |
| 2026-09 | **功能完善：iOS 风格 Home 指示条** | `App.tsx` 新增 `HomeIndicator`：任意 app 界面（`AppShell`）底部常驻圆角指示条，**点击或上滑**即调用 `onBack`（`setActive(null)`）回到主屏/dock；与顶栏 ‹ 一致。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed（回归全绿） |
| 2026-09 | **体验优化：切 app 重置滚动 + 进入动画** | ① `AppShell key={active}`：切换不同 app 时重建视图容器，杜绝“沿用上一 app 的滚动位置（新页一开就在中间）”；② 新增 `@keyframes app-enter`（快速淡入+微上升），打开 app 更顺滑。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **UI 观感优化：图标/按钮/dock** | ① 主屏与 dock 图标 tile 改 iOS 质感：渐变底 + `ring` 微描边 + 阴影、悬停微上浮、点按回弹（`group-hover/-active`）；未读角标加白描边更立体；② dock 容器改半透明+`backdrop-blur` 毛玻璃；③ 全局按钮禁双击缩放/去 iOS 点击高亮、文本不可选中（输入框除外）。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **对齐苹果手机：iPhone 机身框** | 把整个 OS 包进“手机外框”：宽屏（≥sm）下居中、限宽 ~400px、圆角 + 机身阴影 + 细描边，视觉如 iPhone 竖屏；窄屏/真机仍是整屏。壁纸 `Backdrop` 由窗口级 `fixed` 改为框内 `absolute`（铺在机身内而非整个桌面）。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **对齐苹果手机：状态栏灵动岛** | `StatusBar.tsx` 状态栏中间加 Dynamic Island 黑色胶囊（`pointer-events-none`、绝对居中、不挤压左右时间/电量）。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **对齐苹果手机：app 也显示状态栏** | `AppShell` 顶部复用 `StatusBar`（时间 + Dynamic Island + 电量），使打开任意 app 时顶部仍保持 iPhone 状态栏观感（位于 app 标题栏上方）。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **对齐苹果手机：浮层收进机身 + 毛玻璃** | 通知中心 / 最近使用 / 搜索 / 锁屏由 `fixed inset-0`（铺满整个桌面、跑出机身）改为框内 `absolute inset-0` 并加 `backdrop-blur` 毛玻璃（iOS 深色半透明浮层）。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **对齐苹果手机：下拉开通知中心** | 主屏顶部（y≤110px 起始、下拖 >70px）下拉即打开通知中心/快速设置，类 iOS；在已开 app / 编辑 / 锁屏 / 其它面板时不触发。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **UI：彩色 iOS 图标** | 主屏/dock 图标 tile 由统一灰底改为**按 app 确定性配色的渐变底**（10 组明亮色，`toneOf(id)` 哈希选择），更接近 iPhone 主屏的彩色圆角图标；保留微描边/阴影/悬停上浮/点按回弹。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **UI：图标玻璃高光** | 图标 tile 叠加顶部径向柔光（`radial-gradient` 白色高光），增强 iOS 玻璃/质感观感。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **UI：图标悬停放大/上浮** | 主屏/dock 图标 hover 时 `scale-110` + 上浮，点按回弹 `scale-90`，反馈更鲜活。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **UI：dock 邻位联动放大** | 用纯 CSS（`.dock-mag` + `:has`）实现 macOS 风格 dock：鼠标经过某图标，它与左右邻居按距离放大/上浮并抬高层级；避免与内层 hover 叠加，页内图标仅保留上浮+点按。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **UI：顶栏玻璃圆钮** | 主屏顶栏 🔔/⇤/🔍/✎/🔒 改为 iOS 玻璃圆形按钮（半透白 + backdrop-blur + 细描边 + 点按缩放）。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **UI：app 界面平台背景 + 毛玻璃标题栏** | `AppShell` 改为不透明 iOS 平台背景（`bg-neutral-100 / dark:neutral-950`），标题栏加半透白 + `backdrop-blur` 磨砂；app 内内容可读性更佳、更贴近 iPhone。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **UI：图标名称悬停高亮** | 主屏/dock 图标名称 hover 时文字变主题色（`group-hover:text-accent`）并加过渡，与放大反馈呼应。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **交互：信息向左滑动删除单条** | Messages 每条消息支持 iOS 手势：左滑 >50px 即删除该条（与 ✕ 并存）；触屏/设备模拟下可用。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **交互：app 顶部下拉关闭回主屏** | 在 app 内从顶部 (~120px 内) 下拉 >70px 即 `onBack` 回 dock（与主屏“下拉通知”区分，避免误触已开内容顶部）。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **UI：面板滑入动效** | 通知中心下拉滑入(`drop-in`)、最近/搜索底部上浮(`sheet-in`)、锁屏淡入(`fade-in`)，更接近 iOS 转场。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **功能：首页小组件 + 可滚动主屏** | 新增 `components/HomeWidgets.tsx`：首页顶部玻璃“实时时钟卡（时间+日期）+ 今日天气卡”；`HomeDock` 改为上方区域可滚动（小组件 + 图标网格）、dock 固定底部，图标多也不挤压。复用已测纯函数 `fmtClock`/`forecast`。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **功能：地图城市快捷切换** | Maps 搜索行下加一排城市 chips（来自 `PLACES`），点即跳到该城市并高亮当前；点击清空搜索词。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **功能：首页小组件可点开 app** | `HomeWidgets` 支持 `onOpen`：时钟卡→开“时钟”、天气卡→开“天气”（`HomeDock` 传入 `open`），卡片带点按回弹。 | `tsc --noEmit` 通过；`bun test` 178 passed / 0 failed |
| 2026-09 | **功能：地图城市国际化** | `lib/maps.ts` 加 `CITY_LABELS`/`cityLabel`/`cityKey`：中文/英文界面下城市名本地化显示，且中英文都能搜索/点 chip（chip 按当前语言显示）。 | `tsc --noEmit` 通过；`bun test` 179 passed / 0 failed（+1） |
| 2026-09 | **功能：天气单位 ℃/℉ 切换** | `lib/weather.ts` 加 `cToF`/`displayTemp`/`convertRange`；Weather app 顶部 ℃/℉ 切换，今日大温与各日区间联动换算。 | `tsc --noEmit` 通过；`bun test` 180 passed / 0 failed（+1） |
| 2026-09 | **功能：备忘录置顶/星标** | `Note.pinned?` + `togglePin`/`orderPinned`（置顶浮到最上、取消置顶仅去星保留该条；持久化经 normalize 保留 pinned）；Notes UI 加 ☆/★ 按钮；i18n `note.pin`。含单测（并修正实现缺陷：取消置顶不再误删）。 | `tsc --noEmit` 通过；`bun test` 183 passed / 0 failed（+3） |
| 2026-09 | **功能：相册设为壁纸** | Photos 单张查看器里，对**真实拍摄**照片显示“设为壁纸”，点击写入 `amos.settings.wallpaper`（data URL，主屏壁纸即用该图）；渐变占位图不显示该操作；i18n `photo.setWallpaper(+Done)`。 | `tsc --noEmit` 通过；`bun test` 183 passed / 0 failed |
| 2026-09 | **功能：文件收藏/最近** | `lib/files.ts` 加 `FILES_FAV_KEY`/`toggleFav`/`recentFiles`；FilesApp 顶部“全部/收藏/最近”切换 + 每行 ☆/★ 收藏（持久化），收藏空态提示。含单测。 | `tsc --noEmit` 通过；`bun test` 184 passed / 0 failed（+1） |
| 2026-09 | **功能：备忘录归档/最近删除** | `Note.state?`（archived/trash）+ `setNoteState`/`notesOf`（normalize 保留 state）；Notes UI 顶部“备忘录/归档/最近删除”分页：备忘录可编辑/置顶/归档/删除(→最近删除)，归档可恢复或删除，最近删除可恢复或彻底删除。含单测。 | `tsc --noEmit` 通过；`bun test` 185 passed / 0 failed（+1） |
| 2026-09 | **功能：信息已读/未读** | `Msg.read?`（仅对方消息计未读）+ `unreadCount`/`markAllRead`/`markRead`；Messages 顶栏在未读时显示“● n 条未读”可一键标已读，点对方未读气泡即标已读、发送自动清未读；seed 留一条未读作演示。含单测。 | `tsc --noEmit` 通过；`bun test` 186 passed / 0 failed（+1） |
| 2026-09 | **功能：备忘录搜索** | `lib/notes.ts` 加 `searchNotes`（大小写不敏感子串）；Notes“备忘录”视图顶部加搜索框，实时过滤活动便签（含置顶排序）。含单测。 | `tsc --noEmit` 通过；`bun test` 187 passed / 0 failed（+1） |
| 2026-09 | **功能：时钟秒表** | `lib/time.ts` 加纯 reducer `stopwatchReducer`/`stopwatchInit`/`fmtStopwatch`（开始/暂停/继续/清零/计时换算）；Clock 加“秒表”卡（▶/⏸/↺，运行时 50ms 刷新）。含单测。 | `tsc --noEmit` 通过；`bun test` 188 passed / 0 failed（+1） |
| 2026-09 | **功能：音乐循环模式** | `lib/music.ts` 加 `RepeatMode` + `nextIndex(…, mode)`（one 单曲 / all 列表循环 / off 到端停止）；MusicApp 加 🔁/🔂 循环按钮，手动切歌与自动切歌均遵循模式。含单测。 | `tsc --noEmit` 通过；`bun test` 189 passed / 0 failed（+1） |
| 2026-09 | **功能：相册幻灯片** | Photos 查看器加“▶ 幻灯片”开关：开启后每 2.5s 用 `neighborOf` 自动切到下一张，可再点“停止”暂停，关闭查看器自动复位。含 DOM 单测（开/关切换）。 | `tsc --noEmit` 通过；`bun test` 190 passed / 0 failed（+1） |
| 2026-09 | **功能：计算器历史** | `lib/calculator.ts` 加纯 helpers `calcEntry`（= 前的待求表达式→`{expr,result}`，无运算/不可解返 null）与 `addHistory`（新者在前、按 expr+result 去重、上限 12）；Calculator 顶部加“历史”展开/清空，按 = 时记录。含单测。 | `tsc --noEmit` 通过；`bun test` 193 passed / 0 failed（+3） |
| 2026-09 | **功能：时钟倒计时计时器** | `lib/time.ts` 加纯 reducer `timerReducer`/`timerInit`/`fmtCountdown`（设定时长/开始/暂停/继续/tick 自动到 0 停止/重置/结束后可重开）；Clock 加“计时器”卡（1/3/5 分钟预设、到点红色提示）。含单测。 | `tsc --noEmit` 通过；`bun test` 194 passed / 0 failed（+1） |
| 2026-09 | **功能：音乐进度跳转** | `lib/music.ts` 加纯 helpers `pctProgress`/`seekSeconds`（0..1 钳制、无 total 时归 0 不 NaN）；MusicApp 进度条改为可点击/键盘方向键跳转（mm:ss 显示、拖动端部触发切歌）。含单测。 | `tsc --noEmit` 通过；`bun test` 195 passed / 0 failed（+1） |
| 2026-09 | **功能：备忘录字数统计** | `lib/notes.ts` 加纯 `noteStats`（按码点计字符/词数/行数）；Notes 撰写栏底部实时显示“{chars} 字 · {lines} 行”，每条便签下方加字符数。含单测。 | `tsc --noEmit` 通过；`bun test` 196 passed / 0 failed（+1） |
| 2026-09 | **功能：计算器键盘支持** | `lib/calculator.ts` 加纯 `calcFromKey`（把物理键映射为 iOS 符号标签：数字/Enter=/Backspace/Delete|Escape|C/%/+−×÷；修饰键与未知键返回 null）；Calculator 挂 window keydown 监听并 preventDefault 已处理键。含单测。 | `tsc --noEmit` 通过；`bun test` 198 passed / 0 failed（+2） |
| 2026-09 | **优化：渲染/监听去重** | Notes 撰写栏与每条便签的 `noteStats` 单次计算复用（消除每帧重复扫描）；Calculator 键盘监听改用 ref 持最新 `press`、listener 仅注册一次（消除逐键解绑/重挂）。含 DOM 单测（键盘→显示端到端）。 | `tsc --noEmit` 通过；`bun test` 200 passed / 0 failed / 34 files（+2） |
| 2026-09 | **优化：世界时钟格式器缓存** | `lib/time.ts` 的 `zoneClock` 不再每次调用新建 `Intl.DateTimeFormat`（世界时钟 4 城 × 每秒刷新原先每帧各建一次）；改为按 IANA 时区缓存、仅首次构造，未知时区仍回退本地时间不抛错。含缓存命中路径单测。 | `tsc --noEmit` 通过；`bun test` 201 passed / 0 failed（+1）；覆盖 97.57% ≥ 90% |
| 2026-09 | **优化：时钟高频渲染隔离** | 秒表抽成独立 `StopwatchCard` 子组件（自带 50ms reducer + interval），其 20Hz 重渲染不再连带刷新世界时钟/本地时钟/倒计时（仅 1Hz）；行为与 i18n 不变。含 Clock DOM 冒烟单测。 | `tsc --noEmit` 通过；`bun test` 202 passed / 0 failed / 35 files（+1）；覆盖 97.57% ≥ 90% |
| 2026-09 | **功能：备忘录任务清单** | `lib/notes.ts` 加纯 helpers `tasksOf`/`toggleTaskInText`/`taskSummary`（解析 `[ ]`/`[x]`（含 `- ` 前缀）行，按 0 基切换某个复选框且不动其它内容，越界为纯 no-op，进度统计）；Notes 编辑视图在正文含任务行时渲染可勾选面板（☑/☐、完成划线、`完成/总数`）。含单测。 | `tsc --noEmit` 通过；`bun test` 205 passed / 0 failed（+3） |
| 2026-09 | **功能：相册收藏** | `lib/photos.ts` 加 `Photo.fav?`（持久化保留）+ 纯 `toggleFav`/`favsOf`；Photos 查看器加 ♥/♡ 切换、图块左角 ♥ 指示、头部“全部 / ♥(n)”筛选与空收藏提示。含纯逻辑 + DOM 单测。 | `tsc --noEmit` 通过；`bun test` 207 passed / 0 failed（+2） |
| 2026-09 | **功能：时钟闹钟（第 4 卡）** | `lib/time.ts` 加 `Alarm`/`alarmInit`/`alarmsReducer`/`alarmKey`/`ringingAlarms`（add/remove/toggle/dismiss/tick：到点分钟触发并幂等锁存、关闭即停、越界钳制）；Clock 加闹钟卡（列表+开关+删除+时:分+标签添加，持久化 `amos.alarms`，ringing 时红色横幅可关闭）。含 reducer 单测 + DOM 冒烟扩展。 | `tsc --noEmit` 通过；`bun test` 208 passed / 0 failed（+1） |
| 2026-09 | **功能：信息引用回复** | `lib/messages.ts` 给 `Msg` 加可选 `quote?` + 纯 `appendQuote`（trim 后写入，空引用退化为普通消息）；Messages 气泡 hover 出 “↩” 引用回复按钮、气泡顶部显示被引原文、发送栏出现“正在回复：…”横幅可取消，发送携带引用。含单测。 | `tsc --noEmit` 通过；`bun test` 209 passed / 0 failed（+1） |
| 2026-09 | **功能：音乐同步歌词** | `lib/music.ts` 加 `DEMO_LYRICS` + 纯 `lyricIndex`（把播放秒映射到歌词行，均匀铺开并钳制）；MusicApp 加 💬 歌词开关，面板随进度高亮当前行（可拖进度条联动）。含单测。 | `tsc --noEmit` 通过；`bun test` 210 passed / 0 failed（+1） |
| 2026-09 | **功能：文件多选批量删除** | `lib/files.ts` 加纯 `deleteEntries`（删除若干 id 的子树并集；空集/未知 id 不变）；FilesApp 工具条加“选择/取消/删除所选(n)”，选择态下行变为勾选、隐藏单条操作，整行点击/回车切换。含纯逻辑 + DOM 单测。 | `tsc --noEmit` 通过；`bun test` 212 passed / 0 failed / 36 files（+2） |
| 2026-09 | **功能：闹钟再响 + 修复“同分钟关闭复响”** | `lib/time.ts` `alarmsReducer` 触发改为“仅在新到达分钟 freshMinute 才响”（修复同一分钟内 dismiss 后下次每秒 tick 又复响、致关闭在当分钟失效的缺陷）；新增 `snooze` 动作（停止响铃并把闹钟后移约 1 分钟，跨小时安全）。Clock 响铃横幅加“再响/关闭”。含回归单测（dismiss 保持停 / snooze 下一分钟再响）。 | `tsc --noEmit` 通过；`bun test` 214 passed / 0 failed（+2） |
| 2026-09 | **功能：设置 iCloud 风格云同步** | 新增 `lib/cloud.ts`：纯 `readCloud`/`setCloudPrefs`（设置里 `iCloudSync`/`cloudLast` 读写、容忍脏数据）+ `snapshotStores`（固定键序、确定性 JSON 备份）；Settings 加云开关（role=switch），开启后显示提示/上次同步时间并可“立即同步”把备忘录/文件/相册/信息/音乐等快照写入 `amos.cloud.backup`。含纯单测（DOM 用例因与既有 GlobalRegistrator 共享 worker 冲突而撤除，改由纯测试覆盖）。 | `tsc --noEmit` 通过；`bun test` 216 passed / 0 failed（+2） |
| 2026-09 | **功能：相册分享（复制摘要）** | `lib/photos.ts` 加纯 `shareCaption`（真实照片标 📷+时间，演示图用 emoji；含 “— shared from Amos” 尾注）；Photos 查看器加“分享”按钮，把摘要写入剪贴板并提示“已复制”。含纯单测。 | `tsc --noEmit` 通过；`bun test` 217 passed / 0 failed（+1） |
| 2026-09 | **功能：文件全选/全不选** | Files 选择态下新增“全选 (n)/全不选”芯片，作用于当前可见（过滤后）行集；全选后单次“删除所选”清空。含 DOM 单测扩展。 | `tsc --noEmit` 通过；`bun test` 218 passed / 0 failed（+1） |
| 2026-09 | **功能：天气多城市** | `lib/weather.ts` 加 `WCity`/`WEATHER_CITIES`（北京为基准，东京/伦敦/纽约各带 ℃ 偏置）+ 纯 `shiftRange`/`adjustForecast`（平移温度与高低温区间、负值安全、0 偏置返回副本）；Weather UI 顶部加城市芯片（激活城市高亮），预报随城市平移并与 ℃/℉ 联动。含单测。 | `tsc --noEmit` 通过；`bun test` 219 passed / 0 failed（+1） |
| 2026-09 | **功能：闹钟每周重复** | `lib/time.ts` `Alarm` 加可选 `repeat?: number[]`（0=日..6=六；缺省每天）+ `dayAllowed`；`add` 去重排序存重复日、`tick` 用 `dayAllowed` 门控（重复日之外不响）。Clock 添加区加 一周七按钮（周日/一…）重复选择、闹钟行显示“重复: 一·三·五”，重复可叠加 ℃/时段。含单测（周一响/周日不响、无 repeat 每天）。 | `tsc --noEmit` 通过；`bun test` 220 passed / 0 failed（+1） |
| 2026-09 | **功能：文件多选移动** | `lib/files.ts` 加纯 `moveEntries`（把若干 id 移到目标目录/根，逐条沿用环安全守卫，空集同引用）；Files 选择态加原生“移动到…”下拉（目标=未选中的文件夹 + 根目录），选定即移动并退出选择。含单测（多文件迁入 A、移动 A 入 B、A 移入自身被守卫）。 | `tsc --noEmit` 通过；`bun test` 221 passed / 0 failed（+1） |
| 2026-09 | **功能：闹钟铃声** | `lib/time.ts` `Alarm` 加 `tone?: string` + `ALARM_TONES`（🔔/⏰/📯/🎶）；`add` 校验 tone（非法回退默认），reducer 加 `tone` action 循环切换并回绕；Clock 每行铃铛可点循环换铃声，响铃横幅/行显示当前铃声 emoji。含单测（默认/循环/回绕、旧数据缺 tone 用默认）。 | `tsc --noEmit` 通过；`bun test` 222 passed / 0 failed（+1） |
| 2026-09 | **功能：文件层级“移动到”树** | `lib/files.ts` 加纯 `folderTree`（BFS 列出所有文件夹及嵌套深度、环安全、不含文件）；Files 多选“移动到…”下拉改为按嵌套深度缩进展示树形目标（如 `　子文件夹`）。含单测（根/子深度、排除文件、坏父链不挂/不重复）。 | `tsc --noEmit` 通过；`bun test` 223 passed / 0 failed（+1） |
| 2026-09 | **文档：TRACEABILITY_MATRIX 对账** | 矩阵 A 区新增 REQ-A14..A21（备忘录/相册/时钟/计算器/音乐/文件/信息/天气+设置云），B 区计数回填（B7 覆盖率 97.7%、B8 用例 222/36），与 §8 及代码/测试三方一致。 | 人工文档核对 + `bun test` 全绿 | ✅ |
| 2026-09 | **功能：备忘录行内富文本** | `lib/notes.ts` 加纯 `fmtInline`（把 `**粗体**`、`==高亮==` 切成 {text,bold,hl} 片段；无标记即单段、内容逐字保留）；Notes 只读行用 `<strong>`/`<mark>` 渲染粗体与高亮，编辑框仍按原文编辑（标记即语法）。含单测（分片、去标记 round、无标记保真）。 | `tsc --noEmit` 通过；`bun test` 224 passed / 0 failed（+1） |
| 2026-09 | **功能：备忘录行内富文本（续：删除线）** | `RichSeg` 加 `strike`，`fmtInline` 支持 `~~删除线~~`；Notes 只读行用 `<s>` 渲染删除线。含单测（三标记同现、去标记 round 含 ~~）。 | `tsc --noEmit` 通过；`bun test` 224 passed / 0 failed（+0） |
| 2026-09 | **功能：AI provider 本地/云端切换（DeepSeek 预设）** | 新增 `lib/providers.ts`（纯：`readAiConfig/setAiConfig/envFor`，本地 mock ↔ 云端 DeepSeek；切回本地自动清除云端 key）；Settings 加“AI 推理后端”卡（选择 本地/DeepSeek，云端可填 模型/接口/API Key 保存）。含纯单测。 | `tsc --noEmit` 通过；`bun test` 228 passed / 0 failed（+3）；cargo clippy 干净 |
| 2026-09 | **功能：AI 后端本地/云端一键切换 + 持久化恢复** | 新增 `scripts/ai-backend.sh`（停旧→写配置→按 provider 起 `amos-ai`；无参时从 `/tmp/amos-ai-backend.json` 恢复上次选择）；Tauri 命令 `ai_backend_switch` + 前端 `switchAiBackend`，Settings “AI 推理后端”保存即即时切换并在界面回显。`amos-translate` 亦指向 DeepSeek 真翻译（live 实测“机器学习是人工智能的一个分支。”）。 | 前端 228/37 绿；`cargo build/clippy -p amos-tauri` 干净；`chat_once`/`translate_once`/resume 对 live daemon 实证 |
| 2026-09 | **功能/工具：真实云端推理与翻译链路 + live smoke** | `amos-ai` 以 `AMOS_BACKEND=api` 对接 DeepSeek（实测流式出文）；新增 live 示例 `amos-ai/examples/chat_once.rs`、`amos-translate/examples/translate_once.rs`（连接运行中 daemon 发真实 RPC）；`amos-translate` `OllamaProvider` 补 Bearer 鉴权（`AMOS_TRANSLATE_API_KEY`）。含单测 + clippy。 | `cargo test -p amos-translate` 通过；`chat_once`/`translate_once` 对 live daemon 实证；cargo clippy -D warnings 干净 |
| 2026-09 | **安全：云端 AI key 不明文进前端存储** | `setAiConfig` 不再把 `apiKey` 写进 localStorage/设置/快照（前端仅保留瞬时态，一次性交给命令）；`amos-tauri ai_backend_switch` 把 key 以 **0600** 写入 `~/.amos/ai.key`（可 `AMOS_CRED_FILE` 覆盖），后续切云端/恢复无需重填；脚本 resume 回读该文件。含单测（key 不落设置、readback 无 key）。 | `bun test` 228/37 绿；`cargo build/clippy -p amos-tauri` 干净 |
| 2026-09 | **生产启动：后端编排 `run-backends.sh`** | 单一启动入口：按持久化 `/tmp/amos-ai-backend.json` 用 `ai-backend.sh` 启 `amos-ai`（无配置默认本地），拉起/复用 `amos-translate`（socket 已在则不动），等待双 socket 就绪并打印 backend 报告；README Build&run 改以此为生产启动。 | `bash -n` 通过；resume/双向切换对 live daemon 实证 |
| 2026-09 | **生产可观测：Settings 显示当前 AI 后端** | Settings “AI 推理后端”卡底部显示 daemon 实际服务中的模型（真实 `get_status`；浏览器/离线显示 offline），切换成功后再刷新，便于确认所选后端已生效。 | 前端 228/37 绿；`cargo build -p amos-tauri` 干净 |
| 2026-09 | **生产监管：`supervise-backends.sh`（supervisor 接入持久化后端配置）** | 解析 `/tmp/amos-ai-backend.json`（local→mock；deepseek→api+endpoint+model+key 从 `~/.amos/ai.key` 或 env）生成 supervisor JSON spec 并 `exec amos-supervisor run`；`--print-config/--dry-run` 免 key 预览。崩溃自动拉起 / SIGUSR1 热重启为 supervisor 既有能力。 | `bash -n` 通过；`--print-config` 输出正确 spec |
| 2026-09 | **运维：RPC 就绪健康检查 `health-backends.sh`** | 新增 `amos-ai/examples/status_once.rs`、`amos-translate/examples/status_once.rs`（对 live daemon 调 unary `get_status`）+ `scripts/health-backends.sh`（要求 `running=true`，否则非零退出）——比“socket 存在”更严格的就绪探测。 | `make lint` 干净；live：ai `running=true`、translate `model=deepseek-chat` → `health OK` |
| 2026-09 | **审计：REQ-C1/C2 状态校准 + REQ-C2 补全** | C1：核对 8 crate 已带 P0-1 deny（`amos-proto` tonic 生成码、`amos-int-cli` 交互 CLI 合理排除），矩阵 ⬜→✅。C2：`amos-ai` 超时会话清理真正接线——`cleanup_interval()` + `server::new()` 常驻周期清扫、活动 `touch()` 保活；补单测。 | `cargo test -p amos-ai`（13 项含 touch 保活 / 后台定时清扫）通过；clippy `-D warnings` 干净 |
| 2026-09 | **功能补全：天气湿度/风** | `weather.ts` `DayForecast` 加 `humidity/wind` 并填充确定性数据（城市偏置只移温度/区间、湿度不变）；Weather UI 今日区显示“湿度 X% · 风 Y”、各日行加 💧湿度。含单测（湿度整数 0–100、wind 非空、随城市偏置保留）。 | `tsc --noEmit` 通过；`bun test` 229 passed / 0 failed（+1） |
| 2026-09 | **稳健性补全：文件存储归一化 `normalizeFiles`** | 新增纯 `normalizeFiles`（容忍畸形数组：丢弃非对象/无名/坏类型，回填缺失 id，去重 id 冲突）；FilesApp 加载时先归一化再入状态，防坏档/手改 `amos.files` 崩溃。含单测（畸形/缺 id/重复 id/null/primitive）。 | `tsc --noEmit` 通过；`bun test` 230 passed / 0 failed（+1） |
| 2026-09 | **稳健性补全：相册存储归一化 `normalizePhotos`** | 新增纯 `normalizePhotos`（容忍畸形：丢弃无可辨识内容项、回填缺 id、去重 id、保留 `fav`）；Photos 加载时先归一化再入状态。含单测（畸形/重复 id/缺 id/null/primitive、fav 保留）。 | `tsc --noEmit` 通过；`bun test` 231 passed / 0 failed（+1） |
| 2026-09 | **稳健性补全：信息/音乐存储归一化** | 新增纯 `normalizeMessages`（坏 sender/空白正文丢弃、保留 `read`/`quote`）与 `normalizeTracks`（无标题丢弃、缺 id 回填、去重）；Messages/Music 加载时先归一化再入状态。含单测。 | `tsc --noEmit` 通过；`bun test` 233 passed / 0 failed（+2） |
| 2026-09 | **稳健性补全：备忘录极端输入稳定性** | 补单测：5000 行任务清单解析/单条切换/越界 no-op 不退化；残缺未闭合标记（`**`/`==`/`~~`）按纯文本安全处理不误判；空正文边缘返回空。 | `tsc --noEmit` 通过；`bun test` 234 passed / 0 failed（+1） |
| 2026-09 | **稳健性补全：设置/通知键值校验 + 文件子树环注入** | 新增纯 `normalizeQuick`（仅留已知 boolean 开关键）与 `normalizeNotifs`（id+数字 time、去重、保留合法字符串字段），NC 加载即归一化；文件补自环/互环父链下 pathOf/isInside/deleteEntries/moveEntry 不挂测试。 | `tsc --noEmit` 通过；`bun test` 237 passed / 0 failed（+3） |
| 2026-09 | **稳健性补全：设置写入口非对象护栏** | `setCloudPrefs`/`setAiConfig` 对非对象/数组/`null` 入参先归一为空对象再写（防展开产生伪键），补测试。 | `tsc --noEmit` 通过；`bun test` 238 passed / 0 failed（+1） |
| 2026-09 | **稳健性补全：文件搜索/排序极端输入 + 备忘录 CRLF** | 文件补测试：5000 条 filterByName/sortChildren/searchFiles 空查询不误扫、稳定排序不抛、空集安全；备忘录 CRLF 用结构断言（行数 3、解析/切换不抛）——避免覆盖率插桩对 `\r` 的边沿扰动。 | `tsc --noEmit` 通过；`coverage:gate` 240 tests、97.90% ≥ 90%（P2-1） |
| 2026-09 | **稳健性补全：闹钟持久化归一化 `normalizeAlarms`** | 新增纯 `normalizeAlarms`（无 id/缺数值时间丢弃、去重、时/分钳制、仅收合法 repeat 日并排序去重、非法 tone 回退默认、ringing 不还原）；Clock 加载先归一化再 `alarmInit`。含单测。 | `tsc --noEmit` 通过；`bun test` 241 passed / 0 failed（+1） |
| 2026-09 | **稳健性补全：地图越界缩放/平移注入** | maps 补 200 轮极值注入：反复 `clampZoom`(含 NaN) + `latLonToTile`(极区/超大经度) + 超远 `panTiles`，断言输出始终有限且纬度钳制 ≤90（元组 LatLon 解构）。 | `tsc --noEmit` 通过；`bun test` 242 passed / 0 failed（+1） |
| 2026-09 | **稳健性补全：计算器长链/左折叠/除零** | 补测试：99 项加法长链→100 无溢出噪声、**左到右即时折叠语义**（iOS 式实时总和，`2+3×4` 折叠为 `(2+3)×4=20`，非乘除优先）、连续除零冻结 ERR 后 C 恢复、`9÷3×0=0` 有限。 | `tsc --noEmit` 通过；`bun test` 全绿 |
| 2026-09 | **修复：秒表时钟回拨负值 + 计时器/有界极值** | 修复 stopwatch `tick/pause` 在系统时钟回拨时可能把 elapsed 算成负（现 `max(0)` 钳制）；补测试：回拨/超大跳变不出现负或 NaN、timer 巨量截止自动归 0、`fmtCountdown` 巨量仍 mm:ss；`capTail` 50000 项 + NaN cap 边缘。 | `tsc --noEmit` 通过；`bun test` 245 passed / 0 failed（+2） |
| 2026-09 | **真实语音 gated 构建（sherpa ASR + Piper TTS）** | `cargo build -p amos-tauri --features sherpa-asr,piper-tts` 成功（exit 0，模型 `models/sherpa-en-20m`/`piper-low` 就绪）；以 native 二进制 + 模型目录重启 UI。注：有一条 sherpa/piper 均内置 espeak 的重复符号 linker **警告**（非错误），实音轨需窗口内交互验证。 | `cargo build` exit 0；native UI 运行正常；`strings` 检出 sherpa 符号 |
| 2026-09 | **功能：备忘录链接** | `fmtInline` 支持 `[文字](https://…)` → `{url,link}` 段；Notes 只读行用 `<a target=_blank rel=noreferrer>` 渲染可点链接（仅 http(s)，mailto 等保持原文不链接，避免脚本面）。含单测（链接分片、非 http 不触发）。 | `tsc --noEmit` 通过；`bun test` 225 passed / 0 failed（+1） |
| 2026-09 | **测试基建：DOM 逐文件进程隔离 `bun-iso-test.mjs` + UI 交互测试合入** | bun 默认单进程共享 happy-dom 全局（新增 DOM 文件会确定性弄坏既有 DOM 套件）。新增 `scripts/bun-iso-test.mjs`：纯（非 DOM）文件一批一进程跑 + 每个 DOM 测试文件各自独立 `bun test` 进程；`package.json test/check/coverage:gate` 与 Makefile 接线（cov 只测纯批 `src/lib`）。基于此合入 `AiApp`（假 `__TAURI_INTERNALS__` 驱动 发问→token→卡片→完成/busy 生命周期）与 `InterpApp`（开始会话→`segment_final`→transcript、partial）两条 DOM 交互测试（直调内部 `onChange` 驱动受控 textarea——happy-dom 不触发合成 input 的 onChange）。 | `bun run check` exit 0；`bun run test` 253 pass / 0 fail（稳定 ×2）；`coverage:gate` src/lib 91.47% ≥ 90%；`tsc --noEmit` 通过 |
| 2026-09 | **修复：地图 `clampZoom(NaN)` 无兜底 + 计算器“左折叠”误导断言 + i18n 裸 key 守门** | ①`clampZoom` 对 NaN/±Inf 无守卫会穿透返回 NaN 污染缩放 → 补 `!Number.isFinite→3` 兜底 + ±Inf 回归断言；②计算器测试断言“2+3×4=14（优先级）”与实现的 iOS 式左折叠矛盾 → 改为 `=20` 并改名；③`t()` 接收任意 string、缺 key 会回退显示裸 key → 新增扫描全部 `t("…")` 字面量、断言均存在于中英文档的守门测试。 | `bun test` 245→247 passed / 0 failed；`make cov` 97.95%≥90% |
| 2026-09 | **修复：同传 transcript 无界增长（内存）** | `onInterpOutput` 在长会话里 `lines` 无上界 → 新增 `INTERP_LINE_CAP=200`（超界保最新尾）；回归测试灌 250 行断言长度恒 200、最旧逐出。 | `bun test` 247 passed / 0 failed（+1） |
| 2026-09 | **修复：通知存储无界渲染 + 朗读重叠播放** | ①`normalizeNotifs` 无长度上界（病态 store 每次全表渲染）→ `NOTIF_CAP=100` 保最新；②`realtimeTts.playPcm` 每段独立播放不停止上一段（连续 final 段会重叠出声）→ 跟踪 `activeSrc`，新段 `start()` 前 `stop()` 旧源（最新获胜），`resetPlayCtx` 同步清空；假 `AudioContext` 无头测试 3 条。 | `bun test` 251 passed / 0 failed（+4）；`tsc --noEmit` 通过 |
| 2026-09 | **UI 交互测试扩张（依托 DOM 逐文件隔离）** | 新增/扩展：`AiApp`（正常流式、daemon 离线不卡 busy、复制回答、↺ 重发、新建会话、清空二次确认）、`InterpApp`（transcript、结束会话、复制全部译文+双语开关）、`Segmented`、`VoiceMicButton`（① mic 记录生命周期无头：假 getUserMedia+AudioContext 驱动 录帧→release→transcribe→onTranscript）。假桥 = 真 `lib/backend` + `window.__TAURI_INTERNALS__`；受控输入经直调内部 `onChange`（happy-dom 不触发合成 input 的 onChange）；`beforeEach` 重装桥避免 afterEach 删除后同文件后续用例无桥。 | `bun run test` 258→266 pass / 0 fail；`tsc --noEmit` 通过 |
| 2026-09 | **功能：AI 会话工具集 + 同传复制** | AiApp：`ai.copyReply` 复制上条回答、`ai.resend` ↺ 重发（`send(force?)`）、`ai.newChat` 新建会话（`backend.newConversation()` 轮换多轮 id）、`ai.clearConfirm` 清空二次确认（3s 复位）。同传：`interp.bilingual` 双语开关 + `transcriptText(segs, includeSource)` 一键复制（纯函数，含源 `src → target` 双语 / 纯译文两种）。均含 i18n 中/英 + DOM 测试。 | `bun run test` 266 pass / 0 failed；`tsc --noEmit` 通过；`coverage:gate` ≥90%（纯批） |

| 2026-09 | **功能：AI daemon 会话管理（list/clear/remove）** | proto 增 `ListSessions`/`ClearSessions`/`RemoveSession`（自动 codegen）；server 实现（安全层→`SessionManager.list_active/clear_all/remove`，最近活动降序、上限 100）；bridge 命令 `get_ai_sessions`/`clear_ai_sessions`/`remove_ai_session` → TS `listSessions`/`clearSessions`/`removeSession` → AiApp「会话」面板（懒加载列表 + 逐行 ✕ 单删 + 清空全部）。 | `cargo test --workspace` 无 FAILED（含 wire e2e 真实 daemon list→clear→list=0、remove）；TS 278→279 pass / 0 fail（会话面板 DOM：列出、单删保兄弟、清空回空态）；clippy `-D warnings` 干净；tsc 通过 |
| 2026-09 | **功能：AI 会话历史（最小安全切片 + bidi 接入）** | `SessionMetadata` 增 `history: Vec<Turn>`（role/text），`StoredSession` 用 `#[serde(default)]` 向后兼容旧档；**两条聊天路径均写历史**：unary `stream_chat` 与 bidi `chat()` 都在单轮正常完成（非取消）收尾追加 user+assistant 回合（上限 200 丢最旧，卡片/出错/中断/音频占位不写）；新 RPC `GetHistory`（未知 NotFound）+ bridge `get_ai_session_history` + TS `getSessionHistory` + AiApp「会话」面板 …（历史）展开显示回合。 | `cargo test --workspace` 无 FAILED（含 wire e2e stream_chat→get_history 首回合 user、get_history/NotFound）；`cargo test -p amos-ai` 全过、clippy `-D warnings` 干净；TS 279→280 pass / 0 fail（会话面板历史展开 DOM）；tsc 通过 |
| 2026-09 | **修复（真机验收发现）：日历编辑重复场次显示错日期 + S5/Android 14 语义层验收** | 真机验收时的真实缺陷：`openEdit` 用**序列锚点** `event.startAt` 播种编辑器 ⇒ 点开日常重复在「今天」的场次却显示**昨天**（创建日）。真机复现：选中 `9月11日周五` 的 `09:00 团队同步`，编辑器「开始/结束」均为 `2026-09-10`。修复：`openEdit` 按**所点场次**（`occ.startAt/endAt`）播种；提交用新纯函数 `shiftByWallClock(base, from, to)`（`countDays` 整日 + 分钟差，**绝不裸毫秒**）把草稿相对该场次的位移同等施加到序列锚点——`from===to` 逐位恒等（改标题不漂移），非重复事件行为不变；编辑器增「重复日程：保存将修改整条序列」提示。 | `bun run check` **EXIT=0**（pure **948**/97、`test:svelte` **467**/59、`tsc` 0、`svelte-check` 0/0、i18n 奇偶）；`calendar.test` 49→**50**、`calendar.svelte.test` 32→**36**；**真机 S5/Android 14**：`uiautomator` 读 WebView 确认标题/星期表头/42 格日期/今日高亮正确，**打开 9/12 场次显示 `2026-09-12`（非锚点 9/11）**，周视图标题 `9月7日 – 9月13日` 与 7 日分区正确 |
| 2026-09 | **审计 + 补全：日历（第三轮）** | 安全关键式自审计：先补**可复现独立验证**、再关闭已记录的对齐缺口、并修**文档追溯漂移**。① **独立验证**：`calendar.test.ts` 增「独立暴力参考」用例（固定种子 PRNG，**2000 组**随机重复/窗口，与**不设快进/不设上限**的朴素枚举逐场全等 `toEqual`）——把「重复展开绝不丢场次」这条**曾出真实缺陷**（长于一个周期的重复事件被快进越过）的性质变为可回归检查；另做一次性 **30 000 例**扩展交叉比对、`normalize*` 幂等/不变量 **20 000 例**、`occurrencesByDay` **4 000 例**，均 **0 处不一致**（证据，非声称）。② **补全周视图**（此前 §6 列为未实现）：纯内核 `startOfWeek`/`weekDays`（与月网格**同一**区域首周日规则，逐日 `addDays` ⇒ DST 下恒 7 格不漂移）；UI 第三页签「周」= 7 日分区（今日高亮/计数/空态/复用 `eventRow`），‹ › **按周翻**、标题与 aria 随视图切换、中英 i18n 对称。③ **文档纠偏**：`docs/calendar.md` §5 的 `calendar.svelte.test.ts` 计数长期写 24、实际已 29（前轮补测未回填）——更正为实测并补周视图用例。 | `bun run check` **EXIT=0**（pure **947** 例 / 97 文件、`test:svelte` **463** 例 / 59 文件、`tsc` 0、`svelte-check` 0/0、i18n 奇偶）；`calendar.test` 46→**49**、`calendar.svelte.test` 29→**32**；`calendar.ts` **432/432**、`calendarCore.ts` **94/94** 插桩行全执行（lcov 无 `DA:*,0`）；`coverage:gate` 93.84% ≥ 90% |
| 2026-09 | **审计 + 补全：日历（第二轮）** | 逐行自审计后补全 5 项、修 5 处真实缺陷：① 新增 `allDayEnd`（幂等、支持**多天全天**，非午夜吸附次日、早于起点收敛单日）+ 编辑器「结束」日期常显（显示含末日、提交 +1 天转半开、`openEdit` 反向 −1 天）；② `occurrencesOnDay`/`atLocalTime` 改用日期运算（`addDays`/`setHours`）——修复**夏令时日把次日全天事件错算今天**；③ 新增有界 `occurrencesByDay`（多天事件在**覆盖的每一天**打点）；④ 新增 `isContinuation`/`spansDays` + 「延续」文案——多天事件在后续日期显示 `→ HH:MM` 而非昨天的开始时间；⑤ 首周日跟随区域（zh 周一 / en 周日）；⑥ 删除死代码 `startOfNextMonth`、UI 改调已测试的 `reassignOrphans`、`appMeta` 陈旧注释 23→25；⑦ **提醒管线坏档修复**（`calendarCore` + `reminderCore` 均对既有通知跑 `normalizeNotifs`，否则非数组坏档令到点提醒**永久静默失效**）。 | `bun run check` 全绿（`tsc` 0、`svelte-check` 0/0、pure **874** 例、`test:svelte` **403** 例）；`calendar.test` 34→**44**、`calendarCore.test` 15→**16**、`calendar.svelte.test` 19→**24**、`shell.svelte.test` **+1**（真实挂载日历屏）、`reminderNotify.test` **+1**；`calendar.ts` 412/412、`calendarCore.ts` 94/94（**100%**）；`coverage:gate` 94.83% ≥ 90%；`smoke:ui` 4/4 |
| 2026-09 | **功能：日历（iOS 对齐）** | 新增第 25 个内置应用「日历」。纯内核 `lib/calendar.ts`（事件/彩色日历、本地时区日期运算、6×7 月网格、**有界重复展开**含快进与 `MAX_OCCURRENCES_PER_EVENT` 防死循环、选择器、CRUD、坏档归一化、`EVENT_CAP` 封顶）；`lib/calendarCore.ts` + `svelte/osCalendarWatcher.ts` 提供 OS 级到点提醒（`now−Grace ≤ alertAt ≤ now`、隐藏日历静音、`事件id@场次` 幂等标记、`pruneFired` 有界）；`svelte/CalendarApp.svelte` 提供月/日程双视图、42 格月历、彩色圆点、选中日日程、搜索、日历管理与事件编辑器（全天文/重复/提醒/地点/备注），中英 i18n + 无障碍角色；注册三处单源（`appMeta`=25 / `appRegistry` / `appGroups`）。 | `bun run check` 全绿（`tsc` 0、`svelte-check` 0/0、pure **863** 例、`test:svelte` **397** 例）；新增 `calendar.test.ts` 34 + `calendarCore.test.ts` 15 + `calendar.svelte.test.ts` 19；`calendar.ts`/`calendarCore.ts` 行覆盖 **100%**，`src/lib` 聚合 **94.83% ≥ 90%**（`docs/calendar.md`） |

*说明：P0-3 为"未采集必须如实上报 `None`"，属诚实化整改；真实 GPU/令牌采集属后续功能增强，可在新的 P 项中单列。*

## 9. P1-6 核查结果：`loop {}` 终止性（16 处，只读审计）

逐一确认：**不存在无界忙等（busy-spin）**；所有 `loop` 要么有显式退出，要么是进程生命周期内的定时/事件驱动任务（由 runtime/信号终止）。

| 位置 | 性质 | 终止条件 / 判定 |
|---|---|---|
| `amos-int-cli/src/lib.rs:203` | REPL 读 stdin | EOF 或 `.exit` → 有界；交互式按设计运行至 EOF ✅ |
| `amos-tauri/ai_bridge.rs:94` ask_daemon | 重连 | 成功 `break`；失败 `attempt>=2` 返回 Err（有界）✅ |
| `…/ai_bridge.rs:215` fetch_status | 重连 | 同上，attempt 上限 2 ✅ |
| `…/ai_bridge.rs:423/459/500` 安卓命令 | 重连 | 同上，attempt 上限 2 ✅ |
| `amos-supervisor/src/bin/*.rs:85` | 前台监督 | `ctrl_c`→break；SIGUSR1→continue（进程生命周期，信号终止）✅ |
| `amos-supervisor/src/lib.rs:237` monitor | 守护 | stop / 重启预算耗尽 / spawn 失败 → `return`（有界）✅ |
| `amos-ai/tests/hermes_e2e.rs:126` | 读 HTTP 头 | 读到 `\r\n\r\n` 或 `n==0`→`None` ✅（测试助手） |
| `amos-ai/session.rs:215` cleanup | 定时清理 | 进程生命周期，interval 驱动，无忙等；随 daemon 关闭 abort ✅ |
| `amos-ai/security.rs:417` cleanup | 定时清理 | 同上 ✅ |
| `amos-ai/server.rs:388` 'outer | gRPC 流 | `in_rx` 收到 `None`（客户端半关）→ break；各分支 `continue` 有界 ✅ |
| `amos-ai/server.rs:454` token 内层 | 推理流 | `stream.next()` 返回 `None`/发送失败 → break ✅ |
| `amos-ai/inference/real.rs:471` | 读 SSE | `read_line==0`（EOF）→ break ✅ |
| `amos-ai/inference/real.rs:1170` | 读测试请求头 | `read_line==0` 或空行 → break ✅（测试） |
| `amos-android/src/manager.rs:259` | 优雅停机等待 | `active==0`→Ok 或 `>deadline`→Err（有界）✅ |

**结论**：P1-6 无需代码整改；若未来新增“重连/重试”类循环，要求复制既有模式（显式 `attempt` 上限 + 睡眠退避），并保留本表作为可追溯记录。

---

*本报告由代码审计工具自动采集证据生成，引用行号以报告日期版本为准；后续代码变动可能使部分行号漂移。*






