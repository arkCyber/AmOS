#!/usr/bin/env node
/**
 * android-component-scan.mjs — "the manifest names a component the app does not have".
 *
 * Why: `crates/amos-tauri/android-glue/AndroidManifest.components.xml` is a **tracked**
 * fragment whose `<service>`/`<receiver>` entries are the only reason three features exist
 * on device at all (the file itself records the finding: before it was tracked, a clean
 * checkout produced an APK where the Kotlin was compiled in but **nothing bound it** — no
 * in-call UI, no call screening, no live SMS). REQ-A369 later added the alarm receiver.
 *
 * Every one of those entries is a **name the platform resolves at instantiation time**:
 * Android reads `android:name`, finds that class in the APK, and instantiates it. If the
 * name does not match a class (a typo, or the Kotlin class was renamed), nothing fails to
 * build and nothing crashes at start-up — the component simply **never runs**:
 *
 *   * a wrong `AlarmReceiver` ⇒ the alarm fires and *nothing happens* (the F-TAU-007
 *     symptom, on the other side of the same seam);
 *   * a wrong `SmsReceiver` ⇒ SMS only arrives while the app happens to be running;
 *   * a wrong `AmosInCallService` ⇒ no in-call UI, and no error anywhere.
 *
 * What already existed: `scripts/android-glue-mirror.sh` checks that the *generated*
 * manifest (git-ignored `gen/`) contains every `android:name` this fragment declares —
 * i.e. the two **files** agree. That comparison passes just as happily when both spell the
 * same **wrong** name; nothing looked at the Kotlin side. This gate does:
 *
 *   K1 (fragment → Kotlin): every `<service>`/`<receiver>` name resolves to a class the
 *      tracked glue tree declares, and the class is of the right **kind** (a `<receiver>`
 *      must derive from `BroadcastReceiver`, a `<service>` from `Service` or one of its
 *      platform subclasses).
 *   K2 (Kotlin → fragment, the reverse): a top-level glue class that derives from a
 *      component kind must be declared in the fragment — otherwise the platform can never
 *      instantiate it (the class ships, the feature does not).
 *   K3 (`System.loadLibrary` → the crate that builds the .so): the library name Kotlin
 *      loads must be the `[lib] name` (or package name with `-`→`_`) of a workspace crate
 *      that actually builds it — a rename there is an `UnsatisfiedLinkError` at class init.
 *   K4 (the names *inside* a declaration): the `<action>` that reaches a component must be
 *      a platform action from the closed `PLATFORM_ACTIONS` table, must be delivered to
 *      that kind of component, and — for a protected broadcast — the **sender permission**
 *      the platform requires must be declared on it. `SMS_RECEIVED` without
 *      `BROADCAST_SMS` on an exported receiver is the security half of the same defect:
 *      any app could inject the broadcast.
 *
 * Honest scope:
 *   * `<activity>`/`<provider>` are not judged: the Activity is machine-owned (Tauri
 *     generates it) and the fragment has none; an entry outside the app namespace
 *     (`androidx.work.…`) is reported, never judged — this repo does not own that class.
 *   * Kind checking reads the **declared supertype** textually (one class per file, the
 *     repo's glue convention). An intermediate base class of our own is "cannot tell", and
 *     that is a finding with an allow-list escape (`scripts/android-component-allowlist.json`)
 *     rather than a pass.
 *   * K2 only knows the fragment it is pointed at; a component registered from a *different*
 *     manifest still needs an allow-list entry with a reason.
 *   * `PLATFORM_ACTIONS` is **closed**: an action nobody listed FAILS, because "unknown" and
 *     "misspelled" look identical from here. Extending it is a deliberate edit that records
 *     the sender permission — not a guess. `<meta-data>` names have no such table and are
 *     reported only.
 *
 * Usage (from the repo root):
 *   node scripts/android-component-scan.mjs              # gate
 *   node scripts/android-component-scan.mjs --json       # machine-readable
 *   node scripts/android-component-scan.mjs --selftest   # pin the parsers/classifier
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRAGMENT = "crates/amos-tauri/android-glue/AndroidManifest.components.xml";
const CONF = "crates/amos-tauri/tauri.conf.json";
const ALLOWLIST = join(root, "scripts", "android-component-allowlist.json");

/** Android kinds this gate can judge, by the class a component must derive from. */
export const SERVICE_KINDS = [
  "Service",
  "InCallService",
  "CallScreeningService",
  "NotificationListenerService",
  "JobService",
  "MediaBrowserService",
  "MediaBrowserServiceCompat",
  "MediaSessionService",
  "InputMethodService",
  "AccessibilityService",
  "TileService",
  "VpnService",
  "WallpaperService",
  "PrintService",
  "CompanionDeviceService",
  "LifecycleService",
];
export const RECEIVER_KINDS = [
  "BroadcastReceiver",
  "WakefulBroadcastReceiver",
  "DeviceAdminReceiver",
  "AppWidgetProvider",
  "ResultReceiver",
];

/**
 * The **platform names a component declaration contains**, and what each one requires.
 *
 * A component is resolved by the platform through *three* strings, not one: the class name
 * (`<service android:name>`), the action that reaches it, and — for a broadcast the platform
 * protects — the permission the **sender** must hold. A typo in any of them leaves a
 * component that builds, installs, and never runs; and a *missing* sender permission on an
 * **exported** receiver means anyone can inject the broadcast (that is exactly why
 * `SmsReceiver` requires `BROADCAST_SMS` — the fragment's own comment says so).
 *
 * This table is **closed on purpose**: an action it does not list FAILS, so adding a new
 * platform action is a deliberate edit with its sender-permission recorded — a decision, not
 * a guess. (Confirmed against the platform: `InCallService`/`CallScreeningService` are bound
 * only by Telecom and require `BIND_INCALL_SERVICE`/`BIND_SCREENING_SERVICE` from the app;
 * `SMS_RECEIVED` is a protected broadcast requiring `BROADCAST_SMS` from the sender.)
 */
export const PLATFORM_ACTIONS = {
  "android.telecom.InCallService": { who: "service", sender: "android.permission.BIND_INCALL_SERVICE" },
  "android.telecom.CallScreeningService": { who: "service", sender: "android.permission.BIND_SCREENING_SERVICE" },
  "android.provider.Telephony.SMS_RECEIVED": { who: "receiver", sender: "android.permission.BROADCAST_SMS" },
  "android.service.notification.NotificationListenerService": {
    who: "service",
    sender: "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE",
  },
  "android.accessibilityservice.AccessibilityService": {
    who: "service",
    sender: "android.permission.BIND_ACCESSIBILITY_SERVICE",
  },
  "android.app.action.DEVICE_ADMIN_ENABLED": { who: "receiver", sender: "android.permission.BIND_DEVICE_ADMIN" },
  "android.intent.action.BOOT_COMPLETED": { who: "receiver", sender: null },
  "android.intent.action.LOCKED_BOOT_COMPLETED": { who: "receiver", sender: null },
  "android.intent.action.MY_PACKAGE_REPLACED": { who: "receiver", sender: null },
  "android.intent.action.USER_UNLOCKED": { who: "receiver", sender: null },
  "android.net.conn.CONNECTIVITY_CHANGE": { who: "receiver", sender: null },
  "android.media.browse.MediaBrowserService": { who: "service", sender: null },
  "android.media.MediaBrowserService": { who: "service", sender: null },
};

/** `argv[1]` names this file (so the module can also be imported by a test). */
export function invokedDirectly(url, argv1) {
  return argv1 !== undefined && url.endsWith(argv1.split("/").pop());
}

// --- parsers ----------------------------------------------------------------

/** XML with `<!-- … -->` blanked (offsets and line numbers preserved). */
export function stripXmlComments(xml) {
  const out = [...xml];
  let i = 0;
  while (i < xml.length) {
    if (xml[i] === "<" && xml[i + 1] === "!") {
      while (i < xml.length && !(xml[i] === "-" && xml[i + 1] === "-" && xml[i + 2] === ">")) {
        if (xml[i] !== "\n") out[i] = " ";
        i += 1;
      }
      for (let k = 0; k < 3 && i < xml.length; k++) out[i++] = " ";
    } else {
      i += 1;
    }
  }
  return out.join("");
}

function lineOf(src, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

/** The attribute value of `android:name` in a tag's attribute text. */
export function androidName(attrs) {
  const m = /android:name\s*=\s*"([^"]*)"/.exec(attrs);
  return m ? m[1] : null;
}

/**
 * The `<service>`/`<receiver>` entries of a manifest fragment, in document order.
 * Commented-out entries are **not** components (the fragment documents the manifest inside
 * comments, including example names — reading those as declarations was the first thing
 * this parser would have got wrong).
 */
export function componentDeclarations(xml) {
  const code = stripXmlComments(xml);
  const out = [];
  const re = /<(service|receiver|provider|activity)\b([^>]*?)(\/>|>)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const kind = m[1];
    const attrs = m[2];
    const selfClosing = m[3] === "/>";
    let body = "";
    if (!selfClosing) {
      const close = code.indexOf(`</${kind}>`, re.lastIndex);
      if (close > 0) body = code.slice(re.lastIndex, close);
    }
    const inner = (re2, what) =>
      [...body.matchAll(re2)].map((a) => ({
        name: a[1],
        line: lineOf(code, re.lastIndex + a.index),
      }));
    out.push({
      kind,
      name: androidName(attrs),
      permission: /android:permission\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? null,
      exported: /android:exported\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? null,
      actions: inner(/<action\b[^>]*android:name\s*=\s*"([^"]*)"/g),
      metaData: inner(/<meta-data\b[^>]*android:name\s*=\s*"([^"]*)"/g),
      line: lineOf(code, m.index),
    });
  }
  return out;
}

/**
 * A component `android:name` resolved against the app namespace.
 *
 * Android accepts the relative form (`.glue.AlarmReceiver`), which resolves against the
 * app's `applicationId`/package — read from `tauri.conf.json`'s `identifier` here, so the
 * two cannot drift apart silently.
 */
export function resolveComponentName(name, namespace) {
  if (!name) return null;
  if (name.startsWith(".")) return `${namespace}${name}`;
  return name;
}

/**
 * The `class`/`object` declarations of a Kotlin source with their **declared supertype**
 * (`class AlarmReceiver : BroadcastReceiver() {` → `BroadcastReceiver`), or `null` when the
 * declaration names none. One class per file is the repo's glue convention; generic
 * supertypes are stripped to the base name.
 */
export function kotlinClasses(src) {
  const out = [];
  src.split("\n").forEach((line, i) => {
    const m =
      /^[ \t]*(?:(?:public|internal|open|abstract|private|protected|sealed|data|value|annotation)\s+)*(class|object)\s+([A-Za-z_]\w*)/.exec(
        line,
      );
    if (!m) return;
    let rest = line.slice(m[0].length);
    // Skip the primary constructor before looking for `: Supertype`.
    if (rest.trimStart().startsWith("(")) {
      let depth = 0;
      let i2 = 0;
      for (; i2 < rest.length; i2++) {
        if (rest[i2] === "(") depth++;
        else if (rest[i2] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      rest = rest.slice(i2 + 1);
    }
    const sup = /:\s*([A-Za-z_][\w.]*)/.exec(rest);
    out.push({ name: m[2], kind: m[1], supertype: sup ? sup[1].split(".").pop() : null, line: i + 1 });
  });
  return out;
}

/** Every `System.loadLibrary("<name>")` in a Kotlin source. */
export function libraryLoads(src) {
  const out = [];
  src.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/System\.loadLibrary\(\s*"([^"]+)"\s*\)/g)) {
      out.push({ library: m[1], line: i + 1 });
    }
  });
  return out;
}

/** Cargo's rule: a library name is the package name with `-` → `_` unless `[lib] name` says otherwise. */
export function cargoLibNames(cargoToml) {
  const pkg = /^name\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1] ?? null;
  const libSection = /\[lib\]([\s\S]*?)(?:\n\[|$)/.exec(cargoToml)?.[1] ?? null;
  const libName = libSection ? (/name\s*=\s*"([^"]+)"/.exec(libSection)?.[1] ?? null) : null;
  const crates = [];
  if (pkg) crates.push(pkg.replace(/-/g, "_"));
  if (libName && !crates.includes(libName)) crates.push(libName);
  return { package: pkg, lib: libName, names: crates };
}


// --- the checks -------------------------------------------------------------

/**
 * K1 + K2: the fragment's components must exist (with the right kind) in the Kotlin tree,
 * and a component-kind class in that tree must be declared in the fragment.
 *
 * `classes` is `[{name, file, supertype, line}]` over the tracked glue tree.
 */
export function checkComponents(fragmentXml, namespace, classes) {
  const findings = [];
  const reports = [];
  const checked = [];
  const byName = new Map(classes.map((c) => [c.name, c]));
  const declared = new Map(); // class name -> {kind, line}
  for (const decl of componentDeclarations(fragmentXml)) {
    if (decl.kind !== "service" && decl.kind !== "receiver") {
      reports.push({
        kind: "unjudged-element",
        site: `<${decl.kind}${decl.name ? ` android:name="${decl.name}"` : ""}>`,
        detail: `this gate judges <service>/<receiver> only (line ${decl.line})`,
      });
      continue;
    }
    const resolved = resolveComponentName(decl.name, namespace);
    if (!decl.name) {
      findings.push({
        kind: "nameless-component",
        file: FRAGMENT,
        line: decl.line,
        site: `<${decl.kind}>`,
        detail: "a component without android:name cannot be instantiated by the platform",
      });
      continue;
    }
    if (!resolved.startsWith(`${namespace}.`)) {
      reports.push({
        kind: "foreign-component",
        site: `${decl.kind} ${resolved}`,
        detail: "outside this app's namespace — a library class this repo does not own",
      });
      continue;
    }
    const local = resolved.slice(namespace.length + 1).split(".");
    const cls = local[local.length - 1];
    declared.set(cls, { kind: decl.kind, line: decl.line });
    const entry = byName.get(cls);
    if (!entry) {
      findings.push({
        kind: "missing-kotlin-class",
        file: FRAGMENT,
        line: decl.line,
        site: `<${decl.kind} android:name="${decl.name}">`,
        detail: `no tracked Kotlin glue class \`${cls}\` exists — the platform instantiates nothing (the feature is silently dead on device)`,
      });
      continue;
    }
    const allowed = decl.kind === "receiver" ? RECEIVER_KINDS : SERVICE_KINDS;
    if (!entry.supertype) {
      findings.push({
        kind: "unknown-kind",
        file: FRAGMENT,
        line: decl.line,
        site: `<${decl.kind} android:name="${decl.name}">`,
        detail: `${entry.file}:${entry.line} declares \`${cls}\` without a supertype this gate can read — it cannot tell whether the platform can instantiate it`,
      });
      continue;
    }
    if (!allowed.includes(entry.supertype)) {
      findings.push({
        kind: "wrong-kind",
        file: FRAGMENT,
        line: decl.line,
        site: `<${decl.kind} android:name="${decl.name}">`,
        detail: `${entry.file}:${entry.line} declares \`${cls} : ${entry.supertype}()\`, which is not a ${decl.kind === "receiver" ? "BroadcastReceiver" : "Service"}`,
      });
      continue;
    }
    checked.push({ cls, kind: decl.kind, supertype: entry.supertype, file: entry.file });
  }
  for (const entry of classes) {
    if (declared.has(entry.name)) continue;
    const kind = RECEIVER_KINDS.includes(entry.supertype)
      ? "receiver"
      : SERVICE_KINDS.includes(entry.supertype)
        ? "service"
        : null;
    if (!kind) continue;
    findings.push({
      kind: "unregistered-component",
      file: entry.file,
      line: entry.line,
      site: `class ${entry.name} : ${entry.supertype}()`,
      detail: `a ${kind}-kind class that ${FRAGMENT} never registers — the platform can never instantiate it, so it ships dead (allow-list it with a reason if another manifest registers it)`,
    });
  }
  return { findings, reports, checked };
}

/**
 * K4: the platform names *inside* a component declaration — the action that reaches it and
 * the permission the **sender** must hold.
 *
 * Closed table (see `PLATFORM_ACTIONS`): an unknown action FAILS, because "unknown" and
 * "misspelled" are indistinguishable from here, and a misspelling is a component that never
 * runs. A known action whose required sender permission is absent from an **exported**
 * component is the security half of the same defect: the platform protects that broadcast
 * so third-party apps cannot inject it, and dropping the requirement hands that ability back.
 */
export function checkComponentContract(details) {
  const findings = [];
  const reports = [];
  const checked = [];
  for (const d of details) {
    if (d.kind !== "service" && d.kind !== "receiver") continue;
    const where = `<${d.kind} android:name="${d.name ?? "?"}">`;
    const expected = [];
    for (const action of d.actions) {
      const spec = PLATFORM_ACTIONS[action.name];
      if (!spec) {
        findings.push({
          kind: "unknown-action",
          file: FRAGMENT,
          line: action.line,
          site: `<action android:name="${action.name}">`,
          detail:
            `not a platform action this gate knows (in ${where}) — a misspelled action is a component that never runs; ` +
            `if it is legitimate, add it to PLATFORM_ACTIONS with the sender permission the platform requires`,
        });
        continue;
      }
      if (spec.who !== d.kind) {
        findings.push({
          kind: "action-kind-mismatch",
          file: FRAGMENT,
          line: action.line,
          site: `<action android:name="${action.name}">`,
          detail: `${action.name} is delivered to a <${spec.who}>, not to a <${d.kind}> — ${d.name ?? "this component"} can never receive it`,
        });
        continue;
      }
      if (spec.sender) expected.push(spec.sender);
      if (expected.length === 0) {
        checked.push({ component: d.name ?? where, action: action.name, sender: null });
        continue;
      }
      if (d.permission === spec.sender) {
        checked.push({ component: d.name ?? where, action: action.name, sender: spec.sender });
      } else {
        findings.push({
          kind: d.permission ? "wrong-sender-permission" : "missing-sender-permission",
          file: FRAGMENT,
          line: d.line,
          site: where,
          detail: d.permission
            ? `${action.name} is protected by ${spec.sender}, but this component requires ${d.permission} from its sender`
            : `${action.name} is a protected broadcast: without android:permission="${spec.sender}" any app can inject it into this exported receiver`,
        });
      }
    }
    if (d.permission && expected.length === 0 && d.actions.length > 0) {
      reports.push({
        kind: "sender-permission-not-in-table",
        site: where,
        detail: `declares sender permission ${d.permission}, which no action here requires — deliberate hardening, or a leftover`,
      });
    }
    for (const meta of d.metaData) {
      reports.push({
        kind: "unjudged-meta-data",
        site: `<meta-data android:name="${meta.name}">`,
        detail: "no consequence table for meta-data names (reported, not judged)",
      });
    }
  }
  return { findings, reports, checked };
}

/** K3: every `System.loadLibrary` name must be built by a workspace crate. */
export function checkLibraryLoads(sources, workspaceLibs) {
  const findings = [];
  const checked = [];
  for (const { file, text } of sources) {
    for (const load of libraryLoads(text)) {
      const owner = workspaceLibs.find((c) => c.names.includes(load.library));
      if (owner) checked.push({ file, line: load.line, library: load.library, crate: owner.path });
      else {
        findings.push({
          kind: "unknown-library",
          file,
          line: load.line,
          site: `System.loadLibrary("${load.library}")`,
          detail: `no workspace crate builds a library named ${load.library} — class init throws UnsatisfiedLinkError`,
        });
      }
    }
  }
  return { findings, checked };
}


// --- selftest ---------------------------------------------------------------

export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);
  const NS = "com.amos.ai";

  const xml = [
    '<!-- <receiver android:name=".glue.GhostReceiver" /> -->',
    "<manifest>",
    '    <service android:name=".glue.AmosInCallService" android:exported="false" />',
    '    <receiver android:name="com.amos.ai.glue.AlarmReceiver" android:exported="false" />',
    '    <provider android:name="androidx.work.impl.WorkManagerInitializer" />',
    "</manifest>",
  ].join("\n");
  const blanked = stripXmlComments(xml);
  ok("a commented-out component is not a declaration", !blanked.includes("GhostReceiver"));
  ok("line numbers survive XML comment blanking", lineOf(blanked, blanked.indexOf("AmosInCallService")) === 3);
  const decls = componentDeclarations(xml);
  ok(
    "a <service> declaration is read",
    decls.some((d) => d.kind === "service" && d.name === ".glue.AmosInCallService"),
  );
  ok(
    "a <receiver> declaration is read",
    decls.some((d) => d.kind === "receiver" && d.name === "com.amos.ai.glue.AlarmReceiver"),
  );
  ok("the closing tag is not a declaration", decls.filter((d) => d.kind === "service").length === 1);
  ok("no ghost component comes from the comment", !decls.some((d) => d.name === ".glue.GhostReceiver"));

  ok(
    "a relative name resolves against the app namespace",
    resolveComponentName(".glue.AlarmReceiver", NS) === "com.amos.ai.glue.AlarmReceiver",
  );
  ok(
    "an absolute name is kept as written",
    resolveComponentName("com.amos.ai.glue.SmsReceiver", NS) === "com.amos.ai.glue.SmsReceiver",
  );
  ok("a nameless component resolves to nothing", resolveComponentName(null, NS) === null);

  const kt = [
    "class AlarmReceiver : BroadcastReceiver() {",
    "class MediaStoreGlue(private val context: Context) {",
    "object ClipboardBridge : SomeInterface {",
    "internal class AmosInCallService : InCallService() {",
  ].join("\n");
  const classes = kotlinClasses(kt);
  const cls = (n) => classes.find((c) => c.name === n);
  ok("a receiver's supertype is read", cls("AlarmReceiver")?.supertype === "BroadcastReceiver");
  ok("a class without a supertype reads as none", cls("MediaStoreGlue")?.supertype === null);
  ok("an object's supertype is read (no parentheses)", cls("ClipboardBridge")?.supertype === "SomeInterface");
  ok(
    "an internal class with a constructor-less supertype is read",
    cls("AmosInCallService")?.supertype === "InCallService",
  );


  const tree = [
    { name: "AlarmReceiver", file: "…/AlarmReceiver.kt", line: 28, supertype: "BroadcastReceiver" },
    { name: "AmosInCallService", file: "…/AmosInCallService.kt", line: 21, supertype: "InCallService" },
    { name: "MediaStoreGlue", file: "…/MediaStoreGlue.kt", line: 69, supertype: null },
    { name: "GhostService", file: "…/GhostService.kt", line: 9, supertype: "Service" },
  ];
  const k1 = checkComponents(xml, NS, tree);
  ok("a registered receiver of the right kind passes", k1.checked.some((c) => c.cls === "AlarmReceiver"));
  ok("a registered service of the right kind passes", k1.checked.some((c) => c.cls === "AmosInCallService"));
  ok(
    "a service-kind class the fragment never registers is a finding",
    k1.findings.some((f) => f.kind === "unregistered-component" && f.site.includes("GhostService")),
  );
  ok("a <provider> is reported, not judged", k1.reports.some((r) => r.kind === "unjudged-element"));
  ok("no finding is invented for the passing fragment", k1.findings.length === 1);
  ok(
    "a class with no supertype is not claimed as a component kind",
    !k1.findings.some((f) => f.site.includes("MediaStoreGlue")),
  );

  const k1Missing = checkComponents(
    '<manifest><receiver android:name=".glue.TypoReceiver" android:exported="false" /></manifest>',
    NS,
    tree,
  );
  ok(
    "a name with no Kotlin class is a finding (the silently dead component)",
    k1Missing.findings[0]?.kind === "missing-kotlin-class",
  );
  const k1WrongKind = checkComponents(
    '<manifest><receiver android:name=".glue.AmosInCallService" /></manifest>',
    NS,
    tree,
  );
  ok("a <receiver> pointing at a Service is a finding", k1WrongKind.findings[0]?.kind === "wrong-kind");
  const k1Foreign = checkComponents(
    '<manifest><receiver android:name="androidx.work.impl.RescheduleReceiver" /></manifest>',
    NS,
    tree,
  );
  ok(
    "a foreign component is reported, never judged",
    k1Foreign.reports.some((r) => r.kind === "foreign-component") &&
      !k1Foreign.findings.some((f) => f.site.includes("RescheduleReceiver")),
  );
  const k1Nameless = checkComponents("<manifest><service /></manifest>", NS, tree);
  ok("a nameless component is a finding", k1Nameless.findings[0]?.kind === "nameless-component");
  const k1UnknownKind = checkComponents(
    '<manifest><service android:name=".glue.MediaStoreGlue" /></manifest>',
    NS,
    tree,
  );
  ok(
    "a class whose supertype cannot be read is a finding, not a pass",
    k1UnknownKind.findings[0]?.kind === "unknown-kind",
  );

  ok(
    "Cargo's default library name maps '-' to '_'",
    cargoLibNames('name = "amos-clipboard"\n').names.includes("amos_clipboard"),
  );
  ok(
    "[lib] name wins over the package name",
    cargoLibNames('name = "amos-tauri"\n\n[lib]\nname = "amos_tauri_lib"\n').lib === "amos_tauri_lib",
  );
  const libs = [
    { path: "crates/amos-tauri", names: ["amos_tauri", "amos_tauri_lib"] },
    { path: "crates/amos-clipboard", names: ["amos_clipboard"] },
  ];
  const k3 = checkLibraryLoads(
    [{ file: "…/SensorGlue.kt", text: '  System.loadLibrary("amos_tauri_lib")' }],
    libs,
  );
  ok("a load whose library a crate builds passes", k3.checked[0]?.crate === "crates/amos-tauri");
  const k3Bad = checkLibraryLoads([{ file: "…/X.kt", text: 'System.loadLibrary("amos_typo")' }], libs);
  ok("a load of a library no crate builds is a finding", k3Bad.findings[0]?.kind === "unknown-library");

  const smsXml = [
    "<manifest>",
    '  <receiver android:name=".glue.SmsReceiver" android:exported="true" android:permission="android.permission.BROADCAST_SMS">',
    "    <intent-filter>",
    '      <action android:name="android.provider.Telephony.SMS_RECEIVED" />',
    "    </intent-filter>",
    "  </receiver>",
    "</manifest>",
  ].join("\n");
  const smsDetails = componentDeclarations(smsXml);
  ok("a component's actions are read", smsDetails[0]?.actions[0]?.name === "android.provider.Telephony.SMS_RECEIVED");
  ok("a component's sender permission is read", smsDetails[0]?.permission === "android.permission.BROADCAST_SMS");
  ok("a component's exported flag is read", smsDetails[0]?.exported === "true");
  const k4 = checkComponentContract(smsDetails);
  ok("the protected broadcast's sender permission is verified", k4.checked[0]?.sender === "android.permission.BROADCAST_SMS");
  ok("a correct declaration has no finding", k4.findings.length === 0);

  const badAction = componentDeclarations(
    '<manifest><receiver android:name=".glue.X"><intent-filter><action android:name="android.provider.Telephony.SMS_RECEIVEDD" /></intent-filter></receiver></manifest>',
  );
  ok(
    "a misspelled action is a finding (the component could never receive it)",
    checkComponentContract(badAction).findings[0]?.kind === "unknown-action",
  );
  const wrongKind = checkComponentContract(
    componentDeclarations(
      '<manifest><service android:name=".glue.X"><intent-filter><action android:name="android.provider.Telephony.SMS_RECEIVED" /></intent-filter></service></manifest>',
    ),
  );
  ok(
    "an action delivered to a <receiver> inside a <service> is a finding",
    wrongKind.findings.some((f) => f.kind === "action-kind-mismatch"),
  );
  const noSender = checkComponentContract(
    componentDeclarations(
      '<manifest><receiver android:name=".glue.X" android:exported="true"><intent-filter><action android:name="android.provider.Telephony.SMS_RECEIVED" /></intent-filter></receiver></manifest>',
    ),
  );
  ok(
    "an exported receiver with no sender permission is a finding (anyone could inject it)",
    noSender.findings.some((f) => f.kind === "missing-sender-permission"),
  );
  const wrongSender = checkComponentContract(
    componentDeclarations(
      '<manifest><receiver android:name=".glue.X" android:permission="android.permission.WAKE_LOCK"><intent-filter><action android:name="android.provider.Telephony.SMS_RECEIVED" /></intent-filter></receiver></manifest>',
    ),
  );
  ok(
    "the wrong sender permission is a finding",
    wrongSender.findings.some((f) => f.kind === "wrong-sender-permission"),
  );
  const withMeta = checkComponentContract(
    componentDeclarations(
      '<manifest><service android:name=".glue.X" android:permission="android.permission.BIND_INCALL_SERVICE"><intent-filter><action android:name="android.telecom.InCallService" /></intent-filter><meta-data android:name="android.telecom.IN_CALL_SERVICE_UI" android:value="true" /></service></manifest>',
    ),
  );
  ok("an in-call service's action and permission are verified", withMeta.checked.length === 1 && withMeta.findings.length === 0);
  ok("a meta-data name is reported, not judged", withMeta.reports.some((r) => r.kind === "unjudged-meta-data"));
  ok(
    "a component with no action is not judged (the alarm receiver)",
    checkComponentContract(componentDeclarations('<manifest><receiver android:name=".glue.X" android:exported="false" /></manifest>')).findings.length === 0,
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[android-component-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[android-component-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}


// --- scan -------------------------------------------------------------------

/** The tracked Kotlin glue, `tests/` excluded (host-JVM fixtures declare no components). */
export function glueKotlinFiles() {
  const dirs = [];
  const findDirs = (dir) => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (["target", "node_modules", ".git", "gen"].includes(ent.name)) continue;
      const p = join(dir, ent.name);
      if (!ent.isDirectory()) continue;
      if (ent.name === "android-glue") dirs.push(p);
      else findDirs(p);
    }
  };
  findDirs(join(root, "crates"));
  const files = [];
  for (const d of dirs) {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === "tests") continue;
      const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (p.endsWith(".kt")) files.push(p.slice(root.length + 1));
        }
      };
      walk(join(d, ent.name));
    }
  }
  return files.sort();
}

/** Every workspace crate's library name(s), from its `Cargo.toml`. */
export function workspaceLibs() {
  const out = [];
  const cratesDir = join(root, "crates");
  for (const ent of readdirSync(cratesDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const toml = join(cratesDir, ent.name, "Cargo.toml");
    if (!existsSync(toml)) continue;
    const parsed = cargoLibNames(readFileSync(toml, "utf8"));
    out.push({ path: `crates/${ent.name}`, package: parsed.package, lib: parsed.lib, names: parsed.names });
  }
  return out;
}

/** Apply `scripts/android-component-allowlist.json`: `{file, token, reason}`; stale entries FAIL. */
export function applyAllowlist(findings, allow) {
  const used = new Set();
  const kept = [];
  for (const f of findings) {
    const entry = allow.find((e) => e.file === f.file && f.site.includes(e.token));
    if (entry) used.add(entry);
    else kept.push(f);
  }
  return { kept, stale: allow.filter((e) => !used.has(e)) };
}

function runScan() {
  const allow = existsSync(ALLOWLIST) ? JSON.parse(readFileSync(ALLOWLIST, "utf8")) : [];
  for (const e of allow) {
    if (!e.file || !e.token || !String(e.reason ?? "").trim()) {
      console.error(`[android-component-scan] allow-entry without file+token+reason: ${JSON.stringify(e)}`);
      process.exit(2);
    }
  }
  const fragmentPath = join(root, FRAGMENT);
  if (!existsSync(fragmentPath)) {
    // A missing input is a failure, never a silent pass: the fragment is what this gate is for.
    console.error(`[android-component-scan] FAIL — ${FRAGMENT} not found.`);
    process.exit(1);
  }
  const namespace = /"identifier"\s*:\s*"([^"]+)"/.exec(readFileSync(join(root, CONF), "utf8"))?.[1] ?? null;
  if (!namespace) {
    console.error(`[android-component-scan] FAIL — ${CONF} has no identifier (the relative names cannot be resolved).`);
    process.exit(1);
  }
  const files = glueKotlinFiles();
  const classes = [];
  const duplicates = [];
  const seen = new Map();
  const sources = [];
  for (const f of files) {
    const text = readFileSync(join(root, f), "utf8");
    sources.push({ file: f, text });
    for (const c of kotlinClasses(text)) {
      if (seen.has(c.name)) duplicates.push({ name: c.name, file: f, first: seen.get(c.name) });
      else seen.set(c.name, f);
      classes.push({ ...c, file: f });
    }
  }
  const fragmentXml = existsSync(fragmentPath) ? readFileSync(fragmentPath, "utf8") : null;
  const components = checkComponents(fragmentXml ?? "", namespace, classes);
  const loads = checkLibraryLoads(sources, workspaceLibs());
  const contract = checkComponentContract(componentDeclarations(fragmentXml ?? ""));
  const findings = [...components.findings, ...contract.findings, ...loads.findings];
  for (const d of duplicates) {
    findings.push({
      kind: "duplicate-class",
      file: d.file,
      line: 1,
      site: `class ${d.name}`,
      detail: `${d.first} declares the same class name — the component index would check the wrong file`,
    });
  }
  const { kept, stale } = applyAllowlist(findings, allow);
  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          namespace,
          fragment: FRAGMENT,
          kotlinFiles: files.length,
          classes: classes.length,
          componentsChecked: components.checked,
          componentsReported: components.reports,
          actionContracts: contract.checked,
          actionContractsReported: contract.reports,
          libraryLoads: loads.checked,
          findings: kept,
          stale,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[android-component-scan] ${FRAGMENT} @ ${namespace}: ${components.checked.length} component(s) resolve to a Kotlin class of the right kind; ` +
        `${components.reports.length} reported-but-not-judged; ${files.length} glue Kotlin file(s) scanned.`,
    );
    console.log(
      `[android-component-scan] ${contract.checked.length} action(s) reach a component the platform delivers to, with their sender permission; ` +
        `${contract.reports.length} reported-but-not-judged.`,
    );
    console.log(
      `[android-component-scan] ${loads.checked.length} System.loadLibrary call(s) name a library a workspace crate builds.`,
    );
    for (const f of kept) {
      console.error(`[android-component-scan] FAIL — ${f.file}:${f.line} ${f.kind}: ${f.site}\n          ${f.detail}`);
    }
    for (const s of stale) {
      console.error(`[android-component-scan] FAIL — stale allow-list entry (nothing matched it): ${s.file} ${s.token}`);
    }
    if (kept.length === 0 && stale.length === 0) {
      console.log(
        "[android-component-scan] OK — every manifest component is a class this app has (of the right kind), nothing ships unregistered, and every loaded library is built.",
      );
    }
  }
  process.exit(kept.length === 0 && stale.length === 0 ? 0 : 1);
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();
if (IS_ENTRY && !process.argv.includes("--selftest")) runScan();

