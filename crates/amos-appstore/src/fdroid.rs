//! F-Droid **repository compatibility** for the Amos store.
//!
//! F-Droid publishes catalogs in a de-facto standard shape: an `index-v1.json`
//! document (`repo` metadata + `apps` + `packages` arrays, camelCase keys) at
//! `<repo>/index-v1.json`, with packages as APKs at `<repo>/<apkName>` and each
//! package carrying a sha256 `hash`. This module speaks that format both ways:
//!
//! * [`FdroidIndexV1`] — serde model of the index (unknown fields ignored, so
//!   future repo additions can't break parsing);
//! * [`fdroid_index_to_catalog`] — maps an index onto the same
//!   [`AppManifest`](crate::model::AppManifest) catalog the
//!   [`AppStore`](crate::client::AppStore) engine already drives (one entry per
//!   app: the *suggested* package, else the highest `versionCode`);
//! * [`FdroidRepoProvider`] — a [`StoreProvider`](crate::provider::StoreProvider)
//!   over a parsed index (`fetch` downloads `index-v1.json` behind the `live`
//!   feature; parsing itself is offline and unit-testable);
//! * [`catalog_to_fdroid_index_v1`] — the reverse: publish an Amos catalog *as*
//!   an F-Droid index (packages are emitted for `PackageFormat::Apk` entries; a
//!   web-bundle entry stays visible as an app row without a package, which an
//!   F-Droid client reports as incompatible — kept honest on purpose).
//!
//! # Honest boundaries
//!
//! * **Index authenticity**: F-Droid signs the index with the repo's PGP key
//!   (served as `index-v1.jar.asc`). Verifying that OpenPGP signature is **not**
//!   implemented; until it is, pin the index digest via
//!   [`FdroidRepoProvider::fetch`]'s `pinned_index_sha256` argument (sha256 of
//!   the raw JSON) when fetching over the network. The engine's per-package
//!   sha256 verification still applies to every downloaded APK.
//! * **Identities**: an app whose `packageName` is not a valid Amos slug
//!   (lowercase `[a-z0-9._-]`, see `crate::model::valid_id`) is **skipped, not
//!   renamed** — renaming would break the PackageInstaller hand-off.
//! * **Integrity**: packages whose `hash` is not a usable sha256 digest are
//!   skipped — a networked store never degrades to an unverified install.
//! * **Versions**: `versionName` is used when it parses as semver (a two-part
//!   name like `5.0` is padded to `5.0.0`); otherwise the version is derived
//!   monotonically from `versionCode` (base-1000 digit split), so upgrade
//!   ordering never breaks on creative upstream naming.
//! * **Install**: an F-Droid entry is a `PackageFormat::Apk`; the engine
//!   routes those to `AppStore::install_apk` (device PackageInstaller bridge).
//!   `download` (fetch + verify to disk) works anywhere; silent install needs
//!   the device/priv-app seam (`crate::android`), exactly as `docs/appstore.md`
//!   records.
//! * **Bounded bodies**: every live download (index, catalog, or package) is
//!   capped (`http::MAX_BODY_BYTES`, `live`-only) and fails closed past the cap,
//!   so a server that streams forever cannot exhaust memory *before* the sha256
//!   check would have run.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::{Result, StoreError};
use crate::model::{
    valid_id, AppCategory, AppManifest, Checksum, PackageFormat, PackageRef, Version,
};
use crate::provider::StoreProvider;

/// The official F-Droid repository base URL. The index lives at
/// `<repo>/index-v1.json`; packages at `<repo>/<apkName>`.
pub const F_DROID_OFFICIAL_REPO: &str = "https://f-droid.org/repo";

// ---------------------------------------------------------------------------
// index-v1 serde model (the F-Droid wire format)
// ---------------------------------------------------------------------------

/// Lenient numeric deserializers: the official F-Droid index quotes several
/// numeric fields as JSON strings (`"suggestedVersionCode": "1010200"`), while
/// other repos emit them as bare numbers. Accept both; a value that is neither
/// parses as `None` rather than poisoning the whole index.
mod flex {
    use super::FdroidPackage;
    use serde::{Deserialize, Deserializer};

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Num {
        I(i64),
        U(u64),
        S(String),
    }

    pub(crate) fn opt_i64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
        match Option::<Num>::deserialize(d)? {
            None => Ok(None),
            Some(Num::I(n)) => Ok(Some(n)),
            Some(Num::U(n)) => Ok(Some(n.min(i64::MAX as u64) as i64)),
            Some(Num::S(s)) => Ok(s.trim().parse::<i64>().ok()),
        }
    }

    /// Like [`opt_i64`] for non-optional fields: anything unparsable is 0.
    pub(crate) fn i64_or_zero<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
        Ok(opt_i64(d)?.unwrap_or(0))
    }

    pub(crate) fn opt_u64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
        match Option::<Num>::deserialize(d)? {
            None => Ok(None),
            // A negative declared size is **not** "0 bytes": rendering that would
            // be a *fabricated measurement*. Unknown (`None`) is the honest answer
            // — the same rule `InstalledEntry` states for the UI ("unknown", never
            // a made-up `0 B`).
            Some(Num::I(n)) => Ok(u64::try_from(n).ok()),
            Some(Num::U(n)) => Ok(Some(n)),
            Some(Num::S(s)) => Ok(s.trim().parse::<u64>().ok()),
        }
    }

    /// `packages` in both wire shapes: the official f-droid.org index groups
    /// each app's builds under its package name (an object), smaller repos
    /// often emit one flat array. Both flatten to the same
    /// `Vec<FdroidPackage>`.
    pub(crate) fn packages<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Vec<FdroidPackage>, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Shape {
            Flat(Vec<FdroidPackage>),
            Grouped(std::collections::BTreeMap<String, Vec<FdroidPackage>>),
        }
        Ok(match Shape::deserialize(d)? {
            Shape::Flat(v) => v,
            // Grouped rows may omit the inner `packageName` (the object key
            // carries it), so backfill from the key when absent.
            Shape::Grouped(map) => map
                .into_iter()
                .flat_map(|(name, pkgs)| {
                    pkgs.into_iter().map(move |mut p| {
                        if p.package_name.is_empty() {
                            p.package_name = name.clone();
                        }
                        p
                    })
                })
                .collect(),
        })
    }
}

/// An F-Droid repository index (`index-v1.json`). Field names are camelCase on
/// the wire; unknown fields are ignored so newer repos still parse.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FdroidIndexV1 {
    /// Repo-level metadata (address, timestamp, …).
    #[serde(default)]
    pub repo: FdroidRepoMeta,
    /// One row per app (metadata that does not vary per package).
    #[serde(default)]
    pub apps: Vec<FdroidApp>,
    /// One row per published package (APK build) across all apps.
    #[serde(default, deserialize_with = "flex::packages")]
    pub packages: Vec<FdroidPackage>,
}

/// Repo-level metadata (`index.repo`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FdroidRepoMeta {
    /// Canonical base URL packages are resolved against.
    #[serde(default)]
    pub address: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Unix epoch seconds the index was generated at.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "flex::opt_i64"
    )]
    pub timestamp: Option<i64>,
    /// Client cache freshness window in seconds (F-Droid spells it `maxage`).
    #[serde(
        rename = "maxage",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "flex::opt_i64"
    )]
    pub maxage: Option<i64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "flex::opt_i64"
    )]
    pub version: Option<i64>,
}

/// Per-app metadata (`index.apps[i]`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FdroidApp {
    /// The Android package id — also the Amos catalog id (when it is a valid
    /// slug; see the module-level honesty notes).
    #[serde(default)]
    pub package_name: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_site: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_code: Option<String>,
    /// Repo-relative icon filename (served under `<repo>/icons/`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    /// SPDX license expression (carried in the model; the Amos manifest has no
    /// license field, so it is not mapped into [`AppManifest`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// The `versionCode` an F-Droid client would install. The official index
    /// ships this as a *string*; both spellings parse (see [`flex`]).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "flex::opt_i64"
    )]
    pub suggested_version_code: Option<i64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "flex::opt_i64"
    )]
    pub last_updated: Option<i64>,
    /// Author as some third-party repos spell it (`author` instead of
    /// `authorName`); the mapping falls back to it when `author_name` is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Risk tags at the app level (`KnownVuln`, `NSFW`, …). See
    /// [`FdroidRepoProvider::with_exclude_anti_features`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub anti_features: Vec<String>,
    /// Localized display metadata keyed by locale (`"en"`, `"zh-CN"`, …).
    /// Used as a fallback when the top-level text is missing or empty.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub localized: std::collections::BTreeMap<String, FdroidLocalized>,
}

/// Per-package metadata (`index.packages[i]`) — one published APK build.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FdroidPackage {
    #[serde(default)]
    pub package_name: String,
    /// Upstream's human version string (best-effort mapped; see module docs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_name: Option<String>,
    /// Android's monotonic build number — F-Droid's real ordering key.
    #[serde(default, deserialize_with = "flex::i64_or_zero")]
    pub version_code: i64,
    /// Filename under the repo root the APK downloads from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apk_name: Option<String>,
    /// Hex digest of the APK bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// Which algorithm `hash` uses (only `sha256` is consumable here).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash_type: Option<String>,
    /// APK size in bytes.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "flex::opt_u64"
    )]
    pub size: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "flex::opt_i64"
    )]
    pub min_sdk_version: Option<i64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "flex::opt_i64"
    )]
    pub target_sdk_version: Option<i64>,
    /// Hex signing-certificate digest (not verified here; see boundaries).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer: Option<String>,
    /// Risk tags the repo declares for this build (`KnownVuln`, `NSFW`, …).
    /// Carried through so consumers can filter; see
    /// [`FdroidRepoProvider::with_exclude_anti_features`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub anti_features: Vec<String>,
}

/// Per-locale display metadata (`index.apps[i].localized["<locale>"]`). Many
/// repos keep the rich text only here, not at the app level.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FdroidLocalized {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Repo-relative icon filename for this locale (served under `<repo>/icons/`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Release notes for the suggested version (`whatsNew` on the wire).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub whats_new: Option<String>,
}

impl FdroidPackage {
    /// This package's digest **iff** it is a well-formed sha256 value. A
    /// package without one is skipped by the catalog mapping — a networked
    /// store never installs without integrity.
    pub fn sha256_checksum(&self) -> Option<Checksum> {
        let hash = self.hash.as_deref()?;
        match self.hash_type.as_deref().map(str::trim) {
            // An absent **or blank** hashType with a 64-hex value is treated as
            // sha256 (the de-facto shape): some third-party repos emit
            // `"hashType": ""`, and dropping the whole app for that would lose a
            // package whose digest we can verify perfectly well. Any *other*
            // declared algorithm is still refused.
            None | Some("") => Checksum::sha256(hash).ok(),
            Some(t) if !t.eq_ignore_ascii_case("sha256") => None,
            _ => Checksum::sha256(hash).ok(),
        }
    }
}

// ---------------------------------------------------------------------------
// Mapping: F-Droid index  <->  Amos catalog
// ---------------------------------------------------------------------------

/// Join a repo base URL and a path segment into a download URL.
fn join_url(base: &str, seg: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        seg.trim_start_matches('/')
    )
}

/// The URL packages resolve against: the index's own `repo.address` when the
/// index carries one, else the fallback the caller supplied (e.g. the URL the
/// index was fetched from).
fn effective_base(index: &FdroidIndexV1, fallback: &str) -> String {
    if !index.repo.address.trim().is_empty() {
        index.repo.address.trim_end_matches('/').to_string()
    } else {
        fallback.trim().trim_end_matches('/').to_string()
    }
}

/// Map an F-Droid category onto the closest Amos store category. Lossy by
/// design: categories drive browsing only, never identity or integrity.
fn map_category(categories: &[String]) -> AppCategory {
    let first = categories.first().map(|s| s.trim().to_ascii_lowercase());
    match first.as_deref() {
        Some("games") => AppCategory::Games,
        Some("multimedia") | Some("graphics") => AppCategory::Media,
        Some("connectivity") | Some("internet") | Some("phone & sms") | Some("phone + sms") => {
            AppCategory::Communication
        }
        Some("science & education") => AppCategory::Education,
        Some("system") | Some("security") | Some("development") | Some("theming") => {
            AppCategory::System
        }
        Some("time") | Some("reading") | Some("writing") | Some("navigation") => {
            AppCategory::Productivity
        }
        Some("tools") | Some("money") => AppCategory::Tools,
        _ => AppCategory::Other,
    }
}

/// The closest F-Droid category for an Amos category (the export direction of
/// [`map_category`]). `Other` emits no category row rather than inventing one.
///
/// Every arm is chosen so export → import round-trips back to the same Amos
/// category: in particular `Tools` uses F-Droid's own `"Tools"` rather than
/// `"Development"`, which [`map_category`] would read back as `System`.
fn category_to_fdroid(c: AppCategory) -> Vec<String> {
    match c {
        AppCategory::Games => vec!["Games".into()],
        AppCategory::Media => vec!["Multimedia".into()],
        AppCategory::Communication => vec!["Internet".into()],
        AppCategory::Education => vec!["Science & Education".into()],
        AppCategory::System => vec!["System".into()],
        AppCategory::Productivity => vec!["Writing".into()],
        AppCategory::Tools => vec!["Tools".into()],
        AppCategory::Other => Vec::new(),
    }
}

/// Map a package's version onto the engine's [`Version`].
///
/// `versionName` wins when it parses as semver (two-part names like `5.0` are
/// padded to `5.0.0`). Otherwise the version is derived from `versionCode` by
/// a base-1000 digit split (`code = major·10⁶ + minor·10³ + patch`), which is
/// *strictly monotonic* in the code — so even apps with creative names keep
/// working upgrade ordering, at the cost of a synthetic display version.
fn map_version(version_name: Option<&str>, version_code: i64) -> Version {
    if let Some(name) = version_name {
        if let Ok(v) = Version::parse(name) {
            return v;
        }
        if name.matches('.').count() == 1 {
            if let Ok(v) = Version::parse(&format!("{name}.0")) {
                return v;
            }
        }
    }
    let code = version_code.max(0);
    Version::new(
        (code / 1_000_000) as u32,
        ((code / 1_000) % 1_000) as u32,
        (code % 1_000) as u32,
    )
}

/// The inverse, used when *exporting*: a synthetic `versionCode` for a semver,
/// with the same base-1000 split.
///
/// **Precondition**: the two directions are exact inverses only while `minor`
/// and `patch` stay below the base (1000). `1.1000.0` encodes to the same code as
/// `2.0.0`, because the digit carries — no `i64` encoding of three `u32`s in
/// base 1000 avoids that, so the limit is stated rather than hidden.
pub fn version_code_from(v: &Version) -> i64 {
    i64::from(v.major)
        .saturating_mul(1_000_000)
        .saturating_add(i64::from(v.minor).saturating_mul(1_000))
        .saturating_add(i64::from(v.patch))
}

/// Pick the package a client would install: the app's `suggestedVersionCode`
/// when present among the candidates, else the highest `versionCode`.
fn pick_package<'a>(
    packages: &[&'a FdroidPackage],
    suggested: Option<i64>,
) -> Option<&'a FdroidPackage> {
    if let Some(code) = suggested {
        if let Some(p) = packages.iter().copied().find(|p| p.version_code == code) {
            return Some(p);
        }
    }
    packages.iter().copied().max_by_key(|p| p.version_code)
}

/// Display fields with the [`FdroidApp`]'s `localized` fallback applied:
/// top-level values win; empty/missing ones are backfilled from
/// `localized.en`, then any `zh*` locale, then the first locale at all —
/// many repos keep the rich text only under `localized`.
fn effective_display(app: &FdroidApp) -> (String, String, String, Option<String>) {
    let from = |l: &FdroidLocalized| -> (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) {
        let nonempty = |s: &Option<String>| s.clone().filter(|v| !v.trim().is_empty());
        (
            nonempty(&l.name),
            nonempty(&l.summary),
            nonempty(&l.description),
            nonempty(&l.icon),
        )
    };
    let localized = app
        .localized
        .get("en")
        .or_else(|| {
            app.localized
                .iter()
                .find(|(k, _)| k.to_ascii_lowercase().starts_with("zh"))
                .map(|(_, l)| l)
        })
        .or_else(|| app.localized.values().next());
    let (ln, ls, ld, li) = localized.map(from).unwrap_or_default();
    let pick = |top: &str, loc: &Option<String>| {
        if top.trim().is_empty() {
            loc.clone().unwrap_or_default()
        } else {
            top.to_string()
        }
    };
    let icon = app.icon.clone().filter(|i| !i.trim().is_empty()).or(li);
    (
        pick(&app.name, &ln),
        pick(&app.summary, &ls),
        pick(&app.description, &ld),
        icon,
    )
}

/// Case-insensitive `any`-overlap between an entry's anti-features and the
/// provider's exclusion list.
fn excluded_by(tags: &[String], exclude: &[String]) -> bool {
    tags.iter()
        .any(|t| exclude.iter().any(|x| x.eq_ignore_ascii_case(t)))
}

/// Build the (at most one) [`AppManifest`] an index entry maps to, or `None`
/// when the entry cannot be represented honestly: invalid slug id, no package
/// with a usable sha256 digest, an anti-feature the provider excludes, or a
/// manifest that fails validation.
fn manifest_for_app(
    app: &FdroidApp,
    packages: &[FdroidPackage],
    base: &str,
    exclude_anti_features: &[String],
) -> Option<AppManifest> {
    if !valid_id(&app.package_name) {
        return None;
    }
    if excluded_by(&app.anti_features, exclude_anti_features) {
        return None;
    }
    let candidates: Vec<&FdroidPackage> = packages
        .iter()
        .filter(|p| p.package_name == app.package_name)
        .filter(|p| p.apk_name.as_deref().is_some_and(|a| !a.is_empty()))
        .filter(|p| p.sha256_checksum().is_some())
        .filter(|p| !excluded_by(&p.anti_features, exclude_anti_features))
        .collect();
    let pick = pick_package(&candidates, app.suggested_version_code)?;

    let apk_name = pick.apk_name.clone().unwrap_or_default();
    let (name, summary, description, icon) = effective_display(app);
    let manifest = AppManifest {
        id: app.package_name.clone(),
        name: if name.trim().is_empty() {
            app.package_name.clone()
        } else {
            name
        },
        summary,
        description,
        // Upstream frequently omits the author. An empty string means "unknown";
        // the literal `"F-Droid"` would be a **fabricated attribution** — F-Droid
        // is the *distributor*, not the app's author, and the UI renders this
        // field as the author. Unknown stays unknown.
        author: app
            .author_name
            .clone()
            .or_else(|| app.author.clone())
            .unwrap_or_default(),
        version: map_version(pick.version_name.as_deref(), pick.version_code),
        category: map_category(&app.categories),
        homepage: app
            .web_site
            .clone()
            .or_else(|| app.source_code.clone())
            .unwrap_or_default(),
        icon_url: icon_url_from(base, icon.as_deref()),
        package: PackageRef {
            format: PackageFormat::Apk,
            url: join_url(base, &apk_name),
            sha256: pick.sha256_checksum(),
            size_bytes: pick.size,
        },
        publisher: None,
    };
    // Belt and braces: the mapping above should only produce valid manifests,
    // but the engine's invariant is the one that counts.
    manifest.validate().ok()?;
    Some(manifest)
}

/// Convert an F-Droid index into the engine's catalog (one [`AppManifest`] per
/// representable app; skipped entries are documented at the module level).
/// No anti-feature filtering — use [`FdroidRepoProvider`] for that.
pub fn fdroid_index_to_catalog(index: &FdroidIndexV1, fallback_base_url: &str) -> Vec<AppManifest> {
    let base = effective_base(index, fallback_base_url);
    let mut out = Vec::new();
    for app in &index.apps {
        if let Some(mf) = manifest_for_app(app, &index.packages, &base, &[]) {
            out.push(mf);
        }
    }
    out
}

/// Resolve an F-Droid `app.icon` into a catalog URL.
///
/// The wire value is normally a **repo-relative filename** that clients fetch as
/// `<repo>/icons/<icon>`, so that is the shape we prefix. A repo that writes an
/// absolute URL instead is honored **as-is** — prefixing it would produce
/// `<repo>/icons/https://…`, a URL that cannot resolve.
fn icon_url_from(base: &str, icon: Option<&str>) -> String {
    let Some(icon) = icon.map(str::trim).filter(|i| !i.is_empty()) else {
        return String::new();
    };
    if icon.starts_with("http://") || icon.starts_with("https://") {
        icon.to_string()
    } else {
        join_url(base, &format!("icons/{icon}"))
    }
}

/// The F-Droid `icon` value for an exported row — a **repo-relative filename**,
/// the inverse of [`icon_url_from`]. F-Droid clients fetch `<repo>/icons/<icon>`,
/// so emitting our catalog's absolute `icon_url` would make every client (and
/// our own importer) request `<repo>/icons/https://…`.
///
/// Like `apkName`, this is a *reference only*: the exporter writes metadata, it
/// does not copy icon bytes into `<repo>/icons/` (same as it does not publish the
/// APK) — placing the artifacts is the maintainer's job.
fn icon_filename(icon_url: &str) -> Option<String> {
    let url = icon_url.trim().trim_end_matches('/');
    if url.is_empty() {
        return None;
    }
    let seg = url.rsplit('/').next().unwrap_or_default();
    (!seg.is_empty()).then(|| seg.to_string())
}

/// Filename an exported package row advertises: the URL's last segment when it
/// already looks like an APK, else a synthesized `<id>_<versionCode>.apk`.
fn apk_filename(m: &AppManifest) -> String {
    let url = m.package.url.trim_end_matches('/');
    let seg = url.rsplit('/').next().unwrap_or_default();
    if seg.ends_with(".apk") {
        seg.to_string()
    } else {
        format!("{}_{}.apk", m.id, version_code_from(&m.version))
    }
}

/// Export an Amos catalog **as** an F-Droid `index-v1` document — the "our
/// store speaks the F-Droid format" direction.
///
/// * every manifest gets an `apps` row (name/summary/description/author/site/
///   icon/categories survive);
/// * only `PackageFormat::Apk` manifests get a `packages` row (with the sha256
///   digest and a base-1000 `versionCode` synthesized from the semver); a
///   web-bundle entry stays visible as an app without a package, which an
///   F-Droid client reports as incompatible — honest, not hidden.
pub fn catalog_to_fdroid_index_v1(apps: &[AppManifest], repo_address: &str) -> FdroidIndexV1 {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut index = FdroidIndexV1 {
        repo: FdroidRepoMeta {
            address: repo_address.to_string(),
            timestamp: Some(timestamp),
            ..FdroidRepoMeta::default()
        },
        apps: Vec::with_capacity(apps.len()),
        packages: Vec::with_capacity(apps.len()),
    };
    for m in apps {
        let is_apk = m.package.format == PackageFormat::Apk;
        index.apps.push(FdroidApp {
            package_name: m.id.clone(),
            name: m.name.clone(),
            summary: m.summary.clone(),
            description: m.description.clone(),
            author_name: (!m.author.is_empty()).then(|| m.author.clone()),
            web_site: (!m.homepage.is_empty()).then(|| m.homepage.clone()),
            source_code: None,
            icon: icon_filename(&m.icon_url),
            categories: category_to_fdroid(m.category),
            license: None,
            // Point F-Droid clients at exactly the build our semver names.
            suggested_version_code: is_apk.then(|| version_code_from(&m.version)),
            last_updated: Some(timestamp),
            ..FdroidApp::default()
        });
        if is_apk {
            index.packages.push(FdroidPackage {
                package_name: m.id.clone(),
                version_name: Some(m.version.to_string()),
                version_code: version_code_from(&m.version),
                apk_name: Some(apk_filename(m)),
                hash: m.package.sha256.as_ref().map(|c| c.value.clone()),
                hash_type: m.package.sha256.as_ref().map(|_| "sha256".to_string()),
                size: m.package.size_bytes,
                min_sdk_version: None,
                target_sdk_version: None,
                signer: None,
                ..FdroidPackage::default()
            });
        }
    }
    index
}

// ---------------------------------------------------------------------------
// FdroidRepoProvider — a StoreProvider over a parsed index
// ---------------------------------------------------------------------------

/// A [`StoreProvider`] backed by a parsed F-Droid `index-v1.json` document.
///
/// ```text
/// [ GET <repo>/index-v1.json ]  ->  FdroidIndexV1  ->  Vec<AppManifest>
/// [ GET <repo>/<apkName> ]      ->  APK bytes (sha256-verified by the engine)
/// ```
///
/// Parsing is offline ([`Self::from_index_bytes`]); networked fetch lives
/// behind the `live` feature ([`Self::fetch`]) and reuses the same
/// `spawn_blocking` + `ureq` helpers as [`crate::http::HttpStoreProvider`].
#[derive(Clone, Debug)]
pub struct FdroidRepoProvider {
    index: Arc<FdroidIndexV1>,
    base_url: String,
    timeout_secs: u64,
    exclude_anti_features: Vec<String>,
}

impl FdroidRepoProvider {
    /// Per-request timeout for package (APK) downloads.
    pub const DEFAULT_PACKAGE_TIMEOUT_SECS: u64 = 60;

    /// Timeout for downloading the index itself. Generous on purpose: the
    /// official F-Droid `index-v1.json` is tens of megabytes.
    pub const DEFAULT_INDEX_TIMEOUT_SECS: u64 = 300;

    /// Parse an index document from raw JSON bytes (offline). Package URLs
    /// resolve against the index's own `repo.address`, falling back to
    /// `fallback_base_url` (typically the URL the index came from).
    pub fn from_index_bytes(
        index_json: &[u8],
        fallback_base_url: impl Into<String>,
    ) -> Result<Self> {
        let index: FdroidIndexV1 = serde_json::from_slice(index_json)
            .map_err(|e| StoreError::Provider(format!("parse F-Droid index-v1.json: {e}")))?;
        Self::from_index(index, fallback_base_url)
    }

    /// Build from an already-parsed index (see [`Self::from_index_bytes`]).
    pub fn from_index(index: FdroidIndexV1, fallback_base_url: impl Into<String>) -> Result<Self> {
        let fallback = fallback_base_url.into();
        let base = effective_base(&index, &fallback);
        if base.is_empty() {
            return Err(StoreError::Provider(
                "F-Droid repo base URL is empty: pass a repo URL or publish \"repo.address\" in the index"
                    .into(),
            ));
        }
        Ok(Self {
            index: Arc::new(index),
            base_url: base,
            timeout_secs: Self::DEFAULT_PACKAGE_TIMEOUT_SECS,
            exclude_anti_features: Vec::new(),
        })
    }

    /// Override the per-request package-download timeout (default 60 s).
    pub fn with_timeout(mut self, secs: u64) -> Self {
        self.timeout_secs = secs.max(1);
        self
    }

    /// Drop catalog entries tagged with any of these repo anti-features
    /// (case-insensitive; e.g. `["KnownVuln"]`, `["NSFW", "KnownVuln"]`).
    /// The default is to keep every entry the repo publishes — filtering is
    /// a policy choice, made explicit here and never silently.
    pub fn with_exclude_anti_features(mut self, tags: &[&str]) -> Self {
        self.exclude_anti_features = tags.iter().map(|t| (*t).to_string()).collect();
        self
    }

    /// The parsed index (for diagnostics / UI).
    pub fn index(&self) -> &FdroidIndexV1 {
        &self.index
    }

    /// The base URL packages resolve against.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Download + parse a repo's `index-v1.json` over HTTP (`live` builds).
    ///
    /// `pinned_index_sha256` (hex) is refused on mismatch — and because a pin
    /// must see the exact wire bytes, pinned fetches buffer the body first;
    /// unpinned fetches parse it streaming off the response (the official
    /// index is tens of MB; see [`crate::http::fetch_json_async`]).
    /// F-Droid's own authenticity mechanism is the repo's PGP signature over
    /// the index; verifying that is not implemented yet, so treat the pin as
    /// the integrity story until OpenPGP support lands.
    #[cfg(feature = "live")]
    pub async fn fetch(
        repo_base_url: &str,
        timeout_secs: u64,
        pinned_index_sha256: Option<&str>,
    ) -> Result<Self> {
        let url = join_url(repo_base_url, "index-v1.json");
        let index = match pinned_index_sha256 {
            Some(pin) => {
                let bytes = crate::http::fetch_async(url.clone(), timeout_secs).await?;
                let pin = Checksum::sha256(pin)?;
                if !pin.verify(&bytes) {
                    return Err(StoreError::Provider(format!(
                        "F-Droid index digest mismatch: expected {}, got {}",
                        pin.value,
                        Checksum::sha256_hex(&bytes)
                    )));
                }
                serde_json::from_slice(&bytes).map_err(|e| {
                    StoreError::Provider(format!("parse F-Droid index-v1.json: {e}"))
                })?
            }
            None => crate::http::fetch_json_async::<FdroidIndexV1>(url.clone(), timeout_secs)
                .await
                .map_err(|e| {
                    StoreError::Provider(format!("loading F-Droid index-v1.json from {url}: {e}"))
                })?,
        };
        Self::from_index(index, repo_base_url)
    }
}

#[async_trait]
impl StoreProvider for FdroidRepoProvider {
    fn name(&self) -> &'static str {
        "fdroid-repo"
    }

    async fn catalog(&self) -> Result<Vec<AppManifest>> {
        let base = effective_base(&self.index, &self.base_url);
        let mut out = Vec::new();
        for app in &self.index.apps {
            if let Some(mf) = manifest_for_app(
                app,
                &self.index.packages,
                &base,
                &self.exclude_anti_features,
            ) {
                out.push(mf);
            }
        }
        Ok(out)
    }

    async fn fetch_package(&self, manifest: &AppManifest) -> Result<Vec<u8>> {
        #[cfg(feature = "live")]
        {
            crate::http::fetch_async(manifest.package.url.clone(), self.timeout_secs).await
        }
        #[cfg(not(feature = "live"))]
        {
            let _ = manifest;
            Err(StoreError::Provider(
                "fdroid-repo package download requires building with --features live".into(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::AppStore;

    fn hex(data: &[u8]) -> String {
        Checksum::sha256_hex(data)
    }

    /// A realistic minimal `index-v1.json` (camelCase, real digests) exercising
    /// every documented mapping rule.
    fn fixture() -> String {
        let h1 = hex(b"apk one v1");
        let h2 = hex(b"apk one v2");
        let h4 = hex(b"apk shared bytes");
        format!(
            r#"{{
  "repo": {{"address": "https://example.fdroid/repo", "timestamp": 1726100000, "maxage": 86400, "version": 3}},
  "apps": [
    {{"packageName": "org.example.one", "name": "One", "summary": "first app", "description": "long desc",
      "authorName": "Ex Dev", "webSite": "https://ex.dev", "icon": "org.example.one.2.png",
      "categories": ["Multimedia"], "suggestedVersionCode": 2, "license": "MIT", "lastUpdated": 1726000000}},
    {{"packageName": "org.example.two", "name": "Two", "summary": "second app", "categories": ["Games"],
      "sourceCode": "https://git.ex/two"}},
    {{"packageName": "org.example.two-part", "name": "TwoPart", "summary": "a 5.0 release", "categories": ["Tools"]}},
    {{"packageName": "org.example.creative", "name": "Creative", "summary": "unparseable version name"}},
    {{"packageName": "org.example.md5only", "name": "Md5Only", "summary": "digest we cannot honor"}},
    {{"packageName": "Org.Example.Bad", "name": "Bad id", "summary": "uppercase package id"}}
  ],
  "packages": [
    {{"packageName": "org.example.one", "versionName": "1.0", "versionCode": 1, "apkName": "org.example.one_1.apk",
      "hash": "{h1}", "hashType": "sha256", "size": 11}},
    {{"packageName": "org.example.one", "versionName": "2.0", "versionCode": 2, "apkName": "org.example.one_2.apk",
      "hash": "{h2}", "hashType": "sha256", "size": 12}},
    {{"packageName": "org.example.one", "versionName": "3.0", "versionCode": 3, "apkName": "org.example.one_3.apk",
      "hash": "abcd", "hashType": "md5", "size": 13}},
    {{"packageName": "org.example.two", "versionName": "0.1.2", "versionCode": 12, "apkName": "org.example.two_12.apk",
      "hash": "{h4}", "hashType": "sha256"}},
    {{"packageName": "org.example.two-part", "versionName": "5.0", "versionCode": 500,
      "apkName": "org.example.two-part_500.apk", "hash": "{h4}", "hashType": "sha256"}},
    {{"packageName": "org.example.creative", "versionName": "cyanogen-9", "versionCode": 4030201,
      "apkName": "org.example.creative_4030201.apk", "hash": "{h4}", "hashType": "sha256"}},
    {{"packageName": "org.example.md5only", "versionName": "1.0.0", "versionCode": 1,
      "apkName": "org.example.md5only_1.apk", "hash": "abcd", "hashType": "md5"}}
  ]
}}"#
        )
    }

    fn provider() -> FdroidRepoProvider {
        FdroidRepoProvider::from_index_bytes(fixture().as_bytes(), "").unwrap()
    }

    #[tokio::test]
    async fn maps_the_suggested_package_with_full_metadata() {
        let store = AppStore::new(provider());
        let mf = store
            .find("org.example.one")
            .await
            .unwrap()
            .expect("cataloged");
        assert_eq!(mf.version.to_string(), "2.0.0", "suggestedVersionCode wins");
        assert_eq!(
            mf.package.url,
            "https://example.fdroid/repo/org.example.one_2.apk"
        );
        assert_eq!(mf.package.format, PackageFormat::Apk);
        assert_eq!(mf.package.size_bytes, Some(12));
        let cs = mf.package.sha256.as_ref().unwrap();
        assert!(cs.verify(b"apk one v2"), "index digest travels intact");
        assert_eq!(mf.category, AppCategory::Media);
        assert_eq!(mf.author, "Ex Dev");
        assert_eq!(mf.homepage, "https://ex.dev");
        assert_eq!(
            mf.icon_url,
            "https://example.fdroid/repo/icons/org.example.one.2.png"
        );
    }

    #[tokio::test]
    async fn unhonest_entries_are_skipped_not_renamed() {
        let cat = provider().catalog().await.unwrap();
        let ids: Vec<&str> = cat.iter().map(|m| m.id.as_str()).collect();
        // two-part + creative survive; md5-only (no usable digest) and the
        // uppercase id (would break PackageInstaller) do not.
        assert_eq!(
            ids,
            vec![
                "org.example.one",
                "org.example.two",
                "org.example.two-part",
                "org.example.creative"
            ]
        );
    }

    #[tokio::test]
    async fn version_name_shapes_map_as_documented() {
        let store = AppStore::new(provider());
        let two = store.find("org.example.two").await.unwrap().unwrap();
        assert_eq!(two.version.to_string(), "0.1.2", "plain semver as-is");

        let two_part = store.find("org.example.two-part").await.unwrap().unwrap();
        assert_eq!(two_part.version.to_string(), "5.0.0", "5.0 padded to 5.0.0");

        let creative = store.find("org.example.creative").await.unwrap().unwrap();
        assert_eq!(
            creative.version.to_string(),
            "4.30.201",
            "versionCode base-1000 split"
        );
        // And the fallback stays monotonic, so upgrades keep working:
        assert!(map_version(Some("cyanogen-9"), 4030205) > creative.version);
    }

    #[test]
    fn version_code_round_trips_while_each_digit_stays_below_1000() {
        // `version_code_from` / `map_version` are exact inverses only while
        // `minor` and `patch` stay below the base (1000) — past that the digits
        // carry. Both doc comments state the precondition; it is pinned here so it
        // cannot drift into a silently-wrong claim again.
        for v in [
            Version::new(0, 0, 0),
            Version::new(1, 2, 3),
            Version::new(999, 999, 999),
        ] {
            assert_eq!(
                map_version(None, version_code_from(&v)),
                v,
                "{v} must round-trip"
            );
        }
        assert_eq!(
            map_version(None, version_code_from(&Version::new(1, 1000, 0))),
            Version::new(2, 0, 0),
            ">=1000 carries into the next digit — the documented boundary"
        );
    }

    #[test]
    fn package_without_usable_sha256_is_refused() {
        let p = FdroidPackage {
            hash: Some("abcd".into()),
            hash_type: Some("md5".into()),
            ..FdroidPackage::default()
        };
        assert!(p.sha256_checksum().is_none(), "md5 is not consumable");
        let implicit = FdroidPackage {
            hash: Some(hex(b"x")),
            hash_type: None,
            ..FdroidPackage::default()
        };
        assert!(
            implicit.sha256_checksum().is_some(),
            "64-hex assumed sha256"
        );
    }

    #[tokio::test]
    async fn a_negative_declared_size_is_unknown_not_zero() {
        // `size: -1` used to become `Some(0)` — a *fabricated* "0 bytes" the UI
        // would render as a confident measurement. Unknown is the honest answer
        // (the same rule `InstalledEntry` states).
        let h = hex(b"apk bytes");
        let json = format!(
            r#"{{"repo": {{"address": "https://r"}},
                "apps": [{{"packageName": "org.ex.neg", "name": "Neg"}},
                         {{"packageName": "org.ex.pos", "name": "Pos"}}],
                "packages": [
                  {{"packageName": "org.ex.neg", "versionName": "1.0", "versionCode": 1,
                    "apkName": "n.apk", "hash": "{h}", "hashType": "sha256", "size": -1}},
                  {{"packageName": "org.ex.pos", "versionName": "1.0", "versionCode": 1,
                    "apkName": "p.apk", "hash": "{h}", "hashType": "sha256", "size": 42}}
                ]}}"#
        );
        let index: FdroidIndexV1 = serde_json::from_str(&json).unwrap();
        let neg = index
            .packages
            .iter()
            .find(|p| p.package_name == "org.ex.neg")
            .unwrap();
        assert_eq!(neg.size, None, "a negative size is unknown, not 0 bytes");
        let pos = index
            .packages
            .iter()
            .find(|p| p.package_name == "org.ex.pos")
            .unwrap();
        assert_eq!(pos.size, Some(42), "a real size still round-trips");

        // ... and the mapping that the UI reads must not invent a size either.
        let cat = fdroid_index_to_catalog(&index, "");
        let m = cat.iter().find(|m| m.id == "org.ex.neg").unwrap();
        assert_eq!(m.package.size_bytes, None);
    }

    #[test]
    fn a_blank_hash_type_is_absent_not_an_unknown_algorithm() {
        // Some third-party repos emit `"hashType": ""`. Dropping the app for that
        // would lose a package whose 64-hex digest we can verify perfectly well.
        let blank = FdroidPackage {
            hash: Some(hex(b"x")),
            hash_type: Some("   ".into()),
            ..FdroidPackage::default()
        };
        assert!(
            blank.sha256_checksum().is_some(),
            "blank hashType falls back to the de-facto sha256 shape"
        );

        // A *declared* other algorithm is still refused — leniency must not become
        // a weaker integrity rule.
        let sha1 = FdroidPackage {
            hash: Some("a".repeat(40)),
            hash_type: Some("sha1".into()),
            ..FdroidPackage::default()
        };
        assert!(sha1.sha256_checksum().is_none(), "sha1 stays refused");
    }

    #[tokio::test]
    async fn engine_refuses_web_install_of_an_fdroid_entry() {
        let store = AppStore::new(provider());
        let err = store.install("org.example.one").await.unwrap_err();
        assert!(
            err.to_string().contains("install_apk"),
            "honest APK routing message, got: {err}"
        );
        assert!(!store.is_installed("org.example.one").unwrap());
    }

    #[tokio::test]
    async fn export_round_trips_through_the_fdroid_shape() {
        let apk = AppManifest {
            id: "org.amos.exported".into(),
            name: "Exported".into(),
            summary: "an apk app".into(),
            description: String::new(),
            author: "Amos Labs".into(),
            version: Version::new(1, 2, 3),
            category: AppCategory::Tools,
            homepage: "https://amos.dev".into(),
            icon_url: String::new(),
            package: PackageRef {
                format: PackageFormat::Apk,
                url: "https://cdn.amos.dev/org.amos.exported_1020300.apk".into(),
                sha256: Some(Checksum::sha256(hex(b"exported apk bytes")).unwrap()),
                size_bytes: Some(1234),
            },
            publisher: None,
        };
        let web = AppManifest {
            id: "org.amos.webby".into(),
            name: "Webby".into(),
            summary: "a web-bundle app".into(),
            description: String::new(),
            author: "Amos Labs".into(),
            version: Version::new(0, 1, 0),
            category: AppCategory::Productivity,
            homepage: String::new(),
            icon_url: String::new(),
            package: PackageRef {
                format: PackageFormat::TarGz,
                url: "https://cdn.amos.dev/org.amos.webby.tgz".into(),
                sha256: None,
                size_bytes: None,
            },
            publisher: None,
        };

        let index = catalog_to_fdroid_index_v1(&[apk, web], "https://store.amos.dev/repo");
        assert_eq!(index.apps.len(), 2, "both rows visible");
        assert_eq!(index.packages.len(), 1, "only the APK emits a package");
        assert_eq!(
            index.packages[0].version_code,
            version_code_from(&Version::new(1, 2, 3))
        );
        assert_eq!(index.packages[0].hash_type.as_deref(), Some("sha256"));
        assert_eq!(
            index.apps[0].suggested_version_code,
            Some(version_code_from(&Version::new(1, 2, 3))),
            "export points F-Droid clients at our semver build"
        );
        assert_eq!(
            index.apps[1].suggested_version_code, None,
            "package-less rows advertise no build"
        );

        // The exported document parses back as a genuine F-Droid index and the
        // APK entry survives verbatim.
        let json = serde_json::to_string(&index).unwrap();
        let back =
            FdroidRepoProvider::from_index_bytes(json.as_bytes(), "https://elsewhere/").unwrap();
        assert_eq!(back.base_url(), "https://store.amos.dev/repo");
        let cat = back.catalog().await.unwrap();
        assert_eq!(cat.len(), 1, "web row has no package → not installable");
        assert_eq!(cat[0].id, "org.amos.exported");
        assert_eq!(cat[0].version.to_string(), "1.2.3");
        assert_eq!(cat[0].author, "Amos Labs");
        assert_eq!(
            cat[0].package.sha256.as_ref().unwrap().value,
            hex(b"exported apk bytes")
        );
        assert_eq!(cat[0].package.size_bytes, Some(1234));
    }
    #[tokio::test]
    async fn export_round_trips_the_icon_without_double_prefixing() {
        // F-Droid's `app.icon` is a **repo-relative filename** (`<repo>/icons/<icon>`),
        // so an import turns it into an absolute catalog URL...
        let h = hex(b"apk bytes");
        let json = format!(
            r#"{{"repo": {{"address": "https://r/repo"}},
                "apps": [{{"packageName": "org.ex.icon", "name": "Icon", "icon": "org.ex.icon.1.png"}}],
                "packages": [{{"packageName": "org.ex.icon", "versionName": "1.0", "versionCode": 1,
                  "apkName": "i_1.apk", "hash": "{h}", "hashType": "sha256"}}]}}"#
        );
        let p = FdroidRepoProvider::from_index_bytes(json.as_bytes(), "").unwrap();
        let cat = p.catalog().await.unwrap();
        assert_eq!(cat[0].icon_url, "https://r/repo/icons/org.ex.icon.1.png");

        // ... and exporting must put the *filename* back, not the absolute URL
        // (a client/our own importer would otherwise fetch `<repo>/icons/https://…`).
        let index = catalog_to_fdroid_index_v1(&cat, "https://r/repo");
        assert_eq!(
            index.apps[0].icon.as_deref(),
            Some("org.ex.icon.1.png"),
            "exported icon must stay repo-relative"
        );

        // Re-importing our own export must therefore be a fixed point.
        let json2 = serde_json::to_vec(&index).unwrap();
        let p2 = FdroidRepoProvider::from_index_bytes(&json2, "").unwrap();
        let cat2 = p2.catalog().await.unwrap();
        assert_eq!(
            cat2[0].icon_url, "https://r/repo/icons/org.ex.icon.1.png",
            "re-importing our export must not double-prefix the icon URL"
        );
    }

    #[test]
    fn missing_repo_address_is_a_clean_error() {
        let err = FdroidRepoProvider::from_index_bytes(br#"{"apps":[]}"#, "   ").unwrap_err();
        assert!(err.to_string().contains("base URL"), "{err}");
    }

    #[tokio::test]
    async fn official_packages_dict_shape_parses_too() {
        // f-droid.org groups builds per app in an object; the flat array shape
        // (the fixture above) is the third-party variant. Both must map alike.
        let h = hex(b"apk bytes");
        let json = format!(
            r#"{{"repo": {{"address": "https://r/"}},
                "apps": [{{"packageName": "org.ex.grouped", "name": "G"}}],
                "packages": {{"org.ex.grouped": [
                    {{"packageName": "org.ex.grouped", "versionName": "1.0", "versionCode": 1,
                      "apkName": "g_1.apk", "hash": "{h}", "hashType": "sha256"}},
                    {{"versionName": "2.0", "versionCode": 2,
                      "apkName": "g_2.apk", "hash": "{h}", "hashType": "sha256"}}
                ]}}}}"#
        );
        let p = FdroidRepoProvider::from_index_bytes(json.as_bytes(), "").unwrap();
        let cat = p.catalog().await.unwrap();
        assert_eq!(cat.len(), 1);
        assert_eq!(cat[0].id, "org.ex.grouped");
        assert_eq!(
            cat[0].version.to_string(),
            "2.0.0",
            "highest versionCode wins"
        );
        assert_eq!(cat[0].package.url, "https://r/g_2.apk");
    }

    #[tokio::test]
    async fn localized_metadata_backfills_display_fields() {
        // Top-level text wins when present; otherwise en, then zh*, then the
        // first locale — the shape many real repos actually publish. Built via
        // Serialize so the (camelCase) export shape feeds the same parser the
        // wire uses.
        let h = hex(b"apk bytes");
        let app_en = FdroidApp {
            package_name: "org.ex.en".into(),
            localized: [
                (
                    "de".into(),
                    FdroidLocalized {
                        name: Some("Nur Deutsch".into()),
                        summary: Some("deutsch".into()),
                        ..FdroidLocalized::default()
                    },
                ),
                (
                    "en".into(),
                    FdroidLocalized {
                        name: Some("English Name".into()),
                        summary: Some("english text".into()),
                        description: Some("english description".into()),
                        icon: Some("en.png".into()),
                        ..FdroidLocalized::default()
                    },
                ),
            ]
            .into_iter()
            .collect(),
            ..FdroidApp::default()
        };
        let app_zh = FdroidApp {
            package_name: "org.ex.zh".into(),
            localized: [
                (
                    "fr".into(),
                    FdroidLocalized {
                        name: Some("Nom".into()),
                        summary: Some("français".into()),
                        ..FdroidLocalized::default()
                    },
                ),
                (
                    "zh-CN".into(),
                    FdroidLocalized {
                        summary: Some("中文摘要".into()),
                        ..FdroidLocalized::default()
                    },
                ),
            ]
            .into_iter()
            .collect(),
            ..FdroidApp::default()
        };
        let pkg = |id: &str, apk: &str| FdroidPackage {
            package_name: id.into(),
            version_name: Some("1.0".into()),
            version_code: 1,
            apk_name: Some(apk.into()),
            hash: Some(h.clone()),
            hash_type: Some("sha256".into()),
            ..FdroidPackage::default()
        };
        let index = FdroidIndexV1 {
            repo: FdroidRepoMeta {
                address: "https://r".into(),
                ..FdroidRepoMeta::default()
            },
            apps: vec![app_en, app_zh],
            packages: vec![pkg("org.ex.en", "en.apk"), pkg("org.ex.zh", "zh.apk")],
        };
        let json = serde_json::to_vec(&index).unwrap();
        let p = FdroidRepoProvider::from_index_bytes(&json, "").unwrap();
        let cat = p.catalog().await.unwrap();
        assert_eq!(cat.len(), 2);
        let en = cat.iter().find(|m| m.id == "org.ex.en").unwrap();
        assert_eq!(en.name, "English Name");
        assert_eq!(en.summary, "english text");
        assert_eq!(en.description, "english description");
        assert_eq!(en.icon_url, "https://r/icons/en.png");
        let zh = cat.iter().find(|m| m.id == "org.ex.zh").unwrap();
        assert_eq!(
            zh.summary, "中文摘要",
            "zh locales beat the first locale in the map"
        );
    }

    #[tokio::test]
    async fn anti_features_are_filtered_only_when_configured() {
        let h = hex(b"apk bytes");
        let pkg = |vc: i64, apk: &str, anti: &[&str]| FdroidPackage {
            package_name: "org.ex.builds".into(),
            version_name: Some(format!("{vc}.0")),
            version_code: vc,
            apk_name: Some(apk.into()),
            hash: Some(h.clone()),
            hash_type: Some("sha256".into()),
            anti_features: anti.iter().map(|t| (*t).to_string()).collect(),
            ..FdroidPackage::default()
        };
        let index = FdroidIndexV1 {
            repo: FdroidRepoMeta {
                address: "https://r".into(),
                ..FdroidRepoMeta::default()
            },
            apps: vec![
                FdroidApp {
                    package_name: "org.ex.risky".into(),
                    name: "Risky".into(),
                    summary: "app-level tag".into(),
                    anti_features: vec!["KnownVuln".into()],
                    ..FdroidApp::default()
                },
                FdroidApp {
                    package_name: "org.ex.builds".into(),
                    name: "Builds".into(),
                    summary: "tag on one build".into(),
                    ..FdroidApp::default()
                },
            ],
            packages: vec![pkg(1, "b_1.apk", &[]), pkg(2, "b_2.apk", &["KnownVuln"])],
        };
        let json = serde_json::to_vec(&index).unwrap();

        // Default: nothing is hidden — filtering is an explicit policy.
        let open = FdroidRepoProvider::from_index_bytes(&json, "").unwrap();
        let cat = open.catalog().await.unwrap();
        assert_eq!(
            cat.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["org.ex.builds"],
            "risky app kept by default"
        );
        assert_eq!(
            cat[0].version.to_string(),
            "2.0.0",
            "tagged build still wins by versionCode by default"
        );

        // With the policy: the tagged app disappears, and the tagged *build*
        // is skipped in favour of the highest clean one.
        let filtered = FdroidRepoProvider::from_index_bytes(&json, "")
            .unwrap()
            .with_exclude_anti_features(&["knownvuln"]);
        let cat = filtered.catalog().await.unwrap();
        assert_eq!(cat.len(), 1, "app-level KnownVuln dropped");
        assert_eq!(cat[0].id, "org.ex.builds");
        assert_eq!(
            cat[0].version.to_string(),
            "1.0.0",
            "tagged build skipped; highest clean build mapped"
        );
        assert_eq!(cat[0].package.url, "https://r/b_1.apk");
    }

    #[tokio::test]
    async fn a_missing_author_stays_unknown_instead_of_being_attributed_to_the_repo() {
        // Upstream omits the author often. Filling in "F-Droid" would put the
        // *distributor* in a field the UI renders as the app's author.
        let h = hex(b"apk bytes");
        let json = format!(
            r#"{{"repo": {{"address": "https://r"}},
                "apps": [{{"packageName": "org.ex.anon", "name": "Anon"}}],
                "packages": [{{"packageName": "org.ex.anon", "versionName": "1.0", "versionCode": 1,
                  "apkName": "a.apk", "hash": "{h}", "hashType": "sha256"}}]}}"#
        );
        let p = FdroidRepoProvider::from_index_bytes(json.as_bytes(), "").unwrap();
        let cat = p.catalog().await.unwrap();
        assert_eq!(
            cat[0].author, "",
            "an unknown author must stay unknown, not become the repository's name"
        );
    }

    #[tokio::test]
    async fn author_field_is_a_fallback_for_author_name() {
        let h = hex(b"apk bytes");
        let json = format!(
            r#"{{"repo": {{"address": "https://r/"}},
                "apps": [{{"packageName": "org.ex.a", "name": "A", "summary": "s",
                          "author": "Plain Author"}}],
                "packages": [{{"packageName": "org.ex.a", "versionName": "1.0", "versionCode": 1,
                              "apkName": "a.apk", "hash": "{h}", "hashType": "sha256"}}]}}"#
        );
        let p = FdroidRepoProvider::from_index_bytes(json.as_bytes(), "").unwrap();
        let mut cat = p.catalog().await.unwrap();
        assert_eq!(cat.remove(0).author, "Plain Author");
    }

    #[tokio::test]
    async fn category_mapping_covers_the_official_set() {
        let mf = |cats: &[&str], id: &str| -> Option<AppManifest> {
            let h = hex(b"apk bytes");
            let app = FdroidApp {
                package_name: id.into(),
                name: id.into(),
                summary: "s".into(),
                categories: cats.iter().map(|c| (*c).to_string()).collect(),
                ..FdroidApp::default()
            };
            let pkg = FdroidPackage {
                package_name: id.into(),
                version_name: Some("1.0.0".into()),
                version_code: 1,
                apk_name: Some("a.apk".into()),
                hash: Some(h),
                hash_type: Some("sha256".into()),
                ..FdroidPackage::default()
            };
            manifest_for_app(&app, &[pkg], "https://r", &[])
        };
        assert_eq!(
            mf(&["Theming"], "org.ex.t1").unwrap().category,
            AppCategory::System
        );
        assert_eq!(
            mf(&["Money"], "org.ex.t2").unwrap().category,
            AppCategory::Tools
        );
        assert_eq!(
            mf(&["Sports & Health"], "org.ex.t3").unwrap().category,
            AppCategory::Other,
            "unmapped categories stay honest instead of being guessed"
        );
    }

    #[tokio::test]
    async fn category_export_round_trips_for_every_variant() {
        // The export direction must be the inverse of the import table: every
        // Amos category survives export → import unchanged. Without this, a
        // published catalog would drift category on a round-trip through an
        // F-Droid client (the old Tools → "Development" → System bug).
        let all = [
            AppCategory::Other,
            AppCategory::Tools,
            AppCategory::Media,
            AppCategory::Communication,
            AppCategory::Games,
            AppCategory::Productivity,
            AppCategory::Education,
            AppCategory::System,
        ];
        for (i, c) in all.iter().enumerate() {
            let id = format!("org.ex.cat{i}");
            let manifest = AppManifest {
                id: id.clone(),
                name: format!("Cat {i}"),
                summary: "s".into(),
                description: String::new(),
                author: "Amos".into(),
                version: Version::new(1, 0, 0),
                category: *c,
                homepage: String::new(),
                icon_url: String::new(),
                package: PackageRef {
                    format: PackageFormat::Apk,
                    url: format!("https://cdn.amos.dev/{id}_1000000.apk"),
                    sha256: Some(Checksum::sha256(hex(b"apk bytes")).unwrap()),
                    size_bytes: None,
                },
                publisher: None,
            };
            let index = catalog_to_fdroid_index_v1(&[manifest], "https://store.amos.dev/repo");
            let json = serde_json::to_vec(&index).unwrap();
            let p = FdroidRepoProvider::from_index_bytes(&json, "").unwrap();
            let cat = p.catalog().await.unwrap();
            assert_eq!(
                cat.len(),
                1,
                "category {c:?} must stay representable (index: {json:?})"
            );
            assert_eq!(
                cat[0].category, *c,
                "category {c:?} must survive export → import unchanged"
            );
        }
    }

    #[test]
    fn string_encoded_numerics_parse_like_the_official_index() {
        // f-droid.org quotes `suggestedVersionCode` as a string; other repos
        // emit bare numbers. Both must map to the same entry.
        let h = hex(b"apk bytes");
        let json = format!(
            r#"{{"repo": {{"address": "https://r/"}},
                "apps": [{{"packageName": "org.ex.a", "name": "A",
                          "suggestedVersionCode": "1020300",
                          "lastUpdated": "1726000000"}}],
                "packages": [{{"packageName": "org.ex.a", "versionName": "1.2.3",
                              "versionCode": 1020300, "apkName": "a.apk",
                              "hash": "{h}", "hashType": "sha256", "size": "42"}}]}}"#
        );
        let p = FdroidRepoProvider::from_index_bytes(json.as_bytes(), "").unwrap();
        let cat = fdroid_index_to_catalog(p.index(), "");
        assert_eq!(cat.len(), 1);
        assert_eq!(cat[0].version.to_string(), "1.2.3");
        assert_eq!(cat[0].package.size_bytes, Some(42));
        assert_eq!(
            p.index().apps[0].suggested_version_code,
            Some(1_020_300),
            "string-encoded versionCode accepted"
        );
        assert_eq!(p.index().apps[0].last_updated, Some(1_726_000_000));
    }

    #[test]
    fn version_code_split_is_monotonic() {
        let v = |c: i64| map_version(None, c);
        assert!(v(0) < v(1));
        assert!(v(999) < v(1_000));
        assert!(v(999_999) < v(1_000_000));
        assert_eq!(
            version_code_from(&v(4_030_201)),
            4_030_201,
            "split is invertible"
        );
    }

    #[cfg(feature = "live")]
    mod live {
        use super::*;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        /// Serve `n` one-shot HTTP responses: the fixture index at
        /// `/index-v1.json` and the suggested APK at `/org.example.one_2.apk`.
        /// The fixture's `repo.address` is rewritten to the loopback URL —
        /// the mapping prefers the index's own address by design.
        async fn serve(n: usize) -> String {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let index_json = fixture().replace("https://example.fdroid/repo", &base);
            tokio::spawn(async move {
                for _ in 0..n {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut req = Vec::new();
                    let mut buf = [0u8; 256];
                    loop {
                        let n = stream.read(&mut buf).await.unwrap();
                        if n == 0 {
                            break;
                        }
                        req.extend_from_slice(&buf[..n]);
                        if req.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let path = req
                        .split(|c| *c == b' ')
                        .nth(1)
                        .map(|p| String::from_utf8_lossy(p).into_owned())
                        .unwrap_or_default();
                    let (body, ctype): (Vec<u8>, &str) = if path.contains("/index-v1.json") {
                        (index_json.clone().into_bytes(), "application/json")
                    } else {
                        (
                            b"apk one v2".to_vec(),
                            "application/vnd.android.package-archive",
                        )
                    };
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    stream.write_all(head.as_bytes()).await.unwrap();
                    stream.write_all(&body).await.unwrap();
                    let _ = stream.flush().await;
                }
            });
            base
        }

        #[tokio::test]
        async fn fetch_downloads_index_and_provider_downloads_apk() {
            let base = serve(2).await;
            let p = FdroidRepoProvider::fetch(&base, 30, None).await.unwrap();
            assert_eq!(p.base_url(), base.trim_end_matches('/'));
            let cat = p.catalog().await.unwrap();
            assert_eq!(cat.len(), 4);
            assert_eq!(cat[0].package.url, format!("{base}/org.example.one_2.apk"));
            let bytes = p.fetch_package(&cat[0]).await.unwrap();
            assert_eq!(bytes, b"apk one v2", "APK bytes come over the wire");
        }

        #[tokio::test]
        async fn wrong_index_pin_is_refused() {
            let base = serve(1).await;
            let pin = Checksum::sha256(hex(b"not the index")).unwrap();
            let err = FdroidRepoProvider::fetch(&base, 30, Some(&pin.value))
                .await
                .unwrap_err();
            assert!(err.to_string().contains("digest mismatch"), "{err}");
        }

        #[tokio::test]
        async fn correct_index_pin_is_accepted() {
            let base = serve(1).await;
            // The served body is the fixture with its repo.address rewritten to
            // the loopback URL — pin exactly those bytes.
            let served = fixture().replace("https://example.fdroid/repo", &base);
            let pin = Checksum::sha256_hex(served.as_bytes());
            FdroidRepoProvider::fetch(&base, 30, Some(&pin))
                .await
                .unwrap();
        }

        /// **Real network** end-to-end against the official f-droid.org repo.
        ///
        /// Excluded from the default run because it needs the public internet
        /// (and moves tens of MB). Run it explicitly:
        ///
        /// ```text
        /// cargo test -p amos-appstore --features live -- --ignored --nocapture
        /// ```
        ///
        /// It proves the two things an offline fixture cannot: the *real*
        /// ~61 MB index parses and localized (`zh`) metadata is backfilled, and
        /// a *real* APK downloads byte-for-byte matching the published sha256.
        #[tokio::test]
        #[ignore = "requires network access to f-droid.org (moves tens of MB)"]
        async fn real_fdroid_org_index_and_apk() {
            let p = FdroidRepoProvider::fetch(
                F_DROID_OFFICIAL_REPO,
                FdroidRepoProvider::DEFAULT_INDEX_TIMEOUT_SECS,
                None,
            )
            .await
            .expect("fetch the official index");

            let cat = p.catalog().await.expect("map the official index");
            assert!(
                cat.len() > 1000,
                "the real repo publishes thousands of apps, got {}",
                cat.len()
            );

            // `localized` is consumed: Wikipedia's rich text lives there, not at
            // the top level, so a CJK description proves the backfill ran.
            let wiki = cat
                .iter()
                .find(|m| m.id == "org.wikipedia")
                .expect("org.wikipedia is in the official repo");
            assert!(
                !wiki.description.is_empty() && wiki.description.chars().any(|c| c as u32 > 0x2FFF),
                "localized (CJK) description must be backfilled, got {:?}",
                wiki.description
            );

            // Pick the smallest APK so the integrity proof stays quick, then
            // verify real bytes against the digest the index published.
            let smallest = cat
                .iter()
                .filter(|m| m.package.format == PackageFormat::Apk && m.package.sha256.is_some())
                .min_by_key(|m| m.package.size_bytes.unwrap_or(u64::MAX))
                .expect("at least one downloadable APK");
            let bytes = p.fetch_package(smallest).await.expect("download the APK");
            assert!(
                smallest
                    .package
                    .sha256
                    .as_ref()
                    .is_some_and(|c| c.verify(&bytes)),
                "downloaded {} bytes for {} must match the index sha256",
                bytes.len(),
                smallest.id
            );
        }
    }
}
