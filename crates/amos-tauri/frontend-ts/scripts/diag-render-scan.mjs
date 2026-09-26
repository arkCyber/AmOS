#!/usr/bin/env node
/**
 * diag-render-scan.mjs — "a recorded failure whose reason never reaches the reader".
 *
 * Why: `src/lib/debugLog.ts` is the shell's single bounded diagnostic ledger, and its own
 * header calls console output "the primary instrument for 'why is X not rendering on the
 * device' questions". A failure can be lost **after** it is recorded, at one of two
 * render points, and neither is visible from the other:
 *
 *   (A) **the serializer** — `safeDetail` renders the entry's `detail`. `JSON.stringify`
 *       drops a non-enumerable `message`, so `JSON.stringify(new Error("boom"))` is
 *       **`"{}"`**: the entry is written, the reason is not. Every `invoke` failure
 *       (`amosWarn("backend", \`${command} failed\`, err)`), every `listen` failure, and
 *       every `BridgeDiag` object with a nested `detail: err` — `{"ok":false,…,"detail":{}}`
 *       — landed in the ledger and in logcat as `{}`. (REQ-A839)
 *   (B) **the surface** — `settings/AiPage.svelte` is the ledger's only UI reader, and its
 *       row rendered `{e.level} · {e.area} · {e.msg}`: `detail` (the reason) and `ts`
 *       (when) were populated, capped, stored — and dropped exactly there. The two facts a
 *       failures panel is asked for were the two it did not show.
 *
 * The sibling gates cover the *producer* side of the same boundary (`void-cmd-scan`: is the
 * verdict of a void command read? `read-fold-scan`: is a refused read's failure value kept?).
 * This one covers the **renderer**: given that a diagnostic was recorded, does its content
 * reach the reader?
 *
 * Related, and the reason this gate exists at all: the repo's own memory — "a channel needs
 * a reader" — from an earlier round where a `console.*` wrapper with zero readers was counted
 * as "answered". Here the channel had a reader that read three of its six fields.
 *
 * ## What it checks
 *
 * 1. **The field inventory is pinned, not floored.** `DiagEntry`'s field set must equal
 *    `PINNED_FIELDS` exactly. A floor cannot see one name leave a set (the lesson from
 *    `read-fold-scan`'s `MUST_SEE`): deleting `detail` from the interface would otherwise
 *    silence check 2 — a green run bought by removing the thing being asked about.
 * 2. **Every field is read by the surface that renders entries.** Consumer surfaces are the
 *    non-test files that import a ledger reader (`recentDiag` / `diagStats` / `subscribeDiag`).
 *    Each `.svelte` surface must render the entry in a loop keyed on a `DiagEntry` field
 *    (`{#each … as v (v.seq)}` — the repo's own idiom for keying a ledger row), and every
 *    `DiagEntry` field must appear as `v.<field>` inside that loop.
 * 3. **The serializer handles exceptions.** `safeDetail`'s body must branch on an error-like
 *    value, and any `JSON.stringify(` inside it must pass a second argument (a replacer) —
 *    without one, an exception nested in a plain object is still rendered as `{}`.
 *
 * **Comments are stripped before every extraction** (`void-cmd-scan.mjs`'s `stripComments`):
 * this module's own doc-comment quotes `JSON.stringify(new Error(…))` and the interface
 * names, so an unstripped scan would read its own prose as the implementation.
 *
 * ## Honest limits (false-green direction unless stated)
 *
 * * Check 2 is a **textual** presence check on property reads inside the loop body: a
 *   same-named property of an unrelated object, or a read whose value is computed and
 *   discarded, satisfies it. It asks "is this field read where entries are rendered", not
 *   "is the rendered output legible".
 * * A field used as the loop's **key** (`{#each … as e (e.seq)}`) counts as read — it is
 *   how the row gets its identity. The first run of this gate reported `seq` as a finding
 *   for exactly that reason, which was a false positive: the question is whether a field is
 *   read *nowhere*, and being the key is somewhere.
 * * Check 3 is a **structural** check: it asks that an error branch and a replacer exist,
 *   not that they are correct or reachable. The behavioural half is pinned by
 *   `src/__tests__/debugLog.test.ts` (an Error, a nested Error, a cross-realm Error, a
 *   message-less Error, a hostile getter, and the entry cap).
 * * `{#each}` blocks not keyed on a `DiagEntry` field are skipped: a ledger rendered by some
 *   other loop shape would be reported as "no render loop found" rather than as a pass.
 *
 * Usage:
 *   node scripts/diag-render-scan.mjs            # scan the tree
 *   node scripts/diag-render-scan.mjs --selftest # pin the extractors
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, matchDelim, splitTopLevel, invokedDirectly } from "./void-cmd-scan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "src");
const DEBUG_LOG = join(SRC, "lib", "debugLog.ts");
const ALLOWLIST = join(root, "scripts", "diag-render-allowlist.json");

/**
 * The exact field set of `DiagEntry`. **A pin, not a floor** (see the header): a set
 * equality is the only shape that notices one field leaving. Measured 2026-09-21 against
 * this tree — six fields, all rendered by `AiPage.svelte`.
 */
export const PINNED_FIELDS = ["seq", "ts", "level", "area", "msg", "detail"];

/** The ledger readers a consumer surface is recognised by. */
const READERS = ["recentDiag", "diagStats", "subscribeDiag"];

/**
 * Floors that keep the window honest: an empty extraction must not pass vacuously. Deliberately
 * **below** the real counts (6 fields, 1 surface) so that a *one-name* loss is caught by
 * `PINNED_FIELDS` and not by a floor that happens to equal the count — the lesson from
 * `read-fold-scan`, where `FLOORS.wrappers = 60` could not see one name leave a set of 81.
 */
export const FLOORS = { fields: 4, surfaces: 1 };

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/**
 * The field names declared on an `interface <name> { … }` in the (comment-stripped) source.
 * Only depth-1 members are taken, so a nested object type's keys are not mistaken for fields.
 */
export function interfaceFields(src, name) {
  const at = new RegExp(`interface\\s+${name}\\s*\\{`).exec(src);
  if (!at) return null;
  const open = src.indexOf("{", at.index);
  const end = matchDelim(src, open, "{", "}");
  if (end === -1) return null;
  const body = src.slice(open + 1, end - 1);
  const fields = [];
  let depth = 0;
  let token = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === "{" || c === "[" || c === "(" || c === "<") depth += 1;
    else if (c === "}" || c === "]" || c === ")" || c === ">") depth -= 1;
    if (depth === 0 && c === ":") {
      const m = /(\w+)\s*$/.exec(token);
      if (m && !fields.includes(m[1])) fields.push(m[1]);
      token = "";
      continue;
    }
    if (depth === 0 && (c === ";" || c === "\n")) token = "";
    else token += c;
  }
  return fields;
}

/**
 * The `{#each … as v (v.field)}` blocks in the (comment-stripped) markup, with the loop
 * variable and the block body. A loop keyed on anything else is not a ledger row and is
 * skipped — the key is what ties the loop to a `DiagEntry` without a type checker.
 */
export function renderLoops(src) {
  const out = [];
  const re = /\{#each\s+[\w$.[\]]+\s+as\s+(\w+)\s*\(\s*(\w+)\.(\w+)\s*\)\s*\}/g;
  let m;
  while ((m = re.exec(src))) {
    const end = blockEnd(src, re.lastIndex);
    if (end === -1) continue;
    out.push({ varName: m[1], keyVar: m[2], keyField: m[3], body: src.slice(re.lastIndex, end) });
  }
  return out;
}

/** Index of the `{/…}` that closes the block opened before `from`. -1 when unbalanced. */
export function blockEnd(src, from) {
  const re = /\{[#/](\w+)/g;
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(src))) {
    depth += m[0][1] === "#" ? 1 : -1;
    if (depth === 0) return m.index;
  }
  return -1;
}

/** The (comment-stripped) body of a top-level `function <name>(…) { … }`. */
export function functionBody(src, name) {
  const at = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!at) return null;
  const paren = src.indexOf("(", at.index);
  const afterParams = matchDelim(src, paren, "(", ")");
  if (afterParams === -1) return null;
  const open = src.indexOf("{", afterParams);
  if (open === -1) return null;
  const end = matchDelim(src, open, "{", "}");
  if (end === -1) return null;
  return src.slice(open + 1, end - 1);
}

/**
 * Problems with a serializer body: no error-like branch, or a `JSON.stringify` without a
 * replacer (which renders a nested exception as `{}`).
 */
export function serializerProblems(body) {
  const problems = [];
  if (!/isErrorLike|instanceof\s+Error/.test(body)) {
    problems.push(
      "no error-like branch: `JSON.stringify(new Error(…))` is `\"{}\"` (a non-enumerable " +
        "`message`), so an exception detail is recorded as `{}`",
    );
  }
  const re = /JSON\.stringify\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    const open = body.indexOf("(", m.index);
    const end = matchDelim(body, open, "(", ")");
    if (end === -1) continue;
    const args = splitTopLevel(body.slice(open + 1, end - 1));
    if (args.length < 2) {
      problems.push(
        `\`JSON.stringify(${args[0]?.trim() ?? ""})\` has no replacer: an exception nested ` +
          "inside a plain object (the `BridgeDiag` shape) still renders as `{}`",
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Tree walk
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__tests__") continue;
      walk(p, out);
    } else if (/\.(svelte|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Non-test files that read the ledger. */
export function consumerSurfaces(files, readSource) {
  const out = [];
  for (const f of files) {
    const src = stripComments(readSource(f));
    if (!/from\s+["'][^"']*debugLog["']/.test(src)) continue;
    if (!READERS.some((r) => new RegExp(`\\b${r}\\b`).test(src))) continue;
    out.push(f);
  }
  return out;
}

function readAllowlist() {
  if (!existsSync(ALLOWLIST)) return { fields: [], kinds: [] };
  return JSON.parse(readFileSync(ALLOWLIST, "utf8"));
}

/**
 * An allow-listed field must be a real `DiagEntry` field, name a defined `kind`, and carry
 * a non-empty `reason` — otherwise the entry silences the check without saying why.
 */
export function checkAllowlistShape(allowed, fields) {
  const problems = [];
  const kinds = new Set(allowed.kinds ?? []);
  for (const entry of allowed.fields ?? []) {
    if (!fields.includes(entry.field)) problems.push(`unknown field \`${entry.field}\``);
    if (typeof entry.kind !== "string" || !kinds.has(entry.kind)) {
      problems.push(`\`${entry.field}\` names an undefined kind \`${String(entry.kind)}\``);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      problems.push(`\`${entry.field}\` has no reason`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export function analyse(readSource = (f) => readFileSync(f, "utf8")) {
  const rawDiag = readSource(DEBUG_LOG);
  const diag = stripComments(rawDiag);
  const fields = interfaceFields(diag, "DiagEntry") ?? [];
  const safeDetail = functionBody(diag, "safeDetail");
  const files = walk(SRC);
  const surfaces = consumerSurfaces(files, readSource);
  return { fields, safeDetail, surfaces, readSource };
}

export function runScan() {
  const { fields, safeDetail, surfaces, readSource } = analyse();
  const allowed = readAllowlist();
  const allowedFields = new Set((allowed.fields ?? []).map((f) => f.field));
  const failures = [];

  const shape = checkAllowlistShape(allowed, fields);
  for (const p of shape) failures.push(`allow-list: ${p}`);

  if (fields.length < FLOORS.fields || surfaces.length < FLOORS.surfaces) {
    console.error(
      `[diag-render-scan] FAIL — extracted ${fields.length} \`DiagEntry\` field(s) and ` +
        `${surfaces.length} consumer surface(s) (floors ${FLOORS.fields}/${FLOORS.surfaces}). ` +
        "The window the scan reads has moved; fix the extractor before trusting a green run.",
    );
    process.exit(1);
  }

  // (1) The field set is pinned, not floored: a set equality is the only shape that
  // notices one field leaving. Deleting `detail` would otherwise silence check (2).
  const pinned = [...PINNED_FIELDS].sort().join(",");
  const seen = [...fields].sort().join(",");
  if (pinned !== seen) {
    console.error(
      `[diag-render-scan] FAIL — \`DiagEntry\`'s fields are [${seen}], pinned to ` +
        `[${pinned}]. This is a pin, not a floor: a field leaving the set must be a ` +
        "deliberate change to PINNED_FIELDS, never a way to silence the reader check.",
    );
    process.exit(1);
  }

  // (2) Every field is read where entries are rendered.
  let loopsSeen = 0;
  for (const f of surfaces) {
    const name = relative(root, f);
    if (!f.endsWith(".svelte")) {
      failures.push(
        `${name}: reads the ledger but renders nothing — the entries it reads have no ` +
          "render point (a `.ts` consumer must hand them to a `.svelte` surface)",
      );
      continue;
    }
    const src = stripComments(readSource(f));
    const loops = renderLoops(src).filter((l) => fields.includes(l.keyField));
    if (loops.length === 0) {
      failures.push(
        `${name}: no \`{#each … as v (v.<DiagEntry field>)}\` render loop found — the ledger ` +
          "is read but its rows cannot be located, so no field can be checked",
      );
      continue;
    }
    for (const loop of loops) {
      loopsSeen += 1;
      for (const field of fields) {
        if (allowedFields.has(field)) continue;
        // The loop's **key** is a read at the render point too: `(e.seq)` is what gives the
        // row its identity, and a field used that way is not a dropped one. (Reported as a
        // finding on the first run of this gate — a false positive, and a gate that cries
        // wolf is a gate that gets turned off. The defect this gate exists for is a field
        // that is stored and read *nowhere*.)
        if (field === loop.keyField) continue;
        if (!new RegExp(`\\b${loop.varName}\\.${field}\\b`).test(loop.body)) {
          failures.push(
            `${name}: \`DiagEntry.${field}\` is recorded but never rendered by the ` +
              `\`{#each … as ${loop.varName} (…)}\` loop that draws the rows`,
          );
        }
      }
    }
  }

  // (3) The serializer renders exceptions, and nests them.
  if (safeDetail === null) {
    failures.push("src/lib/debugLog.ts: `safeDetail` was not found — the extractor is blind");
  } else {
    for (const p of serializerProblems(safeDetail)) failures.push(`safeDetail: ${p}`);
  }

  if (failures.length > 0) {
    for (const p of failures) console.error(`[diag-render-scan] FAIL — ${p}`);
    console.error(
      "[diag-render-scan] a recorded failure must reach the reader with its reason and its " +
        "time: fix the render point, or (for a field that genuinely must not be shown) name " +
        "it in scripts/diag-render-allowlist.json with a kind and a reason.",
    );
    process.exit(1);
  }
  console.log(
    `[diag-render-scan] ${fields.length} \`DiagEntry\` field(s), all rendered by ` +
      `${loopsSeen} loop(s) across ${surfaces.length} surface(s); \`safeDetail\` renders ` +
      "exceptions. 0 allow-listed.",
  );
  console.log(
    "[diag-render-scan] OK — every recorded field reaches the reader, and a failure carries its reason.",
  );
}

// ---------------------------------------------------------------------------
// Selftest
// ---------------------------------------------------------------------------

export function runSelftest() {
  let bad = 0;
  let cases = 0;
  const t = (label, cond, extra = "") => {
    cases += 1;
    if (cond) console.log(`  [ok] ${label}`);
    else {
      bad += 1;
      console.error(`  [FAIL] ${label}${extra ? ` — ${extra}` : ""}`);
    }
  };

  const src = (s) => stripComments(s);

  // ---- interfaceFields ----
  const iface = src(`
    // DiagEntry is the row type; its \`msg\` fields are rendered.
    interface DiagEntry {
      /** Monotonic id. */
      seq: number;
      ts: number;
      level: DiagLevel;
      entry: { inner: string; also: number };
      detail: string;
    }
    interface Other { nope: string }
  `);
  const f = interfaceFields(iface, "DiagEntry");
  t("interfaceFields finds the depth-1 fields", JSON.stringify(f) === JSON.stringify(["seq", "ts", "level", "entry", "detail"]), JSON.stringify(f));
  t("interfaceFields does not take a nested object's keys", !f.includes("inner") && !f.includes("also"));
  t("interfaceFields ignores a comment's prose", !f.includes("DiagEntry") && !f.includes("msg"));
  t("interfaceFields returns null when the interface is absent", interfaceFields(iface, "Missing") === null);

  // ---- renderLoops / blockEnd ----
  const markup = src(`
    {#each diagEntries as e (e.seq)}
      <li>{e.level} · {e.msg}</li>
      {#if e.detail !== ""}<span>{e.detail}</span>{/if}
    {/each}
    {#each other as o (o.id)}<b>{o.name}</b>{/each}
  `);
  const loops = renderLoops(markup);
  t("renderLoops finds both loops", loops.length === 2, String(loops.length));
  t("renderLoops captures the loop variable and key", loops[0].varName === "e" && loops[0].keyField === "seq");
  t("blockEnd survives a nested {#if}", loops[0].body.includes("{/if}") && loops[0].body.includes("e.detail"));
  t("blockEnd does not run past the matching {/each}", !loops[0].body.includes("o.name"));
  t("the second loop is keyed on a non-DiagEntry field", loops[1].keyField === "id");
  t("a loop with no key is not a row loop", renderLoops(src(`{#each xs as x}<i>{x.a}</i>{/each}`)).length === 0);
  // A field used only as the key is read (row identity) — the false positive this gate
  // reported on its first run against `seq`. The *body* of `loops[0]` really does omit it.
  t("the key field is not in the loop body", !/\be\.seq\b/.test(loops[0].body));

  // ---- serializerProblems ----
  const buggy = src(`function safeDetail(v) {
    let s;
    try { s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v); }
    catch { s = String(v); }
    return s;
  }`);
  const buggyBody = /function safeDetail\(v\) \{([\s\S]*)\}/.exec(buggy)[1];
  const bp = serializerProblems(buggyBody);
  t("a serializer with no error branch is reported", bp.some((p) => p.includes("no error-like branch")), JSON.stringify(bp));
  t("a bare JSON.stringify is reported", bp.some((p) => p.includes("no replacer")), JSON.stringify(bp));

  const fixed = src(`function safeDetail(v) {
    let s;
    try {
      if (typeof v === "string") s = v;
      else if (isErrorLike(v)) s = errorText(v);
      else s = JSON.stringify(v, errReplacer) ?? String(v);
    } catch { s = String(v); }
    return s;
  }`);
  const fixedBody = /function safeDetail\(v\) \{([\s\S]*)\}/.exec(fixed)[1];
  t("a serializer that branches on isErrorLike passes", serializerProblems(fixedBody).length === 0, JSON.stringify(serializerProblems(fixedBody)));

  // The nested case is the one a replacer exists for: a serializer that handles the
  // *top-level* exception but calls `JSON.stringify(v)` still loses `{detail: err}`.
  const halfFixed = src(`function safeDetail(v) {
    if (isErrorLike(v)) return errorText(v);
    return JSON.stringify(v) ?? String(v);
  }`);
  const hfBody = /function safeDetail\(v\) \{([\s\S]*)\}/.exec(halfFixed)[1];
  t(
    "a top-level-only fix is still reported (the nested case)",
    serializerProblems(hfBody).some((p) => p.includes("no replacer")),
    JSON.stringify(serializerProblems(hfBody)),
  );
  t(
    "an `instanceof Error` branch is accepted as the error branch",
    serializerProblems("if (v instanceof Error) return text(v); return JSON.stringify(v, r);").length === 0,
  );
  t(
    "a one-argument call is not excused by a lookalike second argument",
    serializerProblems("return JSON.stringify(v) + JSON.stringify(w, r);").some((p) => p.includes("no replacer")),
  );

  // ---- comments are stripped before extraction (the module's own doc quotes both) ----
  const prose = src(`/** safeDetail used to be \`JSON.stringify(v)\`, and DiagEntry.detail was dropped. */`);
  t("a comment quoting JSON.stringify(v) is not read as the implementation", !/JSON\.stringify\s*\(/.test(prose));
  t("a comment naming DiagEntry.detail is not read as a field", interfaceFields(prose, "DiagEntry") === null);

  // ---- functionBody ----
  t("functionBody extracts the body, not the doc comment", functionBody(src(`// f\nfunction safeDetail(v) { return 1; }`), "safeDetail") === " return 1; ");
  t("functionBody returns null for a missing function", functionBody(src(`function other() {}`), "safeDetail") === null);

  // ---- checkAllowlistShape ----
  const shapeFields = ["seq", "detail"];
  t(
    "an allow-list entry with no reason is reported",
    checkAllowlistShape({ kinds: ["x"], fields: [{ field: "detail", kind: "x" }] }, shapeFields).some((p) => p.includes("no reason")),
  );
  t(
    "an allow-list entry naming an unknown field is reported",
    checkAllowlistShape({ kinds: ["x"], fields: [{ field: "nope", kind: "x", reason: "r" }] }, shapeFields).some((p) => p.includes("unknown field")),
  );
  t(
    "a well-formed allow-list entry passes",
    checkAllowlistShape({ kinds: ["x"], fields: [{ field: "detail", kind: "x", reason: "r" }] }, shapeFields).length === 0,
  );

  // ---- the pin is a set equality, not a floor ----
  t(
    "PINNED_FIELDS and the tree's `DiagEntry` agree",
    interfaceFields(stripComments(readFileSync(DEBUG_LOG, "utf8")), "DiagEntry").slice().sort().join(",") === [...PINNED_FIELDS].sort().join(","),
  );

  if (bad === 0) console.log(`[diag-render-scan] selftest OK — ${cases} case(s).`);
  process.exit(bad === 0 ? 0 : 1);
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();
else if (IS_ENTRY) runScan();
