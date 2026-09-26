//! The one place that knows which Piper voice files we accept.
//!
//! Piper voices are identified by a **stem** (`en_US-lessac-medium`) paired with
//! two files (`<stem>.onnx` + `<stem>.onnx.json`). The stem appears in several
//! artefacts — the provisioning script that downloads it, the on-device loader
//! that must find it, and the offline harnesses — so the list lives here **once**
//! and every loader resolves through [`resolve_voice`]. `scripts/fetch-models.sh`
//! is the provisioner; if it downloads a stem the loader does not accept, the
//! voice is silently ignored and the backend stays on the deterministic mock
//! (silence) with nothing failing. `the_provisioned_voice_is_one_we_accept` reads
//! the provisioning/harness sources and refuses that drift (REQ-A750 / F-SH-207).

use std::path::{Path, PathBuf};

/// Piper voice stems the loader accepts, in preference order (higher quality
/// first). Must include whatever `scripts/fetch-models.sh` provisions.
pub const VOICE_STEMS: &[&str] = &["en_US-lessac-medium", "en_US-lessac-low"];

/// Find the first provisioned Piper voice in `dir`: the first stem in
/// [`VOICE_STEMS`] that has **both** `<stem>.onnx` and `<stem>.onnx.json`
/// present as files. Returns `None` when `dir` holds no complete voice.
pub fn resolve_voice(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    for stem in VOICE_STEMS {
        let onnx = dir.join(format!("{stem}.onnx"));
        let json = dir.join(format!("{stem}.onnx.json"));
        if onnx.is_file() && json.is_file() {
            return Some((onnx, json));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn unique_dir(tag: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("amos-voice-{tag}-{}-{n}", std::process::id()))
    }

    #[test]
    fn resolve_finds_a_complete_voice_in_preference_order() {
        let dir = unique_dir("resolve");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(resolve_voice(&dir).is_none(), "empty dir has no voice");

        // Only a `low` voice present -> it is chosen even though `medium` ranks first.
        std::fs::write(dir.join("en_US-lessac-low.onnx"), b"m").unwrap();
        std::fs::write(dir.join("en_US-lessac-low.onnx.json"), b"{}").unwrap();
        let (onnx, json) = resolve_voice(&dir).expect("low voice resolves");
        assert!(onnx.ends_with("en_US-lessac-low.onnx"));
        assert!(json.ends_with("en_US-lessac-low.onnx.json"));

        // Add the higher-ranked `medium` -> preference flips to it.
        std::fs::write(dir.join("en_US-lessac-medium.onnx"), b"m").unwrap();
        std::fs::write(dir.join("en_US-lessac-medium.onnx.json"), b"{}").unwrap();
        let (onnx, _) = resolve_voice(&dir).expect("medium voice resolves");
        assert!(onnx.ends_with("en_US-lessac-medium.onnx"));

        // A lone `.onnx` without its `.json` is NOT a voice.
        let half = unique_dir("half");
        let _ = std::fs::remove_dir_all(&half);
        std::fs::create_dir_all(&half).unwrap();
        std::fs::write(half.join("en_US-lessac-medium.onnx"), b"m").unwrap();
        assert!(
            resolve_voice(&half).is_none(),
            "an .onnx without its .onnx.json is not a usable voice"
        );

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&half);
    }

    /// Extract the Piper voice stems named by a source file (the `en_US-…` part
    /// of any `<stem>.onnx` / `<stem>.onnx.json` token), so a script or path can
    /// be checked against the loader.
    fn stems_named_in(text: &str) -> Vec<String> {
        text.split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
            .filter_map(|tok| {
                let stem = &tok[..tok.find(".onnx")?];
                stem.starts_with("en_US-").then(|| stem.to_string())
            })
            .collect()
    }

    /// REQ-A750 (F-SH-207): the provisioner and the loader must agree on the
    /// voice stem. `scripts/fetch-models.sh` downloads the voice; the loader
    /// (`resolve_voice`, used by `amos-tauri` and `PiperProvider`) must accept
    /// it. Today they disagreed — the script fetched `medium`, the loader wanted
    /// `low` — so a provisioned device silently kept the mock (silence). Two
    /// halves: (1) every stem the provisioning/harness sources name must be one
    /// the loader accepts, and (2) the on-device loader must resolve *through*
    /// this list rather than name a voice itself (a hardcode is how it drifted).
    #[test]
    fn the_provisioned_voice_is_one_we_accept() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let read = |rel: &str| -> String {
            std::fs::read_to_string(root.join(rel))
                .unwrap_or_else(|e| panic!("cannot read {rel}: {e}"))
        };

        // Half 1: provisioning + harnesses may only name voices we accept.
        let mut seen = 0usize;
        for rel in [
            "scripts/fetch-models.sh",
            "scripts/e2e-local-models.sh",
            "crates/amos-tts/examples/piper_tts.rs",
        ] {
            for stem in stems_named_in(&read(rel)) {
                seen += 1;
                assert!(
                    VOICE_STEMS.contains(&stem.as_str()),
                    "{rel} names Piper voice `{stem}`, but the loader accepts only {VOICE_STEMS:?} \
                     — a provisioned voice would be silently ignored (mock fallback)"
                );
            }
        }
        assert!(
            seen > 0,
            "expected the provisioning/harness sources to name at least one Piper voice"
        );

        // Half 2: the on-device loader resolves through this list, never naming a
        // stem itself — that hardcode is exactly what drifted from the provisioner.
        let loader = read("crates/amos-tauri/src/tts.rs");
        let named = stems_named_in(&loader);
        assert!(
            named.is_empty(),
            "the TTS loader hardcodes Piper voice(s) {named:?}; it must go through \
             resolve_voice/VOICE_STEMS so it can never disagree with the provisioner"
        );
        assert!(
            loader.contains("resolve_voice("),
            "the TTS loader must resolve its voice through amos_tts::resolve_voice"
        );
    }
}
