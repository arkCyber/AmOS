# AmOS Frontend A11y Audit (REQ-A282 → REQ-A283)

> 状态: 第一刀扫描完成,缺口已枚举;**P0 的两把刀已按 REQ-A283 补完第一把(label-field-association,
> 14 → 0),第二把(live-region,18)/第三把(focus-visible,47)仍**未**修 —— 见 §3.1.5 / §6。
> 方法: `scripts/a11y-scan.mjs` 启发式扫描 + DOM 级实测(`svelte-tests/settings-a11y.svelte.test.ts`)
> + 人工分桶(严重性/真信号/误报)。
> 底线: a11y 缺口的影响面 = 用键盘 / 屏幕阅读器的用户根本无法用,所以即使是误报上限也按"先补再说"——但补哪条按严重性,不是按发现数。

> **本文件是人工判断报告;扫描器的最新数据表见** `node scripts/a11y-scan.mjs --md`(默认输出到 stdout)。脚本不会自动覆盖本文件——加 `--write` 才会写。**两个职责分开**:本文件决定补哪些、按什么顺序;脚本是清单与回归信号。

> 编号说明(诚实): 本文件在 REQ-A282 落地时那一次提交**没有**给自己加
> `TRACEABILITY_MATRIX.md` 行,而 REQ-A282 已被"AEROSPACE §1 计数回填"占用 ——
> 也就是说扫描/审计本身是 REQ-A282,而它的**修补**(本轮的刀 1)登记为 **REQ-A283**。
> 两个编号都指向同一个缺口清单,不重复计账。

---

## 1. 摘要

| 维度 | REQ-A282(首扫) | REQ-A283(刀 1 后,实测) |
|---|---:|---:|
| 扫描文件(`src/svelte/**/*.svelte`) | 106 | 109(新 3 个行原语) |
| 含缺口文件 | 65 (61.3%) | **58** |
| 总缺口数 | 79 | **65** |
| `label-field-association` | 14 | **0** |
| `live-region` | 18 | 18(未动) |
| `focus-visible` | 47 | 47(未动) |
| `custom-control-role` / `tab-order` | 0 / 0 | 0 / 0 |

按缺口类型:

| 缺口类型 | 数 | 严重性 |
|---|---:|---|
| live-region(状态变化不广播) | 18 | 高 — 屏幕阅读器完全感知不到状态变化 |
| label-field-association(控件无关联 label) | ~~14~~ **0** | 高 — 已按 REQ-A283 修完(§3.1.1/§3.1.5) |
| focus-visible(键盘焦点不可见) | 47 | 中 — 键盘用户能 tab,但看不到自己 focus 在哪里 |
| custom-control-role | 0 | 已无信号(R2 的 3 个误报已通过 pointer-events + aria-hidden 排除过滤) |
| tab-order(tabindex >= 1) | 0 | 已无信号 |

---

## 2. 复检方式

```bash
# 自测(5 个断言,验证规则能抓真问题)
bun run a11y:selftest

# DOM 级门禁:挂载 14 个设置页,断言每个控件的名字 = 可见文案(REQ-A283)
bun run test:svelte -- svelte-tests/settings-a11y.svelte.test.ts

# 出 markdown(到 stdout,不写文件)
bun run a11y:scan

# 落盘到 docs/A11Y_AUDIT.md(覆盖——慎用)
node scripts/a11y-scan.mjs --md --write

# 出 JSON(给 CI 解析)
node scripts/a11y-scan.mjs --json

# 与其他脚本同源:一起跑
bun run check    # selftest 链;不会自动跑 scan(只跑 selftest,确保规则不退化)
```

退出码**总是 0**——缺口的存在要被工程团队看见,不是先修再说。

---

## 3. 严重性分桶

### 3.1 P0 — 必须立刻修(影响屏幕阅读器用户的基本路径)

#### 3.1.1 settings pages 14 个页面完全没有 label-field 关联 → **已补(REQ-A283,见 §3.1.5)**

| 文件 | 行数 | 备注 |
|---|---:|---|
| src/svelte/settings/AccountPage.svelte | 121 | 账号设置 |
| src/svelte/settings/AiPage.svelte | - | AI 设置 |
| src/svelte/settings/CellularPage.svelte | 66 | 蜂窝网络 |
| src/svelte/settings/DisplayPage.svelte | 88 | 显示与亮度 |
| src/svelte/settings/FocusPage.svelte | 68 | 专注模式 |
| src/svelte/settings/HotspotPage.svelte | - | 热点 |
| src/svelte/settings/ImePage.svelte | - | 输入法 |
| src/svelte/settings/LanguagePage.svelte | 25 | 语言 |
| src/svelte/settings/LockPage.svelte | 72 | 锁屏 |
| src/svelte/settings/NetGuardPage.svelte | 98 | 网络防火墙 |
| src/svelte/settings/NotificationsPage.svelte | 90 | 通知 |
| src/svelte/settings/RadioPage.svelte | - | 无线电 |
| src/svelte/settings/SettingsApp.svelte | - | 设置主页 |
| src/svelte/settings/SoundPage.svelte | - | 声音 |

**影响**: 用户进入"设置"页面,屏幕阅读器读到 `自动息屏` 然后接 `<button role=switch aria-checked=false>`——它不知道 "自动息屏" 这个 label 是属于哪个 switch。结果是:用户听到一组无标签开关,无法判断哪一个是。

**修法**(已写进规则建议):
- Switch 已经接 `aria={…}`,现有调用点改为传 `aria={t("settings.autoOff")}` 即可;14 个 settings pages 全部需要把 LABEL 文本当 aria 传进控件
- Segmented 已经接 `aria=…`,同上
- 真正缺的是 input / textarea(目前这些页几乎没有原生表单控件;若加,需要 label for=id)
- **强烈建议**: 给 kit.ts 的 ROW 模板改造为 label + control slot 的形式,把关联作为结构而不是每个调用方各自拼

#### 3.1.2 18 个 live-region 缺口(`$effect + setInterval` 无 aria-live)

| 文件 | 状态变化 |
|---|---|
| src/svelte/Dock.svelte | Dock 时钟 |
| src/svelte/HomeDock.svelte | 主 Dock |
| src/svelte/LockScreen.svelte | 锁屏时钟 |
| src/svelte/StatusBar.svelte | 顶部状态条 |
| src/svelte/NotificationBanner.svelte | 通知横幅 |
| src/svelte/ImeOverlay.svelte | 输入法层 |
| src/svelte/modules/ClockWidget.svelte | 顶栏时钟 |
| src/svelte/modules/StageClock.svelte | 桌面时钟 |
| src/svelte/settings/AboutPage.svelte | 关于页电池 |
| src/svelte/CalendarApp.svelte | 日历 |
| src/svelte/DeviceMicButton.svelte | 设备麦克风按钮(状态轮询) |
| src/svelte/MonitorApp.svelte | 监视器 |
| src/svelte/MusicApp.svelte | 音乐 |
| src/svelte/RemindersApp.svelte | 提醒 |
| src/svelte/SystemPanel.svelte | 系统面板 |
| src/svelte/TaskManager.svelte | 任务管理器 |
| src/svelte/TerminalApp.svelte | 终端 |
| src/svelte/VoiceMemosApp.svelte | 语音备忘录 |

**影响**: 这 18 个组件主动轮询或定时刷新(每秒 / 几秒)——
- 时钟类(ClockWidget, StageClock, LockScreen, StatusBar): 屏幕阅读器永远不知道现在几点。
- 电池类(AboutPage): 用户问"还剩多少电",屏幕阅读器只读它进入页时的快照。
- 设备状态类(MonitorApp, SystemPanel, TaskManager): 状态变更完全静默。

**修法**: 给承载变化的 span / div 加 `aria-live="polite"`(状态变化时礼貌打断)+ `aria-atomic="true"`(整段重读,而非仅变化的部分)。或者如果只是实时显示,不广播变化,改用 `role="timer"`(语义上正确,屏幕阅读器按需查询)。

**注意区分**: 通知横幅(NotificationBanner)、电池报警、麦克风激活——这些应当用 `aria-live="assertive"`(打断当前朗读)。

### 3.1.5 已补: 刀 1 的实测缺陷与修法(REQ-A283)

刀 1 不是"把 `aria-label` 抄一遍"。先写了一个**DOM 级**门禁
(`svelte-tests/settings-a11y.svelte.test.ts`,16 例),它在改任何页面**之前**跑出 4 条红 ——
这 4 条就是这一刀真正的缺陷:

| # | 缺陷(实测) | 为什么是缺陷 | 修法 |
|---|---|---|---|
| 1 | `DisplayPage` 的两行 `<Segmented>` 传 `aria="appearance"` / `aria="auto-screen-off"` | 屏幕阅读器读**英文 slug**,而可见文案是"外观"/"自动息屏" —— 用户听到的词**看不到**(违反 WCAG 2.5.3 Label in Name) | 行原语 `ChoiceRow label={t("settings.appearance")}`,名字 = 可见文案 |
| 2 | `LanguagePage` 的 `aria="language"` | 同上 | 同上 |
| 3 | `LockPage` 的密码框只有 `placeholder`,没有名字来源 | `placeholder` 不是标签:一输入就消失,屏幕阅读器只读"编辑框" | `aria-label={t("lock.pin")}`(= placeholder 那句),并说明**为什么不**用 `<label for>`(该字段没有任何可见的 label 文案,加一个会改设计) |
| 4 | `AiPage` 的三个云端字段(模型/端点/API 密钥)由 `<span>` 当说明,`<input>` 无任何关联 | 用户在屏幕阅读器里听到三个无名字的编辑框 | 说明文案改成真正 `<label for={id}>` + `<input id={id}>`(**堆叠表单**的正确形状,布局不变),id 来自 kit 的同一个计数器 |

**修法(结构,不是每处各写一遍)** —— 新增三个行原语,关系由**原语生成**:

| 文件 | 作用 |
|---|---|
| `src/svelte/settings/Field.svelte` | 一行 = 可见 label + 控件,id 对由 `nextFieldId()`(kit.ts)生成:label 元素同时拿 `for={id}`(原生控件:名字 + 点 label 即点控件,`<button>` 也是 labelable)与 `id={labelId}`(自定义控件:`aria-labelledby`)。`icon` prop 渲染 `aria-hidden` 装饰字符(🛡️ 不进名字)。 |
| `src/svelte/settings/ToggleRow.svelte` | `<Field>` + `<Switch>` 的固定组合(14 个页面 ~30 行的绝大多数) |
| `src/svelte/settings/ChoiceRow.svelte` | `<Field>` + `<Segmented>`(radiogroup 用 `aria-labelledby`,因为复合控件不是 labelable) |

这样"可见文案"与"控件名字"是**同一个 prop**,不可能再各写一份而漂移。14 个页面全部改造完成,
`label-field-association` 从 14 条降到 **0**。

**扫描器规则也补强了(R1 v3)**: v1/v2 是**文件级**信号 —— 一个文件里 8 行控件只报 1 条,
而且补完 7 行、剩 1 行时规则**就绿了**(文件里已经出现 `<label for>`)。v3 改成**计数对**:
`控件数 > 名字来源数 ⇒ 报还差几个`,并显式承认三条机制(行原语 / `aria-label(ledby)` /
`<label for>`)。顺带修掉 v3 自己的一个误报:计数必须**去掉注释再数** —— 第一版把
`Field.svelte` 文档注释里提到的 `<input>` 当成了控件,给刚修好的组件报了缺口(`stripComments`)。

**证据(同机实跑)**:

```bash
# 改前(红): 14 个页面里 4 例断言失败 —— 上面表格的 4 条缺陷
bunx vitest run --config vitest.config.ts svelte-tests/settings-a11y.svelte.test.ts
#   4 failed | 12 passed (16)

# 改后(绿): 944 例全绿(设置页 16 例新门禁在内)
bun run check          # test + tsc + svelte-check + test:svelte(80 文件 / 944 例)+ 五组 scan

# 缺口数: 79 → 65,其中 label-field-association 14 → 0
node scripts/a11y-scan.mjs --json | python3 -c "import json,sys,collections;d=json.load(sys.stdin);print(d['total_findings'],collections.Counter(f['rule'].split(':')[0] for r in d['report'] for f in r['findings']))"
```

**负数控制 ×1(自校验注入,逐字节还原,`cmp` 证明)**: 把 `Field.svelte` 的
`<label for={id} id={labelId}>` 换成 `<span>`(关联整体消失)⇒ **16 例里 15 例变红**,唯一没红的
正是 `AiPage`(它用的是页面里手写的 `<label for>`,不经 `Field`)—— 说明这几条用例覆盖的是**不同**
的路径,不是同一件事的复述;还原后 16/16 复绿。另一次注入(只去掉 `ToggleRow` 的
`labelledby={ids.labelId}`)只红了 1 例:因为 `<label for>` 对 `<button>` 本身就成立 ——
也就是说**两条机制各自独立可用**,`labelledby` 是第二重保险(诚实登记:`aria-labelledby` 优先级
更高,所以真正生效的是它;`for` 负责"点 label 也能切换")。

**扫描器自测 +2(3 → 5)**: ①用行原语的页面**不**报(防止"修好了反而被规则点名");
②两个控件只有一个名字来源时**报 2 control(s) but only 1 name source**(v1/v2 会整页放行)。

### 3.2 P1 — 应修(影响键盘用户)


#### 47 个 focus-visible 缺口

启发式规则 R4 已在 v2 引入"import shellChrome ⇒ 跳过",但还有 47 个文件未使用共享 token,button 类硬编码无 focus-visible:ring-*。这意味着它们至少需要一次人工复核:是真的没 ring,还是视觉上用了别的 focus 暗示(如 hover 高亮、阴影变化)?

**判断力分桶**:

- **真缺口**: 纯文字 / icon-only button(`<button class="rounded-full bg-accent px-3 py-1 text-white">`)— 视觉上无 focus 暗示。例: MagnifierApp, MailApp, MapsApp, MessagesApp, MusicApp。
- **可能误报**: 内部一次性按钮 / toast dismiss / 调试面板(LmkDebugPanel, SensorPanel)。
- **一次性控件**: 装饰性按钮(只显示、不交互)— 不需要 ring。

**修法(共享 token 化)**:
- 把 `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60` 这样的字符串集中到 lib/shellChrome.ts,导出 BUTTON_FOCUS_RING。
- 47 个文件改成 `<button class={`${BUTTON_FOCUS_RING} …`}>`。
- 或者更优:全局 CSS 一行——`@layer base { button:focus-visible { outline: 2px solid white; outline-offset: 2px; } }`——但这违背了 shellChrome "Token 集中" 的原则,且影响 chrome 之外的 button。

### 3.3 P2 — 留作观察

- R1 / R5 的真信号已经在 P0 列完。
- R2 / R3 当前 0 信号——不是没有问题,是启发式规则在这一轮无法稳定识别,需要后续真屏幕阅读器(NVDA / VoiceOver)手动测。

---

## 4. 误报与边界

### 4.1 R4 (focus-visible) 的 47 个信号里,估计误报率约 20%

我们没有跑键盘真测,只能文本启发式。这些文件极可能有自定义 focus 提示(hover/active/active scale 等):

- MissionControl.svelte(group flex flex-col items-center gap-1 — 缩略图卡片,鼠标 hover 有放大)
- AppLibrary.svelte(w-6 text-accent — 窗口分页标签)
- ClipboardAnnounce.svelte(grid h-6 w-6 — 一次性 toast 关闭按钮)

**但**: 视觉提示不等于键盘焦点提示。键盘用户 Tab 时看不到 hover 效果。所以即使是装饰按钮,只要它能 focus,就应有 ring。

### 4.2 启发式规则的已知盲区

| 盲区 | 例子 |
|---|---|
| 模板字符串拼接的 token | class 用 backtick 模板拼 shellChrome.ts 的 CHROME_ICON_BUTTON,扫描器看不到里面的 focus-visible:ring-2 |
| 动态 class(状态绑定) | class={isSelected ? "ring-2" : ""} |
| Svelte 4 (on:click) vs 5 (onclick) 混用 | R2 已覆盖 on(?:click|:click),但有些组件用 on:click={…} |
| :global(...) 全局样式 | 影响 a11y 但扫描器看不到 |
| 外部 lib(VoiceMemos / MapsApp 的内嵌地图) | 这些控件本身就不是 svelte 文件,扫描器盲 |

**结论**: 这份报告不能代替真键盘 / 真屏幕阅读器测试。它是真测试的清单,跑测试时用它对照。

### 4.3 屏幕阅读器以外的 a11y 维度

本扫描器**只覆盖**:
- ARIA role / state / property
- 键盘焦点
- label 关联
- live region

**没覆盖**(留给后续轮次):
- 颜色对比度 — 需要对比度算法 + 真实 token 调色板
- 触摸目标尺寸(44×44px) — 需要 layout 常量 + 实际 button 尺寸
- 屏幕方向(landscape / portrait / RTL)
- 屏幕缩放(200%)与文本放大
- 动效偏好(prefers-reduced-motion)

---

## 5. 与现有脚本族的关系

| 脚本 | 维度 | 状态 |
|---|---|---|
| scripts/i18n-scan.mjs | 未走 i18n | 跑 |
| scripts/store-scan.mjs | 写未在 allowlist | 跑 |
| scripts/write-scan.mjs | 写入路径完整性 | 跑 |
| scripts/unwired-scan.mjs | 导出未引用 | 跑 |
| scripts/fmea-gen.mjs | FMEA 完整性 | 跑 |
| scripts/a11y-scan.mjs | a11y 缺口(本轮新增) | 跑(只 selftest 入 check;scan 默认到 stdout) |
| svelte-tests/settings-a11y.svelte.test.ts | **DOM 级**名字关联(REQ-A283) | 跑(**入** `test:svelte`,`check` 全量门禁的一部分) |

入口都是 bun run check(看 package.json),与已有 CI 链同源。

---

## 6. 建议的下一步

不要一次补全部 79 个缺口。理由是 a11y 不是 "加 aria-label 一行" 就完——每一处都是三件事:

1. ARIA 属性(技术层)
2. 键盘可达(交互层)
3. 屏幕阅读器实测(VoiceOver / NVDA / Orca)

**推荐三刀走法**:

| 刀 | 范围 | 工作量 | 影响 | 状态 |
|---|---|---|---|---|
| 刀 1 | P0 的 14 个 settings pages(label-field-association) | 中 — 改 ROW 模板让 LABEL 强制关联控件,改 14 个 page 把 aria=LABEL_TEXT 传进 Switch / Segmented | 屏幕阅读器用户能"听懂"系统设置 | ✅ **REQ-A283**(行原语 `Field`/`ToggleRow`/`ChoiceRow` + DOM 门禁 16 例;14 → 0) |
| 刀 2 | P0 的 18 个 live-region | 中 — 在 ClockWidget 等 18 处加 aria-live=polite/assertive + aria-atomic=true;通知横幅 / 麦克风激活用 assertive | 屏幕阅读器用户能"听到"状态变化 | ⬜ 未动(live-region 仍 18) |
| 刀 3 | P1 的 47 个 focus-visible | 大 — 加 BUTTON_FOCUS_RING token 到 shellChrome.ts,把所有 button 改造 | 键盘用户能看到焦点 | ⬜ 未动(focus-visible 仍 47) |

刀 1 的实际做法与上面预估的两点不同(登记差异,不粉饰): ①**没有**去改 `ROW` 模板加 slot ——
新起 `Field.svelte` 作为"一行 = label + 控件"的原语,`ROW` 仍是纯样式字符串(它被静态展示行
共用,塞 slot 会牵连 read-only 行); ②`aria=LABEL_TEXT` 只是三条机制之一,而且对**复合控件**
(`<Segmented>` 的 radiogroup)真正生效的是 `aria-labelledby` —— `aria-label` 与可见文案各写一份
正是缺陷 #1/#2 的成因,所以原语把两者合并成**一个** `label` prop。

刀 2 / 刀 3 的清单仍是 §3.1.2 / §3.2,数字未变(`a11y-scan.mjs` 每次跑都会重算)。

每一刀都包含:
- 代码改动
- 至少 1 个 vitest a11y 测试(用 happy-dom + role 查询 + axe-core / jest-axe)
- a11y-scan 自测扩 1 例(确认扫描器能识别补完后的状态)
- docs/A11Y_AUDIT.md 的"已补/未补"清单更新

---

## 7. 已知反模式(本审计**没有**抓到,但需要警惕)

- "visible focus 是 hover 替的": 仅靠 hover 高亮,键盘 tab 完全不可见。R4 部分文件可能落入此类。
- "原生 div onclick + cursor-pointer": 一旦 R2 漏判(模板字符串拼接覆盖了 onclick),实际是裸 div 在交互。
- "Switch 的 aria 来自视觉 LABEL 的 t() 翻译": 翻译走 i18n 是好的,但**label 字符串与字段的关联**应当是结构性的(传进 Switch 的 aria prop),不是页面级散写——这是刀 1 改造 ROW 模板的动机。

---

## 8. 自测 / 阴性对照

脚本自带 `--selftest`(**5** 例;REQ-A283 起从 3 例扩到 5 例):

- sample 1: 一个 settings page 用 `import {LABEL} from "./kit"` + `<Switch aria="x">` + `<span class={LABEL}>foo</span>`(没有 label-for / aria-labelledby) 应当被 R1 抓到(label-field-association)。
- sample 2: 最简单的 `<div onclick={() => {}}>click</div>`(没有 role) 应当被 R2 抓到(custom-control-role)。
- sample 3: `<button tabindex="1">x</button>` 应当被 R3 抓到(tab-order)。
- sample 4(REQ-A283): 用行原语 `<ToggleRow label="…" />` 的页面**不**应被 R1 抓到 —— 防"修好了反被点名"。
- sample 5(REQ-A283): 两个控件只有一个名字来源 ⇒ R1 必须**报 `2 control(s) but only 1 name source`**(v1/v2 会整页放行)。

5/5 验证过——证明规则**能**抓真问题,而不仅发泛泛"应有 aria"的警告。

### 8.1 阴性对照(DOM 级门禁,不是扫描器自测)

`settings-a11y.svelte.test.ts` 的注入实验(自校验 + 逐字节还原,`cmp` 证明):

- 把 `Field.svelte` 的 `<label for={id} id={labelId}>` 换成 `<span>` ⇒ **15/16 例变红**,唯一幸存的是
  `AiPage`(走页面内手写的 `<label for>`)—— 用例覆盖的是不同路径。
- 只去掉 `ToggleRow` 的 `labelledby` ⇒ 只红 1 例:原生 `<label for>` 对 `<button>` 已成立,故名字仍在;
  两条机制互相独立,`aria-labelledby` 优先。

### 8.2 与 `i18n-scan` 的口径差异(登记,不粉饰)

`i18n-scan` 的 check 8(REQ-A183)把 **`placeholder` 算作可用名字**("the `placeholder` of a text
field"),而本审计的 R1 v3 / DOM 门禁**不算** —— 它的目的正是"字段要有 label 关联",而
placeholder 一输入就消失。这就是为什么 `LockPage` 的密码框与 `AiPage` 的三个字段能通过
`i18n-scan` 却被本轮判为缺陷。两条规则的口径**故意**不同(一条管"有没有名字这个事实",一条管
"名字是不是可见文案"),所以本轮的修法是给它们**真正的名字** —— 两个门禁从此都绿,不再有口径差
遮蔽的缺陷。后续若要统一,应改 `i18n-scan` 的 check 8(单独一轮 + 自己的负数控制),而不是把
本审计的标准放松。

---

## 9. 与其他审计的关系

| 审计 | 范围 | 关系 |
|---|---|---|
| AEROSPACE_SOFTWARE_AUDIT.md | 全栈需求审计 | a11y 是其中一维度("11/106 文件声明 ARIA")——本次给出**结构化诊断 + 可重复扫描** |
| FMEA.md | 失效模式 | 新增 FMEA 行可在下一轮补(类比 F-SH-010 / F-SH-011,见 TRACEABILITY_MATRIX 中 REQ-A280 的格式)。**本轮未加** FMEA 行 —— 刀 1 的缺陷(名字为英文 slug / 字段无名字)属于"可用性降级"而非危险源,且 `FMEA.md` 的 severity 表以数据完整性/安全为主;诚实登记为**已知未登账项** |
| TRACEABILITY_MATRIX.md | 需求-测试-失效模式追踪 | 扫描/审计 = REQ-A282(首扫,该次提交未登记本行);**修补 = REQ-A283**(本文件 §3.1.5) |
