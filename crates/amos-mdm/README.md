# amos-mdm — AmOS 企业移动设备管理（MDM）服务器

`amos-mdm` 是 AmOS 的**服务端**：Rust + Axum + SQLite 的 MDM 后端，为设备提供注册、策略同步、
远程命令（锁定 / 擦除 / 解锁）与审计日志。它是 **[Amos](../../README.md)**（一个以 Cargo
workspace 组织、AI-first 的操作系统）里的一个独立守护进程，跑在服务器侧而不是设备上。

> ⚠️ Amos 是研究原型 —— **不**适用于飞行/医疗/DAL-A 或任何其他安全关键用途（见
> [root README](../../README.md)）。

## What it is

AmOS 移动设备管理 (MDM) 服务器 - 用 Rust + Axum + SQLite 构建的完整企业级 MDM 后端。

### 特性

- ✅ **设备注册** - 通过一次性注册令牌自动注册设备
- ✅ **策略同步** - 设备定期从服务器拉取最新策略
- ✅ **远程命令** - 管理员可远程锁定/擦除设备
- ✅ **API 密钥认证** - 每个设备拥有独立的 API Key
- ✅ **本地存储** - 使用 SQLite (WAL 模式)，无需额外数据库
- ✅ **异步 I/O** - 基于 Tokio 的高性能异步处理
- ✅ **CORS 支持** - 跨域 API 调用
- ✅ **审计日志** - 所有关键操作都有日志记录

## Build & test

```bash
# 在 workspace 根目录
cargo build -p amos-mdm

# Release 构建
cargo build --release -p amos-mdm

# 单元测试（离线：不连网、不连设备、不需要 NDK）
cargo test -p amos-mdm
cargo clippy -p amos-mdm --all-targets -- -D warnings
```

## 启动

```bash
# 默认配置（监听 127.0.0.1:9001，数据库 ./amos-mdm.db）
./target/debug/amos-mdm

# 自定义配置
./target/debug/amos-mdm \
  --listen 0.0.0.0:9001 \
  --database /var/lib/amos-mdm/mdm.db \
  --api-key-prefix "amos_" \
  --sync-interval 3600 \
  --log-level info
```

### 命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--listen` | `127.0.0.1:9001` | 监听地址 |
| `--database` | `./amos-mdm.db` | SQLite 数据库路径 |
| `--jwt-secret` | `amos-mdm-secret-key` | JWT 签名密钥（保留字段，尚未启用 JWT 流程） |
| `--api-key-prefix` | `amos_` | 设备 API 密钥前缀 |
| `--sync-interval` | `3600` | 默认设备同步间隔（秒） |
| `--log-level` | `info` | 日志级别（trace/debug/info/warn/error） |
| `--admin-token` | 随机生成 | **管理员 API 共享令牌**（明文）；不提供时启动时随机生成并打印到日志 |
| `--cors-allowed-origins` | `http://localhost,http://127.0.0.1` | CORS 允许的来源（逗号分隔）—— 管理员控制台 |

> **首次启动**：必须显式 `--admin-token <secret>` 或设置 `MDM_ADMIN_TOKEN` 环境变量；不提供时启动时会随机生成并仅记录**一次**到日志。复制该值并保管好——它不会再次出现。

## Layout

| Path | Contents |
|---|---|
| `src/lib.rs` | crate 入口（`pub` 面 + P0-1 panic 门） |
| `src/main.rs` | 命令行（`clap`）+ CORS 白名单 + axum 路由装配与 server |
| `src/handlers.rs` | HTTP 处理函数：设备端点、管理端点、令牌管理 |
| `src/db.rs` | SQLite 访问层（WAL + 预编译语句）：设备 / 策略 / 命令 / 令牌 |
| `src/models.rs` | 请求与响应模型、状态枚举及其 wire 名称 |
| `src/admin_auth.rs` | 管理员 Bearer 令牌校验（SHA-256 + 常量时间比较，fail-closed） |
| `src/config.rs` | 启动配置（监听地址、库路径、CORS 白名单、管理令牌哈希） |
| `src/state.rs` | `AppState`：连接池 + 配置的共享句柄 |
| `src/error.rs` | `MdmError` → HTTP 状态与响应体 |

## API 端点

### 健康检查

```bash
GET /health
# 返回: OK
```

### 设备端点

#### 注册设备

```bash
POST /api/mdm/enroll
Content-Type: application/json

{
  "enrollmentToken": "<首次启动日志中打印的令牌>",
  "deviceId": "my-device-001",
  "deviceName": "iPhone 15 Pro",
  "platform": "iOS",
  "userAgent": "Mozilla/5.0...",
  "timestamp": 1700000000000
}

# 响应
{
  "success": true,
  "data": {
    "organizationId": "...",
    "organizationName": "AmOS Enterprise",
    "apiKey": "amos_xxxxxx",
    "enrolledBy": null
  },
  "serverTime": 1700000000000
}
```

#### 同步配置

```bash
POST /api/mdm/sync
Authorization: Bearer amos_xxxxxx
Content-Type: application/json

{
  "deviceId": "my-device-001",
  "lastSyncAt": 0,
  "currentVersion": "1.0.0"
}
```

#### 获取待处理命令

```bash
GET /api/mdm/commands?device_id=my-device-001
Authorization: Bearer amos_xxxxxx
```

#### 确认命令执行

```bash
POST /api/mdm/commands/{command_id}/ack
Content-Type: application/json

{
  "commandId": "...",
  "result": "success"
}
```

#### 取消注册

```bash
POST /api/mdm/unenroll
Authorization: Bearer amos_xxxxxx
Content-Type: application/json

{
  "deviceId": "my-device-001",
  "timestamp": 1700000000000
}
```

### 管理端点

> **所有 `/api/admin/*` 端点都需要 `Authorization: Bearer <admin-token>` 头**。
> 没有提供令牌或令牌错误时返回 `401 Unauthorized`（见 `admin_auth::require_admin_token`）。
> 管理端点与设备端点分开放置以便日志区分。
>
> ```bash
> curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:9001/api/admin/devices
> ```

#### 列出设备

```bash
GET /api/admin/devices
Authorization: Bearer <admin-token>
```

#### 远程锁定

```bash
POST /api/admin/devices/{device_id}/lock
Content-Type: application/json

{
  "message": "设备已锁定，请联系管理员"
}
```

#### 远程擦除

```bash
POST /api/admin/devices/{device_id}/wipe
```

#### 远程解锁（撤销锁定）

```bash
POST /api/admin/devices/{device_id}/unlock
# 响应
{
  "success": true,
  "cancelledCommands": 1,  // 被撤销的命令数
  "serverTime": 1700000000000
}
```

#### 推送自定义策略

```bash
POST /api/admin/devices/{device_id}/policy
Content-Type: application/json

{
  "type": "update_policy",
  "payload": { "restrictions": {...} }
}
```

#### 列出策略

```bash
GET /api/admin/policies
```

#### 创建策略

```bash
POST /api/admin/policies
Content-Type: application/json

{
  "type": "data_retention",
  "name": "数据保留策略",
  "description": "强制保留 90 天",
  "config": { "retentionDays": 90 },
  "priority": 10
}
```

#### 更新策略

```bash
PUT /api/admin/policies/{id}
Content-Type: application/json

{
  "name": "新名称",
  "enabled": true,
  "priority": 20
}
```

#### 删除策略

```bash
DELETE /api/admin/policies/{id}
```

### 令牌管理

#### 列出令牌

```bash
GET /api/admin/tokens
```

#### 创建令牌

```bash
POST /api/admin/tokens
Content-Type: application/json

{
  "expiresInDays": 7
}
```

## 架构

```
┌────────────────────────────────────────────────────┐
│              AmOS Tauri (前端 + Rust Core)         │
│  ┌────────────────────────────────────────────┐    │
│  │ enterprise/mdm.ts (MDMManager)             │    │
│  │  - enrollDevice() / syncWithServer()      │    │
│  │  - 配置存储 (amosStore 加密)               │    │
│  └────────────────────────────────────────────┘    │
│                    ↕ HTTP/JSON                     │
└────────────────────────────────────────────────────┘
                       ↓
┌────────────────────────────────────────────────────┐
│        amos-mdm (Rust MDM Server)                  │
│  ┌────────────────────────────────────────────┐    │
│  │ Axum Router (REST API)                     │    │
│  └────────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────────┐    │
│  │ Database (rusqlite + WAL)                  │    │
│  │  - organizations / enrollment_tokens       │    │
│  │  - devices / policies / remote_commands    │    │
│  │  - api_keys                                │    │
│  └────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────┘
```

## 数据库 Schema

```sql
-- 组织
CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    admin_email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 注册令牌
CREATE TABLE enrollment_tokens (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    organization_id TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    used_by_device_id TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

-- 设备
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    device_id TEXT NOT NULL UNIQUE,
    device_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    enrolled_at INTEGER NOT NULL,
    last_sync_at INTEGER NOT NULL DEFAULT 0,
    lock_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 策略
CREATE TABLE policies (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 远程命令
CREATE TABLE remote_commands (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    executed_at INTEGER,
    result TEXT
);

-- API 密钥
CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL UNIQUE,
    key_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
);
```

## 集成到 AmOS Tauri

前端 `enterprise/mdm.ts` 已经实现 MDMManager 客户端。
默认注册令牌：`AMOS-ENROLL-TOKEN-2024`

```typescript
import { mdmManager } from "@/lib/enterprise/mdm";

// 注册
await mdmManager.enrollDevice(
  "http://localhost:9001",
  "AMOS-ENROLL-TOKEN-2024",
  "My Device"
);

// 同步配置 (会自动定期调用)
await mdmManager.syncWithServer();
```

## 默认组织

第一次启动时会自动创建：

- **组织 ID**：（UUID）
- **组织名称**：AmOS Enterprise
- **默认令牌**：AMOS-ENROLL-TOKEN-2024（有效期 7 天）
- **默认策略**：
  - 执行限制（maxExecutionTime=300, maxExecutionsPerDay=1000）
  - 分享控制（allowSharing=true）

## 开发

### 调试模式

```bash
RUST_LOG=debug ./target/debug/amos-mdm
```

### 重置数据库

```bash
rm amos-mdm.db amos-mdm.db-wal amos-mdm.db-shm
./target/debug/amos-mdm  # 自动创建默认组织
```

## 安全考虑

1. **API 密钥使用 SHA 哈希存储** - 原始密钥只在注册时返回一次
2. **令牌一次性使用** - 注册令牌被使用后即作废
3. **WAL 模式 + 预编译语句** - 防止 SQL 注入
4. **CORS** - 默认允许所有源（生产环境应配置 allowlist）

## Examples

本 crate **没有** `examples/` 目录，理由记录在 `scripts/crate-readme-allowlist.json`：
它是一个**守护进程**，不是一个库 API。能演示它的东西是一个真实的 SQLite 文件 + 一个 HTTP 客户端
+ 一个管理员令牌，写成 `cargo run --example` 只会重演 `main.rs` 的启动路径，或者用一个假客户端
去断言一个假服务器（后者会证明与本 crate 相反的东西）。端到端行为由
`cargo test -p amos-mdm` 和 [AmOS 前端](../../crates/amos-tauri/frontend-ts) 的
`enterprise-mdm-*` 测试覆盖。

## Honest boundaries

1. **命令的失败路径还没接上**：`db::fail_command`（写 `status='failed'`）目前没有调用方 —— 设备的
   ack 请求只有 `result: Option<String>`、**没有失败信号**（`models::AckCommandRequest`），所以今天
   一台设备回报 lock/wipe 失败会被记成 `acknowledged`。测试先行、协议改动属于 MDM 工作流；
   该条目已在 `docs/rust-unwired-audit.md` 登记，不会被悄悄忘掉。
2. **`--jwt-secret` 是保留字段**：JWT 流程尚未实现。管理接口用共享 Bearer 令牌（首次启动时
   随机生成并只打印一次），设备接口用每设备 API Key。
3. **没有服务端推送通道**：设备靠轮询 `GET /api/mdm/commands` 取命令，`--sync-interval` 是给设备的
   建议值，服务端并不控制设备 ⇒ “立即锁定”的真实延迟 = 设备下一次轮询的间隔。
4. **`/health` 与设备端点不鉴权**：`/health` 是给探针用的，不透露库内容；设备端点靠
   每设备 API Key 在 handler 内校验（不是中间件）。管理端点 **fail-closed** ——
   没有 `Authorization: Bearer <admin-token>` 一律 401。
5. **单机 SQLite**：适合一台服务器 + 企业规模的设备数；多副本 / 高可用需要外部数据库（未做）。

## Related

- [root README](../../README.md) — 这个 crate 在 AmOS 里的位置
- [`docs/rust-unwired-audit.md`](../../docs/rust-unwired-audit.md) — 边界 1 的登记入口
- [`crates/amos-tauri/frontend-ts/src/lib/enterprise/index.ts`](../amos-tauri/frontend-ts/src/lib/enterprise/index.ts)
  — 控制台侧的客户端（`mdmManager`：注册、策略同步、远程命令）

## License

MIT OR Apache-2.0
