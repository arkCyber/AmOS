//! The event vocabulary across the session boundary.
//!
//! Callers push [`SessionEvent`]s into the engine and consume
//! [`InterpretationOutput`]s from a channel. This is the *only* coupling between
//! the engine and the outside world, so both the CLI and the Tauri UI speak the
//! same language.

use crate::language::Language;
use crate::segment::{PartialSegment, Segment};
use crate::state::SessionState;

/// Inputs a caller may push into the session.
#[derive(Clone, Debug)]
pub enum SessionEvent {
    /// A chunk of mono PCM audio (typically 16 kHz f32). Fed to streaming ASR.
    AudioChunk(Vec<f32>),
    /// A typed text segment (bypasses ASR).
    TextSegment(String),
    /// The VAD decided the current utterance ended: finalize and translate.
    EndOfSpeech,
    /// Suspend input; only resume or end afterwards.
    Pause,
    /// Resume a paused session.
    Resume,
    /// Graceful end (finish the in-flight utterance, then exit).
    Stop,
    /// Hard end (discard in-flight state immediately).
    Abort,
    /// Override / hint the source language.
    SetSourceLang(Language),
}

/// Outputs the engine emits (drives the UI and downstream TTS).
#[derive(Clone, Debug)]
pub enum InterpretationOutput {
    /// The session entered a new lifecycle state.
    StateChanged(SessionState),
    /// Streaming ASR partial for the current utterance.
    Partial(PartialSegment),
    /// A source utterance was recognized (before translation).
    UtteranceRecognized {
        id: u64,
        text: String,
        lang: Language,
    },
    /// A fully translated segment is ready for display.
    SegmentFinal(Segment),
    /// The source language was detected / pinned.
    LanguageDetected(Language),
    /// Request synthesis of the given text (only when TTS is enabled).
    TtsRequest(TtsRequest),
    /// The session ended.
    SessionEnded { reason: EndReason },
    /// A non-fatal error surfaced to the caller.
    Error { message: String },
}

/// Why a session ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EndReason {
    Completed,
    Stopped,
    Aborted,
    Failed(String),
}

/// A request for text-to-speech synthesis.
#[derive(Clone, Debug, PartialEq)]
pub struct TtsRequest {
    pub text: String,
    pub lang: Language,
    pub segment_id: u64,
}
