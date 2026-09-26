//! Phone-number rules: a validated [`Number`] and the emergency classification
//! [`EmergencyMap`] that backs the legal 110/112 hard path.

use crate::error::{Result, TelephonyError};

/// Whether a [`Number`] is a recognized emergency code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NumberKind {
    /// A recognized emergency number (e.g. 110/112/911/999) per an [`EmergencyMap`].
    Emergency,
    /// An ordinary number that must go through the regular (SIM/telecom) path.
    Regular,
}

/// A validated, canonically-formatted phone number.
///
/// Canonical form keeps only digits and an optional leading `+` (separators such
/// as spaces / hyphens / parentheses are stripped during construction).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Number(String);

impl Number {
    /// Maximum canonical digit count a dial string may carry (mirrors the dialer
    /// UI's `MAX_DIAL_LEN`). E.164 numbers are ≤ 15 digits; headroom covers local
    /// extension-heavy plans while still bounding the length so a crafted RPC can
    /// never ask a provider to place a pathologically long call.
    pub const MAX_LEN: usize = 18;

    /// Parse and validate a raw dial string.
    ///
    /// Empty / whitespace-only input, letters and other symbols (other than a
    /// leading `+` and the allowed separators) are rejected, as is anything longer
    /// than [`Number::MAX_LEN`] digits.
    pub fn new(raw: &str) -> Result<Self> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(TelephonyError::InvalidNumber(raw.to_string()));
        }
        let cleaned: String = trimmed
            .chars()
            .filter(|c| !matches!(c, ' ' | '-' | '(' | ')'))
            .collect();
        let mut chars = cleaned.chars();
        // Optional leading '+', then at least one ASCII digit and nothing else.
        let mut seen_digit = false;
        if let Some(first) = chars.next() {
            match first {
                '+' => {}
                c if c.is_ascii_digit() => seen_digit = true,
                _ => return Err(TelephonyError::InvalidNumber(raw.to_string())),
            }
        } else {
            return Err(TelephonyError::InvalidNumber(raw.to_string()));
        }
        for c in chars {
            if c.is_ascii_digit() {
                seen_digit = true;
            } else {
                return Err(TelephonyError::InvalidNumber(raw.to_string()));
            }
        }
        if !seen_digit {
            return Err(TelephonyError::InvalidNumber(raw.to_string()));
        }
        let digits = cleaned.trim_start_matches('+');
        if digits.len() > Self::MAX_LEN {
            return Err(TelephonyError::InvalidNumber(raw.to_string()));
        }
        Ok(Self(cleaned))
    }

    /// The canonical string (digits, optional leading `+`).
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Digits only (leading `+` removed) — the form used for emergency lookup.
    pub fn digits(&self) -> String {
        self.0.trim_start_matches('+').to_string()
    }

    /// Classify against an [`EmergencyMap`].
    pub fn kind(&self, map: &EmergencyMap) -> NumberKind {
        if map.is_emergency(&self.digits()) {
            NumberKind::Emergency
        } else {
            NumberKind::Regular
        }
    }
}

/// The set of emergency codes the platform recognizes, per jurisdiction.
///
/// Code is matched on the *digits-only* form (spaces/dashes/`+` ignored), so a
/// user typing `1 1 2` still hits `112`. Matches the design's "number
/// normalization fallback" requirement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmergencyMap {
    codes: Vec<String>,
}

impl EmergencyMap {
    /// Build from raw codes (each normalized to digits).
    pub fn from_slice(codes: &[&str]) -> Self {
        Self {
            codes: codes.iter().map(|c| normalize(c)).collect(),
        }
    }

    /// The set used when **no jurisdiction is known**: the mock/demo assembly and
    /// [`EmergencyMap::for_region`]'s `_` fallback. Production assembly should prefer
    /// [`EmergencyMap::for_region`] where the region is actually known.
    ///
    /// It must be a **superset of every code the device recognizes** — the flat
    /// `digits == "…" -> true` list in `AmosInCallService.is_emergency`, which the device
    /// enforces locally rather than crossing the JNI seam. That is a safety requirement, not a
    /// convenience: this map is consulted *exactly* when the region is unknown, and the
    /// classification decides the dial path. [`NumberKind::Regular`] reaches the ordinary
    /// provider, where **recording is legal**; an emergency number is refused there and forced
    /// onto the emergency path, where it is forbidden (`crate::route::guard_regular`,
    /// `MockTelephonyProvider::start_recording`). So a code the device calls an emergency and
    /// this map does not is an **emergency call that gets recorded**.
    ///
    /// `000` (AU/NZ), `118` (JP coast guard) and `108` (India) were each recognized by the device
    /// and missing here, so a caller on an unknown jurisdiction dialling one of them took the
    /// ordinary path. `the_host_copy_recognizes_every_canonical_emergency_code` now reads both
    /// directions and keeps this closed (REQ-A820 / F-TEL-006).
    ///
    /// Deliberately broad: on an unknown jurisdiction the cost of over-classifying is a regular
    /// number forced onto the emergency path, while the cost of under-classifying is a **recorded
    /// emergency** — see the module's own "the worst failure mode" note on [`Self::for_region`].
    pub fn common_global() -> Self {
        Self::from_slice(&[
            "110", "112", "119", "120", "122", "911", "999", "000", "118", "108",
        ])
    }

    /// Jurisdiction-flavoured emergency set, self-maintained (see `docs/telephony.md`
    /// §11 decision: self-maintained + overridable). Each set always carries the
    /// international **112**, which every GSM/UMTS/LTE network routes regardless of
    /// region, so a roaming/unknown SIM still resolves an emergency call.
    ///
    /// Unknown / empty region codes fall back to [`EmergencyMap::common_global`], so
    /// an un-assembled build can never produce an *empty* emergency table (a live
    /// 110/112/911 misrouted as a regular call would be the worst failure mode).
    pub fn for_region(region: &str) -> Self {
        let mut codes: Vec<&str> = Vec::new();
        match region.trim().to_ascii_uppercase().as_str() {
            // 中国大陆：110 公安、119 火警、120 急救、122 交通事故。
            "CN" | "CN-HK" | "CN-MO" => codes.extend(["110", "119", "120", "122"]),
            "US" | "CA" | "MX" => codes.extend(["911"]),
            "GB" | "IE" => codes.extend(["999", "112"]),
            "AU" | "NZ" => codes.extend(["000", "112"]),
            "JP" => codes.extend(["110", "119", "118"]),
            "KR" => codes.extend(["112", "119"]),
            // EEA members + others are the plain 112 family.
            "DE" | "FR" | "IT" | "ES" | "PT" | "NL" | "BE" | "AT" | "CH" | "SE" | "NO" | "DK"
            | "FI" | "PL" | "RU" | "GR" => codes.extend(["112"]),
            _ => {
                // No jurisdiction known — the broad global set is the safe default.
                return Self::common_global();
            }
        }
        // The international emergency number is always recognized on top of the
        // local codes (deduplicated in case a set listed it explicitly).
        codes.push("112");
        let mut seen = std::collections::HashSet::new();
        Self {
            codes: codes
                .into_iter()
                .filter(|c| seen.insert((*c).to_string()))
                .map(normalize)
                .collect(),
        }
    }

    /// The primary quick-dial code used by a one-key lock-screen emergency entry
    /// for `region` (the number a locked user reaches in one tap). Defaults to the
    /// universal **112** so the button is never tied to one country.
    ///
    /// Every returned code must appear in [`EmergencyMap::for_region`] for the
    /// same region — the two tables are cross-checked by
    /// `quick_dial_is_always_in_its_own_region_table`, because a one-tap number
    /// that the jurisdiction does not recognize reaches nobody:
    /// * KR dials **112** (police), not the CN/JP police code 110 — 110 is not
    ///   an emergency number in Korea.
    /// * AU/NZ dial **000**, their actual emergency number (112 also works from
    ///   mobiles), never the US 911, which does not connect there.
    pub fn quick_dial(region: &str) -> &'static str {
        match region.trim().to_ascii_uppercase().as_str() {
            "CN" | "CN-HK" | "CN-MO" | "JP" => "110",
            "KR" => "112",
            "US" | "CA" | "MX" => "911",
            "AU" | "NZ" => "000",
            _ => "112",
        }
    }

    /// Whether `digits` (already digits-only) is a recognized emergency code.
    pub fn is_emergency(&self, digits: &str) -> bool {
        self.codes.iter().any(|c| c == digits)
    }

    /// The recognized codes (digits-only, canonical). Used for diagnostics and for
    /// surfacing the exact table to UI/ops layers.
    pub fn codes(&self) -> &[String] {
        &self.codes
    }
}

/// Digits-only normalization used when building [`EmergencyMap`] codes.
fn normalize(s: &str) -> String {
    s.trim().trim_start_matches('+').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_accepts_digits_and_leading_plus() {
        assert!(Number::new("13800138000").is_ok());
        assert!(Number::new("+8613800138000").is_ok());
    }

    #[test]
    fn number_strips_common_separators() {
        let n = Number::new("1 3-8 (0013) 8000").unwrap();
        assert_eq!(n.digits(), "13800138000");
    }

    #[test]
    fn number_rejects_garbage() {
        assert_eq!(
            Number::new("").unwrap_err(),
            TelephonyError::InvalidNumber("".into())
        );
        assert!(Number::new("abc123").is_err());
        assert!(Number::new("   ").is_err());
        assert!(Number::new("+").is_err(), "lone '+' has no digits");
        assert!(Number::new("12a34").is_err());
    }

    #[test]
    fn number_length_is_server_capped() {
        // Exactly MAX_LEN digits (and with a leading '+') are accepted.
        let ok = "1".repeat(Number::MAX_LEN);
        assert!(Number::new(&ok).is_ok());
        assert!(Number::new(&format!("+{ok}")).is_ok());
        // One digit over is rejected — a crafted RPC can't dial a pathological number.
        let over = "1".repeat(Number::MAX_LEN + 1);
        assert_eq!(
            Number::new(&over).unwrap_err(),
            TelephonyError::InvalidNumber(over.clone())
        );
        assert!(Number::new(&format!("+{over}")).is_err());
        // The cap counts canonical *digits*, not raw characters (separators ignored).
        let spread: String = ok
            .chars()
            .enumerate()
            .map(|(i, c)| {
                if i % 3 == 2 {
                    format!("{c}-")
                } else {
                    c.to_string()
                }
            })
            .collect();
        assert!(Number::new(&spread).is_ok());
    }

    #[test]
    fn common_map_classifies_emergency_codes() {
        let map = EmergencyMap::common_global();
        assert!(map.is_emergency("110"));
        assert!(map.is_emergency("112"));
        assert!(map.is_emergency("911"));
        assert!(!map.is_emergency("12345"));
    }

    #[test]
    fn separators_still_hit_emergency_map() {
        let map = EmergencyMap::common_global();
        // digits() strips separators and the leading '+'.
        assert_eq!(Number::new("1 1 2").unwrap().digits(), "112");
        assert_eq!(Number::new("+112").unwrap().digits(), "112");
        let n = Number::new("1 1 2").unwrap();
        assert_eq!(n.kind(&map), NumberKind::Emergency);
        let ordinary = Number::new("13800138000").unwrap();
        assert_eq!(ordinary.kind(&map), NumberKind::Regular);
    }

    #[test]
    fn cn_region_set_covers_local_and_international_codes() {
        let map = EmergencyMap::for_region("CN");
        // Local CN codes resolve…
        for c in ["110", "119", "120", "122"] {
            assert!(map.is_emergency(c), "CN must recognize {c}");
        }
        // …and so does the universal 112 (GSM family), deduplicated exactly once.
        assert!(map.is_emergency("112"));
        assert_eq!(
            map.codes().iter().filter(|c| c.as_str() == "112").count(),
            1,
            "international 112 must not be duplicated"
        );
        // Regional call-out from a classification standpoint.
        assert_eq!(
            Number::new("110").unwrap().kind(&map),
            NumberKind::Emergency
        );
        assert_eq!(
            Number::new("13800138000").unwrap().kind(&map),
            NumberKind::Regular
        );
    }

    #[test]
    fn unknown_region_falls_back_to_global_never_empty() {
        // Region matching is case- and whitespace-insensitive.
        let map = EmergencyMap::for_region(" cn ");
        assert!(map.is_emergency("110"));
        // Unknown / empty jurisdiction must never yield an empty table.
        let fallback = EmergencyMap::for_region("zz");
        assert!(fallback.is_emergency("112"));
        assert!(fallback.is_emergency("911"));
        assert!(!fallback.codes().is_empty());
        assert!(EmergencyMap::for_region("").is_emergency("999"));
    }

    #[test]
    fn quick_dial_is_region_appropriate_and_defaults_universal() {
        assert_eq!(EmergencyMap::quick_dial("CN"), "110");
        assert_eq!(EmergencyMap::quick_dial("cn"), "110");
        assert_eq!(EmergencyMap::quick_dial("US"), "911");
        assert_eq!(EmergencyMap::quick_dial("GB"), "112"); // EU/UK default
        assert_eq!(EmergencyMap::quick_dial("XX"), "112"); // universal default
        assert_eq!(EmergencyMap::quick_dial(""), "112");
    }

    /// The two tables in this module must never disagree: the number a one-tap
    /// lock-screen entry dials has to be one the *same* jurisdiction's
    /// [`EmergencyMap`] recognizes. A quick-dial code outside its own region's
    /// table is a locked user tapping a button that reaches nobody — the worst
    /// failure mode this module exists to prevent.
    #[test]
    fn quick_dial_is_always_in_its_own_region_table() {
        for region in [
            "CN", "CN-HK", "CN-MO", "JP", "KR", "US", "CA", "MX", "AU", "NZ", "GB", "IE", "DE",
            "FR", "IT", "ES", "PT", "NL", "BE", "AT", "CH", "SE", "NO", "DK", "FI", "PL", "RU",
            "GR",
        ] {
            let code = EmergencyMap::quick_dial(region);
            assert!(
                EmergencyMap::for_region(region).is_emergency(code),
                "{region}'s one-tap code {code} is not in its own emergency table {:?}",
                EmergencyMap::for_region(region).codes()
            );
        }
        // And the universal fallback is itself an emergency code.
        for unknown in ["ZZ", "XX", "", "  "] {
            assert!(
                EmergencyMap::for_region(unknown).is_emergency(EmergencyMap::quick_dial(unknown))
            );
        }
    }

    /// The host keeps a **flat local copy** of the emergency codes
    /// (`AmosInCallService.is_emergency`, Kotlin) because its own comment says it
    /// must not cross the JNI seam on that hot path. A copy with no binding
    /// drifts, and the cost of drift here is an emergency call that gets
    /// *recorded*: this asserts the copy recognizes every code the canonical
    /// table can produce, so widening a region's set without updating the host is
    /// a test failure rather than a silently admissible recording.
    ///
    /// **Which direction that is, and which direction this test used to check
    /// (REQ-A820 / F-TEL-006).** Those two sentences disagreed. `NumberKind::Emergency` is what
    /// forbids recording — the emergency provider refuses it (`MockTelephonyProvider`) and
    /// `route::guard_regular` **rejects** such a number from the ordinary path entirely — so the
    /// harm is the host failing to recognize **a code the device recognizes**. The reverse (host
    /// wider than the device) merely forces an ordinary number onto the emergency path.
    ///
    /// What was asserted was the reverse: `KOTLIN.contains("digits == \"{code}\"")` over the
    /// codes the *Rust regions* can produce. **Measured**: with `911` deleted from
    /// `common_global()` — the host then misses a device-recognized emergency on the
    /// unknown-jurisdiction path, which is the recordable one — every assertion here was still
    /// **green**. It also read the raw file, so a comment quoting an arm answered for the code.
    ///
    /// Both directions are read now, and both from the **arms** of comment-stripped source: the
    /// device's set is its `digits == "…" -> true` list, the host must contain it *on the map used
    /// when the jurisdiction is unknown*, and no host region may name a code the device lacks.
    #[test]
    fn the_host_copy_recognizes_every_canonical_emergency_code() {
        const KOTLIN: &str =
            include_str!("../../amos-tauri/android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let code = strip_kotlin_comments(KOTLIN);

        // The **device's** set: the arms that answer `true`. Read from comment-stripped source, so
        // a comment quoting an old arm can neither widen nor narrow it.
        let mut device: Vec<String> = Vec::new();
        for line in code.lines() {
            let mut from = 0usize;
            while let Some(rel) = line[from..].find("digits == \"") {
                let start = from + rel + "digits == \"".len();
                let Some(close) = line[start..].find('"') else {
                    break;
                };
                // Only an arm answering `true` recognizes the code; `-> false` is an exclusion.
                let after = &line[start + close + 1..];
                if after.trim_start().starts_with("-> true") {
                    device.push(line[start..start + close].to_string());
                }
                from = start + close + 1;
            }
        }
        // Vacuity guard: an empty device set would satisfy both directions below.
        assert!(
            device.len() >= 8,
            "expected the device's flat `digits == \"…\" -> true` list, parsed {device:?}"
        );
        device.sort();
        device.dedup();

        // Direction 1 — no host region may claim a code the device does not recognize. Failing
        // here forces an ordinary number onto the emergency path (annoying, not dangerous), and it
        // is the direction that was checked before.
        let mut all: Vec<String> = Vec::new();
        for region in [
            "CN", "CN-HK", "CN-MO", "JP", "KR", "US", "CA", "MX", "AU", "NZ", "GB", "IE", "DE",
            "FR", "IT", "ES", "PT", "NL", "BE", "AT", "CH", "SE", "NO", "DK", "FI", "PL", "RU",
            "GR",
        ] {
            for c in EmergencyMap::for_region(region).codes() {
                if !all.contains(c) {
                    all.push(c.clone());
                }
            }
        }
        // Guard against a vacuous pass if the tables were ever emptied.
        assert!(
            all.len() >= 8,
            "the canonical code set looks wrong: {all:?}"
        );
        for code in &all {
            assert!(
                device.contains(code),
                "AmosInCallService.kt no longer recognizes {code}: the host copy has drifted \
                 from EmergencyMap, so a call to {code} could be recorded"
            );
        }

        // Direction 2 — **the recording direction.** The map consulted when the jurisdiction is
        // unknown must recognize every code the device does. A miss here dials the ordinary path,
        // where recording is legal, so this is the assertion that protects the thing the doc
        // above describes.
        let fallback = EmergencyMap::common_global();
        for code in &device {
            assert!(
                fallback.is_emergency(code),
                "the device treats {code} as an emergency but `common_global()` — the map used \
                 when the jurisdiction is unknown — does not, so that call reaches the ordinary \
                 path and can be recorded"
            );
        }
    }

    /// Strip Kotlin block and line comments, leaving string literals intact — so a comment that
    /// *quotes* an arm cannot answer for the code. A `//` inside a string literal is not a
    /// comment, which is what makes this a character machine rather than a `find("//")`.
    fn strip_kotlin_comments(src: &str) -> String {
        let chars: Vec<char> = src.chars().collect();
        let mut out = String::with_capacity(src.len());
        let mut i = 0usize;
        let mut block_depth = 0usize;
        while i < chars.len() {
            let c = chars[i];
            if block_depth > 0 {
                if c == '/' && chars.get(i + 1) == Some(&'*') {
                    block_depth += 1;
                    i += 2;
                } else if c == '*' && chars.get(i + 1) == Some(&'/') {
                    block_depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
                continue;
            }
            if c == '/' && chars.get(i + 1) == Some(&'/') {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            if c == '/' && chars.get(i + 1) == Some(&'*') {
                block_depth = 1;
                i += 2;
                continue;
            }
            if c == '"' {
                out.push(c);
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        out.push(chars[i]);
                        i += 1;
                    }
                    out.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() {
                    out.push(chars[i]);
                    i += 1;
                }
                continue;
            }
            out.push(c);
            i += 1;
        }
        out
    }

    /// The stripper is itself two-sided: the arm must survive, a commented-out copy of it must
    /// not, and a `//` inside a string literal must not be taken for a comment.
    #[test]
    fn strip_kotlin_comments_keeps_arms_and_drops_prose() {
        let src = "\
        // digits == \"108\" -> true was removed in the migration\n\
        /** the old list had digits == \"999\" -> true */\n\
        digits == \"108\" -> true\n\
        val odd = \"a//b\"\n";
        let code = strip_kotlin_comments(src);
        assert_eq!(
            code.matches("digits == \"108\"").count(),
            1,
            "only the real arm may survive; the commented-out one must be gone"
        );
        assert!(
            !code.contains("digits == \"999\""),
            "a comment quoting an old arm must not be read as one"
        );
        assert!(
            code.contains("\"a//b\""),
            "a // inside a string literal is not a comment"
        );
    }

    #[test]
    fn region_kind_still_classifies_via_number() {
        let map = EmergencyMap::for_region("US");
        assert_eq!(
            Number::new("911").unwrap().kind(&map),
            NumberKind::Emergency
        );
        assert_eq!(
            Number::new("110").unwrap().kind(&map),
            NumberKind::Regular,
            "110 is not a US emergency code"
        );
    }
}
