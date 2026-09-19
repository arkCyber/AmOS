#!/usr/bin/env node
/**
 * menu-i18n-scan.mjs — the macOS menu bar's labels come from **one** table (REQ-A437).
 *
 * The defect this exists to prevent: `crates/amos-tauri/src/menu.rs` drew its labels from
 * English string **literals** inside `build_menu`, while the shell ships **Chinese first**
 * (`lib/i18n.currentLocale()` defaults to `zh`) — so a user whose whole UI is Chinese read a menu
 * bar saying `File / Edit / View / Window / Help` (measured on a real launch, 2026-09-18). The fix
 * moved every label into `MenuLabels` (one struct, one const per language, so a **missing
 * translation is a compile error**).
 *
 * A compile error is exactly what this cannot protect: a future menu row can pass `"New Thing"`
 * as a literal, compile fine, and be invisible to every other gate (the frontend's `i18n-scan`
 * only reads `.svelte` / `.ts`, and `rust-unwired-scan` asks whether code is *called*).
 *
 * Rules (both fail):
 *   R1 `literal-label` — inside `build_menu`, no label may be a string literal:
 *      `SubmenuBuilder::new(app, "File")` and `item(app, ids::X, "File", …)` are the exact shape
 *      that shipped English on a Chinese Mac. Accelerators (`Some("CmdOrCtrl+N")`) are a different
 *      argument and are not labels.
 *   R2 `unused-label` — every field of `MenuLabels` must be read as `l.<field>` inside
 *      `build_menu`: a field nothing draws is a translation that died, and nobody would notice.
 *
 * Deliberately **not** a rule: "`zh` and `en` declare the same fields" — the struct makes that a
 * compile error, and a scanner that re-checks the compiler is how a gate starts claiming coverage
 * it does not have.
 */
import fs from "node:fs";
import path from "node:path";

/** The file the gate reads. */
export const MENU_RS = "crates/amos-tauri/src/menu.rs";

/** The argument shapes that make a call a *label* rather than an accelerator or an id. */
const LABEL_CALLS = [
  /SubmenuBuilder::new\(\s*app\s*,\s*"/g,
  /item\(\s*app\s*,\s*ids::[A-Z_]+\s*,\s*"/g,
  // The predefined rows (REQ-A439): `undo_with_text("Undo")` is the same defect as an `item(…)`
  // literal — an English row inside a Chinese menu — and it is the shape that shipped here.
  /(?:undo|redo|cut|copy|paste|select_all|minimize|maximize|fullscreen|hide|hide_others|show_all|close_window|quit|about|services|bring_all_to_front)_with_text\(\s*"/g,
];

/** Field names declared by `pub struct MenuLabels { … }`. */
export function labelsFields(src) {
  const block = /pub struct MenuLabels \{(?<body>[\s\S]*?)\n\}/.exec(src);
  if (!block) return null;
  return [...block.groups.body.matchAll(/^\s*pub\s+(\w+)\s*:/gm)].map((m) => m[1]);
}

/**
 * The body of `fn build_menu`, brace-matched from its opening `{`.
 *
 * Brace matching rather than "up to the next `\n}`": the body contains nested closures, and a
 * naive slice would either cut the function short or run on into `install`.
 */
export function buildMenuBody(src) {
  const start = /fn build_menu<[^>]*>\([\s\S]*?\{/.exec(src);
  if (!start) return null;
  let depth = 1;
  let i = start.index + start[0].length;
  for (; i < src.length && depth > 0; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") depth -= 1;
  }
  return src.slice(start.index + start[0].length, i);
}

/** All problems in one menu.rs source, as `{ rule, detail }`. */
export function scanMenuSource(src) {
  const problems = [];
  const body = buildMenuBody(src);
  if (body === null) {
    problems.push({ rule: "menu-not-found", detail: "fn build_menu was not found" });
    return problems;
  }
  for (const pattern of LABEL_CALLS) {
    for (const match of body.matchAll(pattern)) {
      const line = body.slice(0, match.index).split("\n").length;
      problems.push({
        rule: "literal-label",
        detail: `build_menu passes a string literal as a menu label (body line ~${line}): ${match[0].trim()}`,
      });
    }
  }
  const fields = labelsFields(src);
  if (fields === null) {
    problems.push({ rule: "labels-not-found", detail: "pub struct MenuLabels was not found" });
    return problems;
  }
  for (const field of fields) {
    if (!body.includes(`l.${field}`)) {
      problems.push({
        rule: "unused-label",
        detail: `MenuLabels::${field} is never read in build_menu (a translation nothing draws)`,
      });
    }
  }
  return problems;
}

function main() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const file = path.join(root, MENU_RS);
  if (!fs.existsSync(file)) {
    console.error(`[menu-i18n-scan] FAIL — ${MENU_RS} not found`);
    process.exit(1);
  }
  const src = fs.readFileSync(file, "utf8");
  const problems = scanMenuSource(src);
  const fields = labelsFields(src) ?? [];
  if (problems.length > 0) {
    console.error(
      `[menu-i18n-scan] FAIL — ${problems.length} problem(s) with the menu bar's labels:`,
    );
    for (const p of problems) console.error(`  ${p.rule}: ${p.detail}`);
    console.error(
      "\nFix by drawing the row from the table (`l.<field>` in `build_menu`) and adding the field\n" +
        "to BOTH `LABELS_EN` and `LABELS_ZH` — the struct makes a missing translation a compile\n" +
        "error, this gate keeps the drawing side honest.",
    );
    process.exit(1);
  }
  console.log(
    `[menu-i18n-scan] OK — every label in build_menu comes from MenuLabels (${fields.length} fields)`,
  );
}

/**
 * The shapes the two rules must catch, and the shape they must not — so the gate's own
 * classifier is pinned before it is trusted (the convention every scan here follows).
 */
function selftest() {
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok });

  const struct = `pub struct MenuLabels {\n    pub file: &'static str,\n    pub quit: &'static str,\n}\n`;
  const body =
    `fn build_menu<R: Runtime>(app: &AppHandle<R>, l: &MenuLabels) -> Result<Menu<R>, String> {\n` +
    `    let file = SubmenuBuilder::new(app, l.file)\n` +
    `        .item(&item(app, ids::QUIT, l.quit, true, Some("CmdOrCtrl+Q"))?)\n` +
    `        .build()?;\n` +
    `    Ok(file)\n}\n`;

  // (a) the clean shape passes, and an accelerator literal is not mistaken for a label.
  check("clean source has no problems", scanMenuSource(struct + body).length === 0);
  check("an accelerator literal is not a label", scanMenuSource(struct + body).length === 0);

  // (b) R1 — a literal item label (the shape that shipped English on a Chinese Mac).
  check(
    "R1 catches a literal item label",
    scanMenuSource(struct + body.replace("l.quit", '"Quit Amos"')).some(
      (p) => p.rule === "literal-label",
    ),
  );
  // (c) R1 — a literal submenu title.
  check(
    "R1 catches a literal submenu title",
    scanMenuSource(struct + body.replace("l.file", '"File"')).some(
      (p) => p.rule === "literal-label",
    ),
  );
  // (c) R1 — a literal predefined row (`undo_with_text("Undo")` under a Chinese menu, REQ-A439):
  //     the exact shape that shipped English rows inside a Chinese 编辑 menu.
  check(
    "R1 catches a literal predefined row",
    scanMenuSource(struct + body.replace(".build()?;", '.undo_with_text("Undo").build()?;')).some(
      (p) => p.rule === "literal-label",
    ),
  );
  // (d) R2 — a field the menu stopped drawing.
  const dead =
    `pub struct MenuLabels {\n    pub file: &'static str,\n    pub quit: &'static str,\n    pub help: &'static str,\n}\n` +
    body;
  check(
    "R2 catches a translation nothing draws",
    scanMenuSource(dead).some((p) => p.rule === "unused-label"),
  );
  // (e) brace matching survives nested calls (a `}` inside a closure cannot cut the body short).
  check(
    "brace matching survives nested calls",
    scanMenuSource(struct + body.replace(".build()?;", ".build().map_err(|e| e.to_string())?;"))
      .length === 0,
  );

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}`);
  console.log(
    `[menu-i18n-scan] selftest: ${checks.length} assertion(s), ${failed.length} failure(s).`,
  );
  if (failed.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
