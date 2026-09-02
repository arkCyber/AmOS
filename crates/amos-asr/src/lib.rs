//! `amos-asr` — streaming speech recognition.
//!
//! Feeds *real* incremental recognition (`AsrEvent::Partial`/`Final`) into an
//! [`amos_int::Session`]. Two pieces:
//!
//! * [`StreamingRecognizer`] — a transport-agnostic trait for an incremental
//!   speech recognizer, with a deterministic [`MockStreamingRecognizer`] for
//!   tests and a [`SherpaOnlineRecognizer`] (feature `sherpa`) wrapping
//!   sherpa-onnx's `OnlineRecognizer`.
//! * [`AsrPipeline`] — adapts any [`StreamingRecognizer`] to the `amos_int`
//!   [`Pipeline`], buffering audio and emitting partials as they grow and a
//!   final when the recognizer signals an endpoint. Optionally delegates
//!   translation to another pipeline (e.g. `GrpcPipeline` → amos-translate),
//!   so a composite pipeline gives *local streaming ASR + remote translation*.
//!
//! ```text
//! [ mic PCM ] --> AsrPipeline.feed_audio --> StreamingRecognizer
//!                                            ├─ push_samples -> partials
//!                                            └─ is_endpoint  -> final
//!                        AsrEvent::Partial/Final --> amos_int::Session
//! ```

pub mod pipeline;
pub mod recognizer;

pub use pipeline::{AsrPipeline, AsrPipelineBuilder};
pub use recognizer::{Hypothesis, MockStreamingRecognizer, StreamingRecognizer};

#[cfg(feature = "sherpa")]
pub mod sherpa;
#[cfg(feature = "sherpa")]
pub use sherpa::{SherpaOnlineRecognizer, SherpaOnlineRecognizerConfig};
