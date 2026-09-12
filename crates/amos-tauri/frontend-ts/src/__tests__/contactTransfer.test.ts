import { describe, expect, test } from "bun:test";
import {
  buildVcf,
  countVCards,
  escapeVCardText,
  foldVCardLine,
  mergeImported,
  parseRev,
  parseVcf,
  revFor,
  toVCard,
  unescapeVCardText,
  type ImportedContact,
} from "../lib/contactTransfer";
import { makeContactId, type Contact } from "../lib/contacts";

function c(name: string, phones: string[], extra: Partial<Contact> = {}): Contact {
  return { id: makeContactId(), name, phones, fav: false, ts: 1, ...extra };
}

function ic(name: string, phones: string[], extra: Partial<ImportedContact> = {}): ImportedContact {
  return { name, phones, fav: false, ts: 0, ...extra };
}

describe("contactTransfer: escaping & folding", () => {
  test("escapeVCardText escapes backslash, semicolon, comma, newlines", () => {
    expect(escapeVCardText("a;b,c\\d\ne")).toBe("a\\;b\\,c\\\\d\\ne");
    expect(escapeVCardText("plain")).toBe("plain");
    expect(escapeVCardText("win\r\nline")).toBe("win\\nline");
  });

  test("unescapeVCardText is the exact inverse (and tolerant of unknown escapes)", () => {
    const round = (s: string): string => unescapeVCardText(escapeVCardText(s));
    expect(round("a;b,c\\d\n张三")).toBe("a;b,c\\d\n张三");
    expect(unescapeVCardText("plain")).toBe("plain");
    expect(unescapeVCardText("trailing\\")).toBe("trailing"); // malformed lone `\`
    expect(unescapeVCardText("x\\q")).toBe("xq"); // unknown escape keeps the char
  });

  test("foldVCardLine keeps short lines and folds long ones by octets", () => {
    expect(foldVCardLine("short")).toBe("short");
    const long = "x".repeat(200);
    const folded = foldVCardLine(long);
    for (const line of folded.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(long); // unfolding restores
    // 40 CJK chars = 120 octets → must fold (a char-based limit would not).
    const cjk = "汉".repeat(40);
    const cjkFolded = foldVCardLine(`NOTE:${cjk}`);
    expect(cjkFolded).toContain("\r\n ");
    for (const line of cjkFolded.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});

describe("contactTransfer: REV timestamps", () => {
  test("revFor emits ISO for positive ts, null for unknown", () => {
    expect(revFor(0)).toBeNull();
    expect(revFor(-5)).toBeNull();
    expect(revFor(Number.NaN)).toBeNull();
    expect(revFor(1000)).toBe("1970-01-01T00:00:01.000Z");
  });

  test("parseRev reads ISO extended, vCard basic, and refuses garbage", () => {
    expect(parseRev("2026-09-12T08:00:00Z")).toBe(Date.parse("2026-09-12T08:00:00Z"));
    expect(parseRev("20260912T080000Z")).toBe(Date.parse("2026-09-12T08:00:00Z"));
    expect(parseRev("20260912T080000")).toBe(Date.parse("2026-09-12T08:00:00Z")); // naive = UTC
    expect(parseRev("not a time")).toBe(0);
    expect(parseRev("")).toBe(0);
    expect(parseRev(42)).toBe(0);
    expect(parseRev(undefined)).toBe(0);
  });

  test("parseRev keeps fractional seconds in both forms (no silent rounding)", () => {
    // Pre-fix the basic form's `(?:\.\d+)?` matched the fraction and dropped it.
    expect(parseRev("20260912T080000.123Z")).toBe(Date.parse("2026-09-12T08:00:00Z") + 123);
    expect(parseRev("20260912T080000.5Z")).toBe(Date.parse("2026-09-12T08:00:00Z") + 500);
    // The extended fallthrough always had it via Date.parse — incl. offset zones.
    expect(parseRev("2026-09-12T08:00:00.25Z")).toBe(Date.parse("2026-09-12T08:00:00.250Z"));
    expect(parseRev("20260912T080000.25+0800")).toBe(Date.parse("2026-09-12T08:00:00.250+08:00"));
  });
});

describe("contactTransfer: export (toVCard / buildVcf)", () => {
  test("a minimal contact serializes to the exact vCard 3.0 shape", () => {
    const v = toVCard({ id: "c1", name: "张三", phones: ["13800000001"], fav: false, ts: 0 });
    expect(v).toBe(
      [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "N:张三;;;;",
        "FN:张三",
        "TEL:13800000001",
        "UID:c1",
        "END:VCARD",
      ].join("\r\n"),
    );
  });

  test("multi-phone, note, favorite, uid and rev are all exported", () => {
    const v = toVCard({
      id: "c9",
      name: "Alice",
      phones: ["111", "222"],
      note: "家人",
      fav: true,
      ts: 1000,
    });
    expect(v).toContain("TEL:111");
    expect(v).toContain("TEL:222");
    expect(v).toContain("NOTE:家人");
    expect(v).toContain("CATEGORIES:Favorites");
    expect(v).toContain("UID:c9");
    expect(v).toContain("REV:1970-01-01T00:00:01.000Z");
    expect(v).toContain("END:VCARD");
    expect(v).not.toBe("");
  });

  test("values with ; , \\ and newlines are escaped (round-trip safe)", () => {
    const v = toVCard({ id: "c2", name: "A;B,C\\D", phones: ["1"], note: "x\ny", fav: false, ts: 0 });
    expect(v).toContain("FN:A\\;B\\,C\\\\D");
    expect(v).toContain("NOTE:x\\ny");
    const back = parseVcf(v);
    expect(back.entries).toHaveLength(1);
    expect(back.entries[0]!.name).toBe("A;B,C\\D");
    expect(back.entries[0]!.note).toBe("x\ny");
  });

  test("unusable contacts serialize to empty and are skipped by buildVcf", () => {
    expect(toVCard({ id: "x", name: "", phones: ["1"], fav: false, ts: 0 })).toBe("");
    expect(toVCard({ id: "x", name: "A", phones: [], fav: false, ts: 0 })).toBe("");
    expect(buildVcf([c("", ["1"]), c("A", [])])).toBe("");
  });

  test("buildVcf joins cards with CRLF, ends with CRLF, and is total", () => {
    const vcf = buildVcf([c("A", ["1"]), c("B", ["2"])]);
    expect(vcf.endsWith("\r\n")).toBe(true);
    expect(vcf.split("BEGIN:VCARD").length - 1).toBe(2);
    expect(vcf.split("END:VCARD\r\n").length - 1).toBe(2);
    expect(buildVcf([])).toBe("");
    expect(buildVcf("nope")).toBe("");
    expect(buildVcf(null)).toBe("");
  });
});


describe("contactTransfer: import (parseVcf)", () => {
  test("round-trips our own export (CRLF + folding + escapes)", () => {
    const book = [
      c("张三", ["13800000001", "+86 139 0000 0002"], {
        fav: true,
        note: "家人\n常联系",
        ts: 1726100000000,
      }),
      c("Bob Smith", ["10086"], { note: "x".repeat(200), ts: 0 }),
    ];
    const res = parseVcf(buildVcf(book));
    expect(res.blocks).toBe(2);
    expect(res.invalid).toBe(0);
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]!.name).toBe("张三");
    expect(res.entries[0]!.phones).toEqual(["13800000001", "+86 139 0000 0002"]);
    expect(res.entries[0]!.fav).toBe(true);
    expect(res.entries[0]!.note).toBe("家人\n常联系");
    expect(res.entries[0]!.ts).toBe(1726100000000);
    expect(res.entries[1]!.note).toBe("x".repeat(200));
    expect(res.entries[1]!.ts).toBe(0);
  });

  test("is tolerant: LF endings, BOM, lowercase properties, blank lines", () => {
    const text =
      "\uFEFFbegin:vcard\nversion:3.0\nfn:Carl\ntel:123\nend:vcard\n\n" +
      "BEGIN:VCARD\nFN:Dora\nTEL:456\nEND:VCARD\n";
    const res = parseVcf(text);
    expect(res.blocks).toBe(2);
    expect(res.entries.map((e) => e.name)).toEqual(["Carl", "Dora"]);
    expect(res.entries[0]!.phones).toEqual(["123"]);
  });

  test("prefers FN, but reconstructs a display name from N components", () => {
    const fnOnly = parseVcf("BEGIN:VCARD\nN:Gagarin;Yuri;A;;;\nFN:Major Yuri\nTEL:1\nEND:VCARD");
    expect(fnOnly.entries[0]!.name).toBe("Major Yuri");
    const nOnly = parseVcf("BEGIN:VCARD\nN:Gagarin;Yuri;A;;;\nTEL:1\nEND:VCARD");
    expect(nOnly.entries[0]!.name).toBe("Yuri A Gagarin"); // Prefix Given Middle Family Suffix
    const cjk = parseVcf("BEGIN:VCARD\nN:张三;;;;\nTEL:1\nEND:VCARD");
    expect(cjk.entries[0]!.name).toBe("张三");
  });

  test("handles escaped separators, quoted params, group prefixes", () => {
    // `TEL;TYPE="a:b":...` — the colon inside quotes is not a name/value split.
    const res = parseVcf(
      "BEGIN:VCARD\r\nFN:A\\;B\r\nTEL;TYPE=\"a:b\":123\r\nitem1.TEL:456\r\nEND:VCARD",
    );
    expect(res.entries[0]!.name).toBe("A;B");
    expect(res.entries[0]!.phones).toEqual(["123", "456"]);
  });

  test("ignores unknown properties and multi-octet values with colons", () => {
    const res = parseVcf(
      "BEGIN:VCARD\nFN:Carl\nX-FOO:bar:baz\nPHOTO:data:image/png;base64,AAAA\nTEL:1\nEND:VCARD",
    );
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.name).toBe("Carl");
  });

  test("counts invalid blocks instead of dropping them silently", () => {
    const res = parseVcf(
      "BEGIN:VCARD\nFN:NoPhone\nEND:VCARD\nBEGIN:VCARD\nTEL:1\nEND:VCARD\nBEGIN:VCARD\nFN:Ok\nTEL:2\nEND:VCARD",
    );
    expect(res.blocks).toBe(3);
    expect(res.invalid).toBe(2);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.name).toBe("Ok");
  });

  test("unterminated final card is still parsed; garbage yields zero blocks", () => {
    const res = parseVcf("BEGIN:VCARD\nFN:Last\nTEL:9");
    expect(res.blocks).toBe(1);
    expect(res.entries[0]!.name).toBe("Last");
    const none = parseVcf("hello world\r\njust text");
    expect(none).toEqual({ entries: [], blocks: 0, invalid: 0 });
  });

  test("is total: non-string input never throws", () => {
    expect(parseVcf(null)).toEqual({ entries: [], blocks: 0, invalid: 0 });
    expect(parseVcf(undefined)).toEqual({ entries: [], blocks: 0, invalid: 0 });
    expect(parseVcf(42)).toEqual({ entries: [], blocks: 0, invalid: 0 });
    expect(parseVcf({})).toEqual({ entries: [], blocks: 0, invalid: 0 });
  });
});


describe("contactTransfer: merge (mergeImported)", () => {
  test("adds new contacts: prepended, fresh unique ids, ts fallback to now", () => {
    const existing = [c("Alice", ["111"])];
    const out = mergeImported(existing, [ic("Bob", ["222"]), ic("Carol", ["333"])], 5000);
    expect(out.added).toBe(2);
    expect(out.dupSkipped).toBe(0);
    expect(out.list).toHaveLength(3);
    expect(out.list[0]!.name).toBe("Carol"); // prepend, last-added first
    expect(new Set(out.list.map((x) => x.id)).size).toBe(3); // fresh unique ids
    // Pre-existing Alice keeps her old ts; only imported entries fall back to `now`.
    expect(out.list.filter((x) => x.name !== "Alice").every((x) => x.ts === 5000)).toBe(true);
    expect(out.list.find((x) => x.name === "Alice")!.ts).toBe(1);
  });

  test("keeps a parsed REV timestamp when present", () => {
    const out = mergeImported([], [ic("Old", ["1"], { ts: 1726100000000 })], 5000);
    expect(out.list[0]!.ts).toBe(1726100000000);
  });

  test("skips duplicates by digit-normalized phone (+CC / bare suffix)", () => {
    const existing = [c("Alice", ["+8613800000001"])];
    const out = mergeImported(existing, [ic("Copy", ["13800000001"])], 5000);
    expect(out.added).toBe(0);
    expect(out.dupSkipped).toBe(1);
    expect(out.list).toBe(existing); // untouched (same reference)
  });

  test("an entry with ANY existing phone is skipped whole (no partial merge)", () => {
    const existing = [c("Alice", ["111"])];
    const out = mergeImported(existing, [ic("Mixed", ["999", "111"])], 5000);
    expect(out.added).toBe(0);
    expect(out.dupSkipped).toBe(1);
    expect(out.list).toHaveLength(1);
  });

  test("duplicate detection accumulates within one import", () => {
    const out = mergeImported([], [ic("Twin", ["555"]), ic("Twin2", ["555"])], 5000);
    expect(out.added).toBe(1);
    expect(out.dupSkipped).toBe(1);
    expect(out.list).toHaveLength(1);
  });

  test("counts defensively-invalid entries (parser should have caught them)", () => {
    const out = mergeImported([], [ic("", ["1"]), ic("NoPhone", []), ic("Ok", ["2"])], 5000);
    expect(out.added).toBe(1);
    expect(out.invalidSkipped).toBe(2);
  });

  test("is total and pure: never mutates the inputs, tolerates non-arrays", () => {
    const existing = [c("Alice", ["111"])];
    const snapshot = JSON.stringify(existing);
    const incoming = [ic("Bob", ["222"])];
    mergeImported(existing, incoming, 5000);
    expect(JSON.stringify(existing)).toBe(snapshot);
    const empty = mergeImported([], "nope" as unknown as ImportedContact[], 5000);
    expect(empty.added).toBe(0);
    expect(empty.list).toEqual([]);
    const none = mergeImported([], [], 5000);
    expect(none.added).toBe(0);
    expect(none.list).toEqual([]);
  });
});
describe("contactTransfer: audit hardening", () => {
  test("revFor / toVCard / buildVcf stay total on an unrepresentable ts", () => {
    // Pre-fix, each of these THREW RangeError ("Invalid Date") — one corrupt
    // stored ts took down the whole export path.
    expect(revFor(1e16)).toBeNull();
    expect(revFor(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(revFor(8.64e15)).not.toBeNull(); // the representable edge still exports
    const corrupt: Contact = { id: "cx", name: "张三", phones: ["13800000001"], fav: false, ts: 1e16 };
    const v = toVCard(corrupt);
    expect(v).toContain("BEGIN:VCARD");
    expect(v).toContain("UID:cx");
    expect(v).not.toContain("REV:"); // unrepresentable → honest "unknown revision"
    const out = buildVcf([corrupt, c("Ok", ["13800000002"])]);
    expect(out.split("BEGIN:VCARD")).toHaveLength(3); // both cards, nothing thrown away
  });

  test("several NOTE lines are joined, blank ones dropped (no silent loss)", () => {
    const res = parseVcf(
      "BEGIN:VCARD\r\nFN:双注\r\nTEL:1\r\nNOTE:first\r\nNOTE:second\r\nNOTE:   \r\nEND:VCARD",
    );
    expect(res.entries[0]?.note).toBe("first\nsecond");
  });

  test("numeric UTC offsets parse even on engines that reject the bare form", () => {
    const real = Date.parse;
    // V8 happens to accept `±HHMM`; an engine that refuses it (JSC has been
    // strict here) must still get the right instant, because parseRev
    // normalizes offsets to `±HH:MM` before calling Date.parse.
    const strict = (s: string): number => (/[+-]\d{4}$/.test(s) ? NaN : real(s));
    const want = real("2026-09-12T08:00:00+08:00");
    expect(want).not.toBeNaN();
    Date.parse = strict as typeof Date.parse;
    try {
      expect(parseRev("20260912T080000+0800")).toBe(want);
      expect(parseRev("2026-09-12T08:00:00+0800")).toBe(want);
      expect(parseRev("20260912T080000z")).toBe(real("2026-09-12T08:00:00Z"));
    } finally {
      Date.parse = real;
    }
  });

  test("mergeImported clamps a garbage ts to `now`", () => {
    const out = mergeImported([], [ic("X", ["5"], { ts: 1e16 })], 5000);
    expect(out.added).toBe(1);
    expect(out.list[0]!.ts).toBe(5000);
  });

  test("countVCards counts cards, not literal BEGIN:VCARD substrings", () => {
    const trickster: Contact = {
      id: "t1",
      name: "骗子",
      phones: ["13900000002"],
      fav: false,
      ts: 1000,
      note: "BEGIN:VCARD\r\nEND:VCARD",
    };
    expect(countVCards([trickster])).toBe(1);
    expect(countVCards([trickster, c("Ok", ["13800000003"]), c("", [])])).toBe(2);
    expect(countVCards("nope")).toBe(0);
    expect(countVCards(null)).toBe(0);
    expect(countVCards([])).toBe(0);
  });
});

