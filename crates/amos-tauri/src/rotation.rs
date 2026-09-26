//! Tauri <-> device-orientation bridge (rotation lock / forced orientation).
//!
//! The touch shell's quick-settings "rotation lock" tile calls `rotation_get` /
//! `rotation_set`. The **decision** — which mode means which Android
//! requested-orientation code — lives in the pure `amos_display::orientation`
//! kernel; this module owns the host half: the durable intent
//! (`amos.rotation`) and the device seam.
//!
//! On Android the seam calls the Kotlin `RotationGlue`, which holds the
//! foreground `Activity` and forwards the code to
//! `Activity#setRequestedOrientation`, through the same `JavaVM` +
//! `amos_jni::attached` shape `alarm_sched` established. Desktop / CI have no
//! display orientation to control: the intent is still stored (so the UI's
//! toggle is real and survives restart) but the platform answer is the honest
//! [`RotationOutcome::HostOnly`] — never rounded up to "applied".
//!
//! REQ-A677 (F-SH-142): the rotation lock's four silent-lie failure modes — a
//! second mode vocabulary / Android-code mapping in the shell, a swallowed
//! `setRequestedOrientation` reported as applied, a desktop host pretending it
//! applied, and a lock lost on restart — are closed by the pure kernel owning the
//! mapping, [`RotationOutcome`] never rounding a refusal up, [`apply_persisted`]
//! replaying at boot, the frontend word list bound to the kernel by test, and the
//! glue's `STATUS_*` words bound to [`rotation_outcome_from_status`] by test.

use amos_display::orientation::{normalize, RotationMode};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::store::SharedStore;

/// Durable store key holding the last committed rotation intent.
pub const ROTATION_KEY: &str = "amos.rotation";

/// What the platform did with a rotation request. Mirrors the
/// `alarm_sched::DeviceOutcome` shape (typed serde enum, `state`/`detail` tags)
/// so the UI branches on a fact rather than a bare boolean; `Unknown` carries
/// the glue's own words and is **never** rounded up to `Applied`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "state", content = "detail")]
pub enum RotationOutcome {
    /// This host has no display orientation to control (desktop / CI): the
    /// intent is stored, nothing is applied.
    HostOnly,
    /// The platform accepted the requested orientation.
    Applied,
    /// The Kotlin glue is not attached yet (boot ordering) — nothing was called.
    Unattached,
    /// The device exposes no foreground Activity to orient.
    Unavailable,
    /// The platform refused the request (e.g. a fixed-orientation Activity).
    Denied,
    /// The glue's own words when they are none of the above — surfaced verbatim.
    Unknown(String),
}

/// Map one `RotationGlue.STATUS_*` word onto the typed outcome.
///
/// Pure, and pinned on both sides: `RotationGlue.kt` spells these words and
/// `rotation_outcome_from_status_parses_the_glue_words` fails if one drifts.
/// An unrecognised string becomes `Unknown(…)` — the honest answer, because a
/// status we cannot classify says nothing about whether the display obeyed.
pub fn rotation_outcome_from_status(status: &str) -> RotationOutcome {
    match status {
        "applied" => RotationOutcome::Applied,
        "unavailable" => RotationOutcome::Unavailable,
        "denied" => RotationOutcome::Denied,
        "" => RotationOutcome::Unknown("the glue answered with an empty status".to_string()),
        other => RotationOutcome::Unknown(other.to_string()),
    }
}

/// The persisted shape — one key, so a hand-edited store stays a shape this
/// module can read (an object whose `mode` is a known key; anything else
/// normalises to `auto`).
#[derive(Serialize)]
struct RotationStore {
    mode: &'static str,
}

/// Whether this platform can actually apply an orientation. `false` on desktop
/// / CI; on Android, true once the Kotlin glue has attached.
pub fn platform_available() -> bool {
    #[cfg(feature = "android")]
    {
        android::attached()
    }
    #[cfg(not(feature = "android"))]
    {
        false
    }
}

/// Apply an orientation on the device, or report honestly that there is none.
#[cfg(feature = "android")]
fn set_orientation(code: i32) -> RotationOutcome {
    android::set_orientation(code)
}

/// Desktop / CI: there is no window-manager orientation here.
#[cfg(not(feature = "android"))]
fn set_orientation(_code: i32) -> RotationOutcome {
    RotationOutcome::HostOnly
}

/// Parse the persisted intent out of `amos.rotation`. Absent / corrupt / an
/// unknown `mode` ⇒ [`RotationMode::Auto`] (the un-locked default): a
/// hand-edited store must never leave the display frozen.
pub fn seed_mode_from_store(raw: Option<&str>) -> RotationMode {
    let mode = raw
        .and_then(|r| serde_json::from_str::<Value>(r).ok())
        .and_then(|v| match v {
            Value::Object(o) => o.get("mode").and_then(Value::as_str).map(str::to_string),
            _ => None,
        });
    normalize(mode.as_deref())
}

/// Answer to `rotation_get`: the stored intent and whether this platform can
/// apply it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotationSnapshot {
    /// The committed mode's wire key (`auto` | `locked` | `portrait` | `landscape`).
    pub mode: String,
    /// Whether the platform can apply an orientation at all (false on desktop).
    pub available: bool,
}

/// Answer to `rotation_set`: the committed mode, whether the platform can apply
/// it, and what it did.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotationApplied {
    pub mode: String,
    pub available: bool,
    /// `HostOnly` on desktop; on a device one of the refusal states when it did
    /// not reach the platform. Never rounded up to "applied".
    pub outcome: RotationOutcome,
}

/// Read the committed rotation intent (and whether this platform can apply it).
#[tauri::command]
pub fn rotation_get(store: State<'_, SharedStore>) -> Result<RotationSnapshot, String> {
    let mode = seed_mode_from_store(store.get(ROTATION_KEY).as_deref());
    Ok(RotationSnapshot {
        mode: mode.key().to_string(),
        available: platform_available(),
    })
}

/// Commit the rotation intent and apply it to the device, returning what the
/// platform did. An unknown mode key is a **refusal**, not a silent default: the
/// UI only ever sends one of the four keys it mirrors, so a fifth means a bug
/// and guessing "auto" could silently unlock a display the user locked.
#[tauri::command]
pub fn rotation_set(
    app: AppHandle,
    store: State<'_, SharedStore>,
    mode: String,
) -> Result<RotationApplied, String> {
    let Some(parsed) = RotationMode::from_key(&mode) else {
        return Err(format!("unknown rotation mode: {mode}"));
    };
    let text =
        serde_json::to_string(&RotationStore { mode: parsed.key() }).map_err(|e| e.to_string())?;
    store.set(&app, ROTATION_KEY, text);
    let outcome = set_orientation(parsed.requested_orientation());
    Ok(RotationApplied {
        mode: parsed.key().to_string(),
        available: platform_available(),
        outcome,
    })
}

/// Re-apply the stored intent once at boot.
///
/// A device `Activity`'s requested orientation does not outlive the process, so
/// a lock the user set must be re-applied after a restart — otherwise the
/// display would silently unlock. Desktop is a no-op (`HostOnly`).
pub fn apply_persisted(store: &SharedStore) {
    let mode = seed_mode_from_store(store.get(ROTATION_KEY).as_deref());
    let outcome = set_orientation(mode.requested_orientation());
    tracing::debug!(target: "amos::rotation", mode = mode.key(), ?outcome, "re-applied the stored rotation intent at boot");
}

/// Android device seam (feature `android`): calls the Kotlin `RotationGlue`,
/// which holds the foreground Activity. Compile-checked under `--features
/// android`, exercised at device time.
#[cfg(feature = "android")]
mod android {
    use super::RotationOutcome;
    use jni::objects::{JValue, JValueOwned};
    use jni::sys::jobject;
    use jni::{JNIEnv, JavaVM};
    use std::sync::OnceLock;

    /// The glue class Rust calls. The package identity behind this string is
    /// checked by `scripts/android-glue-mirror.sh` against `tauri.conf.json`.
    const GLUE_CLASS: &str = "com/amos/ai/glue/RotationGlue";

    /// The process `JavaVM`, captured on the first upcall. The Kotlin glue keeps
    /// the Activity reference itself, so Rust only needs the VM to re-attach the
    /// calling thread for each call.
    static VM: OnceLock<JavaVM> = OnceLock::new();

    /// Whether the glue has attached (so an orientation call could land).
    pub(super) fn attached() -> bool {
        VM.get().is_some()
    }

    /// Clear a pending Java exception left by a failed call, so it cannot escape
    /// into the IPC return path (the rule `alarm_sched` follows).
    fn clear_pending(env: &JNIEnv<'_>) {
        amos_jni::clear_pending(env);
    }

    /// Read the glue's `java.lang.String` answer (one `STATUS_*` word).
    fn status_string(env: &mut JNIEnv<'_>, value: JValueOwned<'_>) -> Result<String, String> {
        let obj = match value {
            JValueOwned::Object(o) => o,
            _ => return Err("the glue answered with a non-object".to_string()),
        };
        if obj.is_null() {
            return Err("the glue answered with null".to_string());
        }
        env.get_string((&obj).into())
            .map(|s| s.into())
            .map_err(|e| format!("the glue's answer was not a string: {e}"))
    }

    /// `RotationGlue.setOrientation(code)` → one `STATUS_*` word.
    pub(super) fn set_orientation(code: i32) -> RotationOutcome {
        let Some(vm) = VM.get() else {
            return RotationOutcome::Unattached;
        };
        let mut env = match amos_jni::attached(vm) {
            Ok(env) => env,
            Err(e) => return RotationOutcome::Unknown(format!("jni attach failed: {e}")),
        };
        let args = [JValue::Int(code)];
        match env.call_static_method(GLUE_CLASS, "setOrientation", "(I)Ljava/lang/String;", &args) {
            Ok(value) => match status_string(&mut env, value) {
                Ok(status) => super::rotation_outcome_from_status(&status),
                Err(reason) => RotationOutcome::Unknown(reason),
            },
            Err(e) => {
                clear_pending(&env);
                RotationOutcome::Unknown(format!("RotationGlue.setOrientation threw: {e}"))
            }
        }
    }

    /// `RotationGlue.attach()` → `Java_com_amos_ai_glue_RotationGlue_attach`.
    ///
    /// # Safety
    /// `env`/`_this` are the standard JNI static-method arguments and must be
    /// valid for the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_RotationGlue_attach(
        env: *mut jni::sys::JNIEnv,
        _this: jobject,
    ) {
        if env.is_null() {
            return; // nothing valid yet: an honest no-op, the intent is stored but not applied
        }
        // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
        let Ok(env) = (unsafe { JNIEnv::from_raw(env) }) else {
            return;
        };
        match env.get_java_vm() {
            Ok(vm) => {
                // Exactly-once; a redundant re-attach (Activity recreated) keeps
                // the first VM.
                let _ = VM.set(vm);
            }
            Err(e) => tracing::debug!("rotation glue attach could not read the JavaVM: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_reads_a_known_mode_and_defaults_the_rest_to_auto() {
        assert_eq!(
            seed_mode_from_store(Some(r#"{"mode":"locked"}"#)),
            RotationMode::Locked
        );
        assert_eq!(
            seed_mode_from_store(Some(r#"{"mode":"landscape","extra":1}"#)),
            RotationMode::Landscape
        );
        // Absent / corrupt / unknown ⇒ auto: never leave the display frozen.
        assert_eq!(seed_mode_from_store(None), RotationMode::Auto);
        assert_eq!(seed_mode_from_store(Some("not json")), RotationMode::Auto);
        assert_eq!(seed_mode_from_store(Some("[1,2,3]")), RotationMode::Auto);
        assert_eq!(
            seed_mode_from_store(Some(r#"{"mode":"sideways"}"#)),
            RotationMode::Auto
        );
        assert_eq!(
            seed_mode_from_store(Some(r#"{"other":"locked"}"#)),
            RotationMode::Auto
        );
    }

    #[test]
    fn rotation_outcome_from_status_parses_the_glue_words() {
        assert_eq!(
            rotation_outcome_from_status("applied"),
            RotationOutcome::Applied
        );
        assert_eq!(
            rotation_outcome_from_status("unavailable"),
            RotationOutcome::Unavailable
        );
        assert_eq!(
            rotation_outcome_from_status("denied"),
            RotationOutcome::Denied
        );
        // Unrecognised / empty is Unknown — never rounded up to applied.
        assert!(matches!(
            rotation_outcome_from_status("surprise"),
            RotationOutcome::Unknown(_)
        ));
        assert!(matches!(
            rotation_outcome_from_status(""),
            RotationOutcome::Unknown(_)
        ));
    }

    /// The Kotlin glue spells the `STATUS_*` words and this host parses them; both
    /// sides carry a comment saying "keep the two in sync" — which is not a gate.
    /// This reads the tracked `RotationGlue.kt` (the compiled source of truth, not the
    /// git-ignored mirror) and binds each `STATUS_*` **name** to the word its own Rust arm
    /// classifies — so a renamed value *and* a swapped pair are both red. (REQ-A818 /
    /// F-TAU-021.)
    ///
    /// The first version of this pin asked `GLUE.contains("= \"applied\"")` — whether the word
    /// is assigned to *some* constant. **Measured**: swapping the values of `STATUS_APPLIED`
    /// and `STATUS_DENIED` left it green, because both words are still assigned, just to the
    /// wrong names. `setRotation` answers with `STATUS_APPLIED` on success, so after that swap a
    /// rotation the device *did* apply reports `Denied` and the user is told "the device
    /// refused to apply that" — silently, with the gate green. That is the defect the sibling
    /// `alarm_sched.rs` pin was fixed for; this is the same predicate one file over
    /// (REQ-A805 / F-TAU-020).
    ///
    /// Deliberately **one-directional**: every word the host classifies need not be one the glue
    /// declares. `host_only` never crosses this boundary — it is the non-Android answer — so a
    /// reverse assertion would be wrong, not stronger.
    #[test]
    fn the_glue_status_words_are_the_ones_the_host_parses() {
        const GLUE: &str = include_str!("../android-glue/com/amos/ai/glue/RotationGlue.kt");
        let code = strip_kotlin_comments(GLUE);

        // Read the *assignment*, not the presence of the word: `const val NAME = "word"`.
        let mut pairs: Vec<(String, String)> = Vec::new();
        for line in code.lines() {
            // Locate the declaration *inside* the line rather than at its start. **Measured**:
            // the inline doc-comment case (`/** … */ const val …`) is handled by the strip
            // above, *not* by this — once the comment is gone, `starts_with` locates it too, so
            // a control that pairs the two proves nothing about this choice. What `find` buys is
            // a declaration that is not first on its line (`; const val …`): there `starts_with`
            // silently drops the constant and the name-set assertion is what catches the loss.
            // A declaration commented *out* is excluded by the strip, also not by this.
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
            pairs.push((name.to_string(), value.trim().trim_matches('"').to_string()));
        }

        let expected: [(&str, RotationOutcome); 3] = [
            ("STATUS_APPLIED", RotationOutcome::Applied),
            ("STATUS_UNAVAILABLE", RotationOutcome::Unavailable),
            ("STATUS_DENIED", RotationOutcome::Denied),
        ];

        let names: Vec<&str> = pairs.iter().map(|(n, _)| n.as_str()).collect();
        let expected_names: Vec<&str> = expected.iter().map(|(n, _)| *n).collect();
        assert_eq!(
            names, expected_names,
            "the glue's STATUS_* constant set changed — the host must be told which word is which"
        );

        for (name, outcome) in &expected {
            let word = pairs
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, w)| w.as_str())
                .unwrap_or_else(|| panic!("{name} disappeared between the two reads"));
            let classified = rotation_outcome_from_status(word);
            assert_eq!(
                classified, *outcome,
                "RotationGlue.kt's {name} holds {word:?}, which the host reads as {classified:?} \
                 — but the glue returns {name} to report {outcome:?}, so the UI would say the \
                 wrong thing about a rotation the device did apply"
            );
        }
    }

    /// Strip Kotlin block and line comments, leaving string literals intact — so the file's own
    /// prose (which exists to *describe* the rule) cannot answer a question about the code.
    ///
    /// A `//` inside a string literal is not a comment; that is what makes this a character
    /// machine rather than a `find("//")`.
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

    /// The stripper is itself two-sided: the prose copy of a constant must go, the real one must
    /// survive, and a `//` inside a string literal must not be taken for a comment.
    #[test]
    fn strip_kotlin_comments_keeps_assignments_and_drops_prose() {
        let src = "\
    /** `const val STATUS_APPLIED = \"applied\"` is the success word. */\n\
    // const val STATUS_GONE = \"applied\"\n\
    const val STATUS_APPLIED = \"applied\"\n\
    const val STATUS_ODD = \"a//b\"\n";
        let code = strip_kotlin_comments(src);
        assert!(
            !code.contains("STATUS_GONE"),
            "a commented-out constant must not be read as a declaration"
        );
        assert_eq!(
            code.matches("\"applied\"").count(),
            1,
            "only the real assignment may still spell the word"
        );
        assert!(
            code.contains("\"a//b\""),
            "a // inside a string literal is not a comment"
        );
    }

    #[test]
    fn the_outcome_wire_shape_is_the_tagged_enum() {
        // The UI branches on `state`; a rename here is a wire break.
        let applied = serde_json::to_value(RotationOutcome::Applied).unwrap();
        assert_eq!(applied, serde_json::json!({"state": "applied"}));
        let host_only = serde_json::to_value(RotationOutcome::HostOnly).unwrap();
        assert_eq!(host_only, serde_json::json!({"state": "host_only"}));
        let unknown = serde_json::to_value(RotationOutcome::Unknown("boom".into())).unwrap();
        assert_eq!(
            unknown,
            serde_json::json!({"state": "unknown", "detail": "boom"})
        );
    }

    #[test]
    fn the_snapshot_and_applied_payloads_are_camel_case() {
        let snap = serde_json::to_value(RotationSnapshot {
            mode: "locked".into(),
            available: true,
        })
        .unwrap();
        assert_eq!(
            snap,
            serde_json::json!({"mode": "locked", "available": true})
        );

        let applied = serde_json::to_value(RotationApplied {
            mode: "auto".into(),
            available: false,
            outcome: RotationOutcome::HostOnly,
        })
        .unwrap();
        assert_eq!(
            applied,
            serde_json::json!({"mode": "auto", "available": false, "outcome": {"state": "host_only"}})
        );
    }

    #[test]
    fn rotation_set_refuses_an_unknown_mode_key() {
        // The four keys are the contract; a fifth must not be guessed to auto.
        for m in RotationMode::all() {
            assert!(RotationMode::from_key(m.key()).is_some());
        }
        assert!(RotationMode::from_key("sideways").is_none());
    }

    #[test]
    fn desktop_reports_no_orientation_control() {
        // Without the `android` feature this host has nothing to orient; the
        // honest answer is false, and applying is HostOnly.
        #[cfg(not(feature = "android"))]
        {
            assert!(!platform_available());
            assert_eq!(
                set_orientation(RotationMode::Locked.requested_orientation()),
                RotationOutcome::HostOnly
            );
        }
    }

    #[test]
    fn the_stored_intent_is_a_single_mode_key() {
        let text = serde_json::to_string(&RotationStore {
            mode: RotationMode::Portrait.key(),
        })
        .unwrap();
        assert_eq!(text, r#"{"mode":"portrait"}"#);
        // Round-trips back through the reader.
        assert_eq!(seed_mode_from_store(Some(&text)), RotationMode::Portrait);
    }
}
