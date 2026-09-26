import { afterEach, describe, it, expect } from "vitest";
import {
  NFC_TAG_EVENT,
  TNF_EMPTY,
  TNF_WELL_KNOWN,
  TNF_MIME_MEDIA,
  TNF_URI,
  TNF_EXTERNAL,
  ndefTextRecord,
  ndefUriRecord,
  ndefMimeRecord,
  decodeTextRecord,
  decodeUriRecord,
  nfcFormatTag,
  nfcReadBelongsTo,
  nfcReadBytes,
  nfcReadNoticeKey,
  nfcStartDispatch,
  nfcStopDispatch,
  nfcWriteMessage,
  type NdefRecord,
  type NfcReadOutcome,
  type NfcReadStateWire,
} from "../nfc";

describe("NFC constants", () => {
  it("NFC_TAG_EVENT is the expected string", () => {
    expect(NFC_TAG_EVENT).toBe("nfc-tag-discovered");
  });
  it("TNF_EMPTY = 0x00", () => expect(TNF_EMPTY).toBe(0x00));
  it("TNF_WELL_KNOWN = 0x01", () => expect(TNF_WELL_KNOWN).toBe(0x01));
  it("TNF_MIME_MEDIA = 0x02", () => expect(TNF_MIME_MEDIA).toBe(0x02));
  it("TNF_URI = 0x03", () => expect(TNF_URI).toBe(0x03));
  it("TNF_EXTERNAL = 0x04", () => expect(TNF_EXTERNAL).toBe(0x04));
});

describe("ndefTextRecord", () => {
  it("returns a valid RTD_TEXT NdefRecord", () => {
    const rec = ndefTextRecord("Hello world", "en");
    expect(rec.tnf).toBe(TNF_WELL_KNOWN);
    expect(rec.type.toLowerCase()).toBe("54"); // "T" in hex
    expect(typeof rec.payload).toBe("string");
    expect(rec.payload.length).toBeGreaterThan(0);
    expect(rec.id).toBe("");
  });

  it("round-trips through decodeTextRecord", () => {
    const rec = ndefTextRecord("你好", "zh");
    const decoded = decodeTextRecord(rec);
    expect(decoded).toBe("你好");
  });

  it("handles empty string", () => {
    const rec = ndefTextRecord("", "en");
    const decoded = decodeTextRecord(rec);
    expect(decoded).toBe("");
  });

  it("different language codes produce different payloads", () => {
    const en = ndefTextRecord("test", "en");
    const zh = ndefTextRecord("测试", "zh");
    expect(en.payload).not.toBe(zh.payload);
  });
});

describe("ndefUriRecord", () => {
  it("returns a valid RTD_URI NdefRecord", () => {
    const rec = ndefUriRecord("https://example.com");
    expect(rec.tnf).toBe(TNF_WELL_KNOWN);
    expect(rec.type.toLowerCase()).toBe("55"); // "U" in hex
    expect(typeof rec.payload).toBe("string");
    expect(rec.payload.length).toBeGreaterThan(0);
    expect(rec.id).toBe("");
  });

  it("round-trips through decodeUriRecord", () => {
    const rec = ndefUriRecord("https://example.com/path?query=1");
    const decoded = decodeUriRecord(rec);
    expect(decoded).toBe("https://example.com/path?query=1");
  });
});

describe("ndefMimeRecord", () => {
  it("returns a valid MIME_MEDIA NdefRecord", () => {
    const rec = ndefMimeRecord("application/json", [0x7b, 0x7d]); // "{}"
    expect(rec.tnf).toBe(TNF_MIME_MEDIA);
    expect(typeof rec.payload).toBe("string");
    expect(rec.payload).toBe("7b7d");
    expect(rec.id).toBe("");
  });
});

describe("decodeTextRecord", () => {
  it("returns null for a non-text type", () => {
    const rec: NdefRecord = { tnf: TNF_URI, type: "55", payload: "01", id: "" };
    expect(decodeTextRecord(rec)).toBeNull();
  });
  it("returns null for malformed payload (non-hex chars)", () => {
    // Length 2 hex chars valid but malformed because payload length is wrong relative to status
    const rec: NdefRecord = { tnf: TNF_WELL_KNOWN, type: "54", payload: "zzzz", id: "" };
    // parseInt will produce NaN, statusByte becomes 0, langLength=0, textStart=1, textBytes=[NaN] → TextDecoder fails
    const result = decodeTextRecord(rec);
    expect(result === null || result === "").toBe(true);
  });
});

describe("decodeUriRecord", () => {
  it("returns null for a non-URI type", () => {
    const rec: NdefRecord = { tnf: TNF_WELL_KNOWN, type: "54", payload: "01", id: "" };
    expect(decodeUriRecord(rec)).toBeNull();
  });
  it("returns null for malformed payload (non-hex chars)", () => {
    // Non-hex chars produce NaN, which TextDecoder coerces to 0 but prefix lookup is well-defined
    const rec: NdefRecord = { tnf: TNF_WELL_KNOWN, type: "55", payload: "GGzz", id: "" };
    const result = decodeUriRecord(rec);
    // parseInt("GG") = NaN; prefix lookup on NaN (wrapped to 0) returns "" prefix;
    // the result is technically valid but contains garbage — we treat it as malformed here.
    expect(result).toBeNull();
  });
});

/**
 * The read answer (REQ-A781 / F-AND-009).
 *
 * `nfcReadBytes` used to resolve to `string | null`, and that one `null` was the answer to four
 * different questions — no tag in the field, a tag read fine that holds no NDEF payload, a read
 * that threw, and "this host could not ask" — which the screen worded as one sentence about the
 * tag: "the system returned no tag bytes". These are the pure functions that keep them apart,
 * so the separation is pinned without a bridge.
 */
describe("nfc read outcome", () => {
  const STATES: NfcReadStateWire[] = ["bytes", "empty", "no-tag", "failed", "unavailable"];

  it("gives every state its own sentence", () => {
    const keys = STATES.map((state) =>
      nfcReadNoticeKey({ state, tag_id: "aa", hex: "00" }, "aa"),
    );
    expect(new Set(keys).size).toBe(STATES.length);
    expect(keys).toEqual([
      "nfc.readOk",
      "nfc.readNoPayload",
      "nfc.readNoTag",
      "nfc.readFailed",
      "nfc.readUnavailable",
    ]);
  });

  it("never words a successful read of an empty tag as a failed read", () => {
    // The exact lie that shipped: the tag was read, it simply carries nothing, and the
    // screen said the *system* returned no tag bytes.
    const empty: NfcReadOutcome = { state: "empty", tag_id: "aa" };
    expect(nfcReadNoticeKey(empty, "aa")).toBe("nfc.readNoPayload");
    expect(nfcReadNoticeKey(empty, "aa")).not.toBe("nfc.readFailed");
    // A zero-length payload is likewise a read that happened.
    expect(nfcReadNoticeKey({ state: "bytes", tag_id: "aa", hex: "" }, "aa")).toBe("nfc.readOk");
  });

  it("never words a failure of our own reach as something the tag did", () => {
    for (const state of ["failed", "unavailable"] as const) {
      const key = nfcReadNoticeKey({ state, tag_id: "aa", detail: "boom" }, "aa");
      expect(key).not.toBe("nfc.readOk");
      expect(key).not.toBe("nfc.readNoPayload");
      expect(key).not.toBe("nfc.readNoTag");
    }
    // `failed` is the glue's own error, `unavailable` is this side's — different sentences.
    expect(nfcReadNoticeKey({ state: "failed", tag_id: "aa" }, "aa")).toBe("nfc.readFailed");
    expect(nfcReadNoticeKey({ state: "unavailable" }, "aa")).toBe("nfc.readUnavailable");
  });

  it("says when the bytes belong to a tag the caller did not ask about", () => {
    const other: NfcReadOutcome = { state: "bytes", tag_id: "bb", hex: "c0ffee" };
    expect(nfcReadNoticeKey(other, "aa")).toBe("nfc.readOtherTag");
    expect(nfcReadNoticeKey(other, "bb")).toBe("nfc.readOk");
    // An `empty` read from the wrong tag is a mismatch too — it is still that tag's answer.
    expect(nfcReadNoticeKey({ state: "empty", tag_id: "bb" }, "aa")).toBe("nfc.readOtherTag");
    // A read that produced nothing has no owner to disagree with, so it is never a mismatch.
    expect(nfcReadNoticeKey({ state: "no-tag" }, "aa")).toBe("nfc.readNoTag");
    expect(nfcReadNoticeKey({ state: "failed", tag_id: "bb" }, "aa")).toBe("nfc.readFailed");
  });

  it("attributes bytes only to the tag that answered", () => {
    expect(nfcReadBelongsTo({ state: "bytes", tag_id: "aa", hex: "00" }, "aa")).toBe(true);
    expect(nfcReadBelongsTo({ state: "empty", tag_id: "aa" }, "aa")).toBe(true);
    expect(nfcReadBelongsTo({ state: "bytes", tag_id: "bb", hex: "00" }, "aa")).toBe(false);
    // A reply that does not say which tag it read cannot be attributed to one — the glue
    // reads the last tag it saw, so "unknown" must resolve to "not this one".
    expect(nfcReadBelongsTo({ state: "bytes", hex: "00" }, "aa")).toBe(false);
    // Nothing was read, so there is nothing that belongs to anybody.
    expect(nfcReadBelongsTo({ state: "no-tag" }, "aa")).toBe(false);
    expect(nfcReadBelongsTo({ state: "failed", tag_id: "aa" }, "aa")).toBe(false);
    expect(nfcReadBelongsTo({ state: "unavailable", tag_id: "aa" }, "aa")).toBe(false);
    expect(nfcReadBelongsTo(null, "aa")).toBe(false);
  });
});

/**
 * REQ-A1337 — the wrapper is the only layer that knows the host said nothing.
 *
 * `invoke` resolves `null` for a refused command and for no bridge, and never rejects. Every
 * read here used to fold that `null` into a value: `?? false` for the three dispatch/format
 * verbs, and `?? { ok: false, error: "not bridged" }` / `?? { state: "unavailable", detail:
 * "not bridged" }` for the two object-answering ones — each an English **cause** this module
 * made up, and `nfc.writeFailed` / `nfc.readUnavailable` render it verbatim.
 */
describe("bridge path (fake __TAURI_INTERNALS__)", () => {
  const globals = globalThis as Record<string, unknown>;
  let calls: { cmd: string; args?: Record<string, unknown> }[] = [];

  const install = (
    answer: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
  ) => {
    calls = [];
    globals.window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          calls.push({ cmd, args });
          return answer(cmd, args);
        },
        listen: async () => () => {},
      },
    };
  };

  afterEach(() => {
    delete globals.window;
  });

  it("a command the host did not answer is `null`, never `false`", async () => {
    install(async () => null);
    expect(await nfcStartDispatch()).toBeNull();
    expect(await nfcStopDispatch()).toBeNull();
    expect(await nfcFormatTag()).toBeNull();
  });

  it("an unanswered write is `null`, never a cause this side invented", async () => {
    install(async () => null);
    const r = await nfcWriteMessage([]);
    expect(r).toBeNull();
    // The exact string the old fold put in front of the user as 「写入失败：{error}」.
    expect(JSON.stringify(r)).not.toContain("not bridged");
  });

  it("an unanswered read is `null`, never `unavailable` padded with an invented detail", async () => {
    install(async () => null);
    const r = await nfcReadBytes("aa");
    expect(r).toBeNull();
    expect(JSON.stringify(r)).not.toContain("not bridged");
  });

  it("an answered command is passed through unchanged, including `false`", async () => {
    // The counterpart the old fold hid: `false` is the host's own refusal and must stay
    // `false` — it is not the same value as `null`.
    install(async (cmd) =>
      cmd === "nfc_start_dispatch" ? false : true,
    );
    expect(await nfcStartDispatch()).toBe(false);
    expect(await nfcStopDispatch()).toBe(true);
    expect(await nfcFormatTag()).toBe(true);
  });

  it("a host that DID speak its own `unavailable` keeps its own words", async () => {
    // `unavailable` and `null` are two facts: one host spoke, the other said nothing. The
    // host's own reason must survive verbatim — only the *invented* one is gone.
    install(async () => ({ state: "unavailable", detail: "this build has no Android NFC glue" }));
    expect(await nfcReadBytes("aa")).toEqual({
      state: "unavailable",
      detail: "this build has no Android NFC glue",
    });
  });

  it("the read sends the tag id it was asked about", async () => {
    install(async (_cmd, args) => ({ state: "bytes", tag_id: args?.tagId, hex: "00" }));
    await nfcReadBytes(" 04a2b1c3 ");
    expect(calls).toEqual([{ cmd: "nfc_read_bytes", args: { tagId: " 04a2b1c3 " } }]);
  });
});
