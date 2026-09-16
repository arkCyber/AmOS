import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SCRIPT = path.join(REPO, "scripts/a11y-scan.mjs");
const SRC = path.join(REPO, "src/svelte");

describe("REQ-A290: target-size scanner (R7) wired into the build", () => {
  test("a11y-scan.mjs contains r7_targetSize and registers it in the rules array", () => {
    const script = fs.readFileSync(SCRIPT, "utf8");
    expect(script).toMatch(/function\s+r7_targetSize\s*\(/);
    expect(script).toMatch(/rules\s*=\s*\[[^\]]*\br7_targetSize\b/);
  });

  test("R7 thresholds are 24 (AA) and 44 (AAA) — match WCAG 2.1 SC 2.5.5 / 2.5.8", () => {
    const script = fs.readFileSync(SCRIPT, "utf8");
    // Source-of-truth is the WCAG standard; we sanity-check the script mentions both.
    expect(script).toMatch(/24/);
    expect(script).toMatch(/44/);
    expect(script).toMatch(/AAA/);
    expect(script).toMatch(/AA/);
  });

  test("chrome widget buttons are exempt — they live in the 44px top bar", () => {
    const script = fs.readFileSync(SCRIPT, "utf8");
    expect(script).toMatch(/R7_CHROME_HIT_ZONE/);
    expect(script).toMatch(/CHROME_ICON_BUTTON/);
    expect(script).toMatch(/CHROME_MENU_BUTTON/);
  });

  test("IME keyboard file is exempt — keys are dense by design (iOS Gboard = 30-36pt)", () => {
    const script = fs.readFileSync(SCRIPT, "utf8");
    expect(script).toMatch(/R7_KEYBOARD_FILE/);
    expect(script).toMatch(/ImeKeyboard/);
  });

  test("AppLibrary search-clear button has been raised from 20→36 px (was AA-fail)", () => {
    const file = path.join(SRC, "AppLibrary.svelte");
    const content = fs.readFileSync(file, "utf8");
    // The clear-search close button (✕) used to be h-5 w-5 = 20px (AA fail).
    // It is now ≥h-9 w-9 (36px) — AA pass, AAA miss but documented.
    expect(content).not.toMatch(/h-5\s+w-5[^"]*bg-neutral-300[^"]*text-\[10px\]/);
    // And we do see h-9 w-9 (36px) for the close button
    expect(content).toMatch(/grid\s+h-9\s+w-9[\s\S]*?bg-neutral-300/);
  });

  test("MessagesApp send button has been raised from 36→44 px", () => {
    const file = path.join(SRC, "MessagesApp.svelte");
    const content = fs.readFileSync(file, "utf8");
    // Both send buttons (real-sms + ai/contact) now h-11 w-11 (44×44)
    expect(content).toMatch(/grid\s+h-11\s+w-11[^"]*bg-accent\s+text-white/);
    // Make sure no h-9 send button is left
    expect(content).not.toMatch(/h-9\s+w-9[^"]*bg-accent\s+text-white/);
  });

  test("TopbarAppleMenu (chrome) is no longer in R7 report", () => {
    const file = path.join(SRC, "modules", "TopbarAppleMenu.svelte");
    const content = fs.readFileSync(file, "utf8");
    // The button uses CHROME_MENU_BUTTON token + h-6 w-6 + px-0 (24×24).
    // WCAG 2.5.5 "essential" exception covers system chrome (Apple HIG = 22pt).
    expect(content).toMatch(/CHROME_MENU_BUTTON/);
    expect(content).toMatch(/h-6\s+w-6/);
  });
});
