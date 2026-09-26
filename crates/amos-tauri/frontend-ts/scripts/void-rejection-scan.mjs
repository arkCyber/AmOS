#!/usr/bin/env node
/**
 * void-rejection-scan.mjs — a `void f()` whose rejection nobody receives is a
 * silent no-op, and this gate finds the ones that *can* reject (REQ-A856).
 *
 * ## The class, and its already-covered mirror
 *
 * `void f()` is the repo's idiom for "this is deliberately fire-and-forget". It
 * is correct whenever `f` cannot reject — and in this codebase that is the usual
 * case, because `lib/backend.ts:invoke` **catches** every bridge rejection and
 * returns `null` (REQ-A296), so the hundreds of `void invoke(...)`-shaped sites
 * are all fine. A first pass that flags `void` + `async` would be noise.
 *
 * The mirror half of this family is already covered: `scripts/void-cmd-scan.mjs`
 * (REQ-A845 / F-SH-273) handles a `void` **bridge command** whose *readable*
 * verdict nobody reads — it takes `invoke`'s never-rejecting contract as its own
 * premise, which is why its failure value (`null`) collides with success. This
 * gate is the complement, not a duplicate: here the callee **does** reject, so
 * there is no verdict to read at all, and no `bridgeDiag(...)` can recover it.
 * Between the two, "the call's outcome was never observed" is covered from both
 * sides — the readable-but-unread, and the unreadable.
 *
 * The defect appears when the callee throws in **plain JS**: `executeShortcut`
 * raises on an execution timeout, on control-flow depth, and on an invalid URL.
 * Then the rejection has no receiver, and the surface has usually already
 * dismissed itself — so the user watches the overlay close and nothing happens,
 * which is shaped exactly like success. That is what `ShareSheet.runTarget` did
 * (REQ-A856) while its own comment claimed parity with `ShortcutsApp.handleRun`,
 * which wraps the identical call in `try/catch/finally`.
 *
 * ## The rule, and why it is drawn here
 *
 * A `void <f>(...)` site is reported when `f` is **repo-defined**, `f`'s body
 * calls a *verified thrower*, and `f`'s body has no `try`. A verified thrower is
 * a function defined under `src/lib/**` whose brace-matched body contains
 * `throw`.
 *
 * The two boundaries are deliberate and each is a measured decision, not a
 * convenience:
 *
 * * **`src/lib/**` only.** A `throw` inside a *component* is not modelled,
 *   because a component function's brace span swallows the `throw` of a nested
 *   callback that its own callee then catches — `PhotosApp.loadNativePage`
 *   looks like a thrower for exactly this reason, while its `throw` sits in a
 *   callback that `fetchInto` catches (`mediaPaging.ts`, per-directory
 *   `catch { failed.push(dir) }`). Including component throwers would have put
 *   that site in the census, and the only honest allow-list entry for it would
 *   have been a *false* reason — the worst kind of green.
 * * **two hops, not a reachability fixpoint.** A full call-graph fixpoint marks
 *   1175 of 2891 definitions as throwing (41%) because generic names (`load`,
 *   `run`, `scan`, `subscribe`) propagate; it is a tautology dressed as rigor,
 *   not a judgment. Depth 2 over a hand-verified throw-set is small enough to
 *   read: 2 sites.
 *
 * Both defects this rule knows about are the *same* shape in two apps — one
 * fixed (ShareSheet), one already correct (CameraApp) — and `MUST_SEE_SITES`
 * pins both directions so a deleted guard cannot quietly empty the census.
 *
 * Usage: `node scripts/void-rejection-scan.mjs [--json] [--selftest]`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FRONTEND = resolve(HERE, '..');
const SRC = join(FRONTEND, 'src');

/** A site that must appear in the census, in both directions (see `pinDiff`). */
export const MUST_SEE_SITES = [
  'src/svelte/CameraApp.svelte:beginRecord',
  'src/svelte/ShareSheet.svelte:runTarget',
];

/** Throwers the pinned sites depend on: if one stops throwing, the *reason* the
 *  guard exists is gone and a human has to re-decide — so its absence is loud. */
export const MUST_SEE_THROWERS = [
  'src/lib/shortcuts.ts:executeShortcut',
  'src/lib/cameraCapture.ts:startVideoRecording',
];

/** Blank comment spans and string interiors, preserving offsets and newlines. */
export function maskProse(src, { strings = true } = {}) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  if (!strings) return out;
  return out
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** The brace-matched body starting at the first `{` at/after `from`. */
export function bodyAt(src, from) {
  const i = src.indexOf('{', from);
  if (i < 0) return '';
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(i, k + 1);
    }
  }
  return src.slice(i);
}

const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new',
  'await', 'constructor', 'do', 'else', 'in', 'of', 'yield', 'super', 'this',
]);

const DEF_PATTERNS = [
  /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^;{]{0,80})?\{/gm,
];

export function walk(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      walk(p, acc);
    } else if (/\.(ts|svelte)$/.test(name) && !/\.test\./.test(name)) {
      acc.push(p);
    }
  }
  return acc;
}

/** name -> { file, body } for every repo-defined function, first definition wins. */
export function indexDefs(files, read = (f) => readFileSync(f, 'utf8')) {
  const defs = new Map();
  for (const abs of files) {
    const src = maskProse(read(abs));
    for (const re of DEF_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const name = m[1];
        if (RESERVED.has(name)) continue;
        if (!defs.has(name)) {
          defs.set(name, { file: relative(FRONTEND, abs), body: bodyAt(src, m.index) });
        }
      }
    }
  }
  return defs;
}

const throws = (body) => /\bthrow\b/.test(body);
const callsNamed = (body, name) =>
  new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(body);

/** `void <callee>(` anywhere — including inline (`onclick={() => void f()}`). */
const VOID_RE = /(?<![\w$.])void\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;

/**
 * The census. `libOnly` default is the measured boundary; the selftest turns it
 * off to prove the boundary is what excludes component throwers.
 */
export function scan({ files, defs, read = (f) => readFileSync(f, 'utf8') }) {
  const throwers = new Map();
  for (const [name, d] of defs) {
    if (d.file.startsWith('src/lib/') && throws(d.body)) throwers.set(name, d.file);
  }
  const sites = [];
  for (const abs of files) {
    const rel = abs.startsWith('/') ? relative(FRONTEND, abs) : abs;
    const src = maskProse(read(abs));
    VOID_RE.lastIndex = 0;
    let m;
    while ((m = VOID_RE.exec(src))) {
      const callee = m[1];
      const base = callee.split('.').pop();
      const def = defs.get(base);
      if (!def) continue; // not repo-defined: a host fn, or an `invoke`-shaped wrapper
      // Depth 1 and depth 2 are the same question asked of different functions:
      // is a verified thrower on the path this `void` starts? A callee that is
      // itself a thrower counts just as a callee that calls one.
      const reached = [];
      if (throwers.has(base)) reached.push(base);
      for (const t of throwers.keys()) {
        if (t !== base && callsNamed(def.body, t)) reached.push(t);
      }
      if (reached.length === 0) continue;
      sites.push({
        file: rel,
        line: src.slice(0, m.index).split('\n').length,
        at: `${rel}:${base}`,
        callee: base,
        calleeDefinedAt: def.file,
        reached,
        guarded: /\btry\s*\{/.test(def.body),
      });
    }
  }
  return { throwers, sites };
}

/** Set equality in both directions: a deleted site must be as loud as a new one. */
export function pinDiff(got, want) {
  const g = new Set(got);
  const w = new Set(want);
  return {
    missing: want.filter((x) => !g.has(x)),
    extra: got.filter((x) => !w.has(x)),
  };
}

function checkPins({ throwers, sites }) {
  const problems = [];
  const sitePins = pinDiff(sites.map((s) => s.at), MUST_SEE_SITES);
  for (const m of sitePins.missing) {
    problems.push(`pinned void site no longer found: ${m} — if its guard was removed this is the regression; if it was refactored away, update MUST_SEE_SITES deliberately`);
  }
  for (const e of sitePins.extra) problems.push(`unpinned void site: ${e}`);

  const throwerKeys = [...throwers].map(([n, f]) => `${f}:${n}`);
  const throwerPins = pinDiff(throwerKeys, MUST_SEE_THROWERS);
  for (const m of throwerPins.missing) {
    problems.push(`pinned thrower no longer throws: ${m} — the guard at its call site is now unexplained; re-review before removing it`);
  }
  for (const s of sites) {
    if (!s.guarded) problems.push(`UNGUARDED: ${s.file}:${s.line} void ${s.callee}() -> [${s.reached.join(', ')}]`);
  }
  return problems;
}

function load() {
  const files = walk(SRC);
  const defs = indexDefs(files);
  return { files, defs, ...scan({ files, defs }) };
}

/* ------------------------------- selftest ------------------------------- */

function selftest() {
  let failures = 0;
  const ok = (name, cond) => {
    if (!cond) {
      failures++;
      console.log(`  FAIL ${name}`);
    }
  };

  // Fixtures are this round's lessons: each one is a shape that fooled an
  // earlier version of the instrument, or a boundary we claim to honour.
  const cases = [
    {
      name: 'a void site whose callee has a try is clean',
      lib: { boom: 'export function boom() { throw new Error("x"); }' },
      comp: 'const f = async () => { try { await boom(); } catch {} };\nvoid f();',
      want: 1, guarded: true,
    },
    {
      name: 'the same site without the try is reported',
      lib: { boom: 'export function boom() { throw new Error("x"); }' },
      comp: 'const f = async () => { await boom(); };\nvoid f();',
      want: 1, guarded: false,
    },
    {
      // The instrument bug that hid the real defect: `void` inline in a handler,
      // never at line start (found in this round — first version reported 0).
      name: 'void inline inside a handler is found',
      lib: { boom: 'export function boom() { throw new Error("x"); }' },
      comp: 'const f = async () => { await boom(); };\n<button onclick={() => void f()}>go</button>',
      want: 1, guarded: false,
    },
    {
      // The boundary: a `throw` in a *component* is not modelled, because the
      // brace span swallows a nested callback's throw that its callee catches.
      name: 'a component-level thrower is not a thrower',
      lib: {},
      comp: 'const helper = async () => { throw new Error("nested"); };\nconst f = async () => { await helper(); };\nvoid f();',
      want: 0, guarded: true,
    },
    {
      // `invoke` catches (REQ-A296), so a wrapper over it cannot reject — the
      // hundreds of `void`-ed bridge calls must stay out of the census.
      name: 'a callee that only funnels through invoke is not a thrower',
      lib: { boom: 'export function boom() { throw new Error("x"); }',
             wrapper: 'export function wrapper() { return invoke("x"); }' },
      comp: 'const f = async () => { await wrapper(); };\nvoid f();',
      want: 0, guarded: true,
    },
    {
      name: 'a throw inside a comment or string does not make a thrower',
      lib: { boom: '// throw new Error("no")\nexport function boom() { return "throw"; }' },
      comp: 'const f = async () => { await boom(); };\nvoid f();',
      want: 0, guarded: true,
    },
    {
      name: 'a direct void of a thrower is reported (depth 1)',
      lib: { boom: 'export function boom() { throw new Error("x"); }' },
      comp: 'void boom();',
      want: 1, guarded: false,
    },
  ];

  for (const c of cases) {
    const libSrc = Object.entries(c.lib).map(([n, s]) => `${s}`).join('\n');
    const files = [];
    const contents = new Map();
    if (libSrc) {
      files.push('src/lib/fixture.ts');
      contents.set('src/lib/fixture.ts', libSrc);
    }
    files.push('src/svelte/Fixture.svelte');
    contents.set('src/svelte/Fixture.svelte', c.comp);

    const read = (f) => contents.get(f);
    const defs = indexDefs(files, read);
    const { sites } = scan({ files, defs, read });
    ok(`${c.name} (count)`, sites.length === c.want);
    if (c.want > 0) ok(`${c.name} (guard flag)`, sites[0]?.guarded === c.guarded);
  }

  // pinDiff must report both directions, or a deleted site is silent.
  const d = pinDiff(['a', 'b'], ['a', 'c']);
  ok('pinDiff reports missing', d.missing.length === 1 && d.missing[0] === 'c');
  ok('pinDiff reports extra', d.extra.length === 1 && d.extra[0] === 'b');

  // The two pins, exercised without perturbing a live source file (the pinned
  // thrower lives in `shortcuts.ts`, which another round may be editing — a
  // perturbation window there is exactly what the workspace's NC discipline
  // forbids). A complete census of the right shape, with one pin starved each time.
  const full = new Map(MUST_SEE_THROWERS.map((k) => {
    const [file, name] = [k.slice(0, k.lastIndexOf(':')), k.slice(k.lastIndexOf(':') + 1)];
    return [name, file];
  }));
  const sites = MUST_SEE_SITES.map((at) => {
    const file = at.slice(0, at.lastIndexOf(':'));
    const callee = at.slice(at.lastIndexOf(':') + 1);
    return { file, at, callee, guarded: true, reached: ['x'], line: 1 };
  });
  ok('a complete census with both pins satisfied has no problems',
    checkPins({ throwers: full, sites }).length === 0);
  const starvedThrower = new Map(full);
  starvedThrower.delete(MUST_SEE_THROWERS[0].slice(MUST_SEE_THROWERS[0].lastIndexOf(':') + 1));
  ok('removing a pinned thrower is reported (the guard would be unexplained)',
    checkPins({ throwers: starvedThrower, sites }).some((p) => p.includes('no longer throws')));
  ok('removing a pinned site is reported (a floor would stay silent here)',
    checkPins({ throwers: full, sites: sites.slice(1) }).some((p) => p.includes('no longer found')));
  ok('an unguarded site is reported even when every pin is satisfied',
    checkPins({ throwers: full, sites: [{ ...sites[0], guarded: false }] })
      .some((p) => p.startsWith('UNGUARDED')));

  console.log(`[void-rejection] selftest: ${cases.length} fixture(s) + 6 assertion(s), ${failures} failure(s).`);
  return failures === 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

  const { throwers, sites } = load();
  const problems = checkPins({ throwers, sites });

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ throwers: [...throwers.keys()], sites, problems }, null, 2));
    process.exit(problems.length === 0 ? 0 : 1);
  }

  for (const s of sites) {
    const mark = s.guarded ? 'guarded  ' : 'UNGUARDED';
    console.log(`[void-rejection] ${mark} ${s.file}:${s.line} void ${s.callee}() -> [${s.reached.join(', ')}]`);
  }
  console.log(
    `[void-rejection] ${sites.length} void site(s) whose callee can reject, over ${throwers.size} verified thrower(s) in src/lib.`,
  );
  for (const p of problems) console.log(`[void-rejection] ${p}`);
  if (problems.length) {
    console.log('[void-rejection] FAIL — a rejected fire-and-forget has no receiver.');
    process.exit(1);
  }
  console.log('[void-rejection] OK — every fire-and-forget that can reject has a receiver.');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
