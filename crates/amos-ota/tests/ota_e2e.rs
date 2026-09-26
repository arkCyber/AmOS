//! End-to-end OTA flow over the public API: a manifest parsed from JSON, a mock
//! source, an eligibility decision, a download, integrity + signature checks,
//! and the install state machine — the happy path and the three ways it must
//! refuse to lie.
//!
//! This exercises the crate the way a runtime would: nothing here reaches into
//! private state, so these tests are also the crate's public-API contract.

use amos_ota::{
    check_integrity, evaluate, sha256_hex, Channel, Cohort, Decision, DeviceFacts, FailReason,
    InstallMachine, InstallState, IntegrityVerdict, Manifest, MockUpdateProvider, PolicyReason,
    Signature, SignatureVerdict, TrustingVerifier, UntrustedSignaturePolicy, UpdatePackage,
    UpdatePolicy, UpdateProvider, Version,
};

fn ver(s: &str) -> Version {
    Version::parse(s).unwrap()
}

/// A signed package whose declared digest matches `bytes`.
fn package_for(version: &str, channel: Channel, uri: &str, bytes: &[u8]) -> UpdatePackage {
    UpdatePackage::new(
        ver(version),
        channel,
        uri,
        sha256_hex(bytes),
        bytes.len() as u64,
    )
    .unwrap()
    .with_signature(Signature::new("amos-release", "aabbccdd").unwrap())
}

/// Drive the post-eligibility half: download from the provider, verify, install.
/// Returns the machine so the caller can assert on it.
fn download_verify(
    provider: &dyn UpdateProvider,
    package: &UpdatePackage,
    verifier: &TrustingVerifier,
) -> InstallMachine {
    let mut machine = InstallMachine::new();
    machine.begin(package).unwrap();
    let bytes = provider.fetch_package(package).unwrap();
    machine.progress(bytes.len() as u64).unwrap();
    machine.finish_download().unwrap();
    machine.begin_verify().unwrap();
    let verdict = check_integrity(package.sha256(), &bytes);
    // Authenticity is only meaningful once integrity passed; check both so the
    // test mirrors a real pipeline.
    let signature = if verdict.is_verified() {
        let sig = amos_ota::verify_signature(verifier, package, &bytes).unwrap();
        assert!(sig.is_trusted());
        sig
    } else {
        SignatureVerdict::Missing
    };
    machine
        .complete_verify(verdict, signature, UntrustedSignaturePolicy::Fail)
        .unwrap();
    machine
}

#[test]
fn happy_path_from_manifest_json_to_applied() {
    // A real manifest as JSON (the shape a CDN would serve).
    let image = b"AMOS-SYSTEM-IMAGE-1.1.0".to_vec();
    let digest = sha256_hex(&image);
    let manifest_json = format!(
        r#"{{
            "packages": [
                {{
                    "version": "1.1.0",
                    "channel": "stable",
                    "uri": "https://cdn.amos.example/system-1.1.0.img",
                    "sha256": "{digest}",
                    "size_bytes": {size},
                    "signature": {{ "key_id": "amos-release", "value": "aabbccdd" }}
                }}
            ],
            "min_supported_version": "1.0.0"
        }}"#,
        size = image.len()
    );
    let manifest: Manifest = serde_json::from_str(&manifest_json).expect("manifest parses");

    let provider = MockUpdateProvider::new()
        .with_manifest(Channel::Stable, manifest.clone())
        .with_payload("https://cdn.amos.example/system-1.1.0.img", image.clone());

    // A device that satisfies every gate.
    let facts = DeviceFacts::new(ver("1.0.0"), "device-42")
        .on_wifi(true)
        .charging(true)
        .in_window(true);
    let policy = UpdatePolicy::new(Channel::Stable)
        .with_cohort(Cohort::new("stable-wave-1", 100).unwrap())
        .defer_outside_window(true);

    let decision = evaluate(&manifest, &policy, &facts);
    assert!(
        decision.is_eligible(),
        "expected eligible, got {decision:?}"
    );
    let package = decision.package().unwrap().clone();

    let verifier = TrustingVerifier::new(["amos-release"]);
    let mut machine = download_verify(&provider, &package, &verifier);
    assert!(machine.state().is_staged());

    machine.await_reboot().unwrap();
    machine.apply().unwrap();
    assert_eq!(machine.state().version().unwrap(), &ver("1.1.0"));
    assert!(machine.state().is_terminal());
}

#[test]
fn tampered_image_fails_integrity_not_staged() {
    let good = b"AMOS-SYSTEM-IMAGE-1.1.0".to_vec();
    let manifest = Manifest::new(
        vec![package_for("1.1.0", Channel::Stable, "u", &good)],
        None,
    )
    .unwrap();
    // The provider serves the *same length* but different bytes than the manifest
    // promised, so the download is complete yet the digest will not match —
    // isolating the integrity gate from the truncation gate.
    let mut tampered = good.clone();
    tampered[0] ^= 0xff;
    let provider = MockUpdateProvider::new().with_payload("u", tampered);

    let facts = DeviceFacts::new(ver("1.0.0"), "d")
        .on_wifi(true)
        .charging(true);
    let policy = UpdatePolicy::new(Channel::Stable);
    let package = evaluate(&manifest, &policy, &facts)
        .package()
        .unwrap()
        .clone();

    let verifier = TrustingVerifier::new(["amos-release"]);
    let machine = download_verify(&provider, &package, &verifier);
    assert!(
        !machine.state().is_staged(),
        "a tampered image must never stage"
    );
    match machine.state() {
        InstallState::Failed {
            reason: FailReason::Integrity { .. },
            ..
        } => {}
        other => panic!("expected Integrity failure, got {other:?}"),
    }
}

/// The manifest crosses the network as JSON, so `Deserialize` *is* the front
/// door of this crate. A zero-byte image is the concrete harm: nothing later in
/// the pipeline rejects it (an empty download is "complete", an empty digest
/// matches an empty body), so if the wire path skipped the constructor the
/// device would happily stage a fake update. Every shape here must be refused
/// before a package exists at all.
#[test]
fn malformed_manifest_json_never_becomes_a_package() {
    let digest = sha256_hex(b"real image");
    // Each entry omits nothing a real CDN would omit; only one field is wrong.
    let cases = [
        (
            "zero-byte image",
            format!(r#""uri":"u","sha256":"{digest}","size_bytes":0"#),
        ),
        (
            "empty uri",
            format!(r#""uri":"","sha256":"{digest}","size_bytes":10"#),
        ),
        (
            "implausibly large image",
            format!(r#""uri":"u","sha256":"{digest}","size_bytes":18446744073709551615"#),
        ),
        (
            "non-hex digest",
            r#""uri":"u","sha256":"not-a-digest","size_bytes":10"#.to_string(),
        ),
        (
            "empty signing key",
            format!(
                r#""uri":"u","sha256":"{digest}","size_bytes":10,"signature":{{"key_id":"","value":"aabb"}}"#
            ),
        ),
    ];
    for (what, fields) in cases {
        let json = format!(r#"{{"packages":[{{"version":"1.1.0","channel":"stable",{fields}}}]}}"#);
        assert!(
            serde_json::from_str::<Manifest>(&json).is_err(),
            "a manifest with a {what} must not parse into a package"
        );
    }
}

#[test]
fn unreachable_source_is_not_up_to_date() {
    let mut provider = MockUpdateProvider::new();
    provider.set_unreachable(true);
    // The caller must see the error, not a silent "no update".
    assert!(provider.fetch_manifest(Channel::Stable).is_err());

    // And with a reachable-but-empty source the decision is honestly UpToDate.
    let empty = MockUpdateProvider::new();
    let manifest = empty.fetch_manifest(Channel::Stable).unwrap();
    assert!(manifest.is_none());
}

#[test]
fn too_old_device_is_refused_for_reflash() {
    let image = b"img".to_vec();
    let manifest = Manifest::new(
        vec![package_for("5.0.0", Channel::Stable, "u", &image)],
        Some(ver("2.0.0")),
    )
    .unwrap();
    let facts = DeviceFacts::new(ver("1.5.0"), "d")
        .on_wifi(true)
        .charging(true);
    let decision = evaluate(&manifest, &UpdatePolicy::new(Channel::Stable), &facts);
    assert!(matches!(
        decision,
        Decision::Refused(PolicyReason::ReflashRequired { .. })
    ));
}

#[test]
fn staged_rollout_holds_a_device_back_then_releases_it() {
    let image = b"img".to_vec();
    let manifest = Manifest::new(
        vec![package_for("1.1.0", Channel::Stable, "u", &image)],
        None,
    )
    .unwrap();
    let facts = DeviceFacts::new(ver("1.0.0"), "device-7")
        .on_wifi(true)
        .charging(true);

    // 0% cohort ⇒ deferred, not eligible.
    let held = UpdatePolicy::new(Channel::Stable).with_cohort(Cohort::new("wave", 0).unwrap());
    assert_eq!(
        evaluate(&manifest, &held, &facts),
        Decision::Deferred(PolicyReason::NotInCohort)
    );
    // Widened to 100% ⇒ the same device is now eligible.
    let released =
        UpdatePolicy::new(Channel::Stable).with_cohort(Cohort::new("wave", 100).unwrap());
    assert!(evaluate(&manifest, &released, &facts).is_eligible());
}

#[test]
fn unsigned_package_is_refused_by_default_policy() {
    let image = b"img".to_vec();
    let unsigned = UpdatePackage::new(
        ver("1.1.0"),
        Channel::Stable,
        "u",
        sha256_hex(&image),
        image.len() as u64,
    )
    .unwrap();
    let manifest = Manifest::new(vec![unsigned], None).unwrap();
    let facts = DeviceFacts::new(ver("1.0.0"), "d")
        .on_wifi(true)
        .charging(true);
    assert!(matches!(
        evaluate(&manifest, &UpdatePolicy::new(Channel::Stable), &facts),
        Decision::Refused(PolicyReason::Unsigned)
    ));
}

#[test]
fn unknown_battery_defers_rather_than_installing() {
    let image = b"img".to_vec();
    let manifest = Manifest::new(
        vec![package_for("1.1.0", Channel::Stable, "u", &image)],
        None,
    )
    .unwrap();
    // On Wi-Fi, known to be on battery, no readable level.
    let facts = DeviceFacts::new(ver("1.0.0"), "d")
        .charging(false)
        .on_wifi(true);
    assert_eq!(
        evaluate(&manifest, &UpdatePolicy::new(Channel::Stable), &facts),
        Decision::Deferred(PolicyReason::UnknownBattery)
    );
}

/// The sibling unknown: an *unread* charging bit defers on its own reason. The
/// charger is what would have waived the missing level, so naming the battery
/// (`UnknownBattery`) would be a different, less precise claim than the one the
/// facts support.
#[test]
fn an_unread_charging_bit_defers_rather_than_installing() {
    let image = b"img".to_vec();
    let manifest = Manifest::new(
        vec![package_for("1.1.0", Channel::Stable, "u", &image)],
        None,
    )
    .unwrap();
    // On Wi-Fi, charging state unread, no readable level.
    let facts = DeviceFacts::new(ver("1.0.0"), "d").on_wifi(true);
    assert_eq!(
        evaluate(&manifest, &UpdatePolicy::new(Channel::Stable), &facts),
        Decision::Deferred(PolicyReason::UnknownCharging)
    );
}

#[test]
fn integrity_verdict_against_a_real_digest() {
    // A direct check that the wiring computes what the manifest declares.
    let bytes = b"payload";
    let declared = sha256_hex(bytes);
    assert_eq!(
        check_integrity(&declared, bytes),
        IntegrityVerdict::Verified
    );
    assert!(!check_integrity(&declared, b"other").is_verified());
}
