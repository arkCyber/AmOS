/**
 * `windowName` — how a **window** is named on screen (REQ-A473).
 *
 * One implementation, three call sites (Mission Control's switcher, the Spaces panel, an
 * app window's title bar). The cases below are the ones that made it necessary: an
 * instance window (`files_2`) is not an app id, the host's `app` field and the label must
 * not disagree, and a window that shows no app has no app name to show.
 *
 * Two boundaries, both inherited from the module under test (and both already documented by
 * `keyboardConfigHook.bindings.test.ts`, the precedent for this pattern):
 *
 * 1. **`$state` is a compiler macro.** `locale.svelte.ts` holds the shared locale in one, so
 *    importing it under bun (no Svelte compiler) would hit a bare identifier. It is stubbed
 *    with the identity function, which is exact: this file tests the *naming logic*, and the
 *    reactive half is what `svelte-tests/`' compiled suite covers.
 *
 *    **The stub is installed inline, before the import** — unlike
 *    `keyboardConfigHook.bindings.test.ts`, whose rune lives inside a function and can
 *    therefore be stubbed from `beforeAll`. Here the rune is evaluated at **module scope**
 *    (line 38 of the module), i.e. during the import itself, so a `beforeAll` would be too
 *    late and the import has to be dynamic.
 * 2. **No happy-dom** — a DOM-registering import would make this a "DOM file" and move it
 *    out of the pure batch. `locale.svelte.ts` only touches `window`/`localStorage` behind
 *    `typeof … !== "undefined"` guards, so a minimal `window` stub is enough.
 */
import { describe, expect, test, afterAll } from "bun:test";
import type { StoreTile } from "../lib/storeApps";

const globals = globalThis as Record<string, unknown>;
const previousWindow = globals.window;
const previousState = globals.$state;

globals.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  localStorage: undefined,
};
// See boundary 1 in the file header: the identity stub, installed *before* the import.
globals.$state = (value: unknown) => value;

const { windowName } = await import("../svelte/locale.svelte");

afterAll(() => {
  globals.window = previousWindow;
  globals.$state = previousState;
});

describe("windowName — the app behind a window, and which instance it is", () => {
  test("the first window is the app's own name (no instance marker)", () => {
    const n = windowName("files");
    expect(n.appId).toBe("files");
    expect(n.instance).toBe(1);
    expect(n.app).toBe("文件");
    expect(n.text).toBe("文件");
  });

  test("a later instance carries its number, and the app name stays the base", () => {
    const n = windowName("files_2");
    expect(n.appId).toBe("files");
    expect(n.instance).toBe(2);
    expect(n.app).toBe("文件");
    expect(n.text).toBe("文件 — 2");
    // The single defect this replaced: the raw label, capitalized, as if it were a name.
    expect(n.text).not.toContain("files_2");
  });

  test("the host's `app` decides the name; the label decides the instance", () => {
    // A payload where both are present: the app is used for the *name* (it is the host's
    // answer, and the only one that survives a label-scheme change), while the ordinal comes
    // from the label — its canonical spelling.
    expect(windowName("files_2", "files").text).toBe("文件 — 2");
    // …and a window whose label cannot be parsed still gets the app's name, as instance 1:
    // the host said which app it shows, and that answer is not thrown away.
    const odd = windowName("some-future-label", "notes");
    expect(odd.appId).toBe("notes");
    expect(odd.instance).toBe(1);
    expect(odd.text).toBe("备忘录");
  });

  test("REQ-A1185: an installed store app's window is named from the tiles it is given", () => {
    // An installed app's name lives in the **store registry** (`lib/storeApps`), not in the i18n
    // dictionary — so `windowName` resolves it through the tile list the caller passes in (the
    // one owner, `lib/appLookup::storeTileFor`). Before this, every surface that lists *windows*
    // asked only `appTitleKey`, found nothing, and fell through to the raw wire id: the titlebar
    // and Mission Control read `store:org.amos.demo` while the sibling built-in read `文件`.
    const tiles: StoreTile[] = [
      { id: "store:org.amos.pomodoro", mid: "org.amos.pomodoro", name: "Pomodoro", icon: "P" },
    ];
    const n = windowName("store:org.amos.pomodoro", null, tiles);
    expect(n.appId).toBe("store:org.amos.pomodoro");
    expect(n.app).toBe("Pomodoro");
    expect(n.text).toBe("Pomodoro");
    expect(n.instance).toBe(1);
    // A later window of the same installed app keeps the instance marker.
    expect(windowName("store:org.amos.pomodoro_2", null, tiles).text).toBe("Pomodoro — 2");
  });

  test("an id in no registry is still shown as its id — never prettified", () => {
    // The boundary that holds: an id that is neither a built-in app nor one of the passed tiles
    // has no name this build can honestly use. Inventing one (capitalizing the id, say) would be
    // a name the host never uses.
    const n = windowName("store:org.amos.pomodoro");
    expect(n.appId).toBe("store:org.amos.pomodoro");
    expect(n.text).toBe("store:org.amos.pomodoro");
    // …and it stays the id when the tiles carry a *different* app.
    const other: StoreTile[] = [
      { id: "store:org.amos.demo", mid: "org.amos.demo", name: "Demo", icon: "D" },
    ];
    expect(windowName("store:org.amos.pomodoro", null, other).text).toBe(
      "store:org.amos.pomodoro",
    );
  });

  test("a window that shows no app keeps its raw label and no app name", () => {
    // The launcher (`main`) and container surfaces are not applications; `app` is `""` so a
    // caller can tell "this window has no app" from "this app is called ''".
    for (const label of ["main", "legacy:waydroid_0"]) {
      const n = windowName(label);
      expect(n.appId, label).toBe("");
      expect(n.app, label).toBe("");
      expect(n.instance, label).toBe(0);
      expect(n.text, label).toBe(label);
    }
  });

  test("is pure — the same window always gets the same name", () => {
    expect(windowName("files_2", "files")).toEqual(windowName("files_2", "files"));
  });
});

