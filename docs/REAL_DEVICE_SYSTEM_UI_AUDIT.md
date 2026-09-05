# Real‑device readiness: System UI + Magnifier/Camera audit & deployment guide

> Scope: the user asked to “link a real device”, audit & complete the code, and test
> comprehensively — focused first on making the **Magnifier / Camera** real‑device ready
> (manifest + runtime CAMERA + WebView media), running the automated suites, then a deploy guide.

## 1. Verified environment (audit date: this session)

| Item | Value | Verdict |
|---|---|---|
| Connected device | `Ragentek S5`, `arm64-v8a`, Android **14** (SDK 34), `720×1540` | `adb devices` → `device` ✅ |
| adb | `/opt/homebrew/bin/adb`, 1.0.41 | ✅ |
| Android SDK | `ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools` (build-tools, ndk, platforms) | ✅ |
| Rust Android targets | `aarch64/armv7/x86_64-linux-android` | ✅ |
| tauri‑cli | `tauri-cli 2.11.2` | ✅ |
| **Root on device** | `adbd cannot run as root in production builds`; no `su`; `/system` **read‑only**; verified boot `green` | ❌ **not rootable** |
| Amos on device | no `com.amos.*` package installed | — |
| Tauri‑Android project | **not generated** (`crates/amos-tauri/android` absent); `gen/schemas/capabilities.json` is just the ACL schema `{}` | ❌ not scaffolded |

### Hard blockers for “whole OS on this phone, today”
- The repo’s on‑device story stages **headless daemons into `/system/bin` via
  `deploy/android/amos.rc`** (`scripts/build-android.sh` + `adb push … /system/bin`).
  That requires a **rooted** device (or a custom system image). This phone cannot be
  rooted (`production builds`) and `/system` is read‑only.
- The **System UI GUI** is a Tauri‑Android app; that project has **not been generated**
  yet, so there is no APK to install and no `AndroidManifest.xml` to merge permissions into.

Consequence: a faithful full‑device bring‑up is **blocked in this environment** without
(1) a rootable device or (2) generating + building the Tauri‑Android APK and accepting a
normal (non‑/system) install of the GUI + daemon running in‑app.

## 2. Two camera paths — where the Magnifier really runs

The frontend Magnifier/Camera call WebView `navigator.mediaDevices.getUserMedia`.
On a real device there are two, very different realities:

- **Desktop / simulator (current code path).** The OS webview already has a camera and
  grants `getUserMedia`. No extra code. `camera.noCamera`/`magnifier.demo` handle the
  no‑camera fallback.
- **Android Tauri shell (real device).** `getUserMedia` is gated by:
  1. `android.permission.CAMERA` in the **manifest**,
  2. the **runtime** CAMERA grant to the app,
  3. the WebView’s **`WebChromeClient.onPermissionRequest`** granting
     `RESOURCE_VIDEO_CAPTURE`.
  None of these are provided by Tauri v2 out‑of‑the‑box, so **today the live magnifier
  would fall back to the demo scene** on a real device even with a working camera.

Separately, this repo already contains the *architecture‑intended* on‑device camera
producer: **`CameraGlue` (Camera2 preview → NV21) → JNI → `LiveSensorProvider` bus**
(`crates/amos-tauri/src/sensor_host.rs` / `android_glue.rs`). That path does **not** go
through WebView `getUserMedia`; it is how a System‑UI APK should feed live frames to the
frontend (mirroring how the flashlight already bridges real torch). Using it for a live
Magnifier on device is the correct long‑term design but is a sizeable feature (stream a
video surface into the frontend canvas) and is **only testable at device time**.

## 3. What was audited & the code completed this pass

Audited (by tracing the actual call graph):
- `MagnifierApp` / `CameraApp` `getUserMedia` path + graceful demo fallback. ✅ (host‑tested)
- Permission‑ledger gate `CapabilityGate` → `lib/permissions.ts` + daemon privacy store. ✅
- The Android **native** producers (`AmosGlue.kt`, `CameraGlue.kt`, `FlashlightGlue.kt`,
  `ClipboardGlue.kt`, `SensorGlue.kt`) — structural skeletons per `docs/android-glue.md`.
- `amos-tauri` Rust bridges (`flashlight.rs`, `radio.rs`, `sensor_host.rs`, `clipboard.rs`)
  gated by `feature = "android"`.

Added (all consistent with the existing `android-glue/` structural‑delivery convention):
1. `crates/amos-tauri/android-glue/AndroidManifest.permissions.xml` — the exact
   `<uses-permission>` block (`CAMERA`, `RECORD_AUDIO`, `INTERNET`, …) to merge into the
   generated `gen/android/.../AndroidManifest.xml` after `cargo tauri android init`.
2. `crates/amos-tauri/android-glue/com/amos/ai/glue/MainActivity.Wiring.kt` — the missing
   **runtime wiring**: request CAMERA/RECORD_AUDIO on `onStart`, forward
   `onRequestPermissionsResult` into `AmosGlue.onCameraPermissionGranted`, and a
   `WebChromeClient` that grants `RESOURCE_VIDEO_CAPTURE`/`RESOURCE_AUDIO_CAPTURE` once the
   OS grant is held (so `getUserMedia` can go live instead of demo).
3. This guide (`docs/REAL_DEVICE_SYSTEM_UI_AUDIT.md`).

### About “Tauri capabilities”
The Magnifier/Camera do **not** use a Tauri *plugin* or a capability‑gated command — they
use WebView media APIs. IPC in the UI goes through `window.__TAURI_INTERNALS__.invoke`
(`frontend-ts/src/lib/backend.ts`), which targets **your own** registered `#[tauri::command]`
handlers in `lib.rs` — those are allowed by default and do **not** need an ACL entry. So a
`capabilities` file is **not** the right lever for camera access. The real levers are the
three listed in §2 (manifest + runtime grant + WebChromeClient). If you later add a *plugin*
you will need a capability granting its permissions; none is used today
(`search: tauri-plugin` → none).

## 4. Comprehensive automated tests

Run on the host (desktop; no Android build is possible here because the device is not
rootable and the Tauri‑Android project is not scaffolded):

- Frontend (React System UI): `cd crates/amos-tauri/frontend-ts && bun run test`
- Rust unit (System‑UI crate + bridges): `cargo test -p amos-tauri --lib`

### Results (this audit)
- **Frontend suite: 579 pass, 0 fail** → `[bun-iso] test OK`
  (includes `magnifier.test.tsx` — permission gate, granted UI, defaults/reset, and the
  live‑camera‑readiness transition).
- **Rust `cargo test -p amos-tauri --lib`: 102 pass, 0 fail** (bridge/glue/store/wm unit tests).


## 5. Real‑device deployment guide (when a rootable device / scaffolded APK exists)

### 5.1 Generate the Tauri‑Android project (needed once)
```bash
cd crates/amos-tauri
cargo tauri android init
# produces gen/android/… with MainActivity + AndroidManifest.xml
```
Then merge `crates/amos-tauri/android-glue/AndroidManifest.permissions.xml`’s
`<uses-permission>` lines into `gen/android/app/src/main/AndroidManifest.xml`, and copy the
Kotlin glue into place:
```bash
cp -r android-glue/com/amos/ai/glue gen/android/app/src/main/java/com/amos/ai/
```

### 5.2 Runtime CAMERA + WebView media (one‑time wiring)
In the generated `MainActivity` (Tauri v2 activity):
- `onStart` → `PermissionWire.requestNeeded(this)` then `AmosGlue.onStart(applicationContext)`
  after the grant.
- `onRequestPermissionsResult` → `PermissionWire.onResult(this, requestCode, grantResults)`
  and (optional) `PermissionWire.mediaChrome` on the webview so `getUserMedia` goes live.

### 5.3 Build + install the System UI APK (no root needed)
```bash
cd crates/amos-tauri
cargo tauri android build --features android   # builds + assembles debug/release APK
adb install -r gen/android/app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p com.amos.ai 1              # launch
```

### 5.4 Headless daemons — requires ROOT (skip on this device)
This phone cannot be rooted; the daemons-in-/system path is documented in
`scripts/build-android.sh` and `deploy/android/amos.rc`. On a rootable device:
```bash
scripts/build-android.sh                       # cross-build amos-ai + amos-wm + radio/flash
adb root
adb push target/aarch64-linux-android/release/amos-ai /system/bin/
adb shell chmod 0755 /system/bin/amos-ai
```

### 5.5 Verify on device
- Open Magnifier 🔍 → allow Camera → confirm the **live** view (not “Demo scene”).
- Toggle brightness/contrast/zoom; drag the lens.
- `adb logcat -s WebView ConsoleTracer` for WebView/media errors.
- If it still says “Demo scene”, the WebChromeClient grant (§5.2) or the runtime grant is missing.

## 6. Honest boundaries
- Kotlin glue + manifest are **structural** (consistent with the repo’s existing
  `android-glue` convention) — they cannot be compiled/validated here because the
  Tauri‑Android project is not scaffolded and this device cannot be rooted.
- The live **native** camera path (`CameraGlue` → `LiveSensorProvider`) is the
  architecture‑intended producer for an on‑device Magnifier and is deliberately **not**
  exercised by WebView `getUserMedia`; wiring a live video surface from it to the frontend
  is a follow‑up feature that is only meaningful at device time.

