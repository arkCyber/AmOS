/**
 * pwaIndex.ts — client for the **system PWA index** (`amos-app://index/apps.json`).
 *
 * The Rust gateway (`crates/amos-appstore::pwa`, `docs/pwa-index.md`) compiles the
 * installed `amos-app.toml` declarations into one JSON document and serves it over
 * the `amos-app://` custom protocol. This module is the consumer: it asks Rust for
 * the **platform-correct base URL**, fetches the document, and normalises it.
 *
 * Three things here are deliberate:
 *
 *  1. **The base URL comes from Rust, never from a literal here.** On Windows and
 *     Android a custom scheme has no native support, so wry maps
 *     `{scheme}://{host}` to `http://{scheme}.{host}`; on macOS/iOS/Linux it does
 *     not. A hard-coded `amos-app://index` would therefore be **dead on Android**
 *     and would present as "the index is empty" — a wrong answer that looks like a
 *     right one. So the *engine* fact lives in Rust (`pwa_index_url`).
 *  2. **An unknown `schema` is refused, not guessed.** The document carries a
 *     version precisely so a consumer can decline to interpret a shape it does not
 *     know; a half-understood index would render a plausible lie.
 *  3. **Nothing throws and nothing is fabricated.** Callers get a discriminated
 *     result distinguishing "the bridge is absent" from "the gateway refused" from
 *     "there genuinely are no declared apps" — the UI must be able to say which.
 */
import { invoke } from "./backend";
import { amosWarn } from "./debugLog";

/** The index document version this client understands (`amos-appstore::pwa::INDEX_SCHEMA`). */
export const PWA_INDEX_SCHEMA = 1;

/** One property of a tool's `inputSchema` (the JSON-Schema subset the gateway emits). */
export interface PwaToolProperty {
  type: string;
  description: string;
}

/** A tool's `inputSchema` — flattened, so the UI never walks an `unknown` tree. */
export interface PwaToolSchema {
  type: string;
  required: string[];
  properties: Record<string, PwaToolProperty>;
}

/** One `[[mcp_tools]]` declaration: a function the AI daemon may call. */
export interface PwaTool {
  name: string;
  description: string;
  inputSchema: PwaToolSchema;
  /** `"url_redirect"` is the only action v0.1 implements (see `docs/pwa-index.md`). */
  action: string;
  /** The URL template with `{property}` placeholders, or `null` when not applicable. */
  urlTemplate: string | null;
}

/** `[display]` — how the shell is asked to render the app. */
export interface PwaDisplay {
  /** The app's online entry (http/https only — the gateway refuses anything else). */
  url: string;
  /** Icon path relative to the index root, or `null` (the UI falls back to a glyph). */
  icon: string | null;
  mode: string;
  orientation: string;
  themeColor: string | null;
}

/** One declared app. */
export interface PwaEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  display: PwaDisplay;
  mcpTools: PwaTool[];
  /** `[permissions.network].allowed_domains` — bare hosts (never wildcards). */
  allowedDomains: string[];
}

/** The compiled index. */
export interface PwaIndexDoc {
  schema: number;
  apps: PwaEntry[];
}

/** Why a load did not produce an index. Each is a *different* thing to say to a user. */
export type PwaIndexFailure =
  /** Not running inside AmOS (no Tauri bridge) — the protocol cannot be reached at all. */
  | "offline"
  /** The gateway answered, but with something this client cannot honestly read. */
  | "unreadable"
  /** The request itself failed (protocol not registered / refused / no such path). */
  | "unreachable";

/** The outcome of one load. */
export type PwaIndexResult =
  /** `base` is the base URL this load actually used — so the caller renders the
   *  icons and the diagnosed base from the **one** answer it got, instead of
   *  asking the host a second time and holding a second copy of the same fact. */
  | { kind: "ok"; doc: PwaIndexDoc; base: string }
  | { kind: "failed"; reason: PwaIndexFailure; detail: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Normalise one tool; a malformed tool is kept with safe fields, never invented. */
function normalizeTool(raw: unknown): PwaTool | null {
  if (!isObject(raw)) return null;
  const name = str(raw.name);
  if (name === "") return null; // a tool with no name is not addressable at all
  const schema = isObject(raw.inputSchema) ? raw.inputSchema : {};
  const props = isObject(schema.properties) ? schema.properties : {};
  const properties: Record<string, PwaToolProperty> = {};
  for (const [key, value] of Object.entries(props)) {
    const p = isObject(value) ? value : {};
    properties[key] = { type: str(p.type), description: str(p.description) };
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === "string")
    : [];
  const execution = isObject(raw.execution) ? raw.execution : {};
  return {
    name,
    description: str(raw.description),
    inputSchema: { type: str(schema.type, "object"), required, properties },
    action: str(execution.action),
    urlTemplate: strOrNull(execution.url_template),
  };
}

/** Normalise one app; `id` is load-bearing (it is the tile identity), so it is required. */
function normalizeEntry(raw: unknown): PwaEntry | null {
  if (!isObject(raw)) return null;
  const app = isObject(raw.app) ? raw.app : {};
  const id = str(app.id);
  if (id === "") return null;
  const display = isObject(raw.display) ? raw.display : {};
  const permissions = isObject(raw.permissions) ? raw.permissions : {};
  const network = isObject(permissions.network) ? permissions.network : {};
  const domains = Array.isArray(network.allowed_domains)
    ? network.allowed_domains.filter((d): d is string => typeof d === "string")
    : [];
  const tools = Array.isArray(raw.mcp_tools)
    ? raw.mcp_tools.map(normalizeTool).filter((t): t is PwaTool => t !== null)
    : [];
  return {
    id,
    // A declared app with no name is shown by its id rather than as a blank tile.
    name: str(app.name, id),
    version: str(app.version),
    description: str(app.description),
    display: {
      url: str(display.url),
      icon: strOrNull(display.icon),
      mode: str(display.mode, "standalone"),
      orientation: str(display.orientation, "any"),
      themeColor: strOrNull(display.theme_color),
    },
    mcpTools: tools,
    allowedDomains: domains,
  };
}

/**
 * Read an already-parsed document. Returns `null` when the shape cannot be read
 * **honestly** — a non-object, or a `schema` this client does not know (we refuse
 * to interpret a version we were not written against rather than half-read it).
 * Individual malformed *entries* are dropped by identity rules, not invented.
 */
export function normalizePwaIndex(raw: unknown): PwaIndexDoc | null {
  if (!isObject(raw)) return null;
  if (raw.schema !== PWA_INDEX_SCHEMA) return null;
  const apps = Array.isArray(raw.apps)
    ? raw.apps.map(normalizeEntry).filter((a): a is PwaEntry => a !== null)
    : [];
  return { schema: PWA_INDEX_SCHEMA, apps };
}


/**
 * The base URL for the index on this platform, from Rust (`pwa_index_url`).
 * `null` when there is no bridge — i.e. the page is not running inside AmOS.
 */
export async function pwaIndexBaseUrl(): Promise<string | null> {
  const url = await invoke<string>("pwa_index_url");
  if (typeof url !== "string" || url.trim() === "" || /\s/.test(url)) {
    if (url !== null) amosWarn("pwa", "host returned an unusable index base URL", { url });
    return null;
  }
  return url.replace(/\/+$/, "");
}

/** The absolute index-document URL under a known `base`. Pure. */
export function indexDocumentUrlFor(base: string): string {
  return `${base.replace(/\/+$/, "")}/apps.json`;
}

/**
 * Fetch + normalise the index. Never throws.
 *
 * Uses raw `fetch` (not `invoke`) on purpose: the whole point of the gateway is
 * that system assets are reachable over the custom protocol, and this is the one
 * call site that exercises it. The base URL is asked for **once** per load and
 * returned in the `ok` result, so nothing downstream needs a second copy.
 */
export async function fetchPwaIndex(): Promise<PwaIndexResult> {
  const base = await pwaIndexBaseUrl();
  if (base === null) {
    return { kind: "failed", reason: "offline", detail: "no Tauri bridge" };
  }
  const url = indexDocumentUrlFor(base);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (e) {
    // A custom-protocol miss (unregistered scheme, refused path) lands here.
    const detail = e instanceof Error ? e.message : String(e);
    amosWarn("pwa", "index fetch failed", { url, detail });
    return { kind: "failed", reason: "unreachable", detail };
  }
  if (!response.ok) {
    // The gateway answers a refusal with its reason as text — surface it.
    const detail = await response.text().catch(() => "");
    return {
      kind: "failed",
      reason: "unreachable",
      detail: detail.trim() || `HTTP ${response.status}`,
    };
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (e) {
    return { kind: "failed", reason: "unreadable", detail: String(e) };
  }
  const doc = normalizePwaIndex(raw);
  if (doc === null) {
    return { kind: "failed", reason: "unreadable", detail: "unsupported index schema" };
  }
  return { kind: "ok", doc, base };
}

/** Tile glyph for an app with no icon: its first character (the store's rule). */
export function pwaEntryGlyph(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "🌐";
  const first = Array.from(trimmed)[0];
  return first && first.trim() ? first.toUpperCase() : "🌐";
}

/**
 * The absolute icon URL for an entry under `base`, or `null` when it declares no
 * icon (then the UI shows a glyph instead of requesting a picture that is not
 * there).
 */
export function pwaEntryIconUrl(base: string, entry: PwaEntry): string | null {
  if (entry.display.icon === null) return null;
  return `${base.replace(/\/+$/, "")}/${entry.display.icon.replace(/^\/+/, "")}`;
}

/** Every tool the index declares, in app order — the system's advertised capability set. */
export function pwaAllTools(doc: PwaIndexDoc): Array<{ app: string; tool: PwaTool }> {
  const out: Array<{ app: string; tool: PwaTool }> = [];
  for (const entry of doc.apps) {
    for (const tool of entry.mcpTools) out.push({ app: entry.id, tool });
  }
  return out;
}

