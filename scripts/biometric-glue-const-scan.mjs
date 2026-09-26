#!/usr/bin/env node
// "the biometric glue's answer to `canAuthenticate` does not mean what the code says it
// means" — `BiometricGlue.getAvailability` maps an `int` from androidx's
// `BiometricManager.canAuthenticate(BIOMETRIC_STRONG)` onto the two questions the UI asks
// ("is there a sensor?" / "is anything enrolled?"). Nothing read that mapping: the Rust seam
// re-parses the glue's JSON, the frontend tests feed hand-written fixtures, and no gate ever
// looked at the `when` arms. So the two answers sat **exchanged** (REQ-A779 / F-AND-008):
//
//   BIOMETRIC_ERROR_NO_HARDWARE (12)   was on the arm that sets hardware_present = true;
//   BIOMETRIC_ERROR_NONE_ENROLLED (11) fell to `else` -> hardware_present = false.
//
// On a phone with no sensor at all the UI therefore printed "the device has biometric
// hardware, but nothing is enrolled" — an instruction to go enrol a fingerprint that cannot
// exist; on a phone whose sensor is present with nothing enrolled (the exact case
// `lock.biometricNeedsEnrollment` was written for) it printed "no biometrics on this device".
// Both are wrong in the same way: a claim about the user's hardware, from a code path the
// author had already decided the meaning of, silently the other way round.
//
// The authority for the codes is **not** in this repository — it is the artifact the APK
// links against. They were read off it, not remembered:
//
//   javap -cp ~/.gradle/caches/8.14.3/transforms/\
//           743c9b6c5cceb72e9888e21187361fbc/transformed/biometric-1.1.0-api.jar \
//         -constants androidx.biometric.BiometricManager
//
//   BIOMETRIC_SUCCESS = 0  BIOMETRIC_STATUS_UNKNOWN = -1  BIOMETRIC_ERROR_UNSUPPORTED = -2
//   BIOMETRIC_ERROR_HW_UNAVAILABLE = 1  BIOMETRIC_ERROR_NONE_ENROLLED = 11
//   BIOMETRIC_ERROR_NO_HARDWARE = 12   BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED = 15
//
// `ANDROIDX_BIOMETRIC` below is that table, and it is a **floor-checked** part of the scan:
// if the glue names a constant this table does not know, the scan cannot judge it, so it says
// so instead of guessing. (The platform class `android.hardware.biometrics.BiometricManager`
// carries the same numbers; the three negative ones are `@hide` there and public in androidx,
// which is why this file reads the artifact rather than `android.jar`.)
//
// Rules:
//   R0 floors           — the three extractions found something, so "scanned nothing" is red.
//   R1 the code → state — every `when (canAuth)` arm's state matches what that code means.
//   R2 hardware_present — the states allowed to claim hardware are exactly the ones whose
//                         code means the sensor is there. This is the rule the defect broke.
//   R3 wire ⊆ Rust      — the states the glue emits are the Rust `BiometricDeviceState` variants
//                         (minus `unavailable`, which only the host can answer).
//
// Written by source text: nothing here is compiled, installed, or on a device.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FLOORS = { arms: 3, codes: 7, hardwareStates: 3 };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KT = "crates/amos-tauri/android-glue/com/amos/ai/glue/BiometricGlue.kt";
const RUST = "crates/amos-tauri/src/ble.rs";

/** The androidx codes, verbatim from the `javap -constants` dump quoted in the header. */
export const ANDROIDX_BIOMETRIC = {
  BIOMETRIC_SUCCESS: 0,
  BIOMETRIC_STATUS_UNKNOWN: -1,
  BIOMETRIC_ERROR_UNSUPPORTED: -2,
  BIOMETRIC_ERROR_HW_UNAVAILABLE: 1,
  BIOMETRIC_ERROR_NONE_ENROLLED: 11,
  BIOMETRIC_ERROR_NO_HARDWARE: 12,
  BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED: 15,
};

/**
 * What each code means for the three things the glue reports.
 *
 * `hardware: true` is a **claim the sensor exists**; `false` is a claim it does not; `null`
 * is "this code does not answer that question". Only `true` and `false` may ever be reported
 * as a hardware fact — a code that answers nothing must not be rounded to `false`.
 */
export const MEANING = {
  BIOMETRIC_SUCCESS: { hardware: true, enrolled: true, state: "enrolled" },
  BIOMETRIC_ERROR_NONE_ENROLLED: { hardware: true, enrolled: false, state: "not-enrolled" },
  BIOMETRIC_ERROR_HW_UNAVAILABLE: { hardware: true, enrolled: false, state: "hw-unavailable" },
  BIOMETRIC_ERROR_NO_HARDWARE: { hardware: false, enrolled: false, state: "no-hardware" },
  // The three that answer neither question. `SECURITY_UPDATE_REQUIRED` means the sensor is
  // there but the device demands a keyguard/security patch first; `STATUS_UNKNOWN` and
  // `ERROR_UNSUPPORTED` are the library declining to say. All three land on `unknown`.
  BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED: { hardware: null, enrolled: false, state: "unknown" },
  BIOMETRIC_STATUS_UNKNOWN: { hardware: null, enrolled: false, state: "unknown" },
  BIOMETRIC_ERROR_UNSUPPORTED: { hardware: null, enrolled: false, state: "unknown" },
};

/**
 * Strip Kotlin block and line comments, then read. **Every** extractor below goes through this.
 *
 * `BiometricGlue.kt` carries a doc comment whose whole job is to quote the arms that used to
 * ship (REQ-A779) so a reader can see what changed. Read raw, that prose is *also* the answer:
 * `indexOf("when (canAuth)")` returns the **quoted** `when` in the comment, not the declared
 * one (the shipped file has the token in its doc block well above the real `val state = when`),
 * so the slice begins inside the prose — and because `ktStateArms` is first-match-wins, a
 * quoted arm silently shadows the real one.
 *
 * Both directions are live, and the second is the harm:
 *   - a comment that quotes the *old* arms reddens a **correct** file (false red), and
 *   - a comment that quotes the *correct* arms makes a **regressed** file green (false green) —
 *     the scan reports success on exactly the inverted-answer defect it exists to catch.
 * A green that means "the comment agrees with the comment" is worse than no gate at all.
 */
export function stripKtComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .map((line) => line.replace(/\s*\/\/.*$/, ""))
    .join("\n");
}

/** `when (canAuth) { BiometricManager.X, BiometricManager.Y -> "state"  ... }` → Map(code → state). */
export function ktStateArms(src) {
  src = stripKtComments(src);
  const start = src.indexOf("when (canAuth)");
  if (start < 0) return new Map();
  const body = src.slice(start, src.indexOf("\n        }", start));
  const out = new Map();
  // One arm: one or more qualified constants, then `->`, then a string literal.
  const arm = /((?:BiometricManager\.[A-Z_0-9]+\s*,?\s*)+)->\s*"([a-z-]+)"/g;
  for (const m of body.matchAll(arm)) {
    for (const c of m[1].matchAll(/BiometricManager\.([A-Z_0-9]+)/g)) {
      if (!out.has(c[1])) out.set(c[1], m[2]);
    }
  }
  return out;
}

/**
 * The **shipped** shape: `val hardwarePresent = when (canAuth) { … -> true … }`, i.e. bare
 * booleans instead of a state vocabulary. Returns null when the file is already shape A, so
 * the caller can tell "not this shape" from "this shape with no arms".
 *
 * This exists so the scan can name the shipped defect instead of only rejecting the shape:
 * on this shape it reports per constant what the answer claims versus what the code means.
 */
export function ktBooleanArms(src) {
  const m = stripKtComments(src).match(
    /val\s+hardwarePresent\s*=\s*when\s*\(canAuth\)\s*\{([\s\S]*?)\n\s*\}/,
  );
  if (!m) return null;
  const out = new Map();
  const arm = /((?:BiometricManager\.[A-Z_0-9]+\s*,?\s*)+)->\s*(true|false)/g;
  for (const a of m[1].matchAll(arm)) {
    for (const c of a[1].matchAll(/BiometricManager\.([A-Z_0-9]+)/g)) {
      if (!out.has(c[1])) out.set(c[1], a[2] === "true");
    }
  }
  const elseArm = m[1].match(/else\s*->\s*(true|false)/)?.[1];
  if (elseArm !== undefined) out.set("__else__", elseArm === "true");
  return out;
}

/** The `else -> "..."` arm of the same `when`. */
export function ktElseArm(src) {
  src = stripKtComments(src);
  const start = src.indexOf("when (canAuth)");
  if (start < 0) return null;
  const body = src.slice(start, src.indexOf("\n        }", start));
  return body.match(/else\s*->\s*"([a-z-]+)"/)?.[1] ?? null;
}

/**
 * What `hardwarePresent` is set to for each state → Map(state → true | false | null).
 *
 * `null` is a value here, not "absent from the map": the whole point of the fix is that some
 * states answer **nothing** about the hardware, and an extractor that dropped those entries
 * would call a file honest for having lost exactly the arm that matters.
 *
 * Two shapes are legitimate and both are read: a `when (state)` block (`"x" -> true`) and a
 * one-liner (`state == "x" || …`, which can only ever assert `true`).
 */
export function ktHardwareClaims(src) {
  const out = new Map();
  const stripped = stripKtComments(src);
  const block = stripped.match(
    /val\s+hardwarePresent[^\n=]*=\s*when\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/,
  );
  if (block) {
    const arm = /((?:"[a-z-]+"\s*,?\s*)+)->\s*(true|false|null)/g;
    for (const a of block[1].matchAll(arm)) {
      const value = a[2] === "true" ? true : a[2] === "false" ? false : null;
      for (const s of a[1].matchAll(/"([a-z-]+)"/g)) if (!out.has(s[1])) out.set(s[1], value);
    }
    return out;
  }
  // `[^\n=]*=` so the greedy run cannot walk past a `==` and land on its second `=`.
  const line = stripped.match(/val\s+hardwarePresent[^\n=]*=\s*([^\n]*)/);
  if (!line) return out;
  for (const s of line[1].matchAll(/"([a-z-]+)"/g)) if (!out.has(s[1])) out.set(s[1], true);
  return out;
}

/** The `enrolled = ...` expression's state literals. */
export function ktEnrolledStates(src) {
  const m = stripKtComments(src).match(/\bval\s+enrolled\s*=\s*([^\n]*)/);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]));
}

/** The Rust `BiometricDeviceState` variants' kebab spellings, in declaration order. */
export function rustStateSpellings(src) {
  const head = src.indexOf("pub enum BiometricDeviceState {");
  if (head < 0) return [];
  const attrs = src.slice(src.lastIndexOf("#[derive(", head), head);
  if (!attrs.includes('rename_all = "kebab-case"')) return [];
  // `Uppercase,` at any indent: the slice is the enum body alone, so the only lines ending in
  // a bare comma are variants (a `#[serde(…)]` or a doc line does not).
  return [...src.slice(head, src.indexOf("\n}", head)).matchAll(/^\s*([A-Z]\w*),$/gm)].map((m) =>
    m[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
  );
}

export function scan({ read = (p) => readFileSync(join(ROOT, p), "utf8"), floors = FLOORS } = {}) {
  const kt = read(KT);
  const rust = read(RUST);
  const findings = [];

  const arms = ktStateArms(kt);
  const elseArm = ktElseArm(kt);
  const hwClaims = ktHardwareClaims(kt);
  const hwStates = new Set([...hwClaims].filter(([, v]) => v === true).map(([s]) => s));
  const enrolledStates = ktEnrolledStates(kt);
  const rustStates = rustStateSpellings(rust);

  // R0 — floors. Every extraction is asserted non-empty before it is compared, so a rewrite
  // that moves the arms out of the scanned window fails loudly instead of comparing 0 to 0.
  if (arms.size < floors.arms) {
    findings.push(`R0: found ${arms.size} canAuthenticate arm(s); floor is ${floors.arms}`);
  }
  if (Object.keys(ANDROIDX_BIOMETRIC).length < floors.codes) {
    findings.push(`R0: the androidx code table has ${Object.keys(ANDROIDX_BIOMETRIC).length}; floor is ${floors.codes}`);
  }
  if (hwStates.size < floors.hardwareStates) {
    findings.push(`R0: found ${hwStates.size} state(s) allowed to claim hardware; floor is ${floors.hardwareStates}`);
  }
  // The other half of the same floor: a file that answers every state with `true` (or that
  // dropped the `false` arm) has no way left to say "there is no sensor", so it must be red.
  if (![...hwClaims.values()].includes(false)) {
    findings.push(
      'R0: no state sets hardware_present = false, so the glue can never report "there is no sensor"',
    );
  }
  if (rustStates.length === 0) {
    findings.push(`R0: no kebab-case \`pub enum BiometricDeviceState\` in ${RUST}`);
  }

  // ── The shipped shape: bare booleans, no state vocabulary ────────────────────────────────
  //
  // Reported per constant, because that is what the defect was: not a missing abstraction but
  // two specific answers exchanged. `hardware_present` here is the only channel the UI has, so
  // an inverted arm is an inverted *statement to the user*.
  const boolArms = ktBooleanArms(kt);
  if (boolArms !== null) {
    const elseClaims = boolArms.get("__else__");
    for (const [code, claimsPresent] of boolArms) {
      if (code === "__else__") continue;
      const meaning = MEANING[code];
      if (!meaning) {
        findings.push(
          `R1: ${code} is not in the androidx table this scan knows (re-run the javap dump)`,
        );
        continue;
      }
      if (meaning.hardware === null) {
        findings.push(
          `R1: ${code} answers neither question, but the glue reports hardware_present = ` +
            `${claimsPresent} — a code that says nothing about the hardware is being read as ` +
            `a statement about it`,
        );
      } else if (claimsPresent !== meaning.hardware) {
        findings.push(
          `R1: ${code} (value ${ANDROIDX_BIOMETRIC[code]}) means the sensor is ` +
            `${meaning.hardware ? "PRESENT" : "ABSENT"}, but the glue reports ` +
            `hardware_present = ${claimsPresent}`,
        );
      }
    }
    for (const [code, meaning] of Object.entries(MEANING)) {
      if (boolArms.has(code)) continue;
      // What the *glue says* is `elseClaims`; what the *code means* is `meaning.hardware`.
      // Naming both is the whole point — the two disagreeing is the defect.
      let tail;
      if (meaning.hardware === null) {
        tail = " — a code that answers nothing is being handed the answer \"no sensor\"";
      } else if (meaning.hardware === elseClaims) {
        tail = " (right by omission, not by an arm — it stops being right the moment `else` moves)";
      } else {
        tail = `, though the code means the sensor is ${meaning.hardware ? "PRESENT" : "ABSENT"}`;
      }
      findings.push(
        `R1: ${code} has no arm on this shape; it falls to \`else -> ${elseClaims}\` and is ` +
          `reported as hardware_present = ${elseClaims}` + tail,
      );
    }
    findings.push(
      "R0: the glue answers `canAuthenticate` with bare booleans, so no state vocabulary " +
        "exists for the Rust `BiometricDeviceState` to bind to and the screen cannot tell " +
        "\"no sensor\" from \"we could not ask\"",
    );
  }

  // R1 — each arm's state is what that code means.
  for (const [code, state] of boolArms === null ? arms : []) {
    const known = MEANING[code];
    if (!known) {
      findings.push(
        `R1: ${KT} maps ${code}, which is not in the androidx table this scan knows ` +
          `(re-run the javap dump in the header; do not guess)`,
      );
      continue;
    }
    if (state !== known.state) {
      findings.push(
        `R1: ${code} (value ${ANDROIDX_BIOMETRIC[code]}) is mapped to "${state}" ` +
          `but it means "${known.state}"`,
      );
    }
  }
  // Every code that **answers** one of the two questions must have its own arm — a bare `else`
  // must not be standing in for it. That is exactly how NO_HARDWARE was reached by omission:
  // not by being given the wrong meaning, but by never being named at all while the arm it
  // used to sit on was rewritten. The three indeterminate codes are deliberately exempt: they
  // answer neither question, so `else -> "unknown"` *is* their arm (checked just below).
  //
  // These checks read the state vocabulary, so they run only on that shape; on the shipped
  // boolean shape the block above has already named each code's answer.
  const unknownState = MEANING.BIOMETRIC_STATUS_UNKNOWN.state;
  if (boolArms === null) {
    for (const [code, meaning] of Object.entries(MEANING)) {
      if (meaning.hardware === null) continue;
      if (!arms.has(code)) {
        findings.push(
          `R1: ${code} has no arm; it falls to the \`else\` arm ("${elseArm}") and would be ` +
            `reported as ${meaning.hardware === true ? "present" : "absent"}`,
        );
      }
    }
    if (elseArm === null) {
      findings.push('R1: the `when (canAuth)` has no `else -> "..."` arm to catch future codes');
    } else if (elseArm !== unknownState) {
      findings.push(
        `R1: an androidx code this scan does not know falls to "${elseArm}"; it must be ` +
          `"${unknownState}" (a code we cannot classify is not a hardware answer in either direction)`,
      );
    }
    // …and the indeterminate codes really do land there, rather than being given an arm that
    // claims something about the hardware.
    for (const [code, meaning] of Object.entries(MEANING)) {
      if (meaning.hardware !== null) continue;
      if (arms.has(code) && arms.get(code) !== unknownState) {
        findings.push(
          `R1: ${code} answers neither question, but it is mapped to "${arms.get(code)}"`,
        );
      }
    }

    // R2 — what `hardware_present` says for each state is exactly what that state's code
    // means: `true` for the codes that mean "the sensor is there", `false` for the code that
    // means it is not, and `null` for the codes that answer nothing.
    const mayClaim = new Set(
      Object.entries(MEANING)
        .filter(([, v]) => v.hardware === true)
        .map(([, v]) => v.state),
    );
    for (const s of mayClaim) {
      if (!hwStates.has(s)) {
        findings.push(`R2: "${s}" means the sensor is present, but it may not set hardware_present`);
      }
    }
    const expectedClaim = new Map(Object.entries(MEANING).map(([, v]) => [v.state, v.hardware]));
    for (const [s, claim] of hwClaims) {
      if (!expectedClaim.has(s)) {
        findings.push(
          `R2: "${s}" sets hardware_present = ${claim}, but no androidx code means that state ` +
            `(this is the exchange REQ-A779 found: NO_HARDWARE sat on the present arm)`,
        );
        continue;
      }
      const expected = expectedClaim.get(s);
      if (expected === null) {
        findings.push(
          `R2: "${s}" is a state whose code answers nothing about the hardware, but it sets ` +
            `hardware_present = ${claim} — a fact the platform never stated`,
        );
      } else if (claim !== expected) {
        findings.push(
          `R2: "${s}" sets hardware_present = ${claim}, but that state means the sensor is ` +
            `${expected ? "present" : "absent"}`,
        );
      }
    }
    // The third value is the whole reason `hardware_present` is an Option: without a `null`
    // arm, "the platform did not tell us" is rendered as "there is no sensor".
    const nullArm =
      [...hwClaims.values()].includes(null) ||
      /val\s+hardwarePresent[\s\S]{0,400}?else\s*->\s*null/.test(kt);
    if (!nullArm) {
      findings.push(
        'R2: nothing sets hardware_present = null, so "we could not tell" is indistinguishable ' +
          'from "there is no sensor"',
      );
    }
    // The other half of the same contract: only `enrolled` may report enrolled.
    const enrolledMay = new Set(
      Object.entries(MEANING)
        .filter(([, v]) => v.enrolled === true)
        .map(([, v]) => v.state),
    );
    if (enrolledStates.size > 0) {
      for (const s of enrolledStates) {
        if (!enrolledMay.has(s)) {
          findings.push(`R2: "${s}" sets enrolled, but it does not mean enrolled`);
        }
      }
      for (const s of enrolledMay) {
        if (!enrolledStates.has(s)) {
          findings.push(`R2: "${s}" means enrolled, but it may not set enrolled`);
        }
      }
    }
  }

  // R3 — the states the glue emits are Rust variants (minus the one only the host answers).
  const hostOnly = new Set(["unavailable"]);
  for (const s of [...arms.values(), ...(elseArm === null ? [] : [elseArm])]) {
    if (!rustStates.includes(s)) {
      findings.push(`R3: "${s}" is not a BiometricDeviceState variant in ${RUST}`);
    }
  }
  for (const s of rustStates) {
    if (hostOnly.has(s)) continue;
    if (!arms.has(s) && ![...arms.values()].includes(s) && elseArm !== s) {
      findings.push(
        `R3: BiometricDeviceState has "${s}", which the glue can never emit — ` +
          `the screen would carry a branch no device can reach`,
      );
    }
  }

  return findings;
}

function main() {
  if (process.argv.includes("--selftest")) return selftest();
  const findings = scan();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(
      "[biometric-glue-const-scan] OK — BiometricGlue's canAuthenticate mapping matches the " +
        "androidx codes it names.",
    );
  } else {
    console.error("[biometric-glue-const-scan] the glue and the androidx codes disagree:");
    for (const f of findings) console.error("  - " + f);
  }
  if (findings.length > 0) process.exitCode = 1;
}

/** The Rust side, shared by the selftest fixtures (kept minimal — the scan reads the real one). */
const RUST_OK = `
    #[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "kebab-case")]
    pub enum BiometricDeviceState {
        Enrolled,
        NotEnrolled,
        HwUnavailable,
        NoHardware,
        Unknown,
        Unavailable,
    }
`;

/** The **fixed** glue: what this repository should contain after REQ-A779. */
const KT_OK = `
    @JvmStatic
    fun getAvailability(context: Context): String {
        val biometricManager = BiometricManager.from(context)
        val canAuth = biometricManager.canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG
        )
        val state = when (canAuth) {
            BiometricManager.BIOMETRIC_SUCCESS -> "enrolled"
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "not-enrolled"
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "hw-unavailable"
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "no-hardware"
            else -> "unknown"
        }
        val hardwarePresent: Boolean? = when (state) {
            "enrolled", "not-enrolled", "hw-unavailable" -> true
            "no-hardware" -> false
            else -> null
        }
        val enrolled = state == "enrolled"
    }
`;

/** The **historical** glue — the shape that shipped, with the two answers exchanged. */
const KT_SWAPPED = KT_OK.replace(
  `            BiometricManager.BIOMETRIC_SUCCESS -> "enrolled"
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "not-enrolled"
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "hw-unavailable"
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "no-hardware"
            else -> "unknown"`,
  `            BiometricManager.BIOMETRIC_SUCCESS,
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE,
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "present"
            else -> "no-hardware"`,
).replace(
  `        val hardwarePresent: Boolean? = when (state) {
            "enrolled", "not-enrolled", "hw-unavailable" -> true
            "no-hardware" -> false
            else -> null
        }`,
  `        val hardwarePresent = state == "present"`,
);

/**
 * The shape that **actually shipped** (read out of `git show HEAD:` of the glue, not imagined):
 * bare booleans, so there is no state vocabulary at all and `hardware_present` is the only
 * channel the UI has. This is the fixture case 2 cannot cover: case 2 still has a `when` whose
 * arms are strings, which is a *different* defect shape.
 */
const KT_BOOL_SHAPE = `
    @JvmStatic
    fun getAvailability(context: Context): String {
        val biometricManager = BiometricManager.from(context)
        val canAuth = biometricManager.canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG
        )
        val hardwarePresent = when (canAuth) {
            BiometricManager.BIOMETRIC_SUCCESS,
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE,
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> true
            else -> false
        }
        val enrolled = canAuth == BiometricManager.BIOMETRIC_SUCCESS
    }
`;

/**
 * A doc comment of the kind `BiometricGlue.kt` actually carries: it quotes a `when (canAuth)`
 * and its arms so a reader can see what changed. `arms` is spliced in as the quoted lines.
 *
 * The quoted `when (canAuth)` is the point — `indexOf` takes the **first** one, so a strip that
 * is missing or applied too late reads these arms as the file's own.
 */
const ktProse = (arms) => `
    /**
     * This used to be \`val state = when (canAuth) { … }\`, answering:
     *
${arms.map((a) => `     *     ${a}`).join("\n")}
     */
`;

/**
 * The historical arms, quoted in the string vocabulary `KT_SWAPPED` models — what a doc
 * explaining this fix would show beside the new ones. Read raw these are the file's own
 * answers: NO_HARDWARE and HW_UNAVAILABLE both land on `"present"`, and every code the glue
 * cannot classify is handed `"no-hardware"` by the quoted `else`.
 */
const PROSE_OLD_ARMS = [
  'BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "present"',
  'BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "present"',
  'else -> "no-hardware"',
];

/** The *correct* arms, quoted — the shape a doc explaining this fix would show. */
const PROSE_FIXED_ARMS = [
  'BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "hw-unavailable"',
  'BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "no-hardware"',
  'else -> "unknown"',
];

function selftest() {
  const cases = [];
  const run = (kt, rust = RUST_OK) =>
    scan({ read: (p) => (p === KT ? kt : p === RUST ? rust : ""), floors: FLOORS });

  // 1. The fixed glue is clean.
  {
    const f = run(KT_OK);
    cases.push(["the fixed glue passes", f.length === 0, f.join("; ")]);
  }
  // 2. **The defect this scan exists for**: the historical mapping is red.
  {
    const f = run(KT_SWAPPED);
    cases.push([
      "the shipped mapping (NO_HARDWARE on the present arm) is a finding",
      f.some((x) => x.startsWith("R2") && x.includes('"present" sets hardware_present')) &&
        f.some((x) => x.startsWith("R1") && x.includes("BIOMETRIC_ERROR_NO_HARDWARE")) &&
        f.some((x) => x.startsWith("R1") && x.includes("BIOMETRIC_ERROR_NONE_ENROLLED")),
      f.join("; ") || "no findings — the scan cannot see the defect it was written for",
    ]);
  }
  // 3. NO_HARDWARE specifically must never be on a hardware-present arm.
  {
    const kt = KT_OK.replace(
      `BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "no-hardware"`,
      `BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "hw-unavailable"`,
    );
    const f = run(kt);
    cases.push([
      "mis-labelling NO_HARDWARE is caught by R1",
      f.some((x) => x.startsWith("R1") && x.includes("BIOMETRIC_ERROR_NO_HARDWARE")),
      f.join("; "),
    ]);
  }
  // 4. Dropping an arm (the code falls into `else`) is caught.
  {
    const kt = KT_OK.replace(`            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "not-enrolled"\n`, "");
    const f = run(kt);
    cases.push([
      "an arm that disappears falls to `else` and is caught",
      f.some((x) => x.startsWith("R1") && x.includes("BIOMETRIC_ERROR_NONE_ENROLLED")),
      f.join("; "),
    ]);
  }
  // 5. A state the Rust enum does not have is caught.
  {
    const kt = KT_OK.replace(`-> "not-enrolled"`, `-> "unregistered"`);
    const f = run(kt);
    cases.push([
      "a state that is not a BiometricDeviceState variant is caught by R3",
      f.some((x) => x.startsWith("R3") && x.includes("unregistered")),
      f.join("; "),
    ]);
  }
  // 6. A constant the scan does not know is reported, never guessed.
  {
    const kt = KT_OK.replace(
      `BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "hw-unavailable"`,
      `BiometricManager.BIOMETRIC_ERROR_SOMETHING_NEW -> "hw-unavailable",
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "hw-unavailable"`,
    );
    const f = run(kt);
    cases.push([
      "an unknown androidx constant is reported, not guessed",
      f.some((x) => x.includes("BIOMETRIC_ERROR_SOMETHING_NEW")),
      f.join("; "),
    ]);
  }
  // 7. An `else` arm that hands an unclassifiable code a hardware answer is caught.
  {
    const kt = KT_OK.replace(`else -> "unknown"`, `else -> "no-hardware"`);
    const f = run(kt);
    cases.push([
      "an `else` that answers `no-hardware` for unknown codes is caught",
      f.some((x) => x.startsWith("R1") && x.includes("does not know falls to")),
      f.join("; "),
    ]);
  }
  // 8. **The shipped shape** — bare booleans — names both exchanged constants.
  {
    const f = run(KT_BOOL_SHAPE);
    const names = (x) => x.includes("BIOMETRIC_ERROR_NO_HARDWARE");
    const byOmission = (x) =>
      x.includes("BIOMETRIC_ERROR_NONE_ENROLLED") && x.includes("has no arm on this shape");
    cases.push([
      "the boolean shape names NO_HARDWARE (inverted) and NONE_ENROLLED (by omission)",
      f.some((x) => x.startsWith("R1") && names(x)) &&
        f.some((x) => x.startsWith("R1") && byOmission(x)) &&
        f.some((x) => x.startsWith("R0") && x.includes("bare booleans")),
      f.join("; ") || "no findings — the scan cannot see the shape that shipped",
    ]);
  }
  // 9. The repository's **own** two files, read from disk with no fixture substitution. The
  //    fixtures above pin the parser; this pins the answer — it is what makes the scan's
  //    green mean "the shipped Kotlin and the shipped Rust agree today", not "my fixtures
  //    agree with my fixtures".
  {
    const f = scan();
    cases.push(["the repository's own glue + rust are clean", f.length === 0, f.join("; ")]);
  }
  // 10. Floors: a file with no arms at all is red, not vacuously green.
  {
    const f = run("fun getAvailability(c: Context) = \"{}\"");
    cases.push(["a glue with no `when (canAuth)` is red (floors)", f.length > 0, f.join("; ")]);
  }
  // 11. **Prose is not code (REQ-A797 / F-DEV-098).** A doc comment quoting the *old* arms
  //     must not redden a file whose code is correct. Read raw, the quoted
  //     `NO_HARDWARE, HW_UNAVAILABLE -> "hw-unavailable"` is the first `when (canAuth)` in the
  //     file and first-match-wins hands NO_HARDWARE the wrong state.
  {
    const f = run(ktProse(PROSE_OLD_ARMS) + KT_OK);
    cases.push([
      "a comment quoting the old arms does not redden the fixed file",
      f.length === 0,
      f.join("; ") || "expected no findings",
    ]);
  }
  // 12. **The stronger harm: the same prose makes a regressed file green.** Here the comment
  //     quotes the *correct* arms while the code regressed `HW_UNAVAILABLE` to `"no-hardware"` —
  //     exactly the inverted-answer defect this scan exists for. Read raw, the quoted arm
  //     shadows the real one and the scan reports success on a file it should reject.
  {
    const regressed = KT_OK.replace(
      `BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "hw-unavailable"`,
      `BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "no-hardware"`,
    );
    const f = run(ktProse(PROSE_FIXED_ARMS) + regressed);
    cases.push([
      "a regressed arm is still caught with that comment above it",
      f.some((x) => x.startsWith("R1") && x.includes("BIOMETRIC_ERROR_HW_UNAVAILABLE")),
      f.join("; ") || "no findings — the comment's quotation answered for the code",
    ]);
    // And the control for the control: the same regressed code with no prose must be red too,
    // so case 12 can never pass by the regression itself being invisible.
    const bare = run(regressed);
    cases.push([
      "…and the same regressed arm is red without any comment above it",
      bare.some((x) => x.startsWith("R1") && x.includes("BIOMETRIC_ERROR_HW_UNAVAILABLE")),
      bare.join("; "),
    ]);
  }

  let failed = 0;
  for (const [name, ok, detail] of cases) {
    if (ok) console.log(`  ok  ${name}`);
    else {
      failed += 1;
      console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} self-test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${cases.length} self-tests passed.`);
  }
}

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (IS_MAIN) main();
