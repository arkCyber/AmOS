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
3. **没有 Kalman**：没有状态协方差可发布，所以输出是**类别**（`GravityCorrection`）而不是 σ。
   一个 EKF/UKF 只有在能同时发布它声称的协方差时才该进这一层。
4. **没有多机协同/编队**：那是任务层（`amos-link` 的机群监督案例演示了“监督”是什么形状）。
5. **没有把 `DriveCommand` 扩成通用动作**：它是 `ground-vehicle` 的三元组；四足/无人机/机械臂
   各自的命令形状不同（共用的是剖面表与帧，不是**规划输出**）。

## 5. Phase 2 接缝：SLAM 与视觉在哪插进来

这两块不是“再写几个函数”，它们各自需要**传感器数据**与**地图表示**，所以先把接缝写清楚：

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

## 6. 验证入口

```bash
# 本层：51 单元 + 2 端到端（跨 crate）+ 10 doctest，全部离线
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
