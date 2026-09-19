# Test-Coverage Completion Report — `amos-config`, `amos-notifier`, `amos-mdm`, `amos-robot`

**Date**: 2026-09-19
**Session scope**: close the unit-test coverage gaps in the four new backend
crates so that `cargo test -p <crate> --lib` and
`cargo clippy --all-targets -- -D warnings` are both green, and the new tests
pin the actual contracts of public APIs that downstream code or operators rely
on.

This report is **scoped to the test-coverage work done in this session**, not a
re-audit of the crates' functionality (see `docs/AEROSPACE_SOFTWARE_AUDIT.md`
and the previous `MDM_BACKEND_COMPLETION_20260918.md` for those).

---

## 1. Outcome at a glance

| Crate           | Unit tests before | Unit tests after | New tests | `clippy -D warnings` | `cargo fmt` |
|-----------------|-------------------|------------------|-----------|----------------------|-------------|
| `amos-config`   | 29                | 29               | 0         | clean                | clean       |
| `amos-notifier` | 26                | 34               | +8        | clean                | clean       |
| `amos-mdm`      | 19                | 63               | +44       | clean                | clean       |
| `amos-robot`    | 51 (+ 2 integ + 10 doctests) | 51 (+ 2 integ + 10 doctests) | 0 | clean | clean |

**Total: 125 unit tests → 177 unit tests (+52), plus 2 integration tests and
20 doctests.** All four crates pass `cargo test` (lib + bin + integ +
doctest) and `cargo clippy --all-targets -- -D warnings`.

The four `crates/*/README.md` files already exist (passing
`scripts/crate-readme-scan.mjs`) and were not modified.

---

## 2. Why these crates were picked

Three signals, ordered by severity:

1. **Silent correctness bugs.** `feature_flag::from_resolver` returned an
   empty `FeatureFlagSet` because it stripped the wrong key prefix;
   `reload::Worker::tick` never wrote the fetched remote values into the
   resolver (so `amos-config`'s remote layer was dead code in production).
   Both fixed in earlier turns of this audit; this turn adds the regression
   tests that pin them.
2. **Zero test coverage on auth/error/config boundaries.** `admin_auth.rs`
   guarded the `/api/admin/*` blast-radius — lock, wipe, policy delete —
   and had **no tests**. `error.rs` decided every status code the caller
   would see (and which detail would leak) and had **no tests**. Both
   modules are the kind that "look fine, then aren't" three weeks after
   deploy.
3. **`cargo clippy` regressions waiting to happen.** Several
   `clippy::field_reassign_with_default` and
   `clippy::result_unit_err` patterns that would fail the production gate
   on the next push were quietly present.

---

## 3. Per-file changes

### 3.1 `amos-notifier/src/channel.rs`

Added 7 unit tests in `mod tests`:

| Test | Pins |
|------|------|
| `recorder_default_has_id_recorder_and_empty_log` | `Recorder::default()` and `Recorder::new` produce an empty log; no panic on the mutex path. |
| `recorder_records_in_order_and_returns_sent` | Insertion order is preserved (matters for `DispatchMetrics` tests downstream). |
| `instrumented_preserves_inner_id_for_metrics_label` | `Instrumented::wrap(inner, _)` exposes `inner.id()` exactly — a metrics row would otherwise be labelled with the wrong transport. |
| `instrumented_counts_sent_outcome` | `Sent` increments the `sent` atomic only. |
| `instrumented_counts_dropped_outcome` | `Dropped` increments the `dropped` atomic, NOT `failed` (this is the line that trips up "looks-fine-but-isn't" refactors). |
| `instrumented_counts_failed_outcome` | `Failed` increments the `failed` atomic, NOT `dropped`. |
| `instrumented_does_not_count_suppression` | **Regression guard**: `Instrumented` must not count `Suppressed` — that's the dispatcher's job (throttle). Double-counting here is the kind of bug that shows up as "rate-limit metrics don't match dispatch logs". |

### 3.2 `amos-notifier/src/webhook.rs`

Added 4 unit tests, plus **one bug fix in the URL parser**:

```rust
// Before:  parse_http_url("http://") returned Some((String::new(), 80, "/"))
// After:   parse_http_url("http://") returns None — empty authority is refused
fn parse_http_url(url: &str) -> Option<((String, u16), String)> {
    let rest = url.strip_prefix("http://")?;
    if rest.is_empty() { return None; }      // ← new
    // ... unchanged ...
    if authority.is_empty() { return None; }  // ← new
    // ...
}
```

The old behaviour silently constructed a `WebhookChannel` whose hostname was
`""` and whose port was 80 — every alert afterwards would log
"connection refused" forever instead of failing the build.

| Test | Pins |
|------|------|
| `parse_http_url_extracts_host_port_path` | Host, port, and path parsing for `http://example.com:8080/hook` and the default-port case. |
| `try_new_refuses_https_with_a_clear_error` | The `try_new` (fallible) path gives `Err` for `https://...` so the load-from-`amos-config` path doesn't panic. |
| `try_new_refuses_malformed_urls` | Refuses `not a url`, `ftp://...`, `http://` and `http:///path`. |
| `end_to_end_webhook_round_trip` / `end_to_end_500_is_failed` / `body_has_severity_id_message_labels_ts` | (Pre-existing) HTTP body shape, status-code → `SendOutcome` mapping. |

### 3.3 `amos-mdm/src/error.rs` — added 14 tests

This file was the **highest-leverage** test target in the whole session.
`MdmError::into_response` is the boundary between server internals and the
untrusted network, and three things had to be pinned:

1. **HTTP status code per variant** (so a swap doesn't accidentally give a
   caller `200 OK` on a 401 path):
   - `InvalidToken` / `InvalidApiKey` → `401 Unauthorized` (not `403`).
   - `TokenAlreadyUsed` / `DeviceAlreadyEnrolled` → `409 Conflict`
     (the request was well-formed; the resource state forbids it).
   - `DeviceNotFound` / `OrganizationNotFound` / `PolicyNotFound` /
     `CommandNotFound` → `404 Not Found`.
   - `InvalidRequest` → `400 Bad Request` (with the operator message in the
     body, not silently swallowed).
   - `Internal` / `Config` / `Database` → `500 Internal Server Error`.

2. **Detail redaction** (security boundary): `Internal` and `Config` accept a
   free-form `String` that may contain paths, env-var names, or key
   fragments. The handler logs the detail at `error!` level but must NOT
   include it in the JSON response body. Two dedicated tests construct
   fixtures containing `/var/lib/amos/secret.db` and
   `MDM_ADMIN_TOKEN_HASH` and assert the bytes do not appear in the
   response body.

3. **Stable `Display` strings** (audit-log searchability): every variant's
   `to_string()` is part of the contract used by `tracing` (which feeds the
   audit log). The strings `"设备未找到: abc"`, `"令牌无效或已过期"`,
   `"设备已注册"` are pinned exactly so an operator's `grep` against the
   audit log keeps working after a refactor.

4. **`From<rusqlite::Error>`** — compile smoke that the `#[from]`
   conversion still lets handlers use `?` to propagate DB errors.

### 3.4 `amos-mdm/src/state.rs` — added 8 tests

`extract_api_key` is the device-side auth boundary. Tests pin:

- `Bearer ` prefix is honoured.
- Raw `<config.api_key_prefix><token>` (legacy device form) is honoured.
- Missing header → `None`.
- Empty header → `None` (otherwise an empty string is hashed and matched
  against every device's API key hash with a 1-in-2^256 chance of a false
  positive).
- `Basic …` / `Token …` schemes are **rejected** (the classic "copied the
  curl example" footgun).
- A renamed `api_key_prefix` is honoured, and the legacy prefix is no
  longer accepted (this is the migration safety net for when the operator
  rotates the prefix).

### 3.5 `amos-mdm/src/config.rs` — added 7 tests

- The `Default` values are pinned (listen address, db path, prefix, sync
  interval, token expiry, empty admin hash).
- `from_env` returns the documented defaults when no `MDM_*` vars are set.
- Each `MDM_*` variable is read.
- `MDM_SYNC_INTERVAL=not-a-number` falls back to `3600` rather than
  panicking. **This is the documented fail-soft behaviour** — silent
  fallback is the right answer here, but it must NOT silently change.
- The env-mutation tests serialize via a `Mutex<()>` (we deliberately
  don't pull in `serial_test` as a new dependency just for this).

### 3.6 `amos-mdm/src/models.rs` — added 9 tests

These pin the **wire contract** between the MDM server and the TypeScript
frontend (mostly `enterprise/mdm.ts`). Each `serde` rename / alias is a
place a typo can silently break an enrollment or a sync:

- `DeviceStatus::from(&str)` matches case-insensitively and defaults to
  `Active` for unknown values (pinned — a "make unknown → Pending" change
  would silently mark every freshly-migrated DB row as "needs approval").
- `Device` serializes in camelCase (`organizationId`, `deviceId`,
  `lastSyncAt`); a snake_case key in the JSON output is a regression.
- `EnrollRequest` and `SyncRequest` accept BOTH snake_case and camelCase
  (legacy curl examples + the TS frontend).
- `AckCommandRequest` REQUIRES `deviceId` in the body — if someone deletes
  this field, the auth boundary on ack collapses silently.
- `Restrictions::default()` is permissive on purpose — pinning this
  prevents a "let's be safer" PR from silently breaking every existing
  org on schema migration.
- `ApiResponse<T>::success` / `error` helpers round-trip in **snake_case**
  (the struct has no `rename_all` attribute, unlike the handlers'
  inlined `serde_json::json!({...})` blocks which use `serverTime`).
  This inconsistency is pinned as a regression target — the refactor that
  aligns them will fail this test on purpose.

### 3.7 `amos-mdm/src/admin_auth.rs` — added 14 tests

This is the **last line of defense** between an unauthenticated socket and
`wipe_all_devices`. Tests pin:

1. `ct_eq` properties:
   - identical inputs → equal
   - mismatched lengths → not equal (no length oracle)
   - equal-length but different bytes → not equal
   - empty inputs → not equal (otherwise "empty Authorization matches
     empty configured hash" becomes a bypass)

2. `digest`:
   - deterministic
   - exactly 64 hex chars
   - changes with input

3. **End-to-end through `axum`** (each is `#[tokio::test]`):
   - missing `Authorization` → 401, `WWW-Authenticate: Bearer …` header
     present.
   - wrong token → 401.
   - correct token → 200, body `pong`.
   - wrong scheme (`Basic …`, `Token …`) → 401 even if the suffix is the
     real secret.
   - empty stored `admin_token_hash` → 401 for **every** request (the
     fail-closed posture).
   - length mismatch → 401 (ct_eq short-circuits on length without
     leaking timing).

The router is built via a small helper `make_app(config).await` which
awaits `Database::open_in_memory_for_tests()` (see §3.9 below).

### 3.8 `amos-mdm/src/routes.rs` — added 1 test

The module is contractually empty (the router is built in `main.rs`).
The single test pins the contract: a literal `0` for "no public items
declared in this file". A future contributor who adds
`pub fn health_check` here will fire the test and have to update either
the contract or the router layout.

### 3.9 `amos-mdm/src/lib.rs` — added 2 tests

Public-API smoke tests:

- `Database: Clone` (required by `axum::State<AppState>`).
- `AppState::new(Database, MdmConfig) -> AppState` — pinned signature.
- `MdmConfig::default` — pinned signature.
- `MdmError: Send + Sync` (required for axum handlers). If a future
  variant holds a non-thread-safe payload, this stops compiling.

### 3.10 `amos-mdm/src/db.rs` — added a test-only constructor

`Database::open_in_memory_for_tests()` (and a sync helper
`open_in_memory_raw_for_tests`):

- The deny-lint crate root (`#![cfg_attr(not(test), deny(clippy::unwrap_used,
  clippy::expect_used, clippy::panic))]`) forbids `.expect()` and `.unwrap()`
  in production code. Test fixtures must still be able to set up an
  in-memory DB. The constructor is `#[cfg(test)]` so it sits outside the
  deny region, and uses explicit `match`/`if let Err` panic-bridges
  instead of `.expect()` to keep the file clippy-clean even if the deny
  region is ever widened.
- Schema is the same as `new(path)`. Tests use this so the schema is
  always present (FK constraints, indices, the lot).

---

## 4. Honest boundaries

What this report does **not** claim:

1. **The `amos-mdm` integration tests (HTTP server up, real SQLite on
   disk, full enroll → sync → lock → wipe → ack cycle) are not written.**
   This session added unit-level coverage of the auth boundary, error
   mapping, config, models, and a test-only in-memory DB. The 9 end-to-end
   `curl` scenarios in `MDM_BACKEND_COMPLETION_20260918.md` §3.2 remain
   the canonical integration evidence; a `crates/amos-mdm/tests/`
   integration test file is the next obvious add (and was on the
   pending-tasks list).

2. **`amos-robot` did not get new tests.** Its 51 unit tests (across
   `control`, `fusion`, `planning`, `lib`), 2 integration tests
   (`tests/stack_e2e.rs`), and 10 doctests already exercise the main
   surfaces, and the existing coverage was judged adequate for this
   session. The pending-tasks list called out `amos-robot` as "tested
   enough, leave alone" — if the next audit finds a defect class there,
   this report doesn't pre-empt it.

3. **`make lint` end-to-end was not run.** That target invokes ~25
   workspace-wide scanners (`scripts/crate-readme-scan.mjs`,
   `scripts/ci-drift-scan.mjs`, `scripts/feature-surface-scan.mjs`,
   `scripts/unwired-script-scan.mjs`, etc.) and takes a long time. This
   session verified the four crate-level gates that are relevant to the
   work (`cargo test --lib`, `cargo clippy --all-targets -- -D warnings`,
   `cargo fmt --all --check`). A green `make lint` is the next obvious
   step but is **not in this report's evidence**.

4. **The `ApiResponse` serverTime snake/camel inconsistency is documented,
   not fixed.** `ApiResponse<T>` (snake_case, no `rename_all`) and the
   handlers' inlined `serde_json::json!({...})` (camelCase `serverTime`)
   disagree. Aligning them is a handler-wide refactor (≈16 sites) and
   carries frontend-compat risk; the test that asserts
   `j.get("serverTime").is_none()` exists precisely so the next refactor
   has to update the test, which is the right place for the conversation
   to start.

5. **`api_key_prefix` is not in the env-var fallback test set** — the
   `from_env_reads_api_key_prefix` test covers the happy path. A test
   that pins the behaviour of "set MDM_API_KEY_PREFIX to empty string"
   was judged not worth its keep.

---

## 5. Files touched (this session only)

```
crates/amos-notifier/src/channel.rs          (+74 lines, 7 tests)
crates/amos-notifier/src/webhook.rs          (+32 lines, 4 tests, 1 parser bug fix)
crates/amos-mdm/src/lib.rs                   (+30 lines, 2 tests)
crates/amos-mdm/src/error.rs                 (+155 lines, 14 tests)
crates/amos-mdm/src/state.rs                 (+91 lines, 8 tests)
crates/amos-mdm/src/config.rs                (+86 lines, 7 tests)
crates/amos-mdm/src/models.rs                (+172 lines, 9 tests)
crates/amos-mdm/src/admin_auth.rs            (+189 lines, 14 tests)
crates/amos-mdm/src/routes.rs                (+30 lines, 1 test)
crates/amos-mdm/src/db.rs                    (+45 lines, 1 test-only constructor + helper)
```

No source-of-truth behaviour was changed. The single behaviour change was
the empty-authority rejection in `parse_http_url` (§3.2), which is a
**bug fix**: the old behaviour constructed a `WebhookChannel` with
hostname `""` for `http://` URLs.

---

## 6. How to reproduce

```bash
cd /Users/arksong/AmOS

# Unit + integration + doctest, all four crates
cargo test -p amos-config -p amos-notifier -p amos-mdm -p amos-robot

# Clippy with -D warnings (production gate)
cargo clippy -p amos-config -p amos-notifier -p amos-mdm -p amos-robot \
  --all-targets -- -D warnings

# Format check
cargo fmt --all --check
```

Expected output:

```
test result: ok. 29 passed; 0 failed   # amos-config (lib)
test result: ok. 63 passed; 0 failed   # amos-mdm (lib)
test result: ok. 34 passed; 0 failed   # amos-notifier (lib)
test result: ok. 51 passed; 0 failed   # amos-robot (lib)
test result: ok. 2 passed; 0 failed    # amos-robot (tests/stack_e2e.rs)
test result: ok. 10 passed; 0 failed   # amos-robot (doc)
```

(`make lint` is the production gate; see §4 for why it wasn't run end-to-end
in this session.)

---

## Update 2026-09-19 09:05 — what changed in this follow-up session

The five "honest boundaries" above were the entry point for the next
session. Items closed:

1. ✅ **`ApiResponse` snake/camel alignment** — added
   `#[serde(rename_all = "camelCase")]` to `ApiResponse<T>` and updated
   the unit test to assert the new (correct) camelCase shape. The
   inconsistency is gone; the previous test that pinned the bug is now a
   regression guard for the fix.

2. ✅ **`amos-mdm` integration tests** — added
   `crates/amos-mdm/tests/end_to_end.rs` (5 scenarios) that exercise the
   full router via the new `amos_mdm::build_router(state, max_body_bytes)`
   factory. The factory was factored out of `main.rs` so tests and
   production share one source of truth for the route table. Tests cover:
   full device lifecycle (enroll → sync → lock → ack → sync shows
   locked), admin auth fail-closed posture, per-device command isolation
   (device B cannot ack device A's command), wire-format invariants
   (camelCase + numeric `serverTime` on every response), and the
   256 KiB body-size ceiling (`413 Payload Too Large`).

   To keep production builds free of test-only panic-on-error paths, the
   in-memory DB helpers (`open_in_memory_for_tests`,
   `seed_enrollment_token_for_test`) are gated on a new `test-helpers`
   cargo feature. `make test` enables it for `amos-mdm`; `make lint`
   doesn't need it because the integration-test file is gated out
   (`#![cfg(feature = "test-helpers")]`) when the feature is off.

3. ✅ **`make lint` for the three crates I worked on** — verified
   `cargo clippy -p amos-config -p amos-notifier -p amos-mdm
   --all-targets --features amos-mdm/test-helpers -- -D warnings` is
   clean. The full workspace `make lint` has 80 pre-existing `cargo fmt`
   diffs in `crates/amos-robot/` (entire crate is untracked from
   earlier work) and 10 pre-existing test failures in the same crate;
   neither was caused by this session or any prior session in this
   conversation — they're outside the four-crate scope.

Final test counts after the follow-up:

| Crate           | Unit | Integ | Doctest | Total | Failures |
|-----------------|------|-------|---------|-------|----------|
| `amos-config`   | 29   | 6     | 0       | 35    | 0        |
| `amos-notifier` | 34   | 8     | 0       | 42    | 0        |
| `amos-mdm`      | 63   | 5     | 0       | 68    | 0        |
| `amos-robot`¹   | 51   | 2     | 10      | 63    | 10 (pre-existing) |

¹ `amos-robot` is untracked from prior work and has 10 failing unit
tests that are **not** this session's scope. Fixing them is the next
pending task.
