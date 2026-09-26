/**
 * declaredMirrors.test.ts — the frontend constants/functions that *declare* (in their own
 * docs) they mirror a Rust authority, bound to that authority by reading it.
 *
 * REQ-A644 fixed the first two instances of this class (`filesCompression.ts` bundle
 * constants ↔ `files.rs`, `ime.ts` fuzzy pairs ↔ `amos-ime/fuzzy.rs`) and left the rest of
 * the "must match the Rust side" comments unbound on purpose (its honesty boundary ③). This
 * file closes that boundary: each remaining declared frontend↔Rust mirror is read from the
 * Rust source here, so a rename/renumber on either side is a red at build time rather than a
 * wrong label (or a wrong emergency number) on a device.
 *
 * Each case also guards against the source-reading test going vacuous: it asserts the
 * extraction found the expected **count** before comparing, so a Rust rewrite that moves the
 * match body out of the scanned window fails loudly instead of comparing two empty lists.
 *
 * REQ-A648 extends the sweep to the four remaining declared mirrors F-SH-114 (REQ-A645) left
 * unbound: `telemetrySpy.ts`'s two wire structs ↔ `telemetry_spy.rs`, `clipboard.ts`'s
 * serde-tagged union ↔ `clipboard.rs::ClipboardPayload`, `settings.ts`'s `FlashlightStore` ↔
 * `flashlight.rs::FlashlightPayload`, and `devcare.ts`'s `CARE_AREAS` ↔ `amos-devocare`'s
 * `CareArea::key()` order.
 *
 * REQ-A669 goes one step past *declared* mirrors — to values the other side **consumes**: i)
 * the lifecycle-key vocabulary, which the bridge spells a third time in
 * `amos-tauri/src/taskmgr.rs::app_state_key` and which is then matched *as strings* by
 * `amos_devocare::reclaim_plan` (the「内存加速」planner) and branched on by
 * `svelte/TaskManager.svelte`'s action menu; ii) `audio.ts::TARGET_RATE`, the rate every
 * capture is resampled to before `interpret_audio` hands it to a pipeline whose clock is
 * `samples / AUDIO_SAMPLE_RATE_HZ`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TARGET_RATE } from "../lib/audio";
import { BOND_BONDED, BOND_BONDING, BOND_NONE } from "../lib/bluetooth";
import {
  CARE_AREAS,
  JUNK_KINDS,
  SENSITIVE_RESOURCES,
  junkKindLabelKey,
  resourceLabelKey,
} from "../lib/devcare";
import { EMERGENCY_NUMBERS, EMERGENCY_QUICK_NUMBER, isEmergencyNumber, quickEmergencyNumber } from "../lib/emergency";
import {
  counterSummary,
  healthKey,
  linkLevel,
  reportAgeText,
  type LinkMetrics,
  type LinkStatus,
} from "../lib/link";
import { orientationOf, rotationFreezes } from "../lib/rotation";
import {
  DEVICE_MIC_BACKENDS,
  IDLE_MIC_BACKEND,
  NATIVE_MIC_BACKENDS,
  isNativeMicBackend,
} from "../lib/deviceMic";
import { APP_ACTIONS, TASK_JOB_KINDS, TASK_STATE_KEYS, normalizeTaskSnapshot } from "../lib/taskmgr";
import { SNAP_KEYS } from "../lib/snapZones";
import { buttonActionOf } from "../lib/systemButtons";
import { canonicalPath } from "../lib/media";
import { DOWNLOAD_PROGRESS_EVENT } from "../lib/webmanDownloads";
import { normalizeDisplays, normalizeLayout, normalizePaneRects, normalizeWindows } from "../lib/wm";
import { LOCALE_KEY } from "../svelte/i18n";

const RUST_ROOT = "../../../../";

function readRust(rel: string): string {
  return readFileSync(new URL(RUST_ROOT + rel, import.meta.url), "utf8");
}

/** A frontend source file under `src/lib/` (read as text, so the binding covers a
 * bare `interface`/`type` whose symbols do not exist at runtime). */
function readLib(rel: string): string {
  return readFileSync(new URL("../lib/" + rel, import.meta.url), "utf8");
}

/** A frontend source file under `src/svelte/` (read as text — for a site that
 * spells a shared key by hand, outside the module that exports it). */
function readSvelte(rel: string): string {
  return readFileSync(new URL("../svelte/" + rel, import.meta.url), "utf8");
}

/** The `format!("…")` template literals inside `fn format_age_ms`, in source order. */
function ageTemplates(src: string): string[] {
  const i = src.indexOf("fn format_age_ms");
  expect(i, "format_age_ms not found in the CLI").toBeGreaterThan(0);
  const end = src.indexOf("\n}", i);
  expect(end).toBeGreaterThan(i);
  return [...src.slice(i, end).matchAll(/format!\("([^"]*)"\)/g)].map((m) => m[1] ?? "");
}

/** A Rust `format!` template as the RegExp for the strings it can render (`{h:02}` = two digits). */
function templateRegex(tpl: string): RegExp {
  const body = tpl
    .split(/(\{[^}]*\})/g)
    .map((p) =>
      p.startsWith("{")
        ? p.includes(":02")
          ? "\\d{2}"
          : "\\d+"
        : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${body}$`);
}

/** The `=> "lit"` string literals of a match body, from `from` to its closing brace. */
function arms(src: string, from: string): string[] {
  const i = src.indexOf(from);
  expect(i, `anchor "${from}" not found`).toBeGreaterThan(0);
  const body = src.slice(i, src.indexOf("\n    }", i));
  return [...body.matchAll(/=>\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("snapZones.SNAP_KEYS == amos_wm::snap::SnapZone::key()", () => {
  test("the chord table's zones are exactly the Rust wire keys, in wire order", () => {
    const rust = arms(readRust("amos-wm/src/snap.rs"), "pub fn key(self)");
    expect(rust).toHaveLength(9);
    // Ordered, not a set: `SnapZone::ALL` (and `key()`'s arms) fix the wire order, and the
    // table advertises the same order. A zone the host does not parse becomes a chord that
    // always gets refused; one missing here is a region no person can reach.
    expect(rust).toEqual(SNAP_KEYS.map((r) => r.zone));
  });
});

describe("emergency.quickEmergencyNumber == amos_telephony EmergencyMap::quick_dial", () => {
  test("every region Rust names maps to the same number the frontend returns", () => {
    const src = readRust("amos-telephony/src/number.rs");
    const anchor = "pub fn quick_dial(region: &str)";
    const i = src.indexOf(anchor);
    expect(i).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf("\n    }", i));

    // Arms look like `"CN" | "CN-HK" | "CN-MO" | "JP" | "KR" => "110"`.
    const pairs: Array<[string, string]> = [];
    for (const a of body.matchAll(/((?:"[A-Z-]+"\s*\|\s*)*"[A-Z-]+")\s*=>\s*"(\d+)"/g)) {
      for (const r of (a[1] ?? "").matchAll(/"([A-Z-]+)"/g)) pairs.push([r[1] ?? "", a[2] ?? ""]);
    }
    // The lock-screen one-tap number is safety-relevant: guard against a vacuous extraction
    // (the table names ≥ 10 regions across two lists) before trusting it.
    expect(pairs.length).toBeGreaterThanOrEqual(10);
    for (const [region, num] of pairs) {
      expect(quickEmergencyNumber(region), region).toBe(num);
    }

    // The universal default is a single `_` arm on the Rust side; the frontend must answer
    // the same for anything it does not special-case (incl. an empty/unknown region).
    expect(/_ => "\d+"/.exec(body)?.[0]).toBe('_ => "112"');
    for (const unknown of ["ZZ", "XX", "", "  ", "fr"]) {
      expect(quickEmergencyNumber(unknown), `default for ${JSON.stringify(unknown)}`).toBe("112");
    }
  });
});

// ─── REQ-A747: the dialer's emergency-number *page* list, bound to the daemon's table ───────
//
// `lib/emergency.ts`'s `EMERGENCY_NUMBERS` documents itself as the "CN-market primary set + the
// universal 112" that "Mirrors the Rust `EmergencyMap` family (see number.rs)". `emergency.test.ts`
// spells `known` as a **TS-local** literal and only guards `quickEmergencyNumber` — it never reads
// `number.rs`, and `declaredMirrors` above bound the *quick-dial* function, not this page list.
// The page renders each code as a red "emergency" button calling `emergencyDial(code)` — but the
// daemon re-classifies every dial: a code the dialer shows that `EmergencyMap` does **not**
// recognize is placed as a **regular** call, from a control labelled 紧急. That is the worst
// failure mode this module's own docs name ("a 110/112/911 misrouted as a regular call"). Bind the
// page list to the Rust table, both directions, so a one-sided edit is a build-time red.
describe("emergency.EMERGENCY_NUMBERS == the amos-telephony `EmergencyMap` table", () => {
  test("the emergency page lists exactly the CN table, and every code the daemon recognizes", () => {
    const src = readRust("amos-telephony/src/number.rs");

    // The daemon's broad fallback set (`common_global()`), read from `from_slice(&[…])`. Every
    // code the page shows must be here, or the "emergency" button is a plain call.
    const global = /pub fn common_global\(\) -> Self \{\s*Self::from_slice\(&\[([^\]]*)\]\)/
      .exec(src)?.[1];
    expect(global, "common_global() not found in number.rs").toBeTruthy();
    const recognized = [...(global ?? "").matchAll(/"(\d+)"/g)].map((m) => m[1] ?? "");
    // Non-vacuity: a rewrite that moves the list out of the scanned window must fail loudly.
    expect(recognized.length, "common_global() codes").toBeGreaterThanOrEqual(5);

    // The CN jurisdiction table: the `codes.extend([…])` arm, plus the universal 112 that
    // `for_region` appends to every region (dedup is a no-op for CN — it lists no 112).
    const cn = /"CN" \| "CN-HK" \| "CN-MO" => codes\.extend\(\[([^\]]*)\]\)/.exec(src)?.[1];
    expect(cn, "the CN arm of for_region not found").toBeTruthy();
    const cnCodes = [...(cn ?? "").matchAll(/"(\d+)"/g)].map((m) => m[1] ?? "");
    expect(cnCodes.length, "the CN arm's codes").toBe(4);
    expect(/\n\s+codes\.push\("112"\);/.test(src), "the universal 112 push").toBe(true);

    // Ordered, not a set: the page lists `EMERGENCY_NUMBERS` order and the CN table fixes it.
    expect([...EMERGENCY_NUMBERS] as string[]).toEqual([...cnCodes, "112"]);
    for (const c of EMERGENCY_NUMBERS as readonly string[]) {
      expect(recognized, `the page shows ${c}, which the daemon must recognize`).toContain(c);
    }
    // The lock-screen one-tap default dials a code the daemon routes on the privileged path.
    expect(recognized, "the one-tap number must be recognized").toContain(EMERGENCY_QUICK_NUMBER);
  });

  // The *other* direction of the same table, for a different consumer. `EMERGENCY_NUMBERS` is a
  // **presentation** list (the page's buttons); `isEmergencyNumber` answers a **classification**
  // question — "is this a call the daemon must route on its privileged emergency path?"
  // (`PhoneApp` / `ContactsApp` pass the answer as `telephony_dial`'s `emergency` argument). That
  // question must be at least as broad as the daemon's own table, or a real emergency is dialled
  // as an ordinary call and the provider refuses it (`MockTelephonyProvider::guard_regular`). The
  // `⊆ recognized` check above cannot see this: it only asks that the page shows nothing the
  // daemon would refuse, never that the classification covers everything the daemon would route
  // to the emergency path.
  test("every code the daemon recognizes is an emergency to the dial surfaces too", () => {
    const src = readRust("amos-telephony/src/number.rs");
    const global = /pub fn common_global\(\) -> Self \{\s*Self::from_slice\(&\[([^\]]*)\]\)/
      .exec(src)?.[1];
    expect(global, "common_global() not found in number.rs").toBeTruthy();
    const recognized = [...(global ?? "").matchAll(/"(\d+)"/g)].map((m) => m[1] ?? "");
    expect(recognized.length, "common_global() codes").toBeGreaterThanOrEqual(5);

    for (const c of recognized) {
      expect(
        isEmergencyNumber(c),
        `the daemon routes ${c} on the emergency path; the dial surfaces must classify it as one`,
      ).toBe(true);
    }
    // …and the classification is not the empty/"everything" predicate: a real number stays regular.
    for (const other of ["13800000001", "10086", "1100"]) {
      expect(isEmergencyNumber(other), other).toBe(false);
    }
  });
});

describe("systemButtons recognises the amos-tauri `hardware-button` vocabulary", () => {
  test("the two Rust spelling sites agree, and the frontend maps every value", () => {
    const src = readRust("amos-tauri/src/buttons.rs");
    // Rust spells the emitted vocabulary twice — the `take_pending_hardware_button` reply
    // (`hardware_name`) and the on-device DOM dispatch (`dispatch_dom`). Neither is tied to
    // the other (nor to the serde `rename` the Rust test pins), so bind all three here.
    const reply = arms(src, "fn hardware_name(b: HardwareButton)");
    const dom = arms(src, "fn dispatch_dom(app: &tauri::AppHandle");
    expect(reply).toEqual(["home", "voice", "ai_assistant"]);
    expect(dom).toEqual(reply);

    // Whatever the host emits must be an action the shell understands, else the button is a
    // silent no-op on-device.
    for (const name of reply) {
      expect(buttonActionOf(name), name).not.toBeNull();
    }
  });
});

describe("bluetooth BOND_* == amos_radio::bluetooth constants", () => {
  test("the three bond-state numbers are the Rust constants (and Android's real values)", () => {
    const src = readRust("amos-radio/src/bluetooth.rs");
    const num = (name: string): number => {
      const m = new RegExp(`pub const ${name}: i32 = (\\d+);`).exec(src);
      expect(m, `${name} not found in bluetooth.rs`).not.toBeNull();
      return Number(m?.[1]);
    };
    // A drift here relabels real paired devices (the frontend decodes the adapter's raw
    // `getBondState()`): 10/11/12 are `BluetoothDevice#BOND_*`.
    expect([BOND_NONE, BOND_BONDING, BOND_BONDED]).toEqual([num("BOND_NONE"), num("BOND_BONDING"), num("BOND_BONDED")]);
    expect([num("BOND_NONE"), num("BOND_BONDING"), num("BOND_BONDED")]).toEqual([10, 11, 12]);
  });
});

describe("telemetrySpy payloads mirror the amos-tauri `telemetry_spy.rs` structs", () => {
  test("both wire structs' field names are exactly the Rust `pub` fields, in order", () => {
    const rust = readRust("amos-tauri/src/telemetry_spy.rs");
    const ts = readLib("telemetrySpy.ts");

    // Rust: the `pub <name>:` fields of a struct body (the doc comments carry no `pub`).
    const rustFields = (name: string): string[] => {
      const i = rust.indexOf(`pub struct ${name} {`);
      expect(i, `${name} not found in telemetry_spy.rs`).toBeGreaterThan(0);
      const body = rust.slice(i, rust.indexOf("\n}", i));
      return [...body.matchAll(/pub (\w+):/g)].map((m) => m[1] ?? "");
    };
    // Frontend: the top-level `name:` fields of an interface (comments start with `/`/`*`).
    const tsFields = (name: string): string[] => {
      const i = ts.indexOf(`export interface ${name} {`);
      expect(i, `${name} not found in telemetrySpy.ts`).toBeGreaterThan(0);
      const body = ts.slice(i, ts.indexOf("\n}", i));
      return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] ?? "");
    };

    // Counts first: a Rust rewrite that moves a field out of the scanned window must
    // fail loudly, not compare two empty lists.
    const hit = rustFields("SpyIdentifierHit");
    expect(hit).toHaveLength(3);
    expect(tsFields("SpyIdentifierHit")).toEqual(hit);

    const payload = rustFields("SpyHitPayload");
    expect(payload).toHaveLength(11);
    expect(tsFields("SpyHitPayload")).toEqual(payload);
  });
});

describe("clipboard.ClipboardPayload mirrors the amos-tauri serde-tagged enum", () => {
  test("every variant tag and its field names are the Rust ones", () => {
    const src = readRust("amos-tauri/src/clipboard.rs");
    const decl = src.indexOf("pub enum ClipboardPayload {");
    expect(decl, "ClipboardPayload not found").toBeGreaterThan(0);
    // The tag is `kind` and the casing is snake_case — pin both before trusting the parse.
    const attrs = src.slice(decl - 120, decl);
    expect(attrs).toContain('tag = "kind"');
    expect(attrs).toContain('rename_all = "snake_case"');

    // Start *after* the enum's own `{`, or the declaration line matches as a variant.
    const body = src.slice(src.indexOf("{", decl) + 1, src.indexOf("\n}", decl));
    const rust = new Map<string, string[]>();
    for (const m of body.matchAll(/(\w+)\s*\{([^}]*)\}/g)) {
      const tag = (m[1] ?? "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
      rust.set(tag, [...(m[2] ?? "").matchAll(/(\w+):/g)].map((x) => x[1] ?? "").sort());
    }
    expect([...rust.keys()]).toEqual(["text", "html", "image", "uris"]);

    const ts = readLib("clipboard.ts");
    const start = ts.indexOf("export type ClipboardPayload =");
    expect(start, "ClipboardPayload not found").toBeGreaterThan(0);
    const tbody = ts.slice(start, ts.indexOf("};", start) + 1);
    const front = new Map<string, string[]>();
    for (const m of tbody.matchAll(/\{\s*kind:\s*"(\w+)"\s*;([^}]*)\}/g)) {
      const fields = [...(m[2] ?? "").matchAll(/(\w+)\s*:/g)]
        .map((x) => x[1] ?? "")
        .filter((f) => f !== "kind")
        .sort();
      front.set(m[1] ?? "", fields);
    }
    // A drifted tag is a payload the host cannot deserialize; a drifted field name
    // makes `entryText`/paste read `undefined`.
    expect([...front.keys()]).toEqual([...rust.keys()]);
    for (const [tag, fields] of rust) expect(front.get(tag), tag).toEqual(fields);
  });
});

describe("settings.FlashlightStore keys exist on the amos-tauri `FlashlightPayload`", () => {
  test("every key the shell reads is a real Rust payload field", () => {
    const rust = readRust("amos-tauri/src/flashlight.rs");
    const i = rust.indexOf("pub struct FlashlightPayload {");
    expect(i, "FlashlightPayload not found").toBeGreaterThan(0);
    const body = rust.slice(i, rust.indexOf("\n}", i));
    const rustFields = [...body.matchAll(/pub (\w+):/g)].map((m) => m[1] ?? "");
    // `available` joined the payload; `on`/`torch_present` are the store's two keys.
    expect(rustFields).toEqual(["on", "torch_present", "available"]);

    const ts = readLib("settings.ts");
    const j = ts.indexOf("export interface FlashlightStore {");
    expect(j, "FlashlightStore not found").toBeGreaterThan(0);
    const tbody = ts.slice(j, ts.indexOf("\n}", j));
    const ks = [...tbody.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] ?? "");
    expect(ks).toEqual(["on", "torch_present"]);
    // A rename on either side makes `torchOn` read `undefined` → "torch off" for a lit
    // torch; bind the store's keys to the Rust fields rather than to themselves.
    for (const k of ks) expect(rustFields, k).toContain(k);
  });
});

describe("devcare.CARE_AREAS is amos-devocare's `CareArea::key()` order", () => {
  test("the four area keys are the Rust enum's wire keys, in domain order", () => {
    const src = readRust("amos-devocare/src/spec.rs");
    // Anchor inside `impl CareArea` — six other types in this file also have `key(self)`.
    const impl = src.indexOf("impl CareArea {");
    expect(impl, "impl CareArea not found").toBeGreaterThan(0);
    const from = src.indexOf("pub const fn key(self)", impl);
    const to = src.indexOf("pub const fn label_key", from);
    expect(from, "CareArea::key not found").toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const rust = [...src.slice(from, to).matchAll(/=>\s*"([a-z_]+)"/g)].map((m) => m[1] ?? "");
    // Order matters (the screen renders `CARE_AREAS` order; the domain orders the enum
    // Storage → Apps → Battery → Permissions), and the `label_key` arms are excluded from
    // the window so a `care.area.*` string cannot be mistaken for a key.
    expect(rust).toHaveLength(4);
    expect(rust).toEqual([...CARE_AREAS]);
  });
});

describe("devcare.JUNK_KINDS is amos-devocare's `JunkKind` tags, labels are `label_key()`", () => {
  test("the junk tags and their i18n keys are the Rust `JunkKind` vocabulary, in enum order", () => {
    const src = readRust("amos-devocare/src/spec.rs");
    // Anchor inside `impl JunkKind` — several other types in this file also have `key(self)`.
    const impl = src.indexOf("impl JunkKind {");
    expect(impl, "impl JunkKind not found").toBeGreaterThan(0);
    const keyFrom = src.indexOf("pub const fn key(self)", impl);
    const keyTo = src.indexOf("pub const fn label_key", keyFrom);
    const labelTo = src.indexOf("pub const fn is_auto_cleanable", keyTo);
    expect(keyFrom, "JunkKind::key not found").toBeGreaterThan(0);
    expect(keyTo).toBeGreaterThan(keyFrom);
    expect(labelTo).toBeGreaterThan(keyTo);
    const keys = [...src.slice(keyFrom, keyTo).matchAll(/=>\s*"([a-z_]+)"/g)].map((m) => m[1] ?? "");
    const labels = [...src.slice(keyTo, labelTo).matchAll(/=>\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    // A rewrite that moves the arms out of the scanned window must fail loudly rather than
    // compare two empty lists.
    expect(keys).toHaveLength(8);
    expect(labels).toHaveLength(8);
    // Ordered: the screen lists `JUNK_KINDS` order and the domain orders the enum the same way.
    expect(keys).toEqual([...JUNK_KINDS]);
    for (let i = 0; i < keys.length; i++) {
      expect(junkKindLabelKey(keys[i]!), keys[i]).toBe(labels[i]!);
    }
  });
});

describe("devcare.SENSITIVE_RESOURCES is amos-devocare's `SensitiveResource`, labels are `label_key()`", () => {
  test("the resource tags and their i18n keys are the Rust vocabulary, in enum order", () => {
    const src = readRust("amos-devocare/src/spec.rs");
    const impl = src.indexOf("impl SensitiveResource {");
    expect(impl, "impl SensitiveResource not found").toBeGreaterThan(0);
    const keyFrom = src.indexOf("pub const fn key(self)", impl);
    const keyTo = src.indexOf("pub const fn label_key", keyFrom);
    const labelTo = src.indexOf("pub fn from_key", keyTo);
    expect(keyFrom, "SensitiveResource::key not found").toBeGreaterThan(0);
    expect(keyTo).toBeGreaterThan(keyFrom);
    expect(labelTo).toBeGreaterThan(keyTo);
    const keys = [...src.slice(keyFrom, keyTo).matchAll(/=>\s*"([a-z_]+)"/g)].map((m) => m[1] ?? "");
    const labels = [...src.slice(keyTo, labelTo).matchAll(/=>\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(keys).toHaveLength(7);
    expect(labels).toHaveLength(7);
    expect(keys).toEqual([...SENSITIVE_RESOURCES]);
    for (let i = 0; i < keys.length; i++) {
      expect(resourceLabelKey(keys[i]!), keys[i]).toBe(labels[i]!);
    }
  });
});

// ─── REQ-A669: the values the other side *reads*, not the shapes it declares ────────────────
//
// The sweeps above bind declared frontend↔Rust shapes and vocabularies. These two are the same
// class one step further out — values the host **consumes as strings / as a rate** — and neither
// side read the other. Both fail *silently* when they drift: nothing throws, nothing is logged,
// the feature just quietly stops working (a card that frees nothing, a transcript at 3× speed).

describe("taskmgr vocabulary == amos-tauri::taskmgr", () => {
  const rust = () => readRust("amos-tauri/src/taskmgr.rs");

  /** The `=> "lit"` arms of a module-level `match` body. */
  function matchKeys(src: string, anchor: string): string[] {
    const i = src.indexOf(anchor);
    expect(i, `anchor "${anchor}" not found`).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf("\n    }", i));
    return [...body.matchAll(/=>\s*"([a-z_]+)"/g)].map((m) => m[1] ?? "");
  }

  test("every lifecycle key the bridge can emit survives normalization", () => {
    const emitted = matchKeys(rust(), "pub fn app_state_key(v: i32) -> &'static str {");
    // Non-vacuity: five proto tiers + the `unknown` sentinel. A Rust rewrite that moves the
    // arms out of the scanned window must fail loudly rather than compare against nothing.
    expect(emitted).toHaveLength(6);
    // Behavioural, not a text comparison: an unknown key is coerced to "unknown", so a rename on
    // the bridge side would read a live app as unknown — `appIsRunning` false, and the action
    // menu (`svelte/TaskManager.svelte`) would offer "foreground" **and "kill"** for the app the
    // user is looking at — while every pre-existing frontend test (local literals only) stayed
    // green and the Rust suite's own key tests compared the file to itself.
    for (const k of emitted) {
      const s = normalizeTaskSnapshot({ apps: [{ id: "com.amos.app", state: k }] });
      expect([k, s.apps[0]?.state], `state ${k} must survive normalization`).toEqual([k, k]);
    }
  });

  test("every job kind the bridge can emit survives normalization", () => {
    const emitted = matchKeys(rust(), "pub fn job_kind_key(v: i32) -> &'static str {");
    expect(emitted).toHaveLength(3);
    for (const k of emitted) {
      const s = normalizeTaskSnapshot({ jobs: [{ id: "j", kind: k, earliest: 0, latest: 0 }] });
      expect([k, s.jobs[0]?.kind], `kind ${k} must survive normalization`).toEqual([k, k]);
    }
  });

  test("every action the UI can send is a token the bridge parses", () => {
    const src = rust();
    const i = src.indexOf("pub fn parse_action(s: &str) -> Option<AppAction> {");
    expect(i, "parse_action not found").toBeGreaterThan(0);
    // The body's string literals *are* the accepted tokens (arms read `"freeze" | "cached" =>`).
    const accepted = [...src.slice(i, src.indexOf("\n    }", i)).matchAll(/"([a-z_]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    // Five actions + two aliases (`cached`, `unregister`) — a vacuous read must fail.
    expect(accepted).toHaveLength(7);
    for (const a of APP_ACTIONS) expect(accepted, `the UI may send ${a}`).toContain(a);
  });

  test("the UI's lifecycle vocabulary is the kernel's key set and covers the bridge's", () => {
    const emitted = matchKeys(rust(), "pub fn app_state_key(v: i32) -> &'static str {");
    // The UI's sixth key (`visible`) is real, but it belongs to the *other* authority: the LMK
    // snapshot carries `amos_applife::AppState::key()`'s keys (`lib/android.ts`). Requiring both
    // directions means the UI can never recognise a state neither authority can produce.
    const spec = readRust("amos-applife/src/spec.rs");
    const at = spec.indexOf("pub fn key(self) -> &'static str {");
    expect(at, "AppState::key() not found").toBeGreaterThan(0);
    const kernel = [
      ...spec.slice(at, spec.indexOf("\n    }", at)).matchAll(/AppState::\w+ => "([a-z_]+)"/g),
    ].map((m) => m[1] ?? "");
    expect(kernel).toHaveLength(6);
    expect([...(TASK_STATE_KEYS as readonly string[])].sort()).toEqual([...kernel].sort());
    for (const k of emitted.filter((k) => k !== "unknown")) {
      expect(TASK_STATE_KEYS as readonly string[], `the bridge emits ${k}`).toContain(k);
    }
  });

  test("the UI's job-kind list is the bridge's, minus the sentinel", () => {
    const emitted = matchKeys(rust(), "pub fn job_kind_key(v: i32) -> &'static str {");
    expect([...(TASK_JOB_KINDS as readonly string[])].sort()).toEqual(
      emitted
        .filter((k) => k !== "unknown")
        .sort(),
    );
  });
});
describe("audio.TARGET_RATE == amos_int::pipeline::AUDIO_SAMPLE_RATE_HZ", () => {
  test("the rate the WebView resamples to is the rate the pipeline consumes", () => {
    const src = readRust("amos-int/src/pipeline.rs");
    const at = src.indexOf("pub const AUDIO_SAMPLE_RATE_HZ: u32 =");
    expect(at, "AUDIO_SAMPLE_RATE_HZ not found in amos-int/src/pipeline.rs").toBeGreaterThan(0);
    const m = /=\s*(\d[\d_]*)/.exec(src.slice(at, at + 80));
    expect(m, "AUDIO_SAMPLE_RATE_HZ has no integer literal").not.toBeNull();
    const hz = Number((m?.[1] ?? "").replace(/_/g, ""));
    // Non-vacuity: a parsed 0 / NaN would satisfy an equality only by accident.
    expect(hz).toBeGreaterThan(0);
    // `lib/audio.ts` resamples every capture to `TARGET_RATE` (the `interpret_audio` caller in
    // `svelte/InterpApp.svelte`, and the WAV header in `lib/voice.ts`), and the host hands the
    // `Vec<f32>` straight to a pipeline whose audio clock is `samples / AUDIO_SAMPLE_RATE_HZ`.
    // A drift here mis-recognises and mis-times every transcript with **no error path** — the
    // command seam only bounds the sample *count* (`MAX_INTERPRET_AUDIO_SAMPLES`).
    expect(TARGET_RATE).toBe(hz);
  });
});

// ─── REQ-A666: the egress-guard's reply shapes on the wire the WebView actually reads ────────
//
// `lib/netguard.ts` documents its three interfaces as the *serializable mirror* of the daemon's
// replies. The JSON the WebView sees is produced by the Tauri bridge's own serde structs
// (`crates/amos-tauri/src/netguard.rs`), whose field names are the wire keys — so a rename there
// (or on the proto it is compiled against) turns `s.top_egress` / `s.policy_rules` / `t.message`
// into `undefined` with **no** error path: the Settings "Network Guard" page silently renders an
// empty audit table and a missing arm confirmation. Every pre-existing netguard test builds its
// fixtures from **local literals** (`netguard.test.ts`), so it stayed green either way.

describe("netguard TS mirrors the amos-tauri `netguard.rs` serializable structs", () => {
  test("every reply struct's field names are exactly the Rust `pub` fields, in order", () => {
    const rust = readRust("amos-tauri/src/netguard.rs");
    const ts = readLib("netguard.ts");

    // Rust: the `pub <name>:` fields of a struct body (doc comments carry no `pub`).
    const rustFields = (name: string): string[] => {
      const i = rust.indexOf(`pub struct ${name} {`);
      expect(i, `${name} not found in netguard.rs`).toBeGreaterThan(0);
      const body = rust.slice(i, rust.indexOf("\n}", i));
      return [...body.matchAll(/pub (\w+):/g)].map((m) => m[1] ?? "");
    };
    // Frontend: the top-level `name:` fields of an interface (comment lines start with `/`/`*`).
    const tsFields = (name: string): string[] => {
      const i = ts.indexOf(`export interface ${name} {`);
      expect(i, `${name} not found in netguard.ts`).toBeGreaterThan(0);
      const body = ts.slice(i, ts.indexOf("\n}", i));
      return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] ?? "");
    };

    // Counts first: a rewrite that moves a field out of the scanned window must fail loudly
    // rather than compare two empty lists.
    const toggle = rustFields("NetGuardToggle");
    expect(toggle).toHaveLength(2);
    expect(tsFields("NetGuardToggle")).toEqual(toggle);

    const sample = rustFields("NetGuardEgressSample");
    expect(sample).toHaveLength(2);
    expect(tsFields("NetGuardEgressSample")).toEqual(sample);

    const status = rustFields("NetGuardStatus");
    expect(status).toHaveLength(6);
    expect(tsFields("NetGuardStatus")).toEqual(status);
  });
});

// ─── REQ-A740: the rotation reply shapes the shell reads from `rotation_get` / `rotation_set` ──
//
// `lib/rotation.ts` declares `RotationSnapshot` / `RotationApplied` as "宿主 `rotation_get` 的应答
// 形状（`RotationSnapshot`，camelCase）" / "…`rotation_set`…（`RotationApplied`，camelCase）", with the
// nested `outcome` as the `{state, detail?}` tagged shape. The Rust authority
// (`crates/amos-tauri/src/rotation.rs`) pins its own JSON with **Rust-local** `json!` literals
// (`the_snapshot_and_applied_payloads_are_camel_case` / `the_outcome_wire_shape_is_the_tagged_enum`),
// and `rotation.test.ts` builds every fixture from a **TS-local literal** — neither reads across. So
// a rename of `available` on the Rust side (mirrored in its own test) leaves the UI reading
// `applied.available === undefined` (falsy ⇒ "this host cannot orient" on every device), and renaming
// the `HostOnly` variant's wire word silently reclassifies a desktop no-op as a refused device —
// **no error path**. The two commands reach the host through the dynamic `invoke(command, args)`
// helper, so `tauri-reply-scan.mjs` cannot see them either (the gate's documented boundary). Bind the
// two sides here, the SMS-trash shape REQ-A667 bound for the layout shapes.
describe("rotation.ts reply shapes == the amos-tauri `rotation.rs` serializable structs", () => {
  /** The `pub <name>:` fields of a serde struct body, in declaration order. */
  const rustFields = (rust: string, name: string): string[] => {
    const i = rust.indexOf(`pub struct ${name} {`);
    expect(i, `${name} not found in rotation.rs`).toBeGreaterThan(0);
    const body = rust.slice(i, rust.indexOf("\n}", i));
    return [...body.matchAll(/pub (\w+):/g)].map((m) => m[1] ?? "");
  };
  /** The top-level `name:` fields of an interface (comment lines start with `/`/`*`). */
  const tsFields = (ts: string, name: string): string[] => {
    const i = ts.indexOf(`export interface ${name} {`);
    expect(i, `${name} not found in rotation.ts`).toBeGreaterThan(0);
    const body = ts.slice(i, ts.indexOf("\n}", i));
    return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] ?? "");
  };
  /** The serde `rename_all = "snake_case"` word for a variant name. */
  const snake = (s: string): string =>
    s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

  test("the snapshot / applied field names are exactly the Rust `pub` fields, in order", () => {
    const rust = readRust("amos-tauri/src/rotation.rs");
    const ts = readLib("rotation.ts");

    // Counts first: a rewrite that moves a struct out of the scanned window must fail loudly
    // rather than compare two empty lists.
    const snap = rustFields(rust, "RotationSnapshot");
    expect(snap).toHaveLength(2);
    expect(tsFields(ts, "RotationSnapshot")).toEqual(snap);

    const applied = rustFields(rust, "RotationApplied");
    expect(applied).toHaveLength(3);
    expect(tsFields(ts, "RotationApplied")).toEqual(applied);
  });

  test("`outcome` is the `{state, detail?}` tagged enum on both sides, and the UI's words exist", () => {
    const rust = readRust("amos-tauri/src/rotation.rs");
    const ts = readLib("rotation.ts");

    // The wire is the tag/content pair the TS `outcome: { state: string; detail?: string }` reads.
    const enumAt = rust.indexOf("pub enum RotationOutcome {");
    expect(enumAt, "RotationOutcome not found in rotation.rs").toBeGreaterThan(0);
    const head = rust.slice(rust.lastIndexOf("#[serde", enumAt), enumAt);
    expect(head).toContain('rename_all = "snake_case"');
    expect(head).toContain('tag = "state"');
    expect(head).toContain('content = "detail"');

    // The wire words the UI branches on must be words the enum can emit: `classifyRotationOutcome`
    // special-cases `applied` and `host_only`, so both variants must still exist.
    const body = rust.slice(enumAt, rust.indexOf("\n}", enumAt));
    const variants = [...body.matchAll(/^\s{4}(\w+)(?:\(|,)/gm)].map((m) => snake(m[1] ?? ""));
    expect(variants).toHaveLength(6);
    expect(variants).toContain("applied");
    expect(variants).toContain("host_only");
    // …and the TS side reads exactly those two literals (a rename here would fall through to
    // `unapplied` for the desktop `host_only` no-op).
    expect(ts).toContain('state === "applied"');
    expect(ts).toContain('state === "host_only"');
  });

  test("orientationOf's rule (strict; a square is portrait) == the kernel's `orientation_of`", () => {
    const rust = readRust("amos-display/src/orientation.rs");
    const at = rust.indexOf("pub fn orientation_of(");
    expect(at, "orientation_of not found in orientation.rs").toBeGreaterThan(0);
    const body = rust.slice(at, rust.indexOf("\n}", at));
    // The width/height comparison must be **strict** — a `>=`/`<=` would make a square
    // landscape and diverge from the home grid the doc says it matches.
    const cmp = /(width|height)\s*(<=?|>=?)\s*(width|height)/.exec(body);
    expect(cmp, "orientation_of's width/height comparison").not.toBeNull();
    expect(cmp?.[2], "must be strict so a square counts as portrait").toBe(
      cmp?.[1] === "width" ? ">" : "<",
    );
    // The TS mirror agrees on the boundary the doc names (square ⇒ portrait).
    expect(orientationOf(1000, 1000)).toBe("portrait");
    expect(orientationOf(1001, 1000)).toBe("landscape");
    expect(orientationOf(1000, 1001)).toBe("portrait");
  });

  test("rotationFreezes is exactly the kernel's non-freezing set", () => {
    const rust = readRust("amos-display/src/orientation.rs");
    const impl = rust.indexOf("impl RotationMode {");
    const keyFrom = rust.indexOf("pub fn key(self)", impl);
    const freezesFrom = rust.indexOf("pub fn freezes(self)", keyFrom);
    expect(keyFrom, "RotationMode::key not found").toBeGreaterThan(0);
    expect(freezesFrom).toBeGreaterThan(keyFrom);

    // `key()`: `RotationMode::Variant => "word"` arms — the variant↔word map.
    const pairs = [
      ...rust.slice(keyFrom, freezesFrom).matchAll(/RotationMode::(\w+)\s*=>\s*"([^"]+)"/g),
    ].map((m) => [m[1]!, m[2]!] as const);
    expect(pairs.length, "key() arms").toBe(4);
    const word = new Map(pairs);

    // `freezes()` is `!matches!(self, RotationMode::X)` — X is the *one* non-freezing mode.
    const fbody = rust.slice(freezesFrom, rust.indexOf("\n    }", freezesFrom));
    const rest = [...fbody.matchAll(/RotationMode::(\w+)/g)].map((m) => m[1]!);
    expect(rest, "freezes() names exactly one non-freezing mode").toHaveLength(1);
    const neverFreezes = word.get(rest[0]!)!;
    expect(neverFreezes, "the non-freezing mode must be `auto`").toBe("auto");

    // TS agrees for every mode, not just the boundary.
    for (const [, w] of pairs) {
      expect(rotationFreezes(w as never), `freezes(${w})`).toBe(w !== neverFreezes);
    }
  });
});

// ─── REQ-A667: the layout wire shapes the shell reads from `wm_layout_snapshot` ──────────────
//
// `lib/wm.ts`'s header declares its `LayoutSnapshot` / `SplitLayoutInfo` / `PaneLayout` interfaces
// "mirror the Rust `LayoutSnapshot` / `SplitLayoutInfo` / `PaneLayout`", and the two sides' own
// tests each claim the *other* pins them — `wm.test.ts`'s "the mirrored key set is exactly the
// Rust wire shape" says it is "pinned on the Rust side by `the_layout_snapshot_wire_shape_is_pinned`",
// while that Rust test says "the TS mirror is pinned by `wm.test.ts`'s key-set test". But neither
// reads across: the TS test compares `normalizeLayout({})` (a local literal, invariant to the host)
// to a TS literal, and the Rust test compares its serialized keys to a Rust-local `vec!`. Rename
// one side's field, mirror the change in that side's own literal, and both suites stay green while
// the other side reads `undefined` and silently falls back to phone defaults — the SMS-trash shape
// (`tauri-reply-scan.mjs` cannot see this command: `lib/wm.ts` reaches the host through a dynamic
// `invoke(command, args)` helper). Bind the two sides here.
describe("wm.ts layout wire shapes == the amos-tauri::wm serde structs", () => {
  test("the snapshot / split / pane field names are exactly the Rust `pub` fields, in order", () => {
    const rust = readRust("amos-tauri/src/wm.rs");
    /** The `pub <name>:` fields of a serde struct body, in declaration order. */
    const rustFields = (name: string): string[] => {
      const i = rust.indexOf(`pub struct ${name} {`);
      expect(i, `${name} not found in wm.rs`).toBeGreaterThan(0);
      const body = rust.slice(i, rust.indexOf("\n}", i));
      // The wire key equals the field name only if the struct does not rename: a `#[serde(rename…)]`
      // anywhere in the body would make this parse compare the wrong thing.
      expect(body, `${name} must not rename its wire keys`).not.toContain("rename");
      return [...body.matchAll(/pub (\w+):/g)].map((m) => m[1] ?? "");
    };

    // Counts first: a rewrite that moves a struct out of the scanned window must fail loudly
    // rather than compare two empty lists. Ordered, not a set — the normalizers build the object
    // in the Rust declaration order, and `Object.keys` preserves it.
    const snapshot = rustFields("LayoutSnapshot");
    expect(snapshot).toHaveLength(10);
    expect(Object.keys(normalizeLayout({}))).toEqual(snapshot);

    const split = rustFields("SplitLayoutInfo");
    expect(split).toHaveLength(5);
    expect(Object.keys(normalizeLayout({ split: {} }).split ?? {})).toEqual(split);

    const pane = rustFields("PaneLayout");
    expect(pane).toHaveLength(5);
    expect(
      Object.keys(normalizePaneRects([{ width: 1, height: 1 }, { width: 1, height: 1 }])?.[0] ?? {}),
    ).toEqual(pane);
  });
});

// ─── REQ-A704: the window-list wire shapes the shell reads from `wm_windows` ─────────────────
//
// `lib/wm.ts`'s `WmWindowInfo` / `WmWindowsSnapshot` declare they mirror `amos-tauri::wm`'s
// `WindowInfo` / `WmSnapshot` ("One window in the host's `wm_windows` snapshot (Rust
// `wm::WindowInfo`)", "The host's whole windowing state (Rust `wm::WmSnapshot`)"). Neither side
// reads the other: the Rust structs carry no wire-shape pin at all (unlike `LayoutSnapshot`, whose
// `the_layout_snapshot_wire_shape_is_pinned` pins a Rust-local `vec!`), and `wm.test.ts`'s
// `normalizeWindows` cases compare to a TS-local literal — both invariant to the host. `wm_windows`
// is reached through the dynamic `invoke(command, args)` helper, so `tauri-reply-scan.mjs` cannot
// name the reply generic and see it either (the gate's documented boundary). Rename a Rust field
// and `windowOf` reads `undefined` and falls back per field — id `0`, a label-derived app, kind
// `"Unknown"` — so the Dock's running dot and AppExpose quietly degrade instead of failing. This is
// the same SMS-trash shape REQ-A667 bound for the layout shapes; bind the window-list shapes here.
describe("wm.ts window-list wire shapes == the amos-tauri::wm serde structs", () => {
  test("the window / snapshot field names are exactly the Rust `pub` fields, in order", () => {
    const rust = readRust("amos-tauri/src/wm.rs");
    /** The `pub <name>:` fields of a serde struct body, in declaration order. */
    const rustFields = (name: string): string[] => {
      const i = rust.indexOf(`pub struct ${name} {`);
      expect(i, `${name} not found in wm.rs`).toBeGreaterThan(0);
      const body = rust.slice(i, rust.indexOf("\n}", i));
      // The wire key equals the field name only if the struct does not rename: a `#[serde(rename…)]`
      // anywhere in the body would make this parse compare the wrong thing.
      expect(body, `${name} must not rename its wire keys`).not.toContain("rename");
      return [...body.matchAll(/pub (\w+):/g)].map((m) => m[1] ?? "");
    };

    // Counts first: a rewrite that moves a struct out of the scanned window must fail loudly
    // rather than compare two empty lists. Ordered, not a set — `windowOf` builds the record in
    // the Rust declaration order, and `Object.keys` preserves it.
    const window = rustFields("WindowInfo");
    expect(window).toHaveLength(8);
    expect(Object.keys(normalizeWindows({ windows: [{ label: "x" }] }).windows[0] ?? {})).toEqual(
      window,
    );

    const snapshot = rustFields("WmSnapshot");
    expect(snapshot).toHaveLength(2);
    expect(Object.keys(normalizeWindows({}))).toEqual(snapshot);
  });
});

// ─── REQ-A690: the display wire shapes the shell reads from `wm_displays` ────────────────────
//
// `lib/wm.ts`'s `DisplayInfo` / `DisplaySet` declare they mirror `amos_wm::display::{Display,
// DisplaySet}`. Unlike the layout shapes (which live in `amos-tauri::wm`), the display domain
// is the pure `amos-wm` crate, so the authority read here is `amos-wm/src/display.rs`. Bind
// the two so a rename on either side is a build-time red rather than a consumer reading
// `undefined` and falling back to a fabricated single display.
describe("wm.ts display wire shapes == the amos-wm::display serde structs", () => {
  test("the display / display-set field names are exactly the Rust `pub` fields, in order", () => {
    const rust = readRust("amos-wm/src/display.rs");
    const rustFields = (name: string): string[] => {
      const i = rust.indexOf(`pub struct ${name} {`);
      expect(i, `${name} not found in display.rs`).toBeGreaterThan(0);
      const body = rust.slice(i, rust.indexOf("\n}", i));
      expect(body, `${name} must not rename its wire keys`).not.toContain("rename");
      return [...body.matchAll(/pub (\w+):/g)].map((m) => m[1] ?? "");
    };

    const display = rustFields("Display");
    expect(display).toHaveLength(5);
    expect(Object.keys(normalizeDisplays({ displays: [{}] }).displays[0] ?? {})).toEqual(display);

    const set = rustFields("DisplaySet");
    expect(set).toHaveLength(1);
    expect(Object.keys(normalizeDisplays({}))).toEqual(set);
  });
});

// ─── REQ-A692: the robot-link control-plane reply shapes the operator panel reads ────────────
//
// `lib/link.ts` declares `LinkStatus` as the "Serializable mirror of the daemon `LinkStatus`
// (matches the Rust serde keys)" and its four nested shapes (`LinkMetrics` / `LinkPeer` /
// `LinkRefusal` / `LinkActuation`) likewise. The authority the WebView actually parses is the
// bridge's own `*Out` structs in `crates/amos-tauri/src/link.rs` (prost structs are not
// `Serialize`, so the bridge re-spells them). The Rust side pins *itself*: e.g.
// `a_peer_serializes_to_the_same_five_fields_the_cli_prints` asserts the serialized keys against
// a Rust-local array and a JSON literal, and its doc claims "one peer table, one spelling across
// the CLI, the control plane and this bridge" — while reading only Rust. No test reads `link.rs`
// from the frontend, so a Rust field rename (with that side's own literal updated) leaves both
// suites green and the panel reads `undefined` (`status.health_reasons` vanishes, `metrics.
// published` goes blank — no error path). Bind the two sides here.
describe("link.ts status shapes == the amos-tauri `link.rs` serializable structs", () => {
  test("every reply struct's field names are exactly the Rust `pub` fields, in order", () => {
    const rust = readRust("amos-tauri/src/link.rs");
    const ts = readLib("link.ts");
    const rustFields = (name: string): string[] => {
      const i = rust.indexOf(`pub struct ${name} {`);
      expect(i, `${name} not found in link.rs`).toBeGreaterThan(0);
      const body = rust.slice(i, rust.indexOf("\n}", i));
      expect(body, `${name} must not rename its wire keys`).not.toContain("rename");
      return [...body.matchAll(/pub (\w+):/g)].map((m) => m[1] ?? "");
    };
    const ifaceFields = (name: string): string[] => {
      const i = ts.indexOf(`export interface ${name} {`);
      expect(i, `${name} not found in link.ts`).toBeGreaterThan(0);
      const body = ts.slice(i, ts.indexOf("\n}", i));
      return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] ?? "");
    };

    // Counts first, then ordered equality: a rewrite that moves a struct out of the scanned
    // window must fail loudly rather than compare two empty lists.
    const pairs: Array<[iface: string, mirror: string, len: number]> = [
      ["LinkStatus", "LinkStatusOut", 10],
      ["LinkMetrics", "LinkMetricsOut", 6],
      ["LinkPeer", "LinkPeerOut", 5],
      ["LinkRefusal", "LinkRefusalOut", 2],
      ["LinkActuation", "LinkActuationOut", 10],
    ];
    for (const [iface, mirror, len] of pairs) {
      const fields = rustFields(mirror);
      expect(fields, `${mirror} field count`).toHaveLength(len);
      expect(ifaceFields(iface), iface).toEqual(fields);
    }
  });
});

// ─── REQ-A827: the panel's counter line ↔ the `amos-link` `MetricsSnapshot` vocabulary ────────
//
// `lib/link.ts::counterSummary` declares, in its own doc, that the tokens it prints are
// "**machine field names** (the same tokens the CLI and the daemon's `NodeStatus` use)". The
// authority for that vocabulary is `crates/amos-link/src/metrics.rs::MetricsSnapshot` — the
// struct `NodeStatus` serializes, with no `#[serde(rename)]`, so its `pub` field names *are* the
// wire keys. Nothing reads it from the frontend: `link.test.ts` pins `counterSummary` against
// **TS-local** string literals and the bridge's `LinkMetricsOut` is built from the *proto*
// `Metrics` message, not from this struct. So a rename on the authority (with the authority's
// own local test and the CLI updated) keeps every suite green while the panel claims a
// vocabulary it no longer speaks — an operator greps a terminal and a panel for the same counter
// and gets two different names, silently. The bind is one-directional: the panel is the mirror,
// `MetricsSnapshot` is the authority.
describe("the panel's counter line == the amos-link `MetricsSnapshot` field names", () => {
  test("every token `counterSummary` prints is a `MetricsSnapshot` wire field, in order", () => {
    const rust = readRust("amos-link/src/metrics.rs");
    const ts = readLib("link.ts");

    const i = rust.indexOf("pub struct MetricsSnapshot {");
    expect(i, "MetricsSnapshot not found in metrics.rs").toBeGreaterThan(0);
    const body = rust.slice(i, rust.indexOf("\n}", i));
    // The field names are the wire keys only without a rename attribute — guard the premise.
    expect(body, "MetricsSnapshot must not rename its wire keys").not.toContain("rename");
    const fields = [...body.matchAll(/pub (\w+):/g)].map((m) => m[1] ?? "");
    // Count first: a rewrite that moves the struct out of the scanned window must fail loudly
    // rather than compare two empty lists.
    expect(fields, "MetricsSnapshot field count").toHaveLength(6);

    // A `LinkMetrics` whose counters are all distinct: a swapped binding cannot pass by
    // collision, and the interface's own field names are pinned by the literal below.
    const m: LinkMetrics = {
      published: 1,
      delivered: 2,
      dropped: 3,
      blocked: 4,
      decode_errors: 5,
      encode_errors: 6,
    };

    // The tokens, in order, exactly the authority's field names.
    const tokens = [...counterSummary(m).matchAll(/([a-z_]+)=\d+/g)].map((m) => m[1] ?? "");
    expect(tokens).toEqual(fields);

    // …and each token carries *its own* counter (3 ↔ `dropped`, not 3 ↔ `delivered`).
    for (const f of fields) {
      const v = (m as unknown as Record<string, number>)[f];
      expect(v, `${f} is not a LinkMetrics field`).toBeTypeOf("number");
      expect(counterSummary(m), f).toContain(`${f}=${v}`);
    }

    // Guard the extraction found the line, not a window of it (`counterSummary` prints six).
    expect(tokens).toHaveLength(6);
    expect(ts).toContain("export function counterSummary");
  });
});

// ─── REQ-A795: the panel's link **verdict vocabulary** ↔ the bridge's `health_str` tokens ─────
//
// `lib/link.ts` declares the four verdicts `LinkStatus.health` may hold —
// `"unknown" | "healthy" | "degraded" | "unrecognized"` — and `linkLevel` branches on the first
// two by name; `crates/amos-tauri/src/link.rs::health_str` is the producer that spells them, with
// the same four literals in its own doc. The two sides are a declared mirror, and nothing reads
// across: `link.test.ts` pins `linkLevel` against **TS-local** literals and `link_status_e2e.rs`
// checks `["unknown","healthy","degraded"].contains(status.health)` on the Rust side. So a
// re-spelling of a verdict token in `health_str` (or a remap of `HealthState`) keeps every suite
// green while the panel quietly folds the renamed verdict into 「unknown」 — the operator loses the
// word **degraded** on exactly a machine whose link is degraded, and no error says so. The bind is
// one-directional by design: the panel is the mirror, the bridge is the authority.
describe("the panel's link verdicts == the bridge `link.rs` health tokens", () => {
  /** A full `LinkStatus` whose only interesting field is `health`. */
  const withHealth = (health: string): LinkStatus =>
    ({
      peer: "amos-daemon",
      kind: "brain",
      version: "0.1.0",
      uptime_ms: 0,
      clock_synced: false,
      health,
      health_reasons: [] as string[],
      metrics: {
        published: 0,
        delivered: 0,
        dropped: 0,
        blocked: 0,
        decode_errors: 0,
        encode_errors: 0,
      },
      peers: [],
      actuations: [],
    }) satisfies LinkStatus;

  test("every token `health_str` emits is one the panel names, and healthy/degraded are not flattened", () => {
    const src = readRust("amos-tauri/src/link.rs");
    const i = src.indexOf("pub fn health_str");
    expect(i, "health_str not found in link.rs").toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf("\n}", i));

    // The `HealthState::Variant as i32 => "token"` arms, plus the `_ => "token"` catch-all.
    const byVariant = new Map(
      [...body.matchAll(/HealthState::(\w+)\s+as i32\s*=>\s*"([a-z]+)"/g)].map((m) => [
        m[1] ?? "",
        m[2] ?? "",
      ]),
    );
    const fallback = /_\s*=>\s*"([a-z]+)"/.exec(body)?.[1];

    // Guard: the scan found the whole table, not a window of it (`HealthState` names three).
    expect([...byVariant.keys()].sort()).toEqual([
      "HealthDegraded",
      "HealthHealthy",
      "HealthUnknown",
    ]);
    expect(fallback, "the catch-all arm `_ => “unrecognized”`").toBe("unrecognized");

    // The two verdicts the panel must *name*: a re-spelling on either side turns this red instead
    // of silently showing 「未知」 for a degraded link (and 「未知」 for a healthy one).
    expect(linkLevel(withHealth(byVariant.get("HealthHealthy") ?? "")), "healthy").toBe("healthy");
    expect(linkLevel(withHealth(byVariant.get("HealthDegraded") ?? "")), "degraded").toBe(
      "degraded",
    );
    // …and they render as two different sentences, not one.
    expect(healthKey(linkLevel(withHealth(byVariant.get("HealthHealthy") ?? "")))).not.toBe(
      healthKey(linkLevel(withHealth(byVariant.get("HealthDegraded") ?? ""))),
    );

    // The two non-verdicts stay un-asserted: 「no evidence yet」 and 「a verdict this build does not
    // know」 must read as unknown — never as a green 「healthy」.
    expect(linkLevel(withHealth(byVariant.get("HealthUnknown") ?? "")), "unknown").toBe("unknown");
    expect(linkLevel(withHealth(fallback ?? "")), "unrecognized").toBe("unknown");
  });
});

// ─── REQ-A794: the panel's **age readout** (`lib/link.ts`) ↔ the CLI's `format_age_ms` ───────
//
// Two sides declare, in their own doc comments, that they render an age the same way:
//   * `crates/amos-link-cli/src/lib.rs::format_age_ms` — "The same shapes the System UI's
//     `formatUptime` uses, so a terminal and the panel describe an age alike";
//   * `lib/link.ts::reportAgeText` — "The same shapes the CLI's `format_age_ms` prints, so a
//     terminal and this panel describe an age alike (and the same shapes as `formatUptime`:
//     an age *is* a duration)".
//
// It is a declaration, not a binding: each side pins its own literals in its own suite
// (`format_age_ms` at `amos-link-cli/src/lib.rs:4666`, `reportAgeText`/`formatUptime` in
// `link.test.ts`) and **no test reads across**. So a change to one renderer keeps both suites
// green while the terminal and the panel describe the **same** age with **different** strings —
// precisely the comparison an operator makes when the CLI's `age=2m 05s` and the panel's row
// disagree. The defect direction is silent in both ways (neither side is the "right" one), which
// is why the binding is a shared set of shapes rather than one side copying the other.
describe("the panel's age readout uses exactly the CLI `format_age_ms` shapes", () => {
  test("every shape `format_age_ms` prints is one `reportAgeText` prints too", () => {
    const templates = ageTemplates(readRust("amos-link-cli/src/lib.rs"));
    // Guard: the scan found the whole branch table, not an empty window.
    expect(templates).toEqual(["{ms}ms", "{d}d {h:02}h", "{h}h {m:02}m", "{m}m {s:02}s", "{s}s"]);

    // One representative age per branch — the same figures the CLI's own test pins.
    const cases: Array<[ms: number, shape: number]> = [
      [250, 0],
      [45_000, 4],
      [125_000, 3],
      [10_800_000, 2],
      [183_600_000, 1],
    ];
    const hit = new Set<number>();
    for (const [ms, which] of cases) {
      const text = reportAgeText(ms);
      expect(text, `reportAgeText(${ms}) must be the CLI's ${templates[which]}`).toMatch(
        templateRegex(templates[which] ?? ""),
      );
      hit.add(which);
    }
    // Every template is exercised: a shape the CLI prints but the panel never reaches (or vice
    // versa) cannot hide behind an untested branch.
    expect([...hit].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });
});

// ─── REQ-A753: the robot **console**'s reply shapes (`lib/robot.ts`) ─────────────────────────
//
// `lib/robot.ts` re-spells the daemon's write-side replies as three interfaces: `LinkPublishOut`
// ("The receipt of one `link_publish`"), `LinkTopicsOut` ("The daemon's live topic inventory
// (`ListTopics`)") and `LinkHeartbeat` ("One peer heartbeat, forwarded from the daemon's
// `StreamHeartbeats`"). The authority the WebView actually parses is the bridge's own `*Out`
// structs in `crates/amos-tauri/src/link.rs` (`LinkPublishOut` / `LinkTopicsOut` /
// `LinkHeartbeatOut`) — `Serialize`, no `#[serde(rename)]`, so the Rust field name *is* the wire
// key. REQ-A692 bound `link.ts`'s **read**-side shapes to this same file; the write side had no
// such bind, and no other test reads `robot.ts` across the boundary (`robot.test.ts` compares the
// interfaces to object literals in the test — the frontend against itself).
//
// A field rename on either side is silent, and lands on the operator:
//   * heartbeat — `asHeartbeat` gates every event on `typeof b.peer === "string" && typeof
//     b.seq === "number"` and defaults `uptime_ms`/`stamp_ms` to `0`. Rename Rust `peer` and
//     **every beat is dropped**, so each robot reads `beatUnknown` forever with no error path.
//   * receipt — `receiptLevel` reads `r.delivered > 0`; a rename makes it `undefined > 0` (false),
//     so the console reports 「unknown」 even when the transport *counted* a delivery, and
//     `receiptSummary` prints `matched=undefined`.
//   * topics — `complete` going `undefined` is falsy, so a full inventory is always rendered
//     「partial」 — the safe direction, but still a lie.
describe("robot.ts reply shapes == the amos-tauri `link.rs` write-side serializable structs", () => {
  test("each interface's field names are exactly the Rust struct's `pub` fields, in order", () => {
    const rust = readRust("amos-tauri/src/link.rs");
    const ts = readLib("robot.ts");
    const rustFields = (name: string): string[] => {
      const i = rust.indexOf(`pub struct ${name} {`);
      expect(i, `${name} not found in link.rs`).toBeGreaterThan(0);
      const body = rust.slice(i, rust.indexOf("\n}", i));
      expect(body, `${name} must not rename its wire keys`).not.toContain("rename");
      return [...body.matchAll(/pub (\w+):/g)].map((m) => m[1] ?? "");
    };
    const ifaceFields = (name: string): string[] => {
      const i = ts.indexOf(`export interface ${name} {`);
      expect(i, `${name} not found in robot.ts`).toBeGreaterThan(0);
      const body = ts.slice(i, ts.indexOf("\n}", i));
      return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] ?? "");
    };

    // The TS name differs from the Rust one only by the bridge's `Out` suffix — spell the map
    // out so a rename that "fixes" the test by aliasing the two cannot hide a real drift.
    const pairs: Array<[iface: string, mirror: string, len: number]> = [
      ["LinkPublishOut", "LinkPublishOut", 4],
      ["LinkTopicsOut", "LinkTopicsOut", 2],
      ["LinkHeartbeat", "LinkHeartbeatOut", 4],
    ];
    for (const [iface, mirror, len] of pairs) {
      const fields = rustFields(mirror);
      expect(fields, `${mirror} field count`).toHaveLength(len);
      expect(ifaceFields(iface), iface).toEqual(fields);
    }
  });
});


// ─── REQ-A697: the IME reply shapes the on-screen keyboard parses ────────────────────────────
//
// `lib/ime.ts` declares three interfaces as mirrors of the bridge's own structs: `ImeCandidate`
// ("mirror of `amos_tauri::ime::ImeCandidateOut`"), `ImeState` ("mirror of `ImeStateOut`") and
// `ImeCommit` ("mirror of `amos_tauri::ime::ImeCommitOut`"). The Rust authority is
// `crates/amos-tauri/src/ime.rs`, whose `*Out` structs are `Serialize` and carry no
// `#[serde(rename)]` (field name == wire key). The only ime binding on the frontend reads
// `amos_ime::FUZZY_PAIRS` (the fuzzy-pair vocabulary — a different authority); no test reads
// `ime.rs`, so a Rust field rename (with that side's own construction sites updated) leaves both
// suites green and the keyboard reads `undefined` (`state.last_pick_code` loses the "forget this
// word" button, `candidates[].text` blanks a whole column — no error path). Bind the two sides.
describe("ime.ts reply shapes == the amos-tauri `ime.rs` serializable structs", () => {
  test("every reply struct's field names are exactly the Rust `pub` fields, in order", () => {
    const rust = readRust("amos-tauri/src/ime.rs");
    const ts = readLib("ime.ts");
    const rustFields = (name: string): string[] => {
      const i = rust.indexOf(`pub struct ${name} {`);
      expect(i, `${name} not found in ime.rs`).toBeGreaterThan(0);
      const body = rust.slice(i, rust.indexOf("\n}", i));
      expect(body, `${name} must not rename its wire keys`).not.toContain("rename");
      return [...body.matchAll(/pub (\w+):/g)].map((m) => m[1] ?? "");
    };
    const ifaceFields = (name: string): string[] => {
      const i = ts.indexOf(`export interface ${name} {`);
      expect(i, `${name} not found in ime.ts`).toBeGreaterThan(0);
      const body = ts.slice(i, ts.indexOf("\n}", i));
      return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] ?? "");
    };

    // Counts first, then ordered equality: a rewrite that moves a struct out of the scanned
    // window must fail loudly rather than compare two empty lists.
    const pairs: Array<[iface: string, mirror: string, len: number]> = [
      ["ImeCandidate", "ImeCandidateOut", 2],
      ["ImeState", "ImeStateOut", 10],
      ["ImeCommit", "ImeCommitOut", 2],
    ];
    for (const [iface, mirror, len] of pairs) {
      const fields = rustFields(mirror);
      expect(fields, `${mirror} field count`).toHaveLength(len);
      expect(ifaceFields(iface), iface).toEqual(fields);
    }
  });
});

describe("screenshot.rs capture dir == lib/media.ts canonicalPath('screenshots') (REQ-A699)", () => {
  test("the host writes the capture into the directory the Photos app reads", () => {
    // The host writes `~/<SCREENSHOT_REL_DIR>`; the Photos app lists the directory
    // `canonicalPath("screenshots")` names. Two spellings of one place, so a rename on
    // either side must fail here rather than silently landing captures where Photos
    // does not look (the "declared mirror, no binding" shape this file exists for).
    const rust = readRust("amos-tauri/src/screenshot.rs");
    const m = /SCREENSHOT_REL_DIR: &str = "([^"]+)"/.exec(rust);
    expect(m, "screenshot.rs must declare SCREENSHOT_REL_DIR").not.toBeNull();
    expect(m?.[1]).toBe(canonicalPath("screenshots"));
  });
});

describe("screen_record.rs recording dir == lib/media.ts canonicalPath('movies') (REQ-A1578)", () => {
  test("the host writes recordings into the collection the Files and Player apps read", () => {
    // Same binding as the screenshot pin above, and needed for the same reason: the
    // provider lists a collection **non-recursively** (`amos-media::HostFsProvider::list`
    // is one `read_dir` of the collection's canonical path), so a host that wrote one
    // level deeper — `Movies/Screen Recordings` — would land every recording somewhere
    // no app lists, and nothing else in either suite would notice. The mirror is the
    // whole reason the recording is reachable, so it is pinned rather than commented.
    const rust = readRust("amos-tauri/src/screen_record.rs");
    const m = /SCREEN_RECORDING_REL_DIR: &str = "([^"]+)"/.exec(rust);
    expect(m, "screen_record.rs must declare SCREEN_RECORDING_REL_DIR").not.toBeNull();
    expect(m?.[1]).toBe(canonicalPath("movies"));
    // The kind the collection defaults to must be the kind a `.mov` is, or the Files app
    // draws a video as a photo. Named here because the constant is the only tie between
    // the two sides and a `Video` collection is what the choice rests on.
    expect(m?.[1]).toBe("Movies");
  });
});

// ─── REQ-A706: the real-time sensor events the live tile parses ──────────────────────────────
//
// `lib/sensorEvents.ts` declares four interfaces as mirrors of the bridge's own structs:
// `SensorImuDatum` ("Serializable mirror of the Rust `HostImu` sample payload"),
// `SensorFrameDatum` ("Serializable mirror of the Rust `HostFrameMeta`"), `SensorVitalsDatum`
// ("Serializable mirror of the Rust `HostVitals`", REQ-A1454) and `SensorDataEvent`
// ("Serializable mirror of the Rust `SensorHostEvent` (snake_case wire keys)"), plus the event
// name `SENSOR_DATA_EVENT`. The Rust authority is `crates/amos-tauri/src/sensor_host.rs`, whose
// `HostImu`/`HostFrameMeta`/`SensorHostEvent` are `Serialize` with no `#[serde(rename)]` (field
// name == wire key). No test reads `sensor_host.rs`: `sensorEvents.test.ts` builds fixtures from
// local literals, so a Rust field rename (with that side's own construction sites updated) leaves
// both suites green and the live tile reads `undefined` (`event.prev_mode` loses the "left mode"
// label, `imu.temperature_c` blanks a reading — no error path). Bind the two sides here.
describe("sensorEvents.ts wire shapes == the amos-tauri `sensor_host.rs` serde structs", () => {
  test("every event struct's field names are exactly the Rust `pub` fields, in order", () => {
    const rust = readRust("amos-tauri/src/sensor_host.rs");
    const ts = readLib("sensorEvents.ts");
    const rustFields = (name: string): string[] => {
      const i = rust.indexOf(`pub struct ${name} {`);
      expect(i, `${name} not found in sensor_host.rs`).toBeGreaterThan(0);
      const body = rust.slice(i, rust.indexOf("\n}", i));
      expect(body, `${name} must not rename its wire keys`).not.toContain("rename");
      return [...body.matchAll(/pub (\w+):/g)].map((m) => m[1] ?? "");
    };
    const ifaceFields = (name: string): string[] => {
      const i = ts.indexOf(`export interface ${name} {`);
      expect(i, `${name} not found in sensorEvents.ts`).toBeGreaterThan(0);
      const body = ts.slice(i, ts.indexOf("\n}", i));
      return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] ?? "");
    };

    // Counts first, then ordered equality: a rewrite that moves a struct out of the scanned
    // window must fail loudly rather than compare two empty lists.
    const pairs: Array<[iface: string, mirror: string, len: number]> = [
      ["SensorImuDatum", "HostImu", 8],
      ["SensorFrameDatum", "HostFrameMeta", 5],
      // REQ-A1454: the wellness pair. Both readings are `Option<f64>` in Rust and
      // `number | null` in TS — an absent reading must stay absent on the wire, never a `0`.
      ["SensorVitalsDatum", "HostVitals", 3],
      ["SensorDataEvent", "SensorHostEvent", 8],
    ];
    for (const [iface, mirror, len] of pairs) {
      const fields = rustFields(mirror);
      expect(fields, `${mirror} field count`).toHaveLength(len);
      expect(ifaceFields(iface), iface).toEqual(fields);
    }

    // The event *name* is also a declared mirror: a typo on either side silently kills the live
    // tile (nothing is emitted / nothing is heard). Bind the literal both ways.
    const rustEvent = rust.match(/pub const SENSOR_DATA_EVENT: &str = "([^"]+)";/)?.[1];
    expect(rustEvent, "SENSOR_DATA_EVENT const not found in sensor_host.rs").toBeTruthy();
    const tsEvent = ts.match(/export const SENSOR_DATA_EVENT = "([^"]+)";/)?.[1];
    expect(tsEvent, "SENSOR_DATA_EVENT const not found in sensorEvents.ts").toBeTruthy();
    expect(tsEvent).toBe(rustEvent);
  });
});

// ─── REQ-A778: the GNSS accuracy sentinel `gps.ts` must not read as a real fix ──────────────
//
// `lib/gps.ts::accuracyLabel` decides that a `0` accuracy is the **absence** of one — never
// the "±5 m" best tier. That rests on a fact about the *producer*, not about the label:
// `crates/amos-sensor/src/android.rs` fills `horizontal_accuracy_m` straight from
// `Location.getAccuracy()`, and Android returns `0.0` from that call when the fix carries no
// accuracy estimate. Nothing else in the tree records that contract, and the day someone
// swaps the producer (or "simplifies" the guard in `accuracyLabel` back to `m < 0`) the code
// still compiles while the screen resumes printing a precision the receiver never measured.
// Bind both halves: the producer is `getAccuracy`, and the consumer treats `≤ 0` as unknown.
describe("the GNSS accuracy sentinel is 0 because the producer is Location.getAccuracy() (REQ-A778)", () => {
  test("android.rs reads getAccuracy() into horizontal_accuracy_m, and gps.ts honours the sentinel", () => {
    const rust = readRust("amos-sensor/src/android.rs");
    // The producer's own shape: one local bound from `Location.getAccuracy()`, then assigned
    // to the wire field. Anchor both halves of that statement so a rewrite that keeps the
    // field but re-sources it (or drops the local) fails here rather than on a device.
    const acc = rust.indexOf("let acc_m");
    expect(acc, "`let acc_m = …` not found in android.rs").toBeGreaterThan(0);
    const stmt = rust.slice(acc, rust.indexOf(";", acc));
    expect(stmt, "the accuracy local must come from Location.getAccuracy()").toContain(
      "getAccuracy",
    );
    expect(rust, "horizontal_accuracy_m must be the field that local fills").toContain(
      "horizontal_accuracy_m: acc_m",
    );

    const ts = readLib("gps.ts");
    const label = ts.indexOf("export function accuracyLabel");
    expect(label, "accuracyLabel not found in gps.ts").toBeGreaterThan(0);
    const body = ts.slice(label, ts.indexOf("\n}", label));
    expect(
      body,
      "accuracyLabel must render the 0 sentinel (and non-finite values) as unknown",
    ).toContain("m <= 0");
    expect(body).toContain("Number.isFinite(m)");
  });
});

// ─── REQ-A710: the Spaces (virtual-desktop) wire shapes the panel parses ─────────────────────
//
// `lib/spaces.ts` declares its reply shapes as mirrors of the bridge's own structs: `SpaceInfo`
// ("Transport-side mirror of `Space` — same shape"), `SpaceSwitchReport` ("与 `spaces_commands::
// SpaceSwitchReport` 一一对应") and its nested `SwitchFailure`. The Rust authority is
// `crates/amos-tauri/src/spaces.rs` (`Space`, `SpaceInfo` — both `Serialize`, no rename) and
// `crates/amos-tauri/src/spaces_commands.rs` (`SpaceSwitchReport`, `SwitchFailure`). No test reads
// either: `spaces.test.ts`'s case *named* "SpaceInfo 接口与 Space 兼容" only builds local literals
// typed `Space[]` and never touches `SpaceInfo` or the Rust source — a test whose name claims a
// cross-side binding nothing establishes. A one-sided rename leaves both suites green and the
// panel reads `undefined` (`report.hide_failed` blanks the "couldn't hide" list, `space.windows`
// empties every desktop — no error path). Bind the two sides here.
describe("spaces.ts wire shapes == the amos-tauri `spaces.rs` / `spaces_commands.rs` serde structs", () => {
  test("every reply struct's field names are exactly the Rust `pub` fields, in order", () => {
    const spaces = readRust("amos-tauri/src/spaces.rs");
    const cmds = readRust("amos-tauri/src/spaces_commands.rs");
    const ts = readLib("spaces.ts");
    const rustFields = (src: string, name: string): string[] => {
      const i = src.indexOf(`pub struct ${name} {`);
      expect(i, `${name} not found`).toBeGreaterThan(0);
      const body = src.slice(i, src.indexOf("\n}", i));
      expect(body, `${name} must not rename its wire keys`).not.toContain("rename");
      return [...body.matchAll(/pub (\w+):/g)].map((m) => m[1] ?? "");
    };
    const ifaceFields = (name: string): string[] => {
      const i = ts.indexOf(`export interface ${name} {`);
      expect(i, `${name} not found in spaces.ts`).toBeGreaterThan(0);
      const body = ts.slice(i, ts.indexOf("\n}", i));
      return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] ?? "");
    };

    // Counts first, then ordered equality: a rewrite that moves a struct out of the scanned
    // window must fail loudly rather than compare two empty lists.
    const pairs: Array<[iface: string, src: string, mirror: string, len: number]> = [
      ["Space", spaces, "Space", 3],
      ["SpaceInfo", spaces, "SpaceInfo", 3],
      ["SpaceSwitchReport", cmds, "SpaceSwitchReport", 3],
      ["SwitchFailure", cmds, "SwitchFailure", 2],
    ];
    for (const [iface, src, mirror, len] of pairs) {
      const fields = rustFields(src, mirror);
      expect(fields, `${mirror} field count`).toHaveLength(len);
      expect(ifaceFields(iface), iface).toEqual(fields);
    }
  });
});

// ─── REQ-A712: the assistant-voice wire payload the AI app parses ─────────────────────────
//
// `lib/voice.ts` declares `AssistantVoiceEvent` as the "Typed mirror of the Rust
// `assistant-voice-event` payloads" and re-spells the five `kind` discriminants
// (`listening`/`token`/`turn_done`/`stopped`/`error`) plus each variant's field names — a
// second copy of the vocabulary in `VOICE_KINDS`. The Rust authority is `VoiceEventPayload` in
// `crates/amos-tauri/src/assistant_voice.rs`, tagged `#[serde(tag = "kind", rename_all =
// "snake_case")]`. Neither side reads the other: the Rust test
// `to_payload_preserves_event_kind_and_fields` matches the payload **struct** variant (never the
// serialized `kind` string or field order), and no frontend test opens the Rust source. Cancel a
// variant — `.TurnDone` → `.TurnFinished` — and the wire `kind` becomes `turn_finished` while
// `VOICE_KINDS` still lists `turn_done`: `parseVoiceEvent` returns `null` for every finished
// reply and the assistant's answers **silently stop rendering** in `AiApp.svelte` (whose sink
// branches on `kind === "turn_done"`), with no error path.
const rustSnake = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()).replace(/^_/, "");

describe("voice.ts AssistantVoiceEvent == the amos-tauri `assistant_voice.rs` serde payload", () => {
  test("the five `kind` discriminants carry exactly the Rust variant's fields, in order", () => {
    const rust = readRust("amos-tauri/src/assistant_voice.rs");
    const ts = readLib("voice.ts");

    // The serde derive *is* the wire shape: if the tag or renaming changes, this binding would
    // compare the wrong thing — fail loudly instead.
    const enumHead = rust.indexOf("pub enum VoiceEventPayload {");
    expect(enumHead, "VoiceEventPayload not found").toBeGreaterThan(0);
    const attrs = rust.slice(rust.lastIndexOf("#[serde(", enumHead), enumHead);
    expect(attrs).toContain('tag = "kind"');
    expect(attrs).toContain('rename_all = "snake_case"');

    const body = rust.slice(enumHead, rust.indexOf("\n}", enumHead));
    const variants = [...body.matchAll(/^\s{4}(\w+) \{([^}]*)\}/gm)].map((m) => ({
      kind: rustSnake(m[1] ?? ""),
      fields: [...(m[2] ?? "").matchAll(/(\w+):/g)].map((f) => f[1] ?? ""),
    }));
    expect(variants, "payload variants").toHaveLength(5);
    expect(variants.map((v) => v.kind)).toEqual([
      "listening",
      "token",
      "turn_done",
      "stopped",
      "error",
    ]);

    // TS side, first copy: the `AssistantVoiceEvent` union members.
    const uStart = ts.indexOf("export type AssistantVoiceEvent =");
    expect(uStart, "AssistantVoiceEvent not found").toBeGreaterThan(0);
    const uEnd = ts.indexOf("const VOICE_KINDS", uStart);
    expect(uEnd, "VOICE_KINDS not found after the union").toBeGreaterThan(uStart);
    const members = [...ts.slice(uStart, uEnd).matchAll(/\{ kind: "([^"]+)"([^}]*)\}/g)].map((m) => ({
      kind: m[1] ?? "",
      fields: [...(m[2] ?? "").matchAll(/(\w+):/g)].map((f) => f[1] ?? ""),
    }));
    expect(members, "union members").toHaveLength(5);
    expect(members.map((m) => m.kind)).toEqual(variants.map((v) => v.kind));
    for (let i = 0; i < variants.length; i++) {
      expect(members[i]?.fields, `fields of ${members[i]?.kind}`).toEqual(variants[i]?.fields);
    }

    // TS side, second copy: `VOICE_KINDS` must agree with the union (a third spelling of the
    // same five strings — the parser's guard).
    const kindsLit = /const VOICE_KINDS = \[([^\]]*)\]/.exec(ts);
    expect(kindsLit, "VOICE_KINDS literal").not.toBeNull();
    expect([...(kindsLit?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual(
      variants.map((v) => v.kind),
    );
  });

  test("the sink subscribes to the Rust `VOICE_EVENT` constant's value", () => {
    const rust = readRust("amos-tauri/src/assistant_voice.rs");
    const c = /pub const VOICE_EVENT: &str = "([^"]+)";/.exec(rust);
    expect(c, "VOICE_EVENT const not found").not.toBeNull();
    const src = readFileSync(new URL("../svelte/AiApp.svelte", import.meta.url), "utf8");
    const subs = [...src.matchAll(/subscribe\("([^"]+)"/g)].map((m) => m[1]);
    expect(subs, "the assistant-voice sink subscription").toContain(c?.[1] ?? "");
  });
});

// ─── REQ-A718: the device-mic backend vocabulary and its native predicate ──────────────────
//
// `deviceMic.ts` declared `DEVICE_MIC_BACKENDS` "mirrors `PlatformMicKind.label()`" — but that
// codomain also has `"host"`, which this set drops, and `"none"`, which is not a label at all;
// and `isNativeMicBackend` re-spelled the native pair (AAudio/TinyALSA) that
// `PlatformMicKind::is_native()` owns. Nothing read `crates/amos-audio/src/source.rs`, so a Rust
// label rename compiled clean and made `isNativeMicBackend` silently answer `false` for a live
// device mic — the always-on indicator would go dark while the mic was running. Bound here.

describe("deviceMic backends == amos-audio `PlatformMicKind` labels and predicate", () => {
  test("the native pair is `is_native()`, and the status vocabulary is the label codomain minus host", () => {
    const src = readRust("amos-audio/src/source.rs");
    // Anchor inside `impl PlatformMicKind` — `PlatformMic` below it also has methods.
    const impl = src.indexOf("impl PlatformMicKind {");
    expect(impl, "impl PlatformMicKind not found").toBeGreaterThan(0);
    const labelFrom = src.indexOf("pub const fn label(self)", impl);
    const nativeFrom = src.indexOf("pub const fn is_native(self)", labelFrom);
    expect(labelFrom, "PlatformMicKind::label not found").toBeGreaterThan(0);
    expect(nativeFrom).toBeGreaterThan(labelFrom);

    // `label()`: `Self::Kind => "label"` arms, held to the enum variant so `is_native()`'s
    // variant names can be mapped through them.
    const pairs = [...src.slice(labelFrom, nativeFrom).matchAll(/Self::(\w+)\s*=>\s*"([^"]+)"/g)].map(
      (m) => [m[1]!, m[2]!] as const,
    );
    const label = new Map(pairs);
    // `is_native()`: `matches!(self, Self::A | Self::B)`.
    const natBody = src.slice(nativeFrom, src.indexOf("\n    }", nativeFrom));
    const nativeKinds = [...natBody.matchAll(/Self::(\w+)/g)].map((m) => m[1]!);

    // Floors: a rewrite that moves the arms out of the scanned window fails loudly, not vacuous.
    expect(pairs.length, "label() arms").toBe(4);
    expect(nativeKinds.length, "is_native() variants").toBe(2);

    // The native pair the UI reads must be the labels `is_native()` accepts.
    const rustNative = nativeKinds.map((k) => label.get(k) ?? `??${k}`).sort();
    expect(rustNative).toEqual([...NATIVE_MIC_BACKENDS].sort());

    // And the predicate must agree with `is_native()` for every variant, not just the pair.
    for (const [kind, lab] of pairs) {
      expect(isNativeMicBackend(lab), `${kind} => ${lab}`).toBe(nativeKinds.includes(kind));
    }

    // The status carries every label a live `PlatformMic` can report — the label() codomain
    // minus `"host"` (a host build cannot open a native mic, so no worker/label exists) — plus
    // the idle marker. Pin the exact relationship so a new Rust kind forces a decision here.
    const rustLabels = [...label.values()];
    expect(rustLabels, "label() must include host").toContain("host");
    const tsLabels: string[] = [...DEVICE_MIC_BACKENDS].sort();
    expect(tsLabels).toEqual(
      rustLabels.filter((l) => l !== "host").concat(IDLE_MIC_BACKEND).sort(),
    );
  });

  test("DeviceMicStatus fields == the amos-tauri `assistant_voice.rs` serializable struct", () => {
    const rust = readRust("amos-tauri/src/assistant_voice.rs");
    const head = rust.indexOf("pub struct DeviceMicStatus {");
    expect(head, "DeviceMicStatus not found").toBeGreaterThan(0);
    const rustFields = [...rust.slice(head, rust.indexOf("\n}", head)).matchAll(/pub (\w+):/g)].map(
      (m) => m[1]!,
    );
    expect(rustFields, "Rust DeviceMicStatus fields").toEqual(["running", "backend", "submitted"]);

    const ts = readLib("backend.ts");
    const tsHead = ts.indexOf("export interface DeviceMicStatus {");
    expect(tsHead, "TS DeviceMicStatus not found").toBeGreaterThan(0);
    const tsFields = [...ts.slice(tsHead, ts.indexOf("\n}", tsHead)).matchAll(/^\s*(\w+):/gm)].map(
      (m) => m[1]!,
    );
    expect(tsFields, "TS DeviceMicStatus fields").toEqual(rustFields);
  });
});

// ─── REQ-A748: the shared-store locale key, held to the one other side that reads it ────────
//
// `svelte/i18n.ts` declares `LOCALE_KEY` "Mirrors the LOCALE_KEY const from the shell's i18n
// provider (shared store)" — but the *only* other side that reads that key is the **native menu
// bar**: `menu.rs::stored_locale` does `store.get("amos-ui.locale")` and falls back to `Zh` when
// the key is absent (`MenuLocale::parse(...).unwrap_or(MenuLocale::Zh)`). Nothing bound the two,
// so a rename on either side is silent: the host would read a key the shell never writes, parse
// `None`, and keep a **Chinese** menu bar for a user who set English — the exact "nobody would
// think to look at it" surface REQ-A437 was filed for. `osBoot.ts` and the reactive writer in
// `locale.svelte.ts` spell the key by hand too; bind all of them to one source of truth so a
// one-sided edit is a build-time red, not a wrong-language menu on a device.

describe("the shared-store locale key == the key the Rust menu bar reads (menu.rs)", () => {
  test("i18n.LOCALE_KEY, osBoot.ts, locale.svelte.ts and menu.rs all name the same key", () => {
    // The key is a store key (`amos-ui.<x>`); pin the shape so a stray non-key match can't pass.
    expect(LOCALE_KEY).toMatch(/^amos-ui\.[a-z]+$/);

    // The Rust authority: the menu bar's only store read. It may be spelled as a literal, or —
    // the stronger shape, and the one the code uses today — reached through the shared const
    // (`store.get(crate::store::LOCALE_KEY)`, REQ-A858's neighbouring refactor). Both are
    // resolved: demanding the literal would stop binding the two sides the moment the code
    // stops using one, which is this very failure mode one level up. (REQ-A861 / F-DEV-113 —
    // measured: `inlineKey = undefined`, `viaConst = "amos-ui.locale"`.) Resolving the const also
    // checks more than the literal did — it reads *store.rs's* value, so a rename there is red
    // instead of silently agreeing.
    const menuSrc = readRust("amos-tauri/src/menu.rs");
    const inlineKey = /store\.get\("([^"]+)"\)/.exec(menuSrc)?.[1];
    const viaConst = /store\.get\((?:crate::)?store::LOCALE_KEY\)/.test(menuSrc)
      ? /pub const LOCALE_KEY: &str = "([^"]+)"/.exec(readRust("amos-tauri/src/store.rs"))?.[1]
      : undefined;
    const rustKey = inlineKey ?? viaConst;
    expect(
      rustKey,
      'menu.rs locale key not found — neither a store.get("...") literal nor store::LOCALE_KEY',
    ).toBeTruthy();
    expect(rustKey, "the menu bar must read the key the shell writes").toBe(LOCALE_KEY);

    // The boot path re-spells it deliberately (no import, to stay init-order independent) — but
    // it must still be the *same* key, or the <html lang> the shell sets disagrees with the menu.
    const bootSrc = readSvelte("osBoot.ts");
    const bootKey = /const LOCALE_KEY = "([^"]+)"/.exec(bootSrc)?.[1];
    expect(bootKey, "osBoot.ts LOCALE_KEY const not found").toBeTruthy();
    expect(bootKey, "osBoot.ts must spell the shell's key").toBe(LOCALE_KEY);

    // The reactive writer types the localStorage key raw (the store mirror beside it uses the
    // imported const). Every raw `amos-ui.*` setItem key in that file must be this one key; an
    // empty list is fine — it means a later refactor switched to the const, leaving no copy to
    // drift (so this only ever *forbids* a divergent raw literal, never requires one).
    const localeSrc = readSvelte("locale.svelte.ts");
    const rawKeys = [...localeSrc.matchAll(/localStorage\.setItem\("(amos-ui\.[^"]+)"/g)].map(
      (m) => m[1]!,
    );
    for (const k of rawKeys) {
      expect(k, "a raw localStorage key in locale.svelte.ts").toBe(LOCALE_KEY);
    }
  });
});

// ─── REQ-A749: WebMan's real download pipeline wire, bound to `webman_download.rs` ──────────
//
// `lib/webmanDownloads.ts` documents its whole surface as the typed WebView side of the Rust
// pipeline (`crates/amos-tauri/src/webman_download.rs`): the event channel "mirrors `EVENT_PROGRESS`"
// (line 33), and the three interfaces mirror the Rust structs' camelCase serde (lines 44, 58). But
// nothing read the Rust source — `lib/__tests__/webman-downloads.test.ts` uses
// `DOWNLOAD_PROGRESS_EVENT` only as a *lookup key* (`listeners.get(wd.DOWNLOAD_PROGRESS_EVENT)`),
// so it would still pass if the Rust literal were renamed. That failure is silent on both sides:
// `listen(EVENT_PROGRESS, …)` on the host then carries a name no WebView subscriber matches, every
// progress event (including the terminal `completed`/`failed`) is emitted into the void, and the UI
// panel sits at 0% forever on a download that actually finished — with no error on either side.
// The struct fields are the same class one level down: a renamed Rust field is dropped from the
// camelCase payload (unknown to the TS type only by `asProgressEvent`'s runtime guard), and a
// renamed TS field reads `undefined`. Bind the channel string and all three field shapes.
const rustCamel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe("webmanDownloads.ts == the amos-tauri `webman_download.rs` download wire", () => {
  test("the progress channel is the host's `EVENT_PROGRESS` literal", () => {
    const rust = readRust("amos-tauri/src/webman_download.rs");
    const channel = /pub const EVENT_PROGRESS: &str = "([^"]+)"/.exec(rust)?.[1];
    expect(channel, "EVENT_PROGRESS const not found in webman_download.rs").toBeTruthy();
    // The host `emit`s on this literal; a divergence makes every download silently stall at 0%.
    expect(DOWNLOAD_PROGRESS_EVENT).toBe(channel ?? "");
  });

  test("each interface carries exactly the Rust struct's camelCase serde fields, in order", () => {
    const rust = readRust("amos-tauri/src/webman_download.rs");
    const ts = readLib("webmanDownloads.ts");

    // serde's `rename_all` *is* the wire shape; if either struct dropped it, snake_case field
    // names would cross the boundary and this binding would compare the wrong names — fail loud.
    const pairs: Array<[string, string]> = [
      ["DownloadProgress", "DownloadProgressEvent"],
      ["DownloadStarted", "DownloadStarted"],
      ["CookieRecord", "CookieRecord"],
    ];
    for (const [rustName, tsName] of pairs) {
      const head = rust.indexOf(`pub struct ${rustName} {`);
      expect(head, `pub struct ${rustName} not found`).toBeGreaterThan(0);
      const attrs = rust.slice(rust.lastIndexOf("#[derive(", head), head);
      expect(attrs, `${rustName} serde attr`).toContain('rename_all = "camelCase"');
      const rustFields = [
        ...rust
          .slice(head, rust.indexOf("\n}", head))
          .matchAll(/^\s*pub (\w+):/gm),
      ].map((m) => rustCamel(m[1] ?? ""));
      // Non-vacuity: the count is fixed by the struct, so we never compare two empty lists.
      expect(rustFields.length, `${rustName} fields`).toBeGreaterThanOrEqual(4);

      const tsHead = ts.indexOf(`interface ${tsName} {`);
      expect(tsHead, `interface ${tsName} not found`).toBeGreaterThan(0);
      const tsFields = [
        ...ts
          .slice(tsHead, ts.indexOf("\n}", tsHead))
          .matchAll(/^\s{2}(\w+):/gm),
      ].map((m) => m[1] ?? "");
      expect(tsFields.length, `${tsName} fields`).toBeGreaterThanOrEqual(4);

      expect(tsFields, `${tsName} must mirror ${rustName}`).toEqual(rustFields);
    }
  });
});

// ─── REQ-A1168: the shell CSP `frame-src` covers every scheme the browser can navigate ───────
//
// `sanitizeUrl` is the door: it accepts exactly the schemes `['http:', 'https:'].includes(protocol)`.
// `WebManApp` then hands a sanitized URL to an `<iframe src>` that lives in the **shell document**,
// so the shell's `frame-src` decides whether the page can be embedded at all. REQ-A171 narrowed
// `frame-src` to `amos-app: http://amos-app.*` for the app-store bundle and — with no gate reading
// the value — silently killed every remote page in the browser (F-SH-225's family: a missing scheme
// in CSP is a feature dying without a sound). The two lists are the same set spelled twice, so this
// binds them: **whatever the browser can navigate to, the shell must allow it to be framed.**
describe("tauri.conf.json frame-src ⊇ the schemes sanitizeUrl accepts (REQ-A1168)", () => {
  /** The scheme set pulled from `sanitizeUrl`'s own allow-list, not re-typed here. */
  function acceptedSchemes(): string[] {
    const line = readLib("webman.ts")
      .split("\n")
      .find((l) => l.includes("includes(parsed.protocol)"));
    expect(line, "the sanitizeUrl scheme check moved — update this binding").toBeTruthy();
    return [...line!.matchAll(/'([a-z]+:)'/g)].map((m) => m[1] ?? "");
  }

  test("every accepted scheme is in `frame-src`, in both `csp` and `devCsp`", () => {
    const conf = JSON.parse(readRust("amos-tauri/tauri.conf.json")) as {
      app: { security: { csp: string; devCsp: string } };
    };
    const schemes = acceptedSchemes();
    expect(schemes, "no schemes read from sanitizeUrl").toEqual(["http:", "https:"]);

    for (const [name, policy] of [
      ["csp", conf.app.security.csp],
      ["devCsp", conf.app.security.devCsp],
    ] as const) {
      const frameSrc = /frame-src ([^;]+);/.exec(policy)?.[1] ?? "";
      expect(frameSrc, `${name} has no frame-src`).toBeTruthy();
      for (const scheme of schemes) {
        expect(frameSrc.split(/\s+/), `${name} frame-src must allow ${scheme}`).toContain(scheme);
      }
      // The app-store bundle scheme rides on the same directive — it must survive this edit.
      expect(frameSrc, `${name} frame-src must still allow the bundle scheme`).toContain("amos-app:");
    }
  });

  test("the browser's own iframe renders the sanitized URL (the path frame-src protects)", () => {
    // Non-vacuity guard for the binding above: if the content area stopped using an iframe, the
    // CSP would govern nothing and this whole file would be describing a dead route.
    const app = readSvelte("WebManApp.svelte");
    expect(app).toMatch(/<iframe[\s\S]*?src=\{activeTab\.url\}/);
  });
});

// ─── REQ-A772: the GNSS state vocabulary the 定位 card speaks ────────────────────────────────
//
// `lib/gps.ts` declares `GnssStatusWire` as "the wire spelling of the Rust `GnssStatus` enum"
// and `HostGnss` as "Serializable GNSS fix from `SensorHost`". The Rust authority is
// `crates/amos-tauri/src/sensor_host.rs`. The two halves bind differently: `GnssStatus` carries
// `#[serde(rename_all = "kebab-case")]`, so its *spellings* are the contract, while `HostGnss`
// renames nothing, so its *field names* are.
//
// Both halves matter, and the failure modes differ. A `HostGnss` field rename blanks a reading
// (`accuracy_m` → `undefined` prints "±NaN m"). A variant the frontend does not recognise is
// worse: `readGnss` falls through to its `no-fix` reading, which says "searching for satellites"
// about a read that **failed** — the exact sentence REQ-A772 removed from the Rust side.
//
// The second half of the contract is the sentence itself: every state the host can report needs
// its own key in both locales, or the card renders the key's bare name (`settings.gnssFoo`) on
// screen. `STATE_KEYS` is that binding spelled out; the count assertion below is the ratchet — a
// new Rust variant reddens here until it is given a state word, a card branch and two locales.
describe("gps.GnssStatusWire / HostGnss == the amos-tauri `sensor_host.rs` serde shapes", () => {
  /** Rust variant → the i18n key the 定位 card prints for it. */
  const STATE_KEYS: Record<string, string> = {
    Fix: "settings.gnssLocked",
    Searching: "settings.gnssSearching",
    ReceiverOff: "settings.gnssOff",
    PermissionRequired: "settings.gnssPermissionRequired",
    ReadFailed: "settings.gnssReadFailed",
  };

  const kebab = (ident: string): string =>
    ident.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

  function source(): { rust: string; ts: string; card: string } {
    return {
      rust: readRust("amos-tauri/src/sensor_host.rs"),
      ts: readLib("gps.ts"),
      card: readSvelte("LiveSensors.svelte"),
    };
  }

  function locale(name: "en" | "zh"): string {
    return readFileSync(new URL(`../i18n/locales/${name}.ts`, import.meta.url), "utf8");
  }

  test("every GnssStatus variant's kebab spelling is in the TS union, and no other", () => {
    const { rust, ts } = source();
    const head = rust.indexOf("pub enum GnssStatus {");
    expect(head, "pub enum GnssStatus not found").toBeGreaterThan(0);
    const attrs = rust.slice(rust.lastIndexOf("#[derive(", head), head);
    expect(attrs, "GnssStatus serde attr").toContain('rename_all = "kebab-case"');
    const variants = [...rust.slice(head, rust.indexOf("\n}", head)).matchAll(/^\s{4}(\w+),$/gm)]
      .map((m) => m[1] ?? "");
    // Non-vacuity: the five states are fixed by the enum, so a rewrite that moves the body out
    // of the scanned window fails here instead of comparing two empty lists.
    expect(variants, "GnssStatus variant count").toHaveLength(5);

    const unionHead = ts.indexOf("export type GnssStatusWire =");
    expect(unionHead, "GnssStatusWire not found in gps.ts").toBeGreaterThan(0);
    const spellings = [
      ...ts.slice(unionHead, ts.indexOf(";", unionHead)).matchAll(/"([a-z-]+)"/g),
    ].map((m) => m[1] ?? "");
    expect(spellings).toHaveLength(5);
    // Ordered equality: `readGnss` branches on these strings, and the order the union lists them
    // is the order the Rust enum declares them.
    expect(spellings).toEqual(variants.map(kebab));
  });

  test("HostGnss renames nothing, and carries exactly the Rust `pub` fields", () => {
    const { rust, ts } = source();
    const head = rust.indexOf("pub struct HostGnss {");
    expect(head, "pub struct HostGnss not found").toBeGreaterThan(0);
    const attrs = rust.slice(rust.lastIndexOf("#[derive(", head), head);
    expect(attrs, "HostGnss must not rename its wire keys").not.toContain("rename");
    const rustFields = [
      ...rust.slice(head, rust.indexOf("\n}", head)).matchAll(/^\s*pub (\w+):/gm),
    ].map((m) => m[1] ?? "");
    expect(rustFields).toHaveLength(6);

    const tsHead = ts.indexOf("export interface HostGnss {");
    expect(tsHead, "HostGnss not found in gps.ts").toBeGreaterThan(0);
    const tsFields = [
      ...ts.slice(tsHead, ts.indexOf("\n}", tsHead)).matchAll(/^\s{2}(\w+)\??:/gm),
    ].map((m) => m[1] ?? "");
    expect(tsFields, "HostGnss must mirror sensor_host.rs::HostGnss").toEqual(rustFields);
  });

  test("every state the host can report has a card branch and two locales", () => {
    const { rust, card } = source();
    const head = rust.indexOf("pub enum GnssStatus {");
    const variants = [...rust.slice(head, rust.indexOf("\n}", head)).matchAll(/^\s{4}(\w+),$/gm)]
      .map((m) => m[1] ?? "");
    // The mapping must cover the enum exactly: a variant added in Rust with no entry here is a
    // state the card cannot name (and `readGnss` would fold it into `no-fix`).
    expect(Object.keys(STATE_KEYS).sort()).toEqual([...variants].sort());

    const en = locale("en");
    const zh = locale("zh");
    for (const [variant, key] of Object.entries(STATE_KEYS)) {
      expect(card, `${variant}: LiveSensors must print ${key}`).toContain(`"${key}"`);
      expect(en, `${variant}: en is missing ${key}`).toContain(`"${key}":`);
      expect(zh, `${variant}: zh is missing ${key}`).toContain(`"${key}":`);
    }
  });

  test("the two failure states are not the 'searching' sentence", () => {
    const en = locale("en");
    const zh = locale("zh");
    // The whole point of REQ-A772: a failed read must not reuse the wording of progress. Checked
    // as text because the two keys are otherwise free to drift back onto one another's wording.
    for (const [loc, src] of [
      ["en", en],
      ["zh", zh],
    ] as const) {
      const locked = src.match(/"settings\.gnssLocked": "([^"]*)"/)?.[1] ?? "";
      const searching = src.match(/"settings\.gnssSearching": "([^"]*)"/)?.[1] ?? "";
      const denied = src.match(/"settings\.gnssPermissionRequired": "([^"]*)"/)?.[1] ?? "";
      const broke = src.match(/"settings\.gnssReadFailed": "([^"]*)"/)?.[1] ?? "";
      expect(searching.length, `${loc}: gnssSearching must be present`).toBeGreaterThan(0);
      for (const [name, v] of [
        ["gnssPermissionRequired", denied],
        ["gnssReadFailed", broke],
      ] as const) {
        expect(v.length, `${loc}: ${name} must be present`).toBeGreaterThan(0);
        expect(v, `${loc}: ${name} must not reuse the searching wording`).not.toBe(searching);
        expect(v, `${loc}: ${name} must not reuse the fix wording`).not.toBe(locked);
      }
      expect(denied, `${loc}: the two failures are different sentences`).not.toBe(broke);
    }
  });

  test("the state the user can leave offers the way out, and the map reads the same host", () => {
    // Naming a state is half the contract; the other half is that the actionable one is
    // actionable. `permission-required` is the only state here the user can change, and the
    // **native** dialog for the `LocationManager` read is not the WebView's — so if the card
    // does not post it, nothing else on this screen ever will, and the state is a dead end.
    const card = readSvelte("LiveSensors.svelte");
    expect(card, "the 定位 card must be able to ask the OS").toContain("locationPermissionRequest");
    expect(card, "and must read the grant so a host build is not blamed").toContain(
      "locationPermissionState",
    );

    // MapsApp locates from the sensor host's reading first: the WebView prompt is the fallback
    // for a host with no GNSS, not the primary path — otherwise the browser prompt's answer
    // stands in for the real receiver's state (the defect REQ-A772 removed).
    const maps = readSvelte("MapsApp.svelte");
    expect(maps, "the map must read the host's GNSS").toContain("readGnss");
    expect(maps, "the map must be able to ask the OS").toContain("locationPermissionRequest");
  });
});

// ─── REQ-A775: the NFC adapter-state vocabulary the NFC screen speaks ───────────────────────
//
// `lib/nfc.ts` declares `NfcStateWire` as "the wire spelling of the Rust `NfcState` enum" and
// `NfcAvailableResult` as the reply of `nfc_status`. The Rust authority is
// `crates/amos-tauri/src/ble.rs`. As with GNSS the two halves bind differently: `NfcState`
// carries `#[serde(rename_all = "kebab-case")]`, so its *spellings* are the contract, while
// `NfcAvailableResult` renames nothing, so its *field names* are.
//
// The failure mode here is worse than a blank reading. `NfcGlue` spells the platform's own
// answer `no_hardware`, and `NfcApp.stateKey` turns that into **"No NFC hardware"** — a claim
// about the user's phone. If `unavailable` ever leaves the union (a Rust variant renamed, a
// union entry dropped, an i18n key deleted) `stateKey` falls through to its `default`, so an
// adapter that could not be read is *silently renamed into a hardware fact* — which is exactly
// the defect REQ-A775 removed. The count assertion below is the ratchet: a new Rust variant
// reddens here until it is given a state word, a screen branch and two locales.
describe("nfc.NfcStateWire / NfcAvailableResult == the amos-tauri `ble.rs` serde shapes", () => {
  /** Rust variant → the i18n key the NFC screen prints for it. */
  const STATE_KEYS: Record<string, string> = {
    Enabled: "nfc.state.enabled",
    Disabled: "nfc.state.disabled",
    NoHardware: "nfc.state.noHardware",
    Unavailable: "nfc.state.unavailable",
  };

  const kebab = (ident: string): string =>
    ident.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

  function source(): { rust: string; ts: string; screen: string } {
    return {
      rust: readRust("amos-tauri/src/ble.rs"),
      ts: readLib("nfc.ts"),
      screen: readSvelte("NfcApp.svelte"),
    };
  }

  function locale(name: "en" | "zh"): string {
    return readFileSync(new URL(`../i18n/locales/${name}.ts`, import.meta.url), "utf8");
  }

  const variantsOf = (rust: string): string[] => {
    const head = rust.indexOf("pub enum NfcState {");
    expect(head, "pub enum NfcState not found").toBeGreaterThan(0);
    return [...rust.slice(head, rust.indexOf("\n}", head)).matchAll(/^\s{4}(\w+),$/gm)].map(
      (m) => m[1] ?? "",
    );
  };

  test("every NfcState variant's kebab spelling is in the TS union, and no other", () => {
    const { rust, ts } = source();
    const head = rust.indexOf("pub enum NfcState {");
    const attrs = rust.slice(rust.lastIndexOf("#[derive(", head), head);
    expect(attrs, "NfcState serde attr").toContain('rename_all = "kebab-case"');
    const variants = variantsOf(rust);
    // Non-vacuity: the four states are fixed by the enum, so a rewrite that moves the body
    // out of the scanned window fails here instead of comparing two empty lists.
    expect(variants, "NfcState variant count").toHaveLength(4);

    const unionHead = ts.indexOf("export type NfcStateWire =");
    expect(unionHead, "NfcStateWire not found in nfc.ts").toBeGreaterThan(0);
    const spellings = [...ts.slice(unionHead, ts.indexOf(";", unionHead)).matchAll(/"([a-z-]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(spellings).toHaveLength(4);
    // Ordered equality: `stateKey` branches on these strings, and the order the union lists
    // them is the order the Rust enum declares them.
    expect(spellings).toEqual(variants.map(kebab));
  });

  test("NfcAvailableResult renames nothing, and carries exactly the Rust `pub` fields", () => {
    const { rust, ts } = source();
    const head = rust.indexOf("pub struct NfcStatusResult {");
    expect(head, "pub struct NfcStatusResult not found").toBeGreaterThan(0);
    const attrs = rust.slice(rust.lastIndexOf("#[derive(", head), head);
    expect(attrs, "NfcStatusResult must not rename its wire keys").not.toContain("rename");
    const rustFields = [...rust.slice(head, rust.indexOf("\n}", head)).matchAll(/^\s*pub (\w+):/gm)].map(
      (m) => m[1] ?? "",
    );
    expect(rustFields).toHaveLength(3);

    const tsHead = ts.indexOf("export type NfcAvailableResult = {");
    expect(tsHead, "NfcAvailableResult not found in nfc.ts").toBeGreaterThan(0);
    const tsFields = [...ts.slice(tsHead, ts.indexOf("\n};", tsHead)).matchAll(/^\s{2}(\w+)\??:/gm)].map(
      (m) => m[1] ?? "",
    );
    expect(tsFields, "NfcAvailableResult must mirror ble.rs::NfcStatusResult").toEqual(rustFields);
  });

  test("every state the host can report has a screen branch and two locales", () => {
    const { rust, screen } = source();
    const variants = variantsOf(rust);
    expect(Object.keys(STATE_KEYS).sort()).toEqual([...variants].sort());

    const en = locale("en");
    const zh = locale("zh");
    for (const [variant, key] of Object.entries(STATE_KEYS)) {
      expect(screen, `${variant}: NfcApp must print ${key}`).toContain(`"${key}"`);
      expect(en, `${variant}: en is missing ${key}`).toContain(`"${key}":`);
      expect(zh, `${variant}: zh is missing ${key}`).toContain(`"${key}":`);
    }
  });

  test("the state that is not a hardware fact is not worded as one", () => {
    // The point of REQ-A775: `unavailable` ("we could not ask") must never reach the
    // user as `no-hardware` ("your phone has no NFC radio"). Checked as text because the
    // two keys are otherwise free to drift back onto one another's wording.
    for (const loc of ["en", "zh"] as const) {
      const src = locale(loc);
      const noHardware = src.match(/"nfc\.state\.noHardware": "([^"]*)"/)?.[1] ?? "";
      const unavailable = src.match(/"nfc\.state\.unavailable": "([^"]*)"/)?.[1] ?? "";
      const noHardwareHint = src.match(/"nfc\.noHardwareHint": "([^"]*)"/)?.[1] ?? "";
      const unavailableHint = src.match(/"nfc\.unavailableHint": "([^"]*)"/)?.[1] ?? "";
      for (const [name, v] of [
        ["state.noHardware", noHardware],
        ["state.unavailable", unavailable],
        ["noHardwareHint", noHardwareHint],
        ["unavailableHint", unavailableHint],
      ] as const) {
        expect(v.length, `${loc}: ${name} must be present`).toBeGreaterThan(0);
      }
      expect(unavailable, `${loc}: the two states are different sentences`).not.toBe(noHardware);
      expect(unavailableHint, `${loc}: the two hints are different sentences`).not.toBe(
        noHardwareHint,
      );
    }
    // The screen must branch on the state rather than print one hint for both: an
    // `{#if}`-less screen would satisfy every key check above and still merge the two.
    const screen = readSvelte("NfcApp.svelte");
    expect(screen, "NfcApp must have a branch for the unread-adapter state").toContain(
      'status?.state === "unavailable"',
    );
    expect(screen, "NfcApp must have a branch for the platform's no-hardware answer").toContain(
      'status?.state === "no-hardware"',
    );
  });
});

// ─── REQ-A779: the biometric state vocabulary — four sides, one contract ────────────────────
//
// This one is bound in **four** places, not two, because the defect lived in the seam nobody
// was reading: `BiometricGlue.kt` (Kotlin, the emitter) → `ble.rs::BiometricDeviceState`
// (Rust, the fold) → `lib/biometric.ts` (TS, the union the screen switches on) → the screen's
// branches and two locales. Nothing read the Kotlin, so `BIOMETRIC_ERROR_NO_HARDWARE` (12) sat
// on the arm reporting the sensor as **present** while `BIOMETRIC_ERROR_NONE_ENROLLED` (11)
// fell to `else`: a phone with no sensor was told to enrol a fingerprint, and the phone that
// needed exactly that sentence was told it had no biometrics.
//
// The ratchet is the ordered spelling comparison plus the per-state key/branch check: a new
// Rust variant (or a glue that invents a state word) reddens until it has a spelling in the
// union, a predicate in `lib/biometric.ts`, a branch in `LockPage.svelte` and two locales.
describe("biometric.BiometricStateWire == the glue's emitted words == ble.rs serde shapes", () => {
  /** Rust variant → the i18n key the lock screen prints for it. */
  const STATE_KEYS: Record<string, string> = {
    Enrolled: "lock.biometricReady",
    NotEnrolled: "lock.biometricNeedsEnrollment",
    HwUnavailable: "lock.biometricHwUnavailable",
    Unknown: "lock.biometricUnknown",
    NoHardware: "lock.biometricUnsupported",
  };
  /** The Rust variant only the host can produce: the glue never emits it. */
  const HOST_ONLY = "Unavailable";

  /** Rust variant → the predicate `lib/biometric.ts` exports for it, and the binding
   *  `LockPage.svelte` calls. The screen must branch on `state`, not on a mirrored boolean. */
  const PREDICATES: Record<string, string> = {
    Enrolled: "biometricReady",
    NotEnrolled: "biometricNeedsEnrollment",
    HwUnavailable: "biometricHwUnavailable",
    Unknown: "biometricUnknown",
    NoHardware: "biometricNoHardware",
  };

  const kebab = (ident: string): string =>
    ident.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

  const GLUE = "amos-tauri/android-glue/com/amos/ai/glue/BiometricGlue.kt";

  function locale(name: "en" | "zh"): string {
    return readFileSync(new URL(`../i18n/locales/${name}.ts`, import.meta.url), "utf8");
  }

  const variantsOf = (rust: string): string[] => {
    const head = rust.indexOf("pub enum BiometricDeviceState {");
    expect(head, "pub enum BiometricDeviceState not found").toBeGreaterThan(0);
    return [...rust.slice(head, rust.indexOf("\n}", head)).matchAll(/^\s{4}(\w+),$/gm)].map(
      (m) => m[1] ?? "",
    );
  };

  test("every BiometricDeviceState variant's kebab spelling is in the TS union, in order", () => {
    const rust = readRust("amos-tauri/src/ble.rs");
    const head = rust.indexOf("pub enum BiometricDeviceState {");
    const attrs = rust.slice(rust.lastIndexOf("#[derive(", head), head);
    expect(attrs, "BiometricDeviceState serde attr").toContain('rename_all = "kebab-case"');
    const variants = variantsOf(rust);
    // Non-vacuity: six states are fixed by the enum.
    expect(variants, "BiometricDeviceState variant count").toHaveLength(6);
    expect(variants).toContain(HOST_ONLY);

    const ts = readLib("biometric.ts");
    const unionHead = ts.indexOf("export type BiometricStateWire =");
    expect(unionHead, "BiometricStateWire not found in biometric.ts").toBeGreaterThan(0);
    const spellings = [...ts.slice(unionHead, ts.indexOf(";", unionHead)).matchAll(/"([a-z-]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(spellings).toHaveLength(6);
    // Ordered equality: the order the union lists them is the order the Rust enum declares
    // them, so a variant dropped from either end is caught rather than merely counted.
    expect(spellings).toEqual(variants.map(kebab));
  });

  test("the glue emits exactly those spellings — minus the host-only one", () => {
    // The Kotlin is the *emitter*: a state word invented there would be turned into
    // `unavailable` by the fold, i.e. a real hardware answer silently becomes "we could not
    // tell". Read as text because no host test can compile the glue.
    const glue = readRust(GLUE);
    const rust = readRust("amos-tauri/src/ble.rs");
    const emitted = [...glue.matchAll(/->\s*"([a-z-]+)"/g)].map((m) => m[1] ?? "");
    const expected = variantsOf(rust)
      .map(kebab)
      .filter((s) => s !== kebab(HOST_ONLY));
    // Non-vacuity: the `when (canAuth)` has five string arms (four codes + `else`), and the
    // `kind`/`label` literals in the same file are not state words.
    const stateArms = emitted.filter((s) => expected.includes(s));
    expect(new Set(stateArms).size, "the glue must name every non-host state").toBe(
      expected.length,
    );
    for (const s of emitted) {
      if (expected.includes(s) || s === "unknown") continue;
      // Any other `-> "..."` in this file is a `kind`/`label`, which are free vocabulary.
      expect(
        ["face", "fingerprint", "iris", "biometric", "none"].includes(s),
        `the glue emits "${s}", which is neither a BiometricDeviceState nor a kind`,
      ).toBe(true);
    }
  });

  test("BiometricAvailability renames nothing, and carries exactly the Rust `pub` fields", () => {
    const rust = readRust("amos-tauri/src/ble.rs");
    const head = rust.indexOf("pub struct BiometricAvailability {");
    expect(head, "pub struct BiometricAvailability not found").toBeGreaterThan(0);
    const attrs = rust.slice(rust.lastIndexOf("#[derive(", head), head);
    expect(attrs, "BiometricAvailability must not rename its wire keys").not.toContain("rename");
    const rustFields = [...rust.slice(head, rust.indexOf("\n}", head)).matchAll(/^\s*pub (\w+):/gm)].map(
      (m) => m[1] ?? "",
    );
    expect(rustFields).toHaveLength(7);

    const ts = readLib("biometric.ts");
    const tsHead = ts.indexOf("export interface BiometricAvailability {");
    expect(tsHead, "BiometricAvailability not found in biometric.ts").toBeGreaterThan(0);
    // `\??` so an optional TS field still matches its required Rust counterpart — the wire
    // carries it either way (`detail` is `null`, not absent).
    const tsFields = [...ts.slice(tsHead, ts.indexOf("\n}", tsHead)).matchAll(/^\s{2}(\w+)\??:/gm)].map(
      (m) => m[1] ?? "",
    );
    expect(tsFields, "BiometricAvailability must mirror ble.rs::BiometricAvailability").toEqual(
      rustFields,
    );
  });

  test("every state the platform can report has a predicate, a screen branch and two locales", () => {
    const rust = readRust("amos-tauri/src/ble.rs");
    const variants = variantsOf(rust);
    expect(Object.keys(STATE_KEYS).sort()).toEqual(
      variants.filter((v) => v !== HOST_ONLY).sort(),
    );
    expect(Object.keys(PREDICATES).sort()).toEqual(
      variants.filter((v) => v !== HOST_ONLY).sort(),
    );

    const ts = readLib("biometric.ts");
    const screen = readSvelte("settings/LockPage.svelte");
    const en = locale("en");
    const zh = locale("zh");
    for (const [variant, pred] of Object.entries(PREDICATES)) {
      expect(ts, `${variant}: biometric.ts must export ${pred}`).toContain(`export function ${pred}(`);
      expect(screen, `${variant}: LockPage must call ${pred}`).toContain(pred);
    }
    for (const [variant, key] of Object.entries(STATE_KEYS)) {
      expect(screen, `${variant}: LockPage must print ${key}`).toContain(`"${key}"`);
      expect(en, `${variant}: en is missing ${key}`).toContain(`"${key}":`);
      expect(zh, `${variant}: zh is missing ${key}`).toContain(`"${key}":`);
    }
    // The host-only state needs a sentence too (it is what the host build and every JNI
    // failure produce), and it must be a *different* sentence from the device's own claim.
    for (const key of ["lock.biometricUnknown", "lock.biometricUnknownDetail"]) {
      expect(screen, `unavailable: LockPage must print ${key}`).toContain(`"${key}"`);
      expect(en, `unavailable: en is missing ${key}`).toContain(`"${key}":`);
      expect(zh, `unavailable: zh is missing ${key}`).toContain(`"${key}":`);
    }
  });

  test("'no answer' and 'the device says there is none' are different sentences", () => {
    // The whole point of REQ-A779. Three states used to share one sentence ("此设备没有生物
    // 识别"), so a phone with a fingerprint reader that had not been asked, a phone whose
    // sensor could not be read, and a phone with no sensor at all all printed the same claim.
    for (const loc of ["en", "zh"] as const) {
      const src = locale(loc);
      const pick = (k: string) => src.match(new RegExp(`"${k}": "([^"]*)"`))?.[1] ?? "";
      const none = pick("lock.biometricUnsupported");
      const unknown = pick("lock.biometricUnknown");
      const needs = pick("lock.biometricNeedsEnrollment");
      const busy = pick("lock.biometricHwUnavailable");
      for (const [name, v] of [
        ["biometricUnsupported", none],
        ["biometricUnknown", unknown],
        ["biometricNeedsEnrollment", needs],
        ["biometricHwUnavailable", busy],
      ] as const) {
        expect(v.length, `${loc}: ${name} must be present`).toBeGreaterThan(0);
      }
      const four = [none, unknown, needs, busy];
      expect(new Set(four).size, `${loc}: the four states must be four distinct sentences`).toBe(4);
    }
    // And the screen must actually branch on the state rather than pick one sentence: a
    // screen that printed `biometricUnsupported` for everything would satisfy every key
    // check above and still merge all four. The branch binding is the `$derived` call —
    // which is also what makes "the screen reads `state`" checkable rather than assumed.
    const screen = readSvelte("settings/LockPage.svelte");
    for (const pred of Object.values(PREDICATES)) {
      expect(screen, `LockPage must branch on ${pred}(avail)`).toContain(`$derived(${pred}(avail))`);
    }
    // The claim-bearing sentence is guarded by the one predicate allowed to reach it.
    expect(screen).toContain("{:else if bioNoHardware}");
    expect(screen).toContain("{:else if bioUnknown}");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The NFC *read* answer (REQ-A781 / F-AND-009). Same four-sided binding as the biometric block
// above, for the same reason: the reply used to be one nullable string, and the four different
// things it could mean were worded as one sentence about the tag.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("nfc.NfcReadStateWire == the glue's emitted words == ble.rs NfcReadState", () => {
  /** Rust variant → a notice key that is *not* the state's, so a borrowing state is caught. */
  const STATE_KEYS: Record<string, string> = {
    Bytes: "nfc.readOk",
    Empty: "nfc.readNoPayload",
    NoTag: "nfc.readNoTag",
    Failed: "nfc.readFailed",
    Unavailable: "nfc.readUnavailable",
  };

  /** The identity mismatch — not a state, an *outcome*: those bytes are another tag's. */
  const OTHER_TAG_KEY = "nfc.readOtherTag";

  /** `unavailable` is this side's own "we could not ask"; the glue must not emit it. */
  const HOST_ONLY = "Unavailable";

  const GLUE = "amos-tauri/android-glue/com/amos/ai/glue/NfcGlue.kt";

  const kebab = (ident: string): string =>
    ident.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

  const locale = (name: "en" | "zh"): string =>
    readFileSync(new URL(`../i18n/locales/${name}.ts`, import.meta.url), "utf8");

  const variantsOf = (rust: string): string[] => {
    const head = rust.indexOf("pub enum NfcReadState {");
    expect(head, "pub enum NfcReadState not found in ble.rs").toBeGreaterThan(0);
    return [...rust.slice(head, rust.indexOf("\n}", head)).matchAll(/^\s{4}(\w+),$/gm)].map(
      (m) => m[1] ?? "",
    );
  };

  test("every NfcReadState variant's kebab spelling is in the TS union, in the same order", () => {
    const rust = readRust("amos-tauri/src/ble.rs");
    const head = rust.indexOf("pub enum NfcReadState {");
    const attrs = rust.slice(rust.lastIndexOf("#[derive(", head), head);
    expect(attrs, "NfcReadState serde attr").toContain('rename_all = "kebab-case"');
    const variants = variantsOf(rust);
    expect(variants, "NfcReadState variant count").toHaveLength(5);

    const ts = readLib("nfc.ts");
    const unionHead = ts.indexOf("export type NfcReadStateWire =");
    expect(unionHead, "NfcReadStateWire not found in nfc.ts").toBeGreaterThan(0);
    const spellings = [
      ...ts.slice(unionHead, ts.indexOf(";", unionHead)).matchAll(/"([a-z-]+)"/g),
    ].map((m) => m[1] ?? "");
    expect(spellings).toHaveLength(5);
    // Ordered: `nfcReadNoticeKey` switches on these, and the order is the Rust enum's.
    expect(spellings).toEqual(variants.map(kebab));
  });

  test("NfcReadOutcome carries exactly the Rust `pub` fields, under the same names", () => {
    const rust = readRust("amos-tauri/src/ble.rs");
    const head = rust.indexOf("pub struct NfcReadResult {");
    expect(head, "pub struct NfcReadResult not found").toBeGreaterThan(0);
    const rustFields = [
      ...rust.slice(head, rust.indexOf("\n}", head)).matchAll(/^\s*pub (\w+):/gm),
    ].map((m) => m[1] ?? "");
    // The id is the load-bearing one: without it the screen cannot tell whose bytes it is
    // showing, and the glue always acts on the tag it last saw rather than the one asked about.
    expect(rustFields).toEqual(["state", "tag_id", "hex", "detail"]);

    const ts = readLib("nfc.ts");
    const tsHead = ts.indexOf("export interface NfcReadOutcome {");
    expect(tsHead, "NfcReadOutcome not found in nfc.ts").toBeGreaterThan(0);
    const tsFields = [
      ...ts.slice(tsHead, ts.indexOf("\n}", tsHead)).matchAll(/^\s{2}(\w+)\??:/gm),
    ].map((m) => m[1] ?? "");
    expect(tsFields, "NfcReadOutcome must mirror ble.rs::NfcReadResult").toEqual(rustFields);
  });

  test("the glue can emit exactly the states Rust has, minus the host's own", () => {
    const rust = readRust("amos-tauri/src/ble.rs");
    const variants = variantsOf(rust);

    const glue = readRust(GLUE);
    const emitted = new Set(
      [...glue.matchAll(/readReply\(\s*"([a-z-]+)"/g)].map((m) => m[1] ?? ""),
    );
    // Non-vacuity: four `readReply` call sites are the four answers the one `null` used to
    // carry, so a rewrite that stops calling the helper fails here rather than comparing
    // an empty set against the enum.
    expect(emitted.size, "the glue must answer four distinct states").toBe(4);
    expect([...emitted].sort()).toEqual(
      variants.filter((v) => v !== HOST_ONLY).map(kebab).sort(),
    );
    // The reply object itself must carry the id it read — the field, not just the value.
    const replyBody = glue.match(/private fun readReply\([\s\S]*?\n    \}/)?.[0] ?? "";
    for (const field of ["state", "id", "hex", "error"]) {
      expect(replyBody, `readReply must carry "${field}"`).toContain(`.put("${field}"`);
    }
  });

  test("every state has its own notice, present in both locales", () => {
    const rust = readRust("amos-tauri/src/ble.rs");
    const variants = variantsOf(rust);
    expect(Object.keys(STATE_KEYS).sort()).toEqual([...variants].sort());

    const ts = readLib("nfc.ts");
    const en = locale("en");
    const zh = locale("zh");
    // The notice function is the single place a state becomes a sentence, so the binding is
    // to the keys it *returns* rather than to the keys the file mentions.
    const fn = ts.match(/export function nfcReadNoticeKey\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn, "nfcReadNoticeKey not found").not.toBe("");
    for (const key of [...Object.values(STATE_KEYS), OTHER_TAG_KEY]) {
      expect(fn, `nfcReadNoticeKey must return ${key}`).toContain(`"${key}"`);
      expect(en, `en is missing ${key}`).toContain(`"${key}":`);
      expect(zh, `zh is missing ${key}`).toContain(`"${key}":`);
    }
  });

  test("'the tag answered nothing' and 'we got no answer' are different sentences", () => {
    // The defect this round fixed: one `null` was all four of these, and the screen printed
    // `nfc.readFailed` — "the system returned no tag bytes" — for every one of them.
    for (const loc of ["en", "zh"] as const) {
      const src = locale(loc);
      const pick = (k: string) => src.match(new RegExp(`"${k}": "([^"]*)"`))?.[1] ?? "";
      const four = [
        pick("nfc.readOk"),
        pick("nfc.readNoPayload"),
        pick("nfc.readNoTag"),
        pick("nfc.readFailed"),
        pick("nfc.readUnavailable"),
      ];
      for (const [i, v] of four.entries()) {
        expect(v.length, `${loc}: sentence ${i} must be present`).toBeGreaterThan(0);
      }
      expect(new Set(four).size, `${loc}: the five read answers must be five sentences`).toBe(5);
      // A parameterized key must not have lost its placeholder: `nfc.readFailed` reports the
      // glue's own words, so a copy edit that dropped `{error}` would silently show nothing.
      expect(pick("nfc.readFailed"), `${loc}: readFailed must carry the glue's words`).toContain(
        "{error}",
      );
      expect(
        pick("nfc.readUnavailable"),
        `${loc}: readUnavailable must carry this side's words`,
      ).toContain("{detail}");
    }
  });

  test("the screen shows bytes under the tag that answered, not the one that was asked", () => {
    const ts = readLib("nfc.ts");
    expect(ts, "nfcReadBelongsTo must exist").toContain("export function nfcReadBelongsTo(");
    // It must compare, not merely exist: a predicate that returned `true` everywhere would
    // satisfy the screen check below and still attribute every read to the selected tag.
    const fn = ts.match(/export function nfcReadBelongsTo\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toContain("tag_id ===");

    const screen = readSvelte("NfcApp.svelte");
    expect(screen, "NfcApp must ask which tag answered").toContain("nfcReadBelongsTo(");
    expect(screen, "NfcApp must word the read through the notice function").toContain(
      "nfcReadNoticeKey(",
    );
    // And the mismatch must have somewhere to be shown that is not the selected tag's card.
    expect(screen, 'NfcApp must print "nfc.readOtherTitle"').toContain('"nfc.readOtherTitle"');
    for (const loc of ["en", "zh"] as const) {
      expect(locale(loc), `${loc} is missing nfc.readOtherTitle`).toContain('"nfc.readOtherTitle":');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The `RECORD_AUDIO` grant answer (REQ-A787 / F-AND-010). Same four-sided binding as the two
// blocks above: the reply used to be one `bool` (`is_granted().unwrap_or(false)`), so a JNI read
// that *failed* and a grant the user *denied* were the same `false` — and the button worded both
// as 「系统未授予麦克风权限（RECORD_AUDIO）」, a fact about the user, from a read that may never
// have happened.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("backend.MicGrantStateWire == mic_permission.rs MicGrantState == the button's copy", () => {
  /** Rust variant → the locale key the button uses for that state. */
  const STATE_KEYS: Record<string, string> = {
    Granted: "ai.deviceMicTitle",
    Denied: "ai.deviceMicDenied",
    Unreadable: "ai.deviceMicUnreadable",
    TimedOut: "ai.deviceMicTimedOut",
    Host: "ai.deviceMicTitle",
  };

  /** The three states a UI must keep apart — one key each, all different. */
  const PROBLEM_STATES = ["Denied", "Unreadable", "TimedOut"] as const;

  const kebab = (ident: string): string =>
    ident.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

  const locale = (name: "en" | "zh"): string =>
    readFileSync(new URL(`../i18n/locales/${name}.ts`, import.meta.url), "utf8");

  const variantsOf = (rust: string): string[] => {
    const head = rust.indexOf("pub enum MicGrantState {");
    expect(head, "pub enum MicGrantState not found in mic_permission.rs").toBeGreaterThan(0);
    return [...rust.slice(head, rust.indexOf("\n}", head)).matchAll(/^\s{4}(\w+),$/gm)].map(
      (m) => m[1] ?? "",
    );
  };

  test("every MicGrantState variant's kebab spelling is in the TS union, in the same order", () => {
    const rust = readRust("amos-tauri/src/mic_permission.rs");
    const head = rust.indexOf("pub enum MicGrantState {");
    const attrs = rust.slice(rust.lastIndexOf("#[derive(", head), head);
    expect(attrs, "MicGrantState serde attr").toContain('rename_all = "kebab-case"');
    const variants = variantsOf(rust);
    expect(variants, "MicGrantState variant count").toHaveLength(5);

    const ts = readLib("backend.ts");
    const unionHead = ts.indexOf("export type MicGrantStateWire =");
    expect(unionHead, "MicGrantStateWire not found in backend.ts").toBeGreaterThan(0);
    const spellings = [
      ...ts.slice(unionHead, ts.indexOf(";", unionHead)).matchAll(/"([a-z-]+)"/g),
    ].map((m) => m[1] ?? "");
    expect(spellings).toHaveLength(5);
    expect(spellings).toEqual(variants.map(kebab));
  });

  test("MicPermissionState carries exactly the Rust `pub` fields, under the same names", () => {
    const rust = readRust("amos-tauri/src/mic_permission.rs");
    const head = rust.indexOf("pub struct MicPermissionState {");
    expect(head).toBeGreaterThan(0);
    const rustFields = [...rust.slice(head, rust.indexOf("\n}", head)).matchAll(/^\s+pub (\w+):/gm)]
      .map((m) => m[1] ?? "")
      .sort();

    const ts = readLib("backend.ts");
    const tsHead = ts.indexOf("export interface MicPermissionState {");
    expect(tsHead).toBeGreaterThan(0);
    const tsFields = [...ts.slice(tsHead, ts.indexOf("\n}", tsHead)).matchAll(/^\s+(\w+)\??:/gm)]
      .map((m) => m[1] ?? "")
      .sort();

    expect(rustFields, "MicPermissionState field anchors").toContain("native");
    expect(tsFields).toEqual(rustFields);
  });

  test("the three problem states have three different sentences, in both languages", () => {
    const keys = PROBLEM_STATES.map((s) => STATE_KEYS[s]);
    expect(new Set(keys).size, "two problem states share one sentence").toBe(3);
    for (const key of keys) {
      for (const loc of ["en", "zh"] as const) {
        expect(locale(loc), `${loc} is missing ${key}`).toContain(`"${key}":`);
      }
    }
    // `unreadable` carries the host's own words; a sentence with no room for them would be
    // re-wording a fact this side does not have.
    for (const loc of ["en", "zh"] as const) {
      expect(locale(loc), `${loc} ai.deviceMicUnreadable must carry {detail}`).toMatch(
        /"ai\.deviceMicUnreadable": "[^"]*\{detail\}/,
      );
    }
  });

  test("the button branches on `state`, and never words a denial from `!granted` alone", () => {
    const screen = readSvelte("DeviceMicButton.svelte");
    // The state is what decides the sentence — the old shape tested `!granted`, which is the
    // same value for "denied", "the read threw" and "no answer in time".
    expect(screen, "DeviceMicButton must test the state").toContain('osMic.state === "denied"');
    expect(screen, "DeviceMicButton must test the state").toContain('"unreadable"');
    expect(screen, "DeviceMicButton must test the state").toContain('"timed-out"');
    expect(screen, "a denial must not be derived from the granted bit").not.toContain(
      "!osMic.granted",
    );
    for (const state of PROBLEM_STATES) {
      expect(screen, `DeviceMicButton must use ${STATE_KEYS[state]}`).toContain(
        `t("${STATE_KEYS[state]}"`,
      );
    }
  });

  test("the Rust fold keeps a failed read out of `denied` — the tests that pin it exist", () => {
    const rust = readRust("amos-tauri/src/mic_permission.rs");
    // The fold is pure and host-testable; if either disappears the binding above is vacuous.
    expect(rust, "state_from_read must exist").toContain("pub fn state_from_read(");
    expect(rust, "state_from_request must exist").toContain("pub fn state_from_request(");
    expect(rust, "the read fold must not swallow the failure").toContain(
      "Err(why) => MicPermissionState::unreadable(why)",
    );
    expect(rust, "the four answers must be pinned apart").toContain(
      "fn the_four_answers_the_read_used_to_fold_together_stay_apart()",
    );
  });
});

// ─── REQ-A798: the mail wire the shell reads from `mail_list` / `mail_read` / `mail_send` ──────
//
// `lib/backend.ts` declares its mail shapes outright — "Shapes mirror the Rust amos_mail models"
// — over the six serde structs in `crates/amos-mail/src/model.rs` (`Address` / `EmailFlags` /
// `EmailSummary` / `Email` / `AttachmentMeta` / `SendReceipt`), which are the reply types of the
// `mail_*` commands in `crates/amos-tauri/src/mail.rs`. Nothing read across before this block:
// `mail.rs`'s own tests drive the engine through **typed Rust calls** (`inbox[0].flags.seen`) and
// never serialize once, and `svelte-tests/mail.svelte.test.ts` builds every fixture from a
// **TS-local literal** — so the JSON keys were pinned by neither side. `model.rs` carries no
// `#[serde(rename_all)]`, so today every wire key *is* the Rust field name; adding one (or
// renaming `attachment_count`) compiles, keeps every Rust test green, keeps every frontend test
// green, and leaves `svelte/MailApp.svelte` rendering the unread dot and the attachment count off
// `undefined` — a falsy read with **no error path**. Same class as F-SH-222 (rotation, REQ-A740).
//
// The expected keys are pinned as a **literal** here and asserted against all three sides — the
// Rust struct, the TS type, and the screen that reads them — so a rename coordinated across the
// two declaration sites still fails: the consumer names the keys it expects too, and this list is
// the third opinion (`半吊子判据比已知的盲区更危险` — a binding that only compares two copies does
// not survive both being edited).
describe("backend.ts mail shapes == the amos-mail `model.rs` serde structs", () => {
  /** Each pair: the Rust struct, the TS type, and the wire keys both sides must spell. */
  const WIRE: { rust: string; ts: string; keys: string[]; interface: boolean }[] = [
    { rust: "Address", ts: "MailAddr", keys: ["name", "email"], interface: false },
    { rust: "EmailFlags", ts: "MailFlags", keys: ["seen", "flagged", "answered"], interface: false },
    {
      rust: "EmailSummary",
      ts: "MailSummary",
      keys: [
        "id",
        "mailbox",
        "from",
        "to",
        "subject",
        "date",
        "flags",
        "attachment_count",
      ],
      interface: true,
    },
    { rust: "AttachmentMeta", ts: "MailAttachment", keys: ["id", "filename", "mime", "size"], interface: false },
    {
      rust: "Email",
      ts: "MailMessage",
      keys: ["summary", "body_plain", "body_html", "attachments"],
      interface: true,
    },
    { rust: "SendReceipt", ts: "MailReceipt", keys: ["id", "date", "delivered"], interface: false },
  ];

  /** The `pub <name>:` fields of a serde struct body, in declaration order. */
  const rustFields = (src: string, name: string): string[] => {
    const i = src.indexOf(`pub struct ${name} {`);
    expect(i, `${name} not found in amos-mail/src/model.rs`).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf("\n}", i));
    return [...body.matchAll(/pub (\w+):/g)].map((m) => m[1] ?? "");
  };
  /** The top-level `name:` fields of an exported interface (comment lines start with `/`/`*`). */
  const tsInterfaceFields = (src: string, name: string): string[] => {
    const i = src.indexOf(`export interface ${name} {`);
    expect(i, `${name} not found in backend.ts`).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf("\n}", i));
    return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] ?? "");
  };
  /** The same for an inline object type alias: `export type X = { a: string; b: number };`. */
  const tsAliasFields = (src: string, name: string): string[] => {
    const i = src.indexOf(`export type ${name} = {`);
    expect(i, `${name} not found in backend.ts`).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf("};", i));
    return [...body.matchAll(/(\w+)\??:/g)].map((m) => m[1] ?? "");
  };

  test("every mail struct's field names are exactly the wire keys, in order, on both sides", () => {
    const rust = readRust("amos-mail/src/model.rs");
    const ts = readLib("backend.ts");

    for (const { rust: rn, ts: tn, keys, interface: isIface } of WIRE) {
      // Count first: a rewrite that moves a field out of the scanned window must fail loudly
      // rather than compare two empty lists.
      expect(rustFields(rust, rn), `${rn}: extracted field count`).toHaveLength(keys.length);
      expect(rustFields(rust, rn), `${rn} must spell the wire keys`).toEqual(keys);

      const tsKeys = isIface ? tsInterfaceFields(ts, tn) : tsAliasFields(ts, tn);
      expect(tsKeys, `${tn}: extracted field count`).toHaveLength(keys.length);
      expect(tsKeys, `${tn} must spell the Rust field names verbatim`).toEqual(keys);
    }
  });

  test("the mail model renames nothing — the JSON keys are the Rust field names", () => {
    const rust = readRust("amos-mail/src/model.rs");
    // The premise of the binding above. A `rename_all = "camelCase"` here (the shape
    // `rotation.rs` legitimately uses) or a per-field `rename`/`skip_serializing_if` would
    // change the wire without touching a single `pub <name>:` the extraction reads.
    expect(rust, "model.rs must not carry serde field attributes").not.toContain("serde(");
    expect(rust, "no rename_all in the mail model").not.toContain("rename_all");
  });

  test("the screen reads the wire keys by name, so a rename lands on a rendered field", () => {
    const screen = readSvelte("MailApp.svelte");
    // The multi-word keys are the ones a rename would silently break; the single-word ones
    // (`id`, `to`, `date`) are too common in the markup to pin unambiguously.
    for (const key of ["attachment_count", "body_plain", "mailbox", "subject", "from"]) {
      expect(screen, `MailApp.svelte must read .${key}`).toContain(`.${key}`);
    }
    // The flag triple is read through `flags`, never flattened onto the summary.
    expect(screen, "MailApp.svelte must read .flags").toContain(".flags");
    expect(screen, "MailApp.svelte must read a nested flag").toMatch(/\.flags\.(seen|flagged|answered)/);
  });
});

// ─── REQ-A802: the appstore catalog wire the shell browses (`appstore_catalog` … ) ─────────────
//
// `lib/backend.ts` declares its store shapes outright — "Shapes mirror the Rust amos_appstore
// models" — over `crates/amos-appstore/src/model.rs`, which is what the `appstore_*` commands in
// `crates/amos-tauri/src/appstore.rs` return. Nothing read across before this block, and the mirror
// had **already drifted**: `PackageFormat` is a three-variant Rust enum (`TarGz`/`Zip`/**`Apk`**,
// `#[serde(rename_all = "snake_case")]`), and the F-Droid ingest (`amos-appstore/src/fdroid.rs`)
// produces `PackageFormat::Apk` manifests into the very catalog `appstore_catalog` serves — from
// `AMOS_APPSTORE_CATALOG` (the `appstore-live` remote-catalog path) or a converted F-Droid index.
// The TS union listed only `"tar_gz" | "zip"`, so the declared type said a shape the domain really
// produces **cannot happen**: any `switch` with a `never` exhaustiveness guard over it was a lie,
// and the one thing the type existed to tell a reader ("which formats can arrive") was wrong.
// Measured by serializing (`serde_json::to_string`), because `PackageFormat::as_str()` spells the
// same variant `tar.gz` — the wire token is **not** the `as_str()` spelling, so inferring it from
// the Rust source's own string table would give the wrong literal.
//
// The second half is the `skip_serializing_if` contract: four fields carry it (`Version::pre`,
// `PackageRef::sha256`, `PackageRef::size_bytes`, `AppManifest::publisher` — plus the three
// `String::is_empty` ones), so a full release serializes **without** a `pre` key rather than with
// `pre: null`. The TS types declared those as *required* `T | null`, which is a different shape:
// `undefined === null` is false, so a reader testing `pkg.sha256 === null` would conclude a digest
// exists and then dereference `undefined`. The binding pins the biconditional — a Rust field is
// skipped in serialization **iff** the TS field is optional — so neither side can drift alone.
describe("backend.ts appstore shapes == the amos-appstore `model.rs` serde structs", () => {
  const MODEL = "amos-appstore/src/model.rs";

  /** Each pair: the Rust struct, the TS type, and the field names the wire carries. */
  const WIRE: { rust: string; ts: string; keys: string[]; iface: boolean }[] = [
    { rust: "Version", ts: "AppVersion", keys: ["major", "minor", "patch", "pre"], iface: false },
    {
      rust: "Checksum",
      ts: "AppChecksum",
      keys: ["algorithm", "value"],
      iface: false,
    },
    {
      rust: "PackageRef",
      ts: "PackageRef",
      keys: ["format", "url", "sha256", "size_bytes"],
      iface: true,
    },
    {
      rust: "AppManifest",
      ts: "AppManifest",
      keys: [
        "id",
        "name",
        "summary",
        "description",
        "author",
        "version",
        "category",
        "homepage",
        "icon_url",
        "package",
        "publisher",
      ],
      iface: true,
    },
    { rust: "InstalledApp", ts: "InstalledApp", keys: ["manifest", "installed_at"], iface: true },
  ];

  /** Each pair: the Rust enum, the TS union, its serde rule, and the wire tokens it yields. */
  const ENUMS: { rust: string; ts: string; rule: string; tokens: string[] }[] = [
    {
      rust: "AppCategory",
      ts: "AppCategory",
      rule: 'rename_all = "snake_case"',
      tokens: [
        "other",
        "tools",
        "media",
        "communication",
        "games",
        "productivity",
        "education",
        "system",
      ],
    },
    {
      rust: "PackageFormat",
      ts: "PackageFormat",
      rule: 'rename_all = "snake_case"',
      tokens: ["tar_gz", "zip", "apk"],
    },
    {
      rust: "HashAlgorithm",
      ts: "AppChecksum",
      rule: 'rename_all = "lowercase"',
      tokens: ["sha256"],
    },
  ];

  /** The `pub <name>:` fields of a struct body, each tagged with whether it is skipped. */
  const rustFields = (src: string, name: string): { name: string; skipped: boolean }[] => {
    const i = src.indexOf(`pub struct ${name} {`);
    expect(i, `${name} not found in ${MODEL}`).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf("\n}", i));
    const out: { name: string; skipped: boolean }[] = [];
    let skipped = false;
    for (const line of body.split("\n")) {
      if (line.includes("skip_serializing_if")) {
        skipped = true;
        continue;
      }
      const m = /pub (\w+):/.exec(line);
      if (m) {
        out.push({ name: m[1] ?? "", skipped });
        skipped = false;
      }
    }
    return out;
  };

  /** The variant names of a serde enum body (doc comments and attributes carry no bare variant). */
  const rustVariants = (src: string, name: string): string[] => {
    const i = src.indexOf(`pub enum ${name} {`);
    expect(i, `${name} not found in ${MODEL}`).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf("\n}", i));
    return [...body.matchAll(/^\s{4}([A-Z]\w*)\s*[,{]/gm)].map((m) => m[1] ?? "");
  };

  /** The top-level `name`/`name?` fields of an interface, in order. */
  const tsInterfaceFields = (src: string, name: string): { name: string; optional: boolean }[] => {
    const i = src.indexOf(`export interface ${name} {`);
    expect(i, `${name} not found in backend.ts`).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf("\n}", i));
    return [...body.matchAll(/^\s{2}(\w+)(\?)?:/gm)].map((m) => ({
      name: m[1] ?? "",
      optional: m[2] === "?",
    }));
  };

  /** The same for an inline object type alias: `export type X = { … };`. */
  const tsAliasFields = (src: string, name: string): { name: string; optional: boolean }[] => {
    const i = src.indexOf(`export type ${name} = {`);
    expect(i, `${name} not found in backend.ts`).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf("};", i));
    return [...body.matchAll(/(\w+)(\?)?:\s*(?:number|string|boolean|App\w+|"[^"]*"|\{)/g)].map((m) => ({
      name: m[1] ?? "",
      optional: m[2] === "?",
    }));
  };

  /** The string literals of a TS union type alias. */
  const tsUnionTokens = (src: string, name: string): string[] => {
    const i = src.indexOf(`export type ${name} =`);
    expect(i, `${name} not found in backend.ts`).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf(";", i));
    return [...body.matchAll(/"([a-z_\d]+)"/g)].map((m) => m[1] ?? "");
  };

  test("every store struct's fields are exactly the Rust `pub` fields, in order", () => {
    const rust = readRust(MODEL);
    const ts = readLib("backend.ts");

    for (const { rust: rn, ts: tn, keys, iface } of WIRE) {
      const rf = rustFields(rust, rn);
      // Count first: a rewrite that moves a field out of the scanned window must fail loudly
      // rather than compare two empty lists.
      expect(rf.map((f) => f.name), `${rn}: extracted field count`).toHaveLength(keys.length);
      expect(rf.map((f) => f.name), `${rn} must spell the wire keys`).toEqual(keys);

      const tf = iface ? tsInterfaceFields(ts, tn) : tsAliasFields(ts, tn);
      expect(tf.map((f) => f.name), `${tn}: extracted field count`).toHaveLength(keys.length);
      expect(tf.map((f) => f.name), `${tn} must spell the Rust field names verbatim`).toEqual(keys);
    }
  });

  test("a skipped Rust field is an optional TS field, and only a skipped one is", () => {
    const rust = readRust(MODEL);
    const ts = readLib("backend.ts");

    // Note `AppChecksum` is the TS name for the enum field inside `Checksum`, so the pairs here
    // are the structs only — the enum members are bound by the test below.
    for (const { rust: rn, ts: tn, iface } of WIRE) {
      if (rn === "Checksum") continue;
      const rf = rustFields(rust, rn);
      const tf = iface ? tsInterfaceFields(ts, tn) : tsAliasFields(ts, tn);
      expect(tf.map((f) => f.name)).toEqual(rf.map((f) => f.name));
      for (const [n, f] of rf.entries()) {
        const t = tf[n];
        // The biconditional is the whole point: `skip_serializing_if` means the key is **absent**,
        // and a TS `?:` means exactly that. Allowing both spellings (`T | null` *and* `undefined`)
        // would let the declaration stay wrong while the test stayed green.
        expect(
          t?.optional,
          `${rn}.${f.name}: Rust ${f.skipped ? "skips this field, so the TS field must be optional" : "always serializes this field, so the TS field must be required"}`,
        ).toBe(f.skipped);
      }
    }
  });

  test("every store enum's wire tokens are exactly the Rust variants' serde spellings", () => {
    const rust = readRust(MODEL);
    const ts = readLib("backend.ts");

    for (const { rust: rn, ts: tn, rule, tokens } of ENUMS) {
      // The literal table above is only justified while the enum really carries that serde rule.
      const head = rust.slice(
        Math.max(0, rust.indexOf(`pub enum ${rn} {`) - 240),
        rust.indexOf(`pub enum ${rn} {`),
      );
      expect(head, `${rn} must carry #[serde(${rule})]`).toContain(rule);

      const variants = rustVariants(rust, rn);
      expect(variants, `${rn}: extracted variant count`).toHaveLength(tokens.length);
      // The kebab/snake spelling of a variant is not derivable from its name without reimplementing
      // serde's rule, so the tokens are pinned above and the variant list is how we know the count.
      const spelled = tokens.map((t) => t.replace(/(^|_)([a-z])/g, (_s, _u, c: string) => c.toUpperCase()));
      expect(spelled.sort(), `${rn}: the pinned tokens must spell the Rust variants`).toEqual(
        [...variants].sort(),
      );

      if (rn !== "HashAlgorithm") {
        expect(tsUnionTokens(ts, tn), `${tn} must list every token the Rust enum can send`).toEqual(
          tokens,
        );
      } else {
        // `HashAlgorithm` has no TS union of its own: the algorithm lives as a literal inside
        // `AppChecksum`, so the token is bound there instead.
        expect(ts, "AppChecksum must spell the lowercase algorithm token").toContain(
          'algorithm: "sha256"',
        );
      }
    }
  });

  test("AppStatus is the externally-tagged enum, and the screen reads those exact tags", () => {
    const rust = readRust(MODEL);
    const ts = readLib("backend.ts");

    const i = rust.indexOf("pub enum AppStatus {");
    expect(i, "AppStatus not found in model.rs").toBeGreaterThan(0);
    const body = rust.slice(i, rust.indexOf("\n}", i));
    // `Available` is a *unit* variant, so it serializes as the bare string and must NOT be
    // renamed — the TS union's `"Available"` is the only tag the host ever sends bare.
    expect(body, "Available must stay a bare unit variant").toMatch(/\n\s{4}Available,/);
    expect(body, 'the installed arm must be tagged "installed"').toContain(
      '#[serde(rename = "installed")]',
    );
    expect(body, 'the updatable arm must be tagged "updatable"').toContain(
      '#[serde(rename = "updatable")]',
    );
    expect(body, "serde must not rename the bare variant").not.toContain("rename_all");

    // The TS side must name exactly those three tags — a rename that missed this file would make
    // `store_status`'s answer unreadable to the screen with no error path.
    const tsHead = ts.indexOf("export type AppStatus =");
    expect(tsHead, "AppStatus not found in backend.ts").toBeGreaterThan(0);
    const tsBody = ts.slice(tsHead, ts.indexOf(";", tsHead));
    expect(tsBody).toContain('"Available"');
    expect(tsBody).toContain("{ installed:");
    expect(tsBody).toContain("{ updatable:");
  });
});
