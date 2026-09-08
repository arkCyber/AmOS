//! `scan_dir` — pack a real directory tree's photos as JSON for the Svelte 5 UI.
//!
//! This is the device bring-up probe the architect proposed (docs/android-storage-unify.md
//! §6 E): a standalone Rust binary that reads `/storage/emulated/0/DCIM/Camera/` etc. and
//! prints each file's path / mtime / size as JSON via [`HostFsProvider`].
//!
//! * Host (quick sanity, macOS/Linux/Waydroid): `cargo run -p amos-media --example scan_dir -- <ROOT> [tag …]`
//! * Android (root test box): cross-compile + ADB:
//!   ```sh
//!   cargo ndk -t arm64-v8a build -p amos-media --example scan_dir --release
//!   adb push target/aarch64-linux-android/release/examples/scan_dir /data/local/tmp/
//!   adb shell 'su -c chmod +x /data/local/tmp/scan_dir'
//!   adb shell 'su -c /data/local/tmp/scan_dir /storage/emulated/0 camera download'
//!   ```
//!
//! Raw `read_dir` of `/storage/emulated/0` is only permitted for a **root** / system /
//! Waydroid context — never a normal Android app (scoped storage). `HostFsProvider` is
//! that raw channel; the normal app path stays on MediaStore via the Kotlin glue.

use std::sync::Arc;
use std::time::Instant;

use amos_media::{HostFsProvider, MediaManager, MediaProvider, StandardDir};
use std::path::PathBuf;

fn parse_dir(tag: &str) -> Option<StandardDir> {
    Some(match tag {
        "camera" => StandardDir::Camera,
        "screenshots" => StandardDir::Screenshots,
        "pictures" => StandardDir::Pictures,
        "download" => StandardDir::Download,
        "recordings" => StandardDir::Recordings,
        "movies" => StandardDir::Movies,
        "music" => StandardDir::Music,
        "root" => StandardDir::Root,
        _ => return None,
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!(
            "usage: scan_dir <ROOT> [camera screenshots pictures download recordings movies music root]"
        );
        std::process::exit(2);
    }
    let root = PathBuf::from(&args[0]);
    let dirs: Vec<StandardDir> = if args.len() > 1 {
        let mut out = Vec::new();
        for tag in &args[1..] {
            match parse_dir(tag) {
                Some(d) => out.push(d),
                None => eprintln!("ignoring unknown collection tag: {tag}"),
            }
        }
        out
    } else {
        vec![StandardDir::Camera, StandardDir::Download]
    };

    let provider: Arc<dyn MediaProvider> = Arc::new(HostFsProvider::new(root));
    let manager = MediaManager::new(provider);
    for d in &dirs {
        manager.grant_read(*d);
    }

    let start = Instant::now();
    let mut all = Vec::new();
    for d in &dirs {
        match manager.list(*d) {
            Ok(items) => {
                eprintln!("{d:?}: {} items", items.len());
                all.extend(items);
            }
            Err(e) => eprintln!("{d:?}: {e}"),
        }
    }

    match serde_json::to_string_pretty(&all) {
        Ok(json) => println!("{json}"),
        Err(e) => {
            eprintln!("json error: {e}");
            std::process::exit(1);
        }
    }
    eprintln!(
        "scanned {} items in {:?} (backend={})",
        all.len(),
        start.elapsed(),
        manager.provider_name()
    );
}
