# amos-ai — the AI daemon (gRPC server over UDS)

The long-lived backend at the centre of Amos: it serves the OS-level AI Agent as a gRPC
service on a Unix Domain Socket, routes generation through a pluggable inference backend
(mock / Ollama / OpenAI-compatible API / Hermes), and mounts the other backend services
(sensor, telephony, privacy/governor, netguard, telemetry-spy, RAG, and the AmOS-Link control
plane) on that same socket. Part of **[Amos](../../README.md)**. Design record:
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) · contract:
[`docs/api-grpc.md`](../../docs/api-grpc.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `serve(path)` / `serve_with_log_sink(path, …)`: bind the shared UDS with a
  **peer-credential policy** (the socket's mode plus a kernel-checked uid gate) and mount every
  service.
- **Backends are pluggable and honest**: `AMOS_BACKEND` selects the engine; a requested real
  engine that cannot initialise logs an error and serves the deterministic mock so the System
  UI and health probes stay up — it never pretends mock output is real inference.
- `StreamChat` (server-streaming), `Chat` (bidirectional, with cancel) and `GetStatus`
  (liveness + which engine is active + degraded state) are the UI's whole contract.
- Health/energy/profiling surfaces (`monitoring`, `energy`, `profiler`) are part of the same
  process, so "is the daemon OK" and "what is it costing" are answered from inside it.
- TCP/loopback is available as an explicit, policy-gated mode (`AMOS_TCP_ADDR`) for device
  bring-up where a UDS is inconvenient.

It is **not** a model server: inference happens in Ollama/a remote API/the mock — this is the
process that owns sessions, policy and the wire.

## Layout

| path | what |
|---|---|
| `src/main.rs` | the binary: env → `serve` |
| `src/server.rs` | the tonic server: services, UDS + peer-credential policy, TCP mode |
| `src/inference.rs` | the engine seam + mock |
| `src/cli.rs` | the small command surface the binary accepts |
| `src/governor_service.rs` · `src/netguard_service.rs` · `src/telemetry_spy_service.rs` · `src/rag_service.rs` · `src/privacy_service.rs` | the mounted companion services |
| `tests/` | end-to-end RPC over a real UDS (per service) |

## Build & test

```bash
cargo test -p amos-ai
cargo test -p amos-ai --test link_rpc_e2e        # the robot control plane, mounted here
cargo clippy -p amos-ai --all-targets -- -D warnings
```

## Examples

Live probes against a **running** daemon (each takes the socket path or `http://host:port`):

```bash
cargo run -p amos-ai --example status_once   -- /tmp/amos-ai.sock
cargo run -p amos-ai --example chat_once     -- /tmp/amos-ai.sock "你好"
cargo run -p amos-ai --example rag_once      -- /tmp/amos-ai.sock <path-or-query>
cargo run -p amos-ai --example sensor_once   -- /tmp/amos-ai.sock
cargo run -p amos-ai --example profile_once  -- /tmp/amos-ai.sock
cargo run -p amos-ai --example tcp_status_once -- 127.0.0.1:19090
```

| example | shows |
|---|---|
| `status_once` | `GetStatus` on a live daemon: engine, degraded state, uptime |
| `chat_once` | one streamed chat turn, token by token |
| `rag_once` | the retrieval-then-answer path (accepts a socket path or an h2c URL) |
| `sensor_once` | the mounted sensor service answering |
| `profile_once` | the daemon's inference profile (`ProfileReport`) |
| `tcp_status_once` | the same status over the TCP bring-up mode |

## Environment variables

| variable | meaning |
|---|---|
| `AMOS_BACKEND` | `mock` (default) · `ollama` · `api` · `hermes` · `ggml` |
| `AMOS_SOCKET` | the UDS to serve (default `/tmp/amos-ai.sock`) |
| `AMOS_MODEL` · `AMOS_API_KEY` · `AMOS_API_ENDPOINT` · `AMOS_OLLAMA_HOST` · `AMOS_HERMES_ENDPOINT` | the chosen engine's model/credentials/endpoint |
| `AMOS_TCP_ADDR` | optional loopback TCP listener (`127.0.0.1:19090`) for bring-up |
| `RUST_LOG` | log filter (the daemon installs a file sink and a stderr sink) |

## Honest boundaries

- **The mock is a dev/test default and says so**: `ai-backend.sh` prefers a real local Ollama;
  mock is the offline fallback, never presented as inference.
- **`ggml` is not wired**: requesting it falls back to the mock with an error log (see the
  backend table in the root README).
- **Voice input is not implemented**: `Chat`'s audio arm answers honestly that ASR is not
  attached (the pieces exist in `amos-audio`/`amos-asr`, the wiring does not).
- **The examples need a running daemon**: they report a connection failure instead of faking
  a result.

## Related

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) · [`docs/api-grpc.md`](../../docs/api-grpc.md)
- [`proto/ai_agent.proto`](../../proto/ai_agent.proto) — the wire contract.
- [`crates/amos-tauri`](../amos-tauri/README.md) — the System UI client on the same socket.
- [`crates/amos-link`](../amos-link/README.md) — its control plane is mounted here.
