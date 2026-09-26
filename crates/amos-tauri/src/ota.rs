//! Host bridge for the system-update (OTA) **decision layer**.
//!
//! `amos-ota` is the domain core that answers "is there an update for me, and may
//! I install it right now?" — but until this module nothing in the product called
//! it: `amos-tauri` did not even depend on the crate, so a whole, fully-tested
//! update path was dead code and the shell had no way to check for one
//! (REQ-A754 / F-SH-211). This bridge is the missing *host* side: it selects a
//! [`UpdateProvider`] from configuration, feeds it the device's own version and
//! channel, and exposes the decision to the Settings「关于本机」page.
//!
//! ## The honest boundary (what this bridge does *not* do)
//!
//! * **It does not flash.** `amos-ota`'s own docs are explicit that writing the
//!   image to the A/B slot and rebooting is the runtime's job. This bridge serves
//!   the *check* and, since REQ-A1457, the **download-and-verify** half of an
//!   install: it reads the image bytes from [`ENV_IMAGE_PATH`] and drives the
//!   `amos-ota` install state machine to `staged`. Reaching `staged` means the
//!   bytes really hashed to the published digest — but applying them still means
//!   a reboot into the other slot, which only the runtime can do. So the result
//!   is reported as *downloaded and verified*, never as "installed".
//! * **It does not invent device facts.** Battery / charging / Wi-Fi / window are
//!   observed by the UI (the WebView reads battery via the host battery command
//!   and the radio state) and passed in. A fact the caller cannot observe is
//!   `None`, which `amos-ota`'s policy renders as a *deferral* — never an
//!   accidental "yes".
//! * **It never fabricates "up to date".** No manifest source ⇒ the check reports
//!   `unreachable` with the reason, not a false all-clear (`amos_ota`'s provider
//!   contract keeps "no source" and "nothing offered" distinguishable; this bridge
//!   preserves that distinction in [`OtaCheckResult::kind`]).

use std::path::PathBuf;

use amos_ota::{
    check_integrity, evaluate, verify_signature, Channel, Decision, DeviceFacts, Ed25519Verifier,
    FailReason, InstallMachine, InstallState, Manifest, OtaError, PolicyReason, SignatureVerdict,
    SignatureVerifier, TrustingVerifier, UntrustedSignaturePolicy, UpdatePackage, UpdatePolicy,
    UpdateProvider, Version, MAX_PACKAGE_BYTES,
};
use serde::Serialize;

/// Upper bound on the bytes read from a manifest file.
///
/// A manifest is a small index (a handful of packages); 4 MiB is generous for
/// that and stops a multi-gigabyte file (or a device node) from being slurped
/// into memory just because a path was configured. Mirrors the "bounded buffer"
/// rule the rest of the host follows.
pub const MAX_OTA_MANIFEST_BYTES: u64 = 4 << 20;

/// Environment variable naming a JSON manifest file to read updates from. Unset
/// ⇒ the bridge is *unconfigured* and `ota_check` honestly says so.
pub const ENV_MANIFEST_PATH: &str = "AMOS_OTA_MANIFEST_PATH";
/// Environment variable naming the release channel (`stable` | `beta`).
pub const ENV_CHANNEL: &str = "AMOS_OTA_CHANNEL";
/// Environment variable naming the **image file** this host may serve for an
/// eligible package. A device build points it at the image its updater service
/// has already downloaded into local storage. Unset ⇒ [`OTA install`] refuses
/// with a reason rather than pretending to have staged anything.
///
/// [`OTA install`]: FileUpdateProvider::fetch_package
pub const ENV_IMAGE_PATH: &str = "AMOS_OTA_IMAGE_PATH";
/// Environment variable naming the signature key ids this host trusts, comma
/// separated. Empty/unset means "trusts none" — the install records the
/// signature verdict either way (as the CLI does); the manifest's own policy
/// gate is what decides whether an unsigned package is offered at all.
///
/// **This is the weak half of the trust configuration.** A bare key id is all a
/// policy-only check needs; setting [`ENV_TRUST_KEY_HEX`] additionally gives the
/// host the public key, and only then can the signature *mathematics* be checked.
pub const ENV_TRUST_KEYS: &str = "AMOS_OTA_TRUST_KEYS";
/// Environment variable naming the trusted Ed25519 **public keys**, as
/// `key_id:public_key_hex` pairs (comma separated). When at least one pair is set
/// the host verifies the signature for real (RFC 8032) and
/// [`OtaSignatureReport::verified_by`] reads `ed25519`; with none it can only
/// match the key id and reads `policy`. The distinction is on the wire because a
/// `trusted` verdict means different things in the two modes.
///
/// Supersedes [`ENV_TRUST_KEYS`] for the keys it names (a key id with a public
/// key is checked against it); ids listed there without a public key cannot be
/// verified at all and read `untrusted`. A malformed pair is an operator error
/// and settles the install with a reason naming this variable — never a silent
/// drop to the policy-only path.
pub const ENV_TRUST_KEY_HEX: &str = "AMOS_OTA_TRUST_KEY_HEX";
/// Environment variable naming this device's rollout id (cohort bucketing).
pub const ENV_DEVICE_ID: &str = "AMOS_OTA_DEVICE_ID";
/// Default device id when [`ENV_DEVICE_ID`] is unset — a stable, deterministic
/// cohort bucket for a host that has no device identity of its own.
pub const DEFAULT_DEVICE_ID: &str = "amos-device";

/// The crate version, parsed lazily so a malformed value is an honest error and
/// never a panic (production code here forbids `unwrap`/`expect`).
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// A [`UpdateProvider`] that reads a manifest from a JSON file on disk.
///
/// This is the host's only real source today: no network client is pulled in,
/// and a device build points [`ENV_MANIFEST_PATH`] at the file its updater
/// service has already fetched. A reachable-but-empty file (or one holding no
/// package on the requested channel) yields `Ok(None)` — "nothing offered" —
/// which stays distinct from an unreadable file's `Err`.
///
/// Its optional `image_path` (from [`ENV_IMAGE_PATH`]) is the *bytes* half: it is
/// what [`fetch_package`](UpdateProvider::fetch_package) serves. The two are
/// separate on purpose — the manifest says what is offered, the image is what
/// would be staged, and a host that has one but not the other must say so.
pub struct FileUpdateProvider {
    path: PathBuf,
    image_path: Option<PathBuf>,
}

impl FileUpdateProvider {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            image_path: None,
        }
    }

    /// Point the provider at the local image file it may serve for a package.
    pub fn with_image(mut self, image: Option<PathBuf>) -> Self {
        self.image_path = image;
        self
    }
}

impl UpdateProvider for FileUpdateProvider {
    fn fetch_manifest(&self, channel: Channel) -> amos_ota::Result<Option<Manifest>> {
        let meta = std::fs::metadata(&self.path).map_err(|e| {
            OtaError::provider(format!(
                "manifest {} is unreadable: {e}",
                self.path.display()
            ))
        })?;
        if meta.len() > MAX_OTA_MANIFEST_BYTES {
            return Err(OtaError::provider(format!(
                "manifest {} is {} bytes (max {MAX_OTA_MANIFEST_BYTES})",
                self.path.display(),
                meta.len()
            )));
        }
        let text = std::fs::read_to_string(&self.path).map_err(|e| {
            OtaError::provider(format!(
                "manifest {} is unreadable: {e}",
                self.path.display()
            ))
        })?;
        let manifest: Manifest = serde_json::from_str(&text).map_err(|e| {
            OtaError::provider(format!(
                "manifest {} is not a valid manifest: {e}",
                self.path.display()
            ))
        })?;
        if manifest.channel_history(channel).is_empty() {
            Ok(None)
        } else {
            Ok(Some(manifest))
        }
    }

    fn fetch_package(&self, _package: &UpdatePackage) -> amos_ota::Result<Vec<u8>> {
        // No image configured is its own honest answer: the host has a manifest but
        // nothing to stage, and saying so is better than an empty success.
        let Some(path) = self.image_path.as_ref() else {
            return Err(OtaError::provider(format!(
                "no update image configured ({ENV_IMAGE_PATH} unset); \
                 applying the image remains the runtime's job"
            )));
        };
        let meta = std::fs::metadata(path).map_err(|e| {
            OtaError::provider(format!("image {} is unreadable: {e}", path.display()))
        })?;
        // Bounded read, mirroring the manifest ceiling: the package-size ceiling is
        // the domain's (a manifest may not even *declare* a bigger one), but this
        // guard stops a device node / a runaway file before it is slurped into RAM.
        if meta.len() > MAX_PACKAGE_BYTES {
            return Err(OtaError::provider(format!(
                "image {} is {} bytes (max {MAX_PACKAGE_BYTES})",
                path.display(),
                meta.len()
            )));
        }
        std::fs::read(path)
            .map_err(|e| OtaError::provider(format!("image {} is unreadable: {e}", path.display())))
    }
}

/// The configured update source (or none).
enum Source {
    Unconfigured,
    File(FileUpdateProvider),
}

impl Source {
    fn from_env() -> Source {
        let image = std::env::var(ENV_IMAGE_PATH)
            .ok()
            .filter(|p| !p.trim().is_empty())
            .map(PathBuf::from);
        match std::env::var(ENV_MANIFEST_PATH) {
            Ok(p) if !p.trim().is_empty() => {
                Source::File(FileUpdateProvider::new(p).with_image(image))
            }
            _ => Source::Unconfigured,
        }
    }

    fn configured(&self) -> bool {
        matches!(self, Source::File(_))
    }

    fn label(&self) -> String {
        match self {
            Source::Unconfigured => String::new(),
            Source::File(p) => p.path.display().to_string(),
        }
    }

    fn provider(&self) -> Option<&dyn UpdateProvider> {
        match self {
            Source::Unconfigured => None,
            Source::File(p) => Some(p),
        }
    }
}

/// The configured release channel, or the reason the configuration is unusable.
///
/// `AMOS_OTA_CHANNEL` is the one variable here with a **closed domain**
/// (`stable` | `beta`). A path ([`ENV_MANIFEST_PATH`]) or a device id
/// ([`ENV_DEVICE_ID`]) accepts any non-blank value, so "unset" and "set to
/// something I did not expect" cannot be confused; a channel cannot. Folding an
/// unrecognised value into `stable` — which is what this function's
/// `unwrap_or(Channel::Stable)` did — made a *typo* indistinguishable from
/// *unset*: the host would run its check on a lane nobody selected, report
/// `up_to_date` against it, and the 「关于本机」 row would read `stable` under an
/// operator who believes they configured `beta`. That is the same over-claim
/// [`TrustConfig::verifier`] refuses for an undecodable [`ENV_TRUST_KEY_HEX`],
/// and it is refused the same way: an error naming the variable.
///
/// The lookup is trimmed and case-folded first, because the value has a closed
/// domain that neither of its spellings has to match byte-for-byte — an env file
/// edited to `AMOS_OTA_CHANNEL=" beta "` (or `Beta`) means `beta`, and every
/// sibling reader here trims before deciding what it was given.
fn channel_from_env() -> Result<Channel, String> {
    parse_channel(env_value(ENV_CHANNEL).as_deref())
}

/// [`channel_from_env`]'s rule, separated from the environment read the way
/// [`TrustConfig::parse`] is, so the judgement is testable without mutating a
/// process-global variable other tests in this binary read.
fn parse_channel(raw: Option<&str>) -> Result<Channel, String> {
    match raw {
        None => Ok(Channel::Stable),
        Some(v) => Channel::from_key(&v.trim().to_ascii_lowercase()).ok_or_else(|| {
            format!("{ENV_CHANNEL}={v:?} is not a channel (expected `stable` or `beta`)")
        }),
    }
}

fn device_id_from_env() -> String {
    std::env::var(ENV_DEVICE_ID)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_DEVICE_ID.to_string())
}

/// The value of `name`, trimmed, when it is set to something non-empty.
fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.trim().is_empty())
}

/// How this host can check a package's signature — the two configurations are
/// **not** interchangeable, and which one ran is reported to the caller.
///
/// * At least one `key_id:public_key_hex` pair in [`ENV_TRUST_KEY_HEX`] ⇒ an
///   [`Ed25519Verifier`] that actually checks the signature (RFC 8032).
///   `verified_by` reads `ed25519` and a `trusted` verdict means the signature
///   verified against the registered public key.
/// * Only bare key ids in [`ENV_TRUST_KEYS`] ⇒ a [`TrustingVerifier`]: it accepts
///   a signature iff the key id is on the list and the value is even-length hex,
///   and performs **no cryptography**. `amos-ota` documents it as *not a security
///   boundary* — it accepts a forged signature from any holder of a trusted key
///   id. `verified_by` reads `policy`, and a `trusted` verdict means only "that
///   key id is on the list".
///
/// Both modes record a verdict; only one of them earns the word. That is why the
/// mode travels with the verdict instead of being assumed.
#[derive(Clone, Debug, Default)]
struct TrustConfig {
    /// `key_id:public_key_hex` pairs — the strong path.
    keys: Vec<(String, String)>,
    /// Bare key ids with no public key attached — the policy-only path.
    ids: Vec<String>,
}

impl TrustConfig {
    /// Parse the two configuration strings — [`ENV_TRUST_KEY_HEX`] first,
    /// [`ENV_TRUST_KEYS`] second. `None` (or a blank value) means the variable is
    /// unset, which is the "trusts none" default: every signed package's verdict
    /// is then `untrusted`, *recorded* not fatal, because the manifest's own
    /// policy gate is what requires a signature in the first place.
    ///
    /// Reading them here (rather than at bridge construction) means a key
    /// rotation does not need a re-launch.
    fn parse(key_hex: Option<&str>, key_ids: Option<&str>) -> Self {
        let keys = key_hex
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(|pair| match pair.split_once(':') {
                Some((id, hex)) => (id.trim().to_string(), hex.trim().to_string()),
                // No `:` ⇒ carry the entry through as an id with an empty key so
                // `insert` rejects it by name, rather than silently discarding a
                // line the operator wrote.
                None => (pair.to_string(), String::new()),
            })
            .collect();
        let ids = key_ids
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(str::to_string)
            .collect();
        Self { keys, ids }
    }

    /// Build the verifier this configuration describes, plus the wire label for
    /// how strong it is (`"ed25519"` | `"policy"`).
    ///
    /// An undecodable public key is returned as an error naming the variable
    /// rather than dropped: falling back to the policy-only path on a *typo*
    /// would leave the host reporting a weaker verdict under the operator's
    /// belief that they configured real keys — the exact over-claim this split
    /// exists to prevent.
    fn verifier(&self) -> Result<(Box<dyn SignatureVerifier>, &'static str), String> {
        if self.keys.is_empty() {
            let ids: Vec<&str> = self.ids.iter().map(String::as_str).collect();
            return Ok((Box::new(TrustingVerifier::new(ids)), "policy"));
        }
        let mut verifier = Ed25519Verifier::new();
        for (id, public_key_hex) in &self.keys {
            verifier
                .insert(id.clone(), public_key_hex)
                .map_err(|e| format!("{ENV_TRUST_KEY_HEX}: key {id:?}: {e}"))?;
        }
        Ok((Box::new(verifier), "ed25519"))
    }
}

/// Read [`TrustConfig`] from the environment.
fn trust_from_env() -> TrustConfig {
    TrustConfig::parse(
        env_value(ENV_TRUST_KEY_HEX).as_deref(),
        env_value(ENV_TRUST_KEYS).as_deref(),
    )
}

/// App-managed OTA state: the configured source, channel and local identity.
pub struct OtaBridge {
    source: Source,
    /// The lane the host actually consults. Falls back to `stable` when
    /// `AMOS_OTA_CHANNEL` is unusable — the conservative lane — but never
    /// silently: [`OtaBridge::channel_error`] carries the reason.
    channel: Channel,
    /// Set when `ENV_CHANNEL` held a value that is not a channel. The
    /// configuration the operator wrote did not take effect, so every surface
    /// that reports the channel reports this alongside it
    /// ([`OtaStatus::channel_error`] on the identity read, `misconfigured` on a
    /// check) rather than presenting the fallback lane as the configured one.
    channel_error: Option<String>,
    device_id: String,
    current: String,
}

impl Default for OtaBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl OtaBridge {
    pub fn new() -> Self {
        let (channel, channel_error) = match channel_from_env() {
            Ok(c) => (c, None),
            Err(e) => (Channel::Stable, Some(e)),
        };
        Self {
            source: Source::from_env(),
            channel,
            channel_error,
            device_id: device_id_from_env(),
            current: CURRENT_VERSION.to_string(),
        }
    }
}

/// Serializable status: who we are and whether an update source is configured.
#[derive(Clone, Debug, Serialize)]
pub struct OtaStatus {
    /// The running system version (this crate's version).
    pub current_version: String,
    /// The release channel key (`stable` / `beta`) the host actually consults.
    pub channel: String,
    /// True only when an update source is configured.
    pub configured: bool,
    /// The configured source (empty when unconfigured) — never a fabricated path.
    pub source: String,
    /// Set when `AMOS_OTA_CHANNEL` was set to something that is not a channel:
    /// `channel` above is then the **fallback** lane, and this is why the
    /// configured one did not take. Absent (not an empty string) when the channel
    /// configuration is fine, so a reader can tell "no problem" from a message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_error: Option<String>,
}

/// Serializable result of a check. `kind` is the discriminant the UI switches on:
/// `up_to_date` | `eligible` | `deferred` | `refused` | `unreachable` |
/// `unconfigured` (no source at all; it is deliberately *not* folded into
/// `up_to_date`, since "we cannot check" is not "you are current") |
/// `misconfigured` (a source exists but `AMOS_OTA_CHANNEL` is not a channel; the
/// check cannot answer for a lane nobody selected — see [`channel_from_env`]).
#[derive(Clone, Debug, Serialize)]
pub struct OtaCheckResult {
    pub kind: String,
    pub current_version: String,
    pub channel: String,
    /// The offered version, when there is one (`eligible`).
    pub version: Option<String>,
    /// Package URI/size for an eligible update (flashing remains the runtime's).
    pub package_uri: Option<String>,
    pub package_bytes: Option<u64>,
    /// A stable machine code for a deferral/refusal (`needs_wifi`, `unsigned`, …).
    pub reason_code: Option<String>,
    /// A human-readable detail: the policy reason, or the provider error text.
    pub detail: Option<String>,
}

fn reason_code(reason: &PolicyReason) -> &'static str {
    match reason {
        PolicyReason::ReflashRequired { .. } => "reflash_required",
        PolicyReason::PrereleaseNotAllowed { .. } => "prerelease_not_allowed",
        PolicyReason::Unsigned => "unsigned",
        PolicyReason::NotInCohort => "not_in_cohort",
        PolicyReason::OutsideWindow => "outside_window",
        PolicyReason::NeedsWifi => "needs_wifi",
        PolicyReason::UnknownBattery => "unknown_battery",
        PolicyReason::LowBattery { .. } => "low_battery",
        PolicyReason::UnknownCharging => "unknown_charging",
    }
}

/// Read the current identity/status. Never fails: an unconfigured bridge is a
/// valid state, not an error.
#[tauri::command]
pub fn ota_status(state: tauri::State<'_, OtaBridge>) -> OtaStatus {
    OtaStatus {
        current_version: state.current.clone(),
        channel: state.channel.key().to_string(),
        configured: state.source.configured(),
        source: state.source.label(),
        channel_error: state.channel_error.clone(),
    }
}

/// The pure core of a check: given a source, channel, local identity and the
/// observed device facts, produce the serializable result. Split out so it can be
/// unit-tested without a Tauri `State` (the command below is a thin shim).
///
/// `battery_percent` is `None` when the caller cannot read the level — the policy
/// then defers rather than guess. `charging` is three-valued for the same reason:
/// `Some(true)` on a charger, `Some(false)` on battery, `None` when the charging
/// state could not be read — a caller that only has a two-valued source must not
/// fold its "unknown" into `false`, because the host would then report a battery
/// problem for a device that may be on a charger.
/// How a decision request resolves before policy is applied: an unconfigured
/// host, an unreadable source, or a real [`Decision`]. Kept distinct from
/// [`OtaCheckResult`] so the check and the install share one decision path
/// (a second copy of the fetch/evaluate logic is how the two drift apart).
enum DecisionOutcome {
    Unconfigured,
    /// `AMOS_OTA_CHANNEL` is not a channel, so there is no lane to decide for.
    Misconfigured(String),
    Unreachable(String),
    Decided(Decision),
}

#[allow(clippy::too_many_arguments)]
fn decide(
    source: &Source,
    channel: Channel,
    channel_error: Option<&str>,
    device_id: &str,
    current: &str,
    battery_percent: Option<u8>,
    charging: Option<bool>,
    on_wifi: bool,
    in_window: bool,
) -> Result<DecisionOutcome, String> {
    let current_v = Version::parse(current)
        .map_err(|e| format!("current version {current} is not valid semver: {e}"))?;

    // Ahead of the source check: an unusable channel makes *every* decision below
    // a verdict about the fallback lane, so it is reported rather than acted on.
    if let Some(e) = channel_error {
        return Ok(DecisionOutcome::Misconfigured(e.to_string()));
    }

    let mut facts = DeviceFacts::new(current_v, device_id.to_string())
        .on_wifi(on_wifi)
        .charging(charging)
        .in_window(in_window);
    if let Some(pct) = battery_percent {
        facts = facts.with_battery(pct);
    }

    let Some(provider) = source.provider() else {
        return Ok(DecisionOutcome::Unconfigured);
    };

    let policy = UpdatePolicy::new(channel);
    match provider.fetch_manifest(channel) {
        Err(e) => Ok(DecisionOutcome::Unreachable(e.to_string())),
        Ok(None) => Ok(DecisionOutcome::Decided(Decision::UpToDate)),
        Ok(Some(manifest)) => Ok(DecisionOutcome::Decided(evaluate(
            &manifest, &policy, &facts,
        ))),
    }
}

#[allow(clippy::too_many_arguments)]
fn run_check(
    source: &Source,
    channel: Channel,
    channel_error: Option<&str>,
    device_id: &str,
    current: &str,
    battery_percent: Option<u8>,
    charging: Option<bool>,
    on_wifi: bool,
    in_window: bool,
) -> Result<OtaCheckResult, String> {
    let base = |kind: &str| OtaCheckResult {
        kind: kind.to_string(),
        current_version: current.to_string(),
        channel: channel.key().to_string(),
        version: None,
        package_uri: None,
        package_bytes: None,
        reason_code: None,
        detail: None,
    };

    Ok(
        match decide(
            source,
            channel,
            channel_error,
            device_id,
            current,
            battery_percent,
            charging,
            on_wifi,
            in_window,
        )? {
            // Unconfigured is *not* "up to date": report it as its own kind so the UI
            // never renders a false all-clear.
            DecisionOutcome::Unconfigured => {
                let mut r = base("unconfigured");
                r.detail = Some(format!(
                    "no update source configured ({ENV_MANIFEST_PATH} unset)"
                ));
                r
            }
            // A channel that is not a channel is its own kind for the same reason:
            // the check cannot answer for the lane that was configured, and saying
            // `up_to_date` about the fallback lane would be a verdict nobody asked
            // for presented under the operator's own configuration.
            DecisionOutcome::Misconfigured(e) => {
                let mut r = base("misconfigured");
                r.detail = Some(e);
                r
            }
            DecisionOutcome::Unreachable(e) => {
                let mut r = base("unreachable");
                r.detail = Some(e);
                r
            }
            DecisionOutcome::Decided(Decision::UpToDate) => base("up_to_date"),
            DecisionOutcome::Decided(Decision::Eligible(pkg)) => OtaCheckResult {
                version: Some(pkg.version().to_string()),
                package_uri: Some(pkg.uri().to_string()),
                package_bytes: Some(pkg.size_bytes()),
                ..base("eligible")
            },
            DecisionOutcome::Decided(Decision::Deferred(reason)) => OtaCheckResult {
                reason_code: Some(reason_code(&reason).to_string()),
                detail: Some(reason.to_string()),
                ..base("deferred")
            },
            DecisionOutcome::Decided(Decision::Refused(reason)) => OtaCheckResult {
                reason_code: Some(reason_code(&reason).to_string()),
                detail: Some(reason.to_string()),
                ..base("refused")
            },
        },
    )
}

/// Check for an update. `battery_percent` is `None` when the caller cannot read
/// the level (the policy then defers rather than guess).
#[tauri::command]
pub fn ota_check(
    state: tauri::State<'_, OtaBridge>,
    battery_percent: Option<u8>,
    charging: Option<bool>,
    on_wifi: bool,
    in_window: bool,
) -> Result<OtaCheckResult, String> {
    run_check(
        &state.source,
        state.channel,
        state.channel_error.as_deref(),
        &state.device_id,
        &state.current,
        battery_percent,
        charging,
        on_wifi,
        in_window,
    )
}

/// The signature verdict an install reached, as a wire block.
///
/// The machine stages on the **integrity** verdict alone (`amos-ota`'s install
/// invariant: `Staged` is reachable only from `complete_verify(Verified)`), so a
/// package whose signature is not trusted still reaches `staged`. That is
/// deliberate — the trusted set is `AMOS_OTA_TRUST_KEYS` and is **empty by
/// default**, so refusing here would make `staged` unreachable in the default
/// configuration — but it must not be *silent*: the bytes matched the published
/// digest while the signer was not established, and a screen that says
/// 「已下载并校验完成」 over that is claiming an authenticity nobody checked.
///
/// So the verdict is *recorded* (never discarded) and the caller decides what to
/// say. `None` on the result means verification never ran (an earlier failure).
///
/// A verdict alone is not enough to say: **how it was reached is part of it.**
/// A `trusted` from [`ENV_TRUST_KEY_HEX`]'s Ed25519 path is a fact about the
/// signature; a `trusted` from the policy-only path is a fact about the key *id*
/// and nothing more — see [`OtaSignatureReport::verified_by`].
#[derive(Clone, Debug, Serialize)]
pub struct OtaSignatureReport {
    /// `trusted` | `untrusted` | `missing`.
    pub verdict: String,
    /// The signing key id, when the package carried a signature.
    pub key_id: Option<String>,
    /// `"ed25519"` when the signature was checked against a registered public
    /// key (RFC 8032); `"policy"` when only the key id was matched and **no
    /// cryptography ran** (`amos-ota::TrustingVerifier`, documented as *not a
    /// security boundary*). A `trusted` verdict is worth exactly as much as this
    /// field: under `"policy"` a forged signature claiming a trusted key id reads
    /// `trusted` too, so a reader that renders the two alike is asserting an
    /// authenticity nobody checked. Treat any value other than `"ed25519"` as
    /// the weak mode.
    pub verified_by: String,
}

impl OtaSignatureReport {
    /// `key_id` is the package's own signing key id (the enum's `Trusted`
    /// variant carries none), so a trusted verdict still names the key it was
    /// trusted under.
    fn of(verdict: &SignatureVerdict, key_id: Option<&str>, verified_by: &str) -> Self {
        match verdict {
            SignatureVerdict::Trusted => Self {
                verdict: "trusted".to_string(),
                key_id: key_id.map(str::to_string),
                verified_by: verified_by.to_string(),
            },
            SignatureVerdict::Missing => Self {
                verdict: "missing".to_string(),
                key_id: None,
                verified_by: verified_by.to_string(),
            },
            SignatureVerdict::Untrusted { key_id, .. } => Self {
                verdict: "untrusted".to_string(),
                key_id: Some(key_id.clone()),
                verified_by: verified_by.to_string(),
            },
        }
    }
}

/// Serializable result of an install attempt.
///
/// `state` is the `amos-ota` machine's terminal key. **`staged` is the success
/// value** — and it means *downloaded and verified*, not *applied*: applying the
/// image is a reboot the runtime performs, which this bridge never claims.
/// `detail` carries why no install ran (the check's own verdict, or the provider's
/// refusal) and is `None` once the machine itself settled.
#[derive(Clone, Debug, Serialize)]
pub struct OtaInstallResult {
    pub state: String,
    pub version: Option<String>,
    /// Set when the machine settled in `failed` — the honest cause.
    pub fail_reason: Option<String>,
    /// Set when the install never began (not eligible, or the provider refused).
    pub detail: Option<String>,
    /// The signature verdict, when verification ran — see [`OtaSignatureReport`].
    /// `None` means no signature check was reached (an integrity failure, a
    /// truncated download, or nothing ran at all), **not** "trusted".
    pub signature: Option<OtaSignatureReport>,
}

impl OtaInstallResult {
    fn from_machine(machine: &InstallMachine) -> Self {
        let state = machine.state();
        Self {
            state: state.key().to_string(),
            version: state.version().map(|v| v.to_string()),
            fail_reason: match state {
                InstallState::Failed { reason, .. } => Some(reason.to_string()),
                _ => None,
            },
            detail: None,
            signature: None,
        }
    }

    /// No install ran, and `detail` is why. `state` stays `idle` because nothing
    /// was ever begun — never a fabricated `staged`.
    fn not_run(detail: impl Into<String>) -> Self {
        Self {
            state: InstallState::Idle.key().to_string(),
            version: None,
            fail_reason: None,
            detail: Some(detail.into()),
            signature: None,
        }
    }
}

/// Run the whole install pipeline against the configured local image: check →
/// fetch → integrity → signature → the install state machine.
///
/// This is the same sequence `amos-ota-cli install` drives, minus the terminal
/// `await_reboot`/`apply` steps a CLI dry run also omits — the runtime owns those.
///
/// A refused step is a **finding, not an error**: a short image, a digest
/// mismatch, or an unconfigured image path all settle the machine (or report
/// `idle`) with their own reason, rather than surfacing as an opaque `Err` that
/// hides which gate closed. `Err` is reserved for a caller bug (an unparseable
/// current version).
#[allow(clippy::too_many_arguments)]
fn run_install(
    source: &Source,
    channel: Channel,
    channel_error: Option<&str>,
    device_id: &str,
    current: &str,
    battery_percent: Option<u8>,
    charging: Option<bool>,
    on_wifi: bool,
    in_window: bool,
    trust: &TrustConfig,
) -> Result<OtaInstallResult, String> {
    let package = match decide(
        source,
        channel,
        channel_error,
        device_id,
        current,
        battery_percent,
        charging,
        on_wifi,
        in_window,
    )? {
        DecisionOutcome::Unconfigured => {
            return Ok(OtaInstallResult::not_run(
                "no update source configured".to_string(),
            ))
        }
        // Same shape as the unreadable trust key below: the configuration the
        // operator wrote did not take, so nothing is installed and the finding
        // names the variable rather than staging an image from the fallback lane.
        DecisionOutcome::Misconfigured(e) => return Ok(OtaInstallResult::not_run(e)),
        DecisionOutcome::Unreachable(e) => return Ok(OtaInstallResult::not_run(e)),
        DecisionOutcome::Decided(Decision::Eligible(pkg)) => pkg,
        DecisionOutcome::Decided(Decision::UpToDate) => {
            return Ok(OtaInstallResult::not_run("up to date".to_string()))
        }
        DecisionOutcome::Decided(Decision::Deferred(reason)) => {
            return Ok(OtaInstallResult::not_run(reason.to_string()))
        }
        DecisionOutcome::Decided(Decision::Refused(reason)) => {
            return Ok(OtaInstallResult::not_run(reason.to_string()))
        }
    };

    let Some(provider) = source.provider() else {
        // `decide` only reaches `Eligible` through a configured provider.
        return Ok(OtaInstallResult::not_run(
            "no update source configured".to_string(),
        ));
    };

    // Build the verifier before the machine begins, so an unreadable trust key is
    // reported as its own finding (naming the variable) rather than silently
    // downgrading to the policy-only path mid-install.
    let (verifier, verified_by) = match trust.verifier() {
        Ok(v) => v,
        Err(e) => return Ok(OtaInstallResult::not_run(e)),
    };

    let mut machine = InstallMachine::new();
    machine.begin(&package).map_err(|e| e.to_string())?;

    let bytes = match provider.fetch_package(&package) {
        Ok(b) => b,
        Err(e) => {
            // The provider is the reason nothing proceeds; record it as the machine's
            // own failure so the terminal state is `failed` naming the cause.
            let _ = machine.fail(FailReason::Provider {
                message: e.to_string(),
            });
            return Ok(OtaInstallResult::from_machine(&machine));
        }
    };

    let received = bytes.len() as u64;
    let total = package.size_bytes();
    if received > total {
        // The machine refuses an over-report *by design* (clamping would hide a
        // lying source), so name the size disagreement rather than feed it a value
        // it will reject — the same translation the CLI makes.
        let _ = machine.fail(FailReason::Provider {
            message: format!("image is {received} bytes but the manifest declares {total}"),
        });
        return Ok(OtaInstallResult::from_machine(&machine));
    }

    machine.progress(received).map_err(|e| e.to_string())?;
    machine.finish_download().map_err(|e| e.to_string())?;
    // A short image is already `Failed(Truncated)`; there is nothing to verify.
    if !matches!(machine.state(), InstallState::Downloaded { .. }) {
        return Ok(OtaInstallResult::from_machine(&machine));
    }

    machine.begin_verify().map_err(|e| e.to_string())?;
    let verdict = check_integrity(package.sha256(), &bytes);
    let mut signature = None;
    let sig_verdict = if verdict.is_verified() {
        // Recorded — and *how fatal* is the operator's configuration's call, not a
        // constant. The verdict is passed to the machine with the mode it was
        // reached under (see `untrusted` below): recorded means **recorded**, so it
        // rides out on `OtaInstallResult.signature` and the screen can qualify its
        // 「校验完成」 line instead of asserting an authenticity nothing established.
        match verify_signature(verifier.as_ref(), &package, &bytes) {
            Ok(v) => {
                signature = Some(OtaSignatureReport::of(
                    &v,
                    package.signature().map(|s| s.key_id()),
                    verified_by,
                ));
                v
            }
            Err(e) => {
                // **Unevaluable** — not refused. `Signature::new` (`amos-ota/src/spec.rs`)
                // admits only well-formed even-length hex at manifest parse, so the
                // shape that reaches here is hex the verifier cannot turn into a
                // signature (e.g. not 64 bytes for Ed25519); its `Err` is "the input
                // could not be read", not "the input was judged". That is the same
                // discipline the sibling *digest* gate keeps — a digest that is not a
                // well-formed SHA-256 becomes `IntegrityVerdict::Malformed` and
                // settles the machine as `FailReason::MalformedDigest` through
                // `complete_verify`, never an `Err`. Settle it here the same way the
                // provider-error and size-disagreement branches above do: a named
                // failure the screen can render, rather than `?`-ing an opaque error
                // that reaches the UI (via `backend.ts::invoke`'s catch) as `null` and
                // is drawn as 「未连接，无法下载更新。」 "Not connected" — a cause this
                // path never established.
                let _ = machine.fail(FailReason::MalformedSignature {
                    reason: e.to_string(),
                });
                return Ok(OtaInstallResult::from_machine(&machine));
            }
        }
    } else {
        // Integrity failed; the machine fails on that and ignores the signature.
        SignatureVerdict::Missing
    };
    // Whether a present-but-unverified signature is fatal is a *policy the operator
    // chose by provisioning keys*, not a constant, and picking it is the caller's
    // job — `amos-ota`'s `UntrustedSignaturePolicy` exists precisely so this is not
    // defaulted. `Allow` is the escape hatch for the host whose trusted set is empty
    // (`AMOS_OTA_TRUST_KEYS`/`AMOS_OTA_TRUST_KEY_HEX` unset), where refusing would
    // make `staged` unreachable. A host that **has** provisioned real public keys is
    // the deployment `UntrustedSignaturePolicy::Fail`'s own doc names — "The safe
    // default for a deployment with keys provisioned: a signature that is present
    // but cannot be verified is a tampering signal, not a formality"
    // (`amos-ota/src/install.rs`) — and there `Allow` would make the whole
    // configuration inert: the signature mathematics would run, record `untrusted`,
    // and the image would stage anyway. This mirrors the CLI, which defaults to
    // `Fail` and needs an explicit `--allow-untrusted` to relax it.
    let untrusted = if verified_by == "ed25519" {
        UntrustedSignaturePolicy::Fail
    } else {
        UntrustedSignaturePolicy::Allow
    };
    machine
        .complete_verify(verdict, sig_verdict, untrusted)
        .map_err(|e| e.to_string())?;
    let mut result = OtaInstallResult::from_machine(&machine);
    result.signature = signature;
    Ok(result)
}

/// Download and verify the offered update from the configured local image.
///
/// **Honest copy:** the returned `state` is at most `staged` — the bytes matched
/// the published digest and would apply on the next reboot. Nothing here flashes
/// or reboots. With no image path configured the call reports `failed` with
/// `AMOS_OTA_IMAGE_PATH` named, never a fabricated success.
#[tauri::command]
pub fn ota_install(
    state: tauri::State<'_, OtaBridge>,
    battery_percent: Option<u8>,
    charging: Option<bool>,
    on_wifi: bool,
    in_window: bool,
) -> Result<OtaInstallResult, String> {
    run_install(
        &state.source,
        state.channel,
        state.channel_error.as_deref(),
        &state.device_id,
        &state.current,
        battery_percent,
        charging,
        on_wifi,
        in_window,
        &trust_from_env(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest() -> String {
        "a".repeat(64)
    }

    /// Build a manifest JSON in the exact wire shape `amos-ota` accepts.
    fn manifest_json(version: &str, channel: &str, signed: bool, min: Option<&str>) -> String {
        let sig = if signed {
            r#","signature":{"key_id":"release","value":"aabb"}"#
        } else {
            ""
        };
        let min = min
            .map(|m| format!(r#","min_supported_version":"{m}""#))
            .unwrap_or_default();
        format!(
            r#"{{"packages":[{{"version":"{version}","channel":"{channel}","uri":"https://example.invalid/os.img","sha256":"{}","size_bytes":1048576{sig}}}]{min}}}"#,
            digest()
        )
    }

    /// Write `json` to a unique temp file and return a `File`-backed `Source`.
    fn file_source(tag: &str, json: &str) -> (Source, PathBuf) {
        let path =
            std::env::temp_dir().join(format!("amos-ota-test-{}-{tag}.json", std::process::id()));
        std::fs::write(&path, json).expect("write temp manifest");
        (Source::File(FileUpdateProvider::new(path.clone())), path)
    }

    fn check(
        source: &Source,
        channel: Channel,
        battery: Option<u8>,
        charging: impl Into<Option<bool>>,
        wifi: bool,
        window: bool,
    ) -> OtaCheckResult {
        run_check(
            source,
            channel,
            None,
            "dev-1",
            "1.0.0",
            battery,
            charging.into(),
            wifi,
            window,
        )
        .expect("check runs")
    }

    #[test]
    fn eligible_signed_package_on_stable() {
        let (src, path) = file_source("eligible", &manifest_json("1.1.0", "stable", true, None));
        let r = check(&src, Channel::Stable, Some(80), false, true, true);
        assert_eq!(r.kind, "eligible");
        assert_eq!(r.version.as_deref(), Some("1.1.0"));
        assert_eq!(
            r.package_uri.as_deref(),
            Some("https://example.invalid/os.img")
        );
        assert_eq!(r.package_bytes, Some(1048576));
        assert_eq!(r.current_version, "1.0.0");
        assert_eq!(r.channel, "stable");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn up_to_date_when_nothing_is_newer() {
        let (src, path) = file_source("current", &manifest_json("1.0.0", "stable", true, None));
        let r = check(&src, Channel::Stable, Some(80), false, true, true);
        assert_eq!(r.kind, "up_to_date");
        assert!(r.version.is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_channel_with_no_package_reads_as_nothing_offered() {
        // Manifest carries only a beta image; a stable device gets Ok(None), which
        // stays "up to date" — not an error and not a phantom offer.
        let (src, path) = file_source("offchannel", &manifest_json("1.1.0", "beta", true, None));
        let r = check(&src, Channel::Stable, Some(80), false, true, true);
        assert_eq!(r.kind, "up_to_date");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unconfigured_is_not_a_false_all_clear() {
        let r = check(
            &Source::Unconfigured,
            Channel::Stable,
            Some(80),
            false,
            true,
            true,
        );
        assert_eq!(r.kind, "unconfigured");
        assert!(r
            .detail
            .as_deref()
            .is_some_and(|d| d.contains(ENV_MANIFEST_PATH)));
    }

    #[test]
    fn missing_manifest_reads_as_unreachable() {
        let path = std::env::temp_dir().join("amos-ota-test-does-not-exist.json");
        let _ = std::fs::remove_file(&path);
        let src = Source::File(FileUpdateProvider::new(path));
        let r = check(&src, Channel::Stable, Some(80), false, true, true);
        assert_eq!(r.kind, "unreachable");
        assert!(r.detail.is_some());
    }

    #[test]
    fn malformed_manifest_reads_as_unreachable() {
        let (src, path) = file_source("malformed", "{ this is not json }");
        let r = check(&src, Channel::Stable, Some(80), false, true, true);
        assert_eq!(r.kind, "unreachable");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn oversized_manifest_is_refused_before_it_is_read() {
        let path = std::env::temp_dir().join(format!(
            "amos-ota-test-{}-oversize.json",
            std::process::id()
        ));
        let f = std::fs::File::create(&path).expect("create sparse file");
        f.set_len(MAX_OTA_MANIFEST_BYTES + 1)
            .expect("sparse extend");
        drop(f);
        let src = Source::File(FileUpdateProvider::new(path.clone()));
        let r = check(&src, Channel::Stable, Some(80), false, true, true);
        assert_eq!(r.kind, "unreachable");
        assert!(
            r.detail.as_deref().is_some_and(|d| d.contains("max")),
            "the size ceiling is reported: {:?}",
            r.detail
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn deferred_needs_wifi() {
        let (src, path) = file_source("wifi", &manifest_json("1.1.0", "stable", true, None));
        let r = check(&src, Channel::Stable, Some(80), false, false, true);
        assert_eq!(r.kind, "deferred");
        assert_eq!(r.reason_code.as_deref(), Some("needs_wifi"));
        assert!(r.detail.is_some());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn deferred_unknown_battery_never_guesses() {
        let (src, path) = file_source("unknownbatt", &manifest_json("1.1.0", "stable", true, None));
        let r = check(&src, Channel::Stable, None, false, true, true);
        assert_eq!(r.kind, "deferred");
        assert_eq!(r.reason_code.as_deref(), Some("unknown_battery"));
        let _ = std::fs::remove_file(path);
    }

    /// An unread charging bit is its own fact, and the host must say so rather
    /// than report `unknown_battery`: the charger is what would have waived the
    /// missing level, so a caller who never read it is not making a claim about
    /// the battery. The command's `charging: Option<bool>` is what carries it —
    /// a bare `bool` forced the caller to answer `false` ("on battery").
    #[test]
    fn deferred_unknown_charging_is_not_reported_as_an_unknown_battery() {
        let (src, path) = file_source("unknownchg", &manifest_json("1.1.0", "stable", true, None));
        let r = check(&src, Channel::Stable, None, None, true, true);
        assert_eq!(r.kind, "deferred");
        assert_eq!(r.reason_code.as_deref(), Some("unknown_charging"));
        // Positive control: the same unread charging bit does not veto a level
        // the caller *did* read and found adequate.
        let ok = check(&src, Channel::Stable, Some(80), None, true, true);
        assert_eq!(ok.kind, "eligible");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn deferred_low_battery() {
        let (src, path) = file_source("lowbatt", &manifest_json("1.1.0", "stable", true, None));
        let r = check(&src, Channel::Stable, Some(10), false, true, true);
        assert_eq!(r.kind, "deferred");
        assert_eq!(r.reason_code.as_deref(), Some("low_battery"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn charging_makes_the_battery_level_irrelevant() {
        let (src, path) = file_source("charging", &manifest_json("1.1.0", "stable", true, None));
        let r = check(&src, Channel::Stable, None, true, true, true);
        assert_eq!(r.kind, "eligible");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn refused_unsigned() {
        let (src, path) = file_source("unsigned", &manifest_json("1.1.0", "stable", false, None));
        let r = check(&src, Channel::Stable, Some(80), false, true, true);
        assert_eq!(r.kind, "refused");
        assert_eq!(r.reason_code.as_deref(), Some("unsigned"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn refused_prerelease_on_stable() {
        let (src, path) = file_source(
            "prerelease",
            &manifest_json("1.1.0-beta.1", "stable", true, None),
        );
        let r = check(&src, Channel::Stable, Some(80), false, true, true);
        assert_eq!(r.kind, "refused");
        assert_eq!(r.reason_code.as_deref(), Some("prerelease_not_allowed"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn refused_reflash_required() {
        let (src, path) = file_source(
            "reflash",
            &manifest_json("2.0.0", "stable", true, Some("2.0.0")),
        );
        let r = check(&src, Channel::Stable, Some(80), false, true, true);
        assert_eq!(r.kind, "refused");
        assert_eq!(r.reason_code.as_deref(), Some("reflash_required"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn an_unparseable_current_version_is_an_error_not_a_guess() {
        let err = run_check(
            &Source::Unconfigured,
            Channel::Stable,
            None,
            "dev-1",
            "not-a-version",
            Some(80),
            Some(false),
            true,
            true,
        )
        .expect_err("a bad current version must fail loudly");
        assert!(err.contains("not valid semver"), "{err}");
    }

    /// `AMOS_OTA_CHANNEL` has a closed domain, so a value that is not a channel is
    /// a configuration error, not a lane. Folding it into `stable` (the
    /// `unwrap_or` this replaced) made the typo indistinguishable from "unset" —
    /// and `" beta "` (an env-file edit) and `"Beta"` (a capital) were both
    /// indistinguishable too: the check would answer about the fallback lane while
    /// the 「关于本机」 row showed `stable` under an operator who thought they had
    /// configured `beta`. The value is now normalised, and a value that is still
    /// not a channel is an error naming the variable.
    #[test]
    fn a_channel_value_is_normalised_and_an_unrecognised_one_is_refused_by_name() {
        // Unset is `stable` — the one case the default is for.
        assert_eq!(parse_channel(None).unwrap(), Channel::Stable);
        // Both recognised spellings, however they were pasted.
        for raw in ["stable", "STABLE", " Stable "] {
            assert_eq!(
                parse_channel(Some(raw)).unwrap(),
                Channel::Stable,
                "{raw:?}"
            );
        }
        for raw in ["beta", "Beta", "\tbeta\n"] {
            assert_eq!(parse_channel(Some(raw)).unwrap(), Channel::Beta, "{raw:?}");
        }
        // Not a channel: refused, naming the variable and the value.
        for raw in ["betta", "nightly", "stable|beta"] {
            let err = parse_channel(Some(raw)).expect_err("not a channel");
            assert!(err.contains(ENV_CHANNEL), "{raw:?}: {err}");
            assert!(err.contains(raw), "{raw:?}: {err}");
        }
    }

    /// The same closed-domain rule at the decision layer: an unusable channel is a
    /// finding naming the variable, not a verdict about the fallback lane. Before
    /// this, the check answered `up_to_date`/`eligible` about `stable` while the
    /// operator's `beta` was silently ignored.
    #[test]
    fn an_unusable_channel_is_a_finding_not_a_verdict_about_the_fallback_lane() {
        let err = parse_channel(Some("betta")).expect_err("not a channel");

        let (src, path) = file_source("badchan", &manifest_json("1.1.0", "stable", true, None));
        let r = run_check(
            &src,
            Channel::Stable,
            Some(&err),
            "dev-1",
            "1.0.0",
            Some(80),
            Some(false),
            true,
            true,
        )
        .expect("a misconfiguration is a finding, not an opaque error");
        assert_eq!(r.kind, "misconfigured", "{r:?}");
        assert!(
            r.detail.as_deref().is_some_and(|d| d.contains(ENV_CHANNEL)),
            "the finding must name the variable: {r:?}"
        );
        // …and no update was offered from the fallback lane.
        assert!(r.version.is_none(), "{r:?}");
        assert!(r.package_uri.is_none(), "{r:?}");
        let _ = std::fs::remove_file(path);

        // The install: nothing is staged from a lane the operator did not choose.
        let (src, path) = file_source(
            "badchan-install",
            &manifest_json("1.1.0", "stable", true, None),
        );
        let inst = run_install(
            &src,
            Channel::Stable,
            Some(&err),
            "dev-1",
            "1.0.0",
            Some(80),
            Some(false),
            true,
            true,
            &TrustConfig::default(),
        )
        .expect("a misconfiguration is a finding, not an opaque error");
        assert_eq!(inst.state, "idle", "{inst:?}");
        assert!(inst
            .detail
            .as_deref()
            .is_some_and(|d| d.contains(ENV_CHANNEL)));
        assert!(inst.signature.is_none(), "{inst:?}");
        let _ = std::fs::remove_file(path);

        // Positive control: with no channel error the same manifest is offered, so
        // the finding above is the channel and not a check that refuses everything.
        let (src, path) = file_source("goodchan", &manifest_json("1.1.0", "stable", true, None));
        let ok = check(&src, Channel::Stable, Some(80), false, true, true);
        assert_eq!(ok.kind, "eligible", "{ok:?}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fetch_package_without_a_configured_image_refuses_by_name() {
        // No image path ⇒ nothing to stage, and the refusal names the env var
        // rather than succeeding with empty bytes.
        let p = FileUpdateProvider::new("/nonexistent");
        let pkg = UpdatePackage::new(
            Version::parse("1.1.0").expect("semver"),
            Channel::Stable,
            "https://example.invalid/os.img",
            digest(),
            1048576,
        )
        .expect("package");
        let err = p.fetch_package(&pkg).expect_err("no image ⇒ error");
        assert!(err.to_string().contains(ENV_IMAGE_PATH), "{err}");
    }

    /// A file-backed `Source` whose image path is `image`.
    fn source_with_image(tag: &str, json: &str, image: &[u8]) -> (Source, Vec<PathBuf>) {
        let (src, manifest_path) = file_source(tag, json);
        let image_path =
            std::env::temp_dir().join(format!("amos-ota-test-{}-{tag}.img", std::process::id()));
        std::fs::write(&image_path, image).expect("write temp image");
        let Source::File(p) = src else {
            unreachable!("file_source always yields a File source")
        };
        (
            Source::File(p.with_image(Some(image_path.clone()))),
            vec![manifest_path, image_path],
        )
    }

    fn install(src: &Source, channel: Channel) -> OtaInstallResult {
        run_install(
            src,
            channel,
            None,
            "dev-1",
            "1.0.0",
            Some(80),
            Some(false),
            true,
            true,
            &TrustConfig::default(),
        )
        .expect("install runs")
    }

    /// A file-backed `Source` offering `version` with `image` behind a signature
    /// `(key_id, signature_hex)`.
    fn source_signed_image(
        tag: &str,
        version: &str,
        image: &[u8],
        key_id: &str,
        signature_hex: &str,
    ) -> (Source, Vec<PathBuf>) {
        let json = format!(
            r#"{{"packages":[{{"version":"{version}","channel":"stable","uri":"file://img","sha256":"{}","size_bytes":{},"signature":{{"key_id":"{key_id}","value":"{signature_hex}"}}}}]}}"#,
            amos_ota::sha256_hex(image),
            image.len()
        );
        source_with_image(tag, &json, image)
    }

    fn install_with(src: &Source, trust: &TrustConfig) -> Result<OtaInstallResult, String> {
        run_install(
            src,
            Channel::Stable,
            None,
            "dev-1",
            "1.0.0",
            Some(80),
            Some(false),
            true,
            true,
            trust,
        )
    }

    /// The RFC 8032 §7.1 TEST 2 triple — the *authority* for "this is Ed25519",
    /// reused here so the host's real-key path is exercised against the same
    /// vectors the verifier itself is pinned to.
    const RFC_KEY: &str = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
    const RFC_MSG: u8 = 0x72;
    const RFC_SIG: &str = "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00";

    #[test]
    fn install_stages_a_matching_image() {
        let image = b"AMOS-IMAGE-1.1.0".to_vec();
        // The manifest digest must match the image or nothing would stage.
        let json = format!(
            r#"{{"packages":[{{"version":"1.1.0","channel":"stable","uri":"file://img","sha256":"{}","size_bytes":{},"signature":{{"key_id":"rel","value":"aabb"}}}}]}}"#,
            amos_ota::sha256_hex(&image),
            image.len()
        );
        let (src, paths) = source_with_image("stages", &json, &image);
        let r = install(&src, Channel::Stable);
        assert_eq!(r.state, "staged", "{r:?}");
        assert_eq!(r.version.as_deref(), Some("1.1.0"));
        assert!(r.fail_reason.is_none());
        assert!(r.detail.is_none());
        // Staged on the *integrity* verdict, but the signer is reported: `install` passes
        // no trust keys, so the package's key really is untrusted here. The point of the
        // field is that this stops being silent (REQ-A1454).
        let sig = r.signature.as_ref().expect("verification ran");
        assert_eq!(sig.verdict, "untrusted");
        assert_eq!(sig.key_id.as_deref(), Some("rel"));
        // No trust keys at all ⇒ the policy-only verifier is what ran, and it says
        // so: this verdict is about a key *id*, not about a signature's maths.
        assert_eq!(sig.verified_by, "policy");
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn install_reports_a_trusted_signature_when_the_key_is_trusted() {
        // The control for the case above: with the key id in the trusted set the
        // same package reports `trusted` — and `verified_by` says *why*, which is
        // the whole point: this `trusted` is a statement about the key id, reached
        // by matching a list, with no cryptography behind it.
        let image = b"AMOS-IMAGE-1.1.0".to_vec();
        let (src, paths) = source_signed_image("trusted-signer", "1.1.0", &image, "rel", "aabb");
        let r = install_with(
            &src,
            &TrustConfig {
                keys: Vec::new(),
                ids: vec!["rel".to_string()],
            },
        )
        .expect("install runs");
        assert_eq!(r.state, "staged", "{r:?}");
        let sig = r.signature.as_ref().expect("verification ran");
        assert_eq!(sig.verdict, "trusted", "{r:?}");
        assert_eq!(sig.verified_by, "policy", "{r:?}");
        // A trusted verdict now names the key it was trusted under (the enum's own
        // `Trusted` variant carries no id, so the host supplies the package's).
        assert_eq!(sig.key_id.as_deref(), Some("rel"));
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    }

    /// **The discriminating pair for the whole trust-mode split.** One package,
    /// one signature value — and the verdict flips on which verifier ran:
    /// matching the key id against a list says `trusted`, actually checking the
    /// signature says `untrusted`. That 64 zero bytes is not a valid Ed25519
    /// signature over the image; the policy-only path cannot tell, and would have
    /// handed the screen a `trusted` it had no basis for.
    #[test]
    fn a_forged_signature_is_trusted_by_policy_and_untrusted_by_ed25519() {
        let image = vec![RFC_MSG];
        let forged = "00".repeat(64);
        let (src, paths) = source_signed_image("forged", "1.1.0", &image, "rel", &forged);

        let by_policy = install_with(
            &src,
            &TrustConfig {
                keys: Vec::new(),
                ids: vec!["rel".to_string()],
            },
        )
        .expect("install runs");
        let p = by_policy.signature.as_ref().expect("verification ran");
        assert_eq!(p.verdict, "trusted", "{by_policy:?}");
        assert_eq!(p.verified_by, "policy");

        let by_ed25519 = install_with(
            &src,
            &TrustConfig {
                keys: vec![("rel".to_string(), RFC_KEY.to_string())],
                ids: Vec::new(),
            },
        )
        .expect("a refusal is a finding, not an opaque error");
        let e = by_ed25519.signature.as_ref().expect("verification ran");
        assert_eq!(e.verdict, "untrusted", "{by_ed25519:?}");
        assert_eq!(e.verified_by, "ed25519");
        // The two modes are not interchangeable, and now they do not *behave* alike
        // either. The policy-only host (no keys provisioned) stages with the verdict
        // recorded, because refusing there would make `staged` unreachable. The host
        // that HAS provisioned real keys has made authenticity a requirement, so the
        // forged image does not stage — otherwise configuring `AMOS_OTA_TRUST_KEY_HEX`
        // would change the recorded verdict but not the outcome, a setting with no
        // effect. (REQ-A1543 ∕ F-SH-779.)
        assert_eq!(by_policy.state, "staged");
        assert_eq!(by_ed25519.state, "failed");

        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    }

    /// The keys-provisioned deployment does not stage a signature the real verifier
    /// just refused — and it names the cause. Before this, `run_install` passed
    /// `UntrustedSignaturePolicy::Allow` **unconditionally**, so the one deployment
    /// `Fail`'s own doc names ("The safe default for a deployment with keys
    /// provisioned", `amos-ota/src/install.rs`) was the one that could never reach
    /// it: an operator who provisioned `AMOS_OTA_TRUST_KEY_HEX` got real Ed25519
    /// mathematics run against the image, an `untrusted` verdict recorded — and a
    /// `staged` result the screen renders as 「已下载并校验完成」 anyway. The in-file
    /// comment justifying `Allow` only reasons about the *empty* trusted set ("would
    /// make `staged` unreachable unless an operator provisioned keys"), which is
    /// exactly the case this test is not. REQ-A1543 ∕ F-SH-779.
    #[test]
    fn a_forged_signature_fails_the_install_when_real_keys_are_provisioned() {
        let image = vec![RFC_MSG];
        let (src, paths) =
            source_signed_image("forged-fail", "1.1.0", &image, "rel", &"00".repeat(64));
        let r = install_with(
            &src,
            &TrustConfig {
                keys: vec![("rel".to_string(), RFC_KEY.to_string())],
                ids: Vec::new(),
            },
        )
        .expect("a refused step is a finding, not an opaque error");

        // The machine settles `failed` naming the gate that closed, not `staged`.
        assert_eq!(r.state, "failed", "{r:?}");
        assert!(
            r.fail_reason
                .as_deref()
                .is_some_and(|f| f.contains("not trusted")),
            "the honest cause must be the machine's own failure line: {r:?}"
        );
        // Failing is not discarding the evidence: the verdict and the mode it was
        // reached under still ride out, so the screen can say *why* it refused.
        let sig = r.signature.as_ref().expect("verification ran");
        assert_eq!(sig.verdict, "untrusted");
        assert_eq!(sig.verified_by, "ed25519");

        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    }

    /// The positive control for the pair above: the *same* key and a genuine
    /// RFC 8032 signature over the same byte reads `trusted` under the real
    /// verifier — so `untrusted` there is the signature being forged, not the
    /// Ed25519 path being wired up to refuse everything.
    #[test]
    fn a_genuine_ed25519_signature_reads_trusted_over_ed25519() {
        let image = vec![RFC_MSG];
        let (src, paths) = source_signed_image("genuine", "1.1.0", &image, "rel", RFC_SIG);
        let r = install_with(
            &src,
            &TrustConfig {
                keys: vec![("rel".to_string(), RFC_KEY.to_string())],
                ids: Vec::new(),
            },
        )
        .expect("install runs");
        assert_eq!(r.state, "staged", "{r:?}");
        let sig = r.signature.as_ref().expect("verification ran");
        assert_eq!(sig.verdict, "trusted", "{r:?}");
        assert_eq!(sig.verified_by, "ed25519", "{r:?}");
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn an_unreadable_trust_key_names_the_variable_instead_of_downgrading() {
        // A typo in the public key must not quietly fall back to the policy-only
        // path: the host would then report `trusted` for a signature it never
        // checked, under an operator's belief that they had configured real keys.
        let image = vec![RFC_MSG];
        let (src, paths) = source_signed_image("badkey", "1.1.0", &image, "rel", RFC_SIG);
        let r = install_with(
            &src,
            &TrustConfig {
                // Odd-length hex — never decodes, so it can never be a key.
                keys: vec![("rel".to_string(), "abc".to_string())],
                ids: Vec::new(),
            },
        )
        .expect("a refusal is a finding, not an opaque error");
        assert_eq!(r.state, "idle", "{r:?}");
        let detail = r.detail.as_deref().unwrap_or_default();
        assert!(detail.contains(ENV_TRUST_KEY_HEX), "{detail}");
        assert!(detail.contains("rel"), "{detail}");
        // Nothing was staged, and no verdict was invented.
        assert!(r.signature.is_none(), "{r:?}");
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn a_key_hex_entry_without_a_colon_is_refused_not_dropped() {
        // The same "do not silently discard the operator's line" rule at the
        // parsing edge: a pair with no `:` is carried through as an empty key so
        // `insert` rejects it by name, rather than vanishing into the id list.
        let cfg = TrustConfig::parse(Some("rel"), None);
        assert_eq!(cfg.keys, vec![("rel".to_string(), String::new())]);
        // `Box<dyn SignatureVerifier>` is not `Debug`, so match rather than
        // `expect_err`.
        let Err(err) = cfg.verifier() else {
            panic!("an empty public key must not build a verifier");
        };
        assert!(err.contains(ENV_TRUST_KEY_HEX), "{err}");
    }

    #[test]
    fn trust_config_parses_both_variables_and_defaults_to_trusting_none() {
        let cfg = TrustConfig::parse(Some(" rel : aabb , other:ccdd "), Some(" rel , bare "));
        assert_eq!(
            cfg.keys,
            vec![
                ("rel".to_string(), "aabb".to_string()),
                ("other".to_string(), "ccdd".to_string()),
            ]
        );
        assert_eq!(cfg.ids, vec!["rel".to_string(), "bare".to_string()]);

        // Blank / unset on both sides is "trusts none", and no `keys` means the
        // policy-only verifier — the weak mode is only ever a *default*, never a
        // silent fallback from a configured strong one.
        let empty = TrustConfig::parse(Some("  "), Some(""));
        assert!(empty.keys.is_empty());
        assert!(empty.ids.is_empty());
        let (_, mode) = empty.verifier().expect("an empty config is valid");
        assert_eq!(mode, "policy");
    }

    #[test]
    fn install_without_an_image_fails_and_names_the_env_var() {
        // A manifest offering an update, but no image path ⇒ the machine settles
        // `failed` naming the cause — never a fabricated `staged`.
        let (src, manifest_path) =
            file_source("noimage", &manifest_json("1.1.0", "stable", true, None));
        let r = install(&src, Channel::Stable);
        assert_eq!(r.state, "failed", "{r:?}");
        assert!(
            r.fail_reason
                .as_deref()
                .is_some_and(|f| f.contains(ENV_IMAGE_PATH)),
            "{r:?}"
        );
        let _ = std::fs::remove_file(manifest_path);
    }

    #[test]
    fn install_reports_a_tampered_image_as_an_integrity_failure() {
        let image = b"AMOS-IMAGE-1.1.0".to_vec();
        let json = format!(
            r#"{{"packages":[{{"version":"1.1.0","channel":"stable","uri":"file://img","sha256":"{}","size_bytes":{},"signature":{{"key_id":"rel","value":"aabb"}}}}]}}"#,
            amos_ota::sha256_hex(&image),
            image.len()
        );
        let mut tampered = image.clone();
        tampered[0] ^= 0xff;
        let (src, paths) = source_with_image("tamper", &json, &tampered);
        let r = install(&src, Channel::Stable);
        assert_eq!(r.state, "failed", "{r:?}");
        assert!(
            r.fail_reason
                .as_deref()
                .is_some_and(|f| f.contains("integrity")),
            "{r:?}"
        );
        // No signature check is reached on a failed digest — `None` is "not checked",
        // and the screen must not read it as "trusted".
        assert!(r.signature.is_none(), "{r:?}");
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn install_reports_a_short_image_as_truncated() {
        // Digest matches the bytes; only the declared size is larger, so the
        // finding must be the truncation — not the transition it causes.
        let image = b"AMOS-IMAGE".to_vec();
        let json = format!(
            r#"{{"packages":[{{"version":"1.1.0","channel":"stable","uri":"file://img","sha256":"{}","size_bytes":{},"signature":{{"key_id":"rel","value":"aabb"}}}}]}}"#,
            amos_ota::sha256_hex(&image),
            image.len() + 90
        );
        let (src, paths) = source_with_image("short", &json, &image);
        let r = install(&src, Channel::Stable);
        assert_eq!(r.state, "failed", "{r:?}");
        assert!(
            r.fail_reason
                .as_deref()
                .is_some_and(|f| f.contains(&format!(
                    "truncated at {}/{}",
                    image.len(),
                    image.len() + 90
                ))),
            "{r:?}"
        );
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn install_reports_an_oversize_image_as_a_size_disagreement() {
        let image = b"AMOS-IMAGE-AND-THEN-SOME-MORE".to_vec();
        let json = format!(
            r#"{{"packages":[{{"version":"1.1.0","channel":"stable","uri":"file://img","sha256":"{}","size_bytes":4,"signature":{{"key_id":"rel","value":"aabb"}}}}]}}"#,
            amos_ota::sha256_hex(&image)
        );
        let (src, paths) = source_with_image("long", &json, &image);
        let r = install(&src, Channel::Stable);
        assert_eq!(r.state, "failed", "{r:?}");
        assert!(
            r.fail_reason
                .as_deref()
                .is_some_and(|f| f.contains(&format!(
                    "is {} bytes but the manifest declares 4",
                    image.len()
                ))),
            "{r:?}"
        );
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    }

    /// An **unevaluable** signature — well-formed hex that the verifier cannot
    /// turn into a signature at all — is a finding that fails the install, not a
    /// caller-bug `Err`.
    ///
    /// `Signature::new` (`amos-ota/src/spec.rs`) rejects odd-length/non-hex at
    /// manifest parse, so the only shape that reaches the verifier is
    /// **valid-hex-but-not-64-bytes**; `Ed25519Verifier::verify` names that shape
    /// "unevaluable" (`Err(OtaError::InvalidHex)`, hex shape *first* so it is an
    /// `Err` regardless of whether the key is known). Its sibling downstream gate,
    /// the *digest*, already has this discipline — a digest that is not a
    /// well-formed SHA-256 becomes `FailReason::MalformedDigest` through
    /// `complete_verify`, never an `Err`. The signature half had no such variant,
    /// so `run_install` `?`-propagated the verifier's error, contradicting its own
    /// doc ("A refused step is a **finding, not an error** … `Err` is reserved for
    /// a caller bug") and diverging from its provider-error and size siblings,
    /// which `machine.fail(...)` and return `Ok`.
    #[test]
    fn an_unevaluable_signature_fails_the_install_rather_than_erroring() {
        let image = vec![RFC_MSG];
        // `aabb` is even-length valid hex — so `Signature::new` accepts it and the
        // manifest parses — but it is 2 bytes, not the 64 an Ed25519 signature is.
        let (src, paths) = source_signed_image("short-sig", "1.1.0", &image, "rel", "aabb");
        let r = install_with(
            &src,
            &TrustConfig {
                keys: vec![("rel".to_string(), RFC_KEY.to_string())],
                ids: Vec::new(),
            },
        )
        .expect("an unevaluable signature is a finding, not a caller-bug Err");
        assert_eq!(r.state, "failed", "{r:?}");
        let reason = r.fail_reason.as_deref().expect("a named cause");
        assert!(
            reason.contains("aabb"),
            "the cause must name the offending signature, got: {reason}"
        );
        // Nothing was evaluated, so no verdict may be recorded as if one had been:
        // `signature: None` means "no check was reached", never "trusted".
        assert!(r.signature.is_none(), "{r:?}");
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn install_does_not_run_when_nothing_is_eligible() {
        // Up to date ⇒ no install begins; `state` stays `idle` and the detail says
        // why, so the UI can never render a running install for a no-op.
        let (src, manifest_path) =
            file_source("idle", &manifest_json("1.0.0", "stable", true, None));
        let r = install(&src, Channel::Stable);
        assert_eq!(r.state, "idle", "{r:?}");
        assert_eq!(r.detail.as_deref(), Some("up to date"));
        assert!(r.fail_reason.is_none());
        let _ = std::fs::remove_file(manifest_path);
    }

    #[test]
    fn install_does_not_run_when_policy_defers() {
        // On battery with an unreadable level the check defers, so no install runs
        // and the deferral's own sentence is the detail.
        let image = b"img".to_vec();
        let json = format!(
            r#"{{"packages":[{{"version":"1.1.0","channel":"stable","uri":"file://img","sha256":"{}","size_bytes":{},"signature":{{"key_id":"rel","value":"aabb"}}}}]}}"#,
            amos_ota::sha256_hex(&image),
            image.len()
        );
        let (src, paths) = source_with_image("deferred", &json, &image);
        let r = run_install(
            &src,
            Channel::Stable,
            None,
            "dev-1",
            "1.0.0",
            None,
            Some(false),
            true,
            true,
            &TrustConfig::default(),
        )
        .expect("install runs");
        assert_eq!(r.state, "idle", "{r:?}");
        assert!(
            r.detail.as_deref().is_some_and(|d| d.contains("battery")),
            "{r:?}"
        );
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    }

    /// Strip Rust line and block comments, leaving string literals intact.
    ///
    /// A pin that reads a source file for *code* must not read the file's own prose. Here the
    /// comment is written in the file the pin reads, so the `contains` below answered "yes" to
    /// a line that had been commented out — the wiring instruction was there, the wiring was
    /// not. Same job `strip_kotlin_comments` does for the Android glue across a language
    /// boundary (`incall.rs`, `rotation.rs`, `number.rs`, `alarm_device_binding_e2e.rs`); one
    /// copy per reading file is this repo's convention for these test-side readers
    /// (`clock.rs::strip_rust_comments` is the Rust-side precedent). (REQ-A1022 / F-SH-339.)
    fn strip_rust_comments(src: &str) -> String {
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

    /// The trimmed source line containing `needle`, so an assertion can require the wiring to
    /// *be* a statement rather than a mention inside one.
    fn wiring_line<'a>(code: &'a str, needle: &str) -> &'a str {
        code.lines()
            .map(str::trim)
            .find(|l| l.contains(needle))
            .unwrap_or_else(|| panic!("lib.rs no longer contains `{needle}`"))
    }

    /// The stripper is itself two-sided: prose that spells the wiring must be gone, the code's
    /// own copy must survive, and a `//` inside a string is not a comment. The `//`-commented
    /// line in the middle is the one this round is about — it is exactly what the pin used to
    /// accept as proof of wiring.
    #[test]
    fn strip_rust_comments_keeps_code_and_drops_prose() {
        let src = "\
/// Wiring the bridge means `pub mod ota;` and `.manage(ota::OtaBridge::new())`.\n\
// .manage(ota::OtaBridge::new())\n\
/* .manage(ota::OtaBridge::new()) */\n\
        .manage(ota::OtaBridge::new())\n\
const NAMED: &str = \"a // is not a comment\";\n";
        let code = strip_rust_comments(src);
        assert!(
            !code.contains("pub mod ota;"),
            "a prose mention of the wiring is not the wiring: {code}"
        );
        assert_eq!(
            code.matches("manage(ota::OtaBridge::new())").count(),
            1,
            "only the code's own line may survive: {code}"
        );
        assert!(
            code.contains("\"a // is not a comment\""),
            "a // inside a string literal is not a comment: {code}"
        );
    }

    /// The binding test for this round's claim: the bridge is not merely written but *wired* —
    /// the module is declared, its state is managed, and both commands are registered. Without
    /// this, `ota.rs` could compile and be dead again (the very defect this round fixes).
    ///
    /// It reads the crate's own `lib.rs` **comment-stripped**, and requires each half of the
    /// wiring to be the whole statement. The first version read the raw text, so commenting a
    /// half out left its spelling behind and the claim above — "fails if any half of the wiring
    /// is undone" — was false: `// .manage(ota::OtaBridge::new())` was green with the state
    /// unmanaged and every other gate quiet (measured, REQ-A1022 / F-SH-339).
    #[test]
    fn the_ota_bridge_is_wired_into_the_host() {
        let lib = strip_rust_comments(include_str!("lib.rs"));
        assert_eq!(
            wiring_line(&lib, "pub mod ota;"),
            "pub mod ota;",
            "module not declared"
        );
        assert_eq!(
            wiring_line(&lib, "manage(ota::OtaBridge::new())"),
            ".manage(ota::OtaBridge::new())",
            "state not managed"
        );
        assert_eq!(
            wiring_line(&lib, "ota::ota_status"),
            "ota::ota_status,",
            "ota_status not registered"
        );
        assert_eq!(
            wiring_line(&lib, "ota::ota_check"),
            "ota::ota_check,",
            "ota_check not registered"
        );
        assert_eq!(
            wiring_line(&lib, "ota::ota_install"),
            "ota::ota_install,",
            "ota_install not registered"
        );
    }
}
