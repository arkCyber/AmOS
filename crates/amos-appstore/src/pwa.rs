//! `amos-app.toml` — the declarative **AmOS PWA index** (protocol v0.1).
//!
//! A *preinstalled* PWA is not a download: it is a few hundred bytes of
//! declaration that the firmware ships, the System UI renders as a tile, and the
//! protocol host ([`crate::host`]) serves. This module owns that declaration —
//! parsing it, refusing it when it lies, and compiling the whole set into the one
//! JSON document the WebView fetches at **`amos-app://index/apps.json`**.
//!
//! ```text
//!   <index dir>/apps/<id>.toml   ──parse+validate──┐
//!   <index dir>/icons/<file>     ──served as-is────┤
//!                                                  ▼
//!                        amos-app://index/apps.json  (PwaIndex::to_json_pretty)
//!                        amos-app://index/icons/<f>  (the icon files)
//! ```
//!
//! # What v0.1 accepts, and what it refuses
//!
//! The manifest is `serde`-decoded with [`deny_unknown_fields`] at **every**
//! level, so a key AmOS does not implement is a **loud parse error naming the
//! key**, never a silently ignored one. That is the whole point of a capability
//! manifest: an app that declares `biometric = true` and gets `true` back from a
//! system that cannot honour it has been lied to.
//!
//! * **`[app]`** — `id` (the store's slug rule), `name`, `version`
//!   (`major.minor.patch[-pre]`), `description`.
//! * **`[display]`** — `url` (http/https only), optional `icon` (a path
//!   *relative* to the index dir, e.g. `icons/org.x.png` — never an absolute
//!   path, never a `..`), `mode`, `orientation`, optional `theme_color`
//!   (`#rgb`/`#rrggbb`).
//! * **`[[mcp_tools]]`** — `name`, `description`, `inputSchema` (a JSON-Schema
//!   *subset*: `type: "object"`, `required`, `properties`) and `execution`.
//! * **`[permissions.network]`** — `allowed_domains` (bare hosts in the
//!   `amos-network-guard` matcher's grammar: `host.tld` — which already covers every
//!   subdomain of it; there is **no** wildcard form, so `*.host.tld` is refused).
//!
//! **Refused in v0.1, on purpose** — the parser rejects these rather than
//! pretending: `execution.action = "eval_js"` (there is no JS executor and no
//! audit trail for one), and the `wallet_sign` / `biometric` / `p2p_network` /
//! `location_access` permission keys (no enforcement path exists for them yet —
//! see `docs/pwa-index.md` § "Honest boundaries"). Add a key here only *with*
//! the Rust chokepoint that enforces it.
//!
//! # Why the tool schemas are validated this strictly
//!
//! The `[[mcp_tools]]` block is what the local model is handed as its tool
//! dictionary, so a broken schema is not a cosmetic problem — it is a tool the
//! model can never call correctly. Every rule below therefore exists to make a
//! *silently useless* tool impossible:
//!
//! * a `required` entry that is not a property → the model is told to always
//!   send an argument the schema does not describe;
//! * a `{placeholder}` in `url_template` with no matching property → the URL
//!   template can never be filled;
//! * a **required** property missing from `url_template` → the model dutifully
//!   supplies an argument that is silently dropped when the URL is built;
//! * a placeholder **before the authority ends** (`https://ok.example.org{q}`) → a
//!   value there can *rewrite the host* (`@evil.test/x` makes the host `evil.test`),
//!   i.e. the open redirect this validation exists to prevent;
//! * the same tool `name` in two apps → the model's routing key is ambiguous.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Result, StoreError};
use crate::host::{ServedBundle, INDEX_NETLOC, SCHEME};
use crate::model::{valid_id, Version};
use crate::serve::content_type_for;

/// Schema version of the JSON served at `amos-app://index/apps.json`. A consumer
/// that does not know a version must not guess at its shape.
pub const INDEX_SCHEMA: u32 = 1;

/// Where the built-in (factory) index lives inside an index directory.
const APPS_DIR: &str = "apps";
/// Where index icons live inside an index directory.
const ICONS_DIR: &str = "icons";
/// The one path the index JSON is served from.
const INDEX_PATH: &str = "apps.json";

// ---------------------------------------------------------------------------
// Manifest types (the `amos-app.toml` shape)
// ---------------------------------------------------------------------------

/// One preinstalled PWA. File name convention: `<index dir>/apps/<id>.toml`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PwaManifest {
    pub app: AppSection,
    #[serde(default)]
    pub display: DisplaySection,
    /// `[[mcp_tools]]` — the semantic handles this app hands the AI daemon.
    #[serde(default)]
    pub mcp_tools: Vec<McpTool>,
    #[serde(default)]
    pub permissions: PermissionsSection,
}

/// `[app]` — identity. `version` stays a `String` here and is validated into a
/// [`Version`] by [`PwaManifest::validate`], so a bad version is an error naming
/// the manifest rather than a serde type error.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppSection {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
}

/// `[display]` — how the shell renders the app.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisplaySection {
    /// The app's online entry. http/https only (see [`validate_http_url`]).
    pub url: String,
    /// Icon path **relative to the index dir** (`icons/x.png`). `None` → the
    /// shell falls back to its glyph, which is the honest alternative to
    /// inventing a picture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub mode: DisplayMode,
    #[serde(default)]
    pub orientation: Orientation,
    /// `#rgb` / `#rrggbb`, the colour the shell tints its own status bar with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_color: Option<String>,
}

impl Default for DisplaySection {
    /// Only ever produced by an omitted `[display]` table — [`validate_http_url`]
    /// then refuses the empty `url`, so a manifest without an entry point fails
    /// loudly instead of compiling to an app that opens nothing.
    fn default() -> Self {
        Self {
            url: String::new(),
            icon: None,
            mode: DisplayMode::default(),
            orientation: Orientation::default(),
            theme_color: None,
        }
    }
}

/// `mode` — the W3C display-mode vocabulary AmOS honours.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DisplayMode {
    /// Immersive: the shell hides its own chrome (the phone default).
    Fullscreen,
    /// The shell keeps a slim navigation bar.
    MinimalUi,
    /// The shell keeps its normal app chrome.
    #[default]
    Standalone,
}

/// `orientation` — the locked orientation, or `any` to let the user decide.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Orientation {
    Portrait,
    Landscape,
    #[default]
    Any,
}

/// One `[[mcp_tools]]` entry — a function the model may call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpTool {
    /// MCP function name: `[a-z][a-z0-9_]*`, globally unique across the index.
    pub name: String,
    pub description: String,
    /// Canonical MCP spelling — kept camelCase on the wire, as the MCP spec has it.
    #[serde(rename = "inputSchema")]
    pub input_schema: InputSchema,
    pub execution: Execution,
}

/// A JSON-Schema **subset**: the flat object shape MCP tools actually use.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputSchema {
    /// Must be `"object"` (a tool's arguments are a single object).
    #[serde(rename = "type")]
    pub kind: String,
    /// Property names the caller must supply. Every one must be a `properties` key.
    #[serde(default)]
    pub required: Vec<String>,
    #[serde(default)]
    pub properties: BTreeMap<String, SchemaProperty>,
}

/// One property of an [`InputSchema`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchemaProperty {
    /// A JSON primitive/array/object type name (see [`SCHEMA_TYPES`]).
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub description: String,
}

/// The JSON-Schema type names accepted in v0.1. Deliberately the *flat* set: no
/// `oneOf`/`$ref`/nested objects, because nothing downstream can resolve them yet
/// (accepting them would be a schema the model sees and the router cannot fill).
pub const SCHEMA_TYPES: &[&str] = &["string", "number", "integer", "boolean", "array", "object"];

/// How a matched tool actually reaches the app.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Execution {
    pub action: ToolAction,
    /// Required for [`ToolAction::UrlRedirect`]: the URL to build, with
    /// `{property}` placeholders. Validated against the schema.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_template: Option<String>,
}

/// The execution actions v0.1 implements.
///
/// Only one variant exists on purpose: `eval_js` (a background silent run) has
/// no executor in AmOS and no audit trail for one, so accepting the spelling
/// would hand a developer a capability the system cannot honour — serde refuses
/// it with `unknown variant ... expected url_redirect` instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolAction {
    /// Build the URL and bring the app to the foreground on that page.
    UrlRedirect,
}

/// `[permissions]` — declarations the Rust judge is expected to enforce.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermissionsSection {
    #[serde(default)]
    pub network: NetworkSection,
}

/// `[permissions.network]` — the outbound-domain allow list.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NetworkSection {
    /// **Bare hosts only** (`host.tld`) — the exact grammar
    /// `amos-network-guard::policy::domain_matches` implements, where a bare host
    /// matches itself **and every subdomain**, and there is no wildcard form. A
    /// pattern written with a leading `*.` therefore matches nothing and is
    /// refused at validation time ([`validate_domain_pattern`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_domains: Vec<String>,
}

/// The compiled index: exactly what `amos-app://index/apps.json` returns.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PwaIndex {
    /// [`INDEX_SCHEMA`] — consumers branch on this, never guess.
    pub schema: u32,
    /// Every app, sorted by id (deterministic output; the same directory always
    /// compiles to the same bytes, so the JSON is diffable and cacheable).
    pub apps: Vec<PwaManifest>,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// A manifest failure, expressed as the crate's existing backend-detail variant
/// (the message carries the offending file/field, so an operator can fix it).
fn bad(msg: impl Into<String>) -> StoreError {
    StoreError::Provider(msg.into())
}

/// True when `url` is an absolute http/https URL whose authority is a plain
/// host (`[A-Za-z0-9.-]`, no userinfo/`@`, no backslash) and which carries no
/// whitespace or control character.
///
/// Everything else is refused — including `javascript:`/`data:`/`file:`, which
/// are exactly the schemes that turn a "declared URL" into an injected script.
fn validate_http_url(url: &str, what: &str) -> Result<()> {
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(bad(format!("{what} contains whitespace/control: {url:?}")));
    }
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| bad(format!("{what} must be an absolute http(s) URL: {url:?}")))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return Err(bad(format!("{what} has no host: {url:?}")));
    }
    if !authority
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
    {
        return Err(bad(format!(
            "{what} host must be a plain host[:port]: {url:?}"
        )));
    }
    Ok(())
}

/// True when `rel` is a safe **relative** path: at least one `Normal` component,
/// no absolute prefix, no `.`/`..`/empty segment, no NUL, no backslash.
fn is_safe_relative(rel: &str) -> bool {
    if rel.is_empty() || rel.contains('\0') || rel.contains('\\') {
        return false;
    }
    let p = Path::new(rel);
    !p.is_absolute() && p.components().all(|c| matches!(c, Component::Normal(_)))
}

/// A `#rgb` / `#rrggbb` colour.
fn is_hex_colour(s: &str) -> bool {
    let Some(hex) = s.strip_prefix('#') else {
        return false;
    };
    matches!(hex.len(), 3 | 6) && hex.chars().all(|c| c.is_ascii_hexdigit())
}

/// True when `name` is an MCP tool identifier: `[a-z][a-z0-9_]*`.
///
/// Constrained on purpose: the name is also the model's routing key, so
/// uppercase/`-`/`.` would make two tools indistinguishable after any
/// normalisation someone downstream might apply.
fn is_tool_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Validate one `[permissions.network].allowed_domains` pattern.
///
/// **Shared on purpose**: the PWA index (`amos-app.toml`) and a hosted bundle
/// (`amos-app.json`) declare egress in the same grammar, so there is exactly one
/// definition of "a domain pattern AmOS accepts" — and both end up enforced the
/// same way (a WebView CSP, see [`bundle_csp`]).
///
/// The *matching* grammar is exactly what `amos-network-guard`'s matcher
/// implements (`policy::domain_matches`): a bare host, which matches that host
/// **and every subdomain of it**. There is no wildcard form in that matcher — a
/// pattern written as `*.example.com` can never match anything, so it is
/// **refused** with the replacement spelled out rather than stored as a rule that
/// will silently do nothing. (The claim that the matcher understands a leading
/// `*.` was wrong; see the parity test below, which pins the grammar against the
/// real matcher.)
///
/// On top of that this validator is deliberately **stricter in one way**: the
/// host must be fully qualified (at least two labels). The matcher would happily
/// match a dotless name, but an egress allow-list is a grant, and `localhost` /
/// a bare LAN name is the one grant that reaches *this* machine — so it is
/// refused rather than offered.
pub(crate) fn validate_domain_pattern(pattern: &str) -> Result<()> {
    if let Some(wildcardless) = pattern.strip_prefix("*.") {
        return Err(bad(format!(
            "allowed domain {pattern:?}: the guard's matcher has no wildcard form — a bare host \
             already matches every subdomain, so write {wildcardless:?} instead"
        )));
    }
    let host = pattern;
    if host.is_empty() || host.contains('*') {
        return Err(bad(format!(
            "allowed domain {pattern:?}: '*' is not a host label"
        )));
    }
    if host != host.to_ascii_lowercase() {
        return Err(bad(format!(
            "allowed domain {pattern:?}: must be lowercase ASCII"
        )));
    }
    if !host.contains('.') {
        return Err(bad(format!(
            "allowed domain {pattern:?}: must be fully qualified (labels separated by '.')"
        )));
    }
    for label in host.split('.') {
        let ok = !label.is_empty()
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !ok {
            return Err(bad(format!(
                "allowed domain {pattern:?}: invalid label {label:?}"
            )));
        }
    }
    Ok(())
}

/// Split a URL template into `(literal, placeholder names)`.
///
/// **The braces must balance, or this is an error.** That is not pedantry: the
/// "every `{x}` must be a declared property" rule below can only see whole
/// `{…}` runs, so an unbalanced brace makes the scanner stop early and treat the
/// rest of the template as literal text — i.e. exactly the malformed template the
/// rule exists to refuse would pass. A URL template is the wire contract the
/// model's arguments are interpolated into, so "half a placeholder" is a defect.
///
/// The returned `literal` is the template with every placeholder **removed**, so
/// [`validate_http_url`] checks the part that is fixed. That also rejects a
/// placeholder standing in for the authority (`https://{host}/x` → `https:///x`
/// has no host), which is deliberate: letting a model-supplied argument become
/// the URL *host* is how a "redirect helper" becomes an open redirect.
///
/// Returns each placeholder's **byte offset in `template`** alongside its name, so the
/// caller can check what precedes it: a placeholder that sits *at the authority
/// boundary* (before any `/`, `?` or `#`) can end the host — `https://ok.example.org`
/// plus the value `@evil.test/x` parses as host `evil.test`.
fn template_parts(template: &str) -> Result<(String, Vec<(String, usize)>)> {
    let mut literal = String::with_capacity(template.len());
    let mut names = Vec::new();
    let mut rest = template;
    loop {
        let Some(i) = rest.find(['{', '}']) else {
            literal.push_str(rest);
            return Ok((literal, names));
        };
        if rest.as_bytes()[i] == b'}' {
            return Err(bad(format!(
                "url_template has a '}}' outside a placeholder: {template:?}"
            )));
        }
        literal.push_str(&rest[..i]);
        let at = template.len() - rest.len() + i; // byte offset of this '{'
        let after = &rest[i + 1..];
        let Some(close) = after.find('}') else {
            return Err(bad(format!(
                "url_template has an unclosed '{{': {template:?}"
            )));
        };
        if after[..close].contains('{') {
            return Err(bad(format!(
                "url_template nests a '{{' inside a placeholder: {template:?}"
            )));
        }
        names.push((after[..close].to_string(), at));
        rest = &after[close + 1..];
    }
}

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

impl PwaManifest {
    /// Parse an `amos-app.toml`. Unknown keys anywhere are an error (see the
    /// module docs) — the `toml` error names the offending key and line.
    pub fn parse(text: &str) -> Result<Self> {
        toml::from_str(text).map_err(|e| bad(format!("invalid amos-app.toml: {e}")))
    }

    /// Full semantic validation. Returns the parsed [`Version`] so a caller that
    /// needs it does not parse it twice (and cannot disagree with the check).
    pub fn validate(&self) -> Result<Version> {
        let id = &self.app.id;
        if !valid_id(id) {
            return Err(StoreError::InvalidAppId(id.clone()));
        }
        if self.app.name.trim().is_empty() {
            return Err(bad(format!("app {id:?}: name is empty")));
        }
        let version =
            Version::parse(&self.app.version).map_err(|e| bad(format!("app {id:?}: {e}")))?;

        if self.display.url.is_empty() {
            return Err(bad(format!(
                "app {id:?}: [display].url is required (the app's entry point)"
            )));
        }
        validate_http_url(&self.display.url, &format!("app {id:?} display.url"))?;
        if let Some(icon) = &self.display.icon {
            if !is_safe_relative(icon) {
                return Err(bad(format!(
                    "app {id:?}: display.icon must be a path relative to the index dir \
                     (no leading '/', no '..'), got {icon:?}"
                )));
            }
        }
        if let Some(colour) = &self.display.theme_color {
            if !is_hex_colour(colour) {
                return Err(bad(format!(
                    "app {id:?}: display.theme_color must be #rgb or #rrggbb, got {colour:?}"
                )));
            }
        }

        for pattern in &self.permissions.network.allowed_domains {
            validate_domain_pattern(pattern).map_err(|e| bad(format!("app {id:?}: {e}")))?;
        }

        let mut seen = BTreeSet::new();
        for tool in &self.mcp_tools {
            self.validate_tool(tool, &mut seen)?;
        }

        Ok(version)
    }
}

impl PwaManifest {
    /// Validate one tool, tracking `seen` names **within this manifest** (the
    /// cross-app uniqueness rule lives in [`PwaIndex::from_manifests`]).
    fn validate_tool(&self, tool: &McpTool, seen: &mut BTreeSet<String>) -> Result<()> {
        let id = &self.app.id;
        if !is_tool_name(&tool.name) {
            return Err(bad(format!(
                "app {id:?}: tool name {:?} must match [a-z][a-z0-9_]*",
                tool.name
            )));
        }
        if !seen.insert(tool.name.clone()) {
            return Err(bad(format!(
                "app {id:?}: duplicate tool name {:?}",
                tool.name
            )));
        }
        if tool.description.trim().is_empty() {
            return Err(bad(format!(
                "app {id:?}: tool {:?} has no description — this is the text the model \
                 matches a spoken request against, so an empty one is an uncallable tool",
                tool.name
            )));
        }

        let schema = &tool.input_schema;
        if schema.kind != "object" {
            return Err(bad(format!(
                "app {id:?}: tool {:?} inputSchema.type must be \"object\", got {:?}",
                tool.name, schema.kind
            )));
        }
        for (name, prop) in &schema.properties {
            if !SCHEMA_TYPES.contains(&prop.kind.as_str()) {
                return Err(bad(format!(
                    "app {id:?}: tool {:?} property {name:?} has unsupported type {:?} \
                     (supported: {})",
                    tool.name,
                    prop.kind,
                    SCHEMA_TYPES.join(", ")
                )));
            }
        }
        for name in &schema.required {
            if !schema.properties.contains_key(name) {
                return Err(bad(format!(
                    "app {id:?}: tool {:?} requires {name:?}, which is not a declared property",
                    tool.name
                )));
            }
        }

        match tool.execution.action {
            ToolAction::UrlRedirect => {
                let Some(template) = &tool.execution.url_template else {
                    return Err(bad(format!(
                        "app {id:?}: tool {:?} action = \"url_redirect\" needs url_template",
                        tool.name
                    )));
                };
                let (literal, placeholders) = template_parts(template)
                    .map_err(|e| bad(format!("app {id:?}: tool {:?}: {e}", tool.name)))?;
                validate_http_url(
                    &literal,
                    &format!("app {id:?} tool {:?} url_template", tool.name),
                )?;
                for (placeholder, at) in &placeholders {
                    if !schema.properties.contains_key(placeholder) {
                        return Err(bad(format!(
                            "app {id:?}: tool {:?} url_template uses {{{placeholder}}}, \
                             which is not a declared property",
                            tool.name
                        )));
                    }
                    // The other half of "a value must never become the host": a placeholder
                    // that appears **before the authority ends** can rewrite it —
                    // `https://ok.example.org` + `@evil.test/x` parses as host `evil.test`.
                    // `/`, `?` and `#` all end the authority, so any of them in the prefix
                    // means the value lands in the path/query/fragment instead.
                    let prefix = &template[..*at];
                    let after_scheme = prefix
                        .find("://")
                        .map(|i| &prefix[i + 3..])
                        .unwrap_or_default();
                    if !after_scheme.contains(['/', '?', '#']) {
                        return Err(bad(format!(
                            "app {id:?}: tool {:?} url_template puts {{{placeholder}}} before \
                             the authority ends, so a value there can rewrite the URL host \
                             (open redirect); end the authority first, e.g. \
                             /path/{{{placeholder}}}",
                            tool.name
                        )));
                    }
                }
                // The inverse direction: a *required* argument the template never
                // consumes is silently dropped when the URL is built.
                for name in &schema.required {
                    if !placeholders.iter().any(|(p, _)| p == name) {
                        return Err(bad(format!(
                            "app {id:?}: tool {:?} requires {name:?} but url_template \
                             never uses {{{name}}} — the argument would be dropped",
                            tool.name
                        )));
                    }
                }
            }
        }
        Ok(())
    }

    /// The tool dictionary this app contributes, as `(name, description)` pairs.
    /// One place the AI layer can read without re-walking the index.
    pub fn tool_dictionary(&self) -> Vec<(&str, &str)> {
        self.mcp_tools
            .iter()
            .map(|t| (t.name.as_str(), t.description.as_str()))
            .collect()
    }
}

impl PwaIndex {
    /// Compile every `apps/*.toml` under `dir` into one index.
    ///
    /// Deterministic: files are read in sorted order and the result is sorted by
    /// app id, so the same directory always produces the same JSON bytes.
    /// The file stem must equal the app's `id` — a rename that leaves the id
    /// behind is a mis-filed manifest, and silently accepting it means two
    /// sources of truth for the same app.
    pub fn from_dir(dir: &Path) -> Result<Self> {
        let apps_dir = dir.join(APPS_DIR);
        let entries = fs::read_dir(&apps_dir)
            .map_err(|e| bad(format!("PWA index {} unreadable: {e}", apps_dir.display())))?;

        let mut files: Vec<PathBuf> = Vec::new();
        for entry in entries {
            let entry =
                entry.map_err(|e| bad(format!("PWA index {} entry: {e}", apps_dir.display())))?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("toml") {
                files.push(path);
            }
        }
        files.sort();

        let mut manifests = Vec::with_capacity(files.len());
        for file in files {
            let text = fs::read_to_string(&file)
                .map_err(|e| bad(format!("read {}: {e}", file.display())))?;
            let manifest =
                PwaManifest::parse(&text).map_err(|e| bad(format!("{}: {e}", file.display())))?;
            manifest
                .validate()
                .map_err(|e| bad(format!("{}: {e}", file.display())))?;
            let stem = file
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            if stem != manifest.app.id {
                return Err(bad(format!(
                    "{}: the file name must equal the app id (expected {}.toml, app id is {:?})",
                    file.display(),
                    manifest.app.id,
                    manifest.app.id
                )));
            }
            manifests.push(manifest);
        }
        Self::from_manifests(manifests)
    }

    /// Validate the set as a whole and compile it.
    ///
    /// Two cross-app rules live here because they are properties of the *index*,
    /// not of one manifest: app ids are unique, and so are **tool names** —
    /// they are the model's routing key, so the same name in two apps is an
    /// ambiguous call, not a naming preference.
    fn from_manifests(mut apps: Vec<PwaManifest>) -> Result<Self> {
        apps.sort_by(|a, b| a.app.id.cmp(&b.app.id));
        let mut ids = BTreeSet::new();
        let mut tools = BTreeSet::new();
        for manifest in &apps {
            if !ids.insert(manifest.app.id.clone()) {
                return Err(bad(format!("duplicate app id {:?}", manifest.app.id)));
            }
            for tool in &manifest.mcp_tools {
                if !tools.insert(tool.name.clone()) {
                    return Err(bad(format!(
                        "duplicate tool name {:?}: tool names are the model's routing key \
                         and must be unique across the whole index",
                        tool.name
                    )));
                }
            }
        }
        Ok(PwaIndex {
            schema: INDEX_SCHEMA,
            apps,
        })
    }

    /// The canonical JSON served at `amos-app://index/apps.json`.
    pub fn to_json_pretty(&self) -> Result<String> {
        serde_json::to_string_pretty(self).map_err(|e| bad(format!("serialize PWA index: {e}")))
    }

    /// Every app's tools as one flat dictionary, in index order. This is the
    /// shape the AI daemon injects into a model's context.
    pub fn tool_dictionary(&self) -> Vec<(&str, &str)> {
        self.apps.iter().flat_map(|m| m.tool_dictionary()).collect()
    }

    /// The app that owns `tool`, if any.
    pub fn app_for_tool(&self, tool: &str) -> Option<&str> {
        self.apps
            .iter()
            .find(|m| m.mcp_tools.iter().any(|t| t.name == tool))
            .map(|m| m.app.id.as_str())
    }
}

/// The manifests a build embeds as factory assets.
///
/// **Empty on purpose.** AmOS has no PWA partners yet, and a fabricated tile on
/// a home screen would be exactly the kind of lie this crate exists to prevent.
/// A real device image supplies [`INDEX_DIR_ENV`]; to embed manifests in the
/// binary instead, add `include_str!` entries here (a few hundred bytes each,
/// which is the whole point of the format).
pub const BUILTIN_MANIFESTS: &[&str] = &[];

/// The env var naming the on-disk index directory (`apps/*.toml` + `icons/`).
pub const INDEX_DIR_ENV: &str = "AMOS_PWA_INDEX_DIR";

/// Compile [`BUILTIN_MANIFESTS`] into an index.
pub fn builtin_index() -> Result<PwaIndex> {
    let mut apps = Vec::with_capacity(BUILTIN_MANIFESTS.len());
    for text in BUILTIN_MANIFESTS {
        let manifest = PwaManifest::parse(text)?;
        manifest.validate()?;
        apps.push(manifest);
    }
    PwaIndex::from_manifests(apps)
}

// ---------------------------------------------------------------------------
// Serving (`amos-app://index/…`)
// ---------------------------------------------------------------------------

/// `root.join(rel)`, but only for a [`is_safe_relative`] path that
/// canonicalizes to a **file inside `root`**. The canonicalize-then-compare is
/// the same two-step `serve::resolve_request` uses for bundles, and it is the
/// only thing that actually stops `..`/symlink escapes (a string check alone
/// never does).
fn resolve_inside(dir: &Path, rel: &str) -> Result<PathBuf> {
    if !is_safe_relative(rel) {
        return Err(bad(format!("unsafe index path {rel:?}")));
    }
    let root = fs::canonicalize(dir)
        .map_err(|e| bad(format!("PWA index {} missing: {e}", dir.display())))?;
    let target =
        fs::canonicalize(root.join(rel)).map_err(|_| bad(format!("no such index asset: {rel}")))?;
    if !target.starts_with(&root) {
        return Err(bad(format!("index path escapes its root: {rel}")));
    }
    if !target.is_file() {
        return Err(bad(format!("index asset is not a file: {rel}")));
    }
    Ok(target)
}

/// Serve one `amos-app://index/<request>` request.
///
/// * `""`, `/`, `/apps.json` → the compiled index ([`PwaIndex::to_json_pretty`]),
///   built from `index_dir` when one is configured and from
///   [`BUILTIN_MANIFESTS`] otherwise.
/// * `/icons/<file>` → that file, read out of `<index_dir>/icons/`.
/// * anything else → refused. Only the icon directory is reachable over the
///   protocol; the manifests themselves are always *compiled* into `apps.json`
///   and never served raw, so the served surface is one JSON document plus
///   images and stays something a reader can hold in their head.
///
/// `index_dir` is the operator-supplied directory (see [`INDEX_DIR_ENV`]);
/// `None` means "this build ships no index directory".
pub fn serve_index(index_dir: Option<&Path>, request: &str) -> Result<ServedBundle> {
    let path = request.trim_start_matches('/');
    let path = path.split(['?', '#']).next().unwrap_or(path);

    if path.is_empty() || path == INDEX_PATH {
        let index = match index_dir {
            Some(dir) => PwaIndex::from_dir(dir)?,
            None => builtin_index()?,
        };
        let json = index.to_json_pretty()?;
        return Ok(ServedBundle {
            bytes: json.into_bytes(),
            content_type: content_type_for(Path::new(INDEX_PATH)),
            nosniff: true,
            csp: Some(index_csp()),
        });
    }

    let dir = index_dir.ok_or_else(|| {
        bad(format!(
            "no PWA index directory is configured ({INDEX_DIR_ENV} is unset; \
             this build embeds {} manifests) — cannot serve {request:?}",
            BUILTIN_MANIFESTS.len()
        ))
    })?;

    if !path.starts_with(&format!("{ICONS_DIR}/")) {
        return Err(bad(format!(
            "amos-app://index/{path} is not served: only /{INDEX_PATH} and /{ICONS_DIR}/… exist"
        )));
    }
    let file = resolve_inside(dir, path)?;
    let bytes = fs::read(&file).map_err(|e| bad(format!("read {}: {e}", file.display())))?;
    Ok(ServedBundle {
        bytes,
        content_type: content_type_for(&file),
        nosniff: true,
        csp: Some(index_csp()),
    })
}

// ---------------------------------------------------------------------------
// The caller's base URL (a *wry* fact, so it lives in Rust)
// ---------------------------------------------------------------------------

/// The base URL a WebView must use to reach the index **on this platform**.
///
/// Thin wrapper over [`protocol_base_url`] with the reserved index netloc — see
/// there for *why* a caller may not assemble this itself.
pub fn index_base_url() -> String {
    protocol_base_url(INDEX_NETLOC)
}

/// Pure: the index base URL for a platform whose custom protocols go through
/// wry's `http://{scheme}.` workaround (`true` = Windows/Android) or do not
/// (`false` = macOS/iOS/Linux). Split out so **both** forms are testable from one
/// machine.
pub fn index_base_url_for(webview_workaround: bool) -> String {
    protocol_base_url_for(INDEX_NETLOC, webview_workaround)
}

/// The base URL a WebView must use to reach *any* netloc of the `amos-app://`
/// namespace **on this platform** — `index` is the compiled index, an app id is
/// that app's installed bundle.
///
/// This is the one piece of the protocol a caller cannot work out from the URI
/// table in `docs/pwa-index.md`: on Windows and Android a custom scheme has no
/// native support, so wry rewrites every `{scheme}://{host}` to
/// `http://{scheme}.{host}` (`wry/src/custom_protocol_workaround.rs`). A
/// frontend that hard-coded `amos-app://index` would therefore be **dead on
/// Android** — the platform AmOS actually ships on — and the failure would look
/// like "the index is empty", not like a URL mistake.
///
/// So a consumer asks for this instead of assembling the URL itself. The
/// protocol handler itself needs no such branch: wry reverts the rewrite before
/// handing the request over, so it always sees `amos-app://<netloc>/…`.
pub fn protocol_base_url(netloc: &str) -> String {
    protocol_base_url_for(netloc, cfg!(any(windows, target_os = "android")))
}

/// Pure [`protocol_base_url`] — the workaround flag is a parameter so both forms
/// are testable from one machine.
pub fn protocol_base_url_for(netloc: &str, webview_workaround: bool) -> String {
    if webview_workaround {
        format!("http://{SCHEME}.{netloc}")
    } else {
        format!("{SCHEME}://{netloc}")
    }
}

/// An absolute URL for `rel` under `base` (a [`protocol_base_url`] value). Every
/// call site composes URLs through this, so no caller pastes a scheme by hand.
pub fn protocol_url(base: &str, rel: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        rel.trim_start_matches('/')
    )
}

// ---------------------------------------------------------------------------
// Content-Security-Policy: how a declared domain list becomes enforced
// ---------------------------------------------------------------------------

/// The CSP source expressions a declared domain list turns into.
///
/// A declaration is a **bare host** (`api.example.com`) whose guard-matcher
/// meaning is "that host *and every subdomain*" ([`validate_domain_pattern`]).
/// The CSP equivalent is therefore the host plus its one-label wildcard, in the
/// **secure** schemes only: `https://` and `wss://`.
///
/// Plain `http://` / `ws://` are deliberately **not** granted. A bundle that
/// declares a host is saying "I talk to this host", and on the open internet that
/// means TLS; granting cleartext as well would let the same declaration be used
/// to exfiltrate over an unauthenticated channel. This is a resolution, not an
/// omission — an app that genuinely needs cleartext to a declared host cannot
/// have it, and the violation shows up in the WebView console rather than
/// silently.
pub fn csp_connect_sources(allowed_domains: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for host in allowed_domains {
        for scheme in ["https", "wss"] {
            out.push(format!("{scheme}://{host}"));
            out.push(format!("{scheme}://*.{host}"));
        }
    }
    out
}

/// The Content-Security-Policy a **hosted bundle's documents** are served with.
///
/// This is the mechanism that turns `allowed_domains` from a declaration into a
/// promise. It has to be a response header from the protocol handler rather than
/// a setting on the shell: a CSP is enforced **per document**, and a bundle is a
/// separate document at its own origin, so the shell's own policy (or any
/// `tauri.conf.json` entry) would not constrain it at all.
///
/// (It is also the *only* mechanism available at this layer: `amos-network-guard`
/// is uid-scoped, and a hosted bundle runs in the **same process and uid** as the
/// shell, so no packet filter can tell them apart. A per-bundle OS firewall rule
/// is not possible by construction — recorded here so nobody promises one.)
///
/// * `default-src 'self'` / `script-src 'self'` — the bundle's own files only, so
///   a publisher cannot pull in remote code (the difference between "a web app"
///   and "arbitrary code of someone else's choosing").
/// * `connect-src 'self'` **plus the declared hosts** — this is the egress promise.
/// * `img-src`/`media-src`/`font-src` allow `data:`/`blob:` because inline assets
///   are how a static bundle ships its pictures and sounds.
/// * `object-src 'none'`, `base-uri 'none'`, `frame-src 'none'` — no plugins, no
///   `<base>` rewriting of every relative URL, no nested frames.
/// * `form-action` is limited to the same allow-list as `connect-src`, so a form
///   post is egress too and gets the same treatment (rather than being blocked
///   outright, which would silently break ordinary apps).
///
/// **Not covered — say it plainly:** a bundle can still *navigate its own frame*
/// to an external URL, and that navigation can carry data in its path. CSP's
/// `navigate-to` is not implemented by the engines we ship, so this cannot be
/// closed here; it needs a real egress guard, which (see above) cannot be
/// per-bundle today.
pub fn bundle_csp(allowed_domains: &[String]) -> String {
    let mut connect = vec!["'self'".to_string()];
    connect.extend(csp_connect_sources(allowed_domains));
    let connect = connect.join(" ");
    format!(
        "default-src 'self'; \
         script-src 'self'; \
         style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob:; \
         media-src 'self' data: blob:; \
         font-src 'self' data:; \
         connect-src {connect}; \
         form-action {connect}; \
         frame-src 'none'; \
         worker-src 'self'; \
         object-src 'none'; \
         base-uri 'none'"
    )
}

/// The CSP the **index namespace** is served with: `apps.json` and the icon
/// files. Nothing there is a document, so nothing there should be able to run or
/// load anything — even if a caller framed the JSON by mistake.
pub fn index_csp() -> String {
    "default-src 'none'; frame-ancestors 'none'".to_string()
}

/// The absolute URL of the index document under `base`.
pub fn index_document_url(base: &str) -> String {
    protocol_url(base, INDEX_PATH)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// The reference manifest: the documented `amos-app.toml` shape, end to end.
    /// Every field of the accepted v0.1 subset appears here, so a change that
    /// breaks one of them breaks this test too.
    const SAMPLE: &str = r##"
[app]
id = "org.amos.demo.odds"
name = "Open Odds"
version = "1.0.0"
description = "去中心化全球预测市场平台"

[display]
url = "https://odds.example.org"
icon = "icons/org.amos.demo.odds.png"
mode = "fullscreen"
orientation = "portrait"
theme_color = "#0F172A"

[[mcp_tools]]
name = "query_market_odds"
description = "查询全球实时事件（如大选、科技趋势、体育比赛）的最新预测胜率或赔率。"

    [mcp_tools.inputSchema]
    type = "object"
    required = ["event_keywords"]

    [mcp_tools.inputSchema.properties.event_keywords]
    type = "string"
    description = "用户想要查询的事件关键词"

    [mcp_tools.execution]
    action = "url_redirect"
    url_template = "https://odds.example.org/search/{event_keywords}"

[permissions.network]
allowed_domains = ["odds.example.org", "cdn.odds.example.net"]
"##;

    fn a_manifest(app_id: &str, tool: &str) -> PwaManifest {
        PwaManifest {
            app: AppSection {
                id: app_id.into(),
                name: "X".into(),
                version: "1.0.0".into(),
                description: String::new(),
            },
            display: DisplaySection {
                url: "https://x.example.org".into(),
                ..DisplaySection::default()
            },
            mcp_tools: vec![McpTool {
                name: tool.into(),
                description: "does a thing".into(),
                input_schema: InputSchema {
                    kind: "object".into(),
                    required: vec!["q".into()],
                    properties: [(
                        "q".to_string(),
                        SchemaProperty {
                            kind: "string".into(),
                            description: String::new(),
                        },
                    )]
                    .into_iter()
                    .collect(),
                },
                execution: Execution {
                    action: ToolAction::UrlRedirect,
                    url_template: Some("https://x.example.org/?q={q}".into()),
                },
            }],
            permissions: PermissionsSection::default(),
        }
    }

    /// A unique temp index dir per call (the repo's parallel-test convention — a
    /// shared directory makes tests race, and a flaky red is worthless evidence).
    fn temp_index(tag: &str) -> PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let seq = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("amos-pwa-{tag}-{}-{seq}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("apps")).unwrap();
        dir
    }

    #[test]
    fn parses_the_reference_manifest_and_compiles_to_json() {
        let manifest = PwaManifest::parse(SAMPLE).expect("reference manifest parses");
        let version = manifest.validate().expect("and validates");
        assert_eq!((version.major, version.minor, version.patch), (1, 0, 0));
        assert_eq!(manifest.display.mode, DisplayMode::Fullscreen);
        assert_eq!(manifest.display.orientation, Orientation::Portrait);
        assert_eq!(
            manifest.permissions.network.allowed_domains,
            vec!["odds.example.org", "cdn.odds.example.net"]
        );

        // The tool survives to the wire with the MCP camelCase schema key.
        let index = PwaIndex {
            schema: INDEX_SCHEMA,
            apps: vec![manifest],
        };
        let json = index.to_json_pretty().unwrap();
        assert!(json.contains("\"inputSchema\""), "{json}");
        assert!(json.contains("\"url_redirect\""));
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["schema"], serde_json::json!(INDEX_SCHEMA));
        assert_eq!(
            index.app_for_tool("query_market_odds"),
            Some("org.amos.demo.odds")
        );
        assert_eq!(index.app_for_tool("nope"), None);
        assert_eq!(index.tool_dictionary().len(), 1);
    }

    #[test]
    fn omitting_optional_display_fields_uses_documented_defaults() {
        let text = "[app]\nid = \"org.amos.min\"\nname = \"Min\"\nversion = \"0.1.0\"\n\
                    [display]\nurl = \"https://min.example.org\"\n";
        let m = PwaManifest::parse(text).unwrap();
        m.validate().unwrap();
        assert_eq!(m.display.mode, DisplayMode::Standalone);
        assert_eq!(m.display.orientation, Orientation::Any);
        assert_eq!(m.display.icon, None);
        assert_eq!(m.display.theme_color, None);
        assert!(m.mcp_tools.is_empty());
    }

    #[test]
    fn a_manifest_without_a_display_entry_point_is_refused() {
        let text = "[app]\nid = \"org.amos.nodisp\"\nname = \"N\"\nversion = \"1.0.0\"\n";
        let m = PwaManifest::parse(text).unwrap();
        assert!(
            m.validate().is_err(),
            "an app that opens nothing is refused"
        );
    }

    #[test]
    fn unimplemented_permission_keys_are_refused_by_name_not_ignored() {
        // The whole point of the protocol: a capability AmOS cannot honour must
        // be a loud error, never a quietly dropped line.
        for key in ["wallet_sign", "biometric", "p2p_network"] {
            let text = format!(
                "[app]\nid = \"org.amos.p\"\nname = \"P\"\nversion = \"1.0.0\"\n\
                 [display]\nurl = \"https://p.example.org\"\n\
                 [permissions]\n{key} = true\n"
            );
            let err = PwaManifest::parse(&text).expect_err("key");
            assert!(
                format!("{err}").contains(key),
                "{key}: the error must name the key, got {err}"
            );
        }
        // …and an unknown key inside the supported sub-table too.
        let text = "[app]\nid = \"org.amos.p\"\nname = \"P\"\nversion = \"1.0.0\"\n\
                    [display]\nurl = \"https://p.example.org\"\n\
                    [permissions.network]\nblocked_domains = [\"a.com\"]\n";
        assert!(PwaManifest::parse(text).is_err());
    }

    #[test]
    fn eval_js_and_unenforced_display_knobs_are_refused() {
        let text = SAMPLE.replace("action = \"url_redirect\"", "action = \"eval_js\"");
        let err = PwaManifest::parse(&text).expect_err("eval_js has no executor in v0.1");
        assert!(format!("{err}").contains("eval_js"), "{err}");

        let text = "[app]\nid = \"org.amos.p\"\nname = \"P\"\nversion = \"1.0.0\"\n\
                    [display]\nurl = \"https://p.example.org\"\njs_heap_limit_mb = 10\n";
        let err = PwaManifest::parse(text).expect_err("no such knob is enforced");
        assert!(format!("{err}").contains("js_heap_limit_mb"), "{err}");
    }

    #[test]
    fn a_url_template_must_have_balanced_braces() {
        // These two *used to pass*: the scan for `{…}` stopped at the stray
        // brace and treated the tail as literal text, so the "every placeholder
        // must be a declared property" rule never ran. `q` is left **optional**
        // here on purpose — otherwise the unrelated "a required argument the
        // template never consumes" rule is what would catch them, and the brace
        // check would be untested.
        for bad in [
            "https://x.example.org/?q={q",  // unclosed '{'
            "https://x.example.org/?q=q}",  // '}' with no '{'
            "https://x.example.org/?{a{b}", // nested '{'
            "https://{q}/x",                // a placeholder may not be the authority
        ] {
            let mut m = a_manifest("org.amos.a", "t");
            m.mcp_tools[0].input_schema.required.clear();
            m.mcp_tools[0].execution.url_template = Some(bad.into());
            let err = m.validate().expect_err(bad);
            assert!(
                format!("{err}").contains("url_template"),
                "{bad}: the error must name the field, got {err}"
            );
        }

        // …and the balanced form still validates (no over-reach).
        let mut ok = a_manifest("org.amos.a", "t");
        ok.mcp_tools[0].execution.url_template = Some("https://x.example.org/s?q={q}&n=1".into());
        ok.validate().expect("a well-formed template stays valid");
    }

    /// A placeholder may not sit at the **authority boundary**. `https://{q}/x` (a
    /// placeholder *as* the host) is already refused; this pins the other half — a
    /// placeholder that can **end** the host, e.g. `https://ok.example.org{q}`, whose
    /// literal `https://ok.example.org` is a valid URL on its own, yet a value like
    /// `@evil.test/x` makes the *host* `evil.test`. That is the open redirect the
    /// template walker claims to prevent, so the placeholder must come after the
    /// authority has ended (`/`, `?` or `#`).
    #[test]
    fn a_placeholder_may_not_end_the_url_authority() {
        // `q` stays optional here so the *other* rules (placeholder-is-a-property,
        // required-is-consumed) cannot be what catches these.
        for bad in [
            "https://ok.example.org{q}",    // directly after the host
            "https://ok.example.org:{p}/x", // …or after a colon (a model-chosen port)
            "https://ok.example.org:{p}",   // …or with no path at all
        ] {
            let mut m = a_manifest("org.amos.a", "t");
            m.mcp_tools[0].input_schema.required.clear();
            m.mcp_tools[0].input_schema.properties.insert(
                "p".into(),
                SchemaProperty {
                    kind: "string".into(),
                    description: String::new(),
                },
            );
            m.mcp_tools[0].execution.url_template = Some(bad.into());
            let err = m
                .validate()
                .expect_err("a value that can rewrite the host must be refused");
            assert!(
                format!("{err}").contains("host"),
                "{bad}: the error must name the consequence, got {err}"
            );
        }

        // The shapes that *cannot* rewrite the authority stay valid — including the
        // query-only one, where `?` has already ended it.
        for ok in [
            "https://ok.example.org/{q}",
            "https://ok.example.org/q?q={q}&n=1",
            "https://ok.example.org?q={q}",
            "https://ok.example.org/v{q}/x",
            "https://ok.example.org/x#f{q}",
        ] {
            let mut m = a_manifest("org.amos.a", "t");
            m.mcp_tools[0].input_schema.required.clear();
            m.mcp_tools[0].execution.url_template = Some(ok.into());
            m.validate()
                .unwrap_or_else(|e| panic!("{ok} should stay valid: {e}"));
        }
    }

    #[test]
    fn tool_schema_and_template_must_agree_in_both_directions() {
        // (a) a `required` name with no property.
        let mut m = a_manifest("org.amos.a", "t");
        m.mcp_tools[0].input_schema.required = vec!["ghost".into()];
        assert!(m.validate().is_err(), "required-but-undeclared is refused");

        // (b) a placeholder with no property.
        let mut m = a_manifest("org.amos.a", "t");
        m.mcp_tools[0].execution.url_template = Some("https://x.example.org/?q={q}&z={zzz}".into());
        assert!(m.validate().is_err(), "undeclared placeholder is refused");

        // (c) a required property the template never consumes.
        let mut m = a_manifest("org.amos.a", "t");
        m.mcp_tools[0].input_schema.properties.insert(
            "unused".into(),
            SchemaProperty {
                kind: "string".into(),
                description: String::new(),
            },
        );
        m.mcp_tools[0].input_schema.required = vec!["q".into(), "unused".into()];
        let err = m
            .validate()
            .expect_err("a required argument the URL drops must be refused");
        assert!(format!("{err}").contains("unused"), "{err}");

        // (d) the control: the same manifest with a 1:1 template validates.
        let mut ok = a_manifest("org.amos.a", "t");
        ok.mcp_tools[0].execution.url_template = Some("https://x.example.org/{q}".into());
        ok.validate().expect("the fixed manifest is valid");
    }

    #[test]
    fn bad_ids_urls_icons_and_colours_are_refused() {
        for (id, url, colour) in [
            ("Bad Space", "https://x.example.org", None),
            ("org.amos.ok", "javascript:alert(1)", None),
            ("org.amos.ok", "data:text/html,x", None),
            ("org.amos.ok", "file:///etc/passwd", None),
            ("org.amos.ok", "https://x.example.org", Some("red")),
            ("org.amos.ok", "https://x.example.org", Some("#12345")),
        ] {
            let mut m = a_manifest("org.amos.placeholder", "t");
            m.app.id = id.into();
            m.display.url = url.into();
            m.display.theme_color = colour.map(str::to_string);
            assert!(
                m.validate().is_err(),
                "{id}/{url}/{colour:?} must be refused"
            );
        }
        let mut m = a_manifest("org.amos.a", "t");
        m.display.icon = Some("../secret.png".into());
        assert!(m.validate().is_err(), "an icon may not leave the index dir");
        m.display.icon = Some("icons/ok.png".into());
        m.validate().expect("a relative icon is fine");
    }

    #[test]
    fn domain_patterns_use_the_guards_grammar_only() {
        let mut m = a_manifest("org.amos.a", "t");
        for good in ["example.com", "api-1.example.co.uk", "cdn.example.net"] {
            m.permissions.network.allowed_domains = vec![good.into()];
            m.validate()
                .unwrap_or_else(|e| panic!("{good} should be valid: {e}"));
        }
        for bad in [
            "*.example.com", // no wildcard form exists in the matcher (see below)
            "*example.com",
            "example.*",
            "*.*.com",
            "example",
            "localhost", // dotless: reaches *this* machine, so refused (see the docs)
            "Example.com",
            "example.com:443",
            "https://example.com",
            "a..b",
            "-a.com",
        ] {
            m.permissions.network.allowed_domains = vec![bad.into()];
            assert!(m.validate().is_err(), "{bad} must be refused");
        }

        // The refused wildcard is refused with the replacement spelled out, because "the
        // bare host covers the subdomains" is the non-obvious part.
        m.permissions.network.allowed_domains = vec!["*.example.com".into()];
        let err = m.validate().expect_err("wildcard refused");
        assert!(
            format!("{err}").contains("\"example.com\""),
            "the error must name what to write instead: {err}"
        );
    }

    /// Pin the grammar against the **real** matcher, not against a comment: this is the
    /// parity that `allowed_domains` depends on, and it is what makes `*.x` a
    /// confidently-refused form rather than a guess.
    #[test]
    fn the_domain_grammar_is_what_the_guard_matcher_implements() {
        // A bare host matches itself and every subdomain…
        assert!(amos_network_guard::policy::domain_matches(
            "example.com",
            "example.com"
        ));
        assert!(amos_network_guard::policy::domain_matches(
            "example.com",
            "api.example.com"
        ));
        // …and a dotted boundary is required (no `notexample.com`).
        assert!(!amos_network_guard::policy::domain_matches(
            "example.com",
            "notexample.com"
        ));
        // There is no wildcard form: the pattern a manifest might *want* to write is
        // inert for every real hostname (it matches only the literal string
        // `*.example.com`, which is not a hostname) — which is why it is refused.
        assert!(!amos_network_guard::policy::domain_matches(
            "*.example.com",
            "api.example.com"
        ));
        assert!(!amos_network_guard::policy::domain_matches(
            "*.example.com",
            "example.com"
        ));
        assert!(!amos_network_guard::policy::domain_matches(
            "*.example.com",
            "deep.api.example.com"
        ));
    }

    #[test]
    fn duplicate_ids_and_duplicate_tool_names_are_refused() {
        let dup_id = vec![
            a_manifest("org.amos.a", "one"),
            a_manifest("org.amos.a", "two"),
        ];
        let err = PwaIndex::from_manifests(dup_id).expect_err("ids are unique");
        assert!(format!("{err}").contains("duplicate app id"), "{err}");

        let dup_tool = vec![
            a_manifest("org.amos.a", "same"),
            a_manifest("org.amos.b", "same"),
        ];
        let err = PwaIndex::from_manifests(dup_tool)
            .expect_err("a tool name is the model's routing key, so it is unique too");
        assert!(format!("{err}").contains("duplicate tool name"), "{err}");

        // Sorted output, so the same set always compiles to the same bytes.
        let index = PwaIndex::from_manifests(vec![
            a_manifest("org.amos.z", "tz"),
            a_manifest("org.amos.a", "ta"),
        ])
        .unwrap();
        assert_eq!(
            index
                .apps
                .iter()
                .map(|m| m.app.id.as_str())
                .collect::<Vec<_>>(),
            vec!["org.amos.a", "org.amos.z"]
        );
    }

    #[test]
    fn index_dir_compiles_and_the_file_name_must_be_the_app_id() {
        let dir = temp_index("fromdir");
        fs::write(dir.join("apps/org.amos.demo.odds.toml"), SAMPLE).unwrap();
        let index = PwaIndex::from_dir(&dir).unwrap();
        assert_eq!(index.apps.len(), 1);
        assert_eq!(index.schema, INDEX_SCHEMA);

        // Renamed file, stale id: two sources of truth for one app.
        fs::remove_file(dir.join("apps/org.amos.demo.odds.toml")).unwrap();
        fs::write(dir.join("apps/renamed.toml"), SAMPLE).unwrap();
        let err = PwaIndex::from_dir(&dir).expect_err("a misfiled manifest");
        assert!(format!("{err}").contains("must equal the app id"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn serving_the_index_and_its_icons_is_an_allow_list() {
        let dir = temp_index("serve");
        fs::write(dir.join("apps/org.amos.demo.odds.toml"), SAMPLE).unwrap();
        fs::create_dir_all(dir.join("icons")).unwrap();
        fs::write(dir.join("icons/org.amos.demo.odds.png"), b"\x89PNG").unwrap();
        fs::write(dir.join("secret.txt"), b"nope").unwrap();

        // The spellings of "the index itself".
        for req in ["", "/", "/apps.json", "/apps.json?cache=1"] {
            let served = serve_index(Some(&dir), req).unwrap();
            assert_eq!(served.content_type, "application/json; charset=utf-8");
            assert!(served.nosniff);
            assert!(String::from_utf8_lossy(&served.bytes).contains("org.amos.demo.odds"));
        }

        let icon = serve_index(Some(&dir), "/icons/org.amos.demo.odds.png").unwrap();
        assert_eq!(icon.content_type, "image/png");
        assert_eq!(icon.bytes, b"\x89PNG");

        // Everything else is refused — including paths that escape the root, a
        // real file outside `icons/`, and the manifests themselves (they are
        // always compiled, never served raw).
        for bad in [
            "/secret.txt",
            "/icons/../secret.txt",
            "/apps/org.amos.demo.odds.toml",
            "/icons/nope.png",
        ] {
            assert!(
                serve_index(Some(&dir), bad).is_err(),
                "{bad} must be refused"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unconfigured_build_serves_an_empty_index_and_no_icons() {
        let served = serve_index(None, "/apps.json").unwrap();
        let json: serde_json::Value = serde_json::from_slice(&served.bytes).unwrap();
        assert_eq!(json["schema"], serde_json::json!(INDEX_SCHEMA));
        assert_eq!(json["apps"], serde_json::json!([]));

        // A build with no index dir has no icons — name the missing knob rather
        // than serving a bare 404 that looks like a broken app.
        let err = serve_index(None, "/icons/x.png").expect_err("no index dir");
        assert!(format!("{err}").contains(INDEX_DIR_ENV), "{err}");
    }

    #[test]
    fn malformed_toml_is_an_error_not_a_default() {
        assert!(PwaManifest::parse("this is not toml = = =").is_err());
        assert!(
            PwaManifest::parse("").is_err(),
            "a missing [app] is refused"
        );
    }

    #[test]
    fn the_base_url_follows_the_platform_the_webview_is_on() {
        // Both forms, from one machine — the point of splitting the pure helper out.
        assert_eq!(index_base_url_for(false), "amos-app://index");
        assert_eq!(index_base_url_for(true), "http://amos-app.index");

        // …and the platform build picks the one wry actually needs. This is the
        // assertion that would have caught a hard-coded `amos-app://index` on
        // Android (the failure would have looked like "the index is empty").
        let expected = if cfg!(any(windows, target_os = "android")) {
            "http://amos-app.index"
        } else {
            "amos-app://index"
        };
        assert_eq!(index_base_url(), expected);

        // The document/icon URLs are built off it, so a caller never pastes a
        // scheme by hand.
        assert_eq!(
            index_document_url(&index_base_url_for(false)),
            "amos-app://index/apps.json"
        );
        assert_eq!(
            index_document_url("amos-app://index/"), // a trailing slash is tolerated
            "amos-app://index/apps.json"
        );
        assert_eq!(
            protocol_url(&index_base_url_for(true), "icons/x.png"),
            "http://amos-app.index/icons/x.png"
        );
        assert_eq!(
            protocol_url("amos-app://index", "/icons/x.png"), // …and so is a leading one
            "amos-app://index/icons/x.png"
        );

        // The same helper serves an app's bundle namespace — the host needs both.
        assert_eq!(
            protocol_base_url_for("org.amos.web", false),
            "amos-app://org.amos.web"
        );
        assert_eq!(
            protocol_url(&protocol_base_url_for("org.amos.web", true), "index.html"),
            "http://amos-app.org.amos.web/index.html"
        );
    }

    #[test]
    fn a_declared_domain_becomes_csp_sources_for_the_host_and_its_subdomains() {
        let sources = csp_connect_sources(&["api.example.com".to_string()]);
        // The guard-matcher meaning of a bare host is "this host and every
        // subdomain", so the CSP equivalent is the host plus its wildcard — in the
        // secure schemes only.
        assert_eq!(
            sources,
            vec![
                "https://api.example.com",
                "https://*.api.example.com",
                "wss://api.example.com",
                "wss://*.api.example.com",
            ]
        );
        // Cleartext is deliberately **not** granted from the same declaration.
        assert!(!sources.iter().any(|s| s.starts_with("http://")));
        assert!(!sources.iter().any(|s| s.starts_with("ws://")));

        // No declaration → no sources at all (not an empty string entry).
        assert!(csp_connect_sources(&[]).is_empty());
        // Several hosts, in declaration order.
        assert_eq!(
            csp_connect_sources(&["a.example.com".into(), "b.example.org".into()]).len(),
            8
        );
    }

    #[test]
    fn a_bundle_with_no_declaration_can_reach_nobody() {
        let csp = bundle_csp(&[]);
        // `connect-src 'self'` and nothing else: the app can read its own files and
        // nothing more. This is the policy an empty `allowed_domains` means.
        assert!(csp.contains("connect-src 'self';"), "{csp}");
        assert!(csp.contains("form-action 'self';"), "{csp}");
        assert!(!csp.contains("https://"), "{csp}");
        assert!(!csp.contains("*. "), "{csp}");

        // The load-side lock-down, which is the part that stops a publisher from
        // pulling in someone else's code.
        for required in [
            "default-src 'self'",
            "script-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-src 'none'",
        ] {
            assert!(csp.contains(required), "missing {required}: {csp}");
        }
        // A bundle may embed data:/blob: assets — but not remote images, which are
        // the classic one-pixel egress channel.
        assert!(csp.contains("img-src 'self' data: blob:"), "{csp}");
        assert!(!csp.contains("img-src 'self' https:"), "{csp}");
    }

    #[test]
    fn a_declared_host_widens_only_connect_and_form_action() {
        let csp = bundle_csp(&["api.example.com".to_string()]);
        assert!(
            csp.contains("connect-src 'self' https://api.example.com https://*.api.example.com"),
            "{csp}"
        );
        // A declared API host must NOT become a place to load code from.
        assert!(csp.contains("script-src 'self';"), "{csp}");
        assert!(!csp.contains("script-src 'self' https"), "{csp}");
        assert!(!csp.contains("default-src 'self' https"), "{csp}");
    }

    #[test]
    fn the_index_namespace_nothing_runs() {
        let csp = index_csp();
        assert!(csp.contains("default-src 'none'"), "{csp}");
        assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
    }
}
