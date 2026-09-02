//! Session lifecycle state machine.
//!
//! A session moves through a small set of states; transitions are validated so
//! an illegal move (e.g. speaking while idle) is rejected rather than silently
//! corrupting the engine.

use serde::{Deserialize, Serialize};

/// Lifecycle of one interpretation session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SessionState {
    /// Constructed, not yet started.
    Idle,
    /// Acquiring the provider pipeline.
    Starting,
    /// Capturing audio / text and building an utterance.
    Collecting,
    /// Awaiting the provider's translation of the finalized utterance.
    Interpreting,
    /// Synthesizing / playing the translation (TTS).
    Speaking,
    /// Suspended; can only resume or end.
    Paused,
    /// Terminal success/failure exit.
    Ended,
    /// Recoverable failure; may be ended or restarted.
    Error,
}

/// A rejected state transition.
#[derive(thiserror::Error, Debug, PartialEq, Eq)]
#[error("illegal session transition {from:?} -> {to:?}")]
pub struct StateError {
    pub from: SessionState,
    pub to: SessionState,
}

impl SessionState {
    /// Whether a direct transition from `from` to `to` is legal.
    pub fn allowed(from: SessionState, to: SessionState) -> bool {
        use SessionState::*;
        match (from, to) {
            // Start.
            (Idle, Starting) | (Idle, Ended) => true,
            (Starting, Collecting) | (Starting, Error) | (Starting, Ended) => true,
            // Normal interpretation cycle: collect -> interpret -> speak -> collect.
            (Collecting, Interpreting)
            | (Collecting, Paused)
            | (Collecting, Error)
            | (Collecting, Ended) => true,
            (Interpreting, Collecting)
            | (Interpreting, Speaking)
            | (Interpreting, Paused)
            | (Interpreting, Error)
            | (Interpreting, Ended) => true,
            (Speaking, Collecting) | (Speaking, Paused) | (Speaking, Error) | (Speaking, Ended) => {
                true
            }
            // Pause only resumes to collecting or ends.
            (Paused, Collecting) | (Paused, Ended) => true,
            // Error may be ended; nothing may leave Ended.
            (Error, Ended) => true,
            (Ended, _) => false,
            _ => false,
        }
    }

    /// Attempt a transition, returning the new state or a [`StateError`].
    pub fn transition(&self, to: SessionState) -> Result<SessionState, StateError> {
        if Self::allowed(*self, to) {
            Ok(to)
        } else {
            Err(StateError { from: *self, to })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SessionState::*;
    use super::*;

    #[test]
    fn normal_interpretation_cycle_is_legal() {
        let mut s = Idle;
        s = s.transition(Starting).unwrap();
        s = s.transition(Collecting).unwrap();
        s = s.transition(Interpreting).unwrap();
        s = s.transition(Speaking).unwrap();
        s = s.transition(Collecting).unwrap();
        assert_eq!(s, Collecting);
    }

    #[test]
    fn illegal_transition_is_rejected() {
        let err = Idle.transition(Speaking).unwrap_err();
        assert_eq!(
            err,
            StateError {
                from: Idle,
                to: Speaking
            }
        );
    }

    #[test]
    fn ended_is_terminal() {
        assert!(Ended.transition(Collecting).is_err());
        assert!(Ended.transition(Idle).is_err());
    }

    #[test]
    fn pause_resume_cycle_is_legal() {
        let mut s = Collecting;
        s = s.transition(Paused).unwrap();
        assert!(s.transition(Interpreting).is_err());
        s = s.transition(Collecting).unwrap();
        assert_eq!(s, Collecting);
    }
}
