//! Tauri <-> TTS bridge.
//!
//! Exposes `tts_synthesize`, so the WebView can synthesize translated text to
//! playable audio (Web Audio API) — completing the speech loop for the
//! interpretation app. The backend is a managed [`TtsProvider`]: the
//! deterministic mock by default, or a **local Piper voice** behind the
//! `piper-tts` feature when `AMOS_PIPER_MODEL_DIR` points at a voice dir.

use std::sync::Arc;

use amos_int::language::{Language, MAX_LANG_TAG_BYTES};
#[cfg(feature = "piper-tts")]
use amos_tts::PiperProvider;
use amos_tts::{MockTtsProvider, TtsProvider};
use serde::Serialize;
#[cfg(feature = "piper-tts")]
use std::path::PathBuf;

/// The environment variable naming the provisioned Piper voice directory.
#[cfg(feature = "piper-tts")]
const PIPER_MODEL_DIR_ENV: &str = "AMOS_PIPER_MODEL_DIR";

/// Read the Piper voice directory from `AMOS_PIPER_MODEL_DIR`.
///
/// `std::env::var(..).ok()` folds **never set** together with **set but not
/// valid Unicode** into one silent `None`. The first is the ordinary "no local
/// voice, use the mock" case; the second is a configured-but-unreadable knob,
/// which must be visible or the operator sees the mock and no reason why. So the
/// two are kept apart: a non-Unicode value warns and is still treated as unset.
///
/// Pure (the raw `OsString` is injected) so the non-Unicode arm is reachable in a
/// test, where a process can only hold one value per key at a time.
///
/// REQ-A1963 ∕ F-SH-949.
#[cfg(feature = "piper-tts")]
fn piper_dir_hint(raw: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let os = raw?;
    match os.to_str() {
        Some(text) => Some(PathBuf::from(text)),
        None => {
            tracing::warn!(
                env = PIPER_MODEL_DIR_ENV,
                "Piper voice directory is set but not valid Unicode; treating it as unset \
                 and using the mock voice"
            );
            None
        }
    }
}

/// Serializable synthesis result for the WebView.
#[derive(Clone, Debug, Serialize)]
pub struct TtsAudioPayload {
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
}

/// Maximum bytes in a TTS text input handed in via `tts_synthesize`.
///
/// Real TTS inputs are one utterance / one translated sentence (≤ 2 KiB). A
/// 32 KiB cap mirrors `MAX_INTERPRET_TEXT_BYTES` (and `MAX_TRANSLATE_TEXT_BYTES`,
/// the same one-utterance bound) and keeps a single TTS call bounded by a
/// sensible upper bound (Piper / onnx memory is per-phoneme; a paste-sized text
/// input would tip past seconds of audio and balloon the response payload sent
/// to the WebView).
///
/// It is deliberately **8× below** `MAX_AI_PROMPT_BYTES` (256 KiB): a prompt /
/// context is a different beast from one utterance, so this cap does **not**
/// track the prompt cap. The earlier wording named the 256 KiB prompt cap as a
/// "mirror", which was simply false — nothing bound it, so the sentence could
/// only ever mislead a reader into 8×-ing the TTS bound. The true relations are
/// now enforced by `the_text_caps_that_claim_to_mirror_each_other_agree`
/// (REQ-A738 / F-SH-195).
pub const MAX_TTS_TEXT_BYTES: usize = 32 << 10;

/// App-managed TTS backend.
pub struct TtsBridge {
    provider: Arc<dyn TtsProvider>,
}

impl Default for TtsBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl TtsBridge {
    pub fn new() -> Self {
        Self {
            provider: Self::select_provider(),
        }
    }

    /// Choose the default provider: a local Piper voice when the `piper-tts`
    /// feature is enabled and `AMOS_PIPER_MODEL_DIR` is configured; otherwise
    /// the deterministic mock (App behavior unchanged when Piper isn't set up).
    fn select_provider() -> Arc<dyn TtsProvider> {
        #[cfg(feature = "piper-tts")]
        if let Some(p) = Self::local_piper_provider() {
            return p;
        }
        Arc::new(MockTtsProvider::default())
    }

    /// Load a local Piper voice from `AMOS_PIPER_MODEL_DIR`. The directory holds
    /// a provisioned voice — a `<stem>.onnx` + `<stem>.onnx.json` pair whose stem
    /// [`amos_tts::VOICE_STEMS`] accepts. That list is the same one
    /// `scripts/fetch-models.sh` provisions (bound by
    /// `amos_tts::voice::tests::the_provisioned_voice_is_one_we_accept`), so a
    /// fetched voice is never silently ignored and the loader can't drift from
    /// the provisioner (REQ-A750 / F-SH-207). Returns `None` when no complete
    /// voice is present or loading fails, so the caller keeps the mock.
    #[cfg(feature = "piper-tts")]
    fn local_piper_provider() -> Option<Arc<dyn TtsProvider>> {
        let dir = piper_dir_hint(std::env::var_os(PIPER_MODEL_DIR_ENV))?;
        let (onnx, voice) = amos_tts::resolve_voice(&dir)?;
        match PiperProvider::new(onnx, voice) {
            Ok(p) => {
                tracing::info!("tts: using local Piper voice from {}", dir.display());
                Some(Arc::new(p) as Arc<dyn TtsProvider>)
            }
            Err(e) => {
                tracing::warn!("tts: Piper model load failed ({e}); falling back to mock");
                None
            }
        }
    }

    /// Swap the backend (e.g. a Piper provider), for tests/advanced use.
    pub fn with_provider(mut self, provider: Arc<dyn TtsProvider>) -> Self {
        self.provider = provider;
        self
    }
}

/// Synthesize `text` to PCM audio via the managed TTS provider.
#[tauri::command]
pub async fn tts_synthesize(
    state: tauri::State<'_, TtsBridge>,
    text: String,
    lang: Option<String>,
) -> Result<TtsAudioPayload, String> {
    if text.len() > MAX_TTS_TEXT_BYTES {
        return Err(format!(
            "tts text too long: {} bytes (max {MAX_TTS_TEXT_BYTES})",
            text.len()
        ));
    }
    let lang_raw = lang.unwrap_or_else(|| "zh".to_string());
    if lang_raw.len() > MAX_LANG_TAG_BYTES {
        return Err(format!(
            "tts lang too long: {} bytes (max {MAX_LANG_TAG_BYTES})",
            lang_raw.len()
        ));
    }
    let lang = Language::new(lang_raw);
    let audio = state
        .provider
        .synthesize(&text, &lang)
        .await
        .map_err(|e| e.to_string())?;
    Ok(TtsAudioPayload {
        sample_rate: audio.sample_rate,
        channels: audio.channels,
        samples: audio.samples,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_synthesize_returns_playable_payload() {
        let bridge = TtsBridge::new();
        // Call the provider directly (command requires a Tauri AppHandle).
        let audio = bridge
            .provider
            .synthesize("你好", &Language::new("zh"))
            .await
            .unwrap();
        let payload = TtsAudioPayload {
            sample_rate: audio.sample_rate,
            channels: audio.channels,
            samples: audio.samples,
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["sample_rate"], 16000);
        assert_eq!(json["channels"], 1);
        assert!(json["samples"].is_array());
    }

    /// With the `piper-tts` feature, an unset/misconfigured model directory must
    /// keep the deterministic mock backend (App behavior unchanged).
    #[cfg(feature = "piper-tts")]
    #[test]
    fn falls_back_to_mock_without_piper_dir() {
        std::env::set_var("AMOS_PIPER_MODEL_DIR", "/nonexistent-amos-piper");
        let bridge = TtsBridge::new();
        assert_eq!(
            bridge.provider.name(),
            "mock-tts",
            "no models => mock backend"
        );
    }

    /// Runtime proof that `tts_synthesize` uses a real local Piper voice when
    /// `AMOS_PIPER_MODEL_DIR` points at a downloaded voice dir (loads the model,
    /// so it needs `models/` on disk). Ignored by default — run it alone with
    /// `cargo test -p amos-tauri --features piper-tts piper_voice -- --ignored`
    /// and the env var exported, so it doesn't race the mock tests.
    #[cfg(feature = "piper-tts")]
    #[tokio::test]
    #[ignore = "requires AMOS_PIPER_MODEL_DIR with a downloaded Piper voice"]
    async fn piper_voice_loads_when_configured() {
        let _ = std::env::var("AMOS_PIPER_MODEL_DIR").expect(
            "export AMOS_PIPER_MODEL_DIR=.../models/piper-en_US-lessac-medium for this test",
        );
        let bridge = TtsBridge::new();
        assert_eq!(
            bridge.provider.name(),
            "piper",
            "configured Piper dir => Piper backend"
        );
        // And it actually synthesizes real PCM.
        let audio = bridge
            .provider
            .synthesize("hello", &Language::new("en"))
            .await
            .expect("piper synthesize");
        assert!(!audio.samples.is_empty(), "Piper produced non-empty audio");
    }

    /// The 32 KiB text caps across the bridge **declare** that they mirror one
    /// another, but only in prose: `tts.rs` "mirrors `MAX_INTERPRET_TEXT_BYTES`",
    /// `translate.rs` "matches `MAX_INTERPRET_TEXT_BYTES`", and `wm.rs` promises to
    /// keep the merged AI prompt "well under `MAX_AI_PROMPT_BYTES`". Nothing bound
    /// any of them, so a rename/relaxation on one side would drift silently (all
    /// values are individually legal — no panic, just a bigger/smaller bound than
    /// the comment claims). `tts.rs` even named the 256 KiB *prompt* cap as a
    /// "mirror" — already false by 8×. This table binds the claimed relations
    /// (REQ-A738 / F-SH-195).
    #[test]
    fn the_text_caps_that_claim_to_mirror_each_other_agree() {
        use crate::ai_bridge::MAX_AI_PROMPT_BYTES;
        use crate::interpret::MAX_INTERPRET_TEXT_BYTES;
        use crate::translate::MAX_TRANSLATE_TEXT_BYTES;
        use crate::wm::MAX_CONTEXT_TEXT_BYTES;

        // Self-pin: the cap the doc advertises is actually 32 KiB.
        assert_eq!(MAX_TTS_TEXT_BYTES, 32 << 10);

        // "mirrors `MAX_INTERPRET_TEXT_BYTES`" (tts.rs) and "matches
        // `MAX_INTERPRET_TEXT_BYTES`" (translate.rs): both are the *same* bound.
        assert_eq!(MAX_TTS_TEXT_BYTES, MAX_INTERPRET_TEXT_BYTES);
        assert_eq!(MAX_TRANSLATE_TEXT_BYTES, MAX_INTERPRET_TEXT_BYTES);

        // The corrected tts doc claims the cap is deliberately 8× below the AI
        // prompt cap (one utterance, not a prompt) — enforce the exact ratio, so
        // the sentence stays true if either side moves.
        assert_eq!(
            MAX_TTS_TEXT_BYTES * 8,
            MAX_AI_PROMPT_BYTES,
            "the TTS cap is documented as 8x below the AI prompt cap"
        );

        // `wm.rs` claims only an inequality — the merged system-selection context
        // stays "well under" the prompt cap, not equal to it. A const block so the
        // relation is checked at compile time (clippy: assertions_on_constants).
        const {
            assert!(
                MAX_CONTEXT_TEXT_BYTES < MAX_AI_PROMPT_BYTES,
                "the system-context text cap must stay under the AI prompt cap"
            );
        }
    }

    /// A value that is set but is not valid Unicode — the third state
    /// `std::env::var(..).ok()` folds into "unset".
    #[cfg(all(feature = "piper-tts", unix))]
    fn non_unicode_hint() -> std::ffi::OsString {
        use std::os::unix::ffi::OsStringExt;
        std::ffi::OsString::from_vec(vec![b'p', b'i', 0xff, 0xfe])
    }

    /// Counts WARN events, so an assertion is on the *observable* diagnostic and
    /// not on a re-statement of the code. Mirrors `wm.rs::WarnProbe`.
    #[cfg(feature = "piper-tts")]
    struct WarnProbe(std::sync::Arc<std::sync::atomic::AtomicU64>);
    #[cfg(feature = "piper-tts")]
    impl tracing::Subscriber for WarnProbe {
        fn enabled(&self, _m: &tracing::Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _s: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _id: &tracing::span::Id, _r: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _a: &tracing::span::Id, _b: &tracing::span::Id) {}
        fn event(&self, ev: &tracing::Event<'_>) {
            if ev.metadata().level() == &tracing::Level::WARN {
                self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
        fn enter(&self, _id: &tracing::span::Id) {}
        fn exit(&self, _id: &tracing::span::Id) {}
    }

    /// Run `f` under a WARN probe and report its result plus how many WARNs it made.
    #[cfg(feature = "piper-tts")]
    fn warns_of<T>(f: impl FnOnce() -> T) -> (T, u64) {
        let warns = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let out = {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            f()
        };
        (out, warns.load(std::sync::atomic::Ordering::Relaxed))
    }

    /// REQ-A1963 ∕ F-SH-949: the reader used `std::env::var(..).ok()`, which folds
    /// **never set** together with **set but not valid Unicode**. The first is the
    /// ordinary "no local voice, use the mock" case; the second is a
    /// configured-but-unreadable `AMOS_PIPER_MODEL_DIR`, which must not be
    /// silently ignored — the sibling `Piper model load failed` arm already warns.
    #[test]
    #[cfg(all(feature = "piper-tts", unix))]
    fn a_non_unicode_piper_dir_is_reported_not_read_as_unset() {
        let (dir, warns) = warns_of(|| piper_dir_hint(Some(non_unicode_hint())));
        assert_eq!(
            dir, None,
            "an unreadable directory cannot name a voice; the mock applies"
        );
        assert_eq!(
            warns, 1,
            "a configured-but-unreadable knob must be visible — the fold to `unset` was silent"
        );
    }

    /// The other arm of the same rule: a genuinely unset variable is the silent case.
    #[test]
    #[cfg(feature = "piper-tts")]
    fn an_unset_piper_dir_stays_silent() {
        let (dir, warns) = warns_of(|| piper_dir_hint(None));
        assert_eq!(dir, None);
        assert_eq!(warns, 0, "an unset variable is not a finding");
    }

    /// A value that *is* valid Unicode is passed through untouched — even one that
    /// names a directory with no voice files. That discovery is not this reader's
    /// business (`resolve_voice` returns `None` on its own), and it must not turn
    /// into a warning here.
    #[test]
    #[cfg(feature = "piper-tts")]
    fn a_usable_piper_dir_passes_through_without_a_warning() {
        let (dir, warns) = warns_of(|| piper_dir_hint(Some("/tmp/amos-piper".into())));
        assert_eq!(
            dir.as_deref(),
            Some(std::path::Path::new("/tmp/amos-piper"))
        );
        assert_eq!(warns, 0);
    }
}
