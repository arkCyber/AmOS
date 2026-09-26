#!/usr/bin/env node
/**
 * android-permission-scan.mjs — "the app never asked for the permission its own
 * platform call needs".
 *
 * Why: `AndroidRadioProvider` (`crates/amos-radio/src/android.rs`, `android`
 * feature) reads and switches Wi-Fi and Bluetooth through JNI —
 * `WifiManager#isWifiEnabled` / `#setWifiEnabled`, `BluetoothAdapter#isEnabled` /
 * `#enable` / `#disable` — and **none of those permissions was declared** in
 * `crates/amos-tauri/android-glue/AndroidManifest.permissions.xml` until REQ-A185
 * (only the privileged `TETHER_PRIVILEGED` was, ironically). On a real device every
 * one of those calls throws `SecurityException`, so the radio snapshot and the
 * quick-settings tiles were dead — and every gate stayed green, because the
 * `android-glue-check` compile *has* the SDK methods: a permission is an
 * install/runtime fact, not a compile-time one (a connected device's own
 * `dumpsys package com.amos.ai` reported **0** Wi-Fi/Bluetooth permissions while
 * the code called APIs that require them).
 *
 * What it checks: every platform API this repo calls is mapped below to the
 * permission(s) it requires — a **recorded decision, not a guess** (same style as
 * `tauri-event-scan.mjs`'s payload table). For each *family* the scan finds in a
 * source file it requires the family's permission set to be declared in the tracked
 * manifest fragment and, for a **runtime** permission, to also be requested from
 * Kotlin (a declared runtime permission that is never requested is never granted).
 * Families are used rather than spellings because a call site may compute the method
 * name (`let method = if on { "enable" } else { "disable" }`) — its siblings in the
 * same file require the same permissions.
 *
 * Honest boundary: the map is hand-maintained, so a platform API nobody listed is
 * invisible; `TETHER_PRIVILEGED` is expected to be present and permanently
 * ungrantable (signature|privileged), recorded as `privileged` rather than as a
 * runtime request; a permission declared but unused by any mapped call is reported
 * as `stale` (informational, not a failure); and prose in docs is not scanned — a
 * mention is not a call.
 *
 * Usage (from the repo root):
 *   node scripts/android-permission-scan.mjs              # gate
 *   node scripts/android-permission-scan.mjs --json       # machine-readable
 *   node scripts/android-permission-scan.mjs --selftest   # pin the parser/classifier
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Platform APIs we call → the permission they require.
 *
 * `tokens` are the strings that appear in our sources: JNI method-name literals
 * (`crates/amos-radio/src/android.rs` passes them to `call_method`) and Kotlin
 * class references in the glue. `permissions` is the whole set the family needs;
 * `runtime` the subset that must also be requested from Kotlin; `privileged` a
 * permission a normal install can never hold (declared so the requirement stays
 * visible, treated as a platform limit, never as a runtime request).
 */
export const API_FAMILIES = [
  {
    family: "wifi-state",
    tokens: ["isWifiEnabled", "ACCESS_WIFI_STATE"],
    permissions: ["android.permission.ACCESS_WIFI_STATE"],
    runtime: [],
    why: "WifiManager#isWifiEnabled (radio snapshot + status-bar badge) needs ACCESS_WIFI_STATE",
  },
  {
    family: "wifi-switch",
    tokens: ["setWifiEnabled", "CHANGE_WIFI_STATE"],
    permissions: ["android.permission.CHANGE_WIFI_STATE"],
    runtime: [],
    why: "WifiManager#setWifiEnabled needs CHANGE_WIFI_STATE (API 29+ still restricts the caller to system/device-owner)",
  },
  {
    family: "bluetooth",
    tokens: [
      "BluetoothAdapter",
      "getAdapter",
      "BLUETOOTH_CONNECT",
      // The detail surface added in REQ-A199 — the adapter's own name and the devices
      // it is paired with. Recorded here because these are the APIs that make
      // `BLUETOOTH_CONNECT` load-bearing beyond on/off, and because the gate's honest
      // boundary is "an API nobody listed is invisible".
      "getName",
      "setName",
      "getBondedDevices",
      "getBondState",
    ],
    permissions: [
      "android.permission.BLUETOOTH",
      "android.permission.BLUETOOTH_ADMIN",
      "android.permission.BLUETOOTH_CONNECT",
    ],
    runtime: ["android.permission.BLUETOOTH_CONNECT"],
    why: "BluetoothAdapter#isEnabled/enable/disable/getName/setName/getBondedDevices + BluetoothDevice#getBondState: BLUETOOTH(+ADMIN) ≤30, BLUETOOTH_CONNECT 31+ (runtime)",
  },
  {
    family: "bluetooth-scan",
    // The discovery/pairing surface (REQ-A200). `BluetoothGlue` names the Kotlin glue
    // in Rust, so both halves are covered by one family.
    //
    // The LE half (REQ-A201) is listed explicitly for the same reason `getName`/`setName`
    // are above: `BluetoothLeScanner`/`ScanCallback` are **new** APIs whose permission
    // requirement (the same runtime `BLUETOOTH_SCAN`) is only checked because they are
    // named here — an API nobody listed is invisible to this gate.
    tokens: [
      "startDiscovery",
      "createBond",
      "BluetoothGlue",
      "BluetoothLeScanner",
      "ScanCallback",
    ],
    permissions: [
      "android.permission.BLUETOOTH",
      "android.permission.BLUETOOTH_ADMIN",
      "android.permission.BLUETOOTH_SCAN",
      "android.permission.BLUETOOTH_CONNECT",
    ],
    runtime: ["android.permission.BLUETOOTH_SCAN"],
    why: "BluetoothAdapter#startDiscovery + BluetoothDevice#createBond + BluetoothLeScanner#startScan (through BluetoothGlue): BLUETOOTH_SCAN (runtime, API 31+; the LE scan needs the same one) + BLUETOOTH_CONNECT, BLUETOOTH(+ADMIN) ≤30",
  },
  {
    family: "tethering",
    tokens: ["TetheringManager", "setWifiTethering", "isWifiTethering"],
    permissions: ["android.permission.TETHER_PRIVILEGED"],
    privileged: ["android.permission.TETHER_PRIVILEGED"],
    runtime: [],
    why: "TetheringManager#startTethering needs TETHER_PRIVILEGED (signature|privileged ⇒ never granted to a normal install)",
  },
  {
    // Exact alarms (REQ-A369, closing F-TAU-007). Until this family existed, the
    // permissions were simply not declared anywhere and the *call site* was not made
    // either: the host wrote its ledger and a sleeping phone was never woken — the
    // gate had nothing to check because the API the app must call was never called
    // (docs/native-alarm-bridge.md, F-TAU-007). Both halves are named here so the
    // declaration and the call site keep each other honest: the Rust command
    // (`scheduler_alarm_register`, through `AlarmGlue`) and the Kotlin API whose
    // permission this is.
    //
    // `runtime` is empty on purpose: neither permission is a runtime *dialog*. On
    // API 31/32 `SCHEDULE_EXACT_ALARM` is an app-op the user grants from a Settings
    // screen (`ACTION_REQUEST_SCHEDULE_EXACT_ALARM`, which the glue opens), and on
    // API 33+ `USE_EXACT_ALARM` is granted at install for an alarm-clock app.
    family: "exact-alarm",
    tokens: [
      "scheduler_alarm_register",
      "AlarmGlue",
      "setExactAndAllowWhileIdle",
      "canScheduleExactAlarms",
      "ACTION_REQUEST_SCHEDULE_EXACT_ALARM",
      "USE_EXACT_ALARM",
      "SCHEDULE_EXACT_ALARM",
    ],
    permissions: [
      "android.permission.SCHEDULE_EXACT_ALARM",
      "android.permission.USE_EXACT_ALARM",
    ],
    runtime: [],
    why: "AlarmManager#setExactAndAllowWhileIdle (through AlarmGlue.schedule, from scheduler_alarm_register): SCHEDULE_EXACT_ALARM (API 31/32 app-op) + USE_EXACT_ALARM (API 33+, install-time for an alarm-clock app)",
  },
  {
    // The **firing** ring (REQ-A375, closing F-TAU-012): a full-screen-intent notification is what
    // can bring an alarm to the front while the app is in the background — a `startActivity` from
    // a receiver is dropped by the Android 10+ background-activity-start rules.
    //
    // The family exists so the declaration and the call site cannot drift apart in either
    // direction: REQ-A369 deliberately did **not** declare `POST_NOTIFICATIONS` because nothing
    // posted anything (a declaration with no call site), and this entry is what makes the new call
    // site *require* the declaration. `POST_NOTIFICATIONS` is a runtime permission on API 33+, so
    // it must also be requested from Kotlin (`PermissionWire.notificationsIfNeeded`).
    family: "alarm-notification",
    tokens: [
      "notifyAlarm",
      "NotificationCompat",
      "setFullScreenIntent",
      "NotificationManagerCompat",
      "POST_NOTIFICATIONS",
      "USE_FULL_SCREEN_INTENT",
    ],
    permissions: [
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.USE_FULL_SCREEN_INTENT",
      // Measured on the device (REQ-A376): this ROM's NotificationService refuses to post the
      // full-screen-intent ring without it (`SecurityException: … has android.permission.WAKE_LOCK`).
      "android.permission.WAKE_LOCK",
    ],
    runtime: ["android.permission.POST_NOTIFICATIONS"],
    why: "NotificationManagerCompat#notify + NotificationCompat.Builder#setFullScreenIntent (through AlarmGlue.notifyAlarm, from AlarmReceiver at the alarm instant): POST_NOTIFICATIONS (runtime, API 33+ — without it the notification is silently not posted) + USE_FULL_SCREEN_INTENT (install-time for an alarm/call app)",
  },
  {
    // Location (REQ-A772, closing F-SH-228). Until this family existed, **neither** location
    // permission was declared anywhere in the tree, so `LocationManager#getLastKnownLocation`
    // threw `SecurityException` on every real device and the GNSS half of the sensor snapshot was
    // permanently empty — while this gate stayed green, because an API nobody listed is invisible
    // to it (its own honest boundary). The map has to name the API, exactly as REQ-A185 had to for
    // `WifiManager`.
    //
    // Both halves are named for the same reason as `exact-alarm`: the Rust JNI call site whose
    // permission this is (`crates/amos-sensor/src/android.rs`), and the Kotlin side that must hold
    // the grant. `runtime` is non-empty because location is a **dangerous** permission: a declared
    // location permission that is never requested is never granted, and the native
    // `LocationManager` read — unlike the WebView `getUserMedia` path — triggers no OS dialog of
    // its own, which is precisely why `LocationPermissionGlue` exists.
    //
    // `ACCESS_COARSE_LOCATION` is listed beside `ACCESS_FINE_LOCATION` deliberately: they are one
    // runtime request and one user choice ("precise" vs "approximate"), and the Rust read works
    // with either. Declaring only the fine one would make the approximate grant — the one a user is
    // most likely to give — an untracked state of the world.
    family: "location",
    tokens: [
      "getLastKnownLocation",
      "isProviderEnabled",
      "LocationPermissionGlue",
      "ACCESS_FINE_LOCATION",
      "ACCESS_COARSE_LOCATION",
    ],
    permissions: [
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_FINE_LOCATION",
    ],
    runtime: [
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_FINE_LOCATION",
    ],
    why: "LocationManager#getLastKnownLocation(\"gps\") + #isProviderEnabled(\"gps\") (crates/amos-sensor/src/android.rs, surfaced as the sensor snapshot's `gnss`): ACCESS_COARSE_LOCATION + ACCESS_FINE_LOCATION (both runtime/dangerous; without the grant the call throws SecurityException and the GNSS half of the snapshot is silently empty)",
  },
  {
    // NFC (REQ-A774, closing F-AND-006). The family exists for the same reason
    // `location` does — an API nobody listed is invisible to this gate — and until it
    // did, `NfcAdapter` was exactly that: `crates/amos-tauri/src/ble.rs` calls
    // `NfcGlue.init` / `NfcGlue.getStatus` through JNI and `NfcGlue.kt` wraps
    // `NfcAdapter` + `Ndef` for foreground dispatch and tag read/write, six Rust
    // commands and a full WebView screen on top, and **no** `android.permission.NFC`
    // was declared anywhere tracked. The only declaration in the tree was a hand-added
    // line in `crates/amos-tauri/gen/android/app/src/main/AndroidManifest.xml`, the
    // git-ignored file `cargo tauri android init` regenerates — so a clean checkout
    // built an APK whose NFC screen cannot work, and this gate stayed green.
    //
    // `runtime` is empty **and that is the point of this family**: NFC is a *normal*
    // (install-time) permission, so the declaration is the entire grant. There is no
    // dialog for a glue to post and nothing in the tree has to name the permission for
    // the feature to compile and ship — which is what makes the omission silent in a
    // way the runtime permissions (BLUETOOTH_SCAN, POST_NOTIFICATIONS, location) are
    // not. Listing the token here is therefore the *only* thing that can catch it.
    //
    // `NfcGlue` is listed as a token on purpose, beside the platform class names: the
    // Rust half names the glue class and the Kotlin half names the adapter, so both
    // ends of the chain are findable and a rewrite that moved one of them would not
    // take the family out of scope.
    family: "nfc",
    tokens: ["NfcGlue", "NfcAdapter", "enableForegroundDispatch", "Ndef"],
    permissions: ["android.permission.NFC"],
    runtime: [],
    why: "NfcAdapter (+ Ndef / per-tag TagTechnology) through NfcGlue, from the nfc_* commands in crates/amos-tauri/src/ble.rs: android.permission.NFC — a **normal** permission, so declaring it IS the grant and nothing else in the tree can be expected to name it",
  },
  {
    // Placing a real call (REQ-A1451). Two seam halves fire a call and both need the
    // same permission, so they are one family: `crates/amos-telephony/src/android.rs`
    // reaches `TelecomManager#placeCall` over JNI, and `crates/amos-tauri/src/real_dial.rs`
    // fires the public `Intent(ACTION_CALL, tel:…)` — the path a non-preloaded System-UI
    // APK can actually use before it holds `ROLE_DIALER`. Neither permission was in this
    // map, which is exactly the "an API nobody listed is invisible" boundary the location
    // and NFC families were added to close.
    //
    // `runtime` names `CALL_PHONE`: it is a **dangerous** permission, so a declared one
    // nobody requests is never granted, and the native `placeCall` / `ACTION_CALL` path
    // raises no OS dialog of its own (which is why `TelephonyGlue.requestCallPermission`
    // exists).
    family: "telephony-dial",
    tokens: ["placeCall", "ACTION_CALL", "TelecomManager", "CALL_PHONE"],
    permissions: ["android.permission.CALL_PHONE"],
    runtime: ["android.permission.CALL_PHONE"],
    why: "TelecomManager#placeCall (crates/amos-telephony/src/android.rs) + Intent(ACTION_CALL) (crates/amos-tauri/src/real_dial.rs, through TelephonyGlue): android.permission.CALL_PHONE — a runtime/dangerous permission, so it must also be requested (TelephonyGlue.requestCallPermission)",
  },
  {
    // The default-dialer / in-call service (REQ-A1451). `AmosInCallService` is the
    // component that has to bind, and once it does, three things it declares must be
    // grantable: `MANAGE_OWN_CALLS` + `READ_PHONE_STATE` drive Telecom, and the
    // foreground service it runs is typed `phoneCall`, whose
    // `FOREGROUND_SERVICE_PHONE_CALL` is mandatory on API 34+ (starting it without the
    // type's permission throws `SecurityException`).
    //
    // `runtime` is empty **and that is the point**: all four are granted together with
    // `ROLE_DIALER` when the user makes AmOS the default phone app (docs/telephony.md
    // §"ROLE_DIALER + InCallService"), so there is no dialog to post and a `runtime`
    // member here would demand one that can never appear. The tokens span both ends —
    // the Kotlin class and the tracked component fragment that declares it — because a
    // family that only saw one half would let the other disappear silently, which is how
    // F-AND-006 shipped.
    family: "telephony-in-call",
    tokens: [
      "AmosInCallService",
      "InCallService",
      "MANAGE_OWN_CALLS",
      "FOREGROUND_SERVICE_PHONE_CALL",
      "FOREGROUND_SERVICE",
    ],
    permissions: [
      "android.permission.MANAGE_OWN_CALLS",
      "android.permission.READ_PHONE_STATE",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_PHONE_CALL",
    ],
    runtime: [],
    why: "AmosInCallService (the default-dialer service, declared in AndroidManifest.components.xml with foregroundServiceType=\"phoneCall\"): MANAGE_OWN_CALLS + READ_PHONE_STATE (read live call state and answer/end through Telecom), FOREGROUND_SERVICE + FOREGROUND_SERVICE_PHONE_CALL (API 34+ refuses to start the phoneCall-typed service without them) — all install-time, granted with ROLE_DIALER",
  },
  {
    // Call recording (REQ-A1579 / F-TEL-038). `AmosInCallService.setRecording` drives a
    // real `MediaRecorder` on the active call. Two sources, one permission each:
    // `AudioSource.VOICE_COMMUNICATION` (the fallback, the near-end mic) needs only the
    // **dangerous** `RECORD_AUDIO` — already declared and runtime-requested for the
    // assistant mic — while `AudioSource.VOICE_CALL` (the mixed, two-sided stream) needs
    // `CAPTURE_AUDIO_OUTPUT`, a **signature|privileged** permission a normal install can
    // never hold. Recorded as `privileged` rather than as a runtime request: the recorder
    // checks it at runtime and falls back, so a retail build records the near end instead
    // of a dead declaration. Before this family the map knew nothing about MediaRecorder —
    // the "an API nobody listed is invisible" boundary the NFC / location / vitals
    // families were added to close.
    family: "call-recording",
    tokens: ["MediaRecorder", "setAudioSource", "VOICE_COMMUNICATION"],
    permissions: ["android.permission.RECORD_AUDIO", "android.permission.CAPTURE_AUDIO_OUTPUT"],
    privileged: ["android.permission.CAPTURE_AUDIO_OUTPUT"],
    runtime: ["android.permission.RECORD_AUDIO"],
    why: "AmosInCallService#setRecording drives MediaRecorder: AudioSource.VOICE_COMMUNICATION needs RECORD_AUDIO (dangerous ⇒ also runtime-requested); AudioSource.VOICE_CALL needs CAPTURE_AUDIO_OUTPUT (signature|privileged ⇒ never granted to a normal install; the recorder falls back when it is absent)",
  },
  {
    // Health & Fitness (REQ-A1454). The wellness pair the Health app draws — a
    // cumulative step count and a heart rate — is produced by `SensorGlue`
    // (`TYPE_STEP_COUNTER` / `TYPE_HEART_RATE`) and pushed through the JNI upcall
    // `recordVitals`. Before this family existed `SensorGlue` registered both
    // sensors and **neither** permission was declared anywhere tracked, so on a
    // real device `registerListener` threw `SecurityException` and the pair was
    // permanently absent while every gate stayed green — the same shape the NFC
    // and location families were added for (an API nobody listed is invisible).
    //
    // Both ends of the chain are named: the Rust export
    // (`Java_com_amos_ai_glue_SensorGlue_recordVitals`) and the Kotlin producer
    // (`pushVitalsSample`, which wraps the two `Sensor.TYPE_*` registrations).
    // Both permissions are **dangerous**, so `runtime` is non-empty and the
    // request must actually be present in the Kotlin glue
    // (`MainActivity.Wiring.kt`'s `activityRecognitionIfNeeded` /
    // `bodySensorsIfNeeded`) or the finding is `not-requested`: a declared
    // dangerous permission nobody asks for is never granted. The SDK floors differ
    // (Q for ACTIVITY_RECOGNITION, S for BODY_SENSORS) but the request helpers
    // encode them; this map tracks the permissions, not the floor.
    family: "vitals",
    // Tokens are the *APIs*, never the permission spellings — the tracked manifest
    // fragment is itself a scanned source, so a permission name in `tokens` would
    // let the declaration scope the family and turn the gate into a no-op the day
    // the last call site disappeared (the `nfc` family's rule).
    tokens: [
      "recordVitals",
      "TYPE_STEP_COUNTER",
      "TYPE_HEART_RATE",
      "pushVitalsSample",
    ],
    permissions: [
      "android.permission.ACTIVITY_RECOGNITION",
      "android.permission.BODY_SENSORS",
    ],
    runtime: [
      "android.permission.ACTIVITY_RECOGNITION",
      "android.permission.BODY_SENSORS",
    ],
    why: "SensorManager#registerListener for Sensor.TYPE_STEP_COUNTER / TYPE_HEART_RATE through SensorGlue (pushed via the recordVitals JNI upcall): ACTIVITY_RECOGNITION (runtime, API 29+) + BODY_SENSORS (runtime, API 31+) — both dangerous, so the declaration alone is never the grant and the glue must ask the user",
  },
  {
    // Whole-screen capture (REQ-A1582 / F-DEV-141). `ScreenRecordGlue` drives
    // `MediaProjectionManager#createScreenCaptureIntent` → `getMediaProjection` →
    // `MediaRecorder` + `VirtualDisplay`, and holds the session in a foreground service
    // typed `mediaProjection` (`ScreenRecordService`, declared in the tracked component
    // fragment).
    //
    // The permission this family exists for is `FOREGROUND_SERVICE_MEDIA_PROJECTION`, and
    // it is the same install-time shape as `FOREGROUND_SERVICE_PHONE_CALL`: it is not a
    // dialog, it is a manifest fact, and on API 34+ starting the service without it throws
    // `SecurityException`. `FOREGROUND_SERVICE` (the generic one) is listed beside it
    // because every typed service needs both.
    //
    // `runtime` is empty on purpose — nothing in this path posts a runtime dialog: the
    // screen-capture consent is an **Activity result** (`createScreenCaptureIntent` +
    // `onActivityResult`), not a permission request, and the marker notification's
    // `POST_NOTIFICATIONS` is already carried by the `alarm-notification` family.
    //
    // Tokens are the APIs (never permission spellings — the `nfc` family's rule), and they
    // name both ends: the platform classes the Kotlin calls and the service class the
    // component fragment registers, so neither half can disappear unnoticed.
    family: "screen-record",
    tokens: [
      "MediaProjectionManager",
      "createScreenCaptureIntent",
      "MediaProjection",
      "ScreenRecordService",
    ],
    permissions: [
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
    ],
    runtime: [],
    why: "MediaProjectionManager#createScreenCaptureIntent + #getMediaProjection + VirtualDisplay through ScreenRecordGlue, with the session held by ScreenRecordService (foregroundServiceType=\"mediaProjection\"): FOREGROUND_SERVICE + FOREGROUND_SERVICE_MEDIA_PROJECTION — both install-time, and API 34+ refuses to start the mediaProjection-typed service without the latter",
  },
  {
    // The system input method (REQ-A1893 / docs/input-method.md §System IME).
    // `AmosImeService : InputMethodService` is bound by the platform's own
    // `InputMethodManager` on behalf of the app the user is typing into, so the permission
    // that guards it — `BIND_INPUT_METHOD` — is what the **caller** must hold, not what
    // this app requests.
    //
    // `permissions` is therefore **empty on purpose**, and that is the decision this family
    // records: there is no `<uses-permission>` to declare here. `BIND_INPUT_METHOD` is
    // `signature|privileged`, so a normal install can never be granted it; declaring it as
    // a request would add a permission the app can never hold to the install-time list
    // (and read as a feature claim nobody can satisfy), while the *real* enforcement —
    // `android:permission="android.permission.BIND_INPUT_METHOD"` on the `<service>` — is
    // what `android-component-scan.mjs`'s K4 verifies against this same action. A
    // `runtime` member would be worse still: it would demand a dialog that cannot exist.
    //
    // Tokens name both ends of the chain (the Kotlin service class and the platform base
    // class it must derive from), because the component scan's K1/K2 are what tie
    // `AmosImeService` to the fragment; if either half disappeared, one of the two gates
    // would go red — and `android-permission-scan`'s own `ime` family would go quiet, which
    // is why the selftest pins the empty set (see `runSelftest`).
    family: "ime",
    tokens: ["InputMethodService", "AmosImeService"],
    permissions: [],
    runtime: [],
    why: "AmosImeService : InputMethodService (declared in AndroidManifest.components.xml with android:permission=\"android.permission.BIND_INPUT_METHOD\" and the action android.view.InputMethod): no <uses-permission> is required — BIND_INPUT_METHOD is the *system's* permission to bind an IME, a signature|privileged grant a normal install can never hold, so the declaration would be a request that can never be satisfied (the enforcement is the service's android:permission, checked by android-component-scan.mjs K4)",
  },
];

/** `true` when the fragment declares `permission` (any `maxSdkVersion`). */
export function declares(fragment, permission) {
  return new RegExp(`<uses-permission[^>]*android:name="${permission.replace(/\./g, "\\.")}"`).test(fragment);
}

/** Permissions the Kotlin glue actually asks the runtime for. */
export function requestedAtRuntime(kotlin) {
  return new Set(
    [...kotlin.matchAll(/Manifest\.permission\.([A-Z_]+)/g)].map((m) => `android.permission.${m[1]}`),
  );
}

/** Families whose `tokens` appear in `source`. */
export function familiesIn(source) {
  return API_FAMILIES.filter((f) => f.tokens.some((t) => source.includes(t)));
}

/** All permissions any mapped family can require (the scope of `stale`). */
const FAMILY_PERMISSIONS = new Set(API_FAMILIES.flatMap((f) => f.permissions));

/**
 * Declared permissions **inside the mapped families** that no call in this tree
 * needs — i.e. a stale radio/bluetooth declaration. Permissions outside the map
 * (CAMERA, INTERNET, SMS…) are other subsystems' business and stay unreported.
 */
export function staleDeclarations(fragment, needed) {
  return [...fragment.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((p) => FAMILY_PERMISSIONS.has(p) && !needed.has(p));
}

/** Findings for one (fragment, kotlin, sources) snapshot — pure, so it is testable. */
export function permissionFindings({ fragment, kotlin, sources }) {
  const declared = new Set(
    [...fragment.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]),
  );
  const requested = requestedAtRuntime(kotlin);
  const findings = [];
  const needed = new Set();
  for (const { file, text } of sources) {
    for (const fam of familiesIn(text)) {
      for (const p of fam.permissions) {
        needed.add(p);
        if (!declared.has(p)) {
          findings.push({ file, family: fam.family, permission: p, kind: "undeclared", why: fam.why });
        } else if (fam.runtime?.includes(p) && !requested.has(p)) {
          findings.push({ file, family: fam.family, permission: p, kind: "not-requested", why: fam.why });
        }
      }
    }
  }
  return { findings, needed, stale: staleDeclarations(fragment, needed), requested };
}

const FRAGMENT = join(root, "crates/amos-tauri/android-glue/AndroidManifest.permissions.xml");

/** `argv[1]` names this file (so the module can also be imported by a test). */
export function invokedDirectly(url, argv1) {
  return argv1 !== undefined && url.endsWith(argv1.split("/").pop());
}

// --- files ------------------------------------------------------------------
/** Strip comments so a token inside prose is not mistaken for a call. */
export function stripComments(text, ext) {
  if (ext === ".xml") return text.replace(/<!--[\s\S]*?-->/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
}

/** Our callers: Rust JNI modules (any crate) + the Kotlin/XML glue. Docs excluded. */
function callerSources() {
  const out = [];
  const walk = (dir, keep) => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (["target", "node_modules", ".git", "build"].includes(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p, keep);
      else if (keep(p)) {
        const ext = p.slice(p.lastIndexOf("."));
        out.push({
          file: p.slice(root.length + 1),
          text: stripComments(readFileSync(p, "utf8"), ext),
        });
      }
    }
  };
  walk(join(root, "crates"), (p) => p.endsWith(".rs") && !/\/(tests|examples)\//.test(p));
  walk(join(root, "crates/amos-tauri/android-glue"), (p) => p.endsWith(".kt") || p.endsWith(".xml"));
  return out;
}

/** Every Kotlin glue file's text, concatenated (the runtime-request corpus). */
export function kotlinGlueText() {
  const out = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (p.endsWith(".kt")) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(join(root, "crates/amos-tauri/android-glue"));
  return out.join("\n");
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const fragment = [
    '<uses-permission android:name="android.permission.CAMERA" />',
    '<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />',
    '<uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />',
    '<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />',
  ].join("\n");
  const kotlin = "ActivityCompat.requestPermissions(a, arrayOf(Manifest.permission.BLUETOOTH_CONNECT), 1)";
  const wifiCall = {
    file: "crates/amos-radio/src/android.rs",
    text: 'env.call_method(&m, "setWifiEnabled", "(Z)Z", &[])',
  };

  const okCase = permissionFindings({ fragment, kotlin, sources: [wifiCall] });
  ok("a declared permission produces no finding", okCase.findings.length === 0);
  ok("the family's permissions are collected", okCase.needed.has("android.permission.CHANGE_WIFI_STATE"));

  const missing = permissionFindings({
    fragment: '<uses-permission android:name="android.permission.CAMERA" />',
    kotlin,
    sources: [wifiCall],
  });
  ok(
    "an undeclared permission is a finding",
    missing.findings.some((f) => f.kind === "undeclared" && f.permission === "android.permission.CHANGE_WIFI_STATE"),
  );

  const notRequested = permissionFindings({
    fragment: '<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />',
    kotlin: "// nothing requests it",
    sources: [
      {
        file: "crates/amos-radio/src/android.rs",
        // The adapter class descriptor is what identifies the family (the method
        // name `enable`/`disable` is computed at the call site).
        text: 'env.call_method(&mgr, "getAdapter", "()Landroid/bluetooth/BluetoothAdapter;", &[])',
      },
    ],
  });
  ok("a runtime permission nobody requests is a finding", notRequested.findings.some((f) => f.kind === "not-requested"));

  const unrelated = permissionFindings({
    fragment: "",
    kotlin: "",
    sources: [{ file: "crates/amos-ai/src/lib.rs", text: "fn pure() {}" }],
  });
  ok("a file with no mapped call needs nothing", unrelated.findings.length === 0);

  ok("familiesIn finds Wi-Fi state", familiesIn('"isWifiEnabled"').some((f) => f.family === "wifi-state"));
  ok("familiesIn finds tethering", familiesIn("TetheringManager").some((f) => f.family === "tethering"));
  // REQ-A369: the exact-alarm family must be findable from **both** ends — the Rust command
  // that schedules and the Kotlin API that needs the permission. A gate that only saw one of
  // them would let the other half disappear silently (that is how F-TAU-007 shipped).
  ok("familiesIn finds exact alarms from the Rust command name", familiesIn("scheduler_alarm_register").some((f) => f.family === "exact-alarm"));
  ok("familiesIn finds exact alarms from the Kotlin API", familiesIn("am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pending(context, id))").some((f) => f.family === "exact-alarm"));
  // REQ-A375: the firing ring. `POST_NOTIFICATIONS` is the one permission whose *absence* is
  // silent (the notification is simply not posted), so the family must be found from the call site
  // and must demand the runtime request too.
  ok("familiesIn finds the firing notification from the call site", familiesIn("NotificationCompat.Builder(context, ALARM_CHANNEL)").some((f) => f.family === "alarm-notification"));
  ok(
    "a declared-but-unrequested POST_NOTIFICATIONS is found",
    permissionFindings({
      fragment:
        '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />' +
        '<uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT" />',
      kotlin: "// nothing asks the user for it",
      sources: [{ file: "crates/amos-tauri/android-glue/com/amos/ai/glue/AlarmReceiver.kt", text: "AlarmGlue.notifyAlarm(ctx, id, atMs)" }],
    }).findings.some((f) => f.kind === "not-requested" && f.permission === "android.permission.POST_NOTIFICATIONS"),
  );
  ok(
    "an undeclared USE_FULL_SCREEN_INTENT is a finding",
    permissionFindings({
      fragment: '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
      kotlin: "Manifest.permission.POST_NOTIFICATIONS",
      sources: [{ file: "crates/amos-tauri/android-glue/com/amos/ai/glue/AlarmGlue.kt", text: ".setFullScreenIntent(show, true)" }],
    }).findings.some((f) => f.kind === "undeclared" && f.permission === "android.permission.USE_FULL_SCREEN_INTENT"),
  );
  ok(
    "a missing exact-alarm declaration is a finding",
    permissionFindings({
      fragment: '<uses-permission android:name="android.permission.CAMERA" />',
      kotlin: "AlarmGlue",
      sources: [{ file: "crates/amos-tauri/src/alarm_sched.rs", text: 'call_static_method("com/amos/ai/glue/AlarmGlue", "schedule"' }],
    }).findings.some((f) => f.kind === "undeclared" && f.permission === "android.permission.USE_EXACT_ALARM"),
  );
  ok(
    "a declared family permission nobody needs is stale (informational)",
    staleDeclarations('<uses-permission android:name="android.permission.BLUETOOTH" />', new Set()).length === 1,
  );
  ok(
    "a declared permission outside the map is not stale",
    staleDeclarations('<uses-permission android:name="android.permission.CAMERA" />', new Set()).length === 0,
  );
  ok(
    "declares() matches the exact name",
    declares(fragment, "android.permission.ACCESS_WIFI_STATE") &&
      !declares(fragment, "android.permission.ACCESS_WIFI_STATEX"),
  );

  // REQ-A772: the location family. This defect was the reverse of the usual one — the permission
  // was declared *nowhere* and no Kotlin ever asked for it — so both halves of the finding have to
  // be provable independently, and both ends of the family have to be findable (the Rust JNI
  // method literal, and the Kotlin glue class), or one half could disappear silently.
  const locationCall = {
    file: "crates/amos-sensor/src/android.rs",
    text: 'env.call_method(&mgr, "getLastKnownLocation", "(Ljava/lang/String;)Landroid/location/Location;", &[])',
  };
  ok(
    "familiesIn finds location from the Rust JNI method literal",
    familiesIn(locationCall.text).some((f) => f.family === "location"),
  );
  ok(
    "familiesIn finds location from the Kotlin glue class",
    familiesIn("LocationPermissionGlue.request()").some((f) => f.family === "location"),
  );
  ok(
    "an undeclared ACCESS_FINE_LOCATION is a finding",
    permissionFindings({
      fragment: '<uses-permission android:name="android.permission.CAMERA" />',
      kotlin: "LocationPermissionGlue",
      sources: [locationCall],
    }).findings.some((f) => f.kind === "undeclared" && f.permission === "android.permission.ACCESS_FINE_LOCATION"),
  );
  ok(
    "a declared-but-unrequested location permission is a finding",
    permissionFindings({
      fragment:
        '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />' +
        '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
      kotlin: "// the glue never asks the user for it",
      sources: [locationCall],
    }).findings.some((f) => f.kind === "not-requested" && f.permission === "android.permission.ACCESS_FINE_LOCATION"),
  );

  // REQ-A774: the NFC family. Its whole reason to exist is that the permission is
  // **normal**, so nothing in the tree has to name it and nothing ever went red — a
  // family is the only instrument that can. Both ends must be findable (the Rust glue
  // class literal `bles.rs` calls through, and the Kotlin adapter the glue wraps), and
  // the finding has to be `undeclared` with an **empty** runtime set: if `runtime` ever
  // gained a member, this gate would start demanding a dialog NFC does not have and the
  // "fix" would be to add one that can never appear.
  ok(
    "familiesIn finds NFC from the Rust glue-class literal",
    familiesIn('pub const NFC_CLASS: &str = "com/amos/ai/glue/NfcGlue";').some((f) => f.family === "nfc"),
  );
  ok(
    "familiesIn finds NFC from the Kotlin adapter",
    familiesIn("nfcAdapter = NfcAdapter.getDefaultAdapter(context)").some((f) => f.family === "nfc"),
  );
  ok(
    "an undeclared android.permission.NFC is a finding",
    permissionFindings({
      fragment: '<uses-permission android:name="android.permission.CAMERA" />',
      kotlin: "NfcGlue",
      sources: [
        {
          file: "crates/amos-tauri/src/ble.rs",
          // The literal the Rust half actually carries. Spelled out here rather than
          // paraphrased: the first version of this fixture used the *constant name*
          // (`android_jni::NFC_CLASS`), which matches no token, and the assertion below
          // went red for the right reason while being written.
          text: 'env.call_static_method("com/amos/ai/glue/NfcGlue", "getStatus", "()Ljava/lang/String;", &args)',
        },
      ],
    }).findings.some((f) => f.kind === "undeclared" && f.permission === "android.permission.NFC"),
  );
  ok(
    "the NFC family never demands a runtime request (it is a normal permission)",
    familiesIn("NfcAdapter").every((f) => f.family !== "nfc" || f.runtime.length === 0),
  );
  ok(
    "a declared NFC permission is not stale once the calls are in the tree",
    staleDeclarations(
      '<uses-permission android:name="android.permission.NFC" />',
      new Set(["android.permission.NFC"]),
    ).length === 0,
  );

  // REQ-A1451: the telephony families. Both halves of placing a call (the JNI
  // `placeCall` and the public `ACTION_CALL` intent) and both ends of the in-call
  // service (the Kotlin class, the tracked component fragment) must be findable, or one
  // half of each contract can disappear without a finding — the exact shape the
  // location and NFC families exist to prevent.
  ok(
    "familiesIn finds the dial family from the Rust JNI method literal",
    familiesIn('"placeCall"').some((f) => f.family === "telephony-dial"),
  );
  ok(
    "familiesIn finds the dial family from the public ACTION_CALL path",
    familiesIn('const ACTION_CALL: &str = "android.intent.action.CALL";').some(
      (f) => f.family === "telephony-dial",
    ),
  );
  ok(
    "familiesIn finds the dial family from the Kotlin runtime request",
    familiesIn("Manifest.permission.CALL_PHONE").some((f) => f.family === "telephony-dial"),
  );
  ok(
    "an undeclared CALL_PHONE is a finding",
    permissionFindings({
      fragment: '<uses-permission android:name="android.permission.CAMERA" />',
      kotlin: "TelephonyGlue",
      sources: [
        {
          file: "crates/amos-telephony/src/android.rs",
          text: 'env.call_method(&tm, "placeCall", "(Landroid/net/Uri;Landroid/os/Bundle;)V", &args)',
        },
      ],
    }).findings.some((f) => f.kind === "undeclared" && f.permission === "android.permission.CALL_PHONE"),
  );
  ok(
    "a declared-but-unrequested CALL_PHONE is a finding",
    permissionFindings({
      fragment: '<uses-permission android:name="android.permission.CALL_PHONE" />',
      kotlin: "// nothing asks the user for it",
      sources: [{ file: "crates/amos-telephony/src/android.rs", text: '"placeCall"' }],
    }).findings.some((f) => f.kind === "not-requested" && f.permission === "android.permission.CALL_PHONE"),
  );
  ok(
    "familiesIn finds the in-call family from the Kotlin service class",
    familiesIn("class AmosInCallService : InCallService() {").some(
      (f) => f.family === "telephony-in-call",
    ),
  );
  ok(
    "an undeclared FOREGROUND_SERVICE_PHONE_CALL is a finding",
    permissionFindings({
      fragment: '<uses-permission android:name="android.permission.CAMERA" />',
      kotlin: "AmosInCallService",
      sources: [
        {
          file: "crates/amos-tauri/android-glue/com/amos/ai/glue/AmosInCallService.kt",
          text: "class AmosInCallService : InCallService() {",

        },
      ],
    }).findings.some(
      (f) => f.kind === "undeclared" && f.permission === "android.permission.FOREGROUND_SERVICE_PHONE_CALL",
    ),
  );
  // The in-call permissions are granted with ROLE_DIALER, not by a dialog: a `runtime`
  // member here would demand a request that can never appear, and the "fix" would be to
  // add one.
  ok(
    "the in-call family never demands a runtime request (granted with ROLE_DIALER)",
    familiesIn("AmosInCallService").every((f) => f.family !== "telephony-in-call" || f.runtime.length === 0),
  );

  // REQ-A1454: the vitals family. Both ends of the chain must be findable — the Rust
  // export the JNI upcall lands on, and the Kotlin producer that registers the two
  // sensors — or one half can disappear silently, which is how the pair shipped with no
  // permission declared at all. Both permissions are dangerous, so a declared one nobody
  // requests must be a finding; the tokens deliberately exclude the permission spellings
  // (the tracked fragment is a scanned source, so including them would let the
  // declaration scope the family and neuter the gate).
  ok(
    "familiesIn finds the vitals family from the Rust JNI export",
    familiesIn("Java_com_amos_ai_glue_SensorGlue_recordVitals").some((f) => f.family === "vitals"),
  );
  ok(
    "familiesIn finds the vitals family from the Kotlin producer",
    familiesIn("sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)").some((f) => f.family === "vitals"),
  );
  ok(
    "the vitals tokens never include the permission spellings",
    familiesIn('<uses-permission android:name="android.permission.ACTIVITY_RECOGNITION" />').every(
      (f) => f.family !== "vitals",
    ),
  );
  ok(
    "an undeclared ACTIVITY_RECOGNITION is a finding",
    permissionFindings({
      fragment: '<uses-permission android:name="android.permission.CAMERA" />',
      kotlin: "SensorGlue",
      sources: [
        {
          file: "crates/amos-tauri/android-glue/com/amos/ai/glue/SensorGlue.kt",
          text: "sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)?.let { sm.registerListener(this, it, SAMPLING_PERIOD_US) }",
        },
      ],
    }).findings.some((f) => f.kind === "undeclared" && f.permission === "android.permission.ACTIVITY_RECOGNITION"),
  );
  ok(
    "a declared-but-unrequested BODY_SENSORS is a finding",
    permissionFindings({
      fragment:
        '<uses-permission android:name="android.permission.ACTIVITY_RECOGNITION" />' +
        '<uses-permission android:name="android.permission.BODY_SENSORS" />',
      kotlin: "// the glue never asks the user",
      sources: [{ file: "crates/amos-tauri/src/android_glue.rs", text: "SensorGlue_recordVitals" }],
    }).findings.some((f) => f.kind === "not-requested" && f.permission === "android.permission.BODY_SENSORS"),
  );

  // REQ-A1893: the IME family. Its `permissions` set is **empty on purpose**
  // (`BIND_INPUT_METHOD` is the *caller's* — the platform's — permission, never a
  // `<uses-permission>` we can hold), which makes the family inert in the scan itself.
  // A family that can never produce a finding is one refactor away from being a family
  // whose tokens silently stop matching anything — so the selftest is the only place that
  // can hold it: both ends of the chain must be findable (the Kotlin service class derives
  // from `InputMethodService`, and the tracked fragment names the class), and the empty
  // sets must stay empty. If `permissions` ever gained `BIND_INPUT_METHOD`, the gate would
  // demand a declaration the app can never be granted; if `runtime` gained anything, it
  // would demand a dialog that cannot exist.
  ok(
    "familiesIn finds the IME family from the Kotlin service base class",
    familiesIn("class AmosImeService : InputMethodService() {").some((f) => f.family === "ime"),
  );
  ok(
    "familiesIn finds the IME family from the component fragment's class name",
    familiesIn('android:name="com.amos.ai.glue.AmosImeService"').some((f) => f.family === "ime"),
  );
  ok(
    "the IME family's permissions set stays empty (BIND_INPUT_METHOD is the caller's)",
    familiesIn("AmosImeService").every((f) => f.family !== "ime" || f.permissions.length === 0),
  );
  ok(
    "the IME family never demands a runtime request",
    familiesIn("AmosImeService").every((f) => f.family !== "ime" || f.runtime.length === 0),
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[android-permission-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[android-permission-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}


// --- scan -------------------------------------------------------------------
function runScan() {
  const fragment = existsSync(FRAGMENT) ? readFileSync(FRAGMENT, "utf8") : "";
  const { findings, needed, stale, requested } = permissionFindings({
    fragment,
    kotlin: kotlinGlueText(),
    sources: callerSources(),
  });
  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          families: API_FAMILIES.length,
          needed: [...needed].sort(),
          requested: [...requested].sort(),
          stale,
          findings,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[android-permission-scan] ${API_FAMILIES.length} mapped platform API family(ies); ` +
        `${needed.size} permission(s) required by the calls in this tree; ${requested.size} requested at runtime.`,
    );
    for (const f of findings) {
      const what =
        f.kind === "undeclared"
          ? "not declared in AndroidManifest.permissions.xml"
          : "declared yet never requested at runtime";
      console.error(
        `[android-permission-scan] FAIL — ${f.file} calls the ${f.family} path but ${f.permission} is ${what} (${f.why})`,
      );
    }
    if (stale.length > 0) {
      console.log(
        `[android-permission-scan] note — declared but unused by any mapped call: ${stale.sort().join(", ")}`,
      );
    }
    if (findings.length === 0) {
      console.log(
        "[android-permission-scan] OK — every platform call this tree makes has its permission declared (and requested, if runtime).",
      );
    }
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();
if (IS_ENTRY && !process.argv.includes("--selftest")) runScan();

