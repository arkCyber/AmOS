#!/usr/bin/env node
/**
 * jni-contract-scan.mjs — "the two sides of the JNI boundary disagree about a name".
 *
 * Why: a JNI name is a **string on one side and a declaration on the other**, and neither
 * compiler can see across it. A device round paid for that on the alarm path (REQ-A376,
 * F-TAU-014): `alarm_sched.rs` called `AlarmGlue.schedule` through
 * `JNIEnv::call_static_method`, while the Kotlin member was a plain `object` member —
 * **not** a static method. Every registration threw
 * `java.lang.NoSuchMethodError: no static method "…AlarmGlue;.schedule(…)Ljava/lang/String;"`
 * on device, so `dumpsys alarm` stayed empty (the user's alarm could never ring) … while
 * Kotlin compiled, Rust compiled, the class was in the APK and the signature string was
 * right. **No gate could see it.**
 *
 * The reverse direction has the same shape: a Kotlin `external fun y` is answered by a
 * Rust `Java_<pkg>_<Class>_y` export, and a rename on either side is an
 * `UnsatisfiedLinkError` that only a device shows.
 *
 * So this gate checks both directions (three rules), statically:
 *
 *   R1 (Rust → Kotlin, static): every `call_static_method(<glue class>, "<member>", …)`
 *      must name a member that carries `@JvmStatic` (the repo's own convention — 22 glue
 *      members already had it). A Kotlin `object`'s member is an **instance** method on
 *      `INSTANCE` unless annotated, and a top-level `fun` lives on the file class
 *      (`<File>Kt`), so either one called statically is a `NoSuchMethodError` at runtime.
 *   R2 (Kotlin → Rust): every `external fun` in a tracked `android-glue/` Kotlin file must
 *      have a matching `Java_…` export in the Rust tree, and every Rust glue export must
 *      still have its Kotlin declaration (`UnsatisfiedLinkError` both ways).
 *   R3 (Rust → Kotlin, instance): every `call_method(<glue handle>, "<member>", <sig>, …)`
 *      must name a `fun` the tracked Kotlin tree declares **with that signature** — arity
 *      *and* types. The JVM resolves an instance call by name *and* signature, so a Kotlin
 *      rename, a parameter change or a type drift is a `NoSuchMethodError` at the first call
 *      — the same invisible contract as R1, one dispatch kind over (F-TAU-016). R1 checks the
 *      descriptor's types too. Handles are recognised narrowly (see `glueHandle`):
 *      `MicPermissionGlue`, `SmsGlue`, `DevCareGlue`, the `ClipboardGlue` bridge,
 *      `MediaStoreGlue` — not `Intent`/`Location`/`Iterator`.
 *
 * Honest scope (each boundary is load-bearing):
 *   * **Our glue classes only** (`com.amos.ai.glue.*`). Platform classes
 *     (`android/net/Uri`, `org.json.JSONObject`, `Location`, …) are Java APIs this repo
 *     does not own; they are counted as skipped, never reported as checked.
 *   * **Class resolution is a name-based analysis of the *Rust* file**, because a call
 *     site holds a `JClass`/`GlobalRef`, not a string: literals first, then `let`
 *     bindings (per function), then file-level consts, then `fn` bodies that hand back
 *     `self.<field>` (the `amos-radio` shape: `let class = self.radio_glue()?` →
 *     `self.radio` → `RADIO_CLASS`). A site the analysis **cannot** resolve is a FAILURE
 *     unless it carries a reason in `scripts/jni-contract-allowlist.json` — a gate that
 *     silently skips what it cannot read is the defect it exists to prevent.
 *   * **R3's member check is name + arity, not class identity** (the tree is searched
 *     tree-wide), and a receiver counts as a glue handle only by the name-based rule in
 *     `glueHandle` — a handle not named `…glue…`/`…bridge…` is invisible. Both boundaries
 *     are why R3 exists *alongside* R1 rather than replacing it.
 *   * **Kotlin reading is text-based, one class per file** (true of every glue file here):
 *     members are looked up by name, `@JvmStatic` is read from the annotation lines
 *     directly above a declaration (KDoc/comments in between are fine). A member inherited
 *     from a superclass, or declared in a generated project, is out of scope — with
 *     `MainActivity` (machine-owned `gen/`) explicitly skipped in R2.
 *
 * Usage (from the repo root):
 *   node scripts/jni-contract-scan.mjs              # gate
 *   node scripts/jni-contract-scan.mjs --json       # machine-readable
 *   node scripts/jni-contract-scan.mjs --selftest   # pin the parsers/resolver (fixtures)
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = join(root, "scripts", "jni-contract-allowlist.json");
/** The package every glue class lives in (dotted and slashed spellings). */
const GLUE_LITERAL = /com[./]amos[./]ai[./]glue[./]([A-Za-z_]\w*)/g;
/** Rust keywords/type names that must never be read as a class-carrying identifier. */
const NOT_IDENTIFIERS = new Set([
  "self", "Self", "fn", "let", "mut", "ref", "as", "in", "if", "else", "match", "return",
  "loop", "while", "for", "impl", "struct", "enum", "trait", "pub", "use", "mod", "crate",
  "super", "true", "false", "None", "Some", "Ok", "Err", "Option", "Result", "str", "bool",
  "i32", "i64", "u32", "u64", "usize", "isize", "f32", "f64", "String", "Vec", "format",
]);

/**
 * The tracked glue class names, filled in by `glueKotlin()`. A Kotlin parameter typed with
 * one of them (`AlarmGlue`, `Context`-like glue types) resolves to `com/amos/ai/glue/<name>`
 * in `kotlinTypeToJni`; a bare name that is neither imported nor a glue class stays
 * "unreadable" rather than being guessed.
 */
let GLUE_CLASS_NAMES = new Set();

/** `argv[1]` names this file (so the module can also be imported by a test). */
export function invokedDirectly(url, argv1) {
  return argv1 !== undefined && url.endsWith(argv1.split("/").pop());
}

/** One-based line number of a byte offset. */
export function lineOf(src, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

/**
 * `src` with `//` and block comments blanked to spaces — offsets and line numbers
 * preserved, string literals respected (a `//` inside a string is not a comment).
 *
 * Same shape as `jni-boolean-scan.mjs`'s blanker, which exists because its first version
 * split statements on the nearest `;` and therefore **missed the defect it was written
 * for** (a `;` inside a comment). Here it matters twice more: the KOTLIN → RUST CONTRACT
 * block comment and the prose in doc comments must not be read as code, while the string
 * arguments (the class name, the member name, the signature) must stay readable.
 */
export function stripComments(src) {
  const out = [...src];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      i += 1;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i += 1;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
    } else if (c === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i += 1;
      }
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

/**
 * `src` with comments blanked **and string contents blanked**, offsets preserved byte for
 * byte. Used where a mention must not count as evidence (deciding whether an expression
 * *is* a glue/bridge handle) — `stripComments` keeps strings, which is what reading a
 * member name needs.
 */
export function blankCode(src) {
  const out = [...src];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      i += 1;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          out[i] = " ";
          if (i + 1 < src.length) out[i + 1] = " ";
          i += 2;
          continue;
        }
        out[i] = " ";
        i += 1;
      }
      i += 1;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
    } else if (c === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i += 1;
      }
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

/** Index of the delimiter closing the one opened at `open`; -1 when unterminated. */
export function matchDelim(src, open, opener, closer) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      i += 1;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split an argument list on top-level commas (strings, parens, brackets, braces). */
export function splitTopLevel(text) {
  const out = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail !== "") out.push(tail);
  return out;
}

/** Every glue class named in `text` (dotted or slashed spelling), in order. */
export function glueClassesIn(text) {
  return [...String(text).matchAll(GLUE_LITERAL)].map((m) => m[1]);
}

// --- the Rust side of the boundary (R1) -------------------------------------

/** Every `fn` in a Rust source, with its parameter list and body extent (comments blanked). */
export function rustFunctions(src) {
  const code = stripComments(src);
  const out = [];
  const re = /(?:^|[^\w])fn\s+([A-Za-z_]\w*)\s*(?:<[^>(]{0,120}>)?\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchDelim(code, open, "(", ")");
    if (close < 0) continue;
    const bodyOpen = code.indexOf("{", close);
    if (bodyOpen < 0) continue;
    const bodyClose = matchDelim(code, bodyOpen, "{", "}");
    if (bodyClose < 0) continue;
    out.push({
      name: m[1],
      params: code.slice(open + 1, close),
      body: code.slice(bodyOpen + 1, bodyClose),
      bodyStart: bodyOpen,
      bodyEnd: bodyClose,
    });
  }
  return out;
}

/** Index of the `;` ending the statement whose `=` is at `from` (depth 0), or -1. */
export function statementEnd(body, from) {
  let depth = 0;
  for (let i = from; i < body.length; i++) {
    const c = body[i];
    if (c === '"') {
      i += 1;
      while (i < body.length && body[i] !== '"') i += body[i] === "\\" ? 2 : 1;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) return i;
  }
  return -1;
}

/**
 * `let` bindings of a fn body: the bound name and its initializer expression. `Some(x)` /
 * `Ok(x)` / `Err(x)` patterns are unwrapped (`amos-radio`'s
 * `let Some(class) = self.tethering.as_ref() else { … };`).
 */
export function rustBindings(body) {
  const out = [];
  const re = /\blet\s+(?:mut\s+)?(?:(?:Some|Ok|Err)\s*\(\s*)?([A-Za-z_]\w*)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const eq = body.indexOf("=", m.index + m[0].length);
    if (eq < 0) continue;
    const semi = statementEnd(body, eq);
    if (semi < 0) continue;
    out.push({ name: m[1], expr: body.slice(eq + 1, semi) });
    re.lastIndex = semi;
  }
  return out;
}

/**
 * Which glue class an expression denotes.
 *
 * Order: a glue **literal** (the strongest evidence) → identifiers looked up in the
 * fn-local bindings, the file's consts, then every name known file-wide. Returns
 * `{ cls }`, `{ ambiguous: [...] }` (more than one class is evidence of a resolver gap,
 * not a verdict) or `null`.
 */
export function classFromExpr(expr, ctx) {
  const lits = [...new Set(glueClassesIn(expr))];
  if (lits.length === 1) return { cls: lits[0], how: "literal" };
  if (lits.length > 1) return { ambiguous: lits };
  const found = new Set();
  for (const m of String(expr).matchAll(/(?<![A-Za-z0-9_])([A-Za-z_]\w*)/g)) {
    const token = m[1];
    if (NOT_IDENTIFIERS.has(token)) continue;
    const cls = ctx.locals?.get(token) ?? ctx.consts?.get(token) ?? ctx.names?.get(token);
    if (cls) found.add(cls);
  }
  if (found.size === 1) return { cls: [...found][0], how: "identifier" };
  if (found.size > 1) return { ambiguous: [...found] };
  return null;
}

/** First string literal in an expression (`"x"` → `x`), or null. */
export function firstStringLiteral(expr) {
  const m = /"([^"]*)"/.exec(String(expr));
  return m ? m[1] : null;
}


/**
 * The JNI descriptor a call site passes.
 *
 * Usually a literal. `alarm_sched.rs` builds it in a variable first
 * (`let sig = "(Landroid/content/Context;…)Ljava/lang/String;";` right before the match), so a
 * `let` binding in the same fn is read as well — otherwise the *types* of those two calls
 * would be silently unchecked (which is what the `signature-unreadable` report says).
 */
export function signatureOf(call, code) {
  const literal = firstStringLiteral(call.signature);
  if (literal) return { value: literal, how: "literal" };
  if (!call.fn) return { value: call.signature, how: "unresolved" };
  const ident = call.signature.trim().replace(/^&/, "");
  const binding = rustBindings(call.fn.body).find((b) => b.name === ident);
  const fromBinding = binding ? firstStringLiteral(binding.expr) : null;
  return fromBinding
    ? { value: fromBinding, how: `binding \`${ident}\`` }
    : { value: call.signature, how: "unresolved" };
}

/**
 * The name-based map a Rust file's class expressions are resolved against.
 *
 * Fixed-point (6 passes) because the shapes chain: `class` ← `self.radio_glue()` (a fn) ←
 * `self.radio` (a field named after the local that built it) ← `RADIO_CLASS` (a const).
 * A name bound to two different classes file-wide is **dropped** rather than guessed.
 */
export function analyzeRustFile(src) {
  const code = stripComments(src);
  const fns = rustFunctions(src);
  const consts = new Map();
  for (const m of code.matchAll(
    /\b(?:const|static)\s+([A-Za-z_]\w*)\s*:\s*&(?:'static\s+)?str\s*=\s*"([^"]*)"/g,
  )) {
    const cls = glueClassesIn(m[2]);
    if (cls.length === 1) consts.set(m[1], cls[0]);
  }
  const locals = new Map(fns.map((f) => [f.name, new Map()]));
  const fnClasses = new Map();
  const unionNames = () => {
    const seen = new Map();
    const put = (k, v) => {
      if (seen.has(k) && seen.get(k) !== v) seen.delete(k);
      else if (!seen.has(k)) seen.set(k, v);
    };
    for (const [k, v] of consts) put(k, v);
    for (const [, lm] of locals) for (const [k, v] of lm) put(k, v);
    for (const [k, v] of fnClasses) put(k, v);
    return seen;
  };
  for (let pass = 0; pass < 6; pass++) {
    const names = unionNames();
    for (const f of fns) {
      const lm = locals.get(f.name);
      for (const b of rustBindings(f.body)) {
        if (lm.has(b.name)) continue;
        const r = classFromExpr(b.expr, { locals: lm, consts, names });
        if (r?.cls) lm.set(b.name, r.cls);
      }
    }
    for (const f of fns) {
      if (fnClasses.has(f.name)) continue;
      const r = classFromExpr(f.body, { locals: locals.get(f.name), consts, names });
      if (r?.cls) fnClasses.set(f.name, r.cls);
    }
  }
  return { consts, locals, fnClasses, names: unionNames() };
}

/**
 * Every `<callee>(<receiver/class>, <member>, <signature>, …)` site in a Rust source — the
 * two shapes the JVM dispatches **by name**: `call_static_method` (R1) and `call_method`
 * (R3, instance dispatch on a handle Kotlin handed up).
 */
export function rustCalls(src, callee) {
  const code = stripComments(src);
  const fns = rustFunctions(src);
  const out = [];
  const re = new RegExp(`(?<![_\\w])${callee}\\s*\\(`, "g");
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchDelim(code, open, "(", ")");
    if (close < 0) continue;
    const args = splitTopLevel(code.slice(open + 1, close));
    const fn =
      fns
        .filter((f) => f.bodyStart < m.index && m.index < f.bodyEnd)
        .sort((a, b) => a.bodyEnd - a.bodyStart - (b.bodyEnd - b.bodyStart))[0] ?? null;
    out.push({
      line: lineOf(code, m.index),
      index: m.index,
      classArg: args[0] ?? "",
      methodArg: args[1] ?? "",
      signature: args[2] ?? "",
      fn,
    });
    re.lastIndex = close;
  }
  return out;
}

/** `call_static_method` sites — the Rust → Kotlin static contract (R1). */
export function rustStaticCalls(src) {
  return rustCalls(src, "call_static_method");
}

/** `call_method` sites — instance dispatch on a handle Kotlin handed up (R3). */
export function rustInstanceCalls(src) {
  return rustCalls(src, "call_method");
}

/**
 * How many arguments a JNI descriptor takes (`(Landroid/content/Context;Z)Z` → 2). `null`
 * when the descriptor cannot be read — "cannot tell" is a finding, never a pass.
 */
export function jniArity(signature) {
  const types = jniTypes(signature);
  return types ? types.args.length : null;
}

/**
 * A JNI descriptor split into its argument and return types
 * (`([BLjava/lang/String;)Ljava/lang/String;` → `{ args: ["[B", "Ljava/lang/String;"],
 * ret: "Ljava/lang/String;" }`), or `null` when it cannot be read.
 */
export function jniTypes(signature) {
  // Call sites pass the argument **as written** (`"()Z"`), quotes included.
  const normalized = String(signature).trim().replace(/^"(.*)"$/s, "$1");
  const m = /\(([^)]*)\)(.*)$/.exec(normalized);
  if (!m) return null;
  const parse = (text) => {
    const out = [];
    let i = 0;
    while (i < text.length) {
      let array = "";
      while (text[i] === "[") {
        array += "[";
        i += 1;
      }
      if (text[i] === "L") {
        const semi = text.indexOf(";", i);
        if (semi < 0) return null;
        out.push(array + text.slice(i, semi + 1));
        i = semi + 1;
      } else {
        out.push(array + text[i]);
        i += 1;
      }
    }
    return out;
  };
  const args = parse(m[1].trim());
  const ret = m[2].trim();
  if (!args || ret === "") return null;
  return { args, ret };
}

/** Kotlin primitives, and the boxed descriptor a **nullable** primitive compiles to. */
const KOTLIN_PRIMITIVES = {
  Int: "I",
  Long: "J",
  Boolean: "Z",
  Float: "F",
  Double: "D",
  Short: "S",
  Byte: "B",
  Char: "C",
  Unit: "V",
};
const KOTLIN_BOXED = {
  Int: "java/lang/Integer",
  Long: "java/lang/Long",
  Boolean: "java/lang/Boolean",
  Float: "java/lang/Float",
  Double: "java/lang/Double",
  Short: "java/lang/Short",
  Byte: "java/lang/Byte",
  Char: "java/lang/Character",
};
const KOTLIN_WELL_KNOWN = {
  String: "Ljava/lang/String;",
  Any: "Ljava/lang/Object;",
  CharSequence: "Ljava/lang/CharSequence;",
  Array: "Ljava/lang/Object;",
  ByteArray: "[B",
  IntArray: "[I",
  LongArray: "[J",
  FloatArray: "[F",
  DoubleArray: "[D",
  BooleanArray: "[Z",
  CharArray: "[C",
};

/**
 * The collections whose JVM erasure is the Java interface (Kotlin's *default imports*, so
 * these need no `import` line and the mapping is the compiler's, not a guess).
 */
const KOTLIN_COLLECTIONS = {
  List: "Ljava/util/List;",
  MutableList: "Ljava/util/List;",
  ArrayList: "Ljava/util/ArrayList;",
  Set: "Ljava/util/Set;",
  MutableSet: "Ljava/util/Set;",
  HashSet: "Ljava/util/HashSet;",
  Map: "Ljava/util/Map;",
  MutableMap: "Ljava/util/Map;",
  HashMap: "Ljava/util/HashMap;",
  Collection: "Ljava/util/Collection;",
  MutableCollection: "Ljava/util/Collection;",
  Iterator: "Ljava/util/Iterator;",
  MutableIterator: "Ljava/util/Iterator;",
  Iterable: "Ljava/lang/Iterable;",
  MutableIterable: "Ljava/lang/Iterable;",
  Sequence: "Lkotlin/sequences/Sequence;",
};

/**
 * A Kotlin type as written → its JNI descriptor, or `null` when this gate cannot tell.
 *
 * The mapping is the **erasure** the JVM sees: generics lose their arguments
 * (`List<String>` → `Ljava/util/List;`), a **nullable primitive** is boxed
 * (`Long?` → `Ljava/lang/Long;`), and an array type is its descriptor. Simple class names
 * are resolved through the Kotlin file's own `import` lines (the repo's glue imports
 * `android.content.Context` etc.), which is what makes `Context` → `Landroid/content/Context;`
 * a **recorded** mapping rather than a guess; a bare name with no import, a lambda type or a
 * type parameter returns `null` (reported, never silently judged).
 */
export function kotlinTypeToJni(asWritten, imports = new Map(), glueClasses = GLUE_CLASS_NAMES) {
  let type = String(asWritten ?? "")
    .trim()
    .replace(/\s*=\s*[^,]*$/, ""); // a default value is not part of the type
  if (type === "" || type.includes("->")) return null;
  const nullable = type.endsWith("?");
  if (nullable) type = type.slice(0, -1).trim();
  if (nullable && KOTLIN_BOXED[type]) return `L${KOTLIN_BOXED[type]};`;
  if (KOTLIN_PRIMITIVES[type]) return KOTLIN_PRIMITIVES[type];
  if (KOTLIN_WELL_KNOWN[type]) return KOTLIN_WELL_KNOWN[type];
  const generic = /^([A-Za-z_][\w.]*)\s*</.exec(type);
  if (generic) type = generic[1];
  if (KOTLIN_COLLECTIONS[type]) return KOTLIN_COLLECTIONS[type];
  if (!/^[A-Z][\w.]*$/.test(type)) return null;
  const parts = type.split(".");
  const imported = imports.get(parts[0]);
  if (imported) {
    const nested = `${imported.replace(/\./g, "/")}${parts.length > 1 ? "$" + parts.slice(1).join("$") : ""}`;
    return `L${nested};`;
  }
  if (parts.length === 1 && glueClasses.has(parts[0])) return `Lcom/amos/ai/glue/${parts[0]};`;
  if (parts.length === 1) return null; // a bare name with no import: cannot tell
  return `L${parts.join("/")};`;
}

/**
 * Compare a JNI descriptor against a Kotlin declaration's parameter/return types.
 *
 * Returns `{ ok: true }`, `{ ok: false, reason }` (a real mismatch: the JVM resolves an
 * instance/static call by name **and signature**, so this is the `NoSuchMethodError` case)
 * or `{ unknown: true, reason }` — a type this gate cannot map. "Unknown" is reported and
 * counted, never silently treated as agreement.
 */
export function signatureVerdict(decl, signature) {
  const jni = jniTypes(signature);
  if (!jni) return { unknown: true, reason: "the JNI descriptor could not be read" };
  if (!Array.isArray(decl?.params)) {
    return { unknown: true, reason: "the Kotlin declaration's parameters could not be read" };
  }
  if (decl.params.length !== jni.args.length) {
    return {
      ok: false,
      reason: `the declaration takes ${decl.params.length} parameter(s), the signature passes ${jni.args.length}`,
    };
  }
  const expected = decl.params.map((p) => kotlinTypeToJni(p, decl.imports));
  const unreadable = [];
  expected.forEach((e, i) => {
    if (e === null) unreadable.push(decl.params[i]);
  });
  const expectedReturn = kotlinTypeToJni(decl.returns ?? "Unit", decl.imports);
  if (expectedReturn === null) unreadable.push(decl.returns ?? "Unit");
  if (unreadable.length > 0) {
    return { unknown: true, reason: `the Kotlin type(s) ${unreadable.join(", ")} cannot be mapped by this gate` };
  }
  const wrong = [];
  expected.forEach((e, i) => {
    if (e !== jni.args[i]) wrong.push(`#${i + 1}: Kotlin ${decl.params[i]} (${e}) vs JNI ${jni.args[i]}`);
  });
  if (expectedReturn !== jni.ret) {
    wrong.push(`return: Kotlin ${decl.returns ?? "Unit"} (${expectedReturn}) vs JNI ${jni.ret}`);
  }
  if (wrong.length === 0) return { ok: true };
  return { ok: false, reason: wrong.join("; ") };
}

/**
 * The member name(s) a call site asks for.
 *
 * A literal is direct. A **parameter** of the enclosing fn means the site is a wrapper
 * (`incall.rs`/`blocklist.rs`'s `call_static_bool(method: &str)`), so the literals its
 * callers pass are the real answers — resolved through the file, which is exactly the
 * shape a literal-only gate would silently miss.
 */
export function methodsFor(call, code) {
  const lit = firstStringLiteral(call.methodArg);
  if (lit) return { names: [lit], how: "literal" };
  const arg = call.methodArg.trim().replace(/^&/, "");
  if (!call.fn) return { names: [], how: "unresolved" };
  const params = call.fn.params.split(",").map((p) => p.trim().split(":")[0].trim());
  if (!params.includes(arg)) return { names: [], how: "unresolved" };
  const names = new Set();
  const re = new RegExp(`\\b${call.fn.name}\\s*\\(\\s*"([^"]+)"`, "g");
  for (const m of code.matchAll(re)) names.add(m[1]);
  return names.size > 0
    ? { names: [...names], how: `wrapper ${call.fn.name}` }
    : { names: [], how: "unresolved" };
}



// --- the Kotlin side of the boundary (R1 + R2) ------------------------------

/**
 * The `fun` declarations of a Kotlin source, with whether `@JvmStatic` sits directly above
 * (annotations and blank lines in between are fine) and whether the declaration is **top
 * level**.
 *
 * `topLevel` matters for R1: a top-level `fun` compiles onto the file class (`<File>Kt`),
 * so `call_static_method("com/amos/ai/glue/AlarmGlue", …)` cannot reach it however it is
 * annotated. One class per glue file is assumed (true of every file here), which is why
 * indentation is enough to tell the two apart.
 */
export function kotlinMembers(src) {
  const lines = src.split("\n");
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  // Simple name -> fully-qualified name, from the file's own imports: this is what makes
  // `Context` → `Landroid/content/Context;` a recorded mapping instead of a guess (REQ-A378).
  const imports = new Map();
  for (const m of src.matchAll(/^\s*import\s+([\w.]+)/gm)) {
    imports.set(m[1].split(".").pop(), m[1]);
  }
  const out = [];
  lines.forEach((line, i) => {
    const m =
      /^([ \t]*)(?:(?:public|internal|private|protected|external|override|final|open|suspend|inline|operator|infix|tailrec|abstract|actual|expect)\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)\s*\(/.exec(
        line,
      );
    if (!m) return;
    let jvmStatic = false;
    for (let j = i - 1; j >= 0; j--) {
      const t = lines[j].trim();
      if (t === "") continue;
      if (t.startsWith("@")) {
        if (/@JvmStatic\b/.test(t)) jvmStatic = true;
        continue;
      }
      break;
    }
    // The parameter list may span lines; the arity is what JNI matches for an instance
    // call (R3), so it is read from the source, not from the line.
    const open = starts[i] + m[0].length - 1;
    const close = matchDelim(src, open, "(", ")");
    const params = close < 0 ? null : splitTopLevel(src.slice(open + 1, close));
    const returns = close < 0 ? null : (/^\s*:\s*([^={\n]+)/.exec(src.slice(close + 1, close + 300))?.[1] ?? null);
    out.push({
      name: m[2],
      line: i + 1,
      jvmStatic,
      topLevel: m[1] === "",
      arity: params === null ? null : params.length,
      // Only the *type* part of each parameter (`id: String = ""` → `String`).
      params: params ? params.map((p) => p.split(":").slice(1).join(":").trim() || p.trim()) : null,
      returns: returns === null ? null : returns.trim(),
      imports,
    });
  });
  return out;
}

/** Kotlin `external fun` declarations (the Kotlin → Rust half of R2). */
export function kotlinExternalFuns(src) {
  const out = [];
  src.split("\n").forEach((line, i) => {
    const m =
      /^\s*(?:(?:public|internal|private|protected)\s+)?external\s+fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)\s*\(/.exec(
        line,
      );
    if (m) out.push({ name: m[1], line: i + 1 });
  });
  return out;
}

/**
 * Rust `Java_com_amos_ai[_glue]_<Class>_<member>` exports (the Rust half of R2).
 * `mangled` marks an overload name (`…_member__<signature>`), which this gate reports
 * instead of guessing at the overload table.
 */
export function rustExports(src) {
  const code = stripComments(src);
  const out = [];
  const re = /fn\s+Java_(com_amos_ai_[A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    let rest = m[1].split("_").slice(3); // after com/amos/ai
    if (rest[0] === "glue") rest = rest.slice(1);
    out.push({
      className: rest[0],
      member: rest[1],
      mangled: rest.length > 2,
      line: lineOf(code, m.index),
      symbol: m[1],
    });
  }
  return out;
}

/**
 * R1: check every static call in one Rust source against the tracked glue classes.
 *
 * `glue` is a `Map<className, { file, members }>`. Returns
 * `{ findings, checked, skipped, sites }` — `skipped` is the honest count of platform
 * statics this gate does not own, `sites` every `call_static_method` it looked at.
 */
export function checkStaticCalls(src, file, glue) {
  const code = stripComments(src);
  const analysis = analyzeRustFile(src);
  const findings = [];
  const checked = [];
  const reports = [];
  let skipped = 0;
  let sites = 0;

  /**
   * The class a call site names, with one extra step a plain expression walk cannot take:
   * when the argument is a **simple identifier** bound in the enclosing fn, the *binding's*
   * initializer is re-resolved — which is also how an ambiguous binding (two glue classes
   * in one expression) stays visible as ambiguity instead of degrading to "unknown".
   */
  const classForArg = (call) => {
    const locals = call.fn ? analysis.locals.get(call.fn.name) : null;
    const ctx = { locals, consts: analysis.consts, names: analysis.names };
    const direct = classFromExpr(call.classArg, ctx);
    if (direct?.cls || !call.fn) return direct;
    const arg = call.classArg.trim().replace(/^&/, "").replace(/\(\)$/, "");
    const binding = rustBindings(call.fn.body).find((b) => b.name === arg);
    return (binding && classFromExpr(binding.expr, ctx)) || direct;
  };

  for (const call of rustStaticCalls(src)) {
    sites++;
    let res = classForArg(call);

    if (!res?.cls && call.fn) {
      // The class is resolved *inside* the enclosing fn (`find_class` / `resolve_class`):
      // `incall.rs` and `blocklist.rs` do exactly this at the top of `call_static_bool`.
      const lits = [...new Set(glueClassesIn(call.fn.body))];
      if (lits.length === 1) res = { cls: lits[0], how: "enclosing fn literal" };
    }
    const mentionsGlue =
      glueClassesIn(call.classArg).length > 0 ||
      (call.fn ? glueClassesIn(call.fn.body).length > 0 : false);
    if (!res?.cls) {
      if (!mentionsGlue) {
        skipped++; // a platform class (android/net/Uri, org.json.…): not ours to check
        continue;
      }
      findings.push({
        file,
        line: call.line,
        kind: res ? "ambiguous-class" : "unresolved-class",
        site: `call_static_method(${res ? res.ambiguous.join("|") : call.classArg})`,
        detail: res
          ? `the class expression names ${res.ambiguous.length} glue classes (${res.ambiguous.join(", ")}) — the gate cannot tell which one is called`
          : "the class expression could not be resolved to a glue class",
      });
      continue;
    }
    const cls = res.cls;
    const kotlin = glue.get(cls);
    const methods = methodsFor(call, code);
    if (methods.names.length === 0) {
      findings.push({
        file,
        line: call.line,
        kind: "unresolved-member",
        site: `call_static_method(${cls}, ${call.methodArg})`,
        detail: "the member name could not be resolved from the call site",
      });
      continue;
    }
    if (!kotlin) {
      findings.push({
        file,
        line: call.line,
        kind: "unknown-class",
        site: `call_static_method(${cls}, …)`,
        detail: `no tracked Kotlin glue file declares class ${cls}`,
      });
      continue;
    }
    for (const member of methods.names) {
      const decl = kotlin.members.find((x) => x.name === member);
      const site = `call_static_method(${cls}, "${member}", ${call.signature})`;
      if (!decl) {
        findings.push({
          file,
          line: call.line,
          kind: "unknown-member",
          site,
          detail: `${kotlin.file} declares no member named ${member}`,
        });
      } else if (decl.topLevel) {
        findings.push({
          file,
          line: call.line,
          kind: "top-level-member",
          site,
          detail: `${kotlin.file}:${decl.line} declares ${member} at top level — it lives on ${cls}Kt, not on ${cls}`,
        });
      } else if (!decl.jvmStatic) {
        findings.push({
          file,
          line: call.line,
          kind: "missing-jvmstatic",
          site,
          detail: `${kotlin.file}:${decl.line} declares ${member} without @JvmStatic — the JVM raises NoSuchMethodError at the first call (F-TAU-014)`,
        });
      } else {
        // `@JvmStatic` is the *name* half; the descriptor is the other half the JVM matches
        // (REQ-A378 added the type check to R1 and R3 alike).
        const verdict = signatureVerdict(decl, signatureOf(call, code).value);
        if (verdict.ok) {
          checked.push({ file, line: call.line, cls, member });
        } else if (verdict.unknown) {
          reports.push({
            kind: "signature-unreadable",
            site,
            detail: `${verdict.reason} — the types of this call are NOT checked`,
          });
        } else {
          findings.push({
            file,
            line: call.line,
            kind: "signature-mismatch",
            site,
            detail: `${kotlin.file}:${decl.line} declares ${member} with different types: ${verdict.reason}`,
          });
        }
      }
    }
  }
  return { findings, checked, skipped, sites, reports };
}

/**
 * Is this receiver a Kotlin glue/bridge handle? The test is deliberately narrow: the
 * receiver expression names one, or the receiver is a simple identifier the enclosing fn
 * bound from such an expression (`let obj = self.bridge.as_obj();`). A **mention in a
 * string or a comment never counts** — with the looser "the fn mentions glue" test, the
 * Intent methods in `real_dial.rs` were reported as glue calls because a doc string says
 * `call TelephonyGlue.nativeAttach at boot` (measured while adding R3).
 */
export function glueHandle(recv, fnBody) {
  const HANDLE = /\w*(glue|bridge)\w*/i;
  if (HANDLE.test(recv)) return true;
  const ident = (recv.trim().replace(/^&/, "").match(/^([A-Za-z_]\w*)/) ?? [])[1];
  if (!ident || !fnBody) return false;
  const bound = new RegExp(
    `\\blet\\s+(?:mut\\s+)?(?:(?:Some|Ok|Err)\\s*\\(\\s*)?${ident}\\b[^=]*=([^;]*)`,
  ).exec(fnBody);
  return Boolean(bound && HANDLE.test(bound[1]));
}

/**
 * R3: check every **instance** call into the glue (`call_method(<handle>, "<member>", …)`)
 * against the Kotlin tree.
 *
 * Why this rule exists: the static direction (R1) is only half of "Rust calls Kotlin by
 * name". Rust also holds a Kotlin instance — the `object` singleton handed up by
 * `MicPermissionGlue.bind`, the bridge `ClipboardGlue.attach(bridge)` passes, the
 * `SmsGlue`/`DevCareGlue`/`MediaStoreGlue` instance — and calls it with `call_method`,
 * which JNI resolves **by name *and* arity**. A Kotlin rename or a signature change is a
 * `NoSuchMethodError` at the first call, and nothing on either side compiles differently,
 * so it is the same invisible-contract family as F-TAU-014 (here: F-TAU-016).
 *
 * `tree` is `{ byName: Map<name, [{cls, file, line, arity}]> }` over the tracked production
 * glue files. A receiver that is not a glue/bridge handle is skipped (platform objects:
 * `Intent#setData`, `Location#getLatitude`, `Iterator#next`, …) and counted — the rule
 * never guesses.
 */
export function checkInstanceCalls(src, file, tree) {
  const code = stripComments(src);
  const blanked = blankCode(src);
  const owners = new Set(rustExports(src).map((e) => e.className));
  const findings = [];
  const checked = [];
  const reports = [];
  let skipped = 0;
  let sites = 0;
  for (const call of rustInstanceCalls(src)) {
    sites++;
    const fnBody = call.fn ? blanked.slice(call.fn.bodyStart, call.fn.bodyEnd) : "";
    if (!glueHandle(blankCode(call.classArg), fnBody)) {
      skipped++;
      continue;
    }
    const names = methodsFor(call, code).names;
    if (names.length === 0) {
      findings.push({
        file,
        line: call.line,
        kind: "unresolved-member",
        site: `call_method(${call.classArg}, ${call.methodArg})`,
        detail: "the member name could not be resolved from the call site",
      });
      continue;
    }
    const arity = jniArity(signatureOf(call, code).value);
    for (const member of names) {
      const decls = tree.byName.get(member) ?? [];
      const site = `call_method(${call.classArg}, "${member}", ${call.signature})`;
      if (decls.length === 0) {
        findings.push({
          file,
          line: call.line,
          kind: "missing-kotlin-member",
          site,
          detail: `no tracked glue Kotlin file declares a \`fun ${member}\` — a rename or a removal here is a NoSuchMethodError at the first call (and a silently dead feature before that)`,
        });
        continue;
      }
      if (arity === null) {
        findings.push({
          file,
          line: call.line,
          kind: "unreadable-signature",
          site,
          detail: "the JNI descriptor could not be read, so the arity cannot be checked",
        });
        continue;
      }
      const exact = decls.filter((d) => d.arity === arity);
      if (exact.length === 0) {
        findings.push({
          file,
          line: call.line,
          kind: "arity-mismatch",
          site,
          detail:
            `the Kotlin side declares ${member} with ` +
            decls.map((d) => `${d.arity} parameter(s) (${d.cls}.kt:${d.line})`).join(", ") +
            `, but this call passes ${arity}`,
        });
        continue;
      }
      checked.push({ file, line: call.line, member, cls: exact[0].cls, arity });
      const typeVerdict = signatureVerdict(exact[0], signatureOf(call, code).value);
      if (typeVerdict.ok) {
        /* the types agree too */
      } else if (typeVerdict.unknown) {
        reports.push({
          kind: "signature-unreadable",
          site,
          detail: `${typeVerdict.reason} — the types of this call are NOT checked`,
        });
      } else {
        findings.push({
          file,
          line: call.line,
          kind: "signature-mismatch",
          site,
          detail: `${exact[0].cls}.kt:${exact[0].line} declares ${member} with different types: ${typeVerdict.reason}`,
        });
        continue;
      }
      const declaredByOwner = owners.size === 0 || exact.some((d) => owners.has(d.cls));
      if (!declaredByOwner) {
        reports.push({
          kind: "member-declared-elsewhere",
          site,
          detail: `${member} is declared by ${exact.map((d) => d.cls).join(", ")}, not by this file's own glue class(es) (${[...owners].join(", ")}) — correct for a Kotlin bridge object, worth a look otherwise`,
        });
      }
    }
  }
  return { findings, checked, reports, skipped, sites };
}



/**
 * R2: pair the Kotlin `external fun` declarations with the Rust `Java_…` exports.
 *
 * `kotlinByClass` is a `Map<class, {file, externals}>`, `exports` the flat Rust list.
 * Leftover exports are only a finding when their class **is** a tracked glue file: the
 * generated, machine-owned `MainActivity` (and anything else outside `android-glue/`) is
 * reported, not judged.
 */
export function pairExports(kotlinByClass, exports) {
  const findings = [];
  const reports = [];
  const paired = [];
  const byKey = new Map();
  for (const e of exports) {
    if (e.mangled) {
      reports.push({
        kind: "mangled-export",
        site: `Java_${e.symbol}`,
        detail: "an overload-mangled JNI name — this gate does not read the overload table",
      });
      continue;
    }
    byKey.set(`${e.className}::${e.member}`, e);
  }
  for (const [cls, kt] of kotlinByClass) {
    for (const fn of kt.externals) {
      const key = `${cls}::${fn.name}`;
      const e = byKey.get(key);
      if (!e) {
        findings.push({
          file: kt.file,
          line: fn.line,
          kind: "missing-export",
          site: `external fun ${cls}.${fn.name}(…)`,
          detail: `no Rust export Java_com_amos_ai_glue_${cls}_${fn.name} exists — the JVM throws UnsatisfiedLinkError the first time Kotlin calls it`,
        });
      } else {
        paired.push(key);
        byKey.delete(key);
      }
    }
  }
  for (const [, e] of byKey) {
    if (!kotlinByClass.has(e.className)) {
      reports.push({
        kind: "foreign-export",
        site: `Java_${e.symbol}`,
        detail: `${e.className} is not a tracked glue file (a generated/machine-owned Activity)`,
      });
      continue;
    }
    findings.push({
      file: e.file,
      line: e.line,
      kind: "stale-export",
      site: `Java_${e.symbol}`,
      detail: `${e.className}.kt declares no external fun named ${e.member} — the Kotlin side renamed or removed it`,
    });
  }
  return { findings, reports, paired };
}

// --- selftest ---------------------------------------------------------------

export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  // 1. the blanker: the two defects jni-boolean-scan's first version had, plus block comments
  const raw = 'let x = "a//b"; // a comment with a ; in it\nlet y = 1; /* { not code } */ let z = 2;';
  const blank = stripComments(raw);
  ok("a `//` inside a string is not a comment", blank.includes('"a//b"'));
  ok("a `;` inside a comment is not code", !blank.includes("comment with a ;"));
  ok("code after a block comment survives", blank.includes("let z = 2;"));
  ok("line numbers are preserved by the blanker", lineOf(blank, blank.indexOf("let z")) === 2);

  // 2. argument splitting: nested commas and commas inside strings
  ok("top-level commas split", splitTopLevel('a, f(b, c), "d,e"').length === 3);
  ok("an empty argument list is no argument", splitTopLevel("").length === 0);

  // 3. Kotlin member extraction
  const ktSrc = [
    "object G {",
    "    @JvmStatic",
    "    fun annotated(): Boolean = true",
    "",
    "    /** KDoc in between is not a declaration */",
    "    @JvmStatic",
    "    fun documented() {}",
    "",
    "    // a comment",
    "    fun plain() {}",
    "}",
    "fun topLevel() {}",
  ].join("\n");
  const members = kotlinMembers(ktSrc);
  const member = (n) => members.find((m) => m.name === n);
  ok("an @JvmStatic member is found", member("annotated")?.jvmStatic === true);
  ok("a KDoc line between annotation and fun is fine", member("documented")?.jvmStatic === true);
  ok("a member without @JvmStatic is read as such", member("plain")?.jvmStatic === false);
  ok("an unannotated member is not top level", member("plain")?.topLevel === false);
  ok("a top-level fun is marked topLevel", member("topLevel")?.topLevel === true);
  ok("KDoc prose is not read as a declaration", members.length === 4);

  // 4. the F-TAU-014 shape: an `object` member called with call_static_method
  const glue = new Map([
    [
      "AlarmGlue",
      {
        file: "crates/amos-tauri/android-glue/com/amos/ai/glue/AlarmGlue.kt",
        members: kotlinMembers(
          'object AlarmGlue {\n    @JvmStatic\n    fun schedule(): Boolean = true\n    fun broken(c: Int): String = ""\n}',
        ),
      },
    ],
  ]);
  const rustFixture = [
    'const GLUE_CLASS: &str = "com/amos/ai/glue/AlarmGlue";',
    "fn good() {",
    '    env.call_static_method(GLUE_CLASS, "schedule", "()Z", &args);',
    "}",
    "fn bad() {",
    '    env.call_static_method(GLUE_CLASS, "broken", "()Z", &args);',
    "}",
    "fn platform_uri() {",
    '    env.call_static_method("android/net/Uri", "parse", "(Ljava/lang/String;)Landroid/net/Uri;", &[]);',
    "}",
  ].join("\n");
  const r1 = checkStaticCalls(rustFixture, "fixture.rs", glue);
  ok("an @JvmStatic member is verified", r1.checked.some((c) => c.member === "schedule"));
  ok(
    "a member without @JvmStatic is a finding (the device defect)",
    r1.findings.some((f) => f.kind === "missing-jvmstatic" && f.site.includes('"broken"')),
  );
  ok("a platform class is skipped, not failed", r1.skipped === 1 && r1.findings.length === 1);
  ok(
    "the finding carries the file and line",
    r1.findings[0]?.file === "fixture.rs" && r1.findings[0]?.line === 6,
  );

  // 5. a member that does not exist / a class the tree does not track
  const missing = checkStaticCalls(
    [
      'const C: &str = "com/amos/ai/glue/AlarmGlue";',
      'fn f() { env.call_static_method(C, "nope", "()V", &[]); }',
    ].join("\n"),
    "fixture.rs",
    glue,
  );
  ok("an unknown member is a finding", missing.findings[0]?.kind === "unknown-member");
  const unknownClass = checkStaticCalls(
    'fn f() { env.call_static_method("com/amos/ai/glue/Gone", "x", "()V", &[]); }',
    "fixture.rs",
    glue,
  );
  ok("an untracked glue class is a finding", unknownClass.findings[0]?.kind === "unknown-class");

  // 6. the amos-radio shape: local ← fn ← self.field ← const
  const radioFixture = [
    'const RADIO_CLASS: &str = "com.amos.ai.glue.RadioGlue";',
    'const BLUETOOTH_CLASS: &str = "com.amos.ai.glue.BluetoothGlue";',
    "fn new() {",
    "    let radio = resolve_glue_class(env, ctx, RADIO_CLASS);",
    "    let bluetooth = resolve_glue_class(env, ctx, BLUETOOTH_CLASS);",
    "}",
    "fn radio_glue(&self) -> Result<&GlobalRef> { self.radio.as_ref().ok_or_else(|| err()) }",
    "fn call_it(&self, env: &mut JNIEnv<'_>) {",
    "    let class = self.radio_glue()?;",
    '    env.call_static_method(class, "managedSurface", "(Ljava/lang/String;)Ljava/lang/String;", &[]);',
    "}",
  ].join("\n");
  const radio = checkStaticCalls(radioFixture, "android.rs", new Map());
  ok("no Kotlin tracked ⇒ unknown-class (not a silent skip)", radio.findings[0]?.kind === "unknown-class");
  ok(
    "the class is resolved through local ← fn ← field ← const",
    radio.findings[0]?.site.includes("RadioGlue") === true,
  );

  // 7. the wrapper shape (incall/blocklist): the member name is a parameter
  const wrapper = [
    "fn call_static_bool(method: &str) -> Result<bool, String> {",
    '    let class = env.find_class("com/amos/ai/glue/AmosInCallService").map_err(e)?;',
    '    let value = env.call_static_method(&class, method, "()Z", &[]).map_err(e)?;',
    "    value.z()",
    "}",
    'fn real_answer() -> Result<bool, String> { call_static_bool("answerActive") }',
    'fn real_hang_up() -> Result<bool, String> { call_static_bool("hangUpActive") }',
  ].join("\n");
  const wrapperGlue = new Map([
    [
      "AmosInCallService",
      {
        file: "crates/amos-tauri/android-glue/com/amos/ai/glue/AmosInCallService.kt",
        members: kotlinMembers(
          "class AmosInCallService {\n    companion object {\n        @JvmStatic\n        fun answerActive(): Boolean = true\n        @JvmStatic\n        fun hangUpActive(): Boolean = true\n    }\n}",
        ),
      },
    ],
  ]);
  const wrapped = checkStaticCalls(wrapper, "incall.rs", wrapperGlue);
  ok(
    "the member names come from the wrapper's callers",
    wrapped.checked.length === 2 && wrapped.checked.every((c) => c.cls === "AmosInCallService"),
  );
  const wrapperBroken = checkStaticCalls(
    wrapper,
    "incall.rs",
    new Map([
      [
        "AmosInCallService",
        {
          file: "x.kt",
          members: kotlinMembers(
            "class AmosInCallService {\n    companion object {\n        fun answerActive(): Boolean = true\n    }\n}",
          ),
        },
      ],
    ]),
  );
  ok(
    "a wrapper member without @JvmStatic is found (the literal-only gate would miss it)",
    wrapperBroken.findings.some((f) => f.kind === "missing-jvmstatic" && f.site.includes("answerActive")),
  );

  // 8. a site the resolver cannot read must not be silently skipped when glue is involved
  const unresolvable = checkStaticCalls(
    'fn f() { let c = pick(); env.call_static_method(c, "x", "()V", &[]); }',
    "fixture.rs",
    glue,
  );
  ok("a site with no glue evidence is skipped (a platform static)", unresolvable.skipped === 1);
  const unreadableMember = checkStaticCalls(
    [
      'const C: &str = "com/amos/ai/glue/AlarmGlue";',
      'fn f() { let m = pick(); env.call_static_method(C, m, "()V", &[]); }',
    ].join("\n"),
    "fixture.rs",
    glue,
  );
  ok(
    "an unreadable member name on a resolved glue class FAILS",
    unreadableMember.findings.some((f) => f.kind === "unresolved-member"),
  );
  const ambiguous = checkStaticCalls(
    [
      "fn f() {",
      '    let c = pick("com/amos/ai/glue/AlarmGlue", "com/amos/ai/glue/RadioGlue");',
      '    env.call_static_method(c, "x", "()V", &[]);',
      "}",
    ].join("\n"),
    "fixture.rs",
    glue,
  );
  ok(
    "two glue classes in one expression is reported as ambiguous, not guessed",
    ambiguous.findings.some((f) => f.kind === "ambiguous-class"),
  );
  const fnLiteral = checkStaticCalls(
    [
      "fn f() {",
      '    let class = env.find_class("com/amos/ai/glue/AlarmGlue")?;',
      '    env.call_static_method(&class, "schedule", "()Z", &[]);',
      "}",
    ].join("\n"),
    "fixture.rs",
    glue,
  );
  ok(
    "a class resolved by the enclosing fn's find_class is checked",
    fnLiteral.checked.some((c) => c.cls === "AlarmGlue" && c.member === "schedule"),
  );

  // 9. R2: both directions of the Kotlin ↔ Rust export contract
  const externals = kotlinExternalFuns(
    "object G {\n    private external fun attach(x: Any)\n    external fun gone()\n}",
  );
  const r2 = pairExports(
    new Map([["G", { file: "G.kt", externals }]]),
    rustExports("fn Java_com_amos_ai_glue_G_attach(env: *mut JNIEnv, x: jobject) {}"),
  );
  ok("a declared external fun with its export is paired", r2.paired.length === 1);
  ok(
    "an external fun with no export is a finding (UnsatisfiedLinkError)",
    r2.findings.some((f) => f.kind === "missing-export" && f.site.includes("gone")),
  );
  const stale = pairExports(
    new Map([["G", { file: "G.kt", externals: [] }]]),
    rustExports("fn Java_com_amos_ai_glue_G_removed() {}"),
  );
  ok("a Rust export whose Kotlin declaration is gone is a finding", stale.findings[0]?.kind === "stale-export");
  const foreign = pairExports(new Map(), rustExports("fn Java_com_amos_ai_MainActivity_onPhysicalHome() {}"));
  ok(
    "an export outside the glue tree (MainActivity) is reported, not judged",
    foreign.reports.length === 1 && foreign.findings.length === 0,
  );
  const mangled = pairExports(new Map(), rustExports("fn Java_com_amos_ai_glue_G_f__Ljava_lang_String_2() {}"));
  ok("a mangled overload name is reported, not guessed", mangled.reports.some((r) => r.kind === "mangled-export"));
  const parsed = rustExports("fn Java_com_amos_ai_glue_SmsGlue_onIncoming() {}")[0];
  ok(
    "the export parser reads class and member from the symbol",
    parsed?.className === "SmsGlue" && parsed?.member === "onIncoming",
  );

  // 10. R3: instance dispatch (`call_method`) — name *and arity* must exist on the Kotlin side
  ok("jniArity reads a no-arg descriptor", jniArity("()V") === 0);
  ok("jniArity counts object and primitive arguments", jniArity("(Ljava/lang/String;Z)V") === 2);
  ok("jniArity counts an array as one argument", jniArity("([BLjava/lang/String;)V") === 2);
  ok("jniArity refuses garbage instead of guessing", jniArity('"()Z" broken') === 0 && jniArity("nonsense") === null);
  ok("a glue handle is recognised by name", glueHandle("bridge.glue.as_obj()", "") === true);
  ok(
    "a handle bound from a bridge expression in the same fn is recognised",
    glueHandle("obj", 'let obj = self.bridge.as_obj();') === true,
  );
  ok(
    "a plain local is not a handle",
    glueHandle("loc", "let loc = read_location();") === false,
  );
  ok(
    "the binding's expression decides (name-based heuristic, documented)",
    glueHandle("loc", "let loc = glue_location();") === true,
  );
  ok(
    "a mention in a string is not a handle (the real_dial.rs lesson)",
    glueHandle("intent", 'let msg = "call TelephonyGlue.nativeAttach at boot";') === false,
  );

  const instanceTree = {
    byName: new Map([
      ["isGranted", [{ cls: "MicPermissionGlue", file: "crates/…/MicPermissionGlue.kt", line: 70, arity: 0, params: [], returns: "Boolean", imports: new Map() }]],
      ["request", [
        { cls: "MediaStoreGlue", file: "crates/…/MediaStoreGlue.kt", line: 60, arity: 2, params: ["String", "String"], returns: "String", imports: new Map() },
        { cls: "MicPermissionGlue", file: "crates/…/MicPermissionGlue.kt", line: 77, arity: 0, params: [], returns: "Unit", imports: new Map() },
      ]],
    ]),
  };
  const instanceFixture = [
    "fn is_granted() -> bool {",
    "    let v = e.call_method(bridge.glue.as_obj(), \"isGranted\", \"()Z\", &[])?;",
    "    v.z()",
    "}",
    "fn post_request() -> () {",
    "    e.call_method(bridge.glue.as_obj(), \"request\", \"()V\", &[])?;",
    "}",
  ].join("\n");
  const r3 = checkInstanceCalls(instanceFixture, "mic_permission.rs", instanceTree);
  ok("an instance call with the right name and arity is verified", r3.checked.length === 2);
  ok(
    "the arity decides *which* declaration matched",
    r3.checked.every((c) => c.cls === "MicPermissionGlue" && c.arity === 0),
  );
  const r3Missing = checkInstanceCalls(
    [
      "fn f() -> () {",
      '    e.call_method(bridge.glue.as_obj(), "isGrantedNow", "()Z", &[])?;',
      "}",
    ].join("\n"),
    "mic_permission.rs",
    instanceTree,
  );
  ok(
    "a renamed Kotlin member is a finding (the invisible-rename defect)",
    r3Missing.findings.some((f) => f.kind === "missing-kotlin-member"),
  );
  const r3Arity = checkInstanceCalls(
    [
      "fn f() -> () {",
      '    e.call_method(bridge.glue.as_obj(), "isGranted", "(Z)Z", &[])?;',
      "}",
    ].join("\n"),
    "mic_permission.rs",
    instanceTree,
  );
  ok(
    "a signature whose arity matches no declaration is a finding",
    r3Arity.findings.some((f) => f.kind === "arity-mismatch"),
  );
  const r3Platform = checkInstanceCalls(
    [
      "fn f() -> () {",
      '    e.call_method(&loc, "getLatitude", "()D", &[])?;',
      '    let intent = e.new_object("android/content/Intent", "()V", &[])?;',
      '    e.call_method(&intent, "addFlags", "(I)Landroid/content/Intent;", &[])?;',
      "}",
    ].join("\n"),
    "sensor.rs",
    instanceTree,
  );
  ok("platform receivers are skipped, never judged", r3Platform.skipped === 2 && r3Platform.findings.length === 0);
  const r3Wrapper = checkInstanceCalls(
    [
      "fn call0(&self, method: &str) -> String {",
      "    let glue = self.glue.0.as_obj();",
      '    e.call_method(glue, method, "()Ljava/lang/String;", &[])?;',
      "}",
      'fn counts(&self) -> String { self.call0("counts") }',
      'fn snapshots(&self) -> String { self.call0("snapshot") }',
      "}",
    ].join("\n"),
    "android.rs",
    { byName: new Map([["counts", [{ cls: "SmsGlue", file: "SmsGlue.kt", line: 240, arity: 0 }]]]) },
  );
  ok(
    "the wrapper's callers supply the member names (counts verified, snapshot a finding)",
    r3Wrapper.checked.some((c) => c.member === "counts") &&
      r3Wrapper.findings.some((f) => f.kind === "missing-kotlin-member" && f.site.includes("snapshot")),
  );
  const r3Owners = checkInstanceCalls(
    [
      "fn Java_com_amos_ai_glue_MicPermissionGlue_bind(env: JNIEnv, this: jobject) {}",
      "fn is_granted() -> bool {",
      '    e.call_method(bridge.glue.as_obj(), "isGranted", "()Z", &[])?;',
      "}",
    ].join("\n"),
    "mic_permission.rs",
    instanceTree,
  );
  ok("a member declared by the file's own glue class is not a report", r3Owners.reports.length === 0);

  // 11. the JNI descriptor's *types*, not just its arity (REQ-A378)
  ok("jniTypes splits arguments and the return type", jniTypes("(Ljava/lang/String;Z)V").args.length === 2);
  ok("jniTypes reads the return type", jniTypes("(Ljava/lang/String;Z)V").ret === "V");
  ok("jniTypes accepts the quoted form used at call sites", jniTypes('"(I)Z"').ret === "Z");
  ok("jniTypes treats an array as one argument type", jniTypes("([BLjava/lang/String;)V").args[0] === "[B");
  ok("jniTypes refuses a descriptor it cannot read", jniTypes("nonsense") === null);
  const noImports = new Map();
  ok("a Kotlin String is Ljava/lang/String;", kotlinTypeToJni("String", noImports) === "Ljava/lang/String;");
  ok("a Kotlin Long is J", kotlinTypeToJni("Long", noImports) === "J");
  ok("a nullable primitive is boxed", kotlinTypeToJni("Long?", noImports) === "Ljava/lang/Long;");
  ok("a nullable String stays Ljava/lang/String;", kotlinTypeToJni("String?", noImports) === "Ljava/lang/String;");
  ok("a ByteArray is [B", kotlinTypeToJni("ByteArray", noImports) === "[B");
  ok("a default value is not part of the type", kotlinTypeToJni("Int = 0", noImports) === "I");
  ok("a generic erases to its raw class", kotlinTypeToJni("MutableList<ScanResult>", noImports) === "Ljava/util/List;");
  ok("a lambda type is unmappable, not guessed", kotlinTypeToJni("() -> Unit", noImports) === null);
  ok("a bare name with no import is unmappable", kotlinTypeToJni("Context", noImports) === null);
  const ctxImports = new Map([["Context", "android.content.Context"], ["Call", "android.telecom.Call"]]);
  ok("an imported type resolves through the file's own import", kotlinTypeToJni("Context", ctxImports) === "Landroid/content/Context;");
  ok(
    "a nested type uses the JVM's $",
    kotlinTypeToJni("Call.Details", ctxImports) === "Landroid/telecom/Call$Details;",
  );
  ok("the glue's own classes resolve to the glue package", kotlinTypeToJni("AlarmGlue", noImports, new Set(["AlarmGlue"])) === "Lcom/amos/ai/glue/AlarmGlue;");

  const decl = { params: ["String", "Long"], returns: "Boolean", imports: noImports };
  ok("an exact match passes", signatureVerdict(decl, "(Ljava/lang/String;J)Z").ok === true);
  ok(
    "a wrong parameter type is a mismatch",
    signatureVerdict(decl, "(Ljava/lang/String;I)Z").ok === false,
  );
  ok("a wrong return type is a mismatch", signatureVerdict(decl, "(Ljava/lang/String;J)V").ok === false);
  ok("a wrong arity is a mismatch", signatureVerdict(decl, "(Ljava/lang/String;)Z").ok === false);
  ok(
    "an unmappable Kotlin type is *unknown*, never agreement",
    signatureVerdict({ params: ["Context"], returns: "Unit", imports: noImports }, "(Landroid/content/Context;)V").unknown === true,
  );
  ok(
    "a mismatch names the offending parameter",
    signatureVerdict(decl, "(Ljava/lang/String;I)Z").reason.includes("Kotlin Long (J) vs JNI I"),
  );

  const sigCall = {
    signature: "sig",
    fn: { name: "f", params: "", body: 'let sig = "(Landroid/content/Context;J)V"; e.call_static_method(C, "m", sig, &[]);' },
  };
  ok(
    "a signature built in a `let` is read from the binding",
    signatureOf(sigCall, "").value === "(Landroid/content/Context;J)V" && signatureOf(sigCall, "").how.includes("binding"),
  );
  ok(
    "a literal signature is read directly",
    signatureOf({ signature: '"()Z"', fn: null }, "").value === "()Z",
  );

  const typeGlue = new Map([
    [
      "AlarmGlue",
      {
        file: "AlarmGlue.kt",
        members: kotlinMembers("object AlarmGlue {\n    @JvmStatic\n    fun at(v: Long): Boolean = true\n}"),
      },
    ],
  ]);
  const typeOk = checkStaticCalls(
    'const C: &str = "com/amos/ai/glue/AlarmGlue";\nfn f() { e.call_static_method(C, "at", "(J)Z", &[]); }',
    "fixture.rs",
    typeGlue,
  );
  ok("a matching descriptor is verified (R1)", typeOk.checked.length === 1 && typeOk.findings.length === 0);
  const typeBad = checkStaticCalls(
    'const C: &str = "com/amos/ai/glue/AlarmGlue";\nfn f() { e.call_static_method(C, "at", "(I)Z", &[]); }',
    "fixture.rs",
    typeGlue,
  );
  ok(
    "a type drift is a finding through R1 (not just the arity)",
    typeBad.findings.some((f) => f.kind === "signature-mismatch"),
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[jni-contract-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[jni-contract-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}


// --- scan -------------------------------------------------------------------

/**
 * Production Rust sources: tests/examples/benches have no JVM duties, and `gen/` is the
 * machine-owned Tauri project (its Kotlin is not tracked and not ours to inspect).
 */
export function productionRust() {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (["target", "node_modules", ".git", "gen"].includes(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (p.endsWith(".rs") && !/\/(tests|examples|benches)\//.test(p)) {
        out.push(p.slice(root.length + 1));
      }
    }
  };
  walk(join(root, "crates"));
  return out.sort();
}

/**
 * The tracked Kotlin glue, indexed by class name. `tests/` is excluded (host-JVM tests
 * declare no production members), and a class name declared by two files is reported
 * rather than overwritten — the index would silently check the wrong file otherwise.
 */
export function glueKotlin() {
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
  const byClass = new Map();
  const byName = new Map();
  const duplicates = [];
  for (const f of files.sort()) {
    const cls = basename(f, ".kt");
    const src = readFileSync(join(root, f), "utf8");
    const entry = { file: f, members: kotlinMembers(src), externals: kotlinExternalFuns(src) };
    if (byClass.has(cls)) duplicates.push({ cls, file: f, first: byClass.get(cls).file });
    else byClass.set(cls, entry);
    for (const m of entry.members) {
      if (!byName.has(m.name)) byName.set(m.name, []);
      byName.get(m.name).push({
        cls,
        file: f,
        line: m.line,
        arity: m.arity,
        params: m.params,
        returns: m.returns,
        imports: m.imports,
      });
    }
  }
  GLUE_CLASS_NAMES = new Set(byClass.keys());
  return { files, byClass, byName, duplicates };
}

/** Apply `scripts/jni-contract-allowlist.json`: `{file, token, reason}`; stale entries FAIL. */
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
      console.error(`[jni-contract-scan] allow-entry without file+token+reason: ${JSON.stringify(e)}`);
      process.exit(2);
    }
  }
  const rustFiles = productionRust();
  const glue = glueKotlin();
  const findings = []; // R1 + R3 + R2 sites
  const checked = []; // R1: (glue class, member) pairs verified @JvmStatic
  const instanceChecked = []; // R3: (member, arity) pairs verified on the Kotlin side
  const staticReports = []; // R1: calls whose types this gate cannot read
  const instanceReports = [];
  let skippedStatics = 0;
  let staticSites = 0;
  let instanceSites = 0;
  let instanceSkipped = 0;
  for (const f of rustFiles) {
    const src = readFileSync(join(root, f), "utf8");
    const statics = checkStaticCalls(src, f, glue.byClass);
    findings.push(...statics.findings);
    checked.push(...statics.checked);
    staticReports.push(...statics.reports);
    skippedStatics += statics.skipped;
    staticSites += statics.sites;
    const instances = checkInstanceCalls(src, f, glue);
    findings.push(...instances.findings);
    instanceChecked.push(...instances.checked);
    instanceReports.push(...instances.reports);
    instanceSkipped += instances.skipped;
    instanceSites += instances.sites;
  }
  for (const d of glue.duplicates) {
    findings.push({
      file: d.file,
      line: 1,
      kind: "duplicate-class",
      site: `class ${d.cls}`,
      detail: `${d.first} declares the same class name — the index would check the wrong Kotlin file`,
    });
  }
  const exports = [];
  for (const f of rustFiles) {
    for (const e of rustExports(readFileSync(join(root, f), "utf8"))) exports.push({ ...e, file: f });
  }
  const r2 = pairExports(glue.byClass, exports);
  findings.push(...r2.findings);

  const { kept, stale } = applyAllowlist(findings, allow);
  const externalFuns = [...glue.byClass.values()].reduce((n, k) => n + k.externals.length, 0);
  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          rustFiles: rustFiles.length,
          kotlinFiles: glue.files.length,
          staticSites,
          staticChecked: checked.length,
          staticSkipped: skippedStatics,
          instanceSites,
          instanceChecked: instanceChecked.length,
          instanceSkipped,
          externalFuns,
          exports: exports.length,
          pairedExports: r2.paired.length,
          reports: [...r2.reports, ...staticReports, ...instanceReports],
          checked,
          instanceMembers: instanceChecked,
          findings: kept,
          stale,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[jni-contract-scan] R1: ${rustFiles.length} production Rust source(s); ${staticSites} static call site(s); ` +
        `${checked.length} glue member(s) verified (@JvmStatic + signature); ${skippedStatics} platform static(s) skipped.`,
    );
    console.log(
      `[jni-contract-scan] R2: ${glue.files.length} glue Kotlin file(s); ${externalFuns} external fun(s) ↔ ` +
        `${exports.length} Rust Java_… export(s); ${r2.paired.length} paired; ${r2.reports.length} reported-but-not-judged.`,
    );
    console.log(
      `[jni-contract-scan] R3: ${instanceSites} instance call site(s) (${instanceSkipped} platform receiver(s) skipped); ` +
        `${instanceChecked.length} glue member(s) verified by name + signature (types and arity); ` +
        `${instanceReports.length} reported-but-not-judged.`,
    );
    for (const f of kept) {
      console.error(`[jni-contract-scan] FAIL — ${f.file}:${f.line} ${f.kind}: ${f.site}\n          ${f.detail}`);
    }
    for (const s of stale) {
      console.error(`[jni-contract-scan] FAIL — stale allow-list entry (nothing matched it): ${s.file} ${s.token}`);
    }
    if (kept.length === 0 && stale.length === 0) {
      console.log(
        "[jni-contract-scan] OK — every Rust static call into the glue has a @JvmStatic member with a matching signature, every Kotlin `external fun` has its Rust export, and every instance call names a member the Kotlin side declares with that signature (types and arity).",
      );
    }
  }
  process.exit(kept.length === 0 && stale.length === 0 ? 0 : 1);
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();
if (IS_ENTRY && !process.argv.includes("--selftest")) runScan();

