//! `amos-tts` — text-to-speech.
//!
//! Turns an [`amos_int::TtsRequest`] (or any text+lang) into playable
//! [`TtsAudio`]. The [`TtsProvider`] trait is the single seam, so the backend is
//! swappable without touching the interpretation engine, CLI, or UI:
//!
//! * [`MockTtsProvider`] — deterministic (short tone/silence) for tests and
//!   offline demos.
//! * [`PiperProvider`] (feature `piper`) — local Piper models via `piper-rs`.
//!
//! ```text
//! [ TtsRequest ] --> TtsProvider.synthesize(text, lang) --> TtsAudio
//!                                                          (PCM f32, playable)
//! ```

// P0-1 gate: production code must not panic on programmer error. Test code is
// exempt (assertions/unwrap are idiomatic there).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod provider;

pub use provider::{MockTtsProvider, TtsProvider};

#[cfg(feature = "piper")]
pub mod piper;
#[cfg(feature = "piper")]
pub use piper::PiperProvider;
