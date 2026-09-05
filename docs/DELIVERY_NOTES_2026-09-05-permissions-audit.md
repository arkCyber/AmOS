# 交付说明与遗留清单 (Delivery Notes & Known Limits) — Permissions Manager · Sandbox · 运行时安全审计

**日期**: 2026-09-05
**范围**: 把「系统级账户与安全沙箱隐私管理」缺口落地为一整条可验证链路（对应
`docs/permissions-sandbox-audit-plan.md` 的 Phase 1/2/3(纯 seam)/4/5(host seam)）：
1. **PrivacyManager 可寻址化 + 统一审计落盘**（`amos-ai`：`audit.rs` 归一模型/落盘 sink；`privacy.rs` 持久化；`security.rs::AuditLogger` 可选落盘）。
2. **daemon 权威 gRPC 权限 RPC**（`proto/privacy.proto` + `amos-ai::privacy_service` + 挂进 `serve()` + `amos-tauri::privacy_client` 命令）。
3. **前端词汇对齐 + 门改走 daemon 权威**（frontend-ts：`contacts`/`storage` 对齐、`privacyBackend` seam、`CapabilityGate`/`PermissionsApp` 消费 `perm_*`）。
4. **web-bundle 沙箱能力桥纯裁决 seam**（`frontend-ts::sandboxBridge`）。
5. **容器侧 APK 能力账本 host seam**（`amos-android::capability`）。

**状态基线**: 工作树（当前分支之上叠加本会话改动）。
**主设计文档**: `docs/permissions-sandbox-audit-plan.md`（含逐步落地进度块）。

---

## 1. 可直接使用的提交说明（commit message）

```
feat: authoritative OS Permissions Manager over gRPC + durable unified audit + UI gates

Persistence + unified audit (crates/amos-ai)
- new audit.rs: normalized AuditRecord{ts,principal,op,resource,outcome,details} +
  Outcome{Success,Granted,Denied,Rejected,Error} folding security::AuditResult and
  privacy::AccessDecision without collapsing; AuditFile = durable JSON-lines sink
  (open() skips torn lines, bounded ring, recent/recent_matching/export_json) +
  From<AuditEntry>/From<AccessRecord>. security.rs AuditLogger gains an optional
  sink (new_persistent/durable_path), log() mirrors best-effort. privacy.rs adds
  atomic save(path)/load(path) (FileState keyed by wire-key) + with_audit_file /
  with_durable_audit so every authorize() mirrors to the unified durable sink.

Authoritative daemon authority (proto + amos-ai + amos-tauri)
- new proto/privacy.proto (amos_privacy, PrivacyService: Grant/Revoke/RevokeAll/
  Authorize/Granted/RecentAudit; resources by stable wire key; unknown -> INVALID_ARGUMENT).
- amos-ai privacy_service.rs: PrivacySvc(Arc<PrivacyManager>), Authorize is the one
  audited chokepoint; AMOS_PRIVACY_PATH -> load + durable audit mirror + persist on
  grant/revoke; mounted in server.rs::serve() alongside governor/etc. New UDS e2e
  privacy_rpc_e2e.rs.
- amos-tauri privacy_client.rs: perm_authorize/grant/revoke/granted/recent_audit
  commands (UDS PrivacyServiceClient), registered in lib.rs.

Frontend alignment + daemon-authoritative gates (frontend-ts)
- Capability vocabulary gains contacts/storage (1:1 with daemon Resource keys;
  notifications = local-only). PermissionsApp exhaustive maps + en/zh keys.
  lib/privacyBackend.ts daemon seam (daemonAuthorize offline->null, grant/revoke
  submit-when-bridged). CapabilityGate useCapability reconciles with daemonAuthorize
  online (denied overrides stale local grant), allow() daemonGrant + local cache;
  PermissionsApp toggles submit daemonGrant/daemonRevoke. Offline path unchanged.

Sandbox decision seams (honest, not faking device enforcement)
- frontend-ts lib/sandboxBridge.ts: validate {type:"capability.request",resource,
  requestId} (known wire keys only); decideCapabilityRequest grants only when the
  daemon says true; offline/unknown/invalid -> denied or no reply.
- amos-android src/capability.rs CapabilityLedger: deny-by-default per-package
  sensitive-resource store aligned to the same wire keys (future container policy
  / LMK / am force-stop hooks).
```

## 2. 改动文件（新增/修改）

新增（proto）：`proto/privacy.proto`。
新增（Rust）：`crates/amos-ai/src/audit.rs`、`crates/amos-ai/src/privacy_service.rs`、
`crates/amos-ai/tests/privacy_rpc_e2e.rs`、`crates/amos-android/src/capability.rs`、
`crates/amos-tauri/src/privacy_client.rs`。
新增（前端）：`frontend-ts/src/lib/privacyBackend.ts`、`frontend-ts/src/lib/sandboxBridge.ts`、
`frontend-ts/src/__tests__/{privacy-backend.test.ts,sandbox-bridge.test.ts}`。
新增（doc）：`docs/permissions-sandbox-audit-plan.md`、`docs/DELIVERY_NOTES_2026-09-05-permissions-audit.md`。
修改（Rust）：`crates/amos-proto/build.rs`、`crates/amos-proto/src/lib.rs`、
`crates/amos-ai/src/{lib,privacy,security,server}.rs`、`crates/amos-android/src/lib.rs`、
`crates/amos-tauri/src/lib.rs`。
修改（前端）：`frontend-ts/src/lib/permissions.ts`、`components/{CapabilityGate,PermissionsApp}.tsx`、
`i18n/locales/{zh,en}.ts`、`__tests__/{permissions.test.ts,capability-gate.test.tsx}`。
修改（doc）：`CHANGELOG.md`。

## 3. 设计与不造假边界（设计决策）

- **权威在 daemon**：前端「隐私」页与能力门不再自以为是唯一真相；`perm_authorize` 是唯一咽喉，
  每次裁决都审计（内存有界 + 可选统一 JSON-lines 落盘）。本地 `amos.permissions` 账本退化为**显示缓存**
  + **离线兜底**（离线路径与旧行为逐字节一致，无异步、无闪烁）。
- **资源单一词表**：`Resource`/`Capability`/`SANDBOX_RESOURCES`/`SENSITIVE_RESOURCES` 共用同一
  wire-key 集合（microphone/camera/contacts/location/storage）；`notifications` 是 local-only，不混入。
- **不明即拒**：web-bundle 沙箱请求、`CapabilityGate` 对账、容器能力账本都在「离线/未知」时默认拒绝，
  绝不在含糊时放行或造假授权。

## 4. 验证计数（本会话跑绿）

Rust：
- `cargo check -p amos-proto`：OK（新 `amos_privacy` 生成）。
- `cargo test -p amos-ai --lib`：**149 passed**（基线含 +audit/privacy-service 等，含 daemon 边界 local-only 名拒绝）。
- `cargo test -p amos-ai --test privacy_rpc_e2e`：**1 passed**（boot `serve()` → 未知键拒绝 → grant mic →
  authorize granted/camera denied → Granted 列表 → RecentAudit 两条）。
- `cargo test -p amos-android --lib`：**57 passed**（含新 `capability` 5）。
- **全量回归（本会话收尾）**：`cargo test -p amos-ai` 全量 **全绿**（lib **149** + 集成二进制
  android/chat/dvfs_overlap_e2e/governor_rpc_e2e/hermes_e2e/lmk_governor_bridge/lmk_reverse_drive/
  privacy_rpc_e2e/rpc_test/system_test 各自 pass——确认 `serve()` 新增 privacy service 挂载未破坏其它 e2e）；
  `cargo test -p amos-android` 全量 **全绿**（lib **57** + 集成），EXIT=0。
- clippy `--all-targets -D warnings`：`amos-ai` / `amos-android` / `amos-tauri` 均 clean；fmt clean。

前端（`frontend-ts`，按文件隔离跑，见下方注）：
- `tsc --noEmit`：exit 0。
- `permissions`、`privacy-backend`、`sandbox-bridge`、`capability-gate`（含新在线权威例）、
  `camera`、`voice-mic`、`stream-voice`：均 **0 fail**。

> 注：直接用 `bun test a b …` 合跑多个 DOM 测试文件会共享 happy-dom 全局（localStorage / bridge）
> 而出现隔离假阳性；仓库 runner `scripts/bun-iso-test.mjs` 按文件隔离。本交付按文件验证。

## 5. 诚实边界 / 真机验收顺序（on-device acceptance）

在桌面/CI 能落地的只是「决策/审计权威 + seam」。真正把决策**执行**到 OS 边界需要真机，验收顺序：
1. **容器内 per-APK 权限拦截**：把 `amos-android::capability::CapabilityLedger` 的 `is_granted(pkg,res)`
   接进 Waydroid host 侧，在 HAL/`am force-stop` 前对 `AudioRecord` / `Camera.open` / 通讯录读取做裁决——
   账本需由 host（`privacy.proto` 的 `Grant/Authorize` 或宿主同步）种子。此步是真机。
2. **web-bundle 沙箱能力桥宿主接线**：把 `sandboxBridge`（`validateCapabilityRequest` /
   `decideCapabilityRequest`）接进真实 `postMessage` 监听 + `amos-app://` 真 origin 宿主
   （`amos_appstore::serve` 就绪）——让沙箱内 bundle 有受控的「申请→裁决→审计」通道。此步需自定义协议宿主。
3. **审计消费**：把统一审计文件（`AMOS_PRIVACY_PATH.jsonl` 或 `AuditFile`）接入 SIEM/隐私 App 视图。
4. **持久化启停闭环**：daemon 以 `AMOS_PRIVACY_PATH` 启动，验证 grant 重启后仍在、决策重启后可查。

## 6. 已知限制（Known Limits）

- daemon 权限服务默认在**无 `AMOS_PRIVACY_PATH` 时为纯内存**（重启即失）；要持久须以该 env 启动
  （与 `AMOS_SESSIONS_PATH` 同模式，非默认开启）。
- `CapabilityGate`/`PermissionsApp` 的 allow/deny：离线为 no-op/本地缓存；在线以 `perm_*` 为准，
  但 `daemonGrant/Revoke` 因 Rust 命令返回 unit（JSON `null`）只表达「已提交」，不表达「已确认」。
- `sandboxBridge` / `CapabilityLedger` 是 seam：未接真实宿主/容器策略，无「已拦截」含义。
- 前端 `daemonAuthorize` 对 `notifications`（local-only）恒返回 `null`（不触达 daemon）。

