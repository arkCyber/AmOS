#!/usr/bin/env node
/**
 * trace-scan.mjs — the requirements ledger checks itself.
 *
 * Why: `docs/TRACEABILITY_MATRIX.md` is the **index of record** for this project — the
 * "requirement → code → test" table a reader is sent to when they ask whether something was
 * built and whether it was verified. Nothing checked it. Measured on the tree that prompted this
 * file (REQ-A371):
 *
 *   * `REQ-A250` was used by **two different rounds** (the macOS window-title audit and the
 *     DesktopShell take-over) — an ID that names two things is not a usable lookup key, and the
 *     documents that cite it (`docs/multi-window.md`, `docs/UI_APPLE_HIG_AUDIT.md`) cannot say
 *     which one they mean;
 *   * one row's **status cell** reads `###（诚实边界：…` where 224 other rows read
 *     `✅（诚实边界：…` — the doc's own legend (`✅`/`🟡`/`⬜`) is what makes the column readable,
 *     so a row that starts with `###` has no state at all.
 *
 * Both defects sit in the one artefact nobody gated. This scan is that gate; it is deliberately
 * narrow and mechanical (shape, unique IDs, a status the legend defines, a non-empty verification
 * cell) because those are the properties the document itself claims.
 *
 * Honest scope: this does **not** prove a row's claims are true — a link to a file that exists and
 * a test name that exists is not the same as a test that runs (that is `orphan-test-scan`'s and the
 * coverage gates' business). It proves the ledger is *readable as an index*.
 *
 * Usage (repo root):
 *   node scripts/trace-scan.mjs              # gate (exit 1 on any finding)
 *   node scripts/trace-scan.mjs --json
 *   node scripts/trace-scan.mjs --selftest   # pin the parsers/classifiers
 *   TRACE_DOC=<path> node scripts/trace-scan.mjs   # check a historical copy (negative control)
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Overridable so a check can run against a *historical* copy of the document (a negative control
// on real history), the same hook `fmea-gen.mjs` uses for `FMEA_DOC`.
const DOC = process.env.TRACE_DOC ?? join(root, "docs/TRACEABILITY_MATRIX.md");

/** The legend the document declares in its own header: implemented+tested / implemented / todo. */
export const STATUS_MARKS = ["✅", "🟡", "⬜"];

/** Cells of a Markdown table row, split on ` | ` (an inner literal `\|` must be escaped in docs). */
function cellsOf(line) {
  return line.split(" | ");
}

/** The first cell's text (the ID column) without the leading pipe. */
function firstCell(line) {
  return cellsOf(line)[0].replace(/^\|\s*/, "").trim();
}

/**
 * Rows whose cell count differs from their table's header. A blank line ends a table (the doc has
 * several tables of different widths, so 2/5-cell tables must both pass without exemptions).
 */
export function tableShapeProblems(text) {
  const problems = [];
  let header = null;
  let headerLine = 0;
  String(text)
    .split("\n")
    .forEach((line, i) => {
      if (!line.startsWith("|")) {
        header = null;
        return;
      }
      if (/^\|[\s:|-]+\|\s*$/.test(line)) return; // |---|---|
      const cells = cellsOf(line).length;
      if (header === null) {
        header = cells;
        headerLine = i + 1;
        return;
      }
      if (cells !== header) problems.push({ line: i + 1, cells, expected: header, headerLine });
    });
  return problems;
}

/** One ID, one requirement: the ledger is an index, so a repeated ID is a defect by definition. */
export function duplicateReqIds(text) {
  const seen = new Map();
  const problems = [];
  String(text)
    .split("\n")
    .forEach((line, i) => {
      if (!line.startsWith("|")) return;
      if (/^\|[\s:|-]+\|\s*$/.test(line)) return;
      const id = firstCell(line);
      if (!/^REQ-[A-Z]?\d+$/.test(id)) return;
      if (seen.has(id)) problems.push({ id, line: i + 1, firstLine: seen.get(id) });
      else seen.set(id, i + 1);
    });
  return problems;
}

/**
 * Requirement rows that cannot be read as index entries:
 *   * `missing-status` — the status cell does not begin with one of the doc's own legend marks;
 *   * `empty-verification` — the 验证 cell is empty, i.e. the row claims no evidence;
 *   * `short-row` — fewer cells than the table (caught by the shape check too, but named here so
 *     the message says which ID).
 *
 * Both are measured invariants of the document as it stands (0 empty cells; exactly one row with
 * the wrong status marker, fixed in the same commit), so gating them cannot be a false alarm.
 */
export function rowProblems(text) {
  const problems = [];
  String(text)
    .split("\n")
    .forEach((line, i) => {
      if (!line.startsWith("|")) return;
      if (/^\|[\s:|-]+\|\s*$/.test(line)) return;
      const id = firstCell(line);
      if (!/^REQ-[A-Z]?\d+$/.test(id)) return;
      const cells = cellsOf(line);
      if (cells.length < 5) {
        problems.push({ id, line: i + 1, kind: "short-row", detail: `${cells.length} cells` });
        return;
      }
      if (cells[3].trim() === "") {
        problems.push({ id, line: i + 1, kind: "empty-verification", detail: "the 验证 cell is empty" });
      }
      const status = cells[4].trim();
      if (!STATUS_MARKS.some((m) => status.startsWith(m))) {
        problems.push({
          id,
          line: i + 1,
          kind: "missing-status",
          detail: `status starts with ${JSON.stringify(status.slice(0, 12))}`,
        });
      }
    });
  return problems;
}

/** All findings for one document text (pure — the selftest and the gate share this). */
export function traceFindings(text) {
  return {
    shape: tableShapeProblems(text),
    duplicates: duplicateReqIds(text),
    rows: rowProblems(text),
  };
}

/** The REQ ids that *do* have a row (used to see which code citations have no row). */
export function registeredIds(text) {
  const out = new Set();
  String(text)
    .split("\n")
    .forEach((line) => {
      if (!line.startsWith("|")) return;
      const id = firstCell(line);
      if (/^REQ-[A-Z]?\d+$/.test(id)) out.add(id);
    });
  return out;
}

/**
 * REQ ids cited by **code** for which the ledger has no row.
 *
 * This is deliberately a *report*, not a failure (REQ-A372). Measured when the check was written:
 * **51** ids are cited in shipped code (`crates/**`, `scripts/**`, the frontend, the Makefile) and
 * have no row — `REQ-A256` in `wm.rs`, `REQ-A302/303/304/307` in `amos-media/src/protocol.rs`, … —
 * while the ledger's header read as if it were the complete index. Two honest options existed:
 * write 51 rows from numbers whose rounds are history (fabricating a record is worse than a gap),
 * or **make the claim true and keep the gap visible**. This function is the second half; the
 * header sentence and the ledger row for REQ-A372 are the first.
 *
 * A cited id is matched as a whole token (`REQ-A99` does not match `REQ-A099`).
 */
export function danglingCitations(sources, ids) {
  const byId = new Map();
  for (const { file, text } of sources) {
    for (const id of new Set(String(text).match(/REQ-[A-Z]?\d+/g) ?? [])) {
      if (ids.has(id)) continue;
      if (!byId.has(id)) byId.set(id, new Set());
      byId.get(id).add(file);
    }
  }
  return [...byId.entries()]
    .map(([id, files]) => ({ id, files: [...files].sort() }))
    .sort((a, b) => b.files.length - a.files.length || a.id.localeCompare(b.id));
}

/** File types that can carry a requirement citation in this repository. */
const CODE_EXT = [".rs", ".mjs", ".js", ".ts", ".tsx", ".svelte", ".kt", ".sh", ".json", ".toml", ".yml", ".yaml"];
/** Never walked: build output, dependencies, the git-ignored generated project, archived docs. */
const SKIP_DIRS = new Set(["target", "node_modules", ".git", "dist", "build", "gen", "archive", "docs"]);

/** Every shipped code file (docs excluded — the ledger's own text is not a citation). */
export function codeSources(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: not a reason to fail the ledger check
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(p);
        continue;
      }
      if (ent.name === "Makefile" || CODE_EXT.some((e) => ent.name.endsWith(e))) {
        try {
          out.push({ file: p.slice(root.length + 1), text: readFileSync(p, "utf8") });
        } catch {
          /* binary or unreadable: skip */
        }
      }
    }
  };
  walk(root);
  return out;
}

export function runSelftest() {
  const cases = [];
  const check = (name, ok) => cases.push([name, ok]);

  const HEADER = "| 需求 ID | 描述 | 设计 / 代码 | 验证（测试/命令） | 状态 |";
  const SEP = "|---|---|---|---|---|";
  const row = (id, verify = "`x.test.ts`", status = "✅ |") => `| ${id} | d | c | ${verify} | ${status}`;

  const clean = traceFindings([HEADER, SEP, row("REQ-A1"), row("REQ-A2")].join("\n"));
  check("a clean table has no findings", clean.shape.length + clean.duplicates.length + clean.rows.length === 0);

  const dup = traceFindings([HEADER, SEP, row("REQ-A1"), row("REQ-A1")].join("\n"));
  check("a repeated ID is a finding", dup.duplicates.length === 1 && dup.duplicates[0].id === "REQ-A1");
  check("the first registration's line is reported", dup.duplicates[0].line === 4 && dup.duplicates[0].firstLine === 3);

  const short = traceFindings([HEADER, SEP, row("REQ-A1"), "| REQ-A2 | only | 3 | cells |"].join("\n"));
  check("a row shorter than its header is a shape finding", short.shape.length === 1 && short.shape[0].cells === 4);
  check("…and is also named as a row problem", short.rows.some((p) => p.kind === "short-row" && p.id === "REQ-A2"));

  const twoTables = traceFindings(
    [HEADER, SEP, row("REQ-A1"), "", "| 风险 | 处置 |", "|---|---|", "| R1 | ok |"].join("\n"),
  );
  check("a narrower second table is not a shape finding (no exemption needed)", twoTables.shape.length === 0);

  const noVerify = traceFindings([HEADER, SEP, row("REQ-A1", "")].join("\n"));
  check("an empty 验证 cell is a finding", noVerify.rows.some((p) => p.kind === "empty-verification"));

  const badStatus = traceFindings([HEADER, SEP, row("REQ-A1", "`x`", "###（诚实边界：…） |")].join("\n"));
  check("a status outside the legend is a finding", badStatus.rows.some((p) => p.kind === "missing-status"));
  for (const mark of STATUS_MARKS) {
    const ok = traceFindings([HEADER, SEP, row("REQ-A1", "`x`", `${mark} |`)].join("\n"));
    check(`the legend mark ${mark} passes`, !ok.rows.some((p) => p.kind === "missing-status"));
  }

  const prose = traceFindings(`${[HEADER, SEP, row("REQ-A1")].join("\n")}\n\nprose cites REQ-A1 — not a row, so it must not count`);
  check("prose that cites an ID is not a row", prose.duplicates.length === 0);

  // REQ-A372: the code→ledger report (informational) must still be *correct* about what it sees.
  const reg = registeredIds([HEADER, SEP, row("REQ-A1"), row("REQ-B12")].join("\n"));
  check("registeredIds collects exactly the row ids", reg.size === 2 && reg.has("REQ-A1") && reg.has("REQ-B12"));
  const dangle = danglingCitations(
    [
      { file: "crates/x/src/lib.rs", text: "// REQ-A1 says hello, and REQ-A99 is not registered" },
      { file: "Makefile", text: "# REQ-A99 again, plus REQ-B12 which is registered" },
    ],
    reg,
  );
  check("a registered citation is not reported", !dangle.some((d) => d.id === "REQ-A1" || d.id === "REQ-B12"));
  check("an unregistered citation is reported once, with its files", dangle.length === 1 && dangle[0].id === "REQ-A99" && dangle[0].files.length === 2);
  check("the busiest citation sorts first", dangle[0].files[0] === "Makefile");
  check("ids are matched whole (REQ-A9 is not REQ-A99)", danglingCitations([{ file: "f", text: "REQ-A9" }], reg)[0].id === "REQ-A9");

  let failed = 0;
  for (const [name, ok] of cases) {
    if (ok) console.log(`  [ok] ${name}`);
    else {
      failed++;
      console.log(`  [FAIL] ${name}`);
    }
  }
  if (failed > 0) {
    console.log(`[trace-scan] selftest FAILED (${failed}/${cases.length}).`);
    process.exit(1);
  }
  console.log(`[trace-scan] selftest OK — ${cases.length} case(s), incl. must-fail shapes.`);
}

// --- gate --------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop());

if (invokedDirectly) {
  if (process.argv.includes("--selftest")) {
    runSelftest();
    process.exit(0);
  }
  if (!existsSync(DOC)) {
    console.error(`[trace-scan] FAIL — ${DOC} not found`);
    process.exit(1);
  }
  const text = readFileSync(DOC, "utf8");
  const findings = traceFindings(text);
  const total = findings.shape.length + findings.duplicates.length + findings.rows.length;
  // Informational, never a failure: how many requirement numbers the code cites that the ledger
  // has no row for (REQ-A372 — the ledger is a partial index, and the header now says so).
  const dangling = danglingCitations(codeSources(root), registeredIds(text));

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ doc: DOC, ...findings, dangling }, null, 2));
    process.exit(total === 0 ? 0 : 1);
  }

  if (findings.duplicates.length > 0) {
    console.error("[trace-scan] FAIL — the same requirement ID is registered twice:");
    for (const d of findings.duplicates) {
      console.error(`  ${d.id} on line ${d.line}, already registered on line ${d.firstLine}`);
    }
  }
  if (findings.rows.length > 0) {
    console.error("[trace-scan] FAIL — requirement rows that are not readable as index entries:");
    for (const p of findings.rows) console.error(`  line ${p.line} ${p.id} [${p.kind}] ${p.detail}`);
  }
  if (findings.shape.length > 0) {
    console.error("[trace-scan] FAIL — table rows whose cell count differs from their header:");
    for (const p of findings.shape) {
      console.error(`  line ${p.line}: ${p.cells} cells, but the header on line ${p.headerLine} has ${p.expected}`);
    }
  }
  if (total > 0) {
    console.error("");
    console.error("Fix: docs/TRACEABILITY_MATRIX.md — one ID per requirement, a legend status mark,");
    console.error("a non-empty 验证 cell, and the same cell count as the table header.");
    process.exit(1);
  }
  console.log(
    "[trace-scan] OK — the requirements ledger reads as an index (unique IDs, legend statuses, evidence in every row).",
  );
  if (dangling.length > 0) {
    console.log(
      `[trace-scan] report — ${dangling.length} REQ id(s) are cited in code with no row in the ledger (informational, not a failure: the ledger is a **partial** index, see its header and REQ-A372):`,
    );
    for (const d of dangling.slice(0, 10)) {
      const files = d.files.slice(0, 2).join(", ");
      console.log(`  ${d.id}: ${files}${d.files.length > 2 ? ` (+${d.files.length - 2} more)` : ""}`);
    }
    if (dangling.length > 10) {
      console.log(`  …and ${dangling.length - 10} more — \`node scripts/trace-scan.mjs --json\``);
    }
  }
}
