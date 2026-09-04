/**
 * Pure helpers for the *web-bundle runtime host*: turning an installed
 * third-party web-bundle (fetched file-by-file as base64 via the appstore
 * bridge) into a single self-contained HTML document that can render in a
 * sandboxed `srcdoc` iframe — without a custom protocol or origin.
 *
 * Honest scope: this is the "render a local web-bundle without a custom
 * protocol" path the store docs anticipate (`docs/appstore.md`). Relative
 * `<script src>` / `<link href>` / `<img src>` references are inlined as
 * `data:` URLs. Because it is a single srcdoc page, classic (non-ESM) demo
 * bundles run; heavier multi-page/ESM bundles are future work for a real
 * `amos-app://` custom-protocol host (the `amos_appstore::serve` seam).
 *
 * All functions here are pure so the URL/path + inlining logic is unit-testable
 * with no DOM / no bridge.
 */

/** `data:` URL for a base64 resource with a MIME type. */
export function toDataUrl(mime: string, base64: string): string {
  return `${mime};base64,${base64}`;
}

/** Decode a base64 string (utf-8) — used for html/css/js that must be text. */
export function decodeBase64Text(base64: string): string {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

/** A reference that must NOT be touched (absolute/other-scheme/anchor/data). */
export function isExternalRef(value: string): boolean {
  const v = value.trim();
  if (v === "" || v === "#" || v.startsWith("#")) return true;
  // protocol-relative or any explicit scheme (http:, https:, data:, blob:,
  // javascript:, mailto:, tel:, ws:…) are not local bundle assets.
  if (v.startsWith("//")) return true;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return true;
  return false;
}

/**
 * Resolve a possibly-relative `href`/`src` against a bundle root into a
 * canonical, `/`-separated *relative* path (no leading `/`, no `.`/`..`).
 * Returns `null` for external refs or anything that escapes the bundle root.
 */
export function resolveBundlePath(baseDir: string, href: string): string | null {
  const [beforeHash = ""] = href.split("#");
  const raw = (beforeHash.split("?")[0] ?? "").trim();
  if (isExternalRef(raw)) return null;

  const base = (baseDir || "").replace(/^\/+|\/+$/g, "");
  const joined = base ? `${base}/${raw}` : raw;
  const segments: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // `..` above the bundle root (with no base to climb into) escapes it.
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  if (segments.length === 0) return null;
  return segments.join("/");
}

const ATTR_RE = /((?:src|href)\s*=\s*["'])(.*?)(["'])/gi;

/**
 * Half-open [start, end) spans of `html` whose text must NOT be treated as
 * attribute references: the body of `<script>`/`<style>` and HTML comments.
 * (Their raw text can contain `src="…"`-looking strings that are code/CSS, not
 * real tags — rewriting them would corrupt a bundle.) Opening-tag attributes
 * such as `<script src="x.js">` are *outside* these spans and still rewritten.
 */
function maskedSpans(html: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const comment = /<!--[\s\S]*?-->/g;
  let m: RegExpExecArray | null;
  while ((m = comment.exec(html)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
  }
  const open = /<(script|style)\b[^>]*>/gi;
  while ((m = open.exec(html)) !== null) {
    const g = m[1];
    if (g === undefined) continue;
    const tag = g.toLowerCase();
    const bodyStart = m.index + m[0].length;
    const closer = html.toLowerCase().indexOf(`</${tag}`, bodyStart);
    if (closer === -1) continue;
    const gt = html.indexOf(">", closer);
    if (gt === -1) continue;
    spans.push([bodyStart, gt + 1]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  return spans;
}

function isMasked(pos: number, spans: Array<[number, number]>): boolean {
  for (const [s, e] of spans) {
    if (pos < s) return false; // spans are sorted ascending
    if (pos >= s && pos < e) return true;
  }
  return false;
}

/** Unique local asset paths referenced by *real* `src`/`href` tags in `html`. */
export function listLocalRefs(html: string, baseDir = ""): string[] {
  const spans = maskedSpans(html);
  const seen = new Set<string>();
  const out: string[] = [];
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(html)) !== null) {
    if (isMasked(m.index, spans)) continue; // script/style body or comment
    const v = m[2];
    if (v === undefined) continue;
    const p = resolveBundlePath(baseDir, v);
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * Rewrite every *real* local `src`/`href` in `html` whose resolved path is a key
 * of `assets` (path → `data:` URL) to that URL. References inside
 * `<script>`/`<style>` text or HTML comments are never touched. External /
 * non-listed refs are left as-is. Deterministic + order-independent.
 */
export function inlineBundle(
  html: string,
  assets: ReadonlyMap<string, string>,
  baseDir = "",
): string {
  const spans = maskedSpans(html);
  return html.replace(
    ATTR_RE,
    (whole, open, value, close, _offset: number) => {
      if (open === undefined || close === undefined) return whole;
      const offset = typeof _offset === "number" ? _offset : -1;
      if (offset >= 0 && isMasked(offset, spans)) return whole;
      const v = value;
      if (v === undefined) return whole;
      const p = resolveBundlePath(baseDir, v);
      if (p === null) return whole;
      const data = assets.get(p);
      return data === undefined ? whole : `${open}${data}${close}`;
    },
  );
}

/** Build the data-URL asset map the host feeds `inlineBundle` (pure wrapper). */
export function assetDataUrlMap(
  paths: string[],
  fetchOne: (path: string) => { mime: string; base64: string } | null,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of paths) {
    const res = fetchOne(p);
    if (res) map.set(p, toDataUrl(res.mime, res.base64));
  }
  return map;
}
