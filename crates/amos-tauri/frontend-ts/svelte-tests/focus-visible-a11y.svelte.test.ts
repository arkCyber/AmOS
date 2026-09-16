/**
 * focus-visible-a11y.svelte.test.ts — DOM-level guard for REQ-A285's focus-visible
 * global CSS.
 *
 * The static `scripts/a11y-scan.mjs` already proves the **string** `button:focus-visible
 * { outline: ... }` is present in src/index.css. This file proves the **specificity
 * contract** actually holds against Tailwind's `outline-none` utility, so a future
 * "let's remove the !important" or "let's rename the rule" change doesn't silently
 * regress keyboard focus to invisible.
 *
 * happy-dom does not parse CSS, so the assertions are against the raw rule text in
 * index.css (it is small enough to grep by line). The reason the test lives here
 * instead of as a node assert in scripts/a11y-scan.mjs is that REQ-A285's failure mode
 * is a **cascade** problem (two rules, same specificity, source-order matters) — and
 * a Vitest test is the cheapest way to keep the contract pinned.
 *
 * Negative controls (REQ-FMEA pattern):
 *   - chrome widget buttons MUST keep their white-translucent ring — losing it to the
 *     global outline would make the topbar feel louder and break the iOS focus
 *     vocabulary. The test pins that `focus-visible:outline-none` stays in
 *     lib/shellChrome.ts.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

// import.meta.url is the URL of this test file (svelte-tests/focus-visible-a11y.svelte.test.ts);
// fileURLToPath gives us the absolute path, and `path.dirname` is its directory. The
// package root is one level up; the absolute paths to the source files we want to read
// (index.css / lib/shellChrome.ts / shell-entry.ts) are relative to that package root.
// We avoid `__dirname` because this file is ESM (`bun run test:svelte` uses Vite's loader);
// under ESM `__dirname` is undefined and falls back to the cwd, which would resolve the
// path to /Users/arksong/AmOS/crates/amos-tauri/frontend-ts/crates/amos-tauri/frontend-ts/…
// and the file open ENOENTs.
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const INDEX_CSS = fs.readFileSync(path.join(REPO, "src/index.css"), "utf8");
const SHELL_CHROME = fs.readFileSync(path.join(REPO, "src/lib/shellChrome.ts"), "utf8");
const SHELL_ENTRY = fs.readFileSync(path.join(REPO, "src/shell-entry.ts"), "utf8");

describe("REQ-A285: global button:focus-visible outline is wired into the build", () => {
  test("shell-entry imports index.css (otherwise the rule never reaches the bundle)", () => {
    // The grep-by-string assertion: any future refactor that moves the entry point or
    // swaps the CSS import for a Tailwind plugin must update this guard. Cline/assistant
    // have both independently tripped on similar accidental-coupling bugs.
    expect(SHELL_ENTRY).toMatch(/import\s+["']\.\/index\.css["']/);
  });

  test("index.css carries the global rule at specificity 0,1,1 (button:focus-visible)", () => {
    // specificity (0,1,1) — one element + one pseudo-class — beats Tailwind's
    // `.outline-none` (specificity 0,1,0), so the rule is not silently overridden on
    // every button the developer never gave an alternative ring to.
    expect(INDEX_CSS).toMatch(/button\s*:\s*focus-visible\s*,\s*\[\s*role="button"\s*\]\s*:\s*focus-visible/);
    // The rule must apply an outline, not just declare a token.
    const rule = INDEX_CSS.match(
      /button\s*:\s*focus-visible\s*,\s*\[\s*role="button"\s*\]\s*:\s*focus-visible\s*\{[^}]+\}/,
    );
    expect(rule, "missing the button:focus-visible + [role=button]:focus-visible rule").toBeTruthy();
    expect(rule![0]).toMatch(/outline:\s*[^;]*solid/);
    expect(rule![0]).toMatch(/outline-offset:\s*[^;]*px/);
  });

  test("index.css does NOT use !important on the button:focus-visible rule (specificity suffices)", () => {
    // If a future change adds !important, the chrome widget buttons (CHROME_ICON_BUTTON /
    // CHROME_MENU_BUTTON) would lose their focus-visible:outline-none opt-out and get a
    // double-ring (blue outline + white ring). That regression is loud visually; we
    // catch it here before it ships.
    const rule = INDEX_CSS.match(
      /button\s*:\s*focus-visible\s*,\s*\[\s*role="button"\s*\]\s*:\s*focus-visible\s*\{[^}]+\}/,
    )?.[0] ?? "";
    expect(rule).not.toMatch(/!important/);
  });
});

describe("REQ-A285: chrome widget buttons keep their iOS white-translucent ring", () => {
  test("shellChrome CHROME_ICON_BUTTON / CHROME_MENU_BUTTON opt out of the global outline", () => {
    // The two tokens must carry `focus-visible:outline-none` so the white-translucent ring
    // they install is the **only** focus indicator. Without this, every chrome button
    // would render both the iOS ring AND the default blue outline (visually loud).
    expect(SHELL_CHROME).toMatch(/CHROME_ICON_BUTTON[\s\S]*?focus-visible:outline-none/);
    expect(SHELL_CHROME).toMatch(/CHROME_MENU_BUTTON[\s\S]*?focus-visible:outline-none/);
  });

  test("shellChrome tokens still install a ring (focus-visible:ring-2)", () => {
    // Negative control for the opt-out above: if a developer removed both
    // `focus-visible:outline-none` and `focus-visible:ring-2` together (e.g. to "fix"
    // a perceived regression), chrome buttons would have neither — same failure mode as
    // forgetting the rule. This guard fails first so the diff is small.
    expect(SHELL_CHROME).toMatch(/focus-visible:ring-2\s+focus-visible:ring-white\/60/);
  });
});
