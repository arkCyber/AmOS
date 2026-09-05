import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SplitFrame } from "../components/SplitFrame";
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

const fullScreenSnap: LayoutSnapshot = {
  screen_w: 800,
  screen_h: 1000,
  split: null,
  candidates: [],
};

let roots: Root[] = [];

function mount(node: ReactNode): { container: HTMLElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(node);
  });
  return { container };
}

function surfaces(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll("[data-surface]"));
}

function surfaceStyle(container: HTMLElement, label: string): Record<string, string> {
  const el = container.querySelector<HTMLElement>(`[data-surface="${label}"]`);
  expect(el).not.toBeNull();
  return {
    left: el!.style.left,
    top: el!.style.top,
    width: el!.style.width,
    height: el!.style.height,
  };
}

afterEach(() => {
  act(() => {
    roots.forEach((r) => r.unmount());
  });
  roots = [];
  document.body.innerHTML = "";
});

describe("SplitFrame (renders the split side by side)", () => {
  test("mounts only the two split windows, positioned by their panes", () => {
    const { container } = mount(
      <SplitFrame
        snapshot={splitSnap}
        surfaces={["notes", "maps", "photos"]} // photos is NOT in the split
        render={(label) => <span>app:{label}</span>}
      />,
    );

    const mounted = surfaces(container).map((el) => el.dataset.surface);
    expect(mounted).toEqual(["notes", "maps"]);
    expect(container.querySelector('[data-surface="photos"]')).toBeNull();

    // notes in the left pane (430px), maps in the right pane at x=438.
    expect(surfaceStyle(container, "notes")).toEqual({
      left: "0px",
      top: "0px",
      width: "430px",
      height: "1920px",
    });
    expect(surfaceStyle(container, "maps")).toEqual({
      left: "438px",
      top: "0px",
      width: "642px",
      height: "1920px",
    });
  });

  test("fullscreen snapshot renders the single surface filling the stage", () => {
    const { container } = mount(
      <SplitFrame
        snapshot={fullScreenSnap}
        surfaces={["notes"]}
        render={(label) => <span>app:{label}</span>}
      />,
    );

    expect(surfaces(container).map((el) => el.dataset.surface)).toEqual(["notes"]);
    expect(surfaceStyle(container, "notes")).toEqual({
      left: "0px",
      top: "0px",
      width: "800px",
      height: "1000px",
    });
  });
});
