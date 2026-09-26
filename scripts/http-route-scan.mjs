#!/usr/bin/env node
/**
 * http-route-scan.mjs — the two sides of the HTTP contract must agree: **an `/api/…` path the
 * UI calls must exist as a route on the server that answers it, and the method it uses must be
 * one that route accepts.**
 *
 * Why (REQ-A507, measured 2026-09-19): `lib/enterprise/*.ts` is a real HTTP client —
 * `templateManager.syncTemplates()` posts to `/api/templates/sync`, `auditLogger`'s sync posts
 * to `/api/audit/sync` — and `crates/amos-mdm` is a real server with device/admin routes and
 * end-to-end tests. **Two of those three endpoint paths do not exist on the server** (it routes
 * `/api/mdm/*` and `/api/admin/*` only). Nothing in this repository compared the two lists:
 * `tauri-args-scan` / `tauri-reply-scan` guard the Tauri *bridge*, and there was no equivalent
 * for HTTP. A client that posts to a 404 is the "declared but not real" shape this audit keeps
 * finding — and here the client's own tests pass, because they assert what the *client* does
 * with a mocked reply, never that the endpoint is served.
 *
 * REQ-A508 closed the other half of the same question: **the method**. A client that calls a
 * routed path with the wrong verb gets a 405, which is just as invisible (the path exists, so
 * the path rule says nothing). Measured before adding it: **0 mismatches** in the corpus (all
 * three served calls are POST against POST routes), so the rule went in strict — see below.
 *
 * What it reads (two corpora, both static):
 *   • **client** — `crates/amos-tauri/frontend-ts/src/**\/*.{ts,svelte}` (production only):
 *     a **relative** path from a template literal (`` `${base}/api/…` ``) or a `fetch("/api/…")`
 *     literal. Absolute URLs are out of scope by construction: a favicon service or a
 *     user-configured AI endpoint is not a route this repo owns. The **method** is read from the
 *     same call expression (`method: "POST"` within the next 400 characters); when it is not
 *     written there it stays *unreadable* and no method claim is made about it.
 *   • **server** — every `.route("…", <verb>(…))` pair under `crates/` (axum), i.e. the route
 *     table the host actually wires, including the multi-line `.route(\n "…",\n post(…))` form.
 *
 * Scope, measured rather than assumed: the rule looks at **`/api/*`** only. The first draft read
 * every relative path and produced three false positives — `/apps.json`, `/incoming.mp3`,
 * `/ringback.mp3` — which are **static assets served by the UI's own origin** (Vite in dev, the
 * bundled `dist/` in release), not axum routes. Keeping the rule narrow is the difference
 * between a gate and a list nobody reads.
 *
 * Failure modes (the repository's ratchet rule):
 *   • an `/api/*` path with no route **fails** unless it is declared in
 *     `scripts/http-route-allowlist.json` with a non-empty `reason`;
 *   • an allow-listed path that *is* served now **also fails** (an exemption nobody prunes hides
 *     the next real gap — the same rule `unwired-scan` and `i18n-scan` follow);
 *   • a **method mismatch** is a **hard failure with no exemption**: a 405 is never a decision
 *     somebody makes on purpose, so there is nothing to declare. (If that ever stops being true,
 *     the exemption mechanism is two lines away — and adding it then is the honest order.)
 *
 * Usage:
 *   node scripts/http-route-scan.mjs             # gate (non-zero on a new/invalid gap)
 *   node scripts/http-route-scan.mjs --json      # machine-readable report
 *   node scripts/http-route-scan.mjs --selftest  # pin the extractors + the matchers
 *
 * Exit codes: 0 ok · 1 an undeclared/stale gap or a method mismatch · 2 an allow-list entry
 * without a reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_ROOT = path.join(ROOT, 'crates/amos-tauri/frontend-ts/src');
const SERVER_ROOT = path.join(ROOT, 'crates');
const ALLOW_PATH = path.join(ROOT, 'scripts', 'http-route-allowlist.json');
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', '.git', 'archive']);

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const isTestPath = (p) => /(\.test\.|\.spec\.|\/__tests__\/|\/svelte-tests\/)/.test(p);

/** Relative API paths a production frontend file calls. */
export function clientPaths(src) {
  const out = new Set();
  for (const m of src.matchAll(/`\$\{[^}]+\}(\/[A-Za-z0-9/_.-]*)`/g)) out.add(m[1]);
  for (const m of src.matchAll(/fetch\(\s*[`"'](\/[A-Za-z0-9/_.-]+)[`"']/g)) out.add(m[1]);
  return [...out];
}

/**
 * A client call: the path **and** the method written next to it (REQ-A508).
 *
 * The method is read from the same call expression — `method: "POST"` within the next 400
 * characters after the URL. That is how every call in this corpus is written (`fetch(url, {
 * method: … })` or a helper taking `{ method: … }`); when it is absent (a helper that defaults,
 * or a URL built at runtime) the method is left `null` and **no claim is made about it** rather
 * than guessing `GET`, because a wrong claim is worse than a missing one.
 */
export function clientCalls(src) {
  const out = [];
  const push = (path, at) => {
    const after = src.slice(at, at + 400);
    const m = /method\s*:\s*["']([A-Za-z]+)["']/.exec(after);
    out.push({ path, method: m ? m[1].toUpperCase() : null });
  };
  for (const m of src.matchAll(/`\$\{[^}]+\}(\/[A-Za-z0-9/_.-]*)`/g)) push(m[1], m.index + m[0].length);
  for (const m of src.matchAll(/fetch\(\s*[`"'](\/[A-Za-z0-9/_.-]+)[`"']/g)) push(m[1], m.index + m[0].length);
  return out;
}

/** Route literals a Rust file wires (axum `.route("…")`). */
export function serverRoutes(src) {
  const out = new Set();
  for (const m of src.matchAll(/\.route\(\s*"([^"]+)"/g)) out.add(m[1]);
  return [...out];
}

/**
 * The **methods** each route accepts: `.route("path", <verb>(handler))`, including the
 * multi-line `.route(\n "path",\n post(…))` form (hence the `s` flag and `\s*`).
 */
export function serverRouteMethods(src) {
  const out = new Map();
  for (const m of src.matchAll(/\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|delete|patch)\s*\(/gs)) {
    if (!out.has(m[1])) out.set(m[1], new Set());
    out.get(m[1]).add(m[2].toUpperCase());
  }
  return out;
}

/**
 * Compare by **segment shape**: axum's `:param` and a client's literal segment are the same
 * route. (`/api/mdm/commands/:id/ack` serves `/api/mdm/commands/42/ack`.)
 */
export function normalizeRoute(p) {
  return p
    .split('/')
    .map((seg) => (seg.startsWith(':') || (seg.startsWith('{') && seg.endsWith('}')) ? ':' : seg))
    .join('/');
}

/** An `/api/*` path with no matching route. */
export function missingRoutes(client, routes) {
  const served = new Set(routes.map(normalizeRoute));
  return client.filter((p) => p.startsWith('/api/') && !served.has(normalizeRoute(p)));
}

/**
 * Client calls whose **method** the serving route does not accept (REQ-A508).
 *
 * Only *provable* claims are reported: a call with no readable method is skipped (see
 * `clientCalls`), and a path with no route at all is the other rule's business.
 */
export function methodMismatches(client, serverMethodsByPath) {
  const accepted = new Map();
  for (const [path, methods] of serverMethodsByPath) {
    const key = normalizeRoute(path);
    if (!accepted.has(key)) accepted.set(key, new Set());
    for (const m of methods) accepted.get(key).add(m);
  }
  const out = [];
  for (const { path, method } of client) {
    if (method === null || !path.startsWith('/api/')) continue;
    const set = accepted.get(normalizeRoute(path));
    if (!set) continue;
    if (!set.has(method)) out.push({ path, method, accepted: [...set].sort() });
  }
  return out;
}

// --- selftest: the two extractors and the matcher, both directions -------------------------
function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const c1 = clientPaths("const u = `${base}/api/mdm/sync`;");
  ok('a template-literal path is read', c1.includes('/api/mdm/sync'));
  const c2 = clientPaths('await fetch("/api/audit/sync", { method: "POST" });');
  ok('a fetch literal path is read', c2.includes('/api/audit/sync'));
  ok('an absolute URL is not a route', clientPaths('fetch("https://example.com/api/x")').length === 0);
  ok('a user-configured base is not a route', clientPaths('`${cfg.baseUrl}${path}`').length === 0);

  const r = serverRoutes('.route("/api/mdm/enroll", post(h))');
  ok('a route literal is read', r.includes('/api/mdm/enroll'));
  ok('a non-route string is not read', serverRoutes('let s = "/api/x";').length === 0);

  ok('a param segment matches a literal one', normalizeRoute('/api/admin/policies/:id') === '/api/admin/policies/:');
  ok('an axum brace param matches too', normalizeRoute('/api/x/{id}') === '/api/x/:');
  ok('a served path is not reported', missingRoutes(['/api/mdm/sync'], ['/api/mdm/sync']).length === 0);
  ok('an unserved /api path IS reported', missingRoutes(['/api/templates/sync'], ['/api/mdm/sync']).length === 1);
  ok('a static asset path is out of scope', missingRoutes(['/incoming.mp3', '/apps.json'], []).length === 0);

  // REQ-A508 — the method half.
  const m1 = serverRouteMethods('.route("/api/mdm/enroll", post(h))');
  ok('a single-line route method is read', m1.get('/api/mdm/enroll')?.has('POST') === true);
  const m2 = serverRouteMethods('.route(\n  "/api/admin/policies",\n  post(h),\n)');
  ok('a multi-line route method is read', m2.get('/api/admin/policies')?.has('POST') === true);
  const m3 = serverRouteMethods('.route("/api/admin/policies", get(a))\n.route("/api/admin/policies", post(b))');
  ok('two verbs on one path are both kept', m3.get('/api/admin/policies')?.size === 2);
  ok('a route with no verb call is not invented', serverRouteMethods('.route("/api/x", fallback())').size === 0);

  const c3 = clientCalls('await fetch(`${b}/api/mdm/sync`, { method: "POST", body });');
  ok('the method beside the URL is read', c3[0]?.method === 'POST');
  ok('a normalised verb is upper-cased', clientCalls('fetch(`${b}/api/x`, { method: "post" })')[0]?.method === 'POST');
  ok(
    'a call with no written method claims nothing',
    clientCalls('fetch(`${b}/api/x`)')[0]?.method === null,
  );

  const served = serverRouteMethods('.route("/api/mdm/enroll", post(h))');
  ok(
    'a matching method is not reported',
    methodMismatches([{ path: '/api/mdm/enroll', method: 'POST' }], served).length === 0,
  );
  ok(
    'a wrong verb IS reported (405 shape)',
    methodMismatches([{ path: '/api/mdm/enroll', method: 'GET' }], served).length === 1,
  );
  ok(
    'an unreadable method is never reported',
    methodMismatches([{ path: '/api/mdm/enroll', method: null }], served).length === 0,
  );
  ok(
    'a path with no route is left to the other rule',
    methodMismatches([{ path: '/api/templates/sync', method: 'POST' }], served).length === 0,
  );
  ok(
    'either verb passes when the route accepts both',
    methodMismatches(
      [{ path: '/api/p', method: 'GET' }, { path: '/api/p', method: 'POST' }],
      serverRouteMethods('.route("/api/p", get(a))\n.route("/api/p", post(b))'),
    ).length === 0,
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[http-route-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[http-route-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}
if (process.argv.includes('--selftest')) runSelftest();

// --- scan ----------------------------------------------------------------------------------
const clientByPath = new Map();
const calls = [];
for (const f of walk(CLIENT_ROOT).filter((p) => /\.(ts|svelte)$/.test(p) && !isTestPath(p))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const c of clientCalls(src)) {
    calls.push(c);
    if (!clientByPath.has(c.path)) clientByPath.set(c.path, []);
    clientByPath.get(c.path).push(path.relative(ROOT, f));
  }
}
const routes = new Set();
const serverMethods = new Map();
for (const f of walk(SERVER_ROOT).filter((p) => p.endsWith('.rs'))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const r of serverRoutes(src)) routes.add(r);
  for (const [p, methods] of serverRouteMethods(src)) {
    if (!serverMethods.has(p)) serverMethods.set(p, new Set());
    for (const m of methods) serverMethods.get(p).add(m);
  }
}

let allow = [];
if (fs.existsSync(ALLOW_PATH)) {
  allow = JSON.parse(fs.readFileSync(ALLOW_PATH, 'utf8'));
  for (const e of allow) {
    if (!e.path || !e.reason || !String(e.reason).trim()) {
      console.error(`[http-route-scan] allow-entry without path+reason: ${JSON.stringify(e)}`);
      process.exit(2);
    }
  }
}
const allowed = new Map(allow.map((e) => [e.path, e.reason]));

const missing = missingRoutes([...clientByPath.keys()], [...routes]);
const undeclared = missing.filter((p) => !allowed.has(p));
const stale = [...allowed.keys()].filter((p) => !missing.includes(p));
const mismatches = methodMismatches(calls, serverMethods);

if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        clientPaths: [...clientByPath.keys()].sort(),
        clientCalls: calls,
        serverRoutes: [...routes].sort(),
        serverMethods: Object.fromEntries(
          [...serverMethods].map(([p, s]) => [p, [...s].sort()]),
        ),
        missing,
        undeclared,
        stale,
        methodMismatches: mismatches,
        allowlisted: [...allowed].map(([p]) => p).sort(),
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `[http-route-scan] ${clientByPath.size} client relative path(s), ${routes.size} server route literal(s), ` +
      `${missing.length} /api path(s) with no route (${allow.length} allow-listed), ` +
      `${mismatches.length} method mismatch(es).`,
  );
  for (const p of missing) {
    const why = allowed.get(p);
    console.log(`  ${why ? 'excused ' : 'MISSING '} ${p}  <- ${clientByPath.get(p).join(', ')}`);
    if (why) console.log(`           reason: ${why}`);
  }
  for (const m of mismatches) {
    console.log(`  VERB     ${m.path}  client sends ${m.method}, the route accepts ${m.accepted.join('/')}`);
  }
  if (undeclared.length > 0) {
    console.error(
      `[http-route-scan] FAIL — ${undeclared.length} /api path(s) the UI calls are served by no route: ` +
        undeclared.join(', ') +
        ' (implement the route, stop calling it, or declare it in scripts/http-route-allowlist.json with a reason).',
    );
  }
  if (stale.length > 0) {
    console.error(
      `[http-route-scan] FAIL — ${stale.length} allow-list entr(y/ies) no longer name a gap (the route is served now): ` +
        stale.join(', ') +
        ' (delete the entry — an exemption nobody prunes hides the next real gap).',
    );
  }
  if (mismatches.length > 0) {
    console.error(
      `[http-route-scan] FAIL — ${mismatches.length} call(s) use a method the route does not accept (a 405 at runtime, ` +
        'and nothing to declare: a wrong verb is never a decision).',
    );
  }
  if (undeclared.length === 0 && stale.length === 0 && mismatches.length === 0) {
    console.log(
      '[http-route-scan] OK — every /api path the UI calls is routed (or declared with a reason), and every method it names is accepted.',
    );
  }
}
process.exit(undeclared.length === 0 && stale.length === 0 && mismatches.length === 0 ? 0 : 1);
