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

### The module-level pass (REQ-A480)

The rule above counts the **declaring file's own** references (minus the declaration) as usage —
which a *coordinated* module can satisfy entirely by itself: its helpers call each other and its
tests call everything, so the file looks wired while nothing outside it ever mentions it
(`crates/amos-tauri/src/recording.rs` did exactly that for 207 lines / 7 public items, while
`lib.rs` described it as "used by telephony").

So one level up, the same question is asked about the **module**: a file that *is* a module
(`mod <name>;` is declared somewhere — `mod.rs` facades excluded) must have at least one public
item name referenced from **another file**, production or test. One finding per orphan, spelled
`path::*`, which is why it reuses this same baseline file, the same R1/R2/R3 rules and the same
`--update-baseline` writer: an orphan that gets wired reports `stale-entry` like any other entry.
Measured when it was added: `572 .rs` files, **exactly one** orphan in the whole workspace.

**Where the rule came from** (REQ-A481 corrected this paragraph's first draft): the *frontend* has
had this pass for longer and in a stricter form — `crates/amos-tauri/frontend-ts/scripts/unwired-scan.mjs`
check 1 (`src/lib` module **reachability** from a production root: hard gate, no baseline), check 4
(a `*.svelte` component no chain mounts) and a 114-entry ratchet for value exports. It was written
for exactly this defect class (`wm.ts` had a full bridge plus tests and zero importers). So the
Rust module pass is **parity with the frontend**, not an invention; what was missing on the Rust
side was one level of altitude, because a self-certifying module satisfies a per-function count.

Gated as a **ratchet** against `scripts/rust-unwired-baseline.json`: the existing
backlog is frozen, a **new** unwired `pub fn` fails `make lint`, and the baseline
is itself checked (REQ-A445) — **R1** an entry with no real `why` fails, **R2** an
entry whose symbol is referenced now fails (the ratchet must shrink, not rot; it
used to be a printed note that nothing acted on), **R3** a duplicate `value` fails,
**R4** (REQ-A647) an entry whose `why` claims *the daemon* reports the same fact —
for a crate `crates/amos-ai` does not depend on — fails. R1 asks whether a reason
**exists**; R4 is the first rule that asks whether it is **true** (against the
daemon's own manifest). `--selftest` pins the extractor and those four rules;
`--json` prints the full report. Each entry carries its `why` **next to the symbol**
(plus a `kind`, whose rationale is the prose below), so an excuse cannot live in a
document nobody diffs.

## Findings from this audit (Round 33)

One **real defect**, now fixed: `SessionManager::get_or_create` is wired into
`stream_chat`, which keys the daemon's own session by the client `session_id`
(empty id keeps the generated-id behaviour). Pinned by
`server::tests::stream_chat_keys_the_session_by_the_client_id` — two turns of one
conversation now share one session whose token total accumulates, instead of three
throwaway sessions for three turns (the negative control).

The remaining **20** entries are baselined by `kind` — **7** `library-surface`, **7**
`inspection-api`, **3** `host-missing` and **3** `planned-feature` (the counts are read off
`scripts/rust-unwired-baseline.json`'s own `entries.length`, not remembered here: REQ-A445
corrected a stale "25" and the script now checks every entry's reason; REQ-A446 moved Spaces'
two window helpers out of `planned-feature` by wiring them; REQ-A480 added the first
**module-level** entry, `crates/amos-tauri/src/recording.rs::*`) —
they are decisions, not unknowns (Round 43 wired `tauri::media::android_backend` and
dropped `ai::config::log_summary`, whose `config.rs` was deleted — see that round
below):

> **Measured 2026-09-19** (REQ-A480): `node scripts/rust-unwired-scan.mjs` prints the histogram
> itself — `baseline kinds: host-missing 5, inspection-api 8, library-surface 7,
> planned-feature 4`. It prints it *because* this paragraph drifted twice (a stale "25" that
> REQ-A445 corrected, and a stale "24" that REQ-A480 found: the file held 23). A remembered
> number in a document that says "read off the file" is the defect this project keeps
> re-finding; the fix is to make the number copy-able from a run.
>
> **Re-measured 2026-09-20** (REQ-A550): `baseline kinds: host-missing 5, inspection-api 7,
> library-surface 7, planned-feature 4` (23 total). `inspection-api` dropped 8 → 7 by **R2**,
> not by re-baselining: `tauri::incall::is_default_dialer_bound` got a real caller and the
> scan reported `stale-entry` until it was removed.
>
> **Re-measured 2026-09-20** (REQ-A588): `baseline kinds: host-missing 4, inspection-api 7,
> library-surface 7, planned-feature 3` (21 total). `life_guard::with_path` left by **wiring**
> (a new tempdir test drives the real impl; R2 reported `stale-entry` until it was removed),
> and `network-guard::audit::dns` moved `host-missing → library-surface` because its recorded
> reason was false (see below).
>
> **Re-measured 2026-09-20** (REQ-A647): `baseline kinds: host-missing 3, inspection-api 7,
> library-surface 7, planned-feature 3` (20 total). Two changes, both from *running* the gate
> rather than reading this document — which is the point of the paragraph above.
>
> 1. `audio::android::tinyalsa::header_layout_notes` left because it was **wired**, not kept:
>    REQ-A642 moved the facts to the host-compilable `amos-audio/src/tinyalsa_layout.rs` and added a
>    test that calls it, so the entry was stale and left `make lint` **red** (R2 `stale-entry`) until
>    it was removed. The round that wired the symbol reported other gates green but never ran this one.
> 2. R4 (`unverifiable-host`) was added and immediately caught two excuses that were **false** —
>    see the next subsection.
>
> **Re-measured 2026-09-21** (REQ-A832): `baseline kinds: host-missing 5, inspection-api 9,
> library-surface 14, planned-feature 3` (31 total). The count went **up by eleven** — and the
> eleven are the point: `countName` counted a bare name in the file's **raw text**, so a
> *mention* in prose witnessed a reference. Every one of the eleven was invisible before this
> round, and they were found by *changing the criterion*, not by reading this document. The
> same round found the reason the fix had been deferred: the shared comment stripper it would
> have to use was itself broken (F-DEV-104 — it opened a block comment at a `/*` written
> **inside a string literal**, deleting real code from what every gate reads). See
> "REQ-A832 — the criterion half of F-DEV-066" below.
>
> **Re-measured 2026-09-23** (REQ-A1160): `baseline kinds: host-missing 6, inspection-api 9,
> library-surface 14, planned-feature 3` (32 total). One entry moved in, and it is a *defect the
> round fixed rather than a new symbol*: `amos-tauri::push_notifications::set_permission` lost its
> only caller when the fabrication it caused was removed (REQ-A865 — the panel announced a grant
> nobody made because `push_request_permission` called it against a `None` backend). It is kept,
> `host-missing`, because it is the single place a future platform glue must land and deleting it
> would take the guard rail (its own doc comment) out with the method.
>
> **Re-measured 2026-09-25**: `baseline kinds: host-missing 4, inspection-api 9,
> library-surface 14, planned-feature 3` (30 total). One entry left, and again it was a
> **stale-entry that made the gate red** rather than a new symbol: `amos-monitor::spec::from_sample`
> — the `BatterySample` → `BatteryStatus` fold whose 2026-09-21 `why` read "monitor tests build
> `Sample` literals instead" — is now exercised by `monitor.rs`'s
> `a_live_voltage_sample_becomes_a_power_reading` / `a_nominal_voltage_sample_is_not_shown_as_a_live_reading`.
> Those tests still are not a *producer* (no production path holds an `amos_profiling::BatterySample`
> yet), which is exactly why the entry's `host-missing` reason survived two rounds while its
> "not a test either" clause quietly stopped being true. Removed from the baseline; the row in
> "The eleven that were hidden" above is the historical record of the 2026-09-21 measurement and was
> deliberately left as written.

### Fluent constructors on public types (`with_*`)

`appstore::model::with_checksum`, `asr::recognizer::with_lang`,
`devocare::spec::with_owner`, `power::policy::with_high_temp`,
`profiling::android::with_voltage_mv`, `timesync::timekeeper::with_name`.

Builder methods that exist so a caller can compose a value in one expression. The
in-workspace callers build the struct directly (or via `Default`), so these are
unused **today**; deleting them would shrink the public API for no defect fixed.

`life_guard::with_path` **left this list under REQ-A588 — it was wired, not kept.** Its
recorded `why` (and the doc comment on the constructor) both claimed it was "the documented
injection point ('tests inject a tempdir')", but no test injected one: the guard's tests all
built `PlatformProcFs::new()`, and the real impl's own file I/O over an injected path had
**zero** coverage. The claim named a seam the code did not exercise. Fix: write the test the
doc promised — `platform_procfs_reads_and_writes_an_injected_tempdir_path` drives the real
`PlatformProcFs::with_path` over a tempdir (gated to Linux/Android, where `/proc` oom control
exists; the impl honestly refuses every op elsewhere) — so the doc became true and **R2**
(the ratchet) reported `stale-entry` until the baseline entry was removed.

### `network-guard::audit::dns`: a corrected reason, not a wired symbol (REQ-A588)

`audit::EgressEvent::dns` stays on the list (still no in-workspace caller), but its recorded
`why` was **false**: it said "no production caller constructs that event yet, so the constructor
has no host". The production wire mapping `event_from_req`
(`crates/amos-ai/src/netguard_service.rs`) **does** build `EgressKind::Dns` events. It does so as
a full struct literal because it must carry the request's own `app`/`bytes`, whereas the
convenience constructor hardcodes `app: ""`/`bytes: 0` — wiring it would *drop* those fields. So
the true state is a public convenience constructor with no caller, i.e. `library-surface`, not a
feature whose host is missing. The reclassification and the rewritten `why` are backed by a new
unit test (`event_from_req_maps_kind_and_carries_app_and_bytes`) that **establishes** the claim
instead of asserting it — the F-SH-003 discipline (a ledger must not assert a quantity the code
does not establish).

### Spaces: the window half of the feature (REQ-A389 → **closed by REQ-A446/A449/A450**)

`tauri::spaces::space_for_window` **left this list under REQ-A581** — but it did not get wired, it
was **deleted**. Its entry here was a `planned-feature` marker, and the premise of that marker had
quietly died:

- its recorded `why` said wiring it would mean "the shell hiding/showing windows on switch" — a gap
  **REQ-A446 closed without it** (`spaces_switch` applies `SpaceManager::switch_plan`, whose
  `hide`/`show` lists are built from `active_space_windows` / `is_window_in_active_space` and never
  consult the reverse accessor). So the marker named a gap that no longer existed;
- the reverse lookup it existed for (window → its Space) is served **in the panel** —
  `SpacesPanel.spaceOfWindow` reads it off the very ledger the panel already loads (`spaces`), so
  there was no host-side consumer to wire and no "UI that does not exist yet" left to build.

With the premise gone, the accessor was dead code kept alive by a false ledger line — the exact
"doc says X, code does Y" shape this baseline exists to prevent, mirrored. Removing it is *not*
hiding a gap: the Spaces window half is wired (REQ-A446 switch, REQ-A449 filing UI, REQ-A450
unfiling), and this accessor had no part in any of it.

The Spaces ledger was wired by REQ-A389: `mod spaces;` / `mod spaces_commands;` declared,
`Mutex<SpaceManager>` managed (loaded from the shared store, so a restart restores the spaces), the
`spaces_*` commands registered, and the shell's `SpacesPanel` — already mounted and calling them —
working.

`active_space_windows` and `is_window_in_active_space` **left this baseline** under REQ-A446 (R2,
26 → 24) because `switch_plan` is built from them, and the plan's own semantics (unfiled windows are
in every Space; the Launcher is neither hidden nor focused; a window filed twice is never in both
lists) are pinned by unit tests in `spaces.rs`.

Boundary, stated because a switch is device-visible behaviour: the plan and the applier's failure
contract are unit-tested, and the command path is type-checked and arg-scanned, but **no real
window was moved on a real desktop** — that needs a launch (`make app-open`).


### Inspection / maintenance API on public services

`android::manager::clear_cache`, `appstore::client::android_bridge`,
`monitor::monitor::sampler_name`, `power::freq::applied_plan`,
`sms::trash::trashed_in`, `tauri::android_glue::is_armed`,
`tauri::appstore::installed_name`.

(`tauri::incall::is_default_dialer_bound` left this list under REQ-A550: the
default-dialer binding became a real gate when the InCallService recording path
(REQ-A544) started calling it from `telephony.rs`, so the ledger's "nothing calls it yet"
was no longer true.)

Read-only accessors (plus one cache flush) exposed by a service so a host can
inspect or maintain it. The daemon surfaces the underlying state through its own
RPC/status path, so no in-workspace caller needs these yet.

### Helpers whose host does not exist yet

`crates/amos-tauri/src/recording.rs::*` (**REQ-A480, the first module-level entry**) — the
call-recording storage ledger. The **whole module** is unreferenced, which is the shape the
per-function pass cannot see: its helpers call each other (`add_recording` →
`load_index`/`save_index`) and its 8 tests call everything, so every per-function reference count
was > 0 while no other file in the workspace mentioned it. Its capture half does not exist (the
Android provider refuses `start_recording` — "requires a call-audio tap (audio pipeline, not yet
wired)"; `docs/telephony.md` scopes real capture to the audio pipeline), so there is no writer to
wire and no reader to write. Kept, with the reason, because the storage contract is a decision the
future audio tap must not re-invent. `crates/amos-tauri/src/lib.rs` used to describe it as "used
by telephony" — a false claim, now replaced by the measurement.

`audio::android::tinyalsa::header_layout_notes` — **left this list under REQ-A642 (removed from the
baseline under REQ-A647).** The `pcm.h` facts the Android audio bring-up depends on, "surfaced so
bring-up tests can assert the header has not drifted". REQ-A642 moved the facts to the
host-compilable `amos-audio/src/tinyalsa_layout.rs`, where a host test now calls them — so the
"test needs the android feature + NDK" excuse was no longer true. The entry was left behind and the
gate was red until REQ-A647 removed it.

`network_guard::audit::dns` — a constructor for a DNS `EgressEvent`; the tests
build the struct literal instead.

`pdf_parser::model::refresh_metrics` — "recompute after a caller mutates `text`";
**no caller in the workspace mutates `text`**, so there is nothing to refresh.

`web3::secp::to_uncompressed_bytes` — SEC1 compression conversion; needs a caller
that consumes uncompressed keys.

### Two exemptions named a daemon path the crate does not have (REQ-A647)

REQ-A588 rewrote the `why` for `network_guard::audit::dns` because it described a production host
that did not exist. R4 exists because that was not the only one. Two entries justified having no
in-workspace caller by pointing at **the daemon** reporting the same fact, and both crates are ones
`crates/amos-ai/Cargo.toml` does not link at all:

* `amos-appstore::client::android_bridge` — "the daemon reports the same state through its own RPC
  path". The installed-app registry is **System-UI-owned** (`crates/amos-tauri/src/appstore.rs`);
  the daemon has no appstore dependency (`grep -c appstore crates/amos-ai/Cargo.toml` → 0), so there
  is no such path.
* `amos-sms::trash::trashed_in` — "the daemon answers the same question over its own RPC path". The
  daemon has **no SMS surface whatsoever**; the trash lives in `crates/amos-tauri/src/sms.rs`
  (`SmsTrashState` + the `sms_trash_list/restore/purge` commands), and the UI reads the whole
  `entries()` list rather than a per-thread count.

Both reasons are now the verified truth (the registry/trash is UI-owned; the caller would be in
`amos-tauri`, which reads the full list), and R4 would have failed them had it existed. The rule
deliberately does **not** fire on the entries whose daemon claim is real —
`amos-android::manager::clear_cache` (the daemon serves `AndroidManager` over gRPC),
`amos-monitor::monitor::sampler_name` (`server.rs` puts the sampler name in its status), and
`amos-power::freq::applied_plan` — which is the discrimination the negative control pins.

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

`mdm::db::fail_command` — **wired in REQ-A410**, so it is no longer in
`scripts/rust-unwired-baseline.json`; the paragraph stays as the record of what changed and why.

The MDM command lifecycle was `create_command` → `get_pending_commands` → `ack_command`, and
`fail_command` (the only writer of `status = 'failed'`) had no caller because the ack request
carried `result: Option<String>` and **no failure signal** (`models::AckCommandRequest`) — so a
device reporting a failed lock/wipe was recorded as `acknowledged`, and the operator's console
showed a completed lock for a device that was still unlocked. REQ-A410 added that signal
**additively** (`AckCommandRequest.ok: Option<bool>`; absent = the old meaning, because the device
agents live outside this repository) and wired the call.

Wiring it also surfaced a defect the baseline entry had been hiding: `fail_command` was scoped by
command id **only**, so it could mark *any* device's command failed. It now takes `device_id` — the
same per-device scoping `ack_command` has had since REQ-A411 — and the ack endpoint echoes the
status it actually recorded (`{"success":true,"status":"failed"|"acknowledged"}`).

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

### REQ-A832 — the criterion half of F-DEV-066, and the stripper that had to be fixed first

F-DEV-066 was filed with the fix **deliberately not made**, and the reason is recorded in its own
row: telling references from prose needs "a decision about what is a comment", regex cannot do it,
and a half-baked matcher would introduce **false greens**, which are worse. This round answers that
reason instead of ignoring it, and the answer has two halves.

**1. The criterion.** `countName` counted `\b<name>\b` in the **raw** source. It now counts in
`stripRustComments(src)`, memoised on the source string (`strippedOf`) because the counts are asked
per candidate name (~2.3 M strips without the memo made the run time out at 120 s; ~28 s with it).
Declarations are still discovered from the **raw** text — that asymmetry is what keeps the gate's
error direction safe (see the direction note below).

**2. The direction argument — this is the acceptance test, not a slogan.** Stripping can only
**remove** occurrences. Every remaining count is therefore a subset of what the old criterion saw
⇒ the criterion can only ever report *more* unwired functions, never fewer. The residual error is a
**false RED**; it cannot be a false green. That is exactly the argument F-DEV-066's recorded reason
said was missing, so the deferral is closed by it rather than overridden: the safe direction is
established by construction, and the two-way synthetic control pins it (below).

**The eleven that were hidden.** All eleven had zero real references; each one had prose (a doc
comment, an audit document, or a baseline `why`) that mentioned its name. Registered by kind, with
the "how do you know" that R1 requires:

| symbol | kind | how it was known |
| --- | --- | --- |
| `amos-ai::server::serve_with_sinks` | `library-surface` | `main.rs:117` calls `serve_with_sinks_full` directly; this is the two-sink convenience wrapper |
| `amos-config::layer::standard` | `library-surface` | the layer stack is built explicitly; no caller composes the standard set |
| `amos-monitor::spec::from_sample` | `inspection-api` | monitor tests build `Sample` literals instead |
| `amos-power::android::snapshot_with_power` | `inspection-api` | the value-taking sibling `snapshot_with_power_from` is exercised (`tests/closed_loop_linux.rs:112`, `examples/live_governor.rs:100`, `types.rs:134/138/141`); the no-arg form is not |
| `amos-tauri::ble::install_glue` | `library-surface` | its doc claimed "called from MainActivity.onStart via JNI"; the live path is `jni_glue.rs::Java_com_amos_ai_glue_BluetoothGattGlue_nativeInstall` → `jni_glue::init()`, plus `lib.rs`'s setup — **the doc was corrected** |
| `amos-tauri::clipboard::bus_stats` | `inspection-api` | diagnostics accessor; tests read the counters through the public map |
| `amos-tauri::flashlight::from_android` | `host-missing` | the trampoline is at `flashlight.rs:274`; the constructor it would use has no in-workspace caller |
| `amos-tauri::sensor_host::bind_android` | `host-missing` | trampoline at `sensor_host.rs:312` |
| `amos-tauri::window_state::with_position` | `library-surface` | **`with_size` was NOT reported** — it is masked by `devocare::AppPackage::with_size` (`devcare.rs:1071`); both are genuinely uncalled |
| `amos-telephony::provider::simulate_remote_ended` | `inspection-api` | test helper driven through the service trait |
| `amos-telephony::service::demo_server` | `library-surface` | the daemon mounts `demo_server_limited(30)` (`amos-ai/src/server.rs:2360`) |

**The control (two-sided, synthetic tree, no perturbation of this repo).** `/tmp/negctl10` holds one
`crates/zzprobe/src/lib.rs` whose names are chosen so each direction is witnessed exactly once:
`zz_prose_only` is mentioned **only** in prose, `zz_code_only` has a real call, `zz_caller` is a real
uncalled declaration, and `between_two_literals` sits between two string literals.

* old gate (original `countName`): reports 2 — `zz_prose_only` is **missed** because its two prose
  mentions witnessed it (the declaration between the two literals *is* reported here: the old count
  path never strips at all, so nothing is hidden from it);
* new gate: reports 3, including `zz_prose_only` and the genuinely uncalled `zz_caller`, while
  `zz_code_only` is reported by **neither** direction;
* the mixed variant (new `countName` + the **old** stripper) is what makes the stripper fix a
  prerequisite rather than a bonus: its strip deletes the region between the two literals, and when
  that region holds the only caller of a live function, the function is reported as unwired. Measured
  on a second probe (`PATTERN` / `caller_inside_region` / `CLOSE`): the mixed gate reports
  `only_called_here` — a **false RED**, the safe direction, but proof that a count taken over a strip
  whose stripper is broken is not the count the criterion claims to be;

**3. The stripper (F-DEV-104).** `stripRustComments` was
`src.replace(/\/\*[\s\S]*?\*\//g, "")`. It does not know string literals, so the `/*` inside
`"amos/dog1/**"` (`crates/amos-link/src/node.rs`) opened a block comment that ran to the next `*/`:
that file went **669 lines → 283** with `pub fn spawn_federation` (`:345`) and both `#[cfg(test)]`
assertions (`:460`, `:565`) **gone**; `robot_hal.rs` went **3488 → 963**. A `/*` inside a `//`
comment did the same. 145 lines of tracked `.rs` contain a `/*` inside a literal. The replacement,
`dropBlockComments(src)`, walks the source character by character, tracking ordinary strings,
`\` escapes, raw strings (`r#"…"#`) and char literals, and opens a block comment only on a `/*` in
**code** — pairing to the next `*/` with exactly the old regex's rules (non-greedy, no nesting, an
unterminated `/*` left alone). So the only thing that changed is *which* `/*` starts a comment.
Measured byte-for-byte: `node.rs` 669 → **511** (only whole-line `//` comments still dropped, as
before), `robot_hal.rs` **3562 → 2308**, and the deleted declarations are back. Residual limit, kept
honest in the comment: a single-quoted string in the `.svelte`/`.ts` corpus is understood only in its
char-literal form, so there the stripper **over**-strips — still the false-red side.

**4. Two consequences worth recording.**
*The exhaustive check found a false positive of its own making.* With the counts fixed,
`crates/amos-clipboard/src/android.rs` was immediately reported as an orphan module — its only public
item is built and installed by `Java_com_amos_ai_glue_AndroidClipboardGlue_attach` **in the same
file**, called from Kotlin. The module-level pass now applies the exemption `DECL_RE` already
documented (an FFI entry point has no in-workspace caller *by design*): a file containing
`#[no_mangle]` or a `Java_*` function **in code** is not an orphan — and **prose does not count**,
with a self-test pinning that a trampoline inside a comment does not exempt.
*Two documents were lying and the old criterion was hiding it.* `ble::install_glue` claimed a Kotlin
`onStart` caller that does not exist, and the clipboard module's header linked to an `attach` symbol
that never existed; both are corrected in place.

**Honest boundary.** ① The `.svelte`/`.ts` over-stripping above is **not** fixed. ② Only the shared
Rust stripper was changed; `stripKtComments` (the Kotlin side) has no equivalent character-wise
walk and was not re-checked for the same family of hole. ③ The other half of F-DEV-066 — a bare name
resolved across the whole tree, so two same-named functions witness each other — is **still
unfixed** (it needs a real parser); this round measured a live instance (`window_state::with_size`
masked by `devocare::AppPackage::with_size` while its twin `with_position` is reported). ④ The
eleven new entries are **bookkeeping**: each records how it was known, but none of them was wired.
⑤ No device/host run was made; every claim above is a static measurement plus the self-tests.

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
