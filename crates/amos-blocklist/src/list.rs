//! The blocklist itself: bounded, deduplicating, JSON round-trippable.

use serde::{Deserialize, Serialize};

use crate::error::BlocklistError;
use crate::rule::{
    digits_of, normalize_number, BlockReason, Channel, MatchKind, Rule, DEFAULT_CAP,
};

/// The persisted rule set (serde shape of `blocklist.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Persisted {
    /// Schema version so a future change can migrate honestly.
    #[serde(default = "Persisted::default_version")]
    version: u32,
    #[serde(default)]
    block_unknown: bool,
    #[serde(default)]
    rules: Vec<Rule>,
}

impl Persisted {
    fn default_version() -> u32 {
        1
    }
}

/// A bounded set of blocking rules for calls and SMS.
#[derive(Debug, Clone)]
pub struct Blocklist {
    rules: Vec<Rule>,
    block_unknown: bool,
    cap: usize,
}

impl Default for Blocklist {
    fn default() -> Self {
        Self::new()
    }
}

impl Blocklist {
    /// Empty list with the default cap.
    pub fn new() -> Self {
        Self::with_cap(DEFAULT_CAP)
    }

    /// Empty list with an explicit cap (tests / unusual devices).
    pub fn with_cap(cap: usize) -> Self {
        Self {
            rules: Vec::new(),
            block_unknown: false,
            cap: cap.max(1),
        }
    }

    /// Whether withheld/unknown numbers are blocked.
    pub fn block_unknown(&self) -> bool {
        self.block_unknown
    }

    /// Turn unknown-number blocking on/off.
    pub fn set_block_unknown(&mut self, on: bool) {
        self.block_unknown = on;
    }

    /// The rules, newest first (display order).
    pub fn rules(&self) -> Vec<Rule> {
        let mut out = self.rules.clone();
        out.sort_by_key(|r| std::cmp::Reverse(r.created_ms));
        out
    }

    /// Number of rules.
    pub fn len(&self) -> usize {
        self.rules.len()
    }

    /// `true` when no rule is stored (unknown-blocking is separate).
    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// Add (or refresh) a rule. Returns the stored rule.
    ///
    /// The pattern is normalized; a duplicate (same digits + kind + channel)
    /// updates the label/creation time instead of piling up. Past the cap the
    /// **oldest** rule is evicted (deterministic, documented).
    pub fn add(
        &mut self,
        pattern: &str,
        kind: MatchKind,
        channel: Channel,
        label: &str,
        now_ms: i64,
    ) -> Result<Rule, BlocklistError> {
        let normalized = normalize_number(pattern).ok_or_else(|| {
            BlocklistError::InvalidPattern(format!("{pattern:?} is not a usable number"))
        })?;
        let digits = digits_of(&normalized);
        if kind == MatchKind::Prefix && digits.len() < crate::rule::MIN_PREFIX_DIGITS {
            return Err(BlocklistError::InvalidPattern(format!(
                "prefix {digits:?} is shorter than {} digits",
                crate::rule::MIN_PREFIX_DIGITS
            )));
        }
        let id = Rule::make_id(&digits, kind, channel);
        let rule = Rule {
            id: id.clone(),
            pattern: normalized,
            digits,
            kind,
            channel,
            label: label.trim().to_string(),
            created_ms: now_ms,
        };
        self.rules.retain(|r| r.id != id);
        self.rules.push(rule.clone());
        self.enforce_cap();
        Ok(rule)
    }

    /// Remove a rule by id; `true` when something was removed.
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.rules.len();
        self.rules.retain(|r| r.id != id);
        self.rules.len() != before
    }

    /// Drop every rule (keeps the `block_unknown` flag).
    pub fn clear(&mut self) {
        self.rules.clear();
    }

    /// Check an address for a given traffic channel.
    ///
    /// `None` = allow. An unparseable address is `Unknown` when
    /// [`Self::block_unknown`] is on, else allowed (never blocked by accident).
    pub fn check(&self, address: &str, traffic: Channel) -> Option<BlockReason> {
        let Some(normalized) = normalize_number(address) else {
            return self.block_unknown.then_some(BlockReason::Unknown);
        };
        let digits = digits_of(&normalized);
        // Newest rule first so a freshly added rule wins in the explanation.
        let mut ordered = self.rules.clone();
        ordered.sort_by_key(|r| std::cmp::Reverse(r.created_ms));
        for r in ordered {
            if r.channel.covers(traffic) && r.matches_digits(&digits) {
                return Some(BlockReason::Rule {
                    id: r.id,
                    pattern: r.pattern,
                    label: r.label,
                    channel: r.channel,
                });
            }
        }
        None
    }

    /// Convenience: is this address blocked for `traffic`?
    pub fn is_blocked(&self, address: &str, traffic: Channel) -> bool {
        self.check(address, traffic).is_some()
    }

    /// `true` when any rule covers `traffic` (used to decide whether the call
    /// screening role is worth requesting at all).
    pub fn has_rules_for(&self, traffic: Channel) -> bool {
        self.rules.iter().any(|r| r.channel.covers(traffic))
    }

    /// Serialize to the persisted JSON (pretty, so the file stays inspectable).
    pub fn to_json(&self) -> String {
        let p = Persisted {
            version: Persisted::default_version(),
            block_unknown: self.block_unknown,
            rules: self.rules(),
        };
        serde_json::to_string_pretty(&p).unwrap_or_else(|_| "{}".to_string())
    }

    /// Parse a persisted payload. **Never trusts it blindly**: an unknown
    /// version, a malformed rule, or more rules than the cap is an honest error
    /// (rather than silently dropping rules the user believes are active).
    pub fn from_json(payload: &str, cap: usize) -> Result<Self, BlocklistError> {
        let p: Persisted = serde_json::from_str(payload)
            .map_err(|e| BlocklistError::InvalidPayload(format!("unparseable: {e}")))?;
        if p.version != Persisted::default_version() {
            return Err(BlocklistError::InvalidPayload(format!(
                "unsupported schema version {}",
                p.version
            )));
        }
        let cap = cap.max(1);
        if p.rules.len() > cap {
            return Err(BlocklistError::InvalidPayload(format!(
                "{} rules exceed the cap of {cap}",
                p.rules.len()
            )));
        }
        let mut list = Self::with_cap(cap);
        list.set_block_unknown(p.block_unknown);
        for r in p.rules {
            // Re-derive from the pattern so a hand-edited file cannot inject an
            // inconsistent digits/id pair.
            list.add(&r.pattern, r.kind, r.channel, &r.label, r.created_ms)?;
        }
        Ok(list)
    }

    /// Keep at most `cap` rules, evicting the oldest first.
    fn enforce_cap(&mut self) {
        while self.rules.len() > self.cap {
            if let Some((idx, _)) = self
                .rules
                .iter()
                .enumerate()
                .min_by_key(|(i, r)| (r.created_ms, *i))
            {
                self.rules.remove(idx);
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rule::{normalize_number, same_number};

    #[test]
    fn exact_rules_match_the_same_number_in_national_or_e164_form() {
        // Verified on device: the outgoing PDU is `+86…`, the incoming one is the
        // domestic `186…` form — an exact rule must catch both.
        let l = list_with("+8618616091470", MatchKind::Exact, Channel::Sms);
        assert!(l.is_blocked("18616091470", Channel::Sms));
        assert!(l.is_blocked("+8618616091470", Channel::Sms));
        assert!(l.is_blocked("8618616091470", Channel::Sms));
        assert!(l.is_blocked("008618616091470", Channel::Sms));
        // …but never a *different* subscriber.
        assert!(!l.is_blocked("18616091471", Channel::Sms));
        assert!(!l.is_blocked("10086", Channel::Sms));
        // A rule written in national form matches the E.164 address too.
        let nat = list_with("13800138000", MatchKind::Exact, Channel::Call);
        assert!(nat.is_blocked("+8613800138000", Channel::Call));
        assert!(!nat.is_blocked("+8613800138001", Channel::Call));
    }

    #[test]
    fn prefix_rules_tolerate_a_leading_country_code_but_stay_conservative() {
        let l = list_with("1069", MatchKind::Prefix, Channel::Sms);
        assert!(l.is_blocked("106942053200156", Channel::Sms));
        assert!(l.is_blocked("86106942053200156", Channel::Sms)); // +86 1069…
                                                                  // Short/unrelated numbers are untouched.
        assert!(!l.is_blocked("10086", Channel::Sms));
        assert!(!l.is_blocked("8610086", Channel::Sms));
        assert!(!l.is_blocked("106", Channel::Sms));
    }

    #[test]
    fn same_number_is_conservative() {
        assert!(same_number("8613800138000", "13800138000"));
        assert!(same_number("13800138000", "13800138000"));
        assert!(same_number("008613800138000", "13800138000"));
        assert!(!same_number("10086", "8610087"));
        assert!(!same_number("", "10086"));
        assert!(!same_number("10086", ""));
    }

    fn list_with(pattern: &str, kind: MatchKind, channel: Channel) -> Blocklist {
        let mut l = Blocklist::new();
        l.add(pattern, kind, channel, "spam", 1).unwrap();
        l
    }

    #[test]
    fn normalization_accepts_human_formats_and_rejects_junk() {
        assert_eq!(
            normalize_number(" +86 138-0013-8000 ").unwrap(),
            "+8613800138000"
        );
        assert_eq!(normalize_number("(10086)").unwrap(), "10086");
        assert_eq!(normalize_number("10086.").unwrap(), "10086");
        assert!(normalize_number("").is_none());
        assert!(normalize_number("12").is_none()); // too short
        assert!(normalize_number("abc").is_none());
        assert!(normalize_number("86+138").is_none()); // `+` must lead
        assert!(normalize_number(&"1".repeat(21)).is_none());
    }

    #[test]
    fn exact_rule_matches_any_equivalent_number_form() {
        let l = list_with("+8613800138000", MatchKind::Exact, Channel::Both);
        assert!(l.is_blocked("+86 138-0013-8000", Channel::Sms));
        assert!(l.is_blocked("8613800138000", Channel::Call));
        assert!(!l.is_blocked("+8613800138001", Channel::Call));
        assert!(!l.is_blocked("10086", Channel::Call));
    }

    #[test]
    fn prefix_rule_matches_service_ranges_but_never_shorts() {
        let l = list_with("1069", MatchKind::Prefix, Channel::Sms);
        assert!(l.is_blocked("106942053200156", Channel::Sms));
        assert!(!l.is_blocked("10086", Channel::Sms));
        // A 2-digit prefix is refused outright.
        let mut short = Blocklist::new();
        assert!(short
            .add("10", MatchKind::Prefix, Channel::Sms, "", 1)
            .is_err());
    }

    #[test]
    fn channels_are_respected() {
        let sms_only = list_with("10086", MatchKind::Exact, Channel::Sms);
        assert!(sms_only.is_blocked("10086", Channel::Sms));
        assert!(!sms_only.is_blocked("10086", Channel::Call));
        let calls_only = list_with("10086", MatchKind::Exact, Channel::Call);
        assert!(calls_only.is_blocked("10086", Channel::Call));
        assert!(!calls_only.is_blocked("10086", Channel::Sms));
        let both = list_with("10086", MatchKind::Exact, Channel::Both);
        assert!(both.is_blocked("10086", Channel::Call));
        assert!(both.is_blocked("10086", Channel::Sms));
    }

    #[test]
    fn unknown_numbers_are_only_blocked_when_asked() {
        let mut l = Blocklist::new();
        assert!(!l.is_blocked("", Channel::Call));
        assert!(!l.is_blocked("withheld", Channel::Call));
        l.set_block_unknown(true);
        assert_eq!(l.check("", Channel::Call), Some(BlockReason::Unknown));
        assert_eq!(
            l.check("withheld", Channel::Sms),
            Some(BlockReason::Unknown)
        );
        // A real number is still allowed (unknown-blocking is not a catch-all).
        assert!(!l.is_blocked("10086", Channel::Call));
    }

    #[test]
    fn block_reason_names_the_rule_that_fired() {
        let l = list_with("1069", MatchKind::Prefix, Channel::Sms);
        match l.check("106942053200156", Channel::Sms) {
            Some(BlockReason::Rule {
                pattern,
                label,
                channel,
                ..
            }) => {
                assert_eq!(pattern, "1069");
                assert_eq!(label, "spam");
                assert_eq!(channel, Channel::Sms);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }
}

/// Contract behaviours (dedupe / cap / persistence) live in their own module so
/// the suite documents them separately from matching.
#[cfg(test)]
mod contract {
    use super::*;

    #[test]
    fn adding_the_same_pattern_twice_keeps_one_rule() {
        let mut l = Blocklist::new();
        l.add("10086", MatchKind::Exact, Channel::Sms, "first", 1)
            .unwrap();
        l.add("10086", MatchKind::Exact, Channel::Sms, "second", 2)
            .unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!(l.rules()[0].label, "second");
        // A different channel is a different rule.
        l.add("10086", MatchKind::Exact, Channel::Call, "calls", 3)
            .unwrap();
        assert_eq!(l.len(), 2);
    }

    #[test]
    fn the_list_is_bounded_evicting_the_oldest() {
        let mut l = Blocklist::with_cap(3);
        for i in 0..5 {
            l.add(&format!("1000{i}"), MatchKind::Exact, Channel::Sms, "", i)
                .unwrap();
        }
        assert_eq!(l.len(), 3);
        let kept: Vec<String> = l.rules().into_iter().map(|r| r.pattern).collect();
        assert!(kept.contains(&"10004".to_string()));
        assert!(!kept.contains(&"10000".to_string())); // oldest evicted
    }

    #[test]
    fn remove_and_clear() {
        let mut l = Blocklist::new();
        let r = l
            .add("10086", MatchKind::Exact, Channel::Both, "", 1)
            .unwrap();
        assert!(l.remove(&r.id));
        assert!(!l.remove(&r.id));
        l.add("10010", MatchKind::Exact, Channel::Both, "", 2)
            .unwrap();
        l.clear();
        assert!(l.is_empty());
    }

    #[test]
    fn json_round_trips_rules_and_the_unknown_flag() {
        let mut l = Blocklist::new();
        l.add("+8613800138000", MatchKind::Exact, Channel::Both, "spam", 7)
            .unwrap();
        l.add("1069", MatchKind::Prefix, Channel::Sms, "bulk", 8)
            .unwrap();
        l.set_block_unknown(true);
        let json = l.to_json();
        let back = Blocklist::from_json(&json, DEFAULT_CAP).unwrap();
        assert_eq!(back.len(), 2);
        assert!(back.block_unknown());
        assert!(back.is_blocked("+86 138-0013-8000", Channel::Call));
        assert!(back.is_blocked("10690001", Channel::Sms));
    }

    #[test]
    fn corrupted_payloads_are_rejected_not_silently_dropped() {
        assert!(Blocklist::from_json("not json", DEFAULT_CAP).is_err());
        assert!(Blocklist::from_json(r#"{"version":99,"rules":[]}"#, DEFAULT_CAP).is_err());
        // A hand-edited file can't smuggle in an unusable pattern…
        let bad = r#"{"version":1,"rules":[{"pattern":"abc","digits":"abc","id":"x","kind":"exact","channel":"both","created_ms":1}]}"#;
        assert!(Blocklist::from_json(bad, DEFAULT_CAP).is_err());
        // …nor more rules than the cap.
        let many: Vec<String> = (0..5)
                .map(|i| format!(r#"{{"pattern":"1000{i}","digits":"1000{i}","id":"r{i}","kind":"exact","channel":"both","created_ms":{i}}}"#))
                .collect();
        let over = format!(r#"{{"version":1,"rules":[{}]}}"#, many.join(","));
        assert!(Blocklist::from_json(&over, 3).is_err());
        // An empty/absent payload is an honest empty list.
        assert!(Blocklist::from_json("{}", DEFAULT_CAP).unwrap().is_empty());
    }
}
