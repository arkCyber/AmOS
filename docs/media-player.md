# AmOS 本地多媒体播放器 — `PlayerApp`（音乐 + 视频）

**日期**: 2026-09-10 · **范围**: `frontend-ts/src/lib/player.ts` + `frontend-ts/src/svelte/PlayerApp.svelte`
**状态**: ✅ 已落地（host 可测；真机走既有 `media_*` 桥）

> 本文描述 **本地** 多媒体播放器：播放设备上的真实音频/视频文件，以及 AmOS 自身
> 已经持有的本地媒体（语音备忘录、相机录像）。所有分类 / 队列 / 走带数学都在纯函数
> `lib/player.ts` 中一次实现、一次单测；屏幕只负责把当前曲目解析成可播放的 object URL
> 并驱动单个 `<audio>`/`<video>` 元素。

## 1. 解决什么断层

既有 `MusicApp` 是**纯演示**：曲目是内存里写死的中文标题、播放头靠 1 s `setInterval`
推进，**不产生任何声音**，也没有视频能力。本播放器补上三件事：

1. **真·本地播放**：`media_*` 桥列出的真实文件 → 读字节 → Blob → `<audio>`/`<video>`；
2. **音频 + 视频统一**：一个队列、一套走带（随机 / 循环 / 进度 / 音量 / 全屏）；
3. **诚实边界**：无桥离线、后端拒绝、内容缺失、文件过大——每一种都渲染成**显式状态**，
   绝不伪装成“空歌单”或“可播放”。

## 2. 架构（数据流）

```text
                 ┌── media_list(music|movies|camera|recordings|download) ┐  ┌─ MediaItem ─┐
 本地媒体来源 ────┤── amos.vmemos（语音备忘录：seed 合成 / recorded 字节）┼─▶│ PlayerTrack │
                 └── amos.captures（相机录像：媒体库字节）──────────────┘  └────────────┘
                                                                               │
                              buildOrder / stepOrderPos（纯函数，可单测）        │ 一个队列
                                                                               ▼
  PlayerApp.resolve(track) ── media_load→Blob / WAV 合成 / mediaStore.get ──▶ object URL
                                                                               │
                                             单个 <audio> | <video>（按 kind） ◀┘
```

| 层 | 文件 | 职责 |
|---|---|---|
| 纯模型 | `lib/player.ts` | `kindFromName`/`mimeForPlayable`（分类）、`trackFromItem/Memo/Capture`（归一到 `PlayerTrack`）、`mergeTracks`（去重）、`buildOrder`（洗牌）、`stepOrderPos`/`skipMode`（走带）、`fmtSeconds`（标签）、`isTooLarge`（有界） |
| 屏幕 | `svelte/PlayerApp.svelte` | 扫描三个来源 → 合并队列；把当前曲目解析为 object URL（并在切换时 **revoke**）；驱动媒体元素与走带 UI |

**为什么分类只看“扩展名 + MIME”**：`MediaProvider` 的 `kind` 是**集合默认值**（HostFs 用
`dir.default_kind()`，`Download` 里的歌会被标成 `file`），因此**不能**用来判断“能不能播”。
`player.ts` 以具体 MIME 优先、扩展名兜底，任何非音视频（图片/PDF/未知）**不进队列**，
所以歌单里不可能出现一行点了没反应的条目。

## 3. 可播放分类（决策表）

| 输入 | 结果 | 依据 |
|---|---|---|
| `song.mp3` / `clip.MP4` | `audio` / `video` | 扩展名（大小写不敏感） |
| `x.bin` + `mime=audio/mpeg` | `audio` | **具体 MIME 优先于扩展名** |
| `a.mp3` + `mime=video/mp4` | `video` | 同上（MIME 更可信） |
| `song.mp3` + `mime=application/octet-stream` | `audio` | 泛化 MIME 回退到扩展名 |
| `x.jpg` / `x.pdf` / 无扩展名 / `.mp3`（隐藏文件） | `null` | 不入队列 |

## 4. 走带模型（重复 / 随机 / 步进）

- 播放顺序 = `order: number[]`（曲目下标）。未随机时是恒等序；随机时是 **Fisher–Yates**
  置换，`rng` **可注入** → 测试确定性（纯函数契约）。
- `stepOrderPos(pos, len, delta, mode)`（**全域、无 NaN、无越界**）：
  - `"one"`：原地不动（调用方重播当前曲目）；
  - `"all"`：双向环绕；
  - `"off"`：到端点即 `stop`（列表首按“上一个”/列表尾按“下一个”不越界）。
- **手动跳曲**用 `skipMode(repeat)`：把 `"one"` 映射成 `"all"`，于是“随机/单曲循环”下
  用户按“下一个”**一定**会换歌（而不是像旧 `MusicApp` 那样“卡住不动”）。
- 曲终自增用原始 `repeat`（单曲循环重播、列表循环环绕、关循环在尾部停）。

## 5. 有界资源与诚实失败（航空航天红线）

| 约束 | 实现 |
|---|---|
| **有界内存** | `MAX_PLAY_BYTES = 256 MiB`：`isTooLarge(size)` 命中即拒绝缓冲并渲染 `player.tooLarge`，**绝不**无界分配（Power-of-10 #3）。 |
| **对象 URL 生命周期** | 每次切曲在 `$effect` 的清理里 `URL.revokeObjectURL`（含“解析期间又切歌”的竞态：已取消分支也会回收自己刚建的 URL）。 |
| **失败可见** | 读字节/取 Blob 失败 → `player.unavailable`；媒体元素 `error` → `player.playbackError`；均**显式渲染**，不静默。 |
| **拒绝不伪装** | 桥在授权拒绝时 `media_list` **reject**；屏幕记为 `denied`，此时**即使库为空也不回退到示例曲**，而是渲染“内容不可用”——沿用 `lib/media.ts` 的既有契约（绝不把拒绝塌缩成空歌单）。 |
| **无挂起** | 扫描用 `Promise.allSettled`；单个集合失败不影响其余来源；媒体元素 `play()`/`pause()`/`requestFullscreen()` 全部 try/catch（无头 DOM 不炸渲染）。 |
| **空库可用** | 无桥且无本地媒体时回退到**合成 WAV 示例**（`demoTracks()`，真能出声），仅在**确为空**时出现。 |
| **刷新不打断** | `refresh()` 重新扫描会替换曲目对象；解析器以 **track id**（`$derived trackId` + `untrack` 读当前对象）为依赖，**同 id 不重载、不重启播放**（否则每次刷新都会把播放头清零）。 |
| **并发扫描** | `scanSeq` 世代令牌：一次较慢的旧扫描返回时若已被更新的扫描取代，则**丢弃自己**，绝不用旧结果覆盖新结果。 |
| **会话恢复** | `amos.player` 持久化「轨道 id / 播放头 / 音量 / 静音 / 循环 / 随机」；播放头**粗粒度节流**（`shouldSavePosition`，约 5 s/次，避免每 tick 写库）；恢复按 **id 精确匹配**（切歌不会误用旧时间戳），`resumePosition` 把「已听完」的位置归 0。 |
| **系统媒体会话** | `mediaSession.ts` 注入式封装：存在 `navigator.mediaSession` 时发布元数据/播放态/锁屏把手（play/pause/上下一首/seek），不存在或宿主抛错都静默 no-op——**绝不把不支持当作播放失败**。 |

## 6. 需求 → 测试追踪矩阵

| 需求 / 行为 | 测试证据 | 位置 |
|---|---|---|
| 扩展名/MIME 分类；非媒体不入队 | `classifies by extension, case-insensitively` / `rejects non-media files` / `a specific MIME outranks a misleading extension` | `src/__tests__/player.test.ts` |
| blob MIME 选择 | `picks a usable blob MIME…` | 同上 |
| 有界缓冲（`MAX_PLAY_BYTES`） | `rejects only sizes above the ceiling` | 同上 |
| 三个来源归一 + 目录标签 | `trackFromItem keeps only playable audio/video…` / `trackFromMemo / trackFromCapture…` | 同上 |
| 队列去重/保序 | `mergeTracks concatenates in order and drops later duplicates` | 同上 |
| 示例曲确定性 | `demoTracks is deterministic, audio-only, and uniquely keyed` | 同上 |
| 随机序是置换 + RNG 健壮 | `shuffle yields a deterministic permutation (valid for any rng)` | 同上 |
| 顺序查询全域 | `posOfTrack / currentTrackIndex are total` | 同上 |
| 循环/步进语义（one/all/off/空） | `transport stepping (stepOrderPos / skipMode)`（5 例） | 同上 |
| 时钟标签无 NaN/负值 | `formats clock labels and never emits NaN/negatives` | 同上 |
| 空库示例歌单 + 传输控件 | `no bridge + empty library → demo playlist…` | `svelte-tests/player.svelte.test.ts` |
| 播放/暂停切换 | `play button toggles to pause` | 同上 |
| 下一首换曲 | `next changes the current track` | 同上 |
| 备忘录 + 相机视频聚合、视频换 `<video>` 舞台 | `aggregates voice memos + camera video captures` | 同上 |
| 桥拒绝**不**被示例曲掩盖 | `a bridge denial is surfaced, not masked by demo clips` | 同上 |
| 注册进 APP_META / Svelte registry / 媒体分组 | `appMeta.test.ts`（27）/ `app-registry.svelte.test.ts`（27） | `src/__tests__`、`svelte-tests` |
| 刷新保留当前曲目（按 id 查找） | `player: rescan preservation (indexOfTrackId)`（2 例） | `src/__tests__/player.test.ts` |
| 刷新拾取新增媒体 | `rescan picks up media added while the player is open` | `svelte-tests/player.svelte.test.ts` |
| 刷新**不重建**当前曲目 URL（不重启播放） | `rescan keeps the active track (does not recreate its object URL)` | 同上 |
| 视频曲目渲染 `<video>` + 类型徽标 | `a seeded video capture renders a video stage + video kind chip` | 同上 |
| 会话归一化 / 夹取 / 往返 / 坏档 / 节流 | `playerPrefs.test.ts`（**10 例**） | `src/__tests__/playerPrefs.test.ts` |
| 速度循环 + 标签（总函数） | `player.test.ts` 的 `playback speed`（4 例） | `src/__tests__/player.test.ts` |
| 恢复位置（含「已听完」归 0） | `player.test.ts` 的 `resume position`（2 例） | 同上 |
| 媒体会话元数据 / 把手 / 清理 / 宿主抛错 no-op | `mediaSession.test.ts`（**7 例**） | `src/__tests__/mediaSession.test.ts` |
| 恢复播放头（DOM） | `restores a saved playhead on the matching track` | `svelte-tests/player.svelte.test.ts` |
| 速度按钮循环（DOM） | `the speed button cycles through the presets` | 同上 |
| 重试重新解析（DOM） | `retry re-resolves a track whose bytes were missing` | 同上 |

**工程红线**：纯逻辑零 DOM 依赖、全域返回（无 throw/NaN/越界）；组件用 Svelte 5 runes，
`$effect` 全部带清理；`tsc` / `svelte-check` 0 error 0 warning；lib 覆盖率门禁 ≥90%（实测 93.85%）。

## 7. 验证（本轮实测）

- `bun run typecheck` → 0 error
- `bun run typecheck:svelte` → **0 error / 0 warning**
- `bun run test`（bun ISO）→ `EXIT=0`；`player.test.ts` **32 例**、`mediaSession.test.ts` **7 例**、`playerPrefs.test.ts` **10 例**
- `bun run test:svelte` → **455 passed / 59 files**（`player.svelte.test.ts` **11 例**，registry 27）
- `bun run coverage:gate`（`src/lib` 行覆盖）→ **93.8% ≥ 90%**，闸门通过
- Rust：`cargo test -p amos-media`（lib **43** + media_core **24** + 其它 10）、`cargo test -p amos-tauri --lib`（**218**，`media::` **13**）、两 crate `clippy -D warnings` 干净

### 7.1 本轮自审计发现并修复的真实缺陷

1. **刷新会打断播放**：rescan 替换曲目对象 → 解析 `$effect` 因对象身份变化重跑，**重建 object URL 并把播放头清零**。修：以 `$derived trackId` 作为解析依赖（同 id 不重载），测试 `rescan keeps the active track (does not recreate its object URL)` 锁死。
2. **Blob MIME 用错名字**：字节分支用**已去扩展名的标题**去推断 MIME，无具体 MIME 的文件会拿到 `application/octet-stream`。修：改用完整 `item.name`。
3. **循环关闭时曲末卡死**：列表尾 `ended` 后仅置 `playing=false` 却**不回到 0**，再按播放会立刻再次 `ended`。修：停止时 `currentTime=0`。
4. **相机录像不可见**：设备相机视频在 `DCIM/Camera`，原集合列表漏了 `camera`。修：加入 `camera`（照片被分类过滤，不入队）。
5. **并发刷新竞态**：两次快速刷新可能让较慢的旧结果覆盖新结果。修：`scanSeq` 世代令牌。
6. **“读不到”与“空”混淆**：`media_list` 返回 `null`（桥中途消失）原先既不算空也不算失败。修：与 reject 同等记为不可用。
7. **无头 DOM 抛错**：`currentTime` 写入未防护。修：`setTime()` 与 `playEl/pauseEl` 一致的 try/catch。
8. **a11y/死键**：音量滑块误用 `player.seek` 标签；`player.count/audio/video` 三个键闲置。修：新增 `player.volume`/`player.refresh`，实际渲染类型徽标与项目数。

**第二轮（2026-09-11）**：

9. **点击「正在播放」的曲目行是死行**：`selectTrack` 落在同一位置时静默 no-op，看起来像「点了没反应」。修：再次点击**当前行** → 播放头归零并继续播放（仅当字节已解析为 URL；解析失败/过大的行保留各自显式的「重试 / 过大」路径，不伪装成可播）。测试 `clicking the ACTIVE row restarts the same track from the top` 锁死。
10. **过大文件要点进去才知道不可播**：超过 `MAX_PLAY_BYTES` 的 file 条目原先只在点击后才渲染 `player.tooLarge`。修：列表行内即渲染「过大」徽标（`player.tooLargeShort`，中英），诚实边界**前置可见**。测试 `a >MAX_PLAY_BYTES file shows the too-large badge up front` 锁死。
11. **恢复播放头依赖浏览器预加载策略**：`<audio>`/`<video>` 未声明 `preload`，真实浏览器可能推迟元数据 → `onLoadedMetadata`（以及保存播放头的恢复）不确定。修：两元素显式 `preload="metadata"`。

### 7.2 新增能力（全部可离线测试）

- **会话恢复**（`lib/playerPrefs.ts` + 接线）：重开播放器回到**上次的曲目与位置**（按 track id 精确匹配），音量/静音/循环/随机一并恢复；播放头**节流**持久化（~5 s/次）。
- **播放速度**：`PLAYBACK_RATES`（0.5×–2×）循环切换，按钮显示 `formatRate` 标签，应用到 `el.playbackRate`。
- **错误重试**：解析失败后曲目不再是「点了没反应」——错误条提供「重试」，播放键亦会触发重试（`retryNonce`）。
- **系统媒体会话**（`lib/mediaSession.ts`）：锁屏/通知/耳机把手上报元数据与播放态，并接 play / pause / 上一首 / 下一首 / seek；无 API 或宿主抛错均静默 no-op。

### 7.3 真实音乐 / 视频验收（host，实测）

用 **ffmpeg 生成的真实编码素材**（LAME mp3、H.264+AAC mp4、AAC m4a），放入符合 Android 布局的
媒体树后跑领域探针（与播放器同一条 list → 分类 → 有界 load → `read_range` → 范围规划路径）：

```sh
cargo run -p amos-media --example probe_media -- /tmp/amos-real-media
# → 6 files, 4 playable, 0 failures（每个文件：容器魔数匹配 + 窗口逐字节精确 + 206 规划合法）
```

真机素材还**暴露并修掉一个真实缺陷**：`HostFsProvider` 原先按所属集合的默认 kind 报告类型
（`Music` 的默认是 `File`）且 `mime=None`，真实 `.mp3` 会被报成"普通文件"、`.mp4` 落在
`DCIM/Camera` 时被报成"图片"，播放器只剩"按扩展名兜底"能救。现改为**按扩展名推断 kind+MIME**
（未知/无扩展名则保留集合默认且**不伪造 MIME**），于是桥自身就给出真实类型——播放器与文件管理器
都直接受益（详见 `docs/media.md` §7）。前端 `player.test.ts` 新增 5 例，用**这些真实文件名与
bridge 元数据**锁定分类与 blob MIME。

> 未做（诚实）：真正的**解码播放**发生在 WebView 里，无法在无头环境验证；本轮验证的是
> **播放器的数据路径**（列表 → 分类 → 字节 → 范围），真机解码/锁屏控制仍属设备验收项。

### 7.4 桌面启动与真实 UI 验收（macOS 实测）

**启动 UI（本机）**

```sh
# A) 开发态：Vite dev server(:1420) + debug 二进制（快速迭代）
AMOS_UI_FEATURES= scripts/run-gui-dev.sh
# B) 自包含发行态：内嵌 dist、不依赖 dev server
scripts/run-ui-release.sh
# C) 直接跑二进制并**指向真实媒体库**（播放器即可列到真文件）
AMOS_MEDIA_ROOT=/tmp/amos-real-media ./target/debug/amos-tauri
```

原生窗口实测（`osascript` 查询运行中的 app）：

```text
tell application "System Events" to tell process "amos-tauri" to get {name, size} of window 1
→ Amos · AI System UI, 480, 820     # 标题与 tauri.conf.json 的 480×820 一致
```

**真实浏览器 UI 验收（可重复、退出码 0/1）**

```sh
cd crates/amos-tauri/frontend-ts
bun run smoke:ui       # 首页：Svelte HomeDock 四个 marker
bun run smoke:player   # 播放器：经 shell.html?surface=app&id=player 打开
```

实测输出：

```text
[smoke-ui/bun]     markers found: 4/4 in 2s   → UI smoke OK
[smoke-player/bun] markers found: 6/6 in 2s
  PASS  data-icon="play"        PASS  data-icon="rate"      PASS  role="slider"
  PASS  <audio                  PASS  data-icon="rotateCcw" PASS  data-icon="musicNote"
  INFO  demo fallback present: true            → player UI smoke OK
```

`smoke:player` 走的是**真实生产包 + 真实 Chromium**：经 `shell-entry` 的 URL 表面
（`?surface=app&id=player`）挂载播放器，断言传输/变速/进度/媒体元素/重扫/列表 glyph 全部渲染，
并锁定"无 Tauri 桥（纯浏览器）→ 回退到**可发声的合成示例曲**"这条契约。

> 诚实说明：无头检查断言的是**挂载与 DOM**、探针断言的是**字节**；两者都**不声称**
> 已经"听到/看到"媒体——真正的解码发生在 WebView 内，需人在真机前确认。

## 8. 诚实边界（未做 / 需设备验收）

- **流式传输尚未接线（前置内核已就绪）**：前端仍是“读全量字节 → Blob → object URL”，**大于
  `MAX_PLAY_BYTES` 的视频会被诚实拒绝**而非流式播放。其**内核已落地并测试**：`amos-media::range`
  （RFC 7233 单范围规划，18 例）+ `MediaProvider::read_range`（HostFs **真 seek**、Mock 切片、默认有界切片）
  + 整项 `MAX_LOAD_BYTES` 上限 + 与 `load` **同读授权**的 `MediaManager::read_range` +
  `media_read_range` 桥命令（见 `docs/media.md` §6）。仍**未做**的只剩 **Tauri 自定义协议注册**
  （`register_asynchronous_uri_scheme_protocol`）与平台相关 URL 形式——那必须在真机上前后端一起验收，
  因此**不在此环境伪造**；协议验证通过后，`MAX_PLAY_BYTES` 与 blob 兜底即可退役。
- **真机来源依赖既有设备后端**：`music` / `movies` / `camera` / `recordings` / `download` 的读取走
  `media_*` 桥；真机 Android MediaStore 后端（Kotlin `MediaStoreGlue` + `READ_MEDIA_*`）与
  `docs/android-storage-unify.md` 的设备验收项一致，未含在 host 测试矩阵内。
- **系统媒体会话已接线但未经真机验收**：`lib/mediaSession.ts` 会在宿主提供 `navigator.mediaSession`
  时发布元数据/播放态/锁屏把手；本环境只能验证“无 API/宿主抛错时静默 no-op”，**真机锁屏/耳机把手的
  实际行为属设备验收项**。后台音频会话（Android 前台服务）仍未做，本播放器只做前台播放。
- **`MusicApp` 保持原样**：既有演示应用未被替换（避免行为回归）；新能力集中在 `player`。

