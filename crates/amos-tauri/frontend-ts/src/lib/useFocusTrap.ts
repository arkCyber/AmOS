import { useEffect, type RefObject } from "react";
import { attachFocusTrap } from "./focusTrap";

/**
 * React hook wrapper over the framework-agnostic modal focus trap
 * (src/lib/focusTrap.ts). Traps focus while `active`; Escape calls `onEscape`.
 * SSR-safe: effects only run on mount in a real DOM.
 */
export function useFocusTrap(active: boolean, ref: RefObject<HTMLElement | null>, onEscape?: () => void): void {
  useEffect(() => {
    if (!active || !ref.current) return;
    return attachFocusTrap(ref.current, onEscape);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ref]);
}
