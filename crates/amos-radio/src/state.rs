//! Radio state types: which subsystems AmOS exposes as toggles, and the
//! point-in-time snapshot of their on/off state.

/// A switchable radio subsystem under AmOS control.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RadioMode {
    Wifi,
    Bluetooth,
    Airplane,
}

impl RadioMode {
    /// Every radio the quick-settings / System UI can drive.
    pub const ALL: [RadioMode; 3] = [RadioMode::Wifi, RadioMode::Bluetooth, RadioMode::Airplane];

    /// Stable wire/UI key (matches the frontend `QuickKey` values).
    pub fn key(self) -> &'static str {
        match self {
            RadioMode::Wifi => "wifi",
            RadioMode::Bluetooth => "bluetooth",
            RadioMode::Airplane => "airplane",
        }
    }

    /// Parse from the wire/UI key; `None` for unknown strings.
    pub fn from_key(s: &str) -> Option<RadioMode> {
        match s {
            "wifi" => Some(RadioMode::Wifi),
            "bluetooth" => Some(RadioMode::Bluetooth),
            "airplane" => Some(RadioMode::Airplane),
            _ => None,
        }
    }
}

/// Point-in-time on/off state of every radio under AmOS control.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RadioSnapshot {
    pub wifi: bool,
    pub bluetooth: bool,
    pub airplane: bool,
}

impl RadioSnapshot {
    /// Read one radio's bit.
    pub fn get(self, radio: RadioMode) -> bool {
        match radio {
            RadioMode::Wifi => self.wifi,
            RadioMode::Bluetooth => self.bluetooth,
            RadioMode::Airplane => self.airplane,
        }
    }

    /// Set one radio's bit, returning the new snapshot.
    pub fn with(self, radio: RadioMode, on: bool) -> RadioSnapshot {
        match radio {
            RadioMode::Wifi => RadioSnapshot { wifi: on, ..self },
            RadioMode::Bluetooth => RadioSnapshot {
                bluetooth: on,
                ..self
            },
            RadioMode::Airplane => RadioSnapshot {
                airplane: on,
                ..self
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip() {
        for m in RadioMode::ALL {
            assert_eq!(RadioMode::from_key(m.key()), Some(m));
        }
        assert_eq!(RadioMode::from_key("nfc"), None);
    }

    #[test]
    fn snapshot_get_with_is_orthogonal() {
        let s = RadioSnapshot::default().with(RadioMode::Wifi, true);
        assert!(s.get(RadioMode::Wifi));
        assert!(!s.get(RadioMode::Bluetooth));
        assert!(!s.get(RadioMode::Airplane));

        let s = s
            .with(RadioMode::Airplane, true)
            .with(RadioMode::Wifi, false);
        assert!(!s.get(RadioMode::Wifi));
        assert!(s.get(RadioMode::Airplane));
        assert!(!s.get(RadioMode::Bluetooth));
    }
}
