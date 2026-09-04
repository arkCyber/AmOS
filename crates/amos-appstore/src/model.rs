//! App-store domain models.
//!
//! Transport-agnostic: these types carry no knowledge of HTTP catalogs, archive
//! formats, or where an installed app lives on disk. They are `serde`-serializable
//! so a future Tauri bridge (JSON) and CLI (table) can both render them, and they
//! encode the *integrity* story of the store:
//!
//! * [`Version`] — a small semantic version used to detect upgrades.
//! * [`Checksum`] — a sha256 digest a downloaded package must match before an
//!   install is allowed (corrupt / tampered payloads are refused).
//! * [`AppManifest`] — everything a *developer publishes* about an app in the
//!   catalog: identity, authorship, category, and a [`PackageRef`] pointing at
//!   the artifact to download.
//! * [`InstalledApp`] — the record the local registry keeps once an app is
//!   installed (a snapshot of the manifest that produced it + a timestamp).
//!
//! The one invariant this module owns is *validation*: an id is a constrained
//! slug, a checksum is well formed, and a version parses.

use std::cmp::Ordering;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::error::{Result, StoreError};

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/// A semantic version `major.minor.patch` with an optional pre-release suffix
/// (`1.4.0`, `2.1.3-beta.2`). Ordering is numeric on the three parts; a
/// pre-release sorts *before* its release (`1.0.0-beta < 1.0.0`). This is what
/// the engine uses to decide whether an installed app can be upgraded.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    /// Optional pre-release tag, e.g. `"beta.2"`. `None` is a full release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre: Option<String>,
}

impl Version {
    /// A full release with no pre-release suffix.
    pub fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
            pre: None,
        }
    }

    /// Parse `major.minor.patch` with an optional `-pre` suffix.
    pub fn parse(s: &str) -> Result<Self> {
        s.parse()
    }

    fn is_release(&self) -> bool {
        self.pre.is_none()
    }
}

impl FromStr for Version {
    type Err = StoreError;

    fn from_str(s: &str) -> Result<Self> {
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (s, None),
        };
        // A dangling `-` with nothing after it is malformed, not a valid pre.
        if let Some(p) = pre {
            if p.is_empty() {
                return Err(StoreError::InvalidVersion(s.to_string()));
            }
        }
        let mut parts = core.split('.');
        let (maj, min, pat) = (parts.next(), parts.next(), parts.next());
        let (Some(maj), Some(min), Some(pat)) = (maj, min, pat) else {
            return Err(StoreError::InvalidVersion(s.to_string()));
        };
        if parts.next().is_some() {
            return Err(StoreError::InvalidVersion(s.to_string()));
        }
        let parse_part = |p: &str| {
            p.parse::<u32>()
                .map_err(|_| StoreError::InvalidVersion(s.to_string()))
        };
        Ok(Version {
            major: parse_part(maj)?,
            minor: parse_part(min)?,
            patch: parse_part(pat)?,
            pre: pre.map(|p| p.to_ascii_lowercase()),
        })
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(pre) = &self.pre {
            write!(f, "-{pre}")?;
        }
        Ok(())
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        let core =
            (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch));
        if core != Ordering::Equal {
            return core;
        }
        // Numerically equal: a release beats its own pre-release; otherwise
        // compare the pre-release tags lexically.
        match (self.is_release(), other.is_release()) {
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            _ => self.pre.cmp(&other.pre),
        }
    }
}

// ---------------------------------------------------------------------------
// Checksum (integrity)
// ---------------------------------------------------------------------------

/// Hash algorithms a package checksum may use. Only sha256 is wired up today;
/// keeping the field lets a later catalog add new algorithms without breaking
/// the JSON contract.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HashAlgorithm {
    #[default]
    Sha256,
}

impl HashAlgorithm {
    pub fn as_str(&self) -> &'static str {
        match self {
            HashAlgorithm::Sha256 => "sha256",
        }
    }
}

impl fmt::Display for HashAlgorithm {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A package digest the engine verifies against downloaded bytes before an
/// install is allowed. The value is a lowercased hex string.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Checksum {
    pub algorithm: HashAlgorithm,
    pub value: String,
}

impl Checksum {
    /// The hex-encoded sha256 digest of `data` (lowercase).
    pub fn sha256_hex(data: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(data);
        to_hex(&hasher.finalize())
    }

    /// Build a checksum from a hex digest string, validating that it is a
    /// 64-char hex string for sha256. Uppercase input is normalized to lower.
    pub fn sha256(value: impl AsRef<str>) -> Result<Self> {
        let value = value.as_ref().to_ascii_lowercase();
        if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(StoreError::InvalidChecksum {
                algorithm: HashAlgorithm::Sha256.as_str(),
                value,
            });
        }
        Ok(Self {
            algorithm: HashAlgorithm::Sha256,
            value,
        })
    }

    /// Whether `data` hashes to this checksum (case-insensitive on the hex).
    pub fn verify(&self, data: &[u8]) -> bool {
        match self.algorithm {
            HashAlgorithm::Sha256 => Self::sha256_hex(data).eq_ignore_ascii_case(&self.value),
        }
    }
}

impl fmt::Display for Checksum {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.algorithm, self.value)
    }
}

/// Lowercase hex encoding of a byte slice.
fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

// ---------------------------------------------------------------------------
// Category / package format
// ---------------------------------------------------------------------------

/// The store category an app is published under (drives browsing).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppCategory {
    #[default]
    Other,
    Tools,
    Media,
    Communication,
    Games,
    Productivity,
    Education,
    System,
}

impl AppCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            AppCategory::Other => "other",
            AppCategory::Tools => "tools",
            AppCategory::Media => "media",
            AppCategory::Communication => "communication",
            AppCategory::Games => "games",
            AppCategory::Productivity => "productivity",
            AppCategory::Education => "education",
            AppCategory::System => "system",
        }
    }
}

impl fmt::Display for AppCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How the packaged artifact is laid out once downloaded. The engine treats a
/// package as an opaque byte blob (it only *verifies* it); a future installer
/// interprets the format to place files.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageFormat {
    #[default]
    TarGz,
    Zip,
}

impl PackageFormat {
    pub fn as_str(&self) -> &'static str {
        match self {
            PackageFormat::TarGz => "tar.gz",
            PackageFormat::Zip => "zip",
        }
    }
}

// ---------------------------------------------------------------------------
// Package + manifest
// ---------------------------------------------------------------------------

/// Where a package lives and how its integrity is proven. `url` is what the
/// store will download; `sha256` (when present) is verified against the bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageRef {
    pub format: PackageFormat,
    pub url: String,
    /// Expected digest of the artifact at `url`. When `None` the engine allows
    /// the install without integrity verification (a trusted / local source).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<Checksum>,
    /// Announced payload size in bytes (informational; progress bars).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

impl PackageRef {
    /// A package reference that will be verified against the given digest.
    pub fn with_checksum(mut self, checksum: Checksum) -> Self {
        self.sha256 = Some(checksum);
        self
    }
}

/// A developer's (publisher's) Ed25519 signature over the *manifest itself*.
///
/// The package `sha256` already proves a downloaded artifact wasn't corrupted;
/// this binds an identity to the manifest, so a store can tell "who published
/// this" and reject manifests whose content doesn't match their signature.
///
/// The signature is computed over the canonical bytes of the manifest with its
/// own `publisher` field cleared (see [`AppManifest::manifest_payload_bytes`]),
/// so signing and verifying never fight the field being signed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublisherSig {
    /// Hex-encoded Ed25519 public key (64 hex chars = 32 bytes).
    pub public_key: String,
    /// Hex-encoded Ed25519 signature (128 hex chars = 64 bytes).
    pub signature: String,
}

/// The developer-facing record published in a store catalog. Everything a store
/// UI shows about an app (identity, authorship, category, icon) plus the
/// [`PackageRef`] to fetch for installation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppManifest {
    /// Globally-unique app slug, validated by [`AppManifest::validate`].
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// One-line description shown in list views.
    #[serde(default)]
    pub summary: String,
    /// Full description shown on the detail page.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Publishing developer / organization (the ecosystem credit).
    #[serde(default)]
    pub author: String,
    /// Version of *this* manifest / published release.
    pub version: Version,
    pub category: AppCategory,
    /// Developer homepage (optional).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub homepage: String,
    /// App icon URL (optional).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub icon_url: String,
    /// The artifact to download for installation.
    pub package: PackageRef,
    /// Optional developer signature binding an identity to this manifest
    /// (see [`PublisherSig`]). Absent = unsigned (sha256 still covers the
    /// package bytes, but nothing attests authorship).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<PublisherSig>,
}

impl AppManifest {
    /// Check the free-text identity invariants a provider could violate:
    /// a well-formed id and a non-empty name. The engine validates every
    /// manifest it processes before trusting it.
    pub fn validate(&self) -> Result<()> {
        if !valid_id(&self.id) {
            return Err(StoreError::InvalidAppId(self.id.clone()));
        }
        if self.name.trim().is_empty() {
            return Err(StoreError::InvalidAppId(format!(
                "{} (empty display name)",
                self.id
            )));
        }
        Ok(())
    }

    /// Whether this manifest carries a developer signature.
    pub fn is_signed(&self) -> bool {
        self.publisher.is_some()
    }

    /// The canonical bytes a publisher signature is computed over: this
    /// manifest with its own `publisher` field cleared, JSON-serialized. Both
    /// signing and verifying use this exact function, so the field being signed
    /// can never make the digest self-referential.
    pub fn manifest_payload_bytes(&self) -> Result<Vec<u8>> {
        let mut payload = self.clone();
        payload.publisher = None;
        serde_json::to_vec(&payload)
            .map_err(|e| StoreError::Provider(format!("serialize manifest payload: {e}")))
    }
}

impl fmt::Display for AppManifest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({}) v{}", self.name, self.id, self.version)
    }
}

/// Whether `id` is an allowed app slug: non-empty, lowercase alphanumerics with
/// `.`, `_` or `-` separators that never lead, trail, or repeat. Reverse-DNS
/// ids like `org.amos.pomodoro` fit naturally. Shared with the URI host
/// (`crate::host`) so an `amos-app://<id>/…` netloc is validated identically.
pub(crate) fn valid_id(id: &str) -> bool {
    if id.is_empty() {
        return false;
    }
    let sep = |b: u8| matches!(b, b'.' | b'_' | b'-');
    let mut bytes = id.bytes();
    let first = bytes.next().unwrap_or(0);
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    let mut prev_sep = false;
    for b in bytes {
        if b.is_ascii_lowercase() || b.is_ascii_digit() {
            prev_sep = false;
        } else if sep(b) {
            if prev_sep {
                return false; // no leading/consecutive separators
            }
            prev_sep = true;
        } else {
            return false; // disallowed character
        }
    }
    !prev_sep // must not end on a separator
}

// ---------------------------------------------------------------------------
// Installed app
// ---------------------------------------------------------------------------

/// The local record kept once an app is installed: a snapshot of the manifest
/// the engine verified & installed, plus when it was installed (unix epoch secs).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledApp {
    /// The manifest that produced this install (identity, version, package).
    pub manifest: AppManifest,
    /// Unix epoch seconds at install time.
    pub installed_at: i64,
}

impl InstalledApp {
    pub fn id(&self) -> &str {
        &self.manifest.id
    }

    pub fn version(&self) -> &Version {
        &self.manifest.version
    }
}

/// A serializable summary of an app's lifecycle state — what a store UI shows
/// for the "Install / Open / Update" button.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AppStatus {
    /// Published in the catalog, not installed.
    Available,
    /// Installed and up to date (or the catalog no longer lists it).
    #[serde(rename = "installed")]
    Installed { version: String },
    /// Installed, and the catalog has a newer release.
    #[serde(rename = "updatable")]
    Updatable { installed: String, latest: String },
}

impl fmt::Display for AppStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppStatus::Available => f.write_str("available"),
            AppStatus::Installed { version } => write!(f, "installed v{version}"),
            AppStatus::Updatable { installed, latest } => {
                write!(f, "update available: v{installed} -> v{latest}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn version_parses_and_displays() {
        assert_eq!(Version::parse("1.4.0").unwrap().to_string(), "1.4.0");
        assert_eq!(
            Version::parse("2.1.3-Beta.2").unwrap().to_string(),
            "2.1.3-beta.2",
            "pre-release normalized to lowercase"
        );
        let ver = v("1.0.0");
        assert_eq!((ver.major, ver.minor, ver.patch), (1, 0, 0));
    }

    #[test]
    fn version_rejects_bad_input() {
        for bad in [
            "", "1", "1.2", "1.2.3.4", "a.b.c", "1.x.3", "1.2.", ".1.2", "1..2.3", "1.2.3-",
        ] {
            assert!(Version::parse(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn version_orders_release_over_prerelease_and_numeric() {
        assert!(v("1.0.0") < v("1.0.1"));
        assert!(v("1.9.0") < v("2.0.0"));
        assert!(v("1.0.0-beta") < v("1.0.0"), "prerelease < its release");
        assert!(v("1.0.0-alpha") < v("1.0.0-beta"));
        assert_eq!(v("2.0.0"), v("2.0.0"));
        assert!(v("2.0.0") > v("2.0.0-rc.1"));
    }

    #[test]
    fn checksum_roundtrip_and_tamper_detection() {
        let data = b"hello app payload";
        let hex = Checksum::sha256_hex(data);
        assert_eq!(hex.len(), 64);
        let cs = Checksum::sha256(hex.to_uppercase()).unwrap();
        assert_eq!(cs.value, hex, "uppercase normalized to lowercase");
        assert!(cs.verify(data), "honest bytes verify");

        let mut tampered = data.to_vec();
        tampered[0] ^= 0xff;
        assert!(!cs.verify(&tampered), "a single flipped byte must fail");
    }

    #[test]
    fn checksum_rejects_malformed_hex() {
        for bad in ["", "abc", "gg".repeat(32).as_str(), "a".repeat(63).as_str()] {
            assert!(Checksum::sha256(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn app_id_validation() {
        for good in [
            "org.amos.pomodoro",
            "amos-maze",
            "notes_lite",
            "a1",
            "a.b-c_d",
        ] {
            assert!(valid_id(good), "{good:?} should be valid");
        }
        for bad in [
            "",
            "Caps",
            "1Caps",
            ".lead",
            "trail.",
            "a..b",
            "a--b",
            "has space",
            "emoji!",
            "a/b",
        ] {
            assert!(!valid_id(bad), "{bad:?} should be invalid");
        }
    }

    #[test]
    fn manifest_validate_rejects_bad_id_or_name() {
        let ok = AppManifest {
            id: "org.amos.demo".into(),
            name: "Demo".into(),
            summary: "s".into(),
            description: String::new(),
            author: "A".into(),
            version: Version::new(1, 0, 0),
            category: AppCategory::Tools,
            homepage: String::new(),
            icon_url: String::new(),
            package: PackageRef {
                format: PackageFormat::TarGz,
                url: "https://example.com/a.tgz".into(),
                sha256: None,
                size_bytes: None,
            },
            publisher: None,
        };
        assert!(ok.validate().is_ok());

        let mut bad_id = ok.clone();
        bad_id.id = "Has Space".into();
        assert!(matches!(
            bad_id.validate(),
            Err(StoreError::InvalidAppId(_))
        ));

        let mut empty_name = ok;
        empty_name.name = "   ".into();
        assert!(matches!(
            empty_name.validate(),
            Err(StoreError::InvalidAppId(_))
        ));
    }
}
