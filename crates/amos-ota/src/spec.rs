//! The wire shapes of an update: [`Channel`], [`Signature`], [`UpdatePackage`],
//! [`Manifest`], and the deterministic rollout [`Cohort`].
//!
//! Everything here is validated **at construction** — a package that exists as a
//! value cannot have an empty URI, a malformed digest or a nonsensical size, so
//! no downstream code has to re-check (or, worse, forget to).
//!
//! "At construction" has to include **deserialization**, because a manifest is
//! JSON off a CDN and that is the production path: a derived `Deserialize` would
//! make every field-level invariant above a lie — a `size_bytes` above
//! [`MAX_PACKAGE_BYTES`] would sail past the ceiling that exists so a downloader
//! does not reserve the memory, and a zero-byte "image" would reach
//! [`crate::install::InstallState::Staged`]. Each wire type therefore derives
//! `Deserialize` through `#[serde(try_from = …)]` into its own constructor
//! (`Version` does the same with a hand-written impl), so there is **one** place
//! per type where a value is judged, and no way in that skips it.

use serde::{Deserialize, Serialize};

use crate::error::{OtaError, Result};
use crate::version::Version;

/// The largest package this core will model (8 GiB). A full system image is big,
/// but a claimed size above this is not a real image and is refused rather than
/// trusted by a downloader that would reserve the memory.
pub const MAX_PACKAGE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// A release channel. Stable receives only tagged releases; Beta may receive
/// prereleases and is the intended early-access lane.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Beta,
}

impl Channel {
    /// Stable wire/UI key.
    pub fn key(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Beta => "beta",
        }
    }

    /// Parse from a key; `None` for an unknown string.
    pub fn from_key(s: &str) -> Option<Channel> {
        match s {
            "stable" => Some(Channel::Stable),
            "beta" => Some(Channel::Beta),
            _ => None,
        }
    }

    /// Whether this channel may carry a *prerelease* version.
    pub fn allows_prerelease(self) -> bool {
        matches!(self, Channel::Beta)
    }
}

/// A detached signature over the package bytes, produced by the release key
/// `key_id`. The core never invents a scheme: which algorithm a `key_id` implies
/// is the deployment's ([`crate::verify::SignatureVerifier`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "SignatureWire")]
pub struct Signature {
    key_id: String,
    /// Lowercase hex; length is algorithm-dependent (e.g. 128 for Ed25519).
    value: String,
}

/// The raw shape [`Signature`] is deserialized from, before validation.
#[derive(Deserialize)]
struct SignatureWire {
    key_id: String,
    value: String,
}

impl TryFrom<SignatureWire> for Signature {
    type Error = OtaError;
    fn try_from(w: SignatureWire) -> Result<Signature> {
        Signature::new(w.key_id, w.value)
    }
}

impl Signature {
    /// Build a signature, validating that the key id is non-empty and the value
    /// is non-empty even-length hex.
    pub fn new(key_id: impl Into<String>, value: impl Into<String>) -> Result<Signature> {
        let key_id = key_id.into();
        let value = value.into();
        if key_id.trim().is_empty() {
            return Err(OtaError::InvalidManifest(
                "signature key id is empty".into(),
            ));
        }
        if value.is_empty() || value.len() % 2 != 0 || hex::decode(&value).is_err() {
            return Err(OtaError::InvalidHex(format!("signature value: {value}")));
        }
        Ok(Signature {
            key_id,
            value: value.to_ascii_lowercase(),
        })
    }

    pub fn key_id(&self) -> &str {
        &self.key_id
    }
    /// The lowercase-hex signature bytes.
    pub fn value(&self) -> &str {
        &self.value
    }
}

/// One installable image: where to get it, how big it is, and the digest that
/// must match before it may be staged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "UpdatePackageWire")]
pub struct UpdatePackage {
    version: Version,
    channel: Channel,
    uri: String,
    /// Lowercase-hex SHA-256 of the package bytes (64 characters).
    sha256: String,
    size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    signature: Option<Signature>,
}

/// The raw shape [`UpdatePackage`] is deserialized from, before validation.
#[derive(Deserialize)]
struct UpdatePackageWire {
    version: Version,
    channel: Channel,
    uri: String,
    sha256: String,
    size_bytes: u64,
    #[serde(default)]
    signature: Option<Signature>,
}

impl TryFrom<UpdatePackageWire> for UpdatePackage {
    type Error = OtaError;
    fn try_from(w: UpdatePackageWire) -> Result<UpdatePackage> {
        let pkg = UpdatePackage::new(w.version, w.channel, w.uri, w.sha256, w.size_bytes)?;
        Ok(match w.signature {
            Some(sig) => pkg.with_signature(sig),
            None => pkg,
        })
    }
}

impl UpdatePackage {
    /// Build a package. Refused: empty URI, a digest that is not 64-hex, a size
    /// of `0` or above [`MAX_PACKAGE_BYTES`]. The URI is normalised only by
    /// trimming surrounding whitespace — the scheme is the provider's business.
    pub fn new(
        version: Version,
        channel: Channel,
        uri: impl Into<String>,
        sha256: impl Into<String>,
        size_bytes: u64,
    ) -> Result<UpdatePackage> {
        let uri = uri.into();
        if uri.trim().is_empty() {
            return Err(OtaError::InvalidManifest("package uri is empty".into()));
        }
        // The doc's normalisation, actually applied (REQ-A1874 / F-OTA-010): a
        // manifest is JSON off a CDN, and the provider keys payloads by `uri()`,
        // so padding left on the value makes a valid package unfetchable while
        // the doc claims it was trimmed. Trim *after* the emptiness check, so a
        // whitespace-only uri is still refused rather than normalised into a
        // silently-empty one.
        let uri = uri.trim().to_string();
        let sha256 = sha256.into().to_ascii_lowercase();
        if sha256.len() != 64 || hex::decode(&sha256).is_err() {
            return Err(OtaError::InvalidHex(format!("sha256 digest: {sha256}")));
        }
        if size_bytes == 0 {
            return Err(OtaError::InvalidManifest(
                "package size is zero (an empty image is not installable)".into(),
            ));
        }
        if size_bytes > MAX_PACKAGE_BYTES {
            return Err(OtaError::InvalidManifest(format!(
                "package size {size_bytes} exceeds the {MAX_PACKAGE_BYTES}-byte ceiling"
            )));
        }
        Ok(UpdatePackage {
            version,
            channel,
            uri,
            sha256,
            size_bytes,
            signature: None,
        })
    }

    /// Attach a detached signature (builder form).
    pub fn with_signature(mut self, sig: Signature) -> UpdatePackage {
        self.signature = Some(sig);
        self
    }

    pub fn version(&self) -> &Version {
        &self.version
    }
    pub fn channel(&self) -> Channel {
        self.channel
    }
    pub fn uri(&self) -> &str {
        &self.uri
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn size_bytes(&self) -> u64 {
        self.size_bytes
    }
    pub fn signature(&self) -> Option<&Signature> {
        self.signature.as_ref()
    }
}

/// The set of packages a channel is currently offering, plus the oldest version
/// the fleet still supports (below which a package-level update is not enough
/// and a full-image reflash is required).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    packages: Vec<UpdatePackage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    min_supported_version: Option<Version>,
}

impl Manifest {
    /// Build a manifest from already-validated packages.
    ///
    /// No per-package loop: an [`UpdatePackage`] can only exist if it passed its
    /// constructor (the `Deserialize` path goes through that constructor too), so
    /// there is nothing left to re-check here. The `Result` is kept because the
    /// signature is part of the crate's public API.
    pub fn new(
        packages: Vec<UpdatePackage>,
        min_supported_version: Option<Version>,
    ) -> Result<Manifest> {
        Ok(Manifest {
            packages,
            min_supported_version,
        })
    }

    pub fn packages(&self) -> &[UpdatePackage] {
        &self.packages
    }
    pub fn min_supported_version(&self) -> Option<&Version> {
        self.min_supported_version.as_ref()
    }

    /// The highest-precedence package on `channel` that is strictly newer than
    /// `current`, if any. Ties (equal precedence, e.g. same version on two URIs)
    /// are broken by the package's own order in the manifest, so the result is
    /// deterministic for a fixed manifest.
    pub fn update_from(&self, channel: Channel, current: &Version) -> Option<&UpdatePackage> {
        self.packages
            .iter()
            .filter(|p| p.channel == channel && &p.version > current)
            .max_by(|a, b| a.version.cmp(&b.version))
    }

    /// The highest-precedence **release** (no prerelease suffix) on `channel` that
    /// is strictly newer than `current`, if any.
    ///
    /// Sibling of [`Manifest::update_from`], which also considers prereleases. The
    /// prerelease gate has to pick from the candidates a policy *accepts* before it
    /// picks the newest; otherwise the newest entry being a prerelease the device
    /// refuses silently discards a release that is on offer in the same manifest.
    /// Same ordering rule as `update_from` (precedence, then manifest order).
    pub fn release_update_from(&self, channel: Channel, current: &Version) -> Option<&UpdatePackage> {
        self.packages
            .iter()
            .filter(|p| p.channel == channel && &p.version > current && !p.version.is_prerelease())
            .max_by(|a, b| a.version.cmp(&b.version))
    }

    /// The highest-precedence package on `channel` that is strictly newer than
    /// `current`, **carries a signature**, and — when `allow_prerelease` is false —
    /// is not a prerelease.
    ///
    /// Sibling of [`Manifest::release_update_from`], for the *signature* gate the way
    /// that one is for the prerelease gate: a policy that requires a signature must
    /// pick from the signed candidates before it picks the newest, or an unsigned
    /// newest entry vetoes a signed package on offer in the same manifest. The
    /// prerelease flag is honoured here too so the fallback cannot re-admit a
    /// prerelease that gate already refused. Same ordering rule as `update_from`
    /// (precedence, then manifest order).
    pub fn signed_update_from(
        &self,
        channel: Channel,
        current: &Version,
        allow_prerelease: bool,
    ) -> Option<&UpdatePackage> {
        self.packages
            .iter()
            .filter(|p| {
                p.channel == channel
                    && &p.version > current
                    && p.signature.is_some()
                    && (allow_prerelease || !p.version.is_prerelease())
            })
            .max_by(|a, b| a.version.cmp(&b.version))
    }

    /// Every package on `channel`, newest first (deterministic).
    pub fn channel_history(&self, channel: Channel) -> Vec<&UpdatePackage> {
        let mut v: Vec<&UpdatePackage> = self
            .packages
            .iter()
            .filter(|p| p.channel == channel)
            .collect();
        v.sort_by(|a, b| b.version.cmp(&a.version));
        v
    }

    /// Whether `current` is so old that a package update is not offered (the
    /// device must be reflashed to `min_supported_version` or later).
    pub fn requires_reflash_from(&self, current: &Version) -> bool {
        matches!(&self.min_supported_version, Some(min) if current < min)
    }
}

/// A deterministic, salt-scoped rollout window: `percentage` percent of devices
/// are in the cohort. The bucket is a pure function of `(salt, device_id)`, so
/// the same device always lands in the same bucket for a given rollout — a
/// deployment can widen `percentage` and every device that was already in stays
/// in (buckets only get *added*, never shuffled).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "CohortWire")]
pub struct Cohort {
    salt: String,
    percentage: u8,
}

/// The raw shape [`Cohort`] is deserialized from, before validation.
#[derive(Deserialize)]
struct CohortWire {
    salt: String,
    percentage: u8,
}

impl TryFrom<CohortWire> for Cohort {
    type Error = OtaError;
    fn try_from(w: CohortWire) -> Result<Cohort> {
        Cohort::new(w.salt, w.percentage)
    }
}

impl Cohort {
    /// A cohort covering `percentage` percent (clamped to 100). An empty salt is
    /// refused: a salt of `""` makes every rollout bucket-identical, which would
    /// silently make "staged rollout" meaningless.
    pub fn new(salt: impl Into<String>, percentage: u8) -> Result<Cohort> {
        let salt = salt.into();
        if salt.trim().is_empty() {
            return Err(OtaError::InvalidManifest(
                "rollout salt is empty (a staged rollout needs a scope)".into(),
            ));
        }
        Ok(Cohort {
            salt,
            percentage: percentage.min(100),
        })
    }

    /// The device's stable bucket in `0..100`.
    ///
    /// An empty `device_id` has no bucket of its own: the result is
    /// `fnv1a(salt, "")`, a function of the **salt alone**, so every unnamed
    /// caller gets the same value. Callers wanting a *decision* for such an id
    /// should ask [`Self::includes`], which withholds it.
    pub fn bucket(&self, device_id: &str) -> u8 {
        (fnv1a(&self.salt, device_id) % 100) as u8
    }

    /// Whether `device_id` is inside this rollout window.
    ///
    /// A blank / whitespace-only id is **never** admitted, at any percentage —
    /// not even a 100% wave. The bucket for the empty string is a function of
    /// the salt alone (see [`Self::bucket`]), so admitting it would put every
    /// anonymous caller on one bucket and make a `50`-percent wave mean "all of
    /// them" or "none of them" rather than half. This is the same refusal
    /// [`Cohort::new`] makes for an empty *salt* — there, the scope is what
    /// cannot be placed; here, the device. `includes` returns a `bool` and has
    /// no way to say "unknown", so the honest verdict for an unplaceable id is
    /// "not in".
    pub fn includes(&self, device_id: &str) -> bool {
        if device_id.trim().is_empty() {
            return false;
        }
        u32::from(self.bucket(device_id)) < u32::from(self.percentage)
    }

    pub fn percentage(&self) -> u8 {
        self.percentage
    }
}

/// FNV-1a over `salt || 0x00 || device_id`, in `u32`. Deterministic across
/// platforms and runs (no `RandomState`, no clock) — that is the whole point.
fn fnv1a(salt: &str, device_id: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for b in salt
        .bytes()
        .chain(std::iter::once(0u8))
        .chain(device_id.bytes())
    {
        hash ^= u32::from(b);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkg(v: &str, ch: Channel, size: u64) -> UpdatePackage {
        UpdatePackage::new(
            Version::parse(v).unwrap(),
            ch,
            format!("https://cdn/{v}.img"),
            "a".repeat(64),
            size,
        )
        .unwrap()
    }

    #[test]
    fn channel_keys_round_trip() {
        for c in [Channel::Stable, Channel::Beta] {
            assert_eq!(Channel::from_key(c.key()), Some(c));
        }
        assert_eq!(Channel::from_key("nightly"), None);
        assert!(Channel::Beta.allows_prerelease());
        assert!(!Channel::Stable.allows_prerelease());
    }

    #[test]
    fn package_validation_refuses_bad_values() {
        let v = || Version::parse("1.0.0").unwrap();
        assert!(UpdatePackage::new(v(), Channel::Stable, "", "a".repeat(64), 10).is_err());
        assert!(UpdatePackage::new(v(), Channel::Stable, "u", "abcd", 10).is_err());
        assert!(UpdatePackage::new(v(), Channel::Stable, "u", "z".repeat(64), 10).is_err());
        assert!(UpdatePackage::new(v(), Channel::Stable, "u", "a".repeat(64), 0).is_err());
        assert!(UpdatePackage::new(
            v(),
            Channel::Stable,
            "u",
            "a".repeat(64),
            MAX_PACKAGE_BYTES + 1
        )
        .is_err());
        // Upper-case hex normalises rather than failing.
        let p = UpdatePackage::new(v(), Channel::Stable, "u", "A".repeat(64), 1).unwrap();
        assert_eq!(p.sha256(), &"a".repeat(64));
    }

    #[test]
    fn signature_validation() {
        assert!(Signature::new("", "aa").is_err());
        assert!(Signature::new("k", "abc").is_err()); // odd length
        assert!(Signature::new("k", "zz").is_err()); // not hex
        let s = Signature::new("k", "AABB").unwrap();
        assert_eq!(s.value(), "aabb");
        assert_eq!(s.key_id(), "k");
    }

    #[test]
    fn update_from_picks_newest_in_channel_above_current() {
        let m = Manifest::new(
            vec![
                pkg("1.1.0", Channel::Stable, 100),
                pkg("1.2.0", Channel::Stable, 100),
                pkg("2.0.0-beta.1", Channel::Beta, 100),
            ],
            None,
        )
        .unwrap();
        let cur = Version::parse("1.0.0").unwrap();
        assert_eq!(
            m.update_from(Channel::Stable, &cur)
                .unwrap()
                .version()
                .to_string(),
            "1.2.0"
        );
        // Beta has nothing newer than the stable current either.
        assert_eq!(
            m.update_from(Channel::Beta, &cur)
                .unwrap()
                .version()
                .to_string(),
            "2.0.0-beta.1"
        );
        // Already current ⇒ no update.
        let cur2 = Version::parse("1.2.0").unwrap();
        assert!(m.update_from(Channel::Stable, &cur2).is_none());
    }

    #[test]
    fn channel_history_is_newest_first() {
        let m = Manifest::new(
            vec![
                pkg("1.0.0", Channel::Stable, 100),
                pkg("1.3.0", Channel::Stable, 100),
                pkg("1.1.0", Channel::Stable, 100),
            ],
            None,
        )
        .unwrap();
        let hist: Vec<String> = m
            .channel_history(Channel::Stable)
            .iter()
            .map(|p| p.version().to_string())
            .collect();
        assert_eq!(hist, vec!["1.3.0", "1.1.0", "1.0.0"]);
    }

    #[test]
    fn reflash_threshold() {
        let m = Manifest::new(
            vec![pkg("3.0.0", Channel::Stable, 100)],
            Some(Version::parse("2.0.0").unwrap()),
        )
        .unwrap();
        assert!(m.requires_reflash_from(&Version::parse("1.9.0").unwrap()));
        assert!(!m.requires_reflash_from(&Version::parse("2.0.0").unwrap()));
    }

    #[test]
    fn cohort_is_deterministic_and_additive() {
        let c = Cohort::new("rollout-2026-09", 50).unwrap();
        // Deterministic across calls.
        assert_eq!(c.bucket("device-1"), c.bucket("device-1"));
        assert_eq!(c.includes("device-1"), c.includes("device-1"));
        // Widening the window never removes an included device.
        let wide = Cohort::new("rollout-2026-09", 100).unwrap();
        for i in 0..500 {
            let d = format!("device-{i}");
            if c.includes(&d) {
                assert!(wide.includes(&d), "{d} must stay in when widened");
            }
        }
        // A 100% cohort includes every device; a 0% cohort includes none.
        assert!((0..200).all(|i| wide.includes(&format!("d{i}"))));
        let none = Cohort::new("s", 0).unwrap();
        assert!((0..200).all(|i| !none.includes(&format!("d{i}"))));
    }

    #[test]
    fn cohort_refuses_empty_salt_and_clamps() {
        assert!(Cohort::new("   ", 50).is_err());
        assert_eq!(Cohort::new("s", 250).unwrap().percentage(), 100);
    }

    /// A device id that names no device cannot be *placed* in the cohort.
    ///
    /// `bucket("")` is `fnv1a(salt, "")` — a function of the salt alone — so
    /// every anonymous caller lands in the **same** bucket. Comparing that
    /// constant against `percentage` admits all of them into a 50% wave, or
    /// none, depending only on the salt: the staged rollout silently stops
    /// being staged. The salt gets exactly this guard at construction ("a salt
    /// of `""` makes every rollout bucket-identical, which would silently make
    /// 'staged rollout' meaningless"); the id it hashes needs the same answer.
    /// `includes` is a `bool` and cannot say "unknown", so the honest verdict
    /// for an unplaceable id is "not in" — as [`super::fnv1a`]'s sibling
    /// `version_gte` refuses a version it cannot place.
    #[test]
    fn a_blank_device_id_is_never_admitted_to_a_cohort() {
        // Not even a 100% wave may admit a device it cannot identify.
        let all = Cohort::new("wave1", 100).unwrap();
        assert!(
            !all.includes(""),
            "an unnamed device is not 'the one device'"
        );
        assert!(!all.includes("   "), "whitespace is not an identity either");
        // …nor may any other percentage, in either direction.
        for pct in [0u8, 1, 50, 99, 100] {
            let c = Cohort::new("wave1", pct).unwrap();
            assert!(!c.includes(""), "percent={pct}");
            assert!(!c.includes("\t"), "percent={pct}");
        }
        // The tell: the empty id is not a *bucket value*, it is one bucket for
        // every such caller — a constant, so no rollout can happen.
        assert_eq!(all.bucket(""), all.bucket(""));
        // Positive control: a real id still rolls, and the 100%/0% corners hold.
        assert!(all.includes("device-42"));
        assert!(!Cohort::new("wave1", 0).unwrap().includes("device-42"));
    }

    /// The module's headline promise is "validated at construction", and a
    /// manifest arrives as JSON off a CDN — so "construction" has to include
    /// `Deserialize`, or every constructor check is advisory. This is the test
    /// that fails the moment the derive is put back.
    #[test]
    fn deserialization_cannot_bypass_the_constructors() {
        let digest = "a".repeat(64);
        let pkg_json = |uri: &str, sha: &str, size: u64, sig: &str| {
            format!(
                r#"{{"packages":[{{"version":"1.0.0","channel":"stable","uri":"{uri}",
                    "sha256":"{sha}","size_bytes":{size}{sig}}}]}}"#
            )
        };
        // Every refusal its constructor makes, made again through the wire.
        for (what, json) in [
            ("empty uri", pkg_json("", &digest, 10, "")),
            ("short digest", pkg_json("u", "abcd", 10, "")),
            ("non-hex digest", pkg_json("u", "zz", 10, "")),
            ("zero size", pkg_json("u", &digest, 0, "")),
            (
                "over the ceiling",
                pkg_json("u", &digest, MAX_PACKAGE_BYTES + 1, ""),
            ),
            (
                "empty signature key",
                pkg_json(
                    "u",
                    &digest,
                    10,
                    r#","signature":{"key_id":"","value":"aa"}"#,
                ),
            ),
            (
                "odd-length signature",
                pkg_json(
                    "u",
                    &digest,
                    10,
                    r#","signature":{"key_id":"k","value":"abc"}"#,
                ),
            ),
        ] {
            assert!(
                serde_json::from_str::<Manifest>(&json).is_err(),
                "the wire path accepted {what}"
            );
        }
        // …and the shape a real manifest has still parses, signature included.
        let ok = pkg_json(
            "u",
            &digest,
            10,
            r#","signature":{"key_id":"k","value":"AABB"}"#,
        );
        let m: Manifest = serde_json::from_str(&ok).expect("a valid manifest parses");
        assert_eq!(
            m.packages()[0].signature().map(Signature::value),
            Some("aabb"),
            "the wire path must still normalise, not merely accept"
        );

        // The other two wire types judge their own fields on the way in.
        assert!(serde_json::from_str::<Cohort>(r#"{"salt":"","percentage":42}"#).is_err());
        assert!(serde_json::from_str::<Signature>(r#"{"key_id":"k","value":"abc"}"#).is_err());
        assert_eq!(
            serde_json::from_str::<Cohort>(r#"{"salt":"s","percentage":250}"#)
                .unwrap()
                .percentage(),
            100,
            "the wire path clamps like the constructor, it does not reject"
        );

        // Serialization is unchanged by the validating path: absent signature is
        // still omitted, and a round trip is the identity.
        let p = pkg("1.2.3", Channel::Stable, 9);
        let json = serde_json::to_string(&p).unwrap();
        assert!(!json.contains("signature"), "{json}");
        assert_eq!(
            serde_json::from_str::<UpdatePackage>(&json).unwrap(),
            p,
            "wire round trip must be the identity"
        );
    }

    #[test]
    fn different_salts_partition_differently() {
        let a = Cohort::new("salt-a", 100).unwrap();
        let b = Cohort::new("salt-b", 100).unwrap();
        // 100% cohorts include everyone regardless of salt (sanity)…
        assert!(a.includes("x") && b.includes("x"));
        // …but the *buckets* differ for at least one device, proving the salt
        // actually scopes the partition (not a constant function).
        let differs = (0..100).any(|i| {
            let d = format!("dev{i}");
            a.bucket(&d) != b.bucket(&d)
        });
        assert!(differs, "salt must affect the bucket");
    }

    /// [`UpdatePackage::new`]'s doc promises the URI "is normalised only by
    /// trimming surrounding whitespace". A manifest is JSON off a CDN (and a
    /// field edited by hand easily carries a stray space or newline), and the
    /// provider keys payloads by `uri()` — so an untrimmed URI makes a
    /// perfectly valid package **unfetchable** while the doc says the padding
    /// was removed. This asserts the promise on all three faces at once: the
    /// direct constructor, the wire parse, and the fetch that keys on it.
    #[test]
    fn a_package_uri_is_normalised_by_trimming_the_way_its_doc_says() {
        let digest = "a".repeat(64);
        let p = UpdatePackage::new(
            Version::parse("1.1.0").unwrap(),
            Channel::Stable,
            "  https://cdn/1.1.0.img\n",
            &digest,
            3,
        )
        .unwrap();
        assert_eq!(
            p.uri(),
            "https://cdn/1.1.0.img",
            "the constructor stores the padded URI"
        );

        // The same promise must hold through the wire, or the JSON off a CDN is
        // judged by a weaker rule than the constructor.
        let json = format!(
            r#"{{"packages":[{{"version":"1.1.0","channel":"stable",
                "uri":"  https://cdn/1.1.0.img  ","sha256":"{digest}","size_bytes":3}}]}}"#
        );
        let manifest: Manifest = serde_json::from_str(&json).unwrap();
        assert_eq!(
            manifest.packages()[0].uri(),
            "https://cdn/1.1.0.img",
            "the wire path stores the padded URI"
        );

        // The reachable consequence: a provider registers the payload under the
        // canonical URI, and the padded package must still find it. Registering
        // the payload via `with_package` would hide this (it copies the very URI
        // under test) — so the registry is keyed by the clean URI, as a real
        // deployment keyed by the manifest's own URL would be.
        let provider = crate::provider::MockUpdateProvider::new()
            .with_payload("https://cdn/1.1.0.img", b"img".to_vec());
        use crate::provider::UpdateProvider;
        assert_eq!(
            provider
                .fetch_package(&p)
                .expect("a padded URI must still fetch"),
            b"img".to_vec()
        );
    }

    /// The trimming must not become a way to *admit* a URI that is only
    /// whitespace: "   " is not a normalised empty string, it is an empty
    /// string, and it stays refused as the constructor already refuses `""`.
    #[test]
    fn a_whitespace_only_uri_is_still_refused_as_empty() {
        let digest = "a".repeat(64);
        for blank in ["   ", "\t", "\n", " \t\n "] {
            assert!(
                UpdatePackage::new(
                    Version::parse("1.1.0").unwrap(),
                    Channel::Stable,
                    blank,
                    &digest,
                    3,
                )
                .is_err(),
                "whitespace-only uri {blank:?} must be refused, not normalised into a valid one"
            );
        }
    }
}
