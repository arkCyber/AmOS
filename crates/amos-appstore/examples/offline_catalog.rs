//! `offline_catalog` — the store engine over an offline mock provider.
//!
//! Catalog → install (sha256 verified) → upgrade to a newer release → uninstall, plus the
//! one thing a store must never get wrong: a **tampered** artifact whose bytes do not
//! match the published digest is refused, and nothing is recorded as installed.
//!
//! Usage:
//! ```text
//! cargo run -p amos-appstore --example offline_catalog
//! ```

use amos_appstore::{
    AppCategory, AppManifest, AppStore, Checksum, MockStoreProvider, PackageFormat, PackageRef,
    Version,
};

/// A minimal but valid catalog entry (the mock stamps the real digest on `add`).
fn manifest(id: &str, name: &str, version: Version) -> AppManifest {
    AppManifest {
        id: id.into(),
        name: name.into(),
        summary: "example app".into(),
        description: String::new(),
        author: "Amos Labs".into(),
        version,
        category: AppCategory::Tools,
        homepage: String::new(),
        icon_url: String::new(),
        package: PackageRef {
            format: PackageFormat::TarGz,
            url: format!("https://cdn.example.com/{id}.tgz"),
            sha256: None,
            size_bytes: None,
        },
        publisher: None,
    }
}

fn ids(store: &AppStore<MockStoreProvider>) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    Ok(store
        .installed()?
        .iter()
        .map(|a| a.id().to_string())
        .collect())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let provider = MockStoreProvider::new();
    provider.add(
        manifest("org.amos.pomodoro", "Pomodoro", Version::new(1, 0, 0)),
        b"pomodoro v1".to_vec(),
    )?;
    let store = AppStore::new(provider.clone());

    println!("provider: {}", store.provider_name());
    for m in store.catalog().await? {
        println!("catalog:  {m}");
    }

    // `add` stamped the artifact's real sha256, so this install verifies.
    let installed = store.install("org.amos.pomodoro").await?;
    println!(
        "\ninstalled {} v{} (sha256 verified)",
        installed.id(),
        installed.version()
    );
    println!("status:   {}", store.status("org.amos.pomodoro").await?);

    // Publish a newer release; `upgrade` is the only way to move forward.
    provider.add(
        manifest("org.amos.pomodoro", "Pomodoro", Version::new(1, 1, 0)),
        b"pomodoro v2".to_vec(),
    )?;
    println!("\nupdatable: {:?}", store.updatable().await?);
    let upgraded = store.upgrade("org.amos.pomodoro").await?;
    println!("upgraded to v{}", upgraded.version());

    // A tampered artifact: the manifest declares one digest, the provider serves other
    // bytes. The install must be refused and leave the registry untouched.
    let tampered = MockStoreProvider::new();
    let mut declared = manifest("org.amos.tampered", "Tampered", Version::new(1, 0, 0));
    declared.package.sha256 = Some(Checksum::sha256(Checksum::sha256_hex(
        b"what was published",
    ))?);
    tampered.add_broken(declared, b"not what was published".to_vec())?;
    let broken = AppStore::new(tampered);
    match broken.install("org.amos.tampered").await {
        Ok(a) => println!("\nBUG: tampered install was accepted: {}", a.id()),
        Err(e) => println!("\ntampered install refused: {e}"),
    }
    println!("installed after refusal: {:?}", ids(&broken)?);

    store.uninstall("org.amos.pomodoro")?;
    println!("\nafter uninstall: {:?}", ids(&store)?);
    Ok(())
}
