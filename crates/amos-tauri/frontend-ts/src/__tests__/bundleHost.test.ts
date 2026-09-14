import { describe, expect, test } from "bun:test";
import {
  BUNDLE_FRAME_SANDBOX,
  bundleFailureFromDiag,
  isFrameableBundleUrl,
  normalizeBundleEntry,
} from "../lib/bundleHost";

/**
 * Pure contract tests for the web-bundle host's decisions (no DOM, no bridge —
 * the bridge/fetch half lives in `svelte-tests/ext-app-host.test.ts`).
 *
 * Two of these are load-bearing security decisions rather than formatting:
 * which URLs may go into an iframe `src`, and which sandbox flags a third-party
 * bundle gets.
 */
describe("bundleHost — what may be framed", () => {
  test("accepts both platform forms of the app's own origin", () => {
    // macOS/iOS/Linux form…
    expect(isFrameableBundleUrl("amos-app://org.amos.demo/index.html")).toBe(true);
    expect(isFrameableBundleUrl("amos-app://org.amos.demo/assets/app.js")).toBe(true);
    // …and the Windows/Android form wry rewrites to.
    expect(isFrameableBundleUrl("http://amos-app.org.amos.demo/index.html")).toBe(true);
    expect(isFrameableBundleUrl("https://amos-app.org.amos.demo/index.html")).toBe(true);
    // A *slug-shaped* netloc is legitimate in both forms — `amos-app.<id>` is
    // exactly the workaround rewrite of `amos-app://<id>`, and the id grammar
    // allows dots. So a name that merely *reads* like a public domain
    // (`amos-app.evil.test`) is still the on-device origin of app `evil.test`.
    // The guard is "is this our scheme+prefix", not "does this look friendly" —
    // the net is wry's `http://amos-app.*` interception, not this regex.
    expect(isFrameableBundleUrl("amos-app://evil.test/index.html")).toBe(true);
    expect(isFrameableBundleUrl("http://amos-app.evil.test/index.html")).toBe(true);
  });

  test("refuses anything that is not the protocol's own origin", () => {
    for (const bad of [
      "",
      "   ",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "https://evil.test/",
      "http://not-amos-app.x/y", // the prefix must be exactly `amos-app.`
      "http://amos-app/x",       // …and must be followed by a `.`
      "https://amos-app.evil.test", // no path: a bare origin is not a document
      "amos-app://",             // no id
      "amos-app://org.amos.demo", // no path
      "amos-app://org.amos.demo/a b.html",
    ]) {
      expect(isFrameableBundleUrl(bad)).toBe(false);
    }
  });

  test("an un-frameable host reply is refused, never half-read", () => {
    expect(normalizeBundleEntry({ url: "amos-app://a.b/index.html", start: "index.html" })).toEqual({
      url: "amos-app://a.b/index.html",
      start: "index.html",
    });
    for (const bad of [
      null,
      undefined,
      "string",
      [],
      {},
      { url: "javascript:alert(1)", start: "index.html" },
      { url: "amos-app://a.b/index.html" }, // no start
      { url: "amos-app://a.b/index.html", start: 7 },
    ]) {
      expect(normalizeBundleEntry(bad)).toBeNull();
    }
  });

  test("the sandbox keeps the frame's own origin but not the shell's", () => {
    // These three are required for a bundle to be a working web app at all.
    expect(BUNDLE_FRAME_SANDBOX).toContain("allow-scripts");
    expect(BUNDLE_FRAME_SANDBOX).toContain("allow-same-origin");
    expect(BUNDLE_FRAME_SANDBOX).toContain("allow-forms");
    // …and these are what would let it escape the frame.
    for (const forbidden of [
      "allow-top-navigation",
      "allow-top-navigation-by-user-activation",
      "allow-popups",
      "allow-modals",
      "allow-pointer-lock",
      "allow-presentation",
    ]) {
      expect(BUNDLE_FRAME_SANDBOX).not.toContain(forbidden);
    }
  });
});

describe("bundleHost — telling the failure apart", () => {
  test("no bridge is 'offline', a rejected command keeps the host's own words", () => {
    expect(bundleFailureFromDiag({ ok: false, kind: "not-bridged", command: "x" })).toEqual({
      reason: "offline",
      detail: "no Tauri bridge",
    });
    // The host's rejection text is the whole point: it names the knob to set.
    expect(
      bundleFailureFromDiag({
        ok: false,
        kind: "command-failed",
        command: "appstore_bundle_entry",
        detail: "no web install dir (set AMOS_APPSTORE_INSTALL_DIR)",
      }),
    ).toEqual({
      reason: "unavailable",
      detail: "no web install dir (set AMOS_APPSTORE_INSTALL_DIR)",
    });
  });

  test("an Error detail is unwrapped; a missing one is not left blank", () => {
    expect(
      bundleFailureFromDiag({
        ok: false,
        kind: "command-failed",
        command: "x",
        detail: new Error("boom"),
      }).detail,
    ).toBe("boom");
    expect(
      bundleFailureFromDiag({ ok: false, kind: "command-failed", command: "x", detail: "  " })
        .detail,
    ).toBe("command failed");
    expect(
      bundleFailureFromDiag({ ok: false, kind: "command-failed", command: "x" }).detail,
    ).toBe("command failed");
  });

  test("a successful call that produced nothing is not framed", () => {
    expect(bundleFailureFromDiag({ ok: true })).toEqual({
      reason: "blocked",
      detail: "host returned no entry",
    });
  });
});
