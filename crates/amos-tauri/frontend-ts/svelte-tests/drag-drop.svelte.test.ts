/**
 * drag-drop.svelte.test.ts — cross-app drag & drop (REQ-A683).
 *
 * Exercises the shell half end-to-end without a real app pane: a `[data-drop-app]`
 * element stands in for a pane, `document.elementFromPoint` is pointed at it, and the
 * window pointer events the ghost listens on are dispatched for real. What is checked
 * is the promise: an accepted drop **hands the payload to the target app** (its link
 * channel gets it and the surface switches), and a refused drop hands over **nothing**
 * while saying why.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import DragGhost from "../src/svelte/DragGhost.svelte";
import { cancelDrag, dragSession, startDrag } from "../src/svelte/dragSession.svelte";
import { performDrop } from "../src/svelte/dropActions";
import { messagesChannel, notesChannel, phoneChannel } from "../src/svelte/appLinks";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { resetShellState, surface } from "../src/svelte/shellState.svelte";
import { makePhonePayload, makeTextPayload } from "../src/lib/dragDrop";
import { zh } from "../src/i18n/locales/zh";

let pane: HTMLElement;

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  resetShellState();
  cancelDrag();
});

afterEach(() => {
  cancelDrag();
  resetPropsChannels();
  resetShellState();
  pane?.remove();
  vi.restoreAllMocks();
});

/** Mount the ghost and a stand-in pane whose app id is `app`. */
async function mount(app: string) {
  const { container } = render(DragGhost);
  pane = document.createElement("div");
  pane.setAttribute("data-drop-app", app);
  document.body.appendChild(pane);
  vi.spyOn(document, "elementFromPoint").mockReturnValue(pane);
  await tick();
  return container;
}

const move = async (x = 40, y = 40) => {
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }));
  await tick();
};
const release = async () => {
  window.dispatchEvent(new MouseEvent("pointerup"));
  await tick();
};

describe("cross-app drag & drop — the shell", () => {
  test("no drag ⇒ no ghost", async () => {
    const c = await mount("messages");
    expect(c.querySelector('[data-testid="drag-ghost"]')).toBeNull();
  });

  test("a phone number dropped on Messages prefills the composer and opens it", async () => {
    const c = await mount("messages");
    startDrag(makePhonePayload("10086", "客服")!, "contacts", 5, 5);
    await tick();
    expect(c.querySelector('[data-testid="drag-ghost"]')).toBeTruthy();

    await move();
    expect(c.querySelector('[data-testid="drag-ghost"]')?.getAttribute("data-drop-state")).toBe(
      "accept",
    );

    await release();
    expect(messagesChannel().get()?.composeTo).toBe("10086");
    expect(surface().id).toBe("messages");
    // The session is over: the ghost unmounted.
    expect(c.querySelector('[data-testid="drag-ghost"]')).toBeNull();
  });

  test("a note's text dropped on the AI app attaches it as context", async () => {
    const c = await mount("ai");
    startDrag(makeTextPayload("buy milk", "Shopping")!, "notes", 5, 5);
    await tick();
    await move();
    expect(c.querySelector('[data-testid="drag-ghost"]')?.getAttribute("data-drop-state")).toBe(
      "accept",
    );
    await release();
    // sendToAi switches to the AI surface (the attach itself is a host call).
    expect(surface().id).toBe("ai");
  });

  test("dropping back on the source app refuses and hands over nothing", async () => {
    const c = await mount("contacts");
    startDrag(makePhonePayload("10086")!, "contacts", 5, 5);
    await tick();
    await move();
    const ghost = c.querySelector('[data-testid="drag-ghost"]');
    expect(ghost?.getAttribute("data-drop-state")).toBe("reject");
    expect(c.querySelector('[data-testid="drag-ghost-hint"]')?.textContent?.trim()).toBe(
      zh["drag.rejectSameApp"],
    );
    await release();
    expect(messagesChannel().get()).toBeUndefined();
    expect(surface().id).not.toBe("messages");
  });

  test("dropping a number on an app that cannot take it refuses, naming the reason", async () => {
    const c = await mount("ai");
    startDrag(makePhonePayload("10086")!, "contacts", 5, 5);
    await tick();
    await move();
    expect(c.querySelector('[data-testid="drag-ghost"]')?.getAttribute("data-drop-state")).toBe(
      "reject",
    );
    expect(c.querySelector('[data-testid="drag-ghost-hint"]')?.textContent?.trim()).toBe(
      zh["drag.rejectUnsupported"],
    );
    await release();
    expect(surface().id).not.toBe("ai");
  });

  test("over nothing the chip invites a target; Escape aborts without a hand-off", async () => {
    const c = await mount("messages");
    vi.spyOn(document, "elementFromPoint").mockReturnValue(null);
    startDrag(makeTextPayload("hello")!, "notes", 5, 5);
    await tick();
    await move();
    expect(c.querySelector('[data-testid="drag-ghost-hint"]')?.textContent?.trim()).toBe(
      zh["drag.dropHint"],
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    expect(dragSession()).toBeNull();
    expect(notesChannel().get()).toBeUndefined();
  });

  test("a drop of note text on Notes prefills a draft without creating a note", async () => {
    await mount("notes");
    startDrag(makeTextPayload("draft body", "Title")!, "ai", 5, 5);
    await tick();
    await move();
    await release();
    const link = notesChannel().get();
    expect(link?.draftText).toBe("draft body");
    expect(link?.noteId).toBe("");
  });

  /**
   * The adapter's own contract (REQ-A1557 ∕ F-SH-791). `performDrop` documents that it
   * "returns whether a hand-off actually happened", but its `new-note` arm hard-coded
   * `true` over a callee that refuses an empty body by silently returning — so the one
   * thing the return value exists to distinguish was the one thing it got wrong. Called
   * directly with an un-normalized payload, exactly as the sheet's Mail refusal test
   * calls `deliver`: the ghost cannot build a blank payload (`makeTextPayload` refuses
   * one), so this is the only seam that can exercise the branch at all.
   */
  test("the new-note adapter reports a refused empty hand-off, not a success", () => {
    expect(performDrop({ kind: "text", text: "   " }, "new-note")).toBe(false);
    expect(notesChannel().get()).toBeUndefined();
    // Positive control: the same verb with real text still hands the draft over.
    expect(performDrop({ kind: "text", text: "real body" }, "new-note")).toBe(true);
    expect(notesChannel().get()?.draftText).toBe("real body");
  });

  /**
   * The same contract, in the three arms that were left by hand (REQ-A1650 ∕ F-SH-840).
   * `performDrop` documents "returns whether a hand-off actually happened" and its
   * `new-note` arm above reads its callee's verdict — but `compose-sms`, `dial` and
   * `ai-context` each hard-coded `true` over a callee that refuses an empty payload by
   * silently returning (`composeSmsTo` / `dialNumber` / `sendToAi`, all `void` until this
   * round). The payload is passed un-normalized on purpose: `makePhonePayload` already
   * refuses a blank number, so no drop the ghost can build reaches these refusals — the
   * round completes a documented contract, which is why the honest boundary is stated
   * here rather than a user-visible fault being claimed.
   */
  test("the phone and AI adapters report a refused empty hand-off too", () => {
    expect(performDrop({ kind: "phone", number: "   " }, "compose-sms")).toBe(false);
    expect(messagesChannel().get()).toBeUndefined();
    expect(performDrop({ kind: "phone", number: "   " }, "dial")).toBe(false);
    expect(phoneChannel().get()).toBeUndefined();
    expect(performDrop({ kind: "text", text: "   " }, "ai-context")).toBe(false);
    expect(surface().id).not.toBe("ai");

    // Positive controls: the same verbs with real values still hand over.
    expect(performDrop({ kind: "phone", number: "10086" }, "compose-sms")).toBe(true);
    expect(messagesChannel().get()?.composeTo).toBe("10086");
    expect(performDrop({ kind: "phone", number: "10010" }, "dial")).toBe(true);
    expect(phoneChannel().get()?.number).toBe("10010");
    expect(performDrop({ kind: "text", text: "real context" }, "ai-context")).toBe(true);
    expect(surface().id).toBe("ai");
  });
});
