# AmOS 媒体 / 外部存储领域内核 — `crates/amos-media`（Phase A）

**日期**: 2026-09-08 · **范围**: `crates/amos-media`（纯 std 领域内核，离线可测）
**状态**: ✅ Phase A 完成（design：`docs/android-storage-unify.md` §6-A）

> 本文只描述 **Phase A 领域内核**。真正的 Android MediaStore 后端（Kotlin glue + 权限）、
> Tauri 命令层、以及 Svelte 前端对接分别落在该设计文档的 Phase B / C / D，本轮**未**实现——
> 对应代码面仍按仓库惯例保持"诚实边界"，见文末。

## 1. 解决什么断层

`docs/android-storage-unify.md` 审计结论：AmOS 的 Photos/Files/Camera 是**前端虚拟 store**
（`amos.photos` / `amos.files` / IndexedDB），与真机用户可见目录树（`/storage/emulated/0` 下的
`DCIM`、`Pictures`、`Download`、`Recordings`…）**没有统一**，也没有任何"列原生媒体/写入标准目录"
的领域抽象。本 crate 把它建成与 `amos-sensor`/`amos-radio` 同构的领域内核。

## 2. 架构

```text
[ System UI 前端 ]   →  Phase D：Photos / Files / Camera …
[ Tauri 命令层    ]   →  Phase B：media_* 命令，经 MediaManager
        │ MediaManager（权限策略：read/write 分集合授权；无授权 → 诚实 Unauthorized）
┌───────┴────────┐
│ MediaProvider   │  seam —— 哑读寄存器：list(dir) / save(dir,…)
│   Mock（今天）  │
│   Android (C)  │  MediaStore via Kotlin glue（真机）
│   HostFs  (E)  │  read_dir /storage/emulated/0（root/Waydroid）
└────────────────┘
```

| 模块 | 内容 |
|---|---|
| `spec` | `StandardDir`（DCIM/Camera、Screenshots、Pictures、Download、Recordings、Movies、Music、Root）+ `MediaKind`（Image/Video/Audio/File/Download）+ `AccessKind`（Read/Write）+ `MediaItem`（opaque `uri`：真机 `content://` / mock `mock://`）——均 serde，可直接过桥到 UI |
| `error` | `MediaError`：`Unauthorized{access,collection}` / `NotFound` / `TooLarge{bytes,max}` / `InvalidArguments` / `Provider` |
| `provider` | `MediaProvider` seam（哑读）+ 确定性 `MockMediaProvider`（`empty`/`from_items`/`seeded`/`single_photo`，`mock-<seq>` 确定性 id）+ `MAX_SAVE_BYTES`（64 MiB）上限 |
| `range` | **RFC 7233 单范围**的纯决策：`RangeSpec`/`ResponsePlan` + `parse_range`/`plan_response`/`clamp_window`/`content_range`/`status_for`——"读哪一段、回什么状态码"在碰存储之前就定好（无 IO，可穷举测试） |
| `read_range` seam | `MediaProvider::read_range`（默认=有界 `load` 后切片；Mock=blob 切片；HostFs=**真 seek+读**）+ 整项 `MAX_LOAD_BYTES`（256 MiB）上限，`MediaManager::read_range` 与 `load` **同一读授权** |
| `manager` | `MediaManager` + `Grant`：持有 `Arc<dyn MediaProvider>` + 逐 `(access,collection)` 授权；**默认全无授权**；`list`=读门控，`save`=写门控；未授权返回 `Unauthorized`（绝不伪装空列表）；空名单校验先于权限 |

**为何 provider「哑」、策略放 manager**：与 radio/sensor 一致——Mock 与未来真后端共享同一套
授权/门控规则与测试。真机上"未授权"来自 Android 运行时权限，host 上来自 manager 的 `Grant`，
两端行为一致（这是可测试的关键）。

## 3. 工程纪律（对齐仓库 P0-1）

- `lib.rs`：`#![cfg_attr(not(test), deny(clippy::unwrap_used, expect_used, panic))]`。
- 锁用 `unwrap_or_else(into_inner)` 防毒化，不 panic；Mock 构造无 fallible 路径（无 panic）。
- 类型 `Debug/Clone/PartialEq/Eq`（可行处）+ serde；错误 `thiserror`。

## 4. 验收（Phase A 判定）

- `cargo build -p amos-media` ✓
- `cargo test -p amos-media` → **18 例绿**（1 单元：error；17 集成：spec 路径/serde、Mock 确定性/过滤/空集合/save 校验与上限、manager 默认无授权/读写分离/逐集合授权/grant 幂等与撤销/参数先于权限/Provider 错误透传）。
- `cargo clippy -p amos-media --all-targets -- -D warnings` ✓
- `cargo fmt -p amos-media -- --check` ✓

## 5. 诚实边界（真机/后续轮次）

- Rust 拿不到 `ContentResolver`：任何 MediaStore 查询/写都要经 Kotlin glue——**Phase C 未在本轮实现**，
  本 crate 只提供 seam 供其实现，未假装真机可用。
- `HostFsProvider`（裸 `read_dir`）仅对 root/Waydroid 形态有意义，**Phase E 未实现**。
- Tauri `media_*` 命令（Phase B）与前端对接（Phase D）**未实现**——本 crate 是纯领域内核，
  无人调用即安全空转（与 `amos-sensor` 先落内核再接线一致）。

## 6. 状态更新（2026-09-08）与需求→测试追踪矩阵

> 上述 §4/§5 是 Phase A 首落时的验收；其后 Phase B/C/D-核心/E 装置陆续落地。下面是当前
> 媒体子系统"能力需求 ↔ 测试证据"的可追溯矩阵（aerospace：每条行为都有一处测试钉住）。

| 需求 / 行为 | 测试证据 | 位置 |
|---|---|---|
| 标准目录映射（DCIM/Camera…路径） | `canonical_paths_match_the_android_external_layout` | `tests/media_core.rs` |
| `StandardDir::tag` 稳定、互异（glue wire tag） | `standard_dir_tags_are_stable_wire_tags` | 同上 |
| `MediaItem` serde 往返 + 构造校验 | `media_item_new_validates_and_round_trips` / `media_item_roundtrips_serde` | 同上 |
| 类型化错误（可显示、可比较） | `errors_are_displayable_and_comparable` | `src/error.rs` |
| Mock 确定性 + 按集合过滤 + 新→旧 | `seeded_mock_is_deterministic_and_correctly_filtered` | `tests/media_core.rs` |
| 空集合=空非错 | `empty_collection_lists_empty_not_error` | 同上 |
| save→list 可见、id/ts 单调 | `save_creates_well_formed_item_visible_to_later_list` | 同上 |
| save 拒绝空名/超上限且不落盘 | `save_rejects_empty_name_and_oversized_payload` | 同上 |
| 默认无授权、读写分离、逐集合 | `nothing_is_authorized_by_default` / `read_grant_enables_list_but_not_write` / `grants_are_per_collection_and_per_access` | 同上 |
| grant 幂等/可撤销 | `grant_is_idempotent_and_revocable` / `with_grants_starts_authorized` | 同上 |
| 参数校验先于权限 | `save_validates_empty_name_before_permission_is_consulted` | 同上 |
| load 原样读回 / seed 无字节诚实 Provider 错 / read 门控 | `load_returns_exactly_the_saved_bytes` / `load_of_a_seeded_item_without_content_is_an_honest_provider_error` / `manager_load_is_gated_by_the_read_grant` | 同上 |
| HostFs：真文件 list(路径/mtime/大小)、save+load、空集合 | `hostfs::lists_real_files_with_size_and_mtime` / `save_writes_a_real_file_and_load_reads_it_back` | `src/hostfs.rs` |
| HostFs：IO 错误不伪装空 / 仅常规文件 / 超限拒绝 / 名穿越拒绝 | `list_reports_a_real_io_error…` / `ignores_non_regular_entries…` / `save_rejects_oversized…` / `save_rejects_unsafe_names` | 同上 |
| HostFs 并发共享安全 | `hostfs_is_safely_shared_across_threads` | 同上 |
| `MediaManager` 多线程并发 list 不 panic | `manager_is_safely_shared_across_threads_without_panic` | `tests/media_core.rs` |
| 默认构建禁 unsafe（非 android） | 编译期 `forbid(unsafe_code)`（无对应运行测试，由编译保证） | `src/lib.rs` |
| Android 映射（按 API 权限/MIME/路径） | `mapping::tests::*`（5 例） | `src/mapping.rs` |
| `media_*` 命令层（boot mock/hostfs、读写往返、load、错误串、hostfs 端到端） | `amos-tauri --lib media::`（6 例） | `crates/amos-tauri/src/media.rs` |
| 前端 TS 桥：normalize/合并/离线 null/有桥被拒 reject | `media.test.ts` + `photoLibrary.test.ts`（17 例） | `frontend-ts/src/__tests__/` |
| RFC 7233 单范围解析与规划（开/闭/后缀/越界/畸形/多范围/空资源） | `range::tests::*`（**18 例**） | `src/range.rs` |
| `read_range` 默认实现（有界 load 切片）+ 窗口数学全域 | `provider::tests::the_default_read_range_slices_the_loaded_bytes` / `window_is_total_and_clamped` | `src/provider.rs` |
| Mock `read_range` 窗口 + 无内容诚实报错 | `provider::tests::mock_read_range_returns_windows_and_stays_honest` | 同上 |
| 整项 load 上限（有界分配） | `provider::tests::ensure_loadable_enforces_the_ceiling` | 同上 |
| Android `load` 整项上限：先按 MediaStore 声明尺寸拒绝（**跨 JNI 前**），解码后再兜底 | `android::tests::a_declared_oversized_item_is_refused_before_the_glue` | `src/android.rs`（`cargo test -p amos-media --features android`） |
| HostFs `read_range` 真文件窗口 / EOF 短读 / 缺文件诚实报错 / 并发安全 | `hostfs::tests::read_range_reads_windows_from_a_real_file`、`read_range_on_a_missing_file_is_an_honest_error`、`concurrent_read_range_is_safe` | `src/hostfs.rs` |
| manager `read_range` 与 `load` 同读授权门控 | `manager_read_range_is_gated_and_windows_the_bytes` | `tests/media_core.rs` |
| 规划 ↔ provider 端到端一致（206 窗口字节 == `Content-Range`） | `a_ranged_reply_plan_matches_the_bytes_the_core_serves` | 同上 |
| `media_read_range` 命令层（窗口 / 无内容 / 撤销读授权） | `amos-tauri --lib media::`（**13 例**，含 `command_core_read_range_windows_and_is_gated`） | `crates/amos-tauri/src/media.rs` |
| 真实文件按**扩展名**推断 kind+MIME（未知/无扩展名不伪造） | `mapping::tests::kind_and_mime_infers_real_media_types` / `extension_of_is_path_aware_and_rejects_dotfiles` / `kind_and_mime_is_none_for_unknown_or_extensionless` | `src/mapping.rs` |
| HostFs 用**真实类型**列表（`.mp3`→Audio/audio/mpeg；`DCIM/Camera` 的 `.mp4`→Video；未知回退集合默认且 mime=None） | `hostfs::tests::list_infers_kind_and_mime_from_real_file_names` / `list_falls_back_to_the_collection_default_for_unknown_types` | `src/hostfs.rs` |
| 桥在**真实文件树**上分类 + 流式读取（`ftyp` 窗口 == 整项 load） | `amos-tauri --lib media::` 的 `hostfs_bridge_classifies_and_streams_real_media` | `crates/amos-tauri/src/media.rs` |
| **真媒体验收探针**（容器魔数 + 窗口字节精确 + 206 规划；真机 root 树同一二进制） | `cargo run -p amos-media --example probe_media -- <ROOT>`（实测 **4 可播 / 0 失败**） | `examples/probe_media.rs` |
| 本地多媒体播放器（扩展名/MIME 分类、三来源归一、队列去重、随机/循环/步进、有界缓冲、拒绝不伪装） | `player.test.ts`（19 例）+ `player.svelte.test.ts`（5 例） | `frontend-ts/src/lib/player.ts` + `src/svelte/PlayerApp.svelte`（设计/边界见 **`docs/media-player.md`**） |

**工程红线（aerospace，编译期/静态保证）**：生产 `deny(clippy::unwrap_used/expect_used/panic)`；
默认构建 `forbid(unsafe_code)`；锁毒化 `into_inner` 恢复；错误类型化、绝不伪装空/成功。

**诚实边界**：真机 Android MediaStore 后端（Kotlin glue + REQ_MEDIA 授权 + `ContentResolver` 实装）
与 `scan_dir` 在 root 测试机的 10ms 实测属设备验收项，未含在 host 测试矩阵内（见 §5）。

> 测试机到手后的逐条执行步骤、命令与验收点见 **`docs/device-bringup-checklist.md`**（路径 A root 扫 DCIM /
> B 普通 App 走 MediaStore / C Waydroid 直读，三选一）。

## 7. 真媒体验收（2026-09-10，host 实测）

用 **ffmpeg 生成的真实编码文件**（非合成占位）搭一棵符合 Android 布局的媒体树，再用
`probe_media` 走**与播放器相同的领域路径**（list → 分类 → 有界 load → `read_range` → 范围规划）：

```sh
# 真实素材：LAME mp3 / H.264+AAC mp4 / AAC m4a（含 DCIM/Camera 与一个非媒体文件）
ffmpeg -f lavfi -i 'sine=frequency=330:duration=2' -c:a libmp3lame /tmp/amos-real-media/Music/晨光.mp3
ffmpeg -f lavfi -i testsrc=size=320x240:rate=15:duration=2 -f lavfi -i 'sine=frequency=220:duration=2' \
       -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest /tmp/amos-real-media/Movies/星河.mp4
cargo run -p amos-media --example probe_media -- /tmp/amos-real-media
```

实测输出（`0 failures`，退出码 0）：

```text
--  Music/readme.txt               kind=File  mime=text/plain         (not media — not queued)
OK  Music/晨光.mp3                  kind=Audio mime=audio/mpeg  bytes=33062
OK  Movies/星河.mp4                 kind=Video mime=video/mp4   bytes=30383
OK  Camera/IMG_0001.mp4            kind=Video mime=video/mp4   bytes=5401
OK  Recordings/Voice_001.m4a       kind=Audio mime=audio/mp4   bytes=25640
--  Download/ReleaseNotes.pdf      kind=File  mime=application/pdf   (not media — not queued)
probe: 6 files, 4 playable, 0 failures
```

每个可播文件都通过了三项检查：**容器魔数**与类型一致（`ftyp` / `ID3`）、**窗口读取逐字节等于**
整项切片（起始/中间/尾/EOF/越界/非对齐）、以及 `Range: bytes=0-` 规划出合法 **206** 窗口。
这次真机素材测试还**暴露并修掉**一个真实缺陷：`HostFsProvider` 原先按**所属集合的默认 kind**
报告类型（`Music` 的默认是 `File`）且 `mime=None`，因此一个真实 `.mp3` 被报成"普通文件"——
现改为按扩展名推断 kind+MIME（未知则不伪造）。

