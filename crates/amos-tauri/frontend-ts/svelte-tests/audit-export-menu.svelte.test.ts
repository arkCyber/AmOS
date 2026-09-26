/**
 * audit-export-menu.svelte.test.ts — the audit log's export menu is usable from the keyboard
 * (REQ-A438, closing REQ-A436's boundary).
 *
 * REQ-A436 gave the shell's pop-up menus a shared keyboard layer (`lib/menuKeys.ts`: arrows /
 * Home / End walk the enabled rows, Escape is handed to the menu's own closer). Seven menus were
 * wired then; the audit viewer's export dropdown was the one left out — it renders
 * `role="menu"` + `role="menuitem"` rows too, so "every pop-up menu in the shell is keyboard
 * driven" was a claim with an exception. Escape happened to close it (a document-level listener
 * elsewhere), which is exactly why the gap was easy to miss: the *closing* worked, only
 * *getting to the second row* did not (arrow keys did nothing; the first row was never focused).
 *
 * This test pins the contract on the real component: opening focuses the first row, the arrows
 * walk and wrap, Home/End jump, and Escape closes **this** menu (the trigger's `aria-expanded`
 * goes back to false).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AuditLogViewer from "../src/svelte/modules/AuditLogViewer.svelte";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("AuditLogViewer — export menu keyboard navigation (REQ-A438)", () => {
  test("opens with its first row focused, walks the rows, and closes on Escape", async () => {
    const { container } = render(AuditLogViewer);
    await tick();

    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await fireEvent.click(trigger);
    await tick();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')];
    // JSON / CSV — the two export formats the menu offers.
    expect(rows.length).toBe(2);
    // macOS opens a menu with its first row focused (REQ-A436's rule, same layer).
    expect(document.activeElement).toBe(rows[0]);

    await fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    await fireEvent.keyDown(menu, { key: "ArrowDown" }); // wraps to the first row
    expect(document.activeElement).toBe(rows[0]);
    await fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(rows[1]);
    await fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(rows[0]);

    // Escape is handed to *this* menu's closer: the dropdown collapses. (Both rows are still in
    // the DOM afterwards — visibility is the `open` class, not an `{#if}`.)
    await fireEvent.keyDown(menu, { key: "Escape" });
    await tick();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(menu.classList.contains("open")).toBe(false);
  });

  // The closing half of the same contract (REQ-A1057). Collapsing the dropdown sets
  // `display: none` on the element that holds the focus, and a hidden focused element is
  // blurred — the browser parks focus on `<body>`, so the keyboard user's place on the audit
  // page is gone and the next Tab restarts from the top of the document. Escape puts it back on
  // the trigger, which is where macOS leaves it too.
  test("Escape leaves the focus on the trigger, not on <body>", async () => {
    const { container } = render(AuditLogViewer);
    await tick();

    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    await fireEvent.click(trigger);
    await tick();
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
    const firstRow = [...menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')][0]!;
    expect(document.activeElement, "the menu took the focus").toBe(firstRow);

    await fireEvent.keyDown(menu, { key: "Escape" });
    await tick();

    expect(menu.classList.contains("open"), "the menu closed").toBe(false);
    expect(document.activeElement, "and the focus came back with it").toBe(trigger);
  });
});
