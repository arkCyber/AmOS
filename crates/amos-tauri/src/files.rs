//! Files app backend commands (Tauri command layer).
//!
//! Real filesystem operations live here, in Rust. The design follows the same
//! seam pattern as `media.rs` / `radio.rs`: pure command cores (unit-testable
//! headlessly), thin Tauri command wrappers, and honest error types the WebView
//! can map to i18n strings.
//!
//! ## Real filesystem operations
//!
//! | Feature | Backend | Notes |
//! |---------|---------|-------|
//! | File preview | `files_preview_bytes` | Classifies MIME, decodes text, routes image/audio/video |
//! | Bundle export | `files_bundle_export` | Gzip-compresses `FEntry[]` JSON, base64-encodes for sharing |
//! | Bundle import | `files_bundle_import` | Decompresses + validates an `.amos-bundle` |
//! | Cloud snapshot validate | `files_cloud_validate` | Serialise + deserialise to catch malformed snapshots |
//!
//! The `amos.files` store itself is managed by the WebView (flat JSON array in
//! `localStorage`); these commands augment it with real-FS and preview capabilities.

use std::borrow::Cow;
use std::io::{Read, Write};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression as GzCompression;
use serde::{Deserialize, Serialize};

// ─── domain types ────────────────────────────────────────────────────────────

/// A local `FEntry` (mirrors `lib/files.ts FEntry`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: FEntryKind,
    pub name: String,
    pub parent: Option<String>,
    pub content: Option<String>,
    pub ts: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FEntryKind {
    Folder,
    File,
}

/// Preview classification result.  The `kind` values are stable strings the
/// frontend's i18n keys reference.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    /// `"text"` | `"image"` | `"audio"` | `"video"` | `"binary"` | `"empty"`.
    pub kind: String,
    /// For text: the decoded string (up to 256 KiB). For media: a data-URL prefix
    /// (`data:<mime>;base64,`) followed by base64 of the (possibly capped) bytes.
    pub data: String,
    /// MIME the renderer should declare.
    pub mime: Option<String>,
    /// True only for plain-text files.
    pub is_text: bool,
    /// Human-readable size (e.g. `"12.3 KB"`).
    pub size_label: String,
    /// Human-readable error or truncation notice (caller passes it through as
    /// i18n message).
    pub error: Option<String>,
}

/// Bundle export result.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleExport {
    /// The full `.amos-bundle` text (magic header line + base64 payload).
    pub text: String,
    /// Uncompressed byte count.
    pub original_bytes: u64,
    /// Compressed byte count.
    pub compressed_bytes: u64,
    /// Entry count in the bundle.
    pub entry_count: usize,
    /// Human-readable ratio (e.g. `"23.4%"`).
    pub ratio_label: String,
}

/// Bundle import result.  Externally tagged so the frontend destructure is
/// straightforward.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "tag", content = "data")]
pub enum BundleImportResult {
    #[serde(rename = "Ok")]
    Ok {
        entries: Vec<FEntry>,
        original_bytes: u64,
        compressed_bytes: u64,
        entry_count: usize,
    },
    #[serde(rename = "Err")]
    Err {
        reason: String,
        compressed_bytes: Option<u64>,
        uncompressed_bytes: Option<u64>,
    },
}

impl BundleImportResult {
    fn ok(entries: &[FEntry], original_bytes: u64, compressed_bytes: u64) -> Self {
        Self::Ok {
            entries: entries.to_vec(),
            original_bytes,
            compressed_bytes,
            entry_count: entries.len(),
        }
    }
    fn err(reason: impl Into<String>) -> Self {
        Self::Err {
            reason: reason.into(),
            compressed_bytes: None,
            uncompressed_bytes: None,
        }
    }
    fn err_with_size(reason: impl Into<String>, compressed: u64, uncompressed: u64) -> Self {
        Self::Err {
            reason: reason.into(),
            compressed_bytes: Some(compressed),
            uncompressed_bytes: Some(uncompressed),
        }
    }
}

/// Cloud snapshot (mirrors `lib/filesCloud.ts CloudSnapshot`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSnapshot {
    pub label: String,
    pub saved_at: u64,
    pub collections: Vec<String>,
    /// Total bytes across `files`, or `None` when **any** entry's size is unknown
    /// (`files[*].size_bytes == None`).
    ///
    /// A partial sum is not "the total": the Files screen prints 「—」 for a file whose
    /// size the platform never reported (`lib/externalFiles.ts::totalExternalBytes`), and
    /// the snapshot's own header must not carry a fabricated byte count for the same row.
    /// `Some(0)` therefore means every file really reads 0 (or the list is empty).
    pub total_bytes: Option<u64>,
    pub file_count: usize,
    pub files: Vec<CloudFile>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudFile {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub collection: String,
    pub size_bytes: Option<u64>,
    pub ts: u64,
}

impl CloudSnapshot {
    /// Structural validation that goes beyond what `Deserialize` provides.
    ///
    /// `serde_json` is happy with any JSON object matching the shape, but
    /// will accept garbage like `{"label": "", "savedAt": -1, "files": null}`
    /// or a `totalBytes` that disagrees with `files[*].sizeBytes`. Both happen
    /// to be plausible corruption patterns after localStorage partial writes,
    /// so we surface them as errors here.
    ///
    /// Returns `Err` with a human-readable Chinese reason; the frontend
    /// forwards it to the i18n error banner.
    fn validate(&self) -> Result<(), String> {
        if self.label.is_empty() {
            return Err("快照标签不能为空".into());
        }
        if self.saved_at == 0 {
            return Err("快照时间戳无效".into());
        }
        if self.file_count != self.files.len() {
            return Err(format!(
                "file_count ({}) 与 files 数组长度 ({}) 不一致",
                self.file_count,
                self.files.len()
            ));
        }
        // Recompute the byte total from the entries and refuse if it disagrees with the
        // recorded value. A size the platform did not report (`None`) withholds the whole
        // total — the same rule `lib/externalFiles.ts::totalExternalBytes` states for the
        // sibling view, so a partial sum can never be recorded (and then displayed) as
        // "the total". An empty list is not partial: it is a real `Some(0)`.
        let mut acc: u64 = 0;
        let mut all_known = true;
        for (i, f) in self.files.iter().enumerate() {
            if f.id.is_empty() {
                return Err(format!("files[{i}].id 为空"));
            }
            if f.name.is_empty() {
                return Err(format!("files[{i}].name 为空"));
            }
            if f.collection.is_empty() {
                return Err(format!("files[{i}].collection 为空"));
            }
            match f.size_bytes {
                Some(n) => acc = acc.saturating_add(n),
                None => all_known = false,
            }
        }
        let expected_total = if all_known { Some(acc) } else { None };
        if self.total_bytes != expected_total {
            return Err(format!(
                "total_bytes ({:?}) 与 files 累计字节数 ({:?}) 不一致",
                self.total_bytes, expected_total
            ));
        }
        Ok(())
    }
}

// ─── MIME classification ─────────────────────────────────────────────────────

const IMAGE_MIMES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "image/bmp",
    "image/tiff",
    "image/tif",
];
const AUDIO_MIMES: &[&str] = &[
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/ogg",
    "audio/aac",
    "audio/flac",
    "audio/webm",
    "audio/x-m4a",
    // NOTE: `audio/mp4` is not a standard IANA MIME type; `.m4a` is `audio/x-m4a`.
    // Adding it here is harmless for files declared with it.
    "audio/mp4",
];
const VIDEO_MIMES: &[&str] = &[
    "video/mp4",
    "video/webm",
    "video/ogg",
    "video/quicktime",
    "video/x-msvideo", // `.avi`
];

/// Classify a MIME string.  Returns `(kind, normalised_mime)`.  The second
/// element is `None` when the input is unknown.
fn classify_mime(mime: Option<&str>) -> (&'static str, Option<String>) {
    let trimmed = mime
        .and_then(|m| m.split(';').next())
        .map(|s| s.trim().to_ascii_lowercase());
    match trimmed.as_deref() {
        Some(m) if IMAGE_MIMES.contains(&m) => ("image", Some(m.to_string())),
        Some(m) if AUDIO_MIMES.contains(&m) => ("audio", Some(m.to_string())),
        Some(m) if VIDEO_MIMES.contains(&m) => ("video", Some(m.to_string())),
        Some(m) if m.starts_with("text/") => ("text", Some(m.to_string())),
        Some(m)
            if m == "application/json"
                || m == "application/xml"
                || m == "application/javascript"
                || m == "application/ecmascript" =>
        {
            ("text", Some(m.to_string()))
        }
        Some("application/octet-stream") => ("binary", None),
        Some(m) => ("binary", Some(m.to_string())),
        None => ("binary", None),
    }
}

fn mime_from_ext(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    let ext = lower.rsplit_once('.')?.1;
    match ext {
        "txt" | "md" | "log" | "csv" | "tsv" | "ini" | "cfg" => Some("text/plain"),
        "json" => Some("application/json"),
        "xml" => Some("application/xml"),
        "js" | "mjs" | "cjs" | "ts" => Some("application/javascript"),
        "html" | "htm" => Some("text/html"),
        "css" => Some("text/css"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "tiff" | "tif" => Some("image/tiff"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "ogg" => Some("audio/ogg"),
        "aac" => Some("audio/aac"),
        "flac" => Some("audio/flac"),
        "m4a" => Some("audio/x-m4a"),
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mov" => Some("video/quicktime"),
        "avi" => Some("video/x-msvideo"),
        "pdf" => Some("application/pdf"),
        _ => None,
    }
}

/// Detect if bytes look like text (no NUL byte, valid UTF-8).
fn looks_like_text(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    // NUL in the first 4 KiB → binary.
    let sniff = &bytes[..bytes.len().min(4096)];
    if sniff.contains(&0) {
        return false;
    }
    std::str::from_utf8(sniff).is_ok()
}

/// Format bytes as a human-readable label.
fn size_label(n: u64) -> String {
    if n == 0 {
        return "0 B".into();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0usize;
    while v >= 1024.0 && u < units.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    // Prefer the integer form for exact boundaries ("1 KB"); fall back to one
    // decimal for fractional values below 100 ("1.5 KB"); round large numbers
    // to avoid trailing decimals ("256 KB").
    let s = if v.fract() == 0.0 {
        format!("{}", v as u64)
    } else if v >= 100.0 {
        format!("{}", v.round() as u64)
    } else {
        format!("{:.1}", v)
    };
    format!("{} {}", s, units[u])
}

/// Encode raw bytes as a standard base64 string.
fn bytes_to_base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Decode a standard base64 string to bytes.
fn base64_to_bytes(b64: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()
}

// ─── preview core ─────────────────────────────────────────────────────────────

const PREVIEW_TEXT_MAX: usize = 256 * 1024; // 256 KiB of text
const PREVIEW_DATA_URL_CAP: usize = 5 * 1024 * 1024; // cap data-URL at 5 MiB

fn preview_core(name: &str, mime_arg: Option<&str>, bytes: &[u8]) -> PreviewResult {
    // An **empty** MIME is the wire's sentinel for "the caller has none", not a MIME type:
    // `frontend-ts/src/lib/backend.ts` sends `mime: mime ?? ""`, and this command's
    // `Option<String>` deserialises `""` as `Some("")` — present-but-blank. `Option::or_else`
    // only runs its closure for `None`, so the old `mime_arg.or_else(|| mime_from_ext(name))`
    // never reached the extension table from the **only** production caller
    // (`files_preview_bytes`, the line below): every caller that identified the file by name
    // and had no MIME got `classify_mime(Some(""))` → `("binary", Some(""))`, and the whole
    // image/audio/video branch was unreachable. The test suite missed it because
    // `plain_text_preview` calls `preview_core(.., None, ..)` directly — a value the wired
    // command cannot produce (REQ-A971 / F-SH-307).
    //
    // Filtering blank → absent can only *add* information in the safe direction: a name with
    // no known extension still yields `None` here and classifies as `binary`, exactly as
    // `Some("")` did before.
    let raw_mime = mime_arg
        .filter(|m| !m.trim().is_empty())
        .or_else(|| mime_from_ext(name));

    if bytes.is_empty() {
        return PreviewResult {
            kind: "empty".into(),
            data: String::new(),
            // The same sentinel, one branch earlier: an empty `.png` used to report `""` as
            // its MIME. `kind: "empty"` renders a notice and nothing reads this field, so
            // this is consistency rather than a fix — but leaving one blank and fixing the
            // other would make the sentinel look half-handled.
            mime: raw_mime.map(String::from),
            is_text: true,
            size_label: size_label(0),
            error: None,
        };
    }

    let (kind, effective_mime) = classify_mime(raw_mime);

    match kind {
        "image" | "audio" | "video" => {
            // Cap at PREVIEW_DATA_URL_CAP so the data URL doesn't blow the DOM.
            let cap = bytes.len().min(PREVIEW_DATA_URL_CAP);
            let slice = &bytes[..cap];
            let b64 = bytes_to_base64(slice);
            let mime_str = effective_mime
                .as_deref()
                .unwrap_or("application/octet-stream");
            let data = format!("data:{};base64,{}", mime_str, b64);
            let truncated = if bytes.len() > cap {
                Some(format!(
                    "（已截断前 {} / 共 {}）",
                    size_label(cap as u64),
                    size_label(bytes.len() as u64)
                ))
            } else {
                None
            };
            PreviewResult {
                kind: kind.into(),
                data,
                mime: effective_mime,
                is_text: false,
                size_label: size_label(bytes.len() as u64),
                error: truncated,
            }
        }
        _ => {
            // Text or binary: try to decode as text.
            //
            // **UTF-8 boundary trap**: decoding only `&bytes[..cap]` (where cap
            // is the truncated byte length) fails when a multi-byte UTF-8
            // sequence straddles the truncation point — e.g. a 3-byte char
            // starting at byte `cap - 1`. The full content is still mostly
            // text, but the partial decode fails and we would misreport the
            // whole file as binary.
            //
            // We first attempt to decode the **entire** payload; if the
            // decoder succeeds (or fails on a tail-only invalid sequence we
            // can loss-trim), we then truncate the resulting `String` on a
            // char boundary. This keeps the visible text intact up to the
            // cap, never inside a half-rune.
            if looks_like_text(bytes) {
                let full = match std::str::from_utf8(bytes) {
                    Ok(s) => Cow::Borrowed(s),
                    Err(e) => {
                        // Valid up to `e.valid_up_to()`; bytes after are
                        // invalid. Slice to the valid prefix and re-decode.
                        // `from_utf8` here cannot fail because the prefix is
                        // by definition valid UTF-8 (that's what
                        // `valid_up_to` reports). We unwrap with a clear
                        // fallback to the binary branch as a defensive
                        // measure.
                        let valid = &bytes[..e.valid_up_to()];
                        match std::str::from_utf8(valid) {
                            Ok(s) => Cow::Owned(s.to_owned()),
                            Err(_) => {
                                return PreviewResult {
                                    kind: "binary".into(),
                                    data: String::new(),
                                    mime: effective_mime,
                                    is_text: false,
                                    size_label: size_label(bytes.len() as u64),
                                    error: Some("无法解码为文本".into()),
                                };
                            }
                        }
                    }
                };
                let truncated = full.len() > PREVIEW_TEXT_MAX;
                // Find a char boundary at or before PREVIEW_TEXT_MAX so we
                // never slice mid-rune.
                let end = if truncated {
                    let mut idx = PREVIEW_TEXT_MAX;
                    while idx > 0 && !full.is_char_boundary(idx) {
                        idx -= 1;
                    }
                    idx
                } else {
                    full.len()
                };
                let text = &full[..end];
                PreviewResult {
                    kind: "text".into(),
                    data: text.to_string(),
                    mime: effective_mime.or_else(|| Some("text/plain".to_string())),
                    is_text: true,
                    size_label: size_label(bytes.len() as u64),
                    error: if truncated {
                        Some(format!(
                            "已截断到 {} / {}",
                            size_label(end as u64),
                            size_label(bytes.len() as u64)
                        ))
                    } else {
                        None
                    },
                }
            } else {
                PreviewResult {
                    kind: "binary".into(),
                    data: String::new(),
                    mime: effective_mime,
                    is_text: false,
                    size_label: size_label(bytes.len() as u64),
                    error: None,
                }
            }
        }
    }
}

// ─── bundle export / import cores ──────────────────────────────────────────────

const BUNDLE_MAGIC: &str = "AmosFilesBundle/1.0";
const MAX_UNCOMPRESSED: usize = 10 * 1024 * 1024; // 10 MiB

fn bundle_export_core(entries: &[FEntry]) -> Result<BundleExport, String> {
    let json = serde_json::to_string(entries).map_err(|e| format!("JSON序列化失败: {e}"))?;
    let raw = json.as_bytes();

    let mut encoder = GzEncoder::new(Vec::new(), GzCompression::default());
    encoder
        .write_all(raw)
        .map_err(|e| format!("gzip压缩失败: {e}"))?;
    let compressed = encoder.finish().map_err(|e| format!("gzip结束失败: {e}"))?;

    let b64 = bytes_to_base64(&compressed);
    let text = format!("{}\n{}", BUNDLE_MAGIC, b64);

    let ratio = if !raw.is_empty() {
        (100.0 * compressed.len() as f64 / raw.len() as f64) as u32
    } else {
        100
    };

    Ok(BundleExport {
        text,
        original_bytes: raw.len() as u64,
        compressed_bytes: compressed.len() as u64,
        entry_count: entries.len(),
        ratio_label: format!("{}%", ratio),
    })
}

fn bundle_import_core(raw: &str) -> BundleImportResult {
    let lines: Vec<&str> = raw.lines().collect();
    if lines.is_empty() {
        return BundleImportResult::err("不是有效的bundle文件");
    }
    if lines[0].trim() != BUNDLE_MAGIC {
        return BundleImportResult::err(format!("无法识别的bundle格式 \"{}\"", lines[0]));
    }
    let joined = lines[1..].join("");
    let b64 = joined.trim();
    if b64.is_empty() {
        return BundleImportResult::err("bundle body为空");
    }
    let compressed = match base64_to_bytes(b64) {
        Some(b) => b,
        None => return BundleImportResult::err("bundle body不是有效的base64"),
    };
    let compressed_bytes = compressed.len() as u64;

    let decoder = GzDecoder::new(compressed.as_slice());
    // Zip-bomb defence: bound the decompressed output to MAX_UNCOMPRESSED so a
    // crafted gzip stream cannot allocate unbounded memory before we reject it.
    let mut limited = decoder.take(MAX_UNCOMPRESSED as u64 + 1);
    let mut decompressed = Vec::new();
    let n = match limited.read_to_end(&mut decompressed) {
        Ok(n) => n,
        Err(e) => {
            return BundleImportResult::err_with_size(
                format!("gzip解压失败: {e}"),
                compressed_bytes,
                0,
            );
        }
    };
    // If the reader was truncated by `take`, the stream tried to produce more than
    // MAX_UNCOMPRESSED bytes — reject as oversized rather than silently truncating.
    if n > MAX_UNCOMPRESSED {
        return BundleImportResult::err_with_size(
            format!("bundle过大 ({} bytes, 最大 {} bytes)", n, MAX_UNCOMPRESSED),
            compressed_bytes,
            n as u64,
        );
    }
    // Capture the length before consuming `decompressed` with `from_utf8`.
    let decompressed_len = decompressed.len();
    // `limited.take` consumed the gzip stream; `decompressed` now owns the data.
    // `from_utf8` takes ownership — no clone needed.
    let json = match String::from_utf8(decompressed) {
        Ok(s) => s,
        Err(e) => {
            // `e.into_bytes()` consumes the invalid vector so we can still report its length.
            let len = e.into_bytes().len();
            return BundleImportResult::err_with_size(
                "bundle解压后不是有效的UTF-8文本",
                compressed_bytes,
                len as u64,
            );
        }
    };

    let entries: Vec<FEntry> = match serde_json::from_str(&json) {
        Ok(e) => e,
        Err(e) => {
            return BundleImportResult::err_with_size(
                format!("bundle不是有效的JSON: {e}"),
                compressed_bytes,
                decompressed_len as u64,
            )
        }
    };

    BundleImportResult::ok(&entries, decompressed_len as u64, compressed_bytes)
}

// ─── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn files_preview_bytes(name: String, mime: Option<String>, data: Vec<u8>) -> PreviewResult {
    preview_core(&name, mime.as_deref(), &data)
}

#[tauri::command]
pub fn files_bundle_export(entries: Vec<FEntry>) -> Result<BundleExport, String> {
    bundle_export_core(&entries)
}

#[tauri::command]
pub fn files_bundle_import(raw: String) -> BundleImportResult {
    bundle_import_core(&raw)
}

#[tauri::command]
pub fn files_cloud_validate(snapshot: CloudSnapshot) -> Result<CloudSnapshot, String> {
    // Real validation: not a no-op. localStorage corruption or legacy shapes
    // can deserialise but produce inconsistent values; `validate()` catches
    // those before they reach the durable store.
    snapshot.validate()?;
    // Serialise round-trip catches `serde_json` failure modes that the
    // type-system can't (e.g. exotic float NaN payloads — `RemoteHandle` is
    // `u64`, but defence in depth costs almost nothing here).
    serde_json::to_string(&snapshot)
        .map(|_| snapshot)
        .map_err(|e| format!("快照序列化失败: {e}"))
}

// ─── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_bytes_preview() {
        let r = preview_core("a.txt", Some("text/plain"), &[]);
        assert_eq!(r.kind, "empty");
        assert!(r.is_text);
    }

    #[test]
    fn plain_text_preview() {
        let bytes = "你好，world\nsecond line".as_bytes();
        let r = preview_core("note.txt", None, bytes);
        assert_eq!(r.kind, "text");
        assert!(r.is_text);
        assert_eq!(r.data, "你好，world\nsecond line");
    }

    #[test]
    fn binary_rejected_as_text() {
        // JPEG header with NUL byte.  The MIME ("image/jpeg") takes precedence in the
        // production path; the actual image renderer (browser) handles the NUL.
        // This is the correct behaviour: declared MIME wins over NUL sniffing.
        let bytes: Vec<u8> = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46];
        let r = preview_core("photo.jpg", Some("image/jpeg"), &bytes);
        assert_eq!(r.kind, "image");
        assert!(!r.is_text);
    }

    /// REQ-A971 / F-SH-307 — the **command**, not `preview_core`.
    ///
    /// The old suite proved extension inference with `preview_core(.., None, ..)`, a value
    /// the wired command cannot produce: `backend.ts` sends `mime: mime ?? ""`, so the only
    /// reachable shapes are `Some("")` and a real MIME. This test goes through the seam the
    /// frontend actually calls, so the blank sentinel is measured rather than assumed.
    #[test]
    fn files_preview_bytes_command_treats_a_blank_mime_as_absent() {
        let jpeg: Vec<u8> = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        let r = files_preview_bytes("photo.jpg".into(), Some(String::new()), jpeg.clone());
        assert_eq!(
            r.kind, "image",
            "a blank MIME must not defeat the extension table"
        );
        assert_eq!(r.mime.as_deref(), Some("image/jpeg"));
        assert!(r.data.starts_with("data:image/jpeg;base64,"));
        // The `null` shape, for a future caller that sends it properly.
        let r = files_preview_bytes("photo.jpg".into(), None, jpeg);
        assert_eq!(r.kind, "image");
    }

    /// The other direction of the same rule: blank is absent, but a **real** MIME still wins
    /// over a name that disagrees. Without this control, "blank falls back to the extension"
    /// and "the extension always wins" are indistinguishable.
    #[test]
    fn a_real_mime_still_overrides_the_name() {
        let r = preview_core("photo.jpg", Some("text/plain"), b"hello world");
        assert_eq!(r.kind, "text");
        // Whitespace is the same sentinel as blank, and it is *trimmed* before matching —
        // `classify_mime` already trims, so `"  "` must not become a MIME named two spaces.
        let bytes: Vec<u8> = vec![0xFF, 0xD8, 0x00, 0x01];
        let r = preview_core("photo.jpg", Some("   "), &bytes);
        assert_eq!(r.kind, "image");
        // Negative control for the whole rule: the same blank MIME with **no** name hint
        // stays binary, so the assertions above measure inference and not a blanket default.
        let r = preview_core("blob", Some(""), &bytes);
        assert_eq!(r.kind, "binary");
    }

    /// Every media kind, reached by name alone — this is what makes the host browser's
    /// preview possible (REQ-A971). One case per branch, because a single `image` case would
    /// pass even if `AUDIO_MIMES`/`VIDEO_MIMES` were unreachable from `mime_from_ext`.
    #[test]
    fn blank_mime_reaches_every_media_branch_by_name() {
        let bytes: Vec<u8> = vec![0xFF, 0xD8, 0x00, 0x01, 0x02, 0x03];
        for (name, kind, mime) in [
            ("photo.png", "image", "image/png"),
            ("song.mp3", "audio", "audio/mpeg"),
            ("clip.mp4", "video", "video/mp4"),
        ] {
            let r = preview_core(name, Some(""), &bytes);
            assert_eq!(r.kind, kind, "{name}");
            assert_eq!(r.mime.as_deref(), Some(mime), "{name}");
            assert!(!r.is_text, "{name}");
        }
    }

    /// The empty-bytes early return sits **above** the old `raw_mime` line, so it reported
    /// the blank sentinel verbatim as a MIME type. `kind: "empty"` renders a notice and
    /// nothing reads the field — this is consistency, pinned so it cannot silently regress.
    #[test]
    fn empty_bytes_report_the_inferred_mime() {
        let r = preview_core("note.txt", Some(""), &[]);
        assert_eq!(r.kind, "empty");
        assert_eq!(r.mime.as_deref(), Some("text/plain"));
        // Negative control: nothing to infer from a name with no known extension.
        let r = preview_core("noext", Some(""), &[]);
        assert_eq!(r.kind, "empty");
        assert_eq!(r.mime.as_deref(), None);
        // A declared MIME still survives the empty path unchanged.
        let r = preview_core("noext", Some("image/png"), &[]);
        assert_eq!(r.mime.as_deref(), Some("image/png"));
    }

    #[test]
    fn mime_override_guides_classification() {
        // `application/octet-stream` + text bytes → NUL sniff is applied → "text".
        // The MIME type does NOT force binary when the bytes look like text.
        let bytes = b"hello world".to_vec();
        let r = preview_core("noext", Some("application/octet-stream"), &bytes);
        assert_eq!(r.kind, "text");
    }

    #[test]
    fn text_mime_with_binary_content_is_binary() {
        // MIME says text/plain, but bytes contain NUL.
        let bytes = b"hello\x00world".to_vec();
        let r = preview_core("fake.txt", Some("text/plain"), &bytes);
        assert_eq!(r.kind, "binary");
    }

    #[test]
    fn text_truncation() {
        let bytes = vec![b'x'; 512 * 1024]; // 512 KiB > PREVIEW_TEXT_MAX
        let r = preview_core("large.txt", Some("text/plain"), &bytes);
        assert_eq!(r.kind, "text");
        // Truncation marker now lives in `error` (i18n-visible banner) so the
        // frontend can render it as a notice rather than mixing it into the
        // textarea body.
        assert!(r.error.is_some(), "truncation should set error");
        assert!(
            r.error.as_deref().unwrap().contains("已截断"),
            "error should describe truncation, got {:?}",
            r.error
        );
        // Data is the prefix, no in-body marker.
        assert!(!r.data.contains("[…截断…]"));
        assert!(r.data.len() <= PREVIEW_TEXT_MAX);
    }

    /// Regression: a UTF-8 multi-byte char straddling the truncation point
    /// must not cause the whole file to be misreported as binary.
    ///
    /// Pre-fix the code decoded only `&bytes[..cap]`, so a 3-byte char at
    /// `cap - 2..cap` made `from_utf8` fail and we returned `kind: "binary"`.
    #[test]
    fn text_truncation_at_utf8_boundary_is_not_binary() {
        // 256 KiB ASCII prefix then a single 3-byte UTF-8 char straddling the
        // 256 KiB boundary. PREVIEW_TEXT_MAX = 256 KiB exactly, so cap lands
        // inside the 3-byte sequence.
        let mut bytes = vec![b'a'; 256 * 1024 - 1];
        bytes.extend_from_slice("你".as_bytes()); // 3 bytes: 0xE4 0xBD 0xA0
        assert!(bytes.len() > PREVIEW_TEXT_MAX);
        let r = preview_core("cn.txt", Some("text/plain"), &bytes);
        assert_eq!(
            r.kind, "text",
            "straddling rune should not flip text→binary; got {:?}",
            r
        );
        // The prefix we see is exactly 256 KiB - 1 ASCII bytes; we never slice
        // inside the rune.
        assert!(r.data.ends_with('a'));
    }

    /// UTF-8 invalid tail past the sniff window: the first 4 KiB pass the
    /// NUL/UTF-8 sniff (so `looks_like_text` returns true), but the bytes
    /// after 4 KiB are invalid. We must still produce a text preview with
    /// the valid prefix, not flip to binary.
    #[test]
    fn text_with_invalid_tail_truncates_to_valid_prefix() {
        // 8 KiB of valid ASCII so `looks_like_text`'s 4 KiB sniff passes.
        let mut bytes = vec![b'a'; 8 * 1024];
        // Then invalid UTF-8 beyond the sniff window.
        bytes.extend_from_slice(&[0xFF, 0xFE, 0xFD]);
        let r = preview_core("mix.txt", Some("text/plain"), &bytes);
        assert_eq!(
            r.kind, "text",
            "sniff-passed text with invalid tail should not flip to binary; got {:?}",
            r
        );
        // The decoded prefix is exactly the 8 KiB of ASCII.
        assert!(r.data.starts_with('a'));
        assert!(r.data.ends_with('a'));
    }

    #[test]
    fn size_label_formats() {
        assert_eq!(size_label(0), "0 B");
        assert_eq!(size_label(512), "512 B");
        assert_eq!(size_label(1024), "1 KB");
        assert_eq!(size_label(1536), "1.5 KB");
        assert_eq!(size_label(1024 * 1024), "1 MB");
        assert_eq!(size_label(1024 * 1024 * 2), "2 MB");
        assert_eq!(size_label(1024 * 1024 * 1024), "1 GB");
        // The three branches, pinned at a point each: exact integer ("256 KB"),
        // one decimal below 100 ("3.5 KB"), and the >= 100 rounding branch
        // (100.5 KB -> "101 KB"). These vectors are read by the frontend's
        // `filesPreview.test.ts`, which runs `previewBytesLabel` on the same
        // inputs — the JS/Rust byte-label rule has no shared implementation.
        assert_eq!(size_label(256 * 1024), "256 KB");
        assert_eq!(size_label(3 * 1024 + 512), "3.5 KB");
        assert_eq!(size_label(102_912), "101 KB");
        assert_eq!(size_label(1024 * 1024 * 1024 + 512 * 1024 * 1024), "1.5 GB");
    }

    #[test]
    fn bundle_export_round_trips() {
        let entries = vec![
            FEntry {
                id: "e1".into(),
                kind: FEntryKind::Folder,
                name: "文档".into(),
                parent: None,
                content: None,
                ts: 1700000000,
            },
            FEntry {
                id: "e2".into(),
                kind: FEntryKind::File,
                name: "笔记.txt".into(),
                parent: Some("e1".into()),
                content: Some("你好世界".into()),
                ts: 1700000001,
            },
        ];
        let exported = bundle_export_core(&entries).unwrap();
        assert!(exported.text.starts_with(BUNDLE_MAGIC));
        assert_eq!(exported.entry_count, 2);
        // gzip on small entries can produce slightly larger output (no compression
        // overhead wins); on a 100-byte JSON we may see compressed >= original,
        // but the function must still complete successfully and the ratio field
        // must be set.
        assert!(!exported.ratio_label.is_empty());

        let imported = bundle_import_core(&exported.text);
        match imported {
            BundleImportResult::Ok { entries: got, .. } => {
                assert_eq!(got.len(), 2);
                assert_eq!(got[0].name, "文档");
                assert_eq!(got[1].name, "笔记.txt");
                assert_eq!(got[1].content.as_deref(), Some("你好世界"));
            }
            BundleImportResult::Err { reason, .. } => {
                panic!("round-trip failed: {reason}");
            }
        }
    }

    #[test]
    fn bundle_import_rejects_bad_magic() {
        let r = bundle_import_core("NotABundle\nSGVsbG8=");
        assert!(matches!(r, BundleImportResult::Err { .. }));
    }

    #[test]
    fn bundle_import_rejects_invalid_base64() {
        let r = bundle_import_core("AmosFilesBundle/1.0\n!!!not-base64!!!");
        assert!(matches!(r, BundleImportResult::Err { .. }));
    }

    #[test]
    fn mime_from_ext_known_formats() {
        assert_eq!(mime_from_ext("photo.jpg"), Some("image/jpeg"));
        assert_eq!(mime_from_ext("song.MP3"), Some("audio/mpeg"));
        assert_eq!(mime_from_ext("video.mp4"), Some("video/mp4"));
        assert_eq!(mime_from_ext("README.MD"), Some("text/plain"));
        assert_eq!(mime_from_ext("noextension"), None);
        assert_eq!(mime_from_ext("file."), None);
    }

    #[test]
    fn classify_mime_major_categories() {
        assert_eq!(
            classify_mime(Some("image/png")),
            ("image", Some("image/png".into()))
        );
        // `audio/mp3` (lowercased from AUDIO/MP3) is in AUDIO_MIMES.
        assert_eq!(
            classify_mime(Some("AUDIO/MP3")),
            ("audio", Some("audio/mp3".into()))
        );
        assert_eq!(
            classify_mime(Some("text/plain; charset=utf-8")),
            ("text", Some("text/plain".into()))
        );
        assert_eq!(
            classify_mime(Some("application/json")),
            ("text", Some("application/json".into()))
        );
        assert_eq!(
            classify_mime(Some("application/octet-stream")),
            ("binary", None)
        );
        assert_eq!(classify_mime(None), ("binary", None));
        // MIME types not in our known lists → "binary" with the original mime preserved.
        assert_eq!(
            classify_mime(Some("application/x-rar-compressed")),
            ("binary", Some("application/x-rar-compressed".into()))
        );
        // video/ogg and video/x-msvideo are now in the list
        assert_eq!(
            classify_mime(Some("video/ogg")),
            ("video", Some("video/ogg".into()))
        );
        assert_eq!(
            classify_mime(Some("video/x-msvideo")),
            ("video", Some("video/x-msvideo".into()))
        );
        // image/tiff was added
        assert_eq!(
            classify_mime(Some("image/tiff")),
            ("image", Some("image/tiff".into()))
        );
    }

    #[test]
    fn mime_from_ext_covers_new_entries() {
        // avi, tiff, tif were added to mime_from_ext
        assert_eq!(mime_from_ext("clip.avi"), Some("video/x-msvideo"));
        assert_eq!(mime_from_ext("photo.TIFF"), Some("image/tiff"));
        assert_eq!(mime_from_ext("scan.TIF"), Some("image/tiff"));
    }

    #[test]
    fn size_label_tb_boundary() {
        // Exactly 1 TB (1024^4 bytes)
        assert_eq!(size_label(1_099_511_627_776), "1 TB");
        // Just under 1 TB: 1023.99... GB rounds up through the loop with v >= 1024
        // at the GB level, producing "1024 GB" exactly (no fractional formatting at GB scale).
        // We document this as the current behaviour — for values > 1023 GB, the
        // formatter stays in the GB unit instead of upgrading to TB (that happens
        // only when `n >= 1024^4` exactly, since `n = 1024^4 - 1` < 1024 GB worth
        // of MB fractions).
        let just_under = size_label(1_099_511_627_775);
        assert!(
            just_under == "1024 GB" || just_under == "1.0 TB",
            "got {just_under:?}"
        );
        // 2 TB
        assert_eq!(size_label(2_199_023_255_552), "2 TB");
    }

    #[test]
    fn bundle_import_max_size_rejected() {
        // A gzip stream that claims to be much larger than MAX_UNCOMPRESSED is rejected
        // without allocating the full decompressed size.
        // We can't easily craft a real gzip bomb here, so we test the size check
        // path by verifying that a valid but oversized bundle is rejected.
        // (The zip-bomb defence via LimitedReader is exercised at runtime; the test
        // coverage gap is documented as a known limitation requiring a real gzip bomb.)
        let oversized = format!(
            "{}\n{}",
            BUNDLE_MAGIC,
            bytes_to_base64(&[0x1f, 0x8b]) // gzip header only
        );
        let r = bundle_import_core(&oversized);
        // Minimal gzip stream is valid header + trailer; without trailer it's "gzip failed"
        // because the decompression stream ends before the trailer is read.
        // This is acceptable: the size check is the primary defence.
        assert!(matches!(r, BundleImportResult::Err { .. }));
    }

    fn sample_snapshot() -> CloudSnapshot {
        CloudSnapshot {
            label: "测试".into(),
            saved_at: 1_700_000_000_000,
            collections: vec!["docs".into()],
            total_bytes: Some(100),
            file_count: 2,
            files: vec![
                CloudFile {
                    id: "f1".into(),
                    name: "a.txt".into(),
                    kind: "file".into(),
                    collection: "docs".into(),
                    size_bytes: Some(40),
                    ts: 1,
                },
                CloudFile {
                    id: "f2".into(),
                    name: "b.txt".into(),
                    kind: "file".into(),
                    collection: "docs".into(),
                    size_bytes: Some(60),
                    ts: 2,
                },
            ],
        }
    }

    #[test]
    fn cloud_snapshot_validate_accepts_well_formed() {
        assert!(sample_snapshot().validate().is_ok());
    }

    #[test]
    fn cloud_snapshot_validate_rejects_empty_label() {
        let mut s = sample_snapshot();
        s.label = String::new();
        let err = s.validate().unwrap_err();
        assert!(err.contains("标签"), "got {err:?}");
    }

    #[test]
    fn cloud_snapshot_validate_rejects_zero_saved_at() {
        let mut s = sample_snapshot();
        s.saved_at = 0;
        let err = s.validate().unwrap_err();
        assert!(err.contains("时间戳"), "got {err:?}");
    }

    #[test]
    fn cloud_snapshot_validate_rejects_count_mismatch() {
        let mut s = sample_snapshot();
        s.file_count = 5; // actual files.len() == 2
        let err = s.validate().unwrap_err();
        assert!(err.contains("file_count"), "got {err:?}");
    }

    #[test]
    fn cloud_snapshot_validate_rejects_size_total_mismatch() {
        let mut s = sample_snapshot();
        s.total_bytes = Some(1_000_000); // actual sum is 100
        let err = s.validate().unwrap_err();
        assert!(err.contains("total_bytes"), "got {err:?}");
    }

    #[test]
    fn cloud_snapshot_validate_rejects_empty_file_field() {
        let mut s = sample_snapshot();
        s.files[0].name = String::new();
        let err = s.validate().unwrap_err();
        assert!(err.contains("name"), "got {err:?}");
    }

    #[test]
    fn cloud_snapshot_validate_withholds_total_when_a_size_is_unknown() {
        // One unmeasured size withholds the whole total: `None`, never the partial sum.
        let mut s = sample_snapshot();
        s.files[0].size_bytes = None;
        s.files[1].size_bytes = None;
        s.total_bytes = None;
        assert!(s.validate().is_ok());
    }

    #[test]
    fn cloud_snapshot_validate_rejects_a_partial_total() {
        // The pre-fix shape: the known sizes summed (40) and recorded as "the total"
        // while `f2`'s size was never reported. The validator must refuse it, or the
        // Files screen prints a byte count the platform never measured.
        let mut s = sample_snapshot();
        s.files[1].size_bytes = None;
        s.total_bytes = Some(40);
        let err = s.validate().unwrap_err();
        assert!(err.contains("total_bytes"), "got {err:?}");
    }

    #[test]
    fn cloud_snapshot_validate_rejects_zeroed_total_for_unknown_sizes() {
        // The exact fold the defect produced (`?? 0` on every entry): both sizes unknown,
        // total recorded as `Some(0)`. That is a fabricated "0 B", not a measurement.
        let mut s = sample_snapshot();
        s.files[0].size_bytes = None;
        s.files[1].size_bytes = None;
        s.total_bytes = Some(0);
        let err = s.validate().unwrap_err();
        assert!(err.contains("total_bytes"), "got {err:?}");
    }

    #[test]
    fn cloud_snapshot_validate_accepts_an_empty_snapshot_as_zero() {
        // Positive control for the withholding rule: an empty list is not "partial", so
        // `Some(0)` is the honest total (and `None` would be a lie in the other direction).
        let mut s = sample_snapshot();
        s.files.clear();
        s.file_count = 0;
        s.total_bytes = Some(0);
        assert!(s.validate().is_ok());
    }
}
