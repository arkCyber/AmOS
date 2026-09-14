//! Android-only: route Rust `tracing` into logcat (REQ-A187).
//!
//! Why this module exists: every Android provider in this crate reports its failures
//! with `tracing::warn!`/`info!` — a dropped camera frame, an unarmed glue bus, a
//! failed radio-provider install, a refused platform call — and **nothing on the device
//! listened**: `run()` never installed a subscriber, so those events went nowhere. A
//! `tracing` event with no subscriber is a no-op, which made every "reported, not
//! swallowed" claim in the Android path unverifiable on hardware (the same class of
//! defect as the missing permissions: the code said one thing and the device another).
//!
//! Logcat is the one sink a device round can read (`adb logcat -s AmosRust`), and the
//! Android build already links `liblog` for the NDK audio path, so this is a small
//! FFI shim instead of a new dependency: `__android_log_write(prio, tag, text)`.
//!
//! Honest boundaries: the subscriber is process-wide and installed **first** in `run()`
//! (before any provider can log); a second call is a no-op; and if `liblog` were absent
//! the call is a plain no-op rather than a crash — the events then simply stay unseen,
//! exactly as before.

#[cfg(target_os = "android")]
use std::ffi::CString;

/// Android log priorities (`android/log.h`).
const ANDROID_LOG_INFO: i32 = 4;
const ANDROID_LOG_WARN: i32 = 5;
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
/// On a **host** build the `android` feature is still compiled *and linked* (CI runs
/// `cargo test`/`clippy --features android` on macOS/Linux) and there is no `liblog` —
/// so the call is a no-op instead of an undefined symbol. Events stay unseen on the
/// host, exactly as they were before this sink existed; only a device gains a log.
fn log_to_logcat(prio: i32, tag: &str, msg: &str) {
    #[cfg(not(target_os = "android"))]
    {
        // Host: no logcat. The tuple keeps the parameters "used" so the signature stays
        // identical on both targets (a tuple is not `#[must_use]`, so this is not a
        // discarded result).
        let _: (i32, &str, &str) = (prio, tag, msg);
    }
    #[cfg(target_os = "android")]
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

/// Install the logcat subscriber once. Called at the top of [`crate::run`].
///
/// **Filtered to this workspace's own targets** (`amos*`): without a filter the first
/// device run produced ~10 000 logcat lines in 25 s, almost all of them the `jni` crate's
/// per-call `log` records — noise that buries the very reports this sink exists for (and
/// churns the device's log ring). Dependencies stay out; our own providers log at DEBUG,
/// which is what a device round reads.
pub fn install() {
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
