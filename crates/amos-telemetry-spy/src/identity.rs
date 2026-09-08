//! Source of the device-bound identifiers the spy watches for.
//!
//! This is the **seam** between the pure scan logic and wherever the real
//! serial / IMEI / serving-cell-ID come from. On the real device those are
//! fetched by platform code (TelephonyManager / Build / modem CellInfo) — a
//! device bring-up concern — so the domain core only talks to a
//! [`DeviceIdentity`] trait. Host builds use [`StaticIdentity`] (env/config
//! driven) or [`MockIdentity`] (clearly synthetic sample values).

use crate::error::Result;
use crate::identifier::{Identifier, IdentifierKind};

/// Supplies the concrete identifiers to watch for.
pub trait DeviceIdentity: Send + Sync {
    /// The identifiers to scan outbound payloads for.
    fn identifiers(&self) -> Vec<Identifier>;
}

/// A fixed identifier list (e.g. parsed from config / env on a real device).
#[derive(Clone, Debug, Default)]
pub struct StaticIdentity {
    ids: Vec<Identifier>,
}

impl StaticIdentity {
    /// A fresh, empty identity set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add one identifier (returns the error from [`Identifier::ascii`] on empty).
    pub fn add_ascii(mut self, kind: IdentifierKind, value: &str) -> Result<Self> {
        self.ids.push(Identifier::ascii(kind, value)?);
        Ok(self)
    }

    /// Parse `("serial"|"imei"|"cell_id", value)` pairs into an identity set.
    pub fn parse(pairs: &[(&str, String)]) -> Result<Self> {
        let mut s = Self::new();
        for (key, value) in pairs {
            let kind = IdentifierKind::parse_key(key).ok_or_else(|| {
                crate::error::Error::InvalidArgument(format!("unknown identifier key: {key}"))
            })?;
            s.ids.push(Identifier::ascii(kind, value)?);
        }
        Ok(s)
    }
}

impl DeviceIdentity for StaticIdentity {
    fn identifiers(&self) -> Vec<Identifier> {
        self.ids.clone()
    }
}

/// Deterministic, **clearly synthetic** sample identity for host tests / demos.
///
/// The values are obviously fake (all-zero digits) so nobody mistakes a demo
/// scan for a real device leak.
#[derive(Clone, Copy, Debug, Default)]
pub struct MockIdentity;

impl MockIdentity {
    /// The fallible builder for the sample identifiers. Kept as `Result` so no
    /// malformed value is ever silently dropped by a caller; the values here
    /// are compile-time non-empty and therefore never actually fail.
    pub fn sample() -> Result<Vec<Identifier>> {
        [
            (IdentifierKind::Serial, "SN-0000-0000-0000"),
            (IdentifierKind::Imei, "000000000000000"),
            (IdentifierKind::CellId, "0000000000"),
        ]
        .into_iter()
        .map(|(kind, value)| Identifier::ascii(kind, value))
        .collect::<Result<Vec<Identifier>>>()
    }
}

impl DeviceIdentity for MockIdentity {
    fn identifiers(&self) -> Vec<Identifier> {
        // The [`DeviceIdentity`] trait is infallible; values are compile-time
        // non-empty so `sample()` cannot fail. The unit test below asserts the
        // full serial/imei/cell_id set is present, so a future edit that
        // empties a sample is caught there rather than silently mis-scanning.
        Self::sample().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_identity_holds_what_was_added() {
        let id = StaticIdentity::new()
            .add_ascii(IdentifierKind::Imei, "490154203237518")
            .unwrap();
        let out = id.identifiers();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, IdentifierKind::Imei);
    }

    #[test]
    fn static_identity_parse_rejects_unknown_keys() {
        assert!(StaticIdentity::parse(&[("bogus", "x".to_string())]).is_err());
        let ok = StaticIdentity::parse(&[
            ("imei", "490154203237518".to_string()),
            ("cellid", "1234".to_string()),
        ])
        .unwrap();
        assert_eq!(ok.identifiers().len(), 2);
    }

    #[test]
    fn mock_identity_is_fake_but_complete() {
        let ids = MockIdentity.identifiers();
        assert!(!ids.is_empty());
        for id in &ids {
            assert!(!id.value.is_empty());
        }
        // The full watch-set must be present so the demo/tests scan for all
        // three device-bound identifier kinds.
        let kinds: Vec<IdentifierKind> = ids.iter().map(|i| i.kind).collect();
        assert!(kinds.contains(&IdentifierKind::Serial));
        assert!(kinds.contains(&IdentifierKind::Imei));
        assert!(kinds.contains(&IdentifierKind::CellId));
    }
}
