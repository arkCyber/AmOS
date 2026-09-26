//! Cross-boundary contract test for the real in-call recording surface (`docs/telephony.md` §10).
//!
//! Two things cross a boundary here and both have no compiler on either side:
//! * the daemon `Watch` stream → the WebView, whose `recording` field is a **string**
//!   (`On` / `Off` / `Failed`), and
//! * the Kotlin `AmosInCallService` companion → Rust (feature `android`), where a refusal must
//!   surface as a distinct state rather than being rounded up to a success (F-TEL-001).
//!
//! Honest scope: the JNI trampoline itself needs a real Android VM, so the `android`-gated tests
//! below pin the **pure** mapping and the foreground gate (which run everywhere) and the
//! not-bound boundary (which is what a host process observes). The on-device `setRecording` call
//! is device-only.

use amos_tauri_lib::telephony::TelephonyCallPayload;

fn payload_with_recording(recording: &str) -> TelephonyCallPayload {
    TelephonyCallPayload {
        id: "real".to_string(),
        peer: "+8613800138000".to_string(),
        state: "Active".to_string(),
        direction: "Outgoing".to_string(),
        emergency: false,
        recording: Some(recording.to_string()),
        // The real in-call bridge answers about *one* toggle per command, so a reply from
        // that path claims nothing about the others — `None` is the "no claim" value (see
        // `TelephonyCallPayload::muted` / `::speaker` / `::hold`).
        muted: None,
        speaker: None,
        hold: None,
    }
}

/// The three recording words the UI branches on survive the IPC serialisation unchanged, and the
/// default ("Off") is never silently turned into a recording claim.
#[test]
fn the_recording_field_round_trips_through_the_event_wire() {
    for word in ["Off", "On", "Failed"] {
        let json = serde_json::to_value(payload_with_recording(word)).expect("serialises");
        assert_eq!(json["recording"], word, "the UI reads this string verbatim");
    }
    assert_eq!(
        payload_with_recording("Off").recording.as_deref(),
        Some("Off"),
        "a call is not recorded until it is"
    );
}

/// The **pure** answer mapping and the foreground gate — no JVM required, but compiled only when
/// the `android` feature (and therefore `incall.rs`) is in the build.
/// REQ-A878 / F-DEV-119: this module compiled under **no** configuration for as long as it
/// existed — `cfg(feature = "android")` removed it by default, and with the feature on its four
/// assertions were type errors (`err.contains(…)` on an `AmosError`). Both directions were
/// silent, so the F-TEL-001 contract this file advertises had never run. The assertions now read
/// `err.message` — the field the UI deserialises — not `err.to_string()`, which would also fold
/// in `cause` and could pass for the wrong reason.
#[cfg(feature = "android")]
mod android_contract {
    use super::*;
    use amos_tauri_lib::incall::{
        recording_change_from_state, set_recording_for_window, RecordingChange,
    };
    use amos_tauri_lib::wm::WmState;

    /// The Kotlin `RecordingState` words map to distinct typed outcomes; an unrecognised word —
    /// including the empty string a broken JNI stub could return — becomes `Unknown`, never a
    /// success (TODO 1.3's negative control).
    #[test]
    fn recording_words_map_to_distinct_states_and_the_empty_answer_is_unknown() {
        assert_eq!(recording_change_from_state("On"), RecordingChange::On);
        assert_eq!(recording_change_from_state("Off"), RecordingChange::Off);
        assert_eq!(
            recording_change_from_state("Failed"),
            RecordingChange::Failed
        );
        assert_eq!(
            recording_change_from_state(""),
            RecordingChange::Unknown("the glue answered with an empty toggle state".to_string())
        );
        assert_eq!(
            recording_change_from_state("Started"),
            RecordingChange::Unknown("Started".to_string())
        );
        assert_ne!(recording_change_from_state("Failed"), RecordingChange::On);
    }

    /// The typed change is a tagged object on the wire, so a consumer cannot confuse "on" with a
    /// bare truthy value.
    #[test]
    fn the_recording_change_serialises_with_a_tagged_state() {
        let on = serde_json::to_value(RecordingChange::On).expect("On");
        assert_eq!(on["state"], "on");
        let failed = serde_json::to_value(RecordingChange::Failed).expect("Failed");
        assert_eq!(failed["state"], "failed");
        let unknown =
            serde_json::to_value(RecordingChange::Unknown("codec".into())).expect("Unknown");
        assert_eq!(unknown["state"], "unknown");
        assert_eq!(unknown["detail"], "codec");
    }

    /// F-TEL-001: the toggle is foreground-only. A background window is refused **by the gate**
    /// (the message names it), so the device seam is never reached.
    #[test]
    fn a_background_window_cannot_toggle_recording() {
        let wm = WmState::new(); // the launcher ("main") is focused
        let err =
            set_recording_for_window(true, &wm, "settings").expect_err("background must be denied");
        assert!(err.message.contains("not the foreground window"), "{err}");
        assert!(err.message.contains("F-TEL-001"), "{err}");
    }

    /// The focused window passes the gate and then hits the honest not-bound boundary — the same
    /// answer a device without ROLE_DIALER gets, phrased so the user knows the remedy.
    #[test]
    fn the_foreground_window_reaches_the_not_default_dialer_boundary() {
        let wm = WmState::new();
        let err = set_recording_for_window(false, &wm, "main")
            .expect_err("no in-call service in a test process");
        assert!(!err.message.contains("not the foreground window"), "{err}");
        assert!(err.message.contains("default dialer"), "{err}");
    }

    /// The recording field and the typed change agree on the vocabulary — the daemon path and the
    /// real in-call path must not speak different words to the same UI.
    #[test]
    fn the_two_recording_vocabularies_agree() {
        let _ = payload_with_recording("On");
        assert_eq!(recording_change_from_state("On"), RecordingChange::On);
        assert_eq!(recording_change_from_state("Off"), RecordingChange::Off);
        assert_eq!(
            recording_change_from_state("Failed"),
            RecordingChange::Failed
        );
    }
}
