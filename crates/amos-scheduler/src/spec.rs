//! Scheduler spec types: [`JobId`], the alarm-vs-deferred [`JobType`], and the
//! device-power/doze [`PowerState`] the deferred-work gate consults.

use std::fmt;

/// Identity of one registered background job / alarm.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct JobId(pub String);

impl JobId {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for JobId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for JobId {
    fn from(s: &str) -> Self {
        Self::new(s)
    }
}

/// The two job kinds — the alarm taxonomy a scheduler must honour.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum JobType {
    /// A user-visible alarm / reminder. Runs once its time arrives; during Doze
    /// the caller is still expected to surface it (subject to its own cadence).
    AlarmExact,
    /// Deferred background work (sync / cleanup / non-urgent inference). Must not
    /// arbitrarily wake the device: runs only when not dozing, or while charging,
    /// or inside an open maintenance window.
    Deferred,
}

impl JobType {
    pub const ALL: [JobType; 2] = [JobType::AlarmExact, JobType::Deferred];

    /// Stable wire/UI key.
    pub fn key(self) -> &'static str {
        match self {
            JobType::AlarmExact => "alarm_exact",
            JobType::Deferred => "deferred",
        }
    }

    pub fn from_key(s: &str) -> Option<JobType> {
        match s {
            "alarm_exact" => Some(JobType::AlarmExact),
            "deferred" => Some(JobType::Deferred),
            _ => None,
        }
    }
}

/// What the device power / Doze subsystem reports on this tick.
///
/// `now` is caller-supplied monotonic ticks; Doze state is external (from the OS /
/// the `amos-power` governor's `throttle_background`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct PowerState {
    /// The device is idle / in Doze (background work should be avoided).
    pub dozing: bool,
    /// A maintenance window is open (deferred work may coalesce and run now).
    pub maintenance_open: bool,
    /// A charger is attached (deferred work is cheap on battery-life).
    pub charging: bool,
}

impl PowerState {
    /// A fresh, fully-awake state (not dozing, no window, not charging).
    pub fn awake() -> Self {
        Self::default()
    }

    /// Whether a deferred (non-urgent) job may run right now.
    ///
    /// Deferred work is allowed when charging, when not dozing at all, or inside
    /// an open maintenance window. It is withheld while the device idles with no
    /// window — this is the core of Doze-compliant background scheduling.
    pub fn deferred_runnable(self) -> bool {
        if self.charging {
            true
        } else if self.dozing {
            self.maintenance_open
        } else {
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_type_keys_round_trip() {
        for jt in JobType::ALL {
            assert_eq!(JobType::from_key(jt.key()), Some(jt));
        }
        assert_eq!(JobType::from_key("foreground"), None);
    }

    #[test]
    fn deferred_runnable_gating() {
        // Charging always lets deferred work run.
        assert!(PowerState {
            charging: true,
            ..PowerState::awake()
        }
        .deferred_runnable());
        // Not dozing → runnable.
        assert!(PowerState::awake().deferred_runnable());
        // Dozing, no window → withheld.
        assert!(!PowerState {
            dozing: true,
            maintenance_open: false,
            charging: false,
        }
        .deferred_runnable());
        // Dozing but a maintenance window is open → runnable (coalesced batch).
        assert!(PowerState {
            dozing: true,
            maintenance_open: true,
            charging: false,
        }
        .deferred_runnable());
    }
}
