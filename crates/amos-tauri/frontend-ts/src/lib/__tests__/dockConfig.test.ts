import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  dockCapacityExtent,
  dockHideTransform,
  dockIsVertical,
  dockMagnifyAxis,
  dockPanelStyle,
  dockPositionClass,
  dockRevealZone,
  dockWrapperStyle,
  emitDockBounce,
  isFullscreen,
  onDockBounce,
  type DockPosition,
} from "../dockConfig";
import { DOCK_HEIGHT, DOCK_MIN_WIDTH, TOPBAR_HEIGHT } from "../desktopLayout";

beforeAll(() => {
  GlobalRegistrator.register();
});

describe("dockPositionClass", () => {
  it("returns bottom classes for 'bottom'", () => {
    expect(dockPositionClass("bottom")).toBe("bottom-0 left-0 right-0 justify-center");
  });

  it("returns left classes for 'left'", () => {
    // REQ-A414: `top-[24px]` / `bottom-0` moved to `dockWrapperStyle`; keeping them in
    // BOTH places is what over-constrained the side dock's box (CSS dropped `bottom`).
    expect(dockPositionClass("left")).toBe("left-0 justify-start");
  });

  it("returns right classes for 'right'", () => {
    expect(dockPositionClass("right")).toBe("right-0 justify-end");
  });

  it("exhaustiveness — adding a new DockPosition causes a type error", () => {
    // The function body has no `default:`. If DockPosition gets a new member
    // (e.g. "top"), svelte-check will report a non-exhaustive switch. This
    // test merely documents the contract; the real check is the type system.
    const positions: DockPosition[] = ["bottom", "left", "right"];
    expect(positions).toHaveLength(3);
  });
});

describe("dock geometry per edge (REQ-A414)", () => {
  it("'vertical' is exactly the two side edges", () => {
    expect(dockIsVertical("bottom")).toBe(false);
    expect(dockIsVertical("left")).toBe(true);
    expect(dockIsVertical("right")).toBe(true);
  });

  it("the wrapper is a 68px bar at the bottom, a full-height column on a side", () => {
    expect(dockWrapperStyle("bottom")).toBe(`height:${DOCK_HEIGHT}px;`);
    // `top` + `bottom` (and NO fixed height): the three-way constraint is what CSS
    // resolves by dropping `bottom`.
    expect(dockWrapperStyle("left")).toBe(`top:${TOPBAR_HEIGHT}px; bottom:0;`);
    expect(dockWrapperStyle("right")).toBe(`top:${TOPBAR_HEIGHT}px; bottom:0;`);
    for (const wrong of [`height:${DOCK_HEIGHT}px;`]) {
      expect(dockWrapperStyle("left")).not.toContain(wrong);
    }
  });

  it("the panel's minimum box follows the axis (min-width vs min-height)", () => {
    expect(dockPanelStyle("bottom")).toBe(`min-width:${DOCK_MIN_WIDTH}px;`);
    // A side dock is as narrow as the bar is tall — 320px would be wrong.
    expect(dockPanelStyle("left")).toBe(`min-height:${DOCK_MIN_WIDTH}px;`);
    expect(dockPanelStyle("right")).toBe(`min-height:${DOCK_MIN_WIDTH}px;`);
    expect(dockPanelStyle("left")).not.toContain("min-width");
  });

  it("the hide transform slides off the dock's OWN edge", () => {
    for (const p of ["bottom", "left", "right"] as const) {
      expect(dockHideTransform(p, false)).toBe("translate(0, 0)");
    }
    expect(dockHideTransform("bottom", true)).toBe("translateY(100%)");
    expect(dockHideTransform("left", true)).toBe("translateX(-100%)");
    expect(dockHideTransform("right", true)).toBe("translateX(100%)");
  });

  it("the magnifier tracks X along a bottom bar and Y along a side column", () => {
    expect(dockMagnifyAxis("bottom")).toBe("x");
    expect(dockMagnifyAxis("left")).toBe("y");
    expect(dockMagnifyAxis("right")).toBe("y");
  });

  it("the reveal zone follows the edge the dock hides behind", () => {
    const W = 1000;
    const H = 800;
    // bottom: the last 80px of the height
    expect(dockRevealZone("bottom", 500, H - 10, W, H)).toBe(true);
    expect(dockRevealZone("bottom", 500, H - 100, W, H)).toBe(false);
    // left: the first 80px of the width (this is the dead-end the old bottom-only
    // check left behind)
    expect(dockRevealZone("left", 10, 400, W, H)).toBe(true);
    expect(dockRevealZone("left", 200, H - 10, W, H)).toBe(false);
    // right: the last 80px of the width
    expect(dockRevealZone("right", W - 10, 400, W, H)).toBe(true);
    expect(dockRevealZone("right", 200, 400, W, H)).toBe(false);
    // a custom threshold is honoured
    expect(dockRevealZone("left", 150, 400, W, H, 200)).toBe(true);
  });

  it("capacity is measured along the dock's long edge", () => {
    expect(dockCapacityExtent("bottom", 900, 68)).toBe(900);
    expect(dockCapacityExtent("left", 68, 600)).toBe(600);
    expect(dockCapacityExtent("right", 68, 600)).toBe(600);
  });
});

describe("isFullscreen", () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(document, "fullscreenElement");

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(document, "fullscreenElement", originalDescriptor);
    }
  });

  it("returns true when document.fullscreenElement is set", () => {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: document.createElement("div"),
    });
    expect(isFullscreen()).toBe(true);
  });

  it("returns false when document.fullscreenElement is null", () => {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: null,
    });
    expect(isFullscreen()).toBe(false);
  });
});

describe("bounce event bus", () => {
  // Each test installs a listener that returns a cleanup; running the
  // cleanups here means the global `dock-bounce` listener pool stays empty
  // between tests.
  afterEach(() => {
    // No global restoration needed: each test owns its own listener + cleanup.
  });

  it("emitDockBounce fires a CustomEvent with the right detail", () => {
    const seen: Array<{ appId: string }> = [];
    const off = onDockBounce("*", (id) => seen.push({ appId: id }));

    emitDockBounce("messages");
    emitDockBounce("contacts");

    expect(seen).toEqual([{ appId: "messages" }, { appId: "contacts" }]);
    off();
  });

  it("filters events by appId", () => {
    const seen: string[] = [];
    const off = onDockBounce("messages", (id) => seen.push(id));

    emitDockBounce("messages");
    emitDockBounce("contacts");
    emitDockBounce("messages");

    expect(seen).toEqual(["messages", "messages"]);
    off();
  });

  it("the cleanup function actually unsubscribes", () => {
    const seen: string[] = [];
    const off = onDockBounce("messages", (id) => seen.push(id));
    off();

    emitDockBounce("messages");
    expect(seen).toEqual([]);
  });

  it("ignores malformed events without detail.appId", () => {
    const seen: string[] = [];
    const off = onDockBounce("*", (id) => seen.push(id));

    window.dispatchEvent(new CustomEvent("dock-bounce", { detail: undefined }));
    window.dispatchEvent(new CustomEvent("dock-bounce", { detail: {} }));

    expect(seen).toEqual([]);
    off();
  });
});
