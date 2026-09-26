//! Android **system IME** glue — the JNI trampolines behind the Kotlin
//! `com.amos.ai.glue.AmosImeService : InputMethodService` (feature `android`;
//! REQ-A1893).
//!
//! Why this module exists: until it did, `amos-ime` had exactly **one** exit — the
//! System UI's own WebView (`crate::ime`'s `ime_*` commands + `ImeOverlay.svelte`).
//! The repository had no `InputMethodService` anywhere, so no Android app on the
//! device (a legacy app in the container, or any app on the no-UI Android base,
//! `docs/no-ui-android.md`) could select the pinyin keyboard: "typing Chinese" only
//! worked inside AmOS's own WebView. This is the missing half — the platform
//! binding that makes the same engine reachable from **any** app.
//!
//! ```text
//! Android app ─► InputMethodManager ─► AmosImeService (System UI APK, same process)
//!                                          │ on-screen keys
//!                                          ▼
//!                     Java_..._AmosImeService_native*  (this module)
//!                                          ▼
//!                                   crate::ime::ImeBridge   ← the *same* instance the
//!                                          ▼                  WebView keyboard drives
//!                                   amos-ime::PinyinInput
//! ```
//!
//! **One engine, one learner, two surfaces.** The service does not own an engine of
//! its own: [`crate::ime::install_shared`] publishes the WebView keyboard's bridge
//! process-wide and every trampoline here drives that instance with the fixed
//! pseudo-window [`crate::ime::ANDROID_WINDOW`]. So a word taught in WeChat ranks
//! first in AmOS's Notes app and vice versa, there is one `amos-ime.json`, and the
//! per-window buffer rule (REQ-A258) keeps the service's half-typed code from
//! leaking into a WebView window. If the platform binds the service *before* the
//! Activity ever booted, [`crate::ime::shared_or_boot`] lazily boots a bridge from
//! the profile path Kotlin passes (its `filesDir`) — an honest fallback, logged,
//! never a panic.
//!
//! **The wire format is not JSON on purpose.** Android ships `org.json`, but the
//! glue's pure helpers must stay host-JVM testable (there is no `org.json` on a
//! plain JVM), so state crosses as newline-separated, tab-separated records with
//! `\\`/`\t`/`\n` escaped — parsed by `ImeWire.kt`. [`encode_state`] is a pure
//! function, unit-tested here; the Kotlin parser is tested by `ImeWireTest.kt`.
//!
//! Honest boundary: everything here is compile-verified on the host
//! (`cargo check --features android`) and exercised by the Kotlin half's tests, but
//! the end-to-end "select AmOS 输入法 in Android Settings and type in a third-party
//! app" is a **device verification item** (`docs/input-method.md` §System IME).

use std::path::Path;

use jni::objects::JString;
use jni::sys::{jint, jobject, jstring};

/// The JVM-supplied `JNIEnv*` — a pointer **to** the env pointer, exactly as the
/// JNI ABI passes it (the other glue modules spell this `*mut jni::sys::JNIEnv`).
type RawJniEnv = *mut jni::sys::JNIEnv;

use crate::ime::{self, ImeBridge, ImeStateOut, ANDROID_WINDOW, MAX_KEY_CHARS};

/// Column separator inside one wire record.
const FIELD: char = '\t';
/// Record separator.
const RECORD: char = '\n';

/// Escape a field so it can carry tabs, newlines and backslashes through the
/// line-oriented wire format without splitting into extra records.
///
/// Only these three characters need escaping: a pinyin code is ASCII lowercase
/// (`amos-ime` rejects anything else) and a candidate is a dictionary word or a
/// sentence composition, so this is belt-and-braces against a future corpus that
/// contains a newline — but it is exactly the class of silent corruption the
/// format would otherwise hide.
fn escape_field(field: &str) -> String {
    let mut out = String::with_capacity(field.len());
    for ch in field.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            _ => out.push(ch),
        }
    }
    out
}

/// Encode one session state (and, for a commit reply, what was inserted) into the
/// line/tab wire the Kotlin service parses.
///
/// `committed` is `Some(text)` only for a reply to `nativeCommit` that actually
/// inserted something; the record is written **always** (empty when nothing was
/// inserted) so the Kotlin side never has to distinguish "no commit record" from
/// "a commit that inserted nothing" — it reads an empty field as "nothing".
fn encode_state(state: &ImeStateOut, committed: Option<&str>) -> String {
    let mut out = String::new();
    // Scoped so the writing closure's mutable borrow of `out` ends before it is
    // returned.
    {
        let mut record = |name: &str, fields: &[&str]| {
            out.push_str(name);
            for field in fields {
                out.push(FIELD);
                out.push_str(field);
            }
            out.push(RECORD);
        };
        record("input", &[&escape_field(&state.input)]);
        record("composing", &[if state.composing { "1" } else { "0" }]);
        record("strict", &[if state.strict { "1" } else { "0" }]);
        let committed = committed.map_or_else(String::new, escape_field);
        record("commit", &[&committed]);
        // The code of the last **dictionary** commit, while undoing it is possible (empty
        // otherwise): this is what the service's 「忘记「X」」 chip is gated on, and a
        // sentence/suggestion pick carries nothing here because it taught the learner
        // nothing to forget.
        let undo = state
            .last_pick_code
            .as_deref()
            .map_or_else(String::new, escape_field);
        record("undo", &[&undo]);
        for candidate in &state.candidates {
            record(
                "cand",
                &[
                    &escape_field(&candidate.kind),
                    &escape_field(&candidate.text),
                ],
            );
        }
    }
    out
}

/// The bridge every trampoline drives: the shared one when the System UI installed
/// it, else a lazily booted fallback (in memory — the service's `nativeAttach`
/// supplies the profile path).
fn bridge() -> ImeBridge {
    ime::shared_or_boot(None)
}

/// Run `f` with a typed `JNIEnv`, then hand its `String` back to the JVM as a
/// `jstring`.
///
/// Returns a null `jstring` on any JNI failure — the Kotlin side reads null as
/// "the engine is unavailable" and degrades to literal English typing rather than
/// offering a Chinese keyboard that swallows every letter (the same rule the
/// WebView overlay follows).
unsafe fn reply(env: RawJniEnv, f: impl FnOnce(&mut jni::JNIEnv) -> String) -> jstring {
    if env.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call, valid for its
    // duration; the typed wrapper borrows it only inside this function.
    let Ok(mut env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
        return std::ptr::null_mut();
    };
    let answer = f(&mut env);
    match env.new_string(answer) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Read a Java `String` argument into an owned Rust `String`.
fn read_arg(env: &mut jni::JNIEnv, arg: jstring) -> Option<String> {
    if arg.is_null() {
        return None;
    }
    // SAFETY: the JVM guarantees `arg` is a live local ref for this call.
    let s = unsafe { JString::from_raw(arg) };
    env.get_string(&s).ok().map(Into::into)
}

/// The current state, as a wire reply. Shared by the error/degrade paths below so
/// every trampoline answers *something* parseable.
fn state_reply(bridge: &ImeBridge) -> String {
    encode_state(&bridge.snapshot(ANDROID_WINDOW), None)
}

/// `AmosImeService.nativeAttach(filesDir)` — bind the service to the shared engine.
///
/// `filesDir` is the app's files directory (`Context#getFilesDir()`), i.e. the same
/// directory the Tauri side joins as `app_data_dir()/files` (`lib.rs`), so the
/// fallback bridge reads and writes the **same** `amos-ime.json` the WebView
/// keyboard uses. When the System UI already installed the shared bridge, the path
/// is ignored (the shared instance is authoritative) — this call is then just a
/// liveness probe.
///
/// # Safety
/// Standard JNI instance-method args of `AmosImeService.nativeAttach(filesDir)`;
/// `files_dir` is a live java.lang.String local ref for the duration of the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_AmosImeService_nativeAttach(
    env: RawJniEnv,
    _this: jobject,
    files_dir: jstring,
) {
    if env.is_null() {
        return;
    }
    // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
    let Ok(mut env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
        return;
    };
    let Some(dir) = read_arg(&mut env, files_dir) else {
        tracing::warn!(
            target: "amos::ime",
            "android system IME attach got no files dir — learning will not persist"
        );
        return;
    };
    let bridge = ime::shared_or_boot(Some(ime::file_in(Path::new(&dir))));
    let state = bridge.snapshot(ANDROID_WINDOW);
    tracing::info!(
        target: "amos::ime",
        dict_entries = state.dict_entries,
        pins = state.learned_pins,
        "android system IME attached to the pinyin engine"
    );
}

/// `AmosImeService.nativeState()` — the current composition + candidates.
///
/// # Safety
/// Standard JNI instance-method args, no local refs are read.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_AmosImeService_nativeState(
    env: RawJniEnv,
    _this: jobject,
) -> jstring {
    // SAFETY: standard JNI instance-method args; no local refs are read here.
    unsafe { reply(env, |_env| state_reply(&bridge())) }
}

/// `AmosImeService.nativeKey(ch)` — feed one key's characters into the buffer.
///
/// Only ASCII letters compose, but the argument is a Java `String`, so it is
/// bounded exactly as the `ime_key` command is: a paste or a runaway key handler
/// must not make the engine iterate a multi-megabyte payload. An over-long payload
/// is **dropped** (the buffer is left intact) and the current state is returned.
///
/// # Safety
/// Standard JNI instance-method args of `AmosImeService.nativeKey(ch)`; `ch` is a
/// live java.lang.String local ref for the duration of the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_AmosImeService_nativeKey(
    env: RawJniEnv,
    _this: jobject,
    ch: jstring,
) -> jstring {
    // SAFETY: standard JNI instance-method args.
    unsafe {
        reply(env, |env| {
            let bridge = bridge();
            let Some(ch) = read_arg(env, ch) else {
                return state_reply(&bridge);
            };
            if ch.len() > MAX_KEY_CHARS {
                tracing::warn!(
                    target: "amos::ime",
                    len = ch.len(),
                    max = MAX_KEY_CHARS,
                    "android system IME key payload dropped (too long)"
                );
                return state_reply(&bridge);
            }
            encode_state(&bridge.key(ANDROID_WINDOW, &ch), None)
        })
    }
}

/// `AmosImeService.nativeBackspace()` — delete the last buffered pinyin letter.
///
/// # Safety
/// Standard JNI instance-method args, no local refs are read.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_AmosImeService_nativeBackspace(
    env: RawJniEnv,
    _this: jobject,
) -> jstring {
    // SAFETY: standard JNI instance-method args.
    unsafe {
        reply(env, |_env| {
            encode_state(&bridge().backspace(ANDROID_WINDOW), None)
        })
    }
}

/// `AmosImeService.nativeClear()` — abandon the in-flight composition.
///
/// # Safety
/// Standard JNI instance-method args, no local refs are read.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_AmosImeService_nativeClear(
    env: RawJniEnv,
    _this: jobject,
) -> jstring {
    // SAFETY: standard JNI instance-method args.
    unsafe {
        reply(env, |_env| {
            encode_state(&bridge().clear(ANDROID_WINDOW), None)
        })
    }
}

/// `AmosImeService.nativeCommit(index)` — pick candidate `index`; the reply's
/// `commit` record carries the text to insert (empty when the index was out of
/// range, so nothing is inserted).
///
/// # Safety
/// Standard JNI instance-method args of `AmosImeService.nativeCommit(index)`;
/// `index` is a plain integer and no local refs are read.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_AmosImeService_nativeCommit(
    env: RawJniEnv,
    _this: jobject,
    index: jint,
) -> jstring {
    // SAFETY: standard JNI instance-method args; `index` is a plain integer.
    unsafe {
        reply(env, |_env| {
            let bridge = bridge();
            if index < 0 {
                return state_reply(&bridge);
            }
            let out = bridge.commit(ANDROID_WINDOW, index as usize);
            encode_state(&out.state, out.committed.as_deref())
        })
    }
}

/// `AmosImeService.nativeFuzzyPreset(preset)` — apply `"strict"` / `"permissive"`.
///
/// Device-wide (the preference is shared) and reported, never silent: an unknown
/// preset returns the unchanged state rather than pretending it applied.
///
/// # Safety
/// Standard JNI instance-method args of `AmosImeService.nativeFuzzyPreset(preset)`;
/// `preset` is a live java.lang.String local ref for the duration of the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_AmosImeService_nativeFuzzyPreset(
    env: RawJniEnv,
    _this: jobject,
    preset: jstring,
) -> jstring {
    // SAFETY: standard JNI instance-method args.
    unsafe {
        reply(env, |env| {
            let bridge = bridge();
            let Some(preset) = read_arg(env, preset) else {
                return state_reply(&bridge);
            };
            match bridge.fuzzy_preset(ANDROID_WINDOW, &preset) {
                Ok(state) => encode_state(&state, None),
                Err(e) => {
                    tracing::warn!(
                        target: "amos::ime",
                        preset = %preset,
                        error = %e,
                        "android system IME fuzzy preset refused"
                    );
                    state_reply(&bridge)
                }
            }
        })
    }
}

/// `AmosImeService.nativeForgetLast()` — undo the just-committed dictionary word
/// (drop its learned pin). The keyboard offers this only while a dictionary pick is
/// the last commit, so a sentence/suggestion pick lands here as a no-op on the
/// learner and only clears the hint.
///
/// # Safety
/// Standard JNI instance-method args, no local refs are read.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_AmosImeService_nativeForgetLast(
    env: RawJniEnv,
    _this: jobject,
) -> jstring {
    // SAFETY: standard JNI instance-method args.
    unsafe {
        reply(env, |_env| {
            encode_state(&bridge().forget_last(ANDROID_WINDOW), None)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(input: &str, composing: bool, candidates: &[(&str, &str)]) -> ImeStateOut {
        ImeStateOut {
            input: input.to_string(),
            candidates: candidates
                .iter()
                .map(|(kind, text)| ime::ImeCandidateOut {
                    text: (*text).to_string(),
                    kind: (*kind).to_string(),
                })
                .collect(),
            composing,
            strict: true,
            fuzzy: amos_ime::FuzzyPrefs::strict(),
            dict_entries: 0,
            learned_pins: 0,
            learned_pending: 0,
            last_committed: None,
            last_pick_code: None,
        }
    }

    /// The escape is the whole reason the format can carry arbitrary text: a
    /// candidate containing a tab must not become a second column, and one
    /// containing a newline must not become a second record. Kotlin's
    /// `ImeWireTest` is the other half of this contract.
    #[test]
    fn escape_field_protects_every_separator() {
        assert_eq!(escape_field("a\tb"), "a\\tb");
        assert_eq!(escape_field("a\nb"), "a\\nb");
        assert_eq!(escape_field("a\\b"), "a\\\\b");
        // Order matters: a literal backslash must not be re-escaped into the
        // escape of a following character.
        assert_eq!(escape_field("\\\t"), "\\\\\\t");
        assert_eq!(escape_field("中国"), "中国", "CJK passes through verbatim");
    }

    #[test]
    fn encode_state_carries_input_flag_and_candidates() {
        let wire = encode_state(
            &state("zhongguo", true, &[("dict", "中国"), ("sentence", "中过")]),
            None,
        );
        assert_eq!(
            wire,
            "input\tzhongguo\ncomposing\t1\nstrict\t1\ncommit\t\nundo\t\ncand\tdict\t中国\ncand\tsentence\t中过\n"
        );
    }

    /// The `undo` record carries the **dictionary** pick's code so the service can offer
    /// 「忘记「X」」 only where forgetting does something; a pick that taught nothing
    /// (here: none at all) writes it empty.
    #[test]
    fn encode_state_carries_the_undoable_code() {
        let mut s = state("", false, &[]);
        s.last_pick_code = Some("zhongguo".to_string());
        assert!(encode_state(&s, None).contains("undo\tzhongguo\n"));
        assert!(encode_state(&state("", false, &[]), None).contains("undo\t\n"));
    }

    /// An empty buffer is still a real answer: the `composing` flag is `0` and the
    /// candidate list is the 联想 suggestions (or empty) — the service must be able
    /// to tell "no composition" from "engine unavailable", and a missing record
    /// would not.
    #[test]
    fn encode_state_reports_an_empty_buffer_honestly() {
        let wire = encode_state(&state("", false, &[]), None);
        assert!(wire.contains("input\t\n"));
        assert!(wire.contains("composing\t0\n"));
        assert!(!wire.contains("cand\t"), "no candidates ⇒ no cand records");
    }

    /// A commit reply carries the inserted text; a non-commit reply writes the
    /// record empty. Both are one parseable shape on the Kotlin side.
    #[test]
    fn encode_state_carries_the_committed_text_when_there_is_one() {
        let wire = encode_state(&state("", false, &[]), Some("中国"));
        assert!(wire.contains("commit\t中国\n"), "{wire}");
        let none = encode_state(&state("", false, &[]), None);
        assert!(none.contains("commit\t\n"), "{none}");
    }

    /// A candidate whose text contains the record separator must survive the round
    /// trip as **one** `cand` record — the failure mode the escape exists to
    /// prevent (a naive split would see two candidates, one of them garbage).
    #[test]
    fn a_candidate_containing_a_newline_stays_one_record() {
        let wire = encode_state(&state("", false, &[("dict", "a\nb")]), None);
        let cand_records = wire
            .lines()
            .filter(|line| line.starts_with("cand\t"))
            .count();
        assert_eq!(cand_records, 1, "{wire}");
        assert!(wire.contains("cand\tdict\ta\\nb\n"), "{wire}");
    }

    /// The 「忘记「X」」 chip's visibility must be gated on the wire's `undo` code
    /// **alone** (REQ-A1896). The service used to *also* require a non-empty candidate
    /// list — but a freshly learned dictionary word is exactly the commit that leaves no
    /// 联想 (`amos-ime::engine::predictions` returns nothing until two words were
    /// committed), so the chip vanished at the one moment there was something to undo.
    /// The Kotlin truth table (`AmosImeServiceTest`) pins the predicate; this pins the
    /// *wiring* so the gate cannot re-grow the extra conjunct.
    #[test]
    fn the_forget_chip_gate_reads_the_undo_code_alone() {
        const KOTLIN: &str =
            include_str!("../android-glue/com/amos/ai/glue/AmosImeService.kt");
        let gate_line = KOTLIN
            .lines()
            .position(|l| l.contains("forgetKey?.visibility"))
            .expect("AmosImeService.kt must assign forgetKey?.visibility");
        let gate_body: String = KOTLIN
            .lines()
            .skip(gate_line)
            .take(2)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            gate_body.contains("forgetChipVisible(snapshot?.undoCode)"),
            "the forget chip must be gated on the undo code via forgetChipVisible, got:\n{gate_body}"
        );
        assert!(
            !gate_body.contains("total > 0"),
            "the forget chip must not fold in a candidate count — a learned word leaves no 联想, got:\n{gate_body}"
        );
        let decl = KOTLIN
            .lines()
            .find(|l| l.contains("fun forgetChipVisible("))
            .expect("AmosImeService.kt must declare forgetChipVisible");
        assert!(
            decl.contains("!undoCode.isNullOrEmpty()"),
            "forgetChipVisible must be exactly `!undoCode.isNullOrEmpty()`, got: {decl}"
        );
    }

    /// The trampolines drive the *shared* bridge under [`ANDROID_WINDOW`]; a key
    /// pressed "by the service" is therefore visible to a `snapshot` on that same
    /// window, and the encoder accepts the real engine's answer.
    #[test]
    fn a_key_through_the_service_window_encodes_real_candidates() {
        let bridge = ImeBridge::boot();
        let state = bridge.key(ANDROID_WINDOW, "ni");
        let wire = encode_state(&state, None);
        assert!(wire.contains("input\tni\n"), "{wire}");
        assert!(wire.contains("composing\t1\n"), "{wire}");
        assert!(wire.contains("cand\t"), "{wire}");
    }
}
