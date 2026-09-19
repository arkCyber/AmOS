.PHONY: all build test check lint fmt cov verify smoke sup-smoke timesync-smoke e2e-local gated-check run-ai run-ui run-ui-dev dev run-ui-release run-backends health supervise gui-smoke gui-smoke-check mobile-init mobile-check android-app android-app-strip android-app-check android-glue-check android-audio-check android-ai-sherpa-check android-usb android-voice-bringup android-rag-bringup pdf-android-check vector-db-check ci-local clean honesty-smoke deploy doctor hot-loop examples-smoke isolation-check release-artifacts api-docs device-eval device-media-probe frontend-dist frontend-fresh app-open

all: build

build:
	cargo build --workspace

# Comprehensive tests: Rust (unit + end-to-end RPC over UDS) + TS System-UI
# shell (bun). `cargo test --workspace` picks up every
# crate's tests/ dir automatically (incl. crates/amos-tauri/tests/ai_daemon_e2e.rs).
test:
	cargo test --workspace
	# Feature-gated seams whose tests the line above cannot even compile (REQ-A188).
	# `cargo test --workspace` builds the *default* configuration, so a module behind
	# `#[cfg(feature = "…")]` is absent — 12 unit tests lived in that blind spot and had
	# never executed: 9 Android-seam ones (the glue bus's IMU/frame stores, the
	# device-care reply parser, the media JNI payload caps — measured: 2 + 2 + 5) and 3
	# NTP-resolver ones. Both steps are host-runnable and offline: no device, no JVM, no
	# NDK, no native download. scripts/feature-test-scan.mjs (in `make lint`) fails if a
	# feature-gated test module is not covered by a `cargo test` step here (or in
	# gated-check for the `audit` features, whose pnet/libpcap is provisioned there).
	cargo test -p amos-tauri -p amos-media --features amos-tauri/android,amos-media/android --lib
	# amos-radio's Android-module **host** tests: the Bluetooth glue's JSON contract and
	# the name/address policy live behind `#[cfg(feature = "android")]`, so the
	# `--workspace` run above compiles neither (REQ-A200, same blind spot as REQ-A188).
	cargo test -p amos-radio --features amos-radio/android --lib
	cargo test -p amos-timesync --features amos-timesync/ntp --lib
	# amos-link's feature-gated channels (REQ-A188 shape): the UDP-beacon discovery
	# (`lan`, real sockets on loopback — offline) and the Zenoh transport (`zenoh`,
	# whose offline cases are the config/env mapping; a **deterministic** session round
	# trip over TCP loopback, and the scouting case that stays `#[ignore]`d on purpose).
	# Both are compiled by `make lint`; this is where they run. **No `--lib` here**: the
	# `lan` feature also gates an integration target (`tests/lan_multicast.rs`, the real
	# multicast tests), and `--lib` would have left that target running nowhere —
	# the very "test the gate makes invisible" shape this step exists for (REQ-A243).
	cargo test -p amos-link --features amos-link/lan
	cargo test -p amos-link --features amos-link/zenoh
	# …and the tests that hide behind two more features no step used to enable (REQ-A191):
	# the mail CLI's live SMTP/IMAP paths answer against a local loopback relay (offline),
	# and the PTY terminal's round trip spawns a real shell (`portable-pty`). Both are
	# compiled by `make lint`; this is where they *run*.
	cargo test -p amos-mail-cli --features amos-mail-cli/live --lib
	cargo test -p amos-tauri --features terminal-pty --lib
	# amos-mdm's end-to-end HTTP integration tests live in `tests/end_to_end.rs`
	# and need the in-memory DB + seed-token helpers exposed via the
	# `test-helpers` feature. Without it, that target compiles to a no-op
	# (`#![cfg(feature = "test-helpers")]` at the top) and the 5 end-to-end
	# scenarios never run — same REQ-A188 / REQ-A191 blind spot as the entries
	# above. The feature has zero effect on production builds.
	cargo test -p amos-mdm --features test-helpers
	# The alerting seam's feature-gated tests (REQ-A460). `amos-ai/notifier` and
	# `amos-supervisor/notifier` are both **off by default** (they pull
	# `amos-notifier` into the build that ships to devices), so the workspace run
	# above neither compiles the bridge modules nor builds their test targets:
	#   * `crates/amos-ai/src/notifier_sink.rs`              (module)
	#   * `crates/amos-ai/tests/notifier_alerts_e2e_v2.rs`   (target, `#![cfg(feature = "notifier")]`)
	#   * `crates/amos-supervisor/src/alert_sink.rs`         (module)
	#   * `crates/amos-supervisor/tests/alert_wiring.rs`     (target, `#![cfg(feature = "notifier")]`)
	# `scripts/feature-test-scan.mjs` reported all four as "run by no `cargo test`
	# step" — the paging path had unit tests *and* an end-to-end test that
	# **nothing executed**, which is the REQ-A188/A191 blind spot again. `make
	# lint` only *compiles* them (`cargo clippy -p amos-ai --features notifier`);
	# this is where they run. No `--lib`: the e2e targets are the point.
	cargo test -p amos-ai --features amos-ai/notifier
	cargo test -p amos-supervisor --features amos-supervisor/notifier
	# TS System-UI: bun-iso-test.mjs runs pure files in one process and each DOM
	# test file in its OWN process (happy-dom global windows are per-process).
	cd crates/amos-tauri/frontend-ts && bun run test

# Fast check of the React/TS System-UI (tests + typecheck).
check:
	cd crates/amos-tauri/frontend-ts && bun run check

# TS core-lib coverage gate (P2-1): line coverage over src/lib/** must stay >= the
# threshold enforced by scripts/lib-coverage-gate.mjs (default 90%; it was documented as
# 80% here while the script's default had already been raised — the comment was the thing
# that was wrong). Every src/lib module must also be *measurable* (see REQ-A405): a module
# no test imports has no lcov record at all and would otherwise be invisible to this gate.
# Runs over the pure (non-DOM) files so no shared happy-dom process is involved (DOM files
# are already covered by correctness in `make test`).
cov:
	cd crates/amos-tauri/frontend-ts && bun run coverage:gate

# Build the frontend bundle the *embedded* (release) desktop binary loads.
# `tauri.conf.json`'s `beforeBuildCommand` is EMPTY, so the release binary embeds
# whatever `frontend-ts/dist` contains at build time — it must be rebuilt by hand.
frontend-dist:
	cd crates/amos-tauri/frontend-ts && bun run build

# Is that bundle newer than its sources? (see scripts/dist-freshness.mjs, REQ-A228)
# `scripts/run-ui-release.sh` runs this before building, so the release UI can never
# silently be an older tree than the one you are looking at. Not part of `lint`: a
# fresh checkout legitimately has no `dist/`.
frontend-fresh:
	node scripts/dist-freshness.mjs

# Headless end-to-end smokes: start a mock daemon and drive the real chain.
smoke:
	bash scripts/int-cli-smoke.sh
	cargo test -p amos-translate --test full_chain

# Supervisor headless smoke: launch real amos-ai + amos-translate (mock) under the
# supervisor with no GUI, SIGUSR1 hot-restart, and a graceful SIGINT stop that must
# not orphan the child daemons (regression guard).
sup-smoke:
	bash scripts/supervisor-smoke.sh

# Time-sync headless smoke: supervisor (timesync) calibrates + persists state,
# propagates AMOS_TIMESYNC_STATE to a child, and the amos-timesync-cli reads the
# calibrated clock; graceful SIGINT stop with no orphans.
timesync-smoke:
	bash scripts/timesync-smoke.sh

# Local-model end-to-end: Piper TTS -> sherpa streaming ASR -> daemon translate.
# (Piper + sherpa are real; translation uses a deterministic mock daemon unless
# AMOS_TRANSLATE_SOCKET points at a live daemon.)
e2e-local:
	bash scripts/e2e-local-models.sh

# Compile the gated native backends (sherpa ASR / Piper TTS / SNTP time sync) +
# the sherpa examples + the amos-tauri native bridge (sherpa-asr + piper-tts
# together). Requires network to download prebuilt native libs — run on a
# networked machine.
gated-check:
	cargo build -p amos-asr --features sherpa
	cargo build -p amos-asr --features sherpa --example sherpa_asr
	cargo build -p amos-asr --features sherpa --example sherpa_session
	# The whole-buffer ASR target (REQ-A243): a crate-root `#![cfg(feature = "sherpa")]`
	# meant it was *built* above and run by nothing. It self-skips when the model files are
	# absent, so the honest place for it is here, where the native libs are provisioned.
	cargo test -p amos-asr --features sherpa --test sherpa_buffer
	# Real local ASR inside the AI daemon (bidi Payload::Audio → sherpa).
	cargo build -p amos-ai --features asr-sherpa
	cargo test -p amos-ai --features asr-sherpa --test bidi_sherpa_audio
	# System-UI resident voice capture thread (feeds amos-audio captures to the
	# daemon; single- and multi-utterance e2e).
	cargo test -p amos-tauri --test assistant_voice_e2e
	cargo build -p amos-tts --features piper
	cargo build -p amos-tts --features piper --example piper_tts
	cargo build -p amos-timesync --features ntp --example ntp_probe
	cargo build -p amos-timesync-cli --features ntp
	cargo build -p amos-supervisor --features timesync
	cargo build -p amos-tauri --features sherpa-asr,piper-tts
	# …and *run* the native-feature tests the line above only compiles (REQ-A192): the
	# `sherpa-asr` / `piper-tts` fallback tests (`interpret.rs`, `tts.rs`) sat behind
	# `#[cfg(feature = …)]` inside a non-gated module, so the REQ-A188 gate (feature-gated
	# *modules*) could not see them and no step ever executed them.
	cargo test -p amos-tauri --features sherpa-asr,piper-tts --lib
	# QCOM/MTK accelerator seams (amos_ai::accelerator): `qnn`/`neuropilot` feature
	# flags gate vendor-NPU claims — compile + unit-test both branches (no network).
	cargo check -p amos-ai --features qnn,neuropilot
	cargo test -p amos-ai --features qnn,neuropilot --lib accelerator::
	# Host compile-checks of the feature-gated Android HAL/power seams (no device /
	# no NDK needed; runtime requires a real Android VM + Context at device bring-up).
	cargo check -p amos-radio --features android
	cargo check -p amos-telephony --features android
	cargo check -p amos-sensor --features android
	cargo check -p amos-media --features android
	cargo check -p amos-profiling --features android
	# Battery/thermal telemetry seam feeding the energy governor (amos-power).
	cargo check -p amos-power --features android
	# CPU/NPU frequency-governor sysfs applier (amos-power, `linux` feature):
	# real scaling_max_freq writes + tempdir tests; host-compiles without a device.
	# **No `--lib`** (REQ-A243): `tests/closed_loop_linux.rs` is a feature-gated *target*
	# (its own header documents `cargo test -p amos-power --features linux --test
	# closed_loop_linux`), and `--lib` compiled the feature while running none of it —
	# scripts/feature-test-scan.mjs rule 3 now fails on exactly that shape.
	cargo check -p amos-power --features linux
	cargo test -p amos-power --features linux
	# System working-status sampler (amos-monitor): real /proc reads over an
	# injected root (`linux`) + on-device Android skeleton (`android`). The linux
	# tests run entirely over a tempdir fixture — no root/device needed.
	cargo check -p amos-monitor --features linux
	cargo test -p amos-monitor --features linux --lib
	cargo check -p amos-monitor --features android
	# Store `live` seams (`amos-appstore::http` — capped/streaming downloads, the
	# proxy policy — plus the CLI's `--repo`/`--catalog`/`--pin` path). They are
	# `#[cfg(feature = "live")]`, so **no other target compiles them**: deliberately
	# placing a `compile_error!` in `http.rs` leaves `make lint` and `make test`
	# green. Compile them with `-D warnings` and run their tests here instead of
	# folding `live` into the default build (which is kept offline-green on
	# purpose). Both steps are loopback-only — the single real-network test is
	# `#[ignore]`-gated.
	cargo clippy -p amos-appstore -p amos-appstore-cli --all-targets --features live -- -D warnings
	cargo test -p amos-appstore -p amos-appstore-cli --features live
	# The `audit` features have the same shape as `live` above (REQ-A188): only
	# `--features audit` compiles `amos-telemetry-spy/src/capture.rs` and
	# `amos-ai/src/telemetry_spy_capture.rs`, so their 6 tests would never run anywhere.
	# They are pure env-plan/error-path logic (no raw-socket privilege needed), but the
	# build pulls `pnet`, which needs libpcap headers — hence this job, not `make test`:
	# the host path below installs `libpcap-dev`, and the pinned container image carries
	# it too (rebuild/dispatch the image after a Dockerfile change, see
	# .github/workflows/container-image.yml — an older pinned tag would fail here).
	cargo test -p amos-telemetry-spy -p amos-ai \
		--features amos-telemetry-spy/audit,amos-ai/telemetry-spy-audit --lib
	# …and the crate's *example*, which no `--all-targets` run in this file compiles: cargo
	# skips a target whose `required-features` are unmet, silently (REQ-A191 — this was the
	# one such target with no step). `docs/telemetry-spy.md` documents running it.
	cargo build -p amos-telemetry-spy --all-targets --features audit

# Format the workspace (Rust): the writing counterpart of `make lint`'s
# `cargo fmt --all --check`. `GETTING_STARTED.md` hands a newcomer `make fmt`; until
# this rule existed the command died with `No rule to make target 'fmt'` — a first-run
# instruction that could not run (caught now by scripts/make-target-doc-scan.mjs).
fmt:
	cargo fmt --all

# Production gate: formatting + clippy must be clean; TS shells must typecheck and
# no `src/lib` export may lose its production call site (dead-export regression).
lint:
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
	# A `required-features` example is *skipped* by every `--all-targets` run, so it needs a
	# step of its own or nothing compiles it (REQ-A463; scripts/feature-surface-scan.mjs
	# reported `amos-monitor [[example]] sample_health (requires linux)` as "never built" the
	# moment the requirement was declared). It is below the clippy line on purpose: the
	# requirement is what makes the workspace run skip it. Offline and pure std — the `linux`
	# feature only swaps the /proc-backed sampler in, so this belongs in `lint`, not in
	# `gated-check` (which is where the examples that need downloaded native libs live).
	cargo build -p amos-monitor --features linux --example sample_health
	# The lock must still match the manifests (see the `--locked` note below): a CI
	# that silently re-resolves is not reproducing the committed dependency set, and
	# the local `cargo build` that assumed the committed one is then the odd one out.
	cargo metadata --locked --format-version 1 > /dev/null
	# Per-package build check + workspace-unique target names (see
	# scripts/isolation-check.mjs, REQ-A464/A465): cargo **unifies features across the
	# workspace**, so a `--workspace` build turns on features a single member never
	# declared; it also merges the members' *output paths*, so two packages can claim
	# one `bin`/`example` name. `cargo check -p <m>` per member catches the first and
	# `cargo metadata` the second. Neither is visible to a workspace-wide run — `make
	# test` sees the first not at all, and cargo's collision is only a *warning* that
	# `cargo build -q` (examples-smoke) hides. Measured 2026-09-19 (warm target dir):
	# 48 members, ~68 s. This line is the **CI-visible** one (CI runs `make lint`);
	# `verify` deliberately does not list the dedicated target below as well, or the
	# 48 checks would run twice.
	node scripts/isolation-check.mjs --timeout 600000
	# CI-config drift (see scripts/ci-drift-scan.mjs): the toolchain the two lines
	# above run on must come from ONE pin (`rust-toolchain.toml`), and every job must
	# pin its runner. `dtolnay/rust-toolchain@stable` overrides that file and
	# `ubuntu-latest` moves underneath us — the two recorded causes of this repo's
	# recurring CI red (docs/ci-engineering.md §6). The device-free half of the check
	# runs here, in the job that would be affected first.
	node scripts/ci-drift-scan.mjs --selftest
	node scripts/ci-drift-scan.mjs
	# Feature surfaces that no other step compiles (REQ-A191). The line above builds the
	# *default* features, and cargo **silently skips** a target whose `required-features`
	# are unmet — so code behind a feature nobody enables is invisible to every gate in
	# this list (the third form of the A187 blind spot). Measured: 7 of the workspace's 35
	# non-default features were enabled by no step anywhere; the three steps below compile
	# (-D warnings) and lint them. The tests hiding behind two of them
	# (`amos-mail-cli/live`, `amos-tauri/terminal-pty`) run in `make test`, and the one
	# feature-gated example (`amos-telemetry-spy`'s `live_spy`, needs pnet) is built in
	# `gated-check`. scripts/feature-surface-scan.mjs fails if a feature loses its step.
	cargo clippy -p amos-network-guard --all-targets --features nftables,vpn -- -D warnings
	cargo clippy -p amos-mail-cli --all-targets --features amos-mail-cli/live -- -D warnings
	cargo clippy -p amos-tauri --all-targets --features appstore-live,tcp,terminal-pty -- -D warnings
	# amos-link's two network channels: the `lan` UDP-beacon discovery and the `zenoh`
	# inter-board transport (docs/amos-link.md). Neither is in the default build, so
	# without these steps `src/lan.rs` and `src/zenoh.rs` would be compiled by nothing
	# (scripts/feature-surface-scan.mjs fails if that happens).
	cargo clippy -p amos-link --all-targets --features lan -- -D warnings
	cargo clippy -p amos-link --all-targets --features zenoh -- -D warnings
	cargo clippy -p amos-link-cli --all-targets --features lan,zenoh -- -D warnings
	# amos-ime's `predict` (the 联想 FSTs) is on by default, but it is named here
	# explicitly so the feature keeps a step of its own: flipping the default later
	# must not silently drop the data *and* the code that consumes it
	# (scripts/feature-surface-scan.mjs reports a feature no step enables).
	cargo clippy -p amos-ime --all-targets --features predict -- -D warnings
	# amos-ai's `notifier` is what makes the daemon *page* on state transitions
	# (`src/notifier_bridge/`, the seam HEAD's alert wiring added). It is off by default
	# so the build that ships to devices keeps its transitive deps minimal — and that is
	# exactly why it needs a step of its own: with no step, **nothing** compiled that
	# bridge (scripts/feature-surface-scan.mjs reported `never enabled: amos-ai/notifier`),
	# so the alert path could rot with every gate in this file green (REQ-A454).
	# Verified clean before it was added: `cargo clippy -p amos-ai --features notifier -- -D warnings` EXIT=0.
	cargo clippy -p amos-ai --features notifier -- -D warnings
	cd crates/amos-tauri/frontend-ts && bun run typecheck
	# Lint-input integrity (see scripts/lint-inputs-scan.mjs): every file the steps
	# below invoke (`node scripts/*.mjs` plus the allow-lists/baselines they read) must
	# exist **and be tracked by git** — a gate that lives only in one working tree makes
	# `make lint` pass locally while a clean checkout runs nothing. Runs first because
	# it guards the gates that follow. `--selftest` pins the parser/resolver first.
	node scripts/lint-inputs-scan.mjs --selftest
	node scripts/lint-inputs-scan.mjs
	# The device tool's *device-free* half (see scripts/device-ui-eval.mjs --selftest): the stall
	# diagnosis — "a page that never answers names the window that is in front of it" — is the one
	# part of that tool that can be pinned without hardware, and its **must-not-blame** cases are
	# exactly what a later edit would break, sending the next device session after a window that is
	# not there (REQ-A367 / F-DEV-004). The rest of the tool needs a phone and stays a manual target
	# (`make device-eval`).
	node scripts/device-ui-eval.mjs --selftest
	# The reverse direction (see scripts/unwired-script-scan.mjs): a script that ships but
	# that the Makefile, the CI workflows and every reachable script never name is dead
	# weight — and the *executable* layer is the one every gate above depends on. Wired by
	# a Makefile target normally (`make dev` / `make supervise` / `make gui-smoke-check`
	# exist because of this scan); an exception needs a reason in
	# scripts/script-allowlist.json and is reported stale once it stops being unwired.
	node scripts/unwired-script-scan.mjs --selftest
	node scripts/unwired-script-scan.mjs
	# Deliverable integrity (see scripts/untracked-source-scan.mjs): no untracked,
	# non-ignored file may sit in the working tree, and no deletion may be left unstaged —
	# the deliverable is the index, and this repository's recurring defect is exactly a
	# mismatch with it (untracked gate layer R74, 34 untracked sources R75, an untracked
	# new e2e test R81 — all three found by hand; plus `config.rs`, deleted on disk while
	# the index still shipped it, found by this gate the moment it existed). An excuse
	# needs a reason in scripts/untracked-allowlist.json and is reported stale once the
	# file it excused stops being untracked.
	node scripts/untracked-source-scan.mjs --selftest
	node scripts/untracked-source-scan.mjs
	# Dangling-source integrity (see scripts/dangling-source-scan.mjs): no tracked file
	# may `mod`/import a source that is not tracked — otherwise a clean clone cannot
	# build it. Catches "committed the importer, forgot the module" (e.g. `git commit -a`
	# after adding a module). `--selftest` pins the parsers first.
	node scripts/dangling-source-scan.mjs --selftest
	node scripts/dangling-source-scan.mjs
	# The reverse direction (see scripts/unreached-source-scan.mjs): a file that **is**
	# in a crate's `src/` but that the compiler never reads. Found by this gate's
	# absence: `crates/amos-mdm/src/error.rs.tmp_tests` held a byte-identical copy of
	# `error.rs`'s test module with a non-`.rs` extension, so `cargo test` reported 14
	# green tests while a second, unreviewed copy rotted beside them — and every other
	# gate was green, because they all walk *from* a reference and this file has none.
	# `--selftest` pins the classifier (including the Rust 2018 module-dir rule, whose
	# first version's misreading produced 5 phantom findings on the real tree; REQ-A460).
	node scripts/unreached-source-scan.mjs --selftest
	node scripts/unreached-source-scan.mjs
	# Unsafe surface (see scripts/unsafe-scan.mjs): every production `unsafe` site must
	# carry a `// SAFETY:` note or a `# Safety` doc section (the invariant, written at the
	# site — this is where the compiler stopped checking), and the per-file count is
	# ratcheted by scripts/unsafe-baseline.json so the surface only grows deliberately.
	node scripts/unsafe-scan.mjs --selftest
	node scripts/unsafe-scan.mjs
	# Async-runtime hygiene (see scripts/blocking-in-async-scan.mjs): no blocking call
	# (std::fs / std::process / std::thread::sleep / std::net) may sit directly in an
	# `async fn` — it would occupy a tokio worker. Work goes to `spawn_blocking`; the
	# accepted startup/shutdown sites carry a reason in scripts/blocking-async-allowlist.json.
	node scripts/blocking-in-async-scan.mjs --selftest
	node scripts/blocking-in-async-scan.mjs
	# Lock-guard hygiene (see scripts/lock-across-await-scan.mjs): a `std` lock guard must
	# not be used after an `.await` inside its own scope — holding a synchronous lock across
	# a suspension point serializes unrelated tasks and risks deadlock. Scope-tracked, so a
	# guard dropped before the await (the shape used in the governor loop) is not a finding.
	node scripts/lock-across-await-scan.mjs --selftest
	node scripts/lock-across-await-scan.mjs
	# Discarded results, type-checked (see scripts/rust-discard-scan.mjs): reads `cargo
	# clippy` diagnostics for `clippy::let_underscore_must_use` (a `let _ =` on a
	# `#[must_use]` value — the explicit way to throw away a `Result`/`JoinHandle`) plus
	# the type-aware `await_holding_lock`/`await_holding_refcell_ref`, which R80's
	# syntactic scan could not decide. Per-file counts are ratcheted by
	# scripts/rust-discard-baseline.json (165 sites across 35 files, recorded as debt —
	# the ratchet stops growth, it does not certify what is already there); a file above
	# its count, or a new file with a discard, fails.
	node scripts/rust-discard-scan.mjs --selftest
	node scripts/rust-discard-scan.mjs
	# Feature-gated test modules (see scripts/feature-test-scan.mjs): a module behind
	# `#[cfg(feature = "…")]` is not compiled by `cargo test --workspace`, so a test inside
	# it is dead weight no gate reports — the same blind spot R187 found for clippy, one
	# step further on (the featured pass *compiled* them, nothing *ran* them). The gate
	# reads the `cargo test` steps the Makefile actually contains and fails on any
	# feature-gated module with a runnable test that no step runs.
	node scripts/feature-test-scan.mjs --selftest
	node scripts/feature-test-scan.mjs
	# Feature-gated *surfaces* no gate compiles (see scripts/feature-surface-scan.mjs): the
	# clippy step above builds default features only, and cargo silently skips a target
	# whose `required-features` are unmet — so code behind an un-enabled feature is
	# invisible here (third form of the A187 blind spot). The gate reads the cargo
	# invocations this Makefile/CI/scripts actually contain and fails on any feature or
	# feature-gated target they never compile.
	node scripts/feature-surface-scan.mjs --selftest
	node scripts/feature-surface-scan.mjs
	# Release-UI build mode (see scripts/release-ui-mode-scan.mjs, REQ-A421): `tauri`
	# picks the embedded `frontendDist` vs `build.devUrl` **at compile time** from its
	# `custom-protocol` feature, so a release `cargo build -p amos-tauri` without it is a
	# binary whose WebView fetches localhost:1420 — a blank window with every gate green
	# (measured: `scripts/run-ui-release.sh` did exactly that). The gate requires the
	# feature to be declared and every release amos-tauri build on the shipped surface to
	# ask for it. It reads the *make/script/CI* surface only, so it needs no built bundle.
	node scripts/release-ui-mode-scan.mjs --selftest
	node scripts/release-ui-mode-scan.mjs
	# Embedded-bundle freshness (see scripts/dist-freshness.mjs, REQ-A228): the release
	# desktop binary embeds `frontend-ts/dist` and `tauri.conf.json`'s
	# `beforeBuildCommand` is empty, so a stale bundle ships a UI that silently does not
	# match the tree. Only the **selftest** runs here (temp tree): a clean checkout has
	# no `dist/` and must not fail lint. `make frontend-fresh` checks the real tree, and
	# `scripts/run-ui-release.sh` runs it before it builds.
	node scripts/dist-freshness.mjs --selftest
	# Static "defined + tested but never wired" scan (see scripts/unwired-scan.mjs):
	# fails when a src/lib module becomes unreachable from production, when a new
	# value export appears with no production call site, or when a .svelte component
	# is never mounted. Baseline-ratcheted. `--selftest` first proves the import-edge
	# extractor still recognises every edge form (a missed one = false failure).
	cd crates/amos-tauri/frontend-ts && node scripts/unwired-scan.mjs --selftest
	cd crates/amos-tauri/frontend-ts && node scripts/unwired-scan.mjs
	# UI dictionary audit (see scripts/i18n-scan.mjs): en/zh must expose the same
	# keys AND the same {param} sets per key, and no dictionary key may be dead
	# (excluding Rust-emitted contract keys and dynamic `t(\`prefix.${…}\`)`
	# namespaces). `--selftest` pins its parser/classifier first.
	cd crates/amos-tauri/frontend-ts && node scripts/i18n-scan.mjs --selftest
	cd crates/amos-tauri/frontend-ts && node scripts/i18n-scan.mjs
	# Store-key *classification* (see scripts/store-scan.mjs): every `amos.*` store
	# key must be either in `SYNC_STORES` (content the user created) or listed in
	# scripts/store-allowlist.json under a kind whose reason says why losing it is
	# acceptable — so a new store can never silently miss every backup, and a stale
	# `SYNC_STORES` entry cannot lie about the snapshot.
	cd crates/amos-tauri/frontend-ts && node scripts/store-scan.mjs --selftest
	cd crates/amos-tauri/frontend-ts && node scripts/store-scan.mjs
	# Content *write* honesty (see scripts/write-scan.mjs): every production write of a
	# user-content store must either ask whether it landed (`writeStoreValueChecked` and
	# act on the answer) or be listed in scripts/write-allowlist.json under a kind whose
	# reason says why the unverified write is acceptable — so a screen can never quietly
	# show a change the store rejected. `--selftest` pins the extractor first.
	cd crates/amos-tauri/frontend-ts && node scripts/write-scan.mjs --selftest
	cd crates/amos-tauri/frontend-ts && node scripts/write-scan.mjs
	# Compiler suppressions (see scripts/svelte-ignore-scan.mjs, REQ-A472): a
	# `svelte-ignore` is a *local* exemption whose reason used to live only in a
	# comment on site, with nothing checking it still held, and `--compiler-warnings`
	# was a flag nobody had written a reason into (both recorded as open in
	# REQ-A471). Now scripts/svelte-ignore-allowlist.json is the carrier: every
	# suppression (file+code) must be declared there with a reason that **quotes the
	# on-site comment**, the site must keep real prose, a stale entry fails, and a
	# relaxed warning code needs its reason at that code. R5 additionally removes
	# each suppression, forces that one code to `error` and requires the count of
	# that code in the file to **rise** — the only instrument that can tell a live
	# exemption from a retired one (svelte-check reports nothing for an unused
	# ignore; measured 2026-09-19).
	# The file is restored and sha256-verified; a failed restore aborts with exit 2.
	# `--selftest` pins the readers first (24 assertions).
	cd crates/amos-tauri/frontend-ts && node scripts/svelte-ignore-scan.mjs --selftest
	cd crates/amos-tauri/frontend-ts && node scripts/svelte-ignore-scan.mjs

	# Identity minting (see scripts/idgen-scan.mjs): a persisted row's id may not be
	# `Date.now()` + a slice of `Math.random` — that family's three remaining sites
	# collided 3 times per 20,000 ids under a frozen clock (REQ-A401), and the failures were
	# user-visible (an overwritten recording's bytes, a notification dropped on reload, a
	# stream's tokens landing in the wrong bubble). R1 requires a decided, reasoned
	# allow-list entry for EVERY other random draw; R2 fails the id idiom outright, and R3
	# fails an id built from the clock alone (REQ-A402: two contexts agreeing on a
	# millisecond mint the SAME string — measured with two processes and a frozen clock —
	# and the consumers are silent: voice memos/calendars DROP the row, notes/events RENAME
	# it). Neither R2 nor R3 has an exception (`lib/localId.ts` is exempt *by name* as the one
	# sanctioned reader of the clock). Both directions are pinned by `--selftest`
	# (38 assertions).
	cd crates/amos-tauri/frontend-ts && node scripts/idgen-scan.mjs --selftest
	cd crates/amos-tauri/frontend-ts && node scripts/idgen-scan.mjs
	# Offline proof (see scripts/net-sentinel.mjs): the suite must not reach the network —
	# and the half that matters cannot be seen by a grep, because a module that *catches* its
	# own network error and degrades turns real egress into a green test (REQ-A400's
	# `fetchDeclination`, 6 real round trips that the log only hinted at). The sentinel is
	# preloaded into every `bun test` process (`scripts/bun-iso-test.mjs`, `bunfig.toml`) and
	# into vitest (`svelte-tests/setup-net-sentinel.ts`); an unstubbed call is recorded and
	# rejected, and the runner fails the file with the call site. `--selftest` pins its own
	# pieces; the negative controls are recorded in the CHANGELOG (remove a test's stub ⇒ the
	# run fails naming `compass.ts:261`).
	cd crates/amos-tauri/frontend-ts && node scripts/net-sentinel.mjs --selftest
	# The P2-1 coverage gate's **line classifier** (see scripts/lib-coverage-gate.mjs):
	# structural lines (`}`, `});`, `};`) are not executable — bun's lcov emits them as
	# `DA:n,0` and never marks them hit, which deflated the gate by ~10 points (measured:
	# 1,946 of 2,669 "missed" lines were bare closing braces; `notes.ts` read 87.6% while
	# being 100% covered). `--selftest` pins both halves of the classifier: structure drops,
	# and every real statement / `} else {` / brace-containing string is **kept**, so a real
	# gap cannot hide behind the filter.
	cd crates/amos-tauri/frontend-ts && node scripts/lib-coverage-gate.mjs --selftest
	# Rust loop hygiene (see scripts/hot-loop-scan.mjs): no `loop` may be a busy wait
	# (neither waiting nor able to exit), and a long-running loop must say who ends
	# it. `--selftest` first proves the classifier itself still fails when it should.
	node scripts/hot-loop-scan.mjs --selftest
	node scripts/hot-loop-scan.mjs
	# Structure: no recursion in production Rust (see scripts/rust-recursion-scan.mjs,
	# NASA Power of 10 rule 1 — the audit recorded "Rust has no goto" and never checked
	# recursion). `crates/amos-link`'s key-expression matcher was a recursive backtracker
	# whose worst case at the 32-segment ceiling was ~10^11 paths *while holding the
	# broker's registry lock*, and `crates/amos-web3`'s EIP-712 dependency walk recursed
	# once per declared type (i.e. per whatever a signing request contained). Also catches
	# **mutual** recursion inside a file (a call graph resolved the way Rust resolves
	# names). Baseline is empty; `--selftest` pins the extractor and the false-positive
	# shapes first.
	node scripts/rust-recursion-scan.mjs --selftest
	node scripts/rust-recursion-scan.mjs
	# Power of 10 rule #10's macro whitelist (see scripts/rust-macro-scan.mjs): the audit doc
	# claimed 「无 `macro_rules!` 自定义宏（0 处生产代码）」 while the tree had **four** — the
	# property is now enforced instead of asserted: a production `macro_rules!` must be listed in
	# scripts/rust-macro-allowlist.json with a `why`, an exemption whose macro is gone fails too
	# (the ratchet cannot rot), and a placeholder reason fails. There is no `--update` writer on
	# purpose: exempting a macro is a decision a human writes down.
	node scripts/rust-macro-scan.mjs --selftest
	node scripts/rust-macro-scan.mjs
	# The macOS menu bar's labels come from ONE table (see scripts/menu-i18n-scan.mjs,
	# REQ-A437): `menu.rs` used to draw them from English string literals while the shell
	# ships Chinese first, so a Chinese UI had an `File / Edit / View` menu bar (measured on a
	# real launch). `MenuLabels` + `LABELS_ZH/EN` made a **missing translation** a compile
	# error; this gate keeps the *drawing* side honest — a future row that passes `"New Thing"`
	# compiles fine and would otherwise be invisible (the frontend's i18n-scan reads only
	# .svelte/.ts). Rule 2 is the other direction: a field nothing draws is a dead translation.
	node scripts/menu-i18n-scan.mjs --selftest
	node scripts/menu-i18n-scan.mjs
	# The gRPC API reference is generated (scripts/proto-doc.mjs): its parser must
	# still work, and the checked-in docs/api-grpc.md must match proto/*.proto.
	node scripts/proto-doc.mjs --selftest
	node scripts/proto-doc.mjs --check
	# Markdown link integrity (see scripts/docs-link-scan.mjs): every *relative*
	# link in every *.md must resolve (root docs lifted out of docs/ kept `../`
	# links and 404'd). `--selftest` pins the strip/extract/classify logic first.
	node scripts/docs-link-scan.mjs --selftest
	node scripts/docs-link-scan.mjs
	# ENV central registry integrity (see scripts/env-doc-gen.mjs): docs/ENV_VARIABLES.md
	# must list every `AMOS_*` env var the Rust code declares (env::var / option_env! /
	# read_env / env_flag / ... and `pub const FOO: &str = "AMOS_*"` plus a usage),
	# and must not list any env that no Rust file references. Two-way sync so the
	# configuration matrix never drifts from the runtime code. `--selftest` pins the
	# parser/extract logic so the gate cannot silently rot.
	node scripts/env-doc-gen.mjs --self-test
	node scripts/env-doc-gen.mjs --check
	# FMEA inventory integrity (see scripts/fmea-gen.mjs): docs/FMEA.md must list every
	# failure mode the inventory knows about, and each documented failure must have its
	# mitigation code actually present in the named files. Two-way sync so the safety
	# table never claims a mitigation that doesn't exist or misses a known failure.
	# `--selftest` pins the verifyMitigation logic so a false-green is impossible.
	node scripts/fmea-gen.mjs --self-test
	node scripts/fmea-gen.mjs --check
	# The requirements ledger checks itself (see scripts/trace-scan.mjs, REQ-A371). The matrix is
	# the "requirement → code → test" index a reader is sent to, and it had **no gate at all**:
	# a duplicated requirement ID (`REQ-A250` used by two different rounds) and a row whose status
	# cell read `###` where the document's own legend says `✅`/`🟡`/`⬜` both lived in it while every
	# gate stayed green. `TRACE_DOC=<path>` checks a historical copy (the negative control).
	node scripts/trace-scan.mjs --selftest
	node scripts/trace-scan.mjs
	# Crate-door documentation (see scripts/crate-readme-scan.mjs): every workspace member
	# ships a README.md in the standard shape — title naming the crate, a link back to the
	# root README, the six sections, and its own `-p <crate>` command — and its `examples/`
	# dir and the README agree with each other (every example file named, every promised
	# `--example` real). A crate that cannot ship examples needs a reason in
	# scripts/crate-readme-allowlist.json. `docs-link-scan` above only proves the links
	# *resolve*; this one proves there is a document to link to at all.
	node scripts/crate-readme-scan.mjs --selftest
	node scripts/crate-readme-scan.mjs
	# Rust "pub fn defined but never referenced" scan (see scripts/rust-unwired-scan.mjs):
	# the Rust counterpart of the TS gate — a `pub` item in a library crate is
	# treated as reachable by the compiler, so `dead_code` never fires on it.
	# Baseline-ratcheted; FFI entry points (JNI / `#[no_mangle]` / `extern` ABI) are
	# deliberately out of scope. `--selftest` pins the extractor first.
	node scripts/rust-unwired-scan.mjs --selftest
	node scripts/rust-unwired-scan.mjs
	# P0-1 coverage (see scripts/rust-panic-scan.mjs): **every** crate root must carry
	# the `deny(clippy::unwrap_used, expect_used, panic)` gate, so a new crate cannot be
	# missed the way five were before this scan existed. `--selftest` pins the parser.
	node scripts/rust-panic-scan.mjs --selftest
	node scripts/rust-panic-scan.mjs
	# Platform-verdict integrity (see scripts/jni-boolean-scan.mjs): a JNI call whose
	# signature returns `Z` is answering *did you accept this?* — discarding it makes a
	# refusal indistinguishable from a switch, which is how the Airplane cascade
	# half-applied with no rollback and nothing reported (the hotspot path already
	# honoured its boolean; its two neighbours did not). `--selftest` pins the
	# parser/classifier first — and it exists because the first version of the scan
	# missed exactly the defect it was written for (a `;` inside a comment split the
	# statement), caught by the negative control.
	node scripts/jni-boolean-scan.mjs --selftest
	node scripts/jni-boolean-scan.mjs
	# Android permission integrity (see scripts/android-permission-scan.mjs): every
	# platform API this tree calls through JNI/Kotlin is mapped to the permission it
	# requires, and that permission must be **declared** in the tracked manifest
	# fragment (and requested from Kotlin when it is a runtime permission). On a real
	# device the missing Wi-Fi/Bluetooth declarations meant every radio read/write
	# threw SecurityException while every gate stayed green — a compile has the SDK
	# methods, the permission is an install/runtime fact (REQ-A185).
	node scripts/android-permission-scan.mjs --selftest
	node scripts/android-permission-scan.mjs
	# Android *component* integrity (see scripts/android-component-scan.mjs): the manifest
	# fragment is the only reason the in-call service, the screening service, the SMS
	# receiver and the exact-alarm receiver exist on device — and every entry is a name the
	# platform resolves at **instantiation** time. A name with no class, or a class of the
	# wrong kind (a `<receiver>` on a Service), builds fine and then simply never runs:
	# the alarm fires and nothing happens. `android-glue-mirror.sh` proves the fragment and
	# the generated manifest agree (both can spell the same wrong name); this gate proves
	# the name is a class this app has, that no component-kind class ships unregistered, that
	# the `<action>` reaching a component is a real platform action **with the sender
	# permission the platform requires** (an exported `SMS_RECEIVED` receiver without
	# `BROADCAST_SMS` lets any app inject the broadcast), and that every
	# `System.loadLibrary` names a library a workspace crate builds.
	node scripts/android-component-scan.mjs --selftest
	node scripts/android-component-scan.mjs
	# JNI hygiene (see scripts/jni-exception-scan.mjs): every provider must attach
	# through `amos_jni::attached` (a pooled thread can inherit a *pending* exception
	# and the next JNI call then aborts the process under CheckJNI — device-proven,
	# REQ-A185) and resolve glue classes through the app's loader
	# (`amos_jni::resolve_class`) instead of the thread-dependent `find_class`.
	# Sites that only hold a `JavaVM` carry a reason in scripts/jni-allowlist.json,
	# and a stale entry fails the gate too. `--selftest` pins the classifier first.
	node scripts/jni-exception-scan.mjs --selftest
	node scripts/jni-exception-scan.mjs
	# The JNI *names* on both sides of the boundary (see scripts/jni-contract-scan.mjs).
	# A JNI name is a string on one side and a declaration on the other, and neither
	# compiler sees across it. Three rules over the same boundary: **R1** every Rust
	# `call_static_method` into the glue must hit a Kotlin member with `@JvmStatic`
	# (without it the JVM throws NoSuchMethodError at the first call — every alarm
	# registration failed while Kotlin, Rust and the APK all compiled: F-TAU-014,
	# REQ-A376); **R2** every Kotlin `external fun` must have its Rust `Java_…` export and
	# vice versa (UnsatisfiedLinkError); **R3** every `call_method` on a glue/bridge handle
	# must name a Kotlin `fun` **with that signature — arity *and* types** (a rename, a
	# parameter change or a type drift is the
	# same invisible NoSuchMethodError — F-TAU-016). `--selftest` pins the parsers, the
	# handle/class resolvers and the JNI descriptor arity reader first; a site the gate
	# cannot resolve is a FAILURE unless scripts/jni-contract-allowlist.json records a
	# reason.
	node scripts/jni-contract-scan.mjs --selftest
	node scripts/jni-contract-scan.mjs
	# Registered Tauri command with no frontend consumer (see
	# scripts/tauri-command-scan.mjs): the reverse of the unwired-scan — a command
	# the host exposes but no screen asks for is a capability the UI cannot reach
	# (that is how the documented "selection → AI" flow sat dead). Also checks that
	# every registered name really is a `#[tauri::command]` fn. Deliberate
	# non-wirings are listed in scripts/tauri-command-allowlist.json **with a
	# reason**; `--selftest` pins the extractors first.
	node scripts/tauri-command-scan.mjs --selftest
	node scripts/tauri-command-scan.mjs
	# Command *arguments* on the wire (see scripts/tauri-args-scan.mjs): Tauri looks
	# each argument up by its lowerCamelCase name, so a payload key no Rust parameter
	# matches is silently ignored for `Option<T>` and a hard `missing required key`
	# error otherwise — how `rag_query`'s `top_k` killed every retrieval and
	# `interpret_start`'s `source_lang` silently ignored the chosen languages.
	# `--selftest` pins the extractors first.
	node scripts/tauri-args-scan.mjs --selftest
	node scripts/tauri-args-scan.mjs
	# Command *replies* on the wire (see scripts/tauri-reply-scan.mjs): Tauri
	# serializes a return value with serde's own rules, so a struct's fields keep
	# their Rust spelling (no `rename_all` in this workspace) and a `bool`/`usize`
	# stays a boolean/number. How the SMS trash panel read camelCase fields off
	# snake_case rows and compared a bool to a string — dead on device, green in CI.
	# `--selftest` pins the extractors first.
	node scripts/tauri-reply-scan.mjs --selftest
	node scripts/tauri-reply-scan.mjs
	# Host→UI *events* (see scripts/tauri-event-scan.mjs): the fourth wire
	# direction. Every emitted event must reach a screen (or be allow-listed with a
	# reason in scripts/tauri-event-allowlist.json), every subscription must have an
	# emitter, and for the events whose payload is a plain struct the TS type that
	# mirrors it must name fields the struct actually serializes (the reviewed table
	# in the script; tagged enums/tuples are documented as out of scope).
	node scripts/tauri-event-scan.mjs --selftest
	node scripts/tauri-event-scan.mjs
	# Documented configuration (see scripts/env-doc-scan.mjs): every AMOS_* env var
	# named in the current docs must actually be READ by the code (a knob that
	# silently does nothing is worse than an undocumented one). Forward-looking
	# mentions are allow-listed with a reason. `--selftest` pins the read-site
	# detection first (a comment or an `export` is not a read).
	node scripts/env-doc-scan.mjs --selftest
	node scripts/env-doc-scan.mjs
	# Onboarding-doc integrity (see scripts/onboarding-doc-scan.mjs): the first-run docs
	# (README/CONTRIBUTING/GETTING_STARTED) must not send a newcomer to a path or package
	# that no longer exists — `crates/amos-tauri/frontend` (the removed React host; the
	# live SPA is `frontend-ts`) and `libappindicator3-dev` (removed from Ubuntu 24.04).
	# `docs-link-scan` only sees `[x](path)` links and `env-doc-scan` only env names, so
	# neither caught a dead `cd` command inside a code fence.
	node scripts/onboarding-doc-scan.mjs --selftest
	node scripts/onboarding-doc-scan.mjs
	# Documented-command integrity (see scripts/make-target-doc-scan.mjs): every
	# `make <target>` the docs present as an instruction (inline code / a fenced
	# line) must be a real Makefile target. `GETTING_STARTED.md` shipped `make fmt`
	# with no such rule (`No rule to make target 'fmt'`); `docs-link-scan` sees
	# links and `env-doc-scan` sees env names — neither reads a command.
	node scripts/make-target-doc-scan.mjs --selftest
	node scripts/make-target-doc-scan.mjs
	# Makefile .PHONY hygiene (see scripts/phony-target-scan.mjs): an undeclared
	# command target is *silently skippable* — a same-named file makes `make` report
	# success without running it (the "gate that quietly does nothing" class), and a
	# `.PHONY` name with no rule is a dead declaration. `e2e-local` / `sup-smoke` /
	# `timesync-smoke` were undeclared.
	node scripts/phony-target-scan.mjs --selftest
	node scripts/phony-target-scan.mjs

# Regenerate the gRPC API reference after touching proto/*.proto (then commit it):
# `make api-docs`. The doc is generated, never hand-edited.
api-docs:
	node scripts/proto-doc.mjs

# Rust loop hygiene only (same scanner as `lint`, without the cargo/bun phases) —
# handy when changing a `loop`/event-task: `make hot-loop`.
hot-loop:
	node scripts/hot-loop-scan.mjs --selftest
	node scripts/hot-loop-scan.mjs

# Release bundle (FUNCTIONAL_GAP_ANALYSIS #39): build the headless daemon + CLI
# binaries, stage them with VERSION/README, tar them and write dist/SHA256SUMS.
# The SAME script is what .github/workflows/release.yml publishes on a `v*` tag, and
# it refuses to package a binary that cannot report its own version.
release-artifacts:
	bash scripts/release-artifacts.sh

run-ai:
	cargo run -p amos-ai

# Run the debug System UI directly. It loads the frontend from `devUrl` (:1420), so
# without a dev server this is the blank-window case: `make run-ui-dev` starts both,
# `make run-ui-release` embeds the assets instead.
run-ui:
	cargo run -p amos-tauri

# Run the System UI from source against a local frontend dev server (fixes the
# blank/white window that appears when the dev binary can't reach devUrl, :1420).
run-ui-dev:
	bash scripts/run-gui-dev.sh

# One-command desktop dev loop: the AI daemon (UDS) + the System UI, starting the
# frontend dev server the debug binary loads from `devUrl` when it is not already up
# (REQ-A189 — the script used to skip that, so it opened onto nothing served).
dev:
	bash scripts/dev.sh

# Production boot: start backends (AI honors the persisted local/cloud choice)
# + translate, wait until both UDS sockets are ready. Then: cargo run -p amos-tauri
run-backends:
	bash scripts/run-backends.sh

# Run amos-ai + amos-translate under amos-supervisor (crash auto-restart, SIGUSR1
# hot-restart, graceful stop) — the README quick-start path. `ARGS=--print-config`
# prints the generated supervisor spec instead of running; `ARGS=--dry-run` validates.
supervise:
	scripts/supervise-backends.sh $(ARGS)

# Build & launch the EMBEDDED (release) System UI. The debug binary loads
# devUrl (localhost:1420) and can collide with another app; use this target.
# NOTE: this launches the **bare** `target/release/amos-tauri` binary, which macOS
# refuses to activate — the window is on screen but sits behind other apps unless you
# bring it forward (the host warns about exactly that: REQ-A232). To *see* the shell,
# use `make app-open` (the `.app` bundle, which macOS does activate).
run-ui-release:
	bash scripts/run-ui-release.sh

# Build + open the macOS `.app` bundle — the only form macOS will activate/focus, so
# this is the target that actually puts the shell window in front of you (REQ-A232).
# The bundle embeds `frontend-ts/dist`, so the freshness gate runs first (a stale
# bundle must not ship, see REQ-A228) — `make frontend-dist` if it complains.
app-open:
	node scripts/dist-freshness.mjs
	cd crates/amos-tauri && cargo tauri build --bundles app
	open "$(CURDIR)/target/release/bundle/macos/Amos.app"

# RPC readiness probe: both daemons must answer get_status running=true.
health:
	bash scripts/health-backends.sh

# GUI smoke for the 同传 app (needs a display): builds, starts the mock translate
# daemon on a UDS, launches the System UI and prints the on-screen script. The headless
# readiness probe (display check + build only) is `make gui-smoke-check` — the wrapper
# scripts/gui-smoke-check.sh advertised a CI/headless use that had no caller until
# REQ-A189 wired it here.
gui-smoke:
	bash scripts/gui-smoke.sh $(ARGS)

gui-smoke-check:
	bash scripts/gui-smoke-check.sh

# Host-side "honesty" smoke: proves the AI daemon truthfully reports its real
# engine + degraded state (engine/engine_model/degraded/asr) over get_status —
# mock=not-degraded, a requested-but-unreachable real engine=degraded, and
# ollama follows reachability. No GUI / no real device needed.
honesty-smoke:
	bash scripts/ai-honesty-smoke.sh

# Print the mobile-targets init guide (requires Android SDK / Xcode on a real
# machine; see docs/mobile-targets.md for the exact commands).
mobile-init:
	@echo "Amos mobile target initialization guide:"
	@echo "  -> docs/mobile-targets.md"
	@echo ""
	@echo "Quick summary (run on a machine with Android SDK / Xcode):"
	@echo "  rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android"
	@echo "  rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim"
	@echo "  cargo install tauri-cli --version ^2 --locked"
	@echo "  cd crates/amos-tauri && cargo tauri android init && cargo tauri ios init"
	@echo "  cargo tauri android build --debug && cargo tauri ios build --debug"

# Best-effort prerequisite check for mobile builds (non-fatal if tools absent).
#
# The SDK/NDK probes accept **either** variable name, because that is what the rest of the
# tree reads: `scripts/android-audio-check.sh` / `-ai-sherpa-check.sh` / `-glue-nv21-check.sh`
# all take `ANDROID_NDK_HOME` or `ANDROID_SDK_ROOT/ndk/*`, and docs/mobile-targets.md says
# "需要 ANDROID_HOME / ANDROID_SDK_ROOT". Probing only `ANDROID_HOME` printed
# "[warn] ANDROID_HOME unset" on a machine where every android-* target passes (REQ-A193) —
# a check that lies about a working toolchain. The NDK is reported because every android-*
# target needs it and nothing else checks it.
mobile-check:
	@echo "--- Amos mobile toolchain check ---"
	@(rustup target list --installed 2>/dev/null | grep -q aarch64-linux-android && echo "[ok] rust android target" || echo "[warn] android rust target not installed (see docs/mobile-targets.md)")
	@(rustup target list --installed 2>/dev/null | grep -q aarch64-apple-ios && echo "[ok] rust ios target" || echo "[warn] ios rust target not installed (see docs/mobile-targets.md)")
	@(command -v cargo-tauri >/dev/null 2>&1 && echo "[ok] tauri-cli" || echo "[warn] tauri-cli not installed (cargo install tauri-cli --version ^2 --locked)")
	@(command -v java >/dev/null 2>&1 && echo "[ok] java" || echo "[warn] java not found (JDK 17+ needed for Android)")
	@(sdk="$${ANDROID_HOME:-$${ANDROID_SDK_ROOT:-}}"; [ -n "$$sdk" ] && echo "[ok] Android SDK=$$sdk" || echo "[warn] neither ANDROID_HOME nor ANDROID_SDK_ROOT is set (Android SDK)")
	@(ndk="$${ANDROID_NDK_HOME:-}"; if [ -z "$$ndk" ] && [ -n "$${ANDROID_SDK_ROOT:-}" ] && [ -d "$$ANDROID_SDK_ROOT/ndk" ]; then ndk="$$(ls -d "$$ANDROID_SDK_ROOT/ndk"/* 2>/dev/null | sort -V | tail -1)"; fi; [ -n "$$ndk" ] && echo "[ok] Android NDK=$${ndk##*/}" || echo "[warn] Android NDK not found (ANDROID_NDK_HOME, or ANDROID_SDK_ROOT/ndk/*)")
	@(command -v xcodebuild >/dev/null 2>&1 && echo "[ok] xcodebuild (iOS)" || echo "[warn] xcodebuild not found (iOS)")

# Run the crates' **examples** (REQ-A463). `cargo clippy --workspace --all-targets`
# compiles them and `cargo test` runs none of them, so an example could compile and still
# break the moment someone ran it — `crates/amos-robot/examples/serial_loopback.rs` did
# exactly that (a hand-written "12 bytes" against a driver whose wire form is 11) and was
# found **by hand**, because no gate could see it. `scripts/examples-smoke.mjs` builds every
# example once, then runs each one under a timeout; the ones that need a device, a feature, an
# argument or a terminal are listed in `scripts/examples-smoke-allowlist.json` **with a
# reason** (an entry that stops matching is stale and fails). Measured 2026-09-19: 68 in the
# tree, 49 run clean, 19 excused — and the first defect it found on its own was
# `amos-monitor/examples/sample_health.rs` missing `required-features`, which broke
# `cargo build -p amos-monitor --all-targets` while every workspace-wide gate stayed green
# (cargo unifies `amos-monitor/linux` in from `amos-ai`).
examples-smoke:
	node scripts/examples-smoke.mjs --selftest
	node scripts/examples-smoke.mjs

# Every workspace member must **check on its own**, and no two members may share a `bin`/`example`
# output path (REQ-A464/A465, the class behind F-DEV-055). cargo unifies features across the
# workspace, so a `--workspace` build turns on features a package does not enable for itself:
# `crates/amos-monitor/examples/sample_health.rs` compiled in every gate (because `amos-ai`
# enables `amos-monitor/linux`) while `cargo build -p amos-monitor --all-targets` failed with
# E0432. It also merges output paths, so `status_once` in amos-ai + amos-translate (and
# `embed_commands` in amos-appstore-cli + amos-link-cli) both wrote to one
# `target/debug/examples/<name>` — which cargo only *warns* about. `make lint` and `make test`
# are both workspace-wide, so neither can see this; the only instrument that can is one cargo
# invocation per package plus cargo's own target table. `check` rather than `build`: the
# per-package class is name-resolution/type-level. Measured 2026-09-19 (warm target dir):
# 48 members, ~68 s.
# Convenience target only: `make lint` already runs the gate (that is the line CI executes), so
# `verify` must not list this target too — that would run all 48 checks a second time.
isolation-check:
	node scripts/isolation-check.mjs --selftest
	node scripts/isolation-check.mjs

# Everything this repository can verify **without a device**, in one command (REQ-A193).
# CI runs the same work split across jobs (`lint`, `test`, `cov`, `smoke`, `sup-smoke`,
# `gated-check`, the android checks); this is the sequential local equivalent, so "is this
# checkout healthy?" is one command instead of a list someone has to remember. Measured
# 2026-09-13: 18 targets, all EXIT=0 (see CHANGELOG). Device targets (`device-eval`,
# `android-app`) and the generator (`api-docs`, which *writes* docs/api-grpc.md — lint runs
# its read-only `--check`) are deliberately not here; neither is `ci-local`'s container
# build (a multi-GB NDK image) — `make ci-local` covers the rest of that gate.
verify: lint test check cov ci-local honesty-smoke hot-loop examples-smoke
verify: smoke sup-smoke timesync-smoke e2e-local gated-check
verify: android-glue-check android-audio-check android-ai-sherpa-check android-app-check
verify: pdf-android-check vector-db-check mobile-check
	@echo "[verify] all offline verification targets passed"

# Cross-compile + link gate for amos-audio's Android audio seams (AAudio/TinyALSA
# FFI). Compiles every ABI and link-checks AAudio against the NDK's libaaudio.so
# via the aaudio_link_smoke example. Requires NDK + cargo-ndk + rustup android
# targets (see scripts/android-audio-check.sh). No device needed.
android-audio-check:
	bash scripts/android-audio-check.sh

# Cross-compile gate for amos-ai WITH real sherpa on-device ASR (asr-sherpa) on
# Android. Stages the sherpa-onnx Android shared lib (upstream archive has no
# wrapping dir, so auto-download fails; see script), then builds the daemon for
# arm64-v8a and link-checks libsherpa-onnx-c-api.so. Requires NDK + cargo-ndk +
# protoc + network. No device needed.
android-ai-sherpa-check:
	bash scripts/android-ai-sherpa-check.sh

# Read-only USB diagnosis for a device that does **not** show up in `adb devices`
# (`scripts/diagnose-android-usb.sh`, macOS host; steps 1/7–7/7 walk adb itself, the
# cable/port, the ROM's debug settings and the udev/usbmuxd layer and print the honest
# verdict per step). READ ONLY unless `ARGS=--fix` is passed, and even then it only
# restarts adb — it never touches USB hardware. It ships for the same reason
# `android-voice-bringup` does: the bring-up docs below are useless if the host cannot
# see the device at all, and until REQ-A454 nothing named this script (the Makefile, CI
# and every reachable script never mentioned it), so `unwired-script-scan` reported it as
# dead weight — a diagnostic nobody can find is the same as no diagnostic.
android-usb:
	bash scripts/diagnose-android-usb.sh $(ARGS)

# One-shot DEVICE driver for the always-on native voice chain (AAudio → local
# sherpa → assistant). Host-verifiable without a device: `bash -n` + `--dry-run`
# print the exact plan; `--check-prereqs` only checks adb. `--apply` actually
# touches an attached device (stage sherpa model, grant RECORD_AUDIO, run the
# AAudio probe → C2/C3 evidence) and prints the honest C1–C7 verdict.
android-voice-bringup:
	bash scripts/android-voice-bringup.sh

# One-shot device driver for the offline RAG chain (daemon `Rag` + rag_once +
# bench_arm). Mirrors android-voice-bringup: --check-prereqs / --dry-run / --apply.
# Pass extra args through ARGS (e.g. `make android-rag-bringup ARGS='--apply --device X'`).
android-rag-bringup:
	bash scripts/android-rag-bringup.sh $(ARGS)

# Build + install the System UI APK on a connected device, with the steps that are
# easy to forget made explicit and ordered:
#   0. mirror the tracked Kotlin glue into `gen/` (git-ignored) — without it a NEWLY
#      ADDED glue file, or an edit to one, is simply missing/stale in the APK
#      (REQ-A175/A176: the alarm glue was absent from every mirror),
#   1. rebuild the frontend `dist` (tauri.conf's beforeBuildCommand is EMPTY, so
#      `cargo tauri android build` embeds whatever `dist/` already holds — a
#      stale bundle silently ships an old UI),
#   2. build the arm64 debug APK with the `android` feature,
#   3. install it with runtime permissions granted (`-g`).
# Override the package/devices as needed: `make android-app DEVICE=...`.
# Output goes to crates/amos-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
# (680 MB unstripped; `make android-app-strip` shrinks it to ~26 MB while keeping JNI exports).
android-app:
	scripts/android-glue-mirror.sh
	cd crates/amos-tauri/frontend-ts && bun run build
	cargo tauri android build --debug --features android --target aarch64
	adb $(if $(DEVICE),-s $(DEVICE),) install -r -g crates/amos-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk

# Strip the unstripped universal APK's libamos_tauri_lib.so of DWARF debug info, re-pack,
# zipalign and debug-sign the result. Drops ~660 MB → ~26 MB while keeping every JNI export
# (only the DWARF sections — `.debug_*`, `.symtab`, `.strtab` — are dropped; the dynamic
# symbol table that the runtime loader consults is untouched). Requires NDK 23.x's
# `llvm-strip` and a debug keystore (Android Studio's `~/.android/debug.keystore`).
# Output: crates/amos-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug-stripped.apk
android-app-strip:
	bash scripts/android-app-strip.sh

# Host-JVM gate for ALL the Android glue's Kotlin (no device needed): mirrors the
# whole android-glue/ tree into the generated Android project (so the compiled set
# == the tracked set, reproducibly), VERIFIES the two hand-merged gen/ artefacts
# (manifest fragments + the generated Activity's glue wiring), runs the Kotlin
# compile + the camera packer's JUnit tests, treats our glue's non-deprecation
# Kotlin warnings as errors, and finally runs **Android Lint** (`:app:lintArmDebug`):
# the compiler cannot tell whether an API exists on `minSdk = 26` or whether a call
# needs a permission nobody checks — the first lint run found 20 such errors in our
# glue (5 × NewApi, 8 × MissingPermission) plus an API-29-only MediaStore path that
# was silently dead on API 26..28 (REQ-A380). Errors in our glue fail this gate;
# warnings are printed grouped by issue id. Requires a JDK 17, an initialised gen/
# and a warm Gradle cache — which is why it lives in `make verify`, not `make lint`.
android-glue-check:
	bash scripts/android-glue-nv21-check.sh

# Cross-compile gate for the offline-RAG PDF data-extraction crate on Android.
# The crate is pure Rust on lopdf (no C), so this only needs the rustup android
# target (no NDK linker for a `check`). Run `rustup target add aarch64-linux-android`
# first if missing. No device needed.
pdf-android-check:
	cargo check -p amos-pdf-parser --target aarch64-linux-android
	cargo test -p amos-pdf-parser

# Host + Android-cross-compile gate for the offline vector-retrieval core
# (amos-vector-db). Pure Rust on serde — the aarch64 `check` needs no NDK linker.
# Also runs clippy + fmt (crate hygiene) and prints the honest host benchmark.
vector-db-check:
	cargo check -p amos-vector-db --target aarch64-linux-android
	cargo test -p amos-vector-db
	cargo clippy -p amos-vector-db --all-targets -- -D warnings
	cargo fmt -p amos-vector-db -- --check
	cargo run -p amos-vector-db --example bench_arm -- 2000 64

# Cross-compile gate for the Tauri host crate on Android — the gate that was missing.
# `mobile-check` only *reports* the toolchain (it never fails); `pdf-android-check` and
# `vector-db-check` cross-compile their own crates. So nothing compiled `amos-tauri`
# for aarch64: a desktop-only API used without a cfg gate (a *runtime* `FormFactor`
# guard does not help — the method must resolve) kept the host green and broke the
# whole APK with E0599 (measured 2026-09-16: `make android-app` died on
# `WebviewWindowBuilder::title_bar_style`, see F-WM-019). The NDK's `cc` shim
# (`aarch64-linux-android-clang`) does not exist under its unversioned name, so the
# env has to come from cargo-ndk — same tool the audio gate uses. API 31 matches the
# linker pinned in .cargo/config.toml.
android-app-check:
	cargo ndk -t arm64-v8a -P 31 check -p amos-tauri --features android


# Local CI-parity gate: shell-syntax + workflow YAML + native-toolchain pin
# parity + (optional) container build. No push / no CI needed. See
# scripts/ci-local-gate.sh. Pass --docker to also build the container image.
ci-local:
	bash scripts/ci-local-gate.sh

# Unified local deploy/gate entrypoint (deploy.sh). Keeps the local M-series Mac
# NDK/env/clippy in lockstep with the Ubuntu CI runner and regenerates
# .cargo/config.toml from the DISCOVERED NDK (no stale hard-coded paths).
#   make deploy        -> ./deploy.sh help
#   ./deploy.sh lint / test / android / android-build / docker / ci-local / doctor
deploy:
	./deploy.sh

doctor:
	./deploy.sh doctor

clean:
	cargo clean

# Drive + inspect the running System UI on a connected device (debuggable build).
# Not part of lint: it needs hardware. See docs/REAL_DEVICE_SYSTEM_UI_AUDIT.md §5.5.
#   make device-eval JS='document.title'
#   make device-media-probe                  # REQ-A350 acceptance: camera + recordings
device-eval:
	node scripts/device-ui-eval.mjs $(JS)

# Device-side acceptance for REQ-A350 (a memo must be a file the user can find):
# reads the camera + recordings collections through the *real* host bridge on the
# device, so "the row said 已保存 but nothing appeared in Files" becomes measurable.
# Read-only (no permission dialog). Run before and after tapping 保存到「录音」 —
# see the header of the probe. Requires a debuggable build (debug APK) + one device.
device-media-probe:
	node scripts/device-ui-eval.mjs --await --file scripts/device-probe-media-export.js
