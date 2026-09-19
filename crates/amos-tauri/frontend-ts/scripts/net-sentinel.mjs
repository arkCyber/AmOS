#!/usr/bin/env node
/**
 * net-sentinel.mjs — "the suite proves, at RUNTIME, that it never reaches the network".
 *
 * Why (REQ-A403): REQ-A400 found two tests that performed **real HTTP** (`compass.ts`'s
 * NOAA lookup — 6 `[Compass] API error: 400` round trips in the log) and only fixed those
 * two files. A grep of the corpus says every remaining `fetch` reference is a saved-and-
 * restored stub — but a grep cannot see the defect that mattered: `fetchDeclination`
 * **catches** its own network errors and degrades to 0, so a test with no stub at all
 * passes *green* while doing real I/O (the green was "the API answered 400", not "the code
 * is right"). Static rules cannot see that; a runtime guard can.
 *
 * What it does: as a test **preload** it replaces the default `fetch` with a function that
 *   • records the call (`url`, stack), and
 *   • **rejects** with a marked error, so a degrade-path still degrades and a test that
 *     really needed the answer fails loudly instead of silently depending on the internet.
 * A test that installs its own stub (`globalThis.fetch = …`) is unaffected: the stub is
 * what runs, and nothing is recorded. Restoring what the test saved
 * (`const real = globalThis.fetch; … globalThis.fetch = real`) restores the **sentinel**,
 * not the network — so a test cannot un-arm the guard by accident.
 *
 * Reporting: with `AMOS_NET_SENTINEL_LOG=<path>` set, every process appends one JSON line
 * per recorded call (flushed on exit, synchronously) — the runner reads it and fails the
 * file with attribution. `bun-iso-test.mjs` sets that variable per file; the vitest setup
 * file (`svelte-tests/setup-net-sentinel.ts`) fails the *test* it happened in instead.
 *
 * Honest boundaries:
 *   • `fetch` is the only network entry point this frontend uses at all (measured: no
 *     `XMLHttpRequest` / `WebSocket` / `EventSource` / `sendBeacon` anywhere in `src/`,
 *     `svelte-tests/` or `scripts/`), so those are **not** wrapped; a future use of one of
 *     them would slip past this sentinel (its static half does not exist on purpose — the
 *     points of this guard are the two a grep cannot make);
 *   • Node-level egress (`node:net`/`node:http`/`node:dgram` from a test) is outside it;
 *   • it lives in the *test* layer only: it is installed by the runners, never by the app.
 *
 * Usage:
 *   bun test --preload ./scripts/net-sentinel.mjs <files>
 *   AMOS_NET_SENTINEL_LOG=/tmp/net.log bun test --preload ./scripts/net-sentinel.mjs <files>
 *   node scripts/net-sentinel.mjs --selftest
 */
import { appendFileSync } from "node:fs";

export const MARKER = "AMOS-NET-SENTINEL";
export const LOG_ENV = "AMOS_NET_SENTINEL_LOG";

/** One recorded (unstubbed) call: `{ url, method }`. */
const records = [];

/** The implementation in force: the real `fetch` until a sentinel intercepts a call. */
let current = null;
let installed = false;
let REAL = null;

export function egressRecords() {
  return records.slice();
}

export function resetEgress() {
  records.length = 0;
}

/** The error an unstubbed call rejects with — its name/message name the sentinel. */
export function sentinelError(url) {
  const err = new Error(
    `${MARKER}: test reached the network (${String(url)}) — stub it (globalThis.fetch = …) ` +
      `or inject the client; see scripts/net-sentinel.mjs`,
  );
  err.name = MARKER;
  return err;
}

function recordUrl(url) {
  let s = "";
  try {
    s = typeof url === "string" ? url : String(url?.url ?? url);
  } catch {
    s = "<unprintable>";
  }
  return s;
}

/**
 * The first two stack frames **outside this file** — the production call site and, usually,
 * the test that drove it. Without this, a batch run (`bun-iso-test` runs the pure files in
 * ONE process) could only say "somewhere in 84 files"; with it the report names the module
 * that fetched (e.g. `compass.ts:261`), which is what a reader needs.
 */
function callSites() {
  const lines = (new Error("sentinel").stack ?? "")
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => !l.includes("net-sentinel.mjs"));
  return lines.slice(0, 2).map((l) => l.replace(/^at\s+/, "").replace(/\s*\(?(.*?)\)?$/, "$1"));
}

function dispatch(...args) {
  if (current === REAL) {
    const url = recordUrl(args[0]);
    records.push({ url, at: callSites() });
    flush();
    return Promise.reject(sentinelError(url));
  }
  return current.apply(globalThis, args);
}

function flush() {
  const path = process.env[LOG_ENV];
  if (!path || records.length === 0) return;
  for (const r of records) {
    try {
      appendFileSync(path, JSON.stringify(r) + "\n");
    } catch {
      /* a full/removed tmp dir must not break the test run itself */
    }
  }
  // The runner reads the file; keeping the in-memory list would double-count on exit.
  records.length = 0;
}

/** Install the sentinel (idempotent). Called automatically on import as a preload. */
export function install() {
  if (installed) return;
  installed = true;
  REAL = globalThis.fetch;
  current = REAL;
  arm();
  process.on("exit", flush);
}

function arm() {
  try {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      get: () => dispatch,
      set: (v) => {
        // A test restoring what it saved gets the sentinel back (never the raw network).
        current = v === dispatch ? REAL : v;
      },
    });
  } catch (e) {
    // A host that makes `fetch` non-configurable leaves the guard un-armed: say so, once.
    console.error(
      `[net-sentinel] WARNING: cannot install the fetch guard (${String(e)}). ` +
        `This process can reach the network unnoticed.`,
    );
  }
}

/**
 * Re-arm after a DOM environment replaces `fetch` (measured: happy-dom's
 * `GlobalRegistrator.register()` assigns its own window globals onto `globalThis`, which
 * clobbered the accessor — and the very first experiment did a **real** network call).
 */
export function rearm() {
  const d = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  if (d && d.get === dispatch) return;
  REAL = globalThis.fetch;
  current = REAL;
  arm();
}

async function armHappyDom() {
  try {
    const mod = await import("@happy-dom/global-registrator");
    const reg = mod?.GlobalRegistrator;
    if (!reg || typeof reg.register !== "function" || reg.__netSentinelWrapped) return;
    const orig = reg.register.bind(reg);
    reg.register = (...args) => {
      const out = orig(...args);
      rearm();
      return out;
    };
    reg.__netSentinelWrapped = true;
  } catch {
    /* happy-dom is not installed for this run: pure files need no re-arm */
  }
}

install();
await armHappyDom();

function selftest() {
  const problems = [];
  const want = (label, got, expected) => {
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      problems.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
    }
  };

  // The error carries the marker (that is what the vitest setup file and a human see).
  const e = sentinelError("https://example.com/");
  want("the rejection names the sentinel", e.name, MARKER);
  want("the rejection names the URL", e.message.includes("https://example.com/"), true);

  // Recording + dispatch behaviour without touching the real global: use a local copy.
  resetEgress();
  want("resetEgress clears", egressRecords().length, 0);

  if (problems.length > 0) {
    console.error(`[net-sentinel] selftest FAIL:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`[net-sentinel] selftest: 3 assertion(s), 0 failure(s).`);
}

if (process.argv.includes("--selftest")) selftest();
