import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { moveBefore, type HomeLayout } from "../lib/amosStore";
import HomeDock from "../components/HomeDock";
import { I18nProvider } from "../i18n";

// Bring up a real DOM for this file (globals are per-process in bun).
// happy-dom may already be registered by another DOM test file in this process.
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
// Silence React's act(...) environment warning.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Dock({ initial }: { initial: HomeLayout }) {
  const dragId = useRef<string | null>(null);
  const [state, setState] = useState(initial);
  return (
    <div data-testid="dock">
      {state.dock.map((id) => (
        <button
          key={id}
          data-id={id}
          draggable
          onDragStart={(e) => {
            dragId.current = e.currentTarget.dataset.id ?? null;
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const target = e.currentTarget.dataset.id ?? null;
            const drag = dragId.current;
            if (drag && target && drag !== target) setState(moveBefore(state, drag, target));
          }}
        >
          {id}
        </button>
      ))}
    </div>
  );
}

describe("Dock drag reorder (DOM smoke)", () => {
  test("dragging dock icon over another reorders via moveBefore", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const el = document.getElementById("root") as HTMLElement;
    const root = createRoot(el);
    const layout: HomeLayout = { page: [], dock: ["a", "b", "c"], hidden: [] };
    await act(async () => {
      root.render(<Dock initial={layout} />);
    });
    const order = () =>
      Array.from(el.querySelectorAll("button[data-id]")).map((b) => (b as HTMLElement).dataset.id);
    expect(order()).toEqual(["a", "b", "c"]);

    const src = el.querySelector('button[data-id="a"]') as HTMLElement;
    const dst = el.querySelector('button[data-id="c"]') as HTMLElement;
    // Emulate HTML5 drag: dragstart on source, dragover+drop on target.
    src.dispatchEvent(new Event("dragstart", { bubbles: true }));
    dst.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    dst.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await act(async () => {});
    expect(order()).toEqual(["b", "a", "c"]);

    root.unmount();
  });

  test("real HomeDock reports a drag/drop via onMove(drag, over)", async () => {
    document.body.innerHTML = '<div id="root2"></div>';
    const el = document.getElementById("root2") as HTMLElement;
    const root = createRoot(el);
    const layout: HomeLayout = { page: [], dock: ["clock", "settings", "calculator"], hidden: [] };
    const moved: string[][] = [];
    await act(async () => {
      root.render(
        <I18nProvider>
          <HomeDock layout={layout} onOpen={() => {}} onMove={(d, o) => moved.push([d, o])} />
        </I18nProvider>,
      );
    });
    const src = el.querySelector('button[aria-label="时钟"]') as HTMLElement;
    const dst = el.querySelector('button[aria-label="计算器"]') as HTMLElement;
    expect(src && dst, "clock and calculator dock icons rendered").toBeTruthy();
    src.dispatchEvent(new Event("dragstart", { bubbles: true }));
    dst.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    dst.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await act(async () => {});
    expect(moved).toEqual([["clock", "calculator"]]);
    root.unmount();
  });

  test("an accidental tap while dragging does not open the app", async () => {
    document.body.innerHTML = '<div id="root3"></div>';
    const el = document.getElementById("root3") as HTMLElement;
    const root = createRoot(el);
    const layout: HomeLayout = { page: [], dock: ["clock", "settings"], hidden: [] };
    const opened: string[] = [];
    await act(async () => {
      root.render(
        <I18nProvider>
          <HomeDock layout={layout} onOpen={(id) => opened.push(id)} onMove={() => {}} />
        </I18nProvider>,
      );
    });
    const clock = el.querySelector('button[aria-label="时钟"]') as HTMLElement;
    clock.dispatchEvent(new Event("dragstart", { bubbles: true }));
    clock.dispatchEvent(new Event("click", { bubbles: true })); // accidental tap mid-drag
    expect(opened).toEqual([]);
    // A clean tap (no drag) still opens.
    const settings = el.querySelector('button[aria-label="设置"]') as HTMLElement;
    settings.dispatchEvent(new Event("click", { bubbles: true }));
    expect(opened).toEqual(["settings"]);
    root.unmount();
  });
});
