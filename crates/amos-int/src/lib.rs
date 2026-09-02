//! `amos-int` — the simultaneous-interpretation **session engine**.
//!
//! A transport-agnostic core that encodes the domain of a live two-way speech
//! translation app (the shape of [sokuji](https://github.com/kizuna-ai-lab/sokuji))
//! in pure Rust, so the *same* engine drives both the CLI daemon and the Tauri
//! System UI.
//!
//! # Why this crate exists
//!
//! sokuji couples its pipeline to Electron/Web. `amos-int` lifts the *domain*
//! — session lifecycle, utterance assembly (partial → final), language pairs,
//! and a pluggable provider pipeline (ASR → translation → TTS) — into a crate
//! that knows nothing about gRPC, sockets, or the WebView. Transport and UI are
//! thin adapters on top:
//!
//! ```text
//! [ WebView / CLI ]  --events-->  [ Session ]  --Pipeline trait-->  [ provider ]
//!                                   (amos-int)           \            ASR/translate/TTS
//!                                                          \___ outputs (partials, segments)
//! ```
//!
//! # Highlights
//!
//! * A validated [`SessionState`] machine — illegal transitions are rejected.
//! * [`UtteranceBuilder`] — merges streaming ASR partials into stable finals.
//! * [`Pipeline`] trait — one seam for every provider (mirrors sokuji's
//!   `ProviderDescriptor`/`IClient`), plus [`BothMode`] shared/split planning.
//! * Pure event I/O: push [`SessionEvent`]s in, read [`InterpretationOutput`]s
//!   out through a channel. No I/O happens inside the engine itself.

pub mod config;
pub mod error;
pub mod event;
pub mod language;
pub mod pipeline;
pub mod segment;
pub mod state;

pub use config::{BothMode, SessionConfig};
pub use error::{InterpretationError, Result};
pub use event::{EndReason, InterpretationOutput, SessionEvent, TtsRequest};
pub use language::{Language, LanguagePair};
pub use pipeline::{AsrEvent, MockPipeline, Pipeline, PipelineInfo, Translation, TtsAudio};
pub use segment::{PartialSegment, Segment, Speaker, UtteranceBuilder};
pub use session::Session;
pub use state::SessionState;

mod session;
