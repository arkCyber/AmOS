//! On-device `SystemHealth` sampler for `amos-monitor` (P-device bring-up prep).
//!
//! Reads the **real** `/proc` of whatever Linux/Android device it runs on via the
//! `--features linux` [`LinuxSystemSampler`] (CPU aggregate + `/proc/meminfo`), then
//! prints the parsed load and memory. The first `snapshot()` only establishes the
//! CPU delta baseline; the second yields a real busy-window reading.
//!
//! ```text
//! cargo build -p amos-monitor --features linux --example sample_health --target aarch64-linux-android --release
//! adb push target/aarch64-linux-android/release/examples/sample_health /data/local/tmp/
//! adb shell chmod +x /data/local/tmp/sample_health && adb shell /data/local/tmp/sample_health
//! # e.g. → "mem_total_bytes=…" that you can cross-check with `adb shell cat /proc/meminfo`
//! ```
//!
//! The same binary also runs on the host: `cargo run -p amos-monitor --features linux --example sample_health`.

use amos_monitor::linux::LinuxSystemSampler;
use amos_monitor::sampler::SystemSampler;

fn main() {
    let s = LinuxSystemSampler::new();
    println!("amos-monitor sample_health (sampler={})", s.name());
    let _ = s.snapshot(); // first read: establishes the CPU delta baseline

    // Let a real window elapse so the second sample yields a genuine busy reading.
    let sleep_ms: u64 = std::env::var("SAMPLE_HEALTH_SLEEP_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(400);
    std::thread::sleep(std::time::Duration::from_millis(sleep_ms));

    let load = s.snapshot(); // a real delta window
    let busy = load
        .cpu
        .busy_pct
        .map(|p| format!("{p:.1}%"))
        .unwrap_or_else(|| "unknown".to_string());
    println!("cpu_busy_window_after_{sleep_ms}ms={busy}");
    match (load.memory.total_bytes, load.memory.available_bytes) {
        (Some(t), Some(a)) => {
            let used = load.memory.used_pct().unwrap_or(f64::NAN);
            println!("mem_total_bytes={t}");
            println!("mem_available_bytes={a}");
            println!("mem_used_pct={used:.1}%");
        }
        other => println!("mem_fields_unknown=({other:?})"),
    }
    println!("SAMPLED_OK");
}
