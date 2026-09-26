//! `plan_update` — the decision layer end to end, offline: a manifest built in
//! memory, two device fact-sets that differ only in battery, and the install
//! pipeline driven to `Staged` for the one that is eligible. No network, no clock,
//! no device.
//!
//! ```text
//! cargo run -p amos-ota --example plan_update
//! ```

use amos_ota::{
    check_integrity, evaluate, sha256_hex, verify_signature, Channel, Cohort, Decision,
    DeviceFacts, InstallMachine, Manifest, MockUpdateProvider, Signature, TrustingVerifier,
    UntrustedSignaturePolicy, UpdatePackage, UpdatePolicy, UpdateProvider, Version,
};

fn main() {
    // The image a CDN would serve, and its published digest.
    let image = b"AMOS-SYSTEM-IMAGE-1.1.0".to_vec();
    let uri = "https://cdn.amos.example/system-1.1.0.img";
    let package = UpdatePackage::new(
        Version::parse("1.1.0").expect("version"),
        Channel::Stable,
        uri,
        sha256_hex(&image),
        image.len() as u64,
    )
    .expect("package")
    .with_signature(Signature::new("amos-release", "aabbccdd").expect("signature"));
    let manifest = Manifest::new(
        vec![package.clone()],
        Some(Version::parse("1.0.0").unwrap()),
    )
    .expect("manifest");

    let provider = MockUpdateProvider::new()
        .with_manifest(Channel::Stable, manifest.clone())
        .with_payload(uri, image.clone());

    let current = Version::parse("1.0.0").unwrap();
    let facts = |battery: Option<u8>, charging: bool| {
        let f = DeviceFacts::new(current.clone(), "device-42")
            .on_wifi(true)
            .charging(charging);
        match battery {
            Some(b) => f.with_battery(b),
            None => f,
        }
    };
    let healthy = facts(Some(80), true);
    let drained = facts(Some(12), false);

    // The same device, three policies: the rollout gate and the battery floor are
    // both deferrals, never an accidental "yes".
    let held = UpdatePolicy::new(Channel::Stable).with_cohort(Cohort::new("wave-1", 0).unwrap());
    let policy =
        UpdatePolicy::new(Channel::Stable).with_cohort(Cohort::new("wave-1", 100).unwrap());

    let show = |d: &Decision| match d {
        Decision::Eligible(p) => format!("Eligible {}", p.version()),
        Decision::UpToDate => "UpToDate".to_string(),
        Decision::Deferred(r) => format!("Deferred ({r})"),
        Decision::Refused(r) => format!("Refused ({r})"),
    };
    println!(
        "0% wave,   charged 80%:    {}",
        show(&evaluate(&manifest, &held, &healthy))
    );
    println!(
        "100% wave, charged 80%:    {}",
        show(&evaluate(&manifest, &policy, &healthy))
    );
    println!(
        "100% wave, on battery 12%: {}",
        show(&evaluate(&manifest, &policy, &drained))
    );

    // Drive the eligible device: fetch → hash → signature → stage.
    let Decision::Eligible(pkg) = evaluate(&manifest, &policy, &healthy) else {
        println!("not eligible — nothing to install");
        return;
    };
    let bytes = provider.fetch_package(&pkg).expect("fetch");
    let verifier = TrustingVerifier::new(["amos-release"]);
    let signature = verify_signature(&verifier, &pkg, &bytes).expect("verify");
    println!("signature:   {signature:?}");

    let mut machine = InstallMachine::new();
    machine.begin(&pkg).unwrap();
    machine.progress(bytes.len() as u64).unwrap();
    machine.finish_download().unwrap();
    machine.begin_verify().unwrap();
    machine
        .complete_verify(
            check_integrity(pkg.sha256(), &bytes),
            // The verdict computed above is the one handed to the machine. The
            // example used to print `Trusted` and then stage under a hardcoded
            // `Missing` — an illustration of the very shape the crate refuses
            // (a verdict reached and then discarded before the gate that acts on it).
            signature,
            UntrustedSignaturePolicy::Fail,
        )
        .unwrap();
    println!("staged {}:    {:?}", pkg.version(), machine.state());
}
