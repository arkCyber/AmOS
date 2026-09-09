/**
 * focusTrap.ts — Framework-agnostic modal focus trap (no React/Svelte imports).
 *
 * Shared by the Svelte controlled overlays that need a modal trap
 * (Recents/Spotlight/etc.), so the trap behaviour can never drift.
 */

const SEL =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function focusables(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(SEL)).filter(
    (n) => !n.hasAttribute("disabled"),
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
  return () => document.removeEventListener("keydown", onKey);
}
