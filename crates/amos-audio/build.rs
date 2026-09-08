//! build.rs — Android NDK link-path injection for the AAudio FFI (feature `aaudio`).
//!
//! `#[link(name = "aaudio")]` in src/android/aaudio.rs needs `libaaudio.so` on the
//! linker search path. AAudio requires NDK API >= 26, but the Rust cross-linker
//! chosen by `cargo tauri android build` targets an older API by default, so the
//! NDK sysroot it resolves does not contain `libaaudio.so` -> `-laudio` is not
//! found. When compiling for Android with the `aaudio` feature we locate the NDK
//! `usr/lib/<triple>/<api>` dir (api >= 26) that contains `libaaudio.so` and emit
//! a `cargo:rustc-link-search`. This only ever runs for an Android target (the
//! host/CI build is unaffected — `target_os` is not android there).
use std::env;
use std::fs;
use std::path::PathBuf;

fn ndk_root() -> Option<PathBuf> {
    if let Ok(p) = env::var("NDK_HOME") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    if let Ok(p) = env::var("ANDROID_NDK_HOME") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    // Fall back to $ANDROID_HOME/ndk/<latest>.
    if let Ok(home) = env::var("ANDROID_HOME") {
        if let Ok(entries) = fs::read_dir(PathBuf::from(home).join("ndk")) {
            let mut dirs: Vec<_> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort();
            return dirs.last().cloned();
        }
    }
    None
}

fn main() {
    let aaudio_feature = env::var("CARGO_FEATURE_AAUDIO").is_ok();
    let target = env::var("TARGET").unwrap_or_default();
    if !(aaudio_feature && target.contains("android")) {
        return; // host/CI build: nothing to do
    }

    let Some(ndk) = ndk_root() else {
        println!(
            "cargo:warning=amos-audio: aaudio needs an NDK (set NDK_HOME/ANDROID_NDK_HOME) for `-laudio`"
        );
        return;
    };

    // NDK names the armv7 ABI dir `arm-linux-androideabi` while the Rust target
    // triple is `armv7-linux-androideabi`; every other ABI matches its triple
    // verbatim. Map to the NDK platform dir for THIS target (we must only search
    // the matching platform — picking another ABI's libaaudio.so yields an
    // `incompatible with armelf_linux_eabi`-style link error).
    let platform_dir = if target == "armv7-linux-androideabi" {
        "arm-linux-androideabi"
    } else {
        target.as_str()
    };

    // Locate the NDK prebuilt sysroot and the matching platform dir.
    let prebuilt = ndk.join("toolchains/llvm/prebuilt");
    let mut best: Option<(u32, PathBuf)> = None;
    if let Ok(hosts) = fs::read_dir(&prebuilt) {
        for h in hosts.filter_map(|e| e.ok()) {
            let base = h.path().join("sysroot/usr/lib").join(platform_dir);
            let Ok(apis) = fs::read_dir(&base) else {
                continue;
            };
            for a in apis.filter_map(|e| e.ok()) {
                let api_dir = a.path();
                let name = a.file_name();
                let Some(name) = name.to_str() else { continue };
                let Ok(api) = name.parse::<u32>() else {
                    continue;
                };
                if api >= 26
                    && api_dir.join("libaaudio.so").exists()
                    && best.as_ref().map_or(true, |(b, _)| api > *b)
                {
                    best = Some((api, api_dir));
                }
            }
        }
    }

    if let Some((_, dir)) = best {
        println!("cargo:rustc-link-search=native={}", dir.display());
        println!("cargo:rerun-if-changed={}", dir.display());
    } else {
        println!(
            "cargo:warning=amos-audio: no NDK libaaudio.so found under usr/lib/{target} (need api>=26)"
        );
    }
}
