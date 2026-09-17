/**
 * focus-trap.svelte.test.ts — the shared modal focus trap (REQ-A323).
 *
 * `lib/focusTrap.ts` carries the WCAG 2.1.2 behaviour for **every** Svelte sheet (Recents /
 * Notification Center / Spotlight / Mission Control / LockScreen / IncomingCall), and until
 * this file it had no test of its own: the only coverage was one panel's Escape passing
 * through it. That left the parts nobody exercised unpinned — focus moving *into* the
 * sheet, Tab wrapping, and (the gap this round fixes) focus going back to the opener.
 */
import { afterEach, describe, expect, test } from "vitest";
import { attachFocusTrap, focusables } from "../src/lib/focusTrap";

/** A tiny DOM: one opener outside the sheet, two controls inside it. */
function stage() {
  document.body.innerHTML = "";
  const opener = document.createElement("button");
  opener.id = "opener";
  document.body.appendChild(opener);
  const sheet = document.createElement("div");
  sheet.id = "sheet";
  for (const id of ["a", "b"]) {
    const b = document.createElement("button");
    b.id = id;
    sheet.appendChild(b);
  }
  document.body.appendChild(sheet);
  return {
    opener,
    sheet,
    a: sheet.querySelector<HTMLButtonElement>("#a")!,
    b: sheet.querySelector<HTMLButtonElement>("#b")!,
  };
}

const activeId = () => document.activeElement?.id ?? "";
const press = (key: string, shiftKey = false) =>
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }),
  );
/**
 * The trap restores focus after the current task (the sheet's DOM may come out of the tree
 * right after the teardown, and the browser then drops focus to `<body>`), so the positive
 * assertions **wait for the outcome** instead of sampling a fixed delay — a fixed delay made
 * this file flaky, and a flaky gate is worse than no gate.
 */
const waitForActiveId = async (id: string): Promise<boolean> => {
  for (let i = 0; i < 20; i++) {
    if (activeId() === id) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
};
/** For "it must NOT happen": give the deferred restore a generous chance to misbehave. */
const settle = () => new Promise((r) => setTimeout(r, 25));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("focusTrap — what it contains", () => {
  test("focusables finds enabled controls, skipping `disabled` and `tabindex=-1`", () => {
    const { sheet } = stage();
    const off = document.createElement("button");
    off.disabled = true;
    const skipped = document.createElement("button");
    skipped.setAttribute("tabindex", "-1");
    sheet.append(off, skipped);
    expect(focusables(sheet).map((n) => n.id)).toEqual(["a", "b"]);
  });

  test("attaching moves focus to the sheet's first control", () => {
    const { a, opener, sheet } = stage();
    opener.focus();
    const off = attachFocusTrap(sheet);
    expect(activeId()).toBe("a");
    off();
  });

  test("Tab wraps forward from the tail and Shift+Tab back from the head", () => {
    const { a, b, sheet } = stage();
    const off = attachFocusTrap(sheet);
    b.focus();
    press("Tab");
    expect(activeId(), "forward from the last control comes back to the first").toBe("a");
    a.focus();
    press("Tab", true);
    expect(activeId(), "backward from the first control lands on the last").toBe("b");
    off();
  });

  test("Escape runs the caller's policy, and is inert without one", () => {
    let closed = 0;
    const first = attachFocusTrap(stage().sheet, () => (closed += 1));
    press("Escape");
    expect(closed).toBe(1);
    first();
    press("Escape");
    expect(closed, "the listener is gone once the trap is detached").toBe(1);
    // LockScreen / IncomingCall deliberately pass no policy: a locked device must not be
    // escapable and a call must not be hung up by a stray key (both documented in-file).
    const silent = attachFocusTrap(stage().sheet);
    press("Escape");
    expect(closed).toBe(1);
    silent();
  });
});

describe("focusTrap — giving the place back (REQ-A323)", () => {
  test("the opener is focused again when the sheet goes away", async () => {
    const { opener, sheet } = stage();
    opener.focus();
    const off = attachFocusTrap(sheet);
    expect(activeId(), "the sheet takes over while it is open").toBe("a");
    sheet.remove(); // the sheet's DOM leaves the tree, as a close does
    off();
    expect(await waitForActiveId("opener"), "the keyboard user's place is given back").toBe(true);
  });

  test("a late restore never steals focus the user has since taken", async () => {
    const { opener, sheet } = stage();
    const other = document.createElement("button");
    other.id = "other";
    document.body.appendChild(other);
    opener.focus();
    const off = attachFocusTrap(sheet);
    sheet.remove();
    off();
    other.focus(); // the user moved on before the restore ran
    await settle();
    expect(activeId(), "where focus goes next is the user's decision").toBe("other");
  });

  test("an opener that is itself gone is not grabbed at", async () => {
    const { opener, sheet } = stage();
    opener.focus();
    const off = attachFocusTrap(sheet);
    opener.remove();
    sheet.remove();
    off();
    await settle();
    expect(activeId(), "nothing to restore ⇒ focus nothing").toBe("");
  });
});