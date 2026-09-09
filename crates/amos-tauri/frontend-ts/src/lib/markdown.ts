/**
 * lib/markdown.ts — pure Markdown helpers for notes (the "Obsidian-ish / .md"
 * thread). No Markdown engine dependency: we only need the small, deterministic
 * bits Notes actually consumes. Everything here is pure + headless-tested, so a
 * future "import .md / paste Markdown" action can reuse it without touching the
 * DOM.
 *
 * * strip YAML front-matter (a leading `---` block) from an imported `.md` body;
 * * pick a friendly display title from the first heading / non-empty line;
 * * fold CRLF to LF and trim (so imported text is stable to store/compare).
 */

/** Is `line` exactly a YAML front-matter delimiter (`---` or `...`)? */
const isFrontDelim = (line: string) =>
  line.trim() === "---" || line.trim() === "...";

/** Drop a leading YAML front-matter block (`--- … ---`), tolerating leading blank
 *  lines and CRLF. No closing delimiter → the whole text is treated as front
 *  matter (empty body); no opening delimiter → body returned unchanged. */
export function stripYamlFrontMatter(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Skip leading blank lines when looking for the opening delimiter.
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim()) continue;
    if (isFrontDelim(lines[i]!)) {
      open = i;
    }
    break;
  }
  if (open === -1) return lines.join("\n");
  for (let i = open + 1; i < lines.length; i++) {
    if (isFrontDelim(lines[i]!)) {
      return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
    }
  }
  // Opened but never closed → treat everything as front matter (empty body).
  return "";
}

/** First line that looks like a Markdown heading or non-empty content. Returns ""
 *  for blank input. */
function firstMeaningful(lines: string[]): string | null {
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    const h1 = /^#\s+(.*)$/.exec(t);
    if (h1) return h1[1]!.trim();
    return t; // first non-empty line that isn't a heading
  }
  return null;
}

/** Input for [`toMarkdownFile`]. `text` is the normalized note body (no front
 *  matter). */
export interface MarkdownNoteMeta {
  title: string;
  text: string;
  /** Epoch ms → emitted as an ISO-8601 `created:` in front matter (optional). */
  created?: number;
  /** Epoch ms → emitted as an ISO-8601 `modified:` in front matter (optional). */
  modified?: number;
}

/** YAML single-line scalar: quoted + escaped only when it contains characters
 *  that would otherwise break the front-matter (colon, #, quotes, newline). */
function yamlScalar(s: string): string {
  if (!/[:#"'\n]/.test(s)) return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

/** Serialise a note as a Markdown file with YAML front-matter (the Obsidian-side
 *  mirror of [`stripYamlFrontMatter`]/[`normalizeMarkdownBody`]). Round-trips:
 *  `normalizeMarkdownBody(toMarkdownFile(m)).text`-safe — body is preserved and
 *  front matter can be stripped again on import. */
export function toMarkdownFile(m: MarkdownNoteMeta): string {
  const fm = [
    "---",
    `title: ${yamlScalar(m.title || "未命名")}`,
    ...(typeof m.created === "number" && Number.isFinite(m.created)
      ? [`created: ${new Date(m.created).toISOString()}`]
      : []),
    ...(typeof m.modified === "number" && Number.isFinite(m.modified)
      ? [`modified: ${new Date(m.modified).toISOString()}`]
      : []),
    "---",
  ].join("\n");
  const body = m.text.replace(/\r\n/g, "\n").trim();
  return body ? `${fm}\n\n${body}\n` : `${fm}\n`;
}

/** A clean Markdown import result: front matter stripped, normalized body, plus a
 *  friendly display title. `null` when nothing meaningful remains. */
export interface MarkdownImport {
  body: string;
  title: string;
}

/** Parse a pasted/imported Markdown document into a note body + title. */
export function parseMarkdownImport(raw: string): MarkdownImport | null {
  const body = normalizeMarkdownBody(raw);
  if (!body) return null;
  return { body, title: markdownTitleOf(body) };
}

/** A friendly note title: the first `# heading` if any, else the first non-empty
 *  line (heading markers stripped, leading `-`/`*` list markers removed). */
export function markdownTitleOf(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Prefer the first heading of any level.
  for (const raw of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(raw.trim());
    if (m) return (m[2] ?? "").trim();
  }
  const first = firstMeaningful(lines);
  if (first == null) return "";
  return first.replace(/^[-*]\s+/, "").replace(/^#+\s*/, "").trim();
}



/** Normalize an imported Markdown body for storage: LF line endings, no leading
 *  blank lines, trimmed at both ends. Returns "" when nothing remains after
 *  front-matter stripping. */
export function normalizeMarkdownBody(text: string): string {
  const withoutFm = stripYamlFrontMatter(text);
  return withoutFm.replace(/\r\n/g, "\n").replace(/^\n+/, "").trim();
}
