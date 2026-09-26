/**
 * dock-open-report.svelte.test.ts — a refused `wm_open` from a Dock tile must be a
 * verdict, not silence.
 *
 * The dock's tiles open an app with `wm_open`, and the host can refuse it: an id the
 * identity model does not know (`wm.rs::WmState::open` → `identity_of_label`), a label
 * naming a window that is not the app's first instance (REQ-A473), or the class's
 * `multi_window` cap (`check_new_app_window`). `invoke` never rejects — it records the
 * reason in the per-command diagnosis and answers `null` — and `wmOpen` folds that into
 * `false`, which the tile discards.
 *
 * `DockFinderItem`'s own comment states the belief that made this look safe: 「a failure
 * is recorded in the diagnostics ledger by `lib/backend` and needs no handler here」. The
 * ledger *does* record it; the question a ledger cannot answer by itself is whether
 * anybody **reads** it. `lib/debugLog`'s header calls console output the primary
 * instrument for "why is X not rendering on the device" questions, and every other
 * launcher of the same act reads the diagnosis and says so: `Launchpad.openApp`,
 * `DesktopNotificationCenter`, both top-bar menus, `SpotlightOverlay`, and — on the very
 * same Dock — `DockContextMenu.noteFailure` (`wm_open` / `wm_new_window` / `wm_close` /
 * `wm_hide` / `wm_focus`). The tiles were the one entry point to that act that left the
 * click dead **and** unrecorded anywhere a reader looks.
 *
 * What these tests pin, one leaf each:
 *   1. an app tile whose `wm_open` is refused reports the host's typed code;
 *   2. the Finder tile — the same act, a different widget — does too.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DockAppItem from "../src/svelte/modules/DockAppItem.svelte";
import DockFinderItem from "../src/svelte/modules/DockFinderItem.svelte";
import * as backend from "../src/lib/backend";

vi.mock("../src/lib/backend");

/** The host's refusal, in the shape `bridgeDiag` hands a caller: a typed code inside a
 * `command-failed` outcome. `amos.wm.window_cap` is the one a user can actually reach
 * without a bug (too many windows of one class). */
const REFUSAL = {
  ok: false,
  kind: "command-failed",
  detail: { code: "amos.wm.window_cap" },
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // `wm_open` refused: `invoke` resolves `null` (never rejects, REQ-A296).
  vi.mocked(backend.invoke).mockImplementation(async () => null);
  vi.mocked(backend.bridgeDiag).mockReturnValue(REFUSAL as never);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  vi.clearAllMocks();
});

/** Everything the surface said, as one string — the tests care that the *reason* reached
 * a reader, not which overload of `console.warn` carried it. */
const said = () => warn.mock.calls.flat().map(String).join(" ");

describe("a refused `wm_open` from the Dock is reported, not discarded", () => {
  test("an app tile whose open is refused reports the host's typed code", async () => {
    const { container } = render(DockAppItem, {
      props: { id: "ghost", icon: "👻", label: "幽灵" },
    });
    await fireEvent.click(container.querySelector('[data-testid="dock-app-ghost"]')!);
    await tick();
    expect(said()).toContain("amos.wm.window_cap");
  });

  test("the Finder tile's refused open reports it too", async () => {
    const { container } = render(DockFinderItem, {});
    await fireEvent.click(container.querySelector('[data-testid="dock-finder"]')!);
    await tick();
    expect(said()).toContain("amos.wm.window_cap");
  });
});
