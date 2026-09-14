# amos-translate — the interpretation daemon (gRPC over UDS)

The daemon that serves translation over the shared Unix Domain Socket, with pluggable
providers (Ollama / Hermes / an OpenAI-compatible API / a deterministic mock) chosen from the
environment and reported honestly when one is unreachable. Part of
**[Amos](../../README.md)**. Design record:
[`docs/translate-daemon.md`](../../docs/translate-daemon.md) ·
[`docs/api-grpc.md`](../../docs/api-grpc.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `serve(path)` mounts the gRPC service (`proto/translate.proto`) on a UDS — the same socket
  family as `amos-ai`, `sensor`, `telephony` and the link control plane.
- `provider_from_env()` picks the backend (`OLLAMA` / `HERMES` / `API` / mock) and
  `recognizer_from_env()` optionally wires speech input, so voice and text arrive through one
  service.
- `TranslateConfig` holds the request shape (source/target language, both-directions), and
  every refusal is a typed status rather than an empty string.
- A requested-but-unreachable real backend is **reported as degraded** — the daemon does not
  silently answer from the mock and call it a translation.

It is **not** a model: no inference engine is implemented here; providers call one.

## Layout

| file | what |
|---|---|
| `src/main.rs` | the binary (env → serve) |
| `src/lib.rs` | `serve`, `provider_from_env`, `recognizer_from_env`, `TranslateConfig` |
| `tests/` | end-to-end RPC over a real UDS |

## Build & test

```bash
cargo test -p amos-translate
cargo run -p amos-translate                       # serve on /tmp/amos-translate.sock
cargo run -p amos-translate --example status_once -- /tmp/amos-translate.sock
cargo run -p amos-translate --example translate_once -- /tmp/amos-translate.sock "Hello" en zh
cargo clippy -p amos-translate --all-targets -- -D warnings
```

## Examples

| example | shows |
|---|---|
| `status_once` | one `GetStatus` against a **running** daemon: which provider is active and whether it is degraded |
| `translate_once` | one translation request end to end (text, source and target language) and the streamed result |

```bash
cargo run -p amos-translate --example status_once -- /tmp/amos-translate.sock
cargo run -p amos-translate --example translate_once -- /tmp/amos-translate.sock "你好" zh en
```

## Environment variables

| variable | meaning |
|---|---|
| `AMOS_TRANSLATE_SOCKET` | socket path to serve (falls back to `AMOS_SOCKET`, then the platform default) |
| `AMOS_TRANSLATE_BACKEND` | which provider to build (`ollama` default, or `mock` / `api` / `hermes`) |
| `AMOS_TRANSLATE_HOST` · `AMOS_TRANSLATE_MODEL` · `AMOS_TRANSLATE_API_KEY` | provider endpoint, model and key |
| `AMOS_TRANSLATE_SOURCE` · `AMOS_TRANSLATE_TARGET` | default language pair (e.g. `auto` → `zh`) |
| `AMOS_SOCKET` | the shared daemon socket (used when no translate-specific path is set) |

## Honest boundaries

- **The examples need a running daemon** (or a socket path argument); they open a real channel
  and report the connection failure instead of faking a result.
- **A real backend needs a real server** (Ollama/Hermes/API); the mock is the offline default
  and says it is the mock in `GetStatus`.
- **Quality belongs to the model**; this crate owns the contract, the routing and the honest
  degraded state.
- **The service is UDS-scoped**: TCP/loopback exposure is a deployment decision made by the
  daemon's transport policy, not by default here.

## Related

- [`docs/translate-daemon.md`](../../docs/translate-daemon.md) — providers, env and the health
  semantics.
- [`proto/translate.proto`](../../proto/translate.proto) · [`docs/api-grpc.md`](../../docs/api-grpc.md)
- [`crates/amos-int-cli`](../amos-int-cli/README.md) — the interpretation front end that talks
  to this daemon.
