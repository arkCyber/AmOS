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
| `service` | tonic 控制面（`proto/robot_link.proto`：GetStatus / ListTopics / Publish / StreamHeartbeats），已挂进 `amos-ai::server::serve()` 的共享 UDS | 控制面≠数据面：RPC 只做管理，字节流永不经过它 |

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

## 5. 控制面（`proto/robot_link.proto`，4 个 RPC）

| RPC | 作用 | 关键实现细节 |
|---|---|---|
| `GetStatus` | 身份/角色/版本/uptime/时钟是否已校准/计数器/对端表/**健康判定与原因**（§3.2） | 由 `LinkNode::status()` 直出，`clock_synced` 决定「延迟数字能不能当真」；`health` 在**没有证据**时是 `UNKNOWN`，绝不冒充健康 |
| `ListTopics` | 传输见过流量的话题清单 | 网络传输回答「不知道」（`Vec::new()`），不伪造空列表 |
| `Publish` | 由非 Rust 节点注入原始负载 | daemon 用自己的 peer id、独立序号与（已校准的）时钟封装成真正的 `Envelope`，因此**类型化订阅者照样能解** |
| `StreamHeartbeats` | 服务端流式心跳 | 直接把 `amos/*/telemetry/beat`（**每个** peer 的心跳，含自己）的订阅转发给 gRPC 客户端——传输的是链路上**真的收到过**的帧，不是合成计数器；「到底谁在线」由 `GetStatus` 的对端表回答。**「含自己」是实装的**：`LinkService::with_heartbeat`（`mock_server()` 用的就是这个形状）会为挂载的节点起心跳任务，所以 daemon 自己也真的在 `amos/amos-daemon/telemetry/beat` 上打拍——否则这条流**一帧都发不出来**，而「没有证据」与「链路健康但安静」在流上长得一模一样（证据：`crates/amos-ai/tests/link_rpc_e2e.rs::the_daemon_link_node_beats…`） |

挂载点：`amos-ai/src/server.rs` 的 `serve()` 里 `.add_service(amos_link::service::mock_server())`，
与 AiAgent/Sensor/Telephony 同一条 UDS；证据是 `crates/amos-ai/tests/link_rpc_e2e.rs`（真 UDS 往返）。
`mock_server()` 挂的是**带心跳**的服务（`LinkService::with_heartbeat`）；`server(node)` 把「谁负责让节点打拍」留给调用方（跨板卡部署通常在 `spawn_heartbeat` 之外还要 `spawn_federation`）。

## 6. 环境变量与边界（老实说）

| 变量 | 作用 | 读取处 |
|---|---|---|
| `AMOS_LINK_PEER` | 默认节点 id（`--peer` 优先） | `crates/amos-link-cli/src/lib.rs` |
| `AMOS_LINK_BEACON_ADDR` | LAN 信标目标（`ip:port`，默认 `239.255.42.99:7446`） | `crates/amos-link/src/lan.rs` |
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
   **诚实边界**：面板读的是守护进程**控制面**的状态；数据面（传感器帧、关节设定点）不经过它，
   也不经过任何 gRPC。**同步改口的地方**：`amos-link/src/service.rs` 的模块文档、
   `amos-link-cli` 的 `run_watch` 文档、`link_rpc_e2e.rs` 的用例注释（它们原先都写着"没有 GUI 消费者"）。

## 7. 验证入口

```bash
make test                     # 含 amos-link 的 lan/zenoh 特性用例、link_e2e / service_uds / cli_smoke
make lint                     # 含 -p amos-link --features lan|zenoh 的 clippy -D warnings
cargo test -p amos-link       # 内核 + 端到端用例（默认构建）
cargo run -p amos-link-cli -- bench --count 2000 --size 4096
cargo run -p amos-link-cli -- status   # JSON：含 health 判定与 health_reasons（§3.2）
cargo run -p amos-link-cli -- motor --action '{"action":"trot","speed":0.5}'
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
cargo run -p amos-link-cli -- status --socket /tmp/amos-ai.sock --json   # 真实 daemon 的身份/计数器/健康
cargo run -p amos-link-cli -- topics --socket /tmp/amos-ai.sock          # daemon 自己那条传输见过的话题
cargo run -p amos-link-cli -- pub --socket /tmp/amos-ai.sock \
    --topic amos/dog1/control/joints --action '{"action":"trot"}'
cargo run -p amos-link-cli -- watch --socket /tmp/amos-ai.sock --seconds 3  # 流式心跳：真的在打拍
cargo test -p amos-link --features zenoh -- --ignored   # 真实 Zenoh 会话往返（需网络）
# 联邦信标节奏 = TTL/3（`federation_period()`，一处规则；默认 TTL 3s ⇒ 每秒 1 个信标）。
# 此前 `discover --bus` 与 `watch` 硬编码 200ms（5 个/秒），既多打 4 倍信标，又让
# `published` 看起来像有真实流量 —— 现在三条路径（lan/bus/watch）同一条规则。
# System UI 的链路面板（只读）：设置 →「机器人链路」，读运行中的 daemon。
cd crates/amos-tauri/frontend-ts && bunx vitest run svelte-tests/link-page.svelte.test.ts
```

