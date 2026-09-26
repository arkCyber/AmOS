/**
 * wireVocab.test.ts — the telemetry-spy wire *vocabulary* (not the payload shape) bound to
 * the Rust authority that declares it.
 *
 * `telemetrySpy.ts` labels each leaked-identifier kind via `kindKey("serial" | "imei" |
 * "cell_id")`. Those strings are the domain crate's `IdentifierKind::as_str()` keys, which
 * `amos-telemetry-spy/src/identifier.rs` documents as "the stable machine key / a future wire
 * mapping" and which the Tauri bridge (`telemetry_spy.rs::kind_str`) now derives from.
 * `declaredMirrors.test.ts` binds the payload *field names*, but not this value vocabulary —
 * so a rename on the Rust side would let `kindKey` fall through to `spy.kind.unknown`,
 * labelling a real IMEI leak as a generic hit, with every existing test green. This reads the
 * arms and binds them (REQ-A650 / F-SH-118).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { kindKey } from "../lib/telemetrySpy";

const RUST_ROOT = "../../../../";

function readRust(rel: string): string {
  return readFileSync(new URL(RUST_ROOT + rel, import.meta.url), "utf8");
}

describe("telemetrySpy.kindKey == amos_telemetry_spy IdentifierKind::as_str", () => {
  test("every identifier kind Rust names has its own frontend i18n key", () => {
    const src = readRust("amos-telemetry-spy/src/identifier.rs");
    const i = src.indexOf("pub fn as_str(self)");
    expect(i, "IdentifierKind::as_str not found").toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf("\n    }", i));
    const rust = [...body.matchAll(/=>\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    // Guard against a vacuous read: the enum names exactly three kinds, and a Rust rewrite
    // that moves the arms out of the scanned window must fail loudly, not compare two lists.
    expect(rust).toHaveLength(3);

    // The frontend's own i18n mapping, keyed by the Rust value. Its *keys* are validated
    // against `rust` below, so this is not a self-referential copy of the frontend.
    const KNOWN: Record<string, string> = {
      serial: "spy.kind.serial",
      imei: "spy.kind.imei",
      cell_id: "spy.kind.cellId",
    };
    for (const kind of rust) {
      const key = KNOWN[kind] ?? "";
      expect(
        key,
        `frontend has no i18n key for Rust identifier kind "${kind}"`,
      ).not.toBe("");
      expect(kindKey(kind), kind).toBe(key);
    }
    // A value Rust does not name still resolves (never throws) — it just is not specialised.
    expect(kindKey("__not_a_kind__")).toBe("spy.kind.unknown");
  });
});
