//! `amos-audio` — the hardware audio abstraction of AmOS.
//!
//! Bridges the gap between the AOSP audio hardware (AudioFlinger / Audio HAL,
//! reached through TinyALSA or AAudio) and the rest of AmOS, which speaks
//! **mono 16 kHz f32 PCM** (the same sample format `amos_asr::StreamingRecognizer`
//! and the `ai_agent` wire contract expect).
//!
//! ```text
//! [ TinyALSA / AAudio mic ]          [ TinyALSA / AAudio sink ]
//!          │ read()                                  ▲ write()
//!          ▼                                         │
//!   ┌──────────────────────────────────────────────────┐
//!   │  AudioCapture trait          AudioSink trait      │
//!   │  (mono f32, any device rate)                     │
//!   ├──────────────────────────────────────────────────┤
//!   │  LinearDownsampler  device_rate ──▶ 16 kHz ASR    │
//!   │  (or open the device at 16 kHz to skip it)        │
//!   ├──────────────────────────────────────────────────┤
//!   │  MockMic / FrameMic / MockSink / NullSink        │
//!   │  (deterministic, offline, for tests & demos)      │
//!   └──────────────────────────────────────────────────┘
//!                       │ Payload::Audio (mono 16k f32le bytes)
//!                       ▼
//!            amos-ai bidi Chat  ──▶  sherpa local ASR
//! ```
//!
//! Crate layout:
//!
//! * [`spec`] — sample-format helpers and the shared [`AudioSpec`] (rate/channels).
//! * [`error`] — [`AudioError`], the single error type returned by the traits.
//! * [`capture`] — the [`AudioCapture`] pull model (`read` fills a mono f32 buffer).
//! * [`sink`] — the [`AudioSink`] push model (`write` accepts mono f32 samples).
//! * [`resample`] — [`LinearDownsampler`], a streaming resampler for the common
//!   device-rate → 16 kHz path; plus a one-shot [`resample_linear`].
//! * [`mock`] — [`SineMic`] / [`FrameMic`] / [`SilenceMic`] captures and a
//!   [`MockSink`] / [`NullSink`], all deterministic and offline.
//! * [`android`] — **compile-time-gated** direct TinyALSA / AAudio FFI bindings
//!   (feature `tinyalsa` / `aaudio` + `target_os = "android"`). On a host build
//!   these modules are empty so the default workspace stays light and green.
//!
//! ## On-device guidance
//!
//! AAudio/TinyALSA let you *request* the capture rate; when the HAL honours it
//! AmOS asks for 16 kHz directly and the resampler is bypassed. Where the device
//! only offers 44.1/48 kHz, route capture through a [`LinearDownsampler`] so the
//! ASR/wire never see the native rate. Audio is always delivered to the traits
//! as **mono f32**; the Android seams down-mix multi-channel devices internally.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod capture;
pub mod error;
pub mod mock;
pub mod resample;
pub mod sink;
pub mod spec;

// On Android (and only with the matching feature) `android` is a directory of
// seam modules; on host builds it is intentionally absent so there is nothing to
// link. Each device backend also re-exports its constructors at crate root for
// ergonomics (e.g. `TinyAlsaCapture::open`), gated the same way.
#[cfg(all(any(feature = "tinyalsa", feature = "aaudio"), target_os = "android"))]
pub mod android;

pub use capture::AudioCapture;
pub use error::AudioError;
pub use resample::{resample_linear, LinearDownsampler};
pub use sink::AudioSink;
pub use spec::{AudioSpec, ASR_SAMPLE_RATE};

#[cfg(all(feature = "aaudio", target_os = "android"))]
pub use crate::android::aaudio::{AAudioCapture, AAudioSink};
#[cfg(all(feature = "tinyalsa", target_os = "android"))]
pub use crate::android::tinyalsa::{TinyAlsaCapture, TinyAlsaSink};
