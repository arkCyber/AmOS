import type { BridgeDiag, RealDialStatus } from "./backend";

export const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

/** E.164 dial strings can be up to 15 digits; leave headroom for "+<cc>". */
export const MAX_DIAL_LEN = 18;

/** Append a key, but never grow beyond MAX_DIAL_LEN (mirrors a real dialer). */
export function pushKey(number: string, k: string): string {
  if (number.length >= MAX_DIAL_LEN) return number;
  return number + k;
}
export function backspace(number: string): string {
  return number.slice(0, -1);
}
export function clearDial(number: string): string {
  return number.slice(0, 0);
}

/**
 * The dial string a search/text query really is, or `null` when it is not a number.
 *
 * Used by Spotlight's "fill the dialler" action: only a query that **looks like** a
 * dialable number offers it (digits with `+ * #` and the usual separators, at least two
 * digits), so a search for "买牛奶" never pretends to be a phone number. The result is
 * the string with separators removed (what a dialler sends), capped at `MAX_DIAL_LEN`.
 */
export function dialableQuery(q: string): string | null {
  const raw = q.trim();
  if (raw === "") return null;
  if (!/^\+?[0-9*#()\-.\s]+$/.test(raw)) return null;
  const digits = raw.replace(/[^0-9*#+]/g, "");
  if ((digits.match(/[0-9]/g) ?? []).length < 2) return null;
  return digits.slice(0, MAX_DIAL_LEN);
}

/**
 * The call id the **real in-call bridge** stamps on every call it reports.
 *
 * `crates/amos-tauri/src/incall.rs`'s JNI upcall (`AmosInCallService.nativeState` →
 * `Java_com_amos_ai_glue_AmosInCallService_nativeState`) hard-codes this on the
 * `TelephonyCallPayload` it emits, for incoming *and* outgoing calls alike — unlike the
 * daemon, which mints a per-call id (`tel_…`). It is therefore **not** an identifier: it
 * names the *owner* of a call (the bound `AmosInCallService`), which is exactly what the
 * Phone page needs to know when it hands a dial-out to Android Telecom and Telecom
 * resolves it back into this app's own in-call service.
 */
export const REAL_CALL_ID = "real";

/** How an outbound call was placed, or why it could not be. */
export type DialOutcome =
  /**
   * A call our in-call UI owns. `simulated` is `true` when **nothing left the device**
   * — the daemon's mock/demo provider answered on a host with no telephony stack —
   * so the surface can say so instead of claiming a call that never happened.
   */
  | { kind: "managed"; id: string; simulated: boolean }
  /** Handed straight to Android Telecom (`ACTION_CALL`): the *system* dialer owns it. */
  | { kind: "handed-off" }
  /**
   * No transport placed it. `reason` is the host's own words for *why* ("" when it
   * gave none) — the remedy lives there, so it must reach the surface rather than
   * being flattened into a generic "dial failed".
   */
  | { kind: "failed"; reason: string };

/**
 * The transports `placeOutgoingCall` tries, injected so the routing decision is a pure,
 * offline-testable function rather than logic buried in the component.
 *
 * The **order** they are tried in is the point (see `placeOutgoingCall`), so the
 * interface spells out, for each one, what its answer may and may not mean.
 */
export interface DialTransports {
  /**
   * The real platform path: a direct `ACTION_CALL` through Android Telecom
   * (`crates/amos-tauri/src/real_dial.rs`, `lib/backend.ts::realDial`). `true` only
   * when the platform took the call; `false` on a desktop host or a device whose dial
   * context is not bound — never a fabricated success.
   */
  system: (number: string) => Promise<boolean>;
  /**
   * Is the daemon's telephony provider a genuinely **real** stack (backend kind
   * `android`), rather than the `mock`/demo provider? An unknown answer reads as
   * `false`: a mock that answered "yes" here would route a real phone's call into a
   * simulation, which is the defect this whole routing exists to close.
   */
  daemonReal: () => Promise<boolean>;
  /**
   * Can this host place a real call at all? `null` = the host never answered, which is
   * read as **on-device** (the safe direction: a host we could not classify must not
   * have its calls simulated). See `lib/backend.ts::RealDialStatus`.
   */
  hostStatus: () => Promise<RealDialStatus | null>;
  /**
   * AmOS-managed call through the daemon: binds OUR in-call UI (recording, mute,
   * ringback). `null` means no daemon answered (desktop dev host, or the daemon is
   * down / refused).
   */
  daemon: (number: string, emergency: boolean) => Promise<{ id?: string } | null>;
}

/**
 * Place an outbound call — **real platform path first**.
 *
 * Why each step sits where it does:
 *
 * 1. Blank → `failed`; there is nothing to dial.
 * 2. `ACTION_CALL` through Android Telecom, tried for **every** number — emergency
 *    ones included. On a device this is the only path that places an actual call, and
 *    the emergency guarantee is a property of that stack, not of user space:
 *    `docs/telephony.md` §5 places it in Telecom + the platform EmergencyNumber DB +
 *    RIL/HAL, which is exactly what `ACTION_CALL` reaches. When AmOS holds
 *    ROLE_DIALER, Telecom resolves the call back into *our own* `AmosInCallService`
 *    (fixed id `real`), and the caller adopts it (REQ-A1222).
 * 3. A daemon backed by a genuinely **real** stack (`android`) is the next real path,
 *    preferred over simulation because it binds our in-call UI.
 * 4. No real path and this **is** a device → `failed`, with the host's own reason. A
 *    simulated call must never stand in for one the platform did not place; the dialer
 *    reports the failure instead of drawing a call that does not exist.
 * 5. Desktop/demo host — no telephony stack at all — → the daemon's simulated call,
 *    the only thing there is, reported as `simulated` so the surface can label it.
 *
 * The order is the fix: with the daemon tried first, its `MockTelephonyProvider`
 * answered `Ok` for every dial (`crates/amos-telephony/src/provider.rs`), so step 2
 * was unreachable on a real phone and a device never fired `ACTION_CALL` — emergency
 * numbers included, while step 2 is where the platform's emergency path lives.
 */
export async function placeOutgoingCall(
  number: string,
  emergency: boolean,
  transports: DialTransports,
): Promise<DialOutcome> {
  const target = number.trim();
  if (target === "") return { kind: "failed", reason: "" };

  if (await transports.system(target)) return { kind: "handed-off" };

  if (await transports.daemonReal()) {
    const managed = await transports.daemon(target, emergency);
    return managed
      ? { kind: "managed", id: managed.id ?? "", simulated: false }
      : { kind: "failed", reason: "" };
  }

  const host = await transports.hostStatus();
  // `null` (no answer) is read as on-device: refusing to simulate a call on a host we
  // could not classify is the honest direction, and it is the one that cannot draw a
  // call the platform never placed.
  if (host === null ? true : host.on_device) {
    return { kind: "failed", reason: host?.reason ?? "" };
  }

  const simulated = await transports.daemon(target, emergency);
  return simulated
    ? { kind: "managed", id: simulated.id ?? "", simulated: true }
    : { kind: "failed", reason: "" };
}

/**
 * What an **in-call action** (answer / decline / hang-up) really did.
 *
 * These are the one family of commands whose *return value cannot answer the
 * question*: `invoke` (`lib/backend.ts`) **never rejects** — a failed command is
 * recorded in `bridgeDiag(command)` and answered with `null`, and a `void` command's
 * success value is `null` too. So "the platform took the call", "the platform
 * refused", and "there is no bridge at all" arrive as the **same value**, which is
 * how the incoming-call overlay used to render a live in-call screen after an
 * answer that never happened (F-SH-236). The verdict is therefore read from the
 * diagnostic slot — the mechanism REQ-A296 established — and not from the value.
 */
export type CallActionOutcome =
  /** The transport accepted it: the call state may now change. */
  | { kind: "accepted" }
  /**
   * Nothing took it. `detail` is the host's **own words** (empty when it gave
   * none — including "not bridged"), so the surface can say what happened instead
   * of claiming the call is up.
   */
  | { kind: "refused"; detail: string };

/** Bound on the host text a one-line in-call error strip may carry. */
export const MAX_ACTION_DETAIL_LEN = 120;

/**
 * Fold a bridge diagnosis into the verdict for one in-call action.
 *
 * Pure, so the decision is offline-testable rather than buried in the component.
 * A command that was never called reads `{ ok: true }` from `bridgeDiag` ("no
 * recorded failure"); that default is inherited here on purpose — the caller must
 * ask **after** its own `await`, and `invoke` writes the slot on every path.
 */
export function callActionOutcome(diag: BridgeDiag): CallActionOutcome {
  if (diag.ok) return { kind: "accepted" };
  // `not-bridged` has no host to quote; it is only reachable when the bridge went
  // away underneath a mounted surface, so it shares the "no words" spelling.
  if (diag.kind === "not-bridged") return { kind: "refused", detail: "" };
  return { kind: "refused", detail: callActionDetailText(diag.detail) };
}

/** The wire vocabulary (`error.rs::codes`): `amos.<domain>.<name>`, never shown to a human. */
const MACHINE_CODE = /^amos(\.[a-z0-9_]+)+$/;

/**
 * Is this string a machine token rather than words for a human?
 *
 * The repo rule ("机器码不得出现在给用户看的句子里") needs a **predicate**, not a promise.
 * `AmosError::with_cause(code, codes::RPC_FAILED, sentence)` — the shape every telephony RPC
 * failure in `telephony.rs` uses — puts the **token** in `message` and the sentence in
 * `cause[0]` (`error.rs`'s own test asserts `v["message"] == "amos.telephony.rpc_failed"`).
 * Preferring `message` unconditionally therefore rendered
 * `接听失败：amos.telephony.rpc_failed——这通电话仍在振铃` to the user. (REQ-A811)
 */
export function isMachineCode(s: string): boolean {
  return MACHINE_CODE.test(s);
}

/** A candidate reduced to "the words a human can read", or `""` when it carries none. */
function humanWords(s: string): string {
  const text = s.trim();
  return isMachineCode(text) ? "" : text;
}

/**
 * The host's own words for a refused command, bounded and never `[object Object]`.
 *
 * `AmosError` crosses the bridge as `{ code, message, cause? }`. Each candidate is read
 * through [`humanWords`], so a detail that carries **only a machine token** yields `""` and
 * the surface says "no reason given" instead, while `invoke` still logs the token
 * (`amosWarn`). The candidates are tried in order — `message`, then the causes — and a
 * token in one does **not** end the search: the sentence is often the token's next sibling
 * (`{ message: "amos.telephony.rpc_failed", cause: ["telephony answer: …"] }`). A plain
 * string detail goes through the same filter. Text longer than [`MAX_ACTION_DETAIL_LEN`] is
 * truncated **visibly** (an ellipsis), so a clipped message never reads as the whole truth.
 */
export function callActionDetailText(detail: unknown): string {
  let text = "";
  if (typeof detail === "string") {
    text = humanWords(detail);
  } else if (detail && typeof detail === "object") {
    const e = detail as { message?: unknown; cause?: unknown };
    const message = humanWords(typeof e.message === "string" ? e.message : "");
    const cause = Array.isArray(e.cause)
      ? e.cause
          .filter((c): c is string => typeof c === "string")
          .map(humanWords)
          .filter((w) => w !== "")
          .join("; ")
      : "";
    text = message !== "" ? message : cause;
  }
  return text.length > MAX_ACTION_DETAIL_LEN ? `${text.slice(0, MAX_ACTION_DETAIL_LEN - 1)}…` : text;
}

/**
 * Format an elapsed call duration in seconds as `m:ss` (or `h:mm:ss` past an hour).
 * Pure + deterministic so the in-call timer is unit-testable offline.
 */
export function fmtCallDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${m}:${pad(sec)}`;
}
