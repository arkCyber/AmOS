#!/usr/bin/env node
/**
 * vocab-mirror-scan.mjs — "a vocabulary is spelled once".
 *
 * Motivation: the shell keeps several fixed sets of strings (media kinds, SMS folders,
 * quick-settings keys, form factors …). Twice now (REQ-A634, REQ-A638) a set was spelled
 * **twice in one file** — a hand-written union `type X = "a" | "b" | …` *and* a separate
 * array `const Y: readonly X[] = ["a", "b", …]` — with membership tested through
 * `(Y as readonly string[]).includes(v)`. That `as` cast is the tell: it erases the type
 * link exactly where the two spellings could disagree, so a value added to one and not the
 * other still compiles. The array (the runtime allowlist the code actually consults) then
 * silently rejects a real value the type says is legal — or the reverse.
 *
 * The fix is not "add a test". It is to make the array the **one declaration** and derive
 * the type from it (`const Y = […] as const; type X = (typeof Y)[number];`). Then an add,
 * rename, or remove is a single edit and the checker sees both sides at once.
 *
 * This gate is the missing sentence that keeps the fix from rotting. It scans every `.ts`
 * under `src/` for a union `type X = <string literals>` paired with an array `const Y: (readonly) X[] =
 * [<the same literals>]` — an **exact set match**, the shape that means "one vocabulary,
 * two spellings". It deliberately does *not* flag:
 *   - a `readonly X[]` array that is a deliberate **subset** (an allowlist) — the set does
 *     not equal the union, so it is not two spellings of the same thing;
 *   - the derived pattern (`const Y = […] as const; type X = (typeof Y)[number]`) — there
 *     is no second spelling to disagree with;
 *   - an array annotated with a different type, or with `string[]`.
 * The comparison is order-insensitive (a reorders is not drift) but exact in membership.
 *
 * Honesty boundary: this is a **syntax scan of `.ts` files under `src/`**, not a resolver.
 * It reads the string literals between the brackets and only understands the `X[]` /
 * `readonly X[]` annotation form (not `Array<X>`). A vocabulary expressed some third way
 * is out of scope — the gate claims exactly what it checks.
 *
 * Usage:
 *   node scripts/vocab-mirror-scan.mjs             # the gate
 *   node scripts/vocab-mirror-scan.mjs --selftest  # pin the extractors
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, ".."); // frontend-ts/
const SRC = join(ROOT, "src");
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".vite"]);

/** Comment-free source: `//` to end-of-line, and `/* … *​/` spans. */
export function stripComments(src) {
  return src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every `.ts` file under `dir`, skipping build/dependency directories. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * The exact-set string-literal unions in `src`: name → literal list.
 * Only pure literal unions (`"a" | "b" | …`, optional leading `|`) — a union containing a
 * non-literal member is a different thing and is skipped.
 */
export function literalUnions(src) {
  const out = new Map();
  const re = /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*\|?\s*((?:"[^"]*"\s*\|\s*)*\|?\s*"[^"]*")\s*;/g;
  for (const m of src.matchAll(re)) {
    out.set(m[1], [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]));
  }
  return out;
}

/**
 * Arrays explicitly annotated with a named element type: name → { typeName, literals }.
 * Only arrays whose body is nothing but string literals and commas qualify — a computed
 * element would make the "same literals" comparison meaningless.
 */
export function typedStringArrays(src) {
  const out = [];
  const re =
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*:\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\[\]\s*=\s*\[([\s\S]*?)\]\s*;/g;
  for (const m of src.matchAll(re)) {
    const [, arrName, typeName, body] = m;
    if (/[^\s,"]/.test(body.replace(/"[^"]*"/g, ""))) continue; // literals + commas only
    out.push({ arrName, typeName, literals: [...body.matchAll(/"([^"]*)"/g)].map((x) => x[1]) });
  }
  return out;
}

/** Same membership, ignoring order. */
export function sameSet(a, b) {
  if (a.length !== b.length) return false;
  return [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
}

/** The two-spelling violations in one file: [{ union, array, count }]. */
export function findViolations(src) {
  const unions = literalUnions(stripComments(src));
  const hits = [];
  for (const { arrName, typeName, literals } of typedStringArrays(stripComments(src))) {
    const u = unions.get(typeName);
    if (u && sameSet(u, literals)) hits.push({ union: typeName, array: arrName, count: u.length });
  }
  return hits;
}

function selftest() {
  const problems = [];
  const want = (label, got, expected) => {
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      problems.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
    }
  };

  // POSITIVE — the exact defect: same six strings spelled twice.
  const twoSpell = `export type Cap = "camera" | "microphone";\nexport const CAPS: readonly Cap[] = ["camera", "microphone"];`;
  want("positive: exact-set union+array", findViolations(twoSpell), [
    { union: "Cap", array: "CAPS", count: 2 },
  ]);

  // POSITIVE — multi-line union with a leading `|` and inline comments (the shape that hid
  // from the first detector), plus a multi-line array.
  const messy = `export type Dir =\n  | "root" // the root\n  | "camera";\nexport const DIRS: readonly Dir[] = [\n  "root",\n  "camera",\n];`;
  want("positive: multi-line union with comments", findViolations(messy), [
    { union: "Dir", array: "DIRS", count: 2 },
  ]);

  // NEGATIVE — a deliberate subset allowlist is NOT two spellings of the same thing.
  const subset = `export type Cap = "camera" | "microphone" | "location";\nexport const READONLY: readonly Cap[] = ["camera", "location"];`;
  want("negative: subset allowlist", findViolations(subset), []);

  // NEGATIVE — the derived pattern is the fix, not the defect.
  const derived = `export const CAPS = ["camera", "microphone"] as const;\nexport type Cap = (typeof CAPS)[number];`;
  want("negative: derived pattern", findViolations(derived), []);

  // NEGATIVE — an array of a different type must not be paired with the union by literal
  // coincidence alone.
  const other = `export type Cap = "camera" | "microphone";\nexport type Mode = "a";\nexport const MODES: readonly Mode[] = ["a", "a"];`;
  want("negative: no same-set pair", findViolations(other), []);

  // NEGATIVE — a computed element disqualifies the array (not a pure literal list).
  const computed = `export type Cap = "camera";\nexport const CAPS: readonly Cap[] = ["camera", ...MORE];`;
  want("negative: computed element", findViolations(computed), []);

  // stripComments must not eat a URL's `//` mid-string — it errs toward removing, which is
  // safe here because we only read the brackets' literals.
  want("stripComments: drops a block comment", stripComments(`a /* x */ b`), "a  b");

  if (problems.length > 0) {
    console.error(`[vocab-mirror-scan] selftest FAIL:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`[vocab-mirror-scan] selftest: 8 assertion(s), 0 failure(s).`);
}

if (process.argv.includes("--selftest")) {
  selftest();
  process.exit(0);
}

const files = walk(SRC);
const problems = [];
let pairs = 0;
for (const f of files) {
  const hits = findViolations(readFileSync(f, "utf8"));
  for (const h of hits) {
    pairs++;
    problems.push(
      `${relative(ROOT, f)}: type ${h.union} and const ${h.array} are the same ${h.count}-string ` +
        `vocabulary spelled twice`,
    );
  }
}

if (problems.length > 0) {
  console.error(`[vocab-mirror-scan] FAIL — ${problems.length} duplicated vocabulary(ies):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nMake the array the one declaration and derive the type from it:\n" +
      `  export const Y = ["a", "b"] as const;\n` +
      `  export type X = (typeof Y)[number];\n` +
      "Then an add/rename/remove is one edit and the checker sees both sides at once.\n" +
      "If the array is a deliberate subset of the type, do not annotate it with the union\n" +
      "(that is what makes it a second spelling) — give it its own name.",
  );
  process.exit(1);
}
console.log(
  `[vocab-mirror-scan] OK — ${files.length} .ts file(s) scanned, 0 duplicated vocabulary ` +
    `(no union/array pair of the same literals).`,
);
