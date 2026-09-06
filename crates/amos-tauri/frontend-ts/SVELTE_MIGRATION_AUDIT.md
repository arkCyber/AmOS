# AmOS UI · React → Svelte 全面迁移审计报告（实测，不改代码）

日期：2026-09-06 · 分支 `feature/system-monitor-and-power`
审计对象：`crates/amos-tauri/frontend-ts`
方式：逐一实跑全部验证门槛，逐屏核对 React 载体 / 纯逻辑 lib / 测试 / 硬件·后端依赖。
承诺：本报告**未改动任何代码**，仅作为下一阶段"逐个模块迁移 + 测试"的决策与验收依据。

---

## 0. 结论速览（先给答案）

1. **能否换 Svelte 后全部软件正常工作？** —— 当前做到的是"**整机可运行**"而非"全部由 Svelte 承担"：
   - 19 屏已迁 Svelte 并在**生产构建走 Svelte**（`apps.tsx` 的 `svelteEnabled()` → `SvelteAppHost` 动态挂载）。
   - 剩余 3 屏安全**回退 React**；`lib/*.ts`（框架无关纯逻辑）双端共享，故功能不因两套 UI 分叉。
   - **全部门槛实测绿**（见 §1），即"软件能正常工作"目前成立。
2. **要"全部应用都由 Svelte 承担并通过一致性与功能测试"，仍未完成**：剩余 9 屏中：
   - 纯逻辑、可本环境端到端验证：**settings**；
   - 依赖摄像头/录音/后端 daemon/真机：**camera、magnifier、vmemos、maps、ai、interpreter、android、store**——只能迁可测的纯逻辑外壳，真机部分需在设备侧验收（见 §4）。
3. **诚实风险**：`lib/` 60+ 模块、~数千行是两套 UI 唯一的逻辑真相源；凡 lib 改动需三端同步（lib + React 屏 + Svelte 屏 + 各自测试），此前 Notes #标签 即暴露过 React/Svelte 行为漂移并被修掉。这是持续迁移期的头号回归源。


---

## 1. 实测验证矩阵（本轮逐项实跑）

| # | 门槛 | 命令 | 结果 |
|---|---|---|---|
| 1 | React 主门槛（DOM 隔离） | `node scripts/bun-iso-test.mjs test` | ✅ `[bun-iso] test OK` |
| 2 | Svelte DOM/交互测试 | `npx vitest run --config vitest.config.ts` | ✅ 121 passed / 37 files |
| 3 | Svelte 类型 | `npx svelte-check --tsconfig ./tsconfig.json` | ✅ 0 errors / 0 warnings |
| 4 | TS 类型（React 侧） | `npx tsc --noEmit` | ✅ clean |
| 5 | 生产构建（真机所发物） | `npx vite build` | ✅ 成功 |
| 6 | 生产包 | — | React 主包 gzip ≈160.5 kB + 19 个 Svelte 按需 chunk（见 §5） |

> **坑位说明（审计发现，非缺陷）**：裸 `bun test`（不带脚本）会把 `svelte-tests/*.test.ts`（vitest 专属、import `.svelte`，bun 无 loader）一并扫入 → 报 ~247 fail / 235 error。**这是误报**：仓库约定用 `bun-iso-test.mjs` 只跑 `src/__tests__`（且 DOM 文件进程隔离）。真门槛是绿的。若想根治"裸跑即绿"，可给 bun 加排除（见 §6-建议A，本报告未改）。

---

## 2. 当前接线结构（证据）

- 接线点：`src/apps.tsx`
  - `svelteEnabled()`（L943）：`import.meta.env.PROD`（vite build 才定义）→ true；否则读 `localStorage["amos.ui.svelteCalc"]==="1"` 的 dev 开关。**bun 下 env 无 PROD → React**，故 React 体作为 bun 回退保留。
  - 模块级稳定 loader（L964-974）→ `SvelteAppHost` 按 loader 身份只挂载一次、随壳 locale 变化原地 re-key（不重挂/不丢状态）。
  - `COMPONENTS`（L2137-2160）：22 个 app id。
- 载体组件：`src/components/*.tsx`（React 屏幕）+ `src/svelte/*.svelte`（已迁屏幕）+ 共享 infra（`locale.svelte.ts` / `theme.svelte.ts` / `store.ts`）。

**已迁 Svelte 并 PROD 接线的 19 屏**（与 vite 产物 19 个 chunk 一一对应）：
`calculator / weather / contacts / privacy(permissions) / clock / messages / music / notes / files / photos / phone / reminders / mail / settings / maps / vmemos / magnifier / android / store`
> phone/maps/vmemos/magnifier/android/store：离线/控制面/离线壳路径全绿；真机 daemon/拨号/定位/录音/取景待验收。


---

## 3. 逐屏剩余工作量审计

行内数字为 React 载体行数（本机 `wc -l` 实测）。⭐ = 本环境（无设备/无 daemon，浏览器 + happy-dom/vitest）可端到端验证的优先项。

| 屏(app id) | React 载体(行) | 纯逻辑 lib（复用真相源） | 现有测试（bun src/__tests__） | 浏览器可全测? | 障碍 | 状态 |
|---|---|---|---|---|---|---|
| ⭐ **settings** | `apps.tsx` 内 `Settings`（~258）+ 8 个面板组件 | `lib/settings`+`display`+`cloud`+`providers`+`wallpaper`+`lock`+`sensors`+`system`+`taskmgr`+`lmk` | 多文件（settings/autooff/sensor/system…） | ✅ | 大量子面板 | ✅ `SettingsApp.svelte`（本任务迁，见 §2） |
| ⭐ **reminders** | `RemindersApp` 733 | `lib/reminders.ts`+`lib/reminderNotify.ts`+`lib/time.ts` | `reminders.test.ts`、`reminders-dom.test.tsx`、`reminderNotify*` | ✅ | 无（大文件 ~733） | ✅ `RemindersApp.svelte`（本任务迁，见 §2） |
| ⭐ **mail** | `MailApp` 502 | 桥接在 `lib/backend.ts`（`amos-mail`） | `mail.test.tsx`（DOM，fake `__TAURI_INTERNALS__`） | 部分 | 端到端需 amos-mail daemon（fake 桥可测 UI） | ✅ `MailApp.svelte`（本任务迁，见 §2） |
| maps | `MapsApp` 246 | `lib/maps.ts`(101) | `maps.test.ts`(纯) | ✅(离线) | 真机定位需 geolocation | ✅ `MapsApp.svelte`（本任务迁，见 §2） |

---

## 4. 风险清单

1. **逻辑真相源单一化**：`lib/` 是两套 UI 唯一共享逻辑；改动必须"lib + React 屏 + Svelte 屏 + 两套测试"同步。历史已有漂移并被修复（Notes #标签 React/Svelte 行为不一致、Svelte 漏切回 all）。→ 迁移屏都应有 `*-parity.test.ts`（React↔Svelte 一致性）护栏。
2. **`$state(initFn)` 非惰性**：Svelte 5 runes 里 `$state(initFn)` 会立即调用函数取初值，roadmap 明示须"先算初值再传值"，否则初值恒为函数体（而非其返回）。
3. **主包未真正瘦身（加法期）**：13 屏 React 体仍留在 React 主包作 bun 回退，故 React main 未下降（gzip ≈159.9 kB）。真正净收益需"真机确认 Svelte → 删除 React 体 + 其 happy-dom DOM 测试"的减法期。过早删除会让 bun 套件失去覆盖。
4. **硬件/后端屏无法在本环境验收**：camera / magnifier / vmemos / maps / ai / interpreter / android / store / mail(端到端) / phone(真机拨号)。盲迁 UI 不验证桥，风险自担；须走 §7 设备侧清单。
5. **测试双轨**：bun（React DOM，`src/__tests__`）+ vitest（Svelte DOM，`svelte-tests/`）。任何"跑裸 `bun test`"的人会踩 §1 误报 → 需要文档/脚本排除防呆。
6. **大组件单回合不可靠**：Reminders 733 / Camera 830 / BackendApps 952 / MailApp 502——roadmap 已判定超单条编辑上限，需多回合或专门任务，避免"能编译 WIP→后续接线+测试"堆积未验证代码。
7. **svelte-enable 依赖 localStorage 键名**：dev 开关键 `amos.ui.svelteCalc` 历史命名与多屏复用不一致（README 亦沿用），语义上现在是"全部已迁屏"开关；改名或文档化，避免误导后续维护者以为只控计算器。

---

## 5. 体积实测（生产构建，dist/assets）

- React 主包 `index-*.js`：raw 516.87 kB / **gzip 159.55 kB**（+CSS 52.47 raw / 9.45 gzip）。
- Svelte 按需 chunk（仅打开对应屏才下载）：共享 `locale.svelte`(gzip 4.10)+`store`(0.58) 常驻 Svelte 图。

| Svelte 屏 | gzip kB | Svelte 屏 | gzip kB |
|---|---|---|---|
| NotesApp | 6.39 | WeatherApp | 1.80 |
| PhoneApp | 4.62 | PermissionsApp | 1.97 |
| ClockApp | 4.55 | CalculatorApp | 2.03 |
| FilesApp | 4.35 | MessagesApp | 2.52 |
| PhotosApp | 4.33 | MusicApp | 2.68 |
| ContactsApp | 2.94 | | |

> 复测：`npm run bundle:report`（`scripts/bundle-report.mjs`）。A/B React 基线：临时把 `svelteEnabled()` 改 `()=>false`。

| magnifier | `MagnifierApp` 478 | `lib/magnifier.ts`(93) | `magnifier.test.tsx`、`magnifier-lens.test.ts` | ✅(控制面) | 真实取景需 Canvas2D+camera | ✅ `MagnifierApp.svelte`（本任务迁，见 §2） |
| vmemos | `VoiceMemosApp` 296 | `lib/voiceMemos.ts`+`lib/voiceRecorder.ts`+`lib/mediaStore` | `voiceMemos.test.ts`、`voiceMemos-dom.test.tsx` | ✅(列表面) | 录音/播放需真机 mic/audio | ✅ `VoiceMemosApp.svelte`（本任务迁，见 §2） |
| camera | `CameraApp` 830 | `lib/camera.ts`+`lib/cameraCapture.ts`+Photos 写 | `camera*.test.tsx`（12+） | 部分 | 摄像头/媒体（无设备 demo） | ⬜ |
| android | `AndroidApp` 164 | `lib/android.ts`+`lib/lmk.ts`+`lib/backend` | `android.test.ts`、`lmk*.test.ts`、`lmk-debug-panel.test.tsx` | ✅(离线壳) | 列表/启动需 daemon | ✅ `AndroidApp.svelte`（本任务迁，见 §2） |

---

## 6. 建议的推进顺序（供选择，非本次已做）

- **P0 纯逻辑/浏览器可测**：`settings` 与 `maps`（离线路径）均已迁完并接线。剩余可接线屏（camera/magnifier/vmemos/ai/interpreter/android/store）基本需硬件/后端 daemon，只能迁纯逻辑外壳，端到端真机验收。
- **P1 减法期**：任一屏真机验收通过后，删除其 React 体 + `src/__tests__/*dom*`，把覆盖并入 vitest，`bun.lock` 刷新，`bundle:report` 复测净收益。
- **P2 基建卫生（小、独立）**：给 bun 默认扫描排除 `svelte-tests/`，根治"裸 `bun test` 误报红"（可并入某次 P0 一起做）。
- **P3 硬件/后端屏**：只能迁纯逻辑外壳；端到端验收全部留给设备侧（§7）。

---

## 7. 验收依赖（设备/daemon 侧，本环境无法代跑）

出自 `ON_DEVICE_ACCEPTANCE.md` / `SVELTE_MIGRATION_DATA.md`，逐屏过一遍（Svelte 版）：
打开→切标签/交互→返回，无白屏/无报错；切中/英语言→屏内文案原地更新；切深/浅色→跟随；关掉再开→数据仍在（store 持久化）。
- 摄像头：camera / magnifier / vmemos(录音) —— `getUserMedia`/MediaRecorder 实机。
- 定位：maps —— 真机 GNSS + OSM 瓦片 + 权限主开关。
- 后端 daemon：ai / interpreter / store / android(LMK) —— 起 `amos-ai`/`amos-mail` daemon 后走真实桥。
- 电话：phone —— 真实外拨 + in-call 桥 + 通话计时（UI 已绿）。
- A/B 帧率/体积：`adb shell dumpsys gfxinfo <pkg> framestats`，Svelte vs React 各 ≥5 次取中位。

---

## 8. 一句话总结

当前分支**可在换 Svelte 后整机正常运行**（19 屏 Svelte + 3 屏安全回退 React，`lib` 共享，全门槛绿）；
剩余 camera/ai/interpreter 只能迁纯逻辑外壳，端到端待真机。
本报告不含任何代码改动。

| ai | `BackendApps`(AiApp) 952 | `lib/aiEngine.ts`+`lib/providers.ts`+`lib/backend.ts` | `backend*.test.*`（fake 桥） | 部分 | 后端桥 + 真机 daemon | ⬜ |
| interpreter | `BackendApps`(InterpApp) 952 | `lib/interp.ts` | `interp*.test.ts` | 部分 | 后端桥（同传 daemon） | ⬜ |
| store | `StoreApp` 152 | `lib/backend.ts`(`appstore_*`)+`lib/storeApps` | `store-apps.test.ts` | ✅(离线+目录) | 下载/校验/装需 daemon | ✅ `StoreApp.svelte`（本任务迁，见 §2） |

> 注：上表"部分" = 该屏的**纯逻辑 + 离线 UI 状态机**可本环境测；凡是走 `window.__TAURI_INTERNALS__` invoke/硬件 `getUserMedia`/`geolocation` 的端到端只能真机验收。已迁 11 屏中，phone 同理（离线绿 / 真机待验收）。

**仍为 React（未迁）的 11 屏**：`settings / reminders / vmemos / android / maps / camera / ai / interpreter / mail / store / magnifier`。
