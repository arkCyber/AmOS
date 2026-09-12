import { beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { installUiFailureObserver, resetUiFailuresForTest } from "../lib/uiFailures";
import { clearDiag, recentDiag } from "../lib/debugLog";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

beforeEach(() => {
  resetUiFailuresForTest();
  clearDiag();
});

const errorEntries = () =>
  recentDiag().filter((e) => e.level === "error" && e.area === "ui");

/**
 * REQ-A151 — an unhandled rejection used to be invisible in this app: the bridge wrappers
 * never reject (they return `null` and log), so the only rejections that happen come from a
 * *throwing callback* — and nothing observed them. These tests pin the observer that puts
 * them in the same diagnostics ledger `invoke` failures already use.
 *
 * They drive the handler with the **events the platform emits** (`unhandledrejection` /
 * `error`) rather than provoking a real unhandled rejection: a test runner is entitled to
 * fail a test on one (Bun does), and the deliverable here is the handler's behaviour.
 */
describe("uiFailures — the WebView's last line of defence", () => {
  const rejectionEvent = (reason: unknown) => {
    const ev = new Event("unhandledrejection", { cancelable: true });
    (ev as unknown as { reason?: unknown }).reason = reason;
    return ev;
  };
  const errorEvent = (message: string, filename?: string, lineno?: number) => {
    const ev = new Event("error", { cancelable: true });
    const e = ev as unknown as { message?: string; filename?: string; lineno?: number };
    e.message = message;
    e.filename = filename;
    e.lineno = lineno;
    return ev;
  };

  test("an unhandled rejection is recorded with its reason, not silent", () => {
    installUiFailureObserver();
    window.dispatchEvent(rejectionEvent(new Error("callback blew up")));

    const entries = errorEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]?.msg).toContain("unhandled rejection");
    expect(entries[0]?.msg).toContain("callback blew up");
  });

  test("a non-Error rejection reason is still described (never throws)", () => {
    installUiFailureObserver();
    window.dispatchEvent(rejectionEvent({ code: 42 }));
    window.dispatchEvent(rejectionEvent(undefined));

    expect(errorEntries()).toHaveLength(2);
    expect(errorEntries().map((e) => e.msg).join("\n")).toContain("42");
  });

  test("an uncaught error is recorded with its location", () => {
    installUiFailureObserver();
    window.dispatchEvent(errorEvent("boom", "/shell.html", 12));

    const msg = errorEntries()[0]?.msg ?? "";
    expect(msg).toContain("uncaught error: boom");
    expect(msg).toContain("/shell.html:12");
  });

  test("an unhandled rejection carries its throw site, lifted from Error.stack", () => {
    installUiFailureObserver();
    const err = new Error("callback blew up");
    // A deterministic stack, so the assertion is about our parser, not an engine's format.
    err.stack =
      "Error: callback blew up\n" +
      "    at runCallback (webpack:///src/lib/backend.ts:42:7)\n" +
      "    at <anonymous> (webpack:///src/shell-entry.ts:9:1)";
    window.dispatchEvent(rejectionEvent(err));

    const entry = errorEntries()[0];
    // A rejection event has no filename/lineno of its own, so the throw site must come
    // from the reason — recorded in the message, in the same "(file:line:col)" shape the
    // `error` branch already uses (before REQ-A152 the message had no location at all).
    expect(entry?.msg).toContain("(webpack:///src/lib/backend.ts:42:7)");
    // …and the whole stack is kept (bounded by the ledger's own detail cap).
    expect(entry?.detail).toContain("at runCallback");
  });

  test("a non-Error rejection reason has no throw site (and still never throws)", () => {
    installUiFailureObserver();
    window.dispatchEvent(rejectionEvent({ code: 42 }));
    window.dispatchEvent(rejectionEvent("plain string reason"));

    const entries = errorEntries();
    expect(entries).toHaveLength(2);
    // No stack ⇒ no fabricated `file:line`; the value itself is still described.
    expect(entries.every((e) => !/:\d+:\d+/.test(e.msg))).toBe(true);
    expect(entries.map((e) => e.msg).join("\n")).toContain("42");
  });

  test("installing twice does not double-record", () => {
    installUiFailureObserver();
    installUiFailureObserver();
    window.dispatchEvent(errorEvent("once"));

    expect(errorEntries()).toHaveLength(1);
  });

  test("re-installing after a test reset does not stack listeners", () => {
    installUiFailureObserver();
    resetUiFailuresForTest(); // detaches
    installUiFailureObserver(); // fresh pair
    window.dispatchEvent(errorEvent("once"));

    expect(errorEntries()).toHaveLength(1);
  });

  test("the observer never swallows the event (no preventDefault)", () => {
    installUiFailureObserver();
    const ev = rejectionEvent(new Error("x"));
    window.dispatchEvent(ev);

    // No listener called preventDefault ⇒ the platform still sees it as unhandled.
    expect(ev.defaultPrevented).toBe(false);
  });
});
