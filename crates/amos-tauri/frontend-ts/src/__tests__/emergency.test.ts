import { describe, expect, test } from "bun:test";
import {
  deviceQuickEmergencyNumber,
  EMERGENCY_LABEL_KEYS,
  EMERGENCY_QUICK_NUMBER,
  EMERGENCY_NUMBERS,
  emergencyLabelKey,
  isEmergencyNumber,
  quickEmergencyNumber,
  quickEmergencyNumberForLocale,
  regionFromLocale,
} from "../lib/emergency";
import { en } from "../i18n/locales/en";
import { zh } from "../i18n/locales/zh";

describe("the dialer page's emergency buttons are labelled", () => {
  test("every listed number has a label, and the table names nothing else", () => {
    // Two-sided binding (REQ-A1138 / F-SH-445): the page's presentation list and its
    // label table are one thing. A code added to `EMERGENCY_NUMBERS` alone would draw an
    // emergency button with **no name** — the exact surface nobody would notice until an
    // emergency. The first direction is the one that matters (an unlabelled button), the
    // second keeps the table honest (a label for a number the page never draws).
    for (const code of EMERGENCY_NUMBERS) {
      expect(EMERGENCY_LABEL_KEYS[code], code).toBeTruthy();
    }
    expect(Object.keys(EMERGENCY_LABEL_KEYS).sort()).toEqual([...EMERGENCY_NUMBERS].sort());
  });

  test("a number the label table does not name still gets a label", () => {
    // The fallback the phone screen's old inline lookup *claimed* to have: it folded an
    // unknown code to `""` before the caller's `?? generic`, and `""` is not nullish, so
    // that fallback could never fire. `emergencyLabelKey` returns the key instead, so an
    // unlisted code degrades to the generic sentence rather than a blank button.
    expect(emergencyLabelKey("110")).toBe("phone.emergency.police");
    for (const other of ["999", "000", "911", "", "110110"]) {
      expect(emergencyLabelKey(other), other).toBe("phone.emergencyGeneric");
    }
  });

  test("every key the page renders resolves in both dictionaries", () => {
    // `translate()` answers a missing key with the key itself (`i18n.ts:43`), so a label
    // key absent from a dictionary would print `phone.emergency.fire` verbatim. The
    // generic key is included because it is the one the fallback above reaches for.
    const keys = [...Object.values(EMERGENCY_LABEL_KEYS), "phone.emergencyGeneric"];
    // The dictionaries are keyed by literal type; a computed lookup is cast (the same
    // thing `translate()` does with its `Record<string, string>` parameter).
    const zhDict = zh as Record<string, string>;
    const enDict = en as Record<string, string>;
    for (const key of keys) {
      expect(zhDict[key], `zh ${key}`).toBeTruthy();
      expect(enDict[key], `en ${key}`).toBeTruthy();
    }
  });
});

describe("emergency quick-dial source", () => {
  test("product default is the CN police code 110", () => {
    expect(EMERGENCY_QUICK_NUMBER).toBe("110");
  });

  test("region selection mirrors the Rust EmergencyMap::quick_dial", () => {
    expect(quickEmergencyNumber("CN")).toBe("110");
    expect(quickEmergencyNumber(" cn ")).toBe("110"); // case/space-insensitive
    expect(quickEmergencyNumber("JP")).toBe("110");
    expect(quickEmergencyNumber("KR")).toBe("112"); // Korea's police, not 110
    expect(quickEmergencyNumber("US")).toBe("911");
    expect(quickEmergencyNumber("AU")).toBe("000"); // AU/NZ emergency, not 911
    expect(quickEmergencyNumber("NZ")).toBe("000");
    expect(quickEmergencyNumber("GB")).toBe("112");
    expect(quickEmergencyNumber("DE")).toBe("112");
    expect(quickEmergencyNumber("XX")).toBe("112"); // universal default
    expect(quickEmergencyNumber("")).toBe("112");
  });

  test("recognized codes are always within the platform emergency family", () => {
    // The lock-screen one-tap number must itself classify as emergency so the
    // daemon routes it on the privileged path, never as a regular SIM call.
    const known = new Set(["110", "112", "911", "119", "120", "122", "999", "000"]);
    expect(known.has(EMERGENCY_QUICK_NUMBER)).toBe(true);
    for (const region of ["CN", "KR", "US", "AU", "NZ", "GB", "JP", "DE", "XX", ""]) {
      expect(known.has(quickEmergencyNumber(region)), region).toBe(true);
    }
  });
});

describe("isEmergencyNumber — the classification the dial surfaces hand the daemon", () => {
  test("every recognized code answers yes, and nothing else does", () => {
    for (const code of EMERGENCY_NUMBERS) expect(isEmergencyNumber(code)).toBe(true);
    // The two-sided half: a regular number must NOT be classified as emergency, or the
    // daemon would be asked to take its privileged route for an ordinary call.
    for (const other of ["13800000001", "1100", "011", "10086", ""]) {
      expect(isEmergencyNumber(other)).toBe(false);
    }
  });

  test("covers every code the daemon's own table recognizes", () => {
    // `EmergencyMap::common_global()` (`number.rs`) is the table the daemon consults when
    // no jurisdiction is known. Its own doc calls it "deliberately broad" and states the
    // requirement: it "must be a **superset of every code the device recognizes**", because
    // "the cost of over-classifying is a regular number forced onto the emergency path, while
    // the cost of under-classifying is a **recorded emergency**".
    //
    // `isEmergencyNumber` feeds that same requirement through the frontend (`PhoneApp` /
    // `ContactsApp` pass its answer as `telephony_dial`'s `emergency` argument), so it must be
    // at least as broad. It was fed the dialer page's *presentation* list instead, which covers
    // 5 of the daemon's 10 codes — so a keypad-typed `911`/`000`/`999`/`118`/`108` reached the
    // daemon as an ordinary dial, which the mock provider's `guard_regular` refuses outright.
    for (const code of ["911", "999", "000", "118", "108"]) {
      expect(isEmergencyNumber(code), code).toBe(true);
    }
  });

  test("surrounding whitespace is not a different number", () => {
    expect(isEmergencyNumber(" 110 ")).toBe(true);
    expect(isEmergencyNumber("110\t")).toBe(true);
  });

  test("the separators the daemon strips are not a different number either", () => {
    // `Number::new` (`crates/amos-telephony/src/number.rs`) strips spaces / hyphens /
    // parentheses before `digits()` feeds `EmergencyMap::is_emergency`, and
    // `docs/telephony.md` §5 guarantee #5 states the consequence as a requirement:
    // 「紧急号去空格/连字符后仍须命中 `EmergencyMap`；命中即走紧急通路，绝不落进普通 dial 被
    // SIM 判断拒掉」. The frontend asks that same classification question and passes the
    // answer to the daemon, so it must not answer it with a weaker normaliser than the
    // daemon's — a number a phone number field can hold verbatim ("1 1 0") is the same
    // emergency number to the daemon and must be to us.
    for (const spaced of ["1 1 0", "1-1-0", "(110)", "11-2", "9 1 1", "0 0 0", "1 (1) 9"]) {
      expect(isEmergencyNumber(spaced), spaced).toBe(true);
    }
    // The two-sided half: a separator is not a digit — stripping must not weld two
    // ordinary numbers into a code ("1 100" is not 1100 either, but "1 1 00" must not
    // read as 1100… it is 1100, which is still not an emergency code).
    for (const other of ["1 100", "1 1 00", "11 0 0", "-110-1", "(1100)"]) {
      expect(isEmergencyNumber(other), other).toBe(false);
    }
  });
});

describe("region from a BCP-47 locale tag", () => {
  test("reads the region subtag, skipping scripts", () => {
    expect(regionFromLocale("zh-CN")).toBe("CN");
    expect(regionFromLocale("ko-KR")).toBe("KR");
    expect(regionFromLocale("en-US")).toBe("US");
    expect(regionFromLocale("sr-Latn-RS")).toBe("RS"); // script skipped
    expect(regionFromLocale("zh-Hant-TW")).toBe("TW");
    expect(regionFromLocale("EN-gb")).toBe("GB"); // case-insensitive
  });

  test("accepts an underscore separator (some platform APIs spell it that way)", () => {
    expect(regionFromLocale("en_US")).toBe("US");
  });

  test("names no region when the tag has none — never a guessed country", () => {
    expect(regionFromLocale("en")).toBe("");
    expect(regionFromLocale("zh-Hans")).toBe(""); // script, not a region
    expect(regionFromLocale("")).toBe("");
    expect(regionFromLocale("und")).toBe("");
    // The universal 112 is the answer, not the CN default: a locale that names no
    // region must not silently dial one country's code.
    expect(quickEmergencyNumberForLocale("en")).toBe("112");
    expect(quickEmergencyNumberForLocale("")).toBe("112");
  });

  test("a locale maps to the same number a bare region does", () => {
    expect(quickEmergencyNumberForLocale("ko-KR")).toBe("112");
    expect(quickEmergencyNumberForLocale("en-US")).toBe("911");
    expect(quickEmergencyNumberForLocale("en-AU")).toBe("000");
    expect(quickEmergencyNumberForLocale("zh-CN")).toBe("110");
  });
});

describe("device quick-dial number", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const withLocale = (language: string | undefined) => {
    Object.defineProperty(globalThis, "navigator", {
      value: language === undefined ? undefined : { language },
      configurable: true,
      writable: true,
    });
  };
  const restore = () => {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete (globalThis as Record<string, unknown>).navigator;
  };

  test("follows the OS locale, not the UI language", () => {
    try {
      withLocale("ko-KR");
      expect(deviceQuickEmergencyNumber()).toBe("112"); // not the CN/JP 110
      withLocale("en-US");
      expect(deviceQuickEmergencyNumber()).toBe("911");
      withLocale("zh-CN");
      expect(deviceQuickEmergencyNumber()).toBe("110");
    } finally {
      restore();
    }
  });

  test("with no navigator at all, it answers the universal 112", () => {
    try {
      withLocale(undefined);
      expect(deviceQuickEmergencyNumber()).toBe("112");
    } finally {
      restore();
    }
  });

  test("a locale with no region, or a malformed one, never dials a country code", () => {
    try {
      withLocale("en");
      expect(deviceQuickEmergencyNumber()).toBe("112");
      withLocale("");
      expect(deviceQuickEmergencyNumber()).toBe("112");
      withLocale("ko");
      expect(deviceQuickEmergencyNumber()).toBe("112");
    } finally {
      restore();
    }
  });
});
