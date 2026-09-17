import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  dockPositionClass,
  emitDockBounce,
  isFullscreen,
  onDockBounce,
  type DockPosition,
} from "../dockConfig";

beforeAll(() => {
  GlobalRegistrator.register();
});

describe("dockPositionClass", () => {
  it("returns bottom classes for 'bottom'", () => {
    expect(dockPositionClass("bottom")).toBe("bottom-0 left-0 right-0 justify-center");
  });

  it("returns left classes for 'left'", () => {
    expect(dockPositionClass("left")).toBe("left-0 top-[24px] bottom-0 justify-start");
  });

  it("returns right classes for 'right'", () => {
    expect(dockPositionClass("right")).toBe("right-0 top-[24px] bottom-0 justify-end");
  });

  it("exhaustiveness — adding a new DockPosition causes a type error", () => {
    // The function body has no `default:`. If DockPosition gets a new member
    // (e.g. "top"), svelte-check will report a non-exhaustive switch. This
    // test merely documents the contract; the real check is the type system.
    const positions: DockPosition[] = ["bottom", "left", "right"];
    expect(positions).toHaveLength(3);
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
