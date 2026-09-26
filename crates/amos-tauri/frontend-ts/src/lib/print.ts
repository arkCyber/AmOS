/**
 * The shell's front door to the host's print pipeline (REQ-A869).
 *
 * Why the host owns this and the shell does not: the WebView here is a **launcher** window and
 * several app windows, each its own WebView. `window.print()` is a DOM call on *the document
 * that makes it*, and the only `menu-event` subscriber in the shell is `DesktopShell.svelte`,
 * which mounts **only in the launcher window** (`Shell.svelte`'s `s.kind === "app"` branch).
 * So a `case "menu.print": window.print()` would print **the desktop**, not the document the
 * user is looking at. The host can resolve "the focused app window" — the rule `wm.rs` already
 * owns for ⌘W / ⌘M and for which `is_screen_window` excludes the launcher — and it is the only
 * place that can, so File ▸ Print / ⌘P is a zero-argument command exactly like `wm_zoom`
 * (the WebView never names a target: `docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md` §2 D2).
 *
 * What `ok: true` does **not** mean (the honest boundary, also stated in `print.rs` and in the
 * host's own log line): `WebviewWindow::print()` returns `Ok(())` on every platform whether or
 * not anything printed. macOS runs `printOperationWithPrintInfo:` only when the view
 * `respondsToSelector` says so, Windows is literally `eval("window.print()")`, and Linux drops
 * `PrintOperation::run_dialog`'s result — a Cancel is `Ok(())`. So this module never reports
 * "the document printed"; it reports which window the host asked the platform about. A user who
 * cancelled sees no page, and no code here claims otherwise.
 *
 * Why `WithDiag` and not `Promise<void>`: `invoke` resolves `null` **both** when the bridge is
 * absent and when the command was refused, so a `void` wrapper makes "the dialog was requested"
 * and "the host said no" indistinguishable (`session.ts`'s reasoning, REQ-A513 / F-SH-053).
 */
import { bridgeDiag, invoke } from "./backend";
import type { BridgeDiag } from "./backend";

/**
 * The host's reply to `print_document` (`print::PrintRequest` on the Rust side).
 *
 * Named rather than left `unknown` on purpose (REQ-A555): a TS type the reply scanner can
 * resolve (`scripts/tauri-reply-scan.mjs`) is the only way the two sides of this wire can be
 * compared at all. Not exported — nothing outside this module reads it, and an unused export
 * is what `scripts/unwired-scan.mjs` exists to catch.
 *
 * Only `window` is declared. The Rust struct also serialises `platform` (which platform's
 * dialog was asked for), and that field is deliberately **not** modelled here: this module
 * makes no decision from it, and a field a consumer declares but never reads is the "fixture
 * omits the field" trap in reverse. It stays visible in the diagnostic detail instead.
 */
interface PrintRequest {
  /** The focused app window the host asked the platform to print. */
  window: string;
}

/** Either the host asked the platform to print something, or it did not (with the reason). */
export type PrintOutcome =
  | { ok: true; window: string }
  | { ok: false; diag: BridgeDiag };

/**
 * Ask the host to print the **focused app window**.
 *
 * No arguments, and that is the contract: the WebView cannot name a window the host might not
 * agree is focused, and the launcher is never a target (F-SH-008). A refusal — no app window
 * focused, or a platform with no print dialog — arrives as a named `amos.print.*` code, which
 * [`printRefusalMessage`] turns into the sentence the shell logs.
 */
export async function printDocumentWithDiag(): Promise<PrintOutcome> {
  const result = await invoke<PrintRequest>("print_document");
  if (result !== null) return { ok: true, window: result.window };
  return { ok: false, diag: bridgeDiag("print_document") };
}

/**
 * The three ways the host refuses to print, spelled as `error.rs` writes them.
 *
 * No gate mirrors these to the Rust `ErrorCode` table (unlike the messages, which the i18n
 * scan does see), so a rename on either side would be silent — the `switch` below has a
 * `default` that prints the code it did receive, which is what makes such a rename
 * *diagnosable* rather than invisible.
 */
const CODE_UNSUPPORTED_PLATFORM = "amos.print.unsupported_platform";
const CODE_NO_WINDOW = "amos.print.no_window";
const CODE_DIALOG_FAILED = "amos.print.dialog_failed";

/**
 * A diagnostic that stands for a refusal — `BridgeDiag` minus its `{ ok: true }` member.
 *
 * Narrowing here (rather than accepting the whole union) is what keeps every branch of
 * [`printRefusalMessage`] reachable: a parameter that admits a *successful* diagnostic would
 * need a sentence for it, and no caller has one to give — `printFocused` names that case
 * itself, because for a command that answers an object it is a wire violation rather than
 * one of the print refusals.
 */
export type PrintRefusal = Extract<BridgeDiag, { ok: false }>;

/** The `code` field of a command-failed diagnostic's detail, when it has one. */
function refusalCode(diag: PrintRefusal): string | null {
  if (diag.kind !== "command-failed") return null;
  const detail = diag.detail;
  if (detail === null || typeof detail !== "object") return null;
  const code = (detail as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * The sentence logged when File ▸ Print does nothing.
 *
 * Developer diagnostics, in the same English register as `snapZones`' `snapRefusal` and
 * `desktopSystemKeys`' chord messages. Per reason, because they are different facts: "this
 * platform has no print dialog at all" and "nothing is focused" are both expected outcomes of
 * a *user's* click, while `amos.print.dialog_failed` is a defect report about the platform
 * call. Kept here, beside the codes it reads, so no call site can describe the same non-event
 * differently — the rule `shellModule.ts` states for every other chrome-handle refusal.
 */
export function printRefusalMessage(diag: PrintRefusal): string {
  if (diag.kind !== "command-failed") {
    return "the host refused to print: there is no bridge to the host (see the diagnostic log)";
  }
  const code = refusalCode(diag);
  switch (code) {
    case CODE_UNSUPPORTED_PLATFORM:
      return "the host refused to print: this platform has no print dialog (printing is desktop-only, and the phone/tablet shells have none)";
    case CODE_NO_WINDOW:
      return "the host refused to print: no app window is focused, and the desktop itself is not a printable document (F-SH-008)";
    case CODE_DIALOG_FAILED:
      return "the host asked the platform for its print dialog and the call failed (see the diagnostic log)";
    default:
      return `the host refused to print: ${code ?? "an unrecognised reason"} (see the diagnostic log)`;
  }
}
