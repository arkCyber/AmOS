import { describe, expect, test } from "bun:test";
import { smsGrantRefusalKey } from "../lib/smsPermission";

// REQ-A1577 / F-TEL-037. The screen used to have exactly one thing to say about a missing
// SMS grant — 「请在系统设置中…」 — and it said it about every answer, including answers that
// never came from the settings screen. These pin the five apart.

describe("smsGrantRefusalKey", () => {
  test("a grant is not a refusal", () => {
    // The caller clears the error and re-reads; there is no sentence to show.
    expect(smsGrantRefusalKey("granted")).toBeNull();
    // …and an absent/unknown state is not silently turned into a denial either.
    expect(smsGrantRefusalKey(undefined)).toBeNull();
    expect(smsGrantRefusalKey("nonsense" as never)).toBeNull();
  });

  test("the OS's own 'no' is the denial sentence; the settings pointer is the hint beside it", () => {
    // The refusal *statement*, not the remedy. `MessagesApp` prints `message.smsDeniedHint`
    // underneath off the `denied` flag, so returning the pointer here printed the identical
    // sentence twice (REQ-A1752 / F-TEL-043). The refused-read path never did: it prints
    // `smsDenied` over `smsDeniedHint`, and the two paths must agree on the pair.
    expect(smsGrantRefusalKey("denied")).toBe("message.smsDenied");
    expect(smsGrantRefusalKey("denied")).not.toBe("message.smsDeniedHint");
  });

  test("a timeout is not a denial — the dialog may still be on screen", () => {
    const key = smsGrantRefusalKey("timed-out");
    expect(key).toBe("message.smsGrantTimedOut");
    expect(key).not.toBe("message.smsDeniedHint");
  });

  test("a failed read is not a fact about the user's settings", () => {
    const key = smsGrantRefusalKey("unreadable");
    expect(key).toBe("message.smsGrantUnreadable");
    expect(key).not.toBe("message.smsDeniedHint");
  });

  test("no OS dialog on this host is its own sentence, not a denial", () => {
    const key = smsGrantRefusalKey("host");
    expect(key).toBe("message.smsGrantHost");
    expect(key).not.toBe("message.smsDeniedHint");
  });

  test("all five states map to distinct answers", () => {
    const keys = (["granted", "denied", "timed-out", "unreadable", "host"] as const).map(
      (s) => smsGrantRefusalKey(s) ?? "(none)",
    );
    const refusals = keys.filter((k) => k !== "(none)");
    expect(new Set(refusals).size).toBe(refusals.length);
  });
});
