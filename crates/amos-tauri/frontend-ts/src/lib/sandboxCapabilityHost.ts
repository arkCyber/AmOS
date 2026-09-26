/**
 * sandboxCapabilityHost.ts — the **live half** of the sandbox capability seam (REQ-A721).
 *
 * `lib/sandboxBridge.ts` is the pure decision: it validates an inbound
 * `capability.request` and turns the daemon's authoritative answer into a
 * `capability.reply`. On its own it decides nothing — **nothing calls it** — so a
 * store-installed web-bundle's frame stayed deny-by-default not because a policy
 * denied it, but because no listener existed to answer. `unwired-allowlist.json`
 * named exactly this as the missing half ("the postMessage listener"). This module
 * is that listener; `ExtAppHost.svelte` is the one place that installs it.
 *
 * Three rules, each load-bearing:
 *
 *   1. **The frame is identified by `event.source`, not by `event.origin`.** The
 *      bundle runs in an iframe whose `src` the host chose (`amos-app://<id>`); a
 *      message is accepted only when `source` is *that exact window object*. An
 *      origin string is shared by every document the bundle can navigate to (and,
 *      with a custom scheme, is often the opaque `"null"`); the window object is
 *      not shareable, and the platform hands it to us for free.
 *   2. **The daemon is the authority.** The shell never grants on its own — it asks
 *      `perm_authorize` (the single audited chokepoint, `lib/privacyBackend`) and
 *      grants **only** on a literal `true`. Offline / unknown (`null`) is a denial.
 *   3. **A malformed frame gets no reply.** Replying to garbage — from our frame or
 *      any other — would teach a hostile page which shapes the parser accepts, so
 *      the host stays silent. Silence is the denial.
 */

import {
  decideCapabilityRequest,
  validateCapabilityRequest,
} from "./sandboxBridge";
import { capForWire } from "./privacyBackend";
import type { Capability } from "./permissions";

/**
 * The sandboxed frame's window (`iframe.contentWindow`). Only `postMessage` is
 * needed, and the object must be **identity-comparable with `event.source`** — the
 * seam's whole security rests on comparing the two, so a wrapper that allocates a
 * fresh object per call would silently break the check.
 */
export interface SandboxFrameWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** The three platform edges the policy needs, and nothing else. */
export interface SandboxHostSeam {
  /** Subscribe to inbound `message` events; returns the unsubscribe. */
  onMessage(handler: (event: MessageEvent) => void): () => void;
  /** The frame we own, or `null` when it is not mounted / has gone away. */
  frameWindow(): SandboxFrameWindow | null;
  /** The daemon's audited chokepoint for `(appId, capability)`. */
  authorize(appId: string, capability: Capability): Promise<boolean | null>;
}

export interface SandboxHostOptions {
  /** The bundle's manifest id — the identity grants are audited against. */
  appId: string;
  /** Called for a frame refused *before* the daemon (foreign source / bad shape). */
  onRefused?(reason: string, data: unknown): void;
}

/**
 * Install the capability listener. Returns the uninstall (it *is* the seam's own
 * unsubscribe), so the caller's teardown and the component's lifetime are one thing.
 */
export function installSandboxCapabilityHost(
  seam: SandboxHostSeam,
  options: SandboxHostOptions,
): () => void {
  const onMessage = (event: MessageEvent): void => {
    const frame = seam.frameWindow();
    if (frame === null || (event.source as unknown) !== frame) {
      // Not our bundle. Say nothing at all — a stranger learns not even that a host
      // is listening, and `onRefused` is for *our* frame's malformed traffic.
      return;
    }
    const validation = validateCapabilityRequest(event.data);
    if (validation.kind !== "valid") {
      options.onRefused?.(validation.reason, event.data);
      return;
    }
    const capability = capForWire(validation.resource);
    if (capability === null) {
      // Unreachable from `validateCapabilityRequest` (it already restricts `resource`
      // to the daemon wire keys) — kept because "the resource is a capability the
      // daemon knows" is the invariant the grant rests on, and a key added on one
      // side only must **fail closed**, not become a grant with an undefined name.
      options.onRefused?.("no-capability", event.data);
      return;
    }
    void answer(seam, frame, event, capability, options);
  };

  return seam.onMessage(onMessage);
}

/**
 * Ask the daemon and reply — but only to the **same** window that asked. The daemon
 * call is async, and the bundle may have navigated (or the app been closed) while it
 * was in flight; replying to `frameWindow()` re-read would deliver the answer to
 * whatever document now occupies the slot.
 */
async function answer(
  seam: SandboxHostSeam,
  frame: SandboxFrameWindow,
  event: MessageEvent,
  capability: Capability,
  options: SandboxHostOptions,
): Promise<void> {
  const granted = await seam.authorize(options.appId, capability);
  if (seam.frameWindow() !== frame) return;
  const reply = decideCapabilityRequest(event.data, granted);
  if (reply === null) return; // re-validation refused it — the same silence as above
  // `targetOrigin: "*"` is deliberate: we have already bound the *sender* by window
  // identity, and the reply is delivered to the frame's own document, so a third
  // party cannot receive it. A custom-scheme origin (`amos-app://<id>`) is frequently
  // opaque, so pinning an origin string here would refuse the honest case, not the
  // hostile one. The reply carries no secret — only the boolean the asker is owed.
  frame.postMessage(reply, "*");
}

/**
 * The real seam: `window`'s `message` events, an `<iframe>`'s `contentWindow`, and
 * the daemon chokepoint. Kept separate from the policy so the policy is testable
 * without a DOM and the DOM wiring without a daemon.
 */
export function bundleFrameSeam(
  frame: () => SandboxFrameWindow | null,
  authorize: (appId: string, capability: Capability) => Promise<boolean | null>,
): SandboxHostSeam {
  return {
    onMessage: (handler) => {
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    },
    frameWindow: frame,
    authorize,
  };
}
