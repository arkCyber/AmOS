#!/usr/bin/env node
/**
 * android-role-scan.mjs — "the app can never be granted the Android role its own
 * components need, because the intent-filter that qualifies it is scoped by <data>".
 *
 * Why this file exists (REQ-A1873 / F-AND-018): AmOS is a *candidate* default phone
 * app. `AmosInCallService` (the whole real-call surface) binds only while the app
 * holds `android.app.role.DIALER`, and the platform grants that role only to a
 * package it can *qualify*. Measured on a retail S5 (Android 14), the app was
 * installed, the DIAL filter was declared, `dumpsys package com.amos.ai` advertised
 * `android.intent.action.DIAL` on `.MainActivity` — and the grant still failed:
 *
 *     $ adb shell cmd role add-role-holder android.app.role.DIALER com.amos.ai
 *     ... Package does not qualify for the role ...
 *     E RoleControllerServiceImpl: Package does not qualify for the role,
 *       package: com.amos.ai, role: android.app.role.DIALER
 *
 * The reason is structural, and no gate could see it. RoleManager qualifies a
 * package by resolving the role's `RequiredComponent` through the PackageManager:
 * for DIALER that is **action DIAL with no data URI** (`IntentFilterData{
 * mDataScheme='null', mDataType='null'}` — the exact string the platform logs in its
 * refusal). `IntentFilter.matchData` answers NO_MATCH_DATA when a filter declares a
 * `<data>` scheme and the incoming intent has no data — so a filter written as
 *
 *     <intent-filter>
 *         <action android:name="android.intent.action.DIAL" />
 *         <category android:name="android.intent.category.DEFAULT" />
 *         <data android:scheme="tel" />
 *     </intent-filter>
 *
 * matches `tel:` URIs and **never** matches the role's no-data query. On the device:
 * `cmd package query-activities -a android.intent.action.DIAL` returned only
 * `com.google.android.dialer`; add `-d tel:110` and `com.amos.ai/.MainActivity`
 * appears. Google's dialer carries **two** filters for DIAL (a bare one and a `tel`
 * one) for exactly this reason; AmOS carried only the scoped one.
 *
 * Why nothing caught it: `scripts/android-glue-mirror.sh` compares the tracked
 * fragment and the generated manifest by **`android:name` strings**, and a bare DIAL
 * filter introduces no new name — so adding or deleting the qualifying filter is
 * invisible to it, to `android-component-scan.mjs` (which judges `<service>`/
 * `<receiver>`, not `<activity>` filters), and to `android-permission-scan.mjs`
 * (which reads `<uses-permission>`). The APK built, installed and launched; the
 * feature simply never became reachable, which is this repo's canonical defect class.
 *
 * What this checks: for each entry in `ROLE_REQUIREMENTS` — a **recorded** mapping
 * from a role to the action/category its `RequiredComponent` resolves — the tracked
 * Activity fragment must contain an `<intent-filter>` that declares the action and
 * the category and carries **no `<data>` element**. It runs the same check over the
 * generated manifest when one exists (that file is git-ignored and hand-merged from
 * the fragment, which is how the two drift), so "fixed the fragment, forgot to
 * merge" fails here rather than on a phone.
 *
 * Honest boundary: the table is hand-maintained, so a role nobody listed is
 * invisible; a scoped sibling for the same action is **reported** (it is a real
 * product surface — `tel:` dialing — not a defect) rather than judged; and this
 * asserts *qualification* (the platform will offer the app), never that the role is
 * granted or that the bound service behaves — that is a device fact.
 *
 * Usage (from the repo root):
 *   node scripts/android-role-scan.mjs              # gate
 *   node scripts/android-role-scan.mjs --json       # machine-readable
 *   node scripts/android-role-scan.mjs --selftest   # pin the parser/classifier
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripXmlComments, invokedDirectly } from "./android-component-scan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRAGMENT = "crates/amos-tauri/android-glue/AndroidManifest.activity.xml";
const GEN_MANIFEST = "crates/amos-tauri/gen/android/app/src/main/AndroidManifest.xml";

/**
 * Roles this app intends to hold, and the `RequiredComponent` the platform resolves
 * to decide whether it qualifies.
 *
 * `action` + `category` are what the platform's qualification query carries;
 * `noData` records that the query has **no data URI**, so the matching filter must
 * declare no `<data>` element. Confirmed against the platform's own refusal on the
 * S5: `RequiredComponent{mIntentFilterData=IntentFilterData{mAction='android.intent.
 * action.DIAL', mCategories='[]', mDataScheme='null', mDataType='null'}, ...}`.
 */
export const ROLE_REQUIREMENTS = [
  {
    role: "android.app.role.DIALER",
    action: "android.intent.action.DIAL",
    category: "android.intent.category.DEFAULT",
    why:
      "RoleManager resolves action DIAL with no data URI; a `<data android:scheme=\"tel\"/>`-scoped " +
      "filter cannot match a no-data intent (IntentFilter.matchData → NO_MATCH_DATA), so the role " +
      "is refused and AmosInCallService never binds",
  },
];

function lineOf(src, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

/**
 * The `<intent-filter>` blocks of a manifest, comment-blanked so an example inside a
 * `<!-- … -->` is not read as a declaration (the Activity fragment documents the
 * template's own filter that way). Each carries its actions, categories, raw
 * `<data …>` tags and its line.
 */
export function intentFilters(xml) {
  const code = stripXmlComments(xml);
  const out = [];
  const re = /<intent-filter\b[^>]*?(\/>|>)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const selfClosing = m[1] === "/>";
    let body = "";
    if (!selfClosing) {
      const close = code.indexOf("</intent-filter>", re.lastIndex);
      if (close > 0) body = code.slice(re.lastIndex, close);
    }
    const gather = (re2) => [...body.matchAll(re2)].map((a) => a[1]);
    out.push({
      actions: gather(/<action\b[^>]*android:name\s*=\s*"([^"]*)"/g),
      categories: gather(/<category\b[^>]*android:name\s*=\s*"([^"]*)"/g),
      data: [...body.matchAll(/<data\b[^>]*?\/?>/g)].map((a) => a[0]),
      line: lineOf(code, m.index),
    });
  }
  return out;
}

/**
 * The role-qualification findings for one manifest snapshot — pure, so it is
 * testable. A role is satisfied when some filter declares its action and category
 * and has no `<data>`; a scoped sibling for the same action is reported, never
 * judged (it is the `tel:` handler, a surface of its own).
 */
export function roleQualificationFindings(filters) {
  const findings = [];
  const reports = [];
  const checked = [];
  for (const req of ROLE_REQUIREMENTS) {
    const withAction = filters.filter((f) => f.actions.includes(req.action));
    const scoped = withAction.filter((f) => f.data.length > 0);
    for (const f of scoped) {
      reports.push({
        kind: "data-scoped-sibling",
        line: f.line,
        site: `${f.data.join(" ")}`,
        detail: `declares ${req.action} but is scoped by <data> — it does NOT qualify for ${req.role}; it exists for URI handling`,
      });
    }
    if (withAction.length === 0) {
      findings.push({
        kind: "missing-role-filter",
        line: 0,
        site: `<action android:name="${req.action}">`,
        detail: `no intent-filter declares ${req.action} — ${req.role} can never be granted, so the app never appears in the role's picker (${req.why})`,
      });
      continue;
    }
    const dataFree = withAction.filter((f) => f.data.length === 0);
    if (dataFree.length === 0) {
      findings.push({
        kind: "role-filter-scoped-by-data",
        line: scoped[0].line,
        site: `<action android:name="${req.action}"> + <data …>`,
        detail:
          `every filter declaring ${req.action} is scoped by <data> (${scoped
            .map((f) => f.data.join(" "))
            .join(" / ")}), so none matches the role's no-data query and ${req.role} is refused (${req.why})`,
      });
      continue;
    }
    const ok = dataFree.find((f) => f.categories.includes(req.category));
    if (!ok) {
      findings.push({
        kind: "role-filter-without-category",
        line: dataFree[0].line,
        site: `<category android:name="${req.category}">`,
        detail: `a data-free filter declares ${req.action} but not ${req.category} — an implicit query (which the role makes) only matches a filter carrying DEFAULT, so ${req.role} is still refused`,
      });
      continue;
    }
    checked.push({ role: req.role, action: req.action, line: ok.line });
  }
  return { findings, reports, checked };
}

// --- selftest ---------------------------------------------------------------

export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);
  const wrap = (inner) => `<manifest>\n${inner}\n</manifest>\n`;
  const DIAL = "android.intent.action.DIAL";

  const bare = wrap(
    '  <intent-filter>\n    <action android:name="android.intent.action.DIAL" />\n' +
      '    <category android:name="android.intent.category.DEFAULT" />\n  </intent-filter>',
  );
  const scoped = wrap(
    '  <intent-filter>\n    <action android:name="android.intent.action.DIAL" />\n' +
      '    <category android:name="android.intent.category.DEFAULT" />\n' +
      '    <data android:scheme="tel" />\n  </intent-filter>',
  );
  const both = wrap(
    '  <intent-filter>\n    <action android:name="android.intent.action.DIAL" />\n' +
      '    <category android:name="android.intent.category.DEFAULT" />\n  </intent-filter>\n' +
      '  <intent-filter>\n    <action android:name="android.intent.action.DIAL" />\n' +
      '    <category android:name="android.intent.category.DEFAULT" />\n' +
      '    <data android:scheme="tel" />\n  </intent-filter>',
  );
  const noCategory = wrap(
    '  <intent-filter>\n    <action android:name="android.intent.action.DIAL" />\n  </intent-filter>',
  );
  const commented = wrap(
    '  <!-- <intent-filter>\n    <action android:name="android.intent.action.DIAL" />\n' +
      '    <category android:name="android.intent.category.DEFAULT" />\n  </intent-filter> -->',
  );

  const one = intentFilters(bare);
  ok("an intent-filter is read", one.length === 1);
  ok("its action is read", one[0]?.actions[0] === DIAL);
  ok("its category is read", one[0]?.categories[0] === "android.intent.category.DEFAULT");
  ok("a data-free filter has no <data>", one[0]?.data.length === 0);
  ok("a scoped filter's <data> is read", intentFilters(scoped)[0]?.data[0]?.includes('scheme="tel"'));
  ok("two sibling filters are read as two", intentFilters(both).length === 2);
  ok("a commented-out filter is not a declaration", intentFilters(commented).length === 0);
  ok("line numbers are reported", intentFilters(bare)[0]?.line > 0);

  const okCase = roleQualificationFindings(intentFilters(bare));
  ok("a bare DIAL filter qualifies", okCase.checked.length === 1 && okCase.findings.length === 0);

  const scopedCase = roleQualificationFindings(intentFilters(scoped));
  ok(
    "a tel-scoped filter alone is a finding (the S5 defect)",
    scopedCase.findings.some((f) => f.kind === "role-filter-scoped-by-data"),
  );
  ok("and the scoped filter is reported as a surface, not judged", scopedCase.reports.some((r) => r.kind === "data-scoped-sibling"));

  const bothCase = roleQualificationFindings(intentFilters(both));
  ok(
    "a bare filter beside a scoped one qualifies, sibling only reported",
    bothCase.checked.length === 1 && bothCase.findings.length === 0 && bothCase.reports.length === 1,
  );

  const noneCase = roleQualificationFindings(intentFilters(wrap("<manifest></manifest>")));
  ok("no DIAL filter at all is a finding", noneCase.findings.some((f) => f.kind === "missing-role-filter"));

  const noCat = roleQualificationFindings(intentFilters(noCategory));
  ok(
    "a bare filter without DEFAULT is a finding",
    noCat.findings.some((f) => f.kind === "role-filter-without-category"),
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[android-role-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[android-role-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}

// --- scan -------------------------------------------------------------------

function runScan() {
  const json = process.argv.includes("--json");
  const fragmentPath = join(root, FRAGMENT);
  if (!existsSync(fragmentPath)) {
    // A missing input is a failure, never a silent pass: the fragment is what this gate is for.
    console.error(`[android-role-scan] FAIL — ${FRAGMENT} not found.`);
    process.exit(1);
  }
  const fragment = roleQualificationFindings(intentFilters(readFileSync(fragmentPath, "utf8")));

  // The generated manifest (git-ignored, hand-merged from the fragment) is the file the
  // build actually reads. When it exists it must qualify too — "fixed the fragment,
  // forgot to merge" is exactly the drift this gate exists to catch.
  const genPath = join(root, GEN_MANIFEST);
  const gen = existsSync(genPath)
    ? roleQualificationFindings(intentFilters(readFileSync(genPath, "utf8")))
    : null;
  const findings = [
    ...fragment.findings.map((f) => ({ ...f, file: FRAGMENT })),
    ...(gen ? gen.findings.map((f) => ({ ...f, file: GEN_MANIFEST })) : []),
  ];

  if (json) {
    console.log(
      JSON.stringify(
        {
          fragment: FRAGMENT,
          generated: gen ? GEN_MANIFEST : null,
          qualified: fragment.checked,
          qualifiedGenerated: gen ? gen.checked : null,
          reports: [...fragment.reports, ...(gen ? gen.reports : [])],
          findings,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[android-role-scan] ${FRAGMENT}: ${fragment.checked.length}/${ROLE_REQUIREMENTS.length} role(s) qualify; ` +
        `${gen ? `${gen.checked.length}/${ROLE_REQUIREMENTS.length} in the generated manifest; ` : "generated manifest absent (skipped); "}` +
        `${fragment.reports.length + (gen ? gen.reports.length : 0)} scoped sibling(s) reported.`,
    );
    for (const f of findings) {
      console.error(`[android-role-scan] FAIL — ${f.file}:${f.line} ${f.kind}: ${f.site}\n          ${f.detail}`);
    }
    if (findings.length === 0) {
      console.log(
        "[android-role-scan] OK — every intended role has a data-free qualifying intent-filter in the tracked fragment (and in the generated manifest where present).",
      );
    }
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();
if (IS_ENTRY && !process.argv.includes("--selftest")) runScan();
