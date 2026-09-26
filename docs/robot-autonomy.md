# 机器人自主栈（`amos-robot`）：审计与实现

> 本文回答两个问题：**（一）AmOS 的机器人功能里，哪些是真实现、哪些是占位**（逐条给证据）；
> **（二）这次补了什么、它在哪、它拒收什么、还缺什么**。
>
> 配套：`crates/amos-robot/README.md`（crate 入口）、`docs/amos-link.md`（它下面的中间件）、
> `docs/robot-domains.md`（六类机器剖面）、`docs/robot-apps.md`（应用案例）。

## 0. 审计结论（对着一份“缺失清单”逐条查）

| 清单上的条目 | 真实状态 | 证据 |
|---|---|---|
| Pub/Sub 总线 | ✅ 已实现 | `crates/amos-link/src/{keyexpr,codec,broker,pubsub,node}.rs`；`*`/`**` 迭代 DP 匹配、`Envelope` 自校验帧（magic+ver+bincode 头+CRC32、16 MiB 上限两侧校验） |
| QoS 策略 | ✅ 已实现 | `src/qos.rs`：`Reliability × depth × DropPolicy` + `Qos::for_channel` 唯一策略表；Zenoh 侧真实映射到 `RingChannel`/`FifoChannel`（`docs/amos-link.md` §3.18） |
| LAN 发现 | ✅ 已实现 | `src/discovery.rs`（总线联邦信标 + TTL/新鲜度）与 `src/lan.rs`（真 UDP 组播，`--lan` 特性；`AMOS_LINK_BEACON_IFACE` 固定接口） |
| **实时电机控制（“当前是 Mock”）** | ⚠️ **一半对**：字节出口是真的，**控制环**是缺的 | 真实：`StreamRobotHal<W>` 把已校验的帧写进任意 `AsyncWrite`（UART 字符设备 / 控制器 UDS / TCP），且“整批校验先于任何字节”“上报数 = 真写出的数”。缺：`docs/amos-link.md` §6.2 明写「不是调度器：`RobotBridge::step()` 是显式的一步，线程/频率由调用方决定」——**没有任何东西真的按周期驱动它**，也没有抖动/超期度量 |
| **传感器融合** | ❌ 本来没有 | `crates/amos-sensor/src/spec.rs` 只有相机/GNSS/IMU 的**采样抽象**（`MockProvider` + Android 后端），全仓无姿态估计：没有四元数、没有重力校正、没有陀螺零偏估计 |
| **SLAM 导航** | ❌ 本来没有 | 全仓无占据栅格、无回环检测、无扫描匹配、无里程计融合；`grep` 不到任何 `occupancy`/`scan_match`/`odometry` 实现 |
| **视觉处理** | ❌ 本来没有 | `proto/sensor.proto` 自己写着「raw camera frame *bytes* are NOT shipped here」；相机只有元数据（帧率/尺寸/时间戳），没有一帧像素进过 Rust |
| **路径规划？？？** | ❌ 本来没有，**且位置已被文档预留** | `docs/amos-link.md` 的 ROS 对照表把 Action/TF 明确写成「在 `amos-robot`/`amos-ai` 层」；`docs/robot-domains.md` §6.6「剖面不是规划器：`goto` 不生成轨迹、`lane_keep` 不做横向控制」 |

**一句话**：链路层（键/帧/QoS/发现/安全核心/控制面）已经是产品级并且被二十多轮审计磨过；
**它上面那一层（我在哪、往哪走、有没有按周期跑）是空的**，而本次交付就是这一层的第一版。

## 1. 本次交付：`crates/amos-robot`

| 模块 | 内容 | 关键性质（可测） |
|---|---|---|
| `fusion` | Mahony 6-DOF 互补滤波（四元数状态 + 重力校正 + 陀螺零偏积分） | 不可用加速度计 ⇒ **如实报告** `GravityCorrection::GyroOnly{reason}`（自由落体 / 非 1 g）；超过 `MAX_DT_S = 250 ms` 的停顿 ⇒ **拒绝积分**（`FusionError::Gap`，要求 `reset()` 重新捕获），而不是悄悄跨过去；偏航带 `YawReference::DeadReckoned` 直到**真的**被 `set_heading` 引用过；拒绝非有限样本/非正步长且**不移动状态** |
| `planning` | 占据栅格 + 整数 A* + 视线捷径平滑 + 栅格膨胀 + 纯追踪 | 整数代价（10/14）+ `(f, g, index)` 全序打破平局 ⇒ **同一张地图永远同一条路**；不可达 ⇒ `Unreachable{explored}`（绝不返回“尽力而为”的半条路）；地图外 = 阻塞（未知不等于空闲）；对角步**不许切角**；`inflated(n)` 供调用方补上规划器不知道的**足迹** |
| `control` | 定周期控制环（`tokio` 计时 + `MissedTickBehavior::Delay`）+ 抖动/超期仪器 | `late_by`（**起跑**晚了多少）与 `overrun`（这一拍的**工作**超过周期）是**两个独立事实**；首个 tick 计数但不评判（它没有前驱）；百分位只来自**有界窗口**且 `window_full()` 说明窗口是否滚过；`CadenceHealth::Unknown` 是「还没有证据」这个第三态 |

**与机器的接口是剖面的**：`DriveCommand::set_points()` 产出的就是 `ground-vehicle` 的三个设定点
（`0` 转向 / `1` 油门 / `2` 制动），`check_against(&Platform)` 广播**剖面自己的** `Actuator::check`；
`to_agent_json(action)` 生成控制话题上的载荷（**不带 `speed`**，因为剖面会拒绝固定位姿动作上的 speed），
而 `tests/stack_e2e.rs` 证明它**能被剖面原样解析回来、并计划成帧**。

## 2. 闭环实测发现的三件事（都不是读出来的）

`tests/stack_e2e.rs::the_route_is_actually_driven_and_the_goal_is_reached` 把「规划 → 纯追踪 →
运动学模型 → IMU → 融合」跑成闭环，于是三条只有**真跑**才会露出来的事实当场现形：

**(a) 纯追踪会切角 —— 格子级安全 ≠ 机器级安全。** 在 10×8 m 的院子里（中间 3×3 m 障碍），
按**未膨胀**的地图规划，车辆真的开进了障碍斜对角那一格：实测 `(4, 3)` at `(3875, 4007)`。
处置不是放宽断言，而是补上 `Grid::inflated`（切比雪夫距离增长，含对角），并在测试里对
**原始地图**断言「扫过轨迹从未进入障碍」。这条也正面回答了 `docs/robot-domains.md` §6.6 的那句
「剖面不是规划器」——规划器不知道足迹，所以足迹由调用方以**地图**的形式给出。

**(b) 无状态的目标点选择会把车身**后方**的路径点当成目标 —— 于是车辆掉头绕圈。**
第一版 `pursuit` 的目标点是「路径顺序里第一个距离 ≥ 前视距离的点」；车辆一旦开过早点，
**起点**就满足这个条件，实测后果是车辆以满舵 40 000 mdeg 原地画圈、`target` 永远停在 `(0,0)`。
正确做法是教科书里的两步：**先把位姿投影到路线折线上**，再从投影点**沿路线前推**一个前视距离
（不足则取终点）。回归测试 `a_pursuer_never_aims_behind_itself` 钉住它，并顺带钉住第二层：
上报的 `target` 是**瞄准点所在的格子**，不是最近的路径顶点（后者在长直线上会报出车辆已经开过的顶点）。

**(c) 到达半径必须大于最小转弯半径 —— 否则永远“快到不了”。** 把 `arrive_radius_mm` 留在默认
400 mm 时，转向饱和、转弯半径 2.38 m 的机器**只会绕着目标画圈**（并且被甩出地图边界，
实测 `the vehicle left the map at (-9, 4819)`）。法条本身推不出这个半径（轴距不在设定点三元组里），
所以它是**调用方的约束**，已写进 `PursuitLimits::arrive_radius_mm` 的文档与 README 的边界 4。

三条都不是靠放宽测试通过的：**(a)(c) 改了测试的**配置**（膨胀 2 格、到达半径 2.5 m、前视 1.5 m），
(b) 改了**生产代码**（`aim_point`）。**

## 3. 第二轮审计（REQ-A411）：三处真缺陷 + 一处补全（2026-09-18）

这一轮**先读代码、再写断言**，三条缺陷都用「先让测试红、再修、再复绿」验证，且每条都有负控。

**(a) `Path::cost()` 把一条多格直线腿按「一步」计价。** `simplified()` 返回的是**航点**（相邻两点
之间是直线，不是格步），而 `cost()` 对任意相邻对都套用 `step_cost`（正交 10 / 对角 14）。实测：
空地上 4×3 的 A* 路线（四邻，5 步）`cost()=50`，它的 `simplified()` 只有 2 个点、
`cost()=14` —— **平滑后的路线比原路线"便宜"**，而文档写的是「每正交步 10、每对角步 14」，
函数自己的契约当场被违反。处置：`cost()` 改签名 `-> Option<u32>`（不是步序列就是 `None`），
新增 `Path::is_contiguous()`；一个诚实的三态，而不是一个好看的小数字。

**(b) `ControlLoop` 把「调用方 idle 的时间」记成**环路的迟到**。** `run_ticks`/`run_until` 各自新建
paced ticker，却沿用上一次 run 留下的 `last_tick` ⇒ 第二次 run 的第一个 tick 的间隔 = 两次调用之间
调用方花掉的时间（可能是几秒），而这个**没有在跑**的区间被记成 `late`。实测：`run_ticks(3)`、
50 ms 的 sleep、再 `run_ticks(3)`，`judged` 是 5（多出来了那一拍）且 `worst_late≈45 ms`。
处置：每段 paced run 入口 `restart_pacing()`（丢掉前驱），于是**一段 run 的第一个 tick 与环路
第一个 tick 同规则**：计数但不评判。自己持有计时器的调用方仍走 `tick()`，那里每个间隔都是真间隔。

**(c) `pursuit` 静默纠正一个越界的 limit。** `PlanError::BadLimit` 的文档写着「limit 被拒绝而不是
被纠正：静默纠正会让控制器的行为与它自己的配置不符」，而 `cruise_milli_percent > 100%` 恰好被
`clamp(0, 100%)` 静默纠正。实测：`cruise_milli_percent = 100_001` 得到的是一条**看起来正常**的命令
（`throttle 12500`，因为有转向因子与接近因子），而不是拒绝。处置：越上界 ⇒ `BadLimit`，与下界
（`< 0`）同一处规则。

**(d) 补全（Phase 2 接缝的第一块拼图）：`Grid::from_occupancy` / `Grid::occupancy()`。** 文档 §4 写着
SLAM 的输出「就是 `planning::Grid`」，而今天的构造路径只有 ASCII 行或逐格 `set_blocked` —— 一个
扫描仪给出的是**密集占用缓冲**。新增 `from_occupancy(&[bool], cols, rows, res)`（**行主序、列最快、
`true`=占用**，即 `Grid::index` 的布局）与 `occupancy()`（同一缓冲的借用视图，是它的逆）。长度不符时
返回**新错误** `PlanError::OccupancyShape{given, cols, rows}` —— 拒绝而不是补齐：补齐过的地图是
「缺失的格子悄悄变成自由」，而本模块里未知从不是自由。

**负控（逐条回退一次，实测）**：(a) 去掉 `is_contiguous` 判断 ⇒ `cost()` 回 `Some(14)`，测试报
`left: Some(14) / right: None`；(b) `restart_pacing()` 改成空操作 ⇒ `judged` 回 5（报
`left: 5, right: 4`）；(c) 去掉越上界检查 ⇒ 命令回到 `Ok(DriveCommand{throttle_milli_percent: 12500,
…})` 而不是 `Err(BadLimit{cruise_milli_percent})`。三处还原后全绿。

**顺带发现（不是本层改动）**：`docs/robot-autonomy.md` 缓存的示例输出（`route 3 cell(s), cost 364`）
已经过期 —— 真跑今天是 `route 3 waypoint(s), grid cost Some(182)`；而且旧文案把 `route.len()`
（= **航点数**，平滑后的）写成 "cell(s)"。本轮按真跑更新，并把示例里的 `cost` 标注为 `path`（未平滑）
的 cost。

## 4. 这次没有做（以及为什么不说“做了”）

1. **没有真机**：`MockRobotHal` 是每一条测试与示例的总线；真描述符那条路是中间件的
   `StreamRobotHal`（`docs/amos-link.md` §3.5），本层没有新增任何设备代码。
2. **没有实时承诺**：`ControlLoop` 用 tokio 计时并**度量**它做到了什么；没有 RT 调度类、
   没有优先级继承、没有 `mlock`、没有 WCET 分析。要**有界**的抖动，得先有一台机器去验证，
   而这个环会把那台机器的真实成绩报出来（示例里 20 ms 周期实测 `late=0/4 overruns=0`，
   指挥官沉默后旧的一拍读作 `worst_work≈100 ms`——那是 100 ms 看门狗，不是“环路坏了”）。
3. **闭环里没有 Kalman**：姿态输出是**类别**（`GravityCorrection`）而不是 σ。一个 EKF/UKF
   只有在能同时发布它声称的协方差时才该进这一层。**注意**：本 crate 里**已经有**一个带完整
   协方差的 EKF（`slam::ekf::SlamState`，协方差是它的公开输出之一），但它今天是**库代码**，
   没有被闭环（`ControlLoop` / 示例）消费；它要进来得先有第 5 节说的输入侧（帧字节/绝对航向）。
4. **没有多机协同/编队**：那是任务层（`amos-link` 的机群监督案例演示了“监督”是什么形状）。
5. **没有把 `DriveCommand` 扩成通用动作**：它是 `ground-vehicle` 的三元组；四足/无人机/机械臂
   各自的命令形状不同（共用的是剖面表与帧，不是**规划输出**）。

## 5. Phase 2 接缝：SLAM 与视觉在哪插进来

这两块不是“再写几个函数”，它们各自需要**传感器数据**与**地图表示**，所以先把接缝写清楚。
**先更正一处**：本 crate 里 `vision`（FAST / LK / 八点 + RANSAC / VO 前端）与 `slam`
（EKF-SLAM、占据栅格、回环扫描匹配、数据关联、地标）**已经是带完整单元测试的库模块**，
不再是“尚未存在”。下表的“必须先有的东西”因此是**接入闭环**缺的东西，而不是“算法还没写”：

| 要做的 | 插在哪 | 必须先有的东西 | 为什么不能现在做 |
|---|---|---|---|
| 视觉前端（特征/光流/深度） | 新 crate（暂定 `crates/amos-cv`），输入 `amos-sensor` 的帧，输出特征/描述子 | **帧字节真的能到 Rust**：今天 `proto/sensor.proto` 明确不传原始帧字节，相机只有元数据 | 需要先做“帧通道”（零拷贝的 `sensor` 话题 + 帧池/生命周期），否则视觉算法无输入 |
| SLAM 后端（占据栅格 / 位姿图） | 输出**就是** `planning::Grid`：`Grid::from_rows` / `set_blocked` 已是地图的唯一表示 | 里程计（IMU + 轮速/视觉）与扫描匹配；`fusion` 的 `Attitude` 是它的姿态输入，**但 `yaw` 是 dead-reckoned**，所以还需要一个绝对参考（磁力计/重定位） | `Grid` 是**调用方给的地图**，本层已把自己限定成“不估计地图”；估计地图需要第二套代码与第二份诚实边界 |
| 定位（在已有地图上） | `Pose` 的来源：今天 `Pose` 由调用方给（测试里是模型推的） | 同上；另外需要时间戳对齐（`amos-timesync` 的 `Clock` 已经在链路上，可复用） | 位置漂移的**度量**必须一起做，否则“定位”会变成一个好看的数 |
| 任务层（RTL / 值守 / 编队） | 剖面已经声明了 `Failsafe::{ReturnToBase, Loiter, MinimalRiskManoeuvre}` 与 `must_manoeuvre_when_lost()`；实现它们的是**任务层**（`amos-link` 的 `uav_mission`/`road_autonomy` 两个案例演示了形状） | 域侧协议栈与安全论证 | 看门狗的最小动作在本层，**机动**不在（`docs/robot-domains.md` §3） |

**Phase 2 的第一件事**（也是唯一有确定答案的一件）：把相机**帧字节**做成一条真实通道
（`sensor` 通道 + 零拷贝队列 + 帧的生命周期），因为视觉与视觉 SLAM 都卡在这一步；
`amos-sensor` 现有的 `CameraSpec`/帧元数据是它的上半截，`amos-link` 的 16 MiB 帧上限与
`Qos::sensor()`（最新帧胜）就是它的下半截。

## 6. 第三轮审计（REQ-A495）：把唯一一处「预留但未接线」真正接上（2026-09-19）

第二轮之后，`grep` 未完成标记（`not yet wired` / `reserved` / `TODO` / `unimplemented`）在本 crate 里
命中四处，其中三处是本仓**故意**不做的扩展点（JCBB 数据关联、五点相对位姿求解器、serial 的
`delimited`/`encode` 测试路径），文档已各自论证「不做」。（**当时记录**：JCBB 一项已于 §71 反转、
实现，此处保留原文以存史。）唯一一处**具体的、安全相邻的缺失代码**
是 CAN 驱动的自述——它自己写着重传循环**尚未实现**。

**(a) `CanRobotHal::apply` 的有界重传。** 第 ①（整批校验）②（超 8 字节载荷拒绝）两步不变，
第 ③ 步从「向内部 HAL 委托一次」改为**只对 `LinkError::Transport` 有界重传**（判据
`attempt < self.retries`，`retries = MAX_CAN_TX_RETRIES = 4` ⇒ 至多 5 次尝试）。

三条设计决定，都写成理由而不是默认值：

- **只重传 `Transport`，绝不重传 `Robot`。** `Transport` 是「总线/邮箱」的问题，`Robot` 是
  「这条命令本身被拒」；重传一条被拒命令是缺陷，不是鲁棒性。
- **两次尝试之间不 sleep。** 在这里 sleep 会推迟急停，而「为仲裁保留一帧」是控制器芯片的职责；
  驱动的唯一职责是把它**再交一次**。
- **重发是安全的。** 本协议的每个 `MotorOp` 都是绝对设定点或模式操作，所以一批只落地了一部分的
  帧重发之后，每个关节仍停在它**已经达到**的状态——重传只增加总线流量，不会破坏机器。

**(b) 三条测试都在一个假写盘上（`Flaky`：前 N 次 `poll_write` 返回 `WouldBlock` 并计尝试数），
且都用「注入 ⇒ 变红 ⇒ 原样还原 ⇒ `cmp` 证字节一致」验证过**：

| 测试 | 钉住的 | 负控怎么变红 |
|---|---|---|
| `apply_succeeds_after_a_transient_failure_within_the_budget` | 失败 2 次后成功；`attempts == 3` 且**帧只上过一次线**（重传不是重复写） | 判据由 `Transport` 翻成 `Robot` ⇒ FAILED |
| `apply_gives_up_after_the_bounded_retry_budget` | 永远失败 ⇒ `Err(Transport)`、`attempts == 5`、`frames_written() == 0` | `attempt < retries` 改 `attempt <= retries` ⇒ `left: 6 / right: 5` |
| `a_refused_command_is_not_retried` | 越界 `SetPosition 90_001` ⇒ `Err(Robot)` 且 `attempts == 0`（一个字节都不上线） | 判据翻成 `Transport` ⇒ 该命令会被重发 |

**(c) 顺带查出的第二个真缺陷：CAN 的字节计数按「CAN 载荷形状」算，而不是按它真正写出的字节。**
`CanRobotHal::bytes_written()` 原本是 `frames × (MAX_CAN_PAYLOAD + 2)`——这个数**今天**恰好等于
`FRAME_LEN`（8 + 2 剥掉的 SOF 字节 = 10），但**驱动写的是原始 `MotorFrame`，不是 CAN 载荷**；
serial 驱动对同一个量用的是 `frames × FRAME_LEN`。两条路今天同值、**推导不同**：`FRAME_LEN`
一旦变动，serial 报得对、CAN 继续报一个看起来合理的错数——而「报一个看起来合理的错数」正是这个
仓按字节计数的理由。处置：改为 `frames_written() × FRAME_LEN`，doc 写明**不要**从 CAN 映射推导
这个数；测试改为对**真写进 sink 的字节数**断言（与 serial 的同一测试同形）。

**诚实边界**：这条修复**没有**测试能钉住「推导」—— `MAX_CAN_PAYLOAD + 2` 与 `FRAME_LEN` 今天
数值相等，任何运行时断言都分不开两种写法。测试钉的是**值**（对真写出字节），推导的改动是**代码
卫生**，已如实写在测试注释里，不声称它是一道门。

**(d) 文档诚实化（不动任何线缆字节/布局）**：`can.rs` 的「Bounded retries (reserved, not yet wired)」
小节改写为已实现的行为；`MAX_CAN_TX_RETRIES` 的文档从「Not enforced today」改为「`4` 次重传 =
至多 5 次尝试」；`driver/mod.rs` 的 CAN 条目从「reserved, not yet wired」改为描述已实现的有界重传；
`lib.rs` 的 `driver` 条目把「real motor-driver **skeletons**」改为「the three physical-layer motor
drivers」（它们早已校验/写盘/计数，不是骨架），并把图示 ① 的「where am I / which way am I pointing」
改为「which way am I pointing」（`fusion` 不估计位置，`Pose` 来自调用方）；`crates/amos-robot/README.md`
按真模块面重写（原文仍写着「Three modules」且边界 2 断言「nothing here estimates a map, matches
scans or processes an image」——与本节 §5 更正后的说法直接矛盾；现补上 `slam`/`vision`/`mrac`/`safety`/
`driver` 五节、Layout 表与计数）。

**仍未做，且不声称做了**：重传只在 `Flaky` 假写盘上验证，**没有任何控制器**验证过真实的
「无邮箱可用」返回；重传是**立即的**（无退避/背压），真实的 `SocketCAN` 可能需要 `write_all`
之外的 ENOBUFS 处理；`retries` 目前只有 `new()` 一个赋值路径（恒为 `4`），没有 setter。

## 7. 第四轮审计（REQ-A497）：`cell_centre` 说「中心」却返回「角」——半格几何缺陷（2026-09-19）

第三轮之后，剩下的工作是把覆盖缺口补齐：对着 `--show-missing-lines` 逐行读 `planning.rs` 里「可达但
没测到」的公开路径。给 `cell_centre` 补一条边界测试时，它**红了**——我写的期望值 `Some((250, 1250))`
对不上真值 `Some((500, 1000))`。查下去是两处真缺陷，都在同一个函数上。

**(a) 半格几何缺陷：`cell_centre` 返回的是格子的西北「角」。**
`world_to_cell` 用 `floor_div(位置 − origin, res)`，所以格子 `k` 是半开盒
`[origin + k·res, origin + (k+1)·res)`——**角**约定，而且这条由既有的
`world_to_cell(-1_001, 500) == None`（origin = −1000）测试钉死。但 `with_origin` 的文档写着
origin 是「cell `(0,0)` 的中心」，`cell_centre` 也自称返回「格子的中心」，实际却返回
`origin + k·res`，即那个**角**。两处文档与代码差半格。

后果不是文档问题，是几何问题：`clearance_mm` 把这个点当成边长 `res` 的正方形的中心（`half = res/2`），
于是障碍方块整体朝角偏移半格——既在真格子**外面**多垫了半格（让从南面接近的车提前 500 mm 停），又在
真格子**里面**漏了靠北/靠东的**半格**（让一个正好落在阻塞格远侧四分之一的点读出正的净空）。在一个
1 m 格的地图上，一个**停在阻塞格上**的点能报出几百毫米净空——这正是「净空」这个量存在的理由的反面。

**处置**：`cell_centre` 加上 `res/2`（现在**真的**是中心），`with_origin` 的文档改为「cell `(0,0)` 的
西北**角**」并说明 `cell_centre` 会把那半个格子加回来。

**(b) 同一个函数里的第二处缺陷：`saturating_sub` 在 `i64` 上钳在 `i64::MIN`，不是 `0`。**
改完 (a) 之后新测试**还是**红（`left: 282`）：`dn = (north − cn).abs().saturating_sub(half)` 在点落在
方块内部时给出**负数**，负数再被平方回去，就变成一段**凭空来的正净空**。距离到面的每轴分量必须在
**零**处钳住（`.max(0)`），而不是仅仅「饱和」。这条与 (a) 无关，是独立的符号缺陷。

**(c) 两条修复各自的负控**（逐条注入 ⇒ 变红 ⇒ 原样还原 ⇒ `cmp` 证字节一致）：

| 测试 | 钉住的 | 负控怎么变红 |
|---|---|---|
| `cell_centre_has_no_position_for_a_cell_outside_the_map` | 3×2 / 500 mm 图上 row 1 col 2 的**中心**是 `(750, 1250)`（不是角 `(500, 1000)`），且越界返回 `None` | 去掉 `+res/2` ⇒ FAILED（`left: Some((500, 1000))`） |
| `a_point_inside_a_blocked_cell_has_no_clearance` | 阻塞格远侧四分之一的点净空为 **0**；格北面外 100 mm 的点净空为 **100** | 去掉 `.max(0)` ⇒ FAILED（`left: 282`）；去掉 `+res/2` ⇒ FAILED（`left: 424`） |

**(d) 影响面（为什么不改线上字节、为什么改了四条测试）**：`cell_centre` 的值是所有瞄准点的基准
（`pursuit`/`dwa` 的目标、平滑、示例的起始位姿、`tests/stack_e2e.rs`），所以修正后四条既有单测的前提
失效——它们的车都停在「角上假装是格心」（`Pose { north_mm: 0, east_mm: 0 }`），DWA 那条的墙在真实
地图上比测试以为的**远半格**（1.5 s 而非 1 s，1 s 视界内不再必然撞墙）。四条都改为从
`grid.cell_centre(...)` 取起点，前提变成「从真正的格心出发」，比原来更强。`tests/stack_e2e.rs` 的闭环
与 `examples/patrol_loop.rs` **未改一字**，仍 `reached_goal=true`。

**诚实边界**：这是**几何模型**的修正，不是安全性的削弱——旧代码是把障碍方块**整块**移了半格（一边
多垫、一边漏防），新代码就是真格子本身；但它**只在离线网格上验证**，没有真机、没有真实代价地图、
没有用测距仪复核过「阻塞格的边界确实在格子边界上」。`cell_centre` 仍是 `pub`，语义变化是**行为**变化
（瞄准点/净空值整体挪半格），任何下游按旧值硬编码的实现需要跟着改。

## 8. 第五轮审计（REQ-A503）：UDP 驱动文档里的「wrapped socket」在类型系统里不存在（2026-09-19）

第四轮之后继续读 `driver/` 三个文件的文档与公开面。`driver/mod.rs` 的表格把 UDP 一行写成「Discovery +
control plane」，而 `udp.rs` 的模块文档写着这两个驱动「wrap a `tokio::net::UdpSocket`」。查下去发现
**那句话不可能为真**，而且连带三处文档在描述不存在的代码。

**(a) `tokio::net::UdpSocket` 不实现 `AsyncWrite`，也不实现 `AsyncRead`。**
它是数据报 socket，不是字节流。在 tokio-1.53.1 的源码里（`src/net/udp.rs`）它的 trait 面只有
`TryFrom`、`Debug`、`AsRawFd`/`AsFd`/`AsRawSocket`/`AsSocket`，另有固有的
`poll_send_to(&self, cx, buf, target)` 与 `recv_from`——**没有** `poll_write`。所以「把 UDP socket 包一下
当 `AsyncWrite` 交给驱动」是一句类型检查直接拒绝的话：任何部署都必须**自己**写这层适配。文档承诺了一个
不存在的类型，读者按它写的代码编译不过。

**(b) 因此 `UdpControlRobotHal` 的 `destination` 安全论证原本是空的。**
它接受一个 `SocketAddr`，文档暗示那就是帧上线的地方；但真正决定字节去哪的是 `W`——而当时**没有任何
随本 crate 发布的 `W` 能做到「发到这个地址」**。`destination` 于是只是元数据。已在类型文档里写明：
本类型从不向它发送，也不**校验**它，只在 `Debug`/`destination()` 里给运维日志一个名字；把 `UdpSink`
绑到另一个地址、却在这里传一个「看起来对」的地址，日志就会报错对端。

**(c) `UdpDiscoveryRobotHal` 被文档描述成「跑 state 报告和总线的 ping 帧」。**
`RobotHal` 的写动作只有一个：`apply(&[MotorFrame])`。而 motor frame 不是 state 报告。所以这个类型
**没有任何发出 state 报告或 ping 的路径**——非空批一律拒绝，空批返回 `0` 且一个字节都不写，
`bytes_written()` 因此**结构性地恒为 0**。已把文档改成它真实的样子：一个**只做拒绝的护栏**
（把发现平面误接到控制平面位置的部署会拿到一条明确的拒绝，而不是把设定点发到错误的 socket），
以及「它今天不携带 state 报告」这条边界，而不是继续暗示有一条被预留的读回路。

**(d) 顺带：控制平面缺了 `bytes_written()`。**
`serial`/`can` 两个驱动都成对报 `frames_written()` 与 `bytes_written()`，只有 UDP 控制平面只有前者。
已补上，推导与另两个驱动同形（`StreamRobotHal::bytes_written()`，即 `frames × FRAME_LEN`）。

**实现**：新增 `pub struct UdpSink`——一个把**一次 `write` 变成一次 `send_to`，即一个数据报**的
`AsyncWrite`，内部就是 `tokio::net::UdpSocket::poll_send_to`。这条「一次写一个报文」的规则是它存在的
全部理由：`StreamRobotHal::apply` 对每一帧调一次 `write_all(frame.encode())`，所以在这个 sink 上
**一帧就是恰好 `FRAME_LEN` 字节的一个数据报**；一个会合并/切分的字节流 sink 交给对端的是它无法解析的
载荷，因为数据报接收方除了报文本身看不到任何帧边界。`poll_write` 不做重传（UDP 静默丢包，重传策略属于
知道「这一批是不是幂等设定点」的上层 HAL）；数据报发送是「全有或全无」，所以 `poll_write` 从不返回短的
`Ok(n)`。`UdpSink` 连同 `UdpControlRobotHal::bytes_written` 从 `driver/mod.rs` 与 `lib.rs` 导出。

**(e) 负控**（逐条注入 ⇒ 变红 ⇒ 原样还原 ⇒ `cmp` 证字节一致）：

| 测试 | 钉住的 | 负控怎么变红 |
|---|---|---|
| `the_udp_sink_sends_one_frame_per_datagram` | 两个真 loopback socket：批内每帧**恰好一个**数据报，字节与 `frame.encode()` **逐字节相同**；`bytes_written() == 2 × FRAME_LEN` | `poll_write` 改成只发前 4 字节 ⇒ FAILED（`one whole frame per datagram: left: 4 / right: 10`） |
| `the_udp_sink_reports_its_destination_and_local_address` | `Debug` 同时报出目标地址与本地绑定地址（运维要区分两个 sink 就靠这两条），且 `flush`/`shutdown` 立即完成、`shutdown` **不**关 socket | 从 `Debug` 里删掉 `local` 字段 ⇒ FAILED（`got UdpSink { destination: 127.0.0.1:9 }`） |

**(f) 顺带清掉的覆盖缺口**：`UdpSink::poll_shutdown` 原本没有调用者（`--show-missing-lines` 指到
124–131），现在由上面第二条测试真的调用一次。`udp.rs` 剩下的未覆盖行只有 232 行那句
`estop_frames().ok_or_else(...)`——**按构造不可达**（`driver/mod.rs` 的测试已钉死
`MAX_JOINT == JOINTS - 1`，循环构造的每个索引都是合法关节），属于本仓规则里「防御性不可达 ⇒ 写证明」
而非「补测试」的那一类。

**诚实边界**：①这条 UDP 往返是在**两个 loopback socket** 之间量的——它比「对抽象断言」强，但仍然
**不是**真实网络对端：没有丢包、没有 MTU 分片、没有防火墙、没有真实 NIC；②`UdpDiscoveryRobotHal`
本轮**只改了文档**，它**依旧不携带 state 报告**（那条读回路没有实现，只是不再被暗示存在）；
③`MAX_UDP_DISCOVERY_BYTES` 本 crate **不**强制（motor frame 路径由 `FRAME_LEN` 限死），文档已写明；
④`poll_write` 里没有重传是**有意的**，不是遗漏——重传归上层 HAL。

## 9. 第六轮审计（REQ-A506）：同一个 CANopen 映射，三份文档三个数（2026-09-19）

第五轮把 `driver/udp.rs` 清干净之后，继续逐个读 `driver/serial.rs` 与 `driver/can.rs` 的文档。`can.rs`
的 COB-ID / PDO 映射**在三处各写了一遍，三处互不相容**，而其中两处与它引用的 CiA 301 都对不上。

**(a) 三份说法**（都在同一文件里）：

| 位置 | 说法 | 问题 |
|---|---|---|
| 模块文档 | 「Function code：11 位 ID 的高 4 位（PDO1 用 `0x200 ‖ node_id`）」 | 这条**对**：`0x200 ≫ 7 = 4`，而 `0x200 + node` 正是 CiA 301 的 RPDO1 |
| `CanId.function` 字段 | 「`0x1` = PDO1 tx，`0x2` = PDO1 rx」 | 这套 nibble 表**不是** CiA 301 的任何一项 |
| `CanRobotHal::new` | 「默认 `0x2` 是 CANopen 的 PDO1 tx」 | 与上一条直接矛盾（同一 nibble 一处读 tx、一处读 rx），且**代码里根本没有「默认」**：`function_tx` 是无默认值的必填参数 |

按 CiA 301 的 *Predefined Connection Set*（已查证并写进代码注释）：TPDO1 = `0x180 + node`（nibble `3`），
RPDO1 = `0x200 + node`（nibble `4`）。设定点走向是主站 → 驱动，所以本条驱动该用的是**驱动的 RPDO1**，
即 nibble `4`；模块文档里那个 `0x200` 因此是对的，被写坏的恰恰是字段文档与构造函数文档。而 `0x2`
（COB-ID `0x100 + node`）落在预定义集**未分配**的区间里——它是本仓测试的占位符，不是一个 CANopen 分配。

**(b) 处置（不改线上字节）**：把三处收成**一处**说法，写进模块文档并让另两处引用它；字段文档改成「它的含义由部署的
PDO 映射决定，不由本 crate 决定」；`new` 的文档改成「**没有默认值**——nibble 是必填的部署参数，改过 PDO 映射的
节点需要别的 nibble，而在错误的 nibble 上发出的帧是驱动器**静默忽略**的帧」，并点名测试用的 `0x2` 只是占位符。
`encode()` 本身**一字未改**（线上字节不受影响：`apply` 根本不构造 `CanId`，`CanFrame`/`encode_frame` 是自述的
「仅供检视与测试」的辅助面）。

**(c) 同一轮里清掉的两类「文档说了、代码没做」**：

* `MAX_CAN_TX_RETRIES` 标着 `// cited:` 却**什么都没引用**（原话是「CAN 控制器 TX 邮箱仲裁隐含的 `~4` 次预算」——
  ISO 11898-1 里没有任何一条规定软件重传预算，位级重传是硬件自己的事）。改为 `// chosen:` 并说清理由：它是
  **策略上限**而非引文，`4` 次让最坏情况停在 5 次总线尝试，且因为没有 sleep，代价是总线流量而不是墙钟时间。
* `CanFrame::from_motor_frame` 的 `None` 分支**从未被覆盖**（`can.rs:119`）。它**按构造不可达**：
  `MotorFrame::encode` 返回定长 `[u8; FRAME_LEN]`，剥掉 2 字节 SOF 后恒为 `FRAME_LEN − 2`，而
  `FRAME_LEN − 2 == MAX_CAN_PAYLOAD`。已把这条不变量**写进文档**并在测试里**显式断言**（不伪造一条「超大帧」
  测试——本 crate 的 API 造不出这种帧），符合本仓规则「防御性不可达 ⇒ 写证明」。
* `serial.rs` 的模块文档说驱动「adds **RS-485 turnaround** on top」，而 `apply` 只在**整批写完之后**睡一次，
  且 RS-485 的真周转还需要收发器的 DE/RE 方向脚——`AsyncWrite` 根本够不到那根脚。已改写为「模型化的是**延迟**，
  不是方向脚」，并写明：要逐帧周转，就得一帧一次 `apply`。

**(d) 负控**（逐条注入 ⇒ 变红 ⇒ 原样还原 ⇒ `cmp` 证字节一致）：

| 测试 | 钉住的 | 负控怎么变红 |
|---|---|---|
| `the_documented_cia301_nibbles_reproduce_their_cob_ids` | nibble `4` ⇒ `0x200 + node`（node 取 1/7/63/127）、nibble `3` ⇒ `0x180 + node`；且测试占位符 `0x2` **不是** CiA 301 分配（`0x100 + node`） | `encode` 的 `<< 7` 改 `<< 8` ⇒ FAILED（`RPDO1 (set-point direction) for node 1: left: 1025 / right: 513`） |
| `a_turnaround_delay_changes_no_byte_and_no_count` | 打开 `turnaround_us = 100` 后：返回值、帧数、字节数、线上字节**与关掉时逐字节相同** | 把「延迟分支」改成睡觉后直接 `frames.len()`（真实缺陷形状：延迟路径**替换**了写）⇒ FAILED（`left: 0 / right: 1`） |

**(e) 覆盖**：`driver/` 三个文件里剩下的未覆盖行**只有**三处「按构造不可达」的防御分支（`can.rs` 的
`from_motor_frame` `None` 与 `estop` 的 `ok_or_else`、`serial.rs`/`udp.rs` 的 `estop` `ok_or_else`），
其余全是测试自用 `AsyncWrite` 夹具的 `poll_shutdown`。整体 `--lib` 覆盖由 97.62% region / 97.59% line
升到 **97.66% / 97.68%**。

**诚实边界**：①本轮**只改文档、注释与测试**，`driver/` 的线上字节**一个都没动**（`encode()` 未改，
`apply` 的写路径未改）；②CiA 301 的 COB-ID 分配是**查证过的既有规范**，但本仓**没有任何真实 CAN 控制器或伺服**
——「在错误 nibble 上发出的帧会被静默忽略」是规范推论，不是本仓实测；③`turnaround_us` 仍然**不**做逐帧周转，
也**不**驱动方向脚：本轮把它从「含糊的承诺」改成「写清楚的边界」，没有把它补成真周转（那需要 `AsyncWrite`
之外的接口，属于接线层设计）；④CAN 驱动仍然**没有**实现 CANopen（模块文档自述），只做仲裁之外的裸帧字节流。

## 10. 第七轮审计（REQ-A509）：数据关联在算完 `sqrt` 之后又把结果平方回去（2026-09-19）

`driver/` 清干净之后往回看 `slam/`。`data_assoc.rs` / `landmarks.rs` 里有两处「代码和它自己的文档对不上」，
一处是热循环里的真浪费，一处是「写了、没人读」的工作区。

**(a) 缺陷一：`sqrt` 的往返（热循环里的真浪费）**

模块文档第 5 行写得很清楚：门是 **平方** 形式 `νᵀ S⁻¹ ν < χ²_threshold`，阈值是 `χ²` 的上分位点，
「**所以不开根**」。但代码是反的：`Landmark::mahalanobis` 返回 `sq.sqrt()`，`associate` 的内层循环拿到根之后
在门里写 `best_distance * best_distance <= gate_squared` —— **每个 landmark × 每个 observation 白算一次 `sqrt`，
再平方回去**（256 × 200 的一帧是 51 200 次）。

处置：
* 新增 `Landmark::mahalanobis_squared`（返回二次型 `sq`，退化情形依旧 `INFINITY`），`mahalanobis` 改为
  `self.mahalanobis_squared(..).sqrt()` —— **对外可观测行为逐位不变**（`INFINITY.sqrt()` 就是 `INFINITY`）。
* `associate` 的内层循环改在平方域比较，门判据变成 `best_squared <= gate_squared`；但
  `Association::Match { distance }` / `New { distance }` 汇报的**仍然是根**（日志和图上要的才是距离）。

**如实标注**：这是**代价**修复，不是**行为**修复。`f32` 里 `sqrt` 再平方不是恒等映射，我枚举了 shipped
门值 `CHI2_2DOF_95` 之上**每一个**可表示 `f32` 平方距离，回代后**没有一个**落回门内 ⇒ 两种写法给出同一判定。
这条边界写进了 `mahalanobis_squared` 的文档，而**没有**伪造一条「精度更好」的测试 —— 那个测试在今天的门值下
**不会**因为改回根而变红（我试过：见 (d) 表的 M0）。

**(b) 缺陷二：一个「写了、没人读、还被清空」的工作区**

`AssocScratch` 的字段文档说「在内层循环里写、在记录门判定时读」，两半都不对：写入发生在内层循环**之后**
（值本来就在寄存器里的 `best_distance`/`best_landmark` 中），判定也是**从那两个局部量**构造的，而
`associate` 在返回**之前**又 `reset()` 了一次 —— 于是这个工作区**从头到尾没被算法读过，且读回来永远是空态**。
模块文档更顺着这个说法写下了「the data-association step never touches the allocator」，而 `associate`
其实**每次调用都分配一个 `Vec<Association>`**（每次调用一次，不是每条 observation 一次）。

处置（**既修文档也补功能**）：
* 工作区改成**真的可用**：`associate` 只在**开头** `reset()`（重用安全由此保证），返回时**保留**本次结果；
  新增 `AssocScratch::best_distance(i) -> Option<f32>` 与 `best_index(i) -> Option<u16>` 把结果读回来，
  不必再走一遍 `Vec`。`None`（超出 `ASSOC_CANDIDATES`）与 `INFINITY`（本帧没有任何候选）的差别写在文档里。
* 模块文档的「Why a scratch buffer」一节改写为**如实**版本：**内层循环**（256 × 200 = 51 200 次比较）确实
  **零分配**——这才是 Power of 10 #2 关心的那个循环；而 `associate` 本身每次调用分配一个 `Vec`，
  20 Hz 下是 **20 次/秒**，并把那句「4000 个 `Vec`/秒」按事实改正（那个数量级属于「每条 observation 一次分配」的设计）。
  `slam/mod.rs` 的第 6 条同样改写为「**内层循环**不分配；**调用**不是零分配」。

**(c) 负控**（逐条注入 ⇒ 变红 ⇒ 原样还原 ⇒ `cmp` 证字节一致）：

| 测试 | 钉住的 | 负控怎么变红 |
|---|---|---|
| `mahalanobis_squared_is_the_square_of_the_root`（`landmarks.rs`） | 各向异性 `Σ = [[4,1],[1,1]]`：`sq = 1/3`（手算），且 `mahalanobis² = sq`；另取离轴点 `(0.5,0.5)` ⇒ `1/4`，让 `Σ⁻¹` 的转置/符号错位现形 | M1 把 `mahalanobis_squared` 的返回值改成 `sq.sqrt()` ⇒ FAILED |
| `mahalanobis_squared_refuses_the_same_degenerate_covariances` | 奇异（`cov = 0`）、不定（`[[−1,0],[0,−1]]`，`det = +1`）、`NAN` 输入两种写法都给 `INFINITY` | M2 删掉 `sq < 0.0` 这一半判据 ⇒ FAILED |
| `the_verdict_reports_the_root_while_the_gate_is_applied_squared`（`data_assoc.rs`） | 汇报的是**根**（点 `(2,0)`、`cov = I` ⇒ 报 `2`，不是 `4`），且 `distance == Landmark::mahalanobis(..)`、`distance² == mahalanobis_squared(..)`；门仍是 `<=`（在门上算内，刚过门算外） | M3 把 `Match` 分支的 `distance: best_squared.sqrt()` 改成 `best_squared` ⇒ FAILED |
| `the_scratch_accessors_agree_with_the_verdicts` | 工作区读数与 verdict 列表**逐个相等**；`None`（超 `ASSOC_CANDIDATES`）与 `INFINITY`（本帧无候选，如全未观测的图）**分得开** | M4 去掉访问器里 `u16::MAX → None` 的映射 ⇒ FAILED（哨兵泄漏成 `Some(65535)`） |
| `the_scratch_is_reusable_across_frames` | 一个工作区连跑三帧：第 2 帧（1 条 observation）**没走过的** slot 1 读回 `INFINITY` / `None`，不是第 1 帧的遗留答案 | M5 删掉 `associate` 开头的 `scratch.reset()` ⇒ FAILED |
| `the_95_percent_gate_admits_the_boundary_and_refuses_past_it`（原有） | 门边界不变：正好在 95% 半径上算内、刚过算外 | 改回根-平方往返也**不会**变红 ⇒ 已如实记入 (a)，不据此宣称覆盖 |

**(d) 覆盖**：`--lib` 由 97.66% region / 97.68% line 变为 **97.62% / 97.65%**（分母增加的是文档中改写后的
新代码路径；`slam/data_assoc.rs` 的**未覆盖行只有测试自用的 `panic!` 臂**与「按构造不可达」的 `u16` 溢出防御）。
单元测试数 280 → **284**（+2 在 `landmarks.rs`、+2 在 `data_assoc.rs`），集成与 doctest 数量不变。

**诚实边界**：①本轮**不改任何线上字节**，也不改 `associate` 的公开判定语义（`Association` 两个分支的
`distance` 仍是根，门仍是 95% 分位点）；②(b) 的「工作区真的可用」是**功能补全**，本仓目前**没有**
非测试调用方 —— 它服务的是「持有一片 landmark 云、但没有联合协方差」的两段式设计（模块文档已述），
这个接缝属于 Phase 2（见 §5）；③`mahalanobis_squared` 的平方域比较**不**改变上面那条
「回代无翻转」的结论——那是**枚举**出来的，不是证明出来的，写在了函数文档里。

## 11. 第八轮审计（REQ-A511）：一条编出来的参考文献，一次单样本窗口「搜到了没问过的位姿」，以及 `slam/` 三个错误类型没有 `Display`（2026-09-19）

`slam/` 的数据关联清完之后，回头读同目录下还没逐行看过的 `loop_closure.rs`（扫描匹配／回环）与
`ekf.rs`、`occupancy.rs` 的公开错误面。四条问题，性质各不相同。

**(a) 伪造的引文（这条最严重，因为它对后来的读者与真引文无法区分）**

模块文档写：`Olson *et al.*, "Closed-loop performance", IROS 2005`。**没有这篇论文**。Olson 的扫描匹配
论文是**单作者** *Real-Time Correlative Scan Matching*, **ICRA 2009**（已查证：ACM DL 10.1109/ROBOT.2009.5152375，
pp. 4387–4393，摘要里 "global loop-closing" 是该论文的**应用**而不是标题）。标题错、会议错、年份错、
作者数也错。同族的第二处：`MIN_MATCH_RATIO` 的文档说 `0.3` 是「Olson 论文报告的真实回环下界」——
该论文里**没有这个数**。

处置：模块文档改正为真实的 ICRA 2009 引文，并**保留一段**说明这次改的是什么、为什么原来的写法是伪造的
（把假引文悄悄换掉，等于把这次审计的证据也一起删掉）；`MIN_MATCH_RATIO` 标为 `// chosen:`，把「0.3 为什么
合理」重新写在**它自己的理由**上（虚匹配也会有一部分点在门内，真实重访则大多数点在门内，`0.3` 落在两者之间
且两侧都有余量），并写明它是**策略**，不是任何人测出来的。

**(b) 单样本窗口搜到了一个调用方没问过的位姿（真缺陷）**

`ScanMatchConfig::samples_*` 的文档写着「`samples == 1` 合法（零宽窗口，**以初始位姿为中心**）」，
测试的注释也这么写。但代码是：步长 `dx = 2·range/(n−1)` 在 `n == 1` 时取 `0`，候选点是
`initial_pose − range + i·dx` ⇒ `n = 1` 时那**唯一**的候选点落在 `initial_pose − range`，即窗口的**角**，
不是中心。于是一次「零宽搜索」返回一个偏了一整个 `range` 的位姿，而 `LoopClosureReport` 的
`cost_drop` 还是拿**从未被求值过的中心**去比的。

处置：抽出 `axis_offset(range, samples, i)`，`samples == 1` 返回 `0.0`（中心），`samples > 1` 保持
`−range + i·step`（**多位姿行为逐位不变**，已由既有 `a_perturbed_pose_converges_back_to_the_initial`
钉住）。既有测试只断言 `cost.is_finite()`，**抓不到**这个缺陷 —— 已补上「返回的位姿必须**逐位等于**初始位姿」
与「单样本窗口永远 `accepted == false`」两条断言。

**(c) `MAX_SCAN_OPERATIONS` 的算术说反了（文档缺陷）**

原话：「5 M 次操作在当代 64 位 CPU 上大约是 10 ms（100 Hz）tick 的**一小部分**」。算术是：每次内层迭代
约 1 ns ⇒ 5 M ≈ **5 ms**，即 10 ms tick 的**一半**，不是一小部分。而且 1 ns 还**低估**了它：内层每次迭代
是 1 次比较 + 2 次减 + 2 次乘 + 1 次加，外加**每个点**一次 `sqrt`。处置：把这段改成算得出来的说法
（≈5 ms、是地板不是估计），并明确写上「本 crate **从未在**任何机器上给 `scan_match` 计时」—— 这个上界的作用
只是让操作数**有限且可预测**。

**(d) `slam/` 三个错误类型**没有 `Display`（补全）

`PlanError` / `DwaError` / `FusionError` / `LoopError` 都有 `Display + std::error::Error`，并有
`every_*_error_renders_its_cause` 测试；而 `SlamError` / `OccupancyError` / `ScanMatchError`
**一个都没有** —— 调用方只能 `{:?}`，拿不到一行给操作员看的话。三个全部补上 `Display` 与
`std::error::Error`，每个配一条测试：**非空**、**不含类型名**（说的是原因不是类型）、**两两不同**
（两个不同的故障渲染出同一行等于什么都没说），以及各自点名的关键数字（`MapFull` 要说 `MAX_LANDMARKS`、
`TooLarge` 要说真实上限 `MAX_GRID_CELLS`、`WindowTooLarge` 要同时说被拒的操作数与上限）。

**(e) 顺带补上的输入校验**

`ScanMatchConfig` 的每个 extent 原来**完全不校验**。一个非有限 `range_*` 会让每个候选位姿非有限、
每个 cost 变 `NaN`，于是 `cost < best_cost` 恒为假 ⇒ 函数返回 `Ok`，带一个 `INFINITY` 的 cost 和
**输入位姿** —— 一个看起来像「搜索跑了、没找到更好的」的结果，实际上**什么都没比较**。负的
`range_*` 则会把窗口镜像而不是改变大小（字段名就叫 half-extent）。新增
`ScanMatchError::InvalidConfig`，在动输入之前先拒绝。零 extent 仍然合法（那是 `samples` 已经表达过的
退化窗口），边界从接受侧也钉住了。

**(f) 负控**（逐条注入 ⇒ 变红 ⇒ 原样还原 ⇒ `cmp` 证字节一致）：

| 测试 | 钉住的 | 负控怎么变红 |
|---|---|---|
| `a_degenerate_window_is_refused_but_a_single_sample_is_not` | `samples = 1` 的候选点**就是**初始位姿（`pose`/`report.pose` 都等于它），且 `accepted == false` | M1 把 `axis_offset` 的单样本分支改回 `−range` ⇒ FAILED |
| `a_malformed_config_is_refused_not_silently_searched` | `NaN`/`INFINITY`/负的 `range_*` 与 `max_match_distance_m` 全部 `Err(InvalidConfig)`；零 extent **不是**错误 | M2 让校验恒不触发（`if false && …`）⇒ FAILED |
| `every_scan_match_error_renders_its_cause` | 5 个变体各自一行、互不相同；`WindowTooLarge` 同时含被拒数与上限 | M3 让 `EmptyMap` 复用 `EmptyScan` 的文案 ⇒ FAILED（两行相同） |
| `every_slam_error_renders_its_cause` | 3 个变体各自一行、互不相同；`MapFull` 含 `MAX_LANDMARKS` | M4 把 `MapFull` 文案里的上限删掉 ⇒ FAILED |
| `every_occupancy_error_renders_its_cause` | 3 个变体各自一行、互不相同；`TooLarge` 含 `MAX_GRID_CELLS` | M5 把上限删掉 ⇒ FAILED |

**(g) 覆盖 / 计数**：单元测试 284 → **288**；集成 29、doctest 11 不变。`--lib` 覆盖
**97.61% region / 97.62% line**（分母增加的是新代码）。除 `examples-smoke` 外仓门全绿；
`examples-smoke` 当轮失败于**另一个 crate**（`amos-tauri` 的编译错误，属于并发会话的在制品），
与本轮改动无关、本轮未触碰。

**诚实边界**：①**线上字节与本层公开判定语义未变**；`samples > 1` 的多位姿行为逐位不变（既有测试钉住）；
②(b) 的修复**只**改变了「`samples == 1`」这一条路径的返回值 —— 但这**是**行为变更，虽然原行为是缺陷：
旧的返回位姿是调用方没问过的位姿；③两个新引文（Olson ICRA 2009 的标题/会议/年份/页码）是**查证过**的，
但「0.3 是合理阈值」仍然是**本 crate 的策略判断**，不是任何论文的结论；④(e) 的 `InvalidConfig`
**改变了公开错误枚举**（新增一个变体）—— 这是 additive 的破坏性变更：外部若对 `ScanMatchError`
做了穷尽匹配会编译失败，本仓内没有这样的匹配点（已查）；⑤本轮的 `MAX_SCAN_OPERATIONS` 文字只是把
**算术**写对，`scan_match` **仍然没有被计时过**。

## 12. 第九轮审计（REQ-A514）：LK 的梯度模板在自己文档明令禁止的地方 clamp 了，而那条「已被覆盖」的边界分支，其实证明的是那个缺陷（2026-09-19）

前八轮的战场是 `slam/`、`planning/`、`fusion/`、`driver/`。`vision/` 一直只有 `vision_e2e.rs` 从外面
看，没有逐行读过。这一轮读 `lk.rs`（稀疏光流）与 `fast.rs`（FAST-9 角点）。两条真缺陷、一处「覆盖率
是假的」、两处站不住的 `// measured:` 标记、两处没写的文档契约。

**(a) LK 的梯度模板在图像远边界上 clamp —— 与模块文档自己写的「永不 clamp」互斥（真缺陷）**

模块文档的 `Failure modes this module refuses` 第一条明写：越界采样一律标 `Lost`，`rather than
wrapping or clamping (both of which silently invent an edge pixel and bias the flow)`。而梯度路径是：

```rust
let right = prev[(py * width + (px + 1).min(width - 1)) as usize] as i32;
let down  = prev[((py + 1).min(height - 1) * width + px) as usize] as i32;
```

`∂I/∂x` 是**前向差分**到 `px + 1`；窗口右边缘贴到最后一列时 `px + 1 == width`，`.min(width - 1)`
就把最后一个像素**复制一份**当邻居 —— 正是文档禁止的那件事。而这两行算出来的不是残差，是
`A = Σ (∇I)(∇I)ᵀ`，也就是**奇异门判定的那个矩阵**。边界检查原本是 `cx + radius >= width`，它
**允许**窗口最后一列就是 `width - 1`，所以这条路径可达。

可达，但此前**只在一种情形下可观测**：同一特征在迭代第一拍就会在 `bilinear` 处被拒（`px = width - 1`
时 `ix + 1 = width` ⇒ `None` ⇒ `Lost`）—— 除非它的 clamped 梯度矩阵恰好被奇异门拦下，于是结果是
`Singular` 而不是 `Lost`。也就是说这个 clamp 唯一可观测的后果是：**一个窗口贴到远边界的特征，可能
被报成 `Singular`（文案说 "constant patch"），而它真正的原因只是窗口不完整。**

处置：边界检查向远侧**收紧一格**（`cx + radius + 1 >= width`），删掉两处 `.min()`。梯度模板与残差
模板从此有一致的完整性条件，文档那句「never clamp」第一次变成真的。行为差异被局限在「远边界内一格」
那批特征上：它们从 `Lost`-或-`Singular` 统一成 `Lost`。新测试
`a_window_whose_gradient_reaches_the_far_edge_is_lost_not_singular` 用**纯色图**做夹具 —— 纯色图上
clamped 模板**恰好**秩亏（被复制的列梯度为 0），所以旧代码对该特征给 `Singular`；这是唯一能把
「窗口不完整」与「patch 常量」两个原因分开的夹具。

**(b) 同一条 bullet 的第二半，覆盖率是「碰巧」来的 —— 覆盖率证明的不是那个分支，是 (a) 的缺陷**

同一条 bullet 还写了另一半：`*or* at the current fractional estimate in the target` —— 源窗口合法，
但把分数位移 `dx` 加上去之后目标采样越界。这一支由 `bilinear` 返回 `None` ⇒ `Lost` 落实。收紧边界后，
`lk.rs` 的**行覆盖掉了下来**：这一支从「已覆盖」变成「未覆盖」。

原因是旧代码里它是**被 (a) 的缺陷顺带覆盖**的 —— 那些被放行的贴边特征，第一拍就撞在 `bilinear` 的
边界上。换句话说：那条覆盖率**证明的是缺陷本身，不是这一支**。这是「有覆盖 ≠ 有测试」的一个样本，
也是本仓纪律里「不许把覆盖率当证据」的一次实测。

处置：不满足于「反正覆盖过」，去找一条**自然**夹具把它真正钉住。这一支可达需要两件事同时成立：
①第一步步长 ≥ 1 像素 —— 否则 `convergence_eps = 1` 配 `(Δx.abs() + Δy.abs()) as i32` 的**截断**会让它
立刻判收敛，根本不会在非零 `dx` 上采样；②一个窗口左边界落在第 1 列的特征。夹具：**1.5 像素左移** +
特征 `x = 2` ⇒ `1 + (−1.5) = −0.5` floor 到 `−1` ⇒ 越界。同一条测试还有第二臂：断言**同一帧对**上
`x = 6` 正常跟踪（左向 ≈1.5 px）—— 否则「把整条左边界一律拒掉」也能让第一臂通过。

**(c) 两处 `// measured:` 标记，写的是做不出来的测量（溯源缺陷）**

`DET_FLOOR_WEIGHT = 1e-3` 的文档说它「由在纹理图与纯色图上跑 tracker 标定而来」。算术是：`det` 下限
= `weight · min_gradient⁴`，取 `min_gradient = 10` 即 `weight · 10⁴`。要让「纹理图 `det ≈ 1e3` 通过、
纯色图 `det = 0` 不通过」这组事实成立，**任何** `weight ∈ (0, 0.1)` 都可以 —— 横跨八个数量级。所以那个
实验**不可能**选出 `1e-3`；它只是把取值约束到一个区间里，而 `1e-3` 落在区间内。改标 `// chosen:`，
保留**可查证**的那半句（`10⁴ · 1e-3 = 10`），并补上一件原来没说的话：这个下限随 `|∇I|⁴` 缩放（与 `det`
同幂），但**不含窗口尺寸因子**，而 `det` 随像素数增长（`a00 ≈ N·|∇I|²`），所以 `window_radius` 越大、
同一个下限越容易过。

`CONDITION_FLOOR = 1e-6` 的文档说它 `sits between the aperture-problem ratio (~0) and the ratio a
gently-elongated real-image patch produces (≫ 1e-3)`。这句话对**那个区间里的每一个值**都成立（区间本身
横跨六个数量级），所以它不是「`1e-6` 这个值的证据」。改标 `// chosen:`，写明**没有任何图像集被扫过**
来定它，并说清它为什么取在靠「边缘问题」那一侧（宁可错杀一个特征，不要放过一个坏的解）。

两条都**保留原数值**，行为不变。

**(d) 防御性分支：文档化，而不是造一条测试去摸它（补全）**

`fast.rs` 两处 `if let Some(x) = scores.get(idx)` 的 `None` 臂**不可达**：循环范围自己保证了
`idx < w·h == scores.len()`（`x ± 1 ∈ [0, w−1]`、`y ± 1 ∈ [0, h−1]`）。它们以 `.get()` 这种「不 panic 的
索引写法」存在，不是活的检查。按本仓纪律 —— **文档化不可达分支，而不是伪造覆盖** —— 两处各加了边界
证明与「该臂无测试」的说明。`--lib` 里这两行仍计入未覆盖，这是真实的，只是不再是无标注的缺口。

**(e) 顺带补的两处文档契约**

① `optical_flow_sparse` 的缓冲区契约原来**完全没写**：`LkConfig` 没有 `height` 字段，高度由
`len / width` 推出，于是长度不是 `width` 整数倍的缓冲区会被当成**更矮的图**读，**尾部那半行被静默忽略**；
短于一行则 `height = 0`、每个特征都 `Lost`。已写明。②`fast.rs` 的 NMS 文档写「keep only the brightest /
darkest score」，而判据是**严格** `>`，所以**等分的整片平台会整片留下** —— 本模块自己的夹具就是
（饱和方块每个角点都是 255，出来的是几个相邻角点而不是一个）。补上这句，并说明这是**有意**的
（严格胜者与遍历顺序无关 ⇒ 确定性；想要「每个平台取一点」的调用方自己收敛）。这条新写的文档同时补了
测试 `non_max_suppression_keeps_a_plateau_of_equal_scores`：夹具就是那个饱和方块，**突变**（`>` 改成
`>=`）会让整片平台**全部消失**（互相把对方判掉），这正是「严格」与「非严格」的分水岭。

**(f) 负控（逐条注入 ⇒ 变红 ⇒ 原样还原 ⇒ `cmp` 证字节一致）**

| 测试 | 钉住的 | 负控怎么变红 |
|---|---|---|
| `a_window_whose_gradient_reaches_the_far_edge_is_lost_not_singular` | 远边界内一格的窗口是 `Lost`（不是 `Singular`）；再进一格（`x = y = 29`）纯色图仍 `Singular` | M1 把边界检查改回 `cx + radius >= width` 并恢复两处 `.min()` ⇒ FAILED（`got Singular`） |
| `a_corner_whose_arc_crosses_the_ring_seam_is_found`（既有） | 9-弧的必要条件是 4 个基点中**至少 2 个**同号，不是 FAST-12 的 3 | M2 把 `bright < 2 && dark < 2` 改成 `< 3` ⇒ FAILED（`(8,8)` 的过缝角点消失） |
| `a_target_sample_that_leaves_the_frame_is_lost_not_wrapped` | 源窗口合法但目标采样越界 ⇒ `Lost`；同一帧对上 `x = 6` 仍被跟踪（左向 ≈1.5 px） | M3 把该分支的 `Lost` 改成 `Singular` ⇒ FAILED |
| `non_max_suppression_keeps_a_plateau_of_equal_scores` | 饱和方块留下**相邻**的等分平台（≥2 个 255），不是塌成一点 | M4 把 NMS 判据 `>` 改成 `>=` ⇒ FAILED（平台整片消失，`got []`） |

**(g) 覆盖 / 计数**：单元测试 288 → **291**（+3）；集成 29、doctest 11 不变。`--lib` 覆盖
**97.59% region / 97.55% line**，比上一轮的 97.61 / 97.62 **略降** —— 降的原因说清楚：新增的未覆盖行
**全部在 `#[cfg(test)]` 里**（新测试的 `assert!` 失败文案表达式与 `panic!` 臂，只在测试失败时求值，
因此永远计为未覆盖）。**生产代码**本轮**没有新增缺口**：唯一两行未覆盖的生产代码是 (d) 里那两条已
文档化的不可达 `None` 臂。**九个仓门全绿**；其中 `examples-smoke` 在本轮**开工时**失败于**另一个 crate**
（`amos-web3` 的 `sign_and_recover` 示例超时，属并发会话的在制品），与本轮改动无关、本轮未触碰 ——
收尾复跑时那个会话已经修好，**49 个示例全部零退出**；`amos-robot` 自己的两个 example
也分别真跑、零退出。

**诚实边界**：①**(a) 是行为变更** —— 远边界内一格的那批特征从 `Lost`-或-`Singular` 变为一律 `Lost`。
这不是「改文档去迁就代码」，而是把代码改回它**自己文档已经声明**的语义；②(a) 那个 clamp 在旧代码里的
**唯一**可观测后果是上面那种 `Singular`/`Lost` 混判，**不是**「流量被算错」—— 若哪个部署见过贴边特征
给出错误流量，那不是这一处造成的；③(c) 只改标记与理由，**数值一个没动**；④本轮**没有动** `vision/` 的
任何公开签名、错误枚举或线上语义（未新增变体，与第八轮不同）；⑤**没查下去的地方**：NMS 之外的
`min_score` 语义、`lk.rs` 里 `x1/y1` 的 `clamp(0, u16::MAX)` 饱和兜底、`(px + 1)` 在 `width == 0` 时的
`width.max(1)` 派生 —— 这三处读下来**是有意的**（饱和 `clamp` 兜的是 `cx + dx` 可能为负；`height` 是派生物
且已在 (e) 写明契约），没有找到第二处「文档说 A、代码做 B」；⑥(d) 的两行仍未覆盖，本轮只是把它**标注**
出来，没有为了让数字好看而加一条碰它的测试。

## 13. 第十轮审计（REQ-A516）：一次被假注释豁免的空转型，以及一个「零个点在前方」也能拿到的位姿（2026-09-19）

第九轮结尾明确留下 `vision/` 的两个模块没读：`five_point.rs`（本质矩阵 + 位姿恢复）和 `vo.rs`（帧间
VO 胶水）。这一轮读完两者：一条溯源缺陷（假豁免掩盖了空转型）、一条**行为缺陷**（编造位姿）、两处
文档订正、三处补测。

**(a) `sampson_distance` 用 `#[allow]` 豁免了一次真正的空转型，而豁免的理由是一句假话（溯源缺陷）**

```rust
// The intermediate `f64` work (Hartley-style normalised coordinates
// are sub-unit) keeps a meaningful numerator; the trailing cast
// narrows to the function's declared `f32` return.
#[allow(clippy::unnecessary_cast)] // precision narrowing, not a no-op
{
    (num * num / denom) as f32
}
```

`Essential = [f32; 9]`，`a`/`b` 是 `(f32, f32)` ⇒ `eb`/`ea`/`num`/`denom` **全部是 `f32`**，
这里**没有任何 f64 中间量**。所以这句话的每个从句都是错的：没有「intermediate f64 work」，这个
cast 不是「narrowing」，它 `f32 as f32` **就是个空操作**。取证：删掉 `#[allow]` 后
`cargo clippy -p amos-robot --lib` 立刻报 `unnecessary_cast`（并给出 `try: (num * num / denom)` 的
建议）—— 也就是说这个 `#[allow]` 一直在压一条**真的** lint。

处置：删 cast、删 `#[allow]`、把注释改成事实（每个中间量都是 `f32`，删掉不改变任何 bit）。

**(b) `recover_pose_from_essential` 会给一个「没有任何对应点落在双相机前方」的矩阵编出一个位姿（行为缺陷）**

候选循环是：

```rust
let mut best = (0usize, 0u32);
for (idx, (r, t)) in candidates.iter().enumerate() {
    let in_front = cheirality_count(a, b, r, t);
    if in_front > best.1 { best = (idx, in_front); }
}
```

`best` 用 `(0, 0)` 初始化。当**四个** `(R, t)` 候选的 cheirality 计数**全是 0** 时，没有任何
`in_front > 0`，于是 `best` 停在初始值 —— 函数返回 `candidates[0]`，一个**未经任何证据支持**的
位姿。探针实测（零本质矩阵 + 8 对点）：`Some(Pose2D { rotation: […], translation: [0.0, -1.0, 0.0],
inliers: 0, total: 8 })`。这正是本模块 `essential_matrix_eight_point` 文档里拒绝的那种
「plausible-looking but meaningless」输出，只不过发生在另一个入口。

处置：候选循环后加 `if best.1 == 0 { return None; }`，并在函数文档里写明这条契约（初始 `candidates[0]`
只是「在有得分者之间」的 tie-break；零分意味着这个矩阵什么都解释不了）。新测试
`a_pose_with_no_in_front_correspondence_is_refused`。

**(c) 模块文档把「Hartley 预条件」说成「按内参归一化」，并把「精度相当」说得比文献强（溯源订正）**

原文：八点法「is what almost every aerospace implementation uses as a sanity check … and what the
literature reports as equally accurate once the points are normalised by the intrinsics」。三点问题：
①「几乎所有航天实现都拿它做 sanity check」是关于实践的无从查证的断言；②文献里的归一化是
**Hartley 预条件**（本文件 `precondition`：平移到质心、缩放到均方根距离 √2），**不是**「按内参
归一化」，两者是两件事；③「与五点法精度相当」强于文献结论。

改为准确表述并给出可查来源：Hartley, *In Defense of the Eight-Point Algorithm*（PAMI 19(6):580–593,
1997）的结论是八点法在**平移+缩放的规范化之后**才与最佳迭代法相当（规范化正是修好线性系统条件的
那一步）；五点法的优势集中在最小样本（恰好 5 点）与平面/退化构型，而本 crate 的 RANSAC-`n ≥ 8`
路径（采样 8、对全体 `n` 打分）不涉及这些。Nistér 的引用核过：**CVPR 2003**（DOI
`10.1109/CVPR.2003.1211470`）—— 原文写的 venue 是对的，未改。

**(d) `Pose2D::inliers` 字段在两条入口下语义不同 —— 写明，而不是假设读者知道（文档订正）**

`recover_pose_from_essential` 往 `inliers` 里放的是 **cheirality 计数**（有多少对应点在双相机前方），
`ransac_essential` 则用 `best_inliers`（**Sampson 内点数**）覆盖它。同名字段、不同量。字段文档原写
「The number of inlier correspondences that supported this pose」，对直接调用恢复函数的那条路径是错的。
改为写明「含义由生产者决定」并分列两条入口。

**(e) 三处补测（含一处生产边界）**

①`a_pose_with_no_in_front_correspondence_is_refused`（见 (b)）；②
`perpendicular_returns_a_unit_vector_orthogonal_to_the_input`：`perpendicular` 的三条 basis 臂此前
两臂未覆盖，测试用 `[0,0,1]`/`[0,1,0]`/`[1,0,0]`/`[0.6,0.7,0.1]` 分别驱动三臂，断言结果**单位、
与输入正交** —— 如实说明它钉的是**结果**而非「选了哪条臂」（三条臂都返回合法垂线，差别只是与所叉
基向量的接近度，那是条件数取舍）。③`vo::replenish_never_exceeds_the_cap`：`replenish` 的
`break` 只在传入的特征集**非空**时才会触发（`track_frame_to_frame` 正是带着幸存者调用它），既有测试
都用空集，从未走到；新测试传入已满 256 的集合，断言不会超过上限。

**(f) 负控（逐条注入 ⇒ 变红 ⇒ 原样还原 ⇒ `cmp` 证字节一致）**

| 测试 | 钉住的 | 负控怎么变红 |
|---|---|---|
| `a_pose_with_no_in_front_correspondence_is_refused` | 没有任何点在前方的矩阵 ⇒ `None`，不是编出的 `candidates[0]` | M2 删掉 `if best.1 == 0 { return None; }` ⇒ FAILED（零矩阵又返回 `Some`） |
| `perpendicular_returns_a_unit_vector_orthogonal_to_the_input` | 垂线是单位向量且与输入正交 | M3 去掉 `perpendicular` 末尾的归一化（`c` 直接返回）⇒ FAILED（`[0.6,0.7,0.1]` 那条长度 0.922） |
| `vo::replenish_never_exceeds_the_cap` | `replenish` 到上限即停 | M4 把 `features.len() >= MAX` 短路成 `false`（去掉 `break` 效果）⇒ FAILED（集合超出 256） |

（`sampson_distance` 的 (a) 无测试：删 cast 是**空操作**，无 bit 变化，行为类测试覆盖不到它；它的
证据是 `cargo clippy --lib` 删 `#[allow]` 后报 `unnecessary_cast`。）

**(g) 覆盖 / 计数**：单元测试 291 → **294**（+3）；集成 29、doctest 11 不变。`--lib` 覆盖
**97.62% line / 97.64% region**。生产代码本轮唯一仍未覆盖的行是 `five_point.rs` 里 RANSAC 的
自适应提前退出 `break`：要触发它需「在一次运行中于第 `it > required` 次迭代才找到更优模型」，
在随机洗牌下无法确定性构造 —— **不编造 fixture**，如实登记。**九个仓门全绿**。

**诚实边界**：①**(b) 是行为变更** —— 之前会给 `Some` 的退化输入现在给 `None`；这是把「编造」改成
「拒绝」，与 `essential_matrix_eight_point` 一向的契约**对齐**，不是改文档迁就代码；②(b) 的守卫是
**强条件**（四个候选**全部**零分），真实一致几何下 cheirality 计数远大于 0，正常路径不受影响；
③(a) 的改动**不改变任何 bit**（`f32 as f32` 恒等）；④本轮**没有动** `vision/` 的任何公开签名或错误
枚举（`Pose2D` 字段未增删，只改文档）；⑤**没查下去的地方**：`MAX_TRACKED_FEATURES` 的 256 与
`MIN_TRACKED_FEATURES = 128` 这两个数值的来历（doc 里那句「128 以下 RANSAC 内点集太小」是**理由**
不是**测量**，本轮未重新标定）、`VO_INLIER_THRESHOLD = 1e-3` 与 `VO_RANSAC_ITERATIONS = 200` 同理；
`precondition` 里 `avg_dist ≈ 0` 时退回 `scale = 1.0` 的兜底（读下来是有意的，防止除零）。

## 14. 第十一轮审计（REQ-A520）：一轮没改一行行为的审计——DWA 章节的文档失真，加上六个从没被任何门拦过的 rustdoc 断链（2026-09-19）

**范围**：第十轮结尾点名、但从未逐行读过的 `planning.rs`（尤其 `dwa` 动态窗口段）；读的过程中
顺手跑了本 crate 此前**从未被任何门覆盖**的一个维度——rustdoc 健康度，于是本轮由「文档失真」扩成
「文档失真 + 六个断链」。

**(a) 缺陷一：`planning.rs` DWA 段的文档失真（纯文档，零行为改动）**

| # | 原文 | 事实 | 处置 |
|---|---|---|---|
| 1 | 模块文档称「the **four** `DWA_W_*` constants」 | 只有**三个**（`DWA_W_PROGRESS` / `DWA_W_CLEARANCE` / `DWA_W_SPEED`） | 改成 three |
| 2 | 「the three numbers … **in [`score`]** …」——`[`score`]` 指向一个**不存在**的符号 | 全文件无 `fn score` / `struct Score`（`grep` 证）；打分是 `dwa` 内联的 | 去掉断链，改内联文字 |
| 3 | 「a deployment … **tunes them in [`DwaLimits`]**」 | 三个权重是 **`const`，不是 `DwaLimits` 的字段**；`DwaLimits` 里根本没有可调权重的旋钮 | 改为「by vendoring this function, not by tuning a limit」 |
| 4 | 「a velocity pair in the machine's own units **(m/s, rad/s)**」 | 实际是 **mm/s、millirad/s**（`DwaVelocity` 的字段名就是 `v_mm_s` / `omega_mrad_s`） | 改成 mm/s, millirad/s |
| 5 | `DWA_CLEARANCE_MARGIN_MM` 文档与 `dwa` 内联注释称「a log that prints the candidate still sees **the real gap**」／「still records them as `safe: false` **so a log can see them**」 | **假**：不安全的候选**从不被存进 `best`**，它的 gap 没有任何出口（只有**被选中**的候选的 clearance 会被返回） | 常量文档与内联注释都改成事实：不安全候选的 gap **对下游不可观测**（含日志） |
| 6 | Honest boundaries 曾写「**No replan** … **The route is fixed input**」 | 自相矛盾——`dwa` **根本不接收 route**，它手里只有 goal 单元格 | 改成「No replan, no route」，写明 route-following 由**调用者**把下一航点当 `goal` 传入 |
| 7 | `DwaLimits` 的 **struct 文档**实际在描述 `dwa` **的参数**，且断言「it pulls the goal toward the pursuer」 | 错位且**不成立**：`dwa` 只收 goal 单元格，是**调用者**在拉 | 把参数说明搬到 `dwa` 的函数文档，`DwaLimits` 只写正确的一句话 |

**一个被撤销的引用**：原 `DWA_W_CLEARANCE` 挂的是 Fox/Burgard/Thrun (1997) 的引用，读起来像
「这三个数来自论文」。核对之后**引用不成立**：论文的目标函数是
`σ(α·heading + β·dist + γ·velocity)`——**clearance（`dist`）的权重是 β，不是 α**，而且论文
**没有给出 α/β/γ 的任何数值**。故三个权重改标 `// chosen:`，并写明 `1.0 : 0.1 : 0.3`
（progress : clearance : speed）是**本 crate 自己的相对权重——一个比值，不是度量**。

**(b) 缺陷二：六个 rustdoc 断链——一项从未存在过的检查**

本轮顺手跑 `RUSTDOCFLAGS="-D warnings" cargo doc -p amos-robot --no-deps`，**它失败**，六个 error：

| 位置 | 断链 | 为什么 |
|---|---|---|
| `driver/can.rs` | `` [`LinkError::Transport`] ``、`` [`LinkError::Robot`] `` | `LinkError` **不在该模块作用域**（代码里写的是全限定 `amos_link::error::LinkError`） |
| `slam/loop_closure.rs` | `` [`MIN_MATCH_RATIO`] ``、`` [`MIN_COST_DROP`] `` | 二者是 **private `const`**，公开文档链不到私有项 |
| `slam/loop_closure.rs` | `` [`axis_offset`] `` | 私有函数 |
| `slam/occupancy.rs` | `` [`index`](Self::index) `` | `index` 是私有方法 |

全部**只改链接形式**（补全限定路径 / 降为纯代码文本），**不动任何代码**。修后
`cargo doc -D warnings` **从红到绿**。

**(c) 一个从未存在的门**

`grep` 确认 `.github/workflows/`、`Makefile`、`scripts/` 里**没有任何一处**跑
`cargo doc` / `rustdoc`。也就是说上面六个断链可以在仓库里躺任意久而无人发觉。本轮**没有**擅自给
CI 加门（CI 是全仓共享面，且本仓正被多个会话同时编辑），只把它作为**建议**登记：
`cargo doc -p amos-robot --no-deps` 配 `RUSTDOCFLAGS=-D warnings` 是一条零成本、纯增量的门。

**(d) 计数 / 证据**

- 本轮**未改动任何行为**，故单元测试**仍 294**（**+0**），集成 29、doctest 11 不变——这是**如实的 0**，
  不是漏跑。
- `--lib` 覆盖 **97.62% line / 97.64% region**（与第十轮相同，符合「只改文档」）。
- `cargo clippy -p amos-robot --all-targets --no-deps -- -D warnings` **0 警告**；`cargo fmt --check`
  净；`RUSTDOCFLAGS="-D warnings" cargo doc` **绿**（本轮新增的检查）。
- **九个仓门全绿**。

**诚实边界**：①本轮是**纯文档轮**——没有任何行为变更，因此**没有任何可注入的负控**（对文档句子做
mutation 不会让测试变红；声称「负控通过」才是造假）；②**(c) 的门没有加**——CI 是共享面，我把它留作
建议而不是单方面改动；③**没查下去的地方**：`dwa` 里 `best` 的并列打破是 `candidate.value > b.value`
（严格大于），意味着**并列时保留先出现的候选**；候选按 `v` 递增枚举，故并列偏好**更低的 v**——这是
**读出来的行为，未被任何测试钉住**，本轮未加测试（构造精确的浮点并列代价高而收益低），如实登记；
④`dwa` 返回的 `DwaVelocity` 用 `v as i32` / `w as i32` **截断**了一个曾用于打分的 `f64`——即
**打分用未截断值、返回用截断值**，两者可能差 <1 mm/s；这是精读发现，本轮**未改**（改动会动行为，
超出纯文档轮的范围）。

## 15. 第十二轮审计（REQ-A523）：旗舰模块 `fusion.rs` 的三处站不住的溯源标记、一次错误的论文归属，以及一条「只在未言明的增益下才复现」的 `measured:`（2026-09-19）

**范围**：`fusion.rs` —— 本 crate 的旗舰模块（1834 行，Mahony 6-DOF 姿态估计 + 9 轴磁力计 +
Allan 方差健康监视）。它是 README 第一个介绍的模块，却从未有过一轮专门的逐行审计。本轮读完全文件
（含两个测试模块），发现的是**文档与溯源标记**层面的缺陷：没有一行行为被改。

**(a) 缺陷一：一个**不存在**的类型**

9 轴扩展段的注释（§"9-DOF fusion extension"）原先写：

```text
//   * `MagReference::Referenced` — the YawReference enum gets a third variant that
```

`MagReference` 在本 crate 里**不存在**（`grep` 全仓只有这一行）。磁力计变体挂在 `YawReference`
上，叫 `Magnetic`。已改为 `` `YawReference::Magnetic` `` 并注明旧写法指向不存在的类型。

**(b) 缺陷二与三：两个站不住的溯源标记**

| 位置 | 原标记 | 事实 | 处置 |
|---|---|---|---|
| `ALLAN_MIN_WINDOW` | `// cited:`「the overlapping Allan variance divides by `2·(N − 1)`…」 | 它**没有引用任何来源** —— 它是 `variance` 函数体里那条公式的**推论**，不是外部文献 | 去掉 `// cited:`，写明这是推论，公式本体就在 `variance` 里 |
| `ALLAN_DEFAULT_NOMINAL_RAD_S` | `// measured: a typical MEMS-class gyro noise floor.` | **本 crate 从没标定过任何陀螺仪**；`record`/`variance` 只吃调用方喂进来的数 ⇒ 这里**不可能**有测量。「typical MEMS-class」是一个**惯例说法**，不是测量结果 | 改标 `// chosen:`，写明它是可被部署方按自家 datasheet 覆盖的**起始默认值** |

（第二条与第九轮在 `lk.rs` 上发现的「不可证伪的 `// measured:`」是同一缺陷类：标记声称了一次
并不存在的实验。）

**(c) 缺陷四：一次论文没做过的归属**

`DEFAULT_KI` 挂着：

```rust
// cited: Mahony, Hamel & Pflimlin (2008); a `Kp:Ki` ratio near 20 decouples the bias
// estimate from the (faster) attitude loop.
const DEFAULT_KI: f32 = 0.05;
```

**核对结果**：Mahony, Hamel & Pflimlin, *Nonlinear Complementary Filters on the Special Orthogonal
Group*（IEEE TAC 53(5):1203–1218, 2008；DOI `10.1109/TAC.2008.923738`）确实给出了姿态校正律与
陀螺零偏估计器，但它只给稳定性条件（`k_p, k_I > 0`），**没有给出任何数值比**。同一算法的公开发现在
增益比上差了两个数量级（RAHRS / Madgwick 实现用 `Kp = 2, Ki = 0.005`，比值 **400**）。而这里的
`20` 就是本 crate 自己的 `DEFAULT_KP / DEFAULT_KI = 1.0 / 0.05`。**改法**：`DEFAULT_KI` 改标
`// chosen:`，把「比值 20」明确为本 crate 的选择；`DEFAULT_KP` 的 `// cited:` 保留（**算法**确实
是那篇论文的）但把「**数值** 1.0 是本 crate 选的、论文只约束正负」与「『~1 s』只是 `1/Kp` 的复述、
不是论文数字」分开写清。这与第十一轮 DWA 段撤销 Fox/Burgard/Thrun 归属是同一缺陷类。

**(d) 缺陷五：一条只在未言明增益下才复现的 `measured:`**

模块文档「诚实边界 6」（重力校正会漏进未参考的偏航）写着：

```text
(measured: 3.3° over a 6 s recovery from a 25°/15° step)
```

**探针实测**（200 Hz，重复该实验）：

| 增益 | 6 s 后的偏航 |
|---|---|
| **默认**（`Kp = 1.0, Ki = 0.05`） | **3.62°** |
| 纯比例（`Ki = 0`） | **3.3267° ≈ 3.33°** |

也就是说 `3.3°` 这个数字**只在 `Ki = 0` 时**成立，而文档**没有说增益**；一个用默认估计器复现的
读者会得到 `3.62°`。已把该句改为写明 **proportional-only（`with_gains(1.0, 0.0)`）**，并注明默认
`Ki` 会给 `3.62°`、差别来自积分项在那个瞬态里学到的一个伪零偏。**顺带补测**：
`a_skewed_gravity_correction_moves_the_unreferenced_yaw` 把这个数字钉住，并钉住它属于**斜置**
（roll、pitch 同时非零）的情形 —— 同一测试上方那条纯 roll 的臂断言偏航 ≈ 0（校正轴就是机体 *x*）。

**(e) 缺陷六：一条未登记的不可达防御分支**

`gravity_reference` 的首个条件是 `!norm.is_finite() || norm <= WEIGHTLESS_G · g`。左半**不可能
为真**：它唯一的调用者是 `update`，而 `update` 在此**之前**已经用 `sample.is_finite()` 挡过；
`accel_norm_m_s2` 的唯一实现在三元组有限时返回真实的平方根 ⇒ `norm` 恒有限。按本仓纪律
（**文档化不可达分支、不伪造覆盖**）已就地写明它是防御性的、当前不可达、以及**为什么仍然保留**
（`norm` 的有限性是**兄弟函数**的性质；若 `accel_norm_m_s2` 哪天不再守卫，`NaN` 会把两个比较都
落空并被拿去做除数）。可达的那一半是失重下限。

**(f) 负控：如实记录一次「注入不变红」**

新测试 `a_skewed_gravity_correction_moves_the_unreferenced_yaw` 钉的是 `3.33°`。按纪律逐条注入
负控，**三条都没有让它变红**：

| 负控 | 结果 |
|---|---|
| M1 把 `Kp` 项整体乘 `0.9` | 仍绿 |
| M2 把叉积的机体 *z* 分量清零 | 仍绿 |
| M3 把 **世界系**角速度当成机体系积分（`quat_mul` 两侧对调） | 仍绿 —— 数值只从 `3.3267283°` 动到 `3.3267329°`（第 **6** 位小数） |

结论：这个「漏进偏航」的量是**收敛后姿态的几何函数**（把重力对齐的那个旋转的偏航分量），对
**路径**几乎不敏感。因此该断言是**钉结果**、不是**钉分支** —— 测试文档已如实改写为「它会在
**重力对齐几何**改变时变红，而不是在某条分支上变红」，而不是硬说负控证明了分支。这正是本仓
「mutation 不变红就改写文档说明它钉的是结果」的纪律，**负结果照记，不藏**。

**(g) 计数 / 证据**

- 单元测试 294 → **295**（+1：`a_skewed_gravity_correction_moves_the_unreferenced_yaw`）；集成
  29、doctest 11 不变。
- `cargo clippy -p amos-robot --all-targets --no-deps -- -D warnings` **0 警告**；`cargo fmt --check`
  净；`RUSTDOCFLAGS="-D warnings" cargo doc -p amos-robot --no-deps` **绿**。
- `--lib` 覆盖 **97.62% line / 97.64% region**（与上一轮相同）。
- **九个仓门全绿**。

**诚实边界**：①本轮**改了行为的地方只有新增的测试**，生产代码一行未动（全部改动是文档与标记）；
②**(d) 的 `3.3°` 仍然是那句原文的数字**，我没有把它改成 `3.62°` —— 因为 `3.33°` 在**写明增益**后
是真的，改数字会丢掉原作者实际测的那个量；③**(f) 的三条负控都失败**，这是本轮最该记住的事实：
一个「数字被钉住」的测试不自动等于「分支被覆盖」；④**没查下去的地方**：`MAX_DT_S = 0.25` 的
「200 Hz 步长的十倍、剖面表最短看门狗 50 ms 的五倍」是**理由**不是测量（未重新标定）；
`ACCEL_MIN_G = 0.75` / `ACCEL_MAX_G = 1.25` / `WEIGHTLESS_G = 0.1` 三个窗口的来历同理；
`update_with_mag` 里「磁力计偏置表现为 `Magnetic` 上的固定偏航偏移」是**叙述**，本轮没有为它造夹具；
⑤`fusion` 仍是 6-DOF 无协方差（边界 3 未变），本轮**没有**把任何 EKF 接进来。

## 16. 第十三轮审计（REQ-A527）：一个只在 `am = −1` 才成立的参考模型，以及三处与自家夹具相矛盾的注释（2026-09-19）

**范围**：`mrac.rs` —— Model-Reference Adaptive Control（Narendra–Valavani）+ 带抗积分饱和
的 PID。它有专门的集成套件（`tests/mrac_lyapunov.rs`），却从未有过一轮专门审计。本轮**不是**
纯文档轮：改了一行生产行为（参考模型），并加了一个测试。

**(a) 缺陷一：参考模型只在 `am = −1` 上是对的**

模块文档给的形状：

```text
ẋ  = am · x + bm · (u + θ · ω)   // plant
ẋm = am · (xm − bm · r)          // reference model  ← 缺陷在这里
u  = r − θ̂ · ω                    // control law
θ̂̇  = −γ · ω · e · p · bm          // adaptation law (Lyapunov-proved stable)
```

参考模型应当是**未知量匹配时的被控对象本身**（`θ̂ = θ` ⇒ 控制律给出 `u = r` ⇒
`ẋ = am·x + bm·r`），也就是标准的 `ẋm = am · xm + bm · r`。而这里写的是
`am · (xm − bm · r)`。两者**仅在 `am = −1` 时相等**（此时 `−(xm − r) = −xm + r`）。

后果有三层：

1. **论文里的 Lyapunov 论证不成立。** 在两个形式不相等时，误差动态里多了一个**持续的**
   `−bm·r·(am + 1)` 项（`ė = am·e + bm·θ̃·ω − bm·r·(am + 1)`），`V̇ = 2·am·p·e² −
   2·p·bm·r·(am+1)·e` 不再 ≤ 0。而模块文档正以这条论证作为「stable」的理由，第 ③ 步的注释
   也写着 `(Lyapunov: V̇ ≤ 0; standard MRAC proof.)`。
2. **`θ̂` 不再收敛到未知量 `θ`，而是收敛到一个带偏的值。** 稳态解为
   `θ̂ → θ + r·(am + 1)/ω`；当回归向量取 `ω = x`（夹具的用法，`x → bm·r`）时，偏置恰为
   `(am + 1)/bm`。
3. **`e` 仍会趋于 0**，因为自适应项把这个偏置「吸收」进 `θ̂` —— 这正是它难以被发现的原因：
   控制器看上去仍在跟踪。

**探针实测**（临时用例，`dt = 0.02`，2000 步，`bm = 1`，真值 `θ = 0.5`，`r = 1`，`ω = x`；已删）：

| `am` | 真值 `θ` | 旧模型的 `θ̂` | 预测偏置 `(am+1)/bm` | 修正后模型的 `θ̂` |
|---|---|---|---|---|
| −1 | 0.5 | 0.500000 | 0 | 0.500000 |
| −2 | 0.5 | **−0.500000** | −1 | 0.498371 |
| −3 | 0.5 | **−1.500000** | −2 | 0.349266（仍在收） |

第三行 `θ = 0` 的对照也一致：`am = −2` 时旧模型给 `θ̂ = −1.000000`。

**(b) 为什么一直没被发现**

`MracController::new` 对不合法的 `am`（非有限或 `≥ 0`）**回退到 `am = −1.0`**；本模块的
单元测试、`tests/mrac_lyapunov.rs` 的四个用例，**全部**用 `am = −1.0`。也就是说：唯一的
默认值恰好是那个「两个形式碰巧相等」的极点。缺陷藏在夹具的盲区里。

**(c) 修法：改成标准参考模型**

```rust
// ① Reference model: ẋm = am · xm + bm · r — the plant at θ̂ = θ, where the control
//    law delivers `u = r` and `ẋ = am·x + bm·r` *is* this model.
self.xm = self.xm + dt_s * (self.am * self.xm + self.bm * r);
```

**在 `am = −1` 上这两个式子的数值逐位相同**，所以现有 16 个 `mrac` 单元测试与全部集成用例
**一个都没变**（负控 M1 证实了这一点，见 (e)）。模块文档的公式、`am` 字段的「随时间常数
`1/|am|` 趋于 `−bm·r/am`」、第 ③ 步的 Lyapunov 注释都已同步改正。

**(d) 三处与自家夹具相矛盾的注释**

| 位置 | 原文 | 事实 | 处置 |
|---|---|---|---|
| `Pid::new` | "A controller with no anti-windup, no output limits, and **`kp = 1.0`**." | `kp` 是**参数**，不是常数；测试 `the_derivative_term_does_not_kick_on_the_first_sample` 就传 `kp = 0.0` | 改为「你传入的三个增益 + 无抗饱和 + 无输出限幅」 |
| `MracController.omega` 字段 | "Last ω (regression vector) — **needed for the next step**." | 下一步 `step` **自带** `omega` 参数；该字段在算法里**从未被读**，只有 `summary()`/`reset()` 用 | 改为「仅供遥测，下一步不吃它」 |
| 测试 `a_plant_with_a_zero_unknown_is_tracked_perfectly` 注释 | "With **am = bm = 1** (and the unknown θ = 0), the reference model and the plant are identical" | 夹具写的是 `let am = -1.0;` —— 而且 `am = +1` 会被构造函数**拒绝**（极点必须为负） | 改为 `am = −1, bm = 1` 并注明 `am = +1` 不是稳定参考模型 |

另外两处顺带收紧：

- `p` 字段：「We use the **closed-form** `P = b·b/(2·|am|)`」——`P` 解的是标量 Lyapunov 方程
  `2·am·P = −Q`，**任意 `Q > 0`** 都给出一个合法解；本 crate 只是固定了 `Q = bm²`。已写明这是
  `// chosen:` 而非**唯一**的闭式解。
- `gamma` 字段的「`0.5 .. 5.0` 是典型范围」——挂上 `// chosen:`，写明这是本 crate 夹具的起手
  区间，所引论文只约束 `γ > 0`。
- **两处挂在已删代码上的 `measured:`**（投影算子段与 `tightening_the_bound_...` 的测试文档，
  都写着「measured: θ̂ = −100 … 20 步之后停在 −96」）—— 那描述的是**已经删掉**的那条分支，
  对着现行实现**无法再复现**。已改为普通叙述，并说明「该图现在钉的是修正后的行为」。

**(e) 负控：如实记录**

新测试 `the_estimate_converges_to_the_true_unknown_at_a_pole_other_than_minus_one`
（`am = −2`，钉 `θ̂ → 0.5`）按下述负控逐条注入：

| 负控 | 结果 |
|---|---|
| M1 把参考模型改回旧式 `am·(xm − bm·r)` | **恰好一条变红**（新用例），其余 16 条 `mrac` 用例全绿 —— 这正是「修正在 `am = −1` 上零行为变化」的可观测证据 |

改动以 `cp` 逐字节还原，`cmp` 校验 `RESTORED-BYTE-IDENTICAL`。

**(f) 计数 / 证据**

- 单元测试 295 → **296**（+1）；集成 29、doctest 11 不变。
- `cargo clippy -p amos-robot --all-targets --no-deps -- -D warnings` **0 警告**；`cargo fmt --check`
  净；`RUSTDOCFLAGS="-D warnings" cargo doc -p amos-robot --no-deps` **绿**。
- `--lib` 覆盖 **97.61% line / 97.63% region**。
- **九个仓门全绿**。

**诚实边界**：①本轮**改了生产行为**（参考模型的积分式），不是纯文档轮 —— 但改动在 `am = −1`
上**数值逐位不变**，且 `mrac` 是**库代码**（边界 2：`ControlLoop` 与示例都不消费它），所以影响面
限于本 crate 的库本身；②**`θ̂` 偏置在 `am = −1` 之外才出现**，而 `am = −1` 既是构造函数回退值
又是全部夹具的取值 ⇒ 若某部署只按默认/示例使用，**它从未见过这个缺陷**，本轮修的是一个**尚未
在夹具里暴露过的**错误；③**未做完的事**：`am = −3` 的修正后收敛在 2000 步内只到 `0.349`（趋势
正确但未收敛到位），新测试因此**只钉 `am = −2`**；④模块文档里 `(Narendra–Valavani, 1978)`、
`(Ioannou & Sun, Robust Adaptive Control, §4.3)`、`(Åström & Hägglund, 2006)` 与
`(Astolfi & Marconi, 2015; Hovakimyan & Cao, 2010)` 四处引用本轮**只核了它们与代码的对应关系，
没有逐本核对页码/章节**（前几轮对论文的核对集中在能直接证伪的数值断言上，这四处没有数值断言）；
⑤**PID 的抗饱和、导数首拍抑制、输出双轨限幅**本轮只读不改（它们的 `measured:` 图可复现：
`u = −1000` 就是 `−kd·pv/dt` 的算术结果）；⑥`MracController::step` 的「非有限 ⇒ safe-off
且不动状态」与本仓 `unknown is never fabricated` 一致，未发现缺陷。

## 17. 第十四轮审计（REQ-A531）：一条声明了不存在的线上格式的枚举、四个冒充测量的策略默认值，以及一次对着「只有位置门」的模块引用的姿态门（2026-09-20）

**范围**：`safety.rs` —— 总线前的最后一层（心跳 + 五条规则 `R1`..`R5` + 有界故障环），
有专门的注入套件 `tests/safety_inject.rs`，却从未有过一轮专门审计。本轮是**纯文档/标记轮**：
**一行行为都没有改**，单元测试 **+0**。

**(a) 缺陷一：一个声明了不存在的线上格式的枚举**

`FaultCode` 的枚举文档写着「The discriminant is part of the wire format — operators grep on
it.」事实是：

- `FaultCode` **没有**派生 `Serialize`/`Deserialize`（只有 `Clone, Copy, Debug, PartialEq,
  Eq, Hash`）；
- 全 workspace `grep` 下来，`FaultCode` 只出现在 `src/safety.rs`、`src/lib.rs` 的一行
  `pub use`，以及 `tests/safety_inject.rs` —— **没有任何代码读它或写它**，因此**不存在**所谓
  线上格式；
- 真正可被 grep 的是 **key 字符串**（`"R1"`..`"R5"`，`key()` 的文档也正确地写的是 logs/UI），
  而不是判别值。

已改为写明「**key** 才是稳定标识，本枚举没有线上格式」。

**(b) 缺陷二：`MAX_FAULT_LOG` 的两个数字**

原文：「256 is the smallest power-of-two that covers a 100 Hz loop's first ~2.5 s of cascading
faults — long enough to write a log, short enough that an `Index` is `u8`.」

- 「an `Index` is `u8`」**两处都不成立**：`256` 装不进 `u8`（上限 255），而且本模块**根本
  没有** `u8` 索引 —— `fault_log` 是 `VecDeque<FaultRecord>`，`fault_log_len()` 返回 `usize`。
  （`grep u8 src/safety.rs` 只命中这一行注释。）
- 「~2.5 s of **cascading** faults」只在**每拍一个故障**时成立（250 拍）。而本模块自己的
  测试 `the_fault_log_is_bounded_and_says_so` 记录的正是**级联**：`max_streak` 一经超过，
  `R3` 与 `R2` 就在**同一拍**各发一条 ⇒ 每拍 2 条 ⇒ 256 条只覆盖 **~1.3 s**。

已写明「一拍一条 ⇒ ~2.5 s；级联 ⇒ ~1.3 s」，并注明索引是 `usize`、不是 `u8`。

**(c) 缺陷三：四个冒充测量的策略默认值**

四个 `DEFAULT_*` 常量都挂着 `// measured:`，但本 crate **没有测量过任何故障率、任何牵引模型**：

| 常量 | 原标记 | 事实 | 处置 |
|---|---|---|---|
| `DEFAULT_HEARTBEAT` | `// measured:` 250 ms | 「25 拍」是算术；「长到能扛过调度抖动、短到能抓住停摆」是**policy** | 改 `// chosen:` |
| `DEFAULT_MAX_DIVERGENCE_RAD` | `// measured:` | **同一句话里就写着「chosen as」**，标记与文字自相矛盾 | 改 `// chosen:` |
| `DEFAULT_MAX_STREAK` | `// measured:` | 「一个是噪声，三个是趋势」是谚语，不是测量 | 改 `// chosen:` |
| `DEFAULT_MAX_TILT_RAD` | `// measured:` | 「地面车辆牵引模型失效处」在本仓**无处求值**，且无引用 | 改 `// chosen:` |

这与第十二轮在 `ALLAN_DEFAULT_NOMINAL_RAD_S` 上发现的「不可证伪的 `// measured:`」是同一
缺陷类。

**(d) 缺陷四：一次对着「只有位置门」的模块引用的姿态门**

`DEFAULT_MAX_DIVERGENCE_RAD` 的文档原写：0.2 rad 是「the pose disagreement a small attitude
error in the fusion estimator can reach before **the SLAM frontend's own gate** would reject
it」。核对 `slam/data_assoc.rs`：那里的门是**平方 Mahalanobis** 距离对 `χ²(2)` 95% 分位
（`ASSOC_*`），量纲是**位置**，**不含任何弧度阈值**。`slam/` 里唯一与 0.2 重合的是
`loop_closure::range_theta_rad = 0.2`，而那是扫描匹配的**搜索窗半宽**，不是**拒绝门**。
已改为「本 crate 的策略」，并把这条被撤销的引用写明。

**(e) 缺陷五：一次被误用的标准引用**

`MAX_DIVERGENCE_LIMIT_RAD`（= π）原挂 `// cited: an angle's range is bounded by 2π (ISO
80000-3)`。核对（WebSearch）：ISO 80000-3 是 *Quantities and units — Part 3: Space and time*，
它给 **plane angle** 的名称/符号/定义/单位（表 1 第 **3-5** 项，`α = s/r`）与弧度 —— 它
**没有**规定「角度的取值被 2π 限制」，而且按 `α = s/r` 定义的平面角**本来就不被 2π 限制**
（可以绕多圈）。这里真正需要的是「两个航向的**分歧取短边** ⇒ ≤ π」，那是本 crate 对
「分歧」的**定义**，不是标准条文。已改标 `// chosen:` 并把撤销的引用写清。

**(f) 缺陷六：一个不可能发生的 `R5` 情形**

`FaultCode::SanityFailed` 的变体文档把「a set point that is **non-finite**」列为 `R5` 的
触发情形。但 `check_set_point` 的入参是 `i32` —— **恒有限**，该情形**不可能发生**；而模块
头的规则表（第 27 行）正是**正确地**没把它列进去。两处自相矛盾。按本仓纪律（**文档化不可达
情形、不伪造覆盖**）已就地写明它不可能发生，并指出与模块头表格的矛盾。

**(g) 缺陷七：一个把「设计位置」写成「运行位置」的开场句**

模块文档首句自称「the **last** layer before the bus ... the only one that can refuse a frame
after the controller has signed off」。但全 workspace 里 **没有任何代码调用**
`SafetyMonitor`（只有 `lib.rs` 的 `pub use` 与注入测试），`ControlLoop` 与示例都不消费它
（crate README 边界 2 把它列在「库代码」里）。而且**拒绝动作本身是调用方的**：监视器只
*报告*（`heartbeat` 返回 `Vec<FaultRecord>`、`check_set_point` 返回 `Option<FaultRecord>`）。
已新增一节「What is not wired」，把首句读作**意图**而非运行管线的描述。

**(h) 计数 / 证据**

- 单元测试 **296（+0）**（纯文档轮，**如实记零**）；集成 29、doctest 11 不变。
- `cargo clippy -p amos-robot --all-targets --no-deps -- -D warnings` **0 警告**；`cargo fmt
  --check` 净；`RUSTDOCFLAGS="-D warnings" cargo doc -p amos-robot --no-deps` **绿**。
- **九个仓门全绿**。

**诚实边界**：①本轮**没有改任何行为**，**没有新增测试** —— 七个缺陷全部落在注释、标记与
文档上，这是**如实零**，不是遮掩；②**没有**为 (f) 的不可达情形造测试（那会违反本仓「不伪造
覆盖」的纪律），只做了文档化；③**没查下去的地方**：`DEFAULT_MAX_TILT_RAD` 文档里「牵引模型
在某倾角失效」这一**物理断言**本轮只撤销了它的 `// measured:` 标记、**没有**去找任何牵引模型
文献来证实或证伪它，也没有为它选一个新的数值；④`MAX_FAULT_LOG = 256`、`DEFAULT_*` 四个数值
本身**一个都没改** —— 改的是**标记与依据**，不是数值；⑤`window_full` 的命名（两个模块里都
是「已开始丢弃」而非「已满」）本轮**核对后判定不是缺陷** —— `SafetyMonitor::window_full` 与
`CycleStats::window_full` 语义**一致**（都是 `rolled`），文档也都写对了，只是名字略偏；顺带
证实 `safety.rs` 里「与 `CycleStats` 同一 `VecDeque` 有界历史形状」的说法**属实**
（`control.rs` 的 `recent: VecDeque<Duration>`）。

## 18. 第十五轮审计（REQ-A534）：一个把 `Unknown` 的边界写错一格的枚举文档、一个把「周期」当参考点的字段文档，以及一句在仓库里不存在的英文引文（2026-09-20）

**范围**：`control.rs` —— README 三条主线之一（`fusion` / `planning` / `control`），也是**最后一个
从未被专门审计**的模块。本轮**没有改任何生产逻辑**；改的是三处文档，并**新增 2 个测试**
（+2，诚实计数）。

**(a) 缺陷一：`Unknown` 的边界被写错了一格**

`CadenceHealth::Unknown` 的变体文档原文：「**Fewer than two judged ticks** and no overrun:
there is no evidence yet」。而 `health()` 的判据是 **`judged == 0`**：

```rust
if self.judged == 0 { return CadenceHealth::Unknown; }
```

第二个 tick 落定之后 `judged == 1`；若它准时，`health()` 返回的是 **`Held`**，不是 `Unknown`
（`late_ratio()` 同样只在 `judged == 0` 时返回 `None`）。三处与代码一致的说法都被这句话否掉：

- 模块文档表格第 14 行的「`Unknown` **before the second tick**」；
- `health()` 自己的「`Unknown` until there is evidence」；
- crate README 的「fewer than two **ticks**」（说的是 *ticks*，不是 *judged ticks*，所以它是对的）。

**没有任何测试**钉住 `judged == 1` 这个边界。已把变体文档改成「no judged interval yet（只有环路
的第一个 tick）」，并指出旧措辞代码从未实现；新增测试
`the_second_tick_is_already_evidence_not_unknown`。负控：把 `health()` 的 `judged == 0` 改成
`judged < 2` ⇒ **恰好**该测试红（`left: Unknown / right: Held`），其余不变。

**(b) 缺陷二：`late_by` 的参考点写成了「周期」**

`CycleVerdict::late_by` 的字段文档写「how late this tick started **relative to the period**」，
但 `record` 减的是 **`period + slack`**（起跑落在 slack 窗口内即记 `None`）。同一结构里
`CycleStats::on_time()` 的文档（"inside `period + slack`"）是对的 —— 字段文档是那个异类。
已改为「relative to `period + slack`」。

**(c) 缺陷三：一句在仓库里不存在的英文引文**

模块首段原文：

> `docs/amos-link.md` §6 says so — "the frequency is the caller's (50–100 Hz in a real product)"

核对：`docs/amos-link.md` §6（「环境变量与边界（老实说）」）是**中文**，那句话是
「线程/频率由调用方（真实产品里是 50–100 Hz 的控制任务）决定」；而且字符串 `in a real product`
**整个仓库都不存在**（`grep -rn` 零命中）。也就是说，引号包着的是一句**翻译**，不是任何文档里的
原文。已改标为「translation, not a quotation」，并把中文原文引出来。

**(d) 顺带：一个没写出来的饱和**

`recent_lateness_percentile` 内部有 `p.min(100)`，即 `p > 100` 被读作 100；文档没提。已写明。

**(e) 新增测试二：把 `tick()` 与 paced run 的对立钉住**

`run_until` 的文档写着「A caller that owns its own timer calls `tick` directly, where every
interval *is* an interval」—— 这正是 `restart_pacing()` 存在的理由（paced run 重新捕获前驱，
手打 `tick` 不）。但 `a_restarted_paced_run_does_not_charge_the_loop_for_the_idle_gap` 只钉了对立的
**一半**。新增 `a_hand_ticked_loop_judges_every_interval`，用**计数**断言（`judged` 2 → 3 → 4），
**不**断言墙钟迟到 —— 那样 CI 机器就成了判决者。负控：在 `tick()` 开头插入 `self.last_tick =
None;` ⇒ 该测试红（`left: 0 / right: 2`）。

**(f) 核实后判定不是缺陷的**

- `MAX_CYCLE_SAMPLES` 的算术：「1024 intervals at 100 Hz is ~10 s」= 10.24 s；「16 KiB —
  `Duration` is 16 bytes on a 64-bit target」= 1024 × 16 = 16384 B，两处都对。
- 它对中间件有界仪器的交叉引用属实：`SeqTracker` 与 `RateTracker` 都由 `MAX_TRACKED_STREAMS`
  （= 4096）封顶。
- §3(b) 那条**实测**缺陷的「≈45 ms」与文档一致：5 ms 周期 + 500 µs slack，50 ms 间隔 ⇒
  50 − 5.5 = 44.5 ms 迟到。
- `MissedTickBehavior::Delay` 与中间件的 `lan.rs`/`telemetry.rs`/`discovery.rs` 三处心跳/信标任务的选择一致。
- `LoopError::ZeroPeriod` 的「panics *inside the spawned task*」措辞与中间件自己的文档
  （`telemetry.rs` §212、`discovery.rs` §1040）一致。

**(g) 证据**

- 单元测试 **298（+2）**；集成 29、doctest 11 不变；全绿。
- `cargo clippy -p amos-robot --all-targets --no-deps -- -D warnings` **0 警告**；`cargo fmt
  --check` 净；`RUSTDOCFLAGS="-D warnings" cargo doc -p amos-robot --no-deps` **绿**。
- coverage：97.62% 行 / 97.64% 区域。**九个仓门全绿。**

**诚实边界**：①本轮**没有改任何生产逻辑** —— 三处缺陷全部落在文档上，两处新增测试钉的是**既有**
行为；②`MAX_CYCLE_SAMPLES = 1024` 与 `DEFAULT_SLACK_DIVISOR = 10` 的**数值一个都没改**；③
`DEFAULT_SLACK_DIVISOR` 文档里「~1 ms 调度抖动」这句策略散文**保留未动** —— 它**不是**本 crate
唯一没有溯源标记的常量（`MAX_DT_S`、`MAX_GRID_CELLS`、`STEP_ORTHOGONAL`、`MAX_TRACKED_FEATURES`
等一大批常量都只有理由散文、无 `// measured:`/`// cited:`/`// chosen:` 标记），所以没有单独挑它；
④**没查下去的地方**：`run_until` 的 `MissedTickBehavior::Delay` 在**长超期**下的实际补偿行为，
本轮只做了读码核对（与中间件三处一致），**没有**跑一场真实的长超期去测它 —— 关于周期语义的
实测仍然只有 §3(b) 那一条。

## 19. 第十六轮审计（REQ-A535）：一个把「负方差」静默消毒成「零协方差路标」的初始化路径，加上三处站不住的文档引用（2026-09-20）

**范围**：`slam/ekf.rs` —— EKF-SLAM 的核心（状态 + 预测 + 观测 + 维护），也是 `slam/` 里最大、此前
从未被专门审计的文件。本轮**改了一行行为**（新增两处输入拒绝），其余是文档；新增 **3 个测试**（+3）。

**(a) 核心缺陷：负/非有限 `initial_landmark_variance` 被静默消毒成「零协方差路标」**

`observe` 的创建分支原样把 `control.initial_landmark_variance.sqrt()` 交给 `Landmark::new`：

```rust
let mut lm = Landmark::new(lm_x, lm_y, control.initial_landmark_variance.sqrt());
```

而 `Landmark::new` 计算 `σ² = σ.max(0.0)²`，`f32::max` **返回非 NaN 的那个操作数**。于是：

- `initial_landmark_variance = -1.0` ⇒ `(-1.0f32).sqrt() = NaN` ⇒ `NaN.max(0.0) = 0.0` ⇒ `σ² = 0.0`；
- `initial_landmark_variance = NaN` ⇒ 同上 ⇒ `σ² = 0.0`。

两种情形都**创建了一个协方差为零的路标** —— 即「位置完全已知」，恰好是该字段文档所承诺的「宽先验 /
非信息先验」的**反面**。而 `add_landmark` 里那道 `!v.is_finite() || v < 0.0` 守卫**拦不住**：它看到的
`v` 早已是消毒后的 `0.0`（有限、非负）。实测：加检查前，`-1.0` 与 `NaN` 都返回
`Ok(Created { landmark_index: 0 })`。修法：在 `observe` 顶部、与观测校验并列，拒绝非有限或负的
`initial_landmark_variance`（**`0.0` 保持合法** —— 调用方可以刻意播种一个「已知」路标）。

**(b) 同一类：非有限或负的 `gate_squared` 也被拒绝**

门是 `d² ≤ gate_squared`，而 `d² ≥ 0`。一个非有限或负的门**永不成立** ⇒ 每个观测都被判为「新建」，
地图被同一处的重复路标填满，而 `observe` **一路报 `Ok`**。这与 (a) 是同一类「坏输入静默变成坏输出」，
故一并拒绝（同样是 `0.0` 合法 —— 「只接受精确命中」）。

**(c) 一处编造的交叉引用**

`VelocityCommand` 的文档写「`forward`, `angular` … the same convention
`amos_link::robot_hal::Gait` uses after the `frame → motion` transform」。核对：`Gait` 是**步态名**
枚举（`stand`/`trot`/`walk`/`sit`/`arm`/`estop`），`Gait::pose` 展开成**关节角**，不是速度；全
`amos-link` **没有** `linear_m_s`/`angular_rad_s` 字段；字符串 `frame → motion` **全仓零命中**（只有
这一行文档自己）。一句引用了「不存在的变换」的话 ⇒ 撤销，改为自述 SI / 机体坐标系约定，并写明
`Gait` 是步态名、别把两者混同。

**(d) `capacity()` 把「行宽」写成了「总格数」**

文档写「Total cells allocated for the covariance」，实际返回 `ROBOT_DIM + LM_DIM · MAX_LANDMARKS`
= **1027** —— 那是协方差的行**步长（stride）**，总格数是 `capacity² ≈ 1.05 M`。已改为 stride。

**(e) 模块边界 2 低估了单状态的占用**

原文只说「`Vec<f32>` of that size is ~4 MiB for the covariance」，但 `SlamState` 还持有
`scratch_a`、`scratch_b` 两个**同尺寸**缓冲（`with_pose` 里各分配一次）⇒ 单个 `SlamState` 实际
≈ **12 MiB**，不是 4。已在边界里写明三块之和。

**(f) `EkfSlam` 的两条封装理由都站不住**

`EkfSlam` 文档称它「pins a `SlamControl` so a test can compare two runs that share the same policy」
—— 但**没有任何 setter**：`with_control`/`set_control` 在前几轮因**零引用**被删（本仓纪律「先有 caller
再有 setter」），全仓 `EkfSlam` 只以 `EkfSlam::default()` 出现（`tests/slam_e2e.rs` 四例 + 本文件两例）。
所以「固定一个控制」描述的是一种无人能用的能力。理由 2 里「a small object」也不成立：该对象持有
≈12 MiB 的 `SlamState`。已把两条改成诚实说法（控制**恒为默认**；封装换来的是**一次可变借用**）。
**按纪律不重新加回 `with_control`** —— 那会重新引入一个零调用点的 setter。

**(g) 修法之后按理不可达的一支**

`add_landmark` 的 `v < 0.0` 分支在 (a) 的检查落地后**经 `observe` 不可达**（坏方差在 `Landmark::new`
之前就被拒了）。按本仓纪律**文档化不可达情形、不伪造覆盖**，只就地写明，不为它造测试。

**(h) 证据**

- 单元测试 **301（+3）**；集成 29、doctest 11 不变；全绿（7 个 `test result: ok`）。
- `cargo clippy -p amos-robot --all-targets --no-deps -- -D warnings` **0 警告**；`cargo fmt
  --check` 净；`RUSTDOCFLAGS="-D warnings" cargo doc -p amos-robot --no-deps` **绿**。
- coverage：97.63% 行 / 97.65% 区域。**九个仓门全绿。**
- **负控（实测）**：把新增的校验块整体替换为 `if false { … }` ⇒ **恰好三条**新测试变红，全部报
  `left: Ok(Created { landmark_index: 0 }) / right: Err(BadInput)`（`a_negative_initial_landmark_variance_is_refused_not_sanitised_to_zero`、
  `a_non_finite_initial_landmark_variance_is_refused_not_sanitised_to_zero`、`a_nonsensical_gate_squared_is_refused`）；
  随后 `cp` 逐字节还原并确认变异字符串 `if false {` 已消失。

**诚实边界**：①本轮**改了行为**（新增两处输入拒绝），**不是**纯文档轮 —— 但改动只落在**非法输入**上：
合法输入（含 `initial_landmark_variance = 0.0`、`gate_squared = 0.0`）的行为**逐位不变**；②拒绝
`gate_squared` 是本轮**主动认定**的同类校验，此前**没有**文档承诺接受负门，「永不匹配」也从来没有受支持
的写法；③`add_landmark` 的 `v < 0` 分支**未**造测试（不可达）；④`Landmark::new` 的消毒行为**保留未改**
（它是公开 API 且 `0.0` 合法），修在**调用方**而非构造函数；⑤**数值一个没改**：`MAX_LANDMARKS = 512`、
默认 `initial_landmark_variance = 1.0`、`gate_squared = CHI2_2DOF_95` 等全部原样；⑥**没查下去的地方**：
`predict` 对 `process_noise_*` 用的是 `.max(MIN_PROCESS_NOISE)` **夹取**而非拒绝 —— 与 `observe` 的拒绝
策略**不一致**，本轮**未统一**（夹取有正当理由：正定性下限，且已有文档），只在 `MIN_PROCESS_NOISE`
既有说明下保留；⑦`Landmark::new` 的文档新增了一段「它消毒、不校验」的说明，属**跨文件**（`slam/landmarks.rs`）
但同属本 crate 且同属本缺陷的根因，未触碰任何其他 crate。

## 20. 第十七轮审计（REQ-A538）：一个自相矛盾的世界原点约定（半格级），以及两处把阈值算术写错的测试注释（2026-09-20）

**范围**：`slam/occupancy.rs` —— 对数几率占据栅格，`slam/` 里最后一个未被专门审计的大模块。
**本轮没有改任何生产逻辑**；改的是文档（1 处真缺陷）、两处测试注释/名字，并给四个常量补了溯源标记；
新增 **1 个测试**（+1）。数值一个没改。

**(a) 核心缺陷：世界原点的约定自相矛盾（半格级）**

`OccupancyGrid::with_origin` 的文档写它设定的是 cell `(0,0)` 的**中心**，同一句话里却又宣称这是
「the same convention as [`crate::planning::Grid::with_origin`] so the two agree when the mask is handed
over」。核对 `planning.rs`：`Grid::with_origin`（第 408 行）把原点定义为 cell `(0,0)` 的西北**角
(corner)**，并专门写了「A corner, not a centre: [`Grid::world_to_cell`] floors `position − origin`…」；
`Grid::cell_centre`（第 586 行）再次重申「The origin is the north-west **corner** of cell `(0, 0)`」。
**两者不可能同时为真** —— 一个是中心、一个是角，差**半格**。

而本模块自己的文档又承认「this mapper stores only the origin」、转换是 `planning` 的职责 ⇒ **正确的
一方是 planning，错的是本模块**。后果：一个照着本模块文档理解、再把 `origin()` 的值交给
`Grid::with_origin(..)` 的调用方，会把整张地图平移 **resolution / 2** —— 与第七轮
`cell_centre`/`clearance_mm` 那处半格缺陷**同一个族**（第七轮把「角」叫成「中心」，这一轮把「中心」
当成了搬运约定）。

**修法**：`with_origin` 与 `origin()` 两处文档改「north-west **corner**」，并写明依据（`world_to_cell`
向下取整 ⇒ cell `(0,0)` 是半开盒 `[origin, origin + res)`）。**无行为改动** —— `with_origin` 只存
两个 `i64`，本模块不做任何 world↔cell 换算。

**(b) 新增测试：把「两个约定一致」这句话变得可测**

`the_origin_agrees_with_the_planners_corner_convention`：构造一个带原点的 `OccupancyGrid`，读出
`origin()`，交给 `planning::Grid::with_origin(..)`，断言两件事 —— `cell_centre((0,0)) == origin +
(res/2, res/2)`（若原点是**中心**，cell `(0,0)` 就会**正中**在它上面；作为**角**，中心在它北/东各半格），
以及 `world_to_cell(origin) == (0,0)`（原点恰在 cell 0 内）。

**诚实边界**：该测试**不能**被「文档变异」证伪 —— 文档不参与执行。它钉的是 **planning 侧的既有约定**，
即本模块声称要与之对齐的那一半。**负控（实测）**：临时把 `planning::Grid::cell_centre` 的半格偏移去掉
⇒ 该测试红（`left: Some((1000, -2000)) / right: Some((1250, -1750))`）；随后 `shasum -a 256`
（`planning.rs 65c85bb9…`）+ `cmp` 逐字节还原，确认 `saturating_add(half)` 两处复原。

**(c) 一个把阈值算错的测试注释**

`a_hit_and_a_miss_cancel_out_partially` 的注释写「+80 − 40 = +40 → still above the threshold
(40/2 = 20)」—— 它把阈值当成了「该格值的一半」。真实阈值是 `OCCUPANCY_DEFAULT_HIT / 2 = 40`，而
`+80 − 40 = +40` **恰好等于**阈值；该格保持 `Occupied` **仅因为** `classify` 用的是 `>=`（**含边界**）。
⇒ 注释改为写出真实规则，测试改名为 `a_hit_and_a_miss_leave_the_cell_exactly_on_the_occupied_boundary`
（它其实是一个**边界**测试，不是「部分抵消」），并**加一条**断言
`assert_eq!(g.get(0, 0), OCCUPANCY_DEFAULT_HIT / 2)` 把「正好落在阈值上」钉死。
**负控（实测）**：把 `classify` 的占据判据由 `>=` 改成 `>` ⇒ 该测试红（`left: Unknown / right:
Occupied`）；随后逐字节还原。

**(d) 一个把次数数错的测试注释**

`a_miss_saturates_a_cell_to_free` 的注释写「Two misses is enough」，但自由阈值是
`OCCUPANCY_DEFAULT_MISS / 2 = −40 / 2 = −20`，**一次** miss（−40）就已 `≤ −20`；而测试体却调了
**三次** `add_miss`。注释、阈值、代码**三者互不一致**。⇒ 改为一次并写明依据。
**负控（实测）**：把自由判据改成 `v < OCCUPANCY_DEFAULT_MISS`（即需低于 −40）⇒ 该测试红
（`left: Unknown / right: Free`）；随后逐字节还原。

**(e) 一个与内容无关的测试名**

`a_4x4_grid_is_the_largest_in_the_construction_call`：名字既不说这个 body（测 2048×2048 =
4,194,304 格 > `MAX_GRID_CELLS` = 1,048,576），也扯上一个并不存在的 4×4 ⇒ 改名
`a_grid_over_the_cell_ceiling_is_refused`。

**(f) 四个常量没有溯源标记**

`OCCUPANCY_MAX_BOUND` / `OCCUPANCY_MIN_BOUND` / `OCCUPANCY_DEFAULT_HIT` / `OCCUPANCY_DEFAULT_MISS`
此前只有「它是什么」的重述，**没有任何** `// measured:` / `// cited:` / `// chosen:`。已补
`// chosen:` + 理由：`80` 与 `−40` 是**策略型**对数几率步长（不是测出来的似然），且 miss 恰为 hit
的**一半** —— 两次自由扫描才抵消一次命中，所以一次虚假回波不会被下一道掠过该格的射线抹掉；边界取
`i16::MAX / 2` 是为在 `i16` 内留头寸，使 clamp 永远在被夹住之前就先饱和。

**(g) 证据**

- 单元测试 **302（+1）**；集成 29、doctest 11 不变；全绿（7 个 `test result: ok`）。
- `cargo clippy -p amos-robot --all-targets --no-deps -- -D warnings` **0 警告**；`cargo fmt
  --check` 净；`RUSTDOCFLAGS="-D warnings" cargo doc -p amos-robot --no-deps` **绿**。
- coverage：97.64% 行 / 97.65% 区域。**九个仓门全绿。**

**诚实边界**：①本轮**没有改任何生产逻辑** —— (a) 是文档、(c)(d)(e) 是测试的注释/名字、(f) 是标记；
唯一新增的测试钉的是 **planning 的既有约定**；②`occupancy.rs` 的**数值一个没改**；③(c) 还**加了**
一条断言（没有放松）；④(a) 的新测试**无法**被文档变异证伪，负控只能在 planning 侧做（已如实记录）；
⑤**没查下去**：`bresenham_line` 的平局规则用的是严格 `>` / `<`（标准写法多为 `>=` / `<=`）—— 本轮
只验证了两者都是**八连通且终止**的合法变体、不产生连通性缺口（端点均在格内 ⇒ 每步至少一轴推进 ⇒
循环至多 `dx + |dy| ≤ cols + rows` 步），**没有**判定哪种平局更「正确」，也没有改；⑥`OccupancyCell::Free`
的阈值用整数除法 `OCCUPANCY_DEFAULT_MISS / 2`，若将来有人把 `MISS` 改成奇数会有向下取整偏差 —— 当前
`MISS = −40` 为偶数、无影响，且 `classify` 与 `free_cells`/`occupied_mask` **同源**，故不会自相矛盾，
本轮未改动。

## 21. 第十八轮审计（REQ-A540）：一个被静默截断的角点坐标，加上一句被安到论文头上的「工作区间」（2026-09-20）

**范围**：`vision/fast.rs` —— FAST-9 角点检测器（`vision/` 里未被专门审计的模块之一；`vo.rs` 才是最后一块）。
本轮**改了两处行为**（一处输入拒绝、一处纯省工），其余是文档；新增 **2 个测试**（+2）。
**算法的数值一个没改。**

**(a) 核心缺陷：`Corner::{x,y}` 是 `u16`，而检测不检查图像是否装得下**

`Corner` 的坐标字段是 `u16`，`detect` 里却是 `x as u16` / `y as u16` 直接截断。`detect` 的入口
守卫只拒绝 `width < 3`，**没有上界**。于是一张宽 `70 000` 的图：抑制扫描 `for x in 1..(w-1)` 会走到
`x = 69 998`，`as u16` 把它按 65 536 取模折成 `4 462` —— 检测器**报出一个位于错误列上的角点**，
既不报错也不空手而归。这正是上一轮 `ekf::observe` 那条「坏输入静默变成坏输出」的同族缺陷，修法也
相同：**拒绝**，而不是截断。真正的界不是 `u16::MAX` 而是 `u16::MAX + 2`（能发出的最大坐标是
`w − 2`，最后两列永远不可能是角点），故判据写作 `config.width > u16::MAX as u32 + 2`，与
`height` 同理。

**(b) 一处纯省工：关掉非极大抑制时，抑制那一趟被算了又扔**

原文在 `non_max_suppression == false` 时**仍然**跑完整趟 3×3 抑制（把 `corners` 建好），再走进
末尾的 `if !config.non_max_suppression` 分支**另建**一个 `raw` 并 `return raw` —— 抑制结果原样丢弃。
输出逐位相同（`raw` 只读 `scores`），所以把 `raw` 分支**提到抑制之前**是纯省工，不改任何结果。

**(c) 一句安到论文头上的「工作区间」**

`DEFAULT_FAST_THRESHOLD` 的文档写「Rosten–Drummond report `t = 10 .. 20` as the working range」。
核对：该论文（ECCV 2006，*Machine learning for high-speed corner detection*）与 Rosten 的参考实现
README 给出的是 **`t = 20` 这个默认值**（`/t X` 的默认），**没有**「10 到 20 的工作区间」这句话。
⇒ 撤销该归属，改写成可核对的 `// cited:` —— 参考实现默认 20、本模块取同一个值；「10..20」不再出现。

**(d) 两句无法核对的断言**

模块文档称本变体是「every aerospace-grade implementation I know of」的做法，又称决策树是
「a 2-3× speedup」—— 两者都不可核对。⇒ 改为自述事实（决策树只是对**同一个**测试的加速，不改哪些
像素通过；本模块直接跑测试，因此检测路径是一趟确定的、可复核的扫描），并明写本轮撤销了这两句。

**(e) 一处把「环」说成「弧」**

`FastConfig::conservative` 的文档写「a 16-pixel arc」。环是 16 个像素，但**弧**是测试要求的**连续 9 个**。
⇒ 改为「the 9-of-16 contiguous arc test」。

**(f) 一个没有定义的「一步」**

`DEFAULT_FAST_MIN_SCORE` 的文档写它「Sits one threshold-step above `DEFAULT_FAST_THRESHOLD`」——
阈值之间**没有**「一步」这种单位，且 30 是 20 的 **1.5 倍**（不是 20 加一步）。⇒ 改为诚实说法：
30 是本 crate 的策略下限，它高于弧测试本身要求的 `t = 20`；并补 `// chosen:` 标记。

**(g) 两个 `DEFAULT_FAST_*` 常量没有溯源标记**

`DEFAULT_FAST_THRESHOLD` 补 `// cited:`（Rosten & Drummond ECCV 2006 / 参考实现默认 20），
`DEFAULT_FAST_MIN_SCORE` 补 `// chosen:`（策略值，非引用非测量）。**数值一个没改**（仍是 20 / 30）。

**(h) 新增测试（两个，均带负控）**

- `an_image_whose_coordinates_do_not_fit_u16_is_refused`：构造一张 `70 000 × 16` 的图，在
  `x ≈ 66 000` 处放一个亮方块（**若**没有上界守卫，就会有一个被截断的角点被报出 —— 让负控是真的），
  断言结果为**空**。
- `a_corner_scoring_exactly_the_min_score_is_kept`：`min_score` 是**含边界**的下限（`best < min_score`
  才丢），故得分**恰好等于**下限的角点必须留下。低对比方块（100 on 0）得分恰为 100 ⇒ 用 100 / 101
  两个下限把这条边界钉死（既有的 `min_score_filters_weak_responses` 用的是 200/30，离任何真实得分都远）。

**(i) 证据**

- 单元测试 **304（+2）**；集成 29、doctest 11 不变；全绿（7 个 `test result: ok`）。
- `cargo clippy -p amos-robot --all-targets --no-deps -- -D warnings` **0 警告**；`cargo fmt
  --check` 净；`RUSTDOCFLAGS="-D warnings" cargo doc -p amos-robot --no-deps` **绿**。
- coverage：97.65% 行 / 97.67% 区域。**九个仓门全绿。**
- **负控（实测）**：
  - 把上界判据整体换成 `if false {` ⇒ **恰好一条**红
    （`an_image_whose_coordinates_do_not_fit_u16_is_refused`），随后逐字节还原；
  - 把 `best < config.min_score` 改成 `best <= config.min_score` ⇒ **恰好一条**红
    （`a_corner_scoring_exactly_the_min_score_is_kept`），随后逐字节还原（`sha256
    2372ad4e…`）。

**诚实边界**：①本轮**改了行为**，不是纯文档轮 —— 但两处改动都不会改变**合法**输入的输出：
上界守卫只影响「坐标装不进 `u16`」的图（此前会静默截断），省工改动输出逐位相同；
②「10..20 工作区间」的撤销依据是**检索**（论文与参考实现给的是默认值 20，未见区间表述），
不是逐字比对原论文 —— 因此更弱的「默认 20」改成了带 `// cited:` 的写法，更强的「区间」删掉；
③`u16::MAX + 2` 这个界是**推出来的**（最大可发出坐标 `w − 2`），不是抄来的；
④抑制关掉时的 `raw` 分支**搬家**了（提到抑制之前），但没有新增或删除任何那个分支的判据；
⑤**没查下去**：`scores` 缓冲每次调用分配一次（`vec![-1i32; w·h]`，对 1080p 是 8 MiB）——
模块文档说的「无分配」指的是**内层**循环，外层这块大分配本轮未动；⑥同 (b) 的 `scores.get` 两个
`None` 分支仍是**按构造不可达**（索引由循环边界保证 `< w·h`），文档如此写明、**不**伪造覆盖。

## 22. 第十九轮审计（REQ-A543）：一句「上限」写成了它并没有提供的保证，加上三处声明了不存在的产物的文档（2026-09-20）

**范围**：`vision/vo.rs` —— 帧间视觉里程计的粘合层（`vision/` 里最后一块未被专门审计的模块）。
**本轮没有改任何生产逻辑**；改的是文档（5 处），新增 **1 个测试**（+1）。**数值与行为一个没改。**

**(a) 核心缺陷：`MAX_TRACKED_FEATURES` 声称的是一条代码并不提供的保证**

该常量的文档原文是「Largest track set the glue **holds** between frames」。核对：这个上限**只**施加在
粘合层**自己生成**的特征上 —— `detect_corners` 末尾的 `truncate(MAX_TRACKED_FEATURES)` 与
`replenish` 循环顶部的 `break`。而 `track_frame_to_frame` 收的是调用方的 `&mut Vec<(u16, u16)>`，
`VisualTracker::set_features` 收的是一条 `Vec` —— **两者都不截断**：传进来 300 个特征，只要有 ≥128 个
跟踪成功，就既不触发补种、也不会被裁，`*prev_features` 原样变成 300。于是「粘合层持有的轨迹集不超过
`MAX_TRACKED_FEATURES`」这句**是假的**，而它正是这个常量存在的理由 —— 本文件自己的测试注释把它称作
「the bounded-work guarantee for the whole frame pipeline」（`replenish_never_exceeds_the_cap`）。
⇒ 文档改为陈述**真正的保证**：它界定粘合层**凭空造出**多少特征，**不是**对调用方输入的一道检查；
一条更长的输入集会被原样传递，**有界工作量是调用方在那个边界上的契约**。（**没有**顺手加一道静默截断 ——
那是另一种「坏输入静默变成坏输出」，且会悄悄丢掉调用方明确要跟踪的点；这条边界属于调用方。）

**(b) 一处把排序说得比它做到的更多的文档**

`detect_corners` 的文档写「Ordering by score before the cap keeps the strongest, **spatially-distributed**
response instead」。排序给出的**只有「最强」**，与空间分布无关：一帧里最强的 256 个角点如果挤在一角，
留下的就是那一撮。让集合铺开的是 `replenish` 的间距过滤（`MIN_REDETECT_SPACING_PX`），
**且只在补种那条路径上**。⇒ 改为「keeps the **strongest** responses instead, wherever they sit」，
并写明铺开不是这一步的职责。

**(c) 一句声明了不存在产物的「诚实边界」**

模块文档的 Honest boundary 写「we report the unit translation direction and the **ratio** of flow
magnitudes」。核对：`VisualObservation` 只有 `x_t/y_t/x_tp1/y_tp1/flow`（一条 `FlowVector`），
`RansacReport` 只有 `essential/pose/iterations` —— **没有任何聚合的「流量模之比」**；全仓检索
`ratio of flow` / `flow magnitudes` 只命中这一行文档自己。单目无法恢复尺度是对的，但**本模块并没有
把这个比值算出来或报出来**。⇒ 改为「报的是单位平移方向 + 每条特征的流量」，并说明「流量模之比」若要有意义
得由**持有尺度**的调用方自己导出。

**(d) 一道与内层守卫完全重复、因而无法被任何测试区分的守卫**

`VO_MIN_SAMPLES = 8` 的文档原写「Below this the RANSAC step is skipped entirely (the report is `None`)
rather than fed a degenerate design matrix」。核对 `five_point::ransac_essential`：它开头就是
`if a.len() < 8 || a.len() != b.len() { return None; }` —— **同样的输入得到同样的 `None`**。也就是说这道
守卫**在可观测行为上是多余的**（它省下一次调用，仅此而已），「否则会喂给求解器一个退化设计矩阵」的说法
把结果说反了：求解器**不会**误处理短输入，它返回 `None`。⇒ 按本仓纪律**写明它冗余、且没有任何测试能
区分两者**，因此**不为它造测试**。

**(e) 一处指向错帧的文档**

`MIN_TRACKED_FEATURES` 的文档写「the tracker re-detects corners in the **current** frame to refill the
set」。代码里补种跑在 `next`（**目标帧**）—— 那些新点活在 `next` 里，而那正是下一次调用的 `prev_features`
要指的地方（`track_frame_to_frame` 的代码注释与测试 `a_frame_that_loses_every_track_is_repopulated_by_redetection`
都按这一点写）。「current frame」会被读成 `prev`。⇒ 改为「the **target** frame `next`」。

**(f) 新增测试：把「留下的是最强的」变成可测**

`the_cap_keeps_the_strongest_response_not_the_top_left_block`：192×192 的图上以 10 px 点阵铺满
**弱**角点（值 100 / 背景 0 ⇒ 得分 ≈100，共 361 个点 ⇒ 远多于 256 个角点），再在**光栅序最后**的右下角
放一个**饱和**角点（值 255 ⇒ 得分 255）。带排序时它排在最前、稳过截断；**没有**排序时按光栅序取前 256 个
只覆盖左上角那一块，它必被丢掉。断言分**两条路径**各查一次：`detect_corners` 直调，以及
`track_frame_to_frame` 的冷启动（`prev` 是均匀图 ⇒ 检测为空 ⇒ 由 `next` 走补种路径），后者才是部署真正
会经过的入口。

**(g) 证据**

- 单元测试 **305（+1）**；集成 29、doctest 11 不变；全绿（7 个 `test result: ok`）。
- `cargo clippy -p amos-robot --all-targets --no-deps -- -D warnings` **0 警告**；`cargo fmt
  --check` 净；`RUSTDOCFLAGS="-D warnings" cargo doc -p amos-robot --no-deps` **绿**
  （过程中该门确实抓过一次：`MAX_TRACKED_FEATURES` 是 `pub`，其文档链到 `detect_corners`/`replenish`
  两个**私有**项 ⇒ `private_intra_doc_links` 报警，已把两处链接改为纯代码体）。
- coverage：97.66% 行 / 97.68% 区域。**与 `amos-robot` 相关的七个仓门全绿**；`rust-unwired-scan` 与 `examples-smoke` **红**，但两处都落在 `crates/amos-tauri`（另一会话正在改的文件：一个 E0382 借用错误让工作区构建失败、一条 baseline 条目已过期），**不是本轮引入**，`rust-unwired-scan` 对 `amos-robot` 报的是 **0 new**。
- **负控（实测）**：删掉 `detect_corners` 里那一行
  `corners.sort_by_key(|c| std::cmp::Reverse(c.score));` ⇒ **恰好一条**红
  （`the_cap_keeps_the_strongest_response_not_the_top_left_block`，停在第一处断言）；随后 `cp`
  逐字节还原（`sha256 38e1718e…` 为还原后的快照），复测 305 绿。

**诚实边界**：①本轮**没有改任何生产逻辑** —— (a)–(e) 全是文档，唯一新增的测试钉的是 `detect_corners`
**既有的**排序行为；②(a) 里那条「调用方可以传更长的集合」是**读代码得出的**（`&mut Vec` 直通、
`set_features` 无检查），**没有**为它加断言 —— 加一条「传 300 个进去、出来还是 300 个」的测试等于把
这个未强制的行为**固化成契约**，而那正是本轮要避免的；③(c) 的撤销依据是全仓检索（`ratio of flow`
只在那一行文档里），不是对单目几何的重新推导；④(d) **故意不造测试**（两条路径可观测等价），
按纪律写明而不伪造覆盖；⑤**没查下去**：`track_frame_to_frame` 对 **`NotConverged`** 的处理 ——
它进 `observations`（供 RANSAC 当外点丢掉）但**不进** `next_features`，这条「报了但不带走」与
`Lost` 的「既不报也不带」是个真实区分，但要用公开入口稳定造出一个 `NotConverged` 需要注入
`LkConfig`（`max_iterations` / `convergence_eps` 都在 `LkConfig::conservative(width)` 里写死，
本函数不暴露），本轮**没有**为它造夹具；⑥`VO_INLIER_THRESHOLD = 1e-3` 的「比默认 1.0 更紧」一句
核对无误（1e-3 < 1.0），其理由「亚像素的 LK 轨迹应当落在阈值深处」在 `typical_640x480` 的 `fx = 555` 下核算：
`√(1e-3) = 0.0316` 归一化单位 × 555 ⇒ **约 17.6 px 的等效半径**，确实宽松到足以容纳亚像素匹配
（「更紧」是相对 1.0 而言，1.0 对应约 555 px），本轮未改。

## 23. 验证入口

```bash
# 本层：332 单元 + 32 集成（mrac_lyapunov 5 / safety_inject 11 / slam_e2e 7 /
#        stack_e2e 4 跨 crate 端到端 / vision_e2e 4 / plan_tree 1）+ 12 doctest，全部离线
cargo test -p amos-robot

# 一个可运行的完整闭环（规划 → 驱动 → 姿态 → 定周期环路 → 看门狗）
cargo run -p amos-robot --example patrol_loop

# 它下面的中间件（本层不改动它）
cargo test -p amos-link
cargo test -p amos-link --test platform_cases      # 剖面契约（18 例，含“参考机逐字节不变”）
```

**实测输出（节选，真跑）**：

```text
map 12x10 cells at 1000 mm · 9 blocked cell(s) (before inflation) · route 3 waypoint(s), grid cost Some(182)
-- drive (0.05 s steps, pure pursuit) --
  step   0  toward (0, 1): steer 14036mdeg throttle 20000 brake 0
  step 450  arrived at (11, 9): brake 100000
  reached_goal=true at (8664, 8540) heading 1598 mrad
  fusion: roll=0.0deg pitch=0.0deg yaw=91.6deg gravity-referenced yaw=dead-reckoned (22.5 s integrated)

-- control loop (20 ms, wheeled profile, deadman 100ms) --
  cadence=held period=20ms slack=2ms ticks=5 late=0/4 (0.0%) worst_late=0us overruns=0 worst_work=32us p99_late=0us window=all 4
  15 frame(s) on the mock bus, armed=true
  commander quiet ⇒ armed=false (21 frame(s) total; the deadman stopped it, and the loop reports the 100 ms wait as work)
```

最后一行值得单独看：**指挥官沉默 ⇒ 剖面自己的 100 ms 看门狗停车**，而环路把那一拍读成
`worst_work ≈ 100 ms`（它在 `step()` 里等看门狗）。这不是“环路坏了”，这正是本仓的仪器纪律——
**把等待读作工作，而不是读作神秘**。

## 24. 补全（REQ-A672）：把 DWA 接到机器上——`(v, ω)` 到剖面 set point 的 join，以及一条撞向计划外障碍的负控

**缺口**：`dwa`（第十轮，REQ-A517 段）写出后，`AEROSPACE_PLAN.md` 把它勾成 ✅，但它输出的是
`(v, ω)` 速度对，而剖面命令只认「转向角 + 油门」——把两者接起来的自行车模型几何
（`ω = v·tan δ / L` 的 `L`、满油门速度）**全树无一处携带**，于是 `dwa` 是「一个只被测试调用的能力」，
`pursuit` 仍会在计划之后出现的障碍前直直撞进去。判据同 REQ-A408：交付的能力必须有一个**非测试**消费者。

**补全**（只**新增**，未改 `dwa`/`pursuit`/`Grid` 的任何数值或行为）：

* `VehicleGeometry{ wheelbase_mm, top_speed_mm_s }` —— 机器常量独立成型（不属于窗口）。
* `DriveCommand::from_velocity(velocity, geometry, max_steer_milli_deg)` —— 用 `atan(ω·L / v)`
  做 join。`|steer| ≤ 列行程`时它**精确反演**自行车模型，故窗口打分的弧＝机器开的弧；
  `v ≤ 0` ⇒ 整刹；转向按列行程饱和、油门按 `[0, 满]` 夹（三处都是**饱和**而不是“修正”）。
* `LocalPlanner{ pursuit, dwa, geometry }::command(plan_grid, world, route, pose, velocity)` ——
  **路线**给目标（`pursuit` 的瞄准点）、**窗口**给命令（`dwa` 对**实时**图 `world` 打分）、
  **到达**由 `pursuit` 判（不经过窗口）、**无安全轨迹＝刹停**。单向分工：混合两套律法会得到一条
  谁都没打过分的命令。`PlanError::Avoidance` 保留窗口的**类型化**拒绝。
* `tests/stack_e2e.rs`：闭环 `the_local_planner_steers_around_an_obstacle_the_route_does_not_know`
  与**负控** `the_negative_control_drives_into_the_obstacle_the_route_does_not_know`。
* `examples/patrol_loop.rs`：作为**非测试**消费者（一步「托盘出现在路线上，同一张路线、实时图」）。

**一条被负控删掉的规则**：`LocalPlanner::command` 起初有一条 `if !score.safe { return brake }`
的分支；负控证明它与 `from_velocity` 对零速度的 `(0,0)` 回退产出**逐字段相同**的 `DriveCommand`
（不可观测的重复规则），故**删除**并把理由写进该类型的文档。

**验证**：`cargo test -p amos-robot`（317 lib + 31 集成 + 11 doctest）全绿；`cargo clippy -p amos-robot
--all-targets -- -D warnings` 0 告警；`cargo fmt --check` 净；`cargo run -p amos-robot --example patrol_loop`
跑通并印出 `reached_goal=true, ever inside the pallet cell=false, closest pass 780 mm from the pallet's
centre (the route runs through it)`（负控时 `reached_goal=false, ever inside the pallet cell=true`）。

**如实边界**：`from_velocity` 的转向只在窗口整体落在行程内时精确——e2e 夹具据此**自行调参**并断言
`!saturated`；闭环/负控是**纯离线运动学**（kinematic bicycle，无滑移、无延迟，`MockRobotHal`），
**未做**真机/真传感器/实时内核验证；该闭环是**场景级**证据（一条走廊 + 一个计划外障碍），不是对
全部 DWA 参数域的证明。

## 25. 补全（REQ-A676）：三处「与它正下方的权威相反」的文档，以及把模块头那张图变成可执行的

**缺口**：三处文字与**紧挨着它们的**代码/测试/表格给出相反事实——

* `planning.rs` 模块头的 ASCII 图画「`pursuit` → `DriveCommand`」，把「route 的追逐命令变成机器命令」
  这条 join 说成是 `pursuit` 干的活。`pursuit` 只产出一个**目标/瞄准点**；真正做 join 的是
  `LocalPlanner::command`（把 `pursuit` 的瞄准点与 `dwa` 选出的速度合成一条命令）加
  `DriveCommand::from_velocity`（`(v, ω)` → set points）。
* `driver/mod.rs::estop_frames` 的文档写「one `Estop` frame per `JointId` **plus a broadcast at
  index 0**」；而**同文件**的测试注释早已写明「index 0 is joint 0, not a separate broadcast」，
  实现也只是每关节一帧。
* `AEROSPACE_PLAN.md` 第 31 行的模块树写 `planning.rs (existing — extended with DWA + multires)`；
  而 `planning.rs` 用 `MAX_GRID_CELLS` 的文档**明确拒绝**多分辨率，同一份计划的 `Status` 表自己把
  multi-resolution frontier 记为 *planned*。

判据同本仓的既有纪律：**文档必须与代码一致，否则文档就是缺陷**——维护者据错误文档会去改 `pursuit`
当反射层（改错地方）、按不存在的广播帧写订阅端、或以为多分辨率已交付而永不实现。

**补全**（只改文档与新增一条可运行 doctest，**未改**任何行为/常量/算法）：

* `planning.rs` 模块头图重画为真实数据流（`LocalPlanner::command` → `pursuit`给**目标** /
  `dwa`给**命令** → `DriveCommand::from_velocity` → `set_points()[3]` → `Actuator::check`），
  假句改成「Three laws, one command」段。
* `estop_frames` 文档改为与代码逐字一致（「no separate broadcast frame — index 0 is joint 0」）。
* `AEROSPACE_PLAN.md` 第 31 行改为「DWA + the reactive join; multi-resolution / frontier is still
  *planned*, not shipped — see the Status table」。
* **把图变成可执行的**：新增一条**可运行** doctest（非 `no_run`）跑完整 join，断言产出的是
  **前进油门**（不是停车回退）——于是那张图不再是会腐烂的 ASCII，而是 `cargo test` 每次都跑的断言。
* 顺带更正 `crates/amos-robot/README.md` 的测试计数（`316 unit + 42 integration` →
  `317 unit + 31 integration`）与本节 §23 的 doctest 计数（11 → 12）。

**验证**：`cargo test -p amos-robot`（317 lib + 31 集成 + 12 doctest）全绿；`cargo clippy -p amos-robot
--all-targets -- -D warnings` 0 告警；`cargo fmt -p amos-robot --check` 净。

**如实边界**：本轮修的是**文档-代码一致性**，新增 doctest 只钉「产出前进命令、不是停车回退、未到目标」
三个**不变量**，**不**证明 `pursuit`/`dwa` 的数值正确性；文档是文本，无自动化门能证明其真伪——本轮只把
**可执行的那一半**（模块头语义）变成 doctest，其余两处靠人工与同文件权威对齐。

## 26. 补全（REQ-A678）：能力台账与代码相反——多报了「5-point」，漏报了「9-DOF 磁力计」

**缺口**：本 crate 的两份「能力台账」与它们各自的权威相反——

* `AEROSPACE_PLAN.md` 的 `Status` 表（第 20 行）与模块树（第 45 行）把视觉前端写成
  「5-point RANSAC」/「5-point essential matrix (Stewenius / Nistér)」；而 `vision/five_point.rs`
  的模块文档逐字写着它实现的是**八点**基线、5-point 多项式求解器**故意不实现**（文件名
  `five_point` 是遗留误称）。
* `fusion.rs` 的诚实边界 #1（第 23 行）写「6-DOF, **no magnetometer**」、`README` 边界 #3 写
  「**No magnetometer**」；而 `fusion` 实际**交付了** 9-DOF 磁力计路径 —— `AttitudeEstimator::update_with_mag`、
  `MagSample`、`YawReference::Magnetic`，并有单测（`a ~43 µT field must be accepted`）；
  `docs/robot-autonomy.md` §17 本身就把该模块记作「Mahony 6-DOF 姿态估计 + 9 轴磁力计 + Allan 方差」。

一份文档**多报**一个不存在的算法、另一份**漏报**一个已交付的能力，且都与紧挨着的权威相反。

**补全**（只改三处文字，**未改**任何行为/常量/算法）：

* `AEROSPACE_PLAN.md` 第 20 行：改为「Hartley-normalised **eight-point** RANSAC — the 5-point
  polynomial solver is deliberately absent, see `vision/five_point.rs`」。
* `AEROSPACE_PLAN.md` 第 45 行：写明八点 + 5-point 故意缺席 + 文件名是遗留误称。
* `fusion.rs` 边界 #1：改为「**6-DOF by default, no covariance**」，写明 `set_heading` /
  `update_with_mag` 两条基准来路与 `YawReference::Magnetic`。
* `README` 边界 #3：改为「6-DOF **by default**… A 9-DOF magnetometer path *does* ship
  （`update_with_mag` / `MagSample` / `YawReference::Magnetic`），but it too publishes no covariance」。

**验证**：`cargo test -p amos-robot`（317 lib + 31 集成 + 12 doctest）全绿；`cargo clippy -p amos-robot
--all-targets -- -D warnings` 0 告警；`cargo fmt -p amos-robot --check` 净；`node scripts/fmea-gen.mjs
--check` ⇒ 366 条。

**如实边界**：本轮修的是**文档-代码一致性**，**未改** `five_point` 的文件名（重命名牵动 `vision/mod.rs`
的 `pub use` 与既有引用，属独立决定），只在计划文档里写明它是误称；磁力计路径**不发布协方差**，故边界
措辞是「航向基准，不是滤波器」；文档是文本，无自动化门能证明其真伪，本轮靠与同文件权威对齐。

## 27. 补全（REQ-A682）：计划模块树点名了一个从未存在的文件——并第一次给它上了门

**缺陷**：`AEROSPACE_PLAN.md` 的 `New modules` 树是审计者读到的**第一张**「这个 crate 是什么」的
图，其中五处与紧挨着的权威相反（均对 `git show HEAD` 核实）：

| 树里写的 | 实际（权威） |
|---|---|
| `ekf.rs` — ``fixed **4-D** state`` | `ROBOT_DIM` 3 + `LM_DIM` 2·N，模块文档逐字写 `dim = 3 + 2 · num_landmarks` |
| `landmarks.rs` — `landmark observations + **bounding-box gates**` | 只是一个 `Landmark{x_m,y_m,cov,observations,ever_observed}` + 门所引用的 `mahalanobis_squared`；门在 `data_assoc.rs`，无 bounding box |
| `data_assoc.rs` — `**JCBB** / nearest-neighbour` | 模块文档写 JCBB "is **not** implemented here — it is the named extension point"；`lib.rs` 第 47 行与 `slam/mod.rs` 各写一遍（**当时**；JCBB 已于 §71 实现，现位于 `ekf.rs`） |
| `loop_closure.rs` — `**pose-graph relocalisation**` | Olson, *Real-Time Correlative Scan Matching* (ICRA 2009) 的**暴力扫描匹配**；`lib.rs` 第 47 行自己写 "brute-force 2-D scan-match loop closure" |
| `driver/traits.rs` — `Re-export / extend RobotHal contract` | **文件不存在**：`ls src/driver/` 只有 `mod.rs`/`serial.rs`/`can.rs`/`udp.rs`；契约归 `amos_link::robot_hal`，`driver/mod.rs` 只再导出 |

这是 **F-DEV-031**（记录与现实不一致、而没有任何东西会失败）在**文档/文件系统**上的一版：据树去找
JCBB 或 pose graph 的审计者会读到一个**不存在的算法**，据树去找 `traits.rs` 会去找一个**不存在的
文件**。`clippy`/`fmt`/任何门都**不读**文档，所以它一直是绿的。

**修法**：五处逐条改为与代码一致；`driver/traits.rs` 删除，`driver/mod.rs` 一条改为「契约归
`amos_link::robot_hal`，本模块只再导出三个驱动」。

**把「树只能点名存在的文件」变成会跑的断言**：新增集成测试 `tests/plan_tree.rs`——从计划文档的
**第一个围栏块**抽 `.rs` 记号（手写记号化，不引 regex 依赖；取以 `.rs` 结尾的 `[A-Za-z0-9_/]` 最长
串），每个都必须在 `src/` 下存在：路径形状（`vision/five_point.rs`）按 `src/` 相对解析，裸名
（`ekf.rs`）在 `src/` 下递归按文件名查找。

作用域**只取围栏块**是本轮的一个教训：第一版扫全文，实测多报四个记号
`["robot/tests/plan_tree.rs", ".rs", "driver/traits.rs", "traits.rs"]`——因为它把**记录这次修复的
那句话**（"an earlier revision named a `driver/traits.rs` that never existed"）也算成了树的内容。散文
**故意**可以点名一个已删的名字，故收敛为 `first_fence()`。

**验证**：`cargo test -p amos-robot` ⇒ **317 lib + 32 集成 + 12 doctest** 全绿（+1 集成）；
clippy `-D warnings` 0 告警；fmt 净；`fmea-gen --check` OK（+1）。**负控（先红后绿，逐字节还原）**：
先写测试 ⇒ 红并**点名单个** `["traits.rs"]`（其余 19 个记号全过，证明提取器找到的是整棵树，不是空集）；
修文档 ⇒ 复绿；再把 `├── zzz_probe.rs` 塞回树 ⇒ 红并点名 `["zzz_probe.rs"]`；`cp` 还原后
`shasum -a 256` 与修前一致（`7795e63c…9cd661`）复绿。

**如实边界**：本轮修的是**文档-现实一致性**，**未改**任何行为/常量/算法。新测试只钉**机械的一半**
——「树里点名的 `.rs` 存在」；它**不**（也无法）验证名字旁边的散文是否**正确描述**了那个文件——本轮
的四处误标（`4-D`/`bounding-box`/`JCBB`/`pose-graph`）都是**散文**而非文件名，只能靠人工与同文件权威
对齐。不检查**摆放位置**（`can.rs` 在 `driver/` 而非 `slam/`），只检查存在性。`first_fence()` 取
**第一个**围栏块，若在树之前插入别的围栏，测试会指向它而非树——`tokens.len() >= 15` 的下限会让这种
失效**响亮**失败而非静默通过。

## 28. 补全（REQ-A686）：串口驱动的线格式图把两个 1 字节字段写反了（2026-09-20）

`crates/amos-robot/src/driver/serial.rs` 的模块头有一张 ASCII 线格式图，读者据它**写 RS-485 解析器**。
它写 ``0xAA 0x55 ‖ 1-byte op ‖ 1-byte joint ‖ 4-byte payload ‖ 2-byte CRC``——**op 在前、joint 在后**。
而三处稳定权威全部相反：

* `MotorFrame::encode`（`crates/amos-link/src/robot_hal.rs:754`）逐字写
  `out[2] = self.joint.0; out[3] = self.op.code();`；
* `amos_link` 自己的线格式文档写 `0xAA 0x55 │ id u8 │ op u8 │ arg i32 │ crc16 u16`；
* 本文件 `tests` 里的既有用例按 `chunk[2]` 是关节、`chunk[3]` 是 op 来断言。

所以图为**孤例**且相反。这不是措辞问题：一个据该图实现的接收端会把**关节号读成操作码**——每帧驱动
错的关节，或把 `Estop` 读成一个位置目标。判据同本仓「文档必须与代码一致，否则文档就是缺陷」，此处
假文档的后果落在**执行器**而非一行日志。

**修法**：图改为 ``0xAA 0x55 ‖ 1-byte id (joint) ‖ 1-byte op ‖ 4-byte arg (i32) ‖ 2-byte CRC``，并补一句
写明字段顺序的来路（`MotorFrame::encode` + `amos_link` 的线格式文档）。并把「图与代码同序」变成会跑的
断言——新增单测 `the_wire_diagram_lists_the_joint_before_the_op_and_encode_agrees`：**(a)** 用
`include_str!("serial.rs")` 读回本文件、取出那张图、断言 `joint` 出现在 `op` 之前（`amos-tauri` 的
`RotationGlue` 跨语言绑定用的同一 idiom）；**(b)** 断言 `encode()` 的第 2 字节确是关节号、第 3 字节确是
op code（非零关节 + 可区分的 op，交换必然红）。

**验证**：`cargo test -p amos-robot` ⇒ **318 lib + 32 集成 + 12 doctest** 全绿（+1 单测）；clippy
`-D warnings` 0 告警；fmt 净；`fmea-gen --check` OK（+1）。**负控（先红后绿，逐字节还原）**：先写测试 ⇒
红并把那张图原样打出来；修图后复绿；再把 `1-byte id (joint) ‖ 1-byte op` 改回
`1-byte op ‖ 1-byte joint` ⇒ 红；`cp` 还原后 `shasum -a 256` 与修前一致（`0ca05cee…d5ac22`）复绿。

**如实边界**：本轮只改模块文档的**文字** + 新增一条单测，行为/常量/算法一行未动。单测钉的是**顺序**，
**不**校验图上其余字段（`4-byte arg`/`2-byte CRC`/SOF 值）的文字正确性。`include_str!` 让测试与源码
同文件——图若移出该文件（如移入 `docs/`），测试会因找不到那句而**响亮**失败（`expect`）而非静默通过。
**出处如实**：该图所在的模块文档扩写（`delimited`/`turnaround` 段落）是**工作区未提交**内容，`git show
HEAD` 的旧版本是另一句 ``0xAA ‖ 10-byte MotorFrame ‖ 0x55``（与 `encode` 的 10 字节也不符，但**没有**
字段倒序），故 `git show HEAD` 对本句无判别力；本轮凭 `amos_link` 线格式文档、`encode` 与本文件既有
测试三处**稳定权威**核实，价值一半在消除危险文本、一半在那条顺序断言。

## 29. 补全（REQ-A687）：安全监视器 `sanitise` 的文档把两种补救说成了同一种（2026-09-20）

`crates/amos-robot/src/safety.rs` 的 `SafetyMonitor::sanitise` 在构造时把「越界」的阈值拉回域内。
它的文档写：

> Replace every out-of-domain limit with its **default**. … or when it exceeds the geometric maximum for
> its unit ([`MAX_DIVERGENCE_LIMIT_RAD`], [`MAX_TILT_LIMIT_RAD`]) and so could never fire …

即：**所有**越界都被替换为**默认值**，且「超过几何上限」被显式列为越界的一种。而代码（`safety.rs:300-312`）做的是：

```rust
max_divergence_rad: if limits.max_divergence_rad.is_finite() && limits.max_divergence_rad > 0.0 {
    limits.max_divergence_rad.min(MAX_DIVERGENCE_LIMIT_RAD)   // 钳到上限
} else {
    DEFAULT_MAX_DIVERGENCE_RAD                                // 只有零/非有限才落默认
},
```

`max_tilt_rad` 同形（`.min(MAX_TILT_LIMIT_RAD)`）。所以两种补救**恰恰不同**：`≤0`/NaN → 默认；`> 上限` →
**钳到上限**。文档把其中一种说成了另一种。

这不是措辞问题。`sanitise` 的存在理由正是「拒绝静默关闭规则」，而文档恰恰在这件事上说错：读它的部署会
**以为**配了 `1e30` 就退回默认的 `0.2 rad`（紧），实际执行的是 π（`R3`）/π/2（`R4`）（**最松**）。对「R3 何时
触发」的推理会全错。判据同本仓「文档必须与代码一致，否则文档就是缺陷」（与 REQ-A686 同一条），而此处
文档与代码**同时可观测**——`SafetyMonitor::limits()` 是 public 读回。

**修法（改文档、不改行为）**：`sanitise` 的 doc 重写为两条互补的补救——`zero/non-finite → default`（没有
有意义的值可钳，NaN/∞ 连界限都不算）、`above the geometric maximum → clamped to that maximum`（有限的
大数仍带调用方「要松」的意图，故取规则表能陈述的最松界限，**不是**默认）；并加一句「读回 `limits()`
看是哪一种——两者可观测且不同」。**行为一行未改**：`min()` 保留，因为既有测试
`an_oversized_limit_is_clamped_to_the_geometric_maximum` 早已**刻意**钉住钳位——本轮只是让文档追上它。

并把「两种补救不可互换」变成会跑的断言：给该既有测试补两条 `assert_ne!`
（`max_divergence_rad != DEFAULT_MAX_DIVERGENCE_RAD`、`max_tilt_rad != DEFAULT_MAX_TILT_RAD`），于是任何
**照旧文档承诺**去「修」钳位（把 `1e30` 变成默认）的后续改动会**变红**，而不是静默通过。

**验证**：`cargo test -p amos-robot` ⇒ **318 lib + 32 集成 + 12 doctest** 全绿；clippy `-D warnings` 0 告警；
fmt 净。**负控（先红后绿，逐字节还原）**：把 `sanitise` 的越界臂改成旧文档所允诺的行为（`<= MAX` 才取原值、
否则落 `DEFAULT_*`）⇒ `an_oversized_limit_is_clamped_to_the_geometric_maximum` **恰红**，打印
`left: 0.2  right: 3.1415927`（默认 vs π，正是两种补救的分歧）；`cp` 还原后 `shasum -a 256` 与扰动前一致
（`af1dd7a9…714f6`）复绿。

**如实边界**：本轮只改文档文字 + 既有测试的两条断言，行为/常量/算法一行未动。新断言钉的是**越界一种**
补救的具体取值（钳到 π/π/2 而非默认），**不**校验零/非有限那一支（由既有
`a_zero_or_invalid_limit_is_replaced_with_a_safe_default` 守护）。`assert_ne!` 是**单向**的——它拒绝「落到
默认」的改动，却不排除把上限钳成别的**非默认**值（真正的护栏是那条
`assert_eq!(.. == MAX_DIVERGENCE_LIMIT_RAD)`）。文档是文本，除这两条断言外无门能证明其真伪。

## 30. 补全（REQ-A689）：UDP 建议上限的文档把策略数说成了测量（2026-09-20）

`crates/amos-robot/src/driver/udp.rs` 导出 `MAX_UDP_DISCOVERY_BYTES: usize = 1024;`，注释（修前）是这样的：

```rust
/// Advisory largest datagram payload (8-byte CAN + 2-byte envelope + safety margin).
///
/// // measured: comfortably under the 1472-byte payload a 1500-byte Ethernet MTU leaves
/// after IP/UDP headers, with margin for a future envelope. This crate does **not** enforce it…
```

两处不真：

* **推导加不到它自己**。括号里 `8 + 2 + safety margin` 的三项，`8 + 2 = 10`，而常量是 `1024`——相差
  100 倍。括号不可能是 1024 的来路，只能是一个残余的、描述「一帧大概多大」的错位注释。
* **标记与实际相反**。`// measured:` 是对**可复现测量**的断言，而 1024 是一个圆整的**策略**数；这个 crate
  从不测量数据报大小，常量甚至**不被强制**——同一段注释的下半句自己就写着 `This crate does not enforce
  it`（motor 路径真正被 `FRAME_LEN` 限死在 10 字节）。

这不是措辞问题：读者会**以为** 1024 是量出来的（因而有经验证据撑着）、且 `10` 是它的来路，据此以错误的
把握去配缓冲。同族是本仓反复修过的一类——**策略数穿 `// measured:` 标记**，`safety.rs` 的四个
`DEFAULT_*` 即前例。判据同本仓「`// measured:` 只标注真实测量，策略数一律 `// chosen:`」。

**修法（改注释、不改值）**：标记改 `// chosen:`；删掉那个加不到自己的括号推导，改述为「1024 是圆整的
**借用**上限，位于 1472 字节之下（1500 MTU − 20 IP − 8 UDP），留出信封余量；确切数字是本 crate 的策略」；
保留「本 crate **不**强制它」一句。**值仍是 1024，一行未改。**

并把「标记必须如实」变成会跑的断言——新增单测 `the_advisory_datagram_ceiling_is_chosen_not_measured`：
`include_str!("udp.rs")` 读回本文件的 doc 块（声明行之上连续的 `///` 行），断言其中**含** `// chosen:`、
且**不含** `// measured:`（散文可以*讨论*旧标记，但不得**佩带**它）。doc 块被移出该文件时测试会**响亮**
失败（`expect`）而非静默通过。

**验证**：`cargo test -p amos-robot` ⇒ **319 lib + 32 集成 + 12 doctest** 全绿（+1 单测）；clippy
`-D warnings` 0 告警；fmt 净。**负控（先红后绿，逐字节还原）**：先写测试 ⇒ 红并打出整个 doc 块；改注释
后复绿；再在 `// chosen:` 行前插回 `// measured:` ⇒ 红；`cp` 还原后 `shasum -a 256` 与修前一致
（`175921eb…3d60`）复绿。

**如实边界**：本轮只改注释/标记，常量值 `1024` 与任何行为一行未改。新断言钉的是**标记本身**
（`chosen` 在场、`measured` 不在），**不**校验 `1024` 这个数是否「最优」——那是策略，任何门都读不出。
子串断言对「散文里出现 `// measured:`」也会拒绝，这是**有意**的粗界（宁可让作者换个说法），本 doc 遂以
「advertised a measured provenance」措辞规避。常量**不被强制**是既有 REQ-A503 已记录并保留的诚实边界，
本轮未改其含义。**并发**：落笔前 `REQ-A688`/`F-SH-149` 已被一个并发的**前端轮**（`filesPreview.ts` 的
MIME 表）占用，故让号改取 **REQ-A689 / F-SH-150**——这是本工作区连续第三次真实撞号（前两次见 REQ-A686
与 REQ-A687 两条）。

## 31. 补全（REQ-A691）：`dwa` 弧线积分器的初值单位无测试保护、注释却自称有（2026-09-20）

`planning.rs` 的 `dwa` 在动态窗里模拟每条候选弧线，积分器把 `pose.heading_mrad`——**毫**弧度——换到弧度：

```rust
let mut heading = pose.heading_mrad as f64 / 1_000.0;
// …每个子步：
heading += w * dt_s / 1_000.0;   // `w` 是 mrad/s
```

积分器上方的注释（修前）写：

```text
// Simulate: `(north, east)` along a circular arc for `DWA_HORIZON_STEPS`
// sub-steps. The integrator is the same midpoint rule the [`pursuit`]
// tests use (the test on this file pins the geometry).
// … feeding milliradians to `sin`/`cos` silently rotated every trajectory by a
// factor of 1000 (measured: a commanded `ω = -100` drove `heading` to -100,
// where `cos(-100 rad) ≈ 0.86`).
```

两处不实，加一处**真的**测试盲区：

* **注释张冠李戴，且承诺了一个不存在的测试。** `pursuit` 是**转向律**——它算出瞄准点与转向角，**没有积分器**；
  midpoint 规则真正在用的是**闭环夹具** `BikeModel`（`tests/stack_e2e.rs`、`examples/patrol_loop.rs`）。而「the
  test on this file pins the geometry」在本文件里**没有**对应用例——于是这句话把「无保护的换算」读成「有保护的
  几何」。
* **`// measured:` 标在了一段手工推导上。** `cos(-100 rad) ≈ 0.86` 是算术，不是测量；没有任何测试跑过那个
  「把毫弧度喂给 `cos`」的旧世界。按本仓标记纪律（策略数 `// chosen:`、真实测量才 `// measured:`），它是误标。
* **测试盲区（真）**：整套 `dwa` 用例里带非零 `heading_mrad` 的不少（如 `dwa_does_not_tunnel_through_a_cell_between_two_samples`
  与 `dwa_treats_leaving_the_map_as_a_collision` 的 `1_571`），但它们钉的是**结果**——到达哪个格、是否回退停车——
  不是朝向的**单位**。把这些用例的结果主导的路径颠倒过来的是穿墙与出界，与初值朝向无关。因此，若把**初始**换算的
  `/ 1_000.0` 删掉（**保留**每步增量的换算，于是其余用例照绿），本模块 15 条 `dwa` 用例里**恰 1 条**红：

  ```rust
  fn dwa_scales_the_heading_from_milliradians()  // 本轮新增
  ```

  它给一台**朝东**（`heading_mrad = 1_571`）、目标在**同一排正东** 17 m 的机器一条**宽**偏航窗
  （`max_omega = 2_000`、`max_alpha = 20_000`、`dt = 0.05` ⇒ 窗 ±1 000 mrad/s、步长 ≈222），让「不需要转」与
  「该猛转」落在明显不同的采样上，断言选中的 `|ω| < 500`。**实测**：修好的代码选 `-111`（窗内最靠近 0 的采样），
  仅把初始换算写成 `pose.heading_mrad as f64` 后选 `+1000`（撞栏）——两侧各留约 4× 余量。

**修法**：新增上面那条用例；把注释改述真值——midpoint 规则来自闭环夹具 `BikeModel`、`pursuit` 没有积分器、
几何由新用例钉住、`// measured:` 降为陈述。**`dwa` 的数值行为与任何常量一行未改。**

**诚实边界**：新用例用合成栅格与显式 limits，证明的是积分器对**初值单位**的敏感度，不覆盖真实车辆动力学；
阈值 `500` 是**判别阈值**而非物理量。本轮末 `planning.rs:1646` 另有一处 `// measured:`（「6 m 投影 + 3 m
lookahead 报起始格」）**未处理**——它与 `a_pursuer_never_aims_behind_itself` 的夹具同源、算术自洽，属较弱的
另一线索，留待后续轮。**并发**：落笔前重探，`F-SH-152`/`F-SH-153`/`REQ-A692`/`REQ-A693` 已被并发**前端轮**
（`buildIdentity`/`link.ts` 镜像）占用，故 FMEA 号取 **F-SH-154**（`grep -rn` 零命中）；`REQ-A691` 仅本轮
`planning.rs` 一处命中。

## 32. 补全（REQ-A701）：`safety` 明说它看不见的「环停」情形，此前无任何补件——外部看门狗（2026-09-20）

`safety.rs` 的 `R1`（看门狗超时）**自己声明了它的盲区**（「What `R1` can and cannot see」）：它测的是**调用方上报**
的间隔 `Heartbeat::elapsed`，本文件里 `Instant::now` 一次都不出现；一条**跑得慢**的环它看得见，一条**彻底不再调用**
的环它看不见——那种情况下本文件没有任何代码会运行。同段把补件点名了：「Detecting a fully-hung process is the job
of an outer watchdog (a hardware timer, or a supervisor task that itself owns a clock).」本仓在**本轮之前没有**
这个 supervisor。`safety.rs` 的「What is not wired」又补一句：连 monitor 自己都还没人调用。于是「最后一层」是
**设计意图**，不是**在跑的管线**。

本轮补的就是那句被点名、却从未存在的 supervisor：新模块 `crates/amos-robot/src/watchdog.rs`。

**分工即要点**（监控侧不持锁、不读钟；监督侧持钟）：

```text
  控制环（可能已挂）              监督任务（自己持钟）
        │ 每 tick pet() ──► PetCounter ──► Watchdog::poll(now)
        │   （一次 relaxed 原子加）            │
        ▼                                       ▼
     驱动机器                       Alive  |  Expired { silent_for }
```

* `PetCounter(Arc<AtomicU64>)`——被监控侧的存活令牌；`pet()` 一次 `fetch_add(1, Relaxed)`，**不读钟、不加锁**；
  `count()` 读回。
* `Watchdog`——监督侧；持 `last_count`/`last_change`/`deadline`/`expirations`。`poll(now)` 取 `now` 作**参数**而非
  自己读钟，故过期逻辑**可确定性测试、不需要真实时间**——与 `CycleStats`「仪器测量、调用方持钟」同一条规矩。
  令牌推进即**重新武装**（把 `now` 记为 `last_change`，答 `Alive`）；否则在静默**严格大于** `deadline` 之后答
  `Expired { silent_for, count }`（恰好等于 `deadline` **尚未**过期——`>=` 会早一格触发，被 `the_deadline_is_a_strict_boundary` 钉住）。
  首次推进之前，静默从**构造**起算——于是「从未 pet 的环」与「pet 过又停的环」以同一方式过期。
* `WatchdogError::{ZeroDeadline, ZeroPollInterval}`——零期限被拒（在它自己的 `poll` 上就会触发的看门狗不是看门狗）。
* `supervise(watchdog, poll_interval, stop)`——**唯一读真钟处**（`tokio::time::interval` + `MissedTickBehavior::Delay`）；
  每次 poll 前检查 `stop`，已置位则**零次 poll** 返回 `Stopped`（与 `ControlLoop::run_until` 同规矩）；否则返回首个 `Expired`。
  测试**不用**它：`Watchdog::poll` 由测试直接驱动以求确定性；它的存在只是为了让部署有东西可 spawn。

**接线（本轮新增，向后兼容）**：`ControlLoop` 增一个**可选** `PetCounter`。

```rust
pub fn with_watchdog(mut self, counter: PetCounter) -> Self   // 可选项接入
pub fn pet_counter(&self) -> Option<&PetCounter>              // 读回
```

`tick()` 在 `bridge.step()` **返回之后**、成功与失败**都** pet：一次**跑过并报错**的 tick 仍是**活环**，把「链路断了」
与「环停了」混为一谈会让看门狗因错误的原因触发。pet 放在 step **之后**是刻意的：**挂住的 step 永不返回、于是永不 pet**，
看门狗过期——这正是令牌存在的意义。未接令牌的环行为**一字未变**。

**测试（12 条新增：`watchdog.rs` 10 + `control.rs` 2）**：

* 确定性单元：零期限被拒；`pet()`/`count()`；**严格边界**（恰好 = deadline 存活、+1 ns 过期）；一次 pet **重新武装**
  且重新起点是**看见推进的那次 poll 的 `now`**；每次过期都计数；过期后 pet 又答 `Alive`（看门狗是**重新武装**，不是闭锁）。
* 异步（`#[tokio::test(start_paused = true)]`，精确）：零轮询间隔被拒；已置 stop **零次 poll** 返回 `Stopped`；
  **从不 pet 的令牌**令 supervisor 过期并返回 `Expired`；一个**独立 pet 任务**让 supervisor 越过四个期限**仍不**过期
  （用 `tokio::time::timeout` 抢先判定）。
* 接线（真 `ControlLoop` + 真 `MockRobotHal`）：跑 4 tick ⇒ `counter.count() == 4`（每 tick 一 pet），运行中 poll 答
  `Alive`，停下来后 `t0+111 ms`（静默 51 ms > 50 ms 期限）答 `Expired`；无令牌的环 `pet_counter()` 为 `None`。

**负面控制（扰动–复位，逐字节）**：① 把 `silent_for > self.deadline` 改成 `>=` ⇒ `watchdog.rs` 恰 3 条红
（`the_deadline_is_a_strict_boundary`、`a_pet_re_arms_the_deadline_from_the_poll_that_saw_it`、`supervise_expires_a_loop_that_never_pets`），
其余 7 绿；② 删掉 `tick()` 里的 `pet.pet()` ⇒ `control.rs` 恰 1 条红
（`a_stopped_loop_expires_an_external_watchdog`，断言落在「the loop pets once per tick」）。两次扰动后
`shasum -a 256` 逐字节复原：`watchdog.rs 96fb15fe…`、`control.rs fef76ea8…`。

**诚实边界**（与模块文档同）：① 这是**软件** supervisor，不是**硬件**看门狗——只有当 supervisor **自身**还在跑时，
它才看得见被监控任务挂掉；整个进程都卡住（第三方持有全局锁、调度器饿死、CPU 停机）时**两侧都不跑**，只有外部定时器
或第二个核能察觉。它对 `R1` 的增益**恰好**是 `R1` 看不见的那一格：一个任务停了、其余进程健康。② **只报不做**：
`poll` 返回判决；停机是部署的决定。③ **期限是策略，不是测量**：本 crate 没测任何任务的失效模式。④ **pet 是存活证明，
不是进度证明**：tick 却空转的环照样 pet。

**并发**：落笔前重探高水位取 **REQ-A700 / F-SH-160**，但在落账过程中一个并发**分屏轮**（`amos.split` 持久意图，见 FMEA F-SH-160）在**同一对号**上落账，故本轮**让号**改取 **REQ-A701 / F-SH-161**（`grep -rn` 均零命中；该并发轮还覆写了本层 `docs/TRACEABILITY_MATRIX.md` 末尾，使本行首写丢失，已按新号补回）。
**新增 dev-dependency**：`tokio` 的 `test-util` feature（仅为 `#[tokio::test(start_paused = true)]` 的精确异步用例；
生产代码不读任何未交给它的钟）。`cargo clippy -p amos-robot --all-targets -- -D warnings`、`cargo fmt --check` 与本层
`332 单元 + 32 集成 + 12 doctest` 全绿。

## 33. 补全（REQ-A707）：机器人栈的 API 文档里 13 处死链 + 2 处与代码相反的断言，而 `cargo doc` 无门禁（2026-09-20）

**缺口（核实）**：`cargo doc -p amos-robot -p amos-link --no-deps` 实测 **13 条 warning**，全部是本轮之前就存在的。
**死链（12 + 1）**：`amos-link` 12 处——公开项的文档把链接指向**私有**项（`RelayCounters`、`match_segments`、
`decode_ingress`、`armed_after`、`RefusalWire`×2、`ActuationStateWire`×3），rustdoc 对这类链接**静默降级**为普通文字，
读者点不开、也看不出它**曾经**是链接；`telemetry.rs` 与 `service.rs` 里 `HealthReason::detail`、`Subscriber::recv_beat`
因不在各自模块作用域而**未解析**；`qos.rs` 的 `[`Channel`](crate::keyexpr::Channel)` 是冗余显式目标。`amos-robot`
1 处——`fusion.rs` 的公开方法 `AllanVariance::new` 文档链到私有常量 `ALLAN_MAX_WINDOW`。

**与代码相反的断言（2）**：① `planning.rs` 的「诚实边界」第 2 条：占据栅格估计 "that is the SLAM front-end,
**still absent**"——而 `slam/occupancy` 早已发布 `occupied_mask()`，并被 `Grid::from_occupancy` 消费
（`slam/occupancy.rs` 有测试 `the_occupied_mask_matches_classify_and_feeds_the_planner` 钉住这条接线）；
② `driver/serial.rs` 的「现场笔记」：编码器回读 "lives in [`crate::slam`] instead, which **subscribes to its own
topic**"——而 `slam` 无任何订阅、无异步、无 IO（`lib.rs` 明说本 crate 每个模块都 offline）。

**为什么是缺陷**：公开 API 文档是使用者读的第一手材料。指向私有项的死链与「画了个不响的开关」同类；而两条与代码
相反的断言更坏——它们是**关于代码的事实**，会误导下一个接线者：照着 `planning.rs` 去重造一个已存在的占据栅格，
照着 `serial.rs` 去 `slam` 里找一个并不存在的总线订阅。并且 `cargo doc` **不在任何门禁里**（Makefile 与
`scripts/*.mjs` 无一条 rustdoc 检查），所以这类腐烂没有任何声音。

**修法**：① 13 处死链全部修正——私有项改普通反引号、未解析名补全路径
（`crate::health::HealthReason::detail` / `crate::pubsub::Subscriber::recv_beat`）、冗余显式目标删去；
② 两处矛盾改写为与代码一致（`planning.rs` 指明 `slam/occupancy`→`Grid::from_occupancy` 的存在，但「把活地图
接进活计划」是调用方的循环；`driver/serial.rs` 明说本 crate 的 HAL 是**只写**的、回读需要 §5 的 Phase-2 帧通道，
且 `slam` 不读任何线）；③ **门禁**：在 `crates/amos-link/src/lib.rs` 与 `crates/amos-robot/src/lib.rs` 的 crate
根加 `#![deny(rustdoc::broken_intra_doc_links, rustdoc::private_intra_doc_links, rustdoc::redundant_explicit_links)]`
——把「文档不得有死链」变成**编译器强制**的断言，形状与 P0-1 门禁一致；④ `slam/mod.rs` 补导出
`ASSOC_CANDIDATES`/`CHI2_2DOF_95`，使它模块头那句「每个公开项都从 `slam::` 可达」为真。

**验证**：`cargo doc -p amos-robot -p amos-link --no-deps` ⇒ **13 warning → 0**，deny 下复跑净（`Finished`）；
`cargo clippy -p amos-robot -p amos-link --all-targets -- -D warnings` 净；`cargo fmt --check` 0 diff；
`cargo test -p amos-robot` ⇒ `332 单元 + 32 集成 + 12 doctest` 全绿。

**负面控制（扰动–复位，逐字节）**：把 `crates/amos-robot/src/fusion.rs` 的 `ALLAN_MAX_WINDOW` 反引号改回链接形式
⇒ `cargo doc -p amos-robot` **硬失败**（`error: public documentation for `new` links to private item
`ALLAN_MAX_WINDOW``、`error: could not document `amos-robot``，exit ≠ 0）；`cp` 逐字节还原后
`shasum -a 256 crates/amos-robot/src/fusion.rs` = `26e14df36648f28b9c52c0e6b2c54939c3bc85e60dde1f143cf19312df048163`、
`cargo doc` 复净。

**诚实边界**：① 本轮是**文档完整性**修复，不改任何算法/控制/安全行为；② 门禁是 **rustdoc lint**，只在 `cargo doc`
时生效——`cargo build`/`test`/`clippy` 不受影响，故若 CI 从不跑 `cargo doc` 则门禁不触发（lint 属性本身的边界）；
③ 两处矛盾改写的是**散文**，代码一行未动（接线本就存在，只是 `planning.rs` 的说明过时）；④ `slam/mod.rs` 的补导出
使两个常量可从 `slam::` 直接引用，未改其值；⑤ 本轮**未**在 Makefile/CI 里新增 `cargo doc` 调用——门禁属性已就位，
把它接进流水线是另一件独立的活。

**并发**：落笔前经 `grep -rhoE` 重探，`REQ-A703`/`F-SH-163` 已被并发轮占用，高水位为 **REQ-A706 / F-SH-165**，
故取 **REQ-A707 / F-SH-166**（`grep -rn` 零命中）。

---

## 34. 补全（REQ-A716）：机器人能回答「我在哪」的**另一半**此前不存在——已知地图上的**全局定位**（粒子滤波 MCL，2026-09-20）

**缺口（核实）**：§5 把「定位（在已有地图上）」列为未做；§0 说链路层之上那一层（"我在哪"）是空的。
本仓此前**唯一**的位姿来源是 `slam` 的 **EKF-SLAM**，而 EKF 的信念是**单峰**的：一个均值 + 一个协方差。
这对"位姿已知、只需跟踪"是正确形状，却**结构上做不到**全局定位——一旦信念有两个同样可能的假设
（"我在四条一模一样的走廊里的哪一条"），就没有一个均值可握。仓库里**没有任何**能处理多峰信念的组件：
`crate::slam` 的五个子模块（ekf / landmarks / data_assoc / loop_closure / occupancy）全是围绕单一高斯建的。

**补什么**：新增 `crates/amos-robot/src/localization.rs`——**蒙特卡洛定位（MCL）粒子滤波**（Thrun/Burgard/Fox
*Probabilistic Robotics* 第 8 章），在**已知**地标地图上回答问题。与 EKF 的分工写进模块头表格：
信念 1 个高斯 vs `N` 个加权样本；地图**被估计**（SLAM）vs **被给定**；全局定位 无 vs 有；每步代价 `O(L²)` vs `O(N·Z·L)`。

**接口**（全部有界，静态上限见常量）：
- `McLocalizer::new(map, control)` —— 云在**地图包围盒 + 2 m 边距**内**均匀**撒开、航向均匀（全局定位）；
  `new_at(map, control, x, y, θ, σ_m, σ_θ)` —— 云围绕**已知位姿**收成高斯（跟踪）。
- `predict(VelocityCommand)` —— 逐粒子采样运动模型（`v/ω/航向` 三路噪声，σ 按 `√dt` 缩放）；非有限或 `dt ≤ 0` **静默拒绝**，
  信念纹丝不动（运动步没有"做一半"的失败模式，与 `EkfSlam::predict` 同规）。
- `update(&[SlamObservation])` —— 逐读数对**全地图**地标取**最大似然**关联（无门限，见边界 6），
  逐粒子在 **`f64` 对数空间**累加再指数化（长扫掠不会先把乘积下溢成 0）；`ESS < ratio·N` 时**系统重采样**。
- `estimate() -> PoseEstimate { x, y, θ(圆周均值), 3×3 协方差, health, effective_particles, match_quality }`；
  `PoseEstimate::to_pose()` 给出 `planning::Pose`（mm / mrad）。
- 三种判定 `LocalizationHealth::{Converged, Uncertain, Diverged}`；`match_quality = exp(-½ · minₚ Σ_z νₚ,ᵢ)`
  是"地图在**最好**的那个粒子处能把整批读数解释到多好"的**有界**一致性分（不是概率密度——高斯归一化常数在粒子间是常量，约掉了）。

**边界与拒绝**（`LocalizationError`，全部有名字）：空地图、地标 > `MAX_LOCALIZATION_LANDMARKS`(256)、
单批读数 > `MAX_OBSERVATIONS_PER_UPDATE`(64)、粒子数 ∉ `1..=MAX_PARTICLES`(4096)、参数非有限/越界
（负方差、非正 σ、重采样比不在 `(0,1)`、`diverged_radius < converged_radius`）、方差 ≤ 0 的读数。

**roughening（本轮发现的真问题，非装饰）**：先按教科书实现 predict/weight/resample 后实测**坍塌**——
重采样把幸存者**原样复制**，几十步后云变成同一个样本的 `N` 份拷贝，`σ_p → 3.8e-5 m`，
估计冻结在种子格点上、永远无法比它被复制来的那个样本更准（有测试 `without_roughening_the_cloud_degenerates` 钉住）。
修法是 Gordon/Salmond/Smith (1993) 的 **roughening**：每次重采样后给每个粒子加 `resample_jitter_m`(5 cm) /
`resample_jitter_rad`(0.02 rad) 抖动，云于是每步都有新位置可供加权更新**选择**，也才有
`roughening_lets_a_stationary_filter_refine`（静止 40 步收敛到真值 0.25 m 内）。这也是
`converged_radius_m` 取 0.25 m 而非厘米的**诚实原因**：收敛后的散布下限由抖动定，不由传感器定。

**零分配**：`predict` / `update` / `resample` / `estimate` **一次分配都没有**——对数权重缓冲 `log_weights`
与重采样缓冲 `resample_buf` 由滤波器自持并复用（`resample` 走 `mem::take` → 填充 → `src.clear()` 回收旧云那块分配）。

**确定性**：`SmallRng::seed_from_u64(control.seed)`；同 seed + 同输入 ⇒ 粒子**逐位相同**（`the_same_seed_gives_the_same_particles`）。

**验证**：`cargo test -p amos-robot` ⇒ **358 单元**（本轮 +26）+ 32 集成 + 12 doctest 全绿；
`cargo clippy -p amos-robot -p amos-link --all-targets -- -D warnings` 净；
`cargo doc -p amos-robot -p amos-link --no-deps` 净（REQ-A707 的 deny 门禁在）；`cargo fmt --check` 0 diff。

**负面控制（实测）**：①把 `McControl::default` 的 `resample_jitter_m` 置 `0.0` ⇒ `roughening_lets_a_stationary_filter_refine` 与 `global_localization_converges_from_a_uniform_cloud` **各恰 1 红**（`24 passed / 2 failed`，即证 roughening 确为收敛所必需——去掉它云就冻结在种子格点上）；逐字节还原后 `shasum -a 256 crates/amos-robot/src/localization.rs` = `483aba24fdc39b9f8a501299925015b106a31eb33456eff4b6d7ff692d3bce73`、复绿 **26 passed**；
② 地图整体平移 100 m ⇒ `match_quality < MATCH_QUALITY_FLOOR`(0.05) 且 `health == Diverged`
（`a_wrong_map_is_reported_as_diverged_not_converged`）——地图与读数不符时**不许**报 Converged。
③ 对称地图（正方形四地标）在全局测试里**会**收敛到真值的 90° 旋转像（最大似然关联使地标不可分辨），
故全局测试改用无旋转对称的 `asymmetric_map()`；这条限制本身写进了边界 5。

**诚实边界**：① **只定位、不建图**——地图是给定的，错地图 ⇒ 自信的错位姿（边界 5）；
② **检测 + 恢复**——地图哪都解释不了时全体粒子似然一起塌、`match_quality → 0`、判 `Diverged`；
自 REQ-A1493 起**并且重新播种**（sensor resetting / Lenser & Veloso）：发散步上按
`McControl::sensor_reset_ratio`（默认 0.3）把一部分粒子**从位姿先验重抽**（在地图包围盒上均匀撒、
忘掉运动模型）、再对同一次扫描**重新打分**，让新假设与幸存者同场竞争权重。无解析逆观测模型时，
"从 `p(x|z)` 采样"由**均匀提议 + 传感器似然重加权**实现（Lenser & Veloso 的实用形式）。救援是
**有界的**：至多 `ratio · N` 个粒子移动、且只在"读数哪都解释不了"的步上——收敛的信念不受影响；
`sensor_reset_ratio = 0.0` 退回**只检测**的旧行为。被搬走的机器人现在**被救**而非只被报失；
③ 关联是**最大似然、无门限无迟滞**（与 `slam::associate` 的马氏门限相对），短暂遮挡不会持续错关联，
但"错而近"的地标也会全额计入；④ `f32` 状态、2-D；⑤ 收敛后的协方差是**云的散布**，
云可以**又紧又错**（对称地图留下一个自洽假设），此时协方差不报错、`match_quality` 也还高——调用方拿不到任何信号；
⑥ **退化传感器 = 退化滤波器**：无噪声读数使似然成为 δ 函数，最近粒子与次近粒子的权重比任意大，
权重塌到一个粒子上、`match_quality` 暴跌（尽管估计离真值只有厘米级）——喂真实方差，别喂 0（`update` 也拒绝 0）。
⑦ 本轮**纯增量**：`amos-robot` 既有模块一行未改，`lib.rs` 只加 `pub mod localization` 与 `pub use`。

**并发**：落笔前 `grep -rhoE 'REQ-A7(1[0-9]|2[0-9])'` 重探，`REQ-A715`/`F-SH-173`（`amos-link-cc` C 头文件安全契约，
本回合期间由并发轮落入 inventory）已被占用，故取 **REQ-A716 / F-SH-174**（`grep -rn` 零命中）。

## 35. 补全（REQ-A720）：MCL 说它消费「SLAM 产出的地标云」——被点名的类型拿不出地标，两张上限还互相矛盾（2026-09-20）

起点是「继续审计与补全代码，完善功能」。上一轮（REQ-A716）刚把 MCL 粒子滤波交给 `amos-robot`，
这一轮自审它最重的一条断言，三处都落在**同一个接缝**（`slam` 与 `localization` 之间）。

**① 缺陷（核实）：被点名的产出类型拿不出地标。** `localization.rs` 边界 1 原文写
「It consumes the [`Landmark`] cloud that [`crate::slam::EkfSlam`] produced」。而 `impl EkfSlam` 的公开面只有
`pose` / `num_landmarks` / `predict` / `observe`——`awk` 切出整个 impl 块，`fn landmarks` 命中 **0**；
内层 `state: SlamState` 是**私有字段**。地标切片实际在 `SlamState::landmarks()`（`pub`，且 `slam/mod.rs:52`
已 `pub use SlamState`）。**照文档点名的类型走，这条工作流做不出来**——调用方会被引到一个没有该访问器的类型上。
（同文件 8 行之上就有一个前例：`EkfSlam` 的 `with_control` 文档曾宣称一个不存在的 setter，因零引用被删。）

**② 第二处缺陷（本轮新增的接缝测试当场撞出）：两张上限互相矛盾。**
`slam::MAX_LANDMARKS` = **512**，`localization::MAX_LOCALIZATION_LANDMARKS` = **256**——EKF **允许建**的地图
（257..=512 个地标）会被它文档里指定的消费者以 `TooManyLandmarks` **拒绝**。两个上限各有理由
（EKF 的上限约束**状态规模** `3+2L`，协方差按 `L²` 增长；本模块的上限约束**单步工作量** `O(N·Z·L)`），
所以修法**不是**把小的抬到大的（那会让单步最坏情况翻倍，与该常量自己的理由相反），
而是把接缝的契约**写明**：超过本模块上限的 SLAM 地图**被拒**而非被静默截断，拒绝里带计数，
调用方自己决定保留哪 256 个。这一处是**新增测试里的一条 `const` 断言**在编译期撞出来的
（`const _: () = assert!(MAX_LANDMARKS > MAX_LOCALIZATION_LANDMARKS)`），不是事后读出来的。

**③ 第三处（常量自述里的数）：自己低报自家上界 4 倍。**
`MAX_LOCALIZATION_LANDMARKS` 的 `// chosen:` 引「`512 · 16 · 256 ≈ 2.1 M` likelihood evaluations」，
而 crate 自己的 `max_step_evaluations()` 用的 `Z` 是 `MAX_OBSERVATIONS_PER_UPDATE`（**64**）：
`512 · 64 · 256 ≈ 8.4 M`。自述里的「16」是一次典型扫掠，不是**上界**——而这一行存在的理由正是
「让调用方按上界做预算」。改为按 `max_step_evaluations()` 的口径给数，并把 16 如实标为「典型扫掠」。

**④ 修法（只改文档 + 新增接缝测试，一行生产逻辑未动）**：
- `localization.rs` 边界 1 改写：产出者改为 `crate::slam::SlamState::landmarks`，并**注明** `EkfSlam` 无地标访问器；
  同时补上一句此前没说的事——SLAM 地图携带的**每地标 `cov` 被本模块丢弃**（「当作地面真值」等于「连没收敛的地标也一样信」）。
- 新增边界 **10**：本模块接受的图上界（256）**低于** SLAM 能建的上界（512），超限**被拒**、带计数、需调用方裁剪，
  接缝由 `tests/localization_e2e.rs` 钉住。
- 新增 `crates/amos-robot/tests/localization_e2e.rs`（**5 用例**）：把「EKF 建图 → MCL 定位」这条此前只有散文的
  数据流变成**会跑的接缝**——`SlamState` 在真位姿上原地盘测出 5 个地标，`landmarks()` 取出、原样交给
  `McLocalizer`；同一位姿下喂读数，滤波器**保持**该位姿（若地图的坐标系/单位/方位约定与滤波器的测量模型不一致，
  更新会把估计拖离真值，于是红）；空地图（只 `predict` 未 `observe` 的 SLAM 态）在接缝处被 `EmptyMap` 拒绝；
  超限地图被 `TooManyLandmarks{given}` 拒绝，且两张上限的大小关系是**编译期**断言。

**验证**：`cargo test -p amos-robot` ⇒ **358 单元** + **37 集成**（本轮 +5，来自新接缝套件）+ 12 doctest 全绿；
`cargo clippy -p amos-robot -p amos-link --all-targets -- -D warnings` 净；
`cargo doc -p amos-robot -p amos-link --no-deps` 净（REQ-A707 的 rustdoc deny 门禁在）；`cargo fmt --check` 0 diff。
（§34 记的「32 集成」是**该轮当时**的数；本轮起为 37。）

**负面控制（实测，逐字节还原 + `shasum -a 256`）**：
① 把 `best_landmark_nees` 的预测方位由 `wrap_angle(dy.atan2(dx) - p.theta_rad)` 改成 `wrap_angle(dy.atan2(dx))`
（抹掉机器人航向项，即破坏「同一约定」）⇒ 新接缝套件**恰 1 红**（`the_localizer_holds_the_pose_the_slam_map_was_built_from`；
另 4 绿），同时 `localization` 单测 **3 红**（共享该约定的三条），即证第 2 条断言**确在读它拿到的地图**、不是空过；
逐字节还原后 `shasum -a 256 crates/amos-robot/src/localization.rs` = `c5729a76dda8baf7b808a6906b331ff795e9d8a3350af72f99398eef97a70081`、复绿 **26 单测 + 5 接缝**。
② 把 `MAX_LOCALIZATION_LANDMARKS` 由 256 改成 512（两张上限拉平）⇒ 接缝套件**编译失败**
（`error[E0080]: evaluation panicked: the bounds now agree: revisit the localization boundary note`），
即证第 4 条断言是**编译期**门、不能被跳过；还原后 sha256 同上、复绿。
③ 套件内**自带**负控 `a_far_off_map_is_reported_lost_not_held`：同一夹具、地图整体平移 50 m ⇒ `match_quality < MATCH_QUALITY_FLOOR`
且 `health == Diverged`（不保持真值），与第 2 条用**同一代码路径**、只换地图——故第 2 条不是「忽略入参也过」。

**诚实边界**：① 本轮**只修文档 + 加测试**，`amos-robot` 的生产逻辑**一行未改**（改的是文档、常量自述与新增 `tests/`）；
② 接缝测试是**场景级**证据（一个静止盘测 + 5 个地标 + 无动力学），不是真机或真传感器验证；
③ 它证明的是**坐标系/单位/约定一致**与**拒绝契约**，**不**证明 SLAM 地图在噪声下的精度（那需要真数据）；
④ 第 2 条的读数带一个**手写的小偏移表**（无 RNG 依赖、无种子），故似然是平滑高斯而非 δ——这是边界 9 的要求，
不声称它代表某型扫描仪的噪声模型；⑤ **未**给 `McLocalizer` 加任何「从 `SlamState` 构造」的便捷 API：
`landmarks()` 已返回 `&[Landmark]`，`.to_vec()` 即可，加一层包装会违反本仓「无真实调用方不加 API」的规矩；
⑥ **未**改任何一张上限的数值（两张都各有理由，见 ②）。

**并发**：落笔前 `grep -rhoE 'REQ-A7[0-9][0-9]'` 重探，`REQ-A719`（`amos-link-py` 的 `.pyi` 桩镜像，`scripts/py-stub-scan.mjs`）
已被并发轮落入占用，`F-SH-176` 亦已占用，故取 **REQ-A720 / F-SH-177**（`grep -rn` 双向零命中）。

---

## 36. 补全（REQ-A722）：传感器在机体上有个偏移，而**没有任何测试把那个偏移转过一次**——EKF 自以为测过，MCL 一次都没测过（2026-09-20）

**上一轮（REQ-A720）刚建的那条「EKF 建图 → MCL 定位」接缝，其最重的一条断言是「坐标系一致」。本轮自审它，
发现它（以及它两侧的每一个偏移测试）都把一个**旋转**当成了**加法**。**

### ① 缺陷（核实）

机体系里的传感器偏移要进世界系得过一个旋转：

```text
sx = x + ox·cosθ − oy·sinθ
sy = y + ox·sinθ + oy·cosθ
```

这一对式子在本仓出现 **3 处**（共 6 行）：EKF 的观测/预测（`src/slam/ekf.rs:606-607`）、EKF 更新用的
`a`/`b`（`src/slam/ekf.rs:633-634`）、MCL 的权重（`src/localization.rs:794-795` 的 `sx`/`sy`）。
而**测到它的测试是零个**：

- EKF 那条 `a_sensor_offset_is_honoured_by_both_the_prediction_and_the_update`（`ekf.rs:1382`）
  用 `sensor_offset_x_m: 0.5`、`sensor_offset_y_m: 0.0`，且在 `SlamState::new()`（位姿 `(0,0,0)`）下运行
  ⇒ `cosθ = 1, sinθ = 0`，**旋转矩阵就是单位阵**。它证明的是「偏移被**加**上去了」，从不是「偏移被**转**了」。
- MCL 侧更彻底：`readings`/`noisy_readings` 走的都是 `SlamObservation::lidar`，而 `lidar()` 把两个偏移
  **写死为 `0.0`**（`ekf.rs:116-117`）；`src/localization.rs` 与 `tests/localization_e2e.rs` 里
  `sensor_offset` 的命中只在**校验**（`581-582`）与**模型**（`794-795`）两处，测试里一次都没有。
- `tests/slam_e2e.rs` 同样显式传 `0.0, 0.0`（`105-106`）。

### ② 为什么是缺陷（实测，不是推断）

- 把 MCL 的 `sx` 交叉项 `− sin·oy` 改成 `+ sin·oy` ⇒ `cargo test -p amos-robot` **407 个测试全绿**
  （修前世界的 358 单元 + 37 集成 + 12 doctest）。
- 把 EKF 的 `sx` 交叉项改成 `+` ⇒ `cargo test -p amos-robot --lib slam::` **80 个全绿**。

即：一个**符号错误**——传感器被放到机体另一侧——可以让整套测试通过。这不是「测得不严」，是**那条代码从未被执行**。
它正落在上一轮声称已被证明的那条接缝上：接缝夹具的读数来自一台**装在机器人中心**的扫描仪，于是
「两侧坐标系一致」这句断言**根本没碰**偏移旋转这一项。

### ③ 修法（三处，都只在测试/夹具侧）

1. `src/localization.rs`：抽出 `offset_readings(x, y, θ, (ox, oy), map)`（按上式算出传感器的世界位置，
   并把偏移写进 `SlamObservation`）与 `with_scanner_noise(obs, seed)`（把原 `noisy_readings` 里的噪声配方
   提出来复用，抽取顺序逐字保持：每条读数先 range 后 bearing，故既有种子的结果不变）；
   新增 `a_rotated_sensor_offset_is_honoured_by_the_weights`——`ox = 0.4`、`oy = 0.3`（**两轴都非零**，
   `oy` 才是 `sin` 交叉项转的东西）、航向 `0.9 rad`，滤波器在真位姿播种后必须**保持**位姿，
   且 `match_quality > 0.2`（这一半是承重的：模型若丢掉或转错偏移，传感器会落在读数来源之外约半米，
   即 ~20σ，一致性分会塌到 0）。
2. `src/slam/ekf.rs`：新增 `a_rotated_sensor_offset_is_honoured_by_the_prediction_and_the_update`——
   `with_pose([1.0, −2.0, 0.9], …)` 配 `(0.4, 0.3)`，断言地标被**建在**「传感器世界位姿 + 射程沿航向」，
   且重复观测不把它挪走（后半句才管**更新**那一侧）。
3. `tests/localization_e2e.rs`：夹具加 `SENSOR_OFFSET = (0.35, −0.20)`，`readings_from` 由
   「机器人原点」改为「旋转后的传感器位置」，于是这条接缝的「坐标系一致」**覆盖偏移旋转**。
   第 2 条声明的散文同步。

### 验证

`cargo test -p amos-robot` ⇒ **360 单元**（本轮 +2：MCL 与 EKF 各一条）+ **37 集成** + **12 doctest** 全绿；
`cargo clippy -p amos-robot -p amos-link --all-targets -- -D warnings` 净；
`cargo doc -p amos-robot -p amos-link --no-deps` 净（REQ-A707 的 deny 门禁在）；`cargo fmt --check` **0 diff**。
（§35 记的「358 单元」是**该轮当时**的数；本轮起为 360。）

### 负面控制（实测，逐字节还原 + `shasum -a 256`）

① **判别力·MCL**：把 `best_landmark_nees` 的 `sx` 交叉项翻号 ⇒ 新用例 `a_rotated_sensor_offset_is_honoured_by_the_weights`
**恰 1 红**（`x off by 0.45570564`），`localization` 其余 26 条仍绿；还原后
`shasum -a 256 crates/amos-robot/src/localization.rs` = `f976140792d4d57d95706245b00229cdc9d75d7f6a102e8f501323299d4739ba`、27 绿。
② **判别力·接缝**：同一翻号下跑 `--test localization_e2e` ⇒ **恰 1 红**
（`the_localizer_holds_the_pose_the_slam_map_was_built_from`，另 4 绿）——即证夹具改成带偏移后，
**接缝本身**对偏移旋转有判别力（修前它没有：同一翻号下 5 条全绿）。
③ **判别力·EKF（两侧各一次）**：翻 `sx` 的交叉项 ⇒ 新用例**恰 1 红**，
`the landmark must be created at the sensor's rotated world position…, expected (2.256866, 0.06646764), got (2.726862, 0.06646764)`；
改为翻更新侧的 `a` 的交叉项 ⇒ 同一个用例**恰 1 红**（落在后半段「重复观测不挪走」的断言上）——
即证这条用例同时钉住**预测**与**更新**两侧。逐字节还原后
`shasum -a 256 crates/amos-robot/src/slam/ekf.rs` = `2dd005cda0bf6b07375f109f8d7ebd6b62c119ddcb5a48244ef52ed9ce667964`、81 绿。
④ **修前盲区（取证）**：上述三个翻号在**修前**的世界里，分别是 407 全绿 / 5 全绿 / 80 全绿（见 ②）。

### 诚实边界

① 本轮**未改任何生产逻辑**——`best_landmark_nees`、`observe`、`predict` 的算式一行未动；改的是**测试与夹具**
   （另加两处 `// chosen` 级别的文档补充）。这是「补上缺失的证明」，不是「修一个跑错的算式」：两侧的偏移旋转
   本来就彼此一致（都符合上文那对式子），本轮把它**钉住**。
② 证据是 Rust 单测/集成 + clippy/doc/fmt + 四个负控，**未做**真机、**未**用真扫描仪标定过的偏移；
   夹具里的 `(0.4, 0.3)`、`(0.35, −0.20)` 是**任取**的非零值，其作用是让交叉项非零，不是某台机器的标称值。
③ 新用例只钉「偏移被正确地**旋转**」这一项，**不**钉偏移的**标定误差**（真实装配偏差是另一回事）。
④ `with_scanner_noise` 是对既有 `noisy_readings` 的**等价重构**（抽取顺序逐字保持），既有用例的随机数序列不变——
   这一点由「重构后 `localization` 全绿、且 §35 记的旧负控仍然红」共同佐证。
⑤ 本轮**只**覆盖机体系偏移；`slam` 的 `associate`／占据栅格／`vision` 不在范围内。
⑥ 并发：落笔前重探，`F-SH-178`（`amos-link-py` 桩镜像，REQ-A719）、`F-SH-179`（`ExtAppHost` 的能力接缝，
   `sandboxCapabilityHost.ts`，REQ-A721）、`F-SH-180`（`SmsGlue.kt` 常量镜像，`scripts/sms-glue-const-scan.mjs`，REQ-A723）
   均已被并发轮占用——其中 `F-SH-179`／`F-SH-180` 是在本轮落账**期间**被占的（初稿欲取 179），故两度让号，
   最终取 **REQ-A722 / F-SH-181**（`grep -rn` 对 `REQ-A722` 与 `F-SH-181` 双向零命中）。

## 37. 补全（REQ-A725）：EKF 观测入口的「输入合法性」闸**一个测试都没有**——整套 `slam::` 把它整段删掉仍全绿，而它恰好漏掉了上一轮刚钉住的那两个偏移字段（2026-09-20）

### ① 缺陷（核实，`git show HEAD`）

`SlamState::observe` 的顶部有一段输入校验（`src/slam/ekf.rs:518-530`），拒绝「非有限值的量测」与「负方差」，
并配了整整 4 行注释解释**为什么 `is_finite` 必须先于 `< 0.0`**（`NaN < 0.0` 为 `false`）。这段代码看起来是被
认真想过的——但它**从未被任何测试执行过**，而且它漏掉了两个字段。

- **零覆盖（实测）**：把整段条件换成 `if false {…}` ⇒ `cargo test -p amos-robot --lib slam::` **81 条全绿**。
  注意是**整段**：非有限值四查与负方差两查**一条也没被触发**。原因是唯一被普遍使用的构造器
  `SlamObservation::lidar` 只会产出有限、正的量测，要喂进非法值必须**字面量构造**结构体，而从没有人那样做过。
- **漏两个字段**：同一段闸检查 `range_m`／`bearing_rad`／`range_variance`／`bearing_variance`，却**不查**
  `sensor_offset_x_m`／`sensor_offset_y_m`。这两个字段正是在上一轮（REQ-A722）刚被钉住的「机体系偏移」——
  也就是说，上一轮修的是**这个偏移的旋转有没有人测**，本轮撞出的是**这个偏移的合法性有没有人管**。
- **接缝两侧不一致**：这条接缝的另一半，`McLocalizer::update`，把两个偏移字段**明确写进了它的合法性闸**
  （`src/localization.rs:581-582`）。同一个量、同一条接缝，一侧校验、一侧不校验。

### ② 为什么是缺陷（实测，不是推断）

- **错的是错误类别**。非有限偏移最终仍会被拦住——但拦它的不是上面那段闸，而是下方 `predict_landmark_position`
  之后的 `lm_x.is_finite()` 网（`ekf.rs:555`），于是返回的是 **`SlamError::Singular`**（「地标压在机器人身上、
  方位雅可比奇异」这一**几何**判决），而不是 `SlamError::BadInput`——后者的文档原文正是「an input carried a
  **non-finite value** or a negative variance」。**代码违反了它自己写下的错误契约。**
- **实测**：`SlamObservation::lidar(2.0, 0.1)` 后把 `sensor_offset_x_m` 置 `NaN` ⇒ `observe` 返回 `Err(Singular)`；
  把 `sensor_offset_y_m` 置 `INFINITY` ⇒ 同样 `Err(Singular)`。
- **代价**：`Singular` 与 `BadInput` 对调用方意味着两种完全不同的处置。`Singular` 是「几何退化，换个位姿再试」——
  而一个 NaN 偏移是**永久**畸形的输入，任何「换个位姿重试」都会永远重试下去。调用方按错误类别分流时，
  这个输入会被分到**永远不会自愈**的那一支。
- **盲区的形态与上一轮同源**：上一轮的盲区是「**被测过的假象**」（用例**用名字**宣称覆盖了偏移）；本轮的盲区是
  「**写得很仔细的代码，无人执行**」——4 行注释解释了每条检查的顺序理由，读者（与负控纪律）会把注释的细致
  读成「这段被验证过」。

### ③ 修法

生产逻辑（`src/slam/ekf.rs`）：

1. `observe` 的合法性闸加入两个偏移字段的 `is_finite` 检查（`ekf.rs:522-523`）。
   **只查有限性、不查正负**：负偏移是合法摆放（扫描仪可以装在机器人中心之后或之侧），
   上一轮接缝夹具用的就是 `oy = −0.20`。
2. 注释扩写：写明这两个字段为什么属于这份名单（它们会被旋转进世界系，非有限值会让预测地标位置非有限），
   以及缺少这两条检查时的历史行为（被 `lm_x.is_finite()` 网捞住、误报为 `Singular`）。

测试（`src/slam/ekf.rs` 的 `tests` 模块）：

3. 新增 `every_malformed_observation_field_is_refused_as_bad_input`：把闸口检查的**每个**字段逐一弄坏
   （六个非有限值 + 两个负方差），断言 `BadInput` 且**不得建出地标**；再补一个**反向补集**——
   负偏移**必须被接受**——使该用例不能靠「一律拒绝」通过。

### 验证

- `cargo test -p amos-robot` ⇒ **361 单元**（本轮 +1）+ **37 集成** + **12 doctest** = **410** 全绿。
- `cargo clippy -p amos-robot -p amos-link --all-targets -- -D warnings` ⇒ 净。
- `cargo doc -p amos-robot -p amos-link --no-deps` ⇒ 净（REQ-A707 的 rustdoc deny 门禁在）。
- `cargo fmt -p amos-robot -p amos-link -- --check` ⇒ 0 diff。

### 负面控制（实测，逐字节还原 + `shasum -a 256`）

① **判别力·只抽掉新增的两条**：还原成修前的六查（去掉两个偏移检查）⇒ 新用例**恰 1 红**，
`assertion left == right failed: a non-finite sensor_offset_x_m must be BadInput, not a geometry verdict`，
`left: Err(Singular)` / `right: Err(BadInput)`，其余 **81 绿**——即证失败点**正是**这两个字段。
② **判别力·整段闸都删**（`if false`）⇒ 新用例**恰 1 红**，且这次落在**第一条**上
（`a non-finite range_m must be BadInput…`，`left: Err(Singular)`）——即证该用例覆盖的是**整段闸**，
而不只是本轮新加的两条。
③ **修前盲区（取证）**：本轮之前，同一个 `if false` 扰动下 `slam::` **81 条全绿**——零覆盖由此坐实。

逐字节还原后 `shasum -a 256 crates/amos-robot/src/slam/ekf.rs` = `95851cbfba78bdd78cc29d335c65fc4afb7359db60a277867ef1d0c0e15db157`，复绿 82。

### 附：一处账本勘误（本轮自查上一轮）

读回 §36 时发现该节的取证句写「这一对式子在本仓出现 **5 处**」，而它**自己列出的**是三处
（`ekf.rs:606-607`、`ekf.rs:633-634`、`localization.rs:794-795`）＝ 6 行。已把 §36 与另外三处
（`docs/FMEA.md` 的 F-SH-181 行、`docs/TRACEABILITY_MATRIX.md` 的 REQ-A722 行、`CHANGELOG.md`）统一订正为
**3 处（共 6 行）**。grep 佐证：生产侧命中恰为这三处；其余命中全在测试侧（`localization.rs:924-925,933`、
`ekf.rs:1438-1439`），不计入「生产算式出现处」。数字错误虽小，但本仓的规矩是**账本里的每个数都要量过**——
上一轮在计数上偷懒，本轮改回。

### 诚实边界

① 本轮**改了一行生产逻辑**（`observe` 的闸口加两条检查），这与前几轮的「只改测试」不同：这是一处真缺陷的
   **真修复**，而非补证明。改动面严格限于那一份名单与一段注释。
② 修的是**错误类别**（`Singular` → `BadInput`），不是「非法输入会污染状态」——非有限偏移本来就会被
   `ekf.rs:555` 的网拦住、不写入状态；本轮让**拒绝的理由**与文档契约一致。
③ 只查有限性，**不**把偏移限制在某个物理范围（多大算「不合理」取决于机器人尺寸，本 crate 不该替调用方定）。
④ 证据为 Rust 单测 + clippy/doc/fmt + 三个负控；**未做**真机，**未**用真扫描仪。
⑤ `McLocalizer::update` 的对应闸口（`localization.rs:578-590`）**已有**偏移检查，本轮未动它；本轮把它当作
   「接缝另一侧早就是这样」的**对照**，而非当作被测对象。
⑥ 并发：落笔前经 `grep -rn 'REQ-A724'` 与 `grep -rn 'F-SH-182'` 重探，`REQ-A724 / F-SH-182`
   （⌘M 名为 Minimize 实为 hide 的那一轮）已被并发轮占用，故取 **REQ-A725 / F-SH-183**（双向零命中）。

## 38. 补全（REQ-A728）：上一轮把 `McLocalizer::update` 的合法性闸当「接缝另一侧的正确榜样」指过去——而它八条条件里**七条零测试**，被引用的那两条偏移检查就在其中；顺带记下同一字段上 `<= 0.0` 与 `< 0.0` 的合约分歧（2026-09-20）

### ① 缺陷（核实，实测，`git show HEAD`）

§37（REQ-A725）的正文把 `McLocalizer::update` 的闸口写成「接缝另一侧早就是这样」的**对照**，
用它反衬 EKF 闸口漏掉了两个偏移字段。本轮回头去量那个「榜样」自己的覆盖：

- **八条条件，一条有测试**。闸口（`src/localization.rs:578-590`）检查八个条件：六个非有限值
  （`range_m`／`bearing_rad`／`sensor_offset_x_m`／`sensor_offset_y_m`／`range_variance`／`bearing_variance`）
  与两个非正方差。全套里**只有** `refuses_a_reading_with_a_nonpositive_variance` 钉了其中一条
  （`range_variance = 0.0`）。
- **实测**：把闸口缩成 `if o.range_variance <= 0.0 {…}`（**保留**那一条被钉的、删掉其余七条）
  ⇒ `cargo test -p amos-robot` **410 条全绿**（当时总数）。也就是说另外七条——**包括两条偏移检查**——
  从未被执行过。
- **这正是上一轮批判的形态的镜像**：§37 说 EKF 的盲区是「写得很仔细的代码，无人执行」，并把 MCL 闸口
  立为反例。本轮证明**反例自己也是无人执行**——它看起来更可信，仅仅因为它旁边有一条同名字的用例
  （`refuses_a_reading_with_a_nonpositive_variance`），而那条只覆盖了八分之一。

### ② 附带发现：同一字段上两侧合约不同（记录，不修）

写下镜像用例时必须决定 `0.0` 方差算不算「畸形」，于是量到一个既有的分歧：

| | `range_variance == 0.0` 的判决 | 依据 |
|---|---|---|
| EKF `observe` | **接受**（`Ok(Created)`，还建出地标） | 闸口是 `range_variance < 0.0` |
| MCL `update` | **拒绝**（`BadParameter`） | 闸口是 `range_variance <= 0.0` |

实测：EKF 喂 `range_variance = 0.0` 的读数 ⇒ `Ok(Created { landmark_index: 0 })`、`num_landmarks() == 1`；
MCL 喂同一读数 ⇒ `Err(BadParameter)`。**两侧对同一个字段、同一个值给出相反的判决，而两侧都没有一行
注释说明这个选择**。EKF 侧的读法是「0 方差＝这次测量是精确的」（与其 `initial_landmark_variance` 允许 `0.0`
的口径一致），MCL 侧的读法是「0 方差＝退化似然」（其边界 9）。两个读法各自成立——但**没有人把这个分歧写下来**，
于是它既不是「故意的」也不是「已知的」，只是**没人看**。

**修法（本轮）**：在 EKF 闸口的注释里补一段，写明 `0.0` 在这里合法、在 MCL 那边被拒、分歧记在 §38，
**不改变任何一侧的判决**——把零方差的政策定下来是一个需要产品判断的决定（「精确测量」是否该被接受），
不是审计能替调用方做的。MCL 的镜像用例同时在注释里点出这处分歧。

### ③ 修法（测试侧）

新增 `every_malformed_reading_is_refused_as_bad_parameter`（`src/localization.rs` 的 `tests` 模块）：
把闸口检查的**每个**字段逐一弄坏（六个非有限值 + 两个非正方差），断言 `BadParameter`；再补**反向补集**
——负偏移**必须被接受**——使用例不能靠「一律拒绝」通过。既有的 `refuses_a_reading_with_a_nonpositive_variance`
**保留**（它钉的是第八条，且被其它轮的负控引用）。

### 验证

- `cargo test -p amos-robot` ⇒ **362 单元**（本轮 +1）+ **37 集成** + **12 doctest** = **411** 全绿。
- `cargo clippy -p amos-robot -p amos-link --all-targets -- -D warnings` ⇒ 净。
- `cargo doc -p amos-robot -p amos-link --no-deps` ⇒ 净（REQ-A707 的 rustdoc deny 门禁在）。
- `cargo fmt -p amos-robot -p amos-link -- --check` ⇒ 0 diff。

### 负面控制（实测，逐字节还原 + `shasum -a 256`）

① **判别力·只留那条被钉的条件**（闸口缩成 `if o.range_variance <= 0.0`，删掉其余七条）⇒
`cargo test -p amos-robot --lib localization::` **恰 1 红**——新用例，落在**第一条**：
`called \`Result::unwrap_err()\` on an \`Ok\` value: ()`（`localization.rs:1087`，`range_m` 那一格），
其余 **27 绿**。这是本轮的**承重负控**：它正是修前世界的形态，而修前该扰动下整套 **410 全绿**。
② **判别力·整段闸都删**（`if false`）⇒ **恰 2 红**——新用例**与**既有的
`refuses_a_reading_with_a_nonpositive_variance`，一并证明两条用例各钉一半、合起来覆盖整段闸。

逐字节还原后 `shasum -a 256 crates/amos-robot/src/localization.rs` =
`72d841d395d772e6ba2807d6db1f802a63c56b04cc560200c7f1c0869ec069db`，复绿 28。

**哈希更新说明**：§37 记的 `crates/amos-robot/src/slam/ekf.rs` = `95851cbf…` 被本轮**注释改动**取代，
现为 `f7607dce5e169a9ffdefc181518b38292686654def4504e133fa22e38282c389`（只加注释、行为零变化；
§37 的负控结论不受影响）。

### 诚实边界

① 本轮的**代码修改只有注释**（EKF 闸口那段），行为零变化；**承重的是测试**——
补上七条从未被执行的条件。这与 §37「改一行生产逻辑」不同：本轮是「把榜样也钉住」。
② 零方差的分歧**记录而不修**（见 ②）：改任一侧都是政策决定，超出审计范围。
③ 新增用例只钉「闸口拒绝什么、接受什么」，**不**钉闸口之外的模型行为（权重、重采样、健康判定各有其用例）。
④ 证据为 Rust 单测 + clippy/doc/fmt + 两个负控，**未做**真机、**未**用真传感器。
⑤ 既有的 `refuses_a_reading_with_a_nonpositive_variance` 保留不动——第八条条件由它钉住，本轮不重复。
⑥ 并发：落笔前经 `grep -rn 'REQ-A726'`／`grep -rn 'F-SH-184'`／`grep -rn 'REQ-A727'`／`grep -rn 'F-SH-185'`
重探，`REQ-A726 / F-SH-184`（`DevCareGlue.kt` 跨语言常量）与 `REQ-A727 / F-SH-185`
（`amos-tauri/src/media.rs`，仅在代码注释里出现）均已被并发轮占用，故取 **REQ-A728 / F-SH-186**（双向零命中）。

## 39. 补全（REQ-A733）：栈里第三道入口闸——`McLocalizer::new` 的**构造期**校验——同样几乎无人执行：21 条里 15 条零测试，删掉全套仍绿（2026-09-20）

### ① 缺陷（核实，实测，`git show HEAD`）

§37 收的是 EKF 的观测入口（`SlamState::observe`），§38 收的是 MCL 的观测入口（`McLocalizer::update`）。
本仓还有**第三道**输入闸，从没人量过它的覆盖：**`McLocalizer::new` 的构造期校验**
（`src/localization.rs:453-491`）。它检查 21 条条件——地图非空、地图不超 `MAX_LOCALIZATION_LANDMARKS`、
**每个地标的 `x_m`／`y_m` 有限**（2 条）、`particles` 在 `1..=MAX_PARTICLES`（2 条）、
以及 `McControl` 的 **19 条**（九个字段，逐个查 `is_finite`、再逐个查其界）。

**实测**：把其中**15 条**删掉——13 条控制条件（保留 `linear_noise < 0`、`angular_noise` 有限、
`ess_ratio` 两端、`converged_radius <= 0`、`diverged_radius < converged_radius` 这六条，其余全删）
加上**两条地图地标有限性检查**——⇒ `cargo test -p amos-robot --lib` **362 条全绿**。
也就是说这 15 条从未被执行过。全套里唯一碰这块的用例是 `refuses_bad_noise_and_ratio_parameters`，
它钉了 6 条（我上面保留的那六条），**21 − 6 = 15** 条落在外面。

### ② 为什么是缺陷

- **形态与 §37／§38 完全同源**：三连的第三例。§37「写得仔细但无人执行」、§38「被援引的榜样也无人执行」、
  本轮「**构造期**闸同样无人执行」——而且这一道最大（21 条），最像被验证过（构造函数里的集中校验最容易被读者当成
  「显然测过」）。
- **不是纯风格问题，有具体后果**：`resample_jitter_m` 的有限性若失守，`NaN` 会在 `resample` 里
  写进**每个**粒子的位置（`dst.push` 前 `p.x_m += jitter` 那类写法），`estimate` 于是给出 `NaN` 位姿，
  而 `health` 判定读的是**有限**的协方差导数——即「`Ok` 之下交出 `NaN` 位姿」。`converged_radius_m` 的界失守则让
  `LocalizationHealth` 的判定阈值变成 `NaN`，`Converged/Uncertain/Diverged` 三态全部走 `else` 分支。
  这些都与 §37 的 EKF 闸口同型：**拒绝的理由与文档契约一致**，不是「非法输入能污染状态」（这条闸在赋值前就把
  构造拒了）。
- **`sensor_offset` 无关**：本轮这块与 §36／§37 的机体系偏移无关，不重复覆盖。

### ③ 修法（**只加测试，生产逻辑一行未改**）

`src/localization.rs` 的 `#[cfg(test)] mod tests` 新增
`every_malformed_construction_parameter_is_refused`：`type Corrupt = fn(&mut McControl);`，
19 条控制条件逐条给一个「只改一个字段」的闭包（每个字段两条：一条钉 `is_finite`、一条钉界），
再 2 条地图地标（`type Set = fn(&mut Landmark);`，`x_m = NaN`／`y_m = INFINITY`），
逐条断言 `LocalizationError::BadParameter`；末尾补**反向补集**——未改动的默认值必须构造成功——
使该用例不能靠「一律拒绝」通过。

### ④ 验证

- `cargo test -p amos-robot` ⇒ **363 单元**（本轮 +1）+ **37 集成** + **12 doctest** = **412** 全绿。
- `cargo clippy -p amos-robot -p amos-link --all-targets -- -D warnings` ⇒ 净。
- `cargo fmt -p amos-robot -p amos-link -- --check` ⇒ 0 diff。
- `cargo doc -p amos-robot -p amos-link --no-deps` ⇒ 净（REQ-A707 的 deny 门禁在）。
- `node scripts/fmea-gen.mjs --check`／`--self-test` ⇒ 绿。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

- **① 删 13 条控制条件**（缩成上面保留的六条）⇒ 新用例**红**（`unwrap_err()` 撞上 `Ok`，
  因为保留的 `linear_noise < 0` 对 `NaN` 为 `false`，第一条就漏）。
- **② 删 2 条地图地标有限性检查**（`if false && (…)`）⇒ 新用例**红**（落在地图那段循环）。
- **盲区取证**：这两处扰动在**修前**（无新用例）下全套 **362 条全绿**——零覆盖由此坐实。
- 逐字节还原后 `shasum -a 256 crates/amos-robot/src/localization.rs` =
  `e1932e596964ce007b936b20ca54ab29a6c8b68de54b83981be9dfdd4140d86f`，复绿 363。

### 诚实边界

① 本轮**只加一条测试**，`McLocalizer::new` 的运行期逻辑**一行未改**——那 21 条条件本来就在闸里，
本轮是把「它们被执行过」钉住，而非改正。
② 新增用例覆盖 `new` 的这 21 条；`new` 的 `EmptyMap`／`TooManyLandmarks`／`BadParticleCount` 三条由既有用例
（`refuses_an_empty_map`／`refuses_an_oversized_map`／`refuses_a_zero_particle_count`＋
`refuses_more_particles_than_the_bound`）覆盖，本轮不重复。
〔更正（REQ-A737 / §40）：本行原写作 `refuses_a_bad_particle_count`，该用例名**不存在**；已改为真实的两条。〕
③ `new_at` 的初始 sigma 校验由 `refuses_a_bad_initial_sigma` 覆盖，**不**在本轮范围。
〔更正（REQ-A737 / §40）：此断言**不成立**——`new_at` 闸 7 条里 5 条零执行，见 §40。〕
④ 证据为 Rust 单测 + clippy/doc/fmt + 两个活负控，**未做**真机、**未**用真传感器。
⑤ 并发：落笔前经 `grep -rn 'REQ-A729'`／`grep -rn 'REQ-A730'`／`grep -rn 'F-SH-187'`／`grep -rn 'F-SH-188'`
重探，`REQ-A729 / F-SH-187`（`amos-tauri/frontend-ts/src/lib/magnifier.ts` 放大镜）与
`REQ-A730 / F-SH-188` 均已被并发轮占用，故取 **REQ-A733 / F-SH-189**（双向零命中；其间 REQ-A731 / F-SH-189 与 REQ-A732 / F-SH-190 亦被该并发轮——appstore id 命令缝——占用）。

## 40. 补全（REQ-A737）：§39 把 `new_at` 的闸写进「范围外」，而那条闸七条条件里五条零执行；顺带发现 §39 边界点名的用例**根本不存在**（2026-09-21）

### ① 缺陷

§39 的诚实边界 ③ 断言：`new_at` 的初始 sigma 校验「由 `refuses_a_bad_initial_sigma` 覆盖，**不**在本轮范围」。
实测不成立。`McLocalizer::new_at` 顶部闸共 **7 条**条件——五个 `f32` 参数（`x_m`／`y_m`／`theta_rad`／
`sigma_m`／`sigma_theta_rad`）各一条 `is_finite()`，外加 `sigma_m <= 0.0` 与 `sigma_theta_rad <= 0.0` 两条——
而 `refuses_a_bad_initial_sigma` **只钉了 `sigma_m` 那两条**（`0.0` 与 `NaN`）。其余 **5 条零执行**：

- `!x_m.is_finite()`、`!y_m.is_finite()`、`!theta_rad.is_finite()`
- `!sigma_theta_rad.is_finite()`、`sigma_theta_rad <= 0.0`

**取证**：把这 5 条整段删掉（闸缩成仅 `!sigma_m.is_finite() || sigma_m <= 0.0`），
`cargo test -p amos-robot --lib` ⇒ **363 全绿、0 失败**。

第二重缺陷（账目本身）：§39 边界 ② 把 `new` 的三条命名条件记成「由既有用例
`refuses_an_empty_map`／`refuses_an_oversized_map`／**`refuses_a_bad_particle_count`** 覆盖」——
最后一个名字**在仓库里不存在**（真实的两条是 `refuses_a_zero_particle_count` 与
`refuses_more_particles_than_the_bound`，见 `crates/amos-robot/src/localization.rs:960,972`）。
一条「点名一篇不存在的测试来宣称覆盖」的账，正是这一整个审计系列所抓的缺陷的同型，
却安然落座于上一轮的「补全覆盖」记录里。

### ② 为什么是缺陷

五条未执行条件里，**三条钉的是姿态参数**（`x_m`／`y_m`／`theta_rad`）的有限性。它们的职责是把
`NaN`／`inf` 挡在采样云之外：一旦放进 `new_at`，`p.x_m = x_m + sigma_m * gaussian(&mut rng)`
会给**每一颗粒子**写下 `NaN`，`estimate()` 的加权均值随之**静默**变成 `NaN`，而不是返回错误。
这恰恰是「静默污染」而非「响亮失败」的一类——最需要闸、也最需要有人证明闸被执行。§39 把这条闸
写进「范围外」，等于让它继续停在无人执行的状态：审计的枪口对准了 `new`，却越过了紧挨着的 `new_at`。

而第二重缺陷解释了它为何能躲过一轮：`claim-scan` 只审 `*-allowlist.json`／`*-baseline.json` 的
`reason` 字段，`docs/robot-autonomy.md` 的 §-散文里被反引号引用的标识符**没有任何门禁**核对是否
存在于代码语料中。于是一个凭空写下的测试名可以在「补全覆盖」的账里落座，并让下一轮（本轮）的第一件事
变成核实它——**覆盖账本身无门禁，是覆盖漏洞得以跨轮存活的原因**。

### ③ 修法

- 只加一条测试 `every_malformed_initial_pose_or_sigma_is_refused`：把 `new_at` 的 5 条未执行条件
  逐条钉住（`x_m`／`y_m`／`theta_rad` 的有限性、`sigma_theta_rad` 的有限性与 `<= 0.0`），
  并断言**补集**（未改动的参数）仍能构造成功，使该用例不能靠「一律拒绝」蒙混。
  `new_at` 的**运行期逻辑一行未改**。
- 把 §39 边界 ② 的用例名改正为真实的两条。

### ④ 验证

`cargo test -p amos-robot` ⇒ **364 单元 + 37 集成 + 12 doctest = 413**；clippy（`-D warnings`）／
`cargo fmt --check`／`cargo doc --no-deps` 全净。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

- **① 把 `new_at` 闸缩成仅两条 `sigma_m` 条件**（删 5 条）⇒ 新用例**红**（其余 363 绿）。
- **② 只中性化 `!theta_rad.is_finite()`**（`false && …`）⇒ 新用例**红**（其余 363 绿）。
- **盲区取证**：这两处扰动在**修前**（无新用例）下全套 **363 条全绿**——五条零覆盖由此坐实。
- 逐字节还原后 `shasum -a 256 crates/amos-robot/src/localization.rs` =
  `94e19b0ecd26c78bc10974b83146ecbe5aee8305e25ffdfd4f33a809cb8dce27`，复绿 364。

### 诚实边界

① 本轮**只加一条测试**，`new_at` 的运行期逻辑**一行未改**——那 7 条条件本来就在闸里，
本轮是把「其余 5 条被执行过」钉住，而非改正。
② `new` 的三条命名条件（`EmptyMap`／`TooManyLandmarks`／`BadParticleCount`）本轮**实测确证**由既有用例覆盖：
分别中性化后 `refuses_an_empty_map`／`refuses_an_oversized_map` 与
`refuses_a_zero_particle_count`＋`refuses_more_particles_than_the_bound` 两两转红——并由此发现 §39 边界 ②
把它们记成了一条不存在的 `refuses_a_bad_particle_count`。
③ §39 边界 ③ 关于 `new_at` 的断言被本轮证伪——这正是本轮的来源。
④ **`docs/robot-autonomy.md` §-散文里反引号标识符无门禁核对**：本轮只在散文层面改正了那个名字，
**未**新增扫描器（新增脚本须同步 `docs/GATES.md`，与并发轮冲突面大）。这是已知缺口，记为下一轮候选。
⑤ 证据为 Rust 单测 + clippy/doc/fmt + 两个活负控，**未做**真机、**未**用真传感器。
⑥ 并发：落笔前经 `grep -rn 'REQ-A735'`／`grep -rn 'F-SH-192'`／`grep -rn 'F-SH-193'` 重探，
三者均已被并发轮占用（`F-SH-192`／`F-SH-193` 已现于 `docs/FMEA.md`），故取
**REQ-A737 / F-SH-194**（双向零命中）。

## 41. 补全（REQ-A746）：同一族的**第四道**入口闸——`McLocalizer::predict` 的指令校验——四条件里 `!angular_rad_s.is_finite()` 零执行（2026-09-21）

### ① 缺陷

`McLocalizer::predict`（`crates/amos-robot/src/localization.rs:539-543`）顶部闸共 **4 条**条件：
`!dt.is_finite()`、`dt <= 0.0`、`!cmd.linear_m_s.is_finite()`、`!cmd.angular_rad_s.is_finite()`。
既有用例 `predict_refuses_a_bad_command_and_leaves_the_belief_alone`（`localization.rs:1292`）喂了三条坏指令
（`dt_s = 0.0`／`dt_s = NaN`／`linear_m_s = INFINITY`），**只钉了前三条**；`!cmd.angular_rad_s.is_finite()`
**零执行**。

**取证**：把 `|| !cmd.angular_rad_s.is_finite()` 中性化为 `|| (false && …)`，
`cargo test -p amos-robot --lib` ⇒ **364 全绿、0 失败**。

### ② 为什么是缺陷

这是 §37（`SlamState::observe`）／§38（`McLocalizer::update`）／§39（`McLocalizer::new`）／
§40（`new_at`）那一族的**第四道**闸，也是最容易被略过的一道。丢失的条件造成的是**同款静默 `NaN`**：
`w = cmd.angular_rad_s + sigma_w * gaussian(rng)` 喂进 `theta = wrap_angle(p.theta_rad + w * dt + sigma_h * …)`，
一个无穷角速度经 `wrap_angle` 变 `NaN`，随后 `p.x_m += v * dt * theta.cos()` 与 `y` 经 `sin()`
把 `NaN` 写进**每一颗**粒子的位置与朝向。

而 `predict` 的签名是 `pub fn predict(&mut self, cmd: VelocityCommand)`——**返回 `()`，不是 `Result`**。
所以这道闸的失守没有错误码可看：调用方得到的是「调用成功了」，而整片粒子云已经中毒，
`estimate()` 随后交出一份 `NaN` 位姿。这正是「静默污染」而非「响亮失败」的一类，
最需要有人证明闸被执行——而它恰恰是四条里唯一没人碰过的那条。

### ③ 修法

只加一条测试 `every_malformed_command_is_refused_and_leaves_the_belief_alone`：以 `type Corrupt = fn(&mut VelocityCommand);`
逐字段钉住**全部四条**（`dt_s` 非有限、`dt_s <= 0.0`、`linear_m_s` 非有限、`angular_rad_s` 非有限），
每条断言 `predict` 后粒子云**逐字节不变**；末尾补**反向补集**——一条合法指令**必须**移动云
（`assert_ne!`），使该用例不能靠「`predict` 从不做事」通过。`predict` 的运行期逻辑**一行未改**。

### ④ 验证

`cargo test -p amos-robot` ⇒ **365 单元 + 37 集成 + 12 doctest = 414**；clippy（`-D warnings`）／
`cargo fmt --check`／`cargo doc --no-deps` 全净。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

- **① 中性化 `!cmd.angular_rad_s.is_finite()`**（`false && …`）⇒ 新用例**红**，其余 364 绿。
- **② 整段闸删**（`if false { return; }`）⇒ **两条红**——新用例与既有
  `predict_refuses_a_bad_command_and_leaves_the_belief_alone`，证明两条合起来覆盖整段闸。
- **盲区取证**：扰动 ① 在**修前**（无新用例）下 `--lib` **364 条全绿**——该条件零覆盖由此坐实。
- 逐字节还原后 `diff` 生产段（1–537 行）对备份为空（运行期逻辑零变化），
  `shasum -a 256 crates/amos-robot/src/localization.rs` =
  `f98c14779494694d77c9b4160afb2dfa8e4e7910f2b80f6f841bfe8d8e976031`，复绿 365。

### 诚实边界

① 本轮**只加一条测试**，`predict` 的运行期逻辑**一行未改**——那 4 条条件本就在闸里，
本轮是把「第四条被执行过」钉住，而非改正。
② 「拒绝」在这道闸里表现为**静默 no-op**（`predict` 返回 `()`），故本轮钉的是「坏指令后云不变」，
而非某个错误码；这与 §37／§38／§39 的 `Result` 闸不同，是同族里唯一的无声形态。
③ 顺带复核了 §40 记为「下轮候选」的**§-散文标识符门禁缺口**：把 `docs/robot-autonomy.md` 里
318 个反引号标识符逐个对语料核对，**唯一**未命中者是 `a_hit_and_a_miss_cancel_out_partially`——
它是 REQ-A538（§20）**历史性**引用的旧名（该轮把它改名为
`a_hit_and_a_miss_leave_the_cell_exactly_on_the_occupied_boundary`），属**合法**的历史引用，
不是失效声明。故该缺口**本轮未产出第二个活体实例**，仍记为下一轮候选（新增扫描器须同步 `docs/GATES.md`）。
④ 证据为 Rust 单测 + clippy/doc/fmt + 两个活负控，**未做**真机、**未**用真传感器。
⑤ 并发：落笔前经 `grep -rn 'REQ-A744'`／`grep -rn 'F-SH-201'`／`grep -rn 'REQ-A745'`／
`grep -rn 'F-SH-202'` 重探，相邻号段均已被并发轮占用，故取
**REQ-A746 / F-SH-203**（双向零命中）。

## 42. 补全（REQ-A752）：同一族的**第五道**入口闸——`slam::loop_closure::scan_match` 的配置校验——八条件里 `config.range_y_m < 0.0` 零执行（2026-09-21）

**① 缺陷（实测）**：`scan_match`（`crates/amos-robot/src/slam/loop_closure.rs:127`）在函数口上先校验
配置，八条条件（`:139-146`）：`!range_x_m.is_finite()`、`!range_y_m.is_finite()`、
`!range_theta_rad.is_finite()`、`range_x_m < 0.0`、`range_y_m < 0.0`、`range_theta_rad < 0.0`、
`!max_match_distance_m.is_finite()`、`max_match_distance_m < 0.0`。既有用例
`a_malformed_config_is_refused_not_silently_searched`（`:643`）喂了 **7** 例——它用了
`range_x_m = -1.0` 与 `range_theta_rad = -0.1`，**独缺** `range_y_m = -1.0`。把
`config.range_y_m < 0.0` 这一条或项中性化（前缀 `false &&`）后，`cargo test -p amos-robot --lib`
**366 条仍全绿**——该条件从未被执行。

**② 为什么是缺陷**：闸自己的注释（`:136-138`）写着——负半窗被拒「因为该字段叫**半**窗，它会
**镜像**窗口而非**尺寸**化窗口」。负 `range_y_m` 若不被拒，搜索在 y 上覆盖的是**镜像**后的区域
（而不是把窗口缩小或归零），函数仍返回 `Ok` 与一个「在错误区域里相对最优」的位姿——**一次把错误
答案报告为成功搜索**。回环闭合据此修正 EKF 状态，偏差被当作观测吸收。这就是同一族在前四轮反复出现
的形状（`SlamState::observe` REQ-A725／`McLocalizer::update` REQ-A728／`new` REQ-A733／
`new_at` REQ-A737／`predict` REQ-A746）：**闸的每一条叶子都得有人钉**，而 x／y 对称最容易让人以为
「三个字段都盖了」。

**③ 修法（未改任何生产逻辑）**：在 `loop_closure.rs` 的 `tests` 加
`every_malformed_scan_match_field_is_refused`——8 例矩阵，逐例断言
`scan_match(...) == Err(ScanMatchError::InvalidConfig)`，覆盖**全部八条叶子**；末尾补**反向补集**：
未经改动的默认配置**必须**被搜索（`is_ok()`），使该用例不能靠「什么都拒绝」空洞通过。八条条件本就
在闸里，一行生产代码未改；既有 `a_malformed_config_is_refused_not_silently_searched` 保留。

**④ 验证**：`cargo test -p amos-robot --lib loop_closure` ⇒ **12 passed**（本轮 +1，修前 11）；
全量 `cargo test -p amos-robot` ⇒ **416 passed**（367 单元 + 37 集成 + 12 doctest）；
`cargo clippy -p amos-robot --all-targets -- -D warnings` 净；`cargo fmt -p amos-robot -- --check`
0 diff；`cargo doc -p amos-robot --no-deps` 0 warn；`node scripts/fmea-gen.mjs --check` ⇒ 432 失效模式
GREEN，`--self-test` ⇒ 12/12。

**⑤ 负面控制（实测，逐字节还原 + `shasum -a 256`）**：①中性化 `config.range_y_m < 0.0`
（前缀 `false &&`）⇒ 新用例**恰 1 红**，其余 366 绿；②中性化 `!config.range_x_m.is_finite()` ⇒
**恰 2 红**（新用例 + 既有 `a_malformed_config_is_refused_not_silently_searched`）。逐字节还原后
`shasum -a 256 crates/amos-robot/src/slam/loop_closure.rs` =
`eaa1f6ff6b40d85ddd9f12c12c90803442bf7b95eebfd88ee013d36cf692b6cd`，复绿 12。

**诚实边界**：①这是**未执行的守卫条件**而非当下坏值——`scan_match` 的八条闸逻辑本就正确，本轮补的
是「有人钉住」；②**未改**生产代码（一行未改，扰动后逐字节还原，sha 如上），只加测试；③只钉八条
**配置入参闸**，**不**覆盖后续的窗口预算（`scan_match_window_budget`／`MAX_SCAN_OPERATIONS`）或
代价／接受语义（另由 `a_window_too_large_is_refused`／
`a_degenerate_window_is_refused_but_a_single_sample_is_not`／
`a_static_scan_on_a_static_map_converges_at_the_initial_pose` 覆盖）；④`scan_match` 目前经
`slam::mod`／`lib.rs` 重导出，生产回路的接入是调用方的循环（`slam/mod.rs` 已如此声明），本轮修的是
该原语的契约；⑤证据为 Rust 单测 + clippy/fmt/doc + 两条活负控，**未做**真机／真传感器复跑；
⑥并发：落笔前经 `grep -rhoE 'REQ-A[0-9]+'`／`F-SH-[0-9]+` 重探（高水位 REQ-A751 / F-SH-208，均属
并发 MRAC·Piper 轮），取 **REQ-A752 / F-SH-209**（双向零命中）。

## 43. 补全（REQ-A755）：同一族的又一例入口闸——`vision::five_point::essential_matrix_eight_point` 的对应点坐标校验——两条件里 `!y.is_finite()` 零执行（2026-09-21）

### ① 缺陷

`essential_matrix_eight_point`（`crates/amos-robot/src/vision/five_point.rs:135`）在求解前有一道对应点
坐标闸，条件是**两条并项**（`:139-144`）：

```rust
if a.iter()
    .chain(b.iter())
    .any(|&(x, y)| !x.is_finite() || !y.is_finite())
{
    return None;
}
```

即 `!x.is_finite()` 与 `!y.is_finite()`——**两个坐标分量各自**必须有限。既有测试
`a_non_finite_coordinate_is_refused`（`:948`）只把 `b[3]` 设成 `(f32::NAN, 0.0)`，**只喂了 x 分量**；
`!y.is_finite()` 这条分支从未被任何输入执行过。**实测**：把 `!y.is_finite()` 中性化（置为
`false`）后，`cargo test -p amos-robot --lib` **367 条仍全绿**——该条件零执行。

更糟的是，既有那条用例**本身也是非判别的**：它的基准输入是 `a = vec![(0.0, 0.0); 8]`、
`b = vec![(0.1, 0.1); 8]`（八对全部共线、秩亏），即使**没有**任何坐标闸，八点法也会因设计矩阵奇异而
返回 `None`；也就是说这条用例对 x 分量同样是「靠输入退化蒙对」，它并未真正钉住 `!x.is_finite()`。

### ② 为什么是缺陷

闸的意图是「非有限坐标不得喂给 SVD」。当一个点的 **x 有限、y 非有限**（如 `y = ∞`）时，两条并项都
为假，该点**穿过闸门**进入八点法：它会被归一化并写进设计矩阵 `A`，一个 `∞` 经乘法/求和把整列污染成
`NaN`／`∞`，SVD 在这种矩阵上的结果**无意义却不会 panic**——`essential_matrix_eight_point` 可能因此
返回一个**看似合理的错误本征矩阵**，或者返回 `None` 但掩盖了「输入本来非法」这一事实。相机位姿恢复
据此把一对**垃圾观测**当作有效几何，偏差被静默吸收，**任何地方都不报错**。

### ③ 修法（未改任何生产逻辑，仅补测试）

在 `five_point.rs` 的 `tests` 加 `every_non_finite_coordinate_field_is_refused`——**4 例矩阵**，
逐例覆盖**两个输入数组 × 两个坐标分量**：`a.x`、`a.y`、`b.x`、`b.y`，每例用一个**非退化**的合成运动
输入（`synthetic_camera_motion(42)`，同文件既有用例 `the_eight_point_solver_recovers_a_synthetic_motion`
所用，`:859`），只污染 `[3]` 号点的**一个分量**，逐例断言 `essential_matrix_eight_point(&a, &b).is_none()`；
末尾补**反向补集**：未经污染的同一对合成对应点**必须**返回 `Some`（`is_some()`），使该测试不能靠
「求解器什么都不返回」空洞通过，也让「基准输入是良构的」这件事本身被钉住。两条闸条件本就在，一行生产
代码未改；既有 `a_non_finite_coordinate_is_refused` 保留。

### ④ 验证

`cargo test -p amos-robot --lib vision` ⇒ **48 passed**（本轮 +1，修前 47）；全量
`cargo test -p amos-robot` ⇒ **417 passed**（368 单元 + 37 集成 + 12 doctest）；
`cargo clippy -p amos-robot --all-targets -- -D warnings` ⇒ 净；`cargo fmt -p amos-robot -- --check`
⇒ 0 diff；`cargo doc -p amos-robot --no-deps` ⇒ 0 warn；`node scripts/fmea-gen.mjs --check` ⇒ 435 失效
模式 GREEN，`--self-test` ⇒ 12/12。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

①中性化 `!y.is_finite()`（置为 `false`）⇒ 新用例**恰 1 红**（新矩阵中 `a.y`／`b.y` 两例），其余全绿；
②中性化 `!x.is_finite()` ⇒ 新用例亦**恰 1 红**，但既有 `a_non_finite_coordinate_is_refused` **保持绿**
——这正是本轮①所述「非判别」的实测证据：既有用例即便对 x 分量也不具备判别力，靠的是退化输入蒙对 `None`。
逐字节还原后 `shasum -a 256 crates/amos-robot/src/vision/five_point.rs` =
`41bb9c8d832a7f97cb4c4a2990233edfe3c0f5087f4931c15a1176d92ced9e08`，复绿 48。

### 诚实边界

①这是**未执行的守卫条件**而非当下坏值——坐标闸逻辑本就正确，本轮补的是「有人钉住」；②**未改**生产
代码（`five_point.rs` 一行未改，扰动后逐字节还原，sha 如上），只加测试、**未新增脚本**；③只钉
`essential_matrix_eight_point` 的**两条坐标有限性闸**，**不**覆盖其后「对应点数量不足／退化」的分支、
归一化/T 矩阵语义、五点法的外积 ROOT 求解，或 `recover_pose` 的分解与 cheirality 判据（各由同文件
其余用例覆盖）；④本轮只钉**八点法**这一入口，**五点法**（`essential_matrix_five_point`）与
`fundamental_matrix_eight_point` 的同形坐标闸**未覆盖**，列为后续候选；⑤证据为 Rust 单测 +
clippy/fmt/doc + 两条活负控，**未做**真机／真图像复跑；⑥并发：落笔前经
`grep -rhoE 'REQ-A[0-9]+'`／`F-SH-[0-9]+` 重探（高水位 REQ-A754 / F-SH-211，均属并发
OTA·robot.ts 轮），取 **REQ-A755 / F-SH-212**（双向零命中）。

## 44. 补全（REQ-A762）：同一族的又一例入口闸——`vision::five_point::cheirality_count` 的「位于两台相机前方」判据——四条件里只有一半被执行（2026-09-21）

### ① 缺陷

`cheirality_count`（`crates/amos-robot/src/vision/five_point.rs:531`）在候选 `(R, t)` 下逐个对应点判定
**是否同时位于相机 1 与相机 2 前方**——这是三角化的物理前提（正深度）。入闸在 `:554`，**四条条件**用
逻辑与相连：

`lambda1.is_finite()` 与 `lambda2.is_finite()` 与 `lambda1` 大于零 与 `lambda2` 大于零

**实测**：把「`lambda1` 大于零」这条置真后，`cargo test -p amos-robot --lib vision` **48 条仍全绿**
——它零执行。四条里只有「`lambda2` 大于零」（第二台相机那一半）被既有用例
`a_pose_with_no_in_front_correspondence_is_refused`（`:1121`）钉住。该用例的所有输入要么是平行射线
（在 `:547` 被跳过）、要么两台相机都判否，故它**只覆盖第二台相机那一半**，从未构造出
「相机 1 后方、相机 2 前方」这一格。

另外两条 `is_finite` 叶子（`:554`）同样零执行——但对**有限 `f32` 输入**它们与 `:547` 的平行射线跳过
逻辑**冗余**：`f32::MAX` 量级的坐标也不会让 `lambda` 溢出成非有限，而 `det` 恰为零时 `lambda` 为 `NaN`
（已被「大于零」判否）。故本轮**不**把它们单列为缺陷，也**不**为其造测试（见诚实边界）。

### ② 为什么是缺陷

`recover_pose_from_essential`（`:260`）以 cheirality 的 in-front **计数**在四个 `(R, t)` 候选里挑赢家
（`:294-300`）。一条**位于相机 1 后方、相机 2 前方**的对应点在错误候选下被虚高计 +1，于是**错的候选
可能胜出**——返回一个 `Some(Pose2D)`，既不 panic 也不返回 `None`，调用方（视觉里程计 `vo.rs`）无从
区分。这与「深度为正」这一对极几何前提直接冲突：一个自洽的位姿应让对应点位于**两台**相机前方，而
这里的判据退化成了「只问第二台」。

### ③ 修法（未改任何生产逻辑，仅补测试）

在 `five_point.rs` 的 `tests` 加 `cheirality_requires_the_point_in_front_of_the_first_camera`——
**手推负例**：`R` 取单位阵、`t` 取 `(0,0,1)`、`a` 取 `(1,0)`、`b` 取 `(0,1)`，正规方程给出
`lambda1 = -1/3`（相机 1 后方）、`lambda2 = +1/3`（相机 2 前方），断言 `cheirality_count` 为 **0**；
末尾补**正例**：真实合成运动（`synthetic_camera_motion(9)`）的对应点应位于两台相机前方（断言计数
**大于 0**），使该测试不能靠「从不计数」空洞通过。四条条件本就在，一行生产代码未改；既有
`a_pose_with_no_in_front_correspondence_is_refused` 保留。

### ④ 验证

`cargo test -p amos-robot --lib vision` ⇒ **49 passed**（本轮 +1，修前 48）；全量
`cargo test -p amos-robot` ⇒ **418 passed**（369 单元 + 37 集成 + 12 doctest）；
`cargo clippy -p amos-robot --all-targets -- -D warnings` ⇒ 净；`cargo fmt -p amos-robot -- --check`
⇒ 0 diff；`cargo doc -p amos-robot --no-deps` ⇒ 0 warn；`node scripts/fmea-gen.mjs --check` ⇒ 441 失效
模式 GREEN，`--self-test` ⇒ 12/12。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

①把「`lambda1` 大于零」置真 ⇒ 新用例**恰 1 红**（负例），其余 48 绿；②把「`lambda2` 大于零」置真 ⇒
新用例**恰 1 红**，与既有用例合计 **2 红**；③把两条 `is_finite` 各自置真 ⇒ **49 全绿**（证实它们对
有限 `f32` 输入与平行射线跳过冗余，不单列为缺陷）。逐字节还原后
`shasum -a 256 crates/amos-robot/src/vision/five_point.rs` =
`b06f684208bd4a1c94803834c0be26d12fb71ab77f632639867660052c32bef4`，复绿 49。

### 诚实边界

①这是**未执行的守卫条件**而非当下坏值——cheirality 闸逻辑本就正确，本轮补的是「有人钉住」；②**未改**
生产代码（`cheirality_count` 一行未改，扰动后逐字节还原，sha 如上），只加测试、**未新增脚本**；③两条
`is_finite` 叶子同样未执行，但对**有限 `f32` 输入**与 `det.abs()` 小于 `1e-12` 的平行射线跳过逻辑
冗余，故**不**单列为缺陷、也**未**为其造测试（这一「不声称」本身是本轮的诚实边界）；④只钉八点法链路
的 cheirality 判据，**不**覆盖 `det` 跳过阈值（`1e-12`）或桑普森距离／内点判定；⑤证据为 Rust 单测 +
clippy/fmt/doc + 四条活负控，**未做**真机／真图像复跑；⑥并发：落笔前经
`grep -rhoE 'REQ-A[0-9]+'`／`F-SH-[0-9]+` 重探（高水位 REQ-A761 / F-SH-218，均属并发菜单契约轮），
取 **REQ-A762 / F-SH-219**（双向零命中）。

## 45. 补全（REQ-A766）：同一族的又一例入口闸——`vision::lk` 的两道边界闸在 x/y 上对称，但所有被执行的用例都只覆盖 x（且远侧）一半（2026-09-21）

### ① 缺陷

`vision::lk` 的 `optical_flow_sparse` 对每个特征跑 `track_one`，其中有两道「拒绝而非读错」的边界闸：

- **窗口界闸**（`track_one`，`lk.rs:163`）：四条叶子用逻辑或用逻辑与相连——左 `cx - radius < 0`、
  上 `cy - radius < 0`、右 `cx + radius + 1 >= width`、下 `cy + radius + 1 >= height`。**实测**右／下两条
  被 `a_window_whose_gradient_reaches_the_far_edge_is_lost_not_singular` 钉住；左／上两条**零执行**——
  唯一用到近边的 `a_lost_track_is_dropped_and_the_set_is_topped_back_up` 用角点 `(0,0)`，它**同时**触发
  左与上两条叶子，故任一条都无法单独失败。
- **采样界闸**（`bilinear`，`lk.rs:325` 与 `:332`）：**实测** x 侧四叶全部被执行
  （`bilinear_interpolates_between_pixels` 驱动 `!fx.is_finite()` 与 `ix + 1 >= width`，而流水线用例
  `a_target_sample_that_leaves_the_frame_is_lost_not_wrapped` 为纯水平位移），三条 **y** 叶子
  `!fy.is_finite()`、`iy < 0`、`iy + 1 >= height` **零执行**。

### ② 为什么是缺陷

两道闸的任意一条叶子被删掉，整套 `cargo test -p amos-robot --lib vision::lk`（修前 11 条）**仍然全绿**。
而后果是真实的：

- 丢掉左／上叶子后，梯度模板以负的 `px`／`py` 读 `prev[(py * width + px)]`——本机实测特征 `(0,1)` 与
  `(1,0)` 触发**越界索引 panic**；若负偏移仍在同一行内（例如 `py=0` 而 `px=-1` 被 `width` 折回上一行）
  则读到换行处别的像素，**语义错误而不 panic**。
- 丢掉 `iy` 叶子后，`bilinear` 的 `fy = NaN`（或越界值）被 `as i32` **饱和成第 0 行**，采样到错的行
  而非拒绝。

LK 是每帧对每个特征都跑的**热路径**，而边缘特征（冷启动检测或 `set_features` 均可产生）最易命中——
这正是「入口闸每一片叶子都要有人钉住」这条族谱（REQ-A725／A728／A733／A737／A746／A752／A755／A762）
在 `vision::lk` 上的下一例。

### ③ 修法

**未改**生产代码（`track_one`／`bilinear` 一行未改，扰动后逐字节还原）。只加两个测试：

- `the_left_and_top_window_bounds_are_refused_not_read_out_of_frame`：`(0,1)` 只触左叶（`cy - radius`
  恰为 0，非负）、`(1,0)` 只触上叶，断言 `LkOutcome::Lost`；末尾补 `(1,8)`／`(8,1)` 界内一像素的
  正例，使测试不能靠「拒绝一切近边特征」蒙混。
- `bilinear_refuses_a_stencil_that_leaves_the_frame_in_y`：`(0.5,1.5)` 触下叶、`(0.5,-0.5)` 触上叶、
  `(0.5,NaN)` 触非有限叶，各断言 `is_none()`；末尾补 y 中心 `(0.5,0.5)` 的正例。

### ④ 验证

`cargo test -p amos-robot --lib vision::lk` ⇒ **13 passed**（本轮 +2，修前 11）；全量
`cargo test -p amos-robot` ⇒ **420 passed**（371 单元 + 37 集成 + 12 doctest）；clippy `-D warnings` 净；
fmt `--check` 零 diff；doc `--no-deps` 零 warn；`node scripts/fmea-gen.mjs --check`（446 失效模式）与
`--self-test` ⇒ 12/12 绿。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

①把左叶 `cx - radius < 0` 置假 ⇒ 窗口界用例**恰 1 红**；②把上叶 `cy - radius < 0` 置假 ⇒ 同用例**恰 1 红**；
③把 `!fy.is_finite()` 置假 ⇒ 采样界用例**恰 1 红**；④把 `iy < 0` 置假 ⇒ 同用例**恰 1 红**；⑤把
`iy + 1 >= height` 置假 ⇒ 同用例**恰 1 红**。逐字节还原后
`shasum -a 256 crates/amos-robot/src/vision/lk.rs` =
`ba952ebce4192f2857e7599fad3adc9469502e011a96598f77ddbf0e366c8845`，复绿 13。

### 诚实边界

①这是**未执行的守卫条件**而非当下坏值——两道闸逻辑本就正确，本轮补的是「有人钉住」；②**未改**
生产代码（一行未改，扰动后逐字节还原，sha 如上），只加测试、**未新增脚本**；③**同一函数内尚有三条
未执行叶子未予处理**：`track_one` 奇异性闸（`lk.rs:207`）的 `!lambda_min.is_finite()`、
`lambda_min` 小于 `CONDITION_FLOOR` 乘 `lambda_max`、`det_f` 小于 `min_det`——本机实测置假后
`vision::lk` 11 条仍全绿，**列为下一轮候选**，本轮未声称；④只钉这两道边界闸，**不**覆盖奇异性闸或
收敛语义；⑤证据为 Rust 单测 + clippy/fmt/doc + 五条活负控，**未做**真机／真图像复跑；⑥并发：落笔前经
`grep -rhoE 'REQ-A[0-9]+'`／`F-SH-[0-9]+` 重探（高水位 REQ-A765 / F-SH-222），取 **REQ-A766 / F-SH-223**
（双向零命中）。

## 46. 补全（REQ-A771）：同一族的又两例入口闸——`vision::lk::track_one` 的奇异性闸四条叶子只被执行一条，且唯一「自称」覆盖条件闸的用例其实由另外两条冗余叶子拒绝（2026-09-21）

### ① 缺陷

`track_one` 的奇异性闸（`lk.rs:207-210`）四条叶子用逻辑或相连：

```text
!lambda_min.is_finite()
|| lambda_min <= 0.0
|| lambda_min < CONDITION_FLOOR * lambda_max
|| det_f < min_det
```

**实测**：把第 1、3、4 条各自置假，`cargo test -p amos-robot --lib vision::lk` 的既有 13 条**全绿**。
唯一被钉住的第 2 条来自 `a_flat_patch_is_singular_even_with_a_zero_gradient_floor`——它刻意配
`min_gradient = 0`，于是 `min_det = 0`，行列式地板对它是死代码。

更糟的是那条**自称**覆盖条件闸的用例。`a_one_dimensional_edge_is_refused` 的注释写着「the condition
guard must catch it」，但它用纯竖直条纹，`a11` 恰为 0 ⇒ `det = 0` 且 `lambda_min = 0`，于是
「`lambda_min` 不大于零」与「`det_f` 小于 `min_det`」**各自都**能拒绝它（互为冗余）——单独置假任一条，
该用例**都不红**，条件闸**从不**是决定性的。文档是假的。

### ② 为什么是缺陷

两条被漏掉的叶子各自是**一条文档契约的唯一实现**：

- **`det_f < min_det`** 是 `min_gradient` 契约（「梯度低于此则 2×2 奇异、特征丢失」）的唯一实现。置假后，
  一个 2 像素微斑（`a00 = 1, a11 = 2, a01 = 1` ⇒ `det = 1`，远低于地板 10）被接受；本机实测在 1-px
  位移（真值 `(1, 0)`）下返回 `NotConverged`，`dx = 1.0`（对）而 **`dy = −3.0`（真值 0）**——不是拒绝、
  不是零，而是**错的数**。
- **`lambda_min < CONDITION_FLOOR * lambda_max`** 是孔径问题（近共线梯度、沿边方向不可观）的唯一实现。
  置假后，一个陡坡近共线窗（`lambda_min` 约 9.8e-4、`lambda_max` 约 3.3e4，比值 3e-8，低于 1e-6 地板）
  被接受并报 `Converged`，而它的 y 向流不可观。

### ③ 修法

**未改**生产代码（`track_one` 一行未改，扰动后逐字节还原）。加两个测试，并把那条假注释改为如实：

- `a_patch_under_the_determinant_floor_is_singular_but_one_above_it_is_tracked`：**同一** 2 像素斑，
  幅度 1 使 `det = 1` 触发地板、幅度 2 使 `det = 16` 穿过地板（`det` 按幅度四次方缩放，形状不变）——
  断言前者 `Singular`、后者**不** `Singular`，使测试不能靠「拒绝一切微斑」蒙混。
- `a_near_parallel_gradient_is_refused_by_the_condition_guard`：陡坡（每列 60）叠加单像素 +2 制造近共线
  窗，断言 `Singular`；再补一片幅度 2 的棋盘格补出缺失的第二梯度方向，断言同一陡坡转为可追踪。
- `a_one_dimensional_edge_is_refused` 的文档注释改为如实：说明它由「`lambda_min` 不大于零」与「行列式
  地板」**冗余**拒绝，并非条件闸。

### ④ 验证

`cargo test -p amos-robot --lib vision::lk` ⇒ **15 passed**（本轮 +2，修前 13）；全量
`cargo test -p amos-robot` ⇒ **422 passed**（373 单元 + 37 集成 + 12 doctest）；clippy `-D warnings` 净；
fmt `--check` 零 diff；doc `--no-deps` 零 warn；`node scripts/fmea-gen.mjs --check` 与 `--self-test` 12/12 绿。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

①把 `det_f` 小于 `min_det` 置假 ⇒ 地板用例**恰 1 红**，其余 14 绿；②把 `lambda_min` 小于
`CONDITION_FLOOR` 乘 `lambda_max` 置假 ⇒ 条件闸用例**恰 1 红**，其余 14 绿；③**交叉隔离**：地板置假时
条件闸用例仍绿、条件闸置假时地板用例仍绿（两个夹具各自只被自己那条叶子决定）；④把非有限
`lambda_min` 置假 ⇒ **15 全绿**（对 u8 输入不可达，见诚实边界）。逐字节还原后
`shasum -a 256 crates/amos-robot/src/vision/lk.rs` =
`2da04433a756d6c7cf1a3de975c1c0ee91868af28f64bf7581ef519f77b98410`，复绿 15。

### 诚实边界

①这是**未执行的守卫叶子**而非当下坏值——闸逻辑本就正确，本轮补的是「有人钉住」；②**未改**生产代码
（`track_one` 一行未改，扰动后逐字节还原，sha 如上），只加测试 + 改一处测试文档注释；③
`!lambda_min.is_finite()` 对 u8 输入**不可达**：`a00, a11` 各不超过 9 乘 255 的平方即 585225，故 `trace`
与 `det` 必有限、`lambda_min` 必有限——**没有任何输入可构造**，它是纯防御叶子，本轮**不**为其造测试、
**不**单列为缺陷（这一「不声称」本身是诚实边界）；④只钉奇异性闸，**不**覆盖 `CONDITION_FLOOR` 与
`DET_FLOOR_WEIGHT` 的**取值**是否合理，也**不**覆盖迭代收敛语义；⑤证据为 Rust 单测 + clippy/fmt/doc +
四条活负控，**未做**真机／真图像复跑；⑥并发：落笔前经 `grep -rhoE 'REQ-A[0-9]+'`／`F-SH-[0-9]+` 重探
（高水位 REQ-A770 / F-SH-226），取 **REQ-A771 / F-SH-227**（双向零命中）。

## 47. 补全（REQ-A817）：同一族的又一例入口闸——`localization::McLocalizer::predict` 的四叶命令闸，`dt <= 0.0` 那一叶零执行（2026-09-21）

### ① 缺陷

`predict`（`localization.rs:537-545`）顶部四条件用逻辑或相连：

```text
!dt.is_finite()
|| dt <= 0.0
|| !cmd.linear_m_s.is_finite()
|| !cmd.angular_rad_s.is_finite()
```

**实测**：把第 2 条 `|| dt <= 0.0` 换成恒假，`cargo test -p amos-robot --lib localization` 的既有
31 条**全绿**（第 1、3、4 条各自置假各**恰 1 红**，故只有第 2 条是空的）。

既有的 `every_malformed_command_is_refused_and_leaves_the_belief_alone` 确实含「把 `dt_s` 设成
0.0」的一格，并断言粒子不变——但**零 `dt` 步本来就动不了粒子**：`root_dt = 0` 使三个噪声密度全为 0，
`v · dt = 0` 且 `w · dt = 0`，于是无论闸门在不在，粒子都逐字不变。那格断言与闸门无关。更糟的是该
测试的文档**逐字声称** `dt_s <= 0.0` 已被它钉住——**那句话是错的**。

### ② 为什么是缺陷

`predict` 返回 `()`（无错误返回），故两条被漏掉的路都静默：

- **负 `dt_s`**：`root_dt = dt.sqrt()` 得 `NaN`，随之 `sigma_v/sigma_w/sigma_h` 皆 `NaN`，
  `w = ω + sigma_w · gaussian` 皆 `NaN`，`theta = wrap_angle(θ + w · dt + …)` 皆 `NaN`，`x`／`y`
  经 `theta.cos()`／`theta.sin()` 一并成 `NaN`。**本机实测**：叶被删后一次 `dt_s = -1.0` 的
  `predict` 把 **512/512** 个粒子的 `x`／`y`／`theta` 全部毒化，此后每一次 `estimate()`／`update()`
  都在 `NaN` 上运算，滤波器**再无法恢复**，而调用方一无所知。
- **`dt_s = 0`**：粒子不动，但函数末尾仍执行 `self.last_dt_s = dt`，即写入 `0`。这与 `predict` 自己的
  文档「the belief is left exactly as it was」相悖——`last_dt_s` 是一次拒绝唯一可观测的痕迹，一个以
  `last_dt_s()` 判断「上一步是否真的走」的调用方会被这枚 0 误导。

### ③ 修法

**未改**生产代码（`predict` 的闸门一行未改，扰动后逐字节还原）。加一个测试，并把那条假文档声明改为如实：

- `a_nonpositive_dt_is_refused_and_leaves_both_the_cloud_and_last_dt_untouched`：先跑一次合法
  `dt_s = 0.1` 把 `last_dt_s` 移离构造值 `0.0`（使后续一次静默的 `last_dt_s = 0` 可见），再对
  `dt_s ∈ {0.0, -1.0}` 各自断言**云**与 **`last_dt_s`** 都原封不动（负值额外钉住那一叶独挡的 `NaN`）；
  末尾用 `dt_s = 0.2` 的合法步作补集，证明测试不是靠「拒绝一切」蒙混。
- `every_malformed_command_is_refused_and_leaves_the_belief_alone` 的文档注释：把「`dt_s <= 0.0`
  已被此处钉住」更正为如实——该格只断言粒子不变，而零 `dt` 步本来就保证这一点；真正钉住该叶的是上面
  那条新用例。

### ④ 验证

`cargo test -p amos-robot --lib localization` ⇒ **32 passed**（本轮 +1，修前 31）；全量
`cargo test -p amos-robot` ⇒ **374 单元 + 37 集成 + 12 doctest** 全绿；clippy `-D warnings` 净；
fmt `--check` 零 diff；doc `--no-deps` 净。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

把第 540 行 `|| dt <= 0.0` 换成恒假 ⇒ 新用例**恰 1 红**，其余 31 绿。逐字节还原后
`shasum -a 256 crates/amos-robot/src/localization.rs` =
`5e0200528a77736f3064113649be28b3f77bc9687aa8aa15c26f40554673728d`，复绿 32。
**实测后果对照**：叶被删时——合法步后 `last_dt_s = 0.1`，`dt_s = -1.0` 后 `last_dt_s = -1`、非有限粒子
**512/512**；叶在位时——`last_dt_s` 保持 `0.1`、非有限粒子 **0/512**。

### 诚实边界

①这是**未执行的守卫叶子**而非当下坏值——闸逻辑本就正确，本轮补的是「有人钉住」；②**只改测试与一处
文档**（生产闸门一行未动，扰动后逐字节还原，sha 如上）；③**未**在 `predict` 加错误返回——那是签名
变更、属独立设计决定，模块文档已声明「a motion step has no partial failure mode」；④**未做**真机运动
验证：两条后果都是纯算术，证据是单测 + 逐叶变异 + 实测数字；⑤其余三叶已逐一验证为**恰 1 红**，故本
闸门四叶现均有判别力；⑥并发：落笔前经 `grep -rhoE` 重探，高水位已被并行轮推到 REQ-A815 / F-SH-256，
且本轮起笔时曾取的 **REQ-A812 / F-SH-252 在落账前被并行轮占用**，故改取 **REQ-A817 / F-SH-257**
（双向零命中后落笔）；`fmea-gen --check` 当下仍报 **F-SH-251**（散文提及而库存缺条目）——**非本轮**。

## 48. 补全（REQ-A840）：同一族的又一例入口闸——`slam::SlamState::observe` 的八叶读数闸，`bearing_variance` 的 `is_finite` 叶零执行（2026-09-21）

### ① 缺陷

`observe`（`slam/ekf.rs:518-526`）顶部八条件用逻辑或相连；逐叶变异（把该叶换成恒假、其余不动）实测：

```text
range_m.is_finite()            → 删掉恰 1 红
bearing_rad.is_finite()        → 删掉恰 1 红
range_variance.is_finite()     → 删掉恰 1 红
bearing_variance.is_finite()   → 删掉 27 全绿   ← 零执行
sensor_offset_x_m.is_finite()  → 删掉恰 1 红
sensor_offset_y_m.is_finite()  → 删掉恰 1 红
range_variance < 0.0           → 删掉恰 1 红
bearing_variance < 0.0         → 删掉恰 1 红
```

既有的 `every_malformed_observation_field_is_refused_as_bad_input` 覆盖了**每一个字段**，却没有覆盖
**每一条叶子**：它对 `bearing_variance` 只喂 `f32::NEG_INFINITY`——这恰好是兄弟叶 `< 0.0` 也命中的
值，两叶对它不可分。对照 `range_variance` 喂的是 `NaN`（`NaN < 0.0` 为假），那一格只走 `is_finite`
叶——所以同一条闸门里，一个字段被钉住了，另一个只被钉住了一半符号。

### ② 为什么是缺陷

**实测后果**（叶被删时）：一条 `bearing_variance = +INFINITY` 的读数

- 第一次 `observe` ⇒ **`Ok(Created { landmark_index: 0 })`**——用一条畸形读数**建立了一个地标**
  （创建分支根本不使用 `R`，故这个方差从未被查过）；
- 第二次同一读数 ⇒ **`Singular`**——正是这道闸自己注释里写要避免的「a geometry verdict for what is
  a malformed input」，而 `Singular` 的文档是「地标压在机器人上」，一个照此「改位姿重试」的调用方
  会永远重试。

叶在位时，两次都是 `BadInput`、地标数为 0。闸门自己的注释早已逐字声明这对后果（「a NaN variance
would otherwise slip through and poison `R`, `S`, `K` and the covariance」），只是测试没压到它。

### ③ 修法

**未改**生产代码（`observe` 八叶闸门一行未改，扰动后逐字节还原）。在
`every_malformed_observation_field_is_refused_as_bad_input` 的 `non_finite` 数组里为
`bearing_variance` **正负各加一条**（数组 6 → 7）：正的 `+INFINITY` 是唯一单走 `is_finite` 叶的
值，负的 `NEG_INFINITY` 保留（它钉的是 `< 0.0` 叶）；并把该测试的文档改为如实——**覆盖了每个字段
不等于覆盖了每条叶子**。

### ④ 验证

`cargo test -p amos-robot --lib slam::ekf` ⇒ **27 passed**（用例条数不变，本轮加的是数据项而非新
用例）；全量 `cargo test -p amos-robot` ⇒ **374 单元 + 37 集成 + 12 doctest** 全绿；clippy
`-D warnings` 净；fmt `--check` 零 diff；doc `--no-deps` 净。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

把第 521 行 `|| !observation.bearing_variance.is_finite()` 换成恒假 ⇒ 该用例**恰 1 红**，并在
`+INFINITY` 那一格弹出 `a non-finite bearing_variance must be BadInput, not a geometry verdict`，
其余 26 绿。逐字节还原后 `shasum -a 256 crates/amos-robot/src/slam/ekf.rs` =
`4d07533a723451d1118519144f1e4e812cf1b70d36aba390b5ef4a6cf76f7cdf`，复绿 27。

### 诚实边界

①这是**未执行的守卫叶子**而非当下坏值——闸逻辑本就正确，本轮补的是「有人钉住」；②**只加测试数据与
一处文档**，生产闸门一行未动（扰动后逐字节还原，sha 如上）；③**未**改 `observe` 的零方差政策
（`< 0.0` 接受零，与 `McLocalizer::update` 的 `<= 0.0` 不一致——那是已记在 §38 的独立议程）；④用例
条数不变，故 `crates/amos-robot/README.md` 的单元测试计数仍为 374；⑤**同族已核查并驳回的一例**：
`SlamState::predict` 顶部四叶闸门的前三叶（非有限 `linear`／`angular`／`dt`）同样删掉无红，但它们被
紧随的「非有限位姿」闸门（第 407 行）以**同一种** `BadInput` 完全遮蔽——删除它们不改变任何可观测
行为，属**冗余而非缺陷**，故本轮不为它们立项（这一「不声称」本身是诚实边界）；⑥并发：落笔前经
`grep -rhoE` 重探，高水位已被并行轮推到 REQ-A839 / F-SH-268，故取 **REQ-A840 / F-SH-269**（双向零
命中后落笔）；`fmea-gen --check` 当下仍报 **F-SH-251**（散文提及而库存缺条目）——**非本轮**。

## 49. 补全（REQ-A846）：同一族的又一例入口闸——`planning::dwa` 的 `dt_s` 两叶闸，`!dt_s.is_finite()` 叶零执行，而漏的是一个「无效控制限被报成安全」（2026-09-21）

### ① 缺陷

`dwa`（`planning.rs:1952`）的 `if !limits.dt_s.is_finite() || limits.dt_s <= 0.0` 两条件用逻辑或相连；
逐叶变异（把该叶换成恒假、其余不动）实测：

```text
!limits.dt_s.is_finite()       → 删掉 60 全绿   ← 零执行
limits.dt_s <= 0.0             → 删掉恰 1 红
```

既有的 `dwa_refuses_a_zero_dt` 只喂 `0.0`——而 `NaN <= 0.0` 为假（所有与 `NaN` 的比较都为假），所以
非有限的 `dt_s` 恰好只走 `is_finite` 叶。钉住闸门拒绝的**某一个值**，不等于钉住它的**每一条叶子**。

### ② 为什么是缺陷

`DwaError::BadDt` 的 Display 逐字写着 "the rollout sub-step dt_s must be finite and positive"——这条契约
本就宣告了这两叶。**实测后果**（叶被删时）：

- `dt_s = NaN` ⇒ `Ok(DwaScore { velocity: { v_mm_s: 1000, omega_mrad_s: -1000 }, value: 0.8999999999999999,
  clearance_mm: 3000, safe: true })`
- `dt_s = +INFINITY` ⇒ 同上

即**在一个无效的控制限上报出 `safe: true`**，而且 `value` 与一个合法 `dt_s` 的结果**逐位相同**（`dt_s`
对打分几乎无影响）——调用方从返回值里没有任何线索察觉输入非法。这正是模块自己第 1967 行的注释为越界
速度拒绝的那一类后果（"the function would report a *safe stop* for a vehicle whose velocity estimate is
wrong — a fault reported as an all-clear"）。叶在位时，两种取值都返回 `Err(BadDt)`。

### ③ 修法

**未改**生产代码（`dwa` 的两叶闸门一行未改，扰动后逐字节还原）。把只喂 `0.0` 的用例扩成
`[0.0, -1.0, NAN, +INFINITY]` 的循环（`NaN` 与 `+INFINITY` 是唯一单走 `is_finite` 叶的值，负值走
`<= 0.0` 叶），并把用例改名为如实（`dwa_refuses_a_dt_that_is_not_finite_and_positive`）——**用例条数
不变**，是改名不是新增；在该测试的文档里写明「钉住闸门拒绝的某一个值，不等于钉住它的每一条叶子」以及
与 §48 同族。

### ④ 验证

`cargo test -p amos-robot --lib planning` ⇒ **60 passed**（用例条数不变）；全量 `cargo test -p amos-robot`
⇒ **374 单元 + 37 集成 + 12 doctest** 全绿；clippy `-D warnings` 净；fmt `--check` 零 diff；doc
`--no-deps` 净。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

把第 1952 行 `!limits.dt_s.is_finite()` 换成恒假 ⇒ **恰 1 红**（59 passed / 1 failed），弹出
`called Result::unwrap_err() on an Ok value: DwaScore { velocity: DwaVelocity { v_mm_s: 1000,
omega_mrad_s: -1000 }, value: 0.8999999999999999, clearance_mm: 3000, safe: true }`，其余 59 绿。逐字节
还原后 `shasum -a 256 crates/amos-robot/src/planning.rs` =
`c655e7a5c17558b68f0c133ea220acda0f59349f01a2e0d02ce1c26fb545505e`，复绿 60。

### 诚实边界

①这是**未执行的守卫叶子**而非当下坏值——闸逻辑本就正确，本轮补的是「有人钉住」；②**只扩测试数据与一
处文档**，生产闸门一行未动；③**未**改 `DwaLimits` 的任何默认值或 `for_ground_vehicle`；④用例条数不变，
故 `crates/amos-robot/README.md` 的单元测试计数仍为 374；⑤**同族已核查并驳回的候选**：本轮把 sweep 扩到
整个 `amos-robot`，`fusion::AttitudeEstimator::update` 的各叶、`safety` 模块全部十叶、`localization`／
`mrac`／`vision` 的相关叶**逐叶置假后各恰 1 红**（已钉住，非缺陷）；`fusion::gravity_reference` 的
`!norm.is_finite()` 与 `update_with_mag` 的 `!mag.is_finite()` 删掉无红，但**被同函数内的兄弟检查完全
遮蔽**（前者被自身注释标为 defensive／unreachable，后者被 `MagSample::norm_ut` 的同一检查遮蔽）——属
**冗余而非缺陷**，故不立项（这一「不声称」本身是诚实边界）；⑥并发：落笔前经 `grep -rhoE` 重探，高水位已
被并行轮推到 REQ-A845 / F-SH-273，故取 **REQ-A846 / F-SH-274**（双向零命中后落笔）；`fmea-gen --check` 当
下仍报 **F-SH-251**（散文提及而库存缺条目）——**非本轮**。

## 50. 补全（REQ-A860）：同一族的又一例入口闸——`fusion::with_gains` 的增益两叶闸，`kp.is_finite()` 叶零执行，而漏的是一个「非有限增益把姿态冻结在水平却仍报已纠正」（2026-09-21）

### ① 缺陷

`AttitudeEstimator::with_gains`（`fusion.rs:404` 起）是这样装增益的：

```rust
if kp.is_finite() && kp >= 0.0 {
    estimator.kp = kp;
}
if ki.is_finite() && ki >= 0.0 {
    estimator.ki = ki;
}
```

两叶用逻辑与相连。逐叶变异（把 `kp.is_finite()` 换成恒真、其余不动）实测：
`cargo test -p amos-robot --lib fusion::` ⇒ **42 passed / 0 failed 逐字不变**。
把 `ki.is_finite()` 换成恒真，同样 **42 passed 逐字不变**。也就是说，这两叶在本仓的
测试里**从未被执行过**——它们可以被删掉而无人报警。

### ② 为什么是缺陷

既有的那条用例只喂了两个值：

```rust
let mut estimator = AttitudeEstimator::with_gains(f32::NAN, -1.0);
```

`NAN` 与 `-1.0` 都被 `>= 0.0` 那半**同样**拦住（`NaN >= 0.0` 为假，`-1.0 >= 0.0` 为假），
所以这条用例即便删掉 `is_finite` 叶也照样红——它钉住的是**同门第二叶**，不是这一叶。
唯一**只**走 `is_finite` 这一叶的值是 `+INFINITY`：`INF >= 0.0` 为真，只有 `is_finite` 能拦它。

闸门自己的文档早已声明这条契约，逐字是：

> A non-finite or negative gain is ignored (the default is kept) rather than propagating a `NaN`
> into every later step.

也就是说文档承诺「非有限增益被忽略、默认增益顶上」，而 `is_finite` 叶正是这条承诺对
`+INFINITY` 的唯一执行者。

### ③ 修法

**只改测试，生产闸门一行未动。** 把只喂 `[NAN, -1.0]` 的用例扩成 `[NAN, +INFINITY, -1.0]`
的三值循环，并对 `kp` 与 `ki` 各自直接断言落回默认：

```rust
for bad in [f32::NAN, f32::INFINITY, -1.0] {
    let mut estimator = AttitudeEstimator::with_gains(bad, bad);
    assert_eq!(estimator.kp, DEFAULT_KP, "kp = {bad} must be ignored, not installed");
    assert_eq!(estimator.ki, DEFAULT_KI, "ki = {bad} must be ignored, not installed");
    let attitude = run(&mut estimator,
        &ImuSample::new(gravity_body(10.0_f32.to_radians(), 0.0), [0.0; 3]), 6.0);
    assert_eq!(attitude.correction, GravityCorrection::Applied);
    assert!((attitude.roll_rad.to_degrees() - 10.0).abs() < 1.0, /* … */);
    assert!(attitude.pitch_rad.to_degrees().abs() < 1.0, /* … */);
}
// 正例：有限非负增益确实会被装上，证明 setter 并非什么都不装。
let tuned = AttitudeEstimator::with_gains(2.0, 0.5);
assert_eq!(tuned.kp, 2.0);
assert_eq!(tuned.ki, 0.5);
```

把 roll 界从原来的 5° 收紧到 1°：默认增益 6 秒收敛到 **9.9755°**（稳过 1°），而被泄漏的
非有限增益冻结在 **0°**（必然越界）。用例改名为如实
`a_non_finite_or_negative_gain_is_ignored_rather_than_propagated`——**条数不变，是改名不是新增**。

**实测后果**（把 `+INFINITY` 当合法增益装进 `kp`，即叶被删时会发生的事）：更新式
`g = gyro + kp·error + correction` 随之非有限，`quat_normalize` 回退到单位四元数
`[1, 0, 0, 0]` ⇒ 估计器对 10° 的横滚输入报出 **roll = 0° / pitch = 0°（水平）**，却**仍标
`GravityCorrection::Applied`**。对照：增益被正确忽略时同一条 6 秒跑出 **roll = 9.9755° 且
`Applied`**。控制器拿到的是一条无从分辨的「车身水平、重力已纠正」全清——而车身其实倾了 10°。

### ④ 验证

`cargo test -p amos-robot --lib fusion::` ⇒ **42 passed**（用例条数不变，本轮只在既有用例里
加数据项）；全量 `cargo test -p amos-robot` ⇒ **375 单元 + 37 集成 + 12 doctest** 全绿；clippy
`-D warnings` 净；fmt `--check` 零 diff；doc `--no-deps` 净。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

把第 404 行 `kp.is_finite()` 换成恒真 ⇒ **恰 1 红**（41 passed / 1 failed），弹出
`assertion left == right failed … kp = inf must be ignored, not installed`；把第 407 行
`ki.is_finite()` 换成恒真 ⇒ **恰 1 红**（41 passed / 1 failed，`ki = inf must be ignored`）。
逐字节还原后 `shasum -a 256 crates/amos-robot/src/fusion.rs` =
`ac5490c2f8051e33400abd16f8152d95dd55a6f1cfb6bee653074c9a58756542`，复绿 42。

### 诚实边界

①这是**未执行的守卫叶子**而非当下坏值——`with_gains` 的闸逻辑本就正确，本轮补的是「有人钉住」；
②**只加测试数据与一段文档注释**，生产闸门一行未动（扰动后逐字节还原，sha 如上）；③**未**改
`DEFAULT_KP` / `DEFAULT_KI` 的取值，也**未**改 `with_gains` 对负值的策略（负值仍被忽略、不报错——
那是既有契约，改它会是另一件事）；④本轮是改名而非新增，未改 `crates/amos-robot/README.md`（其计数行写的 374 属别的轮；并发轮在
审计期间另加了一例，故本轮实测 lib 总数为 375）；⑤**同族已核查并驳回的若干例**：`fusion::accel_norm_m_s2`（第 159 行）的 `y` / `z` 两叶删掉
无红，但该函数是私有的、其文档声明调用方先经 `ImuSample::is_finite` 过滤，属**防御性冗余**；
`fusion::gravity_reference` 的 `!norm.is_finite()` 与 `update_with_mag` 的 `!mag.is_finite()` 删掉无红
但被**同函数内的兄弟检查完全遮蔽**；`slam::Landmark::mahalanobis_squared`（第 115 行）的
`!det.is_finite()` 删掉无红，但被第 127 行**同一返回值**的 `!sq.is_finite()` 完全遮蔽；`vision::five_point`
（第 214 行）的 `!s[0].is_finite()` 与 `s[0] <= 0.0` 删掉无红，因 `s` 来自一次对有限输入做的 SVD，属
**构造性防御**——以上皆**冗余而非缺陷**，故本轮不为它们立项（这一「不声称」本身是诚实边界）；
⑥并发：落笔前经 `grep -rhoE` 重探，高水位已被并行轮推到 REQ-A859（并行轮已占用 A855–A859），
F-SH 高水位 274，故取 **REQ-A860 / F-SH-276**（跳过 275 以避开在写轮，双向零命中后落笔）；
`fmea-gen --check` 当下仍报 **F-SH-251**（散文提及而库存缺条目）——**非本轮**。

## 51. 补全（REQ-A877）：同一族的又一例——`slam::occupancy::index` 的边界闸有两轴，`row >= self.rows` 那一叶零执行，而漏的是一次「越界的行被静默接受」（2026-09-22）

### ① 缺陷

`OccupancyGrid::index`（`slam/occupancy.rs:363`）是全部取址的入口：

```rust
if col >= self.cols || row >= self.rows {
    return None;
}
```

两叶用逻辑或相连。逐叶变异（把 `row >= self.rows` 换成恒假、其余不动）实测：
`cargo test -p amos-robot --lib slam::occupancy` ⇒ **19 passed / 0 failed 逐字不变**。
把第一叶 `col >= self.cols` 换成恒假则 **恰 2 红**——也就是说，`col` 轴被钉住了，
`row` 轴一叶在本仓的测试里**从未是判决者**。

### ② 为什么是缺陷

既有的四条越界断言全都摆在 `col` 轴上：

| 用例 | 越界处 | 判决叶 |
| --- | --- | --- |
| `add_hit(2, 0)` | col 2 ≥ cols 2 | `col >= self.cols` |
| `classify(0, 9)` | col 0 在界内、row 9 越界 | 看似 row，实为 `cells.get` 兜底 |
| `add_miss(&[(9, 9)])` | col 9 ≥ cols 2 | `col >= self.cols` |
| `bresenham((0,0),(4,0))` | col 4 ≥ cols 3 | `col >= self.cols` |

唯一看着像 row 的 `classify(0, 9)` 其实**不是**这一叶在拒绝：它经 `get` 读格，
而 `get` 是 `self.index(col, row)?` 之后再 `self.cells.get(idx).copied()`——index 若放行，
`cells.get` 那个 `Option` 照样拒绝。所以这条路径上 `row` 叶是**被遮蔽**的。

但在另外两条路径上没有这层兜底：

- **`add_miss`** 只用 `index` 做校验（`if self.index(col, row).is_none() { return Err }`），
  之后的写循环对 `None` 槽位是**静默跳过**（`if let Some(slot) = self.cells.get_mut(idx)`）；
- **`bresenham_line`** 只用 `index` 校验两个端点，之后只走坐标、不碰 `cells`。

两处文档都早已声明这条契约：`add_miss` 写着 *"All cells are validated before any is written.
A list containing an out-of-bounds cell is refused with the grid untouched."*；
`bresenham_line` 写着 *"Returns `Err` if either endpoint is outside the grid."*

### ③ 修法

**只扩测试数据与用例文档，生产闸门一行未动。** 把三条既有用例扩成两轴都覆盖：

- `out_of_bounds_is_refused` 补 `add_hit(0, 2)` 与 `classify(0, 2)` 两组 row 例；
- `a_miss_list_with_a_bad_cell_leaves_the_grid_untouched` 补一条 **row-only** 越界批
  `add_miss(&[(0, 0), (0, 2)])`——这是唯一能钉住该叶的路径；
- `bresenham_refuses_out_of_bounds_endpoints` 补 row 端点，且 `from`／`to` 两端各一例。

**用例条数不变**，是扩数据不是新增。

**实测后果**（叶被删时）：在 2×2 网格上 `add_miss(&[(0, 2)])` 返回 **`Ok(())`** 并悄悄丢掉
那个越界格（文档说会 `Err` 且网格不动）；`bresenham_line((0,0),(0,2))` 在 2 行网格上返回
**`Ok(2)`**（文档说会 `Err`）。对照组（col 轴）两种写法都仍 `Err`。

### ④ 验证

`cargo test -p amos-robot --lib slam::occupancy` ⇒ **19 passed**（用例条数不变）；全量
`cargo test -p amos-robot` 全绿；clippy `-D warnings` 净；fmt `--check` 零 diff；
doc `--no-deps` 净。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

把第 363 行 `row >= self.rows` 换成恒假 ⇒ **恰 2 红**（17 passed / 2 failed），红的正是两条被
扩过的用例：`a_miss_list_with_a_bad_cell_leaves_the_grid_untouched`
（`crates/amos-robot/src/slam/occupancy.rs:539`）与 `bresenham_refuses_out_of_bounds_endpoints`
（`:574`），其余 17 绿；把第一叶 `col >= self.cols` 换成恒假同样 **恰 2 红**（col 轴那两条）。
逐字节还原后 `shasum -a 256 crates/amos-robot/src/slam/occupancy.rs` =
`f9e851d975e126f5c6d42fc5859a73b6156bda7a416134eb5263ab1a07d82cf1`，复绿 19。

### 诚实边界

①这是**未被执行的守卫叶子**而非当下坏值——`index` 的两叶闸逻辑本就正确，本轮补的是「有人钉住」；
②**只扩测试数据与用例文档**，生产闸门一行未动（扰动后逐字节还原，sha 如上）；③用例条数不变，
本轮**未**新增用例；④**被核查并驳回的同族候选**：`bresenham_line` 自身第 309 行的四叶游走边界闸
（`x < 0 或 y < 0 或 x >= cols 或 y >= rows`）四叶**逐叶置假全绿**，但两个端点都先经 `index` 校验
在界内，而 Bresenham 游走对每个目标轴单调推进 ⇒ `(x, y)` 不会离开两端点的外接框，该闸**不可达**
（冗余防御而非缺陷），故不立项；这一「不声称」本身是诚实边界；⑤并发：落笔前经 `grep -rhoE` 重探，
高水位已被并行轮推到 **REQ-A876 / F-SH-282**（并行轮已占用 A861–A876、F-SH-277–F-SH-282），故取
**REQ-A877 / F-SH-283**（双向零命中后落笔）。

## 52. 补全（REQ-A1010／REQ-A1011）：同一族的又一例——`vision::fast` 的入口闸三叶零执行，而漏的是一个「短缓冲帧被 panic 拒绝、超界帧被静默截断」（2026-09-22）

`crates/amos-robot/src/vision/fast.rs` 的 `FastDetector::detect` 有两道输入闸，本轮的两次测量各揭其一。

### ① 缺陷

**（甲）第 121 行的三叶输入闸，三叶一个都没被执行：**

```rust
let pixel_count = (config.width as usize).saturating_mul(config.height as usize);
if config.width < 3 || config.height < 3 || pixels.len() < pixel_count {
    return corners;
}
```

仓里那条用例逐字是

```rust
fn a_too_small_image_is_refused() {
    let d = FastDetector::new();
    let c = d.detect(&[0u8; 8], &FastConfig::conservative(4, 4));
    assert!(c.is_empty());
}
```

4×4 的扫描窗口 `for y in 3..(h − 3)` 是 `3..1` —— **空区间**。函数在执行完入口闸之后就走到函数尾返回空 `Vec`，
那条用例的 `is_empty()` 因此对三叶全都恒真。逐叶变异实测：**每一叶**换成恒假，`cargo test -p amos-robot --lib vision::fast`
⇒ **10 passed ／ 0 failed 逐字不变** —— 三叶全空。

**（乙）第 129 行的 u16 上界有两叶，`height` 那一叶从未是判决者：**

```rust
if config.width > u16::MAX as u32 + 2 || config.height > u16::MAX as u32 + 2 {
    return corners;
}
```

既有的 `an_image_whose_coordinates_do_not_fit_u16_is_refused` 用 70_000 **宽** × 16 高 —— 只越 `width` 轴。
`config.height > u16::MAX as u32 + 2` 换恒假 ⇒ **10 passed 逐字不变**；第一叶 `width` 换恒假则**恰 1 红**。

### ② 为什么是缺陷

**(甲)** `pixels.len() < pixel_count` 那一叶在**任何窗口 ≥ 3** 的帧上是**唯一**的拒绝者 —— 没有别的东西拦住短缓冲。
叶被删时 `scores = vec![-1; pixel_count]` 照常分配、扫描照常进入，于是第 165 行 `pixels[cy * (w as usize) + cx]` 越界。
文档（`detect` 的签名注释）说的是「`pixels` must be `width · height` long」，语义是**拒绝**。

**(乙)** `Corner::x`／`y` 是 `u16`，紧跟其后的那段注释自己写明了这条契约：
*「An image wider than that would have `x as u16` silently truncate the coordinate mod 65_536 — a **wrong** corner,
not a refused one.」* `height` 是同一条理由的另一轴，而它从未被求值。

### ③ 修法

**只扩测试数据与用例文档，生产闸门一行未动。**

- `a_too_small_image_is_refused` 保留 4×4 旧例，另补短缓冲例
  `d.detect(&[0u8; 8], &FastConfig::conservative(16, 16))` 断言为空 —— 窗口 ≥ 3 才会走到索引语句，这是唯一能钉住该叶的形状。
- `an_image_whose_coordinates_do_not_fit_u16_is_refused` 保留宽度轴旧例，另补高度轴夹具
  （16 宽 × 70_000 高、亮块在 row ≈ 66_000）断言为空 —— 镜像旧例形状，唯一差别是越界那一轴。

**用例条数不变**，是扩数据不是新增。

### ④ 验证

**(甲) 实测后果**（叶被删时）：`detect(&[0u8; 8], &FastConfig::conservative(16, 16))` 在
`crates/amos-robot/src/vision/fast.rs:165:30` **panic** —— `index out of bounds: the len is 8 but the index is 11`；
闸在位时同一次调用返回空集。`detect` 是纯读 `&self`，所以这是一次**远程 panic** 而不是一次拒绝。

**(乙) 实测后果**（叶被删时）：16 宽 × 70_000 高、亮块在 row ≈ 66_000 的图返回 **16 个角点**，
`first = Corner { x: 6, y: 464, score: 255 }` —— 真实的 ~66_000 被 `y as u16` 截成 464。闸在位时返回空集。
**错坐标比 panic 更坏**：那个角点会进入 `vision::vo` 的特征关联与位姿估计，错误随帧累积而无任何拒绝信号。

`cargo test -p amos-robot --lib vision::fast` ⇒ **10 passed**（用例条数不变）；全量 `cargo test -p amos-robot`
⇒ **375 单元 + 44 集成** 全绿；clippy `-D warnings` 净；fmt `--check` 零 diff；doc `--no-deps` 净。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

- 第 121 行 `pixels.len() < pixel_count` 换恒假 ⇒ **恰 1 红**（9 passed ／ 1 failed，红的是 `a_too_small_image_is_refused`，
  弹出上面的 `:165:30` 越界 panic）；另两叶置假则全绿。
- 第 129 行 `config.height > u16::MAX as u32 + 2` 换恒假 ⇒ **恰 1 红**（9 passed ／ 1 failed，红的是
  `an_image_whose_coordinates_do_not_fit_u16_is_refused` 的高度轴那段）；第一叶 `width` 换恒假同样 **恰 1 红**，两侧都可判。
- 逐字节还原后 `shasum -a 256 crates/amos-robot/src/vision/fast.rs` =
  `9bd56b2c9e38cf2ffe9416b2a2e761dfb7a0bb9536bcb76bd87623bc1b4c1512`，复绿 10。

### 诚实边界

①两次都是**未被执行的守卫叶子**而非当下坏值——两道闸的逻辑本就正确，本轮补的是「有人钉住」；
②**只扩测试数据与用例文档**，生产闸门一行未动（扰动后逐字节还原，sha 如上）；③用例条数不变，本轮**未**新增用例；
④**被核查的对称叶**：第 121 行的 `config.width < 3` 与 `config.height < 3` 两叶同样零执行，但它们在任何窗口 ≥ 3 的帧上
**恒假**（`for y in 3..(h − 3)` 已蕴含 `h ≥ 3`），属**冗余的对称守卫而非当下缺陷**，故本行只把承重的 length 叶钉住，
**不声称**另两叶是缺陷；这一「不声称」本身是诚实边界；⑤**未**改 `FastConfig`／`FastDetector` 的签名或默认值，也**未**改
`Corner` 的 `u16` 字段类型——若将来要支持更大的帧，正确反应是那条测试变红并推动类型变更，而**不是**放宽上界；
⑥并发：落笔前经 `grep -rhoE` 重探，高水位已被并行轮推到 **REQ-A1009 / F-SH-330**（并行轮已占用 A1000–A1009、F-SH-322–F-SH-330），
故取 **REQ-A1010 / F-SH-331** 与 **REQ-A1011 / F-SH-332**（双向零命中后落笔）。

## 53. 补全（REQ-A1021）：同一族的又一例——`slam::ekf` 的「非有限行列式即拒绝」被写了两遍、两处互为遮蔽，任何单叶变异都测不到它（2026-09-22）

`crates/amos-robot/src/slam/ekf.rs` 的 `observe` 路上，同一道拒绝以逐字相同的两叶闸出现了 **两次**。

### ① 缺陷

**`innovation_gate_squared`（第 735 行）与 `update_landmark`（第 791 行）各有一道同样的闸：**

```rust
let det = m.s[0] * m.s[3] - m.s[1] * m.s[2];
if !det.is_finite() || det.abs() <= MIN_INNOVATION_DET {
    return Err(SlamError::Singular);
}
```

`observe` 在调用 `update_landmark` 之前，先对**同一个** `S` 跑 `innovation_gate_squared`，并把错误传播出去。
于是第 791 行那道闸的 `return Err(SlamError::Singular)`（第 792 行）在 628 段覆盖记录里**计数为 0** ——
它在现有唯一调用路径上**根本不可达**；反过来，第 735 行被删时，第 791 行仍会以相同的 `det` 作出相同拒绝。

**逐叶变异实测（本条的核心）：**

- 把第 735 行 `!det.is_finite()` 换成恒假 ⇒ `cargo test -p amos-robot --lib slam::ekf` **28 passed ／ 0 failed 逐字不变**；
- 单独把第 791 行同一叶换成恒假 ⇒ 同样 **28 passed 逐字不变**；
- 把**两处同时**换成恒假 ⇒ **27 passed ／ 1 failed**。

也就是说：**这道闸作为「一份拒绝」是一个整体，任何单叶负控都判它绿。**

### ② 为什么是缺陷

`S = H Σ Hᵀ + R`。`observe` 的输入边界只查 `is_finite()` 且 `>= 0`，所以一个**有限、非负、巨大**的方差
（`range_variance = bearing_variance = 3.0e38`）会被接受，使 `S` 上溢成 `+inf`，从而
`det = s₀·s₃ − s₁·s₂` 变成 `±inf`（或 `NaN`）。同行的兄弟叶 `det.abs() <= MIN_INNOVATION_DET`
**抓不住** `±inf`／`NaN`（`inf <= 1e-12` 为假）—— 只有 `!det.is_finite()` 这一叶能拦下它。

**实测后果（两处都失守时）**：一次对已存在 landmark 的重复观测（range 2.0、`range_variance` 3.0e38、
`bearing_variance` 3.0e38）返回 **`Matched { landmark_index: 0 }`** —— 一个 `d² = 0` 的**伪造的完美匹配**，
正是该函数注释里点名的「把一次观测当成重复 landmark 而把它吞掉」的那种腐蚀，而不是 `Err(SlamError::Singular)`。
一个 `+inf` 行列式在闭合解里会算出一组 `NaN` 的增益，若被当成有效匹配写入状态，错误会静默累积进 SLAM 地图。

### ③ 修法

**生产代码逐字节未动**（两处闸一行未改）：

1. 新增一条**仅测试**用例 `an_overflown_innovation_determinant_is_refused_not_read_as_a_perfect_match`
   （`ekf.rs` 第 1683 行）：先建一个 `SlamObservation::lidar(2.0, 0.0)` 的 landmark，再以
   `range_variance: 3.0e38`、`bearing_variance: 3.0e38` 复观测，断言返回 `Err(SlamError::Singular)`
   且 `num_landmarks()` 仍为 1；
2. 在 `update_landmark` 那道闸上方补一段注释，写明它是 `innovation_gate_squared` 同一个拒绝的**最后一道**、
   在现有唯一路径上不可达、两条闸互为遮蔽，**并指向新用例** —— 让下一位读者知道这道闸必须与它成对测试。

### ④ 验证

- `cargo test -p amos-robot --lib slam::ekf` ⇒ **28 passed**（较 27 新增 1 例）；
- `cargo test -p amos-robot` ⇒ **376 单元 + 9 集成套**（425 例）全绿；
- `cargo clippy -p amos-robot --all-targets -- -D warnings` **净**；`cargo fmt -p amos-robot -- --check` **净**；
  `cargo doc -p amos-robot --no-deps` **净**。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

- 第 735 行 `!det.is_finite()` 换成恒假 ⇒ **28 passed 全绿**（第 791 行遮蔽它）；
- 第 791 行同一叶换成恒假 ⇒ **28 passed 全绿**（第 735 行遮蔽它）；
- **两处同时**换成恒假 ⇒ **27 passed ／ 1 failed**，红的正是新用例，报告 `Matched { landmark_index: 0 }`。
- 逐字节还原后 `shasum -a 256 crates/amos-robot/src/slam/ekf.rs` =
  `c6451eaac98ccf4fbf755e27610d2e20809ea064ef9b0bb728ebd69de15ad984`，复绿 28。

### 诚实边界

①**只新增测试与一段注释**，生产闸门一行未动（扰动后逐字节还原，sha 如上）；
②**两道闸谁也不单独承重 —— 新用例钉住的是「一对」而非任一份**，这一点是有意如实写下的，
**不做**「已覆盖单叶」的虚假声明；这也正是本条与本族前几例的差别：前面几例的缺陷是「某一叶零执行」，
本条的缺陷是「两处同一拒绝互为遮蔽，以致单叶负控恒绿」；
③`update_landmark` 那道闸在现有调用图上**不可达**，本轮**未**删除它（保留为「不先过闸的调用方」的兜底）；
④**未**在 `observe` 的输入边界加 `variance` 上界（那是另一个决定，本行不碰）；
⑤`cargo fmt --all -- --check` 当下在**其它 crate**（amos-display／amos-link／amos-tauri 等并行轮的在场改动）为红，
与 `amos-robot` 无关，是诚实边界；⑥**未**做真机复核。
⑦并发：落笔前经 `grep` 重探 `REQ-A1021`／`F-SH-338` 四处（`docs/`、`scripts/`、`CHANGELOG.md`）皆零命中；
高水位 `REQ-A1020`／`F-SH-337` 已被并行轮占去，故取 **REQ-A1021 / F-SH-338**。

## 54. 补全（REQ-A1027）：门只朝一个方向看 —— 模块地图从没被问过「磁盘上有没有你漏掉的模块」

`crates/amos-robot/tests/plan_tree.rs` 是守着 `AEROSPACE_PLAN.md` 那张模块树的唯一机械检查。
它取 `AEROSPACE_PLAN.md` 的**首个围栏块**（那张渲染出来的 `crates/amos-robot/src/` 树），
把其中每个 `.rs` 记号拿去 `src/` 下解析，断言**每个名字都存在**。这条断言是对的、也有用，
但它只回答了**一个**方向的问题。

### ① 缺陷

它问的是「树里的名字在磁盘上有没有」，从没问「磁盘上的文件在树里有没有名字」。
这两个不是同一个问题，而只有**第二个**能抓住一次**遗漏**：本 crate *有*、这张图*没有*的模块。
图的头部自己写着它是「the map of what this crate *is*」——审计员若读图而不读目录，
一个不在图上的模块就是**隐形的**，正是该文件头部所记的那句
「a record that disagrees with reality, and nothing fails」，只是落在了原检查看不见的那一方向上。

实测的两个遗漏：

- `src/watchdog.rs` —— **外部**看门狗（REQ-A701 / FMEA `F-SH-161`），一个**独立模块**，
  由 `safety.rs` 自己的文档点名指向（「不先删的那份兜底」正是它的近亲职责），
  并在 `lib.rs` 里有 `mod` 声明；
- `src/lib.rs` —— crate 根本身。

**这两个都不在那张树里。** 更值得写下来的是**删除测试**：把树里 `watchdog.rs` 那一行删掉，
**整套测试逐字节不变、仍然全绿** —— 因为文件本身还在磁盘上，单向的门只查「树里的名字能不能解析」，
根本不看「有没有文件没被命名」。

### ② 为什么是缺陷

本条**没有运行时影响**：树里少一行不改任何行为。它的危害全在**可审计性**——
这与本仓反复出现的 F-DEV-031 是同一个病（记录与现实不符，而没有任何东西失败），
只不过这次落在「地图 vs 目录」这一对上。
`watchdog.rs` 恰恰是「外部看门狗」这一安全机制的唯一实现，
它从地图上消失，等于把安全故事的一整个章节从目录里抹掉 —— 而读目录的人，
和读地图的人，是两拨人。

### ③ 修法

1. **把 `lib.rs` 与 `watchdog.rs` 两行补进 `AEROSPACE_PLAN.md` 的模块树**；
   并把 `safety.rs` 那行的括注从「the R1 watchdog」订正为「the R1 watchdog *check*」——
   **外部**看门狗是另一个模块，混说正是这张图一开始出错的同一个毛病。
2. **在 `plan_tree.rs` 新增反向测试** `every_module_in_src_is_named_by_the_plan_tree`：
   新增 `rs_files_under` 递归收集 `src/` 下全部 `.rs` 的**基名**，与树里记号的基名做
   **集合比对**；`EXEMPT` 白名单**为空**，并在注释里写明
   「若真有例外，必须在此登记并写理由——那才是这条测试存在的意义」。
   比对用**基名**（`driver/can.rs` 与裸 `can.rs` 都算命中）：本测试只问**集合**，
   **不管位置**（位置是原测试头注释里明确划到范围外的东西）。
   同时加两条**防退化下限**：树里记号数 ≥ 15、磁盘上 `.rs` 数 ≥ 15，
   任何一个解析/遍历坏了都要**大声失败**，而不是真空地通过。
3. **把 `## New modules` 段的散文改如实**：声明这条检查现为**双向**（REQ-A682, REQ-A1027），
   并点名 `watchdog.rs` 这个曾经的遗漏（FMEA `F-SH-345`）。

生产代码零字节改动。

### ④ 验证

```
cargo test -p amos-robot
```
⇒ **376 单元 + 50 集成**（集成套较 49 新增 1）全绿；
`cargo fmt --check` / `clippy` / `doc` 对 `amos-robot` 皆**净**。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

| 扰动 | 旧测试 `every_rust_file_the_plan_names_exists` | 新测试 `every_module_in_src_is_named_by_the_plan_tree` |
|---|---|---|
| **NC-A** 删掉树里 `watchdog.rs` 那一行 | **绿**（绿得毫无察觉） | **红**：`src/ holds Rust files the plan's tree does not name: ["watchdog.rs"]` |
| **NC-C** 往树里插一行不存在的 `ghost.rs` | **红**：`["ghost.rs"]` | **绿** |

两向各由一道门守住：**NC-A** 证明「删除」这一方向只有新门看得见，
**NC-C** 证明「幽灵」这一方向由旧门把关。两次扰动之后
`crates/amos-robot/AEROSPACE_PLAN.md` 均**逐字节还原**，
`shasum -a 256` = `1ad6e9379329c44f2cc4d0d77ea3c5509a6e9b5082bcba06aaf2eaa20a27d978`。

### 诚实边界

①本条**只动文档与测试**，生产代码零字节改动（此处本就没有运行时行为可供改）；
②门比的是**基名集合**、**不管位置**（`can.rs` 挂在哪个目录下不管），
位置仍靠人工复核——这本就写在原测试头注释里，本轮**未**改变这一取舍；
③每行紧邻的**散文**是否与那个文件名相符，本测试明确声明**做不到**、仍需人工重读，
故本条**未**声称「地图已与磁盘完全一致」，只声称「两边都没有无名的模块」；
④扰动窗口都很短，落笔前经 `grep` 重探 `REQ-A1027`／`F-SH-345`（`docs/`、`scripts/`、`crates/`、`CHANGELOG.md` 四处）
**零命中**（唯一命中是 `AEROSPACE_PLAN.md`／`plan_tree.rs` 里本轮自己写下的引用），
而当时高水位已被并行轮推到 **REQ-A1028 / F-SH-344**；
⑤**未**做真机复核。

## 55. 补全（REQ-A1057）：三胞胎里只测了第三个 —— `MracController::new` 的两条安全兜底零执行

`crates/amos-robot/src/mrac.rs` 的构造器同一次定型里写了**三个**「不合理即回落」的兄弟。
第三个（`gamma`）有专门用例；前两个（`am`、`bm`）一条也没有 —— 而它们恰好是**安全**的那两个。

### ① 缺陷

第 118／119 行：

```rust
let am = if am.is_finite() && am < 0.0 { am } else { -1.0 };
let bm = if bm.is_finite() && bm > 0.0 { bm } else { 1.0 };
```

文档（第 112-116 行）明写这条兜底：「a non-finite or non-negative `am`（the pole must be
negative）、a non-finite or non-positive `bm` ⇒ 回落到 `am = −1.0`／`bm = 1.0`，
so a caller that passes nonsense gets a **stable** controller rather than a `NaN` one」。

**实测（`RUSTFLAGS=-C instrument-coverage` 逐行覆盖）**：这两行的求值计数为 **0**，
而且是 `mrac.rs` 里**仅有的两行零执行生产代码**。紧邻的兄弟 `gamma` 有专门用例
`a_nonsense_adaptation_gain_falls_back_to_the_default`；而**那条用例的注释（第 485 行）
还替 `am`／`bm` 作了散文断言** ——「the same way a nonsense `am`/`bm` does」。
一句没有任何测试背书的断言，是本条最刺眼的地方：它让这块代码**读起来像是已被覆盖**。

### ② 为什么是缺陷（不是防御性冗余）

`step`（第 176 行）用 `ẋm = am·xm + bm·r` 推进参考模型，**此后再不复查 `am`／`bm`**：

- `am` 为正 ⇒ 一个**不稳定极点**。这正是该模块所引 Lyapunov 证明不覆盖的情形
  （证明要求 `am < 0`，见第 181 行注释）：`xm` 会**发散**而不是衰减。
- `am` 非有限 ⇒ `xm`／`e`／`u` **永久为 `NaN`**。而 `step` 自己的 safe-off（第 161-166 行）
  只检查**实参** `x/r/omega/dt_s`，**从不检查自己的状态** —— 所以这个 `NaN`
  会一路到达控制量 `u`，也就是电机的指令。

删掉兜底后的行为不再是「稳定控制器」而是「发散或 `NaN` 控制器」，与文档承诺相反。

### ③ 修法（仅测试，生产代码零字节改动）

新增 `a_nonsense_reference_model_falls_back_to_the_stable_default`，**两侧都钉**：

1. `am ∈ {NaN, +INF, −INF, 0.0, 2.0}` ⇒ 断言 `mrac.am == −1.0`；
   `bm ∈ {NaN, +INF, −INF, 0.0, −3.0}` ⇒ 断言 `mrac.bm == 1.0`。
2. **反向半边**：一个可用的 `(−2.5, 3.0)` 必须被**保留** ——
   否则上面的断言可能因为「构造器一律拒绝」而假绿。
3. **断言后果而不只是边界**：把 `xm` 置 1.0、以 `dt_s = 0.5, r = 0` 走一步，
   断言 `step.u`／`step.xm` 有限**且** `xm` 的绝对值 < 1（衰减）。
   留 `am = 2.0` 得 `xm = 2.0`（发散）、留 `am = NaN` 得 `NaN`，两者都红。

### ④ 验证

```
cargo test -p amos-robot
```
⇒ **377 单元 + 50 集成**（较 376 新增 1）全绿；
`cargo fmt --check` 净、`clippy --all-targets` **0 告警**。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

| 扰动 | 结果 |
|---|---|
| **NC-A** `am`／`bm` 两处兜底**同时**改为直通 | 新用例**红**（18 passed / 1 failed） |
| **NC-B** 仅 `bm` 改为直通 | **仅**新用例红 |
| **NC-C** 仅 `am` 改为直通 | **仅**新用例红 |

两叶**各自**独立承重 —— 这正是本条与本族前几例的差别：**F-SH-338** 是「同一道拒绝写两遍、
两处互为遮蔽，单叶变异恒绿」，而这里单叶变异就足以判红。
还原后 `mrac.rs` = `0e48ab496722b623426ac889b115f7e6ed5acd0d4b4cb73f8d6003a0511fd7c3`。

### 诚实边界

①**只新增测试**，生产代码一行未动（扰动后逐字节还原，sha 如上）；
②**未**给 `step` 增「复查自身状态」的守卫 —— 那是一个独立决定，本行不碰
（但要写明：`step` 的 safe-off 只看实参、不看状态，这一点本身已在第 ② 节作为**缺陷的放大器**记录下来）；
③**未**对 `MracController` 其余 pub 访问器做同样审查；
④逐行覆盖只取 `--lib` 单测二进制：`cargo test` 的集成二进制在本机被**并行轮**的构建
冲掉了 build-id、无法单独导出，故「零执行」的**下限**是单测证据；
但三组**全量** `cargo test`（含集成）负控已独立证明整仓 426 例都测不到它 ——
也就是说这条结论不依赖那份单测覆盖；
⑤并发：落笔前经 `grep` 重探 `REQ-A1057`／`F-SH-372`（`docs/`、`scripts/`、`crates/`、`CHANGELOG.md` 四处）
**零命中**，而当时高水位已被并行轮推到 **REQ-A1056 / F-SH-371**（`CHANGELOG.md:6`、`docs/FMEA.md:553`）；
⑥**未**做真机复核。

## 56. 补全（REQ-A1059）：同一条网上的第三次审计 —— 判决修了两次，网本身还留着

`crates/amos-robot/src/slam/ekf.rs` 的 `observe` 里有一道最后防线：

```rust
let (lm_x, lm_y) = self.predict_landmark_position(&observation);
if !lm_x.is_finite() || !lm_y.is_finite() {
    return Err(SlamError::Singular);
}
```

这条 `return` 是 `mrac.rs` 之外本轮唯一的两行零执行生产代码之一（`RUSTFLAGS=-C instrument-coverage`
逐行覆盖，求值计数 **0**）。它与 **F-SH-183**（给读数闸补上两个偏移字段的 `is_finite`）
和 **F-SH-269**（补上 `bearing_variance` 的 `is_finite` 那一叶）是**同一条网**：那两轮都
在把「别让畸形输入走到这条网上」往前推，而**网自己的判决**从未被问过。

### ① 缺陷

读数闸（`ekf.rs:517-553`）只检查 `range_m`／`bearing_rad`／两个方差／两个偏移的
**`is_finite()`**，**不限定任何量级** —— 这条边界是 F-SH-183 刻意留下的：多大算「不合理」
取决于机器人尺寸，本 crate 不替调用方定。于是两个**各自有限**的字段可以在
`predict_landmark_position`（`ekf.rs:624`）里相遇并溢出：

```text
sx    = x + off_x·cosθ − off_y·sinθ
lm_x  = sx + range·cos(θ + bearing)
```

`range_m = f32::MAX` 与 `sensor_offset_x_m = f32::MAX`（θ = 0）⇒ `MAX + MAX = +inf`。
实测：`Err(SlamError::Singular)`。换到 y 轴（`bearing = π/2`，`cos π/2 ≈ −4.4e−8` 令
`lm_x` 保持有限、只有 `lm_y` 溢出）⇒ 同样 `Err(Singular)`。两者都是**纯有限输入**，
闸口每一个 `is_finite` 叶都合法通过。

### ② 为什么是缺陷（不是「反正拦住了」）

`SlamError::Singular` 的文档逐字写「The Jacobian hit a singular sub-matrix (e.g. the
landmark lies on the robot)」，Display 写「the innovation Jacobian is singular (a landmark
on top of the robot has no bearing to observe)」—— 这是一条**几何**判决，而此处
**根本还没有形成任何雅可比**。`Singular` 对调用方的含义是「换个位姿再试」，而一个溢出的
读数（或溢出时的内部 `pose`）**永远不会自愈**：按类别分流的调用方会永远重试。

**这一点不是本轮的发明。** 同文件 `ekf.rs:536-540` 的注释早已写死：

> Without these two checks that outcome was caught only by the `lm_x.is_finite()` net
> below and reported as `SlamError::Singular` — a *geometry* verdict ("the landmark lies
> on the robot") for what is a malformed input, which is the one thing this variant's own
> doc says it is not. A caller that treats `Singular` as "bad pose, retry" would retry
> forever.

那段话为**两个偏移字段**把这条路堵死了，却把**同一道网本身**的判决留在了原地；
`range_m`（以及溢出时的内部 `pose`）仍旧走这条路。**代码违反了自己写下的错误契约。**

### ③ 修法（一行生产逻辑 + 两处文档）

1. `ekf.rs:577-580` 的判决 `SlamError::Singular` → `SlamError::BadInput`，并在上方补一段
   注释：写明闸口只查有限性（刻意）、`range_m` 与内部 `pose` 同样能把它撑到 `±inf`、
   以及为何这不是几何判决（此处尚未形成雅可比）。
2. `SlamError::BadInput` 的文档与 `Display` 各扩写一句「or a magnitude that overflowed the
   landmark position」—— 此前它只写「non-finite value or a negative variance」，正是那段旧
   注释所引的「本变体的文档说它不是」的那句话。
3. 新增 `a_finite_reading_that_overflows_the_landmark_position_is_bad_input`：**两叶各钉一次**
   （`bearing = 0` 撑破 `lm_x`；`bearing = π/2` 撑破 `lm_y`），断言 `BadInput` 且地标数为 0；
   再补**反向半边** —— 同一姿态下一个有界的 `lidar(2.0, 0.0)` 必须建出地标 —— 使断言
   不可能因为「构造器一律拒绝」而假绿。

### ④ 验证

```
cargo test -p amos-robot
```

⇒ **378 单元**（较 377 新增 1）+ **50 集成** + 12 doctest 全绿；
`cargo fmt -p amos-robot -- --check` 净、`cargo clippy -p amos-robot --all-targets -- -D warnings` **0 告警**。

### ⑤ 负面控制（判别力，实测，逐字节还原 + `shasum -a 256`）

| 扰动 | 结果 |
|---|---|
| **NC-A** 判决改回 `SlamError::Singular` | 新用例**恰 1 红**（28 passed / 1 failed，落在第一格 `bearing = 0`） |
| **NC-B** 拿掉 `!lm_x.is_finite()` 合取项 | **仅**新用例红 |
| **NC-C** 拿掉 `!lm_y.is_finite()` 合取项 | **仅**新用例红 |

两叶**各自**独立承重（`!a.is_finite() || !b.is_finite()` 是两叶闸，没被测到的那一叶会静默死掉）。
还原后 `crates/amos-robot/src/slam/ekf.rs` = `89581752fa8cea7824a164d59dbf9ae905e2360663a266d653f08459bb94be0c`
（修前 = `c6451eaac98ccf4fbf755e27610d2e20809ea064ef9b0bb728ebd69de15ad984`）。

### 诚实边界

①本轮**改了一行生产逻辑 + 两处文档**，不是纯测试轮；改动面严格限于这一点与注释；
②修的是**错误类别**，不是「非法输入会污染状态」—— 溢出的位置本就被这道网拦住、不写入状态，
本轮让**拒绝的理由**与 `ekf.rs` 自己写下的契约一致；
③**未**给读数加任何**量级**上限（沿用 F-SH-183 的刻意边界）；
④**未**改 `observe` 的零方差政策（`< 0.0` 接受零，与 `McLocalizer::update` 的 `<= 0.0` 不一致，
仍是 §38 的独立议程）；
⑤同一族其余候选已核实并**驳回一项**：`ekf.rs:590` 的 `if !self.landmarks[i].ever_observed { continue; }`
属**冗余而非缺陷** —— `add_landmark`（`ekf.rs:366-369`）在压入前**无条件**把该标志置真，
而 `SlamState::landmarks` 是私有字段、没有任何公开路径能把 `ever_observed == false` 的地标
装进地图，故该 `continue` 不可达；按本仓「记录不可达分支而非制造覆盖」的规矩不予立项。
`ekf.rs:605` 的 match-update 分支同理未主张；
⑥**未做**真机复核；
⑦并发：落笔前经 `grep -rl` 重探 `REQ-A1058`／`F-SH-373`（`docs/`、`scripts/`、`crates/`、`CHANGELOG.md` 四处）
**四处全中**（已被并行轮占用），故取 **REQ-A1059 / F-SH-374**（双向零命中）。

## 57. 补全（REQ-A1065）：兄弟饱和里只测了两个 —— `DriveCommand::from_velocity` 的「顶速非正 ⇒ 零油门」零执行

**一句话**：`from_velocity` 的节流块有三条「机器做不到就说做不到」的饱和/拒斥 —— **倒车**（`v <= 0` ⇒ 全刹车）、
**转向行程**（钳到 `max_steer_milli_deg`）、**顶速非正**（`top_speed_mm_s <= 0` ⇒ 零油门）。前两条各有单测，
**第三条零执行**；而它是唯一阻止「`v / 0 = +inf` 被通用 `clamp` 钉到上限」⇒ **100% 油门**的东西。

### 缺陷（实测）

```rust
let throttle_milli_percent = if geometry.top_speed_mm_s <= 0 {
    0
} else {
    ((v / f64::from(geometry.top_speed_mm_s)) * 100_000.0)
        .round()
        .clamp(0.0, f64::from(BRAKE_FULL_MILLI_PERCENT)) as i32
};
```

把 then 分支拿掉后逐级求值：`v / 0.0 = +inf` ⇒ `inf * 100_000.0 = +inf` ⇒ `.round() = inf` ⇒
`.clamp(0.0, 100_000.0)` 把 `+inf` **钉到上限** ⇒ `as i32` = `MAX_TORQUE_MILLI_PERCENT` = **100% 油门**，且
`brake_milli_percent: 0`。**这台机器自己在几何里说它不动。**

实测（临时探针 `tests/zz_r21_probe.rs`，测完即删）：

```
PROBE zero top speed: throttle=0
PROBE normal:        throttle=50000
```

### 为什么可达 —— 三层都没有别的东西拦它

1. `VehicleGeometry` 是 `pub struct`，`wheelbase_mm` / `top_speed_mm_s` **两个字段都是 `pub`**，**没有校验构造器**。
2. 模块文档（`planning.rs:49`）逐字写：裸构造器 `pursuit` 与 `from_velocity`「**do not run it**: a caller that uses
   those directly owns the check」—— 它们**自己不做 profile 检查**。
3. 唯一生产调用方 `LocalPlanner::command` 在 `from_velocity` 之后调 `command.check_against(platform)?`，但
   **`check_against` 只校验命令本身（关节行程），从不校验 `geometry`**。

于是「顶速填 0」这台机器一路走到 `from_velocity`，能拦住它的只有这道闸 —— 而这道闸一行测试都没有。

### 零覆盖（先于本轮存在）

用私有的插桩 target 目录（`RUSTFLAGS="-C instrument-coverage"` + `LLVM_PROFILE_FILE`，
`CARGO_TARGET_DIR=/tmp/cov21/robot` 以免并发轮次 rebuild 破坏 build-id）跑整套，`llvm-profdata merge -sparse` +
`llvm-cov export` 后**只看每行最低列的那一段**（朴素过滤会把每个 `?` 的错误传播段也算成「未进入」），
再筛掉 `mod tests` 之后的行 —— then 分支的 `0` 求值计数为 **0**。

### 负控（实测，各恰 1 红）

| 负控 | 变异 | 结果 |
| --- | --- | --- |
| NC-A | 删掉 `if ... <= 0 { 0 } else` 的 then 分支（只留 clamp 表达式） | 恰 1 红 = 新测试，打出 `100000` milli-percent（**100% 油门**），整套 378 绿 1 红 |
| NC-B | `top_speed_mm_s <= 0` 改成 `< 0` | 恰 1 红 = 新测试（钉住 `== 0` 这个边界值） |

还原后 `shasum -a 256 crates/amos-robot/src/planning.rs` = `21e4b6ad…`（与扰动前逐字节相同）。

### 修法（只加测试 + 补文档，生产零改动）

新单测 `a_declared_zero_top_speed_commands_no_throttle_not_full_throttle`：

- `top_speed_mm_s ∈ {0, -500}` 且 `v = 500` ⇒ `throttle_milli_percent == 0`（两个方向都覆盖，`0` 钉住 `<=` 的等号）；
- **反向半边**：`top_speed = 1_000, v = 500` ⇒ `50_000`（半个顶速 = 半个油门）；
  `v = 3_000 > top_speed` ⇒ `BRAKE_FULL_MILLI_PERCENT`（越过顶速仍钳到上限）。
  反向半边是必须的 —— 没有它，一条「把所有油门都钳成 0」的错实现也能让这条测试变绿。

`from_velocity` 的文档补第四条拒斥，并写明该字段 `pub` 且无校验构造器 ⇒ 从手写 geometry 的调用方可达。

### 诚实边界

- **生产不变量本身是正确的**：`0` 是安全方向（不加速、不刹车、滑行）。本条是**覆盖率缺口**，不是行为缺陷；
  修法因此是**只加测试 + 补文档**，一行生产逻辑都没改（`from_velocity` 只是文档变长）。
- **未做**：没有给 `VehicleGeometry` 加校验构造器（那是另一个工作项，且会改公开 API —— 但它是这条缺陷的**根**：
  一个「声明顶速 0」的几何本该在构造期就被拒）。
- **未做**：没有改动这道闸的语义（`<= 0` 仍是 `<= 0`）。

## 58. 补全（REQ-A1071）：两份等价的实现里只钉住了一份 —— `planning::wrap_rad` 的 180° 归一化零执行

**一句话**：本 crate 有四个角度包装器 —— `ekf::wrap_angle`、`localization::wrap_angle`、`fusion::wrap_pi`、
`planning::wrap_rad`。前三个各有测试。**第四个没有。** 而它偏偏是唯一一个其边界值直接**决定机器转向方向**的：
`pursuit` 把包好的航向误差的符号直接变成 `steer_milli_deg` 的符号。

### 缺陷（实测）

```rust
fn wrap_rad(angle: f64) -> f64 {
    if !angle.is_finite() { return 0.0; }
    let two_pi = 2.0 * std::f64::consts::PI;
    let wrapped = angle - two_pi * ((angle + std::f64::consts::PI) / two_pi).floor();
    if wrapped <= -std::f64::consts::PI { wrapped + two_pi } else { wrapped }   // ← 零执行
}
```

`wrapped` 落在 `[-π, π)`，那一步把 `-π` 搬到 `+π`，落实文档承诺的 `(-π, π]`。它**不是**数学上的死角：

- `wrap_rad(π)`：`(π+π)/(2π) = 1.0` 精确 ⇒ `floor = 1` ⇒ `wrapped = π − 2π = −π` 逐位精确 ⇒ **分支触发** ⇒ `+π`。
- 而 `π` 正是 `pursuit` 会算出的值：`desired = atan2(target_east − pose.east_mm, target_north − pose.north_mm)`，
  取一条**正南向**航线、让车**恰好压在航线的东向坐标上**（东向差**逐位 `0.0`**），
  则 `atan2(+0.0, 负数) = +π` **精确**，`current = 0`，`error = +π` ⇒ `steer = +max_steer_milli_deg`。

**普通输入，不是 ε；每一步 `f64` 精确，没有容差可放。**

### 实测（临时探针 `tests/zz_r22_probe.rs`，测完即删）

```
PROBE due-south aim: target=Cell { col: 0, row: 3 } steer=40000 throttle=8333
PROBE max_steer=40000
```

### 同族证据（决定性）

`fusion::wrap_pi` 与 `wrap_rad` **逐字节等价**（只有 `f32` 与常量名不同），而它**既有测试又有文档**：

```rust
assert!((wrap_pi(-PI) - PI).abs() < 1e-5, "-π normalises to π");   // wrap_is_half_open_at_minus_pi
```

并且它的注释写明了这一步为什么必须存在：「normalise so the interval is half-open, which is what makes
"wrapped equal" a decidable property for tests and for a UI」。`planning::wrap_rad` 的文档照抄了结论
（「the same convention as fusion's wrapper」）却**没有任何东西在它背后** ——
**一句跨文件的声明不是覆盖。**

### 负控（实测）

| 负控 | 变异 | 结果 |
| --- | --- | --- |
| NC-A | 归一化分支换成 `if false`（then 体保留） | **恰 1 红** = 新测试，实测 `left: -40000 / right: 40000`（**转向反向**）；整套 379 绿 1 红 |
| NC-B | 非有限分支 `return 0.0` → `return angle` | **0 红**（整套 380 全绿）⇒ 该叶确实无测试走过 |

还原后 `shasum -a 256 crates/amos-robot/src/planning.rs` = `8106efd6…`（与扰动前逐字节相同）。

### 修法（只加测试 + 补文档，生产零改动）

新单测 `a_pursuer_facing_away_from_its_aim_point_turns_the_way_its_angle_was_wrapped`：

- **断言后果，不是边界值**：正南航线 + 车压线 + `heading_mrad = 0` ⇒ 航向误差**逐位** `+π` ⇒
  `steer_milli_deg == limits.max_steer_milli_deg`（正向饱和）；
- **反向半边**：同网格的正北航线，同一台车正对瞄点 ⇒ `steer_milli_deg == 0` ——
  没有这半边，一条「永远正向打满舵」的错实现也能让第一句变绿。

`wrap_rad` 的文档补上它缺的两件事（孪生副本两件都写了）：归一化兑现的**是什么性质**、
以及非有限输入返回 `0.0` 是**防御性、公开 API 不可达**。

### 诚实边界

- **生产约定本身是正确的**：`+π` 是 `(-π, π]` 的定义，本条是**覆盖缺口**，不是行为缺陷 ——
  修法因此是**只加测试 + 补文档**，一行生产逻辑都没改。
- **如实驳回**：非有限分支（`return 0.0`）经**公开 API 不可达** —— `desired` 是有限入参的 `atan2`，
  `current` 是 `i32` 除 1000，两者之差必有限。NC-B 实测 **0 红**证实它无测试走过。
  按本 crate 的既有做法（**记录不可达分支，而不是为它造测试**）如实驳回，**不登记为缺陷**。
  注意：`fusion::wrap_pi` 给它的同类分支造了测试（`assert_eq!(wrap_pi(f32::NAN), 0.0)`）——
  两份实现在这一点的做法不同；本轮只**在文档里说明** `planning` 这边为何不造，**不**去改动它。
- **未做**：没有把 `wrap_rad` 与 `fusion::wrap_pi` 合并成一处（跨模块去重是另一个工作项，
  且会把 `planning` 变成 `fusion` 的依赖 —— 方向未必对）。

## 59. 补全（REQ-A1073）：一条判决里的三个叶一次全中 —— `LocalizationHealth` 的「不确定」档零执行

**一句话**：`McLocalizer::estimate()` 末尾那棵三态判决，**三个叶各自零执行**：`Uncertain` 那一档没有任何测试产生过，
`Converged` 的 `sigma_h` 合取项从未决定过任何事，`Diverged` 的 `sigma_p > diverged_radius_m` 析取项也是。
三份单叶负控，**每一份都让整套 430 条测试全绿**。

### 判决体

```rust
let health = if self.match_quality < MATCH_QUALITY_FLOOR
    || sigma_p > self.control.diverged_radius_m          // ← 叶 B：从未决定过
{
    LocalizationHealth::Diverged
} else if sigma_p <= self.control.converged_radius_m
    && sigma_h <= self.control.converged_heading_rad     // ← 叶 A：从未决定过
{
    LocalizationHealth::Converged
} else {
    LocalizationHealth::Uncertain                        // ← 整档：从未被执行
};
```

### 为什么这一档尤其该有仪器

`McControl::diverged_radius_m` 自己的文档写死了它存在的理由：

> // chosen: two metres, an order of magnitude past the convergence radius **so that the band
> // between the two is a real "uncertain" region rather than a knife edge.**

那条被**刻意设计**出来的中间带，没有任何仪器读得到。而 `LocalizationHealth` 是 `pub enum`，
`key()` 的文档是「Stable key for logs and traces」—— 这条判决会落到日志与遥测里，供调用方按档分流。

### 「零执行」的实测（三份负控，各 0 红）

| 负控 | 变异 | 结果 |
| --- | --- | --- |
| NC-1 | `else { Uncertain }` → `else { Converged }` | **0 红**（整套 430 全绿） |
| NC-2 | 去掉 `&& sigma_h <= converged_heading_rad` | **0 红** |
| NC-3 | 去掉 `|| sigma_p > diverged_radius_m` | **0 红** |

### 遮蔽：`Diverged` 的三条既有断言全走同一个叶

`localization.rs:1711`、`localization.rs:1828`、`tests/localization_e2e.rs:252` 三处 `assert_eq!(… Diverged)`，
**每一处都经 `match_quality < MATCH_QUALITY_FLOOR` 这一个叶产生** ——
`a_tiny_weight_cloud_does_not_produce_nan` 甚至直接断言 `est.match_quality == 0.0`。
于是 `Diverged` 的**首要含义**（文档首句：「The belief is **spread past** `diverged_radius_m`」）从无测试走过。
这是本族反复量到的「读了判决，没读机构」：三条绿色断言看起来把 `Diverged` 覆盖了，实际只覆盖了它的一条理由。

### 可达性（实测，公开 API）

临时探针 `tests/zz_r23_probe.rs`（测完即删）在公开 API 上直接构造，五组 `(mq, sp, sh, health)`：

```
uniform seed           (1.0000, 5.4541, 1.7701, diverged)   ← 经展开叶
new_at(σ_m=1.0, σ_θ=.05)(1.0000, 0.9880, 0.0493, uncertain)  ← 位置带
new_at(σ_m=0.1, σ_θ=1.0)(1.0000, 0.0988, 0.9866, uncertain)  ← 航向带
new_at(σ_m=0.1, σ_θ=.05)(1.0000, 0.0988, 0.0493, converged)
new_at(σ_m=3.0, σ_θ=.05)(1.0000, 2.9641, 0.0493, diverged)   ← 经展开叶
```

全部是普通输入：`new_at` 直接设置云的 σ，所以每一例**按构造**落在它的带里，不靠调参让滤波器收敛。

### 修法（只加测试，生产零改动）

新单测 `the_three_health_bands_are_each_decided_by_their_own_leaf`，四例，**每例断言「哪个叶在决定」**：

- ① `new_at(0.1, 0.05)` ⇒ 两个 σ 都在半径内 ⇒ `Converged`（**同时是对照**：证明后面几例不是「什么都报未收敛」而绿）；
- ② `new_at(1.0, 0.05)` ⇒ `sp ∈ (converged_radius_m, diverged_radius_m]` ⇒ `Uncertain`（位置带）；
- ③ `new_at(0.1, 1.0)` ⇒ 位置紧、`sh > converged_heading_rad` ⇒ `Uncertain`（航向带）；
- ④ `new_at(3.0, 0.05)` ⇒ `sp > diverged_radius_m`，**并显式断言 `match_quality >= MATCH_QUALITY_FLOOR`** ⇒ `Diverged`。

第④例那句 `match_quality` 断言是**必须的**：没有它，这一例会经**另一个叶**变绿，
把「展开因从没测过」这条重新藏起来 —— 正是本节开头批评的那种遮蔽。

三份负控各恰 1 红（就是这条新测试，380 绿 1 红），还原 sha `4977b3c0…`。

### 诚实边界

- **分类器本身是正确的**：三个叶写的都对，本条是**覆盖缺口**，不是行为缺陷 —— 修法因此**只加测试**，
  一行生产逻辑都没改。
- **「零执行」的判据是负控，不是覆盖率读数**：本轮没有重建插桩目录（前一 round 的私有目录已删），
  所以「零执行」由**三份 NC 各自 0 红**直接量出 —— 这比覆盖率读数更强，因为它同时排除了「执行到了但没人断言」。
- **未做**：没有给 `key()` 加字符串字面量测试（那会把「哪个叶在决定」的机构测试，换成「`uncertain` 拼写正确」的字面量测试，
  两者不是一回事）；没有改分类器。

## 60. 补全（REQ-A1084）：单格路线的唯一支点 —— `aim_point` 的「一个顶点」提前返回零执行

**一句话**：`aim_point` 里 `if vertices.len() == 1 { return Some(last); }` 是一个顶点表（单格路线）的**唯一**支点：
`plan` 对 `start == goal` 正是返回单格路线，而**这套测试里没有一条把它交给 `pursuit`**。
删掉那两行，`pursuit` 不是算错，是 `vertices[segment + 1]` **越界 panic** —— 而整套 381 条单元测试**全绿**。

### 判决体

```rust
let vertices: Vec<(Cell, f64, f64)> = path.cells().iter()
    .filter_map(|cell| grid.cell_centre(*cell).map(|(n, e)| (*cell, n as f64, e as f64)))
    .collect();
let last = *vertices.last()?;
if vertices.len() == 1 {          // ← 本叶：从未执行
    return Some(last);
}
// …
let mut best = (0usize, 0.0f64, f64::INFINITY);
for index in 0..vertices.len() - 1 {   // 单格路线 ⇒ 0..0，一个线段都不评分
    // …
}
let (segment, t, _) = best;            // ⇒ 种子 (0, 0.0, ∞)
let (_, from_north, from_east) = vertices[segment];       // vertices[0]，安全
let (_, to_north, to_east) = vertices[segment + 1];       // ← 单格路线即 vertices[1] ⇒ panic
```

### 为什么「单格路线」是正常输入

`plan` 对 `start == goal` 有一条捷径：

```rust
if start == goal {
    return Ok(Path { cells: vec![start] });
}
```

而 `endpoints_are_checked_against_the_map` **恰好断言了这条捷径**（`same.len() == 1`、`same.cost() == Some(0)`），
**却从不把它交给 `pursuit`**。`plan` 的产物被单独钉住了，**调用者怎么用它**没有任何仪器 ——
而每个真实调用者（`LocalPlanner::command`、`examples/patrol_loop.rs`、`tests/stack_e2e.rs`）都把结果直送 `pursuit`。

到达判据只在**车在到达半径内**时才短路（`goal_distance <= arrive_radius_mm`），
所以一辆被定位在自己目标之外的车（滑行、轮滑、或一次跳变的定位修正）重规划后仍得单格路线、仍会去开它。

### 「零执行」的实测（负控）

| 负控 | 变异 | 结果 |
| --- | --- | --- |
| NC-A | 删掉 `if vertices.len() == 1 { return Some(last); }` | **381 单元全绿**，仅探针 `panicked at planning.rs:1631:42`（越界索引） |
| NC-B | `return Some(last)` → `return None` | **恰 1 红**（就是新增那条测试，其余 381 绿） |

NC-A 比覆盖率读数更强：它同时排除了「执行到了但没人断言」。
本轮另建了插桩目录（`/tmp/cov24`），修正后的零覆盖扫描（只认**每行最低列**那个 `has_count && is_entry && !is_gap && count == 0` 段）
在 `planning.rs:1602` 抓到该叶 —— 与负控结论一致。

### 可达性（实测，公开 API）

临时探针 `tests/zz_r24_probe.rs`（测完即删），地图 `Grid::from_rows(&["...."; 8], 500)`，路线 `plan(c3, c3)`：

```
route.len() = 1
far    command = DriveCommand { steer_milli_deg: 40000, throttle_milli_percent: 10312, brake_milli_percent: 0, reached_goal: false, target: Cell { col: 3, row: 3 } }
centre command = DriveCommand { steer_milli_deg: 0, throttle_milli_percent: 0, brake_milli_percent: 100000, reached_goal: true, target: Cell { col: 3, row: 3 } }
```

`far` 的位姿在地图原点、目标格心在 `(1750, 1750)` mm —— 普通输入，不是 ε。

### 修法（只加测试与文档，生产零改动）

新单测 `a_one_cell_route_aims_at_its_only_cell_instead_of_indexing_past_it`，**从公开 API 造路线**，
先断言 `route.len() == 1`，再两条支路各钉一半：

- **半径外** ⇒ `target == Cell::new(3, 3)`、`!reached_goal`、`throttle_milli_percent > 0`（还有路要开 ⇒ 油门不是停车）；
- **半径内**（位姿在格心）⇒ `reached_goal` 且 `brake_milli_percent == BRAKE_FULL_MILLI_PERCENT`
  —— 证明单顶点路线**不遮蔽**到达判据。

`aim_point` 的文档补一段，写明单格路线没有可投影的线段、这个提前返回是**承重的而非顺手**。

### 诚实边界

- **`aim_point` 本身是正确的**：这个叶写的对，本条是**覆盖缺口** —— 修法因此只加测试与文档，一行生产逻辑都没改。
- **这一族第一次量到「缺了会崩」**：此前 23 轮量到的都是「缺了会给出错值／错档／错符号」；
  本条把同族结论推进一步 —— 零执行的叶不只会让结论失真，**还能让进程停摆**。
- **未做**：没有把 `== 1` 改成 `<= 1`（`len() == 0` 已被 `vertices.last()?` 挡住，改 `<=` 是等价噪声）；
  没有给这两行加冗语注释（新测试已点名）。
## 61. 补全（REQ-A1089）：一条两叶之或，两叶各由一条没走过的输入走到 —— `ekf::measurement` 的「测不到的地标」守卫零执行

**一句话**：`crates/amos-robot/src/slam/ekf.rs` 的 `measurement()` 用一条两叶之或把「测不到的地标」挡在雅可比之外 ——
`!q.is_finite()` 或 `q <= MIN_RANGE_M`（`1e-6`）。两叶都活着，却**各由一条从未被任何测试走过的输入路径**走到：
把整条守卫换成 `if false { return None; }`，既有 **382 条单元测试全绿**；
而第二次观测会从「被跳过、建副本」变成 `Err(SlamError::Singular)` —— 一个「地标压在机器人身上」的**几何**判决，
落到一个其实只是**测不到**的地标上。

### 判决体

```rust
let dx = lm.x_m - (rx + a);
let dy = lm.y_m - (ry + b);
let q2 = dx * dx + dy * dy;
let q = q2.sqrt();
// `q` is a norm, so the `<=` and the finiteness test together reject a coincident
// or non-finite landmark without a NaN slipping through (`NaN <= x` is `false`).
if !q.is_finite() || q <= MIN_RANGE_M {      // ← 两叶，各由一条没走过的输入走到
    return None;
}
// … 叶① 未过 ⇒ dx / q = 0 / 0 = NaN 进雅可比；叶② 未过 ⇒ innovation = z − q = ±inf
```

### 两叶各由哪条输入走到（实测，公开 API）

| 叶 | 条件 | 输入 | 为什么只有这一叶能抓 |
| --- | --- | --- | --- |
| ① 有限性 | `!q.is_finite()` | `SlamObservation::lidar(1.0e30, 0.0)` | `q² = dx² + dy²` 溢出 f32 ⇒ `q == +inf`；`inf <= 1e-6` 为假 ⇒ 叶②抓不到 |
| ② 重合 | `q <= MIN_RANGE_M` | `SlamObservation::lidar(0.0, 0.3)` | 地标正落在传感器原点 ⇒ `q == 0`；`!0.0.is_finite()` 为假 ⇒ 叶①抓不到 |

两者都从公开 API 可达：`observe` 的边界**只校验有限性**（`range_m = 0` 被接受），
于是 `predict_landmark_position` 加 `add_landmark` 把地标恰好建在传感器原点（`q == 0`）；
而 `range_m` **没有任何上界**，一个**有限但巨大**的读数把地标建到 `q²` 溢出处（`q == +inf`）。

### 为什么「全绿」

既有用例（如 `a_second_observation_of_the_same_point_matches_the_first_landmark`）的第二次观测
一律用普通距离（2.0、3.0 m），两条退化路径没有一条走完过 —— 守卫的**两叶都零执行**。

### 「零执行」的实测（负控）

| 负控 | 变异 | 结果 |
| --- | --- | --- |
| NC-A' | 整条守卫 → `if false { return None; }` | **382 单元全绿**（守卫零执行），探针第二次观测 `Err(Singular)` |
| NC-A | 整条守卫删除 | 恰 1 红（新测试，停在叶①那一句） |
| NC-B | 只留 `q <= MIN_RANGE_M`（删 `!q.is_finite()`） | 恰 1 红（新测试，停在叶②，`ekf.rs:1770`） |
| NC-C | 只留 `!q.is_finite()`（删 `q <= MIN_RANGE_M`） | 恰 1 红（新测试，停在叶①，`ekf.rs:1752`） |

NC-A ∕ NC-B ∕ NC-C 各只红它那一叶 ⇒ 两叶都**活**、且各由**互不相同**的输入走到。
每组都 `cp` 到 /tmp/r25 后 `shasum -a 256` 逐字节还原，绝不用 `git checkout --`。

### 可达性（公开 API，临时探针 `tests/zz_r25_probe.rs`，测完即删）

```
a1 = Created { landmark_index: 0 }
a2 = Created { landmark_index: 1 }     ← 重合地标被跳过，不是 Err(Singular)
a landmarks = 2
  a lm[0] x=0 y=0 cov0=1
  a lm[1] x=0 y=0 cov0=1
b1 = Created { landmark_index: 0 }
b2 = Created { landmark_index: 1 }     ← q² 溢出的地标同理
b landmarks = 2
```

### 修法（只加测试与文档，生产零改动）

新单测 `a_landmark_the_robot_cannot_measure_is_skipped_not_a_singular_innovation`，**从公开 API 造输入**：
两叶各钉一条支路（`lidar(0.0, 0.3)` 与 `lidar(1.0e30, 0.0)` 各观测两次，都必须回 `Created` 而非 `Err`、地标数 2），
末尾加**正控制**（`lidar(2.0, 0.3)` 两次得 `Matched{0}`、地标数 1，排除「任何第二次观测都建副本」的假绿）。
`measurement` 的文档从「与传感器原点重合」扩写为「测不到（重合**或** `q²` 溢出致 `q` 非有限）」并点名新测试。

### 诚实边界

- **守卫本身是正确的**：两叶写的都对，本条是**覆盖缺口** —— 修法因此只加测试与文档，一行生产逻辑都没改。
- **不可与「冗余叶」混同**：叶① 与叶② 各由**不同**输入走到（上表 + NC-B ∕ NC-C），不是「一个更宽的条件可以替掉另一个」；
  本仓把**真冗余**的叶如实记成「不可达、不测」，本条不属于那一类。
- **本轮仪器的一处误报，如实记下**：曾用插桩覆盖率（`RUSTFLAGS="-C instrument-coverage"`）定位零执行，
  修正后的扫描器（只认每行**最低列**那个 `has_count && is_entry && !is_gap && count == 0` 段）在
  `localization.rs:625-630` 上**误报** —— 既有测试 `a_tiny_weight_cloud_does_not_produce_nan` 必然执行第 629 行。
  故本轮的「零执行」裁决一律以**负控**为准（更强：同时排除「执行到了但没人断言」）。
- **未做**：没给 `MIN_RANGE_M` 值本身加「与 `observe` 的零上界不一致」的注释（那是另一条约定）；没把 `1e-6` 调大或调小。

## 第六十二节（REQ-A1093 ∕ F-SH-407）：DWA 的进度项 —— 「已经站在目标点上」那一叶是零执行的

### 位置

`crates/amos-robot/src/planning.rs`，`pub fn dwa(…)` 的计分循环内：

```rust
let start_dx = pose.north_mm.saturating_sub(goal_north) as f64;
let start_dy = pose.east_mm.saturating_sub(goal_east) as f64;
let start_dist = (start_dx * start_dx + start_dy * start_dy).sqrt();
let end_dist = (prog_dx * prog_dx + prog_dy * prog_dy).sqrt();
let progress = if start_dist > 0.0 {
    ((start_dist - end_dist) / start_dist).clamp(0.0, 1.0)
} else {
    1.0
};
```

### 为什么 else 那一叶是活的

进度被归一化成 `[0,1]`，分母是**位姿到目标格中心**的距离 `start_dist`。位姿恰好落在目标格中心时 `start_dist == 0`，
除法无法归一化，`else` 直接答 `1.0` —— 「已经站在目标上」就是 100% 进度，这个语义是对的。

`pose = grid.cell_centre(goal)` 是调用者「给我**脚下这一格**的 DWA 分数」最自然的写法，所以这一叶由**公开 API** 走到，
不是防御性代码。`Grid::cell_centre` 是公开方法，`dwa` 又把 `pose` 当参数收，二者拼起来就是 else。

### 为什么删掉它全绿 —— 覆盖缺口

套件里**每一个** DWA 用例都把位姿放在离目标有距离的地方：共用的 `dwa_pose()` 落在**格角**上（`start_dist > 0`），
`the_clearance_term_moves_the_score_rather_than_only_the_safe_gate` 的目标在整格之外。
于是删掉整个 `else`（`let progress = ((start_dist - end_dist) / start_dist).clamp(0.0, 1.0);`）后，
`planning::` 的 64 例**全绿** —— 该叶此前**零执行**。

### 删除之后错在哪里

1. `(0.0 - end_dist) / 0.0` 是 `-inf`（`end_dist > 0` 时），`clamp(0.0, 1.0)` 把它压成 `0.0`。
   于是「**已到目标**」被判成「**零进度**」，各候选的 `value` 一律**少**一整份 `DWA_W_PROGRESS`（1.0）。
   公开字段 `DwaScore::value` 的文档是「The composed score, dimensionless. Higher is better.」，读分数的人据此判断
   「没在往目标走」。392 组扫描（4 布局 × 全部格 × {格中心，偏 1 毫米}）里有 **168 组**各少 1.0，
   例：`open/3,3` 处 `1.1075 → 0.1075`。
2. 停机候选的 `0.0 / 0.0` 是 `NaN`。选速是
   `if safe && best.map_or(true, |b| candidate.value > b.value) { best = Some(candidate) }` —— `NaN > x` 与 `x > NaN`
   恒假，所以若一个 `NaN` 值的 `safe` 候选**先**被取为 `best`，后续任何候选都换不掉它，**选速就此冻结**。

### 为什么这仍是「缺陷」而不是「真冗余叶」

本仓把**真冗余**的叶如实记成「不可达、不测」（见 `SLOW_RADIUS` ∕ `length_sq` 两个被如实排除的同轮候选）。
本条不属于那一类：删掉 else **会改变**公开且被文档定义过的 `value`（168/392 组，各 1.0），并引入 `NaN` 冻结点 ——
可观测、可断言，所以它是一条**上报分数的正确性缺口**，而不是一个可以被更宽条件替掉的叶。

### 诚实边界

- **在生产逻辑上，这是上报分数缺陷、不是控制缺陷**。该分支给**每一个**候选加的是**同一个** `progress`（`start_dist == 0` ⇒
  所有候选都走 else ⇒ 都是 `1.0`），常量偏移**不可能**改变 argmax。探针在 392 组配置里测得
  `v` ∕ `ω` ∕ `safe` ∕ `clearance_mm` 的差异为 **0**。测试本身把这条边界写成断言（`on.velocity == off.velocity` 等），
  而不是只写在文档里。
- **生产逻辑一行未改** —— `if start_dist > 0.0 { … } else { 1.0 }` 本身是对的；修法是补测试 + 补注释。
- **两个负控**：NC-A 删整个 else ⇒ 恰 1 红、其余 383 单元全绿（证明零执行）；NC-B 只把边界改成 `start_dist > 1.0`
  ⇒ 恰 1 红（证明用例钉的是「哪些位姿走这一叶」的边界，不只是叶的存在）。
  逐字节还原一律 `cp` 到 /tmp 后 `shasum -a 256` 比对，**绝不用 `git checkout --`**。
- **未做**：没有改动 `DWA_W_PROGRESS` 的取值，也没有把 `progress` 改成饱和减（`saturating`）形式 —— 那是另一条约定。

## 第六十三节（REQ-A1112 ∕ F-SH-426）：DWA 的 `BadLimits` 六叶守卫 —— 五叶零执行，而它们的丢失不是「只少拒绝一次」

### 位置

`crates/amos-robot/src/planning.rs`，`dwa` 的第一个守卫：

```rust
if limits.max_v_mm_s <= 0
    || limits.max_v_reverse_mm_s <= 0
    || limits.max_omega_mrad_s <= 0
    || limits.max_accel_mm_s2 <= 0
    || limits.max_alpha_mrad_s2 <= 0
    // `cell_mm` is the divisor of the clearance normalisation; a zero would make it
    // `inf`/`NaN` and poison every score comparison.
    || limits.cell_mm == 0
{
    return Err(DwaError::BadLimits);
}
```

### 覆盖缺口

六叶里只有 `cell_mm == 0` 有测试（`dwa_refuses_a_zero_cell_mm`）—— 它有一条专门的注释说明「它是个除数」。
另外五个字段从未被任何测试置为被拒之值。写入点普查（`git grep` 全部相关字段的赋值）：
`DwaLimits::for_ground_vehicle`、本模块测试里的两处字面量 `DwaLimits { … }`、`examples/patrol_loop.rs`、`tests/stack_e2e.rs` ——
**无一处写零或负值**。于是五叶零执行：去掉任意一叶，改前的 384 例单元测试全绿。

### 为什么这不是「只少拒绝一次」

逐叶删除后跑一个「把该字段置零」的探针（`pose` 在 (3000, 3000)、`goal = Cell::new(3, 6)`、7×7 开敞场，基线为 `Ok(v = 25, ω = 55)`）：

| 被删的叶 | 探针结果（该字段置零） | 与基线的差 |
|---|---|---|
| `max_v_mm_s <= 0` | `Ok(v = −25, ω = −100, safe = true, val = 0.4)` | **命令反向** |
| `max_accel_mm_s2 <= 0` | `Ok(v = 0, ω = −100, safe = true, val = 0.1)` | **命令不同**（塌成当前速度） |
| `max_omega_mrad_s <= 0` | `Ok(v = 25, ω = 0, safe = true, val = 0.1145)` | **ω 不同** |
| `max_alpha_mrad_s2 <= 0` | `Ok(v = 25, ω = 0, safe = true, val = 0.1145)` | **ω 不同** |
| `max_v_reverse_mm_s <= 0` | `Ok(v = 25, ω = 55, …)`（与基线逐字段相同） | **惰性** |

`max_v_mm_s <= 0` 的机制最值得记住：动态窗口的上界是 `(v_now + a·dt).min(max_v)`。
`max_v = 0` 时上界塌到 `0`，可达集只剩 `[−a·dt, 0]` —— 一台「最高前进速度为零」的车，窗口里**只有倒车**，
于是 `dwa` 交出 `safe: true` 的倒车命令。同时清度归一化 `speed_norm = (v.abs() ∕ max_v).clamp(0.0, 1.0)`
在 `max_v = 0` 时对任意 `v ≠ 0` 都是 `abs(v) ∕ 0 = inf`，clamp 后为 `1.0` —— 「最高前进速度为零」反而被读成**最快**的车。
这正是本仓已有的「故障被报成全清」形态（同一个函数下方对越界 `velocity` 正因此才拒绝）。

`max_v_reverse_mm_s = 0` 是**惰性叶**，如实记下：它留下的「只许前进」窗口本身合法（`v_lo_reach = max(v_now − a·dt, −0.0)`），
而反向 `velocity` 会被下游的 `VelocityOutOfRange` 拦下。这一叶的删除在该构型下不产生可观测差异 —— 它属于「策略性拒绝」而非「膨胀」。

### 诚实边界

- **生产逻辑一行未改**：六叶守卫本身是对的，修法是补测试 + 在 `DwaError::BadLimits` 的文档上点名该测试。
- **输入是调用者提供的**：`DwaLimits` 的字段是 `pub`、结构体是 `pub`、`dwa` 是 `pub`，所以这是一条公开可达的输入路径；
  但「传一组零上限」本身是调用者的错误，所以本条是**输入校验与安全上报**缺陷，不是运行期自发的控制失效。
- **逐叶负控**：五叶各删一次，每次恰 1 红（新用例）、其余 384 单元全绿。
- **「改前零执行」的可执行证明**：删 `max_v_mm_s <= 0` 并给新用例加 `#[ignore]` ⇒ 384 passed ∕ 0 failed ∕ 1 ignored。
- **本轮仪器的一处结构性盲区**（重要，面向后续轮次）：插桩覆盖率扫描器**看不见这一类缺陷**。
  对短路「A 或 B」链，只要前面的操作数为假，`B` 的区域就会被**进入**，其 `count` 非零；
  所以「零执行」这一判据只能测出「从未被求值」，测不出「**求值过但从未取真**」。
  并且它在**干净重建**下可复现地把 `mrac.rs` 的 18 行（123 ∕ 141–146 ∕ 167–169 ∕ 220–225 ∕ 297 ∕ 319 ∕ 338–342）报成零执行，
  而独立普查证明那是误报（`mrac.rs:491` 的 `new(-1.0, 1.0, bad).gamma` 必然执行 123 行；422–480 行调用 `with_theta_bound`）。
  因此本轮改用**写入点普查 + 逐叶负控** —— 两者都独立可执行，且后者能同时排除「执行到了但从未取真」。
- **未做**：没改任何上限的取值，也没给 `DwaLimits` 加构造函数校验（那是另一个设计选择）。

## 64. 兰氏距的行列式守卫：两叶，套件两叶都没真正钉住（REQ-A1116 ∕ F-SH-429）

`crates/amos-robot/src/slam/landmarks.rs` 的 `Landmark::mahalanobis_squared` 是 SLAM
数据关联门的度量：`associate` 拿 `sq <= CHI2_2DOF_95` 判定「这枚观测是不是这枚 landmark」。
它的第一道守卫是两叶的：

```rust
let det = self.cov[0] * self.cov[3] - self.cov[1] * self.cov[2];
if det <= 0.0 || !det.is_finite() {
    return f32::INFINITY;
}
```

**两叶都不被套件真正钉住**，且各自独占一个输入类，各自的失效后果都是「把一次响亮拒绝换成
一次静默的错答案」。

### 叶甲 `!det.is_finite()`：从未被求值

`Landmark::new(x, y, σ)` 存的是 `cov = diag(σ², σ²)`，所以 `det = σ⁴`。取 `σ = 4.3e9`：
`σ⁴ ≈ 3.42e38` 溢出 `f32::MAX`，而两个协方差元素 `σ² ≈ 1.85e19` **仍是有限值** —— 这正是
叶甲独占的输入类。（元素本身为无穷是另一类：`σ = 1.0e20` 令 `σ²` 自身溢出，`inf ∕ inf = NaN`
被下游的二次型叶 `!sq.is_finite()` 接住，实测仍返回 `INFINITY`。）

去掉叶甲后 `Σ⁻¹ = (1 ∕ INFINITY) · [[σ²,0],[0,σ²]]` 每一项都下溢成 `0`，二次型塌成恰 `0.0`。
实测：`σ = 1.0e19` 的答案由 `INFINITY` 变成 `0.0` —— 「距离为零」即**完美匹配**，
`d2 <= χ²` 放行每一次观测。

证据：在一棵**尚未加入新用例**的树上删掉叶甲，385 例单元测试加整套集成测试**全绿（0 红）**。

### 叶乙 `det <= 0.0`：被顺带覆盖，但没被真正钉住

既有用例 `a_singular_covariance_does_not_panic` 用 `cov = [0;4]`，`det` 恰为 `0.0`，
叶乙**确实取真** —— 但该用例分辨不出：把叶乙换成 `det <= f32::NEG_INFINITY` 后，同一输入
落到 `inv = 0 ∕ 0 = NaN`，被二次型叶拦住，`landmarks` 的 12 例仍全绿。

叶乙独占的是**反射**协方差（`det < 0`），例如 `cov = [1,0,0,−1]`（`det = −1`），
`Landmark` 的 `cov` 字段是 `pub`，自组 2×2 块的调用者可以直接写出。文档也点名了
「reflected」这一类。去掉叶乙后 `Σ⁻¹ = (1 ∕ −1)·[[−1,0],[0,1]] = [[1,0],[0,−1]]`，
于是 `sq = dx² − dy²` 是一个**小**数。实测：`sq(1,0) = 1.0`、`sq(2,0) = 4.0`，均低于
`CHI2_2DOF_95` 门。（`sq(0,1) = −1 < 0` 仍被 `sq < 0.0` 叶拦住 —— 两叶都活，各管不同的轴。）

### 修法与负控

**生产逻辑不动** —— 两叶本身写得都对。补两条逐叶用例：
`an_overflowing_determinant_is_refused_not_read_as_a_perfect_match`（`σ ∈ {4.3e9, 5e9,
1e10, 1e15, 1e19}`；断言元素有限、`det` 非有限、三种查询下两个方法都 `INFINITY`；并配
`σ = 4.0e9` 的对照 —— `det` 有限即不被拒，证明守的是**溢出**不是**量级**）与
`a_reflected_covariance_is_refused_not_read_as_a_small_distance`（`cov = [1,0,0,−1]` 三个
x 轴查询均 `INFINITY`；`−I` 由二次型叶接住）。并在 `mahalanobis` 的文档注释上点名这一输入类。

逐叶负控（各一次，互不干扰）：删 `!det.is_finite()` ⇒ 恰 1 红、386 全绿；把 `det <= 0.0`
换成 `det <= f32::NEG_INFINITY` ⇒ 恰 1 红、386 全绿；中性化 `!sq.is_finite()` 或 `sq < 0.0`
⇒ 各 2 红（既有用例）。全套 **437 passed**（387 单元 + 38 集成 + 12 doctest，原 435）。

**未做**：没改 `mahalanobis_squared` 的任何运算，没改 `data_assoc` 的门，也没给 `Landmark::new`
加 σ 的上界校验（那是另一个设计选择 —— 本守卫的策略是「拒绝得响亮」而不是「拒绝得早」）。

## 65. 批次中途死掉的总线：既不闩锁也不上报，下一条运动照样写进去（REQ-A1139 ∕ F-SH-446）

安全核 `RobotBridge::step` 在写批次的路径上用 `?` 短路：

```rust
// 旧形状（`step_inner` 内）
let applied = self.hal.apply(&frames).await?;   // ← 总线在这里失败，错误直接穿出
```

而 `report()` 当时只在 `Ok` 路径上被走到。于是**一次批次中途的总线故障**同时触发了三件事，
每一件都是航空航天意义上的不可验证项：

1. **闩锁没置**：`estop_latched` 仍是 `false`，桥愿意接受下一条运动；
2. **回程没报**：`amos/<robot>/state/actuation` 保持故障前的 `armed: true` + 旧步态；
3. **下一条运动照样进总线**：那条「刚证明自己不执行帧」的总线又收到一批部分写入。

这不是纸面推论，是一条**真**代码路径：`StreamRobotHal::apply` 自己就写着「a driver failure
mid-batch is reported with the frames that did get out」（`robot_hal.rs:1337`），循环里
`write_all(...).map_err(...)?` 在第 N 帧上原地返回 `Err`，**前 N−1 帧的字节已经出去了**，
`armed_after` 也已经把那几帧的 `Enable` 记成了 `armed=true`。半批帧进了驱动器、半批没有 ——
机器人停在混合位姿，而大脑读到的是「一切正常」。

### 为什么全绿（③）

套件里唯一的 HAL 是 `MockRobotHal`，它的 `apply` **不可能失败**（整批校验后一律 `Ok`）。
没有测试能产生一次传输错误，所以这条路径上的三个后果没有任何一条被钉住。这是「负控必须真的
能变红」而不是「多写几条断言」的又一处：**不可失败的替身让失败路径不可见**。

### 修法（④）

- 权威侧新增 `EstopReason::BusFault`（`key()` = `"bus-fault"`，`from_key` 往返），并加
  `EstopReason::ALL` —— 此前词表在本仓有两份**手抄**副本（`robot_hal.rs` 的往返测试、
  `crates/amos-tauri/src/link.rs` 的桥接受测试），加一个变体会让两份**同时保持绿**而各自的
  断言（「`key()` 实际返回的 token」）悄悄变弱；两份现在都迭代 `ALL`。
- 新增三条私有方法：`command_halt`（剖面走 `halt_frames()`、参考机走 `hal.estop()`）、
  `on_bus_fault`（写停机批次 → 置闩锁 → 置原因，**切扭矩写不进去时计数为 `0`**）、
  `apply_or_latch`（`apply` 失败即走上者）；`arm` 与 `motion` 两条写入路径都改用它。
- `step` 改成「无论 `Ok`/`Err` 都先 `report()` 再返回结果」——`on_bus_fault` 改变了模式，
  而**一个没离开进程的模式变更，就是回程在断言一件桥自己知道为假的事**。
- 看门狗那条路**先**置闩锁与原因、**再**写停机批次：一次写不出去的切扭矩不能留下一个
  仍然愿意接受运动的桥。

### 负控（⑤，三次，互不干扰）

在**未加入新用例之外**的树上逐次扰动，各自实测：

| 扰动 | 红点 |
|---|---|
| 把 `apply_or_latch(&frames)` 换回 `hal.apply(&frames)`（旧 `?` 形状） | 恰 2 红，都在闩锁断言（`estopped` / `estop_reason == BusFault`） |
| `step` 改回只在 `Ok` 路径 `report()` | 恰 2 红，都在回程断言的 `expect("a fault report follows the failed step")` |
| 关掉闩锁对运动的拒绝（`if false && self.estop_latched …`） | 1 条新用例红（`BridgeEvent::Refused` 断言）+ 2 条**既有**用例红（`the_return_path_reports_mode_changes_not_every_command`、`the_watchdog_stops_a_robot_whose_link_went_quiet`）——闩锁守卫本来就被既有套件钉着 |

扰动后一律 `cp` 回快照并用 `shasum -a 256` 核对逐字节一致（`9539ae68…`），**未用**
`git checkout --` / `git restore`。新增的两条用例是
`a_bus_fault_mid_batch_latches_and_reaches_the_return_path`（夹具 `FaultyHal::glitching(1, 4)`：
第 0 批 arm 通过、第 1 批 trot 在第 4 帧死、第 2 批 re-arm 通过）与
`a_fault_whose_cut_cannot_be_written_still_latches_and_still_reports`（
`FaultyHal::gone_after(4)`：总线从第一帧起就是死的，连切扭矩都写不进去）。后者的断言是**实测**
出来的：前 4 帧里有 `Enable`，所以 `armed` 停在 `true` —— 一次**没能写出去**的切扭矩不是
「扭矩被切了」，回程必须照总线自己的答案报，而不是照桥的意图报。

### 如实边界（✅）

- **参考机的自由函数 `execute()` 未改**：它也调 `hal.apply(&frames)?`，但它没有桥状态可以闩锁
  （无 `estop_latched`、无回程），照抄一份闩锁只会造出第二份状态机；它留在原处是**刻意的**。
- **上报走 `state` 通道（最新值胜）**：`Err` 路径上先发的这条故障报告，可能被紧接着的一次
  成功上报顶掉 —— 这是 `state` 通道的既定语义（「当前模式」而非命令历史），不是本轮的缺口。
- **没有真机器人复核**：驱动器级的总线中断（拔线、断电）没有被这套代码命令过；本轮的证据是
  `StreamRobotHal` 的真实字节路径 + 一个**能失败**的测试替身，不是一次硬件故障注入。
- **`frames` 计数是「总线收下的帧数」**：切扭矩写不进去时它是 `0`，`armed` 仍可能是 `true` ——
  三个字段各自是各自的测量，UI 侧不得把 `estopped` 与 `frames == 0` 当成同一件事。

## 66. 粒子云权重归一化守卫的两叶：一叶活而无人走，一叶可证明不可达（REQ-A1142 ∕ F-SH-448）

`McLocalizer::update` 在把每颗粒子的对数权重归一之前有一道守卫：

```rust
if !total.is_finite() || total <= 0.0 {
    let n = self.particles.len();
    for p in &mut self.particles { p.weight = 1.0 / n as f32; }
    self.match_quality = 0.0;
    self.effective_particles = n as f32;
} else {
    // …按 total 归一…
}
```

两叶，套件对它俩的处置不同。

### ① 活叶：`!total.is_finite()`（可达、载荷、零执行）

`best_landmark_nees` 在 `f32` 里平方 `range_m − predicted_range`，而 `range_m` 只被检查
**有限性**（`update` 的边界校验里没有上界）。于是一条 `range_m = 1.0e30` 的读数令 `dr²`
溢出成 `+inf` ⇒ `nees = +inf` ⇒ 每个 `lw = −inf` ⇒ `max_log = −inf` ⇒ 归一相减时
`lw − max_log = −inf − (−inf) = NaN` ⇒ `total = Σ exp(NaN) = NaN`。这正是第一叶要拦的形状。

把它删掉：`inv = 1.0 ∕ NaN`，每颗权重乘成 `NaN`，`sum_sq = NaN`，`effective_particles` 掉到
`0.0`，于是 `0.0 < ess_ratio · n` 成立，代码**对一串权重全为 `NaN` 的云做重采样** ——
`while u > NaN` 永不成立，`i` 停在 `0`，每颗输出粒子都是 `src[0]` 的副本加抖动。
注释承诺的恢复（「Keep the cloud uniform」）不复存在，信念塌到**一个任意假设**上。

### ② 为什么这一点在全绿下不可见

`effective_particles` 两种情况都读 `n`（重采样会把它重置），`match_quality` 两种情况都是
`0.0` —— 只有**位置散布**是可观察量。实测：有叶 `sigma = 0.494`，无叶 `0.051`。

### ③ 死叶：`total <= 0.0`（可证明不可达，如实拒绝）

指数是相对 `max_log` 取的，所以**最大那一项恒为 `exp(0) = 1`**，有限时 `total` 至少是 `1.0`
（至多是 `n`）；而 `total` 不有限时它是 `NaN`，`NaN <= 0.0` 为假。实测：把该叶换成 `false`，
任何 `range_m` 下结局都不变（守卫仍由第一叶触发）。**不制造用例、只写进注释。**

### ④ 为什么全绿

既有 `a_tiny_weight_cloud_does_not_produce_nan` 走的是 **else** 分支 —— 它的地图在 `1e6 m`
外，`dr² ≈ 1e12` 远在 `f32` 之内，`total` 有限，只是权重下溢；守卫自己那条分支需要**指数**
非有限，而没有任何用例把读数推到 `1e19` 以上。

### ⑤ 修法（生产逻辑不动）

一行生产逻辑都没改 —— 两叶本身写得对。只补上缺失的测试、把不可达那一叶的原因写进守卫上方的
代码注释、并把测试名写进注释。

- 新增 `an_all_infinite_nees_reading_keeps_the_cloud_uniform_instead_of_collapsing_it`：
  断言更新前后 `position_sigma_m()` 都 `> 0.4`、每颗权重有限且恰为 `1 ∕ n`、
  `match_quality == 0.0`、`health == Diverged`；并配一条 **else 分支对照**（把地图解释得住的
  读数喂进去，云应当塌到 `< 0.2`），证明守卫管的是「没有假设解释得通」这一情形，不是「云会塌」。
- 守卫上行内写明：第一叶是活的并点名测试，第二叶是可证明不可达的、保留原因已实测。

### 仪器：整仓批扫（不是逐点猜测）

这一轮没有靠猜。写了一个批处理脚本，对 `amos-robot` 全部 **14 条单行 `A 或 B` 守卫的 31 个析取叶**
逐个删叶跑 `cargo test -p amos-robot --lib`，一次性列出所有「0 红」的叶，再从结果里挑出本行。
同一轮扫描也如实排除了若干**已有文档依据**的成对冗余叶（如 `slam/ekf.rs` 的 `!det.is_finite()`
与其下游 `update_landmark` 的同形守卫，文档已写明「一句测试只能见证这一对」），并把
`vision/five_point.rs:214` 的两叶如实记为下一页候选、不在本轮窗口内。

### 负控（实测；`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原）

| 扰动 | 红点 |
|---|---|
| 删 `!total.is_finite()` ⇒ | 恰 **1 红**（本用例）、387 全绿（`sigma_after` 由 `0.494` 掉到 `0.051`） |
| 删 `total <= 0.0` ⇒ | **0 红**（388 全绿），即该叶惰性，如实记为可达性为零而不记为缺陷 |

**「改前零执行」的可执行证明**：在**未加本用例**的树上（387 例）删掉活叶 ⇒
**387 passed ∕ 0 failed**。全套 **438 passed**（388 单元 + 38 集成 + 12 doctest，原 437），
`cargo fmt --check` ∕ `clippy --all-targets` 均 0 警告。

### 如实边界（✅）

- **只加一条测试 + 一段行内注释**，未动 `estimate` ∕ `resample` ∕ `predict`，未改 Rust ∕ proto ∕ 事件流。
- **死叶保留**：`total <= 0.0` 可证明不可达，但**保留原因已写进行内注释**（指数相对 `max_log` 取）
  并**实测**过，不是靠纸面推导就删。
- **`range_m` 无上界是既有设计**：本轮只钉住守卫在该输入下的行为是恢复而非塌缩，**没有**给
  `range_m` 加上界 —— 上界属于传感器融合边界的另一项工作，不在本行窗口内。
- **`vision/five_point.rs:214` 的两叶（`!s[0].is_finite()` 与 `s[0] <= 0.0`）零执行**：同轮扫描
  发现，如实记为下一轮候选。

## 67. 一叶执行次数最多，却无人钉住：它只在 `min_score = 0` 下独自承担语义（REQ-A1205 ∕ F-SH-492）

`vision/fast.rs` 的 `FastDetector::detect` 在评分循环里有一道接受守卫：

```rust
if best == 0 || best < config.min_score as i32 {
    continue;
}
```

### ① 第一叶每调用都在执行 —— 却没有任何用例钉住它

`best == 0` 的语义是**「没有 9 连续弧」**：四基数快测（`bright >= 2 或 dark >= 2`）放行了这个像素，
但 16 环上不存在 9 个连续超过阈值的像素，于是 `best` 保持 0。几乎每次调用都会命中它。

可它**没有一条用例钉得住**：其余用例的 `min_score` 全 ≥ 30
（`a_corner_scoring_exactly_the_min_score_is_kept` 用 100 ∕ 101，`min_score_filters_weak_responses` 用 200 ∕ 30），
而这些取值下 `best == 0` 蕴含 `best < min_score` —— 第二叶会把同一个像素拒掉。
**删掉第一叶，在全部既有配置下行为中性。**

### ② 它在哪里独自承担语义

`FastConfig::min_score` 是 `pub u8`，**`0` 是合法取值**（文档说它「过滤弱响应」，设 0 即「不过滤」）。
那里 `best < 0` 恒假，第一叶是**唯一**的拒绝。

### ③ 删掉它会发生什么

`scores[idx] = best` 被写成 `0`。评分缓冲的哨兵是 `-1`，抑制通路写的是 `if center < 0 { continue; }` ——
`0 < 0` 为假，于是一个**没有任何 9 连续弧**的像素被当作候选分数参与 3×3 胜者通吃，
并最终以 `score = 0` 的角点发出。非抑制通路的 `*score >= config.min_score as i32` 同样让 `0 >= 0` 通过。

### ④ 实测

16×16 图上只在 `(8,5)` 与 `(8,11)` 置 255：中心 `(8,8)` 的四基数快测通过（环位置 0 与 8 是亮的），
但这两点在第 16 环上相隔 8 个位置、不存在 9 连续亮弧，其真实分数为 0。

| 配置 | 角点数 | 含 `(8,8)` score 0？ |
|---|---|---|
| 有叶，`min_score = 0` | 2（两个亮点，score 均为 255） | 否 |
| 无叶，`min_score = 0` | 3 | **是** |
| 有叶 ∕ 无叶，`min_score ≥ 1` | 2 | 否（第二叶兜住） |

两种 `non_max_suppression` 取值下读数相同。

### ⑤ 为什么既有门都读不到

coverage 扫描只看「有没有**执行**」，而这一叶**执行的次数最多**。
要发现「执行 ≠ 被钉住」，只能逐叶做负控 —— 这是 R28 已经写下的教训，本轮是它在整数 ∕ 布尔叶子上的一次实例。

### ⑥ 仪器教训（本轮的真正收获）

R29 的整仓批扫把谓词写死在 `is_finite ∕ <= 0.0 ∕ == 0.0 ∕ is_nan` 这几个**浮点**形状上，
于是**整个整数 ∕ 布尔叶子集合是它的盲区** —— `best == 0` 从未被扫到。
把枚举放宽到「全部单行 `A 或 B` 守卫」（本仓 `amos-robot` 共 **42** 条）后，本条才浮出水面：
**扫描器的谓词定义了它的盲集。**

### 修法（生产逻辑不动）

一行生产逻辑都没改 —— 守卫写得对。新增
`a_pixel_with_no_arc_is_not_a_corner_even_with_a_zero_score_floor`（两种 NMS 取值下断言 `(8,8)` 不在角点集里、
每个返回角点的 `score > 0`，并配对照断言两个亮点仍在），并在守卫行内写明两叶的分工。

### 负控（实测；`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原）

| 扰动 | 红点 |
|---|---|
| 删 `best == 0` ⇒ | 恰 **1 红**（本用例）、388 全绿 |
| 删 `best == 0` 并 `--skip` 本用例 ⇒ | **388 passed ∕ 0 failed**（叶子在被钉住之前确实无人见证） |

全套 **439 passed**（389 单元 + 38 集成 + 12 doctest，原 438），
`cargo fmt --check` ∕ `clippy --all-targets` 均 0 警告。

### 如实边界（✅）

- **只加一条测试 + 一段行内注释**，未动检测算法，未改 Rust ∕ proto ∕ 事件流。
- **线上无此路径**：生产调用者 `vision/vo.rs` 用 `FastConfig::conservative`（`min_score = 30`），
  所以这是一次**公开配置契约在合法取值下未被履行**的补钉，不是一次已发生的线上故障。
- **同轮扫描的其余候选如实排除**：`fusion.rs:556` 的 `!norm.is_finite()` 与 `slam/ekf.rs:359` 的
  `!v.is_finite() ∕ v < 0.0` 行内**早已写明**是「防御性、当前不可达」并刻意不造用例；
  `vision/five_point.rs:214` 的 `!s[0].is_finite()` 与 `s[0] <= 0.0` 由构造不可达
  （`s[0] = sqrt(max(eig, 0))` 且 `ef` 是 Jacobi 的单位特征向量）—— 均不作弊地拒绝，不在本轮窗口内。

## 68. 两叶绑定守卫里的 `is_finite` 一叶无人走：它只在 `bound = +inf` 下独自承担语义（REQ-A1270 ∕ F-SH-545）

`mrac.rs` 的 `MracController::with_theta_bound` 是设置投影界的公开构造点：

```rust
pub fn with_theta_bound(mut self, bound: f64) -> Self {
    if bound.is_finite() && bound > 0.0 {
        self.theta_bound = bound;
    }
    self
}
```

### ① 两叶并不同权，而 `is_finite()` 那一叶无人走

文档（`with_theta_bound` 上方）逐字承诺「A non-finite or non-positive bound is ignored (the default stands)」，
唯一针对这条的用例 `a_nonsense_theta_bound_is_ignored` 喂的是 `-3.0` 与 `f64::NAN`：

| 输入 | `is_finite()` | `bound > 0.0` | 谁拒绝了它 |
|---|---|---|---|
| `-3.0` | 真 | **假** | 兄弟叶 |
| `NaN` | **假** | 假 | 两叶都拒（`NaN > 0.0` 也是假） |

也就是说：**两例都由兄弟叶 `bound > 0.0` 就能拒绝** —— `is_finite()` 在全部既有输入下从未被见证。
删掉它，全套 389 单元用例一个都不红（实测）。

### ② 它在哪里独自承担语义：`bound = +inf`

`+inf > 0.0` 是**真**，兄弟叶放行；只有 `is_finite()` 拒它。`f64::INFINITY` 是一个合法的
`f64` 实参，且正是文档点名要忽略的「non-finite」之一。**本仓自己的约定就要求喂它**：
同文件同形状的 `gamma` 守卫（`new` 的 `gamma.is_finite() && gamma > 0.0`）在
`a_nonsense_adaptation_gain_falls_back_to_the_default` 里逐字写着 `for bad in [f64::NAN, 0.0, -2.0, f64::INFINITY]`
—— 只有 `theta_bound` 这一处漏了那个 `f64::INFINITY`。

### ③ 删掉它会发生什么

`with_theta_bound(f64::INFINITY)` 被采纳 ⇒ `theta_bound = inf` ⇒ 下一步的
`(self.theta_hat + dt_s * theta_dot).clamp(-inf, inf)` **退化为恒等映射**。
模块文档逐字承诺的是「`|θ̂| ≤ theta_bound` holds **unconditionally**」（Ioannou ∕ Sun 的投影算子，
第 50-57 行），而这条「无条件」正是 Lyapunov 证明所需的**有界参数集**：
故障下（传感器掉线使 `e` 持续、回归向量卡死）裸自适应律无界积分，`θ̂` 无界 ⇒ `u = r − θ̂·ω` 无界。
一次「胡闹的界被静静地当成界」的退化，把一条安全属性换成了一个恒等式。

### ④ 实测（负控，逐叶独立；`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原）

在**修前的字节**上中性化本叶（`bound.is_finite()` → `true`）：

| 扰动 | 结果 |
|---|---|
| 修前：中性化 `is_finite()` | **389 passed ∕ 0 failed**（叶子确实无人见证） |
| 修后：中性化 `is_finite()` | 恰 **1 红** —— `an_infinite_theta_bound_is_ignored_not_adopted` |
| 修后：中性化兄弟叶 `bound > 0.0` | 恰 **1 红** —— **既有的** `a_nonsense_theta_bound_is_ignored` |
| 还原后 | 390 ∕ 0 全绿 |

两叶的红点分属**两条不同的用例**，这是「两叶互不遮蔽」的可执行证据。

### ⑤ 修法（生产逻辑一行未改）

守卫写得对。新增 `an_infinite_theta_bound_is_ignored_not_adopted`，并在守卫上方用一行注释写明
两叶为何不可互换（`+inf > 0.0` 为真，只有 `is_finite()` 拒它，而无穷的界会把 clamp 变成恒等式）。

### ⑥ 仪器教训（本轮的真正收获）

R29 的整仓批扫把谓词写死在浮点形状上；R30 放宽到「全部单行 `A 或 B` 守卫」，找出了 `best == 0`；
本轮（R31）把谓词向**两个方向**各推一次：

- **按算子**：单行 `A && B` 与三操作数以上的 `||`（R30 的谓词只覆盖双操作数 `||`），`amos-robot` 共 **147** 条候选；
- **按行形**：条件**跨行折断**的守卫（前两轮的谓词都写着「单行」，于是「Rust 格式化折了行的守卫」整集是盲区），
  共 **87** 条候选。

`sweep1`（147 条）跑满，在 **389 passed** 基线上得到 **60** 条中性化后仍全绿的叶；
本条 `mrac.rs:142` 就是其中**唯一**「同级遮蔽」形状：兄弟叶在全部既有输入下都在替它干活。
`sweep2`（87 条）因共享 `target/` 上多枚并行 cargo 构建争用、吞吐不足以在本轮窗口内跑完，
仅前 4 条完成（`localization.rs:429-436` 的四个 `!f32.is_finite()` 各 **1 红**，均已被钉住）——
如实记录为未完成，不据未完成的扫描下结论。**同一教训第二次被确认：扫描器的谓词定义了它的盲集。**

### 如实边界（✅）

- **只加一条测试 + 一段行内注释**，未动控制算法 ∕ 结构体字段 ∕ 其它模块。
- **线上无此路径**：`crates/amos-robot` 内的调用者与示例都传正数 ∕ 默认值，无一传 `+inf`，
  所以这是一次**公开契约在合法取值下未被履行**的补钉，不是一次已发生的线上故障。
- **未做真机 ∕ 硬件在环复核**，证据是 `cargo test -p amos-robot` 的读数与逐字节负控。

## 69. 双值模式选择子只在**一个**方向上被钉住：`Eight` 丢掉对角步时，390 例全绿（REQ-A1300 ∕ F-SH-575）

`planning.rs` 的 `plan` 在邻居展开循环里有一道对角展开闸：

```rust
for (dcol, drow) in STEPS {
    if connectivity == Connectivity::Four && dcol != 0 && drow != 0 {
        continue;
    }
    ...
}
```

`STEPS` 是八个方向；`Connectivity::Four` 的文档说「no diagonal moves」，
`Connectivity::Eight` 的文档说「A diagonal step is allowed only when **both** orthogonal neighbours
it passes between are free」。也就是说：**`Eight` 是允许对角步的**，它只是拒绝「从两个被占格之间挤过去」的那些 ——
而拒绝这件事交给下面的 `grid.step_is_legal`（角规则）。

### ① 同一道闸，一个方向被钉死，另一个方向完全隐形

| 扰动（在**修前**的字节上） | 结果 |
|---|---|
| 中性化 `connectivity == Connectivity::Four` → `true`（`Eight` 也跳过全部对角步） | **390 passed ∕ 0 failed** |
| 反转成 `connectivity == Connectivity::Eight`（`Four` 反而拿到对角步） | 恰 **1 红** —— `a_smoothed_paths_cost_is_refused_not_under_priced` |

反转有红、中性化无红，这个**不对称**就是全部线索。原因是删除这一叶对 `Four` 是**行为中性**的
（`Four` 本来就只走正交步），所以受影响的只有 `Eight`；而 `Eight` 的每一条用例都是**非严格**断言：

- `eight_neighbour_never_costs_more_than_four` 断言 `eight_cost <= four_cost` —— 退化成 `Four` 后两者**相等**，`<=` 满足；
- `a_wall_is_gone_around_and_no_corner_is_cut` 断言 `cost > heuristic(start, goal, Connectivity::Eight)` ——
  曼哈顿路线比八分度启发大得多，照样满足；
- `tests/stack_e2e.rs` 只检查车到没到终点；
- `smoothing_keeps_the_ends_…` ∕ `a_smoothed_paths_cost_is_refused_not_under_priced` 用的是 **`Four`**，不受影响。

于是「`Eight` 真的会走对角步」这件事，**没有任何一条用例、任何一个门、任何一段文档检查**钉住过。

### ② 删掉它会发生什么

`Eight` 静默退化为 `Four`：每条路线都变成曼哈顿，`STEP_DIAGONAL = 14` 从此不再被任何一步使用，
而 `heuristic` 仍在按八分度距离估计 —— **启发式与实际步代价的对应关系被悄悄切断**。
每一条路径都次优（更长的路线、更多的能耗与时间），而公开文档承诺的行为没有被履行。
路线仍然无碰撞、仍然遵守角规则，所以这不是安全失效，是**功能降级 + 契约失守**：
一个「只有在你把它删掉时才会显形」的缺口。

### ③ 实测（负控逐叶、逐向独立；`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原）

| 扰动 | 修前 | 修后 |
|---|---|---|
| 中性化（`Eight` 丢掉对角步） | **390 passed ∕ 0 failed** | 恰 **1 红**（本用例） |
| 反转（`Four` 拿到对角步） | 恰 **1 红**（既有 `a_smoothed_paths_cost_is_refused_not_under_priced`） | **2 红**（既有那条 + 本用例的对照叶） |
| 还原 | 391 ∕ 0 | 391 ∕ 0 |

修后两个方向各有红点、且红在**不同的**用例上（反转时既有那条先红），
这是「两个方向都被钉住、互不遮蔽」的可执行证据。

### ④ 修法（生产逻辑一行未改）

守卫写得对。新增 `eight_neighbour_actually_takes_the_diagonal`：4×4 开放场 (0,0)→(3,3)，
断言 `Four` 的代价 == `6 * STEP_ORTHOGONAL`（曼哈顿）、`Eight` 的代价 == `3 * STEP_DIAGONAL`（三个对角步）、
`Eight` 严格更便宜、`Eight` 路线里**确实含**至少一个对角步，并配一条对照——
`Four` 的路线必须**只**走正交步，否则「一切都走对角」的实现也会通过。
另在守卫上方写明：该操作数是**唯一**的对角展开闸，删掉它 `Eight` 就退化成了 `Four`。

### ⑤ 仪器（R31 那台批扫的收割）

本条是 R31 那台**放宽了两次**的整仓批扫留下的候选之一：R31 把谓词按**算子**放宽
（单行 `A && B` 与三操作数以上 `||` —— R30 的谓词只覆盖双操作数 `||`，`amos-robot` 共 **147** 条候选）
并按**行形**放宽（跨行折断的守卫，前两轮都以「单行」为谓词而整集排除，共 **87** 条候选）。
`sweep1`（147 条）跑满，在 389 基线上给出 **60** 条中性化后仍全绿的叶；本轮从这份收割里取走一个。
`sweep2`（87 条多行候选）至今**未跑完**（R31 到 4/87、本轮未重启），如实记为未完成的盲集。

### 如实边界（✅）

- **只加一条测试 + 一段行内注释**，未动 `plan` 的搜索、`Grid`、`Path` 或任何其它模块。
- **这是覆盖缺口，不是行为缺陷**：生产守卫本身正确，线上没有一条路径受影响 ——
  它是一次**公开契约没有任何可执行钉子**的补钉。
- **未做真机 ∕ 硬件在环复核**，证据是 `cargo test -p amos-robot` 的读数与逐字节负控。

## 70. 补全（REQ-A1493 ∕ F-SH-733）：MCL 只报失不救人——把 sensor resetting 真正做出来（2026-09-25）

**缺陷（自审边界 2）**：`localization.rs` 的边界 2 从 REQ-A716 起逐字写着「本模块**没有**重新播种
（sensor resetting / Lenser & Veloso），被搬走的机器人是**被报失**而非被救」。这不是错字，是一个
**被主动声明为不做**的缺口：滤波器能**检测**信念丢了（`match_quality → 0`、判 `Diverged`），但云一步
也不会往真位姿挪——`predict` 只会沿着（错的）运动模型把云推走，机器人在**没有里程计的搬运**下永远
回不来。本轮的起点是用户要求「对最新添加的代码审计与补全，**真实实现功能**」，明确点名 MCL 传感器
重采样。

**修法（真算法，非桩）**：在 `McLocalizer::update` 里、权重归一化之前加**传感器重采样**：

1. 先用一次 `score` 遍算 `best_sum_nees` ⇒ `candidate_mq = exp(-½·best/z)`，这正是本步将要上报的
   `match_quality`；
2. `candidate_mq < McControl::sensor_reset_trigger`（默认 = `MATCH_QUALITY_FLOOR` 0.05，故「健康判
   Diverged 的读数不符那一叶」与「救援已武装」是**同一个条件**，不会各自漂移）且
   `sensor_reset_ratio > 0`（默认 0.3）时，`reseed_uniform(k)` 把 `k = round(ratio·N)` 个粒子**从位姿
   先验重抽**——在地图包围盒 + `INITIAL_SPREAD_MARGIN_M` 上均匀撒位置、均匀抽航向，用**随机步长**
   走 `k` 个互不重复的槽位；
3. 对同一次扫描**重新 `score`**（第二遍），让新假设与幸存者**同场竞争权重**；随后原有的重采样把能
   解释读数的假设留下来。

**为什么是「均匀提议 + 似然重加权」而不是「逆观测模型直接采样」**：地标地图**没有解析逆观测模型**
——单个读数只把位姿约束到一个圆（航向自由），从它采样命中真值的概率是零测度。Lenser & Veloso 的
实用形式正是：从位姿先验提议、用**整次扫描**的传感器似然选择。`k` 个均匀假设里只要有落在真位姿
邻域的，它就在重打分里胜出、被重采样放大——这就是救援。

**有界性**（本仓的硬规矩）：救援最多移动 `ratio · N` 个粒子，且**只在发散步**上发生；第二遍 `score`
是这步的额外代价（普通步 1×，发散步至多 2×），已写进 `max_step_evaluations` 的文档。收敛的信念
不受影响——由 `a_matching_reading_never_fires_the_rescue_draw` 钉住（`ratio = 1.0` 下若触发器误触，
整团云会被撒成地图尺度；实测 σ 仍在收敛半径内）。

**验证**：`cargo test -p amos-robot` ⇒ **397 单元** + 5/5/2/11/7/4/4 集成 + 12 doctest 全绿；
`cargo clippy -p amos-robot --all-targets -- -D warnings` 净；`cargo fmt --check` 0 diff。
新增用例：`sensor_resetting_recovers_a_kidnapped_robot`（在原点收敛后被搬到 (5,−3,2)，40 步内**恢复到
真位姿**且判 `Converged`）、`without_sensor_resetting_a_kidnapped_robot_stays_lost`（`ratio = 0.0` 的
**同场景同种子**对照，40 步内健康**永不**为 `Converged`、末态 `Diverged`）、
`a_matching_reading_never_fires_the_rescue_draw`（触发器门槛的判别性观测），外加 `McControl` 两个新字段
的 6 条拒绝行与「`ratio = 0.0` 合法、不是畸形参数」的正向断言。

**负控（实测，逐字节还原）**：把 `update` 里的 `self.reseed_uniform(k);` 中性化为 `let _ = k;` ⇒
**恰 1 红**，正是 `sensor_resetting_recovers_a_kidnapped_robot`（`36 passed ∕ 1 failed`）；`cp` 还原后
复绿 **37 passed**。带 ∕ 不带种子的两用例是**同一场景**只改 `ratio` 的判别对：无救援 ⇒ 永不复原，
有救援 ⇒ 复原，互为对照。

**本轮发现的既有用例前提错误（一并修，非沉默改）**：`a_wrong_map_is_reported_as_diverged_not_converged`
的旧夹具把真值图**整体平移 100 m** 当作「错地图」。但刚体平移**不改变地图形状**——原点处对真方图取的
读数，被一个站在「平移后原点」的机器人**逐字复现**。云种子紧贴原点、又无运动，所以旧版一直绿；传感器
重采样一开，云**搜遍全图**并正确地在该平移图里定位 ⇒ 旧夹具红了。这说明旧夹具量的是**搜索范围**、
不是地图分歧。夹具改为**每个地标各自位移**（无刚体变换可复现），读数才真与每个地标都不符。**意图未变**
（「不描述读数的地图不得报 Converged」），只是把「错」从「平移」纠正为「非全等」。

**如实边界**：① 这是**离线、纯 Rust**的算法补全，**未做真机 ∕ 硬件在环复核**；② 救援的**质量**取决
于 `ratio` 与 `N`——`ratio` 太小 ∕ 地图太大时，均匀假设可能**没落在**真位姿邻域，救援不保证成功（这是
采样滤波器的固有性质，不是 bug；测试用 `N = 4000`、`ratio = 0.3` 把它钉在可复现区间）；③ 均匀提议对
**地图尺度**敏感——地图若远大于机器人活动区，有效命中率下降，本模块不做空间索引（与边界 10 同一理由）；
④ 触发器**无迟滞**：检测与重抽在**同一次 `update`** 内完成，判定发散的那一步就救援。

## 71. 补全（REQ-A1494 ∕ F-SH-734）：JCBB 只在文档里被「点名」——把联合相容数据关联真正做出来（2026-09-25）

**缺陷**：单条 `SlamState::observe` 的关联是「最近且过门」的贪心，**没有一对一约束**。两条读数若都最靠近
同一个地标，就会**同时**匹配它（第一条更新后地标被拉向它，第二条仍然最近），地图被两次方向相同的「纠正」
扭曲——这正是 `data_assoc.rs` 模块文档自己写的 "single-reading observe can double-book a landmark"。
文献的解是 **Joint Compatibility Branch and Bound**（Neira & Tardós, IEEE T-RA 2001），而本 crate 有三处
（`lib.rs`、`slam/mod.rs`、`AEROSPACE_PLAN.md`）一律写它「**未实现**，是预留的扩展点」。**本轮是一次诚实的
反转**：这一条不再是「不做」，而是**做**。§6 与 §27 的相应记录已就地标注「当时」，不抹去历史。

**算法**（`SlamState::associate_joint`）：
1. **个体相容**（prior）：每个观测 × 每个 `ever_observed` 地标算 `νᵀ S⁻¹ ν`（与单条路径**共用**同一
   `gate_statistic`，两者不可能漂移），过 `control.gate_squared` 者入候选表；
2. **一对一**：一个地标在一个假设里至多出现一次（`landmark_used`）；
3. **联合相容**：把假设的 `m` 对读数**堆叠**为 `2m` 维创新 `ν` 与 `S`——对角块是各对自身的 `H Σ Hᵀ + R`，
   非对角块是 `H_a Σ H_bᵀ`（量测噪声独立，只进对角）——用高斯-约当（列主元）解 `S x = ν`，判
   `νᵀ S⁻¹ ν ≤ χ²(2m, 0.95)`；
4. **分支限界**：候选按个体门升序 DFS，`hyp_len + 剩余观测数 < best_len` 剪枝；「本观测不关联」永远是一条
   合法分支，故任一深度都有完整叶可回。

**联合奇异 ⇒ 剪枝，不报错**（对 `innovation_gate_squared` 的**刻意**偏离）：单条路径无可退，故 `Err(Singular)`；
搜索里有替代分支，退化分支直接剪掉即可。此偏离写在 `associate_joint` 的文档里。

**有界**（NASA Power of 10 §2）：`MAX_JCBB_OBSERVATIONS = 8`（超者 `TooManyObservations{given}` **拒绝**，
不截断）、`MAX_JCBB_CANDIDATES = 8`、`MAX_JCBB_NODES = 4096`（到顶即返回**当前最优**，有界且确定）。全部
缓冲为定长数组，搜索**零分配**；唯一分配是 `verdicts()` 返回的 `Vec<Association>`（同 `data_assoc::associate`
的每调用一笔）。配套 **`EkfSlam::observe_batch` / `SlamState::observe_batch`**：关联对**先验**算一次，更新
按序施加（标准分解）。

**验证**：`cargo test -p amos-robot` ⇒ **408 lib + 38 集成 + 12 doctest** 全绿（本轮 +11 lib）；clippy
`-D warnings` 0 告警；fmt 净；`cargo doc -D warnings` 净。判别性用例**成对**：① **一对一**——两条都最近地标 0
的读数，单条 `observe` 两次都匹配地标 0（`Matched{0}`、`Matched{0}`），JCBB 必须拆成 `[0, 1]` 且不新增地标；
② **联合门本身**——航向 σ = 0.3 rad 使两条方位高度相关，两读数落在地标对**两侧**：四对**各自**都过 `χ²(2)`
门，却**没有**任何一对一配对能过 `χ²(4)` 联合门，故 JCBB 被迫降到 size 1（其中一条诚实为 `New`）。

**一并补上的相邻缺口**：`observe_batch` 会 `create_landmark`，而**单条** `observe` 对
`initial_landmark_variance` 的上限拒绝（负值 ⇒ `Landmark::new` 收到 `NaN.sqrt()` ⇒ 其 `sigma.max(0.0)²`
折成**零协方差**地标，即「完全已知」，与「宽先验」正相反）在批路径上原本**缺一份**——新路径若不带此检查，
`add_landmark` 的守卫在 `v` 已是 `0.0` 后无法察觉。现已把同一条拒绝前置到 `observe_batch`，并加判别用例。

**负控（先突变、后逐字节还原）**：把 `joint_statistic` 改成恒 `Some(0.0)`（联合门失效）⇒ **恰好** ② 红、
其余 40 绿；把 `landmark_used` 改成恒 `false`（一对一失效）⇒ **恰好** ① 红、其余 40 绿；删掉
`observe_batch` 里的 `initial_landmark_variance` 检查 ⇒ **恰好**「refuses an invalid initial landmark
variance」红、其余 40 绿。三个控制各只点名一个测试，证明三条性质各自被钉住，且用例不是「因为别的原因」通过的。

**如实边界**：① 纯**离线、纯 Rust** 的算法补全，**未做真机 ∕ 硬件在环复核**；② 候选表上限
`MAX_JCBB_CANDIDATES` 会**漏掉**个体门排名第 9 及以后的真匹配——这是「个体门本应已剪掉它」的有界假设，
不是保证；③ 联合测试**线性化**（用与单条路径同一 `H`、同一 `Σ`），故只对**当前线性化点**成立，不给多假设
（EKF 单一线性化点本就如此）；④ `MAX_JCBB_NODES` 到顶后返回**已找到的最优**，未必是全局最优——有界、确定
的**近似**，不是精确解；⑤ 批内关联对**先验**算，更新依次施加，第二条更新看到的是第一条改过的 `Σ`，与联合
测试所用先验不同（标准分解，此处写明）；⑥ 每个观测的 `New` 距离报其**过门**候选的最小个体门根，无候选时
`INFINITY`——与 `data_assoc::associate`「报最近（即使被拒）距离」的语义**略有不同**，此处以「候选 = 过门者」
为准；⑦ 功能已接线到公开 API（`SlamState::associate_joint` / `observe_batch`、`EkfSlam::observe_batch` 及
`MAX_JCBB_*` 再导出），但**尚无生产调用者**——本轮的「完成」是算法与门已真实存在并可被调用，不是某个上层
路径已改用它。
