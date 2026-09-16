# 机器人应用案例目录（AmOS 机器人的「能干什么」清单）

> 这份文档回答一个具体问题：**AmOS 的机器人中间件到底撑得起哪些应用？**
> 每个案例都是一个**可运行、可测试**的程序（`crates/amos-link/examples/` + `tests/robot_cases.rs`），
> 用的是**出货代码路径**——同一个 broker、同一套帧格式、同一份 QoS 表、同一个 `RobotBridge`
> 安全层、同一个控制面。案例里没有"演示用的假中间件"。
>
> 与本文配套：`docs/amos-link.md`（设计记录：分层、Zenoh 审计、控制面、非目标），
> `crates/amos-link/README.md`（crate 级入口与诚实边界），`proto/robot_link.proto`（控制面契约）。

## 1. 案例总览

| # | 应用 | 拓扑 | 例子 | 案例级测试 |
|---|---|---|---|---|
| ① | **巡检任务**（一条完整控制闭环） | 1 台机器人 + 1 个现场服务器 | `cargo run -p amos-link --example patrol_mission` | `case_1_*`（4 例） |
| ② | **机群监督台**（多机、只读测量） | 3 台机器人 + 1 个监督台 | `cargo run -p amos-link --example fleet_console` | `case_2_*`（3 例） |
| ③ | **不在链路上的大脑**（控制面） | 1 台机器人 + 1 个 gRPC 调用方 | `cargo run -p amos-link --example remote_brain` | `case_3_*`（2 例） |
| ④ | **仿真之外的第一次上电**（真字节流 HAL） | 1 台机器人 + 一条真描述符 | `cargo test -p amos-link --test hardware_hal` | 该文件 6 例 |
| ⑤ | **线缆上的恶意帧**（信任边界） | 两个真 peer | `cargo test -p amos-link --test link_e2e` | 该文件 5 例 |

案例 ①–③ 是本轮新增；④⑤ 早已存在（§3.5/§3.7/§3.8），列在这里是因为它们回答的是同一个问题的另外几面：
**"上电之后、有人捣乱之后，这套东西还成立吗？"**

另外两个更早的例子回答"最小闭环能不能跑通"：`robot_brain_loop`（`docs/amos-link.md` §2 的数据流）与
`amos-link-cli` 的操作员命令（`crates/amos-link-cli/README.md`）。

## 2. 案例的公共契约（每个案例都遵守，写在这里只写一遍）

### 2.1 话题与 QoS：槽位由 **channel** 决定，不由调用点决定

| 用途 | 话题 | channel | profile | 为什么 |
|---|---|---|---|---|
| 传感器流（深度、IMU） | `amos/<robot>/sensor/<name>` | `sensor` | best-effort · depth 1 · drop-oldest | 陈旧的深度帧比没有深度帧更糟：**最新一帧赢** |
| 控制指令（步态、设定点） | `amos/<robot>/control/<name>` | `control` | reliable · depth 64 · drop-newest | 运动指令**不能被丢**；消费者跟不上就背压发布者（`blocked`） |
| 回程（机器人自报状态） | `amos/<robot>/state/actuation` | `state` | best-effort · depth 8 · drop-newest | 读的人要**当前模式**，不是模式历史 |
| 存活（心跳、信标） | `amos/<robot>/telemetry/{beat,beacon}` | `telemetry` | 同 `state` | 丢一拍只是"看得慢一点"，判据是代际年龄与序号缺口 |

这张表在代码里只有一处实现：`Qos::for_channel`（`crates/amos-link/src/qos.rs`），
并由 `the_catalogue_topics_use_the_profile_their_channel_implies` 钉住 —— **文档与中间件不许各说一套**。

### 2.2 归因：**谁发布，谁是**——载荷不许自称

回程的每一条都按**帧头的 `publisher`** 归属（`ListActuations`、监督台的表、CLI 的 `state` 都一样）。
所以 `ActuationState` 的载荷里**没有** robot 字段：一帧两个身份是 §3.9 修掉的形状。

### 2.3 时间：只有两种，别混

- **本机单调时钟**（`Instant`）：速率、带宽、丢弃 —— 用来测量的钟，**永不**读帧里的 `stamp`（§3.19）。
- **帧里的 `stamp`**（`amos-timesync` 校准后）：延迟与"这份报告多久前的"。未校准时它只是**上界**。

### 2.4 三种"不知道"，三种写法

| 情形 | 写法 | 绝不能写成 |
|---|---|---|
| 没有证据 | `health=unknown` / `rate=unknown(<原因>)` | `healthy` / `0 Hz` |
| 回答了但没人上报 | `ListActuations` 的 `[]` | 每台机器人"空闲" |
| 问的问题没人答 | `null`（`--json`）/ 一栏说明 | `[]`（"我们没被告知"不是关于机群的任何事实） |

## 3. 案例①：巡检任务（一条完整闭环）

```text
  现场服务器 ──{"action":"stand|trot|sit"} 于 amos/patrol-01/control/action──► patrol-01
  patrol-01  ──立体帧（best-effort，最新一帧赢）于 amos/*/sensor/stereo_left──► 现场服务器
  patrol-01  ──RobotBridge──► CRC16 电机帧 ──► MockRobotHal（今天的伺服总线）
  patrol-01  ──自己的模式于 amos/patrol-01/state/actuation──────────────────► 现场服务器
```

**实测输出（真跑，删节）**：

```text
$ cargo run -p amos-link --example patrol_mission
link up: patrol-01 (robot) + field-server (brain) over the in-process broker
field server -> {"action":"stand"}  [matched=1 delivered=1 dropped=0 blocked=0]
patrol-01: applied action #1: 13 motor frame(s), armed=true
field server <- mode: robot=patrol-01 armed=true estopped=false gait=stand watchdog=300ms last_refusal=-
…
field server <- camera publisher=patrol-01 topic=amos/patrol-01/sensor/stereo_left frames=6 span=0.51s rate=9.8Hz bytes=762 bw=1.5KiB/s
field server <- camera seq=9 (of a burst of 3; 2 stale frame(s) dropped: latest wins)
…the field server stops talking (link presumed lost)
patrol-01: torque cut (watchdog) — 12 frame(s) the bus accepted
field server <- mode: robot=patrol-01 armed=false estopped=true(watchdog) gait=trot watchdog=300ms last_refusal=-
field server -> {"action":"trot","speed":0.8}  [matched=1 delivered=1 dropped=0 blocked=0]
patrol-01: refused action #3: e-stop latched: send {"action":"arm"} to re-arm
…
patrol-01: applied action #4: 12 motor frame(s), armed=true
field server <- mode: robot=patrol-01 armed=true estopped=false gait=arm watchdog=300ms last_refusal=-
counters: published=28 delivered=34 dropped=2 blocked=0 decode_errors=0
peer table of the field server: ["patrol-01"] (this node is never its own peer: 10 self-echo(es) filtered)
health: degraded: clock_unsynced — latencies are bounds until amos-timesync calibrates the clock (1 reason(s))
```

**读数的自洽性**（读者可以自己复核，这是刻意的）：
`rate=9.8Hz` 来自 `(6−1)/0.51s`；`bytes=762` 是**整帧**的账（6 × 127 B，含帧头与 CRC32）；
`bw=1.5KiB/s` 是 `762 / 0.51`。`12 frame(s)` 的切扭矩数是 HAL **报出来的**（每个关节一帧），
不是"每关节一帧"这句注释算出来的 —— 换一条总线（一次广播切扭矩）这个数就是 1。

**测试断言的性质**（`crates/amos-link/tests/robot_cases.rs`）：

| 测试 | 断言（不是打印） |
|---|---|
| `case_1_the_patrol_loop_applies_refuses_and_reports` | 一条步态 = 1 个 `Enable` + 每关节一个位置帧（13）；回程带着**实际**看门狗周期；看门狗切扭矩后 `estopped=true` 且原因是 `watchdog`、`armed=false`；e-stop 之后的运动被**拒绝**且原因点名 `arm`（怎么恢复）；`arm` 之后重新armed 且拒绝记录被清掉 |
| `case_1_a_malformed_intent_never_reaches_the_bus` | 未知步态 / 非 JSON 都变成 `Refused`，且 `hal.applied()==0`（拒绝 ≠ 半应用） |
| `case_1_the_camera_stream_is_latest_wins_and_the_loss_is_counted` | 连发 3 帧之后拿到的是**第 3 帧**、`dropped==2`、`received==1`，且帧头署名发布者 |
| `case_1_the_stream_figures_are_checkable_arithmetic` | **注入到达时刻**：6 帧 / 500 ms ⇒ `rate=10.0Hz`（`frames/span` 会给出 12 Hz）、`bytes=780`、`bw=1560 B/s`；单帧 ⇒ `rate=None` + `single-frame`（绝不给 0） |

**诚实边界（案例①）**：

1. 例子用**宿主机时钟**，所以打印的延迟是**上界**（`clock_synced=false`）；校准是 `amos-timesync` 的事。
2. `MockRobotHal` 是"记录型总线"，不是伺服：**没有真电机被驱动过**（真描述符那一条见案例④）。
3. HAL 的关节表是**参考四足**的（`JOINTS=12`，`leg*3 + (hip|thigh|knee)`）；换形态要自己实现 `RobotHal`。
4. 看门狗周期是案例参数（300 ms），不是产品值：真产品是 50–100 Hz 控制 + 与之同量级的看门狗。
5. 例子里 `arm` 之后的 `12 frame(s)` 是"每关节一帧 Enable"，`estop` 的 `12` 是"每关节一帧 Estop" —— 都是**总线的形状**，不是定律。


## 4. 案例②：机群监督台（多机、只读测量）

```text
  patrol-01 ──模式 + 相机(10Hz)──┐
  patrol-02 ──模式 + 相机(5Hz)───┼──►  fleet-console（amos/*/state/actuation + amos/*/sensor/stereo_left）
  patrol-03 ──模式（相机只发一帧就停）┘
```

**实测输出（真跑，删节）**：

```text
$ cargo run -p amos-link --example fleet_console
reading 1 — the fleet 700 ms after one `stand` each: …
  mode   patrol-01   armed=true  estopped=false gait=trot  frames=13  watchdog=200ms  last_refusal=-
  mode   patrol-02   armed=false estopped=true (watchdog) gait=stand frames=13  watchdog=200ms  last_refusal=-
  stream patrol-01 amos/patrol-01/sensor/stereo_left frames=5    span=0.40s  rate=unknown(only 404ms of span …) bytes=635
  stream patrol-03 amos/patrol-03/sensor/stereo_left frames=1    span=-      rate=unknown(one frame so far (no interval to divide by)) bytes=127
reading 2 — same console, same patterns, 400 ms after the control loop stopped
  mode   patrol-01   armed=false estopped=true (watchdog) gait=trot  frames=13  watchdog=200ms  last_refusal=-
  stream patrol-01 amos/patrol-01/sensor/stereo_left frames=9    span=0.81s  rate=   9.9Hz bytes=1143    bw=1.4KiB/s
  stream patrol-02 amos/patrol-02/sensor/stereo_left frames=5    span=0.81s  rate=   5.0Hz bytes=635     bw=786.7B/s
  stream patrol-03 amos/patrol-03/sensor/stereo_left frames=1    span=-      rate=unknown(one frame so far …) bytes=127
  note   fleet-console received these arrivals; it missed 0 sensor frame(s) …
peer table of the console: ["patrol-01", "patrol-02", "patrol-03"] (a console is never its own peer; 20 self-echo(es) filtered)
health: degraded: clock_unsynced (latencies are bounds until amos-timesync calibrates the clock)
```

**这份输出要教的三件事**：

1. **两张表放在一起才有信息**：单次快照里"跑得很稳"和"已经死了"长得一样。
   第二张表里 `patrol-03` 的相机仍是 `frames=1`，而 `patrol-01/02` 的 `frames` 在长、`rate` 已经能算出来 ——
   **停住的流由此暴露**（`frames` 不再增长），而**不是**被印成 `0 Hz`。
2. **说得出才说**：两张表里都有 `rate=unknown(only 404ms of span …)` / `unknown(one frame so far …)`。
   原因写在行上（`MIN_RATE_SPAN=500ms` 是策略，写在 §3.19 的边界②里）。
3. **一台机器人的看门狗，在监督台上也看得见**：控制循环一停，`patrol-01` 从 `armed=true` 变成
   `estopped=true(watchdog)` —— 这是"它鞠躬下台"和"它掉线了"的区别，也正是回程存在的理由。

**测试断言的性质**：

| 测试 | 断言 |
|---|---|
| `case_2_a_console_sees_every_robot_and_never_itself` | 一张表 3 个对端、**不含自己**、全部来自信标（`beacons>0` 且非 static）；自我信标**被过滤且被计数**（`self_echoes()>0`，不是"假设它被过滤了"） |
| `case_2_every_robot_reports_its_own_deadman` | 两台机器人各自的看门狗都切扭矩（`frames==JOINTS`），监督台在**一条**通配订阅上读到**两条**报告，归属分别是两台机器人（帧头 `publisher`），且都带 `estop_reason=watchdog` |
| `case_2_the_figures_are_per_robot_and_per_stream` | **注入到达时刻**：4 条流 4 个窗口互不串（10Hz / 4Hz / 单帧 / 一条状态流），`bytes` 总和与各流之和一致，`rates()` 顺序稳定（两次读数可以 diff） |

**诚实边界（案例②）**：

1. 读数**是本进程收到的到达**（§3.19 边界①）：监督台自己慢了会漏帧，而漏掉的帧**会计进 `dropped`** 并印在同一张表的 note 行上。
2. 例子是**自启动以来的平均**，不是滑动窗口：停住的流靠 `frames` 不增长暴露。
3. `patrol-03` 的相机只发一帧，是为了让"停住的流"可读；为此它的首帧刻意晚于另两台（否则会与它们在
   同一瞬间抢那个**单槽**队列，被策略丢掉 —— 那是另一个事实，不是这一条）。
4. 监督台在例子里也发过命令（每个机器人一条 `stand`、以及给 `patrol-01` 的占空循环）：**它不是纯只读**；
   "只读面板"是 System UI 那一栏，它的诚实边界在 `docs/amos-link.md` §6.5。
5. 对端表是**本节点看到的**，不是全网权威视图（§3.11）。


## 5. 案例③：不在链路上的大脑（控制面）

```text
  调用方（不在链路上）──gRPC over UDS──►  RobotLink 控制面（proto/robot_link.proto，5 个 RPC）
                                            │ GetStatus / ListTopics   （读）
                                            │ Publish                  （注入）
                                            ▼
  patrol-01 ──控制通道──► RobotBridge ──► 电机帧 ──► 总线
            ──状态通道──► 被控制面的 watcher 折叠 ──► ListActuations
```

**实测输出（真跑，删节）**：

```text
$ cargo run -p amos-link --example remote_brain
control plane: /var/folders/…/amos-link-remote-brain-95464-….sock (gRPC over a Unix domain socket)
GetStatus: peer=patrol-01 kind=robot version=0.1.0 uptime=1ms clock_synced=false health=degraded peers=0
Publish: seq=1 matched=1 delivered=1 dropped=0 (a real frame: the robot's AgentAction subscriber decoded it)
ListActuations (just after the action): robot=patrol-01 seq=1 gait=trot frames=13 armed=true estopped=false watchdog=400ms last_refusal=-
…the remote brain stops publishing (its link to the robot is gone)
ListActuations (after the deadman period): robot=patrol-01 seq=1 gait=trot frames=13 armed=false estopped=true(watchdog) watchdog=400ms last_refusal=-
ListTopics: 3 topic(s), complete=true (the list tells the caller whether it is the whole truth)
```

**这个案例回答的问题**：一个**不在那条链路上**的调用方（笔记本上的看板、Python 规划器、System UI）
怎么参与？答案是控制面的五条 RPC —— 而且有两条硬规矩：

- **注入是真帧**：`Publish` 收的是**负载字节**，控制面用自己的 peer id、自己的序号与自己的时钟
  把它封成真正的 `Envelope`，所以机器人的**类型化订阅者照样解得开**（`case_3_injection_is_a_real_frame_the_robot_decodes` 断言 `matched==1`、`seq==1`，并断言载荷解出 `gait=trot`）。
  反过来："注入走了一条特殊通道"是不成立的。
- **回程能到**：控制面**订阅**数据面的回程并把它们折进 `ListActuations`（按帧头 `publisher` 归属），
  所以一个不在链路上的调用方也能看到"它刚才那条指令被应用到哪一步、扭矩是不是被切了"。

**测试断言的性质**：

| 测试 | 断言 |
|---|---|
| `case_3_injection_is_a_real_frame_the_robot_decodes` | `Publish` 的回复带**控制面自己的**序号与 `matched=1`；机器人侧的类型化订阅者解出 `Gait::Trot`、`speed=0.5`、`duration_ms=600`，且帧头署名是**控制面那个节点** |
| `case_3_the_deadman_is_visible_from_outside_the_link` | 注入之后 `ListActuations` 读回 `armed=true / frames=13 / gait=trot`；机器人沉默一个看门狗周期之后，同一条 RPC 读出 `estopped=true`、`estop_reason=watchdog`、`watchdog_ms` 与案例参数一致、`gait` 仍是 `trot`。**归属是帧头**（`robot == "patrol-01"`），不是载荷自称 |

**诚实边界（案例③）**：

1. **数据面不从这里过**：深度帧、关节设定点**不**走 gRPC（§6.5）。想看传感器流的看板要么自己在链路上，
   要么读一个在链路上的服务。
2. `Publish` 的 `matched`/`delivered` 只有**进程内 broker** 知道；Zenoh 会诚实地回 0（"不知道"，不是"没有"）。
3. `ListActuations` 是**快照**不是历史，而且**没上报过的机器人不在列表里**（`[]` = "问了，没人上报过"，不是"全员空闲"）。
4. 示例里的 UDS 权限就是它的认证：**控制面是同一台机器上的 UDS**，跨机调用要走部署方自己的通道与鉴权。
5. 例子用**真 UDS + 真 tonic 客户端/服务端**（不是 mock），但仍是在一台机器上、环回。

## 6. 怎么加一个新案例（清单）

1. **先写契约**：这个话题属于哪个 channel？（表在 §2.1；如果它不属于任何一栏，先想清楚它是不是一个新 channel。）
2. **写例子**：`crates/amos-link/examples/<case>.rs` —— 一个进程、离线可跑、打印**可复核**的数字
   （`frames`/`span`/`rate`/`bytes` 同一行；说不出就写原因）。
3. **写案例级测试**：`crates/amos-link/tests/robot_cases.rs` 里加 `case_N_*`。
   断言**性质**，不是打印：帧数、拒绝原因、归属、时间窗算术（能注入时刻就注入，别测本机调度器）。
   会异步收敛的事（对端表、被折叠的报告）用有界轮询，**不要**用固定 sleep。
4. **负数控制**：把这条性质在**生产代码**里改坏一次，确认那个用例**失败**，再逐字节还原（`cmp` 证明）。
   这一条是本仓的纪律：不能失败的测试什么都没证明。
5. **文档**：本文加一节；`docs/amos-link.md` 记设计与被撞出来的缺陷；crate README 的 Examples 表加一行
   （`crate-readme-scan` 会核对 README 与 `examples/` 是否互相认账）。
6. **诚实边界**：写下这个案例**没有**证明什么（没上真机、没驱动真电机、没跑真网络……）。

## 7. 诚实边界（整份目录）

1. **这些案例跑在同一台机器的一个进程里**（案例③ 也是同一台机器上的真 UDS）：真板卡、真 Wi-Fi/5G、
   真交换机的现场验证仍是 bring-up 项（`docs/amos-link.md` §6/§7）。
2. **没有真电机被驱动过**：`MockRobotHal` 记录帧；`StreamRobotHal` 写**真描述符**（案例④），
   但"关节真的动了"需要一台机器。
3. **HAL 是参考四足的**：`JOINTS=12`、`leg*3+(hip|thigh|knee)`、毫度整数。别的形态（轮式底盘、机械臂、
   无人机）要自己实现 `RobotHal` —— 中间件本身与形态无关（它只搬字节），**这一层**与形态有关。
4. **案例时钟是宿主时钟**：所有延迟是上界，直到 `amos-timesync` 校准。
5. **没有 ROS/DDS 互操作**：要进那个生态需要单独的桥接组件（§8 的对照表在 `docs/amos-link.md`）。
6. **没有安全认证**：`PeerId` 是一致性标记不是身份；发现（信标）不认证；控制面靠 UDS 的文件权限。

## 8. 验证入口

```bash
# 三个案例（离线、单进程；每个约 1–2 秒）
cargo run -p amos-link --example patrol_mission
cargo run -p amos-link --example fleet_console
cargo run -p amos-link --example remote_brain

# 案例级测试（10 例：性质断言，不是打印）
cargo test -p amos-link --test robot_cases

# 同一套测试在带网络特性的构建下（真 UDS + 组播通道都要能编译/运行）
cargo test -p amos-link --features lan
cargo test -p amos-link --features zenoh
```

