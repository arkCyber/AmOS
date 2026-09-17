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

