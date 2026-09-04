//! Scheduler error type.

use std::fmt;

/// A scheduler-operation failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SchedulerError {
    /// A job's window is invalid (`latest < earliest`).
    InvalidWindow {
        id: String,
        earliest: u64,
        latest: u64,
    },
}

impl fmt::Display for SchedulerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SchedulerError::InvalidWindow {
                id,
                earliest,
                latest,
            } => write!(f, "invalid window for {id}: [{earliest}, {latest}]"),
        }
    }
}

impl std::error::Error for SchedulerError {}
