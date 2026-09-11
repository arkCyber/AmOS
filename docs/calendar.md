# 日历（Calendar）— iOS 对齐实现说明

> 应用 id：`calendar`（第 25 个内置应用）· 图标 `📅` · App Library 归类 `productivity`
> 设计目标：对齐苹果手机「日历」App 的**能力**（月视图 / 日程 / 多日历彩色区分 / 全天 / 重复 /
> 提前提醒），并沿用本仓库「纯逻辑内核 + DOM 接线 + 单一事实源 + 诚实边界」的工程纪律。
> 非审定软件：本文所述实现为研究/原型级，不构成 DO-178C 或任何适航/任务安全标准的合格证明。

---

## 1. 分层与单一事实源

| 层 | 文件 | 职责 |
|---|---|---|
| 领域内核（纯） | `src/lib/calendar.ts` | 类型、本地时区日期运算、月网格、**周网格（区域首周日起）**、**有界重复展开**、选择器、CRUD、坏档归一化、种子 |
| OS 提醒（纯 + 薄副作用） | `src/lib/calendarCore.ts` | 到点提醒的判定、去重标记、通知构造、`syncDueEventAlerts` 协调 |
| 调度器 | `src/svelte/osCalendarWatcher.ts` | 15 s 轮询 + 存储变更即触发；聚焦「日历」时抑制 |
| 界面 | `src/svelte/CalendarApp.svelte` | **月/周/日程三视图**、月历网格、周分区、日程行、搜索、日历管理、事件编辑器 |
| 注册（三处单源） | `src/lib/appMeta.ts`（id→标题键/图标）、`src/svelte/appRegistry.ts`（id→Svelte 屏）、`src/lib/appGroups.ts`（分类） | 图标/标题/加载器/分组 |
| 文案 | `src/i18n/locales/{zh,en}.ts` | `app.calendar` + `calendar.*`（中英键奇偶由 `i18n.test.ts` 强制） |

**持久化契约**（经共享 `amos.*` store：localStorage + `window.Amos` 桥 + 跨窗口广播）：

| key | 内容 |
|---|---|
| `amos.calendar` | `CalendarEvent[]`（上限 `EVENT_CAP = 1000`，保留最新） |
| `amos.calendars` | `CalendarGroup[]`（彩色日历；`enabled=false` = 隐藏） |
| `amos.calendarFired` | `Record<"事件id@场次开始", 场次开始>`（提醒去重标记，随窗口有界回收） |

`normalizeEvents` / `normalizeCalendars` 在**任何读取路径**先跑：空白标题丢弃、id 去重、
倒置/缺失区间修正（定长 ≥ 1 分钟）、全天吸附本地午夜且恰好一天、`repeat`/`alertMinutes`/颜色
白名单回退、非数组输入 → 空表。坏档不会删除用户数据：`amosStore` 会把原始字节隔离备份到
`<key>.corrupt` 并告警（沿用 P1-1）。

---

## 2. 与 iOS「日历」的能力对齐矩阵

| 能力 | iOS | AmOS | 说明 |
|---|---|---|---|
| 多日历 + 每日历颜色 | ✅ | ✅ | 10 色 iOS 式调色板；显示/隐藏开关（勾选） |
| 月视图（6×7 固定网格） | ✅ | ✅ | 周日开头（`weekStartsOn=0`），非本月日期淡显 |
| 「今天」高亮 + 一键回到今天 | ✅ | ✅ | 今日红字 + `今天` 按钮（同时回到本月） |
| 某日日程列表 | ✅ | ✅ | 点选日期 → 下方列出当日场次，**全天在前**，再按时间/标题 |
| 日程（列表）视图 | ✅ | ✅ | 未来 60 天按天分组（重复事件按场次展开） |
| 周视图（7 日分区） | ✅ | ✅ | 区域首周日起的 7 个本地日分区（`startOfWeek`/`weekDays`，与月网格同一规则）；每日列出当日场次；‹ › **按周翻**、「今天」回到本周 |
| 新建/编辑/删除事件 | ✅ | ✅ | 底部编辑器：标题、全天、起止、所属日历、重复、提醒、地点、备注 |
| 全天事件 | ✅ | ✅ | 吸附本地午夜；起/止**日期**含末日，跨度 = 整数个本地日 |
| 全天事件**跨多天**（年假/出差） | ✅ | ✅ | 编辑器给出「结束」日期；月历在**覆盖的每一天**都打点；日程列表在每一天都出现 |
| 跨午夜/多天定时事件 | ✅ | ✅ | 按天出现；后续日期显示 `→ HH:MM`（当天结束时刻）或「延续」，**不显示昨天的开始时间** |
| 首周日跟随区域 | ✅（区域设置） | ✅ | zh-CN 周一起、en-US 周日起（本仓库仅支持 zh/en 两语言） |
| 重复事件 | ✅（含自定义间隔/结束条件） | 🟡 **有界子集** | `不重复/每天/每周/每月/每年`，间隔恒为 1，无 `COUNT/UNTIL/EXDATE` |
| 提前提醒 | ✅ | ✅ | `无 / 日程开始时 / 5·15·30 分钟 / 1·2 小时 / 1 天` 前 |
| 搜索日程 | ✅ | ✅ | 标题 + 地点 + 备注，大小写不敏感 |
| 月/周/日程视图切换 | ✅ | ✅ | **月 + 周 + 日程**三视图；年/日视图未实现 |
| 邀请参与人 / 附件 / 时区独立事件 | ✅ | ❌ | 诚实边界（需账户/服务端能力） |
| 系统级到点提醒（含进程被杀） | ✅ | 🟡 | 进程存活期内可靠（15 min Grace）；**被杀/关机不唤醒**，需原生 `AlarmManager` 深唤醒（另案，参考 `amos-scheduler::ExactAlarmClock`） |

---

## 3. 日期与重复的确定性约定

- **一律本地时区、`Date` 基准**（非裸毫秒相加）：`addDays` 用 `setDate`（跨 DST 保持墙钟时间），
  `addMonths` 用「先取 1 号再设月再夹取日」实现 `1/31 → 2/28`（闰年 `2/29`）。
- `monthGrid(anchor, weekStartsOn)` 恒返回 **42** 个本地午夜戳（含前置/后置补白），
  因此月历布局与渲染无「5 行/6 行跳动」的抖动。
- `startOfWeek(ms, weekStartsOn)` / `weekDays(anchor, weekStartsOn)` 用**与月历同一**的
  `weekStartsOn` 推出所在周的 7 个本地午夜：`back = (getDay() − weekStartsOn + 7) % 7`，
  逐日走 `addDays`（非裸毫秒）——DST 的 23h/25h 日仍算**一天**，周视图因此恒为 7 格、不漂移；
  两个视图不可能对「一周从哪天开始」产生分歧（单一区域规则）。
- **重复展开** `expandOccurrences(event, from, to)`：
  1. `repeat="none"` → 仅当 `[startAt,endAt)` 与 `[from,to)` 相交（半开区间）；
  2. 否则按 `shiftOccurrence(base, repeat, k)` 生成第 `k` 场（日 +k 天 / 周 +7k 天 / 月 +k 月 / 年 +12k 月），
     持续时间 `endAt-startAt` 逐场保持；
  3. **快进**：一场事件与 `[from,to)` 相交当且仅当 `startAt > from - dur`，因此当 `from - dur` 远在事件起点之后时，
     按 `MAX_STEP_MS`（各重复周期的**上界**：日 `25h`、周 `7d+1h`、月 `31d+1h`、年 `366d+1h`，含 DST 与闰年余量）估算首个可能相交的 `k`，
     避免从创建日逐场迭代（10 年日重复查询仍是一次 `Date` 运算）。**上界**是关键：估算值只会落在首个相交场次**之前**，
     绝不越过它——此前用 `from` 加近似步长（月按 30 天）会**越过**并静默丢掉长于一个周期的重复事件的场次
     （如 20 天长的周重复在单日窗口里会少一场），见 `calendar.test.ts` 的 `a repeat longer than its period …`；
  4. **有界**：`MAX_OCCURRENCES_PER_EVENT = 2000` 与「`startAt ≥ to` 即 break」双保险，
     病态/损坏的重复行不可能让查询无界循环。
- 区间语义：`startAt < to && endAt > from`（两端半开）。零宽查询返回空，不产生「幽灵场次」。
- **全天事件**的持久化约定：`startAt` = 首日本地午夜，`endAt` = **末日的次日**午夜（半开）。
  归一化用 `allDayEnd(startAt, endRaw)`：已是午夜的 `endRaw` **原样保留**（因此归一化是幂等的，
  重复加载不会把跨度越滚越大），非午夜的值向上吸附到次日午夜（把它当作「含末日」的输入），
  早于 `startAt` 则收敛为单日。编辑器显示的是**含末日的最后一天**，提交时 `+1 天` 转回半开。
- **日历日窗口用日期运算而非 `+ 86_400_000`**：`occurrencesOnDay` 的窗口是
  `[startOfDay(d), addDays(startOfDay(d), 1))`。在夏令时切换日，一个本地日是 23 或 25 小时，
  裸毫秒相加会把窗口挪到 01:00 而把**次日**的全天事件错算到今天（`atLocalTime` 同理，用
  `setHours` 而非毫秒加法）。该性质在任意时区成立，测试在无 DST 时区是恒真的断言、
  在有 DST 时区则真正守护该行为。
- **月历圆点**用 `occurrencesByDay(list, from, to)`：把发生次数登记到它**覆盖的每一天**
  （多天事件因此每天都有点），并且只在 `[from, to)` 内游走 —— 病态长跨度不会无界循环。
  日程（列表）视图仍用 `groupByDay`（按**开始日**归档，与 iOS 列表一致）。
- **多天事件的当日标签**：`isContinuation(occ, day)` 判定「这天不是它的开始日」，UI 于是显示
  `→ HH:MM`（当天结束）或「延续/Continued」，绝不显示属于昨天的开始时间；`spansDays(occ)`
  驱动行内的 `起 – 止` 跨度标签。
- **编辑重复日程：所见即所点，且序列不被漂移**。编辑器显示的是**用户点开的那一场**（`occ.startAt`）
  的日期/时刻——不是序列锚点。此前 `openEdit` 用 `event.startAt` 播种，于是点开「今天」的日常重复
  场次，编辑器却显示**昨天**（序列创建日）的日期（真机 S5 实测复现，见 §5）。提交时用
  `shiftByWallClock(base, from, to)`（`countDays` 整日 + 分钟差，**绝不裸毫秒**）把草稿相对该场次的
  位移**同等地施加到序列锚点**上：日期差走 `addDays`（DST 安全），时刻差按分钟。`from === to`
  返回**逐位相同**的原值，因此「只改标题/备注」不会让序列漂移一秒，非重复事件（`occ === anchor`）
  行为完全不变。编辑器另显示「重复日程：保存将修改整条序列」，把「整条序列编辑」这一诚实边界
  摆在用户眼前。

---

## 4. OS 级到点提醒的语义

`collectDueEventAlerts(events, groups, fired, now, opts)`：

1. 先 `visibleEvents`：**隐藏的日历静音**（勾掉即不提醒）；
2. 在 `[now − 8d, now + 8d]` 内有界展开场次；
3. 对每个场次算 `alertAt = startAt − alertMinutes·60s`，只取
   `now − ALERT_GRACE_MS ≤ alertAt ≤ now`（`ALERT_GRACE_MS = 15 min`）；
4. 跳过 `alertMinutes == null` 与 `fired["id@start"] === start`（**幂等**，重复事件每场一次）；
5. 按 `alertAt` 升序，单批上限 `ALERT_BATCH_CAP = 40`。

`syncDueEventAlerts` 把命中项写入 `amos.notifications`（`id = "cal:<id>@<start>"`，
标题 = `HH:MM 标题`，全天不加时间前缀，>60 字截断），并写回去重标记；`pruneFired` 回收
超出 8 天窗口的旧标记，保证标记表有界且**不覆盖用户数据**。

**健壮性**：写入前对既有通知列表跑 `normalizeNotifs`。此前的写法是直接展开存储值，若
`amos.notifications` 被写成非数组（损坏/被外部写坏），展开会**每次协调都抛异常**，而异常发生在
写标记之前 —— 结果是**日历（以及提醒事项）的到点通知永久静默失效**。归一化把该情形修复为
空表并继续投递；`reminderCore.ts` 的同类缺陷一并修复（`__tests__/calendarCore.test.ts`、
`__tests__/reminderNotify.test.ts` 各有一条回归用例，且已用 `[...{}]` 实测确认旧行为确会抛错）。

Shell 侧 `osCalendarWatcher`：每 15 s + 任一相关 key 变更触发；当前聚焦面是 `calendar` 时
**不发**（事件已在屏上），离开后的下一次协调会照常投递（与 reminders/alarms/timer 一致）。

---

## 5. 测试与门禁

| 文件 | 例数 | 覆盖要点 |
|---|---|---|
| `src/__tests__/calendar.test.ts` | **50** | 日期运算/月末夹取/42 格网格/**`startOfWeek`+`weekDays` 区域首周日与 DST 安全 7 日**/**`shiftByWallClock` 墙钟位移（含恒等无操作）**/`fromDateAndTime` 非法日期、坏档归一化与封顶、重复展开（含快进、月夹取、顺序、半开区间、不变异输入、**长于一个周期的重复事件不丢场次**）、选择器与搜索、CRUD/上限/身份保持、日历组保护默认项、孤儿回落、种子自洽、**多天全天跨度与幂等归一化**、**DST 安全的本地日窗口**、**`occurrencesByDay` 跨天打点与窗口裁剪**、`isContinuation/spansDays`、**独立暴力参考交叉验证（2000 例随机重复/窗口）** |
| `src/__tests__/calendarCore.test.ts` | **16** | 标记归一化/`alertKey`/`markFired`/`pruneFired`、到点与提前提醒、Grace 边界、隐藏日历与无提醒跳过、重复每场一次、排序与批量上限、通知构造/截断、store 往返 + 幂等 + 损坏值不抛错 + **通知表坏档被修复而非卡死管线** |
| `svelte-tests/calendar.svelte.test.ts` | **36** | 42 格与唯一「今日」、选中日顺序（全天在前）、切换日期、空态、翻月/今天、建/改/删与持久化、空白标题不可存、全天开关切换时间/日期控件、**多天全天跨度创建（含末日）**、**多天事件逐日打点与延续标签**、非法日期拒绝、取消不落库、搜索与计数、视图切换、**周视图（7 分区/区域首周日/按周翻与今天回归/周一事件在列）**、**重复场次编辑（编辑器显示所点半场次的日期、序列锚点不被漂移、改时刻按墙钟位移重新锚定、非重复事件行为不变）**、日历新建/隐藏/删除回落、观察器聚焦抑制与非聚焦投递且幂等、**zh 周一起 / en 周日起** |
| `svelte-tests/shell.svelte.test.ts` | **+1** | **真实集成**：`open("calendar")` → Shell 经 `appRegistry` 动态 import 并真正挂载日历屏（断言 42 个日格） |
| `src/__tests__/reminderNotify.test.ts` | **+1** | 提醒管线遇通知表坏档同样被修复（同一缺陷的姊妹用例） |

门禁：`bun run check`（pure **948** 例 / 97 文件 + `test:svelte` **467** 例 / 59 文件 + `tsc` +
`svelte-check` + i18n 中英奇偶）**EXIT=0**；`bun run coverage:gate` 聚合 `src/lib` **93.84% ≥ 90%**，
其中 `calendar.ts` **432/432** 与 `calendarCore.ts` **94/94** 被插桩行**全部执行**
（100%：`coverage/lcov.info` 内这两条记录无 `DA:*,0`）；`bun run smoke:ui`
（生产构建 + 真实 headless Chrome 加载主屏）**4/4 PASS**。

**独立验证（可复现证据）**：`calendar.test.ts` 内的「独立暴力参考」用例用**固定种子 PRNG** 生成 **2000** 组随机
（重复类型 × 2000–2040 基准 × 0–40 天时长 × 0–1000 天窗口），与**不设快进、不设上限**的朴素枚举逐场全等比对
（`toEqual`）——把「重复展开绝不丢场次」这条性质变成**可回归**的检查，而非一次性审计；另有一次性的
**30 000 例**扩展交叉比对（更宽的基准/时长/窗口谱）得 **0 处不一致**，`normalize*` 幂等性与
`occurrencesByDay` 逐日暴力判定另做 **20 000 + 4 000 例**、亦 **0 处不一致**（见 §8 审计变更记录）。

---

## 6. 诚实边界（不假装已对齐）

1. **无年/日视图、无拖拽移动事件、月历无跨天横条**：周视图已实现为**7 日分区列表**（每日列出当日场次），
   并非 iOS 的小时时间轴网格；月历仍用「每格最多 3 个圆点」表达——多天事件
   会在覆盖的每一天都打点（已修正），但仍不是 iOS 的连续横条；日程（列表）视图按**起始日**归档
   （与 iOS 列表一致），所以一条 3 天年假在列表里只出现一次。
2. **重复是 RRULE 的有界子集**：无自定义间隔、无「结束于/重复 N 次」、无排除日；编辑重复事件即
   编辑整条序列（不做 iOS 的「仅此事件/未来所有事件」拆分）。
3. **提醒是前台协调器**：进程被杀/设备关机时不会唤醒（无原生 `AlarmManager` 深唤醒）；
   Grace（15 分钟）之外的漏提醒会被丢弃而非补发。
4. **无账户/共享日历/参与人/附件/时区独立事件**：这些需要服务端或系统日历数据源，当前数据
   完全本地（`amos.*` store）。
5. **搜索是本地子串匹配**：无 iOS 的自然语言/索引搜索。
6. **首周日只按语言而非完整区域推断**：仅支持 zh/en，因此用 `locale === "zh" → 周一` 的映射；
   真正的 `Intl.Locale.weekInfo` 在旧 WebView 上不可用。
7. **真机验收：语义层已完成，像素层未做**：已在 **S5 / Android 14** 上用 `uiautomator` 读取 WebView
   无障碍文本，确认真机日历渲染**正确日期**（标题 `2026年9月`、周一开头星期表头、42 格
   `8月31日…10月11日`、今日高亮、每日 `N 个日程`）——并**由此发现并修复**了「编辑重复场次显示
   序列锚点日期」的真实缺陷（§3）。**仍非像素级**：未做逐像素/配色/字号/滚动验收，也未覆盖 iOS 与
   `docs/device-bring-up.md` 的全量流程。

---

## 7. 追溯

- 需求：`docs/TRACEABILITY_MATRIX.md` **REQ-A29**（实现 → 验证 → 状态一栏对应本文 §5）。
- 审计变更记录：`docs/AEROSPACE_SOFTWARE_AUDIT.md` §8 对应行。
- 变更日志：`CHANGELOG.md` `[Unreleased] → Added`。
- iOS 对齐总表：`docs/ios-parity-audit-status.md`。
