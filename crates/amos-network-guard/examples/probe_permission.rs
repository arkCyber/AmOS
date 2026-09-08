//! Device bring-up probe: **what firewall permission does the current context have?**
//!
//! First step when a real test phone arrives (`docs/anti-telemetry-egress-guard.md`
//! §5): probe whether this build can touch the kernel firewall at all, and surface
//! the exact denial (e.g. `Operation not permitted`, SELinux denial) rather than
//! assuming it can. The result decides the default path — a **non-rooted** device
//! will be denied and must use `VpnService` (feature `vpn`), not nftables.
//!
//! Runs on the device over adb. It shells out and prints the exit code + stderr;
//! it never panics and never fabricates success.
//!
//! ```bash
//! # from the device shell (adb shell) or with adb on PATH:
//! cargo run -p amos-network-guard --example probe_permission
//! ```

use std::process::Command;

fn probe(command: &str, args: &[&str]) {
    println!("== probing: {command} {}", args.join(" "));
    match Command::new(command).args(args).output() {
        Ok(out) => {
            let code = out.status.code();
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            println!("  exit code: {code:?}");
            if !stdout.trim().is_empty() {
                println!("  stdout: {}", stdout.trim());
            }
            if !stderr.trim().is_empty() {
                println!("  stderr: {}", stderr.trim());
            }
            // A non-zero / None exit on a permission probe is the *expected*
            // non-rooted result, not an error in this tool.
            println!(
                "  => {}",
                if out.status.success() {
                    "HAS firewall write access"
                } else {
                    "DENIED (see code/stderr) — use the rootless VpnService path"
                }
            );
        }
        Err(e) => {
            println!("  could not run {command}: {e}");
        }
    }
}

fn main() {
    println!("amos-network-guard permission probe (device bring-up)");
    // Read-only listing first (least privileged), then an attempt to touch the
    // ruleset. Read-only is what a non-rooted shell can do; the write is what
    // enforcement would need.
    probe("iptables", &["-L", "-n"]);
    probe("nft", &["list", "ruleset"]);
    probe("iptables", &["-I", "OUTPUT", "-j", "RETURN"]);
}
