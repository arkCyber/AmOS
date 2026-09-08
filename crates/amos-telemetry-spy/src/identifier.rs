//! Device-bound identifiers the passive spy watches for in outbound payloads.
//!
//! These are the hard-coded values a chip vendor or app could leak: the
//! hardware serial number, the IMEI, and the currently-serving base-station
//! Cell ID. They are stored as **raw byte tokens** (not strings) so the same
//! value can be searched inside arbitrary binary payloads without lossy UTF-8
//! conversion.

use crate::error::{Error, Result};

/// Which device-bound identifier a value belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IdentifierKind {
    /// Hardware serial number.
    Serial,
    /// IMEI (15 decimal digits).
    Imei,
    /// Currently-serving base-station cell ID.
    CellId,
}

impl IdentifierKind {
    /// The kinds the scanner understands, in declaration order.
    pub const ALL: [IdentifierKind; 3] = [
        IdentifierKind::Serial,
        IdentifierKind::Imei,
        IdentifierKind::CellId,
    ];

    /// Stable machine key for logs / a future wire mapping.
    pub fn as_str(self) -> &'static str {
        match self {
            IdentifierKind::Serial => "serial",
            IdentifierKind::Imei => "imei",
            IdentifierKind::CellId => "cell_id",
        }
    }

    /// Parse a machine key back into a kind (also accepts `cellid`).
    pub fn parse_key(s: &str) -> Option<IdentifierKind> {
        match s.trim().to_ascii_lowercase().as_str() {
            "serial" => Some(IdentifierKind::Serial),
            "imei" => Some(IdentifierKind::Imei),
            "cell_id" | "cellid" => Some(IdentifierKind::CellId),
            _ => None,
        }
    }

    /// Short human description used in the audit event.
    pub fn description(self) -> &'static str {
        match self {
            IdentifierKind::Serial => "hardware serial",
            IdentifierKind::Imei => "IMEI",
            IdentifierKind::CellId => "serving cell ID",
        }
    }
}

/// One concrete device-bound identifier value to search for, as raw bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identifier {
    /// What this value identifies.
    pub kind: IdentifierKind,
    /// The exact byte token to look for inside outbound payloads.
    pub value: Vec<u8>,
}

impl Identifier {
    /// Build from already-decoded bytes. Rejects empty tokens.
    pub fn new(kind: IdentifierKind, value: Vec<u8>) -> Result<Identifier> {
        if value.is_empty() {
            return Err(Error::InvalidArgument(format!(
                "{} identifier must be non-empty",
                kind.as_str()
            )));
        }
        Ok(Identifier { kind, value })
    }

    /// Build from an ASCII/UTF-8 textual value (e.g. a 15-digit IMEI string).
    pub fn ascii(kind: IdentifierKind, value: impl AsRef<str>) -> Result<Identifier> {
        let text = value.as_ref();
        if text.is_empty() {
            return Err(Error::InvalidArgument(format!(
                "{} identifier must be non-empty",
                kind.as_str()
            )));
        }
        Identifier::new(kind, text.as_bytes().to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_round_trips_and_rejects_empty() {
        let id = Identifier::ascii(IdentifierKind::Imei, "490154203237518").unwrap();
        assert_eq!(id.kind, IdentifierKind::Imei);
        assert_eq!(id.value, b"490154203237518".to_vec());
        assert!(Identifier::ascii(IdentifierKind::Serial, "").is_err());
        assert!(Identifier::new(IdentifierKind::CellId, Vec::new()).is_err());
    }

    #[test]
    fn kind_keys_round_trip() {
        for k in IdentifierKind::ALL {
            assert_eq!(IdentifierKind::parse_key(k.as_str()), Some(k));
        }
        assert_eq!(
            IdentifierKind::parse_key("CELLID"),
            Some(IdentifierKind::CellId)
        );
        assert_eq!(IdentifierKind::parse_key("bogus"), None);
    }

    #[test]
    fn descriptions_are_present() {
        for k in IdentifierKind::ALL {
            assert!(!k.description().is_empty());
        }
    }
}
