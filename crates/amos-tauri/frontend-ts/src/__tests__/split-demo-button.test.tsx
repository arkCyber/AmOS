import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SplitDemoButton } from "../components/SplitDemoButton";
import type { LayoutSnapshot } from "../lib/wm";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleared: LayoutSnapshot = {
  screen_w: 1080,
  screen_h: 1920,
  split: null,
  candidates: ["maps", "notes"],
};

let invokes: string[] = [];
let respond: unknown;

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (command: string) => {
    invokes.push(command);
    return respond;
  },
  listen: async () => () => {},
};

let roots: Root[] = [];

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(<SplitDemoButton />);
  });
  return container;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function statusOf(container: HTMLElement): string | null {
  return container.querySelector("[data-status]")?.textContent ?? null;
}

afterEach(() => {
  act(() => {
    roots.forEach((r) => r.unmount());
  });
  roots = [];
  invokes = [];
  document.body.innerHTML = "";
});

describe("SplitDemoButton (dev trigger for wm_split_demo)", () => {
  test("clicking runs wm_split_demo and reports done", async () => {
    respond = cleared;
    const container = render();
    expect(statusOf(container)).toBe("idle");

    const btn = container.querySelector<HTMLButtonElement>("[data-demo]");
    expect(btn).not.toBeNull();
    act(() => {
      btn!.click();
    });
    await act(async () => {
      await flush();
    });

    expect(invokes).toContain("wm_split_demo");
    expect(statusOf(container)).toBe("done");
  });

  test("reports offline when the demo returns null", async () => {
    respond = null;
    const container = render();
    act(() => {
      container.querySelector<HTMLButtonElement>("[data-demo]")!.click();
    });
    await act(async () => {
      await flush();
    });
    expect(statusOf(container)).toBe("offline");
    expect(invokes).toContain("wm_split_demo");
  });
});
