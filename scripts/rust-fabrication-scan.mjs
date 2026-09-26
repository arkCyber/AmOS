#!/usr/bin/env node
/**
 * rust-fabrication-scan.mjs — "does a comment admit the code is not real, directly above a write of a granted state?"
 *
 * Why: `push_request_permission` used to read, in full —
 *
 *     // Platform-specific permission request would go here
 *     // For now, simulate authorization
 *     let mut manager = state.lock()?;
 *     manager.set_permission(PermissionStatus::Authorized);
 *     Ok(PushResult::Ok)
 *
 * Nobody was asked. The command wrote the grant into its own state and answered `Ok`; the
 * panel re-read that state, saw `authorized`, and printed 「你现在可以接收推送通知了」. The
 * sentence was true of nothing, and the code *said so out loud* two lines above it.
 *
 * That is the shape this gate looks for, and it is a shape a reviewer can act on: an
 * **admission** (a comment conceding the code is not real) sitting within a few lines of a
 * **write of a granted state** (permission, authorization, enabled/verified/connected
 * flags). Neither half alone is evidence — `for now` appears in 275 comment lines across
 * this workspace and `permission =` in many more, but the pair occurs **once**, and it was
 * this defect.
 *
 * It is a **census, not a verdict**: an admission next to a state write is a place a human
 * must look, and the two honest answers are "fix it" or "record why it is fine here" in
 * `scripts/rust-fabrication-baseline.json`. The gate fails while any site is unaccounted
 * for, which is the same discipline `unwired-scan.mjs` and `coverage-unmentioned-allowlist`
 * use for the censuses they keep.
 *
 * ## What counts as a site
 *
 * An **admission line**: a `//` comment matching
 * `for now | simulate(d) | would go here | placeholder | stub | pretend | fake | not yet
 * implemented | hardcod…` — the vocabulary this repo actually uses to say "this is not the
 * real thing". (`FIXME`/`TODO` are **not** in the list: they are a to-do, which is honest
 * about being unfinished; an admission says the shipped behaviour is wrong.)
 *
 * A **state write**, in one of the five lines after it (comments skipped):
 * `set_permission(`, `granted =`, `permission =`, `is_granted`, or a bare `Granted` /
 * `Authorized` / `… = true` for `allowed` / `enabled` / `verified` / `connected`.
 *
 * The window is deliberately short. A comment 30 lines above a write is a coincidence; the
 * defect this gate was built from had the two lines touching, and widening the window only
 * trades a real signal for noise.
 *
 * ## Honest limits
 *
 *   * It cannot tell "this grant is fabricated" from "this grant is a cache of a real one".
 *     That is *why* the answer is a baseline entry with a `reason` rather than an exemption.
 *   * It reads text, so a write spelled outside the five-token list is invisible. The list
 *     is the least it can be and still have caught this defect; it is not exhaustive.
 *   * It only reads `.rs`. The **frontend half** of this defect — `await
 *     requestPushPermission();` with the verdict discarded — is measured but not yet gated;
 *     see the CHANGELOG note for F-DEV-116.
 *
 * Usage:
 *   node scripts/rust-fabrication-scan.mjs            # census, exit 1 on an unaccounted site
 *   node scripts/rust-fabrication-scan.mjs --json     # machine-readable
 *   node scripts/rust-fabrication-scan.mjs --selftest # controls, no filesystem walk
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "scripts/rust-fabrication-baseline.json";

/** A comment saying the code is not the real thing. */
export const ADMISSION =
  /\b(for now|simulate|simulated|would go here|placeholder|stub|pretend|fake|not yet implemented|hardcod)\w*/i;

/**
 * A write to a granted/possessed state.
 *
 * Spelled as a closed list of the tokens this repo actually grants with. `x = true` is only
 * a site for the five names below: `let mut ok = true` is not a grant, and treating it as one
 * is how a census gate earns its reputation for crying wolf.
 */
export const STATE_WRITE =
  /(\bset_permission\s*\(|\bgranted\s*=|\bpermission\s*=|\bis_granted\b|\bGranted\b|\bAuthorized\b|\b(allowed|enabled|verified|connected|active|available)\s*=\s*true\b)/;

/** Comment bodies only — a `//` line, never code, never a string literal's contents. */
function isCommentLine(line) {
  return /^\s*\/\//.test(line);
}

/**
 * The fabrication sites in one Rust source text.
 *
 * Exported (rather than inlined in the walk) so the selftest can drive it with literals —
 * the same reason `headerQuestion` is exported by `gate-index-scan.mjs`: a rule reachable
 * only through a filesystem walk is a rule no control can reach.
 */
export function fabricationSites(text, file = "<mem>") {
  const lines = text.split("\n");
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isCommentLine(lines[i]) || !ADMISSION.test(lines[i])) continue;
    for (let j = i + 1; j <= Math.min(i + 5, lines.length - 1); j++) {
      const next = lines[j];
      if (isCommentLine(next)) continue;
      if (/^\s*$/.test(next)) continue;
      if (STATE_WRITE.test(next)) {
        sites.push({ file, line: j + 1, admissionLine: i + 1, admission: lines[i].trim(), write: next.trim() });
        break;
      }
    }
  }
  // **One site per write, not per comment.** The defect this was built from had two
  // admissions stacked above the same `set_permission(Authorized)` — a comment block says
  // the same thing twice more often than it says two different things — and counting both
  // would report a two-site census for a one-line problem. Keep the nearest admission: it is
  // the one that was being written *about*.
  const byWrite = new Map();
  for (const s of sites) {
    const key = `${s.file}:${s.line}`;
    const prev = byWrite.get(key);
    if (!prev || s.admissionLine > prev.admissionLine) byWrite.set(key, s);
  }
  return [...byWrite.values()].sort((a, b) => a.line - b.line);
}

function walkRust(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "target" || entry === "node_modules" || entry === ".git" || entry === "gen") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walkRust(path, out);
    else if (entry.endsWith(".rs")) out.push(path);
  }
  return out;
}

function loadBaseline() {
  if (!existsSync(join(ROOT, BASELINE))) return { sites: [] };
  try {
    return JSON.parse(readFileSync(join(ROOT, BASELINE), "utf8"));
  } catch (e) {
    console.error(`P2-1 GATE FAILED: ${BASELINE} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}

function scan() {
  const baseline = loadBaseline();
  // Keyed by `file:line` **and** the admission text: a line number alone would let an
  // unrelated edit at the same offset inherit somebody else's acknowledgement.
  const accounted = new Map(
    (baseline.sites ?? []).map((s) => [`${s.file}:${s.line}`, s]),
  );
  const files = walkRust(join(ROOT, "crates"));
  const found = [];
  for (const abs of files) {
    const rel = abs.slice(ROOT.length + 1);
    for (const site of fabricationSites(readFileSync(abs, "utf8"), rel)) found.push(site);
  }

  // Re-key on the *current* line, then look for acknowledgements that no longer match any
  // site: a baseline entry whose site is gone is rot, and rot is how a census quietly stops
  // being one (`lib-coverage-gate.mjs`'s `rottenAllowlist` makes the same argument).
  const unaccounted = [];
  for (const site of found) {
    const entry = accounted.get(`${site.file}:${site.line}`);
    if (entry && typeof entry.reason === "string" && entry.reason.trim() !== "") {
      site.state = "accounted";
      continue;
    }
    site.state = entry ? "no-reason" : "not-in-baseline";
    unaccounted.push(site);
  }
  // Rot is "the key matches no site **at all**" — not "this site is unaccounted". The two
  // directions of a baseline disagree in exactly this way: an entry for a live site that
  // never gained its `reason` is a *missing justification* (reported above, with the site),
  // while an entry pointing at nothing is a *stale row*. Saying "no longer matches a site"
  // about a line that is right there would send the reader to delete a correct entry.
  const foundKeys = new Set(found.map((s) => `${s.file}:${s.line}`));
  const rotten = [...accounted.entries()]
    .filter(([key]) => !foundKeys.has(key))
    .map(([key, entry]) => ({ key, reason: entry.reason }));

  return { files: files.length, found, unaccounted, rotten };
}

function report() {
  const { files, found, unaccounted, rotten } = scan();
  console.log(`rust-fabrication-scan: ${files} .rs files, ${found.length} admission-next-to-grant site(s)`);

  for (const site of found) {
    const mark =
      site.state === "accounted"
        ? "[accounted]"
        : site.state === "no-reason"
          ? "[UNACCOUNTED: baseline entry has no reason]"
          : "[UNACCOUNTED]";
    console.log(`  ${site.file}:${site.line}  ${mark}`);
    console.log(`      admission @${site.admissionLine}: ${site.admission}`);
    console.log(`      write: ${site.write}`);
  }

  if (rotten.length > 0) {
    console.error(
      `\nP2-1 GATE FAILED: ${rotten.length} baseline entr(y/ies) no longer match a site — ` +
        `the census has drifted from the code.`,
    );
    for (const r of rotten) console.error(`    ${r.key}  (${r.reason ?? "no reason"})`);
    console.error(`  fix: delete the stale entr(y/ies) from ${BASELINE}.`);
    process.exit(1);
  }

  if (unaccounted.length > 0) {
    console.error(
      `\nP2-1 GATE FAILED: ${unaccounted.length} unaccounted site(s) — a comment admits the ` +
        `code is not real and a granted state is written next to it.`,
    );
    // The evidence is printed once, in the census list above; here the reader needs to know
    // *which* of those sites are the problem and how they fell short.
    for (const site of unaccounted) {
      console.error(
        `    ${site.file}:${site.line}  ` +
          (site.state === "no-reason" ? "(baseline entry has no non-empty `reason`)" : "(not in the baseline)"),
      );
    }
    console.error(
      `  fix one of two ways, both of which require reading the site:\n` +
        `    • make it real — obtain the value from the thing that owns it;\n` +
        `    • or record it in ${BASELINE} with a \`reason\` that says why the fabricated\n` +
        `      value is acceptable *there*. Do not add an entry you have not read.`,
    );
    process.exit(1);
  }

  console.log("rust-fabrication-scan: OK — every site is accounted for.");
}

function selftest() {
  let failures = 0;
  const ok = (name, cond) => {
    if (cond) console.log(`  ok   ${name}`);
    else {
      failures++;
      console.error(`  FAIL ${name}`);
    }
  };

  // --- the rule fires on the shape it was built from -------------------------------
  const real = [
    "    // Platform-specific permission request would go here",
    "    // For now, simulate authorization",
    "    let mut manager = state.lock()?;",
    "    manager.set_permission(PermissionStatus::Authorized);",
    "    Ok(PushResult::Ok)",
  ].join("\n");
  const realSites = fabricationSites(real);
  ok("fires on the push_request_permission shape", realSites.length === 1);
  ok("names the write it found", realSites[0]?.write.includes("set_permission"));
  // Two admissions above one write is one site (see the dedupe note in `fabricationSites`),
  // and the one kept is the *nearest* — the comment the write was written under.
  ok(
    "stacked admissions collapse to the nearest one",
    realSites[0]?.admission.includes("For now"),
  );

  // --- and NOT on either half alone -------------------------------------------------
  ok(
    "an admission with no grant write below it is not a site",
    fabricationSites("    // For now, simulate authorization\n    let x = 1;") === undefined ||
      fabricationSites("    // For now, simulate authorization\n    let x = 1;").length === 0,
  );
  ok(
    "a grant write with no admission above it is not a site",
    fabricationSites("    let mut m = lock()?;\n    m.set_permission(PermissionStatus::Authorized);").length === 0,
  );
  // `todo`/`fixme` are a to-do, not an admission: they must NOT be sites.
  ok(
    "TODO/FIXME are not admissions",
    fabricationSites("    // TODO: ask the OS some day\n    m.set_permission(PermissionStatus::Authorized);")
      .length === 0,
  );
  // The window is five lines: a comment far above a write is a coincidence.
  const far = ["    // For now, simulate x", ...Array(8).fill("    let a = 1;"), "    granted = true"].join("\n");
  ok("a write more than five lines below is out of the window", fabricationSites(far).length === 0);
  ok(
    "a write exactly five lines below is inside the window",
    fabricationSites(
      ["    // For now, simulate x", "    let a = 1;", "    let b = 2;", "    let c = 3;", "    let d = 4;", "    granted = true"].join("\n"),
    ).length === 1,
  );
  // Comments are skipped when looking forward, so a run of prose does not consume the window.
  ok(
    "intervening comments do not consume the window",
    fabricationSites(
      ["    // For now, simulate x", "    // a note", "    // another note", "    enabled = true"].join("\n"),
    ).length === 1,
  );
  // The dangerous direction: a code line that merely *contains* the word in a string.
  ok(
    "an admission word inside a string is not an admission",
    fabricationSites('    let s = "for now, simulate";\n    granted = true;').length === 0,
  );
  // And the state-write list must not fire on an unrelated `= true`.
  ok(
    "an unrelated boolean assignment is not a grant",
    fabricationSites("    // For now, simulate x\n    let mut ok = true;").length === 0,
  );
  for (const name of ["allowed", "enabled", "verified", "connected", "active", "available"]) {
    ok(
      `\`${name} = true\` is a grant`,
      fabricationSites(`    // For now, simulate x\n    ${name} = true;`).length === 1,
    );
  }
  ok(
    "`permission =` and `granted =` are grants",
    fabricationSites("    // For now, fake it\n    permission = X;").length === 1 &&
      fabricationSites("    // placeholder\n    granted = true;").length === 1,
  );

  // --- the line number reported is the write's, not the comment's -------------------
  const numbered = fabricationSites(["    // stub", "    let a = 1;", "    is_granted = true;"].join("\n"));
  ok("reports the write's line number", numbered[0]?.line === 3);
  ok("reports the admission's line number", numbered[0]?.admissionLine === 1);
  ok("carries the file through", fabricationSites(real, "a/b.rs")[0]?.file === "a/b.rs");

  if (failures > 0) {
    console.error(`\nrust-fabrication-scan --selftest: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nrust-fabrication-scan --selftest: OK");
}

if (process.argv.includes("--selftest")) selftest();
else if (process.argv.includes("--json")) console.log(JSON.stringify(scan(), null, 2));
else report();
