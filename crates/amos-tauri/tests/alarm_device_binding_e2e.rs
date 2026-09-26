//! Cross-boundary contract test for the scheduler alarm device binding (`docs/native-alarm-bridge.md`).
//!
//! The WebView's alarm model reads `scheduler_alarm_register`'s `AlarmArmed.device` to decide
//! whether it may say "this alarm will ring". This test pins the **serialised contract** that
//! crosses the IPC boundary — the tagged device state, the camelCase `atMs`, and the rule that a
//! refusal is never rounded up into a success — plus the in-process ledger behaviour the device
//! half sits on top of.
//!
//! Honest scope: the JNI half (`AlarmGlue.schedule` over `AlarmManager`) needs a real Android VM
//! and is exercised on device, not here. On a host without `AlarmManager` the honest device state
//! is `host_only`, which is what the ledger-side assertions below assume. The unit tests in
//! `alarm_sched.rs` cover the device-seam validation (`epoch-zero`, far-future, ledger rollback,
//! idempotency) with an injected device arm, which this file deliberately does not re-test.

use amos_tauri_lib::alarm_sched::{AlarmArmed, AlarmCanceled, AlarmSchedState, DeviceOutcome};

/// Every device state keeps its own tagged spelling on the wire. A frontend that branched on a
/// bare `true`/`false` could not tell "scheduled" from "exact alarms are disallowed", which is
/// the defect the type exists to remove.
#[test]
fn device_states_are_distinct_tagged_values_never_a_bare_boolean() {
    let cases: [(&str, DeviceOutcome); 6] = [
        ("host_only", DeviceOutcome::HostOnly),
        ("scheduled", DeviceOutcome::Scheduled),
        ("cancelled", DeviceOutcome::Cancelled),
        ("disallowed", DeviceOutcome::Disallowed),
        ("denied", DeviceOutcome::Denied),
        (
            "unknown",
            DeviceOutcome::Unknown("epoch-zero is a possible sentinel".to_string()),
        ),
    ];
    let mut tags = std::collections::HashSet::new();
    for (expected_tag, outcome) in cases {
        let json = serde_json::to_value(&outcome).expect("DeviceOutcome serialises");
        assert!(
            json.is_object(),
            "{expected_tag} must be a tagged object, not a boolean"
        );
        assert_eq!(json["state"], expected_tag);
        assert!(
            tags.insert(expected_tag.to_string()),
            "{expected_tag} tag must be unique"
        );
    }
    // The refusal carries its reason verbatim so the UI can say *why*.
    let json = serde_json::to_value(DeviceOutcome::Unknown("atMs is far in the future".into()))
        .expect("serialises");
    assert_eq!(json["state"], "unknown");
    assert_eq!(json["detail"], "atMs is far in the future");
}

/// The exact JSON shape `scheduler_alarm_register` hands back: camelCase `atMs` (the frontend's
/// own model says `atMs`) and a nested `device` object.
#[test]
fn the_armed_answer_carries_the_instant_and_the_observed_device_state() {
    let armed = AlarmArmed {
        id: "medication-8h".to_string(),
        at_ms: 1_700_000_000_000,
        device: DeviceOutcome::Disallowed,
    };
    let json = serde_json::to_value(&armed).expect("AlarmArmed serialises");
    assert_eq!(json["id"], "medication-8h");
    assert_eq!(json["atMs"], 1_700_000_000_000u64);
    assert_eq!(json["device"]["state"], "disallowed");
    // A refusal must not be representable as a success.
    assert_ne!(json["device"], serde_json::json!("scheduled"));
}

/// `scheduler_alarm_cancel` answers both halves: whether the ledger still held it (the old return
/// value) and what the OS binding did — a cancel that only reached the ledger would leave the
/// alarm armed in `AlarmManager` and ring a phone the user switched off.
#[test]
fn the_cancel_answer_keeps_the_ledger_flag_and_the_device_state_separate() {
    let canceled = AlarmCanceled {
        id: "wake".to_string(),
        was_registered: false,
        device: DeviceOutcome::HostOnly,
    };
    let json = serde_json::to_value(&canceled).expect("AlarmCanceled serialises");
    assert_eq!(json["id"], "wake");
    assert_eq!(json["wasRegistered"], false);
    assert_eq!(json["device"]["state"], "host_only");
}

/// The ledger the device half is layered on: register → poll fires once → cancel removes, and a
/// daily re-arm of an existing id always works (the case that must never fail at capacity).
#[test]
fn the_ledger_registers_polls_and_rearms_a_daily_alarm() {
    let state = AlarmSchedState::new();
    state.register("daily".to_string(), 86_400_000);

    assert_eq!(state.next_at(0), Some(86_400_000));
    assert_eq!(state.poll(86_400_000), vec!["daily".to_string()]);
    // Not re-fired by a later poll.
    assert!(state.poll(86_400_001).is_empty());

    // The caller re-arms the next day; the same id must always be accepted.
    state.register("daily".to_string(), 2 * 86_400_000);
    assert_eq!(state.next_at(86_400_001), Some(2 * 86_400_000));
    assert!(state.contains("daily"));

    assert!(state.cancel("daily"));
    assert!(state.is_empty());
    assert!(!state.cancel("daily"), "a second cancel is honestly false");
}

// ─── REQ-A805 / F-TAU-020: the Kotlin `STATUS_*` binding is *name → word*, not
// "the word occurs somewhere in the file" ───────────────────────────────────────────────
//
// The unit test in `alarm_sched.rs` (`the_glue_status_words_are_pinned_to_the_kotlin_source`)
// pinned the Rust map to the Kotlin source with `KOTLIN.contains("\"word\"")`. That predicate
// asks only whether the literal occurs *anywhere* in the file, and it was measured green under
// two Kotlin-side changes that both make the glue lie (REQ-A805):
//
//   * renaming `STATUS_SCHEDULED = "scheduled"` to `"armed"` — the literal still occurs in the
//     file's own prose at line 45 (`"scheduled" would be a lie.`), so the check held;
//   * swapping the values of `STATUS_SCHEDULED` and `STATUS_DISALLOWED` — every literal is
//     still assigned to *some* constant, so the check held.
//
// Both are the F-ALM-001 lie in one direction or the other: the first turns a real arm into
// `Unknown` (the ledger drops an alarm the OS holds, so the reminder never fires), the second
// reports a refusal as `scheduled` (the ledger *keeps* an alarm the OS refused, so the UI
// promises a wake that will not come). Neither is catchable without reading the **assignment**.

use amos_tauri_lib::alarm_sched::device_outcome_from_status;

/// Strip Kotlin block and line comments, leaving string literals untouched.
///
/// A prose mention of a word is not an assignment, so the prose has to go before the source is
/// read for words. String literals are kept verbatim — including a `//` inside one, which is
/// not a comment.
fn strip_kotlin_comments(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0usize;
    let mut block_depth = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if block_depth > 0 {
            if c == '/' && chars.get(i + 1) == Some(&'*') {
                block_depth += 1;
                i += 2;
            } else if c == '*' && chars.get(i + 1) == Some(&'/') {
                block_depth -= 1;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            block_depth = 1;
            i += 2;
            continue;
        }
        if c == '"' {
            out.push(c);
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    out.push(chars[i]);
                    i += 1;
                }
                out.push(chars[i]);
                i += 1;
            }
            if i < chars.len() {
                out.push(chars[i]);
                i += 1;
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// The stripper is itself two-sided: it must drop a commented-out copy of a word and keep the
/// assigned one, and it must not mistake a `//` inside a string literal for a comment.
#[test]
fn strip_kotlin_comments_keeps_assignments_and_drops_prose() {
    let src = "\
    /** \"scheduled\" would be a lie. */\n\
    // \"cancelled\" too\n\
    const val STATUS_SCHEDULED = \"scheduled\"\n\
    const val STATUS_WEIRD = \"a//b\"\n";
    let code = strip_kotlin_comments(src);
    assert!(
        !code.contains("would be a lie"),
        "the prose copy must be gone, not merely outnumbered"
    );
    assert_eq!(
        code.matches("\"scheduled\"").count(),
        1,
        "only the assignment may still spell the word"
    );
    assert!(
        code.contains("\"a//b\""),
        "a // inside a string literal is not a comment"
    );
}

/// Every Kotlin `STATUS_*` constant must hold the word whose Rust arm is the one its *name*
/// says — and the set of constants must be exactly the five the glue's arm/cancel paths use.
///
/// This is the binding the `contains` predicate did not have: a rename changes which word a
/// constant holds (red), and a swap changes which constant holds which word (red).
#[test]
fn every_kotlin_status_constant_holds_the_word_its_own_rust_arm_classifies() {
    const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AlarmGlue.kt");
    let code = strip_kotlin_comments(KOTLIN);

    let mut pairs: Vec<(String, String)> = Vec::new();
    for line in code.lines() {
        // Locate the declaration *inside* the line rather than at its start, so a same-line
        // doc comment (`/** … */ const val …`) does not hide a real constant. A declaration
        // that is commented *out* is excluded by the strip above, not by this — that is what
        // the strip is for.
        let Some(pos) = line.find("const val ") else {
            continue;
        };
        let Some((name, value)) = line[pos + "const val ".len()..].split_once('=') else {
            continue;
        };
        let name = name.trim();
        if !name.starts_with("STATUS_") {
            continue;
        }
        let word = value.trim().trim_matches('"').to_string();
        pairs.push((name.to_string(), word));
    }

    let expected: [(&str, DeviceOutcome); 5] = [
        ("STATUS_SCHEDULED", DeviceOutcome::Scheduled),
        ("STATUS_CANCELLED", DeviceOutcome::Cancelled),
        ("STATUS_DISALLOWED", DeviceOutcome::Disallowed),
        ("STATUS_UNAVAILABLE", DeviceOutcome::Unavailable),
        ("STATUS_DENIED", DeviceOutcome::Denied),
    ];

    let names: Vec<&str> = pairs.iter().map(|(n, _)| n.as_str()).collect();
    let expected_names: Vec<&str> = expected.iter().map(|(n, _)| *n).collect();
    assert_eq!(
        names, expected_names,
        "the glue's STATUS_* constant set changed — the Rust map must be told which word is which"
    );

    for (name, outcome) in &expected {
        let word = pairs
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, w)| w.as_str())
            .unwrap_or_else(|| panic!("{name} disappeared between the two reads"));
        assert_eq!(
            device_outcome_from_status(word),
            *outcome,
            "AlarmGlue.kt's {name} holds {word:?}, which the Rust map does not read as {outcome:?}"
        );
        assert_ne!(
            device_outcome_from_status(word),
            DeviceOutcome::Unknown(word.to_string()),
            "{word:?} must be a classified state, not Unknown"
        );
    }
}
