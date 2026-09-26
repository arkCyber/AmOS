#!/usr/bin/env node
/**
 * py-stub-scan.mjs — "a checked-in `.pyi` that describes an API the module does not have".
 *
 * Why (REQ-A719): `crates/amos-link-py` is a *declared mirror* of the pyo3 module in
 * `src/lib.rs` — a hand-written type stub whose whole purpose is to tell a Python
 * editor/mypy what `amos_link._native` exposes. Nothing read it, and it had drifted:
 * it declared a `History` class and a `QoS(reliability, history)` constructor that do
 * not exist (the real ones are `DropPolicy` and `QoS(reliability, depth, drop_policy)`),
 * listed `NodeKind.GATEWAY` while the module has `BRAIN`/`ACTUATOR`/`TOOL`, and named
 * `ReceivedMessage`'s fields `peer_id`/`timestamp` where the module exposes
 * `publisher`/`stamp`. On top of the wrong content, the file was named
 * `amos_link_py.pyi` — which resolves to nothing (PEP 561 wants `_native.pyi` for the
 * compiled submodule `amos_link._native`), and the package carried no `py.typed`, so no
 * tool ever read the stub at all.
 *
 * This crate is **not a Cargo workspace member** (it is a maturin package), so the
 * per-crate Rust binding tests cannot host this check — hence a repository-level gate,
 * in the same family as `tauri-event-scan.mjs` / `uniffi`-style stubs.
 *
 * What it checks, all three by reading text (no interpreter, no build):
 *   R1 **surface**   — the class set and, per class, the member set are equal between
 *                      the stub and the pyo3 surface (with total-member floors so a
 *                      rewrite that empties one side cannot pass vacuously). Rust
 *                      `#[classattr] const` → a stub attribute; `#[getter]`/plain `fn`
 *                      → a method/property of that name; `#[staticmethod]` → a static
 *                      method; `#[new] fn` → `__init__`; `#[pyo3(get)] field` → a stub
 *                      attribute.
 *   R2 **resolvable** — the stub is named for the module the packaging declares
 *                      (`module-name` in `pyproject.toml`) and `py.typed` sits beside
 *                      `__init__.py`; a rename that orphans the stub fails here.
 *   R3 **exports**   — every name `__init__.py` re-exports exists as a pyo3 class, and
 *                      the `__version__` marker the module adds is declared in the stub.
 *
 * Usage (repo root):
 *   node scripts/py-stub-scan.mjs              # gate
 *   node scripts/py-stub-scan.mjs --json
 *   node scripts/py-stub-scan.mjs --selftest   # pin the parsers
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "crates/amos-link-py");
const LIB_RS = join(PKG, "src/lib.rs");
const PYPROJECT = join(PKG, "pyproject.toml");
const PY_DIR = join(PKG, "python/amos_link");
const INIT_PY = join(PY_DIR, "__init__.py");

/** Total-member floors: a scan that finds nothing on a side must fail, not compare (∅,∅). */
export const FLOORS = { classes: 11, members: 40, ctors: 3 };

/** The body of a balanced `{ … }` starting at the first `{` at/after `from`. */
function bracedBody(src, from) {
  const open = src.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

/** Split a parameter list on top-level commas (parens/brackets/braces only). */
function splitTop(s) {
  const out = [];
  let d = 0;
  let cur = "";
  for (const ch of s) {
    if ("([{".includes(ch)) d++;
    else if (")]}".includes(ch)) d--;
    if (ch === "," && d === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Parameter **names** of the call whose `(` is the first at/after `from` (`self`/`&self` dropped). */
function paramNames(src, from) {
  const open = src.indexOf("(", from);
  if (open < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  return splitTop(src.slice(open + 1, end))
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (/^(?:&\s*(?:mut\s+)?self|self)\b/.test(p)) return null;
      return /^([A-Za-z_][A-Za-z0-9_]*)/.exec(p)?.[1] ?? null;
    })
    .filter(Boolean);
}

/** `#[classattr]`/`#[getter]`/`#[staticmethod]`/`#[new]` → the `fn`/`const` name that follows. */
function tagged(body, attr, kind) {
  const out = new Set();
  const re = new RegExp(
    `#\\[${attr}\\]\\s*(?://[^\\n]*\\n\\s*)*(?:const|fn)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*[(:]`,
    "g",
  );
  for (const m of body.matchAll(re)) out.add(m[1]);
  return out;
}

/**
 * The pyo3 surface of `src/lib.rs`: one entry per `#[pyclass(name = "X")]`, with the
 * member names Python sees. `#[new] fn new` is reported as `new` (the stub's `__init__`).
 */
export function rustClasses(src) {
  const marks = [...src.matchAll(/#\[pyclass\(name = "([A-Za-z0-9_]+)"\)\]/g)];
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const name = marks[i][1];
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    const slice = src.slice(start, end);
    const members = new Set();
    const pm = slice.indexOf("#[pymethods]");
    const decl = pm >= 0 ? slice.slice(0, pm) : slice;
    const body = pm >= 0 ? bracedBody(slice, pm) : "";
    // `#[pyo3(get)] pub field: T` → an instance attribute.
    for (const m of decl.matchAll(/#\[pyo3\(get\)\]\s*(?:pub\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
      members.add(m[1]);
    }
    for (const n of tagged(body, "classattr")) members.add(n);
    for (const n of tagged(body, "getter")) members.add(n);
    for (const n of tagged(body, "staticmethod")) members.add(n);
    for (const n of tagged(body, "new")) members.add(n);
    // Remaining `fn name(` in the pymethods body, minus the tagged ones and dunders.
    const taggedNames = new Set([
      ...tagged(body, "classattr"),
      ...tagged(body, "getter"),
      ...tagged(body, "staticmethod"),
      ...tagged(body, "new"),
    ]);
    for (const m of body.matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g)) {
      const n = m[1];
      if (n.startsWith("__") || taggedNames.has(n)) continue;
      members.add(n);
    }
    out.push({ name, members, ctor: ctorParams(body) });
  }
  return out;
}

/** Parameter names of `#[new] fn new(…)` in a pymethods body, or null. */
function ctorParams(body) {
  const m = /#\[new\][\s\S]*?\bfn\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:<[^>]*>)?\s*\(/.exec(body);
  return m ? paramNames(body, m.index) : null;
}

/** The stub surface: one entry per top-level `class X:`, with `__init__` → `new`. */
export function stubClasses(src) {
  const marks = [...src.matchAll(/^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)];
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const name = marks[i][1];
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    const body = src.slice(start, end);
    const members = new Set();
    let ctor = null;
    for (const m of body.matchAll(/^[ \t]+def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)) {
      members.add(m[1] === "__init__" ? "new" : m[1]);
      if (m[1] === "__init__") ctor = paramNames(body, m.index);
    }
    // Indentation is `[ \t]`, not `\s`: `\s` would let a blank line carry the match
    // across to a module-level `__version__: str` and attribute it to the last class.
    for (const m of body.matchAll(/^[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*:[ \t]*\S/gm)) {
      members.add(m[1]);
    }
    out.push({ name, members, ctor });
  }
  return out;
}

/** Names in `__all__ = [ … ]` of `__init__.py` (plus the `__version__` marker). */
export function initExports(src) {
  const m = /__all__\s*=\s*\[([\s\S]*?)\]/.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** The stub filename PEP 561 resolves for the packaging `module-name`. */
export function expectedStubName(pyprojectSrc) {
  const m = /module-name\s*=\s*"([^"]+)"/.exec(pyprojectSrc);
  if (!m) return null;
  const last = m[1].split(".").pop();
  return last + ".pyi";
}

export function scan({
  read = (p) => readFileSync(p, "utf8"),
  exists = existsSync,
  floors = FLOORS,
} = {}) {
  const findings = [];
  const rust = rustClasses(read(LIB_RS));
  const pyproject = read(PYPROJECT);
  const expected = expectedStubName(pyproject);
  const stubPath = expected ? join(PY_DIR, expected) : null;
  const canReadStub = stubPath && exists(stubPath);

  if (rust.length < floors.classes) {
    findings.push({ rule: "R1", why: `pyo3 surface parsed only ${rust.length} class(es) (< ${floors.classes}) — the scan lost its subject` });
  }

  // R2 — the stub must be where PEP 561 looks for it, and the package marked typed.
  if (!expected) {
    findings.push({ rule: "R2", why: "pyproject.toml has no `[tool.maturin] module-name`" });
  } else if (!canReadStub) {
    findings.push({ rule: "R2", why: `no stub at python/amos_link/${expected} (the module-name the packaging declares)` });
  } else if (!exists(join(PY_DIR, "py.typed"))) {
    findings.push({ rule: "R2", why: "python/amos_link/py.typed is missing — PEP 561 ignores an unmarked package's stub" });
  }

  const init = initExports(read(INIT_PY));
  const rustNames = new Set(rust.map((c) => c.name));

  // R3 — every re-export exists in the module; `__version__` is declared in the stub.
  for (const n of init) {
    if (n !== "__version__" && !rustNames.has(n)) {
      findings.push({ rule: "R3", why: `__init__.py re-exports \`${n}\`, which is not a pyo3 class in src/lib.rs` });
    }
  }
  if (!/m\.add\("__version__"/.test(read(LIB_RS))) {
    findings.push({ rule: "R3", why: 'src/lib.rs no longer `m.add("__version__", …)` — the stub declares it' });
  }

  if (canReadStub) {
    const stub = stubClasses(read(stubPath));
    if (!/^__version__\s*:/m.test(read(stubPath))) {
      findings.push({ rule: "R3", why: `stub does not declare \`__version__\` (src/lib.rs adds it)` });
    }
    const stubNames = new Set(stub.map((c) => c.name));
    const totalRust = rust.reduce((n, c) => n + c.members.size, 0);
    let compared = 0;
    const totalStub = stub.reduce((n, c) => n + c.members.size, 0);
    if (totalRust < floors.members || totalStub < floors.members) {
      findings.push({ rule: "R1", why: `member census too small (rust=${totalRust}, stub=${totalStub}; floor ${floors.members})` });
    }
    for (const name of rustNames) {
      if (!stubNames.has(name)) findings.push({ rule: "R1", why: `class \`${name}\` is in src/lib.rs but not in the stub` });
    }
    for (const name of stubNames) {
      if (!rustNames.has(name)) findings.push({ rule: "R1", why: `class \`${name}\` is in the stub but not in src/lib.rs` });
    }
    const stubByName = new Map(stub.map((c) => [c.name, c]));
    for (const c of rust) {
      const s = stubByName.get(c.name);
      if (!s) continue;
      const sm = s.members;
      for (const n of c.members) {
        if (!sm.has(n)) findings.push({ rule: "R1", why: `${c.name}.${n} is in src/lib.rs but not in the stub` });
      }
      for (const n of sm) {
        if (!c.members.has(n)) findings.push({ rule: "R1", why: `${c.name}.${n} is in the stub but not in src/lib.rs` });
      }
      // R4 — the constructor's **parameter names** (a `History`-for-`depth`/`drop_policy`
      // swap renames no member, so R1 cannot see it).
      if (c.ctor && s.ctor) {
        compared++;
        if (c.ctor.join() !== s.ctor.join()) {
          findings.push({
            rule: "R4",
            why: `${c.name}.__init__ params differ: src/lib.rs(${c.ctor.join(", ")}) vs stub(${s.ctor.join(", ")})`,
          });
        }
      }
    }
    if (compared < floors.ctors) {
      findings.push({ rule: "R4", why: `only ${compared} constructor(s) compared (< ${floors.ctors}) — the arity check lost its subject` });
    }
  }
  return findings;
}

// --- main --------------------------------------------------------------------
const IS_MAIN = (() => {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (IS_MAIN) {
  const args = process.argv.slice(2);

  function runSelfTest() {
    const cases = [];
    const rust = `#[pyclass(name = "QoS")]
pub struct PyQoS(Qos);
#[pymethods]
impl PyQoS {
    #[new]
    fn new(reliability: PyReliability, depth: usize, drop_policy: PyDropPolicy) -> Self { Q }
    #[staticmethod]
    fn default() -> Self { Q }
    fn __repr__(&self) -> String { String::new() }
}
#[pyclass(name = "ReceivedMessage")]
pub struct PyReceivedMessage {
    #[pyo3(get)]
    topic: String,
    payload: Vec<u8>,
}
#[pymethods]
impl PyReceivedMessage {
    fn payload<'py>(&self, py: Python<'py>) -> &'py PyBytes { b }
}
#[pymodule]
fn _native(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}`;
    const cls = rustClasses(rust);
    cases.push(["two pyclasses", cls.length === 2]);
    cases.push(["new → `new`", cls[0].members.has("new")]);
    cases.push(["staticmethod kept", cls[0].members.has("default")]);
    cases.push(["__repr__ dropped", !cls[0].members.has("__repr__")]);
    cases.push(["pyo3(get) field read", cls[1].members.has("topic")]);
    cases.push(["a non-`get` field is not a member", cls[1].members.size === 2]);
    cases.push(["plain method kept", cls[1].members.has("payload")]);

    const stub = `class QoS:
    def __init__(self, reliability: Reliability, depth: int, drop_policy: DropPolicy) -> None: ...
    @staticmethod
    def default() -> QoS: ...

class ReceivedMessage:
    topic: str
    def payload(self) -> bytes: ...`;
    const sc = stubClasses(stub);
    cases.push(["two stub classes", sc.length === 2]);
    cases.push(["__init__ → new", sc[0].members.has("new")]);
    cases.push(["attribute annotation read", sc[1].members.has("topic")]);
    cases.push(["stub method read", sc[1].members.has("payload")]);

    cases.push([
      "module-name basename",
      expectedStubName(`[tool.maturin]\nmodule-name = "amos_link._native"`) === "_native.pyi",
    ]);
    cases.push([
      "__all__ extraction",
      initExports(`__all__ = [\n    "QoS",\n    "__version__",\n]`).join() === "QoS,__version__",
    ]);

    // A stub that is a class-for-class copy passes; one missing a member fails R1.
    const findingsFor = (stubSrc) =>
      scan({
        read: (p) => {
          if (p.endsWith("lib.rs")) return rust;
          if (p.endsWith("pyproject.toml")) return `module-name = "amos_link._native"`;
          if (p.endsWith("__init__.py")) return `__all__ = ["QoS", "ReceivedMessage"]`;
          return stubSrc;
        },
        exists: () => true,
        floors: { classes: 1, members: 1, ctors: 0 },
      });
    const clean = [
      `class QoS:\n    def __init__(self, reliability: Reliability, depth: int, drop_policy: DropPolicy) -> None: ...\n    @staticmethod\n    def default() -> QoS: ...\n`,
      `class ReceivedMessage:\n    topic: str\n    def payload(self) -> bytes: ...\n`,
      `__version__: str\n`,
    ].join("");
    cases.push(["clean pair has no findings", findingsFor(clean).length === 0]);
    const short = clean.replace("    topic: str\n", "");
    cases.push([
      "missing member is R1",
      findingsFor(short).some((f) => f.rule === "R1"),
    ]);
    // R4: a constructor whose parameter *names* differ renames no member — only R4 sees it.
    const swapped = clean.replace("depth: int, drop_policy: DropPolicy", "history: History");
    cases.push([
      "constructor param drift is R4",
      findingsFor(swapped).some((f) => f.rule === "R4"),
    ]);
    cases.push([
      "matching constructor names is not R4",
      !findingsFor(clean).some((f) => f.rule === "R4"),
    ]);

    let failed = 0;
    for (const [name, ok] of cases) {
      if (ok) console.log(`  [ok] ${name}`);
      else {
        failed++;
        console.log(`  [FAIL] ${name}`);
      }
    }
    if (failed > 0) {
      console.log(`[py-stub-scan] selftest FAILED (${failed}/${cases.length}).`);
      process.exit(1);
    }
    console.log(`[py-stub-scan] selftest OK — ${cases.length} parser case(s).`);
  }

  if (args.includes("--selftest")) {
    runSelfTest();
    process.exit(0);
  }

  const findings = scan();
  if (args.includes("--json")) {
    console.log(JSON.stringify(findings, null, 2));
    process.exit(findings.length === 0 ? 0 : 1);
  }
  if (findings.length > 0) {
    console.log(
      `[py-stub-scan] FAIL — ${findings.length} drift(s) between the amos-link Python stub and the pyo3 module:`,
    );
    for (const f of findings) console.log(`  ${f.rule}: ${f.why}`);
    console.log("  Fix: update crates/amos-link-py/python/amos_link/_native.pyi (or src/lib.rs) in the same change.");
    process.exit(1);
  }
  console.log(
    "[py-stub-scan] OK — the `_native.pyi` stub names exactly the classes/members src/lib.rs exposes.",
  );
}
