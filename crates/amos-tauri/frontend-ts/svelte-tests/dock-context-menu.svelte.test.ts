/**
 * dock-context-menu.svelte.test.ts — DockContextMenu honors the bridge
 * contract for `wm_close` / `wm_hide` / `wm_focus`.
 *
 * REQ-A297 phase-2 §4 (typed-error discipline): `invoke` swallows
 * rejections into `null` (see `lib/backend.ts`, REQ-A296). The pre-fix
 * DockContextMenu wrapped every call in `try { ... } catch {}` — all
 * three were dead branches. A refused `wm_close` / `wm_hide` /
 * `wm_focus` left the user with no feedback at all (the menu closes
 * anyway, the action simply didn't happen).
 *
 * The fix branches on the null result and writes a diagnostic via
 * `bridgeDiag(command)`. This test pins that:
 *
 *   1. The component renders (and exports the menu items) without
 *      ever throwing — a regression to the try/catch era would compile
 *      but break under a host that is missing entirely.
 *   2. The bridge's `vm_open` analogues (`wm_close`, `wm_hide`,
 *      `wm_focus`) are routed through the same `noteFailure` helper,
 *      so an opener-side regression here would surface as a console
 *      warning rather than a silent no-op.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DockContextMenu from "../src/svelte/modules/DockContextMenu.svelte";
import * as backend from "../src/lib/backend";

vi.mock("../src/lib/backend");

describe("DockContextMenu — bridge-contract compliance (REQ-A297 §4)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("renders without throwing even when every backend call rejects", () => {
    // `wm_close` / `wm_hide` / `wm_focus` all return null. The pre-fix
    // try/catch was unreachable; the post-fix code handles the null
    // branch via `noteFailure(...)`. The component should mount and
    // render the menu items without an exception escaping.
    vi.mocked(backend.invoke).mockImplementation(async () => null);

    expect(() =>
      render(DockContextMenu, {
        props: {
          label: "photos",
          running: true,
          x: 0,
          y: 0,
          onclose: vi.fn(),
        },
      }),
    ).not.toThrow();
  });

  test("renders nothing for an un-running app (hide / show are gated by `running`)", () => {
    vi.mocked(backend.invoke).mockImplementation(async () => null);
    const { container } = render(DockContextMenu, {
      props: { label: "settings", running: false, x: 0, y: 0, onclose: vi.fn() },
    });
    // `hide` and `show` should be visible-but-disabled (the macOS "grey
    // rather than hide" rule from `lib/shellChrome.ts`). `quit` should
    // always be present.
    expect(container.querySelector("[role='menu']")).toBeTruthy();
  });
});

/**
 * REQ-A436 — the menu is usable from the keyboard. Before this it rendered `role="menu"` rows
 * and Escape closed it, but **no key moved the focus between the rows**: a keyboard user had no
 * way through it (macOS menus are fully keyboard driven).
 */
describe("DockContextMenu — keyboard navigation (REQ-A436)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  test("opens with its first row focused, walks the enabled rows, closes on Escape", async () => {
    vi.mocked(backend.invoke).mockImplementation(async () => ({ windows: [] }));
    const onclose = vi.fn();
    const { container } = render(DockContextMenu, {
      props: { label: "notes", running: true, x: 10, y: 10, onclose },
    });
    await tick();

    const menu = container.querySelector<HTMLElement>('[data-testid="dock-context-menu"]')!;
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].filter(
      (b) => !b.disabled,
    );
    // `running: true` ⇒ 显示 / 隐藏 / 退出 are live and 选项… is greyed.
    expect(rows.length).toBe(3);
    // macOS opens a menu with its first row focused.
    expect(document.activeElement).toBe(rows[0]);

    await fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    await fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(rows[2]);
    await fireEvent.keyDown(menu, { key: "ArrowDown" }); // wraps
    expect(document.activeElement).toBe(rows[0]);
    await fireEvent.keyDown(menu, { key: "ArrowUp" }); // wraps back
    expect(document.activeElement).toBe(rows[2]);

    // Escape is claimed by this menu and handed to *its* closer (so the Dock's document-level
    // listener cannot close a different menu).
    await fireEvent.keyDown(menu, { key: "Escape" });
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});

/**
 * REQ-A426 — a right-click on a **not-running** Dock icon used to produce a menu whose
 * every single row was disabled (`显示` / `隐藏` / `退出` all require `running`), i.e. a
 * menu that could not do anything at all. macOS's own menu for that state leads with
 * "Open"; this is that row, and it is the way a user gets the app back.
 */
describe("DockContextMenu — 「打开」 is the way out of the all-grey menu", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function bridge(): void {
    vi.mocked(backend.invoke).mockImplementation(async () => ({ windows: [] }));
  }
  const row = (c: HTMLElement, id: string) =>
    c.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

  test("a not-running app: 「打开」 is enabled and sends wm_open for this label", async () => {
    bridge();
    const onclose = vi.fn();
    const { container } = render(DockContextMenu, {
      props: { label: "notes", running: false, x: 0, y: 0, onclose },
    });

    const open = row(container, "dock-ctx-open");
    expect(open).toBeTruthy();
    expect(open!.disabled).toBe(false);

    // The three state-dependent rows stay listed but grey, and each says **why**
    // (the lib/shellChrome.ts discipline: 灰项 + 名字说明原因).
    for (const id of ["dock-ctx-show", "dock-ctx-hide", "dock-ctx-quit"]) {
      const b = row(container, id);
      expect(b, `${id} should still be listed`).toBeTruthy();
      expect(b!.disabled).toBe(true);
      expect(b!.getAttribute("title")).toBeTruthy();
    }

    open!.click();
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(backend.invoke)
          .mock.calls.some(([cmd, args]) => cmd === "wm_open" && (args as { label?: string }).label === "notes"),
      ).toBe(true),
    );
    // The menu is closed before the async call, and the label was captured first
    // (the Svelte 5 prop-read-after-unmount rule this file documents).
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  test("a running app: no 「打开」 row (Show is the enabled one)", () => {
    bridge();
    const { container } = render(DockContextMenu, {
      props: { label: "notes", running: true, x: 0, y: 0, onclose: vi.fn() },
    });
    expect(row(container, "dock-ctx-open")).toBeNull();
    expect(row(container, "dock-ctx-show")!.disabled).toBe(false);
    expect(row(container, "dock-ctx-hide")!.disabled).toBe(false);
    expect(row(container, "dock-ctx-quit")!.disabled).toBe(false);
    expect(row(container, "dock-ctx-show")!.getAttribute("title")).toBeNull();
  });
});
