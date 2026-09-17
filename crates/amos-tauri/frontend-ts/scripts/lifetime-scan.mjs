#!/usr/bin/env node
/**
 * lifetime-scan.mjs — "what registers must also unregister, and here is the rule".
 *
 * A window that stays open for days (this OS shell does) turns every forgotten registration
 * into an accumulating cost, and — worse — into callbacks that wake up for something that is
 * already gone. The audit behind REQ-A327/REQ-A328 swept the whole surface by hand and found
 * the codebase **clean**; this gate is the part that keeps it that way, because "clean today"
 * is not a property anything was checking. Three rules, each exact, each with **zero**
 * violations when the gate was written:
 *
 *   R1 · repeating timers are cleared — a file that starts a `setInterval` also calls
 *        `clearInterval`. Deliberately **not** about `setTimeout`: a one-shot timer needs no
 *        clear and firing once is the whole job (`lib/focusTrap.ts`'s 0 ms focus restore,
 *        `InterpApp`'s 1.5 s "copied" flag) — every `setTimeout` "without a clear" in this
 *        tree was checked by hand and is one of those.
 *   R2 · component subscriptions have a lifetime — in `src/svelte/**`, every subscription
 *        (`X.subscribe(`, `propsChannel<…>(…).on(`) is either **returned** (an `$effect`
 *        teardown) or the file has an `onDestroy(` that tears it down. A *module* singleton
 *        (theme/locale watch, the props bus) is not in scope: it lives exactly as long as
 *        the page, which is what a page-scoped listener should do.
 *   R3 · component global listeners are removed — a `.svelte` file that adds a `window` or
 *        `document` listener also calls `removeEventListener`. (Element-scoped listeners are
 *        out of scope on purpose: they die with their element.)
 *
 * A deliberate exception is declared inline with `lifetime-scan: deliberate` in the file —
 * a decision written down, not an accident (the same pattern `hover-scan.mjs` uses).
 *
 * Usage:
 *   node scripts/lifetime-scan.mjs             # the gate
 *   node scripts/lifetime-scan.mjs --selftest  # pin the three detectors
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, ".."); // frontend-ts/
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".vite"]);
const EXEMPT = "lifetime-scan: deliberate";

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const count = (src, needle) => src.split(needle).length - 1;

/** R1 — a repeating timer whose file never clears it. `null` when fine. */
export function repeatingTimerProblem(src) {
  if (count(src, "setInterval(") === 0) return null;
  if (count(src, "clearInterval(") > 0) return null;
  return "starts a `setInterval` and never clears one in this file";
}

/**
 * R2 — a subscription in a component with no lifetime. `null` when fine.
 *
 * Tracked **per variable, by count**: `const un = store.subscribe(cb)` is fine when that name
 * is returned (an `$effect` teardown) or called (`onDestroy(() => un?.())`), and the releases
 * are counted against the subscriptions that name — a file with two `const un = …subscribe(`
 * and one `return un;` is one release short (which is exactly the shape a first version of
 * this rule missed). The read-once idiom (`store.subscribe(cb)()`) is released on the spot.
 */
export function subscriptionProblem(src) {
  const lines = src.split("\n");
  /** Subscription sites that are not returned inline / released on the spot. */
  const pending = [];
  const assignedCount = new Map();
  for (const line of lines) {
    if (!line.includes(".subscribe(") && !line.includes(".on((")) continue;
    if (line.includes("return ")) continue; // returned inline: an `$effect` teardown
    if (/\)\s*\(\s*\)\s*;?\s*$/.test(line.trim())) continue; // read-once: subscribe(cb)()
    // The name may be declared right here or assigned to one declared earlier.
    const assigned =
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line) ??
      /^\s*([A-Za-z_$][\w$]*)\s*=[^=]/.exec(line);
    if (!assigned) {
      pending.push(null);
      continue;
    }
    const name = assigned[1];
    assignedCount.set(name, (assignedCount.get(name) ?? 0) + 1);
    pending.push(name);
  }
  if (pending.length === 0) return null;
  const problems = [];
  const reported = new Set();
  for (const name of pending) {
    if (name === null) {
      if (!reported.has("(anonymous)")) {
        reported.add("(anonymous)");
        problems.push("a subscription is neither returned nor released");
      }
      continue;
    }
    if (reported.has(name)) continue;
    reported.add(name);
    // Releases: `return <name>` (an $effect teardown) or `<name>(` / `<name>?.(`
    // (the `onDestroy(() => un?.())` idiom).
    const releases =
      (src.match(new RegExp(`return\\s+${name}\\b`, "g")) ?? []).length +
      (src.match(new RegExp(`\\b${name}\\s*\\??\\.?\\s*\\(`, "g")) ?? []).length;
    if (releases < (assignedCount.get(name) ?? 0)) {
      problems.push(
        `\`${name}\` has ${assignedCount.get(name)} subscription(s) and ${releases} release(s)`,
      );
    }
  }
  return problems.length > 0 ? problems.join("; ") : null;
}

/** R3 — a component that adds a window/document listener and never removes one. `null` when fine. */
export function globalListenerProblem(src) {
  const adds = count(src, "window.addEventListener(") + count(src, "document.addEventListener(");
  if (adds === 0) return null;
  if (count(src, "removeEventListener(") > 0) return null;
  return `${adds} window/document listener(s) added, no \`removeEventListener\` in this file`;
}

function selftest() {
  const problems = [];
  const want = (label, got, expected) => {
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      problems.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
    }
  };

  // R1 — the leak, and the three shapes that must NOT be flagged.
  want("R1: interval without clear", repeatingTimerProblem("const i = setInterval(t, 1000);") !== null, true);
  want("R1: interval with clear", repeatingTimerProblem("setInterval(t, 1000); clearInterval(id);"), null);
  want("R1: a one-shot timer is not a repeating one", repeatingTimerProblem("setTimeout(t, 0);"), null);
  want("R1: clearInterval in a file with no interval is fine", repeatingTimerProblem("clearInterval(1);"), null);

  // R2 — returned, torn down, or nothing at all.
  want(
    "R2: unmanaged subscription in a component",
    subscriptionProblem("\n    const un = s.subscribe(cb);\n") !== null,
    true,
  );
  want("R2: returned subscription", subscriptionProblem("\n    return s.subscribe(cb);\n"), null);
  want(
    "R2: manual teardown idiom",
    subscriptionProblem("\n    un = s.subscribe(cb);\n    onDestroy(() => un?.());\n"),
    null,
  );
  want("R2: no subscriptions at all", subscriptionProblem("const x = 1;"), null);

  // R3 — the leak, and the element-scoped case that is deliberately out of scope.
  want(
    "R3: window listener with no removal",
    globalListenerProblem("window.addEventListener(\"keydown\", f);") !== null,
    true,
  );
  want(
    "R3: window listener with removal",
    globalListenerProblem("window.addEventListener(\"keydown\", f); window.removeEventListener(\"keydown\", f);"),
    null,
  );
  want("R3: an element-scoped listener is out of scope", globalListenerProblem("el.addEventListener(\"click\", f);"), null);

  // The exemption marker is a decision, and it has to be readable.
  if (!EXEMPT.includes("deliberate")) problems.push("the exemption marker must say why it is one");

  if (problems.length > 0) {
    console.error(`[lifetime-scan] selftest FAIL:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`[lifetime-scan] selftest: 11 assertion(s), 0 failure(s).`);
}

if (process.argv.includes("--selftest")) {
  selftest();
  process.exit(0);
}

const problems = [];
const isTestDir = (f) => f.includes("__tests__") || f.includes("svelte-tests");

// R1 — every production source file.
let intervals = 0;
for (const f of walk(ROOT)) {
  if (!/\.(ts|svelte)$/.test(f)) continue;
  if (!f.startsWith(join(ROOT, "src"))) continue;
  if (isTestDir(f)) continue;
  const src = readFileSync(f, "utf8");
  if (src.includes(EXEMPT)) continue;
  intervals += count(src, "setInterval(");
  const why = repeatingTimerProblem(src);
  if (why) problems.push(`${relative(ROOT, f)}: ${why}`);
}

// R2 + R3 — components only: a screen must have a lifetime, a module singleton is the page.
let subs = 0;
for (const f of walk(join(ROOT, "src/svelte"))) {
  if (!f.endsWith(".svelte")) continue;
  const src = readFileSync(f, "utf8");
  if (src.includes(EXEMPT)) continue;
  subs += count(src, ".subscribe(") + count(src, ".on((");
  for (const why of [subscriptionProblem(src), globalListenerProblem(src)]) {
    if (why) problems.push(`${relative(ROOT, f)}: ${why}`);
  }
}

if (problems.length > 0) {
  console.error(`[lifetime-scan] FAIL — ${problems.length} lifetime problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nA long-lived shell turns a forgotten registration into an accumulating cost and a\n" +
      "callback that wakes up for something already gone. Clean up what you register, or\n" +
      "declare `lifetime-scan: deliberate` with the reason (see REQ-A327/A328).",
  );
  process.exit(1);
}
console.log(
  `[lifetime-scan] OK — ${intervals} interval(s) cleared in their file, ` +
    `${subs} component subscription(s) with a lifetime, global listeners removed.`,
);
