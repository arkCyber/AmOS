# Amos on the No-UI Android Base

The "operating system" beneath Amos is a **headless Android** — Linux kernel,
Android drivers, HAL, Binder, and base daemons — but **without** the Java UI
framework / SystemUI. This is the ideal substrate: it gives us every hardware
driver and the ActivityManager/SurfaceFlinger, while letting Rust + Tauri own
the entire user-facing system.

## 1. Why the existing code already fits

| Amos component | Runs as | Notes |
|---|---|---|
| `amos-ai` (AI daemon) | `/system/bin/amos-ai`, started by init | Pure Rust, headless, gRPC over UDS, socket `0700`, graceful shutdown |
| `amos-wm` (window manager) | in-process Rust lib | Transport-agnostic state machine (9 tests) |
| `amos-tauri` (System UI) | single launcher APK | WebView renders full-screen as Launcher + System UI; its Rust core is the gRPC client |

No Linux migration, no Waydroid — the "no-UI Android" *is* the container and the
hardware abstraction layer.

## 2. Boot orchestration (`deploy/android/amos.rc`)

Order guaranteed by init:
1. `on early-init` → `mkdir /data/amos` (socket dir, `0770 system:system`).
2. `on property:sys.boot_completed=1` → `start amos-ai`.
3. `service amos-ai /system/bin/amos-ai --socket /data/amos/ai.sock`:
   `class main`, `user root`, `seclabel`, `setenv AMOS_SOCKET=...`,
   `oom_score_adj -1000` (never kill the inference core), auto-restart.
4. Tauri System UI = the **only** app declaring `HOME` intent → Android starts
   it as the launcher after boot; it connects to `/data/amos/ai.sock`.

`amos-ai` now also accepts `--socket PATH` / `--help` / `--version` (unit-tested)
so init can pass the path explicitly.

## 3. Cross-compilation

- **Headless Rust** (`amos-ai`, `amos-wm`): `scripts/build-android.sh` generates
  `.cargo/config.toml` with the NDK linker and runs
  `cargo build --release --target aarch64-linux-android -p amos-ai -p amos-wm`.
- **Tauri System UI**: `cd crates/amos-tauri && cargo tauri android init && cargo tauri android build`
  → produces the launcher APK (needs Android SDK/NDK).

## 4. Design: JNI / Binder Rust bindings (next)

To let Rust (Agent / Tauri core) talk to low-level Android services (power,
network, sensors, ActivityManager):
- **`jni` crate** for JNI calls into system services that still exist but lack a
  UI: e.g. `PowerManager`, `ConnectivityManager` via the system context.
- **`binder` crate** (Rust implementation of Binder) for high-throughput IPC to
  `SurfaceFlinger` / `AMS` / `input` without going through Java at all —
  preferred for latency-critical paths.
- Gate behind `#[cfg(target_os = "android")]` and expose a thin
  `android_bridge` module to `amos-tauri`.

## 5. Design: launch old APKs & mount their surface (next)

When the user taps "微信" in the Tauri Launcher:
1. Rust launches the app (`am start` via binder, or `am start` shell) → AMS
   creates its window.
2. **方案 A (层叠)** — `SurfaceControl`: reparent the old app's surface as a
   child of the Tauri window's layer, positioned/opacity-controlled from Rust.
3. **方案 B (纹理, 最硬核)** — `VirtualDisplay`: render the old app to an
   off-screen virtual display, capture its `HardwareBuffer`, and upload as a
   WebGL texture so the legacy app becomes a `<div>` in the Tauri webview.

## 6. AI Agent on the base (降维打击)

With root/system privileges the Rust Agent can, without Accessibility:
- Inject input: `input tap x y`, `input text "..."` via binder/shell.
- Read the screen: `screencap` or GraphicsBuffer reads at high FPS for VLM.
- Feed the frame/text into the same gRPC pipe (`amos-ai`) for on-device
  inference.
