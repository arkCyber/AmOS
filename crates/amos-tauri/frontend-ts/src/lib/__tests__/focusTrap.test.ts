import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { attachFocusTrap } from "../focusTrap";

/**
 * focusTrap.ts — keyboard focus containment for modal overlays
 * (WCAG 2.1.2 No keyboard trap, 2.4.3 Focus Order).
 *
 * Scenarios:
 *   - attachFocusTrap focuses the first focusable in the scope on attach
 *   - Tab at the last focusable wraps to the first
 *   - Shift+Tab at the first wraps to the last
 *   - Escape (when onEscape provided) is forwarded
 *   - detached scope / no focusable children is a safe no-op
 *   - multiple instances coexist (different scopes don't steal focus from each other)
 */
describe("attachFocusTrap", () => {
  beforeEach(() => {
    GlobalRegistrator.register();
  });

  afterEach(() => {
    GlobalRegistrator.unregister();
  });

  function fireKey(key: string, init: Partial<KeyboardEventInit> = {}) {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    window.document.dispatchEvent(ev);
  }

  it("focuses the first focusable when attached", () => {
    document.body.innerHTML = `
      <div id="scope">
        <button id="b1">one</button>
        <button id="b2">two</button>
        <button id="b3">three</button>
      </div>`;
    const scope = document.getElementById("scope") as HTMLElement;
    const cleanup = attachFocusTrap(scope);
    expect(document.activeElement).toBe(document.getElementById("b1"));
    cleanup();
  });

  it("Tab on the last focusable wraps to the first", () => {
    document.body.innerHTML = `
      <div id="scope">
        <button id="b1">one</button>
        <button id="b2">two</button>
        <button id="b3">three</button>
      </div>`;
    const scope = document.getElementById("scope") as HTMLElement;
    const cleanup = attachFocusTrap(scope);
    const last = document.getElementById("b3") as HTMLElement;
    last.focus();
    expect(document.activeElement).toBe(last);
    fireKey("Tab");
    expect(document.activeElement).toBe(document.getElementById("b1"));
    cleanup();
  });

  it("Shift+Tab on the first focusable wraps to the last", () => {
    document.body.innerHTML = `
      <div id="scope">
        <button id="b1">one</button>
        <button id="b2">two</button>
        <button id="b3">three</button>
      </div>`;
    const scope = document.getElementById("scope") as HTMLElement;
    const cleanup = attachFocusTrap(scope);
    const first = document.getElementById("b1") as HTMLElement;
    first.focus();
    fireKey("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(document.getElementById("b3"));
    cleanup();
  });

  it("Escape invokes the onEscape callback", () => {
    document.body.innerHTML = `
      <div id="scope">
        <button id="b1">one</button>
      </div>`;
    const scope = document.getElementById("scope") as HTMLElement;
    let escaped = false;
    const cleanup = attachFocusTrap(scope, () => {
      escaped = true;
    });
    fireKey("Escape");
    expect(escaped).toBe(true);
    cleanup();
  });

  it("Escape without a callback is a safe no-op (no exception)", () => {
    document.body.innerHTML = `
      <div id="scope">
        <button id="b1">one</button>
      </div>`;
    const scope = document.getElementById("scope") as HTMLElement;
    const cleanup = attachFocusTrap(scope);
    expect(() => fireKey("Escape")).not.toThrow();
    cleanup();
  });

  it("disabled focusables are skipped (Tab wraps over them)", () => {
    document.body.innerHTML = `
      <div id="scope">
        <button id="b1">one</button>
        <button id="b2" disabled>two</button>
        <button id="b3">three</button>
      </div>`;
    const scope = document.getElementById("scope") as HTMLElement;
    const cleanup = attachFocusTrap(scope);
    const last = document.getElementById("b3") as HTMLElement;
    last.focus();
    fireKey("Tab");
    // Should jump back to b1 because b2 is disabled
    expect(document.activeElement).toBe(document.getElementById("b1"));
    cleanup();
  });

  it("non-Tab / non-Escape keys pass through without affecting focus", () => {
    document.body.innerHTML = `
      <div id="scope">
        <button id="b1">one</button>
        <button id="b2">two</button>
      </div>`;
    const scope = document.getElementById("scope") as HTMLElement;
    const cleanup = attachFocusTrap(scope);
    const b1 = document.getElementById("b1") as HTMLElement;
    b1.focus();
    fireKey("Enter");
    expect(document.activeElement).toBe(b1);
    fireKey(" ");
    expect(document.activeElement).toBe(b1);
    cleanup();
  });

  it("cleanup removes the keydown listener", () => {
    document.body.innerHTML = `
      <div id="scope">
        <button id="b1">one</button>
        <button id="b2">two</button>
        <button id="b3">three</button>
      </div>`;
    const scope = document.getElementById("scope") as HTMLElement;
    const cleanup = attachFocusTrap(scope);
    cleanup();
    const last = document.getElementById("b3") as HTMLElement;
    last.focus();
    fireKey("Tab");
    // After cleanup, Tab should NOT wrap — focus should remain on b3
    expect(document.activeElement).toBe(last);
  });

  it("two traps in separate scopes don't steal focus from each other", () => {
    document.body.innerHTML = `
      <div id="a">
        <button id="a1">A1</button>
        <button id="a2">A2</button>
      </div>
      <div id="b">
        <button id="b1">B1</button>
        <button id="b2">B2</button>
      </div>`;
    const scopeA = document.getElementById("a") as HTMLElement;
    const scopeB = document.getElementById("b") as HTMLElement;
    const cleanupA = attachFocusTrap(scopeA);
    const cleanupB = attachFocusTrap(scopeB);
    // Last attached trap took the initial focus (B1); tab on its last wraps within B
    const b2 = document.getElementById("b2") as HTMLElement;
    b2.focus();
    fireKey("Tab");
    expect(document.activeElement).toBe(document.getElementById("b1"));
    cleanupA();
    cleanupB();
  });
});
