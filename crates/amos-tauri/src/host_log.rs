//! Install the process-wide `tracing` sink — logcat on Android, **stderr on desktop**.
//!
//! Why this module exists: every provider and host path in this crate reports its
//! failures with `tracing::warn!`/`info!` — a dropped camera frame, an unarmed glue
//! bus, a failed radio-provider install, **a shell window that could not be sized, a
//! screen that could not be measured, a split pane with no window to place** — and
//! **nothing was listening**. `run()` installed a subscriber only for the Android
//! feature (REQ-A187), so on the **desktop** every one of those events was a no-op:
//! the PC build ran with a completely silent terminal, and each "reported, not
//! silent" claim in the window/form-factor work was unverifiable exactly where a
//! desktop user runs it (observed on macOS: a release run printed nothing at all
//! between launch and the first frame — REQ-A229).
//!
//! Two sinks, one subscription point:
//! * **Android** — logcat via the existing `liblog` FFI (`adb logcat -s AmosRust`),
//!   filtered to this workspace's own targets (without a filter the first device run
//!   produced ~10 000 lines in 25 s, nearly all of them the `jni` crate's noise).
//! * **desktop** — stderr, honoring `RUST_LOG` when set and otherwise defaulting to
//!   `amos=info,warn` (our own targets at INFO — the boot lines a desktop run wants
//!   to read — and a dependency's WARN, but not a dependency's chatter).
//!
//! Honest boundaries: the subscriber is process-wide and installed **first** in
//! `run()` (before any provider can log); a second call is a no-op (`try_init`); and
//! if the logcat symbol were absent the call is a plain no-op rather than a crash —
//! the events then simply stay unseen, exactly as before.

#[cfg(target_os = "android")]
use std::ffi::CString;

/// Android log priorities (`android/log.h`) — only meaningful to the logcat sink.
#[cfg(target_os = "android")]
const ANDROID_LOG_INFO: i32 = 4;
#[cfg(target_os = "android")]
const ANDROID_LOG_WARN: i32 = 5;
#[cfg(target_os = "android")]
const ANDROID_LOG_ERROR: i32 = 6;

extern "C" {
    /// Provided by `liblog` (linked for the NDK audio path: `-llog`).
    #[cfg(target_os = "android")]
    fn __android_log_write(
        prio: i32,
        tag: *const std::os::raw::c_char,
        text: *const std::os::raw::c_char,
    ) -> i32;
}

/// Write one line to logcat under `tag`; a formatting failure is dropped silently
/// (logging must never be the thing that breaks a call).
///
/// Device-only by construction: on a host the sink is stderr (`install_stderr`), so no
/// `liblog` symbol is referenced there at all. The Android build links `liblog` for the
/// NDK audio path, which is why this is an FFI call instead of a new dependency.
#[cfg(target_os = "android")]
fn log_to_logcat(prio: i32, tag: &str, msg: &str) {
    {
        let Ok(tag) = CString::new(tag) else {
            return;
        };
        let Ok(text) = CString::new(msg) else {
            return;
        };
        // SAFETY: both pointers come from live `CString`s that outlive the call;
        // `liblog`'s contract is exactly this (tag + NUL-terminated message).
        //
        // The byte-count return is deliberately ignored (recorded in
        // scripts/rust-discard-baseline.json): if writing to logcat itself fails there is
        // nothing left to report *to*, and retrying a log line is not a behaviour we want
        // (REQ-A187).
        unsafe {
            let _ = __android_log_write(prio, tag.as_ptr(), text.as_ptr());
        }
    }
}

/// Install the process-wide sink once. Called at the top of [`crate::run`], **before**
/// anything that can report a failure.
///
/// One call, two platform sinks — both filtered to this workspace's own targets, so the
/// reports this module exists for are never buried under a dependency's chatter.
pub fn install() {
    #[cfg(target_os = "android")]
    install_logcat();
    #[cfg(not(target_os = "android"))]
    install_stderr();
}

/// Desktop sink: one human-readable line per event on **stderr**, so a `make
/// run-ui-release` / `cargo run -p amos-tauri` prints the boot facts (form factor,
/// shell window size, measured screen, degraded providers) instead of nothing.
///
/// `RUST_LOG` wins when set (standard `EnvFilter` grammar, e.g. `RUST_LOG=debug`);
/// otherwise our targets log at INFO and everything else only at WARN. `try_init` keeps
/// a second call (tests, an embedder that already installed one) a no-op.
///
/// **`with_writer(std::io::stderr)` is load-bearing** (REQ-A422, measured 2026-09-18):
/// `tracing_subscriber::fmt::layer()` defaults to **stdout**, while this module's whole
/// reason for existing is a sink an operator can capture on the *error* stream — the
/// stream the platform's own diagnostics use. Launching the built `.app` through
/// LaunchServices with `open --stderr FILE` produced a file containing only the
/// `eprintln!` probes and none of these events, because every `tracing` line had gone to
/// stdout (which `open` discards unless `--stdout` is also passed). Any embedder,
/// launcher or CI step that captures stderr alone therefore saw a silent host — the
/// exact failure REQ-A229 set out to end.
#[cfg(not(target_os = "android"))]
fn install_stderr() {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("amos=info,warn"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .try_init();
}

/// Android sink: logcat (see the module docs for why logcat and why this filter).
#[cfg(target_os = "android")]
fn install_logcat() {
    use tracing_subscriber::filter::{LevelFilter, Targets};
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    /// A layer that forwards every event to logcat as one line.
    struct LogcatLayer;

    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for LogcatLayer {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _ctx: tracing_subscriber::layer::Context<'_, S>,
        ) {
            struct Line(String);
            impl tracing::field::Visit for Line {
                fn record_debug(
                    &mut self,
                    field: &tracing::field::Field,
                    value: &dyn std::fmt::Debug,
                ) {
                    if !self.0.is_empty() {
                        self.0.push(' ');
                    }
                    self.0.push_str(&format!("{}={:?}", field.name(), value));
                }
            }
            let mut line = Line(String::new());
            event.record(&mut line);
            let prio = match *event.metadata().level() {
                tracing::Level::ERROR => ANDROID_LOG_ERROR,
                tracing::Level::WARN => ANDROID_LOG_WARN,
                _ => ANDROID_LOG_INFO,
            };
            log_to_logcat(
                prio,
                "AmosRust",
                &format!("{} {}", event.metadata().target(), line.0),
            );
        }
    }

    // Hierarchical target filter: `amos` matches `amos::radio`, `amos::camera`, …
    let filter = Targets::new().with_target("amos", LevelFilter::DEBUG);

    // `try_init` (not `init`): a second call is a no-op, and the WebView side may already
    // have installed a subscriber in tests.
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(LogcatLayer)
        .try_init();
}
