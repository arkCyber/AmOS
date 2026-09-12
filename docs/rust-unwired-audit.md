# Rust `pub fn` audit — "defined but never referenced"

## Why this exists

The TypeScript shells have `unwired-scan.mjs`; the Rust workspace had nothing. A
`pub` item in a **library** crate is treated as reachable by the compiler, so
`dead_code` / `clippy -D warnings` never fire on it even when nothing in the whole
workspace calls it. That is exactly how `SessionManager::get_or_create` sat unused
while being *documented* as the mechanism that keys a conversation by the
client-supplied `session_id` — and `server.rs` minted a throwaway session per turn
instead (a real defect: token usage never accumulated per conversation).

`scripts/rust-unwired-scan.mjs` is the Rust counterpart of that gate.

## What it checks

Corpus: every `.rs` file under `crates/**` (skipping `target`, `gen`, …).
Declarations come from `src` files; references are counted across the whole
workspace.

* **In scope:** `pub fn` / `pub async fn` / `pub unsafe fn`.
* **Out of scope:** `pub(crate)` / `pub(super)` / private items (`dead_code`
  already warns), and **FFI entry points** — `pub extern "…" fn`, JNI `Java_*`
  names, and `#[no_mangle]` / `#[export_name]` items are **called from outside
  Rust** (the JVM, the OS) and have no in-workspace caller by design.
* A finding is a declaration with **zero references anywhere**, `tests/` included:
  a public API exercised only by an integration test is **real usage**, not dead.

Gated as a **ratchet** against `scripts/rust-unwired-baseline.json`: the existing
backlog is frozen, a **new** unwired `pub fn` fails `make lint`, and an entry that
became wired is reported so the ratchet cannot rot. `--selftest` pins the
extractor; `--json` prints the full report.

## Findings from this audit (Round 33)

One **real defect**, now fixed: `SessionManager::get_or_create` is wired into
`stream_chat`, which keys the daemon's own session by the client `session_id`
(empty id keeps the generated-id behaviour). Pinned by
`server::tests::stream_chat_keys_the_session_by_the_client_id` — two turns of one
conversation now share one session whose token total accumulates, instead of three
throwaway sessions for three turns (the negative control).

The remaining **19** entries are baselined as **library API surface**, by kind —
they are decisions, not unknowns (Round 43 wired `tauri::media::android_backend` and
dropped `ai::config::log_summary`, whose `config.rs` was deleted — see that round
below):

### Fluent constructors on public types (`with_*`)

`life_guard::with_path`, `appstore::model::with_checksum`, `asr::recognizer::with_lang`,
`devocare::spec::with_owner`, `power::policy::with_high_temp`,
`profiling::android::with_voltage_mv`, `timesync::timekeeper::with_name`.

Builder methods that exist so a caller can compose a value in one expression. The
in-workspace callers build the struct directly (or via `Default`), so these are
unused **today**; deleting them would shrink the public API for no defect fixed.
`life_guard::with_path` is additionally a documented **injection point** ("tests
inject a tempdir").

### Inspection / maintenance API on public services

`android::manager::clear_cache`, `appstore::client::android_bridge`,
`monitor::monitor::sampler_name`, `power::freq::applied_plan`,
`sms::trash::trashed_in`, `tauri::android_glue::is_armed`,
`tauri::appstore::installed_name`, `tauri::incall::is_default_dialer_bound`.

Read-only accessors (plus one cache flush) exposed by a service so a host can
inspect or maintain it. The daemon surfaces the underlying state through its own
RPC/status path, so no in-workspace caller needs these yet.

### Helpers whose host does not exist yet

`audio::android::tinyalsa::header_layout_notes` — the `pcm.h` facts the Android
audio bring-up depends on, "surfaced so bring-up tests can assert the header has
not drifted". That test needs the `android` feature + NDK, so it is not written
yet.

`network_guard::audit::dns` — a constructor for a DNS `EgressEvent`; the tests
build the struct literal instead.

`pdf_parser::model::refresh_metrics` — "recompute after a caller mutates `text`";
**no caller in the workspace mutates `text`**, so there is nothing to refresh.

`web3::secp::to_uncompressed_bytes` — SEC1 compression conversion; needs a caller
that consumes uncompressed keys.

### Round 43 — a documented builder that its own attach path re-implemented

`tauri::media::android_backend` was documented as the seam that *"build[s] the
Android MediaStore backend … ready to hand to `MediaBridge::attach`"*, but had zero
references: the JNI attach path (`media::device::install`) re-implemented the exact
same `AndroidMediaProvider::new(...)` + `Arc` wrap inline. The two could drift (any
future error mapping/logging added to the builder would silently not apply to the
path actually used on device). It now calls `android_backend`, so the Kotlin-glue →
provider conversion has one implementation; `install` only adds the exactly-once
process-global install. `android_backend` left this baseline (20 → 19). Compile
surface: both items are behind `#[cfg(feature = "android")]`.

## Running it

```sh
node scripts/rust-unwired-scan.mjs                 # gate (exit 1 on regression)
node scripts/rust-unwired-scan.mjs --json          # machine-readable
node scripts/rust-unwired-scan.mjs --selftest      # pin the extractor
node scripts/rust-unwired-scan.mjs --update-baseline
```

It runs in `make lint` (hence CI), self-test first.

## Honest boundary

This is a **static name-count** check. It can look wrong in two ways, both in the
safe direction (a false "unwired", never a false "wired"):

* an item reached only from **outside the workspace** (an FFI consumer, a
  proc-macro user) — hence the FFI exclusions above and the baseline for anything
  the exclusions miss;
* an item reached only through a **macro-generated** expansion or a string-keyed
  lookup.

Such an item belongs in the baseline with its reason recorded — **not deleted**.
Adding an entry is deliberately a recorded decision (`docs/` + the JSON), so the
backlog can only shrink-or-hold.
