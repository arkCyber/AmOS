/**
 * setup-net-sentinel.ts — the **vitest** half of REQ-A403's runtime network guard.
 *
 * `svelte-tests/` runs under vitest with the happy-dom environment, whose globals are
 * installed *before* `setupFiles` run — so the sentinel is armed here (and re-armed by
 * `rearm()`, which exists because happy-dom's registration replaces `fetch`; measured: the
 * first experiment let a real call through). The bun half lives in `scripts/bun-iso-test.mjs`
 * (`--preload ./scripts/net-sentinel.mjs` + a per-file log file).
 *
 * Why the guard exists at all: `scripts/net-sentinel.mjs` explains it — a module that
 * catches its own network error and degrades makes an online test look **green**
 * (REQ-A400's `fetchDeclination`), and only a runtime recorder can see that.
 *
 * Attribution: vitest gives one worker per test file, and this hook runs after **every**
 * test, so a hit is named at test granularity and the record is cleared before the next.
 */
import { afterEach } from "vitest";
import { egressRecords, install, rearm, resetEgress } from "../scripts/net-sentinel.mjs";

install();
rearm();

afterEach(() => {
  const hits = egressRecords();
  resetEgress();
  if (hits.length > 0) {
    const where = hits
      .map((h) => `${h.url}${h.at && h.at.length > 0 ? ` (at ${h.at.join(" ← ")})` : ""}`)
      .join("; ");
    throw new Error(
      `net-sentinel: this test reached the network — ${where}. ` +
        `Stub it (globalThis.fetch = …) or inject the client; see scripts/net-sentinel.mjs.`,
    );
  }
});
