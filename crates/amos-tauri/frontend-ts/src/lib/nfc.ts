/**
 * NFC — real device NFC read/write via the System UI APK glue.
 *
 * **Platform**: Android Beam is deprecated (API 29+), so we use
 * `NfcAdapter` / `NfcAdapter#enableForegroundDispatch` for reading tags in the
 * foreground, and `TagTechnology` / `Ndef` for read/write.
 *
 * **Honest semantics**:
 *  * `NfcAvailable` = the platform has NFC hardware.
 *    Always check `isNfcAvailable()` before any operation.
 *  * `isNfcEnabled()` = NFC is turned on in settings.
 *    A disabled NFC silently ignores all reads/writes.
 *  * `TagRead` events arrive as a Tauri event (`NFC_TAG_EVENT`).
 *  * Write requires a formatted NDEF tag; NFC Forum Type 2 / Type 4 are common.
 *  * Not available on iOS (no public NFC API in Safari) / host.
 *
 * **No bridge for NDEF formatting**: formatting a tag requires a raw tag
 * technology session; callers use `nfcFormatTag` for that.
 */
import { invoke, subscribe } from "./backend";

/** Whether NFC hardware is present on this device. */
export type NfcAvailableResult = {
  /** Whether the platform reports an adapter at all. **Derived** from `state` by the
   *  Rust side (`NfcStatusResult::from_state`), never set independently — and `false`
   *  for `unavailable` too, which is why **no caller may read it as "no hardware"**.
   *  That sentence belongs to `state === "no-hardware"` alone. */
  available: boolean;
  /** The adapter state — see `NfcStateWire`. */
  state: NfcStateWire;
  /** Why this side could not read the adapter, when the answer is `unavailable`.
   *  Absent whenever the platform answered for itself. */
  detail?: string;
};

/**
 * The wire spelling of the Rust `NfcState` enum (`#[serde(rename_all = "kebab-case")]`
 * in `amos-tauri/src/ble.rs`). Bound to its Rust source by
 * `__tests__/declaredMirrors.test.ts`, so a renamed variant fails the build rather
 * than silently falling through to the unknown-state wording.
 *
 * `"unavailable"` is **not** a fourth adapter state: the platform knows three
 * (`enabled` / `disabled` / `no-hardware`), and `unavailable` is the host's own
 * "we could not ask" — an undeclared `android.permission.NFC` arrives here as a
 * `SecurityException`, so reading it as `no-hardware` is how the app came to tell
 * users their phone had no NFC radio (REQ-A775 / F-AND-007).
 */
export type NfcStateWire =
  | "enabled"
  | "disabled"
  | "no-hardware"
  | "unavailable";

/** One record inside an NDEF message. */
export interface NdefRecord {
  /** TNF = Type Name Format (0..6, matching android.nfc.NdefRecord). */
  tnf: number;
  /** Raw type byte array as hex string pairs, e.g. "546578744f70657274". */
  type: string;
  /** Raw payload bytes as hex string pairs. */
  payload: string;
  /** Id bytes as hex string pairs (empty string when absent). */
  id: string;
}

/** What a scanned NFC tag contains. */
export interface NfcTag {
  /** Unique tag identifier (bytes as hex string pairs). */
  id: string;
  /** The NFC Forum tag type: "type1" | "type2" | "type3" | "type4" | "iso14443" | "unknown". */
  technology: string;
  /** Whether the tag holds a formatted NDEF message. */
  ndef: boolean;
  /** Parsed NDEF records, null when `ndef = false`. */
  records: NdefRecord[] | null;
}

/** Result of an NFC write operation. */
export type NfcWriteResult =
  | { ok: true; bytesWritten: number; error?: undefined }
  | { ok: false; bytesWritten?: undefined; error: string };

/** Tauri event name for `NFC_TAG_EVENT` (emitted when a tag is discovered). */
export const NFC_TAG_EVENT = "nfc-tag-discovered";

/** Whether the platform has NFC hardware and whether it is currently enabled.
 *  `state: "no-hardware"` = no NFC at all; `state: "disabled"` = hardware present
 *  but user turned it off; `state: "enabled"` = ready to use. */
export async function nfcStatus(): Promise<NfcAvailableResult | null> {
  return invoke<NfcAvailableResult>("nfc_status");
}

/** Convenience: is NFC hardware present AND enabled? Call this before any operation. */
export async function isNfcReady(): Promise<boolean> {
  const s = await nfcStatus();
  return s?.state === "enabled";
}

/**
 * Start NFC foreground dispatch (so the System UI receives tag events).
 *  The WebView subscribes to `NFC_TAG_EVENT` to get tag reads.
 *  Call once when the NFC screen mounts; stop when it unmounts via `nfcStopDispatch`.
 *
 * `null` = the host did not answer (no bridge, or the command was refused). It is its own fact
 * and must not be folded into `false`: `false` is the platform's own refusal — something the
 * device decided — while a command the host never carried out decided nothing (REQ-A1337). */
export async function nfcStartDispatch(): Promise<boolean | null> {
  return await invoke<boolean>("nfc_start_dispatch");
}

/** Stop NFC foreground dispatch (releases the NFC adapter).
 *
 * `null` = the host did not answer (REQ-A1337). A stop that was never carried out leaves the
 * adapter exactly as it was, so the caller must not read `null` as "now stopped". */
export async function nfcStopDispatch(): Promise<boolean | null> {
  return await invoke<boolean>("nfc_stop_dispatch");
}

/** Format a raw NFC tag into an NDEF-formatted tag.
 *  Returns `true` on success. After formatting, use `nfcWriteMessage` to write content.
 *
 * `null` = the host did not answer (REQ-A1337): `false` is the platform reporting that the
 * format was attempted and refused, which is a fact about the tag; a command that never ran
 * establishes nothing about the tag. */
export async function nfcFormatTag(): Promise<boolean | null> {
  return await invoke<boolean>("nfc_format_tag");
}

/** Write an NDEF message to the currently held tag.
 *  `records` are serialised as hex strings by the bridge.
 *  Returns the number of bytes written, or an error.
 *
 * `null` = the host did not answer (REQ-A1337). The old `?? { ok: false, error: "not bridged" }`
 * invented a **cause** — an English string this module made up — and `nfc.writeFailed` renders
 * `error` verbatim, so a Chinese screen answered 「写入失败：not bridged」 about a write nobody
 * ever attempted. */
export async function nfcWriteMessage(
  records: NdefRecord[],
): Promise<NfcWriteResult | null> {
  return await invoke<NfcWriteResult>("nfc_write_message", { records });
}

/**
 * What reading a tag came back as — the wire spelling of the Rust `NfcReadState` enum
 * (`#[serde(rename_all = "kebab-case")]` in `amos-tauri/src/ble.rs`), bound to its Rust and
 * Kotlin sources by `__tests__/declaredMirrors.test.ts` and by
 * `scripts/nfc-read-glue-const-scan.mjs`.
 *
 * This union exists because the reply used to be `string | null`, and that one `null` was the
 * answer to four different questions: no tag was in the field, the tag was read fine and holds
 * no NDEF payload, the read threw, and — the host's own — *we never got to ask*. The screen had
 * a single branch for it, so all four printed **"读取失败：系统没有返回卡片字节"**, a sentence
 * about the tag. The tag that was read perfectly well and simply has nothing on it was reported
 * as a failed read (REQ-A781 / F-AND-009).
 *
 * `unavailable` is the fourth state and it is not a tag fact: it is an answer the **host** gave,
 * in its own words (`detail`), saying the read could not be attempted — no glue bound, a JNI
 * error, or a host build. Never word it as something the tag did.
 *
 * And it is not the same as the wrapper answering `null` (REQ-A1337): `unavailable` is a host
 * that spoke, `null` is a host that said nothing. The old `?? { state: "unavailable", detail:
 * "not bridged" }` merged the two and had to invent the `detail` to fill the slot — an English
 * string, which `nfc.readUnavailable` renders verbatim onto a Chinese screen.
 */
export type NfcReadStateWire =
  | "bytes"
  | "empty"
  | "no-tag"
  | "failed"
  | "unavailable";

/** What `nfc_read_bytes` answers. */
export interface NfcReadOutcome {
  /** What happened. Derive everything else from this. */
  state: NfcReadStateWire;
  /** The hex id of the tag the glue **actually read**. `undefined` when nothing was read.
   *
   *  The glue can only ever act on the last tag it saw, while this screen addresses a tag the
   *  user picked out of a list — so this field is the only thing that can stop one tag's bytes
   *  from being shown under another tag's name. Compare it with {@link nfcReadBelongsTo}. */
  tag_id?: string;
  /** The bytes as lowercase hex. Present exactly for `state === "bytes"`, and `""` is a real
   *  answer (a zero-length payload) — which is what makes `nfc.readEmpty` reachable. */
  hex?: string;
  /** Why, when there is a why: the glue's own words for `failed`, the host's own for
   *  `unavailable`. Absent when the tag answered for itself. */
  detail?: string;
}

/**
 * Read the bytes the glue is holding, for the tag the user selected.
 *
 * `tagId` cannot select *what* is read — the Kotlin glue reads `lastTag` and takes no argument —
 * so the answer carries the id it really read and the caller must compare them.
 */
export async function nfcReadBytes(tagId: string): Promise<NfcReadOutcome | null> {
  return await invoke<NfcReadOutcome>("nfc_read_bytes", { tagId });
}

/**
 * Whether the bytes in `out` are the bytes of the tag the caller asked about.
 *
 * The one place this comparison lives, so a test can pin it and the screen cannot forget it:
 * the glue reads whatever tag it last saw, so a read that reports a *different* id is the hex of
 * another tag, and rendering it inside the selected tag's card would attribute it to the wrong
 * one. `failed`/`no-tag`/`unavailable` are not "for" any tag — nothing was read.
 */
export function nfcReadBelongsTo(out: NfcReadOutcome | null, tagId: string): boolean {
  return (out?.state === "bytes" || out?.state === "empty") && out.tag_id === tagId;
}

/**
 * The sentence the screen shows for a read.
 *
 * Every state gets its own wording, and the wording is about the right subject: `empty` says the
 * tag carries nothing (a *successful* read), `no-tag` says nothing is in the field, `failed`
 * carries the glue's own error, `unavailable` says this app could not ask, and only
 * `unavailable` may be worded as our own limitation rather than the tag's answer.
 *
 * `nfc.readOtherTag` is the fifth outcome and it is not a state: the read succeeded, but on a
 * different tag than the caller asked about — so the bytes are shown, labelled as that tag's.
 */
export function nfcReadNoticeKey(out: NfcReadOutcome, requestedTagId: string): string {
  if (!nfcReadBelongsTo(out, requestedTagId) && (out.state === "bytes" || out.state === "empty")) {
    return "nfc.readOtherTag";
  }
  switch (out.state) {
    case "bytes":
      return "nfc.readOk";
    case "empty":
      return "nfc.readNoPayload";
    case "no-tag":
      return "nfc.readNoTag";
    case "failed":
      return "nfc.readFailed";
    default:
      return "nfc.readUnavailable";
  }
}

/* ---- NDEF helpers (pure, testable) ---- */

/** TNF constants matching android.nfc.NdefRecord. */
export const TNF_EMPTY = 0x00;
export const TNF_WELL_KNOWN = 0x01;
export const TNF_MIME_MEDIA = 0x02;
export const TNF_URI = 0x03;
export const TNF_EXTERNAL = 0x04;
export const TNF_UNKNOWN = 0x05;
export const TNF_UNCHANGED = 0x06;
export const TNF_RESERVED = 0x07;

/** Build a well-known RTD_TEXT record (plain text). */
export function ndefTextRecord(text: string, languageCode = "en"): NdefRecord {
  const langBytes = new TextEncoder().encode(languageCode);
  const textBytes = new TextEncoder().encode(text);
  // RTD_TEXT: status byte (UTF-8 + length of lang code) + language code + text
  // UTF-8 bit (0x80) is unset, lang length is in the low 6 bits.
  const statusByte = langBytes.length & 0x3f;
  const payload = new Uint8Array([statusByte, ...langBytes, ...textBytes]);
  const hex = (b: Uint8Array) =>
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");

  return {
    tnf: TNF_WELL_KNOWN,
    type: hex(new TextEncoder().encode("T")), // RTD Text type
    payload: hex(payload),
    id: "",
  };
}

/** Build a well-known RTD_URI record. */
export function ndefUriRecord(uri: string): NdefRecord {
  const uriBytes = new TextEncoder().encode(uri);
  // RTD_URI: prepend 0x00 (no prefix language)
  const payload = new Uint8Array([0x00, ...Array.from(uriBytes)]);
  const hex = (b: Uint8Array) =>
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");

  return {
    tnf: TNF_WELL_KNOWN,
    type: hex(new TextEncoder().encode("U")), // RTD URI type
    payload: hex(payload),
    id: "",
  };
}

/** Build a MIME media record with a custom type. */
export function ndefMimeRecord(mimeType: string, data: number[]): NdefRecord {
  const hex = (b: Uint8Array) =>
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");

  return {
    tnf: TNF_MIME_MEDIA,
    type: hex(new TextEncoder().encode(mimeType)),
    payload: hex(new Uint8Array(data)),
    id: "",
  };
}

/** Decode a RTD_TEXT payload back to a human-readable string.
 *  Returns null when the record is not a valid RTD_TEXT. */
export function decodeTextRecord(record: NdefRecord): string | null {
  if (record.type.toLowerCase() !== "54") return null; // "T" in hex
  try {
    const payloadHex = record.payload;
    if (payloadHex.length < 2) return null;
    const bytes: number[] = [];
    for (let i = 0; i < payloadHex.length; i += 2) {
      const byte = parseInt(payloadHex.substring(i, i + 2), 16);
      if (isNaN(byte)) return null;
      bytes.push(byte);
    }
    const statusByte = bytes[0] ?? 0;
    const langLength = statusByte & 0x3f;
    const textStart = 1 + langLength;
    const textBytes = bytes.slice(textStart);
    return new TextDecoder().decode(new Uint8Array(textBytes));
  } catch {
    return null;
  }
}

/** Decode a RTD_URI payload back to a string.
 *  Returns null when the record is not a valid RTD_URI. */
export function decodeUriRecord(record: NdefRecord): string | null {
  if (record.type.toLowerCase() !== "55") return null; // "U" in hex
  try {
    const payloadHex = record.payload;
    const bytes: number[] = [];
    for (let i = 0; i < payloadHex.length; i += 2) {
      const byte = parseInt(payloadHex.substring(i, i + 2), 16);
      if (isNaN(byte)) return null;
      bytes.push(byte);
    }
    // URI prefix table (first byte is abbreviated prefix index)
    const PREFIX_TABLE = [
      "", // 0x00 = no abbreviation
      "http://www.",
      "https://www.",
      "http://",
      "https://",
      "tel:",
      "mailto:",
      "ftp://anonymous:anonymous@",
      "ftp://ftp.",
      "mailto:",
      "irc://",
      "urn:",
    ];
    const prefix = PREFIX_TABLE[bytes[0] ?? 0] ?? "";
    const uriBytes = bytes.slice(1);
    return prefix + new TextDecoder().decode(new Uint8Array(uriBytes));
  } catch {
    return null;
  }
}

/** Subscribe to NFC tag discovery events.
 *  Each event payload is `NfcTag`. Returns an unsubscribe, or `null` when the subscription
 *  was not established (REQ-A838): a tag reader that is not listening and one that is
 *  listening in an empty room both produce no tags, and only the `null` tells them apart. */
export async function subscribeNfcTag(
  onTag: (tag: NfcTag) => void,
): Promise<(() => void) | null> {
  // `bridged()` is a boolean, so the old `b.listen(...)` threw and the `try/catch` swallowed
  // it: tag events were never delivered at all (REQ-A412). `subscribe()` is the bridge helper
  // that performs the event-plugin handshake (and is a no-op outside Tauri).
  return subscribe(NFC_TAG_EVENT, (payload) => {
    const tag = payload as NfcTag;
    if (tag && typeof tag.id === "string") onTag(tag);
  });
}
