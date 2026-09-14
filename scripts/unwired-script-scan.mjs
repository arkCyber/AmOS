#!/usr/bin/env node
/**
 * unwired-script-scan.mjs — "a script nothing runs".
 *
 * Why: this repository already audits *code* reachability twice — `unwired-scan.mjs`
 * (TS exports / mounted components) and `rust-unwired-scan.mjs` (`pub` items in library
 * crates) — but the **executable layer** had no such check, and every other gate is built
 * on it: `make lint` is a list of scripts. Measured when this gate was added (REQ-A189):
 * **4 of 48 scripts** were unreachable from the Makefile, the CI workflows, and every
 * reachable script — `dev.sh`, `gui-smoke.sh`, `gui-smoke-check.sh`,
 * `supervise-backends.sh`. One of them (`gui-smoke-check.sh`) says in its own header it
 * is "a quick readiness probe in CI/headless" while no CI job and no target called it;
 * `dev.sh` was the prerequisite `docs/gui-verify.md` tells a human to run *and* it
 * launched a dev-mode UI whose frontend (`devUrl`) nothing served.
 *
 * REQ-A190 extended it one layer over, to the System UI's own surface: **3 of 12 frontend
 * scripts** (`coverage-low.mjs`, `gen-ringtones.mjs`, `gen-ringtones-mp3.mjs`) were named
 * by nothing — and nothing checked that `frontend-ts/package.json`'s keys name files that
 * exist, so a renamed script could leave a key that only fails when a human types it
 * (9 of those 25 keys are never typed by a shipped file or a CI job).
 *
 * What counts as wired: the script's basename appears in a **shipped executable** file —
 * the Makefile, anything under `.github/`, or another script that is itself reachable (so
 * `gui-smoke.sh`, invoked only by `gui-smoke-check.sh`, becomes wired the moment its
 * caller is). **Comments are stripped before edges are read** (`stripComments` below): the
 * first version of this file did not do that, and its negative control failed because this
 * very header comment named the four scripts the gate was reporting — the documentation
 * "wired" them, and the gate stayed green after their Makefile targets were deleted.
 *
 * Docs/README/CHANGELOG mentions do **not** count: a documented command that nothing can
 * run is the defect, not the justification. If a script really is a manual entry point,
 * give it a target (the normal fix — `make dev`, `make supervise` and
 * `make gui-smoke-check` exist because of this gate) or record the reason in
 * `scripts/script-allowlist.json`, where a stale entry FAILS.
 *
 * Relationship to the other gates: `lint-inputs-scan.mjs` (forward) proves every script
 * the Makefile invokes exists and is tracked; this one (reverse) proves every script that
 * ships is invoked. A file can pass one and fail the other, and both matter.
 *
 * Scope boundaries: the tracked surface is `scripts/*.{sh,mjs,js,cjs}`, the repository-root
 * `*.sh` (`deploy.sh`), and the frontend's `crates/amos-tauri/frontend-ts/scripts/*`
 * (REQ-A190 — the System UI has a second command surface and had the same blind spot).
 * A helper *library* a script `source`s is covered by the same edge rule (its users name
 * it); `frontend-ts/package.json` is treated like the Makefile (its keys are the frontend's
 * targets, so each key body is a root edge), and its **forward** direction —
 * every script path a key names must exist — is checked here because a stale key fails only
 * when a human types it (9 of its 25 keys are never typed by a shipped file or CI job).
 * Nothing here proves a target is *run by CI* — many are deliberately manual or
 * device-only, and that is what `unwired` means; the `--json` output reports the counts
 * (`viaCi`, `keys.manual`) so that distinction stays visible.
 *
 * Usage (from the repo root):
 *   node scripts/unwired-script-scan.mjs              # gate
 *   node scripts/unwired-script-scan.mjs --json
 *   node scripts/unwired-script-scan.mjs --selftest   # pin the tokenizer + closure
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAKEFILE = join(root, "Makefile");
const ALLOWLIST = join(root, "scripts", "script-allowlist.json");
const GITHUB = join(root, ".github");
const FRONTEND = join(root, "crates", "amos-tauri", "frontend-ts");
const FE_PKG = join(FRONTEND, "package.json");
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", "build"]);

/**
 * Every script this gate tracks: `scripts/*.{sh,mjs,js,cjs}`, the repository root `*.sh`,
 * and the **frontend's own** `crates/amos-tauri/frontend-ts/scripts/*` (REQ-A190 — the
 * System UI has a second command surface, and it had the same blind spot).
 */
export function shippedScripts(dir = root) {
  const out = [];
  const sdir = join(dir, "scripts");
  if (existsSync(sdir)) {
    for (const e of readdirSync(sdir)) {
      if (/\.(sh|mjs|js|cjs)$/.test(e)) out.push(join("scripts", e));
    }
  }
  for (const e of readdirSync(dir)) {
    if (e.endsWith(".sh") && statSync(join(dir, e)).isFile()) out.push(e);
  }
  const fe = join(dir, "crates", "amos-tauri", "frontend-ts", "scripts");
  if (existsSync(fe)) {
    for (const e of readdirSync(fe)) {
      if (/\.(sh|mjs|js|cjs)$/.test(e)) {
        out.push(join("crates", "amos-tauri", "frontend-ts", "scripts", e));
      }
    }
  }
  return out.sort();
}

/**
 * Basenames of `names` mentioned by `text`. The tokenizer is deliberately blunt
 * (whitespace and shell punctuation) and matches on the **basename**, so `bash
 * scripts/x.sh`, `./scripts/x.sh`, `$(ROOT)/scripts/x.sh` and a bare invocation all count.
 */
export function edgeTargets(text, names, self) {
  const out = new Set();
  for (const tok of text.split(/[\s;'"`()|&<>=,]+/)) {
    const base = tok.split("/").pop();
    if (base !== self && names.has(base)) out.add(base);
  }
  return out;
}

/**
 * Drop comments before looking for edges. This is not cosmetic: the **first version of
 * this gate did not**, and its negative control failed because the four unwired scripts
 * were named in *this file's own header comment* — the gate's documentation "wired" the
 * very scripts it was reporting, and stayed green after their Makefile targets were
 * deleted. A mention inside a comment is not a call site.
 *
 * Blunt by design (documented, not guessed): whole-line `#` comments everywhere, plus
 * `//` and `/* … *​/` for JavaScript. It will also cut a shell `#` inside a string or a
 * `${VAR#prefix}` expansion — the tokens before it survive, and the gate errs toward
 * "still wired", which cannot produce a false failure.
 */
export function stripComments(text, kind) {
  if (kind === "js") return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return text
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? "" : line.replace(/(\s)#.*$/, "$1")))
    .join("\n");
}

/** Which comment syntax a path uses. */
export function kindOf(path) {
  if (/\.(mjs|js|cjs)$/.test(path)) return "js";
  if (/\.sh$/.test(path)) return "shell";
  return "hash";
}

/** `text` from `path`, with its comments removed. */
export function readEdges(path, names, read) {
  let txt;
  try {
    txt = read(path);
  } catch {
    return null;
  }
  return edgeTargets(stripComments(txt, kindOf(path)), names, basename(path));
}

/**
 * All files that can invoke a script: the Makefile, everything under `.github/`, and the
 * frontend's `package.json` — a **second command surface** (its keys are the frontend's
 * equivalent of `make` targets, so each key body is a root edge, exactly like a recipe).
 */
export function executableRoots(dir = root) {
  const out = [MAKEFILE];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (SKIP_DIRS.has(e)) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(GITHUB)) walk(GITHUB);
  if (existsSync(FE_PKG)) out.push(FE_PKG);
  return out.filter((p) => existsSync(p));
}

/** Everything whose text is read for edges: the roots plus every shipped script. */
export function edgeSources(dir = root) {
  return [...executableRoots(dir), ...shippedScripts(dir).map((s) => join(dir, s))];
}

/**
 * Which scripts are reachable, following script-to-script edges to a fixed point. An edge
 * from a non-script file (the Makefile, a workflow, the Dockerfile) is a root edge, unless
 * `seeds` is given — then the search starts from those basenames instead (used to ask "what
 * can CI alone reach?", where the roots come from `make <target>` indirection).
 */
export function closure(sources, names, read = (p) => readFileSync(p, "utf8"), seeds = null) {
  const edges = new Map();
  const roots = new Set(seeds ?? []);
  for (const p of sources) {
    const outs = readEdges(p, names, read);
    if (outs === null) continue;
    const self = basename(p);
    if (names.has(self)) {
      for (const o of edges.get(self) ?? []) outs.add(o);
      edges.set(self, outs);
    } else if (seeds === null) {
      for (const o of outs) roots.add(o);
    }
  }
  const wired = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift();
    for (const o of edges.get(name) ?? []) {
      if (!wired.has(o)) (wired.add(o), queue.push(o));
    }
  }
  return { wired: [...wired].sort(), dead: [...names].filter((n) => !wired.has(n)).sort() };
}

/** A Makefile's recipes, keyed by target name. */
export function makeTargets(makefile) {
  const targets = new Map();
  let cur = null;
  for (const raw of makefile.split("\n")) {
    const t = raw.match(/^([A-Za-z0-9_.\-]+):/);
    if (t) {
      cur = t[1];
      if (!targets.has(cur)) targets.set(cur, []);
      continue;
    }
    if (!raw.startsWith("\t")) {
      cur = null;
      continue;
    }
    if (cur) targets.get(cur).push(raw);
  }
  return targets;
}

/**
 * How many scripts the CI workflows alone can reach. CI calls *targets*, not scripts
 * (`make lint` → `node scripts/…`), so a `make <target>` mention pulls in that target's
 * recipe lines before the usual script-to-script closure runs. Informational: it is what
 * turns "a target exists" into a fact about CI rather than a wish.
 */
export function ciReachable(dir = root, read = (p) => readFileSync(p, "utf8")) {
  const paths = shippedScripts(dir);
  const names = new Set(paths.map((p) => basename(p)));
  const ghFiles = executableRoots(dir).filter((p) => p !== MAKEFILE);
  const ghText = ghFiles.map((p) => {
    try {
      return read(p);
    } catch {
      return "";
    }
  }).join("\n");
  const targets = makeTargets(read(MAKEFILE));
  const seeds = new Set(edgeTargets(stripComments(ghText, "hash"), names, "\u0000"));
  for (const m of ghText.matchAll(/\bmake\s+([A-Za-z0-9_.\-]+)/g)) {
    for (const line of targets.get(m[1]) ?? []) {
      for (const o of edgeTargets(stripComments(line, "hash"), names, "\u0000")) seeds.add(o);
    }
  }
  return closure(paths.map((s) => join(dir, s)), names, read, seeds).wired.length;
}

/** The scan proper: read what is on disk, then close over it. `dead` entries are paths. */
export function scan(dir = root) {
  const paths = shippedScripts(dir);
  const names = new Set(paths.map((p) => basename(p)));
  const pathOf = new Map(paths.map((p) => [basename(p), p]));
  const { wired, dead } = closure(edgeSources(dir), names);
  return { total: paths.length, wired, dead: dead.map((n) => pathOf.get(n)) };
}
/**
 * The frontend surface's **forward** direction: every script path a `package.json` key
 * names must exist. `lint-inputs-scan` does this for the Makefile's steps; a key body is
 * the frontend's equivalent, and a stale one fails only when a human types it — several
 * keys (the manual/dev ones) are never typed by any shipped file or CI job, so a rename
 * could rot there forever. Returns findings `{ key, path }`.
 */
export function missingSurfaceReferences(pkgText, dir, exists = existsSync) {
  const out = [];
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return [{ key: "<package.json>", path: "(unparseable)" }];
  }
  const fe = join(dir, "crates", "amos-tauri", "frontend-ts");
  for (const [key, body] of Object.entries(pkg.scripts ?? {})) {
    for (const tok of String(body).split(/[\s;&|]+/)) {
      if (!/\.(mjs|js|cjs|sh)$/.test(tok)) continue;
      if (/^-/.test(tok)) continue; // a flag that happens to end in .js
      if (!exists(join(fe, tok))) out.push({ key, path: tok });
    }
  }
  return out;
}

/**
 * The frontend's `package.json` keys, split by **who can discover them**: `wired` = a
 * shipped file/CI job (or another wired key, via `bun run x`) names it; `manual` = only
 * `bun run <key>` reaches it. Informational, deliberately not a failure: a key is the
 * frontend's `make` target, and this repository does not require every target to be in CI
 * (`make android-app`, `make release-artifacts`, … are manual too). It is reported so the
 * manual surface is *visible* rather than implied.
 */
export function packageKeys(dir = root, read = (p) => readFileSync(p, "utf8")) {
  const pkgPath = join(dir, "crates", "amos-tauri", "frontend-ts", "package.json");
  if (!existsSync(pkgPath)) return { total: 0, wired: [], manual: [] };
  const pkg = JSON.parse(read(pkgPath));
  const scripts = pkg.scripts ?? {};
  const keys = Object.keys(scripts);
  // The frontend's own scripts are the *implementations* of these keys: a script that
  // documents `bun run <key>` in its header is self-documentation, not an independent
  // caller (the same self-loop the REQ-A189 negative control exposed for scripts), so it
  // does not count as "wired".
  const external = edgeSources(dir)
    .filter((p) => p !== pkgPath && !p.includes("/frontend-ts/scripts/"))
    .map((p) => {
      try {
        return read(p);
      } catch {
        return "";
      }
    })
    .join("\n");
  const wired = new Set();
  const queue = keys.filter((k) => new RegExp(`\\bbun\\s+run\\s+${k.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`).test(external));
  for (const k of queue) wired.add(k);
  while (queue.length) {
    const k = queue.shift();
    for (const m of String(scripts[k]).matchAll(/\bbun\s+run\s+([A-Za-z0-9:_-]+)/g)) {
      if (scripts[m[1]] && !wired.has(m[1])) (wired.add(m[1]), queue.push(m[1]));
    }
  }
  return {
    total: keys.length,
    wired: [...wired].sort(),
    manual: keys.filter((k) => !wired.has(k)).sort(),
  };
}



function runSelfTest() {
  const cases = [];
  const check = (name, ok) => cases.push([name, ok]);
  const names = new Set(["a.sh", "b.sh", "c.sh", "deploy.sh"]);

  check("`bash scripts/x.sh` is an edge", edgeTargets("\tbash scripts/a.sh\n", names, "\u0000").has("a.sh"));
  check(
    "`./scripts/x.sh` and `$(ROOT)/scripts/x.sh` are edges",
    edgeTargets("./scripts/b.sh && $(ROOT)/scripts/c.sh\n", names, "\u0000").size === 2,
  );
  check("a bare `deploy.sh` step is an edge", edgeTargets("\t./deploy.sh doctor\n", names, "\u0000").has("deploy.sh"));
  check("a script never names itself", !edgeTargets("bash scripts/a.sh\n", names, "a.sh").has("a.sh"));
  check("unrelated tokens are ignored", edgeTargets("cargo test --test a_thing\n", names, "\u0000").size === 0);

  const read = (p) =>
    ({
      "/mk": "\tbash scripts/a.sh\n",
      "/gh/wf.yml": "\tbash scripts/deploy.sh\n",
      "/scripts/a.sh": "\n",
      "/scripts/b.sh": "\n",
      "/scripts/c.sh": "\n",
    })[p] ?? "";

  const cl = closure(["/mk", "/gh/wf.yml", "/scripts/a.sh", "/scripts/b.sh"], names, read);
  check("a Makefile edge wires a script", cl.wired.includes("a.sh"));
  check("a CI edge wires a script", cl.wired.includes("deploy.sh"));
  check("an unmentioned script is dead", cl.dead.includes("c.sh"));

  const chained = closure(
    ["/mk", "/scripts/a.sh", "/scripts/b.sh"],
    names,
    (p) => ({ "/mk": "\tbash scripts/a.sh\n", "/scripts/a.sh": "\tbash scripts/b.sh\n" })[p] ?? "",
  );
  check("edges chain transitively (a → b)", chained.wired.includes("b.sh"));

  const orphanChain = closure(
    ["/mk", "/scripts/a.sh", "/scripts/b.sh"],
    names,
    (p) => ({ "/scripts/a.sh": "\tbash scripts/b.sh\n" })[p] ?? "",
  );
  check(
    "a script mentioned only by a dead script stays dead",
    orphanChain.dead.includes("a.sh") && orphanChain.dead.includes("b.sh"),
  );

  const mkText = [
    "lint:",
    "\tnode scripts/a.mjs",
    "\t# a comment line",
    "run:",
    "\tbash scripts/b.sh",
    "clean:",
    "\trm -rf target",
  ].join("\n");
  const tg = makeTargets(mkText);
  check(
    "recipes are keyed by target",
    tg.get("lint")?.[0]?.includes("scripts/a.mjs") && tg.get("run")?.[0]?.includes("scripts/b.sh"),
  );
  check("a recipe comment does not end the target", (tg.get("lint") ?? []).length === 2);

  const seeded = closure(
    ["/scripts/a.sh", "/scripts/b.sh", "/scripts/c.sh"],
    names,
    (p) => ({ "/scripts/a.sh": "\tbash scripts/b.sh\n" })[p] ?? "",
    new Set(["a.sh"]),
  );
  check(
    "seeds replace root derivation and still chain (CI → make → script)",
    seeded.wired.includes("a.sh") && seeded.wired.includes("b.sh") && seeded.dead.includes("c.sh"),
  );

  check(
    "a whole-line comment does not wire a script",
    edgeTargets(stripComments("# bash scripts/a.sh\n", "hash"), names, "\u0000").size === 0,
  );
  check(
    "a shell comment does not wire a script, the code next to it does",
    edgeTargets(stripComments("  # bash scripts/b.sh\nbash scripts/a.sh\n", "shell"), names, "\u0000").size === 1,
  );
  check(
    "JS comments do not wire a script",
    edgeTargets(stripComments("// bash scripts/a.sh\n/* bash scripts/b.sh */\n", "js"), names, "\u0000").size === 0,
  );
  check(
    "code survives a trailing comment",
    edgeTargets(stripComments("bash scripts/a.sh # was: scripts/b.sh\n", "shell"), names, "\u0000").has("a.sh"),
  );

  const pkgText = JSON.stringify({
    scripts: {
      test: "node scripts/bun-iso-test.mjs test",
      check: "bun run test && bun run typecheck",
      typecheck: "tsc --noEmit",
      "smoke:ui": "bun scripts/missing-ui.mjs",
      watch: "bun test --watch",
    },
  });
  const missing = missingSurfaceReferences(pkgText, "/repo", (p) => !p.endsWith("missing-ui.mjs"));
  check(
    "a key naming a missing script is a finding",
    missing.length === 1 && missing[0].key === "smoke:ui" && missing[0].path === "scripts/missing-ui.mjs",
  );
  check(
    "a key naming an existing script is not",
    !missing.some((m) => m.path.includes("bun-iso-test")),
  );
  check(
    "an unparseable package.json is a finding, not a crash",
    missingSurfaceReferences("{ nope", "/repo").length === 1,
  );

  const feRoots = executableRoots();
  check(
    "the frontend package.json is an edge source (a second command surface)",
    feRoots.some((p) => p.endsWith("frontend-ts/package.json")),
  );

  let failed = 0;
  for (const [name, ok] of cases) {
    if (ok) console.log(`  [ok] ${name}`);
    else {
      failed++;
      console.log(`  [FAIL] ${name}`);
    }
  }
  if (failed > 0) {
    console.log(`[unwired-script-scan] selftest FAILED (${failed}/${cases.length}).`);
    process.exit(1);
  }
  console.log(`[unwired-script-scan] selftest OK — ${cases.length} tokenizer/closure case(s).`);
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  runSelfTest();
  process.exit(0);
}

const result = scan();
const allow = existsSync(ALLOWLIST)
  ? (JSON.parse(readFileSync(ALLOWLIST, "utf8")).entries ?? {})
  : {};
const unwired = result.dead.filter((p) => !(p in allow));
const stale = Object.keys(allow).filter((p) => !result.dead.includes(p));
const viaCi = ciReachable();
const keys = packageKeys();
const brokenKeys = existsSync(FE_PKG)
  ? missingSurfaceReferences(readFileSync(FE_PKG, "utf8"), root)
  : [];

if (args.includes("--json")) {
  console.log(JSON.stringify({ ...result, viaCi, unwired, stale, keys, brokenKeys }, null, 2));
  process.exit(
    unwired.length === 0 && stale.length === 0 && brokenKeys.length === 0 ? 0 : 1,
  );
}

for (const b of brokenKeys) {
  console.log(`  broken key: \`bun run ${b.key}\` names ${b.path}, which does not exist`);
}
for (const p of unwired) {
  console.log(`  unwired: ${p} — the Makefile, .github/, the frontend command surface and every reachable script never name it`);
}
for (const p of stale) console.log(`  stale allow-list entry: ${p} (no longer unwired)`);
if (unwired.length > 0 || stale.length > 0 || brokenKeys.length > 0) {
  console.log(
    `[unwired-script-scan] FAIL — ${brokenKeys.length} frontend key(s) name a file that does not exist, ` +
      `${unwired.length} of ${result.total} script(s) nothing runs` +
      `${stale.length > 0 ? `, ${stale.length} stale allow-list entry(ies)` : ""}. ` +
      "Wire it (a Makefile target is the normal fix), delete it, or record the reason in " +
      "scripts/script-allowlist.json.",
  );
  process.exit(1);
}
console.log(
  `[unwired-script-scan] OK — all ${result.total} script(s) are reachable from the Makefile, ` +
    `.github/, the frontend command surface or a reachable script (${viaCi} of them also from the ` +
    `CI workflows; frontend \`package.json\`: ${keys.total} key(s), ${keys.manual.length} reachable ` +
    `only via \`bun run\`).`,
);

