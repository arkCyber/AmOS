# 机器人领域剖面（一个 OS，六类机器）

> 这一层回答一个问题：**同一套 AmOS 机器人操作系统，怎么服务四足、机械臂、无人机、地面车辆、无人艇、
> 工业单元这六类完全不同的机器？** 答案不是六套代码，而是**数据**：每类机器写一份「平台剖面」
> （`crates/amos-link/src/platform.rs`），描述自己的执行器、单位、意图词表和**安全包线**；
> 中间件、帧格式、QoS、序号/速率/带宽仪器、回程、控制面、安全核心（急停锁 + 看门狗 + 拒绝语义 + 回程）
> 全部**共用**。
>
> 与本文配套：`docs/robot-apps.md`（应用案例：巡检/机群/控制面/上电/信任边界），
> `docs/amos-link.md`（设计记录），`crates/amos-link/README.md`（crate 入口与诚实边界）。
>
> **一句话边界**：这一层描述「机器有什么、能接受什么、链路丢了欠它什么」，它**不是**认证、
> 不是实时内核、也不是各域的协议栈（MAVLink/CANopen/EtherCAT/OPC-UA/DDS 都在域侧）。

## 0. 剖面是什么（数据，不是代码）

六份内置剖面是 `const` 表；**部署自己写的机器**走 `Platform::from_parts(kind, actuators, actions,
envelope, arm_on_motion)` —— 同样逐条校验（见 §5 与 §6 边界 11）。不是六份内置能做、你的机器不能做。

```text
  Platform
  ├── actuators  执行器表：总线序号、名称、角色、单位、行程          → 帧
  ├── actions    词表：动作键、类别（Arm/Motion/Halt）、姿态、参数限   → 意图
  └── envelope   安全声明：看门狗周期 + 链路丢失后的机动（failsafe）
```

三类东西被刻意共用，避免"五个平行实现"：

| 共用的 | 为什么 |
|---|---|
| **帧**（`MotorFrame`：`SOF│id│op│i32│CRC16`） | 剖面的规划结果就是出货帧；没有第二套线格式。`SetPosition`（毫度，±90°）与 `SetTorque`（毫百分比，0..=100）就是参考机的参数空间 —— 剖面行程必须落在其中 |
| **类别**（`IntentClass`） | 安全核心只认三件事：`Arm` 解锁、`Motion` 在锁定下被拒、`Halt` 停机并锁定。各域用什么词（`trot`/`takeoff`/`lane_keep`/`station_keep`/`cycle`/`grip`）是剖面的 |
| **看门狗与回程** | `RobotBridge` 一条代码路径负责全部剖面：锁定、deadman、拒绝（带原因）、回程上报；停机**动作**由剖面决定（车的 `Halt` 是全力制动、机械臂是逐关节切扭矩、单元是断电） |

## 1. 六份剖面（代码即文档：`Platform::<kind>()`）

| 剖面 | 执行器 | 词表（Arm/Motion/Halt） | 看门狗 | 链路丢失后欠它什么（failsafe） |
|---|---|---|---|---|
| `quadruped`（参考机） | 12 关节（±90°） | `arm` / `stand·trot·walk·sit` / `estop` | 500 ms | `stop`（逐关节切扭矩） |
| `manipulator` | 6 关节 + 夹爪 | `arm` / `home·ready·move·grip` / `estop` | 100 ms | `hold`（保持位置，属刚体/带抱闸） |
| `drone` | 4 推力 + 2 升降副翼 | `arm` / `takeoff·hover·goto·rtl·land` / `estop` | 300 ms | `return-to-base` |
| `ground-vehicle` | 转向 + 油门 + 制动 | `arm` / `hold·lane_keep·cruise·slow` / `estop`（=全力制动） | 100 ms | `minimal-risk-manoeuvre` |
| `surface-vessel` | 双桨 + 舵 | `arm` / `station_keep·waypoint·loiter` / `estop` | 500 ms | `loiter` |
| `industrial-cell` | 3 轴（行程百分比）+ 夹爪 | `enable` / `home·cycle·pick·release` / `stop`（=断电） | 50 ms | `stop` |

**每条参数限都在剖面上，不在注释里**：`goto` 的 `north_mm/east_mm`（±300 m）、`altitude_mm`（0..120 m），
`lane_keep` 的 `lane_offset_mm`（±1 750 mm）、`cruise` 的 `speed_mm_s`（≤36 000 mm/s = 130 km/h）、
`slow` 的 `decel_mm_s2`（≤4 000），`station_keep`/`loiter` 的 `radius_mm`（≤50 m），
`cycle` 的 `cycle_ms`（100..60 000），`move`/`grip` 的 `speed_milli_percent`/`force_milli_percent`。
越界**拒绝并点名那个数**，绝不夹取到边界：被夹住的围栏 = 飞到没人要求的地方。

**哪些参数必须给，也在剖面上**（`ActionSpec::min_params`）：`goto` 与 `waypoint` 至少要有一个坐标
（它们是**目标**，没目标就不是那条动作），其余带参数的动作都有文档化的默认值（车道偏移 0 = 居中、
`slow` 不给就按位姿的制动力），因此 `min_params = 0`。

## 2. 每类机器的链路契约（该用哪条通道，为什么）

| 域 | 高频流（`sensor`，最新一帧赢） | 指令流（`control`，reliable，不可丢） | 回程（`state`，安全事实） |
|---|---|---|---|
| 无人机 | 姿态/高度/电池遥测 50–200 Hz | `goto`/`rtl` 等意图 10–50 Hz | armed / 切桨(+原因) / 看门狗 / 最近拒绝 |
| 地面车辆（自动驾驶） | 感知与车辆总线 50–100 Hz | 转向/油门/制动设定点 **50–100 Hz** | 同上 + MRM 触发 |
| 工业单元 | 视觉/力矩 100–1000 Hz（或走 EtherCAT，见 §4） | 节拍/取放指令 1–10 Hz | 同上（`stop` = 断电） |
| 机械臂/具身 | 关节反馈 100–1000 Hz | 关节设定点/遥操作 100–500 Hz（`move` 必须给全每个执行器） | 同上（`hold`） |
| 无人艇 | 导航/航向 10–50 Hz | 航点/值守 1–10 Hz | 同上（`loiter`） |
| 四足（参考） | 深度/IMU 30–100 Hz | 步态指令 1–10 Hz | 同上 |

**为什么指令流用 `reliable`**：`control` 通道是背压的（消费者跟不上时发布者被 `blocked` 计数），
不是"丢最旧" —— 一个设定点被静默丢弃，在车上是另一条车道、在无人机上是另一段轨迹。
**为什么遥测用 `sensor`（depth 1，最新赢）**：陈旧姿态比没有姿态更糟；消费者落后就丢自己的积压，
而丢掉的帧会被计数（`dropped`），不会假装收到过。

## 3. 安全语义：三类机器的"停"不是同一件事

| 机器 | `Halt` 的实际动作（剖面的） | 为什么 |
|---|---|---|
| 四足/机械臂 | 逐关节 `Estop`（切扭矩） | 有抱闸/自锁结构，切扭矩即停 |
| 汽车 | 制动 100% + 油门 `Estop` | 车"切扭矩"= 滑行，不是停车 |
| 工业单元 | 全体 `Estop`（断电） | 有防护围栏与人，断电是标准做法 |
| 无人机/无人艇 | 同样切推力/桨，但**这不是安全的终点** | 空中/水上必须机动：RTL / 迫降 / 值守 —— 由**任务层**执行 |

看门狗到期时 `RobotBridge` 做的**是本层能给的最小安全动作**（剖面的 halt 批次，帧数由总线**报出来**），
同时把剖面声明的 **failsafe 机动**写在包里；无人机/无人艇这类"停住不安全"的机器
（`PlatformKind::must_manoeuvre_when_lost()`）必须有任务层去执行它 —— 案例 `uav_mission` 就是这件事。

## 4. 域侧要自己提供什么（这一层**不**做，且不该假装做）

| 域 | 协议/总线 | 安全与合规 | 实时性 |
|---|---|---|---|
| 无人机 | MAVLink（PX4/ArduPilot）、SBUS/CAN | 围栏/失控保护是**本层**给了参数与声明，适航认证不在 | 200–400 Hz 姿态环在飞控里，本层只管指令/遥测 |
| 自动驾驶 | CAN/CAN-FD、SOME/IP、AUTOSAR AP | ISO 26262 ASIL、安全论证、ODD 定义 | 确定性时延（TSN）、看门狗 10–100 ms 是产品决定 |
| 工业 | EtherCAT/PROFINET/OPC-UA、安全 PLC | IEC 61508 SIL、安全回路（e-stop 链）**独立于本层** | 循环 1 ms 级在 PLC 里，本层搬运节拍指令与状态 |
| 机械臂/具身 | CANopen/EtherCAT、力/力矩环 | 力矩/碰撞限制、人体接近（ISO/TS 15066） | 关节环 1–10 kHz 在驱动器里 |
| 无人艇 | NMEA 2000/CAN、AIS | COLREGs、人员落水流程 | 与无人机同 |

**读法**：本层是"机器与操作员/任务系统之间的那条链路 + 意图与安全包线"，它把**谁能命令什么、越界怎么办、
链路丢了欠什么**变成可执行、可测试的东西；域侧的协议栈、认证与硬实时环**不在**其中。


## 5. 接受边界：这一层拒收什么（**要么用上，要么点名拒绝**）

一个操作员发出去的东西只有两种命运：**被用上**，或者**带原因被拒**。第三种（收下、校验、然后悄悄不用）
在本层被逐条堵死 —— 每一条都是实测出来的，不是读出来的（第二十二轮）：

| 你发的东西 | 本层的回答 | 为什么 |
|---|---|---|
| 未知动作键 | `unknown action … (this profile has: …)` | 新词不是提示；顺带把**这台机器有**的词列出来 |
| 未知参数 | `… has no parameter …` | 一个没被认识的限（比如 `ceiling_mm`）不是提示 |
| 参数越界 | `… is outside the limit -300000..=300000 …` | 夹取到边界 = 飞到没人要求的地方 |
| 设定点越界 | `… outside its travel …` / `… the frame's … argument space` | 这是**剖面写错了**，不是关节错了 |
| **固定位姿动作带 `speed`** | `… has a fixed pose, so speed 0.1 cannot be honoured: remove it, or send the set points you want in targets` | 曾经：解析→校验→丢掉，`takeoff` 的 0.1 与 1.0 产出**同一批 55% 推力帧** |
| **同一执行器两个设定点** | `actuator 0 (thruster_1) is named twice …` | 曾经：`find()` 取第一个，JSON 字段顺序决定了无人机飞哪个推力 |
| **只有目标参数的动作没给参数**（`goto`/`waypoint`） | `… needs at least 1 of its parameters (north_mm, east_mm, altitude_mm) …` | 曾经：`{"action":"goto"}` 被接受，飞出默认 58% 推力位姿 —— 一个顶着"去某处"名字的默认动作 |
| 遥操作动作缺设定点 | `needs a set point for every actuator, and actuator 1 (j2) is missing` | 补零 = 命令了一个谁都没提到的关节 |
| 未解锁时的运动 | `not armed: send {"action":"arm"} first` | "油门动了但什么都没发生"是最危险的形状；点名**这台机器自己**的解锁键 |
| 急停锁存中的运动 | `e-stop latched: send {"action":"enable"} to re-arm` | 同上：绝不叫人发一个这台机器没有的动作 |
| 排不出来的看门狗（0 / 超长） | 构造期拒绝（`Platform::from_parts`） | 一个 0 周期的看门狗只是一个字段 |

**停机永远不被这些规则拦住**：`Halt` 不看 speed、不看 targets、不看 params —— 一个拼错了字段的急停
必须照样停车（这条与参考机一致，且被测试钉住）。

## 6. 今天的诚实边界（全部是**已登记的**，不是隐藏的）

1. **一个剖面最多 12 个执行器**：`JointId` 在构造器与线缆两侧都拒绝更大的序号。24 轴机械臂需要把 id 的
   上界改成"剖面自己的" —— 帧的**布局**已经通用（`FRAME_LEN`），不通用的是参考机定下的**界**。
2. **参数空间是参考机的策略**：`SetPosition` ±90 000 毫度、`SetTorque` 0..=100 000 毫百分比且**非负**。
   因此「倒车推力」（无人艇后退）今天**不可表达**；本仓的艇剖面是双桨 + 舵，倒车登记为现场项。
   直线轴（工业单元）用**行程百分比**表达，毫米表达同样需要剖面级参数空间。
3. **HAL 是参考四足的记录器**：`MockRobotHal` 记 12 个关节的形状；真描述符那条路径是
   `StreamRobotHal`（`docs/amos-link.md` §3.5）。域案例证明的是**同一帧格式与同一安全核心**，
   不是"真电机被驱动过"。
4. **回程共享文档里的 `gait` 字段仍属四足词表**：剖面的动作键**不**写进它（那会是一次载荷 schema 变更，
   连带 proto 与界面），剖面机器把 `gait` 留空、把安全事实（armed/estopped/watchdog/frames/最近拒绝）
   照常上报；域自己的模式走自己的话题。要把它并入共享文档，需要单独一轮。
5. **没有认证与实时承诺**：没有 DAL/ASIL/SIL，也没有周期抖动保证；剖面的看门狗周期是**策略**，
   而且它是**剖面声明的一部分**（本层不提供运行期覆盖：改它 = 改这份数据并重新评审，而不是加一个命令行开关）。
6. **剖面的"意图"不是规划**：`goto` 不生成轨迹、`lane_keep` 不做横向控制、`cycle` 不做节拍编排 ——
   这些在域侧（或 `amos-ai` 的规划层）。本层负责把**意图与包线**变成可校验、可拒绝、可回程的事实。
7. **真机复核未做**：六个剖面在集成测试里逐条自检（执行器连续/行程/词表/唯一 Arm 与 Halt/包线可上报），
   两个域案例（无人机、车辆）真跑；没有一架真无人机、一辆真车被这套代码命令过。
8. **剖面的解析比参考机更严**：重复设定点与未知参数在剖面路径被拒，而参考机路径（`Vocabulary::Reference`，
   即 `RobotBridge::new` 用的那条）**逐字节冻结**，仍然按第一个设定点走、忽略不认识的 JSON 字段。
   两台"四足"于是有两种严格度：`Platform::quadruped()` 是"剖面的四足"，`Vocabulary::Reference` 是发货的四足。
9. **`duration_ms` 被携带但**不**参与规划**（与参考机一致：计划只由位姿与 speed 决定）——保持时间是任务层的事。
10. **一个 `Motion` 的 `targets` 可以只覆盖部分执行器**（参考机的既定语义，必须逐字保留：`trot` 的单个关节覆盖
    与手写 planner 逐字节相等）。对多旋翼/车这类需要**整组**动作的机器，域侧应把整组设定点当作一条命令 ——
    本层不替域决定"覆盖几个执行器才算完整"。
11. **`PlatformKind` 是闭集**：机器是数据（`Platform::from_parts` 会逐条校验），但**新域**仍是代码变更
    （要加一个 `PlatformKind` 变体与它的一行文档）。一个 6 轴 ±120° 的机械臂、一个八旋翼 —— 数据；
    潜水器 —— 代码。

## 7. 验证入口

```bash
# 剖面契约与安全语义（18 例，含"参考机逐字节不变"的等价证明、接受边界、自定义剖面校验）
cargo test -p amos-link --test platform_cases

# 两个域案例（真跑，离线）
cargo run -p amos-link --example uav_mission      # 未解锁拒绝 → 解锁 → 起飞 → 围栏内/外 → 看门狗 → 任务层飞 RTL
cargo run -p amos-link --example road_autonomy    # 50 ms 设定点流 → 越界拒绝 → 收油 → 看门狗 → MRM

# 参考机没有变（四足的既有契约）
cargo test -p amos-link --lib
cargo test -p amos-link --test robot_cases
```

