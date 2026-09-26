/**
 * AppExpose.svelte — macOS's Application Windows (`⌃↓`, REQ-A476).
 *
 * The feature only became possible with the identity model (REQ-A473): "this app's windows"
 * is a set that could not exist while one label meant one window. These cases pin the two
 * properties that make it *this* feature rather than a second Mission Control — it shows
 * **one app's** windows, and it addresses each tile by its **window label**.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/svelte";
import AppExpose from "../src/svelte/AppExpose.svelte";
import * as backend from "../src/lib/backend";

vi.mock("../src/lib/backend");
vi.mock("../src/lib/focusTrap", () => ({
  attachFocusTrap: vi.fn(() => () => {}),
}));

const win = (
  id: number,
  label: string,
  app: string,
  instance: number,
  kind = "App",
  state = "Shown",
  focused = false,
) => ({ id, label, app, instance, kind, state, focused, external: false });

function hostWith(windows: unknown[]): void {
  vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "wm_windows") return { windows };
    return null;
  });
}

describe("AppExpose — one application's windows, tiled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const tiles = () =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-testid="app-expose-tile"]')];

  it("shows only the focused app's windows — never another app's", async () => {
    hostWith([
      win(1, "files", "files", 1, "App", "Shown", false),
      win(2, "files_2", "files", 2, "App", "Focused", true),
      win(3, "notes", "notes", 1, "App", "Shown", false), // a different app
      win(4, "main", "", 0, "Launcher", "Shown", false), // not an app at all
    ]);
    render(AppExpose, { props: { onclose: vi.fn() } });

    await waitFor(() => expect(tiles().length).toBe(2));
    expect(tiles().map((t) => t.getAttribute("data-window-label"))).toEqual([
      "files",
      "files_2",
    ]);
    // Names come from the shared resolver: the second window is not called `files_2`.
    expect(screen.getByText("文件")).toBeTruthy();
    expect(screen.getByText("文件 — 2")).toBeTruthy();
    expect(screen.queryByText("notes")).toBeNull();
  });

  it("marks the focused tile, and a click focuses that **window** (its label)", async () => {
    const windows = [
      win(1, "files", "files", 1, "App", "Shown", false),
      win(2, "files_2", "files", 2, "App", "Focused", true),
    ];
    // A **successful** call for the mutation (the refusal path has its own case below): the
    // bridge's contract is "a non-null answer means the host did it".
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) =>
      cmd === "wm_windows" ? { windows } : { focused: 1, windows },
    );
    const onclose = vi.fn();
    render(AppExpose, { props: { onclose } });

    await waitFor(() => expect(tiles().length).toBe(2));
    expect(tiles()[1].getAttribute("aria-current")).toBe("true");
    expect(tiles()[0].getAttribute("aria-current")).toBeNull();

    await fireEvent.click(tiles()[0]);
    await waitFor(() =>
      expect(
        vi
          .mocked(backend.invoke)
          .mock.calls.some(
            ([cmd, args]) =>
              cmd === "wm_focus" && (args as { label?: string }).label === "files",
          ),
      ).toBe(true),
    );
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("still closes — and leaves a breadcrumb — when the host refuses the focus", async () => {
    // The typed-error discipline (REQ-A297 §4): `invoke` resolves `null` on a refused
    // `wm_focus` (the window may be gone since the read). The panel closes anyway — the user
    // has chosen, and staying on a dead overlay is worse — but the refusal is recorded.
    hostWith([
      win(1, "files", "files", 1, "App", "Shown", false),
      win(2, "files_2", "files", 2, "App", "Focused", true),
    ]);
    const refused = { ok: false, kind: "command-failed", command: "wm_focus" } as const;
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) =>
      cmd === "wm_windows"
        ? {
            windows: [
              win(1, "files", "files", 1, "App", "Shown", false),
              win(2, "files_2", "files", 2, "App", "Focused", true),
            ],
          }
        : null,
    );
    vi.mocked(backend.bridgeDiag).mockReturnValue(refused);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const onclose = vi.fn();
    render(AppExpose, { props: { onclose } });
    await waitFor(() => expect(tiles().length).toBe(2));
    await fireEvent.click(tiles()[0]);
    await waitFor(() => expect(onclose).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls.some((c) => String(c[0]).includes("wm_focus(files) refused"))).toBe(true);
    warn.mockRestore();
  });

  it("renders nothing for an app with a single window (nothing to tile)", async () => {
    // macOS shows nothing in this case too; the shell reports *why* the chord did nothing
    // (`desktopSystemKeys.appExposeRefusal`) instead of opening an empty panel. This is the
    // component's second line of defence, in case it is mounted on its own.
    hostWith([win(1, "files", "files", 1, "App", "Focused", true)]);
    render(AppExpose, { props: { onclose: vi.fn() } });
    await waitFor(() => expect(backend.invoke).toHaveBeenCalled());
    expect(document.querySelector('[data-testid="app-expose"]')).toBeNull();
  });

  it("renders nothing when the host does not answer (no desktop form)", async () => {
    vi.mocked(backend.invoke).mockImplementation(async () => null);
    render(AppExpose, { props: { onclose: vi.fn() } });
    await waitFor(() => expect(backend.invoke).toHaveBeenCalled());
    expect(document.querySelector('[data-testid="app-expose"]')).toBeNull();
  });

  it("an old host payload (no `app` field) still tiles by the label's app", async () => {
    // The identity fields are the host's; the *resolver* is shared, so a payload that only
    // carries labels yields the same grouping (`files` + `files_2` = one app).
    hostWith([
      { id: 1, label: "files", kind: "App", state: "Shown", focused: true, external: false },
      { id: 2, label: "files_2", kind: "App", state: "Shown", focused: false, external: false },
      { id: 3, label: "notes", kind: "App", state: "Shown", focused: false, external: false },
    ]);
    render(AppExpose, { props: { onclose: vi.fn() } });
    await waitFor(() => expect(tiles().length).toBe(2));
    expect(tiles().map((t) => t.getAttribute("data-window-label"))).toEqual([
      "files",
      "files_2",
    ]);
  });

  it("closes on Escape and on a backdrop click (one behaviour, two ways in)", async () => {
    hostWith([
      win(1, "files", "files", 1, "App", "Shown", false),
      win(2, "files_2", "files", 2, "App", "Focused", true),
    ]);
    const onclose = vi.fn();
    render(AppExpose, { props: { onclose } });
    await waitFor(() => expect(tiles().length).toBe(2));

    await fireEvent.keyDown(window, { key: "Escape" });
    expect(onclose).toHaveBeenCalledTimes(1);

    const backdrop = document.querySelector('[data-testid="app-expose"] > [role="presentation"]');
    expect(backdrop).toBeTruthy();
    await fireEvent.click(backdrop!);
    expect(onclose).toHaveBeenCalledTimes(2);
  });

  it("arrow keys walk the tiles (a keyboard user is not stuck on Tab)", async () => {
    hostWith([
      win(1, "files", "files", 1, "App", "Shown", false),
      win(2, "files_2", "files", 2, "App", "Focused", true),
      win(3, "files_3", "files", 3, "App", "Shown", false),
    ]);
    render(AppExpose, { props: { onclose: vi.fn() } });
    await waitFor(() => expect(tiles().length).toBe(3));

    // Nothing holds the focus yet (the trap is mocked in this suite), so the first nav key
    // opens the walk — the same courtesy a menu does by focusing its first row.
    await fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tiles()[0]);
    await fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tiles()[1]);
    // One row: Up / Down walk it rather than being dead keys.
    await fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(tiles()[2]);
    await fireEvent.keyDown(document, { key: "ArrowDown" }); // wraps
    expect(document.activeElement).toBe(tiles()[0]);
    await fireEvent.keyDown(document, { key: "End" });
    expect(document.activeElement).toBe(tiles()[2]);
    await fireEvent.keyDown(document, { key: "Home" });
    expect(document.activeElement).toBe(tiles()[0]);
    // A key the module does not own changes nothing (Enter / Space stay the button's job).
    await fireEvent.keyDown(document, { key: "Enter" });
    expect(document.activeElement).toBe(tiles()[0]);
  });
});
