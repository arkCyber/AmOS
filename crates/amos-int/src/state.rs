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

    /// Full 8×8 matrix: `transition(to)` must be `Ok` iff `allowed(from,to)` is
    /// true, and the total allowed-edge count must stay exactly 21. Locks the
    /// table so it can never drift from the `transition` method.
    #[test]
    fn transition_is_exactly_consistent_with_allowed_matrix() {
        use SessionState::*;
        const ALL: [SessionState; 8] = [
            Idle,
            Starting,
            Collecting,
            Interpreting,
            Speaking,
            Paused,
            Ended,
            Error,
        ];
        let mut edges = 0usize;
        for from in ALL {
            for to in ALL {
                let allowed = SessionState::allowed(from, to);
                match from.transition(to) {
                    Ok(next) => {
                        assert!(allowed, "transition Ok but allowed=false for {from:?}->{to:?}");
                        assert_eq!(next, to);
                        edges += 1;
                    }
                    Err(e) => {
                        assert!(!allowed, "transition Err but allowed=true for {from:?}->{to:?}");
                        assert_eq!(e, StateError { from, to });
                    }
                }
            }
        }
        // Idle2 + Starting3 + Collecting4 + Interpreting5 + Speaking4 + Paused2 + Error1 + Ended0
        assert_eq!(edges, 21);
    }

    #[test]
    fn no_self_loops_and_ended_is_terminal() {
        use SessionState::*;
        const ALL: [SessionState; 8] = [
            Idle,
            Starting,
            Collecting,
            Interpreting,
            Speaking,
            Paused,
            Ended,
            Error,
        ];
        for s in ALL {
            assert!(!SessionState::allowed(s, s), "self-loop must not be allowed for {s:?}");
        }
        for to in ALL {
            assert!(
                !SessionState::allowed(Ended, to),
                "Ended must be terminal (no outgoing edges)"
            );
        }
    }

    /// Every declared state must be reachable from Idle through allowed edges —
    /// no unreachable/ghost states.
    #[test]
    fn every_state_is_reachable_from_idle() {
        use SessionState::*;
        const ALL: [SessionState; 8] = [
            Idle,
            Starting,
            Collecting,
            Interpreting,
            Speaking,
            Paused,
            Ended,
            Error,
        ];
        let mut reach = std::collections::HashSet::new();
        reach.insert(Idle);
        let mut frontier = vec![Idle];
        while let Some(from) = frontier.pop() {
            for to in ALL {
                if SessionState::allowed(from, to) && reach.insert(to) {
                    frontier.push(to);
                }
            }
        }
        for s in ALL {
            assert!(reach.contains(&s), "{s:?} unreachable from Idle");
        }
    }

    #[test]
    fn documented_illegal_edges_stay_rejected() {
        use SessionState::*;
        assert!(!SessionState::allowed(Paused, Interpreting));
        assert!(!SessionState::allowed(Paused, Speaking));
        assert!(!SessionState::allowed(Error, Collecting));
        assert!(!SessionState::allowed(Error, Starting));
        assert!(!SessionState::allowed(Error, Paused));
        assert!(!SessionState::allowed(Collecting, Starting));
        assert!(!SessionState::allowed(Speaking, Idle));
    }
}
