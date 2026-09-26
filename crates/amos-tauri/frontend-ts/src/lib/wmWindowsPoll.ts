/**
 * wmWindowsPoll.ts — **one** `wm_windows` source for the whole desktop chrome.
 *
 * Two chrome surfaces read the window list: `DesktopShell` (to know which window the
 * focused-window chords act on) and `Dock` (for the running-app dots). Each used to own its
 * own `setInterval(…, 5000)` while the shell's comment claimed the two "share one heartbeat"
 * — they did not, so the desktop polled the host twice per 5 s for the same answer.
 *
 * This module is that one source (REQ-A535). It is reference-counted: the first
 * subscriber starts the timer and pulls once immediately, the last one leaving stops it and
 * clears the cached snapshot — so a component's unmount releases the poll (nothing outlives
 * its owner) and nothing bleeds from one test into the next.
 *
 * REQ-A717 demoted the 5 s poll to a **reconciliation safety net**: the host now pushes
 * `wm-changed` (the whole `WmSnapshot`) the moment the window list changes, so the Dock's
 * running dot disappears when ⌘W closes the window instead of up to five seconds later.
 * The push is the fast path; the slower timer below only heals a *missed* event (a listener
 * attached after the change, a dropped frame, a host build that does not emit yet).
 */
import { onWmChanged, wmWindows, type WmWindowsSnapshot } from "./wm";

/**
 * How often the window list is **re-read** as a reconciliation backstop (REQ-A717).
 *
 * It no longer sets the latency a user sees — the `wm-changed` push does that — so it can be
 * slow enough not to be a heartbeat at all: 30 s bounds how long a *missed* event can leave
 * the chrome stale, while a live session pays 1/6 of the old query rate.
 */
export const WM_WINDOWS_POLL_MS = 30000;

type Listener = (snapshot: WmWindowsSnapshot | null) => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let latest: WmWindowsSnapshot | null = null;
/**
 * Which poll session the in-flight read belongs to. Bumped when the last listener leaves and
 * the timer stops, so a reply that lands **after** that teardown is discarded instead of
 * repopulating `latest` — otherwise the next owner would be served the previous owner's
 * snapshot, arbitrarily old (its timer had already stopped) and exactly the "stale, outlives
 * its owner" case this module exists to prevent.
 */
let session = 0;

async function pull(gen: number): Promise<void> {
  const snap = await wmWindows();
  if (gen !== session) return; // the session that asked for this read has ended
  latest = snap;
  for (const listener of [...listeners]) listener(snap);
}

/** The host subscription behind the push path, or `null` when there is none. */
let unlisten: (() => void) | null = null;

/**
 * Open the host's `wm-changed` subscription for the current session (REQ-A717).
 *
 * The same session guard `pull` uses, for the same reason: `onWmChanged` resolves
 * asynchronously, so the last listener may have left **before** the subscription exists —
 * then the unsubscribe we get back would be dropped on the floor and the host would keep
 * pushing at a desktop nobody is watching. The guard hands it straight back instead.
 */
function startPush(): void {
  const gen = session;
  void onWmChanged((snap) => {
    if (gen !== session) return; // a push that belongs to a session that already ended
    latest = snap;
    for (const listener of [...listeners]) listener(snap);
  }).then((un) => {
    // REQ-A838: `null` means the host subscription was never established, so there is nothing
    // to hand back or to remember — the poll path below is the only thing keeping the list
    // fresh, and `unlisten` must stay `null` rather than hold a no-op that looks like a push.
    if (un === null) return;
    if (gen !== session) un();
    else unlisten = un;
  });
}

/**
 * Subscribe to the shared window-list source: the host's `wm-changed` push (instant) plus the
 * slow reconciliation poll above (self-healing). The listener is called with each fresh
 * snapshot (or `null` when the host is unreachable / not a desktop form). Returns the
 * unsubscribe function; when the last one runs, the push and the timer both stop.
 */
export function subscribeWmWindows(listener: Listener): () => void {
  listeners.add(listener);
  // Hand a late subscriber the answer we already have instead of a blank first frame, but
  // never a *stale* one: `latest` is dropped when the last listener leaves, so this can only
  // serve the current session's own read.
  if (latest !== null) listener(latest);
  if (timer === null) {
    const gen = session;
    startPush();
    void pull(gen);
    timer = setInterval(() => void pull(gen), WM_WINDOWS_POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
      latest = null;
      session += 1; // any read still in flight belongs to the session that just ended
      unlisten?.();
      unlisten = null;
    }
  };
}
