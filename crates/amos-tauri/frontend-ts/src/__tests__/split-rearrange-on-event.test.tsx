import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SplitFrame } from "../components/SplitFrame";
import { LAYOUT_CHANGED_EVENT, type LayoutSnapshot } from "../lib/wm";
import { useWindowLayout } from "../lib/useWindowLayout";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (e: { payload: unknown }) => void;
let listeners = new Map<string, Listener>();
let invokes: string[] = [];

// notes is primary (left pane); maps is secondary (right pane).
const notesPrimary: LayoutSnapshot = {
  screen_w: 1080,
  screen_h: 1920,
  split: {
    axis: "vertical",
    percent: 40,
    primary: "notes",
    secondary: "maps",
    panes: [
      { label: "notes", x: 0, y: 0, width: 430, height: 1920 },
      { label: "maps", x: 438, y: 0, width: 642, height: 1920 },
    ],
  },
  candidates: ["maps", "notes"],
};

// A host broadcast swaps the primary pane to maps.
const mapsPrimary: LayoutSnapshot = {
  screen_w: 1080,
  screen_h: 1920,
  split: {
    axis: "vertical",
    percent: 40,
    primary: "maps",
    secondary: "notes",
    panes: [
      { label: "maps", x: 0, y: 0, width: 430, height: 1920 },
      { label: "notes", x: 438, y: 0, width: 642, height: 1920 },
    ],
  },
  candidates: ["maps", "notes"],
};

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (command: string) => {
    invokes.push(command);
    if (command === "wm_layout_snapshot") return notesPrimary;
    return null;
  },
  listen: async (channel: string, handler: Listener) => {
    listeners.set(channel, handler);
    return () => {
      listeners.delete(channel);
    };
  },
};

function Harness() {
  const { snapshot } = useWindowLayout();
  return snapshot ? (
    <SplitFrame snapshot={snapshot} surfaces={["notes", "maps"]} render={(l) => <span>{l}</span>} />
  ) : null;
}

let roots: Root[] = [];

function render(): { container: HTMLElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(<Harness />);
  });
  return { container };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function style(container: HTMLElement, label: string): Record<string, string> {
  const el = container.querySelector<HTMLElement>(`[data-surface="${label}"]`);
  expect(el).not.toBeNull();
  return {
    left: el!.style.left,
    width: el!.style.width,
  };
}

afterEach(() => {
  act(() => {
    roots.forEach((r) => r.unmount());
  });
  roots = [];
  listeners = new Map();
  document.body.innerHTML = "";
});

describe("surfaces rearrange themselves on layout-changed", () => {
  test("a host broadcast swaps panes with no extra command", async () => {
    invokes = [];
    const { container } = render();
    await act(async () => {
      await flush();
    });

    // Initial load: notes is the left (primary) pane.
    expect(style(container, "notes")).toEqual({ left: "0px", width: "430px" });
    expect(style(container, "maps")).toEqual({ left: "438px", width: "642px" });

    // The host broadcasts a swap (e.g. another window called wm_split_swap).
    const fire = listeners.get(LAYOUT_CHANGED_EVENT);
    expect(fire).toBeDefined();
    act(() => {
      fire!({ payload: mapsPrimary });
    });
    await act(async () => {
      await flush();
    });

    // Both surfaces rearranged themselves to their new panes…
    expect(style(container, "maps")).toEqual({ left: "0px", width: "430px" });
    expect(style(container, "notes")).toEqual({ left: "438px", width: "642px" });
    // …without issuing any layout command (only the initial snapshot read).
    expect(invokes).toEqual(["wm_layout_snapshot"]);
  });
});
