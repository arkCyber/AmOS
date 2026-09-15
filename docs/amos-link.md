# AmOS-Link — AmOS 的机器人中间件（Rust 内核 · Zenoh 互联）

**日期**: 2026-09-14 · **范围**: `crates/amos-link`（中间件内核）+ `crates/amos-link-cli`（终端）
+ `proto/robot_link.proto`（控制面契约）+ `amos-ai` 挂载点

> 本文回答一个问题：**在没有 ROS 的前提下，AmOS 用什么把「眼睛（双目/IMU）」「大脑（推理服务器）」
> 「小脑（电机驱动）」连起来**，以及这份实现**真的用了 Zenoh 的哪些部分、没有用哪些**（最后一节是
> 逐项审计，不夸大）。设计纪律与全仓一致：**领域内核纯 Rust、离线可测；真正的网络通道放在 feature
> 之后**（`lan` / `zenoh`），默认构建不引入任何 socket、不下载任何原生依赖。

## 1. 现状与定位（改动前）

改动前全仓没有任何机器人中间件：`amos-sensor` 有相机/GNSS/IMU 的**采样抽象**，`amos-power` 有
DVFS 闭环，`amos-telephony`/`amos-radio` 有服务总线，但**没有任何东西能把一个进程（甚至一块板卡）里
产生的高频字节流，异步、无阻塞地送到另一个进程/另一台机器**。`proto/sensor.proto` 的注释自己写着
「raw camera frame *bytes* are NOT shipped here」——缺口是**数据面**，不是一个 RPC。

ROS 的本质不是操作系统，而是三件事：**发布/订阅**、**消息序列化**、**节点发现**。AmOS-Link 就是这
三件事，加上机器人特有的第四个：**把大模型的 JSON 意图翻译成电机的十六进制帧**。

## 2. 分层与实际数据流

```text
   ① 键    amos/<peer>/<channel>/<name>  +  * / ** 通配          keyexpr.rs
   ② 编帧  AMLK │ ver │ hdr │ crc32 │ bincode payload            codec.rs · qos.rs · metrics.rs
   ③ 传输  Broker（进程内） · Zenoh（跨板卡/跨服务器, feature）   broker.rs · zenoh.rs
   ④ 发现  总线联邦(amos/*/telemetry/beacon) · UDP 信标(feature) → PeerRegistry
                                                            discovery.rs · lan.rs(feature)
        ▲                                                              │
        └──── node.rs · telemetry.rs · health.rs · sequence.rs · robot_hal.rs · service.rs ◄──────┘
```

机器狗 ↔ 场边服务器的一条完整链路（`crates/amos-link/tests/link_e2e.rs` 就是这个场景）：

```text
  dog1(publisher)  ── amos/dog1/sensor/stereo_left ──►  brain(pattern amos/*/sensor/stereo_left)
     ▲                                                     │
     └── RobotBridge ◄── amos/dog1/control/action ◄────────┘  {"action":"trot","speed":0.8}
              │
              └──► MockRobotHal：aa55 01 01 e8030000 crc16 …（每关节一帧，CRC16-CCITT）

  dog1  ── amos/dog1/state/actuation ──►  brain(pattern amos/*/state/actuation)
         （**回程**：armed / estopped(+原因) / gait / 最近一次拒绝）
```

**话题归属与发布者是两件事**：`amos/dog1/control/action` 这个**话题**属于被控对象（机器狗的控制输入），
**发布者**是场边大脑（帧头里写着 `publisher=mini-brain`）。这样 `amos/dog1/control/*` 的通配订阅只会
看到「发给 dog1 的命令」，而「谁在指挥」由帧头回答——不需要为人分配命名空间。

## 3. 内核模块（`crates/amos-link`，纯 Rust、离线可测）

| 模块 | 内容 | 关键点 |
|---|---|---|
| `keyexpr` | `Topic` / `Channel`：`amos/<peer>/<channel>/<name>` 校验 + `*`（一段）`**`（零或多段）匹配（**迭代 DP，非递归**）+ `Topic::channel()`（这条键表达式**自称**属于哪个 channel） | 语法与 Zenoh 的 key expression **同构**，所以同一套模式在进程内和跨网两种传输上行为一致。匹配是 `O(n·m) ≤ 32·32` 的**动态规划**（两个栈上定长数组、零分配）：Power of 10 #1 禁递归、#2 要求静态有界，而朴素回溯匹配在 32 段上限下的 `**` 密集模式要探 ~10¹¹ 条路径 —— 那是**拿着 broker 注册表锁**的挂死。`channel()` 让「按主题选 QoS」成为可编程的事：`amos/*/control/*` 自己就说明它是控制流；认不出（通配符在 channel 位 / 路径太短 / 非 `amos` 根）就**如实回答 None**，绝不猜 |
| `codec` | `Message`（任意 serde 类型，bincode 载荷）、`Envelope`（magic+版本+bincode 头+CRC32）、`Timestamp`、`Clock`；**帧大小上限** `MAX_PAYLOAD_BYTES = 16 MiB` | 头里带 **topic / publisher / seq / 时间戳**：通配订阅者因此知道「这是谁、第几帧、多久之前」。上限在 **encode 与 decode 两侧**都检查，且**先于任何分配**校验头部声称的长度（伪造 4 GiB 头不会让接收端分配）。头里的 `topic` 只是**发布者的声明**：订阅侧拿它与**传输的路由键**逐字比对，不一致即拒（否则一个对端可以在 `amos/evil/…` 上发布却声称自己是 `amos/dog1/…`） |
| `qos` | `Reliability{BestEffort,Reliable}` × `depth` × `DropPolicy{DropNewest,DropOldest}`，预设 `Qos::sensor()` / `state()` / `control()`，以及 **`Qos::for_channel(Channel)`**（channel → profile 的**唯一**策略表） | 传感器流=`depth 1 + drop-oldest`（**最新帧胜**）；控制流=`Reliable`（**背压，不丢**）。`for_channel` 让「订阅 `amos/*/control/**` 却拿到 best-effort 档」这种**静默丢控制指令**的错误在类型层面就有正解（CLI `sub` 默认即用它，并打印档位来源） |
| `broker` | `Transport` seam + 进程内 `Broker`：按订阅者独立队列、`Arc<[u8]>` 扇出（不复制大帧）、从不在持有锁时 await；话题清单**有界**（`MAX_TRACKED_TOPICS = 4096`，满了即停止增长且 `topics_complete()` 如实回答 false） | 与 `amos-sensor` 的 provider seam 同一纪律：哑核心 + 可替换后端。有界清单是 Power of 10 #2（静态有界资源）：一个不停发明主题名的发布者不能让诊断集合随进程寿命无限增长；**发布永不因记账上限失败**，而清单**自己声明不完整**（绝不用一个看起来完整的列表撒谎） |
| `discovery` | `Beacon`（`AMLB │ ver=2 │ body_len │ CRC32 │ bincode` 帧）+ `PeerRegistry`（TTL 过期、按新鲜度排序、**静态对端永不过期**）+ `MockDiscovery` + **`BusDiscovery`/`spawn_federation`**（信标走链路自身传输：`amos/<peer>/telemetry/beacon`） | 注册表是**纯状态机**（时间作为参数传入）。信标帧带**长度 + CRC32**，且**两侧都检查**（`encode` 拒绝自己造出超限帧，`decode` 先于任何反序列化拒绝伪造长度/超限帧/CRC 不符），`PeerInfo::validate` 限制端点数量与长度 ⇒ 一条被损坏的「我是谁、来哪连我」不会变成一条被静默信任的假对端。版本 2 之前的节点会被**按版本拒绝**，而不是喂进另一种布局的 body。**静态对端**（`learn_peer`，锁定网络里没有组播）没有信标可错过，因此**不受 TTL 驱逐**（只会被 `forget_peer` 移除，或被它自己的信标转成被 TTL 管理的动态对端）；`learn_peer` 也**不会抹掉已测得的活跃度**（改端点不会把死板卡变活）。总线联邦让**任何传输**都能填满对端表（含 Zenoh），并**过滤自身回声**（节点绝不把自己当 peer） |
| `lan`(feature) | `LanDiscovery`：UDP 组播信标（默认 `239.255.42.99:7446`，`AMOS_LINK_BEACON_ADDR` 覆盖），`SO_REUSEADDR/PORT` 让同机多进程共用一个端口；`spawn_announcer` **按周期重复**广播（不是开机喊一次） | 明文、未认证：这是**发现的提示**，不是身份证明（见 §6）。数据报上限（`MAX_DATAGRAM` 1024B）之外还有帧上限 `MAX_BEACON_BYTES = 512`：外来/超限/篡改报文一律被跳过而不是解析。**为什么要重复**：信标是收方唯一的证据，而证据会随 TTL 过期——只喊一次的节点**只有已经在听的**对端能发现（开机跑起来的机器狗、或一分钟后才入网的场边笔记本，都会看不见它）。周期由调用方给（CLI 用 TTL/3，与 `spawn_federation` 同一条规则：喊得比这更稀，别的表就会看到「加入—过期」反复循环 = 一个扑腾的节点）；每拍都带**新的** `Timestamp`（活着的对端不该一直自称"我刚开机的那一秒"） |
| `telemetry` | `Heartbeat`（`amos/<peer>/telemetry/beat`，1 Hz）+ `NodeStatus`（JSON 自查）+ `spawn_heartbeat` | 心跳是**消息**，走同一条 pub/sub 通道，因此 `topics` 里看得见 |
| `robot_hal` | `parse_command`(JSON 校验) → `plan`(步态→关节位姿) → `MotorFrame`(10 字节/CRC16) → `RobotHal` seam（`MockRobotHal`）；`RobotBridge` 带**死手看门狗 + 闩锁急停**，并可 `reporting()` 把模式**回程**到 `amos/<robot>/state/actuation`（仅模式变化时发） | 大模型只能说 JSON；限位、关节范围、CRC 都由这一侧负责。`JointId` 索引**私有**（只能经 `new` 或在**反序列化时**校验得到），`MotorFrame::validate` 在 **CRC16 总线解码**与 **bincode `Message`** 两条路径上都强制（`MockRobotHal::apply` 也在写总线前拒绝整批）。安全语义见 §3.1 |
| `sequence` | `SeqTracker` / `SeqEvent` / `SeqSummary`：按**发布者**跟踪 `seq` 高水位 ⇒ `in_order` / `gaps` / `missing` / `stale` | 纯状态机（无 IO、无时钟）。「帧丢了」由**发布者自己的计数器**证明，而不是猜：一次跳变 = 一次 gap 事件，`missing` 记它丢了多少帧；等于/低于高水位的帧算 `stale`（重复/乱序/计数器重启），**不混进「丢帧」**。CLI `sub` / `bench` / `watch` 都用它把丢帧变成数字 |
| `node` | `LinkNode`：身份 + 传输 + 时钟 + 计数器 + 对端表，`publisher::<T>()` / `subscriber::<T>()` 的唯一入口 | 控制面与 CLI 都是它的薄壳 |
| `service` | tonic 控制面（`proto/robot_link.proto`：GetStatus / ListTopics / Publish / StreamHeartbeats / **ListActuations**），已挂进 `amos-ai::server::serve()` 的共享 UDS | 控制面≠数据面：RPC 只做管理，字节流永不经过它。**唯一的例外是有意的**：`ListActuations` 把**回程**（`amos/*/state/actuation`）**订阅并折叠**成一张按 robot 排序的快照表，让不在链路上的调用方也能读到「机器人自报什么」——它是**读**数据面，不是代理数据面 |

计数器（`metrics`）由「知道事实的那一层」写：`published`（交给传输）、`delivered`（进入订阅队列）、
`dropped`（QoS 策略真的丢了）、`blocked`（**被可靠订阅者背压**：这次发布不得不等队列腾位置）、
`decode_errors`（收下来但解不开）、`encode_errors`（**发不出去**——本端编码失败）。**没有一个数字是估算的**，
且只增不减；六个计数器在 `NodeStatus` JSON 与控制面 `Metrics` 里都如实出现（不是只活在内核里）。
`blocked` 尤其重要：`Reliable` 的代价本来是「看不见的慢」，现在它是一个可读的数（`PublishReport.blocked`
给出**单次**发布是否等了，`metrics.blocked` 给出**累计**次数）。

### 3.1 安全语义（`RobotBridge`，这是产品级机器人的最低要求）

| 机制 | 行为 | 为什么必须在内核而不是在大模型侧 |
|---|---|---|
| **闩锁急停** | 收到 `estop` 后**所有运动指令被拒**（`BridgeEvent::Refused`），只有显式 `{"action":"arm"}` 才解锁 | 队列里可能还躺着一条陈旧的 `trot`；机器人不能因为一条迟到指令自己复活 |
| **死手看门狗** | `with_watchdog(period)`：静默超过 `period` ⇒ 桥**自己**切扭矩并报 `EstopReason::Watchdog` | 「Wi-Fi 中途断了」必须停机，而不是让最后一条指令一直跑 |
| **`arm` 只上电不运动** | `plan(arm)` = 每关节一帧 `Enable`，**没有**任何 `SetPosition` | 复位是一个需要被明确请求的动作，不能顺手带出一次运动 |
| **畸形意图不进总线** | JSON 解析/限位失败 ⇒ `BridgeEvent::Refused`（**不是** `Err`，也不是默认姿态） | 「大模型说胡话」是常态；它不该让控制环崩溃，也不该变成一个静默的默认动作 |
| **控制流不会被静默降级** | `Qos::for_channel(Control)` 恒为 `Reliable`；订阅模式自称 channel 时 CLI 默认采用它并**打印档位来源**（`--qos` 或 channel 或 default），认不出 channel 才退回文档默认 | 「订阅 `amos/*/control/*` 却用 best-effort」会让急停/步态指令被静默丢掉 —— 这是最贵的一类配置错误。策略表只有一处（`Qos::for_channel`），且选择过程可被打印 |
| **帧大小上限** | 数据帧载荷 >16 MiB、发现信标帧 >512 B（含端点数量/长度）都在编解码**两侧**被拒 | 畸形的对端（或恶意对端）不能逼每个订阅者分配无界内存，也不能让一条伪造发现报文进入对端表 |
| **关节/行程不变量** | `JointId` 索引私有；`MotorFrame::validate`（位置 ±90°、扭矩 0..100%、未知 opcode 拒绝）在 **CRC16 总线解码**与 **bincode 载荷解码**两条路径上都执行；`MockRobotHal::apply` 在写总线前**整批**拒绝 | CRC 只能证明「没被随机损坏」，证明不了「没被恶意构造」；一个信任输入的 HAL 就不是安全层。整批拒绝避免「部分写入 ⇒ 关节处于混合状态」 |
| **算术极值不溢出** | 限位检查是**区间比较**而非 `abs()`；`Timestamp::unix_ms` 饱和；`SeqTracker` 的 `expected = last + 1` 用 `checked_add`；CLI `--hz` 走 `Duration::try_from_secs_f64`（**不是**会 panic 的 `from_secs_f64`） | 这些值全部来自线上/大模型/命令行：`i32::MIN.abs()` 会 panic（debug）或在 release **回绕后通过检查**，`secs = u64::MAX` 会让 `secs * 1000` 溢出，`--hz 1e-300` 会让 `from_secs_f64` 直接 panic —— 安全层与工具都不能有这种边角 |
| **定时器周期必须非零** | `spawn_heartbeat`/`spawn_federation` 对 `Duration::ZERO` 返回**带类型错误**；两处 tick 都设 `MissedTickBehavior::Delay`（错过的心跳/信标**不补发**） | `tokio::time::interval(0)` 会在**被 spawn 的 task 内部** panic：调用方拿到的是一个「看着活着、其实已死」的句柄 —— 「静默死亡」不是「关停」，这一条在本仓被单独拒绝 |
| **非有限浮点不选位姿** | `Gait::pose` 对 `NaN`/`±inf` 一律取**最慢**位姿；位姿表长度与关节数由**编译期断言**钉住（`const _: () = assert!(JOINTS == MAX_JOINT + 1)`） | `f32::clamp` 会传播 NaN，而 `NaN as i32 == 0` 会产生**比任何合法速度都更直**的站姿；一个非法请求绝不能换来更激进的动作。编译期断言让「位姿表 ↔ 关节范围」的一致性由**编译器**而不是评审者保证 |
| **回程（模式上报）** | `RobotBridge::reporting(publisher)` 之后，桥在 `amos/<robot>/state/actuation`（`state` 通道 = **最新值胜**）上报 `armed` / `estopped`(+原因) / 当前 `gait` / **最近一次拒绝**；`seq`/`frames` 等逐指令细节**不参与"变化"判定**，所以 50 Hz 控制流不会变成 50 帧/秒的状态流 | 「机器人停了」这件事，**掉线的那个对端恰恰无法轮询**：Wi-Fi 断掉触发看门狗切扭矩时，只有机器人主动说，大脑才知道自己那条 `trot` 没在跑（否则它一直以为在跑）。**上报失败不会让 `step()` 返回 Err**：安全动作已经发生，把一次链路抖动说成"没停"是更坏的谎 |

`BridgeEvent` 的三种结果与 `metrics` 的关系是刻意的：**被拒的指令仍然算 `delivered`**（帧确实到了，
是安全层拒绝执行），这与「帧丢了」是两件不同的事实。

### 3.2 链路自判（`health`）：一个不撒谎的结论

计数器回答「多少」，运维问「还好吗」。`LinkHealth::evaluate(metrics, peers, clock_synced, sequence?)`
把两者之间那一步做成**纯函数**，规则写死、可单测、可打印：

| 状态 | 何时 | 为什么这样定 |
|---|---|---|
| `Unknown` | `published == 0 && delivered == 0 && peers.is_empty()` | **没有证据就不下结论** ——「未知」绝不等于「健康」 |
| `Degraded{reasons}` | 有证据，且下列任一原因成立 | 每条原因都**带自己的数字**，不是形容词 |
| `Healthy` | 有证据，且无原因 | —— |

原因（**固定顺序**，两次报告可直接对比）：`encode_errors=N`（本端发不出去）、`decode_errors=N`（收下来解不开）、
`back_pressure=N`（可靠消费者比发布者慢）、`frame_loss=N in M gap(s)`（**消费者侧**序列证据，需调用方把
`SeqSummary` 传进来）、`no_peers`（链路上只有自己）、`clock_unsynced`（延迟数字是**上界**，不是测量）。

**刻意不算原因：`dropped`。** best-effort 流的丢弃**就是策略在工作**（最新帧胜会覆盖自己的队列），把它算进
结论会把一台健康机器人判成「降级」—— 结论不替调用方解释丢弃，`metrics.dropped` 原样给出。

**序号是饱和的，不是回绕的。** `telemetry::next_seq`（全 crate 唯一的序号源：`Publisher` 的帧序号、节点心跳、控制面 `Publish`）用 compare-exchange 在 `u64::MAX` 处停住 —— `fetch_add(1) + 1` 在极值处会把存储值回绕成 0，于是「刚盖出去的戳」比计数器还大、后续帧重新用 1、2…，消费端的 `SeqTracker` 会把它读成「发布者重启了」（一个凭空编出来的故事）。饱和则让**盖出去的戳与读到的计数器始终一致**。

**边界**：节点只能看见**自己**的计数器，看不见某个消费者的序列跳变（那是订阅级状态）；CLI `watch`
手里正好有 beat 的 `SeqTracker`，因此它的结论比 `status` 多一条 `frame_loss` —— 后者需要调用方把
`SeqSummary` 传进 `evaluate`。控制面 `LinkStatus.health`（枚举）+ `health_reasons`（每条带数字的 token）
把同一结论送到非 Rust 客户端。

### 3.3 分配与算术纪律（航天级加固轮，REQ-A241）

> 本节记录一次**按安全关键纪律逐行复核**的结果：五处真实缺陷（都带可复现的负控）与一处
> **核实后判定不是缺陷**的怀疑。判定标准沿用全仓的 Power of 10 口径：**任何来自线缆/命令行/模型
> 的值都必须被有界化，任何"等一个可能永不到来的事件"的等待都必须能被证明会结束，任何上报出去的
> 数字都必须是**测量**而不是假设**。

| # | 缺陷（修前） | 为什么按适航标准不可接受 | 处置 |
|---|---|---|---|
| 1 | **CRC 用 `crc32fast::hash(&[header, payload].concat())`** | 每帧**多分配并复制一整份帧**：16 MiB 上限下把一帧的**峰值内存翻倍**；更糟的是它发生在**校验之前**——对端一个 16 MiB 的帧就能让接收端先分配 32 MiB，而"分配必须发生在验证之后"是本 crate 自己写在 §3 的纪律 | 新增 `codec::crc32_over(header, payload)`：`Hasher::update` **流式**覆盖两段，**零额外分配**，CRC 值**逐字节不变** |
| 2 | **锁中毒 ⇒ 可靠发布无界等待**（`broker::LatestSlot::try_put` 把 `Err(poison)` 当"槽已占用"） | 中毒后 `take()` 永远返回 `None`，`taken` 通知**永远不会有发送者**，于是 `offer_blocking` 在**控制回路上永久等待**；`recv()` 同样会空转。Power of 10 #2 要求"每个循环都要能证明会结束"，而这是一个**没有终止条件**的等待 | `try_put` 返回 `Result<Option<Ingress>>`：中毒 = `LinkError::Closed`（类型化拒绝）；`is_closed()` 把中毒视为**已关闭**（消费者结束、注册项被清扫） |
| 3 | **看门狗上报的帧数是猜的**（`RobotHal::estop()` 返回 `()`，看门狗路径写死 `frames: JOINTS`） | 上报给大脑/界面的 `frames` 必须是**测量值**。切扭矩没有唯一线形：有的驱动器**一帧广播**就切，有的每关节一帧——对前者，12 是**编造的数字** | `RobotHal::estop() -> Result<usize>`（与 `apply` 同形，实测）；`BridgeEvent::Estopped.frames` 用实测值；`MockRobotHal::estop` 返回 `apply` 的计数 |
| 4 | **CLI 两个可复现的崩溃**（负控实测：`discover --bus --seconds 18446744073709551615` ⇒ `panicked … overflow when adding duration to instant`；`bench --count 18446744073709551615` ⇒ `panicked … capacity overflow`） | 操作员输入不该**panic**，更不该**abort**（`Vec::with_capacity` 的容量溢出是 abort 级失败）。同一个纪律本轮之前已经用在 `--hz` 上（`Duration::try_from_secs_f64`），但 `Instant + Duration` 与按 `--count` 预留容量这两条漏了 | `deadline_after()`（`checked_add`，**一处定义**）在**解析期**拒绝不可表示的窗口（exit 2），运行时再以同一函数兜底；latency 预留改为有界（`LATENCY_RESERVE`），`target` 用 `usize::try_from` 无截断；`--size` 超过线上限（`MAX_BENCH_PAYLOAD = 16 MiB − 64`）在解析期拒绝 |
| 5 | **静默截断**：`PublishReply` 的 `usize as u32`、`watchdog_ms` 的 `u128 as u64` | `as` 溢出时**回绕**（2³² 变 0），调用方会读成"几乎什么都没送达"；仓内既有的纪律是**饱和**（`Timestamp::unix_ms`、`next_seq`），这两处不一致 | `service::count_to_u32`、`watchdog_ms` 的 `u64::try_from(...).unwrap_or(u64::MAX)`，各带单测（含 64 位平台上的回绕负控） |

**核实后判定"不是缺陷"的一条（诚实记录）**：本轮曾怀疑所有 `bincode::deserialize`（其默认字节预算
为 **Unlimited**）可被一个短帧里的长度前缀骗出巨额分配。查依赖源码后**否定**：`bincode 1.3.3` 的
`SliceReader::get_byte_slice` 会**先**判 `length > slice.len()` 再决定是否分配（`de/read.rs:47`），
而本 crate 的解码点**全部**喂 `&[u8]`（不是 `io::Read`）——所以 `Vec<u8>`/`String` 的超长声明是
**拒绝**而不是分配。故此轮**不改**解码配置，只把结论记录在案；**附带条件**：若有解码点改成
`deserialize_from(reader)`（`IoReader` 会 `temp_buffer.resize(length, 0)`），该结论立刻失效，届时
必须补 `with_limit`。

**回归证据**（全部可复跑）：
```bash
cargo test -p amos-link                                  # 115 lib + 1 分配预算 + 4 e2e + 2 UDS
cargo test -p amos-link --features amos-link/lan --lib   # 120
cargo test -p amos-link --features amos-link/zenoh --lib # 117 + 1 ignored
cargo test -p amos-link-cli                              # 9 parser + 17 process-level
cargo clippy -p amos-link -p amos-link-cli --all-targets --features lan,zenoh -- -D warnings
```
**负控实测**（把缺陷注入回去，证明每条新验证真的会红；每次注入后都 `cmp` 还原为**逐字节一致**）：

| 注入的旧行为 | 新验证的反应 |
|---|---|
| CRC 改回 `crc32fast::hash(&[…].concat())` | `allocation_budget`：`encoding a 4194389-byte frame asked for 8388837 bytes`（≈ 2×）⇒ **FAILED** |
| `LatestSlot::try_put` 的"中毒 = 占用"**与** `is_closed()` 的旧实现一起注入 | `a_poisoned_reliable_slot_refuses_…`：`the publish must return, not wait forever: Elapsed(())`（**真的永久等待**）⇒ 两条用例 **FAILED** |
| 看门狗路径改回 `frames: JOINTS` | `a_watchdog_cut_reports_…`：`left: Estopped { frames: 12 } / right: { frames: 1 }` ⇒ **FAILED** |
| CLI 原样 | `--seconds u64::MAX` ⇒ `panicked at lib.rs:1155: overflow when adding duration to instant`；`--count u64::MAX` ⇒ `panicked … capacity overflow`（修**前**的实测输出） |

**新增/加固的验证**：编帧 CRC 的**值被钉住**（`the_streamed_crc_equals_the_concatenated_one_and_is_pinned`
断言 `crc32_over` == `concat()` 的 CRC，并把一帧真实帧的 CRC 固定为 `0xFC0E56E6` —— 线协议一旦
漂移，这条会红）；`a_flipped_bit_in_either_half_is_caught_before_it_is_parsed`（帧头/载荷各翻一位，
且证明**校验先于解析**）；`a_poisoned_reliable_slot_refuses_…`（中毒槽的发布**有界返回**、`recv` 不空转）；
`a_poisoned_sensor_slot_is_a_dead_consumer_not_a_silent_delivery`；`a_watchdog_cut_reports_the_frames_the_bus_took_not_a_guess`
（1 帧切扭矩的 HAL ⇔ 上报 1）；`arguments_that_used_to_crash_the_process_are_usage_errors_now`
（进程级：两条负控命令现在 exit 2）；`a_huge_count_still_starts_the_benchmark_…`。


### 3.4 对端表与匹配器（第二轮复核，REQ-A242）

> 同一套纪律的第二轮，两个真缺陷：一个**上报了不存在的对端**，一个**在发布热路径上分配**。
> 两条都有**实测证据**与**负控**（注入回旧行为 ⇒ 新验证变红 ⇒ `cmp` 还原逐字节一致）。

| # | 缺陷（修前） | 实测证据 | 处置 |
|---|---|---|---|
| 1 | **节点把自己当成对端**：`discover --lan` 把自己的信标收进来（`IP_MULTICAST_LOOP` 默认开启，组播会回到发送者），而总线路径在源头过滤、LAN 路径没有；`PeerRegistry` 本身没有"我是谁"的概念，两个 CLI 路径还各自 `learn(self)` 播种自己 | `amos-link-cli --features lan -- discover --lan --peer self-test --seconds 4` ⇒ `self-test · tool · 4 beacons`、`peers=1`（"这个 LAN 上有谁"答成了发起者自己） | 不变量下沉到表本身：`PeerRegistry::with_local(ttl, local)` — `observe`/`learn` 一律拒绝**本机 id** 并计数 `self_entries_refused()`；`LinkNode` 的三个构造器都带上自己的身份；CLI 两条路径改用 `with_local`、去掉自我播种，并**如实打印**被过滤的条数（`filtered N entries naming this node itself`）。`spawn_federation` 的源头过滤保留为快路径，其计数从"写了从不读"变成 `FederationTask::self_echoes()`（文档里"可以证明过滤生效"这句话此前**无法成立**） |
| 2 | **匹配器在发布热路径上分配**：`Topic::matches` 每次 `collect()` 出**两个 `Vec<&str>`**，而 `keyexpr` 模块文档自称匹配"无分配、无回溯"；它每帧对每个匹配订阅者各跑一次，**且在 broker 注册表锁内** | 计数分配器：1000 次匹配 ⇒ **128 000 字节**（每次 128 字节 = 两个 Vec）｜修复后**0 字节** | 两段都走**栈上定长数组**（`[&str; MAX_SEGMENTS]`，与 DP 的两个栈数组同一纪律），`matches` 与调用点一起做到**零分配** |

**修后的实测输出**（同一条命令）：

```text
discovery=lan target=239.255.42.99:7446 bound=0.0.0.0:7446 announce=1000ms listening 4s
(no peers)
filtered 4 entries naming this node itself (a node is not its own peer)

discovery=bus transport=broker peer=amos-node topic=amos/amos-node/telemetry/beacon listening 2s
no peers announced on this link in 2s (federation still ran: …)
(no peers)
filtered 3 entries naming this node itself (a node is not its own peer)
```

**负控实测**（每次注入后 `cmp` 还原**逐字节一致**）：

| 注入的旧行为 | 新验证的反应 |
|---|---|
| 删掉 `observe` 的自拒绝 | `a_node_is_never_a_peer_of_itself` ⇒ **FAILED**（自己进了表） |
| `matches` 改回 `collect()` | 分配预算用例 ⇒ `1000 matches asked for 128000 bytes: the matcher must not allocate` **FAILED** |

**回归证据**：`cargo test -p amos-link`（**117 lib + 1 分配预算 + 4 e2e + 2 UDS**）、`--features lan` **120**、`--features zenoh` **117 + 1 ignored**、`cargo test -p amos-link-cli`（**9 + 17**）。**边界（诚实）**：`with_local` 只认**一个**本机 id（一个进程一个节点，与 `PeerId` 的约定一致）；`PeerRegistry::new`（无身份）仍接受一切 —— 那是单元测试想要的形状，生产构造器一律用 `with_local`；组播回环是**平台默认**（`IP_MULTICAST_LOOP`），本轮不改 socket 选项：**过滤比期望对方不发回来**可靠。


### 3.5 真硬件输出：从 `plan` 到真实字节流（第三轮，REQ-A243）

> 上一轮记下的边界是「**真硬件 HAL 未实现**（只有 `MockRobotHal`）」。本轮兑现它：新增
> `StreamRobotHal`（任意 `AsyncWrite`：设备节点、Unix 套接字、TCP 桥），CLI 用 `--device` 接上去。
> 「真」字仍然要说清楚：它写的是**真实字节流**，不是完整驱动 —— 波特率/`raw`/位定时是**部署**的事
> （`stty -F /dev/ttyUSB0 1M raw`），本层不偷偷改别人的总线（见下「诚实边界」）。

| 形状 | 构造 | 用途 |
|---|---|---|
| `StreamRobotHal::new(w)` | 任意 `AsyncWrite + Unpin + Send` | 测试、管道、自定义桥 |
| `StreamRobotHal::open_device(path)` | 字符设备（UART/PTY） | 真串口/板卡串口线 |
| `StreamRobotHal::connect_unix(path)` | Unix 域套接字 | 板卡上的电机守护进程 |

**两条总线层必须具备的性质**（mock 证明不了，这里是实测）：

1. **整批校验先于任何字节**：`apply` 先把整批 `validate()` 走完，再碰描述符。实测
   （`tests/hardware_hal.rs`）：一批 `[Enable(合法), SetPosition(越限)]` ⇒ 返回 `Err`，
   `frames_written()==0`，对端套接字在 150 ms 内**读到 0 字节** —— 不会有「一半关节被下令」。
2. **上报的 accepted 数就是真的写出去的数**：计数只在某帧的 `write_all` 返回**之后**前进，因此中途
   失败会带着「已写出 N 帧」报错，而不是照抄计划的长度。

**（本轮缺陷）`armed` 曾是"批内有没有 Enable"**：两个 HAL 都用两趟 `any()` 回答「驱动器还带电吗」，
于是**以 `Enable` 结尾**的批次只要**任何位置**出现过 `Estop`，就报 `armed: false` —— 而这是
「下一条运动指令是否允许」的依据，也是回程里**上报给指挥方**的数字。处置：把规则收成一处
`armed_after(armed, frames)`（**按线缆顺序折叠，最后一个带装定语义的 op 生效**），`StreamRobotHal`
更是**每写出一帧就折一帧**：它按构造就免疫这个缺陷类别（写序即线序）。

**实测（CLI 进程级，`crates/amos-link-cli/tests/cli_smoke.rs`）**：测试自己起一个控制器套接字，
`amos-link-cli motor --action '{"action":"stand"}' --device <socket>` ⇒ 末行
`applied 13 frame(s) to hal=stream armed=true at <path>`，对端**读回 130 字节并逐帧 `MotorFrame::decode`
（CRC16 校验通过）**：`Enable` 在先、12 条 `SetPosition` 在后。设备打不开时是 **exit 1** 且错误里带路径
（绝不出现「applied 13 frames」这种假报告），`--device` 用在别的命令上是**用法错误 exit 2**。

**诚实边界（本轮新增）**：

- **不配置端口**：只 `open`+`write`。写到一个参数错的串口在本层**照样成功**，驱动器收到垃圾 —— 所以端口
  设置写进 bring-up 清单，而不是写进这个函数。
- **没有真实伺服验收**：证据止于「真实字节流上是正确的 CRC16 帧」，不是「电机动了」。真机验收仍是现场项。
- **`--device` 仅 Unix**（套接字/设备文件是 Unix 概念），别的平台明确拒绝而不是假装写过了。


### 3.6 组播：接口固定、回环开关，与「无身份表」的退场（REQ-A243）

> 同轮收口另外三条边界。两条是**能测的部分**（多网卡机器的组播、真实组播路径上的自回声），
> 一条是**接口收紧**（上一轮说「生产构造器一律 `with_local`」，本轮让这句话由编译器保证）。

| # | 边界（上一轮的说法） | 本轮处置 | 实测证据 |
|---|---|---|---|
| 1 | 「跨板卡组播待现场验证」 | 新增 `AMOS_LINK_BEACON_IFACE`（本机 IPv4）：**出向** `set_multicast_if_v4`、**入向** 组加入绑定到同一接口。多网卡板子上「内核挑一个」不是决策：信标可能从 5G 模组出去，而相机板在 Wi-Fi 上；组加入绑到 `0.0.0.0` 只在**默认接口**订阅 —— 两者永远碰不上 | `tests/lan_multicast.rs`（真组播、真接口）：组加入 + `spawn_announcer` + 收帧，**每一拍都是新时间戳**；`AMOS_LINK_BEACON_IFACE=127.0.0.1 amos-link-cli discover --lan …` ⇒ `beacon iface=127.0.0.1 loop=platform-default`，且仍 `filtered 2 entries naming this node itself`；`en0` 这类**错值在启动期被拒**（`is not an interface IPv4 address`） |
| 2 | 「组播回环是平台默认，本轮不改 socket 选项」 | 新增 `AMOS_LINK_BEACON_LOOP`（**默认仍是平台默认**）。关闭它**不是**正确性机制：`IP_MULTICAST_LOOP=0` 会连**同机第二个进程**都收不到（内核根本不把数据报复制回本机），所以「节点不是自己的对端」仍由**对端表**保证 | 同一个套接字形状：loop 开 ⇒ 自己的信标**真的回来了**（并喂给 `PeerRegistry::with_local` ⇒ `observe==false`、`self_entries_refused()==1`、表为空）；loop 关 ⇒ 300 ms 内**一帧都没有**（同测试内互为阳性对照） |
| 3 | 「`PeerRegistry::new`（无身份）仍接受一切 —— 那是单元测试要的形状」 | **让 API 保证它**：`new` 变成 `#[cfg(test)] pub(crate)`，并且**删掉 `impl Default for PeerRegistry`** —— `Default` 是标准 trait，`PeerRegistry::default()` / `.unwrap_or_default()` / 下游 `#[derive(Default)]` 都能在**生产构建**里造出那张「接受一切」的表 | **负控（编译期）**：往非测试代码里写一个 `PeerRegistry::new(DEFAULT_TTL)` 调用 ⇒ **构建失败**（`no associated function named 'new'`）。删掉 `new` 时暴露的正是那条路：`impl Default` 是**唯一**的生产调用方 |

**Zenoh 真会话往返（同轮收口）**：原先是 `#[ignore]`，理由是「开真会话（peer + 组播 scouting）依赖环境」。
本轮把它拆开：**会话往返本身可以确定**——同进程两个 peer、显式端点、关掉 scouting，走真实 TCP 环回
（`a_typed_frame_crosses_a_real_session_over_tcp_loopback`，已**不再 ignore**）；留在 `#[ignore]` 的只剩
*跨主机 scouting*（`scouting_finds_a_peer_on_a_real_network`）。**顺带查出一个被 `#[ignore]` 掩盖的事实**：
`#[tokio::test]` 默认 **current-thread** 调度器，而 Zenoh 运行时在其上**直接 panic**
（"Please use multi thread scheduler instead"）—— 旧用例在任何机器上都**不可能通过**；`#[ignore]` 让它
既没红也没绿。**负控**：把调度器改回默认 ⇒ 该用例 FAILED（Zenoh 的 panic 原样复现）。


**门禁覆盖（同轮查出并修掉的第 8 个缺陷）**：新增的真组播测试是 `tests/lan_multicast.rs`，整份文件被
`#![cfg(feature = "lan")]` 门住；而 Makefile 里那条 lan 步骤写的是 `… --features amos-link/lan --lib`
—— **`--lib` 会把集成测试目标排除在外**，于是这份文件写了、评审了、**执行了零次**：
`feature-test-scan` 只查"特性门住的模块/测试项"（`tests/` 明确写在范围外），`feature-surface-scan` 只要求它
**被编译**。本轮给前者加了**规则 3**（`targetGate()` + `runsTarget()`：既要求启用特性，也要求步骤**没有**用
`--lib` 限制目标、或点名 `--test <name>`），selftest 从 23 例扩到 **33 例**；新规则**当场抓出仓库里另外两处
同形状的既有缺陷**——`crates/amos-power/tests/closed_loop_linux.rs`（`--features linux --lib` 从未跑它）
与 `crates/amos-asr/tests/sherpa_buffer.rs`（`gated-check` 里只有 `cargo build --features sherpa`，
**建了不跑**）。三处一起修，负控是"改回 `--lib`/删掉步骤 ⇒ 门 EXIT=1 且点名那个文件"。


### 3.7 信任边界：回程载荷与"按对端建表"（第四轮，REQ-A244）

> 前三轮查的是"分配 · 等待 · 上报的数字"。本轮查的是另一条：**谁的数据被当成事实存下来**。
> 两个缺陷都同一形状——**键或值来自线缆**，而代码把它们当本地量处理。

| # | 缺陷（修前） | 为什么是缺陷 | 处置 |
|---|---|---|---|
| 1 | **回程报告不受校验**：`ActuationState`（`amos/<robot>/state/actuation` 的载荷）直接 `Deserialize`，控制面把 `frames`/`watchdog_ms`/`last_refusal.reason` 原样存进表、原样交给 UI/CLI | 这份数据**来自另一个对端**（信任边界），而它有三个"下游已经假定有界"的字段：`frames` 要进 proto 的 **u32**（`proto_actuation` 用的是 `state.frames as u32`——**静默截断**，`2³²+3` 会显示成 `3`，正是 REQ-A241 在 `PublishReply` 上修掉的同一类）、`watchdog_ms` 会被当作"看门狗周期"展示、`reason` 会被**存下来并渲染**（帧上限 16 MiB 对一个"给人看的句子"太宽松） | 照本 crate 既有先例（`JointId`/`MotorFrame` 的 `try_from` wire 形态）给 `ActuationState` 加**线缆形态校验**：`MAX_ACTUATION_FRAMES = 4096`、`MAX_WATCHDOG_MS = 3_600_000`、`MAX_REFUSAL_REASON_BYTES = 512`；越界即**解码失败**——订阅侧计数（`decode_errors`）并跳过，**绝不进表**。`proto_actuation` 的映射同时改为饱和（`count_to_u32`），把"下游字段装不下"这件事写出来而不是假定 |
| 2 | **`SeqTracker` 按对端无界建表**：`BTreeMap<PeerId, u64>` 的键是 `envelope.header.publisher`，即**线缆上的任意 1..63 字节 token**，而它没有上限 | 一个（恶意或坏掉的）对端每帧换一个 id（`p1`、`p2`…）就能让长跑的消费者内存无界增长。本 crate 的同类资源早有先例：broker 的话题清单有 `MAX_TRACKED_TOPICS` + `topics_complete()`（Power of 10 #2"静态有界资源"） | `MAX_TRACKED_STREAMS = 4096`（与话题上限同一量级）：满表时**拒绝新增**并返回 `SeqEvent::Untracked`、计入 `SeqSummary::untracked`，summary 用 `is_complete()` **如实声明自己不再完整**——"我们停止记账"绝不能被读成"这条流很干净"。已在表里的对端照常记账（上限不能破坏健康路径）。CLI 的 `sub`/`watch` 现在打印 `untracked=` 与 `tracking=complete|full` |

**实测证据**：

```text
# 一条真实链路上的恶意回程（tests/link_e2e.rs）：谎报 frames=usize::MAX 的帧先发，再发一条正常报告
watcher.recv() ⇒ 正常报告（恶意那条被跳过）
watcher.stats().decode_errors == 1     # 被拒绝且**计数**，不是静默丢弃
reports.seq() == 2                     # 两帧真的都上了线（拒绝发生在解码处，不是发布处）

# 线缆形态（tests/… robot_hal::tests）
MAX_ACTUATION_FRAMES + 1  ⇒ 解码 Err（错误里带边界数字）
MAX_ACTUATION_FRAMES      ⇒ 解码 Ok（边界本身合法，防 off-by-one）
u64::MAX 的 watchdog_ms   ⇒ 解码 Err
MAX_REFUSAL_REASON_BYTES+1 的 reason ⇒ 解码 Err

# 追踪表（sequence::tests）：填满 4096 个对端后再来一个新 id
observe("one-too-many") ⇒ SeqEvent::Untracked { seq: 1 }；streams() 仍 = 4096
is_complete() == false；untracked == 1
observe("p0", 2) ⇒ SeqEvent::InOrder（已知对端照常）
```

**负控实测**（3/3，每次注入后 `cmp` 还原**逐字节一致**）：

| 注入的旧行为 | 新验证的反应 |
|---|---|
| 去掉 `ActuationState` 的线缆校验 | `an_actuation_report_off_the_wire_is_validated_not_trusted` ⇒ **FAILED**；`a_hostile_actuation_report_is_refused_and_counted` 同样变红 |
| `proto_actuation` 改回 `frames as u32` | `an_actuation_report_maps_to_the_wire_without_wrapping` ⇒ **FAILED**（`2³²+3` 读成 3） |
| 去掉 `SeqTracker` 的表上限 | `a_full_tracker_refuses_a_new_publisher_and_says_so` ⇒ **FAILED**（表越过 4096 继续长） |

**诚实边界（本轮新增）**：`MAX_ACTUATION_FRAMES`/`MAX_WATCHDOG_MS`/`MAX_REFUSAL_REASON_BYTES` 是**工程上界**而非物理定律——一台关节特别多、或做多步规划的机器若真超过 4096 帧/动作，需要在同一处上调（并同步 proto 的 u32 约定）；`SeqTracker` 的 4096 对端同理，满表后的"拒绝"是**有界策略**，不是"丢掉了坏数据"（`untracked` 计数与 `is_complete()` 就是它的如实出口）；线缆校验只覆盖这三个字段，`seq` 是任意的 `u64`（它本来就没有上界语义）。


## 4. Zenoh 集成审计（**实际用了什么、没用什麼**）





依赖声明（`crates/amos-link/Cargo.toml`，可选依赖、默认构建不拉）：

```toml
zenoh = { version = "1.10", default-features = false,
          features = ["transport_tcp", "transport_udp", "transport_unixsock-stream"],
          optional = true }
```

**为什么关掉 default features**：Zenoh 的默认特性集包含 QUIC / TLS / WebSocket / 插件 / 压缩 /
多链路（`auth_pubkey`、`transport_quic*`、`transport_tls`、`transport_ws`、`plugins`…）。机器人链
路需要的是 **TCP（有线/5G 回程）+ UDP（局域网）+ 本机 UDS（板内快路径）**；其余不进二进制。

| Zenoh 能力 | 用了吗 | 本仓的位置 / 说明 |
|---|---|---|
| **Session（`zenoh::open`）** | ✅ 用 | `ZenohTransport::open()`：`Config::default()`（**不 pin 模式、不写死 endpoint**，让 Zenoh 自己解析默认的 peer 模式 + 组播 scouting） |
| **Key expression 语法（`*` / `**`）** | ✅ 用（同构复用） | `keyexpr.rs` 自己实现并校验同一套语法，**原样交给 Zenoh**：进程内 broker 与跨网 Zenoh 对同一模式给出同一行为 |
| **`Session::put`（发布）** | ✅ 用 | `Transport::publish`：一次 `put`，无长生命周期 publisher（控制话题 1 Hz，不值得为它维持句柄） |
| **`declare_subscriber` + Handler** | ✅ 用（**QoS 映射的真实落点**） | `Reliability::BestEffort → RingChannel`（满则丢，与「最新帧胜」一致）、`Reliability::Reliable → FifoChannel`（满则阻塞 Zenoh 线程 = 背压） |
| **组播 scouting（无 IP 列表发现）** | ✅ 用（默认开启） | 跨节点发现的本体；`AMOS_LINK_ZENOH_ENDPOINT` 可显式指定 `tcp/host:port` 列表用于锁定网络 |
| **总线联邦（信标走链路自身）** | ✅ 用（本仓新增） | `BusDiscovery`/`spawn_federation`：在 `amos/*/telemetry/beacon` 上收发 `Beacon`，与数据同路 ⇒ **Zenoh 场景下对端表终于被填满**（此前只有会话、没有 peer 表）；自身回声被过滤并计数 |
| **`ZBytes` 零拷贝载荷 / shared-memory** | ❌ 未用 | 我们走 `to_vec()`：`Envelope` 已经是一段自校验字节，SHM 需要两侧同机同版本约定，收益不抵复杂度（列入 §6 的后续项） |
| **query/reply、liveliness、admin space** | ❌ 未用 | 数据面只需要 pub/sub；节点存活由**我们自己的心跳 + TTL 注册表**表达（与 `amos-timesync` 的时钟配合可测真实延迟） |
| **router（`zenohd`）、plugin、TLS/QUIC/WS、multilink、compression** | ❌ 未用 | 去中心化的 peer 模式不需要 router；跨公网/加密属于部署决定，不是内核默认（`--features zenoh` 不带这些依赖） |
| **zenoh-pico（MCU 版）** | ❌ 未用（**边界**） | 本仓是 Rust 主机/板卡端中间件，**不编译到 MCU**；RK3576 上跑的是本 crate 的 Linux 二进制。MCU 直连属于另一条产品线，需要 pico 的 C 端与 AmOS-Link 的 key/帧格式对齐（§6） |
| **`unstable` 特性 / 逐调用 `Reliability`** | ❌ 未用 | Zenoh 的 per-call 可靠性藏在 `unstable` 后；本 crate 的诚实做法：**链路可靠性**取传输默认（TCP/UDS 可靠、UDP 尽力而为），**我们保证的是本地消费队列的 QoS**（`depth` 直接映射到 Handler 容量）。这条边界写在 `zenoh.rs::network_reliability_note` 的文档里，而不是含糊过去 |

**测试现状（诚实）**：`lan` 与 `zenoh` 的**离线**用例进入 `make test`
（`cargo test -p amos-link --features amos-link/lan --lib`、
`cargo test -p amos-link --features amos-link/zenoh --lib`），`lan` 的用例在**回环地址**上收发真实
UDP 信标；真实 Zenoh 会话的往返用例（两个订阅者 + 一次发布）以 `#[ignore]` 标注——
它需要可用的组播/网络环境，`cargo test -p amos-link --features zenoh -- --ignored` 可在联网机器上手动跑。
**默认 CI 不会伪造这条证据**。

## 5. 控制面（`proto/robot_link.proto`，5 个 RPC）

| RPC | 作用 | 关键实现细节 |
|---|---|---|
| `GetStatus` | 身份/角色/版本/uptime/时钟是否已校准/计数器/对端表/**健康判定与原因**（§3.2） | 由 `LinkNode::status()` 直出，`clock_synced` 决定「延迟数字能不能当真」；`health` 在**没有证据**时是 `UNKNOWN`，绝不冒充健康 |
| `ListTopics` | 传输见过流量的话题清单 | 网络传输回答「不知道」（`Vec::new()`），不伪造空列表 |
| `Publish` | 由非 Rust 节点注入原始负载 | daemon 用自己的 peer id、独立序号与（已校准的）时钟封装成真正的 `Envelope`，因此**类型化订阅者照样能解** |
| `StreamHeartbeats` | 服务端流式心跳 | 直接把 `amos/*/telemetry/beat`（**每个** peer 的心跳，含自己）的订阅转发给 gRPC 客户端——传输的是链路上**真的收到过**的帧，不是合成计数器；「到底谁在线」由 `GetStatus` 的对端表回答。**「含自己」是实装的**：`LinkService::with_heartbeat`（`mock_server()` 用的就是这个形状）会为挂载的节点起心跳任务，所以 daemon 自己也真的在 `amos/amos-daemon/telemetry/beat` 上打拍——否则这条流**一帧都发不出来**，而「没有证据」与「链路健康但安静」在流上长得一模一样（证据：`crates/amos-ai/tests/link_rpc_e2e.rs::the_daemon_link_node_beats…`） |
| `ListActuations` | **回程**：每个机器人自报的 `armed`/`estopped`(+原因)/`gait`/最近一次拒绝 | 数据面在 `amos/<robot>/state/actuation`，控制面**订阅并折叠**它们（`LinkService::with_heartbeat` 起的 watcher），让**不在链路上**的调用方（System UI、CLI）也能读到。三个诚实点：**(a) 按帧头 `publisher` 归属**（谁发布谁是机器人），不信负载自称；**(b) 一张快照表，按 id 排序**，同一机器人后来的报告覆盖旧的；**(c) 没上报过的机器人是「不在列表里」，不是「空闲」**——`mock_server` 刚起来时它是空的，而空 ≠ 全员空闲 |

挂载点：`amos-ai/src/server.rs` 的 `serve()` 里 `.add_service(amos_link::service::mock_server())`，
与 AiAgent/Sensor/Telephony 同一条 UDS；证据是 `crates/amos-ai/tests/link_rpc_e2e.rs`（真 UDS 往返）。
`mock_server()` 挂的是**带心跳**的服务（`LinkService::with_heartbeat`）；`server(node)` 把「谁负责让节点打拍」留给调用方（跨板卡部署通常在 `spawn_heartbeat` 之外还要 `spawn_federation`）。

## 6. 环境变量与边界（老实说）

| 变量 | 作用 | 读取处 |
|---|---|---|
| `AMOS_LINK_PEER` | 默认节点 id（`--peer` 优先） | `crates/amos-link-cli/src/lib.rs` |
| `AMOS_LINK_BEACON_ADDR` | LAN 信标目标（`ip:port`，默认 `239.255.42.99:7446`） | `crates/amos-link/src/lan.rs` |
| `AMOS_LINK_BEACON_IFACE` | LAN 信标**固定到哪个接口**（本机 IPv4 地址，如 `192.168.1.5`；出向 `IP_MULTICAST_IF` + 入向组加入都绑到它）。多网卡板子必须设，否则「内核挑一个」可能让信标从 5G 出去而相机板在 Wi-Fi 上；**错值在启动期拒绝** | `crates/amos-link/src/lan.rs` |
| `AMOS_LINK_BEACON_LOOP` | 组播回环开关（`1`/`0`，默认 = 平台默认即开）。关掉会让**本机所有进程**都收不到自己的信标（不只自己），因此**不是**正确性机制（对端表才是）| `crates/amos-link/src/lan.rs` |
| `AMOS_LINK_ZENOH_ENDPOINT` | Zenoh 连接点（逗号分隔，如 `tcp/10.0.0.7:7447`） | `crates/amos-link/src/zenoh.rs` |

**明确不做的事**（避免把边界留给想象）：

1. **不是 ROS 兼容层**：没有 `.msg`/IDL 解析、没有 `rostopic` 兼容、没有 DDS 线路。要在 ROS 生态里
   出现，需要另写桥接（Zenoh 官方有 ros2dds 插件，属于部署组件，不进内核）。
2. **不是调度器**：`LinkNode` 不会替你起控制线程；`RobotBridge::step()` 是显式的一步，线程/频率由调用方
   （真实产品里是 50–100 Hz 的控制任务）决定。
3. **发现不认证**：`lan` 的信标是明文广播，任何人都能伪造（它只是「去连我」的提示）。**认证路径是
   daemon 的 UDS**（`amos-ai` 的 peer-credential 检查），不是这条信标。
4. **shm / pico / `unstable` QoS / 加密传输**：见 §4 表格的 ❌ 行，都是有意的未做项。
5. **System UI 的"链路面板"——已建成（本条原来的"未做"已兑现）**。历史上本条记录过：本 crate 的模块文档曾把
   "System UI 的链路面板"写成一个消费者，而 `crates/amos-tauri` 与 `src/` 里**零** `amos_link`/`robot_link`
   引用 —— 那是一句"承诺了不存在的消费者"，当时 GUI 面板属于**未做**，并记下了兑现它需要
   "Tauri 命令 + 界面 + i18n + 界面用例一起落地"。现在它成套存在：
   `crates/amos-tauri/src/link.rs` 的 `link_status`（读 `GetStatus`，把 prost 结构映射成可序列化快照）+
   设置页 `frontend-ts/src/svelte/settings/LinkPage.svelte`（经 `SettingsApp` 的「机器人链路」行进入）+
   `lib/link.ts`（纯函数 + 离线契约）+ en/zh 文案 +
   两份用例（`svelte-tests/link-page.svelte.test.ts`、`src/__tests__/link.test.ts`）。
   **它只读、不指挥**（发布是 CLI/工具的事），并且**原样带出守护进程的判定**：`unknown`（暂无证据）**不等于**
   `healthy`，时钟未校准会明确说"延迟只是上界"，计数器标明是自启动累计。
   **（本轮补全）它现在也读"回程"**：`link_status` 同时调 `ListActuations`（§5），所以「机器人链路」页在
   实时的对端表之下还列出**每台机器人自报的状态**——armed / 已切扭矩(+原因) / 当前步态 / 最近一次被拒绝的指令
   （连"怎么恢复"都带出来）。这一栏的诚实点写进了界面文案：**没上报过的机器人不在列表里（那不是"空闲"）**，
   而且列表是**快照不是历史**；老版本的 daemon 没有这个 RPC 时，界面只是少显示一栏、不报错。
   **诚实边界**：面板读的是守护进程**控制面**的状态；数据面（传感器帧、关节设定点）不经过它，
   也不经过任何 gRPC —— 回程能被看到，是因为**守护进程订阅了数据面并把它折叠进控制面**，而不是因为 UI 自己上了链路。
   **同步改口的地方**：`amos-link/src/service.rs` 的模块文档、`amos-link-cli` 的 `run_watch` 文档、
   `link_rpc_e2e.rs` 的用例注释（它们原先都写着"没有 GUI 消费者"）。

## 7. 验证入口

```bash
make test                     # 含 amos-link 的 lan/zenoh 特性用例、link_e2e / service_uds / cli_smoke
make lint                     # 含 -p amos-link --features lan|zenoh 的 clippy -D warnings
cargo test -p amos-link       # 内核 + 端到端用例（默认构建）
cargo run -p amos-link-cli -- bench --count 2000 --size 4096
cargo run -p amos-link-cli -- status   # JSON：含 health 判定与 health_reasons（§3.2）
cargo run -p amos-link-cli -- motor --action '{"action":"trot","speed":0.5}'
# 真总线（REQ-A243）：控制器套接字或字符设备；末行报的是**真的写出去的帧数**（§3.5）
cargo run -p amos-link-cli -- motor --action '{"action":"stand"}' --device /run/motor.sock
AMOS_LINK_BEACON_IFACE=192.168.1.5 cargo run -p amos-link-cli --features lan -- discover --lan --seconds 9
# ↑ 多网卡板子固定接口；输出会如实打印 `beacon iface=… loop=…`（应用后的配置，不是请求的）
cargo test -p amos-link --test hardware_hal           # 真字节流上的 HAL（真实套接字 + CRC16 逐帧解码）
cargo test -p amos-link --features lan --test lan_multicast   # 真组播：固定接口、自回声、回环开关
cargo test -p amos-link --test allocation_budget_codec        # 三个分配预算，一个进程一个测量
cargo test -p amos-link --test allocation_budget_matcher
cargo test -p amos-link --test allocation_budget_fanout       # 一次发布 ⇒ 8 个订阅者：共享同一缓冲
cargo run -p amos-link-cli -- sub --pattern 'amos/**' --count 5 --timeout-ms 2000   # 末行报告 gaps/missing/stale/loss
cargo run -p amos-link-cli -- sub --pattern 'amos/*/control/*' --count 1 --timeout-ms 1000  # 档位由 channel 决定（reliable）
# 注意 `--timeout-ms`：默认 0 = 永远等，没有发布者时这条命令**不会返回**（本文件的示例一律给上界）。
cargo run -p amos-link-cli -- state --timeout-ms 2000   # 回程：机器人自报的模式（armed/estopped/gait/拒绝）
# 注意：`sub`/`state` 订阅的是**本进程**的 broker；要看**另一个进程**（板卡）说了什么，
# 用 `--transport zenoh`（真网络），或者板卡侧自己跑 RobotBridge + reporting。
cargo run -p amos-link-cli -- discover --peer dog1 --kind robot --lan --seconds 9   # 真 UDP 信标（重复广播）
cargo run -p amos-link-cli -- discover --peer field-brain --lan --seconds 5         # 另一个进程：两台互相看得见
cargo run -p amos-link-cli -- discover --bus --seconds 3   # 联邦：链路自身的对端表
cargo run -p amos-link-cli -- discover --bus --seconds 3 --transport zenoh  # 跨板卡（需 zenoh feature）
cargo run -p amos-link-cli -- watch --seconds 5            # 心跳 + 联邦：「链路还活着吗」
# 远程模式（`--socket`）：读的是**运行中的节点**（daemon 挂的控制面），不是本地临时节点。
# status/topics/pub/watch 支持 `--socket`；sub/bench/discover 需要本地数据面，会被点名拒绝。
cargo run -p amos-link-cli -- status --socket /tmp/amos-ai.sock --json   # 真实 daemon 的身份/计数器/健康/**机器人自报状态**
cargo run -p amos-link-cli -- status --socket /tmp/amos-ai.sock          # 人类可读：含「robots reported (N)」一栏
cargo run -p amos-link-cli -- topics --socket /tmp/amos-ai.sock          # daemon 自己那条传输见过的话题
cargo run -p amos-link-cli -- pub --socket /tmp/amos-ai.sock \
    --topic amos/dog1/control/joints --action '{"action":"trot"}'
cargo run -p amos-link-cli -- watch --socket /tmp/amos-ai.sock --seconds 3  # 流式心跳：真的在打拍
cargo test -p amos-link --features zenoh --lib a_typed_frame_crosses_a_real_session_over_tcp_loopback
# ↑ 真会话往返（两个 peer + 显式端点 + 关 scouting，走 TCP 环回）——**不再是 #[ignore]**（§3.6）
cargo test -p amos-link --features zenoh -- --ignored   # 只剩跨主机 scouting（需真网络）
# 联邦信标节奏 = TTL/3（`federation_period()`，一处规则；默认 TTL 3s ⇒ 每秒 1 个信标）。
# 此前 `discover --bus` 与 `watch` 硬编码 200ms（5 个/秒），既多打 4 倍信标，又让
# `published` 看起来像有真实流量 —— 现在三条路径（lan/bus/watch）同一条规则。
# System UI 的链路面板（只读）：设置 →「机器人链路」，读运行中的 daemon。
cd crates/amos-tauri/frontend-ts && bunx vitest run svelte-tests/link-page.svelte.test.ts
```

**操作员输入的两个上界**（都在**解析期**拒绝，exit 2，绝不 panic / abort —— 见 §3.3）：

```bash
# 窗口超出本平台时钟可表示的范围：exit 2 + 说明，而不是 "overflow when adding duration to instant"
cargo run -p amos-link-cli -- discover --bus --seconds 18446744073709551615
# 载荷超过线上限（16 MiB − 64）：exit 2，而不是跑一场每次发布都注定失败的 bench
cargo run -p amos-link-cli -- bench --size 16777216
# 合法的大计数仍然照跑（"一直发"是操作员自己的请求），但不会再在预留 latency 向量时 abort
cargo run -p amos-link-cli -- bench --count 18446744073709551615
```

