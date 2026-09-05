import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useWindowLayout } from "../lib/useWindowLayout";
import type { LayoutSnapshot } from "../lib/wm";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const splitSnap: LayoutSnapshot = {
  screen_w: 1080,
  screen_h: 1920,
  split: {
    axis: "vertical",
    percent: 50,
    primary: "notes",
    secondary: "maps",
    panes: [
      { label: "notes", x: 0, y: 0, width: 536, height: 1920 },
      { label: "maps", x: 544, y: 0, width: 536, height: 1920 },
    ],
  },
  candidates: ["maps", "notes"],
};

const fullScreenSnap: LayoutSnapshot = {
  screen_w: 1080,
  screen_h: 1920,
  split: null,
  candidates: [],
};

const byCommand: Record<string, LayoutSnapshot> = {
  wm_layout_snapshot: splitSnap,
  wm_split_exit: fullScreenSnap,
};

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (command: string) => byCommand[command] ?? null,
  listen: async () => () => {},
};

function Harness() {
  const { snapshot, actions } = useWindowLayout();
  return (
    <div>
      <span data-layout>{snapshot ? (snapshot.split ? "split" : "full") : "none"}</span>
      <button
        data-exit
        onClick={() => {
          void actions.exit();
        }}
      >
        exit
      </button>
    </div>
  );
}

let roots: Root[] = [];

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(<Harness />);
  });
  return container;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function layoutOf(container: HTMLElement): string | null {
  return container.querySelector("[data-layout]")?.textContent ?? null;
}

afterEach(() => {
  act(() => {
    roots.forEach((r) => r.unmount());
  });
  roots = [];
  document.body.innerHTML = "";
});

describe("useWindowLayout drives layout state end to end", () => {
  test("loads a split on mount, then an exit action moves to fullscreen", async () => {
    const container = render();
    // Let the mount effect's wm_layout_snapshot round-trip resolve.
    await act(async () => {
      await flush();
    });
    expect(layoutOf(container)).toBe("split");

    const exitBtn = container.querySelector<HTMLButtonElement>("[data-exit]");
    expect(exitBtn).not.toBeNull();
    act(() => {
      exitBtn!.click();
    });
    // Let the wm_split_exit round-trip resolve and update state.
    await act(async () => {
      await flush();
    });
    expect(layoutOf(container)).toBe("full");
  });
});
