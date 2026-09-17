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
Then merge the tracked fragment(s) from
`crates/amos-tauri/android-glue/` into `gen/android/app/src/main/AndroidManifest.xml`,
and mirror the Kotlin glue into place — **always via the script, never a hand `cp`** (a
manual copy goes stale, and a newly added glue file never reaches the APK):
```bash
scripts/android-glue-mirror.sh   # mirrors the glue AND verifies the merges below
```
The script also **checks** that the generated manifest declares every `android:name` the
fragments declare (`AndroidManifest.permissions.xml` — permissions/features, and
`AndroidManifest.components.xml` — the in-call/screening services and the SMS receiver),
failing loudly with the missing entries and their source fragment. Both merges stay
manual (the generated manifest is Tauri's); drift, however, is now loud — it already had
happened twice: the hotspot's `TETHER_PRIVILEGED` sat declared-but-unmerged, and the three
glue components existed **only** in the generated file (a clean checkout would have built
an APK with no in-call UI, no call screening and no live SMS receive).

### 5.2 Runtime CAMERA + WebView media (one‑time wiring)
In the generated `MainActivity` (Tauri v2 activity) — the template with the full set of
calls is `crates/amos-tauri/android-glue/com/amos/ai/glue/MainActivity.Wiring.kt`:
- `onCreate` → `AlwaysOn.apply(this)` (常驻·永亮)
- `onStart` → `PermissionWire.requestNeeded(this)` + `PermissionWire.requestMedia(this)` +
  `PermissionWire.ensureAttached(this)`, then `TelephonyGlue.bind(...)`/`ensureCallPermission`,
  `BlocklistGlue.bind(...)`/`attachActivity(this)`, `DevCareGlue.attachActivity(this)`/
  `bind(...)`, and — once CAMERA is held — `AmosGlue.onStart(applicationContext)`.
- `onRequestPermissionsResult` → `PermissionWire.onResult(...)` + `TelephonyGlue.onResult(...)`,
  then `AmosGlue.onCameraPermissionGranted(...)` + `AmosGlue.onStart(...)` on a CAMERA grant.
- `onStop` → `AmosGlue.onStop(applicationContext)` (frees the camera/torch).
- optionally `PermissionWire.mediaChrome` on the webview so `getUserMedia` goes live.

`scripts/android-glue-mirror.sh` **verifies** these 15 call sites are present in the
generated Activity and fails loudly (with each missing call and what it is for) — because
a fresh `tauri android init` Activity calls none of them, and that APK would ship the whole
compiled glue without binding any of it.

### 5.3 Build + install the System UI APK (no root needed)
```bash
scripts/build-apk.sh                 # release APK (unsigned — cannot be installed)
scripts/build-apk.sh --config        # **debug** APK (debug-signed ⇒ installable, debuggable)
cd crates/amos-tauri
adb install -r gen/android/app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p com.amos.ai 1              # launch
```
> JDK 17 is required (AGP/Kotlin 1.x reject newer JDKs). Export it for the build:
> `JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home`.
> A release APK cannot be installed at all (no signing config is tracked, REQ-A176
> boundary) — device verification needs `--config`.

### 5.5 Device-driven UI verification (REQ-A185)
The System UI is a WebView: `uiautomator` sees **one** node and `input tap` has no
coordinates a test can derive, so device checks used to stop at "the app launched".
A **debuggable** build exposes the WebView devtools socket, and
`scripts/device-ui-eval.mjs` drives it over CDP (nothing is installed, nothing is
patched):

```bash
node scripts/device-ui-eval.mjs 'document.title'                       # → "Amos System UI"
node scripts/device-ui-eval.mjs 'document.querySelectorAll("[data-testid]").length'
node scripts/device-ui-eval.mjs --await 'await window.__probe()'       # async expressions
node scripts/device-ui-eval.mjs --wait 45000 'document.title'          # bound the readiness wait
node scripts/device-ui-eval.mjs --list                                 # devtools targets
node scripts/device-ui-eval.mjs --selftest                             # no device needed
```
It finds the app pid, forwards `@webview_devtools_remote_<pid>` and evaluates in the
real page — so a control's presence, its rendered text and the **real bridge's**
answer are all observable. Native (non-WebView) UI — permission dialogs, system
bars — is still `uiautomator`'s job; the two together cover a device round.

**A stalled page now names its cause (REQ-A367).** `Runtime.evaluate` **never returns**
while the WebView is paused, and Android pauses an obscured WebView. Measured on the S5
with the notification shade pulled down: `dumpsys window` reported
`mCurrentFocus=Window{… NotificationShade}` while `com.amos.ai/.MainActivity` was still the
resumed activity — the app was on screen and running, and its JS had simply stopped. That
state used to be reported as a bare `devtools evaluate timed out` /
`page never became ready within 30000ms`, which reads like a broken tool and cost one
session's worth of chasing ANR/crash logs that had already scrolled away. The failure path
now reads `dumpsys window` and `dumpsys activity activities` and prints `mCurrentFocus` /
`mFocusedApp` / `ResumedActivity` **plus a decision** — one that is required to be able to
answer "the device state is **not** the reason" (the app's own window in front, or the IME
taking focus). `--selftest` pins the parsers and that decision table on captured device
output: no phone, no debug build, and it runs in `make lint`.

**Correction (REQ-A368).** The shade was *a* cause, not *the* cause. Collapsing it (a swipe up —
`cmd statusbar collapse` alone did not work) returned `mCurrentFocus` to
`com.amos.ai/com.amos.ai.MainActivity`, and the page *still* never answered, through a
`force-stop` + relaunch as well. What does explain it is the **renderer** reading: `logcat` showed
`ActivityManager: Unable to launch app com.amos.ai/10172 for service Intent { cmp=com.amos.ai/
org.chromium.content.app.SandboxedProcessService0:0 }: process is bad`, and
`dumpsys activity processes` still lists the app's four
`ConnectionRecord{… u0 CR DEAD …SandboxedProcessService…}` entries — **no WebView renderer**, so the
page has no JS engine at all (the process meanwhile spins at ~50% of a core, which is how "paused"
and "stuck" can be told apart). The failure path reports that reading first, together with the
device-side step (reboot the phone; this is ActivityManager bookkeeping, not an app defect). A
logcat *window* was not good enough for it: the decisive lines appeared 12 times, all within the
launch second, and had scrolled out of `logcat -d -t 600` two minutes later — so the verdict comes
from the current state, and the log line is only corroboration.

Permission ground truth (what the installed APK may actually call) is
`dumpsys`, not the source:
```bash
adb shell dumpsys package com.amos.ai | sed -n '/requested permissions:/,/install permissions:/p'
```

### 5.6 Verify on device

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

