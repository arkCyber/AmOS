# Amos — 需求 → 代码 → 测试 可追溯矩阵（轻量 DO-178C 风格）

> 目的：把“功能/非功能需求”与“实现文件”和“验证（单测/命令）”显式对应，便于任何一次改动可回查它覆盖了哪条需求、由哪条测试保护。
> 约定：`REQ-<编号>`。矩阵分两类——**A 应用/OS 功能**、**B 稳健性与安全（对应审计 §8 处置）**。
> 状态：✅ 已实现并有测试保护；🟡 已实现、测试待补；⬜ 待办。

---

## A. 系统 UI / 应用功能

| 需求 ID | 描述 | 设计 / 代码 | 验证（测试/命令） | 状态 |
|---|---|---|---|---|
| REQ-A1 | 主屏布局可分页/dock/隐藏，可拖拽排序并持久化 | `lib/amosStore.ts`（`getLayout/moveBefore/hideFromHome/…`）、`HomeDock.tsx`、`EditHome.tsx` | `__tests__/amosStore.test.ts`、`__tests__/dock-drag.test.tsx` | ✅ |
| REQ-A2 | 应用注册表：图标→组件一一对应；未知 id 有占位 | `apps.tsx`（`APPS`/`COMPONENTS`/`AppComponent`） | `__tests__/app-render.test.tsx`（SSR 逐个渲染不抛错） | ✅ |
| REQ-A3 | 主题（浅/深/自动）与 i18n（中/英）本地化 | `theme/`、`i18n/` | `theme.test.ts`、`i18n.test.ts`（键一致性） | ✅ |
| REQ-A4 | 备忘录：增删 + **编辑**已有便签 | `lib/notes.ts`（`editNote`）、`apps.tsx` Notes | `notes.test.ts` | ✅ |
| REQ-A5 | 信息：收发（含**单条删除**与整段清空） | `lib/messages.ts`、`CommsApps.tsx` | `trio.test.ts`（messages 段） | ✅ |
| REQ-A6 | 电话：拨号（退格/清空/**号长上限**） | `lib/phone.ts`、`CommsApps.tsx` | `trio.test.ts`（phone 段） | ✅ |
| REQ-A7 | 音乐：播放/上首/下首、**删除曲目**、空歌单不崩 | `lib/music.ts`（`removeTrack/nextIndexAfterRemoval`）、`CommsApps.tsx` | `trio.test.ts`（music 段） | ✅ |
| REQ-A8 | 相机：实时取景/拍照，**权限被拒可重试**、无摄像头降级 | `components/CameraApp.tsx` | `__tests__/camera.test.tsx` | ✅ |
| REQ-A9 | 地图：城市搜索/定位/缩放 + **拖拽平移与方向键** | `lib/maps.ts`（`tileToLatLon/panTiles/shiftCenter`）、`MapsApp.tsx` | `__tests__/maps.test.ts` | ✅ |
| REQ-A10 | 网络状态**响应式**（地图等据此降级） | `lib/useOnline.ts`、`MapsApp.tsx` | `__tests__/useOnline.test.tsx` | ✅ |
| REQ-A11 | 长会话（AI 消息/同传译文）**有界**、持久化同样封顶 | `lib/bounded.ts`、`components/BackendApps.tsx` | `__tests__/bounded.test.ts` | ✅ |
| REQ-A12 | 文件管理器：增删改移、面包屑、循环防护 | `lib/files.ts`、`components/FilesApp.tsx` | `__tests__/files.test.ts` | ✅ |
| REQ-A13 | 锁屏 / 最近使用 / 搜索 / 通知中心焦点管理 | `SystemPanels.tsx`、`useFocusTrap.ts` | `focus-trap/panels-focus/lock` 等 | ✅ |
| REQ-A14 | 备忘录进阶：搜索 / 归档与“最近删除”(恢复) / 置顶 / **字数统计** / **任务清单(勾选)** | `lib/notes.ts`（`searchNotes/setNoteState/orderPinned/noteStats/tasksOf/toggleTaskInText`）、`apps.tsx` Notes | `notes.test.ts` | ✅ |
| REQ-A15 | 相册进阶：多选批量删除 / 查看器(前后·方向键) / 幻灯片 / 设为壁纸 / **收藏(♥)+筛选** / **分享(复制摘要)** | `lib/photos.ts`（`removePhotos/neighborOf/toggleFav/favsOf/shareCaption`）、`apps.tsx` Photos | `photos.test.ts`、`photos-keys.test.tsx` | ✅ |
| REQ-A16 | 时钟进阶：世界城市 / 秒表 / 倒计时 / **闹钟**(再响·铃声·每周重复·修复同分钟复响) | `lib/time.ts`（`stopwatch/timer/alarm` reducer、`alarmKey/dayAllowed/…`）、`apps.tsx`（Clock/StopwatchCard） | `time.test.ts`、`clock.test.tsx` | ✅ |
| REQ-A17 | 计算器：**历史记录** / **物理键盘输入** | `lib/calculator.ts`（`calcEntry/addHistory/calcFromKey`）、`apps.tsx` Calculator | `calculator.test.ts`、`calculator-dom.test.tsx` | ✅ |
| REQ-A18 | 音乐进阶：删除 / **循环模式** / **进度拖拽(可键盘)** / **同步歌词** | `lib/music.ts`（`nextIndex/pctProgress/seekSeconds/DEMO_LYRICS/lyricIndex`）、`CommsApps.tsx` | `trio.test.ts`（music 段） | ✅ |
| REQ-A19 | 文件进阶：收藏 / 最近 / 搜索·排序 / **多选(删除·全选·移动)** | `lib/files.ts`（`deleteEntries/moveEntries/toggleFav/recentFiles/searchFiles`）、`FilesApp.tsx` | `files.test.ts`、`files-select.test.tsx` | ✅ |
| REQ-A20 | 信息进阶：日分组 / 已读·未读 / 左滑删 / **引用回复** | `lib/messages.ts`（`appendQuote/markRead/…`）、`CommsApps.tsx` | `trio.test.ts`（messages 段） | ✅ |
| REQ-A21 | 天气 ℃/℉ + **多城市切换**；设置 **iCloud 云开关+本地备份快照** | `lib/weather.ts`（`adjustForecast/WEATHER_CITIES`）、`lib/cloud.ts`（`readCloud/snapshotStores`）、`apps.tsx` | `weather.test.ts`、`settings.test.ts` | ✅ |
| REQ-A22 | AI 推理后端 **本地/云端一键切换**（DeepSeek 预设）+ Settings 显示当前后端 | `lib/providers.ts`（`readAiConfig/setAiConfig/envFor`）、Settings“AI 推理后端”卡、Tauri `ai_backend_switch`（`scripts/ai-backend.sh`） | `providers.test.ts`；live `chat_once`/`translate_once` | ✅ |
| REQ-A23 | 云端 key **不明文进前端**：0600 落盘 + 恢复复用 | `setAiConfig` 不存 `apiKey`；`ai_bridge` 写 `~/.amos/ai.key`(0600)；`ai-backend.sh` 持久化/回读 | `providers.test.ts`（key 不落设置）；`ls -l` 0600 实证 | ✅ |
| REQ-A24 | 生产后端编排与监管：`run-backends.sh` / `supervise-backends.sh`（supervisor 崩溃自动拉起·SIGUSR1 热重启·持久化后端配置） | `scripts/run-backends.sh`、`scripts/supervise-backends.sh`、`scripts/ai-backend.sh`、`amos-supervisor` | `bash -n`、`--print-config`、`supervisor-smoke.sh` | ✅ |
| REQ-A25 | 真实语音 native：gated 构建（sherpa ASR + Piper TTS）+ 本地模型 | `amos-tauri --features sherpa-asr,piper-tts`；模型 `models/sherpa-en-20m`、`models/piper-low`；`scripts/run-ui-release.sh` | `cargo build` exit 0；`cargo test -p amos-tauri --features sherpa-asr --lib -- --ignored local_sherpa_pipeline_selects_when_configured` ok（配好模型时真选 sherpa）；release 内嵌 UI 运行（不占 1420）；live `chat_once`/`translate_once` | ✅ |
| REQ-A26 | 持久化存储坏档归一化（备忘录/文件/相册/信息/音乐/设置/通知）+ 设置读写护栏 | `lib/{notes,files,photos,messages,music,settings,cloud,providers}.ts` 各 `normalize*`；加载先归一化 | 各 `*normalize*` 单测（畸形/缺 id/重复 id/null/primitive/非对象写） | ✅ |
| REQ-A27 | 稳健性测试：文件子树环 / 搜索排序极端 / 备忘录病态与 CRLF | `__tests__/files.test.ts`、`notes.test.ts`（pathOf/isInside/delete/move 环不挂、5000 条搜索排序、病态标记、CRLF 结构断言） | 上述单测文件 | ✅ |

---

## B. 稳健性 / 安全（与审计 §8 处置对应）

| 需求 ID | 描述 | 实现 | 验证 | 状态 |
|---|---|---|---|---|
| REQ-B1 | 遥测不伪造：未采集必须上报 `None`（**P0-3**） | `amos-ai/…/real.rs`（`BackendStats` 全 `Option`） | `cargo test -p amos-ai`（`stats_report_unknown…`） | ✅ |
| REQ-B2 | 存储损坏不静默丢失：告警 + 隔离备份（**P1-1**） | `lib/amosStore.ts`（`quarantineCorrupt`） | `amosStore.test.ts`（P1-1 段） | ✅ |
| REQ-B3 | IPC 失败保留根因分类（**P0-2 阶段一**） | `lib/backend.ts`（`bridgeDiag`） | `backend.test.ts`（结构化诊断） | ✅ |
| REQ-B4 | 索引越界编译期检查（**P1-5**） | `tsconfig.json`（`noUncheckedIndexedAccess`）+ 49 处修复 | `tsc --noEmit` 0 error + `bun test` | ✅ |
| REQ-B5 | `loop{}` 无无界忙等，均有终止（**P1-6**） | 见报告 §9（只读审计） | 人工核查表 §9 | ✅ |
| REQ-B6 | 生产代码禁 `unwrap/expect/panic`（**P0-1 阶段一批**） | `amos-wm/amos-tts/amos-asr` 顶部 `cfg_attr(not(test), deny(…))` | `cargo clippy -p <crate> --all-targets/--all-features -- -D warnings` | ✅（该 3 crate） |
| REQ-B7 | TS 核心 `src/lib` 行覆盖率 ≥ 90%（**P2-1**） | `scripts/lib-coverage-gate.mjs` + `package.json` + `Makefile cov` + CI | `make cov`（97.72% ≥ 90%） | ✅ |
| REQ-B8 | 核心 `src/lib` 纯逻辑均有单测覆盖 | `__tests__/` 各文件 | `bun test`（245 用例 / 37 文件全绿）；覆盖 ≥90% | ✅ |
| REQ-C1 | Rust 生产 `unwrap/expect/panic` 全面收敛 + 全 crate 门禁（**P0-1 收敛**） | 8 个 crate `lib.rs` 均加 `cfg_attr(not(test), deny(clippy::unwrap_used/expect_used/panic))`：amos-ai/int/tauri/android/supervisor/translate/asr/tts；`amos-proto`(tonic 生成代码) 与 `amos-int-cli`(交互 CLI) 属合理排除 | `make lint`（`clippy --workspace --all-targets -D warnings`）通过 | ✅ |
| REQ-C2 | 内存应用超时会话清理收尾（**P1-3/P1-4 收尾**） | `amos-ai`：`SessionManager::cleanup_interval()` + `server::new()` 常驻 spawn 周期清扫；活动经 `touch()` 保活 | `cargo test -p amos-ai`（`touch_keeps_active_session_alive`、`background_sweeper_reaps_stale_periodically` 等 13 项通过）；clippy 干净 | ✅ |

---

*生成日期 2026-09；与 `docs/AEROSPACE_SOFTWARE_AUDIT.md` §8/§9 对应。新增需求时请继续编号并回填“设计→验证”列。*
