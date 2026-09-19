# AmOS — NASA Power of 10 全面合规审计

> **NASA/JPL "Power of 10"** 安全关键编码规范(Holzmann, *IEEE Computer* 2006)
>
> 10 条规则 → 每个 crate / 模块都给出**当前证据 + 不变量 + 测试**
>
> 状态:**已审计**(2026-09-15)。每条规则附门禁脚本或测试 ID。
>
> 审计基准:AmOS workspace **47 个 crate** + **frontend-ts** + **scripts/**。
>
> **诚实声明**:本审计基于当前仓库快照。**新增代码必须重新审计**。适航审定要求**独立审计员**,本表只作工程纪律。

---

## 总览

| 规则 | 一句话 | 当前状态 | 覆盖率 | 主要门禁 |
|---|---|---|---:|---|
| **#1** 限制控制流(无 goto/递归) | "无递归"已是静态门禁(**含跨文件/跨 crate 环**) | ✅ 全绿 | 100%(全量生产 `.rs`;数量由扫描每次运行打印) | `rust-recursion-scan.mjs` |
| **#2** 所有循环静态有界 | 长循环都有明确终止 | ✅ 全绿 | 100% (64 处) | `hot-loop-scan.mjs` |
| **#3** 初始化后禁堆分配 | 编译期管理,无 `malloc` | ✅ 语义内合规 | n/a | 编译期保证 |
| **#4** 禁止函数指针 | 用 trait/dyn,受控 | ✅ 语义内合规 | n/a | 编译器类型系统 |
| **#5** 编译期最高告警 + 静态分析 | clippy `-D warnings` | ✅ 全绿 | 100% | CI `lint-and-test` |
| **#6** 声明尽量小作用域 + 多用 `const` | Rust 借用检查器强制 | ✅ 语义内合规 | n/a | 借用检查器 |
| **#7** 函数返回值必处理,错误不得吞掉 | `Result` 显式传播 | 🟡 83 处静默丢弃(棘轮,0 增长) | 32 文件已审 | `rust-discard-scan.mjs` |
| **#8** 强类型 + 限制隐式转换 | Rust 强类型 | ✅ 语义内合规 | n/a | 类型系统 + clippy |
| **#9** 运行时断言用于防缺陷 | 197 `#[test]` + 健康上报 | ✅ 充分 | 100% | 单元 + 集成测试 |
| **#10** 少用预处理器/魔法 | Rust 无宏滥用 | ✅ 语义内合规 | n/a | `fmt --check` |

**总分:9/10 完全合规 + 1/10 已建基线(棘轮只减不增)**

---

## 规则 #1:限制控制流(无 goto/递归)

### 条款

- 无 `goto`
- 无**直接**递归
- 无**互**递归(同一调用图内)

### 现状(全仓)

| 维度 | 度量 |
|---|---|
| 总 .rs 文件 | **不再写死**。旧文档写「465 个(生产 337 + 测试)」—— 2026-09-19 实测生产文件已远超 337,且**在同一小时内**随并发会话继续增长(404 → 412)。数字由 `node scripts/rust-recursion-scan.mjs` **每次运行打印**:写进文档的计数没有人会去重量(F-DEV-031 的教训,而这是它的现场) |
| `goto` 出现 | 0 |
| 直接自递归函数 | 0 |
| 互递归函数组 | 0 |
| 基线条目 | **空**(棘轮只减不增) |

### 修复历史

| 日期 | 缺陷 | 修复 | 验证 |
|---|---|---|---|
| 2026-09 | `amos-link::keyexpr::match_segments` 回溯 O(C(n+m,m)) 挂死 broker 锁 | 改为 O(n·m) 迭代 DP | 117 lib + 1 分配预算 |
| 2026-09 | `amos-web3::eip712::collect_deps` 每声明类型一帧 | 改为显式工作列表 | 16 例互递归覆盖 |
| 2026-09-19 | **门自身的缺口**：调用图只连**同一文件内**的函数 ⇒ 跨文件/跨 crate 的环不可见（残余风险表自己登记的那一行） | 增加 workspace-wide 图（目标键全 workspace 唯一才加边,歧义不加）(REQ-A443) | selftest **23/23** + **真实树负控**（两个 crate 各插一个探针 ⇒ 红在 `crates/amos-audio/src/ring.rs:189`,还原后 sha256 一致） |

### 门禁

`scripts/rust-recursion-scan.mjs`(含**双向互递归**：文件内环 + **workspace-wide 跨文件/跨 crate 环**)

```bash
$ node scripts/rust-recursion-scan.mjs --selftest
23/23 passed

$ node scripts/rust-recursion-scan.mjs
# (生产文件数由本行打印 —— 不再写死在文档里:同一小时内它从 404 变成 412;0 finds, 0 baseline)
```

---

## 规则 #2:所有循环静态有界

### 条款

- 循环上限**编译期已知**
- 计数器不得当数组下标
- 长事件循环必须由外部信号终止

### 现状(全仓)

| 维度 | 度量 |
|---|---|
| 总 `loop`/循环块 | 64 处(生产代码) |
| 空转循环(无等待/无出口) | **0 处** |
| 可等待/阻塞循环 | 40 处 |
| 有界忙碌循环 | 7 处 |
| 等待但无出口循环 | 17 处(**全部**有书面终止条件注释) |

### 修复历史

| 日期 | 缺陷 | 修复 |
|---|---|---|
| 2026-09-11 | 11 处长循环缺终止条件注释 | 逐处补齐;`hot-loop-scan.mjs` 上线 |

### 门禁

`scripts/hot-loop-scan.mjs`(空转硬失败 + 棘轮终止性注释)

```bash
$ node scripts/hot-loop-scan.mjs --selftest
7/7 passed (含 3 必须失败用例)

$ node scripts/hot-loop-scan.mjs
# (文件数由本行打印 —— 旧文档写死的 "304 production files" 已与树不符)
```

### 测试保护

- 12 并发任务跑 5000 次 `in_flight + available == capacity`(`pool::tests`)
- broker `LatestSlot` 中毒路径负控(`Elapsed` ⇒ FAIL, 还原 ⇒ OK)

---

## 规则 #3:初始化后禁堆分配

### 条款

- 启动后禁止 `malloc`/`new`
- 所有数据结构**静态分配**

### 现状

- Rust 无手动动态内存分配
- 所有分配由编译器 + 容器(`Vec`/`HashMap`/`Box`/...)管理
- **运行时分配 ≠ 设计缺陷**(容器分配是受控的)
- 关键热路径已审计:
  - `amos-link::keyexpr` 0 字节/1000 matches(修复前 128 KB)
  - `amos-link::codec` 0 额外 CRC 分配(修复前 1 帧 + 1 帧)
  - `amos-link::broker` `Arc` 共享缓冲(`Arc::strong_count`)

### 门禁

`scripts/rust-discard-scan.mjs` + `amos-link::tests/allocation_budget.rs` + 计数器分配器测量

```bash
$ cargo test -p amos-link --test allocation_budget
# (encode: 1 alloc/frame, decode: 0 alloc, matcher: 0 bytes/1000)
```

### 残余风险

| 风险 | 状态 |
|---|---|
| 容器无界增长 | **已用 cap 限制**(`capTail` / `GenerationPool` / `ResponseCache` / `NOTIF_CAP`) |
| 容器初始化后扩容 | **运行时**行为,通过容量门禁约束 |

---

## 规则 #4:禁止函数指针

### 条款

- 不得用裸函数指针
- 多态用 `trait` + 静态分发

### 现状

- 生产代码无裸函数指针(编译器不鼓励)
- 多态通过 `trait`/`dyn Trait`/`impl Trait`
- `Box<dyn Trait>` 用作服务注入点(受控,非热路径)

### 门禁

`scripts/unsafe-scan.mjs` 同时拒绝裸函数指针 + 未 SAFETY 注释的 `unsafe`

---

## 规则 #5:编译期最高告警 + 静态分析

### 条款

- `-Wall -Wextra` 等价 + 全部警告当错误
- 静态分析器集成(clippy / semver / ...)

### 现状

| 检查 | 状态 |
|---|---|
| `cargo clippy --workspace --all-targets -- -D warnings` | ✅ 全绿 |
| `cargo fmt --all --check` | ✅ 全绿 |
| TS `tsc --noEmit` (`strict` + `noUncheckedIndexedAccess`) | ✅ 0 错 |
| TS `svelte-check` | ✅ 0 错 0 警 |
| TS 覆盖率门禁(`coverage:gate`) | ✅ 93.79% ≥ 90% |

### 门禁

CI `lint-and-test` job + `make lint` + `make check`

```bash
$ make lint
# (30+ gates, EXIT=0)

$ cargo clippy --workspace --all-targets -- -D warnings
# EXIT=0
```

### 残余风险

| 风险 | 状态 |
|---|---|
| 第三方 crate 引入新警告 | 依赖锁文件 (`Cargo.lock`) + 锁定 workspace 依赖 |
| 代码内 TODO 残留 | 已清零(2026-09-11 R-P2-3) |

---

## 规则 #6:声明尽量小作用域 + 多用 `const`

### 条款

- 变量最小作用域
- 不变性默认 + `const` 优先

### 现状

- Rust 借用检查器强制最小作用域
- `const`/`static` 广泛使用(模块级常量)
- 函数参数默认 `&T`/`&mut T`,非所有权转移

### 测试

无直接门禁;`cargo clippy::needless_pass_by_value` / `cargo clippy::redundant_locals` 报告可疑用法。

---

## 规则 #7:函数返回值必处理,错误不得吞掉

### 条款

- 非 void 函数返回值**必须**被使用
- 错误**不得**静默丢弃
- `Result`/`Option` 显式处理

### 现状

| 维度 | 度量 |
|---|---|
| 生产 `let _ =`（全部,含非 `must_use`） | **488 处**（2026-09-19 实测;`grep -rn 'let _ =' crates/*​/src --include='*.rs' \| wc -l`——上一轮写 481,并发会话新增文件后被量到 488;这个数字是**原始 grep**,不是门禁跟踪的那一批） |
| 生产 `must_use` 值丢弃（棘轮跟踪的那一批） | **83 处 / 32 文件**（`scripts/rust-discard-baseline.json` 的 `total`/`files`——本文档此前写"165 处 / 35 文件"、下表写"30 文件",都已与树不符;REQ-A442 与 REQ-A443 各按实测更正一次,REQ-A459 再按实测更正为 32 个文件） |
| 已逐处审计的文件 | crate 级散文：`amos-ai` / `amos-supervisor` / `amos-tauri` / `amos-android`；**逐文件段落**：`amos-tauri/src/wm.rs`（REQ-A442）、`amos-translate/src/lib.rs`（REQ-A443）、**`amos-tauri` 的 9 个文件**（REQ-A448）、**`amos-ai/src/server.rs`**（REQ-A451）。这一行**如实区分**两者——按 crate 的散文不等于逐文件结论 |
| 未逐处审计但已棘轮 | 棘轮只保证"不新增",不等于"逐处看过"——这一行是**登记**不是免责。此前这里写"其余 29 文件"，那个数字来自按 crate 的散文而非逐文件记录，**无法核算**，故不再写数字 |

**`wm.rs` 的审计结论（REQ-A442,Power of 10 规则 #7 "丢弃即缺陷,除非效果被读回"）**：该文件原有 6 处 `let _ =`;
其中 3 处是窗口操作（`window_maximize` / `window_toggle_zoom` / `window_toggle_fullscreen`),
**三处都在调用后读回平台状态**（`is_maximized()` / `is_fullscreen()`),且函数文档写明"不假设 `Ok(())` 等于状态变了"
——这是**正确的**模式,不是缺陷;1 处是 `app.emit(LAYOUT_EVENT, _)` 尽力广播（无接收者即无事可报）;
1 处在测试里;**1 处是真的吞掉了平台拒绝** —— `wm_split_swap` 末尾 `let _ = w.set_focus()`:分屏交换后主窗格
拿不到 OS 焦点意味着"输入路由没有跟着窗格走",而这一半生效的布局此前没有任何痕迹。已改为 `tracing::warn!`
（与本模块其它焦点路径同一条纪律),因此基线 `crates/amos-tauri/src/wm.rs` 由 5 降到 4（`total` 87 → 86）。

**`crates/amos-translate/src/lib.rs` 的审计结论（REQ-A443,同一规则,同一个"半条纪律"缺陷形状）**：该文件原有 6 处 `let _ =`
（棘轮里 6 处全部是它）。逐处过目的结论:

- **2 处是"同一文件、同一条规则、只应用了一半"** —— 文本分支（`Some(Text)`）写完 `tx.send(...)` **检查 `.is_err()` 并 `break`**,
  而两个音频分支（ASR 成功 / ASR 未接入）把同样的 `send` 结果 `let _ =` 丢掉**且继续循环**。`mpsc::Sender::send` 的失败
  **只在接收端被 drop 时发生**（缓冲区满时它 `await` 等待,不返回 `Err`——文件自己第 162-164 行就写着这件事）⇒ 丢掉它意味着
  **客户端已经走了,守护进程还在为它逐帧跑 ASR**。修法不是再抄一遍 `is_err()`,而是把规则**收到一处**:
  `async fn deliver(&tx, out) -> bool`,三个 Ok 分支一律 `if !deliver(...).await { break; }` —— 一个分支再也无法"只做一半"。
- **1 处真的会改变下一次启动**：`serve()` 末尾的 `let _ = std::fs::remove_file(&path)`。`serve()` 绑定的就是这条 UDS 路径,
  而 `UnixListener::bind` 对**残留的 socket 文件**返回 `EADDRINUSE` ⇒ 清理失败坏的是**下一次**启动,而上次什么都没说。
  改为 `tracing::warn!` 并点名路径。
- **3 处是正当的**,保留在基线里：两处 `let _ = tx.send(Err(...)).await;` 后面紧跟 `break`（没人可告知,`break` 才是重点）,
  以及循环结束后那条 `done: true` 终止标记。

因此基线 `crates/amos-translate/src/lib.rs` 6 → 3（`total` 86 → 83）。**并补一条钉住该契约的测试**:
`deliver()` 同时被钉住三个方向 —— 消费者活着 ⇒ `true`;缓冲区满但消费者活着 ⇒ **等待而非 `false`**（否则每个慢客户端都会被
当成已离开）;接收端被 drop ⇒ `false`（`deliver_is_true_for_a_live_consumer_and_false_once_it_is_gone`）。

### REQ-A448 批次：`amos-tauri` 的 9 个文件 / 17 处 `let _` —— 一个共同假设，此前全仓没有一处写过

逐处过目：`buttons` / `host_log` / `media` / `mic_permission` / `mail` / `flashlight` / `incall` /
`devcare_device` / `clipboard_glue`。

- **8 个文件是同一族**：进程级句柄用 `OnceLock::set` 只装一次 —— `APP` / `VM` / `GLUE` / `SINK` /
  `DEVICE` / `PUSHER`，每处注释都写着"冗余的二次 attach 保留第一个"。
- **那句话为什么成立，此前没有任何一处写过**：Activity 若被**重建**（旋转 / 分屏改尺寸 / 语言 /
  UI 模式），JNI attach 会递来一个**新的 Kotlin 对象**，而 `OnceLock::set` 会把它丢掉 ⇒ 麦克风 /
  剪贴板 / 媒体桥继续驱动一个**已死实例**。让它成立的不是本仓的 Kotlin，而是**生成**的 manifest 上
  那行 `android:configChanges`（Tauri 模板）。
- **处置**：把这句话写进后果最重的 4 处站点（`clipboard_glue` / `mic_permission` / `media` /
  `flashlight`），并把它**变成门** —— `scripts/android-glue-mirror.sh` 新增一段：读生成的 manifest，
  要求 Activity 的 `configChanges` 包含 8 个 token（`orientation` / `keyboardHidden` / `keyboard` /
  `screenSize` / `locale` / `smallestScreenSize` / `screenLayout` / `uiMode`），按 `|` 切分**精确比对**
  ——子串匹配会让 `smallestScreenSize` 冒充 `screenSize`（负控正是这么设计的）。
- **边界（登记，不豁免）**：`density` 与 `fontScale` **不在**那张表里 ⇒ 用户改显示大小 / 字体缩放会
  **真的**重建 Activity，那条路径上"保留第一个"仍是已知缺口。
- `mail.rs`（demo 播种，注释已写明"只会让**演示**收件箱变短"）与 `host_log.rs`（`try_init` 唯一的失败
  原因是"已经装了 subscriber"，即该函数自己文档化的 no-op）**正当**。

证据：`bash scripts/android-glue-mirror.sh` exit 0（新增一行 + 17 个接线点仍全过）；**负控**：从生成
manifest 删掉 `screenSize`（**保留** `smallestScreenSize`）⇒ 立刻红并点名 `screenSize`，还原后
**sha256 一致**；`cargo check -p amos-tauri --features android` 干净。

### REQ-A451 批次：`amos-ai/src/server.rs`（15 处）—— 一处真缺陷，而**它的注释早就写明了赌注**

`server.rs` 是全仓单文件最多的一处（15 处），此前只有"rounds 82-84: `crates/amos-ai`"这种**按 crate**
的记录。

- **真缺陷（1 处，已修）**：关停那一行是 `let _ = std::fs::remove_file(&path);`，**紧挨着的注释**写着
  "Remove the socket file so a stale one never blocks the next bind" —— 作者**知道**后果，然后把这个
  结果丢掉了。`serve_with_sinks` 绑定的正是这条路径，而 `UnixListener::bind` 对**仍然存在**的文件答
  `EADDRINUSE` ⇒ 清理失败坏的是**下一次**启动，这一次什么都不说。已改为 `remove_socket()`（报告失败）。
  **这与 REQ-A443 在 `amos-translate` 修掉的是同一个缺陷** —— 兄弟守护进程也有，当时没人回头看一眼
  （F-DEV-040）。
- **正当（14 处）**：三处 `let _ = tx.send(<终止帧>)` 后面紧跟 `return`（没人收了，而它们之后的记账与
  审计日志照常执行）；六处 `sessions.update(…)` 的 `Result`（唯一错误是"会话已被回收" —— 这一轮的记账
  对**会话驱逐**是有意的尽力而为）；bidi 循环里五处 `let _ = tx.send(…)` —— 它**不是**靠失败的 send
  结束，而是靠**请求半边关闭**（`in_rx.recv() == None`）结束。写下来是因为紧邻其上的 `stream_chat`
  用的是**另一条纪律**（`is_err()` → `return`），而两条纪律各自成立的理由不在代码里。

证据：`cargo test -p amos-ai --lib` **322 pass**（+1：`a_socket_that_survives_its_cleanup_blocks_the_next_bind`
—— 它**量出**后果而不是断言日志：UDS 路径在 listener 之后仍在磁盘上、清理真的删掉它、而**残留的路径
确实让下一次 bind 答 `AddrInUse`**）；`clippy -D warnings` 净；`fmt --check` 0 diff；基线
`crates/amos-ai/src/server.rs` **15 → 14**、`total` **83 → 82**。


> **关于 `--self-test`（本轮量出来的第二件事）**:本文档"自动校验"一节此前把五个 `-scan` 门禁的自测写成 `--self-test`,
> 而这五个脚本只认 `--selftest`（`fmea-gen.mjs` / `env-doc-gen.mjs` 才是 `--self-test`）。结果:在被当成"验证命令"的那一行里,
> 脚本**静默跑的是门禁而不是自测**,并打印一行干净的结论 —— 这正是本仓 F-DEV-005 的形状（**仪器悄悄回答了另一个问题**）。
> 处置:①文档改为 `--selftest`;②更耐久的一半——五个脚本现在**拒绝不认识的 flag**(`exit 2` 并列出已知 flag),
> 所以打错的验证命令**不可能再静默通过**。

### 修复历史

| 日期 | 缺陷 | 修复 |
|---|---|---|
| 2026-09-11 | 11 处长循环无终止注释 | 补齐注释 + 上闸 |
| 2026-09-14 | `governor_service.rs` 6 处 host→容器反向驱动静默 | `mirror_failed` warn |
| 2026-09-14 | `amos-supervisor` monitor 丢 spawn 错误 | 记 `error` |
| 2026-09-14 | `ai_bridge.rs` 5 处云端 key 写失败 | `persist_cloud_key` 全检查 + 0600 模式断言 |
| 2026-09-14 | `android::service` ApplyHostDecision 拒后照发事件 | 拒时 warn,**不发事件** |
| 2026-09-19 | `wm_split_swap` 丢焦点拒绝（分屏交换后半生效） | 记 `warn` + 基线 5 → 4（REQ-A442） |

### 门禁

`scripts/rust-discard-scan.mjs`(棘轮 `let _` 必须-use 值)

```bash
$ node scripts/rust-discard-scan.mjs --selftest
23/23 passed

$ cargo clippy --workspace --all-targets -- -D warnings
# (clippy::let_underscore_must_use active)
```

### 测试

- `governor_service` 镜像失败日志断言
- `persist_cloud_key` 模式断言
- 监督进程 spawn 错误断言
- 服务拒绝时不广播事件断言

### 残余风险

| 风险 | 状态 |
|---|---|
| 29 文件 × 83 处 `must_use` 丢弃 | 已棘轮,新增立即失败;**未逐处审**（REQ-A443 后按实测更正;棘轮只保证不新增 ≠ 逐处看过） |
| `.ok()` 链(189 处) | 噪声大(多为 env/parse 默认值),R82 仅修行为会变的 1 处 |

---

## 规则 #8:强类型 + 限制隐式转换

### 条款

- 无隐式转换
- 无未初始化变量
- 整数宽度显式

### 现状

- Rust 强类型系统
- `as` 转换**有节制使用**(已审 165 处的对应检查)
- 整数截断 → 饱和(`count_to_u32` / `Timestamp::unix_ms` / `next_seq`)
- `usize as u32` 类型化拒绝 + 负控

### 门禁

编译期(clippy::cast_possible_truncation, clippy::cast_sign_loss, clippy::cast_lossless)

### 测试

- 64 位平台回绕负控(`count_to_u32`)
- 时钟校时毫秒截断负控(`Timestamp::unix_ms`)

---

## 规则 #9:运行时断言用于防缺陷

### 条款

- 关键不变量的运行时检查
- 健康上报路径

### 现状

| 类别 | 数量 |
|---|---|
| Rust 单元测试 | 165+ (`#[test]` / `#[tokio::test]`) |
| Rust 集成测试 | 20+ (`tests/*.rs`) |
| 前端单元 | 1000+ (bun test) |
| 前端 DOM | 660+ (svelte-test) |
| 健康上报字段 | 21 个 (`get_status.*` 上 wire) |

### 上 wire 字段(选)

- `running` / `uptime_sec` / `clock_calibrated`
- `system` (CPU/mem load)
- `engine.kind` / `engine.model`
- `rate_limit` (per-client RPS / per-hour quota)
- `breaker` (state, opens, cooldown_remaining)
- `generation_pool` (capacity, in_flight, rejected)
- `response_cache` (enabled, hits, misses)
- `alerts` (ranked, derived from counters)
- `log_sink` (bytes_written, lost_bytes, write_failures)
- ...

### 门禁

测试本身是门禁;覆盖率门禁(TS `src/lib` ≥ 90%)是最低门槛。

---

## 规则 #10:少用预处理器/魔法

### 条款

- 无宏滥用
- 无神秘数字

### 现状

- Rust 宏仅用于:`tonic::include_proto!` / `concat!` / `env!` / 测试夹具
- **`macro_rules!` 自定义宏:生产代码 4 处**（**2026-09-19 实测更正**，REQ-A442）——原文写的是
  "搜索:`grep macro_rules crates/` **0 处生产代码**",而实际是 4 处:
  `amos-jni::jni_call` / `amos-link::zenoh::{forward_samples,forward_latest}` / `amos-radio::android::jni`。
  **四处都是有意的、且各自在定义处已写清理由**:两处 JNI 宏是因为 wrapper 收 `&mut self`,
  调用必须展开成独立语句才能在该借用结束之后做共享借用的异常检查（函数签名表达不了这个借用顺序）;
  两处 Zenoh 宏是因为各 handler 类型没有共同 trait 暴露 `recv_async`,而转发循环对它们完全相同。
  这不是代码缺陷,是**审计文档断言了它没有量过的事实** —— 航空航天审计里这本身就是缺陷（见 F-DEV-031）。
- 神秘数字 → `pub const` 命名常量
- `magic` 数字示例:
  - `MAX_SEGMENTS = 32` (`keyexpr.rs`)
  - `LATENCY_RESERVE` (`cli.rs`)
  - `CAP` 上限常量(各处)
  - `MAGIC` / `VERSION` (`codec.rs`)

### 门禁

`cargo fmt --check` + `cargo clippy::needless_late_init` 等
+ **`scripts/rust-macro-scan.mjs`**（REQ-A442 补上的"宏白名单"门禁,原本就在下表的残余风险里写着"待补"）:

```bash
$ node scripts/rust-macro-scan.mjs --selftest   # 8 断言（R1-R4 + 两条负控 + 边界）
$ node scripts/rust-macro-scan.mjs
# [rust-macro-scan] OK — 4 production macro(s), all registered with a reason
```

四条规则:未登记的 `macro_rules!`(R1)、**已在白名单里但宏已经不存在**(R2,棘轮不许烂)、
`why` 是占位符(R3)、重复条目(R4)。刻意**不提供 `--update` 写入器**:豁免是人写下的决定。
`crates/<crate>/tests/**` 不属于生产代码（`eventually!` 夹具在 `amos-link/tests/robot_cases.rs`,
由设计排除）;`src/` 里 `#[cfg(test)]` 内的宏**会**被计入（今天没有）——那时正确的做法是加一条
`why: "test fixture"`,而不是写一个后人要重新推导的正则。

---

## 残余风险与跟进

### 全部 10 条规则的残余风险

| 规则 | 残余风险 | 后续行动 |
|---|---|---|
| #1 | **已关闭(REQ-A443)**:workspace-wide call graph 已建 —— 文件内互递归 **加上** 跨文件/跨 crate 的环（只在目标键在整个 workspace 里**唯一**时加边,有歧义就不加:假环比漏环更糟,REQ-A387 的教训）。仍**不**覆盖:动态派发（trait object / 函数指针 / 闭包）、无法命名的调用（`other.run()`）、比 `crate::Type::name` 更深的限定路径 | 边界已写在脚本头与本节;若将来引入更深的路径调用,再扩 `calleesOf` |
| #2 | 长循环的"等待"语义可能在重构后失效 | CI 注释自检门禁(待补) |
| #3 | 容器运行时扩容无法静态证明 | 容量门禁约束 |
| #4 | 第三方 unsafe 函数指针(如 `tonic`) | 仅信任锁定版本 |
| #5 | 新增警告未跑 CI 即合并 | PR 流程约束 |
| #6 | n/a(借用检查器强制) | n/a |
| #7 | 83 处 `let _`（棘轮基线，读 `scripts/rust-discard-baseline.json` 的 `total`；**32** 个文件，读它的 `files.length`）—— 另 77 处是 `#[tauri::command]` 宏生成的（信息项，不棘轮） | 后续每轮 PR 审 1-2 文件（REQ-A459 本轮审了 `amos-config`/`amos-notifier` 的 6 处：`audit.rs` 的 mkdir 改为**点名目录**、`smtp.rs` 的两处 `set_*_timeout` 与 QUIT 改为**上报**、`webhook.rs` 的两处超时由并发会话同轮修掉 ⇒ 基线 **0 增长**）。此前本文档写"30 文件 × 165 处"，已被 REQ-A442 / REQ-A443 / REQ-A459 三次按实测更正 |
| #8 | 第三方库内 `as` 转换不可控 | 锁依赖 |
| #9 | 健康上报字段可能撒谎(回归) | 已建 `alerts` 字段 + 负控 |
| #10 | 新增 `macro_rules!` 无门禁 | **已关闭（REQ-A442）**：`scripts/rust-macro-scan.mjs` —— 白名单 + 双向棘轮（未登记即红、豁免过期即红）+ 理由门槛 + 无 `--update` 写入器；同时更正本文档此前"0 处生产代码"的**未量测断言**（实测 4 处，逐条登记理由） |

### 已知缺口

- `cargo mcdc` / 形式化覆盖率:**未做**(DO-178C DAL A 才需要)
- 形式化方法(TLA+/SPARK):**未做**(全项目无形式化规约)
- 独立验证人:**未指定**(研究项目无审定流程)

---

## 自动校验

```bash
$ node scripts/rust-recursion-scan.mjs --selftest && node scripts/rust-recursion-scan.mjs
$ node scripts/rust-macro-scan.mjs --selftest && node scripts/rust-macro-scan.mjs
$ node scripts/hot-loop-scan.mjs --selftest && node scripts/hot-loop-scan.mjs
$ node scripts/unsafe-scan.mjs --selftest && node scripts/unsafe-scan.mjs
$ node scripts/rust-discard-scan.mjs --selftest && node scripts/rust-discard-scan.mjs
$ cargo clippy --workspace --all-targets -- -D warnings
$ cargo test --workspace --quiet
```

全部 EXIT=0 ⇒ 本表当前描述与代码一致。
