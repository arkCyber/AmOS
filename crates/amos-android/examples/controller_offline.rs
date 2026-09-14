//! `controller_offline` — drive the Android container controller against a **fake shell**.
//!
//! No Waydroid and no `adb` are needed: the `CommandRunner` seam records the exact command
//! lines the controller would execute and returns canned output. What this proves is the part
//! that has to be right before a container exists — command construction, the app-list parser,
//! and the capability ledger that remembers what was granted.
//!
//! Usage:
//! ```text
//! cargo run -p amos-android --example controller_offline
//! ```

use std::io;
use std::os::unix::process::ExitStatusExt;
use std::process::Output;
use std::sync::{Arc, Mutex};

use amos_android::controller::{AndroidController, CommandRunner};

/// A runner that records instead of executing (the whole point of the seam).
///
/// The recorded lines are shared through an `Arc` so the example can print the exact
/// transcript **after** the controller has taken ownership of the runner.
#[derive(Default)]
struct RecordingRunner {
    calls: Arc<Mutex<Vec<String>>>,
    /// What `pm list packages` would have printed.
    listing: String,
}

impl RecordingRunner {
    fn new(calls: Arc<Mutex<Vec<String>>>, listing: &str) -> Self {
        Self {
            calls,
            listing: listing.to_string(),
        }
    }
}

impl CommandRunner for RecordingRunner {
    fn run(&self, program: &str, args: &[&str]) -> io::Result<Output> {
        if let Ok(mut calls) = self.calls.lock() {
            calls.push(format!("{program} {}", args.join(" ")));
        }
        Ok(Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: self.listing.clone().into_bytes(),
            stderr: Vec::new(),
        })
    }
}

fn main() {
    // One `pm list packages -f` line per installed app.
    let listing = "package:/data/app/base.apk=com.example.notes\npackage:/system/priv-app/SystemUI/SystemUI.apk=com.android.systemui\n";
    let calls = Arc::new(Mutex::new(Vec::<String>::new()));
    let controller =
        AndroidController::with_runner(RecordingRunner::new(Arc::clone(&calls), listing));

    match controller.list_installed_apps() {
        Ok(apps) => {
            println!("parsed {} app(s):", apps.len());
            for app in &apps {
                // The offline parser fills identity only; icon/activity are resolved
                // later (icon extraction / launch), so they are shown as absent rather
                // than invented.
                println!(
                    "  {} (name={}, icon={}, activity={})",
                    app.package_name,
                    app.name,
                    if app.icon_path.is_empty() {
                        "(none)"
                    } else {
                        &app.icon_path
                    },
                    if app.activity.is_empty() {
                        "(none)"
                    } else {
                        &app.activity
                    },
                );
            }
        }
        Err(e) => println!("listing failed: {e}"),
    }

    // Launch/stop/install all become real command lines — printed here, executed on a device.
    // The label travels with the result, so a refusal names the operation it refused.
    let attempts: [(&str, Result<(), String>); 3] = [
        (
            "launch",
            controller.launch_apk("com.example.notes").map(|_| ()),
        ),
        ("force-stop", controller.force_stop("com.example.notes")),
        (
            "install",
            controller.install_apk("/data/local/tmp/notes.apk", "com.example.notes"),
        ),
    ];
    for (what, result) in attempts {
        match result {
            Ok(()) => println!("{what}: ok"),
            Err(e) => println!("{what} refused: {e}"),
        }
    }

    // The capability ledger: what this app was granted, and what a revoke really removes.
    let ledger = controller.ledger();
    println!(
        "grant camera -> {}",
        ledger.grant("com.example.notes", "camera")
    );
    println!(
        "grant storage -> {}",
        ledger.grant("com.example.notes", "storage.read")
    );
    println!(
        "re-grant camera -> {}",
        ledger.grant("com.example.notes", "camera")
    );
    println!("granted: {:?}", ledger.granted("com.example.notes"));
    println!(
        "is_granted(camera)={} revoke(camera)={} is_granted(camera)={}",
        ledger.is_granted("com.example.notes", "camera"),
        ledger.revoke("com.example.notes", "camera"),
        ledger.is_granted("com.example.notes", "camera")
    );
    println!(
        "a resource key with a space is refused: {}",
        !amos_android::capability::valid_resource_key("camera read")
    );
    println!("packages tracked: {:?}", ledger.packages());

    // And the transcript: every command the controller actually issued, in order.
    println!("\ncommand lines issued:");
    match calls.lock() {
        Ok(lines) => {
            for line in lines.iter() {
                println!("  {line}");
            }
        }
        Err(_) => println!("  (the recording lock was poisoned)"),
    }
    println!("(swap `RecordingRunner` for `ShellRunner` on a device to execute them)");
}
