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
backlog is frozen, a **new** unwired `pub fn` fails `make lint`, and the baseline
is itself checked (REQ-A445) — **R1** an entry with no real `why` fails, **R2** an
entry whose symbol is referenced now fails (the ratchet must shrink, not rot; it
used to be a printed note that nothing acted on), **R3** a duplicate `value` fails.
`--selftest` pins the extractor and those three rules; `--json` prints the full
report. Each entry carries its `why` **next to the symbol** (plus a `kind`, whose
rationale is the prose below), so an excuse cannot live in a document nobody diffs.

## Findings from this audit (Round 33)

One **real defect**, now fixed: `SessionManager::get_or_create` is wired into
`stream_chat`, which keys the daemon's own session by the client `session_id`
(empty id keeps the generated-id behaviour). Pinned by
`server::tests::stream_chat_keys_the_session_by_the_client_id` — two turns of one
conversation now share one session whose token total accumulates, instead of three
throwaway sessions for three turns (the negative control).

The remaining **24** entries are baselined by `kind` — **7** `library-surface`, **8**
`inspection-api`, **4** `host-missing` and **5** `planned-feature` (the counts are read off
`scripts/rust-unwired-baseline.json`'s own `entries.length`, not remembered here: REQ-A445
corrected a stale "25" and the script now checks every entry's reason; REQ-A446 moved Spaces'
two window helpers out of `planned-feature` by wiring them) —
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

### Spaces: the window half of the feature (REQ-A389 → **closed by REQ-A446**)

`tauri::spaces::space_for_window` — the only one of the three left.

The Spaces ledger was wired by REQ-A389: `mod spaces;` / `mod spaces_commands;` declared,
`Mutex<SpaceManager>` managed (loaded from the shared store, so a restart restores the spaces), the
`spaces_*` commands registered, and the shell's `SpacesPanel` — already mounted and calling them —
working.

The *window* half is wired as of **REQ-A446**. `spaces_switch` now applies
`SpaceManager::switch_plan` — hide what the destination Space does not own, reveal what it does — so
switching a desktop moves the windows instead of only the number the panel draws.
`active_space_windows` and `is_window_in_active_space` are the two helpers that plan is built from,
so they **left this baseline** (R2, 26 → 24) instead of being excused, and the plan's own semantics
(unfiled windows are in every Space; the Launcher is neither hidden nor focused; a window filed
twice is never in both lists) are pinned by unit tests in `spaces.rs`.

`space_for_window` stays: the reverse mapping (window → its Space) is not needed by a switch; its
caller is a panel that wants to say "this window lives in 工作", a UI that does not exist yet.

Boundary, stated because a switch is device-visible behaviour: the plan and the applier's failure
contract are unit-tested, and the command path is type-checked and arg-scanned, but **no real
window was moved on a real desktop by this round** — that needs a launch (`make app-open`).


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

### REQ-A411 — the read side of two in-flight device features, and the MDM command-failure path

Four entries (baseline 22 → 26). None of them is dead code in the "nobody wrote the caller"
sense that `get_or_create` was; each is the **unfinished half of a feature whose write side
exists**, recorded so the gap stays visible instead of reading as "done".

`tauri::jni_glue::take_tag`, `tauri::jni_glue::peek_tag` (NFC),
`tauri::jni_glue::take_pending_notification` (BLE GATT notifications).

`crates/amos-tauri/src/jni_glue.rs` is the host-side state cell for the Kotlin glue (feature
`android`): Kotlin callbacks write a discovered tag / a GATT notification into it, and a host
command reads it back. The BLE half is half-wired — `ble.rs` does call `take_services` and
`take_pending_read` — but nothing reads the NFC tag or a notification value, and no host
command exposes them, so the two `take_*`/`peek_*` accessors have no caller. Two of them were
already marked `#[allow(dead_code)]` by their author, i.e. the intent was recorded but never
turned into a wiring. They are **not deleted**: the state they read is populated by device
callbacks, and the missing piece is a `nfc_*`/`ble_*` command (a screen + i18n + a real device
run), not the accessor.

`mdm::db::fail_command`.

The MDM server's command lifecycle has `create_command` → `get_pending_commands` →
`ack_command`, and `fail_command` (which writes `status = 'failed'`) is the only writer of that
state. It has no caller because the ack request carries `result: Option<String>` and **no
failure signal** (`models::AckCommandRequest`), so a device reporting a failed lock/wipe is
recorded as `acknowledged` today. Wiring it is a protocol decision (add a status to the ack
body) that belongs to the MDM workstream; baselining it keeps the unwired gate honest in the
meantime.

### REQ-A459 — a documented default whose resolver had no caller (plus three more zero-reference surfaces)

`crates/amos-config` came into the tree with **four** `pub fn` that nothing anywhere referenced —
the `get_or_create` shape one crate over, and all four sitting in the **feature-flag / typed-config
read path**, which is exactly where "looks configured, is not" is most expensive:

* `feature_flag::default_file_path` — the function that **implements** the module header's promise
  (*"`~/.amos/feature-flags.json` (override with the `AMOS_FEATURE_FLAGS_FILE` env var)"*). Nothing
  called it, so **neither the default path nor the override existed in any code path**: the
  documented "local source" was prose. **Wired, not baselined** — a new
  `FeatureFlagSet::from_local()` is the one entry point that consults `default_file_path()` and reads
  the file through `from_file`. The test drives it through the documented env override and carries the
  negative control that matters: when the file turns into garbage the flag must read **off**, never
  "still on from the last good read" (a silent fail-open).
* `layer::get_typed` — the typed config read. **Wired to a test** pinning all three outcomes: a typed
  hit; an absent key as `Ok(None)` (absence is not an error, and must never become a fabricated
  default); a shape mismatch as an `Err` **naming the key**, so the caller learns which key lied.
* `layer::feature_flags` — the resolver→flag-set composition. **Wired to a test** whose load-bearing
  assertion is the negative control: only `amos.flags.*` becomes a flag, so an unrelated config key
  set to `true` cannot be turned into a gate by accident.
* `layer::env_name_for_pub` — **deleted**. Its doc claimed a consumer ("so the hot-reload worker can
  normalise keys without going through a `Resolver`"), but the worker calls the **other** direction
  (`env_key_to_config_key_pub`); the only code that needs this direction is the env layer itself,
  which uses the private `env_name_for`. Keeping it would advertise a direction for which no host
  exists — "delete if you can", as the robot audit's rule says.

Baseline unchanged at **24**: the four were *new* findings, not acknowledged entries, so nothing was
excused. A `NOTE` left in `layer.rs` records why `env_name_for_pub` is deliberately absent, so the
next round cannot re-add it without a caller.

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
Adding an entry is deliberately a recorded decision, and since REQ-A445 that is enforced rather
than asserted: the reason lives in the JSON next to the symbol (R1), `--update-baseline` keeps
every reason it was given and marks a new entry `UNREVIEWED` — which R1 refuses — so the writer
cannot excuse a finding, an entry that is wired again must be removed (R2), and the backlog can
therefore only shrink-or-hold.
