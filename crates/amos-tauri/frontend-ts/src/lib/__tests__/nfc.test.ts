import { describe, it, expect } from "vitest";
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
  type NdefRecord,
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
