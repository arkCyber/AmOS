//! The per-call model and its state machine.
//!
//! [`CallSession`] owns the *legal* transitions of a single call and never does
//! I/O itself; a provider (see [`crate::provider`]) performs the signalling and
//! reports events that the session then validates.

use std::fmt;

use crate::error::{Result, TelephonyError};
use crate::number::Number;

/// Opaque, provider-scoped id for one call. Independent namespace — never mix
/// with `amos-wm`'s window ids.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct CallId(String);

impl CallId {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CallId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Who initiated the call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallDirection {
    Outgoing,
    Incoming,
}

/// Current lifecycle state of a call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallState {
    /// Not yet dialling (placeholder parity with the wire enum).
    Idle,
    /// An outgoing call has been requested; waiting to connect.
    Dialing,
    /// An incoming call is ringing (or an outgoing call is ringing the peer).
    Ringing,
    /// The call is connected / in progress.
    Active,
    /// Terminal state.
    Ended,
}

/// Whether the current call is being recorded.
///
/// A call starts `Off`; it may only become `On` while the call is [`CallState::Active`]
/// and **non-emergency** (recording emergency / 110-112 calls is a hard legal rule).
/// `Failed` means recording was *intended* but the audio/device backend reported an
/// error, so the caller sees a clear "recording unavailable" state instead of a silent
/// lie. The machine: `Off -> On`, `On -> Off` (stop) and `On -> Failed` (device error,
/// reportable via the provider). A new `On` retries from `Failed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordingState {
    /// Not recording (default for every new call).
    Off,
    /// Recording is active on this call.
    On,
    /// Recording was attempted but the backend reported a failure.
    Failed,
}

/// Why a call ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndReason {
    /// Ended locally (hang up / reject).
    Local,
    /// Ended by the remote party.
    Remote,
    /// The call failed (no answer, network, etc.).
    Failed,
    /// An emergency call was placed (still recorded/audited).
    Emergency,
}

/// Immutable snapshot of a call for `status`/broadcast.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Call {
    pub id: CallId,
    pub peer: Number,
    pub direction: CallDirection,
    pub state: CallState,
    pub emergency: bool,
    pub ended_reason: Option<EndReason>,
    /// Whether the call is being recorded (always [`RecordingState::Off`] once ended).
    pub recording: RecordingState,
}

/// One call's legal state machine.
#[derive(Debug)]
pub struct CallSession {
    call: Call,
}

impl CallSession {
    /// Begin a new outgoing call (regular or emergency) in [`CallState::Dialing`].
    pub fn start_outgoing(id: CallId, peer: Number, emergency: bool) -> Self {
        Self {
            call: Call {
                id,
                peer,
                direction: CallDirection::Outgoing,
                state: CallState::Dialing,
                emergency,
                ended_reason: None,
                recording: RecordingState::Off,
            },
        }
    }

    /// Begin a ringing incoming call.
    pub fn start_incoming(id: CallId, peer: Number) -> Self {
        Self {
            call: Call {
                id,
                peer,
                direction: CallDirection::Incoming,
                state: CallState::Ringing,
                emergency: false,
                ended_reason: None,
                recording: RecordingState::Off,
            },
        }
    }

    pub fn state(&self) -> CallState {
        self.call.state
    }

    pub fn recording(&self) -> RecordingState {
        self.call.recording
    }

    pub fn snapshot(&self) -> Call {
        self.call.clone()
    }

    /// The far side connected / was answered (legal from Dialing or Ringing).
    pub fn connect(&mut self) -> Result<()> {
        if self.call.state == CallState::Ended {
            return Err(self.illegal("connect"));
        }
        match self.call.state {
            CallState::Dialing | CallState::Ringing => {
                self.call.state = CallState::Active;
                Ok(())
            }
            ref s => Err(TelephonyError::IllegalState {
                from: *s,
                event: "connect",
            }),
        }
    }

    /// The user answered an incoming call (legal only while Ringing).
    pub fn answer(&mut self) -> Result<()> {
        if self.call.state == CallState::Ended {
            return Err(self.illegal("answer"));
        }
        match self.call.state {
            CallState::Ringing => {
                self.call.state = CallState::Active;
                Ok(())
            }
            ref s => Err(TelephonyError::IllegalState {
                from: *s,
                event: "answer",
            }),
        }
    }

    /// End the call locally (hang up / reject). Legal from Dialing/Ringing/Active.
    pub fn end(&mut self, reason: EndReason) -> Result<()> {
        match self.call.state {
            CallState::Dialing | CallState::Ringing | CallState::Active => {
                self.call.state = CallState::Ended;
                self.call.ended_reason = Some(reason);
                // No recording may outlive the call it captured.
                self.call.recording = RecordingState::Off;
                Ok(())
            }
            CallState::Ended => Err(self.illegal("end")),
            CallState::Idle => Err(TelephonyError::IllegalState {
                from: CallState::Idle,
                event: "end",
            }),
        }
    }

    /// Begin recording this call.
    ///
    /// Legal **only** while the call is [`CallState::Active`], the number is
    /// **not** an emergency line, and recording is not already `On`. Calling from any
    /// other (non-`Active`) call state is an [`TelephonyError::IllegalState`];
    /// already-recording and emergency refusals are a
    /// [`TelephonyError::RecordingForbidden`]. A prior `Failed` state may be retried.
    pub fn start_recording(&mut self) -> Result<()> {
        if self.call.emergency {
            return Err(TelephonyError::RecordingForbidden(
                "emergency calls must never be recorded",
            ));
        }
        if self.call.state != CallState::Active {
            return Err(self.illegal("start_recording"));
        }
        match self.call.recording {
            RecordingState::On => Err(TelephonyError::RecordingForbidden(
                "call is already being recorded",
            )),
            RecordingState::Off | RecordingState::Failed => {
                self.call.recording = RecordingState::On;
                Ok(())
            }
        }
    }

    /// Stop recording this call. Legal only while it is actually being recorded
    /// ([`RecordingState::On`]); stopping an `Off`/`Failed` call is refused.
    pub fn stop_recording(&mut self) -> Result<()> {
        match self.call.recording {
            RecordingState::On => {
                self.call.recording = RecordingState::Off;
                Ok(())
            }
            RecordingState::Off | RecordingState::Failed => Err(
                TelephonyError::RecordingForbidden("call is not being recorded"),
            ),
        }
    }

    /// The device audio backend reported an error while recording: surface it as
    /// [`RecordingState::Failed`] (legal only from `On`) so callers don't believe a
    /// recording that never happened is being captured.
    pub fn recording_failed(&mut self) -> Result<()> {
        match self.call.recording {
            RecordingState::On => {
                self.call.recording = RecordingState::Failed;
                Ok(())
            }
            RecordingState::Off | RecordingState::Failed => Err(
                TelephonyError::RecordingForbidden("no active recording to mark failed"),
            ),
        }
    }

    fn illegal(&self, event: &'static str) -> TelephonyError {
        TelephonyError::IllegalState {
            from: self.call.state,
            event,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::number::Number;

    fn outgoing() -> CallSession {
        CallSession::start_outgoing(
            CallId::new("c1"),
            Number::new("13800138000").unwrap(),
            false,
        )
    }

    #[test]
    fn outgoing_full_flow() {
        let mut s = outgoing();
        assert_eq!(s.state(), CallState::Dialing);
        assert!(s.connect().is_ok());
        assert_eq!(s.state(), CallState::Active);
        assert!(s.end(EndReason::Local).is_ok());
        assert_eq!(s.state(), CallState::Ended);
        assert_eq!(s.snapshot().ended_reason, Some(EndReason::Local));
    }

    #[test]
    fn incoming_answer_flow() {
        let mut s =
            CallSession::start_incoming(CallId::new("c2"), Number::new("02112345678").unwrap());
        assert_eq!(s.state(), CallState::Ringing);
        assert!(s.answer().is_ok());
        assert_eq!(s.state(), CallState::Active);
    }

    #[test]
    fn answering_outgoing_is_illegal() {
        let mut s = outgoing();
        let err = s.answer().unwrap_err();
        assert!(matches!(
            err,
            TelephonyError::IllegalState {
                from: CallState::Dialing,
                event: "answer"
            }
        ));
    }

    #[test]
    fn connect_from_active_is_illegal() {
        let mut s = outgoing();
        assert!(s.connect().is_ok());
        assert!(s.connect().is_err(), "cannot connect twice");
    }

    #[test]
    fn end_after_end_is_illegal() {
        let mut s = outgoing();
        assert!(s.end(EndReason::Local).is_ok());
        assert!(s.end(EndReason::Remote).is_err());
        assert_eq!(s.snapshot().ended_reason, Some(EndReason::Local));
    }

    #[test]
    fn remote_end_records_remote_reason() {
        let mut s = outgoing();
        assert!(s.connect().is_ok());
        assert!(s.end(EndReason::Remote).is_ok());
        assert_eq!(s.state(), CallState::Ended);
        assert_eq!(s.snapshot().ended_reason, Some(EndReason::Remote));
    }

    fn active() -> CallSession {
        let mut s = outgoing();
        assert!(s.connect().is_ok());
        s
    }

    #[test]
    fn new_call_is_not_recording() {
        assert_eq!(outgoing().recording(), RecordingState::Off);
        assert_eq!(
            CallSession::start_incoming(CallId::new("i"), Number::new("02112345678").unwrap())
                .recording(),
            RecordingState::Off
        );
    }

    #[test]
    fn record_only_legal_while_active() {
        let mut s = outgoing(); // Dialing
        let err = s.start_recording().unwrap_err();
        assert!(matches!(err, TelephonyError::IllegalState { .. }));
    }

    #[test]
    fn start_then_stop_recording_full_cycle() {
        let mut s = active();
        assert!(s.start_recording().is_ok());
        assert_eq!(s.recording(), RecordingState::On);
        assert!(s.stop_recording().is_ok());
        assert_eq!(s.recording(), RecordingState::Off);
    }

    #[test]
    fn double_start_is_forbidden() {
        let mut s = active();
        assert!(s.start_recording().is_ok());
        let err = s.start_recording().unwrap_err();
        assert_eq!(
            err,
            TelephonyError::RecordingForbidden("call is already being recorded")
        );
    }

    #[test]
    fn stop_when_not_recording_is_forbidden() {
        let err = active().stop_recording().unwrap_err();
        assert_eq!(
            err,
            TelephonyError::RecordingForbidden("call is not being recorded")
        );
    }

    #[test]
    fn emergency_call_can_never_be_recorded() {
        let mut s =
            CallSession::start_outgoing(CallId::new("e1"), Number::new("110").unwrap(), true);
        assert!(s.connect().is_ok());
        let err = s.start_recording().unwrap_err();
        assert_eq!(
            err,
            TelephonyError::RecordingForbidden("emergency calls must never be recorded")
        );
        assert_eq!(s.recording(), RecordingState::Off);
    }

    #[test]
    fn recording_failure_is_surfacable_and_retryable() {
        let mut s = active();
        assert!(s.start_recording().is_ok());
        assert!(s.recording_failed().is_ok());
        assert_eq!(s.recording(), RecordingState::Failed);
        // A failed recording can be retried from scratch.
        assert!(s.start_recording().is_ok());
        assert_eq!(s.recording(), RecordingState::On);
        // No active recording -> cannot mark failed.
        let mut fresh = active();
        assert!(fresh.recording_failed().is_err());
    }

    #[test]
    fn ending_a_call_resets_recording() {
        let mut s = active();
        assert!(s.start_recording().is_ok());
        assert_eq!(s.recording(), RecordingState::On);
        assert!(s.end(EndReason::Local).is_ok());
        assert_eq!(
            s.recording(),
            RecordingState::Off,
            "recording must not outlive call"
        );
    }
}
