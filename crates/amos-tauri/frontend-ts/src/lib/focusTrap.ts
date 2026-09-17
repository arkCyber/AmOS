/**
 * focusTrap.ts — Framework-agnostic modal focus trap (no React/Svelte imports).
 *
 * Shared by the Svelte controlled overlays that need a modal trap
 * (Recents/Spotlight/etc.), so the trap behaviour can never drift.
 */

const SEL =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function focusables(scope: HTMLElement): HTMLElement[] {
  // The CSS selector can't express "buttons AND tabindex!=−1" in one clause
  // without per-attribute selectors happy-dom disagrees with. So we accept the
  // broader `button:not([disabled])` set, then drop `tabindex="-1"` ourselves.
  return Array.from(scope.querySelectorAll<HTMLElement>(SEL)).filter(
    (n) => !n.hasAttribute("disabled") && n.getAttribute("tabindex") !== "-1",
  );
}

/**
 * Attach a keyboard focus trap to `scope`:
 *   • focuses the first focusable (like the React original);
 *   • Tab / Shift+Tab wraps inside the scope;
 *   • Escape (optional via `onEscape`) is handled by the caller policy.
 * Returns a cleanup that removes the listener. SSR/no-scope safe.
 */
export function attachFocusTrap(
  scope: HTMLElement,
  onEscape?: () => void,
): () => void {
  // Capture the pre-attachment active element BEFORE we steal focus for the
  // sheet. This is the element we hand back to on teardown (REQ-A323 — give
  // the keyboard user's place back).
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const initial = focusables(scope);
  const first = initial[0];
  if (first) first.focus();

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onEscape?.();
      return;
    }
    if (e.key !== "Tab") return;
    const list = focusables(scope);
    if (!list.length) return;
    const head = list[0];
    const tail = list[list.length - 1];
    if (!head || !tail) return; // non-empty by the guard above; defensive
    const cur = document.activeElement as HTMLElement | null;
    const inside = cur ? list.includes(cur) : false;
    if (e.shiftKey && (!inside || cur === head)) {
      e.preventDefault();
      tail.focus();
    } else if (!e.shiftKey && (!inside || cur === tail)) {
      e.preventDefault();
      head.focus();
    }
  };
  document.addEventListener("keydown", onKey);

  return () => {
    document.removeEventListener("keydown", onKey);
    if (!opener || !opener.isConnected) return;
    // Defer: the caller may remove the sheet's DOM in the same tick, and only
    // after that does the browser drop focus. Doing it in a microtask lets the
    // DOM settle first. We then restore focus, but only if the user has not
    // since moved focus elsewhere (a true idle place is `body`; an element the
    // user focused is theirs).
    queueMicrotask(() => {
      const cur = document.activeElement;
      if (cur && cur !== document.body && cur !== opener) return;
      opener.focus();
    });
  };
}
