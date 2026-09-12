.PHONY: all build test check lint cov smoke gated-check run-ai run-ui run-ui-dev run-ui-release run-backends health mobile-init mobile-check android-app android-glue-check android-audio-check android-ai-sherpa-check android-voice-bringup android-rag-bringup pdf-android-check vector-db-check ci-local clean honesty-smoke deploy doctor hot-loop release-artifacts api-docs

all: build

build:
	cargo build --workspace

# Comprehensive tests: Rust (unit + end-to-end RPC over UDS) + TS System-UI
# shell (bun). `cargo test --workspace` picks up every
# crate's tests/ dir automatically (incl. crates/amos-tauri/tests/ai_daemon_e2e.rs).
test:
	cargo test --workspace
	# TS System-UI: bun-iso-test.mjs runs pure files in one process and each DOM
	# test file in its OWN process (happy-dom global windows are per-process).
	cd crates/amos-tauri/frontend-ts && bun run test

# Fast check of the React/TS System-UI (tests + typecheck).
check:
	cd crates/amos-tauri/frontend-ts && bun run check

# TS core-lib coverage gate (P2-1): line coverage over src/lib/** must stay >= the
# threshold enforced by scripts/lib-coverage-gate.mjs (default 80%). Runs over the
# pure (non-DOM) files so no shared happy-dom process is involved (DOM files are
# already covered by correctness in `make test`).
cov:
	cd crates/amos-tauri/frontend-ts && bun run coverage:gate

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
	cargo check -p amos-power --features linux
	cargo test -p amos-power --features linux --lib
	# System working-status sampler (amos-monitor): real /proc reads over an
	# injected root (`linux`) + on-device Android skeleton (`android`). The linux
	# tests run entirely over a tempdir fixture — no root/device needed.
	cargo check -p amos-monitor --features linux
	cargo test -p amos-monitor --features linux --lib
	cargo check -p amos-monitor --features android

# Production gate: formatting + clippy must be clean; TS shells must typecheck and
# no `src/lib` export may lose its production call site (dead-export regression).
lint:
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
	cd crates/amos-tauri/frontend-ts && bun run typecheck
	# Lint-input integrity (see scripts/lint-inputs-scan.mjs): every file the steps
	# below invoke (`node scripts/*.mjs` plus the allow-lists/baselines they read) must
	# exist **and be tracked by git** — a gate that lives only in one working tree makes
	# `make lint` pass locally while a clean checkout runs nothing. Runs first because
	# it guards the gates that follow. `--selftest` pins the parser/resolver first.
	node scripts/lint-inputs-scan.mjs --selftest
	node scripts/lint-inputs-scan.mjs
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
	# Rust loop hygiene (see scripts/hot-loop-scan.mjs): no `loop` may be a busy wait
	# (neither waiting nor able to exit), and a long-running loop must say who ends
	# it. `--selftest` first proves the classifier itself still fails when it should.
	node scripts/hot-loop-scan.mjs --selftest
	node scripts/hot-loop-scan.mjs
	# The gRPC API reference is generated (scripts/proto-doc.mjs): its parser must
	# still work, and the checked-in docs/api-grpc.md must match proto/*.proto.
	node scripts/proto-doc.mjs --selftest
	node scripts/proto-doc.mjs --check
	# Markdown link integrity (see scripts/docs-link-scan.mjs): every *relative*
	# link in every *.md must resolve (root docs lifted out of docs/ kept `../`
	# links and 404'd). `--selftest` pins the strip/extract/classify logic first.
	node scripts/docs-link-scan.mjs --selftest
	node scripts/docs-link-scan.mjs
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

run-ui:
	cargo run -p amos-tauri

# Run the System UI from source against a local frontend dev server (fixes the
# blank/white window that appears when the dev binary can't reach :5173).
run-ui-dev:
	bash scripts/run-gui-dev.sh

# Production boot: start backends (AI honors the persisted local/cloud choice)
# + translate, wait until both UDS sockets are ready. Then: cargo run -p amos-tauri
run-backends:
	bash scripts/run-backends.sh

# Build & launch the EMBEDDED (release) System UI. The debug binary loads
# devUrl (localhost:1420) and can collide with another app; use this target.
run-ui-release:
	bash scripts/run-ui-release.sh

# RPC readiness probe: both daemons must answer get_status running=true.
health:
	bash scripts/health-backends.sh

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
mobile-check:
	@echo "--- Amos mobile toolchain check ---"
	@(rustup target list --installed 2>/dev/null | grep -q aarch64-linux-android && echo "[ok] rust android target" || echo "[warn] android rust target not installed (see docs/mobile-targets.md)")
	@(rustup target list --installed 2>/dev/null | grep -q aarch64-apple-ios && echo "[ok] rust ios target" || echo "[warn] ios rust target not installed (see docs/mobile-targets.md)")
	@(command -v cargo-tauri >/dev/null 2>&1 && echo "[ok] tauri-cli" || echo "[warn] tauri-cli not installed (cargo install tauri-cli --version ^2 --locked)")
	@(command -v java >/dev/null 2>&1 && echo "[ok] java" || echo "[warn] java not found (JDK 17+ needed for Android)")
	@(test -n "$$ANDROID_HOME" && echo "[ok] ANDROID_HOME=$$ANDROID_HOME" || echo "[warn] ANDROID_HOME unset (Android SDK)")
	@(command -v xcodebuild >/dev/null 2>&1 && echo "[ok] xcodebuild (iOS)" || echo "[warn] xcodebuild not found (iOS)")

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

# Build + install the System UI APK on a connected device, with the two steps
# that are easy to forget made explicit and ordered:
#   1. rebuild the frontend `dist` (tauri.conf's beforeBuildCommand is EMPTY, so
#      `cargo tauri android build` embeds whatever `dist/` already holds — a
#      stale bundle silently ships an old UI),
#   2. build the arm64 debug APK with the `android` feature,
#   3. install it with runtime permissions granted (`-g`).
# Override the package/devices as needed: `make android-app DEVICE=...`.
android-app: 
	cd crates/amos-tauri/frontend-ts && bun run build
	cargo tauri android build --debug --features android --target aarch64
	adb $(if $(DEVICE),-s $(DEVICE),) install -r -g crates/amos-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk

# Host-JVM gate for the Kotlin camera glue's pure NV21 packer (no device needed):
# mirrors android-glue/ into the generated Android project and runs the packer's
# JUnit tests + the Kotlin compile. Requires a JDK 17 (AGP/Kotlin reject newer).
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
