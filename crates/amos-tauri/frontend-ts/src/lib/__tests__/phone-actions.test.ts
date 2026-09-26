/**
 * phone-actions.test.ts — the verdict for an **in-call action** (answer / decline /
 * hang-up), which cannot be read from the command's return value.
 *
 * `invoke` never rejects: it records the reason in `bridgeDiag(command)` and answers
 * `null`, and a `void` command's success value is `null` too. So these three
 * realities — accepted / refused with words / refused without words — have to be
 * told apart from the **diagnosis**, not from the value (F-SH-236).
 *
 * REQ-A811 / F-SH-252: the detail that verdict carries must be **words**, not the
 * machine token the producer puts in `message`.
 */
import { describe, expect, test } from "vitest";
import {
  callActionOutcome,
  callActionDetailText,
  MAX_ACTION_DETAIL_LEN,
} from "../phone";

describe("callActionOutcome", () => {
  test("a clean diagnosis is an accepted action", () => {
    expect(callActionOutcome({ ok: true })).toEqual({ kind: "accepted" });
  });

  test("a refused command keeps the host's own words", () => {
    expect(
      callActionOutcome({
        ok: false,
        kind: "command-failed",
        command: "telephony_answer",
        detail: {
          code: "amos.telephony.rpc_failed",
          message: "telephony answer failed: status: NotFound",
        },
      }),
    ).toEqual({
      kind: "refused",
      detail: "telephony answer failed: status: NotFound",
    });
  });

  test("an unbridged call is refused with no words to quote", () => {
    expect(
      callActionOutcome({ ok: false, kind: "not-bridged", command: "telephony_answer" }),
    ).toEqual({ kind: "refused", detail: "" });
  });

  test("accepted and refused are not the same answer (the fold cannot collapse)", () => {
    const accepted = callActionOutcome({ ok: true });
    const refused = callActionOutcome({
      ok: false,
      kind: "command-failed",
      command: "telephony_end",
      detail: { code: "amos.telephony.rpc_failed", message: "nope" },
    });
    expect(accepted).not.toEqual(refused);
    expect(accepted.kind).not.toBe(refused.kind);
  });
});

describe("callActionDetailText", () => {
  test("prefers the AmosError sentence", () => {
    expect(
      callActionDetailText({
        code: "amos.telephony.rpc_failed",
        message: "telephony answer failed",
        cause: ["status: NotFound"],
      }),
    ).toBe("telephony answer failed");
  });

  test("falls back to the cause list when there is no sentence", () => {
    expect(
      callActionDetailText({ code: "amos.telephony.rpc_failed", cause: ["a", "b"] }),
    ).toBe("a; b");
  });

  test("a detail that carries only a machine code has no words to show a human", () => {
    // A code is not a sentence: the surface says "no reason given" instead of putting
    // `amos.telephony.rpc_failed` in front of the user (`invoke` still logs it).
    expect(callActionDetailText({ code: "amos.telephony.rpc_failed" })).toBe("");
  });

  test("the token in `message` does not hide the sentence in `cause`", () => {
    // This is the shape `AmosError::with_cause(code, codes::RPC_FAILED, sentence)`
    // actually produces (`error.rs` asserts `v["message"] == "amos.telephony.rpc_failed"`),
    // and it is the shape the fixture above omits — so the test above was green for the
    // wrong reason while the UI rendered the token.
    expect(
      callActionDetailText({
        code: "amos.telephony.rpc_failed",
        message: "amos.telephony.rpc_failed",
        cause: ["telephony answer: in-call JVM not captured yet"],
      }),
    ).toBe("telephony answer: in-call JVM not captured yet");
  });

  test("a machine code is refused as words whatever field it arrives in", () => {
    for (const detail of [
      { message: "amos.telephony.rpc_failed" },
      { code: "amos.telephony.rpc_failed", message: "amos.telephony.rpc_failed" },
      { cause: ["amos.spaces.lock_failed"] },
      { message: "amos.telephony.rpc_failed", cause: ["amos.spaces.lock_failed"] },
      "amos.telephony.rpc_failed",
    ]) {
      expect(callActionDetailText(detail)).toBe("");
    }
  });

  test("a sentence that merely mentions a token is still words", () => {
    // The filter matches the whole string, not a substring: a host sentence *about* a
    // token is exactly what a human needs to read.
    expect(
      callActionDetailText({ message: "request failed: amos.telephony.rpc_failed (retried twice)" }),
    ).toBe("request failed: amos.telephony.rpc_failed (retried twice)");
  });

  test("a plain string detail is passed through, trimmed", () => {
    expect(callActionDetailText("  boom  ")).toBe("boom");
  });

  test("nothing to say is an empty string — never `[object Object]`", () => {
    for (const nothing of [undefined, null, "", "   ", {}, { message: "  " }, 42, []]) {
      expect(callActionDetailText(nothing)).toBe("");
    }
  });

  test("a long message is truncated visibly, never silently", () => {
    const long = "x".repeat(MAX_ACTION_DETAIL_LEN * 2);
    const got = callActionDetailText(long);
    expect(got.length).toBe(MAX_ACTION_DETAIL_LEN);
    expect(got.endsWith("…")).toBe(true);
    // The truncation is visible: what is shown is not the whole message.
    expect(got).not.toBe(long);
  });

  test("a message exactly at the cap is not touched", () => {
    const exact = "y".repeat(MAX_ACTION_DETAIL_LEN);
    expect(callActionDetailText(exact)).toBe(exact);
  });
});
