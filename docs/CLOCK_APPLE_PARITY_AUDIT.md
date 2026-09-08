# AmOS 时钟应用 — 与 iOS「时钟」App 对齐审计 + 补全报告

> 审计日期：2026-09-07
> 范围：`frontend-ts/src/svelte/ClockApp.svelte` + `frontend-ts/src/lib/time.ts` + i18n `clock.*`
> 方法：源码 + 纯 reducer / DOM 语义化审阅（非像素级）。实现单文件已用 vitest / bun / svelte-check 全绿验证。
> 结论先行：**四个 Tab（世界时钟 / 闹钟 / 秒表 / 计时器）齐备，方向正确；但对齐度约 75%。** 秒表已非常接近 iOS；闹钟缺「编辑已有闹钟」；计时器只能选 1/3/5 分钟预设、不能自设任意时长。本次已补全这两点，其余差距多为 OS 层或数据目录规模问题，另列为「诚实边界」。

---

## 1. 功能对齐矩阵（对 iOS 时钟 App）

| 能力 | iOS 时钟 | AmOS（审计前） | AmOS（本次补全后） | 备注 |
| --- | --- | --- | --- | --- |
| 四 Tab 结构 | ✅ | ✅ | ✅ | 世界时钟/闹钟/秒表/计时器 |
| 大字号 `tabular-nums` 时间 | ✅ | ✅ | ✅ | 接近 iOS |
| 世界时钟城市时区时间 | ✅ | ✅（12 预设，默认 4） | ✅ | 列表已扩至 12 座预设城市 |
| 城市搜索/海量目录 | ✅（数百城市可搜） | ❌ | ❌ | 诚实边界：仍无搜索 UI，仅 12 座预设 |
| 世界时钟时差/今天昨天标记 | ✅ | ❌ | ❌ | 诚实边界（未做偏移换算） |
| 添加/删除城市 | ✅ | ✅（仅能自动加下一座） | ✅ 可从 12 座任选添加 | 上限=目录长度 12 |
| 闹钟：新建（时/分/标签/重复/铃声） | ✅ | ✅ | ✅ | |
| 闹钟：启停开关 / 删除 / 换铃声 | ✅ | ✅ | ✅ | |
| 闹钟：**编辑已有闹钟** | ✅ | ❌ | ✅ 本次新增 | 点行进入编辑 → 保存/取消 |
| 闹钟：响铃提示 + 再响(贪睡) + 关闭 | ✅（iOS 内） | ✅（仅闹钟页可见） | ✅ 任意 Tab 页可见 | 见诚实边界①(仅 App 打开时) |
| 秒表：启/停/归零 | ✅ | ✅ | ✅ | |
| 秒表：计次 + 最快圈标注 | ✅ | ✅（★ 最快 + 每圈差） | ✅ | 每圈差/最快均有 |
| 计时器：预设 1/3/5 分钟 | — | ✅ | ✅ | |
| 计时器：**自设任意时长** | ✅（小时/分/秒滚轮） | ❌ | ✅ 本次新增 mm:ss 输入 | 上限 24h、秒 0–59 |
| 计时器：开始/暂停/继续/归零/到时提示 | ✅ | ✅ | ✅ | `time's up`/时间到 |
| 国际化 en/zh | — | ✅ | ✅ | |

> 说明：iOS 时钟另有「就寝/Sleep」不在「时钟」App 内（属于健康/睡眠），未纳入对比。

---

## 2. 做得很对、值得保留的部分 ✅

- **单源纯逻辑**：`lib/time.ts` 的 `stopwatchReducer` / `timerReducer` / `alarmsReducer` 全部 headless 可测，Svelte UI 只做接线与 1Hz/50ms 一个 interval —— 无自写定时器竞态，符合本仓库「纯逻辑 + DOM 测试」纪律。
- **持久化**：世界时钟 `amos.worldclock`、闹钟 `amos.alarms` 经 `writeStoreValue` 落地，`normalize*` 自愈旧数据。
- **世界时钟时区**：`zoneClock` 用 `Intl.DateTimeFormat` + per-zone 缓存，每个城市每秒重排不重建 formatter。
- **贪睡跨小时安全**：`snooze` 从真实 `Date` + `SNOOZE_MS` 计算再响，而非粗暴 `min+5`。
- **计次 delta / 最快圈**：`lapDeltas` + `fastestLap` 纯函数，行内 `(+Δ)` 与 ★ 标注接近 iOS 秒表。

---

## 3. 审计发现的主要差距（按优先级）

### 🟠 P1-A　闹钟不能编辑（已补全）
iOS 点任一行闹钟即进编辑页改时间/标签/重复；此前 AmOS 只能 启停/删除/换铃声。已补：
- `lib/time.ts` `alarmsReducer` 新增 **`update`** action：保留 `id/enabled/tone`，按 `add` 同规则清洗 hh:mm、重复日；编辑会把正在响的闹钟静音（新时间才是权威），清空重复日回退「每天」。
- `ClockApp.svelte`：闹钟行本身可点 → 载入编辑器（`editingId` 高亮该行、顶部「正在编辑闹钟」提示 + 取消），提交按钮「添加/保存」自动切换。
- i18n 增 `clock.editAlarm / saveAlarm / cancelEdit`（en/zh 同步）。

### 🟠 P1-B　计时器只能选 1/3/5 分钟（已补全）
iOS 计时器可滚到任意 hh:mm:ss。已补：快速预设保留（1/3/5），新增**自定义「分:秒」数字输入**（分钟 ≤1439、秒 0–59，≤24h），输入即时 `armTimer` → 大时间随之刷新；运行中禁用输入。`tArmMin/tArmSec` 与预设 chips 共享同一来源（按预设会同步输入框），避免两处状态打架。i18n 增 `clock.custom / clock.second`。

### 🟡 P2（审计时未决项；多数已由后续轮次落地——见 §6「OS 级到点提醒」、§7「铃声」）
1. **闹钟只在时钟 App 打开时响铃/到时**（诚实边界①）：`ringingAlarms` 只在 `ClockApp` 内出现；切走/关闭 App → 组件卸载 → interval 清掉。真·前台响铃/到点需要**全局 ticker + 通知/音频桥**（OS 调度层，参考 `amos-scheduler` 的 `AlarmExact`），属架构级工作而非该屏可闭环。
2. **世界时钟城市目录小**：仅 5 座预设、不可搜索、加满即无；没有「时差 / 今天昨天」副文本。要像 iOS 需更大 IANA 目录 + 搜索 UI + `Intl` 偏移换算。
3. **编辑交互细节**：iOS 是全屏编辑页 + 时间滚轮；本次用「行内编辑表单」近似（对齐能力而非像素交互）。
4. **铃声只是 emoji 标签、无任何声音**（`🔔⏰📯🎶` 仅作持久化 token 轮换）：曾完全不可播。已由 §7 补齐为「各 token 可听、音色各异（Web Audio 合成循环）+ 预留缺省铃声目录」。仍余：铃音是合成音而非打包音频文件、token 仍是 emoji 而非 SF Symbol 字形（见 `docs/UI_APPLE_HIG_AUDIT.md` 的 P0-1）。

---

## 4. 第一轮改动文件清单

| 文件 | 改动 |
| --- | --- |
| `frontend-ts/src/lib/time.ts` | `AlarmAction` 增 `update`；`alarmsReducer` 增 `update` 分支（保留身份、清洗、静音在响闹钟、清重复回退每天） |
| `frontend-ts/src/svelte/ClockApp.svelte` | 闹钟行可点编辑 + `editingId` + 保存/取消；计时器自定义 分:秒 输入 + `armTimer` 统一来源 |
| `frontend-ts/src/i18n/locales/zh.ts`、`en.ts` | 新增 `clock.custom / second / editAlarm / saveAlarm / cancelEdit` |
| `frontend-ts/src/__tests__/time.test.ts` | +4 纯 reducer 用例（update 保留身份/清洗/清重复回退/编辑静音在响闹钟并改在新点响） |
| `frontend-ts/svelte-tests/clock.svelte.test.ts` | +3 DOM 用例（点行编辑→保存原地改写、取消不改、计时器自定义 mm:ss + 预设） |

## 4.2　第二轮补全（追加）

针对审计第 3 节的 P2 剩余差距，追加三处组件内可闭环的改进：

| 文件 | 改动 |
| --- | --- |
| `frontend-ts/src/lib/time.ts` | 世界时钟目录 `WORLD_CITY_PRESETS` 扩至 **12 座**（巴黎/柏林/洛杉矶/新加坡/迪拜/孟买/芝加哥）；`WORLD_CITY_MAX` 改为动态等于目录长度，杜绝“加新城市静默淘汰最旧” |
| `frontend-ts/src/svelte/ClockApp.svelte` | 世界时钟「+ 城市」改为**下拉选择器 + 添加**（`wcPick`/`wcAvail`，任选一座未加入城市）；世界行加 `data-city` 便于测试；**响铃横幅移至 Tab 外层**——切到任何页都能看到响起的闹钟并「再响/关闭」 |
| `frontend-ts/src/i18n/locales/zh.ts`、`en.ts` | 新增 7 组城市名（巴黎/柏林/洛杉矶/新加坡/迪拜/孟买/芝加哥） |
| `frontend-ts/src/__tests__/time.test.ts` | 改写世界时钟 cap 用例以匹配新目录（扩至上限再多加一座 → 淘汰最旧、绝不超过上限） |
| `frontend-ts/svelte-tests/clock.svelte.test.ts` | +1 DOM 用例（选择器任选巴黎并添加、加后从候选中消失） |

> 说明：受 `<select>` 在 happy-dom 下 `bind:value` 更新不可靠的影响，选择器改用显式 `onchange`（与仓库 `InterpApp` 既有写法一致）。



---

## 5. 验证结果（全绿）

- 纯逻辑（bun）：`time` **34**、`alarmNotify` **5**、`ringtone` **10**、`worldDiff` **4**、`callTone` **4**、`timerStore` **5**、`cityIndex` **7**、`osAlarmWatcher` **3**、`osReminderWatcher` **3**、`osTimerWatcher` **3**（均 pass / 0 fail）。
- 时钟 DOM（vitest）：`clock.svelte.test.ts` **21 pass / 0 fail**。
- 全量 vitest：**286 pass**；`tsc --noEmit` 0 错误；`svelte-check` 0 错误 0 警告；bun 全量门禁 `[bun-iso] test OK`。

---

## 6. 第三轮补全（OS 级闹钟「到时/响铃」— 前端全局到达通知）

把「闹钟只在时钟 App 打开时才响」这一边界从架构级降为**「已部分落地」**。思路是完全镜像仓库里已验证的**到期提醒 OS 层机制**（`lib/reminderNotify.ts` + 壳内 `useDueReminderAlerts`），因为闹钟与提醒同属「持久化到 `amos.*` store、可由壳级服务跨屏读取」的域。

新增 `lib/alarmNotify.ts`（新，React-free 纯逻辑 + React hook）：
- 与 ClockApp 共用同一 `amos.alarms` store。差异在闹钟**可重复**：去重标记按 `id|HH:MM` 且**按自然日（日期）**记账，所以每日闹钟次日会再响、被编辑/贪睡到新时刻会在新点响、同一天绝不重复派发。
- `collectDueRings`/`markRung`/`pruneRung`/`ringsToNotifs`（纯）+ `syncDueAlarmAlerts`（副作用，幂等）+ `useDueAlarmAlerts(activeAppId)`（壳级钩子）。
- 到点动作：向 `amos.notifications` 推**一条**闹钟 App 通知（到达横幅 + 依据生效声音策略的提示音，均走既有全局层）+ **把该闹钟写为 `ringing:true`**，让之后打开时钟页能看到仍活跃的「再响/关闭」响铃。
- **抑制规则**：当前台聚焦 App 是「时钟」本身时不派发（它自己屏内已在响），避免重复。
- 接线：`src/App.tsx` `Shell()` 内紧邻 `useDueReminderAlerts(active)` 挂载 `useDueAlarmAlerts(active)`——系统 UI 存活期间，无论时钟 App 开没开都会到点提醒。

> 说明：本仓库「按时到期提醒」的既有形态就是**到达通知**（banner+badge+一次提示音），不是原生那种持续循环响铃；开启 App 清除角标并展示活跃响铃以「再响/关闭」。为与 ClockApp 共享同一份 `amos.alarms`（避免双响/互相覆盖），未在 `alarmNotify` 内另起一套 `ringing` 判断，而是直接复用/回写 ClockApp 持久化的 `ringing` 标记。

### 诚实边界（仍未覆盖，需原生）
- **整机息屏 / OS 进程被杀时仍不响**：前端 WebView 层做不到，需原生 `amos-scheduler AlarmExact` + 前端→Rust 调度桥（现无现成桥，属新后端工作）。
- 到达提示音遵循「通知到达」生效声音策略（免打扰 DND 可静音提示音，横幅仍显示）——闹钟若要无视 DND 需另建策略。
- 在另一屏上停留时是**一次到达提醒**，非持续循环响铃；持续响铃/就地「再响/关闭」由时钟屏承载。

---

## 7. 第四轮补全（铃声：真正可听 + 缺省文件目录）

**审计结论（对“铃声是否准备好 / 有无缺省目录”两问）**：
- 铃声此前**未准备好**：闹钟的“铃声”只是 `ALARM_TONES=["🔔","⏰","📯","🎶"]` 这 4 个 emoji **持久化 token**，只能轮换显示、不可播放；全仓库唯一音频文件是 ASR 测试用的 `models/sherpa-en-20m/test_wavs/0.wav`。
- 此前**没有存储铃声的缺省目录**：`frontend-ts/public/` 只有 `wallpapers/`。

**本轮补全**（保持仓库「免打包音频、Web Audio 合成」取向）：

| 文件 | 说明 |
| --- | --- |
| `src/lib/ringtone.ts`（新） | 把 emoji token 映射到 4 个稳定音色 id（bell/alarm/bugle/melody）；`makeToneSamples(token)` 纯函数为每种音色合成一段**各自不同、可循环**的短旋律（无头可测）；`RINGTONE_DIR`/`RINGTONE_FILE_BY_ID` 定义缺省目录与文件命名约定 |
| `src/lib/ringtonePlayer.ts`（新） | `startAlarmRing(token)`：把样本放进 `AudioBufferSourceNode.loop` **循环播放**直到 `stopAlarmRing()`；SSR/无头无 AudioContext 时安全空转 |
| `src/svelte/ClockApp.svelte` | 响铃开始时**真正循环播放**所选项铃音；全部关闭/离开屏幕即停（`onDestroy`） |
| `public/sounds/ringtones/`（新，后由 `scripts/gen-ringtones.mjs` 填充） | **缺省铃声存储目录**：现含 4 个真实 `.wav`（bell/alarm/bugle/melody，由脚本确定性生成）+ `README.md` + `.gitkeep` |
| `src/__tests__/ringtone.test.ts` | **6 例**：token→id/文件映射、未知 token 回落、缺省目录解析、`makeToneSamples` 纯函数（有限/钳制/非静音/四种互异/回落）、player 无音频安全空转 + 桩 AudioContext 下 start(loop)→替换→stop 生命周期 |

**第六轮补全（铃声选择 + 试听 + 真实音频文件，2026-09-07 追加）**：上述“仍余”的「合成音/空目录」缺口已闭合——(a) 用 `scripts/gen-ringtones.mjs`（确定性生成、可复现）把 **4 个真实 `.wav`** 写入缺省目录：`public/sounds/ringtones/{bell,alarm,bugle,melody}.wav`（mono 16-bit PCM，各 ≈94KB）；(b) `ringtonePlayer` 升级为**文件优先、合成回退**双引擎（`setRingtoneFilesEnabled`；浏览器/WebView 用真实文件循环/试听，无文件时自动回落合成）；(c) 闹钟编辑器新增**铃声选择 + 试听**：4 个音色 chip（点选即预览）+「试听」钮；`alarmReducer` 的 `add`/`update` 均携带 `tone`（改铃声、无效 token 忽略）；ClockApp 在真实浏览器里自动启用文件音。(d) 测试：`time` +2（add/edit 存 tone、无效忽略）、`ringtone` +4（文件引擎开关、preview 安全空转、文件开启无音频回退不崩、**4 个真实文件在盘**）、`clock.svelte` +1（选 ⏰ → 保存后持久化 tone）。

**仍余（诚实边界）**：token 仍是 emoji 而非 SF Symbol 字形（`UI_APPLE_HIG_AUDIT.md` P0-1，视觉项）。


---

## 8. 第五轮补全（世界时钟：每城「时差 + 今天/明天/昨天」副文本）

补齐 iOS 世界时钟行下的相对信息行。此前每城只显示时区时间、没有“比本地快/慢几小时、那边已今天还是明天”的语境，跨时区很易误读。

- `lib/time.ts`：新增**宿主无关**的纯函数——`zoneUtcOffsetMinutes(d,tz)`（读 IANA 真实偏移，含夏令时）、`zoneDiff(baseTz,tz,d)`（返回 `aheadMinutes` + `dayDelta`，比任意两显式时区，不依赖宿主时区，因而可确定地单测）、`fmtOffsetMinutes`、`systemTimeZone`；内部用 `Intl.DateTimeFormat` parts 缓存，处理“24 点”午夜边界。
- `ClockApp.svelte`：每行城市新增 `<div data-zone-sub>` 副文本，例：`明天 · 快 16 小时` / `同时` / `昨天 · 慢 8 小时`（日期超前即前加「明天/昨天」）。
- i18n：`clock.dayToday/dayTomorrow/dayYesterday/zoneSame/zoneAhead/zoneBehind`（en/zh）。
- 测试：`src/__tests__/worldDiff.test.ts` **4 例**（真实偏移含 DST、两时区间 ahead+day、半时区格式、宿主区可测性）；`clock.svelte.test.ts` **+1 例**（每行都有非空副文本，命中 快/慢/同时/明天/昨天）。

仍余：世界时钟**海量可搜索城市目录**未做（现 12 预设 + 下拉选择），见 §9 Roadmap。

---

## 9. 若需再进一步（Roadmap 建议）
1. 让时钟「到时/响铃」在 **系统进程也被杀/息屏**时仍生效：把 `alarmNotify` 的判定交给原生 `amos-scheduler AlarmExact`，前端仅消费其到点事件（属 Rust 桥接工作；前端层到达提醒已由第三轮落地）。
2. 世界时钟扩为**真·海量可搜索目录 + 按首字母浏览**（现为 18 预设 + 下拉/搜索过滤；时差/今天昨天副文本已在第五轮落地）。
3. 闹钟编辑改为 iOS 式全屏 + 时间滚轮（视觉层）。

---

## 附　第七轮补全（世界时钟排序 + 秒表最慢圈，2026-09-07）

- **世界时钟可排序**（iOS 世界时钟可拖动重排城市）：`lib/time.ts` 新增纯函数 `moveWorldCity(list, from, to)`（越界夹取、同下标/NaN 原样返回）；`ClockApp` 编辑模式每行加 ▲/▼ 上移/下移（端点自动禁用），移动即持久化到 `amos.worldclock`。i18n `clock.moveUp/moveDown`。
- **秒表标注最慢圈**（iOS 秒表最快绿、最慢红）：`lib/time.ts` 新增 `slowestLap`；圈列表对最慢圈加红色 + `●`（最快仍绿色 `★`）。
- 测试：`time.test` **+2**（slowestLap 索引、moveWorldCity 重排/夹取/幂等）；`clock.svelte` **+1**（编辑模式移动首城 → 新顺序 + 持久化 + 端点按钮禁用）。
- 说明：受「WAV vs MP3/M4R」提问启发——**iOS 铃声是 `.m4r`（AAC/MP4），不是 WAV 也不是 MP3**；本工程播放层 `<audio>`/WebAudio 格式无关，当前用 WAV 资产，后续要“苹果式省空间”可换 `.m4r`/`.mp3`（纯 Node 离线编码需 ffmpeg 类编码器）。
- **闹钟列表按时间排序**（iOS 闹钟最早在前）：`lib/time.ts` 新增 `alarmsByTime`（稳定、返回副本、不改输入/存储序）；`ClockApp` 展示层用其渲染，持久化顺序不变。测试：`time` +1（稳定最早在前、输入不变、平局保留身份）、`clock.svelte` +1（先加 08:00 再加 06:00 → 列表仍 06:00 在上、共 2 个）。
- **世界时钟：目录扩至 18 座 + 可搜索**（§9 ① 的部分落地）：`WORLD_CITY_PRESETS` +6（曼谷/首尔/罗马/多伦多/墨西哥城/奥克兰，均 i18n）；添加区新增「搜索城市」输入，实时按**本地化名称或 IANA 时区**过滤下拉选项，加号在当前筛选下添加（命中即选定、无命中禁用）。i18n `clock.city.*` 6 组 + `clock.searchCity`。测试：`clock.svelte` +1（输入「罗马」→ 仅剩 Europe/Rome 一项 → 添加成功）。仍余「真·海量 + 按首字母浏览」见 §9。
- **闹钟时间 −/+ 步进（环绕）**（§9 ② 的轻量版）：编辑器保留数字输入，另给「时 / 分」各加 ▲/▼ 步进（时 0–23、分 0–59 各自环绕），`stepAlHour/stepAlMin` 纯增量环绕。测试：`clock.svelte` +1（8:00 → 分 +1=01、时 +3=11；23:59 时 +1→00:59；00:00 分 −1→59）。仍余 iOS 全屏滚轮视觉层见 §9。
- **闹钟重复快捷预设**：`lib/time.ts` 导出 `WEEKDAYS=[1..5]` / `WEEKENDS=[0,6]`；编辑器在逐日 chip 下新增「工作日 / 周末 / 每天」一键（含 aria-pressed 状态）。测试：`clock.svelte` +1（点「工作日」→ 保存后持久化 `repeat=[1,2,3,4,5]`）。
- **响铃屏幕动画 + ringing 续传修复**：`ClockApp` 把原静态红条升级为**带动画的响铃卡片**（铃铛 `ringPulse` 脉冲 + 卡片 `ringShake` 微抖 + `ringGlow` 光晕 + 背景 `ringFlash` 呼吸闪红，含暗色配色；`role=alert`/`aria-live`），仍在任意 Tab 可见并保留 再响/关闭。**修复一个真实缺陷**：此前挂载用 `normalizeAlarms` 会抹掉 store 里持久化的 `ringing:true`，导致 OS 到点通知写的 ringing 在**重开时钟页时丢失、不显示“还在响”**——现改为种子时恢复 ringing。测试：`clock.svelte` +1（预置 ringing 闹钟挂载 → 出现 `data-testid=alarm-ring` 动画区并含时间/标签/再响 → 点「关闭」后消失且 store 置 ringing=false）。
- **铃声资产切 MP3 播放**：`RINGTONE_BY_TOKEN`/`RINGTONE_FILE_BY_ID` 现指向 `*.mp3`（每首 ~5–8KB，WebView/`<audio>` 直接解码循环；较 WAV ~94KB 省 ~10 倍）；`.wav` 保留为可再编辑源。`scripts/gen-ringtones-mp3.mjs`（ffmpeg，已用本机 ffmpeg 8.1 生成）可复现。测试：`ringtone.test` 更新为断言「映射为 .mp3 + mp3 与 wav 源均在盘」。
- **拨打电话页/来电也改用 MP3**：新增 `lib/callTone.ts`（共享 `<audio>` 循环播放、`playRingback`/`playIncomingRing`/`stopCallTone`，离线安全 no-op）；`PhoneApp` 拨号等待音与 `IncomingCall` 来电振铃由原 `AudioContext` 合成音改为播真实 MP3；资产在 `public/sounds/phone/{ringback,incoming}.mp3`。测试：`callTone` **4**（目录映射 / 无音频安全 / 桩 Audio 走 mp3+停止 / mp3 文件在盘）。
- **计时器到时也出声/响屏**：`lib/time.ts` 新增纯函数 `risingEdge`（可测的上升沿，一次性瞬态提示用）；`ClockApp` 在 `timerDone` 上升沿用 `playNotifyTone()`（独立 AudioContext，不与闹钟响铃冲突）播一声，并把“时间到”提示升级为**脉冲动画**（`data-testid=timer-done`，`timerDonePulse` keyframes）。测试：`time` +1（risingEdge 仅 false→true 触发、不重复）。
- **计时器 OS 级到时提醒（App 未打开也能响）**：倒计时落 store + OS notifier，与闹钟同机制。新增 `lib/timerStore.ts`（React-free：`normalizeTimer/readTimer/writeTimer/persistFromTimer/restoreTimerState/pollTimer`，`amos.timer` 持 running+`endAtMs` 墙钟，`pollTimer` 到点一次性触发并停 running）+ `lib/timerNotify.ts`（React 钩子 `useDueTimerAlerts`，挂进壳，Clock App 打开时抑制防重复）。`ClockApp` 挂载从 store 恢复运行中的倒计时、每次变更持久化。测试：`timerStore` **4**（normalize/恢复未来·不恢复已过/持久化 re-arm/poll 一次性触发）；`clock.svelte` **+2**（设定后持久化 total、启动后持久化 running+endAt&gt;now）。
- **世界时钟接入更大目录（cityIndex）+ 双语持久化**：`time.ts` 的 `WorldCity` 增可选 `name{zh,en}`（额外城市用空 `labelKey` + `name`）、`WORLD_CITY_MAX` 放宽到 30、`normalizeWorldCities` 保留带合法 `name` 的非预设城市（仍丢垃圾、去重、限长）；`ClockApp` 用 `wcLabel(c)` 显示（有 name 按当前 locale，否则 `t(labelKey)`），候选=预设未加 + `cityIndex`(51) 未加（去重），`addPickedCity` 支持加 name 城市并持久化。测试：`time` +2（name 城市 normalize/丢弃垃圾；可加与 cap 有界）、`cityIndex` **7**（数据/搜索纯函数）、`clock.svelte` +1（搜「香港」添加 → `data-city=Asia/Hong_Kong` 出现且持久化 `name{zh,en}`）。
- **§9 ③ 原生部分落地**：新增 `amos-scheduler::ExactAlarmClock`（纯 `std` 精确墙钟 fire-once 账本：`register/due/next_at/cancel`，时钟可注入；`due` 到点一次性移除、`next_at` 供宿主“睡到何时唤醒”），导出 `pub use`；`cargo test -p amos-scheduler` 12+1、clippy `-D warnings`、fmt 全绿。**Tauri 命令已落地**（`amos-tauri` 新增 `alarm_sched.rs`：进程共享态 `AlarmSchedState` 包 `ExactAlarmClock`，`scheduler_alarm_register/cancel/poll` 已入 `invoke_handler` 与 `.manage`；`cargo test -p amos-tauri --lib alarm_sched::` 3 通过、clippy 0）。**前端桥封装已落地**：`lib/time.ts` 新增 `nextAlarmAtMs`（下次合法到点 epoch-ms）；`lib/backend.ts` 新增 `registerNativeAlarm/cancelNativeAlarm/pollNativeAlarms`（离线安全 no-op）；`lib/alarmNotify.ts` 在到点后把该闹钟的**下次到点**经 `nextArmments` 注册给原生（fire-and-forget）。测试：`time` +1（nextAlarmAtMs：今日未到→今日、已过→明日、工作日只在允许日）、`alarmNotify` +1（nextArmments 只计划启用闹钟的下次到点）。设备侧（Android `AlarmManager` 深度唤醒进程被杀）仍未落地——见 `docs/native-alarm-bridge.md`（诚实边界：真机 AlarmManager 需真机验收，本环境未验证）。
