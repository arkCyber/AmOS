//! `amos-ota-cli` — drive the [`amos_ota`] update decision layer from a terminal.
//!
//! Commands:
//! * `version <A> [B]` — parse a SemVer version (or compare two).
//! * `digest <file>` — print the SHA-256 of a file (the digest a manifest must
//!   carry for that image).
//! * `check` — load a manifest, fold it with a policy and device facts, and
//!   print the [`amos_ota::Decision`].
//! * `install` — the same, then run the whole pipeline against a **local** image
//!   file: fetch → integrity → signature → install state machine. It is a dry
//!   run on the host: it stages nothing and reboots nothing, and it says so.
//!
//! Exit codes are stable so a script can branch on the *kind* of answer:
//! `0` eligible/up-to-date/ok, `10` deferred, `11` refused, `2` usage error,
//! `1` a real error (bad file, unreadable manifest).

// P0-1 gate: production code must not panic on programmer error.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

use std::io::Write;

use amos_ota::{
    evaluate, sha256_hex, Channel, Cohort, Decision, DeviceFacts, Ed25519Verifier, FailReason,
    InstallMachine, InstallState, Manifest, MockUpdateProvider, SignatureVerdict,
    SignatureVerifier, TrustingVerifier, UntrustedSignaturePolicy, UpdatePolicy, UpdateProvider,
    Version,
};

/// Exit code for a successful, actionable answer.
pub const EXIT_OK: i32 = 0;
/// Exit code for a *deferred* decision (a transient condition holds it back).
pub const EXIT_DEFERRED: i32 = 10;
/// Exit code for a *refused* decision (a durable condition).
pub const EXIT_REFUSED: i32 = 11;
/// Exit code for a usage error.
pub const EXIT_USAGE: i32 = 2;
/// Exit code for a real error (file/manifest/parse).
pub const EXIT_ERROR: i32 = 1;

const USAGE: &str = "\
amos-ota-cli — system-update (OTA) decision tool

USAGE:
  amos-ota-cli version <A> [B]                 parse a version, or compare A and B
  amos-ota-cli digest <file>                   print the SHA-256 of a file
  amos-ota-cli check   --manifest <file> [opts]
  amos-ota-cli install --manifest <file> --image <file> [opts]

check/install options:
  --channel stable|beta        channel to follow            (default: stable)
  --current <version>          the device's current version (required)
  --device-id <id>             device identity for cohorts   (default: local)
  --battery <0..100>           battery level (omit ⇒ unknown)
  --charging                   on a charger
  --on-battery                 not on a charger (omit both ⇒ unknown)
  --wifi                       on Wi-Fi
  --window                     inside the maintenance window
  --cohort <salt:percent>      staged-rollout gate, e.g. wave1:25
  --no-signature               do not require a signature
  --any-network                do not require Wi-Fi
  --window-only                only update inside the window

install extras:
  --image <file>               local image bytes to 'fetch'
  --trust-key <key_id>         trusted key id, POLICY-ONLY (repeatable; not cryptographic)
  --trust-key-hex <id>=<hex>   32-byte Ed25519 public key, REAL verification (repeatable)
  --allow-untrusted            stage even if the signature is untrusted (recorded, not fatal)
  --json                       emit one JSON object per command

  --trust-key-hex and --trust-key are mutually exclusive: the first verifies the
  signature mathematics, the second only checks that the id is one you listed.
  A signature that is present but untrusted FAILS the install unless
  --allow-untrusted is given.

exit codes: 0 ok · 10 deferred · 11 refused · 2 usage · 1 error";

/// Run the CLI. `args` is the full argv (argv[0] included). Output is written to
/// `out`, which makes the whole surface testable in-process.
pub fn run(args: &[String], out: &mut dyn Write) -> anyhow::Result<i32> {
    let cmd = args.get(1).map(String::as_str);
    match cmd {
        Some("version") => cmd_version(&args[2..], out),
        Some("digest") => cmd_digest(&args[2..], out),
        Some("check") => cmd_check(&args[2..], out, false),
        Some("install") => cmd_check(&args[2..], out, true),
        Some("-h") | Some("--help") | None => {
            writeln!(out, "{USAGE}")?;
            Ok(EXIT_OK)
        }
        Some(other) => {
            writeln!(out, "unknown command: {other}\n\n{USAGE}")?;
            Ok(EXIT_USAGE)
        }
    }
}

fn cmd_version(args: &[String], out: &mut dyn Write) -> anyhow::Result<i32> {
    let mut versions = Vec::new();
    for a in args {
        match Version::parse(a) {
            Ok(v) => versions.push(v),
            Err(e) => {
                writeln!(out, "invalid version {a:?}: {e}")?;
                return Ok(EXIT_USAGE);
            }
        }
    }
    match versions.as_slice() {
        [a] => {
            writeln!(
                out,
                "{a} (major={} minor={} patch={} prerelease={} build={})",
                a.major(),
                a.minor(),
                a.patch(),
                a.is_prerelease(),
                a.build().unwrap_or("-"),
            )?;
            Ok(EXIT_OK)
        }
        [a, b] => {
            let ord = match a.cmp(b) {
                std::cmp::Ordering::Less => "<",
                std::cmp::Ordering::Equal => "=",
                std::cmp::Ordering::Greater => ">",
            };
            writeln!(out, "{a} {ord} {b}")?;
            Ok(EXIT_OK)
        }
        _ => {
            writeln!(out, "version takes one or two arguments\n\n{USAGE}")?;
            Ok(EXIT_USAGE)
        }
    }
}

fn cmd_digest(args: &[String], out: &mut dyn Write) -> anyhow::Result<i32> {
    let Some(path) = args.first() else {
        writeln!(out, "digest needs a file path\n\n{USAGE}")?;
        return Ok(EXIT_USAGE);
    };
    let bytes = std::fs::read(path)?;
    writeln!(out, "{}", sha256_hex(&bytes))?;
    Ok(EXIT_OK)
}

/// Parsed `check`/`install` options.
struct Opts {
    manifest_path: String,
    image_path: Option<String>,
    channel: Channel,
    current: Version,
    device_id: String,
    battery: Option<u8>,
    /// Three-valued like `--battery`: `--charging` ⇒ `Some(true)`,
    /// `--on-battery` ⇒ `Some(false)`, neither ⇒ `None` ("the charging state was
    /// not observed"). A bare `bool` made the omitted case assert a discharge
    /// nobody observed, which the policy then reported as a battery problem.
    charging: Option<bool>,
    wifi: bool,
    window: bool,
    cohort: Option<Cohort>,
    require_signature: bool,
    wifi_only: bool,
    window_only: bool,
    trust_keys: Vec<String>,
    /// `(key_id, public_key_hex)` pairs for **real** Ed25519 verification.
    trust_keys_hex: Vec<(String, String)>,
    /// Stage despite an untrusted signature (recorded, not fatal).
    allow_untrusted: bool,
    json: bool,
}

fn parse_opts(args: &[String]) -> Result<Opts, String> {
    let mut manifest_path = None;
    let mut image_path = None;
    let mut channel = Channel::Stable;
    let mut current = None;
    let mut device_id = "local".to_string();
    let mut battery = None;
    let mut charging: Option<bool> = None;
    let mut wifi = false;
    let mut window = false;
    let mut cohort = None;
    let mut require_signature = true;
    let mut wifi_only = true;
    let mut window_only = false;
    let mut trust_keys = Vec::new();
    let mut trust_keys_hex = Vec::new();
    let mut allow_untrusted = false;
    let mut json = false;

    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let mut next = || -> Result<String, String> {
            i += 1;
            args.get(i)
                .cloned()
                .ok_or_else(|| format!("{a} needs a value"))
        };
        match a {
            "--manifest" => manifest_path = Some(next()?),
            "--image" => image_path = Some(next()?),
            "--channel" => {
                let v = next()?;
                channel = Channel::from_key(&v)
                    .ok_or_else(|| format!("unknown channel {v:?} (stable|beta)"))?;
            }
            "--current" => {
                let v = next()?;
                current = Some(Version::parse(&v).map_err(|e| format!("--current: {e}"))?);
            }
            "--device-id" => {
                let v = next()?;
                if v.trim().is_empty() {
                    return Err(
                        "--device-id: device id is empty (an unnamed device cannot be placed in a cohort)"
                            .to_string(),
                    );
                }
                device_id = v;
            }
            "--battery" => {
                let v = next()?;
                let n: u8 = v
                    .parse()
                    .map_err(|_| format!("--battery: {v} is not 0..100"))?;
                if n > 100 {
                    return Err(format!("--battery: {n} is not 0..100"));
                }
                battery = Some(n);
            }
            "--charging" => charging = Some(true),
            "--on-battery" => charging = Some(false),
            "--wifi" => wifi = true,
            "--window" => window = true,
            "--cohort" => {
                let v = next()?;
                let (salt, pct) = v
                    .split_once(':')
                    .ok_or_else(|| "--cohort expects <salt:percent>".to_string())?;
                let pct: u8 = pct
                    .parse()
                    .map_err(|_| format!("--cohort percent {pct:?} is not 0..100"))?;
                // `Cohort::new` *clamps* a percentage above 100 to 100 — right for
                // a helper that over-widened a computed value, wrong here. At this
                // boundary the clamp turns a typo into the **opposite** of what was
                // asked: `--cohort wave1:150` (a mistyped `15`) becomes a 100% wave
                // and releases to the whole fleet, silently. `--battery`, the sibling
                // percent flag, refuses `>100` for exactly this reason, so the
                // rollout width must not be the one flag that folds it.
                if pct > 100 {
                    return Err(format!("--cohort percent {pct} is not 0..100"));
                }
                cohort = Some(Cohort::new(salt, pct).map_err(|e| e.to_string())?);
            }
            "--no-signature" => require_signature = false,
            "--any-network" => wifi_only = false,
            "--window-only" => window_only = true,
            "--trust-key" => trust_keys.push(next()?),
            "--trust-key-hex" => {
                let v = next()?;
                let (id, hex) = v
                    .split_once('=')
                    .ok_or_else(|| "--trust-key-hex expects <key_id>=<32-byte-hex>".to_string())?;
                if id.is_empty() {
                    return Err("--trust-key-hex: key id is empty".to_string());
                }
                trust_keys_hex.push((id.to_string(), hex.to_string()));
            }
            "--allow-untrusted" => allow_untrusted = true,
            "--json" => json = true,
            other => return Err(format!("unknown option {other}")),
        }
        i += 1;
    }

    if !trust_keys.is_empty() && !trust_keys_hex.is_empty() {
        return Err(
            "--trust-key (policy-only) and --trust-key-hex (real Ed25519) are mutually \
             exclusive; pick one so the printed verdict names the check that ran"
                .to_string(),
        );
    }

    Ok(Opts {
        manifest_path: manifest_path.ok_or("--manifest is required")?,
        image_path,
        channel,
        current: current.ok_or("--current is required")?,
        device_id,
        battery,
        charging,
        wifi,
        window,
        cohort,
        require_signature,
        wifi_only,
        window_only,
        trust_keys,
        trust_keys_hex,
        allow_untrusted,
        json,
    })
}

fn cmd_check(args: &[String], out: &mut dyn Write, install: bool) -> anyhow::Result<i32> {
    let opts = match parse_opts(args) {
        Ok(o) => o,
        Err(e) => {
            writeln!(out, "{e}\n\n{USAGE}")?;
            return Ok(EXIT_USAGE);
        }
    };

    let raw = std::fs::read_to_string(&opts.manifest_path)?;
    let manifest: Manifest =
        serde_json::from_str(&raw).map_err(|e| anyhow::anyhow!("{}: {e}", opts.manifest_path))?;

    let policy = UpdatePolicy::new(opts.channel)
        .require_signature(opts.require_signature)
        .wifi_only(opts.wifi_only)
        .defer_outside_window(opts.window_only)
        .with_cohort_opt(opts.cohort.clone());

    let mut facts = DeviceFacts::new(opts.current.clone(), opts.device_id.clone());
    if let Some(b) = opts.battery {
        facts = facts.with_battery(b);
    }
    facts = facts
        .charging(opts.charging)
        .on_wifi(opts.wifi)
        .in_window(opts.window);

    let decision = evaluate(&manifest, &policy, &facts);

    if opts.json {
        writeln!(
            out,
            "{}",
            render_json(&decision, &manifest, &facts, policy.channel())
        )?;
    } else {
        writeln!(
            out,
            "{}",
            render_human(&decision, &manifest, &facts, policy.channel())
        )?;
    }

    let code = match &decision {
        Decision::Eligible(_) | Decision::UpToDate => EXIT_OK,
        Decision::Deferred(_) => EXIT_DEFERRED,
        Decision::Refused(_) => EXIT_REFUSED,
    };

    if install {
        let Some(image) = opts.image_path.clone() else {
            writeln!(out, "--image is required for `install`\n\n{USAGE}")?;
            return Ok(EXIT_USAGE);
        };
        let Decision::Eligible(package) = &decision else {
            // Nothing to install; the decision line above already said why.
            return Ok(code);
        };
        let image_bytes = std::fs::read(&image)?;
        let provider = MockUpdateProvider::new().with_package(package, image_bytes);
        // Pick the verifier the operator asked for, and say which one ran. A
        // `--trust-key-hex` pair that will not decode is a usage error, not a
        // silent downgrade to the policy-only path.
        let verifier: Box<dyn SignatureVerifier> = if opts.trust_keys_hex.is_empty() {
            Box::new(TrustingVerifier::new(
                opts.trust_keys.iter().map(String::as_str),
            ))
        } else {
            let mut v = Ed25519Verifier::new();
            for (id, hex) in &opts.trust_keys_hex {
                v.insert(id.clone(), hex)
                    .map_err(|e| anyhow::anyhow!("--trust-key-hex {id}: {e}"))?;
            }
            Box::new(v)
        };
        let untrusted = if opts.allow_untrusted {
            UntrustedSignaturePolicy::Allow
        } else {
            UntrustedSignaturePolicy::Fail
        };
        let machine = run_install(&provider, package, verifier.as_ref(), untrusted, out)?;
        // A dry run: report the state we reached, never claim it was applied.
        if machine.state().is_staged() {
            writeln!(
                out,
                "dry run: image verified and staged (would apply {} on the next reboot)",
                machine
                    .state()
                    .version()
                    .map(Version::to_string)
                    .unwrap_or_default()
            )?;
            return Ok(EXIT_OK);
        }
        writeln!(out, "{}", failure_line(machine.state()))?;
        return Ok(EXIT_ERROR);
    }

    Ok(code)
}

/// Drive the pipeline for a local image and print each gate. Returns the
/// machine so the caller can branch on its terminal state.
///
/// The machine's own refusals are **findings, not errors**: when a step says
/// "this install cannot continue" (a short image, an unverified digest), the
/// pipeline stops there and hands the terminal state back. Chaining the next
/// transition anyway would turn an honest, already-computed verdict —
/// `download truncated at 10/20 bytes` — into the name of the illegal
/// transition that verdict caused, which is an instrument answering a
/// different question than the one it was asked.
fn run_install(
    provider: &dyn UpdateProvider,
    package: &amos_ota::UpdatePackage,
    verifier: &dyn SignatureVerifier,
    untrusted: UntrustedSignaturePolicy,
    out: &mut dyn Write,
) -> anyhow::Result<InstallMachine> {
    let mut machine = InstallMachine::new();
    machine.begin(package)?;
    let bytes = provider.fetch_package(package)?;
    writeln!(out, "fetched  {} bytes", bytes.len())?;

    let received = bytes.len() as u64;
    let total = package.size_bytes();
    if received > total {
        // The core's `progress` refuses an over-report *by design* (clamping
        // would hide a lying source), so record the mismatch as the source
        // error it is rather than feeding the machine a size it will reject.
        machine.fail(FailReason::Provider {
            message: format!("image is {received} bytes but the manifest declares {total}"),
        })?;
        return Ok(machine);
    }

    machine.progress(received)?;
    machine.finish_download()?;
    // A short image is already `Failed(Truncated)`; there is nothing to verify.
    if !matches!(machine.state(), InstallState::Downloaded { .. }) {
        return Ok(machine);
    }
    machine.begin_verify()?;
    let verdict = amos_ota::check_integrity(package.sha256(), &bytes);
    writeln!(out, "integrity {}", integrity_word(&verdict))?;
    // Verify the signature over the bytes whenever the digest matched, and hand
    // the verdict to the machine rather than only printing it — an untrusted
    // signature must fail the install (unless `--allow-untrusted`), not decorate
    // the transcript of one that stages anyway.
    let signature = if verdict.is_verified() {
        match amos_ota::verify_signature(verifier, package, &bytes) {
            Ok(sig) => {
                writeln!(out, "signature {}", signature_word(&sig))?;
                sig
            }
            Err(e) => {
                // Unevaluable input is a finding, not a hard error — the same
                // translation the size disagreement above makes, so a signature the
                // verifier cannot read does not abort the run with an opaque
                // failure. The machine settles `Failed(MalformedSignature)` and the
                // caller prints why (see `failure_line`).
                machine.fail(FailReason::MalformedSignature {
                    reason: e.to_string(),
                })?;
                return Ok(machine);
            }
        }
    } else {
        SignatureVerdict::Missing
    };
    machine.complete_verify(verdict, signature, untrusted)?;
    Ok(machine)
}

/// One honest line for a terminal install state the caller must not mistake for
/// success.
fn failure_line(state: &InstallState) -> String {
    match state {
        InstallState::Failed { reason, .. } => format!("install failed: {reason}"),
        other => format!(
            "install did not reach staged: {}",
            install_state_label(other)
        ),
    }
}

fn integrity_word(v: &amos_ota::IntegrityVerdict) -> &'static str {
    match v {
        amos_ota::IntegrityVerdict::Verified => "OK",
        amos_ota::IntegrityVerdict::Mismatch { .. } => "MISMATCH",
        amos_ota::IntegrityVerdict::Malformed { .. } => "MALFORMED",
    }
}

fn signature_word(v: &amos_ota::SignatureVerdict) -> &'static str {
    match v {
        amos_ota::SignatureVerdict::Trusted => "trusted",
        amos_ota::SignatureVerdict::Untrusted { .. } => "UNTRUSTED",
        amos_ota::SignatureVerdict::Missing => "MISSING",
    }
}

fn render_human(
    decision: &Decision,
    manifest: &Manifest,
    facts: &DeviceFacts,
    channel: Channel,
) -> String {
    let head = match decision {
        Decision::UpToDate => format!("up to date (current {})", facts.current),
        Decision::Eligible(p) => format!("eligible: {} ({})", p.version(), p.uri()),
        Decision::Deferred(r) => format!("deferred: {r}"),
        Decision::Refused(r) => format!("refused: {r}"),
    };
    let min = manifest
        .min_supported_version()
        .map(|m| format!(" · min supported {m}"))
        .unwrap_or_default();
    format!(
        "{head} · channel {} · current {}{min}",
        channel.key(),
        facts.current
    )
}

fn render_json(
    decision: &Decision,
    manifest: &Manifest,
    facts: &DeviceFacts,
    channel: Channel,
) -> String {
    let mut s = String::new();
    let (state, version, reason) = match decision {
        Decision::UpToDate => ("up_to_date", None, None),
        Decision::Eligible(p) => ("eligible", Some(p.version().to_string()), None),
        Decision::Deferred(r) => ("deferred", None, Some(r.to_string())),
        Decision::Refused(r) => ("refused", None, Some(r.to_string())),
    };
    s.push_str(&format!("{{\"state\":\"{state}\""));
    s.push_str(&format!(",\"channel\":\"{}\"", channel.key()));
    s.push_str(&format!(",\"current\":\"{}\"", facts.current));
    if let Some(v) = version {
        s.push_str(&format!(",\"version\":\"{v}\""));
    }
    if let Some(r) = reason {
        s.push_str(&format!(",\"reason\":{}", json_string(&r)));
    }
    if let Some(min) = manifest.min_supported_version() {
        s.push_str(&format!(",\"min_supported_version\":\"{min}\""));
    }
    s.push('}');
    s
}

/// Minimal JSON string escaping (quotes and backslashes; reasons are plain text).
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Small extension so the policy builder stays fluent with an optional cohort.
trait WithCohortOpt {
    fn with_cohort_opt(self, cohort: Option<Cohort>) -> Self;
}

impl WithCohortOpt for UpdatePolicy {
    fn with_cohort_opt(self, cohort: Option<Cohort>) -> Self {
        match cohort {
            Some(c) => self.with_cohort(c),
            None => self,
        }
    }
}

/// Convenience for embedders: a one-line status string from an install state.
pub fn install_state_label(state: &InstallState) -> String {
    match state.version() {
        Some(v) => format!("{} ({v})", state.key()),
        None => state.key().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_str(args: &[&str]) -> (i32, String) {
        let argv: Vec<String> = std::iter::once("amos-ota-cli".to_string())
            .chain(args.iter().map(|s| s.to_string()))
            .collect();
        let mut buf: Vec<u8> = Vec::new();
        let code = run(&argv, &mut buf).unwrap();
        (code, String::from_utf8(buf).unwrap())
    }

    #[test]
    fn version_compares_and_describes() {
        let (code, out) = run_str(&["version", "1.0.0-alpha", "1.0.0"]);
        assert_eq!(code, EXIT_OK);
        assert!(out.contains('<'), "{out}");
        let (code, out) = run_str(&["version", "1.2.3-rc.1+build.9"]);
        assert_eq!(code, EXIT_OK);
        assert!(out.contains("major=1"), "{out}");
        assert!(out.contains("prerelease=true"), "{out}");
        assert!(out.contains("build=build.9"), "{out}");
    }

    #[test]
    fn version_refuses_garbage() {
        let (code, _out) = run_str(&["version", "not-a-version"]);
        assert_eq!(code, EXIT_USAGE);
    }

    #[test]
    fn help_lists_commands() {
        let (code, out) = run_str(&["--help"]);
        assert_eq!(code, EXIT_OK);
        assert!(out.contains("check") && out.contains("install"));
    }

    #[test]
    fn unknown_command_is_usage_error() {
        let (code, _) = run_str(&["frobnicate"]);
        assert_eq!(code, EXIT_USAGE);
    }

    /// `--device-id` is the cohort identity, and the CLI already refuses an
    /// empty *key* id (`--trust-key-hex`). An empty device id has to be refused
    /// for the same reason: `Cohort` cannot place it, so every such invocation
    /// would fall on one bucket and a `--cohort wave1:50` would mean "all of
    /// them" or "none of them" rather than half. Say so at the boundary instead
    /// of returning a confident `not in cohort` for a whole fleet.
    ///
    /// The two branches are told apart by their *message*, not by the exit code
    /// or by the presence of `--device-id`: the usage banner printed on every
    /// latter-stage error already lists the flag, so only "which requirement did
    /// we stop at" discriminates the guard from the next check down the line.
    #[test]
    fn a_blank_device_id_is_a_usage_error() {
        let (code, out) = run_str(&["check", "--device-id", ""]);
        assert_eq!(code, EXIT_USAGE, "{out}");
        assert!(out.contains("device id is empty"), "{out}");
        assert!(
            !out.contains("--manifest is required"),
            "the run must stop at --device-id, not fall through to --manifest: {out}"
        );
        // Positive control: a real id passes the guard and falls through to the
        // next requirement, so "always refuse --device-id" cannot pass.
        let (code, out) = run_str(&["check", "--device-id", "device-42"]);
        assert_eq!(code, EXIT_USAGE, "{out}");
        assert!(!out.contains("device id is empty"), "{out}");
        assert!(out.contains("--manifest is required"), "{out}");
    }

    /// `--cohort <salt:percent>` is the rollout *width*, and `Cohort::new`
    /// **clamps** a percentage above 100 to 100 — a deliberate library contract
    /// for a helper handed an over-wide computed value. At this user boundary the
    /// clamp inverts the instruction: `--cohort wave1:150` (a mistyped `15`)
    /// becomes a 100% wave and releases to the whole fleet, silently, which is the
    /// opposite of a staged rollout. `--battery`, the sibling percent flag, already
    /// refuses `>100` (`--battery: 150 is not 0..100`); the CLI's own `--cohort`
    /// error string promises the same range but only reaches it when the `u8`
    /// parse fails, so every value 101..=255 slipped through.
    ///
    /// Discrimination is by the guard's *own* message and by which requirement the
    /// run stopped at: the usage banner printed for every latter-stage error
    /// already contains the literal `--battery <0..100>`, so asserting on `0..100`
    /// would match the banner for the legal widths too and prove nothing.
    #[test]
    fn a_cohort_percentage_above_100_is_a_usage_error() {
        for bad in ["wave1:150", "wave1:101", "wave1:255"] {
            let (code, out) = run_str(&["check", "--cohort", bad]);
            assert_eq!(code, EXIT_USAGE, "{bad}: {out}");
            assert!(out.contains("--cohort percent"), "{bad}: {out}");
            assert!(
                !out.contains("--manifest is required"),
                "{bad} must stop at --cohort, not fall through to --manifest: {out}"
            );
        }
        // Positive controls: a legal width passes the guard and falls through to
        // the next requirement, so "always refuse --cohort" cannot pass. `0` and
        // `100` are the inclusive edges of the contract.
        for ok in ["wave1:15", "wave1:0", "wave1:100"] {
            let (code, out) = run_str(&["check", "--cohort", ok]);
            assert_eq!(code, EXIT_USAGE, "{ok}: {out}");
            assert!(
                !out.contains("--cohort percent"),
                "{ok} is a legal width: {out}"
            );
            assert!(out.contains("--manifest is required"), "{ok}: {out}");
        }
    }

    // A small end-to-end exercised through `run` using a temp manifest + image.
    fn write_fixture(
        dir: &std::path::Path,
        image: &[u8],
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        write_fixture_declaring(dir, image, image.len() as u64)
    }

    /// Like [`write_fixture`], but the manifest may *declare* a size other than
    /// the file's, so a size disagreement can be isolated from a digest one.
    fn write_fixture_declaring(
        dir: &std::path::Path,
        image: &[u8],
        declared_size: u64,
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let digest = sha256_hex(image);
        let manifest = format!(
            r#"{{"packages":[{{"version":"1.1.0","channel":"stable","uri":"file://img","sha256":"{digest}","size_bytes":{declared_size},"signature":{{"key_id":"rel","value":"aabb"}}}}],"min_supported_version":"1.0.0"}}"#
        );
        let mp = dir.join("manifest.json");
        let ip = dir.join("image.bin");
        std::fs::write(&mp, manifest).unwrap();
        std::fs::write(&ip, image).unwrap();
        (mp, ip)
    }

    /// Like [`write_fixture`], but the manifest carries `sig_hex` under key id
    /// `rel` — so a test can drive the `--trust-key-hex` path with a signature it
    /// produced (or deliberately forged).
    fn write_fixture_signed(
        dir: &std::path::Path,
        image: &[u8],
        sig_hex: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let digest = sha256_hex(image);
        let manifest = format!(
            r#"{{"packages":[{{"version":"1.1.0","channel":"stable","uri":"file://img","sha256":"{digest}","size_bytes":{},"signature":{{"key_id":"rel","value":"{sig_hex}"}}}}],"min_supported_version":"1.0.0"}}"#,
            image.len()
        );
        let mp = dir.join("manifest.json");
        let ip = dir.join("image.bin");
        std::fs::write(&mp, manifest).unwrap();
        std::fs::write(&ip, image).unwrap();
        (mp, ip)
    }

    /// A deterministic Ed25519 keypair for tests: `(public_key_hex, sign)`.
    fn test_signing_key() -> (String, impl Fn(&[u8]) -> String) {
        use ed25519_dalek::{Signer, SigningKey};
        // RFC 8032 TEST 2's seed — fixed, so the signature is reproducible.
        let seed: [u8; 32] =
            hex::decode("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
                .unwrap()
                .try_into()
                .unwrap();
        let key = SigningKey::from_bytes(&seed);
        let pk = hex::encode(key.verifying_key().to_bytes());
        (pk, move |msg: &[u8]| hex::encode(key.sign(msg).to_bytes()))
    }

    /// The real path: `--trust-key-hex` verifies the signature *mathematics*, so
    /// a genuine signature is `trusted` and stages, while a forged value on the
    /// same key id is `UNTRUSTED` — the case `--trust-key` cannot distinguish.
    #[test]
    fn install_with_trust_key_hex_verifies_the_signature() {
        let dir = std::env::temp_dir().join(format!("amos-ota-cli-ed25519-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = b"AMOS-IMAGE-1.1.0-ED25519".to_vec();
        let (pk, sign) = test_signing_key();
        let good_sig = sign(&image);
        let (mp, ip) = write_fixture_signed(&dir, &image, &good_sig);
        let ms = mp.to_string_lossy().to_string();
        let is = ip.to_string_lossy().to_string();

        let (code, out) = run_str(&[
            "install",
            "--manifest",
            &ms,
            "--image",
            &is,
            "--current",
            "1.0.0",
            "--wifi",
            "--charging",
            "--trust-key-hex",
            &format!("rel={pk}"),
        ]);
        assert_eq!(code, EXIT_OK, "{out}");
        assert!(out.contains("signature trusted"), "{out}");
        assert!(out.contains("dry run"), "{out}");

        // The same manifest checked with a *different* real key is UNTRUSTED.
        let (other_pk, _) = {
            use ed25519_dalek::SigningKey;
            let k = SigningKey::from_bytes(&[7u8; 32]);
            (hex::encode(k.verifying_key().to_bytes()), ())
        };
        let (code, out) = run_str(&[
            "install",
            "--manifest",
            &ms,
            "--image",
            &is,
            "--current",
            "1.0.0",
            "--wifi",
            "--charging",
            "--trust-key-hex",
            &format!("rel={other_pk}"),
        ]);
        assert_ne!(code, EXIT_OK, "{out}");
        assert!(out.contains("signature UNTRUSTED"), "{out}");
        assert!(!out.contains("dry run"), "{out}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// An **unevaluable** signature — well-formed hex the verifier cannot read as
    /// a signature (here 2 bytes, not 64) — is a *finding*, not a hard error.
    ///
    /// `Signature::new` (`amos-ota/src/spec.rs`) admits only well-formed
    /// even-length hex at manifest parse, so `aabb` parses fine and reaches the
    /// verifier; `Ed25519Verifier` then refuses to *evaluate* it. Before this,
    /// `run_install` `?`-propagated that error and the whole run aborted with an
    /// opaque failure — while its own sibling, the size disagreement a few lines
    /// above, already settled the machine with a named reason and returned `Ok`.
    /// The digest gate keeps the same discipline
    /// (`IntegrityVerdict::Malformed` → `FailReason::MalformedDigest`); the
    /// signature half now has its own name too.
    #[test]
    fn an_unevaluable_signature_is_reported_not_aborted() {
        let dir = std::env::temp_dir().join(format!("amos-ota-cli-malsig-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = b"AMOS-IMAGE-1.1.0-MALSIG".to_vec();
        let (pk, _sign) = test_signing_key();
        // Well-formed hex, but 2 bytes — not the 64 an Ed25519 signature is.
        let (mp, ip) = write_fixture_signed(&dir, &image, "aabb");
        let ms = mp.to_string_lossy().to_string();
        let is = ip.to_string_lossy().to_string();

        let (code, out) = run_str(&[
            "install",
            "--manifest",
            &ms,
            "--image",
            &is,
            "--current",
            "1.0.0",
            "--wifi",
            "--charging",
            "--trust-key-hex",
            &format!("rel={pk}"),
        ]);
        assert_eq!(code, EXIT_ERROR, "{out}");
        assert!(out.contains("malformed signature"), "{out}");
        assert!(
            out.contains("aabb"),
            "the cause must name the offending signature: {out}"
        );
        assert!(!out.contains("dry run"), "{out}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The discriminator: a *forged* signature (any 64 bytes) on a trusted key id
    /// is accepted by the policy-only `--trust-key` and refused by the real
    /// `--trust-key-hex`. This is the whole reason the second option exists.
    #[test]
    fn a_forged_signature_passes_trust_key_but_fails_trust_key_hex() {
        let dir = std::env::temp_dir().join(format!("amos-ota-cli-forge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = b"AMOS-IMAGE-1.1.0".to_vec();
        let (pk, _sign) = test_signing_key();
        // A well-formed but bogus 64-byte signature; the digest still matches.
        let forged = "00".repeat(64);
        let (mp, ip) = write_fixture_signed(&dir, &image, &forged);
        let ms = mp.to_string_lossy().to_string();
        let is = ip.to_string_lossy().to_string();

        // Policy-only path: accepted (it never looks at the math).
        let (code, out) = run_str(&[
            "install",
            "--manifest",
            &ms,
            "--image",
            &is,
            "--current",
            "1.0.0",
            "--wifi",
            "--charging",
            "--trust-key",
            "rel",
        ]);
        assert_eq!(code, EXIT_OK, "{out}");
        assert!(out.contains("signature trusted"), "{out}");

        // Real path: refused.
        let (code, out) = run_str(&[
            "install",
            "--manifest",
            &ms,
            "--image",
            &is,
            "--current",
            "1.0.0",
            "--wifi",
            "--charging",
            "--trust-key-hex",
            &format!("rel={pk}"),
        ]);
        assert_ne!(code, EXIT_OK, "{out}");
        assert!(
            out.contains("signature UNTRUSTED"),
            "the real verifier must refuse a forgery the policy verifier accepts: {out}"
        );
        assert!(!out.contains("dry run"), "{out}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A `--trust-key-hex` value that is not a usable key is a **usage error**, not
    /// a silent downgrade to the policy-only path — which would verify nothing
    /// while the operator believed it had.
    #[test]
    fn a_malformed_trust_key_hex_is_a_hard_error() {
        let dir = std::env::temp_dir().join(format!("amos-ota-cli-badkey-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = b"AMOS-IMAGE-1.1.0".to_vec();
        let (mp, ip) = write_fixture(&dir, &image);
        let ms = mp.to_string_lossy().to_string();
        let is = ip.to_string_lossy().to_string();

        // Not hex / wrong length. `--wifi --charging` make the decision Eligible
        // so the pipeline reaches the verifier (a Deferred decision returns before
        // the key is ever constructed).
        let err = run(
            &[
                "amos-ota-cli".into(),
                "install".into(),
                "--manifest".into(),
                ms.clone(),
                "--image".into(),
                is.clone(),
                "--current".into(),
                "1.0.0".into(),
                "--wifi".into(),
                "--charging".into(),
                "--trust-key-hex".into(),
                "rel=nothex".into(),
            ],
            &mut Vec::new(),
        )
        .expect_err("a bad public key must error, not silently trust nothing");
        assert!(err.to_string().contains("trust-key-hex"), "{err}");

        // Missing `=` is caught by the parser (a usage error, before any file I/O).
        let (code, out) = run_str(&[
            "install",
            "--manifest",
            &ms,
            "--image",
            &is,
            "--current",
            "1.0.0",
            "--trust-key-hex",
            "no-equals-sign",
        ]);
        assert_eq!(code, EXIT_USAGE, "{out}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `--trust-key` and `--trust-key-hex` name two different checks; asking for
    /// both at once is refused so the printed verdict always names the check that
    /// actually ran.
    #[test]
    fn the_two_trust_options_are_mutually_exclusive() {
        let (code, out) = run_str(&[
            "check",
            "--manifest",
            "/nonexistent",
            "--current",
            "1.0.0",
            "--trust-key",
            "rel",
            "--trust-key-hex",
            "rel=00",
        ]);
        assert_eq!(code, EXIT_USAGE, "{out}");
    }

    #[test]
    fn check_reports_eligible_then_install_stages() {
        let dir = std::env::temp_dir().join(format!("amos-ota-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = b"AMOS-IMAGE-1.1.0".to_vec();
        let (mp, ip) = write_fixture(&dir, &image);
        let ms = mp.to_string_lossy().to_string();
        let is = ip.to_string_lossy().to_string();

        let (code, out) = run_str(&[
            "check",
            "--manifest",
            &ms,
            "--current",
            "1.0.0",
            "--wifi",
            "--charging",
            "--json",
        ]);
        assert_eq!(code, EXIT_OK, "{out}");
        assert!(out.contains("\"state\":\"eligible\""), "{out}");

        let (code, out) = run_str(&[
            "install",
            "--manifest",
            &ms,
            "--image",
            &is,
            "--current",
            "1.0.0",
            "--wifi",
            "--charging",
            "--trust-key",
            "rel",
        ]);
        assert_eq!(code, EXIT_OK, "{out}");
        assert!(out.contains("integrity OK"), "{out}");
        assert!(out.contains("dry run"), "{out}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn install_detects_a_tampered_image() {
        let dir = std::env::temp_dir().join(format!("amos-ota-cli-tamper-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = b"AMOS-IMAGE-1.1.0".to_vec();
        let (mp, ip) = write_fixture(&dir, &image);
        // Overwrite the image with same-length different bytes.
        let mut tampered = image.clone();
        tampered[0] ^= 0xff;
        std::fs::write(&ip, &tampered).unwrap();

        let ms = mp.to_string_lossy().to_string();
        let is = ip.to_string_lossy().to_string();
        let (code, out) = run_str(&[
            "install",
            "--manifest",
            &ms,
            "--image",
            &is,
            "--current",
            "1.0.0",
            "--wifi",
            "--charging",
            "--trust-key",
            "rel",
        ]);
        assert_ne!(code, EXIT_OK, "{out}");
        assert!(out.contains("MISMATCH"), "{out}");
        assert!(
            !out.contains("dry run"),
            "a tampered image must not stage: {out}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A local image shorter than the manifest declares must be reported as the
    /// truncation it is — not as the illegal transition that truncation causes.
    #[test]
    fn install_reports_a_short_image_as_truncated() {
        let dir = std::env::temp_dir().join(format!("amos-ota-cli-short-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = b"AMOS-IMAGE".to_vec();
        // The digest matches the bytes; only the declared size is too large.
        let (mp, ip) = write_fixture_declaring(&dir, &image, image.len() as u64 + 90);
        let ms = mp.to_string_lossy().to_string();
        let is = ip.to_string_lossy().to_string();

        let (code, out) = run_str(&[
            "install",
            "--manifest",
            &ms,
            "--image",
            &is,
            "--current",
            "1.0.0",
            "--wifi",
            "--charging",
            "--trust-key",
            "rel",
        ]);
        let short = image.len();
        let total = short + 90;
        assert_ne!(code, EXIT_OK, "{out}");
        assert!(
            out.contains(&format!("truncated at {short}/{total}")),
            "the honest cause must be the line shown: {out}"
        );
        assert!(
            !out.contains("illegal install transition"),
            "a refused step is a finding, not an internal error: {out}"
        );
        assert!(!out.contains("dry run"), "{out}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An image *longer* than the manifest declares must say so, not surface the
    /// core's (deliberate) refusal of an over-report as a transition error.
    #[test]
    fn install_reports_an_oversize_image_honestly() {
        let dir = std::env::temp_dir().join(format!("amos-ota-cli-long-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = b"AMOS-IMAGE-AND-THEN-SOME-MORE".to_vec();
        let (mp, ip) = write_fixture_declaring(&dir, &image, 4);
        let ms = mp.to_string_lossy().to_string();
        let is = ip.to_string_lossy().to_string();

        let (code, out) = run_str(&[
            "install",
            "--manifest",
            &ms,
            "--image",
            &is,
            "--current",
            "1.0.0",
            "--wifi",
            "--charging",
        ]);
        assert_ne!(code, EXIT_OK, "{out}");
        assert!(
            out.contains(&format!(
                "is {} bytes but the manifest declares 4",
                image.len()
            )),
            "the size disagreement must be named: {out}"
        );
        assert!(
            !out.contains("illegal install transition"),
            "the core's refusal must be translated, not leaked: {out}"
        );
        assert!(!out.contains("dry run"), "{out}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deferred_decision_has_its_own_exit_code() {
        let dir = std::env::temp_dir().join(format!("amos-ota-cli-defer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (mp, _ip) = write_fixture(&dir, b"img");
        let ms = mp.to_string_lossy().to_string();
        // On battery, no readable level, no Wi-Fi ⇒ deferred.
        let (code, out) = run_str(&["check", "--manifest", &ms, "--current", "1.0.0"]);
        assert_eq!(code, EXIT_DEFERRED, "{out}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Omitting **both** charging flags is "nobody read the charger", not "off
    /// the charger" — the CLI's third state on the same axis as `--battery`'s
    /// "omit ⇒ unknown". A device on Wi-Fi with an unread charger and no level
    /// must be held back by the *charger* fact, and the message must name it so
    /// the operator does not go inspect a battery that was never the obstacle.
    #[test]
    fn an_unread_charger_is_named_not_folded_into_a_battery_problem() {
        let dir = std::env::temp_dir().join(format!("amos-ota-cli-chg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (mp, _ip) = write_fixture(&dir, b"img");
        let ms = mp.to_string_lossy().to_string();

        let (code, out) = run_str(&["check", "--manifest", &ms, "--current", "1.0.0", "--wifi"]);
        assert_eq!(code, EXIT_DEFERRED, "{out}");
        assert!(
            out.contains("charging state is unknown"),
            "the unread charger must be named: {out}"
        );
        assert!(
            !out.contains("battery level is unknown"),
            "an unread charger is not a battery problem: {out}"
        );

        // Positive control: the *same* omission does not veto a level the
        // operator did read and found adequate.
        let (code, out) = run_str(&[
            "check",
            "--manifest",
            &ms,
            "--current",
            "1.0.0",
            "--wifi",
            "--battery",
            "80",
        ]);
        assert_eq!(code, EXIT_OK, "{out}");
        assert!(out.contains("eligible"), "{out}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn install_state_label_is_readable() {
        let m = InstallMachine::new();
        assert_eq!(install_state_label(m.state()), "idle");
    }
}
