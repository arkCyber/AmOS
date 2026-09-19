//! Evaluate the three flag shapes (boolean / percent / user allow-list) from a
//! JSON file, and show the rule that matters most: an **unknown key is `false`**,
//! so a typo cannot grant access.
//!
//! Writes one small JSON file into the system temp dir and reads it back with
//! `FeatureFlagSet::from_file` — the same entry point `from_local` uses after
//! resolving `AMOS_FEATURE_FLAGS_FILE` / `~/.amos/feature-flags.json`.
//!
//! ```bash
//! cargo run -p amos-config --example feature_flags
//! ```

use amos_config::{FeatureFlagSet, FlagContext};

fn main() {
    let dir = std::env::temp_dir().join(format!("amos-flags-example-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("feature-flags.json");
    std::fs::write(
        &path,
        r#"{
  "new_checkout": true,
  "old_checkout": false,
  "beta_ui": { "percent": 50 },
  "staff_tools": { "users": ["alice"] }
}"#,
    )
    .expect("write flags");

    let flags = FeatureFlagSet::from_file(&path);
    let ctx = FlagContext {
        install_id: "install-42".into(),
        user_id: Some("alice".into()),
        version: Some("1.0.0".into()),
    };

    for key in ["new_checkout", "old_checkout", "beta_ui", "staff_tools"] {
        println!("{key:<14} => {}", flags.is_enabled(key, Some(&ctx)));
    }

    // The percent bucket is `fnv1a(install_id) % 100`, so it is **stable** for
    // one install: a rollout does not flicker between reloads.
    println!(
        "{:<14} => {}",
        "beta_ui again",
        flags.is_enabled("beta_ui", Some(&ctx))
    );

    // Fail-closed: a typo is a different key, and a missing key is never "on".
    println!(
        "{:<14} => {}",
        "typo.new_checkout",
        flags.is_enabled("typo.new_checkout", None)
    );

    std::fs::remove_dir_all(&dir).ok();
}
