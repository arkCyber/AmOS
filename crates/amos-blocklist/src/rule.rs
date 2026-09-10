//! Rules, channels and match kinds.

use serde::{Deserialize, Serialize};

use crate::error::BlocklistError;

/// Shortest allowed prefix rule (a 1–2 digit prefix would block far too much).
pub const MIN_PREFIX_DIGITS: usize = 3;
/// Longest accepted digit run (E.164 is ≤15; service ids are short).
pub const MAX_DIGITS: usize = 20;
/// Default rule cap; past it the oldest rule is evicted (deterministic).
pub const DEFAULT_CAP: usize = 500;

/// Which traffic a rule applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Call,
    Sms,
    Both,
}

impl Channel {
    /// `true` when this rule channel covers the traffic being checked.
    pub fn covers(self, traffic: Channel) -> bool {
        match self {
            Channel::Both => true,
            Channel::Call => traffic == Channel::Call || traffic == Channel::Both,
            Channel::Sms => traffic == Channel::Sms || traffic == Channel::Both,
        }
    }

    /// Wire name (also the JSON value).
    pub fn wire(self) -> &'static str {
        match self {
            Channel::Call => "call",
            Channel::Sms => "sms",
            Channel::Both => "both",
        }
    }

    /// Parse a wire name; unknown names are an honest caller error.
    pub fn from_wire(name: &str) -> Result<Self, BlocklistError> {
        match name.trim().to_ascii_lowercase().as_str() {
            "call" => Ok(Channel::Call),
            "sms" => Ok(Channel::Sms),
            "both" | "" => Ok(Channel::Both),
            other => Err(BlocklistError::InvalidPattern(format!(
                "unknown channel {other:?} (expected call|sms|both)"
            ))),
        }
    }
}

/// How a pattern is compared with an address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchKind {
    /// The whole digit string must be equal.
    Exact,
    /// The address must start with the pattern's digits.
    Prefix,
}

impl MatchKind {
    pub fn wire(self) -> &'static str {
        match self {
            MatchKind::Exact => "exact",
            MatchKind::Prefix => "prefix",
        }
    }

    pub fn from_wire(name: &str) -> Result<Self, BlocklistError> {
        match name.trim().to_ascii_lowercase().as_str() {
            "exact" | "" => Ok(MatchKind::Exact),
            "prefix" => Ok(MatchKind::Prefix),
            other => Err(BlocklistError::InvalidPattern(format!(
                "unknown match kind {other:?} (expected exact|prefix)"
            ))),
        }
    }
}

/// One blocking rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    /// Stable id (derived from pattern + kind + channel) for list keys/removal.
    pub id: String,
    /// Normalized pattern (digits with an optional leading `+`, as typed).
    pub pattern: String,
    /// Digits used for comparison (pattern without the leading `+`).
    pub digits: String,
    pub kind: MatchKind,
    pub channel: Channel,
    /// Free-form label ("spam", "骚扰电话", …); empty when unset.
    #[serde(default)]
    pub label: String,
    /// Creation time (epoch ms) — used for display order and cap eviction.
    pub created_ms: i64,
}

impl Rule {
    /// Stable id for a (pattern, kind, channel) triple.
    pub fn make_id(digits: &str, kind: MatchKind, channel: Channel) -> String {
        format!("{digits}|{}|{}", kind.wire(), channel.wire())
    }

    /// `true` when this rule matches `digits` (already normalized).
    pub fn matches_digits(&self, digits: &str) -> bool {
        match self.kind {
            // Tolerates the national/E.164 forms of one number (see
            // `same_number` / `starts_with_number`): otherwise a rule written as
            // `+86…` would never match the domestic `186…` form an incoming SMS
            // actually carries (verified on a real device).
            MatchKind::Exact => same_number(&self.digits, digits),
            MatchKind::Prefix => starts_with_number(digits, &self.digits),
        }
    }
}

/// Why an address was blocked (kept so the UI can explain *which* rule fired).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BlockReason {
    /// An exact/prefix rule fired.
    Rule {
        id: String,
        pattern: String,
        label: String,
        channel: Channel,
    },
    /// The address was withheld/withheld-unknown and `block_unknown` is on.
    Unknown,
}

/// Normalize a typed number to digits + optional leading `+`, or `None` when it
/// is blank / contains something other than digits and separators.
///
/// `+`, spaces, `-`, `(`, `)`, `.` are accepted; the `+` must lead. A number
/// shorter than 3 digits is refused (it cannot be a real address).
pub fn normalize_number(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(trimmed.len());
    for (i, ch) in trimmed.chars().enumerate() {
        match ch {
            '+' if i == 0 => out.push('+'),
            c if c.is_ascii_digit() => out.push(c),
            '-' | ' ' | '(' | ')' | '.' => {}
            _ => return None,
        }
    }
    let digits = out.trim_start_matches('+');
    if digits.len() < MIN_PREFIX_DIGITS || digits.len() > MAX_DIGITS {
        return None;
    }
    Some(out)
}

/// Digits of a normalized pattern/address (drops a leading `+`).
pub fn digits_of(normalized: &str) -> String {
    normalized.trim_start_matches('+').to_string()
}

/// Strip the international `00` access prefix and a single trunk `0`
/// (`008613800138000` / `013800138000` → `13800138000`).
fn trim_zeros(digits: &str) -> &str {
    let d = digits.strip_prefix("00").unwrap_or(digits);
    d.strip_prefix('0').unwrap_or(d)
}

/// `true` when two digit strings denote the **same subscriber**, tolerating the
/// forms carriers actually use for one number:
///
/// * equal digits,
/// * equal after dropping a 1–3 digit country-code segment from the longer one
///   (`+8613800138000` ≡ `8613800138000` ≡ `13800138000`) — the outgoing PDU is
///   `+86…` while an incoming one is commonly the national form,
/// * `00`/`0` access-prefix forms (`0086…`, `0…`).
///
/// Deliberately conservative: only a *leading* 1–3 digit segment may be dropped,
/// so unrelated numbers (`10086` vs `8610087`) never collapse.
pub fn same_number(a: &str, b: &str) -> bool {
    let (a, b) = (trim_zeros(a), trim_zeros(b));
    if a == b {
        return true;
    }
    let (long, short) = if a.len() >= b.len() { (a, b) } else { (b, a) };
    if short.is_empty() {
        return false;
    }
    (1..=3).any(|cc| long.len() == short.len() + cc && long[cc..] == *short)
}

/// `true` when `digits` starts with `prefix`, tolerating a leading country-code
/// segment on the address (`+86 1069…` matches a `1069` prefix rule).
pub fn starts_with_number(digits: &str, prefix: &str) -> bool {
    let (d, p) = (trim_zeros(digits), trim_zeros(prefix));
    if d.starts_with(p) {
        return true;
    }
    (1..=3).any(|cc| d.len() > cc && d[cc..].starts_with(p))
}
