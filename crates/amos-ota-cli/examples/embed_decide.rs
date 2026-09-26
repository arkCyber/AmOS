//! `embed_decide` — the CLI as a library, offline: `run` called in-process with a
//! manifest written to a temp file, showing the *decision* command (which exits by
//! the kind of answer) and a full `install` dry run against local bytes.
//!
//! ```text
//! cargo run -p amos-ota-cli --example embed_decide
//! ```

use amos_ota_cli::{run, EXIT_DEFERRED, EXIT_OK};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join("amos-ota-embed");
    std::fs::create_dir_all(&dir)?;
    let image = b"AMOS-SYSTEM-IMAGE-2.0.0".to_vec();
    let image_path = dir.join("system-2.0.0.img");
    std::fs::write(&image_path, &image)?;
    let digest = amos_ota::sha256_hex(&image);
    let manifest_path = dir.join("manifest.json");
    std::fs::write(
        &manifest_path,
        format!(
            r#"{{"packages":[{{"version":"2.0.0","channel":"stable",
                "uri":"https://cdn.amos.example/system-2.0.0.img","sha256":"{digest}",
                "size_bytes":{size},
                "signature":{{"key_id":"amos-release","value":"aabbccdd"}}}}]}}"#,
            size = image.len()
        ),
    )?;

    let argv = |extra: &[&str]| {
        let mut v = vec![
            "amos-ota-cli",
            "install",
            "--manifest",
            manifest_path.to_str().unwrap(),
            "--image",
            image_path.to_str().unwrap(),
            "--current",
            "1.0.0",
            "--trust-key",
            "amos-release",
        ];
        v.extend_from_slice(extra);
        v.into_iter().map(String::from).collect::<Vec<_>>()
    };

    // On Wi-Fi but on battery with no readable level: honest deferral, not a guess.
    // Exit code 10 is the machine-readable form of that.
    let mut buf = Vec::new();
    let code = run(&argv(&["--wifi"]), &mut buf)?;
    println!(
        "deferred exit={code} (expected {EXIT_DEFERRED})\n{}",
        String::from_utf8(buf)?
    );

    // With a battery reading the gates clear and the dry run stages the image.
    let mut buf = Vec::new();
    let code = run(
        &argv(&["--wifi", "--charging", "--battery", "80"]),
        &mut buf,
    )?;
    println!(
        "install exit={code} (expected {EXIT_OK})\n{}",
        String::from_utf8(buf)?
    );

    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}
