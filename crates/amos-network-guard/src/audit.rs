//! Structured outbound **audit** events and a running counter.
//!
//! Signals are **metadata** (destination domain/SNI, per-app bytes, event kind) —
//! not magic-string payload scanning. Per `docs/anti-telemetry-egress-guard.md`
//! §3.2, grepping packet payloads for an IMEI/CellID string is treated as a
//! brittle, low-confidence heuristic and is deliberately **not** the primary
//! detector here; encrypted flows do not expose plaintext, and naive scanning
//! over-reports.

use std::collections::BTreeMap;

/// The transport signal that produced an [`EgressEvent`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EgressKind {
    /// A DNS query for a hostname.
    Dns,
    /// A TLS ClientHello (SNI observed).
    Tls,
    /// Other data-plane traffic not classified by a higher-level signal.
    Other,
}

/// One audited outbound event from the userspace data plane.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EgressEvent {
    /// Wall-clock milliseconds (UTC) when observed.
    pub ts_ms: u64,
    /// The Android uid that produced the traffic.
    pub uid: u32,
    /// The app package name, when resolvable.
    pub app: String,
    /// The observed destination domain / SNI, when one was present.
    pub domain: Option<String>,
    /// Bytes attributed to this event (0 when unknown).
    pub bytes: u64,
    /// What kind of signal produced this event.
    pub kind: EgressKind,
}

impl EgressEvent {
    /// A minimal event with no domain yet (callers fill fields).
    pub fn dns(ts_ms: u64, uid: u32, domain: impl Into<String>) -> Self {
        EgressEvent {
            ts_ms,
            uid,
            app: String::new(),
            domain: Some(domain.into()),
            bytes: 0,
            kind: EgressKind::Dns,
        }
    }
}

/// Running, order-independent byte/event tallies per uid and per domain.
#[derive(Debug, Default)]
pub struct EgressCounter {
    total_events: u64,
    total_bytes: u64,
    per_uid: BTreeMap<u32, u64>,
    per_domain: BTreeMap<String, u64>,
}

impl EgressCounter {
    /// A fresh counter.
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one event into the totals.
    pub fn record(&mut self, event: &EgressEvent) {
        self.total_events = self.total_events.saturating_add(1);
        self.total_bytes = self.total_bytes.saturating_add(event.bytes);
        self.per_uid
            .entry(event.uid)
            .and_modify(|bytes| *bytes = bytes.saturating_add(event.bytes))
            .or_insert(event.bytes);
        if let Some(domain) = &event.domain {
            self.per_domain
                .entry(domain.clone())
                .and_modify(|bytes| *bytes = bytes.saturating_add(event.bytes))
                .or_insert(event.bytes);
        }
    }

    /// Number of events seen.
    pub fn events(&self) -> u64 {
        self.total_events
    }

    /// Total bytes across all events.
    pub fn bytes(&self) -> u64 {
        self.total_bytes
    }

    /// Bytes attributed to one uid.
    pub fn uid_bytes(&self, uid: u32) -> u64 {
        self.per_uid.get(&uid).copied().unwrap_or(0)
    }

    /// Bytes attributed to one exact domain.
    pub fn domain_bytes(&self, domain: &str) -> u64 {
        self.per_domain.get(domain).copied().unwrap_or(0)
    }

    /// The top `n` domains by bytes, descending. Pure and total (no panics).
    pub fn top_domains(&self, n: usize) -> Vec<(String, u64)> {
        let mut ranked: Vec<(String, u64)> = self
            .per_domain
            .iter()
            .map(|(d, b)| (d.clone(), *b))
            .collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        ranked.truncate(n);
        ranked
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_bytes_and_events() {
        let mut c = EgressCounter::new();
        c.record(&EgressEvent {
            ts_ms: 1,
            uid: 10,
            app: "a".into(),
            domain: Some("x.example".into()),
            bytes: 100,
            kind: EgressKind::Dns,
        });
        c.record(&EgressEvent {
            ts_ms: 2,
            uid: 10,
            app: "a".into(),
            domain: Some("y.example".into()),
            bytes: 50,
            kind: EgressKind::Tls,
        });
        c.record(&EgressEvent {
            ts_ms: 3,
            uid: 20,
            app: "b".into(),
            domain: None,
            bytes: 25,
            kind: EgressKind::Other,
        });
        assert_eq!(c.events(), 3);
        assert_eq!(c.bytes(), 175);
        assert_eq!(c.uid_bytes(10), 150);
        assert_eq!(c.uid_bytes(20), 25);
        assert_eq!(c.uid_bytes(999), 0);
        assert_eq!(c.domain_bytes("x.example"), 100);
        assert_eq!(c.domain_bytes("missing.example"), 0);
    }

    #[test]
    fn top_domains_is_descending_and_truncated() {
        let mut c = EgressCounter::new();
        for (d, b) in [("a.example", 10), ("b.example", 30), ("c.example", 20)] {
            c.record(&EgressEvent {
                ts_ms: 1,
                uid: 1,
                app: "".into(),
                domain: Some(d.into()),
                bytes: b,
                kind: EgressKind::Other,
            });
        }
        let top = c.top_domains(2);
        assert_eq!(
            top,
            vec![("b.example".to_string(), 30), ("c.example".to_string(), 20)]
        );
    }
}
