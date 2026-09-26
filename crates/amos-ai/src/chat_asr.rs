//! Voice input for the bidi `Chat` stream: a per-connection recognizer that
//! turns incoming `Payload::Audio` frames into a finalized utterance.
//!
//! `amos-ai` speaks the *wire* format for audio as **mono 16 kHz f32 PCM,
//! little-endian** (4 bytes per sample) — the same sample format
//! [`amos_asr::StreamingRecognizer`] expects. When the recognizer signals an
//! utterance end (its endpoint / VAD), [`ChatAsr::feed_audio`] returns the
//! recognized text so the server can enqueue it as a normal prompt. Design:
//! `docs/bidi-voice-asr.md`.
//!
//! Backend is selected by `AMOS_ASR_BACKEND`:
//! * unset (default) — real on-device sherpa from the **model-dir resolution
//!   chain** ([`resolve_sherpa_model_dir`]): `AMOS_SHERPA_MODEL_DIR` (operator
//!   override) → the bundled asset dirs the AOSP image stages → *then* the
//!   deterministic mock, and only ever with an explicit `tracing::error!` naming
//!   the fallback as dev/CI-only. This is the "real ASR by default" production
//!   path; a device image that bundles a model never serves the mock.
//! * `mock` — force the deterministic, offline recognizer (tests / dev).
//! * `sherpa` — real local on-device ASR (sherpa-onnx behind `amos-asr`'s
//!   `sherpa` feature). Requires the `asr-sherpa` feature **and** a resolvable
//!   model dir; if either is missing, returns `None` (honest "not configured")
//!   rather than silently degrading to the mock.
//! * `off` / `none` / `disabled` — disable voice entirely.
//!
//! Honesty contract (Gap 8 / F-ASR-001): the mock is a **dev/CI** engine. It is
//! only ever returned from an *unset* `AMOS_ASR_BACKEND` (the "voice always
//! works" demo path) and it is always accompanied by an `error!` log so an
//! operator reading the daemon log cannot mistake it for real recognition. An
//! explicit `sherpa` request never degrades to the mock.

use amos_asr::{MockStreamingRecognizer, StreamingRecognizer};

/// Upper bound on one inbound audio frame (in 16 kHz samples ≈ 4 bytes each).
/// ~10 seconds @16 kHz is far above any real mic chunk (milliseconds–hundreds of
/// ms), so anything larger is a malformed/malicious client trying to make us
/// allocate an unbounded buffer — dropped before decode, never processed.
const MAX_FRAME_SAMPLES: usize = 160_000;

/// Upper bound on an operator-supplied model-directory path string
/// (`AMOS_SHERPA_MODEL_DIR` / the bundled-asset roots). This is an env seam:
/// bounding it stops a hostile or typo'd multi-megabyte value from becoming an
/// unbounded allocation. A real filesystem path is far below this.
pub const MAX_MODEL_DIR_BYTES: usize = 4096;

/// Bundled sherpa model directories, tried in order after
/// `AMOS_SHERPA_MODEL_DIR` is found unusable. These mirror the locations the
/// AOSP image / operator install stage the model under (see
/// `docs/bidi-voice-asr.md` and `deploy/android/amos.rc`, which points the
/// daemon at `/data/amos/sherpa`).
pub const BUNDLED_SHERPA_DIRS: &[&str] = &["/data/amos/sherpa", "/system/share/amos/sherpa"];

/// Wraps a [`StreamingRecognizer`] for one bidi connection.
pub struct ChatAsr {
    rec: Box<dyn StreamingRecognizer>,
    /// Honest label of the recognizer actually wrapping `rec` ("sherpa",
    /// "mock", …). Surfaced so `get_status` / logs / tests can tell a real
    /// recognizer from the deterministic mock without inspecting internals.
    label: &'static str,
}

impl ChatAsr {
    /// Wrap a recognizer with the generic `"custom"` label. Prefer
    /// [`ChatAsr::with_label`] (or [`ChatAsr::from_env`]) so status reporting
    /// can name the engine truthfully.
    pub fn new(rec: Box<dyn StreamingRecognizer>) -> Self {
        Self::with_label(rec, "custom")
    }

    /// Wrap a recognizer and label it (one of `"sherpa"` / `"mock"` / …).
    pub fn with_label(rec: Box<dyn StreamingRecognizer>, label: &'static str) -> Self {
        Self { rec, label }
    }

    /// The recognizer engine actually in use: `"sherpa"` (real on-device ASR),
    /// `"mock"` (deterministic dev/CI engine), or `"custom"` for an injected
    /// recognizer. Never a claim about a model that was not loaded.
    pub fn backend_label(&self) -> &'static str {
        self.label
    }

    /// Build from the environment. Selects the recognizer backend:
    ///
    /// * `AMOS_ASR_BACKEND=off|none|disabled` → `None` (voice disabled).
    /// * `AMOS_ASR_BACKEND=sherpa` (requires the `asr-sherpa` feature) → real
    ///   local sherpa-onnx streaming recognizer from the resolution chain
    ///   ([`resolve_sherpa_model_dir`]). If the feature or a model dir is missing
    ///   we warn and return `None` so `Payload::Audio` falls back to the honest
    ///   "voice not configured" path instead of silently degrading to the mock.
    /// * `AMOS_ASR_BACKEND=mock` → the deterministic mock.
    /// * unset (or an unrecognised value) → [`Self::default_asr`]: a real
    ///   on-device sherpa recognizer *when the daemon was built with the
    ///   `asr-sherpa` feature and a model dir resolves* (override or bundled);
    ///   otherwise the deterministic mock, with an explicit `error!` log.
    pub fn from_env() -> Option<Self> {
        match std::env::var("AMOS_ASR_BACKEND").as_deref() {
            Ok("off") | Ok("none") | Ok("disabled") => {
                tracing::debug!("voice input disabled (AMOS_ASR_BACKEND)");
                None
            }
            // Explicit real on-device ASR: honest "None" (not mock) when the
            // feature or model files are missing.
            Ok("sherpa") => sherpa_recognizer_from_env(),
            // Explicit deterministic mock (tests / offline / dev).
            Ok("mock") => {
                tracing::info!("voice input: deterministic mock ASR (AMOS_ASR_BACKEND=mock)");
                Some(Self::with_label(Box::new(mock_recognizer()), "mock"))
            }
            // Default: real sherpa when the chain resolves one, else mock.
            _ => Some(Self::default_asr()),
        }
    }

    /// Default recognizer for an *unset* `AMOS_ASR_BACKEND`: a real on-device
    /// sherpa recognizer when the daemon was built with `asr-sherpa` **and** the
    /// model-dir chain resolves one; otherwise (feature off / no model dir /
    /// staged init failure) the deterministic mock — always with an explicit
    /// `error!` log so the fallback can never be mistaken for real recognition
    /// (Gap 8 / F-ASR-001). Never `None`, so unset always yields a working
    /// recognizer for the bidi `Payload::Audio` channel.
    fn default_asr() -> Self {
        #[cfg(feature = "asr-sherpa")]
        {
            if let Some(asr) = sherpa_recognizer_from_env() {
                tracing::info!(
                    engine = asr.backend_label(),
                    "voice input: real on-device sherpa ASR (auto-selected from the model-dir chain)"
                );
                return asr;
            }
            tracing::error!(
                "no real ASR model is staged: AMOS_SHERPA_MODEL_DIR is unset and no bundled \
                 sherpa dir carries tokens.txt (tried {:?}); falling back to the DETERMINISTIC \
                 MOCK recognizer — this is a dev/CI result, NOT real speech recognition. Stage \
                 a model dir or set AMOS_ASR_BACKEND=off to disable voice explicitly.",
                BUNDLED_SHERPA_DIRS
            );
            Self::with_label(Box::new(mock_recognizer()), "mock")
        }
        #[cfg(not(feature = "asr-sherpa"))]
        {
            tracing::error!(
                "amos-ai was built without the `asr-sherpa` feature, so voice input falls back \
                 to the DETERMINISTIC MOCK recognizer — dev/CI only, NOT real speech \
                 recognition. Rebuild with default features (asr-sherpa is on by default) or set \
                 AMOS_ASR_BACKEND=off."
            );
            Self::with_label(Box::new(mock_recognizer()), "mock")
        }
    }

    /// Feed one PCM frame (mono 16 kHz f32, little-endian) and return the
    /// finalized utterance text if the recognizer reached its endpoint (the
    /// recognizer is then reset, ready for the next utterance).
    pub fn feed_audio(&mut self, bytes: &[u8]) -> Option<String> {
        // Bound the untrusted wire frame *before* allocating/decode: an oversized
        // or corrupt frame must not make us allocate a huge buffer (memory DoS).
        if bytes.len() / 4 > MAX_FRAME_SAMPLES {
            tracing::warn!(
                "dropping oversized audio frame ({} samples > cap {MAX_FRAME_SAMPLES})",
                bytes.len() / 4
            );
            return None;
        }
        let samples = decode_f32_le(bytes);
        if samples.is_empty() {
            return None;
        }
        self.feed_samples(&samples)
    }

    /// Feed decoded samples; exposed for tests and non-wire callers.
    pub fn feed_samples(&mut self, samples: &[f32]) -> Option<String> {
        if samples.is_empty() {
            return None;
        }
        let _ = self.rec.push_samples(samples);
        if self.rec.is_endpoint() {
            let text = self.rec.finalize();
            self.rec.reset();
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        None
    }

    /// **Force-finalize** the current utterance and reset, returning its text
    /// without waiting for the recognizer's own endpoint/VAD. This is what a
    /// push-to-talk release (`Payload::AudioEnd`) triggers: the user said "I'm
    /// done speaking", so whatever was recognized so far becomes the turn.
    pub fn finish(&mut self) -> Option<String> {
        let text = self.rec.finalize();
        self.rec.reset();
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            Some(trimmed.to_string())
        } else {
            None
        }
    }
}

/// Deterministic mock recognizer for offline demo / CI.
fn mock_recognizer() -> MockStreamingRecognizer {
    // Emits one word per ~10 ms frame; endpoint after 4 words (~640 samples).
    MockStreamingRecognizer::new(["你", "好", "，", "Amos"], 4)
}

/// Resolve a model file by trying each candidate name in order and returning the
/// first that exists in `dir` (used for the int8 → plain → generic fallback).
#[cfg(feature = "asr-sherpa")]
fn first_existing(dir: &std::path::Path, candidates: &[&str]) -> Option<std::path::PathBuf> {
    candidates.iter().map(|f| dir.join(f)).find(|p| p.exists())
}

/// Validate + bound an operator-supplied model-directory path string.
/// `None` for blank or over-cap input (never a silent truncation): an env path
/// is untrusted input at a seam (`MAX_MODEL_DIR_BYTES`).
#[cfg(feature = "asr-sherpa")]
fn bounded_model_dir(raw: &str) -> Option<std::path::PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_MODEL_DIR_BYTES {
        return None;
    }
    Some(std::path::PathBuf::from(trimmed))
}

/// Read one model-directory env key with its three input states kept distinct:
/// **unset** is silent (the ordinary case), while **present but not Unicode** and
/// **present but blank/over-cap** are each reported before being ignored. A value
/// the operator set must never be dropped without a word — the same shape
/// F-AI-025/F-AI-026 fixed in `bundled_model::env_path`.
#[cfg(feature = "asr-sherpa")]
fn bounded_env_dir(key: &str) -> Option<std::path::PathBuf> {
    let raw = std::env::var_os(key)?;
    let Some(raw) = raw.to_str() else {
        tracing::warn!("{key} is not valid Unicode; ignoring it");
        return None;
    };
    match bounded_model_dir(raw) {
        Some(dir) => Some(dir),
        None => {
            tracing::warn!("{key} is blank or exceeds {MAX_MODEL_DIR_BYTES} bytes; ignoring it");
            None
        }
    }
}

/// Resolve the sherpa model dir via the documented chain (Gap 8):
///
/// 1. `AMOS_SHERPA_MODEL_DIR` — operator override (wins outright when usable);
/// 2. `${AMOS_BUNDLE_RES_DIR}/sherpa` then `${AMOS_BUNDLE_MODELS_DIR}/sherpa` —
///    the asset roots the AOSP build sets when it stages a bundled model;
/// 3. [`BUNDLED_SHERPA_DIRS`] — the fixed on-device locations
///    (`/data/amos/sherpa`, `/system/share/amos/sherpa`).
///
/// A candidate only counts when it actually contains `tokens.txt`, so a
/// directory that merely exists can never be reported as a usable model.
/// A value the operator set that cannot be used (blank, over-cap, non-Unicode)
/// is reported before being skipped; an **unset** key stays silent.
/// Returns `None` (honest "not staged") when no candidate qualifies — the
/// caller decides the fallback and logs it; this function never fabricates a
/// model and never panics.
#[cfg(feature = "asr-sherpa")]
pub fn resolve_sherpa_model_dir() -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    if let Some(dir) = bounded_env_dir("AMOS_SHERPA_MODEL_DIR") {
        candidates.push(dir);
    }
    for env_key in ["AMOS_BUNDLE_RES_DIR", "AMOS_BUNDLE_MODELS_DIR"] {
        if let Some(root) = bounded_env_dir(env_key) {
            candidates.push(root.join("sherpa"));
        }
    }
    candidates.extend(BUNDLED_SHERPA_DIRS.iter().map(std::path::PathBuf::from));

    candidates
        .into_iter()
        .find(|d| d.join("tokens.txt").is_file())
}

/// Fallback when the daemon was built without `asr-sherpa`: no model dir can be
/// resolved (there is no recognizer to feed one to).
#[cfg(not(feature = "asr-sherpa"))]
pub fn resolve_sherpa_model_dir() -> Option<std::path::PathBuf> {
    None
}

/// Real local sherpa-onnx streaming recognizer from [`resolve_sherpa_model_dir`]
/// (feature `asr-sherpa`). Honest `None` — never the mock — when no dir
/// resolves or the model fails to load.
#[cfg(feature = "asr-sherpa")]
fn sherpa_recognizer_from_env() -> Option<ChatAsr> {
    use amos_asr::{SherpaOnlineRecognizer, SherpaOnlineRecognizerConfig};

    let Some(dir) = resolve_sherpa_model_dir() else {
        tracing::warn!(
            "no sherpa model dir resolves (AMOS_SHERPA_MODEL_DIR unset/unusable and no bundled \
             dir carries tokens.txt); real ASR unavailable"
        );
        return None;
    };
    // Resolve each ONNX with an int8 → plain → generic-name fallback, so a model
    // dir carrying only the non-quantised files still loads (mirrors the Tauri
    // side's model resolution).
    let encoder = first_existing(
        &dir,
        &[
            "encoder-epoch-99-avg-1.int8.onnx",
            "encoder-epoch-99-avg-1.onnx",
            "encoder.onnx",
        ],
    );
    let decoder = first_existing(
        &dir,
        &[
            "decoder-epoch-99-avg-1.int8.onnx",
            "decoder-epoch-99-avg-1.onnx",
            "decoder.onnx",
        ],
    );
    let joiner = first_existing(
        &dir,
        &[
            "joiner-epoch-99-avg-1.int8.onnx",
            "joiner-epoch-99-avg-1.onnx",
            "joiner.onnx",
        ],
    );
    let (Some(encoder), Some(decoder), Some(joiner)) = (encoder, decoder, joiner) else {
        tracing::warn!(
            "sherpa model dir {} carries tokens.txt but encoder/decoder/joiner are missing",
            dir.display()
        );
        return None;
    };
    let cfg = SherpaOnlineRecognizerConfig {
        tokens: dir.join("tokens.txt"),
        encoder,
        decoder,
        joiner,
        lang: "auto".into(),
        ..Default::default()
    };
    match SherpaOnlineRecognizer::new(cfg) {
        Ok(rec) => {
            tracing::info!(
                model_dir = %dir.display(),
                "voice input: real on-device sherpa-onnx ASR"
            );
            Some(ChatAsr::with_label(Box::new(rec), "sherpa"))
        }
        Err(e) => {
            tracing::warn!(
                "sherpa model dir {} failed to initialise: {e}",
                dir.display()
            );
            None
        }
    }
}

/// Fallback when the daemon was built without `asr-sherpa`: there is no
/// recognizer to build, and we must **not** substitute the mock here (an
/// explicit `sherpa` request degrades to an honest `None`, never a mock).
#[cfg(not(feature = "asr-sherpa"))]
fn sherpa_recognizer_from_env() -> Option<ChatAsr> {
    tracing::warn!(
        "AMOS_ASR_BACKEND=sherpa but amos-ai was built without the `asr-sherpa` feature"
    );
    None
}

/// Decode mono 16 kHz f32 little-endian PCM bytes into `f32` samples. Trailing
/// partial samples (< 4 bytes) are ignored.
fn decode_f32_le(bytes: &[u8]) -> Vec<f32> {
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    out
}

/// Every env var the ASR resolution chain reads. Tests that mutate the process
/// environment wipe/lock exactly these so one test cannot leak into the next.
#[cfg(test)]
const ASR_ENV_KEYS: &[&str] = &[
    "AMOS_ASR_BACKEND",
    "AMOS_SHERPA_MODEL_DIR",
    "AMOS_BUNDLE_RES_DIR",
    "AMOS_BUNDLE_MODELS_DIR",
];

/// Save/wipe/restore an env-var subset for one test. Combined with
/// `#[serial_test::serial(env_lock)]` this makes the env-sensitive
/// resolution tests deterministic under cargo's parallel test runner.
#[cfg(test)]
struct EnvGuard(Vec<(&'static str, Option<String>)>);

#[cfg(test)]
impl EnvGuard {
    fn wipe(keys: &[&'static str]) -> Self {
        let mut saved = Vec::with_capacity(keys.len());
        for k in keys {
            saved.push((*k, std::env::var(k).ok()));
            std::env::remove_var(k);
        }
        Self(saved)
    }

    fn set(&mut self, key: &'static str, value: &str) {
        std::env::set_var(key, value);
    }
}

#[cfg(test)]
impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (k, v) in self.0.drain(..) {
            match v {
                Some(s) => std::env::set_var(k, s),
                None => std::env::remove_var(k),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zeros(n: usize) -> Vec<u8> {
        vec![0u8; n * 4]
    }

    #[test]
    fn decodes_f32_le_bytes() {
        let bytes = 1.0f32.to_le_bytes();
        assert_eq!(decode_f32_le(&bytes), vec![1.0]);
        // Trailing <4 bytes ignored.
        let mut b = bytes.to_vec();
        b.push(0);
        assert_eq!(decode_f32_le(&b), vec![1.0]);
    }

    #[test]
    fn mock_recognizes_after_enough_samples() {
        let mut asr = ChatAsr::new(Box::new(mock_recognizer()));
        // 160 samples per partial, 4 partials -> endpoint.
        let frame = zeros(640);
        let text = asr.feed_audio(&frame);
        assert_eq!(text.as_deref(), Some("你好，Amos"));
    }

    #[test]
    fn accumulates_across_frames_then_resets() {
        let mut asr = ChatAsr::new(Box::new(mock_recognizer()));
        // Two frames of 320 samples each (cumulative 640 -> endpoint).
        assert_eq!(asr.feed_audio(&zeros(320)), None, "not enough yet");
        let text = asr.feed_audio(&zeros(320));
        assert_eq!(text.as_deref(), Some("你好，Amos"));
        // Recognizer reset: a fresh utterance needs more samples before endpoint.
        assert_eq!(
            asr.feed_audio(&zeros(160)),
            None,
            "reset, still accumulating"
        );
    }

    #[test]
    #[serial_test::serial(env_lock)]
    fn from_env_can_be_disabled() {
        let mut env = EnvGuard::wipe(ASR_ENV_KEYS);
        env.set("AMOS_ASR_BACKEND", "off");
        assert!(
            ChatAsr::from_env().is_none(),
            "AMOS_ASR_BACKEND=off disables"
        );

        env.set("AMOS_ASR_BACKEND", "none");
        assert!(ChatAsr::from_env().is_none());

        // Default (unset) still yields a usable recognizer.
        std::env::remove_var("AMOS_ASR_BACKEND");
        let asr = ChatAsr::from_env().expect("unset backend still yields a recognizer");
        let label = asr.backend_label();
        assert!(
            matches!(label, "mock" | "sherpa"),
            "the unset default is a working recognizer, got {label}"
        );
        // On a host with no bundled model dir the only honest outcome is the mock.
        if resolve_sherpa_model_dir().is_none() {
            assert_eq!(label, "mock", "no model dir -> deterministic mock");
        }
    }

    /// The explicit `mock` request is honoured and *labelled* mock — never
    /// reported as a real engine.
    #[test]
    #[serial_test::serial(env_lock)]
    fn explicit_mock_request_is_labelled_mock() {
        let mut env = EnvGuard::wipe(ASR_ENV_KEYS);
        env.set("AMOS_ASR_BACKEND", "mock");
        let asr = ChatAsr::from_env().expect("explicit mock yields a recognizer");
        assert_eq!(asr.backend_label(), "mock");
    }

    /// Injected recognizers are labelled `custom` so nothing claims an engine
    /// that was not built from the environment.
    #[test]
    fn injected_recognizer_is_labelled_custom() {
        let asr = ChatAsr::new(Box::new(mock_recognizer()));
        assert_eq!(asr.backend_label(), "custom");
    }

    /// Gap 8 test 4: `AMOS_ASR_BACKEND=sherpa` on a build **without** the
    /// `asr-sherpa` feature must return `None` (honest "not configured") — it
    /// must NOT silently hand back the mock.
    #[cfg(not(feature = "asr-sherpa"))]
    #[test]
    #[serial_test::serial(env_lock)]
    fn sherpa_without_feature_returns_none_not_mock() {
        let mut env = EnvGuard::wipe(ASR_ENV_KEYS);
        env.set("AMOS_ASR_BACKEND", "sherpa");
        assert!(
            ChatAsr::from_env().is_none(),
            "an explicit sherpa request on a feature-less build must be None, never the mock"
        );
        assert!(resolve_sherpa_model_dir().is_none());
    }

    #[test]
    fn finish_force_finalizes_a_short_utterance_and_resets() {
        let mut asr = ChatAsr::new(Box::new(mock_recognizer()));
        // One partial (160 samples) is not enough to auto-endpoint (needs 640).
        assert_eq!(asr.feed_audio(&zeros(160)), None, "still accumulating");
        // Push-to-talk release force-finalizes whatever was heard.
        assert_eq!(asr.finish().as_deref(), Some("你好，Amos"));
        // Recognizer is reset for the next utterance.
        assert_eq!(
            asr.feed_audio(&zeros(160)),
            None,
            "reset, accumulating anew"
        );
        assert_eq!(asr.finish().as_deref(), Some("你好，Amos"));
    }

    #[test]
    fn oversized_audio_frame_is_dropped_before_decode() {
        let mut asr = ChatAsr::new(Box::new(mock_recognizer()));
        // One full valid frame (enough for an utterance) works as usual.
        assert_eq!(asr.feed_audio(&zeros(640)), Some("你好，Amos".to_string()));

        // A frame far beyond the cap must be dropped (None) without panic or a
        // huge decode allocation.
        let huge = vec![0u8; (MAX_FRAME_SAMPLES + 10) * 4];
        assert_eq!(asr.feed_audio(&huge), None, "oversized frame ignored");

        // The recognizer/session remains fully usable afterwards.
        assert_eq!(asr.finish().as_deref(), Some("你好，Amos"));
    }
}

#[cfg(all(test, feature = "asr-sherpa"))]
mod sherpa_tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    /// Counts WARN events, so the assertions land on the *observable* diagnostic
    /// (the operator's only view of a dropped override) rather than on a
    /// re-statement of the code. Thread-local via `set_default`, so the count is
    /// not perturbed by other tests running in parallel.
    struct WarnProbe(Arc<AtomicU64>);
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
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }
        fn enter(&self, _id: &tracing::span::Id) {}
        fn exit(&self, _id: &tracing::span::Id) {}
    }

    /// A bundle root whose `sherpa/` subdir carries the `tokens.txt` marker, so
    /// the resolver has a real second link to fall back to.
    fn staged_bundle_root(tag: &str) -> std::path::PathBuf {
        let root = staging_dir(tag, false);
        let model = root.join("sherpa");
        std::fs::create_dir_all(&model).unwrap();
        std::fs::write(model.join("tokens.txt"), b"<blk> 0\n").unwrap();
        root
    }

    #[test]
    fn first_existing_prefers_int8_then_falls_back_to_plain() {
        let dir = std::env::temp_dir().join(format!("amos-sherpa-find-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Only the plain (non-int8) model present -> it is chosen.
        std::fs::write(dir.join("encoder-epoch-99-avg-1.onnx"), b"x").unwrap();
        let p = first_existing(
            Path::new(&dir),
            &[
                "encoder-epoch-99-avg-1.int8.onnx",
                "encoder-epoch-99-avg-1.onnx",
            ],
        )
        .expect("plain fallback resolves");
        assert_eq!(p, dir.join("encoder-epoch-99-avg-1.onnx"));

        // Once the int8 variant appears, it is preferred.
        std::fs::write(dir.join("encoder-epoch-99-avg-1.int8.onnx"), b"y").unwrap();
        let p = first_existing(
            Path::new(&dir),
            &[
                "encoder-epoch-99-avg-1.int8.onnx",
                "encoder-epoch-99-avg-1.onnx",
            ],
        )
        .expect("int8 preferred");
        assert_eq!(p, dir.join("encoder-epoch-99-avg-1.int8.onnx"));

        // None of the candidates present -> None.
        assert!(first_existing(Path::new(&dir), &["joiner.onnx"]).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A temp dir holding only `tokens.txt` is enough for the *resolver* (it
    /// checks for the tokens marker), but not for a full recognizer build.
    fn staging_dir(tag: &str, with_tokens: bool) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "amos-sherpa-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        if with_tokens {
            std::fs::write(dir.join("tokens.txt"), b"<blk> 0\n").unwrap();
        }
        dir
    }

    /// Test 1 of the Gap 8 chain: an explicit `AMOS_SHERPA_MODEL_DIR` wins over
    /// everything else.
    #[test]
    #[serial_test::serial(env_lock)]
    fn resolve_prefers_the_operator_override() {
        let override_dir = staging_dir("override", true);
        let bundled_root =
            std::env::temp_dir().join(format!("amos-sherpa-bundle-root-{}", std::process::id()));
        std::fs::create_dir_all(bundled_root.join("sherpa")).unwrap();
        std::fs::write(bundled_root.join("sherpa/tokens.txt"), b"<blk> 0\n").unwrap();

        let mut env = EnvGuard::wipe(ASR_ENV_KEYS);
        env.set("AMOS_SHERPA_MODEL_DIR", override_dir.to_str().unwrap());
        env.set("AMOS_BUNDLE_RES_DIR", bundled_root.to_str().unwrap());

        assert_eq!(
            resolve_sherpa_model_dir().as_deref(),
            Some(override_dir.as_path()),
            "AMOS_SHERPA_MODEL_DIR must beat the bundled asset root"
        );

        let _ = std::fs::remove_dir_all(&override_dir);
        let _ = std::fs::remove_dir_all(&bundled_root);
    }

    /// Test 2: with no override, `${AMOS_BUNDLE_RES_DIR}/sherpa` is used — this
    /// is the "device ships a bundled model" path (F-ASR-001 mitigation).
    #[test]
    #[serial_test::serial(env_lock)]
    fn resolve_falls_back_to_the_bundled_asset_root() {
        let root = staging_dir("bundle", false);
        let model = root.join("sherpa");
        std::fs::create_dir_all(&model).unwrap();
        std::fs::write(model.join("tokens.txt"), b"<blk> 0\n").unwrap();

        let mut env = EnvGuard::wipe(ASR_ENV_KEYS);
        env.set("AMOS_BUNDLE_RES_DIR", root.to_str().unwrap());

        assert_eq!(
            resolve_sherpa_model_dir().as_deref(),
            Some(model.as_path()),
            "the bundled asset root is the second link in the chain"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Test 3 (**negative control**): a directory that exists but carries no
    /// `tokens.txt` must not be reported as a usable model, and a *non-existent*
    /// `AMOS_SHERPA_MODEL_DIR` must resolve to `None` (not panic, not mock).
    #[test]
    #[serial_test::serial(env_lock)]
    fn resolve_returns_none_for_missing_or_tokenless_dirs() {
        let empty = staging_dir("empty", false);
        let mut env = EnvGuard::wipe(ASR_ENV_KEYS);
        env.set("AMOS_SHERPA_MODEL_DIR", empty.to_str().unwrap());
        assert!(
            resolve_sherpa_model_dir().is_none(),
            "a dir without tokens.txt is not a model dir"
        );

        env.set(
            "AMOS_SHERPA_MODEL_DIR",
            "/nonexistent-amos-sherpa-model-dir-407",
        );
        assert!(
            resolve_sherpa_model_dir().is_none(),
            "a non-existent dir must resolve to None, never panic"
        );
        assert!(
            sherpa_recognizer_from_env().is_none(),
            "an explicit sherpa request with a bad dir is None — never the mock"
        );

        let _ = std::fs::remove_dir_all(&empty);
    }

    /// Test 4 (positive): when a bundled dir carries a real model the default
    /// path builds a **real** recognizer and reports it as `sherpa`, not mock.
    /// Skipped when the repo demo model was not fetched (`scripts/fetch-models.sh`).
    #[test]
    #[serial_test::serial(env_lock)]
    fn default_asr_prefers_real_when_a_bundled_dir_is_staged() {
        let repo_models = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models/sherpa-en-20m");
        if !repo_models.join("tokens.txt").is_file() {
            eprintln!("skip: repo demo sherpa model not present");
            return;
        }
        let root = staging_dir("bundled-real", false);
        let model = root.join("sherpa");
        std::fs::create_dir_all(&model).unwrap();
        for name in [
            "tokens.txt",
            "encoder-epoch-99-avg-1.int8.onnx",
            "decoder-epoch-99-avg-1.int8.onnx",
            "joiner-epoch-99-avg-1.int8.onnx",
        ] {
            std::os::unix::fs::symlink(repo_models.join(name), model.join(name))
                .expect("symlink model file");
        }

        let mut env = EnvGuard::wipe(ASR_ENV_KEYS);
        env.set("AMOS_BUNDLE_RES_DIR", root.to_str().unwrap());

        let asr = ChatAsr::from_env().expect("bundled model yields a recognizer");
        assert_eq!(
            asr.backend_label(),
            "sherpa",
            "a bundled model must select the REAL recognizer, not the mock"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// F-ASR-003: a present-but-blank `AMOS_SHERPA_MODEL_DIR` (an unexpanded shell
    /// variable, a stray space) is ignored — but the operator must be told, since
    /// the warn beside the site already claims to cover "blank". Dropping it in
    /// silence is exactly the shape F-AI-025 fixed in `bundled_model::env_path`.
    #[test]
    #[serial_test::serial(env_lock)]
    fn a_blank_override_is_reported_not_silently_dropped() {
        let root = staged_bundle_root("blank-override");
        let mut env = EnvGuard::wipe(ASR_ENV_KEYS);
        env.set("AMOS_SHERPA_MODEL_DIR", "   ");
        env.set("AMOS_BUNDLE_RES_DIR", root.to_str().unwrap());

        let warns = Arc::new(AtomicU64::new(0));
        let resolved = {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            resolve_sherpa_model_dir()
        };

        let expected = root.join("sherpa");
        assert_eq!(
            resolved.as_deref(),
            Some(expected.as_path()),
            "a blank override is ignored, so the bundled root must still win"
        );
        assert!(
            warns.load(Ordering::Relaxed) >= 1,
            "a present-but-blank AMOS_SHERPA_MODEL_DIR must be reported; dropping it in \
             silence is the F-ASR-003 defect"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The disjointness control for the test above: an **unset** variable is the
    /// ordinary case and must stay silent. A blanket "warn whenever the value is
    /// unusable" fix that also fires here would be caught by this assertion.
    #[test]
    #[serial_test::serial(env_lock)]
    fn an_unset_override_stays_silent() {
        let root = staged_bundle_root("unset-override");
        let mut env = EnvGuard::wipe(ASR_ENV_KEYS);
        env.set("AMOS_BUNDLE_RES_DIR", root.to_str().unwrap());
        // AMOS_SHERPA_MODEL_DIR is deliberately left unset.

        let warns = Arc::new(AtomicU64::new(0));
        let resolved = {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            resolve_sherpa_model_dir()
        };

        let expected = root.join("sherpa");
        assert_eq!(resolved.as_deref(), Some(expected.as_path()));
        assert_eq!(
            warns.load(Ordering::Relaxed),
            0,
            "an unset variable is the ordinary case and must not warn — only a \
             present-but-unusable value does"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// F-ASR-004: a present-but-non-Unicode override is dropped by the old
    /// `std::env::var(..).ok()`/`if let Ok` read **without a word** — the same
    /// fold F-AI-026 fixed in `bundled_model::env_path`.
    #[test]
    #[cfg(unix)]
    #[serial_test::serial(env_lock)]
    fn a_non_unicode_override_is_reported_not_silently_dropped() {
        use std::os::unix::ffi::OsStrExt;
        let root = staged_bundle_root("nonunicode-override");
        let mut env = EnvGuard::wipe(ASR_ENV_KEYS);
        std::env::set_var(
            "AMOS_SHERPA_MODEL_DIR",
            std::ffi::OsStr::from_bytes(b"/tmp/amos-\xff-sherpa"),
        );
        env.set("AMOS_BUNDLE_RES_DIR", root.to_str().unwrap());

        let warns = Arc::new(AtomicU64::new(0));
        let resolved = {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            resolve_sherpa_model_dir()
        };

        let expected = root.join("sherpa");
        assert_eq!(resolved.as_deref(), Some(expected.as_path()));
        assert!(
            warns.load(Ordering::Relaxed) >= 1,
            "a present-but-non-Unicode AMOS_SHERPA_MODEL_DIR must be reported; the old read \
             folded it into the same silent None as 'unset' (F-ASR-004)"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// F-ASR-004, the second half: the two **bundle-root** keys never reported a
    /// blank/over-cap value at all (the `if let Some(root) = bounded_model_dir(..)`
    /// arm has no else). A present-but-unusable `AMOS_BUNDLE_RES_DIR` must warn.
    #[test]
    #[serial_test::serial(env_lock)]
    fn a_blank_bundle_root_is_reported_not_silently_dropped() {
        let mut env = EnvGuard::wipe(ASR_ENV_KEYS);
        env.set("AMOS_BUNDLE_RES_DIR", "  ");

        let warns = Arc::new(AtomicU64::new(0));
        let _resolved = {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            resolve_sherpa_model_dir()
        };

        assert!(
            warns.load(Ordering::Relaxed) >= 1,
            "a present-but-blank AMOS_BUNDLE_RES_DIR must be reported; the bundle-root arm \
             dropped it without a word (F-ASR-004)"
        );
    }
}
