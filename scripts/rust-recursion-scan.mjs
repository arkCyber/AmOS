#!/usr/bin/env node
/**
 * rust-recursion-scan.mjs — static "no recursion in production Rust" scan
 * (NASA Power of 10 rule 1: restrict control flow — no goto, no recursion).
 *
 * Why: the aerospace audit (`docs/AEROSPACE_SOFTWARE_AUDIT.md` §2) recorded "Rust has no
 * goto" and left recursion unchecked, because nothing static looked for it. The gap is
 * not academic: `amos-link`'s key-expression matcher was a recursive backtracker whose
 * worst case at the 32-segment ceiling explored ~10^11 paths — and it ran **while holding
 * the broker's registry lock**, so one wildcard-heavy pattern could stall every publish
 * on the node (REQ-A214). A property that a reviewer has to *remember* is not a property;
 * this gate makes it checkable.
 *
 * What it finds (deliberately narrow, to stay high-signal):
 *   • **direct self-recursion** — a `fn NAME` whose own (string-, char- and
 *     comment-stripped) body calls `NAME`: a bare call for a free function, `self.NAME(…)` /
 *     `Self::NAME(…)` for a method;
 *   • **mutual recursion inside one file** — a cycle in the call graph the same pass builds
 *     (`fn a() { b() } fn b() { a() }`, or two methods of one type calling each other). The
 *     graph is resolved the way Rust resolves it: `Type::NAME` prefers the **inherent** item,
 *     so a trait impl delegating to the inherent method of the same name
 *     (`impl Discovery for Bus { fn announce(&self) { Bus::announce(self) } }`) is a call to a
 *     different function, and same-named methods on two types are two nodes. Field accesses
 *     (`self.path` in a getter) are not calls; a call on some other value (`other.run()`)
 *     cannot be resolved by name and contributes no edge.
 *
 * Workspace-wide (REQ-A443). The scan also builds a **whole-workspace call graph**, so a cycle
 * spanning two files or two crates is caught, not only one inside a single file. The global pass
 * adds an edge only where the target is **unambiguous**: a call the file itself cannot resolve
 * contributes an edge *iff* exactly one production definition of that key (`Type::name`, or a
 * bare free-function name) exists in the whole workspace. Two crates with a same-named method
 * therefore contribute **no** edge — a false cycle is worse than a missed one, the contract every
 * resolver here keeps — and only cycles whose members live in ≥2 files are reported by it, so the
 * per-file findings keep their stable shape.
 *
 * What it does **not** claim (honest boundaries, spelled out rather than implied):
 *   • a target key that is **ambiguous** workspace-wide (two same-named types, or two free
 *     functions): the global pass drops the edge rather than guessing which one it means;
 *   • a call the resolver cannot name at all: a method call on some other value
 *     (`other.run()`), or a qualified path deeper than `crate::Type::name` (see `calleesOf`);
 *   • dynamic recursion through a trait object, a function pointer or a closure;
 *   • macro-generated code (`macro_rules!` bodies, `include!`d files) — this workspace uses
 *     neither for control flow;
 *   • `#[cfg(test)]` sections and `crates/**​/tests/` are skipped: a recursive test helper
 *     is not production behaviour.
 *
 * Gated as a **ratchet** (`scripts/rust-recursion-baseline.json`): the existing backlog is
 * frozen with a reason per entry, a **new** recursion finding fails the scan, and a baseline
 * entry that no longer matches **fails too** (REQ-A447 — the ratchet must shrink, not rot;
 * printing a note was not enough). The baseline
 * is **empty** today (the two recursive functions that ever existed in the production tree were
 * rewritten as a dynamic program and a work list, REQ-A214/A215), so any finding at all is a
 * regression. The scanned-file count is *printed* by every run rather than written down here,
 * because a number in a comment is a claim nobody re-measures — the lesson of F-DEV-031.
 *
 * The scanner is dependency-free (regex + fs) and never executes or imports the Rust it
 * inspects.
 *
 * Usage (from the repo root):
 *   node scripts/rust-recursion-scan.mjs                 # gate (non-zero on regression)
 *   node scripts/rust-recursion-scan.mjs --json          # machine-readable report
 *   node scripts/rust-recursion-scan.mjs --selftest      # pin the extractor
 *   node scripts/rust-recursion-scan.mjs --update-baseline
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cratesDir = join(repoRoot, "crates");
const baselinePath = join(repoRoot, "scripts", "rust-recursion-baseline.json");

// An unrecognised flag is a **failure**, not a no-op. `docs/POWER_OF_10.md`'s verification block
// spelled this script's selftest as `--self-test`, which it does not implement — so the documented
// command silently ran the *gate* and printed a clean line (the F-DEV-005 shape: an instrument
// answering a different question). Measured on 2026-09-19 across all five `-scan` gates; the flag
// is rejected here so the mistake cannot silently pass again.
const KNOWN_FLAGS = new Set(["--selftest", "--json", "--update-baseline"]);
const unknownFlags = process.argv
  .slice(2)
  .filter((f) => f.startsWith("-") && !KNOWN_FLAGS.has(f));
if (unknownFlags.length > 0) {
  console.error(
    `[recursion-scan] unknown flag(s): ${unknownFlags.join(", ")} — known: ${[...KNOWN_FLAGS].join(", ")}`,
  );
  process.exit(2);
}

const SKIP_DIRS = new Set(["node_modules", "target", ".git", "gen"]);

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (ent.name.endsWith(".rs")) acc.push(p);
  }
  return acc;
}

/** Production sources only: `crates/<crate>/src/**`, no `tests/` directories. */
const rustFiles = readdirSync(cratesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "target")
  .map((d) => join(cratesDir, d.name, "src"))
  .flatMap((src) => walk(src))
  .filter((f) => !f.includes("/tests/"))
  .sort();

/** Drop everything from the first `#[cfg(test)]` (test modules hold code too). */
function stripTestModules(src) {
  const i = src.indexOf("#[cfg(test)]");
  return i < 0 ? src : src.slice(0, i);
}

/**
 * Blank out comments and string/char literals, preserving every byte offset (and every
 * newline), so a call site can be searched for without a mention *inside a string or a
 * comment* counting as a call. Rust block comments nest; raw strings (`r#"…"#`) are honoured.
 */
function maskNonCode(src) {
  const out = src.split("");
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === "/" && src[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (src[j] === "*" && src[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    const raw = /^(b?r)(#*)"/.exec(src.slice(i, i + 8));
    if (raw) {
      const close = '"' + raw[2];
      const start = i + raw[0].length;
      const end = src.indexOf(close, start);
      const stop = end < 0 ? src.length : end + close.length;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "'") {
      const ch = /^'(?:\\.|[^'\\])'/.exec(src.slice(i, i + 6));
      if (ch) {
        blank(i, i + ch[0].length);
        i += ch[0].length;
        continue;
      }
      i++; // a lifetime such as `'a`
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Body of the braced block whose `{` sits at `open`, using the **masked** source so a
 * brace inside a string or a comment cannot desynchronise the count.
 */
function bodyOf(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") {
      depth--;
      if (depth === 0) return masked.slice(open + 1, i);
    }
  }
  return masked.slice(open + 1);
}

/**
 * Every `fn` declaration in a (masked) source: `{ name, bodyOpen }`.
 *
 * The declaration regex tolerates the qualifiers this workspace uses (`pub`, `pub(crate)`,
 * `async`, `unsafe`, `const`, `extern "C"`) and a generic parameter list; the body is the
 * first `{` after the parameter list — found by a paren-depth scan, so a `where` clause or
 * a generic bound with a `()` in it cannot confuse it.
 */
function extractFns(masked) {
  const out = [];
  const re =
    /\b(?:pub(?:\s*\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern\s+"[^"]*")\s+)*fn\s+([A-Za-z0-9_]+)/g;
  for (const m of masked.matchAll(re)) {
    let i = m.index + m[0].length;
    // Skip the parameter list (paren depth 0 across it), then any `-> Ty` / `where …`.
    while (i < masked.length && masked[i] !== "(") {
      if (masked[i] === "{" || masked[i] === ";") break; // not a body (a trait decl, a type)
      i++;
    }
    if (masked[i] !== "(") continue;
    let depth = 0;
    while (i < masked.length) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    while (i < masked.length && masked[i] !== "{" && masked[i] !== ";") i++;
    if (masked[i] !== "{") continue; // declaration without a body (`;` ahead)
    out.push({ name: m[1], bodyOpen: i, declAt: m.index });
  }
  return out;
}

/**
 * True when `body` calls `name` in a way that means *this* function:
 * a bare call (`name(` / `name::<T>(`), not a method call (`self.name(`), not a path call
 * (`other::name(`), and not a nested definition (`fn name(`).
 */
function bodyCalls(body, name) {
  const re = new RegExp(`(^|[^A-Za-z0-9_.:])${name}\\s*(?:::\\s*<[^>]*>)?\\s*\\(`, "g");
  for (const m of body.matchAll(re)) {
    // The character before the name decides: `.` and `:` were already excluded by the
    // regex, and a leading `fn` means this is a nested *definition*, not a call.
    const nameStart = m.index + m[1].length;
    const before = body.slice(Math.max(0, nameStart - 4), nameStart).trimEnd();
    if (before.endsWith("fn")) continue;
    return true;
  }
  return false;
}

/**
 * True when a **method** body recurses into itself: `self.name(…)`, `Self::name(…)` or
 * `Self::name::<T>(…)`. A bare `name(…)` inside a method is a free function in scope, so it
 * is deliberately not counted here (see `implRanges`).
 */
function bodyCallsMethod(body, name) {
  const re = new RegExp(
    `(?:\\bself\\s*\\.\\s*${name}|\\bSelf\\s*::\\s*${name})(?:\\s*::\\s*<[^>]*>)?\\s*\\(`,
    "g",
  );
  return re.test(body);
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

/**
 * Ranges of every `impl`/`trait` block in a (masked) source: `{ open, close, selfType }`.
 *
 * Needed because Rust name resolution differs between the two: inside an inherent method a
 * bare `open(…)` can only be a **free function** (a method call needs `self.` or `Self::`),
 * while a method recursing on itself writes `self.name(…)`. A scanner that ignores the
 * difference reports `TinyAlsaCapture::open` calling the module's FFI `open(...)` as
 * recursion — a false positive that would train the reader to ignore the gate.
 *
 * `selfType` (the type after `impl`/`for`, or the trait's own name) is what makes **mutual
 * recursion** detectable without inventing edges: `A::run` calling `self.help(…)` resolves to
 * `A::help`, so two same-named methods on two different types are two different nodes.
 */
function implRanges(masked) {
  const out = [];
  for (const m of masked.matchAll(/\b(?:impl|trait)\b/g)) {
    let i = m.index + m[0].length;
    while (i < masked.length && masked[i] !== "{" && masked[i] !== ";") i++;
    if (masked[i] !== "{") continue; // an `impl` without a body (a trait alias, a `;`)
    const header = masked.slice(m.index + m[0].length, i);
    let depth = 0;
    for (let j = i; j < masked.length; j++) {
      if (masked[j] === "{") depth++;
      else if (masked[j] === "}") {
        depth--;
        if (depth === 0) {
          out.push({ open: i, close: j, selfType: selfTypeOf(header), traitName: traitOf(header) });
          break;
        }
      }
    }
  }
  return out;
}

/** The self type of an `impl`/`trait` header, name-level: `Foo` in `impl Bar for Foo` too. */
function selfTypeOf(header) {
  // Drop a leading generic list (`impl<'a, T: Into<u8>> …`).
  let text = header.replace(/^\s*<[^>]*>/, "");
  const forAt = text.lastIndexOf(" for ");
  if (forAt >= 0) text = text.slice(forAt + 5);
  const name = /[A-Za-z_][A-Za-z0-9_]*/.exec(text);
  return name ? name[0] : null;
}

/**
 * The trait of an `impl Trait for Type` header (`null` for an inherent impl).
 *
 * It matters because Rust resolves `Type::name(…)` to the **inherent** item first: a trait
 * impl whose method delegates to the inherent one of the same name
 * (`impl Discovery for Bus { fn announce(&self) { Bus::announce(self) } }`) is *not*
 * recursion, and a scanner that merges both into one node reports it as a cycle — as the
 * first run of this extension did, four times, on `amos-link`'s discovery channels.
 */
function traitOf(header) {
  let text = header.replace(/^\s*<[^>]*>/, "");
  const forAt = text.lastIndexOf(" for ");
  if (forAt < 0) return null;
  const name = /[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(0, forAt));
  return name ? name[0] : null;
}

/**
 * Resolve one function's callees to the keys *this scan* uses (`Type::name` for methods,
 * `name` for free functions) — the edges of the call graph.
 *
 * Deliberately conservative: an unresolved call contributes **no** edge (a method call on
 * some other value, `other.run()`, cannot be resolved by name alone), so the analysis can
 * miss a cycle but never invent one — the same contract as the direct-recursion check.
 */
function calleesOfDetailed(masked, fn, index) {
  const resolved = new Set(); // keys *this file* defines — the per-file graph's edges
  const unresolved = new Set(); // candidate keys only the workspace pass can resolve
  const body = bodyOf(masked, fn.bodyOpen);
  // A call this file resolves becomes an edge here; one it cannot carries its *candidate* key
  // (`Type::name`, or a bare name) so `scanWorkspace` can still use it when the whole workspace
  // defines that key exactly once.
  const push = (local, candidate) => {
    if (local !== undefined) resolved.add(local);
    else if (candidate !== undefined) unresolved.add(candidate);
  };
  // `self.name(…)` / `Self::name(…)` — this type's own methods. The trailing `(` matters:
  // `self.path` in a getter is a *field* access, and counting those as calls made every
  // accessor a "recursive function" (170 of them on the first run).
  if (fn.selfType) {
    for (const m of body.matchAll(
      /\b(self\s*\.\s*|Self\s*::\s*)([A-Za-z_][A-Za-z0-9_]*)\s*(?:::\s*<[^>]*>)?\s*\(/g,
    )) {
      push(resolveMethod(index, fn.selfType, m[2]), `${fn.selfType}::${m[2]}`);
    }
  }
  // `Type::name(…)` — an explicit path to a type implemented in this file. **Only a path
  // that can actually name a local type**: one segment (`Timestamp::now()`), or two with a
  // relative-crate prefix (`crate::Timestamp::now()`). Anything longer belongs to another
  // crate/module — `amos_link::codec::Timestamp::now()` resolves *there*, not here — and
  // matching only its last two segments made every C-ABI bridge method in
  // `crates/amos-link-cc/src/lib.rs` look self-recursive (REQ-A387, 4 false positives; see
  // the selftest case "a qualified path to another crate's same-named method").
  const LOCAL_PREFIXES = new Set(["crate", "self", "super"]);
  for (const m of body.matchAll(
    /([A-Za-z_][A-Za-z0-9_]*(?:\s*::\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*::\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:::\s*<[^>]*>)?\s*\(/g,
  )) {
    const path = m[1].split(/\s*::\s*/);
    if (path.length === 1) {
      push(resolveMethod(index, path[0], m[2]), `${path[0]}::${m[2]}`);
      continue;
    }
    if (path.length === 2 && LOCAL_PREFIXES.has(path[0])) {
      push(resolveMethod(index, path[1], m[2]), `${path[1]}::${m[2]}`);
    }
  }
  // A bare `name(…)` — a free function (never this method), unless it is a definition.
  for (const m of body.matchAll(
    /(^|[^A-Za-z0-9_.:])([A-Za-z_][A-Za-z0-9_]*)\s*(?:::\s*<[^>]*>)?\s*\(/g,
  )) {
    const nameStart = m.index + m[1].length;
    const before = body.slice(Math.max(0, nameStart - 4), nameStart).trimEnd();
    if (before.endsWith("fn")) continue; // a nested definition, not a call
    push(index.all.has(m[2]) ? m[2] : undefined, m[2]);
  }
  return { resolved: [...resolved], unresolved: [...unresolved] };
}

/**
 * Edges the **per-file** graph uses: the calls this file resolves by itself. Kept as a wrapper
 * so `scanMasked` reads exactly as before; the workspace pass (`scanWorkspace`) uses the
 * detailed form, which also carries the candidates only a whole-workspace index can resolve.
 */
function calleesOf(masked, fn, index) {
  return calleesOfDetailed(masked, fn, index).resolved;
}

/** Every function in one masked source, keyed as the graph needs it. */
function functionsOf(masked) {
  const impls = implRanges(masked);
  const out = [];
  for (const fn of extractFns(masked)) {
    const block = impls.find((b) => fn.declAt > b.open && fn.declAt < b.close);
    const selfType = block ? (block.selfType ?? `?${fn.name}`) : null;
    const traitName = block ? block.traitName : null;
    // A trait impl gets its own node (`Type::name@Trait`), so delegating to the inherent
    // method of the same name is a call to a *different* function (see `traitOf`).
    const key =
      selfType === null
        ? fn.name
        : traitName
          ? `${selfType}::${fn.name}@${traitName}`
          : `${selfType}::${fn.name}`;
    out.push({ ...fn, selfType, traitName, key, line: lineOf(masked, fn.declAt) });
  }
  return out;
}

/** Lookup tables the resolver needs: every key, and the trait-impl nodes per `Type::name`. */
function indexFunctions(fns) {
  const all = new Set(fns.map((f) => f.key));
  const traitImpls = new Map();
  for (const f of fns) {
    if (!f.traitName || !f.selfType) continue;
    const base = `${f.selfType}::${f.name}`;
    traitImpls.set(base, [...(traitImpls.get(base) ?? []), f.key]);
  }
  return { all, traitImpls };
}

/**
 * Resolve `Type::name` to a node, using **Rust's own precedence**: an inherent item wins over
 * a trait impl's, and an ambiguous set (two traits providing the same name) resolves to
 * nothing — the caller's code could not compile either.
 */
function resolveMethod(index, type, name) {
  const base = `${type}::${name}`;
  if (index.all.has(base)) return base;
  const traits = index.traitImpls.get(base);
  return traits && traits.length === 1 ? traits[0] : undefined;
}


/**
 * Every recursive function (or cycle of functions) in one already-masked source.
 *
 * Direct self-recursion is a **cycle of length 1** in this graph, so one mechanism covers
 * both: the graph is built from the resolved callees, then an iterative DFS (white / grey /
 * black colouring — no recursion in the scanner either) reports every back edge. Members are
 * sorted so a cycle has one stable name (`a+b`), which is what the baseline keys on.
 *
 * Honest scope: the per-file graph's edges exist only between functions **defined in the same
 * file** and resolved by name (see `calleesOf`), so a cycle that spans two files, a bare method
 * call on another value, or dynamic dispatch through a trait object is not seen here — the first
 * of those is what `scanWorkspace` (REQ-A443) adds, and the header states the rest.
 */
function scanMasked(masked) {
  const fns = functionsOf(masked);
  const index = indexFunctions(fns);
  const graph = new Map(fns.map((f) => [f.key, calleesOf(masked, f, index)]));
  const keys = index.all;
  const lineOfKey = new Map(fns.map((f) => [f.key, f.line]));

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map([...keys].map((k) => [k, WHITE]));
  const cycles = new Map(); // sorted members joined -> { members, line }

  for (const start of keys) {
    if (colour.get(start) !== WHITE) continue;
    const path = [];
    // Each frame is [key, index into its callee list]; the path *is* the DFS stack, so a
    // grey node met again is a back edge and the cycle is the tail of this path.
    const stack = [[start, 0]];
    colour.set(start, GREY);
    path.push(start);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const [key, index] = frame;
      const callees = graph.get(key) ?? [];
      if (index >= callees.length) {
        colour.set(key, BLACK);
        stack.pop();
        path.pop();
        continue;
      }
      frame[1] = index + 1;
      const next = callees[index];
      if (colour.get(next) === GREY) {
        const members = path.slice(path.indexOf(next)).sort();
        const label = members.join("+");
        if (!cycles.has(label)) {
          cycles.set(label, { members, line: lineOfKey.get(next) ?? 0 });
        }
      } else if (colour.get(next) === WHITE) {
        colour.set(next, GREY);
        path.push(next);
        stack.push([next, 0]);
      }
    }
  }
  return [...cycles.values()];
}

/**
 * The **workspace-wide** pass (REQ-A443). The per-file pass cannot see a cycle split across two
 * files or two crates, and `docs/POWER_OF_10.md`'s residual-risk table registered exactly that
 * ("跨 crate 间接递归(扫描器只看 crate 内) → 扩展为 workspace-wide call graph"). This pass builds
 * one graph over every production file and adds an edge for a call the file could not resolve
 * **iff the whole workspace defines that key exactly once**.
 *
 * Why uniqueness rather than "the first definition with that name": a false cycle is worse than a
 * missed one — the REQ-A387 lesson, where matching a name without knowing *which* definition it
 * named produced four false positives. Two same-named types, or two free functions, make the
 * target ambiguous and the edge is dropped (unremarked; the header states the boundary).
 *
 * Only cycles whose members live in **≥2 files** are returned: a cycle inside one file is already
 * the per-file pass's finding, and reporting it twice would double every baseline entry.
 *
 * @param {{path: string, masked: string}[]} parsed every production file, masked and test-stripped
 */
function scanWorkspace(parsed) {
  const files = parsed.map(({ path, masked }) => {
    const fns = functionsOf(masked);
    const index = indexFunctions(fns);
    const node = (key) => `${path}::${key}`;
    const localNode = new Map();
    for (const f of fns) if (!localNode.has(f.key)) localNode.set(f.key, node(f.key));
    return { path, masked, fns, index, node, localNode };
  });

  // Every definition of each key, workspace-wide. `length > 1` ⇒ the key is ambiguous.
  const owners = new Map();
  for (const pf of files) {
    for (const f of pf.fns) {
      if (!owners.has(f.key)) owners.set(f.key, []);
      owners.get(f.key).push(pf.node(f.key));
    }
  }

  const graph = new Map();
  const nodeInfo = new Map(); // node id -> { path, key, line }
  for (const pf of files) {
    for (const f of pf.fns) {
      const id = pf.node(f.key);
      nodeInfo.set(id, { path: pf.path, key: f.key, line: f.line });
      const { resolved, unresolved } = calleesOfDetailed(pf.masked, f, pf.index);
      const edges = new Set();
      for (const k of resolved) {
        const target = pf.localNode.get(k);
        if (target && target !== id) edges.add(target);
      }
      for (const k of unresolved) {
        const os = owners.get(k);
        if (os && os.length === 1 && os[0] !== id) edges.add(os[0]);
      }
      graph.set(id, edges);
    }
  }

  // The same iterative white/grey/black DFS as `scanMasked`, now over the workspace nodes.
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map([...graph.keys()].map((k) => [k, WHITE]));
  const cycles = new Map();
  for (const start of graph.keys()) {
    if (colour.get(start) !== WHITE) continue;
    const path = [start];
    const stack = [[start, 0]];
    colour.set(start, GREY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const [key, index] = frame;
      const callees = [...(graph.get(key) ?? [])];
      if (index >= callees.length) {
        colour.set(key, BLACK);
        stack.pop();
        path.pop();
        continue;
      }
      frame[1] = index + 1;
      const next = callees[index];
      if (colour.get(next) === GREY) {
        const members = path.slice(path.indexOf(next)).sort();
        const label = members.join("+");
        if (!cycles.has(label)) cycles.set(label, { members });
      } else if (colour.get(next) === WHITE) {
        colour.set(next, GREY);
        path.push(next);
        stack.push([next, 0]);
      }
    }
  }

  // Report only the cycles the per-file pass cannot produce: `members` are rendered as
  // `path::key` so a baseline key is unique without a second field.
  const out = [];
  for (const c of cycles.values()) {
    const infos = c.members.map((m) => nodeInfo.get(m));
    const paths = [...new Set(infos.map((i) => i.path))];
    if (paths.length < 2) continue;
    out.push({
      entry: infos[0],
      files: paths,
      members: infos.map((i) => `${i.path}::${i.key}`),
    });
  }
  return out;
}

// --- selftest ---------------------------------------------------------------
/**
 * Pin the extractor on synthetic sources. Every case here is a shape the real workspace
 * contains (or a false positive it must not report) — a scanner whose parser is not pinned
 * is a scanner that silently stops working after the next refactor.
 */
function runSelftest() {
  const cases = [
    {
      name: "direct recursion",
      src: `fn walk(node: &Node) -> usize {
        let mut n = 1;
        for child in &node.children { n += walk(child); }
        n
    }`,
      expect: ["walk"],
    },
    {
      name: "async/generic/where recursion",
      src: `pub async fn drain<T: Send>(queue: &Q) where T: Clone {
        if let Some(next) = queue.pop() { drain::<T>(queue).await; }
    }`,
      expect: ["drain"],
    },
    {
      name: "method call on self is not recursion",
      src: `impl S {
        fn parse(&self) -> u8 { 1 }
        fn outer(&self) -> u8 { self.parse() + parse_helper(self) }
    }`,
      expect: [],
    },
    {
      name: "path call to a same-named fn elsewhere is not recursion",
      src: `fn value() -> u8 { 1 }
    fn caller() -> u8 { other::value() }`,
      expect: [],
    },
    {
      // REQ-A387: the C-ABI mirror in `crates/amos-link-cc/src/lib.rs` delegates to the
      // **upstream** type's method of the same name. Resolving by the last two path
      // segments made every one of those bridges look self-recursive (4 false positives:
      // Qos::for_channel, Qos::validate, Timestamp::now, Timestamp::new).
      name: "a qualified path to another crate's same-named method is not recursion",
      src: `impl Timestamp {
        pub fn now() -> Self {
            let inner = amos_link::codec::Timestamp::now();
            Self { secs: inner.secs, nanos: inner.nanos }
        }
        pub fn new(secs: u64) -> Self {
            amos_link::codec::Timestamp::new(secs, 0).unwrap();
            Self { secs, nanos: 0 }
        }
    }`,
      expect: [],
    },
    {
      // …while the same type reached through `crate::` **is** this file's type.
      name: "crate::Type::method is still the local type",
      src: `impl Counter {
        fn count(&self, n: u32) -> u32 {
            if n == 0 { 0 } else { crate::Counter::count(self, n - 1) }
        }
    }`,
      expect: ["Counter::count"],
    },
    {
      name: "mentions inside strings and comments are not calls",
      src: `fn scan(x: &str) -> bool {
        // scan(x) in a comment
        let doc = "scan(x) in a string";
        doc.len() > 0 && x.is_empty()
    }`,
      expect: [],
    },
    {
      name: "a nested definition of the same name is not a call",
      src: `fn build() -> u8 {
        fn build() -> u8 { 0 }
        1
    }`,
      expect: [],
    },
    {
      name: "recursion behind a block-comment brace cannot desynchronise the body",
      src: `fn tally(v: &[u8]) -> u8 {
        /* } not a real brace { */
        if v.is_empty() { 0 } else { tally(&v[1..]) }
    }`,
      expect: ["tally"],
    },
    {
      name: "trait declarations have no body and are not findings",
      src: `trait T { fn f(&self) -> u8; }`,
      expect: [],
    },
    {
      name: "an inherent method calling a free fn of the same name is not recursion",
      src: `fn open(card: u32, rate: u32) -> u8 { card as u8 + rate as u8 }
    impl Capture {
        pub fn open(rate: u32) -> u8 { open(0, rate) }
    }`,
      expect: [],
    },
    {
      name: "a method recursing on itself is a finding",
      src: `impl Counter {
        fn count(&self, n: u32) -> u32 {
            if n == 0 { 0 } else { self.count(n - 1) }
        }
        fn build() -> u32 { Self::build() }
    }`,
      expect: ["Counter::count", "Counter::build"],
    },
    {
      name: "mutual recursion between two free fns is a finding",
      src: `fn even(n: u32) -> bool { if n == 0 { true } else { odd(n - 1) } }
    fn odd(n: u32) -> bool { if n == 0 { false } else { even(n - 1) } }`,
      expect: ["even+odd"],
    },
    {
      name: "a longer cycle is one finding naming every member",
      src: `fn a() -> u8 { b() }
    fn b() -> u8 { c() }
    fn c() -> u8 { a() }
    fn leaf() -> u8 { 0 }`,
      expect: ["a+b+c"],
    },
    {
      name: "mutual recursion through methods of one type is a finding",
      src: `impl Parser {
        fn expr(&self) -> u8 { self.term() }
        fn term(&self) -> u8 { self.expr() }
    }`,
      expect: ["Parser::expr+Parser::term"],
    },
    {
      name: "same-named methods on two types are two nodes, not a cycle",
      src: `impl A { fn run(&self) { self.help() } fn help(&self) {} }
    impl B { fn help(&self) { self.run() } fn run(&self) {} }`,
      expect: [],
    },
    {
      name: "a method call on another value is unresolvable and contributes no edge",
      src: `impl A { fn run(&self) { other.run() } }
    impl B { fn run(&self) { other2.run() } }`,
      expect: [],
    },
  ];
  let failures = 0;
  for (const c of cases) {
    const got = scanMasked(maskNonCode(c.src)).map((f) => f.members.join("+"));
    const ok = got.length === c.expect.length && got.every((n, i) => n === c.expect[i]);
    if (!ok) {
      failures++;
      console.error(
        `[recursion-scan:selftest] FAIL ${c.name}: expected [${c.expect}], got [${got}]`,
      );
    }
  }
  // --- the workspace pass (REQ-A443): the shapes it must catch and must not invent -----------
  const crossCases = [
    {
      name: "a cycle spanning two files is a finding (the per-file pass cannot see it)",
      files: [
        { path: "crates/a/src/x.rs", src: "fn a() -> u8 { b() }\n" },
        { path: "crates/b/src/y.rs", src: "fn b() -> u8 { a() }\n" },
      ],
      expect: 1,
    },
    {
      name: "a cycle inside one file is left to the per-file pass (no double report)",
      files: [{ path: "crates/a/src/x.rs", src: "fn a() -> u8 { b() }\nfn b() -> u8 { a() }\n" }],
      expect: 0,
    },
    {
      // The REQ-A387 lesson one level up: `helper` is defined in two files, so the target is
      // ambiguous — an implementation that "picks one" would report a cycle here. Not guessing is
      // the whole contract, so the expected count is zero.
      name: "an ambiguous key contributes no edge",
      files: [
        { path: "crates/a/src/x.rs", src: "fn a() -> u8 { helper() }\n" },
        { path: "crates/b/src/y.rs", src: "fn helper() -> u8 { a() }\n" },
        { path: "crates/c/src/z.rs", src: "fn helper() -> u8 { 0 }\n" },
      ],
      expect: 0,
    },
    {
      name: "a cycle of methods split across two files is a finding",
      files: [
        { path: "crates/a/src/x.rs", src: "impl A { fn x(&self) -> u8 { self.y() } }\n" },
        { path: "crates/b/src/y.rs", src: "impl A { fn y(&self) -> u8 { self.x() } }\n" },
      ],
      expect: 1,
    },
    {
      name: "a same-named method on two types contributes no edge",
      files: [
        {
          path: "crates/a/src/x.rs",
          src: "impl A { fn run(&self) -> u8 { self.help() } fn help(&self) -> u8 { 0 } }\n",
        },
        {
          path: "crates/b/src/y.rs",
          src: "impl B { fn help(&self) -> u8 { self.run() } fn run(&self) -> u8 { 0 } }\n",
        },
      ],
      expect: 0,
    },
  ];
  for (const c of crossCases) {
    const got = scanWorkspace(
      c.files.map((f) => ({ path: f.path, masked: maskNonCode(f.src) })),
    ).length;
    if (got !== c.expect) {
      failures++;
      console.error(
        `[recursion-scan:selftest] FAIL ${c.name}: expected ${c.expect} finding(s), got ${got}`,
      );
    }
  }
  // The test-module stripper is part of the contract too.
  const withTest = `fn helper() -> u8 { 0 }
#[cfg(test)]
mod tests { fn helper() -> u8 { helper() } }`;
  const stripped = scanMasked(maskNonCode(stripTestModules(withTest)));
  if (stripped.length !== 0) {
    failures++;
    console.error(
      `[recursion-scan:selftest] FAIL test module not stripped: got [${stripped.map(
        (f) => f.members.join("+"),
      )}]`,
    );
  }
  if (failures > 0) {
    console.error(`[recursion-scan:selftest] ${failures} case(s) failed`);
    process.exit(1);
  }
  console.log(
    `[recursion-scan:selftest] OK — ${cases.length + crossCases.length + 1} pinned case(s)`,
  );
}
if (process.argv.includes("--selftest")) {
  runSelftest();
  process.exit(0);
}

// --- scan -------------------------------------------------------------------
const rel = (f) => relative(repoRoot, f);
const files = rustFiles.map((f) => [f, readFileSync(f, "utf8")]);

const findings = [];
const parsed = files.map(([file, src]) => ({
  path: rel(file),
  masked: maskNonCode(stripTestModules(src)),
}));
for (const { path, masked } of parsed) {
  for (const hit of scanMasked(masked)) {
    findings.push({ path, members: hit.members, line: hit.line });
  }
}
// The workspace pass (REQ-A443): only the cycles the per-file pass above cannot see — ones whose
// members live in **two or more** files. Its member names are already `path::key`, so the baseline
// key (`path::members`) stays unique without a second field.
for (const hit of scanWorkspace(parsed)) {
  findings.push({
    path: hit.entry.path,
    members: hit.members,
    line: hit.entry.line,
    crossFile: true,
    files: hit.files,
  });
}
findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
/** `path::a+b` — a cycle has one stable name, whether it has one member or three. */
const keyOf = (f) => `${f.path}::${f.members.join("+")}`;
const describe = (f) =>
  f.crossFile
    ? `cross-file cycle ${f.members.join(" → ")} → ${f.members[0]}`
    : f.members.length === 1
      ? `fn ${f.members[0]}`
      : `cycle ${f.members.join(" → ")} → ${f.members[0]}`;

// --- baseline (ratchet) -----------------------------------------------------
function loadBaseline() {
  if (!existsSync(baselinePath)) return { policy: "", captured: "", entries: [] };
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  // Tolerate the pre-cycle entry shape (`{ path, name }`), so an older baseline still
  // ratchets instead of crashing the gate it exists to enforce.
  const entries = (parsed.entries ?? []).map((e) =>
    e.members ? e : { ...e, members: [e.name] },
  );
  return { ...parsed, entries };
}

function writeBaseline(current) {
  const baseline = {
    policy:
      "Known production recursion (NASA Power of 10 rule 1), frozen per `path::fn` with a reason. " +
      "A **new** recursive function fails `make lint` until it is either rewritten or acknowledged here; " +
      "an entry that no longer matches **fails the scan** (REQ-A447), so this ratchet must shrink rather than rot. " +
      "The intended steady state for a safety-critical crate is **zero** entries: prefer the iterative " +
      "form (a bounded loop or a dynamic program) over a recursive one, and if recursion is genuinely " +
      "unavoidable, write down why its depth is bounded.",
    captured: new Date().toISOString().slice(0, 10),
    entries: current.map(({ path, members }) => ({
      path,
      members,
      reason: "<why the depth is bounded>",
    })),
  };
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  console.log(
    `[recursion-scan] wrote ${rel(baselinePath)} — ${baseline.entries.length} entry/entries ` +
      "(fill in every reason before committing)",
  );
}

if (process.argv.includes("--update-baseline")) {
  writeBaseline(findings);
  process.exit(0);
}

const baseline = loadBaseline();
const known = new Map(baseline.entries.map((e) => [`${e.path}::${e.members.join("+")}`, e]));
const fresh = findings.filter((f) => !known.has(keyOf(f)));
const stale = [...known.keys()].filter((k) => !findings.some((f) => keyOf(f) === k));

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      { scanned: files.length, findings, fresh, stale, baseline: baseline.entries.length },
      null,
      2,
    ),
  );
  process.exit(fresh.length > 0 || stale.length > 0 ? 1 : 0);
}

console.log(
  `[recursion-scan] ${files.length} production .rs file(s) scanned; ${findings.length} recursive ` +
    `function(s)/cycle(s) (${fresh.length} new, baseline ${baseline.entries.length}).`,
);
for (const f of findings) {
  const entry = known.get(keyOf(f));
  console.log(
    `[recursion-scan]   ${entry ? "baselined" : "NEW      "} ${f.path}:${f.line} ${describe(f)}` +
      (entry ? ` — ${entry.reason}` : ""),
  );
}
for (const k of stale) {
  console.log(`[recursion-scan]   [stale] ${k} — no longer recursive, remove it from the baseline`);
}
if (fresh.length > 0) {
  console.error(
    `[recursion-scan] FAIL — ${fresh.length} new recursion finding(s). NASA Power of 10 rule 1 ` +
      "forbids recursion, direct or mutual: rewrite it as a bounded loop, a dynamic program " +
      "or work list (see `crates/amos-link/src/keyexpr.rs::match_segments` and " +
      "`crates/amos-web3/src/eip712.rs::collect_deps` for the two patterns in this workspace), " +
      "or — if the depth is genuinely bounded and recursion is the clearer form — run " +
      "`node scripts/rust-recursion-scan.mjs --update-baseline` and write a real reason.",
  );
  process.exit(1);
}
if (stale.length > 0) {
  // A note was not enough (REQ-A447): the ratchet must **shrink**. A baseline entry that no longer
  // matches any finding is a claim about code that has changed — it fails until it is removed.
  console.error(
    `[recursion-scan] FAIL — ${stale.length} stale baseline entr(ies); remove them (the ratchet must shrink, not rot).`,
  );
  process.exit(1);
}
console.log("[recursion-scan] OK — no new recursion, no stale baseline entries.");
