import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  admitNavKey,
  mapHardwareAction,
  mapKeyAction,
  startOsInputBridge,
} from "../svelte/osInputBridge";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("osInputBridge — React-free shell event mapping", () => {
  test("mapHardwareAction maps home/back → home, ai/voice → ai", () => {
    expect(mapHardwareAction("home")).toBe("home");
    expect(mapHardwareAction("HOME")).toBe("home");
    expect(mapHardwareAction("back")).toBe("home");
    expect(mapHardwareAction("ai")).toBe("ai");
    expect(mapHardwareAction("voice")).toBe("ai");
    expect(mapHardwareAction("assistant")).toBe("ai");
    // Rust serializes the AiAssistant button as "ai_assistant" (see buttons.rs).
    expect(mapHardwareAction("ai_assistant")).toBe("ai");
    expect(mapHardwareAction("")).toBeNull();
    expect(mapHardwareAction(null)).toBeNull();
    expect(mapHardwareAction("settings")).toBeNull();
  });

  test("mapKeyAction wires the H/V/A desktop shortcuts (lib/systemButtons)", () => {
    // Regression guard: keydown used to go through mapHardwareAction, which never
    // matched the single-letter shortcuts, so H/V/A silently did nothing.
    expect(mapKeyAction("h")).toBe("home");
    expect(mapKeyAction("H")).toBe("home");
    expect(mapKeyAction("v")).toBe("ai");
    expect(mapKeyAction("a")).toBe("ai");
    // Synthesized keydowns carrying a button name still navigate.
    expect(mapKeyAction("home")).toBe("home");
    expect(mapKeyAction("ai_assistant")).toBe("ai");
    expect(mapKeyAction("x")).toBeNull();
    expect(mapKeyAction(null)).toBeNull();
  });
});

/**
 * REQ-A1413 ∕ FMEA F-SH-671 — the H/V/A shortcuts are **bare letters**, so without an
 * admission gate they fired *while the user was typing*: `keyActionOf` reads the key alone
 * and lowercases it, ignoring both the modifiers and the event target. Measured before the
 * fix (happy-dom, real listeners): `a` typed into a focused `<input>` called `onNav("ai")`,
 * `h` called `onNav("home")`, and ⌘A / Ctrl+A did the same.
 *
 * The shell's own handler (`Shell.svelte`) never had this bug — every intent it resolves is
 * a **chord** — but it carries the first three stand-downs below, and they are the same rule.
 */
describe("osInputBridge — a bare-letter shortcut must not fire while typing (REQ-A1413)", () => {
  const ev = (over: Partial<Parameters<typeof admitNavKey>[0]> = {}) =>
    ({ key: "a", ...over }) as Parameters<typeof admitNavKey>[0];

  const input = (tag = "input"): HTMLElement => {
    const el = document.createElement(tag);
    document.body.appendChild(el);
    return el;
  };

  test("admitNavKey: a bare letter on a non-editable target is ours", () => {
    expect(admitNavKey(ev())).toBe(true);
    expect(admitNavKey(ev({ target: null }))).toBe(true);
    expect(admitNavKey(ev({ target: document.body }))).toBe(true);
    expect(admitNavKey(ev({ target: window }))).toBe(true);
    // The physical Home key rides the same bridge and must stay admitted.
    expect(admitNavKey(ev({ key: "Home", target: document.body }))).toBe(true);
  });

  test("admitNavKey: a text-field target stands the shortcut down", () => {
    expect(admitNavKey(ev({ target: input("input") }))).toBe(false);
    expect(admitNavKey(ev({ target: input("textarea") }))).toBe(false);
    expect(admitNavKey(ev({ target: input("select") }))).toBe(false);
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.appendChild(editable);
    expect(admitNavKey(ev({ target: editable }))).toBe(false);
  });

  test("admitNavKey: any modifier, composition, repeat or a claimed event stands it down", () => {
    // ⇧A is how a real keyboard reports a capital A — still typing.
    expect(admitNavKey(ev({ shiftKey: true }))).toBe(false);
    expect(admitNavKey(ev({ metaKey: true }))).toBe(false);
    expect(admitNavKey(ev({ ctrlKey: true }))).toBe(false);
    expect(admitNavKey(ev({ altKey: true }))).toBe(false);
    expect(admitNavKey(ev({ isComposing: true }))).toBe(false);
    expect(admitNavKey(ev({ key: "Process" }))).toBe(false);
    expect(admitNavKey(ev({ repeat: true }))).toBe(false);
    expect(admitNavKey(ev({ defaultPrevented: true }))).toBe(false);
  });

  const keydown = (target: EventTarget, key: string, init: Record<string, unknown> = {}) => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    for (const [k, v] of Object.entries(init)) {
      try {
        Object.defineProperty(e, k, { value: v, configurable: true });
      } catch {
        /* happy-dom already set it */
      }
    }
    target.dispatchEvent(e);
    return e;
  };

  test("the wired listener: typing `a` / `h` in a real text field does not navigate", () => {
    const box = input("input") as HTMLInputElement;
    box.focus();
    const navs: string[] = [];
    const stop = startOsInputBridge({ onNav: (a) => navs.push(a) });
    try {
      keydown(box, "a");
      keydown(box, "h");
      keydown(box, "v");
      keydown(box, "a", { metaKey: true }); // ⌘A = select all, not "AI"
      keydown(box, "a", { shiftKey: true }); // ⇧A = a capital A
      expect(navs, "打字时的每一次按键都不是导航").toEqual([]);
    } finally {
      stop();
    }
    // Contrast in the same leaf: the shortcut still works away from a text field.
    const after: string[] = [];
    const stop2 = startOsInputBridge({ onNav: (a) => after.push(a) });
    try {
      keydown(document.body, "a");
      keydown(document.body, "h");
    } finally {
      stop2();
    }
    expect(after).toEqual(["ai", "home"]);
  });

  test("the wired listener: a chord is not a bare-letter shortcut, even off a text field", () => {
    const navs: string[] = [];
    const stop = startOsInputBridge({ onNav: (a) => navs.push(a) });
    try {
      keydown(document.body, "a", { metaKey: true });
      keydown(document.body, "a", { ctrlKey: true });
      keydown(document.body, "a", { altKey: true });
      expect(navs).toEqual([]);
    } finally {
      stop();
    }
  });

  test("the wired listener: the physical Home key still navigates home", () => {
    const navs: string[] = [];
    const stop = startOsInputBridge({ onNav: (a) => navs.push(a) });
    try {
      keydown(document.body, "Home");
      expect(navs).toEqual(["home"]);
    } finally {
      stop();
    }
    // …and stop() really unsubscribes.
    keydown(document.body, "Home");
    expect(navs).toEqual(["home"]);
  });
});
