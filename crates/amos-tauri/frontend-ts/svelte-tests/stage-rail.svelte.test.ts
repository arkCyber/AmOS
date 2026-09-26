/**
 * StageRail.svelte —— 轨道栏的渲染与动作（REQ-A1546）。
 *
 * 桥接层被整体 mock（`../src/lib/stage`），因为本文件测的是**组件**:什么时候画、
 * 每块瓷砖点下去发什么、被拒时说什么。命令接线与回包收窄在
 * `src/__tests__/stage.test.ts` 里测。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import StageRail from "../src/svelte/StageRail.svelte";
import * as stage from "../src/lib/stage";
import * as wm from "../src/lib/wm";
import { t, windowName } from "../src/svelte/locale.svelte";

vi.mock("../src/lib/stage");
vi.mock("../src/lib/wm");

/** The stage rect the shell hands down (matches `stageRect(1440, 900)`). */
const STAGE = { x: 0, y: 24, width: 1440, height: 808 } as const;

/**
 * The rail's width is a **layout** fact, not part of `StageSnapshot` (REQ-A1563): the shell
 * reads it from `LayoutSnapshot.rail_width` and passes the one number down. So it is a prop
 * here, and every render below states it explicitly — a case that forgot would draw no rail
 * and the assertion on `data-rail-width` would be the only thing to notice.
 */
const RAIL = 180;

const ON: stage.StageSnapshot = {
  enabled: true,
  on_stage: [{ label: "files_2", app: "files", instance: 2 }],
  parked: [
    { label: "notes", app: "notes", instance: 1 },
    { label: "notes_2", app: "notes", instance: 2 },
  ],
};

/** Handlers the component registered for the two host pushes. */
let wmPush: (() => void) | null = null;
let layoutPush: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  wmPush = null;
  layoutPush = null;
  vi.mocked(stage.stageSnapshot).mockResolvedValue(ON);
  vi.mocked(stage.stagePark).mockResolvedValue(ON);
  vi.mocked(stage.stageBring).mockResolvedValue(ON);
  vi.mocked(stage.stageArrange).mockResolvedValue(ON);
  // `stageFailure` returns the sentence key; the component reads `{key, hostMessage?}`. The
  // default is the neutral sentence so that a case wanting a *specific* cause has to ask for
  // it — otherwise a component that hard-coded one sentence would pass every case here.
  vi.mocked(stage.stageFailure).mockReturnValue({ key: "stage.errorUnknown" });
  // Both pushes are **subscriptions**: the component stores the returned unsubscribe in
  // its `onMount` cleanup, so an automock returning `undefined` makes every unmount throw
  // (`stop is not a function`) — the same shape `MissionControl`'s test documents.
  vi.mocked(wm.onWmChanged).mockImplementation(async (handler) => {
    wmPush = () => handler(ON_WINDOWS);
    return () => {};
  });
  vi.mocked(wm.onLayoutChanged).mockImplementation(async (handler) => {
    layoutPush = () => handler(LAYOUT);
    return () => {};
  });
});

// The pushes hand the *component* payloads it does not read (it re-asks the host), but the
// mock still has to produce the shape the real `onWmChanged` narrows to.
const ON_WINDOWS = { focused: null, windows: [] } as never;
const LAYOUT = { screen_w: 1440, screen_h: 900 } as never;

describe("StageRail — when the rail is drawn", () => {
  it("draws the rail at the stage's left edge, at the width the host reported", async () => {
    render(StageRail, { props: { stage: STAGE, railWidth: RAIL } });
    const rail = await screen.findByTestId("stage-rail");
    expect(rail.getAttribute("data-rail-width")).toBe("180");
    // The rail is a sub-rectangle of the *stage* — same y/height, no second arithmetic.
    expect(rail.getAttribute("style")).toContain("left: 0px");
    expect(rail.getAttribute("style")).toContain("top: 24px");
    expect(rail.getAttribute("style")).toContain("height: 808px");
  });

  it("draws nothing when the mode is off", async () => {
    vi.mocked(stage.stageSnapshot).mockResolvedValue({ ...ON, enabled: false });
    render(StageRail, { props: { stage: STAGE, railWidth: RAIL } });
    await waitFor(() => expect(stage.stageSnapshot).toHaveBeenCalled());
    expect(screen.queryByTestId("stage-rail")).toBeNull();
  });

  /**
   * `enabled` alone does not mean a rail exists: on a screen too narrow to afford a
   * minimum pane beside it the rail gives way and takes **0** pixels, and the host still
   * reports the mode as on. Drawing it then would put a strip over the windows.
   */
  it("draws nothing when the layout reported a zero-width rail (the give-way case)", async () => {
    render(StageRail, { props: { stage: STAGE, railWidth: 0 } });
    await waitFor(() => expect(stage.stageSnapshot).toHaveBeenCalled());
    expect(screen.queryByTestId("stage-rail")).toBeNull();
  });

  it("keeps the last reading when the host does not answer (never draws 'off')", async () => {
    vi.mocked(stage.stageSnapshot).mockResolvedValue(null);
    render(StageRail, { props: { stage: STAGE, railWidth: RAIL } });
    await waitFor(() => expect(stage.stageSnapshot).toHaveBeenCalled());
    expect(screen.queryByTestId("stage-rail")).toBeNull();
  });
});

describe("StageRail — the tiles", () => {
  it("names each parked window through the shared resolver and brings it back on click", async () => {
    render(StageRail, { props: { stage: STAGE, railWidth: RAIL } });
    const tiles = await screen.findAllByTestId("stage-tile");
    expect(tiles).toHaveLength(2);
    // `notes_2` is instance 2 of `notes`: the *name* carries the instance, the **value**
    // sent to the host stays the label (REQ-A473's rule, same as the Spaces panel). The
    // expected strings come from the resolver itself rather than being hard-coded, because
    // the claim is "this tile went through `windowName`", not "the dictionary says 备忘录".
    const firstName = windowName("notes", "notes", []).text;
    const secondName = windowName("notes_2", "notes", []).text;
    expect(tiles[0]?.textContent?.trim()).toBe(firstName);
    expect(tiles[1]?.textContent?.trim()).toBe(secondName);
    // The two tiles must not read the same, or the rail cannot tell the user which one it
    // would bring back…
    expect(secondName).not.toBe(firstName);
    // …and neither may print the raw wire label, which no other surface shows (REQ-A473).
    expect(tiles[1]?.textContent).not.toContain("notes_2");

    await fireEvent.click(tiles[0]!);
    await waitFor(() => expect(stage.stageBring).toHaveBeenCalledWith("notes"));
    expect(stage.stageBring).toHaveBeenCalledTimes(1);
  });

  it("parks an on-stage window on click", async () => {
    render(StageRail, { props: { stage: STAGE, railWidth: RAIL } });
    const tiles = await screen.findAllByTestId("stage-stage-tile");
    expect(tiles).toHaveLength(1);
    await fireEvent.click(tiles[0]!);
    await waitFor(() => expect(stage.stagePark).toHaveBeenCalledWith("files_2"));
  });

  /** "Tidy" with nothing on stage is a no-op the host is never asked about. */
  it("disables Tidy with an empty stage and enables it with one", async () => {
    vi.mocked(stage.stageSnapshot).mockResolvedValue({ ...ON, on_stage: [], parked: ON.parked });
    const { unmount } = render(StageRail, { props: { stage: STAGE, railWidth: RAIL } });
    const empty = (await screen.findByTestId("stage-tidy")) as HTMLButtonElement;
    expect(empty.disabled).toBe(true);
    unmount();

    // The host now answers the second mount with the real stage (the mock is per-call, so
    // the first mount's empty answer must not still be in force here).
    vi.mocked(stage.stageSnapshot).mockResolvedValue(ON);
    render(StageRail, { props: { stage: STAGE, railWidth: RAIL } });
    const ready = (await screen.findByTestId("stage-tidy")) as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    await fireEvent.click(ready);
    await waitFor(() => expect(stage.stageArrange).toHaveBeenCalledTimes(1));
  });
});

describe("StageRail — refusals and pushes", () => {
  /**
   * A refusal must be a **named** line, never a silent no-op: "the rail says parked and
   * the window is still on screen" is the one failure the user can see and the ledger
   * cannot.
   */
  it("says why a command was refused instead of doing nothing", async () => {
    // The first read succeeds (so the rail is drawn); the *action* is refused.
    vi.mocked(stage.stageBring).mockResolvedValue(null);
    // The refusal's own cause, handed to the component by `stageFailure` — the key the
    // component renders has to be *this* one, not a sentence of its own choosing.
    vi.mocked(stage.stageFailure).mockReturnValue({ key: "stage.errorWindowInSplit" });
    render(StageRail, { props: { stage: STAGE, railWidth: RAIL } });
    const tiles = await screen.findAllByTestId("stage-tile");
    expect(screen.queryByTestId("stage-error")).toBeNull();

    await fireEvent.click(tiles[0]!);
    const error = await screen.findByTestId("stage-error");
    // The rendered line is the **sentence** the dictionary holds for that key, not the key
    // itself — a component that printed the key would pass a `toContain("stage.error…")`
    // check while showing the user a wire identifier.
    expect(error.textContent?.trim()).toBe(t("stage.errorWindowInSplit"));
    // Which command was refused is on the ledger's own key, so a reader can tell the two
    // apart when two of them can be pressed in a row.
    expect(error.getAttribute("data-command")).toBe("stage_bring");
    // …and the view is the *last good* one, not a guess at what the refusal did.
    expect(screen.getAllByTestId("stage-tile")).toHaveLength(2);
  });

  /**
   * `onWmChanged`/`onLayoutChanged` resolve **asynchronously** (a host `listen` round-trip),
   * so the rail can be gone before its subscription exists. If the handle is dropped on the
   * floor then, the host keeps pushing at a rail nobody is watching and every push re-asks
   * `stage_snapshot` — the exact leak `lib/wmWindowsPoll.ts` names in its own doc-comment
   * ("the unsubscribe we get back would be dropped on the floor … The guard hands it straight
   * back instead") and guards there. Same rule, this component (REQ-A1682).
   */
  it("hands a push subscription straight back when it lands after the rail is gone", async () => {
    const stopWm = vi.fn();
    let release!: (un: () => void) => void;
    vi.mocked(wm.onWmChanged).mockImplementation(
      () => new Promise<(() => void) | null>((resolve) => (release = resolve)) as never,
    );
    const { unmount } = render(StageRail, { props: { stage: STAGE, railWidth: RAIL } });
    await waitFor(() => expect(wm.onWmChanged).toHaveBeenCalled());
    unmount(); // the rail leaves before the host answers…
    release!(stopWm); // …and only now does the subscription exist
    await waitFor(() => expect(stopWm).toHaveBeenCalledTimes(1));
  });

  it("still unsubscribes exactly once when the push lands while the rail is alive", async () => {
    const stopWm = vi.fn();
    let release!: (un: () => void) => void;
    vi.mocked(wm.onWmChanged).mockImplementation(
      () => new Promise<(() => void) | null>((resolve) => (release = resolve)) as never,
    );
    const { unmount } = render(StageRail, { props: { stage: STAGE, railWidth: RAIL } });
    await waitFor(() => expect(wm.onWmChanged).toHaveBeenCalled());
    release!(stopWm); // the subscription exists while the rail is still mounted
    await Promise.resolve();
    expect(stopWm).not.toHaveBeenCalled(); // never torn down early (no eager release)
    unmount();
    await waitFor(() => expect(stopWm).toHaveBeenCalledTimes(1)); // and not twice
  });

  it("re-reads the host when the window list or the screen changes", async () => {
    render(StageRail, { props: { stage: STAGE, railWidth: RAIL } });
    await waitFor(() => expect(stage.stageSnapshot).toHaveBeenCalledTimes(1));

    // A window was opened/closed/focused: the rail re-asks the host rather than deriving a
    // second view of its own (`docs/stage-manager.md` — one rule for "what is parked").
    wmPush?.();
    await waitFor(() => expect(stage.stageSnapshot).toHaveBeenCalledTimes(2));

    // The screen changed — the rail may have just given way (or come back) at the new width.
    layoutPush?.();
    await waitFor(() => expect(stage.stageSnapshot).toHaveBeenCalledTimes(3));
  });
});
