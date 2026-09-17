import { describe, expect, test } from "vitest";

describe("happy-dom selector diag", () => {
  test("querySelectorAll with :not([attr=value])", () => {
    const container = document.createElement("div");
    const a = document.createElement("button"); a.id = "a";
    const b = document.createElement("button"); b.id = "b";
    const off = document.createElement("button"); off.disabled = true;
    const skipped = document.createElement("button"); skipped.setAttribute("tabindex", "-1");
    container.append(a, b, off, skipped);
    document.body.appendChild(container);

    const SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    console.log("[E] SEL matches count:", container.querySelectorAll(SEL).length);
    console.log("[F] matched ids:", Array.from(container.querySelectorAll(SEL)).map((n) => n.id || `[${n.tagName}, attrs=${n.getAttribute("tabindex")}]`));

    // Try each selector separately
    const parts = SEL.split(",");
    for (const part of parts) {
      console.log(`  part "${part}" matches:`, container.querySelectorAll(part).length, Array.from(container.querySelectorAll(part)).map((n) => n.id || `[tabindex=${n.getAttribute("tabindex")}]`));
    }
    expect(true).toBe(true);
  });
});
