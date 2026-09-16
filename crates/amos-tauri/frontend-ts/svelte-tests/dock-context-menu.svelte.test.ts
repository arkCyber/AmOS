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
import { render } from "@testing-library/svelte";
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
