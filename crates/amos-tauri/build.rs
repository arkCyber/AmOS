//! Build script — `tauri_build::build()` plus one thing `tauri-build` does **not** do:
//! make the **embedded frontend bundle** a tracked input of this crate (REQ-A425).
//!
//! Why this is needed, measured on this machine (2026-09-18): `generate_context!` expands
//! *during* this crate's compilation and embeds `frontend-ts/dist` there — so a bundle
//! that changes afterwards is embedded only if the crate is recompiled, and nothing told
//! cargo that `dist` could matter. Measured: `bun run build` (20:39) followed by
//! `cargo build --release -p amos-tauri --features custom-protocol` finished in 0.31 s
//! without compiling anything, and `target/release/build/amos-tauri-*/out/tauri-codegen-assets`
//! still held the 20:34 asset set — i.e. the release binary shipped the **previous** UI
//! while `scripts/dist-freshness.mjs` (which compares `dist` against its *sources*) happily
//! said "dist is current".
//!
//! Two lines of defence, because one of them is not sufficient on its own:
//!   * `cargo:rerun-if-changed` for every file under the bundle — so a changed/new asset
//!     re-runs this script;
//!   * a fingerprint file in `OUT_DIR` that `src/lib.rs` `include_str!`s — so a rerun that
//!     observes different content makes the **crate** dirty, which is what actually forces
//!     the macro to embed the new bytes.
//!
//! The fingerprint is content-derived (file path + size + mtime, hashed) rather than the
//! bundle path, so "same number of files, same size, different bytes" cannot slip through.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

/// The bundle the release binary embeds (`tauri.conf.json`'s `frontendDist`).
const BUNDLE_DIR: &str = "frontend-ts/dist";

fn main() {
    tauri_build::build();
    track_embedded_bundle();
}

/// Emit the rerun directives and write `OUT_DIR/embedded-frontend.fingerprint`.
fn track_embedded_bundle() {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));
    let bundle = Path::new(BUNDLE_DIR);
    // `rerun-if-changed` on the directory itself covers additions/removals; the per-file
    // lines below cover edits, which a directory mtime does not reflect.
    println!("cargo:rerun-if-changed={BUNDLE_DIR}");

    let mut files = Vec::new();
    collect(bundle, &mut files);
    files.sort();
    for file in &files {
        println!("cargo:rerun-if-changed={}", file.display());
    }

    let mut hasher = DefaultHasher::new();
    for file in &files {
        file.display().to_string().hash(&mut hasher);
        if let Ok(meta) = fs::metadata(file) {
            meta.len().hash(&mut hasher);
            if let Ok(modified) = meta.modified() {
                if let Ok(d) = modified.duration_since(std::time::UNIX_EPOCH) {
                    d.as_nanos().hash(&mut hasher);
                }
            }
        }
    }
    // `absent` is a real state (a fresh checkout legitimately has no `dist/`; the dev
    // build loads the Vite server instead), and it must be distinguishable from "empty
    // bundle" in the boot log rather than looking like a broken one.
    let fingerprint = if files.is_empty() {
        "absent".to_string()
    } else {
        format!("{:016x}-{}", hasher.finish(), files.len())
    };
    let dest = out_dir.join("embedded-frontend.fingerprint");
    // Write only on change: an unconditional rewrite would make the crate dirty on every
    // build, i.e. force a full recompile even when nothing moved (`dist-freshness`-style
    // honesty about *what* changed, applied to the build graph itself).
    let unchanged = fs::read_to_string(&dest)
        .map(|old| old == fingerprint)
        .unwrap_or(false);
    if !unchanged {
        fs::write(&dest, &fingerprint).expect("writing the bundle fingerprint");
    }
}

/// Every file under `dir` (recursively); a missing `dir` yields nothing.
fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out);
        } else {
            out.push(path);
        }
    }
}
