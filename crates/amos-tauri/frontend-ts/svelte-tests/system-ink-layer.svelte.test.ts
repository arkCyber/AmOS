/**
 * system-ink-layer.svelte.test.ts — the system-wide ink layer, end to end (REQ-A1590).
 *
 * What this pins, in the user's language: while the layer is **down** the shell draws nothing for
 * it; raising it (`openSysInk`) draws a full-window surface and a toolbar; a pen stroke lands as a
 * path; undo/redo move that path both ways; the eraser removes it; Done lowers the layer. The
 * geometry itself is `lib/ink.ts`'s and the history is `lib/systemInk.ts`'s — both unit-tested
 * apart. This file only checks the **wiring**: that the DOM plumbing feeds those two pure modules
 * and that the toolbar reads their answers back.
 *
 * happy-dom ships no `PointerEvent` constructor, so the samples are plain bubbling `Event`s
 * stamped with the fields the component reads — the component (like `InkCanvas`) takes plain
 * values through `classifyPointer`, not a DOM type.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import SystemInkLayer from "../src/svelte/SystemInkLayer.svelte";
import { closeSysInk, openSysInk, resetShellState } from "../src/svelte/shellState.svelte";

const settle = () => new Promise((r) => setTimeout(r, 0));

function pev(type: string, props: Record<string, unknown> = {}): PointerEvent {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, {
    pointerId: 1,
    pointerType: "pen",
    isPrimary: true,
    width: 1,
    height: 1,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    clientX: 0,
    clientY: 0,
    ...props,
  });
  return e as unknown as PointerEvent;
}

beforeEach(() => {
  window.localStorage.clear();
  resetShellState();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetShellState();
});

describe("SystemInkLayer.svelte", () => {
  test("draws nothing until the layer is raised", async () => {
    const { container } = render(SystemInkLayer);
    await tick();
    expect(container.querySelector('[data-testid="system-ink-layer"]')).toBeNull();

    openSysInk();
    await tick();
    expect(container.querySelector('[data-testid="system-ink-layer"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="system-ink-svg"]')).toBeTruthy();
  });

  test("a pen stroke lands as a path, undo removes it, redo brings it back", async () => {
    const { container } = render(SystemInkLayer);
    openSysInk();
    await tick();

    const svg = container.querySelector('[data-testid="system-ink-svg"]') as SVGSVGElement;
    const undo = container.querySelector('[data-testid="system-ink-undo"]') as HTMLButtonElement;
    const redo = container.querySelector('[data-testid="system-ink-redo"]') as HTMLButtonElement;

    // Nothing drawn yet: the history has no step to undo, and the toolbar says so.
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(true);

    // A pen down at (10,10), two moves ≥ the 0.75px jitter gate apart, then up.
    svg.dispatchEvent(pev("pointerdown", { clientX: 10, clientY: 10 }));
    await tick();
    svg.dispatchEvent(pev("pointermove", { clientX: 20, clientY: 20 }));
    await tick();
    svg.dispatchEvent(pev("pointermove", { clientX: 30, clientY: 30 }));
    await tick();
    svg.dispatchEvent(pev("pointerup", { clientX: 30, clientY: 30 }));
    await tick();

    // The live path is gone with the stroke (pointer-up cleared it), so every path left is a
    // committed stroke — that is what makes this count meaningful.
    const paths = () => svg.querySelectorAll("path").length;
    expect(paths()).toBe(1);
    expect(container.querySelector('[data-testid="system-ink-live"]')).toBeNull();
    expect(undo.disabled).toBe(false);

    await fireEvent.click(undo);
    await tick();
    expect(paths()).toBe(0);
    expect(undo.disabled).toBe(true); // back to the blank sheet — nothing left to undo
    expect(redo.disabled).toBe(false);

    await fireEvent.click(redo);
    await tick();
    expect(paths()).toBe(1);
    expect(redo.disabled).toBe(true);
  });

  test("the eraser removes a stroke it is dragged across", async () => {
    const { container } = render(SystemInkLayer);
    openSysInk();
    await tick();

    const svg = container.querySelector('[data-testid="system-ink-svg"]') as SVGSVGElement;
    const paths = () => svg.querySelectorAll("path").length;

    svg.dispatchEvent(pev("pointerdown", { clientX: 100, clientY: 100 }));
    await tick();
    svg.dispatchEvent(pev("pointermove", { clientX: 110, clientY: 100 }));
    await tick();
    svg.dispatchEvent(pev("pointerup", { clientX: 110, clientY: 100 }));
    await tick();
    expect(paths()).toBe(1);

    await fireEvent.click(container.querySelector('[data-testid="system-ink-eraser"]')!);
    await tick();

    // The eraser's hit test is segment-based (`strokeHitRadius`), so a contact on the segment —
    // not on a sample point — is what must erase it.
    svg.dispatchEvent(pev("pointerdown", { clientX: 105, clientY: 100 }));
    await tick();
    svg.dispatchEvent(pev("pointerup", { clientX: 105, clientY: 100 }));
    await tick();

    expect(paths()).toBe(0);
  });

  test("Clear is a step, and Done lowers the layer", async () => {
    const { container } = render(SystemInkLayer);
    openSysInk();
    await tick();

    const svg = container.querySelector('[data-testid="system-ink-svg"]') as SVGSVGElement;
    const clear = container.querySelector('[data-testid="system-ink-clear"]') as HTMLButtonElement;
    const undo = container.querySelector('[data-testid="system-ink-undo"]') as HTMLButtonElement;
    const redo = container.querySelector('[data-testid="system-ink-redo"]') as HTMLButtonElement;

    // Clear is disabled on an already-blank sheet: there is no drawing to remove.
    expect(clear.disabled).toBe(true);

    svg.dispatchEvent(pev("pointerdown", { clientX: 10, clientY: 10 }));
    await tick();
    svg.dispatchEvent(pev("pointermove", { clientX: 40, clientY: 10 }));
    await tick();
    svg.dispatchEvent(pev("pointerup", { clientX: 40, clientY: 10 }));
    await tick();
    expect(svg.querySelectorAll("path").length).toBe(1);
    expect(clear.disabled).toBe(false);

    await fireEvent.click(clear);
    await tick();
    expect(svg.querySelectorAll("path").length).toBe(0);
    expect(clear.disabled).toBe(true);
    // Clear really is undoable — the stroke comes back through the ordinary undo path.
    expect(undo.disabled).toBe(false);
    await fireEvent.click(undo);
    await tick();
    expect(svg.querySelectorAll("path").length).toBe(1);
    expect(redo.disabled).toBe(false);

    await fireEvent.click(container.querySelector('[data-testid="system-ink-done"]')!);
    await tick();
    expect(container.querySelector('[data-testid="system-ink-layer"]')).toBeNull();
  });

  test("the drawing survives a close/reopen within the run (scratch pad, not a discard)", async () => {
    const { container } = render(SystemInkLayer);
    openSysInk();
    await tick();

    const svg = container.querySelector('[data-testid="system-ink-svg"]') as SVGSVGElement;
    svg.dispatchEvent(pev("pointerdown", { clientX: 5, clientY: 5 }));
    await tick();
    svg.dispatchEvent(pev("pointermove", { clientX: 60, clientY: 5 }));
    await tick();
    svg.dispatchEvent(pev("pointerup", { clientX: 60, clientY: 5 }));
    await tick();
    expect(svg.querySelectorAll("path").length).toBe(1);

    closeSysInk();
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="system-ink-layer"]')).toBeNull();

    openSysInk();
    await tick();
    const reopened = container.querySelector('[data-testid="system-ink-svg"]') as SVGSVGElement;
    expect(reopened.querySelectorAll("path").length).toBe(1);
  });

  /**
   * A blank sheet has **one** definition, and the toolbar has to read that one.
   *
   * `commitSystemInk` folds `null` and a zero-stroke layer together (`inkEqual` — "the empty
   * sheet and the cleared sheet are one shape"), and `lib/ink.ts::noteHasInk` is the repo's
   * single predicate for "carries a drawing". But Clear was gated on `ink === null`, the
   * *never drawn* sentinel — and the eraser writes a **non-null, empty** layer (`eraseAt`
   * keeps a zero-stroke `Ink`). So a sheet the eraser just emptied is blank on screen while
   * Clear stays lit, and pressing it is a silent no-op (`inkEqual` folds it to the same
   * state) — the "a button that silently does nothing" shape this repo keeps removing
   * (REQ-A1701 ∕ F-SH-871).
   */
  test("Clear is unavailable once the eraser has emptied the sheet, not only when it was never drawn", async () => {
    const { container } = render(SystemInkLayer);
    openSysInk();
    await tick();

    const svg = container.querySelector('[data-testid="system-ink-svg"]') as SVGSVGElement;
    const clear = container.querySelector('[data-testid="system-ink-clear"]') as HTMLButtonElement;
    const undo = container.querySelector('[data-testid="system-ink-undo"]') as HTMLButtonElement;

    // Positive control: a drawn sheet *does* have something to clear (so a component that
    // disabled Clear unconditionally would fail here, not pass).
    svg.dispatchEvent(pev("pointerdown", { clientX: 100, clientY: 100 }));
    await tick();
    svg.dispatchEvent(pev("pointermove", { clientX: 140, clientY: 100 }));
    await tick();
    svg.dispatchEvent(pev("pointerup", { clientX: 140, clientY: 100 }));
    await tick();
    expect(svg.querySelectorAll("path").length).toBe(1);
    expect(clear.disabled).toBe(false);

    // The eraser empties the sheet — the same blankness, reached the other way.
    await fireEvent.click(container.querySelector('[data-testid="system-ink-eraser"]')!);
    await tick();
    svg.dispatchEvent(pev("pointerdown", { clientX: 120, clientY: 100 }));
    await tick();
    svg.dispatchEvent(pev("pointerup", { clientX: 120, clientY: 100 }));
    await tick();
    expect(svg.querySelectorAll("path").length).toBe(0); // blank on screen…
    expect(clear.disabled).toBe(true); // …so there is nothing to clear, and Clear must say so

    // The eraser's own pass is one undo step — Undo (not Clear) is what brings it back, so the
    // sheet did not become "never drawn".
    expect(undo.disabled).toBe(false);
    await fireEvent.click(undo);
    await tick();
    expect(svg.querySelectorAll("path").length).toBe(1);
  });
});
