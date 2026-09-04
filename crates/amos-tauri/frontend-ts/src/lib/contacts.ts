/**
 * Contacts (address book) domain — the phone's "通信录".
 *
 * Pure, immutable, validation-normalizing operations on a list of {@link Contact},
 * persisted under `amos.contacts` in the shared store (so it survives restarts on
 * disk). All list operations return new arrays and never mutate their input; they
 * tolerate corrupt / partial stored data via {@link normalizeContacts}.
 */

/** A single address-book entry. */
export interface Contact {
  id: string;
  /** Display name (required, non-blank after trimming). */
  name: string;
  /** Phone numbers, each non-blank after trimming. */
  phones: string[];
  /** Free-form note (optional). */
  note?: string;
  /** Marked as a favorite (pinned to the top of the list). */
  fav: boolean;
  /** Last modified / created wall-clock ms. */
  ts: number;
}

/** Input accepted when creating/editing a contact. */
export interface ContactInput {
  name: string;
  phones: string[];
  note?: string;
}

/** Shared-store key under which the contact list is persisted. */
export const CONTACTS_KEY = "amos.contacts";

/* ---- normalization helpers ------------------------------------------------- */

/** Trim + collapse internal whitespace; `""` if blank. */
export function cleanName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name.trim().replace(/\s+/g, " ");
}

/** Trim, drop blanks, dedupe in order. */
export function cleanPhones(phones: unknown): string[] {
  if (!Array.isArray(phones)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of phones) {
    if (typeof p !== "string") continue;
    const t = p.trim();
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** A new unique contact id (time + random suffix). */
export function makeContactId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** A contact is usable iff it has a name and at least one phone number. */
export function isContactValid(c: ContactInput): boolean {
  return cleanName(c.name) !== "" && cleanPhones(c.phones).length > 0;
}

/** Clean a raw contact into a {@link Contact}, or `null` when unusable. */
export function normalizeOne(
  raw: unknown,
  id: string,
  used: Set<string>,
): Contact | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = cleanName(o.name);
  const phones = cleanPhones(o.phones);
  if (name === "" || phones.length === 0) return null;
  if (used.has(id)) return null; // duplicate id
  used.add(id);
  return {
    id,
    name,
    phones,
    note: typeof o.note === "string" && o.note.trim() !== "" ? o.note.trim() : undefined,
    fav: o.fav === true,
    ts: typeof o.ts === "number" && Number.isFinite(o.ts) ? o.ts : 0,
  };
}

/** Validate a stored list: keep usable contacts, drop/repair the rest. */
export function normalizeContacts(raw: unknown): Contact[] {
  if (!Array.isArray(raw)) return [];
  const used = new Set<string>();
  const out: Contact[] = [];
  for (const r of raw) {
    const o = r as Record<string, unknown> | null;
    const id = typeof o?.id === "string" && o.id !== "" ? o.id : makeContactId();
    const c = normalizeOne(r, id, used);
    if (c) out.push(c);
  }
  return out;
}

/** A small, sensible starter list for the first run. */
export function seedContacts(now: number = Date.now()): Contact[] {
  const mk = (name: string, phones: string[], fav = false, note?: string): Contact => ({
    id: makeContactId(),
    name,
    phones,
    fav,
    note,
    ts: now,
  });
  return [
    mk("张三", ["13800000001"], true, "家人"),
    mk("李四", ["13900000002"], false),
    mk("客服热线", ["10086"]),
  ];
}

/** The first phone number, if any (what a "call" button dials). */
export function primaryPhone(c: Contact): string | undefined {
  return c.phones[0];
}

/* ---- immutable list operations -------------------------------------------- */

/** Prepend a validated new contact. Returns the input unchanged when invalid. */
export function addContact(list: Contact[], input: ContactInput): Contact[] {
  if (!isContactValid(input)) return list;
  const c: Contact = {
    id: makeContactId(),
    name: cleanName(input.name),
    phones: cleanPhones(input.phones),
    note: input.note && input.note.trim() !== "" ? input.note.trim() : undefined,
    fav: false,
    ts: Date.now(),
  };
  return [c, ...list];
}

/** Upsert by id (replace when it exists, else prepend). */
export function upsertContact(
  list: Contact[],
  input: { id: string } & ContactInput & { fav?: boolean },
): Contact[] {
  const name = cleanName(input.name);
  const phones = cleanPhones(input.phones);
  if (name === "" || phones.length === 0) return list; // refuse invalid
  const clean: Contact = {
    id: input.id,
    name,
    phones,
    note: input.note && input.note.trim() !== "" ? input.note.trim() : undefined,
    fav: input.fav === true,
    ts: Date.now(),
  };
  if (list.some((c) => c.id === input.id)) {
    return list.map((c) => (c.id === input.id ? clean : c));
  }
  return [clean, ...list];
}

/** Remove one contact by id. */
export function removeContact(list: Contact[], id: string): Contact[] {
  return list.filter((c) => c.id !== id);
}

/** Set (or clear) the favorite flag on one contact. */
export function setContactFav(list: Contact[], id: string, fav: boolean): Contact[] {
  return list.map((c) => (c.id === id ? { ...c, fav, ts: Date.now() } : c));
}

/** Patch name/phones/note of one contact (validates; ignores empty name). */
export function editContact(
  list: Contact[],
  id: string,
  patch: Partial<ContactInput>,
): Contact[] {
  const target = list.find((c) => c.id === id);
  if (!target) return list;
  const name = patch.name !== undefined ? cleanName(patch.name) : target.name;
  const phones = patch.phones !== undefined ? cleanPhones(patch.phones) : target.phones;
  if (name === "" || phones.length === 0) return list; // refuse invalid edit
  const note =
    patch.note !== undefined
      ? patch.note.trim() !== ""
        ? patch.note.trim()
        : undefined
      : target.note;
  return list.map((c) =>
    c.id === id ? { ...c, name, phones, note, ts: Date.now() } : c,
  );
}

/* ---- queries --------------------------------------------------------------- */

/** The "digits" view of a phone string (keeps leading `+` then digits), for search. */
export function phoneDigits(raw: string): string {
  const t = raw.trim();
  return (t.startsWith("+") ? "+" : "") + t.replace(/\D/g, "");
}

/** Contacts that already hold the *same* number, digit-normalized.
 * A bare local number (e.g. `13800000001`) is treated as a duplicate of its
 * country-code form (`+86 138 0000 0001`) via a suffix match of ≥7 digits. */
export function contactsWithPhone(list: Contact[], raw: string): Contact[] {
  const digits = phoneDigits(raw).replace(/^\+/, "");
  if (digits === "") return [];
  return list.filter((c) =>
    c.phones.some((p) => {
      const pd = phoneDigits(p).replace(/^\+/, "");
      if (pd === digits) return true;
      if (digits.length >= 7 && pd.endsWith(digits)) return true;
      if (pd.length >= 7 && digits.endsWith(pd)) return true;
      return false;
    }),
  );
}

/** Reverse lookup: the display name for a number, or `null` when unknown. */
export function contactNameFor(list: Contact[], raw: string): string | null {
  const hit = contactsWithPhone(list, raw)[0];
  return hit ? hit.name : null;
}

/** Same-number matches excluding `exceptId` (for edit-time duplicate checks). */
export function contactsWithPhoneExcept(
  list: Contact[],
  raw: string,
  exceptId: string,
): Contact[] {
  return contactsWithPhone(list, raw).filter((c) => c.id !== exceptId);
}

/** Case-insensitive match on name, or digits-match on any phone number. */
export function searchContacts(list: Contact[], query: string): Contact[] {
  const q = query.trim().toLowerCase();
  if (q === "") return list;
  const qd = phoneDigits(q);
  const qHasDigits = /\d/.test(qd);
  return list.filter((c) => {
    if (c.name.toLowerCase().includes(q)) return true;
    if (qHasDigits) return c.phones.some((p) => phoneDigits(p).includes(qd));
    return false;
  });
}

/** Favorites first, then case-insensitive by name (stable). */
export function sortContacts(list: Contact[]): Contact[] {
  return [...list].sort((a, b) => {
    if (a.fav !== b.fav) return a.fav ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Look up a single contact by id. */
export function contactById(list: Contact[], id: string): Contact | undefined {
  return list.find((c) => c.id === id);
}

/* ---- grouping / avatars (presentation helpers, still pure) ----------------- */

/** Index letter for a name: uppercase A–Z or 0-9, else `#`. */
export function contactLetter(name: string): string {
  const ch = cleanName(name).charAt(0);
  if (!ch) return "#";
  const up = ch.toUpperCase();
  return /[A-Z0-9]/.test(up) ? up : "#";
}

/** A stable 0–359 hue for a name (used for the avatar circle color). */
export function avatarHue(name: string): number {
  let sum = 0;
  for (const ch of cleanName(name)) sum = (sum + ch.codePointAt(0)!) % 360;
  return sum;
}

/** Split an already-sorted contact list into letter sections (pure). */
export function groupContacts(sorted: Contact[]): { letter: string; items: Contact[] }[] {
  const out: { letter: string; items: Contact[] }[] = [];
  for (const c of sorted) {
    const letter = contactLetter(c.name);
    const last = out[out.length - 1];
    if (last && last.letter === letter) last.items.push(c);
    else out.push({ letter, items: [c] });
  }
  return out;
}

