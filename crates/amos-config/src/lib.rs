//! `amos-config` — layered configuration + JSON-schema validation + hot reload
//! + runtime feature flags.
//!
//! Five modules, each behind its own re-export so consumers can `use
//! amos_config::layer::Layer` (full path) **or** `use amos_config::Layer`
//! (short path):
//!
//! * [`layer`] — the four sources (`Env`, `File`, `Session`, `Remote`) and the
//!   merge order.
//! * [`schema`] — a tiny JSON Schema subset validator (type/enum/min/max/
//!   required) so a value resolved from a file can be **refused** instead of
//!   silently passed downstream.
//! * [`reload`] — polling-based hot reload (no `notify`/`inotify` dependency;
//!   the file is re-stat'd on every `Resolver::refresh()` call, which a worker
//!   thread ticks on the interval the embedder passes to
//!   `reload::Worker::spawn` — `reload::interval_from_env()` honours
//!   `AMOS_CONFIG_RELOAD_SECS`, default 60).
//! * [`feature_flag`] — runtime feature flags (local JSON + optional HTTP
//!   poll).
//! * [`audit`] — append-only change log. The **path is supplied by the
//!   embedder** (`AuditLogger::open`); the workspace convention is
//!   `~/.amos/config-audit.jsonl`, so an operator can find "what changed, by
//!   whom, when" without reading this crate.
//!
//! Honesty rules — same as the rest of the workspace:
//!
//! * Every step is best-effort. A bad file degrades to "missing layer"; the
//!   `Resolver::explain()` text reflects that, never a fabricated value.
//! * The default `Layer::Env` reads `AMOS_*` env vars. The leading `amos.` of a
//!   config key **is** the env namespace, so `amos.ai.port` is reached as
//!   `AMOS_AI_PORT`: the two directions are
//!   [`layer::env_key_to_config_key`] and [`layer::env_name_for`], and for a
//!   key whose segments contain no `_` the round trip is the identity (pinned
//!   by `layer::tests::the_env_name_and_the_config_key_are_inverses`). The
//!   mapping is a **normalisation, not a bijection**: `AMOS_FLAGS_NEW_CHECKOUT`
//!   and `amos.flags.new_checkout` both normalise to `amos.flags.new.checkout`,
//!   and no rule can separate them — write flag keys without underscores inside
//!   a segment if you need the round trip. REQ-A459:
//!   this paragraph used to promise the round trip while the code did something
//!   else (see `env_key_to_config_key`), and pointed at a
//!   `layer::key::normalize` that never existed.

#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod audit;
pub mod feature_flag;
pub mod layer;
pub mod reload;
pub mod schema;

pub use audit::{AuditEvent, AuditLogger};
pub use feature_flag::{FeatureFlagSet, FlagContext, FlagKey, FlagValue};
pub use layer::{Layer, Resolver, ResolverBuilder, SnapshotError, Source, Value};
pub use schema::{Schema, SchemaError, Type};
