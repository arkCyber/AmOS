# AmOS 整屏录制（Screen Recording）——平台路径、取舍与诚实边界

**日期**: 2026-09-25 · **范围**: `crates/amos-tauri/src/screen_record.rs`（macOS 宿主）、
`crates/amos-tauri/src/screen_record_android.rs` + `android-glue/com/amos/ai/glue/ScreenRecord*.kt`（Android 设备侧）、
`crates/amos-tauri/frontend-ts/src/lib/screenRecord.ts` 与两个界面（`ScreenRecordingTile.svelte` / `ScreenRecordIndicator.svelte`）

**关联**: `docs/screen-recording.md` 由 `screen_record.rs` 的模块注释在**三处**指名（帧率上限、取舍全文、`screencapture -v` 的实测）；
`docs/sensors.md`（同一「先给纯规则、平台调用留在 seam」的写法）、`docs/android-glue.md`（glue 镜像与告警门禁）、
`REQ-A1580`（Control Center 磁贴）、`REQ-A1581`（顶栏 REC 指示器）、`REQ-A1582 ∕ F-DEV-141`（Android 绑定）。
本文件本身由 `REQ-A1628 ∕ F-DEV-142` 补齐——见 §9。

> 本文回答 `screen_record.rs` 的模块注释留下的那个指向：宿主已能录整屏，但**为什么用 `ffmpeg` 而不是系统的
> `screencapture -v`、时长上限为什么是 30 分钟、帧率为什么是 30、文件为什么落在 `Movies` 而不是子目录、
> 停止为什么用 SIGINT**——这些取舍此前只写在代码注释里，并被三处引用指向一个**当时并不存在**的本文件。

---

## 1. 这个模块做什么

宿主提供四个命令（`crates/amos-tauri/src/lib.rs` 注册），前端只有一条 seam（`lib/screenRecord.ts`）：

| 命令 | 语义 | 前端包装 |
|---|---|---|
| `screen_record_start` | 开始一次整屏录制，返回**当前**会话状态 | `screenRecordStart(opts)` |
| `screen_record_stop` | 给录制进程发信号封口，**确认文件落地**后返回 | `screenRecordStop()` |
| `screen_record_status` | 会话现状（live / sealing / idle），**不门禁** | `screenRecordStatus()` |
| `screen_record_capability` | 本构建能否录制，不能则给出原因（宿主自己的话） | `screenRecordCapability()` |

`start` / `stop` 都是**前台门禁**的（`require_screen_record_foreground` → `clipboard::require_foreground`）：
只有用户正在看的那个窗口可以开始或结束一次「整屏采集」。`status` **故意不门禁**——它只披露「正在录制」，
而顶栏指示器（`REQ-A1581`）本就在向任何看屏幕的人显示这件事；门禁它只会多出一条拒绝、并弄坏它所保护的那个指示器。

---

## 2. 为什么是 `ffmpeg`，不是 `screencapture -v`（本轮取舍的核心）

**先说结论**：`ffmpeg -f avfoundation` 是 macOS 这一侧唯一的正确选择，代价是一个**运行时依赖**——`PATH` 上没有
`ffmpeg` 时 `capability()` 回答 `available: false` 并指名缺的是什么，而不是退回一个**停不下来**的工具。

`crates/amos-tauri/src/screen_record.rs::macos_record_command` 的注释记录了对 `screencapture -v` 的实测
（macOS 26.4.1，2026-09-25，`-V30`）：

- **它只在自行退出时才写文件。** 录制三秒时磁盘上**根本没有文件**——整段采集是缓冲的。
- **没有任何信号能封口。** SIGINT（`kill -INT`，以及真正 pty 上的 `\x03`）、SIGTERM、SIGQUIT、SIGHUP、
  SIGUSR1、SIGUSR2 各自都杀掉进程并**什么都不留下**。

后果是致命的：一个基于它的「停止」按钮，会在用户**刚刚亲眼看着录完**的一段录像上回答「录制工具跑了但没写文件」。
更早一次「看起来成功」的 shell 实测其实是伪影：zsh 的后台任务忽略 SIGINT，那一轮是**跑满了自己的 20s 上限**
才封口的——正是 `tests/screen_record_e2e.rs` 抓住了这一点（它也是**当初发现原设计有误**的那个门禁）。

`ffmpeg` 提供本模块需要的东西：**边采边写**（三秒时磁盘上 262 KB），并在 **SIGINT 上封口容器**
（退出码 255，文件可被 `ffprobe` 读回一个真实时长）。它的 `-t<secs>` 是**工具自己的**上限，
因此即使宿主进程在能停它之前就死了，这条上限依然成立。

### 2.1 停止的信号选择是正确性关键，不是实现细节

`interrupt_command(pid)` 发的是 **SIGINT**：`ffmpeg` 装有 SIGINT/SIGTERM 处理器，会停止采集并写出容器 trailer，
于是 `.mov` 可播放。实测：四分之一秒内退出 255，文件存在且 `ffprobe` 可读。**它没处理的信号**会留下一个
「存在但打不开」的文件——而「非零大小」这一条**单独是抓不到**那种情况的，所以信号的选择才是停止路径上的要点。

注意：这条路径上 `ffmpeg` 的退出码 **255 是成功**。`screen_record_stop` 从不把退出码当判决读；
**文件的「存在且非空」才是**（`confirm_written`）。

---

## 3. 时长上限与帧率

| 常量 | 值 | 说明 |
|---|---|---|
| `MIN_RECORD_SECS` | 1 | 零长度请求是笔误，不是「录空」——工具会写出没有帧的文件 |
| `MAX_RECORD_SECS` | 1800（30 分钟） | 请求**超出即按名拒绝**（`amos.screenrecord.duration_out_of_range`），不是静默钳制 |
| `RECORD_FRAMERATE` | 30 | 见下 |
| `SPAWN_GRACE_MS` | 250 | 见 §5 |
| `STOP_WAIT_SECS` | 15 | 见 §6 |

`resolve_max_secs(Option<u32>) -> Result<u32, AmosError>`（`screen_record_start` 在**任一平台启动之前**调用一次）：
`None`（调用方没给上限）**就是最大值** `1800`；落在 `[1, 1800]` 内的值原样通过；**落在区间外则是命名拒绝**。

**为什么是拒绝而不是钳制**（REQ-A1795，推翻了本模块更早的「钳制不拒绝」契约）：钳制替换掉的边界**在产物里看不见**
——要了一小时、静默拿到 30 分钟的人，手里是一个和完整录像长得一模一样的文件。它也不是对调用方的服务：
「录一小时」的诚实答案是「最多 30 分钟，请重新要求」，而不是一段提前停止的采集。这与同 crate 的
`sensors::sensor_acquire` 对 `rate_hz` 的处理是同一条规则（调用方不必解析消息即可渲染一句诚实的话）。
边界值 `1` 与 `1800` 本身是**合法**请求（闭区间），UI 的「30 分钟」选项不该被 off-by-one 打回。

通过检查的值**同时**交给平台工具（macOS 的 `-t<secs>`、Android glue 的 `scheduleAutoStop`），
所以这条上限是**真的**而不是建议值——即使宿主进程在能停它之前就死了。

**帧率取 30 而不是面板刷新率**：此处真正在意的上限是「一段 30 分钟录像留在 `~/Movies` 里的文件大小」，
而宿主没有可移植的办法去问面板的刷新率。这是取舍，不是遗漏。

---

## 4. 文件落在哪、叫什么

- **目录**：`<home>/Movies`——常量 `SCREEN_RECORDING_REL_DIR`，是
  `lib/media.ts::canonicalPath("movies")` 的**镜像**，由 `declaredMirrors` 测试钉住两者不漂移。
- **文件名**：`Screen Recording <YYYY-MM-DD> at <HH.MM.SS>.mov`（本地时间，因为人会在 Finder 里看它）。

**为什么不建一个 `Screen Recordings/` 子目录**：会更整齐，但会**不可见**。媒体 provider 列一个集合是**非递归**的
（`amos-media` 的 `HostFsProvider::list` 是对 `base/<canonical_path>` 的一次 `read_dir`），
所以落在下一层的录像永远不会被任何界面列出来。要让它可见就得新增一个 `StandardDir` 等价集合——
一个新的 wire tag，而它的 Android `MediaStoreGlue` 键并不存在、也无法在本机验证，
也就是「一个列着任何设备后端都答不上来的地方的界面」。所以录像落在 macOS 自己也会放的位置、
且词汇表已经指向的地方：`Movies`（其 `default_kind` 是 `Video`）。文件名负责把它与用户自己的影片区分开。

---

## 5. 「一次 spawn 还不等于一段录制」

`screen_record_start` 在 spawn 之后**观测它的出生**：睡 `SPAWN_GRACE_MS`(250ms)，然后子进程必须**还活着**，
否则以命名错误拒绝。原因：`ffmpeg` 在打不开采集设备时会在一秒内退出——**缺 Screen Recording 授权**正是这种情况，
它会带着自己的错误退出而不是赖着。仅凭 `spawn()` 成功就报 `recording: true`，会为一段**并未发生**的采集点亮 REC 指示器。

这是本仓库反复清除的「能力事实被当作观测事实」一族；同一个 grace 也是「start 最快也要 250ms 才回答」的下限，
以及 `tests/screen_record_e2e.rs` 断言的是**拒绝的前提**（立即退出的工具没写文件）而不是假定它。

---

## 6. 停止是两阶段的

`screen_record_stop` 针对共享槽位做两阶段操作：

1. 持锁：把会话从 `active` 取出，放一个 `Stopping` 标记（带输出路径）**顶替**它——此后 `status` 仍能如实回答「finishing…」；
2. **先释放锁**，再去 await 子进程（最多 `STOP_WAIT_SECS`(15s)），所以这段封口窗口里 `screen_record_status` 不会阻塞在锁后。

标记的清点带**代数守卫**（`generation`，抄自 `android-glue` 的 `CameraGlue.kt` 纪律）：一次迟到的 stop 若代数不等，
**丢弃**，不能碰一个更晚开始的会话的槽位。

`screen_record_status` 每次读槽位时**回收**已经自行退出的子进程（`-t` 上限到点、或崩溃），
所以 `recording` 不会比它所描述的那个进程活得更久（「一个短暂的位比它的证据活得久」一族）。
代价是：**一次自己跑到上限而结束的会话，会静默地变回 idle，其目标路径随之丢失**——文件确实在 `Movies` 里，
但没有任何界面被告知「它结束了」。这是设计选择，如实写在这里。

---

## 7. Android 一侧（设备侧，本机未运行）

Android 没有可当作子进程的等价物：一次采集是 `MediaProjection` + `MediaRecorder` + `VirtualDisplay`
三元组，由 app 持有，外加一个**用户本人**回答的系统授权对话框。所以宿主**没有**会话可持有，
这块是 `android-glue` 的 `ScreenRecordGlue` 在 Java 侧持有状态，Rust 只做薄 seam。

```text
screen_record_start ─► Rust ─► ScreenRecordGlue.start(maxSecs, display): String
                                       └► createScreenCaptureIntent() + startActivityForResult(REQ_SCREEN_RECORD)
  用户同意 ─► MainActivity.onActivityResult ─► onConsentResult()
                                                └► 前台服务 + recorder + mirror
screen_record_status ─► ScreenRecordGlue.statusJson(): String → ScreenRecordStatus
screen_record_stop   ─► ScreenRecordGlue.stop(): String（封口 + 发布 MediaStore 行）
```

三条被刻意不折叠的事实（macOS 那一侧各自都尊重）：

- **一次 start 是请求，不是录制。** 用户要批一个系统对话框，所以 `start()` 回答 `requested`，
  真正开始会话的是**同意结果**。仅凭对话框**贴出来了**就报 `recording`，会为一段没人批准过的采集点亮顶栏 REC——
  同一个 macOS 侧 spawn-grace 存在所要避免的缺陷。
- **代数计数器**：一次迟到的 `MediaProjection` 停止回调、或一个迟到的自动停止定时器，不得拆掉更新的那个会话。
- **时长上限在这里也执行，且越界请求按名拒绝。** 上限是**宿主的**决定（`resolve_max_secs`，
  `MIN_CAPTURE_SECS` ∕ `MAX_CAPTURE_SECS` 是它的镜像）；`MediaRecorder` 没有 `-t` 等价物，所以 `scheduleAutoStop`
  是这一侧的 `-t`：一段没人来停的录制（进程被前台服务撑着、WebView 丢了）不能把用户存储填满。
  落在区间外的请求由 `start` 在**贴出同意对话框之前**答 `out_of_range`，宿主把它映射成同一条
  `amos.screenrecord.duration_out_of_range`——**不是**替换成另一个长度（更早的版本对非正数请求编造 60 秒，
  那种文件与一段被要求的录像不可分辨）。两处数字由 `screen_record_android` 的一个测试**读 glue 源码**钉住，
  所以两侧不会各自漂移（REQ-A1821 ∕ F-DEV-149）。

- **封口后要确认文件真的写了，且「量不到」不等于「量到 0」。** macOS 的 stop 会 stat 它子进程写出的文件
  （`confirm_written`）；这里目的地是 MediaStore 的一行 `content://`，所以 glue 在 `release()` 之后、
  关描述符之前 stat 它交给 `MediaRecorder` 的描述符，把数字经 `statusJson` 带回来（`UNMEASURED_BYTES` = 平台没报，
  与「量到 0」是两件事），宿主侧的 `confirm_sealed` 施加同一条规则：`Some(0)` 是「录了但没写帧」，
  字段缺失是「这个宿主什么都确认不了」，两者各自一条 `amos.screenrecord.confirm_failed` 句子。
  更早的版本把 glue 的成功**发布**当成全部确认，于是一段起了但没写帧的 `MediaRecorder` 被报成完成
  （REQ-A1847 ∕ F-DEV-154）。

**前台服务不是装饰。** `MediaProjectionManager#getMediaProjection` 只在有一个 `mediaProjection` 类型的前台服务运行时才被允许；
在 Android 14（API 34）上，若未声明 `FOREGROUND_SERVICE_MEDIA_PROJECTION`，**启动该服务本身**就会抛 `SecurityException`。
所以 `ScreenRecordGlue.begin` 在向 OS 要投影**之前**先 `ScreenRecordService.start`，
并在**每个**会话结束路径都汇到的那一个 `teardown` 里 `ScreenRecordService.stop`
（`stop()`、自动停止定时器、平台的 `MediaProjection.Callback.onStop`、拒绝路径 `abort` 都走它）。
否则那条常驻的 “Recording screen” 通知会继续声称一段已经结束（或从未开始）的采集。

**Android 的诚实边界**（`screen_record_android.rs` 与 glue 的注释同样声明）：

- **没有任何设备跑过它。** 宿主只能 `cargo check --features android` 与 Android 构建类型检查它；
  FMEA 行 `F-DEV-141` 把它标为 device-only。
- **确认的是「写了字节」，不是「画面对」。** 文件大小已被确认（上一条非折叠事实），但**两个平台都不看一个像素**：
  macOS 的 `confirm_written` 与这里的 `confirm_sealed` 都只回答「文件存在且非空」，所以「帧确实是屏幕」两边都不报告。
- **`display` 参数被忽略**：`MediaProjection` 镜像默认显示，Android 没有公开办法去投另一块。
  静默录显示 0 而用户要的是 1 才是最糟的选项，所以这一点是**写出来**的而不是藏起来的。

---

## 8. 前端：三个读状态，一个都不折叠

`lib/screenRecord.ts` 是唯一的 seam（DOM-free，纯读取部分是单测对象）。
`recordingPhase(status)` 把一次读分成**四个互不相同的**相位：

| 相位 | 含义 | 为什么不能折叠 |
|---|---|---|
| `unknown` | `null`——宿主**没回答**（无桥，或命令失败） | 折进 `idle` 会在一段**仍在运行**的会话上画一个停止了的录制器 |
| `idle` | 宿主回答「没有会话」 | —— |
| `recording` | 正在跑 | —— |
| `stopping` | 已发停止、正在封口 | 值得单独一个词，界面才能说「finishing…」而不是两个方向都撒谎 |

两个界面：Control Center 磁贴（`REQ-A1580`，前端 `screen_record_*` 命令此前**没有任何界面调用它们**）
与顶栏 REC 指示器（`REQ-A1581`）。`capability` 的 `null` 是**「宿主没回答」**，不是「不可用」；
不可用时显示的是**宿主自己的话**，界面不得为同一个事实再编第二套理由。
一次被拒绝的 start/stop 会解析成 `null`，界面**要把它显示出来**而不是静默地什么都不做。

---

## 9. 本文件自身与门禁

`screen_record.rs` 在**三处**指名本文件作为取舍全文/实测的披露处。此前它**并不存在**，
而没有任何门禁能发现：`scripts/docs-link-scan.mjs` 只解析 `.md` 文件里的 Markdown 链接
（且先剥掉代码片段），因此**写在 Rust / Svelte / TS 注释里的 `docs/….md` 引用落在任何窗口之外**。

本文件由 `REQ-A1628 ∕ F-DEV-142` 补齐，并在 `screen_record.rs` 的测试里钉住：
`cited_docs_in_doc_comments` 只读**文档注释行**（`//!` / `///`），因此它不会把测试自己的
字符串字面量（`"docs/a.md"`）误当成引用；测试随后要求每一条被指名的 `docs/….md` **在仓库中确实存在**。

**为什么没有顺手把 `docs-link-scan.mjs` 扩成扫描源码注释**：那个扫描器要区分
「注释里的一次**引用**」与「字符串里的一个**路径**」（例如
`files.svelte.test.ts` 的夹具路径 `/tmp/fence/docs/readme.md`），这需要专门设计而不是加一条正则；
本轮的边界止于**最新模块自身的承诺**，其余三处源码注释中的失效引用
（`docs/stage-manager.md`、`docs/FUNCTIONAL_GAP_ANALYSIS.md`、`docs/SVELTE_MIGRATION_AUDIT.md`）如实记在
`REQ-A1628` 的如实边界里，未被本轮改写。

**后续（`REQ-A1655 ∕ F-DEV-143`）**：那「三处失效引用」已在本轮结清 ——
`docs/stage-manager.md` 已写好，另两条是把文档**写在了 `docs/` 下**而文档实际位于仓库根目录
（`FUNCTIONAL_GAP_ANALYSIS.md`）与前端目录（`SVELTE_MIGRATION_AUDIT.md`），引用已改为真实路径；
并且上面「专门设计而不是加一条正则」这件事**已经做了**：新增门禁 `scripts/doc-cite-scan.mjs`
只读源码的**注释行**（行首 `//` / `///` / `//!` / `*` ∕ shell `#`，以及 `.svelte` 的
`<!-- … -->` 注释体），不读字符串字面量、也不读 `.md` 散文，全仓 558 条引用逐条核对是否落地。
所以本节的盲区**不再是盲区**；`screen_record.rs` 里那条模块级守卫仍然保留，它是本模块**自己的**
承诺（模块注释新指名一份不存在的文档时，`cargo test` 立刻红）。

---

## 10. 诚实边界汇总（不是未说明的缺陷）

- **macOS-only，且需要 `PATH` 上有 `ffmpeg`。** 其他平台从 `capability()` 回答 `available: false` 并点名是哪个 OS；
  macOS 在工具缺失时回答 `false` 并说出缺的是 `ffmpeg`（`capability_with_tool`）。
- **Screen Recording 权限是 OS 的。** 授权被拒会让工具失败（`ffmpeg` 在选中采集设备之后带着自己的错误退出），
  spawn grace 会把它变成一次**命名的 start 拒绝**，而不是一段幻影录制。「文件有字节但像素是错的」**不检测、也从不声称**。
- **录制中崩溃会留下子进程**，只能由它自己的 `-t<secs>` 上限封口——那条上限也是 `stop` 永不抵达时仍能守住时长天花板的原因。
- **哪块屏叫 `display` 是工具的词汇表。** avfoundation 索引依机器而定（相机占低位索引），所以按**名字**查；
  宿主列不出的屏是一次拒绝，不是回退。本机只跑过单屏情形。
- **没有设备模拟器路径**；Android 那一半在本机未被运行（§7）。
- **像素从不被检视**：无论 macOS 还是 Android，都只报告「一个文件被写出、有多大」，从不报告「帧就是屏幕」。
