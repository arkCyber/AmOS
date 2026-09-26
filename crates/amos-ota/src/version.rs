//! A strict [SemVer](https://semver.org/spec/v2.0.0.html) version with the
//! *precedence* rules the spec actually defines.
//!
//! The point of keeping this in-tree rather than depending on a crate is that
//! update eligibility is a safety decision: "is the image on this phone newer
//! than the one I am about to install?" must never be answered by a lenient
//! parser that silently accepts `1.2` or `01.2.3` and then orders it wrongly.
//! So [`Version::parse`] refuses anything that is not exactly
//! `MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]` with the spec's identifier rules,
//! and the ordering is the spec's.
//!
//! Two deliberate, documented choices:
//! * **Build metadata never affects precedence** (per the spec), so it never
//!   affects [`Ord`]/[`Eq`] either — `1.0.0+a` and `1.0.0+b` compare *equal*,
//!   which is what makes them freely interchangeable for a rollout decision.
//!   The metadata is still kept and readable via [`Version::build`].
//! * **Leading zeros are refused** in every numeric component, including inside
//!   a prerelease numeric identifier (`1.0.0-01` is not valid SemVer).

use std::cmp::Ordering;
use std::fmt;
use std::str::FromStr;

use crate::error::{OtaError, Result};

/// One prerelease identifier: numeric identifiers sort below alphanumeric ones,
/// and are compared numerically.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Ident {
    Num(u64),
    Alpha(String),
}

impl Ident {
    fn parse(raw: &str) -> Result<Ident> {
        if raw.is_empty() {
            return Err(OtaError::InvalidVersion(
                "empty prerelease identifier".into(),
            ));
        }
        let numeric = raw.bytes().all(|b| b.is_ascii_digit());
        if numeric {
            // No leading zeros in a numeric identifier (SemVer §9).
            if raw.len() > 1 && raw.starts_with('0') {
                return Err(OtaError::InvalidVersion(format!(
                    "numeric prerelease identifier has a leading zero: {raw}"
                )));
            }
            raw.parse::<u64>().map(Ident::Num).map_err(|_| {
                OtaError::InvalidVersion(format!("numeric identifier overflow: {raw}"))
            })
        } else {
            if !raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                return Err(OtaError::InvalidVersion(format!(
                    "prerelease identifier has a non [0-9A-Za-z-] byte: {raw}"
                )));
            }
            Ok(Ident::Alpha(raw.to_string()))
        }
    }
}

impl Ord for Ident {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Ident::Num(a), Ident::Num(b)) => a.cmp(b),
            // A numeric identifier always has *lower* precedence than an
            // alphanumeric one (SemVer §11.4.3).
            (Ident::Num(_), Ident::Alpha(_)) => Ordering::Less,
            (Ident::Alpha(_), Ident::Num(_)) => Ordering::Greater,
            (Ident::Alpha(a), Ident::Alpha(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for Ident {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for Ident {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Ident::Num(n) => write!(f, "{n}"),
            Ident::Alpha(s) => f.write_str(s),
        }
    }
}

/// A parsed SemVer version. Construct with [`Version::parse`] or [`FromStr`].
#[derive(Clone, Debug, Eq)]
pub struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    /// Empty means "a release" (which outranks every prerelease of the same
    /// `major.minor.patch`). `Some(vec![])` is never produced.
    prerelease: Option<Vec<Ident>>,
    /// Build metadata — kept for display, ignored for precedence and equality.
    build: Option<String>,
}

impl Version {
    /// Parse a strict SemVer string. See the module docs for the rules.
    pub fn parse(input: &str) -> Result<Version> {
        if input.is_empty() {
            return Err(OtaError::InvalidVersion("empty string".into()));
        }
        // Split build metadata first: it may itself contain `-`, so the `+`
        // split must happen before the `-` split.
        let (core_pre, build) = match input.split_once('+') {
            Some((l, r)) => {
                if r.is_empty() {
                    return Err(OtaError::InvalidVersion(format!(
                        "empty build metadata: {input}"
                    )));
                }
                for id in r.split('.') {
                    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    {
                        return Err(OtaError::InvalidVersion(format!(
                            "invalid build metadata identifier: {id}"
                        )));
                    }
                }
                (l, Some(r.to_string()))
            }
            None => (input, None),
        };

        let (core, pre) = match core_pre.split_once('-') {
            Some((l, r)) => (l, Some(r)),
            None => (core_pre, None),
        };

        let mut nums = core.split('.');
        let major = parse_num(nums.next(), "major", input)?;
        let minor = parse_num(nums.next(), "minor", input)?;
        let patch = parse_num(nums.next(), "patch", input)?;
        if nums.next().is_some() {
            return Err(OtaError::InvalidVersion(format!(
                "too many numeric components: {input}"
            )));
        }

        let prerelease = match pre {
            None => None,
            Some(p) => {
                if p.is_empty() {
                    return Err(OtaError::InvalidVersion(format!(
                        "empty prerelease after '-': {input}"
                    )));
                }
                let mut v = Vec::new();
                for raw in p.split('.') {
                    v.push(Ident::parse(raw)?);
                }
                Some(v)
            }
        };

        Ok(Version {
            major,
            minor,
            patch,
            prerelease,
            build,
        })
    }

    pub fn major(&self) -> u64 {
        self.major
    }
    pub fn minor(&self) -> u64 {
        self.minor
    }
    pub fn patch(&self) -> u64 {
        self.patch
    }
    /// The build metadata (the part after `+`), if any.
    pub fn build(&self) -> Option<&str> {
        self.build.as_deref()
    }
    /// Whether this is a prerelease (has a `-something` suffix).
    pub fn is_prerelease(&self) -> bool {
        self.prerelease.is_some()
    }

    /// SemVer precedence, ignoring build metadata (the [`Ord`] implementation).
    fn precedence(&self, other: &Version) -> Ordering {
        self.major
            .cmp(&other.major)
            .then_with(|| self.minor.cmp(&other.minor))
            .then_with(|| self.patch.cmp(&other.patch))
            .then_with(|| match (&self.prerelease, &other.prerelease) {
                // A release outranks any prerelease of the same triple.
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => compare_idents(a, b),
            })
    }
}

/// Compare two prerelease identifier lists: element-wise, then the longer list
/// wins when one is a prefix of the other (SemVer §11.4.4).
fn compare_idents(a: &[Ident], b: &[Ident]) -> Ordering {
    for (x, y) in a.iter().zip(b.iter()) {
        match x.cmp(y) {
            Ordering::Equal => continue,
            non_eq => return non_eq,
        }
    }
    a.len().cmp(&b.len())
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.precedence(other)
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Equality follows precedence: build metadata is ignored (so `1.0.0+a` and
/// `1.0.0+b` are equal *and* compare `Ordering::Equal`, keeping `Ord` lawful).
impl PartialEq for Version {
    fn eq(&self, other: &Self) -> bool {
        self.precedence(other) == Ordering::Equal
    }
}

fn parse_num(part: Option<&str>, name: &str, input: &str) -> Result<u64> {
    let part = part
        .ok_or_else(|| OtaError::InvalidVersion(format!("missing {name} component in {input}")))?;
    if part.is_empty() {
        return Err(OtaError::InvalidVersion(format!(
            "empty {name} component in {input}"
        )));
    }
    if !part.bytes().all(|b| b.is_ascii_digit()) {
        return Err(OtaError::InvalidVersion(format!(
            "non-numeric {name} component: {part}"
        )));
    }
    if part.len() > 1 && part.starts_with('0') {
        return Err(OtaError::InvalidVersion(format!(
            "leading zero in {name} component: {part}"
        )));
    }
    part.parse::<u64>()
        .map_err(|_| OtaError::InvalidVersion(format!("{name} component overflow: {part}")))
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(pre) = &self.prerelease {
            f.write_str("-")?;
            for (i, id) in pre.iter().enumerate() {
                if i > 0 {
                    f.write_str(".")?;
                }
                write!(f, "{id}")?;
            }
        }
        if let Some(b) = &self.build {
            write!(f, "+{b}")?;
        }
        Ok(())
    }
}

impl FromStr for Version {
    type Err = OtaError;
    fn from_str(s: &str) -> Result<Version> {
        Version::parse(s)
    }
}

impl TryFrom<String> for Version {
    type Error = OtaError;
    fn try_from(s: String) -> Result<Version> {
        Version::parse(&s)
    }
}

impl From<&Version> for String {
    fn from(v: &Version) -> String {
        v.to_string()
    }
}

impl serde::Serialize for Version {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> serde::Deserialize<'de> for Version {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Version, D::Error> {
        let raw = String::deserialize(d)?;
        Version::parse(&raw).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap_or_else(|e| panic!("{s} should parse: {e}"))
    }

    #[test]
    fn parses_and_round_trips() {
        for s in [
            "1.2.3",
            "0.0.0",
            "10.20.30",
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-0.3.7",
            "1.0.0-x.7.z.92",
            "1.0.0+20130313144700",
            "1.0.0-beta+exp.sha.5114f85",
            "1.0.0-rc.1+build.123",
        ] {
            assert_eq!(v(s).to_string(), s, "round trip {s}");
        }
    }

    #[test]
    fn rejects_malformed() {
        for bad in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.02.3",
            "1.2.03",
            "a.b.c",
            "1.2.x",
            "1.2.3-",
            "1.2.3+",
            "1.2.3-01",
            "1.2.3-+",
            "1.2.3-a..b",
            "1.2.3-a_b",
            "1.2.3+ ",
            " 1.2.3",
            "1.2.3 ",
            "1.2.-3",
        ] {
            assert!(Version::parse(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn numeric_components_and_metadata_are_readable() {
        let x = v("1.2.3-rc.1+build.5");
        assert_eq!((x.major(), x.minor(), x.patch()), (1, 2, 3));
        assert_eq!(x.build(), Some("build.5"));
        assert!(x.is_prerelease());
        assert!(!v("1.2.3").is_prerelease());
    }

    #[test]
    fn spec_ordering_examples() {
        // The exact chain from SemVer §11.4.
        let chain = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
        ];
        for pair in chain.windows(2) {
            assert!(
                v(pair[0]) < v(pair[1]),
                "{} must precede {}",
                pair[0],
                pair[1]
            );
        }
    }

    #[test]
    fn numeric_identifiers_sort_below_alphanumeric() {
        // `alpha.1` vs `alpha.beta`: at index 1, Num(1) < Alpha("beta").
        assert!(v("1.0.0-alpha.1") < v("1.0.0-alpha.beta"));
        // A longer list wins when it is a prefix-extension.
        assert!(v("1.0.0-alpha") < v("1.0.0-alpha.1"));
        // Numeric comparison, not lexicographic: beta.2 < beta.11.
        assert!(v("1.0.0-beta.2") < v("1.0.0-beta.11"));
    }

    #[test]
    fn build_metadata_does_not_affect_precedence_or_equality() {
        assert_eq!(v("1.0.0+a"), v("1.0.0+b"));
        assert_eq!(v("1.0.0+a").cmp(&v("1.0.0+b")), Ordering::Equal);
        // …but it does not *hide* an actual difference.
        assert!(v("1.0.0+a") < v("1.0.1+a"));
    }

    #[test]
    fn ordering_across_components() {
        assert!(v("1.9.9") < v("2.0.0"));
        assert!(v("2.0.0") < v("2.0.1"));
        assert!(v("1.0.0-zzz") < v("1.0.0"));
    }
}
