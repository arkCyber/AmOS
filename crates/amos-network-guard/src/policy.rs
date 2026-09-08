//! Pure, host-testable egress **policy model**.
//!
//! Rules are expressed as the fields an egress gate can *actually observe* —
//! a domain (via DNS/SNI), an IP address, or a TLS Server Name — **never** as raw
//! URL strings. That is a deliberate, load-bearing choice: `iptables -d` matches an
//! IP, not a URL, and it does no DNS resolution, so a "block list" of `://…` strings
//! (as seen in an early draft of this feature) is not only useless but actively
//! wrong — it would silently match nothing while looking authoritative. No code in
//! this crate ever encodes that shape.

use std::net::IpAddr;

/// A destination an egress rule can match.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Destination {
    /// A domain, normalized (lower-cased, trailing dot stripped). Matched against
    /// DNS queries / SNI / observed hostnames via [`domain_matches`].
    Domain(String),
    /// A concrete IP address (v4 or v6), matched by its textual form.
    Ip(IpAddr),
    /// A TLS Server Name Indication observed in a ClientHello.
    TlsSnI(String),
}

impl Destination {
    /// Build a [`Destination::Domain`], normalizing the input.
    pub fn domain(raw: impl Into<String>) -> Self {
        Destination::Domain(normalize_domain(&raw.into()))
    }
}

/// What to do with traffic matching a [`Policy`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    /// Let matching traffic through.
    Allow,
    /// Drop matching traffic at the data-plane gate.
    Block,
}

/// One app-scoped egress rule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// The Android uid the rule applies to.
    pub uid: u32,
    /// Allow or block.
    pub effect: Effect,
    /// The destination to match.
    pub destination: Destination,
}

impl Policy {
    /// An allow rule for `uid` toward `destination`.
    pub fn allow(uid: u32, destination: Destination) -> Self {
        Policy {
            uid,
            effect: Effect::Allow,
            destination,
        }
    }

    /// A block rule for `uid` toward `destination`.
    pub fn block(uid: u32, destination: Destination) -> Self {
        Policy {
            uid,
            effect: Effect::Block,
            destination,
        }
    }
}

/// Normalize a domain for matching: trim whitespace, strip a single trailing dot,
/// and lower-case. Pure and total (no panics).
pub fn normalize_domain(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_trailing_dot = trimmed.strip_suffix('.').unwrap_or(trimmed);
    without_trailing_dot.to_ascii_lowercase()
}

/// Does an observed hostname match a rule domain? Exact match or any subdomain
/// (i.e. rule `qualcomm.com` matches `qualcomm.com` and `telemetry.qualcomm.com`,
/// but not `notqualcomm.com`). Pure and total.
pub fn domain_matches(rule_domain: &str, observed: &str) -> bool {
    let rule = normalize_domain(rule_domain);
    let observed = normalize_domain(observed);
    if rule.is_empty() {
        return false;
    }
    if observed == rule {
        return true;
    }
    // observed ends with ".<rule>"? e.g. "x.qualcomm.com" ends with "qualcomm.com".
    observed
        .strip_suffix(&rule)
        .is_some_and(|prefix| prefix.ends_with('.'))
}

/// A uid-scoped, ordered set of rules. First match wins; evaluation is pure and
/// never panics.
#[derive(Debug, Default)]
pub struct RuleSet {
    rules: Vec<Policy>,
}

impl RuleSet {
    /// An empty rule set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Append a rule. Later rules are lower priority than earlier ones.
    pub fn insert(&mut self, rule: Policy) {
        self.rules.push(rule);
    }

    /// All rules, in insertion order.
    pub fn rules(&self) -> &[Policy] {
        &self.rules
    }

    /// Number of rules.
    pub fn len(&self) -> usize {
        self.rules.len()
    }

    /// Whether there are no rules.
    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// The effect of the **first** rule matching `(uid, destination)`, if any.
    ///
    /// Returns `None` when nothing matches — the caller decides the default
    /// (typically allow-list / deny-by-default policy at the transport layer).
    pub fn effect_for(&self, uid: u32, destination: &Destination) -> Option<Effect> {
        for rule in &self.rules {
            if rule.uid == uid && destination_matches(&rule.destination, destination) {
                return Some(rule.effect);
            }
        }
        None
    }

    /// Whether `(uid, destination)` is explicitly blocked by the first matching rule.
    pub fn blocked(&self, uid: u32, destination: &Destination) -> bool {
        self.effect_for(uid, destination) == Some(Effect::Block)
    }
}

/// Does a rule's destination pattern match an observed destination? Domain rules
/// match via [`domain_matches`]; IP and SNI rules compare for equality.
fn destination_matches(rule: &Destination, observed: &Destination) -> bool {
    match rule {
        Destination::Domain(d) => match observed {
            Destination::Domain(obs) => domain_matches(d, obs),
            Destination::TlsSnI(obs) => domain_matches(d, obs),
            Destination::Ip(_) => false,
        },
        Destination::Ip(ip) => observed == &Destination::Ip(*ip),
        Destination::TlsSnI(sni) => match observed {
            Destination::TlsSnI(obs) => domain_matches(sni, obs),
            Destination::Domain(obs) => domain_matches(sni, obs),
            Destination::Ip(_) => false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_domains(domains: &[&str]) -> RuleSet {
        let mut set = RuleSet::new();
        for d in domains {
            set.insert(Policy::block(10_000, Destination::domain(*d)));
        }
        set
    }

    #[test]
    fn normalizes_lowercase_and_trailing_dot() {
        assert_eq!(normalize_domain(" QualComm.com. "), "qualcomm.com");
        assert_eq!(normalize_domain("MEDIATEK.com"), "mediatek.com");
    }

    #[test]
    fn domain_matching_is_exact_or_subdomain_only() {
        assert!(domain_matches("qualcomm.com", "qualcomm.com"));
        assert!(domain_matches("qualcomm.com", "telemetry.qualcomm.com"));
        assert!(!domain_matches("qualcomm.com", "notqualcomm.com"));
        assert!(!domain_matches("qualcomm.com", "qualcomm.com.evil.example"));
    }

    #[test]
    fn empty_rule_never_matches() {
        assert!(!domain_matches("", "example.com"));
    }

    #[test]
    fn domain_rule_blocks_subdomains_and_exact() {
        let set = block_domains(&["qualcomm.com", "mediatek.com"]);
        let dom = |d: &str| Destination::domain(d);
        assert!(set.blocked(10_000, &dom("telemetry.qualcomm.com")));
        assert!(set.blocked(10_000, &dom("qualcomm.com")));
        assert!(set.blocked(10_000, &dom("example.mediatek.com")));
        assert!(!set.blocked(10_000, &dom("example.com")));
    }

    #[test]
    fn rules_are_uid_scoped() {
        let mut set = RuleSet::new();
        set.insert(Policy::block(1000, Destination::domain("a.example")));
        assert!(set.blocked(1000, &Destination::domain("a.example")));
        assert!(!set.blocked(2000, &Destination::domain("a.example")));
    }

    #[test]
    fn snis_and_domains_share_the_domain_matcher() {
        let set = block_domains(&["tracker.example"]);
        assert!(set.blocked(10_000, &Destination::TlsSnI("tracker.example".into())));
        assert!(set.blocked(10_000, &Destination::TlsSnI("a.tracker.example".into())));
        assert!(!set.blocked(10_000, &Destination::TlsSnI("other.example".into())));
    }

    #[test]
    fn ip_rules_match_textually() {
        let ip: IpAddr = "203.0.113.50".parse().unwrap();
        let mut set = RuleSet::new();
        set.insert(Policy::block(9, Destination::Ip(ip)));
        assert!(set.blocked(9, &Destination::Ip(ip)));
        let other: IpAddr = "203.0.113.51".parse().unwrap();
        assert!(!set.blocked(9, &Destination::Ip(other)));
    }

    #[test]
    fn first_match_wins() {
        let mut set = RuleSet::new();
        // A broad allow inserted first beats a later block for the same uid+dest.
        set.insert(Policy::allow(5, Destination::domain("example.com")));
        set.insert(Policy::block(5, Destination::domain("example.com")));
        assert_eq!(
            set.effect_for(5, &Destination::domain("example.com")),
            Some(Effect::Allow)
        );
    }

    #[test]
    fn no_match_is_none() {
        let set = RuleSet::new();
        assert_eq!(set.effect_for(1, &Destination::domain("example.com")), None);
    }
}
