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
import { readFileSync, existsSync } from "node:fs";
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

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ doc: DOC, ...findings }, null, 2));
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
}
