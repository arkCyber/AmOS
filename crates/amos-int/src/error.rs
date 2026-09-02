//! Error type and result alias for the engine.

use thiserror::Error;

use crate::state::StateError;

/// Errors surfaced by the interpretation engine.
#[derive(Error, Debug)]
pub enum InterpretationError {
    #[error("session state error: {0}")]
    State(#[from] StateError),

    #[error("provider pipeline: {0}")]
    Pipeline(String),

    #[error("session is not active (state is {state:?})")]
    NotActive { state: crate::state::SessionState },

    #[error("session is not collecting input")]
    NotCollecting,

    #[error("TTS is disabled for this session")]
    TtsDisabled,

    #[error("engine is closed")]
    Closed,

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, InterpretationError>;
