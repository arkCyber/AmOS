//! `session` — the host's **power / session** actions: restart, shut down, sleep.
//!
//! Commands:
//!   * `session_restart` — restart the host
//!   * `session_shutdown` — power the host off
//!   * `session_sleep` — suspend the host
//!
//! Three rules this module follows, each learned elsewhere in this repo:
//!
//! 1. **Zero arguments, not a validated string.** The obvious shape is one command
//!    taking a `kind: String`, but `docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md` §2 D2 says a
//!    WebView must never name an arbitrary target — the host accepts an id/enum *it*
//!    enumerated, never a caller-chosen token. Three zero-argument commands make the
//!    WebView's request **unspellable** rather than merely *checked*, which is the same
//!    disposition `wine.rs` / `linux_apps.rs` apply one step looser (an id the host
//!    listed) and strictly narrower than either: there is nothing here to name at all.
//!
//! 2. **Unavailability is a runtime fact, never a `cfg` on the commands.** The module
//!    compiles on every desktop target and [`invocation`] answers *for the host it runs
//!    on* (`wine.rs`'s rule, and the reason its first draft — registered under
//!    `#[cfg(target_os = "darwin")]`, which is not a `target_os` value — never
//!    registered at all). A host with no power/session command gets a **named refusal**
//!    (`amos.session.unsupported_host`), not an unregistered command.
//!
//! 3. **Delayed, detached delivery — because the reply must go out first.** Spawning the
//!    action directly would power the machine off *before* the IPC reply is written: the
//!    WebView would read `null`, which the bridge convention defines as **failure**, and
//!    a successful restart would be reported as a failure — exactly the REQ-A513 /
//!    F-SH-053 shape (`()` and "failure" collapsing to the same value on the wire). So
//!    the command returns its [`SessionPlan`] immediately and hands the action to a
//!    detached `sh` that sleeps [`REQUEST_DELAY_SECS`] first.
//!
//! The action split is **pure decision / side effect**, in this repo's usual shape: the
//! only thing a unit test touches is [`invocation`] (and the pure [`required`] /
//! [`delivery_argv`]), so the test suite **never** spawns anything — a test for "what
//! does restart map to" must not be able to restart the developer's machine.

use std::process::{Command, Stdio};

use crate::error::{AmosError, AmosResult, ErrorCode};

/// How long the detached delivery waits before performing the action.
///
/// Long enough for the IPC reply to be written and read on a loaded machine, short
/// enough that the user (who confirmed the action) is not left wondering. There is no
/// signal to wait on — the machine is about to stop running our process.
pub const REQUEST_DELAY_SECS: u64 = 2;

/// Which host session action a command performs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionAction {
    Restart,
    Shutdown,
    Sleep,
}

impl SessionAction {
    /// The name used in the refusal message (a `match` over `Debug` would print the
    /// variant spelling, which is an implementation detail).
    fn name(self) -> &'static str {
        match self {
            Self::Restart => "restart",
            Self::Shutdown => "shut down",
            Self::Sleep => "sleep",
        }
    }
}

/// What the host accepted, as the command's reply.
///
/// A **value**, not `()`. Tauri serializes `()` to `null` and the bridge reads `null` as
/// failure (REQ-A513 / F-SH-053), so every session command answers with an object.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPlan {
    /// The action that was accepted.
    pub action: SessionAction,
    /// Seconds the host waits before the action runs (the reply goes out first).
    pub delay_secs: u64,
}

/// One way to perform an action on this host: a program and its constant arguments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Invocation {
    program: &'static str,
    args: &'static [&'static str],
}

/// How this host performs `action`, or `None` when it has no way to.
///
/// **Pure** — no side effects, no spawn — so it is the whole of what the unit tests
/// exercise. Availability is answered here, at runtime, rather than by a `cfg` on the
/// commands (rule 2 in the module header).
#[cfg(target_os = "macos")]
fn invocation(action: SessionAction) -> Option<Invocation> {
    let inv = match action {
        SessionAction::Restart => Invocation {
            program: "osascript",
            args: &["-e", "tell application \"System Events\" to restart"],
        },
        SessionAction::Shutdown => Invocation {
            program: "osascript",
            args: &["-e", "tell application \"System Events\" to shut down"],
        },
        SessionAction::Sleep => Invocation {
            program: "pmset",
            args: &["sleepnow"],
        },
    };
    Some(inv)
}

/// How this host performs `action`, or `None` when it has no way to.
///
/// **Pure** (see the macOS arm above).
#[cfg(target_os = "linux")]
fn invocation(action: SessionAction) -> Option<Invocation> {
    let inv = match action {
        SessionAction::Restart => Invocation {
            program: "systemctl",
            args: &["reboot"],
        },
        SessionAction::Shutdown => Invocation {
            program: "systemctl",
            args: &["poweroff"],
        },
        SessionAction::Sleep => Invocation {
            program: "systemctl",
            args: &["suspend"],
        },
    };
    Some(inv)
}

/// How this host performs `action` — this arm is for hosts that have **no** such command.
///
/// **Pure** (see the macOS arm above).
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn invocation(_action: SessionAction) -> Option<Invocation> {
    None
}

/// Turn "the host has no answer" into a **named refusal**. Pure.
///
/// `invocation()` cannot return `None` on macOS or Linux, so this is the only way the
/// refusal path is reachable from the machine the tests run on — hence `Option` as a
/// parameter rather than reading the host directly.
fn required(inv: Option<Invocation>, action: SessionAction) -> Result<Invocation, AmosError> {
    inv.ok_or_else(|| {
        AmosError::new(
            ErrorCode::SessionUnsupportedHost,
            format!(
                "this host has no power/session command for {}",
                action.name()
            ),
        )
    })
}

/// The argv of the **delayed, detached** delivery.
///
/// `sh -c 'sleep N; exec "$0" "$@"' <program> <args…>`: the program and its arguments
/// ride *after* the script and are reached through `$0` / `$@`, so they are **never**
/// interpolated into the script text. That is the difference between "these constants
/// happen to be safe" and "no value can become shell syntax here" — the latter is what
/// this module means to say.
///
/// Pure, so a test can pin the shape without spawning.
fn delivery_argv(inv: &Invocation) -> Vec<String> {
    let mut argv = vec![
        "sh".to_string(),
        "-c".to_string(),
        format!("sleep {REQUEST_DELAY_SECS}; exec \"$0\" \"$@\""),
        inv.program.to_string(),
    ];
    argv.extend(inv.args.iter().map(|a| (*a).to_string()));
    argv
}

/// Hand the invocation to a detached, delayed shell. The only side effect in this file.
///
/// The child outlives this call — that is the point — so it is **not** waited on (waiting
/// would block a command thread until the machine goes down) and its stdio is detached.
/// Rust's `Child` does not kill its process on drop, so dropping it here leaves the
/// delivery running.
fn spawn(inv: &Invocation) -> Result<(), AmosError> {
    let argv = delivery_argv(inv);
    let Some((program, args)) = argv.split_first() else {
        // `delivery_argv` always yields at least the program; this branch exists so the
        // module has no panic path, not because it is reachable.
        return Err(AmosError::new(
            ErrorCode::SessionSpawnFailed,
            "the delivery argv was empty",
        ));
    };
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            AmosError::with_cause(
                ErrorCode::SessionSpawnFailed,
                format!("could not schedule the {} action", inv.program),
                e,
            )
        })?;
    Ok(())
}

/// Decide and deliver one action: resolve the invocation, refuse by name if there is
/// none, schedule it detached, and answer with the plan. **The only caller of `spawn`.**
fn run(action: SessionAction) -> Result<SessionPlan, AmosError> {
    let inv = required(invocation(action), action)?;
    spawn(&inv)?;
    tracing::info!(
        target: "amos::session",
        action = action.name(),
        program = inv.program,
        delay_secs = REQUEST_DELAY_SECS,
        "session action scheduled (the delivery is detached and delayed)"
    );
    Ok(SessionPlan {
        action,
        delay_secs: REQUEST_DELAY_SECS,
    })
}

/* ---- Tauri commands --------------------------------------------------------- */

/// Restart the host. The reply is written **before** the action runs.
#[tauri::command]
pub fn session_restart() -> AmosResult<SessionPlan> {
    run(SessionAction::Restart)
}

/// Shut the host down. The reply is written **before** the action runs.
#[tauri::command]
pub fn session_shutdown() -> AmosResult<SessionPlan> {
    run(SessionAction::Shutdown)
}

/// Suspend the host. The reply is written **before** the action runs.
#[tauri::command]
pub fn session_sleep() -> AmosResult<SessionPlan> {
    run(SessionAction::Sleep)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The actions, so a case can be written once for all three.
    const ACTIONS: [SessionAction; 3] = [
        SessionAction::Restart,
        SessionAction::Shutdown,
        SessionAction::Sleep,
    ];

    /// This host names a command for every action.
    ///
    /// The negative control for the whole table: make an arm answer `None` and exactly
    /// this case (plus the per-platform cases below) goes red.
    #[test]
    fn every_action_has_an_invocation_on_a_supported_host() {
        for action in ACTIONS {
            let inv =
                invocation(action).unwrap_or_else(|| panic!("no invocation for {}", action.name()));
            assert!(
                !inv.program.is_empty(),
                "{} names no program",
                action.name()
            );
        }
    }

    #[test]
    fn the_actions_map_to_this_hosts_own_commands() {
        for action in ACTIONS {
            let inv = invocation(action).expect("supported host");
            #[cfg(target_os = "macos")]
            match action {
                SessionAction::Restart | SessionAction::Shutdown => {
                    assert_eq!(inv.program, "osascript");
                    assert_eq!(inv.args.len(), 2);
                    assert_eq!(inv.args[0], "-e");
                    // The AppleScript says which of the two it is — the `-e` script is the
                    // only thing that distinguishes restart from shut down.
                    let verb = if action == SessionAction::Restart {
                        "restart"
                    } else {
                        "shut down"
                    };
                    assert!(
                        inv.args[1].contains(verb),
                        "{:?} must ask System Events to {verb}: {}",
                        action,
                        inv.args[1]
                    );
                }
                SessionAction::Sleep => {
                    assert_eq!(inv.program, "pmset");
                    assert_eq!(inv.args, &["sleepnow"]);
                }
            }
            #[cfg(target_os = "linux")]
            {
                assert_eq!(inv.program, "systemctl");
                let verb = match action {
                    SessionAction::Restart => "reboot",
                    SessionAction::Shutdown => "poweroff",
                    SessionAction::Sleep => "suspend",
                };
                assert_eq!(inv.args, &[verb]);
            }
        }
    }

    #[test]
    fn a_host_without_a_command_is_refused_by_name() {
        for action in ACTIONS {
            // Passing `None` directly is how the refusal is reached on a machine that
            // *does* support every action — the reason `required` takes the `Option`.
            let err = required(None, action).expect_err("no invocation must be refused");
            assert_eq!(err.code, ErrorCode::SessionUnsupportedHost);
            assert_eq!(err.code(), "amos.session.unsupported_host");
            assert!(
                err.message.contains(action.name()),
                "the refusal must name the action: {}",
                err.message
            );
        }
        // …and it is not a blanket refusal: a present invocation passes through untouched.
        let inv = invocation(SessionAction::Restart).expect("supported host");
        assert_eq!(required(Some(inv), SessionAction::Restart).ok(), Some(inv));
    }

    /// The delivery is **delayed** and the program is passed as an argument, never
    /// interpolated into the script.
    #[test]
    fn delivery_is_delayed_and_never_interpolates_the_program() {
        for action in ACTIONS {
            let inv = invocation(action).expect("supported host");
            let argv = delivery_argv(&inv);
            assert_eq!(argv[0], "sh");
            assert_eq!(argv[1], "-c");
            assert!(
                argv[2].starts_with(&format!("sleep {REQUEST_DELAY_SECS};")),
                "the script must sleep before acting: {}",
                argv[2]
            );
            assert!(
                argv[2].contains("exec \"$0\" \"$@\""),
                "the program must arrive via $0/$@: {}",
                argv[2]
            );
            // The program and its args are argv entries *after* the script — not text in it.
            assert_eq!(argv[3], inv.program);
            assert_eq!(&argv[4..], inv.args);
            assert!(
                !argv[2].contains(inv.program) || inv.program == "sh",
                "the program name must not appear in the script text: {}",
                argv[2]
            );
        }
    }

    #[test]
    fn the_delay_leaves_the_reply_time_to_go_out() {
        // A zero delay would put the action back in a race with the IPC reply — the very
        // defect (a success read as a failure) the delay exists to remove. Checked in a
        // const block so it holds at **compile** time, not only when the tests run.
        const {
            assert!(
                REQUEST_DELAY_SECS >= 1,
                "the reply needs a nonzero head start"
            )
        };
    }

    #[test]
    fn the_plan_is_an_object_the_bridge_can_tell_from_a_failure() {
        // REQ-A513 / F-SH-053: `()` serializes to `null` and `null` means failure on the
        // wire, so the reply is a value. Serialized, it must be an object, never `null`.
        let plan = SessionPlan {
            action: SessionAction::Restart,
            delay_secs: REQUEST_DELAY_SECS,
        };
        let v = serde_json::to_value(&plan).expect("plan serializes");
        assert!(v.is_object(), "the reply must not be null on the wire: {v}");
        assert_eq!(v["action"], "restart");
        assert_eq!(v["delaySecs"], REQUEST_DELAY_SECS);
    }
}
