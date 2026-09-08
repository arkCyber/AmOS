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

**工程红线（aerospace，编译期/静态保证）**：生产 `deny(clippy::unwrap_used/expect_used/panic)`；
默认构建 `forbid(unsafe_code)`；锁毒化 `into_inner` 恢复；错误类型化、绝不伪装空/成功。

**诚实边界**：真机 Android MediaStore 后端（Kotlin glue + REQ_MEDIA 授权 + `ContentResolver` 实装）
与 `scan_dir` 在 root 测试机的 10ms 实测属设备验收项，未含在 host 测试矩阵内（见 §5）。

> 测试机到手后的逐条执行步骤、命令与验收点见 **`docs/device-bringup-checklist.md`**（路径 A root 扫 DCIM /
> B 普通 App 走 MediaStore / C Waydroid 直读，三选一）。

