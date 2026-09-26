import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  appIdFromHash,
  appOfWindowLabel,
  MAX_WINDOWS_PER_APP,
  splitWindowLabel,
  WINDOW_INSTANCE_SEPARATOR,
  windowLabelFromHash,
} from "../lib/windowRoute";
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

// ─── REQ-A473: a window label carries an *instance*, and the app is still resolvable ───

describe("splitWindowLabel / appOfWindowLabel — the app behind a window label", () => {
  test("the separator is the one the Rust identity domain uses", () => {
    // A drift here would make the host and the shell disagree about every second window.
    // REQ-A651: read the authority instead of re-typing its value — the test's name claims
    // the Rust identity domain, so it must consult `amos-wm`, not a local literal.
    const rust = readFileSync(new URL("../../../../amos-wm/src/identity.rs", import.meta.url), "utf8");
    const m = /pub const INSTANCE_SEPARATOR: char = '(.)';/.exec(rust);
    expect(m, "INSTANCE_SEPARATOR not found in amos-wm/src/identity.rs").not.toBeNull();
    const separator = m?.[1] ?? "";
    // Non-vacuity: a Rust separator is one char; a two-char capture would mean the regex matched
    // something else, and an empty capture would mean it matched nothing at all.
    expect(separator).toHaveLength(1);
    expect(WINDOW_INSTANCE_SEPARATOR as string).toBe(separator);
  });

  test("a bare app id is instance 1 and a suffixed label is that instance", () => {
    expect(splitWindowLabel("files")).toEqual({ app: "files", instance: 1 });
    expect(splitWindowLabel("files_2")).toEqual({ app: "files", instance: 2 });
    expect(splitWindowLabel("files_16")).toEqual({ app: "files", instance: 16 });
    expect(appOfWindowLabel("files_2")).toBe("files");
  });

  test("the instance ceiling is the one `amos-wm` enforces (REQ-A698)", () => {
    // The defect this closes: `splitWindowLabel` checked only the floor (`>= 2`), so
    // `files_17` resolved here while `identity.rs` refuses it with `OrdinalOutOfRange` — the
    // shell routed to a window the host refuses to create instead of falling back to `null`.
    // REQ-A651 idiom: read the authority, do not re-type its value.
    const rust = readFileSync(new URL("../../../../amos-wm/src/identity.rs", import.meta.url), "utf8");
    const m = /pub const MAX_WINDOWS_PER_APP: u32 = (\d+);/.exec(rust);
    expect(m, "MAX_WINDOWS_PER_APP not found in amos-wm/src/identity.rs").not.toBeNull();
    const rustMax = Number(m?.[1]);
    // Non-vacuity: a ceiling below 2 would collapse the suffixed-label space entirely and a
    // zero/NaN capture would mean the regex matched something other than the constant.
    expect(rustMax).toBeGreaterThanOrEqual(2);
    expect(MAX_WINDOWS_PER_APP).toBe(rustMax);
  });

  test("an ordinal above the host's ceiling resolves to nothing, not to a doomed window", () => {
    // The boundary pair is the whole point: `files_16` resolves (the host's last slot) and
    // `files_17` does not (the host would refuse it). One test bound may read the Rust
    // constant; the behaviour is pinned against `MAX_WINDOWS_PER_APP` itself so it cannot
    // drift when the host raises its ceiling.
    expect(splitWindowLabel(`files_${MAX_WINDOWS_PER_APP}`)).toEqual({
      app: "files",
      instance: MAX_WINDOWS_PER_APP,
    });
    expect(splitWindowLabel(`files_${MAX_WINDOWS_PER_APP + 1}`)).toBeNull();
    expect(splitWindowLabel("files_17")).toBeNull();
    // …and the same refusal reaches every route that goes through the splitter.
    expect(appOfWindowLabel("files_17")).toBeNull();
    expect(appIdFromHash("#window=files_17")).toBeNull();
    expect(windowLabelFromHash("#window=files_17")).toBeNull();
  });

  test("the fragment route resolves an instance window to its app", () => {
    // The defect this closes: before the identity model `#window=files_2` (a second window)
    // fell through to "unknown app" and the window rendered the empty-app panel.
    expect(appIdFromHash("#window=files_2")).toBe("files");
    expect(appIdFromHash("#window=store:org.amos.pomodoro_3")).toBe(
      "store:org.amos.pomodoro",
    );
  });

  test("windowLabelFromHash keeps the instance, which appIdFromHash must drop (REQ-A478)", () => {
    // The OS window title needs *this window's* name (`文件 — 2`); the surface state needs
    // the app. One hash, two questions — and only the label can answer the first.
    expect(windowLabelFromHash("#window=files_2")).toBe("files_2");
    expect(appIdFromHash("#window=files_2")).toBe("files");
    expect(windowLabelFromHash("#window=files")).toBe("files");
    // Validated the same way: a label that names no app is `null`, never a made-up identity.
    for (const bad of ["#window=NOTES", "#window=app-3", "#window=main", "", null, undefined]) {
      expect(windowLabelFromHash(bad), String(bad)).toBeNull();
    }
  });

  test("instance 1 has one spelling: `_1` is not a second one", () => {
    // The Rust rule (`identity.rs`): the bare id is the only spelling of the first window,
    // so a redundant suffix must not resolve anywhere.
    expect(splitWindowLabel("files_1")).toBeNull();
    expect(splitWindowLabel("files_0")).toBeNull();
  });

  test("an id whose tail is not a number is looked up as a whole", () => {
    // `store:org.amos.some_app` is a legitimate manifest id. Nothing is stripped, because
    // `app` is not an instance number — stripping on any `_` would resolve it to an app
    // named `store:org.amos.some`, a wrong answer rather than a missing one.
    const id = extIdOf("org.amos.some_app") as string;
    expect(splitWindowLabel(id)).toEqual({ app: id, instance: 1 });
    expect(appOfWindowLabel(id)).toBe(id);
  });

  test("a suffix that is not a whole number ≥ 2 resolves to nothing", () => {
    for (const bad of [
      "files_two",
      "files_2.5",
      "files_",
      "_2",
      "files_2_3", // the *first* separator is not the last one: `files_2_3` = app `files_2`? No — see below
      "nosuchapp_2", // an unknown base is never guessed
      "files_99999999999999999999",
      "",
      null,
      undefined,
    ]) {
      expect(splitWindowLabel(bad)).toBeNull();
    }
  });

  test("a doubled suffix belongs to the app named by its prefix, never to a wrong one", () => {
    // `files_2_3` reads as instance 3 of the app `files_2` — which is not an app id, so the
    // answer is `null`. The point of the assertion is that it is *not* `{files, 3}`: only
    // the last separator may carry an ordinal, and the base has to be a real app.
    expect(splitWindowLabel("files_2_3")).toBeNull();
  });
});

