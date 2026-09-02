# Hermes-Rust 智能体接入 AmOS（Agent 层）

> 目标架构：**AmOS → hermes-rust（Agent 层）→ Ollama（模型层）→ 大模型**
>
> hermes-rust 是独立的 Rust 智能体 daemon，内部通过 **Ollama** 调用大模型。

## 一、已从 hermes-rust 源码确认的接口（/Users/arksong/hermes-rust）

| 表面 | 地址 | 说明 |
|------|------|------|
| HTTP daemon | `127.0.0.1:11438`（env `HERMES_DAEMON_PORT`/`HERMES_HOST`） | `hermes-rust serve` |
| **OpenAI 兼容 chat** | `POST /v1/chat/completions`（`api.rs`） | `stream:true` 走 SSE |
| 原生 chat | `POST /v1/chat` | 单消息 |
| models | `GET /v1/models` | 模型列表 |
| tools | `GET /v1/tools` / `POST /v1/tools/call` | 工具面 |
| agent | `POST /v1/agent/run` / `GET /v1/agent/status` | Agent 驱动 |
| sessions | `GET/POST /v1/sessions...` | 会话管理 |
| health | `GET /health` | 健康探测 |
| gRPC（feature `grpc`） | `11438`（`proto/hermes.proto` → `HermesService`） | `StreamChatCompletion`/`RunAgent`/`ListTools`/`Check` |

**流式格式（关键）**：`/v1/chat/completions` 每个 `StreamEvent` 转 SSE——
- 中间 token：`data: {"type":"token","content":"..."}`
- 终止 Done：`data: {"choices":[{"delta":{"content":"<全文>"}}]}`（OpenAI 格式）

## 二、AmOS 侧接线（✅ 已完成 2026-09-01）

新增 `HermesAgentBackend`（`amos-ai/src/inference/real.rs`）：
- `infer()` → `POST {endpoint}/v1/chat/completions`（stream），用 `parse_hermes_sse_chunk` 解析
  原生 `type:"token"` 帧 → **真实逐 token 流式**；同时兼容 OpenAI delta 兜底
- `health_check()` → `GET {endpoint}/health`
- `metadata()` → `supports_function_calling: true`（hermes 有 tools/agent）
- `AMOS_BACKEND=hermes` + `AMOS_HERMES_ENDPOINT`（默认 `http://127.0.0.1:11438`）+ `AMOS_MODEL`

**✅ session_id 透传（2026-09-01）**：`amos-ai` 把客户端 `session_id` 经
`context["session_id"]` 传入 `HermesAgentBackend`，写入 hermes 请求体 `session_id`
字段 → **hermes-rust 的 SQLite 会话 lineage/多轮记忆真正被 AmOS 用起来**（同一
`session_id` 的后续轮次能续接历史）。测试：`hermes_body_binds_session_id_when_present`。

```bash
AMOS_BACKEND=hermes AMOS_HERMES_ENDPOINT=http://127.0.0.1:11438 AMOS_MODEL=hermes-rust cargo run -p amos-ai
```

## 三、用 amos-supervisor 拉起 hermes-rust daemon

```rust
use amos_supervisor::{DaemonSpec, RestartPolicy, Supervisor};

let spec = DaemonSpec {
    name: "hermes-agent".into(),
    program: "/path/to/hermes-rust".into(),   // 你的 hermes-rust 可执行文件
    args: vec!["serve".into(), "--port".into(), "11438".into()],
    env: vec![("HERMES_HOST".into(), "127.0.0.1".into())],
    restart: RestartPolicy::default(),
};
let sup = Supervisor::new();
sup.start(spec).await?;
```

## 四、备选接入面
- **直连 Ollama**：`AMOS_BACKEND=ollama`（跳过 hermes-rust，模型层直连）
- **gRPC**：若需 `RunAgent`/`CallTool` 原生 RPC，可新增 tonic 客户端连 `HermesService`（当前 HTTP 已覆盖 OpenAI 兼容流式）

## 五、端到端联调（✅ 已验证 2026-09-01）

**真实全栈跑通**（`CARGO EXIT 0`）：
- 启动真实 `hermes-rust serve`（8080，`/health` ok，`/v1/models` 含 `hermes-rust`）
- 启动真实 `amos-ai`（`AMOS_BACKEND=hermes`、`AMOS_HERMES_ENDPOINT=http://127.0.0.1:8080`）
- 经 amos-ai gRPC 发"你好" → hermes-rust 真实生成并**逐 token 流式**返回
- 发"帮我播放一首歌" → 返回 `media` 语义卡片
- hermes-rust 的真实流式格式 `{"content":"...","type":"token"}` 与 `parse_hermes_token` 完全匹配

**✅ 多轮记忆端到端（2026-09-01）**：前端 `ai.js` 使用**稳定会话 id**（持久化
`amos.ai.session`，同会话复用；"清空"即新会话）→ 经 `chat_agent(sessionId)` → amos-ai
`context["session_id"]` → `HermesAgentBackend` 请求体 `session_id` → hermes-rust
SQLite lineage。**同一会话的后续轮次真正续接历史**。测试：`ai: conversation id is
stable and reset starts a new one` + `hermes_body_binds_session_id_when_present`。

**测试**：`crates/amos-ai/tests/hermes_e2e.rs`
- 默认用 mock hermes（确定性，CI 可跑）
- 设 `HERMES_E2E_URL` 时连真实 hermes-rust（手动联调）

## 六、待办
- [x] 读取 hermes-rust 源码，确认接口与流式格式
- [x] 新增 `HermesAgentBackend` + `AMOS_BACKEND=hermes` 接线
- [x] 端到端联调（真实 hermes-rust serve + amos-ai hermes 后端，流式 + 卡片）
- [ ] （可选）gRPC `RunAgent`/`CallTool` 客户端（当前 HTTP 已覆盖 OpenAI 兼容流式）
- [ ] （可选）把 hermes-rust daemon 纳入 `amos-supervisor` 自愈托管

