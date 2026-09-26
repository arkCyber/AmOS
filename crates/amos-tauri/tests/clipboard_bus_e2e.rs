//! End-to-end test for the clipboard **ingest bus** (`TODO 5.2`: "verify the ingest bus
//! path (`INGEST_BUS`) is `OnceLock<Arc<GlobalClipboard>>` — write a test that asserts it's set
//! exactly once") and its announce hook.
//!
//! The bus and the notifier are **process-global** `OnceLock`s, so their exactly-once property
//! can only be observed honestly in a process that has not touched them: an integration test
//! binary is a fresh process, which is exactly why this lives in `tests/` rather than beside the
//! `lib.rs` unit tests (a parallel `cargo test --lib` run could have armed them from another
//! test).
//!
//! What is proven here is the host-verifiable half of the container→host path:
//! `arm_ingest` + `set_notifier` are exactly-once, a real container copy lands in the shared
//! buffer, and the notice the UI receives is **metadata-only** (never the content). The Android
//! `ClipboardGlue.onContainerCopy` JNI trampoline and the `AndroidClipboardSink` push direction
//! need a real JVM + Kotlin glue and are device-only — see the module docs of `clipboard_glue.rs`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use amos_tauri_lib::clipboard::{
    arm_ingest, ingest_native_text, set_notifier, ClipboardNotice, GlobalClipboard,
};

/// One narrative for the process-global bus: install the notifier, arm the bus, prove both are
/// exactly-once, then ingest a real container copy and inspect what the UI was told.
#[test]
fn the_ingest_bus_and_notifier_are_exactly_once_and_ingest_notices_stay_metadata_only() {
    let shared = Arc::new(GlobalClipboard::new());

    // The notifier observes only notices — the Arc<Mutex> is the test's own capture, not part of
    // the production path.
    let seen: Arc<Mutex<Vec<ClipboardNotice>>> = Arc::new(Mutex::new(Vec::new()));
    let seen_in_hook = Arc::clone(&seen);
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_in_hook = Arc::clone(&calls);

    set_notifier(move |entry| {
        calls_in_hook.fetch_add(1, Ordering::Relaxed);
        seen_in_hook
            .lock()
            .expect("the capture lock is not poisoned")
            .push(ClipboardNotice::from(entry));
    })
    .expect("the notifier installs on a fresh process");

    // A second install is an honest error — never a silent swap of the running hook.
    let second = set_notifier(|_| {});
    assert!(
        second.is_err(),
        "a second notifier install must fail, not replace the first"
    );
    assert!(second.unwrap_err().contains("already installed"));

    // Arm the bus with the buffer the app would manage.
    arm_ingest(Arc::clone(&shared)).expect("the ingest bus arms on a fresh process");
    let second_arm = arm_ingest(Arc::new(GlobalClipboard::new()));
    assert!(
        second_arm.is_err(),
        "a second arm must fail — otherwise container copies could land in the wrong buffer"
    );
    assert!(second_arm.unwrap_err().contains("already armed"));

    // A real container copy (the JNI upcall's payload) is ingested…
    assert!(
        ingest_native_text("android:container", "copied-in-wechat"),
        "an armed bus ingests a real container copy"
    );
    assert_eq!(
        shared.latest_text().as_deref(),
        Some("copied-in-wechat"),
        "the shared buffer now holds the container copy"
    );

    // …and the UI learned about it through a metadata-only notice.
    assert_eq!(calls.load(Ordering::Relaxed), 1, "exactly one announce");
    let notices = seen.lock().expect("capture lock");
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].seq, 1);
    assert_eq!(notices[0].source, "android:container");
    let json = serde_json::to_value(&notices[0]).expect("notice serialises");
    let obj = json.as_object().expect("object");
    assert_eq!(
        obj.len(),
        3,
        "the notice carries only seq/timestamp_ms/source"
    );
    assert!(
        !obj.contains_key("payload") && !obj.contains_key("text"),
        "the container copy's content must never be broadcast"
    );

    // A blank container copy is refused rather than ingesting an empty entry that would make a
    // foreground app paste nothing where it expected text.
    assert!(
        !ingest_native_text("android:container", "   "),
        "a blank copy is not a real copy"
    );
    assert_eq!(
        calls.load(Ordering::Relaxed),
        1,
        "no announce for the refusal"
    );
}
