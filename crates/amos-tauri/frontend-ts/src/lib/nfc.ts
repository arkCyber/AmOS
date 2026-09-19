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
  available: boolean;
  /** The platform-reported NFC state ("enabled" | "disabled" | "no_hardware"). */
  state: string;
};

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
 *  `state: "no_hardware"` = no NFC at all; `state: "disabled"` = hardware present
 *  but user turned it off; `state: "enabled"` = ready to use. */
export async function nfcStatus(): Promise<NfcAvailableResult | null> {
  return invoke<NfcAvailableResult>("nfc_status");
}

/** Convenience: is NFC hardware present AND enabled? Call this before any operation. */
export async function isNfcReady(): Promise<boolean> {
  const s = await nfcStatus();
  return s?.state === "enabled";
}

/** Start NFC foreground dispatch (so the System UI receives tag events).
 *  The WebView subscribes to `NFC_TAG_EVENT` to get tag reads.
 *  Call once when the NFC screen mounts; stop when it unmounts via `nfcStopDispatch`. */
export async function nfcStartDispatch(): Promise<boolean> {
  return (await invoke<boolean>("nfc_start_dispatch")) ?? false;
}

/** Stop NFC foreground dispatch (releases the NFC adapter). */
export async function nfcStopDispatch(): Promise<boolean> {
  return (await invoke<boolean>("nfc_stop_dispatch")) ?? false;
}

/** Format a raw NFC tag into an NDEF-formatted tag.
 *  Returns `true` on success. After formatting, use `nfcWriteMessage` to write content. */
export async function nfcFormatTag(): Promise<boolean> {
  return (await invoke<boolean>("nfc_format_tag")) ?? false;
}

/** Write an NDEF message to the currently held tag.
 *  `records` are serialised as hex strings by the bridge.
 *  Returns the number of bytes written, or an error. */
export async function nfcWriteMessage(
  records: NdefRecord[],
): Promise<NfcWriteResult> {
  const r = await invoke<NfcWriteResult>("nfc_write_message", {
    records,
  });
  return r ?? { ok: false, error: "not bridged" };
}

/** Read the raw bytes from a specific NFC tag id.
 *  Returns the tag content as hex string pairs, or null when unreadable. */
export async function nfcReadBytes(tagId: string): Promise<string | null> {
  return invoke<string | null>("nfc_read_bytes", { tagId });
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
 *  Each event payload is `NfcTag`. Returns an unsubscribe function. */
export async function subscribeNfcTag(
  onTag: (tag: NfcTag) => void,
): Promise<() => void> {
  // `bridged()` is a boolean, so the old `b.listen(...)` threw and the `try/catch` swallowed
  // it: tag events were never delivered at all (REQ-A412). `subscribe()` is the bridge helper
  // that performs the event-plugin handshake (and is a no-op outside Tauri).
  return subscribe(NFC_TAG_EVENT, (payload) => {
    const tag = payload as NfcTag;
    if (tag && typeof tag.id === "string") onTag(tag);
  });
}
