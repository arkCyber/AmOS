import { describe, expect, test } from "bun:test";
import {
  CONTACTS_KEY,
  addContact,
  cleanName,
  cleanPhones,
  contactById,
  editContact,
  isContactValid,
  makeContactId,
  normalizeContacts,
  normalizeOne,
  phoneDigits,
  primaryPhone,
  removeContact,
  searchContacts,
  seedContacts,
  setContactFav,
  sortContacts,
  contactsWithPhone,
  contactsWithPhoneExcept,
  contactNameFor,
  contactLetter,
  avatarHue,
  groupContacts,
  upsertContact,
  type Contact,
} from "../lib/contacts";

function c(name: string, phones: string[], fav = false): Contact {
  return { id: makeContactId(), name, phones, fav, ts: 1 };
}

describe("contacts: normalization & validation", () => {
  test("cleanName trims and collapses whitespace", () => {
    expect(cleanName("  张 三  ")).toBe("张 三");
    expect(cleanName(42)).toBe("");
    expect(cleanName("   ")).toBe("");
  });

  test("cleanPhones trims, drops blanks/dupes, keeps order", () => {
    expect(cleanPhones([" 138 ", " 138 ", "", "139", 7, "  "])).toEqual(["138", "139"]);
    expect(cleanPhones("nope")).toEqual([]);
  });

  test("isContactValid needs a name and at least one phone", () => {
    expect(isContactValid({ name: "A", phones: ["1"] })).toBe(true);
    expect(isContactValid({ name: "  ", phones: ["1"] })).toBe(false);
    expect(isContactValid({ name: "A", phones: [] })).toBe(false);
  });

  test("makeContactId is unique", () => {
    expect(makeContactId()).not.toBe(makeContactId());
  });

  test("normalizeOne repairs or rejects malformed entries", () => {
    const used = new Set<string>();
    expect(normalizeOne(null, "x", used)).toBeNull();
    expect(normalizeOne({ name: "A", phones: [] }, "x", used)).toBeNull();
    const ok = normalizeOne({ name: " A ", phones: [" 1 ", "1"], note: " n ", fav: true }, "id1", used);
    expect(ok).toEqual({ id: "id1", name: "A", phones: ["1"], note: "n", fav: true, ts: 0 });
    expect(normalizeOne({ name: "B", phones: ["2"] }, "id1", used)).toBeNull(); // dup id
  });

  test("normalizeContacts drops invalid + dedupes + assigns ids", () => {
    const bad = [null, { name: "X" }, { name: "Y", phones: ["1"] }, { name: "Z", phones: ["2"] }];
    const good = { id: "keep", name: "K", phones: ["9"], fav: true, ts: 5 };
    const out = normalizeContacts([...bad, good, good]);
    expect(out).toHaveLength(3);
    expect(out.filter((x) => x.name === "K")).toHaveLength(1); // dedupe by id
    expect(normalizeContacts("nope")).toEqual([]);
  });

  test("seedContacts yields valid, non-empty entries", () => {
    const s = seedContacts(0);
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) expect(x.ts).toBe(0);
    expect(s.some((x) => x.fav)).toBe(true);
  });
});

describe("contacts: list operations", () => {
  const a = c("Alice", ["111"]);
  const b = c("Bob", ["222"], true);
  const list = [a, b];

  test("primaryPhone returns the first number", () => {
    expect(primaryPhone(a)).toBe("111");
    expect(primaryPhone({ ...a, phones: [] })).toBeUndefined();
  });

  test("addContact prepends valid input, ignores invalid, never mutates", () => {
    expect(list).toHaveLength(2);
    const added = addContact(list, { name: " Carol ", phones: [" 333 ", "333"], note: "n" });
    expect(added).toHaveLength(3);
    expect(added[0]!.name).toBe("Carol");
    expect(added[0]!.phones).toEqual(["333"]);
    expect(added[0]!.fav).toBe(false);
    expect(list).toHaveLength(2); // immutable
    expect(addContact(list, { name: "  ", phones: ["1"] })).toBe(list);
  });

  test("upsertContact replaces by id or prepends", () => {
    const updated = upsertContact(list, { ...a, name: "Alice2", phones: ["999"] });
    expect(contactById(updated, a.id)?.name).toBe("Alice2");
    expect(contactById(updated, a.id)?.phones).toEqual(["999"]);
    const fresh = upsertContact(list, { id: "new", name: "New", phones: ["7"] });
    expect(contactById(fresh, "new")).toBeDefined();
  });

  test("removeContact / setContactFav / editContact", () => {
    const removed = removeContact(list, a.id);
    expect(removed.some((x) => x.id === a.id)).toBe(false);
    expect(list).toHaveLength(2);

    const faved = setContactFav(list, a.id, true);
    expect(contactById(faved, a.id)?.fav).toBe(true);
    expect(contactById(faved, a.id)?.name).toBe("Alice");

    const edited = editContact(list, a.id, { name: " Alice ", phones: ["4"], note: "work" });
    expect(contactById(edited, a.id)).toMatchObject({ name: "Alice", phones: ["4"], note: "work" });
    expect(editContact(list, "ghost", { name: "X" })).toBe(list);
    expect(editContact(list, a.id, { name: "  " })).toBe(list);
  });
});


describe("contacts: search & sort & store round-trip", () => {
  const list = [
    c("Alice", ["+86 138 0000 0001"], false),
    c("Bob", ["222"]),
    c("Carol", ["333"], true),
  ];

  test("searchContacts matches name (case-insensitive) and phone digits", () => {
    expect(searchContacts(list, "")).toBe(list);
    expect(searchContacts(list, "ali")).toHaveLength(1);
    expect(searchContacts(list, "ALICE")).toHaveLength(1);
    expect(searchContacts(list, "13800000001")).toHaveLength(1); // via digits
    expect(searchContacts(list, "1380")).toHaveLength(1);
    expect(searchContacts(list, "zzz")).toHaveLength(0);
  });

  test("phoneDigits strips separators, keeps leading +", () => {
    expect(phoneDigits("+86 138-0000 0001")).toBe("+8613800000001");
    expect(phoneDigits("138 (0000) 0001")).toBe("13800000001");
  });

  test("contactsWithPhone matches the same normalized number", () => {
    expect(contactsWithPhone(list, "138 0000 0001")).toHaveLength(1); // Alice
    expect(contactsWithPhone(list, "+86 13800000001")).toHaveLength(1);
    expect(contactsWithPhone(list, "999")).toHaveLength(0);
    expect(contactsWithPhone(list, "")).toHaveLength(0);
  });

  test("contactNameFor reverse-looks-up a number to a contact name", () => {
    expect(contactNameFor(list, "+86 138 0000 0001")).toBe("Alice");
    expect(contactNameFor(list, "222")).toBe("Bob");
    expect(contactNameFor(list, "12345")).toBeNull();
    expect(contactNameFor([], "138 0000 0001")).toBeNull();
  });

  test("contactsWithPhoneExcept excludes one contact (edit-time dup check)", () => {
    const alice = list[0]!;
    const bob = list[1]!;
    // Alice holds "+86 138 0000 0001".
    expect(contactsWithPhoneExcept(list, "138 0000 0001", alice.id)).toHaveLength(0); // self allowed
    expect(contactsWithPhoneExcept(list, "138 0000 0001", bob.id)).toHaveLength(1); // other blocks
    expect(contactsWithPhoneExcept(list, "222", alice.id)).toHaveLength(1); // bob's number
  });

  test("sortContacts puts favorites first then name order", () => {
    const sorted = sortContacts(list);
    expect(sorted[0]!.name).toBe("Carol"); // favorite first
    expect(sorted[1]!.name).toBe("Alice");
    expect(sorted[2]!.name).toBe("Bob");
    expect(list.map((x) => x.name)).toEqual(["Alice", "Bob", "Carol"]); // immutable
  });

  test("contactById finds or returns undefined", () => {
    const a = list[0]!;
    expect(contactById(list, a.id)?.name).toBe("Alice");
    expect(contactById(list, "nope")).toBeUndefined();
  });

  test("addContact → normalizeContacts keeps the produced contact valid", () => {
    const next = addContact([], { name: " Z  Q ", phones: ["+86 138 0000", ""] });
    const back = normalizeContacts(next);
    expect(back[0]!.name).toBe("Z Q");
    expect(back[0]!.phones).toEqual(["+86 138 0000"]);
    expect(CONTACTS_KEY).toBe("amos.contacts");
  });

  test("grouping & avatar helpers are pure and stable", () => {
    expect(contactLetter("alice")).toBe("A");
    expect(contactLetter("张三")).toBe("#"); // non-latin → '#'
    expect(contactLetter("  ")).toBe("#");
    expect(contactLetter("9tails")).toBe("9");

    // avatarHue deterministic 0–359
    const a = avatarHue("Alice");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);
    expect(avatarHue("Alice")).toBe(a);

    // groupContacts buckets a sorted list by letter (UI feeds it sorted output)
    const groups = groupContacts([
      c("abe", ["2"]),
      c("bob", ["1"]),
      c("张三", ["3"]),
    ]);
    expect(groups.map((g) => g.letter)).toEqual(["A", "B", "#"]);
    expect(groups[0]!.items.map((x) => x.name)).toEqual(["abe"]);
    expect(groups[1]!.items[0]!.name).toBe("bob");
  });
});
