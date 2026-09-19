# amos-config — layered configuration, hot reload, runtime feature flags

Layered config (`system → user → session-env → remote`) with a JSON-Schema subset that
**refuses** bad values, a polling hot-reload worker, an append-only change audit, and
fail-closed runtime feature flags. Part of **[Amos](../../README.md)**. Runbook:
[`docs/devops.md`](../../docs/devops.md) §4.

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `layer.rs`: the four `Layer` variants and the merge order (later overrides earlier),
  plus `Resolver::explain()` — the text answer to "why is this value what it is?".
- `schema.rs`: a JSON-Schema subset (`type` / `enum` / `min` / `max` / `required`) so a
  value read from a file is **refused**, not silently passed downstream.
- `reload.rs`: polling hot reload — no `notify`/`inotify` dependency; the file is
  re-stat'd on every `Worker::tick()`, and `interval_from_env()` reads
  `AMOS_CONFIG_RELOAD_SECS`.
- `feature_flag.rs`: runtime flags from a local JSON file and from `AMOS_FLAG_*` env
  values; an unknown key evaluates to `false` (fail-closed, so a typo cannot grant
  access).
- `audit.rs`: append-only change log. The embedder picks the path; the workspace
  convention is `~/.amos/config-audit.jsonl`.

It is **not** a service-configuration daemon: it does not use inotify, it does not fetch
a remote layer over HTTP (the embedder supplies the fetcher), and `Layer` has no
session-scoped variant.

The documented key namespace is `amos.*`, and the env spelling of `amos.ai.port` is
`AMOS_AI_PORT` — those two names are the same lookup.

## Layout

| file | what |
|---|---|
| `src/layer.rs` | `Layer`, `Resolver`, `ResolverBuilder`, `Value`, key normalization |
| `src/schema.rs` | the JSON-Schema subset validator |
| `src/reload.rs` | `Worker`, `interval_from_env`, `DEFAULT_RELOAD_SECS` |
| `src/feature_flag.rs` | `FeatureFlagSet`, `FlagContext`, the evaluation rules |
| `src/audit.rs` | `AuditLogger`, `AuditEvent` |
| `examples/` | `layered_resolve`, `feature_flags` |

## Build & test

```bash
cargo test -p amos-config
cargo clippy -p amos-config --all-targets -- -D warnings
node scripts/rust-unwired-scan.mjs    # a documented capability must have a caller
node scripts/env-doc-scan.mjs         # every AMOS_* a doc names must be read in code
```

## Examples

```bash
# Layer order + explain() + a typed read. Offline (env layer + one registered default).
cargo run -p amos-config --example layered_resolve
AMOS_AI_PORT=9090 cargo run -p amos-config --example layered_resolve   # the override wins

# The three flag shapes (boolean / percent / user list) + the fail-closed rule.
cargo run -p amos-config --example feature_flags
```

| example | shows |
|---|---|
| `layered_resolve` | `explain()` printing every layer's contribution, then `get_typed::<u16>`; the documented `AMOS_AI_PORT` override actually taking effect |
| `feature_flags` | a JSON file read through `from_file`; `percent` as a **stable** `fnv1a(install_id) % 100` bucket; an unknown key reading `false` |

## Honest boundaries

- **The remote layer is fetched by the embedder.** `Worker::with_remote_fetcher` takes a
  closure and this crate ships no HTTP client. Remote rules **win** over local ones.
- **The reload interval is chosen by the embedder.** `Worker::spawn(interval)` takes it
  explicitly — pass `interval_from_env()` to honour `AMOS_CONFIG_RELOAD_SECS`
  (default 60 s; a zero / negative / unparsable value is refused and reported rather
  than becoming a busy loop).
- **The audit path is supplied by the embedder** (`AuditLogger::open`); there is no
  built-in default path.
- **Key normalization is a normalization, not a bijection:**
  `AMOS_FLAGS_NEW_CHECKOUT` and `amos.flags.new_checkout` both land on
  `amos.flags.new.checkout`. Keep `_` out of the segments of a key you need to
  round-trip.
- **`~/.amos/feature-flags.json` is the default flag file** only when
  `AMOS_FEATURE_FLAGS_FILE` is empty; a path that cannot be resolved (or a file that is
  missing/malformed) yields the empty set — never a fabricated "enabled".

## Related

- [`docs/devops.md`](../../docs/devops.md) §4 — the runbook for this crate.
- [`crates/amos-notifier`](../amos-notifier/README.md) — the alerting half of the same
  ops surface.
- [`docs/ENV_VARIABLES.md`](../../docs/ENV_VARIABLES.md) — the list of env knobs.
