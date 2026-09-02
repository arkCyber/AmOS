import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useFocusTrap } from "../lib/useFocusTrap";

// happy-dom may already be registered by another DOM test file in this process.
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Modal({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(true, ref, onClose);
  return (
    <div ref={ref} data-testid="modal">
      <button>First</button>
      <button>Last</button>
    </div>
  );
}

function escapeKey() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}
function tabKey() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
}

describe("useFocusTrap (DOM)", () => {
  test("focuses the first element and wraps Tab, and Escape calls onClose", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const el = document.getElementById("root") as HTMLElement;
    const root = createRoot(el);
    const closed: string[] = [];
    await act(async () => {
      root.render(<Modal onClose={() => closed.push("x")} />);
    });
    const buttons = Array.from(el.querySelectorAll("button")) as HTMLElement[];
    expect(buttons.length).toBe(2);
    expect(document.activeElement).toBe(buttons[0]); // first focused on mount

    buttons[1].focus(); // user tabs to the last
    tabKey(); // Tab from last wraps to first
    expect(document.activeElement).toBe(buttons[0]);

    escapeKey(); // Escape closes
    expect(closed).toEqual(["x"]);
    root.unmount();
  });
});
