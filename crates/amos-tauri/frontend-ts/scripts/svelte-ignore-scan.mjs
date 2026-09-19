#!/usr/bin/env node
/**
 * svelte-ignore-scan.mjs — the cross-file carrier + ratchet for **compiler
 * suppressions** (`svelte-ignore`) in the System-UI tree.  (REQ-A472)
 *
 * Why this exists. REQ-A471 fixed three real `svelte-check` a11y warnings and
 * turned warnings into a gate (`--fail-on-warnings`), then wrote down two
 * things it deliberately left open:
 *
 *   1. there was **no cross-file carrier** for "this warning code is relaxed,
 *      and here is why" — the discipline lived in prose, so a future relaxation
 *      could only be an unexplained `--compiler-warnings` edit in `package.json`;
 *   2. a `svelte-ignore` is a **local** exemption whose reason is a comment on
 *      site, and **nothing checked whether that reason still holds** — this repo
 *      ratchets its JSON allow-lists, but had no such discipline for compiler
 *      suppressions.
 *
 * Measured 2026-09-19 (the probes this gate is built on): `svelte-check` reports
 * an *unknown* code (`unknown_code`, e.g. a typo, or a code removed upstream),
 * which `--fail-on-warnings` already makes fatal — but it reports **nothing**
 * for a suppression that no longer suppresses anything: with the real exemption
 * still in place, an extra `a11y_media_has_caption` ignore sitting above a
 * `<div>` produced `0 errors and 0 warnings`, exit 0. So "the reason still
 * holds" had no instrument at all.
 *
 * What this gate checks (corpus: every `.svelte` under `src/` and `svelte-tests/`):
 *
 *   R0  every `svelte-ignore` is a **single-line** `<!-- svelte-ignore … -->`
 *       comment naming at least one code (an unparseable one would otherwise be
 *       skipped in silence — the failure mode this whole gate is about).
 *   R1  **carrier**: every suppression site (file + code) has an entry in
 *       `scripts/svelte-ignore-allowlist.json`. A new suppression therefore
 *       cannot be added quietly: it fails until someone declares it.
 *   R2  **reason**: that entry's `reason` is non-empty **and contains the
 *       on-site comment verbatim** (whitespace-normalised). Two carriers that
 *       disagree fail, so neither can drift away from the other.
 *   R3  **no stale entries**: an allow-list entry with no matching site is a
 *       finding — the list cannot rot, and it cannot "pre-allow" a suppression
 *       that nobody wrote.
 *   R4  **reason on site**: the HTML comment immediately above the suppression
 *       (read as a whole block, so multi-line reasons count) exists and is real
 *       prose (>= 24 chars), not another `svelte-ignore`.
 *   R5  **liveness** (the mechanical half of "does the reason still hold"):
 *       count that one code in the file, remove **this** suppression, count again
 *       and require the count to go **up**. Counting (not "did it fire at all") is
 *       what keeps a retired exemption from reading as live just because another
 *       instance of the same code exists elsewhere in the file. A suppression that
 *       suppresses nothing is a finding — its justification has retired underneath
 *       it. The file is restored in a `finally` and verified byte-for-byte by
 *       sha256; a failed restore aborts with exit 2 rather than leaving the tree
 *       modified. Cost: two `svelte-check` passes per (file, code). Sites outside the
 *       `tsconfig.json` include (`svelte-tests/`, which `svelte-check` does not
 *       check) are reported as `skipped` — honestly, not silently.
 *   R6  **relaxation carrier**: every `--compiler-warnings` entry in
 *       `package.json`'s `typecheck:svelte` must be declared in the same JSON
 *       with a `reason` and a level, and vice versa. Today both are empty, i.e.
 *       the gate asserts "no compiler warning is relaxed anywhere" — the only
 *       sanctioned way to relax one is to write the reason at that code.
 *
 * Usage (from frontend-ts):
 *   node scripts/svelte-ignore-scan.mjs              # gate (R0–R6, non-zero on finding)
 *   node scripts/svelte-ignore-scan.mjs --no-live    # R0–R4, R6 only (triage / offline)
 *   node scripts/svelte-ignore-scan.mjs --json       # machine-readable report
 *   node scripts/svelte-ignore-scan.mjs --selftest   # pin the parsers first
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_PATH = join(root, "scripts", "svelte-ignore-allowlist.json");
const PACKAGE_PATH = join(root, "package.json");
const SVELTE_CHECK_BIN = join(root, "node_modules", ".bin", "svelte-check");
const TSCONFIG = "./tsconfig.json";

/** Corpus of the carrier/liveness checks. */
const CORPORA = ["src", "svelte-tests"];
/** Only these are matched by `tsconfig.json`'s `include`, so only these can be probed. */
const TSCOVERED = ["src/"];
/** A "reason" shorter than this is a label, not a reason. */
const MIN_REASON = 24;

const normWS = (s) => s.replace(/\s+/g, " ").trim();
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// --- file discovery ---------------------------------------------------------
function walkSvelte(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist" || ent.name === "coverage") continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkSvelte(p, acc);
    else if (ent.name.endsWith(".svelte")) acc.push(p);
  }
  return acc;
}

/**
 * Parse a **single-line** `<!-- svelte-ignore … -->` comment, mirroring Svelte's
 * own grammar (`svelte/src/compiler/utils/extract_svelte_ignore.js`): codes are
 * comma-separated, and everything after the first token *without* a trailing
 * comma is prose. Getting this wrong in either direction is a real defect here:
 * a too-greedy reader invents codes that do not exist, a too-lax one skips a
 * suppression entirely.
 *
 * @returns {null | { codes: string[], malformed: string|null }} null = this line
 *   is not a `svelte-ignore` comment at all.
 */
export function parseIgnoreComment(line) {
  const m = /^[ \t]*<!--[ \t]*svelte-ignore\b([\s\S]*?)-->[ \t]*$/.exec(line);
  if (!m) return null;
  const body = m[1].trim();
  if (!body) return { codes: [], malformed: "names no warning code" };
  const codes = [];
  for (const token of body.split(/\s+/)) {
    const code = token.replace(/,+$/, "");
    if (!/^[A-Za-z0-9_$-]+$/.test(code)) break;
    codes.push(code);
    if (!token.endsWith(",")) break; // Svelte: no comma ⇒ the rest is prose
  }
  if (codes.length === 0) return { codes: [], malformed: "names no usable warning code" };
  return { codes, malformed: null };
}

/**
 * The HTML comment block immediately above `lineIndex` — the "reason on site".
 * Read as a **block** (walks up to its `<!--`), because a real reason is often
 * prose wrapped over two lines (the `FilesApp` video exemption is exactly that).
 * A block that is itself a `svelte-ignore` is not a reason.
 *
 * @returns {null | { text: string, startLine: number }} whitespace-normalised text.
 */
export function reasonBlockAbove(lines, lineIndex) {
  const j = lineIndex - 1;
  if (j < 0) return null;
  if (!/-->/.test(lines[j])) return null;
  let start = j;
  while (start >= 0 && !/<!--/.test(lines[start])) start--;
  if (start < 0) return null;
  if (!/^[ \t]*<!--/.test(lines[start])) return null;
  const raw = lines.slice(start, j + 1).join("\n");
  if (raw.split("<!--").length !== 2 || raw.split("-->").length !== 2) return null;
  if (/svelte-ignore/.test(raw)) return null;
  const inner = raw.replace(/^[\s\S]*?<!--/, "").replace(/-->[\s\S]*$/, "");
  return { text: normWS(inner), startLine: start + 1 };
}

/** Every suppression site in the corpus, plus the ones this scanner cannot read. */
export function collectSites(rootDir, corpora = CORPORA) {
  const files = corpora.flatMap((c) => walkSvelte(join(rootDir, c)));
  const sites = [];
  const malformed = [];
  for (const abs of files) {
    const rel = relative(rootDir, abs).split("\\").join("/");
    const lines = readFileSync(abs, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/svelte-ignore/.test(line)) return;
      const parsed = parseIgnoreComment(line);
      if (!parsed) {
        malformed.push({ file: rel, line: i + 1, why: "not a single-line `<!-- svelte-ignore … -->` comment" });
        return;
      }
      if (parsed.malformed) {
        malformed.push({ file: rel, line: i + 1, why: parsed.malformed });
        return;
      }
      const reason = reasonBlockAbove(lines, i);
      for (const code of parsed.codes) {
        sites.push({
          file: rel,
          line: i + 1,
          code,
          siteReason: reason ? reason.text : null,
          siteReasonLine: reason ? reason.startLine : null,
        });
      }
    });
  }
  return { sites, malformed };
}

/** Sites the liveness probe can actually measure (`tsconfig.json` covers them). */
export function isTsconfigCovered(file) {
  return TSCOVERED.some((p) => file.startsWith(p));
}

// --- the carrier ------------------------------------------------------------
export function loadAllowlist(path) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const ignores = Array.isArray(doc.ignores) ? doc.ignores : [];
  const compilerWarnings = Array.isArray(doc.compilerWarnings) ? doc.compilerWarnings : [];
  return { ignores, compilerWarnings };
}

/** `--compiler-warnings "css_unused_selector:ignore,…"` → Map(code → level). */
export function parseCompilerWarningsFlag(scriptText) {
  const m = /--compiler-warnings[= ]"([^"]*)"/.exec(scriptText);
  if (!m) return new Map();
  const out = new Map();
  for (const piece of m[1].split(",")) {
    const [code, level] = piece.split(":").map((s) => s.trim());
    if (code) out.set(code, level ?? "");
  }
  return out;
}

/** Carrier entries → the exact flag value they authorise (empty = no flag). */
export function buildCompilerWarningsFlag(entries) {
  return [...entries]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((e) => `${e.code}:${e.level}`)
    .join(",");
}

// --- svelte-check machine output --------------------------------------------
const unescapeJsonLike = (s) =>
  s.replace(/\\(["\\nrt])/g, (_, c) => ({ '"': '"', "\\": "\\", n: "\n", r: "\r", t: "\t" })[c]);

/** `<ts> ERROR|WARN "<file>" <line>:<col> "<message>"` — one diagnostic per line. */
export function parseMachineDiagnostics(stdout) {
  const out = [];
  for (const raw of stdout.split("\n")) {
    const m = /^\d+ (ERROR|WARN) "([^"]+)" (\d+):(\d+) "((?:[^"\\]|\\.)*)"$/.exec(raw.trim());
    if (!m) continue;
    out.push({
      level: m[1],
      file: m[2].split("\\").join("/"),
      line: Number(m[3]),
      col: Number(m[4]),
      message: unescapeJsonLike(m[5]),
    });
  }
  return out;
}

/**
 * How many `ERROR`s with this code does `svelte-check` report **in this file**,
 * with that one code forced to `error`?
 *
 * Counting (rather than "is it reported at all") is what makes R5 independent of
 * the *other* suppressions in the same file: a second, unsuppressed instance of
 * the same code would make a retired exemption read as live under a
 * "did the code fire anywhere in this file" test. Measured against that
 * misreading (the first version of this probe): moving an ignore away from the
 * `<video>` while another instance of the same warning existed kept the verdict
 * "live".
 */
export function countCodeDiagnostics(file, code) {
  let out = "";
  try {
    out = execFileSync(
      SVELTE_CHECK_BIN,
      [file, "--tsconfig", TSCONFIG, "--output", "machine", "--compiler-warnings", `${code}:error`],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  return parseMachineDiagnostics(out).filter(
    (d) => d.level === "ERROR" && d.file === file && d.message.includes(`https://svelte.dev/e/${code}`),
  ).length;
}

/**
 * R5 — is this suppression still suppressing something?
 *
 * Count that one code in the file, remove **this** `svelte-ignore` line, count
 * again: it is live iff the removal made the count go **up**. This is the only
 * instrument that can tell a live exemption from a retired one — measured:
 * svelte-check reports nothing at all for an ignore that matches no warning, so
 * no other gate in this repo can see the difference.
 *
 * The file is restored in `finally` from the bytes we read, verified by sha256;
 * a failed restore aborts with exit 2 rather than leaving a modified tree.
 *
 * @returns {{ status: "live"|"dead"|"skipped"|"error", why?: string, before?: number, after?: number }}
 */
export function probeLiveness(site, baseCount = null) {
  if (!isTsconfigCovered(site.file)) {
    return { status: "skipped", why: "outside tsconfig.json include (svelte-check does not check it)" };
  }
  const abs = join(root, site.file);
  const original = readFileSync(abs);
  const before = sha256(original);
  const lines = original.toString("utf8").split("\n");
  const target = lines[site.line - 1] ?? "";
  if (!parseIgnoreComment(target)) {
    return { status: "error", why: `line ${site.line} is not a suppression comment` };
  }
  const withSuppression = baseCount ?? countCodeDiagnostics(site.file, site.code);
  writeFileSync(abs, lines.filter((_, i) => i !== site.line - 1).join("\n"));
  let withoutSuppression;
  try {
    withoutSuppression = countCodeDiagnostics(site.file, site.code);
  } finally {
    writeFileSync(abs, original);
    const after = sha256(readFileSync(abs));
    if (after !== before) {
      console.error(
        `[svelte-ignore-scan] CRITICAL: failed to restore ${site.file} byte-for-byte (${before} → ${after}). ` +
          `The working tree is modified — restore it from git before doing anything else.`,
      );
      process.exit(2);
    }
  }
  return withSuppression === undefined || withoutSuppression > withSuppression
    ? { status: "live", before: withSuppression, after: withoutSuppression }
    : { status: "dead", before: withSuppression, after: withoutSuppression };
}

// --- rules ------------------------------------------------------------------
const key = (file, code) => `${file}::${code}`;

/** R0–R4 + R6 (+R5 when `live`). Reads the tree; only the probe writes (and restores). */
export function runChecks({ live = true, rootDir = root, allowlistPath = ALLOWLIST_PATH } = {}) {
  const { sites, malformed } = collectSites(rootDir);
  const { ignores, compilerWarnings } = loadAllowlist(allowlistPath);
  const findings = [];
  const add = (rule, message) => findings.push({ rule, message });

  // R0 — a suppression this scanner cannot read would be skipped in silence.
  for (const m of malformed) add("R0", `${m.file}:${m.line} ${m.why}`);

  // Codes Svelte actually knows — the difference between a suppression and a word.
  const compiler = loadSvelteWarningCodes(rootDir);

  const declared = new Map();
  for (const e of ignores) {
    const file = typeof e.file === "string" ? e.file : "";
    const code = typeof e.code === "string" ? e.code : "";
    if (!file || !code) {
      add("R1", `allow-list entry without a string "file"+"code": ${JSON.stringify(e)}`);
      continue;
    }
    declared.set(key(file, code), e);
    // R2 — the reason must exist (the anti-drift half is checked against the site below).
    if (typeof e.reason !== "string" || normWS(e.reason).length < MIN_REASON) {
      add("R2", `${file} :: ${code} — the entry's "reason" is missing or shorter than ${MIN_REASON} chars`);
    }
  }

  const seen = new Set();
  for (const s of sites) {
    // R7 — a token that is not a Svelte warning code suppresses nothing. Reporting
    // it here is not redundant with svelte-check: this message carries the file
    // and line, and it is the reason no allow-list entry is demanded below.
    if (!compiler.codes.has(s.code)) {
      add(
        "R7",
        `${s.file}:${s.line} names \`${s.code}\`, which is not a Svelte warning code` +
          (compiler.legacy.has(s.code) ? " (legacy code: svelte-check reports `legacy_code`)" : "") +
          ` — nothing is suppressed here (svelte-check reports \`unknown_code\`)`,
      );
      continue;
    }
    const k = key(s.file, s.code);
    seen.add(k);
    const entry = declared.get(k);
    // R1 — carrier
    if (!entry) {
      add(
        "R1",
        `${s.file}:${s.line} suppresses \`${s.code}\` but no entry declares it — add { file, code, reason } to scripts/svelte-ignore-allowlist.json`,
      );
      continue;
    }
    // R2 — the two carriers must say the same thing (site comment ⇄ JSON reason)
    if (typeof entry.reason === "string" && s.siteReason && !normWS(entry.reason).includes(s.siteReason)) {
      add(
        "R2",
        `${s.file} :: ${s.code} — the allow-list "reason" does not contain the on-site comment (line ${s.siteReasonLine}) verbatim. ` +
          `Quote the site sentence in the JSON or fix the site comment: the two must not drift apart`,
      );
    }
    // R4 — reason on site
    if (!s.siteReason) {
      add(
        "R4",
        `${s.file}:${s.line} — no HTML comment directly above the suppression (the reason lives in the JSON, but a reader of this file cannot see it)`,
      );
    } else if (s.siteReason.length < MIN_REASON) {
      add("R4", `${s.file}:${s.line} — the on-site reason is ${s.siteReason.length} chars (min ${MIN_REASON}); a label is not a reason`);
    }
  }
  // R3 — stale entries (the list may not rot, nor pre-allow an unwritten site)
  for (const [k, e] of declared) {
    if (!seen.has(k)) add("R3", `${e.file} :: ${e.code} — declared, but no such suppression exists (remove the entry)`);
  }

  // R6 — the relaxation carrier: flag ⇄ JSON must agree, and a relaxed code needs
  // a written reason *at that code* (the discipline REQ-A471 recorded, now enforced).
  for (const e of compilerWarnings) {
    if (typeof e.code !== "string" || !e.code) add("R6", `compilerWarnings entry without "code": ${JSON.stringify(e)}`);
    if (e.level !== "error" && e.level !== "ignore") {
      add("R6", `compilerWarnings ${e.code}: "level" must be "error" or "ignore" (got ${JSON.stringify(e.level)})`);
    }
    if (typeof e.reason !== "string" || normWS(e.reason).length < MIN_REASON) {
      add("R6", `compilerWarnings ${e.code}: no written "reason" (this is the only sanctioned place to relax a compiler warning)`);
    }
  }
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
  } catch (err) {
    // A broken package.json is a finding here, not a stack trace: this gate is
    // the one that reads the flag out of it.
    add("R6", `package.json is not valid JSON (${err.message}) — cannot read the declared --compiler-warnings`);
  }
  const flag = parseCompilerWarningsFlag(pkg.scripts?.["typecheck:svelte"] ?? "");
  const wanted = buildCompilerWarningsFlag(compilerWarnings);
  const actual = buildCompilerWarningsFlag([...flag].map(([code, level]) => ({ code, level })));
  if (wanted !== actual) {
    add(
      "R6",
      `package.json "typecheck:svelte" carries --compiler-warnings "${actual}" but the carrier declares "${wanted}" — ` +
        `a relaxation must be declared in scripts/svelte-ignore-allowlist.json with its reason, never by editing the flag alone`,
    );
  }

  // R5 — liveness, last: no point probing a site the carrier has not accepted.
  const liveness = [];
  if (live) {
    const baseCounts = new Map();
    for (const s of sites) {
      if (!seen.has(key(s.file, s.code))) continue;
      const k = key(s.file, s.code);
      let base = null;
      if (isTsconfigCovered(s.file)) {
        if (!baseCounts.has(k)) baseCounts.set(k, countCodeDiagnostics(s.file, s.code));
        base = baseCounts.get(k);
      }
      const r = probeLiveness(s, base);
      liveness.push({ ...s, ...r });
      if (r.status === "dead") {
        add(
          "R5",
          `${s.file}:${s.line} \`${s.code}\` suppresses nothing (that code is reported ${r.after}× in this file with and without this ignore) — the reason it records may no longer hold`,
        );
      } else if (r.status === "error") {
        add("R5", `${s.file}:${s.line} ${r.why}`);
      }
    }
  }

  return { sites, ignores, compilerWarnings, findings, liveness, live };
}

// --- "what is a suppression?" ------------------------------------------------
/**
 * The set of codes Svelte itself recognises, read **from the installed compiler**
 * rather than hard-coded here. This is not about catching typos (svelte-check
 * already reports `unknown_code` and `--fail-on-warnings` makes it fatal): it is
 * what lets this scanner tell a *suppression* from a word. The grammar alone
 * cannot — `<!-- svelte-ignore a11y_x, because …, -->` yields the token `because`,
 * and treating that as a code would demand an allow-list entry for prose.
 *
 * @returns {{ codes: Set<string>, legacy: Set<string> }}
 */
export function loadSvelteWarningCodes(rootDir = root) {
  const warningsSrc = readFileSync(join(rootDir, "node_modules/svelte/src/compiler/warnings.js"), "utf8");
  const constantsSrc = readFileSync(join(rootDir, "node_modules/svelte/src/constants.js"), "utf8");
  const extractSrc = readFileSync(join(rootDir, "node_modules/svelte/src/compiler/utils/extract_svelte_ignore.js"), "utf8");
  return { codes: extractWarningCodes(warningsSrc, constantsSrc), legacy: extractLegacyCodes(extractSrc) };
}

/** Pure extraction, so `--selftest` can pin it without `node_modules`. */
export function extractWarningCodes(warningsSrc, constantsSrc) {
  const codes = new Set();
  for (const m of warningsSrc.matchAll(/\bw\([^,]+,\s*'([a-z0-9_]+)'/g)) codes.add(m[1]);
  const list = /export const codes = \[([\s\S]*?)\n\];/.exec(warningsSrc);
  if (list) for (const m of list[1].matchAll(/'([a-z0-9_]+)'/g)) codes.add(m[1]);
  const ign = /IGNORABLE_RUNTIME_WARNINGS = [\s\S]*?\(\[([\s\S]*?)\]\)/.exec(constantsSrc);
  if (ign) for (const m of ign[1].matchAll(/'([a-z0-9_]+)'/g)) codes.add(m[1]);
  return codes;
}

/** Legacy dashed codes Svelte still accepts but reports as `legacy_code`. */
export function extractLegacyCodes(extractSrc) {
  const legacy = new Set();
  const map = /const replacements = \{([\s\S]*?)\};/.exec(extractSrc);
  if (map) for (const m of map[1].matchAll(/'([a-z0-9_-]+)':\s*'/g)) legacy.add(m[1]);
  return legacy;
}


// --- selftest ----------------------------------------------------------------
/**
 * `--selftest` pins the readers this gate stands on: the ignore-comment grammar
 * (mirroring Svelte's own `extract_svelte_ignore`), the "reason on site" block
 * reader, the `--compiler-warnings` flag parser and the machine-output reader.
 * A silently-wrong reader here is worse than no gate at all: too lax and a
 * suppression is skipped, too greedy and prose becomes a code that then demands
 * an allow-list entry for a word.
 */
function runSelftest() {
  let total = 0;
  let failed = 0;
  const check = (name, cond) => {
    total++;
    if (!cond) {
      console.error(`[svelte-ignore-scan] selftest FAIL: ${name}`);
      failed++;
    }
  };
  const codesOf = (line) => parseIgnoreComment(line)?.codes ?? null;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  check("single code", same(codesOf(`  <!-- svelte-ignore a11y_media_has_caption -->`), ["a11y_media_has_caption"]));
  check("comma-separated codes", same(codesOf(`<!-- svelte-ignore a11y_x, css_unused_selector -->`), ["a11y_x", "css_unused_selector"]));
  check("space-separated: the rest is prose (Svelte's rule)", same(codesOf(`<!-- svelte-ignore a11y_x a11y_y -->`), ["a11y_x"]));
  check("dashed legacy code kept verbatim", same(codesOf(`<!-- svelte-ignore unused-export-let -->`), ["unused-export-let"]));
  check("no code named ⇒ malformed", parseIgnoreComment(`<!-- svelte-ignore -->`)?.malformed === "names no warning code");
  check("not an ignore comment ⇒ null", parseIgnoreComment(`<!-- a note -->`) === null);
  check("longer word is not `svelte-ignore`", parseIgnoreComment(`<!-- svelte-ignoreness -->`) === null);
  check("two-line comment is not parsed (R0 catches it)", parseIgnoreComment(`<!-- svelte-ignore a11y_x`) === null);

  const multi = [
    "  <!-- The file is the user's own: a captions track can only come from the file itself, and",
    "       synthesizing one we do not have would put a claim on screen that nobody made. -->",
    "  <!-- svelte-ignore a11y_media_has_caption -->",
  ];
  const block = reasonBlockAbove(multi, 2);
  check("multi-line reason block is read whole", !!block && block.text.startsWith("The file is the user's own:") && block.text.endsWith("nobody made."));
  check("reason block start line", block?.startLine === 1);
  check("no comment above ⇒ null", reasonBlockAbove(["  <div>", "  <!-- svelte-ignore a11y_x -->"], 1) === null);
  check("another ignore is not a reason", reasonBlockAbove(["  <!-- svelte-ignore a11y_y -->", "  <!-- svelte-ignore a11y_x -->"], 1) === null);
  check("plain code above (not a comment) ⇒ null", reasonBlockAbove(["  <div>", "  </div>"], 1) === null);

  const flag = parseCompilerWarningsFlag(`svelte-check --tsconfig ./tsconfig.json --fail-on-warnings --compiler-warnings "b:ignore,a:error"`);
  check("flag: both entries", flag.get("a") === "error" && flag.get("b") === "ignore");
  check("flag: absent ⇒ empty", parseCompilerWarningsFlag(`svelte-check --fail-on-warnings`).size === 0);
  check("flag: built back sorted", buildCompilerWarningsFlag([{ code: "b", level: "ignore" }, { code: "a", level: "error" }]) === "a:error,b:ignore");

  const machine = [
    `1789802469981 START "/w"`,
    `1789802469981 ERROR "src/svelte/FilesApp.svelte" 1075:11 "<video> elements must have a <track kind=\\"captions\\">\\nhttps://svelte.dev/e/a11y_media_has_caption"`,
    `1789802470000 COMPLETED 141 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS`,
  ].join("\n");
  const diags = parseMachineDiagnostics(machine);
  check("machine output: one diagnostic", diags.length === 1);
  check(
    "machine output: file/level/code",
    diags[0]?.file === "src/svelte/FilesApp.svelte" &&
      diags[0]?.level === "ERROR" &&
      diags[0]?.message.includes("https://svelte.dev/e/a11y_media_has_caption"),
  );
  check("machine output: escaped quote kept", diags[0]?.message.includes(`<track kind="captions">`));

  const real = extractWarningCodes(
    `w(node, 'a11y_x', \`m\`);\nexport const codes = [\n\t'a11y_x',\n\t'css_y'\n];\n`,
    `export const IGNORABLE_RUNTIME_WARNINGS = /** @type {const} */ ([\n\t'await_waterfall'\n]);\n`,
  );
  check("code extraction: w() literal", real.has("a11y_x"));
  check("code extraction: codes[]", real.has("css_y"));
  check("code extraction: IGNORABLE_RUNTIME_WARNINGS", real.has("await_waterfall"));
  check("legacy code extraction", extractLegacyCodes(`const replacements = {\n\t'unused-export-let': 'export_let_unused'\n};`).has("unused-export-let"));

  check("tsconfig coverage predicate", isTsconfigCovered("src/svelte/A.svelte") && !isTsconfigCovered("svelte-tests/fixtures/A.svelte"));

  console.log(`[svelte-ignore-scan] selftest: ${total} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}


// --- CLI ---------------------------------------------------------------------
function main() {
  const asJson = process.argv.includes("--json");
  const live = !process.argv.includes("--no-live");
  const report = runChecks({ live });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.findings.length === 0 ? 0 : 1);
  }

  if (report.findings.length === 0) {
    const files = new Set(report.sites.map((s) => s.file));
    const probed = report.liveness.filter((l) => l.status === "live").length;
    const skipped = report.liveness.filter((l) => l.status === "skipped");
    console.log(
      `[svelte-ignore-scan] OK — ${report.sites.length} suppression(s) in ${files.size} file(s), each declared in ` +
        `scripts/svelte-ignore-allowlist.json with a reason; 0 undeclared, 0 stale, 0 dead` +
        (live ? `; liveness probed: ${probed} live` : " (liveness not probed: --no-live)") +
        `; --compiler-warnings relaxations declared: ${report.compilerWarnings.length}.`,
    );
    for (const s of skipped) {
      console.log(`[svelte-ignore-scan] note: ${s.file}:${s.line} (${s.code}) liveness skipped — ${s.why}`);
    }
    process.exit(0);
  }

  const byRule = new Map();
  for (const f of report.findings) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f.message);
  }
  for (const rule of [...byRule.keys()].sort()) {
    console.error(`[svelte-ignore-scan] ${rule} — ${byRule.get(rule).length} finding(s):`);
    for (const msg of byRule.get(rule)) console.error(`       - ${msg}`);
  }
  console.error(
    `\n[svelte-ignore-scan] ${report.findings.length} finding(s). Every compiler suppression must (a) be declared in ` +
      `scripts/svelte-ignore-allowlist.json with a reason that quotes the on-site comment, (b) keep a prose reason on ` +
      `site, and (c) still suppress something. A relaxed --compiler-warnings code needs a declared reason too.`,
  );
  process.exit(1);
}

if (process.argv.includes("--selftest")) runSelftest();
main();

