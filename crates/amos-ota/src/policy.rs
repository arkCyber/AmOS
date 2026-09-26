//! The eligibility decision: may this device install this update *right now*?
//!
//! The rule the whole module is built around is that **"I do not know" is never
//! rendered as "yes"**. An unreadable battery level on battery power defers an
//! update rather than risk flashing a system image at 3%; an unreachable
//! manifest is not "up to date". Every refusal and deferral carries a [`Reason`]
//! a UI can show and a log can trust.
//!
//! Order of evaluation is fixed and documented so a decision is reproducible:
//! reflash-threshold → no-newer ⇒ up-to-date → prerelease policy → signature
//! presence → rollout cohort → maintenance window → Wi-Fi → battery → eligible.

use crate::spec::{Channel, Cohort, Manifest, UpdatePackage};
use crate::version::Version;

/// Why an update is being held back or refused. `Deferred` reasons clear on
/// their own (the condition is transient); `Refused` ones do not — they need a
/// human or a different image.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reason {
    /// `current` is below the fleet's minimum supported version: a package
    /// update is not enough, the device must be reflashed.
    ReflashRequired { min: String },
    /// The offered package is a prerelease but this device does not accept them.
    PrereleaseNotAllowed { version: String },
    /// The policy requires a signature and the package has none.
    Unsigned,
    /// The device is outside the rollout cohort for this update.
    NotInCohort,
    /// The policy only updates inside a maintenance window and we are outside it.
    OutsideWindow,
    /// The policy only updates on Wi-Fi and the device is not on Wi-Fi.
    NeedsWifi,
    /// On battery with no readable level — deferred rather than guessed.
    UnknownBattery,
    /// On battery below the policy's floor.
    LowBattery { percent: u8, required: u8 },
    /// The charging state could not be read, so neither the charger-gate nor
    /// the battery floor can be applied — deferred rather than guessed.
    ///
    /// Distinct from [`UnknownBattery`](Self::UnknownBattery) on purpose: the
    /// *decisive* unknown here is the charger. On a charger the battery level is
    /// irrelevant (step 8 below), so a device whose charging bit is unread is
    /// being held back by the charger fact, not by the level — naming the level
    /// would send the user to look at a battery that may be perfectly known.
    UnknownCharging,
}

impl std::fmt::Display for Reason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Reason::ReflashRequired { min } => {
                write!(
                    f,
                    "device is older than the minimum supported version {min}"
                )
            }
            Reason::PrereleaseNotAllowed { version } => {
                write!(f, "prerelease {version} is not accepted by this policy")
            }
            Reason::Unsigned => {
                f.write_str("package is unsigned and the policy requires a signature")
            }
            Reason::NotInCohort => f.write_str("device is outside the rollout cohort"),
            Reason::OutsideWindow => f.write_str("outside the maintenance window"),
            Reason::NeedsWifi => f.write_str("waiting for Wi-Fi"),
            Reason::UnknownBattery => f.write_str("battery level is unknown on battery power"),
            Reason::LowBattery { percent, required } => {
                write!(f, "battery {percent}% is below the required {required}%")
            }
            Reason::UnknownCharging => {
                f.write_str("charging state is unknown, so the battery level cannot be waived")
            }
        }
    }
}

/// Facts about the device as the caller observed them.
///
/// Both power facts are *three-valued*, because "I did not read it" is not the
/// same claim as any measured value: `battery_percent` is `None` when the level
/// could not be read, and `charging` is `None` when the charging state could
/// not — a `Some(false)` is an assertion that the device is on battery, which a
/// caller who never read the bit (an unrecognised `status` word, or a battery
/// subsystem that answered nothing) is not entitled to make. Folding the unread
/// case into `Some(false)` would make the policy's own "an unknown defers"
/// rule ([`Reason::UnknownBattery`]) unreachable for the charger fact.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceFacts {
    pub current: Version,
    pub device_id: String,
    pub battery_percent: Option<u8>,
    /// `Some(true)` on a charger, `Some(false)` on battery, `None` when unread.
    pub charging: Option<bool>,
    pub on_wifi: bool,
    pub in_window: bool,
}

impl DeviceFacts {
    /// Facts with everything but the essentials defaulted to the *conservative*
    /// value: an unread charging state, not on Wi-Fi, no known battery level, not
    /// in a window. A caller that forgets to set a field gets a deferral, not an
    /// accidental install — and, for `charging`, a deferral that names the
    /// charger rather than asserting a discharge nobody observed.
    pub fn new(current: Version, device_id: impl Into<String>) -> DeviceFacts {
        DeviceFacts {
            current,
            device_id: device_id.into(),
            battery_percent: None,
            charging: None,
            on_wifi: false,
            in_window: false,
        }
    }

    pub fn with_battery(mut self, percent: u8) -> DeviceFacts {
        self.battery_percent = Some(percent.min(100));
        self
    }

    /// Set the charging state. Takes `impl Into<Option<bool>>` so a caller
    /// holding a plain `bool` from a two-valued source (a CLI flag, a boot
    /// default) can pass it directly, while a caller that *has* a real unknown
    /// passes `None` rather than a fabricated `false`.
    pub fn charging(mut self, state: impl Into<Option<bool>>) -> DeviceFacts {
        self.charging = state.into();
        self
    }
    pub fn on_wifi(mut self, yes: bool) -> DeviceFacts {
        self.on_wifi = yes;
        self
    }
    pub fn in_window(mut self, yes: bool) -> DeviceFacts {
        self.in_window = yes;
        self
    }
}

/// The update policy: which channel this device follows and the conditions an
/// install must satisfy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdatePolicy {
    channel: Channel,
    allow_prerelease: bool,
    require_signature: bool,
    wifi_only: bool,
    min_battery_percent: u8,
    defer_outside_window: bool,
    cohort: Option<Cohort>,
}

impl UpdatePolicy {
    /// A policy for `channel` with the conservative defaults: prereleases only
    /// where the channel carries them, signature required, Wi-Fi only, 30%
    /// battery floor, no window restriction, no cohort gate.
    pub fn new(channel: Channel) -> UpdatePolicy {
        UpdatePolicy {
            channel,
            allow_prerelease: channel.allows_prerelease(),
            require_signature: true,
            wifi_only: true,
            min_battery_percent: 30,
            defer_outside_window: false,
            cohort: None,
        }
    }

    pub fn allow_prerelease(mut self, yes: bool) -> UpdatePolicy {
        self.allow_prerelease = yes;
        self
    }
    pub fn require_signature(mut self, yes: bool) -> UpdatePolicy {
        self.require_signature = yes;
        self
    }
    pub fn wifi_only(mut self, yes: bool) -> UpdatePolicy {
        self.wifi_only = yes;
        self
    }
    /// Set the battery floor (clamped to 100). `0` means "no battery floor", but
    /// an *unknown* level still defers while on battery — `0` relaxes the floor,
    /// it does not license a blind install.
    pub fn min_battery_percent(mut self, percent: u8) -> UpdatePolicy {
        self.min_battery_percent = percent.min(100);
        self
    }

    pub fn defer_outside_window(mut self, yes: bool) -> UpdatePolicy {
        self.defer_outside_window = yes;
        self
    }
    pub fn with_cohort(mut self, cohort: Cohort) -> UpdatePolicy {
        self.cohort = Some(cohort);
        self
    }

    pub fn channel(&self) -> Channel {
        self.channel
    }
    /// The battery floor (percent) an install must meet while on battery.
    pub fn battery_floor(&self) -> u8 {
        self.min_battery_percent
    }
    pub fn requires_signature(&self) -> bool {
        self.require_signature
    }
}

/// The decision for one (manifest, policy, device) triple.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Nothing newer than `current` on this channel.
    UpToDate,
    /// The install may proceed now; the package to install.
    Eligible(UpdatePackage),
    /// Held back by a transient condition; will clear on its own.
    Deferred(Reason),
    /// Refused for a durable reason; a retry will not help.
    Refused(Reason),
}

impl Decision {
    pub fn is_eligible(&self) -> bool {
        matches!(self, Decision::Eligible(_))
    }
    /// The package when eligible.
    pub fn package(&self) -> Option<&UpdatePackage> {
        match self {
            Decision::Eligible(p) => Some(p),
            _ => None,
        }
    }
    /// The reason, for a deferral or a refusal.
    pub fn reason(&self) -> Option<&Reason> {
        match self {
            Decision::Deferred(r) | Decision::Refused(r) => Some(r),
            _ => None,
        }
    }
}

/// Evaluate an update decision. See the module docs for the fixed order.
pub fn evaluate(manifest: &Manifest, policy: &UpdatePolicy, facts: &DeviceFacts) -> Decision {
    // 1. Too old for a package update at all (durable refusal).
    if let Some(min) = manifest.min_supported_version() {
        if &facts.current < min {
            return Decision::Refused(Reason::ReflashRequired {
                min: min.to_string(),
            });
        }
    }

    // 2. Is there anything newer on our channel?
    let Some(pkg) = manifest.update_from(policy.channel(), &facts.current) else {
        return Decision::UpToDate;
    };

    // 3. Prerelease policy. The gate chooses among the candidates a policy
    //    *accepts*; it must not let an unacceptable prerelease veto a release that
    //    is also newer than `current` and on the same channel. Refusing the whole
    //    update in that case is a durable verdict ("a retry will not help") handed
    //    to a device that could have installed the release immediately.
    let pkg = if pkg.version().is_prerelease() && !policy.allow_prerelease {
        match manifest.release_update_from(policy.channel(), &facts.current) {
            Some(release) => release,
            // Nothing else is on offer: the prerelease is the honest reason.
            None => {
                return Decision::Refused(Reason::PrereleaseNotAllowed {
                    version: pkg.version().to_string(),
                })
            }
        }
    } else {
        pkg
    };

    // 4. Signature *presence* (authenticity is checked later, over the bytes). Like
    //    the prerelease gate above, this gate must choose among the candidates the
    //    policy *accepts*: an unsigned newest entry must not veto a signed package
    //    that is also newer than `current` and on the same channel. The `Unsigned`
    //    refusal is durable, handed to a device that could have installed the signed
    //    package now. The fallback honours `allow_prerelease` so it cannot re-admit a
    //    prerelease gate 3 just refused.
    let pkg = if policy.requires_signature() && pkg.signature().is_none() {
        match manifest.signed_update_from(
            policy.channel(),
            &facts.current,
            policy.allow_prerelease,
        ) {
            Some(signed) => signed,
            // Nothing signed is on offer: the unsigned newest is the honest reason.
            None => return Decision::Refused(Reason::Unsigned),
        }
    } else {
        pkg
    };

    // 5. Rollout cohort.
    if let Some(cohort) = &policy.cohort {
        if !cohort.includes(&facts.device_id) {
            return Decision::Deferred(Reason::NotInCohort);
        }
    }

    // 6. Maintenance window.
    if policy.defer_outside_window && !facts.in_window {
        return Decision::Deferred(Reason::OutsideWindow);
    }

    // 7. Network.
    if policy.wifi_only && !facts.on_wifi {
        return Decision::Deferred(Reason::NeedsWifi);
    }

    // 8. Power. The charger gate is three-valued, and the two directions are not
    //    symmetric: a *known* charger waives the level entirely, a *known*
    //    discharge demands a known level at or above the floor, and an *unread*
    //    charging bit is evidence of neither.
    //
    //    An unread charging bit must not be folded into "on battery": that would
    //    apply the battery floor to a device that may be on a charger (where the
    //    level is irrelevant), and — with the level equally unread — report
    //    `UnknownBattery`, sending the user to look at a battery when the fact
    //    that actually decided the answer was the charger. So the unread case
    //    takes the same *safe* shape as on-battery (a known, adequate level is
    //    still required) but names `UnknownCharging` when the level is the thing
    //    we cannot see, because the charger is what would have waived it.
    match facts.charging {
        Some(true) => {}
        Some(false) => {
            if let Some(reason) = battery_gate(policy, facts) {
                return Decision::Deferred(reason);
            }
        }
        None => {
            if facts.battery_percent.is_none() {
                return Decision::Deferred(Reason::UnknownCharging);
            }
            if let Some(reason) = battery_gate(policy, facts) {
                return Decision::Deferred(reason);
            }
        }
    }

    Decision::Eligible(pkg.clone())
}

/// The battery-level gate, applied when no *known* charger waives it: a known
/// level below the floor is `LowBattery`; an unread level is `UnknownBattery`.
/// `None` means the level is an acceptable known value.
///
/// Split out so the on-battery arm and the unread-charging arm share one
/// definition of the floor — the two differ only in *which* unknown they name.
fn battery_gate(policy: &UpdatePolicy, facts: &DeviceFacts) -> Option<Reason> {
    match facts.battery_percent {
        None => Some(Reason::UnknownBattery),
        Some(percent) if percent < policy.battery_floor() => Some(Reason::LowBattery {
            percent,
            required: policy.battery_floor(),
        }),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::OtaError;
    use crate::spec::{Signature, UpdatePackage};

    fn ver(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    fn pkg(v: &str, ch: Channel, signed: bool) -> UpdatePackage {
        let p = UpdatePackage::new(
            ver(v),
            ch,
            format!("https://cdn/{v}.img"),
            "a".repeat(64),
            100,
        )
        .unwrap();
        if signed {
            p.with_signature(Signature::new("rel", "aabb").unwrap())
        } else {
            p
        }
    }

    fn manifest(pkgs: Vec<UpdatePackage>, min: Option<&str>) -> Manifest {
        Manifest::new(pkgs, min.map(ver)).unwrap()
    }

    /// Facts that satisfy every default gate: on Wi-Fi, charged, in window.
    fn ready(current: &str) -> DeviceFacts {
        DeviceFacts::new(ver(current), "dev-1")
            .charging(true)
            .on_wifi(true)
            .in_window(true)
    }

    #[test]
    fn eligible_when_everything_passes() {
        let m = manifest(vec![pkg("1.1.0", Channel::Stable, true)], None);
        let pol = UpdatePolicy::new(Channel::Stable);
        let d = evaluate(&m, &pol, &ready("1.0.0"));
        assert!(d.is_eligible());
        assert_eq!(d.package().unwrap().version().to_string(), "1.1.0");
    }

    #[test]
    fn up_to_date_when_nothing_newer() {
        let m = manifest(vec![pkg("1.0.0", Channel::Stable, true)], None);
        let d = evaluate(&m, &UpdatePolicy::new(Channel::Stable), &ready("1.0.0"));
        assert_eq!(d, Decision::UpToDate);
    }

    #[test]
    fn reflash_refusal_beats_everything() {
        let m = manifest(vec![pkg("9.0.0", Channel::Stable, true)], Some("2.0.0"));
        let d = evaluate(&m, &UpdatePolicy::new(Channel::Stable), &ready("1.0.0"));
        assert!(matches!(
            d,
            Decision::Refused(Reason::ReflashRequired { .. })
        ));
    }

    #[test]
    fn unsigned_refused_when_required_but_allowed_when_not() {
        let m = manifest(vec![pkg("1.1.0", Channel::Stable, false)], None);
        let strict = UpdatePolicy::new(Channel::Stable);
        assert!(matches!(
            evaluate(&m, &strict, &ready("1.0.0")),
            Decision::Refused(Reason::Unsigned)
        ));
        let lax = UpdatePolicy::new(Channel::Stable).require_signature(false);
        assert!(evaluate(&m, &lax, &ready("1.0.0")).is_eligible());
    }

    /// The signature gate — the sibling of the prerelease gate above it in `evaluate`
    /// — must choose among the candidates the policy *accepts*, not merely veto the
    /// newest entry. An unsigned newest package must not refuse a **signed** package
    /// that is also newer than `current` and on the same channel: the refusal is
    /// durable, handed to a device that could have installed the signed one now.
    #[test]
    fn a_device_that_requires_a_signature_is_still_offered_the_signed_package_below_it() {
        let m = manifest(
            vec![
                pkg("1.1.0", Channel::Stable, true),
                pkg("1.2.0", Channel::Stable, false),
            ],
            None,
        );
        let strict = UpdatePolicy::new(Channel::Stable);
        let d = evaluate(&m, &strict, &ready("1.0.0"));
        assert!(
            d.is_eligible(),
            "requiring a signature must not refuse the signed package on offer: {d:?}"
        );
        assert_eq!(d.package().unwrap().version().to_string(), "1.1.0");

        // Control: with no signed package on offer the refusal stands — the fallback
        // must not invent an eligible decision out of a signed-less manifest.
        let only_unsigned = manifest(vec![pkg("1.2.0", Channel::Stable, false)], None);
        assert!(matches!(
            evaluate(&only_unsigned, &strict, &ready("1.0.0")),
            Decision::Refused(Reason::Unsigned)
        ));
    }

    /// The signature fallback must not re-admit what the prerelease gate already
    /// refused: with prereleases not allowed, a *signed prerelease* cannot become the
    /// answer merely because it is the only signed candidate above `current`.
    #[test]
    fn the_signature_fallback_does_not_reintroduce_a_refused_prerelease() {
        let m = manifest(
            vec![
                pkg("1.1.0", Channel::Stable, false),     // unsigned release
                pkg("1.2.0-rc.1", Channel::Stable, true), // signed, but a prerelease
            ],
            None,
        );
        let strict = UpdatePolicy::new(Channel::Stable);
        assert!(matches!(
            evaluate(&m, &strict, &ready("1.0.0")),
            Decision::Refused(Reason::Unsigned)
        ));
    }

    #[test]
    fn prerelease_policy() {
        let m = manifest(vec![pkg("1.1.0-rc.1", Channel::Beta, true)], None);
        // Beta accepts prereleases by default.
        let beta = UpdatePolicy::new(Channel::Beta);
        assert!(evaluate(&m, &beta, &ready("1.0.0")).is_eligible());
        // …but a device that opted out refuses.
        let opted_out = UpdatePolicy::new(Channel::Beta).allow_prerelease(false);
        assert!(matches!(
            evaluate(&m, &opted_out, &ready("1.0.0")),
            Decision::Refused(Reason::PrereleaseNotAllowed { .. })
        ));
    }

    /// The prerelease gate must choose among the candidates, not merely veto the
    /// newest entry: a device that refuses prereleases still has an installable
    /// release on the same channel, and must be offered it.
    #[test]
    fn a_device_that_refuses_prereleases_is_still_offered_the_release_below_it() {
        let m = manifest(
            vec![
                pkg("1.1.0", Channel::Beta, true),
                pkg("1.2.0-rc.1", Channel::Beta, true),
            ],
            None,
        );
        let opted_out = UpdatePolicy::new(Channel::Beta).allow_prerelease(false);
        let d = evaluate(&m, &opted_out, &ready("1.0.0"));
        assert!(
            d.is_eligible(),
            "opting out of prereleases must not refuse the release on offer: {d:?}"
        );
        assert_eq!(d.package().unwrap().version().to_string(), "1.1.0");
    }

    /// The same defect on the default policy: Stable refuses prereleases, and
    /// nothing on the wire path rejects a prerelease merely for being labelled
    /// `stable`, so the newest entry of a stable manifest can be one.
    #[test]
    fn a_stable_manifest_carrying_a_prerelease_still_offers_its_release() {
        let m = manifest(
            vec![
                pkg("1.2.0", Channel::Stable, true),
                pkg("1.5.0-rc.1", Channel::Stable, true),
            ],
            None,
        );
        let d = evaluate(&m, &UpdatePolicy::new(Channel::Stable), &ready("1.0.0"));
        assert!(
            d.is_eligible(),
            "the stable release must still be offered: {d:?}"
        );
        assert_eq!(d.package().unwrap().version().to_string(), "1.2.0");
    }

    /// The fallback is a release *newer than `current`*, not any release: with no
    /// such release the refusal still names the prerelease it would not install.
    #[test]
    fn a_prerelease_is_refused_when_no_release_is_above_current() {
        let m = manifest(
            vec![
                pkg("0.9.0", Channel::Beta, true),
                pkg("1.2.0-rc.1", Channel::Beta, true),
            ],
            None,
        );
        let opted_out = UpdatePolicy::new(Channel::Beta).allow_prerelease(false);
        assert!(matches!(
            evaluate(&m, &opted_out, &ready("1.0.0")),
            Decision::Refused(Reason::PrereleaseNotAllowed { .. })
        ));
    }

    /// Positive control: when prereleases *are* accepted, the newest entry still
    /// wins — the fix must not demote a prerelease that the policy allows.
    #[test]
    fn an_accepted_prerelease_still_outranks_the_release_below_it() {
        let m = manifest(
            vec![
                pkg("1.1.0", Channel::Beta, true),
                pkg("1.2.0-rc.1", Channel::Beta, true),
            ],
            None,
        );
        let d = evaluate(&m, &UpdatePolicy::new(Channel::Beta), &ready("1.0.0"));
        assert_eq!(d.package().unwrap().version().to_string(), "1.2.0-rc.1");
    }

    #[test]
    fn unknown_battery_defers_even_with_zero_floor() {
        let m = manifest(vec![pkg("1.1.0", Channel::Stable, true)], None);
        // Floor relaxed to 0, on Wi-Fi, battery level unreadable AND the device
        // known to be on battery (the `charging(false)` is what makes this the
        // *battery* case — an unstated charging bit is `UnknownCharging`).
        let pol = UpdatePolicy::new(Channel::Stable).min_battery_percent(0);
        let facts = DeviceFacts::new(ver("1.0.0"), "dev-1")
            .charging(false)
            .on_wifi(true);
        assert_eq!(
            evaluate(&m, &pol, &facts),
            Decision::Deferred(Reason::UnknownBattery)
        );
        // On the charger the same unreadable level is fine.
        let charging = facts.clone().charging(true);
        assert!(evaluate(&m, &pol, &charging).is_eligible());
    }

    /// The charger fact is three-valued, and its *unread* state must not be
    /// reported as a battery problem: with both the charging bit and the level
    /// unread, the fact that decided the answer is the charger (on a charger the
    /// level would not matter at all), so the deferral names `UnknownCharging`.
    /// Before the fix `charging` was a bare `bool` whose `false` default folded
    /// this case into `UnknownBattery`.
    #[test]
    fn an_unread_charging_bit_defers_on_its_own_reason_not_the_battery() {
        let m = manifest(vec![pkg("1.1.0", Channel::Stable, true)], None);
        let pol = UpdatePolicy::new(Channel::Stable);
        let facts = DeviceFacts::new(ver("1.0.0"), "dev-1").on_wifi(true);
        assert_eq!(facts.charging, None, "an unstated charging bit is unknown");
        assert_eq!(
            evaluate(&m, &pol, &facts),
            Decision::Deferred(Reason::UnknownCharging)
        );
    }

    /// Positive control for the rule above: an unread charging bit must not be
    /// made *more* conservative than a known discharge for a level we *did*
    /// read. A known, adequate level still passes (the charging bit alone is not
    /// a reason to hold an update), and a known low level still names the floor
    /// exactly as it does on battery.
    #[test]
    fn an_unread_charging_bit_still_applies_the_level_it_does_know() {
        let m = manifest(vec![pkg("1.1.0", Channel::Stable, true)], None);
        let pol = UpdatePolicy::new(Channel::Stable).min_battery_percent(30);
        let unread = DeviceFacts::new(ver("1.0.0"), "dev-1").on_wifi(true);
        assert!(
            evaluate(&m, &pol, &unread.clone().with_battery(80)).is_eligible(),
            "a known adequate level is not vetoed by an unread charger"
        );
        assert_eq!(
            evaluate(&m, &pol, &unread.with_battery(10)),
            Decision::Deferred(Reason::LowBattery {
                percent: 10,
                required: 30
            })
        );
    }

    #[test]
    fn low_battery_defers_with_numbers() {
        let m = manifest(vec![pkg("1.1.0", Channel::Stable, true)], None);
        let pol = UpdatePolicy::new(Channel::Stable).min_battery_percent(50);
        let facts = DeviceFacts::new(ver("1.0.0"), "d")
            .on_wifi(true)
            .with_battery(49);
        assert_eq!(
            evaluate(&m, &pol, &facts),
            Decision::Deferred(Reason::LowBattery {
                percent: 49,
                required: 50
            })
        );
        assert!(evaluate(&m, &pol, &facts.with_battery(50)).is_eligible());
    }

    #[test]
    fn wifi_and_window_deferrals() {
        let m = manifest(vec![pkg("1.1.0", Channel::Stable, true)], None);
        let pol = UpdatePolicy::new(Channel::Stable);
        let no_wifi = DeviceFacts::new(ver("1.0.0"), "d").charging(true);
        assert_eq!(
            evaluate(&m, &pol, &no_wifi),
            Decision::Deferred(Reason::NeedsWifi)
        );

        let windowed = pol.clone().defer_outside_window(true);
        let outside = ready("1.0.0").in_window(false);
        assert_eq!(
            evaluate(&m, &windowed, &outside),
            Decision::Deferred(Reason::OutsideWindow)
        );
    }

    /// End-to-end of the same rule at the decision layer: a device carrying no
    /// identity must not be swept into a cohort just because the salt's bucket
    /// for the empty string happens to fall inside the window. With a 100%
    /// cohort the *unfixed* code admits it (every bucket is < 100), so this is
    /// the assertion that fails before the fix.
    #[test]
    fn a_device_with_no_identity_is_not_admitted_by_the_cohort() {
        let m = manifest(vec![pkg("1.1.0", Channel::Stable, true)], None);
        let pol =
            UpdatePolicy::new(Channel::Stable).with_cohort(Cohort::new("wave1", 100).unwrap());
        assert!(evaluate(&m, &pol, &ready("1.0.0")).is_eligible());
        let anonymous = DeviceFacts {
            device_id: String::new(),
            ..ready("1.0.0")
        };
        assert_eq!(
            evaluate(&m, &pol, &anonymous),
            Decision::Deferred(Reason::NotInCohort),
            "an unnamed device cannot be placed in the wave, so it is not in it"
        );
    }

    #[test]
    fn cohort_gates_rollout() {
        let m = manifest(vec![pkg("1.1.0", Channel::Stable, true)], None);
        // A 0% cohort holds everyone back.
        let none = UpdatePolicy::new(Channel::Stable).with_cohort(Cohort::new("s", 0).unwrap());
        assert_eq!(
            evaluate(&m, &none, &ready("1.0.0")),
            Decision::Deferred(Reason::NotInCohort)
        );
        // A 100% cohort lets everyone through.
        let all = UpdatePolicy::new(Channel::Stable).with_cohort(Cohort::new("s", 100).unwrap());
        assert!(evaluate(&m, &all, &ready("1.0.0")).is_eligible());
    }

    #[test]
    fn default_facts_are_conservative() {
        let f = DeviceFacts::new(ver("1.0.0"), "d");
        assert_eq!(f.battery_percent, None);
        assert_eq!(f.charging, None, "an unset charging bit is unknown, not false");
        assert!(!f.on_wifi && !f.in_window);
        let m = manifest(vec![pkg("1.1.0", Channel::Stable, true)], None);
        // Conservative facts ⇒ a deferral, never an accidental Eligible. (The
        // Wi-Fi gate fires first here; the unread-charger case is pinned by
        // `an_unread_charging_bit_defers_on_its_own_reason_not_the_battery`.)
        assert!(matches!(
            evaluate(&m, &UpdatePolicy::new(Channel::Stable), &f),
            Decision::Deferred(_)
        ));
    }

    #[test]
    fn reason_display_names_the_cause() {
        assert!(Reason::NeedsWifi.to_string().contains("Wi-Fi"));
        assert!(Reason::LowBattery {
            percent: 10,
            required: 30
        }
        .to_string()
        .contains("10%"));
        assert!(Reason::UnknownCharging
            .to_string()
            .contains("charging state is unknown"));
    }

    // Referenced so the constructor is not dead in non-test builds.
    #[test]
    fn provider_error_carries_its_message() {
        let e: OtaError = OtaError::provider("boom");
        assert!(e.to_string().contains("boom"));
    }
}
