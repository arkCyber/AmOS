/**
 * Contacts import/export ("通讯录导入/导出") — vCard 3.0 (RFC 2426) interchange.
 *
 * Pure + deterministic: no DOM, no bridge, no clock (callers pass `now`). Writing
 * is strict and spec-shaped (CRLF line endings, 75-octet folding, escaped text
 * values); reading is tolerant (LF or CRLF, folded lines, a UTF-8 BOM, lowercase
 * property names, Apple-style `itemN.` group prefixes, unknown properties and
 * parameters ignored) and **never throws** — garbage text simply yields zero
 * blocks so the caller can say "unrecognized format" honestly.
 *
 * Honesty rules (same discipline as the rest of lib/):
 * - Imported contacts ALWAYS get fresh local ids (`makeContactId`) — imported
 *   UIDs are never trusted for the local store.
 * - An entry whose **any** phone already exists (digit-normalized, incl. the
 *   `+CC`/bare-suffix rule of `contactsWithPhone`) is skipped and **counted**,
 *   mirroring the manual add dup-guard; nothing is merged silently.
 * - Entries without a name or without a phone are skipped and **counted** as
 *   invalid (a name + at least one number is the domain's validity rule).
 */

import { cleanName, cleanPhones, contactsWithPhone, makeContactId } from "./contacts";
import type { Contact } from "./contacts";

/** One contact as it arrived from a vCard, already validated (name + ≥1 phone). */
export interface ImportedContact {
  name: string;
  phones: string[];
  note?: string;
  fav: boolean;
  /** REV in epoch ms; 0 when absent or unparseable (merge falls back to `now`). */
  ts: number;
}

/** What `parseVcf` found — the accounting a screen needs to report honestly. */
export interface ParseVcfResult {
  entries: ImportedContact[];
  /** vCard blocks seen (valid + invalid). 0 ⇒ the text held no vCard at all. */
  blocks: number;
  /** Blocks present but unusable (no name / no phone). */
  invalid: number;
}

/** The outcome of folding parsed entries into an existing book. */
export interface ImportMergeResult {
  list: Contact[];
  added: number;
  dupSkipped: number;
  /** Defensive re-validation failures (the parser should have caught these). */
  invalidSkipped: number;
}

/* ---- text escaping (RFC 2426 §2.4.2 / RFC 6350 §3.4) ----------------------- */

/** Escape one structured/text value: `\` `;` `,` and newlines. */
export function escapeVCardText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Inverse of {@link escapeVCardText}; unknown escapes keep the literal char. */
export function unescapeVCardText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\" && i + 1 < value.length) {
      const next = value[++i]!;
      out += next === "n" || next === "N" ? "\n" : next;
    } else if (ch !== "\\") {
      out += ch;
    } // a lone trailing backslash is malformed — dropped
  }
  return out;
}



/* ---- line folding (RFC 2426 §2.1: ≤75 octets per physical line) ------------ */

/** UTF-8 octet length of a string (fold limits are octets, not characters). */
function utf8Octets(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * Fold one logical line to ≤75-octet physical lines joined by CRLF + SP.
 * The first line gets the full 75; continuations get 74 (the space is extra).
 * Long multi-octet characters are never split (fold at code-point boundaries).
 */
export function foldVCardLine(line: string): string {
  const FIRST = 75;
  const CONT = 74; // one octet goes to the leading space of a continuation
  if (utf8Octets(line) <= FIRST) return line;
  const chunks: string[] = [];
  let cur = "";
  let budget = FIRST;
  let curOctets = 0;
  for (const ch of line) {
    const octets = utf8Octets(ch);
    if (curOctets + octets > budget) {
      chunks.push(cur);
      cur = "";
      curOctets = 0;
      budget = CONT;
    }
    cur += ch;
    curOctets += octets;
  }
  if (cur !== "") chunks.push(cur);
  return chunks.join("\r\n ");
}

/* ---- timestamps (REV) ------------------------------------------------------- */

/** `ts` (epoch ms) as a vCard REV ISO-8601 string; `null` when unknown (≤0). */
export function revFor(ts: number): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  const d = new Date(ts);
  // Past Date's representable range `toISOString` THROWS (RangeError: Invalid
  // Date) — export must stay total, so an unrepresentable ts means "unknown".
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parse a REV value to epoch ms; 0 when absent/unparseable. Accepts the ISO
 * extended form (`Date.parse`) and the vCard basic form (`20260912T080000Z`).
 */
export function parseRev(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const v = raw.trim();
  if (v === "") return 0;
  const basic = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.\d+)?(Z|[+-]\d{4})?$/i.exec(v);
  if (basic) {
    const [, y, mo, d, h, mi, se, tz] = basic;
    // A missing time designator defaults to UTC in vCard. Numeric offsets are
    // normalized to `±HH:MM` — engines disagree on the bare `+HHMM` form, and
    // parsing must not depend on that leniency.
    const off =
      tz === undefined || tz === "" || tz.toUpperCase() === "Z" ? "Z" : `${tz.slice(0, 3)}:${tz.slice(3)}`;
    const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${se}${off}`);
    return Number.isFinite(t) ? t : 0;
  }
  // The ISO-extended fallthrough gets the same ±HHMM → ±HH:MM normalization;
  // engines disagree on the bare form, and parsing must not depend on leniency.
  const m = /([+-])(\d{2})(\d{2})$/.exec(v);
  const t = Date.parse(m ? `${v.slice(0, -2)}:${v.slice(-2)}` : v);
  return Number.isFinite(t) ? t : 0;
}

/* ---- export: Contact[] → vCard 3.0 ----------------------------------------- */

/** Serialize ONE contact; `""` when the contact is unusable (never throws). */
export function toVCard(c: Contact): string {
  const name = cleanName(c?.name);
  const phones = cleanPhones(c?.phones);
  if (name === "" || phones.length === 0) return "";
  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0"];
  // We only hold a flat display name: keep it whole in both N (single component)
  // and FN, escaped — never invent family/given splits the data does not have.
  lines.push(`N:${escapeVCardText(name)};;;;`);
  lines.push(`FN:${escapeVCardText(name)}`);
  for (const p of phones) lines.push(`TEL:${escapeVCardText(p)}`);
  const note = typeof c?.note === "string" ? c.note.trim() : "";
  if (note !== "") lines.push(`NOTE:${escapeVCardText(note)}`);
  if (c.fav === true) lines.push("CATEGORIES:Favorites");
  if (typeof c.id === "string" && c.id !== "") lines.push(`UID:${escapeVCardText(c.id)}`);
  const rev = revFor(c.ts);
  if (rev !== null) lines.push(`REV:${rev}`);
  lines.push("END:VCARD");
  return lines.map(foldVCardLine).join("\r\n");
}

/** Serialize the whole book (CRLF separators + trailing CRLF); `""` when empty. */
export function buildVcf(list: unknown): string {
  if (!Array.isArray(list)) return "";
  const parts: string[] = [];
  for (const c of list as Contact[]) {
    const v = toVCard(c);
    if (v !== "") parts.push(v);
  }
  return parts.length === 0 ? "" : parts.join("\r\n") + "\r\n";
}

/**
 * How many entries of `list` would actually serialize. Status bars must count
 * with this, never by substring-searching the output: a note that happens to
 * contain the literal text `BEGIN:VCARD` would inflate a substring count while
 * the file still holds one card per contact. Total: non-array / garbage → 0.
 */
export function countVCards(list: unknown): number {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const c of list as Contact[]) if (toVCard(c) !== "") n++;
  return n;
}


/* ---- import: vCard text → entries ------------------------------------------ */

/** Split on `sep` while honoring `\`-escapes (used for the structured N value). */
function splitUnescaped(value: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\" && i + 1 < value.length) {
      cur += ch + value[i + 1]!;
      i++;
    } else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Split `PROP;PARAM=..:value` on the first `:` outside double quotes. */
function splitNameValue(line: string): { head: string; value: string } | null {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) return { head: line.slice(0, i), value: line.slice(i + 1) };
  }
  return null;
}

/** The bare property name: group prefix (`item1.`) + parameters stripped. */
function propName(head: string): string {
  let rest = head;
  const dot = rest.indexOf(".");
  if (dot > -1 && /^[A-Za-z0-9-]+$/.test(rest.slice(0, dot))) rest = rest.slice(dot + 1);
  const semi = rest.indexOf(";");
  return (semi === -1 ? rest : rest.slice(0, semi)).trim().toUpperCase();
}

/** Display name from a vCard property set: FN preferred, else N components. */
function nameFrom(props: Map<string, string[]>): string {
  for (const raw of props.get("FN") ?? []) {
    const name = cleanName(unescapeVCardText(raw));
    if (name !== "") return name;
  }
  for (const raw of props.get("N") ?? []) {
    // N is Family;Given;Middle;Prefix;Suffix — display in that conventional order.
    const comp = splitUnescaped(raw, ";").map(unescapeVCardText);
    const order = [comp[3], comp[1], comp[2], comp[0], comp[4]];
    const name = cleanName(order.filter((x) => x !== undefined && x.trim() !== "").join(" "));
    if (name !== "") return name;
  }
  return "";
}

/** Build one validated entry from one card's properties; `null` when unusable. */
function entryFromProps(props: Map<string, string[]>): ImportedContact | null {
  const name = nameFrom(props);
  const phones = cleanPhones((props.get("TEL") ?? []).map(unescapeVCardText));
  if (name === "" || phones.length === 0) return null;
  // Real-world producers emit several NOTE lines — join the usable ones (blank
  // entries drop) instead of silently keeping only the first.
  const note = (props.get("NOTE") ?? [])
    .map((raw) => unescapeVCardText(raw).trim())
    .filter((s) => s !== "")
    .join("\n");
  const fav = (props.get("CATEGORIES") ?? []).some((v) =>
    unescapeVCardText(v).toLowerCase().includes("favorite"),
  );
  return {
    name,
    phones,
    note: note !== "" ? note : undefined,
    fav,
    ts: parseRev(props.get("REV")?.[0]),
  };
}

/** Normalize line breaks, unfold continuations (`\n` + SP/TAB), strip a BOM. */
function prepareLines(text: string): string[] {
  const noBom = text.replace(/^\uFEFF/, "");
  const lf = noBom.replace(/\r\n?/g, "\n");
  const unfolded = lf.replace(/\n[ \t]/g, "");
  return unfolded.split("\n");
}

/**
 * Parse vCard text into validated entries — tolerant, total (never throws).
 * `blocks` counts every BEGIN:VCARD seen, so a screen can distinguish
 * "no vCard at all" (`blocks === 0`) from "vCards but none usable".
 */
export function parseVcf(text: unknown): ParseVcfResult {
  const res: ParseVcfResult = { entries: [], blocks: 0, invalid: 0 };
  if (typeof text !== "string") return res;
  let cur: Map<string, string[]> | null = null;
  const finish = (): void => {
    if (!cur) return;
    res.blocks++;
    const entry = entryFromProps(cur);
    if (entry) res.entries.push(entry);
    else res.invalid++;
    cur = null;
  };
  for (const rawLine of prepareLines(text)) {
    const line = rawLine.trimEnd();
    if (line === "") continue;
    if (line.toUpperCase() === "BEGIN:VCARD") {
      finish(); // a new BEGIN without END: close the (incomplete) previous card
      cur = new Map();
      continue;
    }
    if (!cur) continue; // content outside any card is ignored
    if (line.toUpperCase() === "END:VCARD") {
      finish();
      continue;
    }
    const nv = splitNameValue(line);
    if (!nv) continue; // a line without a value colon cannot be a property
    const key = propName(nv.head);
    if (key === "") continue;
    const values = cur.get(key) ?? [];
    values.push(nv.value);
    cur.set(key, values);
  }
  finish(); // tolerate a missing final END:VCARD
  return res;
}


/* ---- merge: parsed entries → the existing book ------------------------------ */

/**
 * Fold validated {@link ImportedContact} entries into `existing` (pure).
 *
 * - Re-validates every entry (defense in depth): unusable → `invalidSkipped`.
 * - If **any** phone of an entry already exists in the accumulating book
 *   (digit-normalized suffix rule) the whole entry is skipped → `dupSkipped`
 *   (a bulk import must never create a same-number duplicate).
 * - New entries are prepended (as `addContact` does) with fresh ids; `ts`
 *   keeps the source REV when known, else the caller's `now`.
 */
export function mergeImported(
  existing: Contact[],
  incoming: ImportedContact[],
  now: number,
): ImportMergeResult {
  const base: Contact[] = Array.isArray(existing) ? existing : [];
  let list = base;
  let added = 0;
  let dupSkipped = 0;
  let invalidSkipped = 0;
  if (!Array.isArray(incoming)) return { list: base, added, dupSkipped, invalidSkipped };
  for (const item of incoming) {
    const name = cleanName(item?.name);
    const phones = cleanPhones(item?.phones);
    if (name === "" || phones.length === 0) {
      invalidSkipped++;
      continue;
    }
    const dup = phones.some((p) => contactsWithPhone(list, p).length > 0);
    if (dup) {
      dupSkipped++;
      continue;
    }
    const c: Contact = {
      id: makeContactId(),
      name,
      phones,
      note:
        typeof item?.note === "string" && item.note.trim() !== "" ? item.note.trim() : undefined,
      fav: item?.fav === true,
      // Past Date's representable range (8.64e15 ms) a ts is garbage — fall
      // back to `now` rather than store a value that degrades/throws downstream.
      ts:
        typeof item?.ts === "number" &&
        Number.isFinite(item.ts) &&
        item.ts > 0 &&
        item.ts <= 8.64e15
          ? item.ts
          : now,
    };
    list = [c, ...list];
    added++;
  }
  return { list, added, dupSkipped, invalidSkipped };
}

