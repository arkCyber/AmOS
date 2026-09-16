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
| `codec` | `Message`（任意 serde 类型，bincode 载荷）、`Envelope`（magic+版本+bincode 头+CRC32）、`Timestamp`、`Clock`；**帧大小上限** `MAX_PAYLOAD_BYTES = 16 MiB` | 头里带 **topic / publisher / seq / 时间戳**：通配订阅者因此知道「这是谁、第几帧、多久之前」。上限在 **encode 与 decode 两侧**都检查，且**先于任何分配**校验头部声称的长度（伪造 4 GiB 头不会让接收端分配）。头里的 `topic` 只是**发布者的声明**：订阅侧拿它与**传输的路由键**逐字比对，不一致即拒（否则一个对端可以在 `amos/evil/…` 上发布却声称自己是 `amos/dog1/…`）。**头里每个字段都在线缆那一侧被重新问过一遍**（`Header::validate`，§3.8）：`Deserialize` 从不调用 `Topic::new`/`PeerId::new`/`Timestamp::new`，所以 decode 不会发出「自己的构造器会拒绝」的值（400 字节的 `publisher`、`nanos=4e9` 的 `stamp`）——版本号则照旧只认 `VERSION`，其它带具名原因拒绝 |
| `qos` | `Reliability{BestEffort,Reliable}` × `depth` × `DropPolicy{DropNewest,DropOldest}`，预设 `Qos::sensor()` / `state()` / `control()`，以及 **`Qos::for_channel(Channel)`**（channel → profile 的**唯一**策略表） | 传感器流=`depth 1 + drop-oldest`（**最新帧胜**）；控制流=`Reliable`（**背压，不丢**）。`for_channel` 让「订阅 `amos/*/control/**` 却拿到 best-effort 档」这种**静默丢控制指令**的错误在类型层面就有正解（CLI `sub` 默认即用它，并打印档位来源） |
| `broker` | `Transport` seam + 进程内 `Broker`：按订阅者独立队列、`Arc<[u8]>` 扇出（不复制大帧）、从不在持有锁时 await；话题清单**有界**（`MAX_TRACKED_TOPICS = 4096`，满了即停止增长且 `topics_complete()` 如实回答 false） | 与 `amos-sensor` 的 provider seam 同一纪律：哑核心 + 可替换后端。有界清单是 Power of 10 #2（静态有界资源）：一个不停发明主题名的发布者不能让诊断集合随进程寿命无限增长；**发布永不因记账上限失败**，而清单**自己声明不完整**（绝不用一个看起来完整的列表撒谎） |
| `discovery` | `Beacon`（`AMLB │ ver=2 │ body_len │ CRC32 │ bincode` 帧）+ `PeerRegistry`（TTL 过期、按新鲜度排序、**静态对端永不过期**）+ `MockDiscovery` + **`BusDiscovery`/`spawn_federation`**（信标走链路自身传输：`amos/<peer>/telemetry/beacon`） | 注册表是**纯状态机**（时间作为参数传入）。信标帧带**长度 + CRC32**，且**两侧都检查**（`encode` 拒绝自己造出超限帧，`decode` 先于任何反序列化拒绝伪造长度/超限帧/CRC 不符），`PeerInfo::validate` 限制端点数量与长度 ⇒ 一条被损坏的「我是谁、来哪连我」不会变成一条被静默信任的假对端。版本 2 之前的节点会被**按版本拒绝**，而不是喂进另一种布局的 body。**静态对端**（`learn_peer`，锁定网络里没有组播）没有信标可错过，因此**不受 TTL 驱逐**（只会被 `forget_peer` 移除，或被它自己的信标转成被 TTL 管理的动态对端）；`learn_peer` 也**不会抹掉已测得的活跃度**（改端点不会把死板卡变活）。总线联邦让**任何传输**都能填满对端表（含 Zenoh），并**过滤自身回声**（节点绝不把自己当 peer） |
| `lan`(feature) | `LanDiscovery`：UDP 组播信标（默认 `239.255.42.99:7446`，`AMOS_LINK_BEACON_ADDR` 覆盖），`SO_REUSEADDR/PORT` 让同机多进程共用一个端口；`spawn_announcer` **按周期重复**广播（不是开机喊一次） | 明文、未认证：这是**发现的提示**，不是身份证明（见 §6）。数据报上限（`MAX_DATAGRAM` 1024B）之外还有帧上限 `MAX_BEACON_BYTES = 512`：外来/超限/篡改报文一律被跳过而不是解析。**为什么要重复**：信标是收方唯一的证据，而证据会随 TTL 过期——只喊一次的节点**只有已经在听的**对端能发现（开机跑起来的机器狗、或一分钟后才入网的场边笔记本，都会看不见它）。周期由调用方给（CLI 用 TTL/3，与 `spawn_federation` 同一条规则：喊得比这更稀，别的表就会看到「加入—过期」反复循环 = 一个扑腾的节点）；每拍都带**新的** `Timestamp`（活着的对端不该一直自称"我刚开机的那一秒"） |
| `telemetry` | `Heartbeat`（`amos/<peer>/telemetry/beat`，1 Hz）+ `NodeStatus`（JSON 自查）+ `spawn_heartbeat` | 心跳是**消息**，走同一条 pub/sub 通道，因此 `topics` 里看得见。`NodeStatus` 里的话题清单**与它的完整性同一份值**（`topics` + `topics_complete`，§3.8）：机器读 `status --json` 时，一个撞了 4096 上限而停止增长的清单不会读成「这条链路有 4096 个话题」，网络传输的空列表也不会读成「没人发布」 |
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
每个订阅自己的 `dropped`（`SubscriptionStats`）覆盖**全部**"路由到它、但谁也没拿到"的路径：best-effort
队列满、一次性槽被更新帧顶掉、以及**消费者在发布中途消失**（关闭或锁中毒）——**REQ-A247 修掉了最后一条**：
`Reliable` 的一次性槽拒绝路径此前只进 `PublishReport`/`metrics`，**没有**记进该订阅自己的计数器，
于是 `sub.stats().dropped` 会对一个丢帧的订阅报 0（"计数器由知道事实的那一层写"这句话，当时对这条路径不成立）。

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
`SeqSummary` 传进来）、`untracked_frames=N`（追踪表撞了上限，这 N 帧**在损失数字之外** —— 判决不得比仪器更
干净，§3.9）、`no_peers`（链路上只有自己）、`clock_unsynced`（延迟数字是**上界**，不是测量）。

**刻意不算原因：`dropped`。** best-effort 流的丢弃**就是策略在工作**（最新帧胜会覆盖自己的队列），把它算进
结论会把一台健康机器人判成「降级」—— 结论不替调用方解释丢弃，`metrics.dropped` 原样给出。

**序号是饱和的，不是回绕的。** `telemetry::next_seq`（全 crate 唯一的序号源：`Publisher` 的帧序号、节点心跳、控制面 `Publish`）用 compare-exchange 在 `u64::MAX` 处停住 —— `fetch_add(1) + 1` 在极值处会把存储值回绕成 0，于是「刚盖出去的戳」比计数器还大、后续帧重新用 1、2…，消费端的 `SeqTracker` 会把它读成「发布者重启了」（一个凭空编出来的故事）。饱和则让**盖出去的戳与读到的计数器始终一致**。

**边界**：节点只能看见**自己**的计数器，看不见某个消费者的序列跳变（那是订阅级状态）；CLI `watch`
手里正好有 beat 的 `SeqTracker`，因此它的结论比 `status` 多一条 `frame_loss`（以及满表后的 `untracked_frames`）
—— 后者需要调用方把 `SeqSummary` 传进 `evaluate`。控制面 `LinkStatus.health`（枚举）+ `health_reasons`（每条带数字的 token）
把同一结论送到非 Rust 客户端 —— 而**这套 token 词汇现在也是内核 `status --json` 与 CLI `watch --json` 的词汇**
（§3.11：一处判决只有一种拼法）。

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

### 3.8 线缆形态的再校验 + 清单一并声明自己完整与否（第五轮，REQ-A245）

> 本轮审计面是上一轮结尾登记的五个未深读处：`codec` 的解码路径（版本协商 · `Timestamp` 边界）、
> `keyexpr` 的长度/段数边界、`broker` 中段（`publish` 的队列策略 · `try_recv` 边界）、
> `telemetry` 的 `NodeStatus` JSON、以及 System UI 侧（`amos-tauri/src/link.rs` + `LinkPage.svelte`）。
> 两个真缺陷，同一句话就能概括：**类型自称"构造时校验过"，但 `Deserialize` 从不调用构造器**；
> **清单自称有界，但"是否完整"这句话只走到了一半**。

| # | 缺陷（修前） | 为什么是缺陷 | 处置 |
|---|---|---|---|
| 1 | **线缆上的头字段绕过各自的构造器**：`Header`（`topic` / `publisher` / `stamp`）与 `Beacon.peer.id` 都 `derive(Deserialize)`，而 `Topic::new`、`PeerId::new`、`Timestamp::new` 的校验**永远不会被执行**。实测（手工写字节，CRC 正确）：`publisher` 放 400 字节、含 `\n`、含 `/` 或空串 ⇒ `decode` 全部 `Ok`；`stamp.nanos = 4 294 967 295` ⇒ `decode` `Ok` | `PeerId` 的文档写着"构造时校验一次，其余代码可当作安全 token"——它是**对端表与追踪表的键**，也是每个 CLI/UI 渲染的字符串；`Timestamp::new` 守着"两种写法不能指向同一瞬间"的不变量（派生 `Ord` 比字段、`as_nanos`/`since` 比数值，只有 `nanos < 1e9` 时两者一致）。这两条承诺在**线缆这一侧**此前都是空的 | 每个带校验构造器的类型加一个**不分配的**检查入口（`Topic::validate_str` / `PeerId::validate_str` / `Timestamp::is_valid`，构造器改为调用它们 ⇒ 一处规则两个入口），`Header::validate` 在 `encode` **与** `decode` 两侧把这三个问题重问一遍，`PeerInfo::validate` 补上 `peer.id`。越界即 `LinkError::Frame` + **具名原因**（哪个字段、越了什么界） |
| 2 | **清单的"是否完整"只走到一半**：`NodeStatus` 有 `topics` 数组却**没有**完整性字段（CLI 的 `topics` 命令会打印提示，但 `status --json`——机器读的那一份——不会）；控制面的 `TopicList` 连字段都没有，于是**远端 `topics` 只打印条数**，把截断的清单当完整清单呈现 | 本 crate 的纪律是"有界资源必须自己声明"（`MAX_TRACKED_TOPICS` / `MAX_TRACKED_STREAMS` 都照此办理）。而远端调用方**不在那条传输上**，除了这个字段没有任何办法知道：`complete=false` 既可能是 broker 撞了 4096 上限，也可能是 Zenoh 这类网络传输"根本枚举不了"（空列表 ≠ 没流量） | `NodeStatus` 新增 `topics_complete`（与 `topics` 同一次从传输读取，两者不可能不一致）；`TopicList` 新增 `bool complete = 2`，`ListTopics` 用 `node.topics_complete()` 填；远端 `topics` 打印 `(inventory complete|incomplete — …)` |

**实测证据**（默认构建）：

```text
# (1) 手工写字节的头（tests 里用同布局的 shadow struct + 正确 CRC）：
publisher = "x"*400 / "amos/dog1" / "dog 1" / "dog1\n" / ""  ⇒ decode Err，原因里点名 `publisher`
publisher = "x"*63（边界本身）                                ⇒ decode Ok
stamp.nanos = 1_000_000_000 / 4_294_967_295                   ⇒ decode Err，原因里点名 `sub-second`
stamp.nanos = 999_999_999                                     ⇒ decode Ok
topic = "amos//imu" / "not a topic" / "amos/*/sensor/imu"     ⇒ decode Err，原因里点名 `topic`
# encode 侧同规矩：把 header.topic 改坏 / 把 stamp.nanos 改成 2e9 ⇒ encode Err（"线那边只会表现为什么都没到"）
# 真链路上的样子（pubsub，真实 broker）：伪造 publisher 的帧先发、正常帧后发 ⇒
  consumer 拿到的是**正常帧**（seq=2），sub.stats().decode_errors == 1、metrics.decode_errors >= 1

# (2) 完整性随行（节点层 + 控制面）：
LinkNode::with_parts(自定义传输，topics_complete()==false) ⇒ status().topics_complete == false，
  status.to_json() 里含 "topics_complete": false；in_process 的 broker ⇒ true 且与 topics() 一致
服务端 UDS 用例：list_topics() ⇒ topics 正确 **且** complete == true
cli_smoke（真 UDS + 真二进制）：topics --socket … ⇒ "…(inventory complete)"
amos-ai 的 link_rpc_e2e（daemon 挂载的真实控制面）：list_topics() ⇒ complete == true
```

**负控实测**（5/5，每次注入后 `cmp` 还原**逐字节一致**）：

| 注入的旧行为 | 新验证的反应 |
|---|---|
| 去掉 `decode` 里的 `header.validate()` | `a_header_off_the_wire_is_re_validated_field_by_field` ⇒ **FAILED**；`a_frame_off_the_wire_is_re_validated_before_it_is_believed`（真 broker）同样变红 |
| 去掉 `Header::validate` 里的 stamp 检查 | 上面两条 + `a_header_this_side_would_refuse_is_never_put_on_the_wire` ⇒ **FAILED**（两侧同规矩） |
| 去掉 `PeerInfo::validate` 里的 `peer.id` 检查 | `a_beacon_off_the_wire_is_re_validated_too` ⇒ **FAILED** |
| `NodeStatus::topics_complete` 写成常量 `true` | `the_inventorys_own_limit_travels_with_the_inventory` ⇒ **FAILED** |
| `ListTopics` 的 `complete` 写成常量 `false` | `control_plane_answers_over_a_unix_domain_socket` 与 cli_smoke 的 `remote_mode_reads_a_running_control_plane_over_a_unix_socket` ⇒ **FAILED** |

**同轮审计过但**（据实记录）**没有真缺陷的部分**：`codec` 的**版本协商**是有意缺失的——解码只认
`VERSION`，其它版本带具名原因拒绝（数据面不该为一次解帧做往返；用例已覆盖）；`keyexpr` 的长度/段数
边界自查一致（`MAX_SEGMENT = 64` × `MAX_SEGMENTS = 32`，`validate_str` 与 `new` 逐条对齐，测试用 12 个
正反例钉住）；`broker` 的 `publish` 在锁内只做"选中 + `Arc` 克隆"、`try_recv` 两条队列形状都如实回答
（有帧 / 无帧 / 已关闭）；System UI 侧 `link.rs` 的映射不发明任何值（未知枚举 → `"unrecognized"`、
proto 的 `0`/`""` → `None`）。

**诚实边界（本轮新增）**：
1. `Header::validate` 里的 **topic 检查对"已投递的帧"是冗余的**——`Subscriber` 在此之前已把帧头声明的
   topic 与传输的路由键逐字比对（`amos/evil/…` 上发布却声称 `amos/dog1/…` 会被拒）。保留它是为了让
   **`Envelope::decode` 这个公开入口**也满足"解出来的头是合法的头"，不是"修好了第二个漏洞"。
2. `encode` 侧的校验只防**本端 bug**（`Header` 的字段是 `pub`，手搓得出来）；对端写字节时当然绕过它——
   真正起作用的是 `decode` 侧。
3. `nanos ≥ 1e9` 的**危害是有限的**：时间戳本来就是发布者自报（谎报者可以随便填 `secs`）。修的是
   "解码器不得发出自己会拒绝的值"，而不是"时间戳可信了"。
4. 控制面仍未携带**话题清单本身**（`LinkStatus` 无 `topics` 字段，只有 `ListTopics` 有）——那是刻意的：
   清单是一次查询，不是一个常驻状态；本轮只补上它的完整性。
5. System UI 的链路面板的**一次读取**已经不是边界（**REQ-A246 已处置**）：读数带**读数时间**（`link.probe`）、
   打开且可见时每 10 秒重读、重读拿不到答案就**丢掉数字**（不把冻结的读数冒充当前的）。
   详细处置与负控见 **§6.6**。


### 3.9 心跳是第三种「带身份的线缆消息」+ 判决不得超出仪器（第八轮，REQ-A248）

> 起点是上一轮（§3.8）留下的一个**没问完的问题**：那张表只把**两种**「带校验构造器、却被
> `Deserialize` 绕过」的线缆类型点了出来（`Header` 与 `Beacon.peer.id`）。本轮把「哪些类型带着
> **构造期不变量**、又在线缆那一侧被解出来」逐个过了一遍 —— **`Heartbeat` 是第三个**；顺带查出
> 判决（`LinkHealth`）读的是一份**它自己知道不完整**的损失数字。

| # | 缺陷（修前） | 为什么是缺陷 | 处置 |
|---|---|---|---|
| 1 | **心跳载荷里的身份既没被校验、也没被对齐**：`Heartbeat { peer, seq, stamp, uptime_ms }` 是线缆载荷，`peer` 是 `PeerId`、`stamp` 是 `Timestamp`，而 `PeerId::new`/`Timestamp::new` **在解码路径上永远不会跑** | 两层：**(a)** 一个 `peer` 可以是 400 字节、含 `/`/换行/空串 —— 而它正是 CLI `watch` 打印、控制面 `StreamHeartbeats` 转发给每个 UI 的那个字符串；**(b)** 更实际的一层：心跳是**自描述**消息，而路由键是**话题**（本 crate 的规则：发布者在帧头里，不在话题里），所以一个对端可以在 `amos/dog1/telemetry/beat` 上发布、**让载荷自称 `dog1`**，而它自己的帧归属是另一个 id。CLI 会把**载荷**的 peer 打印出来（`beat peer=…`），却用**帧头**的 publisher 做顺序记账（`missed=`）—— 一帧两个身份；控制面则把载荷的自称送进每一个 UI。REQ-A244 早就为回程定过这条规则（**按帧头 publisher 归属、不信载荷自称**），心跳这条路径漏了 | 新增 `Heartbeat::validate(&self, attributed: &PeerId)`：**先**用 `PeerId::validate_str` 问身份本身（理由里点名 `beat peer`），**再**要求 `beat.peer == attributed`（帧头的、已校验的发布者；理由里同时点名两个 id），最后要求 `stamp` 满足与帧头同一条不变量（`nanos < 1e9`，否则 `age()` 量的是一个 `Ord` 与 `as_nanos` 各说各话的瞬间）。落点在**读取路径**上：新增 `Subscriber<Heartbeat>::recv_beat()`（与 `recv()` 同形：不可信就计数并跳过），控制面 `StreamHeartbeats` 与 CLI `watch` 都改走它 —— 规则只有一处，消费者不可能忘 |
| 2 | **判决读的是一份自己知道不完整的损失数字**：`LinkHealth::evaluate` 只看 `SeqSummary::has_loss()`，不看 `untracked` | `SeqTracker` 撞上 `MAX_TRACKED_STREAMS` 之后会**拒绝新增并计数**（`SeqSummary::untracked`、`is_complete()`）—— 它**自己声明**「我停止记账了」。而判决在这条路径上仍可能给出 `healthy`：**没有一个理由**，尽管损失数字只覆盖被记账的那部分。这正是本 crate 反复钉住的形状（**有界资源必须随行声明自己完整与否**，REQ-A244/A245 各钉过一次）。CLI 上还留下一个可见的不对称：同一行里 `beats_untracked=3` 与 `health=healthy` 并存 | 新增 `HealthReason::UntrackedFrames { untracked }`（key 与 detail 都是 `untracked_frames=N`），在 `frame_loss` 之后、`no_peers` 之前发出。判决的规则不变（仍是纯函数、每个理由带数字），变的只是它**不再比仪器更干净** |

**实测证据**（默认构建）：

```text
# (1) 心跳（telemetry::tests / pubsub::tests / tests/service_uds.rs）
手工写字节的 beat（影子结构体，bincode 布局与 Heartbeat 一致）：
  peer = "x"*64 / "dog/1" / "dog 1" / "dog1\n" / ""  ⇒ Heartbeat::decode **Ok**（bincode 不校验 id）
                                                     ⇒ validate(&dog1) Err，理由点名 `beat peer`
  peer = "dog1"，但帧归属是 impostor                  ⇒ validate Err（理由同时点名 dog1 与 impostor）
  stamp.nanos = 4e9                                  ⇒ validate Err（`sub-second`）
真链路上（pubsub，真 broker）：impostor 在 amos/dog1/telemetry/beat 上发一条自称 dog1 的 beat ⇒
  recv() 拿到的帧：message.peer == dog1、publisher == impostor   ← 这就是修前的两个身份
  recv_beat() 跳过它：拿到的下一条是 dog2 自己的 beat；sub.stats().decode_errors >= 1、metrics 同步 +1
控制面（真 UDS）：先发伪造 beat、再发诚实 beat ⇒
  GetStatus.metrics.decode_errors 先 +1（**这个顺序有意义**：计数发生在伪造帧被取走之后）
  StreamHeartbeats 的下一条是诚实的（seq 8 / uptime 43）；伪造的（seq 99 / uptime 999）**从未到达客户端**

# (2) 判决不得超出仪器（health::tests）
SeqSummary{ missing: 0, untracked: 3 } + 有证据的计数器 + 有对端 + 时钟已校准
  ⇒ Degraded { [UntrackedFrames { untracked: 3 }] }、summary = "degraded: untracked_frames=3"
  （对照：untracked = 0 时同一条输入仍是 healthy —— 未被触碰的追踪器是一份完整的账）
```

**负控实测**（4/4，每次注入后 `cmp` 还原**逐字节一致**）：

| 注入的旧行为 | 新验证的反应 |
|---|---|
| 去掉 `Heartbeat::validate` 里的**归属**检查 | `pubsub::tests::a_beat_that_names_another_peer_is_refused_and_counted`（真 broker）与 `control_plane_answers_over_a_unix_domain_socket`（真 UDS）⇒ **FAILED**（后者停在「伪造帧被计数」那条断言上） |
| 去掉**身份**检查（`PeerId::validate_str`） | `telemetry::tests::a_beat_off_the_wire_is_re_validated_and_must_name_its_publisher` ⇒ **FAILED**（理由不再点名 `beat peer`） |
| 去掉 **stamp** 检查 | 同上 ⇒ **FAILED**（理由不再点名 `sub-second`） |
| 去掉 `untracked` 理由 | `health::tests::a_partial_loss_figure_is_never_called_healthy` 与 `every_reason_fires_with_its_number_in_a_stable_order` ⇒ **FAILED** |

**诚实边界（本轮新增）**：归属检查是**一致性**检查，**不是认证** —— 一个连帧头都敢谎报的对端不在它的射程内（链路没有可诉诸的认证机制；对端表本身的信任边界见 §6 与 crate README 的「Discovery is not authentication」）。它保证的是更弱、但可测的那一条：**一帧一个身份**。心跳的 `stamp` 与帧头一样是**发布者自报**，校验只保证「解码器不会发出自己的构造器会拒绝的值」，不是「时间戳可信了」。`untracked_frames` 只在**调用方手里有 `SeqSummary`** 时可能出现（`GetStatus` 拿不到消费者侧的追踪器），所以它出现在 CLI `watch`/`sub` 这类**同进程消费者**的报告里，而不是控制面的判决里。**同轮如实记录**：`Heartbeat` 之外，还逐个核对了其余会走线缆的载荷类型（`Header`、`Beacon`/`PeerInfo`、`ActuationState`、`MotorFrame`/`JointId`/`RefusalReason`），它们各自的构造期不变量都已有线缆侧入口 —— 本轮没有再发现第四个。

### 3.10 CLI 的参数面：`--json` 处处兑现 + 「不能用的旗标不是静默忽略」（第九轮，REQ-A264）

> 起点是**没有测试背书的三句话**：USAGE 写「`--json`：`sub`/`watch`/`status --socket`」，
> README 写「`--device` 只属于 `motor`——别处是用法错误（exit 2），**绝不静默忽略**」，
> 而 `--device` 之外**再没有任何一条旗标受过同一条规则的约束**。本轮把这三句话都拿到真二进制上
> 核对了一遍：第一句是**不完整的承诺**，后两句把缺陷的形状指了出来。
>
> 结论一句话：**一个旗标要么被兑现、要么被拒绝，不能既被接受又什么都不做** —— 因为后者的失败
> 模式是**静默的**：命令照跑、退出码 0，而操作员以为刚刚发生的事从未发生。

| # | 缺陷（修前，均有真二进制实测） | 为什么是缺陷 | 处置 |
|---|---|---|---|
| 1 | **`--json` 被 5 条命令静默忽略**：`topics --json` 打印散文句、`pub --json` 打印人类行、`bench --json` 打印人类报表、`motor --json` 打印十六进制日志、`discover --json` 打印表格（远端 `topics`/`pub` 同）。而 USAGE 与 README 只说它属于 `sub`/`watch`/`status --socket` | 解析器**接受**它（不报错），所以脚本无从察觉：`topics --json \| jq .topics` 拿到的是 `(no traffic yet — publish or subscribe first)`，`jq` 报的是语法错，而不是「这个旗标没人管」。这正是本仓库反复钉住的形状：**接受了一个请求，却没有回应它** | `--json` 升为**全局旗标**（与 `-h`/`-V` 同位）：每个会打印结果的命令都兑现它。一次性命令出**一份文档**（`status`/`topics`/`bench`/`motor`/`discover`），流式命令出**一行一个对象**（`sub`/`state`/`watch`）。细节都有理由：`topics` 的文档把 `topics` 与 `complete` 放在一起（脚本只读数组就不会把截断清单读成全部真相）；`bench` 的 `latency_us` 是嵌套对象、**没有样本时为 `null`**（空跑不是零延迟）；`motor` 的 `frames` 是数组、`device` 为 `null` 表示 mock 总线；`discover` 的 `endpoint` 用 `null` 而不是人类表的 `-`；远端 `topics`/`pub` 的文档带 `remote`（答案永远写明是谁给的） |
| 2 | **`--count 0` 是静默空跑**：`pub --count 0` **一行都不打印**、退出 0，与「发布成功但没输出」不可区分；`sub --count 0` 打印「waiting for 0 frame(s)」 | 一个既不发布也不等待的运行**什么都报告不了**，所以退出 0 不是「成功」而是「没有信息」；操作员无法从任何输出判断自己是不是写错了 | 解析期拒绝（exit 2）：`--count 0` 在 `pub`/`sub`/`bench`/`state` 上是用法错误，消息点名 `--count 0` 与命令；`--count 1` 仍是最小的合法运行 |
| 3 | **不能用的旗标被静默忽略**（`--device` 之外的全部）：`sub --hz 5` 跑了、`bench --pattern 'amos/**'` 跑了、`motor --topic amos/x` 跑了、`status --seconds 9` 跑了 —— 全部退出 0 且旗标**不起任何作用**；远端 `status --socket X --peer dog1` 看起来像过滤器，实际什么都没过滤（应答的是**守护进程**的身份）；`discover --transport zenoh`（无 `--bus`）也不起作用 | 与 `--device` 完全同形，而 `--device` 的规则早已写进 README（「绝不静默忽略」）。区别只在后果的可见度：写错的 `--device` 会让人以为字节进了总线，写错的 `--pattern` 会让人以为过滤生效了 —— 两者都是**关于刚刚发生了什么的一句假话** | 新增一张表 `honors(cmd, flag)`（唯一的真源）+ `check_flag_scope`：解析期末尾按「命令行上真正出现过的旗标」逐个核对，不属于本命令的一律 exit 2，消息点名**旗标**与**命令**，并说清它属于谁（`--pattern` → `` `sub` and `state` ``）。跨模式的两条也在同一处：`--socket` 运行时，`--peer`/`--kind`/`--transport` 被拒（守护进程的身份不是从这一行设的）；`discover --transport` 只在 `--bus` 下被读（`--lan` 走 UDP、离线走种子表）。`--socket` 本身**刻意留到运行期**：它对数据面命令的拒绝是**能力**声明（exit 1，`needs a local data-plane node`），不是拼错了别的命令的旗标 |

**实测证据**（真二进制，`./target/debug/amos-link-cli`）：

```text
# (1) --json 处处兑现：每条命令的输出**逐行**都能被 JSON 解析器吃下
topics  --json                      ⇒ {"complete":true,"topics":[]}                    （1 行）
pub     --json --count 2            ⇒ {"event":"published","seq":1,…} / {"…","seq":2}  （2 行）
bench   --json --count 5            ⇒ {"frames":5,"sent":5,"latency_us":{"min":5,"p50":6,"p99":6,"max":33},…}
motor   --action '{"action":"arm"}' --json
                                    ⇒ {"applied":12,"armed":true,"hal":"mock","device":null,
                                       "frames":[{"joint":0,"leg":0,"part":0,"op":"Enable","arg":0,"hex":"aa5500…"},…]}
discover --static dog1 --json        ⇒ {"discovery":"mock","peers":[{"peer":"dog1","kind":"robot","static":true,"endpoint":null}],"ttl_ms":3000}
discover --bus --seconds 1 --json    ⇒ {"discovery":"bus","transport":"broker","seconds":1,"self_refused":2,"ttl_ms":3000}（1 行：横幅被抑制）
topics  --socket <UDS> --json        ⇒ {"complete":true,"remote":"/tmp/…sock","topics":[…]}

# (2) --count 0：拒绝（exit 2），且**没有任何结果行**
pub --topic amos/x --text hi --count 0
  ⇒ --count 0 would leave `pub` with nothing to do: give a positive count (…)     [exit 2, stdout 为空]

# (3) 不能用的旗标：exit 2 + 点名两者 + 说清归属
sub    --pattern 'amos/**' --hz 5          ⇒ --hz is not a `sub` flag: it belongs to `pub` and `bench`
bench  --count 3 --pattern 'amos/**'       ⇒ --pattern is not a `bench` flag: it belongs to `sub` and `state`
topics --topic amos/x                      ⇒ --topic is not a `topics` flag: it belongs to `pub` and `bench`
watch  --seconds 1 --count 2               ⇒ --count is not a `watch` flag: it belongs to `pub`, `sub`, `bench` and `state`
motor  --action '{"action":"stand"}' --topic amos/x
                                           ⇒ --topic is not a `motor` flag: it belongs to `pub` and `bench`
status --device /tmp/x.sock                ⇒ --device is not a `status` flag: it belongs to `motor`
status --socket X --peer dog1              ⇒ --peer configures *this* process's node, but --socket reads the running daemon's …
discover --transport zenoh                 ⇒ --transport selects the link that `discover --bus` federates over; this sweep is offline/`--lan`
```

**负控实测**（注入后 `cmp` 逐字节复原）：

| 注入的旧行为 | 新验证的反应 |
|---|---|
| `honors("--hz")` 改回「处处为真」（即回到静默忽略） | **第一次注入暴露了测试自身的弱点**：`tests::no_flag_is_silently_ignored_on_any_command` **仍然通过** —— 它比较的是「解析器 ⟺ `honors`」，而当 `honors` 自己变成「处处为真」时，两者**一起**变，断言自然成立（**用被测对象做期望的自指测试**）。因此补上硬编码的那条 `the_scope_table_refuses_what_the_docs_say_it_refuses`（17 组 `(旗标, 必须拒绝的命令, 必须接受的命令)`）：再注入时它 **FAILED**（`["sub", "--hz", "1"] must be refused`），进程级 `a_flag_the_command_cannot_use_is_a_usage_error_not_a_silent_no_op` 同轮 **FAILED**（期望 exit 2，实得 0）。**顺带修**：该进程级用例原先的 `sub --hz 5` **没有上界**，注入后它真的会去等帧（负控时挂住 300 s）⇒ 现在每个用例都带 `--count`/`--timeout-ms`/`--seconds`，负控能**快速变红** |
| 去掉 `--count 0` 的解析期拒绝 | `tests::a_count_of_zero_is_refused_instead_of_doing_nothing` ⇒ **FAILED**（`--count 0 must be refused: Opts { count: Some(0), … }`）；进程级 `a_flag_the_command_cannot_use_is_a_usage_error_not_a_silent_no_op` ⇒ **FAILED**（`pub --count 0` 又变回「退出 0、stdout 为空」，只剩断言在响） |
| 把 `topics` 的 `--json` 分支改回人类输出 | `json_is_honored_by_every_command_that_prints` ⇒ **FAILED**（`printed a non-JSON line "(no traffic yet — publish or subscribe first)"`） |
| 去掉远端 `--peer`/`--kind`/`--transport` 的相斥检查 | `remote_mode_refuses_flags_that_only_configure_a_local_node` ⇒ **FAILED**（`status --socket … --peer dog1` 被接受）；进程级 `a_socket_run_refuses_the_flags_that_would_configure_a_local_node` ⇒ **FAILED** |

**诚实边界（本轮新增）**：

1. **`--json` 不是稳定 schema 的承诺**：字段名是**当前**的机器可读形式，没有版本号、没有 JSON Schema、
   也没有兼容性保证（本 CLI 是**同机工具**，不是对外 API）。真正有契约的是控制面
   （`proto/robot_link.proto`）。字段一旦改名，靠它拼出来的脚本会断 —— 这一点写在这里，而不是留给别人猜。
2. **~~`--json` 只保证「能解析」，不保证「整个输出流都是 JSON」~~ —— 已处置（第十三轮，REQ-A268，§3.14 缺陷 3）**：
   此前 `sub`/`state`/`watch` 的**首行就是散文**（`subscribed …` / `watching …` / `watching transport=…`，本地与 `--socket` 两种形态都是），
   末尾还有散文的 `timeout …`/`stats …`/`watched …`，所以「流式命令一行一个对象」这句承诺在**第一行**就不成立。
   现在三条命令的每一行都是**带 `event` 的事件对象**（`subscribed`/`frame`/`timeout`/`stats`、`watching`/`report`/`timeout`/`stats`、
   `watching`/`heartbeat`/`status`/`summary`），**人形态逐字节不变**。这条边界到此结束，字段名不是 schema 的那条（边界 #1）仍然有效。
3. **作用域表是「命令 × 旗标」，不含值的语义**：`bench --size 0`（空载荷）与 `--size 1024` 一样合法，
   表只回答「本命令读不读这个旗标」；`--qos` 的**值**是否与话题的 channel 一致仍由运行期决定
   （`sub` 从模式推导档位并打印来源，`--qos` 只是覆盖它）。
4. **刻意保留的「忽略」**：`AMOS_LINK_*` 环境变量在对应旗标给出时被忽略（`--peer` 优先），
   这是文档写明的优先级，不是缺陷；`status`（本地）的 `--json` 是**同义**的 ——
   它本来就只输出 JSON，没有另一种形态可切换，因此「兑现」与「忽略」在这里是同一件事。
5. **真机观感复核未做**：本轮的证据全部来自真二进制与真 UDS（`mock_server` 控制面），
   没有在真机器狗/真总线（`--device`）上复核过；作用域表也没有覆盖 `AMOS_LINK_BEACON_*`
   这类只在 `--lan` 路径读取的**环境变量**（本轮只处理旗标）。

### 3.11 一份对端表、一种判决词汇：`status` 与 `status --socket` 是「同一份文档 + 谁答的」（第十轮，REQ-A265）

> 起点是上一轮（§3.10）自己登记的那条边界：**"`sub`/`state` 的横幅行仍是散文"** 之外，还有一条更
> 值钱的问题没问 —— **同一个命令的两种模式（本地 / `--socket`）输出的到底是"一份文档"还是"两种方言"？**
> 答案是后者，而且不止一处：**同名的键在两种模式下有两种类型**。
>
> 一句话：**键名相同而类型不同，比键名不同更坏** —— 前者会让一个脚本在另一种模式下**静默读错**。

| # | 缺陷（修前，均有真二进制实测） | 为什么是缺陷 | 处置 |
|---|---|---|---|
| 1 | **`status --socket` 把对端表整个丢掉了**：`GetStatus` 返回 `repeated Peer peers`（id/kind/endpoint/last_seen_ms/beacons），System UI（`amos-tauri/src/link.rs`）逐字段渲染，而 CLI 只打印 `peers={metrics.peers}`（一个**数字**），`--json` 里也把那个数字放在 `peers` 键上 | 控制面**已经答了**「谁在链路上」，而操作员拿来问这个问题的工具（终端）只能给出人数。RPC 上有的字段，只有终端这一个消费者看不见 —— 与"消费者拿不到答案"相反的形状：**答案到了，被扔了** | `status --socket` 改读 `status.peers`：人类形态多一栏对端表（`print_peer_rows`，与本地 `discover` 同一个渲染器），`--json` 的 `peers` 变成**数组**（同一个 `PeerRow` 形状）。人类形态同时补上清单行（`topics (N): inventory complete\|incomplete`），因为 JSON 里有这两个键 |
| 2 | **同名键、两种类型**：本地 `status` 的 `peers` 是**对象数组**、`health` 是**对象**（`{"state","reasons"}`）、计数器**嵌在 `metrics` 下**；远端 `status --socket --json` 的 `peers` 是**数字**、`health` 是**裸字符串**、计数器**平铺在顶层** | 两种模式只差一个 `--socket`，键名却一个都没改 —— 于是 `jq .peers[0].id` 在本地能用、在远端**静默**拿到 `null`（数字没有 `[0]`）。这不是"另一种格式"，这是**同一个名字下的两种类型**，任何脚本都无法同时正确 | 远端文档改为**本地文档 + `remote` + `actuations`**（`remote_status_json`：逐键按本地的形状抄，新增两个键，不删一个键）。为了让 `topics`/`topics_complete` 也在，`status --socket` 多调一次 `ListTopics`（同一条 UDS，一次往返）。**判据是可执行的**：`the_remote_status_document_is_the_local_document_plus_who_answered` 用**同一组事实**分别构造内核文档与远端文档，逐键断言相等；进程级 `status_json_is_one_document_locally_and_over_a_socket` 用真二进制跑两种模式，断言键集 = 本地键集 + 两个 |
| 3 | **一份对端表，四种渲染**：内核 `NodeStatus`（serde 派生）`{"info":{"id","kind","endpoints":[…]},"last_seen_ms","beacons"}`（嵌套 + 复数数组）／CLI `discover --json` `{"peer","kind","seen_ms","static","endpoint"}`（**另一套键名**）／CLI 远端 `status --json`（**一个数字**）／proto `Peer` 与 UI `LinkPeerOut`（扁平五字段） | 同一个概念在工作区里有三套词汇，而终端用的那套（`peer`/`seen_ms`）与控制面契约（`id`/`last_seen_ms`）和 UI 用的那套都不一致。脚本必须知道"我现在读的是哪一种" | 统一为**控制面契约的那一套**（proto 是线上真源）：`id`/`kind`/`endpoint`/`last_seen_ms`/`beacons`。内核 `PeerView` 改为手写 `Serialize`（扁平；端点列表折叠为首选端点，与 proto/UI 同一条规则；`beacons: 0` 即"手工声明"，不再另发明 `static` 键）；CLI 新增 `PeerRow`（唯一的行类型，`from_view`/`from_proto` 两个来源 + 一个 `to_json`），`discover`/`status`/`status --socket` 都走它 |
| 4 | **同一个 CLI 里判决有两种拼法**：本地 `status` 是 `{"state":"degraded","reasons":[{"decode_errors":{"count":3}}]}`（**Rust 字段名**嵌在里面），`watch --json` 是 `{"health":"degraded","health_reasons":["decode_errors=3"]}`，远端 `status` 是 `"health":"degraded"` + 同款 token 数组 | `HealthReason::key()` 的文档写着"Stable key (JSON, CLI, logs)"，而 JSON 里从来不是它 —— 里面是 Rust 的字段名（`count`/`missing`+`gaps`/`blocked`/`untracked`），也就是**跨语言读者要懂 Rust 内部**才能读判决。而 proto 与 CLI 另外两条路径早就在用 `detail()` token | `HealthReason` 的 JSON = 它的 **detail token**（`"decode_errors=3"`），`LinkHealth` 保留下 `{"state":…,"reasons":[token,…]}`；CLI 三处（`status`、`status --socket`、`watch`）统一走 `health_json_labeled`/`health_json`。**顺带**：`HealthReason`/`LinkHealth`/`NodeStatus`/`PeerView` 改为**只 `Serialize`**（去掉 `Deserialize`）—— 它们是**渲染**，不是线缆类型；旧测试还断言过"UI 能把它送回来"这种**工作区里不存在**的往返 |

**实测证据**（真二进制；远端是测试起的真控制面 `service::server(node)`，表里预置 dog1/cam-front）：

```text
# (1) 一份文档：本地 status 的关键字段（判决是对象、对端是数组、计数器嵌套）
$ amos-link-cli status --peer dog1 --kind robot
{"health":{"state":"unknown"},"peers":[],"metrics":{"published":0,"delivered":0,"dropped":0,
 "blocked":0,"decode_errors":0,"encode_errors":0}}

# (2) 远端人类形态：多了「谁在链路上」这一栏（修前只有 peers=2 这个数字）
$ amos-link-cli status --socket <UDS>
remote=<UDS> link peer=amos-daemon kind=tool version=0.1.0 uptime=614ms clock_synced=false
  peers=2 published=0 delivered=0 dropped=0 blocked=0 decode_errors=0 health=degraded
health reasons: clock_unsynced
peers (2):
peer                 kind         seen(ms)  beacons  endpoint
cam-front            sensor            614        0  -
dog1                 robot             614        0  udp/10.0.0.9:7446
topics (0): inventory complete
robots reported (0): nobody has reported its actuation since the daemon started watching …

# (3) 远端 JSON = 本地键 + remote + actuations（peers 是数组，health 是对象）
$ amos-link-cli status --socket <UDS> --json
{"actuations":[],"clock_synced":false,"health":{"reasons":["clock_unsynced"],"state":"degraded"},
 "kind":"tool","metrics":{"blocked":0,"decode_errors":0,"delivered":0,"dropped":0,"encode_errors":0,
 "published":0},"peer":"amos-daemon","peers":[{"beacons":0,"endpoint":null,"id":"cam-front",
 "kind":"sensor","last_seen_ms":622},{"beacons":0,"endpoint":"udp/10.0.0.9:7446","id":"dog1",
 "kind":"robot","last_seen_ms":622}],"remote":"<UDS>","topics":[],"topics_complete":true,"uptime_ms":622}

# (4) 同一套对端字段，扫描侧也一样
$ amos-link-cli discover --static dog1 --json
{"discovery":"mock","peers":[{"beacons":0,"endpoint":null,"id":"dog1","kind":"robot",
 "last_seen_ms":0}],"self_refused":0,"ttl_ms":3000}
```

**负控实测**（5 次注入；每次改回并核验）：

| 注入的旧行为 | 新验证的反应 |
|---|---|
| 判决的 JSON 改回"Rust 字段名对象"（NC1） | `health::tests::the_verdict_json_is_the_control_planes_vocabulary` ⇒ **FAILED**（`left: …"reasons":[{"count":15},…]`）；`telemetry::…the_status_document_speaks…` ⇒ **FAILED** |
| `PeerView` 改回嵌套 `info`（NC2） | `discovery::…a_peer_view_serializes_as_the_flat_peer…` ⇒ **FAILED**（`left: {"info":{"endpoints":[…],"id":…}}`）；`telemetry::…the_status_document_speaks…` ⇒ **FAILED**；CLI 的**跨端一致性**单测 `the_remote_status_document_is_the_local_document_plus_who_answered` ⇒ **FAILED**（`peers must be the same fact in the same shape`） |
| 远端 `peers` 改回**数字**（NC3） | 上面那条单测 + 进程级 `status_json_is_one_document_locally_and_over_a_socket` + `the_running_nodes_peer_table_crosses_the_socket` ⇒ 三条 **FAILED** |
| 远端 `health` 改回**裸字符串**（NC4） | 单测 + `remote_mode_reads_a_running_control_plane_over_a_unix_socket` + 文档等同性 ⇒ 三条 **FAILED** |
| 远端文档**丢掉** `topics`/`topics_complete`（NC5） | 单测（键集断言）+ 文档等同性 ⇒ 两条 **FAILED** |

**负控过程中的一次自伤（照实记下）**：NC2 的还原脚本自己有 bug —— 它在**每次**运行时把当前文件复制成"备份"，
于是第二次注入失败后，备份里已经是**注入后的**内容；`cmp` 因此**通过**，而缺陷还在树上（随后整包跑测试抓红：
`amos-link` lib 2 条 FAILED）。处置：把扁平序列化实现按原样写回并用测试重新核验（`cargo test -p amos-link` **133**、
`cargo test -p amos-link-cli` **18 + 27** 全绿），并把脚本改成**只在显式 backup 时取一次备份**。
教训与 §3.10 那条自指测试同形：**"我验证过了"这句话本身也要有可执行的判据** —— 对"还原"而言，
判据不是 `cmp`（它可能只是在比两份脏文件），而是**命名测试重新变绿**。

**诚实边界（本轮新增）**：

1. **端点列表被折叠**：`PeerRow`/`PeerView` 的 JSON 只带**首选端点**（`PeerInfo::endpoint()`），完整列表仍在
   Rust API（`PeerInfo.endpoints`）里。这与 proto `Peer`（单字段）和 UI 的映射一致，但**确实少了一维信息** ——
   将来要多端点，得先在 proto 上加字段，再让三处一起改。
2. **`--json` 仍不是版本化的 schema**（继承 §3.10 的边界）：这一轮让"两种模式同形"，没有给字段加版本号。
3. **渲染类型现在只 `Serialize`**：`NodeStatus`/`PeerView`/`LinkHealth`/`HealthReason` 去掉了 `Deserialize`。
   工作区里没有任何地方反序列化它们（已 grep 核实），但**外部**读者若曾依赖那个（事实上与其 `Serialize` 不对称的）
   派生实现，需要显式加一个自己的形状 —— 这是有意的：**一个渲染不该假装能往返**。
4. **proto 与判决词表都没改**：控制面一直是这套词汇（枚举 + token），本轮改的是**生产者**向它对齐；
   `state` 的三个词（`unknown|healthy|degraded`）是 CLI/UI 的显示词，proto 的枚举仍是 `HEALTH_*`（线上契约不变）。
5. **UI 未改一行**：`LinkPeerOut` 本来就是扁平五字段，前端零改动；本轮只补了一条**钉住它**的序列化测试
   （`a_peer_serializes_to_the_same_five_fields_the_cli_prints`）。
6. **真机复核未做**：全部证据来自真二进制 + 真 UDS（本机），没有真狗/真板卡上的第二次复核。

### 3.12 报告也要有日期：`age=` 与 `age_ms`（第十一轮，REQ-A266）

> 起点是上一轮（§3.11）把「一份对端表、一种判决词汇」收口之后剩下的一个问题：
> **回程（`amos/<robot>/state/actuation`）说的每个字都是"现在"，而"现在"从哪来？**
> 面板早就为自己的**读数**打了日期（`link.probe` + 每 10 秒重读，REQ-A246），终端早就在心跳上打
> `age=`（`watch` 的 `beat … age=…ms`），而对端表有 `last_seen_ms` —— **只有机器人自报的状态没有年龄**：
> `armed=true` / `estopped=false` 是"此刻是否通电/是否已切扭矩"的**安全断言**，而一份两小时前的报告
> 与一份两秒前的报告，在屏幕上长得一模一样。
>
> 一句话：**读有日期，报告没有**。

| # | 缺陷（修前，均有真二进制实测） | 为什么是缺陷 | 处置 |
|---|---|---|---|
| 1 | **人类形态完全没有日期**：`render_actuation` 打印 `robot=… armed=… estopped=… gait=… frames=… seq=… watchdog=…`，不带时间戳、不带年龄 —— `state`（数据面订阅）与 `status --socket`（控制面折叠）**两条路径共用这一个渲染器**，于是两边都缺 | `armed` 是"此刻通电"的断言：一个上报过 `armed=true` 之后死掉的机器人，在终端里会**永远**显示 `armed=true`，而旁边没有任何东西说明这是多久以前的事。命令存在的理由就是回答"机器人现在在做什么"，缺了年龄这一列，它回答的是"机器人**曾经**在做什么" | `render_actuation` 增加 `now_ms` 参数并在人类行尾追加 ` age=<…>`（`state` 与 `status --socket` 一起变，因为是同一个渲染器）；`actuation_json` 增加 `age_ms` |
| 2 | **机器可读形态给了时间戳、没给年龄**：JSON 里只有 `stamp_ms`（56 位纪元毫秒），读者要自己知道"本机现在几点"才能算 | `stamp_ms` 是**报告者**的表（跨机时钟不同步时它是唯一可比的量），而"多久以前"是**读者**的问题。让每个消费者各算一次，就是把"用哪个时钟、算错了怎么办"留给每个脚本 | JSON 同时给 `stamp_ms`（原样）与 `age_ms`（用本机时钟算出的年龄），一个都不少 |
| 3 | **无法计算的情形会被折成一个数字**（修前的形状：`stamp_ms` 为 `0`、或时间戳**在未来**） | `0` 是 proto 的"缺省"哨兵，不是 1970：按 `now - 0` 算会得到"56 年前上报"；时间戳在未来（两台机器时钟不一致的**可见症状**）按 `now - stamp` 算会得到负数，而 `0`/负数会读成"刚刚" —— 两者都是**把未知说成了一个数字**。本 crate 的纪律是"未知要说出来"（`HealthReason::Unknown`、`unknown ≠ healthy`、`endpoint: null ≠ ""`） | 两个 `AgeUnknown` 情形各有名字：`age=unknown(no stamp)`、`age=unknown(stamp is Nms in the future — **that** clock is not this clock)`（措辞于第十四轮改为中性的「that clock」，因为同一条规则也被**帧**渲染器使用了；见 §3.15）；JSON 里是 `age_ms: null`，**绝不 `0`** |
| 4 | **面板：读数有日期，报告没有**：`LinkActuation.stamp_ms` 在类型里带着注释（"When the robot published it"），`LinkPage.svelte` 的机器人行**从不渲染它**，页面只有 `link.probe`（整个读数的时间） | 与缺陷 1 同形，且更危险：面板每 10 秒重读一次，所以 `link.probe` 永远是"新鲜的" —— 一个死了两小时的机器人旁边挂着一个刚刚的时间戳，读起来像"两小时前到现在一直是 armed" | `lib/link.ts` 新增 `actuationAgeMs(a, now)` / `reportAgeKey(age)` / `reportAgeText(age)`（纯函数），面板每行渲染 `link.reportedNow` / `link.reportedAgo{age}` / `link.reportedUnknown` |

**实测证据**（真二进制；机器人由**第二个节点**在真链路上发布报告，守护进程的 watch 折叠，CLI 读回来）：

```text
$ amos-link-cli status --socket <UDS>          # 人类形态：多了一列年龄
remote=<UDS> link peer=amos-daemon kind=tool version=0.1.0 uptime=1111ms clock_synced=false
  peers=0 published=24 delivered=22 dropped=0 blocked=0 decode_errors=0 health=degraded
health reasons: no_peers, clock_unsynced
peers (0): (nobody else is fresh on this link)
(no peers)
topics (2): inventory complete
robots reported (1):
  robot=dog1 armed=true estopped=false gait=trot frames=13 seq=7 watchdog=1000ms age=23ms

$ amos-link-cli status --socket <UDS> --json   # 机器形态：stamp_ms 与 age_ms 并列
{"actuations":[{"age_ms":26,"armed":true,"estop_reason":null,"estopped":false,"frames":13,
 "gait":"trot","last_refusal":null,"robot":"dog1","seq":7,"stamp_ms":1789486030723,
 "watchdog_ms":1000}, …]}

# 单元级（受控时钟）：三小时前的报告、无时间戳、未来时间戳
state_lines(frame(now - 3h))   ⇒ … age=3h 00m
state_lines(frame(now - 250))  ⇒ … age=2xxms
state_lines(frame(0))          ⇒ … age=unknown(no stamp)            ; JSON age_ms = null
state_lines(frame(now + 5s))   ⇒ … age=unknown(stamp is 5000ms in the future …) ; JSON age_ms = null

# 面板（zh）：一行一个年龄
dog1 · trot · #12   …   2s 前上报
dog2 · estop · #13  …   3h 00m 前上报
（无时间戳 / 未来时间戳）⇒ 上报时间未知（时间戳不可用——机器人时钟可能不同步）
```

**负控实测**（5 次注入；UI 侧另有一条**方法学**教训）：

| 注入的旧行为 | 新验证的反应 |
|---|---|
| 人类行去掉 `age=`（NC-cli_human） | `a_report_is_dated_and_an_unusable_stamp_says_so` ⇒ **FAILED**；进程级 `the_return_path_is_dated_when_it_crosses_the_socket` ⇒ **FAILED** |
| JSON 的 `age_ms` 写死 `0`（NC-cli_json） | `the_machine_form_carries_the_age_as_a_number_or_null` ⇒ **FAILED**（**进程级那条仍绿**：它断言的是"年龄存在且合理"，精确值由受控时钟的单测负责） |
| `report_age_ms` 改成 `Ok(now - stamp)`（任何时间戳都给数字，NC-cli_unusable） | `a_report_is_dated_and_an_unusable_stamp_says_so` ⇒ **FAILED**（`frame(0)` 变成"56 年"而不是 unknown） |
| `actuationAgeMs` 改成永远返回数字（NC-ui_helper） | `bun test src/__tests__/link.test.ts` ⇒ **1 failed**（`null` 的两种情形）；面板 `…a report whose stamp is unusable…` ⇒ **FAILED** |
| 面板里删掉年龄那一行（NC-ui_row） | 面板 `…robot rows show what each robot reports…` 与 `…a report whose stamp is unusable…` ⇒ 两条 **FAILED** |

**方法学教训（照实记下）**：NC-ui_row 第一次跑**"通过"了** —— 注入确实落到了文件里（`grep` 为 0），但 Vite 的 transform 缓存按 mtime 粒度复用，同一个粒度内改动的 `.svelte` 被当作上一次的编译结果用了。处置：负控跑 UI 侧时**先 `sleep 1 && touch` 目标文件**再跑；加了这个步骤之后两条测试如期变红。这与上一轮那次"还原脚本把注入后的文件当备份"（§3.11）是同一条：**一次"通过"必须能解释为什么它应该通过**，否则它什么都没证明。

**诚实边界（本轮新增）**：

1. **年龄是"报告者时钟"与"读者时钟"之差**：两台机器的时钟不同步时它是**界，不是测量** —— 与延迟数字同一条规矩
   （`clock_synced: false ⇒ latencies are bounds`）。能看见的症状是"时间戳在未来"，那时本轮**拒绝给年龄**；
   但"报告者慢两分钟、看起来像 10 秒前"这种**温和**的不同步无法从数据上区分，因此 CLI 的 `status --socket` 仍把
   `clock_synced=` 打在同一屏上。
2. **`stamp_ms` 与 `age_ms` 都保留**：前者是跨机可比的原始量，后者是读者要的答案；只给年龄会让"两台机器差多少"
   变得不可算，只给时间戳则把算年龄这件事推给每个消费者。
3. **面板的年龄在每次重读时定格**（页面每 10 秒重读一次）：屏幕上的"2s 前上报"最多滞后 10 秒。既有文案
   （`link.probe` 的"每 10 秒重读"）已说明这个周期，本轮没有为年龄单独加计时器 —— 那是另一件事。
4. **`state`（数据面订阅）的年龄几乎总是 0ms**：它订阅的是**正在发布**的帧，年龄是"这帧从发布到我看完"的时延；
   真正会"老"的是 `status --socket` 读到的折叠表。同一条规则、两种尺度，因此没有为它们各写一套渲染。
5. **阈值是工程选择**：`0` 与"未来"是**结构性**的不可用；"56 年前"（例如从纪元起算的时钟）本轮**当作真实年龄**如实打印
   —— 不设"太久就是假的"这种魔法阈值（设了就是在替读者猜）。真机上如果出现这种报告，应当去修那台机器人的时钟。
6. **真机复核未做**：证据全部来自本机真二进制 + 真 UDS + 真前端测试；没有在真狗上验证"拔网线后 `armed` 变老"的观感。

### 3.13 序号属于「流」而不是「对端」：`missing` 既不虚报也不漏报（第十二轮，REQ-A267）

> 起点是把上一轮（§3.12）的仪器问到底：**损失数字的键，和序号被盖出去的方式，是不是同一件事？**
> 不是。生产者每建一个 `Publisher` 就有**一个自己的计数器**（`LinkNode::publisher::<T>(topic)` 是**按话题**发的），
> 而 `SeqTracker` 只按**发布者**建表。于是：**一个机器人发布两路（相机 + IMU），或者既打心跳又发数据，
> 在消费者眼里就成了「同一个流在反复重启」。**
>
> 一句话：**序号标识的是「谁·在哪个话题上」的那一刻** —— 键少了一维，仪器就会替链路编故事。

| # | 缺陷（修前，均有测试实测） | 为什么是缺陷 | 处置 |
|---|---|---|---|
| 1 | **一个对端的两条流被当成一条**：帧头带 `(topic, publisher, seq)`，`Publisher` 每个对象一个计数器（**按话题**），而 `SeqTracker` 的 `BTreeMap<PeerId, u64>` 只按 publisher 建键 | `sub --pattern 'amos/**'`（CLI 默认）覆盖多条流：相机与 IMU 各自的 1、2、3… 交错到达，仪器把它们读成「同一个发布者的高水位反复回退」⇒ **虚报 `stale`**（模块文档把 stale 定义为「重复、乱序、或发布者重启计数器」—— 三条全不成立），而且 `streams=` 数的是**对端数**，与字段名说的不是一回事 | 新增 `StreamKey { publisher, topic }`（`SeqTracker` 的键），`observe_received` 从**帧自己**读出键（`StreamKey::of`）；`observe`/`highest` 改为收 `&StreamKey`；`streams=` 从此就是流数 |
| 2 | **真正的丢帧会被更快的流吃掉（这一半没人看得见）**：键共享时，活跃流把高水位拖到很远，安静流的帧**全部落在高水位之下** ⇒ 一律 `Stale` | 一条 200 Hz 的 IMU 把水位推到 200 之后，10 Hz 的雷达（其帧号 2、3、4…）全部是「Stale」；它**真的丢了第 3 帧**时，仪器看到的只是又一条「Stale」——**丢帧被记成重复**，`missing` 不增、`has_loss()` 为 false、判决照旧 `healthy`。这是仪器**比线缆更乐观**，与 REQ-A248 那条「判决不得比仪器更干净」正好互为反面 | 同上（键 = 流）之后，`Gap` 按**每条流自己的**高水位判定；`a_fast_stream_does_not_hide_a_slow_streams_real_gap` 钉住它 |
| 3 | **总量无法归因**：`missing=3` 只说链路丢了帧，不说**丢在哪条流**；通配模式下有几十条流时，操作员只能猜 | 本 crate 的一贯纪律是「数字要能行动」（`health reasons`、`topics_complete`、`untracked=`、`age_ms` 都是这条）。归因的代价是每条流多两个 `u64`（`gaps`/`missing`），而表本身**已经有界**（`MAX_TRACKED_STREAMS`） | `StreamState { highest, gaps, missing }` + `pub fn streams_with_loss() -> Vec<(StreamKey, u64, u64)>`（按 (publisher, topic) 排序，两次运行输出一致）；CLI `sub` 在总量行之下打印 `lost peer=… topic=… missing=N in M gap(s)` |

**实测证据**（都先用测试证明缺陷存在，再修）：

```text
# (1) 一个对端、两条话题（修前）：第二条流的 seq 1 被读成「重复」
observe_received(cam, 1) ⇒ First { seq: 1 }
observe_received(imu, 1) ⇒ **Stale { seq: 1, last: 1 }**   ← 修前：同一个对端的另一条流
observe_received(cam, 2) ⇒ InOrder { seq: 2 }
summary ⇒ streams=1（真值 2）、stale=2（真值 0）、gaps=0

# (2) 快流吃掉慢流的真丢帧（修前）：IMU 推到 5 之后，雷达的 2、4 全是 Stale
lidar: 1 → First；imu: 1..5；lidar: 2 → **Stale**；lidar: 4 → **Stale**
summary ⇒ missing=0、has_loss()=false    ← 雷达真的丢了第 3 帧，仪器没有说

# (3) 修后（同一个用例）
streams=2、stale=0、gaps=0；lidar 2 → InOrder、lidar 4 → **Gap { expected: 3, missing: 1 }**
streams_with_loss() ⇒ [(dog1@amos/dog1/sensor/lidar, missing=1, gaps=1)]
CLI `sub` 末行之下：lost peer=dog1 topic=amos/dog1/sensor/lidar missing=1 in 1 gap(s)
```

**负控实测**（3 次注入；每次改回并核验）：

| 注入的旧行为 | 新验证的反应 |
|---|---|
| `observe_received` 忽略话题、只按发布者建键（NC-peer_key） | `one_peers_two_topics_are_two_streams_not_one_restarting` 与 `a_fast_stream_does_not_hide_a_slow_streams_real_gap` ⇒ **FAILED**；内核 e2e `a_best_effort_lag_is_visible_as_a_sequence_gap`（真 broker）⇒ **FAILED** |
| 去掉每条流的 `gaps`/`missing` 累加（NC-no_attribution） | 归因断言 ⇒ **FAILED**（`left: []`，而真值是一条 `lidar` 流）；总数仍然正确 —— 正是「有总量、没出处」的旧局面 |
| CLI 的归因行构造改为返回空（NC-no_lines） | `the_loss_figures_name_the_stream_that_lost_frames` ⇒ **FAILED**（`left: []` vs 两行） |

**诚实边界（本轮新增）**：

1. **归因行的端到端（进程级）没有被覆盖**：`sub` 的统计行与归因行是在 `run` 里直接打印的，
   能进程级复现「丢掉某一帧」需要一个会真的丢帧的链路；本轮覆盖的是**纯行构造器**（单测）+ 打印调用本身。
   内核侧的 `streams_with_loss()` 有单测，e2e 覆盖面是「真 broker 上一条流的 gap」。
2. **`streams=` 的语义变了**（对端数 → 流数）：这是一个**行为变化**，对日志比对脚本的人有意义；
   `untracked=` / `tracking=complete|full` 的语义不变，而 `MAX_TRACKED_STREAMS` 现在数的是流
   —— 一个对端可以占多条（更容易撞上限，「说它停了」的那套机制照旧生效）。
3. **生产者没有改**：`Publisher` 仍然每个对象一个计数器（按话题）——本轮把**仪器**对齐到生产者的实际语义，
   而不是反过来把生产者改成「一个节点一个计数器」（后者会让**只订阅一条流的消费者**看到莫名其妙的空洞，
   反而更糟：见 §3.13 缺陷 2 的推理）。
4. **心跳不受影响**：每个对端的心跳在自己的话题上（`amos/<peer>/telemetry/beat`），所以 `watch` 的
   `beats_missing` 一直就是「按对端」的；本轮之后它仍然是「每个 (对端, 话题) 一条流」的特例。
5. **重复/乱序的判定仍然按流**：`Stale` 的定义没变，变的只是它的键；一个**在同一话题上**重启计数器的
   发布者仍会呈现一串 `Stale`，需要调用方 `reset()`（这条边界与 REQ-A245 相同）。
6. **真机复核未做**：证据来自受控单测 + 真 broker 的 e2e（本机），没有在真机器狗上跑双流丢帧的实验。

### 3.14 信标的端点：一条只能被测试表达的承诺 + 流式命令的 `--json` 最终兑现（第十三轮，REQ-A268）

> 起点是把 §3.13 的仪器问到底之后换一个问法：**这条链路上，哪一栏是「文档在说、代码做不到」的？**
> 于是逐字段核对 `PeerInfo` —— `id`/`kind`/`endpoints` 三个字段，前两个**每个生产路径都填**，
> 第三个**只有测试填**。
>
> 一句话：**`PeerInfo::with_endpoint` 有边界、有校验、有渲染、有文档，却没有生产者** ——
> 于是一张「谁在链路上、怎么连它」的表，在每一次真实部署里都印着 `-`。

| # | 缺陷（修前，均有实测） | 为什么是缺陷 | 处置 |
|---|---|---|---|
| 1 | **端点字段没有生产者**：`PeerInfo::with_endpoint`/`endpoints` 的 `grep` 命中全部落在 `#[cfg(test)]` 里；两个真正的产出者都在用 `PeerInfo::new(id, kind)` —— `discovery::spawn_federation`（总线联邦）与 CLI 的 `discover --lan`。也就是**每一个真实信标的 `endpoints` 都是空数组** | 这个字段不是内部细节，它是**四个消费者的一栏**：内核 `PeerRegistry`→`PeerView`（`endpoint`）、控制面 `proto.Peer.endpoint`、系统设置的「机器人链路」页（有专门的渲染与用例）、CLI `discover`/`status --socket` 的 `endpoint` 列（`-`/`null`）。同时 §6 第 3 条把信标定义为「**它只是『去连我』的提示**」—— 而**没有任何办法把一个地址放进这条提示里**：没有旗标、没有环境变量、没有部署开关。信标存在的理由（告诉别人连哪里）在代码里不存在 | 新增 `discovery::parse_endpoints(raw)`（逗号分隔的**操作员输入**的唯一解析处：去空白、丢空项、按 `MAX_ENDPOINTS`/`MAX_ENDPOINT_LEN` 逐字段设界，错误点名**数量/第几项/字节数**而不是回显 4 KiB 的输入）+ `PeerInfo::advertising(id, kind, endpoints)`（唯一填 `endpoints` 的生产路径）+ `spawn_federation_advertising(node, period, endpoints)`（`spawn_federation` 以空表委托它，一条实现两条入口）+ `LinkNode::spawn_federation_advertising`；CLI 新增 `--endpoint <EP>`（可重复、值内也可逗号）与 `AMOS_LINK_ENDPOINT`，`watch`/`discover --bus` 走同一个 `start_federation`，`discover --lan` 用 `PeerInfo::advertising` 建自己的公告 |
| 2 | **逐字段的界不是整帧的界**：`MAX_ENDPOINTS = 8` × `MAX_ENDPOINT_LEN = 128` = 1024 字节的公告，而信标帧上限 `MAX_BEACON_BYTES = 512`。**修 #1 的第一版就有这个洞**：只做 `PeerInfo::validate()` 的话，一个「每项都合法」的列表会让**每一个**信标在 emit 路径上被拒 —— `spawn_federation` 只记一行 `debug!`，于是**节点在 LAN 上彻底不可见，而没有任何东西说出口** | 「启动时拒绝」与「发不出去的节点」是两种完全不同的失败：前者点名原因、退出非零；后者安静地表现为「这个 LAN 上没有别人」。本 crate 的纪律是「一个被隐藏的过滤器与一条什么都没运的链路无法区分」（`self_entries_refused`、`self_echoes` 都是为这条存在的） | `PeerInfo::advertising` 在 `validate()` 之后**再编码一个探针信标**：只有把整帧编出来才知道 id/kind/时间戳加起来是否塞得下，错误带回**实测**字节数（8 × 128B 的端点 ⇒ `beacon of 1138 bytes exceeds the 512-byte frame ceiling`）。CLI 侧两条 announcing 路径都经过它，因此 `watch --endpoint <8×127B>` ⇒ **exit 1 且点名整帧**（`beacon of 1136 bytes …`），而不是跑满整个窗口一个信标都发不出去 |
| 3 | **§3.10 自己登记的边界 #2 兑现**：那里写着「`--json` 只保证『能解析』，不保证『整个输出流都是 JSON』：`sub`/`state` 的**横幅行**（`subscribed …`、`stats …`）仍是散文」。实测三条流式命令**首行就是散文**：`sub`→`subscribed peer=…`、`state`→`watching …`、`watch`→`watching transport=…`（本地与 `--socket` 两种形态都是），末尾还有散文的 `timeout …`/`stats …`/`watched …`；而 USAGE 与 README 承诺的是「流式命令**一行一个对象**」 | 这是「接受了一个请求、却没有全程回应它」的同一形状（REQ-A264 修的就是它的一半）：`watch --json \| jq` 在**第一行**就语法错，而上一轮把这条写成了**边界**而不是缺陷 —— 边界可以是「做不到的事」，不能是「已经承诺却没有做到的事」 | 三条流式命令的散文行全部变成**事件对象**（事实一条不丢）：`sub` 出 `subscribed`/`frame`/`timeout`/`stats`（`lost` 归因从字符串行变成数组）、`state` 出 `watching`/`report`/`timeout`/`stats`、`watch`（含 `--socket`）出 `watching`/`heartbeat`/`status`/`summary`；**人形态逐字节不变**（只在 `!opts.json` 时打印）。`print_frame` 此前是唯一没有 `event` 键的流式行，一并补上 `"event":"frame"` |
**实测证据**（真二进制 + 真 broker）：

```text
# (1) 修前：两个产出者都不带端点（`PeerInfo::new` 的两个生产调用点）
spawn_federation      ⇒ Beacon::new(PeerInfo::new(peer, kind), now)      endpoints=[]
discover --lan        ⇒ PeerInfo::new(peer, kind)                        endpoints=[]
peer table（任意部署） ⇒ {"id":"dog1","kind":"robot","endpoint":null,…}   ← 永远
CLI 人类表            ⇒ dog1  robot  300ms  7×   -                        ← endpoint 列永远印占位符

# (1b) 修后：同一条链路上，对端表里终于有地址（crates/amos-link 的联邦 e2e）
dog1 spawn_federation_advertising(period, ["tcp/10.0.0.7:7447","udp/239.0.0.1:7446"])
mini-brain 的 peers()      ⇒ info.endpoints == ["tcp/10.0.0.7:7447","udp/239.0.0.1:7446"]
mini-brain 的 status JSON  ⇒ "endpoint":"tcp/10.0.0.7:7447"

# (2) 逐字段合法 ≠ 发得出去（修 #1 的第一版会漏掉的一半）
parse_endpoints("8 × 128B")     ⇒ Ok（每一项都在 MAX_ENDPOINT_LEN 内）
PeerInfo::advertising(…)        ⇒ Err(Frame: beacon of 1138 bytes exceeds the 512-byte frame ceiling)
CLI: watch --endpoint <8×127B>  ⇒ exit 1，stderr 点名整帧（beacon of 1136 bytes …，不是「跑完窗口、什么都没发」）

# (3) 流式命令的机器形态（修前首行就是散文，jq 在第一行报语法错）
sub   --json  ⇒ {"event":"subscribed","peer":"amos-node","pattern":"amos/**","qos":{…},"from":…,"waiting_for":1}
                {"event":"frame","topic":…,"publisher":…,"seq":1,"age_ms":0,"frame_len":…}   ← 新增 event
                {"event":"timeout","timeout_ms":50,"received":0,"waiting_for":1}
                {"event":"stats","received":0,…,"tracking":"complete","loss_percent":0.0,"lost":[]}
state --json  ⇒ {"event":"watching","pattern":"amos/*/state/actuation","qos":{…}} … {"event":"report",…} …
                {"event":"stats","received":0,"dropped":0,"decode_errors":0,"note":"state is latest-wins per robot"}
watch --json  ⇒ {"event":"watching","transport":"broker","peer":"link-watch","kind":"tool",
                 "beat":"amos/link-watch/telemetry/beat","advertised":["tcp/10.0.0.7:7447"],"seconds":1}
                {"event":"status",…,"advertised":[…]} / {"event":"heartbeat",…}
                {"event":"summary","watched_s":1,"beats_published":2,"beats_seen":1,…,"advertised":[…]}
watch --socket … --json ⇒ {"event":"watching","remote":"/tmp/…sock","seconds":1} … {"event":"summary",…,"per_peer":{}}
```

**负控实测**（4 次注入；每次从注入前的副本 `cp` 回来并核验）：

| 注入的旧行为 | 新验证的反应 |
|---|---|
| `spawn_federation_advertising` 忽略传入列表、改回 `PeerInfo::new`（NC1） | 内核 e2e `a_federating_node_announces_the_endpoints_it_was_given` ⇒ **FAILED**（对端表的 `endpoints` 为空） |
| `PeerInfo::advertising` 去掉探针编码、只留逐字段界（NC2） | `an_advertisement_is_parsed_and_bounded_before_a_beacon_is_built`（第 3 段）与 `an_unemittable_advertisement_is_refused_before_the_task_starts` ⇒ **FAILED**；进程级 `an_advertised_endpoint_is_what_the_node_announces_or_a_usage_error` 的第 5 段（期望 exit 1，实得 0）⇒ **FAILED** |
| `watch` 的本地横幅改回散文（NC3a） | **第一次注入时 `the_streaming_commands…` 仍然通过** —— 它当时只覆盖 `watch --socket`，而名字说的是「流式命令」。补上本地 `watch` 一节后重注入 ⇒ **FAILED**（`printed a non-JSON line "watching transport=broker …"`）。**一次通过必须能解释为什么它应该通过**（§3.10 的 `honors` 自指测试是同一教训的第二次出现） |
| CLI 的 `start_federation` 改传空列表（NC4） | 进程级的「CLI 说自己在广播 `tcp/…`」断言**全部仍然通过** —— 因为那些行印的是 `opts.endpoints`（**操作员输入的东西**），不是节点**发出去的东西**。于是新增 `the_cli_announces_the_endpoint_the_operator_gave`（两个节点挂同一个 broker，问**对端**的 `peers()`）：重注入 ⇒ **FAILED**（`left: []` vs 两个端点），进程级用例因整帧检查失败而 **FAILED**（期望 exit 1） |

**诚实边界（本轮新增）**：

1. **端点是一句声明，不是身份**：信标仍是明文、未认证（§6 第 3 条），所以「对端表里有 `tcp/…`」只说明**它这么说过**。
   冒充者可以贴别人的地址；真正的信任路径仍是守护进程的 UDS（peer-credential）。本轮的保证只是：这句声明**有地方填、填错在启动期被拒、并且真的上了线**。
2. **默认仍然是「不广播地址」**：所有既有部署的行为**逐字节不变**（空列表 = 今天就有的形状）。这是有意的 —— Zenoh 之类的传输自己会发现的地址，硬填一个反而更糟。`--endpoint`/`AMOS_LINK_ENDPOINT` 是**显式**的。
3. **`endpoint` 只是「首选端点」**：列表的其余项仍在 Rust API（`PeerInfo.endpoints`）里，JSON/proto/UI 都只取第一项（REQ-A265 定下的折叠）。`watch --json` 的 `advertised` 是**本节点自己广播的整份列表**，不是对端表的形状。
4. **进程级观测不到自己的信标**：一个进程只有一个节点，而「节点不是自己的对端」是被保证的性质，所以「CLI 真的把地址放进了信标」只能由**另一个节点**来观察（`the_cli_announces_the_endpoint_the_operator_gave`）。真机（两块板子对着同一个交换机）仍未复核。
5. **流式 `--json` 的字段名仍不是 schema**（§3.10 边界 #1 不变）：本轮只保证每一行都是**带 `event` 的对象**，不保证字段永不改名。
6. **`--lan` 的进程级用例需要 `lan` 特性**（`cargo test -p amos-link-cli --features lan`）：默认构建下它被 `#[cfg(feature = "lan")]` 跳过。


### 3.15 一个事实，两种回答：帧的年龄被折成 `0`（第十四轮，REQ-A269）

> 起点是把第十三轮那句「哪一栏是文档在说、代码做不到」换个方向问：**同一个事实，CLI 里的两处渲染器会不会给出两个答案？**
>
> 会。第十一轮已经立下规矩：**时间戳在未来 ⇒ 年龄无法陈述**（`age=unknown(…)`、`age_ms: null`），
> 因为那是两台时钟不一致的可见症状。而同一份 CLI 的**帧**渲染器（`sub`、`watch`、`bench`）走的是
> `Received::age()` —— 它的底座 `Timestamp::since` 对「更早」的一端**饱和到 ZERO**（对 duration 是对的设计：
> 回退的时钟不该产出天文数字），于是帧的年龄被印成 **`0`**。
>
> 一句话：**`0` 读起来是「刚刚到达」——那是关于链路的一个断言，而仪器并不能支持它。**

| # | 缺陷（修前，均有实测） | 为什么是缺陷 | 处置 |
|---|---|---|---|
| 1 | **`sub`/`watch` 把未来的戳印成 `age=0ms`**：`received.age().as_millis()`（`Timestamp::since` 的饱和值） | 对端时钟快 5 秒（两块没校准的板子），或者本机时钟在中途被校准/回退（`Clock::apply`、NTP step），每一帧都变成「刚刚到达」。**同一个 CLI 对同一类事实已经拒绝这么做**（`state`/`status --socket` 说 unknown）—— 一个事实两个答案，而错的那个在操作员用来判断链路健康的那条线上 | 新增 `age_between(stamp_ms, now_ms)` 作为**唯一规则**（未来 ⇒ `InTheFuture`），`report_age_ms`（回程，`0` = proto 的「缺省」哨兵）与 `frame_age_ms`（帧，`0` = 纪元，是一个**真实但巨大**的年龄）是同一规则的两条哨兵策略；`received_line`/`received_json` 成为纯渲染器（此前只能靠打印来观察），`watch` 的心跳行同样走它 |
| 2 | **`bench` 把「不可测」记成 `0 µs`**：`latencies.push(received.age().as_micros())` | 于是一条时钟不一致的链路在直方图里**变得更快**：那个 0 会拉低 `min`/`p50`/`p99`，而 `bench` 存在的理由就是回答「这条链路够快吗」。这是**测量往好听的方向撒谎** —— 本轮唯一不能接受的错误方向 | `sample()` 成为纯分类器：可测 ⇒ 采样，不可测 ⇒ `skewed += 1`；`latency_line`/`latency_json` 成为纯渲染器，`latency_us` 增加 `samples`（百分位数的基数）、顶层增加 `skewed`，`received = samples + skewed`（两个数字不可能悄悄互相矛盾）；全部样本都不可测 ⇒ 直方图为 `null` + 一行 `latency: none measurable (N frame(s) skewed)` |
| 3 | **`Received::age()` 的文档承诺没有兑现**：它写着「an unsynced host clock ⇒ it is a bound — **which is why the node reports `clock_synced` beside it**」，而 `sub` 从不打印 `clock_synced` | 文档替代码许了一个不存在的旁注；操作员在 `sub` 的输出里看不到「这些年龄只是上界」。与第十三轮同一形状：**承诺要么兑现，要么别说** | `sub` 的 `subscribed` 事件与人类行、`watch` 的头部行都带上 `clock_synced` 与同一个子句 `clock_synced=false: ages are bounds, not measurements`；内核该方法的文档同时补上**渲染器的两条义务**（饱和度要还原；未校准要说明），因为那是事实与旁注唯一相遇的地方 |

**修 #2 的第一版自己的洞（写下来，因为它是这一轮第二个「先跑一遍真二进制」抓到的缺陷）**：
把 `sample()` 改成 `frame_age_ms(&stamp) * 1000` 之后，本地一次 `bench --count 20` 打出
`min=0 p50=0 p99=0` —— **亚毫秒的样本被截断成 0**，也就是用**另一种**方式说了「瞬时」（正是本轮要修的那句话）。
处置：把**唯一的比较**提到**纳秒**（线上自己的单位，`Timestamp::as_nanos`），各种单位只是由它**除**出来的
（`frame_age_ms` = ns/1e6、`frame_age_us` = ns/1e3、回程用 ms 形状）；`InTheFuture` 里的毫秒数字**向上取整**
（亚毫秒的偏斜读作「1ms in the future」，不再是「0ms in the future」）。钉住它的用例是
`the_benchmark_histogram_keeps_its_microsecond_resolution`（250 µs 的年龄：µs 形状是 250、ms 形状是 0 —— 两者都对，
但只有前者能当延迟样本）。

**实测证据**（真 broker、两个真实时钟）：

```text
# (1) 同一个事实，修前两个答案（CLI 内）：
state --json（回程）   时间戳在未来 ⇒ age_ms: null        ← 第十一轮立的规矩
sub   --json（帧）     同一时刻        ⇒ age_ms: 0         ← 修前：饱和值被当成测量
sub（人类形态）        ⇒ "… age=0ms …"                     ← 读作「刚刚到达」

# (2) 两个真实时钟的 e2e（发布者时钟快 5 秒，读者用本机时钟）
received.age()                    ⇒ Duration::ZERO       （`Timestamp::since` 的饱和，设计如此）
frame_age_ms(&stamp)              ⇒ Err(InTheFuture(≈5000))
received_line()                   ⇒ "… age=unknown(stamp is 5000ms in the future — that clock is not this clock) …"
received_json()                   ⇒ {"age_ms": null, …}   ← 绝不 0
（同一个渲染器，正常时钟）        ⇒ age=250ms / {"age_ms": 250}
（帧头 stamp=0，即纪元）          ⇒ 一个巨大但真实的年龄，**不是** unknown（`0` 只是回程的哨兵）

# (3) bench 的分类（单元级，两个时钟）
sample(now-2s) ⇔ 采样 ⇒ latencies=[2_000_000µs]；sample(now+1year) ⇒ skewed=1（不进直方图）
latency_line ⇒ "latency (publish -> decoded, us): min=… p50=… p99=… max=… (n=1) · 1 frame(s) excluded: …"
全不可测 ⇒ latency_us: null + "latency: none measurable (N frame(s) skewed)"
进程级：bench --count 20 --json ⇒ latency_us.samples=20、skewed=0、received=20
```

**负控实测**（4 次注入；每次从注入前的副本 `cp` 回来 `diff` 核验）：

| 注入的旧行为 | 新验证的反应 |
|---|---|
| 两个帧渲染器改回 `received.age()`（NC1） | `a_frame_stamped_in_the_future_has_no_age_to_print` ⇒ **FAILED**（`age=0ms` 又回来了） |
| `bench` 的 `sample()` 改回 `push(received.age().as_micros())`（NC2） | `a_benchmark_never_counts_an_unmeasurable_frame_as_zero_latency` ⇒ **FAILED**（`left: 0, right: 1` —— 未来那一帧又进了分布） |
| `sub` 去掉 `clock_synced`（人类行与 JSON 两处，NC3） | 进程级 `the_age_caveat_and_the_bench_sample_count_are_wired` ⇒ **FAILED**。**第一次注入没能编译**（少一个 `{}` 参数）—— 那是编译器在兜底，不是测试；重做成「完全合法的旧行为」后才是真的红 |
| `frame_age_ms` 借用回程的哨兵（`report_age_ms`，NC4） | `a_measurable_age_is_still_a_number_and_the_epoch_is_not_absent` ⇒ **FAILED**（纪元被说成 unknown） |
| 比较退化为毫秒（`stamp_ns/1e6 > now_ns/1e6`，NC5） | **第一次注入时 `the_benchmark_histogram…` 仍然通过，而且第二次也通过** —— 两个原因，都值得写下来：**(a)** 用例当时直接调 `frame_age_us`，**没有经过 `sample()`**（回归真正发生的那一行），名字比断言覆盖得多；**(b)** 改走 `sample()` 之后它**仍然是随机的** ——「未来 500 µs」是否跨过一个毫秒边界取决于 `Timestamp::now()` 恰好落在哪里（所以注入是「红或绿看运气」）。处置：把读者的时钟**钉在毫秒内部**（`nanos = 400_000`），于是该用例由**比较本身**决定；重注入 ⇒ **FAILED**，而且是**确定的**失败（`attempt to subtract with overflow` —— 毫秒比较把这一帧当成「现在」再相减）。 |
| `sample()` 用 `frame_age_ms × 1000`（NC6，也就是本轮自查到的那个回归） | 同一条用例 ⇒ **FAILED**（`a 250 µs age must survive into the histogram, got 0µs`） |

**诚实边界（本轮新增）**：

1. **饱和本身没有改，也不该改**：`Timestamp::since` 对回退时钟给 `0` 是**故意的**（对 duration 而言），
   本轮把「把它当测量」这件事从渲染器里拿掉，而不是改底座。唯一的比较是 `age_nanos_between`（纳秒，
   线上自己的单位），各种单位由它除出来；任何**新的**年龄渲染器都要走它
   —— 这条纪律写在 `Received::age()` 的文档里（事实与旁白唯一相遇的地方）。
2. **进程级造不出时钟偏斜**：一个 CLI 进程只有一个节点、一个时钟，而「节点不是自己的对端」是被保证的性质
   （与第十二轮归因行同一处边界）。所以偏斜本身由**单元级的两个真实时钟**证明（跨 broker 的发布/接收），
   进程级只证明**接线**（`clock_synced` 旁注、`bench` 的两个字段）。
3. **`bench` 的 `received` 变了含义**（现在含被排除的帧）：它是「收到的帧数」，而百分位数的基数是
   `latency_us.samples`；两个数字现在都印出来，`received = samples + skewed`。
4. **帧行的人类形态变了拼写**：`age=5000ms` → `age=5s`（同一个 `format_age_ms`，与回程行、面板一致）；
   数值不变，`grep 'age='` 的人会看到更短的一串。
5. **`age=unknown(…)` 的措辞变了**：原来是「the **robot's** clock is not this clock」，现在是
   「**that** clock is not this clock」—— 同一条规则现在也回答帧，而帧的发布者可能是大脑或工具，不一定是机器人。
6. **真机复核未做**：两块真板子（或一台时钟被 NTP step 的机器）上「拔掉/校准时钟后年龄变 unknown」的观感仍未验证。



### 3.16 同一份数字，两个传输：真网络上的节点把自己的计数器留在 0（第十五轮，REQ-A270）

> 起点是把 §3.15 的问法再推一步：**同一个事实在同一个 CLI 里只有一种回答 —— 那么同一份数字在两个传输上呢？**
>
> 不会一样。`published`/`delivered`/`dropped`/`blocked` 这四个计数器由 **传输**在事实发生的地方记录，
> 而 `record_published`/`record_delivered` 的全部调用点都在 **`broker.rs`** —— 也就是说
> 进程内 broker 会数，**Zenoh 一个都不数**。而现场跑的就是 Zenoh：`--transport zenoh` 的 CLI、
> 板卡上的 `LinkNode::with_parts(.., ZenohTransport, ..)`。
>
> 一句话：**仪器在进程内很诚实，一到真网络上就整体读到 0 —— 而 0 是没有说谎的形式在说谎。**

| # | 缺陷（修前，均有实测） | 为什么是缺陷 | 处置 |
|---|---|---|---|
| 1 | **网络传输不计数**：`ZenohTransport::publish` 只 `put` 然后返回报告，`subscribe` 的转发任务也不记；`ZenohTransport` 甚至**不持有**任何计数器。于是 `LinkNode::metrics()` 在 Zenoh 上永远是 0 | 这四个数字是操作员读到的**全部**：`status --json`、`watch` 的周期行、`LinkHealth::evaluate` 的判决、系统设置「机器人链路」页的计数行。一个正在跨会话发帧的节点报 `published=0 delivered=0`，而 **0 不会被读成「不知道」，只会被读成「没发过」**——正是本 crate 反复钉住的那条纪律的反面 | `ZenohTransport` 持有节点的那一组计数器（`open_with_metrics`/`with_metrics`/`metrics()`）：`put` 返回 `Ok` ⇒ `published+1`、`delivered+1`（与它自己的报告里 `delivered: 1` = "put on the wire" 同义）；转发任务把帧交给订阅队列 ⇒ `delivered+1`，订阅者已走 ⇒ `dropped+1`（与 broker 的分工一字不差）。CLI 的 `build_zenoh_node` 改为**一组计数器**贯穿传输与节点 |
| 2 | **这个不变式此前不可检查**：`LinkNode::with_parts` 同时收 `transport` 与 `metrics`，两者是**不同的 Arc 也不会有人发现** —— 节点照常工作、计数落进没人读的那一组 | 这是缺陷 1 的**成因**（CLI 就是这么写的），也是它**能藏这么久**的原因：一条只在文档里的不变式，等于没有不变式。本轮写自己的测试时**又踩了同一脚**（订阅侧传了节点的一组、传输持有另一组 ⇒ `delivered` 依旧是 0），说明这个形状随手就能复现 | 把不变式做**可比较**：`Transport::metrics()` 成为 seam 的一部分（broker / Zenoh / 测试替身都实现它），`LinkNode::with_parts` 在两组不是同一个 `Arc` 时 **`warn!`**（可见而不静默），并把「必须传传输那一组」写进 `with_parts` 的文档 |
| 3 | **同文档自相矛盾（文档缺陷）**：§4 的「测试现状」写着「真实 Zenoh 会话的往返用例（两个订阅者 + 一次发布）以 `#[ignore]` 标注」，而 §3.6 与 §7 **都写着同一个用例「不再是 `#[ignore]`」**（REQ-A243 已把它变成确定性的 TCP 环回往返） | 同一份文档的两节对同一件事给出两个答案；而且**看测试现状的人会以为这条证据不存在**（`-- --ignored` 才跑），于是要么重做一遍、要么不信任这个套件。`grep '#\[ignore'` 的真实答案是：`src/zenoh.rs` 里只剩**跨主机 scouting** 一个 | §4 的该段改写为事实：三个会话用例（往返、最长键、计数器）都在 `make test` 里跑；仍然 `#[ignore]` 的只有跨主机 scouting，并点名它 |

**实测证据**（真 TCP 会话、两个 peer、显式端点、关 scouting）：

```text
# (1) 修前：帧真的过去了，计数器仍是 0
cargo test -p amos-link --features zenoh --lib a_node_over_a_real_session_counts_what_it_publishes
  ⇒ 对端收到了 seq=1（sub.recv() 成功）
  ⇒ 但 metrics.snapshot().published == 0            ← assertion failed: left: 0, right: 1

# (2) 修后（同一条用例）
metrics.snapshot().published == 1（发布侧：一次成功的 put = 一帧）
subscriber_metrics.snapshot().delivered >= 1（接收侧：转发任务把帧交给订阅队列）
node.status().await.metrics.published == 1（操作员读到的那条路径）

# (3) 仍然不可见的部分（照实说）
Zenoh 自己的 RingChannel 在满时丢帧（best-effort）—— 那发生在 Zenoh 内部，
这一侧**看不到**，因此网络节点的 `dropped` 仍可能是 0；可见的真相是**订阅自己的** stats。
```

**负控实测**（2 次注入；每次从注入前的副本 `cp` 回来并核验）：

| 注入的旧行为 | 新验证的反应 |
|---|---|
| `ZenohTransport::publish` 去掉 `record_published`/`record_delivered`（NC1） | `a_node_over_a_real_session_counts_what_it_publishes` ⇒ **FAILED**（`left: 0, right: 1`）；这正是修前那条用例报出的同一句话 |
| 转发任务去掉 `record_delivered`（NC2） | 同一条用例的**接收侧**断言 ⇒ **FAILED**（`delivered: 0`，而帧确实到了订阅者手里） |

**诚实边界（本轮新增）**：

1. **`dropped` 在网络传输上仍不完整**：Zenoh 内部的丢弃（`RingChannel` 满、UDP 线缆丢包）发生在**我们的进程之外**，
   这一侧只能数「我把帧交给了订阅队列吗」。所以网络节点的 `dropped` 是**下界**，而**订阅自己的** `stats().received`
   才是消费者可见的真相。这条不写成「已解决」——它写在这里，也写在 §4 的表里。
2. **`delivered` 在两个传输上含义略有不同**（broker：本地扇出的队列数；Zenoh：`put` 上线 1 次 + 转发任务各 1 次），
   这正是 `PublishReport` 自带的写法（"accepted into a subscriber queue **or put on the wire**"）。数字不再撒谎，但跨传输比较时要知道口径。
3. **`blocked` 在 Zenoh 上天然是 0**：`put` 不阻塞我们的发布者（背压发生在 Zenoh 内部），这一条是**正确**的 0，不是缺失。
4. **`Transport::metrics` 是 seam 的新成员**：任何新的传输实现都必须回答它（否则编译不过），测试替身也一样；
   这条 seam 只能保证「传输持有的那一组」被节点读到，**不保证**调用方传对了——那由 `with_parts` 的 `warn!` 提示，而不是由类型系统。
5. **真机复核未做**：证据是 TCP 环回上的两个真实会话（真握手、真路由），没有在两块真板子/真 5G 回程上跑。



### 3.17 一条只写在文档里的降级路径：老 daemon 会把整页拖下水（第十六轮，REQ-A271）

> 起点是把 §3.16 的问法再推一步：**同一条契约，两个消费者会不会给出两个答案？** —— 这次是**有版本差**的时候。
>
> §6.5 写着「老版本的 daemon 没有这个 RPC 时，界面只是少显示一栏、不报错」；
> 而 `link_status` 里那一行是 `client.list_actuations(...).await.map_err(...)?` ——
> 一个 `?` 把「少显示一栏」变成了「**整页显示守护进程未连接**」，连 daemon **已经答过**的状态、对端表与判定一起丢掉。
>
> 一句话：**「我们没被告知」被当成了「没有人上报」** —— 而这正是同一个页面上写着「a robot that has not reported is absent, not idle」的那页。

| # | 缺陷（修前，均有实测） | 为什么是缺陷 | 处置 |
|---|---|---|---|
| 1 | **System UI 的桥把整次读取交给 `?`**：`crates/amos-tauri/src/link.rs` 的 `link_status` 先 `get_status`（已成功），再 `list_actuations(...)?` —— 老 daemon（没有这个 RPC）回 `Unimplemented`，于是命令返回 `Err`，前端把 `Err` 渲染成「守护进程未连接」并**清空所有数字** | 文档承诺的降级不存在；更糟的是**丢掉的是已经拿到的答案**（状态/对端表/判定都在同一次会话里答过了）。而这条 RPC 恰恰是「回程」——**老 daemon 与正在升级的现场**是最常见的组合 | 只对 `Unimplemented` 降级：回程成为 **`actuations: None`**（JSON `null`）+ 一条 `warn!`；**其它失败照旧 `Err`**（有实现却服务不了是真故障，不能折进「老版本」）。`status_out(&status, Option<Vec<..>>)` 随之把这个区分带进类型 |
| 2 | **CLI 的 `status --socket` 是同一个形状**：`ListActuations` 的失败同样靠 `?` 冒到顶层 ⇒ 老 daemon 上一条状态都读不到（`exit 1`） | 终端是**同一份契约的另一个消费者**：如果只有面板降级，那么「老 daemon 上能读到什么」就取决于你用哪个工具 —— 这正是本仓反复拒绝的形状（§3.10/§3.11）。而且 CLI 的 JSON 是脚本的输入：`actuations` 从数组变成 `null`，脚本必须能区分 | 同一个规则：`Unimplemented` ⇒ `Some/None` 三态 + `tracing::warn!`；人类形态打印 `robots reported: not answered by this daemon (no ListActuations — an older build); the status above was answered`，JSON 里 `actuations: null`（**绝不 `[]`**） |
| 3 | **前端把「没有回答」与「没人上报」渲染成同一句话**：`LinkStatus.actuations` 的类型注释写着「a daemon older than the RPC simply omits it: the panel must show less」，而页面只有两个分支（有列表 / `link.noReports`）；`link-page.svelte.test.ts` 里那条用例**把这个合并钉住了**（老 daemon ⇒ 断言 `link-robots-none`） | 一个「缺席」被渲染成「机群一句话都没说」——与本页自己那句「absent, not idle」直接矛盾；而**测试把它固定下来**，所以它不是疏忽而是**被接受的行为** | 三态成为类型与纯函数：`returnPathLevel(status) -> "unavailable" \| "none" \| "reported"`（`null` 与 `undefined` 都算 `unavailable`：反方向的版本差——**新面板 × 老桥**——是同一件事），`unavailable` 有自己的 testid 与文案（en/zh），那条钉住旧行为的用例改写成断言**相反**的事实 |

**实测证据**（真 UDS + 真 gRPC；两个「老 daemon」替身只实现一部分 RPC）：

```text
# (1) 修前（tauri 侧，`tests/link_status_e2e.rs`）：一个只有 GetStatus 的 daemon
link_status() ⇒ Err("robot-link ListActuations failed: code: 'Operation is not implemented …'")
                 ← 整次读取失败；而 GetStatus 已经答了 peer/uptime/peers

# (2) 修后（同一条用例）
link_status() ⇒ Ok(peer="amos-daemon", clock_synced=true, peers=[], actuations=null)
JSON: {"actuations": null, "peers": []}   ← 没有被回答的那一栏是 null，答过的照旧

# (3) 修前（CLI 侧，`cli_smoke.rs`）：`status --socket <老 daemon>` ⇒ exit 1，什么都读不到
#     修后：exit 0，且
remote=… link peer=amos-daemon … health=unknown        （已答的照常打印）
peers (1): … dog1 …                                    （已答的对端表照常打印）
topics (1): inventory complete                          （已答的清单照常打印）
robots reported: not answered by this daemon (no ListActuations — an older build); the status
above was answered                                      （没答的那一栏如实说明）
--json ⇒ "actuations": null（不是 []）

# (4) 面板（vitest）：老 daemon ⇒ [data-testid="link-robots-unavailable"] + 「这个守护进程不上报回程」，
#     且 link-robots-none **不存在**；老桥（字段整个缺席）走同一条分支；counterSummary 照常显示
```

**负控实测**（3 次注入；每次从注入前的副本 `cp` 回来并核验）：

| 注入的旧行为 | 新验证的反应 |
|---|---|
| 桥改回 `list_actuations(...)?`（NC1） | `a_daemon_without_the_return_path_still_answers_the_panel` ⇒ **FAILED**（`a daemon without ListActuations must still answer the status`，逐字复现修前的错误串） |
| CLI 改回 `with_context(...)?`（NC2） | 进程级 `an_older_daemon_still_answers_the_status_over_a_socket` ⇒ **FAILED**（exit 1） |
| 面板去掉 `unavailable` 分支（NC3） | `link-page.svelte.test.ts` 的那条用例 ⇒ **FAILED**（`link-robots-none` 又出现了） |

**诚实边界（本轮新增）**：

1. **只对 `Unimplemented` 降级**：`tonic::Code::Unimplemented` 是「这个 RPC 不存在」的**唯一**可靠信号。别的失败
   （`Internal`/`Unavailable`/超时）一律照实报错——把「服务不了」也说成「老版本」会让真故障**永远沉默**。
   这条规则写在两个消费者的代码里，也写进 §5 的契约表。
2. **「老 daemon」的两个方向都覆盖了**：老 **daemon** × 新面板（`actuations: null`）与老 **桥** × 新面板
   （字段整个缺席）都读作 `unavailable`；但**老面板 × 新桥**（字段可能是 `null` 而老代码只认数组）**没有**覆盖 ——
   那个方向的兜底是 `?? []`（读成「没人上报」），属于升级顺序问题，本轮不动（面板与桥同包发布）。
3. **`status --socket` 的 JSON 多了一个可能的 `null`**：`actuations` 现在是 `[] | null`，脚本若要区分必须显式判断；
   人类形态的一行说明是新增的（老 daemon 上以前什么都看不到）。
4. **面板的行为在「老 daemon」上是新增文案，不是新增数据**：`unavailable` 只说「它没有回答」，绝不推断机群状态。
5. **真机复核未做**：证据落在真 UDS + 真 gRPC（两个只实现部分 RPC 的替身服务）+ 真前端测试；
   没有一台**真的旧版本 daemon 二进制**可用（版本化部署属现场的升级顺序问题）。

### 3.18 同一份 QoS，两个传输上是两种东西：ROS 对照复核（第十七轮，REQ-A272）

> 起点是这一轮的题面本身：**对照 ROS 2 的功能再核一遍**。于是先做对照表（§8），再从表里挑出「我们声称对齐」
> 的那一行去查代码 —— **QoS：`Reliability{BestEffort,Reliable} × depth × DropPolicy`，`qos.rs` 的模块文档说
> 「DDS 叫 QoS，ROS 2 叫 reliability + history depth，我们用同一个东西表达」**。
>
> 一查就露：**这份 QoS 只在进程内有效**。`Broker::subscribe` 为 `DropOldest` + depth 1（`Qos::sensor()`，
> 「latest sample wins」）建的是**单槽覆盖队列**；而 `ZenohTransport::subscribe` 走的是 `Subscription::remote`
> ——**没有槽**（`slot: None`），只有一个 `mpsc` + 一个「阻塞式 `send`」转发任务。于是**同一份 QoS 在两个传输上
> 语义不同**，且**丢帧数在两个传输上都读不到**。
>
> 一句话：**QoS 是「订阅的属性」，不是「broker 的属性」** —— 而这正是 ROS 2 / DDS 的立场（QoS 由中间件在
> 每个传输上兑现）。本仓自己的 `qos.rs` 却把 `LatestSlot` 留在了 `Broker::subscribe` 里，等于把契约绑在了
> 一个传输上。

| # | 缺陷（修前，均有实测） | 为什么是缺陷 | 处置 |
|---|---|---|---|
| 1 | **`Qos::sensor()` 在网络传输上不是「最新的一帧赢」**：`ZenohTransport::subscribe` 对 `is_latest_only()` 也只建 `mpsc(depth)` + 转发任务 `tx.send(..).await`。一个「忙了 10 帧」的消费者醒来拿到的是**它卡住时被抽走的第 1 帧**（最老的那一帧），而不是第 10 帧 | `qos.rs` 的原话是「a consumer that was busy for 10 frames **wakes up holding frame 10** — never a backlog of 10 stale ones」。而在真网络上（相机板 → 大脑，**这条 profile 就是为它写的**）拿到的是**陈旧帧**——正是「stale depth is worse than no depth」要避免的东西。ROS 2 的 KEEP_LAST(1) 在任何 transport 上都意味着「最近的一帧」 | 远端订阅也按 **sink** 分形状：`is_latest_only()` ⇒ `Subscription::remote_latest`（单槽，`LatestSlot::offer`/`offer_blocking`），其余 ⇒ 队列。`Broker::subscribe` 建哪种、远端就建哪种 |
| 2 | **`DropPolicy::DropNewest` 在网络传输上从不生效**：转发任务对**任何**可靠性都做阻塞 `send`，于是「队列满 ⇒ 丢新帧」被实现成了「队列满 ⇒ 背压整条链路」 | 一个 depth 2 的 best-effort 订阅**承诺**满了就丢，实际却把生产者/网络拖住；更糟的是**没有任何计数器动**：`sub.stats().dropped` 与节点的 `dropped` 都读 0，而帧真的没了 —— 破的正是本仓反复强调的「**`0` 不是「不知道」的说法**」（§3.15 同一条纪律） | 转发任务按 `$reliable` 分支：best-effort ⇒ `try_send` 失败即丢并**计数**；reliable ⇒ `try_send` 后再 `send().await`（与 broker 一字不差） |
| 3 | **订阅自己的计数器在网络传输上是死的**：`SubCounters` 只被 broker 触碰（`LatestSlot::offer`、队列满、槽被毒化）；转发任务只写**节点**那一组（`metrics`），而且只写「消费者不见了」这一种 | `SubscriptionStats` 的文档写着「`dropped` covers **every** way a frame this subscription was routed can fail to arrive… 与节点的 `metrics.dropped` **count the same frames, so the two never disagree**」。进程内为真，网络上是假的（一个恒为 0）——`sub --transport zenoh` 的收尾统计、`bench` 的 `dropped`、面板都读它 | 新增 `RelayCounters`：**三种结局**（`stored` / `replaced` / `lost`）与 broker 的发布路径一一对应，每处只动它该动的那一组（`replaced` 只动节点那一组，因为槽已经记过订阅侧；见 §3.18 后的边界 2） |

**实测证据**（真 TCP 环回会话，两个 session、真 `put`/订阅路由；帧间隔 50 ms，消费者**故意**全程不 poll）：

```text
# (1) Qos::sensor()（DropOldest + depth 1）：连发 5 帧，然后才 recv
修前： recv ⇒ seq=1      sub.stats().dropped = 0     ← 最老的那一帧，4 帧「凭空消失」
修后： recv ⇒ seq=5      sub.stats().dropped = 4     节点 metrics.dropped = 4
       （与进程内 broker 的同名用例逐字一致：frame 5 + dropped 4）

# (2) BestEffort depth 2 + DropNewest：连发 5 帧
修前： recv ⇒ 1, 2, 3 …（第 3 帧在 400 ms 内到达 = 转发任务在背压，而不是丢）
      sub.stats().dropped = 0    节点 metrics.dropped = 0
修后： recv ⇒ 1, 2，之后 400 ms 无帧（满即丢，不背压）
      sub.stats().dropped = 3    节点 metrics.dropped = 3
```

**负控实测**（2 次注入，均为**单条命令内**注入 → 跑测 → 从注入前副本 `cp` 回来 → `diff` 核验）：

| 注入的旧行为 | 新验证的反应 |
|---|---|
| 转发任务改回「任何可靠性都阻塞 `send`」（NC1） | `a_best_effort_queue_over_a_real_session_drops_the_newest_and_counts_it` ⇒ **FAILED**（`a full best-effort queue drops; it does not back-pressure the link` —— 第 3 帧真的又出现了） |
| 远端订阅去掉单槽、全部走队列（NC2） | `a_latest_only_subscription_over_a_real_session_keeps_the_newest_frame` ⇒ **FAILED**（`left: 1, right: 5`，逐字复现修前的观察） |

**诚实边界（本轮新增）**：

1. **传输边界内仍然丢得看不见**：`RingChannel`（best-effort 的 Zenoh 侧）自己满时会丢**最老**的样本，`FifoChannel`
   会阻塞 Zenoh 的投递线程；这两件事发生在本 crate 之外，**不计入**任何计数器（§3.16 边界 ① 不变，仍是下界）。
   本轮修的是「**我们自己的消费队列**」那一层的语义与计数 —— 那正是 `network_reliability_note` 一直说我们保证的东西。
2. **`replaced` 只动节点那一组计数器**：单槽覆盖时，**槽**已经记了订阅侧的 `dropped`（它拥有那个计数器，
   `LatestSlot::offer` 的既有行为）；转发任务若再调 `lost()` 会把**一次丢失算两次**。这条分工与 broker 一字不差。
3. **`blocked` 在网络节点上仍然是 0，这是有意的**：它定义为「**本节点的发布路径**等待过慢订阅者」。网络路径上等待的是
   *转发任务*（我们的消费者），不是我们的发布者 —— 把两者合并会让「远端生产者被本机慢消费者拖住」伪装成
   「本机发布被拖住」。§4 的边界因此不变（只是多了一句：reliable 的远端订阅**会**把背压传给 Zenoh 的 FIFO 通道）。
4. **`FORWARD_CHANNEL = 64` 仍是上限**：`depth > 64` 的订阅在 Zenoh 侧的处理器容量被夹到 64（本地队列仍是 `depth`）。
   这是既有的、写在 `FORWARD_CHANNEL` 上的边界，本轮不动，只是它现在**同时**决定了两种 sink 的形状。
5. **两帧之间的「中间那几帧」仍然只能靠序号推断**：latest-only 现在会**数**被覆盖的帧，但被覆盖的是*哪几帧*只有
   `SeqTracker` 能说（它按 `(publisher, topic)` 记序号，§3.13）—— 计数器与追踪器回答的是两个问题。
6. **真机复核未做**：证据是同一个进程里两个真 session 的 TCP 环回（真握手、真路由、真 `put`），
   没有两块板子/真 Wi-Fi-5G 的现场数据；`#[ignore]` 的跨主机 scouting 用例仍然忽略。

### 3.19 「这条流还在按它的频率跑吗？」——`hz`，以及为它做的三处修正（第十八轮，REQ-A273）

> 起点是上一轮自己留下的那张表：§8 的 ROS 2 对照里，`ros2 topic echo / hz / bw` 那一行是唯一还写着
> 「速率的代理是 `published` 与序号缺口」的 ⚠️。**本 CLI 一个速率数字都没有** —— `bench` 测的是它自己造的
> 合成发布者，`watch` 数的是心跳。于是「相机掉到 10 fps」「大脑不再发控制指令但心跳照打」「IMU 驱动在高负载
> 下限速」这三类故障，**在操作员能读到的任何数字里都不存在**：丢帧计数干净（没有丢帧），判决健康（心跳还在），
> 而流已经不跑它的频率了。`ros2 topic hz` 存在的全部理由就是这个问题。
>
> 本轮把它补上，并顺手修掉实现过程中撞出来的三处缺陷。

**交付**：内核 `crates/amos-link/src/rate.rs`（`RateTracker` / `StreamRate` / `RateEvidence`，**纯状态机**：
无 I/O、无时钟、到达时刻由调用方注入 ⇒ 单测用注入的时刻把速率钉成算术，而不是测量本机调度器）+
CLI 新命令 **`hz`**（`--pattern` / `--qos` / `--seconds` / `--json`，每 1 秒打印每条流一条读数）。

**三条诚实点**（都是本仓反复付过学费的那几条）：

1. **用我们自己的单调时钟的到达时刻，绝不用帧里的 `stamp`**。用远端时间戳算速率，会在两块板卡时钟不一致时
   悄悄变成另一种量 —— §3.15 对「年龄」的教训，用在第二个测量上。副产品：**速率不需要时钟校准**，
   `clock_synced=false` 不削弱它。
2. **速率 = 间隔数 / 跨度**（`(frames − 1) / span`），不是 `frames / span`（后者在 60 Hz 上快 ~1.7%，
   在两帧时快 100%）。`frames` 与 `span` 就印在与数字**同一行**，读者随时可以自己复核算术。
3. **说不出速率时说原因，绝不说 `0`**：一帧 = `unknown(one frame so far (no interval to divide by))`；
   跨度短于 `MIN_RATE_SPAN`（500 ms）= `unknown(only 40ms of span …)`。`0 Hz` 会被读成「机器人停止发布了」，
   那是关于**别人**的断言，而我们只知道自己这个窗口。`--json` 里是 `"rate_hz": null` + `"why": "single-frame"`。

| # | 本轮撞出的缺陷（都是为 `hz` 找路时发现的，均已实测） | 为什么是缺陷 | 处置 |
|---|---|---|---|
| 1 | **只要信封的消费者要复制整份帧**：`Envelope::decode` 以 `payload.to_vec()` 结束，而速率/计数/转发这类消费者只需要 `(topic, publisher, seq, stamp)` —— 上限 16 MiB 的帧，每帧一次 memcpy | 与 §3.3「接收路径永不构造第二份帧」同一条纪律（那条只修了 CRC）。一个 60 Hz 的深度流会为「读一个头部」付出 60 MB/s 的拷贝 | 新增 **`Envelope::decode_header(frame) -> (Header, &[u8])`**（借出负载切片），并让 `decode` 写在它之上：**一份解析器、两副形状**，magic/版本/长度/CRC/头部校验不可能在两条路径之间漂移（校验就是拒绝敌对帧的那几道，第二份实现等于第二种意见） |
| 2 | **订阅 profile 规则写了两遍**：`sub` 与 `state` 各自实现「`--qos` ＞ pattern 的 channel ＞ 默认」，而 `hz` 会是第三份 —— 同一个 pattern 在两个命令里可能选出**不同的 profile**（正是 §3.18 修过的形状：同一份契约两个消费者给出两个答案） | 复制粘贴的规则会在下一次修改时漂移，而漂移的后果是「控制流被 best-effort 丢掉」这条最危险的默认 | 抽成 `subscription_qos(pattern, requested, default_channel)`：`--qos` 胜；否则 **pattern 自己的 channel**（`amos/*/control/**` 永远拿 reliable）；否则调用方文档化的默认（`sub`/`hz` = sensor，`state` = state）。**打印出来的来源文案不变**（`from channel control` / `from --qos` / `from default (no channel in the pattern)`） |
| 3 | **一个用例钉住了一次 `select!` 竞态**：`watch` 的判定断言写在「状态 tick」那一行上，而 `tokio::time::interval` 的**第一次 tick 是立即的** ⇒ 负载高时它先于本节点自己的第一拍触发，此刻 `published=0`、无证据 ⇒ `health=unknown`（那一瞬间诚实，但不是整轮的结论）。实测：全量跑时该用例偶发失败（`got … health=unknown`），单跑三次全过 | 一个「通过或失败取决于哪个分支先跑」的用例，既不能证明它声称的事实，还会在有人真正改坏判定时给出错误信号 | 判定**同时写进收尾 summary**（`watched 1s: … health=degraded: no_peers, clock_unsynced`，`--json` 的 summary 事件加 `health` 对象）；用例改为断言 summary，tick 行只断言**形状**（` tracking=complete health=`）。summary 折的是整窗的累计事实，因此与机器负载无关 |

**实测证据**（真二进制、进程级）：

```text
$ amos-link-cli hz --seconds 1                     # 空闲链路：没有任何数字可编
measuring transport=broker peer=amos-node pattern=amos/** qos=best-effort/drop-oldest \
  from default (no channel in the pattern) every=1000ms for 1s · clock_synced=false: …
no frames observed in 1s (an idle link is not a 0 Hz stream; check --pattern and --transport)
summary streams=0 frames=0 untracked=0 undecodable=0 complete=yes ran=1s

$ amos-link-cli hz --seconds 1 --json              # 机器形态：rates 为空数组，绝不虚构 rate_hz
{"event":"measuring","every_ms":1000,"from":"default (no channel in the pattern)",…}
{"complete":true,"event":"hz_summary","frames":0,"rates":[],"seconds":1,"streams":0,…}

# 内核：注入时刻，把速率钉成算术（`cargo test -p amos-link --lib rate::`）
5 帧 × 250 ms ⇒ span=1s、rate=4.0Hz（`frames/span` 会给出 5.0Hz）；1 帧 ⇒ None + `single-frame`；
2 帧 × 250 ms（span=250ms < 500ms）⇒ None + `span-too-short{span:250ms}`；2 帧 × 500 ms ⇒ 恰在界内 ⇒ Some(2.0)
一台 peer 的两个话题 ⇒ 两条流两个速率（§3.13 的键在速率仪器上的同一个道理）
乱序注入的时刻 ⇒ span 饱和到 0、速率**不说**（不会因减法回绕而给出看似合理的错数）
超过 MAX_TRACKED_STREAMS ⇒ `Untracked` 计数、`complete=no`，且 `reset()` **不擦掉**这个证据

# 信封只读（`cargo test -p amos-link --lib the_header_only_reader`）
decode_header 返回的负载切片指向**帧内**（不是新缓冲）；decode 与 decode_header 对坏 magic/版本/
截断/CRC/长度上限给出**逐字相同**的拒绝理由
```

**诚实边界（本轮新增）**：

1. **印出来的是「自 `hz` 启动以来的平均速率」**（与 `watch` 的 `beats_seen` 同一形状），不是滑动窗口。
   一个「先 60 Hz 跑了 60 s、然后死了 30 s」的流会读成 ~40 Hz —— 停住这件事体现在**同一行的 `frames` 不再增长**，
   而「速率跌到 0」这种说法需要窗口，窗口在 1 秒的采样上只是在描述本机调度器（因此**故意不做**窗口速率）。
2. **`MIN_RATE_SPAN = 500 ms` 是策略，不是定理**：它把「3 帧挤在 40 ms 内的 ~50 Hz」这类**关于调度器的**数字挡在门外，
   代价是慢流（1 Hz 心跳）在前两拍内只能得到 `span-too-short`，要等满 500 ms 才有数。
3. **`hz` 是数据面命令**：`--socket` 会被按名拒绝（控制面不携带 per-topic 速率），因此它测的是**本进程所在的这条链路**
   —— 在板卡上就是 `--transport zenoh` 那条真链路。
4. **`undecodable` 是单独计数的**：一个连本 crate 的 `Envelope::decode_header` 都拒绝的帧不是任何流的到达，
   它进 `undecodable`（summary 里可见），不会被折进任何速率。
5. **真机复核未做**：证据是内核注入时刻的单测、进程级的空闲链路输出与真二进制行为；没有两块板卡/真 Wi-Fi-5G 的现场采样。

### 3.20 「这条流占了多少链路？」——`bw` 并入同一台仪器（第十九轮，REQ-A274）

> 上一轮补掉 §8 里 `hz` 那半格之后，同一行的 `bw` 还空着：**按话题的带宽没有对应物**。
> 而「跑得多快」和「占了多少」是同一个问题的两半 —— 60 Hz 的立体相机和 10 Hz 的不是一条链路，
> 60 Hz 的 160×120 和 60 Hz 的 1920×1080 也不是。
>
> **不新开一条命令**：第二条命令会有自己的订阅、自己的窗口、自己的一份「说不出就别说」的实现 ——
> 那正是上一轮刚修掉的形状（`sub`/`state` 各写一份 profile 规则、`hz` 会是第三份）。所以
> `hz` 的同一条读数上多了两个数：`bytes=` 与 `bw=`，与 `rate=`/`span=` 出自**同一个窗口**。

| 想做 | 做法 | 为什么这么选 |
|---|---|---|
| 数字节 | 每次到达**必须**带上它的 framed 大小（`RateTracker::observe(.., bytes)`，`observe_received` 直接取 `Received::frame_len`） | 一个窗口两半数字，不可能出现「速率来自这一窗、带宽来自那一窗」；framed 大小 = 中间件**真的搬过**的字节（`magic│ver│hdr│crc32│payload`），不是猜的负载大小 |
| 算带宽 | `bytes / span`（**不是** `(bytes − first) / span`） | 印出来的总数就是分子 —— 读者可以用同一行的 `bytes` 除以 `span` 自己复核；代价写在下面的边界 ② |
| 说不出时 | 与速率**共用**一条规则（`MIN_RATE_SPAN`）：两者同时为 `Some` 或同时为 `None`，`evidence()` 只解释一次 | 一个窗口不可能「够算速率但不够算带宽」；两个理由字段迟早会互相矛盾 |

**实测证据**（两个真进程、真 Zenoh 会话、环回 scouting；发布方 `pub --count 20 --hz 10`）：

```text
$ amos-link-cli hz --transport zenoh --pattern 'amos/**' --seconds 9
measuring transport=zenoh peer=amos-node pattern=amos/** qos=best-effort/drop-oldest \
  from default (no channel in the pattern) every=1000ms for 9s · clock_synced=false: …
rate publisher=amos-node topic=amos/dog1/sensor/imu frames=9  span=0.82s rate=9.8Hz bytes=927  bw=1.1KiB/s
rate publisher=amos-node topic=amos/dog1/sensor/imu frames=19 span=1.84s rate=9.8Hz bytes=1957 bw=1.0KiB/s
…（同一读数每秒重印，直到窗口结束）
summary streams=1 frames=19 bytes=1957 untracked=0 undecodable=0 complete=yes ran=9s

# 发布方（同一会话的另一端）：published seq=20 … delivered=1 dropped=0 blocked=0
# 读数的自洽性：18 个间隔 / 1.84 s = 9.78 Hz ⇒ `rate=9.8Hz`；1957 B / 1.84 s = 1063 B/s ⇒ `bw=1.0KiB/s`
# 1957 / 19 = 103 B/帧 —— 与「`hi` + 头 + CRC」的量级一致（§3.20 的边界①说这是整帧的账）
```

**诚实边界（本轮新增）**：

1. **`bytes` 是整帧的账，不是负载大小**：它回答「这条流花了链路多少」，所以包含头与 CRC（每帧几十字节，
   小帧上占比可观 —— 上面 103 B/帧里大部分是框开销）。想知道负载大小要减去框开销，本命令不给这个数。
2. **`bytes / span` 把第一帧的字节算进分子，却不算进分母**（它的到达时刻就是 `span` 的起点）：帧数一多就低于
   千分之一，且换来「印出来的数字能自证」；若要精确的「窗口内搬运量」，需要 `(bytes − first)/span`，
   但那个分子不在行上，读者无法复核 —— 这是**有意的取舍**，写在 `rate.rs` 的模块文档里。
3. **总数饱和、不回绕**：`bytes` 用 `saturating_add` 累计（与 `next_seq`、`LinkMetrics` 同一条规则）。
   一个跑了数周的消费者绝不能因为回绕而报出**比真实负载更低**的带宽 —— 那是唯一不可接受的方向。
4. **仍然是「自 `hz` 启动以来的平均」**（§3.19 边界①不变）：停住体现为 `frames`/`bytes` 不再增长。
5. **发布方发的帧数与 `frames=` 可能不等**：链路**没有留存**（§6.4），`hz` 订阅建立之前发出的帧本来就不存在 ——
   上面 20 发 19 收正是这件事，不是丢帧（丢帧由 `sub` 的序号缺口回答）。
6. **真机复核未做**：证据是同一台机器上两个真进程的真 Zenoh 会话（真 scouting、真 `put`/路由），
   没有两块板卡/真 Wi-Fi-5G 的现场采样。

### 3.21 三个应用案例：把「中间件成立」变成「应用成立」（第二十轮，REQ-A276）

> 前十九轮把中间件自己磨得很利：信任边界、序号归属、速率、带宽、回程、判定的词汇表。
> 但**没有一个应用案例**：仓库里的例子只有 `robot_brain_loop` 一个（§2 的数据流），
> 而"巡检机器人怎么用这套东西""监督台看什么""不在链路上的大脑怎么参与"这些**用法**，
> 以及应用层依赖的性质（最新一帧赢、拒绝读得懂、看门狗在监督台看得见、控制面注入是真帧）
> —— 一个都没有被**断言**过。例子只打印；打印的东西不会在有人改坏它时报错。
>
> 本轮把这一面补上：三个可运行案例 + 一份案例目录（[`docs/robot-apps.md`](robot-apps.md)）
> + 10 例案例级测试（断言性质，不是打印）+ 3 个负数控制（每条性质都在生产代码里改坏过一次，
> 确认对应用例**失败**，再逐字节还原）。

| # | 案例 | 例子 | 断言的性质（`tests/robot_cases.rs`） |
|---|---|---|---|
| ① | 巡检任务（一条闭环） | `examples/patrol_mission.rs` | 一条步态 = 1×`Enable` + 每关节位置帧（13）；回程带**实际**看门狗周期；切扭矩的帧数是 HAL **报出来的**且原因是 `watchdog`；e-stop 后运动被拒且原因点名 `arm`；`arm` 清锁并清拒绝记录；未知步态/非 JSON ⇒ `Refused` 且 `hal.applied()==0`（拒绝 ≠ 半应用）；连发 3 帧 ⇒ 拿到第 3 帧、`dropped==2`；注入时刻下 6 帧/500ms ⇒ `10.0Hz` 与 `1560 B/s`，单帧 ⇒ `single-frame` |
| ② | 机群监督台（多机只读测量） | `examples/fleet_console.rs` | 通配订阅看到全部机器人、**不含自己**、全部来自信标（非 static）、自我信标**被过滤且被计数**；两台机器人各自的看门狗都切扭矩，监督台在一条订阅上收到**两条**报告并按帧头归属；注入时刻下 4 条流 4 个窗口互不串（10Hz / 4Hz / 单帧 / 状态流），`bytes` 总和自洽，`rates()` 顺序稳定 |
| ③ | 不在链路上的大脑（控制面） | `examples/remote_brain.rs` | `Publish` 回复带控制面自己的序号且 `matched==1`；机器人侧**类型化**订阅者解出 `Gait::Trot`/`speed`/`duration_ms`，帧头署名是控制面节点；注入后 `ListActuations` 读回 `armed/frames/gait`；沉默一个看门狗周期后同一 RPC 读出 `estopped=true` + `estop_reason=watchdog`，归属按帧头而非载荷自称 |

**案例目录为什么要单独一份文档**：案例把"应用能依赖什么"写成了可执行的东西，而这份依赖**必须有一张契约表**
（话题 → channel → profile → 为什么）。那张表在代码里只有一处实现（`Qos::for_channel`），
并由 `the_catalogue_topics_use_the_profile_their_channel_implies` 钉住 —— **文档与中间件不许各说一套**。

**负数控制（3/3，每次都逐字节还原，`cmp` 证明）**：

| # | 在生产代码里改坏什么 | 失败的用例（实测） |
|---|---|---|
| 1 | `Qos::sensor()` 的 `DropOldest` → `DropNewest`（= 队列留最老那帧） | `case_1_the_camera_stream_is_latest_wins_and_the_loss_is_counted`：`left: 1, right: 3`（"醒来拿到的是最新一帧"） |
| 2 | `Gait::is_motion` 恒为 `false`（= 急停锁不住运动） | `case_1_the_patrol_loop_applies_refuses_and_reports`：`expected a refusal, got Applied { seq: 2, frames: 13, armed: true }` |
| 3 | `service::start_actuation_watch` 直接 `return None`（= 控制面不再折叠回程） | `case_3_the_deadman_is_visible_from_outside_the_link`：3.02 s 后 `left: 0, right: 1`（"one robot has reported"） |

**诚实边界（本轮新增）**：

1. **案例测的是中间件，不是一台机器人**：①–③ 走 `MockRobotHal`（记录型总线）。没有真电机被驱动过，
   案例④（`tests/hardware_hal.rs`，写**真描述符**）也只是"字节真的出去了"。
2. **HAL 的关节表是参考四足的**（`JOINTS=12`、`leg*3+(hip|thigh|knee)`、毫度整数）：轮式底盘、机械臂、
   无人机要各自实现 `RobotHal`。中间件与形态无关（它搬字节），**这一层**与形态有关。
3. **案例的读数是"打印它的那个进程收到的到达"**（§3.19 边界①/§3.20 边界②）：监督台自己慢了会漏帧，
   漏掉的计进 `dropped` 并印在同一张表的 note 行上；停住的流靠 `frames` 不再增长暴露，**绝不**印成 `0 Hz`。
4. **案例在同一台机器的一个进程里**（案例③ 是同一台机器上的真 UDS + 真 tonic）：真板卡、真 Wi-Fi/5G、
   真交换机的现场验证仍是 bring-up 项。
5. **案例的时钟是宿主时钟**：所有延迟都是上界，直到 `amos-timesync` 校准（案例输出自己写着这一句）。

### 3.22 平台剖面：一个 OS，六类机器（第二十一轮，REQ-A277）

> 上一轮把"应用"补上了（§3.21），但那一轮的三个案例全是**同一台机器**：参考四足。
> 而我们真正要服务的是**无人机、具身机器人、工业自主设备、汽车自动驾驶、无人艇**这几类 —
> 它们与四足的共同点只有"需要一条链路 + 一套安全语义"，执行器、单位、词表、**停机方式**全都不同。
>
> 本轮把"四足专用"的那一层（`robot_hal` 的意图词表与 12 关节姿态表）抽象成**平台剖面**：
> 描述是**数据**（执行器表 + 动作表 + 安全包线），机器实现是**共用**的（帧、类别、看门狗、回程、控制面）。

**交付**：`crates/amos-link/src/platform.rs`（`PlatformKind` / `Unit` / `Actuator` / `ActionSpec` /
`ParamSpec` / `IntentClass` / `Failsafe` / `SafetyEnvelope` / `Platform` / `Vocabulary`）+
六份内置剖面 + `RobotBridge::for_platform`（同一安全核心换了词表）+ 新文档
[`docs/robot-domains.md`](robot-domains.md)（每域契约、协议/认证/实时性的域侧责任、诚实边界）+
两个域案例（`examples/uav_mission.rs`、`examples/road_autonomy.rs`）+ `tests/platform_cases.rs`（**13 例**）。
第二十二轮（§3.23）把**接受边界**与**部署自定义剖面**补上 ⇒ 该套件现在是 **18 例**。

**四条设计决定，每条都有代价写在边界里**：

| 决定 | 为什么 | 代价 |
|---|---|---|
| **规划进出货帧**（`MotorFrame`，没有第二套线格式） | 总线的 CRC16/10 字节布局已经与形态无关；多一套格式 = 多一份校验与拒绝理由 | 剖面行程必须落在参考机的参数空间内（±90°，0..=100% 非负）⇒ **倒车推力、毫米直线轴今天不可表达**（登记在 §5） |
| **类别共用**（`Arm`/`Motion`/`Halt`），停机**动作**归剖面 | 安全核心只该知道三件事；车的 `Halt` 是全力制动、机械臂是切扭矩、单元是断电 | 三类机器的"停"不再长得一样，回程必须靠剖面解释 |
| **看门狗的最小动作是本层的**（剖面的 halt 批次），**机动**归任务层 | 本层知道"停"，不知道"家在哪"；无人机切桨不是降落 | 无人机/无人艇必须自带任务层执行 RTL/值守（案例演示了这一点） |
| **参考机逐字节不变** | 19 轮的行为不能被一次抽象改坏 | 剖面必须复刻四足的历史怪癖（运动批次前导一个 `Enable(0)`），并由等价测试钉住 |

**为域补的一条安全语义（本轮新增，来自写无人机案例时的实测）**：剖面机器在**未解锁**时收到
`Motion` 会被**拒绝**并点名它自己的解锁动作（`arm` / `enable`），拒绝写在回程里 ——
"油门动了但什么都没发生"正是这类系统最危险的形状；参考机自身在运动批次里带 `Enable`，
因此这条分支对它**永不触发**（等价测试仍然逐字节为证）。

**实测（真跑，删节）**：

```text
$ cargo run -p amos-link --example uav_mission
platform drone · failsafe=return-to-base · deadman=300ms
  actuator  0 thruster_1   thrust  mpercent  travel 0..=100000
  action   goto      motion  params=["north_mm -300000..=300000", …, "altitude_mm 0..=120000"]
gcs -> {"action":"takeoff"}  [matched=1 delivered=1]
uav-01: refused #1: not armed: send {"action":"arm"} first
uav-01: applied #2, 6 frame(s) on the bus
uav-01: applied #4, 6 frame(s) on the bus                      # goto 在围栏内
uav-01: refused #5: north_mm 420000 mm is outside the limit -300000..=300000 of action `goto` (drone)
uav-01: stopped (watchdog) — 6 frame(s) the bus accepted
profile drone: failsafe=return-to-base — a torque cut is not a landing, so the *mission layer* flies it
mission layer: rtl wrote 6 frame(s) through the same HAL

$ cargo run -p amos-link --example road_autonomy
platform ground-vehicle · failsafe=minimal-risk-manoeuvre · deadman=100ms · stop="brake 100000" + throttle cut
planner cadence: frames=12 span=0.57s rate=19.2Hz (its own clock; the wire's rate is the broker's business)
car-01: refused #12: lane_offset_mm 4200 mm is outside the limit -1750..=1750 of action `lane_keep` (ground-vehicle)
car-01: refused #13: speed_mm_s 40000 mm/s is outside the limit 0..=36000 of action `cruise` (ground-vehicle)
car-01: stopped (watchdog) — 3 frame(s) the bus accepted
mission layer: decel wrote 3 frame(s), the halt batch wrote 3 (brake=100000, throttle=Estop)
```

**诚实边界（本轮新增）**：

1. **12 个执行器的上界**（`JointId`）：24 轴机械臂需要"剖面自己的" id 上界 —— 布局已通用，界还是参考机的策略。
2. **参数空间非负**：`SetTorque` 0..=100 000 ⇒ 倒车推力不可表达（艇剖面登记为现场项）；直线轴用行程百分比。
3. **回程共享文档的 `gait` 字段仍属四足词表**：剖面的动作键**不**写进它（那是一次载荷 schema 变更，连带
   proto 与界面），剖面机器把 `gait` 留空、安全事实照常上报，域自己的模式走自己的话题。
4. **没有认证、没有实时承诺、没有真机**：剖面是策略与契约，不是安全论证；两个域案例跑在同一台机器的一个进程里。
5. **剖面不是规划器**：`goto` 不生成轨迹、`lane_keep` 不做横向控制、`cycle` 不编排节拍 —— 那些在域侧。

### 3.23 剖面的接受边界：把"收下、校验、然后丢掉"逐条堵死（第二十二轮，REQ-A281）

> 上一轮（§3.22，REQ-A277）的**双 agent 只读审计**（REQ-A278）判定 `platform` 面 0 缺陷 ——
> 它读的是代码。本轮改成**实测**：把每一类 JSON 喂进 `Platform::parse_intent`、把产出的帧打出来，
> 三条真缺陷当场现形，另外四条"说得出但做不到"的措辞也一并纠正。

**三条真缺陷（都是"收下、校验、然后悄悄不用"）**：

| # | 实测到的形状 | 为什么危险 | 现在的回答 |
|---|---|---|---|
| 1 | `{"action":"takeoff","speed":0.0}` 与 `speed:1.0` 产出**同一批** 4×55% 推力帧 —— `speed_scaled: false` 的动作把 speed 解析、做了范围检查、然后丢掉 | 地面站要求"温柔起飞"得到满推力，**且没有任何提示** | `action takeoff on platform drone has a fixed pose, so speed 0.1 cannot be honoured: remove it, or send the set points you want in targets` |
| 2 | 同一执行器两个设定点：`[{"actuator":0,"arg":10000},{"actuator":0,"arg":90000}]` ⇒ `arg:90000` 消失（`find()` 取第一个），**JSON 字段顺序**决定了无人机飞哪个推力 | 一条自相矛盾的指令被静默地二选一 | `actuator 0 (thruster_1) is named twice in one intent: two set points for one actuator leave the layer choosing which of them to drop` |
| 3 | `{"action":"goto"}` 被接受，飞出默认 58% 推力位姿 —— 一个顶着"去某处"名字的**默认动作** | 工具少填一个字段 ⇒ 机器动起来 | `action goto … needs at least 1 of its parameters (north_mm, east_mm, altitude_mm), and this intent names none of them — a target is not a default` |

**一条"说得出做不到"的措辞（补全代码，不只是补文档）**：文档写着"剖面的看门狗周期是策略，产品按自己的
安全论证定值"，但 `Platform` 的字段是私有的、六个剖面是 `const` —— 产品**只能改这个 crate 的文件**。
⇒ 新增 `Platform::from_parts(kind, actuators, actions, envelope, arm_on_motion)` + `Platform::validate()`：
部署自己写的机器（6 轴 ±120° 机械臂、八旋翼、不同制动执行器）现在**是一份数据**，且被**内置剖面同一条规则**
逐条校验（18 条规则：序号连续且在帧参数空间内、名字唯一、恰好一个 `Arm` 与一个 `Halt`、位姿长度与行程、
非运动动作的位姿必须惰性、参数名唯一且区间有序、`min_params` 可满足、包线可排程）。
这条规则同时被集成测试跑在六个内置剖面上 —— **一条规则，两个调用方**，手写剖面不可能带着自相矛盾的词表上线。

**实测（本轮的负数控制 5/5，每次都逐字节还原，`cmp` 证明）**：

| # | 在生产代码里改坏什么 | 失败的用例（实测） |
|---|---|---|
| 1 | `if raw.speed.is_some() && !spec.speed_scaled` → `if false && …`（= 恢复"悄悄丢掉"） | `a_speed_that_cannot_be_honoured_is_refused_not_dropped`：`platform_cases.rs:921` 拒绝没有发生 |
| 2 | 重复设定点检查 → `if false && …` | `two_set_points_for_one_actuator_are_refused_rather_than_first_wins`：`platform_cases.rs:983` |
| 3 | `if params.len() < spec.min_params` → `if false && …` | `an_action_that_is_its_target_is_refused_without_one`：`platform_cases.rs:1018` |
| 4 | `Platform::from_parts` 里的 `platform.validate()?` 注释掉 | `a_misdeclared_profile_is_refused_naming_the_rule_it_broke`：`platform_cases.rs:1106`（坏剖面被**收下**了） |
| 5 | `validate()` 里"恰好一个 `Arm`"的检查 → `if false && …` | 同上（`needs exactly one arm action` 不再出现） |

**同时更新的两个域案例**（它们曾在**自己的** JSON 里演示这个缺陷）：`uav_mission` 的 `takeoff` 与 `rtl`
不再带 `speed`（那台机器的推力是它的位姿，不是位姿的倍数）。

**诚实边界（本轮新增）**：**剖面的解析比参考机更严**（重复设定点/未知参数在剖面路径被拒，而
`Vocabulary::Reference` 逐字节冻结，仍按第一个设定点走）；`duration_ms` 携带但不参与规划（与参考机一致）；
一个 `Motion` 的 `targets` 仍可只覆盖部分执行器（参考机语义，`trot` 的单关节覆盖必须逐字节不变）；
`PlatformKind` 仍是闭集（机器是数据，**新域**是代码）。全部登记在 `docs/robot-domains.md` §5–§6。



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
| **Key expression 语法（`*` / `**`）** | ✅ 用（同构复用） | `keyexpr.rs` 自己实现并校验同一套语法，**原样交给 Zenoh**：进程内 broker 与跨网 Zenoh 对同一模式给出同一行为。**长度也实测钉住**（REQ-A247）：本 crate 允许的最长键（32 段 / ~2 KiB，`MAX_SEGMENT = 64` × `MAX_SEGMENTS = 32`）与同形模式都能跨真会话往返（`the_longest_key_expression_we_accept_crosses_a_real_session`）——此前只核对了**语法**，长度是没验证的（Zenoh 0.x 把键表达式限制在 255 字节，而那会让一个本地合法的键**在线上**失败）；实测 Zenoh 1.10.1 无此上限，且该用例会在未来引入上限时变红 |
| **`Session::put`（发布）** | ✅ 用 | `Transport::publish`：一次 `put`，无长生命周期 publisher（控制话题 1 Hz，不值得为它维持句柄） |
| **`declare_subscriber` + Handler** | ✅ 用（**QoS 映射的真实落点**） | `Reliability::BestEffort → RingChannel`（满则丢，与「最新帧胜」一致）、`Reliability::Reliable → FifoChannel`（满则阻塞 Zenoh 线程 = 背压） |
| **计数器（`published`/`delivered`/`dropped`/`blocked`）** | ✅ 用（**第十五轮补上**） | 传输持有**节点的那一组**（`Transport::metrics`）：`put` 成功 ⇒ `published+1`/`delivered+1`；转发任务把帧交给订阅队列 ⇒ `delivered+1`，订阅者已走 ⇒ `dropped+1`。**此前一个都不数**（`record_*` 只在 `broker.rs`），于是真网络上的节点终生报 0（§3.16）。**边界**：Zenoh 内部的丢弃（`RingChannel` 满、UDP 线缆丢包）在这一侧不可见 ⇒ `dropped` 是下界；`blocked` 天然为 0（`put` 不阻塞我们的发布者） |
| **组播 scouting（无 IP 列表发现）** | ✅ 用（默认开启） | 跨节点发现的本体；`AMOS_LINK_ZENOH_ENDPOINT` 可显式指定 `tcp/host:port` 列表用于锁定网络 |
| **总线联邦（信标走链路自身）** | ✅ 用（本仓新增） | `BusDiscovery`/`spawn_federation`：在 `amos/*/telemetry/beacon` 上收发 `Beacon`，与数据同路 ⇒ **Zenoh 场景下对端表终于被填满**（此前只有会话、没有 peer 表）；自身回声被过滤并计数 |
| **`ZBytes` 零拷贝载荷 / shared-memory** | ❌ 未用 | 我们走 `to_vec()`：`Envelope` 已经是一段自校验字节，SHM 需要两侧同机同版本约定，收益不抵复杂度（列入 §6 的后续项） |
| **query/reply、liveliness、admin space** | ❌ 未用 | 数据面只需要 pub/sub；节点存活由**我们自己的心跳 + TTL 注册表**表达（与 `amos-timesync` 的时钟配合可测真实延迟） |
| **router（`zenohd`）、plugin、TLS/QUIC/WS、multilink、compression** | ❌ 未用 | 去中心化的 peer 模式不需要 router；跨公网/加密属于部署决定，不是内核默认（`--features zenoh` 不带这些依赖） |
| **zenoh-pico（MCU 版）** | ❌ 未用（**边界**） | 本仓是 Rust 主机/板卡端中间件，**不编译到 MCU**；RK3576 上跑的是本 crate 的 Linux 二进制。MCU 直连属于另一条产品线，需要 pico 的 C 端与 AmOS-Link 的 key/帧格式对齐（§6） |
| **`unstable` 特性 / 逐调用 `Reliability`** | ❌ 未用 | Zenoh 的 per-call 可靠性藏在 `unstable` 后；本 crate 的诚实做法：**链路可靠性**取传输默认（TCP/UDS 可靠、UDP 尽力而为），**我们保证的是本地消费队列的 QoS**（`depth` 直接映射到 Handler 容量）。这条边界写在 `zenoh.rs::network_reliability_note` 的文档里，而不是含糊过去。**第十七轮补完（§3.18）**：「消费队列」这一半现在**与进程内 broker 逐条同形** —— `DropOldest`+depth 1 ⇒ 单槽（最新帧赢、被覆盖的帧计入 `dropped`），其余 ⇒ 有界队列（best-effort 满即丢并计数、reliable 满即等）；此前 `DropPolicy` 在网络侧从不生效、订阅自己的 `dropped` 恒为 0 |

**测试现状（诚实 —— 本段于第十五轮更正，此前它把**已经不再 ignore** 的用例说成 `#[ignore]`，与本文件的 §3.6/§7 自相矛盾）**：
`lan` 与 `zenoh` 的用例都进入 `make test`（`cargo test -p amos-link --features lan --lib`、
`cargo test -p amos-link --features zenoh --lib`）。
- `lan`：在**回环地址**上收发真实 UDP 信标（`lan_multicast/…`）。
- `zenoh`：**真会话往返已经在跑** —— `a_typed_frame_crosses_a_real_session_over_tcp_loopback`、
  `the_longest_key_expression_we_accept_crosses_a_real_session`、`a_node_over_a_real_session_counts_what_it_publishes`
  三个用例都是**两个 peer + 显式端点 + 关 scouting，走 TCP 环回**，因此不依赖任何网络环境、**不再是 `#[ignore]`**（REQ-A243 收口；§3.6）。
- **仍然 `#[ignore]` 的只剩跨主机 scouting**（`scouting_finds_a_peer_on_a_real_network`：需要真实组播与第二台主机），
  `cargo test -p amos-link --features zenoh -- --ignored` 可在真机器上手动跑。**默认 CI 不会伪造这条证据。**

## 5. 控制面（`proto/robot_link.proto`，5 个 RPC）

| RPC | 作用 | 关键实现细节 |
|---|---|---|
| `GetStatus` | 身份/角色/版本/uptime/时钟是否已校准/计数器/对端表/**健康判定与原因**（§3.2） | 由 `LinkNode::status()` 直出，`clock_synced` 决定「延迟数字能不能当真」；`health` 在**没有证据**时是 `UNKNOWN`，绝不冒充健康 |
| `ListTopics` | 传输见过流量的话题清单 | 网络传输回答「不知道」（`Vec::new()`），不伪造空列表。清单与**它的完整性**一起返回（`TopicList.complete`，§3.8）：调用方不在那条传输上，「这些就是全部」与「这是这台节点恰好看到的」只能靠这个字段区分——CLI 远端因此也打印 `(inventory complete\|incomplete …)` |
| `Publish` | 由非 Rust 节点注入原始负载 | daemon 用自己的 peer id、独立序号与（已校准的）时钟封装成真正的 `Envelope`，因此**类型化订阅者照样能解** |
| `StreamHeartbeats` | 服务端流式心跳 | 直接把 `amos/*/telemetry/beat`（**每个** peer 的心跳，含自己）的订阅转发给 gRPC 客户端——传输的是链路上**真的收到过**的帧，不是合成计数器；「到底谁在线」由 `GetStatus` 的对端表回答。**心跳按 `Subscriber::recv_beat` 读取**（§3.9）：载荷自称的 peer 必须等于帧头的 publisher，否则**拒绝并计入 `decode_errors`**，绝不送进客户端 —— 这条流**就是**「哪些机器人活着」的答案，一帧两个身份会把载荷的自称摆到每个操作员面前。**「含自己」是实装的**：`LinkService::with_heartbeat`（`mock_server()` 用的就是这个形状）会为挂载的节点起心跳任务，所以 daemon 自己也真的在 `amos/amos-daemon/telemetry/beat` 上打拍——否则这条流**一帧都发不出来**，而「没有证据」与「链路健康但安静」在流上长得一模一样（证据：`crates/amos-ai/tests/link_rpc_e2e.rs::the_daemon_link_node_beats…`） |
| `ListActuations` | **回程**：每个机器人自报的 `armed`/`estopped`(+原因)/`gait`/最近一次拒绝 | 数据面在 `amos/<robot>/state/actuation`，控制面**订阅并折叠**它们（`LinkService::with_heartbeat` 起的 watcher），让**不在链路上**的调用方（System UI、CLI）也能读到。三个诚实点：**(a) 按帧头 `publisher` 归属**（谁发布谁是机器人），不信负载自称；**(b) 一张快照表，按 id 排序**，同一机器人后来的报告覆盖旧的；**(c) 没上报过的机器人是「不在列表里」，不是「空闲」**——`mock_server` 刚起来时它是空的，而空 ≠ 全员空闲 |

挂载点：`amos-ai/src/server.rs` 的 `serve()` 里 `.add_service(amos_link::service::mock_server())`，
与 AiAgent/Sensor/Telephony 同一条 UDS；证据是 `crates/amos-ai/tests/link_rpc_e2e.rs`（真 UDS 往返）。
`mock_server()` 挂的是**带心跳**的服务（`LinkService::with_heartbeat`）；`server(node)` 把「谁负责让节点打拍」留给调用方（跨板卡部署通常在 `spawn_heartbeat` 之外还要 `spawn_federation`）。

**每种事实的消费者与拼法**（第十轮定稿，§3.11）：`GetStatus` 的**对端表**由 CLI（`status --socket`，人类表 +
`peers[]` 数组）与 System UI（`LinkPeerOut`）共同消费，两边都是同一套扁平五字段（`id`/`kind`/`endpoint`/`last_seen_ms`/`beacons`）；
**判决**是 `health`（枚举）`+ health_reasons`（token），CLI 把它渲染成 `{"state":…,"reasons":[token,…]}` —— 与内核
`status --json` 逐字一致。也就是说：**控制面一直是这套词汇，生产者曾经不一致**（§3.11 的四个缺陷）。

**一个 RPC「不存在」时的消费者契约**（第十六轮，REQ-A271，§3.17）：控制面五个 RPC 是**同一条 UDS 上的一次会话**，
一次调用失败**不等于**整条链路不可用。约定如下（CLI 与 System UI 一字不差）：

| 情形 | 消费者怎么说 | 依据 |
|---|---|---|
| `GetStatus` 不可达（守护进程没起） | 「守护进程未连接」/ `exit 1` —— 什么都不显示 | 没有这条就什么都没有 |
| 某个 RPC 回 `Unimplemented`（**老构建**没有它，例如没有 `ListActuations` 的 daemon） | **降级**：那一栏读作「本 daemon 没有回答这个问题」（`null` / 一行说明），其余已答的照常显示，并 `warn!` 一条日志 | 「界面只是少显示一栏」（§6.5）——**这只对「没有这个 RPC」成立** |
| 某个 RPC **有这个实现却失败**（真故障） | **照实报错**，绝不折进「老版本」 | 「有 RPC 却服务不了」是故障，不是版本差异 |

回程因此有**三种状态**（`Option` 的三种含义）：`null` = 没有回答、`[]` = 回答了且没人上报过、`[…]` = 这些机器人上报过；
`null` 绝不能被渲染成 `[]`（「我们没被告知」不是关于机群的任何事实）。

## 6. 环境变量与边界（老实说）

| 变量 | 作用 | 读取处 |
|---|---|---|
| `AMOS_LINK_PEER` | 默认节点 id（`--peer` 优先） | `crates/amos-link-cli/src/lib.rs` |
| `AMOS_LINK_BEACON_ADDR` | LAN 信标目标（`ip:port`，默认 `239.255.42.99:7446`） | `crates/amos-link/src/lan.rs` |
| `AMOS_LINK_BEACON_IFACE` | LAN 信标**固定到哪个接口**（本机 IPv4 地址，如 `192.168.1.5`；出向 `IP_MULTICAST_IF` + 入向组加入都绑到它）。多网卡板子必须设，否则「内核挑一个」可能让信标从 5G 出去而相机板在 Wi-Fi 上；**错值在启动期拒绝** | `crates/amos-link/src/lan.rs` |
| `AMOS_LINK_BEACON_LOOP` | 组播回环开关（`1`/`0`，默认 = 平台默认即开）。关掉会让**本机所有进程**都收不到自己的信标（不只自己），因此**不是**正确性机制（对端表才是）| `crates/amos-link/src/lan.rs` |
| `AMOS_LINK_ZENOH_ENDPOINT` | Zenoh 连接点（逗号分隔，如 `tcp/10.0.0.7:7447`） | `crates/amos-link/src/zenoh.rs` |
| `AMOS_LINK_ENDPOINT` | **本节点广播的地址**（逗号分隔，如 `tcp/10.0.0.7:7447,udp/239.255.42.99:7446`；`--endpoint` 优先）。只有**会公告自己**的命令读它（`watch`、`discover --lan`/`--bus`）：`status` 之类读了也没有意义，否则一个部署变量就能让一条没有公告的命令失败。留空 = 不广播地址（**默认**，也是自发现传输唯一合理的取值）。界与信标同源（≤8 项、每项 ≤128 字节、整帧 ≤512 字节），**在启动期拒绝**（见 §3.14） | `crates/amos-link-cli/src/lib.rs` |

**明确不做的事**（避免把边界留给想象）：

1. **不是 ROS 兼容层**：没有 `.msg`/IDL 解析、没有 `rostopic` 兼容、没有 DDS 线路。要在 ROS 生态里
   出现，需要另写桥接（Zenoh 官方有 ros2dds 插件，属于部署组件，不进内核）。
2. **不是调度器**：`LinkNode` 不会替你起控制线程；`RobotBridge::step()` 是显式的一步，线程/频率由调用方
   （真实产品里是 50–100 Hz 的控制任务）决定。
3. **发现不认证**：`lan` 的信标是明文广播，任何人都能伪造（它只是「去连我」的提示）。**认证路径是
   daemon 的 UDS**（`amos-ai` 的 peer-credential 检查），不是这条信标。
   **（第十三轮更正）** 这句话此前**没有兑现的机制**：信标里的 `endpoints` 字段有边界、有校验、有渲染，
   却**没有任何生产者**，因此「去连我」这条提示**从不带地址**（`endpoint` 永远是 `null`）。现在它是**显式**的
   （`--endpoint` / `AMOS_LINK_ENDPOINT`，见 §3.14），并且填错在**启动期**被拒 —— 但「对端表里有地址」
   仍然只是一句**声明**：本条的不认证性质不变。
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
   而且列表是**快照不是历史**。
   **（第十六轮更正）** 上一句原先写着「老版本的 daemon 没有这个 RPC 时，界面只是少显示一栏、不报错」——
   **当时那是假的**：`link_status` 用 `?` 把 `ListActuations` 的失败抛了出去，于是同一个老 daemon 会让**整个页面**
   变成「守护进程未连接」，连它**已经答过**的状态、对端表与判定一起消失。现在这句话是**代码**（且只对
   一种失败成立）：只有 `Unimplemented`（老构建 / 没有这个 RPC）才降级为「这一栏没有被回答」并 `warn!`，
   **其它任何失败仍然照实报错**（有这个 RPC 却服务不了，那是真故障，不能被折进「老 daemon」）。
   三种状态各有名字：`actuations: null` = 守护进程**没有回答这个问题**、`[]` = 回答了且没人上报过、
   `[…]` = 这些机器人上报过；界面文案与 CLI（`status --socket`，人类行 + JSON）说同一种话（REQ-A271）。
   **诚实边界**：面板读的是守护进程**控制面**的状态；数据面（传感器帧、关节设定点）不经过它，
   也不经过任何 gRPC —— 回程能被看到，是因为**守护进程订阅了数据面并把它折叠进控制面**，而不是因为 UI 自己上了链路。
   **同步改口的地方**：`amos-link/src/service.rs` 的模块文档、`amos-link-cli` 的 `run_watch` 文档、
   `link_rpc_e2e.rs` 的用例注释（它们原先都写着「没有 GUI 消费者」）。
6. **链路面板的读数是「一次读取」——已处置（第二轮，REQ-A246）**。曾经的缺口：面板只在挂载时读一次，
   `peers[].last_seen_ms` 是**那次读取当时**的年龄，页面上**没有「读数时间」**，因此一个开着不动的页面会把
   「三分钟前的 300 ms」一直显示成 300 ms —— 数字确实来自守护进程（没有撒谎），但**陈旧的读数与新鲜读数
   无法区分**。现在的处置与其余设置页同形（`settings.aiProbe`/`aboutProbe` 的纪律）：
   **(a) 读数带时间**——每次成功读取记下时刻，页面打印 `link.probe`（「最近读数：HH:MM:SS（每 10 秒重读）」），
   并且**失败的读取没有可标注的读数**（时间戳随数字一起清空，而不是留一个看起来新鲜的旧时刻）；
   **(b) 打开期间按周期重读**——每 10 秒（`LINK_PROBE_MS`；`document.visibilityState === "visible"` 才读，页面销毁时清掉定时器），
   所以「陈旧」本身被消灭，而不只是被标注（**注意**：文案里写明了「每 10 秒重读」，与常量必须一起改——与
   `settings.aiProbe`/`aboutProbe` 同一条惯例，改周期时记得改两处 locale）；**(c) 重读拿不到答案就丢数字**——判据是 `linkLevel(null) === "offline"`，
   上一轮的计数与对端表**不会**留在屏幕上冒充活的链路（与 AboutPage 的「失败的探测回到诚实的 '—'」同一条规则）；
   **(d) 顺带补全**：对端行现在显示信标带来的**传输端点**（`peer.endpoint`；`null` 就什么都不显示，
   不伪造地址、也不渲染 `"null"`）——这个字段由桥接映射、`link.rs` 的文档专门交代过，此前 UI 取了不用。
   **实测**（`bunx vitest run svelte-tests/link-page.svelte.test.ts`，9 例）：假定时器推进 10 秒 ⇒ `link_status`
   被再调一次且**新的计数**上屏；守护进程中途失联 ⇒ verdict 变「守护进程未连接」、计数与对端表**消失**、
   `link-read-at` 也消失（没有读数就没有读数时间）；端点渲染与 `null` 不渲染；`link.probe` 匹配
   `最近读数：\d\d:\d\d:\d\d（每 10 秒重读）`。
   **负控 4/4**（每次注入后 `cmp` 还原逐字节一致）：去掉定时器 ⇒ 「打开期间重读」「失联就丢数字」两条 FAILED；
   去掉端点渲染 ⇒ 对端断言 FAILED；时间戳写成常量 ⇒ 读数时间断言 FAILED；失败时保留旧读数 ⇒
   「失联就丢数字」FAILED。

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
# 线缆形态的再校验（§3.8）：手工写字节的头（正确 CRC）在 decode 与 encode 两侧都被拒，
# 真 broker 上的伪造帧被跳过并计入 decode_errors；清单的完整性随 JSON 与控制面一起走。
cargo test -p amos-link --lib codec::tests::a_header_off_the_wire_is_re_validated_field_by_field
cargo test -p amos-link --lib discovery::tests::a_beacon_off_the_wire_is_re_validated_too
cargo test -p amos-link --lib pubsub::tests::a_frame_off_the_wire_is_re_validated_before_it_is_believed
cargo test -p amos-link --lib node::tests::the_inventorys_own_limit_travels_with_the_inventory
# 心跳（第八轮，§3.9）：线缆上的 beat 必须与帧头的归属一致（第三个带身份的线缆类型），
# 且判决不得比仪器更干净（满表后的 untracked_frames）。
cargo test -p amos-link --lib telemetry::tests::a_beat_off_the_wire_is_re_validated_and_must_name_its_publisher
cargo test -p amos-link --lib pubsub::tests::a_beat_that_names_another_peer_is_refused_and_counted
cargo test -p amos-link --test service_uds     # StreamHeartbeats 不转发一帧两个身份的 beat
cargo test -p amos-link --lib health::tests::a_partial_loss_figure_is_never_called_healthy
cargo test -p amos-link --test service_uds                 # ListTopics ⇒ topics **且** complete
cargo test -p amos-link-cli --test cli_smoke               # 远端 topics 打印 (inventory complete|incomplete)
# 参数面（第九轮，§3.10）：`--json` 处处兑现 + 不能用的旗标 exit 2
cargo test -p amos-link-cli --lib no_flag_is_silently_ignored_on_any_command
cargo test -p amos-link-cli --lib a_count_of_zero_is_refused_instead_of_doing_nothing
cargo test -p amos-link-cli --test cli_smoke json_is_honored_by_every_command_that_prints
cargo test -p amos-link-cli --test cli_smoke a_flag_the_command_cannot_use_is_a_usage_error_not_a_silent_no_op
# 一份文档 / 一种词汇（第十轮，§3.11）：远端 status 与本地同形，对端表只有一种拼法，判决只有一种词
cargo test -p amos-link --lib health::tests::the_verdict_json_is_the_control_planes_vocabulary
cargo test -p amos-link --lib discovery::tests::a_peer_view_serializes_as_the_flat_peer_the_control_plane_carries
cargo test -p amos-link --lib telemetry::tests::the_status_document_speaks_the_control_planes_peer_and_verdict_shapes
cargo test -p amos-link-cli --lib the_remote_status_document_is_the_local_document_plus_who_answered
cargo test -p amos-link-cli --test cli_smoke status_json_is_one_document_locally_and_over_a_socket
cargo test -p amos-link-cli --test cli_smoke the_running_nodes_peer_table_crosses_the_socket
cargo test -p amos-tauri --lib link::tests::a_peer_serializes_to_the_same_five_fields_the_cli_prints
cargo run -p amos-link-cli -- status --peer dog1 | jq '.health.state, .peers, .metrics'   # 判决是对象、对端是数组
cargo run -p amos-link-cli -- status --socket /tmp/amos-ai.sock | sed -n '1,12p'          # 人类形态含对端表与清单行
cargo run -p amos-link-cli -- discover --static dog1 --json | jq '.peers[0]'              # id/kind/endpoint/last_seen_ms/beacons
# 报告也要有日期（第十一轮，§3.12）：回程的年龄，人类形态 `age=` 与机器形态 `age_ms`
cargo test -p amos-link-cli --lib a_report_is_dated_and_an_unusable_stamp_says_so
cargo test -p amos-link-cli --lib the_machine_form_carries_the_age_as_a_number_or_null
cargo test -p amos-link-cli --lib the_age_format_is_shared_with_the_panel
cargo test -p amos-link-cli --test cli_smoke the_return_path_is_dated_when_it_crosses_the_socket
cd crates/amos-tauri/frontend-ts && bun test src/__tests__/link.test.ts      # actuationAgeMs / reportAgeKey / reportAgeText
cd crates/amos-tauri/frontend-ts && bunx vitest run svelte-tests/link-page.svelte.test.ts  # 每行的「… 前上报」
cargo run -p amos-link-cli -- status --socket /tmp/amos-ai.sock | grep 'robot='   # 行尾 age=…（报告自己的日期）
# 序号属于「流」（第十二轮，§3.13）：一个对端多条流不再虚报 stale，快流不再吃掉慢流的真丢帧
cargo test -p amos-link --lib sequence::tests::one_peers_two_topics_are_two_streams_not_one_restarting
cargo test -p amos-link --lib sequence::tests::a_fast_stream_does_not_hide_a_slow_streams_real_gap
cargo test -p amos-link --test link_e2e a_best_effort_lag_is_visible_as_a_sequence_gap   # 真 broker：一条流的 gap
cargo test -p amos-link-cli --lib the_loss_figures_name_the_stream_that_lost_frames
# 信标的端点 + 流式 --json（第十三轮，§3.14）：地址能填、填错在启动期被拒、真的上线；每行都是事件
cargo test -p amos-link --lib discovery::tests::an_advertisement_is_parsed_and_bounded_before_a_beacon_is_built
cargo test -p amos-link --lib discovery::tests::a_federating_node_announces_the_endpoints_it_was_given   # 真 broker：对端表里有地址
cargo test -p amos-link --lib discovery::tests::an_unemittable_advertisement_is_refused_before_the_task_starts
cargo test -p amos-link-cli --lib the_cli_announces_the_endpoint_the_operator_gave   # 节点真的广播了操作员输入的地址
cargo test -p amos-link-cli --lib the_advertisement_is_bounded_where_the_operator_can_fix_it
cargo test -p amos-link-cli --test cli_smoke an_advertised_endpoint_is_what_the_node_announces_or_a_usage_error
cargo test -p amos-link-cli --test cli_smoke the_streaming_commands_are_json_line_by_line_when_asked
cargo test -p amos-link-cli --features lan --test cli_smoke a_lan_sweep_announces_the_endpoints_it_was_given
# 一个事实一种回答（第十四轮，§3.15）：帧的年龄不再被折成 0，bench 不把「不可测」记成 0 µs
cargo test -p amos-link-cli --lib a_frame_stamped_in_the_future_has_no_age_to_print   # 两个真实时钟的 e2e
cargo test -p amos-link-cli --lib a_measurable_age_is_still_a_number_and_the_epoch_is_not_absent
cargo test -p amos-link-cli --lib a_benchmark_never_counts_an_unmeasurable_frame_as_zero_latency
cargo test -p amos-link-cli --lib the_benchmark_histogram_keeps_its_microsecond_resolution
cargo test -p amos-link-cli --test cli_smoke the_age_caveat_and_the_bench_sample_count_are_wired
cargo test -p amos-link --lib codec::tests::timestamps_validate_and_measure_age   # `since` 的饱和是**设计**（对 duration）
cargo run -p amos-link-cli -- bench --count 20             # 末行 latency 带 (n=20)，异常时带 "N frame(s) excluded"
cargo run -p amos-link-cli -- sub --count 1 --timeout-ms 50  # 头部带 clock_synced=false: ages are bounds, not measurements
cargo run -p amos-link-cli -- bench --count 20 --json | jq '.latency_us.samples, .skewed, .received'
cargo run -p amos-link-cli -- watch --kind robot --endpoint tcp/10.0.0.7:7447 --seconds 2   # advertising=tcp/…
cargo run -p amos-link-cli -- watch --endpoint tcp/10.0.0.7:7447 --seconds 2 --json | jq -c '.event'  # 每行一个事件
cargo run -p amos-link-cli -- discover --endpoint tcp/x:1                    # exit 2：离线 sweep 不公告
cargo run -p amos-link-cli -- status --endpoint tcp/x:1                      # exit 2：belongs to `discover` and `watch`
cargo run -p amos-link-cli -- sub --pattern 'amos/**' --count 5 --timeout-ms 2000   # 有丢帧时逐流打印 lost peer=… topic=…
cargo run -p amos-link-cli -- topics --json                 # 一份文档：{"complete":…,"topics":[…]}（可 jq）
cargo run -p amos-link-cli -- motor --action '{"action":"arm"}' --json   # frames[] + applied + device:null
cargo run -p amos-link-cli -- bench --count 3 --pattern 'amos/**'        # exit 2：belongs to `sub` and `state`
cargo run -p amos-link-cli -- pub --topic amos/x --text hi --count 0     # exit 2：--count 0 空跑被拒
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
# 一个 RPC「不存在」时的消费者契约（第十六轮，§3.17）：老 daemon 只让那一栏缺席，不拖垮整次读取
cargo test -p amos-tauri --test link_status_e2e a_daemon_without_the_return_path_still_answers_the_panel
cargo test -p amos-link-cli --test cli_smoke an_older_daemon_still_answers_the_status_over_a_socket
cd crates/amos-tauri/frontend-ts && bunx vitest run svelte-tests/link-page.svelte.test.ts   # 三态（unavailable/none/reported）
cargo run -p amos-link-cli -- status --socket /tmp/old-daemon.sock | tail -3    # 「not answered by this daemon」
# 速率与带宽（第十八/十九轮，§3.19/§3.20）：每条流一行 `frames`/`span`/`rate`/`bytes`/`bw`，
# 说不出的数字给原因而不给 0
cargo run -p amos-link-cli -- hz --pattern 'amos/**' --seconds 10
cargo run -p amos-link-cli -- hz --pattern 'amos/*/sensor/**' --seconds 10 --json   # 每条流：rate + bytes/bw
cargo test -p amos-link --lib rate::          # 11 例：注入时刻 ⇒ 速率与带宽都是算术（single-frame / span-too-short / 饱和）
cargo test -p amos-link --lib the_header_only_reader   # 只读信封：负载是借用，拒绝理由与 decode 逐字相同
# 真会话上的速率与带宽（第十九轮 §3.20 的证据）：发布方 `pub --count 20 --hz 10`，另一进程
cargo run -p amos-link-cli --features zenoh -- hz --transport zenoh --pattern 'amos/**' --seconds 9
# 同一份 QoS 必须在两个传输上意味着同一件事（第十七轮，§3.18）：
# 真 TCP 环回会话上，Qos::sensor() 连发 5 帧后只 recv 一次 ⇒ 拿到**第 5 帧**且 dropped=4
cargo test -p amos-link --features zenoh --lib a_latest_only_subscription_over_a_real_session_keeps_the_newest_frame
# best-effort depth 2：满即丢、不背压、dropped 如实计数
cargo test -p amos-link --features zenoh --lib a_best_effort_queue_over_a_real_session_drops_the_newest_and_counts_it
cargo test -p amos-link --features zenoh --lib a_node_over_a_real_session_counts_what_it_publishes
# 计数器在真网络上也是真的（第十五轮，§3.16）：两个真实会话，帧过去、数字跟着动
cargo test -p amos-link --features zenoh --lib a_node_over_a_real_session_counts_what_it_publishes
cargo test -p amos-link --features zenoh --lib a_typed_frame_crosses_a_real_session_over_tcp_loopback
# 联邦信标节奏 = TTL/3（`federation_period()`，一处规则；默认 TTL 3s ⇒ 每秒 1 个信标）。
# 此前 `discover --bus` 与 `watch` 硬编码 200ms（5 个/秒），既多打 4 倍信标，又让
# `published` 看起来像有真实流量 —— 现在三条路径（lan/bus/watch）同一条规则。
# System UI 的链路面板（只读）：设置 →「机器人链路」，读运行中的 daemon。
cd crates/amos-tauri/frontend-ts && bunx vitest run svelte-tests/link-page.svelte.test.ts
# 应用案例（第二十轮，§3.21 + docs/robot-apps.md）：① 巡检闭环 ② 机群监督台 ③ 不在链路上的大脑
cargo run -p amos-link --example patrol_mission     # 施加 → 回程 → 看门狗切扭矩 → 拒绝 → 重新 arm
cargo run -p amos-link --example fleet_console      # 一张表印两次：哪条流在动、哪条停了
cargo run -p amos-link --example remote_brain       # 真 UDS + 真 tonic：注入是真帧、回程能读回
cargo test -p amos-link --test robot_cases          # 10 例：断言性质（不是打印）；含契约表对码
cargo test -p amos-link --test robot_cases -- --nocapture   # 需要看时序时用；断言与上面同一条
# 平台剖面与领域案例（第二十一/二十二轮，§3.22/§3.23 + docs/robot-domains.md）：
# 六份剖面（四足/机械臂/无人机/车辆/无人艇/工业单元）、共用的帧与安全核心、每个限都有牙齿
cargo test -p amos-link --test platform_cases      # 18 例：参考机逐字节不变 + 六剖面自检 + 包线拒绝 + 解锁语义 + 接受边界 + 自定义剖面校验
cargo run -p amos-link --example uav_mission       # 未解锁拒绝 → 起飞 → 围栏内/外 → 看门狗 → 任务层飞 RTL
cargo run -p amos-link --example road_autonomy     # 设定点流 → 越界拒绝 → 收油 → 看门狗 → MRM（全力制动）
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
## 8. 与 ROS 2 的功能对照（逐项，2026-09-15 复核，REQ-A272）

**为什么要有这一节**：README 把 AmOS-Link 叫作「ROS-class pub/sub」，`qos.rs` 说「DDS 叫 QoS，ROS 2 叫
reliability + history depth」，而本节的用途是**把这些类比逐条落到代码和证据上** —— 哪一条是真的（有消费者、
有用例）、哪一条只是名字像、哪一条我们**故意**不做。**类比不是兼容**：本 crate 没有 `.msg`/IDL、没有 DDS 线路、
没有 `rostopic` 兼容（§6.1）；下表每一行都写明「对应物」与「差异」，最后三行是**类比的断裂处**。

| ROS 2 能力 | AmOS-Link 的对应物 | 状态 | 证据 / 差异（诚实说） |
|---|---|---|---|
| **Topic + pub/sub** | `Topic`（`amos/<peer>/<channel>/<name>`，`*`/`**`）+ `Publisher<T>`/`Subscriber<T>` | ✅ 等价 | `keyexpr.rs`（迭代匹配、长度上限）、`broker.rs`、`node.rs`；**差异**：一层命名空间（peer 段）是**强制的**，没有「无名根话题」 |
| **QoS：reliability** | `Reliability{BestEffort, Reliable}` | ⚠️ **名字同、语义不同** | ROS 2 的 RELIABLE = 传输层重传；本 crate 的 `Reliable` = **本地消费队列背压**（网络链路可靠性取传输默认）。§4 的 Zenoh 行与 `network_reliability_note` 都写着这条 |
| **QoS：history depth（KEEP_LAST n）** | `depth` + `DropPolicy{Newest, Oldest}`，`Qos::sensor()/state()/control()` | ✅ 语义对齐（第十七轮收紧） | `KEEP_LAST(1)` ≡ `DropOldest` + depth 1 ≡ `Qos::sensor()`：**两个传输上都**「醒来拿到最新的那一帧」（§3.18 修的就是网络侧曾拿到最老那帧） |
| **QoS：KEEP_ALL** | ❌ 无 | ❌ 故意不做 | 唯一的「全留」形状是 `Reliable` 的无损背压；无限历史的替代品不存在，`MAX_DEPTH=4096` 直接拒绝（一个更大的队列是泄漏，不是缓冲） |
| **QoS：durability（VOLATILE / TRANSIENT_LOCAL）** | ❌ 只有 VOLATILE 语义 | ❌ 故意不做 | 没有「晚加入者收到最后一帧」的机制；**对端表 + 心跳 TTL** 是「谁在」的回答，不是历史。要 late-joiner 语义，只能让发布者周期重发（心跳/状态类话题本来就是周期性的） |
| **QoS：deadline / lifespan / liveliness** | 心跳 + `PeerRegistry` TTL + `LinkHealth` | ⚠️ 用别的机制实现 | §4 的 Zenoh 行已写「节点存活由我们自己的心跳 + TTL 表表达」；**差异**：判据是**代际年龄与序号缺口**（`SeqTracker`），不是 per-topic 的 deadline 契约 |
| **Service（request/reply）** | gRPC 控制面 `GetStatus`/`ListTopics`/`Publish`/`StreamHeartbeats`/`ListActuations` | ⚠️ 控制面有，数据面没有 | §5；**差异**：那些 RPC 是**运维工具**（读状态、注入帧、读回程），没有「服务名 + 客户端关联 id」这套数据面语义 |
| **Action（长任务 + 反馈 + 取消）** | ❌ 无 | ❌ 故意不做 | 运动/长任务的编排在 `amos-robot`/`amos-ai` 层（gRPC 命令 + 状态回程），不在链路上 |
| **Parameter（node 参数）** | ❌ 无 | ❌ 故意不做 | 配置来自环境变量（§6）与各 crate 自身；链路不承载参数分发 |
| **`.msg` / IDL / 接口自描述** | `serde` 类型 + `bincode` 帧（`magic │ ver │ hdr │ crc32 │ payload`） | ⚠️ 类型契约只在进程内、线缆不自描述 | 帧头**不带类型名**：订阅方必须先知道类型（`Subscriber::<T>`）。这是设计选择（体积/零拷贝），代价是「通用 echo 任意类型」做不到 —— CLI 的 `sub` 只能解它认识的消息（§6.1） |
| **Discovery（DDS simple discovery）** | 两种信标：链路自身传输上的 beacon + `lan` feature 的 UDP 组播；`PeerRegistry` 带 TTL | ✅ 等价（范围更小） | `discovery.rs`/`lan.rs`；**差异**：不是 DDS 的分布式发现协议，**且明确不是认证**（§6.2） |
| **Time / sim time（`/clock`）** | `amos-timesync` 的 `Clock`（`host()` / 已校准），`clock_synced` 一路带到判决与界面 | ✅ 有对应物 | §3.15：未校准时所有延迟是**上界**；**差异**：没有 `use_sim_time` 那种「仿真时钟注入」开关 |
| **TF / 坐标变换树** | ❌ 无 | ❌ 故意不做 | 坐标与里程计在 `amos-robot` 的 HAL/状态里；链路只搬字节 |
| **rosbag（录制/回放）** | ❌ 无 | ❌ 故意不做 | `bench`/`watch`/`sub --json` 是可**管道**的观测（`> file.jsonl` 就是录制），但没有 bag 格式、没有按时间回放 |
| **SROS2（认证/加密）** | ❌ 无 | ❌ 故意不做 | §6.2：发现不是认证；UDS 侧靠文件权限，网络侧靠传输配置。**不要**把链路当作安全边界 |
| **Lifecycle node（configure/activate/…）** | ❌ 无 | ❌ 故意不做 | 组件的启动/停止是 systemd / `amos-kernel` 的事 |
| **Executor / callback group** | ❌ 无（**由调用方拥有线程**） | ❌ 故意不做 | README：「not a scheduler (you own the control thread and its rate)」；`try_recv` 是给控制回路用的非阻塞读取 |
| **`ros2 topic echo` / `hz` / `bw`** | `sub` / `hz`（速率**与**带宽） / `watch` / `bench` | ✅ 覆盖（形状不同） | `watch` 打**心跳**（含 `missed`）、`bench` 打**延迟直方图 + 吞吐**、`sub` 打**每一帧 + 序号缺口与丢帧计数**、`hz` 打**每条流的到达速率与带宽**（§3.19 补速率、§3.20 把 `bw` 并入同一读数：`frames/span/rate/bytes/bw` 出自一个窗口）。**差异**：`hz` 的带宽是**该进程这条链路上收到的**（不是发布方的发送量），且计的是整帧的账（含头与 CRC）；`bench` 的吞吐仍是它自己造的那条流 |
| **`ros2 topic info`（类型 + 订阅者数）** | `status`（对端表、计数器、判决）+ `topics`（清单及其**完整性**） | ⚠️ 部分 | **差异**：没有「谁订阅了它」的远端视图（broker 知道本地 fan-out 数，网络传输**诚实地说不知道**），也没有类型名 |
| **`ros2 node list` / `info`** | `status` / `discover`（对端表：id/kind/version/uptime/地址/beacon 数） | ✅ 形状相近 | §5 与 §3.11：对端表是**本节点**看到的，不是全网权威视图 |
| **`ros2 param` / `service` / `action` CLI** | ❌ 无（没有这些数据面概念） | ❌ 由上表三行决定 | — |
| **`ros2 doctor`** | `status --json` 的 `health` + `health_reasons`（每个 token 可行动） | ⚠️ 更窄但更具体 | §3.9/§3.12：判决**不是**「OK」，而是枚举 + 原因 token；未校准时钟、序号缺口、清单不完整都会进 reasons |
| **多语言客户端（rclcpp/rclpy/…）** | ❌ 只有 Rust + 5 个 gRPC RPC | ❌ 故意不做 | 非 Rust 节点通过**控制面**参与（§5 的 `Publish` 就是给它们的）；完整 API 需要各自实现帧格式，不在本仓目标内 |
| **DDS 线路 / RTPS 互操作** | ❌ 无（Zenoh 作为网络底座，**不是** DDS） | ❌ 故意不做 | §6.1 与 §4：进 ROS 生态需要另写桥接（Zenoh 有 ros2dds 插件，属部署组件） |
| **安全（认证的对端身份）** | ❌ 无 | ❌ 故意不做 | §6.2：`PeerId` 是**一致性**标记，不是身份。§3.9 的「一帧一个身份」也只是**拒绝自相矛盾**，不是认证 |

**三条断裂处（类比的边界，必须记住）**：

1. **可靠性是两层的**：ROS 2 的 QoS 由中间件在**每个传输**上兑现；本 crate 的 `Reliability` 只管**本地消费队列**，
   线缆可靠性交给传输（TCP/UDS 可靠、UDP 尽力而为）。所以「`Reliable` ⇒ 一定不丢」在网络上是**两段承诺的合取**，
   而我们只能证明本地那一段（§4 的界限）。第十七轮把**深度与丢弃策略**这一半在两个传输上对齐了（§3.18）。
2. **类型契约不在线缆上**：帧头不带类型名/类型哈希。跨语言、跨版本消费者必须先约定类型 —— 这正是「不是 ROS 兼容层」
   的具体含义之一。
3. **「谁在」不等于「谁健康」**：对端表回答前者（TTL + 信标），`health` + 心跳序号缺口回答后者；
   ROS 2 里 liveliness/deadline 是 per-topic 契约，这里是**节点级**的判断。


