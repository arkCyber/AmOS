import { describe, expect, test } from "bun:test";
import { appIdFromHash } from "../lib/windowRoute";
import { appIds } from "../lib/appMeta";
import { extIdOf } from "../lib/storeApps";

describe("appIdFromHash — the host's `#window=<label>` contract", () => {
  test("a built-in app label resolves to that app id", () => {
    expect(appIdFromHash("#window=notes")).toBe("notes");
    expect(appIdFromHash("#window=phone")).toBe("phone");
    expect(appIdFromHash("window=settings")).toBe("settings"); // no '#'
  });

  test("a store-installed tile label resolves too (its id is `store:<mid>`)", () => {
    expect(appIdFromHash(`#window=${extIdOf("org.amos.pomodoro")}`)).toBe(
      "store:org.amos.pomodoro",
    );
  });

  test("an ordinary launcher window has no fragment and gets no app", () => {
    for (const hash of ["", "#", "#other=1", null, undefined]) {
      expect(appIdFromHash(hash)).toBeNull();
    }
  });

  test("a label that names no app is never guessed into one", () => {
    // The defect class this guards: a split pane / restored window whose label is
    // a window id or a container surface name must fall back to home, not open a
    // made-up screen (`FormFactor::parse`'s "unknown → None" rule).
    for (const bad of [
      "#window=",
      "#window=main", // the launcher's own label (not an app id)
      "#window=legacy:waydroid_0", // an external container surface
      "#window=app-3", // a host window id
      "#window=NOTES", // case matters: ids are exact
      "#window=weather.app",
    ]) {
      expect(appIdFromHash(bad)).toBeNull();
    }
  });

  test("every built-in id the shell can open round-trips", () => {
    for (const id of appIds()) {
      expect(appIdFromHash(`#window=${id}`)).toBe(id);
    }
  });

  test("is pure — no state, repeatable answer", () => {
    expect(appIdFromHash("#window=notes")).toBe(appIdFromHash("#window=notes"));
  });
});
