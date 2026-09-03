import { useEffect, type RefObject } from "react";

const SEL =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusables(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(SEL)).filter((n) => !n.hasAttribute("disabled"));
}

/**
 * Trap keyboard focus inside a modal while `active` (Tab wraps, Escape optional).
 * SSR-safe: effects only run on mount in a real DOM.
 */
export function useFocusTrap(active: boolean, ref: RefObject<HTMLElement | null>, onEscape?: () => void): void {
  useEffect(() => {
    if (!active || !ref.current) return;
    const scope = ref.current;
    const f = focusables(scope);
    const firstFocus = f[0];
    if (firstFocus) firstFocus.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onEscape?.();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables(scope);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return; // non-empty by the guard above; defensive
      const cur = document.activeElement as HTMLElement | null;
      const inside = cur ? list.includes(cur) : false;
      if (e.shiftKey && (!inside || cur === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || cur === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, ref, onEscape]);
}
