# Dock / 主屏 · Svelte 全面迁移路线图（审计）

目标：把 home + dock 上可打开的**所有已注册 app** 迁到 Svelte 5，全部带 vitest + React↔Svelte 一致性测试；最后删除各 React 实现体及其 happy-dom DOM 测试，退出 React。

> 现实：一次性迁完全部不可靠（多数是大屏、部分依赖摄像头/音频/后端桥）。本文件是**逐屏清单 + 顺序 + 每屏 checklist**。每屏按 checklist 完成后勾掉，进度可追踪。

> ✅ **最终态（2026-09）**：本清单所列**全部内置 App 均已 Svelte 单源完成**——各 React 实现体与 `*-parity.test.ts` 均已删除，`apps.tsx` 现仅剩 Svelte 宿主接线（约 149 行），`src/components` 仅保留壳层 chrome 所需的 React 叶与宿主。下表与 checklist 是**历史记录 / 迁移样板**，其中的“React 载体 / 留作 bun 回退”等表述不再代表当前状态。


## 迁移状态总览（前端 `src/`）

✅ = 已迁（Svelte 屏 + vitest + 一致性护栏 + PROD 路由）；⬜ = 待迁。

| 顺序 | app id | React 载体 / 行数 | 纯逻辑复用 | 浏览器可测 | 依赖障碍 | 状态 |
|---|---|---|---|---|---|---|
| — | calculator | apps.tsx ~165 | lib/calculator | ✅ | 无 | ✅ |
| — | weather | apps.tsx ~106 | lib/weather | ✅ | 无 | ✅ |
| — | contacts | ContactsApp 275 | lib/contacts | ✅ | 拨号仅需桥 | ✅ |
| — | privacy(permissions) | PermissionsApp 213 | lib/permissions | ✅ | daemon 审计仅在线 | ✅ |
| 1 | clock | apps.tsx ~312 | lib/time | ✅ | 需内联 Segmented/Switch | ✅ `ClockApp.svelte` |
| 2 | notes | apps.tsx ~392 | lib/notes | ✅ | 无 | ✅ `NotesApp.svelte` |
| 3 | maps | MapsApp 246 | lib/maps | ✅(离线) | 定位需真机 | ✅ `MapsApp.svelte` |
| 4 | files | FilesApp 478 | lib/files | ✅ | 无 | ✅ `FilesApp.svelte` |
| 5 | settings | apps.tsx ~258 | lib/settings/display | ✅ | 大量子面板 | ✅ `SettingsApp.svelte` |
| 6 | magnifier | MagnifierApp 478 | lib/magnifier | ✅(控制面) | 取景需真机 | ✅ `MagnifierApp.svelte` |
| 7 | vmemos(voice memos) | VoiceMemosApp 296 | lib/voiceMemos | ✅(列表面) | 录音需真机 | ✅ `VoiceMemosApp.svelte` |
| 8 | messages | CommsApps (MessagesApp ~197) | lib/messages | ✅ | 无 | ✅ `MessagesApp.svelte` |
| 9 | phone (dock) | PhoneDialer 495 | lib/phone + calllog + contacts + backend | ✅(离线UI) | 真实拨号/录音/in-call 需真机 daemon | ✅ `PhoneApp.svelte`（离线路径测绿，真机拨号待验收）|
| 10 | music | CommsApps (MusicApp ~220) | lib/music | ✅ | 无 | ✅ `MusicApp.svelte` |
| 11 | mail | MailApp 502 | lib/? | ✅ | 无 | ✅ `MailApp.svelte` |
| 12 | reminders | RemindersApp 733 | lib/reminders | ✅ | 无 | ✅ `RemindersApp.svelte` |
| 13 | photos | apps.tsx ~420 | lib/photos + cameraCapture | ✅ | 视频帧缩略图(MediaStore)设备侧 | ✅ `PhotosApp.svelte` |
| 14 | camera | CameraApp 857 | lib/camera + cameraCapture | ✅(离线壳) | 真机取景/录像待验收 | ✅ `CameraApp.svelte` |
| 15 | android | AndroidApp 164 | lib/android/lmk | ✅(离线壳) | LMK/后端 | ✅ `AndroidApp.svelte` |
| 16 | ai | BackendApps 952 | lib/aiEngine/providers/backend + lib/stream + lib/voice | ✅(离线壳) | 实时对话/语音/daemon 需真机 | ✅ `AiApp.svelte` |
| 17 | interpreter | BackendApps | lib/interp | ✅(离线壳) | 实时麦/daemon 需真机 | ✅ `InterpApp.svelte` |
| 18 | store(app store) | StoreApp 152 | lib/backend | ✅(离线+目录) | daemon 需真机 | ✅ `StoreApp.svelte` |

> 注：dock 底栏应用 = phone / messages / ai / interpreter / mail，也在此清单内。

## 每屏迁移 checklist（照抄即固化样板）

1. **读取** React FC → 拆出所需**纯逻辑 lib**（不重写）。
2. **新建** `src/svelte/<App>.svelte`（runes `$state`/`$derived`/`$effect`）：
   - 纯逻辑复用 lib；store 持久化走 `readStoreValue/writeStoreValue` 或 `createStoreValue`；
   - i18n 读响应式 `t`/`locale`（`locale.svelte.ts`）；
   - **不 import React**：`components/ui.tsx` 里 `chip/GROUP/btn` 等字符串助手就地内联；`Segmented`/`Switch` 用 Svelte 迷你版；
   - 若用 `$state(initFn)`：**先算初值再传值**（`$state` 不惰性调用函数）。
3. **接线** `apps.tsx`：`load<App>` loader + `<App>Entry = svelteEnabled() ? <SvelteAppHost …/> : <React<App>/>`，`COMPONENTS[<id>]=<App>Entry`（React 体保留作 bun 回退）。
4. **测试**：
   - `svelte-tests/<app>.svelte.test.ts`（UI 关键交互，vitest）；
   - `svelte-tests/<app>-parity.test.ts`（React↔Svelte 一致性，若有价值且可驱动）。
5. **验证**：`bun run test:svelte`、`typecheck:svelte`、`tsc`、`vite build`、`bun run test`（bun 全绿）→ `npm run bundle:report` 记体积。
6. **收尾阶段**（数屏完成后）：删除该 React 实现体 + 其 `src/__tests__/*dom*`，把该覆盖并入 vitest；`bun.lock` 刷新。

## 体积跟踪
迁移每屏后跑 `npm run bundle:report`（见 `SVELTE_MIGRATION_DATA.md`）。当前 Svelte 按需 ≈ gzip 13.7 kB（4 屏）；删除 React 体后主包开始真正下降。

## 当前决定（基线外 · 后续独立任务）

在本对话中**已迁到全绿的 10 屏**：calculator / weather / contacts / privacy(permissions) / clock / messages / music / notes / files / photos（vitest 71、svelte-check 0/0、tsc、build、bun 零回归）。

**Reminders（`RemindersApp.svelte`）已在本任务接续迁到全绿**：733 行 React 体 → Svelte 5（runes），纯 `lib/reminders.ts` 全复用；`apps.tsx` 加 `loadReminders` + `RemindersEntry`（PROD 走 Svelte / React 留作 bun 回退）；新增 `svelte-tests/reminders.svelte.test.ts`(4) + `reminders-parity.test.ts`(2, React↔Svelte)；vitest 升到 **83**，`RemindersApp` 按需 chunk gzip ≈7.7 kB，bun-iso/tsc/svelte-check 0/0 零回归。

**Mail（dock 应用，`MailApp.svelte`）也已迁到全绿**：502 行 React 体 → Svelte 5，经 `lib/backend.ts` 的 `amos-mail` 桥（与 React 同桥）；离线走本地化 banner、在线经 fake 桥测 INBOX 列表/阅读/compose 校验，未读 INBOX 镜像为 dock 通知（`amos.notifications`）；新增 `svelte-tests/mail.svelte.test.ts`(3) + `mail-parity.test.ts`(2, React↔Svelte)；vitest 升到 **88**，`MailApp` 按需 chunk gzip ≈4.0 kB，bun-iso/tsc/svelte-check 0/0 零回归。

**全部已注册 dock/主屏 app 均已迁到 Svelte 并接线（PROD 切 Svelte）；React 体一律保留作 bun 回退。** 后续只剩「减法期」：真机逐屏验收通过后删除对应 React 实现体及其 `src/__tests__/*dom*`，把覆盖并入 vitest。

> **减法期进度（首刀已完成，2026-09-07）**：**calculator** 的 React 实现体已删除（`apps.tsx` 内联 FC + 专用 import），`CalculatorEntry` 直接 mount Svelte、无回退；其 happy-dom `calculator-dom.test.tsx` 与 `calculator-parity.test.ts` 删除，±/AC→C 覆盖并入 `svelte-tests/calculator.test.ts`。calculator 成为第一个「纯 Svelte」屏（主包剔除其字节）。

> **减法期之二：weather（2026-09-07）**：`apps.tsx` 天气 React FC（~106 行 + 专用 `lib/weather` import）已删除，`WeatherEntry` 直接 mount Svelte、无回退；happy-dom `weather-dom.test.tsx` 与 `weather-parity.test.ts` 删除，新增城市持久化覆盖并入 `svelte-tests/weather.svelte.test.ts`。weather 成为第二个「纯 Svelte」屏。


> **减法期之三：privacy/permissions（2026-09-07）**：`components/PermissionsApp.tsx`(React 整文件 ~213 行) 已删除，`PermissionsEntry` 直接 mount Svelte、无回退；`permissions-parity.test.ts` 删除（离线行为已被 `permissions.svelte.test.ts` 覆盖，无 React happy-dom 测试）。permissions 成为第三个「纯 Svelte」屏。备注：**contacts 暂不减法**——其 React DOM 测试含桥接耦合的拨号/Recent/Frequent/通知与 Edit 行为，Svelte 版对这些的覆盖未齐，须待补齐后再减。



> **减法期之四：files（2026-09-07）**：核对 Svelte 版 Files 与 React 版功能一致（含 multi-select 批删）后，删除 `components/FilesApp.tsx`(React ~478 行)，`FilesEntry` 直接 mount Svelte、无回退；multi-select 批删覆盖并入 `svelte-tests/files.svelte.test.ts`(3→5)，删 `files-parity.test.ts` + `files-select.test.tsx`，`app-render.test.tsx` 移除 files 条。files 成为第四个「纯 Svelte」屏。


> **HomeDock（主屏容器本身，非 app 屏）已迁到 Svelte 5 并接线（2026-09）**：把 home 主屏（小组件+4×3 分页图标网格+单行底部 dock 栏+徽标/DND/横滑翻页/HTML5 拖拽重排/软启动脉冲）从 `components/HomeDock.tsx`(React) 迁到 `src/svelte/HomeDock.svelte`(runes)；同时新增两个「受控屏」通用基建并复用：
> - **`lib/appIcon.ts`**（框架无关纯模块）：色调/确定性渐变/9 组 bespoke SVG 字形收敛为单一真相源，React `AppIcon.tsx` 与 `src/svelte/AppIcon.svelte` 同源渲染（消除双实现漂移=审计头号回归源）；已在产物 CSS 验证无 Tailwind 裁类。
> - **`src/svelte/propsBus.ts` + `components/SveltePropsHost.tsx`**：通用 React⇄Svelte「受控屏」通道（下行 `svelte/store` 原位推 props、不重挂不丢内部态；上行事件回传；卸载 dispose）。因 Svelte 5 **无 `$setProps`**，HomeDock 走该通道接收 `{layout,ext,pulseId}`、回传 `open/move/search`；`App.tsx` home 分支 `svelteEnabled()? SveltePropsHost : HomeDock`（PROD 走 Svelte / bun·dev 走 React），壳仍为 React（保留 lock/app/edit/sheets 编排）。另补 React 原版行为对齐：网格缩小时 `gridPage` 收敛（防再扩容自动回跳）。
> - 测试：`appIcon.test.ts`、`propsBus.test.ts`、`svelte-props-host.spec.test.ts`、`home-dock.svelte.test.ts`、`home-dock-parity.test.ts`；vitest **164**、svelte-check 0/0、tsc clean、bun-iso OK、build 产出 `HomeDock` 按需 chunk(gzip ≈3.94 kB)。诚实边界：真机像素/手势需 S5 验收后进入「减法期」删除 React `HomeDock` 体。
>
> > **受控屏基建已复用于主屏布局编辑 `EditHome`（`EditHome.svelte`，channel "editHome"，2026-09）**：72 行 React 体 → Svelte 5，同样「壳持有 `layout`、Svelte 用共享纯 `hideFromHome`/`restoreToHome` 算下一版 `layout` 并 `emit('change')` 回传、壳持久化回推」闭环；`App.tsx` editMode 分支 `svelteEnabled()? SveltePropsHost : EditHome`。测试 `edit-home.svelte.test.ts`(5) + `edit-home-parity.test.ts`(3) → vitest **172**、svelte-check 0/0、tsc clean、build 产出 `EditHome` chunk(gzip ≈1.27 kB)。证明该基建对多屏可复用；React `EditHome` 体保留作 bun 回退（减法期待真机验收后删除）。


> **ai 已迁到全绿并接线（`AiApp.svelte` + 两个语音子组件，PROD 切 Svelte）**：`BackendApps.tsx` 的 React `AiApp` → Svelte 5(runes)；`src/svelte/VoiceMicButton.svelte`（tap-to-record→ASR WAV 转写）与 `src/svelte/StreamVoiceButton.svelte`（按住说话流式语音，`assistant_voice_start/feed/end` + `assistant-voice-event` turn_done）同步移植。纯逻辑全复用 `lib/backend`（chat/session/history/voice RPC）+ `lib/stream`(token/card/session parsers) + `lib/voice`(状态机/ASR 解析/WAV/PCM 助手)。chat_agent 流式 token + 语义 UiCard(天气/音乐/备忘等)落地；会话/历史面板、清空(两段确认)/复制回答/重发/新建会话/停止接线齐全。离线(无 Tauri 桥)自动降级：in-browser 提示、发送时回显用户行 +「未连接守护进程」说明而非静默、会话面板空态。测试 `svelte-tests/ai.svelte.test.ts` 6 例 + `voice-buttons.svelte.test.ts` 2 例 + `ai-parity.test.ts` 1 例（React↔Svelte 离线 shell 一致：banner/占位/会话空态），vitest 升到 **145**，svelte-check 0/0，bun-iso OK，build 产出 `AiApp` 按需 chunk（gzip ≈6.32 kB）。实时对话/ASR/流式语音需真机 + amos-ai daemon 验收。

> **interpreter 已迁到全绿并接线（`InterpApp.svelte`，PROD 切 Svelte）**：`BackendApps.tsx` 的 React 体 → Svelte 5(runes)，纯逻辑全复用 `lib/interp.ts`（语言目录、语言对+自动朗读偏好、可持久化译文记录都写同一共享 store，双端互通）+ `lib/backend.ts` 的 `interpret_*` RPC。离线(无 Tauri 桥)自动降级：显示 in-browser 提示、开始/发送给「未连接守护进程」提示而非静默 no-op、偏好与记录照常持久化。在线路径：订阅 `interpret-output` 事件流 → partial/segment_final/utterance/session_ended/error 分类落地 + 自动朗读（`speakText`）+ 结束清麦；两段式麦克风授权（再点允许）与实时 16k 音频喂 `interpret_audio`。顺修一个 Svelte 陷阱：持久化 `$effect` 只读整个 `prefs` 对象无法感知嵌套 `bind` 修改——改为逐字段读取 `prefs.source/.target/.autospeak` 以正确重触发；语言 `<select>` 用显式 `onchange` 替换对象。测试 `svelte-tests/interp.svelte.test.ts` 6 例（偏好恢复+变更持久化、译文记录渲染/清空/空态 copyAll 禁用、离线开始/发送提示），vitest 升到 **136**，svelte-check 0/0，bun-iso OK，build 产出 `InterpApp` 按需 chunk（gzip ≈3.74 kB）。React 体保留作 bun 回退（实时麦/daemon 需真机验收）。

> **camera 已迁到全绿并接线（`CameraApp.svelte`，PROD 切 Svelte）**：857 行 React 体 → Svelte 5(runes)，纯逻辑全复用 `lib/camera.ts` + `lib/cameraCapture.ts`（拍照落 `lib/photos` store、录像走二进制 MediaStore、默认授权即取景、翻转/闪光/网格/定时/变焦(点按+滑块+双指捏合)/画质/连拍/录像库增删播覆盖层一应俱全）。另修一个 React 原版的开屏竞态：首次取景在 feed 就绪后才挂载 `<video>`，Svelte 版用 `$effect` 在元素 bind 后补接 `srcObject`（React 版在空元素上赋流被跳过）。测试 `svelte-tests/camera.svelte.test.ts` 6 例（无摄像头演示壳 + stub `getUserMedia` 的实时快门落盘/网格/连拍/画质重取流 + stub `MediaRecorder` 的录像入库），vitest 升到 **127**，svelte-check 0/0，bun-iso OK，build 产出 `CameraApp` 按需 chunk（gzip ≈5.96 kB）。React 体保留作 bun 回退。

> `reminders`、`mail`（dock）、`settings`（全部 9 组）、`maps`（离线）、`vmemos`（列表面）、`magnifier`（控制面）、`android`（离线壳）与 `store`（离线+目录）已迁到全绿并接线，移出本表（真机 daemon 侧验收待续）。

> **settings 全量迁移已完成并接线（`SettingsApp.svelte` + 子面板，PROD 切 Svelte）**：全部 9 组——外观/语言/自动息屏/唤醒 + iCloud + AI后端 + SensorPanel/SystemPanel/TaskManager/LmkDebugPanel + WallpaperCard/LockWallpaperCard + LockSettings。测试 `settings(4)+wallpaper(3)+monitor(4)+lmk(2)+settings-parity(1)`，vitest 102，svelte-check 0/0，bun-iso OK，build 产出 `SettingsApp` 按需 chunk(gzip ≈10.2 kB)。React 体保留作 bun 回退。

**逐屏 checklist 已固化**（见本文档顶部"每屏迁移 checklist"），Files/Photos 已示范"回合1 可编译 WIP → 后续接线+测试、全程基线保绿"。在能容纳一次性整份大组件并本地全量验证的环境中，按 checklist 即可把这些屏迁到全绿。

