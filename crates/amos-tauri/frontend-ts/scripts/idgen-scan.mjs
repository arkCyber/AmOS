#!/usr/bin/env node
/**
 * idgen-scan.mjs — "an identity minted from the clock plus a handful of random digits".
 *
 * Why: the shell persisted a family of records whose **id is their identity** (a contact,
 * a shortcut action, a recording's MediaStore key, a notification-centre row, an AI message
 * bubble) and minted those ids as `Date.now()` + a slice of `Math.random().toString(36)`.
 * REQ-A390 replaced that idiom at seven sites with the shared `localId` (a
 * process-monotonic counter + a zero-padded crypto tail) after a real failure
 * (`enterprise-audit.test.ts`'s 10-id uniqueness case); REQ-A400 fixed an eighth
 * (`files.ts`, measured **19913/20000** unique in a tight loop, i.e. 87 collisions).
 * REQ-A401 measured the rest under a **frozen clock** with a seeded PRNG (20,000 ids per
 * generator, reproducible) and found three sites still colliding:
 *
 *   cameraCapture.newCaptureId          3 collisions   ← the id is the media key: the
 *                                                        second recording overwrites the
 *                                                        first one's bytes
 *   PhoneApp/ContactsApp notification   3 collisions   ← `normalizeNotifs` drops repeated
 *                                                        ids: the row disappears on reload
 *   AiApp message id                    3 collisions   ← `patchCur` finds the streaming
 *                                                        bubble by id: tokens land in the
 *                                                        wrong bubble
 *
 * The entropy width decides it: a 5-char base-36 tail is ~26 bits (birthday collisions at
 * 20k), while 6-7 chars (~31-36 bits) did not collide in that run. That is a guarantee by
 * arithmetic luck, not by construction — and the sites had **no owner**: each wrote its own
 * formula, and nothing could tell a reviewer that a new one had appeared.
 *
 * This gate gives the family one owner:
 *
 *   R1  production code may not touch `Math.random` unless the *use* is listed in
 *       `scripts/idgen-allowlist.json` under a `kind` whose reason says why it is not an
 *       identity (a presentation draw, a shuffle order, a mock token, the sanctioned
 *       fallback inside `localId` itself). A new random draw therefore fails the build
 *       until someone decides which it is.
 *
 *   R2  a hit that also reads the clock (`Date.now()`) in the same expression — the id idiom
 *       itself — is classified `id-idiom` and is **never excusable**: identities go through
 *       `localId` (`lib/localId.ts`). This is the rule that would have caught all eight
 *       historical sites, including a brand-new ninth.
 *
 *   R3  an identity built from the clock **without** any random draw — `` `${now36}-${seq}` ``,
 *       `id: \`${Date.now()}-${n}\`` — is the *other* half of the same family (REQ-A402): no
 *       entropy at all, so two contexts that agree on a millisecond mint the same string.
 *       Measured with two processes and a frozen clock: `note`/`reminder`/`event`/`voicememo`
 *       all produced `loyw3v28-1`, while `localId` differed by its crypto tail — and the
 *       consumers are silent (`normalizeVoiceMemos` **drops** a repeated id: 2 rows in,
 *       1 row out; `normalizeConversations` kept both, so `removeConversation` deleted two;
 *       `normalizeNotes`/`normalizeEvents` **rename** the row and break every reference).
 *       Also never excusable:
 *         (a) `id:`/`id =` assigned a template literal that interpolates the clock
 *             (`Date.now()`, or a bare `now`/`nowMs`/`ts`/`createdAt`), or
 *         (b) a function whose **name ends in `Id`** returning such a template
 *             (`makeId`, `makeVoiceId`, `newCaptureId` …).
 *       Both are syntactic and pinned by `--selftest`. The `/Id$/` half is deliberately
 *       narrow: a clock-stamped *display name* (`Amos-20260916-180507.jpg` in `mediaExport`)
 *       is not an identity and must not be blocked — which is why (b) keys on the name and
 *       (a) on the field, not on "every template that mentions the clock".
 *         (c) the **first argument** of a `newX(…)` factory call is such a template.
 *       (c) exists because the first two patterns were **not enough**: a grep survey of the
 *       real tree (after the rules were written) found `newPhoto(\`p${Date.now()}\`, …)` in
 *       `svelte/PhotosApp.svelte` — the clock with no counter at all, feeding the **keyed**
 *       `{#each … (p.id)}` of the gallery. `newPhoto` now mints its own id (the caller cannot
 *       pass one), and (c) keeps the shape from coming back through another `new*` factory
 *       (`newPhoto(id, now)` was the convention that let it in).
 *
 * Honest boundaries:
 *   • this is a text scan: it reads token/expression shapes, not a type system. A draw
 *     laundered through another module (`const r = makeRandom; r()`) is outside it — the
 *     allow-list entry for a *file* is what the reviewer must read;
 *   • R3(a)/(b)/(c) likewise: an id minted by a helper *not* named `…Id`, *not* assigned to
 *     `id:`/`id =`, and *not* the first argument of a `new*` call (e.g. `const key =
 *     \`${now}-x\`; … id: key`) is outside it; the shape contract in
 *     `src/__tests__/idUniqueness.test.ts` is what pins the known generators, and these
 *     three shapes are what stop a *new* member of the family. This hole was found by hand
 *     twice (REQ-A402): once as three false positives, once as the `newPhoto` miss above.
 *   • the counter family is **now converted** (REQ-A402) — the previous wording of this
 *     boundary said it was recorded-not-converted, which stopped being true the moment the
 *     six sites were fixed; leaving that sentence here would have been a false claim;
 *   • the test corpus inside `src/` (`__tests__/`, `*.test.ts`) is excluded by design, and
 *     `svelte-tests/` sits outside `src/` entirely: a test-local key or id cannot corrupt a
 *     user's store, and pinning it would turn this gate into test-style enforcement. The
 *     excluded hits are counted and printed so the exclusion stays visible.
 *
 * Usage (from frontend-ts):
 *   node scripts/idgen-scan.mjs              # gate
 *   node scripts/idgen-scan.mjs --json       # machine-readable
 *   node scripts/idgen-scan.mjs --selftest   # pin the classifier
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "src");
const ALLOWLIST = join(root, "scripts", "idgen-allowlist.json");

const TEST_RE = /(\.test\.|\.spec\.|\/__tests__\/)/;

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist" || ent.name === "coverage") continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/**
 * Blank out line comments, block comments and HTML comments, **keeping every newline** so
 * reported line numbers still point at the real line. A comment that mentions
 * `Math.random` (every migration above left one) is not a call site.
 */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/** Every `Math.random` token (call or bare reference) in the corpus, with its offset. */
export function randomHits(src) {
  const clean = stripComments(src);
  const out = [];
  for (const m of clean.matchAll(/\bMath\s*\.\s*random\b/g)) {
    out.push({ index: m.index, line: clean.slice(0, m.index).split("\n").length });
  }
  return out;
}

/**
 * The template literal that encloses `index`, or `null`.
 *
 * Needed because the idiom is often written across lines
 * (`const uid = (tag) =>` on one line, the template on the next), and the clock read then
 * sits on a different line from the draw — a line-based classifier would call it
 * `plain-random` and let the one shape this gate exists for slip through.
 */
export function enclosingTemplate(src, index) {
  let depth = 0; // ${ … } nesting we are currently inside, walking backwards
  for (let i = index - 1; i >= 0; i--) {
    const ch = src[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth > 0) depth--;
    } else if (ch === "`") {
      if (depth === 0) {
        const close = src.indexOf("`", index);
        return src.slice(i, close < 0 ? src.length : close + 1);
      }
    } else if (ch === ";" && depth === 0) return null; // statement boundary: no template around us
  }
  return null;
}

/**
 * Classify one hit: `id-idiom` when the clock is read in the same expression (the template
 * that encloses it, else its own line), `plain-random` otherwise.
 */
export function classify(src, index) {
  const clean = stripComments(src);
  const template = enclosingTemplate(clean, index);
  const lineStart = clean.lastIndexOf("\n", index - 1) + 1;
  const lineEnd = clean.indexOf("\n", index);
  const line = clean.slice(lineStart, lineEnd < 0 ? clean.length : lineEnd);
  const context = template ?? line;
  return /\bDate\s*\.\s*now\b/.test(context) ? "id-idiom" : "plain-random";
}

/** Every hit in the corpus: `[{ file, line, kind }]`, sorted for a deterministic report. */
export function scanHits(sources) {
  const out = [];
  for (const { file, src } of sources) {
    for (const hit of randomHits(src)) {
      out.push({ file, line: hit.line, kind: classify(src, hit.index) });
    }
  }
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** 1-based line of `index` inside `src`. */
export function lineAt(src, index) {
  return src.slice(0, index).split("\n").length;
}

/**
 * Does this template **body** interpolate the clock in a `${…}` hole?
 *
 * `Date.now()` counts, and so do the bare identifiers the retired family used (`now`,
 * `nowMs`, `ts`, `createdAt`). A *property* read of the same name does **not**: the
 * derived render key `msg:${i}:${m.ts}` is not a fresh identity and must not be flagged.
 */
export function clockInTemplate(body) {
  for (const m of body.matchAll(/\$\{([^}]*)\}/g)) {
    const expr = m[1];
    if (/\bDate\s*\.\s*now\s*\(/.test(expr)) return true;
    if (/(^|[^\w$.])(now|nowMs|ts|createdAt)\b/.test(expr)) return true;
  }
  return false;
}

/** The nearest enclosing function's name (`function f(…)` or `const f = (…) =>`), or null. */
export function enclosingFunctionName(src, index) {
  const before = src.slice(0, index);
  const decls = [...before.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  const arrows = [
    ...before.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g),
  ];
  const last = [...decls, ...arrows].sort((a, b) => a.index - b.index).pop();
  if (!last) return null;
  // Still inside it? A closing brace at column 0 between the signature and us means no.
  if (/\n\}/.test(before.slice(last.index + last[0].length))) return null;
  return last[1];
}

/**
 * R3: identities built from the clock with **no entropy at all**.
 *
 * (a) an identity field (`id:` / `id =`) assigned a clock-stamped template, or
 * (b) a function named `…Id` returning one.
 *
 * Two refinements, both deliberate:
 *   • `src/lib/localId.ts` is **not judged** — it is the one place where reading the clock
 *     is the correct design (counter + zero-padded crypto tail), so the rule would be
 *     self-contradictory there. Exempted by name, not via the allow-list: the exemption is
 *     part of the rule, not an excuse.
 *   • the field form requires the `id` **not** to be a property read
 *     (`` o.id : `${createdAt36}-${i}` `` is the *else* branch of the back-fill ternary in
 *     `normalizeNotes`/`normalizeReminders`/`normalizeEvents`, not an identity mint). Repair
 *     ids are deterministic by design — they must stay stable across loads, which is the
 *     opposite of what a fresh id wants — so they are out of R3's scope. Found by running
 *     the rule against the real tree: three false positives, all of them this shape.
 *
 * Returns `[{ file, line, rule }]`, de-duplicated per site (a site can match both).
 */
export function clockIdioms(sources) {
  const SANCTIONED = "src/lib/localId.ts";
  const out = new Map(); // `${file}:${line}` -> finding
  const add = (file, line, rule) => {
    const key = `${file}:${line}`;
    if (!out.has(key)) out.set(key, { file, line, rule });
  };
  for (const { file, src } of sources) {
    if (file === SANCTIONED) continue;
    const clean = stripComments(src);
    for (const m of clean.matchAll(/(?<![\w$.])id\s*[:=]\s*`([^`]*)`/g)) {
      if (clockInTemplate(m[1])) add(file, lineAt(clean, m.index), "id-field");
    }
    for (const m of clean.matchAll(/\bnew[A-Z][\w$]*\s*\(\s*`([^`]*)`/g)) {
      if (clockInTemplate(m[1])) add(file, lineAt(clean, m.index), "new-arg");
    }
    for (const m of clean.matchAll(/`([^`]*)`/g)) {
      if (!clockInTemplate(m[1])) continue;
      const fn = enclosingFunctionName(clean, m.index);
      if (fn && /Id$/i.test(fn)) add(file, lineAt(clean, m.index), `return-in-${fn}`);
    }
  }
  return [...out.values()].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/**
 * Apply the three rules to the corpus. Returns `[{ kind, file, line?, detail? }]`.
 *
 * `allow.sites` entries are `{ file, kind, hits }`: the file may use `Math.random` at
 * `hits` places, and the reason lives once under `allow.kinds[kind]`. The count is
 * deliberate — adding a second draw to an already-excused file is exactly how this family
 * grew the first time, so it must make the maintainer look again (`count-drift`).
 */
export function scan({ sources, allow }) {
  const findings = [];
  const hits = scanHits(sources);
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file).push(h);
  }

  const entries = [];
  for (const raw of allow.sites ?? []) {
    if (!raw || typeof raw !== "object" || typeof raw.file !== "string") {
      findings.push({ kind: "bad-allow-entry", detail: JSON.stringify(raw) });
      continue;
    }
    if (typeof raw.kind !== "string" || !(raw.kind in (allow.kinds ?? {}))) {
      findings.push({ kind: "unknown-kind", file: raw.file, detail: String(raw.kind) });
      continue;
    }
    if (String(allow.kinds[raw.kind]).trim() === "") {
      findings.push({ kind: "no-reason", file: raw.file, detail: raw.kind });
      continue;
    }
    if (!Number.isInteger(raw.hits) || raw.hits < 1) {
      findings.push({ kind: "bad-allow-entry", file: raw.file, detail: "missing/invalid `hits`" });
      continue;
    }
    entries.push({ file: raw.file, kind: raw.kind, hits: raw.hits });
  }

  // R2 first: the id idiom is never excusable.
  for (const h of hits) {
    if (h.kind === "id-idiom") findings.push({ kind: "id-idiom", file: h.file, line: h.line });
  }

  // R3: a clock-stamped identity with no entropy at all — never excusable either.
  for (const c of clockIdioms(sources)) {
    findings.push({ kind: "id-from-clock", file: c.file, line: c.line, detail: c.rule });
  }

  // R1: every other draw needs an entry, and the entry must still describe the file.
  const excused = new Set();
  for (const e of entries) {
    const fileHits = byFile.get(e.file) ?? [];
    const plain = fileHits.filter((h) => h.kind === "plain-random");
    if (fileHits.length === 0) {
      findings.push({ kind: "stale-allow", file: e.file, detail: `${e.kind} (no Math.random left)` });
      continue;
    }
    if (plain.length !== e.hits) {
      findings.push({
        kind: "count-drift",
        file: e.file,
        detail: `${e.kind}: allow-list says ${e.hits} hit(s), file has ${plain.length}`,
        line: plain[0]?.line,
      });
    }
    excused.add(e.file);
  }
  for (const h of hits) {
    if (h.kind === "id-idiom") continue;
    if (!excused.has(h.file)) {
      findings.push({ kind: "random-not-allowlisted", file: h.file, line: h.line });
    }
  }
  return findings.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    const af = a.file ?? "";
    const bf = b.file ?? "";
    return af === bf ? (a.line ?? 0) - (b.line ?? 0) : af < bf ? -1 : 1;
  });
}

function runSelfTest() {
  const problems = [];
  let assertions = 0;
  const want = (label, got, expected) => {
    assertions++;
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      problems.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
    }
  };

  // --- the ban reads tokens, not comments ------------------------------------
  want("comments are not call sites", randomHits(`/* Math.random here */\n// Math.random there\nconst x = 1;`).length, 0);
  want("a call is a hit", randomHits("const a = Math.random();").length, 1);
  want("even a spaced call", randomHits("const a = Math . random ();").length, 1);
  want("a bare reference is a hit too", randomHits("return Math.random;").length, 1);

  // --- R2: the id idiom, including the multi-line form ------------------------
  const oneLine = "const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;";
  want("one-line template + clock ⇒ id-idiom", classify(oneLine, oneLine.indexOf("Math")), "id-idiom");

  const twoLine =
    "  const uid = (tag) =>\n" +
    "    `${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;";
  want(
    "clock on the line above, inside the same template ⇒ id-idiom",
    classify(twoLine, twoLine.indexOf("Math")),
    "id-idiom",
  );

  const statementBefore = "const t = Date.now();\nconst r = Math.random();";
  want(
    "a clock read in an *earlier statement* is not the same expression",
    classify(statementBefore, statementBefore.indexOf("Math")),
    "plain-random",
  );

  // --- the uses that are genuinely not identities ----------------------------
  want(
    "a palette draw is plain-random",
    classify("const pal = PALETTE[Math.floor(Math.random() * PALETTE.length)];", 27),
    "plain-random",
  );
  const defaultRng = "export function buildOrder(total, shuffle, rng = Math.random) { return []; }";
  want(
    "an injected default rng is plain-random",
    classify(defaultRng, defaultRng.indexOf("Math")),
    "plain-random",
  );

  // --- the two rules over a corpus -------------------------------------------
  const allow = {
    kinds: { "presentation-draw": "A colour, not an identity." },
    sites: [{ file: "src/lib/paint.ts", kind: "presentation-draw", hits: 1 }],
  };
  const kinds = (f) => f.map((x) => x.kind).sort();
  const only = (src) => scan({ sources: [{ file: "src/lib/paint.ts", src }], allow });
  /** A corpus whose only file is the properly-excused one, plus extra allow-list entries. */
  const withEntries = (sites, kindMap = allow.kinds) =>
    scan({
      sources: [{ file: "src/lib/paint.ts", src: "const c = Math.random();" }],
      allow: { kinds: kindMap, sites: [{ file: "src/lib/paint.ts", kind: "presentation-draw", hits: 1 }, ...sites] },
    });

  want("an excused plain draw passes", only("const c = Math.random();"), []);
  want(
    "an unexcused draw fails (with the excused file still drawing, so nothing is stale)",
    kinds(
      scan({
        sources: [
          { file: "src/lib/paint.ts", src: "const c = Math.random();" },
          { file: "src/lib/new.ts", src: "const c = Math.random();" },
        ],
        allow,
      }),
    ),
    ["random-not-allowlisted"],
  );
  want(
    "an id idiom fails even in an excused file (R2 is not excusable)",
    kinds(only("const id = `${Date.now()}${Math.random()}`;")),
    ["count-drift", "id-from-clock", "id-idiom"],
  );
  want(
    "a second draw in an excused file is count-drift",
    kinds(only("const a = Math.random(); const b = Math.random();")),
    ["count-drift"],
  );
  want("an entry whose file no longer draws is stale", kinds(only("const c = 1;")), ["stale-allow"]);
  want(
    "an unknown kind is a finding, not a pass",
    kinds(withEntries([{ file: "src/lib/other.ts", kind: "vibes", hits: 1 }])),
    ["unknown-kind"],
  );
  want(
    "an entry without a reason is a finding",
    kinds(withEntries([{ file: "src/lib/other.ts", kind: "k2", hits: 1 }], { ...allow.kinds, k2: "  " })),
    ["no-reason"],
  );
  want(
    "an entry without a hit count is malformed",
    kinds(withEntries([{ file: "src/lib/other.ts", kind: "presentation-draw" }])),
    ["bad-allow-entry"],
  );

  // --- R3: a clock-stamped identity with no entropy at all --------------------
  want("clockInTemplate: Date.now()", clockInTemplate("${Date.now()}-x"), true);
  want("clockInTemplate: a bare `now`", clockInTemplate("${now.toString(36)}-${seq}"), true);
  want("clockInTemplate: a bare `ts`", clockInTemplate("${ts}-1"), true);
  want("clockInTemplate: a derived key (property read) is NOT the clock", clockInTemplate("msg:${i}:${m.ts}"), false);
  want("clockInTemplate: another id is not the clock", clockInTemplate("alarm:${a.id}:${hm}"), false);
  want("clockInTemplate: a uri is not the clock", clockInTemplate("file:${item.uri}"), false);
  want("clockInTemplate: no holes at all", clockInTemplate("seed-1"), false);

  const r3 = (src) => clockIdioms([{ file: "src/lib/mint.ts", src }]).map((f) => f.rule);
  want("R3(a): an id field from the clock", r3("const o = { id: `${now.toString(36)}-${seq}` };"), ["id-field"]);
  want("R3(a): an id field from Date.now()", r3("let o = { id: `${Date.now()}-1` };"), ["id-field"]);
  want("R3(a): a derived id field passes", r3("const o = { id: `file:${item.uri}` };"), []);
  want("R3(a): an id field on the next line still counts", r3("const o = { id:\n  `${now.toString(36)}-${seq}` };"), ["id-field"]);
  want(
    "R3(b): a `…Id` function returning the clock",
    r3("export function makeId(now: number): string {\n  return `${now.toString(36)}-${seq}`;\n}"),
    ["return-in-makeId"],
  );
  want(
    "R3(b): the arrow form too",
    r3("const makeVoiceId = (now: number) => `${now.toString(36)}-1`;"),
    ["return-in-makeVoiceId"],
  );
  want(
    "R3(b): a display name is not an identity (it must NOT be flagged)",
    r3("export function mediaName(d: Date): string {\n  return `Amos-${d.getTime()}.jpg`;\n}"),
    [],
  );
  want(
    "R3: a site matching (a) and (b) is reported once",
    r3("export function makeId(now: number) {\n  return { id: `${now}-1` };\n}"),
    ["id-field"],
  );
  want(
    "R3 is not excusable (a valid allow-list entry does not hide it)",
    kinds(
      scan({
        sources: [
          { file: "src/lib/mint.ts", src: "const o = { id: `${now}-1` };\nconst r = Math.random();" },
        ],
        allow: { kinds: { k: "why" }, sites: [{ file: "src/lib/mint.ts", kind: "k", hits: 1 }] },
      }),
    ),
    ["id-from-clock"],
  );
  want(
    "R3(c): a clock template as the first argument of a `new*` factory",
    r3("const p = newPhoto(`p${Date.now()}`, Date.now());"),
    ["new-arg"],
  );
  want(
    "R3(c): a localId argument passes",
    r3('const p = newPhoto(localId("p"), Date.now());'),
    [],
  );
  want(
    "R3(c): a clock-stamped *file name* argument is not an id (and is not first)",
    r3("const f = new File([], `export-${Date.now()}.json`);"),
    [],
  );
  want(
    "R3(a): the back-fill ternary is NOT an id field (property read)",
    r3("const baseId = typeof o.id === \"string\" && o.id ? o.id : `${createdAt.toString(36)}-${out.length}`;"),
    [],
  );
  want(
    "R3: the sanctioned generator itself is exempt by name",
    clockIdioms([{ file: "src/lib/localId.ts", src: "export function localId(prefix) {\n  return `${prefix}-${Date.now()}-${seq}`;\n}" }]),
    [],
  );

  if (problems.length > 0) {
    console.error(`[idgen-scan] selftest FAIL:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`[idgen-scan] selftest: ${assertions} assertion(s), 0 failure(s).`);
}

function loadAllow() {
  if (!existsSync(ALLOWLIST)) return { kinds: {}, sites: [] };
  return JSON.parse(readFileSync(ALLOWLIST, "utf8"));
}

function main() {
  const files = walk(SRC).filter((f) => /\.(ts|js|svelte)$/.test(f));
  const sources = [];
  const testHits = [];
  for (const f of files) {
    const rel = relative(root, f);
    const src = readFileSync(f, "utf8");
    if (TEST_RE.test(rel)) {
      for (const h of randomHits(src)) testHits.push({ file: rel, line: h.line });
      continue;
    }
    sources.push({ file: rel, src });
  }
  const allow = loadAllow();
  const findings = scan({ sources, allow });
  const draws = sources.reduce((n, s) => n + randomHits(s.src).length, 0);

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          productionSources: sources.length,
          draws,
          testHits: testHits.length,
          allow: allow.sites?.length ?? 0,
          findings,
        },
        null,
        2,
      ),
    );
  }
  if (findings.length === 0) {
    console.log(
      `[idgen-scan] OK — ${sources.length} production file(s), ${draws} Math.random use(s), all ` +
        `excused with a reason; 0 id idiom, 0 clock-only identity (identities go through localId). ` +
        `${testHits.length} hit(s) in the excluded test corpus.`,
    );
    return 0;
  }
  console.error(`[idgen-scan] FAIL — ${findings.length} finding(s):`);
  for (const f of findings) {
    if (f.kind === "id-idiom") {
      console.error(
        `  id-idiom ${f.file}:${f.line} — an id minted from the clock + Math.random. Identities go ` +
          `through localId() (src/lib/localId.ts): a counter-backed id does not collide under a ` +
          `frozen clock. This rule has no exception (REQ-A401).`,
      );
    } else if (f.kind === "id-from-clock") {
      console.error(
        `  id-from-clock ${f.file}:${f.line} — an identity built from the clock alone (${f.detail}). ` +
          `Two contexts that agree on a millisecond mint the SAME string (measured: two processes ` +
          `with a frozen clock both produced \`loyw3v28-1\`; \`localId\` differed by its crypto tail), ` +
          `and the consumers are silent: voice memos/calendars DROP the repeated row, notes/events ` +
          `RENAME it. Use localId() (src/lib/localId.ts) and keep any clock value for \`ts\`/display. ` +
          `This rule has no exception (REQ-A402).`,
      );
    } else if (f.kind === "random-not-allowlisted") {
      console.error(
        `  random-not-allowlisted ${f.file}:${f.line} — if this draw is NOT an identity, add a ` +
          `{ file, kind, hits } entry to scripts/idgen-allowlist.json and say why under \`kinds\`. ` +
          `If it IS an identity, use localId().`,
      );
    } else if (f.kind === "count-drift") {
      console.error(
        `  count-drift ${f.file} — ${f.detail}. Re-read the file: a new draw must be decided, not ` +
          `absorbed by an old excuse.`,
      );
    } else if (f.kind === "stale-allow") {
      console.error(`  stale-allow ${f.file} — ${f.detail}; remove the entry.`);
    } else {
      console.error(`  ${f.kind} ${f.file ?? f.detail}`);
    }
  }
  return 1;
}

if (process.argv.includes("--selftest")) {
  runSelfTest();
} else {
  process.exit(main());
}



